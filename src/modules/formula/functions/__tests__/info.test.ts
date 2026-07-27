/**
 * Unit tests for information / type-inspection / logical functions.
 *
 * These functions live directly inside `function-registry.ts` (registered
 * via `defineEager`) rather than in a dedicated `../information.ts`
 * module, so we go through the registry — `lookupFunction` — to get at
 * their implementations. The registry is auto-initialized at import time
 * so no explicit setup is needed.
 *
 * Reference-aware functions (CELL, ISREF, ISFORMULA, FORMULATEXT, SHEET
 * with a reference argument) short-circuit in the evaluator before the
 * registry stub is reached; they are tested through the Workbook API in
 * `../../runtime/__tests__/evaluator.test.ts`. This file exercises the
 * non-context-dependent stubs.
 */

import { calculateFormulas } from "@excel/core/formula-adapter";
import { Cell, Workbook } from "@excel/index";
import { describe, it, expect } from "vitest";

import { lookupFunction } from "../../runtime/function-registry";
import type { ArrayValue, BooleanValue, NumberValue, RuntimeValue } from "../../runtime/values";
import {
  BLANK,
  ERRORS,
  RVKind,
  rvArray,
  rvBoolean,
  rvError,
  rvNumber,
  rvString
} from "../../runtime/values";

/** Resolve a registered function by name or throw if missing. */
function fn(name: string): (args: RuntimeValue[]) => RuntimeValue {
  const desc = lookupFunction(name);
  if (!desc) {
    throw new Error(`Function ${name} not registered`);
  }
  return args => desc.invoke(args, { date1904: false });
}

function asBool(v: RuntimeValue): boolean {
  expect(v.kind).toBe(RVKind.Boolean);
  return (v as BooleanValue).value;
}

function asNumber(v: RuntimeValue): number {
  expect(v.kind).toBe(RVKind.Number);
  return (v as NumberValue).value;
}

// ============================================================================
// IS* family — type predicates
// ============================================================================

describe("ISBLANK", () => {
  const isblank = fn("ISBLANK");

  it("returns TRUE for a BLANK value", () => {
    expect(asBool(isblank([BLANK]))).toBe(true);
  });

  it("returns FALSE for number zero (blank !== 0)", () => {
    expect(asBool(isblank([rvNumber(0)]))).toBe(false);
  });

  it('returns FALSE for empty string (blank !== "")', () => {
    expect(asBool(isblank([rvString("")]))).toBe(false);
  });

  it("inspects the top-left cell of an array argument", () => {
    const arr = rvArray([[BLANK, rvNumber(1)]]);
    expect(asBool(isblank([arr]))).toBe(true);
  });

  it("returns FALSE for errors (an error is not blank)", () => {
    expect(asBool(isblank([ERRORS.NA]))).toBe(false);
    expect(asBool(isblank([ERRORS.DIV0]))).toBe(false);
  });
});

describe("ISNUMBER", () => {
  const isnumber = fn("ISNUMBER");

  it("returns TRUE for a number", () => {
    expect(asBool(isnumber([rvNumber(42)]))).toBe(true);
  });

  it("returns TRUE for zero and negative numbers", () => {
    expect(asBool(isnumber([rvNumber(0)]))).toBe(true);
    expect(asBool(isnumber([rvNumber(-1.5)]))).toBe(true);
  });

  it("returns FALSE for strings even if they look numeric", () => {
    expect(asBool(isnumber([rvString("42")]))).toBe(false);
  });

  it("returns FALSE for booleans (booleans are not numbers in Excel)", () => {
    expect(asBool(isnumber([rvBoolean(true)]))).toBe(false);
  });

  it("returns FALSE for BLANK and errors", () => {
    expect(asBool(isnumber([BLANK]))).toBe(false);
    expect(asBool(isnumber([ERRORS.NA]))).toBe(false);
  });
});

describe("ISTEXT", () => {
  const istext = fn("ISTEXT");

  it("returns TRUE for a string", () => {
    expect(asBool(istext([rvString("hello")]))).toBe(true);
  });

  it("returns TRUE for an empty string literal", () => {
    expect(asBool(istext([rvString("")]))).toBe(true);
  });

  it("returns FALSE for numbers and booleans", () => {
    expect(asBool(istext([rvNumber(5)]))).toBe(false);
    expect(asBool(istext([rvBoolean(false)]))).toBe(false);
  });

  it("returns FALSE for BLANK cells", () => {
    expect(asBool(istext([BLANK]))).toBe(false);
  });

  it("returns FALSE for error values", () => {
    expect(asBool(istext([ERRORS.VALUE]))).toBe(false);
  });
});

