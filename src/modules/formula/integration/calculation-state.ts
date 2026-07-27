import type { SpillRegion, SpillState } from "@formula/materialize/writeback-plan";
import type { AstNode } from "@formula/syntax/ast";

export const PARSE_FAILED = Symbol("parse-failed");
export type CachedAst = AstNode | typeof PARSE_FAILED;

/**
 * Persistent state owned by a single workbook calculation host.
 *
 * `astCache` is a pure `formula text → AST` memo, so it is shared across calls
 * and may be updated in place: a parsed AST is valid regardless of whether the
 * surrounding calculation later fails.
 *
 * The spill maps are calculation *results*, so they are never mutated in place.
 * Each calculation returns a new state whose maps come straight from the plan,
 * letting the host commit them atomically only after a successful writeback.
 */
export interface FormulaCalculationState {
  readonly astCache: Map<string, CachedAst>;
  readonly spillRegions: ReadonlyMap<string, SpillRegion>;
  readonly ghostSnapshots: ReadonlyMap<string, SnapshotCellValue>;
}

export function createFormulaCalculationState(): FormulaCalculationState {
  return {
    astCache: new Map(),
    spillRegions: new Map(),
    ghostSnapshots: new Map()
  };
}

/**
 * Derive the next committed state from a plan's spill state.
 *
 * The plan always carries the complete next spill state (not a delta), so the
 * maps are adopted wholesale — stale regions and ghost snapshots disappear
 * without any explicit removal bookkeeping.
 */
export function nextFormulaCalculationState(
  state: FormulaCalculationState,
  spillState: SpillState
): FormulaCalculationState {
  return {
    astCache: state.astCache,
    spillRegions: spillState.spillRegions,
    ghostSnapshots: spillState.ghostSnapshots
  };
}
import type { SnapshotCellValue } from "@formula/integration/workbook-snapshot";
