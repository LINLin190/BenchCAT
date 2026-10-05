import { alStatusInfo } from "./alStatus";
import { stateLabel, type RegisterDefinition } from "./types";

export type ValueFormat = "hex" | "decimal" | "bytes";
export interface RegisterValue { position: number; address: number; data: string; wkc: number; duration_ms: number; timestamp: number }
export interface DecodedRegisterField { bits: string; name: string; value: bigint; meaning: string; reserved: boolean; access: string; shift: number; width: number }

/** Register identities include address space so local references never alias ESC values. */
export function definitionKey(definition: RegisterDefinition): string {
  return definition.definition_id ?? `${definition.address_space ?? "esc_core"}:${definition.address}:${registerWidth(definition)}`;
}

/** Widths in the catalog are byte counts, including multi-byte scalar registers. */
export function registerWidth(definition: RegisterDefinition): number {
  return definition.width ?? definition.size ?? 1;
}

/** Bare address digits remain hexadecimal, matching ESC documentation. */
export function parseRegisterAddress(input: string): number | undefined {
  const text = input.trim().replace(/^0x/i, "");
  if (!/^[\da-f]+$/i.test(text)) return undefined;
  const address = Number.parseInt(text, 16);
  return address <= 0xffff ? address : undefined;
}

/** Decode with bigint so 64-bit DC timestamps never lose precision. */
export function registerNumber(data: string): bigint {
  return data.trim().split(/\s+/).filter(Boolean).reduceRight((value, byte) => (value << 8n) | BigInt(`0x${byte}`), 0n);
}

/** Present scalars as numbers and retain byte display for larger memory ranges. */
export function formatRegisterValue(data: string, format: ValueFormat = "hex"): string {
  const bytes = data.trim().split(/\s+/).filter(Boolean);
  if (format === "bytes" || bytes.length > 8) return bytes.join(" ").toUpperCase();
  const value = registerNumber(data);
  return format === "decimal" ? value.toString() : `0x${value.toString(16).toUpperCase().padStart(bytes.length * 2, "0")}`;
}

/** Show the full register width in nibble groups, with the most significant bit first. */
export function formatRegisterBinary(data: string, width: number): string {
  return registerNumber(data).toString(2).padStart(width * 8, "0").match(/.{1,4}/g)?.join(" ") ?? "";
}

