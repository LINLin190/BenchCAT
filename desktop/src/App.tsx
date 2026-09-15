import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AppBar,
  Box,
  Button,
  ButtonGroup,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  InputLabel,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  BugReportRounded,
  MenuRounded,
  ChevronLeftRounded,
  CableRounded,
  DashboardRounded,
  DeveloperBoardRounded,
  FolderOpenRounded,
  GitHub as GitHubIcon,
  InfoOutlineRounded,
  MemoryRounded,
  OpenInNewRounded,
  PlayArrowRounded,
  RefreshRounded,
  SaveAltRounded,
  SettingsRounded,
  StopRounded,
  TuneRounded,
  UsbRounded,
  WarningAmberRounded,
  ExpandMoreRounded,
} from "@mui/icons-material";
import packageInfo from "../package.json";
import { OverviewEeprom } from "./OverviewEeprom";
import { EscHardwareCard } from "./EscHardwareCard";
import { alStatusInfo, type AlStatusLanguage } from "./alStatus";
import { BridgeRequestError, bridgeRequest, onBridgeEvent, onBridgeExited, onFileDrop, openExternal, pickDirectory, pickFile, previewMode, revealPath, subscribeBusSnapshot, type AdapterInfo } from "./api";
import { minimumBusState } from "./busState";
import { operationStore } from "./operationStore";
import { decodeConfigData, loadEepromAutoReset, normalizeConfigData, pdiMeaning, saveEepromAutoReset } from "./eepromConfig";
import { QuickEepromFlashDialog, type EepromDetailSelection, type EepromProgressState } from "./QuickEepromFlashDialog";
import type {
  BridgeEvent,
  BridgeExitInfo,
  EsiDevice,
  OperationProgress,
  PdoEntry,
  RegisterDefinition,
  SlaveInfo,
  AutoScanResult,
  WorkbenchStatus,
} from "./types";
import { hex, stateLabel } from "./types";

type PageKey = "overview" | "registers" | "eeprom";
type Run = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;
const PREFERRED_ADAPTER_KEY = "ethercat-workbench.preferred-adapter";
const RECENT_ESI_KEY = "ethercat-workbench.recent-esi";
const AL_LANGUAGE_KEY = "ethercat-workbench.al-language";
const PROJECT_URL = "https://github.com/LINLin190/EtherCAT-Workbench";
const ISSUES_URL = `${PROJECT_URL}/issues`;

function orderAdapters(items: AdapterInfo[]): AdapterInfo[] {
  const virtual = /\b(wan miniport|wi-?fi|wireless|loopback|vmware|virtual|wintun|tunnel)\b/i;
  const ethernet = /\b(ethernet|gbe|gigabit|i21\d|realtek|ethercat)\b/i;
  return [...items].sort((left, right) => {
    const score = (item: AdapterInfo) => virtual.test(item.description) ? 2 : ethernet.test(item.description) ? 0 : 1;
    return score(left) - score(right) || left.description.localeCompare(right.description);
  });
}

interface SlaveContextMenu {
  mouseX: number;
  mouseY: number;
  position: number;
}

const pages: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: "overview", label: "概览", icon: <DashboardRounded /> },
  { key: "registers", label: "寄存器", icon: <TuneRounded /> },
  { key: "eeprom", label: "EEPROM", icon: <MemoryRounded /> },
];

const cardSx = { borderRadius: 1.25, minWidth: 0 };
const registerProfiles = ["ET1100", "LAN9252", "LAN9253"];
const controllableStates = [1, 2, 4, 8];

function slaveIdentityKey(slave?: SlaveInfo): string {
  if (!slave) return "none";
  const identity = slave.identity;
  return [slave.position, identity.vendor_id, identity.product_code, identity.revision, identity.serial_number, slave.configured_address ?? ""].join(":");
}

function isEepromOperation(operation?: string): boolean {
  return Boolean(operation?.startsWith("eeprom"));
}

function cycleFaultMessage(data: unknown): string {
  if (typeof data === "string") return `周期通信故障：${data}`;
  if (data && typeof data === "object") {
    const value = data as Partial<Snapshot> & { message?: unknown };
    if (typeof value.message === "string") return `周期通信故障：${value.message}`;
    if (typeof value.actual_wkc === "number" || typeof value.expected_wkc === "number") {
      return `周期通信故障：WKC ${value.actual_wkc ?? "—"}/${value.expected_wkc ?? "—"}，连续错误 ${value.consecutive_errors ?? "—"}，超时 ${value.timeout_count ?? "—"}`;
    }
  }
  return "周期通信发生未知故障，请停止通信并刷新从站状态。";
}

function defaultRegisterProfile(chipModel: string | undefined): string {
  if (chipModel === "LAN9252" || chipModel === "E252") return "LAN9252";
  if (chipModel === "LAN9253" || chipModel === "E253") return "LAN9253";
  return "ET1100";
}

function PageTitle({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2} sx={{ mb: 1.25 }}>
      <Box>
        <Typography variant="h5" fontWeight={750}>{title}</Typography>
        {subtitle && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.2 }}>{subtitle}</Typography>}
      </Box>
      {actions && <Stack direction="row" gap={1}>{actions}</Stack>}
    </Stack>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card sx={cardSx}>
      <CardContent sx={{ minHeight: 156, display: "grid", placeItems: "center", textAlign: "center" }}>
        <Stack alignItems="center" spacing={0.8} color="text.secondary">
          <DeveloperBoardRounded sx={{ fontSize: 36, opacity: 0.45 }} />
          <Typography>{text}</Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

function StateChip({ state, error = false }: { state: number; error?: boolean }) {
  const color = error ? "error" : state === 8 ? "success" : state === 0 ? "default" : state === 1 ? "warning" : "primary";
  return <Chip size="small" color={color} variant={state === 8 ? "filled" : "outlined"} label={`${stateLabel(state)}${error ? " + ERROR" : ""}`} />;
}

function OverviewPage({ slave, slaves, status, busy, run, refresh, registerProfile, onRegisterProfileChange, alLanguage }: { slave?: SlaveInfo; slaves: SlaveInfo[]; status: WorkbenchStatus; busy: boolean; run: Run; refresh: () => Promise<void>; registerProfile: string; onRegisterProfileChange: (profile: string) => void; alLanguage: AlStatusLanguage }) {
  const [switchingProfile, setSwitchingProfile] = useState<string>();
  const requestState = (state: number) => run(
    () => bridgeRequest<SlaveInfo[]>("request_state", { position: slave?.position ?? 0, state }),
    `已请求 ${stateLabel(state)}`,
  );
  const repair = (method: "reconfig" | "recover", success: string) => slave && run(
    () => bridgeRequest<{ slaves: SlaveInfo[] }>(method, { position: slave.position }),
    success,
  );
  const changeEscModel = async (profile: string) => {
    if (!slave || profile === registerProfile || switchingProfile) return;
    setSwitchingProfile(profile);
    try {
      const result = await run(
        () => bridgeRequest<{ succeeded: boolean; slaves: SlaveInfo[] }>("reconfig", { position: slave.position }),
        `从站 ${slave.position} 已完成重配置，ESC 型号切换为 ${profile}`,
      );
      if (result) onRegisterProfileChange(profile);
    } finally {
      setSwitchingProfile(undefined);
    }
  };
  const allOp = slaves.length > 0 && slaves.every((item) => item.state === 8 && !((item.raw_state ?? item.state) & 0x10) && !item.al_status);
  const alInfo = alStatusInfo(slave?.al_status ?? 0, alLanguage);
  return (
    <>
      {!slave && <PageTitle title="设备概览" subtitle="总线状态与设备信息" actions={<Button disabled={busy} startIcon={<RefreshRounded />} onClick={() => run(refresh)}>刷新状态</Button>} />}
      {status.last_error && <Alert severity={status.phase === "faulted" ? "error" : "warning"} sx={{ mb: 1.25 }}>
        <Typography fontWeight={700}>最近通信问题</Typography>
        <Typography variant="body2">{status.last_error}</Typography>
        <Typography variant="caption" display="block" sx={{ mt: 0.35 }}>先刷新状态；若问题持续，请检查链路、从站供电与 AL 状态码，再进行重配置或故障恢复。</Typography>
      </Alert>}
      {!slave ? <EmptyState text="连接并扫描后，在左侧选择一个从站" /> : (
        <Stack spacing={1.25} className="overview-cards">
          <Card sx={cardSx} className="overview-top-row">
              <CardContent>
                <Typography variant="h6">运行摘要</Typography>
                <Box className="overview-summary-grid">
                  <Box className="overview-metric">
                    <Typography className="section-label">当前状态</Typography>
                    <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 0.45 }}>
                      <StateChip state={slave.state} error={Boolean((slave.raw_state ?? slave.state) & 0x10)} />
                    </Stack>
                  </Box>
                  <Box className="overview-metric">
                    <Typography className="section-label">过程数据{slave.pdo_size_source === "unknown" ? "" : ` · ${slave.pdo_size_source === "sii" ? "SII 声明" : slave.pdo_size_source === "cache" ? "已缓存" : "已映射"}`}</Typography>
                    <Stack direction="row" divider={<Divider orientation="vertical" flexItem />} spacing={2} sx={{ mt: 0.4 }}>
                      <Box><Typography variant="caption" color="text.secondary">输入</Typography><Typography className="mono" fontWeight={750}>{slave.input_size == null ? "—" : `${slave.input_size} B`}</Typography></Box>
                      <Box><Typography variant="caption" color="text.secondary">输出</Typography><Typography className="mono" fontWeight={750}>{slave.output_size == null ? "—" : `${slave.output_size} B`}</Typography></Box>
                    </Stack>
                  </Box>
                  <Box className="overview-metric overview-esc-selector">
                    <FormControl size="small" fullWidth disabled={busy || status.cycle_running || Boolean(switchingProfile)}>
                      <InputLabel>ESC 型号</InputLabel>
                      <Select label="ESC 型号" value={registerProfile} onChange={(event) => void changeEscModel(String(event.target.value))}>
                        {registerProfiles.map((profile) => <MenuItem key={profile} value={profile}>{profile}</MenuItem>)}
                      </Select>
                    </FormControl>
                    {(status.cycle_running || switchingProfile) && <Typography variant="caption" color={status.cycle_running ? "warning.main" : "text.secondary"}>
                      {status.cycle_running ? "停止周期通信后可切换" : `正在应用 ${switchingProfile} 并重配置从站…`}
                    </Typography>}
                  </Box>
                  <Box className="overview-metric"><Typography className="section-label">AL 状态码</Typography><Typography className="kv-value mono" fontWeight={750}>{hex(slave.al_status)}</Typography><Typography variant="caption" color={slave.al_status ? "warning.main" : "text.secondary"}>{alInfo.name}</Typography></Box>
                </Box>
                {slave.al_status !== 0 && <Alert severity={alInfo.known ? "warning" : "error"} sx={{ mt: 1.5 }}><Typography fontWeight={700}>{hex(slave.al_status)} · {alInfo.name}</Typography><Typography variant="body2">说明：{alInfo.detail}</Typography><Typography variant="body2">排查：{alInfo.action}</Typography></Alert>}
              </CardContent>
              <CardContent>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                  <Typography variant="h6">状态控制</Typography>
                </Stack>
                <Box className="overview-control-row">
                  <Box className="overview-state-buttons">
                    {[1, 2, 4, 8].map((state) => <Button key={state} disabled={busy} variant={slave.state === state ? "contained" : "outlined"} onClick={() => requestState(state)}>{stateLabel(state)}</Button>)}
                  </Box>
                  <Stack direction="row" gap={0.5} flexWrap="wrap" className="overview-repair-actions">
                    {status.cycle_running && <Button disabled={busy} size="small" color="error" variant="outlined" startIcon={<StopRounded />} onClick={() => run(() => bridgeRequest("stop_cycle"), "周期通信已停止，全部从站回到 SAFEOP")}>停止周期</Button>}
                    <Button disabled={busy || status.cycle_running} size="small" color="warning" variant="outlined" onClick={() => repair("reconfig", "重配置完成")}>重配置</Button>
                    <Button disabled={busy || status.cycle_running} size="small" color="warning" variant="outlined" onClick={() => repair("recover", "恢复并通过状态复核")}>故障恢复</Button>
                  </Stack>
                </Box>
              </CardContent>
          </Card>
          <Card sx={cardSx} className="overview-details-row">
              <CardContent>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.25 }}>
                  <Typography variant="h6">设备身份</Typography>
                </Stack>
                <Box className="kv-grid overview-identity-grid">
                  <Box className="kv-item overview-identity-item"><Typography className="section-label">配置地址</Typography><Typography className="kv-value mono" fontWeight={700}>{slave.configured_address === undefined ? "—" : hex(slave.configured_address)}</Typography></Box>
                  <Box className="kv-item overview-identity-item"><Typography className="section-label">厂商 ID</Typography><Typography className="kv-value mono" fontWeight={700}>{hex(slave.identity.vendor_id, 8)}</Typography></Box>
                  <Box className="kv-item overview-identity-item"><Typography className="section-label">产品代码</Typography><Typography className="kv-value mono" fontWeight={700}>{hex(slave.identity.product_code, 8)}</Typography></Box>
                  <Box className="kv-item overview-identity-item"><Typography className="section-label">修订版本</Typography><Typography className="kv-value mono" fontWeight={700}>{hex(slave.identity.revision, 8)}</Typography></Box>
                  <Box className="kv-item overview-identity-item"><Typography className="section-label">序列号</Typography><Typography className="kv-value mono" fontWeight={700}>{hex(slave.identity.serial_number, 8)}</Typography></Box>
                </Box>
              </CardContent>
            <EscHardwareCard key={`${slave.position}-${registerProfile}`} slave={slave} profile={registerProfile} />
          </Card>
          <OverviewEeprom key={slave.position} slave={slave} />
          {(allOp || Boolean(slave.al_status)) && <Alert severity={allOp ? "success" : "warning"}>{allOp ? "全部从站处于 OP，总线已就绪。" : `当前从站报告 AL 状态码 ${hex(slave.al_status)}：${alInfo.name}。`}</Alert>}
        </Stack>
      )}
    </>
  );
}

