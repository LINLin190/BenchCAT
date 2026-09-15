import { hexWord, pdiMeaning } from "./eepromConfig";

// EEPROM Control/Status, 0x0502–0x0503. Every value is decoded from one 16-bit read.
// Only bits with a documented definition are listed: a reserved bit would add a row whose
// Value and Description cells are both empty.
const statusBits = [
  [15, 1, "Busy", ["Idle", "Busy"]],
  [14, 1, "Write Enable Error", ["No error", "Error"]],
  [13, 1, "ACK/Command Error", ["No error", "Error"]],
  [12, 1, "Loading Status", ["EEPROM loaded", "EEPROM not loaded"]],
  [11, 1, "Checksum Error", ["Checksum OK", "Checksum error"]],
  [8, 3, "Command", ["Idle / No command", "Read", "Write", "Reserved / Invalid", "Reload", "Reserved / Invalid", "Reserved / Invalid", "Reserved / Invalid"]],
  [7, 1, "EEPROM Algorithm", ["1-byte address", "2-byte address"]],
  [6, 1, "Read Size", ["4 bytes", "8 bytes"]],
  [5, 1, "EEPROM Emulation", ["Physical I²C EEPROM", "PDI emulates EEPROM"]],
  [3, 1, "EEPROM Availability", ["Present", "Not present"]],
  [0, 1, "ECAT Write Enable", ["Writes disabled", "Writes enabled"]],
] as const;

/** Summary rows follow the documented bit order, so the card reads like the register. */
const summaryBits = [7, 5, 3, 11, 12];
/** Fault bits: a non-zero value is an error the operator must see, not just a state. */
const errorBits = [15, 14, 13, 12, 11, 3];

interface StatusField {
  bits: string;
  shift: number;
  name: string;
  binary: string;
  description: string;
  detail?: string;
  error: boolean;
  summary: boolean;
}

export interface EepromStatus {
  raw: string;
  binary: string;
  fields: StatusField[];
  summary: StatusField[];
}

function statusField(shift: number, width: number, name: string, descriptions: readonly string[], value: number): StatusField {
  const raw = (value >> shift) & ((1 << width) - 1);
  // The capacity range is the actionable half of the addressing algorithm.
  const detail = shift === 7 ? (raw ? "32 Kbit ~ 4 Mbit EEPROM" : "1 Kbit ~ 16 Kbit EEPROM") : undefined;
  return {
    bits: width === 1 ? `${shift}` : `${shift + width - 1}:${shift}`,
    shift,
    name,
    binary: raw.toString(2).padStart(width, "0"),
    description: descriptions[raw],
    detail,
    error: errorBits.includes(shift) && raw !== 0,
    summary: summaryBits.includes(shift),
  };
}

export function decodeEepromStatus(value: number | null | undefined): EepromStatus | undefined {
  if (value == null || !Number.isInteger(value) || value < 0 || value > 0xFFFF) return undefined;
  const fields = statusBits.map(([shift, width, name, descriptions]) =>
    statusField(shift, width, name, descriptions, value));
  return {
    raw: hexWord(value),
    binary: value.toString(2).padStart(16, "0").match(/.{4}/g)!.join(" "),
    fields,
    summary: summaryBits
      .map((shift) => fields.find((field) => field.shift === shift)!)
      .filter(Boolean),
  };
}

// EEPROM configuration area, words 0x0000–0x0007 (the first 16 bytes of SII).
// Byte order is little endian: the low byte of a word is at the lower byte offset.
export interface EepromBitsField {
  bits: string;
  name: string;
  value: string;
  meaning: string;
}

/** One row of the default prefix summary: the configuration byte an operator compares against
 *  the ESI file. Only the bytes that carry a decision are listed. */
export interface EepromConfigRow {
  /** ESC register address of the byte, e.g. 0x0140. */
  register: string;
  name: string;
  /** Raw byte value taken straight from the prefix, e.g. 0x8D. */
  value: string;
  /** Decoded meaning; empty when the byte has no single headline meaning. */
  headline: string;
}

