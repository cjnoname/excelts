/**
 * Unit tests for the compile-layer analysis helpers:
 *
 * - `extractStaticDeps` — collects cell / area references from a bound
 *   expression so the dependency graph can order formula evaluation.
 * - `detectDynamicArrayFunction` — flags whether a formula's top-level
 *   call is a known dynamic-array producer (SEQUENCE, FILTER, etc.).
 * - `analyzeExpr` — scans for volatile / dynamic-ref / lambda usage.
 *
 * Correctness here underpins the whole calc engine: a missed dep
 * silently orders formulas wrong; a missed volatile flag caches stale
 * NOW/RAND across iterations.
 */

import { captureFormulaSnapshot } from "@excel/core/formula-capture";
import { Workbook } from "@excel/index";
import { describe, expect, it } from "vitest";

import { parse } from "../../syntax/parser";
import { tokenize } from "../../syntax/tokenizer";
import { bind } from "../binder";
import {
  analyzeExpr,
  detectDynamicArrayFunction,
  detectSubtotalOutput,
  extractStaticDeps
} from "../compiled-formula";

function compile(source: string, currentSheet = "Sheet1") {
  const wb = Workbook.create();
  Workbook.addWorksheet(wb, currentSheet);
  const snap = captureFormulaSnapshot(wb);
  const ast = parse(tokenize(source));
  const bound = bind(ast, { snapshot: snap, currentSheet });
  return { ast, bound, snap };
}

// ---------------------------------------------------------------------------
// extractStaticDeps
// ---------------------------------------------------------------------------

