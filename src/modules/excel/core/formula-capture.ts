/**
 * Excel formula snapshot capture — converts concrete Excel records into the
 * formula engine's immutable snapshot representation.
 *
 * This is the only file in the engine pipeline that walks a live host
 * workbook; the rest of the pipeline consumes the immutable
 * `WorkbookSnapshot` this file produces.
 *
 * ## Responsibilities
 *
 * 1. `captureFormulaSnapshot()` — walk the workbook and produce an
 *    immutable `WorkbookSnapshot`.
 * 2. Cell value conversion — Date → serial number, rich text → string,
 *    shared formula translation, etc.
 */

import type { CellData } from "@excel/core/cell";
import { cellFormula, cellGetValue, cellResult, cellType } from "@excel/core/cell";
import { definedNamesGetAllEntries } from "@excel/core/defined-names";
import { Enums } from "@excel/core/enums";
import type { WorkbookData } from "@excel/core/workbook-core";
import { getWorksheets } from "@excel/core/workbook.browser";
import type { WorksheetData } from "@excel/core/worksheet";
import { getSheetDimensions, getTables } from "@excel/core/worksheet";
import type {
  CalcPropertiesSnapshot,
  CellSnapshot,
  DefinedNameSnapshot,
  FormulaCellKind,
  ResolvedTable,
  SnapshotCellValue,
  SnapshotErrorValue,
  TableColumnSnapshot,
  TableSnapshot,
  WorkbookPropertiesSnapshot,
  WorkbookSnapshot,
  WorksheetSnapshot
} from "@formula/integration/workbook-snapshot";
import { snapshotCellKey, scopedNameKey } from "@formula/integration/workbook-snapshot";
import { dateToExcel } from "@utils/utils.base";

// ============================================================================
// Build Workbook Snapshot
// ============================================================================

/**
 * Build a complete `WorkbookSnapshot` from a live workbook.
 *
 * This traverses all worksheets and cells once, converting everything to
 * engine-internal snapshot types. The result is a fully self-contained,
 * read-only data structure.
 */
export function captureFormulaSnapshot(workbook: WorkbookData): WorkbookSnapshot {
  const worksheets: WorksheetSnapshot[] = [];
  const worksheetsByName = new Map<string, WorksheetSnapshot>();
  const worksheetsById = new Map<number, WorksheetSnapshot>();

  const date1904 = workbook.properties?.date1904 ?? false;
  const hostWorksheets = getWorksheets(workbook);

  for (const ws of hostWorksheets) {
    const wsSnapshot = buildWorksheetSnapshot(ws, date1904);
    worksheets.push(wsSnapshot);
    worksheetsByName.set(ws._name.toLowerCase(), wsSnapshot);
    worksheetsById.set(ws.id, wsSnapshot);
  }

  const definedNames = buildDefinedNames(workbook, hostWorksheets);

  // Build table-by-name index for O(1) lookup
  const tablesByName = new Map<string, ResolvedTable>();
  for (const wsSnapshot of worksheets) {
    for (const table of wsSnapshot.tables) {
      if (table.name) {
        tablesByName.set(table.name.toLowerCase(), {
          table,
          sheetName: wsSnapshot.name
        });
      }
    }
  }

  const calcProperties: CalcPropertiesSnapshot = {
    fullCalcOnLoad: workbook.calcProperties?.fullCalcOnLoad,
    iterate: workbook.calcProperties?.iterate,
    iterateCount: workbook.calcProperties?.iterateCount,
    iterateDelta: workbook.calcProperties?.iterateDelta
  };

  const properties: WorkbookPropertiesSnapshot = {
    date1904
  };

  return {
    worksheets,
    worksheetsByName,
    worksheetsById,
    definedNames,
    tablesByName,
    calcProperties,
    properties
  };
}

// ============================================================================
// Build Worksheet Snapshot
// ============================================================================

