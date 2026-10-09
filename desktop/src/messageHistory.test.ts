import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryRequest, cycleFaultHistory } from "./bridgeHistory";
import { copyMessage, createMessageHistory, HISTORY_LIMIT, messageHistory } from "./messageHistory";
import type { SlaveInfo, WorkbenchStatus } from "./types";

const slave = (position: number, overrides: Partial<SlaveInfo> = {}) => ({ position, state: 1, raw_state: 1, al_status: 0, ...overrides } as SlaveInfo);
const status = (slaves: SlaveInfo[]) => ({ slaves, adapter: "Ethernet", host_generation: 1, session_id: 1 } as WorkbenchStatus);
beforeEach(() => { messageHistory.setViewing(false); messageHistory.clear(); });
afterEach(() => vi.useRealTimers());

describe("session message history", () => {
  it("stores only faults and labels an unconfirmed outcome as a warning", () => {
    const history = createMessageHistory();
    for (const result of ["started", "success", "info", "cancelled"] as const) history.append({ operation: "操作", result, text: result });
    expect(history.snapshot().entries).toEqual([]);
    history.append({ operation: "操作", result: "unknown", text: "结果未确认" });
    expect(history.snapshot()).toMatchObject({ unread: 1, unreadErrors: 0 });
    expect(history.snapshot().entries[0].result).toBe("warning");
  });
  it("keeps explicit failures separate and tracks unread severities", () => {
    const history = createMessageHistory();
    const input = { operation: "状态请求", result: "error" as const, text: "同一错误" };
    history.append(input); history.append(input);
    expect(history.snapshot()).toMatchObject({ unread: 2, unreadErrors: 2 });
    history.setViewing(true); history.append(input);
    expect(history.snapshot().unread).toBe(0);
    history.setViewing(false); history.append({ ...input, result: "warning" });
    expect(history.snapshot()).toMatchObject({ unread: 1, unreadErrors: 0 });
    expect(createMessageHistory().snapshot().entries).toEqual([]);
  });
  it("separates a monitoring fault headline from its cause", () => {
    const history = createMessageHistory();
    history.append({ operation: "寄存器监视", result: "error", text: "寄存器监视异常停止；部分寄存器读取失败", durationMs: 3000, operationId: "monitor-1" });
    expect(history.snapshot().entries[0]).toMatchObject({ text: "寄存器监视异常停止", reason: "部分寄存器读取失败" });
    expect(copyMessage(history.snapshot().entries[0])).not.toMatch(/操作编号|耗时/);
  });
  it("merges automatic repeats, updates their WKC, and marks a repeated fault unread", () => {
    vi.useFakeTimers();
    const history = createMessageHistory();
    const input = { operation: "监测", result: "error" as const, text: "通信异常", repeatKey: "slave-1", wkc: [{ label: "WKC", actual: 0, expected: 6 }] };
    history.append(input);
    const first = history.snapshot().entries[0];
    history.setViewing(true); history.setViewing(false);
    vi.advanceTimersByTime(1000);
    history.append({ ...input, wkc: [{ label: "WKC", actual: 3, expected: 6 }] });
    expect(history.snapshot().entries).toHaveLength(1);
    expect(history.snapshot().entries[0]).toMatchObject({ id: first.id, firstTime: first.time, time: first.time + 1000, repeatCount: 2, wkc: [{ actual: 3 }] });
    expect(history.snapshot()).toMatchObject({ unread: 1, unreadErrors: 1 });
    history.endRepeat("slave-1"); history.append(input);
    expect(history.snapshot().entries).toHaveLength(2);
    history.clear(); history.append(input);
    expect(history.snapshot().entries[0].repeatCount).toBe(1);
  });
  it("separates different automatic causes and bounds retained records", () => {
    const history = createMessageHistory();
    history.append({ operation: "监测", result: "error", text: "通信异常", reason: "原因 A", repeatKey: "monitor" });
    history.append({ operation: "监测", result: "error", text: "通信异常", reason: "原因 B", repeatKey: "monitor" });
    expect(history.snapshot().entries).toHaveLength(2);
    for (let index = 0; index <= HISTORY_LIMIT; index++) history.append({ operation: "读取", result: "error", text: `${index}` });
    expect(history.snapshot().entries).toHaveLength(300);
    expect(history.snapshot().unread).toBe(300);
    expect(history.snapshot().entries.at(-1)?.text).toBe("1");
  });
  it("copies the complete fault without routine operation metadata", () => {
    const history = createMessageHistory();
    const input = { operation: "读取", result: "error" as const, text: "读取失败", reason: "完整原因", details: ["原始错误"], wkc: [{ label: "读取 WKC", actual: 0, expected: 1 }] };
    history.append(input);
    input.wkc[0].actual = 9; input.details[0] = "changed";
    const copied = copyMessage(history.snapshot().entries[0]);
    expect(copied).toContain("读取 WKC：实际 0 / 期望 1");
    expect(copied).toContain("原始错误");
    expect(copied).toContain("完整原因");
    expect(copied).not.toMatch(/操作编号|耗时/);
  });
});

