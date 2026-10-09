import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
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
  Stack,
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
  AutoStoriesRounded,
  CloseRounded,
  DashboardRounded,
  DeveloperBoardRounded,
  GitHub as GitHubIcon,
  MemoryRounded,
  PlayArrowRounded,
  RefreshRounded,
  SettingsRounded,
  StopRounded,
  TuneRounded,
  UsbRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import packageInfo from "../package.json";
import { OverviewEeprom } from "./OverviewEeprom";
import type { EepromReadResult } from "./EepromPage";
import { EmptyState, PageTitle, slaveDisplayName, slaveIdentityKey } from "./pageShared";
import { CardHeading } from "./OverviewDisclosure";
import { EscHardwareCard } from "./EscHardwareCard";
import { alStatusInfo, type AlStatusLanguage } from "./alStatus";
import {
  BridgeRequestError,
  bridgeRequest,
  onBridgeEvent,
  onBridgeExited,
  onEepromOpenRequest,
  initialEepromPath,
  openExternal,
  previewMode,
  subscribeBusSnapshot,
  type AdapterInfo,
} from "./api";
import { minimumBusState } from "./busState";
import { operationStore, type BridgeFailure } from "./operationStore";
import { currentAlCode, isSlaveStateUnknown, showSlaveIoSizes, slaveStateLabel } from "./slaveState";
import { messageHistory } from "./messageHistory";
import { MessageHistoryPanel } from "./MessageHistoryPanel";
import { cycleFaultHistory } from "./bridgeHistory";
import { createBridgeStartup } from "./bridgeStartup";
import { loadEepromAutoReset, saveEepromAutoReset } from "./eepromConfig";
import { QuickEepromFlashDialog, type EepromDetailSelection, type EepromProgressState, type EepromLaunchSource } from "./QuickEepromFlashDialog";
import type {
  BridgeEvent,
  BridgeExitInfo,
  OperationProgress,
  PdoEntry,
  SlaveInfo,
  AutoScanResult,
  WorkbenchStatus,
} from "./types";
import { hex, stateLabel } from "./types";
import { checkForUpdate, type AvailableUpdate } from "./updater";

const RegistersPage = lazy(() => import("./RegistersPage").then(module => ({ default: module.RegistersPage })));
const EepromPage = lazy(() => import("./EepromPage").then(module => ({ default: module.EepromPage })));
const SettingsDialog = lazy(() => import("./SettingsDialog").then(module => ({ default: module.SettingsDialog })));
const FeatureGuideDialog = lazy(() => import("./FeatureGuideDialog").then(module => ({ default: module.FeatureGuideDialog })));

const appIconUrl = new URL("../src-tauri/icons/icon.png", import.meta.url).href;

type PageKey = "overview" | "registers" | "eeprom";
type Run = <T>(operation: () => Promise<T>, success?: string, statePositions?: number[]) => Promise<T | undefined>;
interface ToastMessage { text: string; severity: "success" | "error" | "info" | "warning"; record?: boolean; id?: number; historyId?: number }
const PREFERRED_ADAPTER_KEY = "benchcat.preferred-adapter";
const AL_LANGUAGE_KEY = "benchcat.al-language";
const AUTO_UPDATE_KEY = "benchcat.auto-check-updates";
const IGNORED_UPDATE_KEY = "benchcat.ignored-update-version";
const PROJECT_URL = "https://github.com/LINLin190/BenchCAT";
const DOWNLOAD_URL = `${PROJECT_URL}/releases/latest`;

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

function isEepromOperation(operation?: string): boolean {
  return Boolean(operation?.startsWith("eeprom"));
}

function defaultRegisterProfile(chipModel: string | undefined): string {
  if (chipModel === "LAN9252" || chipModel === "E252") return "LAN9252";
  if (chipModel === "LAN9253" || chipModel === "E253") return "LAN9253";
  return "ET1100";
}

function escModelLabel(chipModel: string | undefined, profile: string): string {
  return chipModel === "E252" && profile === "LAN9252" ? "E252" : profile;
}

