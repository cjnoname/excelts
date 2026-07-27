/**
 * Workbook Snapshot — Immutable data layer for the formula engine.
 *
 * The snapshot captures all workbook state needed for formula compilation
 * and evaluation as plain, read-only data structures. Runtime/compile code
 * must depend only on these types — never on live Workbook/Worksheet/Cell
 * objects.
 *
 * ## Design Principles
 *
 * 1. **Immutable** — all interfaces use `readonly` modifiers. The engine
 *    must never mutate snapshot data.
 * 2. **Self-contained** — every piece of information the engine needs
 *    (cell values, formula text, table metadata, defined names, calc
 *    properties) is captured up front.
 * 3. **No @excel/ imports** — this file defines pure data types. Concrete
 *    hosts own snapshot capture and writeback outside the formula module.
 */

// ============================================================================
// Error Value (self-contained, mirrors CellErrorValue)
// ============================================================================

/**
 * Error codes recognized by the formula engine.
 * This is an engine-internal type that avoids importing from `@excel/types`.
 */
export type ErrorCode =
  | "#N/A"
  | "#REF!"
  | "#NAME?"
  | "#DIV/0!"
  | "#NULL!"
  | "#VALUE!"
  | "#NUM!"
  | "#SPILL!"
  | "#CALC!";

export interface SnapshotErrorValue {
  readonly error: ErrorCode;
}

// ============================================================================
// Cell Values
// ============================================================================

/**
 * A cell's raw value as captured in the snapshot.
 *
 * - `Date` is NOT included — dates are stored as their Excel serial number.
 *   The snapshot builder converts Date objects to serial numbers at capture
 *   time so the engine never needs to reason about Date objects.
 * - Rich text is flattened to a plain string.
 */
export type SnapshotCellValue = number | string | boolean | SnapshotErrorValue | null;

// ============================================================================
// Cell Snapshot
// ============================================================================

/**
 * The kind of formula a cell contains.
 *
 * - `"none"` — not a formula cell (literal value)
 * - `"normal"` — ordinary formula
 * - `"shared-master"` — master cell of a shared formula group
 * - `"shared-slave"` — slave cell that inherits from a shared master
 * - `"cse"` — legacy CSE (Ctrl+Shift+Enter) array formula
 * - `"dynamic-array"` — Excel 365 dynamic array formula
 */
export type FormulaCellKind =
  | "none"
  | "normal"
  | "shared-master"
  | "shared-slave"
  | "cse"
  | "dynamic-array";

/**
 * Snapshot of a single cell.
 *
 * Only cells that contain data or formulas are captured — truly empty
 * positions are represented by the absence of a CellSnapshot in the
 * worksheet's cell map.
 */
export interface CellSnapshot {
  /** 1-based row number. */
  readonly row: number;
  /** 1-based column number. */
  readonly col: number;

  // ── Value ──

  /** The cell's raw value (for non-formula cells) or cached result (for formula cells). */
  readonly value: SnapshotCellValue;
  /** Source spill key when this cell is an engine-owned ghost. */
  readonly ghostOwner?: string;

  // ── Formula ──

  /** The formula classification. */
  readonly formulaKind: FormulaCellKind;
  /**
   * The formula source text.
   * - For normal / shared-master / CSE / dynamic-array: the actual formula.
   * - For shared-slave: the *translated* formula (already offset from master).
   * - For non-formula cells: `undefined`.
   */
  readonly formula?: string;
  /**
   * For CSE and shared-master formulas: the target range in "A1:B2" format.
   * Used by the materialize layer to determine where results are written.
   */
  readonly ref?: string;
  /**
   * Whether this is a dynamic array formula (explicit `isDynamicArray` flag
   * from the XLSX model, or inferred from the top-level function name).
   */
  readonly isDynamicArray?: boolean;
  /**
   * The cached result from the XLSX file (before engine evaluation).
   * Used by `shouldPreserveCachedResult` to avoid overwriting usable data
   * when the engine returns #NAME? for an unsupported function.
   */
  readonly cachedResult?: SnapshotCellValue;
}

// ============================================================================
// Worksheet Snapshot
// ============================================================================

/**
 * Snapshot of a single worksheet.
 */
