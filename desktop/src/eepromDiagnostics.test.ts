import { describe, expect, it } from "vitest";
import { decodeEepromPrefix, decodeEepromStatus } from "./eepromDiagnostics";

describe("EEPROM control/status decoding", () => {
  it("decodes 0x40C0 into the documented bit order", () => {
    const result = decodeEepromStatus(0x40C0)!;
    expect(result.binary).toBe("0100 0000 1100 0000");
    expect(result.summary.map((field) => `${field.bits}|${field.name}|${field.binary}|${field.description}`)).toEqual([
      "7|EEPROM Algorithm|1|2-byte address",
      "5|EEPROM Emulation|0|Physical I²C EEPROM",
      "3|EEPROM Availability|0|Present",
      "11|Checksum Error|0|Checksum OK",
      "12|Loading Status|0|EEPROM loaded",
    ]);
    // The capacity range belongs to the addressing algorithm itself.
    expect(result.summary[0].detail).toBe("32 Kbit ~ 4 Mbit EEPROM");
    expect(result.summary[1].detail).toBeUndefined();
  });

  it("keeps the error outside the summary visible in the full decode", () => {
    const result = decodeEepromStatus(0x40C0)!;
    expect(result.fields.find((field) => field.bits === "14")).toMatchObject({ binary: "1", error: true });
    expect(result.summary.some((field) => field.bits === "14")).toBe(false);
  });

  it("lists only documented bits, so no row carries an empty value or description", () => {
    for (const value of [0x0000, 0x0010, 0x0006, 0x40c0, 0xffff]) {
      const fields = decodeEepromStatus(value)!.fields;
      expect(fields.map((field) => field.bits)).toEqual(["15", "14", "13", "12", "11", "10:8", "7", "6", "5", "3", "0"]);
      expect(fields.every((field) => field.binary.length > 0 && Boolean(field.description))).toBe(true);
    }
  });

  it("keeps loading status separate from busy and shows every command encoding", () => {
    const fields = decodeEepromStatus(0x1008)!.fields;
    expect(fields.find((field) => field.bits === "12")?.description).toBe("EEPROM not loaded");
    expect(fields.find((field) => field.bits === "15")?.description).toBe("Idle");
    expect(fields.find((field) => field.bits === "3")?.description).toBe("Not present");
    expect(fields.find((field) => field.bits === "7")?.description).toBe("1-byte address");
    expect(fields.find((field) => field.bits === "7")?.detail).toBe("1 Kbit ~ 16 Kbit EEPROM");
    for (let command = 0; command < 8; command++) {
      expect(decodeEepromStatus(command << 8)!.fields.find((field) => field.bits === "10:8")?.binary).toBe(command.toString(2).padStart(3, "0"));
    }
  });

  it("does not manufacture zero values from missing or invalid data", () => {
    for (const value of [null, undefined, -1, 65536, NaN]) expect(decodeEepromStatus(value)).toBeUndefined();
    expect(decodeEepromStatus(0)?.raw).toBe("0x0000");
  });
});

const PREFIX = "8D 0E 03 44 88 13 00 00 00 00 00 00 00 00 E4 00";

