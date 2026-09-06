import type { PivotChartOptions } from "@excel/chart/model/types";
import type { ColumnData } from "@excel/core/column";
import type {
  CacheField,
  DataField,
  ParsedCacheDefinition,
  ParsedCacheRecords,
  PivotError,
  PivotTableChartFormat,
  PivotTableSubtotal,
  RecordValue,
  SharedItemValue
} from "@excel/core/pivot-table-types";
import {
  METRIC_DISPLAY_NAMES,
  pivotError,
  isPivotError,
  formatPivotError,
  VALID_SUBTOTALS
} from "@excel/core/pivot-table-types";
import type { RangeData } from "@excel/core/range";
import { rangeCreate, rangeExpand } from "@excel/core/range";
import type { RowData } from "@excel/core/row";
import { rowDimensions, rowValues } from "@excel/core/row";
import type { TableData } from "@excel/core/table";
import { tableModel } from "@excel/core/table";
import type { WorksheetData } from "@excel/core/worksheet-core";
import {
  columnValues,
  getColumn,
  getRow,
  getSheetName,
  getSheetValues
} from "@excel/core/worksheet-core";
import { PivotTableError } from "@excel/errors";
import { colCache } from "@excel/utils/col-cache";
import { range } from "@utils/utils";

// Re-export the pure OOXML data types/constants that were relocated to
// pivot-table-types.ts, preserving backward compatibility for existing
// `import { X } from "@excel/core/pivot-table"` call sites (worksheet.ts,
// surface/pivot.ts, etc.).
export {
  type CacheField,
  type DataField,
  METRIC_DISPLAY_NAMES,
  type ParsedCacheDefinition,
  type ParsedCacheRecords,
  type PivotError,
  pivotError,
  isPivotError,
  formatPivotError,
  type PivotTableChartFormat,
  type PivotTableSubtotal,
  type RecordValue,
  type SharedItemValue,
  VALID_SUBTOTALS
};

/**
 * Interface representing the source data abstraction for pivot tables.
 * This allows both Worksheet and Table to be used as pivot table data sources.
 */
export interface PivotTableSource {
  /** Name of the worksheet containing the source data (used in pivotCacheDefinition) */
  name: string;
  /**
   * Name of the source Table (e.g., "SalesData").
   * When present, pivotCacheDefinition uses `<worksheetSource name="..."/>` instead of ref+sheet.
   */
  tableName?: string;
  /** Get a row by 1-indexed number (worksheet RowData or a `{ values }` adapter). */
  getRow(rowNumber: number): RowData | { values: unknown[] };
  /** Get a column by 1-indexed number (worksheet ColumnData or a `{ values }` adapter). */
  getColumn(columnNumber: number): ColumnData | { values: unknown[] };
  /** Get all sheet values as a sparse 2D array */
  getSheetValues(): unknown[][];
  /** Dimensions of the source data (plain range record). */
  dimensions: RangeData;
}

/** Extract the values array from a getRow result (RowData or `{ values }`). */
function rowValuesOf(row: RowData | { values: unknown[] }): unknown[] {
  return "cells" in row ? rowValues(row as RowData) : (row as { values: unknown[] }).values;
}

/** Extract the values array from a getColumn result (ColumnData or `{ values }`). */
function columnValuesOf(col: ColumnData | { values: unknown[] }): unknown[] {
  return "values" in col && Array.isArray((col as { values: unknown[] }).values)
    ? (col as { values: unknown[] }).values
    : columnValues(col as ColumnData);
}

/**
 * A value field specification with optional per-field metric override.
 * Use this instead of a plain string when you need different aggregation
 * metrics for individual value fields.
 *
 * @example
 * ```ts
 * values: [
 *   { name: "Sales", metric: "sum" },
 *   { name: "Quantity", metric: "count" },
 *   { name: "Price", metric: "average" },
 * ]
 * ```
 */
export interface PivotTableValue {
  /** Column name to aggregate */
  name: string;
  /**
   * Aggregation metric for this specific value field.
   * Overrides the table-wide `metric` when specified.
   * @default inherited from PivotTableModel.metric (which defaults to 'sum')
   */
  metric?: PivotTableSubtotal;
}

/**
 * Model for creating a new pivot table.
 * Pass this to worksheet.addPivotTable() to create a pivot table.
 */
