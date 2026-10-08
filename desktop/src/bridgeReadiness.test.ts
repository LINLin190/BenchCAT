import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  native.listen.mockImplementation(async (name, handler) => { handlers.set(name, handler); return native.stop; });
});
afterEach(() => vi.unstubAllGlobals());

describe("native core admission", () => {
  it("subscribes before reading durable readiness and sends no early bridge command", async () => {
    native.invoke.mockImplementation(async (command) => {
      expect(handlers.has("bridge-restarted")).toBe(true);
      expect(command).toBe("bridge_host_state");
      return { state: "starting", host_generation: 1 };
    });
    const { onBridgeEvent } = await import("./api");
    const receive = vi.fn();
    const stop = await onBridgeEvent(receive);
    expect(receive).not.toHaveBeenCalled();
    handlers.get("bridge-restarted")!({ payload: { host_generation: 1 } });
    expect(receive).toHaveBeenCalledWith({ kind: "host_ready", host_generation: 1, data: { host_generation: 1 } });
    stop();
    expect(native.stop).toHaveBeenCalledTimes(3);
  });

  it("delivers readiness when Python finished before the frontend subscribed", async () => {
    native.invoke.mockResolvedValue({ state: "ready", host_generation: 4 });
    const { onBridgeEvent } = await import("./api");
    const receive = vi.fn();
    await onBridgeEvent(receive);
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0][0]).toMatchObject({ kind: "host_ready", host_generation: 4 });
  });

  it("rejects an older query result arriving after a newer admission event", async () => {
    native.invoke.mockImplementation(async () => {
      handlers.get("bridge-restarted")!({ payload: { host_generation: 5 } });
      return { state: "ready", host_generation: 4 };
    });
    const { onBridgeEvent } = await import("./api");
    const receive = vi.fn();
    await onBridgeEvent(receive);
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0][0].host_generation).toBe(5);
  });

  it("preserves genuine startup failure details and cleans up failed subscriptions", async () => {
    native.invoke.mockResolvedValue({ state: "failed", host_generation: 2, message: "Python executable missing" });
    const { onBridgeEvent } = await import("./api");
    const receive = vi.fn();
    await onBridgeEvent(receive);
    expect(receive.mock.calls[0][0]).toMatchObject({ kind: "host_restart_failed", data: { message: "Python executable missing" } });
    native.invoke.mockRejectedValue(new Error("readiness query failed"));
    await expect(onBridgeEvent(vi.fn())).rejects.toThrow("readiness query failed");
    expect(native.stop).toHaveBeenCalledTimes(3);
  });

  it("releases the exit listener when the remaining fault subscription fails", async () => {
    native.listen.mockImplementation(async (name) => {
      if (name === "bridge-stalled") throw new Error("fault subscription failed");
      return native.stop;
    });
    const { onBridgeExited } = await import("./api");
    await expect(onBridgeExited(vi.fn())).rejects.toThrow("fault subscription failed");
    expect(native.stop).toHaveBeenCalledOnce();
  });
});