function CoePage({ slave, run }: { slave?: SlaveInfo; run: Run }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [index, setIndex] = useState("0x1000");
  const [subindex, setSubindex] = useState("0");
  const [data, setData] = useState("");
  const load = () => slave && run(() => bridgeRequest<Record<string, unknown>[]>("object_dictionary", { position: slave.position }).then((value) => { setRows(value); return value; }));
  useEffect(() => { setRows([]); }, [slave?.position]);
  if (!slave) return <><PageTitle title="CoE 对象" subtitle="在线对象字典与 SDO 访问" /><EmptyState text="请先选择从站" /></>;
  return (
    <>
      <PageTitle title="CoE 对象" subtitle={`从站 ${slave.position} · 在线对象字典与 SDO`} actions={<Button variant="contained" onClick={load}>读取对象字典</Button>} />
      <Stack spacing={2}>
        <Card sx={cardSx}><CardContent>
          <Typography variant="h6">快速 SDO 访问</Typography>
          <Stack direction="row" gap={1.2} sx={{ mt: 2 }} alignItems="center">
            <TextField label="Index" value={index} onChange={(e) => setIndex(e.target.value)} size="small" sx={{ width: 150 }} inputProps={{ className: "mono" }} />
            <TextField label="SubIndex" value={subindex} onChange={(e) => setSubindex(e.target.value)} size="small" sx={{ width: 130 }} inputProps={{ className: "mono" }} />
            <TextField label="HEX 数据（写入）" value={data} onChange={(e) => setData(e.target.value)} size="small" fullWidth inputProps={{ className: "mono" }} />
            <Button variant="outlined" onClick={() => run(() => bridgeRequest<{ data: string }>("sdo_read", { position: slave.position, index: Number(index), subindex: Number(subindex) }).then((value) => { setData(value.data); return value; }), "读取完成")}>读取</Button>
            <Button variant="contained" disabled={!data.trim()} onClick={() => run(() => bridgeRequest("sdo_write", { position: slave.position, index: Number(index), subindex: Number(subindex), data }), "写入并回读验证完成")}>写入并验证</Button>
          </Stack>
        </CardContent></Card>
        <Card sx={cardSx}><TableContainer sx={{ maxHeight: "calc(100vh - 390px)" }}><Table stickyHeader size="small"><TableHead><TableRow>{["Index", "Sub", "名称", "类型", "位宽", "访问", "来源"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead><TableBody>
          {rows.map((row, i) => <TableRow hover key={i}><TableCell className="mono">{hex(Number(row.index))}</TableCell><TableCell>{String(row.subindex)}</TableCell><TableCell>{String(row.name)}</TableCell><TableCell>{String(row.data_type)}</TableCell><TableCell>{String(row.bit_length)}</TableCell><TableCell>{String(row.access)}</TableCell><TableCell>{String(row.source)}</TableCell></TableRow>)}
          {!rows.length && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 8, color: "text.secondary" }}>点击“读取对象字典”开始</TableCell></TableRow>}
        </TableBody></Table></TableContainer></Card>
      </Stack>
    </>
  );
}

function PdoPage({ slave, run }: { slave?: SlaveInfo; run: Run }) {
  const [mapping, setMapping] = useState<{ rx: PdoEntry[]; tx: PdoEntry[] }>({ rx: [], tx: [] });
  const [tab, setTab] = useState(0);
  useEffect(() => { setMapping({ rx: [], tx: [] }); }, [slave?.position]);
  const load = () => slave && run(() => bridgeRequest<{ rx: PdoEntry[]; tx: PdoEntry[] }>("pdo_mapping", { position: slave.position }).then((value) => { setMapping(value); return value; }));
  const rows = tab === 0 ? mapping.tx : mapping.rx;
  if (!slave) return <><PageTitle title="PDO 映射" subtitle="过程数据布局" /><EmptyState text="请先选择从站" /></>;
  return <><PageTitle title="PDO 映射" subtitle={`从站 ${slave.position} · 位偏移和数据类型`} actions={<Button variant="contained" onClick={load}>读取映射</Button>} />
    <Card sx={cardSx}><Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ px: 2 }}><Tab label={`输入 TxPDO (${mapping.tx.length})`} /><Tab label={`输出 RxPDO (${mapping.rx.length})`} /></Tabs><Divider />
      <TableContainer sx={{ maxHeight: "calc(100vh - 290px)" }}><Table stickyHeader size="small"><TableHead><TableRow>{["PDO", "对象", "Sub", "名称", "类型", "位长度", "位偏移"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead><TableBody>{rows.map((row, i) => <TableRow hover key={i}><TableCell className="mono">{hex(row.pdo_index)}</TableCell><TableCell className="mono">{hex(row.index)}</TableCell><TableCell>{row.subindex}</TableCell><TableCell>{row.name || "—"}</TableCell><TableCell>{row.data_type || "—"}</TableCell><TableCell>{row.bit_length}</TableCell><TableCell>{row.bit_offset}</TableCell></TableRow>)}{!rows.length && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 10, color: "text.secondary" }}>尚未读取映射</TableCell></TableRow>}</TableBody></Table></TableContainer>
    </Card></>;
}

interface Snapshot { inputs: string[]; outputs: string[]; actual_wkc: number; expected_wkc: number; cycle_count: number; timeout_count: number; wkc_error_count: number; consecutive_errors: number }
function IoPage({ slave, status, snapshot, run, refresh }: { slave?: SlaveInfo; status: WorkbenchStatus; snapshot?: Snapshot; run: Run; refresh: () => void }) {
  const [period, setPeriod] = useState("1");
  const [output, setOutput] = useState("");
  const toggle = () => run(() => bridgeRequest(status.cycle_running ? "stop_cycle" : "start_cycle", status.cycle_running ? {} : { period_ms: Number(period) }).then((result) => { refresh(); return result; }), status.cycle_running ? "周期通信已安全停止" : "周期通信已启动");
  return <><PageTitle title="在线 I/O" subtitle="周期通信、WKC 健康度与过程数据" actions={<><FormControl size="small" sx={{ width: 126 }}><InputLabel>周期</InputLabel><Select label="周期" value={period} disabled={status.cycle_running} onChange={(e) => setPeriod(e.target.value)}>{["0.5", "1", "2", "5", "10", "20"].map((p) => <MenuItem value={p} key={p}>{p} ms</MenuItem>)}</Select></FormControl><Button color={status.cycle_running ? "error" : "primary"} variant="contained" disabled={!status.connected || !status.slaves.length} startIcon={status.cycle_running ? <StopRounded /> : <PlayArrowRounded />} onClick={toggle}>{status.cycle_running ? "安全停止" : "启动周期"}</Button></>} />
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 2, mb: 2 }}>{[["WKC", snapshot ? `${snapshot.actual_wkc} / ${snapshot.expected_wkc}` : "—"], ["周期计数", snapshot?.cycle_count ?? "—"], ["WKC 错误", snapshot?.wkc_error_count ?? "—"], ["超时", snapshot?.timeout_count ?? "—"]].map(([label, value]) => <Card sx={cardSx} key={String(label)}><CardContent><Typography color="text.secondary" variant="caption">{label}</Typography><Typography variant="h6" className="mono" sx={{ mt: 0.8 }}>{value}</Typography></CardContent></Card>)}</Box>
    {!slave ? <EmptyState text="选择从站后查看其过程数据" /> : <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
      <Card sx={cardSx}><CardContent><Typography variant="h6">输入数据</Typography><Typography className="mono" sx={{ mt: 2, p: 2, bgcolor: "#F7F8FB", borderRadius: 2, minHeight: 82 }}>{snapshot?.inputs?.[slave.position - 1] || "尚无周期数据"}</Typography></CardContent></Card>
      <Card sx={cardSx}><CardContent><Typography variant="h6">输出数据</Typography><Stack direction="row" gap={1} sx={{ mt: 2 }}><TextField fullWidth size="small" label={`HEX · ${slave.output_size} B`} value={output} onChange={(e) => setOutput(e.target.value)} inputProps={{ className: "mono" }} /><Button variant="contained" disabled={!status.cycle_running || !slave.output_size || !output.trim()} onClick={() => run(() => bridgeRequest("set_output", { position: slave.position, data: output }), "输出已应用")}>应用</Button></Stack><Typography variant="caption" color="text.secondary">仅在周期运行时可写；后台确认成功后才更新状态。</Typography></CardContent></Card>
    </Box>}</>;
}

interface RegisterValue { position: number; address: number; data: string; wkc: number; duration_ms: number; timestamp: number }
interface RegisterWriteContext { address: number; width: number; name: string; access: string; known: boolean }

const registerKey = (address: number, width: number) => `${address}:${width}`;

/** Accepts "0x0130" and "0130"; plain digits are hexadecimal, not decimal. */
function parseHexInput(text: string): number | undefined {
  const cleaned = text.trim().replace(/^0x/i, "");
  if (!/^[0-9A-Fa-f]+$/.test(cleaned)) return undefined;
  const value = parseInt(cleaned, 16);
  return Number.isNaN(value) ? undefined : value;
}

function littleEndianValue(data: string): bigint {
  return data.trim().split(/\s+/).filter(Boolean).reduceRight((value, byte) => (value << 8n) | BigInt(`0x${byte}`), 0n);
}

