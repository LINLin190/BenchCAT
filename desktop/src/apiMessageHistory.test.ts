import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlaveInfo, WorkbenchStatus } from "./types";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const initial: WorkbenchStatus = { host_generation: 1, session_id: 1, revision: 1, mode: "real", phase: "bus_scanned", connected: true, cycle_running: false,
  adapter: "n0", last_error: null, slaves: [{ position: 1, name: "PDM", state: 8, raw_state: 8, al_status: 0 } as SlaveInfo] };
const envelope = (result: unknown, snapshot = initial) => ({ result, snapshot, host_generation: snapshot.host_generation, session_id: snapshot.session_id });
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bridge history integration", () => {
  it("does not report cached OP as confirmed after a rejected request without a fresh snapshot", async () => {
    native.invoke.mockImplementation(async (_command, args) => {
      if (args.method === "status") return envelope(initial);
      throw { code: "STATE_REQUEST_FAILED", user_message: "无法确认请求结果", message: "write not acknowledged", operation_result: "unknown" };
    });
    const { bridgeRequest } = await import("./api");
    const { messageHistory } = await import("./messageHistory");
    await bridgeRequest("status");
    await expect(bridgeRequest("request_state", { position: 0, state: 8 })).rejects.toMatchObject({ historyRecorded: true });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ result: "warning", text: "OP 状态请求未确认", reason: "未达到 0 个 · 未确认 1 个" });
  });
  it("uses the rejection snapshot to record the actual invalid status and AL code", async () => {
    const failed: WorkbenchStatus = { ...initial, revision: 2, slaves: [{ ...initial.slaves[0], state_error: "invalid", raw_state: 0x1600, al_status: 0x1600, observed_al_status: 0x1600 }] };
    const message = "从站 1：OP 请求未完成；当前为未知状态(0x00)；AL 错误码 0x1600（未知状态码）";
    native.invoke.mockImplementation(async (_command, args) => {
      if (args.method === "status") return envelope(initial);
      throw { code: "STATE_REQUEST_FAILED", message, user_message: message, snapshot: failed };
    });
    const { bridgeRequest } = await import("./api");
    const { messageHistory } = await import("./messageHistory");
    await bridgeRequest("status");
    await expect(bridgeRequest("request_state", { position: 1, state: 8 })).rejects.toThrow(message);
    expect(messageHistory.snapshot().entries[0].details).toContain("从站 1：AL Status 0x0130 = 0x1600");
  });
  it("preserves a completed device command even if the history observer fails", async () => {
    native.invoke.mockResolvedValue(envelope({ success: true, result: { words_written: 1 } }));
    const { bridgeRequest } = await import("./api");
    const { messageHistory } = await import("./messageHistory");
    vi.spyOn(messageHistory, "append").mockImplementation(() => { throw new Error("observer failed"); });
    await expect(bridgeRequest("eeprom_flash", { position: 1 })).resolves.toMatchObject({ success: true });
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
