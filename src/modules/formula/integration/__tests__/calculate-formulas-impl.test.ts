/**
 * Integration tests for the calculate-formulas pipeline.
 *
 * These tests exercise `calculateFormulasImpl` through the public
 * `Workbook.calculateFormulas()` entry point so that snapshot →
 * compile → topological sort → evaluate → writeback is covered
 * end-to-end.
 *
 * Focus areas:
 *   - Dependency-graph topological ordering (chains, diamonds, multi-root)
 *   - Iterative calculation convergence
 *   - Dynamic-reference discovery (INDIRECT / OFFSET) feeding back into
 *     the dependency graph via session.dynamicDeps
 *   - AST cache reuse across repeated invocations
 *   - Dynamic-array spill lifecycle (spill → resize → clear)
 *   - Formula-kind dispatch: normal, shared, CSE master/slave, dynamic array
 *   - Error surfacing from the three pipeline phases: parse, bind, evaluate
 *   - date1904 propagation to the function registry
 *   - Empty workbook / no-formula no-ops
 */

import { cellGetValue } from "@excel/core/cell";
import { calculateFormulas } from "@excel/core/formula-adapter";
import { findCell } from "@excel/core/worksheet";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { describe, it, expect } from "vitest";

// ============================================================================
// Dependency Graph Topological Ordering
// ============================================================================

/** Cell value, or null when the cell is absent — preserves the original `findCell(...)?.value ?? null` semantics. */
function cellValueOrNull(c: ReturnType<typeof findCell>): unknown {
  return c ? (cellGetValue(c) ?? null) : null;
}

describe("calculate-formulas: dependency graph topological ordering", () => {
  it("evaluates a chain A1 → B1 → C1 in correct order (R2-PX-01)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "B1", { formula: "A1+10", result: 0 });
    Cell.setValue(ws, "C1", { formula: "B1*2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(11);
    expect(Cell.getResult(ws, "C1")).toBe(22);
  });

  it("evaluates a chain declared in reverse source order (R2-PX-02)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // Declare C1 first — topological sort must still put A1 → B1 → C1.
    Cell.setValue(ws, "C1", { formula: "B1*2", result: 0 });
    Cell.setValue(ws, "B1", { formula: "A1+10", result: 0 });
    Cell.setValue(ws, "A1", 1);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(11);
    expect(Cell.getResult(ws, "C1")).toBe(22);
  });

  it("evaluates a diamond dependency A→B, A→C, B+C→D (R2-PX-03)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 5);
    Cell.setValue(ws, "B1", { formula: "A1*2", result: 0 }); // 10
    Cell.setValue(ws, "C1", { formula: "A1+1", result: 0 }); // 6
    Cell.setValue(ws, "D1", { formula: "B1+C1", result: 0 }); // 16
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(10);
    expect(Cell.getResult(ws, "C1")).toBe(6);
    expect(Cell.getResult(ws, "D1")).toBe(16);
  });

  it("evaluates multiple independent roots in one pass (R2-PX-04)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // Two disjoint chains sharing no cells.
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "A2", { formula: "A1*2", result: 0 });
    Cell.setValue(ws, "B1", 20);
    Cell.setValue(ws, "B2", { formula: "B1+3", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A2")).toBe(20);
    expect(Cell.getResult(ws, "B2")).toBe(23);
  });

  it("evaluates a deep chain without stack issues (R2-PX-05)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 0);
    for (let i = 2; i <= 100; i++) {
      Cell.setValue(ws, `A${i}`, { formula: `A${i - 1}+1`, result: 0 });
    }
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A100")).toBe(99);
  });
});

// ============================================================================
// Iterative Calculation
// ============================================================================

