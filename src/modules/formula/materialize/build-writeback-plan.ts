/**
 * Build Writeback Plan — Convert evaluation results into a WritebackPlan.
 *
 * This module takes the evaluation results from the evaluator and
 * produces a declarative `WritebackPlan` that describes all cell mutations.
 * The host adapter applies the completed plan after calculation succeeds.
 *
 * ## Responsibilities
 *
 * 1. Classify each formula's result as scalar, CSE, or dynamic-array.
 * 2. Check spill availability and detect #SPILL! conflicts.
 * 3. Generate cleanup operations for stale ghost cells.
 * 4. Track spill regions and ghost snapshots for persistence.
 *
 * ## Key Principle
 *
 * This module does NOT touch any live workbook objects. It reads only
 * from the `WorkbookSnapshot` and the evaluation results.
 */

import { parseRefRange } from "@formula/compile/address-utils";
import type { CompiledFormula } from "@formula/compile/compiled-formula";
import type { FormulaInstance } from "@formula/integration/formula-instance";
import type {
  WorkbookSnapshot,
  WorksheetSnapshot,
  SnapshotCellValue
} from "@formula/integration/workbook-snapshot";
import {
  snapshotCellKey,
  spillCellKeyFromId,
  formulaCellKey
} from "@formula/integration/workbook-snapshot";
import { isSpillAvailable } from "@formula/materialize/spill-availability";
import type {
  SpillRegion,
  WritebackPlan,
  WriteOperation,
  SpillWrite,
  SpillErrorWrite,
  CleanupWrite,
  CSEWrite,
  ScalarWrite
} from "@formula/materialize/writeback-plan";
import type { RuntimeValue, ScalarValue, ArrayValue } from "@formula/runtime/values";
import { RVKind } from "@formula/runtime/values";

// ============================================================================
// Spill Tracking State
// ============================================================================

/**
 * Tracks which cells are ghost cells (spill targets).
 * Key: ghost cell key → source cell key.
 */
type GhostMap = Map<string, string>;

// ============================================================================
// Build Writeback Plan
// ============================================================================

/**
 * Build a complete `WritebackPlan` from evaluation results.
 *
 * @param snapshot - The workbook snapshot
 * @param compiled - All compiled formulas in evaluation order
 * @param results - Raw evaluation results, keyed by formula cell key
 * @param previousSpills - Persistent spill regions from previous calculation
 */
