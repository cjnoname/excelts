import type { CellData } from "@excel/core/cell";
import { cellGetValue, cellSetValue } from "@excel/core/cell";
import { getRow, getSheetWorkbook, rowGetCell } from "@excel/core/worksheet-core";
import type { WorksheetData as Worksheet } from "@excel/core/worksheet-core";
import { TableError } from "@excel/errors";
import type {
  DecodedAddress,
  CellFormulaValue,
  CellValue,
  Style,
  TableColumnProperties,
  TableStyleProperties
} from "@excel/types";
import { colCache } from "@excel/utils/col-cache";

interface LoadedTableColumnProperties extends TableColumnProperties {
  rawFilterXml?: string[];
  namespaceAttributes?: Record<string, string>;
}

/** The round-trip table model — `Table.model` / `Table.setModel`. */
export interface TableModel {
  ref: string;
  name: string;
  displayName?: string;
  columns: LoadedTableColumnProperties[];
  rows: CellValue[][];
  headerRow?: boolean;
  totalsRow?: boolean;
  qualifyImplicitStructuredReferences?: boolean;
  style?: TableStyleProperties;
  tl?: DecodedAddress;
  autoFilterRef?: string;
  tableRef?: string;
  sortStateXml?: string;
  sortStateAutoFilterRef?: string;
  autoFilterSortStateXml?: string;
  autoFilterSortStateRef?: string;
  autoFilterExtLstXml?: string;
  rawAttributes?: Record<string, string>;
  extLstXml?: string;
  autoFilterNamespaceAttributes?: Record<string, string>;
}

function clearStaleSortState(t: TableData): void {
  t.table.sortStateXml = undefined;
  t.table.sortStateAutoFilterRef = undefined;
  t.table.autoFilterSortStateXml = undefined;
  t.table.autoFilterSortStateRef = undefined;
}

/**
 * Maximum length for an Excel defined name (and therefore table name).
 */
const MAX_TABLE_NAME_LENGTH = 255;

/**
 * Matches an A1-style cell reference pattern like A1, Z99, XFD1048576.
 * Excel rejects table names that match this pattern.
 */
const CELL_REF_PATTERN = /^[A-Za-z]{1,3}\d+$/;

/**
 * Matches an R1C1-style cell reference, e.g. R1C1, R100C200.
 * Must have at least one digit after R and at least one digit after C
 * to be considered a cell reference. Bare "RC" is NOT a cell reference.
 */
const R1C1_PATTERN = /^[Rr]\d+[Cc]\d+$/;

/**
 * Single-character names that Excel reserves for row/column navigation.
 * Per Microsoft docs: "You cannot use the uppercase and lowercase characters
 * 'C', 'c', 'R', or 'r' as a defined name."
 */
const RESERVED_SINGLE_CHARS = new Set(["C", "c", "R", "r"]);

/** Regex patterns used by sanitizeTableName, hoisted to module scope to avoid recompilation. */
const WHITESPACE_RE = /\s/g;
const INVALID_CHARS_RE = /[^\p{L}\p{N}_.]/gu;
const VALID_FIRST_CHAR_RE = /^[\p{L}_\\]/u;

/**
 * Sanitize a table name to comply with OOXML defined name rules
 * (ECMA-376, 4th edition, Part 1, §18.5.1.2).
 *
 * Rules enforced (per Microsoft documentation):
 * - First character must be a letter (any script), underscore (_), or backslash (\)
 * - Subsequent characters may be letters, digits, underscores, or periods (.)
 * - Backslash is only valid as the first character
 * - Spaces are replaced with underscores
 * - Other invalid characters are stripped
 * - Single-character names "C", "c", "R", "r" are prefixed with _
 * - Names that look like cell references (e.g. A1, R1C1) are prefixed with _
 * - Maximum 255 characters
 * - Empty result falls back to "_Table"
 *
 * This library applies these rules automatically so that generated files
 * always comply with the OOXML schema, avoiding Excel "repair" dialogs.
 */
