import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, Checkbox,
  CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControl, FormControlLabel, IconButton, InputLabel, Menu, MenuItem, Select, Stack,
  Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs,
  TextField, Tooltip, Typography,
} from "@mui/material";
import { createTheme, ThemeProvider, useTheme } from "@mui/material/styles";
import {
  CheckRounded, CloseRounded, ContentCopyRounded, ExpandMoreRounded, MoreHorizRounded,
  PlaylistAddRounded, RefreshRounded, SearchRounded, StarBorderRounded, StarRounded,
} from "@mui/icons-material";
import { BridgeRequestError, bridgeRequest } from "./api";
import { operationStore } from "./operationStore";
import { hex, type RegisterDefinition, type SlaveInfo } from "./types";
import {
  decodeRegisterFields, definitionKey, encodeRegisterInput, formatRegisterBinary, formatRegisterValue,
  hasReadSideEffects, isCommonRegister, matchesRegisterSearch, parseRegisterAddress, registerDisplayName, registerMeaning,
  registerNumber, registerWidth, type RegisterValue, type ValueFormat,
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
  catalog?: RegisterDefinition[]; error?: string;
}
interface CachedRegisters { catalog: RegisterDefinition[]; values: Record<string, RegisterValue>; errors: Record<string, string>; snapshot?: RegisterSnapshot }
const snapshots = new Map<string, CachedRegisters>();
let cachedSession = "";

/** Restore user choices without storing live values across connection sessions. */
function registerPreferences(profile: string): { favorites: string[]; pinned: string[]; intervalMs: number; format: ValueFormat } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`benchcat-registers:${profile}`) ?? "{}");
    return { favorites: Array.isArray(saved.favorites) ? saved.favorites : [], pinned: Array.isArray(saved.pinned) ? saved.pinned : [],
      intervalMs: [500, 1000, 2000, 5000].includes(saved.intervalMs) ? saved.intervalMs : 1000,
      format: ["hex", "decimal", "bytes"].includes(saved.format) ? saved.format : "hex" };
  } catch { return { favorites: [], pinned: [], intervalMs: 1000, format: "hex" }; }
}
interface WriteResult { readback: string | null; fpwr_wkc: number }

const groupLabels: Record<string, string> = {
  "AL State Machine": "AL 状态机", "Data Link Layer / Port Status": "链路与端口",
  "Error Counters / Diagnostics": "错误计数与诊断", "ESC Identification / Capability": "ESC 信息",
  "Station Address": "站地址", "Watchdog": "看门狗", "Event / Interrupt": "事件与中断",
  "PDI / ESC Configuration": "PDI 配置", "SII EEPROM Interface": "EEPROM 接口",
  "PHY Management / Port Status": "PHY 管理", "Distributed Clocks": "分布式时钟",
  "Write Protection / Reset": "写保护与复位", "Digital I/O / General Purpose I/O": "数字 I/O",
  "FMMU": "FMMU 映射", "SyncManager": "SyncManager 通道",
};
const disclosureSx = {
  borderTop: 1, borderColor: "divider", "&:before": { display: "none" },
  "& .MuiAccordionSummary-root": { px: 0, minHeight: 40 },
  "& .MuiAccordionDetails-root": { px: 0, pt: 0, pb: 1.5 },
};

/** Shorten display labels without changing catalog names or register identities. */
function registerLabel(name = ""): string {
  return name.replace(/\s+Register\s*$/i, "");
}

