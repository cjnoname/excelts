/**
 * Browser-condition artifact test for `documonster/excel/formula`.
 *
 * `pnpm test:browser` builds `dist/browser` before Playwright starts. Importing
 * those emitted files here verifies the browser artifacts themselves — not the
 * source aliases used by the regular in-memory suite — execute together and
 * recalculate a real workbook without registration.
 */
import type * as FormulaArtifact from "@excel/bridge/formula";
import type * as ExcelArtifact from "@excel/index.browser";
import { describe, expect, it } from "vitest";

describe("excel/formula browser artifact", () => {
  it("recalculates through the emitted browser entry", async () => {
    const excelUrl = "/dist/browser/modules/excel/index.browser.js";
    const formulaUrl = "/dist/browser/modules/excel/bridge/formula.js";
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
