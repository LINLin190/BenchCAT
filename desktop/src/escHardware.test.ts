import { describe, expect, it } from "vitest";
import { decodeEscHardware } from "./escHardware";

describe("ESC power-on decoding", () => {
  it("decodes ET1100 ports, including logical port 3 as the third port", () => {
    const result = decodeEscHardware("ET1100", "1E 62 00 00 00 00 00 00")!;
    expect(result.value).toBe("0x621E");
    expect(result.fields.find((field) => field.name === "P_CONF[2]")?.meaning).toBe("Port 3 · MII");
    expect(result.fields.find((field) => field.name === "P_CONF[3]")?.meaning).toBe("端口未启用");
    expect(result.fields.find((field) => field.name === "C25_SHI")?.meaning).toContain("20 ns");
    expect(result.fields.find((field) => field.name === "PHYAD_OFF")?.meaning).toContain("16");
    expect(result.fields.at(-1)?.reserved).toBe(true);
  });
  it.each(["LAN9252", "E252"])("decodes %s with the LAN9252 layout", (profile) => {
    const result = decodeEscHardware(profile, "34 12 52 92 36 00 00 00")!;
    expect(result.value).toBe("0x0000003692521234");
    expect(result.fields.find((field) => field.name === "Silicon Revision")?.value).toBe("0x1234");
    expect(result.fields.find((field) => field.name === "CHIPMODE")?.meaning).toContain("三端口下行");
    expect(result.fields.find((field) => field.name === "TX_SHIFT_STRAP")?.meaning).toBe("0 ns");
    expect(result.mismatch).toBe(false);
  });
  it("keeps 64-bit precision and decodes LAN9253 high strap bits", () => {
    const result = decodeEscHardware("LAN9253", "EF CD 53 92 A8 68 FE FF")!;
    expect(result.value).toBe("0xFFFE68A89253CDEF");
    expect(result.bytes.slice(4, 6)).toEqual(["A8", "68"]);
    expect(result.fields.find((field) => field.name === "EE_EMUL")?.meaning).toContain("Beckhoff SPI");
    expect(result.fields.find((field) => field.name === "XTAL_MODE")?.value).toBe("1b");
    expect(result.bytes.at(-1)).toBe("FF");
  });
  it.each(["", "01", "01 00 53 92", "GG 00 53 92 00 00 00 00"])("rejects incomplete or malformed data: %s", (raw) => {
    expect(decodeEscHardware("LAN9253", raw)).toBeUndefined();
  });
  it("does not interpret unknown profiles or assume compatible IDs", () => {
    expect(decodeEscHardware("Generic ESC", "00 00 00 00 00 00 00 00")).toBeUndefined();
    expect(decodeEscHardware("LAN9252", "00 00 53 92 00 00 00 00")?.mismatch).toBe(true);
    expect(decodeEscHardware("E253", "00 00 53 E2 00 00 00 00")?.mismatch).toBe(false);
    expect(decodeEscHardware("E101", "00 00 00 00 00 00 00 00")?.family).toBe("ET1100");
  });
  it("decodes every ET1100 port mode without duplicating ports", () => {
    for (let mode = 0; mode < 4; mode++) {
      const result = decodeEscHardware("ET1100", `${(0x3C | mode).toString(16)} 00 00 00 00 00 00 00`)!;
      expect(result.fields.filter((field) => field.meaning.startsWith("Port "))).toHaveLength([2, 3, 3, 4][mode]);
    }
  });
  it("uses chip-specific TX shift encodings for all four values", () => {
    for (let shift = 0; shift < 4; shift++) {
      const et = decodeEscHardware("ET1100", `00 0${shift} 00 00 00 00 00 00`)!;
      const lan = decodeEscHardware("LAN9253", `00 00 53 92 00 0${shift << 1} 00 00`)!;
      expect(et.fields.find((field) => field.name === "C25_SHI")?.meaning).toContain(`${shift * 10} ns`);
      expect(lan.fields.find((field) => field.name === "TX_SHIFT")?.meaning).toBe(["20 ns", "30 ns", "0 ns", "10 ns"][shift]);
    }
  });
  it("exposes reserved encodings and ALE emulation polarity explicitly", () => {
    const result = decodeEscHardware("LAN9253", "00 00 53 92 51 00 00 00")!;
    expect(result.fields.find((field) => field.name === "CHIPMODE")?.meaning).toBe("保留编码");
    expect(result.fields.find((field) => field.name === "EE_EMUL_ALELO_POL")?.meaning).toContain("下降沿");
    expect(result.fields.find((field) => field.name === "EE_EMUL")?.meaning).toContain("单相");
  });
});
