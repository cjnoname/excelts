import { encodeColor, readColor } from "@excel/xlsb/color";
import { BinaryReader } from "@utils/binary";
import { describe, expect, it } from "vitest";

/**
 * `BrtColor.nTintAndShade` is a signed 16-bit fraction over **32767**, and the two values Excel writes prove it.
 *
 * This was the last inferred constant in the codec with no evidence behind it — the note said every colour in the corpus
 * carried a zero tint. That was true of every *standalone* `BrtColor` record and missed the ones **embedded** in
 * `BrtFont`, where the field sits at offset 14. Two of the 62 fonts across the corpus carry one, both theme colours in
 * `poi-sample.xlsb`, and both reproduce an Excel UI value exactly:
 *
 * - `-16383 / 32767 = -0.499984740745262` — "darker 50%", and the literal Excel writes in XLSX
 * - `13106 / 32767 = 0.399975585192419` — "lighter 40%"
 *
 * Dividing by 32768 gives `-0.499969482421875`, which matches nothing. The scale is not a rounding detail: it decides
 * what shade of a theme colour a consumer paints.
 */
const DARKER_50 = -0.499984740745262;
const LIGHTER_40 = 0.39997558519241921;

function tintOf(bytes: Uint8Array): number | undefined {
  return readColor(new BinaryReader(bytes, 0, "test")).tint;
}

describe("BrtColor tint scale", () => {
  it("round-trips Excel's darker-50% tint to the exact raw value", async () => {
    const bytes = encodeColor({ theme: 9, tint: DARKER_50 });
    // Offset 2 is `nTintAndShade`, signed.
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getInt16(2, true)).toBe(
      -16383
    );
  });

  it("round-trips Excel's lighter-40% tint to the exact raw value", async () => {
    const bytes = encodeColor({ theme: 3, tint: LIGHTER_40 });
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getInt16(2, true)).toBe(
      13106
    );
  });

  it("reads Excel's own bytes back to the value XLSX prints", async () => {
    // Verbatim from `poi-sample.xlsb`: theme colour, tint -16383.
    const excel = new Uint8Array([0x07, 0x09, 0x01, 0xc0, 0x97, 0x47, 0x06, 0xff]);
    expect(tintOf(excel)).toBeCloseTo(DARKER_50, 15);
  });

  it("reads the lighter-40% font's bytes back too", async () => {
    const excel = new Uint8Array([0x07, 0x03, 0x32, 0x33, 0x53, 0x8d, 0xd5, 0xff]);
    expect(tintOf(excel)).toBeCloseTo(LIGHTER_40, 15);
  });

  it("does not use 32768", async () => {
    // The competing reading, and the one that would be invisible without a real tint to check against: it differs from
    // the correct value only in the fifth decimal place.
    const bytes = encodeColor({ theme: 9, tint: DARKER_50 });
    const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getInt16(2, true);
    expect(raw / 32768).not.toBeCloseTo(DARKER_50, 6);
    expect(raw / 32767).toBeCloseTo(DARKER_50, 15);
  });

  it("clamps rather than overflowing the field", async () => {
    // A caller can hand in any number; the field is 16 bits and a wrap would flip the shade to its opposite.
    for (const tint of [1, -1, 2, -2]) {
      const bytes = encodeColor({ theme: 1, tint });
      const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getInt16(2, true);
      expect(Math.abs(raw)).toBeLessThanOrEqual(32767);
      expect(Math.sign(raw)).toBe(Math.sign(tint));
    }
  });
});
