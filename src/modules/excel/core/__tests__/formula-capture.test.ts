/**
 * Unit tests for `captureFormulaSnapshot`. The snapshot is the immutable
 * input to the entire compile → evaluate → materialize pipeline, so
 * every formula-engine behaviour ultimately depends on it capturing the
 * right shape of the live workbook.
 */

import { definedNamesAdd } from "@excel/core/defined-names";
import { captureFormulaSnapshot } from "@excel/core/formula-capture";
import { getDefinedNames } from "@excel/core/workbook";
import { Cell, Row, Workbook } from "@excel/index";
import { snapshotCellKey } from "@formula/integration/workbook-snapshot";
import { describe, it, expect } from "vitest";

describe("captureFormulaSnapshot: basic shape", () => {
  it("captures worksheet name and id", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");
    Cell.setValue(ws, "A1", 42);
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets).toHaveLength(1);
    expect(snap.worksheets[0].name).toBe("Data");
    expect(snap.worksheets[0].id).toBe(ws.id);
  });

  it("builds worksheet name lookup (lowercase)", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "Foo");
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheetsByName.has("foo")).toBe(true);
    expect(snap.worksheetsByName.has("FOO")).toBe(false);
  });

  it("builds worksheet id lookup", () => {
    const wb = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb, "A");
    const ws2 = Workbook.addWorksheet(wb, "B");
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheetsById.get(ws1.id)?.name).toBe("A");
    expect(snap.worksheetsById.get(ws2.id)?.name).toBe("B");
  });

  it("handles empty workbook (no sheets)", () => {
    const wb = Workbook.create();
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets).toHaveLength(0);
    expect(snap.worksheetsByName.size).toBe(0);
  });
});

describe("captureFormulaSnapshot: cell capture", () => {
  it("captures numeric values", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 42);
    const snap = captureFormulaSnapshot(wb);
    const cell = snap.worksheets[0].cells.get(snapshotCellKey(1, 1));
    expect(cell?.value).toBe(42);
    expect(cell?.formulaKind).toBe("none");
  });

  it("captures string values", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "B2", "hello");
    const snap = captureFormulaSnapshot(wb);
    const cell = snap.worksheets[0].cells.get(snapshotCellKey(2, 2));
    expect(cell?.value).toBe("hello");
  });

  it("captures boolean values", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", true);
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets[0].cells.get(snapshotCellKey(1, 1))?.value).toBe(true);
  });

  it("does not emit empty cells (sparse representation)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "C3", 3);
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets[0].cells.size).toBe(2);
  });

  it("captures Date values as Excel serial numbers", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", new Date(Date.UTC(2024, 0, 15)));
    const snap = captureFormulaSnapshot(wb);
    const v = snap.worksheets[0].cells.get(snapshotCellKey(1, 1))?.value;
    expect(typeof v).toBe("number");
    // 2024-01-15 = serial 45306
    expect(v).toBeGreaterThan(45000);
    expect(v).toBeLessThan(46000);
  });

  it("captures formula cells with kind=normal", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1+1", result: 2 });
    const snap = captureFormulaSnapshot(wb);
    const cell = snap.worksheets[0].cells.get(snapshotCellKey(1, 1));
    expect(cell?.formulaKind).toBe("normal");
    expect(cell?.formula).toBe("1+1");
    expect(cell?.cachedResult).toBe(2);
  });

  it("captures a formula cell's cached result", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SUM(1,2,3)", result: 6 });
    const snap = captureFormulaSnapshot(wb);
    const cell = snap.worksheets[0].cells.get(snapshotCellKey(1, 1));
    expect(cell?.cachedResult).toBe(6);
  });
});

describe("captureFormulaSnapshot: error value sanitization (R8)", () => {
  it("preserves known Excel error codes", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { error: "#N/A" });
    const snap = captureFormulaSnapshot(wb);
    const v = snap.worksheets[0].cells.get(snapshotCellKey(1, 1))?.value;
    expect(v).toEqual({ error: "#N/A" });
  });

  it("gates unknown error codes to #VALUE!", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    // Inject an unknown error string
    Cell.setValue(ws, "A1", { error: "custom-err" } as unknown as string);
    const snap = captureFormulaSnapshot(wb);
    const v = snap.worksheets[0].cells.get(snapshotCellKey(1, 1))?.value;
    expect(v).toEqual({ error: "#VALUE!" });
  });
});

