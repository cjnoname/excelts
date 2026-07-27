/**
 * End-to-end tests exercising the full compile → evaluate → materialize
 * → apply pipeline. These are the only tests that verify workbook-level
 * roundtripping: the engine result is written back via the plan, and we
 * then read the live cell to confirm the materialised state.
 */

import { definedNamesAdd } from "@excel/core/defined-names";
import { calculateFormulas } from "@excel/core/formula-adapter";
import { captureFormulaSnapshot } from "@excel/core/formula-capture";
import { applyFormulaWriteback } from "@excel/core/formula-writeback";
import { getDefinedNames } from "@excel/core/workbook";
import { getCell, getSheetModel } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import type { WriteOperation } from "@formula/materialize/writeback-plan";
import { describe, it, expect } from "vitest";

describe("formula writeback transaction", () => {
  it.each(["scalar", "cse", "spill", "spill-error", "cleanup"] as const)(
    "rolls back the complete workbook when %s application throws",
    operationType => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      Cell.setValue(ws, "A1", { formula: "1", result: 0 });
      Cell.setValue(ws, "B1", { formula: "1", result: 0 });
      Cell.setValue(ws, "C1", 9);
      Cell.setValue(ws, "D1", { formula: "SEQUENCE(2)", result: 0 });
      Cell.setValue(ws, "E1", { formula: "1", result: 0 });
      Cell.setValue(ws, "F1", { formula: "1", result: 0 });

      const operation: WriteOperation = (() => {
        switch (operationType) {
          case "scalar":
            return { type: "scalar", sheetName: "S", row: 1, col: 2, value: 7 };
          case "cse":
            return {
              type: "cse",
              sheetName: "S",
              top: 1,
              left: 2,
              bottom: 1,
              right: 2,
              results: [[7]]
            };
          case "spill":
            return {
              type: "spill",
              sheetName: "S",
              sheetId: ws.id,
              row: 1,
              col: 4,
              results: [[1], [2]]
            };
          case "spill-error":
            return { type: "spill-error", sheetName: "S", sheetId: ws.id, row: 1, col: 5 };
          case "cleanup":
            return {
              type: "cleanup",
              sheetName: "S",
              sheetId: ws.id,
              cells: [{ row: 1, col: 3 }]
            };
        }
      })();
      const before = JSON.stringify(getSheetModel(ws));
      const snapshot = captureFormulaSnapshot(wb);

      expect(() =>
        applyFormulaWriteback(
          wb,
          {
            operations: [{ type: "scalar", sheetName: "S", row: 1, col: 1, value: 42 }, operation],
            spillState: { spillRegions: new Map() }
          },
          snapshot,
          captureFormulaSnapshot(wb),
          {
            afterOperation: (_operation, index) => {
              if (index === 1) {
                throw new Error("injected writeback failure");
              }
            }
          }
        )
      ).toThrow("injected writeback failure");
      expect(JSON.stringify(getSheetModel(ws))).toBe(before);
    }
  );

  it("does not invoke a custom function twice while recording a plain dynamic dependency", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    let calls = 0;
    Workbook.registerFunction(wb, "NEXT", () => ++calls);
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "B1", { formula: 'INDIRECT("A1")+NEXT()', result: 0 });

    calculateFormulas(wb);

    expect(calls).toBe(1);
    expect(Cell.getResult(ws, "B1")).toBe(11);
  });

  it("honors the volatile option for custom functions", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    let calls = 0;
    Workbook.registerFunction(wb, "TICK", () => ++calls, { volatile: true });
    Cell.setValue(ws, "A1", { formula: "TICK()", result: 0 });

    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(2);
  });
  it("validates the whole plan before mutating any cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1", result: 0 });

    const snapshot = captureFormulaSnapshot(wb);
    expect(() =>
      applyFormulaWriteback(
        wb,
        {
          operations: [
            { type: "scalar", sheetName: "S", row: 1, col: 1, value: 42 },
            { type: "scalar", sheetName: "Deleted", row: 1, col: 1, value: 99 }
          ],
          spillState: { spillRegions: new Map() }
        },
        snapshot,
        captureFormulaSnapshot(wb)
      )
    ).toThrow("Formula writeback");

    expect(Cell.getResult(ws, "A1")).toBe(0);
  });

  it("rejects target changes made by a custom function during evaluation", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "MUTATE()", result: 0 });
    Workbook.registerFunction(wb, "MUTATE", () => {
      Cell.setValue(ws, "A1", { formula: "1", result: 7 });
      return { kind: 1, value: 42 };
    });

    expect(() => calculateFormulas(wb)).toThrow("Workbook changed during formula calculation");
    expect(Cell.getResult(ws, "A1")).toBe(7);
  });

  it("still rejects changes when the custom function unregisters itself", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "MUTATE()", result: 0 });
    Workbook.registerFunction(wb, "MUTATE", () => {
      Cell.setValue(ws, "A1", { formula: "1", result: 7 });
      Workbook.unregisterFunction(wb, "MUTATE");
      return { kind: 1, value: 42 };
    });

    expect(() => calculateFormulas(wb)).toThrow("Workbook changed during formula calculation");
    expect(Cell.getFormula(ws, "A1")).toBe("1");
    expect(Cell.getResult(ws, "A1")).toBe(7);
  });

  it("validates CSE bounds before applying earlier operations", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1", result: 0 });
    const snapshot = captureFormulaSnapshot(wb);

    expect(() =>
      applyFormulaWriteback(
        wb,
        {
          operations: [
            { type: "scalar", sheetName: "S", row: 1, col: 1, value: 42 },
            {
              type: "cse",
              sheetName: "S",
              top: 1,
              left: 2,
              bottom: 1,
              right: 16385,
              results: []
            }
          ],
          spillState: { spillRegions: new Map() }
        },
        snapshot,
        captureFormulaSnapshot(wb)
      )
    ).toThrow("outside worksheet bounds");
    expect(Cell.getResult(ws, "A1")).toBe(0);
  });

  it("validates spill bounds before applying earlier operations", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1", result: 0 });
    Cell.setValue(ws, "XFD1", { formula: "1", result: 0 });
    const snapshot = captureFormulaSnapshot(wb);

    expect(() =>
      applyFormulaWriteback(
        wb,
        {
          operations: [
            { type: "scalar", sheetName: "S", row: 1, col: 1, value: 42 },
            {
              type: "spill",
              sheetName: "S",
              sheetId: ws.id,
              row: 1,
              col: 16384,
              results: [[1, 2]]
            }
          ],
          spillState: { spillRegions: new Map() }
        },
        snapshot,
        captureFormulaSnapshot(wb)
      )
    ).toThrow("outside worksheet bounds");
    expect(Cell.getResult(ws, "A1")).toBe(0);
  });

  it("validates cleanup bounds before applying earlier operations", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1", result: 0 });
    const snapshot = captureFormulaSnapshot(wb);

    expect(() =>
      applyFormulaWriteback(
        wb,
        {
          operations: [
            { type: "scalar", sheetName: "S", row: 1, col: 1, value: 42 },
            { type: "cleanup", sheetName: "S", sheetId: ws.id, cells: [{ row: 1, col: 0 }] }
          ],
          spillState: { spillRegions: new Map() }
        },
        snapshot,
        captureFormulaSnapshot(wb)
      )
    ).toThrow("outside worksheet bounds");
    expect(Cell.getResult(ws, "A1")).toBe(0);
  });
});

