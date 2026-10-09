import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, IconButton, InputAdornment, LinearProgress, List, ListItemButton, ListItemText, Stack, Tab, Tabs,
  MenuItem, TextField, Tooltip, Typography,
} from "@mui/material";
import {
  DeleteOutlineRounded, FolderOpenRounded, HistoryRounded, Inventory2Rounded, MemoryRounded, SaveRounded,
  RefreshRounded, SearchRounded, StarOutlineRounded, StarRounded,
} from "@mui/icons-material";
import { BridgeRequestError, bridgeRequest, onFileDrop, pickFile, revealPath } from "./api";
import {
  addFixedEsiEntry, decodeConfigData, fixedEsiEntries, hexByte, hexWord, loadFixedEsiState, loadFlashHistory,
  loadQuickFlashTab, loadRecentEsi, normalizeConfigData, removeFixedEsiEntry, removeFlashHistory, sameEepromSource, saveFixedEsiState, saveFlashHistory, saveQuickFlashTab, writeRecentEsi,
  FLASH_HISTORY_LIMIT, eepromSourceIndex, isBinFile, sourcePathKey,
  type EepromBinTarget, type FixedEsiEntry, type FixedEsiState, type FlashHistoryEntry,
} from "./eepromConfig";
import type { EsiDevice, OperationProgress, SlaveInfo, WorkbenchStatus } from "./types";
import { hex } from "./types";

export interface EepromProgressState extends OperationProgress {
  percent: number;
  tone?: "error" | "success" | "info" | "warning";
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
  omitted: string[];
}

interface EepromHeader {
  config_data: string;
  size: number | null;
  sii_status?: string;
  sii_error?: string | null;
}

type LibraryEntry = FixedEsiEntry;

interface LibraryResult {
  directory: string;
  entries: LibraryEntry[];
  errors: { path: string; error: string }[];
}

interface FlashPayload {
  success: boolean;
  result: { image_verification: string; reload_verified?: boolean; reload_error?: string; words_written: number; sii_valid?: boolean; semantic_valid?: boolean | null };
}

export interface EepromDetailSelection {
  path: string;
  ordinal: number;
  configData: string;
}

export interface EepromLaunchSource {
  path: string;
}

