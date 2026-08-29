/**
 * Browser-condition artifact test for `documonster/excel/formula`.
 *
 * `pnpm test:browser` builds `dist/esm` before Playwright starts. Importing those
 * emitted files here verifies the published artifacts themselves — not the source
 * aliases used by the regular in-memory suite — execute together and recalculate a
 * real workbook without registration.
 *
 * It also exercises the resolution layer that replaced the duplicated `dist/browser`
 * tree: these files reach their platform-specific modules through `#platform/*`
 * specifiers, so loading them in a browser only works if the `browser` condition
 * actually selects the browser variant. A regression there would otherwise be
 * invisible — the Node variant would load and mostly work.
 */
import type * as FormulaArtifact from "@excel/bridge/formula";
import type * as ExcelArtifact from "@excel/index.browser";
import { describe, expect, it } from "vitest";

describe("excel/formula browser artifact", () => {
  it("recalculates through the emitted browser entry", async () => {
    const excelUrl = "/dist/esm/modules/excel/index.browser.js";
    const formulaUrl = "/dist/esm/modules/excel/bridge/formula.js";
    const excel = (await import(/* @vite-ignore */ excelUrl)) as typeof ExcelArtifact;
    const formula = (await import(/* @vite-ignore */ formulaUrl)) as typeof FormulaArtifact;

    const wb = excel.Workbook.create();
    const ws = excel.Workbook.addWorksheet(wb, "Browser");
    excel.Cell.setValue(ws, "A1", 19);
    excel.Cell.setValue(ws, "A2", 23);
    excel.Cell.setValue(ws, "A3", { formula: "SUM(A1:A2)" });

    formula.calculateFormulas(wb);

    expect(excel.Cell.getResult(ws, "A3")).toBe(42);
  });
});
