import { describe, expect, it } from "vitest";
import { decodeRegisterFields, definitionKey, encodeRegisterInput, formatRegisterValue, hasReadSideEffects, parseRegisterAddress, registerMeaning } from "./registerValues";
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
  it.each(["0x10000", "-1", "0x", "GG", "12 34"])("rejects invalid or overflowing scalar input %s", (input) => {
    expect(encodeRegisterInput(input, 2, "hex")).toBeUndefined();
  });
  it("keeps decimal and byte modes unambiguous", () => {
    expect(encodeRegisterInput("0x10", 2, "decimal")).toBeUndefined();
    expect(encodeRegisterInput("34 12", 2, "bytes")).toBe("3412");
    expect(encodeRegisterInput("12", 2, "bytes")).toBeUndefined();
    expect(encodeRegisterInput("1", 9, "hex")).toBeUndefined();
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
  it("shows the state name and error flag beside one decoded value", () => {
    expect(registerMeaning(status, "12 00")).toBe("PRE-OP · ERROR");
    const fields = decodeRegisterFields(status, "12 00");
    expect(fields[0].meaning).toBe("PRE-OP");
    expect(fields[1]).toMatchObject({ value: 1n, meaning: "Has error" });
    expect(fields[2].reserved).toBe(true);
  });
  it("recognizes field-level ECAT acknowledgements even under a plain RO register", () => {
    expect(hasReadSideEffects(status)).toBe(true);
    expect(hasReadSideEffects({ ...status, fields: [{ bits: "0", name: "PDI acknowledgement", ecat_access: "RO", read_semantics: "PDI reading acknowledges events" }] })).toBe(false);
  });
  it("does not apply AL decoding to the matching local address", () => {
    expect(registerMeaning({ ...status, address_space: "system_csr" }, "12 00")).toBe("");
  });
});
