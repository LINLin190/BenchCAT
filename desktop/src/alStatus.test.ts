import { describe, expect, it } from "vitest";

import { alStatusInfo, standardAlStatusCodeCount } from "./alStatus";

describe("AL status catalog", () => {
  it("uses the complete shared standard catalog", () => {
    expect(standardAlStatusCodeCount).toBe(61);
    expect(alStatusInfo(0x0050)).toMatchObject({
      name: "EEPROM 无访问权",
      known: true,
    });
    expect(alStatusInfo(0x0050).action).toContain("0x0501");
  });

  it("distinguishes vendor-specific and unknown standard values", () => {
    expect(alStatusInfo(0x8001).name).toBe("厂商自定义 AL 状态码");
    expect(alStatusInfo(0x0003).name).toBe("未知AL状态码");
  });

  it("provides English display text for standard and vendor codes", () => {
    expect(alStatusInfo(0x0050, "en")).toMatchObject({ name: "EEPROM no access", known: true });
    expect(alStatusInfo(0x0050, "en").action).toContain("0x0501");
    expect(alStatusInfo(0x8001, "en").name).toBe("Vendor-specific AL status code");
  });
});