/** Convert a bounded unsigned number to little-endian bytes without truncation. */
export function encodeRegisterInput(input: string, width: number, format: ValueFormat): string | undefined {
  if (!Number.isInteger(width) || width < 1 || width > 256) return undefined;
  const text = input.trim();
  if (format === "bytes") {
    const bytes = text.replace(/\s+/g, "");
    return new RegExp(`^[\\da-f]{${width * 2}}$`, "i").test(bytes) ? bytes.toUpperCase() : undefined;
  }
  if (width > 8 || !(format === "hex" ? /^(?:0x)?[\da-f]+$/i : /^\d+$/).test(text)) return undefined;
  const value = BigInt(format === "hex" ? `0x${text.replace(/^0x/i, "")}` : text);
  if (value >= 1n << BigInt(width * 8)) return undefined;
  return Array.from({ length: width }, (_, index) => ((value >> BigInt(index * 8)) & 0xffn).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Common diagnostics are intentionally short; full field meanings live in the inspector. */
export function registerMeaning(definition: RegisterDefinition, data?: string): string {
  if (!data) return "";
  const value = registerNumber(data);
  if (definition.address_space !== "esc_core") return "";
  if (definition.address === 0x0130) return `${stateLabel(Number(value & 0xfn))}${value & 0x10n ? " · ERROR" : ""}${value & 0x40n ? " · WARNING" : ""}`;
  if (definition.address === 0x0134) return alStatusInfo(Number(value)).name;
  return "";
}

/** Decode each documented field beside its value, keeping reserved rows optional. */
export function decodeRegisterFields(definition: RegisterDefinition, data: string): DecodedRegisterField[] {
  const value = registerNumber(data);
  return (definition.fields ?? []).flatMap((field) => {
    const match = /^(\d+)(?::(\d+))?$/.exec(field.bits);
    if (!match) return [];
    const high = Number(match[1]), low = Number(match[2] ?? match[1]);
    const shift = Math.min(high, low), width = Math.abs(high - low) + 1;
    if (shift + width > registerWidth(definition) * 8) return [];
    const fieldValue = (value >> BigInt(shift)) & ((1n << BigInt(width)) - 1n);
    const enumeration = field.enum_values?.find((entry) => /^(?:0x[\da-f]+|\d+)$/i.test(entry.value) && BigInt(entry.value) === fieldValue);
    const meaning = definition.address === 0x0130 && shift === 0 && width === 4
      ? stateLabel(Number(fieldValue)) : enumeration?.meaning ?? field.description ?? "";
    return [{ bits: field.bits, name: field.name, value: fieldValue, meaning, reserved: Boolean(field.reserved), access: field.ecat_access ?? "", shift, width }];
  });
}

/** Master-side acknowledgements must not be inferred from a PDI-only description. */
export function hasReadSideEffects(definition: RegisterDefinition): boolean {
  if (definition.requires_manual_read !== undefined) return definition.requires_manual_read;
  return Boolean(definition.read_side_effects?.length || /READ_SIDE_EFFECT|ACK_SEMANTIC/.test(definition.master_access ?? "")
    || definition.fields?.some((field) => /READ_SIDE_EFFECT|ACK_SEMANTIC/.test(field.ecat_access ?? "")));
}

/** Search documented aliases, Chinese diagnostics, and overlapping address ranges. */
export function matchesRegisterSearch(definition: RegisterDefinition, input: string): boolean {
  const text = input.trim().toLowerCase();
  if (!text) return true;
  const range = /^(0x[\da-f]+|[\da-f]+)\s*[-~～]\s*(0x[\da-f]+|[\da-f]+)$/i.exec(text);
  if (range) {
    const start = parseRegisterAddress(range[1]), end = parseRegisterAddress(range[2]);
    return start !== undefined && end !== undefined && start <= end && definition.address <= end && definition.address + registerWidth(definition) > start;
  }
  const address = parseRegisterAddress(text);
  if (address !== undefined) return address >= definition.address && address < definition.address + registerWidth(definition);
  return [definition.name, definition.official_name, definition.description, definition.group,
    registerDisplayName(definition), ...(definition.aliases ?? [])].join(" ").toLowerCase().includes(text);
}

/** Keep common diagnostic labels concise while retaining the official name in details. */
export function registerDisplayName(definition: RegisterDefinition): string {
  const labels: Record<number, string> = {
    0x0000: "ESC 类型", 0x0001: "ESC 版本", 0x0002: "ESC 构建版本", 0x0004: "FMMU 数量",
    0x0005: "SyncManager 数量", 0x0006: "RAM 容量", 0x0007: "端口类型", 0x0008: "ESC 功能",
    0x0010: "配置站地址", 0x0012: "配置站别名", 0x0110: "链路状态", 0x0120: "AL 控制",
    0x0130: "AL 状态", 0x0134: "AL 状态码", 0x0200: "EtherCAT 事件掩码", 0x0204: "AL 事件掩码",
    0x0210: "EtherCAT 事件请求", 0x0220: "AL 事件请求", 0x030C: "EtherCAT 处理错误计数",
    0x0300: "端口 0 接收错误计数", 0x0302: "端口 1 接收错误计数", 0x0304: "端口 2 接收错误计数", 0x0306: "端口 3 接收错误计数",
    0x0308: "端口 0 转发错误计数", 0x0309: "端口 1 转发错误计数", 0x030A: "端口 2 转发错误计数", 0x030B: "端口 3 转发错误计数",
    0x0310: "端口 0 链路丢失计数", 0x0311: "端口 1 链路丢失计数", 0x0312: "端口 2 链路丢失计数", 0x0313: "端口 3 链路丢失计数",
    0x030D: "PDI 错误计数", 0x030E: "PDI 错误码", 0x0400: "看门狗分频", 0x0410: "PDI 看门狗时间",
    0x0420: "过程数据看门狗时间", 0x0440: "过程数据看门狗状态", 0x0442: "过程数据看门狗计数",
    0x0443: "PDI 看门狗计数", 0x0502: "EEPROM 控制／状态",
  };
  return labels[definition.address] ?? definition.name.replace(/\s+Register\s*$/i, "");
}

/** The default view contains a small diagnostic set, rather than every expanded channel. */
export function isCommonRegister(definition: RegisterDefinition): boolean {
  return definition.address_space === "esc_core" && [0x0000, 0x0001, 0x0010, 0x0110, 0x0120, 0x0130, 0x0134, 0x0300, 0x0302, 0x0308, 0x030c, 0x030d, 0x0310, 0x0311, 0x0440, 0x0442].includes(definition.address);
}
