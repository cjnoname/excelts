/**
 * Writeback Plan — Declarative description of formula calculation results.
 *
 * The engine never directly mutates workbook cells. Instead, it produces a
 * `WritebackPlan` — a list of write operations that describe what values
 * should be written where. A thin adapter layer then applies the plan to
 * the live workbook.
 *
 * ## Design Principles
 *
 * 1. **Declarative** — the plan describes *what* to write, not *how*.
 * 2. **Deterministic** — #SPILL! conflicts are detected during plan
 *    construction, not during application.
 * 3. **Ordered** — operations are applied in the order they appear.
 * 4. **Independent** — each operation stands alone; the adapter does not
 *    need engine internals to apply the plan.
 *
 * ## Operation Types
 *
 * - `ScalarWrite` — write a single value to a formula cell's result.
 * - `CSEWrite` — distribute an array across a CSE formula's target range.
 * - `SpillWrite` — write a dynamic array result to adjacent cells (spill).
 * - `SpillErrorWrite` — write #SPILL! to the source cell (conflict detected).
 * - `CleanupWrite` — clear stale ghost cells from a previous spill.
 * - `PreserveWrite` — keep the cell's existing cached result (unsupported fn).
 */

import type { SnapshotCellValue } from "@formula/integration/workbook-snapshot";

export interface SpillRegion {
  readonly worksheetId: number;
  readonly sourceRow: number;
  readonly sourceCol: number;
  readonly rows: number;
  readonly cols: number;
}

// ============================================================================
// Individual Write Operations
// ============================================================================

/**
 * Write a scalar value to a formula cell's result.
 */
export interface ScalarWrite {
  readonly type: "scalar";
  readonly sheetName: string;
  readonly row: number;
  readonly col: number;
  /** The computed result value. */
  readonly value: SnapshotCellValue;
}

/**
 * Distribute an array result across a CSE (Ctrl+Shift+Enter) formula's
 * target range. Each cell in the range gets the corresponding element.
 * If the result is smaller than the target range, excess cells receive
 * the scalar value (or `null` for missing elements).
 */
export interface CSEWrite {
  readonly type: "cse";
  readonly sheetName: string;
  /** Top-left corner of the target range. */
  readonly top: number;
  readonly left: number;
  /** Bottom-right corner of the target range. */
  readonly bottom: number;
  readonly right: number;
  /**
   * The result array. `results[r][c]` is the value for row `top + r`,
   * col `left + c`. May be smaller than the target range.
   */
  readonly results: readonly (readonly SnapshotCellValue[])[];
  /**
   * For scalar CSE results: the single value to fill the entire range.
   * When set, `results` is ignored.
   */
  readonly scalarFill?: SnapshotCellValue;
}

/**
 * Write a dynamic array result to the source cell and adjacent ghost cells.
 * The spill region starts at (row, col) and extends downward/rightward.
 */
export interface SpillWrite {
  readonly type: "spill";
  readonly sheetName: string;
  readonly sheetId: number;
  /** Source formula cell position. */
  readonly row: number;
  readonly col: number;
  /**
   * The result array. `results[r][c]` is the value for row `row + r`,
   * col `col + c`. The source cell gets `results[0][0]`.
   */
  readonly results: readonly (readonly SnapshotCellValue[])[];
}

/**
 * Write #SPILL! to the source cell because the target range is occupied.
 */
export interface SpillErrorWrite {
  readonly type: "spill-error";
  readonly sheetName: string;
  readonly sheetId: number;
  readonly row: number;
  readonly col: number;
}

/**
 * Clear ghost cells from a previous spill that is no longer valid.
 * Each entry in `cells` is a (row, col) pair to clear.
 */
export interface CleanupWrite {
  readonly type: "cleanup";
  readonly sheetName: string;
  readonly sheetId: number;
  /**
   * Cells to clear. Each is `{ row, col }`.
   * Only cells that haven't been modified by the user should be cleared —
   * the plan builder checks this against the snapshot.
   */
  readonly cells: readonly { readonly row: number; readonly col: number }[];
}

/**
 * Keep the cell's existing cached result.
 * Used when the engine returns #NAME? (unsupported function) but the cell
 * has a usable cached result from the XLSX file.
 */
export interface PreserveWrite {
  readonly type: "preserve";
  readonly sheetName: string;
  readonly row: number;
  readonly col: number;
}

// ============================================================================
// WritebackPlan
// ============================================================================

/**
 * A single write operation in the plan.
 */
export type WriteOperation =
  | ScalarWrite
  | CSEWrite
  | SpillWrite
  | SpillErrorWrite
  | CleanupWrite
  | PreserveWrite;

/**
 * The complete writeback plan produced by the engine.
 *
 * Operations are ordered: cleanups first, then writes, to ensure stale
 * data is removed before new data is written.
 */
export interface WritebackPlan {
  /**
   * All write operations in application order.
   * The adapter should apply them sequentially.
   */
  readonly operations: readonly WriteOperation[];

  /**
   * Spill persistent state changes — spill regions and ghost cell snapshots
   * that the adapter must update in the persistent tracking maps.
   */
  readonly spillState: SpillState;
}

// ============================================================================
// Spill State Delta
// ============================================================================

/**
 * Describes changes to the persistent spill tracking state.
 * The adapter updates the persistent maps accordingly.
 */
export interface SpillState {
  /**
   * New or updated spill region metadata.
   * Key: `"ws:<id>!row:col"` of the source formula cell.
   * Value: the spill region dimensions.
   */
  readonly spillRegions: ReadonlyMap<string, SpillRegion>;

  /**
   * Ghost cell value snapshots for modification detection.
   * Key: ghost cell key `"ws:<id>!row:col"`.
   * Value: the raw value written to that ghost cell.
   */
  readonly ghostSnapshots: ReadonlyMap<string, SnapshotCellValue>;
}