describe("extractStaticDeps", () => {
  it("empty formula has no deps", () => {
    const { bound } = compile("123");
    const deps = extractStaticDeps(bound);
    expect(deps.cells.length).toBe(0);
    expect(deps.areas.length).toBe(0);
  });

  it("captures a single cell reference", () => {
    const { bound } = compile("A1+1");
    const deps = extractStaticDeps(bound);
    expect(deps.cells).toEqual([{ sheet: "Sheet1", row: 1, col: 1 }]);
    expect(deps.areas.length).toBe(0);
  });

  it("captures an area reference", () => {
    const { bound } = compile("SUM(A1:C3)");
    const deps = extractStaticDeps(bound);
    expect(deps.cells.length).toBe(0);
    expect(deps.areas).toEqual([{ sheet: "Sheet1", top: 1, left: 1, bottom: 3, right: 3 }]);
  });

  it("collects deps from both branches of a binary op", () => {
    const { bound } = compile("A1+B2");
    const deps = extractStaticDeps(bound);
    expect(deps.cells.length).toBe(2);
  });

  it("collects deps through nested function calls", () => {
    const { bound } = compile("SUM(A1:A3) + AVERAGE(B1:B3)");
    const deps = extractStaticDeps(bound);
    expect(deps.areas.length).toBe(2);
  });

  it("deduplicates repeated cell deps", () => {
    const { bound } = compile("A1 + A1 + A1");
    const deps = extractStaticDeps(bound);
    expect(deps.cells.length).toBe(1);
  });

  it("deduplicates repeated area deps", () => {
    const { bound } = compile("SUM(A1:A5) + AVERAGE(A1:A5)");
    const deps = extractStaticDeps(bound);
    expect(deps.areas.length).toBe(1);
  });

  it("keeps distinct areas separate", () => {
    const { bound } = compile("SUM(A1:A3) + SUM(A1:A4)");
    const deps = extractStaticDeps(bound);
    expect(deps.areas.length).toBe(2);
  });

  it("cross-sheet reference preserves sheet name", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "Data");
    Workbook.addWorksheet(wb, "Report");
    const snap = captureFormulaSnapshot(wb);
    const ast = parse(tokenize("Data!A1*2"));
    const bound = bind(ast, { snapshot: snap, currentSheet: "Report" });
    const deps = extractStaticDeps(bound);
    expect(deps.cells).toEqual([{ sheet: "Data", row: 1, col: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// detectDynamicArrayFunction
// ---------------------------------------------------------------------------

describe("detectDynamicArrayFunction", () => {
  it("SEQUENCE at top-level is a dynamic-array producer", () => {
    const { ast, bound } = compile("SEQUENCE(5)");
    expect(detectDynamicArrayFunction(ast, bound)).toBe(true);
  });

  it("FILTER at top-level is a dynamic-array producer", () => {
    const { ast, bound } = compile("FILTER(A1:A5, B1:B5)");
    expect(detectDynamicArrayFunction(ast, bound)).toBe(true);
  });

  it("SORT / UNIQUE / RANDARRAY are dynamic-array producers", () => {
    for (const f of ["SORT(A1:A5)", "UNIQUE(A1:A5)", "RANDARRAY(3,3)"]) {
      const { ast, bound } = compile(f);
      expect(detectDynamicArrayFunction(ast, bound)).toBe(true);
    }
  });

  it("plain SUM is NOT a dynamic-array producer", () => {
    const { ast, bound } = compile("SUM(A1:A5)");
    expect(detectDynamicArrayFunction(ast, bound)).toBe(false);
  });

  it("scalar expression is NOT a dynamic-array producer", () => {
    const { ast, bound } = compile("1+2");
    expect(detectDynamicArrayFunction(ast, bound)).toBe(false);
  });

  it("dynamic-array function nested inside non-DA call is NOT flagged", () => {
    // The detector only looks at the TOP-LEVEL call.
    const { ast, bound } = compile("SUM(SEQUENCE(5))");
    expect(detectDynamicArrayFunction(ast, bound)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeExpr
// ---------------------------------------------------------------------------

describe("analyzeExpr", () => {
  it("plain arithmetic is non-volatile, no dynamic refs, no lambda", () => {
    const { bound } = compile("1+2");
    const a = analyzeExpr(bound);
    expect(a.isVolatile).toBe(false);
    expect(a.hasDynamicRefs).toBe(false);
    expect(a.containsLambda).toBe(false);
  });

  it("NOW() is volatile", () => {
    const { bound } = compile("NOW()");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("TODAY() is volatile", () => {
    const { bound } = compile("TODAY()");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("RAND() is volatile", () => {
    const { bound } = compile("RAND()");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("RANDBETWEEN is volatile", () => {
    const { bound } = compile("RANDBETWEEN(1, 10)");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("INDIRECT flags both volatile and hasDynamicRefs (R5)", () => {
    const { bound } = compile('INDIRECT("A1")');
    const a = analyzeExpr(bound);
    expect(a.isVolatile).toBe(true);
    expect(a.hasDynamicRefs).toBe(true);
  });

  it("OFFSET flags both volatile and hasDynamicRefs", () => {
    const { bound } = compile("OFFSET(A1, 1, 1)");
    const a = analyzeExpr(bound);
    expect(a.isVolatile).toBe(true);
    expect(a.hasDynamicRefs).toBe(true);
  });

  it("volatility bubbles up through arithmetic", () => {
    const { bound } = compile("NOW() + 1");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("volatility bubbles up through function calls", () => {
    const { bound } = compile("YEAR(NOW())");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("_XLFN.RANDARRAY is flagged volatile via canonical name (regression)", () => {
    // Regression: `boundCall` preserves the `_XLFN.` prefix on regular
    // function names, so VOLATILE_FUNCTIONS.has("_XLFN.RANDARRAY") used
    // to return false and the outer formula's session cache held stale
    // values across calc passes. analyzeExpr must strip the prefix
    // before doing the lookup.
    const { bound } = compile("_XLFN.RANDARRAY(3, 3)");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("_XLFN._XLWS.RANDARRAY double-prefixed form is also flagged volatile", () => {
    const { bound } = compile("_XLFN._XLWS.RANDARRAY(3, 3)");
    expect(analyzeExpr(bound).isVolatile).toBe(true);
  });

  it("LAMBDA is flagged", () => {
    // LAMBDA can only appear as a top-level call of a higher-order fn
    // like REDUCE / MAP / LET, not as an immediately-invoked prefix.
    const { bound } = compile("REDUCE(0, A1:A3, LAMBDA(acc,x, acc+x))");
    expect(analyzeExpr(bound).containsLambda).toBe(true);
  });

  it("nested LAMBDA inside LET is flagged", () => {
    const { bound } = compile("LET(f, LAMBDA(x, x+1), f(3))");
    expect(analyzeExpr(bound).containsLambda).toBe(true);
  });

  it("plain formula without LAMBDA is not flagged", () => {
    const { bound } = compile("SUM(1,2,3)");
    expect(analyzeExpr(bound).containsLambda).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectSubtotalOutput — drives the subtotalMask on array values so
// outer SUBTOTAL / AGGREGATE calls don't double-count inner aggregates.
// ---------------------------------------------------------------------------

describe("detectSubtotalOutput", () => {
  it("SUBTOTAL at top level is flagged", () => {
    const { ast, bound } = compile("SUBTOTAL(9, A1:A5)");
    expect(detectSubtotalOutput(ast, bound)).toBe(true);
  });

  it("AGGREGATE at top level is flagged", () => {
    const { ast, bound } = compile("AGGREGATE(9, 5, A1:A5)");
    expect(detectSubtotalOutput(ast, bound)).toBe(true);
  });

  it("_XLFN.AGGREGATE (xlsx-prefixed) is flagged via canonical name", () => {
    const { ast, bound } = compile("_XLFN.AGGREGATE(9, 5, A1:A5)");
    expect(detectSubtotalOutput(ast, bound)).toBe(true);
  });

  it("plain SUM is NOT flagged", () => {
    const { ast, bound } = compile("SUM(A1:A5)");
    expect(detectSubtotalOutput(ast, bound)).toBe(false);
  });

  it("SUBTOTAL nested inside another function is NOT flagged at top level", () => {
    // Only the top-level call matters for cell marking — the nested
    // SUBTOTAL's result gets merged into the outer SUM result, which
    // itself is not a subtotal-output cell.
    const { ast, bound } = compile("SUM(SUBTOTAL(9, A1:A5), 1)");
    expect(detectSubtotalOutput(ast, bound)).toBe(false);
  });

  it("arithmetic expression is NOT flagged", () => {
    const { ast, bound } = compile("1+2");
    expect(detectSubtotalOutput(ast, bound)).toBe(false);
  });
});
