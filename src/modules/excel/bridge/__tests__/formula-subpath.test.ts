/**
 * Public-API contract for formula recalculation (issue #193).
 *
 * `documonster/excel/formula` is the published seam between the excel workbook
 * (a plain-data `WorkbookData` record) and the snapshot-based formula engine.
 *
 * Regression guard: every recalculation test in the repo used to deep-import
 * `@excel/core/formula-adapter`, which was NOT part of any published entry
 * point. That left the documented path completely unexercised, so it could
 * ship broken — `Formula.calculate(wb)` failed to typecheck AND threw
 * `workbook.worksheets is not iterable` at runtime. These source-level tests
 * exercise the exact modules behind the public entries; package-condition and
 * emitted-artifact resolution are verified separately by
 * `scripts/treeshake-verify.ts` and `pnpm build:verify`.
 */
import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";
import { describe, expect, it } from "vitest";

describe("documonster/excel/formula — calculateFormulas (public surface)", () => {
  it("is exposed as a function", () => {
    expect(typeof calculateFormulas).toBe("function");
  });

  it("recalculates a workbook built through the public API", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "A2", 20);
    Cell.setValue(ws, "A3", 30);
    Cell.setValue(ws, "A4", { formula: "SUM(A1:A3)" });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A4")).toBe(60);
  });

  it("recalculates stale cached results after a value changes", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 2);
    Cell.setValue(ws, "B1", { formula: "A1*10" });

    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(20);

    // Mutate an input: the cached result is now stale until calc runs again.
    Cell.setValue(ws, "A1", 5);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(50);
  });

  it("recalculates a workbook loaded from an XLSX buffer", async () => {
    const source = Workbook.create();
    const sheet = Workbook.addWorksheet(source, "Data");
    Cell.setValue(sheet, "A1", 1);
    Cell.setValue(sheet, "A2", 2);
    Cell.setValue(sheet, "A3", { formula: "SUM(A1:A2)" });
    const buffer = await Workbook.toBuffer(source);

    const loaded = Workbook.create();
    await Workbook.read(loaded, buffer);
    const ws = Workbook.getWorksheet(loaded, "Data")!;

    Cell.setValue(ws, "A2", 40);
    calculateFormulas(loaded);

    expect(Cell.getResult(ws, "A3")).toBe(41);
  });

  it("evaluates dynamic-array spills through the public entry", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Spill");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)" });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);
  });

  it("persists spill state by WorkbookData identity across recalculations", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Spill");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)" });
    calculateFormulas(wb);

    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);

    Cell.setValue(ws, "A1", { formula: "SEQUENCE(1)" });
    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBeNull();
    expect(Cell.getValue(ws, "A3")).toBeNull();
  });

  it("never reclaims a former ghost cell the user turned into a formula", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Spill");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)" });
    calculateFormulas(wb);
    expect(Cell.getValue(ws, "A3")).toBe(3);

    // The user types a brand-new formula over a former ghost. It has no cached
    // result yet, so it must still be treated as user content: the spill has to
    // report #SPILL! and the formula must survive untouched.
    Cell.setValue(ws, "A3", { formula: "1+1" });
    calculateFormulas(wb);

    expect(Cell.getFormula(ws, "A3")).toBe("1+1");
    expect(Cell.getResult(ws, "A3")).toBe(2);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#SPILL!" });
  });
});