function StateChip({ state, error = false }: { state: number; error?: boolean }) {
  const color = error ? "error" : state === 8 ? "success" : state === 0 || state === 1 ? "default" : "primary";
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
// Share retry and manual-download guidance while preserving other error details.
function updateFailureMessage(error: UpdateFailure): string {
  const requestStage = error.stage === "checking" || error.stage === "downloading";
  if (requestStage && /error sending request/i.test(error.message)) {
    return `${UPDATE_ERROR_LABELS[error.stage]}。请检查网络连接并稍后重试，或前往 GitHub 手动下载。`;
  }
  return `${UPDATE_ERROR_LABELS[error.stage]}：${error.message}${requestStage ? "。可稍后重试，或前往 GitHub 手动下载。" : ""}`;
}

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
          {state === "error" && error && <Alert severity="warning" sx={{ overflowWrap: "anywhere" }}>{updateFailureMessage(error)}</Alert>}
        </Stack>
      </DialogContent>
      <Box sx={{ px: 3, pt: 1.5 }}>
        <Typography variant="caption" color="text.secondary">{updating
          ? "关闭此弹窗后继续更新，请保持软件运行；安装时软件将退出并自动重新启动。"
          : "更新会停止通信并断开设备，安装时软件将自动重启。忽略本次更新仅关闭该版本的自动提醒。"}</Typography>
      </Box>
      <DialogActions sx={{ px: 3, pb: 2, pt: 1.5, gap: 0.5 }}>
        {state === "available" && <Button onClick={onIgnore} sx={{ mr: "auto" }}>忽略本次更新</Button>}
        {state === "error" && <Button startIcon={<GitHubIcon />} onClick={onDownloadPage} sx={{ mr: "auto" }}>GitHub 手动下载</Button>}
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

const OverviewPage = memo(function OverviewPage({ slave, status, busy, stateRequestBusy, run, refresh, registerProfile, onRegisterProfileChange, alLanguage }: { slave?: SlaveInfo; status: WorkbenchStatus; busy: boolean; stateRequestBusy: boolean; run: Run; refresh: () => Promise<void>; registerProfile: string; onRegisterProfileChange: (profile: string) => void; alLanguage: AlStatusLanguage }) {
  const [switchingProfile, setSwitchingProfile] = useState<string>();
  const requestState = (state: number) => run(
    () => bridgeRequest<SlaveInfo[]>("request_state", { position: slave?.position ?? 0, state }),
    undefined, slave ? [slave.position] : [],
  );
  const repair = (method: "recover", success: string) => slave && run(
    () => bridgeRequest<{ slaves: SlaveInfo[] }>(method, { position: slave.position }),
    success,
  );
  const changeEscModel = async (profile: string) => {
    if (!slave || profile === registerProfile || switchingProfile) return;
    setSwitchingProfile(profile);
    try {
      const result = await run(
        () => bridgeRequest<{ succeeded: boolean; slaves: SlaveInfo[] }>("reconfig", { position: slave.position }, { profileChange: { from: registerProfile, to: profile } }),
        `从站 ${slave.position} 已完成重配置，ESC 型号切换为 ${escModelLabel(slave.chip_model, profile)}`,
      );
      if (result) onRegisterProfileChange(profile);
    } finally {
      setSwitchingProfile(undefined);
    }
  };
  const alCode = slave ? currentAlCode(slave) : undefined;
  const alInfo = alStatusInfo(alCode ?? 0, alLanguage);
  return (
    <>
      {!slave && <PageTitle title="设备概览" subtitle="总线状态与设备信息" actions={<Button disabled={busy} startIcon={<RefreshRounded className={busy ? "operation-icon-spinning" : undefined} />} onClick={() => run(refresh)}>刷新状态</Button>} />}
      {!slave ? <EmptyState text="连接并扫描后，在左侧选择一个从站" /> : (
        <Stack spacing={1.25} className="overview-cards">
          {slave.scan_errors?.some(error => !error.includes("0x0130") && !error.includes("0x0134") && !error.includes("AL 状态值")) && <Alert severity="warning">部分设备信息未能读取，可重新扫描。</Alert>}
          <Box className="overview-grid">
            <Card sx={cardSx} className="ov-runtime"><CardContent className="ov-card-body">
              <CardHeading title="状态" />
              <Box className="ov-runtime-facts">
                <Typography className="section-label">当前状态</Typography>
                {isSlaveStateUnknown(slave) ? <Chip size="small" color="warning" label="未知状态" /> : <StateChip state={slave.state} error={Boolean((slave.raw_state ?? slave.state) & 0x10)} />}
                <Typography className="section-label">AL 状态码</Typography>
                <Typography className="mono ov-strong">{alCode === undefined ? "未取得有效读数" : `${hex(alCode)} · ${alInfo.name}`}</Typography>
                <Typography className="ov-pdo-label">SM Size IN <b className="mono">{slave.input_size == null ? "—" : `${slave.input_size} B`}</b> OUT <b className="mono">{slave.output_size == null ? "—" : `${slave.output_size} B`}</b></Typography>
              </Box>
              <Box className="ov-runtime-actions">
                <Typography className="section-label">状态请求</Typography>
                <StateSelector key={`${status.session_id}:${slaveIdentityKey(slave)}`} state={isSlaveStateUnknown(slave) ? undefined : slave.state} disabled={busy || stateRequestBusy} onRequest={requestState} label="从站状态请求" className="overview-state-buttons" />
                <Tooltip title={status.cycle_running ? "请先请求 SAFE-OP，再清除从站状态错误。" : "确认当前从站的状态错误，保持当前状态"}>
                  <span><Button className="overview-clear-error" size="small" variant="outlined" disabled={busy || status.cycle_running} onClick={() => run(() => bridgeRequest<SlaveInfo[]>("clear_error", { position: slave.position }), "已确认从站状态错误")}>Clear Error</Button></span>
                </Tooltip>
                <Tooltip title={status.cycle_running ? "请先请求 SAFE-OP；停止周期通信将影响整条总线。" : busy ? "操作进行中" : ""}>
                <Stack direction="row" gap={0.75} className="ov-repair-actions">
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
        </Stack>
      )}
    </>
  );
});

function CoePage({ slave, run }: { slave?: SlaveInfo; run: Run }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [index, setIndex] = useState("0x1000");
  const [subindex, setSubindex] = useState("0");
  const [data, setData] = useState("");
  const load = () => slave && run(() => bridgeRequest<Record<string, unknown>[]>("object_dictionary", { position: slave.position }).then((value) => { setRows(value); return value; }));
  const writeSdo = () => slave && run(async () => {
    const result = await bridgeRequest<{ verified: boolean }>("sdo_write", { position: slave.position, index: Number(index), subindex: Number(subindex), data });
    if (!result.verified) {
      const error = new BridgeRequestError({ code: "SDO_WRITE_MISMATCH", message: "SDO readback mismatch", user_message: `从站 ${slave.position}：SDO 写入未完成；写入值与回读值不一致` });
      error.historyRecorded = true;
      throw error;
    }
    return result;
  }, "写入完成；回读一致");
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
            <Button variant="contained" disabled={!data.trim()} onClick={writeSdo}>写入并验证</Button>
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

export default function App() {
  const reloadAdaptersRef = useRef<() => void>(() => undefined);
  const requestedPage = new URLSearchParams(window.location.search).get("page") as PageKey | null;
  const [page, setPage] = useState<PageKey>(pages.some((item) => item.key === requestedPage) ? requestedPage! : "overview");
  const [status, setStatus] = useState<WorkbenchStatus>({ host_generation: 0, mode: "real", phase: "disconnected", connected: false, cycle_running: false, slaves: [], session_id: 0, revision: 0 });
  const startupEepromPath = initialEepromPath();
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adapter, setAdapter] = useState("");
  const [adaptersLoading, setAdaptersLoading] = useState(true);
  const [adapterLoadError, setAdapterLoadError] = useState<string>();
  const [selectedPosition, setSelectedPosition] = useState<number | undefined>(() => startupEepromPath ? 1 : undefined);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [bridgeStarting, setBridgeStarting] = useState(true);
  const [bridgeExit, setBridgeExit] = useState<BridgeExitInfo>();
  const [messages, setMessages] = useState<Array<ToastMessage & { id: number }>>([]);
  const toastSequence = useRef(0);
  const backgroundErrorRecorded = useRef(false);
  const cycleFaultRecorded = useRef(false);
  const setMessage = useCallback((value: ToastMessage) => {
    let historyId = value.historyId;
    if (value.record !== false && (value.severity === "error" || value.severity === "warning")) {
      const [text, ...remaining] = value.text.split("。");
      const reason = remaining.filter(Boolean).join("。");
      historyId = messageHistory.append({ operation: "通知", result: value.severity, text, reason: reason || undefined, details: reason ? [value.text] : undefined })?.id;
    } else if (!historyId && (value.severity === "error" || value.severity === "warning")) {
      const latest = messageHistory.snapshot().entries[0];
      if (latest && Date.now() - latest.time < 1000 && [latest.text, latest.reason, ...(latest.details ?? [])].includes(value.text)) historyId = latest.id;
    }
    const id = ++toastSequence.current;
    setMessages(queue => [...queue, { ...value, historyId, id }]);
  }, []);
  const consumeMessages = useCallback((throughId: number) => setMessages(queue => queue.filter(message => message.id > throughId)), []);
  const [stateFailures, setStateFailures] = useState<Record<number, BridgeFailure>>({});
  const [settings, setSettings] = useState(false);
  const [featureGuideOpen, setFeatureGuideOpen] = useState(false);
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
  const [quickFlashOpen, setQuickFlashOpen] = useState(() => Boolean(startupEepromPath));
  const [quickFlashSource, setQuickFlashSource] = useState<EepromLaunchSource | undefined>(() => startupEepromPath ? { path: startupEepromPath } : undefined);
  const [pendingFlashSource, setPendingFlashSource] = useState<EepromLaunchSource>();
  const [quickFlashBusy, setQuickFlashBusy] = useState(false);
  const consumeQuickFlashSource = useCallback(() => setQuickFlashSource(undefined), []);
  const [eepromDetailSelection, setEepromDetailSelection] = useState<EepromDetailSelection>();
  const [eepromReadCache, setEepromReadCache] = useState<Record<string, EepromReadResult>>({});
  const [progress, setProgress] = useState<EepromProgressState>();
  const [registerProfileOverrides, setRegisterProfileOverrides] = useState<Record<string, string>>({});
  const appliedClockRef = useRef<{ hostGeneration: number; sessionId: number } | undefined>(undefined);
  const slave = status.slaves.find((item) => item.position === selectedPosition);
  const selectedSlaveKey = slaveIdentityKey(slave);
  const eepromReadCacheKey = `${status.host_generation}:${status.session_id}:${selectedSlaveKey}`;
  const registerProfile = slave ? registerProfileOverrides[selectedSlaveKey] ?? defaultRegisterProfile(slave.chip_model) : "ET1100";
  const { stateRequestBusy, hardwareBusy, scanning, connecting, configSaveBusy, disconnectHardwareBusy } = useSyncExternalStore(operationStore.subscribeActivity, operationStore.activitySnapshot);
  const eepromExclusive = isEepromOperation(progress?.operation) && progress!.percent < 100;
  const updating = isUpdateInProgress(updateState);
  const busy = hardwareBusy || updating;
  // A disconnect cancels pending register frames before closing the same Worker.
  const disconnectBusy = updating || disconnectHardwareBusy;
  const updateBlockedReason = eepromExclusive
    ? "EEPROM 操作进行中，完成后即可更新。"
    : hardwareBusy || stateRequestBusy ? "设备操作进行中，完成后即可更新。" : "";
  const busState = status.slaves.some(isSlaveStateUnknown) ? undefined : minimumBusState(status.slaves);
  const linkDisconnected = status.slaves.some((item) => item.state_error_kind === "link_disconnected");
  useEffect(() => { if (status.cycle_running) cycleFaultRecorded.current = false; }, [status.cycle_running]);
  const connectionObservation = useRef<{ service?: boolean; link?: boolean }>({});
  const serviceFault = useRef<{ text: string; details: string[] }>({ text: "通信服务不可用，请重新启动软件。", details: [] });
  useEffect(() => {
    const previous = connectionObservation.current;
    if (!bridgeStarting) {
      if (!bridgeAvailable && previous.service !== false) messageHistory.append({ operation: "通信服务", result: "error", text: serviceFault.current.text.split("。")[0], details: serviceFault.current.details });
      previous.service = bridgeAvailable;
    }
    if (status.connected) {
      const context = status.adapter ? `网卡：${adapters.find(adapter => adapter.name === status.adapter)?.description || status.adapter}` : undefined;
      if (linkDisconnected && previous.link !== false) messageHistory.append({ operation: "网卡链路", result: "error", text: "网卡链路未连接", context });
      previous.link = !linkDisconnected;
    } else previous.link = undefined;
  }, [bridgeStarting, bridgeAvailable, status.connected, status.adapter, linkDisconnected, adapters]);
  const busStateBlockedReason = !bridgeAvailable
    ? "暂时无法连接设备，请重启软件后重试。"
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

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void onEepromOpenRequest((path) => {
      if (!active) return;
      setQuickFlashOpen(true);
      setPendingFlashSource({ path });
    }).then((stop) => { if (active) unlisten = stop; else stop(); })
      .catch(() => { if (active) setMessage({ text: "无法接收 XML 右键烧录请求，请重新打开软件。", severity: "error" }); });
    return () => { active = false; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!pendingFlashSource || eepromExclusive || configSaveBusy || quickFlashBusy || updating) return;
    setSelectedPosition(1);
    setQuickFlashSource(pendingFlashSource);
    setPendingFlashSource(undefined);
  }, [pendingFlashSource, eepromExclusive, configSaveBusy, quickFlashBusy, updating]);

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
      setStateFailures({});
    }
  }), []);

  const refresh = useCallback(async () => {
    await bridgeRequest<WorkbenchStatus>("status");
  }, []);

  const reportRegisterError = useCallback((text: string) => setMessage({ text, severity: "error", record: false }), [setMessage]);

  const run: Run = useCallback(async (operation, success, statePositions) => {
    const clock = operationStore.context();
    try {
      const result = await operation();
      backgroundErrorRecorded.current = false;
      const currentClock = operationStore.context();
      if (statePositions && clock.hostGeneration === currentClock.hostGeneration && clock.sessionId === currentClock.sessionId) {
        setStateFailures(current => Object.fromEntries(Object.entries(current).filter(([position]) => !statePositions.includes(Number(position)))));
      }
      if (success) setMessage({ text: success, severity: "success", record: false });
      return result;
    } catch (error) {
      const text = error instanceof BridgeRequestError ? error.message : "操作未完成，请检查当前连接和操作条件。";
      const cancelled = error instanceof BridgeRequestError && error.code === "CANCELLED";
      const failure = error instanceof BridgeRequestError ? error.failure : undefined;
      const currentClock = operationStore.context();
      const sameSession = clock.hostGeneration === currentClock.hostGeneration && clock.sessionId === currentClock.sessionId;
      const positions = statePositions && sameSession && !cancelled ? failure?.details?.positions ?? statePositions : [];
      if (failure && positions.length) setStateFailures(current => ({ ...current, ...Object.fromEntries(positions.map(position => [position, failure])) }));
      setMessage({ text: cancelled ? `已取消：${text}` : text, severity: cancelled ? "info" : "error", record: !(error instanceof BridgeRequestError && error.historyRecorded) });
      if (cancelled) return undefined;
      if (!statePositions) setProgress((previous) => previous ? { ...previous, stage: "操作失败", detail: text, tone: "error" } : previous);
      return undefined;
    }
  }, [setMessage]);

  const refreshStates = useCallback(async () => {
    if (!status.connected || !status.slaves.length) {
      await refresh();
      return;
    }
    await bridgeRequest<SlaveInfo[]>("read_states", { refresh_eeprom: true });
  }, [refresh, status.connected, status.slaves.length]);

  const applyAdapters = useCallback((items: AdapterInfo[], selected?: string) => {
    const ordered = orderAdapters(items);
    const preferred = selected || window.localStorage.getItem(PREFERRED_ADAPTER_KEY) || "";
    setAdapters(ordered);
    setAdapter(ordered.some((item) => item.name === preferred) ? preferred : ordered[0]?.name ?? "");
    setAdapterLoadError(items.length ? undefined : "未找到可用网卡。请确认网卡已启用，然后重新加载网卡。");
  }, []);

  const applyAutoScan = useCallback((result: AutoScanResult) => {
    if (result.connected && result.slaves.length) {
      if (result.selected_adapter) window.localStorage.setItem(PREFERRED_ADAPTER_KEY, result.selected_adapter);
      const adapterName = result.adapters.find((item) => item.name === result.selected_adapter)?.description
        || result.selected_adapter;
      setMessage({ text: `已在 ${adapterName} 上发现 ${result.slaves.length} 个从站`, severity: "success", record: false });
      return;
    }

    if (!result.adapters.length) {
      return;
    }
    const failed = result.attempts.filter((attempt) => attempt.error);
    const openedWithoutSlaves = result.attempts.filter((attempt) => !attempt.error && attempt.slave_count === 0);
    if (failed.length && failed.length === result.attempts.length) {
      setMessage({ text: "网卡扫描未完成。请检查网卡连接；如果反复出现，请记录操作步骤并反馈。", severity: "error", record: false });
    } else if (failed.length && openedWithoutSlaves.length) {
      setMessage({ text: "未扫描到从站，部分网卡的扫描也未完成。请检查网卡连接后重试。", severity: "warning", record: false });
    } else if (openedWithoutSlaves.length) {
      setMessage({ text: "未扫描到从站", severity: "info", record: false });
    } else {
      setMessage({ text: "自动扫描未发现从站。请确认设备已连接并通电，再重新扫描。", severity: "info", record: false });
    }
  }, []);

  useEffect(() => {
    const disableBrowserContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", disableBrowserContextMenu);
    return () => document.removeEventListener("contextmenu", disableBrowserContextMenu);
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    const startup = createBridgeStartup({
      preferredAdapter: () => window.localStorage.getItem(PREFERRED_ADAPTER_KEY) ?? "",
      onAdapters: applyAdapters,
      onScan: applyAutoScan,
      onLoading: setAdaptersLoading,
      onError: (text) => {
        setAdapterLoadError(text);
      },
    });
    reloadAdaptersRef.current = startup.reloadAdapters;
    const eventReady = onBridgeEvent((event: BridgeEvent) => {
      if (!active) return;
      if (event.kind === "host_ready") {
        const generation = event.host_generation
          ?? (event.data as { host_generation?: number } | undefined)?.host_generation ?? 0;
        if (!startup.ready(generation)) return;
        setAdapters([]);
        setAdapter("");
        setBridgeAvailable(true);
        setBridgeStarting(false);
        setBridgeExit(undefined);
        backgroundErrorRecorded.current = false;
        setMessages(queue => queue.filter(message => message.text !== "暂时无法连接设备，请重启软件后重试。"));
      }
      if (event.kind === "host_restart_failed") {
        const data = event.data as { message?: string; reason?: string } | undefined;
        serviceFault.current = { text: "通信服务未能启动，请重新启动软件。", details: [data?.message, data?.reason].filter((text): text is string => Boolean(text)) };
        startup.unavailable();
        setAdapters([]);
        setAdapter("");
        setBridgeAvailable(false);
        setBridgeStarting(false);
        console.error("Bridge startup failed", event.data);
      }
      if (event.kind === "heartbeat") {
        // Heartbeat is telemetry only. Command responses and bus_snapshot events
        // are the authoritative source of EtherCAT session and state.
      }
      if (event.kind === "cycle_fault" && !cycleFaultRecorded.current) {
        cycleFaultRecorded.current = true;
        const fault = messageHistory.append(cycleFaultHistory(event.data));
        setMessage({ text: "周期通信已中断，无法继续交换数据。请刷新从站状态后再操作。", severity: "error", record: false, historyId: fault?.id });
      }
      // Background observations update the snapshot without replacing operation notifications.
      if (event.kind === "worker_fatal") {
        const text = "通信服务已停止，请重新启动软件。";
        const data = event.data as { message?: string; reason?: string } | undefined;
        serviceFault.current = { text, details: (typeof event.data === "string" ? [event.data] : [data?.message, data?.reason]).filter((text): text is string => Boolean(text)) };
        console.error("Bridge worker stopped", event.data);
        startup.unavailable();
        setBridgeAvailable(false);
        operationStore.invalidate("WORKER_FATAL", text);
        setSelectedPosition(undefined);
        setSnapshot(undefined);
        setRegisterProfileOverrides({});
        setProgress((previous) => previous && previous.percent < 100 ? { ...previous, completed: previous.total, percent: 100, stage: "通信服务已停止", detail: text, tone: "error", cancellable: false } : previous);
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
          setMessage({ text: `已发现 ${discovered.length} 个从站，正在读取设备信息…`, severity: "info", record: false });
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
      if (event.kind === "error" && !operationStore.active() && !backgroundErrorRecorded.current) {
        backgroundErrorRecorded.current = true;
        setMessage({ text: "后台操作遇到问题。请刷新状态；如果反复出现，请记录操作步骤并反馈。", severity: "error" });
      }
    }).then((value) => { if (active) unlisten = value; else value(); });
    const exitReady = onBridgeExited((info) => {
      if (!active) return;
      serviceFault.current = { text: "通信服务已停止，请重新启动软件。", details: [info.message, info.reason,
        info.exit_code !== undefined ? `退出码：${info.exit_code}` : undefined, info.log_path ? `日志路径：${info.log_path}` : undefined].filter((text): text is string => Boolean(text)) };
      startup.unavailable();
      setAdapters([]);
      setAdapter("");
      setBridgeAvailable(false);
      setBridgeStarting(false);
      setBridgeExit(info);
      operationStore.invalidate("PROCESS_EXITED", "通信服务已停止");
      setProgress((previous) => previous && previous.percent < 100 ? {
        ...previous,
        completed: previous.total,
        percent: 100,
        stage: "通信服务已停止",
        detail: "写入结果尚未确认，请先读取设备确认结果，再继续操作。",
        tone: "error",
        cancellable: false,
      } : previous);
      setSelectedPosition(undefined);
      setSnapshot(undefined);
      setRegisterProfileOverrides({});
    }).then((value) => { if (active) unlistenExit = value; else value(); });
    Promise.all([eventReady, exitReady]).then(() => {
      if (active) startup.subscribed();
    }).catch((error) => {
      if (!active) return;
      startup.unavailable();
      active = false;
      startup.dispose();
      unlisten?.();
      unlistenExit?.();
      unlisten = undefined;
      unlistenExit = undefined;
      setBridgeAvailable(false);
      setBridgeStarting(false);
      console.error("Bridge event subscriptions failed", error);
    });
    return () => { active = false; startup.dispose(); reloadAdaptersRef.current = () => undefined; unlisten?.(); unlistenExit?.(); };
  }, [applyAdapters, applyAutoScan]);

  const connect = async () => {
    if (status.connected) await run(() => bridgeRequest("disconnect"), "已断开网卡");
    else if (await run(() => bridgeRequest("connect", { adapter }))) await scan();
  };
  const checkUpdate = useCallback(async (automatic = false) => {
    if (automatic && startupUpdateCheckedRef.current) return true;
    if (updateTaskRef.current) return false;
    // Manual checks take over from startup retries, including manual failures.
    if (!automatic) startupUpdateCheckedRef.current = true;
    updateTaskRef.current = true;
    setPendingUpdateReminder(false);
    setUpdateError(undefined);
    setAvailableUpdate(undefined);
    setUpdateState("checking");
    try {
      const update = await checkForUpdate();
      startupUpdateCheckedRef.current = true;
      if (!update) {
        setUpdateState("latest");
        setUpdateDialogOpen(false);
        if (!automatic) setMessage({ text: `当前已是最新版本 v${packageInfo.version}`, severity: "info" });
        return true;
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
      return true;
    } catch (error) {
      if (automatic) {
        setUpdateState("idle");
        return false;
      }
      setUpdateState("error");
      setUpdateError({ stage: "checking", message: error instanceof Error ? error.message : String(error) });
      setUpdateDialogOpen(true);
      return true;
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
  // Retry silent startup failures with increasing intervals, stopping on success or manual takeover.
  useEffect(() => {
    let cancelled = false;
    let retryDelay = 30_000;
    const attempt = async () => {
      const complete = await checkUpdate(true);
      if (cancelled || complete) return;
      timer = window.setTimeout(() => { void attempt(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5 * 60_000);
    };
    let timer = window.setTimeout(() => { void attempt(); }, 25_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [checkUpdate]);
  const scan = async () => {
    const found = await run(() => bridgeRequest<SlaveInfo[]>("scan"));
    if (found) setMessage({ text: found.length ? `扫描完成，发现 ${found.length} 个从站` : "未扫描到从站", severity: found.length ? "success" : "info", record: false });
  };
  const requestBusState = (state: number) => run(
    () => bridgeRequest<SlaveInfo[]>("request_state", { position: 0, state }),
    undefined, status.slaves.map(item => item.position),
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
  // Clearing a snapshot must also remove its cached copy after programming.
  const setSelectedEepromReadResult = useCallback((value?: EepromReadResult) => {
    setEepromReadCache((current) => {
      if (value) return { ...current, [eepromReadCacheKey]: value };
      const next = { ...current };
      delete next[eepromReadCacheKey];
      return next;
    });
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

  // Keep page and settings controls on the same persisted reset preference.
  const changeEepromAutoReset = useCallback((value: boolean) => setEepromAutoReset(saveEepromAutoReset(value)), []);

  const changeRegisterProfile = useCallback((profile: string) => {
    if (slave) setRegisterProfileOverrides(current => ({ ...current, [selectedSlaveKey]: profile }));
  }, [slave, selectedSlaveKey]);

  const content = useMemo(() => {
    const props = { slave, run };
    if (page === "overview") return <OverviewPage {...props} status={status} busy={busy} stateRequestBusy={stateRequestBusy} refresh={refreshStates} registerProfile={registerProfile} alLanguage={alLanguage} onRegisterProfileChange={changeRegisterProfile} />;
    if (page === "registers") return <RegistersPage key={`${status.host_generation}:${status.session_id}:${selectedSlaveKey}:${registerProfile}`} {...props} onError={reportRegisterError} registerProfile={registerProfile} deviceOperationsBlocked={updating} sessionContext={`${status.host_generation}:${status.session_id}`} />;
    return <EepromPage {...props} status={status} progress={progress} setProgress={setProgress} readResult={eepromReadCache[eepromReadCacheKey]} setReadResult={setSelectedEepromReadResult} initialSelection={eepromDetailSelection} onInitialSelectionConsumed={consumeEepromDetailSelection} autoResetEsc={eepromAutoReset} onAutoResetChange={changeEepromAutoReset} fileDropEnabled={!quickFlashOpen} deviceOperationsBlocked={updating} />;
  }, [page, changeRegisterProfile, registerProfile, selectedSlaveKey, selectedPosition, slave, status, progress, refreshStates, run, reportRegisterError, busy, stateRequestBusy, updating, alLanguage, eepromAutoReset, changeEepromAutoReset, quickFlashOpen, eepromReadCache, eepromReadCacheKey, eepromDetailSelection, setSelectedEepromReadResult, consumeEepromDetailSelection]);

  return <Box sx={{ display: "flex", height: "100vh", bgcolor: "background.default" }}>
    <Drawer variant="permanent" PaperProps={{ sx: { width: 64, borderRight: 1, borderColor: "divider", bgcolor: "#FBFCFE", overflow: "hidden" } }}>
      <Toolbar sx={{ minHeight: "54px !important", px: "11px !important", gap: 0.75 }}>
        <Box component="img" src={appIconUrl} alt="BenchCAT" sx={{ width: 42, height: 42, borderRadius: 1.2, display: "block", flexShrink: 0 }} />
      </Toolbar>
      <Divider />
      <List sx={{ px: 0.6, pt: 1.25 }}>{pages.map((item) => <Tooltip key={item.key} title={item.label} placement="right"><span><ListItemButton aria-label={item.label} disabled={(updateState === "preparing" && item.key !== page) || (eepromExclusive && item.key !== "eeprom")} selected={page === item.key} onClick={() => navigate(item.key)} key={item.key} sx={{ minHeight: 52, mb: 0.3, px: 0.3, py: 0.6, flexDirection: "column", gap: 0.45, color: page === item.key ? "primary.main" : "text.secondary" }}><ListItemIcon sx={{ minWidth: 0, color: "inherit" }}>{item.icon}</ListItemIcon><Typography sx={{ fontSize: 11, lineHeight: 1.3, fontWeight: page === item.key ? 700 : 500 }}>{item.label}</Typography></ListItemButton></span></Tooltip>)}</List>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <List sx={{ p: 0.6 }}>
        <Tooltip title="功能导览" placement="right"><ListItemButton aria-label="功能导览" onClick={() => setFeatureGuideOpen(true)} sx={{ minHeight: 52, mb: 0.3, px: 0.3, py: 0.6, flexDirection: "column", gap: 0.45, color: "text.secondary" }}><ListItemIcon sx={{ minWidth: 0, color: "inherit" }}><AutoStoriesRounded sx={{ fontSize: 21 }} /></ListItemIcon><Typography sx={{ fontSize: 11, lineHeight: 1.3 }}>导览</Typography></ListItemButton></Tooltip>
        <Tooltip title={"设置"} placement="right"><ListItemButton aria-label="设置" onClick={() => { setSettings(true); }} sx={{ width: 42, height: 42, minHeight: 42, mx: "auto", p: 0, justifyContent: "center", color: "text.secondary" }}><ListItemIcon sx={{ minWidth: 0, color: "inherit" }}><SettingsRounded sx={{ fontSize: 21 }} /></ListItemIcon></ListItemButton></Tooltip>
      </List>
    </Drawer>
    <Box sx={{ ml: "64px", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <AppBar className="workbench-toolbar" position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider", bgcolor: "rgba(255,255,255,.96)" }}>
        <Toolbar sx={{ minHeight: "54px !important", columnGap: 0.65, rowGap: 0.65, px: "10px !important", py: 0.45, flexWrap: "wrap", alignContent: "center", "&:hover .connection-disconnect:not(.Mui-disabled)": { color: "error.main", borderColor: "error.main", transitionDelay: "300ms, 300ms, 0s" } }}>
          <Stack sx={{ width: 170, minWidth: 0, flexShrink: 0 }} spacing={0.15}>
            <Stack direction="row" gap={0.6} alignItems="center" flexWrap="wrap">
              <Chip size="small" color={!bridgeAvailable ? bridgeStarting ? "default" : "error" : status.connected ? "success" : "default"} variant={status.connected ? "filled" : "outlined"} label={!bridgeAvailable ? bridgeStarting ? "正在启动" : "连接暂不可用" : status.connected ? "网卡已连接" : "网卡未连接"} />
              {status.mode === "demo" && <Chip size="small" color="warning" label="Demo" />}
              {previewMode && <Chip size="small" variant="outlined" label="预览" />}
            </Stack>
            <Typography variant="caption" color="text.secondary" noWrap>{!bridgeAvailable ? bridgeStarting ? "正在准备连接，请稍候" : "请重启软件后重试" : status.connected ? status.slaves.length ? `已发现 ${status.slaves.length} 个从站` : "暂无从站" : "检测网卡并自动扫描 EtherCAT 从站"}</Typography>
          </Stack>
          {status.connected && status.slaves.length > 0 && status.slaves.length !== 1 && <Box sx={{ pl: 1, borderLeft: 1, borderColor: "divider", flexShrink: 0 }}>
            <Tooltip title={busStateBlockedReason || `全部从站状态控制 · 当前 ${busState === undefined ? "未知状态" : stateLabel(busState)}`}>
              <span>
                <StateSelector key={status.session_id} state={busState} disabled={Boolean(busStateBlockedReason)} onRequest={requestBusState} label="全部从站状态控制" />
              </span>
            </Tooltip>
          </Box>}
          <Box sx={{ display: "flex", alignItems: "center", alignContent: "center", justifyContent: "flex-end", flex: "0 1 auto", minWidth: 0, ml: "auto", flexWrap: "wrap", gap: 0.65 }}>
            <FormControl size="small" sx={{ width: 230, minWidth: 170 }}><Select displayEmpty inputProps={{ "aria-label": "网卡" }} MenuProps={{ PaperProps: { sx: { width: 230, maxWidth: 230 } } }} value={adapter} disabled={!bridgeAvailable || adaptersLoading || eepromExclusive || status.connected || busy} onChange={(e) => selectAdapter(e.target.value)}>{adapters.map((item) => <MenuItem value={item.name} key={item.name} title={item.description || item.name} sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{item.description || item.name}</MenuItem>)}</Select></FormControl>
            <Button className={status.connected && status.slaves.length > 0 ? "connection-disconnect" : undefined} size="small" variant={status.connected ? "outlined" : "contained"} color={status.connected ? "error" : "primary"} startIcon={connecting ? <CircularProgress size={18} color="inherit" /> : <UsbRounded />} disabled={!bridgeAvailable || eepromExclusive || (status.connected ? disconnectBusy : busy || adaptersLoading) || (!status.connected && !adapter)} onClick={connect} sx={{ flexShrink: 0, whiteSpace: "nowrap", ...(status.connected && status.slaves.length > 0 ? { color: "text.secondary", borderColor: "divider", transition: "color 0s 800ms, border-color 0s 800ms, background-color 150ms", "&.Mui-disabled": { transition: "none" } } : {}) }}>{status.connected ? "断开" : "连接"}</Button>
            <Button size="small" variant="outlined" startIcon={<RefreshRounded className={scanning ? "operation-icon-spinning" : undefined} />} disabled={!bridgeAvailable || adaptersLoading || eepromExclusive || busy || !status.connected || status.cycle_running} onClick={scan} sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>{scanning ? "扫描中…" : status.slaves.length > 0 ? "重扫" : "扫描"}</Button>
          </Box>
        </Toolbar>
      </AppBar>
      {bridgeAvailable && adapterLoadError && <Alert severity="error" sx={{ borderRadius: 0, flexShrink: 0 }} action={<Button color="inherit" size="small" disabled={!bridgeAvailable || adaptersLoading || eepromExclusive || busy} onClick={() => reloadAdaptersRef.current()}>重新加载网卡</Button>}>{adapterLoadError}</Alert>}
      {bridgeAvailable && linkDisconnected && <Alert severity="error" sx={{ borderRadius: 0, flexShrink: 0 }}>网卡链路未连接，请检查网卡连接。</Alert>}
      {!bridgeStarting && !bridgeAvailable && <Alert severity="error" sx={{ borderRadius: 0, flexShrink: 0 }}>{bridgeExit ? "通信服务已停止" : "通信服务不可用"}，请重新启动软件。</Alert>}
      <Box sx={{ display: "flex", minHeight: 0, flex: 1 }}>
        {status.slaves.length > 0 && <Box component="aside" sx={{ width: { xs: 190, xl: 204 }, flexShrink: 0, bgcolor: "background.paper", borderRight: 1, borderColor: "divider", overflow: "auto", p: 0.75 }}><Stack direction="row" justifyContent="space-between" alignItems="center" gap={0.5} sx={{ px: 0.75, py: 0.55 }}><Typography variant="overline" color="text.secondary" sx={{ flexShrink: 0 }}>从站 · {status.slaves.length}</Typography></Stack><List dense sx={{ pt: 0.35 }}>{status.slaves.map((item) => <ListItemButton disabled={eepromExclusive} key={item.position} selected={item.position === selectedPosition} onClick={() => setSelectedPosition(item.position)} onContextMenu={(event) => openSlaveContextMenu(event, item.position)} sx={{ mb: 0.25, py: 0.55, px: 0.75 }}><ListItemIcon sx={{ minWidth: 32, alignItems: "center" }}>
                  <Box sx={{ position: "relative", display: "inline-flex" }}>
                    <DeveloperBoardRounded className="slave-state-icon" data-state={item.state_error ? 0 : item.state} sx={{ fontSize: 22 }} />
                    {!item.state_error && Boolean((item.raw_state ?? item.state) & 0x10) && <WarningAmberRounded titleAccess="状态错误" color="error" sx={{ position: "absolute", right: -4, top: -5, fontSize: 13, bgcolor: "background.paper", borderRadius: "50%" }} />}
                  </Box>
                </ListItemIcon><ListItemText
                  primary={`${item.position}. ${slaveDisplayName(item)}`}
                  secondary={<>
                    <Typography component="span" fontSize={11.5} color={isSlaveStateUnknown(item) ? "warning.main" : (item.raw_state ?? item.state) & 0x10 || item.al_status ? "error.main" : "text.secondary"}>{slaveStateLabel(item)}</Typography>
                    {showSlaveIoSizes(item, Boolean(stateFailures[item.position])) && <Typography component="span" fontSize={11.5} color="text.secondary">{" "}IN {item.input_size ?? "—"}B | OUT {item.output_size ?? "—"}B</Typography>}
                  </>}
                  primaryTypographyProps={{ noWrap: true, fontWeight: 650, fontSize: 12.5, title: slaveDisplayName(item) }}
                  secondaryTypographyProps={{ component: "div", noWrap: true, align: isSlaveStateUnknown(item) ? "center" : "left" }}
                /></ListItemButton>)}</List></Box>}
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {slave && <Stack direction="row" alignItems="center" gap={1} sx={{ px: 2, pt: page === "overview" ? 1.5 : 0.75, pb: page === "overview" ? 0 : 0.75, borderBottom: page === "overview" ? 0 : 1, borderColor: "divider", bgcolor: page === "overview" ? "background.default" : "background.paper" }}>
            {page === "overview" && <Typography variant="h5" fontWeight={750} sx={{ mr: 1 }}>设备概览</Typography>}
            {page === "eeprom" && <Typography variant="h5" fontWeight={750} sx={{ mr: 1 }}>EEPROM</Typography>}
            {page === "registers" && <Typography variant="h5" fontWeight={750} sx={{ mr: 1 }}>寄存器</Typography>}
            <Typography variant="body2" fontWeight={650} noWrap onContextMenu={(event) => openSlaveContextMenu(event, slave.position)} sx={{ minWidth: 0 }} title={slaveDisplayName(slave)}>从站 {slave.position} · {slaveDisplayName(slave)}</Typography>
            {page !== "overview" && (isSlaveStateUnknown(slave) ? <Chip size="small" color="warning" label="未知状态" /> : page === "registers" && slave.state === 1 ? null : <StateChip state={slave.state} error={Boolean((slave.raw_state ?? slave.state) & 0x10)} />)}
            {page === "overview" && <Button size="small" sx={{ ml: "auto" }} disabled={busy} startIcon={<RefreshRounded className={busy ? "operation-icon-spinning" : undefined} />} onClick={() => run(refreshStates)}>刷新状态</Button>}
          </Stack>}
        <Box component="main" sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: page === "eeprom" ? "hidden" : "auto", p: { xs: 1.5, xl: 2 }, ...(page === "overview" && slave ? { pt: 0 } : {}) }}><Box sx={{ width: "100%", maxWidth: 1840, mx: "auto", ...(page === "eeprom" ? { height: "100%", minHeight: 0, display: "flex", flexDirection: "column" } : {}) }}><Suspense fallback={<Box sx={{ p: 3 }}><CircularProgress size={24} /></Box>}>{content}</Suspense></Box></Box>
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
    <QuickEepromFlashDialog open={quickFlashOpen} slave={slave} onSelectSlave={setSelectedPosition} initialSource={quickFlashSource} onInitialSourceConsumed={consumeQuickFlashSource} onBusyChange={setQuickFlashBusy} status={status} progress={progress} autoResetEsc={eepromAutoReset} setProgress={setProgress} onClose={() => { setQuickFlashOpen(false); setQuickFlashSource(undefined); }} onOpenDetails={(selection) => { setQuickFlashOpen(false); setEepromDetailSelection(selection); navigate("eeprom"); }} />
    {settings && <Suspense fallback={<Dialog open onClose={() => setSettings(false)} fullWidth maxWidth="sm"><DialogContent><CircularProgress size={24} /></DialogContent></Dialog>}>
      <SettingsDialog onClose={() => setSettings(false)} onOpenGuide={() => { setSettings(false); setFeatureGuideOpen(true); }} alLanguage={alLanguage} onLanguageChange={value => { setAlLanguage(value); window.localStorage.setItem(AL_LANGUAGE_KEY, value); }} autoCheckUpdates={autoCheckUpdates} onAutoCheckChange={enabled => { setAutoCheckUpdates(enabled); window.localStorage.setItem(AUTO_UPDATE_KEY, String(enabled)); }} updateState={updateState} updateError={updateError ? updateFailureMessage(updateError) : undefined} updateStageLabel={updating ? UPDATE_STAGE_LABELS[updateState as UpdateStage] : undefined} updating={updating} availableVersion={availableUpdate?.version} ignoredUpdateVersion={ignoredUpdateVersion} pendingUpdateReminder={pendingUpdateReminder} visit={visit} checkUpdate={checkUpdate} onShowUpdate={() => setUpdateDialogOpen(true)} onShowAvailableUpdate={() => { setPendingUpdateReminder(false); setUpdateDialogOpen(true); }} />
    </Suspense>}
    {featureGuideOpen && <Suspense fallback={<Dialog open onClose={() => setFeatureGuideOpen(false)} fullWidth maxWidth="lg"><DialogContent><CircularProgress size={24} /></DialogContent></Dialog>}>
      <FeatureGuideDialog onClose={() => setFeatureGuideOpen(false)} />
    </Suspense>}
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
    <MessageHistoryPanel messages={messages} onMessagesConsumed={consumeMessages} progress={!updateDialogOpen && updating ? {
      key: "online-update", title: UPDATE_STAGE_LABELS[updateState], severity: "info", running: true,
      detail: updateState === "downloading" ? `${formatBytes(updateProgress.downloaded)}${updateProgress.total > 0 ? ` / ${formatBytes(updateProgress.total)}` : ""}`
        : updateState === "installing" ? "即将退出并打开安装器" : "正在停止通信并断开设备",
      percent: updateState === "downloading" && updateProgress.total > 0 ? Math.min(100, updateProgress.downloaded / updateProgress.total * 100) : undefined,
      actionLabel: "详情", onAction: () => setUpdateDialogOpen(true),
    } : progress && !isEepromOperation(progress.operation) ? {
      key: `${progress.operation}:${progress.percent < 100 ? "running" : `finished:${progress.tone}`}`,
      title: progress.stage, detail: progress.detail, severity: progress.tone ?? "info", percent: progress.percent, running: progress.percent < 100,
      actionLabel: "取消", onAction: progress.percent < 100 && progress.cancellable !== false ? () => { void bridgeRequest("cancel"); } : undefined,
      onDismiss: () => setProgress(undefined),
    } : undefined} />
  </Box>;
}