export function buildWritebackPlan(
  snapshot: WorkbookSnapshot,
  compiled: readonly CompiledFormula[],
  failedInstances: readonly FormulaInstance[],
  results: ReadonlyMap<string, RuntimeValue>,
  previousSpills: ReadonlyMap<string, SpillRegion>
): WritebackPlan {
  const cleanupOperations: WriteOperation[] = [];
  const writeOperations: WriteOperation[] = [];
  const spillRegions = new Map<string, SpillRegion>();
  // Target cells already claimed by a spill produced EARLIER in this
  // calc pass. Without this set, two dynamic-array formulas whose spill
  // regions overlap would each pass the availability check against the
  // immutable snapshot and then silently clobber each other during
  // apply. See R5-P0-6.
  const activeSpillTargets = new Set<string>();

  // Build a set of current formula cell keys (using worksheet-id-based keys)
  const formulaKeys = new Set<string>();
  for (const cf of compiled) {
    const inst = cf.instance;
    formulaKeys.add(spillCellKeyFromId(inst.sheetId, inst.row, inst.col));
  }
  for (const inst of failedInstances) {
    formulaKeys.add(spillCellKeyFromId(inst.sheetId, inst.row, inst.col));
  }

  // Parse/bind failures have no CompiledFormula, but still require a scalar
  // error write (or cached-result preservation) and prior-spill cleanup.
  for (const inst of failedInstances) {
    const result = results.get(formulaCellKey(inst.sheetName, inst.row, inst.col));
    if (result === undefined) {
      continue;
    }
    const srcKey = spillCellKeyFromId(inst.sheetId, inst.row, inst.col);
    const previousRegion = previousSpills.get(srcKey);
    if (previousRegion) {
      emitPreviousSpillCleanup(
        previousRegion,
        snapshot,
        cleanupOperations,
        inst.sheetName,
        inst.sheetId
      );
    }
    const scalar = scalarFromResult(result);
    if (!shouldPreserveCompileFailure(scalar, inst, snapshot)) {
      writeOperations.push({
        type: "scalar",
        sheetName: inst.sheetName,
        row: inst.row,
        col: inst.col,
        value: runtimeToSnapshotValue(scalar)
      });
    }
  }

  // Build ghost map from previous spills (validated against snapshot)
  const ghostMap: GhostMap = new Map();
  for (const [srcKey, region] of previousSpills) {
    // Hoist the worksheet lookup once per region — the previous code did
    // `snapshot.worksheetsById.get(…)` inside the inner cell loop,
    // paying the Map lookup cost `region.rows × region.cols` times.
    const ws = snapshot.worksheetsById.get(region.worksheetId);
    if (!ws) {
      continue;
    }
    for (let r = 0; r < region.rows; r++) {
      for (let c = 0; c < region.cols; c++) {
        if (r === 0 && c === 0) {
          continue;
        }
        const targetRow = region.sourceRow + r;
        const targetCol = region.sourceCol + c;
        const targetKey = spillCellKeyFromId(region.worksheetId, targetRow, targetCol);
        // Validate ghost cell is still unmodified
        const cell = ws.cells.get(snapshotCellKey(targetRow, targetCol));
        if (isGhostUnmodified(cell, srcKey)) {
          ghostMap.set(targetKey, srcKey);
        }
      }
    }
  }

  // Clean up stale spill regions (source formula no longer exists)
  for (const [srcKey, region] of previousSpills) {
    if (!formulaKeys.has(srcKey)) {
      const ws = snapshot.worksheetsById.get(region.worksheetId);
      if (ws) {
        emitPreviousSpillCleanup(region, snapshot, cleanupOperations, ws.name, region.worksheetId);
      }
    }
  }

  // Process each compiled formula's result
  for (const cf of compiled) {
    const inst = cf.instance;
    const fKey = formulaCellKey(inst.sheetName, inst.row, inst.col);
    const result = results.get(fKey);
    if (result === undefined) {
      continue;
    }

    const isCSE = inst.kind === "cse" && inst.targetRef;
    const isDynamic = inst.isDynamicArray || cf.isDynamicArrayFunction;

    if (isCSE) {
      const srcKey = spillCellKeyFromId(inst.sheetId, inst.row, inst.col);
      const previousRegion = previousSpills.get(srcKey);
      if (previousRegion) {
        emitPreviousSpillCleanup(
          previousRegion,
          snapshot,
          cleanupOperations,
          inst.sheetName,
          inst.sheetId
        );
      }
      // CSE array formula
      const op = buildCSEWrite(inst, result);
      if (op) {
        writeOperations.push(op);
      }
    } else if (
      isDynamic &&
      result.kind === RVKind.Array &&
      (result.height > 1 || result.width > 1)
    ) {
      // Dynamic array formula with array result
      const srcKey = spillCellKeyFromId(inst.sheetId, inst.row, inst.col);

      // Check spill availability
      const spillResult = buildSpillWrite(
        inst,
        result,
        srcKey,
        ghostMap,
        previousSpills.get(srcKey),
        snapshot,
        spillRegions,
        cleanupOperations,
        writeOperations,
        activeSpillTargets
      );

      if (spillResult === "error") {
        const previousRegion = previousSpills.get(srcKey);
        if (previousRegion) {
          emitPreviousSpillCleanup(
            previousRegion,
            snapshot,
            cleanupOperations,
            inst.sheetName,
            inst.sheetId
          );
        }
        writeOperations.push({
          type: "spill-error",
          sheetName: inst.sheetName,
          sheetId: inst.sheetId,
          row: inst.row,
          col: inst.col
        } satisfies SpillErrorWrite);
      }
    } else {
      // Scalar result (or 1x1 array)
      const scalar = scalarFromResult(result);

      // If this formula previously had a spill region, clean it up
      const srcKey = spillCellKeyFromId(inst.sheetId, inst.row, inst.col);
      const prevRegion = previousSpills.get(srcKey);
      if (prevRegion) {
        emitPreviousSpillCleanup(
          prevRegion,
          snapshot,
          cleanupOperations,
          inst.sheetName,
          inst.sheetId
        );
      }

      if (!shouldPreserveUnsupportedFunction(scalar, inst, snapshot)) {
        writeOperations.push({
          type: "scalar",
          sheetName: inst.sheetName,
          row: inst.row,
          col: inst.col,
          value: runtimeToSnapshotValue(scalar)
        } satisfies ScalarWrite);
      }
    }
  }

  return {
    operations: [...cleanupOperations, ...writeOperations],
    spillState: { spillRegions }
  };
}

