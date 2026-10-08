import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { MemoryRounded, SaveAltRounded, EditRounded, FolderOpenRounded } from "@mui/icons-material";
import { operationStore } from "./operationStore";
import { EepromDataView } from "./EepromDataView";
import { EepromSources } from "./EepromSources";
import type { ImageSnapshot } from "./eepromViewModel";
import { BridgeRequestError, bridgeRequest, onFileDrop, pickDirectory, pickFile, revealPath } from "./api";
import {
  decodeConfigData,
  isBinFile,
  loadRecentEsi,
  normalizeConfigData,
  sameEepromSource,
  writeRecentEsi,
  type EepromBinTarget,
  type FixedEsiEntry,
} from "./eepromConfig";
import type { EepromDetailSelection, EepromProgressState } from "./QuickEepromFlashDialog";
import type { EsiDevice, SlaveInfo, WorkbenchStatus } from "./types";
import { hex } from "./types";
import { EmptyState, PageTitle, esiDeviceDisplayName, slaveDisplayName, slaveIdentityKey } from "./pageShared";
type Run = <T>(operation: () => Promise<T>, success?: string) => Promise<T | undefined>;
const isEepromOperation = (operation?: string) => Boolean(operation?.startsWith("eeprom"));

interface EsiResult { document_id: string; path: string; sha256: string; vendor_id: number; vendor_name: string; devices: EsiDevice[] }
interface TargetResult { target_id: string; size: number; sha256: string; supported: string[]; omitted: string[]; device: EsiDevice; original_config_data?: string; effective_config_data?: string }
type ProgressState = EepromProgressState;
interface EepromComparisonResult { equal: boolean; differing_bytes: number; first_difference?: number | null; target_sha256: string; readback_sha256: string }
export interface EepromReadResult extends ImageSnapshot { data: string; size: number; sha256: string; read_at: string; sii_valid: boolean; sii_error?: string; identity?: { vendor_id: number; product_code: number; revision: number; serial_number: number }; category_count?: number; categories?: number[]; end_offset?: number; comparison?: EepromComparisonResult }
interface EepromFlashDetails { bytes_read_back: number; words_written: number; comparison: EepromComparisonResult; sii_valid: boolean; semantic_valid: boolean | null; image_verification: string; reset_sequence?: boolean[] | null; rediscovered?: boolean | null; reload_verified?: boolean | null; reload_error?: string | null }
interface EepromFlashPayload { success: boolean; result: EepromFlashDetails; slaves: SlaveInfo[] }
interface EepromOperationResult { title: string; severity: "success" | "warning" | "error" | "info"; payload?: EepromFlashPayload; error?: string }

function deviceRevision(device: EsiDevice): number {
  return Number(device.revision ?? device.revision_number ?? 0);
}

function deviceConfigData(device?: EsiDevice): string {
  const value = typeof device?.config_data === "string" ? device.config_data : "";
  return normalizeConfigData(value).formatted ?? "";
}