describe("captureFormulaSnapshot: defined names", () => {
  it("captures workbook-level defined name", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 100);
    definedNamesAdd(getDefinedNames(wb), "Sheet1!A1", "TaxRate");
    const snap = captureFormulaSnapshot(wb);
    // Name should be findable (keys are uppercase)
    const found = Array.from(snap.definedNames.keys()).find(k =>
      k.toUpperCase().includes("TAXRATE")
    );
    expect(found).toBeDefined();
  });

  it("empty workbook has no defined names", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "S");
    const snap = captureFormulaSnapshot(wb);
    expect(snap.definedNames.size).toBe(0);
  });
});

describe("captureFormulaSnapshot: calc properties", () => {
  it("default iterative off", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "S");
    const snap = captureFormulaSnapshot(wb);
    expect(snap.calcProperties.iterate).toBeFalsy();
  });

  it("captures iterate flag", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "S");
    wb.calcProperties = { iterate: true, iterateCount: 50, iterateDelta: 0.0001 };
    const snap = captureFormulaSnapshot(wb);
    expect(snap.calcProperties.iterate).toBe(true);
    expect(snap.calcProperties.iterateCount).toBe(50);
    expect(snap.calcProperties.iterateDelta).toBe(0.0001);
  });
});

describe("captureFormulaSnapshot: date1904 property", () => {
  it("defaults to false", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "S");
    const snap = captureFormulaSnapshot(wb);
    expect(snap.properties.date1904).toBe(false);
  });

  it("captures date1904=true from workbook properties", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "S");
    wb.properties = { date1904: true };
    const snap = captureFormulaSnapshot(wb);
    expect(snap.properties.date1904).toBe(true);
  });
});

describe("captureFormulaSnapshot: hiddenRows capture", () => {
  it("empty worksheet has empty hiddenRows set", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "S");
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets[0].hiddenRows.size).toBe(0);
  });

  it("captures a hidden row that contains data", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", 2);
    Cell.setValue(ws, "A3", 3);
    Row.setHidden(ws, 2, true);
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets[0].hiddenRows.has(2)).toBe(true);
    expect(snap.worksheets[0].hiddenRows.has(1)).toBe(false);
    expect(snap.worksheets[0].hiddenRows.has(3)).toBe(false);
  });

  it("captures a hidden row that has no cells", () => {
    // Pure empty hidden row — adapter must use includeEmpty iteration
    // so the hidden flag is observed even without populated cells.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A3", 3);
    // Row 2 is empty; mark it hidden anyway.
    Row.setHidden(ws, 2, true);
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheets[0].hiddenRows.has(2)).toBe(true);
  });

  it("captures multiple hidden rows across the sheet", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    for (let i = 1; i <= 5; i++) {
      Cell.setValue(ws, `A${i}`, i);
    }
    Row.setHidden(ws, 1, true);
    Row.setHidden(ws, 3, true);
    Row.setHidden(ws, 5, true);
    const snap = captureFormulaSnapshot(wb);
    const hidden = snap.worksheets[0].hiddenRows;
    expect(hidden.has(1)).toBe(true);
    expect(hidden.has(2)).toBe(false);
    expect(hidden.has(3)).toBe(true);
    expect(hidden.has(4)).toBe(false);
    expect(hidden.has(5)).toBe(true);
    expect(hidden.size).toBe(3);
  });

  it("independent per-sheet hiddenRows sets", () => {
    const wb = Workbook.create();
    const s1 = Workbook.addWorksheet(wb, "S1");
    const s2 = Workbook.addWorksheet(wb, "S2");
    Cell.setValue(s1, "A1", 1);
    Row.setHidden(s1, 1, true);
    Cell.setValue(s2, "A1", 1);
    // S2 not hidden.
    const snap = captureFormulaSnapshot(wb);
    expect(snap.worksheetsByName.get("s1")?.hiddenRows.has(1)).toBe(true);
    expect(snap.worksheetsByName.get("s2")?.hiddenRows.has(1)).toBe(false);
  });
});