/** One row of the full prefix decode: word address, its 16-bit value, one-line decode. */
export interface EepromWordRow {
  word: string;
  value: string;
  parse: string;
}

export type EepromFamily = "ET1100" | "LAN9252" | "LAN9253";

/** Decodes a byte (or a wider field) selected by a consecutive bit range. */
function bitsOf(byte: number, high: number, low: number) {
  const width = high - low + 1;
  return { value: (byte >> low) & ((1 << width) - 1), width };
}

function field(bits: string, name: string, descriptions: readonly string[], byte: number): EepromBitsField {
  const [high, low = high] = bits.split(":").map(Number);
  const { value, width } = bitsOf(byte, high, low);
  return {
    bits,
    name,
    value: width === 1 ? `${value}` : value.toString(2).padStart(width, "0"),
    meaning: descriptions[value] ?? "含义未收录",
  };
}

// Word 0x0140 low byte. The PDI type comes from the shared vocabulary so that the
// overview and the EEPROM flashing pages can never disagree.
const PDI_CONTROL_FIELDS = (pdiCode: number): EepromBitsField[] => [
  { bits: "7:0", name: "Process data interface", value: pdiCode.toString(2).padStart(8, "0"), meaning: pdiMeaning(pdiCode) },
];

const ESC_CONFIGURATION_FIELDS = (value: number, extended: boolean): EepromBitsField[] => [
  field("0", "Device emulation", ["AL status set by PDI", "AL status set to AL Control value"], value),
  field("1", "Enhanced link detection", ["Disabled", "Enabled at all ports"], value),
  field("2", "Distributed clocks SYNC unit", ["Disabled (power saving)", "Enabled"], value),
  field("3", "Distributed clocks latch unit", ["Disabled (power saving)", "Enabled"], value),
  field("4", "Enhanced link port 0", ["Disabled", "Enabled"], value),
  // ET1100 documentation stops at bit 4; only the LAN925x family documents ports 1 and 2.
  ...(extended ? [
    field("5", "Enhanced link port 1", ["Disabled", "Enabled"], value),
    field("6", "Enhanced link port 2", ["Disabled", "Enabled"], value),
  ] : []),
];

const PDI_CONFIGURATION_FIELDS = (value: number): EepromBitsField[] => [
  field("1:0", "BUSY output driver / polarity", ["Push-pull active low", "Open drain (active low)", "Push-pull active high", "Open source (active high)"], value),
  field("4", "BHE / byte enable polarity", ["Active low", "Active high"], value),
  field("0", "Read BUSY delay", ["Normal read BUSY output", "Delayed read BUSY output"], value),
  field("7", "RD polarity", ["Active low", "Active high"], value),
];

const SYNC_LATCH_FIELDS = (value: number): EepromBitsField[] => [
  field("1:0", "SYNC0/2 output driver / polarity", ["Push-pull active low", "Open drain (active low)", "Push-pull active high", "Open source (active high)"], value),
  field("2", "SYNC0/LATCH0 configuration", ["LATCH input", "SYNC output"], value),
  field("3", "SYNC0/2 mapped to AL event", ["Disabled", "Enabled"], value),
  field("5:4", "SYNC1/3 output driver / polarity", ["Push-pull active low", "Open drain (active low)", "Push-pull active high", "Open source (active high)"], value),
  field("6", "SYNC1/LATCH1 configuration", ["LATCH input", "SYNC output"], value),
  field("7", "SYNC1/3 mapped to AL event", ["Disabled", "Enabled"], value),
];

/** ESC configuration A0 bit labels, in the order the public datasheets list them. */
const ESC_FLAG_NAMES = [
  "Device Emulation",
  "Enhanced Link Detection All Ports",
  "DC SYNC Out",
  "DC Latch In",
  "Enhanced Link Port 0",
  "Enhanced Link Port 1",
  "Enhanced Link Port 2",
] as const;

const driverText = (fields: EepromBitsField[], bits: string, port: string) =>
  `${port}，${fields.find((item) => item.bits === bits)?.meaning ?? ""}`;

