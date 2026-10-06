import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AppBar,
  Box,
  Button,
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
  CloseRounded,
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
import { RegistersPage } from "./RegistersPage";
import { OverviewEeprom } from "./OverviewEeprom";
import { CardHeading } from "./OverviewDisclosure";
import { EscHardwareCard } from "./EscHardwareCard";
import { alStatusInfo, type AlStatusLanguage } from "./alStatus";
import { BridgeRequestError, bridgeRequest, onBridgeEvent, onBridgeExited, onFileDrop, openExternal, pickDirectory, pickFile, previewMode, revealPath, subscribeBusSnapshot, type AdapterInfo } from "./api";
import { minimumBusState } from "./busState";
import { operationStore } from "./operationStore";
import { decodeConfigData, isBinFile, loadEepromAutoReset, normalizeConfigData, saveEepromAutoReset, type EepromBinTarget } from "./eepromConfig";
import { QuickEepromFlashDialog, type EepromDetailSelection, type EepromProgressState } from "./QuickEepromFlashDialog";
import type {
  BridgeEvent,
  BridgeExitInfo,
  EsiDevice,
  OperationProgress,
  PdoEntry,
  SlaveInfo,
  AutoScanResult,
  WorkbenchStatus,
} from "./types";
import { hex, stateLabel } from "./types";
import { checkForUpdate, type AvailableUpdate } from "./updater";

const appIconUrl = new URL("../src-tauri/icons/icon.png", import.meta.url).href;
const brandIconUrl = new URL("./assets/BenchCAT.png", import.meta.url).href;

type PageKey = "overview" | "registers" | "eeprom";
type Run = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;
const PREFERRED_ADAPTER_KEY = "benchcat.preferred-adapter";
const RECENT_ESI_KEY = "benchcat.recent-esi";
const AL_LANGUAGE_KEY = "benchcat.al-language";
const AUTO_UPDATE_KEY = "benchcat.auto-check-updates";
const IGNORED_UPDATE_KEY = "benchcat.ignored-update-version";
const PROJECT_URL = "https://github.com/LINLin190/BenchCAT";
const DOWNLOAD_URL = `${PROJECT_URL}/releases/latest`;
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

function slaveDisplayName(slave: SlaveInfo): string {
  return slave.product_model || slave.name;
}

function esiDeviceDisplayName(device: EsiDevice): string {
  return device.type_name || device.name;
}

function isEepromOperation(operation?: string): boolean {
  return Boolean(operation?.startsWith("eeprom"));
}

function cycleFaultMessage(_data: unknown): string {
  return "周期通信已中断，无法继续交换数据。请刷新从站状态后再操作。";
}

function defaultRegisterProfile(chipModel: string | undefined): string {
  if (chipModel === "LAN9252" || chipModel === "E252") return "LAN9252";
  if (chipModel === "LAN9253" || chipModel === "E253") return "LAN9253";
  return "ET1100";
}

