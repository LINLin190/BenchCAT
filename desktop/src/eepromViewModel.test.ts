import { describe, expect, it } from "vitest";
import { compareSnapshots, imageBytes } from "./eepromViewModel";

describe("EEPROM snapshot comparison", () => {
  it("groups adjacent differences across row and page boundaries", () => {
    const actual = Array(1024).fill("00"), target = [...actual];
    for (const offset of [15, 16, 511, 512, 513, 900]) target[offset] = "01";
    expect(compareSnapshots(actual, target)).toMatchObject({ differing: 6, ranges: [
      { offset: 15, length: 2 }, { offset: 511, length: 3 }, { offset: 900, length: 1 },
    ] });
  });
  it("does not classify unread bytes or bytes outside the write range as differences", () => {
    expect(compareSnapshots(["00"], ["00", "FF"])).toMatchObject({ compared: 1, differing: 0, unread: 1 });
    expect(compareSnapshots(["00", "FF"], ["00"])).toMatchObject({ compared: 1, differing: 0, extra: 1 });
  });
  it("recomputes differences against a replacement target", () => {
    const read = imageBytes("aa  00\nFF");
    expect(compareSnapshots(read, imageBytes("AA 00 FF")).differing).toBe(0);
    expect(compareSnapshots(read, imageBytes("AA 01 FF")).ranges).toEqual([{ offset: 1, length: 1 }]);
  });
});
