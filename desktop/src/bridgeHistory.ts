import { alStatusInfo } from "./alStatus";
import { messageHistory, type MessageInput } from "./messageHistory";
import type { BridgeFailure } from "./operationStore";
import { currentAlCode, isSlaveStateHealthy, isSlaveStateUnknown } from "./slaveState";
import { stateLabel, type SlaveInfo, type WorkbenchStatus } from "./types";

export interface HistoryOptions {
  history?: boolean;
  automatic?: boolean;
  file?: string;
  device?: string;
  position?: number;
  address?: number;
  size?: number;
  data?: string;
  configBefore?: string;
  profileChange?: { from: string; to: string };
  adapterLabel?: string;
  operationId?: string;
}
const operations: Record<string, string> = {
  auto_scan: "扫描从站", scan: "扫描从站", enumerate_adapters: "刷新网卡", connect: "连接网卡", disconnect: "断开连接",
  read_states: "刷新状态", request_state: "状态请求", clear_error: "清除状态错误", recover: "故障恢复", reconfig: "重新配置",
  esi_load: "打开 XML", eeprom_bin_load: "打开 BIN", esi_config_save: "保存 XML", sii_generate: "准备烧录目标",
  eeprom_flash: "烧录 EEPROM", eeprom_restore: "恢复 EEPROM", eeprom_read: "读取 EEPROM", eeprom_backup: "导出 BIN",
  sdo_read: "SDO 读取", sdo_write: "SDO 写入", object_dictionary: "读取对象字典", pdo_mapping: "读取 PDO 映射",
  register_read: "寄存器读取", register_raw_read: "寄存器读取", register_raw_write: "寄存器写入",
  register_prepare_write: "寄存器写入", register_execute_write: "寄存器写入", register_snapshot: "寄存器读取",
  register_reset: "设备复位", start_cycle: "周期通信", stop_cycle: "周期通信", set_output: "设置输出", switch_mode: "切换模式",
};
const hex = (value: number, width = 4) => `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const textOf = (value: unknown) => typeof value === "string" ? value : "";
const reading = (label: string, actual: unknown, expected = 1): NonNullable<MessageInput["wkc"]> =>
  typeof actual === "number" && Number.isFinite(actual) ? [{ label, actual, expected }] : [];

export function observedStateLabel(slave: SlaveInfo): string {
  return isSlaveStateUnknown(slave) ? `未知状态${slave.raw_state == null ? "" : `(${hex(slave.raw_state & 0x0F, 2)})`}` : stateLabel(slave.state);
}
function stateText(slave: SlaveInfo): string {
  const code = currentAlCode(slave);
  const state = isSlaveStateUnknown(slave) && slave.raw_state == null ? "无法读取状态" : `当前 ${observedStateLabel(slave)}`;
  return `从站 ${slave.position} · ${state}${code ? ` · AL ${hex(code)}（${alStatusInfo(code).name}）` : ""}`;
}
function alReadings(slave: SlaveInfo): string[] {
  return [slave.raw_state != null ? `从站 ${slave.position}：AL Status 0x0130 = ${hex(slave.raw_state)}` : undefined,
    currentAlCode(slave) !== undefined ? `从站 ${slave.position}：AL Status Code 0x0134 = ${hex(currentAlCode(slave)!)}` : undefined].filter((item): item is string => Boolean(item));
}
interface HistoryError { message: string; code: string; failure?: BridgeFailure }

export function createHistoryRequest(method: string, params: Data, before?: WorkbenchStatus, options: HistoryOptions = {}) {
  if (options.history === false || !operations[method] || method === "enumerate_adapters" && options.history !== true
    || method === "register_snapshot" && options.history !== true && params.automatic !== false) return undefined;
  const position = Number(options.position ?? params.position ?? 0);
  const initialSlaves = before?.slaves.map(slave => ({ ...slave })) ?? [];
  const selected = initialSlaves.find(slave => slave.position === position);
  const path = textOf(options.file ?? params.path);
  const operation = method === "eeprom_flash" && path ? /\.xml$/i.test(path) ? "烧录 XML" : "烧录 BIN" : operations[method];
  const adapter = textOf(params.adapter ?? before?.adapter);
  const address = options.address ?? params.address;
  const context = [position > 0 ? `从站 ${position}` : undefined,
    path ? fileName(path) : undefined,
    address !== undefined ? `地址 ${hex(Number(address))}` : undefined,
    params.index !== undefined ? `对象 ${hex(Number(params.index))}:${hex(Number(params.subindex ?? 0), 2)}` : undefined,
    ["connect", "disconnect", "scan", "auto_scan", "enumerate_adapters"].includes(method) && adapter ? options.adapterLabel || adapter : undefined,
  ].filter(Boolean).join(" · ") || undefined;
  const baseDetails = [selected?.name ? `设备：${selected.name}` : undefined,
    path ? `文件路径：${path}` : undefined, options.device ? `Device：${options.device}` : undefined,
    options.size !== undefined || params.size !== undefined ? `长度：${options.size ?? params.size} B` : undefined,
    options.profileChange ? `寄存器型号：${options.profileChange.from} → ${options.profileChange.to}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const repeatKey = options.automatic ? `${before?.host_generation}:${before?.session_id}:${method}:${position}:${path}:${params.ordinal}` : undefined;
  const record = (input: Omit<MessageInput, "operation" | "context">, finalContext = context) => messageHistory.append({
    operation, context: finalContext, repeatKey, ...input,
    reason: finalContext && input.reason?.startsWith(`${finalContext} · `) ? input.reason.slice(finalContext.length + 3) : input.reason,
    details: [...new Set([...baseDetails, ...(input.reason && input.reason.length > 60 ? [input.reason] : []), ...(input.details ?? [])])]
      .filter(detail => detail !== input.reason || detail.length > 60),
  });
  let finished = false;
  return {
    finish(result?: unknown, error?: HistoryError, after?: WorkbenchStatus) {
      if (finished) return;
      finished = true;
      if (error?.code === "CANCELLED") return;
      const value = object(result);
      const finalSlaves = Array.isArray(result) && ["request_state", "read_states", "clear_error", "scan"].includes(method)
        ? result as SlaveInfo[] : after?.slaves ?? [];
      const observed = finalSlaves.find(slave => slave.position === position);
      if (method === "request_state") {
        const target = Number(params.state);
        const affected = position > 0 ? [position] : (initialSlaves.length ? initialSlaves : finalSlaves).map(slave => slave.position);
        let unknown = 0;
        const failures = affected.flatMap(item => {
          const slave = finalSlaves.find(slave => slave.position === item);
          // A failed command can only be described using its fresh response snapshot.
          if (!slave || error && error.code !== "STATE_REQUEST_FAILED") { unknown++; return [`从站 ${item} · 无法确认请求结果`]; }
          if (isSlaveStateUnknown(slave)) { unknown++; return [stateText(slave), ...alReadings(slave)]; }
          return isSlaveStateHealthy(slave) && slave.state === target ? [] : [stateText(slave), ...alReadings(slave)];
        });
        const failedCount = affected.filter(item => {
          const slave = finalSlaves.find(slave => slave.position === item);
          return slave && (!error || error.code === "STATE_REQUEST_FAILED") && !isSlaveStateUnknown(slave) && (!isSlaveStateHealthy(slave) || slave.state !== target);
        }).length;
        if (error || failures.length) {
          record({ result: failedCount || error && !unknown && error.failure?.operation_result !== "unknown" ? "error" : "warning",
            text: `${stateLabel(target)} 状态请求${unknown && !failedCount ? "未确认" : "失败"}`,
            reason: position > 0 ? failures[0] || error?.message : failedCount || unknown ? `未达到 ${failedCount} 个 · 未确认 ${unknown} 个` : error?.message,
            details: [...failures, ...(error ? [error.message] : [])] });
          return;
        }
      } else if (error) {
        const stateDetails = ["read_states", "clear_error", "recover", "reconfig"].includes(method)
          ? finalSlaves.filter(slave => (position === 0 || slave.position === position) && !isSlaveStateHealthy(slave)).flatMap(slave => [stateText(slave), ...alReadings(slave)]) : [];
        record({ result: error.failure?.operation_result === "unknown" ? "warning" : "error",
          text: `${operation}${error.failure?.operation_result === "unknown" ? "结果未确认" : "失败"}`, reason: error.message,
          details: [...stateDetails, `错误码：${error.code}`, ...(error.failure?.message && error.failure.message !== error.message ? [error.failure.message] : [])] });
        return;
      } else if (method === "scan" || method === "auto_scan") {
        const slaves = (method === "scan" ? array(result) : array(value.slaves)) as SlaveInfo[];
        const attempts = array(value.attempts).map(object);
        const failed = attempts.filter(attempt => attempt.error || attempt.disconnect_error);
        const abnormal = slaves.filter(slave => !isSlaveStateHealthy(slave) || slave.scan_errors?.length);
        if (failed.length || abnormal.length) {
          const adapters = array(value.adapters).map(object);
          const label = (name: unknown) => textOf(adapters.find(item => item.name === name)?.description) || textOf(name);
          record({ result: attempts.length > 0 && failed.length === attempts.length && !slaves.length ? "error" : "warning", text: "扫描发现异常",
            reason: [failed.length ? `${failed.length} 张网卡扫描异常` : "", abnormal.length ? `${abnormal.length} 个从站异常` : ""].filter(Boolean).join(" · "),
            details: [...failed.map(attempt => `网卡 ${label(attempt.adapter)}：${textOf(attempt.error)}${attempt.disconnect_error ? `；${attempt.disconnect_error}` : ""}`),
              ...abnormal.flatMap(slave => [stateText(slave), ...(slave.scan_errors ?? []).map(error => `从站 ${slave.position}：${error}`)])],
          }, method === "auto_scan" ? label(value.selected_adapter) || undefined : context);
          return;
        }
        if (!slaves.length) {
          record({ result: method === "auto_scan" && !array(value.adapters).length ? "error" : "warning",
            text: method === "auto_scan" && !array(value.adapters).length ? "未发现可用网卡" : "未扫描到从站" });
          return;
        }
      } else if (method === "read_states") {
        const abnormal = finalSlaves.filter(slave => !isSlaveStateHealthy(slave));
        if (abnormal.length) {
          record({ result: "warning", text: "从站状态异常", reason: `${abnormal.length} 个从站状态异常`, details: abnormal.flatMap(slave => [stateText(slave), ...alReadings(slave)]) });
          return;
        }
      } else if (["eeprom_flash", "eeprom_restore"].includes(method)) {
        const flash = object(value.result), comparison = object(flash.comparison);
        const reasons = [value.success === false ? textOf(flash.image_verification) || "回读与目标镜像不一致" : "",
          flash.reload_verified === false ? "复位后重新加载未确认" : "", flash.sii_valid === false ? "镜像 SII 解析异常" : "",
          flash.semantic_valid === false ? "镜像设备信息与所选 Device 不一致" : "",
          params.auto_reset === false ? "未复位 ESC，未确认新内容已加载" : ""].filter(Boolean);
        if (reasons.length) {
          record({ result: value.success === false ? "error" : "warning", text: value.success === false ? `${operation}失败` : "EEPROM 写入后存在异常", reason: reasons.join("；"),
            details: [textOf(flash.reload_error), comparison.equal === false ? `差异 ${comparison.differing_bytes} B；首次差异 ${comparison.first_difference}` : ""].filter(Boolean) });
          return;
        }
      } else if (method === "eeprom_read") {
        const comparison = object(value.comparison);
        if (value.sii_valid === false || comparison.equal === false) {
          record({ result: "warning", text: "EEPROM 数据异常", reason: value.sii_valid === false ? "SII 数据无法解析" : "与目标镜像不一致",
            details: [value.sii_valid === false ? textOf(value.sii_error) : "", comparison.equal === false ? `与目标镜像差异 ${comparison.differing_bytes} B` : ""].filter(Boolean) });
          return;
        }
      } else if (method === "register_snapshot") {
        if (value.cancelled === true) return;
        const errors = Object.entries(object(value.errors));
        if (errors.length || value.error) {
          record({ result: array(value.values).length ? "warning" : "error", text: "寄存器读取失败", reason: errors.length ? `${errors.length} 项读取失败` : textOf(value.error),
            details: [...errors.map(([key, error]) => `${key}：${error}`), ...(value.error ? [textOf(value.error)] : [])] });
          return;
        }
      } else if (method === "register_raw_write") {
        const readback = object(value.readback);
        if (value.write_wkc !== 1 || value.write_error || readback.wkc !== 1 || value.read_error) {
          const writeFailed = value.write_wkc !== 1 || Boolean(value.write_error);
          record({ result: "warning", text: writeFailed ? "寄存器写入未确认" : "寄存器写入后回读失败",
            reason: textOf(writeFailed ? value.write_error : value.read_error) || undefined,
            wkc: [...reading("写入 WKC", value.write_wkc), ...reading("回读 WKC", readback.wkc)],
            details: [params.data ? `写入值：${params.data}` : "", textOf(value.write_error), textOf(value.read_error), typeof readback.data === "string" ? `回读值：${readback.data}` : ""].filter(Boolean) });
          return;
        }
      } else if (method === "register_execute_write" || method === "sdo_write") {
        if (value.verified !== true) {
          record({ result: value.verified === false ? "error" : "warning", text: `${operation}${value.verified === false ? "回读不一致" : "结果未确认"}`,
            reason: textOf(value.conclusion) || (value.verified === false ? "写入值与回读值不一致" : "写入已返回，设备动作结果未确认"),
            wkc: method === "register_execute_write" ? reading("写入 WKC", value.fpwr_wkc) : undefined,
            details: [options.data || params.data || value.data ? `写入值：${options.data || params.data || value.data}` : "", typeof value.readback === "string" ? `回读值：${value.readback}` : ""].filter(Boolean) });
          return;
        }
      } else if (method === "register_read" || method === "register_raw_read") {
        if (value.wkc !== 1) { record({ result: "error", text: "寄存器读取失败", reason: typeof value.wkc === "number" ? undefined : "未返回 WKC", wkc: reading("读取 WKC", value.wkc) }); return; }
      } else if (method === "register_reset") {
        record({ result: "warning", text: "ESC 复位命令已发送", reason: "需要重新扫描总线" });
        return;
      } else if (["recover", "reconfig", "clear_error"].includes(method)) {
        if (!observed || !isSlaveStateHealthy(observed)) {
          record({ result: "warning", text: `${operation}后状态${!observed || isSlaveStateUnknown(observed) ? "未确认" : "异常"}`,
            reason: observed ? stateText(observed) : "无法读取从站状态", details: observed ? alReadings(observed) : [] });
          return;
        }
        if (method === "reconfig" && options.profileChange && options.profileChange.from !== options.profileChange.to) {
          record({ result: "warning", text: `ESC 型号切换为 ${options.profileChange.to}`,
            reason: `已完成重配置 · 原型号 ${options.profileChange.from}` });
          return;
        }
      }
      if (repeatKey) messageHistory.endRepeat(repeatKey);
    },
  };
}

export function cycleFaultHistory(data: unknown): MessageInput {
  const value = object(data);
  const wkc = typeof value.expected_wkc === "number" ? reading("WKC", value.actual_wkc, value.expected_wkc) : [];
  const reason = typeof value.consecutive_errors === "number" ? `连续异常 ${value.consecutive_errors} 次` : textOf(data) || textOf(value.message);
  return { operation: "周期通信", result: "error", text: "周期通信中断", reason: reason || undefined, wkc, details: reason.length > 60 ? [reason] : [] };
}
