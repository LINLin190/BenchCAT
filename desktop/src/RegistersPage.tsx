import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, Checkbox,
  CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControl, FormControlLabel, IconButton, Menu, MenuItem, Select, Stack,
  Link, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs,
  TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from "@mui/material";
import { createTheme, ThemeProvider, useTheme } from "@mui/material/styles";
import {
  CheckRounded, CloseRounded, ContentCopyRounded, ExpandMoreRounded, MoreHorizRounded,
  PlaylistAddRounded, RefreshRounded, SearchRounded, StarBorderRounded, StarRounded,
} from "@mui/icons-material";
import { BridgeRequestError, bridgeRequest } from "./api";
import type { ManualTarget } from "./PdfManualViewer";
import { operationStore } from "./operationStore";
import { hex, type RegisterDefinition, type RegisterManualReference, type SlaveInfo } from "./types";
import {
  decodeRegisterFields, definitionKey, encodeRegisterInput, formatRegisterBinary, formatRegisterValue,
  requiresManualRead, isCommonRegister, registerSearchRank, parseRegisterAddress, registerDisplayName, registerMeaning,
  registerAccessDescription, registerAccessLabel, registerManuals, registerNumber, registerWidth, type RegisterValue, type ValueFormat,
} from "./registerValues";

type Run = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;
type CatalogView = "common" | "all" | "favorites";
interface Props { slave?: SlaveInfo; run: Run; registerProfile: string; deviceOperationsBlocked: boolean; sessionContext: string }
interface WriteContext { definition?: RegisterDefinition; address: number; width: number; access: string; name: string; current?: string }
interface ValueChange { previous: string; timestamp: number }
interface ReadJob { definition: RegisterDefinition; automatic: boolean; context: string }
interface RegisterSnapshot {
  values: RegisterValue[]; errors: Record<string, string>; skipped: Record<string, string>;
  cancelled: boolean; frame_count: number; duration_ms: number; timestamp: number;
  catalog?: RegisterDefinition[]; catalog_version?: string; error?: string;
}
interface RegisterCatalog { catalog: RegisterDefinition[] | null; catalog_version: string }
interface CachedRegisters { catalog: RegisterDefinition[]; catalogVersion: string; details: Map<string, RegisterDefinition>; values: Record<string, RegisterValue>; errors: Record<string, string>; snapshot?: RegisterSnapshot }
const snapshots = new Map<string, CachedRegisters>();
let cachedSession = "";
// Load the PDF engine only when the user opens a reference manual.
const PdfManualViewer = lazy(() => import("./PdfManualViewer"));

/** Restore user choices without storing live values across connection sessions. */
function registerPreferences(profile: string): { favorites: string[]; pinned: string[]; intervalMs: number; format: ValueFormat } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`benchcat-registers:${profile}`) ?? "{}");
    return { favorites: Array.isArray(saved.favorites) ? saved.favorites : [], pinned: Array.isArray(saved.pinned) ? saved.pinned : [],
      intervalMs: [500, 1000, 2000, 5000].includes(saved.intervalMs) ? saved.intervalMs : 1000,
      format: ["hex", "decimal"].includes(saved.format) ? saved.format : "hex" };
  } catch { return { favorites: [], pinned: [], intervalMs: 1000, format: "hex" }; }
}
interface WriteResult { readback: string | null; fpwr_wkc: number }
interface RawWriteResult { write_wkc: number | null; readback: RegisterValue | null; write_error: string | null; read_error: string | null }
type RawFormat = "hex" | "decimal";

/** Raw ranges remain whole unsigned integers even beyond eight bytes. */
function formatRawValue(data: string, format: RawFormat): string {
  const value = registerNumber(data);
  return format === "decimal" ? value.toString() : `0x${value.toString(16).toUpperCase().padStart(data.trim().split(/\s+/).length * 2, "0")}`;
}

const groupLabels: Record<string, string> = {
  "AL State Machine": "AL 状态机", "Data Link Layer / Port Status": "链路与端口",
  "Error Counters / Diagnostics": "错误计数与诊断", "ESC Identification / Capability": "ESC 信息",
  "Station Address": "站地址", "Watchdog": "看门狗", "Event / Interrupt": "事件与中断",
  "PDI / ESC Configuration": "PDI 配置", "SII EEPROM Interface": "EEPROM 接口",
  "PHY Management / Port Status": "PHY 管理", "Distributed Clocks": "分布式时钟",
  "Write Protection / Reset": "写保护与复位", "Digital I/O / General Purpose I/O": "数字 I/O",
  "FMMU": "FMMU 映射", "SyncManager": "SyncManager 通道",
  "User RAM": "用户 RAM", "Process Data RAM": "PRAM", "Process Data RAM / PRAM": "PRAM",
  "phy": "PHY 寄存器", "lan925x_system_csr": "CSR 寄存器", "hbi_local": "HBI 寄存器",
};
const referenceGroups = ["phy", "lan925x_system_csr", "hbi_local"];
const disclosureSx = {
  borderTop: 1, borderColor: "divider", "&:before": { display: "none" },
  "& .MuiAccordionSummary-root": { px: 0, minHeight: 40 },
  "& .MuiAccordionDetails-root": { px: 0, pt: 0, pb: 1.5 },
};

/** Shorten display labels without changing catalog names or register identities. */
function registerLabel(name = ""): string {
  return name.replace(/\s+Register\s*$/i, "");
}

/** Group local references by address space, keeping CSR bridge entries together. */
function functionGroup(definition: RegisterDefinition): string {
  return referenceGroups.includes(definition.address_space ?? "") ? definition.address_space! : definition.group;
}

/** Directly readable or writable entries belong to the ordinary ECAT catalog. */
function ecatAccessible(definition: RegisterDefinition): boolean {
  return definition.direct_read_allowed === true || definition.direct_write_allowed === true;
}

/** A PRAM overview is a navigation row and never a device transaction. */
function isPramOverview(definition: RegisterDefinition): boolean {
  return definition.address_space === "process_ram_overview";
}

/** Explain the missing direct ECAT path without implying that indirect access is impossible. */
function unavailableReason(definition: RegisterDefinition): string {
  if (definition.address_space === "phy") return "本页不支持通过 ECAT 直接访问；需要通过 PHY 管理接口间接访问。";
  if (definition.address_space === "lan925x_system_csr") return "CSR 寄存器属于芯片本地地址空间，需要通过 HBI 或 SPI/SQI 接口访问。";
  if (definition.address_space === "hbi_local") return "HBI 寄存器属于本地主机接口窗口，需要通过对应 HBI 模式访问。";
  return documentationText(definition.hardware_condition) || "此条目不适用于当前芯片，或不允许主站直接访问。";
}

/** Manual acquisition policy is distinct from event acknowledgement and buffer access. */
function readDescription(definition: RegisterDefinition): string {
  if (isPramOverview(definition)) return "进入 PRAM 分类";
  if (!ecatAccessible(definition)) return unavailableReason(definition);
  if (!requiresManualRead(definition)) return "";
  if (definition.address_space === "user_ram") return "此区域不自动刷新。";
  if (definition.address_space === "process_ram") return "此区域采用手动读取；访问已配置的 SyncManager 缓冲区可能影响事件或缓冲区状态。";
  if (definition.address_space === "esc_core") {
    const descriptions: Record<number, string> = {
      0x0110: "读取会确认链路状态事件。", 0x0130: "读取会确认 AL 状态事件。",
      0x0440: "读取会清除过程数据看门狗事件。",
    };
    if (descriptions[definition.address]) return descriptions[definition.address];
    if ([0x09B0, 0x09B8, 0x09C0, 0x09C8].includes(definition.address)) return "读取可能确认对应 LATCH 事件，取决于锁存单元控制权配置。";
  }
  return definition.read_side_effects?.map(documentationText).filter(Boolean).join(" ") || "此寄存器不自动刷新；具体读取行为见操作说明。";
}

/** Read hints are shared by the value cell, refresh control, and detail panel. */
function readHint(definition: RegisterDefinition): string {
  const description = readDescription(definition);
  return canRead(definition) && requiresManualRead(definition) ? `${description} 请点击刷新图标手动读取。` : description;
}

/** Translate reference text and omit metadata that the document does not specify. */
function documentationText(text?: string): string {
  if (!text?.trim() || /^(?:not documented|文档未注明)$/i.test(text.trim())) return "";
  return text.replace(/not documented/gi, "文档未注明").replace(/not applicable/gi, "不适用")
    .replace(/undefined/gi, "未定义").replace(/LSB is stored at the lowest EtherCAT Core CSR address; MSB at the highest address/gi, "小端字节序：低地址存放低字节，高地址存放高字节。")
    .replace(/reserved fields must be written 0; reserved read values are not guaranteed/gi, "除字段另有说明外，保留位写入为 0。")
    .replace(/读出值不保证。/g, "")
    .replace(/Read clears the EEE wake error counter\./gi, "读取会清除 EEE 唤醒错误计数器。")
    .replace(/write 0 unless the register-specific description explicitly requires another behavior; ignore reserved read values/gi, "除字段另有说明外，保留位写入为 0；不解释读出值。")
    .replace(/LSB at lower ESC address for multi-byte ESC registers; coherent\/latch behavior is register-specific/gi, "小端字节序：低地址存放低字节。多字节一致性／锁存条件见具体寄存器说明。")
    .replace(/System CSRs are DWORD-oriented; HBI\/SPI bridge performs documented byte\/word assembly\/disassembly/gi, "本地系统 CSR 按 DWORD 定义；HBI/SPI 的字节／字访问按接口规则组装。")
    .replace(/16-bit PHY register semantics; access through MII\/MMD management path/gi, "16 位 PHY 寄存器，通过 MII/MMD 管理路径访问。")
    .replace(/LSB at lower ESC address; multi-byte transaction ordering is register-specific/gi, "低地址存放低字节；多字节访问顺序见具体寄存器说明。")
    .replace(/LSB at lower (?:ESC|EtherCAT Core) address/gi, "低地址存放低字节。")
    .replace(/Read low byte\/low part first; this latches upper bits for a consistent 64-bit snapshot\./gi, "先读取低字节／低半部，锁存高位以取得一致的 64 位快照。")
    .replace(/for registers with snapshot-latch semantics, read the low byte\/low part first\./gi, "对具有快照锁存语义的寄存器，先读取低字节／低半部。")
    .replace(/byte-addressed memory; (?:EtherCAT\/PDI application endianness is protocol-specific|application data endianness is protocol\/application-defined)/gi, "按字节寻址；应用数据字节序由协议／应用定义。")
    .replace(/^field-defined$/i, "按各字段定义").replace(/^EEPROM-configurable$/i, "可由 EEPROM 配置")
    .replace(/Configuration registers with r\/\(w\) are writable only while this SyncManager is disabled \(\+0x6\[0\]=0\)\./gi, "仅在对应 SyncManager 通道禁用（激活寄存器 bit0=0）时允许修改配置。");
}