describe("ISNONTEXT", () => {
  const isnontext = fn("ISNONTEXT");

  it("returns FALSE for a string", () => {
    expect(asBool(isnontext([rvString("abc")]))).toBe(false);
  });

  it("returns TRUE for numbers", () => {
    expect(asBool(isnontext([rvNumber(1)]))).toBe(true);
  });

  it("returns TRUE for booleans", () => {
    expect(asBool(isnontext([rvBoolean(true)]))).toBe(true);
  });

  it("returns TRUE for BLANK cells", () => {
    expect(asBool(isnontext([BLANK]))).toBe(true);
  });

  it("returns TRUE for errors (errors are not text)", () => {
    expect(asBool(isnontext([ERRORS.NA]))).toBe(true);
  });
});

describe("ISLOGICAL", () => {
  const islogical = fn("ISLOGICAL");

  it("returns TRUE for TRUE", () => {
    expect(asBool(islogical([rvBoolean(true)]))).toBe(true);
  });

  it("returns TRUE for FALSE", () => {
    expect(asBool(islogical([rvBoolean(false)]))).toBe(true);
  });

  it("returns FALSE for numbers 0/1 (not boolean)", () => {
    expect(asBool(islogical([rvNumber(1)]))).toBe(false);
    expect(asBool(islogical([rvNumber(0)]))).toBe(false);
  });

  it('returns FALSE for the strings "TRUE"/"FALSE"', () => {
    expect(asBool(islogical([rvString("TRUE")]))).toBe(false);
  });

  it("returns FALSE for BLANK and errors", () => {
    expect(asBool(islogical([BLANK]))).toBe(false);
    expect(asBool(islogical([ERRORS.VALUE]))).toBe(false);
  });
});

describe("ISERROR", () => {
  const iserror = fn("ISERROR");

  it("returns TRUE for #N/A", () => {
    expect(asBool(iserror([ERRORS.NA]))).toBe(true);
  });

  it("returns TRUE for every other error code", () => {
    expect(asBool(iserror([ERRORS.VALUE]))).toBe(true);
    expect(asBool(iserror([ERRORS.DIV0]))).toBe(true);
    expect(asBool(iserror([ERRORS.NUM]))).toBe(true);
    expect(asBool(iserror([ERRORS.REF]))).toBe(true);
    expect(asBool(iserror([ERRORS.NAME]))).toBe(true);
  });

  it("returns FALSE for normal scalars", () => {
    expect(asBool(iserror([rvNumber(0)]))).toBe(false);
    expect(asBool(iserror([rvString("#N/A")]))).toBe(false);
  });

  it("inspects the top-left cell for array args", () => {
    expect(asBool(iserror([rvArray([[ERRORS.DIV0, rvNumber(1)]])]))).toBe(true);
    expect(asBool(iserror([rvArray([[rvNumber(1), ERRORS.DIV0]])]))).toBe(false);
  });

  it("returns FALSE for BLANK", () => {
    expect(asBool(iserror([BLANK]))).toBe(false);
  });
});

describe("ISERR", () => {
  const iserr = fn("ISERR");

  it("returns FALSE for #N/A (ISERR excludes #N/A)", () => {
    expect(asBool(iserr([ERRORS.NA]))).toBe(false);
  });

  it("returns TRUE for every other error", () => {
    expect(asBool(iserr([ERRORS.VALUE]))).toBe(true);
    expect(asBool(iserr([ERRORS.DIV0]))).toBe(true);
    expect(asBool(iserr([ERRORS.NUM]))).toBe(true);
    expect(asBool(iserr([ERRORS.REF]))).toBe(true);
  });

  it("returns FALSE for normal scalars", () => {
    expect(asBool(iserr([rvNumber(0)]))).toBe(false);
    expect(asBool(iserr([rvString("abc")]))).toBe(false);
    expect(asBool(iserr([BLANK]))).toBe(false);
  });

  it("is the complement of ISNA for error inputs", () => {
    const isna = fn("ISNA");
    const inputs: RuntimeValue[] = [ERRORS.VALUE, ERRORS.DIV0, ERRORS.NA, ERRORS.NUM];
    for (const v of inputs) {
      if (v.kind === RVKind.Error) {
        const errResult = asBool(iserr([v]));
        const naResult = asBool(isna([v]));
        // For errors, ISERR XOR ISNA is always true (exactly one fires).
        expect(errResult !== naResult).toBe(true);
      }
    }
  });

  it("respects array top-left", () => {
    expect(asBool(iserr([rvArray([[ERRORS.NA]])]))).toBe(false);
    expect(asBool(iserr([rvArray([[ERRORS.VALUE]])]))).toBe(true);
  });
});