interface Props {
  open: boolean;
  slave?: SlaveInfo;
  onSelectSlave: (position: number) => void;
  initialSource?: EepromLaunchSource;
  onInitialSourceConsumed: () => void;
  onBusyChange: (busy: boolean) => void;
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

function deviceDisplayName(device?: EsiDevice): string {
  return device?.type_name || device?.name || "—";
}

function slaveDisplayName(slave?: SlaveInfo): string {
  return slave?.product_model || slave?.name || "—";
}

function ConfigSummary({ title, configData, subtle = false, placeholder = "等待选择" }: {
  title: string; configData: string; subtle?: boolean; placeholder?: string;
}) {
  const decoded = decodeConfigData(configData);
  return <Box sx={{ p: 1.35, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: subtle ? "#FAFBFD" : "background.paper", minWidth: 0 }}>
    <Typography variant="overline" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>{title}</Typography>
    <Typography className="mono" sx={{ mt: 0.35, fontSize: 13, overflowWrap: "anywhere" }}>{decoded?.formatted || placeholder}</Typography>
    <Stack direction="row" alignItems="center" gap={0.75} sx={{ mt: 0.9 }}>
      <Chip size="small" label={decoded ? hexByte(decoded.pdiCode) : "—"} variant="outlined" />
      <Typography variant="body2" fontWeight={700} fontSize={13}>{decoded?.pdiLabel ?? "等待 ConfigData"}</Typography>
    </Stack>
  </Box>;
}

export function QuickEepromFlashDialog({ open, slave, onSelectSlave, initialSource, onInitialSourceConsumed, onBusyChange, status, progress, autoResetEsc, setProgress, onClose, onOpenDetails }: Props) {
  const [tab, setTab] = useState<0 | 1>(() => loadQuickFlashTab());
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const [dragOver, setDragOver] = useState(false);
  const [library, setLibrary] = useState<LibraryResult>({ directory: "", entries: [], errors: [] });
  const [history, setHistory] = useState<FlashHistoryEntry[]>(() => loadFlashHistory());
  const [fixedState, setFixedState] = useState<FixedEsiState>(() => loadFixedEsiState());
  const [esi, setEsi] = useState<EsiResult>();
  const [bin, setBin] = useState<EepromBinTarget>();
  const [ordinal, setOrdinal] = useState(-1);
  const [target, setTarget] = useState<TargetResult>();
  const [header, setHeader] = useState<EepromHeader>();
  const [headerError, setHeaderError] = useState("");
  const [configData, setConfigData] = useState("");
  const [originalConfigData, setOriginalConfigData] = useState("");
  const [loading, setLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [result, setResult] = useState<{ severity: "success" | "warning" | "error" | "info"; text: string }>();
  const [sourcePath, setSourcePath] = useState(() => initialSource?.path ?? "");
  const sourceRequestRef = useRef<{ path: string; ordinal?: number; configData?: string } | undefined>(undefined);
  const requestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const generatedConfigRef = useRef("");
  const openedContextRef = useRef("");
  const libraryRequestRef = useRef(0);
  const targetContextRef = useRef("");
  const currentDevice = esi?.devices[ordinal];
  const flashTarget = bin ?? target;
  const parsedConfig = normalizeConfigData(configData);
  const targetDecoded = decodeConfigData(configData);
  const operationInProgress = Boolean(progress?.operation?.startsWith("eeprom") && progress.percent < 100);
  useEffect(() => onBusyChange(operationInProgress || configSaving), [operationInProgress, configSaving, onBusyChange]);
  const contextKey = `${status.host_generation}:${status.session_id}:${slaveKey(slave)}`;
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  if (esi && !loading) sourceRequestRef.current = { path: esi.path, ordinal: ordinal >= 0 ? ordinal : undefined, configData };

  // Discard generated targets when the source or selected slave changes.
  const generate = useCallback(async (document: EsiResult, selectedOrdinal: number, effectiveConfig: string, automatic = false) => {
    const requestId = ++requestRef.current;
    const context = contextKey;
    generatedConfigRef.current = effectiveConfig;
    setTarget(undefined);
    setGenerationError("");
    try {
      const value = await bridgeRequest<TargetResult>("sii_generate", {
        document_id: document.document_id,
        ordinal: selectedOrdinal,
        config_data: effectiveConfig,
        position: slave?.position,
      }, { file: document.path, device: deviceDisplayName(document.devices[selectedOrdinal]), automatic });
      if (requestRef.current === requestId && contextRef.current === context) {
        targetContextRef.current = context;
        setTarget(value);
      }
    } catch (error) {
      if (requestRef.current === requestId && contextRef.current === context) setGenerationError(error instanceof BridgeRequestError ? error.message : "无法生成烧录目标，请检查所选 XML 和设备。");
    }
  }, [contextKey, slave?.position]);

  // XML keeps its Device selection and temporary ConfigData override.
  const loadXml = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string, record = true) => {
    sourceRequestRef.current = { path, ordinal: preferredOrdinal, configData: overrideConfig };
    setSourcePath(path);
    const loadId = ++loadRequestRef.current;
    const context = contextKey;
    requestRef.current += 1;
    generatedConfigRef.current = "";
    setTarget(undefined);
    setEsi(undefined);
    setBin(undefined);
    setGenerationError("");
    setLoading(true);
    setResult(undefined);
    try {
      const document = await bridgeRequest<EsiResult>("esi_load", { path }, { history: record, position: slave?.position });
      if (loadRequestRef.current !== loadId || contextRef.current !== context) return;
      writeRecentEsi([document.path, ...loadRecentEsi()]);
      const matches = slave?.identity_valid !== false && slave ? document.devices.map((device, index) =>
        document.vendor_id === slave.identity.vendor_id
        && device.product_code === slave.identity.product_code
        && Number(device.revision ?? device.revision_number ?? 0) === slave.identity.revision
        ? index : -1).filter((index) => index >= 0) : [];
      const selectedOrdinal = preferredOrdinal !== undefined && document.devices[preferredOrdinal]
        ? preferredOrdinal : matches.length === 1 ? matches[0] : document.devices.length === 1 ? 0 : -1;
      const original = deviceConfigData(document.devices[selectedOrdinal]);
      const effective = normalizeConfigData(overrideConfig ?? original).formatted ?? original;
      sourceRequestRef.current = { path: document.path, ordinal: selectedOrdinal >= 0 ? selectedOrdinal : undefined, configData: effective };
      setEsi(document);
      setOrdinal(selectedOrdinal);
      setOriginalConfigData(original);
      setConfigData(effective);
      if (selectedOrdinal >= 0) await generate(document, selectedOrdinal, effective, !record);
    } catch (error) {
      if (loadRequestRef.current === loadId && contextRef.current === context) setGenerationError(error instanceof BridgeRequestError ? error.message : "无法打开所选 XML，请检查文件。");
    } finally {
      if (loadRequestRef.current === loadId && contextRef.current === context) setLoading(false);
    }
  }, [contextKey, generate, slave]);

