// Type-only imports for the WorksheetData record shape. These are erased at
// compile time and never create a runtime dependency.
import type { AnchorData } from "@excel/core/anchor";
/**
 * worksheet-core — the low-level Worksheet container layer.
 *
 * Holds the plain-data `WorksheetData` record interface and the *container*
 * accessors that create / look up rows, columns and cells inside a worksheet.
 *
 * This module exists to break what would otherwise be an import cycle: the
 * cell / row / column modules need a few "by-coordinate" container operations
 * (e.g. resolving the `ColumnData` for a cell being created, or writing a value
 * by address), and the worksheet container needs to create row/column/cell
 * records. Keeping all of those operations here — strictly *above* cell/row/
 * column and *below* the heavy `worksheet.ts` feature module — yields a clean
 * one-directional dependency graph:
 *
 *     worksheet.ts  (image / table / pivot / chart / model / IO …)
 *        ↓ imports
 *     worksheet-core.ts  (WorksheetData + container accessors)
 *        ↓ imports
 *     cell.ts / row.ts / column.ts   (pure handle data + own-field ops)
 *        ↓ imports
 *     col-cache / range / enums / types / utils
 *
 * No file below this one imports the heavy `worksheet.ts`.
 */
import type { CellData, CellValueType } from "@excel/core/cell";
import {
  CellTypes,
  cellComment,
  cellCreate,
  cellGetValue,
  cellSetAlignment,
  cellSetBorder,
  cellSetComment,
  cellSetFill,
  cellSetFont,
  cellSetModel,
  cellSetNumFmt,
  cellSetProtection,
  cellSetValue,
  cellType,
  setFacet,
  setFacetCloned
} from "@excel/core/cell";
import type { ColumnData, ColumnDefn, ColumnHeaderValue, ColumnModel } from "@excel/core/column";
import { columnHeaders } from "@excel/core/column";
import type { DataValidationsData } from "@excel/core/data-validations";
import { Enums } from "@excel/core/enums";
import type { FormCheckboxData } from "@excel/core/form-control";
import type { WorksheetImage } from "@excel/core/image";
import type { OpaqueRelationship } from "@excel/core/opaque-part";
import type { PivotTable } from "@excel/core/pivot-table";
import type { RangeData } from "@excel/core/range";
import { rangeCreate, rangeRange } from "@excel/core/range";
import type { RowData, RowModel } from "@excel/core/row";
import {
  rowCreate,
  rowFindCell,
  rowHasValues,
  rowValues,
  resolveColumnKeyValue
} from "@excel/core/row";
import type { SparklineGroup } from "@excel/core/sparkline";
import type { TableData } from "@excel/core/table";
import type { Workbook } from "@excel/core/workbook";
import { ExcelError, InvalidAddressError } from "@excel/errors";
import type {
  Alignment,
  AutoFilter,
  Borders,
  CellValue,
  ColBreak,
  ConditionalFormattingOptions,
  DecodedAddress,
  Fill,
  Font,
  HeaderFooter,
  IgnoredError,
  PageSetup,
  Protection,
  RowBreak,
  RowValues,
  ShapeModel,
  Style,
  ThreadedComment,
  WatermarkOptions,
  WorksheetProperties,
  WorksheetState,
  WorksheetView
} from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import { copyStyle } from "@excel/utils/copy-style";

/** Opaque worksheet auto-filter criteria preserved for XLSX round trips. */
export interface AutoFilterCriteria {
  ref: string;
  xml: string;
  namespaceAttributes?: Record<string, string>;
}

export interface SheetProtection {
  sheet?: boolean;
  objects?: boolean;
  scenarios?: boolean;
  selectLockedCells?: boolean;
  selectUnlockedCells?: boolean;
  formatCells?: boolean;
  formatColumns?: boolean;
  formatRows?: boolean;
  insertColumns?: boolean;
  insertRows?: boolean;
  insertHyperlinks?: boolean;
  deleteColumns?: boolean;
  deleteRows?: boolean;
  sort?: boolean;
  autoFilter?: boolean;
  pivotTables?: boolean;
  algorithmName?: string;
  hashValue?: string;
  saltValue?: string;
  spinCount?: number;
}

/**
 * The range a chart occupies on a worksheet (resolved anchor form).
 */
export interface ChartAnchorRange {
  /** Top-left anchor (always present) */
  tl: AnchorData;
  /** Bottom-right anchor (only for twoCellAnchor) */
  br?: AnchorData;
  /** Absolute position in EMU (only for absoluteAnchor) */
  pos?: { x: number; y: number };
  /** Extent in EMU (for oneCellAnchor and absoluteAnchor) */
  ext?: { cx: number; cy: number };
  /** Anchor behaviour: oneCell, twoCell, or absolute */
  editAs?: string;
}

/**
 * Plain-data chart handle. Carries the owning worksheet, the 1-based classic
 * `chartNumber` (0 for chartEx) / `chartExNumber` (0 for classic), and the
 * resolved anchor range. Stored in `WorksheetData._charts`; all chart
 * operations are free `chart*` functions in the chart module taking this
 * record as the first argument.
 */