function RegistersPage({ slave, run, registerProfile }: { slave?: SlaveInfo; run: Run; registerProfile: string }) {
  const [catalog, setCatalog] = useState<RegisterDefinition[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [selected, setSelected] = useState<RegisterDefinition>();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("全部类别");
  const [result, setResult] = useState<RegisterValue>();
  const [readingDefinitionId, setReadingDefinitionId] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState<RegisterDefinition[]>([]);
  const [watchValues, setWatchValues] = useState<Record<string, RegisterValue>>({});
  const [changedWatchKeys, setChangedWatchKeys] = useState<Set<string>>(new Set());
  const watchValuesRef = useRef<Record<string, RegisterValue>>({});
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const [watching, setWatching] = useState(false);
  const [watchError, setWatchError] = useState("");
  const [intervalMs, setIntervalMs] = useState(1000);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeContext, setWriteContext] = useState<RegisterWriteContext>();
  const [writeData, setWriteData] = useState("");
  const [plan, setPlan] = useState<{ plan_id: string; plan: Record<string, unknown>; expiresAt: number }>();
  const [planNow, setPlanNow] = useState(Date.now());
  const [resetConfirm, setResetConfirm] = useState(false);
  const [rawAddress, setRawAddress] = useState("0x0000");
  const [rawSize, setRawSize] = useState(1);
  const [rawResult, setRawResult] = useState<RegisterValue>();
  const [rawAccess, setRawAccess] = useState("RW");
  const identityKey = slaveIdentityKey(slave);
  const registerContext = `${identityKey}:${registerProfile}`;
  const registerContextRef = useRef(registerContext);
  registerContextRef.current = registerContext;

  useEffect(() => {
    if (!slave) { setCatalog([]); setCatalogError(""); return; }
    let active = true;
    setCatalog([]); setCatalogError("");
    bridgeRequest<RegisterDefinition[]>("register_catalog", { position: slave.position, profile: registerProfile })
      .then((value) => { if (active) setCatalog(value); })
      .catch((error) => { if (active) setCatalogError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [identityKey, registerProfile]);
  useEffect(() => {
    if (!plan) return;
    setPlanNow(Date.now());
    const timer = window.setInterval(() => setPlanNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [plan?.plan_id]);
  useEffect(() => {
    setSelected(undefined); setResult(undefined); setPinned([]); setWatchValues({}); setWatching(false);
    setWatchError(""); setPlan(undefined); setWriteOpen(false); setResetConfirm(false); setRawResult(undefined); setGroup("全部类别");
  }, [identityKey, registerProfile]);

  const groups = useMemo(() => ["全部类别", ...Array.from(new Set(catalog.map((definition) => definition.group))).sort()], [catalog]);
  const filtered = catalog.filter((definition) => group === "全部类别" || definition.group === group).filter((definition) =>
    `${definition.name} ${definition.group} ${definition.description} ${definition.address_text ?? hex(definition.address)} ${definition.address_space_label ?? ""}`
      .toLowerCase().includes(query.toLowerCase()),
  );
  const read = async (definition: RegisterDefinition) => {
    if (operationStore.active("register_read")) return;
    const requestedContext = registerContextRef.current;
    setSelected(definition);
    if (!slave) return;
    setReadingDefinitionId(definition.definition_id);
    try {
      const detail = await run(() => bridgeRequest<RegisterDefinition>("register_definition", {
        position: slave.position, definition_id: definition.definition_id, profile: registerProfile,
      }));
      if (!detail || registerContextRef.current !== requestedContext) return;
      setSelected(detail);
      if (detail.direct_read_allowed === false) { setResult(undefined); return; }
      const value = await run(() => bridgeRequest<RegisterValue>("register_read", {
        position: slave.position, address: detail.address, size: detail.width ?? detail.size, definition_id: detail.definition_id, profile: registerProfile,
      }));
      if (value && registerContextRef.current === requestedContext) setResult(value);
    } finally {
      if (registerContextRef.current === requestedContext) setReadingDefinitionId(undefined);
    }
  };
  const copyReadValue = async () => {
    if (!result?.data) return;
    await navigator.clipboard.writeText(result.data);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const readRaw = async () => {
    if (!slave) return;
    const address = parseHexInput(rawAddress);
    if (address === undefined) return;
    await run(() => bridgeRequest<RegisterValue>("register_read", {
      position: slave.position, address, size: rawSize,
    }).then((value) => { setRawResult(value); return value; }), "原始寄存器读取完成");
  };

  useEffect(() => {
    if (!watching || !pinned.length || !slave) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const values = await bridgeRequest<RegisterValue[]>("register_watch", {
          position: slave.position,
          requests: pinned.map((definition) => ({ address: definition.address, size: definition.width ?? definition.size, definition_id: definition.definition_id, profile: registerProfile })),
        });
        if (active) {
          const nextValues = Object.fromEntries(values.map((value) => [registerKey(value.address, value.data.split(/\s+/).length), value]));
          const changed = new Set(Object.entries(nextValues).filter(([key, value]) => watchValuesRef.current[key] && watchValuesRef.current[key].data !== value.data).map(([key]) => key));
          watchValuesRef.current = nextValues;
          setWatchValues(nextValues);
          setChangedWatchKeys(changed);
          if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = window.setTimeout(() => setChangedWatchKeys(new Set()), 850);
          setWatchError("");
        }
      } catch (error) {
        if (active) { setWatching(false); setWatchError(error instanceof Error ? error.message : String(error)); }
      } finally { if (active) timer = window.setTimeout(poll, intervalMs); }
    };
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [watching, pinned, slave, intervalMs, registerProfile]);

  const togglePinned = (definition: RegisterDefinition) => {
    if (definition.direct_read_allowed === false) return;
    const width = definition.width ?? definition.size ?? 1;
    const exists = pinned.some((item) => item.address === definition.address && (item.width ?? item.size) === width);
    setPinned((items) => exists
      ? items.filter((item) => !(item.address === definition.address && (item.width ?? item.size) === width))
      : [...items, definition]);
    if (exists && pinned.length === 1) setWatching(false);
  };
  const removePinned = (definition: RegisterDefinition) => {
    const width = definition.width ?? definition.size ?? 1;
    setPinned((items) => items.filter((item) => !(item.address === definition.address && (item.width ?? item.size) === width)));
    if (pinned.length === 1) setWatching(false);
  };
  const openWrite = (context: RegisterWriteContext) => {
    setWriteContext(context); setWriteData(""); setPlan(undefined); setWriteOpen(true);
  };
  const prepareWrite = async () => {
    if (!slave || !writeContext) return;
    const value = await run(() => bridgeRequest<{ plan_id: string; plan: Record<string, unknown>; expires_in_seconds: number }>(
      "register_prepare_write",
      { position: slave.position, address: writeContext.address, size: writeContext.width, data: writeData, semantics: writeContext.access, known_register: writeContext.known, definition_id: selected?.definition_id, profile: registerProfile },
    ));
    if (value) setPlan({ plan_id: value.plan_id, plan: value.plan, expiresAt: Date.now() + value.expires_in_seconds * 1000 });
  };
  const executeWrite = async () => {
    if (!plan) return;
    const value = await run(() => bridgeRequest("register_execute_write", { plan_id: plan.plan_id }), "寄存器写入并验证完成");
    if (value) {
      setPlan(undefined); setWriteOpen(false);
      if (writeContext?.known && selected) await read(selected); else await readRaw();
    }
  };
  const decodedFields = useMemo(() => {
    if (!selected?.bit_fields || !result?.data) return [];
    const value = littleEndianValue(result.data);
    return selected.bit_fields.map((field) => ({
      name: field.name,
      value: (value >> BigInt(field.shift)) & ((1n << BigInt(field.bits)) - 1n),
    }));
  }, [selected, result]);
  const planRemaining = plan ? Math.max(0, Math.ceil((plan.expiresAt - planNow) / 1000)) : 0;
  const planExpired = Boolean(plan && planRemaining === 0);

  return <><PageTitle title="寄存器" subtitle={slave ? `从站 ${slave.position} · ESC 型号 ${registerProfile}` : "标准 ESC 寄存器读取与诊断"} actions={<Stack direction="row" gap={1} alignItems="center">{readingDefinitionId && <><CircularProgress size={18} /><Typography variant="caption">正在读取寄存器…</Typography></>}{result?.data && <Button size="small" variant="outlined" onClick={() => void copyReadValue()}>{copied ? "已复制" : "复制读取值"}</Button>}</Stack>} />
    {!slave ? <EmptyState text="请先选择从站" /> : <Stack spacing={1.5}>
      <Alert severity="info">目标：从站 {slave.position} · 配置地址 {slave.configured_address === undefined ? "未知" : hex(slave.configured_address)} · 默认只读；所有写入均记录 AUDIT。</Alert>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(250px, .78fr) minmax(0, 1.22fr)", xl: "minmax(270px, .78fr) minmax(0, 1.22fr)" }, gap: 1.25, minHeight: 0 }}>
        <Card sx={cardSx}>
          <CardContent sx={{ pb: "10px !important" }}>
            <Stack spacing={0.8}>
              <TextField fullWidth size="small" placeholder="搜索名称、地址、类别或地址空间" value={query} onChange={(e) => setQuery(e.target.value)} />
              <FormControl fullWidth size="small"><InputLabel>类别</InputLabel><Select label="类别" value={group} onChange={(e) => setGroup(String(e.target.value))}>{groups.map((item) => <MenuItem value={item} key={item}>{item}</MenuItem>)}</Select></FormControl>
              <Typography variant="caption" color="text.secondary">{filtered.length} / {catalog.length} 项；本地 PDI/HBI/PHY 项仅供查阅。</Typography>
              {catalogError && <Alert severity="error">加载 {registerProfile} 寄存器定义失败：{catalogError}</Alert>}
            </Stack>
          </CardContent>
          <Divider />
          <List dense sx={{ overflow: "auto", maxHeight: "calc(100vh - 350px)", p: 0.6 }}>
            {filtered.map((definition) => <ListItemButton disabled={Boolean(readingDefinitionId)} selected={selected?.definition_id === definition.definition_id} key={definition.definition_id ?? `${definition.address}-${definition.name}`} onClick={() => void read(definition)} sx={{ py: 0.55, px: 0.8 }}><ListItemText primary={definition.name} secondary={`${definition.address_text ?? hex(definition.address)} · ${definition.group} · ${definition.address_space_label ?? "ESC"}`} primaryTypographyProps={{ fontSize: 13 }} secondaryTypographyProps={{ fontSize: 11.5 }} /><Stack alignItems="flex-end" gap={0.35}>{readingDefinitionId === definition.definition_id ? <CircularProgress size={18} /> : <Chip size="small" variant="outlined" label={definition.access} />}{definition.direct_read_allowed === false && <Chip size="small" color="warning" variant="outlined" label="本地访问" />}</Stack></ListItemButton>)}
            {!catalogError && catalog.length > 0 && filtered.length === 0 && <Box sx={{ py: 6, px: 2, textAlign: "center", color: "text.secondary" }}><Typography fontWeight={700}>没有匹配的寄存器</Typography><Typography variant="caption">请调整搜索词或类别筛选。</Typography></Box>}
          </List>
        </Card>
        <Card sx={cardSx}><CardContent>{selected ? <Stack spacing={1.25}><Stack direction="row" justifyContent="space-between" gap={1}><Box minWidth={0}><Typography variant="h6" noWrap title={selected.name}>{selected.name}</Typography><Typography variant="body2" color="text.secondary" noWrap title={selected.description}>{selected.description}</Typography></Box><Chip label={selected.access} size="small" /></Stack><Divider /><Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1.25 }}><Box><Typography className="section-label">地址 / 空间</Typography><Typography className="mono kv-value">{selected.address_text ?? hex(selected.address)}</Typography><Typography variant="caption" color="text.secondary">{selected.address_space_label ?? "ESC Core"}</Typography></Box><Box><Typography className="section-label">宽度 / 主站权限</Typography><Typography className="kv-value">{selected.width ?? selected.size} byte</Typography><Typography variant="caption" color="text.secondary">{selected.master_access ?? selected.access}</Typography></Box><Box><Typography className="section-label">WKC / 可信度</Typography><Typography className="kv-value">{result ? result.wkc : "—"}</Typography><Typography variant="caption" color="text.secondary">{selected.confidence ?? "—"}</Typography></Box></Box>{selected.direct_read_allowed === false ? <Alert severity="warning">此项属于 {selected.address_space_label}，或未声明允许 EtherCAT 主站访问；当前桥接不会发送 FPRD/FPWR。</Alert> : <Box><Typography className="section-label">读取值</Typography><Typography className="mono data-surface" sx={{ mt: 0.6, p: 1.25, fontSize: 17, minHeight: 42, display: "flex", alignItems: "center" }}>{result?.data ?? "选择即读取"}</Typography></Box>}<Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 0.8 }}><Box><Typography className="section-label">复位 / 上电默认值</Typography><Typography variant="body2">{selected.reset_value ?? "未记录"} / {selected.power_on_default ?? "未记录"}</Typography></Box><Box><Typography className="section-label">状态限制</Typography><Typography variant="body2">{selected.state_restriction ?? "未记录"}</Typography></Box><Box><Typography className="section-label">保留位规则</Typography><Typography variant="body2">{selected.reserved_bits_rule ?? "未记录"}</Typography></Box></Box>{selected.fields && <Box><Typography className="section-label">位字段与 EtherCAT 访问权限</Typography><TableContainer sx={{ mt: 0.6, maxHeight: 180 }}><Table size="small" stickyHeader><TableHead><TableRow><TableCell>Bits</TableCell><TableCell>字段</TableCell><TableCell>访问</TableCell><TableCell>说明</TableCell></TableRow></TableHead><TableBody>{selected.fields.map((field, index) => <TableRow key={`${field.bits}-${field.name}-${index}`}><TableCell className="mono">{field.bits}</TableCell><TableCell>{field.name}{field.reserved && "（保留）"}</TableCell><TableCell>{field.ecat_access ?? field.access ?? "—"}</TableCell><TableCell title={field.description}>{field.description || "—"}</TableCell></TableRow>)}</TableBody></Table></TableContainer></Box>}{decodedFields.length > 0 && <Box><Typography className="section-label">当前值解码</Typography><Stack direction="row" gap={0.6} flexWrap="wrap" sx={{ mt: 0.6 }}>{decodedFields.map((field) => <Chip key={field.name} size="small" label={`${field.name}: ${field.value}`} />)}</Stack></Box>}<Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap">{selected.direct_read_allowed !== false && <Button size="small" variant={pinned.some((item) => item.definition_id === selected.definition_id) ? "contained" : "outlined"} onClick={() => togglePinned(selected)}>{pinned.some((item) => item.definition_id === selected.definition_id) ? "取消固定" : "固定监视"}</Button>}{selected.address === 0x0040 && selected.direct_read_allowed !== false ? <Button size="small" color="error" onClick={() => setResetConfirm(true)}>发送三帧 RES</Button> : selected.direct_write_allowed && <Button size="small" color="warning" onClick={() => openWrite({ address: selected.address, width: selected.width ?? selected.size ?? 1, name: selected.name, access: selected.access, known: true })}>{selected.access === "W1C" || selected.access === "W1S" ? "操作掩码" : selected.access === "WAC" ? "清零操作" : "进入写入模式"}</Button>}</Stack><Alert sx={{ py: 0.35 }} severity={selected.direct_write_allowed ? "warning" : "info"}>{selected.direct_write_allowed ? `${selected.access} 写入严格使用定义宽度，并在第二次确认后执行。` : selected.dangerous ? "该项含混合权限、保留位、状态限制或副作用；普通整寄存器写入已禁用。" : "只读寄存器，不提供写入操作。"}</Alert></Stack> : <Box sx={{ minHeight: 240, display: "grid", placeItems: "center", color: "text.secondary" }}>从左侧选择寄存器即可读取</Box>}</CardContent></Card>
      </Box>
      <Card sx={cardSx}>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Box minWidth={0}><Typography variant="h6">固定监视 {pinned.length > 0 && <Typography component="span" variant="caption" color="text.secondary">· {pinned.length} 项</Typography>}</Typography><Typography variant="caption" color="text.secondary">合并相邻范围；值变化时短暂高亮；失败后自动暂停。</Typography></Box>
            <Stack direction="row" gap={0.75}><FormControl size="small" sx={{ width: 122 }}><InputLabel>刷新周期</InputLabel><Select label="刷新周期" value={intervalMs} disabled={watching} onChange={(e) => setIntervalMs(Number(e.target.value))}>{[500, 1000, 2000, 5000].map((value) => <MenuItem value={value} key={value}>{value} ms</MenuItem>)}</Select></FormControl><Button size="small" disabled={!pinned.length} variant={watching ? "contained" : "outlined"} onClick={() => setWatching(!watching)}>{watching ? "暂停" : "开始"}</Button><Button size="small" disabled={!pinned.length} onClick={() => { setPinned([]); setWatchValues({}); watchValuesRef.current = {}; setWatching(false); }}>清空</Button></Stack>
          </Stack>
          {watchError && <Alert severity="error" sx={{ mt: 1 }}>{watchError}</Alert>}
          <TableContainer sx={{ mt: 1 }}><Table size="small"><TableHead><TableRow>{["地址", "名称", "值", "耗时", "操作"].map((item) => <TableCell key={item}>{item}</TableCell>)}</TableRow></TableHead><TableBody>{pinned.map((definition) => { const width = definition.width ?? definition.size ?? 1; const key = registerKey(definition.address, width); const value = watchValues[key]; const changed = changedWatchKeys.has(key); return <TableRow key={key} sx={{ bgcolor: changed ? "warning.light" : "transparent", transition: "background-color .35s ease" }}><TableCell className="mono">{hex(definition.address)}</TableCell><TableCell>{definition.name}</TableCell><TableCell className="mono"><Stack direction="row" alignItems="center" gap={0.75}>{value?.data ?? "—"}{changed && <Chip size="small" color="warning" label="变化" />}</Stack></TableCell><TableCell>{value ? `${value.duration_ms.toFixed(2)} ms` : "—"}</TableCell><TableCell><Button size="small" onClick={() => removePinned(definition)}>移除</Button></TableCell></TableRow>; })}{!pinned.length && <TableRow><TableCell colSpan={5} align="center" sx={{ py: 2.5, color: "text.secondary" }}>从标准寄存器详情中固定需要监视的项目</TableCell></TableRow>}</TableBody></Table></TableContainer>
        </CardContent>
      </Card>
        <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreRounded />}><Box><Typography fontWeight={700}>原始地址工具</Typography><Typography variant="caption" color="text.secondary">用于未收录地址；宽度同时约束读取长度和写入 HEX 字节数。</Typography></Box></AccordionSummary><AccordionDetails><Alert severity="warning" sx={{ mb: 1.5 }}>未知地址写入可能破坏链路、状态机或 EEPROM 控制状态；写入数据必须与“宽度”完全一致，仍会生成计划、二次确认并记录 AUDIT。</Alert><Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><TextField size="small" label="地址" value={rawAddress} onChange={(e) => setRawAddress(e.target.value)} inputProps={{ className: "mono" }} sx={{ width: 150 }} /><TextField size="small" type="number" label="读写宽度（byte）" value={rawSize} onChange={(e) => setRawSize(Number(e.target.value))} inputProps={{ min: 1, max: 256 }} sx={{ width: 150 }} /><Button variant="outlined" disabled={parseHexInput(rawAddress) === undefined || !Number.isInteger(rawSize) || rawSize < 1 || rawSize > 256} onClick={readRaw}>读取</Button><FormControl size="small" sx={{ width: 150 }}><InputLabel>写入语义</InputLabel><Select label="写入语义" value={rawAccess} onChange={(e) => setRawAccess(e.target.value)}>{["RW", "WO", "W1C", "W1S", "WAC", "SELF_CLEARING", "VOLATILE"].map((item) => <MenuItem value={item} key={item}>{item}</MenuItem>)}</Select></FormControl><Button color="warning" disabled={parseHexInput(rawAddress) === undefined || !Number.isInteger(rawSize) || rawSize < 1 || rawSize > 256} onClick={() => openWrite({ address: parseHexInput(rawAddress) ?? 0, width: rawSize, name: `原始地址 ${rawAddress}`, access: rawAccess, known: false })}>写入工具</Button><Typography className="mono">{rawResult?.data ?? ""}</Typography></Stack></AccordionDetails></Accordion>
    </Stack>}
    <Dialog open={writeOpen} onClose={() => { setWriteOpen(false); setPlan(undefined); }} fullWidth maxWidth="sm"><DialogTitle>寄存器安全写入</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}><Alert severity="warning">目标从站 {slave?.position ?? "—"} · {writeContext?.name} · {hex(writeContext?.address ?? 0)}。请确认访问语义和最终字节。</Alert><TextField label={writeContext?.access === "W1C" || writeContext?.access === "W1S" ? `操作掩码（HEX，必须 ${writeContext?.width ?? 0} B）` : `目标值（HEX，必须 ${writeContext?.width ?? 0} B）`} value={writeData} onChange={(e) => { setWriteData(e.target.value); setPlan(undefined); }} inputProps={{ className: "mono" }} />{plan && <Box sx={{ p: 2, bgcolor: "#F7F8FB", borderRadius: 2 }}><Stack direction="row" justifyContent="space-between"><Typography variant="subtitle2">写入计划</Typography><Chip size="small" color={planExpired ? "error" : planRemaining <= 10 ? "warning" : "default"} label={planExpired ? "已过期" : `${planRemaining} 秒后过期`} /></Stack><Typography className="mono">当前值：{String(plan.plan.current || "不可回读")}</Typography><Typography className="mono">目标值：{String(plan.plan.target)}</Typography><Typography className="mono">变化位：{String(plan.plan.changed_mask || "按语义执行")}</Typography>{planExpired && <Alert severity="warning" sx={{ mt: 1 }}>计划已超过 60 秒，请重新生成并确认。</Alert>}</Box>}</Stack></DialogContent><DialogActions><Button onClick={() => { setWriteOpen(false); setPlan(undefined); }}>取消</Button>{!plan || planExpired ? <Button variant="contained" color="warning" disabled={!writeData.trim()} onClick={prepareWrite}>重新生成写入计划</Button> : <Button variant="contained" color="error" onClick={executeWrite}>确认并执行</Button>}</DialogActions></Dialog>
    <Dialog open={resetConfirm} onClose={() => setResetConfirm(false)}><DialogTitle>确认复位 EtherCAT 控制器</DialogTitle><DialogContent><Alert severity="error">将独占 Worker，以三个连续、独立 FPWR 向 0x0040 写入 52、45、53；从站会短暂掉线。</Alert></DialogContent><DialogActions><Button onClick={() => setResetConfirm(false)}>取消</Button><Button color="error" variant="contained" onClick={async () => { const value = await run(() => bridgeRequest("register_reset", { position: slave?.position, profile: registerProfile }), "RES 复位序列已发送"); if (value) setResetConfirm(false); }}>确认并发送</Button></DialogActions></Dialog>
  </>;
}