// ============================================================================
// CSE Write
// ============================================================================

function buildCSEWrite(inst: FormulaInstance, result: RuntimeValue): CSEWrite | null {
  const ref = inst.targetRef;
  if (!ref) {
    return null;
  }

  const range = parseRefRange(ref);
  if (!range) {
    return null;
  }

  if (result.kind === RVKind.Array) {
    const results: SnapshotCellValue[][] = [];
    const numRows = range.bottom - range.top + 1;
    const numCols = range.right - range.left + 1;
    for (let r = 0; r < numRows; r++) {
      const row: SnapshotCellValue[] = [];
      for (let c = 0; c < numCols; c++) {
        // When the array result is smaller than the CSE target range,
        // positions outside the array get #N/A (Excel behaviour) — not
        // BLANK, which is what the previous `?? { kind: Blank }` gave
        // us. R6-P1-3.
        const inBounds = r < result.height && c < result.width;
        const val = inBounds
          ? result.rows[r][c]
          : { kind: RVKind.Error as const, code: "#N/A" as const };
        row.push(runtimeToSnapshotValue(val));
      }
      results.push(row);
    }
    return {
      type: "cse",
      sheetName: inst.sheetName,
      top: range.top,
      left: range.left,
      bottom: range.bottom,
      right: range.right,
      results
    };
  }

  // Scalar fill
  const scalarVal = runtimeToSnapshotValue(scalarFromResult(result));
  return {
    type: "cse",
    sheetName: inst.sheetName,
    top: range.top,
    left: range.left,
    bottom: range.bottom,
    right: range.right,
    results: [],
    scalarFill: scalarVal
  };
}

// ============================================================================
// Spill Write
// ============================================================================