function buildWorksheetSnapshot(ws: WorksheetData, date1904: boolean): WorksheetSnapshot {
  const cells = new Map<string, CellSnapshot>();
  const hiddenRows = new Set<number>();

  // Walk `_rows` directly rather than `eachRow({ includeEmpty: true })`, which
  // creates a row for every hole — capture is a read. Iterating the backing
  // array still observes the `hidden` flag on rows that have no populated cells
  // (a user may hide an empty row via the filter UI, and SUBTOTAL(1xx,…) has to
  // treat that row as hidden); a hole has no flag and no cells to miss.
  for (let i = 0; i < ws._rows.length; i++) {
    const row = ws._rows[i];
    if (!row) {
      continue;
    }
    const rowNumber = row.number;
    if (row.hidden) {
      hiddenRows.add(rowNumber);
    }
    row.cells.forEach((cell, index) => {
      if (!cell) {
        return;
      }
      const colNumber = index + 1;
      const cellSnapshot = buildCellSnapshot(cell, rowNumber, colNumber, date1904);
      if (cellSnapshot) {
        cells.set(snapshotCellKey(rowNumber, colNumber), cellSnapshot);
      }
    });
  }

  const dims = getSheetDimensions(ws);
  const dimensions =
    dims.top <= dims.bottom && dims.left <= dims.right
      ? { top: dims.top, left: dims.left, bottom: dims.bottom, right: dims.right }
      : null;

  const tables = buildTables(ws);

  // Snapshot plain rectangles so engine state never aliases live merge records.
  const mergedRegions = Object.values(ws._merges).map(r => ({
    top: r.top,
    left: r.left,
    bottom: r.bottom,
    right: r.right
  }));

  return {
    id: ws.id,
    name: ws._name,
    dimensions,
    cells,
    hiddenRows,
    tables,
    mergedRegions
  };
}

// ============================================================================
// Build Cell Snapshot
// ============================================================================

function buildCellSnapshot(
  cell: CellData,
  row: number,
  col: number,
  date1904: boolean
): CellSnapshot | null {
  const type = cellType(cell);

  // Skip truly empty cells
  if (type === Enums.ValueType.Null) {
    return null;
  }

  // Skip merge slaves — Excel treats them as blank for formula
  // purposes, but the host's `MergeValue` proxy would forward
  // `cell.value` from the master, so letting them into `cells` would
  // double-count master values in range aggregates. See
  // and the `Merge` case in `CellValueTypeLike`.
  if (type === Enums.ValueType.Merge) {
    return null;
  }

  // ── Formula cells ──
  if (type === Enums.ValueType.Formula) {
    return buildFormulaCellSnapshot(cell, row, col, date1904);
  }

  // ── Non-formula cells ──
  const value = convertCellValue(cellGetValue(cell), date1904);

  return {
    row,
    col,
    value,
    ghostOwner: cell._formulaGhostOwner,
    formulaKind: "none"
  };
}

function buildFormulaCellSnapshot(
  cell: CellData,
  row: number,
  col: number,
  date1904: boolean
): CellSnapshot | null {
  const model = cell._value.model;
  const formula = cellFormula(cell); // triggers shared formula translation for slaves

  if (formula == null) {
    // Formula cell with no parseable formula — capture the cached result
    const cachedResult = convertFormulaResult(cellResult(cell), date1904);
    return {
      row,
      col,
      value: cachedResult,
      formulaKind: "none"
    };
  }

  // Determine formula kind
  const kind = classifyFormulaKind(model);

  // Capture the cached result from the XLSX
  const cachedResult = convertFormulaResult(cellResult(cell), date1904);

  return {
    row,
    col,
    value: cachedResult,
    formulaKind: kind,
    formula,
    ref: model.ref,
    isDynamicArray: model.isDynamicArray ?? undefined
  };
}

/**
 * Classify a formula cell's kind based on its model properties.
 */
function classifyFormulaKind(model: {
  shareType?: string;
  ref?: string;
  formula?: string;
  sharedFormula?: string;
  isDynamicArray?: boolean;
}): FormulaCellKind {
  if (model.isDynamicArray) {
    return "dynamic-array";
  }

  if (model.shareType === "array" && model.ref) {
    return "cse";
  }

  if (model.shareType === "shared") {
    // shared-master has formula + ref, shared-slave has sharedFormula
    if (model.formula && model.ref) {
      return "shared-master";
    }
    if (model.sharedFormula) {
      return "shared-slave";
    }
  }

  return "normal";
}

// ============================================================================
// Value Conversion
// ============================================================================

/**
 * Convert a live cell value to a snapshot value.
 * - Dates → Excel serial number
 * - Rich text → plain string
 * - Errors → SnapshotErrorValue
 * - All other types pass through
 */