export interface WorksheetSnapshot {
  /** Stable worksheet identifier (survives renames). */
  readonly id: number;
  /** Worksheet name (used as the key for cross-sheet references). */
  readonly name: string;

  // ── Dimensions ──

  /**
   * The used range of the worksheet. `null` if the sheet has no data.
   * All values are 1-based.
   */
  readonly dimensions: {
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
  } | null;

  // ── Cell Data ──

  /**
   * All cells with data, keyed by `"row:col"` (e.g. `"1:1"` for A1).
   * Only non-empty cells are present.
   */
  readonly cells: ReadonlyMap<string, CellSnapshot>;

  /**
   * Rows that are hidden. Used by SUBTOTAL's 1xx-variant codes
   * (101-111) and AGGREGATE option 5/7 to skip hidden rows during
   * aggregation. Excel distinguishes filter-hidden vs manually hidden,
   * but our worksheet model carries a single `row.hidden` boolean for
   * either case — SUBTOTAL 1xx/AGGREGATE treat them identically anyway,
   * and SUBTOTAL 9 (plain) always skips filter-hidden rows (not
   * distinguishable here, so we conservatively treat them as visible).
   * 1-based row numbers.
   */
  readonly hiddenRows: ReadonlySet<number>;

  // ── Tables ──

  /** Tables defined in this worksheet. */
  readonly tables: readonly TableSnapshot[];

  // ── Merged Regions ──

  /**
   * Merged regions on this worksheet, as 1-based inclusive rectangles.
   * Consulted by the writeback planner to reject `#SPILL!` conflicts;
   * the evaluator does not need this since merge slaves are already
   * filtered out of `cells`.
   */
  readonly mergedRegions: readonly {
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
  }[];
}

// ============================================================================
// Table Snapshot
// ============================================================================

/**
 * Column definition within a table.
 */
export interface TableColumnSnapshot {
  readonly name: string;
}

/**
 * Snapshot of a table (ListObject) within a worksheet.
 */
export interface TableSnapshot {
  /** The table name (used in structured references). */
  readonly name: string;
  /** Column definitions — order matches physical column order. */
  readonly columns: readonly TableColumnSnapshot[];
  /** Top-left corner of the table (1-based). */
  readonly topLeft: { readonly row: number; readonly col: number };
  /** Number of data rows (excludes header and totals). */
  readonly dataRowCount: number;
  /** Whether the table has a header row (default true). */
  readonly hasHeaderRow: boolean;
  /** Whether the table has a totals row. */
  readonly hasTotalsRow: boolean;
}

// ============================================================================
// Defined Name Snapshot
// ============================================================================

/**
 * A single defined name in the workbook.
 *
 * Defined names can reference:
 * - A cell or range: `"Sheet1!$A$1:$B$2"`
 * - A formula expression: `"LAMBDA(x,y,x+y)"`
 * - Multiple areas (currently unsupported by the engine)
 */
export interface DefinedNameSnapshot {
  /** The defined name (case-insensitive). */
  readonly name: string;
  /**
   * The range strings associated with this name.
   * Usually a single entry. Multi-area names (length > 1) are not supported
   * by the engine and will produce #VALUE!.
   */
  readonly ranges: readonly string[];
  /**
   * The scope of this defined name.
   * - `undefined` or empty string means workbook-scoped (global).
   * - A sheet name means this name is local to that worksheet.
   *
   * Excel allows the same name to exist both as a workbook-scoped name
   * and as a sheet-scoped name on specific worksheets. When a formula on
   * Sheet1 references the name "Total", the engine first looks for a
   * sheet-scoped name on Sheet1, then falls back to the workbook-scoped name.
   */
  readonly scope?: string;
}

// ============================================================================
// Calculation Properties
// ============================================================================

/**
 * Calculation settings from the workbook.
 */
export interface CalcPropertiesSnapshot {
  /** Whether to perform a full calculation on load. */
  readonly fullCalcOnLoad?: boolean;
  /** Whether iterative calculation is enabled (for circular references). */
  readonly iterate?: boolean;
  /** Maximum number of iterations (default 100). */
  readonly iterateCount?: number;
  /** Maximum change threshold for convergence (default 0.001). */
  readonly iterateDelta?: number;
}

