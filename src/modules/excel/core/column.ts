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
  ColBreak
} from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import { deepEqual } from "@utils/object";
import type { DeepReadonly } from "@utils/types";

/** Header value type - can be a single value or array for multi-row headers */
export type ColumnHeaderValue = CellValue | CellValue[];

const DEFAULT_COLUMN_WIDTH = 9;

export interface ColumnDefn {
  header?: ColumnHeaderValue;
  key?: string;
  width?: number;
  outlineLevel?: number;
  hidden?: boolean;
  style?: Partial<Style>;
  bestFit?: boolean;
}

export interface ColumnModel {
  min: number;
  max: number;
  width?: number;
  style?: Partial<Style>;
  isCustomWidth?: boolean;
  hidden?: boolean;
  outlineLevel?: number;
  collapsed?: boolean;
  bestFit?: boolean;
}

/**
 * Plain-data column record. The entire state of a column — no class.
 * All operations are free functions in the {@link Column} namespace.
 */
export interface ColumnData {
  worksheet: Worksheet;
  number: number;
  header?: ColumnHeaderValue;
  key?: string;
  width?: number;
  hidden?: boolean;
  outlineLevel?: number;
  bestFit?: boolean;
  style: Partial<Style>;
}

/**
 * A **read-only view** of a column record, as handed out by `Worksheet.columns`
 * / `Worksheet.lastColumn`.
 *
 * The same live object as the {@link ColumnData} handle, minus the `worksheet`
 * back-reference and with every field (including the nested `style`) readonly:
 * columns are declared through `Worksheet.setColumns` and changed through the
 * `Column` namespace, both of which keep the column numbering, the key registry
 * and the cells' styles in sync. Writing to the object directly does not.
 *
 * `worksheet` is omitted rather than made readonly on purpose — recursing into
 * it would drag the whole worksheet → workbook graph into the type.
 */
export type ColumnView = Omit<DeepReadonly<ColumnData>, "worksheet">;

/**
 * Column namespace — free functions over the plain-data {@link ColumnData}.
 * Replaces the former `Column` class.
 */
export function columnLetter(c: ColumnData): string {
  return colCache.n2l(c.number);
}

export function columnIsCustomWidth(c: ColumnData): boolean {
  return c.width !== undefined && c.width !== DEFAULT_COLUMN_WIDTH;
}

export function columnDefn(c: ColumnData): ColumnDefn {
  return {
    header: c.header,
    key: c.key,
    width: c.width,
    style: c.style,
    hidden: columnHidden(c),
    outlineLevel: columnOutlineLevel(c),
    bestFit: c.bestFit
  };
}

export function columnHeaders(c: ColumnData): CellValue[] {
  if (Array.isArray(c.header)) {
    return c.header;
  }
  if (c.header !== undefined) {
    return [c.header];
  }
  return [];
}

export function columnHidden(c: ColumnData): boolean {
  return !!c.hidden;
}

export function columnSetHidden(c: ColumnData, value: boolean): void {
  c.hidden = value;
}

export function columnOutlineLevel(c: ColumnData): number {
  return c.outlineLevel ?? 0;
}

export function columnSetOutlineLevel(c: ColumnData, value: number | undefined): void {
  c.outlineLevel = value;
}

export function columnCollapsed(c: ColumnData): boolean {
  return !!(c.outlineLevel && c.outlineLevel >= (c.worksheet.properties.outlineLevelCol ?? 0));
}

export function columnEquivalentTo(c: ColumnData, other: ColumnData): boolean {
  return (
    c.width === other.width &&
    columnHidden(c) === columnHidden(other) &&
    columnOutlineLevel(c) === columnOutlineLevel(other) &&
    deepEqual(c.style, other.style)
  );
}

export function columnEquivalentToModel(c: ColumnData, model: ColumnModel): boolean {
  return (
    c.width === model.width &&
    columnHidden(c) === model.hidden &&
    columnOutlineLevel(c) === model.outlineLevel &&
    c.bestFit === model.bestFit &&
    deepEqual(c.style, model.style)
  );
}

export function columnIsDefault(c: ColumnData): boolean {
  if (columnIsCustomWidth(c)) {
    return false;
  }
  if (columnHidden(c)) {
    return false;
  }
  if (columnOutlineLevel(c)) {
    return false;
  }
  if (c.bestFit) {
    return false;
  }
  const s = c.style;
  if (
    s &&
    (s.font || s.numFmt || s.alignment || s.border || s.fill || s.protection || s.styleName)
  ) {
    return false;
  }
  return true;
}

export function columnHeaderCount(c: ColumnData): number {
  return columnHeaders(c).length;
}

export function columnAddPageBreak(c: ColumnData, top?: number, bottom?: number): void {
  const ws = c.worksheet;
  const topRow = Math.max(0, (top ?? 0) - 1) || 0;
  const bottomRow = Math.max(0, (bottom ?? 0) - 1) || 1048575;
  const pb: ColBreak = { id: c.number, max: bottomRow, man: 1 };
  if (topRow) {
    pb.min = topRow;
  }
  ws.colBreaks.push(pb);
}

export function columnNumFmt(c: ColumnData): string | NumFmt | undefined {
  return c.style.numFmt;
}

export function columnFont(c: ColumnData): Partial<Font> | undefined {
  return c.style.font;
}

export function columnAlignment(c: ColumnData): Partial<Alignment> | undefined {
  return c.style.alignment;
}

export function columnProtection(c: ColumnData): Partial<Protection> | undefined {
  return c.style.protection;
}

export function columnBorder(c: ColumnData): Partial<Borders> | undefined {
  return c.style.border;
}

export function columnFill(c: ColumnData): Fill | undefined {
  return c.style.fill;
}

export function columnToModel(columns: readonly ColumnData[]): ColumnModel[] | undefined {
  const cols: ColumnModel[] = [];
  let col: ColumnModel | null = null;
  columns.forEach((column, index) => {
    if (columnIsDefault(column)) {
      if (col) {
        col = null;
      }
    } else if (!col || !columnEquivalentToModel(column, col)) {
      col = {
        min: index + 1,
        max: index + 1,
        width: column.width !== undefined ? column.width : DEFAULT_COLUMN_WIDTH,
        style: column.style,
        isCustomWidth: columnIsCustomWidth(column),
        hidden: columnHidden(column),
        outlineLevel: columnOutlineLevel(column),
        collapsed: columnCollapsed(column),
        bestFit: column.bestFit
      };
      cols.push(col);
    } else {
      col.max = index + 1;
    }
  });
  return cols.length ? cols : undefined;
}