export interface ChartHandle {
  readonly worksheet: WorksheetData;
  chartNumber: number;
  chartExNumber: number;
  range: ChartAnchorRange;
}

/**
 * Plain-data worksheet record. The full state of a worksheet — no class. All
 * operations are free functions (container ops here, feature ops in
 * `worksheet.ts`).
 */
export interface WorksheetData {
  _workbook: Workbook;
  id: number;
  orderNo: number;
  _name: string;
  state: WorksheetState;
  _rows: RowData[];
  _columns: ColumnData[];
  _keys: { [key: string]: ColumnData };
  _merges: { [key: string]: RangeData };
  rowBreaks: RowBreak[];
  colBreaks: ColBreak[];
  properties: Partial<WorksheetProperties>;
  pageSetup: PageSetup;
  headerFooter: HeaderFooter;
  dataValidations: DataValidationsData;
  views: Partial<WorksheetView>[];
  autoFilter: AutoFilter | null;
  /**
   * Filter criteria captured from a loaded `<autoFilter>`. The public
   * `autoFilter` property is only a range, so criteria are carried verbatim to
   * survive a save; they are dropped automatically once the range changes.
   */
  _autoFilterCriteria?: AutoFilterCriteria;
  /** The worksheet's `<sortState>` block, preserved verbatim from a loaded file. */
  _sortStateXml?: string;
  /**
   * Relationships from this sheet to preserved parts this library does not model
   * — printer settings and query tables are the common cases.
   *
   * They live on the sheet rather than on the workbook because that is where
   * Excel looks for them, and they travel with the sheet's own model so that
   * reordering or renaming sheets cannot detach a part from the one that owns it.
   */
  _opaqueRels?: OpaqueRelationship[];
  /**
   * Set when this sheet stands in for a *chartsheet* the reader could not model.
   *
   * A chartsheet holds a chart rather than a cell grid, so reading its records as rows would invent cells that do not
   * exist; the reader keeps the name and position as an empty worksheet instead, and reports the substitution. That
   * repair is fine for a caller reading the workbook and wrong for one writing it back: the chartsheet's own part is
   * preserved and still reachable, so emitting a worksheet part for the placeholder as well produced *two* parts for
   * one declared sheet — thirteen relationship targets against twelve `BrtBundleSh` records, with the sheet's
   * relationship pointing at a 319-byte empty grid instead of at the chart.
   *
   * So it holds the *path* of the part it stands for, not a boolean: the writer needs to point the sheet's
   * relationship at the real chartsheet, and a flag would only tell it not to write the wrong thing.
   */
  _chartsheetPlaceholder?: string;
  /**
   * Notes a *streaming* worksheet kept, because it releases `_rows` at `commit()`.
   *
   * `readonly unknown[]` because the element is the XLSB writer's `SheetComment` and this layer must not depend on that
   * writer — the same reason `styledBlankRanges` is typed loosely on the model. Declared here rather than reached through
   * a cast at both ends, which is how `_styledBlankRanges` is still handled and is a weaker guarantee: a rename would
   * silently produce `undefined` instead of a compile error.
   *
   * Absent on a random-access worksheet, whose rows are still there when the package is written.
   */
  _retainedComments?: readonly unknown[];
  /**
   * Relationship id of the drawing this sheet already pointed at, from an XLSB read.
   *
   * XLSB stores the *reference* as a binary record while the drawing itself is XML this library keeps
   * as an opaque part, so the reference is the one piece a rewrite must reproduce. Nothing else uses
   * it: the XLSX writer rebuilds the reference from the modelled drawing, and a workbook that never
   * came from XLSB does not have one.
   */
  _xlsbDrawingRelationshipId?: string;
  /** Additional root namespace declarations needed by preserved worksheet XML. */
  _worksheetNamespaceAttributes?: Record<string, string>;
  _worksheetMcIgnorable?: string;
  _sortStateAutoFilterRef?: string;
  _media: WorksheetImage[];
  _shapes: ShapeModel[];
  _charts: ChartHandle[];
  _sparklineGroups: SparklineGroup[];
  sheetProtection: SheetProtection | null;
  tables: { [key: string]: TableData };
  pivotTables: PivotTable[];
  conditionalFormattings: ConditionalFormattingOptions[];
  formControls: FormCheckboxData[];
  ignoredErrors: IgnoredError[];
  threadedComments: Array<{ ref: string; comment: ThreadedComment }>;
  _headerRowCount?: number;
  _drawing: unknown;
  _watermark: WatermarkOptions | null;
  /** The exact media entry created by the watermark API, for precise removal. */
  _watermarkMedia: WorksheetImage | null;
  /**
   * Optional streaming-writer hook. Present on streaming worksheet writers,
   * absent on plain record worksheets; `_commitRow` dispatches to it when set.
   */
  _commitRow?: (row: RowData) => void;
}

// =============================================================================
// Sheet identity accessors
// =============================================================================