interface EsiResult { document_id: string; path: string; vendor_id: number; vendor_name: string; devices: EsiDevice[] }
interface SiiLayoutItem { kind?: number; name: string; offset: number; length: number; content: string }
interface TargetResult { target_id: string; size: number; sha256: string; supported: string[]; omitted: string[]; device: EsiDevice; layout: SiiLayoutItem[]; original_config_data?: string; effective_config_data?: string }
type ProgressState = EepromProgressState;
interface EepromComparisonResult { equal: boolean; differing_bytes: number; first_difference?: number; target_sha256: string; readback_sha256: string }
interface EepromReadResult { data: string; size: number; sha256: string; read_at: string; sii_valid: boolean; sii_error?: string; identity?: { vendor_id: number; product_code: number; revision: number; serial_number: number }; category_count?: number; categories?: number[]; end_offset?: number; comparison?: EepromComparisonResult }
interface EepromFlashDetails { bytes_read_back: number; words_written: number; comparison: EepromComparisonResult; sii_valid: boolean; semantic_valid: boolean; image_verification: string; reset_sequence?: boolean[] | null; rediscovered?: boolean | null; reload_verified?: boolean | null }
interface EepromFlashPayload { success: boolean; result: EepromFlashDetails; slaves: SlaveInfo[] }
interface EepromOperationResult { title: string; severity: "success" | "warning" | "error" | "info"; payload?: EepromFlashPayload; error?: string }

function targetNeedsAttention(target: TargetResult): boolean {
  return target.omitted.some((item) => /PDO entry names omitted|PDO categories omitted|DC category/.test(item));
}

function identityMismatchReasons(slave: SlaveInfo | undefined, document: EsiResult | undefined, device: EsiDevice | undefined): string[] {
  if (!slave || !document || !device) return [];
  const reasons: string[] = [];
  if (slave.identity.vendor_id !== document.vendor_id) reasons.push("Vendor ID 不同");
  if (slave.identity.product_code !== device.product_code) reasons.push("Product Code 不同");
  if (slave.identity.revision !== deviceRevision(device)) reasons.push("Revision 不同");
  return reasons;
}

function formatHexView(data: string): string {
  const bytes = data.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    const hexadecimal = row.join(" ").padEnd(47, " ");
    const ascii = row.map((item) => {
      const value = Number.parseInt(item, 16);
      return value >= 0x20 && value <= 0x7E ? String.fromCharCode(value) : ".";
    }).join("");
    lines.push(`${offset.toString(16).toUpperCase().padStart(4, "0")}: ${hexadecimal}  |${ascii.padEnd(16, " ")}|`);
  }
  return lines.join("\n");
}

function deviceRevision(device: EsiDevice): number {
  return Number(device.revision ?? device.revision_number ?? 0);
}

function deviceConfigData(device?: EsiDevice): string {
  const value = typeof device?.config_data === "string" ? device.config_data : "";
  return normalizeConfigData(value).formatted ?? "";
}

interface EepromPageProps {
  slave?: SlaveInfo;
  status: WorkbenchStatus;
  progress?: ProgressState;
  setProgress: (value?: ProgressState) => void;
  run: Run;
  readResult?: EepromReadResult;
  setReadResult: (value?: EepromReadResult) => void;
  initialSelection?: EepromDetailSelection;
  onInitialSelectionConsumed: () => void;
  autoResetEsc: boolean;
  fileDropEnabled: boolean;
}