describe("EEPROM configuration prefix decoding", () => {
  it("summarises the two configuration bytes an operator compares with the ESI file", () => {
    const result = decodeEepromPrefix(PREFIX, "LAN9252")!;
    expect(result.rows.map((row) => `${row.register}|${row.name}|${row.value}|${row.headline}`)).toEqual([
      "0x0140|PDI Control|0x8D|HBI Index 16bit",
      "0x0150|PDI Configuration|0x03|",
    ]);
    expect(result.raw).toBe(PREFIX);
    expect(result.pdiControl).toBe("0x8D");
  });

  it("lists one row per documented word with its 16-bit value and a one-line decode", () => {
    const result = decodeEepromPrefix(PREFIX, "LAN9252")!;
    expect(result.words.map((row) => `${row.word}|${row.value}`)).toEqual([
      "0x0000|0x0E8D",
      "0x0001|0x4403",
      "0x0002|0x1388",
      "0x0003|0x0000",
      "0x0004|0x0000",
      "0x0005|0x0000",
      "0x0007|0x00E4",
    ]);
  });

  it("decodes word 0x0000 as the PDI type plus the ESC configuration flags", () => {
    const row = decodeEepromPrefix(PREFIX, "LAN9252")!.words[0];
    expect(row.parse).toBe(
      "0x8D：PDI = HBI Index 16bit；0x0E：Device Emulation=0、Enhanced Link Detection All Ports=1、DC SYNC Out=1、DC Latch In=1、Enhanced Link Port 0=0、Enhanced Link Port 1=0、Enhanced Link Port 2=0",
    );
  });

  it("names the SYNC driver polarity for both SYNC units", () => {
    const row = decodeEepromPrefix(PREFIX, "LAN9252")!.words[1];
    expect(row.parse).toContain("0x44：SYNC0，Push-pull active low、SYNC1，Push-pull active low");
    expect(row.parse).toContain("SYNC0/LATCH0=SYNC output");
    expect(row.parse).toContain("SYNC1/LATCH1=SYNC output");
  });

  it("converts the sync impulse length into a pulse width", () => {
    expect(decodeEepromPrefix(PREFIX)!.words[2].parse).toBe("0x1388 = 5000，SYNC脉宽 50us");
    const short = decodeEepromPrefix("00 00 00 00 64 00 00 00 00 00 00 00 00 00 00 00")!;
    expect(short.words[2].parse).toBe("0x0064 = 100，SYNC脉宽 1us");
  });

  it("states when a zeroed word carries no configuration", () => {
    const words = decodeEepromPrefix(PREFIX)!.words;
    expect(words[3].parse).toBe("扩展 PDI 配置为 0，无额外配置");
    expect(words[4].parse).toBe("Station Alias = 0，未预设固定别名地址");
    expect(words[5].parse).toBe("ESC 扩展配置，全部为默认值 0");
    const aliased = decodeEepromPrefix("00 00 00 00 00 00 00 00 05 00 00 00 00 00 00 00")!;
    expect(aliased.words[4].parse).toBe("Station Alias = 5");
  });

  it("shows the checksum as read, without claiming a verdict", () => {
    expect(decodeEepromPrefix(PREFIX)!.words[6]).toMatchObject({ word: "0x0007", value: "0x00E4", parse: "CRC校验 = 0xE4" });
  });

  it("never lists the fully reserved word 0x0006", () => {
    expect(decodeEepromPrefix(PREFIX)!.words.map((row) => row.word)).not.toContain("0x0006");
  });

  it("falls back to a neutral marker for an unpublished PDI type", () => {
    const unknown = decodeEepromPrefix(PREFIX.replace("8D", "7F"))!;
    expect(unknown.rows[0].headline).toBe("含义未收录");
    expect(unknown.words[0].parse).toContain("PDI = 含义未收录");
  });

  it("names enhanced link ports 1 and 2 only where the ESC family defines them", () => {
    // ET1100 documentation stops at bit 4, so its decode lists five flags.
    const et = decodeEepromPrefix(PREFIX, "ET1100")!.words[0].parse;
    expect(et).not.toContain("Enhanced Link Port 1");
    expect(et.split("、")).toHaveLength(5);
    for (const family of ["LAN9252", "LAN9253"] as const) {
      const parse = decodeEepromPrefix(PREFIX, family)!.words[0].parse;
      expect(parse).toContain("Enhanced Link Port 2=0");
      expect(parse.split("、")).toHaveLength(7);
    }
  });

  it("keeps the PDI configuration drivers in the word 0x0001 decode", () => {
    const parse = decodeEepromPrefix(PREFIX)!.words[1].parse;
    expect(parse).toContain("BUSY output driver / polarity = Open source (active high)");
    expect(parse).toContain("Read BUSY delay = Delayed read BUSY output");
  });

  it("rejects anything that is not the sixteen-byte prefix", () => {
    expect(decodeEepromPrefix(null)).toBeUndefined();
    expect(decodeEepromPrefix(PREFIX.slice(3))).toBeUndefined();
    expect(decodeEepromPrefix(PREFIX.replace("8D", "XX"))).toBeUndefined();
  });
});
