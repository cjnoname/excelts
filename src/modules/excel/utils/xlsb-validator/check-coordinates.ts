/**
 * Coordinate check: are rows, columns and declared ranges inside the grid, and does
 * the declared used range match the cells actually present?
 *
 * Two failure modes worth separating. A coordinate outside the grid is a hard
 * rejection — Excel will not open a sheet claiming row 2,000,000. A `BrtWsDim` that
 * disagrees with the cells is subtler: Excel usually recovers, but a consumer that
 * sized a buffer from the declared range and then met a cell outside it will not, so
 * it is reported rather than ignored.
 *
 * Row ordering is checked too, because `BrtRowHdr` records are required to ascend and
 * a reader that trusts that — as any streaming reader must — silently produces a
 * scrambled sheet when they do not.
 *
 * Every field read here goes through the spec-driven decoder, so a record whose layout
 * the table does not describe is skipped rather than guessed at. The seven `BrtShort*`
 * cell variants are in that position today: they are recognised as cells, so the
 * ordering check still applies to them, but their coordinates cannot be read and this
 * check says so by not firing.
 */

import type { FramedPart } from "@excel/utils/xlsb-validator/check-framing";
import type { XlsbReporter } from "@excel/utils/xlsb-validator/reporter";
import { CELL_RECORD_NAMES, ROW_RECORD_NAMES } from "@excel/utils/xlsb-validator/roles";
import { XLSB_MAX_COLUMNS, XLSB_MAX_ROWS, type BiffRange } from "@excel/xlsb/binary";
import { cellField, decodeRecord, numberField, rangeField } from "@excel/xlsb/spec/decode";
import { recordSpec } from "@excel/xlsb/spec/records";

export function checkCoordinates(framed: FramedPart, reporter: XlsbReporter): void {
  let declared: BiffRange | undefined;
  let previousRow: number | undefined;
  let currentRow: number | undefined;
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = Number.NEGATIVE_INFINITY;
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = Number.NEGATIVE_INFINITY;

  for (const record of framed.records) {
    if (reporter.capped) {
      return;
    }
    const name = recordSpec(record.id)?.name;
    if (!name) {
      continue;
    }
    const at = { part: framed.part, offset: record.offset };
    const decoded = decodeRecord(record, framed.part);

    if (name === "BrtWsDim" || name === "BrtMergeCell") {
      const range = rangeField(decoded, "ref");
      if (!range) {
        continue;
      }
      if (name === "BrtWsDim") {
        declared = range;
      }
      checkRange(name, range, reporter, at);
      continue;
    }

    if (ROW_RECORD_NAMES.has(name)) {
      const row = numberField(decoded, "rw");
      if (row === undefined) {
        continue;
      }
      currentRow = row;
      if (row >= XLSB_MAX_ROWS) {
        reporter.error(
          "coordinate-row-out-of-range",
          `row ${row} is beyond the last row (${XLSB_MAX_ROWS - 1})`,
          at
        );
        continue;
      }
      if (previousRow !== undefined && row <= previousRow) {
        reporter.error(
          "coordinate-row-out-of-order",
          `row ${row} follows row ${previousRow}; row headers must ascend`,
          at
        );
      }
      previousRow = row;
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      continue;
    }

    if (CELL_RECORD_NAMES.has(name)) {
      const cell = cellField(decoded, "cell");
      if (!cell) {
        continue;
      }
      if (cell.column >= XLSB_MAX_COLUMNS) {
        reporter.error(
          "coordinate-column-out-of-range",
          `column ${cell.column} is beyond the last column (${XLSB_MAX_COLUMNS - 1})`,
          at
        );
        continue;
      }
      minColumn = Math.min(minColumn, cell.column);
      maxColumn = Math.max(maxColumn, cell.column);
      if (currentRow !== undefined) {
        minRow = Math.min(minRow, currentRow);
        maxRow = Math.max(maxRow, currentRow);
      }
    }
  }

  if (!declared || maxRow < minRow) {
    return;
  }
  // Only an *under*-declaration is reported. A used range wider than the cells present
  // is what Excel itself writes when formatting was applied and then cleared, so
  // treating it as a problem would fire on ordinary files.
  if (minRow < declared.firstRow || maxRow > declared.lastRow) {
    reporter.warning(
      "coordinate-dimension-mismatch",
      `BrtWsDim declares rows ${declared.firstRow}–${declared.lastRow} but cells occupy ` +
        `${minRow}–${maxRow}`,
      { part: framed.part }
    );
  }
  if (
    maxColumn >= minColumn &&
    (minColumn < declared.firstColumn || maxColumn > declared.lastColumn)
  ) {
    reporter.warning(
      "coordinate-dimension-mismatch",
      `BrtWsDim declares columns ${declared.firstColumn}–${declared.lastColumn} but cells ` +
        `occupy ${minColumn}–${maxColumn}`,
      { part: framed.part }
    );
  }
}

function checkRange(
  name: string,
  range: BiffRange,
  reporter: XlsbReporter,
  at: { part: string; offset: number }
): void {
  if (range.lastRow >= XLSB_MAX_ROWS || range.firstRow >= XLSB_MAX_ROWS) {
    reporter.error("coordinate-row-out-of-range", `${name} names a row beyond the grid`, at);
    return;
  }
  if (range.lastColumn >= XLSB_MAX_COLUMNS || range.firstColumn >= XLSB_MAX_COLUMNS) {
    reporter.error("coordinate-column-out-of-range", `${name} names a column beyond the grid`, at);
    return;
  }
  if (range.firstRow > range.lastRow || range.firstColumn > range.lastColumn) {
    reporter.error(
      "coordinate-range-inverted",
      `${name} range ${range.firstRow}:${range.lastRow}×${range.firstColumn}:${range.lastColumn} ` +
        `has its start after its end`,
      at
    );
  }
}