export interface PivotTableModel {
  /**
   * Source worksheet for the pivot table data.
   * Either sourceSheet or sourceTable must be provided (mutually exclusive).
   *
   * Accepts a {@link WorksheetData} record directly (the common case) or a
   * pre-built {@link PivotTableSource} adapter; {@link resolveSource} wraps a
   * bare worksheet record in an adapter automatically.
   */
  sourceSheet?: WorksheetData | PivotTableSource;
  /**
   * Source table for the pivot table data.
   * Either sourceSheet or sourceTable must be provided (mutually exclusive).
   * The table must have headerRow=true and contain at least one data row.
   */
  sourceTable?: TableData;
  /** Column names to use as row fields in the pivot table */
  rows: string[];
  /**
   * Column names to use as column fields in the pivot table.
   * If omitted or empty, Excel will use "Values" as the column field.
   * When multiple values are specified alongside columns, the synthetic
   * "∑Values" pseudo-field is appended to the column axis automatically.
   * @default []
   */
  columns?: string[];
  /**
   * Column names (or value field specifications) to aggregate in the pivot table.
   * Each entry can be a plain string (column name) or a {@link PivotTableValue}
   * object with a per-field metric override.
   *
   * @example
   * ```ts
   * // Simple: all values use the table-wide metric
   * values: ["Sales", "Quantity"]
   *
   * // Per-value metrics
   * values: [
   *   { name: "Sales", metric: "sum" },
   *   { name: "Quantity", metric: "count" },
   *   { name: "Price", metric: "average" },
   * ]
   *
   * // Mixed: plain strings inherit table-wide metric
   * values: ["Sales", { name: "Quantity", metric: "count" }]
   * ```
   */
  values: (string | PivotTableValue)[];
  /**
   * Column names to use as page fields (report filters) in the pivot table.
   * Page fields appear as dropdown filters above the pivot table.
   * @default []
   */
  pages?: string[];
  /**
   * Default aggregation metric for all value fields.
   * Individual value fields can override this via {@link PivotTableValue.metric}.
   * @default 'sum'
   */
  metric?: PivotTableSubtotal;
  /**
   * Controls whether pivot table style overrides worksheet column widths.
   * - '0': Preserve worksheet column widths (useful for custom sizing)
   * - '1': Apply pivot table style width/height (default Excel behavior)
   * @default '1'
   */
  applyWidthHeightFormats?: "0" | "1";
  /**
   * Top-left cell anchor for the pivot table, e.g. `"A3"` or `"E5"`.
   *
   * Specifies where the pivot's displayed block begins. When page filters are
   * present they occupy rows from the anchor downward, followed by a blank
   * separator row and then the pivot body (header + data). The library sizes
   * the initial placeholder range automatically — when Excel refreshes the
   * pivot cache it expands the pivot from this anchor to its full size.
   *
   * When multiple pivot tables share a worksheet, each must be given a distinct
   * anchor with enough vertical or horizontal room between them so the expanded
   * pivots do not overlap. Excel reports "there's already a PivotTable there"
   * when refreshing two overlapping pivots, so this option is required for
   * dashboards that host several pivots on one sheet.
   *
   * Accepts a single-cell address (`"A3"`). A range reference (`"A3:C5"`) is
   * also tolerated — only the top-left cell is used; the range extent is
   * recomputed from the pivot's field layout.
   *
   * @default `"A3"` (row 3 of column A)
   */
  ref?: string;
}

/**
 * Internal pivot table representation used by the library.
 * This is the processed model after calling makePivotTable().
 */
