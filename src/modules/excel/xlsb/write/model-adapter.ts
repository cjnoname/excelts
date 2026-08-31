/**
 * Turning a `WorkbookModel` into the shapes the part writers take.
 *
 * **This is the only place that knows the model's field names**, and keeping it that way is the point:
 * the part writers below it take rows, columns and ranges, so they can be tested against hand-built
 * inputs rather than against a whole workbook. The model is also the looser of the two shapes — a
 * column's width may be absent, a merge reference may be unbounded — so the narrowing belongs here
 * rather than being repeated at each use.
 *
 * A conversion that cannot be made is *reported*, not dropped. `mergesFromModel` returns the references
 * it could not express alongside the ones it could, because a merge that silently disappears is a
 * workbook that comes back subtly rearranged with nothing said.
 */
import type { WorkbookModel } from "@excel/core/workbook.browser";
import type { Alignment, Fill, Font, Protection } from "@excel/types";
import { decodeCell } from "@excel/utils/address";
import type { BiffRange } from "@excel/xlsb/binary";
import {
  formulaCachedResultLoss,
  numberFormatOf,
  unsupportedKind,
  writableValue
} from "@excel/xlsb/write/cells";
import type { CellLike, SheetCell, SheetColumn, SheetRow } from "@excel/xlsb/write/types";

/**
 * Rows from a workbook model's worksheet, in the shape the part writer wants.
 *
 * `CellModel` is flat: a formula cell carries `formula` and `result` as sibling fields
 * and leaves `value` undefined, and rich text, errors and hyperlinks are the same shape
 * of thing. Reading `value` alone therefore reports a formula cell as blank, which is the
 * one failure mode this writer's "unsupported" list exists to prevent — so the classifier
 * looks at the fields that are actually set, not at `value`.
 */
export function sheetRowsFromModel(
  worksheet: WorkbookModel["worksheets"][number],
  date1904 = false
): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const row of worksheet.rows ?? []) {
    const cells: SheetCell[] = [];
    for (const cell of row.cells ?? []) {
      const column = columnIndex(cell.address);
      if (column === undefined) {
        continue;
      }
      const unsupported = unsupportedKind(cell);
      cells.push({
        row: row.number - 1,
        column,
        value: writableValue(cell),
        numberFormat: numberFormatOf(cell),
        font: cell.style?.font,
        fill: cell.style?.fill,
        alignment: cell.style?.alignment,
        protection: cell.style?.protection,
        // Withheld when the cell was classified unsupported, and that is the whole mechanism by
        // which an unsupported cell becomes a blank. Passing the formula through anyway meant a
        // cell reported as an array formula was *written as an ordinary one*: it computed a single
        // value where the author had asked for a spilled range, and `unsupported: "ignore"` —
        // documented as writing such cells as blanks — silently produced a different formula
        // instead. Reporting a loss and then not taking it is worse than either alone.
        ...(unsupported === undefined ? { formula: cell.formula } : {}),
        date1904,
        // One field for both kinds of loss, because both are things the caller needs told. Which of
        // the two it is decides whether the cell above kept its formula, not what is reported.
        unsupported: unsupported ?? formulaCachedResultLoss(cell)
      });
    }
    rows.push({
      row: row.number - 1,
      cells,
      ...(typeof row.height === "number" ? { heightPoints: row.height } : {}),
      ...styleOf(row)
    });
  }
  return rows;
}

/**
 * Column widths from a worksheet model.
 *
 * Only columns with an explicit width are emitted. A column that never had one set does not
 * need a record, and writing one would pin the default as though the author had chosen it.
 */
