/**
 * `BrtFont` — the font table entry.
 *
 * **How this layout was established.** Fifteen fonts across nine Excel-authored workbooks, and
 * the reading is self-checking: the name is an `XLWideString` at offset 21, so `25 + 2 × cch`
 * must equal the payload length exactly. It does for all fifteen, at four different name lengths
 * (`Arial`, `Calibri`, `FreeSans`, `等线`), which pins the header at 21 bytes.
 *
 * The division *within* those 21 bytes is pinned by values that cannot be coincidences:
 *
 * - `dyHeight` at 0 reads 200, 240, 220, 280, 180 across the corpus — exactly 10, 12, 11, 14 and
 *   9 point in twentieths. A wrong offset or scale would not produce five integral point sizes.
 * - `bCharSet` at 10 reads **204** in the workbook whose style name is `Обычный`, and **134** in
 *   the one whose font is named `等线`. 204 is Windows Cyrillic and 134 is GB2312. A byte that
 *   tracks the document's language is not at the wrong offset.
 * - `bFontScheme` at 20 reads **2** — minor — on precisely the 11-point Calibri fonts, which is
 *   Excel's default theme font, and 0 on every font that is not a theme font.
 * - `brtColor` at 12 spans all four colour kinds, each internally consistent. See `color.ts`.
 *
 * **What is *not* established, and this matters.** Every font in the corpus is regular weight
 * (`bls` = 400) and has `grbit` = 0. So the corpus fixes the offsets of the bold and italic
 * fields but never exercises their "on" state, and the values used for it are collected in
 * {@link INFERRED_FONT_VALUES} rather than scattered through this file — one list to check
 * against a new sample, which `INFERRED_VALUES` registers and `spec.test.ts` pins.
 */
import type { Font } from "@excel/types";
import { encodeWideString, readWideString } from "@excel/xlsb/binary";
import { COLOR_SIZE, encodeColor, readColor } from "@excel/xlsb/color";
import { INFERRED_VALUES } from "@excel/xlsb/spec/records";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/**
 * Bytes before the name's character count.
 *
 * Confirmed by `FONT_HEADER_SIZE + 4 + 2 × cch === payload.length` on fifteen real fonts at four
 * different name lengths. Exported because the test derives its self-check from it rather than
 * from a second copy of the number: a constant a test restates as a literal is a constant no test
 * is actually checking.
 */
export const FONT_HEADER_SIZE = 21;

/** Offset of `grbit` — the toggles — within the header. */
export const GRBIT_OFFSET = 2;

/** `dyHeight` is a point size in twentieths. 220 is Excel's default 11pt. */
const TWENTIETHS_PER_POINT = 20;

/** Weight for a regular font. Read from all fifteen corpus fonts. */
const WEIGHT_REGULAR = 400;

/**
 * Weight for a bold font, and the `grbit` bits for the toggles.
 *
 * **None of these appear in the reference corpus**, whose fonts are all regular with `grbit` = 0.
 * The offsets they sit at *are* established; only the values are not. They are the values the
 * same attributes take in the XLSX form of this format and in OpenType, so they are inferences
 * from a documented convention rather than from Excel's own bytes — a distinction this module
 * keeps visible rather than quietly collapsing.
 *
 * A single workbook containing one bold and one italic cell would settle every entry here.
 */
export const INFERRED_FONT_VALUES = {
  weightBold: INFERRED_VALUES.fontWeightBold,
  italic: INFERRED_VALUES.fontItalic,
  strike: INFERRED_VALUES.fontStrike,
  outline: INFERRED_VALUES.fontOutline,
  shadow: INFERRED_VALUES.fontShadow,
  condense: INFERRED_VALUES.fontCondense,
  extend: INFERRED_VALUES.fontExtend
} as const;

/** `uls` values. Only `single` (1) appears in the corpus. */
const UNDERLINE = {
  none: 0,
  single: 1,
  double: 2,
  singleAccounting: 33,
  doubleAccounting: 34
} as const;

/** `sss` values. None appears in the corpus; the field is 0 throughout. */
const VERTICAL_ALIGN = { none: 0, superscript: 1, subscript: 2 } as const;

/** `bFontScheme`. `minor` (2) is established from Excel's default Calibri. */
const SCHEME = { none: 0, major: 1, minor: 2 } as const;