/** Only readable EtherCAT master ranges can create device reads. */
function canRead(definition: RegisterDefinition): boolean {
  return definition.direct_read_allowed === true && definition.access !== "WO" && !definition.is_reserved;
}

/** Keep communication errors near the affected register. */
function failureText(error: unknown): string {
  if (error instanceof BridgeRequestError && !error.failure.session_invalidated) return error.failure.message;
  return error instanceof Error ? error.message : "操作未完成，请检查从站连接。";
}

/** Secondary information stays available without filling the default workspace. */
function Disclosure({ title, children, defaultExpanded = false }: { title: string; children: ReactNode | (() => ReactNode); defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return <Accordion expanded={expanded} onChange={(_, value) => setExpanded(value)} disableGutters elevation={0} sx={disclosureSx}
    slotProps={{ transition: { mountOnEnter: true, unmountOnExit: true } }}>
    <AccordionSummary expandIcon={<ExpandMoreRounded sx={{ fontSize: 17 }} />}><Typography fontSize={12}>{title}</Typography></AccordionSummary>
    <AccordionDetails>{expanded && (typeof children === "function" ? children() : children)}</AccordionDetails>
  </Accordion>;
}

/** Separate reference sections with consistent headings and readable field rows. */
function DocumentationSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <Stack spacing={0.75}>
    <Typography fontSize={12} fontWeight={600}>{title}</Typography>
    {children}
  </Stack>;
}

/** Use the same English permission codes and hover explanations throughout the page. */
function RegisterAccess({ access }: { access?: string }) {
  return <Tooltip title={registerAccessDescription(access)}>
    <Typography component="span" sx={{ fontSize: "inherit", color: "inherit" }}>{registerAccessLabel(access)}</Typography>
  </Tooltip>;
}

/** Field permissions and meanings remain together within each separated row. */
function DocumentationFields({ fields }: { fields: NonNullable<RegisterDefinition["fields"]> }) {
  return <Stack divider={<Divider />} spacing={1}>
    {fields.map((field, index) => {
      const accesses = [["ECAT", field.ecat_access], ["PDI", field.pdi_access]]
        .filter(([, access]) => documentationText(registerAccessLabel(access)));
      const description = documentationText(field.description);
      return <Box key={`${field.bits}-${index}`} sx={{ lineHeight: 1.7 }}>
        <Typography fontSize={11} fontWeight={600}>{field.bits} · {field.reserved ? "保留" : field.name}</Typography>
        {accesses.length > 0 && <Stack direction="row" spacing={0.75} divider={<Typography fontSize={11} color="text.secondary">·</Typography>}>
          {accesses.map(([label, access]) => <Typography key={label} fontSize={11} color="text.secondary">{label}：<RegisterAccess access={access} /></Typography>)}
        </Stack>}
        {description && <Typography fontSize={11} sx={{ mt: 0.25, lineHeight: 1.7, whiteSpace: "pre-line" }}>{description}</Typography>}
      </Box>;
    })}
  </Stack>;
}

interface RegisterRowProps {
  definition: RegisterDefinition; index: number; value?: string; change?: ValueChange; error?: string;
  format: ValueFormat; monitor: boolean; selected: boolean; writing: boolean; reading: boolean;
  favorite: boolean; favoriteFeedback: boolean;
  onSelect: (definition: RegisterDefinition) => void;
  onFavorite: (definition: RegisterDefinition, monitor: boolean, favorite: boolean) => void;
}