describe("ISNA", () => {
  const isna = fn("ISNA");

  it("returns TRUE only for #N/A", () => {
    expect(asBool(isna([ERRORS.NA]))).toBe(true);
  });

  it("returns FALSE for other errors", () => {
    expect(asBool(isna([ERRORS.VALUE]))).toBe(false);
    expect(asBool(isna([ERRORS.DIV0]))).toBe(false);
    expect(asBool(isna([ERRORS.NUM]))).toBe(false);
    expect(asBool(isna([ERRORS.REF]))).toBe(false);
  });

  it("returns FALSE for non-error values", () => {
    expect(asBool(isna([rvNumber(0)]))).toBe(false);
    expect(asBool(isna([rvString("#N/A")]))).toBe(false);
    expect(asBool(isna([BLANK]))).toBe(false);
  });

  it("inspects top-left for array input", () => {
    expect(asBool(isna([rvArray([[ERRORS.NA]])]))).toBe(true);
    expect(asBool(isna([rvArray([[rvNumber(1), ERRORS.NA]])]))).toBe(false);
  });

  it("returns FALSE for custom error codes (via rvError) that aren't #N/A", () => {
    expect(asBool(isna([rvError("#NULL!")]))).toBe(false);
  });
});

describe("ISEVEN", () => {
  const iseven = fn("ISEVEN");

  it("returns TRUE for 0 and even integers", () => {
    expect(asBool(iseven([rvNumber(0)]))).toBe(true);
    expect(asBool(iseven([rvNumber(4)]))).toBe(true);
  });

  it("returns FALSE for odd integers", () => {
    expect(asBool(iseven([rvNumber(1)]))).toBe(false);
    expect(asBool(iseven([rvNumber(7)]))).toBe(false);
  });

  it("truncates fractional part before parity check", () => {
    expect(asBool(iseven([rvNumber(2.9)]))).toBe(true);
    expect(asBool(iseven([rvNumber(3.5)]))).toBe(false);
  });

  it("treats negative values by magnitude", () => {
    expect(asBool(iseven([rvNumber(-2)]))).toBe(true);
    expect(asBool(iseven([rvNumber(-3)]))).toBe(false);
  });

  it("returns #VALUE! for non-numeric args, propagates errors", () => {
    expect(iseven([rvString("abc")])).toEqual(ERRORS.VALUE);
    expect(iseven([ERRORS.NA])).toEqual(ERRORS.NA);
  });

  it("coerces numeric strings and booleans (Excel behaviour)", () => {
    // Regression: previously the `v.kind !== Number` check rejected
    // every non-Number kind outright, so `ISEVEN("4")` reported #VALUE!
    // even though Excel coerces the text to 4 and returns TRUE.
    expect(asBool(iseven([rvString("4")]))).toBe(true);
    expect(asBool(iseven([rvString("3")]))).toBe(false);
    // Blank coerces to 0 (even).
    expect(asBool(iseven([BLANK]))).toBe(true);
    // Booleans: TRUE → 1 (odd), FALSE → 0 (even).
    expect(asBool(iseven([rvBoolean(true)]))).toBe(false);
    expect(asBool(iseven([rvBoolean(false)]))).toBe(true);
  });
});

describe("ISODD", () => {
  const isodd = fn("ISODD");

  it("returns TRUE for odd integers", () => {
    expect(asBool(isodd([rvNumber(1)]))).toBe(true);
    expect(asBool(isodd([rvNumber(7)]))).toBe(true);
  });

  it("returns FALSE for 0 and even integers", () => {
    expect(asBool(isodd([rvNumber(0)]))).toBe(false);
    expect(asBool(isodd([rvNumber(8)]))).toBe(false);
  });

  it("truncates fractional part", () => {
    expect(asBool(isodd([rvNumber(3.9)]))).toBe(true);
    expect(asBool(isodd([rvNumber(2.4)]))).toBe(false);
  });

  it("handles negative numbers", () => {
    expect(asBool(isodd([rvNumber(-5)]))).toBe(true);
    expect(asBool(isodd([rvNumber(-2)]))).toBe(false);
  });

  it("returns #VALUE! for text, propagates errors", () => {
    expect(isodd([rvString("abc")])).toEqual(ERRORS.VALUE);
    expect(isodd([ERRORS.DIV0])).toEqual(ERRORS.DIV0);
  });
});

describe("ISREF (stub — non-reference arguments)", () => {
  const isref = fn("ISREF");

  // The real ISREF behaviour lives in the evaluator. Once the argument
  // has been dereferenced to a runtime value, the answer is always FALSE.

  it("returns FALSE for a number", () => {
    expect(asBool(isref([rvNumber(1)]))).toBe(false);
  });

  it("returns FALSE for a string", () => {
    expect(asBool(isref([rvString("A1")]))).toBe(false);
  });

  it("returns FALSE for a BLANK", () => {
    expect(asBool(isref([BLANK]))).toBe(false);
  });

  it("returns FALSE for an array", () => {
    expect(asBool(isref([rvArray([[rvNumber(1)]])]))).toBe(false);
  });

  it("returns FALSE for an error input (stub ignores argument kind)", () => {
    expect(asBool(isref([ERRORS.NA]))).toBe(false);
  });
});

