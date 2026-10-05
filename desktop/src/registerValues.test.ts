import { describe, expect, it } from "vitest";
import { decodeRegisterFields, definitionKey, encodeRegisterInput, formatRegisterValue, requiresManualRead, matchesRegisterSearch, parseRegisterAddress, registerMeaning, registerManuals } from "./registerValues";
import type { RegisterDefinition } from "./types";

const status: RegisterDefinition = { address: 0x0130, address_space: "esc_core", width: 2, name: "AL status", group: "AL State Machine", access: "RO", description: "", fields: [
  { bits: "3:0", name: "State", ecat_access: "RO_READ_SIDE_EFFECT" },
  { bits: "4", name: "Error", enum_values: [{ value: "1", meaning: "Has error" }] },
  { bits: "15:7", name: "Reserved", reserved: true },
] };

describe("register numeric editing", () => {
  it("accepts a complete scalar and sends bytes in address order", () => {
    expect(encodeRegisterInput("0x1234", 2, "hex")).toBe("3412");
    expect(encodeRegisterInput("4660", 2, "decimal")).toBe("3412");
    expect(formatRegisterValue("34 12")).toBe("0x1234");
  });
  it("retains unsigned 64-bit precision in every scalar format", () => {
    const bytes = "EF CD AB 89 67 45 23 F1";
    expect(formatRegisterValue(bytes)).toBe("0xF123456789ABCDEF");
    expect(encodeRegisterInput("17375808098319191535", 8, "decimal")).toBe("EFCDAB89674523F1");
    expect(encodeRegisterInput("0xFFFFFFFFFFFFFFFF", 8, "hex")).toBe("FFFFFFFFFFFFFFFF");
  });
  // Raw numeric ranges must retain every bit through HEX and DEC input.
  it("supports whole unsigned values through the full 256-byte raw range", () => {
    expect(encodeRegisterInput("0x1234567890ABCDEF12", 9, "hex")).toBe("12EFCDAB9078563412");
    const maximum = (1n << 2048n) - 1n;
    expect(encodeRegisterInput(maximum.toString(), 256, "decimal")).toBe("FF".repeat(256));
    expect(encodeRegisterInput(`0x${maximum.toString(16)}`, 256, "hex")).toBe("FF".repeat(256));
    expect(encodeRegisterInput((maximum + 1n).toString(), 256, "decimal")).toBeUndefined();
  });
  it.each(["0x10000", "-1", "0x", "GG", "12 34"])("rejects invalid or overflowing scalar input %s", (input) => {
    expect(encodeRegisterInput(input, 2, "hex")).toBeUndefined();
  });
  it("keeps decimal and byte modes unambiguous", () => {
    expect(encodeRegisterInput("0x10", 2, "decimal")).toBeUndefined();
    expect(encodeRegisterInput("34 12", 2, "bytes")).toBe("3412");
    expect(encodeRegisterInput("12", 2, "bytes")).toBeUndefined();
    expect(encodeRegisterInput("1", 9, "hex")).toBe("01" + "00".repeat(8));
    expect(encodeRegisterInput("00 ".repeat(256), 256, "bytes")).toHaveLength(512);
  });
  it("does not confuse an ESC register with a local register at the same address", () => {
    expect(definitionKey(status)).not.toBe(definitionKey({ ...status, address_space: "system_csr" }));
  });
  it("bounds the hexadecimal address independently of scalar input", () => {
    expect(parseRegisterAddress("0130")).toBe(0x130);
    expect(parseRegisterAddress("0xFFFF")).toBe(0xffff);
    expect(parseRegisterAddress("10000")).toBeUndefined();
  });
});

describe("register interpretation", () => {
  // EEPROM command codes are bit patterns, while unprefixed enum values remain decimal.
  it("decodes binary EEPROM write/reload codes without changing decimal enums", () => {
    const command: RegisterDefinition = { ...status, address: 0x502, fields: [{ bits: "10:8", name: "Command", enum_values: [
      { value: "0b010", meaning: "Write" }, { value: "0b100", meaning: "Reload" }, { value: "3", meaning: "Decimal three" },
    ] }] };
    expect(decodeRegisterFields(command, "00 02")[0].meaning).toBe("Write");
    expect(decodeRegisterFields(command, "00 04")[0].meaning).toBe("Reload");
    expect(decodeRegisterFields(command, "00 03")[0].meaning).toBe("Decimal three");
  });
  // A selected chip must link its own offline manual, not the generic source template.
  it("selects local manuals by the actual source chip and labels their real language", () => {
    expect(registerManuals({ ...status, source_chip: "LAN9252" }).map((manual) => manual.filename)).toEqual([
      "microchip_lan9252_register_zh.pdf", "microchip_lan9252_register_en.pdf",
    ]);
    expect(registerManuals({ ...status, source_chip: "LAN9253" })[0].filename).toBe("microchip_lan9253_register_en.pdf");
  });
  it("shows the state name and error flag beside one decoded value", () => {
    expect(registerMeaning(status, "12 00")).toBe("PRE-OP · ERROR");
    const fields = decodeRegisterFields(status, "12 00");
    expect(fields[0].meaning).toBe("PRE-OP");
    expect(fields[1]).toMatchObject({ value: 1n, meaning: "Has error" });
    expect(fields[2].reserved).toBe(true);
  });
  it("recognizes field-level ECAT acknowledgements even under a plain RO register", () => {
    expect(requiresManualRead(status)).toBe(true);
    expect(requiresManualRead({ ...status, fields: [{ bits: "0", name: "PDI acknowledgement", ecat_access: "RO", read_semantics: "PDI reading acknowledges events" }] })).toBe(false);
  });
  it("does not apply AL decoding to the matching local address", () => {
    expect(registerMeaning({ ...status, address_space: "system_csr" }, "12 00")).toBe("");
  });
  it("uses the documented distinction between read acknowledgements and write-clear counters", () => {
    expect(requiresManualRead({ ...status, requires_manual_read: false })).toBe(false);
    expect(requiresManualRead({ ...status, fields: [], requires_manual_read: true })).toBe(true);
  });
});

describe("register search", () => {
  it("finds an interior byte and ranges overlapping a multi-byte register", () => {
    expect(matchesRegisterSearch(status, "0131")).toBe(true);
    expect(matchesRegisterSearch(status, "0x012F～0x0130")).toBe(true);
    expect(matchesRegisterSearch(status, "0132-0134")).toBe(false);
    expect(matchesRegisterSearch(status, "0134-0130")).toBe(false);
  });
  it("finds Chinese diagnostic labels and documented aliases", () => {
    expect(matchesRegisterSearch(status, "AL 状态")).toBe(true);
    expect(matchesRegisterSearch({ ...status, aliases: ["Application Layer Status"] }, "application layer")).toBe(true);
    expect(matchesRegisterSearch(status, "链路")).toBe(false);
  });
});
