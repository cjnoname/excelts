/**
 * Encoding one cell.
 *
 * A `BrtCell*` record is chosen by the *shape of the value*, not by the model's `type` discriminant —
 * and that is a decision rather than an oversight. A rich-text cell built through `Cell.setValue`
 * arrives with `type` set to `String` and its runs nested inside `value`, so the discriminant does not
 * discriminate; the shapes below were read off the model instead.
 *
 * The other decision worth naming is what happens when a cell cannot be encoded. It becomes a blank
 * **with its formatting intact**, and its address is reported. Writing the cached result of a formula
 * this module cannot express would produce a cell that shows the right number and never recalculates,
 * which is worse than one that admits it is empty.
 */
import { ValueType } from "@excel/core/enums";
import type { CellValue } from "@excel/types";
import { encodeCol } from "@excel/utils/address";
import { encodeCell, encodeRk, encodeWideString, type BiffRange } from "@excel/xlsb/binary";
import { encodeCellParsedFormula, encodePtg, type PtgContext } from "@excel/xlsb/formula/ptg";
import { record, type Emitted } from "@excel/xlsb/write/emit";
import type { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import { type CellLike, type SheetCell, type SheetRow } from "@excel/xlsb/write/types";
import { parse } from "@formula/syntax/parser";
import { tokenize } from "@formula/syntax/tokenizer";
import { BinaryWriter, concatUint8Arrays } from "@utils/binary";

/** Days between the 1900 epoch Excel uses and the Unix epoch, including its leap-year bug. */
const EXCEL_EPOCH_OFFSET = 25_569;
const MS_PER_DAY = 86_400_000;

/**
 * Choose the record for a cell value.
 *
 * The `BrtShort*` variants are never emitted. Their encoding has not been established,
 * and the non-short records express every value this writer can produce — a larger file
 * than Excel would write, and one whose every byte is accounted for.
 */
export function encodeCellRecord(
  cell: SheetCell,
  strings: SharedStringTable,
  formulaContext: PtgContext
): Emitted | undefined {
  const head = encodeCell({ column: cell.column, styleIndex: cell.styleIndex ?? 0 });
  const value = cell.value;

  if (cell.formula !== undefined) {
    return encodeFormulaCell(cell, head, formulaContext);
  }

  if (value === null || value === undefined) {
    return record("BrtCellBlank", head);
  }
  if (typeof value === "number") {
    // RkNumber where it is exact, a full double otherwise. `encodeRk` returns undefined
    // rather than rounding, so this cannot silently change a value to save four bytes.
    const compressed = encodeRk(value);
    return compressed === undefined
      ? record(
          "BrtCellReal",
          concatUint8Arrays([head, new BinaryWriter().writeFloat64(value).toUint8Array()])
        )
      : record(
          "BrtCellRk",
          concatUint8Arrays([head, new BinaryWriter().writeUint32(compressed).toUint8Array()])
        );
  }
  if (typeof value === "boolean") {
    return record("BrtCellBool", concatUint8Arrays([head, Uint8Array.of(value ? 1 : 0)]));
  }
  if (typeof value === "string") {
    return record(
      "BrtCellIsst",
      concatUint8Arrays([
        head,
        new BinaryWriter().writeUint32(strings.intern(value)).toUint8Array()
      ])
    );
  }
  if (value instanceof Date) {
    // Dates are serial numbers plus a number format; the serial is the value.
    const serial = dateToSerial(value, cell.date1904 ?? false);
    return record(
      "BrtCellReal",
      concatUint8Arrays([head, new BinaryWriter().writeFloat64(serial).toUint8Array()])
    );
  }
  // Unreachable for a model-derived cell: `writableValue` has already reduced anything this
  // cannot express to null. Reached only when a caller builds a `SheetCell` by hand with a
  // value outside the supported set, and the caller reports it.
  return undefined;
}

/**
 * A formula cell: the cached result, a flags word, then the token stream.
 *
 * The record is chosen by the *result*'s type, not the formula's: Excel stores
 * `BrtFmlaNum` for a numeric result and `BrtFmlaString` for a text one, and a reader skips
 * to the tokens using that width.
 *
 * A cached result this writer cannot express falls back to `BrtFmlaNum` with zero — which is what
 * Excel itself writes for a formula it has not evaluated — rather than costing the cell its formula.
 * The comment here used to claim the opposite, that such a cell "is not written as a formula at all",
 * and the code never did that; the claim was also the wrong policy. Excel recalculates on open, so
 * the formula displays correctly either way, and dropping it would lose the expression permanently to
 * protect a value that is about to be replaced. The loss is reported instead, by
 * `formulaCachedResultLoss`.
 */
function encodeFormulaCell(
  cell: SheetCell,
  head: Uint8Array,
  context: PtgContext
): Emitted | undefined {
  const where = `${encodeCol(cell.column)}${cell.row + 1}`;
  let tokens: Uint8Array;
  try {
    tokens = encodePtg(parse(tokenize(cell.formula!)), context, where);
  } catch {
    // Reported by the caller through `unsupported`; emitting the cached value alone would
    // produce a cell that looks right and never recalculates.
    return undefined;
  }
  const formula = encodeCellParsedFormula(tokens);
  const flags = new BinaryWriter().writeUint16(0).toUint8Array();
  // A date-valued cached result is its serial, the same number a literal date cell carries. The
  // epoch has to come from the cell rather than be assumed, for the same reason it does there.
  const result =
    cell.value instanceof Date ? dateToSerial(cell.value, cell.date1904 ?? false) : cell.value;

  if (typeof result === "number") {
    return record(
      "BrtFmlaNum",
      concatUint8Arrays([
        head,
        new BinaryWriter().writeFloat64(result).toUint8Array(),
        flags,
        formula
      ])
    );
  }
  if (typeof result === "boolean") {
    return record(
      "BrtFmlaBool",
      concatUint8Arrays([head, Uint8Array.of(result ? 1 : 0), flags, formula])
    );
  }
  if (typeof result === "string") {
    return record(
      "BrtFmlaString",
      concatUint8Arrays([head, encodeWideString(result), flags, formula])
    );
  }
  // No cached result, or one this writer cannot express. `BrtFmlaNum` with zero is what
  // Excel writes for a formula it has not evaluated.
  return record(
    "BrtFmlaNum",
    concatUint8Arrays([head, new BinaryWriter().writeFloat64(0).toUint8Array(), flags, formula])
  );
}

export function dateToSerial(date: Date, date1904: boolean): number {
  return date.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET - (date1904 ? 1462 : 0);
}

/**
 * What this writer can express from a cell.
 *
 * Deliberately narrow. A cell whose content needs a record this writer does not emit
 * becomes a blank rather than an approximation: writing a formula's cached result as a
 * plain number would produce a file that opens, looks right, and silently stops
 * recalculating. The cell still exists, so its position survives, and `unsupportedKind`
 * reports what was lost.
 */
export function writableValue(cell: CellLike): CellValue {
  if (unsupportedKind(cell) !== undefined) {
    return null;
  }
  // A formula cell's model value is undefined and its cached result lives in `result`.
  if (cell.formula !== undefined) {
    const result = cell.result;
    // `Date` belongs here. Dropping it to null made the cell write a cached zero, which reads back
    // as 1899-12-30 — a formula whose answer is a date came back as the epoch, silently. The date
    // is the same serial a literal date cell writes, so nothing new is needed to express it.
    if (
      result === null ||
      result === undefined ||
      typeof result === "number" ||
      typeof result === "boolean" ||
      typeof result === "string" ||
      result instanceof Date
    ) {
      return (result ?? null) as CellValue;
    }
    return null;
  }
  const value = cell.value;
  return value === undefined ? null : (value as CellValue);
}

/**
 * What a formula cell loses even though the formula itself is written.
 *
 * Distinct from `unsupportedKind`, and the distinction decides whether the cell survives. A cached
 * result this writer cannot express is **not** a reason to drop the formula: Excel recalculates on
 * open, so a formula with a stale cached zero displays correctly, while a blank cell has lost the
 * expression for good. The loss is real all the same — a consumer that reads the file without
 * recalculating, which includes this library's own reader, sees `0` where an error belongs — so it is
 * reported rather than left silent.
 *
 * `BrtFmlaError` is the record that would express it, and its payload is a cell followed by a
 * one-byte error code. That byte's values are the reason this is a loss and not a feature: no
 * workbook in the reference corpus contains a single `BrtCellError` or `BrtFmlaError`, so the mapping
 * from `#DIV/0!` to a code is unobserved, and inventing one is how a writer comes to agree with its
 * own reader and disagree with Excel.
 */
export function formulaCachedResultLoss(cell: CellLike): string | undefined {
  if (cell.formula === undefined) {
    return undefined;
  }
  const result = cell.result;
  if (
    result === null ||
    result === undefined ||
    typeof result === "number" ||
    typeof result === "boolean" ||
    typeof result === "string" ||
    result instanceof Date
  ) {
    return undefined;
  }
  if (typeof result === "object" && (result as Record<string, unknown>).error !== undefined) {
    return "formula cached error";
  }
  return "formula cached value";
}

/**
 * Name of the feature a cell needs and this writer lacks, or `undefined`.
 *
 * Classified by the shape of what the model actually holds, not by `CellModel.type`.
 * That is not laziness: a rich-text cell built through `Cell.setValue` arrives with
 * `type` set to `String` and the runs nested inside `value`, so the discriminant does not
 * discriminate. The shapes below were read off the model rather than assumed — a formula
 * sits in a sibling field with no `value` at all, while an error and rich text are both
 * objects *inside* `value`.
 */
export function unsupportedKind(cell: CellLike): string | undefined {
  if (cell.sharedFormula !== undefined) {
    // A shared formula defers to a master cell through `PtgExp`, which needs the master's
    // address — information the flat cell model does not carry here.
    return "shared formula";
  }
  if (cell.hyperlink !== undefined) {
    return "hyperlink";
  }
  // An array formula spills over a range, and `BrtArrFmla` is the record that says so. It does
  // not appear in any reference workbook, so its layout is not established and cannot be written.
  // What matters is that this is *reported*: written as an ordinary single-cell formula it would
  // compute one value where the author asked for a range, and a round trip would confirm that one
  // value happily. A shared formula was already reported; this was the same situation unreported.
  if (cell.shareType === "array" || cell.ref !== undefined) {
    return "array formula";
  }
  if (cell.isDynamicArray === true) {
    return "dynamic array formula";
  }
  // The value of a shared-string cell is an index into the string table, not a number. Passing it
  // through the numeric path writes the index as the cell's content — a plausible-looking small
  // integer where text belongs.
  if (cell.type === ValueType.SharedString && typeof cell.value === "number") {
    return "shared string index";
  }
  const value = cell.value;
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    value instanceof Date
  ) {
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.error !== undefined) {
      return "error value";
    }
    if (record.richText !== undefined) {
      return "rich text";
    }
    if (record.formula !== undefined) {
      return "formula";
    }
    if (record.hyperlink !== undefined) {
      return "hyperlink";
    }
  }
  return "cell value";
}

