import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, IconButton, InputAdornment, LinearProgress, List, ListItemButton, ListItemText, Stack, Tab, Tabs,
  TextField, Tooltip, Typography,
} from "@mui/material";
import {
  FolderOpenRounded, HistoryRounded, Inventory2Rounded, MemoryRounded, RestartAltRounded,
  SearchRounded, StarOutlineRounded, StarRounded,
} from "@mui/icons-material";
import { BridgeRequestError, bridgeRequest, onFileDrop, pickFile, revealPath } from "./api";
import {
  decodeConfigData, fixedEsiKey, hexByte, hexWord, loadFixedEsiState, loadFlashHistory,
  loadQuickFlashTab, normalizeConfigData, saveFixedEsiState, saveFlashHistory, saveQuickFlashTab,
  FLASH_HISTORY_LIMIT, type FixedEsiEntry, type FixedEsiState, type FlashHistoryEntry,
} from "./eepromConfig";
import type { EsiDevice, OperationProgress, SlaveInfo, WorkbenchStatus } from "./types";
import { hex } from "./types";

export interface EepromProgressState extends OperationProgress {
  percent: number;
  tone?: "error" | "success" | "info";
}

interface EsiResult {
  document_id: string;
  path: string;
  sha256: string;
  vendor_id: number;
  vendor_name: string;
  devices: EsiDevice[];
}

interface TargetResult {
  target_id: string;
  size: number;
  sha256: string;
  device: EsiDevice;
  original_config_data: string;
  effective_config_data: string;
}

interface EepromHeader {
  header: string;
  config_data: string;
  crc_valid: boolean;
  size: number;
}

type LibraryEntry = FixedEsiEntry;

interface LibraryResult {
  directory: string;
  entries: LibraryEntry[];
  errors: { path: string; error: string }[];
}

interface FlashPayload {
  success: boolean;
  result: { image_verification: string; reload_verified?: boolean; words_written: number };
}

export interface EepromDetailSelection {
  path: string;
  ordinal: number;
  configData: string;
}

interface Props {
  open: boolean;
  slave?: SlaveInfo;
  status: WorkbenchStatus;
  progress?: EepromProgressState;
  autoResetEsc: boolean;
  setProgress: (value?: EepromProgressState) => void;
  onClose: () => void;
  onOpenDetails: (selection?: EepromDetailSelection) => void;
}

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const slaveKey = (slave?: SlaveInfo) => slave ? [
  slave.position, slave.identity.vendor_id, slave.identity.product_code, slave.identity.revision,
  slave.identity.serial_number, slave.configured_address ?? "",
].join(":") : "none";

function deviceConfigData(device?: EsiDevice): string {
  const value = typeof device?.config_data === "string" ? device.config_data : "";
  return normalizeConfigData(value).formatted ?? "";
}

function ConfigSummary({ title, configData, subtle = false }: {
  title: string; configData: string; subtle?: boolean;
}) {
  const decoded = decodeConfigData(configData);
  return <Box sx={{ p: 1.35, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: subtle ? "#FAFBFD" : "#F7FAFF", minWidth: 0 }}>
    <Typography variant="overline" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>{title}</Typography>
    <Typography className="mono" sx={{ mt: 0.35, fontSize: 13, overflowWrap: "anywhere" }}>{decoded?.formatted || "读取中…"}</Typography>
    <Stack direction="row" alignItems="center" gap={0.75} sx={{ mt: 0.9 }}>
      <Chip size="small" label={decoded ? hexByte(decoded.pdiCode) : "—"} color="primary" variant="outlined" />
      <Typography variant="body2" fontWeight={700} fontSize={13}>{decoded?.pdiLabel ?? "等待 ConfigData"}</Typography>
    </Stack>
  </Box>;
}

