/**
 * Public entry for the documonster formula engine.
 *
 * This entry exposes syntax inspection only. Workbook recalculation lives at
 * `documonster/excel/formula`, where the Excel host adapter and the calculation
 * engine are linked without adding either to `documonster/excel` itself.
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

// Syntax types, so callers can name what `tokenize` / `parse` return and switch
// exhaustively over token / node kinds.
export { TokenType } from "@formula/syntax/token-types";
export type { Token } from "@formula/syntax/token-types";
export { NodeType } from "@formula/syntax/ast";
export type { AstNode } from "@formula/syntax/ast";