export function getSheetName(ws: WorksheetData): string {
  return ws._name;
}

export function getSheetWorkbook(ws: WorksheetData): Workbook {
  return ws._workbook;
}

// =============================================================================
// Column-key registry
// =============================================================================

export function getColumnKey(ws: WorksheetData, key: string): ColumnData | undefined {
  return ws._keys[key];
}

export function setColumnKey(ws: WorksheetData, key: string, value: ColumnData): void {
  ws._keys[key] = value;
}

export function deleteColumnKey(ws: WorksheetData, key: string): void {
  delete ws._keys[key];
}

export function eachColumnKey(
  ws: WorksheetData,
  f: (column: ColumnData, key: string) => void
): void {
  Object.keys(ws._keys).forEach(key => f(ws._keys[key], key));
}

// =============================================================================
// Columns
// =============================================================================

export function getColumn(ws: WorksheetData, c: string | number): ColumnData {
  let colNum: number;
  if (typeof c === "string") {
    const col = ws._keys[c];
    if (col) {
      return col;
    }
    colNum = colCache.l2n(c);
  } else {
    colNum = c;
  }
  if (colNum > ws._columns.length) {
    let n = ws._columns.length + 1;
    while (n <= colNum) {
      ws._columns.push(columnCreate(ws, n++));
    }
  }
  return ws._columns[colNum - 1];
}

// =============================================================================
// Rows
// =============================================================================

export function _commitRow(ws: WorksheetData, row: RowData): void {
  // Streaming writers track committed rows via an internal offset; dispatch to the writer's own commit logic so the flat
  // `rowCommit` works on writer rows too.
  //
  // **For a plain worksheet this is deliberately a no-op, and the reason matters — it was tried as a throw.** The
  // justification here used to name the streaming *reader*, which does not call this at all, so the branch looked like a
  // silence covering a caller mistake. Refusing broke ten tests across four files, all through one shared fixture
  // builder: `__tests__/shared/test-values-sheet.ts` populates a worksheet with `cellSetValue` and `rowCommit`, and the
  // same function runs against a random-access `Worksheet` and a `Stream.WorksheetWriter`.
  //
  // That is what the no-op buys: `rowCommit` is the one call in the row-building vocabulary that only means something to
  // a streaming writer, so making it harmless elsewhere is what lets one piece of code fill either kind of sheet. A
  // caller who reaches for it on a random-access worksheet is not making a mistake — the rows are written when the
  // workbook is serialised, and committing is simply not a step there.
  if (typeof ws._commitRow === "function") {
    ws._commitRow(row);
  }
}

export function findRow(ws: WorksheetData, r: number): RowData | undefined {
  return ws._rows[r - 1];
}

export function findRows(
  ws: WorksheetData,
  start: number,
  length: number
): (RowData | undefined)[] {
  return ws._rows.slice(start - 1, start - 1 + length);
}

export function getRow(ws: WorksheetData, r: number): RowData {
  let row = ws._rows[r - 1];
  if (!row) {
    row = ws._rows[r - 1] = rowCreate(ws, r);
  }
  return row;
}

export function getRows(ws: WorksheetData, start: number, length: number): RowData[] | undefined {
  if (length < 1) {
    return undefined;
  }
  const rows: RowData[] = [];
  for (let i = start; i < start + length; i++) {
    rows.push(getRow(ws, i));
  }
  return rows;
}

export function eachRow(
  ws: WorksheetData,
  callback: (row: RowData, rowNumber: number) => void
): void;
export function eachRow(
  ws: WorksheetData,
  opt: { includeEmpty?: boolean },
  callback: (row: RowData, rowNumber: number) => void
): void;
export function eachRow(
  ws: WorksheetData,
  optOrCallback: { includeEmpty?: boolean } | ((row: RowData, rowNumber: number) => void),
  maybeCallback?: (row: RowData, rowNumber: number) => void
): void {
  let options: { includeEmpty?: boolean } | undefined;
  let callback: (row: RowData, rowNumber: number) => void;
  if (typeof optOrCallback === "function") {
    callback = optOrCallback;
  } else {
    options = optOrCallback;
    callback = maybeCallback!;
  }
  if (options && options.includeEmpty) {
    const n = ws._rows.length;
    for (let i = 1; i <= n; i++) {
      callback(getRow(ws, i), i);
    }
  } else {
    ws._rows.forEach(row => {
      if (row && rowHasValues(row)) {
        callback(row, row.number);
      }
    });
  }
}

export function getSheetValues(ws: WorksheetData): CellValue[][] {
  const rows: CellValue[][] = [];
  ws._rows.forEach(row => {
    if (row) {
      rows[row.number] = rowValues(row);
    }
  });
  return rows;
}

// =============================================================================
// Cells (by coordinate)
// =============================================================================

export function findCell(ws: WorksheetData, r: number | string, c?: number): CellData | undefined {
  const address = colCache.getAddress(r, c);
  const row = ws._rows[address.row - 1];
  return row ? rowFindCell(row, address.col) : undefined;
}