/** Compact flag list, e.g. `Enhanced Link Detection All Ports=1、DC SYNC Out=1`. */
const flagText = (value: number, extended: boolean) => {
  const limit = extended ? 7 : 5;
  return Array.from({ length: limit }, (_, bit) => `${ESC_FLAG_NAMES[bit]}=${(value >> bit) & 1}`).join("、");
};

/**
 * Decodes the first 16 EEPROM bytes (SII words 0x0000–0x0007). The `family` selects the
 * ESC-specific bit definitions of word 0x0141: ET1100 documentation stops at bit 4, while
 * LAN9252/LAN9253 also document enhanced link ports 1 and 2.
 */
export function decodeEepromPrefix(raw: string | null | undefined, family: EepromFamily = "ET1100") {
  const parts = raw?.trim().split(/\s+/);
  if (!parts || parts.length !== 16 || parts.some((part) => !/^[\da-f]{2}$/i.test(part))) return undefined;
  const bytes = parts.map((part) => parseInt(part, 16));
  const word = (index: number) => bytes[index * 2] | (bytes[index * 2 + 1] << 8);
  const wordValue = (index: number) => hexWord(word(index));
  const byteText = (index: number) => `0x${bytes[index].toString(16).toUpperCase().padStart(2, "0")}`;
  const pdiCode = bytes[0];
  const extended = family !== "ET1100";

  const pdiFields = PDI_CONTROL_FIELDS(pdiCode);
  const escFields = ESC_CONFIGURATION_FIELDS(bytes[1], extended);
  const pdiConfigFields = PDI_CONFIGURATION_FIELDS(bytes[2]);
  const syncFields = SYNC_LATCH_FIELDS(bytes[3]);

  // Default summary: the two bytes the operator compares against the ESI file, shown with the
  // value of the byte itself rather than the enclosing 16-bit word.
  const rows: EepromConfigRow[] = [
    { register: "0x0140", name: "PDI Control", value: byteText(0), headline: pdiFields[0].meaning },
    { register: "0x0150", name: "PDI Configuration", value: byteText(2), headline: "" },
  ];

  // Full decode of the prefix; word 0x0006 is fully reserved and is not listed.
  const words: EepromWordRow[] = [
    { word: hexWord(0), value: wordValue(0), parse: `${byteText(0)}：PDI = ${pdiFields[0].meaning}；${byteText(1)}：${flagText(bytes[1], extended)}` },
    {
      word: hexWord(1),
      value: wordValue(1),
      parse: `${byteText(2)}：PDI 接口配置（${pdiConfigFields.map((item) => `${item.name} = ${item.meaning}`).join("；")}）；` +
        `${byteText(3)}：${driverText(syncFields, "1:0", "SYNC0")}、${driverText(syncFields, "5:4", "SYNC1")}，` +
        `SYNC0/LATCH0=${syncFields.find((item) => item.bits === "2")?.meaning}，SYNC1/LATCH1=${syncFields.find((item) => item.bits === "6")?.meaning}`,
    },
    // Sync impulse length counts 10 ns units, so the pulse width is the value times 10 ns.
    { word: hexWord(2), value: wordValue(2), parse: `${wordValue(2)} = ${word(2)}，SYNC脉宽 ${(word(2) * 10) / 1000}us` },
    { word: hexWord(3), value: wordValue(3), parse: word(3) === 0 ? "扩展 PDI 配置为 0，无额外配置" : `扩展 PDI 配置 = ${wordValue(3)}` },
    { word: hexWord(4), value: wordValue(4), parse: word(4) === 0 ? "Station Alias = 0，未预设固定别名地址" : `Station Alias = ${word(4)}` },
    { word: hexWord(5), value: wordValue(5), parse: word(5) === 0 ? "ESC 扩展配置，全部为默认值 0" : `ESC 扩展配置 = ${wordValue(5)}` },
    // The checksum is shown as read; verifying it would require the ESC CRC-8 definition.
    { word: hexWord(7), value: wordValue(7), parse: `CRC校验 = ${byteText(14)}` },
  ];

  return {
    raw: parts.join(" ").toUpperCase(),
    family,
    pdiCode,
    pdiControl: byteText(0),
    rows,
    words,
  };
}
