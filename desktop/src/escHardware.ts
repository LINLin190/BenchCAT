import definitions from "../../src/ethercat_debug_tool/esc_profiles/data/esc_hardware_fields.json";

export const hardwareFamily = (profile: string) => ({ E101: "ET1100", E252: "LAN9252", E253: "LAN9253" }[profile] ?? profile);

export interface HardwareField {
  location: string;
  name: string;
  value: string;
  meaning: string;
  reserved: boolean;
}

/** Shared with ProfileRegistry. Sources: Beckhoff Section II §2.50.2;
 * Microchip DS00001909C §7.1/12.14.94, DS00003421B §3.2/11.16.95.
 * CHIPMODE selects ports, not the PDI. Never coerce the whole ID to Number. */
export function decodeEscHardware(profile: string, raw: string) {
  const family = hardwareFamily(profile);
  if (family !== "ET1100" && family !== "LAN9252" && family !== "LAN9253") return undefined;
  const parts = raw.trim().split(/\s+/);
  const size = 8;
  if (parts.length !== size || parts.some((part) => !/^[\da-f]{2}$/i.test(part))) return undefined;
  const bytes = parts.map((part) => parseInt(part, 16));
  const value = `0x${parts.slice(0, family === "ET1100" ? 2 : size).reverse().join("").toUpperCase()}`;
  const numeric = BigInt(value);
  const hex = (value: number, digits = 4) => `0x${value.toString(16).toUpperCase().padStart(digits, "0")}`;
  const fields: HardwareField[] = definitions[family].map((field) => {
    const [high, low = high] = field.bits.split(":").map(Number);
    const width = high - low + 1;
    const current = Number((numeric >> BigInt(low)) & ((1n << BigInt(width)) - 1n));
    const first = Math.floor(low / 8), last = Math.floor(high / 8);
    const location = first === last
      ? `0x0E0${first}[${width === 1 ? low % 8 : `${high % 8}:${low % 8}`}]`
      : `0x0E0${first}–0x0E0${last}`;
    return { location, name: field.name, reserved: field.reserved,
      value: width > 8 ? hex(current, Math.ceil(width / 4)) : `${current.toString(2).padStart(width, "0")}b`,
      meaning: field.enum_values[current] ?? field.description };
  });
  if (family === "ET1100") {
    const ports = [[0, 1], [0, 1, 2], [0, 1, 3], [0, 1, 2, 3]];
    const mode = bytes[0] & 3;
    for (let bit = 2; bit <= 5; bit++) {
      const port = bit === 4 && mode === 2 ? 3 : bit - 2;
      const active = bit === 5 ? mode === 3 : ports[mode].includes(port);
      const field = fields.find((field) => field.name === `P_CONF[${bit - 2}]`)!;
      field.meaning = active ? `Port ${port} · ${field.meaning}` : "端口未启用";
    }
  }
  const chip = bytes[2] | (bytes[3] << 8);
  // Summary facts of the identification area, so the card can show them without decoding.
  const revision = bytes[0] | (bytes[1] << 8);
  const strap = family === "ET1100" ? bytes[0] : bytes[4] | (bytes[5] << 8);
  return { family, bytes: parts.slice(0, size).map((part) => part.toUpperCase()), fields, value,
    revision: hex(revision), chipId: hex(chip), strap: hex(strap),
    mismatch: profile === family && family !== "ET1100" && chip !== (family === "LAN9252" ? 0x9252 : 0x9253) };
}