export function getCell(ws: WorksheetData, r: number | string, c?: number): CellData {
  const address = colCache.getAddress(r, c);
  const row = getRow(ws, address.row);
  return rowGetCellEx(row, address);
}

/**
 * Read every cell value in a rectangular range as a row-major matrix.
 *
 * The result is always exactly `bottom - top + 1` rows by `right - left + 1`
 * columns — blank rows and columns are never dropped, so `result[r][c]` maps
 * positionally onto the requested range regardless of how sparse the sheet is.
 * Cells that do not exist read as `null`.
 *
 * Unlike {@link getCell}, this never materialises rows or cells, so reading a
 * range leaves the worksheet (and everything derived from it — `rowCount`,
 * `columnCount`, memory footprint) untouched.
 *
 * Values carry the same semantics as a single {@link cellGetValue}: formula
 * cells yield a `FormulaValueData` record rather than the cached result, dates
 * yield `Date`, rich text and hyperlinks yield their object forms. Every cell of
 * a merged region yields the master cell's value.
 *
 * @param ws - Worksheet to read from.
 * @param range - An A1 range (`"G7:H19"`), a single address (`"G7"`), or a
 *   {@link RangeData} handle. Reversed corners are normalised, including on a
 *   hand-built handle. An optional sheet qualifier must name `ws` (compared
 *   case-insensitively, as Excel does).
 * @throws {InvalidAddressError} If the range cannot be decoded, is unbounded
 *   (`"A:A"`, `"1:5"`), or is unset — including the dimensions of a sheet that
 *   has no cells.
 * @throws {ExcelError} If the range is qualified with a different worksheet.
 */
export function getRangeValues(ws: WorksheetData, range: string | RangeData): CellValue[][] {
  const r = typeof range === "string" ? rangeCreate(range) : range;

  const bounds = [r.top, r.left, r.bottom, r.right];
  const decoded = bounds.every(n => Number.isInteger(n));
  const set = decoded && bounds.every(n => n >= 1);
  // `rangeTl`/`rangeToString` coerce 0 and NaN bounds to 1, so an unusable range
  // would render as a plausible-looking "A1:A1". Describe the raw bounds instead.
  const label =
    typeof range === "string"
      ? range
      : set
        ? rangeRange(r)
        : `{ top: ${r.top}, left: ${r.left}, bottom: ${r.bottom}, right: ${r.right} }`;

  if (!decoded) {
    // `colCache.decodeAddress` yields `undefined` for a missing row or column,
    // which `rangeCreate` turns into a NaN bound. That covers both unbounded
    // references ("A:A", "1:5") and strings it cannot decode at all.
    throw new InvalidAddressError(
      label,
      'expected a bounded A1 range like "G7:H19" — whole-column and whole-row references have no bounds to read'
    );
  }
  if (!set) {
    // All-zero is `rangeCreate`'s unset sentinel — e.g. `Range.create()`, or the
    // dimensions of a sheet with no cells. Reading it as "A1" would hide the bug.
    throw new InvalidAddressError(
      label,
      "range bounds must be 1-based row and column numbers; this range is unset or empty"
    );
  }
  if (r.sheetName) {
    const sheetName = getSheetName(ws);
    if (r.sheetName.toLowerCase() !== sheetName.toLowerCase()) {
      throw new ExcelError(
        `Range "${label}" refers to worksheet "${r.sheetName}" but was read from worksheet "${sheetName}"`
      );
    }
  }

  // `rangeCreate` normalises reversed corners, but `RangeData` is a plain record
  // a caller can hand-build, so normalise here too rather than deriving a
  // negative height and failing inside `new Array()`.
  const top = Math.min(r.top, r.bottom);
  const bottom = Math.max(r.top, r.bottom);
  const left = Math.min(r.left, r.right);
  const right = Math.max(r.left, r.right);

  const width = right - left + 1;
  const result: CellValue[][] = new Array(bottom - top + 1);

  for (let row = top; row <= bottom; row++) {
    const rowData: CellValue[] = new Array(width);
    const rowHandle = findRow(ws, row);
    for (let col = left; col <= right; col++) {
      const cell = rowHandle ? rowFindCell(rowHandle, col) : undefined;
      rowData[col - left] = cell ? cellGetValue(cell) : null;
    }
    result[row - top] = rowData;
  }

  return result;
}

// =============================================================================
// Row cell access (need the worksheet container to resolve columns)
// =============================================================================

export function rowGetCellEx(r: RowData, address: DecodedAddress): CellData {
  let cell = r.cells[address.col - 1];
  if (!cell) {
    const column = getColumn(r.worksheet, address.col);
    cell = cellCreate(r, column, address.address);
    r.cells[address.col - 1] = cell;
  }
  return cell;
}

export function rowGetCell(r: RowData, col: string | number): CellData {
  let colNum: number;
  if (typeof col === "string") {
    const column = getColumnKey(r.worksheet, col);
    colNum = column ? column.number : colCache.l2n(col);
  } else {
    colNum = col;
  }
  return (
    r.cells[colNum - 1] ||
    rowGetCellEx(r, {
      address: colCache.encodeAddress(r.number, colNum),
      row: r.number,
      col: colNum
    })
  );
}