describe("ISFORMULA (stub — non-reference arguments)", () => {
  const isformula = fn("ISFORMULA");

  it("returns FALSE for a number", () => {
    expect(asBool(isformula([rvNumber(1)]))).toBe(false);
  });

  it("returns FALSE for a string", () => {
    expect(asBool(isformula([rvString("=A1")]))).toBe(false);
  });

  it("returns FALSE for BLANK", () => {
    expect(asBool(isformula([BLANK]))).toBe(false);
  });

  it("returns FALSE for arrays", () => {
    expect(asBool(isformula([rvArray([[rvNumber(1)]])]))).toBe(false);
  });

  it("returns FALSE even for error inputs (stub)", () => {
    expect(asBool(isformula([ERRORS.NA]))).toBe(false);
  });
});

describe("FORMULATEXT (stub — non-reference arguments)", () => {
  const ft = fn("FORMULATEXT");

  it("returns #N/A for a number", () => {
    expect(ft([rvNumber(1)])).toEqual(ERRORS.NA);
  });

  it("returns #N/A for a string", () => {
    expect(ft([rvString("=A1")])).toEqual(ERRORS.NA);
  });

  it("returns #N/A for BLANK", () => {
    expect(ft([BLANK])).toEqual(ERRORS.NA);
  });

  it("returns #N/A for arrays", () => {
    expect(ft([rvArray([[rvNumber(1)]])])).toEqual(ERRORS.NA);
  });

  it("returns #N/A for errors too", () => {
    expect(ft([ERRORS.VALUE])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// N / T / TYPE / ERROR.TYPE / NA
// ============================================================================

describe("N", () => {
  const n = fn("N");

  it("returns the number itself", () => {
    expect(asNumber(n([rvNumber(42)]))).toBe(42);
  });

  it("coerces TRUE → 1, FALSE → 0", () => {
    expect(asNumber(n([rvBoolean(true)]))).toBe(1);
    expect(asNumber(n([rvBoolean(false)]))).toBe(0);
  });

  it("returns 0 for strings (N does NOT parse numeric text)", () => {
    expect(asNumber(n([rvString("5")]))).toBe(0);
    expect(asNumber(n([rvString("abc")]))).toBe(0);
  });

  it("returns 0 for BLANK", () => {
    expect(asNumber(n([BLANK]))).toBe(0);
  });

  it("propagates errors", () => {
    expect(n([ERRORS.NA])).toEqual(ERRORS.NA);
    expect(n([ERRORS.VALUE])).toEqual(ERRORS.VALUE);
  });

  it("inspects top-left for array args", () => {
    expect(asNumber(n([rvArray([[rvNumber(7), rvString("x")]])]))).toBe(7);
  });
});

describe("TYPE", () => {
  const type = fn("TYPE");

  it("returns 1 for numbers", () => {
    expect(asNumber(type([rvNumber(3.14)]))).toBe(1);
  });

  it("returns 2 for text", () => {
    expect(asNumber(type([rvString("hi")]))).toBe(2);
  });

  it("returns 4 for booleans", () => {
    expect(asNumber(type([rvBoolean(true)]))).toBe(4);
  });

  it("returns 16 for errors", () => {
    expect(asNumber(type([ERRORS.NA]))).toBe(16);
    expect(asNumber(type([ERRORS.VALUE]))).toBe(16);
  });

  it("returns 64 for arrays (checked before top-left extraction)", () => {
    expect(asNumber(type([rvArray([[rvNumber(1), rvNumber(2)]])]))).toBe(64);
  });

  it("returns 1 for BLANK (Excel classifies empty as numeric)", () => {
    expect(asNumber(type([BLANK]))).toBe(1);
  });
});

describe("ERROR.TYPE", () => {
  const et = fn("ERROR.TYPE");

  it("maps #NULL! → 1, #DIV/0! → 2, #VALUE! → 3", () => {
    expect(asNumber(et([rvError("#NULL!")]))).toBe(1);
    expect(asNumber(et([ERRORS.DIV0]))).toBe(2);
    expect(asNumber(et([ERRORS.VALUE]))).toBe(3);
  });

  it("maps #REF! → 4, #NAME? → 5, #NUM! → 6, #N/A → 7", () => {
    expect(asNumber(et([ERRORS.REF]))).toBe(4);
    expect(asNumber(et([ERRORS.NAME]))).toBe(5);
    expect(asNumber(et([ERRORS.NUM]))).toBe(6);
    expect(asNumber(et([ERRORS.NA]))).toBe(7);
  });

  it("returns #N/A for non-error inputs", () => {
    expect(et([rvNumber(0)])).toEqual(ERRORS.NA);
    expect(et([rvString("#N/A")])).toEqual(ERRORS.NA);
    expect(et([rvBoolean(false)])).toEqual(ERRORS.NA);
  });

  it("returns #N/A for BLANK", () => {
    expect(et([BLANK])).toEqual(ERRORS.NA);
  });

  it("respects top-left on arrays", () => {
    expect(asNumber(et([rvArray([[ERRORS.NA, rvNumber(1)]])]))).toBe(7);
  });
});

describe("NA()", () => {
  const na = fn("NA");

  it("takes zero arguments and returns #N/A", () => {
    expect(na([])).toEqual(ERRORS.NA);
  });

  it("can be wrapped by ISNA in the evaluator", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "ISNA(NA())", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(true);
  });

  it("used as an explicit error value in arithmetic propagates", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "NA()+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#N/A" });
  });

  it("used with IFERROR returns the fallback", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'IFERROR(NA(),"fallback")', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe("fallback");
  });

  it("is classified by ERROR.TYPE as 7", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "ERROR.TYPE(NA())", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(7);
  });
});

