/**
 * Auto filters and ignored errors — two small worksheet records with the same shape of payload.
 *
 * **`BrtBeginAFilter`** (MS-XLSB 2.4.8) is sixteen bytes: the range the filter covers, and nothing else.
 * The *criteria* live in the `BrtBeginFilterColumn` collection it opens, which this module does not
 * write — so an auto filter round-trips as the dropdowns being present on the right range, and any
 * filter a person had applied is reported as lost. That is the honest split: the range is what makes the
 * arrows appear, and it is what the model carries.
 *
 * **`BrtCellIgnoreEC`** (MS-XLSB 2.4.322) is a nine-bit flag word and then an `UncheckedSqRfX` — the same
 * counted range array `BrtDVal` uses. `crfx` here is bounded only above (under 8,192), so unlike
 * `BrtDVal` a zero count is legal; a record covering no range still says nothing, so it is not written.
 *
 * The flag order is the record's and **not** the model's field order. `ffecCalcError` comes first and
 * the model calls it `evalError`; `ffecNumStoredAsText` is third and is the one people recognise as the
 * green triangle. Mapping these by position rather than by name would silently swap which warnings a
 * sheet suppresses.
 */
import type { IgnoredError } from "@excel/types";
import { encodeRange, rangeReference, readRange, tryDecodeRange } from "@excel/xlsb/binary";
import { BinaryReader, BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** Serialise a `BrtBeginAFilter`, or `undefined` when the reference does not decode. */
export function encodeAutoFilter(reference: string): Uint8Array | undefined {
  const range = tryDecodeRange(reference);
  return range === undefined ? undefined : encodeRange(range);
}

/** Read a `BrtBeginAFilter` back to an `A1:B2` reference. */
export function readAutoFilter(payload: Uint8Array, part: string): string | undefined {
  try {
    return rangeReference(readRange(new BinaryReader(payload, 0, part)));
  } catch {
    return undefined;
  }
}

/**
 * `BrtCellIgnoreEC`'s flags, in the record's own bit order.
 *
 * Each entry is the model's name for that bit. The order is what matters and is why this is a list
 * rather than a map: bit 0 is `ffecCalcError`, which the model calls `evalError`.
 */
const IGNORED_FLAGS: readonly (keyof IgnoredError)[] = [
  "evalError", // A: ffecCalcError
  "emptyCellReference", // B: ffecEmptyCellRef
  "numberStoredAsText", // C: ffecNumStoredAsText
  "formulaRange", // D: ffecInconsistRange
  "formula", // E: ffecInconsistFmla
  "twoDigitTextYear", // F: ffecTextDateInsuff
  "unlockedFormula", // G: ffecUnprotFmla
  "listDataValidation", // H: ffecDataValidation
  "calculatedColumn" // I: ffecCalcCol
];

/** Serialise a `BrtCellIgnoreEC`, or `undefined` when it would say nothing. */
export function encodeIgnoredError(entry: IgnoredError): Uint8Array | undefined {
  const range = tryDecodeRange(entry.ref);
  if (range === undefined) {
    return undefined;
  }
  let flags = 0;
  IGNORED_FLAGS.forEach((name, bit) => {
    flags |= entry[name] === true ? 1 << bit : 0;
  });
  if (flags === 0) {
    // A record that ignores nothing is a record with no effect. Excel does not write one.
    return undefined;
  }
  return concatUint8Arrays([
    new BinaryWriter().writeUint32(flags).writeInt32(1).toUint8Array(),
    encodeRange(range)
  ]);
}

/** Read a `BrtCellIgnoreEC`. One entry per range it covers, because the model keys them by range. */
export function readIgnoredErrors(payload: Uint8Array, part: string): readonly IgnoredError[] {
  try {
    const reader = new BinaryReader(payload, 0, part);
    const flags = reader.readUint32();
    const count = reader.readInt32();
    if (count < 1 || count >= 8192) {
      return [];
    }
    const settings: Partial<IgnoredError> = {};
    IGNORED_FLAGS.forEach((name, bit) => {
      if ((flags & (1 << bit)) !== 0) {
        settings[name] = true as never;
      }
    });
    const entries: IgnoredError[] = [];
    for (let index = 0; index < count; index++) {
      entries.push({ ...settings, ref: rangeReference(readRange(reader)) });
    }
    return entries;
  } catch {
    return [];
  }
}
