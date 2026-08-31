/**
 * `BrtFill` — the fill table entry.
 *
 * **What the corpus establishes, and what it does not.** Sixty-eight bytes, and every one of the
 * nine Excel-authored reference workbooks contains exactly two of these records, differing in a single byte:
 * `fls` = 0 and `fls` = 0x11. Those are the two fills Excel emits into every workbook it writes —
 * `none` and `gray125` — and **17 is exactly where `gray125` sits** in the eighteen-value pattern
 * ordering. An enumeration confirmed at its first and its eighteenth position leaves no room for
 * the ordering to differ in between, which is what makes `solid` = 1 a reading rather than a
 * guess: were the order different anywhere below 17, `gray125` would not have landed on 17.
 *
 * The colour fields are the `BrtColor` established in `color.ts`, and the two the corpus contains
 * are the system foreground and background (indices 64 and 65) — self-consistent with their
 * resolved RGB, which is how they were confirmed.
 *
 * **No corpus fill has a real colour**, both being the defaults, so a solid fill carrying an RGB
 * is composed entirely of established parts but has never been observed as a whole. The gradient
 * fields after the two colours are left alone: nothing in the corpus sets them, and the model's
 * gradient fills degrade to their first stop rather than being invented here.
 */
import type { Color, Fill, FillPatterns } from "@excel/types";
import { COLOR_SIZE, encodeColor, readColor } from "@excel/xlsb/color";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * `fls` — the pattern ordering.
 *
 * Confirmed at two points against Excel's own output: `none` at 0 and `gray125` at 17.
 */
const PATTERNS: readonly FillPatterns[] = [
  "none",
  "solid",
  "mediumGray",
  "darkGray",
  "lightGray",
  "darkHorizontal",
  "darkVertical",
  "darkDown",
  "darkUp",
  "darkGrid",
  "darkTrellis",
  "lightHorizontal",
  "lightVertical",
  "lightDown",
  "lightUp",
  "lightGrid",
  "lightTrellis",
  "gray125",
  "gray0625"
];

/** Total bytes in a `BrtFill`, as Excel writes it. */
const FILL_SIZE = 68;

/** The two patterns every Excel workbook declares, in the order it declares them. */
export const MANDATORY_FILL_PATTERNS = [0, PATTERNS.indexOf("gray125")] as const;

/** Read a `BrtFill` payload. */
export function readFill(payload: Uint8Array, part: string): Fill | undefined {
  if (payload.length < 4 + COLOR_SIZE * 2) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  const pattern = PATTERNS[reader.readUint32()];
  if (pattern === undefined || pattern === "none") {
    // An unrecognised pattern index is reported as no fill rather than as a wrong pattern.
    return undefined;
  }
  const fgColor = readColor(reader);
  const bgColor = readColor(reader);
  const fill: Fill = { type: "pattern", pattern };
  if (Object.keys(fgColor).length > 0) {
    fill.fgColor = fgColor;
  }
  if (Object.keys(bgColor).length > 0) {
    fill.bgColor = bgColor;
  }
  return fill;
}

/**
 * Serialise a `BrtFill`.
 *
 * A gradient is written as a solid fill of its first stop. That is what the chart engine in this
 * repository already does with a gradient it cannot express, and it is the honest degradation:
 * the alternative is either inventing the gradient field layout, which the corpus does not
 * establish, or dropping the fill entirely and losing the colour as well as the gradient.
 */
export function encodeFill(fill: Fill | undefined): Uint8Array {
  if (fill === undefined) {
    return patternFill(0);
  }
  if (fill.type === "gradient") {
    const first = fill.stops[0]?.color;
    return patternFill(PATTERNS.indexOf("solid"), first, undefined);
  }
  const index = PATTERNS.indexOf(fill.pattern);
  return patternFill(index < 0 ? 0 : index, fill.fgColor, fill.bgColor);
}

/**
 * A `BrtFill` for one of the two mandatory entries, exactly as Excel spells them.
 *
 * The two colours are written verbatim rather than through `encodeColor`, and the difference is
 * not cosmetic: Excel writes them as **indexed** colours (kind 1, `03 40 …` and `03 41 …`) with
 * their resolved RGB alongside — black for palette slot 64, white for 65. Composing them from the
 * model side produces `01 40 …`, an *automatic* colour with no RGB, because this library declines
 * to resolve a palette it does not carry. That is the right policy for a colour a caller chose and
 * the wrong one for these two, whose values are known because Excel writes the same bytes into
 * every workbook it produces.
 */
export function mandatoryFill(pattern: number): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter().writeUint32(pattern).toUint8Array(),
    // Palette slot 64 — the system foreground, black.
    new Uint8Array([0x03, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    // Palette slot 65 — the system background, white.
    new Uint8Array([0x03, 0x41, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]),
    new BinaryWriter().writeZeros(FILL_SIZE - 4 - COLOR_SIZE * 2).toUint8Array()
  ]);
}

function patternFill(
  pattern: number,
  fgColor?: Partial<Color>,
  bgColor?: Partial<Color>
): Uint8Array {
  return concatUint8Arrays([
    new BinaryWriter().writeUint32(pattern).toUint8Array(),
    encodeColor(fgColor),
    encodeColor(bgColor),
    new BinaryWriter().writeZeros(FILL_SIZE - 4 - COLOR_SIZE * 2).toUint8Array()
  ]);
}
