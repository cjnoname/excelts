/**
 * Public entry for the documonster formula engine.
 *
 * **Functional, zero-side-effect** is the only evaluation style:
 * ```ts
 * import { Formula } from "documonster/formula";
 * Formula.calculate(workbook);
 * ```
 * Perfect tree-shaking: unused exports are dropped, no module initialisation
 * runs, and there is **no install / registration step** — every export is used
 * directly. Bundles that import only `Formula.tokenize` / `Formula.parse` never
 * pull the evaluator or function registry in; the evaluator is reached solely
 * through `Formula.calculate`, so consumers who never call it never pay for it.
 *
 * To recalculate a workbook from `documonster/excel`, use the adapter exported
 * by `documonster/excel/formula`:
 * ```ts
 * import { calculateFormulas } from "documonster/excel/formula";
 * calculateFormulas(workbook);
 * ```
 */

// Public value API — the `Formula` domain namespace. Tree-shaken per-member
// on rolldown / rspack; a consumer that references only `Formula.tokenize`
// never pulls in the evaluator.
export * as Formula from "@formula/surface/formula";

// Errors — extend BaseError, consistent with every other module's errors.ts.
export { FormulaError, FormulaParseError, isFormulaError } from "@formula/errors";

// Structural types callers may need to describe their host workbook.
export type {
  CellErrorValueLike,
  CellLike,
  DefinedNameEntry,
  DefinedNamesLike,
  DimensionsLike,
  FormulaResultLike,
  RowLike,
  SpillRegion,
  WorkbookLike,
  WorksheetLike
} from "@formula/materialize/types";