export function QuickEepromFlashDialog({ open, slave, status, progress, autoResetEsc, setProgress, onClose, onOpenDetails }: Props) {
  const [tab, setTab] = useState<0 | 1>(() => loadQuickFlashTab());
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<LibraryResult>({ directory: "", entries: [], errors: [] });
  const [history, setHistory] = useState<FlashHistoryEntry[]>(() => loadFlashHistory());
  const [fixedState, setFixedState] = useState<FixedEsiState>(() => loadFixedEsiState());
  const [esi, setEsi] = useState<EsiResult>();
  const [ordinal, setOrdinal] = useState(0);
  const [target, setTarget] = useState<TargetResult>();
  const [header, setHeader] = useState<EepromHeader>();
  const [headerError, setHeaderError] = useState("");
  const [configData, setConfigData] = useState("");
  const [originalConfigData, setOriginalConfigData] = useState("");
  const [loading, setLoading] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [result, setResult] = useState<{ severity: "success" | "warning" | "error" | "info"; text: string }>();
  const requestRef = useRef(0);
  const generatedConfigRef = useRef("");
  const openedContextRef = useRef("");
  const currentDevice = esi?.devices[ordinal];
  const parsedConfig = normalizeConfigData(configData);
  const targetDecoded = decodeConfigData(configData);
  const operationInProgress = Boolean(progress?.operation?.startsWith("eeprom") && progress.percent < 100);
  const contextKey = slaveKey(slave);

  const generate = useCallback(async (document: EsiResult, selectedOrdinal: number, effectiveConfig: string) => {
    const requestId = ++requestRef.current;
    generatedConfigRef.current = effectiveConfig;
    setTarget(undefined);
    setGenerationError("");
    try {
      const value = await bridgeRequest<TargetResult>("sii_generate", {
        document_id: document.document_id,
        ordinal: selectedOrdinal,
        config_data: effectiveConfig,
      });
      if (requestRef.current === requestId) setTarget(value);
    } catch (error) {
      if (requestRef.current === requestId) setGenerationError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const loadXml = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string) => {
    setLoading(true);
    setResult(undefined);
    try {
      const document = await bridgeRequest<EsiResult>("esi_load", { path });
      const matched = slave ? document.devices.findIndex((device) =>
        document.vendor_id === slave.identity.vendor_id
        && device.product_code === slave.identity.product_code
        && Number(device.revision ?? device.revision_number ?? 0) === slave.identity.revision
      ) : -1;
      const selectedOrdinal = preferredOrdinal !== undefined && document.devices[preferredOrdinal]
        ? preferredOrdinal : matched >= 0 ? matched : 0;
      const original = deviceConfigData(document.devices[selectedOrdinal]);
      const effective = normalizeConfigData(overrideConfig ?? original).formatted ?? original;
      setEsi(document);
      setOrdinal(selectedOrdinal);
      setOriginalConfigData(original);
      setConfigData(effective);
      await generate(document, selectedOrdinal, effective);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [generate, slave]);

  useEffect(() => {
    if (!open || !slave || openedContextRef.current === contextKey) return;
    openedContextRef.current = contextKey;
    setResult(undefined);
    setHeader(undefined);
    setHeaderError("");
    void bridgeRequest<LibraryResult>("esi_library_list").then(setLibrary).catch((error) =>
      setLibrary({ directory: "", entries: [], errors: [{ path: "", error: error instanceof Error ? error.message : String(error) }] })
    );
    void bridgeRequest<EepromHeader>("eeprom_header", { position: slave.position })
      .then(setHeader)
      .catch((error) => setHeaderError(error instanceof Error ? error.message : String(error)));
    requestRef.current += 1;
    generatedConfigRef.current = "";
    setEsi(undefined);
    setOrdinal(0);
    setTarget(undefined);
    setConfigData("");
    setOriginalConfigData("");
    setGenerationError("");
  }, [contextKey, open, slave]);

  useEffect(() => {
    if (!open || !esi || !parsedConfig.formatted || parsedConfig.formatted === generatedConfigRef.current) return;
    setTarget(undefined);
    const timer = window.setTimeout(() => void generate(esi, ordinal, parsedConfig.formatted!), 250);
    return () => window.clearTimeout(timer);
  }, [configData, esi, generate, open, ordinal, parsedConfig.formatted]);

  const chooseFile = async () => {
    const path = await pickFile(["xml"]);
    if (path) await loadXml(path);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void onFileDrop((paths) => {
      const xml = paths.find((path) => path.toLowerCase().endsWith(".xml"));
      if (xml && !operationInProgress) void loadXml(xml);
    }).then((value) => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); };
  }, [loadXml, open, operationInProgress]);

  const filteredHistory = useMemo(() => history.filter((item) => {
    const haystack = `${item.path} ${item.deviceName} ${item.productCode.toString(16)} ${item.effectiveConfigData}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [history, query]);
  const fixedEntries = useMemo(() => {
    const items = new Map<string, LibraryEntry>();
    fixedState.favorites.forEach((item) => items.set(fixedEsiKey(item), item));
    library.entries.forEach((item) => {
      const key = fixedEsiKey(item);
      if (!fixedState.hidden.includes(key) && !items.has(key)) items.set(key, item);
    });
    return [...items.values()];
  }, [fixedState, library.entries]);
  const filteredLibrary = useMemo(() => fixedEntries.filter((item) => {
    const haystack = `${item.path} ${item.device_name} ${item.product_code.toString(16)} ${item.config_data}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [fixedEntries, query]);

  const blocker = operationInProgress ? "EEPROM 操作正在执行"
    : status.cycle_running ? "周期通信正在运行，请先停止周期通信"
      : headerError ? `无法读取当前 EEPROM：${headerError}`
        : !header ? "正在读取当前 EEPROM 配置"
          : !esi ? "请选择 XML 并等待烧录目标生成完成"
            : parsedConfig.error ? parsedConfig.error
              : generationError ? generationError
                : !target ? "正在生成烧录目标"
                : target.size !== header.size ? "XML 生成目标与物理 EEPROM 容量不兼容"
                  : "";

  const flash = async () => {
    if (!slave || !target || blocker) return;
    setResult(undefined);
    setProgress({ operation: "eeprom-flash", stage: "准备", completed: 0, total: 100, percent: 0, detail: "准备切换 INIT 并烧录", tone: "info", cancellable: true });
    try {
      const payload = await bridgeRequest<FlashPayload>("eeprom_flash", { position: slave.position, target_id: target.target_id, auto_reset: autoResetEsc });
      if (!payload.success) {
        setResult({ severity: "error", text: payload.result.image_verification });
        setProgress({ operation: "eeprom-flash", stage: "镜像校验失败", completed: 100, total: 100, percent: 100, detail: payload.result.image_verification, tone: "error" });
        return;
      }
      const effective = parsedConfig.formatted!;
      const original = originalConfigData || effective;
      const entry: FlashHistoryEntry = {
        path: esi!.path,
        documentSha256: esi!.sha256,
        ordinal,
        deviceName: currentDevice!.name,
        vendorId: esi!.vendor_id,
        productCode: currentDevice!.product_code,
        revision: Number(currentDevice!.revision ?? currentDevice!.revision_number ?? 0),
        byteSize: Number(currentDevice!.byte_size ?? currentDevice!.eeprom_byte_size ?? target.size),
        originalConfigData: original,
        effectiveConfigData: effective,
        flashedAt: new Date().toISOString(),
        slaveKey: contextKey,
      };
      setHistory((current) => saveFlashHistory(entry, window.localStorage, current));
      const reloadFailed = payload.result.reload_verified === false;
      const text = reloadFailed
        ? "镜像校验完成；复位后的重新加载复核未通过。"
        : payload.result.words_written === 0 ? "烧录校验已完成。"
        : autoResetEsc ? "烧录、完整回读和校验已完成。" : "烧录与完整回读校验已完成；未复位 ESC。";
      setResult({ severity: reloadFailed ? "warning" : "success", text });
      setProgress({ operation: "eeprom-flash", stage: reloadFailed ? "烧录完成，重新加载复核未通过" : "烧录并校验完成", completed: 100, total: 100, percent: 100, detail: text, tone: reloadFailed ? "info" : "success", cancellable: false });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const cancelled = error instanceof BridgeRequestError && error.code === "CANCELLED";
      setResult({ severity: cancelled ? "info" : "error", text });
      setProgress({ operation: "eeprom-flash", stage: cancelled ? "已取消" : "操作失败", completed: 100, total: 100, percent: 100, detail: text, tone: cancelled ? "info" : "error", cancellable: false });
    }
  };

  const favoriteHistory = (item: FlashHistoryEntry) => {
    const favorite: LibraryEntry = {
      path: item.path,
      sha256: item.documentSha256,
      vendor_id: item.vendorId,
      vendor_name: "",
      ordinal: item.ordinal,
      device_name: item.deviceName,
      type_name: item.deviceName,
      product_code: item.productCode,
      revision: item.revision,
      byte_size: item.byteSize,
      config_data: item.effectiveConfigData,
    };
    const key = fixedEsiKey(favorite);
    setFixedState((current) => saveFixedEsiState({
      favorites: [favorite, ...current.favorites.filter((entry) => fixedEsiKey(entry) !== key)],
      hidden: current.hidden.filter((entry) => entry !== key),
    }));
  };

  const removeFixed = (item: Pick<LibraryEntry, "path" | "ordinal">) => {
    const key = fixedEsiKey(item);
    setFixedState((current) => saveFixedEsiState({
      favorites: current.favorites.filter((entry) => fixedEsiKey(entry) !== key),
      hidden: current.hidden.includes(key) ? current.hidden : [...current.hidden, key],
    }));
  };

  const openXmlLocation = async (path: string) => {
    try {
      await revealPath(path);
    } catch (error) {
      setResult({ severity: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const renderSource = (item: LibraryEntry | FlashHistoryEntry, recent: boolean) => {
    const path = item.path;
    const deviceName = recent ? (item as FlashHistoryEntry).deviceName : (item as LibraryEntry).device_name;
    const productCode = recent ? (item as FlashHistoryEntry).productCode : (item as LibraryEntry).product_code;
    const sourceConfig = recent ? (item as FlashHistoryEntry).effectiveConfigData : (item as LibraryEntry).config_data;
    const itemOrdinal = recent ? (item as FlashHistoryEntry).ordinal : (item as LibraryEntry).ordinal;
    const decoded = decodeConfigData(sourceConfig);
    const selected = esi?.path === path && currentDevice?.name === deviceName && parsedConfig.formatted === decoded?.formatted;
    const inFixedList = fixedEntries.some((entry) => fixedEsiKey(entry) === fixedEsiKey({ path, ordinal: itemOrdinal }));
    return <Box key={`${path}-${itemOrdinal}-${sourceConfig}`} sx={{ position: "relative", mb: 0.4 }}>
      <ListItemButton
        selected={selected}
        disabled={operationInProgress}
        onClick={() => void loadXml(path, itemOrdinal, sourceConfig)}
        onDoubleClick={() => void openXmlLocation(path)}
        title={`${path}\n双击打开文件位置`}
        sx={{ alignItems: "flex-start", borderRadius: 1.15, border: 1, borderColor: selected ? "primary.main" : "transparent", px: 1, pr: 4.5, py: 0.7 }}
      >
        <ListItemText
          primary={<Typography fontWeight={700} fontSize={12.5} noWrap title={fileName(path)}>{fileName(path)}</Typography>}
          secondary={<Stack spacing={0.2} sx={{ mt: 0.25 }}>
            <Typography variant="caption" fontSize={11} color="text.secondary" noWrap title={deviceName}>Device：{deviceName}</Typography>
            <Typography variant="caption" fontSize={11} className="mono">Product：{hex(productCode, 8)}</Typography>
            <Typography variant="caption" fontSize={11} color="primary.main" fontWeight={650}>{decoded ? `${hexByte(decoded.pdiCode)} · ${decoded.pdiLabel}` : "ConfigData 未解析"}</Typography>
            {recent && <Typography variant="caption" fontSize={10.5} color="text.secondary">{new Date((item as FlashHistoryEntry).flashedAt).toLocaleString()}</Typography>}
          </Stack>}
        />
      </ListItemButton>
      <Stack direction="row" sx={{ position: "absolute", top: 4, right: 4 }}>
        {recent ? <Tooltip title={inFixedList ? "取消收藏" : "收藏到固定列表"}><span><IconButton size="small" disabled={operationInProgress} aria-label={inFixedList ? "取消收藏" : "收藏到固定列表"} onClick={(event) => { event.stopPropagation(); inFixedList ? removeFixed({ path, ordinal: itemOrdinal }) : favoriteHistory(item as FlashHistoryEntry); }}>{inFixedList ? <StarRounded fontSize="small" color="warning" /> : <StarOutlineRounded fontSize="small" color="action" />}</IconButton></span></Tooltip> : <Tooltip title="取消收藏（不删除 XML 文件）"><span><IconButton size="small" disabled={operationInProgress} aria-label="取消收藏" onClick={(event) => { event.stopPropagation(); removeFixed(item as LibraryEntry); }}><StarRounded fontSize="small" color="warning" /></IconButton></span></Tooltip>}
      </Stack>
    </Box>;
  };

  const handleClose = (_event?: object, reason?: "backdropClick" | "escapeKeyDown") => {
    if (operationInProgress || reason === "backdropClick" && operationInProgress) return;
    saveQuickFlashTab(tab);
    openedContextRef.current = "";
    onClose();
  };

  return <Dialog open={open} onClose={handleClose} fullWidth maxWidth="lg" disableEscapeKeyDown={operationInProgress}
    PaperProps={{ sx: { height: { xs: "calc(100vh - 40px)", xl: 820 }, maxHeight: "calc(100vh - 32px)", borderRadius: 2, overflow: "hidden" } }}>
    <DialogTitle sx={{ py: 1.6, px: 2.25 }}>
      <Box><Typography variant="h6" fontWeight={780} fontSize={18}>快速烧录 EEPROM</Typography><Typography variant="body2" fontSize={12.5} color="text.secondary">{slave ? `从站 ${slave.position} · ${slave.name} · ${slave.chip_model}` : "未选择从站"}</Typography></Box>
    </DialogTitle>
    <Divider />
    <DialogContent sx={{ p: 0, overflow: "hidden" }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "310px minmax(0, 1fr)", xl: "350px minmax(0, 1fr)" }, height: "100%", minHeight: 0 }}>
        <Box sx={{ borderRight: 1, borderColor: "divider", display: "flex", flexDirection: "column", minHeight: 0, bgcolor: "#FBFCFE" }}>
          <Tabs value={tab} onChange={(_, value: 0 | 1) => { setTab(value); saveQuickFlashTab(value); }} variant="fullWidth" sx={{ minHeight: 40, bgcolor: "background.paper" }}>
            <Tab icon={<HistoryRounded sx={{ fontSize: 18 }} />} iconPosition="start" label={`最近烧录 ${history.length || ""}`} sx={{ minHeight: 40, py: 0.7, fontSize: 12.5 }} />
            <Tab icon={<Inventory2Rounded sx={{ fontSize: 18 }} />} iconPosition="start" label={`固定列表 ${fixedEntries.length || ""}`} sx={{ minHeight: 40, py: 0.7, fontSize: 12.5 }} />
          </Tabs>
          <Box sx={{ p: 1 }}><TextField fullWidth size="small" placeholder="搜索 XML、Device、Product" value={query} onChange={(event) => setQuery(event.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 18 }} /></InputAdornment> }} sx={{ "& .MuiInputBase-input": { py: 0.8, fontSize: 12.5 } }} /></Box>
          <List dense sx={{ px: 0.65, pb: 0.8, overflow: "auto", flex: 1 }}>
            {tab === 0 ? filteredHistory.map((item) => renderSource(item, true)) : filteredLibrary.map((item) => renderSource(item, false))}
            {tab === 0 && filteredHistory.length === 0 && <Box sx={{ py: 7, px: 2, textAlign: "center", color: "text.secondary" }}><HistoryRounded sx={{ opacity: 0.3, fontSize: 38 }} /><Typography fontWeight={700}>暂无最近烧录</Typography><Typography variant="caption">成功烧录后会自动保留最近 {FLASH_HISTORY_LIMIT} 项</Typography></Box>}
            {tab === 1 && filteredLibrary.length === 0 && <Box sx={{ py: 7, px: 2, textAlign: "center", color: "text.secondary" }}><Inventory2Rounded sx={{ opacity: 0.3, fontSize: 38 }} /><Typography fontWeight={700}>固定列表为空</Typography><Typography variant="caption">{library.directory || "未找到 xml列表 目录"}</Typography></Box>}
          </List>
          {library.errors.length > 0 && tab === 1 && <Alert severity="warning" sx={{ m: 1, mt: 0 }}>{library.errors.length} 个 XML 无法解析</Alert>}
          <Box sx={{ p: 1, borderTop: 1, borderColor: "divider", bgcolor: "background.paper" }}><Button fullWidth size="small" variant="outlined" startIcon={<FolderOpenRounded />} disabled={operationInProgress} onClick={chooseFile}>选择或拖入 XML</Button></Box>
        </Box>

        <Box sx={{ p: 2.25, overflow: "auto", minWidth: 0 }}>
          {progress && operationInProgress && <Box sx={{ mb: 1.5, p: 1.4, borderRadius: 1.5, bgcolor: "#F2F7FF", border: 1, borderColor: "primary.light" }}><Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}><Box minWidth={0}><Typography fontWeight={750}>{progress.stage}</Typography><Typography variant="caption" color="text.secondary">{progress.detail}</Typography></Box><Typography className="mono" fontWeight={700}>{progress.percent}%</Typography></Stack><LinearProgress variant="determinate" value={progress.percent} sx={{ mt: 1, height: 6, borderRadius: 4 }} /></Box>}
          {result && <Alert severity={result.severity} sx={{ mb: 1.5 }}>{result.text}</Alert>}
          <Box sx={{ p: 1.45, mb: 1.5, border: 1, borderLeft: 4, borderColor: "#D7DCE3", borderLeftColor: "#7B8794", borderRadius: 1.5, bgcolor: "#F8F9FB" }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.1 }}>
              <Typography fontWeight={780} fontSize={15}>当前从站 · 设备实际值</Typography>
            </Stack>
            <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 1.25 }}>
              <Box sx={{ p: 1.35, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "background.paper", minWidth: 0 }}>
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>当前 Device</Typography>
                <Typography fontWeight={780} fontSize={14} noWrap title={slave?.name}>Device：{slave?.name ?? "—"}</Typography>
                <Typography variant="body2" fontSize={13} color="text.secondary" noWrap>{slave ? `从站 ${slave.position} · ${slave.chip_model}` : "未选择从站"}</Typography>
              </Box>
              <ConfigSummary title="实际 EEPROM ConfigData" configData={header?.config_data ?? ""} subtle />
            </Box>
          </Box>
          {headerError && <Alert severity="error" sx={{ mb: 1.25 }}>无法读取当前 EEPROM：{headerError}</Alert>}
          {!esi ? <Box sx={{ minHeight: 280, display: "grid", placeItems: "center", textAlign: "center", color: "text.secondary" }}><Stack alignItems="center" spacing={1}><MemoryRounded sx={{ fontSize: 48, opacity: 0.24 }} /><Typography fontWeight={750}>从左侧选择烧录 XML</Typography><Typography variant="body2">选择后可查看并临时修改目标 ConfigData；双击 XML 可打开文件位置</Typography>{loading && <CircularProgress size={22} />}</Stack></Box> : <Stack spacing={1.75}>
            <Box sx={{ p: 1.45, border: 1, borderLeft: 4, borderColor: "primary.light", borderLeftColor: "primary.main", borderRadius: 1.5, bgcolor: "#F5F8FF" }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.1 }}>
                <Typography color="primary.main" fontWeight={780} fontSize={15}>选中 XML · 待烧录目标</Typography>
              </Stack>
              <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 1.25 }}>
                <Box sx={{ p: 1.35, borderRadius: 1.25, bgcolor: "background.paper", border: 1, borderColor: "primary.light", minWidth: 0 }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>XML 文件</Typography><Typography fontWeight={780} fontSize={14} noWrap title={fileName(esi.path)}>{fileName(esi.path)}</Typography><Typography variant="body2" fontSize={13} color="text.secondary" noWrap title={currentDevice?.name}>Device：{currentDevice?.name}</Typography>
                </Box>
                <ConfigSummary title="XML ConfigData" configData={configData} />
              </Box>
              <Divider sx={{ my: 1.35, borderColor: "primary.light" }} />
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 0.9 }}><Box><Typography fontWeight={750} fontSize={14}>XML ConfigData解析</Typography><Typography variant="caption" color="text.secondary" fontSize={12}>10 byte；只修改内存目标，原 XML 文件保持不变</Typography></Box><Button size="small" startIcon={<RestartAltRounded />} disabled={operationInProgress || configData === originalConfigData} onClick={() => setConfigData(originalConfigData)}>恢复 XML 原值</Button></Stack>
              <TextField size="small" fullWidth value={configData} disabled={operationInProgress} error={Boolean(parsedConfig.error)} helperText={parsedConfig.error} onChange={(event) => { setConfigData(event.target.value.toUpperCase()); setTarget(undefined); }} onBlur={() => parsedConfig.formatted && setConfigData(parsedConfig.formatted)} inputProps={{ className: "mono", spellCheck: false, style: { fontSize: 13.5 } }} FormHelperTextProps={{ sx: { fontSize: 12, mt: 0.45 } }} />
              {targetDecoded && <><Divider sx={{ my: 1.35, borderColor: "primary.light" }} /><Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1 }}>{[
                ["0x0140 · PDI Control", `${hexByte(targetDecoded.pdiCode)} · ${targetDecoded.pdiLabel}`],
                ["0x0141 · ESC Configuration", hexByte(targetDecoded.escConfiguration)],
                ["0x0150 · PDI Configuration", hexByte(targetDecoded.pdiConfiguration)],
                ["0x0151 · SYNC/LATCH", hexByte(targetDecoded.syncLatchConfiguration)],
                ["0x0982 · SYNC 脉宽", `${hexWord(targetDecoded.syncPulse)} · ${targetDecoded.syncPulse === 0 ? "ACK 模式" : `${targetDecoded.syncPulse * 10} ns`}`],
                ["0x0152 · Extended PDI", hexWord(targetDecoded.extendedPdiConfiguration)],
                ["0x0012 · Station Alias", hexWord(targetDecoded.stationAlias)],
              ].map(([label, value]) => <Box key={label} sx={{ minWidth: 0, minHeight: 55, p: 0.9, border: 1, borderColor: "primary.light", borderRadius: 1.1, bgcolor: "background.paper" }}><Typography variant="caption" color="text.secondary" fontSize={11.5}>{label}</Typography><Typography variant="body2" className="mono" fontWeight={650} fontSize={13} sx={{ mt: 0.2 }} noWrap title={value}>{value}</Typography></Box>)}</Box></>}
            </Box>
            {generationError && <Alert severity="error">{generationError}</Alert>}
          </Stack>}
        </Box>
      </Box>
    </DialogContent>
    <Divider />
    <DialogActions sx={{ px: 2, py: 1.25, justifyContent: "space-between" }}>
      <Button disabled={!esi || operationInProgress} onClick={() => esi && onOpenDetails({ path: esi.path, ordinal, configData: parsedConfig.formatted ?? configData })}>进入 EEPROM 详情</Button>
      <Stack direction="row" gap={1} alignItems="center"><Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420, textAlign: "right" }}>{blocker || (autoResetEsc ? "有写入时自动复位 ESC" : "烧录后不复位 ESC")}</Typography><Button disabled={operationInProgress} onClick={() => handleClose()}>取消</Button><Button variant="contained" color="error" startIcon={operationInProgress ? <CircularProgress size={16} color="inherit" /> : <MemoryRounded />} disabled={Boolean(blocker)} onClick={flash}>烧录</Button></Stack>
    </DialogActions>
  </Dialog>;
}