// ============================================================================
// Workbook Properties
// ============================================================================

/**
 * Global workbook properties relevant to the formula engine.
 */
export interface WorkbookPropertiesSnapshot {
  /** Whether the workbook uses the 1904 date system. */
  readonly date1904?: boolean;
}

// ============================================================================
// Workbook Snapshot (Top-Level)
// ============================================================================

/**
 * A table resolved with its containing worksheet name.
 * Used by the `tablesByName` index for O(1) table lookup.
 */
export interface ResolvedTable {
  readonly table: TableSnapshot;
  readonly sheetName: string;
}

/**
 * Complete, immutable snapshot of all workbook state needed by the formula
 * engine. This is the sole input to the compile → evaluate → materialize
 * pipeline.
 */
export interface WorkbookSnapshot {
  /** All worksheets in workbook order. */
  readonly worksheets: readonly WorksheetSnapshot[];

  /** Quick lookup: worksheet name (lowercase) → WorksheetSnapshot. */
  readonly worksheetsByName: ReadonlyMap<string, WorksheetSnapshot>;

  /** Quick lookup: worksheet id → WorksheetSnapshot. */
  readonly worksheetsById: ReadonlyMap<number, WorksheetSnapshot>;

  /** All defined names in the workbook. Keyed by uppercase name for global
   *  names, or `"SHEETNAME\0NAME"` for sheet-scoped names. Use the
   *  `resolveDefinedNameKey()` helper to find the correct entry. */
  readonly definedNames: ReadonlyMap<string, DefinedNameSnapshot>;

  /**
   * Quick lookup: table name (lowercase) → table + sheet info.
   * Built at snapshot creation time to avoid O(sheets × tables) scans
   * in the binder and evaluator.
   */
  readonly tablesByName: ReadonlyMap<string, ResolvedTable>;

  /** Calculation properties (iterative calc settings, etc.). */
  readonly calcProperties: CalcPropertiesSnapshot;

  /** Global workbook properties. */
  readonly properties: WorkbookPropertiesSnapshot;
}

// ============================================================================
// Cell Key Helpers
// ============================================================================

/**
 * Build a snapshot cell key from row and column.
 * This key format is used for the `WorksheetSnapshot.cells` map.
 */
export function snapshotCellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

/**
 * Build a formula cell key that includes the sheet name.
 * Used by the dependency graph and eval session cache.
 */
export function formulaCellKey(sheet: string, row: number, col: number): string {
  return `${sheet}!${row}:${col}`;
}

/**
 * Build a spill cell key using the worksheet id (stable across renames).
 * Used by the spill engine for persistent tracking.
 */
export function spillCellKeyFromId(worksheetId: number, row: number, col: number): string {
  return `ws:${worksheetId}!${row}:${col}`;
}

// ============================================================================
// Defined Name Resolution
// ============================================================================

/**
 * Build the key used to store a sheet-scoped defined name.
 * Format: `"SHEETNAME\0NAME"` (null character separator ensures no collisions).
 */
export function scopedNameKey(sheetName: string, name: string): string {
  return `${sheetName.toUpperCase()}\0${name.toUpperCase()}`;
}

/**
 * Resolve a defined name considering scope precedence.
 *
 * Excel name resolution order:
 * 1. Sheet-scoped name on `currentSheet` (if any)
 * 2. Workbook-scoped (global) name
 *
 * @param definedNames - The defined names map from the snapshot
 * @param name - The name to resolve (case-insensitive)
 * @param currentSheet - The sheet where the formula is located
 * @returns The matching DefinedNameSnapshot, or undefined
 */
export function resolveDefinedName(
  definedNames: ReadonlyMap<string, DefinedNameSnapshot>,
  name: string,
  currentSheet?: string
): DefinedNameSnapshot | undefined {
  // 1. Try sheet-scoped name first
  if (currentSheet) {
    const scopedKey = scopedNameKey(currentSheet, name);
    const scoped = definedNames.get(scopedKey);
    if (scoped) {
      return scoped;
    }
  }
  // 2. Fall back to global name
  return definedNames.get(name.toUpperCase());
}