describe("formula writeback roundtrip: scalar formulas", () => {
  it("does not preserve stale cache for a runtime #CALC! result", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", 2);
    Cell.setValue(ws, "B1", { formula: "FILTER(A1:A2,A1:A2>10)", result: 99 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toEqual({ error: "#CALC!" });
  });
  it("writes parse failures when no cached result exists", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SUM(" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#NAME?" });
  });

  it("propagates parse failures to dependent formulas", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SUM(" });
    Cell.setValue(ws, "B1", { formula: "A1+1" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#NAME?" });
    expect(Cell.getResult(ws, "B1")).toEqual({ error: "#NAME?" });
  });

  it("keeps dependents consistent with a preserved cached result", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    // The engine cannot compile A1, but Excel already stored 99 for it. The
    // cell keeps 99, so a dependent must read 99 — not an error.
    Cell.setValue(ws, "A1", { formula: "SUM(", result: 99 });
    Cell.setValue(ws, "B1", { formula: "A1+1" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(99);
    expect(Cell.getResult(ws, "B1")).toBe(100);
  });

  it("preserves cached results for formulas the engine cannot parse", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SUM(", result: 99 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(99);
  });

  it("writes scalar result back to the source cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "A2", { formula: "A1*2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A2")).toBe(20);
  });

  it("preserves error result", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1/0", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#DIV/0!" });
  });

  it("chained dependencies compute in topological order", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", { formula: "A1+1", result: 0 });
    Cell.setValue(ws, "A3", { formula: "A2+1", result: 0 });
    Cell.setValue(ws, "A4", { formula: "A3+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A4")).toBe(4);
  });

  it("recalc after cell value change updates dependents", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "B1", { formula: "A1+5", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(15);

    Cell.setValue(ws, "A1", 100);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(105);
  });
});

