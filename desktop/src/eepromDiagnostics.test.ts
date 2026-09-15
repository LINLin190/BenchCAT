import { describe, expect, it } from "vitest";
import { decodeEepromPrefix, decodeEepromStatus } from "./eepromDiagnostics";

describe("EEPROM overview decoding", () => {
  it("decodes 0x40C0 and preserves the error outside the five summary fields", () => {
    const result = decodeEepromStatus(0x40C0)!;
    expect(result.binary).toBe("0100 0000 1100 0000");
    expect(result.summary.map((field) => field.description)).toEqual([
      "2-byte address", "Physical I²C EEPROM", "Present", "Checksum OK", "EEPROM loaded",
    ]);
    expect(result.fields.find((field) => field.bits === "14")).toMatchObject({ value: "1", error: true });
    expect(result.fields).toHaveLength(13);
  });
  it("keeps loading status separate from busy and shows every command encoding", () => {
    const fields = decodeEepromStatus(0x1008)!.fields;
    expect(fields.find((field) => field.bits === "12")?.description).toBe("EEPROM not loaded");
    expect(fields.find((field) => field.bits === "15")?.description).toBe("Idle");
    expect(fields.find((field) => field.bits === "3")?.description).toBe("Not present");
    for (let command = 0; command < 8; command++) {
      expect(decodeEepromStatus(command << 8)!.fields.find((field) => field.bits === "10:8")?.value).toBe(command.toString(2).padStart(3, "0"));
    }
  });
  it("decodes exactly eight little-endian words, including zero and checksum", () => {
    const result = decodeEepromPrefix("8D 0E 03 44 88 13 00 00 00 00 00 00 00 00 E4 00")!;
    expect(result.words.map((word) => word.value)).toEqual(["0x0E8D", "0x4403", "0x1388", "0x0000", "0x0000", "0x0000", "0x0000", "0x00E4"]);
    expect(result.words[7].address).toBe("0x0007");
    expect(decodeEepromPrefix(result.raw.slice(3))).toBeUndefined();
    expect(decodeEepromPrefix(result.raw.replace("8D", "XX"))).toBeUndefined();
  });
  it("does not manufacture zero values from missing or invalid data", () => {
    for (const value of [null, undefined, -1, 65536, NaN]) expect(decodeEepromStatus(value)).toBeUndefined();
    expect(decodeEepromPrefix(null)).toBeUndefined();
    expect(decodeEepromStatus(0)?.raw).toBe("0x0000");
  });
});