function buildSpillWrite(
  inst: FormulaInstance,
  arr: ArrayValue,
  srcKey: string,
  ghostMap: GhostMap,
  previousRegion: SpillRegion | undefined,
  snapshot: WorkbookSnapshot,
  spillRegions: Map<string, SpillRegion>,
  cleanupOperations: WriteOperation[],
  writeOperations: WriteOperation[],
  /**
   * Target cell keys claimed by spill regions produced EARLIER in this
   * same calc pass. The snapshot is immutable during a pass, so without
   * an explicit set the availability check wouldn't see the A1→A1:A5
   * spill that the previous iteration just committed, and a subsequent
   * formula spilling over A3:A7 would silently overwrite half of it.
   */
  activeSpillTargets: Set<string>
): "ok" | "error" {
  const ws = snapshot.worksheetsByName.get(inst.sheetName.toLowerCase());
  if (!ws) {
    return "error";
  }

  // 1x1 result: just write scalar, no spilling
  if (arr.height <= 1 && arr.width <= 1) {
    const val =
      arr.height > 0 && arr.width > 0 ? arr.rows[0][0] : ({ kind: RVKind.Blank } as ScalarValue);
    writeOperations.push({
      type: "scalar",
      sheetName: inst.sheetName,
      row: inst.row,
      col: inst.col,
      value: runtimeToSnapshotValue(val)
    } satisfies ScalarWrite);
    // Clean up previous spill if any
    if (previousRegion) {
      emitPreviousSpillCleanup(
        previousRegion,
        snapshot,
        cleanupOperations,
        inst.sheetName,
        inst.sheetId
      );
    }
    return "ok";
  }

  if (
    !isSpillAvailable({
      snapshot,
      sheetName: inst.sheetName,
      sourceRow: inst.row,
      sourceCol: inst.col,
      rows: arr.height,
      cols: arr.width,
      isReusableGhost: (row, col) => {
        const key = spillCellKeyFromId(inst.sheetId, row, col);
        const owner = ghostMap.get(key);
        return (
          owner !== undefined && isGhostUnmodified(ws.cells.get(snapshotCellKey(row, col)), owner)
        );
      },
      isClaimed: (row, col) => activeSpillTargets.has(spillCellKeyFromId(inst.sheetId, row, col))
    })
  ) {
    return "error";
  }

  // Now that availability is confirmed, claim the target cells so the
  // next spill in this pass sees them as occupied.
  for (let r = 0; r < arr.height; r++) {
    for (let c = 0; c < arr.width; c++) {
      if (r === 0 && c === 0) {
        continue;
      }
      const targetRow = inst.row + r;
      const targetCol = inst.col + c;
      activeSpillTargets.add(spillCellKeyFromId(inst.sheetId, targetRow, targetCol));
    }
  }

  // Clean up previous spill region if size changed
  if (previousRegion) {
    emitPreviousSpillCleanup(
      previousRegion,
      snapshot,
      cleanupOperations,
      inst.sheetName,
      inst.sheetId
    );
  }

  // Build spill write operation
  const results: SnapshotCellValue[][] = [];
  for (let r = 0; r < arr.height; r++) {
    const row: SnapshotCellValue[] = [];
    for (let c = 0; c < arr.width; c++) {
      const val = arr.rows[r]?.[c] ?? ({ kind: RVKind.Blank } as ScalarValue);
      const sv = runtimeToSnapshotValue(val);
      row.push(sv);
    }
    results.push(row);
  }

  writeOperations.push({
    type: "spill",
    sheetName: inst.sheetName,
    sheetId: inst.sheetId,
    row: inst.row,
    col: inst.col,
    results
  } satisfies SpillWrite);

  // Record spill region
  spillRegions.set(srcKey, {
    worksheetId: inst.sheetId,
    sourceRow: inst.row,
    sourceCol: inst.col,
    rows: arr.height,
    cols: arr.width
  });

  return "ok";
}

// ============================================================================
// Helpers
// ============================================================================

function collectStaleGhosts(
  region: SpillRegion,
  snapshot: WorkbookSnapshot
): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  const ws = snapshot.worksheetsById.get(region.worksheetId);
  if (!ws) {
    return cells;
  }
  for (let r = 0; r < region.rows; r++) {
    for (let c = 0; c < region.cols; c++) {
      if (r === 0 && c === 0) {
        continue;
      }
      const targetRow = region.sourceRow + r;
      const targetCol = region.sourceCol + c;
      // If the user (or a previous edit) has placed this former ghost
      // inside a merged region, skip it. The cell is now either a merge
      // master (carrying the user's intentional value) or a merge slave
      // (whose `cell.value = null` writeback would forward through
      // `MergeValue`'s setter and clobber the master). Either way,
      // cleanup must not touch it. The snapshot builder filters merge
      // slaves out of `ws.cells`, so the
      // `isGhostUnmodified` check below would otherwise miss this case
      // — `cell` would be `undefined`, which currently means
      // "unmodified, safe to wipe".
      if (isInMergedRegion(ws, targetRow, targetCol)) {
        continue;
      }
      const cell = ws.cells.get(snapshotCellKey(targetRow, targetCol));
      const sourceKey = spillCellKeyFromId(region.worksheetId, region.sourceRow, region.sourceCol);
      if (isGhostUnmodified(cell, sourceKey)) {
        cells.push({ row: targetRow, col: targetCol });
      }
    }
  }
  return cells;
}

/**
 * Emit a cleanup operation for a previous spill region whose ghosts are
 * still unmodified.
 *
 * Collects the stale ghost cells and, if any remain, pushes a single
 * `CleanupWrite` onto `operations`. The next spill state is rebuilt from
 * successful spills in the current pass, so stale metadata is omitted
 * automatically.
 */
