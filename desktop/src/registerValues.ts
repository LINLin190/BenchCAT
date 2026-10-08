import { alStatusInfo } from "./alStatus";
import { hex, stateLabel, type RegisterDefinition, type RegisterManualReference } from "./types";

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
  if (!(format === "hex" ? /^(?:0x)?[\da-f]+$/i : /^\d+$/).test(text)) return undefined;
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

/** Decode each documented field beside its value, including reserved rows. */
export function decodeRegisterFields(definition: RegisterDefinition, data: string): DecodedRegisterField[] {
  const value = registerNumber(data);
  return (definition.fields ?? []).flatMap((field) => {
    const match = /^(\d+)(?::(\d+))?$/.exec(field.bits);
    if (!match) return [];
    const high = Number(match[1]), low = Number(match[2] ?? match[1]);
    const shift = Math.min(high, low), width = Math.abs(high - low) + 1;
    if (shift + width > registerWidth(definition) * 8) return [];
    const fieldValue = (value >> BigInt(shift)) & ((1n << BigInt(width)) - 1n);
    // Binary patterns are explicit in the catalog; decimal values keep decimal semantics.
    const enumeration = field.enum_values?.find((entry) => /^(?:0x[\da-f]+|0b[01]+|\d+)$/i.test(entry.value) && BigInt(entry.value) === fieldValue);
    const meaning = definition.address === 0x0130 && shift === 0 && width === 4
      ? stateLabel(Number(fieldValue)) : enumeration?.meaning ?? field.description ?? "";
    return [{ bits: field.bits, name: field.reserved ? "保留" : field.name, value: fieldValue, meaning, reserved: Boolean(field.reserved), access: field.ecat_access ?? "", shift, width }];
  });
}

/** Manual acquisition includes memory policy as well as master-side acknowledgements. */
export function requiresManualRead(definition: RegisterDefinition): boolean {
  if (definition.requires_manual_read !== undefined) return definition.requires_manual_read;
  return Boolean(definition.read_side_effects?.length || /READ_SIDE_EFFECT|ACK_SEMANTIC/.test(definition.master_access ?? "")
    || definition.fields?.some((field) => /READ_SIDE_EFFECT|ACK_SEMANTIC/.test(field.ecat_access ?? "")));
}

/** Rank exact addresses before containing ranges, address prefixes and text matches. */
export function registerSearchText(definition: RegisterDefinition): string {
  return [definition.name, definition.official_name, definition.description, definition.group,
    registerDisplayName(definition), ...(definition.aliases ?? [])].join(" ").toLowerCase();
}

export function registerSearchRank(definition: RegisterDefinition, input: string, searchText?: string): number {
  const text = input.trim().toLowerCase();
  if (!text) return 0;
  const range = /^(0x[\da-f]+|[\da-f]+)\s*[-~～]\s*(0x[\da-f]+|[\da-f]+)$/i.exec(text);
  if (range) {
    const start = parseRegisterAddress(range[1]), end = parseRegisterAddress(range[2]);
    return start !== undefined && end !== undefined && start <= end && definition.address <= end && definition.address + registerWidth(definition) > start ? 0 : Infinity;
  }
  const address = parseRegisterAddress(text);
  if (address !== undefined) {
    if (address === definition.address) return 0;
    if (address > definition.address && address < definition.address + registerWidth(definition)) return 1;
    // Normalize leading zeros so 14, 014 and 0x0014 share the same address prefix.
    if (definition.address.toString(16).startsWith(address.toString(16))) return 2;
  }
  return (searchText ?? registerSearchText(definition)).includes(text) ? 3 : Infinity;
}

/** Keep boolean searches consistent with the list's address relevance ordering. */
export function matchesRegisterSearch(definition: RegisterDefinition, input: string): boolean {
  return Number.isFinite(registerSearchRank(definition, input));
}

