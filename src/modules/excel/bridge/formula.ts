/**
 * `documonster/excel/formula` — recalculate an Excel workbook's formulas.
 *
 * ```ts
 * import { Workbook } from "documonster/excel";
 * import { calculateFormulas } from "documonster/excel/formula";
 *
 * const wb = Workbook.create();
 * // … populate cells …
 * calculateFormulas(wb); // results written back in place
 * ```
 *
 * ## Why its own subpath
 *
 * The calculation core is a pure snapshot-to-plan transform. This bridge owns
 * all host effects: it captures an Excel `WorkbookData` record, runs the core,
 * applies the plan, and commits persistent calculation state only after the
 * writeback succeeds.
 *
 * It is published here rather than as a `Workbook.calculate` member because
 * every export of a module entry is reachable in bundling formats that cannot
 * drop unused members — notably the script-tag IIFE, where hanging the engine
 * off the `Workbook` namespace added roughly 200 KB to the minified Excel IIFE
 * for every CDN consumer, including those who never recalculate. A separate
 * entry keeps `documonster/excel` byte-for-byte unchanged and makes the engine
 * cost impossible to pay by accident, while staying a plain function call with
 * no install or registration step.
 */

export { calculateFormulas } from "@excel/core/formula-adapter";
export type { FormulaFunction } from "@formula/integration/calculate-formulas";
export type { RuntimeValue as FormulaValue } from "@formula/runtime/values";
import type { RVKind } from "@formula/runtime/values";

/**
 * Value tags used by `FormulaValue`.
 *
 * Custom functions receive and return tagged values; this object gives those
 * tags names so callers never have to hard-code the numeric literals.
 *
 * ```ts
 * import { FormulaValueKind } from "documonster/excel/formula";
 *
 * const answer = { kind: FormulaValueKind.Number, value: 42 } as const;
 * ```
 */
export const FormulaValueKind = {
  Blank: 0,
  Number: 1,
  String: 2,
  Boolean: 3,
  Error: 4,
  Array: 5,
  Reference: 6,
  Lambda: 7
} as const;

// Compile-time proof that the published tags match the engine's internal enum.
// `RVKind` stays a `const enum` (inlined on hot paths) and is therefore not
// itself part of the public surface.
type AssertSameTag<A extends B, B> = A;
type _BlankTag = AssertSameTag<typeof FormulaValueKind.Blank, RVKind.Blank>;
type _NumberTag = AssertSameTag<typeof FormulaValueKind.Number, RVKind.Number>;
type _StringTag = AssertSameTag<typeof FormulaValueKind.String, RVKind.String>;
type _BooleanTag = AssertSameTag<typeof FormulaValueKind.Boolean, RVKind.Boolean>;
type _ErrorTag = AssertSameTag<typeof FormulaValueKind.Error, RVKind.Error>;
type _ArrayTag = AssertSameTag<typeof FormulaValueKind.Array, RVKind.Array>;
type _ReferenceTag = AssertSameTag<typeof FormulaValueKind.Reference, RVKind.Reference>;
type _LambdaTag = AssertSameTag<typeof FormulaValueKind.Lambda, RVKind.Lambda>;