/** Align current and target facts, and mark only known differing configuration bytes. */
function EepromSummaryColumn({ title, tag, rows, config, compareConfig, placeholder, configInput, configAction, emptyState }: {
  title: string; tag?: string; rows: { label: string; value: ReactNode }[];
  config: string; compareConfig?: string; placeholder: string;
  configInput?: ReactNode; configAction?: ReactNode; emptyState?: ReactNode;
}) {
  const parsed = normalizeConfigData(config);
  const comparison = normalizeConfigData(compareConfig ?? "");
  const decoded = decodeConfigData(config);
  return <Card className="eeprom-summary" variant="outlined">
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 1.75, py: 1.25, bgcolor: "#F8F9FC", borderBottom: 1, borderColor: "divider" }}>
      <Typography fontWeight={750}>{title}</Typography>{tag && <Chip size="small" label={tag} variant="outlined" />}
    </Stack>
    {/* An unloaded target replaces all placeholder facts and configuration bytes. */}
    {emptyState ?? <><Box sx={{ px: 1.75, py: 0.5 }}>{rows.map((row) => <Box key={row.label} className="eeprom-summary-row"><Typography variant="caption" color="text.secondary">{row.label}</Typography><Box className="eeprom-summary-value">{row.value}</Box></Box>)}</Box>
    <Box className="eeprom-config-summary">
      <Typography variant="caption" color="text.secondary" fontWeight={550}>ConfigData · 前 14 字节</Typography>
      <Stack direction="row" gap={1} alignItems="flex-start" className="eeprom-config-row" sx={{ mt: 0.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>{configInput ?? <Box className="mono eeprom-config-bytes">{parsed.bytes ? parsed.bytes.map((byte, index) => <span key={index} className={comparison.bytes?.[index] !== undefined && comparison.bytes[index] !== byte ? "eeprom-byte-changed" : undefined}>{byte.toString(16).toUpperCase().padStart(2, "0")}</span>) : <Typography variant="body2" color="text.secondary">{placeholder}</Typography>}</Box>}</Box>
        {configAction}
      </Stack>
      <Typography variant="caption" color="text.secondary" fontWeight={550} sx={{ display: "block", mt: 0.5, minHeight: 20 }}>{decoded ? `PDI ${hex(decoded.pdiCode, 2)} · ${decoded.pdiLabel}` : "PDI —"}</Typography>
    </Box></>}
  </Card>;
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
  onAutoResetChange: (value: boolean) => void;
  fileDropEnabled: boolean;
  deviceOperationsBlocked: boolean;
}

// ConfigData drafts are written to the selected XML only after an explicit save.
export const EepromPage = memo(function EepromPage({ slave, status, progress, setProgress, run, readResult, setReadResult, initialSelection, onInitialSelectionConsumed, autoResetEsc, onAutoResetChange, fileDropEnabled, deviceOperationsBlocked }: EepromPageProps) {
  const [esi, setEsi] = useState<EsiResult>();
  const [bin, setBin] = useState<EepromBinTarget>();
  const [ordinal, setOrdinal] = useState(-1);
  const [target, setTarget] = useState<TargetResult>();
  const flashTarget = bin ?? target;
  const [generationError, setGenerationError] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [readLength, setReadLength] = useState("");
  const [readRange, setReadRange] = useState<"device" | "target" | "custom">();
  const [configEditing, setConfigEditing] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaveError, setConfigSaveError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [configurationChanged, setConfigurationChanged] = useState(false);
  // Resolve one explicit range for both reading and exporting; never silently fall back.
  const effectiveRange = readRange ?? (slave?.eeprom_capacity != null ? "device" : flashTarget ? "target" : "custom");
  const capacity = effectiveRange === "device" ? slave?.eeprom_capacity ?? undefined
    : effectiveRange === "target" ? flashTarget && flashTarget.size + flashTarget.size % 2
    : readLength.trim() ? Number(readLength) : undefined;
  const invalidReadLength = capacity !== undefined && (!Number.isInteger(capacity) || capacity < 2 || capacity > 131072 || capacity % 2 !== 0);
  const readLengthRequired = capacity === undefined;
  const readLengthHint = invalidReadLength ? "请输入 2–131072 范围的偶数"
    : readLengthRequired ? effectiveRange === "device" ? "设备声明容量未知，请选择其他范围" : effectiveRange === "target" ? "请先选择 XML/BIN 目标" : "请填写读取长度" : "";
  const fullSiiRead = readResult?.size === slave?.eeprom_capacity;
  const [recentEsi, setRecentEsi] = useState(loadRecentEsi);
  // Refresh records changed by quick programming when its dialog closes.
  useEffect(() => { if (fileDropEnabled) setRecentEsi(loadRecentEsi()); }, [fileDropEnabled]);
  const [configData, setConfigData] = useState("");
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
  const operationInProgress = isEepromOperation(progress?.operation) && progress!.percent < 100;
  const canFlash = Boolean(slave && flashTarget && !configEditing && !configSaving && (!esi || !configDataResult.error) && !generationError && targetContextRef.current === contextKey && !status.cycle_running && !operationInProgress && !deviceOperationsBlocked);
  const blockers = [deviceOperationsBlocked && "软件正在更新", operationInProgress && "已有 EEPROM 操作正在执行", status.cycle_running && "需要停止周期通信", configEditing && "请先保存 ConfigData 到 XML", configSaving && "正在保存 XML", !slave && "请选择从站", esi && ordinal < 0 && "请选择 XML Device", esi && ordinal >= 0 && configDataResult.error, generationError, !flashTarget && "需要准备 XML/BIN 目标", flashTarget && targetContextRef.current !== contextKey && "目标从站或连接已变化"].filter(Boolean) as string[];
  useEffect(() => {
    generationRequestRef.current += 1;
    loadRequestRef.current += 1;
    generatedConfigRef.current = "";
    setEsi(undefined); setBin(undefined); setOrdinal(-1); setTarget(undefined); setConfigData("");
    setGenerationError(""); setOperationResult(undefined); setBackupPath(""); setReadLength("");
    setReadRange(undefined); setConfigEditing(false); setConfigSaving(false); setConfigSaveError(""); setDetailsOpen(false); setConfigurationChanged(false);
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
    setConfigEditing(false); setConfigSaveError(""); setOperationResult(undefined);
    const document = await run(() => bridgeRequest<EsiResult>("esi_load", { path }));
    if (document && loadRequestRef.current === loadId && contextRef.current === context) {
      setRecentEsi(writeRecentEsi([document.path, ...loadRecentEsi()]));
      const matches = slave && slave.identity_valid !== false ? document.devices.map((device, index) =>
        document.vendor_id === slave.identity.vendor_id && device.product_code === slave.identity.product_code && deviceRevision(device) === slave.identity.revision ? index : -1,
      ).filter((index) => index >= 0) : [];
      const selectedOrdinal = preferredOrdinal !== undefined && document.devices[preferredOrdinal] ? preferredOrdinal : matches.length === 1 ? matches[0] : document.devices.length === 1 ? 0 : -1;
      const original = deviceConfigData(document.devices[selectedOrdinal]);
      const effective = normalizeConfigData(overrideConfig ?? original).formatted ?? original;
      setEsi(document); setOrdinal(selectedOrdinal); setConfigData(effective);
      if (selectedOrdinal >= 0) await generate(document, selectedOrdinal, effective);
    }
  }, [contextKey, generate, run, slaveIdentityKey(slave)]);
  // Load BIN bytes into a frozen target; XML follows the existing Device workflow.
  const loadFile = useCallback(async (path: string, preferredOrdinal?: number, overrideConfig?: string) => {
    if (!isBinFile(path)) return loadXml(path, preferredOrdinal, overrideConfig);
    const loadId = ++loadRequestRef.current;
    const context = contextKey;
    generationRequestRef.current += 1;
    generatedConfigRef.current = "";
    setEsi(undefined); setBin(undefined); setTarget(undefined); setOrdinal(-1);
    setConfigData(""); setGenerationError(""); setOperationResult(undefined);
    setConfigEditing(false); setConfigSaveError("");
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
      setRecentEsi(writeRecentEsi([value.path, ...loadRecentEsi()]));
    }
  }, [contextKey, loadXml, run, slave?.position]);

  useEffect(() => {
    if (!initialSelection) return;
    onInitialSelectionConsumed();
    void loadFile(initialSelection.path, initialSelection.ordinal, initialSelection.configData);
  }, [initialSelection, loadFile, onInitialSelectionConsumed]);
  // XML and BIN use one picker and one programming button.
  const selectFile = useCallback(async () => {
    const path = await pickFile(["xml", "bin"]); if (path) await loadFile(path);
  }, [loadFile]);
  // Stable source actions keep the file list independent of progress updates.
  const selectSource = useCallback((path: string, deviceOrdinal?: number) => { void loadFile(path, deviceOrdinal); }, [loadFile]);
  const removeRecentSource = useCallback((path: string) => {
    setRecentEsi(writeRecentEsi(loadRecentEsi().filter(item => !sameEepromSource({ path: item }, { path }))));
  }, []);
  useEffect(() => {
    setDragOver(false);
    if (!fileDropEnabled) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void onFileDrop((paths) => {
      const source = paths.find((path) => /\.(xml|bin)$/i.test(path));
      if (source && !operationInProgress && !configSaving && !deviceOperationsBlocked) void loadFile(source);
    }, hovering => setDragOver(hovering && !operationInProgress && !configSaving && !deviceOperationsBlocked)).then((value) => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); };
  }, [fileDropEnabled, loadFile, operationInProgress, configSaving, deviceOperationsBlocked]);
  useEffect(() => {
    if (configEditing || configSaving || !esi || ordinal < 0 || !configDataResult.formatted || configDataResult.formatted === generatedConfigRef.current) return;
    setTarget(undefined);
    const timer = window.setTimeout(() => void generate(esi, ordinal, configDataResult.formatted!), 250);
    return () => window.clearTimeout(timer);
  }, [configData, configDataResult.formatted, configEditing, configSaving, esi, generate, ordinal]);
  // Selecting another Device starts from its original XML configuration.
  const changeDevice = async (value: number) => {
    setConfigEditing(false); setConfigSaveError("");
    setOrdinal(value);
    if (esi) {
      const nextConfig = deviceConfigData(esi.devices[value]);
      setConfigData(nextConfig);
      await generate(esi, value, nextConfig);
    }
  };
  // Persist the draft to its loaded Device, then generate a target from the saved XML.
  const saveConfig = async () => {
    if (!esi || ordinal < 0 || !configDataResult.formatted || configSaving || operationInProgress || deviceOperationsBlocked) return;
    const selectedOrdinal = ordinal;
    const requestId = ++loadRequestRef.current;
    const context = contextKey;
    generationRequestRef.current += 1;
    setConfigSaving(true); setConfigSaveError("");
    try {
      const saved = await run(async () => {
        try {
          return await bridgeRequest<EsiResult>("esi_config_save", { document_id: esi.document_id, ordinal: selectedOrdinal, config_data: configDataResult.formatted });
        } catch (error) {
          if (contextRef.current === context && loadRequestRef.current === requestId) setConfigSaveError(error instanceof BridgeRequestError ? error.message : "无法保存 XML，请检查文件写入权限。");
          throw error;
        }
      }, "ConfigData 已保存到 XML");
      if (saved && contextRef.current === context && loadRequestRef.current === requestId) {
        const savedConfig = deviceConfigData(saved.devices[selectedOrdinal]);
        setRecentEsi(writeRecentEsi([saved.path, ...loadRecentEsi()]));
        setEsi(saved); setConfigData(savedConfig); setConfigEditing(false); setTarget(undefined);
        await generate(saved, selectedOrdinal, savedConfig);
      }
    } finally {
      if (contextRef.current === context && loadRequestRef.current === requestId) setConfigSaving(false);
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
  // Read exactly the displayed range and retain the raw bytes for Hex navigation.
  const readFull = async () => {
    if (!slave || invalidReadLength || readLengthRequired) return;
    const value = await operation(() => bridgeRequest<EepromReadResult>("eeprom_read", { position: slave.position, target_id: flashTarget?.target_id, capacity }), "读取完成");
    if (value) { setReadResult(value); if (value.size >= 14) setConfigurationChanged(false); }
  };
  // Export the raw bytes under the selected slave's name.
  const exportBin = async () => {
    if (!slave || invalidReadLength || readLengthRequired) return;
    const directory = await pickDirectory();
    if (!directory) return;
    // Clear the previous export before attempting another destination.
    setBackupPath("");
    const value = await operation(() => bridgeRequest<{ binary_path: string }>("eeprom_backup", {
      position: slave.position,
      directory,
      capacity,
    }), "BIN 文件导出完成");
    if (value) setBackupPath(value.binary_path);
  };
  // Both sources write the frozen target selected for this slave and session.
  const flash = () => {
    if (!canFlash || !slave || !flashTarget) return;
    // A write attempt can change bytes even when it fails; discard the old read snapshot.
    setReadResult(undefined); setConfigurationChanged(true);
    return operation(() => bridgeRequest<EepromFlashPayload>("eeprom_flash", { position: slave.position, target_id: flashTarget.target_id, auto_reset: autoResetEsc }), autoResetEsc ? "烧录完成" : "烧录完成，未复位 ESC", "烧录失败");
  };

  // Prefer a complete read snapshot; shorter reads cannot describe the configuration area.
  const actualConfig = useMemo(() => configurationChanged ? "" : readResult && readResult.size >= 14
    ? readResult.data.trim().split(/\s+/, 14).join(" ")
    : slave?.eeprom_prefix?.trim().split(/\s+/, 14).join(" ") ?? "", [configurationChanged, readResult, slave?.eeprom_prefix]);
  const effectiveConfig = bin ? "" : configEditing ? configData : target?.effective_config_data ?? configData;
  const currentIdentity = readResult?.identity ?? slave?.identity;
  const identityKnown = Boolean(readResult?.identity || slave?.identity_valid !== false);
  const sourcePath = bin?.path ?? esi?.path;
  // Source shortcuts retain Device selection; the image still comes from the loaded XML/BIN.
  const sourceEntry = useMemo<FixedEsiEntry | undefined>(() => sourcePath ? {
    path: sourcePath, sha256: bin?.sha256 ?? esi?.sha256 ?? "", ordinal: bin ? -1 : ordinal,
    vendor_id: esi?.vendor_id ?? 0, vendor_name: esi?.vendor_name ?? "",
    device_name: currentDevice?.name ?? "", type_name: currentDevice ? esiDeviceDisplayName(currentDevice) : "",
    product_code: currentDevice?.product_code ?? 0, revision: currentDevice ? deviceRevision(currentDevice) : 0,
    byte_size: flashTarget?.size ?? currentDevice?.byte_size ?? 0, config_data: currentDevice ? deviceConfigData(currentDevice) : "",
  } : undefined, [sourcePath, bin, esi, ordinal, currentDevice, flashTarget?.size]);
  const readBlocker = deviceOperationsBlocked ? "软件正在更新" : operationInProgress ? "已有 EEPROM 操作正在执行"
    : status.cycle_running ? "请先停止周期通信" : !slave ? "请选择从站" : readLengthHint;
  const readDisabled = Boolean(readBlocker);
  const activeProgress = progress && isEepromOperation(progress.operation) && operationInProgress;

  return <Box className="eeprom-workspace">
    {!slave && <PageTitle title="EEPROM" subtitle="" />}
    {!slave ? <Box sx={{ flex: 1 }}><EmptyState text="请先选择目标从站" /></Box> : <>
      <EepromSources recent={recentEsi} current={sourceEntry} disabled={operationInProgress || configSaving || deviceOperationsBlocked} active={fileDropEnabled} dragOver={dragOver} onChoose={selectFile} onSelect={selectSource} onRemoveRecent={removeRecentSource} />
      <Box className="eeprom-content">
      <Box className="eeprom-top">
        <Box className="eeprom-comparison">
          <EepromSummaryColumn title="当前设备" tag={configurationChanged ? "待重新读取" : undefined}
            config={actualConfig} compareConfig={effectiveConfig} placeholder={configurationChanged ? "写入后请重新读取设备配置" : "暂无设备配置数据"}
            rows={[
              { label: "设备", value: <Typography variant="body2" fontWeight={650} noWrap title={slaveDisplayName(slave)}>从站 {slave.position} · {slaveDisplayName(slave)}</Typography> },
              { label: "Vendor ID", value: identityKnown && currentIdentity ? hex(currentIdentity.vendor_id, 8) : "未知" },
              { label: "Product Code", value: identityKnown && currentIdentity ? hex(currentIdentity.product_code, 8) : "未知" },
              { label: "Revision", value: identityKnown && currentIdentity ? hex(currentIdentity.revision, 8) : "未知" },
              { label: "设备声明容量", value: slave.eeprom_capacity == null ? "未知" : `${slave.eeprom_capacity} B` },
            ]} />
          <EepromSummaryColumn title="待写入目标" tag={bin ? "BIN" : esi ? "XML" : undefined}
            emptyState={!esi && !bin ? <Stack spacing={0.75} alignItems="center" justifyContent="center" aria-live="polite" sx={{ flex: 1, minHeight: 100, p: 3, textAlign: "center", border: "2px dashed", borderColor: dragOver ? "primary.main" : "transparent", borderRadius: 1.5 }}>{dragOver && <Typography variant="body2" fontWeight={650} color="primary.main">松开以加载 XML/BIN</Typography>}<Button size="small" variant="outlined" disableRipple={false} startIcon={<FolderOpenRounded />} disabled={operationInProgress || configSaving || deviceOperationsBlocked} onClick={() => void selectFile()}>选择/拖入XML/BIN</Button>{!dragOver && <Typography variant="body2" color="text.secondary">选择或拖入文件后，显示待写入信息。</Typography>}</Stack> : undefined}
            configInput={configEditing ? <TextField fullWidth size="small" value={configData} disabled={configSaving || operationInProgress || deviceOperationsBlocked} error={Boolean(configDataResult.error || configSaveError)} helperText={configSaveError || configDataResult.error || "保存会修改当前 XML Device 的 ConfigData"} onChange={(event) => { setConfigData(event.target.value.toUpperCase()); setConfigSaveError(""); }} onBlur={() => configDataResult.formatted && setConfigData(configDataResult.formatted)} inputProps={{ "aria-label": "XML ConfigData", className: "mono", spellCheck: false }} /> : undefined}
            configAction={esi && ordinal >= 0 ? <Button size="small" variant={configEditing ? "contained" : "text"} sx={{ flexShrink: 0 }} startIcon={configSaving ? <CircularProgress size={14} color="inherit" /> : configEditing ? undefined : <EditRounded />} disabled={configSaving || operationInProgress || deviceOperationsBlocked || (configEditing && Boolean(configDataResult.error))} onClick={() => { if (configEditing) void saveConfig(); else { generationRequestRef.current += 1; setConfigSaveError(""); setConfigEditing(true); } }}>{configEditing ? "保存" : "编辑"}</Button> : undefined}
            config={effectiveConfig} compareConfig={actualConfig} placeholder={bin ? "BIN 按原始字节写入，不编辑 ConfigData" : ordinal < 0 && esi ? "请选择 Device" : "选择 XML 后显示配置"}
            rows={[
              { label: "Device", value: esi ? <FormControl fullWidth size="small"><Select value={ordinal} inputProps={{ "aria-label": "烧录 Device" }} disabled={operationInProgress || configSaving || deviceOperationsBlocked} onChange={(event) => void changeDevice(Number(event.target.value))}><MenuItem value={-1} disabled>请选择烧录设备</MenuItem>{esi.devices.map((device, index) => <MenuItem key={index} value={index}>{esiDeviceDisplayName(device)} · {hex(device.product_code, 8)} · Rev {hex(deviceRevision(device), 8)}</MenuItem>)}</Select></FormControl> : <Typography variant="body2" noWrap title={sourcePath}>{bin ? bin.path.split(/[\\/]/).at(-1) : "未选择文件"}</Typography> },
              { label: "Vendor ID", value: currentDevice && esi ? hex(esi.vendor_id, 8) : "—" },
              { label: "Product Code", value: currentDevice ? hex(currentDevice.product_code, 8) : "—" },
              { label: "Revision", value: currentDevice ? hex(deviceRevision(currentDevice), 8) : "—" },
              { label: "目标镜像长度", value: flashTarget ? `${flashTarget.size} B` : generationError ? "生成失败" : esi && ordinal >= 0 ? "生成中…" : "—" },
            ]} />
        </Box>

        {bin && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>BIN 从地址 0 按原始字节写入，不修改 ConfigData、CRC、身份或 SII 类别。</Typography>}
        {generationError && <Alert severity="error" sx={{ mt: 1 }}>{generationError}</Alert>}
      </Box>

    {/* Reading actions precede the Hex panel; short workspaces scroll instead of clipping rows. */}
    <Box className="eeprom-action-bar">
      <Stack direction="row" alignItems="center" gap={1}>
        <FormControl size="small" sx={{ width: 156, flexShrink: 0 }}><InputLabel>读取范围</InputLabel><Select label="读取范围" inputProps={{ "aria-label": "读取范围" }} MenuProps={{ slotProps: { paper: { sx: { "& .MuiMenuItem-root": { minHeight: 30, fontSize: 12 } } } } }} value={effectiveRange} disabled={!slave || operationInProgress || deviceOperationsBlocked} onChange={(event) => setReadRange(event.target.value as "device" | "target" | "custom")}><MenuItem value="device">设备声明容量</MenuItem><MenuItem value="target">目标镜像长度</MenuItem><MenuItem value="custom">自定义长度</MenuItem></Select></FormControl>
        {effectiveRange === "custom" ? <TextField label="字节数（偶数）" size="small" sx={{ width: 158, flexShrink: 0 }} value={readLength} disabled={!slave || operationInProgress || deviceOperationsBlocked} error={invalidReadLength} onChange={(event) => setReadLength(event.target.value)} inputProps={{ inputMode: "numeric" }} /> : <Typography variant="body2" className="mono" sx={{ minWidth: 78 }}>{capacity == null ? "长度未知" : `${capacity} B`}</Typography>}
        <Tooltip title={readBlocker}><span><Button variant="outlined" size="small" disableRipple={false} disabled={readDisabled} onClick={() => void readFull()}>读取</Button></span></Tooltip>
        <Tooltip title={readBlocker || "按所选范围重新读取并导出"}><span><Button variant="outlined" size="small" disableRipple={false} startIcon={<SaveAltRounded />} disabled={readDisabled} onClick={() => void exportBin()}>导出 BIN</Button></span></Tooltip>
        <Box sx={{ flex: 1 }} />
        <Stack component="label" direction="row" alignItems="center" sx={{ flexShrink: 0 }}><Switch size="small" checked={autoResetEsc} disabled={operationInProgress || deviceOperationsBlocked} onChange={(event) => onAutoResetChange(event.target.checked)} inputProps={{ "aria-label": "写入后复位 ESC" }} /><Typography variant="body2">写入后复位 ESC</Typography></Stack>
        <Tooltip title={blockers.join("；")}><span><Button size="small" variant="contained" disableRipple={false} disabled={!canFlash} startIcon={<MemoryRounded />} onClick={() => void flash()}>烧录 EEPROM</Button></span></Tooltip>
      </Stack>
      {activeProgress && <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 1 }}><Typography variant="caption" sx={{ minWidth: 120 }}>{progress.stage}</Typography><LinearProgress variant="determinate" value={progress.percent} sx={{ flex: 1, height: 5, borderRadius: 4 }} /><Typography variant="caption" className="mono">{progress.percent}%</Typography><Typography variant="caption" color="text.secondary" noWrap title={progress.detail} sx={{ maxWidth: "45%" }}>{progress.detail}</Typography>{progress.cancellable !== false && <Button size="small" onClick={() => void run(() => bridgeRequest("cancel"))}>取消</Button>}</Stack>}
      {!operationInProgress && backupPath && <Button size="small" sx={{ mt: 0.75 }} title={backupPath} onClick={() => void run(() => revealPath(backupPath))}>打开导出位置</Button>}
      {!operationInProgress && operationResult && <Alert severity={operationResult.severity} sx={{ mt: 1, py: 0 }} action={<Button size="small" color="inherit" onClick={() => setDetailsOpen(true)}>详情</Button>}>{operationResult.title}{operationResult.error ? `：${operationResult.error}` : ""}</Alert>}
    </Box>
    <EepromDataView read={readResult} targetId={flashTarget?.target_id} fullRead={fullSiiRead} />
      </Box>
    </>}
    <Dialog open={detailsOpen} onClose={() => setDetailsOpen(false)} maxWidth="md" fullWidth>
      <DialogTitle>EEPROM 操作详情</DialogTitle>
      <DialogContent dividers><Stack spacing={2}>
        {flashTarget && <Box><Typography fontWeight={700}>待写入目标 · {flashTarget.size} B</Typography><Typography variant="caption" color="text.secondary">SHA-256</Typography><Typography className="mono" variant="body2" sx={{ overflowWrap: "anywhere" }}>{flashTarget.sha256}</Typography></Box>}
        {readResult && <Box><Typography fontWeight={700}>最近读取 · {readResult.size} B</Typography><Typography variant="body2">{new Date(readResult.read_at).toLocaleString()}</Typography><Typography variant="caption" color="text.secondary">SHA-256</Typography><Typography className="mono" variant="body2" sx={{ overflowWrap: "anywhere" }}>{readResult.sha256}</Typography>{readResult.sii_error && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{readResult.sii_error}</Typography>}</Box>}
        {readResult?.comparison && <Box><Typography fontWeight={700}>读取时的目标对比</Typography><Typography variant="body2">差异 {readResult.comparison.differing_bytes} 字节 · 首个差异地址 {readResult.comparison.first_difference == null ? "无" : hex(readResult.comparison.first_difference, 5)}</Typography><Typography variant="caption" color="text.secondary">当时的目标 SHA-256</Typography><Typography variant="body2" className="mono" sx={{ overflowWrap: "anywhere" }}>{readResult.comparison.target_sha256}</Typography></Box>}
        {backupPath && <Box><Typography fontWeight={700}>BIN 导出位置</Typography><Typography className="mono" variant="body2" sx={{ overflowWrap: "anywhere" }}>{backupPath}</Typography></Box>}
        {operationResult && <Alert severity={operationResult.severity}>{operationResult.title}{operationResult.error ? `：${operationResult.error}` : ""}</Alert>}
        {operationResult?.payload && <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5 }}>{[
          ["写入 Word", operationResult.payload.result.words_written], ["完整回读", `${operationResult.payload.result.bytes_read_back} B`],
          ["差异字节", operationResult.payload.result.comparison.differing_bytes], ["首个差异字节地址", operationResult.payload.result.comparison.first_difference == null ? "无" : hex(operationResult.payload.result.comparison.first_difference, 5)],
          ["目标 SHA-256", operationResult.payload.result.comparison.target_sha256], ["回读 SHA-256", operationResult.payload.result.comparison.readback_sha256],
          ["SII 结构（辅助信息）", operationResult.payload.result.sii_valid ? "可解析" : "未解析"], ["XML 语义（辅助信息）", operationResult.payload.result.semantic_valid == null ? "不适用" : operationResult.payload.result.semantic_valid ? "可解析" : "与 XML 描述不同"],
          ["RES 序列", operationResult.payload.result.reset_sequence == null ? "未执行" : operationResult.payload.result.reset_sequence.every(Boolean) ? "三帧成功" : "未完成"],
          ["重新发现", operationResult.payload.result.rediscovered == null ? "未执行" : operationResult.payload.result.rediscovered ? "成功" : "失败"],
          ["重新加载复核", operationResult.payload.result.reload_verified == null ? "未执行" : operationResult.payload.result.reload_verified ? "成功" : "失败"],
        ].map(([label, value]) => <Box key={String(label)} minWidth={0}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography variant="body2" className={String(label).includes("SHA") ? "mono" : ""} sx={{ overflowWrap: "anywhere" }}>{String(value)}</Typography></Box>)}</Box>}
      </Stack></DialogContent>
      <DialogActions><Button onClick={() => setDetailsOpen(false)}>关闭</Button></DialogActions>
    </Dialog>
  </Box>;
});
