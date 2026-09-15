import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewEeprom } from "./OverviewEeprom";
import type { SlaveInfo } from "./types";

const slave: SlaveInfo = {
  position: 1, name: "test", identity: { vendor_id: 1, product_code: 2, revision: 3, serial_number: 4 },
  state: 2, al_status: 0, input_size: 0, output_size: 0, chip_model: "LAN9252", register_family: "LAN9252",
  eeprom_status: 0x00C0,
  eeprom_prefix: "8D 0E 03 44 88 13 00 00 00 00 00 00 00 00 E4 00",
};

describe("overview EEPROM card", () => {
  it("shows the two configuration bytes in the default view", () => {
    const html = renderToStaticMarkup(<OverviewEeprom slave={slave} profile="LAN9252" />);
    expect(html).toContain("PDI Control");
    expect(html).toContain("0x0140");
    expect(html).toContain("0x8D");
    expect(html).toContain("HBI Index 16bit");
    expect(html).toContain("PDI Configuration");
    expect(html).toContain("0x0150");
    expect(html).toContain("0x03");
    // The full word decode is part of the expanded detail, not the default view.
    expect(html).not.toContain("0x0E8D");
    expect(html).not.toContain("SYNC脉宽");
  });

  it("puts the raw register value and binary above the control/status table", () => {
    const html = renderToStaticMarkup(<OverviewEeprom slave={slave} profile="LAN9252" />);
    const raw = html.indexOf("Raw value");
    const table = html.indexOf("EEPROM Algorithm");
    expect(raw).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(raw);
    expect(html).toContain("0000 0000 1100 0000");
  });

  it("renders collapsed by default with a single card-level disclosure", () => {
    const html = renderToStaticMarkup(<OverviewEeprom slave={slave} profile="LAN9252" />);
    expect(html).toContain("展开详细解析");
    expect(html).not.toContain("16-bit 值");
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
  });

  it("keeps failures distinct from a zero prefix", () => {
    const html = renderToStaticMarkup(<OverviewEeprom slave={{ ...slave, eeprom_prefix: null, eeprom_prefix_error: "timeout" }} profile="LAN9252" />);
    expect(html).toContain("timeout");
    expect(html).not.toContain("0x8D");
    const statusHtml = renderToStaticMarkup(<OverviewEeprom slave={{ ...slave, eeprom_status: null, eeprom_status_error: "busy" }} profile="LAN9252" />);
    expect(statusHtml).toContain("busy");
    expect(statusHtml).not.toContain("0000 0000 1100 0000");
  });

  it("keeps the ESC-specific link ports out of the ET1100 decode", () => {
    const html = renderToStaticMarkup(<OverviewEeprom slave={{ ...slave, register_family: "ET1100", chip_model: "ET1100" }} profile="ET1100" />);
    expect(html).not.toContain("Enhanced Link Port 1");
  });
});
