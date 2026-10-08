import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  native.listen.mockResolvedValue(native.stop);
  native.invoke.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe("XML quick-flash launch delivery", () => {
  it("keeps browser mode independent of native launch commands", async () => {
    vi.stubGlobal("window", {});
    const { onEepromOpenRequest } = await import("./api");
    const stop = await onEepromOpenRequest(vi.fn());
    stop();
    expect(native.listen).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("exposes the cold-start XML synchronously without contacting the bridge", async () => {
    const path = String.raw`D:\设备文件\从站 1.XML`;
    Object.assign(window, { __BENCHCAT_EEPROM_PATH__: path });
    const { initialEepromPath } = await import("./api");
    expect(initialEepromPath()).toBe(path);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("subscribes before taking requests queued while the frontend was loading", async () => {
    native.invoke.mockResolvedValueOnce([String.raw`D:\设备文件\从站 1.xml`]);
    const { onEepromOpenRequest } = await import("./api");
    const receive = vi.fn();
    const stop = await onEepromOpenRequest(receive);
    expect(native.listen.mock.invocationCallOrder[0]).toBeLessThan(native.invoke.mock.invocationCallOrder[0]);
    expect(native.invoke).toHaveBeenCalledWith("take_eeprom_open_requests");
    expect(receive).toHaveBeenCalledExactlyOnceWith(String.raw`D:\设备文件\从站 1.xml`);
    stop();
    expect(native.stop).toHaveBeenCalledOnce();
  });

  it("delivers a second launch arriving while the first drain is in flight", async () => {
    let complete!: (paths: string[]) => void;
    native.invoke.mockImplementationOnce(() => new Promise<string[]>((resolve) => { complete = resolve; }))
      .mockResolvedValueOnce(["second.xml"]);
    const { onEepromOpenRequest } = await import("./api");
    const receive = vi.fn();
    const subscription = onEepromOpenRequest(receive);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
    native.listen.mock.calls[0][1]({ payload: null });
    complete(["first.xml"]);
    const stop = await subscription;
    expect(receive.mock.calls.map(([path]) => path)).toEqual(["first.xml", "second.xml"]);
    stop();
  });

  it("does not deliver a pending request after the subscription closes", async () => {
    const { onEepromOpenRequest } = await import("./api");
    const receive = vi.fn();
    const stop = await onEepromOpenRequest(receive);
    let complete!: (paths: string[]) => void;
    native.invoke.mockImplementationOnce(() => new Promise<string[]>((resolve) => { complete = resolve; }));
    native.listen.mock.calls[0][1]({ payload: null });
    stop();
    complete(["late.xml"]);
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
  });

  it("releases the event listener if the native command is unavailable", async () => {
    native.invoke.mockRejectedValueOnce(new Error("missing command"));
    const { onEepromOpenRequest } = await import("./api");
    await expect(onEepromOpenRequest(vi.fn())).rejects.toThrow("missing command");
    expect(native.stop).toHaveBeenCalledOnce();
  });
});
