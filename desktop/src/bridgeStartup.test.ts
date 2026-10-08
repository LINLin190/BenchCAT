import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoScanResult, WorkbenchStatus } from "./types";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
const adapters = [{ name: "npcap0", description: "EtherCAT adapter" }];
const scan: AutoScanResult = { adapters, selected_adapter: "npcap0", connected: false, slaves: [], attempts: [] };
function snapshot(generation = 1, connected = false): WorkbenchStatus {
  return { host_generation: generation, mode: "real", phase: connected ? "adapter_open" : "disconnected",
    adapter: connected ? "npcap0" : null, connected, cycle_running: false, slaves: [],
    session_id: 0, revision: 0, last_error: null };
}
function response(method: string, generation = 1, connected = false) {
  const status = snapshot(generation, connected);
  const { host_generation: _, ...pythonStatus } = status;
  return { host_generation: generation, session_id: status.session_id, snapshot: status,
    result: method === "status" ? pythonStatus : method === "auto_scan" ? scan : adapters };
}
function handlers() {
  return { preferredAdapter: () => "npcap0", onAdapters: vi.fn(), onScan: vi.fn(), onLoading: vi.fn(), onError: vi.fn() };
}
function methods() {
  return native.invoke.mock.calls.filter(([command]) => command === "bridge_request").map(([, args]) => args.method);
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  native.listen.mockResolvedValue(() => undefined);
  native.invoke.mockImplementation(async (command, args) => command === "bridge_host_state"
    ? { state: "ready", host_generation: 1 } : response(args.method));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("status response contract", () => {
  it("returns the host snapshot when Python's raw result has no host generation", async () => {
    const { bridgeRequest, subscribeBusSnapshot } = await import("./api");
    const receive = vi.fn();
    subscribeBusSnapshot(receive);
    const status = await bridgeRequest<WorkbenchStatus>("status");
    expect(status).toEqual(snapshot());
    expect(status).toBe(receive.mock.calls[0][0]);
    expect(await bridgeRequest("enumerate_adapters")).toEqual(adapters);
  });

  it.each(["missing clock", "generation mismatch", "session mismatch"])("rejects %s before publishing status", async (fault) => {
    const envelope = response("status");
    if (fault === "missing clock") delete (envelope.snapshot as Partial<WorkbenchStatus>).host_generation;
    if (fault === "generation mismatch") envelope.host_generation = 2;
    if (fault === "session mismatch") envelope.session_id = 3;
    native.invoke.mockResolvedValue(envelope);
    const { bridgeRequest, subscribeBusSnapshot } = await import("./api");
    const { operationStore } = await import("./operationStore");
    const receive = vi.fn();
    subscribeBusSnapshot(receive);
    await expect(bridgeRequest("status")).rejects.toMatchObject({ code: "PROTOCOL" });
    expect(receive).not.toHaveBeenCalled();
    expect(operationStore.context().hostGeneration).toBeUndefined();
  });

  it("also normalizes the browser status envelope", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response("status") }));
    const { bridgeRequest } = await import("./api");
    expect(await bridgeRequest("status")).toEqual(snapshot());
    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe("device initialization", () => {
  it.each([true, false])("waits for admission and subscriptions, then enumerates once (ready first: %s)", async (readyFirst) => {
    const { createBridgeStartup } = await import("./bridgeStartup");
    const { onBridgeEvent } = await import("./api");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    const subscribe = () => onBridgeEvent((event) => { if (event.kind === "host_ready") startup.ready(event.host_generation!); });
    if (readyFirst) { await subscribe(); expect(methods()).toEqual([]); startup.subscribed(); }
    else { startup.subscribed(); expect(methods()).toEqual([]); await subscribe(); }
    await vi.waitFor(() => expect(callbacks.onLoading).toHaveBeenLastCalledWith(false));
    expect(methods()).toEqual(["status", "auto_scan"]);
    expect(callbacks.onAdapters).toHaveBeenCalledExactlyOnceWith(adapters, "npcap0");
    expect(callbacks.onScan).toHaveBeenCalledExactlyOnceWith(scan);
    expect(callbacks.onError.mock.calls.every(([value]) => value === undefined)).toBe(true);
    expect(startup.ready(1)).toBe(false);
    expect(methods()).toEqual(["status", "auto_scan"]);
  });

  it("enumerates without scanning an already connected master", async () => {
    native.invoke.mockImplementation(async (_command, args) => response(args.method, 1, true));
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed();
    await vi.waitFor(() => expect(callbacks.onAdapters).toHaveBeenCalled());
    expect(methods()).toEqual(["status", "enumerate_adapters"]);
    expect(callbacks.onScan).not.toHaveBeenCalled();
  });

  it("keeps scan failure details in diagnostics and offers explicit adapter reload without repeating scan", async () => {
    native.invoke.mockImplementation(async (_command, args) => {
      if (args.method === "auto_scan") throw { code: "HARDWARE", message: "adapter open failed", user_message: "无法打开网卡" };
      return response(args.method);
    });
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed();
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenLastCalledWith("无法加载网卡，请重新加载网卡；如仍无法使用，请重启软件。"));
    expect(callbacks.onLoading).toHaveBeenLastCalledWith(false);
    expect(methods()).toEqual(["status", "auto_scan"]);
    startup.reloadAdapters();
    await vi.waitFor(() => expect(callbacks.onAdapters).toHaveBeenCalled());
    expect(methods()).toEqual(["status", "auto_scan", "status", "enumerate_adapters"]);
    expect(callbacks.onError).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps inconsistent generation details in diagnostics and reports an adapter reload action", async () => {
    native.invoke.mockResolvedValue(response("status", 2));
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed();
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenLastCalledWith("无法加载网卡，请重新加载网卡；如仍无法使用，请重启软件。"));
    expect(methods()).toEqual(["status"]);
    expect(callbacks.onLoading).toHaveBeenLastCalledWith(false);
  });

  it("starts the replacement generation after discarding the old pending status", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    native.invoke.mockImplementationOnce(() => new Promise((complete) => { resolve = complete; }))
      .mockImplementation(async (_command, args) => response(args.method, 2));
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed();
    startup.ready(2);
    resolve(response("status", 1));
    await vi.waitFor(() => expect(callbacks.onScan).toHaveBeenCalled());
    expect(methods()).toEqual(["status", "status", "auto_scan"]);
    expect(callbacks.onAdapters).toHaveBeenCalledOnce();
    expect(callbacks.onError.mock.calls.every(([value]) => value === undefined)).toBe(true);
  });

  it("does not show an old scan failure after the host has restarted", async () => {
    let reject!: (error: unknown) => void;
    let generation = 1;
    native.invoke.mockImplementation(async (_command, args) => {
      if (args.method === "auto_scan" && generation === 1) return new Promise((_resolve, fail) => { reject = fail; });
      return response(args.method, generation);
    });
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed();
    await vi.waitFor(() => expect(methods()).toEqual(["status", "auto_scan"]));
    startup.unavailable(); generation = 2; startup.ready(2);
    reject({ code: "PROCESS_EXITED", message: "old core exited" });
    await vi.waitFor(() => expect(callbacks.onScan).toHaveBeenCalledOnce());
    expect(methods()).toEqual(["status", "auto_scan", "status", "auto_scan"]);
    expect(callbacks.onError.mock.calls.every(([value]) => value === undefined)).toBe(true);
  });

  it("accepts browser admission before its first host clock is known", async () => {
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(0); startup.subscribed();
    await vi.waitFor(() => expect(callbacks.onScan).toHaveBeenCalledOnce());
    expect(methods()).toEqual(["status", "auto_scan"]);
  });

  it("allows a fresh adapter enumeration after an empty list", async () => {
    native.invoke.mockImplementation(async (_command, args) => args.method === "auto_scan"
      ? { ...response(args.method), result: { ...scan, adapters: [], selected_adapter: "" } } : response(args.method));
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed();
    await vi.waitFor(() => expect(callbacks.onAdapters).toHaveBeenCalledWith([], undefined));
    startup.reloadAdapters();
    await vi.waitFor(() => expect(callbacks.onAdapters).toHaveBeenLastCalledWith(adapters, undefined));
    expect(methods()).toEqual(["status", "auto_scan", "status", "enumerate_adapters"]);
  });

  it("stops applying pending device data after disposal", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    native.invoke.mockImplementationOnce(() => new Promise((complete) => { resolve = complete; }));
    const { createBridgeStartup } = await import("./bridgeStartup");
    const callbacks = handlers();
    const startup = createBridgeStartup(callbacks);
    startup.ready(1); startup.subscribed(); startup.dispose();
    resolve(response("status"));
    await new Promise((complete) => setTimeout(complete, 0));
    expect(methods()).toEqual(["status"]);
    expect(callbacks.onAdapters).not.toHaveBeenCalled();
    expect(callbacks.onError.mock.calls.every(([value]) => value === undefined)).toBe(true);
  });
});