export function rowSetValues(r: RowData, value: RowValues): void {
  r.cells = [];
  if (!value) {
    // empty row
  } else if (value instanceof Array) {
    let offset = 0;
    if (Object.prototype.hasOwnProperty.call(value, "0")) {
      offset = 1;
    }
    value.forEach((item, index) => {
      if (item !== undefined) {
        cellSetValue(
          rowGetCellEx(r, {
            address: colCache.encodeAddress(r.number, index + offset),
            row: r.number,
            col: index + offset
          }),
          item
        );
      }
    });
  } else {
    // `RowObject` is `object` so that plain interfaces are accepted without a
    // cast at every call site; key lookup is read-only, hence the local widening.
    const keyed = value as Record<string, unknown>;
    eachColumnKey(r.worksheet, (column: ColumnData, key: string) => {
      const resolved = resolveColumnKeyValue(keyed, key);
      if (resolved !== undefined) {
        cellSetValue(
          rowGetCellEx(r, {
            address: colCache.encodeAddress(r.number, column.number),
            row: r.number,
            col: column.number
          }),
          resolved as CellValue
        );
      }
    });
  }
}

// =============================================================================
// Column cell access (need the worksheet container)
// =============================================================================

export function columnSetKey(c: ColumnData, value: string | undefined): void {
  const existing = c.key && getColumnKey(c.worksheet, c.key);
  if (existing === c) {
    deleteColumnKey(c.worksheet, c.key!);
  }
  c.key = value;
  if (value) {
    setColumnKey(c.worksheet, value, c);
  }
}

export function columnEachCell(
  c: ColumnData,
  optOrCallback: { includeEmpty?: boolean } | ((cell: CellData, rowNumber: number) => void),
  maybeCallback?: (cell: CellData, rowNumber: number) => void
): void {
  let options: { includeEmpty?: boolean } | undefined;
  let callback: (cell: CellData, rowNumber: number) => void;
  if (typeof optOrCallback === "function") {
    callback = optOrCallback;
  } else {
    options = optOrCallback;
    callback = maybeCallback!;
  }
  const colNumber = c.number;
  eachRow(c.worksheet, options ?? {}, (row: RowData, rowNumber: number) => {
    callback(rowGetCell(row, colNumber), rowNumber);
  });
}

export function columnValues(c: ColumnData): CellValueType[] {
  const v: CellValueType[] = [];
  // Deliberately not via `columnEachCell`: its callback signature demands a
  // `CellData`, so it materialises a cell on every row of the column. This is a
  // getter, so walk the rows non-destructively instead.
  const rows = c.worksheet._rows;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    const cell = rowFindCell(row, c.number);
    if (cell && cellType(cell) !== Enums.ValueType.Null) {
      v[row.number] = cellGetValue(cell);
    }
  }
  return v;
}

export function columnSetValues(c: ColumnData, v: CellValueType[]): void {
  if (!v) {
    return;
  }
  const colNumber = c.number;
  let offset = 0;
  if (Object.prototype.hasOwnProperty.call(v, "0")) {
    offset = 1;
  }
  v.forEach((value, index) => {
    cellSetValue(getCell(c.worksheet, index + offset, colNumber), value as never);
  });
}

// =============================================================================
// Column creation / defn application (needs container ops via columnSetKey /
// columnSetHeader, so it lives in the core layer above column.ts)
// =============================================================================

const DEFAULT_COLUMN_WIDTH = 9;

function applyDefn(c: ColumnData, value: ColumnDefn | undefined): void {
  if (value) {
    columnSetKey(c, value.key);
    c.width = value.width !== undefined ? value.width : DEFAULT_COLUMN_WIDTH;
    c.outlineLevel = value.outlineLevel;
    c.style = value.style ? ((copyStyle(value.style) as Partial<Style>) ?? {}) : {};
    // headers must be set after style
    columnSetHeader(c, value.header);
    c.hidden = !!value.hidden;
    c.bestFit = value.bestFit;
  } else {
    c.header = undefined;
    c.key = undefined;
    c.width = undefined;
    c.style = {};
    c.outlineLevel = 0;
    c.bestFit = undefined;
  }
}

export function columnCreate(
  worksheet: WorksheetData,
  number: number,
  defn?: ColumnDefn | false
): ColumnData {
  const c: ColumnData = { worksheet, number, style: {} };
  if (defn !== false) {
    applyDefn(c, defn ?? undefined);
  }
  return c;
}

export function columnSetDefn(c: ColumnData, value: ColumnDefn | undefined): void {
  applyDefn(c, value);
}

export function columnSetHeader(c: ColumnData, value: ColumnHeaderValue | undefined): void {
  if (value !== undefined) {
    c.header = value;
    columnHeaders(c).forEach((cellValue, index) => {
      cellSetValue(getCell(c.worksheet, index + 1, c.number), cellValue as never);
    });
  } else {
    c.header = undefined;
  }
}