export interface PivotTable {
  /** Pivot table display name, defaults to `PivotTable${tableNumber}` for new tables. */
  name?: string;
  /** Worksheet containing the pivot table. */
  worksheetName?: string;
  /** Source data adapter (always present for new pivot tables) */
  source?: PivotTableSource;
  /** Field indices for row fields */
  rows: number[];
  /** Field indices for column fields */
  columns: number[];
  /** Field indices for value fields */
  values: number[];
  /** Field indices for page fields (report filters) */
  pages?: number[];
  /** Default aggregation metric */
  metric: PivotTableSubtotal;
  /** Per-value metric overrides (parallel to `values` array). Falls back to `metric`. */
  valueMetrics: PivotTableSubtotal[];
  /** Cache fields with shared items */
  cacheFields: CacheField[];
  /** Cache ID for linking to pivot cache */
  cacheId: string;
  /** Width/height format setting */
  applyWidthHeightFormats: "0" | "1";
  /**
   * Top-left cell anchor for the pivot block (e.g. `"A3"`).
   * When present, overrides the default `A{3+pageOffset}` anchor used by the
   * writer. The anchor represents the cell where the pivot's displayed area
   * starts (page filters if any, followed by a blank row, followed by the
   * pivot body).
   */
  ref?: string;
  /** 1-indexed table number for file naming (pivotTable1.xml, pivotTable2.xml, etc.) */
  tableNumber: number;
  /** Workbook relationship ID, assigned during write by addWorkbookRels() */
  rId?: string;
  /** Flag indicating this pivot table was loaded from file (not newly created) */
  isLoaded?: boolean;
  /** Data fields for loaded pivot tables */
  dataFields?: DataField[];
  /** Cache definition for loaded pivot tables */
  cacheDefinition?: ParsedCacheDefinition;
  /** Cache records for loaded pivot tables */
  cacheRecords?: ParsedCacheRecords;
  /** Root chartFormat attribute used by pivot charts. */
  chartFormat?: number;
  /** Chart format entries used by pivot charts. */
  chartFormats?: PivotTableChartFormat[];
  /** Structured pivot chart metadata attached by addPivotChart/addPivotChartsheet. */
  pivotChartOptions?: PivotChartOptions;
}

/**
 * Data rows start at index 2 in the 1-based sparse row arrays:
 * index 0 = empty (1-based array convention), index 1 = header row.
 */
const DATA_START_INDEX = 2;

/**
 * Creates a PivotTableSource adapter from a Table object.
 * This allows Tables to be used as pivot table data sources with the same interface as Worksheets.
 */
function createTableSourceAdapter(table: TableData): PivotTableSource {
  const tblModel = tableModel(table);

  // Validate that table has headerRow enabled (required for pivot table column names)
  if (tblModel.headerRow === false) {
    throw new PivotTableError(
      "Cannot create pivot table from a table without headers. Set headerRow: true on the table."
    );
  }

  // Validate table has data rows
  if (!tblModel.rows || tblModel.rows.length === 0) {
    throw new PivotTableError(
      "Cannot create pivot table from an empty table. Add data rows to the table."
    );
  }

  const columnNames = tblModel.columns.map(col => col.name);

  // Check for duplicate column names
  const nameSet = new Set<string>();
  for (const name of columnNames) {
    if (nameSet.has(name)) {
      throw new PivotTableError(
        `Duplicate column name "${name}" found in table. Pivot tables require unique column names.`
      );
    }
    nameSet.add(name);
  }

  // Build the full data array: headers + rows
  const headerRow = [undefined, ...columnNames]; // sparse array starting at index 1
  const dataRows = tblModel.rows.map(row => [undefined, ...row]); // sparse array starting at index 1

  // Calculate the range reference for the table
  const tl = tblModel.tl;
  if (!tl) {
    throw new PivotTableError(`Table "${tblModel.name}" is missing top-left cell address (tl)`);
  }
  const startRow = tl.row;
  const startCol = tl.col;
  const endRow = startRow + tblModel.rows.length; // header row + data rows
  const endCol = startCol + columnNames.length - 1;

  // Use the worksheet name (not table name) for pivotCacheDefinition's worksheetSource
  // The sheet attribute in worksheetSource must reference the actual worksheet name
  const worksheetName = getSheetName(table.worksheet);
  const tableName = tblModel.name;

  return {
    name: worksheetName,
    tableName,
    getRow(rowNumber: number): { values: unknown[] } {
      if (rowNumber === 1) {
        return { values: headerRow };
      }
      const dataIndex = rowNumber - DATA_START_INDEX; // rowNumber 2 maps to index 0
      if (dataIndex >= 0 && dataIndex < dataRows.length) {
        return { values: dataRows[dataIndex] };
      }
      return { values: [] };
    },
    getColumn(columnNumber: number): { values: unknown[] } {
      // Validate column number is within bounds
      if (columnNumber < 1 || columnNumber > columnNames.length) {
        return { values: [] };
      }
      // Values should be sparse array with header at index 1, data starting at index 2
      const values: unknown[] = [];
      values[1] = columnNames[columnNumber - 1];
      for (let i = 0; i < tblModel.rows.length; i++) {
        values[i + 2] = tblModel.rows[i][columnNumber - 1];
      }
      return { values };
    },
    getSheetValues(): unknown[][] {
      // Return sparse array where index 1 is header row, and subsequent indices are data rows
      const result: unknown[][] = [];
      result[1] = headerRow;
      for (let i = 0; i < dataRows.length; i++) {
        result[i + 2] = dataRows[i];
      }
      return result;
    },
    dimensions: rangeCreate(startRow, startCol, endRow, endCol)
  };
}

