import type { CellData, CellModel } from "@excel/core/cell";
import {
  cellCol,
  cellGetModel,
  cellGetValue,
  cellType,
  setFacet,
  setFacetCloned
} from "@excel/core/cell";
import { Enums } from "@excel/core/enums";
import type { Worksheet } from "@excel/core/worksheet";
import type {
  Style,
  NumFmt,
  Font,
  Alignment,
  Protection,
  Borders,
  Fill,
  CellValue,
  RowBreak
} from "@excel/types";

interface RowDimensions {
  min: number;
  max: number;
}

export interface RowModel {
  cells: CellModel[];
  number: number;
  min: number;
  max: number;
  height?: number;
  customHeight?: boolean;
  style: Partial<Style>;
  hidden: boolean;
  outlineLevel: number;
  collapsed: boolean;
  dyDescent?: number;
}

/**
 * Plain-data row record. The entire state of a row — no class.
 * All operations are free functions in the {@link Row} namespace.
 */
export interface RowData {
  worksheet: Worksheet;
  number: number;
  cells: CellData[];
  style: Partial<Style>;
  hidden?: boolean;
  outlineLevel?: number;
  height?: number;
  customHeight?: boolean;
  dyDescent?: number;
}

function applyStyle<K extends keyof Style>(r: RowData, name: K, value: Style[K]): void {
  r.style[name] = value;
  r.cells.forEach(cell => {
    if (cell) {
      setFacetCloned(cell.style, name, value);
    }
  });
}

/**
 * Row namespace — free functions over the plain-data {@link RowData}.
 * Replaces the former `Row` class.
 */
export function rowCreate(worksheet: Worksheet, number: number): RowData {
  return { worksheet, number, cells: [], style: {}, outlineLevel: 0 };
}

export function rowFindCell(r: RowData, colNumber: number): CellData | undefined {
  return r.cells[colNumber - 1];
}

export function rowAddPageBreak(r: RowData, lft?: number, rght?: number): void {
  const ws = r.worksheet;
  const left = Math.max(0, (lft ?? 0) - 1) || 0;
  const right = Math.max(0, (rght ?? 0) - 1) || 16838;
  const pb: RowBreak = { id: r.number, max: right, man: 1 };
  if (left) {
    pb.min = left;
  }
  ws.rowBreaks.push(pb);
}

export function rowValues(r: RowData): CellValue[] {
  const values: CellValue[] = [];
  r.cells.forEach(cell => {
    if (cell && cellType(cell) !== Enums.ValueType.Null) {
      values[cellCol(cell)] = cellGetValue(cell);
    }
  });
  return values;
}

export function rowGetValues(r: RowData): CellValue[] {
  const values: CellValue[] = [];
  r.cells.forEach(cell => {
    if (cell && cellType(cell) !== Enums.ValueType.Null) {
      values[cellCol(cell) - 1] = cellGetValue(cell);
    }
  });
  return values;
}

export function rowValuesToString(r: RowData, separator = ","): string {
  return rowGetValues(r).join(separator);
}

export function rowHasValues(r: RowData): boolean {
  return r.cells.some(cell => cell && cellType(cell) !== Enums.ValueType.Null);
}

export function rowCellCount(r: RowData): number {
  return r.cells.length;
}

export function rowActualCellCount(r: RowData): number {
  let count = 0;
  r.cells.forEach(cell => {
    if (cell && cellType(cell) !== Enums.ValueType.Null) {
      count++;
    }
  });
  return count;
}

export function rowDimensions(r: RowData): RowDimensions | null {
  let min = 0;
  let max = 0;
  r.cells.forEach(cell => {
    if (cell && cellType(cell) !== Enums.ValueType.Null) {
      if (!min || min > cellCol(cell)) {
        min = cellCol(cell);
      }
      if (max < cellCol(cell)) {
        max = cellCol(cell);
      }
    }
  });
  return min > 0 ? { min, max } : null;
}

export function rowNumFmt(r: RowData): string | NumFmt | undefined {
  return r.style.numFmt;
}