/** Read a `BrtFont` payload. */
export function readFont(payload: Uint8Array, part: string): Partial<Font> | undefined {
  if (payload.length < FONT_HEADER_SIZE + 4) {
    return undefined;
  }
  const reader = new BinaryReader(payload, 0, part);
  const height = reader.readUint16();
  const grbit = reader.readUint16();
  const weight = reader.readUint16();
  const vertical = reader.readUint16();
  const underline = reader.readUint8();
  const family = reader.readUint8();
  const charset = reader.readUint8();
  reader.skip(1); // unused
  const color = readColor(reader);
  const scheme = reader.readUint8();

  let name: string;
  try {
    name = readWideString(reader, part);
  } catch {
    // A truncated name costs the font, not the styles part.
    return undefined;
  }

  const font: Partial<Font> = { name, size: height / TWENTIETHS_PER_POINT };
  if (weight >= INFERRED_FONT_VALUES.weightBold) {
    font.bold = true;
  }
  if ((grbit & INFERRED_FONT_VALUES.italic) !== 0) {
    font.italic = true;
  }
  if ((grbit & INFERRED_FONT_VALUES.strike) !== 0) {
    font.strike = true;
  }
  if ((grbit & INFERRED_FONT_VALUES.outline) !== 0) {
    font.outline = true;
  }
  if ((grbit & INFERRED_FONT_VALUES.shadow) !== 0) {
    font.shadow = true;
  }
  if ((grbit & INFERRED_FONT_VALUES.condense) !== 0) {
    font.condense = true;
  }
  if ((grbit & INFERRED_FONT_VALUES.extend) !== 0) {
    font.extend = true;
  }
  if (family !== 0) {
    font.family = family;
  }
  if (charset !== 0) {
    font.charset = charset;
  }
  if (Object.keys(color).length > 0) {
    font.color = color;
  }
  const underlineName = nameOf(UNDERLINE, underline);
  if (underlineName !== undefined && underlineName !== "none") {
    font.underline = underlineName;
  }
  const verticalName = nameOf(VERTICAL_ALIGN, vertical);
  if (verticalName === "superscript" || verticalName === "subscript") {
    font.vertAlign = verticalName;
  }
  const schemeName = nameOf(SCHEME, scheme);
  // `none` is the absence of a theme role, so reporting it would add a field the writer never
  // set. A font *must* carry a name, a size and a scheme byte — there is no way to encode "no
  // name" — so the two that cannot be omitted are reported and the one that can is not.
  if (schemeName === "major" || schemeName === "minor") {
    font.scheme = schemeName;
  }
  return font;
}

/** Serialise a `BrtFont`. */
export function encodeFont(font: Partial<Font>): Uint8Array {
  let grbit = 0;
  if (font.italic === true) {
    grbit |= INFERRED_FONT_VALUES.italic;
  }
  if (font.strike === true) {
    grbit |= INFERRED_FONT_VALUES.strike;
  }
  if (font.outline === true) {
    grbit |= INFERRED_FONT_VALUES.outline;
  }
  if (font.shadow === true) {
    grbit |= INFERRED_FONT_VALUES.shadow;
  }
  if (font.condense === true) {
    grbit |= INFERRED_FONT_VALUES.condense;
  }
  if (font.extend === true) {
    grbit |= INFERRED_FONT_VALUES.extend;
  }

  return concatUint8Arrays([
    new BinaryWriter()
      .writeUint16(Math.round((font.size ?? 11) * TWENTIETHS_PER_POINT))
      .writeUint16(grbit)
      .writeUint16(font.bold === true ? INFERRED_FONT_VALUES.weightBold : WEIGHT_REGULAR)
      .writeUint16(VERTICAL_ALIGN[font.vertAlign ?? "none"])
      .writeUint8(underlineValue(font.underline))
      .writeUint8(font.family ?? 0)
      .writeUint8(font.charset ?? 0)
      .writeUint8(0)
      .toUint8Array(),
    encodeColor(font.color),
    new BinaryWriter().writeUint8(SCHEME[font.scheme ?? "none"]).toUint8Array(),
    encodeWideString(font.name ?? "Calibri")
  ]);
}

/**
 * The font at index 0: Excel's own default, with the workbook's overrides applied.
 *
 * Index 0 is what every cell that names no font inherits, so a workbook whose author set a default of
 * Arial 10 and got Calibri 11 has had *every unstyled cell* restyled. The baseline is kept underneath
 * rather than replaced because a partial `defaultFont` — `{ name: "Arial" }` and nothing else — must
 * still produce the complete record `BrtFont` requires.
 */
export function defaultFont(override?: Partial<Font>): Uint8Array {
  return encodeFont({ name: "Calibri", size: 11, family: 2, scheme: "minor", ...override });
}

function underlineValue(underline: Partial<Font>["underline"]): number {
  if (underline === undefined || underline === false || underline === "none") {
    return UNDERLINE.none;
  }
  // `true` is the xlsx shorthand for a single underline.
  return underline === true ? UNDERLINE.single : UNDERLINE[underline];
}

function nameOf<T extends Record<string, number>>(table: T, value: number): keyof T | undefined {
  for (const key of Object.keys(table) as (keyof T)[]) {
    if (table[key] === value) {
      return key;
    }
  }
  return undefined;
}

/**
 * Count of `grbit` bits this module does not model, for a font payload.
 *
 * One workbook in the reference corpus — the one not written by Excel — sets bit 2, which none of
 * the modelled toggles claims. Its meaning is not establishable from a single sample, so the bit
 * is neither interpreted nor silently discarded: it is counted, and the count surfaces on the
 * read result. A reader that quietly dropped it would make a lossy round trip look lossless.
 */
export function unmodelledFlagsOf(payload: Uint8Array): number {
  if (payload.length < FONT_HEADER_SIZE) {
    return 0;
  }
  const grbit = new BinaryReader(payload, GRBIT_OFFSET).readUint16();
  const modelled =
    INFERRED_FONT_VALUES.italic |
    INFERRED_FONT_VALUES.strike |
    INFERRED_FONT_VALUES.outline |
    INFERRED_FONT_VALUES.shadow |
    INFERRED_FONT_VALUES.condense |
    INFERRED_FONT_VALUES.extend;
  return popcount(grbit & ~modelled);
}

function popcount(value: number): number {
  let bits = value;
  let count = 0;
  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

/** Bytes a `BrtColor` occupies inside a font, re-exported so the spec table can assert it. */
export const FONT_COLOR_SIZE = COLOR_SIZE;