/** Base cache ID starts at 10 (Excel convention), each subsequent table increments */
const BASE_CACHE_ID = 10;

/**
 * Resolves the data source from the model, supporting both sourceSheet and sourceTable.
 * Validates that exactly one source is provided.
 */
function resolveSource(model: PivotTableModel): PivotTableSource {
  if (model.sourceSheet && model.sourceTable) {
    throw new PivotTableError("Cannot specify both sourceSheet and sourceTable. Choose one.");
  }
  if (model.sourceTable) {
    return createTableSourceAdapter(model.sourceTable);
  }
  if (!model.sourceSheet) {
    throw new PivotTableError("Either sourceSheet or sourceTable must be provided.");
  }
  // A de-classed worksheet (WorksheetData record) is identified structurally
  // by its `_rows` field; a pre-built PivotTableSource adapter has none.
  const sourceSheet = model.sourceSheet;
  if ("_rows" in sourceSheet) {
    const ws = sourceSheet;
    return {
      name: getSheetName(ws),
      getRow: (rowNumber: number) => getRow(ws, rowNumber),
      getColumn: (columnNumber: number) => getColumn(ws, columnNumber),
      getSheetValues: () => getSheetValues(ws) as unknown[][],
      get dimensions(): RangeData {
        return computeSourceDimensions(ws);
      }
    };
  }
  return sourceSheet;
}

/** Bounding range of populated cells in a worksheet record (avoids importing the heavy worksheet module). */
function computeSourceDimensions(ws: WorksheetData): RangeData {
  const dims = rangeCreate();
  ws._rows.forEach(row => {
    if (row) {
      const rd = rowDimensions(row);
      if (rd) {
        rangeExpand(dims, row.number, rd.min, row.number, rd.max);
      }
    }
  });
  return dims;
}

/** Resolve a value entry to its column name string */
function resolveValueName(v: string | PivotTableValue): string {
  return typeof v === "string" ? v : v.name;
}

/** Resolve a value entry's metric (or undefined if inheriting table-wide default) */
function resolveValueMetric(v: string | PivotTableValue): PivotTableSubtotal | undefined {
  return typeof v === "string" ? undefined : v.metric;
}