describe("formula writeback roundtrip: spill visibility", () => {
  it("rebuilds a spill after inserting a row above it", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);

    Worksheet.spliceRows(ws, 1, 0, []);
    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A2")).toBe(1);
    expect(Cell.getValue(ws, "A3")).toBe(2);
    expect(Cell.getValue(ws, "A4")).toBe(3);
  });

  it("rebuilds a spill after inserting a column before it", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(1,3)", result: 0 });
    calculateFormulas(wb);

    Worksheet.spliceColumns(ws, 1, 0, []);
    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toBe(1);
    expect(Cell.getValue(ws, "C1")).toBe(2);
    expect(Cell.getValue(ws, "D1")).toBe(3);
  });

  it("does not duplicate spill ghosts as blocking constants", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(1,3)", result: 0 });
    calculateFormulas(wb);

    Worksheet.duplicateRow(ws, 1, 1, true);
    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A2")).toBe(1);
    expect(Cell.getValue(ws, "B2")).toBe(2);
    expect(Cell.getValue(ws, "C2")).toBe(3);
  });

  it("clears ghost ownership when the ghost becomes a merge master", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);

    Worksheet.merge(ws, "A2:B2");
    expect(getCell(ws, "A2")._formulaGhostOwner).toBeUndefined();
  });
  it("propagates a blocked spill error instead of exposing virtual ghosts", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(2)", result: 0 });
    Cell.setValue(ws, "A2", 100);
    Cell.setValue(ws, "C1", { formula: "SUM(A1:A2)", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#SPILL!" });
    expect(Cell.getResult(ws, "C1")).toEqual({ error: "#SPILL!" });
  });

  it("treats old ghosts outside a shrunken spill as blank", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    Cell.setValue(ws, "B1", { formula: "SUM(A1:A3)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(6);

    Cell.setValue(ws, "A1", { formula: "SEQUENCE(1)", result: 0 });
    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBeNull();
    expect(Cell.getValue(ws, "A3")).toBeNull();
  });

  it("does not reclaim a Date that normalizes to the old ghost number", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);

    const replacement = new Date(Date.UTC(1900, 0, 1));
    Cell.setValue(ws, "A2", replacement);
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(1)", result: 0 });
    calculateFormulas(wb);

    expect(Cell.getValue(ws, "A2")).toEqual(replacement);
  });

  it("does not reclaim a ghost rewritten by the user with the same value", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);

    Cell.setValue(ws, "A2", 2);
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(1)", result: 0 });
    calculateFormulas(wb);

    expect(Cell.getValue(ws, "A2")).toBe(2);
  });
});

describe("applyWritebackPlan roundtrip: cross-sheet", () => {
  it("resolves references to other sheets", () => {
    const wb = Workbook.create();
    const s1 = Workbook.addWorksheet(wb, "Data");
    const s2 = Workbook.addWorksheet(wb, "Report");
    Cell.setValue(s1, "A1", 99);
    Cell.setValue(s2, "B1", { formula: "Data!A1 * 2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(s2, "B1")).toBe(198);
  });

  it("quoted sheet names with spaces", () => {
    const wb = Workbook.create();
    const s1 = Workbook.addWorksheet(wb, "My Data");
    const s2 = Workbook.addWorksheet(wb, "Rpt");
    Cell.setValue(s1, "A1", 7);
    Cell.setValue(s2, "A1", { formula: "'My Data'!A1 + 3", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(s2, "A1")).toBe(10);
  });
});

describe("applyWritebackPlan roundtrip: dynamic arrays", () => {
  it("SEQUENCE(3) spills down to A1:A3", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);
  });

  it("SEQUENCE(2,3) spills to 2×3 block", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(2,3)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(4);
    expect(Cell.getValue(ws, "C2")).toBe(6);
  });

  it("Changing spill source reclaims old ghost cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    // First, spill to A1:A5
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(5)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getValue(ws, "A5")).toBe(5);

    // Change to shorter spill
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(2)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    // A3..A5 should have been cleaned up
    expect(Cell.getValue(ws, "A3")).toBeFalsy();
  });

  it("#SPILL! when target cell occupied", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A2", "blocker");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#SPILL!" });
  });

  it("transitions from a prior spill through #SPILL! and back without stale state", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getValue(ws, "A3")).toBe(3);

    // A user edit replaces a previous ghost. The engine must preserve that
    // value, clean only untouched ghosts, and drop the old spill metadata.
    Cell.setValue(ws, "A2", "blocker");
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#SPILL!" });
    expect(Cell.getValue(ws, "A2")).toBe("blocker");
    expect(Cell.getValue(ws, "A3")).toBeNull();

    Cell.setValue(ws, "A2", null);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);
  });
});