function convertCellValue(value: unknown, date1904: boolean): SnapshotCellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return dateToExcel(value, date1904);
  }
  if (isRecord(value) && typeof value.error === "string") {
    // Gate the error code through the known set so user-supplied values
    // like `{ error: "anything" }` can't pollute the snapshot. Unknown
    // strings fall back to #VALUE! — matches Excel's default diagnostic
    // when it reads an unrecognised error value from a persisted file.
    return { error: normalizeErrorCode(value.error) };
  }
  // Rich text → plain string
  if (isRecord(value) && Array.isArray(value.richText)) {
    return value.richText
      .map(run => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
      .join("");
  }
  // Hyperlink / other objects with text
  if (isRecord(value) && typeof value.text === "string") {
    return value.text;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeErrorCode(error: string): SnapshotErrorValue["error"] {
  switch (error) {
    case "#N/A":
    case "#NULL!":
    case "#DIV/0!":
    case "#VALUE!":
    case "#REF!":
    case "#NAME?":
    case "#NUM!":
    case "#CALC!":
    case "#SPILL!":
      return error;
    default:
      return "#VALUE!";
  }
}

/**
 * Convert a formula result to a snapshot value.
 */
function convertFormulaResult(result: unknown, date1904: boolean): SnapshotCellValue {
  if (result === undefined || result === null) {
    return null;
  }
  return convertCellValue(result, date1904);
}

// ============================================================================
// Build Tables
// ============================================================================

function buildTables(ws: WorksheetData): TableSnapshot[] {
  const tables: TableSnapshot[] = [];

  for (const t of getTables(ws)) {
    const model = t.table;
    if (!model || !model.tl) {
      continue;
    }

    const columns: TableColumnSnapshot[] = (model.columns || []).map(c => ({
      name: c.name
    }));

    tables.push({
      name: model.name || model.displayName || "",
      columns,
      topLeft: { row: model.tl.row, col: model.tl.col },
      dataRowCount: (model.rows || []).length,
      hasHeaderRow: model.headerRow !== false,
      hasTotalsRow: model.totalsRow === true
    });
  }

  return tables;
}

// ============================================================================
// Build Defined Names
// ============================================================================

function buildDefinedNames(
  workbook: WorkbookData,
  worksheets: readonly WorksheetData[]
): ReadonlyMap<string, DefinedNameSnapshot> {
  const map = new Map<string, DefinedNameSnapshot>();

  if (!workbook._definedNames) {
    return map;
  }

  // Build a sheet-id-to-name lookup for resolving localSheetId → sheet name.
  //
  // `localSheetId` stores the 0-based position in the XLSX-model sheet list,
  // which in this library corresponds to the index in `workbook.worksheets`
  // (the filtered+ordered view, see `workbook.xlsx/xform/book/workbook-xform.ts`
  // line 50-94 where `index` is incremented per rendered sheet).
  //
  // Iterate the array exactly once and capture the position directly — avoids
  // an O(n²) `indexOf` over a fresh array each call. Any caller that has
  // deleted sheets after creating scoped names is responsible for updating
  // `localSheetId` to match the new positions; this layer just reflects the
  // workbook's current state.
  const sheetIdToName = new Map<number, string>();
  const liveSheets = worksheets;
  for (let idx = 0; idx < liveSheets.length; idx++) {
    sheetIdToName.set(idx, liveSheets[idx]._name);
  }

  // getAllEntries() returns self-contained entries — no second lookup needed.
  const entries = definedNamesGetAllEntries(workbook._definedNames);
  for (const entry of entries) {
    if (!entry.ranges || entry.ranges.length === 0) {
      continue;
    }

    // Convert numeric localSheetId → sheet name string for the snapshot
    let scope: string | undefined;
    if (entry.localSheetId !== undefined) {
      scope = sheetIdToName.get(entry.localSheetId);
    }

    const snapshot: DefinedNameSnapshot = {
      name: entry.name,
      ranges: [...entry.ranges],
      ...(scope ? { scope } : {})
    };

    const key = scope ? scopedNameKey(scope, entry.name) : entry.name.toUpperCase();
    if (!map.has(key)) {
      map.set(key, snapshot);
    }
  }

  return map;
}
