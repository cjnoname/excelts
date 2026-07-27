/**
 * Excel → formula snapshot/writeback adapter.
 *
 * The formula engine consumes an immutable workbook snapshot and emits a
 * declarative writeback plan. documonster's workbook/worksheet/cell values are
 * plain-data records, so this module captures their state through the flat
 * helpers and resolves live cells only during final writeback.
 *
 * Excel (layer 4) may import formula (layer 3); this is the sanctioned seam.
 */
import { captureFormulaSnapshot } from "@excel/core/formula-capture";
import { applyFormulaWriteback } from "@excel/core/formula-writeback";
import type { WorkbookData } from "@excel/core/workbook.browser";
import { calculateFormulas as calculateFormulasEngine } from "@formula/integration/calculate-formulas";
import { createFormulaCalculationState } from "@formula/integration/calculation-state";
import type { FormulaCalculationState } from "@formula/integration/calculation-state";

const calculationStates = new WeakMap<WorkbookData, FormulaCalculationState>();

function stateFor(wb: WorkbookData): FormulaCalculationState {
  let state = calculationStates.get(wb);
  if (!state) {
    state = createFormulaCalculationState();
    calculationStates.set(wb, state);
  }
  return state;
}

/**
 * Recalculate all formulas in a workbook, mutating cached results in place.
 * Excel-side wrapper around the formula engine's snapshot/writeback boundary.
 */
export function calculateFormulas(wb: WorkbookData): void {
  const state = stateFor(wb);
  const snapshot = captureFormulaSnapshot(wb);
  // Capture this before evaluation. A custom function may unregister itself
  // after mutating the workbook; consulting the live registry afterwards
  // would incorrectly skip drift validation.
  const mayHaveMutated = (wb.userFunctions?.size ?? 0) > 0;
  const result = calculateFormulasEngine(snapshot, state, wb.userFunctions);
  const { plan } = result;
  // The engine is pure, so the only way the workbook can change while a
  // calculation runs is a user-registered function writing to it. Re-capture
  // (and compare) only in that case; otherwise the plan is provably still
  // consistent with `snapshot` and a second full capture would be dead work.
  applyFormulaWriteback(wb, plan, snapshot, mayHaveMutated ? captureFormulaSnapshot(wb) : snapshot);
  calculationStates.set(wb, result.state);
}