function EepromPage({ slave, status, progress, setProgress, run, readResult, setReadResult, initialSelection, onInitialSelectionConsumed, autoResetEsc, fileDropEnabled }: EepromPageProps) {
  const [esi, setEsi] = useState<EsiResult>();
  const [ordinal, setOrdinal] = useState(0);
  const [target, setTarget] = useState<TargetResult>();
  const [physicalSize, setPhysicalSize] = useState<number>();
  const [capacityError, setCapacityError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [recentEsi, setRecentEsi] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(RECENT_ESI_KEY) ?? "[]") as string[]; }
    catch { return []; }
  });
  const [configData, setConfigData] = useState("");
  const [originalConfigData, setOriginalConfigData] = useState("");
  const [operationResult, setOperationResult] = useState<EepromOperationResult>();
  const generationRequestRef = useRef(0);
  const generatedConfigRef = useRef("");
  const autoMatchContextRef = useRef("");
  const currentDevice = esi?.devices[ordinal];
  const configDataResult = normalizeConfigData(configData);
  const configDecoded = decodeConfigData(configData);
  const operationInProgress = isEepromOperation(progress?.operation) && progress!.percent < 100;
  const capacityKnown = physicalSize !== undefined && !capacityError;
  const capacityMatches = Boolean(target && capacityKnown && target.size === physicalSize);
  const capacityState = !target ? "uncompared" : !capacityKnown ? "unknown" : capacityMatches ? "matched" : "mismatched";
  const identityMismatches = identityMismatchReasons(slave, esi, currentDevice);
  const identityMismatch = identityMismatches.length > 0;
  const canFlash = Boolean(slave && target && capacityMatches && !status.cycle_running && !operationInProgress);
  const blockers = [operationInProgress && "已有 EEPROM 操作正在执行", !target && "需要选择有效 XML", !capacityKnown && "需要成功读取物理 EEPROM 容量", target && capacityKnown && !capacityMatches && "目标容量与物理 EEPROM 不一致", status.cycle_running && "需要停止周期通信"].filter(Boolean) as string[];
  useEffect(() => {
    let active = true;
    setPhysicalSize(undefined); setCapacityError(""); setOperationResult(undefined); setBackupPath("");
    if (slave) bridgeRequest<{ size: number }>("eeprom_capacity", { position: slave.position })
      .then((value) => { if (active) setPhysicalSize(value.size); })
      .catch((error) => { if (active) setCapacityError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [slaveIdentityKey(slave)]);

  const generate = useCallback(async (document: EsiResult, selectedOrdinal: number, effectiveConfig?: string) => {
    const requestId = ++generationRequestRef.current;
    const normalized = normalizeConfigData(effectiveConfig ?? deviceConfigData(document.devices[selectedOrdinal])).formatted;
    generatedConfigRef.current = normalized ?? "";
    setTarget(undefined); setOperationResult(undefined); setGenerationError("");
    const value = await run(async () => {
      try { return await bridgeRequest<TargetResult>("sii_generate", { document_id: document.document_id, ordinal: selectedOrdinal, ...(normalized ? { config_data: normalized } : {}) }); }
      catch (error) {
        if (generationRequestRef.current === requestId) setGenerationError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    if (value && generationRequestRef.current === requestId) setTarget(value);
  }, [run]);

  useEffect(() => {
    if (!slave || !esi) return;
    const context = `${esi.document_id}:${slaveIdentityKey(slave)}`;
    if (autoMatchContextRef.current === context) return;
    autoMatchContextRef.current = context;
    const matched = esi.devices.findIndex((device) =>
      esi.vendor_id === slave.identity.vendor_id && device.product_code === slave.identity.product_code &&
      deviceRevision(device) === slave.identity.revision,
    );
    if (matched >= 0) {
      const nextConfig = deviceConfigData(esi.devices[matched]);
      setOrdinal(matched);
      setOriginalConfigData(nextConfig);
      setConfigData(nextConfig);
      void generate(esi, matched, nextConfig);
    }
  }, [esi, generate, slaveIdentityKey(slave)]);

  const loadXml = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string) => {
    const document = await run(() => bridgeRequest<EsiResult>("esi_load", { path }));
    if (document) {
      const nextRecent = [path, ...recentEsi.filter((item) => item !== path)].slice(0, 5);
      setRecentEsi(nextRecent);
      window.localStorage.setItem(RECENT_ESI_KEY, JSON.stringify(nextRecent));
      const matched = slave ? document.devices.findIndex((device) =>
        document.vendor_id === slave.identity.vendor_id && device.product_code === slave.identity.product_code && deviceRevision(device) === slave.identity.revision,
      ) : -1;
      const selectedOrdinal = preferredOrdinal !== undefined && document.devices[preferredOrdinal] ? preferredOrdinal : matched >= 0 ? matched : 0;
      const original = deviceConfigData(document.devices[selectedOrdinal]);
      const effective = normalizeConfigData(overrideConfig ?? original).formatted ?? original;
      autoMatchContextRef.current = slave ? `${document.document_id}:${slaveIdentityKey(slave)}` : "";
      setEsi(document); setOrdinal(selectedOrdinal); setOriginalConfigData(original); setConfigData(effective); await generate(document, selectedOrdinal, effective);
    }
  }, [generate, recentEsi, run, slaveIdentityKey(slave)]);
  useEffect(() => {
    if (!initialSelection) return;
    void loadXml(initialSelection.path, initialSelection.ordinal, initialSelection.configData)
      .finally(onInitialSelectionConsumed);
  }, [initialSelection, loadXml, onInitialSelectionConsumed]);
  const selectXml = async () => {
    const path = await pickFile(["xml"]); if (path) await loadXml(path);
  };
  useEffect(() => {
    if (!fileDropEnabled) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void onFileDrop((paths) => {
      const xml = paths.find((path) => path.toLowerCase().endsWith(".xml"));
      if (xml && !operationInProgress) void loadXml(xml);
    }).then((value) => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); };
  }, [fileDropEnabled, loadXml, operationInProgress]);
  useEffect(() => {
    if (!esi || !configDataResult.formatted || configDataResult.formatted === generatedConfigRef.current) return;
    setTarget(undefined);
    const timer = window.setTimeout(() => void generate(esi, ordinal, configDataResult.formatted!), 250);
    return () => window.clearTimeout(timer);
  }, [configData, configDataResult.formatted, esi, generate, ordinal]);
  const changeDevice = async (value: number) => {
    setOrdinal(value);
    if (esi) {
      const nextConfig = deviceConfigData(esi.devices[value]);
      setOriginalConfigData(nextConfig);
      setConfigData(nextConfig);
      await generate(esi, value, nextConfig);
    }
  };
  const operation = async <T,>(fn: () => Promise<T>, success: string): Promise<T | undefined> => {
    if (["eeprom_read", "eeprom_backup", "eeprom_flash", "eeprom_restore"].some((method) => operationStore.active(method))) return undefined;
    setOperationResult(undefined);
    setProgress({ operation: "eeprom", stage: "准备", completed: 0, total: 100, percent: 0, detail: "正在检查操作条件", tone: "info", cancellable: true });
    try {
      const value = await fn();
      const flashPayload = value as EepromFlashPayload;
      if (flashPayload && typeof flashPayload === "object" && "success" in flashPayload) {
        if (!flashPayload.success) {
          const title = "镜像校验失败";
          setProgress({ operation: "eeprom", stage: title, completed: 100, total: 100, percent: 100, detail: flashPayload.result.image_verification, tone: "error" });
          setOperationResult({ title, severity: "error", payload: flashPayload });
          return value;
        }
        const reloadFailed = flashPayload.result.reload_verified === false;
        const title = reloadFailed ? "镜像校验成功；复位后复核失败" : success;
        setProgress({ operation: "eeprom", stage: title, completed: 100, total: 100, percent: 100, detail: reloadFailed ? "EEPROM 镜像已通过校验，但复位后的重新加载复核未通过。" : success, tone: reloadFailed ? "info" : "success" });
        setOperationResult({ title, severity: reloadFailed ? "warning" : "success", payload: flashPayload });
      } else {
        setProgress({ operation: "eeprom", stage: success, completed: 100, total: 100, percent: 100, detail: success, tone: "success" });
        setOperationResult({ title: success, severity: "success" });
      }
      return value;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof BridgeRequestError && error.code === "CANCELLED") {
        setProgress({ operation: "eeprom", stage: "已取消", completed: 100, total: 100, percent: 100, detail: text, tone: "info" });
        setOperationResult({ title: "操作已取消", severity: "info", error: text });
        return undefined;
      }
      setProgress({ operation: "eeprom", stage: "操作失败", completed: 100, total: 100, percent: 100, detail: text, tone: "error" });
      setOperationResult({ title: "操作失败", severity: "error", error: text });
      return undefined;
    }
  };
  const readFull = async () => {
    if (!slave) return;
    const value = await operation(() => bridgeRequest<EepromReadResult>("eeprom_read", { position: slave.position, target_id: target?.target_id }), "完整读取完成");
    if (value) setReadResult(value);
  };
  const backup = async () => { if (!slave) return; const directory = await pickDirectory(); if (directory) { const value = await operation(() => bridgeRequest<{ binary_path: string }>("eeprom_backup", { position: slave.position, directory }), "BIN 备份完成"); if (value) setBackupPath(value.binary_path); } };
  const restore = async () => { if (!slave) return; const path = await pickFile(["bin"]); if (path) await operation(() => bridgeRequest<EepromFlashPayload>("eeprom_restore", { position: slave.position, path, auto_reset: autoResetEsc }), "恢复并校验完成"); };
  const flash = () => slave && target && operation(() => bridgeRequest<EepromFlashPayload>("eeprom_flash", { position: slave.position, target_id: target.target_id, auto_reset: autoResetEsc }), "烧录并校验完成");

  return <><PageTitle title="EEPROM" subtitle="ESI 预览、完整读取、BIN 备份与安全烧录" />
    <Box sx={{ mb: 1.25, p: 1.25, border: "1px dashed", borderColor: "primary.light", borderRadius: 1.5, bgcolor: "rgba(25,118,210,.035)" }}><Stack direction="row" alignItems="center" gap={1} flexWrap="wrap"><Typography variant="body2" fontWeight={700}>可将 ESI XML 拖入窗口</Typography><Typography variant="caption" color="text.secondary">最近文件：</Typography>{recentEsi.length ? recentEsi.map((path) => <Chip key={path} size="small" variant="outlined" disabled={operationInProgress} label={path.split(/[\\/]/).at(-1)} title={path} onClick={() => void loadXml(path)} />) : <Typography variant="caption" color="text.secondary">暂无</Typography>}</Stack></Box>
    {backupPath && <Alert severity="success" action={<Button size="small" onClick={() => revealPath(backupPath)}>打开位置</Button>} sx={{ mb: 1.25 }}><Typography fontWeight={700}>BIN 备份已保存</Typography><Typography variant="body2" className="mono" sx={{ overflowWrap: "anywhere" }}>{backupPath}</Typography></Alert>}
    {operationResult?.payload && <Alert severity="info" sx={{ mb: 1.25 }}><Typography variant="body2"><strong>技术详情 · 首个差异：</strong>{operationResult.payload.result.comparison.first_difference === undefined ? "无" : hex(operationResult.payload.result.comparison.first_difference, 4)}</Typography></Alert>}
    {target?.layout && <Card sx={{ ...cardSx, mb: 1.25 }}><CardContent><Typography variant="h6">Smart View · 目标 SII 布局</Typography><Typography variant="caption" color="text.secondary">类别偏移和长度含类别头；内容最多预览前 32 byte。</Typography><TableContainer sx={{ mt: 1, maxHeight: 260 }}><Table size="small" stickyHeader><TableHead><TableRow><TableCell>类别</TableCell><TableCell>类型</TableCell><TableCell>偏移</TableCell><TableCell>长度</TableCell><TableCell>内容预览</TableCell></TableRow></TableHead><TableBody>{target.layout.map((item) => <TableRow key={`${item.offset}-${item.name}`}><TableCell>{item.name}</TableCell><TableCell className="mono">{item.kind === undefined || item.kind === null ? "—" : hex(item.kind)}</TableCell><TableCell className="mono">{hex(item.offset, 4)}</TableCell><TableCell>{item.length} B</TableCell><TableCell className="mono" sx={{ maxWidth: 420 }}><Typography variant="caption" noWrap title={item.content}>{item.content || "（空）"}</Typography></TableCell></TableRow>)}</TableBody></Table></TableContainer></CardContent></Card>}
    {progress && isEepromOperation(progress.operation) && <Card sx={{ ...cardSx, mb: 1.25, borderColor: progress.tone === "error" ? "error.main" : progress.tone === "success" ? "success.main" : "primary.main" }}><CardContent sx={{ py: "10px !important" }}><Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}><Box minWidth={0}><Typography fontWeight={700}>{progress.stage}</Typography><Typography variant="caption" color="text.secondary" noWrap>{progress.detail}</Typography></Box><Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 230 }}><LinearProgress color={progress.tone === "error" ? "error" : progress.tone === "success" ? "success" : "primary"} variant="determinate" value={progress.percent} sx={{ flex: 1, height: 5, borderRadius: 4 }} /><Typography className="mono" variant="caption" sx={{ width: 34, textAlign: "right" }}>{progress.percent}%</Typography>{progress.percent < 100 && progress.cancellable !== false && <Button size="small" onClick={() => bridgeRequest("cancel")}>取消</Button>}</Stack></Stack></CardContent></Card>}
    {!slave ? <EmptyState text="请先选择目标从站" /> : <Stack spacing={1.5}>
      <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(320px, .85fr)", gap: 1.25, alignItems: "start" }}>
        <Card sx={cardSx}><CardContent><Stack direction="row" alignItems="center" justifyContent="space-between"><Box><Typography variant="h6">烧录目标</Typography><Typography color="text.secondary">XML 或 Device 变化时自动生成</Typography></Box><Button disabled={operationInProgress} variant="outlined" startIcon={<FolderOpenRounded />} onClick={selectXml}>选择 XML</Button></Stack><Divider sx={{ my: 2 }} />
          {esi ? <Stack spacing={1.5}>
            <TextField label="XML 文件" size="small" value={esi.path} InputProps={{ readOnly: true }} />
            <FormControl disabled={operationInProgress} fullWidth size="small"><InputLabel>Device</InputLabel><Select label="Device" value={ordinal} onChange={(e) => changeDevice(Number(e.target.value))}>{esi.devices.map((device, i) => <MenuItem value={i} key={i}>{device.name} · {hex(device.product_code, 8)}</MenuItem>)}</Select></FormControl>
            <Box sx={{ p: 1.4, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "#FAFBFD" }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 0.8 }}><Box><Typography variant="subtitle2">本次烧录 ConfigData</Typography><Typography variant="caption" color="text.secondary">10 byte；修改只作用于本次内存目标，原 XML 不变</Typography></Box><Button size="small" disabled={operationInProgress || configData === originalConfigData} onClick={() => setConfigData(originalConfigData)}>恢复原值</Button></Stack>
              <TextField fullWidth size="small" value={configData} disabled={operationInProgress} error={Boolean(configDataResult.error)} helperText={configDataResult.error ?? (configDecoded ? `PDI ${configDecoded.formatted.slice(0, 2)} · ${configDecoded.pdiLabel}` : "输入 10 个十六进制字节")} onChange={(event) => { setConfigData(event.target.value.toUpperCase()); setTarget(undefined); }} onBlur={() => configDataResult.formatted && setConfigData(configDataResult.formatted)} inputProps={{ className: "mono", spellCheck: false }} />
            </Box>
            {identityMismatch && <Alert severity="info">当前 XML/Device 与目标从站身份不同：{identityMismatches.join("、")}。该信息仅供核对，不影响烧录。</Alert>}
            {generationError ? <Alert severity="error"><Typography fontWeight={700}>目标生成失败</Typography>{generationError}</Alert> : target ? <Alert severity={targetNeedsAttention(target) ? "warning" : "success"}>{targetNeedsAttention(target) ? "目标已生成，但有容量降级或关键类别未写入；请查看 Smart View。" : "目标已生成，容量与完整性由烧录条件继续检查。"}</Alert> : <Alert severity="info">正在生成 Smart View…</Alert>}
          </Stack> : <Box sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>选择厂商 ESI XML 后自动解析并生成目标</Box>}
        </CardContent></Card>
        <Card sx={cardSx}><CardContent><Typography variant="h6">Smart View</Typography><Typography color="text.secondary">随当前 XML 和 Device 实时更新</Typography><Divider sx={{ my: 2 }} />
          {currentDevice && target ? <Stack spacing={1.5}><Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5 }}>{[["设备", currentDevice.name], ["厂商", esi?.vendor_name], ["Product Code（产品代码）", hex(currentDevice.product_code, 8)], ["Revision（修订版本）", hex(deviceRevision(currentDevice), 8)], ["目标容量", `${target.size} B`], ["物理容量", capacityError ? "读取失败" : physicalSize === undefined ? "读取中…" : `${physicalSize} B`], ["SHA-256", target.sha256]].map(([label, value]) => <Box key={String(label)}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography className={String(label).includes("Code") || label === "SHA-256" ? "mono" : ""} noWrap title={String(value)}>{value}</Typography></Box>)}</Box>{capacityError && <Alert severity="error">{capacityError}</Alert>}<Divider /><Box><Typography variant="subtitle2">已转换内容</Typography><Stack direction="row" flexWrap="wrap" gap={0.7} sx={{ mt: 1 }}>{target.supported.map((item) => <Chip size="small" color="success" variant="outlined" label={item} key={item} />)}</Stack></Box>{target.omitted.length > 0 && <Box><Typography variant="subtitle2" color={targetNeedsAttention(target) ? "warning.main" : "text.primary"}>{targetNeedsAttention(target) ? "容量降级或未写入类别" : "转换范围说明"}</Typography>{target.omitted.map((item) => <Typography variant="body2" color={targetNeedsAttention(target) ? "warning.main" : "text.secondary"} key={item}>• {item}</Typography>)}</Box>}</Stack> : <Box sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>尚无可预览的烧录目标</Box>}
        </CardContent></Card>
      </Box>
      <Card sx={cardSx}><CardContent><Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(300px, .85fr)", gap: 2, alignItems: "start" }}><Box><Typography variant="h6">读取与恢复</Typography><Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.25 }}>完整读取只刷新 Smart/Hex View；备份 BIN 会保存可恢复文件。</Typography><Stack direction="row" gap={0.75} flexWrap="wrap"><Tooltip title={status.cycle_running ? "完整读取前必须停止周期通信" : ""}><span><Button size="small" variant="outlined" disabled={status.cycle_running || operationInProgress} onClick={readFull}>完整读取</Button></span></Tooltip><Tooltip title={status.cycle_running ? "备份前必须停止周期通信" : ""}><span><Button size="small" variant="outlined" disabled={status.cycle_running || operationInProgress} startIcon={<SaveAltRounded />} onClick={backup}>备份 BIN</Button></span></Tooltip><Tooltip title={status.cycle_running ? "恢复前必须停止周期通信" : "恢复时自动切换到 INIT"}><span><Button size="small" color="warning" variant="outlined" disabled={status.cycle_running || operationInProgress} onClick={restore}>从 BIN 恢复</Button></span></Tooltip>{backupPath && <Button size="small" onClick={() => revealPath(backupPath)} startIcon={<FolderOpenRounded />}>打开备份位置</Button>}</Stack></Box><Box sx={{ borderLeft: { sm: 1 }, borderColor: "divider", pl: { sm: 2 } }}><Typography variant="h6">烧录</Typography><Typography variant="caption" color="text.secondary">执行时自动将目标从站切换到 INIT，再写入并完整校验。</Typography><Stack direction="row" gap={0.6} flexWrap="wrap" sx={{ my: 1 }}><Chip color={target ? "success" : "default"} label={target ? "目标已生成" : "缺少目标"} /><Chip color={capacityState === "matched" ? "success" : capacityState === "uncompared" ? "default" : "warning"} label={{ uncompared: "容量未比对", unknown: "容量未知", matched: "容量一致", mismatched: "容量不一致" }[capacityState]} /><Chip color={!status.cycle_running ? "success" : "warning"} label={!status.cycle_running ? "周期已停止" : "周期运行中"} /></Stack><Tooltip title={blockers.join("；")}><span><Button size="small" variant="contained" color="error" disabled={!canFlash} startIcon={<MemoryRounded />} onClick={flash}>烧录</Button></span></Tooltip>{blockers.length > 0 && <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>{blockers.join("；")}</Typography>}</Box></Box></CardContent></Card>
      {readResult && <Card sx={cardSx}><CardContent><Typography variant="h6">最近完整读取</Typography><Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 1.25, mt: 1.25 }}>{[["读取时间", new Date(readResult.read_at).toLocaleString()], ["容量", `${readResult.size} B`], ["SII 结构", readResult.sii_valid ? `${readResult.category_count ?? 0} 个 Category` : "无效"], ["差异", readResult.comparison ? `${readResult.comparison.differing_bytes} byte` : "未选择目标"], ["Vendor ID（厂商 ID）", readResult.identity ? hex(readResult.identity.vendor_id, 8) : "—"], ["Product Code（产品代码）", readResult.identity ? hex(readResult.identity.product_code, 8) : "—"], ["Revision（修订版本）", readResult.identity ? hex(readResult.identity.revision, 8) : "—"], ["SHA-256", readResult.sha256]].map(([label, value]) => <Box key={label} minWidth={0}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography className={label === "SHA-256" || label.includes("Code") ? "mono" : ""} noWrap title={value}>{value}</Typography></Box>)}</Box>{!readResult.sii_valid && <Alert severity="warning" sx={{ mt: 1.25 }}>原始 BIN 已完整读取，但 SII 解析失败：{readResult.sii_error}</Alert>}<Accordion disableGutters sx={{ mt: 1.25 }}><AccordionSummary expandIcon={<ExpandMoreRounded />}><Typography fontWeight={700}>Hex View（只读）</Typography></AccordionSummary><AccordionDetails><Box component="pre" className="mono data-surface" sx={{ m: 0, p: 1.25, maxHeight: 320, overflow: "auto", fontSize: 12 }}>{formatHexView(readResult.data)}</Box></AccordionDetails></Accordion></CardContent></Card>}
      {operationResult && <Card sx={cardSx}><CardContent><Alert severity={operationResult.severity}><Typography fontWeight={700}>{operationResult.title}</Typography>{operationResult.error ?? operationResult.payload?.result.image_verification}</Alert>{operationResult.payload && <Accordion disableGutters sx={{ mt: 1.2 }}><AccordionSummary expandIcon={<ExpandMoreRounded />}><Typography fontWeight={700}>技术详情</Typography></AccordionSummary><AccordionDetails><Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>{[["写入 Word", operationResult.payload.result.words_written], ["完整回读", `${operationResult.payload.result.bytes_read_back} B`], ["差异字节", operationResult.payload.result.comparison.differing_bytes], ["目标 SHA-256", operationResult.payload.result.comparison.target_sha256], ["回读 SHA-256", operationResult.payload.result.comparison.readback_sha256], ["SII 结构", operationResult.payload.result.sii_valid ? "通过" : "失败"], ["XML 语义", operationResult.payload.result.semantic_valid ? "通过" : "失败"], ["RES 序列", operationResult.payload.result.reset_sequence == null ? "未执行" : operationResult.payload.result.reset_sequence.every(Boolean) ? "三帧成功" : "未完成"], ["重新发现", operationResult.payload.result.rediscovered == null ? "未执行" : operationResult.payload.result.rediscovered ? "成功" : "失败"], ["重新加载复核", operationResult.payload.result.reload_verified == null ? "未执行" : operationResult.payload.result.reload_verified ? "成功" : "失败"]].map(([label, value]) => <Box key={String(label)}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography className={String(label).includes("SHA") ? "mono" : ""} noWrap title={String(value)}>{String(value)}</Typography></Box>)}</Box></AccordionDetails></Accordion>}</CardContent></Card>}
    </Stack>}</>;
}

