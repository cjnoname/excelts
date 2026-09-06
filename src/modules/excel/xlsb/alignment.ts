/**
 * The alignment and protection bits inside a `BrtXF`.
 *
 * **How this was established.** Thirty-two cell formats across nine Excel-authored workbooks,
 * and the confirmation is a set of correlations rather than a single lucky value:
 *
 * - Byte 12 reads `0x10` on twenty-six of them, across eight files. Split as three bits of
 *   horizontal and three of vertical, that is `general` + `bottom` — which is exactly Excel's
 *   default alignment. The two exceptions read `0x08` (vertical `center`) and `0x12` (horizontal
 *   `center`), so the enumerations are pinned at 0, 1 and 2 in both directions.
 * - Byte 13 reads `0x10` on **all** thirty-two: bit 4, `fLocked`. A cell in Excel is locked
 *   unless you unlock it, so a corpus in which every format is locked is what a correct reading
 *   predicts, and any other bit position would not have been uniformly set.
 * - Byte 14 is `xfGrbitAtr`, the mask saying which attributes this format overrides. In
 *   `issues.xlsb` bit 0 is set on precisely the formats with a non-zero `iFmt`, and bit 1 on
 *   precisely those with a non-zero `iFont`. A mask that tracks two other fields across four
 *   records is not at the wrong offset.
 * - Byte 10 is `trot`, and one format in `issue127.xlsb` carries `0x5a` — 90 degrees.
 *
 * **What is not established.** `fWrap`, `fShrinkToFit`, `fHidden` and the reading order are zero
 * throughout the corpus, and the alignment enumerations are confirmed only at 0, 1 and 2. Values
 * past that follow the documented order the XLSX form of the same attribute uses, and are listed
 * in `INFERRED_VALUES` so the distinction survives.
 */
import type { Alignment, Protection } from "@excel/types";

/** Byte offsets within a `BrtXF` payload, all established from the corpus. */
export const XF_ROTATION_OFFSET = 10;
export const XF_INDENT_OFFSET = 11;
export const XF_ALIGNMENT_OFFSET = 12;
export const XF_PROTECTION_OFFSET = 13;
export const XF_ATTRIBUTE_MASK_OFFSET = 14;

/**
 * Horizontal alignment, by `alc` value — MS-XLSB 2.5.74.
 *
 * Eight values, `ALCGEN` through `ALCDIST`. The published table also carries `ALCNIL` at `0xFF` for
 * "alignment not specified", which this array cannot index and does not need to: the model spells the
 * absence of a choice by omitting the field, and `general` at 0 is what Excel writes for it.
 */
const HORIZONTAL: readonly (Alignment["horizontal"] | undefined)[] = [
  undefined, // general — the absence of a choice, which the model spells by omitting the field
  "left",
  "center",
  "right",
  "fill",
  "justify",
  "centerContinuous",
  "distributed"
];

/**
 * Vertical alignment, by `alcV` value — MS-XLSB 2.5.158.
 *
 * The five values were first established by reading Excel's own output, with a comment saying so. The
 * enumeration is published and says the same thing, so the inference is now a citation.
 */
const VERTICAL: readonly (Alignment["vertical"] | undefined)[] = [
  "top",
  "middle",
  undefined, // bottom — Excel's default, so the model omits it rather than restating it
  "justify",
  "distributed"
];

/**
 * Reading order, by `iReadingOrder` value — MS-XLSB 2.5.114.
 *
 * Three values: context, left-to-right, right-to-left. Every corpus workbook carries 0, so the two non-zero
 * values are unexercised by any sample here — but they are published rather than guessed, which is the
 * difference between an unobserved value and an inferred one.
 */
const READING_ORDER: readonly (Alignment["readingOrder"] | undefined)[] = [undefined, "ltr", "rtl"];

/**
 * The two bytes of alignment and protection bits — MS-XLSB 2.4.876.
 *
 * ```text
 * byte 2   alc(0-2)  alcv(3-5)  fWrap(6)  fJustLast(7)
 * byte 3   fShrinkToFit(0)  fMergeCell(1)  iReadingOrder(2-3)  fLocked(4)  fHidden(5)
 * ```
 *
 * The split matters: `fWrap` sits in the *first* byte immediately above the two three-bit alignments, while
 * `fShrinkToFit` starts the second. Reading them as one sixteen-bit field and counting attributes in order
 * places `fShrinkToFit` at bit 8, which is `fMergeCell` shifted — and a cell would come back merged.
 *
 * `WRAP` and `SHRINK_TO_FIT` were in the inferred register, described as unexercised by the corpus. They are
 * published, so they are citations now; the register is for values Excel's bytes and the specification both
 * leave open.
 */
