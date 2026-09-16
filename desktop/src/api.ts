import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AdapterInfo, BridgeEvent, BridgeExitInfo, WorkbenchStatus } from "./types";
import { normalizeBridgeFailure, operationStore } from "./operationStore";
import { acceptsSessionEvent, acceptsSnapshot } from "./snapshotClock";

const isTauri = "__TAURI_INTERNALS__" in window;
type Handler = (event: BridgeEvent) => void;
type SnapshotHandler = (snapshot: WorkbenchStatus) => void;
interface BridgeEnvelope<T> {
  result: T;
  host_generation: number;
  session_id: number;
  snapshot: WorkbenchStatus;
}

const snapshotHandlers = new Set<SnapshotHandler>();
let latestSnapshot: WorkbenchStatus | undefined;

function publishSnapshot(snapshot: WorkbenchStatus | undefined, sourceOperationId?: string) {
  if (!snapshot) return;
  if (!acceptsSnapshot(latestSnapshot, snapshot)) return;
  latestSnapshot = snapshot;
  operationStore.setSnapshotClock(snapshot.host_generation, snapshot.session_id, sourceOperationId);
  snapshotHandlers.forEach((handler) => handler(snapshot));
}

function publishHostFault(message: string, hostGeneration?: number) {
  const previous = latestSnapshot;
  publishSnapshot({
    host_generation: hostGeneration ?? previous?.host_generation ?? 0,
    mode: previous?.mode ?? "real",
    phase: "faulted",
    adapter: null,
    connected: false,
    cycle_running: false,
    slaves: [],
    session_id: previous?.session_id ?? 0,
    revision: previous?.revision ?? 0,
    last_error: message,
    worker_healthy: false,
    worker_state: "exited",
    queue_depth: 0,
  });
}

export function subscribeBusSnapshot(handler: SnapshotHandler): () => void {
  snapshotHandlers.add(handler);
  return () => snapshotHandlers.delete(handler);
}

export class BridgeRequestError extends Error {
  readonly code: string;
  readonly failure: ReturnType<typeof normalizeBridgeFailure>;

  constructor(failure: ReturnType<typeof normalizeBridgeFailure>) {
    super(failure.message);
    this.name = "BridgeRequestError";
    this.code = failure.code;
    this.failure = failure;
  }
}

async function fetchJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json() as T;
      if (!response.ok) throw value;
      return value;
    } catch (error) {
      lastError = error;
      if (!(error instanceof TypeError) || attempt === 29) break;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error("独立浏览器通信核心不可用");
}

async function browserBridgeRequest<T>(
  method: string,
  params: Record<string, unknown>,
  sessionId: number | undefined,
): Promise<BridgeEnvelope<T>> {
  return fetchJson<BridgeEnvelope<T>>("/api/bridge", {
    method,
    params,
    session_id: sessionId,
  });
}

function consumeBridgeEvent(handler: Handler, event: BridgeEvent) {
  if (event.kind === "bus_snapshot") {
    const snapshot = event.data as WorkbenchStatus;
    publishSnapshot({
      ...snapshot,
      host_generation: snapshot.host_generation ?? event.host_generation ?? 0,
    });
    return;
  }
  if (!acceptsSessionEvent(latestSnapshot, event)) return;
  handler(event);
}

export async function bridgeRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const operation = operationStore.begin(method);
  operationStore.transition(operation.id, "running");
  try {
    const envelope = isTauri
      ? await invoke<BridgeEnvelope<T>>("bridge_request", { method, params, sessionId: operation.sessionId })
      : await browserBridgeRequest<T>(method, params, operation.sessionId);
    publishSnapshot(envelope.snapshot, operation.id);
    const current = operationStore.get(operation.id);
    if (current?.phase !== "running") throw current?.error ?? new Error("操作上下文已失效");
    operationStore.transition(operation.id, "completed");
    return envelope.result;
  } catch (error) {
    if (error && typeof error === "object" && "snapshot" in error) {
      publishSnapshot((error as { snapshot?: WorkbenchStatus }).snapshot, operation.id);
    }
    const failure = normalizeBridgeFailure(error);
    operationStore.transition(operation.id, failure.operation_result === "unknown" ? "unknown" : failure.code === "CANCELLED" ? "cancelled" : "failed", failure);
    if (failure.session_invalidated) operationStore.invalidate(failure.code, failure.message);
    throw new BridgeRequestError(failure);
  }
}

export async function onBridgeEvent(handler: Handler): Promise<UnlistenFn> {
  if (!isTauri) {
    const events = new EventSource("/api/events");
    events.onmessage = (message) => {
      try {
        consumeBridgeEvent(handler, JSON.parse(message.data) as BridgeEvent);
      } catch (error) {
        console.error("无法解析浏览器 Bridge 事件", error);
      }
    };
    return () => events.close();
  }
  const bridgeEvent = await listen<BridgeEvent>("bridge-event", (event) => {
    consumeBridgeEvent(handler, event.payload);
  });
  const restarted = await listen<{ host_generation: number }>("bridge-restarted", (event) =>
    handler({ kind: "host_ready", data: event.payload })
  );
  const restartFailed = await listen<{ host_generation: number; message: string }>("bridge-restart-failed", (event) =>
    handler({ kind: "host_restart_failed", data: event.payload })
  );
  return () => { bridgeEvent(); restarted(); restartFailed(); };
}

export async function onBridgeExited(handler: (info: BridgeExitInfo) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const receive = (payload: BridgeExitInfo | string) => {
    const info = typeof payload === "string"
      ? { message: payload, reason: "旧版桥接未提供退出详情" }
      : payload;
    operationStore.invalidate("PROCESS_EXITED", info.message);
    publishHostFault(info.message, info.host_generation);
    handler(info);
  };
  const exited = await listen<BridgeExitInfo | string>("bridge-exited", (event) => receive(event.payload));
  const stalled = await listen<{ message: string }>("bridge-stalled", (event) => receive({ ...event.payload, reason: "heartbeat_timeout" }));
  return () => { exited(); stalled(); };
}

export async function onFileDrop(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "drop") handler(event.payload.paths);
  });
}

export async function pickFile(extensions: string[]): Promise<string | null> {
  if (!isTauri) {
    return (await fetchJson<{ path: string | null }>("/api/dialog/file", { extensions })).path;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, filters: [{ name: "支持的文件", extensions }] });
  return typeof selected === "string" ? selected : null;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri) {
    return (await fetchJson<{ path: string | null }>("/api/dialog/directory", {})).path;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function revealPath(path: string): Promise<void> {
  if (!isTauri) {
    await fetchJson("/api/reveal", { path });
    return;
  }
  await invoke("reveal_path", { path });
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_external", { url });
}

export const previewMode = false;
export const demoModeAvailable = isTauri;
export type { AdapterInfo, WorkbenchStatus };