export function columnFromModel(worksheet: WorksheetData, cols: ColumnModel[]): ColumnData[] {
  const columns: ColumnData[] = [];
  let count = 1;
  let index = 0;
  cols = (cols ?? []).sort((pre, next) => pre.min - next.min);
  while (index < cols.length) {
    const col = cols[index++];
    while (count < col.min) {
      columns.push(columnCreate(worksheet, count++));
    }
    while (count <= col.max) {
      columns.push(columnCreate(worksheet, count++, col));
    }
  }
  return columns;
}

// =============================================================================
// Column style setters (propagate to every cell in the column -> need
// container iteration, so they live in the core layer)
// =============================================================================

export function columnSetNumFmt(c: ColumnData, value: string | undefined): void {
  c.style.numFmt = value;
  columnEachCell(c, cell => {
    cellSetNumFmt(cell, value);
  });
}

export function columnSetFont(c: ColumnData, value: Partial<Font> | undefined): void {
  c.style.font = value;
  columnEachCell(c, cell => {
    cellSetFont(cell, value ? structuredClone(value) : value);
  });
}

export function columnSetAlignment(c: ColumnData, value: Partial<Alignment> | undefined): void {
  c.style.alignment = value;
  columnEachCell(c, cell => {
    cellSetAlignment(cell, value ? structuredClone(value) : value);
  });
}

export function columnSetProtection(c: ColumnData, value: Partial<Protection> | undefined): void {
  c.style.protection = value;
  columnEachCell(c, cell => {
    cellSetProtection(cell, value ? structuredClone(value) : value);
  });
}

export function columnSetBorder(c: ColumnData, value: Partial<Borders> | undefined): void {
  c.style.border = value;
  columnEachCell(c, cell => {
    cellSetBorder(cell, value ? structuredClone(value) : value);
  });
}

export function columnSetFill(c: ColumnData, value: Fill | undefined): void {
  c.style.fill = value;
  columnEachCell(c, cell => {
    cellSetFill(cell, value ? structuredClone(value) : value);
  });
}

/**
 * Merge a partial style into the column, propagating each provided facet to
 * every existing cell in the column. Mirrors {@link cellSetStyle} /
 * `rowSetStyle`: only facets present on `style` are applied; omitted facets are
 * left untouched.
 *
 * Walks the column's cells a single time applying every provided facet, rather
 * than one full column pass per facet (the per-facet `columnSet*` setters each
 * iterate the whole column, so delegating to all six would scan the column up
 * to six times).
 */
export function columnSetStyle(c: ColumnData, style: Partial<Style>): void {
  const keys = (Object.keys(style) as (keyof Style)[]).filter(k => style[k] !== undefined);
  if (keys.length === 0) {
    return;
  }
  // The column's own style holds each facet by reference; every cell gets a
  // deep-cloned copy so cells never alias the column's style sub-objects.
  for (const k of keys) {
    setFacet(c.style, k, style[k]);
  }
  columnEachCell(c, cell => {
    for (const k of keys) {
      setFacetCloned(cell.style, k, style[k]);
    }
  });
}

// =============================================================================
// Row operations that need the worksheet container (cell creation / iteration)
// =============================================================================

export function rowSetModel(r: RowData, value: RowModel): void {
  if (value.number !== r.number) {
    throw new ExcelError("Invalid row number in model");
  }
  r.cells = [];
  let previousAddress: DecodedAddress | undefined;
  value.cells.forEach(cellModel => {
    switch (cellModel.type) {
      case CellTypes.Merge:
        break;
      default: {
        let address: DecodedAddress | undefined;
        if (cellModel.address) {
          address = colCache.decodeAddress(cellModel.address);
        } else if (previousAddress) {
          const { row } = previousAddress;
          const col = previousAddress.col + 1;
          address = {
            row,
            col,
            address: colCache.encodeAddress(row, col),
            $col$row: `$${colCache.n2l(col)}$${row}`
          };
        }
        previousAddress = address;
        if (!address) {
          break;
        }
        const cell = rowGetCellEx(r, address);
        cellSetModel(cell, cellModel);
        break;
      }
    }
  });

  if (value.height != null) {
    r.height = value.height;
  } else {
    r.height = undefined;
  }
  if (value.customHeight != null) {
    r.customHeight = value.customHeight;
  } else {
    r.customHeight = undefined;
  }
  r.hidden = value.hidden;
  r.outlineLevel = value.outlineLevel ?? 0;
  r.dyDescent = value.dyDescent;
  r.style = value.style ? structuredClone(value.style) : {};
}