export default function App() {
  const startupScanAttempted = useRef(false);
  const requestedPage = new URLSearchParams(window.location.search).get("page") as PageKey | null;
  const [page, setPage] = useState<PageKey>(pages.some((item) => item.key === requestedPage) ? requestedPage! : "overview");
  const [status, setStatus] = useState<WorkbenchStatus>({ host_generation: 0, mode: "real", phase: "disconnected", connected: false, cycle_running: false, slaves: [], session_id: 0, revision: 0 });
  const [slaveListExpanded, setSlaveListExpanded] = useState(true);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adapter, setAdapter] = useState("");
  const [selectedPosition, setSelectedPosition] = useState<number>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [bridgeAvailable, setBridgeAvailable] = useState(true);
  const [bridgeExit, setBridgeExit] = useState<BridgeExitInfo>();
  const [message, setMessage] = useState<{ text: string; severity: "success" | "error" | "info" }>();
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState(0);
  const [alLanguage, setAlLanguage] = useState<AlStatusLanguage>(() => window.localStorage.getItem(AL_LANGUAGE_KEY) === "en" ? "en" : "zh");
  const [eepromAutoReset, setEepromAutoReset] = useState(() => loadEepromAutoReset());
  const [slaveContextMenu, setSlaveContextMenu] = useState<SlaveContextMenu>();
  const [quickFlashOpen, setQuickFlashOpen] = useState(false);
  const [eepromDetailSelection, setEepromDetailSelection] = useState<EepromDetailSelection>();
  const [eepromReadCache, setEepromReadCache] = useState<Record<string, EepromReadResult>>({});
  const [progress, setProgress] = useState<ProgressState>();
  const [registerProfileOverrides, setRegisterProfileOverrides] = useState<Record<string, string>>({});
  const appliedClockRef = useRef<{ hostGeneration: number; sessionId: number } | undefined>(undefined);
  const slave = status.slaves.find((item) => item.position === selectedPosition);
  const selectedSlaveKey = slaveIdentityKey(slave);
  const eepromReadCacheKey = `${status.host_generation}:${status.session_id}:${selectedSlaveKey}`;
  const registerProfile = slave ? registerProfileOverrides[selectedSlaveKey] ?? defaultRegisterProfile(slave.chip_model) : "ET1100";
  const operations = useSyncExternalStore(operationStore.subscribe, operationStore.snapshot);
  const busy = useMemo(() => [...operations.values()].some((operation) =>
    ["queued", "running"].includes(operation.phase) && operation.lane === "hardware" && operation.method !== "register_watch"
  ), [operations]);
  const eepromExclusive = isEepromOperation(progress?.operation) && progress!.percent < 100;
  const busState = minimumBusState(status.slaves);
  const busStateBlockedReason = !bridgeAvailable
    ? "通信核心不可用"
    : !status.connected
      ? "请先连接 EtherCAT 网卡"
      : !status.slaves.length
        ? "请先扫描从站"
        : eepromExclusive
          ? "EEPROM 操作期间不能切换状态"
          : busy
            ? "请等待当前硬件操作完成"
            : "";

  useEffect(() => subscribeBusSnapshot((next) => {
    const previousClock = appliedClockRef.current;
    const sessionChanged = previousClock !== undefined && (
      previousClock.hostGeneration !== next.host_generation
      || previousClock.sessionId !== next.session_id
    );
    appliedClockRef.current = {
      hostGeneration: next.host_generation,
      sessionId: next.session_id,
    };
    setStatus(next);
    setSelectedPosition((current) => current !== undefined && next.slaves.some((item) => item.position === current)
      ? current
      : next.slaves[0]?.position);
    if (sessionChanged) {
      setSnapshot(undefined);
      setRegisterProfileOverrides({});
      setEepromReadCache({});
    }
  }), []);

  const refresh = useCallback(async () => {
    await bridgeRequest<WorkbenchStatus>("status");
  }, []);

  const run: Run = useCallback(async (operation, success) => {
    try {
      const result = await operation();
      if (success) setMessage({ text: success, severity: "success" });
      return result;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const cancelled = error instanceof BridgeRequestError && error.code === "CANCELLED";
      setMessage({ text: cancelled ? `已取消：${text}` : text, severity: cancelled ? "info" : "error" });
      if (cancelled) return undefined;
      setProgress((previous) => previous ? { ...previous, stage: "操作失败", detail: text, tone: "error" } : previous);
      return undefined;
    }
  }, []);

  const refreshStates = useCallback(async () => {
    if (!status.connected || !status.slaves.length) {
      await refresh();
      return;
    }
    await bridgeRequest<SlaveInfo[]>("read_states", { refresh_eeprom: true });
  }, [refresh, status.connected, status.slaves.length]);

  const applyAdapters = useCallback((items: AdapterInfo[]) => {
    const ordered = orderAdapters(items);
    const preferred = window.localStorage.getItem(PREFERRED_ADAPTER_KEY) ?? "";
    setAdapters(ordered);
    setAdapter(ordered.some((item) => item.name === preferred) ? preferred : ordered[0]?.name ?? "");
  }, []);

  const autoScan = useCallback(async () => {
    const preferred = window.localStorage.getItem(PREFERRED_ADAPTER_KEY) ?? "";
    const result = await run(() => bridgeRequest<AutoScanResult>("auto_scan", { preferred_adapter: preferred }));
    if (!result) return;

    const ordered = orderAdapters(result.adapters);
    const selected = result.selected_adapter || preferred;
    setAdapters(ordered);
    setAdapter(ordered.some((item) => item.name === selected) ? selected : ordered[0]?.name ?? "");
    if (result.connected && result.slaves.length) {
      if (result.selected_adapter) window.localStorage.setItem(PREFERRED_ADAPTER_KEY, result.selected_adapter);
      const adapterName = result.adapters.find((item) => item.name === result.selected_adapter)?.description
        || result.selected_adapter;
      setMessage({ text: `已在 ${adapterName} 上发现 ${result.slaves.length} 个从站`, severity: "success" });
      return;
    }

    if (!result.adapters.length) {
      setMessage({ text: "未枚举到网卡：pySOEM 没有返回可用适配器。请检查 Npcap、WinPcap 兼容模式和网卡驱动。", severity: "error" });
      return;
    }
    const failed = result.attempts.filter((attempt) => attempt.error);
    const openedWithoutSlaves = result.attempts.filter((attempt) => !attempt.error && attempt.slave_count === 0);
    if (failed.length && failed.length === result.attempts.length) {
      setMessage({ text: `已枚举到 ${result.adapters.length} 个网卡，但全部无法打开：${failed[0].error}`, severity: "error" });
    } else if (openedWithoutSlaves.length) {
      setMessage({ text: `网卡已打开并完成 EtherCAT 探测，但没有从站响应。请检查专用网线、链路和从站供电；另有 ${failed.length} 个网卡打开失败。`, severity: "info" });
    } else {
      setMessage({ text: `自动扫描未发现从站：已尝试 ${result.attempts.length} 个网卡。请检查 Npcap 权限、链路和从站供电。`, severity: "info" });
    }
  }, [run]);

  useEffect(() => {
    const disableBrowserContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", disableBrowserContextMenu);
    return () => document.removeEventListener("contextmenu", disableBrowserContextMenu);
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let bootstrapInFlight = false;
    let bootstrapPending = false;
    let bootstrappedGeneration: number | undefined;
    const bootstrap = async () => {
      if (!active || bootstrappedGeneration !== undefined) return;
      if (bootstrapInFlight) {
        bootstrapPending = true;
        return;
      }
      bootstrapInFlight = true;
      try {
        const current = await bridgeRequest<WorkbenchStatus>("status");
        const items = await bridgeRequest<AdapterInfo[]>("enumerate_adapters");
        if (!active) return;
        applyAdapters(items);
        bootstrappedGeneration = current.host_generation;
        bootstrapPending = false;
        if (!current.connected && !startupScanAttempted.current) {
          startupScanAttempted.current = true;
          await autoScan();
        }
      } catch (error) {
        if (!active) return;
        const text = error instanceof Error ? error.message : String(error);
        if (/Python EtherCAT|桥接通信|桥接进程/.test(text)) {
          setBridgeAvailable(false);
          setSelectedPosition(undefined);
        }
        setMessage({ text, severity: "error" });
      } finally {
        bootstrapInFlight = false;
        if (active && bootstrapPending) {
          bootstrapPending = false;
          void bootstrap();
        }
      }
    };
    const eventReady = onBridgeEvent((event: BridgeEvent) => {
      if (["ready", "host_ready"].includes(event.kind)) {
        setBridgeAvailable(true);
        setBridgeExit(undefined);
        setMessage((current) => current?.text.includes("通信核心") ? undefined : current);
        const generation = event.host_generation
          ?? (event.data as { host_generation?: number } | undefined)?.host_generation;
        if (generation !== undefined && generation !== bootstrappedGeneration) bootstrappedGeneration = undefined;
        void bootstrap();
      }
      if (event.kind === "host_restart_failed") {
        const data = event.data as { message?: string };
        setBridgeAvailable(false);
        setMessage({ text: `通信核心启动失败：${data.message ?? "未知错误"}；监督器将在后台重试。`, severity: "error" });
      }
      if (event.kind === "heartbeat") {
        // Heartbeat is telemetry only. Command responses and bus_snapshot events
        // are the authoritative source of EtherCAT session and state.
      }
      if (event.kind === "cycle_fault") setMessage({ text: cycleFaultMessage(event.data), severity: "error" });
      if (event.kind === "worker_fatal") {
        const text = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
        setBridgeAvailable(false);
        operationStore.invalidate("WORKER_FATAL", text);
        setSelectedPosition(undefined);
        setSnapshot(undefined);
        setRegisterProfileOverrides({});
        setProgress((previous) => previous && previous.percent < 100 ? { ...previous, completed: previous.total, percent: 100, stage: "通信 Worker 已停止", detail: text, tone: "error", cancellable: false } : previous);
        setMessage({ text: `EtherCAT Worker 无法启动或已停止：${text}`, severity: "error" });
      }
      if (event.kind === "process_data") setSnapshot(event.data as Snapshot);
      if (event.kind === "progress") {
        const next = event.data as OperationProgress;
        const fraction = next.total > 0 ? Math.min(1, next.completed / next.total) : 0;
        const ranges: Record<string, [number, number]> = {
          "prepare-init": [0, 5], "read-current": [5, 20], "write-verify": [20, 65], "stability-wait": [65, 75],
          "full-verify": [75, 95], reset: [95, 97], "reload-verify": [97, 100],
        };
        const range = ranges[next.stage];
        const calculated = Math.round(range ? range[0] + (range[1] - range[0]) * fraction : fraction * 100);
        const labels: Record<string, string> = {
          read: "完整读取", "backup-read": "读取并保存 BIN", "prepare-init": "自动切换 INIT", "read-current": "读取当前 EEPROM",
          "write-verify": "写入并校验", "stability-wait": "等待 EEPROM 稳定",
          "full-verify": "完整回读校验", reset: "复位并重新发现", "reload-verify": "复位后重新加载复核",
        };
        setProgress((previous) => {
          if (previous?.percent === 100 && previous.tone !== "info") return previous;
          return { ...next, stage: labels[next.stage] ?? next.stage, percent: Math.max(previous?.percent ?? 0, calculated), tone: "info" };
        });
      }
      if (event.kind === "error") setMessage({ text: event.data instanceof Error ? event.data.message : typeof event.data === "string" ? event.data : JSON.stringify(event.data), severity: "error" });
    }).then((value) => { if (active) unlisten = value; else value(); });
    const exitReady = onBridgeExited((info) => {
      if (!active) return;
      setBridgeAvailable(false);
      setBridgeExit(info);
      operationStore.invalidate("PROCESS_EXITED", info.message);
      setProgress((previous) => previous && previous.percent < 100 ? {
        ...previous,
        completed: previous.total,
        percent: 100,
        stage: "通信核心已退出",
        detail: info.last_method ? `${info.message}；最后操作：${info.last_method}` : info.message,
        tone: "error",
        cancellable: false,
      } : previous);
      setSelectedPosition(undefined);
      setSnapshot(undefined);
      setRegisterProfileOverrides({});
      const detail = info.stderr_tail?.trim().split(/\r?\n/).at(-1);
      setMessage({ text: `${info.message}${detail ? `：${detail}` : ""}。通信核心将以未连接状态重建；写操作结果未知时请先重新读取设备。`, severity: "error" });
    }).then((value) => { if (active) unlistenExit = value; else value(); });
    Promise.all([eventReady, exitReady]).then(() => { if (active) bootstrap(); });
    return () => { active = false; unlisten?.(); unlistenExit?.(); };
  }, [applyAdapters, autoScan]);

  const connect = async () => {
    if (status.connected) await run(() => bridgeRequest("disconnect"), "已断开网卡");
    else await run(() => bridgeRequest("connect", { adapter }), "网卡已连接");
  };
  const scan = async () => {
    const found = await run(() => bridgeRequest<SlaveInfo[]>("scan"));
    if (found) setMessage({ text: found.length ? `扫描完成，发现 ${found.length} 个从站` : "扫描完成，但未发现从站。请检查网卡、链路和从站供电。", severity: found.length ? "success" : "info" });
  };
  const requestBusState = (state: number) => run(
    () => bridgeRequest<SlaveInfo[]>("request_state", { position: 0, state }),
    `全部 ${status.slaves.length} 个从站已进入 ${stateLabel(state)}`,
  );
  const switchMode = async (demo: boolean) => {
    const mode = demo ? "demo" : "real";
    const changed = await run(() => bridgeRequest("switch_mode", { mode }), demo ? "已切换到 Demo 模式" : "已切换到实际设备");
    if (changed) {
      const items = await bridgeRequest<AdapterInfo[]>("enumerate_adapters");
      const ordered = orderAdapters(items);
      const preferred = window.localStorage.getItem(PREFERRED_ADAPTER_KEY) ?? "";
      setAdapters(ordered);
      setAdapter(ordered.some((item) => item.name === preferred) ? preferred : ordered[0]?.name ?? "");
    }
  };

  const selectAdapter = (value: string) => {
    setAdapter(value);
    window.localStorage.setItem(PREFERRED_ADAPTER_KEY, value);
  };

  const navigate = useCallback((nextPage: PageKey) => {
    if (nextPage === page) return;
    // Advance before rendering the target page so its initial bridge calls are
    // born into the new page generation instead of being cancelled immediately.
    operationStore.nextPage();
    setPage(nextPage);
  }, [page]);
  const setSelectedEepromReadResult = useCallback((value?: EepromReadResult) => {
    if (value) setEepromReadCache((current) => ({ ...current, [eepromReadCacheKey]: value }));
  }, [eepromReadCacheKey]);
  const consumeEepromDetailSelection = useCallback(() => setEepromDetailSelection(undefined), []);

  const openSlaveContextMenu = (event: ReactMouseEvent, position: number) => {
    event.preventDefault();
    setSelectedPosition(position);
    setSlaveContextMenu({ mouseX: event.clientX + 2, mouseY: event.clientY - 6, position });
  };

  const openSlaveEeprom = () => {
    if (slaveContextMenu) setSelectedPosition(slaveContextMenu.position);
    setSlaveContextMenu(undefined);
    setQuickFlashOpen(true);
  };

  const visit = (url: string) => {
    openExternal(url).catch((error) => setMessage({
      text: error instanceof Error ? error.message : String(error),
      severity: "error",
    }));
  };

  const content = useMemo(() => {
    const props = { slave, run };
    if (page === "overview") return <OverviewPage {...props} status={status} busy={busy} slaves={status.slaves} refresh={refreshStates} registerProfile={registerProfile} alLanguage={alLanguage} onRegisterProfileChange={(profile) => slave && setRegisterProfileOverrides((current) => ({ ...current, [selectedSlaveKey]: profile }))} />;
    if (page === "registers") return <RegistersPage {...props} registerProfile={registerProfile} />;
    return <EepromPage {...props} status={status} progress={progress} setProgress={setProgress} readResult={eepromReadCache[eepromReadCacheKey]} setReadResult={setSelectedEepromReadResult} initialSelection={eepromDetailSelection} onInitialSelectionConsumed={consumeEepromDetailSelection} autoResetEsc={eepromAutoReset} fileDropEnabled={!quickFlashOpen} />;
  }, [page, registerProfile, selectedSlaveKey, selectedPosition, slave, status, snapshot, progress, refreshStates, run, busy, alLanguage, eepromAutoReset, quickFlashOpen, eepromReadCache, eepromReadCacheKey, eepromDetailSelection, setSelectedEepromReadResult, consumeEepromDetailSelection]);

  return <Box sx={{ display: "flex", height: "100vh", bgcolor: "background.default" }}>
    <Drawer variant="permanent" PaperProps={{ sx: { width: 56, borderRight: 1, borderColor: "divider", bgcolor: "#FBFCFE", overflow: "hidden" } }}>
      <Toolbar sx={{ minHeight: "54px !important", px: "10px !important", gap: 0.75 }}>
        <Box sx={{ width: 34, height: 34, borderRadius: 1.2, bgcolor: "primary.main", color: "white", display: "grid", placeItems: "center", flexShrink: 0 }}><CableRounded fontSize="small" /></Box>
      </Toolbar>
      <Divider />
      <List sx={{ px: 0.6, pt: 0.3 }}>{pages.map((item) => <Tooltip key={item.key} title={item.label} placement="right"><span><ListItemButton aria-label={item.label} disabled={eepromExclusive && item.key !== "eeprom"} selected={page === item.key} onClick={() => navigate(item.key)} key={item.key} sx={{ minHeight: 36, mb: 0.3, px: 0.85 }}><ListItemIcon sx={{ minWidth: 28 }}>{item.icon}</ListItemIcon></ListItemButton></span></Tooltip>)}</List>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <List sx={{ p: 0.6 }}><Tooltip title={"设置"} placement="right"><ListItemButton aria-label="设置" onClick={() => { setSettingsTab(0); setSettings(true); }} sx={{ minHeight: 36, px: 0.85 }}><ListItemIcon sx={{ minWidth: 28 }}><SettingsRounded /></ListItemIcon></ListItemButton></Tooltip></List>
    </Drawer>
    <Box sx={{ ml: "56px", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <AppBar className="workbench-toolbar" position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider", bgcolor: "rgba(255,255,255,.96)" }}>
        <Toolbar sx={{ minHeight: "54px !important", columnGap: 0.65, rowGap: 0.65, px: "10px !important", py: 0.45, flexWrap: "wrap", alignContent: "center" }}>
          <Stack sx={{ width: 170, minWidth: 0, flexShrink: 0 }} spacing={0.15}>
            <Stack direction="row" gap={0.6} alignItems="center" flexWrap="wrap">
              <Chip size="small" color={!bridgeAvailable ? "error" : status.connected ? "success" : "default"} variant={status.connected ? "filled" : "outlined"} label={!bridgeAvailable ? "通信核心不可用" : status.connected ? "已连接" : "未连接"} />
              {status.mode === "demo" && <Chip size="small" color="warning" label="Demo" />}
              {previewMode && <Chip size="small" variant="outlined" label="预览" />}
            </Stack>
            <Typography variant="caption" color="text.secondary" noWrap>{!bridgeAvailable ? "通信核心正在恢复" : status.connected ? `已发现 ${status.slaves.length} 个从站` : "检测网卡并自动扫描 EtherCAT 从站"}</Typography>
          </Stack>
          {status.slaves.length !== 1 && <Box sx={{ pl: 1, borderLeft: 1, borderColor: "divider", flexShrink: 0 }}>
            <Tooltip title={busStateBlockedReason || `全部从站状态控制 · 当前 ${busState === undefined ? "无状态" : stateLabel(busState)}`}>
              <span>
                <ButtonGroup size="small" aria-label="全部从站状态控制" disabled={Boolean(busStateBlockedReason)} sx={{ height: 28 }}>
                  {controllableStates.map((state) => <Button key={state} variant={busState === state ? "contained" : "outlined"} onClick={() => void requestBusState(state)} sx={{ minWidth: state === 1 || state === 8 ? 42 : 58, px: 0.8, py: 0.2, fontSize: 11.5, whiteSpace: "nowrap" }}>{stateLabel(state)}</Button>)}
                </ButtonGroup>
              </span>
            </Tooltip>
          </Box>}
          <Box sx={{ display: "flex", alignItems: "center", alignContent: "center", justifyContent: "flex-end", flex: "0 1 auto", minWidth: 0, ml: "auto", flexWrap: "wrap", gap: 0.65 }}>
            <FormControl size="small" sx={{ width: 270, minWidth: 170 }}><Select displayEmpty inputProps={{ "aria-label": "网卡" }} value={adapter} disabled={!bridgeAvailable || eepromExclusive || status.connected || busy} onChange={(e) => selectAdapter(e.target.value)}>{adapters.map((item) => <MenuItem value={item.name} key={item.name}>{item.description || item.name}</MenuItem>)}</Select></FormControl>
            <Button size="small" variant={status.connected ? "outlined" : "contained"} color={status.connected ? "error" : "primary"} startIcon={<UsbRounded />} disabled={!bridgeAvailable || eepromExclusive || busy || (!status.connected && !adapter)} onClick={connect} sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>{status.connected ? "断开" : "连接"}</Button>
            <Button size="small" variant="outlined" startIcon={<RefreshRounded />} disabled={!bridgeAvailable || eepromExclusive || busy || !status.connected || status.cycle_running} onClick={scan} sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>扫描</Button>
            {busy && <CircularProgress size={20} sx={{ mx: 0.5 }} />}
          </Box>
        </Toolbar>
      </AppBar>
      <Box sx={{ display: "flex", minHeight: 0, flex: 1 }}>
        {status.slaves.length > 1 && slaveListExpanded && <Box component="aside" sx={{ width: { xs: 210, xl: 224 }, flexShrink: 0, bgcolor: "background.paper", borderRight: 1, borderColor: "divider", overflow: "auto", p: 0.75 }}><Stack direction="row" justifyContent="space-between" alignItems="center" gap={0.5} sx={{ px: 0.75, py: 0.55 }}><Typography variant="overline" color="text.secondary" sx={{ flexShrink: 0 }}>从站 · {status.slaves.length}</Typography><Stack direction="row" alignItems="center" gap={0.45} minWidth={0}><StateChip state={busState!} /><Chip size="small" variant="outlined" label={status.cycle_running ? "周期运行" : "周期停止"} /></Stack></Stack><List dense sx={{ pt: 0.35 }}>{status.slaves.map((item) => <ListItemButton disabled={eepromExclusive} key={item.position} selected={item.position === selectedPosition} onClick={() => setSelectedPosition(item.position)} onContextMenu={(event) => openSlaveContextMenu(event, item.position)} sx={{ mb: 0.25, py: 0.55, px: 0.75 }}><ListItemIcon sx={{ minWidth: 30 }}><DeveloperBoardRounded fontSize="small" color={item.state === 8 ? "success" : "action"} /></ListItemIcon><ListItemText primary={`${item.position}. ${item.name}`} secondary={`${stateLabel(item.state)}${(item.raw_state ?? item.state) & 0x10 ? " + ERROR" : ""} · ${item.input_size ?? "—"}/${item.output_size ?? "—"} B · ${item.chip_model}`} primaryTypographyProps={{ noWrap: true, fontWeight: 650, fontSize: 12.5 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11.5 }} /></ListItemButton>)}</List></Box>}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {slave && <Stack direction="row" alignItems="center" gap={1} sx={{ px: 2, py: page === "overview" ? 1.5 : 0.75, borderBottom: page === "overview" ? 0 : 1, borderColor: "divider", bgcolor: page === "overview" ? "background.default" : "background.paper" }}>
            {page === "overview" && <Typography variant="h5" fontWeight={750} sx={{ mr: 1 }}>设备概览</Typography>}
            {status.slaves.length > 1 && <Tooltip title={slaveListExpanded ? "收起从站列表" : "展开从站列表"}><IconButton size="small" aria-label={slaveListExpanded ? "收起从站列表" : "展开从站列表"} onClick={() => setSlaveListExpanded((value) => !value)}>{slaveListExpanded ? <ChevronLeftRounded /> : <MenuRounded />}</IconButton></Tooltip>}
            <Typography variant="body2" fontWeight={650} noWrap onContextMenu={(event) => openSlaveContextMenu(event, slave.position)} sx={{ minWidth: 0 }} title={slave.name}>从站 {slave.position} · {slave.name}</Typography>
            <StateChip state={slave.state} error={Boolean((slave.raw_state ?? slave.state) & 0x10)} />
            <Chip size="small" variant="outlined" label={status.cycle_running ? "周期运行" : "周期停止"} />
            {page === "overview" && <Button size="small" sx={{ ml: "auto" }} disabled={busy} startIcon={<RefreshRounded />} onClick={() => run(refreshStates)}>刷新状态</Button>}
          </Stack>}
        <Box component="main" sx={{ flex: 1, minWidth: 0, overflow: "auto", p: { xs: 1.5, xl: 2 } }}><Box sx={{ width: "100%", maxWidth: 1840, mx: "auto" }}>{bridgeExit && <Alert severity="error" action={bridgeExit.log_path ? <Button color="inherit" size="small" onClick={() => revealPath(bridgeExit.log_path!)}>打开日志</Button> : undefined} sx={{ mb: 1.25 }}><Typography fontWeight={700}>通信核心已退出</Typography><Typography variant="body2">{bridgeExit.message}</Typography>{bridgeExit.log_path && <Typography variant="caption" className="mono" sx={{ overflowWrap: "anywhere" }}>日志：{bridgeExit.log_path}</Typography>}</Alert>}{content}</Box></Box>
        </Box>
      </Box>
    </Box>
    <Menu
      open={Boolean(slaveContextMenu)}
      onClose={() => setSlaveContextMenu(undefined)}
      anchorReference="anchorPosition"
      anchorPosition={slaveContextMenu ? { top: slaveContextMenu.mouseY, left: slaveContextMenu.mouseX } : undefined}
      slotProps={{ paper: { sx: { minWidth: 210, border: 1, borderColor: "divider", boxShadow: "0 10px 30px rgba(23,32,51,.16)" } } }}
    >
      <MenuItem onClick={openSlaveEeprom}>
        <ListItemIcon><MemoryRounded fontSize="small" color="warning" /></ListItemIcon>
        <ListItemText primary="烧录 EEPROM" />
      </MenuItem>
    </Menu>
    <QuickEepromFlashDialog open={quickFlashOpen} slave={slave} status={status} progress={progress} autoResetEsc={eepromAutoReset} setProgress={setProgress} onClose={() => setQuickFlashOpen(false)} onOpenDetails={(selection) => { setQuickFlashOpen(false); setEepromDetailSelection(selection); navigate("eeprom"); }} />
    <Dialog open={settings} onClose={() => setSettings(false)} fullWidth maxWidth="sm">
      <DialogTitle sx={{ pb: 1 }}>设置</DialogTitle>
      <Tabs value={settingsTab} onChange={(_, value) => setSettingsTab(value)} sx={{ px: 2.5, minHeight: 42 }}>
        <Tab icon={<SettingsRounded fontSize="small" />} iconPosition="start" label="通用" sx={{ minHeight: 42 }} />
        <Tab icon={<InfoOutlineRounded fontSize="small" />} iconPosition="start" label="关于" sx={{ minHeight: 42 }} />
      </Tabs>
      <Divider />
      <DialogContent sx={{ minHeight: 360 }}>
        {settingsTab === 0 ? <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}>
            <Box><Typography fontWeight={700}>Demo 模式</Typography><Typography variant="body2" color="text.secondary">使用模拟从站，不访问实际 EtherCAT 网卡。</Typography></Box>
            <Switch checked={status.mode === "demo"} disabled={!bridgeAvailable || eepromExclusive || status.connected} onChange={(e) => switchMode(e.target.checked)} />
          </Box>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>AL 状态码语言</Typography><Typography variant="body2" color="text.secondary">切换概览页 AL 状态名称、说明与排查建议。</Typography></Box><FormControl size="small" sx={{ width: 150 }}><InputLabel>Language</InputLabel><Select label="Language" value={alLanguage} onChange={(event) => { const value = event.target.value as AlStatusLanguage; setAlLanguage(value); window.localStorage.setItem(AL_LANGUAGE_KEY, value); }}><MenuItem value="zh">中文</MenuItem><MenuItem value="en">English</MenuItem></Select></FormControl></Box>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>EEPROM 写入后复位 ESC</Typography><Typography variant="body2" color="text.secondary">用于 XML 烧录和 BIN 恢复；关闭后仍会完整回读校验，但不执行 ESC RES 复位、重新发现和重新加载复核。</Typography></Box><Switch checked={eepromAutoReset} disabled={eepromExclusive} onChange={(event) => setEepromAutoReset(saveEepromAutoReset(event.target.checked))} /></Box>
          {status.connected && <Alert severity="info">切换模式前请停止周期通信并断开网卡。</Alert>}
        </Stack> : <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "#F8FAFF" }}>
            <Box sx={{ width: 52, height: 52, borderRadius: 1.5, bgcolor: "primary.main", color: "white", display: "grid", placeItems: "center", flexShrink: 0 }}><CableRounded /></Box>
            <Box sx={{ minWidth: 0, flex: 1 }}><Stack direction="row" alignItems="center" gap={1}><Typography variant="h6">EtherCAT Workbench</Typography><Chip size="small" variant="outlined" label={`v${packageInfo.version}`} /></Stack><Typography variant="body2" color="text.secondary">面向 Windows 的 EtherCAT 从站调试与诊断工作台</Typography></Box>
          </Box>
          <Typography variant="body2" color="text.secondary">聚焦从站概览、ESC 标准寄存器诊断与 EEPROM 安全读取、备份、烧录和恢复。硬件通信由独立 Python Bridge 与 Worker 串行执行。</Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1.2 }}>
            {[["版本", packageInfo.version], ["通信核心", "pySOEM 1.1.13"], ["许可证", "PolyForm NC 1.0"]].map(([label, value]) => <Box key={label} sx={{ p: 1.4, border: 1, borderColor: "divider", borderRadius: 1 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" fontWeight={700} sx={{ mt: 0.3 }}>{value}</Typography></Box>)}
          </Box>
          <Divider />
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button variant="contained" startIcon={<GitHubIcon />} endIcon={<OpenInNewRounded fontSize="small" />} onClick={() => visit(PROJECT_URL)}>GitHub 项目</Button>
            <Button variant="outlined" startIcon={<BugReportRounded />} endIcon={<OpenInNewRounded fontSize="small" />} onClick={() => visit(ISSUES_URL)}>问题反馈</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">Copyright © EtherCAT Workbench contributors</Typography>
        </Stack>}
      </DialogContent>
      <DialogActions><Button onClick={() => setSettings(false)}>完成</Button></DialogActions>
    </Dialog>
    <Snackbar open={Boolean(progress && !isEepromOperation(progress.operation))} autoHideDuration={progress?.percent === 100 ? 6000 : null} onClose={(_, reason) => { if (reason !== "clickaway" && progress?.percent === 100) setProgress(undefined); }} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}>
      <Alert severity={progress?.tone === "error" ? "error" : progress?.tone === "success" ? "success" : "info"} variant="filled" action={progress && progress.percent < 100 && progress.cancellable !== false ? <Button color="inherit" size="small" onClick={() => bridgeRequest("cancel")}>取消</Button> : undefined} sx={{ width: 440, alignItems: "center" }}>
        <Typography fontWeight={750}>{progress?.stage}</Typography><Typography variant="body2">{progress?.detail}</Typography>{progress && <LinearProgress color="inherit" variant="determinate" value={progress.percent} sx={{ mt: 1, height: 5, borderRadius: 8, bgcolor: "rgba(255,255,255,.25)" }} />}
      </Alert>
    </Snackbar>
    <Snackbar open={Boolean(message)} autoHideDuration={5000} onClose={() => setMessage(undefined)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }}><Alert severity={message?.severity} variant="filled" onClose={() => setMessage(undefined)}>{message?.text}</Alert></Snackbar>
  </Box>;
}
