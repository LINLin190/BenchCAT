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

function publish(next: Map<string, ManagedOperation>) {
  operations = next;
  listeners.forEach((listener) => listener());
}

export const operationStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  snapshot() { return operations; },
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
        "EtherCAT 通信核心已重建",
        (op) => op.id !== sourceOperationId,
      );
    } else if (sessionChanged) {
      this.invalidate("SESSION_CHANGED", "EtherCAT 会话已变化", (op) =>
        op.id !== sourceOperationId
        && op.sessionId !== undefined
        && op.sessionId !== value
        && !["connect", "disconnect", "scan", "auto_scan", "switch_mode", "reconfig", "recover", "register_reset", "eeprom_flash", "eeprom_restore"].includes(op.method),
      );
    }
  },
  nextPage() { pageGeneration += 1; this.invalidate("PAGE_CHANGED", "页面上下文已变化", (op) => op.pageGeneration < pageGeneration); },
  begin(method: string) {
    const spec = specs[method];
    if (!spec) throw new Error(`未注册前端命令：${method}`);
    // The updater still needs to stop communication and disconnect safely.
    if (updateInProgress && spec.lane === "hardware" && !["stop_cycle", "disconnect"].includes(method)) {
      throw new Error("正在更新 BenchCAT，设备操作暂不可用");
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
    for (const [id, op] of next) if (!terminal.has(op.phase) && predicate(op)) {
      const phase: OperationPhase = op.mutating ? "unknown" : "failed";
      next.set(id, { ...op, phase, error: { code, message, operation_result: phase } });
    }
    publish(next);
  },
  active(method?: string) { return [...operations.values()].some((op) => !terminal.has(op.phase) && (!method || op.method === method)); },
  activeHardware() { return [...operations.values()].some((op) => !terminal.has(op.phase) && op.lane === "hardware" && op.method !== "register_watch"); },
};

export function normalizeBridgeFailure(error: unknown): BridgeFailure {
  if (error && typeof error === "object" && "message" in error) {
    const value = error as Partial<BridgeFailure>;
    return { code: value.code ?? "UNKNOWN", message: String(value.message), operation_result: value.operation_result, session_invalidated: value.session_invalidated, method: value.method };
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
}
