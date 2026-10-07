export interface SiiSection { name: string; kind: number | null; offset: number; length: number }
export interface ImageSnapshot { data: string; size: number; layout?: SiiSection[]; layout_error?: string | null }
export interface DifferenceRange { offset: number; length: number }

// The bridge serializes raw EEPROM bytes as space-separated hex.
export function imageBytes(data?: string): string[] {
  return data?.trim().split(/\s+/).filter(Boolean).map(byte => byte.toUpperCase()) ?? [];
}

// Compare only observed bytes in the write range; unread target bytes remain unknown.
export function compareSnapshots(actual: string[], target: string[]) {
  const compared = Math.min(actual.length, target.length);
  const ranges: DifferenceRange[] = [];
  let differing = 0;
  for (let offset = 0; offset < compared; offset += 1) {
    if (actual[offset] === target[offset]) continue;
    differing += 1;
    const previous = ranges.at(-1);
    if (previous && previous.offset + previous.length === offset) previous.length += 1;
    else ranges.push({ offset, length: 1 });
  }
  return { compared, differing, ranges, unread: Math.max(0, target.length - actual.length), extra: Math.max(0, actual.length - target.length) };
}