/**
 * A cell's number format as a format string.
 *
 * `Style.numFmt` is either the format code or the `{ id, formatCode }` pair `styles.xml`
 * carries, and only the code is meaningful here: an XLSX numbering id does not survive into
 * BIFF12, where the writer allocates its own.
 */
export function numberFormatOf(cell: CellLike): string | undefined {
  const numFmt = cell.style?.numFmt;
  if (typeof numFmt === "string") {
    return numFmt;
  }
  return typeof numFmt?.formatCode === "string" ? numFmt.formatCode : undefined;
}

export function usedRange(rows: readonly SheetRow[]): BiffRange {
  let firstRow = Number.POSITIVE_INFINITY;
  let lastRow = 0;
  let firstColumn = Number.POSITIVE_INFINITY;
  let lastColumn = 0;
  for (const row of rows) {
    firstRow = Math.min(firstRow, row.row);
    lastRow = Math.max(lastRow, row.row);
    for (const cell of row.cells) {
      firstColumn = Math.min(firstColumn, cell.column);
      lastColumn = Math.max(lastColumn, cell.column);
    }
  }
  return Number.isFinite(firstRow)
    ? {
        firstRow,
        lastRow,
        firstColumn: Number.isFinite(firstColumn) ? firstColumn : 0,
        lastColumn: Number.isFinite(firstColumn) ? lastColumn : 0
      }
    : { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 };
}