function makePivotTable(
  worksheet: { workbook: { pivotTables: PivotTable[] }; name: string },
  model: PivotTableModel
): PivotTable {
  // Resolve source (validates exactly one source is provided)
  const source = resolveSource(model);

  validate(model, source);

  const { rows } = model;
  const columns = model.columns ?? [];
  const pages = model.pages ?? [];
  const valueNames = model.values.map(resolveValueName);
  const defaultMetric: PivotTableSubtotal = model.metric ?? "sum";
  const valueMetrics = model.values.map(v => resolveValueMetric(v) ?? defaultMetric);

  const cacheFields = makeCacheFields(source, [...rows, ...columns, ...pages], valueNames);

  const nameToIndex: Record<string, number> = {};
  for (let i = 0; i < cacheFields.length; i++) {
    nameToIndex[cacheFields[i].name] = i;
  }
  const resolveIndex = (fieldName: string, role: string): number => {
    const idx = nameToIndex[fieldName];
    if (idx === undefined) {
      throw new PivotTableError(`${role} field "${fieldName}" not found in cache fields`);
    }
    return idx;
  };
  const rowIndices = rows.map(row => resolveIndex(row, "Row"));
  const columnIndices = columns.map(column => resolveIndex(column, "Column"));
  const valueIndices = valueNames.map(value => resolveIndex(value, "Value"));
  const pageIndices = pages.map(page => resolveIndex(page, "Page"));

  // R9-B1: Calculate tableNumber as max(existing)+1 to avoid collision with loaded
  // pivot tables that may have non-contiguous numbering (e.g. [1, 2, 5]).
  // Using length+1 would collide when adding multiple new tables.
  const existingTableNumbers = worksheet.workbook.pivotTables
    .map(pt => pt.tableNumber)
    .filter(n => Number.isFinite(n));
  const tableNumber =
    existingTableNumbers.length > 0
      ? existingTableNumbers.reduce((a, b) => (a > b ? a : b), -Infinity) + 1
      : 1;

  // Dynamic cacheId: avoid collision with existing (loaded) pivot tables.
  // Find the max cacheId already in use and start from max+1.
  const existingCacheIds = worksheet.workbook.pivotTables
    .map(pt => parseInt(pt.cacheId, 10))
    .filter(id => Number.isFinite(id));
  // R8-O3: Use reduce instead of Math.max(...spread) to avoid stack overflow with many pivot tables
  const nextCacheId =
    existingCacheIds.length > 0
      ? existingCacheIds.reduce((a, b) => (a > b ? a : b), -Infinity) + 1
      : BASE_CACHE_ID + tableNumber - 1;

  // Normalise the optional user-supplied anchor. A range (e.g. "A3:C5") is
  // reduced to its top-left cell; the pivot's own field layout determines the
  // extent of the placeholder location written to XML.
  const ref = normalisePivotRef(model.ref);

  // form pivot table object
  return {
    name: `PivotTable${tableNumber}`,
    worksheetName: worksheet.name,
    source,
    rows: rowIndices,
    columns: columnIndices,
    values: valueIndices,
    pages: pageIndices,
    metric: defaultMetric,
    valueMetrics,
    cacheFields,
    cacheId: String(nextCacheId),
    // Control whether pivot table style overrides worksheet column widths
    // '0' = preserve worksheet column widths (useful for custom sizing)
    // '1' = apply pivot table style width/height (default Excel behavior)
    applyWidthHeightFormats: model.applyWidthHeightFormats ?? "1",
    ref,
    // Table number for file naming (pivotTable1.xml, pivotTable2.xml, etc.)
    tableNumber
  };
}

/**
 * Normalise a user-supplied pivot anchor to a canonical top-left cell address
 * (e.g. `"A3"`). Accepts either a single cell or a range; ranges are collapsed
 * to their top-left cell. Returns `undefined` when the input is missing.
 */
function normalisePivotRef(ref: string | undefined): string | undefined {
  if (ref === undefined) {
    return undefined;
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new PivotTableError(
      `Invalid pivot table ref "${String(ref)}". Provide a cell address like "A3".`
    );
  }
  // Strip an optional sheet prefix ("Sheet1!A3") so users can pass through
  // range strings composed elsewhere without surprises.
  const trimmed = ref.trim().replace(/^[^!]+!/, "");
  const topLeft = trimmed.includes(":") ? trimmed.split(":", 1)[0] : trimmed;
  let decoded: { col?: number; row?: number };
  try {
    decoded = colCache.decodeAddress(topLeft);
  } catch {
    throw new PivotTableError(
      `Invalid pivot table ref "${ref}". Provide a cell address like "A3".`
    );
  }
  if (!decoded.col || !decoded.row) {
    throw new PivotTableError(
      `Invalid pivot table ref "${ref}". Both column and row are required (e.g. "A3").`
    );
  }
  return `${colCache.n2l(decoded.col)}${decoded.row}`;
}

