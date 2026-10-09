import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AdapterInfo, BridgeEvent, BridgeExitInfo, WorkbenchStatus } from "./types";
import { normalizeBridgeFailure, operationStore } from "./operationStore";
import { acceptsSessionEvent, acceptsSnapshot } from "./snapshotClock";
import { reconcileBusSnapshot } from "./busSnapshot";
import { createHistoryRequest, type HistoryOptions } from "./bridgeHistory";

const isTauri = "__TAURI_INTERNALS__" in window;

export function initialEepromPath(): string | undefined {
  return (window as Window & { __BENCHCAT_EEPROM_PATH__?: string | null }).__BENCHCAT_EEPROM_PATH__ ?? undefined;
}

// Subscribe before draining so requests arriving during frontend startup stay queued.
export async function onEepromOpenRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  let active = true;
  let draining = false;
  let pending = false;
  const drain = async () => {
    pending = true;
    if (draining) return;
    draining = true;
    try {
      while (active && pending) {
        pending = false;
        const paths = await invoke<string[]>("take_eeprom_open_requests");
        if (active) paths.forEach((path) => handler(path));
      }
    } finally {
      draining = false;
    }
  };
  const unlisten = await listen("eeprom-open-request", () => { void drain(); });
  try {
    await drain();
  } catch (error) {
    active = false;
    unlisten();
    throw error;
  }
  return () => { active = false; unlisten(); };
}
type Handler = (event: BridgeEvent) => void;
type SnapshotHandler = (snapshot: WorkbenchStatus) => void;
interface BridgeEnvelope<T> {
  result: T;
  host_generation: number;
  session_id: number;
  snapshot: WorkbenchStatus;
}

function statusSnapshot(envelope: BridgeEnvelope<unknown>): WorkbenchStatus {
  const snapshot = envelope?.snapshot;
  const validClock = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!snapshot || !validClock(snapshot.host_generation) || !validClock(snapshot.session_id)
    || !validClock(snapshot.revision) || snapshot.host_generation !== envelope.host_generation
    || snapshot.session_id !== envelope.session_id || !["real", "demo"].includes(snapshot.mode)
    || typeof snapshot.phase !== "string" || typeof snapshot.connected !== "boolean"
    || typeof snapshot.cycle_running !== "boolean" || !Array.isArray(snapshot.slaves)
    || !(snapshot.adapter === null || typeof snapshot.adapter === "string")
    || !(snapshot.last_error === null || typeof snapshot.last_error === "string")) {
    throw { code: "PROTOCOL", message: "Status snapshot is incomplete or inconsistent with its envelope",
      user_message: "暂时无法连接设备，请重新加载网卡或重启软件。",
      method: "status", operation_result: "failed" };
  }
  return snapshot;
}

const snapshotHandlers = new Set<SnapshotHandler>();
let latestSnapshot: WorkbenchStatus | undefined;
let knownAdapters: AdapterInfo[] = [];