describe("calculate-formulas: iterative calculation", () => {
  it("converges a single-cell self-reference with iterate=true (R2-PX-10)", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 200, iterateDelta: 0.0001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // Classic converging self-ref: A1 = A1/2 + 1 → fixed point 2
    Cell.setValue(ws, "A1", { formula: "A1/2+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBeCloseTo(2, 3);
  });

  it("advances a non-converging self-reference up to iterateCount (R2-PX-11)", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 7, iterateDelta: 0 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "A1+1", result: 0 });
    calculateFormulas(wb);
    // Initial pass (circular fallback 0 → 0+1 = 1), then 7 iterations: 8
    expect(Cell.getResult(ws, "A1")).toBe(8);
  });

  it("converges a 3-cell ring A→B→C→A (R2-PX-12)", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 200, iterateDelta: 0.0001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // A = C/2 + 1, B = A/2 + 1, C = B/2 + 1 → all converge to 2
    Cell.setValue(ws, "A1", { formula: "C1/2+1", result: 0 });
    Cell.setValue(ws, "B1", { formula: "A1/2+1", result: 0 });
    Cell.setValue(ws, "C1", { formula: "B1/2+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBeCloseTo(2, 3);
    expect(Cell.getResult(ws, "B1")).toBeCloseTo(2, 3);
    expect(Cell.getResult(ws, "C1")).toBeCloseTo(2, 3);
  });

  it("re-evaluates downstream non-circular cells after convergence (R2-PX-13)", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // A1 converges to 1, downstream B1 and C1 should reflect the converged value.
    Cell.setValue(ws, "A1", { formula: "IF(A1>0,A1,1)", result: 0 });
    Cell.setValue(ws, "B1", { formula: "A1*10", result: 0 });
    Cell.setValue(ws, "C1", { formula: "B1+5", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getResult(ws, "B1")).toBe(10);
    expect(Cell.getResult(ws, "C1")).toBe(15);
  });

  it("returns a number (not an error) for a cycle without iterate (R2-PX-14)", () => {
    // Baseline: circular ref zero-seed fallback. Verified again here at
    // the integration layer to pin the behaviour.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "A2+1", result: 0 });
    Cell.setValue(ws, "A2", { formula: "A1+1", result: 0 });
    calculateFormulas(wb);
    expect(typeof Cell.getResult(ws, "A1")).toBe("number");
    expect(typeof Cell.getResult(ws, "A2")).toBe("number");
  });

  it("iterates every element of a circular dynamic array", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "A1:A2/2+1",
      result: 0,
      isDynamicArray: true
    });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A1")).toBeCloseTo(2, 2);
    expect(Cell.getValue(ws, "A2")).toBeCloseTo(2, 2);
  });

  it("orders a direct reference to a first-pass spill ghost after its master", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "C3*10", result: 0 });
    Cell.setValue(ws, "C1", { formula: "SEQUENCE(3)", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A1")).toBe(30);
  });

  it("re-evaluates direct ghost dependents after circular arrays converge", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "A1:A3/2+1",
      result: 0,
      isDynamicArray: true
    });
    Cell.setValue(ws, "C1", { formula: "A3*10", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "C1")).toBeCloseTo(20, 1);
  });

  it("updates dependencies when a circular spill expands during iteration", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 20, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "SEQUENCE(IF(A1<1,1,3))",
      result: 0,
      isDynamicArray: true
    });
    Cell.setValue(ws, "C1", { formula: "A3", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "C1")).toBe(3);
  });

  it("restarts iteration when spill expansion creates a new cycle", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "SEQUENCE(IF(A1<1,1,3),1,B1)",
      result: 0,
      isDynamicArray: true
    });
    Cell.setValue(ws, "B1", { formula: "A3/2+1", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toBeCloseTo(4, 2);
    expect(Cell.getValue(ws, "A3")).toBeCloseTo(6, 2);
  });

  it("resynchronizes footprints after dynamic-dependency reevaluation", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'SEQUENCE(INDIRECT("C3"))', result: 0 });
    Cell.setValue(ws, "B1", { formula: "A3", result: 0 });
    Cell.setValue(ws, "C1", { formula: "SEQUENCE(3)", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toBe(3);
  });

  it("remaps dynamic ghost dependencies to their spill master", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'INDIRECT("C3")/2+1', result: 0 });
    Cell.setValue(ws, "C1", {
      formula: "SEQUENCE(3,1,A1)",
      result: 0,
      isDynamicArray: true
    });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "A1")).toBeCloseTo(4, 2);
  });

  it("replaces dynamic dependency branches instead of accumulating stale edges", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B1", { formula: 'INDIRECT(IF(C3=3,"D1","E1"))', result: 0 });
    Cell.setValue(ws, "C1", { formula: "SEQUENCE(3)", result: 0 });
    Cell.setValue(ws, "D1", 10);
    Cell.setValue(ws, "E1", { formula: "B1+1", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toBe(10);
    expect(Cell.getResult(ws, "E1")).toBe(11);
  });

  it("keeps other formula dependencies inside a range that starts at a spill master", () => {
    const wb = Workbook.create();
    wb.calcProperties = { iterate: true, iterateCount: 100, iterateDelta: 0.001 };
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "SEQUENCE(2)", result: 0 });
    Cell.setValue(ws, "A3", { formula: "B1/2", result: 0 });
    Cell.setValue(ws, "B1", { formula: "SUM(A1:A3)", result: 0 });

    calculateFormulas(wb);

    expect(Cell.getResult(ws, "B1")).toBeCloseTo(6, 2);
    expect(Cell.getResult(ws, "A3")).toBeCloseTo(3, 2);
  });
});