describe("operation faults", () => {
  it("ignores successful operations, polling, and intentional cancellation", () => {
    expect(createHistoryRequest("status", {})).toBeUndefined();
    expect(createHistoryRequest("register_snapshot", { automatic: true })).toBeUndefined();
    expect(createHistoryRequest("esi_load", {}, undefined, { history: false })).toBeUndefined();
    createHistoryRequest("register_raw_read", { position: 1 })?.finish({ wkc: 1, data: "00 16" });
    createHistoryRequest("eeprom_flash", { position: 1 })?.finish({ success: true, result: {} });
    createHistoryRequest("eeprom_read", { position: 1 })?.finish(undefined, { code: "CANCELLED", message: "已取消" });
    createHistoryRequest("register_snapshot", { automatic: false })?.finish({ cancelled: true, errors: { status: "WKC=0" } });
    expect(messageHistory.snapshot().entries).toEqual([]);
  });
  it("records programming failures and keeps captured file and device details", () => {
    const before = status([slave(1, { name: "PDM" })]);
    const request = createHistoryRequest("eeprom_flash", { position: 1 }, before, { file: "D:\\device.xml", device: "PDM Device" });
    before.slaves[0].name = "Other";
    request?.finish({ success: false, result: { image_verification: "回读不一致" } });
    request?.finish({ success: false });
    expect(messageHistory.snapshot().entries).toHaveLength(1);
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ result: "error", text: "烧录 XML失败", context: "从站 1 · device.xml", reason: "回读不一致" });
    expect(messageHistory.snapshot().entries[0].details).toContain("设备：PDM");
  });
  it("reports only failed batch members and preserves fresh invalid AL readings", () => {
    const failed = slave(2, { state: 2, raw_state: 0x1600, state_error: "invalid", observed_al_status: 0x1600, al_status: 0x1600 });
    createHistoryRequest("request_state", { state: 8, position: 0 }, status([slave(1), slave(2)]))?.finish(undefined,
      { code: "STATE_REQUEST_FAILED", message: "从站 2：状态请求失败" }, status([slave(1, { state: 8, raw_state: 8 }), failed]));
    failed.raw_state = 2; failed.observed_al_status = 0;
    const entry = messageHistory.snapshot().entries[0];
    expect(entry.reason).toBe("未达到 0 个 · 未确认 1 个");
    expect(entry.details?.join(" ")).not.toContain("从站 1");
    expect(entry.details?.join(" ")).toContain("未知状态(0x00)");
    expect(entry.details).toContain("从站 2：AL Status 0x0130 = 0x1600");
  });
  it("does not claim cached OP confirms a failed batch", () => {
    createHistoryRequest("request_state", { state: 8, position: 0 }, status([slave(1, { state: 8, raw_state: 8 })]))?.finish(undefined,
      { code: "STATE_REQUEST_FAILED", message: "无法确认请求结果", failure: { code: "STATE_REQUEST_FAILED", message: "write not acknowledged", operation_result: "unknown" } });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ result: "warning", text: "OP 状态请求未确认", reason: "未达到 0 个 · 未确认 1 个" });
    expect(messageHistory.snapshot().entries[0].details?.join(" ")).not.toMatch(/已进入|AL Status/);
  });
  it("keeps an invalid state with a zero AL code distinct from an unread state", () => {
    createHistoryRequest("request_state", { position: 1, state: 8 })?.finish([slave(1, { state_error: "invalid", raw_state: 0x1606, observed_al_status: 0 })]);
    expect(messageHistory.snapshot().entries[0].reason).toContain("未知状态(0x06)");
    expect(messageHistory.snapshot().entries[0].reason).not.toContain("无法读取");
  });
  it("retains real WKC values separately for reading, writing, and readback", () => {
    createHistoryRequest("register_raw_read", { position: 1, address: 0x130, size: 2 })?.finish({ wkc: 0, data: "" });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ context: "从站 1 · 地址 0x0130", wkc: [{ label: "读取 WKC", actual: 0, expected: 1 }] });
    createHistoryRequest("register_raw_write", { position: 1 })?.finish({ write_wkc: 0, readback: { wkc: 1, data: "01 00" } });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ result: "warning", text: "寄存器写入未确认", wkc: [{ label: "写入 WKC", actual: 0 }, { label: "回读 WKC", actual: 1 }] });
    createHistoryRequest("register_raw_write", { position: 1 })?.finish({ write_wkc: 1, readback: { wkc: 0, data: "" } });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ text: "寄存器写入后回读失败", wkc: [{ actual: 1 }, { actual: 0 }] });
    createHistoryRequest("register_raw_write", { position: 1 })?.finish({ write_wkc: null, readback: null, write_error: "timeout" });
    expect(messageHistory.snapshot().entries[0].wkc).toEqual([]);
  });
  it("keeps only errors in a partially acquired register batch", () => {
    createHistoryRequest("register_snapshot", { position: 1, automatic: false })?.finish({ values: [{ address: 0x130, data: "00 16" }], errors: { status: "WKC=0" }, skipped: { reserved: "保留地址" } });
    const entry = messageHistory.snapshot().entries[0];
    expect(entry).toMatchObject({ result: "warning", text: "寄存器读取失败", reason: "1 项读取失败" });
    expect(entry.details).toEqual(["status：WKC=0"]);
  });
  it("reports SDO comparison faults without inventing a WKC", () => {
    createHistoryRequest("sdo_write", { position: 1, index: 0x2000, subindex: 1, data: "01 00" })?.finish({ data: "01 00", readback: "00 00", verified: false });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ result: "error", reason: "写入值与回读值不一致", context: "从站 1 · 对象 0x2000:0x01" });
    expect(messageHistory.snapshot().entries[0].wkc).toBeUndefined();
  });
  it("keeps EEPROM parsing and comparison anomalies as warnings", () => {
    createHistoryRequest("eeprom_read", { position: 1 })?.finish({ sii_valid: false, sii_error: "invalid categories", comparison: { equal: false, differing_bytes: 2 } });
    expect(messageHistory.snapshot().entries[0]).toMatchObject({ result: "warning", text: "EEPROM 数据异常" });
    expect(messageHistory.snapshot().entries[0].details).toContain("与目标镜像差异 2 B");
  });
  it("merges automatic generation faults until recovery while preserving explicit failures", () => {
    const options = { file: "device.xml", device: "Device", automatic: true };
    const failure = { code: "INVALID_ESI", message: "缺少 Device 信息" };
    createHistoryRequest("sii_generate", { ordinal: 0 }, undefined, options)?.finish(undefined, failure);
    createHistoryRequest("sii_generate", { ordinal: 0 }, undefined, options)?.finish(undefined, failure);
    expect(messageHistory.snapshot().entries[0].repeatCount).toBe(2);
    createHistoryRequest("sii_generate", { ordinal: 0 }, undefined, options)?.finish({ size: 1024 });
    createHistoryRequest("sii_generate", { ordinal: 0 }, undefined, options)?.finish(undefined, failure);
    createHistoryRequest("sii_generate", { ordinal: 0 }, undefined, { ...options, automatic: false })?.finish(undefined, failure);
    expect(messageHistory.snapshot().entries).toHaveLength(3);
  });
  it("takes cycle WKC from the fault event rather than an older I/O snapshot", () => {
    const message = cycleFaultHistory({ actual_wkc: 0, expected_wkc: 6, consecutive_errors: 10 });
    expect(message).toMatchObject({ text: "周期通信中断", reason: "连续异常 10 次", wkc: [{ label: "WKC", actual: 0, expected: 6 }] });
    expect(cycleFaultHistory("从站 1 已退出 OP")).toMatchObject({ reason: "从站 1 已退出 OP", wkc: [] });
    expect(cycleFaultHistory({ actual_wkc: 0 }).wkc).toEqual([]);
  });
});
