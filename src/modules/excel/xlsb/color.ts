/**
 * `BrtColor` — the eight-byte colour structure BIFF12 uses everywhere a colour appears.
 *
 * This is the one structure shared by fonts, fills, borders and differential formats, so it is
 * worth establishing once rather than four times. Its layout was read out of nine
 * Excel-authored workbooks, and what makes the reading trustworthy is that all four colour
 * *kinds* appear in that corpus and each one is internally consistent — the RGB bytes agree with
 * what the index means:
 *
 * | Bytes                     | Reading                        | Why it is not a coincidence          |
 * | ------------------------- | ------------------------------ | ------------------------------------ |
 * | `01 40 00 00 00 00 00 00` | automatic, index 64            | 64 is the automatic-colour index     |
 * | `03 08 00 00 00 00 00 ff` | indexed 8, opaque black        | palette slot 8 *is* black            |
 * | `05 ff 00 00 ff ff ff ff` | RGB, opaque white              | RGB kind carries real bytes          |
 * | `07 01 00 00 00 00 00 ff` | theme slot 1, opaque black     | theme slot 1 is the dark text colour |
 *
 * Had the field division been wrong, those four would not have agreed with each other.
 *
 * **The byte order is `R G B A`, not `A R G B`.** The model spells a colour `argb` and the file
 * spells it the other way round, which is a difference that produces a plausible-looking wrong
 * colour rather than an error.
 */
import type { Color } from "@excel/types";
import { INFERRED_VALUES } from "@excel/xlsb/spec/records";
import type { BinaryReader } from "@utils/binary";
import { BinaryWriter } from "@utils/binary";

/** How the remaining fields of a `BrtColor` are to be read. */
export const COLOR_KIND = {
  /** The consumer's default text or background colour. `index` says which. */
  automatic: 0,
  /** A slot in the legacy 56-entry palette. */
  indexed: 1,
  /** The `bRed`/`bGreen`/`bBlue`/`bAlpha` bytes carry the colour. */
  rgb: 2,
  /** A slot in the document theme, which the `theme1.xml` part resolves. */
  theme: 3
} as const;

/**
 * The `fValidRGB` bit — "the four colour bytes are meaningful".
 *
 * Every colour in the corpus sets it, because Excel resolves an index or a theme slot to its RGB
 * and writes both: index 8 comes with `00 00 00 ff`, index 65 with `ff ff ff ff`, index 64 with
 * zeros. That redundancy is what let the layout be established in the first place.
 *
 * This writer only sets the bit for a colour that *is* an RGB. Resolving a palette index or a
 * theme slot needs a 56-entry palette and the `theme1.xml` part, neither of which is available
 * here, and writing a plausible-looking wrong RGB with the bit set is worse than writing none:
 * a consumer honouring the bit would render the wrong colour instead of falling back to the
 * index, which is correct. Clearing the bit is the one bit pattern here the corpus does not
 * contain, and it is the conservative direction.
 *
 * ## Do not "fix" this with `themeIndexToName`
 *
 * The temptation is obvious — the theme part *is* written now (see `themeParts` in
 * `write/package.ts`), and `@excel/chart/shared/chart-utils` already exports a theme index → slot
 * name mapping. Following it would be wrong, and measurably so.
 *
 * `themeIndexToName(1)` is `lt1`, which in the built-in theme is `sysClr window` — **white**.
 * Excel's own `BrtFont` for the default font carries theme index 1 with the resolved RGB
 * `00 00 00 ff` — **black**. So the chart mapping is not the cell-style mapping: Excel's styles
 * number the first four slots the way its UI names them ("Background 1, Text 1, Background 2,
 * Text 2"), which puts `lt1` at 0 and `dk1` at 1 — the reverse of the document order the chart
 * mapping follows. Resolving a default font through the chart table would set `fValidRGB` on a
 * white text colour.
 *
 * A correct resolver therefore needs its own twelve-entry table, and Excel's bytes confirm exactly
 * **one** of those entries. Twelve values inferred from one is the shape of mistake this file exists
 * to avoid, so the bit stays clear until a corpus sample pins the rest. The cost of leaving it is
 * two bytes per colour against Excel's output and nothing at all in behaviour — `fValidRGB = 0` is
 * defined as "ignore the RGB bytes and use the index", which is what a consumer must then do.
 */
export const VALID_RGB = 0x01;

/** Bytes in a `BrtColor`. */
export const COLOR_SIZE = 8;

/**
 * The index Excel uses for the automatic foreground colour.
 *
 * Established from the corpus: every font with colour kind `automatic` carries exactly this.
 */
const AUTOMATIC_INDEX = 64;

/**
 * `nTintAndShade` is a signed fraction of this, so a tint of `-1`…`1` spans the `int16` range.
 *
 * No corpus colour carries a non-zero tint, so this scale is *not* established from Excel's
 * output — see {@link INFERRED}. It is, however, the scale the XLSX form of the same attribute
 * uses, and a zero tint round-trips regardless.
 */
const TINT_SCALE = INFERRED_VALUES.colorTintScale;

/**
 * Values this module writes that the reference corpus does not contain.
 *
 * Every layout here was established from real bytes. A handful of *values* were not, because no
 * workbook in the corpus exercises them, and they are collected here so the gap is one list a
 * future reader can check against a new sample rather than a belief spread through the file.
 */

