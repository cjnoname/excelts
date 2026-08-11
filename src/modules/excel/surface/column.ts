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