// ============================================================================
// Dynamic Reference Discovery (INDIRECT / OFFSET)
// ============================================================================

describe("calculate-formulas: dynamic reference discovery", () => {
  it("re-evaluates INDIRECT targets when the address cell changes (R2-PX-20)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "C1");
    Cell.setValue(ws, "C1", 100);
    Cell.setValue(ws, "E1", 200);
    Cell.setValue(ws, "B1", { formula: "INDIRECT(A1)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(100);

    // Flip the target address and recalc — B1 must re-evaluate.
    Cell.setValue(ws, "A1", "E1");
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(200);
  });

  it("propagates INDIRECT changes to downstream dependents (R2-PX-21)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "C1");
    Cell.setValue(ws, "C1", 3);
    // B1 = INDIRECT(A1) → 3, D1 depends on B1.
    Cell.setValue(ws, "B1", { formula: "INDIRECT(A1)", result: 0 });
    Cell.setValue(ws, "D1", { formula: "B1*10", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(3);
    expect(Cell.getResult(ws, "D1")).toBe(30);
  });

  it("OFFSET-generated range is re-read after source data changes (R2-PX-22)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", 2);
    Cell.setValue(ws, "A3", 3);
    Cell.setValue(ws, "B1", {
      formula: "SUM(OFFSET(A1,0,0,3,1))",
      result: 0
    });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(6);

    // Data changes; recalc should pick them up even though OFFSET's deps
    // are dynamic.
    Cell.setValue(ws, "A2", 20);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(24);
  });
});

// ============================================================================
// AST Cache Reuse
// ============================================================================

describe("calculate-formulas: AST cache reuse across invocations", () => {
  it("produces identical results across successive recalculations (R2-PX-30)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 4);
    Cell.setValue(ws, "A2", { formula: "A1*A1+3", result: 0 });
    calculateFormulas(wb);
    const first = Cell.getResult(ws, "A2");
    calculateFormulas(wb);
    const second = Cell.getResult(ws, "A2");
    calculateFormulas(wb);
    const third = Cell.getResult(ws, "A2");
    expect(first).toBe(19);
    expect(second).toBe(19);
    expect(third).toBe(19);
  });

  it("keeps a cached AST usable after mutating dependency cells (R2-PX-31)", () => {
    // This exercises the same AST on successive calcs with different inputs.
    // The AST cache is keyed by formula text, so identical text reuses the
    // cached bound expression.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "B1", { formula: "A1*A1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(1);

    Cell.setValue(ws, "A1", 5);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(25);

    Cell.setValue(ws, "A1", 10);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(100);
  });

  it("shares a cached AST between two cells with the same formula text (R2-PX-32)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 3);
    Cell.setValue(ws, "A2", 5);
    // Identical formula text in different cells — AST cache hit
    Cell.setValue(ws, "B1", { formula: "A1+A2", result: 0 });
    Cell.setValue(ws, "B2", { formula: "A1+A2", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(8);
    expect(Cell.getResult(ws, "B2")).toBe(8);
  });
});

// ============================================================================
// Dynamic Array Spill Lifecycle
// ============================================================================