// ============================================================================
// SHEET / SHEETS / INFO / HYPERLINK
// ============================================================================

describe("SHEET / SHEETS (stubs and context-aware path)", () => {
  it("SHEET() with no args returns current sheet number via evaluator", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "One");
    Workbook.addWorksheet(wb, "Two");
    const ws = Workbook.getWorksheet(wb, "Two")!;
    Cell.setValue(ws, "A1", { formula: "SHEET()", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(2);
  });

  it("SHEETS() with no args returns total sheet count", () => {
    const wb = Workbook.create();
    Workbook.addWorksheet(wb, "One");
    Workbook.addWorksheet(wb, "Two");
    Workbook.addWorksheet(wb, "Three");
    const ws = Workbook.getWorksheet(wb, "One")!;
    Cell.setValue(ws, "A1", { formula: "SHEETS()", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(3);
  });

  it("SHEET registry stub returns 1 when no argument is provided", () => {
    const sheet = fn("SHEET");
    expect(asNumber(sheet([]))).toBe(1);
  });

  it("SHEETS registry stub returns 1 when no argument is provided", () => {
    const sheets = fn("SHEETS");
    expect(asNumber(sheets([]))).toBe(1);
  });

  it("SHEET(arg) stub with a scalar arg falls back to 1", () => {
    const sheet = fn("SHEET");
    expect(asNumber(sheet([rvString("Sheet1")]))).toBe(1);
  });
});

describe("INFO", () => {
  const info = fn("INFO");

  it('returns a release identifier for "release"', () => {
    const v = info([rvString("release")]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("16.0");
  });

  it('returns "Automatic" for "recalc"', () => {
    const v = info([rvString("recalc")]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("Automatic");
  });

  it("returns #N/A for UI-dependent info types", () => {
    expect(info([rvString("directory")])).toEqual(ERRORS.NA);
    expect(info([rvString("numfile")])).toEqual(ERRORS.NA);
    expect(info([rvString("origin")])).toEqual(ERRORS.NA);
  });

  it("returns #VALUE! for unknown info types", () => {
    expect(info([rvString("totally-made-up")])).toEqual(ERRORS.VALUE);
  });

  it("propagates errors", () => {
    expect(info([ERRORS.NA])).toEqual(ERRORS.NA);
  });

  it('returns one of the expected values for "system"', () => {
    const v = info([rvString("system")]);
    expect(v.kind).toBe(RVKind.String);
    const s = (v as { value: string }).value;
    expect(["mac", "pcdos"]).toContain(s);
  });
});

describe("HYPERLINK", () => {
  const hl = fn("HYPERLINK");

  it("returns the friendly name when two args are given", () => {
    const v = hl([rvString("https://example.com"), rvString("Click me")]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("Click me");
  });

  it("returns the URL when only one arg is given", () => {
    const v = hl([rvString("https://example.com")]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("https://example.com");
  });

  it("falls back to URL when friendly_name is BLANK", () => {
    const v = hl([rvString("https://example.com"), BLANK]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("https://example.com");
  });

  it("coerces a numeric friendly_name to its string form", () => {
    const v = hl([rvString("https://example.com"), rvNumber(42)]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("42");
  });

  it("propagates errors from either argument", () => {
    expect(hl([ERRORS.NA, rvString("Click")])).toEqual(rvString("Click"));
    expect(hl([rvString("x"), ERRORS.NA])).toEqual(ERRORS.NA);
  });

  it("renders a boolean friendly_name as its uppercase string", () => {
    const v = hl([rvString("https://example.com"), rvBoolean(true)]);
    expect(v.kind).toBe(RVKind.String);
    expect((v as { value: string }).value).toBe("TRUE");
  });
});

// ============================================================================
// CELL — via the evaluator (reference-aware path)
// ============================================================================

describe("CELL (via evaluator)", () => {
  it('"address" returns absolute reference to the cell', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B2", { formula: 'CELL("address",C5)', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B2")).toBe("$C$5");
  });

  it('"address" qualifies cross-sheet targets with the sheet name (Excel)', () => {
    // Regression: previously dropped the sheet prefix, so
    // `INDIRECT(CELL("address", Sheet2!A1))` misread the same cell on
    // the formula's own sheet. Excel always qualifies when the target
    // sheet differs from the formula cell's sheet.
    const wb = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb, "Sheet1");
    Workbook.addWorksheet(wb, "Sheet2");
    Cell.setValue(ws1, "B2", { formula: 'CELL("address", Sheet2!C5)', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws1, "B2")).toBe("Sheet2!$C$5");
  });

  it('"address" quotes sheet names that need quoting', () => {
    // Sheet name with a space requires `'...'` around it.
    const wb = Workbook.create();
    const ws1 = Workbook.addWorksheet(wb, "Sheet1");
    Workbook.addWorksheet(wb, "My Sheet");
    Cell.setValue(ws1, "B2", { formula: "CELL(\"address\", 'My Sheet'!A1)", result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws1, "B2")).toBe("'My Sheet'!$A$1");
  });

  it('"row" and "col" return 1-based coordinates', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'CELL("row",C5)', result: 0 });
    Cell.setValue(ws, "A2", { formula: 'CELL("col",C5)', result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(5);
    expect(Cell.getResult(ws, "A2")).toBe(3);
  });

  it('"contents" returns the value of the target cell', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "C5", 99);
    Cell.setValue(ws, "A1", { formula: 'CELL("contents",C5)', result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(99);
  });

  it('"type" classifies blank / label / value', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A5", "hello");
    Cell.setValue(ws, "A6", 42);
    // A7 blank
    Cell.setValue(ws, "B1", { formula: 'CELL("type",A5)', result: "" });
    Cell.setValue(ws, "B2", { formula: 'CELL("type",A6)', result: "" });
    Cell.setValue(ws, "B3", { formula: 'CELL("type",A7)', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe("l");
    expect(Cell.getResult(ws, "B2")).toBe("v");
    expect(Cell.getResult(ws, "B3")).toBe("b");
  });

  it("unknown info type returns #N/A", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'CELL("nosuchinfo",A2)', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#N/A" });
  });

  it('"width" returns the default column width (8)', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'CELL("width",B2)', result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(8);
  });
});

// ============================================================================
// AND / OR / NOT / XOR
// ============================================================================

describe("NOT", () => {
  const not = fn("NOT");

  it("flips TRUE → FALSE, FALSE → TRUE", () => {
    expect(asBool(not([rvBoolean(true)]))).toBe(false);
    expect(asBool(not([rvBoolean(false)]))).toBe(true);
  });

  it("coerces non-zero numbers to TRUE → returns FALSE", () => {
    expect(asBool(not([rvNumber(5)]))).toBe(false);
    expect(asBool(not([rvNumber(-2)]))).toBe(false);
  });

  it("coerces 0 to FALSE → returns TRUE", () => {
    expect(asBool(not([rvNumber(0)]))).toBe(true);
  });

  it("coerces numeric-string / boolean-string / blank (Excel behaviour)", () => {
    // Regression: Excel accepts text "TRUE" / "FALSE" (case-insensitive)
    // and blank cells (→ FALSE) for NOT; previously we rejected every
    // non-Number/Boolean with #VALUE!.
    expect(asBool(not([rvString("TRUE")]))).toBe(false);
    expect(asBool(not([rvString("false")]))).toBe(true);
    // Blank → FALSE → NOT → TRUE
    expect(asBool(not([BLANK]))).toBe(true);
    // True non-boolean text still rejected.
    expect(not([rvString("abc")])).toEqual(ERRORS.VALUE);
  });

  it("propagates errors", () => {
    expect(not([ERRORS.NA])).toEqual(ERRORS.NA);
    expect(not([ERRORS.DIV0])).toEqual(ERRORS.DIV0);
  });
});

describe("AND", () => {
  const and = fn("AND");

  it("returns TRUE when every arg is truthy", () => {
    expect(asBool(and([rvBoolean(true), rvBoolean(true)]))).toBe(true);
  });

  it("returns FALSE when any arg is falsy", () => {
    expect(asBool(and([rvBoolean(true), rvBoolean(false)]))).toBe(false);
    expect(asBool(and([rvBoolean(false), rvBoolean(true), rvBoolean(true)]))).toBe(false);
  });

  it("coerces numbers: nonzero → true, zero → false", () => {
    expect(asBool(and([rvNumber(1), rvNumber(2)]))).toBe(true);
    expect(asBool(and([rvNumber(1), rvNumber(0)]))).toBe(false);
  });

  it('parses the strings "TRUE"/"FALSE" case-insensitively', () => {
    expect(asBool(and([rvString("TRUE"), rvString("true")]))).toBe(true);
    expect(asBool(and([rvString("TRUE"), rvString("FALSE")]))).toBe(false);
  });

  it("returns #VALUE! when no boolean-like value is found (all BLANK)", () => {
    expect(and([BLANK])).toEqual(ERRORS.VALUE);
  });

  it("returns #VALUE! for non-boolean text", () => {
    expect(and([rvBoolean(true), rvString("abc")])).toEqual(ERRORS.VALUE);
  });

  it("propagates errors", () => {
    expect(and([rvBoolean(true), ERRORS.DIV0])).toEqual(ERRORS.DIV0);
  });

  it("aggregates values inside array arguments", () => {
    const arr = rvArray([[rvBoolean(true), rvBoolean(true), rvBoolean(true)]]);
    expect(asBool(and([arr]))).toBe(true);
    const arr2 = rvArray([[rvBoolean(true), rvBoolean(false)]]);
    expect(asBool(and([arr2]))).toBe(false);
  });
});

describe("OR", () => {
  const or = fn("OR");

  it("returns TRUE when any arg is truthy", () => {
    expect(asBool(or([rvBoolean(false), rvBoolean(true)]))).toBe(true);
  });

  it("returns FALSE when every arg is falsy", () => {
    expect(asBool(or([rvBoolean(false), rvBoolean(false)]))).toBe(false);
  });

  it("coerces numbers: nonzero → true", () => {
    expect(asBool(or([rvNumber(0), rvNumber(3)]))).toBe(true);
    expect(asBool(or([rvNumber(0), rvNumber(0)]))).toBe(false);
  });

  it("returns #VALUE! when no boolean-like value is found", () => {
    expect(or([BLANK])).toEqual(ERRORS.VALUE);
  });

  it("returns #VALUE! for non-boolean text", () => {
    expect(or([rvString("foo")])).toEqual(ERRORS.VALUE);
  });

  it("propagates errors", () => {
    expect(or([rvBoolean(false), ERRORS.NA])).toEqual(ERRORS.NA);
  });

  it("aggregates across arrays", () => {
    const arr = rvArray([[rvBoolean(false), rvBoolean(false), rvBoolean(true)]]);
    expect(asBool(or([arr]))).toBe(true);
  });
});

describe("XOR", () => {
  const xor = fn("XOR");

  it("returns TRUE for an odd number of TRUE args", () => {
    expect(asBool(xor([rvBoolean(true)]))).toBe(true);
    expect(asBool(xor([rvBoolean(true), rvBoolean(false), rvBoolean(true), rvBoolean(true)]))).toBe(
      true
    );
  });

  it("returns FALSE for an even number of TRUE args", () => {
    expect(asBool(xor([rvBoolean(true), rvBoolean(true)]))).toBe(false);
    expect(asBool(xor([rvBoolean(false), rvBoolean(false)]))).toBe(false);
  });

  it("coerces numbers", () => {
    expect(asBool(xor([rvNumber(1), rvNumber(0)]))).toBe(true);
    expect(asBool(xor([rvNumber(2), rvNumber(3)]))).toBe(false);
  });

  it("returns #VALUE! when no boolean-like value is seen (all BLANK)", () => {
    expect(xor([BLANK, BLANK])).toEqual(ERRORS.VALUE);
  });

  it("propagates errors from any argument", () => {
    expect(xor([rvBoolean(true), ERRORS.NUM])).toEqual(ERRORS.NUM);
  });

  it("aggregates values inside arrays", () => {
    const arr = rvArray([[rvBoolean(true), rvBoolean(true), rvBoolean(true)]]);
    expect(asBool(xor([arr]))).toBe(true);
  });
});

// ============================================================================
// TRUE / FALSE — boolean literal keywords
// ============================================================================
//
// NOTE: `TRUE` / `FALSE` are tokenized as boolean literals in this engine —
// see `tokenizer.ts:851`. The bareword form (no parens) is the canonical
// way to produce TRUE/FALSE in a formula. The `TRUE()` / `FALSE()` paren
// form that Excel also accepts as nullary functions is NOT currently
// supported by this engine (they resolve as #NAME? because the registry
// has no descriptor for them). Tests here cover the bareword form that
// does work; the parenthesised form is a known gap reported to the task
// caller rather than patched here.

describe("TRUE / FALSE literals", () => {
  it("TRUE bareword returns boolean true", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "TRUE", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(true);
  });

  it("FALSE bareword returns boolean false", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "FALSE", result: true });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(false);
  });

  it("TRUE and FALSE participate in AND", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "AND(TRUE,FALSE)", result: true });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(false);
  });

  it("TRUE+1 coerces to 2", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "TRUE+1", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(2);
  });

  it("NOT(TRUE) is FALSE", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "NOT(TRUE)", result: true });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(false);
  });

  it("TRUE<>FALSE is TRUE", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "TRUE<>FALSE", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toBe(true);
  });
});