/** Keep common diagnostic labels concise while retaining the official name in details. */
export function registerDisplayName(definition: RegisterDefinition): string {
  if (definition.address_space === "user_ram") return `用户 RAM ${definition.address_text ?? ""}`;
  // Inclusive range labels follow the actual read width, including four-byte RAM windows.
  if (definition.address_space === "process_ram") return `RAM ${hex(definition.address)}-${hex(definition.address + registerWidth(definition) - 1)}`;
  if (definition.address_space !== "esc_core") return definition.name.replace(/\s+Register\s*$/i, "");
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
    0x0020: "寄存器写使能", 0x0021: "寄存器写保护", 0x0030: "ESC 写使能", 0x0031: "ESC 写保护",
    0x0040: "ECAT 侧 ESC 复位", 0x0041: "PDI 侧 ESC 复位", 0x0100: "数据链路控制", 0x0108: "物理读写偏移",
    0x0138: "RUN 灯覆盖", 0x0139: "ERR 灯覆盖", 0x0140: "PDI 控制", 0x0141: "ESC 配置",
    0x0142: "ASIC 配置", 0x0150: "PDI 配置", 0x0151: "SYNC/LATCH 配置", 0x0152: "扩展 PDI 配置",
    0x0500: "EEPROM 控制权", 0x0501: "EEPROM PDI 访问状态", 0x0504: "EEPROM 地址", 0x0508: "EEPROM 数据",
    0x0510: "MII 管理控制／状态", 0x0512: "PHY 地址", 0x0513: "PHY 寄存器地址", 0x0514: "PHY 数据",
    0x0516: "MII ECAT 访问状态", 0x0517: "MII PDI 访问状态",
    0x0900: "端口 0 接收时间", 0x0904: "端口 1 接收时间", 0x0908: "端口 2 接收时间", 0x090C: "端口 3 接收时间",
    0x0910: "系统时间", 0x0918: "处理单元接收时间", 0x0920: "系统时间偏移", 0x0928: "系统时间延迟",
    0x092C: "系统时间偏差", 0x0930: "速度计数起始值", 0x0932: "速度计数差值", 0x0934: "时间偏差滤波深度", 0x0935: "速度计数滤波深度",
    0x0980: "周期单元控制权", 0x0981: "SYNC 激活", 0x0982: "SYNC 脉冲长度", 0x0984: "SYNC 激活状态",
    0x098E: "SYNC0 状态", 0x098F: "SYNC1 状态", 0x0990: "周期启动时间", 0x0998: "下一 SYNC1 时间",
    0x09A0: "SYNC0 周期", 0x09A4: "SYNC1 周期", 0x09A8: "LATCH0 控制", 0x09A9: "LATCH1 控制",
    0x09AE: "LATCH0 状态", 0x09AF: "LATCH1 状态", 0x09B0: "LATCH0 正边沿时间", 0x09B8: "LATCH0 负边沿时间",
    0x09C0: "LATCH1 正边沿时间", 0x09C8: "LATCH1 负边沿时间", 0x09F0: "ECAT 缓冲交换时间", 0x09F8: "PDI 缓冲访问时间", 0x09FC: "PDI 缓冲交换时间",
    0x0E00: definition.source_chip === "ET1100" ? "上电引脚配置" : "产品标识", 0x0E08: "厂商标识",
    0x0F00: "数字 I/O 输出", 0x0F10: "通用输出", 0x0F18: "通用输入", 0x1000: "数字 I/O 输入",
  };
  // Channel offsets share names, while their actual channel identities stay distinct.
  if (definition.channel_kind === "FMMU") {
    const names: Record<number, string> = { 0: "逻辑起始地址", 4: "映射长度", 6: "逻辑起始位", 7: "逻辑结束位", 8: "物理起始地址", 10: "物理起始位", 11: "映射类型", 12: "激活", 13: "保留区域" };
    return `FMMU ${definition.channel_index} ${names[(definition.address - 0x600) % 16] ?? "配置"}`;
  }
  if (definition.channel_kind === "SyncManager") {
    const names: Record<number, string> = { 0: "起始地址", 2: "缓冲区长度", 4: "控制", 5: "状态", 6: "激活", 7: "PDI 控制" };
    return `SyncManager ${definition.channel_index} ${names[(definition.address - 0x800) % 8] ?? "配置"}`;
  }
  return labels[definition.address] ?? definition.name.replace(/\s+Register\s*$/i, "");
}

