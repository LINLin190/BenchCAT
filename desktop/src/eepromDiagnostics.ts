import { hexWord } from "./eepromConfig";

// EEPROM Control/Status, 0x0502–0x0503. Values are decoded from one 16-bit read.
const statusFields = [
  [15, 1, "Busy", ["Idle", "Busy"]],
  [14, 1, "Write Enable Error", ["No error", "Error"]],
  [13, 1, "ACK/Command Error", ["No error", "Error"]],
  [12, 1, "Loading Status", ["EEPROM loaded", "EEPROM not loaded"]],
  [11, 1, "Checksum Error", ["Checksum OK", "Checksum error"]],
  [8, 3, "Command", ["Idle / No command", "Read", "Write", "Reserved / Invalid", "Reload", "Reserved / Invalid", "Reserved / Invalid", "Reserved / Invalid"]],
  [7, 1, "EEPROM Algorithm", ["1-byte address", "2-byte address"]],
  [6, 1, "Read Size", ["4 bytes", "8 bytes"]],
  [5, 1, "EEPROM Emulation", ["Physical I²C EEPROM", "PDI emulates EEPROM"]],
  [4, 1, "Reserved", ["—", "—"]],
  [3, 1, "EEPROM Availability", ["Present", "Not present"]],
  [1, 2, "Reserved", ["—", "—", "—", "—"]],
  [0, 1, "ECAT Write Enable", ["Writes disabled", "Writes enabled"]],
] as const;

export function decodeEepromStatus(value: number | null | undefined) {
  if (value == null || !Number.isInteger(value) || value < 0 || value > 0xFFFF) return undefined;
  const fields = statusFields.map(([shift, width, name, meanings]) => {
    const raw = (value >> shift) & ((1 << width) - 1);
    return { bits: width === 1 ? `${shift}` : `${shift + width - 1}:${shift}`, name,
      value: raw.toString(2).padStart(width, "0"), description: meanings[raw],
      error: [14, 13, 12, 11, 3].includes(shift) && raw !== 0 };
  });
  return { raw: hexWord(value), binary: value.toString(2).padStart(16, "0").match(/.{4}/g)!.join(" "), fields,
    summary: [7, 5, 3, 11, 12].map((bit) => fields.find((field) => field.bits === `${bit}`)!) };
}

const wordNames = [
  "PDI Control + ESC Configuration", "PDI Configuration + Sync/Latch Configuration",
  "SyncImpulseLen", "PDI Configuration 2 / Extended PDI Config", "Configured Station Alias",
  "Reserved", "Reserved", "Configuration checksum",
];

export function decodeEepromPrefix(raw: string | null | undefined) {
  const parts = raw?.trim().split(/\s+/);
  if (!parts || parts.length !== 16 || parts.some((part) => !/^[\da-f]{2}$/i.test(part))) return undefined;
  const bytes = parts.map((part) => parseInt(part, 16));
  return { raw: parts.join(" ").toUpperCase(), words: wordNames.map((name, index) => ({
    address: hexWord(index), bytes: parts.slice(index * 2, index * 2 + 2).join(" ").toUpperCase(),
    value: hexWord(bytes[index * 2] | (bytes[index * 2 + 1] << 8)), name,
  })) };
}