function validate(model: PivotTableModel, source: PivotTableSource): void {
  const columns = model.columns ?? [];
  const pages = model.pages ?? [];
  const valueNames = model.values.map(resolveValueName);

  // Get header names from source (already resolved)
  const headerNames = rowValuesOf(source.getRow(1)).slice(1);

  // Validate no empty header names (null, undefined, empty-string, or whitespace-only).
  // Note: numeric 0 and boolean false are valid headers (they coerce to "0"/"false").
  for (let i = 0; i < headerNames.length; i++) {
    const h = headerNames[i];
    if (h === null || h === undefined || h === "" || (typeof h === "string" && h.trim() === "")) {
      throw new PivotTableError(
        `Empty or missing header name at column ${i + 1} in ${source.name}. Pivot tables require all columns to have non-empty headers.`
      );
    }
  }

  // Validate no duplicate header names
  const headerDupCheck = new Set<string>();
  for (const h of headerNames) {
    const name = String(h);
    if (headerDupCheck.has(name)) {
      throw new PivotTableError(
        `Duplicate header name "${name}" found in ${source.name}. Pivot tables require unique column names.`
      );
    }
    headerDupCheck.add(name);
  }

  // Use Set for O(1) lookup — coerce to String for consistent comparison with user-supplied names
  const headerNameSet = new Set(headerNames.map(String));
  const validateFieldExists = (name: string): void => {
    if (!headerNameSet.has(name)) {
      throw new PivotTableError(`The header name "${name}" was not found in ${source.name}.`);
    }
  };
  for (const name of model.rows) {
    validateFieldExists(name);
  }
  for (const name of columns) {
    validateFieldExists(name);
  }
  for (const name of valueNames) {
    validateFieldExists(name);
  }
  for (const name of pages) {
    validateFieldExists(name);
  }

  // Validate no duplicate field names across axis areas (rows, columns, pages).
  // A field can only belong to one axis area. Values can overlap with axis areas (dataField="1").
  const fieldToAxis = new Map<string, string>();
  const axisAreas = [
    { name: "rows", fields: model.rows },
    { name: "columns", fields: columns },
    { name: "pages", fields: pages }
  ];
  for (const area of axisAreas) {
    for (const field of area.fields) {
      const existing = fieldToAxis.get(field);
      if (existing === area.name) {
        throw new PivotTableError(
          `Duplicate field "${field}" in ${area.name}. Each field can only appear once per axis area.`
        );
      } else if (existing) {
        throw new PivotTableError(
          `Field "${field}" cannot appear in both ${existing} and ${area.name}. Each field can only be assigned to one axis area.`
        );
      }
      fieldToAxis.set(field, area.name);
    }
  }

  if (!model.rows.length) {
    throw new PivotTableError("No pivot table rows specified.");
  }

  // Allow empty columns - Excel will use "Values" as column field
  if (model.values.length < 1) {
    throw new PivotTableError("Must have at least one value.");
  }

  // Validate metric values at runtime (guards against `as any` bypasses)
  if (model.metric !== undefined && !VALID_SUBTOTALS.has(model.metric)) {
    throw new PivotTableError(
      `Invalid metric "${model.metric}". Must be one of: ${[...VALID_SUBTOTALS].join(", ")}.`
    );
  }
  for (const v of model.values) {
    const perMetric = resolveValueMetric(v);
    if (perMetric !== undefined && !VALID_SUBTOTALS.has(perMetric)) {
      throw new PivotTableError(
        `Invalid metric "${perMetric}" on value field "${resolveValueName(v)}". Must be one of: ${[...VALID_SUBTOTALS].join(", ")}.`
      );
    }
  }

  // Validate no duplicate value field names
  const valueDupCheck = new Set<string>();
  for (const name of valueNames) {
    if (valueDupCheck.has(name)) {
      throw new PivotTableError(
        `Duplicate value field "${name}". Each value field name must be unique.`
      );
    }
    valueDupCheck.add(name);
  }

  // Multiple values with columns is supported — the synthetic "Values" pseudo-field
  // (field x="-2") is appended to colFields so Excel positions the data field labels
  // correctly on the column axis.
}

/**
 * R8-B2: Unwrap complex cell value types to a primitive suitable for pivot table shared items.
 * - CellErrorValue ({error:"#REF!"}) → PivotErrorValue
 * - CellRichTextValue ({richText:[...]}) → concatenated plain text
 * - CellFormulaValue / CellArrayFormulaValue / CellSharedFormulaValue → result value (recursive)
 * - CellHyperlinkValue ({text,hyperlink}) → text string
 * - CellCheckboxValue ({checkbox:bool}) → boolean
 * - Other objects → String(v)
 */
function unwrapCellValue(v: unknown): string | number | boolean | Date | PivotError | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== "object") {
    // Already a primitive (string, number, boolean)
    return v as string | number | boolean;
  }
  if (v instanceof Date) {
    return v;
  }
  if (isPivotError(v)) {
    return v;
  }
  const obj = v as Record<string, unknown>;
  // CellErrorValue: { error: "#REF!" } → PivotError with code "REF!" (strip leading #)
  if (typeof obj.error === "string") {
    const errorStr = obj.error as string;
    return pivotError(errorStr.startsWith("#") ? errorStr.slice(1) : errorStr);
  }
  // CellFormulaValue / CellArrayFormulaValue / CellSharedFormulaValue: { formula/sharedFormula, result }
  if ("formula" in obj || "sharedFormula" in obj) {
    const result = obj.result;
    if (result === undefined || result === null) {
      return null;
    }
    // result can be number | string | boolean | Date | CellErrorValue — recurse
    return unwrapCellValue(result);
  }
  // CellRichTextValue: { richText: [{text:"..."}, ...] }
  if (Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map(rt => rt.text ?? "").join("");
  }
  // CellHyperlinkValue: { text, hyperlink }
  if (typeof obj.text === "string" && typeof obj.hyperlink === "string") {
    return obj.text;
  }
  // CellCheckboxValue: { checkbox: boolean }
  if (typeof obj.checkbox === "boolean") {
    return obj.checkbox;
  }
  // Unknown object — fallback to string
  return String(v);
}

