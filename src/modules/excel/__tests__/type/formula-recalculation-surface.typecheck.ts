// This file is typechecked by `pnpm type` (tsgo) but is NOT executed by Vitest.
//
// Type-level contract for formula recalculation (issue #193).
//
// `calculateFormulas` from `documonster/excel/formula` is the only public
// evaluation seam. The formula module no longer exposes a workbook-shaped host
// contract or a second calculation entry.

import { calculateFormulas } from "@excel/bridge/formula";
import type { FormulaFunction, FormulaValue } from "@excel/bridge/formula";
import { Workbook } from "@excel/index";
import type { Formula } from "@formula/index";

declare const wb: Workbook.Handle;

// Public path — must typecheck.
calculateFormulas(wb);

type HasCalculate = "calculate" extends keyof typeof Formula ? true : false;
const formulaHasNoCalculate: HasCalculate = false;
void formulaHasNoCalculate;

const customFunction: FormulaFunction = {
  minArity: 1,
  maxArity: 1,
  invoke(args: FormulaValue[]): FormulaValue {
    return args[0];
  }
};
Workbook.registerFunction(wb, "IDENTITY", customFunction.invoke, {
  minArity: customFunction.minArity,
  maxArity: customFunction.maxArity
});