describe("calculate-formulas: dynamic array spill lifecycle", () => {
  it("fills SEQUENCE(3) into A1:A3 (R2-PX-40)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "SEQUENCE(3)",
      result: 0,
      shareType: "array",
      ref: "A1",
      isDynamicArray: true
    });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);
  });

  it("spills a 2-column SEQUENCE to a 3×2 block (R2-PX-41)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "SEQUENCE(3,2)",
      result: 0,
      shareType: "array",
      ref: "A1",
      isDynamicArray: true
    });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "B1")).toBe(2);
    expect(Cell.getValue(ws, "A2")).toBe(3);
    expect(Cell.getValue(ws, "B2")).toBe(4);
    expect(Cell.getValue(ws, "A3")).toBe(5);
    expect(Cell.getValue(ws, "B3")).toBe(6);
  });

  it("clears ghost cells when a dynamic array source becomes a scalar formula (R2-PX-42)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "SEQUENCE(3)",
      result: 0,
      shareType: "array",
      ref: "A1",
      isDynamicArray: true
    });
    calculateFormulas(wb);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(Cell.getValue(ws, "A3")).toBe(3);

    // Replace with a scalar formula — previous ghosts must be cleared.
    Cell.setValue(ws, "A1", { formula: "100", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(100);
    expect(cellValueOrNull(findCell(ws, 2, 1))).toBeNull();
    expect(cellValueOrNull(findCell(ws, 3, 1))).toBeNull();
  });

  it("shrinks the spill footprint when the output array shrinks (R2-PX-43)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "C1", 5);
    Cell.setValue(ws, "A1", {
      formula: "SEQUENCE(C1)",
      result: 0,
      shareType: "array",
      ref: "A1",
      isDynamicArray: true
    });
    calculateFormulas(wb);
    expect(Cell.getValue(ws, "A5")).toBe(5);

    // Shrink the source — row 5 ghost should be removed
    Cell.setValue(ws, "C1", 2);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe(2);
    expect(cellValueOrNull(findCell(ws, 3, 1))).toBeNull();
    expect(cellValueOrNull(findCell(ws, 4, 1))).toBeNull();
    expect(cellValueOrNull(findCell(ws, 5, 1))).toBeNull();
  });
});

// ============================================================================
// Formula Kinds — Normal, Shared, CSE Master/Slave, Dynamic Array
// ============================================================================

describe("calculate-formulas: formula kind dispatch", () => {
  it("evaluates a plain scalar formula (R2-PX-50)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 6);
    Cell.setValue(ws, "B1", { formula: "A1*7", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(42);
  });

  it("evaluates a shared (fillFormula) group with relative refs (R2-PX-51)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", 2);
    Cell.setValue(ws, "A3", 3);
    // B1:B3 — master at B1, slaves at B2/B3 share the formula with slide
    Worksheet.fillFormula(ws, "B1:B3", "A1*10", [10, 20, 30]);
    // Modify source to confirm slaves recompute, not just return cached values.
    Cell.setValue(ws, "A1", 5);
    Cell.setValue(ws, "A2", 6);
    Cell.setValue(ws, "A3", 7);
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(50);
    expect(Cell.getResult(ws, "B2")).toBe(60);
    expect(Cell.getResult(ws, "B3")).toBe(70);
  });

  it("distributes CSE array formula results across the target range (R2-PX-52)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", 2);
    Cell.setValue(ws, "A3", 3);
    Cell.setValue(ws, "B1", 10);
    Cell.setValue(ws, "B2", 20);
    Cell.setValue(ws, "B3", 30);
    // Master at C1 with range C1:C3; slaves at C2/C3
    Cell.setValue(ws, "C1", {
      formula: "A1:A3*B1:B3",
      result: 0,
      shareType: "array",
      ref: "C1:C3"
    });
    Cell.setValue(ws, "C2", { formula: "A1:A3*B1:B3", result: 0, shareType: "array" });
    Cell.setValue(ws, "C3", { formula: "A1:A3*B1:B3", result: 0, shareType: "array" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "C1")).toBe(10);
    expect(Cell.getResult(ws, "C2")).toBe(40);
    expect(Cell.getResult(ws, "C3")).toBe(90);
  });

  it("caches CSE array results for slave cells — second recalc agrees (R2-PX-53)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 2);
    Cell.setValue(ws, "A2", 3);
    Cell.setValue(ws, "B1", 4);
    Cell.setValue(ws, "B2", 5);
    Cell.setValue(ws, "C1", {
      formula: "A1:A2*B1:B2",
      result: 0,
      shareType: "array",
      ref: "C1:C2"
    });
    Cell.setValue(ws, "C2", { formula: "A1:A2*B1:B2", result: 0, shareType: "array" });
    calculateFormulas(wb);
    const first1 = Cell.getResult(ws, "C1");
    const first2 = Cell.getResult(ws, "C2");
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "C1")).toBe(first1);
    expect(Cell.getResult(ws, "C2")).toBe(first2);
    expect(first1).toBe(8);
    expect(first2).toBe(15);
  });

  it("spills a dynamic array formula (R2-PX-54)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 3);
    Cell.setValue(ws, "A2", 1);
    Cell.setValue(ws, "A3", 2);
    Cell.setValue(ws, "C1", {
      formula: "_xlfn._xlws.SORT(A1:A3)",
      result: 0,
      shareType: "array",
      ref: "C1",
      isDynamicArray: true
    });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "C1")).toBe(1);
    expect(Cell.getValue(ws, "C2")).toBe(2);
    expect(Cell.getValue(ws, "C3")).toBe(3);
  });
});

