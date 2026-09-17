/** PDI_SELECT values are decoded as the common mode names from PDI.md. */
const PDI_TYPES: Record<number, string> = {
  0x00: "Interface deactivated",
  0x04: "Digital I/O",
  0x05: "Beckhoff SPI",
  0x08: "16-bit asynchronous µC",
  0x09: "8-bit asynchronous µC",
  0x0A: "16-bit synchronous µC",
  0x0B: "8-bit synchronous µC",
  0x10: "32 digital inputs",
  0x11: "24 digital inputs / 8 outputs",
  0x12: "16 digital inputs / 16 outputs",
  0x13: "8 digital inputs / 24 outputs",
  0x14: "32 digital outputs",
  0x80: "SPI-LAN9252 Compat",
  0x82: "SPI-ECAT DirectMap",
  0x88: "HBI Mux 1P8bit",
  0x89: "HBI Mux 1P16bit",
  0x8A: "HBI Mux 2P8bit",
  0x8B: "HBI Mux 2P16bit",
  0x8C: "HBI Index 8bit",
  0x8D: "HBI Index 16bit",
  0x90: "HBI Mux 1P8bit DirectMap",
  0x91: "HBI Mux 1P16bit DirectMap",
  0x92: "HBI Mux 2P8bit DirectMap",
  0x93: "HBI Mux 2P16bit DirectMap",
  0x94: "HBI Index 8bit DirectMap",
  0x95: "HBI Index 16bit DirectMap",
};

export function pdiMeaning(value: number): string {
  return PDI_TYPES[value] ?? "含义未收录";
}

export function normalizeConfigData(value: string): { formatted?: string; bytes?: number[]; error?: string } {
  const compact = value.replace(/[\s,_-]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(compact)) return { error: "只能输入十六进制字节" };
  if (compact.length !== 20) return { error: `需要 10 byte，当前 ${Math.floor(compact.length / 2)} byte` };
  const bytes = Array.from({ length: 10 }, (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16));
  return { bytes, formatted: bytes.map((item) => item.toString(16).toUpperCase().padStart(2, "0")).join(" ") };
}

export interface DecodedConfigData {
  formatted: string;
  pdiCode: number;
  pdiLabel: string;
  escConfiguration: number;
  pdiConfiguration: number;
  syncLatchConfiguration: number;
  syncPulse: number;
  extendedPdiConfiguration: number;
  stationAlias: number;
}

export function decodeConfigData(value: string): DecodedConfigData | undefined {
  const parsed = normalizeConfigData(value);
  if (!parsed.bytes || !parsed.formatted) return undefined;
  const bytes = parsed.bytes;
  const word = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
  return {
    formatted: parsed.formatted,
    pdiCode: bytes[0],
    pdiLabel: pdiMeaning(bytes[0]),
    escConfiguration: bytes[1],
    pdiConfiguration: bytes[2],
    syncLatchConfiguration: bytes[3],
    syncPulse: word(4),
    extendedPdiConfiguration: word(6),
    stationAlias: word(8),
  };
}

export const hexByte = (value: number) => `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
export const hexWord = (value: number) => `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;

export interface FlashHistoryEntry {
  path: string;
  documentSha256: string;
  ordinal: number;
  deviceName: string;
  vendorId: number;
  productCode: number;
  revision: number;
  byteSize: number;
  originalConfigData: string;
  effectiveConfigData: string;
  flashedAt: string;
  slaveKey: string;
}

export interface FixedEsiEntry {
  path: string;
  sha256: string;
  vendor_id: number;
  vendor_name: string;
  ordinal: number;
  device_name: string;
  type_name: string;
  product_code: number;
  revision: number;
  byte_size: number;
  config_data: string;
}

export interface FixedEsiState {
  favorites: FixedEsiEntry[];
  hidden: string[];
}

export const FLASH_HISTORY_KEY = "benchcat.eeprom-flash-history-v1";
export const FIXED_ESI_STATE_KEY = "benchcat.eeprom-fixed-list-v1";
export const QUICK_FLASH_TAB_KEY = "benchcat.eeprom-quick-tab-v1";
export const EEPROM_AUTO_RESET_KEY = "benchcat.eeprom-auto-reset-v1";
export const FLASH_HISTORY_LIMIT = 20;

export function fixedEsiKey(entry: Pick<FixedEsiEntry, "path" | "ordinal">): string {
  return `${entry.path.toLowerCase()}|${entry.ordinal}`;
}

export function loadFixedEsiState(storage: Pick<Storage, "getItem"> = window.localStorage): FixedEsiState {
  try {
    const value = JSON.parse(storage.getItem(FIXED_ESI_STATE_KEY) ?? "{}");
    return {
      favorites: Array.isArray(value.favorites) ? value.favorites.filter((item: unknown) =>
        Boolean(item && typeof item === "object" && typeof (item as FixedEsiEntry).path === "string")
      ) : [],
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((item: unknown): item is string => typeof item === "string") : [],
    };
  } catch {
    return { favorites: [], hidden: [] };
  }
}

export function saveFixedEsiState(
  state: FixedEsiState,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): FixedEsiState {
  storage.setItem(FIXED_ESI_STATE_KEY, JSON.stringify(state));
  return state;
}

export function loadQuickFlashTab(storage: Pick<Storage, "getItem"> = window.localStorage): 0 | 1 {
  return storage.getItem(QUICK_FLASH_TAB_KEY) === "1" ? 1 : 0;
}

export function saveQuickFlashTab(tab: number, storage: Pick<Storage, "setItem"> = window.localStorage): 0 | 1 {
  const value = tab === 1 ? 1 : 0;
  storage.setItem(QUICK_FLASH_TAB_KEY, String(value));
  return value;
}

export function loadEepromAutoReset(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  return storage.getItem(EEPROM_AUTO_RESET_KEY) !== "false";
}

export function saveEepromAutoReset(enabled: boolean, storage: Pick<Storage, "setItem"> = window.localStorage): boolean {
  storage.setItem(EEPROM_AUTO_RESET_KEY, String(enabled));
  return enabled;
}

export function loadFlashHistory(storage: Pick<Storage, "getItem"> = window.localStorage): FlashHistoryEntry[] {
  try {
    const value = JSON.parse(storage.getItem(FLASH_HISTORY_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.path === "string").slice(0, FLASH_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveFlashHistory(
  entry: FlashHistoryEntry,
  storage: Pick<Storage, "setItem"> = window.localStorage,
  current = loadFlashHistory(),
): FlashHistoryEntry[] {
  const key = `${entry.path.toLowerCase()}|${entry.ordinal}|${entry.effectiveConfigData}`;
  const next = [entry, ...current.filter((item) =>
    `${item.path.toLowerCase()}|${item.ordinal}|${item.effectiveConfigData}` !== key
  )].slice(0, FLASH_HISTORY_LIMIT);
  storage.setItem(FLASH_HISTORY_KEY, JSON.stringify(next));
  return next;
}
