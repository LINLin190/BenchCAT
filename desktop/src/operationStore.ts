import registry from "../../src/ethercat_debug_tool/protocol/commands.json";

export type OperationPhase = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export interface ManagedOperation {
  id: string;
  method: string;
  lane: "control" | "metadata" | "hardware";
  mutating: boolean;
  hostGeneration?: number;
  sessionId?: number;
  pageGeneration: number;
  phase: OperationPhase;
  error?: BridgeFailure;
}
export interface BridgeFailure {
  code: string;
  message: string;
  user_message?: string;
  operation_result?: "failed" | "unknown";
  session_invalidated?: boolean;
  method?: string;
}

type Spec = { lane: ManagedOperation["lane"]; mutating: boolean };
const specs = registry.commands as Record<string, Spec>;
const terminal = new Set<OperationPhase>(["completed", "failed", "cancelled", "unknown"]);
let sequence = 0;
let pageGeneration = 0;
let hostGeneration: number | undefined;
let sessionId: number | undefined;
let operations: ReadonlyMap<string, ManagedOperation> = new Map();
let updateInProgress = false;
const listeners = new Set<() => void>();
const activityListeners = new Set<() => void>();
interface OperationActivity {
  stateRequestBusy: boolean;
  hardwareBusy: boolean;
  scanning: boolean;
  connecting: boolean;
  configSaveBusy: boolean;
  disconnectHardwareBusy: boolean;
}
let activity: OperationActivity = { stateRequestBusy: false, hardwareBusy: false, scanning: false, connecting: false, configSaveBusy: false, disconnectHardwareBusy: false };

function publish(next: Map<string, ManagedOperation>) {
  operations = next;
  listeners.forEach((listener) => listener());
  const nextActivity: OperationActivity = { stateRequestBusy: false, hardwareBusy: false, scanning: false, connecting: false, configSaveBusy: false, disconnectHardwareBusy: false };
  for (const op of next.values()) {
    if (terminal.has(op.phase)) continue;
    nextActivity.stateRequestBusy ||= op.method === "request_state";
    nextActivity.hardwareBusy ||= op.lane === "hardware" && !["register_watch", "request_state"].includes(op.method);
    nextActivity.scanning ||= ["scan", "auto_scan"].includes(op.method);
    nextActivity.connecting ||= ["connect", "disconnect"].includes(op.method);
    nextActivity.configSaveBusy ||= op.method === "esi_config_save";
    nextActivity.disconnectHardwareBusy ||= op.lane === "hardware" && !["register_snapshot", "register_watch", "request_state"].includes(op.method);
  }
  // Routine request transitions must not redraw the application shell.
  if ((Object.keys(activity) as (keyof OperationActivity)[]).some((key) => activity[key] !== nextActivity[key])) {
    activity = nextActivity;
    activityListeners.forEach((listener) => listener());
  }
}

export const operationStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  snapshot() { return operations; },
  subscribeActivity(listener: () => void) { activityListeners.add(listener); return () => activityListeners.delete(listener); },
  activitySnapshot() { return activity; },
  get(id: string) { return operations.get(id); },
  context() { return { pageGeneration, hostGeneration, sessionId }; },
  setUpdateInProgress(value: boolean) { updateInProgress = value; },
  setSnapshotClock(generation: number, value: number, sourceOperationId?: string) {
    const generationChanged = hostGeneration !== undefined && hostGeneration !== generation;
    const sessionChanged = sessionId !== undefined && sessionId !== value;
    hostGeneration = generation;
    sessionId = value;
    if (generationChanged) {
      this.invalidate(
        "GENERATION_CHANGED",
        "通信服务已重新启动，请重新连接设备",
        (op) => op.id !== sourceOperationId,
      );
    } else if (sessionChanged) {
      this.invalidate("SESSION_CHANGED", "连接状态已变化，请刷新从站状态", (op) =>
        op.id !== sourceOperationId
        && op.sessionId !== undefined
        && op.sessionId !== value
        && !["connect", "disconnect", "scan", "auto_scan", "switch_mode", "reconfig", "recover", "register_reset", "eeprom_flash", "eeprom_restore"].includes(op.method),
      );
    }
  },
  nextPage() { pageGeneration += 1; this.invalidate("PAGE_CHANGED", "页面已切换，当前操作已停止", (op) => op.pageGeneration < pageGeneration); },
  begin(method: string) {
    const spec = specs[method];
    if (!spec) throw new Error(`未注册前端命令：${method}`);
    // The updater still needs to stop communication and disconnect safely.
    if (updateInProgress && spec.lane === "hardware" && !["stop_cycle", "disconnect"].includes(method)) {
      throw new Error("软件正在更新，设备操作暂不可用");
    }
    const id = `ui-${Date.now()}-${++sequence}`;
    if (operations.size > 200) operations = new Map([...operations].filter(([, op]) => !terminal.has(op.phase)).slice(-100));
    const operation: ManagedOperation = { id, method, lane: spec.lane, mutating: spec.mutating, hostGeneration, sessionId, pageGeneration, phase: "queued" };
    publish(new Map(operations).set(id, operation));
    return operation;
  },
  transition(id: string, phase: OperationPhase, error?: BridgeFailure) {
    const current = operations.get(id); if (!current || terminal.has(current.phase)) return;
    publish(new Map(operations).set(id, { ...current, phase, error }));
  },
  invalidate(code: string, message: string, predicate: (op: ManagedOperation) => boolean = () => true) {
    const next = new Map(operations);
    let changed = false;
    for (const [id, op] of next) if (!terminal.has(op.phase) && predicate(op)) {
      const phase: OperationPhase = op.mutating ? "unknown" : "failed";
      next.set(id, { ...op, phase, error: { code, message, operation_result: phase } });
      changed = true;
    }
    if (changed) publish(next);
  },
  active(method?: string) { return [...operations.values()].some((op) => !terminal.has(op.phase) && (!method || op.method === method)); },
  activeHardware() { return [...operations.values()].some((op) => !terminal.has(op.phase) && op.lane === "hardware" && op.method !== "register_watch"); },
};

export function normalizeBridgeFailure(error: unknown): BridgeFailure {
  if (error && typeof error === "object" && "message" in error) {
    const value = error as Partial<BridgeFailure>;
    return { code: value.code ?? "UNKNOWN", message: String(value.message), user_message: value.user_message, operation_result: value.operation_result, session_invalidated: value.session_invalidated, method: value.method };
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
}
