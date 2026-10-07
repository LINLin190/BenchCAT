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

// Preserve the XML's actual configuration length, including extended bytes.
export function normalizeConfigData(value: string): { formatted?: string; bytes?: number[]; error?: string } {
  const compact = value.replace(/[\s,_-]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(compact)) return { error: "只能输入十六进制字节" };
  if (compact.length % 2) return { error: "每个字节需要两个十六进制字符" };
  if (compact.length < 2 || compact.length > 28) return { error: `需要 1–14 byte，当前 ${compact.length / 2} byte` };
  const bytes = Array.from({ length: compact.length / 2 }, (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16));
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

// Decode the common fields while retaining all bytes in the formatted value.
export function decodeConfigData(value: string): DecodedConfigData | undefined {
  const parsed = normalizeConfigData(value);
  if (!parsed.bytes || !parsed.formatted) return undefined;
  const bytes = Array.from({ length: 10 }, (_, index) => parsed.bytes![index] ?? 0);
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

export interface EepromBinTarget {
  target_id: string;
  path: string;
  size: number;
  sha256: string;
}

// Detect the source format consistently in dialogs, history, and favorites.
export function isBinFile(path: string): boolean {
  return path.toLowerCase().endsWith(".bin");
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
export const RECENT_ESI_KEY = "benchcat.recent-esi";
// Start with reset disabled after upgrading; later explicit choices use this key.
export const EEPROM_AUTO_RESET_KEY = "benchcat.eeprom-auto-reset-v2";
export const FLASH_HISTORY_LIMIT = 25;

export function fixedEsiKey(entry: Pick<FixedEsiEntry, "path" | "ordinal">): string {
  return `${entry.path.toLowerCase()}|${entry.ordinal}`;
}

export interface EepromSourceRecord { path: string }

// Windows paths identify list records; identical files at different paths stay separate.
const sourcePathKey = (entry: EepromSourceRecord) => entry.path.replace(/\//g, "\\").toLowerCase();

// Device and configuration changes refresh the existing file record.
export function sameEepromSource(a: EepromSourceRecord, b: EepromSourceRecord): boolean {
  return sourcePathKey(a) === sourcePathKey(b);
}

// Preserve the first, most recent record for each path.
export function uniqueEepromSources<T extends EepromSourceRecord>(entries: T[]): T[] {
  const paths = new Set<string>();
  return entries.filter(entry => {
    const path = sourcePathKey(entry);
    const duplicate = paths.has(path);
    paths.add(path);
    return !duplicate;
  });
}

// Include legacy Device keys when reading shortcuts saved by older versions.
const sourceHiddenKeys = (entry: EepromSourceRecord & { ordinal?: number }) => [
  `path:${sourcePathKey(entry)}`,
  ...(entry.ordinal !== undefined ? [fixedEsiKey({ path: entry.path, ordinal: entry.ordinal })] : []),
];

// Both XML lists use the same path deduplication and persistent hidden records.
export function fixedEsiEntries(state: FixedEsiState, library: FixedEsiEntry[]): FixedEsiEntry[] {
  return uniqueEepromSources([...state.favorites, ...library].filter(entry => !sourceHiddenKeys(entry).some(key => state.hidden.includes(key))));
}

// Restore a shortcut explicitly without restoring other deleted records.
export function addFixedEsiEntry(state: FixedEsiState, entry: FixedEsiEntry): FixedEsiState {
  const keys = sourceHiddenKeys(entry);
  return { favorites: uniqueEepromSources([entry, ...state.favorites]), hidden: state.hidden.filter(key => !keys.includes(key)) };
}

// Hide this path's shortcuts, leaving the XML/BIN file and loaded target untouched.
export function removeFixedEsiEntry(state: FixedEsiState, entry: EepromSourceRecord, library: FixedEsiEntry[] = []): FixedEsiState {
  const matches = [...state.favorites, ...library].filter(item => sameEepromSource(item, entry));
  return {
    favorites: state.favorites.filter(item => !sameEepromSource(item, entry)),
    hidden: [...new Set([...state.hidden, ...[entry, ...matches].flatMap(sourceHiddenKeys)])],
  };
}

// Collapse legacy duplicate favorites while retaining persistent hidden shortcuts.
export function loadFixedEsiState(storage: Pick<Storage, "getItem"> = window.localStorage): FixedEsiState {
  try {
    const value = JSON.parse(storage.getItem(FIXED_ESI_STATE_KEY) ?? "{}");
    return {
      favorites: Array.isArray(value.favorites) ? uniqueEepromSources(value.favorites.filter((item: unknown) =>
        Boolean(item && typeof item === "object" && typeof (item as FixedEsiEntry).path === "string")
      )) : [],
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((item: unknown): item is string => typeof item === "string") : [],
    };
  } catch {
    return { favorites: [], hidden: [] };
  }
}

// Store the same unique favorites used by both XML list views.
export function saveFixedEsiState(
  state: FixedEsiState,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): FixedEsiState {
  const next = { ...state, favorites: uniqueEepromSources(state.favorites) };
  storage.setItem(FIXED_ESI_STATE_KEY, JSON.stringify(next));
  return next;
}

// Normalize old recent-file lists without dropping different-path copies.
export function loadRecentEsi(storage: Pick<Storage, "getItem"> = window.localStorage): string[] {
  try {
    const value = JSON.parse(storage.getItem(RECENT_ESI_KEY) ?? "[]");
    return Array.isArray(value) ? uniqueEepromSources(value.filter((path): path is string => typeof path === "string").map(path => ({ path }))).map(entry => entry.path).slice(0, 20) : [];
  } catch { return []; }
}

// Persist recent files after loading, editing, or removing a list record.
export function writeRecentEsi(entries: string[], storage: Pick<Storage, "setItem"> = window.localStorage): string[] {
  const next = uniqueEepromSources(entries.map(path => ({ path }))).map(entry => entry.path).slice(0, 20);
  storage.setItem(RECENT_ESI_KEY, JSON.stringify(next));
  return next;
}

export function loadQuickFlashTab(storage: Pick<Storage, "getItem"> = window.localStorage): 0 | 1 {
  return storage.getItem(QUICK_FLASH_TAB_KEY) === "1" ? 1 : 0;
}

export function saveQuickFlashTab(tab: number, storage: Pick<Storage, "setItem"> = window.localStorage): 0 | 1 {
  const value = tab === 1 ? 1 : 0;
  storage.setItem(QUICK_FLASH_TAB_KEY, String(value));
  return value;
}

// Only a new explicit choice enables reset for XML and BIN programming.
export function loadEepromAutoReset(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  return storage.getItem(EEPROM_AUTO_RESET_KEY) === "true";
}

export function saveEepromAutoReset(enabled: boolean, storage: Pick<Storage, "setItem"> = window.localStorage): boolean {
  storage.setItem(EEPROM_AUTO_RESET_KEY, String(enabled));
  return enabled;
}

// Keep the latest saved operation for each path, including older duplicate histories.
export function loadFlashHistory(storage: Pick<Storage, "getItem"> = window.localStorage): FlashHistoryEntry[] {
  try {
    const value = JSON.parse(storage.getItem(FLASH_HISTORY_KEY) ?? "[]");
    return Array.isArray(value) ? uniqueEepromSources(value.filter((item) => item && typeof item.path === "string")
      .sort((a, b) => (Date.parse(b.flashedAt) || 0) - (Date.parse(a.flashedAt) || 0))).slice(0, FLASH_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

// Reusing a source refreshes its last flash time and saved configuration.
export function saveFlashHistory(
  entry: FlashHistoryEntry,
  storage: Pick<Storage, "setItem"> = window.localStorage,
  current = loadFlashHistory(),
): FlashHistoryEntry[] {
  const next = uniqueEepromSources([entry, ...current]).slice(0, FLASH_HISTORY_LIMIT);
  storage.setItem(FLASH_HISTORY_KEY, JSON.stringify(next));
  return next;
}

// Deleting recent programming records never touches the source file.
export function removeFlashHistory(entry: EepromSourceRecord, current: FlashHistoryEntry[], storage: Pick<Storage, "setItem"> = window.localStorage): FlashHistoryEntry[] {
  const next = current.filter(item => !sameEepromSource(item, entry));
  storage.setItem(FLASH_HISTORY_KEY, JSON.stringify(next));
  return next;
}