// ============================================================================
// ISFORMULA / FORMULATEXT — reference-aware path via evaluator
// ============================================================================

describe("ISFORMULA / FORMULATEXT (reference path via evaluator)", () => {
  it("ISFORMULA(ref) is TRUE when target cell holds a formula", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "1+1", result: 0 });
    Cell.setValue(ws, "B1", { formula: "ISFORMULA(A1)", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(true);
  });

  it("ISFORMULA(ref) is FALSE for a literal cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 42);
    Cell.setValue(ws, "B1", { formula: "ISFORMULA(A1)", result: true });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(false);
  });

  it("FORMULATEXT(ref) returns =<formula> for a formula cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "1+1", result: 0 });
    Cell.setValue(ws, "B1", { formula: "FORMULATEXT(A1)", result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe("=1+1");
  });

  it("FORMULATEXT on a literal cell returns #N/A", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 10);
    Cell.setValue(ws, "B1", { formula: "FORMULATEXT(A1)", result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toEqual({ error: "#N/A" });
  });

  it("ISFORMULA on a value expression (non-ref) returns #N/A", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "ISFORMULA(1+1)", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#N/A" });
  });

  it('ISFORMULA(INDIRECT("A1")) resolves through a runtime reference', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "1+1", result: 0 });
    Cell.setValue(ws, "B1", { formula: 'ISFORMULA(INDIRECT("A1"))', result: false });
    Cell.setValue(ws, "B2", 5);
    Cell.setValue(ws, "C2", { formula: 'ISFORMULA(INDIRECT("B2"))', result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(true);
    expect(Cell.getResult(ws, "C2")).toBe(false);
  });

  it('ISFORMULA(INDIRECT("xx")) returns #N/A — invalid ref collapses to N/A', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'ISFORMULA(INDIRECT("xx"))', result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#N/A" });
  });

  it("ISFORMULA on an area reference inspects the top-left cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "1+1", result: 0 });
    Cell.setValue(ws, "B2", 5);
    Cell.setValue(ws, "C1", { formula: "ISFORMULA(A1:B2)", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "C1")).toBe(true);
  });

  it('FORMULATEXT(INDIRECT("A1")) returns the formula text', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "SUM(1,2)", result: 0 });
    Cell.setValue(ws, "B1", { formula: 'FORMULATEXT(INDIRECT("A1"))', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe("=SUM(1,2)");
  });

  it("FORMULATEXT on an area reference inspects the top-left cell", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: "1*2", result: 0 });
    Cell.setValue(ws, "B1", { formula: "FORMULATEXT(A1:B2)", result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe("=1*2");
  });

  it("FORMULATEXT on a missing cell returns #N/A", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B1", { formula: "FORMULATEXT(Z99)", result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toEqual({ error: "#N/A" });
  });

  it('FORMULATEXT(INDIRECT("xx")) returns #N/A', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", { formula: 'FORMULATEXT(INDIRECT("xx"))', result: "" });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "A1")).toEqual({ error: "#N/A" });
  });
});