export function columnsFromModel(worksheet: WorkbookModel["worksheets"][number]): SheetColumn[] {
  const columns: SheetColumn[] = [];
  (worksheet.cols ?? []).forEach(column => {
    const width = (column as { width?: number }).width;
    const min = (column as { min?: number }).min;
    const max = (column as { max?: number }).max;
    if (typeof width !== "number" || typeof min !== "number") {
      return;
    }
    columns.push({
      firstColumn: min - 1,
      lastColumn: (typeof max === "number" ? max : min) - 1,
      widthCharacters: width,
      ...styleOf(column as { style?: CellLike["style"] })
    });
  });
  return columns;
}

/**
 * Merge ranges from a worksheet model, as zero-based bounds.
 *
 * The model carries them as `"A1:B2"` strings, which is the shape the public API takes; BIFF12
 * wants four integers.
 */
export function mergesFromModel(worksheet: WorkbookModel["worksheets"][number]): {
  readonly ranges: readonly BiffRange[];
  /** References that could not be expressed, so a caller learns rather than guesses. */
  readonly unsupported: readonly string[];
} {
  const ranges: BiffRange[] = [];
  const unsupported: string[] = [];
  for (const reference of worksheet.mergeCells ?? []) {
    const range = parseRange(reference);
    if (range) {
      ranges.push(range);
    } else {
      // A whole-row (`1:2`), whole-column (`A:B`), single-cell or inverted reference. `BrtMergeCell`
      // carries four bounded indices and cannot express an unbounded one, so the merge is dropped —
      // but silently dropping it made a workbook come back with its merges missing and nothing said.
      unsupported.push(`${reference}: merge range`);
    }
  }
  return { ranges, unsupported };
}

/** `"A1:B2"` to zero-based bounds, or `undefined` when unparseable. */
function parseRange(reference: string): BiffRange | undefined {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(reference.trim().toUpperCase());
  if (!match) {
    return undefined;
  }
  const firstColumn = columnIndex(match[1]!);
  const lastColumn = columnIndex(match[3]!);
  const firstRow = Number(match[2]) - 1;
  const lastRow = Number(match[4]) - 1;
  if (
    firstColumn === undefined ||
    lastColumn === undefined ||
    firstRow < 0 ||
    lastRow < 0 ||
    // A range whose start is after its end is what the validator calls `coordinate-range-inverted`,
    // so it is refused here rather than written and then reported.
    firstRow > lastRow ||
    firstColumn > lastColumn
  ) {
    return undefined;
  }
  return { firstRow, lastRow, firstColumn, lastColumn };
}

/**
 * The formatting a row or a column declares, in the shape the format table interns.
 *
 * Shared because a row and a column carry the same `style` object and reference it through an
 * `ixfe` in the same position of their respective records.
 */
function styleOf(owner: { readonly style?: CellLike["style"] }): {
  numberFormat?: string;
  font?: Partial<Font>;
  fill?: Fill;
  alignment?: Partial<Alignment>;
  protection?: Partial<Protection>;
} {
  const style = owner.style;
  if (style === undefined) {
    return {};
  }
  const numberFormat = numberFormatOf({ address: "A1", style });
  return {
    ...(numberFormat === undefined ? {} : { numberFormat }),
    ...(style.font === undefined ? {} : { font: style.font }),
    ...(style.fill === undefined ? {} : { fill: style.fill }),
    ...(style.alignment === undefined ? {} : { alignment: style.alignment }),
    ...(style.protection === undefined ? {} : { protection: style.protection })
  };
}

/**
 * Zero-based column index from an A1 address, or `undefined` when it is not one.
 *
 * Delegates to `decodeCell` rather than scanning the letters here, and the difference is not merely
 * tidiness: a hand-rolled scan returned a column for `Sheet1!A1` — 8,826,681, from reading `Sheet` as
 * base-26 digits — and for a bare `XYZ` with no row at all. Sharing the parser means this agrees with
 * every other place in the library that reads an address.
 */
function columnIndex(address: string): number | undefined {
  try {
    const column = decodeCell(address).c;
    return Number.isFinite(column) ? column : undefined;
  } catch {
    return undefined;
  }
}
