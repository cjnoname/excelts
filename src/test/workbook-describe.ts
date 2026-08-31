/**
 * Canonical description of a workbook's cell content.
 *
 * Third instance of the pattern in `svg-geometry.ts` and `pdf-draw-record.ts`, and the
 * reason is the same each time: a golden hash cannot survive a re-implementation, so the
 * only way through is to re-baseline — which means checking the new output against
 * itself. Describing what the workbook *contains* compares the content instead of the
 * encoding.
 *
 * Here that buys something specific. XLSB and XLSX are two encodings of the same
 * document, and the question a round-trip has to answer is whether they carry the same
 * one. A byte comparison cannot answer it, and `toEqual` on two model objects answers a
 * different question — it fails on an `undefined` where the other has a missing key, on
 * row objects that differ only in whether a default was materialised, and on every other
 * difference that no user could observe. This normalises those away and keeps the ones
 * that matter.
 *
 * ## What it deliberately cannot see
 *
 * Style indices, number formats, column widths, and anything else not reachable from a
 * cell's address and value. It describes *content*, and a test that wants to compare
 * formatting needs a different description rather than a looser version of this one —
 * the mistake `describeSvgGeometry` documents about element opacity is exactly this
 * mistake, and the fix is to say so rather than to widen the describer.
 */

import { Address, Cell, Workbook, Worksheet } from "@excel";
import type { WorkbookData } from "@excel/core/workbook-core";

export interface DescribeWorkbookOptions {
  /**
   * Round numbers to this many decimal places before describing them.
   *
   * Off by default. It exists for comparisons that cross a lossy encoding — not for
   * making a failing test pass, which is why it has to be asked for at the call site
   * where the loss can be justified.
   */
  readonly precision?: number;
}

/**
 * Describe every non-empty cell as `Sheet!Address type value`, one per line.
 *
 * Sorted by sheet order, then row, then column, so the text is stable and a diff points
 * at the cell that changed rather than at a reordering.
 */
export function describeWorkbook(
  workbook: WorkbookData,
  options: DescribeWorkbookOptions = {}
): string {
  const lines: string[] = [];
  for (const worksheet of Workbook.getWorksheets(workbook)) {
    const name = Worksheet.getName(worksheet);
    const described: { row: number; column: number; text: string }[] = [];

    Worksheet.eachRow(worksheet, row => {
      for (const { address } of rowCells(row)) {
        const value = Cell.getValue(worksheet, address);
        if (value === null || value === undefined || value === "") {
          continue;
        }
        const { r: rowIndex, c: col } = Address.decodeCell(address);
        described.push({
          row: rowIndex,
          column: col,
          text: `${name}!${address} ${describeValue(value, options)}`
        });
      }
    });

    described.sort((left, right) => left.row - right.row || left.column - right.column);
    // Appended one at a time rather than spread. `push(...array)` turns the array into an argument
    // list, and an argument list is bounded by the call stack — so a workbook with tens of thousands
    // of cells raises `RangeError: Maximum call stack size exceeded` rather than describing itself.
    // The same mistake was in the PDF exporter; this is the second time it has cost a real run.
    for (const entry of described) {
      lines.push(entry.text);
    }
  }
  return lines.join("\n");
}

/**
 * The cells a row actually holds, with their addresses.
 *
 * Read from the row's own cell list rather than by scanning the sheet's declared dimensions:
 * a used range is allowed to be wider than the cells present, and scanning it would describe
 * blanks the two encodings are entitled to disagree about.
 */
function rowCells(row: unknown): readonly { address: string; value: unknown }[] {
  const cells = (row as { cells?: readonly unknown[] }).cells;
  if (!Array.isArray(cells)) {
    return [];
  }
  const out: { address: string; value: unknown }[] = [];
  for (const cell of cells) {
    // A row's cell array is sparse: unset columns are holes.
    if (cell === undefined || cell === null) {
      continue;
    }
    const address = (cell as { address?: string }).address;
    if (typeof address === "string") {
      out.push({ address, value: undefined });
    }
  }
  return out;
}

function describeValue(value: unknown, options: DescribeWorkbookOptions): string {
  if (typeof value === "number") {
    const rounded =
      options.precision === undefined ? value : Number(value.toFixed(options.precision));
    return `number ${rounded}`;
  }
  if (typeof value === "boolean") {
    return `boolean ${value}`;
  }
  if (typeof value === "string") {
    return `string ${JSON.stringify(value)}`;
  }
  if (value instanceof Date) {
    // Compared as an instant rather than as a formatted date: the two encodings store a
    // serial number and the formatting is a separate concern this describer excludes.
    return `date ${value.toISOString()}`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.formula === "string") {
      return `formula ${JSON.stringify(record.formula)} = ${describeValue(record.result, options)}`;
    }
    if (typeof record.error === "string") {
      return `error ${record.error}`;
    }
    if (Array.isArray(record.richText)) {
      const text = record.richText.map(run => (run as { text?: string }).text ?? "").join("");
      return `richText ${JSON.stringify(text)}`;
    }
    if (typeof record.hyperlink === "string") {
      return `hyperlink ${JSON.stringify(record.text ?? "")} → ${record.hyperlink}`;
    }
  }
  return `other ${JSON.stringify(value)}`;
}
