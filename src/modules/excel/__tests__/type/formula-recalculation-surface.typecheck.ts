// This file is typechecked by `pnpm type` (tsgo) but is NOT executed by Vitest.
//
// Type-level contract for formula recalculation (issue #193).
//
// `calculateFormulas` from `documonster/excel/formula` is the public seam: the
// excel workbook handle is a plain-data record (`WorkbookData`), while the
// engine entry `Formula.calculate` consumes the structural `WorkbookLike`
// contract (`worksheets` array + `getWorksheet()` method + live worksheet/cell
// views). The two are deliberately NOT structurally compatible — the adapter in
// `@excel/core/formula-adapter` bridges them, and the `excel/formula` subpath
// is how consumers reach it.
//
// The `@ts-expect-error` below is the load-bearing assertion: it fails the
// build if `WorkbookData` ever silently becomes assignable to `WorkbookLike`,
// which is what the old docs incorrectly promised.

import { calculateFormulas } from "@excel/bridge/formula";
import type { Workbook } from "@excel/index";
import { Formula } from "@formula/index";

declare const wb: Workbook.Handle;

// Public path — must typecheck.
calculateFormulas(wb);

// The engine entry takes a `WorkbookLike`, never the excel workbook handle.
// @ts-expect-error `WorkbookData` is missing `worksheets` / `getWorksheet`
Formula.calculate(wb);

// `Formula.calculate` still accepts a genuine structural host.
declare const host: Parameters<typeof Formula.calculate>[0];
Formula.calculate(host);
