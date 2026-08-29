/**
 * `Column` namespace surface — column-level operations addressed by key, letter,
 * or 1-based number.
 *
 * `import { Column } from "documonster/excel"` → `Column.setWidth(ws, "A", 20)`,
 * `Column.setHeader(ws, 1, "Name")`, `Column.setStyle(ws, "B", { numFmt })`.
 *
 * The `col` parameter is a column key, an `"A"` letter, or a 1-based column
 * number — hence the `string | number` unions in the signatures below.
 */
import type { ColumnDefn, ColumnHeaderValue } from "@excel/core/column";
import {
  columnAddPageBreak,
  columnDefn,
  columnHidden,
  columnLetter,
  columnOutlineLevel,
  columnSetHidden,
  columnSetOutlineLevel
} from "@excel/core/column";
import {
  getColumn,
  columnSetHeader,
  columnSetKey,
  columnSetNumFmt,
  columnSetStyle
} from "@excel/core/worksheet-core";
import type { WorksheetData } from "@excel/core/worksheet-core";
import type { Style } from "@excel/types";

export type Sheet = WorksheetData;

// --- identity ---

/**
 * The 1-based column number for a key, letter or number.
 *
 * This is the bridge from a column *key* to the `(row, col)` form the `Cell`
 * namespace takes: `Cell.setValue(ws, row, Column.getNumber(ws, "total"), v)`.
 */
export function getNumber(ws: Sheet, col: string | number): number {
  return getColumn(ws, col).number;
}

/** The column letter (`"A"`, `"AB"`) for a key, letter or number. */
export function getLetter(ws: Sheet, col: string | number): string {
  return columnLetter(getColumn(ws, col));
}

// --- width ---

export function getWidth(ws: Sheet, col: string | number): number | undefined {
  return getColumn(ws, col).width;
}
export function setWidth(ws: Sheet, col: string | number, width: number): void {
  getColumn(ws, col).width = width;
}

// --- header / key ---

export function getHeader(ws: Sheet, col: string | number): ColumnHeaderValue | undefined {
  return getColumn(ws, col).header;
}
export function setHeader(ws: Sheet, col: string | number, header: ColumnHeaderValue): void {
  columnSetHeader(getColumn(ws, col), header);
}
export function getKey(ws: Sheet, col: string | number): string | undefined {
  return getColumn(ws, col).key;
}
export function setKey(ws: Sheet, col: string | number, key: string): void {
  columnSetKey(getColumn(ws, col), key);
}

// --- visibility / outline ---

export function getHidden(ws: Sheet, col: string | number): boolean {
  return columnHidden(getColumn(ws, col));
}
export function setHidden(ws: Sheet, col: string | number, hidden: boolean): void {
  columnSetHidden(getColumn(ws, col), hidden);
}
export function getOutlineLevel(ws: Sheet, col: string | number): number {
  return columnOutlineLevel(getColumn(ws, col));
}
export function setOutlineLevel(ws: Sheet, col: string | number, level: number): void {
  columnSetOutlineLevel(getColumn(ws, col), level);
}

// --- style ---

export function getStyle(ws: Sheet, col: string | number): Partial<Style> {
  return getColumn(ws, col).style;
}
export function setStyle(ws: Sheet, col: string | number, style: Partial<Style>): void {
  columnSetStyle(getColumn(ws, col), style);
}

// --- number format ---

/**
 * Set the column's number format.
 *
 * The mirror of `Cell.setNumFmt` / `Row.setNumFmt`, so a format can be set at
 * whichever level owns it. It is the one facet with its own setter here because
 * it is the one consumers reach for by column; every other facet goes through
 * {@link setStyle} (`setStyle(ws, col, { font })`), which also walks the column a
 * single time when several facets are set together.
 *
 * The format lands on the column *and* on the cells of every row that holds a
 * value, which is not quite "every existing cell": a row with values elsewhere
 * gains a cell in this column if it had none, and a materialised-but-empty cell in
 * a row with no values at all is skipped. That is the behaviour of every
 * `columnSet*`, not a property of this one.
 *
 * Passing `undefined` clears the format.
 *
 * There is no matching *getter*: a column's style is one record and
 * {@link getStyle} hands it over whole, so `getStyle(ws, col).numFmt` is the read.
 *
 * @example
 * ```typescript
 * import { Column, Workbook } from "documonster/excel";
 *
 * const wb = Workbook.create();
 * const ws = Workbook.addWorksheet(wb, "Sales");
 * Column.setNumFmt(ws, "C", "#,##0.00");
 * ```
 */
export function setNumFmt(ws: Sheet, col: string | number, value: string | undefined): void {
  columnSetNumFmt(getColumn(ws, col), value);
}

// --- definition ---

/**
 * The column's definition as plain data — the shape `Worksheet.setColumns`
 * takes, with `hidden` / `outlineLevel` normalised the way the library
 * normalises them internally.
 *
 * Use this (or `Worksheet.columnDefinitions` for every column) instead of copying
 * fields off a column handle by hand: hand-copying re-implements the
 * normalisation and silently drifts the moment a field or a fallback changes.
 */
export function getDefinition(ws: Sheet, col: string | number): ColumnDefn {
  return columnDefn(getColumn(ws, col));
}

// --- printing ---

/**
 * Add a manual vertical page break to the **right** of `col`, the equivalent of
 * Excel's *Page Layout → Breaks → Insert Page Break*. Applies to printing and
 * to `Pdf.fromExcel`; it does not affect the on-screen grid.
 *
 * The break spans the full height of the sheet, which is the only kind Excel can
 * author or render — see `columnAddPageBreak` for why no row band is offered.
 *
 * @example
 * ```typescript
 * import { Column, Workbook } from "documonster/excel";
 *
 * const wb = Workbook.create();
 * const ws = Workbook.addWorksheet(wb, "Report");
 * Column.addPageBreak(ws, "F"); // the next page starts at column G
 * ```
 */
export function addPageBreak(ws: Sheet, col: string | number): void {
  columnAddPageBreak(getColumn(ws, col));
}