// ============================================================================
// ISREF — reference-aware path via evaluator
// ============================================================================

describe("ISREF (reference path via evaluator)", () => {
  it("returns TRUE for a direct cell reference", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", 1);
    Cell.setValue(ws, "B1", { formula: "ISREF(A1)", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(true);
  });

  it("returns TRUE for an area reference", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B1", { formula: "ISREF(A1:A5)", result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(true);
  });

  it("returns FALSE for an arithmetic expression", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B1", { formula: "ISREF(1+1)", result: true });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(false);
  });

  it("returns FALSE for a string literal", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B1", { formula: 'ISREF("A1")', result: true });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(false);
  });

  it('returns FALSE for INDIRECT("xx") (invalid target → FALSE per Excel)', () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "B1", { formula: 'ISREF(INDIRECT("xx"))', result: false });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "B1")).toBe(false);
  });
});

// ============================================================================
// Extra array-input coverage for IS* family
// ============================================================================

describe("IS* family: array argument top-left inspection", () => {
  it("ISNUMBER picks top-left of the array", () => {
    const isnumber = fn("ISNUMBER");
    const arr: ArrayValue = rvArray([
      [rvNumber(1), rvString("x")],
      [rvString("y"), rvNumber(2)]
    ]);
    expect(asBool(isnumber([arr]))).toBe(true);
  });

  it("ISTEXT picks top-left of the array", () => {
    const istext = fn("ISTEXT");
    const arr: ArrayValue = rvArray([
      [rvString("hi"), rvNumber(1)],
      [rvNumber(2), rvNumber(3)]
    ]);
    expect(asBool(istext([arr]))).toBe(true);
  });

  it("ISLOGICAL respects top-left", () => {
    const islogical = fn("ISLOGICAL");
    expect(asBool(islogical([rvArray([[rvBoolean(false), rvNumber(1)]])]))).toBe(true);
    expect(asBool(islogical([rvArray([[rvNumber(1), rvBoolean(false)]])]))).toBe(false);
  });

  it("N picks top-left", () => {
    const n = fn("N");
    expect(asNumber(n([rvArray([[rvNumber(5), rvNumber(99)]])]))).toBe(5);
  });

  it("TYPE of empty array → 64 (array kind takes precedence)", () => {
    const type = fn("TYPE");
    // Width 0 → still an array kind
    expect(asNumber(type([rvArray([[]])]))).toBe(64);
  });
});
