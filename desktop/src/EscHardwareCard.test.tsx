import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EscHardwareCard } from "./EscHardwareCard";
import type { SlaveInfo } from "./types";

const slave: SlaveInfo = {
  position: 1, name: "test", identity: { vendor_id: 1, product_code: 2, revision: 3, serial_number: 4 },
  state: 2, al_status: 0, input_size: 0, output_size: 0, chip_model: "LAN9253", register_family: "LAN9253",
  esc_hardware: "02 00 53 92 2D 68 00 00",
};

describe("hardware scan snapshot card", () => {
  it("shows a cached value without refresh controls or a timestamp", () => {
    const html = renderToStaticMarkup(<EscHardwareCard slave={slave} profile="LAN9253" />);
    expect(html).not.toContain("Product ID：");
    expect(html).not.toContain("0x0000682D92530002");
    expect(html).toContain("0x0E00–0x0E07");
    expect(html).toContain("02 00 53 92 2D 68 00 00");
    expect(html).not.toContain("刷新");
    expect(html).not.toContain("最近读取");
    expect(html).not.toContain("非实测");
    expect(html).not.toContain("不作状态判断");
    expect(html).not.toContain("不是 EEPROM Revision");
    expect(html).toContain("Address");
    expect(html).toContain("ChipMode");
    expect(html).toContain("展开详情");
  });
  it("uses the requested LAN9252 field names", () => {
    const html = renderToStaticMarkup(<EscHardwareCard slave={{ ...slave, esc_hardware: "01 00 52 92 3C 00 00 00" }} profile="LAN9252" />);
    expect(html).toContain("ChipMode");
    expect(html).toContain("EEPROM Size");
    expect(html).toContain("TX_Shift");
    expect(html).toContain("MII_LinkPOL");
  });
  it.each([
    ["LAN9252", "01 00 52 92 3C 00 00 00", "32 Kbit ~ 4 Mbit"],
    ["LAN9252", "01 00 52 92 00 00 00 00", "1 Kbit ~ 16 Kbit"],
    ["LAN9253", "01 00 53 92 08 00 00 00", "32 Kbit ~ 4 Mbit"],
    ["LAN9253", "01 00 53 92 00 00 00 00", "1 Kbit ~ 16 Kbit"],
  ])("shows the scanned %s EEPROM capacity range", (profile, raw, capacity) => {
    const html = renderToStaticMarkup(<EscHardwareCard slave={{ ...slave, esc_hardware: raw }} profile={profile} />);
    expect(html).toContain("EEPROM size strap");
    expect(html).toContain(capacity);
    expect(html.indexOf(">Chip ID<")).toBeLessThan(html.indexOf(">硅版本<"));
  });

  it("keeps failures and unavailable scan data distinct from zero", () => {
    const html = renderToStaticMarkup(<EscHardwareCard slave={{ ...slave, esc_hardware: null, esc_hardware_error: "timeout" }} profile="LAN9253" />);
    expect(html).toContain("读取失败");
    expect(html).toContain("timeout");
    expect(html).not.toContain("0x0000000000000000");
    expect(html).not.toContain("Product ID：");
  });
  it("does not invent unscanned ET1100 bytes or fetch after a profile change", () => {
    const et = { ...slave, esc_hardware: "4C 24 00 00 00 00 00 00" };
    const etHtml = renderToStaticMarkup(<EscHardwareCard slave={et} profile="ET1100" />);
    expect(etHtml).toContain("0x0E00–0x0E07");
    expect(etHtml).toContain("4C 24");
    expect(etHtml).not.toContain("Reserved");
    expect(etHtml).not.toContain("EEPROM size strap");
    expect(renderToStaticMarkup(<EscHardwareCard slave={{ ...et, esc_hardware: "4C 24" }} profile="LAN9253" />)).toContain("当前扫描无可用数据");
  });
});
