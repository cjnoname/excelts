// This file is typechecked by `pnpm type` (tsgo) but is NOT executed by Vitest.
//
// Type-level contract for `Pdf.fromExcel`'s `recalculate` option (issue #193).
//
// `recalculate` used to be declared on `PdfExportOptions` as
// `(workbook: never) => void`. A `never` parameter makes EVERY unary function
// assignable, so passing a recalculator that cannot handle an excel workbook —
// e.g. `Formula.calculate`, which needs a structural `WorkbookLike` — compiled
// cleanly and then threw `workbook.worksheets is not iterable` at runtime.
//
// The option now lives on `ExcelToPdfOptions` typed against the real workbook,
// so the mismatch is a compile error. The `@ts-expect-error` blocks below fail
// the build if that masking ever returns.

import { calculateFormulas } from "@excel/bridge/formula";
import type { Workbook } from "@excel/index";
import { Formula } from "@formula/index";
import type { ExcelToPdfOptions } from "@pdf/index";
import { Pdf } from "@pdf/index";

declare const wb: Workbook.Handle;

// Correct injection — the excel-side recalculator.
void Pdf.fromExcel(wb, { recalculate: calculateFormulas });

// Omitting it keeps the cached XLSX results (engine stays out of the bundle).
void Pdf.fromExcel(wb, { title: "no recalc" });

// The raw engine entry expects a structural `WorkbookLike`, not the workbook
// handle `fromExcel` will hand it.
void Pdf.fromExcel(wb, {
  // @ts-expect-error `Formula.calculate` does not accept an excel workbook handle
  recalculate: Formula.calculate
});

// A recalculator with an unrelated parameter type must not be assignable.
const options: ExcelToPdfOptions = {
  // @ts-expect-error `string` is not an excel workbook handle
  recalculate: (_wb: string) => {}
};
void options;