function publishSnapshot(snapshot: WorkbenchStatus | undefined, sourceOperationId?: string) {
  if (!snapshot) return;
  if (!acceptsSnapshot(latestSnapshot, snapshot)) return;
  operationStore.setSnapshotClock(snapshot.host_generation, snapshot.session_id, sourceOperationId);
  const next = reconcileBusSnapshot(latestSnapshot, snapshot);
  if (next === latestSnapshot) return;
  latestSnapshot = next;
  snapshotHandlers.forEach((handler) => handler(next));
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

const connectionErrorMessages: Record<string, string> = {
  BRIDGE_STARTING: "通信服务正在启动，请稍候。",
  BRIDGE_START_FAILED: "通信服务未能启动，请重新启动软件。",
  BRIDGE_UNAVAILABLE: "通信服务不可用，请重新启动软件。",
  PROTOCOL: "通信服务返回的信息不完整，请重新启动软件。",
  PROCESS_EXITED: "通信服务已停止，请重新启动软件。",
  TRANSPORT_WRITE: "无法向通信服务发送请求，请重新启动软件。",
  HOST_TIMEOUT: "通信服务响应超时，请重新启动软件。",
  WORKER_STALLED: "通信服务无响应，请重新启动软件。",
  WORKER_FATAL: "通信服务已停止，请重新启动软件。",
  GENERATION_CHANGED: "连接状态已变化，请重新连接网卡后再操作。",
  GENERATION_SUPERSEDED: "连接状态已变化，请重新连接网卡后再操作。",
};

export class BridgeRequestError extends Error {
  readonly code: string;
  readonly failure: ReturnType<typeof normalizeBridgeFailure>;
  historyRecorded = false;

  get severity(): "warning" | "error" {
    return this.failure.operation_result === "unknown" ? "warning" : "error";
  }

  constructor(failure: ReturnType<typeof normalizeBridgeFailure>) {
    const connectionMessage = connectionErrorMessages[failure.code];
    super(connectionMessage
      ? connectionMessage + (failure.operation_result === "unknown" ? " 写入结果尚未确认，请先读取设备确认结果，再继续操作。" : "")
      : failure.user_message ?? (failure.code === "CANCELLED" ? "操作已取消" : "操作未完成，请检查当前连接和操作条件。"));
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

export async function bridgeRequest<T>(method: string, params: Record<string, unknown> = {}, historyOptions: HistoryOptions = {}): Promise<T> {
  const operation = operationStore.begin(method);
  const before = latestSnapshot;
  const adapterName = String(params.adapter ?? before?.adapter ?? "");
  let history: ReturnType<typeof createHistoryRequest>;
  try {
    history = createHistoryRequest(method, params, before, {
      adapterLabel: knownAdapters.find(adapter => adapter.name === adapterName)?.description,
      ...historyOptions, operationId: operation.id.split("-").at(-1),
    });
  } catch (historyError) { console.error("Unable to begin operation history", historyError); }
  // History is observational and must never change the outcome of a device command.
  const finishHistory = (result?: unknown, error?: BridgeRequestError, snapshot?: WorkbenchStatus) => {
    try { history?.finish(result, error, snapshot); }
    catch (historyError) { console.error("Unable to record operation history", historyError); }
  };
  operationStore.transition(operation.id, "running");
  try {
    const envelope = isTauri
      ? await invoke<BridgeEnvelope<T>>("bridge_request", { method, params, sessionId: operation.sessionId })
      : await browserBridgeRequest<T>(method, params, operation.sessionId);
    // The host owns generation metadata; Python's raw status result has no host clock.
    const result = method === "status" ? statusSnapshot(envelope) : envelope.result;
    publishSnapshot(envelope.snapshot, operation.id);
    const current = operationStore.get(operation.id);
    if (current?.phase !== "running") throw current?.error ?? new Error("操作上下文已失效");
    operationStore.transition(operation.id, "completed");
    if (method === "enumerate_adapters") knownAdapters = result as AdapterInfo[];
    else if (method === "auto_scan") knownAdapters = (result as { adapters: AdapterInfo[] }).adapters;
    finishHistory(result, undefined, envelope.snapshot);
    return result as T;
  } catch (error) {
    const responseSnapshot = error && typeof error === "object" && "snapshot" in error
      ? (error as { snapshot?: WorkbenchStatus }).snapshot : undefined;
    if (error && typeof error === "object" && "snapshot" in error) {
      publishSnapshot((error as { snapshot?: WorkbenchStatus }).snapshot, operation.id);
    }
    const failure = normalizeBridgeFailure(error);
    operationStore.transition(operation.id, failure.operation_result === "unknown" ? "unknown" : failure.code === "CANCELLED" ? "cancelled" : "failed", failure);
    if (failure.session_invalidated) operationStore.invalidate(failure.code, failure.message);
    const requestError = new BridgeRequestError(failure);
    const freshSnapshot = responseSnapshot ?? (latestSnapshot && before && latestSnapshot.host_generation === before.host_generation
      && latestSnapshot.session_id === before.session_id && latestSnapshot.revision > before.revision ? latestSnapshot : undefined);
    finishHistory(undefined, requestError, freshSnapshot);
    requestError.historyRecorded = Boolean(history) || historyOptions.history === false;
    throw requestError;
  }
}

export async function onBridgeEvent(handler: Handler): Promise<UnlistenFn> {
  if (!isTauri) {
    const events = new EventSource("/api/events");
    events.onopen = () => handler({ kind: "host_ready", data: {} });
    events.onmessage = (message) => {
      try {
        consumeBridgeEvent(handler, JSON.parse(message.data) as BridgeEvent);
      } catch (error) {
        console.error("无法解析浏览器 Bridge 事件", error);
      }
    };
    return () => events.close();
  }
  let observedGeneration = 0;
  const stops: UnlistenFn[] = [];
  const publishHostState = (kind: "host_ready" | "host_restart_failed", data: { host_generation: number; message?: string }) => {
    if (data.host_generation < observedGeneration) return;
    observedGeneration = data.host_generation;
    handler({ kind, host_generation: data.host_generation, data });
  };
  try {
    stops.push(await listen<BridgeEvent>("bridge-event", (event) => consumeBridgeEvent(handler, event.payload)));
    stops.push(await listen<{ host_generation: number }>("bridge-restarted", (event) => publishHostState("host_ready", event.payload)));
    stops.push(await listen<{ host_generation: number; message: string }>("bridge-restart-failed", (event) => publishHostState("host_restart_failed", event.payload)));
    // Read durable native state after subscribing, so an earlier ready event cannot be lost.
    const state = await invoke<{ state: "starting" | "ready" | "failed" | "unavailable"; host_generation: number; message?: string }>("bridge_host_state");
    if (state.state === "ready") publishHostState("host_ready", state);
    else if (state.state !== "starting") publishHostState("host_restart_failed", state);
    return () => stops.forEach(stop => stop());
  } catch (error) {
    stops.forEach(stop => stop());
    throw error;
  }
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
  try {
    const stalled = await listen<{ message: string }>("bridge-stalled", (event) => receive({ ...event.payload, reason: "heartbeat_timeout" }));
    return () => { exited(); stalled(); };
  } catch (error) {
    exited();
    throw error;
  }
}

// Expose native drag presence without publishing high-frequency pointer movement.
export async function onFileDrop(handler: (paths: string[]) => void, onHover?: (active: boolean) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === "enter") onHover?.(event.payload.paths.some(path => /\.(xml|bin)$/i.test(path)));
    if (event.payload.type === "leave" || event.payload.type === "drop") onHover?.(false);
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

/** Read original PDF bytes outside the device command transport. */
export async function readRegisterManual(filename: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (isTauri) return invoke<ArrayBuffer>("read_register_manual", { filename });
  const response = await fetch(`/api/register-manual/${encodeURIComponent(filename)}`, { signal });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "无法加载离线手册");
  }
  return response.arrayBuffer();
}

export const previewMode = false;
export type { AdapterInfo, WorkbenchStatus };