function makeCacheFields(
  source: PivotTableSource,
  fieldNamesWithSharedItems: string[],
  valueFieldNames: string[]
): CacheField[] {
  // Cache fields are used in pivot tables to reference source data.
  // Fields in fieldNamesWithSharedItems get their unique values extracted as sharedItems.
  // Fields in valueFieldNames (but not in fieldNamesWithSharedItems) get min/max calculated.
  // Other fields are unused and get null sharedItems.

  const names = rowValuesOf(source.getRow(1));
  // Use Set for O(1) lookup instead of object
  const sharedItemsFields = new Set(fieldNamesWithSharedItems);
  const valueFields = new Set(valueFieldNames);

  const aggregate = (columnIndex: number): SharedItemValue[] => {
    const columnValues = columnValuesOf(source.getColumn(columnIndex));
    // Build unique values set directly, skipping header (index 0,1).
    // null/undefined are tracked separately (collapsed to a single null sentinel)
    // because Set treats each null as the same key but undefined as a separate key,
    // and we need null in sharedItems so renderCellNew can find it via indexOf.
    const uniqueValues = new Set<SharedItemValue>();
    // R8-B12: track error codes separately to avoid duplicates (e.g., two
    // pivotError("#REF!") values).
    const seenErrors = new Map<string, PivotError>();
    let hasNull = false;
    for (let i = DATA_START_INDEX; i < columnValues.length; i++) {
      // R8-B2: Unwrap complex cell values (formula results, rich text, errors, etc.)
      const v = unwrapCellValue(columnValues[i]);
      if (v === null || (typeof v === "number" && isNaN(v))) {
        hasNull = true;
      } else if (isPivotError(v)) {
        // R8-B12: Deduplicate pivot errors by error code
        if (!seenErrors.has(v.code)) {
          seenErrors.set(v.code, v);
          uniqueValues.add(v);
        }
      } else {
        uniqueValues.add(v);
      }
    }
    // **In the order the data presents them, not sorted.**
    //
    // A cache field's shared items are addressed by index — a `BrtBeginSXVI`'s `iCache`, a `<x v="2"/>` — so their order
    // is not presentation, it is identity. Excel writes them in first-appearance order, and sorting them therefore
    // renumbered every item and every reference to one: the oracle's `05-pivots` case showed `AMER, APAC, EMEA` against
    // Excel's `APAC, EMEA, AMER`, which is exactly the order the source column presents. Twenty-seven of the
    // thirty-three record differences against Excel's own files came from this single call.
    //
    // A `Set` preserves insertion order, so the values are already in it — `toSortedArray` was undoing that.
    const ordered = [...uniqueValues];
    // Append null at the end (OOXML convention: <m/> items go last in sharedItems)
    if (hasNull) {
      ordered.push(null);
    }
    return ordered;
  };

  // Calculate min/max and integer status for numeric fields
  const getMinMax = (
    columnIndex: number
  ): { minValue: number; maxValue: number; allInteger: boolean } | null => {
    const columnValues = columnValuesOf(source.getColumn(columnIndex));
    let min = Infinity;
    let max = -Infinity;
    let hasNumeric = false;
    let allInteger = true;
    for (let i = DATA_START_INDEX; i < columnValues.length; i++) {
      // R8-B10: Unwrap formula/complex cell values to extract numeric results
      const unwrapped = unwrapCellValue(columnValues[i]);
      if (typeof unwrapped === "number" && !isNaN(unwrapped)) {
        hasNumeric = true;
        if (unwrapped < min) {
          min = unwrapped;
        }
        if (unwrapped > max) {
          max = unwrapped;
        }
        if (!Number.isInteger(unwrapped)) {
          allInteger = false;
        }
      }
    }
    return hasNumeric ? { minValue: min, maxValue: max, allInteger } : null;
  };

  /**
   * The cache field's `numFmtId`, which for a date column is not zero.
   *
   * Excel writes `14` — the built-in short-date format — for a source column of dates, *even when the source file's own
   * `<cacheField numFmtId="0">` says otherwise: it is derived from the column, not copied. Without it a date field's
   * `BrtBeginPCDField` claims the General format, and a consumer that trusts the cache rather than the sheet displays a
   * serial number.
   *
   * A serial date is a number in the cell model, so the values cannot answer this on their own — the number format is
   * what distinguishes `45306` the date from `45306` the quantity, which is also how Excel decides.
   */
  const numberFormatIdFor = (columnIndex: number): string | undefined => {
    const columnValues = columnValuesOf(source.getColumn(columnIndex));
    let sawDate = false;
    for (let i = DATA_START_INDEX; i < columnValues.length; i++) {
      const cell = columnValues[i];
      const value = unwrapCellValue(cell);
      if (value === null || value === undefined) {
        continue;
      }
      if (value instanceof Date) {
        sawDate = true;
        continue;
      }
      const numFmt = (cell as { style?: { numFmt?: string | { formatCode?: string } } } | undefined)
        ?.style?.numFmt;
      const code = typeof numFmt === "string" ? numFmt : numFmt?.formatCode;
      // A date format names a date or time component outside a literal.
      if (typeof code === "string" && /(?:^|[^\\])[dmyhs]/i.test(code)) {
        sawDate = true;
        continue;
      }
      // Anything else in the column means it is not a date field.
      return undefined;
    }
    // `14` is `mm-dd-yy`, the built-in Excel writes here.
    return sawDate ? "14" : undefined;
  };

  const withNumberFormat = (columnIndex: number): { numFmtId?: string } => {
    const id = numberFormatIdFor(columnIndex);
    return id === undefined ? {} : { numFmtId: id };
  };

  // Build result array
  const result: CacheField[] = [];
  for (const columnIndex of range(1, names.length)) {
    const rawName = names[columnIndex];
    const name = String(rawName);
    if (sharedItemsFields.has(name)) {
      // Field used for rows/columns - extract unique values as sharedItems
      result.push({
        name,
        sharedItems: aggregate(columnIndex),
        ...withNumberFormat(columnIndex)
      });
    } else if (valueFields.has(name)) {
      // Field used only for values (aggregation) - calculate min/max
      const minMax = getMinMax(columnIndex);
      result.push({
        name,
        sharedItems: null,
        ...withNumberFormat(columnIndex),
        containsNumber: minMax ? "1" : undefined,
        minValue: minMax?.minValue,
        maxValue: minMax?.maxValue,
        containsInteger: minMax?.allInteger ? "1" : undefined
      });
    } else {
      // **An unused field gets empty shared items, whatever its type — and a date is not the exception it looks like.**
      //
      // Excel's own save of the oracle's `05-pivots` appears to contradict this: one of its three caches materialises
      // three `BrtPCDIDatetime` for a `Sold` column that no axis uses. It does not. **The cache numbering differs
      // between the two files** — Excel's `pivotCacheDefinition3.bin` serves the sheet this library's
      // `pivotCacheDefinition1.bin` serves — and pairing the caches by *filename* rather than by the pivot table that
      // points at them inverts the finding completely. Paired correctly:
      //
      // | field 2 (`Sold`) | Excel shared items | Excel record |
      // | ---------------- | ------------------ | ------------ |
      // | on the row axis  | 3                  | index, 16 B  |
      // | on the column axis | 3                | index, 16 B  |
      // | on no axis       | **0**              | **inline, 20 B** |
      //
      // So the rule is the axis, and an unused field's *values* travel inline in the records instead — which is why
      // giving it shared items also shortened every `BrtPCRRecord` from 20 bytes to 16 and made the two halves
      // disagree about how to read the same column.
      //
      // A previous attempt added a date special case here on the strength of the filename pairing. It is recorded
      // because the reasoning was sound and the data was not: two earlier attempts at this same field went the same
      // way, one of them taking the oracle from 100 differences to 155.
      // Unused string or numeric field — empty shared items, which is what Excel writes for those.
      result.push({ name, sharedItems: null, ...withNumberFormat(columnIndex) });
    }
  }
  return result;
}

export { makePivotTable };