function escModelLabel(chipModel: string | undefined, profile: string): string {
  return chipModel === "E252" && profile === "LAN9252" ? "E252" : profile;
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

type UpdateState = "idle" | "checking" | "available" | "preparing" | "downloading" | "installing" | "latest" | "error";
type UpdateStage = "checking" | "preparing" | "downloading" | "installing";
interface UpdateFailure { stage: UpdateStage; message: string }
const UPDATE_STAGE_LABELS: Record<UpdateStage, string> = {
  checking: "检查更新",
  preparing: "准备更新",
  downloading: "下载更新",
  installing: "准备安装",
};
const UPDATE_ERROR_LABELS: Record<UpdateStage, string> = {
  checking: "检查更新失败",
  preparing: "准备更新失败",
  downloading: "下载更新失败",
  installing: "安装启动失败",
};

function isUpdateInProgress(state: UpdateState): state is "preparing" | "downloading" | "installing" {
  return state === "preparing" || state === "downloading" || state === "installing";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function UpdateDialog({
  open,
  state,
  update,
  progress,
  blockedReason,
  error,
  onClose,
  onIgnore,
  onInstall,
  onRetry,
  onDownloadPage,
}: {
  open: boolean;
  state: UpdateState;
  update?: AvailableUpdate;
  progress: { downloaded: number; total: number };
  blockedReason: string;
  error?: UpdateFailure;
  onClose: () => void;
  onIgnore: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onDownloadPage: () => void;
}) {
  const downloading = state === "downloading";
  const updating = isUpdateInProgress(state);
  const percentage = progress.total > 0
    ? Math.min(100, Math.round(progress.downloaded / progress.total * 100))
    : undefined;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="update-dialog-title">
      <DialogTitle id="update-dialog-title" sx={{ pr: 7 }}>
        {updating ? "正在更新软件" : state === "error" ? "在线更新未完成" : state === "checking" ? "正在检查更新" : "发现新版本"}
        <IconButton aria-label={updating ? "后台运行" : "关闭更新弹窗"} onClick={onClose} sx={{ position: "absolute", right: 12, top: 12 }}><CloseRounded /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          {update && <Typography fontWeight={700}>当前 v{packageInfo.version} → 新版本 v{update.version}</Typography>}
          {!updating && update?.date && Number.isFinite(Date.parse(update.date)) && <Typography variant="body2" color="text.secondary">发布时间：{new Date(update.date).toLocaleString("zh-CN")}</Typography>}
          {!updating && update && <Box sx={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", p: 1.5, bgcolor: "action.hover", borderRadius: 1 }}>{update.notes?.trim() || "此版本未提供更新说明。"}</Box>}
          {(updating || state === "checking") && <>
            <Typography role="status" variant="body2">{UPDATE_STAGE_LABELS[state]}{state === "installing" ? "，随后由 Windows 安装器接管…" : "…"}</Typography>
            <LinearProgress aria-label={UPDATE_STAGE_LABELS[state]} variant={downloading && percentage !== undefined ? "determinate" : "indeterminate"} value={downloading ? percentage : undefined} />
          </>}
          {downloading && <>
            <Stack direction="row" justifyContent="space-between" gap={2}>
              <Typography variant="body2" color="text.secondary">已下载 {formatBytes(progress.downloaded)}{progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""}</Typography>
              {percentage !== undefined && <Typography variant="body2" color="text.secondary">{percentage}%</Typography>}
            </Stack>
          </>}
          {blockedReason && !updating && <Alert severity="info">{blockedReason}</Alert>}
          {state === "error" && error && <Alert severity="warning" sx={{ overflowWrap: "anywhere" }}>{UPDATE_ERROR_LABELS[error.stage]}：{error.message}</Alert>}
        </Stack>
      </DialogContent>
      <Box sx={{ px: 3, pt: 1.5 }}>
        <Typography variant="caption" color="text.secondary">{updating
          ? "关闭此弹窗后继续更新，请保持软件运行；安装时软件将退出并自动重新启动。"
          : "更新会停止通信并断开设备，安装时软件将自动重启。忽略本次更新仅关闭该版本的自动提醒。"}</Typography>
      </Box>
      <DialogActions sx={{ px: 3, pb: 2, pt: 1.5, gap: 0.5 }}>
        {state === "available" && <Button onClick={onIgnore} sx={{ mr: "auto" }}>忽略本次更新</Button>}
        {state === "error" && <Button onClick={onDownloadPage} sx={{ mr: "auto" }}>打开下载页面</Button>}
        <Button onClick={onClose}>{updating ? "后台运行" : state === "available" ? "取消" : "关闭"}</Button>
        {state === "available" && <Button variant="contained" disabled={Boolean(blockedReason) || !update} onClick={onInstall}>立即更新</Button>}
        {state === "error" && <Button variant="contained" disabled={error?.stage !== "checking" && Boolean(blockedReason)} onClick={onRetry}>{error?.stage === "checking" ? "重新检查" : "重试更新"}</Button>}
      </DialogActions>
    </Dialog>
  );
}

function StateSelector({ state, disabled, onRequest, label, className = "" }: {
  state?: number;
  disabled: boolean;
  onRequest: (state: number) => Promise<unknown>;
  label: string;
  className?: string;
}) {
  const [pendingState, setPendingState] = useState<number>();
  const requesting = useRef(false);
  const [requestRunning, setRequestRunning] = useState(false);
  const displayedState = pendingState ?? state;
  const selectedIndex = controllableStates.indexOf(displayedState ?? 0);
  useEffect(() => {
    if (pendingState === undefined) return;
    const timer = window.setTimeout(() => setPendingState(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [pendingState]);
  useEffect(() => {
    if (pendingState !== undefined && state === pendingState) setPendingState(undefined);
  }, [state, pendingState]);
  const request = async (target: number) => {
    if (disabled || requesting.current) return;
    requesting.current = true;
    setRequestRunning(true);
    setPendingState(target);
    try {
      await onRequest(target);
    } finally {
      requesting.current = false;
      setRequestRunning(false);
    }
  };
  return <Box role="group" aria-label={label} aria-busy={requestRunning} className={`state-selector ${className}`} sx={{ bgcolor: "action.hover", borderColor: "divider" }}>
    <Box aria-hidden="true" className="state-selector-thumb" sx={{ bgcolor: "primary.main", opacity: selectedIndex < 0 ? 0 : 1, transform: `translateX(${Math.max(0, selectedIndex) * 100}%)` }} />
    {controllableStates.map((target) => <Button key={target} size="small" disableRipple aria-pressed={displayedState === target} disabled={disabled || requestRunning || pendingState !== undefined} className={pendingState === target ? "state-selector-pending" : undefined} sx={{ color: displayedState === target ? "primary.contrastText" : "text.secondary", "&.Mui-disabled": { color: displayedState === target ? "primary.contrastText" : "text.secondary" } }} onClick={() => void request(target)}>{stateLabel(target)}</Button>)}
  </Box>;
}

function OverviewPage({ slave, status, busy, stateRequestBusy, run, refresh, registerProfile, onRegisterProfileChange, alLanguage }: { slave?: SlaveInfo; status: WorkbenchStatus; busy: boolean; stateRequestBusy: boolean; run: Run; refresh: () => Promise<void>; registerProfile: string; onRegisterProfileChange: (profile: string) => void; alLanguage: AlStatusLanguage }) {
  const [switchingProfile, setSwitchingProfile] = useState<string>();
  const requestState = (state: number) => run(
    () => bridgeRequest<SlaveInfo[]>("request_state", { position: slave?.position ?? 0, state }),
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
        `从站 ${slave.position} 已完成重配置，ESC 型号切换为 ${escModelLabel(slave.chip_model, profile)}`,
      );
      if (result) onRegisterProfileChange(profile);
    } finally {
      setSwitchingProfile(undefined);
    }
  };
  const alInfo = alStatusInfo(slave?.al_status ?? 0, alLanguage);
  return (
    <>
      {!slave && <PageTitle title="设备概览" subtitle="总线状态与设备信息" actions={<Button disabled={busy} startIcon={<RefreshRounded className={busy ? "operation-icon-spinning" : undefined} />} onClick={() => run(refresh)}>刷新状态</Button>} />}
      {!slave ? <EmptyState text="连接并扫描后，在左侧选择一个从站" /> : (
        <Stack spacing={1.25} className="overview-cards">
          {Boolean(slave.scan_errors?.length) && <Alert severity="warning">部分设备信息未能读取，可重新扫描。</Alert>}
          <Box className="overview-grid">
            <Card sx={cardSx} className="ov-runtime"><CardContent className="ov-card-body">
              <CardHeading title="状态" />
              <Box className="ov-runtime-facts">
                <Typography className="section-label">当前状态</Typography>
                {slave.state_error || slave.state === 0 ? <Chip size="small" label="—" /> : <StateChip state={slave.state} error={Boolean((slave.raw_state ?? slave.state) & 0x10)} />}
                <Typography className="section-label">AL 状态码</Typography>
                <Typography className="mono ov-strong">{slave.state_error ? "—" : `${hex(slave.al_status)} · ${alInfo.name}`}</Typography>
                <Typography className="ov-pdo-label">SM Size IN <b className="mono">{slave.input_size == null ? "—" : `${slave.input_size} B`}</b> OUT <b className="mono">{slave.output_size == null ? "—" : `${slave.output_size} B`}</b></Typography>
              </Box>
              <Box className="ov-runtime-actions">
                <Typography className="section-label">状态请求</Typography>
                <StateSelector key={`${status.session_id}:${slaveIdentityKey(slave)}`} state={slave.state} disabled={busy || stateRequestBusy} onRequest={requestState} label="从站状态请求" className="overview-state-buttons" />
                <Tooltip title={status.cycle_running ? "请先请求 SAFE-OP，再清除从站状态错误。" : "确认当前从站的状态错误，保持当前状态"}>
                  <span><Button className="overview-clear-error" size="small" variant="outlined" disabled={busy || status.cycle_running} onClick={() => run(() => bridgeRequest<SlaveInfo[]>("clear_error", { position: slave.position }), "已确认从站状态错误")}>Clear Error</Button></span>
                </Tooltip>
                <Tooltip title={status.cycle_running ? "请先请求 SAFE-OP；停止周期通信将影响整条总线。" : busy ? "操作进行中" : ""}>
                <Stack direction="row" gap={0.75} className="ov-repair-actions">
                  <Button disabled={busy || status.cycle_running} size="small" color="warning" variant="outlined" onClick={() => repair("reconfig", "重配置完成")}>重配置</Button>
                  <Button disabled={busy || status.cycle_running} size="small" color="warning" variant="outlined" onClick={() => repair("recover", "恢复并通过状态复核")}>故障恢复</Button>
                </Stack>
                </Tooltip>
              </Box>
            </CardContent></Card>

            <EscHardwareCard
              key={`${slave.position}-${registerProfile}`}
              slave={slave}
              profile={registerProfile}
              identity={<>
                <Typography className="ov-section-title">设备身份</Typography>
              <Box>
                <Box className="kv-identity"><Typography className="section-label">配置地址</Typography><Typography variant="body2" className="mono ov-strong">{slave.configured_address == null ? "—" : hex(slave.configured_address)}</Typography></Box>
                <Box className="kv-identity"><Typography className="section-label">厂商 ID</Typography><Typography variant="body2" className="mono ov-strong">{slave.identity_valid === false ? "未知" : hex(slave.identity.vendor_id, 8)}</Typography></Box>
                <Box className="kv-identity"><Typography className="section-label">{slave.product_type ? "产品类型" : "产品代码"}</Typography><Typography variant="body2" className="mono ov-strong">{slave.identity_valid === false ? "未知" : slave.product_type || hex(slave.identity.product_code, 8)}</Typography></Box>
                <Box className="kv-identity"><Typography className="section-label">{slave.product_model ? "产品型号" : "修订版本"}</Typography><Typography variant="body2" className="mono ov-strong">{slave.identity_valid === false ? "未知" : slave.product_model || hex(slave.identity.revision, 8)}</Typography></Box>
              </Box>
                <Divider sx={{ my: 1.5 }} />
              </>}
              modelControl={<Tooltip title={status.cycle_running ? "请先请求 SAFE-OP，再切换 ESC 型号；停止周期通信将影响整条总线。" : ""}><FormControl size="small" sx={{ width: 152, maxWidth: "100%" }}>
                <Select inputProps={{ "aria-label": "ESC 型号" }} value={registerProfile} onChange={(event) => void changeEscModel(String(event.target.value))} disabled={busy || status.cycle_running || Boolean(switchingProfile)}>
                  {registerProfiles.map((profile) => <MenuItem key={profile} value={profile}>{escModelLabel(slave.chip_model, profile)}</MenuItem>)}
                </Select>
              </FormControl></Tooltip>}
              modelNote={switchingProfile && <Typography variant="caption" color="text.secondary" className="ov-state-flow">
                {`正在应用 ${switchingProfile} 并重配置从站…`}
              </Typography>}
            />
            <OverviewEeprom key={`eeprom-${slave.position}`} slave={slave} profile={registerProfile} />
          </Box>
          {!slave.state_error && slave.al_status !== 0 && <Alert severity={alInfo.known ? "warning" : "error"}>
            <Typography fontWeight={700}>{hex(slave.al_status)} · {alInfo.name}</Typography>
            <Typography variant="body2">说明：{alInfo.detail}</Typography>
            <Typography variant="body2">排查：{alInfo.action}</Typography>
          </Alert>}

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
      <Card sx={cardSx}><CardContent><Typography variant="h6">输出数据</Typography><Stack direction="row" gap={1} sx={{ mt: 2 }}><TextField fullWidth size="small" label={`SM OUT · ${slave.output_size} B`} value={output} onChange={(e) => setOutput(e.target.value)} inputProps={{ className: "mono" }} /><Button variant="contained" disabled={!status.cycle_running || !slave.output_size || !output.trim()} onClick={() => run(() => bridgeRequest("set_output", { position: slave.position, data: output }), "输出已应用")}>应用</Button></Stack><Typography variant="caption" color="text.secondary">仅在周期运行时可写；后台确认成功后才更新状态。</Typography></CardContent></Card>
    </Box>}</>;
}

interface EsiResult { document_id: string; path: string; vendor_id: number; vendor_name: string; devices: EsiDevice[] }
interface TargetResult { target_id: string; size: number; sha256: string; supported: string[]; omitted: string[]; device: EsiDevice; original_config_data?: string; effective_config_data?: string }
type ProgressState = EepromProgressState;
interface EepromComparisonResult { equal: boolean; differing_bytes: number; first_difference?: number | null; target_sha256: string; readback_sha256: string }
interface EepromReadResult { data: string; size: number; sha256: string; read_at: string; sii_valid: boolean; sii_error?: string; identity?: { vendor_id: number; product_code: number; revision: number; serial_number: number }; category_count?: number; categories?: number[]; end_offset?: number; comparison?: EepromComparisonResult }
interface EepromFlashDetails { bytes_read_back: number; words_written: number; comparison: EepromComparisonResult; sii_valid: boolean; semantic_valid: boolean | null; image_verification: string; reset_sequence?: boolean[] | null; rediscovered?: boolean | null; reload_verified?: boolean | null; reload_error?: string | null }
interface EepromFlashPayload { success: boolean; result: EepromFlashDetails; slaves: SlaveInfo[] }
interface EepromOperationResult { title: string; severity: "success" | "warning" | "error" | "info"; payload?: EepromFlashPayload; error?: string }

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
  deviceOperationsBlocked: boolean;
}

// Temporary ConfigData lives in this page and is discarded when navigation unmounts it.
function EepromPage({ slave, status, progress, setProgress, run, readResult, setReadResult, initialSelection, onInitialSelectionConsumed, autoResetEsc, fileDropEnabled, deviceOperationsBlocked }: EepromPageProps) {
  const [esi, setEsi] = useState<EsiResult>();
  const [bin, setBin] = useState<EepromBinTarget>();
  const [ordinal, setOrdinal] = useState(-1);
  const [target, setTarget] = useState<TargetResult>();
  const flashTarget = bin ?? target;
  const [generationError, setGenerationError] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [readLength, setReadLength] = useState("");
  const capacity = readLength.trim() ? Number(readLength) : undefined;
  const invalidReadLength = capacity !== undefined && (!Number.isInteger(capacity) || capacity < 2 || capacity > 131072 || capacity % 2 !== 0);
  const readLengthRequired = capacity === undefined && !flashTarget && slave?.eeprom_capacity == null
    && (slave?.sii_status === "blank" || slave?.sii_status === "invalid");
  const readLengthHint = invalidReadLength ? "请输入 2–131072 范围的偶数"
    : readLengthRequired ? "请先填写读取长度" : "";
  const fullSiiRead = readResult?.size === slave?.eeprom_capacity;
  const [recentEsi, setRecentEsi] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(RECENT_ESI_KEY) ?? "[]") as string[]; }
    catch { return []; }
  });
  const [configData, setConfigData] = useState("");
  const [originalConfigData, setOriginalConfigData] = useState("");
  const [operationResult, setOperationResult] = useState<EepromOperationResult>();
  const generationRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const generatedConfigRef = useRef("");
  const targetContextRef = useRef("");
  const contextKey = `${status.host_generation}:${status.session_id}:${slaveIdentityKey(slave)}`;
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const currentDevice = esi?.devices[ordinal];
  const configDataResult = normalizeConfigData(configData);
  const configDecoded = decodeConfigData(configData);
  const operationInProgress = isEepromOperation(progress?.operation) && progress!.percent < 100;
  const canFlash = Boolean(slave && flashTarget && (!esi || !configDataResult.error) && !generationError && targetContextRef.current === contextKey && !status.cycle_running && !operationInProgress && !deviceOperationsBlocked);
  const blockers = [deviceOperationsBlocked && "软件正在更新", operationInProgress && "已有 EEPROM 操作正在执行", !flashTarget && "需要选择 XML/BIN", status.cycle_running && "需要停止周期通信"].filter(Boolean) as string[];
  useEffect(() => {
    generationRequestRef.current += 1;
    loadRequestRef.current += 1;
    generatedConfigRef.current = "";
    setEsi(undefined); setBin(undefined); setOrdinal(-1); setTarget(undefined); setConfigData(""); setOriginalConfigData("");
    setGenerationError(""); setOperationResult(undefined); setBackupPath(""); setReadLength("");
  }, [contextKey]);

  // Generate a new XML target whenever its selected Device or ConfigData changes.
  const generate = useCallback(async (document: EsiResult, selectedOrdinal: number, effectiveConfig?: string) => {
    const requestId = ++generationRequestRef.current;
    const context = contextKey;
    const normalized = normalizeConfigData(effectiveConfig ?? deviceConfigData(document.devices[selectedOrdinal])).formatted;
    generatedConfigRef.current = normalized ?? "";
    setTarget(undefined); setOperationResult(undefined); setGenerationError("");
    const value = await run(async () => {
      try { return await bridgeRequest<TargetResult>("sii_generate", { document_id: document.document_id, ordinal: selectedOrdinal, position: slave?.position, ...(normalized ? { config_data: normalized } : {}) }); }
      catch (error) {
        if (generationRequestRef.current === requestId && contextRef.current === context) setGenerationError(error instanceof BridgeRequestError ? error.message : "无法生成烧录目标，请检查所选 XML。");
        throw error;
      }
    });
    if (value && generationRequestRef.current === requestId && contextRef.current === context) {
      targetContextRef.current = context;
      setTarget(value);
    }
  }, [contextKey, run, slave?.position]);

  const loadXml = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string) => {
    const loadId = ++loadRequestRef.current;
    const context = contextKey;
    generationRequestRef.current += 1;
    generatedConfigRef.current = "";
    setTarget(undefined); setEsi(undefined); setBin(undefined); setGenerationError("");
    const document = await run(() => bridgeRequest<EsiResult>("esi_load", { path }));
    if (document && loadRequestRef.current === loadId && contextRef.current === context) {
      const nextRecent = [path, ...recentEsi.filter((item) => item !== path)].slice(0, 5);
      setRecentEsi(nextRecent);
      window.localStorage.setItem(RECENT_ESI_KEY, JSON.stringify(nextRecent));
      const matches = slave && slave.identity_valid !== false ? document.devices.map((device, index) =>
        document.vendor_id === slave.identity.vendor_id && device.product_code === slave.identity.product_code && deviceRevision(device) === slave.identity.revision ? index : -1,
      ).filter((index) => index >= 0) : [];
      const selectedOrdinal = preferredOrdinal !== undefined && document.devices[preferredOrdinal] ? preferredOrdinal : matches.length === 1 ? matches[0] : document.devices.length === 1 ? 0 : -1;
      const original = deviceConfigData(document.devices[selectedOrdinal]);
      const effective = normalizeConfigData(overrideConfig ?? original).formatted ?? original;
      setEsi(document); setOrdinal(selectedOrdinal); setOriginalConfigData(original); setConfigData(effective);
      if (selectedOrdinal >= 0) await generate(document, selectedOrdinal, effective);
    }
  }, [contextKey, generate, recentEsi, run, slaveIdentityKey(slave)]);
  // Load BIN bytes into a frozen target; XML follows the existing Device workflow.
  const loadFile = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string) => {
    if (!isBinFile(path)) return loadXml(path, preferredOrdinal, overrideConfig);
    const loadId = ++loadRequestRef.current;
    const context = contextKey;
    generationRequestRef.current += 1;
    generatedConfigRef.current = "";
    setEsi(undefined); setBin(undefined); setTarget(undefined); setOrdinal(-1);
    setConfigData(""); setOriginalConfigData(""); setGenerationError(""); setOperationResult(undefined);
    const value = await run(async () => {
      try { return await bridgeRequest<EepromBinTarget>("eeprom_bin_load", { path, position: slave?.position }); }
      catch (error) {
        if (loadRequestRef.current === loadId && contextRef.current === context) setGenerationError(error instanceof BridgeRequestError ? error.message : "无法加载所选 BIN。");
        throw error;
      }
    });
    if (value && loadRequestRef.current === loadId && contextRef.current === context) {
      targetContextRef.current = context;
      setBin(value);
      const nextRecent = [path, ...recentEsi.filter((item) => item !== path)].slice(0, 5);
      setRecentEsi(nextRecent);
      window.localStorage.setItem(RECENT_ESI_KEY, JSON.stringify(nextRecent));
    }
  }, [contextKey, loadXml, recentEsi, run, slave?.position]);

  useEffect(() => {
    if (!initialSelection) return;
    onInitialSelectionConsumed();
    void loadFile(initialSelection.path, initialSelection.ordinal, initialSelection.configData);
  }, [initialSelection, loadFile, onInitialSelectionConsumed]);
  // XML and BIN use one picker and one programming button.
  const selectFile = async () => {
    const path = await pickFile(["xml", "bin"]); if (path) await loadFile(path);
  };
  useEffect(() => {
    if (!fileDropEnabled) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void onFileDrop((paths) => {
      const source = paths.find((path) => /\.(xml|bin)$/i.test(path));
      if (source && !operationInProgress && !deviceOperationsBlocked) void loadFile(source);
    }).then((value) => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); };
  }, [fileDropEnabled, loadFile, operationInProgress, deviceOperationsBlocked]);
  useEffect(() => {
    if (!esi || ordinal < 0 || !configDataResult.formatted || configDataResult.formatted === generatedConfigRef.current) return;
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
  const operation = async <T,>(fn: () => Promise<T>, success: string, failure = "操作失败"): Promise<T | undefined> => {
    if (["eeprom_read", "eeprom_backup", "eeprom_flash", "eeprom_restore"].some((method) => operationStore.active(method))) return undefined;
    setOperationResult(undefined);
    setProgress({ operation: "eeprom", stage: "准备", completed: 0, total: 100, percent: 0, detail: "正在检查操作条件", tone: "info", cancellable: true });
    try {
      const value = await fn();
      const flashPayload = value as EepromFlashPayload;
      if (flashPayload && typeof flashPayload === "object" && "success" in flashPayload) {
        if (!flashPayload.success) {
          const title = "烧录失败";
          setProgress({ operation: "eeprom", stage: title, completed: 100, total: 100, percent: 100, detail: flashPayload.result.image_verification, tone: "error" });
          setOperationResult({ title, severity: "error", payload: flashPayload, error: flashPayload.result.image_verification });
          return value;
        }
        const reloadFailed = flashPayload.result.reload_verified === false;
        const title = reloadFailed ? "镜像校验成功；复位后复核失败" : success;
        setProgress({ operation: "eeprom", stage: title, completed: 100, total: 100, percent: 100, detail: reloadFailed ? "EEPROM 镜像已通过校验，但复位后的重新加载复核未通过。" : success, tone: reloadFailed ? "info" : "success" });
        setOperationResult({ title, severity: reloadFailed ? "warning" : "success", payload: flashPayload, error: reloadFailed ? "复位后未能确认设备已加载新内容，请重新读取设备。" : undefined });
      } else {
        setProgress({ operation: "eeprom", stage: success, completed: 100, total: 100, percent: 100, detail: success, tone: "success" });
        setOperationResult({ title: success, severity: "success" });
      }
      return value;
    } catch (error) {
      const text = error instanceof BridgeRequestError ? error.message : "EEPROM 操作未完成，请检查文件与当前连接。";
      if (error instanceof BridgeRequestError && error.code === "CANCELLED") {
        setProgress({ operation: "eeprom", stage: "已取消", completed: 100, total: 100, percent: 100, detail: text, tone: "info" });
        setOperationResult({ title: "操作已取消", severity: "info", error: text });
        return undefined;
      }
      setProgress({ operation: "eeprom", stage: failure, completed: 100, total: 100, percent: 100, detail: text, tone: "error" });
      setOperationResult({ title: failure, severity: "error", error: text });
      return undefined;
    }
  };
  const readFull = async () => {
    if (!slave || invalidReadLength || readLengthRequired) return;
    const value = await operation(() => bridgeRequest<EepromReadResult>("eeprom_read", { position: slave.position, target_id: flashTarget?.target_id, capacity: capacity ?? (flashTarget ? flashTarget.size + flashTarget.size % 2 : undefined) }), "完整读取完成");
    if (value) setReadResult(value);
  };
  // Export the raw bytes under the selected slave's name.
  const exportBin = async () => {
    if (!slave || invalidReadLength || readLengthRequired) return;
    const directory = await pickDirectory();
    if (!directory) return;
    const value = await operation(() => bridgeRequest<{ binary_path: string }>("eeprom_backup", {
      position: slave.position,
      directory,
      capacity: capacity ?? (flashTarget ? flashTarget.size + flashTarget.size % 2 : undefined),
    }), "BIN 文件导出完成");
    if (value) setBackupPath(value.binary_path);
  };
  // Both sources write the frozen target selected for this slave and session.
  const flash = () => canFlash && slave && flashTarget && operation(() => bridgeRequest<EepromFlashPayload>("eeprom_flash", { position: slave.position, target_id: flashTarget.target_id, auto_reset: autoResetEsc }), autoResetEsc ? "烧录完成" : "烧录完成，未复位 ESC", "烧录失败");

  return <><PageTitle title="EEPROM" subtitle="XML/BIN 烧录、原始读取与 BIN 文件导出" />
    <Box sx={{ mb: 1.25, p: 1.25, border: "1px dashed", borderColor: "primary.light", borderRadius: 1.5, bgcolor: "rgba(25,118,210,.035)" }}>
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
        <Typography variant="body2" fontWeight={700}>可将 XML/BIN 拖入窗口</Typography><Typography variant="caption" color="text.secondary">最近文件：</Typography>
        {recentEsi.length ? recentEsi.map((path) => <Chip key={path} size="small" variant="outlined" disabled={operationInProgress || deviceOperationsBlocked} label={path.split(/[\\/]/).at(-1)} title={path} onClick={() => void loadFile(path)} />) : <Typography variant="caption" color="text.secondary">暂无</Typography>}
      </Stack>
    </Box>
    {backupPath && <Alert severity="success" action={<Button size="small" onClick={() => revealPath(backupPath)}>打开位置</Button>} sx={{ mb: 1.25 }}><Typography fontWeight={700}>BIN 文件已导出</Typography><Typography variant="body2" className="mono" sx={{ overflowWrap: "anywhere" }}>{backupPath}</Typography></Alert>}
    {progress && isEepromOperation(progress.operation) && <Card sx={{ ...cardSx, mb: 1.25, borderColor: progress.tone === "error" ? "error.main" : progress.tone === "success" ? "success.main" : "primary.main" }}><CardContent sx={{ py: "10px !important" }}><Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}><Box minWidth={0}><Typography fontWeight={700}>{progress.stage}</Typography><Typography variant="caption" color="text.secondary">{progress.detail}</Typography></Box><Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 230 }}><LinearProgress color={progress.tone === "error" ? "error" : progress.tone === "success" ? "success" : "primary"} variant="determinate" value={progress.percent} sx={{ flex: 1, height: 5, borderRadius: 4 }} /><Typography className="mono" variant="caption" sx={{ width: 34, textAlign: "right" }}>{progress.percent}%</Typography>{progress.percent < 100 && progress.cancellable !== false && <Button size="small" onClick={() => bridgeRequest("cancel")}>取消</Button>}</Stack></Stack></CardContent></Card>}
    {!slave ? <EmptyState text="请先选择目标从站" /> : <Stack spacing={1.5}>
      <Card sx={cardSx}><CardContent>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Box><Typography variant="h6">烧录目标</Typography><Typography variant="body2" color="text.secondary">从站 {slave.position} · {slaveDisplayName(slave)} · {slave.chip_model}</Typography></Box>
          <Button disabled={operationInProgress || deviceOperationsBlocked} variant="outlined" startIcon={<FolderOpenRounded />} onClick={selectFile}>选择 XML/BIN</Button>
        </Stack><Divider sx={{ my: 1.5 }} />
        {bin ? <Stack spacing={1.25}>
          <TextField label="BIN 文件" size="small" value={bin.path} InputProps={{ readOnly: true }} />
          <Stack direction="row" gap={1}><Chip label="BIN · 原始数据" color="primary" variant="outlined" /><Chip label={`待写入 ${bin.size} B`} /></Stack>
          <Typography variant="caption" className="mono" sx={{ overflowWrap: "anywhere" }}>SHA-256：{bin.sha256}</Typography>
          <Alert severity="info">从 EEPROM 地址 0 开始写入文件原始字节，不修改 ConfigData、CRC、身份或 SII 类别。</Alert>
        </Stack> : esi ? <Stack spacing={1.5}>
          <TextField label="XML 文件" size="small" value={esi.path} InputProps={{ readOnly: true }} />
          <FormControl disabled={operationInProgress || deviceOperationsBlocked} fullWidth size="small"><InputLabel>Device</InputLabel><Select label="Device" value={ordinal} onChange={(e) => changeDevice(Number(e.target.value))}><MenuItem value={-1} disabled>请选择烧录设备</MenuItem>{esi.devices.map((device, i) => <MenuItem value={i} key={i}>{esiDeviceDisplayName(device)} · {hex(device.product_code, 8)}</MenuItem>)}</Select></FormControl>
          <Box sx={{ p: 1.4, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "#FAFBFD" }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 0.8 }}><Box><Typography variant="subtitle2">本次烧录 ConfigData</Typography><Typography variant="caption" color="text.secondary">1–14 byte；修改只作用于本次内存目标，原 XML 不变</Typography></Box><Button size="small" disabled={operationInProgress || deviceOperationsBlocked || configData === originalConfigData} onClick={() => { generationRequestRef.current += 1; generatedConfigRef.current = ""; setTarget(undefined); setConfigData(originalConfigData); }}>恢复原值</Button></Stack>
            <TextField fullWidth size="small" value={configData} disabled={operationInProgress || deviceOperationsBlocked || ordinal < 0} error={Boolean(configDataResult.error)} helperText={configDataResult.error ?? (configDecoded ? `PDI ${configDecoded.formatted.slice(0, 2)} · ${configDecoded.pdiLabel}` : "输入 1–14 个十六进制字节")} onChange={(event) => { generationRequestRef.current += 1; generatedConfigRef.current = ""; setConfigData(event.target.value.toUpperCase()); setTarget(undefined); }} onBlur={() => configDataResult.formatted && setConfigData(configDataResult.formatted)} inputProps={{ className: "mono", spellCheck: false }} />
          </Box>
          {target ? <Box>
            <Typography variant="body2" fontWeight={700}>待写入 {target.size} B · 保留 XML 声明长度</Typography>
            <Typography className="mono" variant="caption" sx={{ display: "block", overflowWrap: "anywhere", mt: 0.5 }}>SHA-256：{target.sha256}</Typography>
          </Box> : !generationError && <Alert severity="info">{ordinal < 0 ? "XML 包含多个 Device，请明确选择烧录设备。" : "正在生成烧录目标…"}</Alert>}
        </Stack> : <Box sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>选择 XML 或 BIN 文件准备烧录</Box>}
        {generationError && <Alert severity="error" sx={{ mt: 1.25 }}>{generationError}</Alert>}
        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" gap={1.25} alignItems="center">
          <Tooltip title={blockers.join("；")}><span><Button size="small" variant="contained" color="error" disabled={!canFlash} startIcon={<MemoryRounded />} onClick={flash}>烧录</Button></span></Tooltip>
          <Typography variant="caption" color="text.secondary">{blockers.join("；") || (autoResetEsc ? "写入后自动复位 ESC" : "烧录后不复位 ESC")}</Typography>
        </Stack>
      </CardContent></Card>
      <Card sx={cardSx}><CardContent>
        <Typography variant="h6">读取与导出</Typography><Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.25 }}>读取 EEPROM 原始数据并显示 Hex View；导出 BIN 文件保留空白或损坏内容。选择文件后，默认按目标长度读取。</Typography>
        <TextField size="small" fullWidth label="读取长度（字节，可选）" value={readLength} disabled={operationInProgress} error={invalidReadLength} helperText={readLengthHint} onChange={(event) => setReadLength(event.target.value)} sx={{ mb: 1.25 }} />
        <Stack direction="row" gap={0.75} flexWrap="wrap">
          <Tooltip title={status.cycle_running ? "完整读取前必须停止周期通信" : readLengthRequired ? "请先填写读取长度" : ""}><span><Button size="small" variant="outlined" disabled={deviceOperationsBlocked || status.cycle_running || operationInProgress || invalidReadLength || readLengthRequired} onClick={readFull}>完整读取</Button></span></Tooltip>
          <Tooltip title={status.cycle_running ? "导出前必须停止周期通信" : readLengthRequired ? "请先填写读取长度" : ""}><span><Button size="small" variant="outlined" disabled={deviceOperationsBlocked || status.cycle_running || operationInProgress || invalidReadLength || readLengthRequired} startIcon={<SaveAltRounded />} onClick={exportBin}>导出BIN文件</Button></span></Tooltip>
          {backupPath && <Button size="small" onClick={() => revealPath(backupPath)} startIcon={<FolderOpenRounded />}>打开导出位置</Button>}
        </Stack>
      </CardContent></Card>
      {readResult && <Card sx={cardSx}><CardContent><Typography variant="h6">最近 EEPROM 读取</Typography><Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 1.25, mt: 1.25 }}>{[["读取时间", new Date(readResult.read_at).toLocaleString()], ["读取长度", `${readResult.size} B`], ["SII 结构", readResult.sii_valid ? `${readResult.category_count ?? 0} 个 Category` : fullSiiRead ? "无效" : "未解析"], ["差异", readResult.comparison ? `${readResult.comparison.differing_bytes} byte` : "未选择目标"], ["Vendor ID（厂商 ID）", readResult.identity ? hex(readResult.identity.vendor_id, 8) : "—"], ["Product Code（产品代码）", readResult.identity ? hex(readResult.identity.product_code, 8) : "—"], ["Revision（修订版本）", readResult.identity ? hex(readResult.identity.revision, 8) : "—"], ["SHA-256", readResult.sha256]].map(([label, value]) => <Box key={label} minWidth={0}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography className={label === "SHA-256" || label.includes("Code") ? "mono" : ""} noWrap title={value}>{value}</Typography></Box>)}</Box>{!readResult.sii_valid && fullSiiRead && <Alert severity="warning" sx={{ mt: 1.25 }}>原始数据已读取，但设备信息未能解析。可在下方查看原始内容。</Alert>}<Accordion disableGutters sx={{ mt: 1.25 }}><AccordionSummary expandIcon={<ExpandMoreRounded />}><Typography fontWeight={700}>Hex View（只读）</Typography></AccordionSummary><AccordionDetails><Box component="pre" className="mono data-surface" sx={{ m: 0, p: 1.25, maxHeight: 320, overflow: "auto", fontSize: 12 }}>{formatHexView(readResult.data)}</Box></AccordionDetails></Accordion></CardContent></Card>}
      {operationResult && <Card sx={cardSx}><CardContent><Alert severity={operationResult.severity}><Typography fontWeight={700}>{operationResult.title}</Typography>{operationResult.error}</Alert>{operationResult.payload && <Accordion disableGutters sx={{ mt: 1.2 }}><AccordionSummary expandIcon={<ExpandMoreRounded />}><Typography fontWeight={700}>技术详情</Typography></AccordionSummary><AccordionDetails><Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>{[["写入 Word", operationResult.payload.result.words_written], ["完整回读", `${operationResult.payload.result.bytes_read_back} B`], ["差异字节", operationResult.payload.result.comparison.differing_bytes], ["首个差异字节地址", operationResult.payload.result.comparison.first_difference == null ? "无" : hex(operationResult.payload.result.comparison.first_difference, 4)], ["目标 SHA-256", operationResult.payload.result.comparison.target_sha256], ["回读 SHA-256", operationResult.payload.result.comparison.readback_sha256], ["SII 结构（辅助信息）", operationResult.payload.result.sii_valid ? "可解析" : "未解析"], ["XML 语义（辅助信息）", operationResult.payload.result.semantic_valid == null ? "不适用" : operationResult.payload.result.semantic_valid ? "可解析" : "与 XML 描述不同"], ["RES 序列", operationResult.payload.result.reset_sequence == null ? "未执行" : operationResult.payload.result.reset_sequence.every(Boolean) ? "三帧成功" : "未完成"], ["重新发现", operationResult.payload.result.rediscovered == null ? "未执行" : operationResult.payload.result.rediscovered ? "成功" : "失败"], ["重新加载复核", operationResult.payload.result.reload_verified == null ? "未执行" : operationResult.payload.result.reload_verified ? "成功" : "失败"]].map(([label, value]) => <Box key={String(label)}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography className={String(label).includes("SHA") ? "mono" : ""} noWrap title={String(value)}>{String(value)}</Typography></Box>)}</Box></AccordionDetails></Accordion>}</CardContent></Card>}
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
  const [message, setMessage] = useState<{ text: string; severity: "success" | "error" | "info" | "warning"; dismissed?: boolean }>();
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState(0);
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate>();
  const [updateProgress, setUpdateProgress] = useState({ downloaded: 0, total: 0 });
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateError, setUpdateError] = useState<UpdateFailure>();
  const [pendingUpdateReminder, setPendingUpdateReminder] = useState(false);
  const [ignoredUpdateVersion, setIgnoredUpdateVersion] = useState(() => window.localStorage.getItem(IGNORED_UPDATE_KEY) ?? "");
  const updateTaskRef = useRef(false);
  const startupUpdateCheckedRef = useRef(false);
  const [alLanguage, setAlLanguage] = useState<AlStatusLanguage>(() => window.localStorage.getItem(AL_LANGUAGE_KEY) === "en" ? "en" : "zh");
  const [eepromAutoReset, setEepromAutoReset] = useState(() => loadEepromAutoReset());
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(() => window.localStorage.getItem(AUTO_UPDATE_KEY) === "true");
  const autoCheckUpdatesRef = useRef(autoCheckUpdates);
  autoCheckUpdatesRef.current = autoCheckUpdates;
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
  const stateRequestBusy = useMemo(() => [...operations.values()].some((operation) =>
    ["queued", "running"].includes(operation.phase) && operation.method === "request_state"
  ), [operations]);
  const hardwareBusy = useMemo(() => [...operations.values()].some((operation) =>
    ["queued", "running"].includes(operation.phase) && operation.lane === "hardware" && !["register_watch", "request_state"].includes(operation.method)
  ), [operations]);
  const scanning = [...operations.values()].some((operation) => ["queued", "running"].includes(operation.phase) && ["scan", "auto_scan"].includes(operation.method));
  const connecting = [...operations.values()].some((operation) => ["queued", "running"].includes(operation.phase) && ["connect", "disconnect"].includes(operation.method));
  const eepromExclusive = isEepromOperation(progress?.operation) && progress!.percent < 100;
  const updating = isUpdateInProgress(updateState);
  const busy = hardwareBusy || updating;
  // A disconnect cancels pending register frames before closing the same Worker.
  const disconnectBusy = updating || [...operations.values()].some((operation) =>
    ["queued", "running"].includes(operation.phase) && operation.lane === "hardware"
    && !["register_snapshot", "register_watch", "request_state"].includes(operation.method)
  );
  const updateBlockedReason = eepromExclusive
    ? "EEPROM 操作进行中，完成后即可更新。"
    : hardwareBusy || stateRequestBusy ? "设备操作进行中，完成后即可更新。" : "";
  const busState = minimumBusState(status.slaves);
  const busStateBlockedReason = !bridgeAvailable
    ? "通信服务暂不可用"
    : !status.connected
      ? "请先连接 EtherCAT 网卡"
      : !status.slaves.length
        ? "请先扫描从站"
        : eepromExclusive
          ? "EEPROM 操作期间不能切换状态"
          : stateRequestBusy
            ? "正在切换从站状态"
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

  // Preserve the text and severity until the snackbar finishes its exit animation.
  const closeMessage = () => setMessage((current) => current ? { ...current, dismissed: true } : current);

  const run: Run = useCallback(async (operation, success) => {
    try {
      const result = await operation();
      if (success) setMessage({ text: success, severity: "success" });
      return result;
    } catch (error) {
      const text = error instanceof BridgeRequestError ? error.message : "操作未完成，请检查当前连接和操作条件。";
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
      setMessage({ text: "未找到可用网卡。请确认网卡已启用并重新扫描。", severity: "error" });
      return;
    }
    const failed = result.attempts.filter((attempt) => attempt.error);
    const openedWithoutSlaves = result.attempts.filter((attempt) => !attempt.error && attempt.slave_count === 0);
    if (failed.length && failed.length === result.attempts.length) {
      setMessage({ text: "网卡扫描未完成。请检查网卡连接；如果反复出现，请记录操作步骤并反馈。", severity: "error" });
    } else if (failed.length && openedWithoutSlaves.length) {
      setMessage({ text: "未扫描到从站，部分网卡的扫描也未完成。请检查网卡连接后重试。", severity: "warning" });
    } else if (openedWithoutSlaves.length) {
      setMessage({ text: "未扫描到从站", severity: "info" });
    } else {
      setMessage({ text: "自动扫描未发现从站。请确认设备已连接并通电，再重新扫描。", severity: "info" });
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
        setMessage({ text: error instanceof BridgeRequestError ? text : "暂时无法读取设备状态，请稍后重试。", severity: "error" });
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
        setMessage((current) => current?.text.includes("通信服务") ? undefined : current);
        const generation = event.host_generation
          ?? (event.data as { host_generation?: number } | undefined)?.host_generation;
        if (generation !== undefined && generation !== bootstrappedGeneration) bootstrappedGeneration = undefined;
        void bootstrap();
      }
      if (event.kind === "host_restart_failed") {
        setBridgeAvailable(false);
        setMessage({ text: "通信服务启动失败，软件正在尝试恢复。", severity: "error" });
      }
      if (event.kind === "heartbeat") {
        // Heartbeat is telemetry only. Command responses and bus_snapshot events
        // are the authoritative source of EtherCAT session and state.
      }
      if (event.kind === "cycle_fault") setMessage({ text: cycleFaultMessage(event.data), severity: "error" });
      if (event.kind === "worker_fatal") {
        const text = "通信服务已停止，请重新启动软件后连接设备。";
        setBridgeAvailable(false);
        operationStore.invalidate("WORKER_FATAL", text);
        setSelectedPosition(undefined);
        setSnapshot(undefined);
        setRegisterProfileOverrides({});
        setProgress((previous) => previous && previous.percent < 100 ? { ...previous, completed: previous.total, percent: 100, stage: "通信服务已停止", detail: text, tone: "error", cancellable: false } : previous);
        setMessage({ text, severity: "error" });
      }
      if (event.kind === "process_data") setSnapshot(event.data as Snapshot);
      if (event.kind === "scan_discovered") {
        const data = event.data as { adapter?: string; slaves?: SlaveInfo[] };
        const discovered = data.slaves ?? [];
        if (discovered.length) {
          setStatus((current) => ({
            ...current,
            phase: "bus_scanned",
            adapter: data.adapter ?? current.adapter,
            connected: true,
            slaves: discovered,
          }));
          setSelectedPosition((current) => current !== undefined && discovered.some((item) => item.position === current)
            ? current
            : discovered[0].position);
          setMessage({ text: `已发现 ${discovered.length} 个从站，正在读取设备信息…`, severity: "info" });
        }
      }
      if (event.kind === "progress") {
        const next = event.data as OperationProgress;
        const fraction = next.total > 0 ? Math.min(1, next.completed / next.total) : 0;
        const ranges: Record<string, [number, number]> = {
          "write-verify": [0, 75], "full-verify": [75, 95], reset: [95, 97], "reload-verify": [97, 99],
        };
        const range = ranges[next.stage];
        const calculated = Math.round(range ? range[0] + (range[1] - range[0]) * fraction : fraction * 100);
        const labels: Record<string, string> = {
          read: "完整读取", "backup-read": "读取并保存 BIN", "write-verify": "写入 EEPROM",
          "full-verify": "完整回读校验", reset: "复位并重新发现", "reload-verify": "复位后重新加载复核",
        };
        setProgress((previous) => {
          if (previous?.percent === 100 && previous.tone !== "info") return previous;
          return { ...next, stage: labels[next.stage] ?? next.stage, percent: Math.max(previous?.percent ?? 0, calculated), tone: "info" };
        });
      }
      if (event.kind === "error") setMessage({ text: "后台操作遇到问题。请刷新状态；如果反复出现，请记录操作步骤并反馈。", severity: "error" });
    }).then((value) => { if (active) unlisten = value; else value(); });
    const exitReady = onBridgeExited((info) => {
      if (!active) return;
      setBridgeAvailable(false);
      setBridgeExit(info);
      operationStore.invalidate("PROCESS_EXITED", "通信服务已退出");
      setProgress((previous) => previous && previous.percent < 100 ? {
        ...previous,
        completed: previous.total,
        percent: 100,
        stage: "通信服务已退出",
        detail: "通信服务已退出，写入结果可能需要重新确认。",
        tone: "error",
        cancellable: false,
      } : previous);
      setSelectedPosition(undefined);
      setSnapshot(undefined);
      setRegisterProfileOverrides({});
      setMessage({ text: "通信服务已退出，软件将尝试恢复。重新连接后请先读取设备状态，确认此前写入的结果。", severity: "error" });
    }).then((value) => { if (active) unlistenExit = value; else value(); });
    Promise.all([eventReady, exitReady]).then(() => { if (active) bootstrap(); });
    return () => { active = false; unlisten?.(); unlistenExit?.(); };
  }, [applyAdapters, autoScan]);

  const connect = async () => {
    if (status.connected) await run(() => bridgeRequest("disconnect"), "已断开网卡");
    else if (await run(() => bridgeRequest("connect", { adapter }))) await scan();
  };
  const checkUpdate = useCallback(async (automatic = false) => {
    if (updateTaskRef.current || (automatic && startupUpdateCheckedRef.current)) return;
    startupUpdateCheckedRef.current = true;
    updateTaskRef.current = true;
    setPendingUpdateReminder(false);
    setUpdateError(undefined);
    setAvailableUpdate(undefined);
    setUpdateState("checking");
    try {
      const update = await checkForUpdate();
      if (!update) {
        setUpdateState("latest");
        setUpdateDialogOpen(false);
        if (!automatic) setMessage({ text: `当前已是最新版本 v${packageInfo.version}`, severity: "info" });
        return;
      }
      setAvailableUpdate(update);
      setUpdateProgress({ downloaded: 0, total: 0 });
      setUpdateState("available");
      if (automatic) {
        const ignored = window.localStorage.getItem(IGNORED_UPDATE_KEY) === update.version;
        if (!ignored && autoCheckUpdatesRef.current) {
          setPendingUpdateReminder(true);
        } else if (!ignored) {
          setMessage({ text: `发现 v${update.version} 更新，可在“关于”页面查看。`, severity: "info" });
        }
      } else {
        setUpdateDialogOpen(true);
      }
    } catch (error) {
      setUpdateState("error");
      setUpdateError({ stage: "checking", message: error instanceof Error ? error.message : String(error) });
      if (!automatic) setUpdateDialogOpen(true);
    } finally {
      updateTaskRef.current = false;
    }
  }, []);
  useEffect(() => () => { void availableUpdate?.close().catch(console.error); }, [availableUpdate]);
  useEffect(() => {
    if (!autoCheckUpdates) {
      setPendingUpdateReminder(false);
      return;
    }
    if (pendingUpdateReminder && updateState === "available" && !updateBlockedReason) {
      setPendingUpdateReminder(false);
      setUpdateDialogOpen(true);
    }
  }, [autoCheckUpdates, pendingUpdateReminder, updateState, updateBlockedReason]);
  const closeUpdateDialog = () => {
    setPendingUpdateReminder(false);
    setUpdateDialogOpen(false);
  };
  const ignoreUpdate = () => {
    if (!availableUpdate || updateTaskRef.current) return;
    try {
      window.localStorage.setItem(IGNORED_UPDATE_KEY, availableUpdate.version);
      setIgnoredUpdateVersion(availableUpdate.version);
      closeUpdateDialog();
    } catch {
      setMessage({ text: "无法保存忽略设置，请使用“取消”关闭本次提醒。", severity: "error" });
    }
  };
  const installUpdate = async () => {
    if (!availableUpdate || updateTaskRef.current || eepromExclusive || operationStore.activeHardware()) return;
    updateTaskRef.current = true;
    operationStore.setUpdateInProgress(true);
    setPendingUpdateReminder(false);
    setUpdateError(undefined);
    setUpdateState("preparing");
    setUpdateDialogOpen(true);
    setQuickFlashOpen(false);
    setSlaveContextMenu(undefined);
    let stage: UpdateStage = "preparing";
    try {
      const current = await bridgeRequest<WorkbenchStatus>("status");
      if (current.cycle_running) await bridgeRequest("stop_cycle");
      if (current.connected) await bridgeRequest("disconnect");
      setUpdateProgress({ downloaded: 0, total: 0 });
      stage = "downloading";
      setUpdateState("downloading");
      await availableUpdate.downloadAndInstall((next) => {
        stage = next.phase;
        setUpdateState(next.phase);
        setUpdateProgress({ downloaded: next.downloaded, total: next.total ?? 0 });
      });
    } catch (error) {
      operationStore.setUpdateInProgress(false);
      setUpdateState("error");
      setUpdateError({ stage, message: error instanceof Error ? error.message : String(error) });
      setUpdateDialogOpen(true);
      updateTaskRef.current = false;
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => { void checkUpdate(true); }, 25_000);
    return () => window.clearTimeout(timer);
  }, [checkUpdate]);
  const scan = async () => {
    const found = await run(() => bridgeRequest<SlaveInfo[]>("scan"));
    if (found) setMessage({ text: found.length ? `扫描完成，发现 ${found.length} 个从站` : "未扫描到从站", severity: found.length ? "success" : "info" });
  };
  const requestBusState = (state: number) => run(
    () => bridgeRequest<SlaveInfo[]>("request_state", { position: 0, state }),
  );
  const selectAdapter = (value: string) => {
    setAdapter(value);
    window.localStorage.setItem(PREFERRED_ADAPTER_KEY, value);
  };

  const navigate = useCallback((nextPage: PageKey) => {
    if (nextPage === page || updateState === "preparing") return;
    // Advance before rendering the target page so its initial bridge calls are
    // born into the new page generation instead of being cancelled immediately.
    operationStore.nextPage();
    setPage(nextPage);
  }, [page, updateState]);
  const setSelectedEepromReadResult = useCallback((value?: EepromReadResult) => {
    if (value) setEepromReadCache((current) => ({ ...current, [eepromReadCacheKey]: value }));
  }, [eepromReadCacheKey]);
  const consumeEepromDetailSelection = useCallback(() => setEepromDetailSelection(undefined), []);

  const openSlaveContextMenu = (event: ReactMouseEvent, position: number) => {
    event.preventDefault();
    if (updating) return;
    setSelectedPosition(position);
    setSlaveContextMenu({ mouseX: event.clientX + 2, mouseY: event.clientY - 6, position });
  };

  const openSlaveEeprom = () => {
    if (slaveContextMenu) setSelectedPosition(slaveContextMenu.position);
    setSlaveContextMenu(undefined);
    setQuickFlashOpen(true);
  };

  const visit = (url: string) => {
    openExternal(url).catch((_error) => setMessage({
      text: "无法打开链接，请稍后重试。",
      severity: "error",
    }));
  };

  const content = useMemo(() => {
    const props = { slave, run };
    if (page === "overview") return <OverviewPage {...props} status={status} busy={busy} stateRequestBusy={stateRequestBusy} refresh={refreshStates} registerProfile={registerProfile} alLanguage={alLanguage} onRegisterProfileChange={(profile) => slave && setRegisterProfileOverrides((current) => ({ ...current, [selectedSlaveKey]: profile }))} />;
    if (page === "registers") return <RegistersPage key={`${status.host_generation}:${status.session_id}:${selectedSlaveKey}:${registerProfile}`} {...props} registerProfile={registerProfile} deviceOperationsBlocked={updating} sessionContext={`${status.host_generation}:${status.session_id}`} />;
    return <EepromPage {...props} status={status} progress={progress} setProgress={setProgress} readResult={eepromReadCache[eepromReadCacheKey]} setReadResult={setSelectedEepromReadResult} initialSelection={eepromDetailSelection} onInitialSelectionConsumed={consumeEepromDetailSelection} autoResetEsc={eepromAutoReset} fileDropEnabled={!quickFlashOpen} deviceOperationsBlocked={updating} />;
  }, [page, registerProfile, selectedSlaveKey, selectedPosition, slave, status, snapshot, progress, refreshStates, run, busy, stateRequestBusy, updating, alLanguage, eepromAutoReset, quickFlashOpen, eepromReadCache, eepromReadCacheKey, eepromDetailSelection, setSelectedEepromReadResult, consumeEepromDetailSelection]);

  return <Box sx={{ display: "flex", height: "100vh", bgcolor: "background.default" }}>
    <Drawer variant="permanent" PaperProps={{ sx: { width: 56, borderRight: 1, borderColor: "divider", bgcolor: "#FBFCFE", overflow: "hidden" } }}>
      <Toolbar sx={{ minHeight: "54px !important", px: "7px !important", gap: 0.75 }}>
        <Box component="img" src={appIconUrl} alt="BenchCAT" sx={{ width: 42, height: 42, borderRadius: 1.2, display: "block", flexShrink: 0 }} />
      </Toolbar>
      <Divider />
      <List sx={{ px: 0.6, pt: 1.25 }}>{pages.map((item) => <Tooltip key={item.key} title={item.label} placement="right"><span><ListItemButton aria-label={item.label} disabled={(updateState === "preparing" && item.key !== page) || (eepromExclusive && item.key !== "eeprom")} selected={page === item.key} onClick={() => navigate(item.key)} key={item.key} sx={{ minHeight: 36, mb: 0.3, px: 0.85 }}><ListItemIcon sx={{ minWidth: 28, color: page === item.key ? "primary.main" : "text.secondary" }}>{item.icon}</ListItemIcon></ListItemButton></span></Tooltip>)}</List>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <List sx={{ p: 0.6 }}><Tooltip title={"设置"} placement="right"><ListItemButton aria-label="设置" onClick={() => { setSettingsTab(0); setSettings(true); }} sx={{ minHeight: 36, px: 0.85 }}><ListItemIcon sx={{ minWidth: 28 }}><SettingsRounded /></ListItemIcon></ListItemButton></Tooltip></List>
    </Drawer>
    <Box sx={{ ml: "56px", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <AppBar className="workbench-toolbar" position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider", bgcolor: "rgba(255,255,255,.96)" }}>
        <Toolbar sx={{ minHeight: "54px !important", columnGap: 0.65, rowGap: 0.65, px: "10px !important", py: 0.45, flexWrap: "wrap", alignContent: "center" }}>
          <Stack sx={{ width: 170, minWidth: 0, flexShrink: 0 }} spacing={0.15}>
            <Stack direction="row" gap={0.6} alignItems="center" flexWrap="wrap">
              <Chip size="small" color={!bridgeAvailable ? "error" : status.connected ? "success" : "default"} variant={status.connected ? "filled" : "outlined"} label={!bridgeAvailable ? "通信核心不可用" : status.connected ? "网卡已连接" : "网卡未连接"} />
              {status.mode === "demo" && <Chip size="small" color="warning" label="Demo" />}
              {previewMode && <Chip size="small" variant="outlined" label="预览" />}
            </Stack>
            <Typography variant="caption" color="text.secondary" noWrap>{!bridgeAvailable ? "通信核心正在恢复" : status.connected ? status.slaves.length ? `已发现 ${status.slaves.length} 个从站` : "暂无从站" : "检测网卡并自动扫描 EtherCAT 从站"}</Typography>
          </Stack>
          {status.connected && status.slaves.length > 0 && status.slaves.length !== 1 && <Box sx={{ pl: 1, borderLeft: 1, borderColor: "divider", flexShrink: 0 }}>
            <Tooltip title={busStateBlockedReason || `全部从站状态控制 · 当前 ${busState === undefined ? "无状态" : stateLabel(busState)}`}>
              <span>
                <StateSelector key={status.session_id} state={busState} disabled={Boolean(busStateBlockedReason)} onRequest={requestBusState} label="全部从站状态控制" />
              </span>
            </Tooltip>
          </Box>}
          <Box sx={{ display: "flex", alignItems: "center", alignContent: "center", justifyContent: "flex-end", flex: "0 1 auto", minWidth: 0, ml: "auto", flexWrap: "wrap", gap: 0.65 }}>
            <FormControl size="small" sx={{ width: 270, minWidth: 170 }}><Select displayEmpty inputProps={{ "aria-label": "网卡" }} MenuProps={{ PaperProps: { sx: { width: 270, maxWidth: 270 } } }} value={adapter} disabled={!bridgeAvailable || eepromExclusive || status.connected || busy} onChange={(e) => selectAdapter(e.target.value)}>{adapters.map((item) => <MenuItem value={item.name} key={item.name} title={item.description || item.name} sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{item.description || item.name}</MenuItem>)}</Select></FormControl>
            <Button size="small" variant={status.connected ? "outlined" : "contained"} color={status.connected ? "error" : "primary"} startIcon={connecting ? <CircularProgress size={18} color="inherit" /> : <UsbRounded />} disabled={!bridgeAvailable || eepromExclusive || (status.connected ? disconnectBusy : busy) || (!status.connected && !adapter)} onClick={connect} sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>{status.connected ? "断开" : "连接"}</Button>
            <Button size="small" variant="outlined" startIcon={<RefreshRounded className={scanning ? "operation-icon-spinning" : undefined} />} disabled={!bridgeAvailable || eepromExclusive || busy || !status.connected || status.cycle_running} onClick={scan} sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>扫描</Button>
          </Box>
        </Toolbar>
      </AppBar>
      <Box sx={{ display: "flex", minHeight: 0, flex: 1 }}>
        {status.slaves.length > 0 && slaveListExpanded && <Box component="aside" sx={{ width: { xs: 210, xl: 224 }, flexShrink: 0, bgcolor: "background.paper", borderRight: 1, borderColor: "divider", overflow: "auto", p: 0.75 }}><Stack direction="row" justifyContent="space-between" alignItems="center" gap={0.5} sx={{ px: 0.75, py: 0.55 }}><Typography variant="overline" color="text.secondary" sx={{ flexShrink: 0 }}>从站 · {status.slaves.length}</Typography><Stack direction="row" alignItems="center" gap={0.45} minWidth={0}>{status.slaves.some((item) => item.state_error) ? <Chip size="small" label="—" /> : <StateChip state={busState!} />}</Stack></Stack><List dense sx={{ pt: 0.35 }}>{status.slaves.map((item) => <ListItemButton disabled={eepromExclusive} key={item.position} selected={item.position === selectedPosition} onClick={() => setSelectedPosition(item.position)} onContextMenu={(event) => openSlaveContextMenu(event, item.position)} sx={{ mb: 0.25, py: 0.55, px: 0.75 }}><ListItemIcon sx={{ minWidth: 32, alignItems: "center" }}>
                  <Box sx={{ position: "relative", display: "inline-flex" }}>
                    <DeveloperBoardRounded className="slave-state-icon" data-state={item.state_error ? 0 : item.state} sx={{ fontSize: 22 }} />
                    {!item.state_error && Boolean((item.raw_state ?? item.state) & 0x10) && <WarningAmberRounded titleAccess="状态错误" color="error" sx={{ position: "absolute", right: -4, top: -5, fontSize: 13, bgcolor: "background.paper", borderRadius: "50%" }} />}
                  </Box>
                </ListItemIcon><ListItemText primary={`${item.position}. ${slaveDisplayName(item)}`} secondary={`${item.state_error ? "状态暂不可用" : item.state === 0 ? "—" : stateLabel(item.state)}${!item.state_error && (item.raw_state ?? item.state) & 0x10 ? " + ERROR" : ""} · SM Size IN ${item.input_size ?? "—"} B OUT ${item.output_size ?? "—"} B · ${item.chip_model}`} primaryTypographyProps={{ noWrap: true, fontWeight: 650, fontSize: 12.5 }} secondaryTypographyProps={{ noWrap: true, fontSize: 11.5 }} /></ListItemButton>)}</List></Box>}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {slave && <Stack direction="row" alignItems="center" gap={1} sx={{ px: 2, py: page === "overview" ? 1.5 : 0.75, borderBottom: page === "overview" ? 0 : 1, borderColor: "divider", bgcolor: page === "overview" ? "background.default" : "background.paper" }}>
            {page === "overview" && <Typography variant="h5" fontWeight={750} sx={{ mr: 1 }}>设备概览</Typography>}
            {status.slaves.length > 0 && <Tooltip title={slaveListExpanded ? "收起从站列表" : "展开从站列表"}><IconButton size="small" aria-label={slaveListExpanded ? "收起从站列表" : "展开从站列表"} onClick={() => setSlaveListExpanded((value) => !value)}>{slaveListExpanded ? <ChevronLeftRounded /> : <MenuRounded />}</IconButton></Tooltip>}
            <Typography variant="body2" fontWeight={650} noWrap onContextMenu={(event) => openSlaveContextMenu(event, slave.position)} sx={{ minWidth: 0 }} title={slaveDisplayName(slave)}>从站 {slave.position} · {slaveDisplayName(slave)}</Typography>
            {page !== "overview" && (slave.state_error ? <Chip size="small" label="—" /> : <StateChip state={slave.state} error={Boolean((slave.raw_state ?? slave.state) & 0x10)} />)}
            {page === "overview" && <Button size="small" sx={{ ml: "auto" }} disabled={busy} startIcon={<RefreshRounded className={busy ? "operation-icon-spinning" : undefined} />} onClick={() => run(refreshStates)}>刷新状态</Button>}
          </Stack>}
        <Box component="main" sx={{ flex: 1, minWidth: 0, overflow: "auto", p: { xs: 1.5, xl: 2 } }}><Box sx={{ width: "100%", maxWidth: 1840, mx: "auto" }}>{bridgeExit && <Alert severity="error" action={bridgeExit.log_path ? <Button color="inherit" size="small" onClick={() => revealPath(bridgeExit.log_path!)}>打开日志</Button> : undefined} sx={{ mb: 1.25 }}><Typography fontWeight={700}>通信服务已退出</Typography><Typography variant="body2">软件将尝试恢复连接，请重新读取设备状态后再操作。</Typography>{bridgeExit.log_path && <Typography variant="caption" className="mono" sx={{ overflowWrap: "anywhere" }}>日志：{bridgeExit.log_path}</Typography>}</Alert>}{content}</Box></Box>
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
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>AL 状态码语言</Typography><Typography variant="body2" color="text.secondary">切换概览页 AL 状态名称、说明与排查建议。</Typography></Box><FormControl size="small" sx={{ width: 150 }}><InputLabel>Language</InputLabel><Select label="Language" value={alLanguage} onChange={(event) => { const value = event.target.value as AlStatusLanguage; setAlLanguage(value); window.localStorage.setItem(AL_LANGUAGE_KEY, value); }}><MenuItem value="zh">中文</MenuItem><MenuItem value="en">English</MenuItem></Select></FormControl></Box>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>自动检查更新</Typography><Typography variant="body2" color="text.secondary">开启后发现新版本会显示更新弹窗；关闭后启动时仅在右下角短暂提示，仍可在“关于”页面手动检查。</Typography></Box><Switch checked={autoCheckUpdates} onChange={(event) => { const enabled = event.target.checked; setAutoCheckUpdates(enabled); window.localStorage.setItem(AUTO_UPDATE_KEY, String(enabled)); }} /></Box>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25 }}><Box><Typography fontWeight={700}>EEPROM 写入后复位 ESC</Typography><Typography variant="body2" color="text.secondary">用于 XML/BIN 烧录，默认关闭；关闭后仍会完整回读校验，但不执行 ESC RES 复位、重新发现和重新加载复核。</Typography></Box><Switch checked={eepromAutoReset} disabled={eepromExclusive} onChange={(event) => setEepromAutoReset(saveEepromAutoReset(event.target.checked))} /></Box>
        </Stack> : <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, p: 2, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "#F8FAFF" }}>
            <Box component="img" src={brandIconUrl} alt="BenchCAT" sx={{ width: 72, height: 72, borderRadius: 1.5, display: "block", flexShrink: 0 }} />
            <Box sx={{ minWidth: 0, flex: 1 }}><Stack direction="row" alignItems="center" gap={1}><Typography variant="h6">BenchCAT</Typography><Chip size="small" variant="outlined" label={`v${packageInfo.version}`} /></Stack><Typography variant="body2" color="text.secondary">面向 Windows 的 EtherCAT 从站调试与诊断工作台</Typography></Box>
          </Box>
          <Typography variant="body2" color="text.secondary">聚焦从站概览、ESC 标准寄存器诊断与 EEPROM 原始读取、BIN 文件导出及 XML/BIN 烧录。硬件通信由独立 Python Bridge 与 Worker 串行执行。</Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1.2 }}>
            {[["版本", packageInfo.version], ["通信核心", "pySOEM 1.1.13"], ["许可证", "PolyForm NC 1.0"]].map(([label, value]) => <Box key={label} sx={{ p: 1.4, border: 1, borderColor: "divider", borderRadius: 1 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" fontWeight={700} sx={{ mt: 0.3 }}>{value}</Typography></Box>)}
          </Box>
          <Divider />
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button variant="contained" startIcon={<GitHubIcon />} endIcon={<OpenInNewRounded fontSize="small" />} onClick={() => visit(PROJECT_URL)}>GitHub 项目</Button>
            <Button variant="outlined" startIcon={<BugReportRounded />} endIcon={<OpenInNewRounded fontSize="small" />} onClick={() => visit(ISSUES_URL)}>问题反馈</Button>
            <Button variant="outlined" startIcon={updateState === "checking" ? <CircularProgress size={16} /> : <RefreshRounded />} disabled={updateState === "checking" || updating} onClick={() => void checkUpdate()}>{updateState === "checking" ? "正在检查…" : "检查更新"}</Button>
          </Stack>
          {updateState === "latest" && <Alert severity="success">当前已是最新版本。</Alert>}
          {updateState === "error" && updateError && <Alert severity="warning" action={<Button color="inherit" size="small" onClick={() => setUpdateDialogOpen(true)}>查看详情</Button>} sx={{ overflowWrap: "anywhere" }}>软件更新未完成，可查看详情或稍后重试。</Alert>}
          {availableUpdate && updateState === "available" && <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => { setPendingUpdateReminder(false); setUpdateDialogOpen(true); }}>查看更新</Button>}>{ignoredUpdateVersion === availableUpdate.version ? `已忽略 v${availableUpdate.version} 的自动提醒，仍可手动更新。` : `发现 v${availableUpdate.version} 更新。${pendingUpdateReminder ? "设备操作结束后将显示更新弹窗。" : ""}`}</Alert>}
          {updating && <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => setUpdateDialogOpen(true)}>查看进度</Button>}>{UPDATE_STAGE_LABELS[updateState]}，请保持软件运行。</Alert>}
          <Typography variant="caption" color="text.secondary">Copyright © BenchCAT contributors</Typography>
        </Stack>}
      </DialogContent>
      <DialogActions><Button onClick={() => setSettings(false)}>完成</Button></DialogActions>
    </Dialog>
    <UpdateDialog
      open={updateDialogOpen}
      state={updateState}
      update={availableUpdate}
      progress={updateProgress}
      blockedReason={updateBlockedReason}
      error={updateError}
      onClose={closeUpdateDialog}
      onIgnore={ignoreUpdate}
      onInstall={() => void installUpdate()}
      onRetry={() => { if (updateError?.stage === "checking") void checkUpdate(); else void installUpdate(); }}
      onDownloadPage={() => visit(DOWNLOAD_URL)}
    />
    <Stack spacing={1} sx={{ position: "fixed", bottom: 24, right: 24, maxWidth: 440, zIndex: (theme) => theme.zIndex.snackbar }}>
    <Snackbar open={!updateDialogOpen && updating} style={{ position: "static", transform: "none" }}>
      <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => setUpdateDialogOpen(true)}>查看进度</Button>} sx={{ width: 440, "& .MuiAlert-message": { flex: 1 } }}>
        <Typography fontWeight={700}>BenchCAT · {updating ? UPDATE_STAGE_LABELS[updateState] : "在线更新"}</Typography>
        {updateState === "downloading" ? <>
          <Typography variant="body2">{formatBytes(updateProgress.downloaded)}{updateProgress.total > 0 ? ` / ${formatBytes(updateProgress.total)} · ${Math.min(100, Math.round(updateProgress.downloaded / updateProgress.total * 100))}%` : ""}</Typography>
          <LinearProgress aria-label="后台下载进度" variant={updateProgress.total > 0 ? "determinate" : "indeterminate"} value={updateProgress.total > 0 ? Math.min(100, updateProgress.downloaded / updateProgress.total * 100) : undefined} sx={{ mt: 1 }} />
        </> : <Typography variant="body2">{updateState === "installing" ? "即将退出并交由 Windows 安装器继续。" : "正在停止通信并断开设备…"}</Typography>}
      </Alert>
    </Snackbar>
    <Snackbar open={Boolean(progress && !isEepromOperation(progress.operation))} autoHideDuration={progress?.percent === 100 ? 6000 : null} onClose={(_, reason) => { if (reason !== "clickaway" && progress?.percent === 100) setProgress(undefined); }} style={{ position: "static", transform: "none" }}>
      <Alert severity={progress?.tone === "error" ? "error" : progress?.tone === "success" ? "success" : "info"} variant="filled" action={progress && progress.percent < 100 && progress.cancellable !== false ? <Button color="inherit" size="small" onClick={() => bridgeRequest("cancel")}>取消</Button> : undefined} sx={{ width: 440, alignItems: "center" }}>
        <Typography fontWeight={750}>{progress?.stage}</Typography><Typography variant="body2">{progress?.detail}</Typography>{progress && <LinearProgress color="inherit" variant="determinate" value={progress.percent} sx={{ mt: 1, height: 5, borderRadius: 8, bgcolor: "rgba(255,255,255,.25)" }} />}
      </Alert>
    </Snackbar>
    <Snackbar open={Boolean(message && !message.dismissed)} autoHideDuration={5000} onClose={closeMessage} style={{ position: "static", transform: "none" }}><Alert severity={message?.severity} variant="filled" onClose={closeMessage} sx={{ overflowWrap: "anywhere" }}>{message?.text}</Alert></Snackbar>
    </Stack>
  </Box>;
}
