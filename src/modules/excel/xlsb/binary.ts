/**
 * BIFF12 record framing and value primitives.
 *
 * A `.bin` part is a flat sequence of records:
 *
 * ```text
 * record id (1–2 bytes, varint) | payload length (1–4 bytes, varint) | payload
 * ```
 *
 * Everything that reads or writes a `.bin` part goes through this file. That is
 * not tidiness — it is the only way malformed input behaves consistently. When
 * each part parser decodes its own headers, every one of them grows a slightly
 * different bounds check, and the difference only shows up on a file none of them
 * were tested against.
 *
 * The scalar reads and writes come from `@utils/binary`, which is also what the
 * ZIP and CFB code uses. This file adds the two things BIFF12 has of its own: the
 * variable-length header, and the handful of value encodings that appear in
 * payloads.
 */

import { XlsbParseError } from "@excel/errors";
import { decodeRange, encodeRange as encodeRangeAddress } from "@excel/utils/address";
import { MAX_RECORD_ID } from "@excel/xlsb/spec/records";
import type { BinaryReader } from "@utils/binary";
import { BinaryWriter, concatUint8Arrays, decodeBytesToString } from "@utils/binary";

/** One framed record, with the payload as a view into the source. */
export interface BiffRecord {
  readonly id: number;
  readonly payload: Uint8Array;
  /** Offset of the record's first header byte, for error messages. */
  readonly offset: number;
}

/**
 * Walk the records in a `.bin` part.
 *
 * Both header fields are validated before the payload is sliced, so a declared
 * length that runs past the end is reported at the record that declared it rather
 * than surfacing as a confusing failure in whatever the next read happens to be.
 *
 * @param context Part name, quoted in any error.
 */
export function* iterateBiffRecords(bytes: Uint8Array, context: string): Generator<BiffRecord> {
  let offset = 0;
  while (offset < bytes.length) {
    const recordOffset = offset;

    const id = readVarUInt(bytes, offset, 2, context, "record id");
    offset = id.next;
    const length = readVarUInt(bytes, offset, 4, context, "record length");
    offset = length.next;

    // No upper-bound check on the id: a two-byte varint holds seven value bits per
    // byte, so it cannot exceed 0x3FFF, which is already below MAX_RECORD_ID. The
    // limit is enforced where it is reachable — on the writing side, where a caller
    // supplies the number.
    if (length.value > bytes.length - offset) {
      throw new XlsbParseError(
        context,
        `record ${id.value} at byte ${recordOffset} declares ${length.value} byte(s), ` +
          `but only ${bytes.length - offset} remain`
      );
    }

    yield {
      id: id.value,
      payload: bytes.subarray(offset, offset + length.value),
      offset: recordOffset
    };
    offset += length.value;
  }
}

/** Read the whole part into an array. Convenient where streaming buys nothing. */
export function readBiffRecords(bytes: Uint8Array, context: string): BiffRecord[] {
  return [...iterateBiffRecords(bytes, context)];
}

interface VarUInt {
  readonly value: number;
  readonly next: number;
}

function readVarUInt(
  bytes: Uint8Array,
  start: number,
  maxBytes: number,
  context: string,
  label: string
): VarUInt {
  let value = 0;
  let offset = start;
  for (let i = 0; i < maxBytes; i++) {
    if (offset >= bytes.length) {
      throw new XlsbParseError(context, `truncated ${label} at byte ${start}`);
    }
    const byte = bytes[offset++]!;
    // Multiplication rather than `<<`: a four-byte length reaches bit 28, and
    // `1 << 28` is still fine but `value | (byte << 28)` coerces to int32 and turns
    // a large length negative. Arithmetic keeps it a safe integer.
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) {
      return { value, next: offset };
    }
  }
  throw new XlsbParseError(context, `${label} at byte ${start} exceeds ${maxBytes} byte(s)`);
}

