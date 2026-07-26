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
 * The engine (`documonster/formula`) evaluates the structural `WorkbookLike`
 * contract, while an excel workbook handle is a plain-data `WorkbookData`
 * record with no methods — the two are not interchangeable, so a bridge is
 * required (`@excel/core/formula-adapter`).
 *
 * That bridge is published here rather than as a `Workbook.calculate` member
 * because every export of a module entry is reachable in bundling formats that
 * cannot drop unused members — notably the script-tag IIFE, where hanging the
 * engine off the `Workbook` namespace added approximately 200 KB to the
 * minified Excel IIFE for every CDN consumer, including those who never
 * recalculate. A separate
 * entry keeps `documonster/excel` byte-for-byte unchanged and makes the engine
 * cost impossible to pay by accident, while staying a plain function call with
 * no install or registration step.
 *
 * For hosts that are not excel workbooks, call `Formula.calculate` from
 * `documonster/formula` directly with your own `WorkbookLike` implementation.
 */

export { calculateFormulas } from "@excel/core/formula-adapter";
