/**
 * Formula Calculation Engine
 *
 * Pure internal calculation boundary. It consumes immutable snapshot/state and
 * returns a writeback plan plus isolated next state; it never imports, models,
 * or mutates a live workbook.
 *
 * ## Architecture
 *
 * 1. **Snapshot** — immutable capture of all workbook state
 * 2. **Normalize** — uniform FormulaInstance objects
 * 3. **Parse** — tokenize → AST
 * 4. **Compile** — bind AST → BoundExpr (resolve names, structured refs, sheets)
 * 5. **Dependency Analysis** — topological sort
 * 6. **Evaluate** — execute BoundExpr with RuntimeValue system
 * 7. **Materialize** — build declarative WritebackPlan
 * 8. **Return** — emit plan + next state for the host to commit atomically
 */

import { calculateFormulasImpl } from "@formula/integration/calculate-formulas-impl";
import { nextFormulaCalculationState } from "@formula/integration/calculation-state";
import type { FormulaCalculationState } from "@formula/integration/calculation-state";
import type { WorkbookSnapshot } from "@formula/integration/workbook-snapshot";
import type { WritebackPlan } from "@formula/materialize/writeback-plan";
import type { RuntimeValue } from "@formula/runtime/values";

export interface FormulaFunction {
  readonly minArity: number;
  readonly maxArity: number;
  readonly volatile?: boolean;
  readonly invoke: (args: RuntimeValue[]) => RuntimeValue;
}

export interface FormulaCalculationResult {
  readonly plan: WritebackPlan;
  readonly state: FormulaCalculationState;
}

/**
 * Calculate all formula cells in a captured workbook snapshot.
 *
 * Evaluates every formula cell using the built-in calculation engine
 * and describes result updates in a plan. Formulas are evaluated lazily
 * with recursive dependency resolution, memoization, and circular
 * reference detection.
 *
 * All evaluation state is scoped to this invocation — concurrent calls
 * for different workbooks are safe.
 *
 * **Supported formula features:**
 * - Cell references: `A1`, `$B$2`, `Sheet1!A1`, `'Sheet Name'!A1:B10`
 * - Operators: `+ - * / ^`, `& (concat)`, `= <> < > <= >=`, `%`
 * - 448 built-in functions across math, text, logical, date, lookup,
 *   statistical, financial, dynamic-array, database and engineering
 *   categories.
 * - Shared formulas, array constants, nested expressions
 * - Dynamic array spill: FILTER, SORT, UNIQUE, SORTBY results are
 *   written to adjacent cells. #SPILL! error if target cells are occupied.
 * - CSE array formulas: `{=formula}` with a ref range distribute results
 *   across the designated range.
 * - Array arithmetic broadcasting: `{1,2,3} + {4;5;6}` produces a 3x3 matrix.
 * - Implicit intersection: range references in scalar context pick the
 *   value from the formula cell's row or column.
 *
 * **Unsupported formula behavior:**
 * - If a formula uses a function the engine does not implement, the engine
 *   returns `#NAME?`. However, if the cell already has a cached result
 *   (e.g., pre-computed by Excel when the XLSX was saved), that cached
 *   result is **preserved** — the engine will not overwrite usable data.
 * - If no cached result exists, the cell's result becomes `#NAME?`.
 *
 * **Volatile functions:**
 * - `RAND`, `RANDBETWEEN`, `NOW`, `TODAY` are re-evaluated on every call.
 *   This is intentional — these functions are expected to produce fresh values.
 *
 * **Side effects:** the snapshot and the committed spill state are never
 * mutated. The returned `state` carries the next spill state, which the host
 * commits only after a successful writeback. The shared AST memo may gain
 * entries, which is safe regardless of the outcome.
 *
 * @param snapshot - Immutable workbook data captured by the host adapter
 * @param state - Explicit persistent state for this workbook
 * @param userFunctions - Optional per-workbook custom functions
 */
export function calculateFormulas(
  snapshot: WorkbookSnapshot,
  state: FormulaCalculationState,
  userFunctions?: ReadonlyMap<string, FormulaFunction>
): FormulaCalculationResult {
  const plan = calculateFormulasImpl(snapshot, state, userFunctions);
  return { plan, state: nextFormulaCalculationState(state, plan.spillState) };
}