export function rowEachCell(
  r: RowData,
  optOrCallback: { includeEmpty?: boolean } | ((cell: CellData, colNumber: number) => void),
  maybeCallback?: (cell: CellData, colNumber: number) => void
): void {
  let options: { includeEmpty?: boolean } | null = null;
  let callback: (cell: CellData, colNumber: number) => void;
  if (typeof optOrCallback === "function") {
    callback = optOrCallback;
  } else {
    options = optOrCallback;
    callback = maybeCallback!;
  }
  if (options && options.includeEmpty) {
    const n = r.cells.length;
    for (let i = 1; i <= n; i++) {
      callback(rowGetCell(r, i), i);
    }
  } else {
    r.cells.forEach((cell, index) => {
      if (cell && cellType(cell) !== Enums.ValueType.Null) {
        callback(cell, index + 1);
      }
    });
  }
}

export function rowSplice(r: RowData, start: number, count: number, ...inserts: CellValue[]): void {
  const nKeep = start + count;
  const nExpand = inserts.length - count;
  const nEnd = r.cells.length;
  let i: number;
  let cSrc: CellData | undefined;
  let cDst: CellData | undefined;

  if (nExpand < 0) {
    for (i = start + inserts.length; i <= nEnd; i++) {
      cDst = r.cells[i - 1];
      cSrc = r.cells[i - nExpand - 1];
      if (cSrc) {
        cDst = rowGetCell(r, i);
        cellSetValue(cDst, cSrc._formulaGhostOwner === undefined ? cellGetValue(cSrc) : null);
        cDst.style = copyStyle(cSrc.style) ?? {};
        cellSetComment(cDst, cellComment(cSrc));
      } else if (cDst) {
        cellSetValue(cDst, null);
        cDst.style = {};
        cellSetComment(cDst, undefined);
      }
    }
  } else if (nExpand > 0) {
    for (i = nEnd; i >= nKeep; i--) {
      cSrc = r.cells[i - 1];
      if (cSrc) {
        cDst = rowGetCell(r, i + nExpand);
        cellSetValue(cDst, cSrc._formulaGhostOwner === undefined ? cellGetValue(cSrc) : null);
        cDst.style = copyStyle(cSrc.style) ?? {};
        cellSetComment(cDst, cellComment(cSrc));
      } else {
        r.cells[i + nExpand - 1] = undefined!;
      }
    }
  }

  for (i = 0; i < inserts.length; i++) {
    cDst = rowGetCell(r, start + i);
    cellSetValue(cDst, inserts[i]);
    cDst.style = {};
    cellSetComment(cDst, undefined);
  }
}

/**
 * Hand a row to the stream it belongs to — `Stream.commitRow` on the public surface.
 *
 * **A no-op when the row's worksheet is not a streaming writer, and that is part of the contract rather than an
 * oversight.** `rowCommit` is the only call in the row-building vocabulary that means something exclusively to a
 * streaming writer; making it harmless elsewhere is what lets one piece of code populate either kind of sheet, which is
 * how this library's own shared fixture builder works. On a random-access worksheet the rows are written when the
 * workbook is serialised, so there is no commit step to perform.
 *
 * Stated here because it cannot be inferred from the signature: a caller cannot otherwise tell whether nothing happened
 * because nothing needed to. See `_commitRow` for what refusing it cost.
 */
export function rowCommit(r: RowData): void {
  _commitRow(r.worksheet, r);
}
// =============================================================================
// Row addition / style propagation (worksheet container mutations)
// =============================================================================

export function get_lastRowNumber(ws: WorksheetData): number {
  // need to cope with results of splice
  const rows = ws._rows;
  let n = rows.length;
  while (n > 0 && rows[n - 1] === undefined) {
    n--;
  }
  return n;
}

export function get_nextRow(ws: WorksheetData): number {
  return get_lastRowNumber(ws) + 1;
}

export function _copyStyle(
  ws: WorksheetData,
  src: number,
  dest: number,
  styleEmpty: boolean = false
): void {
  const rSrc = getRow(ws, src);
  const rDst = getRow(ws, dest);
  rDst.style = (copyStyle(rSrc.style) as Partial<Style>) ?? {};
  rowEachCell(rSrc, { includeEmpty: styleEmpty }, (cell: CellData, colNumber: number) => {
    rowGetCell(rDst, colNumber).style = (copyStyle(cell.style) as Partial<Style>) ?? {};
  });
  rDst.height = rSrc.height;
}

export function _setStyleOption(ws: WorksheetData, pos: number, style: string = "n"): void {
  if (style[0] === "o" && findRow(ws, pos + 1) !== undefined) {
    _copyStyle(ws, pos + 1, pos, style[1] === "+");
  } else if (style[0] === "i" && findRow(ws, pos - 1) !== undefined) {
    _copyStyle(ws, pos - 1, pos, style[1] === "+");
  }
}

export function addRow(ws: WorksheetData, value: RowValues, style: string = "n"): RowData {
  const rowNo = get_nextRow(ws);
  const row = getRow(ws, rowNo);
  rowSetValues(row, value);
  _setStyleOption(ws, rowNo, style[0] === "i" ? style : "n");
  return row;
}

export function addRows(ws: WorksheetData, value: RowValues[], style: string = "n"): RowData[] {
  const rows: RowData[] = [];
  value.forEach(row => {
    rows.push(addRow(ws, row, style));
  });
  return rows;
}