export function rowSetNumFmt(r: RowData, value: string | undefined): void {
  if (value !== undefined) {
    applyStyle(r, "numFmt", value);
  }
}

export function rowFont(r: RowData): Partial<Font> | undefined {
  return r.style.font;
}

export function rowSetFont(r: RowData, value: Partial<Font> | undefined): void {
  if (value !== undefined) {
    applyStyle(r, "font", value);
  }
}

export function rowSetAlignment(r: RowData, value: Partial<Alignment> | undefined): void {
  if (value !== undefined) {
    applyStyle(r, "alignment", value);
  }
}

export function rowSetProtection(r: RowData, value: Partial<Protection> | undefined): void {
  if (value !== undefined) {
    applyStyle(r, "protection", value);
  }
}

export function rowSetBorder(r: RowData, value: Partial<Borders> | undefined): void {
  if (value !== undefined) {
    applyStyle(r, "border", value);
  }
}

export function rowSetFill(r: RowData, value: Fill | undefined): void {
  if (value !== undefined) {
    applyStyle(r, "fill", value);
  }
}

/** Read the row's style record. */
export function rowGetStyle(r: RowData): Partial<Style> {
  return r.style;
}

/** Merge a partial style into the row (propagates to existing cells). */
export function rowSetStyle(r: RowData, style: Partial<Style>): void {
  // Collect the provided facets once, then walk the cells a single time —
  // applying every facet per cell — instead of one full pass per facet.
  const keys = (Object.keys(style) as (keyof Style)[]).filter(k => style[k] !== undefined);
  if (keys.length === 0) {
    return;
  }
  for (const k of keys) {
    setFacet(r.style, k, style[k]);
  }
  r.cells.forEach(cell => {
    if (cell) {
      for (const k of keys) {
        setFacetCloned(cell.style, k, style[k]);
      }
    }
  });
}

export function rowHidden(r: RowData): boolean {
  return !!r.hidden;
}

export function rowSetHidden(r: RowData, value: boolean): void {
  r.hidden = value;
}

export function rowOutlineLevel(r: RowData): number {
  return r.outlineLevel ?? 0;
}

export function rowSetOutlineLevel(r: RowData, value: number): void {
  r.outlineLevel = value;
}

export function rowCollapsed(r: RowData): boolean {
  return !!(r.outlineLevel && r.outlineLevel >= (r.worksheet.properties.outlineLevelRow ?? 0));
}

export function rowGetModel(r: RowData): RowModel | null {
  const cells: CellModel[] = [];
  let min = 0;
  let max = 0;
  r.cells.forEach(cell => {
    // Spill ghosts are derived values, not independent worksheet cells. Do
    // not persist their derived value; the dynamic-array master reconstructs
    // it after load. Preserve style/comment metadata as an empty cell model.
    if (cell) {
      const original = cellGetModel(cell);
      const cellModel =
        cell._formulaGhostOwner === undefined
          ? original
          : ({
              address: original.address,
              type: Enums.ValueType.Null,
              style: original.style,
              comment: original.comment
            } satisfies CellModel);
      if (cellModel) {
        if (!min || min > cellCol(cell)) {
          min = cellCol(cell);
        }
        if (max < cellCol(cell)) {
          max = cellCol(cell);
        }
        cells.push(cellModel);
      }
    }
  });

  return r.height != null || cells.length
    ? {
        cells,
        number: r.number,
        min,
        max,
        height: r.height,
        customHeight: r.customHeight,
        style: r.style,
        hidden: rowHidden(r),
        outlineLevel: rowOutlineLevel(r),
        collapsed: rowCollapsed(r),
        dyDescent: r.dyDescent
      }
    : null;
}

export function resolveColumnKeyValue(obj: Record<string, unknown>, key: string): unknown {
  const direct = obj[key];
  if (direct !== undefined || !key.includes(".")) {
    return direct;
  }
  let current: unknown = obj;
  for (const segment of key.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