/** Translate undocumented metadata without changing the reference definitions. */
function documentationText(text?: string): string {
  return text?.replace(/not documented/gi, "文档未注明") ?? "未记录";
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
function Disclosure({ title, children, defaultExpanded = false }: { title: string; children: ReactNode; defaultExpanded?: boolean }) {
  return <Accordion defaultExpanded={defaultExpanded} disableGutters elevation={0} sx={disclosureSx}>
    <AccordionSummary expandIcon={<ExpandMoreRounded sx={{ fontSize: 17 }} />}><Typography fontSize={12}>{title}</Typography></AccordionSummary>
    <AccordionDetails>{children}</AccordionDetails>
  </Accordion>;
}

/** A session snapshot serves all list views; only explicit monitoring repeats reads. */
export function RegistersPage({ slave, run, registerProfile, deviceOperationsBlocked, sessionContext }: Props) {
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
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [view, setView] = useState<CatalogView>("common");
  const [group, setGroup] = useState("");
  const [query, setQuery] = useState("");
  const [monitor, setMonitor] = useState(false);
  const [selected, setSelected] = useState<RegisterDefinition>();
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
  const [showReserved, setShowReserved] = useState(false);
  const [watchConfirm, setWatchConfirm] = useState<RegisterDefinition>();
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawAddress, setRawAddress] = useState("0x0000");
  const [rawSize, setRawSize] = useState(1);
  const [rawAccess, setRawAccess] = useState("RW");
  const [rawResult, setRawResult] = useState<RegisterValue>();
  const [rawError, setRawError] = useState("");
  const [writeContext, setWriteContext] = useState<WriteContext>();
  const [writeDialog, setWriteDialog] = useState(false);
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
    cache.current = new Map(); queue.current = []; queued.current.clear(); attempted.current.clear();
    automaticPaused.current = false; fullReadQueued.current = false; initialReadDone.current = Boolean(saved?.snapshot);
    dirtyRef.current = false; requestSequence.current += 1;
    setCatalog(saved?.catalog ?? []); setSelected(undefined); setPinned([]);
    setValues(saved?.values ?? {}); valuesRef.current = saved?.values ?? {}; setErrors(saved?.errors ?? {});
    setChanges({}); setSnapshotInfo(saved?.snapshot); setReadbackKeys(new Set());
    setWatching(false); setReading(false); setDetailLoading(false);
    setPageError(""); setDetailError(""); setWriteContext(undefined); setWriteDialog(false); setWatchConfirm(undefined);
    setRawOpen(false); setRawResult(undefined); setRawError(""); setResetConfirm(false); setMonitor(false);
    if (!slave) return;
    setCatalogLoading(true);
    bridgeRequest<RegisterDefinition[]>("register_catalog", { position: slave.position, profile: registerProfile })
      .then((data) => { if (active) setCatalog(data.filter((item) => item.address_space === "esc_core" && item.master_access_allowed !== false)); })
      .catch((error) => { if (active) setPageError(failureText(error)); })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [context]);

  // Persist UI choices; runtime snapshots are scoped to the current connection.
  useEffect(() => {
    if (!catalog.length) return;
    setPinned((current) => {
      const ids = new Set([...persistedPinned.current, ...current.map(definitionKey)]);
      return catalog.filter((item) => ids.has(definitionKey(item)));
    });
  }, [catalog]);
  useEffect(() => {
    if (!catalog.length) return;
    const available = new Set(catalog.map(definitionKey));
    persistedPinned.current = [...persistedPinned.current.filter((id) => !available.has(id)), ...pinned.map(definitionKey)];
    window.localStorage.setItem(`benchcat-registers:${registerProfile}`, JSON.stringify({ favorites: [...favorites], pinned: persistedPinned.current, intervalMs, format }));
  }, [favorites, pinned, intervalMs, format, registerProfile]);
  useEffect(() => {
    if (catalog.length) snapshots.set(context, { catalog, values, errors, snapshot: snapshotInfo });
  }, [catalog, values, errors, snapshotInfo, context]);

  const groups = useMemo(() => [...new Set(catalog.map((item) => item.group))], [catalog]);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return catalog.filter((item) => {
      if (!showReservedAddresses && item.is_reserved) return false;
      if (view === "favorites" && !favorites.has(definitionKey(item))) return false;
      if (!text && view === "common" && !isCommonRegister(item)) return false;
      if (group && item.group !== group) return false;
      return matchesRegisterSearch(item, text) || Boolean(text && (groupLabels[item.group] ?? "").includes(text));
    }).sort((left, right) => left.address - right.address);
  }, [catalog, view, group, query, favorites, showReservedAddresses]);
  const displayed = monitor ? pinned : filtered;
  const selectedKey = selected ? definitionKey(selected) : "";
  const selectedValue = values[selectedKey];
  const selectedFields = selected && selectedValue ? decodeRegisterFields(selected, selectedValue.data) : [];
  const rawNumericAddress = parseRegisterAddress(rawAddress);
  const rawDefinition = catalog.find((item) => item.address === rawNumericAddress);
  const rawWidth = rawDefinition ? registerWidth(rawDefinition) : rawSize;
  const rawValid = rawNumericAddress !== undefined && Number.isInteger(rawWidth) && rawWidth >= 1 && rawWidth <= 256 && rawNumericAddress + rawWidth <= 0x10000;
  const writeBytes = writeContext ? encodeRegisterInput(writeInput, writeContext.width, writeFormat) : undefined;
  const writeFields = writeContext?.definition ? decodeRegisterFields(writeContext.definition, writeContext.current ?? Array(writeContext.width).fill("00").join(" ")) : [];
  const controlsBlocked = deviceOperationsBlocked || reading || writing;
  const writable = Boolean(selected?.direct_write_allowed && selected.access !== "RO" && !selected.dangerous);

  /** Detailed permissions and read side effects are resolved before automatic reads. */
  const loadDefinition = (definition: RegisterDefinition): Promise<RegisterDefinition> => {
    const key = definitionKey(definition);
    let pending = cache.current.get(key);
    if (!pending) {
      pending = bridgeRequest<RegisterDefinition>("register_definition", { position: slave?.position, profile: registerProfile, definition_id: definition.definition_id });
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
    for (const definition of definitions) {
      const value = results.find((item) => item.address === definition.address && item.data.trim().split(/\s+/).length === registerWidth(definition));
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
            request_id: requestId, position: slave.position, profile: registerProfile, all: readAll,
            automatic: jobs.every((job) => job.automatic),
            requests: jobs.map((job) => ({ address: job.definition.address, size: registerWidth(job.definition), definition_id: job.definition.definition_id })),
          });
          if (!mounted.current || contextRef.current !== requestedContext) break;
          if (result.catalog) setCatalog(result.catalog);
          acceptValues(result.catalog ?? jobs.map((job) => job.definition), result.values, requestedContext);
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
    const sequence = ++requestSequence.current, requestedContext = context;
    dirtyRef.current = false; setSelected(definition); setWriteContext(undefined); setWriteInput("");
    setWriteError(""); setWriteMessage(""); setDetailLoading(true); setDetailError("");
    try {
      const detail = await loadDefinition(definition);
      if (!mounted.current || contextRef.current !== requestedContext || sequence !== requestSequence.current) return;
      setSelected(detail);
      if (!valuesRef.current[definitionKey(detail)] && detail.automatic_read_allowed !== false && !hasReadSideEffects(detail)) enqueueReads([detail], true);
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
    if (!selected || !writable || detailLoading || rawOpen || writeDialog || dirtyRef.current) return;
    initializeEditor({ definition: selected, address: selected.address, width: registerWidth(selected), access: selected.access, name: selected.name, current: selectedValue?.data });
  }, [selected, selectedValue?.data, writable, detailLoading, rawOpen, writeDialog]);

  /** Refresh all always targets the full safe catalog, regardless of list filters. */
  const refresh = () => {
    automaticPaused.current = false; setPageError(""); setWriteError(""); setWriteMessage(""); dirtyRef.current = false;
    enqueueReads(catalog, true, true);
  };

  /** Read side effects require opt-in before a register enters a repeated watch. */
  const addWatch = (definition: RegisterDefinition) => {
    if (hasReadSideEffects(definition)) { setWatchConfirm(definition); return; }
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

  /** Ordinary edits stay in the inspector; raw access uses the same editor in its dialog. */
  const openRawWrite = async () => {
    if (!slave || !rawValid || controlsBlocked || busyRef.current || operationStore.activeHardware()) return;
    const requestedContext = context;
    busyRef.current = true; setReading(true); setWatching(false); setRawError(""); setWriteMessage("");
    try {
      const definition = rawDefinition ? await loadDefinition(rawDefinition) : undefined;
      if (!mounted.current || contextRef.current !== requestedContext) return;
      const target: WriteContext = { definition, address: rawNumericAddress!, width: rawWidth, access: definition?.access ?? rawAccess, name: definition?.name ?? `原始地址 ${hex(rawNumericAddress!)}`, current: rawResult?.data };
      if (target.access === "RW" && !target.current) {
        const value = await bridgeRequest<RegisterValue>("register_read", { position: slave.position, address: target.address, size: target.width, definition_id: definition?.definition_id, profile: registerProfile });
        if (!mounted.current || contextRef.current !== requestedContext) return;
        target.current = value.data; setRawResult(value);
      }
      initializeEditor(target); setWriteDialog(true);
    } catch (error) { if (contextRef.current === requestedContext) setRawError(failureText(error)); }
    finally {
      busyRef.current = false;
      if (mounted.current && contextRef.current === requestedContext) setReading(false);
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
            if (writeDialog) setRawResult(value);
            setWriteContext({ ...target, current: value.data });
            setWriteInput(["WAC", "W1C", "W1S"].includes(target.access) ? writeFormat === "bytes" ? "00".repeat(target.width) : "0" : formatRegisterValue(value.data, writeFormat));
          } else if (target.definition && canRead(target.definition)) {
            enqueueReads([target.definition]);
          } else if (writeDialog) {
            setRawResult(undefined);
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

  /** Known raw addresses reuse catalog width and access permissions. */
  const readRaw = async () => {
    if (!slave || !rawValid || controlsBlocked || busyRef.current || operationStore.activeHardware() || (rawDefinition && !canRead(rawDefinition))) return;
    const requestedContext = context;
    busyRef.current = true; setReading(true); setRawError("");
    try {
      const result = await bridgeRequest<RegisterValue>("register_read", { position: slave.position, address: rawNumericAddress, size: rawWidth, definition_id: rawDefinition?.definition_id, profile: registerProfile });
      if (mounted.current && contextRef.current === requestedContext) {
        setRawResult(result);
        if (rawDefinition) acceptValues([rawDefinition], [result], requestedContext);
      }
    } catch (error) { if (contextRef.current === requestedContext) setRawError(failureText(error)); }
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

  if (!slave) return <Box sx={{ py: 8, textAlign: "center", color: "text.secondary" }}>请先选择从站</Box>;

  /** Reuse one inline editor for ordinary and raw register writes. */
  const renderEditor = () => <Stack spacing={1.25}>
    {writeContext?.access === "WAC" ? <Typography fontSize={12} color="text.secondary">写入后清零此计数器</Typography> : <Stack direction="row" spacing={0.75}>
      <TextField fullWidth size="small" label={writeContext?.access === "W1C" ? "清除位掩码" : writeContext?.access === "W1S" ? "置位掩码" : "写入值"} value={writeInput}
        onChange={(event) => { dirtyRef.current = true; setWatching(false); setWriteInput(event.target.value); setWriteMessage(""); }}
        disabled={controlsBlocked} error={Boolean(writeInput && !writeBytes)} inputProps={{ className: "mono", style: { fontSize: 13 } }} />
      <FormControl size="small" sx={{ width: 87, flexShrink: 0 }}><Select value={writeFormat} inputProps={{ "aria-label": "写入值格式" }} disabled={controlsBlocked} onChange={(event) => changeWriteFormat(event.target.value as ValueFormat)} sx={{ fontSize: 12 }}>
        {writeContext && writeContext.width <= 8 && [<MenuItem key="hex" value="hex">HEX</MenuItem>, <MenuItem key="decimal" value="decimal">DEC</MenuItem>]}<MenuItem value="bytes">字节</MenuItem>
      </Select></FormControl>
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
  const renderTable = () => <TableContainer sx={{ flex: 1, minHeight: 0 }}>
    <Table stickyHeader size="small" sx={{ tableLayout: "fixed", "& td, & th": { fontSize: 12, py: 0.5, borderColor: "#EEF1F6" }, "& th": { height: 34 } }}>
      <TableHead><TableRow>
        <TableCell sx={{ width: 90 }}>地址</TableCell><TableCell>寄存器</TableCell><TableCell sx={{ width: 200 }}>当前值</TableCell>
        <TableCell sx={{ width: 58 }}>权限</TableCell><TableCell sx={{ width: 58 }}>宽度</TableCell><TableCell sx={{ width: 32 }} />
      </TableRow></TableHead>
      <TableBody>{displayed.map((definition) => {
        const key = definitionKey(definition), value = values[key], change = changes[key], error = errors[key], meaning = registerMeaning(definition, value?.data);
        return <TableRow key={key} data-register-key={key} hover selected={key === selectedKey} tabIndex={writing ? -1 : 0}
          onClick={() => void selectDefinition(definition)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") void selectDefinition(definition); }}
          sx={{ cursor: "pointer", height: 36, "&:hover .register-favorite, &:focus-within .register-favorite": { visibility: "visible" }, "&.Mui-selected": { bgcolor: "#EDF2FF" } }}>
          <TableCell className="mono" sx={{ color: "text.primary", fontWeight: 650 }}>{hex(definition.address)}</TableCell>
          <TableCell sx={{ overflow: "hidden" }}><Tooltip title={<Stack spacing={0.25}><span>{registerDisplayName(definition)}</span>{registerDisplayName(definition) !== (definition.official_name ?? definition.name) && <span>{definition.official_name ?? definition.name}</span>}</Stack>}><Typography fontSize={12} fontWeight={400} noWrap>{registerDisplayName(definition)}</Typography></Tooltip></TableCell>
          <TableCell><Tooltip title={error || (hasReadSideEffects(definition) ? "读取可能确认事件。请使用右侧的刷新图标手动读取。" : monitor && change && value ? `${formatRegisterValue(change.previous, format)} → ${formatRegisterValue(value.data, format)}` : value?.data ?? "")}>
            <Typography className="mono" fontSize={12} color={error ? "error.main" : "text.primary"} noWrap>
              {value ? formatRegisterValue(value.data, format) : error ? "读取失败" : definition.is_reserved ? "保留地址" : definition.access === "WO" ? "只写" : hasReadSideEffects(definition) ? "需手动读取" : definition.automatic_read_allowed === false ? "不适用" : reading ? "读取中…" : "未读取"}
              {value && meaning && <Box component="span" sx={{ color: "text.secondary", ml: 0.75, fontFamily: "inherit", fontSize: 11 }}>{meaning}</Box>}
              {value && error && <Box component="span" sx={{ color: "error.main", ml: 0.75, fontSize: 11 }}>旧值 · 读取失败</Box>}
              {monitor && change && <Box component="span" sx={{ color: "warning.main", ml: 0.75, fontSize: 11 }}>变化</Box>}
            </Typography>
          </Tooltip></TableCell>
          <TableCell><Tooltip title={definition.master_access ?? definition.access}><Typography fontSize={11} color="text.secondary">{({ RO: "只读", RW: "读写", WO: "只写", WAC: "清零", W1C: "W1C", W1S: "W1S", MIXED: "混合" } as Record<string, string>)[definition.access] ?? definition.access}</Typography></Tooltip></TableCell>
          <TableCell><Typography fontSize={11} color="text.secondary">{registerWidth(definition)} B</Typography></TableCell>
          <TableCell sx={{ px: 0.25 }}><IconButton size="small" className="register-favorite" aria-label={monitor ? `移除监视 ${registerLabel(definition.name)}` : `收藏 ${registerLabel(definition.name)}`}
            sx={{ p: 0.5, visibility: monitor || favorites.has(key) ? "visible" : "hidden" }} onClick={(event) => {
              event.stopPropagation();
              if (monitor) { setPinned((current) => current.filter((item) => definitionKey(item) !== key)); setWatching(false); }
              else {
                setFavoriteFeedback(favorites.has(key) ? undefined : key);
                setFavorites((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
              }
            }}>{monitor ? <CloseRounded sx={{ fontSize: 16 }} /> : favorites.has(key) ? <StarRounded className={favoriteFeedback === key ? "register-star-selected" : undefined} sx={{ fontSize: 16 }} color="warning" /> : <StarBorderRounded sx={{ fontSize: 16 }} />}</IconButton></TableCell>
        </TableRow>;
      })}
        {!displayed.length && <TableRow><TableCell colSpan={6} sx={{ py: "70px !important", textAlign: "center", color: "text.secondary" }}>
          {catalogLoading ? <CircularProgress size={22} /> : monitor ? "从寄存器详情中加入需要监视的项目" : view === "favorites" ? "将鼠标移到寄存器行，点击星标收藏" : "没有匹配的寄存器"}
        </TableCell></TableRow>}
      </TableBody>
    </Table>
  </TableContainer>;

  return <ThemeProvider theme={registerTheme}><Stack className="register-workspace" spacing={1.25} sx={{ "& .MuiButton-root": { fontSize: 12 } }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minHeight: 28 }}>
      <Typography fontSize={19} fontWeight={700}>寄存器</Typography>
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
        <Tabs className="register-view-tabs" value={view} onChange={(_, value: CatalogView) => { setView(value); setGroup(""); }} aria-label="寄存器列表范围">
          <Tab value="common" label="常用" disabled={writing} /><Tab value="all" label="全部" disabled={writing} /><Tab value="favorites" label="收藏" disabled={writing} />
        </Tabs>
        <TextField size="small" placeholder="搜索名称、地址或地址范围" inputProps={{ "aria-label": "搜索寄存器" }} value={query} disabled={writing}
          onChange={(event) => { setQuery(event.target.value); requestSequence.current += 1; setSelected(undefined); setWriteContext(undefined); }}
          InputProps={{ startAdornment: <SearchRounded sx={{ fontSize: 18, color: "text.secondary", mr: 0.75 }} /> }} sx={{ flex: 1, minWidth: 190, "& input": { fontSize: 12, py: 1 } }} />
        {view === "all" && <FormControl size="small" sx={{ width: 156, flexShrink: 0 }}><Select value={group} displayEmpty disabled={writing} inputProps={{ "aria-label": "功能分组" }} onChange={(event) => setGroup(event.target.value)} sx={{ fontSize: 12 }}><MenuItem value="">全部功能</MenuItem>{groups.map((item) => <MenuItem key={item} value={item}>{groupLabels[item] ?? item}</MenuItem>)}</Select></FormControl>}
      </>}
      <FormControl size="small" sx={{ width: 84, flexShrink: 0 }}><Select value={format} inputProps={{ "aria-label": "值显示格式" }} onChange={(event) => setFormat(event.target.value as ValueFormat)} sx={{ fontSize: 12 }}><MenuItem value="hex">HEX</MenuItem><MenuItem value="decimal">DEC</MenuItem><MenuItem value="bytes">字节</MenuItem></Select></FormControl>
      <Tooltip title="刷新整个目录中可自动读取的寄存器"><span><Button size="small" variant="text" color="inherit" sx={{ flexShrink: 0, minWidth: 0, px: 1, color: "text.secondary", "&:hover, &:active:not(.Mui-disabled)": { bgcolor: "#EEF1F6" }, "& .MuiButton-startIcon": { width: 17, height: 17, alignItems: "center", justifyContent: "center" } }} startIcon={reading ? <CircularProgress size={14} color="inherit" /> : <RefreshRounded sx={{ fontSize: 17 }} />} disabled={controlsBlocked || !catalog.length} onClick={refresh}>刷新全部</Button></span></Tooltip>
      {!monitor && <Button size="small" color="inherit" disabled={writing} onClick={() => { setMonitor(true); setWatching(false); }}>监视{pinned.length ? ` (${pinned.length})` : ""}</Button>}
      <IconButton size="small" aria-label="更多操作" disabled={writing} onClick={(event) => setMoreAnchor(event.currentTarget)}><MoreHorizRounded sx={{ fontSize: 21 }} /></IconButton>
    </Stack>
    {pageError && <Alert severity="error" onClose={() => setPageError("")}>{pageError}</Alert>}
    <Box sx={{ display: "grid", gridTemplateColumns: selected ? "minmax(0, 1fr) 360px" : "minmax(0, 1fr)", gap: 1.5, height: "calc(100vh - 235px)", minHeight: 380 }}>
      <Card variant="outlined" sx={{ minWidth: 0, overflow: "hidden", borderRadius: 1.5, display: "flex", flexDirection: "column", boxShadow: "none" }}>
        {renderTable()}
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 1.25, height: 30, flexShrink: 0, borderTop: 1, borderColor: "divider", color: "text.secondary" }}>
          <Typography fontSize={11}>{displayed.length} 项 · {displayed.filter((item) => values[definitionKey(item)]).length} 项已有值{displayed.some((item) => errors[definitionKey(item)]) ? ` · ${displayed.filter((item) => errors[definitionKey(item)]).length} 项失败` : ""}{displayed.some(hasReadSideEffects) ? ` · ${displayed.filter(hasReadSideEffects).length} 项需手动读取` : ""}</Typography>
          <Typography fontSize={11} color={pageError ? "error.main" : "text.secondary"}>{reading ? "正在读取…" : snapshotInfo ? `${snapshotInfo.cancelled ? "读取已取消 · " : ""}${new Date(snapshotInfo.timestamp * 1000).toLocaleTimeString("zh-CN", { hour12: false })} · ${snapshotInfo.duration_ms.toFixed(1)} ms · ${snapshotInfo.frame_count} 帧` : "尚未读取"}</Typography>
        </Stack>
      </Card>
      {selected && <Card variant="outlined" sx={{ minWidth: 0, overflow: "auto", borderRadius: 1.5, boxShadow: "none" }}><Stack spacing={1.75} sx={{ p: 2 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={0.5}><Box minWidth={0}>
          <Typography fontSize={14} fontWeight={500} sx={{ overflowWrap: "anywhere" }}>{registerDisplayName(selected)}</Typography>
          {registerDisplayName(selected) !== registerLabel(selected.name) && <Typography fontSize={11} color="text.secondary" sx={{ mt: 0.25 }}>{registerLabel(selected.name)}</Typography>}
          <Typography fontSize={12} color="text.secondary" sx={{ mt: 0.5 }}><Box component="span" className="mono" sx={{ fontWeight: 650, color: "text.primary" }}>{hex(selected.address)}</Box> · {registerWidth(selected) * 8} bit · {selected.access === "RO" ? "只读" : selected.access === "RW" ? "读写" : selected.access}</Typography>
        </Box><IconButton size="small" aria-label="关闭寄存器详情" disabled={writing} onClick={() => { requestSequence.current += 1; setSelected(undefined); setWriteContext(undefined); }}><CloseRounded sx={{ fontSize: 17 }} /></IconButton></Stack>
        {detailError && <Alert severity="error">{detailError}</Alert>}
        <Box sx={{ bgcolor: "#F6F8FC", borderRadius: 1, p: 1.5 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between"><Typography fontSize={11} color="text.secondary">{errors[selectedKey] ? "上次读取值" : "当前值"}</Typography><Stack direction="row" spacing={0.25}>
            <Tooltip title={hasReadSideEffects(selected) ? "刷新此寄存器；读取可能确认事件" : "刷新此寄存器"}><span><IconButton size="small" aria-label="刷新此寄存器" disabled={controlsBlocked || !canRead(selected) || detailLoading || Boolean(detailError) || selected.is_reserved} onClick={() => { setWatching(false); setWriteError(""); setWriteMessage(""); enqueueReads([selected]); }}><RefreshRounded sx={{ fontSize: 17 }} /></IconButton></span></Tooltip>
            <Tooltip title={copied ? "已复制" : "复制值"}><span><IconButton size="small" aria-label="复制寄存器值" disabled={!selectedValue} onClick={() => void copyValue()}>{copied ? <CheckRounded className="register-copy-confirmed" sx={{ fontSize: 15 }} color="success" /> : <ContentCopyRounded sx={{ fontSize: 15 }} />}</IconButton></span></Tooltip>
            <Tooltip title="加入监视"><span><IconButton size="small" aria-label="加入监视" disabled={!canRead(selected) || detailLoading || Boolean(detailError)} onClick={() => pinned.some((item) => definitionKey(item) === selectedKey) ? setMonitor(true) : addWatch(selected)}><PlaylistAddRounded sx={{ fontSize: 18 }} /></IconButton></span></Tooltip>
          </Stack></Stack>
          <Typography className="mono" fontSize={21} sx={{ overflowWrap: "anywhere", mt: 0.25 }}>{selectedValue ? formatRegisterValue(selectedValue.data, format) : detailLoading || reading ? "…" : "—"}</Typography>
          <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 0.75 }}>
            <Typography fontSize={11} color="text.secondary" sx={{ lineHeight: 1.7, flexShrink: 0 }}>BIN</Typography>
            <Typography className="mono" fontSize={12} sx={{ lineHeight: 1.6, overflowWrap: "anywhere", minWidth: 0 }}>{selectedValue ? formatRegisterBinary(selectedValue.data, registerWidth(selected)) : "—"}</Typography>
          </Stack>
          {selectedValue && registerMeaning(selected, selectedValue.data) && <Typography fontSize={12} color="text.secondary" sx={{ mt: 0.5 }}>{registerMeaning(selected, selectedValue.data)}</Typography>}
          {hasReadSideEffects(selected) && <Typography fontSize={11} color="text.secondary" sx={{ mt: 0.5 }}>读取可能确认事件，请点击刷新图标手动读取。</Typography>}
        </Box>
        {errors[selectedKey] && <Alert severity="error" sx={{ fontSize: 12 }}>{errors[selectedKey]}</Alert>}
        {writable && !rawOpen && !writeDialog && renderEditor()}
        {selected.address === 0x0040 && <Button size="small" color="error" variant="outlined" disabled={controlsBlocked} onClick={() => setResetConfirm(true)}>复位 EtherCAT 控制器</Button>}
        <Box>
          <Disclosure key={`${selectedKey}-fields`} title="位字段解析" defaultExpanded={[0x0110, 0x0130, 0x0134, 0x0440].includes(selected.address)}><Stack spacing={1}>
            {selectedFields.length ? <Table size="small" sx={{ "& td": { px: 0.5, py: 0.75, fontSize: 11, verticalAlign: "top", borderColor: "#EEF1F6" } }}><TableBody>{selectedFields.filter((field) => showReserved || !field.reserved).map((field, index) => <TableRow key={`${field.bits}-${index}`}>
              <TableCell sx={{ width: 34 }} className="mono">{field.bits}</TableCell><TableCell><Typography fontSize={11} fontWeight={600}>{field.name}</Typography><Typography fontSize={11} color="text.secondary">{field.meaning}</Typography></TableCell><TableCell align="right" className="mono">{field.value.toString()}</TableCell>
            </TableRow>)}</TableBody></Table> : <Typography fontSize={11} color="text.secondary">{selectedValue ? "此寄存器没有位字段定义" : "获取当前值后显示字段解析"}</Typography>}
            {selectedFields.some((field) => field.reserved) && <FormControlLabel sx={{ m: 0 }} control={<Checkbox size="small" checked={showReserved} onChange={(_, enabled) => setShowReserved(enabled)} />} label={<Typography fontSize={11}>显示保留位</Typography>} />}
            {writable && writeContext?.definition && definitionKey(writeContext.definition) === selectedKey && writeContext.access === "RW" && writeContext.width <= 8 && writeFields.filter((field) => !field.reserved && field.access === "RW").map((field, index) => <TextField key={index} size="small" label={`${field.bits} · ${field.name}（HEX）`} disabled={controlsBlocked || !writeBytes} value={writeBytes ? ((registerNumber(writeBytes.match(/../g)!.join(" ")) >> BigInt(field.shift)) & ((1n << BigInt(field.width)) - 1n)).toString(16).toUpperCase() : ""} onChange={(event) => editField(field.shift, field.width, event.target.value)} />)}
            {writable && writeContext?.definition && definitionKey(writeContext.definition) === selectedKey && ["W1C", "W1S"].includes(writeContext.access) && writeContext.width <= 8 && writeFields.filter((field) => !field.reserved && field.access === writeContext.access).map((field, index) => {
              const mask = ((1n << BigInt(field.width)) - 1n) << BigInt(field.shift), current = writeBytes ? registerNumber(writeBytes.match(/../g)!.join(" ")) : 0n;
              return <FormControlLabel key={index} label={<Typography fontSize={11}>{writeContext.access === "W1C" ? "清除" : "置位"} {field.name}</Typography>} control={<Checkbox size="small" disabled={controlsBlocked || !writeBytes} checked={(current & mask) === mask} indeterminate={(current & mask) !== 0n && (current & mask) !== mask} onChange={(_, enabled) => { dirtyRef.current = true; setWriteFormat("hex"); setWriteInput(`0x${(enabled ? current | mask : current & ~mask).toString(16).toUpperCase()}`); }} />} />;
            })}
          </Stack></Disclosure>
          <Disclosure title="完整说明"><Stack spacing={1}>
            <Typography fontSize={12} color="text.secondary">{documentationText(selected.description)}</Typography>
            <Typography fontSize={11} color="text.secondary">主站权限：{documentationText(selected.master_access ?? selected.access)}<br />默认值：{documentationText(selected.reset_value)}<br />上电值：{documentationText(selected.power_on_default)}<br />状态限制：{documentationText(selected.state_restriction)}<br />保留位：{documentationText(selected.reserved_bits_rule)}</Typography>
            {selected.fields?.map((field, index) => <Typography key={index} fontSize={11}><b>{field.bits} · {field.name}</b> [{documentationText(field.ecat_access ?? "—")}]<br />{documentationText(field.description)}</Typography>)}
            {selected.source?.map((source, index) => <Typography key={index} fontSize={11} color="text.secondary">{source.source_id} · {source.section ?? ""}{source.page ? ` · p.${source.page}` : ""}</Typography>)}
          </Stack></Disclosure>
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
      <MenuItem onClick={() => { setRawOpen(true); setRawResult(rawDefinition ? values[definitionKey(rawDefinition)] : undefined); setRawError(""); setMoreAnchor(null); }}>原始地址访问</MenuItem>
      {monitor && <MenuItem disabled={!pinned.length} onClick={() => { setPinned([]); setWatching(false); setMoreAnchor(null); }}>清空监视列表</MenuItem>}
      {!monitor && <MenuItem onClick={() => { setShowReservedAddresses(!showReservedAddresses); setMoreAnchor(null); }}>{showReservedAddresses ? "隐藏保留地址" : "显示保留地址"}</MenuItem>}
    </Menu>
    <Dialog open={rawOpen} onClose={() => { if (!controlsBlocked) { setRawOpen(false); dirtyRef.current = false; } }} fullWidth maxWidth="sm">
      <DialogTitle>原始地址访问</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
        <Stack direction="row" spacing={1}><TextField label="地址（HEX）" size="small" value={rawAddress} disabled={controlsBlocked} error={rawNumericAddress === undefined} onChange={(event) => { setRawAddress(event.target.value); setRawResult(undefined); setRawError(""); }} onBlur={() => { if (!rawResult) void readRaw(); }} onKeyDown={(event) => { if (event.key === "Enter") void readRaw(); }} sx={{ flex: 1 }} />
          <TextField label="宽度（byte）" size="small" type="number" value={rawWidth} disabled={controlsBlocked || Boolean(rawDefinition)} onChange={(event) => { setRawSize(Number(event.target.value)); setRawResult(undefined); }} onBlur={() => { if (!rawResult) void readRaw(); }} inputProps={{ min: 1, max: 256 }} sx={{ width: 145 }} /></Stack>
        <Typography fontSize={12} color="text.secondary">{rawDefinition ? `${registerLabel(rawDefinition.name)} · 自动使用寄存器宽度和权限` : "未收录地址 · 1–256 byte"}</Typography>
        <Button variant="outlined" disabled={controlsBlocked || !rawValid || Boolean(rawDefinition && !canRead(rawDefinition))} onClick={() => void readRaw()}>刷新</Button>
        {rawError && <Alert severity="error">{rawError}</Alert>}
        {rawResult && <Typography className="mono" sx={{ overflowWrap: "anywhere", p: 1.5, bgcolor: "#F6F8FC", borderRadius: 1 }}>{formatRegisterValue(rawResult.data, format)}</Typography>}
        {!rawDefinition && <FormControl size="small"><InputLabel>操作类型</InputLabel><Select label="操作类型" value={rawAccess} disabled={controlsBlocked} onChange={(event) => setRawAccess(event.target.value)}>{Object.entries({ RW: "普通读写", WO: "只写", W1C: "写 1 清除", W1S: "写 1 置位", WAC: "写入清零", SELF_CLEARING: "命令自动清除", VOLATILE: "易变值" }).map(([value, label]) => <MenuItem key={value} value={value}>{label}（{value}）</MenuItem>)}</Select></FormControl>}
        <Button variant="contained" disabled={controlsBlocked || !rawValid || Boolean(rawDefinition && (!rawDefinition.direct_write_allowed || rawDefinition.access === "RO"))} onClick={() => void openRawWrite()}>编辑写入值</Button>
      </Stack></DialogContent><DialogActions><Button disabled={controlsBlocked} onClick={() => { setRawOpen(false); dirtyRef.current = false; }}>关闭</Button></DialogActions>
    </Dialog>
    <Dialog open={writeDialog} onClose={() => { if (!writing) { setWriteDialog(false); dirtyRef.current = false; } }} fullWidth maxWidth="sm">
      <DialogTitle>写入寄存器</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}><Typography fontSize={13}>{registerLabel(writeContext?.name)} · {hex(writeContext?.address ?? 0)} · {writeContext?.width} byte</Typography>{renderEditor()}</Stack></DialogContent><DialogActions><Button disabled={writing} onClick={() => { setWriteDialog(false); dirtyRef.current = false; }}>关闭</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(watchConfirm)} onClose={() => setWatchConfirm(undefined)} fullWidth maxWidth="xs"><DialogTitle>加入持续监视</DialogTitle><DialogContent><Typography fontSize={13}>{registerLabel(watchConfirm?.name)} 的读取可能确认事件或改变状态。开始监视后会按所选周期重复获取。</Typography></DialogContent><DialogActions><Button onClick={() => setWatchConfirm(undefined)}>取消</Button><Button variant="contained" onClick={() => { if (watchConfirm) setPinned((current) => current.some((item) => definitionKey(item) === definitionKey(watchConfirm)) ? current : [...current, watchConfirm]); setWatchConfirm(undefined); }}>加入监视</Button></DialogActions></Dialog>
    <Dialog open={resetConfirm} onClose={() => { if (!writing) setResetConfirm(false); }}><DialogTitle>复位 EtherCAT 控制器</DialogTitle><DialogContent><Alert severity="error">复位会中断从站通信。</Alert></DialogContent><DialogActions><Button disabled={writing} onClick={() => setResetConfirm(false)}>取消</Button><Button color="error" variant="contained" disabled={controlsBlocked} onClick={async () => {
      const requestedContext = context; setWriting(true); setWatching(false);
      try { const value = await run(() => bridgeRequest("register_reset", { position: slave.position, profile: registerProfile }), "复位命令已发送"); if (value && contextRef.current === requestedContext) setResetConfirm(false); }
      finally { if (mounted.current && contextRef.current === requestedContext) setWriting(false); }
    }}>复位</Button></DialogActions></Dialog>
  </Stack></ThemeProvider>;
}