  // BIN selection freezes the original bytes in the same target store as XML.
  const loadFile = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string, record = true) => {
    if (!isBinFile(path)) return loadXml(path, preferredOrdinal, overrideConfig, record);
    sourceRequestRef.current = { path };
    setSourcePath(path);
    const loadId = ++loadRequestRef.current;
    const context = contextKey;
    requestRef.current += 1;
    generatedConfigRef.current = "";
    setEsi(undefined); setTarget(undefined); setBin(undefined); setOrdinal(-1);
    setConfigData(""); setOriginalConfigData(""); setGenerationError("");
    setLoading(true); setResult(undefined);
    try {
      const value = await bridgeRequest<EepromBinTarget>("eeprom_bin_load", { path, position: slave?.position }, { history: record });
      if (loadRequestRef.current === loadId && contextRef.current === context) {
        targetContextRef.current = context;
        setBin(value);
        writeRecentEsi([value.path, ...loadRecentEsi()]);
      }
    } catch (error) {
      if (loadRequestRef.current === loadId && contextRef.current === context) {
        setGenerationError(error instanceof BridgeRequestError ? error.message : "无法打开所选 BIN，请检查文件。");
      }
    } finally {
      if (loadRequestRef.current === loadId && contextRef.current === context) setLoading(false);
    }
  }, [contextKey, loadXml, slave?.position]);

  useEffect(() => {
    if (!open) {
      requestRef.current += 1;
      loadRequestRef.current += 1;
      openedContextRef.current = "";
      // Keep the override visible until close, then discard its generated target.
      generatedConfigRef.current = "";
      setTarget(undefined);
      setConfigData(originalConfigData);
      return;
    }
    if (openedContextRef.current === contextKey) return;
    const previousContext = openedContextRef.current;
    const firstOpen = !previousContext;
    const clockChanged = previousContext.split(":").slice(0, 2).join(":") !== contextKey.split(":").slice(0, 2).join(":");
    openedContextRef.current = contextKey;
    // Reload shared favorites when opening after a main-page source-list edit.
    if (firstOpen) {
      setFixedState(loadFixedEsiState());
      setHistory(loadFlashHistory());
    }
    setResult(undefined);
    setHeader(undefined);
    setHeaderError("");
    if (slave) void bridgeRequest<EepromHeader>("eeprom_header", { position: slave.position })
      .then((value) => { if (openedContextRef.current === contextKey) setHeader(value); })
      .catch((error) => { if (openedContextRef.current === contextKey) setHeaderError(error instanceof BridgeRequestError ? error.message : "无法读取设备当前配置"); });
    requestRef.current += 1;
    loadRequestRef.current += 1;
    setLoading(false);
    setConfigSaving(false);
    generatedConfigRef.current = "";
    setTarget(undefined);
    setGenerationError("");
    if (firstOpen) {
      sourceRequestRef.current = undefined;
      setSourcePath(initialSource?.path ?? "");
      setEsi(undefined);
      setBin(undefined);
      setOrdinal(-1);
      setConfigData("");
      setOriginalConfigData("");
    } else if (status.host_generation > 0 && sourceRequestRef.current && (clockChanged || bin || loading)) {
      const source = sourceRequestRef.current;
      void loadFile(source.path, source.ordinal, source.configData, false);
    }
    // A slave switch keeps the XML draft; generation binds a fresh target to that slave.
  }, [contextKey, open, slave, status.host_generation, initialSource, bin, loading, loadFile]);

  const loadLibrary = useCallback(async (refresh = false) => {
    const request = ++libraryRequestRef.current;
    try {
      const value = await bridgeRequest<LibraryResult>("esi_library_list", { refresh });
      if (libraryRequestRef.current === request) setLibrary(value);
    } catch (error) {
      if (libraryRequestRef.current !== request) return;
      if (refresh) setResult({ severity: "error", text: error instanceof BridgeRequestError ? error.message : "无法刷新文件列表" });
      else setLibrary({ directory: "", entries: [], errors: [{ path: "", error: "无法读取 XML/BIN 文件列表" }] });
    }
  }, []);

  // Library metadata belongs to the dialog, independently of the selected slave.
  useEffect(() => {
    if (open && status.host_generation > 0) void loadLibrary();
    return () => { libraryRequestRef.current += 1; };
  }, [open, status.host_generation, loadLibrary]);

  useEffect(() => {
    if (!open || !initialSource || status.host_generation === 0 || operationInProgress || configSaving) return;
    void loadFile(initialSource.path);
    onInitialSourceConsumed();
  }, [open, initialSource, status.host_generation, operationInProgress, configSaving, loadFile, onInitialSourceConsumed]);

  useEffect(() => {
    if (!open || configSaving || !esi || ordinal < 0 || !parsedConfig.formatted || parsedConfig.formatted === generatedConfigRef.current) return;
    setTarget(undefined);
    const timer = window.setTimeout(() => void generate(esi, ordinal, parsedConfig.formatted!, true), 250);
    return () => window.clearTimeout(timer);
  }, [configData, configSaving, esi, generate, open, ordinal, parsedConfig.formatted]);

  // Save the selected Device's draft to XML and rebuild its target from the saved source.
  const saveConfigToFile = async () => {
    if (!esi || ordinal < 0 || !parsedConfig.formatted || loading || configSaving || operationInProgress) return;
    const loadId = ++loadRequestRef.current;
    const context = contextKey;
    const selectedOrdinal = ordinal;
    requestRef.current += 1;
    generatedConfigRef.current = "";
    setConfigSaving(true); setResult(undefined);
    try {
      const saved = await bridgeRequest<EsiResult>("esi_config_save", {
        document_id: esi.document_id, ordinal: selectedOrdinal, config_data: parsedConfig.formatted,
      }, { file: esi.path, device: deviceDisplayName(esi.devices[selectedOrdinal]), configBefore: deviceConfigData(esi.devices[selectedOrdinal]) });
      if (loadRequestRef.current !== loadId || contextRef.current !== context || openedContextRef.current !== context) return;
      const savedConfig = deviceConfigData(saved.devices[selectedOrdinal]);
      writeRecentEsi([saved.path, ...loadRecentEsi()]);
      setEsi(saved); setOriginalConfigData(savedConfig); setConfigData(savedConfig);
      setResult({ severity: "success", text: "ConfigData 已修改至 XML 文件" });
      await generate(saved, selectedOrdinal, savedConfig);
    } catch (error) {
      if (loadRequestRef.current === loadId && contextRef.current === context && openedContextRef.current === context) {
        setResult({ severity: "error", text: error instanceof BridgeRequestError ? error.message : "无法保存 XML，请检查文件写入权限。" });
      }
    } finally {
      if (loadRequestRef.current === loadId && contextRef.current === context && openedContextRef.current === context) setConfigSaving(false);
    }
  };

  const chooseFile = async () => {
    const path = await pickFile(["xml", "bin"]);
    if (path) await loadFile(path);
  };

  useEffect(() => {
    setDragOver(false);
    if (!open) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void onFileDrop((paths) => {
      const source = paths.find((path) => /\.(xml|bin)$/i.test(path));
      if (source && !operationInProgress && !configSaving) void loadFile(source);
    }, hovering => setDragOver(hovering && !operationInProgress && !configSaving)).then((value) => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); };
  }, [loadFile, open, operationInProgress, configSaving]);

  const search = useDeferredValue(query).trim().toLowerCase();
  const historySearch = useMemo(() => history.map(item => ({ item, text: `${item.path} ${item.deviceName} ${item.productCode.toString(16)} ${item.effectiveConfigData}`.toLowerCase() })), [history]);
  const filteredHistory = useMemo(() => historySearch.filter(entry => entry.text.includes(search)).map(entry => entry.item), [historySearch, search]);
  const fixedEntries = useMemo(() => fixedEsiEntries(fixedState, library.entries), [fixedState, library.entries]);
  const librarySearch = useMemo(() => fixedEntries.map(item => ({ item, text: `${item.path} ${item.type_name} ${item.device_name} ${item.product_code.toString(16)} ${item.config_data}`.toLowerCase() })), [fixedEntries]);
  const filteredLibrary = useMemo(() => librarySearch.filter(entry => entry.text.includes(search)).map(entry => entry.item), [librarySearch, search]);
  const fixedIndex = useMemo(() => eepromSourceIndex(fixedEntries), [fixedEntries]);
  const displayedIndex = useMemo(() => eepromSourceIndex<{ path: string }>(tab === 0 ? filteredHistory : filteredLibrary), [tab, filteredHistory, filteredLibrary]);
  useEffect(() => { setVisibleCount(50); }, [search, tab, fixedEntries, history, open]);

  const blocker = operationInProgress ? "EEPROM 操作正在执行"
    : configSaving ? "正在修改 XML 文件"
    : status.cycle_running ? "周期通信正在运行，请先停止周期通信"
      : !slave ? "请选择从站"
        : loading ? "正在加载 XML/BIN"
          : generationError ? generationError
            : !esi && !bin ? "请选择 XML/BIN"
              : esi && ordinal < 0 ? "XML 包含多个 Device，请明确选择烧录设备"
                : esi && parsedConfig.error ? parsedConfig.error
                  : !flashTarget || targetContextRef.current !== contextKey ? "正在准备烧录目标"
                    : "";

  // Both file formats share one programming command and one history list.
  const flash = async () => {
    if (!slave || !flashTarget || blocker) return;
    setResult(undefined);
    setProgress({ operation: "eeprom-flash", stage: "准备", completed: 0, total: 100, percent: 0, detail: "准备写入与完整回读", tone: "info", cancellable: true });
    try {
      const payload = await bridgeRequest<FlashPayload>("eeprom_flash", { position: slave.position, target_id: flashTarget.target_id, auto_reset: autoResetEsc }, { file: bin?.path ?? esi?.path, device: bin ? "原始 BIN" : deviceDisplayName(currentDevice), size: flashTarget.size });
      if (!payload.success) {
        const text = payload.result.image_verification;
        setResult({ severity: "error", text });
        setProgress({ operation: "eeprom-flash", stage: "烧录失败", completed: 100, total: 100, percent: 100, detail: text, tone: "error" });
        return;
      }
      const effective = bin ? "" : parsedConfig.formatted!;
      const entry: FlashHistoryEntry = {
        path: bin?.path ?? esi!.path,
        documentSha256: bin?.sha256 ?? esi!.sha256,
        ordinal: bin ? -1 : ordinal,
        deviceName: bin ? "原始 BIN" : deviceDisplayName(currentDevice),
        vendorId: bin ? 0 : esi!.vendor_id,
        productCode: bin ? 0 : currentDevice!.product_code,
        revision: bin ? 0 : Number(currentDevice!.revision ?? currentDevice!.revision_number ?? 0),
        byteSize: flashTarget.size,
        originalConfigData: bin ? "" : originalConfigData || effective,
        effectiveConfigData: effective,
        flashedAt: new Date().toISOString(),
        slaveKey: contextKey,
      };
      setHistory((current) => saveFlashHistory(entry, window.localStorage, current));
      if (contextRef.current === contextKey) {
        void bridgeRequest<EepromHeader>("eeprom_header", { position: slave.position })
          .then((value) => { if (contextRef.current === contextKey) { setHeader(value); setHeaderError(""); } })
          .catch(() => { if (contextRef.current === contextKey) setHeaderError("无法读取设备当前配置"); });
      }
      const reloadFailed = payload.result.reload_verified === false;
      const hasWarning = reloadFailed || !autoResetEsc || payload.result.sii_valid === false || payload.result.semantic_valid === false;
      const text = reloadFailed
        ? payload.result.reload_error || "镜像已写入，但复位后未能重新加载。"
        : autoResetEsc ? "烧录完成，完整回读与目标一致。" : "烧录完成，完整回读与目标一致；未复位 ESC。";
      setResult({ severity: hasWarning ? "warning" : "success", text });
      setProgress({ operation: "eeprom-flash", stage: reloadFailed ? "烧录完成，复位后重新加载失败" : "烧录完成", completed: 100, total: 100, percent: 100, detail: text, tone: hasWarning ? "warning" : "success", cancellable: false });
    } catch (error) {
      const text = error instanceof BridgeRequestError ? error.message : "烧录未完成，请重新读取设备确认当前内容。";
      const cancelled = error instanceof BridgeRequestError && error.code === "CANCELLED";
      const severity = cancelled ? "info" : error instanceof BridgeRequestError ? error.severity : "error";
      setResult({ severity, text });
      setProgress({ operation: "eeprom-flash", stage: cancelled ? "已取消" : severity === "warning" ? "烧录结果未确认" : "烧录失败", completed: 100, total: 100, percent: 100, detail: text, tone: severity, cancellable: false });
    }
  };

  // Favorites describe the XML source, while history retains the bytes actually written.
  const favoriteHistory = useCallback((item: FlashHistoryEntry) => {
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
      config_data: item.originalConfigData,
    };
    setFixedState((current) => saveFixedEsiState(addFixedEsiEntry(current, favorite)));
  }, []);

  // List deletion and unfavoriting only remove shortcuts, never files.
  const removeFixed = useCallback((item: { path: string }) => {
    setFixedState((current) => saveFixedEsiState(removeFixedEsiEntry(current, item, library.entries)));
  }, [library.entries]);

  // Report location failures next to the programming result.
  const openXmlLocation = useCallback(async (path: string) => {
    try {
      await revealPath(path);
    } catch (_error) {
      setResult({ severity: "error", text: "无法打开文件位置，请检查文件是否仍存在。" });
    }
  }, []);

  // Selecting a source reloads its XML original instead of replaying a saved override.
  const renderSource = useCallback((item: LibraryEntry | FlashHistoryEntry, recent: boolean) => {
    const path = item.path;
    const deviceName = recent ? (item as FlashHistoryEntry).deviceName : (item as LibraryEntry).type_name || (item as LibraryEntry).device_name;
    const productCode = recent ? (item as FlashHistoryEntry).productCode : (item as LibraryEntry).product_code;
    const sourceConfig = recent ? (item as FlashHistoryEntry).effectiveConfigData : (item as LibraryEntry).config_data;
    const itemOrdinal = recent ? (item as FlashHistoryEntry).ordinal : (item as LibraryEntry).ordinal;
    const hasDevice = itemOrdinal >= 0;
    const binary = isBinFile(path);
    const byteSize = recent ? (item as FlashHistoryEntry).byteSize : (item as LibraryEntry).byte_size;
    const decoded = decodeConfigData(sourceConfig);
    const selected = Boolean((bin || esi) && sameEepromSource({ path: bin?.path ?? esi!.path }, item));
    const inFixedList = fixedIndex.byPath.has(sourcePathKey(item));
    // Equal filenames at different locations remain distinct and display their paths.
    const showPath = displayedIndex.duplicateNames.has(fileName(path).toLowerCase());
    const rowKey = path.toLowerCase();
    return <Box key={rowKey} className="eeprom-file-row" sx={{ position: "relative", mb: 0.4 }}>
      <ListItemButton
        disableRipple={false}
        selected={selected}
        disabled={operationInProgress || configSaving}
        onClick={() => void loadFile(path, itemOrdinal)}
        onDoubleClick={() => void openXmlLocation(path)}
        title={`${path}\n双击打开文件位置`}
        sx={{ alignItems: "flex-start", borderRadius: 1.15, border: 1, borderColor: selected ? "primary.main" : "transparent", px: 1, pr: 8, py: 0.7 }}
      >
        <ListItemText
          primary={<Typography fontWeight={700} fontSize={12.5} noWrap title={fileName(path)}>{fileName(path)}</Typography>}
          secondary={<Stack spacing={0.2} sx={{ mt: 0.25 }}>
            {showPath && <Typography variant="caption" fontSize={10.5} color="text.secondary" noWrap title={path}>{path}</Typography>}
            <Typography variant="caption" fontSize={11} color="text.secondary" noWrap title={deviceName}>{binary ? `BIN · ${byteSize} B · 原始数据` : hasDevice ? `Device：${deviceName}` : "XML · 加载后选择 Device"}</Typography>
            {!binary && hasDevice && <Typography variant="caption" fontSize={11} className="mono">Product：{hex(productCode, 8)}</Typography>}
            {!binary && hasDevice && <Typography variant="caption" fontSize={11} color="text.secondary" fontWeight={650}>{decoded ? `${hexByte(decoded.pdiCode)} · ${decoded.pdiLabel}` : "ConfigData 未解析"}</Typography>}
            {recent && <Typography variant="caption" fontSize={10.5} color="text.secondary">{new Date((item as FlashHistoryEntry).flashedAt).toLocaleString()}</Typography>}
          </Stack>}
        />
      </ListItemButton>
      <Stack direction="row" sx={{ position: "absolute", top: 4, right: 4 }}>
        <Tooltip title="删除记录（不删除文件）"><span className="eeprom-hover-action"><IconButton size="small" disabled={operationInProgress || configSaving} aria-label={`删除记录 ${fileName(path)}`} onClick={() => recent ? setHistory(current => removeFlashHistory(item, current)) : removeFixed(item)}><DeleteOutlineRounded fontSize="small" /></IconButton></span></Tooltip>
        {recent ? <Tooltip title={inFixedList ? "取消收藏" : "收藏到固定列表"}><span className={inFixedList ? undefined : "eeprom-hover-action"}><IconButton size="small" disabled={operationInProgress || configSaving} aria-label={inFixedList ? "取消收藏" : "收藏到固定列表"} onClick={() => inFixedList ? removeFixed(item) : favoriteHistory(item as FlashHistoryEntry)}>{inFixedList ? <StarRounded fontSize="small" color="warning" /> : <StarOutlineRounded fontSize="small" color="action" />}</IconButton></span></Tooltip> : <Tooltip title="取消收藏（不删除文件）"><span><IconButton size="small" disabled={operationInProgress || configSaving} aria-label="取消收藏" onClick={() => removeFixed(item)}><StarRounded fontSize="small" color="warning" /></IconButton></span></Tooltip>}
      </Stack>
    </Box>;
  }, [bin?.path, esi?.path, fixedIndex, displayedIndex, operationInProgress, configSaving, loadFile, openXmlLocation, favoriteHistory, removeFixed]);

  // Reuse row elements while only telemetry changes, and mount long lists in batches.
  const sourceRows = useMemo(() => tab === 0 ? filteredHistory.map(item => renderSource(item, true))
    : filteredLibrary.slice(0, visibleCount).map(item => renderSource(item, false)), [tab, filteredHistory, filteredLibrary, visibleCount, renderSource]);

  // A manual refresh bypasses cached metadata, including malformed-file results.
  const refreshLibrary = async () => {
    await loadLibrary(true);
  };

  const handleClose = (_event?: object, reason?: "backdropClick" | "escapeKeyDown") => {
    if (operationInProgress || configSaving || reason === "backdropClick" && operationInProgress) return;
    saveQuickFlashTab(tab);
    openedContextRef.current = "";
    onClose();
  };

  return <Dialog open={open} onClose={handleClose} fullWidth maxWidth="lg" transitionDuration={0} disableEscapeKeyDown={operationInProgress || configSaving}
    PaperProps={{ sx: { width: "calc(100% - 96px)", maxWidth: 1080, height: { xs: "calc(100vh - 56px)", xl: 730 }, maxHeight: "calc(100vh - 56px)", borderRadius: 2, overflow: "hidden", outline: dragOver ? "2px solid #9aaedb" : undefined } }}>
    <DialogTitle sx={{ py: 1.35, px: 2 }}>
      <Box><Typography variant="h6" fontWeight={780} fontSize={18}>快速烧录 EEPROM</Typography><Typography variant="body2" fontSize={12.5} color="text.secondary">{slave ? `从站 ${slave.position} · ${slaveDisplayName(slave)} · ${slave.chip_model}` : "未选择从站"}</Typography></Box>
    </DialogTitle>
    <Divider />
    <DialogContent sx={{ p: 0, overflow: "hidden" }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "290px minmax(0, 1fr)", xl: "320px minmax(0, 1fr)" }, height: "100%", minHeight: 0 }}>
        <Box sx={{ borderRight: 1, borderColor: "divider", display: "flex", flexDirection: "column", minHeight: 0, bgcolor: "#FBFCFE" }}>
          <Tabs value={tab} onChange={(_, value: 0 | 1) => { setTab(value); saveQuickFlashTab(value); }} variant="fullWidth" sx={{ minHeight: 40, bgcolor: "background.paper" }}>
            <Tab disableRipple={false} icon={<HistoryRounded sx={{ fontSize: 18 }} />} iconPosition="start" label={`最近烧录 ${history.length || ""}`} sx={{ minHeight: 40, py: 0.7, fontSize: 12.5 }} />
            <Tab disableRipple={false} icon={<Inventory2Rounded sx={{ fontSize: 18 }} />} iconPosition="start" label={`固定列表 ${fixedEntries.length || ""}`} sx={{ minHeight: 40, py: 0.7, fontSize: 12.5 }} />
          </Tabs>
          <Box sx={{ p: 1 }}><TextField fullWidth size="small" placeholder="搜索 XML/BIN、Device、Product" value={query} onChange={(event) => setQuery(event.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 18 }} /></InputAdornment> }} sx={{ "& .MuiInputBase-input": { py: 0.8, fontSize: 12.5 } }} /></Box>
          <List dense sx={{ px: 0.65, pb: 0.8, overflow: "auto", flex: 1 }}>
            {sourceRows}
            {tab === 1 && filteredLibrary.length > visibleCount && <Button fullWidth size="small" onClick={() => setVisibleCount(count => count + 50)}>显示更多（{visibleCount} / {filteredLibrary.length}）</Button>}
            {tab === 0 && filteredHistory.length === 0 && <Box sx={{ py: 7, px: 2, textAlign: "center", color: "text.secondary" }}><HistoryRounded sx={{ opacity: 0.3, fontSize: 38 }} /><Typography fontWeight={700}>暂无最近烧录</Typography><Typography variant="caption">成功烧录后保留最近 {FLASH_HISTORY_LIMIT} 个文件，同一路径只显示最新记录</Typography></Box>}
            {tab === 1 && filteredLibrary.length === 0 && <Box sx={{ py: 7, px: 2, textAlign: "center", color: "text.secondary" }}><Inventory2Rounded sx={{ opacity: 0.3, fontSize: 38 }} /><Typography fontWeight={700}>固定列表为空</Typography><Typography variant="caption">{library.directory || "未找到 xml列表 目录"}</Typography></Box>}
          </List>
          {library.errors.length > 0 && tab === 1 && <Alert severity="warning" sx={{ m: 1, mt: 0 }}>{library.errors.length} 个文件无法加载</Alert>}
          <Box sx={{ p: 1, borderTop: 1, borderColor: "divider", bgcolor: dragOver ? "#f6f8fd" : "background.paper" }}>
            <Stack direction="row" gap={0.5}><Button fullWidth size="small" variant="outlined" disableRipple={false} startIcon={<FolderOpenRounded />} disabled={operationInProgress || configSaving} onClick={chooseFile}>选择 XML/BIN</Button><Tooltip title="刷新固定列表"><span><IconButton size="small" aria-label="刷新固定列表" disabled={operationInProgress || configSaving} onClick={() => void refreshLibrary()}><RefreshRounded fontSize="small" /></IconButton></span></Tooltip></Stack>
            <Typography variant="caption" color={dragOver ? "primary.main" : "text.secondary"} display="block" textAlign="center" aria-live="polite" sx={{ mt: 0.5 }}>{operationInProgress || configSaving ? "操作中，暂不可切换文件" : dragOver ? "松开以加载 XML/BIN" : "也可将 XML/BIN 拖入此窗口"}</Typography>
          </Box>
        </Box>

        <Box sx={{ p: 2, overflow: "auto", minWidth: 0 }}>
          {progress && operationInProgress && <Box sx={{ mb: 1.5, p: 1.4, borderRadius: 1.5, bgcolor: "#F2F7FF", border: 1, borderColor: "primary.light" }}><Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}><Box minWidth={0}><Typography fontWeight={750}>{progress.stage}</Typography><Typography variant="caption" color="text.secondary">{progress.detail}</Typography></Box><Typography className="mono" fontWeight={700}>{progress.percent}%</Typography></Stack><LinearProgress variant="determinate" value={progress.percent} sx={{ mt: 1, height: 6, borderRadius: 4 }} /></Box>}
          {result && <Alert severity={result.severity} sx={{ mb: 1.5 }}>{result.text}</Alert>}
          <Box sx={{ p: 1.45, mb: 1.5, border: 1, borderLeft: 4, borderColor: "#D7DCE3", borderLeftColor: "#7B8794", borderRadius: 1.5, bgcolor: "#F8F9FB" }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.1 }}>
              <Typography fontWeight={780} fontSize={15}>当前从站 · 设备实际值</Typography>
            </Stack>
            <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 1.25 }}>
              <Box sx={{ p: 1.35, border: 1, borderColor: "divider", borderRadius: 1.25, bgcolor: "background.paper", minWidth: 0 }}>
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>当前 Device</Typography>
                <TextField select fullWidth size="small" value={slave?.position ?? ""} disabled={operationInProgress || configSaving || status.slaves.length === 0} onChange={(event) => onSelectSlave(Number(event.target.value))} SelectProps={{ displayEmpty: true }} inputProps={{ "aria-label": "选择烧录从站" }} sx={{ mt: 0.45, mb: 0.75, "& .MuiSelect-select": { fontSize: 13 } }}>
                  {status.slaves.length === 0 && <MenuItem value="">未发现从站</MenuItem>}
                  {status.slaves.map((item) => <MenuItem key={item.position} value={item.position}>从站 {item.position} · {slaveDisplayName(item)}</MenuItem>)}
                </TextField>
                <Typography fontWeight={780} fontSize={14} noWrap title={slaveDisplayName(slave)}>Device：{slaveDisplayName(slave)}</Typography>
                <Typography variant="body2" fontSize={13} color="text.secondary" noWrap>{slave ? `从站 ${slave.position} · ${slave.chip_model}` : "未选择从站"}</Typography>
              </Box>
              <ConfigSummary title="实际 EEPROM ConfigData" configData={header?.config_data ?? ""} placeholder={!slave ? "等待从站连接…" : headerError ? "读取失败" : "读取中…"} subtle />
            </Box>
            {headerError ? <Alert severity="warning" sx={{ mt: 1 }}>暂时无法读取设备当前配置，仍可尝试烧录。</Alert>
              : header?.sii_status === "blank" ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>EEPROM 未烧录，可直接烧录。</Typography>
                : header?.sii_error && <Alert severity="warning" sx={{ mt: 1 }}>设备信息未能完整读取或解析，仍可尝试烧录。</Alert>}
          </Box>
          {generationError && <Alert severity="error" sx={{ mb: 1.5 }}>{generationError}</Alert>}
          {!esi && !bin ? <Box sx={{ minHeight: 280, display: "grid", placeItems: "center", textAlign: "center", color: "text.secondary", border: "2px dashed", borderColor: dragOver ? "primary.main" : "transparent", borderRadius: 1.5 }}><Stack alignItems="center" spacing={1} aria-live="polite"><MemoryRounded sx={{ fontSize: 48, opacity: 0.24 }} /><Typography fontWeight={750} color={dragOver ? "primary.main" : undefined}>{dragOver ? "松开以加载 XML/BIN" : sourcePath ? fileName(sourcePath) : "选择文件，或将 XML/BIN 拖入此窗口"}</Typography><Typography variant="body2">{!slave ? "请连接从站并扫描，默认选择从站 1" : sourcePath && loading ? "正在加载烧录文件…" : "XML 可临时修改 ConfigData；BIN 按原始内容写入"}</Typography>{(loading || initialSource) && <CircularProgress size={22} />}</Stack></Box> : bin ? <Stack spacing={1.75}>
            <Box sx={{ p: 1.75, border: 1, borderColor: "divider", borderRadius: 1.5, bgcolor: "#FAFBFD" }}>
              <Typography fontWeight={780} fontSize={15}>选中 BIN · 待烧录目标</Typography>
              <Typography fontWeight={750} sx={{ mt: 1 }}>{fileName(bin.path)}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere", mt: 0.5 }}>{bin.path}</Typography>
              <Stack direction="row" gap={1} sx={{ my: 1.5 }}><Chip label="BIN" variant="outlined" /><Chip label={`待写入 ${bin.size} B`} variant="outlined" /></Stack>
              <Typography variant="caption" color="text.secondary">SHA-256</Typography>
              <Typography className="mono" variant="body2" sx={{ overflowWrap: "anywhere" }}>{bin.sha256}</Typography>
            </Box>
            <Alert severity="info">从 EEPROM 地址 0 开始写入文件原始字节，不修改 ConfigData、CRC、身份或 SII 类别。</Alert>
          </Stack> : esi ? <Stack spacing={1.75}>
            <Box sx={{ p: 1.45, border: 1, borderLeft: 4, borderColor: "divider", borderLeftColor: "#8A9EC6", borderRadius: 1.5, bgcolor: "#FAFBFD" }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1.1 }}>
                <Typography fontWeight={780} fontSize={15}>选中 XML · 待烧录目标</Typography>
                {target && <Chip size="small" label={`XML · ${target.size} B`} variant="outlined" />}
              </Stack>
              {esi.devices.length > 1 && <TextField select fullWidth size="small" label="Device" value={ordinal} disabled={operationInProgress || loading || configSaving} sx={{ mb: 1.25 }} onChange={(event) => {
                const selected = Number(event.target.value);
                const config = deviceConfigData(esi.devices[selected]);
                setOrdinal(selected); setOriginalConfigData(config); setConfigData(config);
                void generate(esi, selected, config);
              }}><MenuItem value={-1} disabled>请选择烧录设备</MenuItem>{esi.devices.map((device, index) => <MenuItem key={index} value={index}>{deviceDisplayName(device)} · {hex(device.product_code, 8)} · Rev {hex(Number(device.revision ?? device.revision_number ?? 0), 8)}</MenuItem>)}</TextField>}
              <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 1.25 }}>
                <Box sx={{ p: 1.35, borderRadius: 1.25, bgcolor: "background.paper", border: 1, borderColor: "divider", minWidth: 0 }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.55 }}>XML 文件</Typography><Typography fontWeight={780} fontSize={14} noWrap title={fileName(esi.path)}>{fileName(esi.path)}</Typography><Typography variant="body2" fontSize={13} color="text.secondary" noWrap title={deviceDisplayName(currentDevice)}>Device：{deviceDisplayName(currentDevice)}</Typography>
                </Box>
                <ConfigSummary title="XML ConfigData" configData={configData} />
              </Box>
              <Divider sx={{ my: 1.35 }} />
              <Box sx={{ mb: 0.9 }}><Typography fontWeight={750} fontSize={14}>XML ConfigData解析</Typography><Typography variant="caption" color="text.secondary" fontSize={12}>1–14 byte；点击“修改至文件”保存到当前 XML Device</Typography></Box>
              {/* Keep the explicit XML save action beside its editable value. */}
              <Stack direction="row" gap={1} alignItems="flex-start">
                <TextField size="small" fullWidth value={configData} disabled={operationInProgress || configSaving || loading || ordinal < 0} error={Boolean(parsedConfig.error)} helperText={parsedConfig.error} onChange={(event) => { requestRef.current += 1; generatedConfigRef.current = ""; setConfigData(event.target.value.toUpperCase()); setTarget(undefined); }} onBlur={() => parsedConfig.formatted && setConfigData(parsedConfig.formatted)} inputProps={{ "aria-label": "快速烧录 ConfigData", className: "mono", spellCheck: false, style: { fontSize: 13.5 } }} FormHelperTextProps={{ sx: { fontSize: 12, mt: 0.45 } }} />
                <Button size="small" sx={{ flexShrink: 0, mt: 0.25 }} startIcon={configSaving ? <CircularProgress size={14} color="inherit" /> : <SaveRounded />} disabled={operationInProgress || configSaving || loading || ordinal < 0 || Boolean(parsedConfig.error) || parsedConfig.formatted === originalConfigData} onClick={() => void saveConfigToFile()}>修改至文件</Button>
              </Stack>
              {targetDecoded && <><Divider sx={{ my: 1.35 }} /><Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1 }}>{[
                ["0x0140 · PDI Control", `${hexByte(targetDecoded.pdiCode)} · ${targetDecoded.pdiLabel}`],
                ["0x0141 · ESC Configuration", hexByte(targetDecoded.escConfiguration)],
                ["0x0150 · PDI Configuration", hexByte(targetDecoded.pdiConfiguration)],
                ["0x0151 · SYNC/LATCH", hexByte(targetDecoded.syncLatchConfiguration)],
                ["0x0982 · SYNC 脉宽", `${hexWord(targetDecoded.syncPulse)} · ${targetDecoded.syncPulse === 0 ? "ACK 模式" : `${targetDecoded.syncPulse * 10} ns`}`],
                ["0x0152 · Extended PDI", hexWord(targetDecoded.extendedPdiConfiguration)],
                ["0x0012 · Station Alias", hexWord(targetDecoded.stationAlias)],
              ].map(([label, value]) => <Box key={label} sx={{ minWidth: 0, minHeight: 55, p: 0.9, border: 1, borderColor: "divider", borderRadius: 1.1, bgcolor: "background.paper" }}><Typography variant="caption" color="text.secondary" fontSize={11.5}>{label}</Typography><Typography variant="body2" className="mono" fontWeight={650} fontSize={13} sx={{ mt: 0.2 }} noWrap title={value}>{value}</Typography></Box>)}</Box></>}
            </Box>
          </Stack> : null}
        </Box>
      </Box>
    </DialogContent>
    <Divider />
    <DialogActions sx={{ px: 2, py: 1, justifyContent: "space-between" }}>
      <Button disabled={(!bin && (!esi || ordinal < 0)) || operationInProgress || loading || configSaving} onClick={() => onOpenDetails({ path: bin?.path ?? esi!.path, ordinal: bin ? -1 : ordinal, configData: bin ? "" : originalConfigData })}>进入 EEPROM 详情</Button>
      <Stack direction="row" gap={1} alignItems="center"><Typography variant="caption" color="text.secondary" sx={{ maxWidth: 420, textAlign: "right" }}>{blocker || (autoResetEsc ? "有写入时自动复位 ESC" : "烧录后不复位 ESC")}</Typography><Button disabled={operationInProgress || configSaving} onClick={() => handleClose()}>取消</Button><Button variant="contained" disableRipple={false} startIcon={operationInProgress ? <CircularProgress size={16} color="inherit" /> : <MemoryRounded />} disabled={Boolean(blocker)} onClick={flash}>烧录</Button></Stack>
    </DialogActions>
  </Dialog>;
}