function emitPreviousSpillCleanup(
  previousRegion: SpillRegion,
  snapshot: WorkbookSnapshot,
  operations: WriteOperation[],
  sheetName: string,
  sheetId: number
): void {
  const cleanupCells = collectStaleGhosts(previousRegion, snapshot);
  if (cleanupCells.length === 0) {
    return;
  }
  operations.push({
    type: "cleanup",
    sheetName,
    sheetId,
    cells: cleanupCells
  } satisfies CleanupWrite);
}

/**
 * Test whether `(row, col)` falls inside any merged region of `ws`.
 *
 * Linear scan — merge counts per sheet are small in practice. The
 * snapshot builder filters merge slaves out of `ws.cells`, so callers
 * use this helper to recover the "is this cell part of a merge?"
 * signal that the cell map alone no longer carries.
 */
function isInMergedRegion(ws: WorksheetSnapshot, row: number, col: number): boolean {
  for (const region of ws.mergedRegions) {
    if (row >= region.top && row <= region.bottom && col >= region.left && col <= region.right) {
      return true;
    }
  }
  return false;
}

export function isGhostUnmodified(
  cell: { formulaKind: string; ghostOwner?: string } | undefined,
  sourceKey: string
): boolean {
  return cell?.formulaKind === "none" && cell.ghostOwner === sourceKey;
}

function scalarFromResult(v: RuntimeValue): ScalarValue {
  if (v.kind === RVKind.Array) {
    if (v.height > 0 && v.width > 0) {
      return v.rows[0][0];
    }
    return { kind: RVKind.Blank };
  }
  if (
    v.kind === RVKind.Blank ||
    v.kind === RVKind.Number ||
    v.kind === RVKind.String ||
    v.kind === RVKind.Boolean ||
    v.kind === RVKind.Error
  ) {
    return v;
  }
  return { kind: RVKind.Blank };
}

function runtimeToSnapshotValue(v: ScalarValue | RuntimeValue): SnapshotCellValue {
  switch (v.kind) {
    case RVKind.Blank:
      return null;
    case RVKind.Number:
      // Boundary guard: never let NaN or ±Infinity leak into the
      // persisted workbook. Either comes from arithmetic the per-
      // function guards missed (for example extreme ROUND digit
      // counts before the R6-P1-2 clamp). Convert to #NUM! here so
      // downstream readers see a clean error instead of a stringified
      // "NaN" / "Infinity" value. See R6 architectural note.
      if (!Number.isFinite(v.value)) {
        return { error: "#NUM!" };
      }
      return v.value;
    case RVKind.String:
      return v.value;
    case RVKind.Boolean:
      return v.value;
    case RVKind.Error:
      return { error: v.code };
    case RVKind.Array:
      // Take top-left
      if (v.height > 0 && v.width > 0) {
        return runtimeToSnapshotValue(v.rows[0][0]);
      }
      return null;
    default:
      return null;
  }
}

export function shouldPreserveCompileFailure(
  computed: ScalarValue,
  inst: FormulaInstance,
  snapshot: WorkbookSnapshot
): boolean {
  if (computed.kind !== RVKind.Error) {
    return false;
  }
  if (computed.code !== "#NAME?" && computed.code !== "#CALC!") {
    return false;
  }
  // Check if cell has a cached result in the snapshot
  const ws = snapshot.worksheetsByName.get(inst.sheetName.toLowerCase());
  if (!ws) {
    return false;
  }
  const cell = ws.cells.get(snapshotCellKey(inst.row, inst.col));
  return cell?.value !== undefined && cell.value !== null;
}

function shouldPreserveUnsupportedFunction(
  computed: ScalarValue,
  inst: FormulaInstance,
  snapshot: WorkbookSnapshot
): boolean {
  return computed.kind === RVKind.Error && computed.code === "#NAME?"
    ? shouldPreserveCompileFailure(computed, inst, snapshot)
    : false;
}
