/**
 * Cell borders: `BrtBorder` — MS-XLSB 2.4.314.
 *
 * ```text
 * flags       u8    bit 0 fBdrDiagDown, bit 1 fBdrDiagUp, six reserved
 * blxfTop     Blxf  10 bytes
 * blxfBottom  Blxf
 * blxfLeft    Blxf
 * blxfRight   Blxf
 * blxfDiag    Blxf
 * ```
 *
 * `1 + 5 × 10 = 51`, which is exactly the length of the single `BrtBorder` every corpus workbook
 * contains — and that record is 51 zero bytes, because every one of those workbooks uses the default
 * border and nothing else. **That is why this was on the loss list**: the record's *size* was established
 * and not one of its fields, so `styles.ts` wrote `new Uint8Array(51)` for every cell format and a border
 * a caller asked for silently disappeared. The specification supplies the fields.
 *
 * A `Blxf` (2.5.5) is `dg` (one byte of style), a reserved byte, and an eight-byte `BrtColor` — the same
 * colour structure fills and fonts already use, so `encodeColor` is reused rather than a second colour
 * writer appearing here.
 *
 * **The order is top, bottom, left, right — not the CSS order.** Writing left where bottom belongs
 * produces a table whose rules are on the wrong sides, which no round trip through this library would
 * notice because it would read them back the same way.
 */
import type { Border, BorderStyle, Borders, Color } from "@excel/types";
import { COLOR_SIZE, VALID_RGB, encodeColor, readColor } from "@excel/xlsb/color";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** `dg`, in the record's own order. The index is the value written. */
const BORDER_STYLE: readonly (BorderStyle | undefined)[] = [
  undefined, // 0x00 none
  "thin",
  "medium",
  "dashed",
  "dotted",
  "thick",
  "double",
  "hair",
  "mediumDashed",
  "dashDot",
  "mediumDashDot",
  "dashDotDot",
  "mediumDashDotDot",
  "slantDashDot"
];

/**
 * `dgBorder` for a style name — the value a `BrtBorder` edge and an `XFPropBorder` both write.
 *
 * Exported so the differential format in `styles.ts` reads from the same table rather than a second copy of
 * these fourteen names in a second order. Two tables meaning the same thing is how "thin" ends up as
 * "medium" in one of the two places.
 */
export function borderStyleValue(style: BorderStyle | undefined): number {
  return style === undefined ? 0 : Math.max(0, BORDER_STYLE.indexOf(style));
}

/** The style name for a `dgBorder` value, or `undefined` for 0 — the record's own "no line". */
export function borderStyleName(value: number): BorderStyle | undefined {
  return BORDER_STYLE[value];
}

/** One `Blxf`: a style byte, a reserved byte, then a colour. */
const BLXF_SIZE = 2 + COLOR_SIZE;

/** `1 + 5 × 10`, matching the corpus record exactly. */
export const BORDER_SIZE = 1 + 5 * BLXF_SIZE;

/** Serialise a `BrtBorder`. */
export function encodeBorder(borders: Partial<Borders> | undefined): Uint8Array {
  const diagonal = borders?.diagonal;
  let flags = 0;
  flags |= diagonal?.down === true ? 1 << 0 : 0;
  flags |= diagonal?.up === true ? 1 << 1 : 0;
  return concatUint8Arrays([
    new BinaryWriter().writeUint8(flags).toUint8Array(),
    // Top, bottom, left, right, diagonal. The specification's order, which is not the CSS one.
    encodeBlxf(borders?.top),
    encodeBlxf(borders?.bottom),
    encodeBlxf(borders?.left),
    encodeBlxf(borders?.right),
    encodeBlxf(diagonal)
  ]);
}

/** Read a `BrtBorder`, or `undefined` when it describes no border at all. */
export function readBorder(payload: Uint8Array, part: string): Partial<Borders> | undefined {
  if (payload.length < BORDER_SIZE) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  const flags = reader.readUint8();
  const top = readBlxf(reader);
  const bottom = readBlxf(reader);
  const left = readBlxf(reader);
  const right = readBlxf(reader);
  const diagonalEdge = readBlxf(reader);
  const down = (flags & (1 << 0)) !== 0;
  const up = (flags & (1 << 1)) !== 0;
  const diagonal =
    diagonalEdge === undefined && !down && !up
      ? undefined
      : { ...(diagonalEdge ?? {}), ...(down ? { down } : {}), ...(up ? { up } : {}) };
  const borders: Partial<Borders> = {
    ...(top === undefined ? {} : { top }),
    ...(left === undefined ? {} : { left }),
    ...(bottom === undefined ? {} : { bottom }),
    ...(right === undefined ? {} : { right }),
    ...(diagonal === undefined ? {} : { diagonal })
  };
  // The default `BrtBorder` is 51 zero bytes and describes no border. Returning an empty object for it
  // would give every cell format in every corpus workbook an explicit "no borders" setting.
  return Object.keys(borders).length === 0 ? undefined : borders;
}

/** Where the `BrtColor` starts inside a `Blxf`: after `dg` and its reserved byte. */
const BLXF_COLOR_OFFSET = 2;

/** One edge. An absent style is `dg = 0`, which is the record's own "none". */
function encodeBlxf(border: Partial<Border> | undefined): Uint8Array {
  const index = borderStyleValue(border?.style);
  if (index === 0) {
    // A `dg` of 0 means there is no line, but the colour is **not** all zeros: Excel sets `fValidRGB` on it and
    // leaves the index and the channels clear. Every real file agrees — three corpus workbooks and every one of
    // the eight Excel produced for the oracle carry `0x01` in this byte on all five edges.
    //
    // This returned ten zeros, under a comment asserting that "the default `BrtBorder` in every corpus workbook
    // is 51 zero bytes". It is not, and the claim was never checked against them; the byte is one flag away in a
    // record that is otherwise all zeros, which is exactly the kind of thing an eye slides over.
    //
    // Not `encodeColor(undefined)` either: that writes the automatic *palette index* 64, which is right for a
    // font whose colour is unstated and is not what Excel puts on an absent edge.
    const blxf = new Uint8Array(BLXF_SIZE);
    blxf[BLXF_COLOR_OFFSET] = VALID_RGB;
    return blxf;
  }
  return concatUint8Arrays([
    new BinaryWriter().writeUint8(index).writeUint8(0).toUint8Array(),
    encodeColor(border?.color)
  ]);
}

function readBlxf(reader: BinaryReader): Partial<Border> | undefined {
  const index = reader.readUint8();
  reader.readUint8(); // reserved
  const color = readColor(reader);
  const style = BORDER_STYLE[index];
  if (style === undefined) {
    return undefined;
  }
  return {
    style,
    ...(Object.keys(color).length === 0 ? {} : { color: color as Partial<Color> })
  };
}