function sanitizeTableName(name: string): string {
  // Replace all whitespace characters (space, tab, newline, etc.) with underscores
  let sanitized = name.replace(WHITESPACE_RE, "_");

  // Preserve a leading backslash (valid only as first character per spec)
  let leadingBackslash = false;
  if (sanitized.startsWith("\\")) {
    leadingBackslash = true;
    sanitized = sanitized.slice(1);
  }

  // Strip characters not valid in defined names.
  // Subsequent characters: Unicode letters, digits, underscore, period.
  // Backslash is NOT valid in subsequent positions.
  sanitized = sanitized.replace(INVALID_CHARS_RE, "");

  // Re-attach leading backslash
  if (leadingBackslash) {
    sanitized = `\\${sanitized}`;
  }

  // Ensure the first character is valid (letter, underscore, or backslash).
  // Test the whole string start rather than sanitized[0] to correctly handle
  // supplementary Unicode characters (surrogate pairs).
  if (sanitized.length > 0 && !VALID_FIRST_CHAR_RE.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Fallback if empty after sanitization
  if (sanitized.length === 0) {
    return "_Table";
  }

  // Avoid reserved single-character names (C, c, R, r)
  if (sanitized.length === 1 && RESERVED_SINGLE_CHARS.has(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Avoid names that look like cell references
  if (CELL_REF_PATTERN.test(sanitized) || R1C1_PATTERN.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Truncate to max length last, after all prefix additions,
  // to guarantee the result never exceeds 255 characters.
  if (sanitized.length > MAX_TABLE_NAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_TABLE_NAME_LENGTH);
  }

  return sanitized;
}

interface CacheState {
  ref: string;
  width: number;
  tableHeight: number;
}

// ============================================================================
// Table — de-classed domain model (data record + flat helpers)
// ============================================================================

/**
 * Plain-data worksheet table (de-classed domain model). Holds the owning
 * worksheet, the {@link TableModel}, and an optional mutation cache. All former
 * methods/getters/setters are flat `table*` helpers.
 */
export interface TableData {
  worksheet: Worksheet;
  table: TableModel;
  _cache?: CacheState;
}

/**
 * View over a single table column (de-classed). Carries the owning table, the
 * column properties record, and the column index; setters route through
 * {@link tableCacheState} so {@link tableCommit} replays `store()`.
 */
export interface TableColumnView {
  table: TableData;
  column: TableColumnProperties;
  index: number;
}

// SUBTOTAL function codes per OOXML/Excel (see original notes):
//   average → 101, countNums → 102, count → 103, max → 104, min → 105,
//   stdDev → 107, var → 110, sum → 109.
const SUBTOTAL_FUNCTIONS: Record<string, number> = {
  average: 101,
  countNums: 102,
  count: 103,
  max: 104,
  min: 105,
  stdDev: 107,
  var: 110,
  sum: 109
};

/** Create a table bound to a worksheet, validating + storing on-sheet if a model is given. */
export function createTable(worksheet: Worksheet, table?: TableModel): TableData {
  const t: TableData = { worksheet, table: table as TableModel };
  if (table) {
    // When loading tables from xlsx, Excel stores table ranges and cell values in the worksheet,
    // but may not embed row data into the table definition. Hydrate rows from the worksheet so
    // table mutations (e.g. addRow) can correctly expand table ranges and serialize.
    if (Array.isArray(table.rows) && table.rows.length === 0 && table.tableRef) {
      const decoded = colCache.decode(table.tableRef);
      if ("dimensions" in decoded) {
        const startRow = decoded.top + (table.headerRow === false ? 0 : 1);
        const endRow = decoded.bottom - (table.totalsRow === true ? 1 : 0);

        if (endRow >= startRow) {
          for (let r = startRow; r <= endRow; r++) {
            const row = getRow(worksheet, r);
            const values: CellValue[] = [];
            for (let c = decoded.left; c <= decoded.right; c++) {
              values.push(cellGetValue(rowGetCell(row, c)));
            }
            table.rows.push(values);
          }
        }
      }
    }
    // check things are ok first
    tableValidate(t);

    tableStore(t);
  }
  return t;
}

export function tableGetFormula(t: TableData, column: TableColumnProperties): string | null {
  if (column.totalsRowFunction === "none") {
    return null;
  }
  if (column.totalsRowFunction === "custom") {
    return column.totalsRowFormula ?? null;
  }
  const fnNum = column.totalsRowFunction ? SUBTOTAL_FUNCTIONS[column.totalsRowFunction] : undefined;
  if (fnNum !== undefined) {
    return `SUBTOTAL(${fnNum},${t.table.name}[${column.name}])`;
  }
  throw new TableError(`Invalid Totals Row Function: ${column.totalsRowFunction}`);
}

/** Number of columns. */
export function tableWidth(t: TableData): number {
  return t.table.columns.length;
}

/** Number of data rows. */
export function tableHeight(t: TableData): number {
  return t.table.rows.length;
}

/** Data rows + optional header row. */
export function tableFilterHeight(t: TableData): number {
  return tableHeight(t) + (t.table.headerRow ? 1 : 0);
}

/** Full on-sheet height (data + header + optional totals row). */
export function tableTableHeight(t: TableData): number {
  return tableFilterHeight(t) + (t.table.totalsRow ? 1 : 0);
}

export function tableValidate(t: TableData): void {
  const { table } = t;
  // set defaults and check is valid
  const assign = <T extends object, K extends keyof T>(o: T, name: K, dflt: T[K]): void => {
    if (o[name] === undefined) {
      o[name] = dflt;
    }
  };
  assign(table, "headerRow", true);
  assign(table, "totalsRow", false);

  assign(table, "style", {});
  const style = table.style!;
  assign(style, "theme", "TableStyleMedium2");
  assign(style, "showFirstColumn", false);
  assign(style, "showLastColumn", false);
  assign(style, "showRowStripes", false);
  assign(style, "showColumnStripes", false);

  // Sanitize table name and displayName to comply with OOXML defined name rules.
  // Excel UI rejects invalid names; here we auto-correct to avoid "repair" dialogs.
  if (table.name) {
    table.name = sanitizeTableName(table.name);
  }
  if (table.displayName) {
    table.displayName = sanitizeTableName(table.displayName);
  }

  const assert = (test: boolean, message: string) => {
    if (!test) {
      throw new TableError(message);
    }
  };
  assert(!!table.name, "Table must have a name");
  assert(!!table.ref, "Table must have ref");
  assert(!!table.columns, "Table must have column definitions");
  assert(!!table.rows, "Table must have row definitions");

  table.tl = colCache.decodeAddress(table.ref);
  const { row, col } = table.tl;
  assert(row > 0, "Table must be on valid row");
  assert(col > 0, "Table must be on valid col");

  const width = tableWidth(t);
  const filterHeight = tableFilterHeight(t);
  const tableHt = tableTableHeight(t);

  // autoFilterRef spans the header + all data rows (excludes the optional
  // totals row). See original notes: matches what Excel emits and avoids
  // "Removed Records: Table" on open.
  table.autoFilterRef = colCache.encode(row, col, row + filterHeight - 1, col + width - 1);

  // tableRef is a range that includes optional headers and totals
  table.tableRef = colCache.encode(row, col, row + tableHt - 1, col + width - 1);

  table.columns.forEach((column, i) => {
    assert(!!column.name, `Column ${i} must have a name`);
    if (i === 0) {
      assign(column, "totalsRowLabel", "Total");
    } else {
      assign(column, "totalsRowFunction", "none");
      column.totalsRowFormula = tableGetFormula(t, column) ?? undefined;
    }
  });
}

export function tableStore(t: TableData): void {
  // where the table needs to store table data, headers, footers in the sheet...
  const assignStyle = (cell: CellData, style: Partial<Style> | undefined): void => {
    if (style) {
      Object.assign(cell.style, style);
    }
  };

  const { worksheet, table } = t;
  const { row, col } = table.tl!;
  let count = 0;
  if (table.headerRow) {
    const r = getRow(worksheet, row + count++);
    table.columns.forEach((column, j) => {
      const { style, name } = column;
      const cell = rowGetCell(r, col + j);
      cellSetValue(cell, name);
      assignStyle(cell, style);
    });
  }
  table.rows.forEach(data => {
    const r = getRow(worksheet, row + count++);
    data.forEach((value, j) => {
      const cell = rowGetCell(r, col + j);
      const isFormulaValue = typeof value === "object" && value !== null && "formula" in value;
      if (isFormulaValue && typeof (value as CellFormulaValue).formula === "string") {
        const formulaValue = value as CellFormulaValue;
        const shouldQualify = table.qualifyImplicitStructuredReferences === true;
        cellSetValue(cell, {
          ...formulaValue,
          formula: shouldQualify
            ? formulaValue.formula.replace(
                /(^|[^A-Za-z0-9_])\[@\[?([^[\]]+?)\]?\]/g,
                `$1${table.name}[[#This Row],[$2]]`
              )
            : formulaValue.formula
        } as CellFormulaValue);
      } else {
        cellSetValue(cell, value);
      }

      assignStyle(cell, table.columns[j]?.style);
    });
  });

  if (table.totalsRow) {
    const r = getRow(worksheet, row + count++);
    table.columns.forEach((column, j) => {
      const cell = rowGetCell(r, col + j);
      if (j === 0) {
        cellSetValue(cell, column.totalsRowLabel);
      } else {
        const formula = tableGetFormula(t, column);
        if (formula) {
          cellSetValue(cell, {
            formula,
            result: column.totalsRowResult
          });
        } else {
          cellSetValue(cell, null);
        }
      }

      assignStyle(cell, column.style);
    });
  }
}

export function tableLoad(t: TableData, worksheet: Worksheet): void {
  // where the table will read necessary features from a loaded sheet
  const { table } = t;
  const { row, col } = table.tl!;
  let count = 0;
  if (table.headerRow) {
    const r = getRow(worksheet, row + count++);
    table.columns.forEach((column, j) => {
      const cell = rowGetCell(r, col + j);
      cellSetValue(cell, column.name);
    });
  }
  table.rows.forEach(data => {
    const r = getRow(worksheet, row + count++);
    data.forEach((value, j) => {
      const cell = rowGetCell(r, col + j);
      cellSetValue(cell, value);
    });
  });

  if (table.totalsRow) {
    const r = getRow(worksheet, row + count++);
    table.columns.forEach((column, j) => {
      const cell = rowGetCell(r, col + j);
      if (j === 0) {
        cellSetValue(cell, column.totalsRowLabel);
      } else {
        const formula = tableGetFormula(t, column);
        if (formula) {
          cellSetValue(cell, {
            formula,
            result: column.totalsRowResult
          });
        }
      }
    });
  }
}

/** The underlying serialized {@link TableModel}. */
export function tableModel(t: TableData): TableModel {
  return t.table;
}

/** Replace the underlying {@link TableModel}. */
export function tableSetModel(t: TableData, value: TableModel): void {
  t.table = value;
}

export function tableCacheState(t: TableData): void {
  if (!t._cache) {
    t._cache = {
      ref: tableRef(t),
      width: tableWidth(t),
      tableHeight: tableTableHeight(t)
    };
  }
}

export function tableCommit(t: TableData): void {
  // changes may have been made that might have on-sheet effects
  if (!t._cache) {
    return;
  }

  // check things are ok first
  tableValidate(t);

  const ref = colCache.decodeAddress(t._cache.ref);
  if (tableRef(t) !== t._cache.ref) {
    // wipe out whole table footprint at previous location
    for (let i = 0; i < t._cache.tableHeight; i++) {
      const row = getRow(t.worksheet, ref.row + i);
      for (let j = 0; j < t._cache.width; j++) {
        const cell = rowGetCell(row, ref.col + j);
        cellSetValue(cell, null);
      }
    }
  } else {
    // clear out below table if it has shrunk
    for (let i = tableTableHeight(t); i < t._cache.tableHeight; i++) {
      const row = getRow(t.worksheet, ref.row + i);
      for (let j = 0; j < t._cache.width; j++) {
        const cell = rowGetCell(row, ref.col + j);
        cellSetValue(cell, null);
      }
    }

    // clear out to right of table if it has lost columns
    for (let i = 0; i < tableTableHeight(t); i++) {
      const row = getRow(t.worksheet, ref.row + i);
      for (let j = tableWidth(t); j < t._cache.width; j++) {
        const cell = rowGetCell(row, ref.col + j);
        cellSetValue(cell, null);
      }
    }
  }

  tableStore(t);
  t._cache = undefined;
}

export function tableAddRow(
  t: TableData,
  values: CellValue[],
  rowNumber?: number,
  options?: { commit?: boolean }
): void {
  // Add a row of data, either insert at rowNumber or append
  tableCacheState(t);
  clearStaleSortState(t);

  if (rowNumber === undefined) {
    t.table.rows.push(values);
  } else {
    t.table.rows.splice(rowNumber, 0, values);
  }

  if (options?.commit !== false) {
    tableCommit(t);
  }
}

export function tableRemoveRows(
  t: TableData,
  rowIndex: number,
  count: number = 1,
  options?: { commit?: boolean }
): void {
  // Remove a rows of data
  tableCacheState(t);
  if (count > 0) {
    clearStaleSortState(t);
  }
  t.table.rows.splice(rowIndex, count);

  if (options?.commit !== false) {
    tableCommit(t);
  }
}

export function tableGetColumn(t: TableData, colIndex: number): TableColumnView {
  const column = t.table.columns[colIndex];
  return { table: t, column, index: colIndex };
}

export function tableAddColumn(
  t: TableData,
  column: TableColumnProperties,
  values: CellValue[],
  colIndex?: number
): void {
  // Add a new column, including column defn and values
  // Inserts at colNumber or adds to the right
  tableCacheState(t);
  clearStaleSortState(t);

  if (colIndex === undefined) {
    t.table.columns.push(column);
    t.table.rows.forEach((row, i) => {
      row.push(values[i]);
    });
  } else {
    t.table.columns.splice(colIndex, 0, column);
    t.table.rows.forEach((row, i) => {
      row.splice(colIndex, 0, values[i]);
    });
  }
}

export function tableRemoveColumns(t: TableData, colIndex: number, count: number = 1): void {
  // Remove a column with data
  tableCacheState(t);
  if (count > 0) {
    clearStaleSortState(t);
  }

  t.table.columns.splice(colIndex, count);
  t.table.rows.forEach(row => {
    row.splice(colIndex, count);
  });
}

function tableAssign<T extends object, K extends keyof T>(
  t: TableData,
  target: T,
  prop: K,
  value: T[K]
): void {
  tableCacheState(t);
  target[prop] = value;
}

export function tableRef(t: TableData): string {
  return t.table.ref;
}
export function tableSetRef(t: TableData, value: string): void {
  if (t.table.ref !== value) {
    clearStaleSortState(t);
  }
  tableAssign(t, t.table, "ref", value);
}

export function tableName(t: TableData): string {
  return t.table.name;
}
export function tableSetName(t: TableData, value: string): void {
  tableCacheState(t);
  const newName = sanitizeTableName(value);
  const oldName = t.table.name;
  if (newName === oldName) {
    return;
  }
  // Synchronise the worksheet's table map and the workbook-wide name set
  // so subsequent getTable(newName)/duplicate-name checks remain correct.
  // Falls back to a bare assignment if the worksheet hasn't registered
  // this table (e.g. transient instances built by Worksheet.set model).
  const ws = t.worksheet;
  const tables = ws?.tables;
  const tableNames = getSheetWorkbook(ws)?._tableNames;
  if (tables && tables[oldName] === t) {
    const newKey = newName.toLowerCase();
    const oldKey = oldName.toLowerCase();
    if (newKey !== oldKey && tableNames?.has(newKey)) {
      throw new TableError(
        `Table name "${newName}" already exists in the workbook (case-insensitive).`
      );
    }
    delete tables[oldName];
    tables[newName] = t;
    if (tableNames) {
      tableNames.delete(oldKey);
      tableNames.add(newKey);
    }
  }
  t.table.name = newName;
}

export function tableDisplayName(t: TableData): string {
  return t.table.displayName || t.table.name;
}
export function tableSetDisplayName(t: TableData, value: string): void {
  tableCacheState(t);
  t.table.displayName = sanitizeTableName(value);
}

export function tableHeaderRow(t: TableData): boolean | undefined {
  return t.table.headerRow;
}
export function tableSetHeaderRow(t: TableData, value: boolean | undefined): void {
  if (t.table.headerRow !== value) {
    clearStaleSortState(t);
  }
  tableAssign(t, t.table, "headerRow", value);
}

export function tableTotalsRow(t: TableData): boolean | undefined {
  return t.table.totalsRow;
}
export function tableSetTotalsRow(t: TableData, value: boolean | undefined): void {
  if (t.table.totalsRow !== value && t.table.rawAttributes) {
    // `totalsRowShown` is preserved from the loaded file; once the public
    // totals-row state is changed the stale attribute must not survive.
    delete t.table.rawAttributes.totalsRowShown;
  }
  tableAssign(t, t.table, "totalsRow", value);
}

function tableEnsureStyle(t: TableData): TableStyleProperties {
  if (!t.table.style) {
    t.table.style = {};
  }
  return t.table.style;
}

export function tableTheme(t: TableData): TableStyleProperties["theme"] {
  return t.table.style?.theme;
}
export function tableSetTheme(t: TableData, value: TableStyleProperties["theme"]): void {
  tableEnsureStyle(t).theme = value;
}

export function tableShowFirstColumn(t: TableData): boolean | undefined {
  return t.table.style?.showFirstColumn;
}
export function tableSetShowFirstColumn(t: TableData, value: boolean | undefined): void {
  tableEnsureStyle(t).showFirstColumn = value;
}

export function tableShowLastColumn(t: TableData): boolean | undefined {
  return t.table.style?.showLastColumn;
}
export function tableSetShowLastColumn(t: TableData, value: boolean | undefined): void {
  tableEnsureStyle(t).showLastColumn = value;
}

export function tableShowRowStripes(t: TableData): boolean | undefined {
  return t.table.style?.showRowStripes;
}
export function tableSetShowRowStripes(t: TableData, value: boolean | undefined): void {
  tableEnsureStyle(t).showRowStripes = value;
}

export function tableShowColumnStripes(t: TableData): boolean | undefined {
  return t.table.style?.showColumnStripes;
}
export function tableSetShowColumnStripes(t: TableData, value: boolean | undefined): void {
  tableEnsureStyle(t).showColumnStripes = value;
}

// --- TableColumnView accessors (former Column getters/setters) ---------------

function tableColumnSet<K extends keyof TableColumnProperties>(
  view: TableColumnView,
  name: K,
  value: TableColumnProperties[K]
): void {
  tableCacheState(view.table);
  view.column[name] = value;
}

export function tableColumnName(view: TableColumnView): string {
  return view.column.name;
}
export function tableColumnSetName(view: TableColumnView, value: string): void {
  tableColumnSet(view, "name", value);
}

export function tableColumnFilterButton(view: TableColumnView): boolean | undefined {
  return view.column.filterButton;
}
export function tableColumnSetFilterButton(
  view: TableColumnView,
  value: boolean | undefined
): void {
  view.column.filterButton = value;
}

export function tableColumnStyle(view: TableColumnView): Partial<Style> | undefined {
  return view.column.style;
}
export function tableColumnSetStyle(
  view: TableColumnView,
  value: Partial<Style> | undefined
): void {
  // Route through tableColumnSet so commit() will replay store() and propagate
  // the new style to the on-sheet cells.
  tableColumnSet(view, "style", value);
}

export function tableColumnTotalsRowLabel(view: TableColumnView): string | undefined {
  return view.column.totalsRowLabel;
}
export function tableColumnSetTotalsRowLabel(
  view: TableColumnView,
  value: string | undefined
): void {
  tableColumnSet(view, "totalsRowLabel", value);
}

export function tableColumnTotalsRowFunction(
  view: TableColumnView
): TableColumnProperties["totalsRowFunction"] {
  return view.column.totalsRowFunction;
}
export function tableColumnSetTotalsRowFunction(
  view: TableColumnView,
  value: TableColumnProperties["totalsRowFunction"]
): void {
  tableColumnSet(view, "totalsRowFunction", value);
}

export function tableColumnTotalsRowResult(view: TableColumnView): CellValue {
  return view.column.totalsRowResult;
}
export function tableColumnSetTotalsRowResult(
  view: TableColumnView,
  value: CellFormulaValue["result"]
): void {
  tableColumnSet(view, "totalsRowResult", value);
}

export function tableColumnTotalsRowFormula(view: TableColumnView): string | undefined {
  return view.column.totalsRowFormula;
}
export function tableColumnSetTotalsRowFormula(
  view: TableColumnView,
  value: string | undefined
): void {
  tableColumnSet(view, "totalsRowFormula", value);
}

export { sanitizeTableName };