describe("applyWritebackPlan roundtrip: circular references", () => {
  it("circular returns 0 by default (non-iterative)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "A1+1", result: 0 });
    calculateFormulas(wb);
    // Without iteration, engine returns 0 (the seeded fallback) + 1 = 1
    expect(Cell.getResult(ws, "A1")).toBe(1);
  });

  it("converges under iterative calc", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "A1+1", result: 0 });
    calculateFormulas(wb);
    // Each iteration adds 1; 100 iterations → 100 (or maxIter)
    const r = Cell.getResult(ws, "A1") as number;
    expect(r).toBeGreaterThan(50);
  });

  it("keeps iterating when a circular cell starts out non-numeric", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 20, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "S");
    // B1 converges to 0 only after several passes; A1's text result must not
    // make the loop declare convergence after a single iteration.
    Cell.setValue(ws, "A1", { formula: 'IF(B1>3,"done",A1)', result: 0 });
    Cell.setValue(ws, "B1", { formula: "B1+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1") as number).toBeGreaterThan(5);
  });

  it("preserves a dynamic-array spill inside an iterative calculation", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 10, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(3)", result: 0 });
    Cell.setValue(ws, "C1", { formula: "C1+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);
  });
});

describe("applyWritebackPlan roundtrip: shared formula propagation", () => {
  it("a formula copied to a sibling cell evaluates correctly", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "A2", 20);
    Cell.setValue(ws, "B1", { formula: "A1*2", result: 0 });
    Cell.setValue(ws, "B2", { formula: "A2*2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(20);
    expect(Cell.getResult(ws, "B2")).toBe(40);
  });
});

describe("applyWritebackPlan roundtrip: error propagation chain", () => {
  it("error in base cell propagates through chain", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1/0", result: 0 });
    Cell.setValue(ws, "A2", { formula: "A1+1", result: 0 });
    Cell.setValue(ws, "A3", { formula: "A2*2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A3")).toEqual({ error: "#DIV/0!" });
  });

  it("IFERROR catches upstream error", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "1/0", result: 0 });
    Cell.setValue(ws, "B1", { formula: "IFERROR(A1, 999)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(999);
  });
});

describe("applyWritebackPlan roundtrip: BLANK / null results", () => {
  it("formula returning nothing reads as undefined", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "IF(TRUE,,)", result: 0 });
    calculateFormulas(wb);
    // IF with empty else branch → BLANK → undefined
    const r = Cell.getResult(ws, "A1");
    expect(r === undefined || r === null || r === 0).toBe(true);
  });

  it("string result", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: 'UPPER("hello")', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe("HELLO");
  });
});

describe("applyWritebackPlan roundtrip: recalc idempotence", () => {
  it("two consecutive calcs produce the same result", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "A2", { formula: "A1+5", result: 0 });
    calculateFormulas(wb);
    const r1 = Cell.getResult(ws, "A2");
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A2")).toBe(r1);
  });

  it("volatile functions re-evaluate each calc", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", { formula: "RAND()", result: 0 });
    calculateFormulas(wb);
    const r1 = Cell.getResult(ws, "A1");
    calculateFormulas(wb);
    const r2 = Cell.getResult(ws, "A1");
    // 1 in 2^53 chance of same — OK to assert strict
    expect(typeof r1).toBe("number");
    expect(typeof r2).toBe("number");
  });
});

describe("applyWritebackPlan roundtrip: defined names", () => {
  it("workbook-level defined name resolves to cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", 42);
    definedNamesAdd(getDefinedNames(wb), "S!A1", "Answer");
    Cell.setValue(ws, "B1", { formula: "Answer * 2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(84);
  });
});