/** Keep permission codes in English and normalize equivalent source notations. */
export function registerAccessLabel(access?: string): string {
  const labels: Record<string, string> = { R: "RO", RO_READ_SIDE_EFFECT: "RO (ACK)", RO_WITH_ACK_SEMANTIC: "RO (ACK)",
    "NOT APPLICABLE": "N/A", "not applicable": "N/A",
    "indirect via MII/PHY management when ECAT owns the management interface": "INDIRECT",
    "indirect via MII/PHY management when PDI owns the management interface": "INDIRECT" };
  if (!access) return "not documented";
  if (access.startsWith("mixed:")) return "MIXED";
  return labels[access] ?? access;
}

/** Explain access codes on hover, including acknowledgements and conditional access. */
export function registerAccessDescription(access?: string): string {
  const descriptions: Record<string, string> = {
    RO: "可以读取，不能写入", RW: "可以读取和写入；遵循字段及访问条件", WO: "只能写入，不能读取",
    WAC: "可以读取；写入触发清除", W1C: "可以读取；写入 1 清除对应位，写入 0 不改变对应位",
    W1S: "可以读取；写入 1 置位对应位，写入 0 不改变对应位", MIXED: "按位定义，需要查看字段或访问条件",
    RW_CONDITIONAL: "有条件读写，需要满足文档注明的状态或硬件访问条件",
    "RO (ACK)": "可以读取，不能写入；读取会确认对应事件", NO_ACCESS: "该访问侧不可直接访问",
    "RW/W1C": "读写与写 1 清除语义并存，需要查看各字段定义", "N/A": "不适用",
    SELF_CLEARING: "写入触发命令，命令位由硬件自动清除", VOLATILE: "数值可能由硬件实时更新",
    "not documented": "文档未注明",
  };
  if (access?.startsWith("indirect via")) return access.includes("ECAT owns")
    ? "主站取得 MII 管理权后，通过 MII/PHY 管理接口间接访问"
    : "PDI 取得 MII 管理权后，通过 MII/PHY 管理接口间接访问";
  return descriptions[registerAccessLabel(access)] ?? "访问含义见字段或访问条件说明";
}

/** Names identify the actual bundled document language and revision. */
export function registerManuals(definition: RegisterDefinition): RegisterManualReference[] {
  // Resolved references carry physical pages for each bundled document revision.
  if (definition.manuals) return definition.manuals;
  const chip = definition.source_chip;
  if (chip === "LAN9252") return [
    { filename: "microchip_lan9252_register_zh.pdf", title: "LAN9252 官方中文手册（DS00001909A_CN）" },
    { filename: "microchip_lan9252_register_en.pdf", title: "LAN9252 官方英文手册（DS00001909C）" },
  ];
  if (chip === "LAN9253") return [{ filename: "microchip_lan9253_register_en.pdf", title: "LAN9253 官方英文手册（DS00003421B）" }];
  return [
    { filename: "beckhoff_esc_register_en.pdf", title: "Beckhoff ESC 寄存器说明（英文，3.3）" },
    { filename: "beckhoff_et1100_datasheet_en.pdf", title: "ET1100 器件手册（英文，2.1，寄存器概览）" },
  ];
}

/** The common view follows the selected diagnostic registers and byte ranges. */
export function isCommonRegister(definition: RegisterDefinition): boolean {
  if (definition.address_space !== "esc_core") return false;
  const address = definition.address;
  return (address >= 0x0004 && address <= 0x0006)
    || (address >= 0x0110 && address <= 0x0111)
    || (address >= 0x0120 && address <= 0x0121)
    || (address >= 0x0130 && address <= 0x0131)
    || (address >= 0x0134 && address <= 0x0135)
    || address === 0x0140
    || (address >= 0x0300 && address <= 0x0307)
    || address === 0x030d
    || (address >= 0x0310 && address <= 0x0313)
    || (address >= 0x0440 && address <= 0x0441)
    || (address >= 0x0502 && address <= 0x0503)
    || address === 0x060c
    || address === 0x0805
    || address === 0x0806
    || (address >= 0x092c && address <= 0x092f)
    || address === 0x0981
    || (address >= 0x09a0 && address <= 0x09a3);
}