const WRAP = 0x40;
const SHRINK_TO_FIT = 0x01;
/** `fLocked`. Set on every cell format in the corpus, which is also Excel's default. */
const LOCKED = 0x10;
/** `fHidden`. Zero throughout the corpus. */
const HIDDEN = 0x20;

/** Bits of `xfGrbitAtr` — which attributes the format overrides rather than inheriting. */
export const ATTRIBUTE_MASK = {
  numberFormat: 0x01,
  font: 0x02,
  alignment: 0x04,
  border: 0x08,
  fill: 0x10,
  protection: 0x20
} as const;

/** The rotation `trot` uses for vertically stacked text, which is not an angle. */
const STACKED_ROTATION = 255;

/** Read the alignment a `BrtXF` declares, or `undefined` when it declares only defaults. */
export function readAlignment(payload: Uint8Array): Partial<Alignment> | undefined {
  if (payload.length <= XF_ATTRIBUTE_MASK_OFFSET) {
    return undefined;
  }
  const rotation = payload[XF_ROTATION_OFFSET]!;
  const indent = payload[XF_INDENT_OFFSET]!;
  const bits = payload[XF_ALIGNMENT_OFFSET]!;
  const more = payload[XF_PROTECTION_OFFSET]!;

  const alignment: Partial<Alignment> = {};
  const horizontal = HORIZONTAL[bits & 0x07];
  if (horizontal !== undefined) {
    alignment.horizontal = horizontal;
  }
  const vertical = VERTICAL[(bits >> 3) & 0x07];
  if (vertical !== undefined) {
    alignment.vertical = vertical;
  }
  if ((bits & WRAP) !== 0) {
    alignment.wrapText = true;
  }
  if ((more & SHRINK_TO_FIT) !== 0) {
    alignment.shrinkToFit = true;
  }
  const readingOrder = READING_ORDER[(more >> 2) & 0x03];
  if (readingOrder !== undefined) {
    alignment.readingOrder = readingOrder;
  }
  if (indent !== 0) {
    alignment.indent = indent;
  }
  if (rotation === STACKED_ROTATION) {
    alignment.textRotation = "vertical";
  } else if (rotation !== 0) {
    alignment.textRotation = rotation;
  }
  return Object.keys(alignment).length === 0 ? undefined : alignment;
}

/** Read the protection a `BrtXF` declares, or `undefined` when it declares only defaults. */
export function readProtection(payload: Uint8Array): Partial<Protection> | undefined {
  if (payload.length <= XF_PROTECTION_OFFSET) {
    return undefined;
  }
  const bits = payload[XF_PROTECTION_OFFSET]!;
  const protection: Partial<Protection> = {};
  // Locked is the default, so only its *absence* is worth reporting — the same reasoning that
  // keeps `bottom` and `general` out of the alignment result.
  if ((bits & LOCKED) === 0) {
    protection.locked = false;
  }
  if ((bits & HIDDEN) !== 0) {
    protection.hidden = true;
  }
  return Object.keys(protection).length === 0 ? undefined : protection;
}

/** The six bytes of a `BrtXF` from `trot` onwards. */
export function encodeAlignmentAndProtection(
  alignment: Partial<Alignment> | undefined,
  protection: Partial<Protection> | undefined,
  overrides: number
): Uint8Array {
  let bits = 0;
  const horizontal = alignment?.horizontal;
  if (horizontal !== undefined) {
    const value = HORIZONTAL.indexOf(horizontal);
    if (value > 0) {
      bits |= value;
    }
  }
  // Bottom is the default and the model omits it, so an absent vertical must encode as 2 — not
  // as 0, which is `top`. Defaulting the wrong way silently moves every cell's text.
  const vertical = alignment?.vertical;
  const verticalValue = vertical === undefined ? 2 : Math.max(VERTICAL.indexOf(vertical), 0);
  bits |= verticalValue << 3;
  if (alignment?.wrapText === true) {
    bits |= WRAP;
  }

  let more = 0;
  if (alignment?.shrinkToFit === true) {
    more |= SHRINK_TO_FIT;
  }
  const readingOrder = alignment?.readingOrder;
  if (readingOrder !== undefined) {
    const value = READING_ORDER.indexOf(readingOrder);
    if (value > 0) {
      more |= value << 2;
    }
  }
  // Locked unless explicitly unlocked, which is what every corpus format carries.
  if (protection?.locked !== false) {
    more |= LOCKED;
  }
  if (protection?.hidden === true) {
    more |= HIDDEN;
  }

  const rotation =
    alignment?.textRotation === "vertical"
      ? STACKED_ROTATION
      : Math.max(0, Math.min(255, Math.round(alignment?.textRotation ?? 0)));

  return new Uint8Array([
    rotation,
    Math.max(0, Math.min(255, Math.round(alignment?.indent ?? 0))),
    bits,
    more,
    overrides,
    0
  ]);
}