/** Read a `BrtColor` at the reader's position. */
export function readColor(reader: BinaryReader): Partial<Color> {
  const flags = reader.readUint8();
  const index = reader.readUint8();
  const tint = reader.readInt16();
  const red = reader.readUint8();
  const green = reader.readUint8();
  const blue = reader.readUint8();
  const alpha = reader.readUint8();

  const color: Partial<Color> = {};
  if (tint !== 0) {
    color.tint = tint / TINT_SCALE;
  }

  switch ((flags >> 1) & 0x7f) {
    case COLOR_KIND.indexed:
      color.indexed = index;
      break;
    case COLOR_KIND.theme:
      color.theme = index;
      break;
    case COLOR_KIND.rgb:
      color.argb = hex(alpha) + hex(red) + hex(green) + hex(blue);
      break;
    default:
      // Automatic. The index selects which default, and carries no colour of its own, so
      // there is nothing to report: an automatic colour is the absence of a choice.
      break;
  }
  return color;
}

/**
 * Encode a colour, or the automatic colour when there is nothing to say.
 *
 * A model colour can name a theme slot, a palette index and an ARGB string at once. Only one
 * fits in a `BrtColor`, so they are tried in the order Excel itself prefers: an explicit RGB
 * beats a theme reference, which beats a legacy palette index.
 */
export function encodeColor(color: Partial<Color> | undefined): Uint8Array {
  const writer = new BinaryWriter();
  const tint = Math.round(Math.max(-1, Math.min(1, color?.tint ?? 0)) * TINT_SCALE);

  const argb = color?.argb;
  if (argb !== undefined && /^[0-9a-fA-F]{6,8}$/.test(argb)) {
    // Six digits means no alpha was given; an opaque colour is the only sensible reading.
    const padded = argb.length === 6 ? `FF${argb}` : argb;
    const value = Number.parseInt(padded, 16);
    return (
      writer
        .writeUint8(VALID_RGB | (COLOR_KIND.rgb << 1))
        // Excel writes 0xff here for an RGB colour — "no palette index" — in both corpus fonts
        // that carry one.
        .writeUint8(0xff)
        .writeUint16(tint & 0xffff)
        .writeUint8((value >>> 16) & 0xff)
        .writeUint8((value >>> 8) & 0xff)
        .writeUint8(value & 0xff)
        .writeUint8((value >>> 24) & 0xff)
        .toUint8Array()
    );
  }

  // **A theme colour still carries `fValidRGB` and an opaque alpha.**
  //
  // The reasoning here was that a theme slot is resolved by the consumer, so the RGB bytes stay zero and the flag that
  // says "the RGB is meaningful" stays clear. That is a coherent reading and it is not what Excel does: every one of the
  // fifteen `BrtFont` records across the oracle's reference workbooks writes `07 01 00 00 00 00 00 ff` — `fValidRGB`
  // set, theme index 1, red/green/blue zero, **alpha 0xff**. Fifteen out of fifteen, so this is not one file's habit.
  //
  // Read as a whole it is consistent: the four colour bytes are `BGRA`, and an alpha of zero means fully transparent. A
  // consumer that honoured the RGB would draw nothing. Excel writes an opaque alpha and marks the field valid, and
  // leaves the *theme index* to say which colour it actually is — so the RGB is a fallback, not a contradiction.
  //
  // This was the largest single group of differences left against Excel's own files, and it had been dismissed as
  // "legitimate" once on exactly the reasoning above. A judgement that a difference is benign needs the same evidence
  // as a judgement that it is a defect.
  if (color?.theme !== undefined) {
    return writer
      .writeUint8(VALID_RGB | (COLOR_KIND.theme << 1))
      .writeUint8(color.theme & 0xff)
      .writeUint16(tint & 0xffff)
      .writeZeros(3)
      .writeUint8(0xff)
      .toUint8Array();
  }

  if (color?.indexed !== undefined) {
    return writer
      .writeUint8(COLOR_KIND.indexed << 1)
      .writeUint8(color.indexed & 0xff)
      .writeUint16(tint & 0xffff)
      .writeZeros(4)
      .toUint8Array();
  }

  // A font's absent colour, which is the shape `encodeColor` is called for. A sheet's absent tab
  // colour is spelled differently and asks for it explicitly — see `automaticColor`.
  return automaticColor(AUTOMATIC_INDEX, true);
}

/**
 * The automatic colour.
 *
 * `validRgb` exists because the two records that carry one disagree, and the disagreement is real
 * rather than noise: a `BrtFont`'s automatic colour is `01 40 …` with `fValidRGB` **set**, while a
 * `BrtWsProp`'s tab colour is `00 40 …` with it **clear**. Both readings hold across every sheet
 * and every font in the corpus, so this is a per-record convention and not a field this module got
 * wrong — which is the kind of thing only a byte-for-byte comparison surfaces.
 */
export function automaticColor(index: number, validRgb: boolean): Uint8Array {
  return (
    new BinaryWriter()
      .writeUint8((validRgb ? VALID_RGB : 0) | (COLOR_KIND.automatic << 1))
      .writeUint8(index)
      .writeUint16(0) // nTintAndShade
      .writeUint8(0) // bRed
      .writeUint8(0) // bGreen
      .writeUint8(0) // bBlue
      // **Zero, and deliberately.** `fValidRGB` set beside an all-zero RGBA reads as "a valid colour of fully
      // transparent black", and writing `0xff` here to resolve that was tried and is wrong: `date.xlsb`, a
      // file Excel wrote, carries exactly `01 40 00 00 00 00 00 00` for its automatic font colour. Excel does
      // not honour the flag for `xColorType` 0 — the index is what names the colour — so the apparent
      // contradiction is one Excel itself writes.
      //
      // Current Excel spells a default font's colour differently, as theme 1 with an opaque black companion
      // (`07 01 00 00 00 00 00 ff`). That is a different choice about *which* colour to name, not a different
      // encoding of this one, and both open.
      .writeUint8(0)
      .toUint8Array()
  );
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0").toUpperCase();
}