/** Encode a record identifier or payload length. */
export function encodeVarUInt(value: number, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`BIFF12 variable integer must be a non-negative integer: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0 && bytes.length < maxBytes);
  if (remaining > 0) {
    throw new RangeError(`BIFF12 variable integer ${value} does not fit in ${maxBytes} byte(s)`);
  }
  return new Uint8Array(bytes);
}

/** Frame one record. */
export function encodeBiffRecord(id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!Number.isInteger(id) || id < 0 || id >= MAX_RECORD_ID) {
    throw new RangeError(`BIFF12 record id must be an integer in [0, ${MAX_RECORD_ID}): ${id}`);
  }
  const idBytes = encodeVarUInt(id, 2);
  const lengthBytes = encodeVarUInt(payload.length, 4);
  return concatUint8Arrays(
    [idBytes, lengthBytes, payload],
    idBytes.length + lengthBytes.length + payload.length
  );
}

/** Frame a sequence of records into one part. */
export function encodeBiffRecords(
  records: readonly { id: number; payload?: Uint8Array }[]
): Uint8Array {
  const framed = records.map(record => encodeBiffRecord(record.id, record.payload));
  return concatUint8Arrays(
    framed,
    framed.reduce((total, chunk) => total + chunk.length, 0)
  );
}

// =============================================================================
// Value encodings
// =============================================================================

/** Sentinel `cchCharacters` meaning "no string", used by `XLNullableWideString`. */
const NULL_STRING_LENGTH = 0xffffffff;

/**
 * Read an `XLWideString`: a `u32` code-unit count followed by UTF-16LE.
 *
 * The declared count is checked against what remains before allocating, because
 * it is attacker-controlled: a four-byte field can ask for two gigabytes of string
 * from an eight-byte record.
 */
export function readWideString(reader: BinaryReader, context: string): string {
  const units = reader.readUint32();
  return decodeWideStringBody(reader, units, context);
}

/** Read an `XLNullableWideString`, whose `0xFFFFFFFF` count means absent. */
export function readNullableWideString(reader: BinaryReader, context: string): string | undefined {
  const units = reader.readUint32();
  return units === NULL_STRING_LENGTH ? undefined : decodeWideStringBody(reader, units, context);
}

function decodeWideStringBody(reader: BinaryReader, units: number, context: string): string {
  if (units > Math.floor(reader.remaining / 2)) {
    throw new XlsbParseError(
      context,
      `string at byte ${reader.position} declares ${units} code unit(s) with only ` +
        `${reader.remaining} byte(s) remaining`
    );
  }
  return decodeBytesToString(reader.readBytes(units * 2), "utf-16le");
}

/** Encode an `XLWideString`. */
export function encodeWideString(value: string): Uint8Array {
  // `value.length` counts UTF-16 code units, which is exactly what the format
  // stores — so a surrogate pair is two units here and stays intact, where a
  // code-point count would under-report it by one and truncate the string.
  const writer = new BinaryWriter().writeUint32(value.length);
  for (let i = 0; i < value.length; i++) {
    writer.writeUint16(value.charCodeAt(i));
  }
  return writer.toUint8Array();
}

/** Encode an `XLNullableWideString`. */
export function encodeNullableWideString(value: string | undefined): Uint8Array {
  return value === undefined
    ? new BinaryWriter().writeUint32(NULL_STRING_LENGTH).toUint8Array()
    : encodeWideString(value);
}

/**
 * Decode an `RkNumber`: a compressed numeric cell value in four bytes.
 *
 * The low two bits are flags — `fX100` means the value was multiplied by 100,
 * `fInt` means the upper 30 bits are a signed integer rather than the top of a
 * double. Excel uses it for the common cases (small integers, two-decimal
 * currency) to avoid eight bytes per cell.
 */
export function decodeRk(raw: number): number {
  const scaledByHundred = (raw & 0x01) !== 0;
  const isInteger = (raw & 0x02) !== 0;
  let value: number;
  if (isInteger) {
    // Sign-extend the 30-bit two's-complement integer sitting above the flags.
    value = raw >> 2;
  } else {
    // The 30 bits are the *high* end of an IEEE 754 double; the rest is zero.
    const scratch = new DataView(new ArrayBuffer(8));
    scratch.setUint32(4, raw & 0xfffffffc, true);
    value = scratch.getFloat64(0, true);
  }
  return scaledByHundred ? value / 100 : value;
}

/** Whether `value` can be represented exactly as an `RkNumber`. */
export function canEncodeRk(value: number): boolean {
  return encodeRk(value) !== undefined;
}

/**
 * Encode an `RkNumber`, or `undefined` when the value needs a full double.
 *
 * Returning `undefined` rather than a lossy approximation is the point: the caller
 * has `BrtCellReal` available, and silently rounding a cell value to fit a
 * compression format would be the worst kind of bug to debug.
 */
export function encodeRk(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  // **The truncated-double form first**, because that is the one Excel reaches for. A double whose low 34 bits
  // are zero survives the truncation exactly, which every small integer and every whole-day date serial does —
  // and Excel writes `10`, `20` and a 2024 date serial this way, not as integers. Any of these forms decodes to
  // the same number, so the order is about matching Excel's bytes rather than about correctness; it was
  // integer-first, and every numeric cell differed from Excel's by three bytes.
  const scratch = new DataView(new ArrayBuffer(8));
  scratch.setFloat64(0, value, true);
  if (scratch.getUint32(0, true) === 0 && (scratch.getUint32(4, true) & 0x03) === 0) {
    return scratch.getUint32(4, true) >>> 0;
  }
  // Integers the truncation cannot hold: near ±2²⁹ the mantissa reaches into the discarded bits.
  if (Number.isInteger(value) && value >= -(2 ** 29) && value < 2 ** 29) {
    return ((value << 2) | 0x02) >>> 0;
  }
  // The hundredths form, which exists for currency. Rounding before the range test
  // rather than requiring `value * 100` to be integral is the whole point: 19.99 is
  // the most ordinary spreadsheet value there is and `19.99 * 100` is
  // 1998.9999999999998, so an integrality test rejects exactly the case the flag was
  // added for. `scaled / 100 === value` is still an exactness check — division is
  // correctly rounded, so it holds only when the value really does round-trip.
  const scaled = Math.round(value * 100);
  if (scaled >= -(2 ** 29) && scaled < 2 ** 29 && scaled / 100 === value) {
    return ((scaled << 2) | 0x03) >>> 0;
  }
  return undefined;
}

/** A cell's column and style reference, as carried by every cell record. */
export interface BiffCell {
  readonly column: number;
  readonly styleIndex: number;
}

/** Read a `Cell`: column `u32`, then `iStyleRef` in the low 24 bits of a `u32`. */
export function readCell(reader: BinaryReader): BiffCell {
  const column = reader.readUint32();
  const styleAndFlags = reader.readUint32();
  return { column, styleIndex: styleAndFlags & 0x00ffffff };
}

/** Encode a `Cell`. */
export function encodeCell(cell: BiffCell): Uint8Array {
  return new BinaryWriter()
    .writeUint32(cell.column)
    .writeUint32(cell.styleIndex & 0x00ffffff)
    .toUint8Array();
}

/** An `UncheckedRfX` cell range, as inclusive zero-based bounds. */
export interface BiffRange {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
}

/** Read an `UncheckedRfX`. */
export function readRange(reader: BinaryReader): BiffRange {
  return {
    firstRow: reader.readUint32(),
    lastRow: reader.readUint32(),
    firstColumn: reader.readUint32(),
    lastColumn: reader.readUint32()
  };
}

/**
 * An `UncheckedRfX` as an A1 reference.
 *
 * Beside `readRange` because it is what every caller of it wants next, and it was private to `filter.ts`
 * while a second reader needed the identical three lines — the point at which a copy becomes two places for
 * an off-by-one to live.
 */
export function rangeReference(range: BiffRange): string {
  return encodeRangeAddress(
    { r: range.firstRow, c: range.firstColumn },
    { r: range.lastRow, c: range.lastColumn }
  );
}

/** Encode an `UncheckedRfX`. */
/**
 * An `A1:B2` reference as a {@link BiffRange}, or `undefined` when it is not one.
 *
 * **One implementation, because there were five and they had already split into two policies.** The identical body
 * appeared in `conditional-format.ts`, `filter.ts`, `data-validation.ts` and `tables.ts`, all of which decoded through
 * `@excel/utils/address`'s `decodeRange` — which returns an *inverted* range unchanged. Meanwhile the merge path had its
 * own regex-based `parseRange` that **refused** an inverted range, with a comment explaining that the validator calls it
 * `coordinate-range-inverted`. So one package could carry a refused merge and four written-inverted `RfX`s.
 *
 * **Normalised rather than refused**, because that is what the library's own authoritative decoder already does:
 * `colCache.decode("B2:A1")` returns `A1:B2`, while `utils/address`'s `decodeRange` returns `s = B2, e = A1`. Two answers
 * inside one utility module is the actual root, and the normalising one is right — `B2:A1` and `A1:B2` denote the same
 * rectangle, so refusing it loses a range the caller described perfectly well and writing it inverted produces a record
 * the validator rejects.
 *
 * `$` is accepted, which the merge path's regex was not: `$A$1:$B$2` was reported as unsupported there while a single
 * `$A$1` parsed fine two hundred lines away.
 *
 * **A single cell is a 1×1 range here, and that is the caller's business to accept or refuse.** A conditional format or a
 * data validation over `A1` is ordinary; a *merge* of `A1` is not, and Excel refuses one. So the axis-and-bounds parsing
 * is shared and the "must cover more than one cell" rule stays with merges, where it is true — folding it in here would
 * make four callers refuse something legitimate.
 */
export function tryDecodeRange(reference: string | undefined): BiffRange | undefined {
  if (reference === undefined || reference === "") {
    return undefined;
  }
  try {
    const { s, e } = decodeRange(reference);
    // **Both axes, on both ends.** A reference missing one is a *span*, not a cell range: `A:B` names two whole columns
    // and `1:2` two whole rows. `decodeCell` yields `NaN` for the absent row and `null` for the absent column, so a
    // check on rows alone let `1:2` through with `firstColumn: null` — which an `RfX` would have written as garbage.
    if (![s.r, e.r, s.c, e.c].every(value => Number.isInteger(value))) {
      return undefined;
    }
    return {
      firstRow: Math.min(s.r, e.r),
      lastRow: Math.max(s.r, e.r),
      firstColumn: Math.min(s.c, e.c),
      lastColumn: Math.max(s.c, e.c)
    };
  } catch {
    return undefined;
  }
}

export function encodeRange(range: BiffRange): Uint8Array {
  return new BinaryWriter()
    .writeUint32(range.firstRow)
    .writeUint32(range.lastRow)
    .writeUint32(range.firstColumn)
    .writeUint32(range.lastColumn)
    .toUint8Array();
}

/**
 * Record ids that open and close a future-record wrapper.
 *
 * `BrtFRTBegin`/`BrtFRTEnd` (35/36) and `BrtACBegin`/`BrtACEnd` (37/38), which this library's spec table
 * names `BrtFRTBegin`, `BrtFRTEnd`, `BrtACBegin` and
 * `BrtACEnd`.
 */
const FUTURE_OPEN = new Set([0x0023, 0x0025]);
const FUTURE_CLOSE = new Set([0x0024, 0x0026]);

/**
 * Records this library models that legitimately live inside a future-record wrapper.
 *
 * The sparkline family, whose ids appear nowhere else — so yielding them cannot resurrect the misreading that
 * the wrapper skip was written to prevent. Anything added here must have that property.
 */
const MODELLED_FUTURE_RECORDS = new Set([
  1041, // BrtBeginSparklineGroup
  1042, // BrtEndSparklineGroup
  1043, // BrtSparkline
  1056, // BrtBeginSparklines
  1057, // BrtEndSparklines
  1058, // BrtBeginSparklineGroups
  1059 // BrtEndSparklineGroups
]);

/**
 * Records in a part, with the contents of future-record wrappers left out.
 *
 * **Why the contents have to be skipped rather than merely ignored.** The future-record mechanism
 * (MS-XLSB 2.1.6) lets a newer Excel carry data an older one must step over, and the records inside a
 * wrapper *reuse the ordinary record ids*. So a reader that walks the stream flat sees whatever those ids
 * normally mean, in a position where it cannot mean that.
 *
 * `poi-62815.xlsb` in the pinned corpus is the case that found this. Its sheet ends
 *
 * ```text
 * BrtEndSheetData → … → BrtPageSetup → BrtFRTBegin → BrtCellBlank → BrtFRTEnd → BrtEndSheet
 * ```
 *
 * and the reader took that `BrtCellBlank` for a cell: it invented a blank at A282 wearing cell format 8
 * in a workbook that has seven, *after* the sheet data had ended. The validator then reported both facts
 * as defects in the file. Both were defects in this walk.
 *
 * The wrapper markers themselves are still yielded, so a scope checker can see the pairing; only what is
 * between them is withheld.
 *
 * **The exception, and why there has to be one.** This used to claim that "nothing inside is lost that this
 * library models". That became false the moment sparklines were modelled: Excel writes the whole
 * `BrtBeginSparklineGroups` collection *inside* a wrapper, so a blanket skip means this library cannot read a
 * sparkline Excel wrote. It did not notice, because its own writer emitted them outside any wrapper and its own
 * reader looked only outside — self-consistent, and matching no other program.
 *
 * So a small set of ids is allowed through. The criterion is narrow on purpose: a record whose id this library
 * models **as a future record** — one that only ever appears inside a wrapper — cannot be confused with an
 * ordinary record at that position, which is the hazard the skip exists for. `BrtCellBlank` is emphatically not
 * in the set, and `poi-62815.xlsb` still reads correctly.
 */
export function* iterateInterpretableRecords(
  bytes: Uint8Array,
  part: string
): Generator<BiffRecord> {
  let depth = 0;
  for (const record of iterateBiffRecords(bytes, part)) {
    if (FUTURE_OPEN.has(record.id)) {
      depth++;
      yield record;
      continue;
    }
    if (FUTURE_CLOSE.has(record.id)) {
      depth = Math.max(0, depth - 1);
      yield record;
      continue;
    }
    if (depth === 0 || MODELLED_FUTURE_RECORDS.has(record.id)) {
      yield record;
    }
  }
}

/** Grid limits, which several checks and both codecs need. */
export const XLSB_MAX_ROWS = 1_048_576;
export const XLSB_MAX_COLUMNS = 16_384;

/**
 * Column widths are stored in 1/256ths of a character.
 *
 * Confirmed against Excel's own output: a default column carries 2742, which is 10.71
 * characters — the width of a default Calibri 11 column.
 */
export const COLUMN_WIDTH_UNITS = 256;

/** Row heights are stored in twips: 1/20 of a point, so a 15pt row is 300. */
export const TWIPS_PER_POINT = 20;

/** How a sheet appears in the tab bar, as `BrtBundleSh` stores it. */
export const SHEET_STATE = {
  visible: 0,
  hidden: 1,
  veryHidden: 2
} as const;

/** Sheet state name for a stored value, defaulting to visible for anything unknown. */
export function sheetStateName(value: number): "visible" | "hidden" | "veryHidden" {
  return value === SHEET_STATE.hidden
    ? "hidden"
    : value === SHEET_STATE.veryHidden
      ? "veryHidden"
      : "visible";
}

/**
 * `BrtName` flag bits that mark a name as machinery rather than something a user created.
 *
 * `_xlfn.CONCAT` in the reference corpus carries `fHidden | fFunc | fProc` — 0x0b — which is exactly the
 * combination a hidden function stub should have, and is what first identified these bits. MS-XLSB 2.4.712
 * confirms the order: `fHidden`, `fFunc`, `fOB`, `fProc` at bits 0 through 3.
 * `fProc` additionally selects a longer record tail; see `readName`.
 */
export const NAME_FLAG_HIDDEN = 0x0001;
export const NAME_FLAG_FUNCTION = 0x0002;
export const NAME_FLAG_PROCEDURE = 0x0008;