/**
 * Look up a table on the worksheet by name. Pure data accessor over the
 * `tables` record — kept in the core layer (not `worksheet.ts`) so the chart
 * module can read table ranges without forming a `worksheet → chart →
 * worksheet` import cycle.
 */
export function getTable(ws: WorksheetData, name: string): TableData {
  return ws.tables[name];
}

/** All tables defined on the worksheet. See {@link getTable} for the layering rationale. */
export function getTables(ws: WorksheetData): TableData[] {
  return Object.values(ws.tables);
}

// ============================================================================
// Panes and the auto-filter
// ============================================================================

/**
 * Freeze rows and columns so they stay in view while the rest scrolls.
 *
 * `columns` and `rows` are how many to hold — `freeze(ws, 1, 1)` pins the first column and the header row.
 * Zero for either means that axis does not freeze, and `freeze(ws, 0, 0)` is the same as {@link unfreeze}.
 *
 * ## Why this exists
 *
 * A frozen pane is a `views` entry, and `views` had no public setter — so the only way to freeze anything was
 * `Worksheet.setModel(sheet, { ...Worksheet.getModel(sheet), views: [{ state: "frozen", … }] })`. That is not a
 * workaround a caller should have to find: it requires knowing the OOXML field names, that `xSplit` counts
 * *columns* despite the name, and that `topLeftCell` has to be derived from the two splits or the sheet scrolls
 * to the wrong place. Two of the examples here did exactly that and said so in a comment.
 *
 * `topLeftCell` is computed rather than accepted, because it is not an independent choice: it is the first cell
 * *outside* the frozen region, and any other value is a file that scrolls somewhere the author did not ask for.
 */
export function freeze(ws: WorksheetData, columns = 0, rows = 0): void {
  const heldColumns = Math.max(0, Math.trunc(columns));
  const heldRows = Math.max(0, Math.trunc(rows));
  if (heldColumns === 0 && heldRows === 0) {
    unfreeze(ws);
    return;
  }
  const topLeft = `${colCache.n2l(heldColumns + 1)}${heldRows + 1}`;
  ws.views = [
    {
      state: "frozen",
      // `xSplit` is a column count and `ySplit` a row count, despite reading like coordinates.
      ...(heldColumns === 0 ? {} : { xSplit: heldColumns }),
      ...(heldRows === 0 ? {} : { ySplit: heldRows }),
      topLeftCell: topLeft,
      activeCell: topLeft
    }
  ];
}

/**
 * Split the sheet into resizable panes at a point measured in **twentieths of a point**.
 *
 * Distinct from {@link freeze} in the file and in behaviour: a split pane can be dragged and scrolls
 * independently, a frozen one cannot. The units are the format's — `xSplit`/`ySplit` mean columns and rows for a
 * frozen view and twips for a split one, which is the kind of overloading a public member should absorb rather
 * than pass on, so this function's name says which it is.
 */
export function split(ws: WorksheetData, x = 0, y = 0): void {
  const horizontal = Math.max(0, Math.trunc(x));
  const vertical = Math.max(0, Math.trunc(y));
  if (horizontal === 0 && vertical === 0) {
    unfreeze(ws);
    return;
  }
  ws.views = [
    {
      state: "split",
      ...(horizontal === 0 ? {} : { xSplit: horizontal }),
      ...(vertical === 0 ? {} : { ySplit: vertical }),
      // The pane the cursor starts in. Bottom-right whenever both axes split, which is what Excel does.
      activePane:
        horizontal > 0 && vertical > 0 ? "bottomRight" : horizontal > 0 ? "topRight" : "bottomLeft"
    }
  ];
}

/** Remove any frozen or split panes, leaving a normally scrolling sheet. */
export function unfreeze(ws: WorksheetData): void {
  ws.views = [];
}

/**
 * The frozen or split panes currently set, or `undefined` for a normally scrolling sheet.
 *
 * Returns the model's own view entry rather than a reduced shape, because a caller reading this wants whatever
 * is there — including the fields {@link freeze} does not set, such as `zoomScale`, which a file read from Excel
 * may carry.
 */
export function panes(ws: WorksheetData): Partial<WorksheetView> | undefined {
  const view = ws.views?.[0];
  return view === undefined || view.state === "normal" ? undefined : view;
}

/**
 * Put an auto-filter over a range, or remove it with `null`.
 *
 * The range may be an `A1:C4` string or the `{ from, to }` pair the model also accepts; both are passed through
 * unchanged, because the writers already normalise them and a second normalisation here would be a second set
 * of rules for the same string.
 *
 * `autoFilter` was a model field with no setter, so an example that wanted one had to go through
 * `getModel`/`setModel` — see {@link freeze} for why that is not an acceptable answer for a documented feature.
 */
export function setAutoFilter(ws: WorksheetData, range: AutoFilter | null): void {
  ws.autoFilter = range;
}

/** The auto-filter range, or `null` when the sheet has none. */
export function autoFilter(ws: WorksheetData): AutoFilter | null {
  return ws.autoFilter ?? null;
}
