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
 * The `FontFlags` bits — MS-XLSB 2.5.53.
 *
 * These were in the inferred register, described as values borrowed from the XLSX form of this format and
 * from OpenType because no corpus font sets any of them. `FontFlags` is a published structure and gives all
 * six positions, so they are citations now:
 *
 * ```text
 * bit 0  unused1     bit 4  fOutline
 * bit 1  fItalic     bit 5  fShadow
 * bit 2  unused2     bit 6  fCondense
 * bit 3  fStrikeout  bit 7  fExtend
 * ```
 *
 * Note the two unused bits at 0 and 2: the six flags are *not* contiguous, so a table built by counting
 * attributes in order would place every one of them wrongly from `fStrikeout` on.
 */
const FONT_FLAGS = {
  italic: 0x0002,
  strike: 0x0008,
  outline: 0x0010,
  shadow: 0x0020,
  condense: 0x0040,
  extend: 0x0080
} as const;

/**
 * `BrtFont.bls` for a bold font — **observed, no longer inferred.**
 *
 * This said "a single workbook containing one bold cell would settle it", and three of them do: `poi-comments.xlsb`,
 * `poi-sample.xlsb` and `poi-testVarious.xlsb` carry five bold fonts between them and every one is **700**, against 42
 * regular fonts at 400 across the same corpus. Three independently-produced files agreeing is what turns the OpenType
 * convention into a reading of this format.
 *
 * Kept as its own constant rather than folded into `FONT_FLAGS` because it is a *weight*, not a flag — the field takes a
 * range and this is one point in it.
 */
export const INFERRED_FONT_VALUES = {
  weightBold: INFERRED_VALUES.fontWeightBold,
  ...FONT_FLAGS
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
    // **`true` for a plain single underline, because that is what the XLSX reader produces for the same font.**
    //
    // `<u/>` carries no `val`, so `UnderlineXform.parseOpen` reads `attributes.val || true` and yields `true`; this
    // reader yielded `"single"` from the enumeration byte. Both mean one underline and both writers accept either, so
    // nothing was lost — but the same font read through the two containers compared unequal, which is the container
    // leaking into the model that `verify:xlsb-corpus`'s parity check exists to catch. It found this on `poi-sample`'s
    // rich-text run.
    //
    // The other four names are unambiguous and stay as they are; only the single case has a shorthand.
    font.underline = underlineName === "single" ? true : underlineName;
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
 *
 * **The baseline includes the colour**, and it did not. Without it `encodeColor` fell through to its last
 * branch and wrote the automatic colour (`01 40 …`) — a `BrtColor` of kind *automatic* carrying palette index
 * 64 — while Excel writes theme slot 1 (`07 01 … ff`) for the same font, and this library's own XLSX writer
 * emits `<color theme="1"/>`. So a from-scratch workbook described its default text colour one way in the XML
 * container and another in the binary one, and every one of the fifteen oracle cases differed on this record
 * for that single reason.
 *
 * The value is deliberately the same literal the XLSX side uses (`styles-xform.ts`'s default font), because
 * these are one fact about one workbook and a second copy is how the two came to disagree in the first place.
 * Theme slot 1 is `lt1`/text-1 — near-black — which is what "no colour specified" has always rendered as.
 */
export function defaultFont(override?: Partial<Font>): Uint8Array {
  return encodeFont({
    name: "Calibri",
    size: 11,
    family: 2,
    scheme: "minor",
    color: { theme: 1 },
    ...override
  });
}

/**
 * The `Underline` enumeration value for a model underline.
 *
 * Exported because a *differential* format needs the same mapping: `XFProp` type `0x1A` carries an `Underline`,
 * and the DXF encoder had no underline branch at all — so a conditional-formatting rule whose only formatting
 * was an underline produced a `BrtDXF` with **zero properties**, six bytes of header and nothing else. A second
 * copy of the enumeration is how the two would come to disagree about `singleAccounting`.
 */
export function underlineValue(underline: Partial<Font>["underline"]): number {
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