// ============================================================================
// Error Surfacing by Pipeline Phase
// ============================================================================

describe("calculate-formulas: error surfacing", () => {
  it("surfaces #NAME? when an unknown function is referenced (R2-PX-60)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    // Unknown function: tokenizes/parses fine but the runtime has no
    // matching descriptor. Omit `result:` so the engine can't preserve
    // a cached value, forcing it to surface the actual error.
    Cell.setValue(ws, "A1", { formula: "XYZUNKNOWN(1,2,3)" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#NAME?" });
  });

  it("surfaces #REF! for an external workbook reference (bind failure) (R2-PX-61)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "[Book1]Sheet1!A1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#REF!" });
  });

  it("surfaces the specific error produced during evaluation (R2-PX-62)", () => {
    // Verifies that evaluator-phase errors propagate, not the generic
    // #CALC! catch-all.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "1/0", result: 0 });
    Cell.setValue(ws, "A2", { formula: "SQRT(-4)", result: 0 });
    Cell.setValue(ws, "A3", { formula: "NA()", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#DIV/0!" });
    expect(Cell.getResult(ws, "A2")).toEqual({ error: "#NUM!" });
    expect(Cell.getResult(ws, "A3")).toEqual({ error: "#N/A" });
  });

  it("preserves a cached result when a formula text is un-parseable (R2-PX-63)", () => {
    // The unsupported-formula path: if the engine can't parse or
    // recognize the formula but the author provided a cached result,
    // that result is preserved rather than overwritten.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", {
      formula: "XYZUNKNOWN(1,2,3)",
      result: 42
    });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(42);
  });
});

// ============================================================================
// date1904 Propagation
// ============================================================================

describe("calculate-formulas: date1904 propagation", () => {
  it("DATE(1900,1,1) differs by exactly 1462 between 1900 and 1904 modes (R2-PX-70)", () => {
    // Same DATE() formula, two workbooks, only the date1904 flag differs.
    const wbA = Workbook.create();
    wbA.properties = { date1904: false };
    const wsA = Workbook.addWorksheet(wbA, "Sheet1");
    Cell.setValue(wsA, "A1", { formula: "DATE(2024,1,1)", result: 0 });
    calculateFormulas(wbA);

    const wbB = Workbook.create();
    wbB.properties = { date1904: true };
    const wsB = Workbook.addWorksheet(wbB, "Sheet1");
    Cell.setValue(wsB, "A1", { formula: "DATE(2024,1,1)", result: 0 });
    calculateFormulas(wbB);

    const a = Cell.getResult(wsA, "A1") as number;
    const b = Cell.getResult(wsB, "A1") as number;
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
    // 1900 mode serial is 1462 larger (the difference between the two epochs).
    expect(a - b).toBe(1462);
  });
});

// ============================================================================
// Empty / No-Formula Workbook
// ============================================================================

describe("calculate-formulas: empty and no-formula workbooks", () => {
  it("does nothing on an empty workbook (R2-PX-80)", () => {
    const wb = Workbook.create();
    expect(() => calculateFormulas(wb)).not.toThrow();
  });

  it("does nothing on a worksheet with only data cells (R2-PX-81)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "A2", "hello");
    Cell.setValue(ws, "A3", true);
    expect(() => calculateFormulas(wb)).not.toThrow();
    expect(Cell.getValue(ws, "A1")).toBe(1);
    expect(Cell.getValue(ws, "A2")).toBe("hello");
    expect(Cell.getValue(ws, "A3")).toBe(true);
  });

  it("handles a single formula with no dependencies (R2-PX-82)", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "2*3+4", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(10);
  });
});