/** Unchanged rows stay idle when selection, editor state, or another value changes. */
const RegisterTableRow = memo(function RegisterTableRow({ definition, index, value, change, error, format, monitor, selected,
  writing, reading, favorite, favoriteFeedback, onSelect, onFavorite }: RegisterRowProps) {
  const key = definitionKey(definition), name = registerDisplayName(definition), meaning = registerMeaning(definition, value);
  return <TableRow key={key} data-register-key={key} data-register-index={index} aria-rowindex={index + 2} hover selected={selected} tabIndex={writing ? -1 : 0}
    onClick={() => onSelect(definition)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") onSelect(definition); }}
    sx={{ cursor: "pointer", height: 36, "&:hover .register-favorite, &:focus-within .register-favorite": { visibility: "visible" }, "&.Mui-selected": { bgcolor: "#EDF2FF" } }}>
    <TableCell className="mono" sx={{ color: "text.primary", fontWeight: 650, whiteSpace: "pre-line", lineHeight: "14px" }}>{isPramOverview(definition) ? definition.address_text?.replace("-", "-\n") : hex(definition.address)}</TableCell>
    {/* Show bilingual register names only after a deliberate hover. */}
    <TableCell sx={{ overflow: "hidden" }}><Tooltip title={<Stack spacing={0.25}><span>{name}</span>{name !== (definition.official_name ?? definition.name) && <span>{definition.official_name ?? definition.name}</span>}</Stack>}><Typography fontSize={12} fontWeight={400} noWrap>{name}</Typography></Tooltip></TableCell>
    <TableCell><Tooltip title={error || readHint(definition) || (monitor && change && value ? `${formatRegisterValue(change.previous, format)} → ${formatRegisterValue(value, format)}` : value ?? "")}>
      <Typography className="mono" fontSize={12} color={error ? "error.main" : "text.primary"} noWrap>
        {isPramOverview(definition) ? "进入 PRAM 分类" : !ecatAccessible(definition) ? "ECAT不可访问" : value ? formatRegisterValue(value, format) : error ? "读取失败" : definition.is_reserved ? "保留地址" : definition.access === "WO" ? "只写" : requiresManualRead(definition) ? "需手动读取" : definition.automatic_read_allowed === false ? "不适用" : reading ? "读取中…" : "未读取"}
        {value && meaning && <Box component="span" sx={{ color: "text.secondary", ml: 0.75, fontFamily: "inherit", fontSize: 11 }}>{meaning}</Box>}
        {value && error && <Box component="span" sx={{ color: "error.main", ml: 0.75, fontSize: 11 }}>旧值 · 读取失败</Box>}
        {monitor && change && <Box component="span" sx={{ color: "warning.main", ml: 0.75, fontSize: 11 }}>变化</Box>}
      </Typography>
    </Tooltip></TableCell>
    <TableCell><Typography fontSize={11} color="text.secondary">{isPramOverview(definition) ? "—" : <RegisterAccess access={definition.access} />}</Typography></TableCell>
    <TableCell><Typography fontSize={11} color="text.secondary">{isPramOverview(definition) ? "—" : `${registerWidth(definition)} B`}</Typography></TableCell>
    <TableCell sx={{ px: 0.25 }}>{!isPramOverview(definition) && <IconButton size="small" className="register-favorite" aria-label={monitor ? `移除监视 ${registerLabel(definition.name)}` : `收藏 ${registerLabel(definition.name)}`}
      sx={{ p: 0.5, visibility: monitor || favorite ? "visible" : "hidden" }} onClick={(event) => {
        event.stopPropagation();
        onFavorite(definition, monitor, favorite);
      }}>{monitor ? <CloseRounded sx={{ fontSize: 16 }} /> : favorite ? <StarRounded className={favoriteFeedback ? "register-star-selected" : undefined} sx={{ fontSize: 16 }} color="warning" /> : <StarBorderRounded sx={{ fontSize: 16 }} />}</IconButton>}</TableCell>
  </TableRow>;
});

interface RegisterTableProps {
  definitions: RegisterDefinition[]; values: Record<string, RegisterValue>; changes: Record<string, ValueChange>;
  errors: Record<string, string>; favorites: Set<string>; selectedKey: string; favoriteFeedback?: string;
  format: ValueFormat; monitor: boolean; writing: boolean; reading: boolean; scope: string;
  loading: boolean; emptyText: string; detailsVisible: boolean;
  onSelect: RegisterRowProps["onSelect"]; onFavorite: RegisterRowProps["onFavorite"];
}
const registerRowHeight = 36;
const registerHeaderHeight = 36;
const registerOverscan = 8;

/** Keep only viewport rows mounted while spacer rows preserve the full scroll range. */
const VirtualRegisterTable = memo(function VirtualRegisterTable({ definitions, values, changes, errors, favorites, selectedKey,
  favoriteFeedback, format, monitor, writing, reading, scope, loading, emptyText, detailsVisible, onSelect, onFavorite }: RegisterTableProps) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => setViewport((current) => current.height === element.clientHeight ? current : { ...current, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Filters reset the scroll position; selecting or favoriting a row does not.
  useLayoutEffect(() => {
    if (container.current) container.current.scrollTop = 0;
    setViewport((current) => current.top === 0 ? current : { ...current, top: 0 });
  }, [scope]);
  const firstVisible = Math.floor(Math.max(0, viewport.top - registerHeaderHeight) / registerRowHeight);
  const start = Math.max(0, Math.min(firstVisible - registerOverscan, definitions.length - 1));
  const end = Math.min(definitions.length, Math.ceil((viewport.top + viewport.height) / registerRowHeight) + registerOverscan);

  /** Arrow navigation scrolls and mounts the target before moving keyboard focus. */
  const navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-register-index]");
    if (!row || event.target !== row || writing || !container.current) return;
    const index = Number(row.dataset.registerIndex);
    const target = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1
      : event.key === "Home" ? 0 : event.key === "End" ? definitions.length - 1 : undefined;
    if (target === undefined || target < 0 || target >= definitions.length) return;
    event.preventDefault();
    const element = container.current, top = target * registerRowHeight + registerHeaderHeight;
    if (top < element.scrollTop + registerHeaderHeight) element.scrollTop = top - registerHeaderHeight;
    else if (top + registerRowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + registerRowHeight - element.clientHeight;
    setViewport((current) => ({ ...current, top: element.scrollTop }));
    requestAnimationFrame(() => element.querySelector<HTMLTableRowElement>(`tr[data-register-index="${target}"]`)?.focus({ preventScroll: true }));
  };
  return <TableContainer ref={container} onKeyDown={navigate} onScroll={(event) => {
    const top = event.currentTarget.scrollTop;
    setViewport((current) => current.top === top ? current : { ...current, top });
  }} sx={{ flex: 1, minHeight: 0, overflowAnchor: "none" }}>
    {/* Adjust the value column position with the detail panel while keeping header and cells aligned. */}
    <Table stickyHeader size="small" aria-rowcount={definitions.length + 1} sx={{ tableLayout: "fixed", "& td, & th": { fontSize: 12, py: 0.5, borderColor: "#EEF1F6", boxSizing: "border-box", height: registerRowHeight }, "& th": { py: 0, height: registerHeaderHeight } }}>
      <TableHead><TableRow aria-rowindex={1}>
        <TableCell sx={{ width: 90 }}>地址</TableCell><TableCell>寄存器</TableCell><TableCell sx={{ width: detailsVisible ? 192 : 320 }}>当前值</TableCell>
        <TableCell sx={{ width: 58 }}>权限</TableCell><TableCell sx={{ width: 58 }}>宽度</TableCell><TableCell sx={{ width: 32 }} />
      </TableRow></TableHead>
      <TableBody>
        {start > 0 && <TableRow aria-hidden><TableCell colSpan={6} style={{ padding: 0, border: 0, height: start * registerRowHeight }} /></TableRow>}
        {definitions.slice(start, end).map((definition, offset) => {
          const key = definitionKey(definition);
          return <RegisterTableRow key={key} definition={definition} index={start + offset} value={values[key]?.data} change={changes[key]} error={errors[key]}
            format={format} monitor={monitor} selected={key === selectedKey} writing={writing} reading={reading && !values[key]}
            favorite={favorites.has(key)} favoriteFeedback={favoriteFeedback === key} onSelect={onSelect} onFavorite={onFavorite} />;
        })}
        {end < definitions.length && <TableRow aria-hidden><TableCell colSpan={6} style={{ padding: 0, border: 0, height: (definitions.length - end) * registerRowHeight }} /></TableRow>}
        {!definitions.length && <TableRow><TableCell colSpan={6} sx={{ py: "70px !important", textAlign: "center", color: "text.secondary" }}>
          {loading ? <CircularProgress size={22} /> : emptyText}
        </TableCell></TableRow>}
      </TableBody>
    </Table>
  </TableContainer>;
});

/** A session snapshot serves all list views; only explicit monitoring repeats reads. */
export const RegistersPage = memo(function RegistersPage({ slave, run, registerProfile, deviceOperationsBlocked, sessionContext }: Props) {
  const outerTheme = useTheme();
  // The nested theme also reaches portal menus and dialogs, without affecting other pages.
  const registerTheme = useMemo(() => createTheme(outerTheme, {
    components: {
      MuiButtonBase: {
        defaultProps: { disableRipple: true },
        styleOverrides: { root: {
          transition: "background-color 120ms ease-out, color 120ms ease-out, box-shadow 120ms ease-out",
          "&.Mui-focusVisible": { outline: "2px solid #365CCF", outlineOffset: 2 },
          "@media (prefers-reduced-motion: reduce)": { transition: "none" },
        } },
      },
      MuiButton: { styleOverrides: { root: {
        transition: "background-color 120ms ease-out, color 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out",
        "&:active:not(.Mui-disabled)": { backgroundColor: "#E9EEFF" },
        "&.MuiButton-contained:active:not(.Mui-disabled)": { backgroundColor: "#2846A6", boxShadow: "inset 0 2px 3px #17203330" },
        "&.MuiButton-containedError:active:not(.Mui-disabled)": { backgroundColor: "#A82F39" },
        "&.MuiButton-outlinedError:active:not(.Mui-disabled)": { backgroundColor: "#FFF0F1" },
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
      } } },
      MuiIconButton: { styleOverrides: { root: {
        transition: "background-color 120ms ease-out, color 120ms ease-out",
        "&:active:not(.Mui-disabled)": { backgroundColor: "#E9EEFF" },
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
      } } },
    },
  }), [outerTheme]);
  const [catalog, setCatalog] = useState<RegisterDefinition[]>([]);
  const catalogVersion = useRef("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [view, setView] = useState<CatalogView>("common");
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [monitor, setMonitor] = useState(false);
  const [selected, setSelected] = useState<RegisterDefinition>();
  const [fieldVariant, setFieldVariant] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const preferences = useMemo(() => registerPreferences(registerProfile), [registerProfile]);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(preferences.favorites));
  const [pinned, setPinned] = useState<RegisterDefinition[]>([]);
  const [values, setValues] = useState<Record<string, RegisterValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [changes, setChanges] = useState<Record<string, ValueChange>>({});
  const [snapshotInfo, setSnapshotInfo] = useState<RegisterSnapshot>();
  const [showReservedAddresses, setShowReservedAddresses] = useState(false);
  const [format, setFormat] = useState<ValueFormat>(preferences.format);
  const [reading, setReading] = useState(false);
  const [watching, setWatching] = useState(false);
  const [intervalMs, setIntervalMs] = useState(preferences.intervalMs);
  const [manualTarget, setManualTarget] = useState<ManualTarget>();
  const [manualOpen, setManualOpen] = useState(false);
  // A stable callback lets the PDF viewer ignore register acquisition updates.
  const closeManual = useCallback(() => setManualOpen(false), []);
  const [watchConfirm, setWatchConfirm] = useState<RegisterDefinition>();
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawAddress, setRawAddress] = useState("0x0000");
  const [rawSize, setRawSize] = useState(1);
  const [rawFormat, setRawFormat] = useState<RawFormat>("hex");
  const [rawWriteInput, setRawWriteInput] = useState("");
  const [rawWriteWkc, setRawWriteWkc] = useState<number | null>();
  const [rawReadWkc, setRawReadWkc] = useState<number | null>();
  const [rawResult, setRawResult] = useState<RegisterValue>();
  const [rawError, setRawError] = useState("");
  const [writeContext, setWriteContext] = useState<WriteContext>();
  const [writeInput, setWriteInput] = useState("");
  const [writeFormat, setWriteFormat] = useState<ValueFormat>("hex");
  const [writeError, setWriteError] = useState("");
  const [writeMessage, setWriteMessage] = useState("");
  const [readbackKeys, setReadbackKeys] = useState<Set<string>>(new Set());
  const [writing, setWriting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [favoriteFeedback, setFavoriteFeedback] = useState<string>();
  const cache = useRef(new Map<string, Promise<RegisterDefinition>>());
  const resolvedDefinitions = useRef(new Map<string, RegisterDefinition>());
  const valuesRef = useRef(values);
  const dirtyRef = useRef(false);
  const attempted = useRef(new Set<string>());
  const queue = useRef<ReadJob[]>([]);
  const queued = useRef(new Set<string>());
  const automaticPaused = useRef(false);
  const fullReadQueued = useRef(false);
  const initialReadDone = useRef(false);
  const snapshotRequest = useRef<string | undefined>(undefined);
  const persistedPinned = useRef(preferences.pinned);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const blockedRef = useRef(deviceOperationsBlocked);
  const identity = slave ? `${slave.position}:${slave.configured_address}:${Object.values(slave.identity).join(":")}` : "none";
  const context = `${sessionContext}:${identity}:${registerProfile}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  valuesRef.current = values;
  blockedRef.current = deviceOperationsBlocked;

  // Clear transient copy feedback when it expires or the displayed value changes.
  useEffect(() => {
    setCopied(false);
  }, [selected, format, selected ? values[definitionKey(selected)]?.data : undefined]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // Animate only a newly added favorite, rather than every remount of a saved star.
  useEffect(() => {
    if (!favoriteFeedback) return;
    const timer = window.setTimeout(() => setFavoriteFeedback(undefined), 160);
    return () => window.clearTimeout(timer);
  }, [favoriteFeedback]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = operationStore.subscribe(() => { void drainRef.current(); });
    return () => {
      mounted.current = false; queue.current = []; queued.current.clear(); unsubscribe();
      if (snapshotRequest.current) void bridgeRequest("register_cancel", { request_id: snapshotRequest.current }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (cachedSession !== sessionContext) { snapshots.clear(); cachedSession = sessionContext; }
    const saved = snapshots.get(context);
    cache.current = new Map(); resolvedDefinitions.current = saved?.details ?? new Map();
    catalogVersion.current = saved?.catalogVersion ?? ""; queue.current = []; queued.current.clear(); attempted.current.clear();
    automaticPaused.current = false; fullReadQueued.current = false; initialReadDone.current = Boolean(saved?.snapshot);
    dirtyRef.current = false; requestSequence.current += 1;
    setCatalog(saved?.catalog ?? []); setSelected(undefined); setPinned([]);
    setValues(saved?.values ?? {}); valuesRef.current = saved?.values ?? {}; setErrors(saved?.errors ?? {});
    setChanges({}); setSnapshotInfo(saved?.snapshot); setReadbackKeys(new Set());
    setWatching(false); setReading(false); setDetailLoading(false);
    setPageError(""); setDetailError(""); setManualOpen(false); setWriteContext(undefined); setWatchConfirm(undefined);
    setRawOpen(false); setRawResult(undefined); setRawError(""); setRawWriteInput(""); setRawWriteWkc(undefined); setRawReadWkc(undefined); setResetConfirm(false); setMonitor(false);
    if (!slave) return;
    setCatalogLoading(true);
    bridgeRequest<RegisterCatalog>("register_catalog", { position: slave.position, profile: registerProfile, catalog_version: catalogVersion.current })
      .then((data) => { if (active) acceptCatalog(data.catalog, data.catalog_version); })
      .catch((error) => { if (active) setPageError(failureText(error)); })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [context]);

  // Persist UI choices; runtime snapshots are scoped to the current connection.
  useEffect(() => {
    if (!catalog.length) return;
    setPinned((current) => {
      const ids = new Set([...persistedPinned.current, ...current.map(definitionKey)]);
      return catalog.filter((item) => ids.has(definitionKey(item)) && canRead(item));
    });
  }, [catalog]);
  useEffect(() => {
    if (!catalog.length) return;
    const available = new Set(catalog.map(definitionKey));
    persistedPinned.current = [...persistedPinned.current.filter((id) => !available.has(id)), ...pinned.map(definitionKey)];
    window.localStorage.setItem(`benchcat-registers:${registerProfile}`, JSON.stringify({ favorites: [...favorites], pinned: persistedPinned.current, intervalMs, format }));
  }, [favorites, pinned, intervalMs, format, registerProfile]);
  useEffect(() => {
    if (catalog.length) snapshots.set(context, { catalog, catalogVersion: catalogVersion.current, details: resolvedDefinitions.current, values, errors, snapshot: snapshotInfo });
  }, [catalog, values, errors, snapshotInfo, context]);

  // Reference-only groups are explicit choices and always appear at the end of the menu.
  const groups = useMemo(() => {
    const available = new Set(catalog.filter((item) => ecatAccessible(item) || referenceGroups.includes(functionGroup(item))).map(functionGroup));
    return [...available].filter((item) => !referenceGroups.includes(item)).concat(referenceGroups.filter((item) => available.has(item)));
  }, [catalog]);
  // Collapse PRAM only in the all-functions view; its category retains actual memory windows.
  const listCatalog = useMemo(() => {
    if (view !== "all" || group) return catalog;
    const pram = catalog.find((item) => item.address_space === "process_ram");
    if (!pram) return catalog;
    const overview: RegisterDefinition = {
      ...pram, definition_id: `${registerProfile}|process_ram_overview`, address_space: "process_ram_overview",
      address: 0x1000, address_text: "0x1000-0x1FFFF", width: 0x1f000, width_bits: 0xf8000,
      name: "PRAM", official_name: "Process Data RAM", description: "进入 PRAM 分类",
      direct_read_allowed: false, direct_write_allowed: false, automatic_read_allowed: false,
    };
    return [...catalog.filter((item) => item.address_space !== "process_ram"), overview];
  }, [catalog, view, group, registerProfile]);
  // Calculate relevance once per row, then keep matching addresses ahead of text.
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return listCatalog.flatMap((item) => {
      const itemGroup = functionGroup(item);
      if (!ecatAccessible(item) && !isPramOverview(item) && !(referenceGroups.includes(group) && itemGroup === group)) return [];
      if (!showReservedAddresses && item.is_reserved) return [];
      if (view === "favorites" && !favorites.has(definitionKey(item))) return [];
      if (!text && view === "common" && !isCommonRegister(item)) return [];
      if (group && itemGroup !== group) return [];
      const addressRank = registerSearchRank(item, text);
      const rank = Number.isFinite(addressRank) ? addressRank : text && (groupLabels[itemGroup] ?? "").includes(text) ? 3 : Infinity;
      return Number.isFinite(rank) ? [{ definition: item, rank }] : [];
    }).sort((left, right) => left.rank - right.rank || left.definition.address - right.definition.address).map((item) => item.definition);
  }, [listCatalog, view, group, query, favorites, showReservedAddresses]);
  const displayed = monitor ? pinned : filtered;
  const selectedKey = selected ? definitionKey(selected) : "";
  // Reset conditional tables on selection; reset status is the normal read interpretation.
  useEffect(() => { setFieldVariant(selected?.field_variants?.[0]?.name === "读取状态" ? "读取状态" : ""); }, [selectedKey, selected?.field_variants]);
  const variantFields = selected?.field_variants?.find((variant) => variant.name === fieldVariant)?.fields;
  const parsedDefinition = selected && variantFields ? { ...selected, fields: variantFields, bit_fields: [] } : selected;
  const selectedValue = values[selectedKey];
  const selectedFields = parsedDefinition && selectedValue ? decodeRegisterFields(parsedDefinition, selectedValue.data) : [];
  // Keep documented metadata only, excluding the routine little-endian explanation.
  const documentationItems: [string, string | undefined][] = selected ? [
    ["主站权限", registerAccessLabel(selected.master_access ?? selected.access)],
    ["PDI 权限", registerAccessLabel(selected.pdi_access)],
    ["复位／默认值", selected.reset_value],
    ["上电值", selected.power_on_default !== selected.reset_value ? selected.power_on_default : undefined],
    ["AL 状态限制", selected.state_restriction],
    ["硬件／访问条件", selected.hardware_condition],
    ["保留位规则", selected.fields?.some((field) => field.reserved) || selected.field_variants?.some((variant) => variant.fields.some((field) => field.reserved)) ? selected.reserved_bits_rule : undefined],
    ["字节序", selected.byte_order],
  ] : [];
  const visibleDocumentationItems = documentationItems.map(([label, text]) => [label, documentationText(text)])
    .filter(([label, text]) => text && !(label === "字节序" && text === "小端字节序：低地址存放低字节，高地址存放高字节。"));
  const operationNotes: [string, string | undefined][] = selected ? [
    ...(selected.read_side_effects ?? []).map((text): [string, string] => [selected.address_space === "user_ram" || selected.address_space === "process_ram" ? "读取说明" : /Read clears.*counter/i.test(text) ? "读取清除" : "读取确认", text]),
    ...(selected.write_side_effects ?? []).map((text): [string, string] => ["写入副作用", text]),
    ["写入顺序", selected.write_sequence],
    ...(selected.documentation_notes ?? []).map((text): [string, string] => ["", text]),
  ] : [];
  const visibleOperationNotes = operationNotes.map(([label, text]) => [label, documentationText(text)]).filter(([, text]) => text);
  const rawNumericAddress = parseRegisterAddress(rawAddress);
  const rawDefinition = catalog.find((item) => item.address_space === "esc_core" && item.address === rawNumericAddress);
  // Catalog matches are informational; raw access always uses the user's byte length.
  const rawValid = rawNumericAddress !== undefined && Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 256 && rawNumericAddress + rawSize <= 0x10000;
  const rawWriteBytes = encodeRegisterInput(rawWriteInput, rawSize, rawFormat);
  const writeBytes = writeContext ? encodeRegisterInput(writeInput, writeContext.width, writeFormat) : undefined;
  const writeFields = writeContext?.definition ? decodeRegisterFields(writeContext.definition, writeContext.current ?? Array(writeContext.width).fill("00").join(" ")) : [];
  const controlsBlocked = deviceOperationsBlocked || reading || writing;
  const writable = Boolean(selected?.direct_write_allowed && selected.access !== "RO" && !selected.dangerous);

  /** Replace catalogs only when capabilities change, invalidating stale detail requests. */
  const acceptCatalog = (definitions: RegisterDefinition[] | null | undefined, version?: string) => {
    if (!definitions) return;
    if (version !== catalogVersion.current) {
      cache.current = new Map(); resolvedDefinitions.current = new Map();
      requestSequence.current += 1; setSelected(undefined); setWriteContext(undefined); setDetailLoading(false);
    }
    catalogVersion.current = version ?? "";
    setCatalog(definitions);
  };

  /** Detailed permissions and read side effects are resolved before automatic reads. */
  const loadDefinition = (definition: RegisterDefinition): Promise<RegisterDefinition> => {
    const key = definitionKey(definition);
    const resolved = resolvedDefinitions.current.get(key);
    if (resolved) return Promise.resolve(resolved);
    let pending = cache.current.get(key);
    if (!pending) {
      const resolvedCache = resolvedDefinitions.current;
      pending = bridgeRequest<RegisterDefinition>("register_definition", { position: slave?.position, profile: registerProfile, definition_id: definition.definition_id })
        .then((detail) => { resolvedCache.set(key, detail); return detail; });
      const currentCache = cache.current;
      currentCache.set(key, pending);
      void pending.catch(() => { if (currentCache.get(key) === pending) currentCache.delete(key); });
    }
    return pending;
  };

  /** Manual, automatic and watched values update the same cached rows. */
  const acceptValues = (definitions: RegisterDefinition[], results: RegisterValue[], requestedContext: string) => {
    if (!mounted.current || contextRef.current !== requestedContext) return;
    const next = { ...valuesRef.current }, nextChanges: Record<string, ValueChange> = {};
    const keys: string[] = [];
    // Index acquired ranges once instead of scanning every result for every catalog entry.
    const ranges = new Map(results.map((item) => [`${item.address}:${item.data.trim().split(/\s+/).length}`, item]));
    for (const definition of definitions) {
      // Local/PHY offsets must never acquire values from a same-address ESC transaction.
      if (!canRead(definition)) continue;
      const value = ranges.get(`${definition.address}:${registerWidth(definition)}`);
      if (!value) continue;
      const key = definitionKey(definition), previous = next[key];
      if (previous && previous.data !== value.data) nextChanges[key] = { previous: previous.data, timestamp: value.timestamp };
      next[key] = value; keys.push(key);
    }
    valuesRef.current = next; setValues(next); setChanges((current) => ({ ...current, ...nextChanges }));
    setReadbackKeys((current) => new Set([...current].filter((key) => !keys.includes(key))));
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))));
  };

  /** One logical snapshot packs all pending reads; rows update after the batch returns. */
  drainRef.current = async () => {
    if (!slave || !mounted.current || blockedRef.current || busyRef.current || operationStore.activeHardware() || operationStore.active("register_watch") || (!queue.current.length && !fullReadQueued.current)) return;
    const requestedContext = context;
    busyRef.current = true; setReading(true);
    try {
      while ((queue.current.length || fullReadQueued.current) && mounted.current && contextRef.current === requestedContext && !blockedRef.current && !operationStore.activeHardware() && !operationStore.active("register_watch")) {
        const jobs = queue.current.splice(0).filter((job) => job.context === requestedContext && canRead(job.definition));
        const readAll = fullReadQueued.current;
        fullReadQueued.current = false;
        if (!jobs.length && !readAll) break;
        const requestId = `register-${crypto.randomUUID()}`;
        snapshotRequest.current = requestId;
        try {
          const result = await bridgeRequest<RegisterSnapshot>("register_snapshot", {
            request_id: requestId, position: slave.position, profile: registerProfile, all: readAll, catalog_version: catalogVersion.current,
            automatic: jobs.every((job) => job.automatic),
            // Full acquisition is resolved by the backend catalog, without repeating every range in the request.
            requests: readAll ? [] : jobs.map((job) => ({ address: job.definition.address, size: registerWidth(job.definition), definition_id: job.definition.definition_id })),
          });
          if (!mounted.current || contextRef.current !== requestedContext) break;
          acceptCatalog(result.catalog, result.catalog_version);
          acceptValues(result.catalog ?? (readAll ? catalog : jobs.map((job) => job.definition)), result.values, requestedContext);
          setErrors((current) => ({ ...current, ...result.errors })); setSnapshotInfo(result);
          if (result.error) setPageError(result.error);
          for (const job of jobs) attempted.current.add(definitionKey(job.definition));
          if (result.cancelled) { queue.current = []; fullReadQueued.current = false; break; }
        } catch (error) {
          if (mounted.current && contextRef.current === requestedContext) {
            setErrors((current) => ({ ...current, ...Object.fromEntries(jobs.map((job) => [definitionKey(job.definition), failureText(error)])) }));
            setPageError(failureText(error)); automaticPaused.current = true;
            queue.current = []; fullReadQueued.current = false; queued.current.clear(); break;
          }
        } finally {
          for (const job of jobs) queued.current.delete(definitionKey(job.definition));
          if (snapshotRequest.current === requestId) snapshotRequest.current = undefined;
        }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current && contextRef.current === requestedContext) setReading(false);
    }
  };

  /** Explicit jobs replace a pending automatic job without duplicating its device read. */
  const enqueueReads = (definitions: RegisterDefinition[], automatic = false, all = false) => {
    if (all) fullReadQueued.current = true;
    const jobs: ReadJob[] = [];
    for (const definition of definitions.filter(canRead)) {
      const key = definitionKey(definition);
      if (queued.current.has(key)) {
        if (!automatic) queue.current.forEach((job) => { if (definitionKey(job.definition) === key) job.automatic = false; });
        continue;
      }
      if (automatic && !all && (attempted.current.has(key) || automaticPaused.current)) continue;
      queued.current.add(key); jobs.push({ definition, automatic, context });
    }
    queue.current = automatic ? [...queue.current, ...jobs] : [...jobs, ...queue.current];
    void drainRef.current();
  };

  // One initial snapshot serves scrolling, search and function filters.
  useEffect(() => {
    if (catalog.length && !initialReadDone.current && !deviceOperationsBlocked && !writing && !rawOpen) {
      initialReadDone.current = true;
      enqueueReads(catalog, true, true);
    }
  }, [catalog, deviceOperationsBlocked, writing, rawOpen]);

  /** Selecting a register fetches missing values without requiring a second button. */
  const selectDefinition = async (definition: RegisterDefinition) => {
    if (writing || deviceOperationsBlocked) return;
    // The overview opens the PRAM category without loading a definition or reading memory.
    if (isPramOverview(definition)) {
      requestSequence.current += 1;
      setGroup(definition.group); setQuery(""); setSelected(undefined); setWriteContext(undefined);
      return;
    }
    // Re-selecting the current row preserves its editor and avoids redundant state updates.
    if (selectedKey === definitionKey(definition) && !detailError) return;
    const sequence = ++requestSequence.current, requestedContext = context;
    const cached = resolvedDefinitions.current.get(definitionKey(definition));
    dirtyRef.current = false; setSelected(cached ?? definition); setWriteContext(undefined); setWriteInput("");
    setWriteError(""); setWriteMessage(""); setDetailLoading(!cached); setDetailError("");
    // Cached definitions appear synchronously, without a loading-state round trip.
    if (cached) {
      if (!valuesRef.current[definitionKey(cached)] && cached.automatic_read_allowed !== false && !requiresManualRead(cached)) enqueueReads([cached], true);
      return;
    }
    try {
      const detail = await loadDefinition(definition);
      if (!mounted.current || contextRef.current !== requestedContext || sequence !== requestSequence.current) return;
      setSelected(detail);
      if (!valuesRef.current[definitionKey(detail)] && detail.automatic_read_allowed !== false && !requiresManualRead(detail)) enqueueReads([detail], true);
    } catch (error) {
      if (mounted.current && contextRef.current === requestedContext && sequence === requestSequence.current) setDetailError(failureText(error));
    } finally {
      if (mounted.current && contextRef.current === requestedContext && sequence === requestSequence.current) setDetailLoading(false);
    }
  };

  /** Preserve user edits while keeping an untouched editor in step with current values. */
  const initializeEditor = (target: WriteContext) => {
    const nextFormat = target.width <= 8 ? "hex" : "bytes";
    dirtyRef.current = false; setWriteFormat(nextFormat); setWriteError("");
    setWriteInput(["WAC", "W1C", "W1S"].includes(target.access) ? nextFormat === "bytes" ? "00".repeat(target.width) : "0" : target.current ? formatRegisterValue(target.current, nextFormat) : "");
    setWriteContext(target);
  };
  useEffect(() => {
    if (!selected || !writable || detailLoading || rawOpen || dirtyRef.current) return;
    initializeEditor({ definition: selected, address: selected.address, width: registerWidth(selected), access: selected.access, name: selected.name, current: selectedValue?.data });
  }, [selected, selectedValue?.data, writable, detailLoading, rawOpen]);

  /** Refresh all always targets the full safe catalog, regardless of list filters. */
  const refresh = () => {
    automaticPaused.current = false; setPageError(""); setWriteError(""); setWriteMessage(""); dirtyRef.current = false;
    enqueueReads(catalog, true, true);
  };

  /** Explicit monitoring presents the actual reason that default acquisition is manual. */
  const addWatch = (definition: RegisterDefinition) => {
    if (!canRead(definition)) return;
    if (requiresManualRead(definition)) { setWatchConfirm(definition); return; }
    setPinned((current) => current.some((item) => definitionKey(item) === definitionKey(definition)) ? current : [...current, definition]);
  };
  const pollKey = pinned.map(definitionKey).join("|");
  useEffect(() => {
    if (!monitor || !watching || !slave || deviceOperationsBlocked || !pinned.length) return;
    let active = true, timer: number | undefined, requestId: string | undefined;
    const requestedContext = context;
    /** Only the explicit monitor view performs repeated hardware transactions. */
    const poll = async () => {
      let acquired = false;
      try {
        if (busyRef.current || operationStore.activeHardware() || operationStore.active("register_watch")) return;
        busyRef.current = true; acquired = true;
        requestId = `watch-${crypto.randomUUID()}`;
        const result = await bridgeRequest<RegisterSnapshot>("register_watch", {
          request_id: requestId, profile: registerProfile,
          position: slave.position, requests: pinned.map((item) => ({ address: item.address, size: registerWidth(item), definition_id: item.definition_id, profile: registerProfile })),
        });
        if (active) {
          acceptValues(pinned, result.values, requestedContext);
          setErrors((current) => ({ ...current, ...result.errors }));
          setSnapshotInfo(result);
          if (result.error || Object.keys(result.errors).length) { setWatching(false); if (result.error) setPageError(result.error); }
        }
      } catch (error) {
        if (active && contextRef.current === requestedContext) {
          setWatching(false); setPageError(failureText(error));
          setErrors((current) => ({ ...current, ...Object.fromEntries(pinned.map((item) => [definitionKey(item), failureText(error)])) }));
        }
      } finally {
        if (acquired) { requestId = undefined; busyRef.current = false; void drainRef.current(); }
        if (active) timer = window.setTimeout(poll, intervalMs);
      }
    };
    void poll();
    return () => {
      active = false; if (timer !== undefined) window.clearTimeout(timer);
      if (requestId) void bridgeRequest("register_cancel", { request_id: requestId }).catch(() => {});
    };
  }, [watching, monitor, pollKey, intervalMs, context, deviceOperationsBlocked]);

  /** Shared HEX/DEC presentation preserves valid input without touching the device. */
  const changeRawFormat = (next: RawFormat | null) => {
    if (!next || next === rawFormat) return;
    if (rawWriteBytes) setRawWriteInput(formatRawValue(rawWriteBytes.match(/../g)!.join(" "), next));
    setRawFormat(next);
  };

  /** Raw writes and their single readback share one session-bound hardware operation. */
  const writeRaw = async () => {
    if (!slave || !rawValid || !rawWriteBytes || controlsBlocked || busyRef.current || operationStore.activeHardware()) return;
    const requestedContext = context;
    const address = rawNumericAddress!, size = rawSize;
    busyRef.current = true; setWriting(true); setWatching(false); setRawResult(undefined); setRawError(""); setRawWriteWkc(undefined); setRawReadWkc(undefined);
    try {
      const result = await bridgeRequest<RawWriteResult>("register_raw_write", { position: slave.position, address, size, data: rawWriteBytes });
      if (mounted.current && contextRef.current === requestedContext) {
        setRawWriteWkc(result.write_wkc); setRawReadWkc(result.readback?.wkc ?? null);
        const failures = [result.write_error && `写入：${result.write_error}`, result.read_error && `读取：${result.read_error}`];
        if (result.write_wkc !== null && result.write_wkc !== 1) failures.push(`写入 WKC=${result.write_wkc}`);
        if (result.readback && result.readback.wkc !== 1) failures.push(`读取 WKC=${result.readback.wkc}，未取得有效值`);
        setRawError(failures.filter(Boolean).join("；"));
        // Remove overlapping cached values before accepting the new readback.
        const affected = catalog.filter((item) => ecatAccessible(item) && item.address < address + size && item.address + registerWidth(item) > address).map(definitionKey);
        const next = { ...valuesRef.current }; affected.forEach((key) => delete next[key]);
        valuesRef.current = next; setValues(next);
        setReadbackKeys((current) => { const next = new Set(current); affected.forEach((key) => next.delete(key)); return next; });
        if (result.readback?.wkc === 1) {
          setRawResult(result.readback);
          if (rawDefinition && registerWidth(rawDefinition) === size) acceptValues([rawDefinition], [result.readback], requestedContext);
        }
      }
    } catch (error) { if (contextRef.current === requestedContext) { setRawWriteWkc(null); setRawReadWkc(null); setRawError(failureText(error)); } }
    finally {
      busyRef.current = false;
      if (mounted.current && contextRef.current === requestedContext) setWriting(false);
      void drainRef.current();
    }
  };

  /** Writes retain declared semantics and reject a changed editing baseline. */
  const executeWrite = async () => {
    if (!slave || !writeContext || !writeBytes || controlsBlocked || busyRef.current || operationStore.activeHardware()) return;
    const target = writeContext, requestedContext = context;
    busyRef.current = true; setWriting(true); setWatching(false); setWriteError(""); setWriteMessage("");
    try {
      await run(async () => {
        try {
          const prepared = await bridgeRequest<{ plan_id: string; plan: { current: string } }>("register_prepare_write", {
            position: slave.position, address: target.address, size: target.width, data: writeBytes,
            semantics: target.access, known_register: Boolean(target.definition), definition_id: target.definition?.definition_id, profile: registerProfile,
          });
          if (!mounted.current || contextRef.current !== requestedContext) throw new BridgeRequestError({ code: "SESSION_CHANGED", message: "目标从站已变化。", user_message: "目标从站已变化，请重新选择寄存器。" });
          if (target.access === "RW" && target.current && registerNumber(prepared.plan.current) !== registerNumber(target.current)) throw new BridgeRequestError({ code: "REGISTER_CHANGED", message: "当前值已变化。", user_message: "当前值已变化，请刷新后再写入。" });
          const result = await bridgeRequest<WriteResult>("register_execute_write", { plan_id: prepared.plan_id });
          if (!mounted.current || contextRef.current !== requestedContext) return;
          dirtyRef.current = false;
          if (result.readback) {
            const value: RegisterValue = { position: slave.position, address: target.address, data: result.readback, wkc: result.fpwr_wkc, duration_ms: 0, timestamp: Date.now() / 1000 };
            if (target.definition) acceptValues([target.definition], [value], requestedContext);
            if (target.definition) setReadbackKeys((current) => new Set(current).add(definitionKey(target.definition!)));
            setWriteContext({ ...target, current: value.data });
            setWriteInput(["WAC", "W1C", "W1S"].includes(target.access) ? writeFormat === "bytes" ? "00".repeat(target.width) : "0" : formatRegisterValue(value.data, writeFormat));
          } else if (target.definition && canRead(target.definition)) {
            enqueueReads([target.definition]);
          }
          setWriteMessage("已写入");
        } catch (error) {
          if (mounted.current && contextRef.current === requestedContext) setWriteError(failureText(error));
          throw error;
        }
      });
    } finally {
      busyRef.current = false;
      if (mounted.current && contextRef.current === requestedContext) setWriting(false);
      void drainRef.current();
    }
  };

  /** Explicit reads bypass catalog permissions and preserve the requested byte range. */
  const readRaw = async () => {
    if (!slave || !rawValid || controlsBlocked || busyRef.current || operationStore.activeHardware()) return;
    const requestedContext = context;
    busyRef.current = true; setReading(true); setWatching(false); setRawResult(undefined); setRawError(""); setRawWriteWkc(undefined); setRawReadWkc(undefined);
    try {
      const result = await bridgeRequest<RegisterValue>("register_raw_read", { position: slave.position, address: rawNumericAddress, size: rawSize });
      if (mounted.current && contextRef.current === requestedContext) {
        setRawReadWkc(result.wkc);
        if (result.wkc === 1) {
          setRawResult(result);
          if (rawDefinition && registerWidth(rawDefinition) === rawSize) acceptValues([rawDefinition], [result], requestedContext);
        } else setRawError(`读取 WKC=${result.wkc}，未取得有效值`);
      }
    } catch (error) { if (contextRef.current === requestedContext) { setRawReadWkc(null); setRawError(failureText(error)); } }
    finally { busyRef.current = false; if (mounted.current && contextRef.current === requestedContext) setReading(false); void drainRef.current(); }
  };

  /** Field edits modify only the documented field bits, preserving the other bits. */
  const editField = (shift: number, width: number, input: string) => {
    if (!writeContext || !/^(?:0x)?[\da-f]+$/i.test(input) || !writeBytes) return;
    const value = BigInt(`0x${input.replace(/^0x/i, "")}`), mask = (1n << BigInt(width)) - 1n;
    if (value > mask) return;
    const current = registerNumber(writeBytes.match(/../g)!.join(" "));
    dirtyRef.current = true; setWatching(false); setWriteMessage("");
    setWriteFormat("hex"); setWriteInput(`0x${((current & ~(mask << BigInt(shift))) | (value << BigInt(shift))).toString(16).toUpperCase()}`);
  };

  /** Copy the displayed value without any device operation. */
  const copyValue = async () => {
    if (!selectedValue) return;
    const requestedContext = context;
    const requestedSequence = requestSequence.current;
    const copiedValue = await run(async () => { await navigator.clipboard.writeText(formatRegisterValue(selectedValue.data, format)); return true; }, "已复制寄存器值");
    if (copiedValue && mounted.current && contextRef.current === requestedContext && requestSequence.current === requestedSequence) setCopied(true);
  };

  /** Keep invalid drafts intact when changing numeric presentation. */
  const changeWriteFormat = (next: ValueFormat) => {
    if (writeBytes) setWriteInput(formatRegisterValue(writeBytes.match(/../g)!.join(" "), next));
    setWriteFormat(next);
  };

  /** Pass the selected definition's document and physical destination to the local viewer. */
  const openManual = (manual: RegisterManualReference) => {
    if (!selected) return;
    setManualTarget({ manual, name: selected.official_name || selected.name, address: selected.address_text || hex(selected.address) });
    setManualOpen(true);
  };

  if (!slave) return <Box sx={{ py: 8, textAlign: "center", color: "text.secondary" }}>请先选择从站</Box>;

  /** Edit catalog registers with their documented write semantics. */
  const renderEditor = () => <Stack spacing={1.25}>
    {writeContext?.access === "WAC" ? <Typography fontSize={12} color="text.secondary">写入后清零此计数器</Typography> : <Stack direction="row" spacing={0.75}>
      <TextField fullWidth size="small" label={writeContext?.access === "W1C" ? "清除位掩码" : writeContext?.access === "W1S" ? "置位掩码" : writeFormat === "bytes" ? "写入值（HEX）" : "写入值"} value={writeInput}
        onChange={(event) => { dirtyRef.current = true; setWatching(false); setWriteInput(event.target.value); setWriteMessage(""); }}
        helperText={writeFormat === "bytes" ? `按地址顺序输入 ${writeContext?.width} 字节十六进制数据，低地址在前。` : undefined}
        disabled={controlsBlocked} error={Boolean(writeInput && !writeBytes)} inputProps={{ className: "mono", style: { fontSize: 13 } }} />
      {writeFormat === "bytes" ? <Typography fontSize={12} color="text.secondary" sx={{ pt: 1 }}>HEX</Typography> : <FormControl size="small" sx={{ width: 87, flexShrink: 0 }}><Select value={writeFormat} inputProps={{ "aria-label": "写入值格式" }} disabled={controlsBlocked} onChange={(event) => changeWriteFormat(event.target.value as ValueFormat)} sx={{ fontSize: 12 }}>
        <MenuItem value="hex">HEX</MenuItem><MenuItem value="decimal">DEC</MenuItem>
      </Select></FormControl>}
    </Stack>}
    {writeInput && !writeBytes && <Typography fontSize={11} color="error.main">数值格式不正确或超出寄存器范围</Typography>}
    <Button fullWidth variant="contained" size="small" disabled={controlsBlocked || !writeBytes || Boolean(writeError) || !writeContext || (writeContext.access === "RW" && !writeContext.current)} onClick={() => void executeWrite()}>
      {writing ? "写入中…" : writeContext?.access === "WAC" ? "清零" : "写入"}
    </Button>
    {writeError && <Alert severity="error" sx={{ fontSize: 12 }}>{writeError}</Alert>}
    {writeMessage && <Typography fontSize={12} color="success.main">{writeMessage}</Typography>}
    <Disclosure title="写入细节"><Stack spacing={0.75}>
      {writeBytes && <>
        <Typography variant="caption" className="mono">目标值：{formatRegisterValue(writeBytes.match(/../g)!.join(" "))}</Typography>
        {writeContext?.access === "RW" && writeContext.current && <Typography variant="caption" className="mono">变化掩码：0x{(registerNumber(writeContext.current) ^ registerNumber(writeBytes.match(/../g)!.join(" "))).toString(16).toUpperCase()}</Typography>}
        <Typography variant="caption" className="mono" sx={{ overflowWrap: "anywhere" }}>发送字节：{writeBytes.match(/../g)!.join(" ")}</Typography>
      </>}
    </Stack></Disclosure>
  </Stack>;

  /** Compact rows keep timing and raw communication information out of the default table. */
  // Stable row callbacks dispatch to the current page logic without stale session state.
  const rowActions = useRef({ select: selectDefinition });
  rowActions.current = { select: selectDefinition };
  const selectRow = useCallback((definition: RegisterDefinition) => { void rowActions.current.select(definition); }, []);
  const favoriteRow = useCallback((definition: RegisterDefinition, monitoring: boolean, favorite: boolean) => {
    const key = definitionKey(definition);
    if (monitoring) { setPinned((current) => current.filter((item) => definitionKey(item) !== key)); setWatching(false); }
    else {
      setFavoriteFeedback(favorite ? undefined : key);
      setFavorites((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    }
  }, []);

  return <ThemeProvider theme={registerTheme}><Stack className="register-workspace" spacing={1.25} sx={{ "& .MuiButton-root": { fontSize: 12 } }}>
    {/* The shared slave header owns the page title; keep the register context here. */}
    <Stack direction="row" alignItems="center" justifyContent="flex-end" sx={{ minHeight: 28 }}>
      <Typography fontSize={12} color="text.secondary">{monitor ? watching ? "监视中" : "监视已暂停" : `ESC ${slave.chip_model} · 参考 ${registerProfile}`}</Typography>
    </Stack>
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 36 }}>
      {monitor ? <>
        <Button size="small" variant="outlined" onClick={() => { setMonitor(false); setWatching(false); }}>返回列表</Button>
        <Button size="small" variant={watching ? "outlined" : "contained"} disabled={controlsBlocked || !pinned.length} onClick={() => setWatching(!watching)}>{watching ? "暂停监视" : "开始监视"}</Button>
        <FormControl size="small" sx={{ width: 102 }}><Select inputProps={{ "aria-label": "刷新周期" }} value={intervalMs} onChange={(event) => setIntervalMs(Number(event.target.value))} sx={{ fontSize: 12 }}>{[500, 1000, 2000, 5000].map((value) => <MenuItem key={value} value={value}>{value / 1000} 秒</MenuItem>)}</Select></FormControl>
        <Box sx={{ flex: 1 }} />
      </> : <>
        {/* Equal segments share one moving thumb; this anchor never follows the function filter. */}
        <Tabs className="register-view-tabs" value={view} onChange={(_, value: CatalogView) => { requestSequence.current += 1; setView(value); setGroup(""); setSelected(undefined); setWriteContext(undefined); }} aria-label="寄存器列表范围">
          <Tab value="common" label="常用" disabled={writing} /><Tab value="all" label="全部" disabled={writing} /><Tab value="favorites" label="收藏" disabled={writing} />
        </Tabs>
        <TextField size="small" placeholder="搜索名称、地址或地址范围" inputProps={{ "aria-label": "搜索寄存器" }} value={query} disabled={writing}
          onChange={(event) => { setQuery(event.target.value); requestSequence.current += 1; setSelected(undefined); setWriteContext(undefined); }}
          InputProps={{ startAdornment: <SearchRounded sx={{ fontSize: 18, color: "text.secondary", mr: 0.75 }} /> }} sx={{ flex: 1, minWidth: 170, "& input": { fontSize: 12, py: 1 } }} />
        {view === "all" && <FormControl size="small" sx={{ width: 108, flexShrink: 0 }}><Select value={group} displayEmpty disabled={writing} inputProps={{ "aria-label": "功能分组" }} onChange={(event) => { requestSequence.current += 1; setGroup(event.target.value); setSelected(undefined); setWriteContext(undefined); }} sx={{ fontSize: 11, height: 34, "& .MuiSelect-select": { pl: 1.25, pr: "28px !important", py: 0.75 }, "& .MuiSelect-icon": { fontSize: 18, right: 7 } }} MenuProps={{ slotProps: { paper: { sx: { "& .MuiMenuItem-root": { fontSize: 12, minHeight: 30, py: 0.5 }, "& .MuiList-root": { py: 0.5 } } } } }}><MenuItem value="">全部功能</MenuItem>{groups.map((item) => <MenuItem key={item} value={item}>{groupLabels[item] ?? item}</MenuItem>)}</Select></FormControl>}
      </>}
      <Button size="small" variant="outlined" sx={{ flexShrink: 0 }} disabled={writing} onClick={() => { setRawOpen(true); setWatching(false); }}>原始地址访问</Button>
      <Tooltip title="刷新整个目录中可自动读取的寄存器"><span><Button size="small" color="inherit" sx={{ flexShrink: 0 }} startIcon={reading ? <CircularProgress size={14} color="inherit" /> : <RefreshRounded sx={{ fontSize: 17 }} />} disabled={controlsBlocked || !catalog.length} onClick={refresh}>刷新全部</Button></span></Tooltip>
      {!monitor && <Button size="small" color="inherit" disabled={writing} onClick={() => { setMonitor(true); setWatching(false); }}>监视{pinned.length ? ` (${pinned.length})` : ""}</Button>}
      <IconButton size="small" aria-label="更多操作" disabled={writing} onClick={(event) => setMoreAnchor(event.currentTarget)}><MoreHorizRounded sx={{ fontSize: 21 }} /></IconButton>
    </Stack>
    {pageError && <Alert severity="error" onClose={() => setPageError("")}>{pageError}</Alert>}
    <Box sx={{ display: "grid", gridTemplateColumns: selected ? "minmax(0, 1fr) 340px" : "minmax(0, 1fr)", gap: 1.5, height: "calc(100vh - 235px)", minHeight: 380 }}>
      <Card variant="outlined" sx={{ minWidth: 0, overflow: "hidden", borderRadius: 1.5, display: "flex", flexDirection: "column", boxShadow: "none" }}>
        <VirtualRegisterTable definitions={displayed} values={values} changes={changes} errors={errors} favorites={favorites}
          selectedKey={selectedKey} favoriteFeedback={favoriteFeedback} format={format} monitor={monitor} writing={writing} reading={reading} detailsVisible={Boolean(selected)}
          scope={`${monitor}:${view}:${group}:${query}:${showReservedAddresses}`} loading={catalogLoading}
          emptyText={monitor ? "从寄存器详情中加入需要监视的项目" : view === "favorites" ? "将鼠标移到寄存器行，点击星标收藏" : "没有匹配的寄存器"}
          onSelect={selectRow} onFavorite={favoriteRow} />
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 1.25, height: 30, flexShrink: 0, borderTop: 1, borderColor: "divider", color: "text.secondary" }}>
          <Typography fontSize={11}>{displayed.length} 项</Typography>
          <Typography fontSize={11} color={pageError ? "error.main" : "text.secondary"}>{reading ? "正在读取…" : snapshotInfo ? `${snapshotInfo.cancelled ? "读取已取消 · " : ""}${new Date(snapshotInfo.timestamp * 1000).toLocaleTimeString("zh-CN", { hour12: false })} · ${snapshotInfo.duration_ms.toFixed(1)} ms` : "尚未读取"}</Typography>
        </Stack>
      </Card>
      {selected && <Card variant="outlined" sx={{ minWidth: 0, overflow: "auto", borderRadius: 1.5, boxShadow: "none" }}><Stack spacing={1.75} sx={{ p: 2 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={0.5}><Box minWidth={0}>
          <Typography fontSize={14} fontWeight={500} sx={{ overflowWrap: "anywhere" }}>{registerDisplayName(selected)}</Typography>
          {registerDisplayName(selected) !== registerLabel(selected.name) && <Typography fontSize={11} color="text.secondary" sx={{ mt: 0.25 }}>{registerLabel(selected.name)}</Typography>}
          <Typography fontSize={12} color="text.secondary" sx={{ mt: 0.5 }}><Box component="span" className="mono" sx={{ fontWeight: 650, color: "text.primary" }}>{selected.address_text ?? hex(selected.address)}</Box> · {registerWidth(selected)} B · <RegisterAccess access={selected.master_access ?? selected.access} /></Typography>
          {(!ecatAccessible(selected) || selected.address_space !== "esc_core") && <Typography fontSize={11} color="text.secondary">{groupLabels[functionGroup(selected)] ?? selected.address_space_label}{!ecatAccessible(selected) ? <Tooltip title={unavailableReason(selected)}><Box component="span"> · ECAT不可访问</Box></Tooltip> : " · 手动读取"}</Typography>}
        </Box><IconButton size="small" aria-label="关闭寄存器详情" disabled={writing} onClick={() => { requestSequence.current += 1; setSelected(undefined); setWriteContext(undefined); }}><CloseRounded sx={{ fontSize: 17 }} /></IconButton></Stack>
        {detailError && <Alert severity="error">{detailError}</Alert>}
        <Box sx={{ bgcolor: "#F6F8FC", borderRadius: 1, p: 1.5 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between"><Typography fontSize={11} color="text.secondary">{errors[selectedKey] ? "上次读取值" : "当前值"}</Typography><Stack direction="row" spacing={0.25}>
            <Tooltip title={readHint(selected) || "刷新此寄存器"}><span><IconButton size="small" aria-label="刷新此寄存器" disabled={controlsBlocked || !canRead(selected) || detailLoading || Boolean(detailError) || selected.is_reserved} onClick={() => { setWatching(false); setWriteError(""); setWriteMessage(""); enqueueReads([selected]); }}><RefreshRounded sx={{ fontSize: 17 }} /></IconButton></span></Tooltip>
            <Tooltip title={copied ? "已复制" : "复制值"}><span><IconButton size="small" aria-label="复制寄存器值" disabled={!selectedValue} onClick={() => void copyValue()}>{copied ? <CheckRounded className="register-copy-confirmed" sx={{ fontSize: 15 }} color="success" /> : <ContentCopyRounded sx={{ fontSize: 15 }} />}</IconButton></span></Tooltip>
            <Tooltip title="加入监视"><span><IconButton size="small" aria-label="加入监视" disabled={!canRead(selected) || detailLoading || Boolean(detailError)} onClick={() => pinned.some((item) => definitionKey(item) === selectedKey) ? setMonitor(true) : addWatch(selected)}><PlaylistAddRounded sx={{ fontSize: 18 }} /></IconButton></span></Tooltip>
          </Stack></Stack>
          <Typography className="mono" fontSize={21} sx={{ overflowWrap: "anywhere", mt: 0.25 }}>{selectedValue ? formatRegisterValue(selectedValue.data, format) : detailLoading || reading ? "…" : "—"}</Typography>
          {registerWidth(selected) <= 8 && <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 0.75 }}>
            <Typography fontSize={11} color="text.secondary" sx={{ lineHeight: 1.7, flexShrink: 0 }}>BIN</Typography>
            <Typography className="mono" fontSize={12} sx={{ lineHeight: 1.6, overflowWrap: "anywhere", minWidth: 0 }}>{selectedValue ? formatRegisterBinary(selectedValue.data, registerWidth(selected)) : "—"}</Typography>
          </Stack>}
          {selectedValue && registerMeaning(selected, selectedValue.data) && <Typography fontSize={12} color="text.secondary" sx={{ mt: 0.5 }}>{registerMeaning(selected, selectedValue.data)}</Typography>}
          {readHint(selected) && <Typography fontSize={11} color="text.secondary" sx={{ mt: 0.5 }}>{readHint(selected)}</Typography>}
        </Box>
        {errors[selectedKey] && <Alert severity="error" sx={{ fontSize: 12 }}>{errors[selectedKey]}</Alert>}
        {writable && !rawOpen && renderEditor()}
        {selected.address_space === "esc_core" && selected.address === 0x0040 && <Button size="small" color="error" variant="outlined" disabled={controlsBlocked} onClick={() => setResetConfirm(true)}>复位 EtherCAT 控制器</Button>}
        <Box>
          <Disclosure key={`${selectedKey}-fields`} title="位字段解析" defaultExpanded={[0x0110, 0x0130, 0x0134, 0x0440].includes(selected.address)}><Stack spacing={1}>
            {Boolean(selected.field_variants?.length) && <TextField select size="small" label="字段适用条件" value={fieldVariant} onChange={(event) => setFieldVariant(event.target.value)}>
              <MenuItem value="">请选择实际 PDI 模式／操作</MenuItem>
              {selected.field_variants?.map((variant) => <MenuItem key={variant.name} value={variant.name}>{variant.name}</MenuItem>)}
            </TextField>}
            {selectedFields.length ? <Table size="small" sx={{ "& td": { px: 0.5, py: 0.75, fontSize: 11, verticalAlign: "top", borderColor: "#EEF1F6" } }}><TableBody>{selectedFields.map((field, index) => <TableRow key={`${field.bits}-${index}`}>
              <TableCell sx={{ width: 34 }} className="mono">{field.bits}</TableCell><TableCell><Typography fontSize={11} fontWeight={600}>{field.name}</Typography><Typography fontSize={11} color="text.secondary">{field.meaning}</Typography></TableCell><TableCell align="right" className="mono">{field.value.toString()}</TableCell>
            </TableRow>)}</TableBody></Table> : <Typography fontSize={11} color="text.secondary">{selected.field_variants?.length && !fieldVariant ? "先选择与设备相符的字段适用条件。" : selectedValue ? "此寄存器没有位字段定义" : "获取当前值后显示字段解析"}</Typography>}
            {writable && writeContext?.definition && definitionKey(writeContext.definition) === selectedKey && writeContext.access === "RW" && writeContext.width <= 8 && writeFields.filter((field) => !field.reserved && field.access === "RW").map((field, index) => <TextField key={index} size="small" label={`${field.bits} · ${field.name}（HEX）`} disabled={controlsBlocked || !writeBytes} value={writeBytes ? ((registerNumber(writeBytes.match(/../g)!.join(" ")) >> BigInt(field.shift)) & ((1n << BigInt(field.width)) - 1n)).toString(16).toUpperCase() : ""} onChange={(event) => editField(field.shift, field.width, event.target.value)} />)}
            {writable && writeContext?.definition && definitionKey(writeContext.definition) === selectedKey && ["W1C", "W1S"].includes(writeContext.access) && writeContext.width <= 8 && writeFields.filter((field) => !field.reserved && field.access === writeContext.access).map((field, index) => {
              const mask = ((1n << BigInt(field.width)) - 1n) << BigInt(field.shift), current = writeBytes ? registerNumber(writeBytes.match(/../g)!.join(" ")) : 0n;
              return <FormControlLabel key={index} label={<Typography fontSize={11}>{writeContext.access === "W1C" ? "清除" : "置位"} {field.name}</Typography>} control={<Checkbox size="small" disabled={controlsBlocked || !writeBytes} checked={(current & mask) === mask} indeterminate={(current & mask) !== 0n && (current & mask) !== mask} onChange={(_, enabled) => { dirtyRef.current = true; setWriteFormat("hex"); setWriteInput(`0x${(enabled ? current | mask : current & ~mask).toString(16).toUpperCase()}`); }} />} />;
            })}
          </Stack></Disclosure>
          <Disclosure title="完整说明">{() => <Stack spacing={1.5} divider={<Divider />} sx={{ "& p": { lineHeight: 1.7 } }}>
            {(documentationText(selected.description) || visibleDocumentationItems.length > 0) && <DocumentationSection title="基本信息">
              {documentationText(selected.description) && <Typography fontSize={12} color="text.secondary" sx={{ whiteSpace: "pre-line" }}>{documentationText(selected.description)}</Typography>}
              <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "4px 12px", fontSize: 11, lineHeight: 1.7 }}>
                {visibleDocumentationItems.map(([label, text]) => <Box key={label} sx={{ display: "contents" }}>
                  <Box component="dt" sx={{ color: "text.secondary" }}>{label}</Box>
                  <Box component="dd" sx={{ m: 0, overflowWrap: "anywhere", whiteSpace: "pre-line" }}>{label === "主站权限" ? <RegisterAccess access={selected.master_access ?? selected.access} /> : label === "PDI 权限" ? <RegisterAccess access={selected.pdi_access} /> : text}</Box>
                </Box>)}
              </Box>
            </DocumentationSection>}
            {visibleOperationNotes.length > 0 && <DocumentationSection title="操作说明">
              {visibleOperationNotes.map(([label, text], index) => <Typography key={index} fontSize={11} sx={{ whiteSpace: "pre-line" }}>{label && <b>{label}：</b>}{text}</Typography>)}
            </DocumentationSection>}
            {Boolean(selected.fields?.length) && <DocumentationSection title="位字段说明"><DocumentationFields fields={selected.fields!} /></DocumentationSection>}
            {selected.field_variants?.map((variant) => <DocumentationSection key={variant.name} title={`位字段说明 · ${variant.name}`}><DocumentationFields fields={variant.fields} /></DocumentationSection>)}
          </Stack>}</Disclosure>
          <Box sx={{ borderTop: 1, borderColor: "divider", py: 1.5 }}>
            {/* Selectable filenames preserve document names when copying the reference text. */}
            <DocumentationSection title={<>参考手册<Typography component="span" fontSize={10} color="text.secondary" sx={{ ml: 0.5, fontWeight: 400 }}>(点击打开文档)</Typography></>}>
              {registerManuals(selected).map((manual) => <Link key={manual.filename} component="button" type="button" title={`${manual.title}${manual.section ? ` · 章节 ${manual.section}` : ""}`}
                  disabled={detailLoading || Boolean(detailError)}
                  sx={{ display: "block", alignSelf: "flex-start", maxWidth: "100%", color: "primary.main", fontSize: 11, lineHeight: 1.7, textAlign: "left", overflowWrap: "anywhere", userSelect: "text", "&:disabled": { color: "text.disabled", cursor: "default" } }}
                  onClick={() => openManual(manual)}>{manual.filename}{manual.pdf_page ? ` · PDF 第 ${manual.pdf_page} 页` : ""}</Link>)}
            </DocumentationSection>
          </Box>
          {/* Acquisition metadata stays visible independently of the description disclosure. */}
          <Box component="footer" sx={{ borderTop: 1, borderColor: "divider", pt: 1.5 }}>
            <Typography fontSize={11} color="text.secondary" sx={{ lineHeight: 1.8 }}>
              {readbackKeys.has(selectedKey) ? "写入回读" : "读取时间"}：{selectedValue ? new Date(selectedValue.timestamp * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}<br />
              耗时：{selectedValue && !readbackKeys.has(selectedKey) ? `${selectedValue.duration_ms.toFixed(2)} ms` : "—"} · WKC {selectedValue?.wkc ?? "—"}
            </Typography>
          </Box>
        </Box>
      </Stack></Card>}
    </Box>
    <Menu anchorEl={moreAnchor} open={Boolean(moreAnchor)} onClose={() => setMoreAnchor(null)} slotProps={{ paper: { sx: { minWidth: 190 } } }}>
      {/* Keep list presentation controls alongside the optional reserved-address view. */}
      <Box sx={{ px: 2, py: 0.75 }}><Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Typography fontSize={12} color="text.secondary">显示格式</Typography>
        <ToggleButtonGroup size="small" exclusive value={format} onChange={(_, next: ValueFormat | null) => { if (next) setFormat(next); }} aria-label="值显示格式" sx={{ "& .MuiToggleButton-root": { px: 1.25, py: 0.25, fontSize: 11 } }}>
          <ToggleButton value="hex">HEX</ToggleButton><ToggleButton value="decimal">DEC</ToggleButton>
        </ToggleButtonGroup>
      </Stack></Box><Divider />
      {monitor && <MenuItem disabled={!pinned.length} onClick={() => { setPinned([]); setWatching(false); setMoreAnchor(null); }}>清空监视列表</MenuItem>}
      {!monitor && <MenuItem onClick={() => { setShowReservedAddresses(!showReservedAddresses); setMoreAnchor(null); }}>{showReservedAddresses ? "隐藏保留地址" : "显示保留地址"}</MenuItem>}
    </Menu>
    <Dialog open={rawOpen} aria-labelledby="raw-register-title" onClose={() => { if (!controlsBlocked) setRawOpen(false); }} fullWidth maxWidth="sm" slotProps={{ paper: { sx: { maxWidth: 540, borderRadius: 2 } } }}>
      <DialogTitle id="raw-register-header" sx={{ px: 2.5, pt: 2, pb: 1.5 }}><Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Typography id="raw-register-title" component="span" fontSize={17} fontWeight={700}>原始地址访问</Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          <ToggleButtonGroup size="small" exclusive value={rawFormat} disabled={controlsBlocked} onChange={(_, next: RawFormat | null) => changeRawFormat(next)} aria-label="原始读写数值格式" sx={{ "& .MuiToggleButton-root": { px: 1.5, py: 0.4, fontSize: 11, lineHeight: 1.8 } }}>
            <ToggleButton value="hex">HEX</ToggleButton><ToggleButton value="decimal">DEC</ToggleButton>
          </ToggleButtonGroup>
          <IconButton size="small" aria-label="关闭原始地址访问" disabled={controlsBlocked} onClick={() => setRawOpen(false)}><CloseRounded sx={{ fontSize: 19 }} /></IconButton>
        </Stack>
      </Stack></DialogTitle>
      <DialogContent sx={{ px: 2.5, pb: 2.5 }}><Stack spacing={1.75} sx={{ pt: 0.5 }}>
        <Stack direction="row" spacing={1.25} alignItems="flex-start">
          <TextField label="地址（HEX）" size="small" value={rawAddress} disabled={controlsBlocked} error={rawNumericAddress === undefined}
            helperText={rawNumericAddress === undefined ? "请输入 0000–FFFF" : undefined}
            onChange={(event) => { setRawAddress(event.target.value); setRawResult(undefined); setRawError(""); setRawWriteWkc(undefined); setRawReadWkc(undefined); }}
            onKeyDown={(event) => { if (event.key === "Enter") void readRaw(); }} inputProps={{ className: "mono" }} sx={{ flex: 1 }} />
          <TextField label="长度（B）" size="small" type="number" value={rawSize || ""} disabled={controlsBlocked} error={!rawValid && rawNumericAddress !== undefined}
            helperText={!rawValid && rawNumericAddress !== undefined ? "须为 1–256B，地址不能越界" : undefined}
            onChange={(event) => { setRawSize(Number(event.target.value)); setRawResult(undefined); setRawError(""); setRawWriteWkc(undefined); setRawReadWkc(undefined); }} inputProps={{ min: 1, max: 256, step: 1 }} sx={{ width: 112 }} />
        </Stack>
        <Typography fontSize={11} color="text.secondary">{rawDefinition ? registerDisplayName(rawDefinition) : "ESC 直接读写"}</Typography>
        <Stack direction="row" spacing={1.25} alignItems="flex-start">
          <TextField label="读取值" size="small" multiline maxRows={4} value={rawResult ? formatRawValue(rawResult.data, rawFormat) : ""} placeholder="—" InputLabelProps={{ shrink: true }}
            InputProps={{ readOnly: true }} inputProps={{ className: "mono", style: { fontSize: 13 } }} sx={{ flex: 1, "& .MuiInputBase-root": { bgcolor: "#F6F8FC" } }} />
          <Button variant="outlined" sx={{ minWidth: 76, height: 40, flexShrink: 0 }} disabled={controlsBlocked || !rawValid} onClick={() => void readRaw()}>{reading ? "读取中…" : "读取"}</Button>
        </Stack>
        <Stack direction="row" spacing={1.25} alignItems="flex-start">
          <TextField label="写入值" size="small" multiline maxRows={4} value={rawWriteInput} disabled={controlsBlocked} placeholder={rawFormat === "hex" ? "例如：0x12" : "例如：18"}
            error={Boolean(rawWriteInput && !rawWriteBytes)} helperText={rawWriteInput && !rawWriteBytes ? `请输入 ${rawSize || "指定长度的"}B 范围内的${rawFormat === "hex" ? "十六" : "十"}进制无符号整数` : undefined}
            onChange={(event) => { setRawWriteInput(event.target.value); setRawError(""); setRawWriteWkc(undefined); }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void writeRaw(); } }}
            inputProps={{ className: "mono", style: { fontSize: 13 } }} sx={{ flex: 1 }} />
          <Button variant="contained" sx={{ minWidth: 76, height: 40, flexShrink: 0 }} disabled={controlsBlocked || !rawValid || !rawWriteBytes} onClick={() => void writeRaw()}>{writing ? "处理中…" : "写入"}</Button>
        </Stack>
        {rawWriteBytes && <Typography fontSize={11} color="text.secondary" className="mono" sx={{ overflowWrap: "anywhere", maxHeight: 64, overflowY: "auto" }}>发送字节：{rawWriteBytes.match(/../g)!.join(" ")}</Typography>}
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ pt: 1.25, borderTop: 1, borderColor: "divider" }}>
          <Typography fontSize={11} color="text.secondary">Enter 写入 · 写入后自动读取一次</Typography>
          {(rawWriteWkc !== undefined || rawReadWkc !== undefined) && <Typography fontSize={11} color="text.secondary" className="mono">{rawWriteWkc !== undefined ? `写入 WKC：${rawWriteWkc ?? "—"} · ` : ""}读取 WKC：{rawReadWkc ?? "—"}</Typography>}
        </Stack>
        {rawError && <Alert severity="error" sx={{ fontSize: 12 }}>{rawError}</Alert>}
      </Stack></DialogContent>
    </Dialog>
    <Dialog open={Boolean(watchConfirm)} onClose={() => setWatchConfirm(undefined)} fullWidth maxWidth="xs"><DialogTitle>加入持续监视</DialogTitle><DialogContent><Typography fontSize={13}>{watchConfirm && `${registerDisplayName(watchConfirm)}：${readDescription(watchConfirm)}`} 开始监视后会按所选周期重复读取。</Typography></DialogContent><DialogActions><Button onClick={() => setWatchConfirm(undefined)}>取消</Button><Button variant="contained" onClick={() => { if (watchConfirm && canRead(watchConfirm)) setPinned((current) => current.some((item) => definitionKey(item) === definitionKey(watchConfirm)) ? current : [...current, watchConfirm]); setWatchConfirm(undefined); }}>加入监视</Button></DialogActions></Dialog>
    <Dialog open={resetConfirm} onClose={() => { if (!writing) setResetConfirm(false); }}><DialogTitle>复位 EtherCAT 控制器</DialogTitle><DialogContent><Alert severity="error">复位会中断从站通信。</Alert></DialogContent><DialogActions><Button disabled={writing} onClick={() => setResetConfirm(false)}>取消</Button><Button color="error" variant="contained" disabled={controlsBlocked} onClick={async () => {
      const requestedContext = context; setWriting(true); setWatching(false);
      try { const value = await run(() => bridgeRequest("register_reset", { position: slave.position, profile: registerProfile }), "复位命令已发送"); if (value && contextRef.current === requestedContext) setResetConfirm(false); }
      finally { if (mounted.current && contextRef.current === requestedContext) setWriting(false); }
    }}>复位</Button></DialogActions></Dialog>
    {manualTarget && <Suspense fallback={<Dialog open={manualOpen} onClose={() => setManualOpen(false)}><DialogContent><CircularProgress size={24} /> 正在加载查看器…</DialogContent></Dialog>}>
      <PdfManualViewer target={manualTarget} open={manualOpen} onClose={closeManual} />
    </Suspense>}
  </Stack></ThemeProvider>;
}, (previous, next) => {
  // Ignore unrelated bus-state changes while preserving identity, session, and control changes.
  const left = previous.slave, right = next.slave;
  return previous.run === next.run && previous.registerProfile === next.registerProfile
    && previous.deviceOperationsBlocked === next.deviceOperationsBlocked && previous.sessionContext === next.sessionContext
    && left?.position === right?.position && left?.configured_address === right?.configured_address && left?.chip_model === right?.chip_model
    && left?.identity.vendor_id === right?.identity.vendor_id && left?.identity.product_code === right?.identity.product_code
    && left?.identity.revision === right?.identity.revision && left?.identity.serial_number === right?.identity.serial_number;
});
