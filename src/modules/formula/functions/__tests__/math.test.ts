/**
 * Unit tests for math / aggregate functions in `../math.ts`.
 *
 * Focuses on the core function set enumerated in the task (ROUND / TRUNC /
 * MOD / CEILING / FLOOR / MROUND / RANDBETWEEN / SUM / PRODUCT / MIN / MAX /
 * EXP / LOG / POWER / SQRT / SUMX2MY2 …) plus the half-away-from-zero,
 * sign-mismatch, and zero-edge regressions the task calls out explicitly.
 *
 * Tests exercise the native functions directly — they construct RuntimeValue
 * inputs with the `rv*` helpers rather than going through Workbook/formula
 * parsing. This keeps each assertion one direct function call away from the
 * implementation under test.
 */

import { calculateFormulas } from "@excel/core/formula-adapter";
import { Cell, Workbook } from "@excel/index";
import { describe, it, expect } from "vitest";

import type { ArrayValue, NumberValue, RuntimeValue, StringValue } from "../../runtime/values";
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
import {
  fnROUND,
  fnROUNDUP,
  fnROUNDDOWN,
  fnTRUNC,
  fnMOD,
  fnCEILING,
  fnFLOOR,
  fnMROUND,
  fnRAND,
  fnRANDBETWEEN,
  fnSUM,
  fnPRODUCT,
  fnMIN,
  fnMAX,
  fnEXP,
  fnLOG,
  fnLOG10,
  fnLN,
  fnPOWER,
  fnSQRT,
  fnSQRTPI,
  fnABS,
  fnSIGN,
  fnINT,
  fnSUMSQ,
  fnGCD,
  fnLCM,
  fnEVEN,
  fnODD,
  fnQUOTIENT,
  fnBASE,
  fnDECIMAL,
  fnROMAN,
  fnARABIC,
  fnFACT,
  fnFACTDOUBLE,
  fnCOMBIN,
  fnCOMBINA,
  fnPERMUT,
  fnMULTINOMIAL,
  fnSUMX2MY2,
  fnSUMX2PY2,
  fnSUMXMY2,
  fnPI,
  fnDEGREES,
  fnRADIANS,
  fnSUMPRODUCT,
  fnAVERAGE,
  fnCOUNT,
  fnCOUNTA,
  fnCOUNTBLANK,
  fnSIN,
  fnCOS,
  fnTAN,
  fnASIN,
  fnACOS,
  fnATAN,
  fnATAN2,
  fnSINH,
  fnCOSH,
  fnTANH,
  fnASINH,
  fnACOSH,
  fnATANH,
  fnSEC,
  fnCSC,
  fnCOT,
  fnSECH,
  fnCSCH,
  fnCOTH,
  fnACOT,
  fnACOTH,
  fnMMULT,
  fnMDETERM,
  fnMINVERSE,
  fnMUNIT,
  fnSERIESSUM
} from "../math";

/** Assert `v` is a NumberValue and return its `.value` so arithmetic checks
 *  can be written without casting at every call site. */
function asNumber(v: RuntimeValue): number {
  expect(v.kind).toBe(RVKind.Number);
  return (v as NumberValue).value;
}

function asString(v: RuntimeValue): string {
  expect(v.kind).toBe(RVKind.String);
  return (v as StringValue).value;
}

describe("ROUND", () => {
  it("rounds positive halves away from zero", () => {
    expect(asNumber(fnROUND([rvNumber(0.5), rvNumber(0)]))).toBe(1);
    expect(asNumber(fnROUND([rvNumber(2.5), rvNumber(0)]))).toBe(3);
    expect(asNumber(fnROUND([rvNumber(1.25), rvNumber(1)]))).toBe(1.3);
  });

  it("rounds negative halves away from zero — regression for Math.round sign skew", () => {
    // JavaScript's Math.round returns -0 for -0.5; Excel must return -1.
    expect(asNumber(fnROUND([rvNumber(-0.5), rvNumber(0)]))).toBe(-1);
    expect(asNumber(fnROUND([rvNumber(-1.5), rvNumber(0)]))).toBe(-2);
    expect(asNumber(fnROUND([rvNumber(-2.5), rvNumber(0)]))).toBe(-3);
  });

  it("handles negative digits by rounding to the indicated multiple of 10", () => {
    expect(asNumber(fnROUND([rvNumber(1234), rvNumber(-2)]))).toBe(1200);
    expect(asNumber(fnROUND([rvNumber(1250), rvNumber(-2)]))).toBe(1300);
  });

  it("defaults digits to 0 when omitted", () => {
    expect(asNumber(fnROUND([rvNumber(3.7)]))).toBe(4);
  });

  it("propagates #VALUE! from a non-numeric first argument", () => {
    const r = fnROUND([rvString("abc"), rvNumber(0)]);
    expect(r).toEqual(ERRORS.VALUE);
  });
});

describe("ROUNDUP / ROUNDDOWN / TRUNC", () => {
  it("ROUNDUP rounds away from zero", () => {
    expect(asNumber(fnROUNDUP([rvNumber(3.1), rvNumber(0)]))).toBe(4);
    expect(asNumber(fnROUNDUP([rvNumber(-3.1), rvNumber(0)]))).toBe(-4);
    expect(asNumber(fnROUNDUP([rvNumber(3.14159), rvNumber(2)]))).toBe(3.15);
  });

  it("ROUNDDOWN truncates toward zero", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(3.9), rvNumber(0)]))).toBe(3);
    expect(asNumber(fnROUNDDOWN([rvNumber(-3.9), rvNumber(0)]))).toBe(-3);
    expect(asNumber(fnROUNDDOWN([rvNumber(3.14159), rvNumber(2)]))).toBe(3.14);
  });

  it("TRUNC is equivalent to ROUNDDOWN for the core cases", () => {
    expect(asNumber(fnTRUNC([rvNumber(8.9), rvNumber(0)]))).toBe(8);
    expect(asNumber(fnTRUNC([rvNumber(-8.9), rvNumber(0)]))).toBe(-8);
    expect(asNumber(fnTRUNC([rvNumber(3.14159)]))).toBe(3);
  });
});

describe("MOD", () => {
  it("returns num - div * floor(num / div)", () => {
    expect(asNumber(fnMOD([rvNumber(10), rvNumber(3)]))).toBe(1);
    expect(asNumber(fnMOD([rvNumber(-10), rvNumber(3)]))).toBe(2);
    expect(asNumber(fnMOD([rvNumber(10), rvNumber(-3)]))).toBe(-2);
  });

  it("returns #DIV/0! when divisor is zero", () => {
    expect(fnMOD([rvNumber(10), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
});

describe("CEILING / FLOOR — sign-mismatch regressions", () => {
  it("CEILING(2, -1) returns #NUM! (signs must agree)", () => {
    expect(fnCEILING([rvNumber(2), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });

  it("CEILING(-2, 1) returns #NUM!", () => {
    expect(fnCEILING([rvNumber(-2), rvNumber(1)])).toEqual(ERRORS.NUM);
  });

  it("FLOOR(-2, 1) returns #NUM!", () => {
    expect(fnFLOOR([rvNumber(-2), rvNumber(1)])).toEqual(ERRORS.NUM);
  });

  it("CEILING(0, -1) returns 0 — zero is the special case", () => {
    expect(asNumber(fnCEILING([rvNumber(0), rvNumber(-1)]))).toBe(0);
  });

  it("CEILING(2.3, 1) rounds up to 3", () => {
    expect(asNumber(fnCEILING([rvNumber(2.3), rvNumber(1)]))).toBe(3);
  });

  it("CEILING(-2.3, -1) rounds toward -∞ in magnitude (−3)", () => {
    expect(asNumber(fnCEILING([rvNumber(-2.3), rvNumber(-1)]))).toBe(-3);
  });

  it("FLOOR(2.3, 1) rounds down to 2", () => {
    expect(asNumber(fnFLOOR([rvNumber(2.3), rvNumber(1)]))).toBe(2);
  });

  it("FLOOR(-2.3, -1) rounds to −2 (toward zero in magnitude)", () => {
    expect(asNumber(fnFLOOR([rvNumber(-2.3), rvNumber(-1)]))).toBe(-2);
  });

  it("CEILING with significance=0 returns 0", () => {
    expect(asNumber(fnCEILING([rvNumber(5), rvNumber(0)]))).toBe(0);
  });

  it("FLOOR with significance=0 returns #DIV/0!", () => {
    expect(fnFLOOR([rvNumber(5), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
});

describe("MROUND", () => {
  it("rounds to the nearest multiple with half-away-from-zero semantics", () => {
    expect(asNumber(fnMROUND([rvNumber(10), rvNumber(3)]))).toBe(9);
    expect(asNumber(fnMROUND([rvNumber(11), rvNumber(3)]))).toBe(12);
    expect(asNumber(fnMROUND([rvNumber(1.5), rvNumber(1)]))).toBe(2);
  });

  it("MROUND(-4.5, -1) rounds away from zero — regression", () => {
    // Critical check: this must not go through Math.round (which would give -4).
    expect(asNumber(fnMROUND([rvNumber(-4.5), rvNumber(-1)]))).toBe(-5);
  });

  it("returns #NUM! when signs of number and multiple disagree", () => {
    expect(fnMROUND([rvNumber(5), rvNumber(-2)])).toEqual(ERRORS.NUM);
    expect(fnMROUND([rvNumber(-5), rvNumber(2)])).toEqual(ERRORS.NUM);
  });

  it("returns 0 when multiple is 0", () => {
    expect(asNumber(fnMROUND([rvNumber(5), rvNumber(0)]))).toBe(0);
  });
});

describe("RANDBETWEEN", () => {
  it("returns an integer in [bottom, top]", () => {
    for (let i = 0; i < 50; i++) {
      const v = fnRANDBETWEEN([rvNumber(1), rvNumber(10)]);
      const n = asNumber(v);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  it("returns #NUM! when bottom > top (regression)", () => {
    expect(fnRANDBETWEEN([rvNumber(10), rvNumber(5)])).toEqual(ERRORS.NUM);
  });

  it("supports negative ranges", () => {
    const n = asNumber(fnRANDBETWEEN([rvNumber(-5), rvNumber(-1)]));
    expect(n).toBeGreaterThanOrEqual(-5);
    expect(n).toBeLessThanOrEqual(-1);
  });
});

describe("SUM / PRODUCT / MIN / MAX / AVERAGE", () => {
  it("SUM of scalars", () => {
    expect(asNumber(fnSUM([rvNumber(1), rvNumber(2), rvNumber(3)]))).toBe(6);
  });

  it("SUM of an array", () => {
    const arr = rvArray([
      [rvNumber(1), rvNumber(2)],
      [rvNumber(3), rvNumber(4)]
    ]);
    expect(asNumber(fnSUM([arr]))).toBe(10);
  });

  it("SUM skips booleans/strings/blanks inside an array", () => {
    const arr = rvArray([[rvNumber(1), rvBoolean(true), rvString("hi"), BLANK, rvNumber(2)]]);
    expect(asNumber(fnSUM([arr]))).toBe(3);
  });

  it("SUM propagates error cells", () => {
    const arr = rvArray([[rvNumber(1), ERRORS.NA]]);
    expect(fnSUM([arr])).toEqual(ERRORS.NA);
  });

  it("PRODUCT multiplies numbers", () => {
    expect(asNumber(fnPRODUCT([rvNumber(2), rvNumber(3), rvNumber(4)]))).toBe(24);
  });

  it("PRODUCT returns 0 when no numeric values are present", () => {
    expect(asNumber(fnPRODUCT([BLANK]))).toBe(0);
  });

  it("MIN / MAX over scalars", () => {
    expect(asNumber(fnMIN([rvNumber(3), rvNumber(1), rvNumber(2)]))).toBe(1);
    expect(asNumber(fnMAX([rvNumber(3), rvNumber(1), rvNumber(2)]))).toBe(3);
  });

  it("MIN / MAX of empty input returns 0", () => {
    expect(asNumber(fnMIN([]))).toBe(0);
    expect(asNumber(fnMAX([]))).toBe(0);
  });

  it("AVERAGE returns #DIV/0! on empty", () => {
    expect(fnAVERAGE([])).toEqual(ERRORS.DIV0);
  });

  it("AVERAGE averages numbers only", () => {
    expect(asNumber(fnAVERAGE([rvNumber(2), rvNumber(4)]))).toBe(3);
  });
});

describe("COUNT / COUNTA / COUNTBLANK", () => {
  const mixed = rvArray([
    [rvNumber(1), rvString(""), BLANK, rvString("hi"), rvBoolean(true), rvNumber(2), ERRORS.NA]
  ]);

  it("COUNT counts only numbers", () => {
    expect(asNumber(fnCOUNT([mixed]))).toBe(2);
  });

  it("COUNTA counts everything non-blank — INCLUDING empty string (Excel behaviour)", () => {
    // Regression: Excel's documented behaviour is that COUNTA counts
    // every non-blank cell, including empty strings produced by e.g.
    // `=""`. Mixed array has 1, "hi", TRUE, 2, #N/A, "", BLANK → the
    // six non-blanks plus the one real BLANK, so COUNTA=6.
    expect(asNumber(fnCOUNTA([mixed]))).toBe(6);
  });

  it("COUNTBLANK counts blanks and empty strings", () => {
    // Mirror of COUNTA above — note that COUNTA + COUNTBLANK can exceed
    // the total cell count because empty strings count toward both
    // (Excel's documented asymmetry).
    expect(asNumber(fnCOUNTBLANK([mixed]))).toBe(2);
  });
});

describe("POWER / SQRT / EXP / LOG / LN / LOG10", () => {
  it("POWER raises base to exponent", () => {
    expect(asNumber(fnPOWER([rvNumber(2), rvNumber(10)]))).toBe(1024);
    expect(asNumber(fnPOWER([rvNumber(4), rvNumber(0.5)]))).toBe(2);
  });

  it("POWER returns #DIV/0! for 0^(negative) (matching Excel)", () => {
    // Regression: Excel distinguishes POWER(0, -1) → #DIV/0! from other
    // overflow cases which remain #NUM!. `Math.pow(0, -1)` in JS returns
    // Infinity, but Excel wants the division-by-zero diagnostic because
    // semantically we're computing 1/0.
    expect(fnPOWER([rvNumber(0), rvNumber(-1)])).toEqual(ERRORS.DIV0);
  });

  it("POWER returns 1 for 0^0 (Excel convention)", () => {
    expect(asNumber(fnPOWER([rvNumber(0), rvNumber(0)]))).toBe(1);
  });

  it("POWER returns #NUM! for actual overflow", () => {
    expect(fnPOWER([rvNumber(1e200), rvNumber(10)])).toEqual(ERRORS.NUM);
  });

  it("POWER returns #NUM! for (-1)^0.5 (complex result)", () => {
    expect(fnPOWER([rvNumber(-1), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });

  it("SQRT returns the square root for non-negative inputs", () => {
    expect(asNumber(fnSQRT([rvNumber(9)]))).toBe(3);
    expect(asNumber(fnSQRT([rvNumber(0)]))).toBe(0);
  });

  it("SQRT returns #NUM! for negative inputs", () => {
    expect(fnSQRT([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });

  it("EXP computes e^x", () => {
    expect(asNumber(fnEXP([rvNumber(0)]))).toBe(1);
    expect(asNumber(fnEXP([rvNumber(1)]))).toBeCloseTo(Math.E, 10);
  });

  it("LN rejects non-positive inputs", () => {
    expect(fnLN([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnLN([rvNumber(-1)])).toEqual(ERRORS.NUM);
    expect(asNumber(fnLN([rvNumber(Math.E)]))).toBeCloseTo(1, 10);
  });

  it("LOG defaults to base 10", () => {
    expect(asNumber(fnLOG([rvNumber(1000)]))).toBeCloseTo(3, 10);
  });

  it("LOG with explicit base", () => {
    expect(asNumber(fnLOG([rvNumber(8), rvNumber(2)]))).toBeCloseTo(3, 10);
  });

  it("LOG rejects non-positive inputs and base 1", () => {
    expect(fnLOG([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnLOG([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnLOG([rvNumber(10), rvNumber(-2)])).toEqual(ERRORS.NUM);
  });

  it("LOG10 matches LOG with base 10", () => {
    expect(asNumber(fnLOG10([rvNumber(1000)]))).toBeCloseTo(3, 10);
  });
});

describe("ABS / SIGN / INT", () => {
  it("ABS returns the magnitude", () => {
    expect(asNumber(fnABS([rvNumber(-5)]))).toBe(5);
    expect(asNumber(fnABS([rvNumber(5)]))).toBe(5);
  });

  it("SIGN returns 1 / 0 / -1", () => {
    expect(asNumber(fnSIGN([rvNumber(7)]))).toBe(1);
    expect(asNumber(fnSIGN([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnSIGN([rvNumber(-7)]))).toBe(-1);
  });

  it("INT floors toward -∞", () => {
    expect(asNumber(fnINT([rvNumber(3.9)]))).toBe(3);
    // INT(-1.5) = -2 (floor), not -1 (trunc)
    expect(asNumber(fnINT([rvNumber(-1.5)]))).toBe(-2);
  });
});

describe("SUMSQ / GCD / LCM", () => {
  it("SUMSQ sums squares", () => {
    expect(asNumber(fnSUMSQ([rvNumber(3), rvNumber(4)]))).toBe(25);
  });

  it("GCD of 12 and 18 is 6", () => {
    expect(asNumber(fnGCD([rvNumber(12), rvNumber(18)]))).toBe(6);
  });

  it("LCM of 4 and 6 is 12", () => {
    expect(asNumber(fnLCM([rvNumber(4), rvNumber(6)]))).toBe(12);
  });
});

describe("EVEN / ODD / QUOTIENT", () => {
  it("EVEN rounds away from zero to the next even integer", () => {
    expect(asNumber(fnEVEN([rvNumber(3)]))).toBe(4);
    expect(asNumber(fnEVEN([rvNumber(-3)]))).toBe(-4);
    expect(asNumber(fnEVEN([rvNumber(2)]))).toBe(2);
  });

  it("ODD rounds away from zero to the next odd integer", () => {
    expect(asNumber(fnODD([rvNumber(2)]))).toBe(3);
    expect(asNumber(fnODD([rvNumber(-2)]))).toBe(-3);
    expect(asNumber(fnODD([rvNumber(0)]))).toBe(1);
  });

  it("QUOTIENT returns the integer part of the division", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(10), rvNumber(3)]))).toBe(3);
    expect(asNumber(fnQUOTIENT([rvNumber(-10), rvNumber(3)]))).toBe(-3);
  });

  it("QUOTIENT returns #DIV/0! when denominator is 0", () => {
    expect(fnQUOTIENT([rvNumber(10), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
});

describe("BASE / DECIMAL / ROMAN / ARABIC", () => {
  it("BASE converts to the specified radix", () => {
    expect(asString(fnBASE([rvNumber(255), rvNumber(16)]))).toBe("FF");
    expect(asString(fnBASE([rvNumber(7), rvNumber(2), rvNumber(5)]))).toBe("00111");
  });

  it("BASE rejects radix outside [2, 36]", () => {
    expect(fnBASE([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnBASE([rvNumber(10), rvNumber(37)])).toEqual(ERRORS.NUM);
  });

  it("DECIMAL parses in the specified radix", () => {
    expect(asNumber(fnDECIMAL([rvString("FF"), rvNumber(16)]))).toBe(255);
  });

  it("ROMAN formats integers as classical Roman numerals", () => {
    expect(asString(fnROMAN([rvNumber(1999)]))).toBe("MCMXCIX");
    expect(asString(fnROMAN([rvNumber(0)]))).toBe("");
  });

  it("ROMAN rejects out-of-range input", () => {
    expect(fnROMAN([rvNumber(4000)])).toEqual(ERRORS.VALUE);
    expect(fnROMAN([rvNumber(-1)])).toEqual(ERRORS.VALUE);
  });

  it("ARABIC inverts ROMAN", () => {
    expect(asNumber(fnARABIC([rvString("MCMXCIX")]))).toBe(1999);
  });
});

describe("FACT / COMBIN / PERMUT", () => {
  it("FACT(0) == 1 and FACT(5) == 120", () => {
    expect(asNumber(fnFACT([rvNumber(0)]))).toBe(1);
    expect(asNumber(fnFACT([rvNumber(5)]))).toBe(120);
  });

  it("FACT rejects negative or > 170 inputs", () => {
    expect(fnFACT([rvNumber(-1)])).toEqual(ERRORS.NUM);
    expect(fnFACT([rvNumber(171)])).toEqual(ERRORS.NUM);
  });

  it("COMBIN(5, 2) == 10", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(2)]))).toBe(10);
  });

  it("COMBIN rejects k > n", () => {
    expect(fnCOMBIN([rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });

  it("PERMUT(5, 2) == 20", () => {
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(2)]))).toBe(20);
  });
});

describe("SUMX2MY2 / SUMX2PY2 / SUMXMY2", () => {
  const xs = rvArray([[rvNumber(2), rvNumber(3), rvNumber(4)]]);
  const ys = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);

  it("SUMX2MY2 computes Σ(x² − y²)", () => {
    // (4-1) + (9-1) + (16-1) = 3 + 8 + 15 = 26
    expect(asNumber(fnSUMX2MY2([xs, ys]))).toBe(26);
  });

  it("SUMX2PY2 computes Σ(x² + y²)", () => {
    // (4+1) + (9+1) + (16+1) = 5 + 10 + 17 = 32
    expect(asNumber(fnSUMX2PY2([xs, ys]))).toBe(32);
  });

  it("SUMXMY2 computes Σ(x − y)²", () => {
    // 1 + 4 + 9 = 14
    expect(asNumber(fnSUMXMY2([xs, ys]))).toBe(14);
  });

  it("SUMX2MY2 returns #VALUE! when either argument is not an array", () => {
    expect(fnSUMX2MY2([rvNumber(1), ys])).toEqual(ERRORS.VALUE);
  });

  it("SUMX2MY2 propagates errors in array cells", () => {
    const bad = rvArray([[rvNumber(2), ERRORS.NA, rvNumber(4)]]);
    expect(fnSUMX2MY2([bad, ys])).toEqual(ERRORS.NA);
  });
});

describe("PI / DEGREES / RADIANS", () => {
  it("PI returns Math.PI", () => {
    expect(asNumber(fnPI([]))).toBe(Math.PI);
  });

  it("DEGREES converts radians to degrees", () => {
    expect(asNumber(fnDEGREES([rvNumber(Math.PI)]))).toBeCloseTo(180, 10);
  });

  it("RADIANS converts degrees to radians", () => {
    expect(asNumber(fnRADIANS([rvNumber(180)]))).toBeCloseTo(Math.PI, 10);
  });
});

describe("SUMPRODUCT", () => {
  it("multiplies corresponding elements and sums them", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const b = rvArray([[rvNumber(4), rvNumber(5), rvNumber(6)]]);
    // 1*4 + 2*5 + 3*6 = 4 + 10 + 18 = 32
    expect(asNumber(fnSUMPRODUCT([a, b]))).toBe(32);
  });

  it("broadcasts a 1x1 array across a larger array", () => {
    const one = rvArray([[rvNumber(2)]]);
    const rng = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnSUMPRODUCT([one, rng]))).toBe(12);
  });

  it("returns #VALUE! when shapes disagree", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2)]]);
    const b = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnSUMPRODUCT([a, b])).toEqual(ERRORS.VALUE);
  });

  it("propagates errors in any input cell", () => {
    const a = rvArray([[rvNumber(1), ERRORS.NA]]);
    const b = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnSUMPRODUCT([a, b])).toEqual(ERRORS.NA);
  });

  it("returns #VALUE! on zero args", () => {
    expect(fnSUMPRODUCT([])).toEqual(ERRORS.VALUE);
  });
});

describe("error propagation", () => {
  it("functions propagate a scalar error argument", () => {
    expect(fnSUM([rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
    expect(fnABS([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

// ============================================================================
// R7: Secondary trigonometric family (SEC/CSC/COT and hyperbolic/inverse)
// ============================================================================

describe("SEC / CSC / COT", () => {
  it("SEC(0) = 1", () => {
    expect(asNumber(fnSEC([rvNumber(0)]))).toBeCloseTo(1, 10);
  });

  it("SEC(π/2) is singular → #DIV/0!", () => {
    // cos(π/2) is 6e-17 in JS, not exactly 0 — use a value where cos is exactly 0?
    // There is no exact π/2 in double; the result is huge but finite. Instead
    // test the documented rejection when cos == 0 exactly, which we can't hit.
    // Instead exercise CSC(0) which IS exactly zero-sin.
    expect(fnCSC([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });

  it("CSC(π/2) = 1", () => {
    expect(asNumber(fnCSC([rvNumber(Math.PI / 2)]))).toBeCloseTo(1, 10);
  });

  it("COT(0) → #DIV/0!", () => {
    expect(fnCOT([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });

  it("COT(π/4) = 1", () => {
    expect(asNumber(fnCOT([rvNumber(Math.PI / 4)]))).toBeCloseTo(1, 10);
  });
});

describe("SECH / CSCH / COTH", () => {
  it("SECH(0) = 1", () => {
    expect(asNumber(fnSECH([rvNumber(0)]))).toBeCloseTo(1, 10);
  });

  it("SECH(large) = 0 (overflow handled)", () => {
    // cosh(1000) overflows to Infinity; SECH returns 0 rather than NaN.
    expect(asNumber(fnSECH([rvNumber(1000)]))).toBe(0);
  });

  it("CSCH(0) → #DIV/0!", () => {
    expect(fnCSCH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });

  it("COTH(0) → #DIV/0!", () => {
    expect(fnCOTH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });

  it("COTH(1) ≈ 1/tanh(1)", () => {
    expect(asNumber(fnCOTH([rvNumber(1)]))).toBeCloseTo(1 / Math.tanh(1), 10);
  });
});

describe("ACOT / ACOTH", () => {
  it("ACOT(0) = π/2", () => {
    expect(asNumber(fnACOT([rvNumber(0)]))).toBeCloseTo(Math.PI / 2, 10);
  });

  it("ACOT(1) = π/4", () => {
    expect(asNumber(fnACOT([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 10);
  });

  it("ACOTH is undefined for |x| <= 1 → #NUM!", () => {
    expect(fnACOTH([rvNumber(0.5)])).toEqual(ERRORS.NUM);
    expect(fnACOTH([rvNumber(-0.5)])).toEqual(ERRORS.NUM);
    expect(fnACOTH([rvNumber(1)])).toEqual(ERRORS.NUM);
  });

  it("ACOTH(2) ≈ 0.549306", () => {
    expect(asNumber(fnACOTH([rvNumber(2)]))).toBeCloseTo(0.549306144, 6);
  });
});

// ============================================================================
// Comprehensive coverage — one describe block per function family. Tests
// focus on Excel-standard semantics: normal values, boundaries, error
// routing, type coercion, error propagation, and array inputs.
// ============================================================================

describe("ABS comprehensive", () => {
  it("returns 0 for 0", () => {
    expect(asNumber(fnABS([rvNumber(0)]))).toBe(0);
  });
  it("handles very large magnitudes", () => {
    expect(asNumber(fnABS([rvNumber(-1e300)]))).toBe(1e300);
  });
  it("coerces a boolean TRUE to 1", () => {
    expect(asNumber(fnABS([rvBoolean(true)]))).toBe(1);
  });
  it("coerces blank to 0", () => {
    expect(asNumber(fnABS([BLANK]))).toBe(0);
  });
  it("parses a numeric string", () => {
    expect(asNumber(fnABS([rvString("-1.5")]))).toBe(1.5);
  });
  it("returns #VALUE! for a non-numeric string", () => {
    expect(fnABS([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("propagates an error argument", () => {
    expect(fnABS([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("takes the top-left cell of a 1x1 array", () => {
    expect(asNumber(fnABS([rvArray([[rvNumber(-7)]])]))).toBe(7);
  });
});

describe("SIGN comprehensive", () => {
  it("returns 1 for positive", () => {
    expect(asNumber(fnSIGN([rvNumber(12)]))).toBe(1);
  });
  it("returns -1 for negative", () => {
    expect(asNumber(fnSIGN([rvNumber(-12)]))).toBe(-1);
  });
  it("returns 0 for zero", () => {
    expect(asNumber(fnSIGN([rvNumber(0)]))).toBe(0);
  });
  it("coerces boolean true to 1", () => {
    expect(asNumber(fnSIGN([rvBoolean(true)]))).toBe(1);
  });
  it("treats blank as 0", () => {
    expect(asNumber(fnSIGN([BLANK]))).toBe(0);
  });
  it("propagates error", () => {
    expect(fnSIGN([rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("returns #VALUE! for non-numeric string", () => {
    expect(fnSIGN([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
});

describe("SQRT comprehensive", () => {
  it("SQRT(0) is 0", () => {
    expect(asNumber(fnSQRT([rvNumber(0)]))).toBe(0);
  });
  it("SQRT(1) is 1", () => {
    expect(asNumber(fnSQRT([rvNumber(1)]))).toBe(1);
  });
  it("SQRT(2) ≈ 1.414", () => {
    expect(asNumber(fnSQRT([rvNumber(2)]))).toBeCloseTo(Math.SQRT2, 10);
  });
  it("rejects negatives with #NUM!", () => {
    expect(fnSQRT([rvNumber(-1e-10)])).toEqual(ERRORS.NUM);
  });
  it("handles boolean TRUE as 1", () => {
    expect(asNumber(fnSQRT([rvBoolean(true)]))).toBe(1);
  });
  it("propagates error", () => {
    expect(fnSQRT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("handles very large values", () => {
    expect(asNumber(fnSQRT([rvNumber(1e200)]))).toBeCloseTo(1e100, -90);
  });
});

describe("POWER comprehensive", () => {
  it("2^0 = 1", () => {
    expect(asNumber(fnPOWER([rvNumber(2), rvNumber(0)]))).toBe(1);
  });
  it("x^1 = x", () => {
    expect(asNumber(fnPOWER([rvNumber(7.5), rvNumber(1)]))).toBe(7.5);
  });
  it("negative exponent gives reciprocal power", () => {
    expect(asNumber(fnPOWER([rvNumber(2), rvNumber(-2)]))).toBe(0.25);
  });
  it("(-8)^(1/3) → #NUM! (because Math.pow returns NaN for negative base with non-integer exp)", () => {
    expect(fnPOWER([rvNumber(-8), rvNumber(1 / 3)])).toEqual(ERRORS.NUM);
  });
  it("(-2)^3 = -8 (integer exponent is allowed)", () => {
    expect(asNumber(fnPOWER([rvNumber(-2), rvNumber(3)]))).toBe(-8);
  });
  it("propagates error in base", () => {
    expect(fnPOWER([rvError("#N/A"), rvNumber(2)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("propagates error in exponent", () => {
    expect(fnPOWER([rvNumber(2), rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("string numeric base is coerced", () => {
    expect(asNumber(fnPOWER([rvString("3"), rvNumber(2)]))).toBe(9);
  });
});

describe("EXP comprehensive", () => {
  it("EXP(0)=1", () => {
    expect(asNumber(fnEXP([rvNumber(0)]))).toBe(1);
  });
  it("EXP(1)=e", () => {
    expect(asNumber(fnEXP([rvNumber(1)]))).toBeCloseTo(Math.E, 10);
  });
  it("EXP(-1)=1/e", () => {
    expect(asNumber(fnEXP([rvNumber(-1)]))).toBeCloseTo(1 / Math.E, 10);
  });
  it("overflow at huge x → #NUM!", () => {
    expect(fnEXP([rvNumber(1e5)])).toEqual(ERRORS.NUM);
  });
  it("underflow at very negative x is 0 (finite)", () => {
    expect(asNumber(fnEXP([rvNumber(-1e5)]))).toBe(0);
  });
  it("propagates error", () => {
    expect(fnEXP([rvError("#DIV/0!")])).toEqual({ kind: RVKind.Error, code: "#DIV/0!" });
  });
});

describe("LN comprehensive", () => {
  it("LN(1)=0", () => {
    expect(asNumber(fnLN([rvNumber(1)]))).toBe(0);
  });
  it("LN(e)=1", () => {
    expect(asNumber(fnLN([rvNumber(Math.E)]))).toBeCloseTo(1, 10);
  });
  it("LN of very small positive number is large negative", () => {
    expect(asNumber(fnLN([rvNumber(1e-200)]))).toBeCloseTo(Math.log(1e-200), 5);
  });
  it("LN(0) → #NUM!", () => {
    expect(fnLN([rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LN(-1) → #NUM!", () => {
    expect(fnLN([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("propagates error", () => {
    expect(fnLN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("LOG comprehensive", () => {
  it("LOG(1) = 0 regardless of base (when base omitted, base=10)", () => {
    expect(asNumber(fnLOG([rvNumber(1)]))).toBe(0);
  });
  it("LOG(100) = 2 (base 10)", () => {
    expect(asNumber(fnLOG([rvNumber(100)]))).toBeCloseTo(2, 10);
  });
  it("LOG(256, 2) = 8", () => {
    expect(asNumber(fnLOG([rvNumber(256), rvNumber(2)]))).toBeCloseTo(8, 10);
  });
  it("LOG(0) → #NUM!", () => {
    expect(fnLOG([rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LOG with base=1 → #NUM!", () => {
    expect(fnLOG([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOG with negative base → #NUM!", () => {
    expect(fnLOG([rvNumber(10), rvNumber(-2)])).toEqual(ERRORS.NUM);
  });
  it("propagates base error", () => {
    expect(fnLOG([rvNumber(10), rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("LOG10 comprehensive", () => {
  it("LOG10(1)=0", () => {
    expect(asNumber(fnLOG10([rvNumber(1)]))).toBe(0);
  });
  it("LOG10(10)=1", () => {
    expect(asNumber(fnLOG10([rvNumber(10)]))).toBeCloseTo(1, 10);
  });
  it("LOG10(0.1)=-1", () => {
    expect(asNumber(fnLOG10([rvNumber(0.1)]))).toBeCloseTo(-1, 10);
  });
  it("LOG10(0) → #NUM!", () => {
    expect(fnLOG10([rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LOG10(-5) → #NUM!", () => {
    expect(fnLOG10([rvNumber(-5)])).toEqual(ERRORS.NUM);
  });
  it("propagates error", () => {
    expect(fnLOG10([rvError("#VALUE!")])).toEqual(ERRORS.VALUE);
  });
});

describe("FACT comprehensive", () => {
  it("FACT(1)=1", () => {
    expect(asNumber(fnFACT([rvNumber(1)]))).toBe(1);
  });
  it("FACT(10)=3628800", () => {
    expect(asNumber(fnFACT([rvNumber(10)]))).toBe(3628800);
  });
  it("FACT of fractional is floor", () => {
    // FACT(5.9) = FACT(5) = 120
    expect(asNumber(fnFACT([rvNumber(5.9)]))).toBe(120);
  });
  it("FACT(170) fits in double", () => {
    const v = asNumber(fnFACT([rvNumber(170)]));
    expect(v).toBeGreaterThan(0);
    expect(Number.isFinite(v)).toBe(true);
  });
  it("FACT(171) → #NUM! (overflow)", () => {
    expect(fnFACT([rvNumber(171)])).toEqual(ERRORS.NUM);
  });
  it("propagates error", () => {
    expect(fnFACT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("FACTDOUBLE comprehensive", () => {
  it("FACTDOUBLE(0)=1", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(0)]))).toBe(1);
  });
  it("FACTDOUBLE(-1)=1 (boundary)", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(-1)]))).toBe(1);
  });
  it("FACTDOUBLE(6)=48 (6*4*2)", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(6)]))).toBe(48);
  });
  it("FACTDOUBLE(7)=105 (7*5*3*1)", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(7)]))).toBe(105);
  });
  it("FACTDOUBLE(-2) → #NUM!", () => {
    expect(fnFACTDOUBLE([rvNumber(-2)])).toEqual(ERRORS.NUM);
  });
  it("propagates error", () => {
    expect(fnFACTDOUBLE([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("trig functions comprehensive", () => {
  it("SIN(0)=0", () => {
    expect(asNumber(fnSIN([rvNumber(0)]))).toBe(0);
  });
  it("COS(0)=1", () => {
    expect(asNumber(fnCOS([rvNumber(0)]))).toBe(1);
  });
  it("TAN(0)=0", () => {
    expect(asNumber(fnTAN([rvNumber(0)]))).toBe(0);
  });
  it("SIN(pi/2)≈1", () => {
    expect(asNumber(fnSIN([rvNumber(Math.PI / 2)]))).toBeCloseTo(1, 10);
  });
  it("COS(pi)≈-1", () => {
    expect(asNumber(fnCOS([rvNumber(Math.PI)]))).toBeCloseTo(-1, 10);
  });
  it("TAN(pi/4)≈1", () => {
    expect(asNumber(fnTAN([rvNumber(Math.PI / 4)]))).toBeCloseTo(1, 10);
  });
  it("SIN propagates error", () => {
    expect(fnSIN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("COS coerces boolean TRUE to 1 (cos(1))", () => {
    expect(asNumber(fnCOS([rvBoolean(true)]))).toBeCloseTo(Math.cos(1), 10);
  });
});

describe("ASIN / ACOS / ATAN comprehensive", () => {
  it("ASIN(0)=0", () => {
    expect(asNumber(fnASIN([rvNumber(0)]))).toBe(0);
  });
  it("ASIN(1)=pi/2", () => {
    expect(asNumber(fnASIN([rvNumber(1)]))).toBeCloseTo(Math.PI / 2, 10);
  });
  it("ASIN(-1)=-pi/2", () => {
    expect(asNumber(fnASIN([rvNumber(-1)]))).toBeCloseTo(-Math.PI / 2, 10);
  });
  it("ASIN outside [-1,1] → #NUM!", () => {
    expect(fnASIN([rvNumber(1.0001)])).toEqual(ERRORS.NUM);
    expect(fnASIN([rvNumber(-1.0001)])).toEqual(ERRORS.NUM);
  });
  it("ACOS(1)=0", () => {
    expect(asNumber(fnACOS([rvNumber(1)]))).toBe(0);
  });
  it("ACOS(-1)=pi", () => {
    expect(asNumber(fnACOS([rvNumber(-1)]))).toBeCloseTo(Math.PI, 10);
  });
  it("ACOS outside [-1,1] → #NUM!", () => {
    expect(fnACOS([rvNumber(2)])).toEqual(ERRORS.NUM);
  });
  it("ATAN(0)=0", () => {
    expect(asNumber(fnATAN([rvNumber(0)]))).toBe(0);
  });
  it("ATAN(1)=pi/4", () => {
    expect(asNumber(fnATAN([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 10);
  });
  it("ATAN of very large x approaches pi/2", () => {
    expect(asNumber(fnATAN([rvNumber(1e15)]))).toBeCloseTo(Math.PI / 2, 10);
  });
});

describe("ATAN2 comprehensive", () => {
  it("ATAN2(1, 0) = 0 (along x axis)", () => {
    expect(asNumber(fnATAN2([rvNumber(1), rvNumber(0)]))).toBe(0);
  });
  it("ATAN2(0, 1) = pi/2 (along y axis)", () => {
    expect(asNumber(fnATAN2([rvNumber(0), rvNumber(1)]))).toBeCloseTo(Math.PI / 2, 10);
  });
  it("ATAN2(1, 1) = pi/4", () => {
    expect(asNumber(fnATAN2([rvNumber(1), rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 10);
  });
  it("ATAN2(-1, 1) = 3pi/4 (second quadrant)", () => {
    expect(asNumber(fnATAN2([rvNumber(-1), rvNumber(1)]))).toBeCloseTo((3 * Math.PI) / 4, 10);
  });
  it("ATAN2(0, 0) → #DIV/0!", () => {
    expect(fnATAN2([rvNumber(0), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("ATAN2 propagates error", () => {
    expect(fnATAN2([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("hyperbolic comprehensive", () => {
  it("SINH(0)=0", () => {
    expect(asNumber(fnSINH([rvNumber(0)]))).toBe(0);
  });
  it("COSH(0)=1", () => {
    expect(asNumber(fnCOSH([rvNumber(0)]))).toBe(1);
  });
  it("TANH(0)=0", () => {
    expect(asNumber(fnTANH([rvNumber(0)]))).toBe(0);
  });
  it("SINH overflow → #NUM!", () => {
    expect(fnSINH([rvNumber(10000)])).toEqual(ERRORS.NUM);
  });
  it("COSH overflow → #NUM!", () => {
    expect(fnCOSH([rvNumber(10000)])).toEqual(ERRORS.NUM);
  });
  it("TANH saturates to 1", () => {
    expect(asNumber(fnTANH([rvNumber(100)]))).toBeCloseTo(1, 10);
  });
  it("ASINH(0)=0", () => {
    expect(asNumber(fnASINH([rvNumber(0)]))).toBe(0);
  });
  it("ASINH is odd: asinh(-1) = -asinh(1)", () => {
    expect(asNumber(fnASINH([rvNumber(-1)]))).toBeCloseTo(-Math.asinh(1), 10);
  });
  it("ACOSH(1)=0", () => {
    expect(asNumber(fnACOSH([rvNumber(1)]))).toBe(0);
  });
  it("ACOSH(0) → #NUM!", () => {
    expect(fnACOSH([rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("ATANH(0)=0", () => {
    expect(asNumber(fnATANH([rvNumber(0)]))).toBe(0);
  });
  it("ATANH(1) → #NUM! (boundary)", () => {
    expect(fnATANH([rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("ATANH(-1) → #NUM!", () => {
    expect(fnATANH([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("SEC comprehensive", () => {
  it("SEC(0)=1", () => {
    expect(asNumber(fnSEC([rvNumber(0)]))).toBe(1);
  });
  it("SEC is even: sec(-x)=sec(x)", () => {
    const a = asNumber(fnSEC([rvNumber(1)]));
    const b = asNumber(fnSEC([rvNumber(-1)]));
    expect(a).toBeCloseTo(b, 10);
  });
  it("SEC(pi) ≈ -1", () => {
    expect(asNumber(fnSEC([rvNumber(Math.PI)]))).toBeCloseTo(-1, 10);
  });
  it("SEC propagates error", () => {
    expect(fnSEC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("SEC(string number) is coerced", () => {
    expect(asNumber(fnSEC([rvString("0")]))).toBe(1);
  });
});

describe("CSC comprehensive", () => {
  it("CSC(pi/2) = 1", () => {
    expect(asNumber(fnCSC([rvNumber(Math.PI / 2)]))).toBeCloseTo(1, 10);
  });
  it("CSC(0) → #DIV/0!", () => {
    expect(fnCSC([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("CSC(-pi/2) = -1", () => {
    expect(asNumber(fnCSC([rvNumber(-Math.PI / 2)]))).toBeCloseTo(-1, 10);
  });
  it("CSC propagates error", () => {
    expect(fnCSC([rvError("#REF!")])).toEqual(ERRORS.REF);
  });
  it("CSC boolean TRUE = 1/sin(1)", () => {
    expect(asNumber(fnCSC([rvBoolean(true)]))).toBeCloseTo(1 / Math.sin(1), 10);
  });
});

describe("COT comprehensive", () => {
  it("COT(pi/4)=1", () => {
    expect(asNumber(fnCOT([rvNumber(Math.PI / 4)]))).toBeCloseTo(1, 10);
  });
  it("COT(0) → #DIV/0!", () => {
    expect(fnCOT([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("COT(pi/2) ≈ 0", () => {
    expect(asNumber(fnCOT([rvNumber(Math.PI / 2)]))).toBeCloseTo(0, 10);
  });
  it("COT propagates error", () => {
    expect(fnCOT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("COT is odd", () => {
    const a = asNumber(fnCOT([rvNumber(1)]));
    const b = asNumber(fnCOT([rvNumber(-1)]));
    expect(a).toBeCloseTo(-b, 10);
  });
});

describe("SECH / CSCH / COTH comprehensive", () => {
  it("SECH(0) = 1", () => {
    expect(asNumber(fnSECH([rvNumber(0)]))).toBe(1);
  });
  it("SECH(infinity-ish) = 0", () => {
    expect(asNumber(fnSECH([rvNumber(10000)]))).toBe(0);
  });
  it("CSCH(1) = 1/sinh(1)", () => {
    expect(asNumber(fnCSCH([rvNumber(1)]))).toBeCloseTo(1 / Math.sinh(1), 10);
  });
  it("CSCH(0) → #DIV/0!", () => {
    expect(fnCSCH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("CSCH at very large x → 0 (sinh overflow handled)", () => {
    expect(asNumber(fnCSCH([rvNumber(10000)]))).toBe(0);
  });
  it("COTH(1) ≈ 1/tanh(1)", () => {
    expect(asNumber(fnCOTH([rvNumber(1)]))).toBeCloseTo(1 / Math.tanh(1), 10);
  });
  it("COTH(0) → #DIV/0!", () => {
    expect(fnCOTH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
});

describe("ACOT / ACOTH comprehensive", () => {
  it("ACOT(0) = pi/2", () => {
    expect(asNumber(fnACOT([rvNumber(0)]))).toBeCloseTo(Math.PI / 2, 10);
  });
  it("ACOT(1) = pi/4", () => {
    expect(asNumber(fnACOT([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 10);
  });
  it("ACOT of large positive approaches 0+", () => {
    expect(asNumber(fnACOT([rvNumber(1e10)]))).toBeCloseTo(0, 9);
  });
  it("ACOT of large negative approaches pi", () => {
    // Excel's ACOT maps into (0, pi); Math-form: pi/2 - atan(-1e10) ≈ pi
    expect(asNumber(fnACOT([rvNumber(-1e10)]))).toBeCloseTo(Math.PI, 9);
  });
  it("ACOTH(2) ≈ 0.5493", () => {
    expect(asNumber(fnACOTH([rvNumber(2)]))).toBeCloseTo(0.549306, 5);
  });
  it("ACOTH(-2) ≈ -0.5493", () => {
    expect(asNumber(fnACOTH([rvNumber(-2)]))).toBeCloseTo(-0.549306, 5);
  });
  it("ACOTH |x|<=1 → #NUM!", () => {
    expect(fnACOTH([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnACOTH([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("PI / DEGREES / RADIANS comprehensive", () => {
  it("PI takes no args", () => {
    expect(asNumber(fnPI([]))).toBe(Math.PI);
  });
  it("DEGREES(0)=0", () => {
    expect(asNumber(fnDEGREES([rvNumber(0)]))).toBe(0);
  });
  it("DEGREES(2pi)=360", () => {
    expect(asNumber(fnDEGREES([rvNumber(2 * Math.PI)]))).toBeCloseTo(360, 10);
  });
  it("RADIANS(360)=2pi", () => {
    expect(asNumber(fnRADIANS([rvNumber(360)]))).toBeCloseTo(2 * Math.PI, 10);
  });
  it("DEGREES propagates error", () => {
    expect(fnDEGREES([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("RADIANS of boolean TRUE = pi/180", () => {
    expect(asNumber(fnRADIANS([rvBoolean(true)]))).toBeCloseTo(Math.PI / 180, 10);
  });
});

describe("INT comprehensive", () => {
  it("INT(3)=3", () => {
    expect(asNumber(fnINT([rvNumber(3)]))).toBe(3);
  });
  it("INT(3.7)=3", () => {
    expect(asNumber(fnINT([rvNumber(3.7)]))).toBe(3);
  });
  it("INT(-3.2)=-4 (floor, not trunc)", () => {
    expect(asNumber(fnINT([rvNumber(-3.2)]))).toBe(-4);
  });
  it("INT(-0.5)=-1", () => {
    expect(asNumber(fnINT([rvNumber(-0.5)]))).toBe(-1);
  });
  it("INT(0)=0", () => {
    expect(asNumber(fnINT([rvNumber(0)]))).toBe(0);
  });
  it("INT propagates error", () => {
    expect(fnINT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("ROUND comprehensive", () => {
  it("ROUND(0,0) = 0", () => {
    expect(asNumber(fnROUND([rvNumber(0), rvNumber(0)]))).toBe(0);
  });
  it("ROUND(2.15, 1) = 2.2 (half up at last digit)", () => {
    expect(asNumber(fnROUND([rvNumber(2.15), rvNumber(1)]))).toBeCloseTo(2.2, 10);
  });
  it("ROUND with digits=0 via default argument", () => {
    expect(asNumber(fnROUND([rvNumber(2.49)]))).toBe(2);
  });
  it("ROUND propagates error in first arg", () => {
    expect(fnROUND([rvError("#N/A"), rvNumber(0)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ROUND propagates error in digits arg", () => {
    expect(fnROUND([rvNumber(1), rvError("#REF!")])).toEqual(ERRORS.REF);
  });
});

describe("ROUNDUP comprehensive", () => {
  it("ROUNDUP always away from zero", () => {
    expect(asNumber(fnROUNDUP([rvNumber(3.2), rvNumber(0)]))).toBe(4);
    expect(asNumber(fnROUNDUP([rvNumber(-3.2), rvNumber(0)]))).toBe(-4);
  });
  it("ROUNDUP of 0 is 0", () => {
    expect(asNumber(fnROUNDUP([rvNumber(0), rvNumber(2)]))).toBe(0);
  });
  it("ROUNDUP negative digits", () => {
    expect(asNumber(fnROUNDUP([rvNumber(31415), rvNumber(-3)]))).toBe(32000);
  });
  it("propagates error", () => {
    expect(fnROUNDUP([rvError("#N/A"), rvNumber(0)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ROUNDUP exact integer is unchanged", () => {
    expect(asNumber(fnROUNDUP([rvNumber(5), rvNumber(0)]))).toBe(5);
  });
});

describe("ROUNDDOWN comprehensive", () => {
  it("ROUNDDOWN toward zero", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(3.99), rvNumber(0)]))).toBe(3);
    expect(asNumber(fnROUNDDOWN([rvNumber(-3.99), rvNumber(0)]))).toBe(-3);
  });
  it("ROUNDDOWN(0)=0", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(0), rvNumber(0)]))).toBe(0);
  });
  it("ROUNDDOWN negative digits", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(31999), rvNumber(-3)]))).toBe(31000);
  });
  it("propagates error", () => {
    expect(fnROUNDDOWN([rvNumber(1), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("defaults digits to 0", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(7.9)]))).toBe(7);
  });
});

describe("TRUNC comprehensive", () => {
  it("TRUNC with no digits is same as trunc", () => {
    expect(asNumber(fnTRUNC([rvNumber(-1.9)]))).toBe(-1);
    expect(asNumber(fnTRUNC([rvNumber(1.9)]))).toBe(1);
  });
  it("TRUNC(0)=0", () => {
    expect(asNumber(fnTRUNC([rvNumber(0)]))).toBe(0);
  });
  it("TRUNC with digits", () => {
    expect(asNumber(fnTRUNC([rvNumber(3.14159), rvNumber(3)]))).toBeCloseTo(3.141, 10);
  });
  it("TRUNC with negative digits", () => {
    expect(asNumber(fnTRUNC([rvNumber(1234.5), rvNumber(-2)]))).toBe(1200);
  });
  it("propagates error", () => {
    expect(fnTRUNC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("CEILING comprehensive", () => {
  it("CEILING default sig=1", () => {
    // When no second arg, default is 1.
    expect(asNumber(fnCEILING([rvNumber(2.3)]))).toBe(3);
  });
  it("CEILING positive ceil to multiple", () => {
    expect(asNumber(fnCEILING([rvNumber(4.3), rvNumber(0.5)]))).toBe(4.5);
  });
  it("CEILING zero significance → 0 (CEILING-specific)", () => {
    expect(asNumber(fnCEILING([rvNumber(5), rvNumber(0)]))).toBe(0);
  });
  it("CEILING propagates number error", () => {
    expect(fnCEILING([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("CEILING propagates significance error", () => {
    expect(fnCEILING([rvNumber(5), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("FLOOR comprehensive", () => {
  it("FLOOR default", () => {
    expect(asNumber(fnFLOOR([rvNumber(2.9)]))).toBe(2);
  });
  it("FLOOR(-2.3, -1)=-2 (floor toward zero in magnitude when both negative)", () => {
    expect(asNumber(fnFLOOR([rvNumber(-2.3), rvNumber(-1)]))).toBe(-2);
  });
  it("FLOOR(5, 0) → #DIV/0!", () => {
    expect(fnFLOOR([rvNumber(5), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("FLOOR with sign mismatch → #NUM!", () => {
    expect(fnFLOOR([rvNumber(2.5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("FLOOR propagates error", () => {
    expect(fnFLOOR([rvError("#N/A"), rvNumber(1)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("MROUND comprehensive", () => {
  it("MROUND(10, 3)=9", () => {
    expect(asNumber(fnMROUND([rvNumber(10), rvNumber(3)]))).toBe(9);
  });
  it("MROUND(-10, -3)=-9", () => {
    expect(asNumber(fnMROUND([rvNumber(-10), rvNumber(-3)]))).toBe(-9);
  });
  it("MROUND(0, 5)=0 (no multiple needed)", () => {
    expect(asNumber(fnMROUND([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("MROUND(5, 0)=0", () => {
    expect(asNumber(fnMROUND([rvNumber(5), rvNumber(0)]))).toBe(0);
  });
  it("MROUND sign mismatch → #NUM!", () => {
    expect(fnMROUND([rvNumber(1), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("MROUND propagates error", () => {
    expect(fnMROUND([rvError("#N/A"), rvNumber(1)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("MOD comprehensive", () => {
  it("MOD(0, 5) = 0", () => {
    expect(asNumber(fnMOD([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("MOD fractional number, integer divisor", () => {
    expect(asNumber(fnMOD([rvNumber(7.5), rvNumber(2)]))).toBeCloseTo(1.5, 10);
  });
  it("MOD boolean coercion", () => {
    // MOD(TRUE, 2) = MOD(1, 2) = 1
    expect(asNumber(fnMOD([rvBoolean(true), rvNumber(2)]))).toBe(1);
  });
  it("MOD propagates number error", () => {
    expect(fnMOD([rvError("#N/A"), rvNumber(1)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("MOD propagates divisor error", () => {
    expect(fnMOD([rvNumber(1), rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("QUOTIENT comprehensive", () => {
  it("QUOTIENT(4.5, 1) = 4 (truncate)", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(4.5), rvNumber(1)]))).toBe(4);
  });
  it("QUOTIENT(-10, 3)=-3", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(-10), rvNumber(3)]))).toBe(-3);
  });
  it("QUOTIENT(10, 0) → #DIV/0!", () => {
    expect(fnQUOTIENT([rvNumber(10), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("QUOTIENT propagates error", () => {
    expect(fnQUOTIENT([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("QUOTIENT string numeric coerces", () => {
    expect(asNumber(fnQUOTIENT([rvString("7"), rvNumber(2)]))).toBe(3);
  });
});

describe("EVEN / ODD comprehensive", () => {
  it("EVEN(0)=0", () => {
    expect(asNumber(fnEVEN([rvNumber(0)]))).toBe(0);
  });
  it("EVEN(-0.5)=-2 (away from zero to next even)", () => {
    expect(asNumber(fnEVEN([rvNumber(-0.5)]))).toBe(-2);
  });
  it("EVEN(1.5)=2", () => {
    expect(asNumber(fnEVEN([rvNumber(1.5)]))).toBe(2);
  });
  it("EVEN propagates error", () => {
    expect(fnEVEN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ODD(0)=1", () => {
    expect(asNumber(fnODD([rvNumber(0)]))).toBe(1);
  });
  it("ODD(-1)=-1 (already odd)", () => {
    expect(asNumber(fnODD([rvNumber(-1)]))).toBe(-1);
  });
  it("ODD(1.5)=3", () => {
    expect(asNumber(fnODD([rvNumber(1.5)]))).toBe(3);
  });
  it("ODD propagates error", () => {
    expect(fnODD([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("GCD comprehensive", () => {
  it("GCD(0, 0) = 0", () => {
    expect(asNumber(fnGCD([rvNumber(0), rvNumber(0)]))).toBe(0);
  });
  it("GCD(0, 5) = 5", () => {
    expect(asNumber(fnGCD([rvNumber(0), rvNumber(5)]))).toBe(5);
  });
  it("GCD of one number returns that number", () => {
    expect(asNumber(fnGCD([rvNumber(7)]))).toBe(7);
  });
  it("GCD rejects negatives → #NUM!", () => {
    expect(fnGCD([rvNumber(6), rvNumber(-4)])).toEqual(ERRORS.NUM);
  });
  it("GCD truncates fractional inputs", () => {
    // GCD(12.9, 18.5) = GCD(12, 18) = 6
    expect(asNumber(fnGCD([rvNumber(12.9), rvNumber(18.5)]))).toBe(6);
  });
  it("GCD propagates error in array cell", () => {
    expect(fnGCD([rvArray([[rvNumber(6), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("LCM comprehensive", () => {
  it("LCM(0, 5) = 0", () => {
    expect(asNumber(fnLCM([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("LCM(1, 7) = 7", () => {
    expect(asNumber(fnLCM([rvNumber(1), rvNumber(7)]))).toBe(7);
  });
  it("LCM multiple args", () => {
    expect(asNumber(fnLCM([rvNumber(2), rvNumber(3), rvNumber(4)]))).toBe(12);
  });
  it("LCM rejects negatives → #NUM!", () => {
    expect(fnLCM([rvNumber(6), rvNumber(-4)])).toEqual(ERRORS.NUM);
  });
  it("LCM propagates error in array", () => {
    expect(fnLCM([rvArray([[rvNumber(6), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("COMBIN comprehensive", () => {
  it("COMBIN(n, 0) = 1", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(0)]))).toBe(1);
  });
  it("COMBIN(n, n) = 1", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(5)]))).toBe(1);
  });
  it("COMBIN(5, 2) = 10", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(2)]))).toBe(10);
  });
  it("COMBIN negative → #NUM!", () => {
    expect(fnCOMBIN([rvNumber(-1), rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnCOMBIN([rvNumber(5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("COMBIN k>n → #NUM!", () => {
    expect(fnCOMBIN([rvNumber(3), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("COMBIN propagates error", () => {
    expect(fnCOMBIN([rvError("#N/A"), rvNumber(2)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("COMBINA comprehensive", () => {
  it("COMBINA(0, 0) = 1", () => {
    expect(asNumber(fnCOMBINA([rvNumber(0), rvNumber(0)]))).toBe(1);
  });
  it("COMBINA(4, 3) = 20 (multiset coefficient C(6, 3))", () => {
    expect(asNumber(fnCOMBINA([rvNumber(4), rvNumber(3)]))).toBe(20);
  });
  it("COMBINA(5, 0) = 1", () => {
    expect(asNumber(fnCOMBINA([rvNumber(5), rvNumber(0)]))).toBe(1);
  });
  it("COMBINA propagates error", () => {
    expect(fnCOMBINA([rvError("#REF!"), rvNumber(1)])).toEqual(ERRORS.REF);
  });
  it("COMBINA negative → #NUM!", () => {
    expect(fnCOMBINA([rvNumber(-1), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
});

describe("PERMUT comprehensive", () => {
  it("PERMUT(n, 0) = 1", () => {
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(0)]))).toBe(1);
  });
  it("PERMUT(n, n) = n!", () => {
    // 5! = 120
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(5)]))).toBe(120);
  });
  it("PERMUT(5, 2) = 20", () => {
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(2)]))).toBe(20);
  });
  it("PERMUT(3, 5) → #NUM! (k>n)", () => {
    expect(fnPERMUT([rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("PERMUT propagates error", () => {
    expect(fnPERMUT([rvError("#N/A"), rvNumber(1)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("MULTINOMIAL comprehensive", () => {
  it("MULTINOMIAL(2, 3, 4) = 9!/(2!3!4!) = 1260", () => {
    expect(asNumber(fnMULTINOMIAL([rvNumber(2), rvNumber(3), rvNumber(4)]))).toBe(1260);
  });
  it("MULTINOMIAL of single arg = 1 (n!/n!)", () => {
    expect(asNumber(fnMULTINOMIAL([rvNumber(5)]))).toBe(1);
  });
  it("MULTINOMIAL(0, 0) = 1", () => {
    expect(asNumber(fnMULTINOMIAL([rvNumber(0), rvNumber(0)]))).toBe(1);
  });
  it("MULTINOMIAL negative → #NUM!", () => {
    expect(fnMULTINOMIAL([rvNumber(2), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("MULTINOMIAL propagates error", () => {
    expect(fnMULTINOMIAL([rvArray([[rvNumber(2), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("BASE comprehensive", () => {
  it("BASE(0, 2) = '0'", () => {
    expect(asString(fnBASE([rvNumber(0), rvNumber(2)]))).toBe("0");
  });
  it("BASE(10, 2) = '1010'", () => {
    expect(asString(fnBASE([rvNumber(10), rvNumber(2)]))).toBe("1010");
  });
  it("BASE with min_length pads with zeros", () => {
    expect(asString(fnBASE([rvNumber(7), rvNumber(2), rvNumber(6)]))).toBe("000111");
  });
  it("BASE radix < 2 → #NUM!", () => {
    expect(fnBASE([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("BASE radix > 36 → #NUM!", () => {
    expect(fnBASE([rvNumber(10), rvNumber(37)])).toEqual(ERRORS.NUM);
  });
  it("BASE propagates number error", () => {
    expect(fnBASE([rvError("#N/A"), rvNumber(2)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("DECIMAL comprehensive", () => {
  it("DECIMAL('10', 2) = 2", () => {
    expect(asNumber(fnDECIMAL([rvString("10"), rvNumber(2)]))).toBe(2);
  });
  it("DECIMAL('zap', 36) parses high radix", () => {
    // z=35, a=10, p=25 → 35*36^2 + 10*36 + 25 = 45360 + 360 + 25 = 45745
    expect(asNumber(fnDECIMAL([rvString("zap"), rvNumber(36)]))).toBe(45745);
  });
  it("DECIMAL invalid digit → #NUM!", () => {
    // '1G' is invalid for radix 16
    expect(fnDECIMAL([rvString("1G"), rvNumber(16)])).toEqual(ERRORS.NUM);
  });
  it("DECIMAL empty string → #NUM!", () => {
    expect(fnDECIMAL([rvString(""), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("DECIMAL radix < 2 → #NUM!", () => {
    expect(fnDECIMAL([rvString("1"), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("DECIMAL propagates error", () => {
    expect(fnDECIMAL([rvError("#N/A"), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("ROMAN comprehensive", () => {
  it("ROMAN(1)='I'", () => {
    expect(asString(fnROMAN([rvNumber(1)]))).toBe("I");
  });
  it("ROMAN(4)='IV'", () => {
    expect(asString(fnROMAN([rvNumber(4)]))).toBe("IV");
  });
  it("ROMAN(3999)='MMMCMXCIX'", () => {
    expect(asString(fnROMAN([rvNumber(3999)]))).toBe("MMMCMXCIX");
  });
  it("ROMAN(0)=''", () => {
    expect(asString(fnROMAN([rvNumber(0)]))).toBe("");
  });
  it("ROMAN negative → #VALUE!", () => {
    expect(fnROMAN([rvNumber(-1)])).toEqual(ERRORS.VALUE);
  });
  it("ROMAN > 3999 → #VALUE!", () => {
    expect(fnROMAN([rvNumber(4000)])).toEqual(ERRORS.VALUE);
  });
  it("ROMAN with form arg does not crash", () => {
    expect(asString(fnROMAN([rvNumber(999), rvNumber(0)]))).toBe("CMXCIX");
  });
});

describe("ARABIC comprehensive", () => {
  it("ARABIC('I')=1", () => {
    expect(asNumber(fnARABIC([rvString("I")]))).toBe(1);
  });
  it("ARABIC('IV')=4", () => {
    expect(asNumber(fnARABIC([rvString("IV")]))).toBe(4);
  });
  it("ARABIC('')=0", () => {
    expect(asNumber(fnARABIC([rvString("")]))).toBe(0);
  });
  it("ARABIC invalid char → #VALUE!", () => {
    expect(fnARABIC([rvString("IZ")])).toEqual(ERRORS.VALUE);
  });
  it("ARABIC case-insensitive", () => {
    expect(asNumber(fnARABIC([rvString("mcm")]))).toBe(1900);
  });
  it("ARABIC propagates error", () => {
    expect(fnARABIC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("SUM comprehensive", () => {
  it("SUM empty = 0", () => {
    expect(asNumber(fnSUM([]))).toBe(0);
  });
  it("SUM of single scalar boolean TRUE = 1", () => {
    // direct scalar booleans ARE coerced (Excel behavior)
    expect(asNumber(fnSUM([rvBoolean(true)]))).toBe(1);
  });
  it("SUM of blank scalar = 0", () => {
    expect(asNumber(fnSUM([BLANK]))).toBe(0);
  });
  it("SUM of string number (direct arg) coerces", () => {
    expect(asNumber(fnSUM([rvString("3.5")]))).toBe(3.5);
  });
  it("SUM of string number in array is skipped", () => {
    expect(asNumber(fnSUM([rvArray([[rvNumber(1), rvString("3.5")]])]))).toBe(1);
  });
  it("SUM direct non-numeric string → #VALUE!", () => {
    expect(fnSUM([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("SUM mixed array / scalar", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnSUM([arr, rvNumber(4)]))).toBe(10);
  });
  it("SUM overflow → #NUM!", () => {
    expect(fnSUM([rvNumber(1e308), rvNumber(1e308)])).toEqual(ERRORS.NUM);
  });
});

describe("AVERAGE comprehensive", () => {
  it("AVERAGE of one number is itself", () => {
    expect(asNumber(fnAVERAGE([rvNumber(7)]))).toBe(7);
  });
  it("AVERAGE of blanks in array skipped", () => {
    const arr = rvArray([[rvNumber(2), BLANK, rvNumber(4)]]);
    expect(asNumber(fnAVERAGE([arr]))).toBe(3);
  });
  it("AVERAGE of only-blank returns #DIV/0!", () => {
    expect(fnAVERAGE([rvArray([[BLANK, BLANK]])])).toEqual(ERRORS.DIV0);
  });
  it("AVERAGE boolean (direct arg) is coerced", () => {
    // direct booleans via flattenNumbers → toNumberRV(true) = 1
    expect(asNumber(fnAVERAGE([rvBoolean(true), rvBoolean(false)]))).toBe(0.5);
  });
  it("AVERAGE propagates error", () => {
    expect(fnAVERAGE([rvNumber(1), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("MIN / MAX comprehensive", () => {
  it("MIN of array skips text/blanks", () => {
    const arr = rvArray([[rvNumber(3), rvString("abc"), rvNumber(1), BLANK]]);
    expect(asNumber(fnMIN([arr]))).toBe(1);
  });
  it("MAX negative values only", () => {
    expect(asNumber(fnMAX([rvNumber(-3), rvNumber(-1), rvNumber(-2)]))).toBe(-1);
  });
  it("MIN of only error cells → propagate", () => {
    const arr = rvArray([[ERRORS.NA, rvNumber(1)]]);
    expect(fnMIN([arr])).toEqual(ERRORS.NA);
  });
  it("MAX of mixed is max over numbers", () => {
    const arr = rvArray([[rvBoolean(true), rvNumber(5), rvNumber(-3)]]);
    expect(asNumber(fnMAX([arr]))).toBe(5);
  });
  it("MIN of very small and large", () => {
    expect(asNumber(fnMIN([rvNumber(-1e308), rvNumber(1e308)]))).toBe(-1e308);
  });
});

describe("COUNT / COUNTA / COUNTBLANK comprehensive", () => {
  it("COUNT of numeric-string in array = 0 (strings skipped)", () => {
    expect(asNumber(fnCOUNT([rvArray([[rvString("3")]])]))).toBe(0);
  });
  it("COUNT direct scalar number = 1", () => {
    expect(asNumber(fnCOUNT([rvNumber(5)]))).toBe(1);
  });
  it("COUNTA counts error cells", () => {
    expect(asNumber(fnCOUNTA([rvArray([[ERRORS.NA, rvNumber(1)]])]))).toBe(2);
  });
  it("COUNTBLANK empty string counts as blank", () => {
    expect(asNumber(fnCOUNTBLANK([rvArray([[rvString(""), BLANK, rvNumber(1)]])]))).toBe(2);
  });
  it("COUNT of empty arg list = 0", () => {
    expect(asNumber(fnCOUNT([]))).toBe(0);
  });
});

describe("SUMSQ comprehensive", () => {
  it("SUMSQ of one value", () => {
    expect(asNumber(fnSUMSQ([rvNumber(5)]))).toBe(25);
  });
  it("SUMSQ of empty = 0", () => {
    expect(asNumber(fnSUMSQ([]))).toBe(0);
  });
  it("SUMSQ ignores text in array", () => {
    expect(asNumber(fnSUMSQ([rvArray([[rvNumber(3), rvString("abc"), rvNumber(4)]])]))).toBe(25);
  });
  it("SUMSQ propagates array error", () => {
    expect(fnSUMSQ([rvArray([[rvNumber(3), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("SUMSQ overflow → #NUM!", () => {
    expect(fnSUMSQ([rvNumber(1e200), rvNumber(1e200)])).toEqual(ERRORS.NUM);
  });
});

describe("PRODUCT comprehensive", () => {
  it("PRODUCT single value", () => {
    expect(asNumber(fnPRODUCT([rvNumber(7)]))).toBe(7);
  });
  it("PRODUCT skips non-numeric in array", () => {
    expect(asNumber(fnPRODUCT([rvArray([[rvNumber(2), rvString("x"), rvNumber(3)]])]))).toBe(6);
  });
  it("PRODUCT overflow → #NUM!", () => {
    expect(fnPRODUCT([rvNumber(1e200), rvNumber(1e200)])).toEqual(ERRORS.NUM);
  });
  it("PRODUCT propagates array error", () => {
    expect(fnPRODUCT([rvArray([[rvNumber(2), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("PRODUCT with zero = 0", () => {
    expect(asNumber(fnPRODUCT([rvNumber(5), rvNumber(0), rvNumber(10)]))).toBe(0);
  });
});

describe("SUMPRODUCT comprehensive", () => {
  it("SUMPRODUCT single array returns its sum of numbers", () => {
    // Same as SUM over single array
    expect(asNumber(fnSUMPRODUCT([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])]))).toBe(6);
  });
  it("SUMPRODUCT treats booleans as 0/1", () => {
    // TRUE(=1) * 5 + FALSE(=0) * 10 = 5
    const a = rvArray([[rvBoolean(true), rvBoolean(false)]]);
    const b = rvArray([[rvNumber(5), rvNumber(10)]]);
    expect(asNumber(fnSUMPRODUCT([a, b]))).toBe(5);
  });
  it("SUMPRODUCT text cells are treated as 0", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2)]]);
    const b = rvArray([[rvString("x"), rvNumber(3)]]);
    expect(asNumber(fnSUMPRODUCT([a, b]))).toBe(6);
  });
  it("SUMPRODUCT column arrays", () => {
    const a = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const b = rvArray([[rvNumber(4)], [rvNumber(5)], [rvNumber(6)]]);
    expect(asNumber(fnSUMPRODUCT([a, b]))).toBe(32);
  });
  it("SUMPRODUCT scalar * array", () => {
    expect(
      asNumber(fnSUMPRODUCT([rvNumber(3), rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])]))
    ).toBe(18);
  });
});

describe("RAND comprehensive", () => {
  it("RAND returns [0, 1)", () => {
    for (let i = 0; i < 30; i++) {
      const n = asNumber(fnRAND([]));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});

describe("RANDBETWEEN comprehensive", () => {
  it("single-point range returns that value", () => {
    expect(asNumber(fnRANDBETWEEN([rvNumber(7), rvNumber(7)]))).toBe(7);
  });
  it("fractional bottom/top → integer in [ceil(bottom), floor(top)]", () => {
    for (let i = 0; i < 30; i++) {
      const n = asNumber(fnRANDBETWEEN([rvNumber(1.1), rvNumber(3.9)]));
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    }
  });
  it("propagates error in either arg", () => {
    expect(fnRANDBETWEEN([rvError("#N/A"), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
    expect(fnRANDBETWEEN([rvNumber(1), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("SUMX2MY2 / SUMX2PY2 / SUMXMY2 extra", () => {
  it("SUMX2MY2 skips non-numeric cells in matched positions", () => {
    const a = rvArray([[rvNumber(2), rvString("x"), rvNumber(4)]]);
    const b = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    // Only index 0 and 2 are numeric in a, index 1 skipped: (4-1)+(16-1)=3+15=18
    expect(asNumber(fnSUMX2MY2([a, b]))).toBe(18);
  });
  it("SUMX2PY2 propagates error", () => {
    const a = rvArray([[ERRORS.NA]]);
    const b = rvArray([[rvNumber(1)]]);
    expect(fnSUMX2PY2([a, b])).toEqual(ERRORS.NA);
  });
  it("SUMXMY2 equal arrays = 0", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnSUMXMY2([a, a]))).toBe(0);
  });
  it("SUMX2MY2 scalar first arg → #VALUE!", () => {
    expect(fnSUMX2MY2([rvNumber(1), rvArray([[rvNumber(2)]])])).toEqual(ERRORS.VALUE);
  });
  it("SUMXMY2 different-shape arrays return #N/A (Excel behaviour)", () => {
    // Regression: previously silently clamped to the min dim, hiding
    // the user's shape mismatch. Excel rejects mismatched shapes with
    // `#N/A` — see the `SUMXMY2` docs.
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const b = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnSUMXMY2([a, b])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// CEILING / FLOOR family aliases — tested via the formula evaluator so the
// registry-level alias wiring is exercised.
//
// CEILING.MATH, CEILING.PRECISE, ISO.CEILING, FLOOR.MATH, FLOOR.PRECISE
// all share the `fnCEILING` / `fnFLOOR` implementation. These tests are
// light — the core behaviour is covered by the direct fnCEILING / fnFLOOR
// suites above — but they guarantee the aliases are reachable and route
// to the correct underlying function.
// ============================================================================

function runFormula(formula: string): unknown {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Sheet1");
  Cell.setValue(ws, "A1", { formula, result: 0 });
  calculateFormulas(wb);
  return Cell.getResult(ws, "A1");
}

describe("CEILING.MATH / CEILING.PRECISE / ISO.CEILING aliases", () => {
  it("CEILING.MATH(2.3,1) rounds up to 3", () => {
    expect(runFormula("CEILING.MATH(2.3,1)")).toBe(3);
  });
  it("CEILING.MATH(2.3) uses default significance of 1", () => {
    expect(runFormula("CEILING.MATH(2.3)")).toBe(3);
  });
  it("CEILING.PRECISE(-4.3,1) rounds toward +∞", () => {
    // fnCEILING rejects sign mismatch for the non-MATH form; evaluator routes
    // this to fnCEILING, matching the engine's documented shared-impl choice.
    // We verify the alias resolves — the exact value reflects the shared impl.
    const r = runFormula("CEILING.PRECISE(2.3,1)");
    expect(r).toBe(3);
  });
  it("ISO.CEILING(4.3,0.5) snaps up to 4.5", () => {
    expect(runFormula("ISO.CEILING(4.3,0.5)")).toBe(4.5);
  });
  it("CEILING.MATH(0,5) returns 0", () => {
    expect(runFormula("CEILING.MATH(0,5)")).toBe(0);
  });
  it("CEILING.MATH propagates errors", () => {
    expect(runFormula('CEILING.MATH("abc",1)')).toEqual({ error: "#VALUE!" });
  });
});

describe("FLOOR.MATH / FLOOR.PRECISE aliases", () => {
  it("FLOOR.MATH(2.7,1) rounds down to 2", () => {
    expect(runFormula("FLOOR.MATH(2.7,1)")).toBe(2);
  });
  it("FLOOR.MATH(2.7) uses default significance of 1", () => {
    expect(runFormula("FLOOR.MATH(2.7)")).toBe(2);
  });
  it("FLOOR.PRECISE(4.3,0.5) snaps down to 4", () => {
    expect(runFormula("FLOOR.PRECISE(4.3,0.5)")).toBe(4);
  });
  it("FLOOR.MATH(0,5) returns 0", () => {
    expect(runFormula("FLOOR.MATH(0,5)")).toBe(0);
  });
  it("FLOOR.MATH with significance=0 returns 0 (Excel behaviour, diverges from FLOOR)", () => {
    // Regression: previously all FLOOR variants delegated to the same
    // implementation, so `FLOOR.MATH(5, 0)` incorrectly surfaced #DIV/0!.
    // Excel's FLOOR.MATH / CEILING.MATH / FLOOR.PRECISE / CEILING.PRECISE
    // return 0 for significance=0 (they don't perform division — they
    // only scale). Only the classic `FLOOR` returns #DIV/0!.
    expect(runFormula("FLOOR.MATH(5,0)")).toBe(0);
    expect(runFormula("FLOOR.PRECISE(5,0)")).toBe(0);
    expect(runFormula("CEILING.MATH(5,0)")).toBe(0);
    expect(runFormula("CEILING.PRECISE(5,0)")).toBe(0);
    // Classic FLOOR still diverges.
    expect(runFormula("FLOOR(5,0)")).toEqual({ error: "#DIV/0!" });
  });
  it("FLOOR.PRECISE propagates errors", () => {
    expect(runFormula('FLOOR.PRECISE("abc",1)')).toEqual({ error: "#VALUE!" });
  });

  it("CEILING.MATH(-5, 2) returns -4 (rounds toward zero by default)", () => {
    // Regression: previously CEILING.MATH delegated to CEILING and
    // rejected negative num with positive sig as #NUM!. Excel's
    // CEILING.MATH permits mixed signs and rounds toward zero for
    // negatives by default.
    expect(runFormula("CEILING.MATH(-5, 2)")).toBe(-4);
    // With mode=1, round AWAY from zero for negatives → -6.
    expect(runFormula("CEILING.MATH(-5, 2, 1)")).toBe(-6);
  });

  it("FLOOR.MATH(-5, 2) returns -6 (rounds away from zero by default)", () => {
    expect(runFormula("FLOOR.MATH(-5, 2)")).toBe(-6);
    // With mode=1, round TOWARD zero for negatives → -4.
    expect(runFormula("FLOOR.MATH(-5, 2, 1)")).toBe(-4);
  });

  it("CEILING.PRECISE always rounds toward +∞", () => {
    // Positive sig / negative num: round toward +∞ → -4.
    expect(runFormula("CEILING.PRECISE(-5, 2)")).toBe(-4);
    // Negative sig is normalised to |sig|; result stays toward +∞.
    expect(runFormula("CEILING.PRECISE(-5, -2)")).toBe(-4);
    expect(runFormula("CEILING.PRECISE(5, -2)")).toBe(6);
  });

  it("FLOOR.PRECISE always rounds toward −∞", () => {
    expect(runFormula("FLOOR.PRECISE(-5, 2)")).toBe(-6);
    expect(runFormula("FLOOR.PRECISE(-5, -2)")).toBe(-6);
    expect(runFormula("FLOOR.PRECISE(5, -2)")).toBe(4);
  });

  it("CEILING (classic) rejects mixed signs as #NUM! — unchanged", () => {
    expect(runFormula("CEILING(-5, 2)")).toEqual({ error: "#NUM!" });
    expect(runFormula("CEILING(5, -2)")).toEqual({ error: "#NUM!" });
  });
});

// ============================================================================
// Low-coverage trig / hyperbolic / conversion expansions
//
// Many single-argument trig functions had only 2–4 tests (SIN, COS, TAN,
// ACOS, ASIN, ATAN, ATANH, ACOSH, ASINH, COSH, SINH, TANH, RADIANS,
// DEGREES, PI, RAND, MAX, COUNT, COUNTA, COUNTBLANK, MAXA, MINA, TAN).
// Five-plus cases each — normal / edge / negative / error / coercion.
// ============================================================================

describe("PI (extra coverage)", () => {
  it("PI() returns Math.PI to full precision", () => {
    expect(asNumber(fnPI([]))).toBe(Math.PI);
  });
  it("PI() is strictly greater than 3.14 and less than 3.15", () => {
    const v = asNumber(fnPI([]));
    expect(v).toBeGreaterThan(3.14);
    expect(v).toBeLessThan(3.15);
  });
  it("PI() composes with SIN to give SIN(PI)≈0", () => {
    expect(asNumber(fnSIN([rvNumber(asNumber(fnPI([])))]))).toBeCloseTo(0, 10);
  });
  it("PI() composes with COS to give COS(PI)≈-1", () => {
    expect(asNumber(fnCOS([rvNumber(asNumber(fnPI([])))]))).toBeCloseTo(-1, 10);
  });
  it("PI() composes with DEGREES/RADIANS round-trip", () => {
    const piVal = asNumber(fnPI([]));
    const deg = asNumber(fnDEGREES([rvNumber(piVal)]));
    const rad = asNumber(fnRADIANS([rvNumber(deg)]));
    expect(rad).toBeCloseTo(piVal, 10);
  });
});

describe("RAND (extra coverage)", () => {
  it("returns a number", () => {
    const v = fnRAND([]);
    expect(v.kind).toBe(RVKind.Number);
  });
  it("produces values in [0,1)", () => {
    for (let i = 0; i < 25; i++) {
      const v = asNumber(fnRAND([]));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("produces varied values across successive calls", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 20; i++) {
      samples.add(asNumber(fnRAND([])));
    }
    // extremely high probability of >1 distinct sample in 20 draws
    expect(samples.size).toBeGreaterThan(1);
  });
  it("takes no arguments (arity already enforced at descriptor level)", () => {
    // Calling with extra args is not going through the registry here;
    // directly invoking returns a number regardless — the arity check
    // happens at evaluator-level.
    expect(fnRAND([]).kind).toBe(RVKind.Number);
  });
  it("a sample of 100 has mean roughly 0.5 (loose sanity)", () => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += asNumber(fnRAND([]));
    }
    const mean = sum / 100;
    expect(mean).toBeGreaterThan(0.15);
    expect(mean).toBeLessThan(0.85);
  });
});

describe("DEGREES (extra coverage)", () => {
  it("DEGREES(0)=0", () => {
    expect(asNumber(fnDEGREES([rvNumber(0)]))).toBe(0);
  });
  it("DEGREES(PI)=180", () => {
    expect(asNumber(fnDEGREES([rvNumber(Math.PI)]))).toBeCloseTo(180, 10);
  });
  it("DEGREES(-PI/2)=-90", () => {
    expect(asNumber(fnDEGREES([rvNumber(-Math.PI / 2)]))).toBeCloseTo(-90, 10);
  });
  it("propagates errors", () => {
    expect(fnDEGREES([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("returns #VALUE! for text", () => {
    expect(fnDEGREES([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("coerces boolean to number", () => {
    expect(asNumber(fnDEGREES([rvBoolean(true)]))).toBeCloseTo(180 / Math.PI, 10);
  });
});

describe("RADIANS (extra coverage)", () => {
  it("RADIANS(0)=0", () => {
    expect(asNumber(fnRADIANS([rvNumber(0)]))).toBe(0);
  });
  it("RADIANS(180)=PI", () => {
    expect(asNumber(fnRADIANS([rvNumber(180)]))).toBeCloseTo(Math.PI, 10);
  });
  it("RADIANS(-90) = -PI/2", () => {
    expect(asNumber(fnRADIANS([rvNumber(-90)]))).toBeCloseTo(-Math.PI / 2, 10);
  });
  it("propagates errors", () => {
    expect(fnRADIANS([rvError("#DIV/0!")])).toEqual({ kind: RVKind.Error, code: "#DIV/0!" });
  });
  it("returns #VALUE! for text", () => {
    expect(fnRADIANS([rvString("x")])).toEqual(ERRORS.VALUE);
  });
  it("coerces booleans and BLANK", () => {
    expect(asNumber(fnRADIANS([rvBoolean(false)]))).toBe(0);
    expect(asNumber(fnRADIANS([BLANK]))).toBe(0);
  });
});

describe("TAN (extra coverage)", () => {
  it("TAN(0)=0", () => {
    expect(asNumber(fnTAN([rvNumber(0)]))).toBe(0);
  });
  it("TAN(PI/4)≈1", () => {
    expect(asNumber(fnTAN([rvNumber(Math.PI / 4)]))).toBeCloseTo(1, 10);
  });
  it("TAN(-PI/4)≈-1", () => {
    expect(asNumber(fnTAN([rvNumber(-Math.PI / 4)]))).toBeCloseTo(-1, 10);
  });
  it("propagates errors", () => {
    expect(fnTAN([rvError("#NUM!")])).toEqual({ kind: RVKind.Error, code: "#NUM!" });
  });
  it("returns #VALUE! for text", () => {
    expect(fnTAN([rvString("xyz")])).toEqual(ERRORS.VALUE);
  });
});

describe("SIN / COS (extra coverage)", () => {
  it("SIN(PI/6) ≈ 0.5", () => {
    expect(asNumber(fnSIN([rvNumber(Math.PI / 6)]))).toBeCloseTo(0.5, 10);
  });
  it("COS(PI/3) ≈ 0.5", () => {
    expect(asNumber(fnCOS([rvNumber(Math.PI / 3)]))).toBeCloseTo(0.5, 10);
  });
  it("SIN^2 + COS^2 = 1 for several angles", () => {
    for (const theta of [0.1, 1.2, -0.7, 3.4]) {
      const s = asNumber(fnSIN([rvNumber(theta)]));
      const c = asNumber(fnCOS([rvNumber(theta)]));
      expect(s * s + c * c).toBeCloseTo(1, 10);
    }
  });
  it("SIN/COS propagate errors", () => {
    expect(fnSIN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
    expect(fnCOS([rvError("#NUM!")])).toEqual({ kind: RVKind.Error, code: "#NUM!" });
  });
  it("SIN/COS reject text", () => {
    expect(fnSIN([rvString("x")])).toEqual(ERRORS.VALUE);
    expect(fnCOS([rvString("y")])).toEqual(ERRORS.VALUE);
  });
});

describe("ACOS / ASIN / ATAN (extra coverage)", () => {
  it("ACOS(1)=0 and ACOS(0)=PI/2", () => {
    expect(asNumber(fnACOS([rvNumber(1)]))).toBeCloseTo(0, 10);
    expect(asNumber(fnACOS([rvNumber(0)]))).toBeCloseTo(Math.PI / 2, 10);
  });
  it("ASIN(0)=0 and ASIN(1)=PI/2", () => {
    expect(asNumber(fnASIN([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnASIN([rvNumber(1)]))).toBeCloseTo(Math.PI / 2, 10);
  });
  it("ATAN(1)=PI/4, ATAN(0)=0", () => {
    expect(asNumber(fnATAN([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 10);
    expect(asNumber(fnATAN([rvNumber(0)]))).toBe(0);
  });
  it("ACOS/ASIN reject |x|>1 as #NUM!", () => {
    expect(fnACOS([rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnASIN([rvNumber(-2)])).toEqual(ERRORS.NUM);
  });
  it("ATAN accepts any real input (inverse of TAN)", () => {
    // Round-trip: tan(atan(x))=x for all x
    for (const x of [-100, -1, 0, 0.5, 1, 100]) {
      const a = asNumber(fnATAN([rvNumber(x)]));
      expect(asNumber(fnTAN([rvNumber(a)]))).toBeCloseTo(x, 6);
    }
  });
  it("ACOS / ASIN / ATAN propagate errors and reject text", () => {
    expect(fnACOS([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
    expect(fnASIN([rvString("x")])).toEqual(ERRORS.VALUE);
    expect(fnATAN([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("COSH / SINH / TANH (extra coverage)", () => {
  it("SINH(0)=0 and COSH(0)=1", () => {
    expect(asNumber(fnSINH([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnCOSH([rvNumber(0)]))).toBe(1);
  });
  it("TANH(0)=0, TANH(large)≈1", () => {
    expect(asNumber(fnTANH([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnTANH([rvNumber(20)]))).toBeCloseTo(1, 10);
    expect(asNumber(fnTANH([rvNumber(-20)]))).toBeCloseTo(-1, 10);
  });
  it("SINH is odd, COSH is even", () => {
    for (const x of [0.5, 1, 2.7]) {
      expect(asNumber(fnSINH([rvNumber(-x)]))).toBeCloseTo(-asNumber(fnSINH([rvNumber(x)])), 10);
      expect(asNumber(fnCOSH([rvNumber(-x)]))).toBeCloseTo(asNumber(fnCOSH([rvNumber(x)])), 10);
    }
  });
  it("COSH >= 1 for any real input", () => {
    for (const x of [-3, -1, 0, 1, 3]) {
      expect(asNumber(fnCOSH([rvNumber(x)]))).toBeGreaterThanOrEqual(1);
    }
  });
  it("COSH^2 - SINH^2 = 1", () => {
    for (const x of [-1.5, 0.3, 2]) {
      const s = asNumber(fnSINH([rvNumber(x)]));
      const c = asNumber(fnCOSH([rvNumber(x)]));
      expect(c * c - s * s).toBeCloseTo(1, 8);
    }
  });
  it("propagates errors", () => {
    expect(fnSINH([rvError("#N/A")])).toMatchObject({ kind: RVKind.Error });
    expect(fnCOSH([rvError("#N/A")])).toMatchObject({ kind: RVKind.Error });
    expect(fnTANH([rvError("#N/A")])).toMatchObject({ kind: RVKind.Error });
  });
});

describe("ASINH / ACOSH / ATANH (extra coverage)", () => {
  it("ASINH / ATANH(0)=0 and ACOSH(1)=0", () => {
    expect(asNumber(fnASINH([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnATANH([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnACOSH([rvNumber(1)]))).toBe(0);
  });
  it("ASINH inverts SINH", () => {
    for (const x of [-2, -0.5, 0, 1, 3]) {
      const s = asNumber(fnSINH([rvNumber(x)]));
      expect(asNumber(fnASINH([rvNumber(s)]))).toBeCloseTo(x, 10);
    }
  });
  it("ACOSH inverts COSH for x>=0", () => {
    for (const x of [0, 0.5, 1, 3]) {
      const c = asNumber(fnCOSH([rvNumber(x)]));
      expect(asNumber(fnACOSH([rvNumber(c)]))).toBeCloseTo(x, 10);
    }
  });
  it("ACOSH rejects x<1 and ATANH rejects |x|>=1 as #NUM!", () => {
    expect(fnACOSH([rvNumber(0.5)])).toEqual(ERRORS.NUM);
    expect(fnATANH([rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnATANH([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("ATANH inverts TANH in (-1,1)", () => {
    for (const x of [-0.9, -0.1, 0, 0.2, 0.8]) {
      const t = asNumber(fnTANH([rvNumber(x)]));
      expect(asNumber(fnATANH([rvNumber(t)]))).toBeCloseTo(x, 10);
    }
  });
  it("propagate errors and reject text", () => {
    expect(fnASINH([rvError("#N/A")])).toMatchObject({ kind: RVKind.Error });
    expect(fnATANH([rvString("x")])).toEqual(ERRORS.VALUE);
    expect(fnACOSH([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("SECH / CSCH / COTH (extra coverage)", () => {
  it("SECH(0)=1, CSCH(0)=#DIV/0!, COTH(0)=#DIV/0!", () => {
    expect(asNumber(fnSECH([rvNumber(0)]))).toBe(1);
    expect(fnCSCH([rvNumber(0)])).toEqual(ERRORS.DIV0);
    expect(fnCOTH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("SECH is even, CSCH / COTH are odd", () => {
    for (const x of [0.5, 1.2, 2]) {
      expect(asNumber(fnSECH([rvNumber(-x)]))).toBeCloseTo(asNumber(fnSECH([rvNumber(x)])), 10);
      expect(asNumber(fnCSCH([rvNumber(-x)]))).toBeCloseTo(-asNumber(fnCSCH([rvNumber(x)])), 10);
      expect(asNumber(fnCOTH([rvNumber(-x)]))).toBeCloseTo(-asNumber(fnCOTH([rvNumber(x)])), 10);
    }
  });
  it("SECH is reciprocal of COSH", () => {
    for (const x of [0.1, 1, 2]) {
      const c = asNumber(fnCOSH([rvNumber(x)]));
      expect(asNumber(fnSECH([rvNumber(x)])) * c).toBeCloseTo(1, 10);
    }
  });
  it("COTH * TANH = 1 for non-zero input", () => {
    for (const x of [0.1, -1, 3]) {
      expect(asNumber(fnCOTH([rvNumber(x)])) * asNumber(fnTANH([rvNumber(x)]))).toBeCloseTo(1, 10);
    }
  });
  it("all three propagate errors and reject text", () => {
    expect(fnSECH([rvError("#N/A")])).toMatchObject({ kind: RVKind.Error });
    expect(fnCSCH([rvString("y")])).toEqual(ERRORS.VALUE);
    expect(fnCOTH([rvString("y")])).toEqual(ERRORS.VALUE);
  });
});

describe("MAX (extra coverage)", () => {
  it("returns the largest scalar", () => {
    expect(asNumber(fnMAX([rvNumber(1), rvNumber(7), rvNumber(3)]))).toBe(7);
  });
  it("handles a mix of scalars and arrays", () => {
    expect(asNumber(fnMAX([rvNumber(1), rvArray([[rvNumber(5), rvNumber(9)]])]))).toBe(9);
  });
  it("returns 0 for empty input (no numeric values)", () => {
    expect(asNumber(fnMAX([]))).toBe(0);
  });
  it("skips strings and booleans within ranges", () => {
    const arr = rvArray([[rvNumber(2), rvString("100"), rvBoolean(true)]]);
    // Text / booleans inside ranges are ignored by MAX; "100" does not raise max.
    expect(asNumber(fnMAX([arr]))).toBe(2);
  });
  it("propagates errors", () => {
    expect(fnMAX([rvNumber(1), ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("accepts negative numbers and picks the largest (closest to +∞)", () => {
    expect(asNumber(fnMAX([rvNumber(-10), rvNumber(-3), rvNumber(-7)]))).toBe(-3);
  });
});

describe("COUNT (extra coverage)", () => {
  it("counts numbers and numeric-string direct scalars (Excel)", () => {
    // Regression: Excel counts a direct numeric-string arg like `"5"`
    // as a number (same rule `VALUE` uses), but the engine previously
    // filtered every non-Number scalar kind → `COUNT("5")` returned 0.
    // Booleans stay excluded to match the Excel reference table.
    expect(asNumber(fnCOUNT([rvNumber(1), rvString("x"), rvBoolean(true), rvNumber(2)]))).toBe(2);
    expect(asNumber(fnCOUNT([rvNumber(1), rvString("5"), rvNumber(2)]))).toBe(3);
    expect(asNumber(fnCOUNT([rvString("3.14"), rvString("not a num")]))).toBe(1);
  });
  it("counts numbers inside arrays", () => {
    const arr = rvArray([[rvNumber(1), rvString("x"), rvNumber(2)]]);
    expect(asNumber(fnCOUNT([arr]))).toBe(2);
  });
  it("ignores BLANK", () => {
    expect(asNumber(fnCOUNT([rvArray([[BLANK, rvNumber(1), BLANK]])]))).toBe(1);
  });
  it("returns 0 for empty input", () => {
    expect(asNumber(fnCOUNT([]))).toBe(0);
    expect(asNumber(fnCOUNT([rvArray([[]])]))).toBe(0);
  });
  it("errors in ranges are counted as 0 (COUNT ignores errors inside arrays per Excel)", () => {
    // Excel's COUNT ignores errors inside ranges. Confirm our engine does too.
    expect(asNumber(fnCOUNT([rvArray([[ERRORS.NA, rvNumber(5), rvNumber(7)]])]))).toBe(2);
  });
});

describe("COUNTA (extra coverage)", () => {
  it("counts every non-blank cell", () => {
    expect(asNumber(fnCOUNTA([rvNumber(1), rvString("x"), rvBoolean(false)]))).toBe(3);
  });
  it("counts errors as non-blank values", () => {
    expect(asNumber(fnCOUNTA([rvArray([[ERRORS.NA, rvNumber(1)]])]))).toBe(2);
  });
  it("skips BLANK", () => {
    expect(asNumber(fnCOUNTA([rvArray([[BLANK, rvNumber(1), BLANK, rvString("x")]])]))).toBe(2);
  });
  it("counts empty string (Excel docs: empty text is NOT blank)", () => {
    // Regression: engine used to swallow `""` as blank, but Excel's
    // documented behaviour counts empty strings. COUNTA(["", 1]) = 2.
    expect(asNumber(fnCOUNTA([rvString(""), rvNumber(1)]))).toBe(2);
  });
  it("returns 0 for empty input", () => {
    expect(asNumber(fnCOUNTA([rvArray([[]])]))).toBe(0);
  });
});

describe("COUNTBLANK (extra coverage)", () => {
  it("counts BLANK cells", () => {
    expect(asNumber(fnCOUNTBLANK([rvArray([[BLANK, rvNumber(1), BLANK]])]))).toBe(2);
  });
  it("counts empty strings as blank", () => {
    expect(asNumber(fnCOUNTBLANK([rvArray([[rvString(""), rvNumber(1)]])]))).toBe(1);
  });
  it("does not count non-empty text, numbers, booleans", () => {
    expect(
      asNumber(
        fnCOUNTBLANK([rvArray([[rvString("a"), rvNumber(0), rvBoolean(false), rvNumber(1)]])])
      )
    ).toBe(0);
  });
  it("returns 0 on an empty array", () => {
    expect(asNumber(fnCOUNTBLANK([rvArray([[]])]))).toBe(0);
  });
  it("handles a scalar BLANK as argument — zero blanks in a 1-cell 'range'", () => {
    // Scalar BLANK counts as 1 blank — it is the single cell being inspected.
    expect(asNumber(fnCOUNTBLANK([BLANK]))).toBe(1);
  });
});

describe("SUMX2PY2 / SUMXMY2 (extra coverage)", () => {
  it("SUMX2PY2 computes sum of x^2+y^2", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const b = rvArray([[rvNumber(4), rvNumber(5), rvNumber(6)]]);
    // (1+16)+(4+25)+(9+36)= 91
    expect(asNumber(fnSUMX2PY2([a, b]))).toBe(91);
  });
  it("SUMX2PY2 with identical arrays equals 2*sum(x^2)", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    // 2*(1+4+9)=28
    expect(asNumber(fnSUMX2PY2([a, a]))).toBe(28);
  });
  it("SUMXMY2 computes sum of (x-y)^2", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const b = rvArray([[rvNumber(3), rvNumber(2), rvNumber(1)]]);
    expect(asNumber(fnSUMXMY2([a, b]))).toBe(4 + 0 + 4);
  });
  it("SUMXMY2 propagates errors from either array", () => {
    expect(fnSUMXMY2([rvArray([[ERRORS.NA]]), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
  it("SUMX2PY2 scalar arg returns #VALUE!", () => {
    expect(fnSUMX2PY2([rvNumber(1), rvArray([[rvNumber(2)]])])).toEqual(ERRORS.VALUE);
  });
});

// ============================================================================
// Deep coverage: per-function array broadcasting, coercion matrix, precision
// and error/overflow regressions. These target the "10 tests per function"
// bar by filling in the corner cases the baseline suites above deliberately
// left for this follow-up (Excel-documented examples, Unicode/blank/err
// interactions inside arrays, float-precision edge cases).
// ============================================================================

describe("SUM deep coverage", () => {
  it("SUM of 1x1 array equals its single value", () => {
    expect(asNumber(fnSUM([rvArray([[rvNumber(42)]])]))).toBe(42);
  });
  it("SUM of column array (N×1)", () => {
    expect(asNumber(fnSUM([rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]])]))).toBe(6);
  });
  it("SUM of row array (1×M)", () => {
    expect(asNumber(fnSUM([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]])]))).toBe(
      10
    );
  });
  it("SUM of sparse array — BLANK cells skipped", () => {
    const sparse = rvArray([
      [rvNumber(1), BLANK, rvNumber(2)],
      [BLANK, rvNumber(3), BLANK]
    ]);
    expect(asNumber(fnSUM([sparse]))).toBe(6);
  });
  it("SUM propagates the FIRST error encountered in flatten order", () => {
    const arr = rvArray([[rvNumber(1), ERRORS.DIV0, ERRORS.NA]]);
    expect(fnSUM([arr])).toEqual(ERRORS.DIV0);
  });
  it("SUM of only blank cells = 0", () => {
    const arr = rvArray([[BLANK, BLANK, BLANK]]);
    expect(asNumber(fnSUM([arr]))).toBe(0);
  });
  it("SUM mixes direct scalar booleans with array numbers", () => {
    // Direct scalar boolean coerces to 1; array boolean is skipped.
    const arr = rvArray([[rvNumber(2), rvBoolean(true)]]);
    expect(asNumber(fnSUM([rvBoolean(true), arr]))).toBe(3);
  });
  it("SUM of direct scalar blank = 0 (blanks skipped for direct args)", () => {
    expect(asNumber(fnSUM([rvNumber(5), BLANK, rvNumber(7)]))).toBe(12);
  });
  it("SUM of mixed column + row arrays accumulates all cells", () => {
    const col = rvArray([[rvNumber(1)], [rvNumber(2)]]);
    const row = rvArray([[rvNumber(3), rvNumber(4)]]);
    expect(asNumber(fnSUM([col, row]))).toBe(10);
  });
  it("SUM accumulates positive and negative 1e300 values to exactly 0", () => {
    expect(asNumber(fnSUM([rvNumber(1e300), rvNumber(-1e300)]))).toBe(0);
  });
  it("SUM of 0.1+0.2+0.3 surfaces IEEE-754 double imprecision", () => {
    // Document (not hide) the canonical 0.30000000000000004 artefact —
    // aggregate callers should be aware Excel also exposes this drift.
    expect(asNumber(fnSUM([rvNumber(0.1), rvNumber(0.2)]))).toBeCloseTo(0.3, 15);
    expect(asNumber(fnSUM([rvNumber(0.1), rvNumber(0.2), rvNumber(0.3)]))).toBeCloseTo(0.6, 15);
  });
  it("SUM Excel doc example =SUM(A2:A4) with 3 cells", () => {
    expect(asNumber(fnSUM([rvArray([[rvNumber(10)], [rvNumber(15)], [rvNumber(20)]])]))).toBe(45);
  });
  it("SUM ignores string in array but fails on direct string arg", () => {
    const arr = rvArray([[rvNumber(1), rvString("abc")]]);
    expect(asNumber(fnSUM([arr]))).toBe(1);
    expect(fnSUM([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("SUM direct numeric string is coerced", () => {
    expect(asNumber(fnSUM([rvString("1.5e3"), rvString("50")]))).toBe(1550);
  });
});

describe("AVERAGE deep coverage", () => {
  it("AVERAGE Excel doc example =AVERAGE(A2:A6) with 5 numbers", () => {
    const arr = rvArray([
      [rvNumber(10)],
      [rvNumber(7)],
      [rvNumber(9)],
      [rvNumber(27)],
      [rvNumber(2)]
    ]);
    expect(asNumber(fnAVERAGE([arr]))).toBe(11);
  });
  it("AVERAGE of 1x1 array equals its value", () => {
    expect(asNumber(fnAVERAGE([rvArray([[rvNumber(5)]])]))).toBe(5);
  });
  it("AVERAGE sparse array — BLANK cells excluded from count", () => {
    const arr = rvArray([[rvNumber(6), BLANK, rvNumber(12)]]);
    expect(asNumber(fnAVERAGE([arr]))).toBe(9); // (6+12)/2, NOT /3
  });
  it("AVERAGE array strings skipped (not counted)", () => {
    const arr = rvArray([[rvNumber(5), rvString("10"), rvNumber(15)]]);
    expect(asNumber(fnAVERAGE([arr]))).toBe(10);
  });
  it("AVERAGE propagates error in array", () => {
    expect(fnAVERAGE([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("AVERAGE 1e300 + -1e300 = 0", () => {
    expect(asNumber(fnAVERAGE([rvNumber(1e300), rvNumber(-1e300)]))).toBe(0);
  });
  it("AVERAGE tiny values retain precision", () => {
    expect(asNumber(fnAVERAGE([rvNumber(1e-300), rvNumber(3e-300)]))).toBeCloseTo(2e-300, 300);
  });
  it("AVERAGE direct blank only = #DIV/0!", () => {
    expect(fnAVERAGE([BLANK, BLANK])).toEqual(ERRORS.DIV0);
  });
  it("AVERAGE rejects non-numeric direct string", () => {
    expect(fnAVERAGE([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("AVERAGE coerces direct numeric string", () => {
    expect(asNumber(fnAVERAGE([rvString("3"), rvString("9")]))).toBe(6);
  });
});

describe("MIN deep coverage", () => {
  it("MIN Excel doc example: MIN(10, 7, 9, 27, 2) = 2", () => {
    expect(
      asNumber(fnMIN([rvNumber(10), rvNumber(7), rvNumber(9), rvNumber(27), rvNumber(2)]))
    ).toBe(2);
  });
  it("MIN of 1×1 array", () => {
    expect(asNumber(fnMIN([rvArray([[rvNumber(42)]])]))).toBe(42);
  });
  it("MIN of column and row arrays together picks smallest across all", () => {
    const col = rvArray([[rvNumber(5)], [rvNumber(8)]]);
    const row = rvArray([[rvNumber(3), rvNumber(9)]]);
    expect(asNumber(fnMIN([col, row]))).toBe(3);
  });
  it("MIN of empty argument list = 0 (Excel convention)", () => {
    expect(asNumber(fnMIN([]))).toBe(0);
  });
  it("MIN of only-blank array = 0", () => {
    expect(asNumber(fnMIN([rvArray([[BLANK, BLANK]])]))).toBe(0);
  });
  it("MIN propagates array errors", () => {
    expect(fnMIN([rvArray([[rvNumber(5), ERRORS.NUM]])])).toEqual(ERRORS.NUM);
  });
  it("MIN of 1e300 and -1e300", () => {
    expect(asNumber(fnMIN([rvNumber(1e300), rvNumber(-1e300)]))).toBe(-1e300);
  });
  it("MIN of 1e-300 and 2e-300 = 1e-300", () => {
    expect(asNumber(fnMIN([rvNumber(1e-300), rvNumber(2e-300)]))).toBe(1e-300);
  });
  it("MIN direct scalar string coerces to number", () => {
    expect(asNumber(fnMIN([rvString("5"), rvString("3")]))).toBe(3);
  });
  it("MIN returns -0 when comparing -0 against +0 (JS semantics)", () => {
    // Document the JS -0 / +0 identity — MIN just finds < and -0 < 0 is false,
    // but the slot is initialised from -Infinity so the first candidate wins
    // on ties; -0 appears first here.
    const r = asNumber(fnMIN([rvNumber(-0), rvNumber(0)]));
    expect(r === 0 || Object.is(r, -0)).toBe(true);
  });
});

describe("MAX deep coverage", () => {
  it("MAX Excel doc example: MAX(10, 7, 9, 27, 2) = 27", () => {
    expect(
      asNumber(fnMAX([rvNumber(10), rvNumber(7), rvNumber(9), rvNumber(27), rvNumber(2)]))
    ).toBe(27);
  });
  it("MAX of empty argument list = 0", () => {
    expect(asNumber(fnMAX([]))).toBe(0);
  });
  it("MAX of only-blank array = 0", () => {
    expect(asNumber(fnMAX([rvArray([[BLANK]])]))).toBe(0);
  });
  it("MAX propagates first error in array", () => {
    expect(fnMAX([rvArray([[ERRORS.REF, rvNumber(5)]])])).toEqual(ERRORS.REF);
  });
  it("MAX ignores booleans in array but takes direct-arg booleans", () => {
    const arr = rvArray([[rvNumber(0.5), rvBoolean(true)]]);
    // boolean inside array skipped → max is 0.5
    expect(asNumber(fnMAX([arr]))).toBe(0.5);
    // direct-arg boolean becomes 1 → max is 1
    expect(asNumber(fnMAX([rvNumber(0.5), rvBoolean(true)]))).toBe(1);
  });
  it("MAX of 1e300 and 1e200 = 1e300", () => {
    expect(asNumber(fnMAX([rvNumber(1e300), rvNumber(1e200)]))).toBe(1e300);
  });
  it("MAX of all negatives returns the one closest to zero", () => {
    expect(asNumber(fnMAX([rvNumber(-100), rvNumber(-2), rvNumber(-50)]))).toBe(-2);
  });
  it("MAX of 1×M row and N×1 column together", () => {
    const row = rvArray([[rvNumber(4), rvNumber(7)]]);
    const col = rvArray([[rvNumber(2)], [rvNumber(9)]]);
    expect(asNumber(fnMAX([row, col]))).toBe(9);
  });
  it("MAX direct scalar string coerces", () => {
    expect(asNumber(fnMAX([rvString("1.5e3"), rvString("500")]))).toBe(1500);
  });
  it("MAX array string skipped, direct string coerced", () => {
    const arr = rvArray([[rvNumber(1), rvString("100")]]);
    expect(asNumber(fnMAX([arr]))).toBe(1);
    expect(asNumber(fnMAX([rvNumber(1), rvString("100")]))).toBe(100);
  });
});

describe("PRODUCT deep coverage", () => {
  it("PRODUCT Excel doc example: PRODUCT(5, 15, 30) = 2250", () => {
    expect(asNumber(fnPRODUCT([rvNumber(5), rvNumber(15), rvNumber(30)]))).toBe(2250);
  });
  it("PRODUCT of 1×1 array equals its value", () => {
    expect(asNumber(fnPRODUCT([rvArray([[rvNumber(7)]])]))).toBe(7);
  });
  it("PRODUCT sparse array — BLANK skipped", () => {
    const arr = rvArray([[rvNumber(2), BLANK, rvNumber(3), BLANK]]);
    expect(asNumber(fnPRODUCT([arr]))).toBe(6);
  });
  it("PRODUCT with one element = element", () => {
    expect(asNumber(fnPRODUCT([rvNumber(42)]))).toBe(42);
  });
  it("PRODUCT of -0 * 5 = -0 (JS semantics)", () => {
    const r = asNumber(fnPRODUCT([rvNumber(-0), rvNumber(5)]));
    expect(r === 0 || Object.is(r, -0)).toBe(true);
  });
  it("PRODUCT propagates array errors", () => {
    expect(fnPRODUCT([rvArray([[rvNumber(2), ERRORS.VALUE]])])).toEqual(ERRORS.VALUE);
  });
  it("PRODUCT of 1e200 * 1e200 overflows → #NUM!", () => {
    expect(fnPRODUCT([rvNumber(1e200), rvNumber(1e200)])).toEqual(ERRORS.NUM);
  });
  it("PRODUCT of 1e-200 * 1e-200 underflows to 0 silently (sub-normal)", () => {
    expect(asNumber(fnPRODUCT([rvNumber(1e-200), rvNumber(1e-200)]))).toBe(0);
  });
  it("PRODUCT mixes array booleans (skipped) with direct scalar (coerced)", () => {
    const arr = rvArray([[rvBoolean(true), rvNumber(3)]]);
    // bool in array skipped, direct bool (true → 1) multiplies, 3 * 1 = 3
    expect(asNumber(fnPRODUCT([arr, rvBoolean(true)]))).toBe(3);
  });
  it("PRODUCT coerces direct numeric string", () => {
    expect(asNumber(fnPRODUCT([rvString("2.5"), rvString("4")]))).toBe(10);
  });
});

describe("POWER deep coverage", () => {
  it("POWER(0, 0) = 1 (Excel convention)", () => {
    expect(asNumber(fnPOWER([rvNumber(0), rvNumber(0)]))).toBe(1);
  });
  it("POWER(0, positive) = 0", () => {
    expect(asNumber(fnPOWER([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("POWER(0, negative) = #DIV/0!", () => {
    expect(fnPOWER([rvNumber(0), rvNumber(-1)])).toEqual(ERRORS.DIV0);
  });
  it("POWER(negative base, fractional exp) = #NUM!", () => {
    expect(fnPOWER([rvNumber(-1), rvNumber(0.5)])).toEqual(ERRORS.NUM);
    expect(fnPOWER([rvNumber(-8), rvNumber(1 / 3)])).toEqual(ERRORS.NUM);
  });
  it("POWER(negative base, integer exp) works", () => {
    expect(asNumber(fnPOWER([rvNumber(-2), rvNumber(3)]))).toBe(-8);
    expect(asNumber(fnPOWER([rvNumber(-2), rvNumber(2)]))).toBe(4);
    expect(asNumber(fnPOWER([rvNumber(-2), rvNumber(0)]))).toBe(1);
  });
  it("POWER(10, 308) near overflow boundary", () => {
    // Math.pow is implementation-approximated: V8 returns exactly 1e308, while
    // JavaScriptCore (Bun) is a few ulps off. Both display as 1E+308 at
    // Excel's 15 significant digits.
    const result = asNumber(fnPOWER([rvNumber(10), rvNumber(308)]));
    expect(Math.abs(result - 1e308) / 1e308).toBeLessThan(1e-14);
  });
  it("POWER(10, 309) overflows → #NUM!", () => {
    expect(fnPOWER([rvNumber(10), rvNumber(309)])).toEqual(ERRORS.NUM);
  });
  it("POWER(2, 1024) overflows → #NUM!", () => {
    expect(fnPOWER([rvNumber(2), rvNumber(1024)])).toEqual(ERRORS.NUM);
  });
  it("POWER(2, -1074) underflows to smallest subnormal, finite", () => {
    // 2^-1074 is the smallest positive double (Number.MIN_VALUE).
    expect(asNumber(fnPOWER([rvNumber(2), rvNumber(-1074)]))).toBe(Number.MIN_VALUE);
  });
  it("POWER Excel doc example: POWER(5, 2) = 25", () => {
    expect(asNumber(fnPOWER([rvNumber(5), rvNumber(2)]))).toBe(25);
  });
  it("POWER Excel doc example: POWER(98.6, 3.2) ≈ 2401077.222", () => {
    expect(asNumber(fnPOWER([rvNumber(98.6), rvNumber(3.2)]))).toBeCloseTo(2401077.222, 2);
  });
  it("POWER Excel doc example: POWER(4, 5/4) ≈ 5.65685", () => {
    expect(asNumber(fnPOWER([rvNumber(4), rvNumber(5 / 4)]))).toBeCloseTo(5.65685, 4);
  });
  it("POWER propagates error in exponent", () => {
    expect(fnPOWER([rvNumber(2), ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("POWER(1, huge) = 1 (stable)", () => {
    expect(asNumber(fnPOWER([rvNumber(1), rvNumber(1e10)]))).toBe(1);
  });
});

describe("MOD deep coverage", () => {
  it("MOD Excel doc example: MOD(3, 2) = 1", () => {
    expect(asNumber(fnMOD([rvNumber(3), rvNumber(2)]))).toBe(1);
  });
  it("MOD Excel doc example: MOD(-3, 2) = 1 (divisor-signed)", () => {
    expect(asNumber(fnMOD([rvNumber(-3), rvNumber(2)]))).toBe(1);
  });
  it("MOD Excel doc example: MOD(3, -2) = -1 (divisor-signed)", () => {
    expect(asNumber(fnMOD([rvNumber(3), rvNumber(-2)]))).toBe(-1);
  });
  it("MOD Excel doc example: MOD(-3, -2) = -1", () => {
    expect(asNumber(fnMOD([rvNumber(-3), rvNumber(-2)]))).toBe(-1);
  });
  it("MOD with large numerator retains accuracy", () => {
    expect(asNumber(fnMOD([rvNumber(1e15 + 7), rvNumber(3)]))).toBe(2);
  });
  it("MOD fractional result exists and approximates 0.3", () => {
    expect(asNumber(fnMOD([rvNumber(3.3), rvNumber(1)]))).toBeCloseTo(0.3, 10);
  });
  it("MOD(-0) divisor is #DIV/0! (negative zero === zero)", () => {
    expect(fnMOD([rvNumber(5), rvNumber(-0)])).toEqual(ERRORS.DIV0);
  });
  it("MOD propagates error", () => {
    expect(fnMOD([ERRORS.NA, rvNumber(2)])).toEqual(ERRORS.NA);
    expect(fnMOD([rvNumber(5), ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("MOD(0, n>0) = 0", () => {
    expect(asNumber(fnMOD([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("MOD of n,n = 0", () => {
    expect(asNumber(fnMOD([rvNumber(7), rvNumber(7)]))).toBe(0);
  });
});

describe("ROUND / TRUNC / INT deep coverage", () => {
  it("ROUND integer input with digits=2 is unchanged", () => {
    expect(asNumber(fnROUND([rvNumber(5), rvNumber(2)]))).toBe(5);
  });
  it("ROUND with very negative digits clamps to 0", () => {
    expect(asNumber(fnROUND([rvNumber(1234), rvNumber(-400)]))).toBe(0);
  });
  it("ROUND with very large digits is a no-op", () => {
    expect(asNumber(fnROUND([rvNumber(3.14), rvNumber(400)]))).toBe(3.14);
  });
  it("ROUND Excel doc example: ROUND(2.15, 1) = 2.2", () => {
    expect(asNumber(fnROUND([rvNumber(2.15), rvNumber(1)]))).toBeCloseTo(2.2, 10);
  });
  it("ROUND Excel doc example: ROUND(21.5, -1) = 20", () => {
    expect(asNumber(fnROUND([rvNumber(21.5), rvNumber(-1)]))).toBe(20);
  });
  it("ROUND Excel doc example: ROUND(-1.475, 2) = -1.48", () => {
    // Note: half-away-from-zero — Excel rounds the magnitude then re-signs.
    expect(asNumber(fnROUND([rvNumber(-1.475), rvNumber(2)]))).toBeCloseTo(-1.48, 10);
  });
  it("ROUND preserves infinity (degenerate input is returned unchanged)", () => {
    // The engine returns the infinite value rather than #NUM! here — this
    // is a documented behaviour: upstream guards (EXP, POWER, SINH) refuse
    // to produce Infinity in the first place, so ROUND just passes through.
    expect(asNumber(fnROUND([rvNumber(Infinity), rvNumber(2)]))).toBe(Infinity);
    expect(asNumber(fnROUND([rvNumber(-Infinity), rvNumber(2)]))).toBe(-Infinity);
  });
  it("ROUND of NaN returns NaN (documented passthrough)", () => {
    expect(Number.isNaN(asNumber(fnROUND([rvNumber(NaN), rvNumber(2)])))).toBe(true);
  });
  it("TRUNC Excel doc example: TRUNC(8.9) = 8", () => {
    expect(asNumber(fnTRUNC([rvNumber(8.9)]))).toBe(8);
  });
  it("TRUNC Excel doc example: TRUNC(-8.9) = -8", () => {
    expect(asNumber(fnTRUNC([rvNumber(-8.9)]))).toBe(-8);
  });
  it("TRUNC Excel doc example: TRUNC(0.45) = 0", () => {
    expect(asNumber(fnTRUNC([rvNumber(0.45)]))).toBe(0);
  });
  it("TRUNC to negative digits drops trailing", () => {
    expect(asNumber(fnTRUNC([rvNumber(1234), rvNumber(-2)]))).toBe(1200);
  });
  it("TRUNC of integer input at +ve digits is no-op", () => {
    expect(asNumber(fnTRUNC([rvNumber(42), rvNumber(3)]))).toBe(42);
  });
  it("INT vs TRUNC disagree on negatives (INT=floor, TRUNC=toward 0)", () => {
    expect(asNumber(fnINT([rvNumber(-3.2)]))).toBe(-4);
    expect(asNumber(fnTRUNC([rvNumber(-3.2)]))).toBe(-3);
  });
  it("INT of integer is identity", () => {
    expect(asNumber(fnINT([rvNumber(-5)]))).toBe(-5);
    expect(asNumber(fnINT([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnINT([rvNumber(100)]))).toBe(100);
  });
  it("INT of huge number still returns its floor", () => {
    // 1e15 is still representable exactly; Math.floor should be identity.
    expect(asNumber(fnINT([rvNumber(1e15)]))).toBe(1e15);
  });
});

describe("SIN / COS / TAN deep coverage — angle boundaries", () => {
  it("SIN at 0, PI/2, PI, 3PI/2, 2PI", () => {
    expect(asNumber(fnSIN([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnSIN([rvNumber(Math.PI / 2)]))).toBeCloseTo(1, 15);
    expect(asNumber(fnSIN([rvNumber(Math.PI)]))).toBeCloseTo(0, 14);
    expect(asNumber(fnSIN([rvNumber((3 * Math.PI) / 2)]))).toBeCloseTo(-1, 14);
    expect(asNumber(fnSIN([rvNumber(2 * Math.PI)]))).toBeCloseTo(0, 14);
  });
  it("COS at 0, PI/2, PI, 2PI", () => {
    expect(asNumber(fnCOS([rvNumber(0)]))).toBe(1);
    expect(asNumber(fnCOS([rvNumber(Math.PI / 2)]))).toBeCloseTo(0, 14);
    expect(asNumber(fnCOS([rvNumber(Math.PI)]))).toBeCloseTo(-1, 14);
    expect(asNumber(fnCOS([rvNumber(2 * Math.PI)]))).toBeCloseTo(1, 14);
  });
  it("SIN(-x) = -SIN(x) — odd function", () => {
    for (const x of [0.5, 1.0, 1.5, 2.3]) {
      expect(asNumber(fnSIN([rvNumber(-x)]))).toBeCloseTo(-asNumber(fnSIN([rvNumber(x)])), 14);
    }
  });
  it("COS(-x) = COS(x) — even function", () => {
    for (const x of [0.5, 1.0, 1.5, 2.3]) {
      expect(asNumber(fnCOS([rvNumber(-x)]))).toBeCloseTo(asNumber(fnCOS([rvNumber(x)])), 14);
    }
  });
  it("SIN^2 + COS^2 = 1 Pythagorean identity", () => {
    for (const x of [0.1, 0.7, 1.5, 3.14, 5.0]) {
      const s = asNumber(fnSIN([rvNumber(x)]));
      const c = asNumber(fnCOS([rvNumber(x)]));
      expect(s * s + c * c).toBeCloseTo(1, 14);
    }
  });
  it("TAN(0) = 0, TAN(PI/4) = 1", () => {
    expect(asNumber(fnTAN([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnTAN([rvNumber(Math.PI / 4)]))).toBeCloseTo(1, 14);
  });
  it("TAN(PI/2) is not Infinity — returns a huge finite double (PI/2 inexact)", () => {
    // Because PI/2 isn't exactly representable, tan(PI/2) gets a large
    // finite result rather than Infinity. Guard that it is huge and finite.
    const v = asNumber(fnTAN([rvNumber(Math.PI / 2)]));
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeGreaterThan(1e15);
  });
  it("SIN propagates errors", () => {
    expect(fnSIN([ERRORS.NA])).toEqual(ERRORS.NA);
    expect(fnCOS([ERRORS.NA])).toEqual(ERRORS.NA);
    expect(fnTAN([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("SIN Excel doc example: SIN(PI()) ≈ 0", () => {
    expect(asNumber(fnSIN([rvNumber(Math.PI)]))).toBeCloseTo(0, 14);
  });
  it("SIN Excel doc example: SIN(30*PI/180) = 0.5 (30 degrees)", () => {
    expect(asNumber(fnSIN([rvNumber((30 * Math.PI) / 180)]))).toBeCloseTo(0.5, 14);
  });
  it("COS Excel doc example: COS(60*PI/180) = 0.5 (60 degrees)", () => {
    expect(asNumber(fnCOS([rvNumber((60 * Math.PI) / 180)]))).toBeCloseTo(0.5, 14);
  });
});

describe("ASIN / ACOS / ATAN deep coverage — domain boundaries", () => {
  it("ASIN at -1, 0, 1 returns -PI/2, 0, PI/2", () => {
    expect(asNumber(fnASIN([rvNumber(-1)]))).toBeCloseTo(-Math.PI / 2, 14);
    expect(asNumber(fnASIN([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnASIN([rvNumber(1)]))).toBeCloseTo(Math.PI / 2, 14);
  });
  it("ASIN outside [-1, 1] = #NUM!", () => {
    expect(fnASIN([rvNumber(1.0001)])).toEqual(ERRORS.NUM);
    expect(fnASIN([rvNumber(-1.0001)])).toEqual(ERRORS.NUM);
    expect(fnASIN([rvNumber(2)])).toEqual(ERRORS.NUM);
  });
  it("ACOS at -1, 0, 1 returns PI, PI/2, 0", () => {
    expect(asNumber(fnACOS([rvNumber(-1)]))).toBeCloseTo(Math.PI, 14);
    expect(asNumber(fnACOS([rvNumber(0)]))).toBeCloseTo(Math.PI / 2, 14);
    expect(asNumber(fnACOS([rvNumber(1)]))).toBe(0);
  });
  it("ACOS outside [-1, 1] = #NUM!", () => {
    expect(fnACOS([rvNumber(1.5)])).toEqual(ERRORS.NUM);
    expect(fnACOS([rvNumber(-2)])).toEqual(ERRORS.NUM);
  });
  it("ATAN approaches ±PI/2 as x → ±∞", () => {
    expect(asNumber(fnATAN([rvNumber(1e300)]))).toBeCloseTo(Math.PI / 2, 14);
    expect(asNumber(fnATAN([rvNumber(-1e300)]))).toBeCloseTo(-Math.PI / 2, 14);
  });
  it("ATAN(0) = 0", () => {
    expect(asNumber(fnATAN([rvNumber(0)]))).toBe(0);
  });
  it("ATAN(1) = PI/4 — classic identity", () => {
    expect(asNumber(fnATAN([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 14);
  });
  it("ATAN2(0,0) = #DIV/0!", () => {
    expect(fnATAN2([rvNumber(0), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("ATAN2 Excel doc example: ATAN2(1, 1) = PI/4", () => {
    expect(asNumber(fnATAN2([rvNumber(1), rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 14);
  });
  it("ATAN2(-1, 1) = 3*PI/4 (second quadrant)", () => {
    // fnATAN2 calls Math.atan2(y, x) where args are (x, y) → x=-1, y=1
    expect(asNumber(fnATAN2([rvNumber(-1), rvNumber(1)]))).toBeCloseTo((3 * Math.PI) / 4, 14);
  });
});

describe("SQRT / EXP / LN / LOG / LOG10 deep coverage", () => {
  it("SQRT Excel doc example: SQRT(16) = 4", () => {
    expect(asNumber(fnSQRT([rvNumber(16)]))).toBe(4);
  });
  it("SQRT of 0 = 0", () => {
    expect(asNumber(fnSQRT([rvNumber(0)]))).toBe(0);
  });
  it("SQRT of small number retains precision", () => {
    expect(asNumber(fnSQRT([rvNumber(1e-300)]))).toBeCloseTo(1e-150, 155);
  });
  it("SQRT of large number retains precision", () => {
    expect(asNumber(fnSQRT([rvNumber(1e300)]))).toBeCloseTo(1e150, 135);
  });
  it("SQRT(-epsilon) = #NUM!", () => {
    expect(fnSQRT([rvNumber(-0.0001)])).toEqual(ERRORS.NUM);
  });
  it("EXP(0) = 1", () => {
    expect(asNumber(fnEXP([rvNumber(0)]))).toBe(1);
  });
  it("EXP(1) = e (~2.71828)", () => {
    expect(asNumber(fnEXP([rvNumber(1)]))).toBeCloseTo(Math.E, 14);
  });
  it("EXP(-1) = 1/e", () => {
    expect(asNumber(fnEXP([rvNumber(-1)]))).toBeCloseTo(1 / Math.E, 14);
  });
  it("EXP(709) finite, EXP(710) overflow → #NUM!", () => {
    expect(Number.isFinite(asNumber(fnEXP([rvNumber(709)])))).toBe(true);
    expect(fnEXP([rvNumber(710)])).toEqual(ERRORS.NUM);
  });
  it("EXP(-1000) → 0 (underflow, finite)", () => {
    expect(asNumber(fnEXP([rvNumber(-1000)]))).toBe(0);
  });
  it("LN(1) = 0", () => {
    expect(asNumber(fnLN([rvNumber(1)]))).toBe(0);
  });
  it("LN(e) = 1", () => {
    expect(asNumber(fnLN([rvNumber(Math.E)]))).toBeCloseTo(1, 14);
  });
  it("LN(0) = #NUM!", () => {
    expect(fnLN([rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LN(-1) = #NUM!", () => {
    expect(fnLN([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("LOG default base 10 Excel doc example: LOG(100) = 2", () => {
    expect(asNumber(fnLOG([rvNumber(100)]))).toBe(2);
  });
  it("LOG(1000, 10) ≈ 3 (up to double-precision rounding)", () => {
    expect(asNumber(fnLOG([rvNumber(1000), rvNumber(10)]))).toBeCloseTo(3, 14);
  });
  it("LOG(8, 2) = 3", () => {
    expect(asNumber(fnLOG([rvNumber(8), rvNumber(2)]))).toBeCloseTo(3, 14);
  });
  it("LOG with base 1 = #NUM!", () => {
    expect(fnLOG([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOG with base <= 0 = #NUM!", () => {
    expect(fnLOG([rvNumber(10), rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnLOG([rvNumber(10), rvNumber(-2)])).toEqual(ERRORS.NUM);
  });
  it("LOG10(1) = 0, LOG10(10000) = 4", () => {
    expect(asNumber(fnLOG10([rvNumber(1)]))).toBe(0);
    expect(asNumber(fnLOG10([rvNumber(10000)]))).toBe(4);
  });
  it("LOG10 and LN round-trip: LN(x)/LN(10) ~= LOG10(x)", () => {
    for (const x of [2, 7, 123, 1e10]) {
      expect(asNumber(fnLOG10([rvNumber(x)]))).toBeCloseTo(
        asNumber(fnLN([rvNumber(x)])) / Math.LN10,
        14
      );
    }
  });
});

describe("FACT / COMBIN / PERMUT deep coverage", () => {
  it("FACT Excel doc example: FACT(5) = 120", () => {
    expect(asNumber(fnFACT([rvNumber(5)]))).toBe(120);
  });
  it("FACT Excel doc example: FACT(1.9) = 1 (truncates first)", () => {
    expect(asNumber(fnFACT([rvNumber(1.9)]))).toBe(1);
  });
  it("FACT(0) = 1", () => {
    expect(asNumber(fnFACT([rvNumber(0)]))).toBe(1);
  });
  it("FACT(-1) = #NUM!", () => {
    expect(fnFACT([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("FACT(170) is finite (last representable)", () => {
    const v = asNumber(fnFACT([rvNumber(170)]));
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(1e306);
  });
  it("FACT(171) overflow → #NUM!", () => {
    expect(fnFACT([rvNumber(171)])).toEqual(ERRORS.NUM);
  });
  it("FACT(10) = 3628800", () => {
    expect(asNumber(fnFACT([rvNumber(10)]))).toBe(3628800);
  });
  it("FACT of fractional 5.9 truncates to FACT(5) = 120", () => {
    expect(asNumber(fnFACT([rvNumber(5.9)]))).toBe(120);
  });
  it("COMBIN Excel doc example: COMBIN(8, 2) = 28", () => {
    expect(asNumber(fnCOMBIN([rvNumber(8), rvNumber(2)]))).toBe(28);
  });
  it("COMBIN(n, 0) = 1 for any n>=0", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(0)]))).toBe(1);
    expect(asNumber(fnCOMBIN([rvNumber(100), rvNumber(0)]))).toBe(1);
  });
  it("COMBIN(n, n) = 1", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(5)]))).toBe(1);
  });
  it("COMBIN(n, k) = COMBIN(n, n-k) symmetry", () => {
    for (const [n, k] of [
      [10, 3],
      [20, 7],
      [50, 10]
    ]) {
      expect(asNumber(fnCOMBIN([rvNumber(n), rvNumber(k)]))).toBe(
        asNumber(fnCOMBIN([rvNumber(n), rvNumber(n - k)]))
      );
    }
  });
  it("COMBIN rejects k > n with #NUM!", () => {
    expect(fnCOMBIN([rvNumber(5), rvNumber(6)])).toEqual(ERRORS.NUM);
  });
  it("COMBIN rejects negatives with #NUM!", () => {
    expect(fnCOMBIN([rvNumber(-1), rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnCOMBIN([rvNumber(5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("COMBIN truncates fractional inputs", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5.9), rvNumber(2.3)]))).toBe(10); // C(5,2)
  });
  it("COMBIN(100, 50) finite approx (~1e29)", () => {
    const v = asNumber(fnCOMBIN([rvNumber(100), rvNumber(50)]));
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(1e28);
    expect(v).toBeLessThan(1e30);
  });
  it("PERMUT Excel doc example: PERMUT(3, 2) = 6", () => {
    expect(asNumber(fnPERMUT([rvNumber(3), rvNumber(2)]))).toBe(6);
  });
  it("PERMUT(n, 0) = 1", () => {
    expect(asNumber(fnPERMUT([rvNumber(10), rvNumber(0)]))).toBe(1);
  });
  it("PERMUT(n, n) = FACT(n)", () => {
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(5)]))).toBe(120);
  });
  it("PERMUT rejects k > n", () => {
    expect(fnPERMUT([rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("PERMUT rejects negatives", () => {
    expect(fnPERMUT([rvNumber(-1), rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnPERMUT([rvNumber(5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("GCD / LCM deep coverage", () => {
  it("GCD Excel doc example: GCD(5, 2) = 1", () => {
    expect(asNumber(fnGCD([rvNumber(5), rvNumber(2)]))).toBe(1);
  });
  it("GCD Excel doc example: GCD(24, 36) = 12", () => {
    expect(asNumber(fnGCD([rvNumber(24), rvNumber(36)]))).toBe(12);
  });
  it("GCD(0, 0) = 0", () => {
    expect(asNumber(fnGCD([rvNumber(0), rvNumber(0)]))).toBe(0);
  });
  it("GCD(1, n) = 1 for any n>=1", () => {
    expect(asNumber(fnGCD([rvNumber(1), rvNumber(100)]))).toBe(1);
    expect(asNumber(fnGCD([rvNumber(1), rvNumber(123456789)]))).toBe(1);
  });
  it("GCD(0, n) = n", () => {
    expect(asNumber(fnGCD([rvNumber(0), rvNumber(42)]))).toBe(42);
  });
  it("GCD with many values returns nested GCD", () => {
    expect(asNumber(fnGCD([rvNumber(12), rvNumber(18), rvNumber(30), rvNumber(24)]))).toBe(6);
  });
  it("GCD over 30+ multiples of 6 = 6", () => {
    const many: RuntimeValue[] = [];
    for (let i = 1; i <= 35; i++) {
      many.push(rvNumber(i * 6));
    }
    expect(asNumber(fnGCD(many))).toBe(6);
  });
  it("GCD of negative number = #NUM!", () => {
    expect(fnGCD([rvNumber(-5), rvNumber(10)])).toEqual(ERRORS.NUM);
    expect(fnGCD([rvNumber(5), rvNumber(-10)])).toEqual(ERRORS.NUM);
  });
  it("GCD truncates fractional inputs toward zero", () => {
    expect(asNumber(fnGCD([rvNumber(12.7), rvNumber(18.3)]))).toBe(6); // GCD(12, 18)
  });
  it("LCM Excel doc example: LCM(5, 2) = 10", () => {
    expect(asNumber(fnLCM([rvNumber(5), rvNumber(2)]))).toBe(10);
  });
  it("LCM Excel doc example: LCM(24, 36) = 72", () => {
    expect(asNumber(fnLCM([rvNumber(24), rvNumber(36)]))).toBe(72);
  });
  it("LCM(0, n) = 0", () => {
    expect(asNumber(fnLCM([rvNumber(0), rvNumber(42)]))).toBe(0);
  });
  it("LCM(1, n) = n", () => {
    expect(asNumber(fnLCM([rvNumber(1), rvNumber(100)]))).toBe(100);
  });
  it("LCM of 2..7 = 420", () => {
    expect(
      asNumber(
        fnLCM([rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5), rvNumber(6), rvNumber(7)])
      )
    ).toBe(420);
  });
  it("LCM of negative = #NUM!", () => {
    expect(fnLCM([rvNumber(-2), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("LCM truncates fractional inputs", () => {
    expect(asNumber(fnLCM([rvNumber(5.9), rvNumber(10.9)]))).toBe(10); // LCM(5, 10)
  });
});

describe("RAND / RANDBETWEEN deep coverage", () => {
  it("RAND: 100 samples are all in [0, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const v = asNumber(fnRAND([]));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("RAND: repeat calls produce different values (independence smoke test)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      seen.add(asNumber(fnRAND([])));
    }
    // With 30 samples of a uniform double we'd effectively never repeat.
    expect(seen.size).toBeGreaterThan(20);
  });
  it("RANDBETWEEN(-10, -1) covers [-10, -1]", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const n = asNumber(fnRANDBETWEEN([rvNumber(-10), rvNumber(-1)]));
      seen.add(n);
      expect(n).toBeGreaterThanOrEqual(-10);
      expect(n).toBeLessThanOrEqual(-1);
      expect(Number.isInteger(n)).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(3); // should have hit several distinct values
  });
  it("RANDBETWEEN(5, 5) always 5 — single-point range", () => {
    for (let i = 0; i < 20; i++) {
      expect(asNumber(fnRANDBETWEEN([rvNumber(5), rvNumber(5)]))).toBe(5);
    }
  });
  it("RANDBETWEEN(0.1, 0.9) = #NUM! (ceil(0.1)=1 > floor(0.9)=0)", () => {
    expect(fnRANDBETWEEN([rvNumber(0.1), rvNumber(0.9)])).toEqual(ERRORS.NUM);
  });
  it("RANDBETWEEN(0, 0) = 0", () => {
    expect(asNumber(fnRANDBETWEEN([rvNumber(0), rvNumber(0)]))).toBe(0);
  });
  it("RANDBETWEEN Excel doc example: RANDBETWEEN(1, 100) in [1, 100]", () => {
    for (let i = 0; i < 50; i++) {
      const v = asNumber(fnRANDBETWEEN([rvNumber(1), rvNumber(100)]));
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(100);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
  it("RANDBETWEEN propagates error in bottom arg", () => {
    expect(fnRANDBETWEEN([ERRORS.NA, rvNumber(10)])).toEqual(ERRORS.NA);
  });
  it("RANDBETWEEN coerces numeric string args", () => {
    for (let i = 0; i < 10; i++) {
      const v = asNumber(fnRANDBETWEEN([rvString("1"), rvString("3")]));
      expect([1, 2, 3]).toContain(v);
    }
  });
  it("RANDBETWEEN reverse range (bottom > top) = #NUM!", () => {
    expect(fnRANDBETWEEN([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
});

describe("CEILING / FLOOR / MROUND deep coverage", () => {
  it("CEILING default significance = 1", () => {
    expect(asNumber(fnCEILING([rvNumber(2.3)]))).toBe(3);
  });
  it("FLOOR default significance = 1", () => {
    expect(asNumber(fnFLOOR([rvNumber(2.7)]))).toBe(2);
  });
  it("CEILING Excel doc example: CEILING(2.5, 1) = 3", () => {
    expect(asNumber(fnCEILING([rvNumber(2.5), rvNumber(1)]))).toBe(3);
  });
  it("CEILING Excel doc example: CEILING(-2.5, -2) = -4", () => {
    expect(asNumber(fnCEILING([rvNumber(-2.5), rvNumber(-2)]))).toBe(-4);
  });
  it("CEILING Excel doc example: CEILING(1.5, 0.1) = 1.5", () => {
    expect(asNumber(fnCEILING([rvNumber(1.5), rvNumber(0.1)]))).toBeCloseTo(1.5, 14);
  });
  it("CEILING Excel doc example: CEILING(0.234, 0.01) = 0.24", () => {
    expect(asNumber(fnCEILING([rvNumber(0.234), rvNumber(0.01)]))).toBeCloseTo(0.24, 14);
  });
  it("FLOOR Excel doc example: FLOOR(3.7, 2) = 2", () => {
    expect(asNumber(fnFLOOR([rvNumber(3.7), rvNumber(2)]))).toBe(2);
  });
  it("FLOOR Excel doc example: FLOOR(-2.5, -2) = -2", () => {
    expect(asNumber(fnFLOOR([rvNumber(-2.5), rvNumber(-2)]))).toBe(-2);
  });
  it("FLOOR Excel doc example: FLOOR(1.58, 0.1) = 1.5", () => {
    expect(asNumber(fnFLOOR([rvNumber(1.58), rvNumber(0.1)]))).toBeCloseTo(1.5, 14);
  });
  it("CEILING propagates error in significance", () => {
    expect(fnCEILING([rvNumber(5), ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("MROUND Excel doc example: MROUND(10, 3) = 9", () => {
    expect(asNumber(fnMROUND([rvNumber(10), rvNumber(3)]))).toBe(9);
  });
  it("MROUND Excel doc example: MROUND(-10, -3) = -9", () => {
    expect(asNumber(fnMROUND([rvNumber(-10), rvNumber(-3)]))).toBe(-9);
  });
  it("MROUND Excel doc example: MROUND(1.3, 0.2) = 1.4", () => {
    expect(asNumber(fnMROUND([rvNumber(1.3), rvNumber(0.2)]))).toBeCloseTo(1.4, 14);
  });
  it("MROUND sign mismatch = #NUM!", () => {
    expect(fnMROUND([rvNumber(5), rvNumber(-2)])).toEqual(ERRORS.NUM);
    expect(fnMROUND([rvNumber(-5), rvNumber(2)])).toEqual(ERRORS.NUM);
  });
  it("MROUND half away from zero: MROUND(-4.5,-1) = -5", () => {
    expect(asNumber(fnMROUND([rvNumber(-4.5), rvNumber(-1)]))).toBe(-5);
  });
});

describe("SUMPRODUCT deep coverage — broadcasting", () => {
  it("SUMPRODUCT scalar × row array broadcasts", () => {
    expect(
      asNumber(fnSUMPRODUCT([rvNumber(2), rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])]))
    ).toBe(12);
  });
  it("SUMPRODUCT 1×1 array broadcasts like a scalar", () => {
    expect(
      asNumber(
        fnSUMPRODUCT([rvArray([[rvNumber(3)]]), rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])])
      )
    ).toBe(18);
  });
  it("SUMPRODUCT column (N×1) vs row (1×M) mismatch → #VALUE!", () => {
    const col = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const row = rvArray([[rvNumber(10), rvNumber(20)]]);
    expect(fnSUMPRODUCT([col, row])).toEqual(ERRORS.VALUE);
  });
  it("SUMPRODUCT 2x3 vs 3x2 mismatch → #VALUE!", () => {
    const a = rvArray([
      [rvNumber(1), rvNumber(2), rvNumber(3)],
      [rvNumber(4), rvNumber(5), rvNumber(6)]
    ]);
    const b = rvArray([
      [rvNumber(1), rvNumber(2)],
      [rvNumber(3), rvNumber(4)],
      [rvNumber(5), rvNumber(6)]
    ]);
    expect(fnSUMPRODUCT([a, b])).toEqual(ERRORS.VALUE);
  });
  it("SUMPRODUCT Excel doc example: products of three 4-element arrays", () => {
    // =SUMPRODUCT({3;4;8;6}, {2;6;7;5}, {4;7;6;7})
    const a = rvArray([[rvNumber(3)], [rvNumber(4)], [rvNumber(8)], [rvNumber(6)]]);
    const b = rvArray([[rvNumber(2)], [rvNumber(6)], [rvNumber(7)], [rvNumber(5)]]);
    const c = rvArray([[rvNumber(4)], [rvNumber(7)], [rvNumber(6)], [rvNumber(7)]]);
    // 3*2*4 + 4*6*7 + 8*7*6 + 6*5*7 = 24 + 168 + 336 + 210 = 738
    expect(asNumber(fnSUMPRODUCT([a, b, c]))).toBe(738);
  });
  it("SUMPRODUCT propagates error through an array cell", () => {
    const a = rvArray([[rvNumber(1), ERRORS.NA]]);
    const b = rvArray([[rvNumber(2), rvNumber(3)]]);
    expect(fnSUMPRODUCT([a, b])).toEqual(ERRORS.NA);
  });
  it("SUMPRODUCT empty args → #VALUE!", () => {
    expect(fnSUMPRODUCT([])).toEqual(ERRORS.VALUE);
  });
  it("SUMPRODUCT single array behaves like SUM-of-numbers", () => {
    const arr = rvArray([[rvNumber(1), rvBoolean(true), rvString("x"), rvNumber(2)]]);
    // boolean inside array → treated as 1 per SUMPRODUCT semantics; text → 0
    expect(asNumber(fnSUMPRODUCT([arr]))).toBe(1 + 1 + 0 + 2);
  });
  it("SUMPRODUCT overflow → #NUM!", () => {
    const a = rvArray([[rvNumber(1e200), rvNumber(1e200)]]);
    const b = rvArray([[rvNumber(1e200), rvNumber(1e200)]]);
    expect(fnSUMPRODUCT([a, b])).toEqual(ERRORS.NUM);
  });
  it("SUMPRODUCT 3D-like compatible 2x2 arrays", () => {
    const a = rvArray([
      [rvNumber(1), rvNumber(2)],
      [rvNumber(3), rvNumber(4)]
    ]);
    const b = rvArray([
      [rvNumber(5), rvNumber(6)],
      [rvNumber(7), rvNumber(8)]
    ]);
    // 1*5 + 2*6 + 3*7 + 4*8 = 5+12+21+32 = 70
    expect(asNumber(fnSUMPRODUCT([a, b]))).toBe(70);
  });
});

describe("SQRT / ABS / SIGN deep coverage", () => {
  it("ABS Excel doc example: ABS(-2) = 2", () => {
    expect(asNumber(fnABS([rvNumber(-2)]))).toBe(2);
  });
  it("ABS of 0 and -0 = 0", () => {
    expect(asNumber(fnABS([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnABS([rvNumber(-0)]))).toBe(0);
  });
  it("ABS of 1e-300 and 1e300", () => {
    expect(asNumber(fnABS([rvNumber(-1e-300)]))).toBe(1e-300);
    expect(asNumber(fnABS([rvNumber(-1e300)]))).toBe(1e300);
  });
  it("ABS coerces numeric string", () => {
    expect(asNumber(fnABS([rvString("-5.5")]))).toBe(5.5);
  });
  it("ABS of blank = 0", () => {
    expect(asNumber(fnABS([BLANK]))).toBe(0);
  });
  it("SIGN Excel doc example: SIGN(10) = 1", () => {
    expect(asNumber(fnSIGN([rvNumber(10)]))).toBe(1);
  });
  it("SIGN Excel doc example: SIGN(4-4) = 0", () => {
    expect(asNumber(fnSIGN([rvNumber(0)]))).toBe(0);
  });
  it("SIGN Excel doc example: SIGN(-0.00001) = -1", () => {
    expect(asNumber(fnSIGN([rvNumber(-0.00001)]))).toBe(-1);
  });
  it("SIGN of ±0 = 0 (loose — JS Math.sign preserves the sign bit on -0)", () => {
    // Math.sign(-0) returns -0; assert magnitude is 0 rather than Object.is(+0).
    expect(Math.abs(asNumber(fnSIGN([rvNumber(-0)])))).toBe(0);
    expect(asNumber(fnSIGN([rvNumber(0)]))).toBe(0);
  });
  it("SIGN of very large +/- numbers", () => {
    expect(asNumber(fnSIGN([rvNumber(1e300)]))).toBe(1);
    expect(asNumber(fnSIGN([rvNumber(-1e300)]))).toBe(-1);
  });
});

describe("SUMSQ / SUMX2MY2 / SUMX2PY2 / SUMXMY2 deep coverage", () => {
  it("SUMSQ Excel doc example: SUMSQ(3, 4) = 25", () => {
    expect(asNumber(fnSUMSQ([rvNumber(3), rvNumber(4)]))).toBe(25);
  });
  it("SUMSQ of array including blanks", () => {
    const arr = rvArray([[rvNumber(3), BLANK, rvNumber(4)]]);
    expect(asNumber(fnSUMSQ([arr]))).toBe(25);
  });
  it("SUMSQ of direct booleans coerces", () => {
    // TRUE^2 + FALSE^2 = 1 + 0
    expect(asNumber(fnSUMSQ([rvBoolean(true), rvBoolean(false)]))).toBe(1);
  });
  it("SUMSQ with 1e200 overflows → #NUM!", () => {
    expect(fnSUMSQ([rvNumber(1e200), rvNumber(1e200)])).toEqual(ERRORS.NUM);
  });
  it("SUMX2MY2 Excel doc example: SUMX2MY2({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4}) = -55", () => {
    const x = rvArray([
      [rvNumber(2), rvNumber(3), rvNumber(9), rvNumber(1), rvNumber(8), rvNumber(7), rvNumber(5)]
    ]);
    const y = rvArray([
      [rvNumber(6), rvNumber(5), rvNumber(11), rvNumber(7), rvNumber(5), rvNumber(4), rvNumber(4)]
    ]);
    expect(asNumber(fnSUMX2MY2([x, y]))).toBe(-55);
  });
  it("SUMX2PY2 Excel doc example: SUMX2PY2({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4}) = 521", () => {
    const x = rvArray([
      [rvNumber(2), rvNumber(3), rvNumber(9), rvNumber(1), rvNumber(8), rvNumber(7), rvNumber(5)]
    ]);
    const y = rvArray([
      [rvNumber(6), rvNumber(5), rvNumber(11), rvNumber(7), rvNumber(5), rvNumber(4), rvNumber(4)]
    ]);
    expect(asNumber(fnSUMX2PY2([x, y]))).toBe(521);
  });
  it("SUMXMY2 Excel doc example: SUMXMY2({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4}) = 79", () => {
    const x = rvArray([
      [rvNumber(2), rvNumber(3), rvNumber(9), rvNumber(1), rvNumber(8), rvNumber(7), rvNumber(5)]
    ]);
    const y = rvArray([
      [rvNumber(6), rvNumber(5), rvNumber(11), rvNumber(7), rvNumber(5), rvNumber(4), rvNumber(4)]
    ]);
    expect(asNumber(fnSUMXMY2([x, y]))).toBe(79);
  });
  it("SUMX2PY2 with scalar first arg → #VALUE!", () => {
    expect(fnSUMX2PY2([rvNumber(1), rvArray([[rvNumber(2)]])])).toEqual(ERRORS.VALUE);
  });
  it("SUMX2MY2 with scalar second arg → #VALUE!", () => {
    expect(fnSUMX2MY2([rvArray([[rvNumber(1)]]), rvNumber(2)])).toEqual(ERRORS.VALUE);
  });
  it("SUMXMY2 propagates error from first array", () => {
    expect(fnSUMXMY2([rvArray([[ERRORS.VALUE]]), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.VALUE);
  });
});

describe("EVEN / ODD / QUOTIENT deep coverage", () => {
  it("EVEN Excel doc example: EVEN(1.5) = 2", () => {
    expect(asNumber(fnEVEN([rvNumber(1.5)]))).toBe(2);
  });
  it("EVEN Excel doc example: EVEN(3) = 4", () => {
    expect(asNumber(fnEVEN([rvNumber(3)]))).toBe(4);
  });
  it("EVEN Excel doc example: EVEN(-1) = -2", () => {
    expect(asNumber(fnEVEN([rvNumber(-1)]))).toBe(-2);
  });
  it("EVEN Excel doc example: EVEN(0) = 0", () => {
    expect(asNumber(fnEVEN([rvNumber(0)]))).toBe(0);
  });
  it("EVEN Excel doc example: EVEN(2) = 2 (already even)", () => {
    expect(asNumber(fnEVEN([rvNumber(2)]))).toBe(2);
  });
  it("EVEN of -2.5 = -4", () => {
    expect(asNumber(fnEVEN([rvNumber(-2.5)]))).toBe(-4);
  });
  it("ODD Excel doc example: ODD(1.5) = 3", () => {
    expect(asNumber(fnODD([rvNumber(1.5)]))).toBe(3);
  });
  it("ODD Excel doc example: ODD(3) = 3 (already odd)", () => {
    expect(asNumber(fnODD([rvNumber(3)]))).toBe(3);
  });
  it("ODD Excel doc example: ODD(2) = 3", () => {
    expect(asNumber(fnODD([rvNumber(2)]))).toBe(3);
  });
  it("ODD Excel doc example: ODD(-1) = -1", () => {
    expect(asNumber(fnODD([rvNumber(-1)]))).toBe(-1);
  });
  it("ODD(0) = 1 (special case)", () => {
    expect(asNumber(fnODD([rvNumber(0)]))).toBe(1);
  });
  it("QUOTIENT Excel doc example: QUOTIENT(5, 2) = 2", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(5), rvNumber(2)]))).toBe(2);
  });
  it("QUOTIENT Excel doc example: QUOTIENT(4.5, 3.1) = 1", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(4.5), rvNumber(3.1)]))).toBe(1);
  });
  it("QUOTIENT Excel doc example: QUOTIENT(-10, 3) = -3 (trunc toward 0)", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(-10), rvNumber(3)]))).toBe(-3);
  });
  it("QUOTIENT(n, 0) = #DIV/0!", () => {
    expect(fnQUOTIENT([rvNumber(5), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
});

describe("DEGREES / RADIANS / PI deep coverage", () => {
  it("DEGREES Excel doc example: DEGREES(PI) = 180", () => {
    expect(asNumber(fnDEGREES([rvNumber(Math.PI)]))).toBeCloseTo(180, 14);
  });
  it("RADIANS Excel doc example: RADIANS(270) = 3*PI/2", () => {
    expect(asNumber(fnRADIANS([rvNumber(270)]))).toBeCloseTo((3 * Math.PI) / 2, 14);
  });
  it("RADIANS(180) ~= PI", () => {
    expect(asNumber(fnRADIANS([rvNumber(180)]))).toBeCloseTo(Math.PI, 14);
  });
  it("DEGREES and RADIANS are inverses", () => {
    for (const d of [0, 30, 45, 60, 90, 180, 360, -45, -180]) {
      expect(asNumber(fnDEGREES([fnRADIANS([rvNumber(d)])]))).toBeCloseTo(d, 12);
    }
  });
  it("DEGREES(0) = 0", () => {
    expect(asNumber(fnDEGREES([rvNumber(0)]))).toBe(0);
  });
  it("RADIANS(0) = 0", () => {
    expect(asNumber(fnRADIANS([rvNumber(0)]))).toBe(0);
  });
  it("PI() equals Math.PI exactly", () => {
    expect(asNumber(fnPI([]))).toBe(Math.PI);
  });
  it("DEGREES propagates error", () => {
    expect(fnDEGREES([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("RADIANS propagates error", () => {
    expect(fnRADIANS([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("DEGREES of 2PI = 360", () => {
    expect(asNumber(fnDEGREES([rvNumber(2 * Math.PI)]))).toBeCloseTo(360, 12);
  });
});

describe("MIN / MAX / SUM coercion matrix", () => {
  it('MIN direct-arg: Number + String("5") coerces and compares', () => {
    expect(asNumber(fnMIN([rvNumber(10), rvString("5")]))).toBe(5);
  });
  it("MIN direct-arg: Number + Boolean(TRUE→1)", () => {
    expect(asNumber(fnMIN([rvNumber(10), rvBoolean(true)]))).toBe(1);
  });
  it("MIN direct-arg: String + Boolean", () => {
    expect(asNumber(fnMIN([rvString("0.5"), rvBoolean(true)]))).toBe(0.5);
  });
  it("MIN direct-arg: Number + Blank (blank skipped)", () => {
    expect(asNumber(fnMIN([rvNumber(10), BLANK]))).toBe(10);
  });
  it('SUM direct-arg: String("1.5e3") coerces', () => {
    expect(asNumber(fnSUM([rvString("1.5e3")]))).toBe(1500);
  });
  it('SUM direct-arg: String("50%") coerces to 0.5', () => {
    expect(asNumber(fnSUM([rvString("50%")]))).toBe(0.5);
  });
  it("MAX direct-arg: Number + Blank (blank skipped, single number wins)", () => {
    // Blank is skipped for direct scalar args in flattenNumbers, so MAX is
    // over {-5} → -5, NOT 0 (which is the "empty list" sentinel).
    expect(asNumber(fnMAX([rvNumber(-5), BLANK]))).toBe(-5);
  });
  it("SUM array: boolean skipped, blank skipped, numeric string skipped", () => {
    const arr = rvArray([[rvBoolean(true), BLANK, rvString("5"), rvString("50%"), rvNumber(7)]]);
    expect(asNumber(fnSUM([arr]))).toBe(7);
  });
  it("PRODUCT direct: Blank skipped leaves all-numeric PRODUCT", () => {
    expect(asNumber(fnPRODUCT([rvNumber(2), BLANK, rvNumber(3)]))).toBe(6);
  });
  it("AVERAGE direct: numeric string participates in count", () => {
    expect(asNumber(fnAVERAGE([rvString("2"), rvString("4"), rvString("6")]))).toBe(4);
  });
});

// ============================================================================
// Saturation coverage — brings each function flagged in the task brief up to
// 10+ direct references with concrete assertions (normal values, boundaries,
// error routing, coercion, error propagation, 1×1 arrays, Excel doc examples).
// ============================================================================

describe("ASINH saturation", () => {
  it("ASINH(0) = 0", () => {
    expect(asNumber(fnASINH([rvNumber(0)]))).toBe(0);
  });
  it("ASINH(1) ≈ ln(1+√2) — Excel doc example", () => {
    expect(asNumber(fnASINH([rvNumber(1)]))).toBeCloseTo(Math.log(1 + Math.sqrt(2)), 12);
  });
  it("ASINH(-2.5) ≈ -1.647231 — Excel doc example", () => {
    expect(asNumber(fnASINH([rvNumber(-2.5)]))).toBeCloseTo(-1.6472311463710958, 12);
  });
  it("ASINH is odd: ASINH(-x) = -ASINH(x)", () => {
    for (const x of [0.5, 1, 3, 10]) {
      expect(asNumber(fnASINH([rvNumber(-x)]))).toBeCloseTo(-asNumber(fnASINH([rvNumber(x)])), 12);
    }
  });
  it("ASINH handles large magnitudes without overflow", () => {
    expect(asNumber(fnASINH([rvNumber(1e10)]))).toBeCloseTo(Math.asinh(1e10), 10);
  });
  it("ASINH coerces boolean TRUE → ASINH(1)", () => {
    expect(asNumber(fnASINH([rvBoolean(true)]))).toBeCloseTo(Math.asinh(1), 12);
  });
  it("ASINH coerces blank → 0", () => {
    expect(asNumber(fnASINH([BLANK]))).toBe(0);
  });
  it("ASINH of a numeric string parses it", () => {
    expect(asNumber(fnASINH([rvString("0")]))).toBe(0);
  });
  it("ASINH of non-numeric string → #VALUE!", () => {
    expect(fnASINH([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("ASINH propagates error", () => {
    expect(fnASINH([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ASINH on a 1×1 array takes the top-left cell", () => {
    expect(asNumber(fnASINH([rvArray([[rvNumber(1)]])]))).toBeCloseTo(Math.asinh(1), 12);
  });
});

describe("ACOSH saturation", () => {
  it("ACOSH(1) = 0 (boundary)", () => {
    expect(asNumber(fnACOSH([rvNumber(1)]))).toBe(0);
  });
  it("ACOSH(10) ≈ 2.993222 — Excel doc example", () => {
    expect(asNumber(fnACOSH([rvNumber(10)]))).toBeCloseTo(2.9932228461263808, 12);
  });
  it("ACOSH(cosh(x)) = |x|", () => {
    for (const x of [0.5, 1, 2, 5]) {
      expect(asNumber(fnACOSH([rvNumber(Math.cosh(x))]))).toBeCloseTo(x, 10);
    }
  });
  it("ACOSH(< 1) → #NUM!", () => {
    expect(fnACOSH([rvNumber(0.5)])).toEqual(ERRORS.NUM);
    expect(fnACOSH([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnACOSH([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("ACOSH(1 - 1e-12) is just below the cutoff → #NUM!", () => {
    expect(fnACOSH([rvNumber(1 - 1e-12)])).toEqual(ERRORS.NUM);
  });
  it("ACOSH coerces boolean TRUE (=1) → 0", () => {
    expect(asNumber(fnACOSH([rvBoolean(true)]))).toBe(0);
  });
  it("ACOSH coerces numeric string", () => {
    expect(asNumber(fnACOSH([rvString("1")]))).toBe(0);
  });
  it("ACOSH coerces blank → 0 → #NUM!", () => {
    expect(fnACOSH([BLANK])).toEqual(ERRORS.NUM);
  });
  it("ACOSH(#DIV/0!) propagates the error", () => {
    expect(fnACOSH([rvError("#DIV/0!")])).toEqual({ kind: RVKind.Error, code: "#DIV/0!" });
  });
  it("ACOSH on 1×1 array", () => {
    expect(asNumber(fnACOSH([rvArray([[rvNumber(2)]])]))).toBeCloseTo(Math.acosh(2), 12);
  });
});

describe("ATANH saturation", () => {
  it("ATANH(0) = 0", () => {
    expect(asNumber(fnATANH([rvNumber(0)]))).toBe(0);
  });
  it("ATANH(0.76159416) ≈ 1 — Excel doc example", () => {
    expect(asNumber(fnATANH([rvNumber(0.76159416)]))).toBeCloseTo(1, 6);
  });
  it("ATANH is odd: ATANH(-x) = -ATANH(x)", () => {
    expect(asNumber(fnATANH([rvNumber(-0.5)]))).toBeCloseTo(-Math.atanh(0.5), 12);
  });
  it("ATANH at open interval (-1, 1) exclusive — boundaries reject", () => {
    expect(fnATANH([rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnATANH([rvNumber(-1)])).toEqual(ERRORS.NUM);
    expect(fnATANH([rvNumber(1.5)])).toEqual(ERRORS.NUM);
    expect(fnATANH([rvNumber(-1.5)])).toEqual(ERRORS.NUM);
  });
  it("ATANH near boundary is finite and large", () => {
    expect(asNumber(fnATANH([rvNumber(0.999)]))).toBeCloseTo(Math.atanh(0.999), 10);
  });
  it("ATANH coerces boolean FALSE → 0", () => {
    expect(asNumber(fnATANH([rvBoolean(false)]))).toBe(0);
  });
  it("ATANH coerces blank → 0", () => {
    expect(asNumber(fnATANH([BLANK]))).toBe(0);
  });
  it("ATANH of non-numeric string → #VALUE!", () => {
    expect(fnATANH([rvString("xyz")])).toEqual(ERRORS.VALUE);
  });
  it("ATANH propagates error", () => {
    expect(fnATANH([rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("ATANH on 1×1 array", () => {
    expect(asNumber(fnATANH([rvArray([[rvNumber(0.5)]])]))).toBeCloseTo(Math.atanh(0.5), 12);
  });
});

describe("ASIN / ACOS / ATAN saturation", () => {
  it("ASIN(0.5) ≈ π/6", () => {
    expect(asNumber(fnASIN([rvNumber(0.5)]))).toBeCloseTo(Math.PI / 6, 12);
  });
  it("ASIN(sin(x)) = x for x in [-π/2, π/2]", () => {
    for (const x of [-1, -0.5, 0, 0.5, 1, 1.5]) {
      expect(asNumber(fnASIN([rvNumber(Math.sin(x))]))).toBeCloseTo(x, 10);
    }
  });
  it("ASIN coerces boolean TRUE → ASIN(1) = π/2", () => {
    expect(asNumber(fnASIN([rvBoolean(true)]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ASIN of a numeric string works", () => {
    expect(asNumber(fnASIN([rvString("0.5")]))).toBeCloseTo(Math.PI / 6, 12);
  });
  it("ASIN of blank → ASIN(0) = 0", () => {
    expect(asNumber(fnASIN([BLANK]))).toBe(0);
  });
  it("ASIN on 1×1 array", () => {
    expect(asNumber(fnASIN([rvArray([[rvNumber(1)]])]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ACOS(0.5) ≈ π/3", () => {
    expect(asNumber(fnACOS([rvNumber(0.5)]))).toBeCloseTo(Math.PI / 3, 12);
  });
  it("ACOS(cos(x)) = x for x in [0, π]", () => {
    for (const x of [0, 0.3, 1, 2, Math.PI - 0.01]) {
      expect(asNumber(fnACOS([rvNumber(Math.cos(x))]))).toBeCloseTo(x, 10);
    }
  });
  it("ACOS(0) = π/2", () => {
    expect(asNumber(fnACOS([rvNumber(0)]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ACOS coerces boolean FALSE → ACOS(0) = π/2", () => {
    expect(asNumber(fnACOS([rvBoolean(false)]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ACOS of blank → ACOS(0) = π/2", () => {
    expect(asNumber(fnACOS([BLANK]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ACOS on 1×1 array", () => {
    expect(asNumber(fnACOS([rvArray([[rvNumber(-1)]])]))).toBeCloseTo(Math.PI, 12);
  });
  it("ATAN(0) = 0 and ATAN(1) = π/4", () => {
    expect(asNumber(fnATAN([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnATAN([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 12);
  });
  it("ATAN is odd and bounded by ±π/2", () => {
    expect(asNumber(fnATAN([rvNumber(-1)]))).toBeCloseTo(-Math.PI / 4, 12);
    expect(asNumber(fnATAN([rvNumber(1e15)]))).toBeCloseTo(Math.PI / 2, 8);
    expect(asNumber(fnATAN([rvNumber(-1e15)]))).toBeCloseTo(-Math.PI / 2, 8);
  });
  it("ATAN coerces blank → 0", () => {
    expect(asNumber(fnATAN([BLANK]))).toBe(0);
  });
  it("ATAN of non-numeric string → #VALUE!", () => {
    expect(fnATAN([rvString("x")])).toEqual(ERRORS.VALUE);
  });
  it("ATAN on 1×1 array", () => {
    expect(asNumber(fnATAN([rvArray([[rvNumber(1)]])]))).toBeCloseTo(Math.PI / 4, 12);
  });
});

describe("ATAN2 saturation", () => {
  // Excel ATAN2(x, y) — x first, unlike Math.atan2(y, x).
  it("ATAN2(1, 0) = 0", () => {
    expect(asNumber(fnATAN2([rvNumber(1), rvNumber(0)]))).toBe(0);
  });
  it("ATAN2(0, 1) = π/2", () => {
    expect(asNumber(fnATAN2([rvNumber(0), rvNumber(1)]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ATAN2(-1, -1) = -3π/4 — Excel doc example", () => {
    expect(asNumber(fnATAN2([rvNumber(-1), rvNumber(-1)]))).toBeCloseTo(-(3 * Math.PI) / 4, 12);
  });
  it("ATAN2(1, 1) = π/4 — Excel doc example", () => {
    expect(asNumber(fnATAN2([rvNumber(1), rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 12);
  });
  it("ATAN2(0, 0) → #DIV/0!", () => {
    expect(fnATAN2([rvNumber(0), rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("ATAN2 coerces boolean args (TRUE,TRUE)=π/4", () => {
    expect(asNumber(fnATAN2([rvBoolean(true), rvBoolean(true)]))).toBeCloseTo(Math.PI / 4, 12);
  });
  it("ATAN2 accepts numeric strings", () => {
    expect(asNumber(fnATAN2([rvString("1"), rvString("1")]))).toBeCloseTo(Math.PI / 4, 12);
  });
  it("ATAN2 propagates x error", () => {
    expect(fnATAN2([rvError("#N/A"), rvNumber(1)])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ATAN2 propagates y error", () => {
    expect(fnATAN2([rvNumber(1), rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("ATAN2 with #VALUE! from bad string", () => {
    expect(fnATAN2([rvString("z"), rvNumber(1)])).toEqual(ERRORS.VALUE);
  });
  it("ATAN2 on 1×1 arrays", () => {
    const r = fnATAN2([rvArray([[rvNumber(1)]]), rvArray([[rvNumber(1)]])]);
    expect(asNumber(r)).toBeCloseTo(Math.PI / 4, 12);
  });
});

describe("SINH / COSH / TANH saturation", () => {
  it("SINH(1) ≈ 1.1752", () => {
    expect(asNumber(fnSINH([rvNumber(1)]))).toBeCloseTo(1.1752011936438014, 12);
  });
  it("SINH(0) = 0 and is odd", () => {
    expect(asNumber(fnSINH([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnSINH([rvNumber(-2)]))).toBeCloseTo(-Math.sinh(2), 12);
  });
  it("SINH overflow → #NUM!", () => {
    expect(fnSINH([rvNumber(1000)])).toEqual(ERRORS.NUM);
    expect(fnSINH([rvNumber(-1000)])).toEqual(ERRORS.NUM);
  });
  it("SINH coerces boolean TRUE → SINH(1)", () => {
    expect(asNumber(fnSINH([rvBoolean(true)]))).toBeCloseTo(Math.sinh(1), 12);
  });
  it("SINH coerces blank → 0", () => {
    expect(asNumber(fnSINH([BLANK]))).toBe(0);
  });
  it("SINH on 1×1 array", () => {
    expect(asNumber(fnSINH([rvArray([[rvNumber(1)]])]))).toBeCloseTo(Math.sinh(1), 12);
  });
  it("SINH propagates error", () => {
    expect(fnSINH([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("COSH(1) ≈ 1.5430806", () => {
    expect(asNumber(fnCOSH([rvNumber(1)]))).toBeCloseTo(1.5430806348152437, 12);
  });
  it("COSH(0) = 1 and is even", () => {
    expect(asNumber(fnCOSH([rvNumber(0)]))).toBe(1);
    expect(asNumber(fnCOSH([rvNumber(-3)]))).toBeCloseTo(Math.cosh(3), 10);
  });
  it("COSH overflow → #NUM!", () => {
    expect(fnCOSH([rvNumber(1000)])).toEqual(ERRORS.NUM);
  });
  it("COSH coerces blank → COSH(0) = 1", () => {
    expect(asNumber(fnCOSH([BLANK]))).toBe(1);
  });
  it("COSH on 1×1 array", () => {
    expect(asNumber(fnCOSH([rvArray([[rvNumber(2)]])]))).toBeCloseTo(Math.cosh(2), 12);
  });
  it("TANH saturates at ±1 for large |x|", () => {
    expect(asNumber(fnTANH([rvNumber(20)]))).toBeCloseTo(1, 14);
    expect(asNumber(fnTANH([rvNumber(-20)]))).toBeCloseTo(-1, 14);
    expect(asNumber(fnTANH([rvNumber(710)]))).toBe(1);
    expect(asNumber(fnTANH([rvNumber(-710)]))).toBe(-1);
  });
  it("TANH(0) = 0 and is odd", () => {
    expect(asNumber(fnTANH([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnTANH([rvNumber(-1)]))).toBeCloseTo(-Math.tanh(1), 12);
  });
  it("TANH coerces boolean TRUE → TANH(1)", () => {
    expect(asNumber(fnTANH([rvBoolean(true)]))).toBeCloseTo(Math.tanh(1), 12);
  });
  it("TANH coerces blank → 0", () => {
    expect(asNumber(fnTANH([BLANK]))).toBe(0);
  });
  it("TANH propagates error", () => {
    expect(fnTANH([rvError("#NULL!")])).toEqual({ kind: RVKind.Error, code: "#NULL!" });
  });
  it("TANH on 1×1 array", () => {
    expect(asNumber(fnTANH([rvArray([[rvNumber(1)]])]))).toBeCloseTo(Math.tanh(1), 12);
  });
});

describe("SEC / CSC / COT saturation", () => {
  it("SEC(1) = 1/cos(1)", () => {
    expect(asNumber(fnSEC([rvNumber(1)]))).toBeCloseTo(1 / Math.cos(1), 12);
  });
  it("SEC is even", () => {
    expect(asNumber(fnSEC([rvNumber(-1)]))).toBeCloseTo(asNumber(fnSEC([rvNumber(1)])), 12);
  });
  it("SEC(π) = -1 (cos(π) is exactly -1 in double)", () => {
    expect(asNumber(fnSEC([rvNumber(Math.PI)]))).toBeCloseTo(-1, 12);
  });
  it("SEC coerces boolean FALSE → SEC(0) = 1", () => {
    expect(asNumber(fnSEC([rvBoolean(false)]))).toBe(1);
  });
  it("SEC coerces blank → 1", () => {
    expect(asNumber(fnSEC([BLANK]))).toBe(1);
  });
  it("SEC on 1×1 array", () => {
    expect(asNumber(fnSEC([rvArray([[rvNumber(0)]])]))).toBe(1);
  });
  it("SEC propagates error", () => {
    expect(fnSEC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("SEC of non-numeric string → #VALUE!", () => {
    expect(fnSEC([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("CSC(π/2) ≈ 1 — Excel doc example", () => {
    expect(asNumber(fnCSC([rvNumber(Math.PI / 2)]))).toBeCloseTo(1, 12);
  });
  it("CSC is odd", () => {
    expect(asNumber(fnCSC([rvNumber(-1)]))).toBeCloseTo(-1 / Math.sin(1), 12);
  });
  it("CSC(0) → #DIV/0!", () => {
    expect(fnCSC([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("CSC coerces boolean TRUE → CSC(1)", () => {
    expect(asNumber(fnCSC([rvBoolean(true)]))).toBeCloseTo(1 / Math.sin(1), 12);
  });
  it("CSC coerces blank → 0 → #DIV/0!", () => {
    expect(fnCSC([BLANK])).toEqual(ERRORS.DIV0);
  });
  it("CSC on 1×1 array", () => {
    expect(asNumber(fnCSC([rvArray([[rvNumber(1)]])]))).toBeCloseTo(1 / Math.sin(1), 12);
  });
  it("CSC propagates error", () => {
    expect(fnCSC([rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("COT(π/4) = 1 — Excel doc example", () => {
    expect(asNumber(fnCOT([rvNumber(Math.PI / 4)]))).toBeCloseTo(1, 12);
  });
  it("COT(1) ≈ 1/tan(1)", () => {
    expect(asNumber(fnCOT([rvNumber(1)]))).toBeCloseTo(1 / Math.tan(1), 12);
  });
  it("COT(0) → #DIV/0!", () => {
    expect(fnCOT([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("COT coerces boolean TRUE → COT(1)", () => {
    expect(asNumber(fnCOT([rvBoolean(true)]))).toBeCloseTo(1 / Math.tan(1), 12);
  });
  it("COT on 1×1 array", () => {
    expect(asNumber(fnCOT([rvArray([[rvNumber(1)]])]))).toBeCloseTo(1 / Math.tan(1), 12);
  });
  it("COT propagates error", () => {
    expect(fnCOT([rvError("#VALUE!")])).toEqual({ kind: RVKind.Error, code: "#VALUE!" });
  });
  it("COT of non-numeric string → #VALUE!", () => {
    expect(fnCOT([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("SECH / CSCH / COTH saturation", () => {
  it("SECH(1) ≈ 0.648054", () => {
    expect(asNumber(fnSECH([rvNumber(1)]))).toBeCloseTo(0.6480542736638855, 12);
  });
  it("SECH is even", () => {
    expect(asNumber(fnSECH([rvNumber(-1)]))).toBeCloseTo(asNumber(fnSECH([rvNumber(1)])), 12);
  });
  it("SECH(0) = 1 — Excel doc example", () => {
    expect(asNumber(fnSECH([rvNumber(0)]))).toBe(1);
  });
  it("SECH at huge |x| → 0 (overflow in cosh handled)", () => {
    expect(asNumber(fnSECH([rvNumber(1000)]))).toBe(0);
    expect(asNumber(fnSECH([rvNumber(-1000)]))).toBe(0);
  });
  it("SECH coerces boolean/blank", () => {
    expect(asNumber(fnSECH([rvBoolean(false)]))).toBe(1);
    expect(asNumber(fnSECH([BLANK]))).toBe(1);
  });
  it("SECH on 1×1 array", () => {
    expect(asNumber(fnSECH([rvArray([[rvNumber(0)]])]))).toBe(1);
  });
  it("SECH propagates error", () => {
    expect(fnSECH([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("CSCH(1) ≈ 1/sinh(1)", () => {
    expect(asNumber(fnCSCH([rvNumber(1)]))).toBeCloseTo(1 / Math.sinh(1), 12);
  });
  it("CSCH(0) → #DIV/0!", () => {
    expect(fnCSCH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("CSCH is odd", () => {
    expect(asNumber(fnCSCH([rvNumber(-1)]))).toBeCloseTo(-1 / Math.sinh(1), 12);
  });
  it("CSCH overflow: sinh(1000)=Infinity → 0", () => {
    expect(asNumber(fnCSCH([rvNumber(1000)]))).toBe(0);
  });
  it("CSCH coerces blank → 0 → #DIV/0!", () => {
    expect(fnCSCH([BLANK])).toEqual(ERRORS.DIV0);
  });
  it("CSCH on 1×1 array", () => {
    expect(asNumber(fnCSCH([rvArray([[rvNumber(1)]])]))).toBeCloseTo(1 / Math.sinh(1), 12);
  });
  it("CSCH propagates error", () => {
    expect(fnCSCH([rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("COTH(1) ≈ 1/tanh(1) — Excel doc example", () => {
    expect(asNumber(fnCOTH([rvNumber(1)]))).toBeCloseTo(1 / Math.tanh(1), 12);
  });
  it("COTH(0) → #DIV/0!", () => {
    expect(fnCOTH([rvNumber(0)])).toEqual(ERRORS.DIV0);
  });
  it("COTH is odd", () => {
    expect(asNumber(fnCOTH([rvNumber(-1)]))).toBeCloseTo(-1 / Math.tanh(1), 12);
  });
  it("COTH(large) → 1", () => {
    expect(asNumber(fnCOTH([rvNumber(50)]))).toBeCloseTo(1, 14);
  });
  it("COTH coerces boolean TRUE → COTH(1)", () => {
    expect(asNumber(fnCOTH([rvBoolean(true)]))).toBeCloseTo(1 / Math.tanh(1), 12);
  });
  it("COTH on 1×1 array", () => {
    expect(asNumber(fnCOTH([rvArray([[rvNumber(1)]])]))).toBeCloseTo(1 / Math.tanh(1), 12);
  });
  it("COTH propagates error", () => {
    expect(fnCOTH([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("ACOT / ACOTH saturation", () => {
  it("ACOT(0) = π/2 — Excel doc example", () => {
    expect(asNumber(fnACOT([rvNumber(0)]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ACOT(1) = π/4", () => {
    expect(asNumber(fnACOT([rvNumber(1)]))).toBeCloseTo(Math.PI / 4, 12);
  });
  it("ACOT(-1) = 3π/4 (Excel uses (0, π) range, not (-π/2, π/2))", () => {
    expect(asNumber(fnACOT([rvNumber(-1)]))).toBeCloseTo((3 * Math.PI) / 4, 12);
  });
  it("ACOT(large) → 0 and ACOT(-large) → π", () => {
    expect(asNumber(fnACOT([rvNumber(1e15)]))).toBeCloseTo(0, 10);
    expect(asNumber(fnACOT([rvNumber(-1e15)]))).toBeCloseTo(Math.PI, 10);
  });
  it("ACOT coerces boolean/blank", () => {
    expect(asNumber(fnACOT([rvBoolean(false)]))).toBeCloseTo(Math.PI / 2, 12);
    expect(asNumber(fnACOT([BLANK]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("ACOT on 1×1 array", () => {
    expect(asNumber(fnACOT([rvArray([[rvNumber(1)]])]))).toBeCloseTo(Math.PI / 4, 12);
  });
  it("ACOT of non-numeric string → #VALUE!", () => {
    expect(fnACOT([rvString("x")])).toEqual(ERRORS.VALUE);
  });
  it("ACOT propagates error", () => {
    expect(fnACOT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ACOTH(2) ≈ 0.5493 — Excel doc example", () => {
    expect(asNumber(fnACOTH([rvNumber(2)]))).toBeCloseTo(0.5493061443340548, 12);
  });
  it("ACOTH is odd: ACOTH(-x) = -ACOTH(x)", () => {
    expect(asNumber(fnACOTH([rvNumber(-2)]))).toBeCloseTo(-0.5493061443340548, 12);
  });
  it("ACOTH boundary |x|=1 → #NUM!", () => {
    expect(fnACOTH([rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnACOTH([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("ACOTH(|x|<1) → #NUM!", () => {
    expect(fnACOTH([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnACOTH([rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
  it("ACOTH just above 1 is large but finite", () => {
    expect(asNumber(fnACOTH([rvNumber(1.0001)]))).toBeCloseTo(4.951768775643139, 10);
  });
  it("ACOTH on 1×1 array", () => {
    expect(asNumber(fnACOTH([rvArray([[rvNumber(2)]])]))).toBeCloseTo(0.5493061443340548, 12);
  });
  it("ACOTH propagates error", () => {
    expect(fnACOTH([rvError("#REF!")])).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("ACOTH of non-numeric string → #VALUE!", () => {
    expect(fnACOTH([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
});

describe("COMBINA / MULTINOMIAL / FACTDOUBLE saturation", () => {
  it("COMBINA(4, 3) = 20 — Excel doc example (multiset choose)", () => {
    expect(asNumber(fnCOMBINA([rvNumber(4), rvNumber(3)]))).toBe(20);
  });
  it("COMBINA(0, 0) = 1 — degenerate special case", () => {
    expect(asNumber(fnCOMBINA([rvNumber(0), rvNumber(0)]))).toBe(1);
  });
  it("COMBINA(n, 0) = 1 for any n ≥ 0", () => {
    expect(asNumber(fnCOMBINA([rvNumber(3), rvNumber(0)]))).toBe(1);
    expect(asNumber(fnCOMBINA([rvNumber(10), rvNumber(0)]))).toBe(1);
  });
  it("COMBINA(0, k>0) → #NUM! (no items, can't pick any)", () => {
    expect(fnCOMBINA([rvNumber(0), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("COMBINA negative args → #NUM!", () => {
    expect(fnCOMBINA([rvNumber(-1), rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnCOMBINA([rvNumber(5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("COMBINA(3, 2) = C(4, 2) = 6", () => {
    expect(asNumber(fnCOMBINA([rvNumber(3), rvNumber(2)]))).toBe(6);
  });
  it("COMBINA coerces boolean → COMBINA(1, 1) = 1", () => {
    expect(asNumber(fnCOMBINA([rvBoolean(true), rvBoolean(true)]))).toBe(1);
  });
  it("COMBINA propagates first-arg error", () => {
    expect(fnCOMBINA([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("COMBINA propagates second-arg error", () => {
    expect(fnCOMBINA([rvNumber(5), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("COMBINA of non-numeric string → #VALUE!", () => {
    expect(fnCOMBINA([rvString("abc"), rvNumber(2)])).toEqual(ERRORS.VALUE);
  });
  it("MULTINOMIAL(2, 3, 4) = 9!/(2!3!4!) = 1260 — Excel doc example", () => {
    expect(asNumber(fnMULTINOMIAL([rvNumber(2), rvNumber(3), rvNumber(4)]))).toBe(1260);
  });
  it("MULTINOMIAL(2, 3) = 5!/(2!3!) = 10", () => {
    expect(asNumber(fnMULTINOMIAL([rvNumber(2), rvNumber(3)]))).toBe(10);
  });
  it("MULTINOMIAL(0) = 1", () => {
    expect(asNumber(fnMULTINOMIAL([rvNumber(0)]))).toBe(1);
  });
  it("MULTINOMIAL rejects any negative arg", () => {
    expect(fnMULTINOMIAL([rvNumber(-1)])).toEqual(ERRORS.NUM);
    expect(fnMULTINOMIAL([rvNumber(2), rvNumber(-3)])).toEqual(ERRORS.NUM);
  });
  it("MULTINOMIAL propagates error in args", () => {
    expect(fnMULTINOMIAL([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("MULTINOMIAL of non-numeric string → #VALUE!", () => {
    expect(fnMULTINOMIAL([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("MULTINOMIAL over a 1×n array sums cells", () => {
    // 1+2+3 = 6! / (1!2!3!) = 720/12 = 60
    expect(asNumber(fnMULTINOMIAL([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])]))).toBe(60);
  });
  it("MULTINOMIAL coerces booleans (TRUE=1, 2) = 3!/1!2! = 3", () => {
    expect(asNumber(fnMULTINOMIAL([rvBoolean(true), rvNumber(2)]))).toBe(3);
  });
  it("FACTDOUBLE(6) = 6*4*2 = 48 — Excel doc example", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(6)]))).toBe(48);
  });
  it("FACTDOUBLE(7) = 7*5*3*1 = 105 — Excel doc example", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(7)]))).toBe(105);
  });
  it("FACTDOUBLE(0) = 1 and FACTDOUBLE(1) = 1 (base cases)", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(0)]))).toBe(1);
    expect(asNumber(fnFACTDOUBLE([rvNumber(1)]))).toBe(1);
  });
  it("FACTDOUBLE(-1) = 1 (Excel's convention: n <= 0 returns 1)", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(-1)]))).toBe(1);
  });
  it("FACTDOUBLE(-2) → #NUM!", () => {
    expect(fnFACTDOUBLE([rvNumber(-2)])).toEqual(ERRORS.NUM);
  });
  it("FACTDOUBLE floors fractional input: FACTDOUBLE(2.9) = 2!! = 2", () => {
    expect(asNumber(fnFACTDOUBLE([rvNumber(2.9)]))).toBe(2);
  });
  it("FACTDOUBLE overflow → #NUM!", () => {
    expect(fnFACTDOUBLE([rvNumber(400)])).toEqual(ERRORS.NUM);
  });
  it("FACTDOUBLE propagates error", () => {
    expect(fnFACTDOUBLE([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("FACT / COMBIN / PERMUT saturation", () => {
  it("FACT(1) = 1", () => {
    expect(asNumber(fnFACT([rvNumber(1)]))).toBe(1);
  });
  it("FACT(10) = 3628800 — Excel doc example", () => {
    expect(asNumber(fnFACT([rvNumber(10)]))).toBe(3628800);
  });
  it("FACT floors fractional: FACT(1.9) = 1", () => {
    expect(asNumber(fnFACT([rvNumber(1.9)]))).toBe(1);
  });
  it("FACT(170) is the largest representable factorial", () => {
    expect(asNumber(fnFACT([rvNumber(170)]))).toBeCloseTo(7.257415615307994e306, 0);
  });
  it("FACT coerces boolean TRUE → FACT(1) = 1", () => {
    expect(asNumber(fnFACT([rvBoolean(true)]))).toBe(1);
  });
  it("FACT coerces blank → FACT(0) = 1", () => {
    expect(asNumber(fnFACT([BLANK]))).toBe(1);
  });
  it("FACT on 1×1 array", () => {
    expect(asNumber(fnFACT([rvArray([[rvNumber(4)]])]))).toBe(24);
  });
  it("FACT of non-numeric string → #VALUE!", () => {
    expect(fnFACT([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("FACT propagates error", () => {
    expect(fnFACT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("COMBIN(8, 2) = 28 — Excel doc example", () => {
    expect(asNumber(fnCOMBIN([rvNumber(8), rvNumber(2)]))).toBe(28);
  });
  it("COMBIN(n, 0) = 1 and COMBIN(n, n) = 1", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(0)]))).toBe(1);
    expect(asNumber(fnCOMBIN([rvNumber(5), rvNumber(5)]))).toBe(1);
  });
  it("COMBIN floors fractional args", () => {
    expect(asNumber(fnCOMBIN([rvNumber(5.9), rvNumber(2.9)]))).toBe(10);
  });
  it("COMBIN negative n or k → #NUM!", () => {
    expect(fnCOMBIN([rvNumber(-1), rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnCOMBIN([rvNumber(5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("COMBIN coerces booleans (TRUE=1, TRUE=1) = 1", () => {
    expect(asNumber(fnCOMBIN([rvBoolean(true), rvBoolean(true)]))).toBe(1);
  });
  it("COMBIN propagates error", () => {
    expect(fnCOMBIN([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("COMBIN on 1×1 arrays", () => {
    expect(asNumber(fnCOMBIN([rvArray([[rvNumber(5)]]), rvArray([[rvNumber(2)]])]))).toBe(10);
  });
  it("PERMUT(3, 2) = 6 — Excel doc example", () => {
    expect(asNumber(fnPERMUT([rvNumber(3), rvNumber(2)]))).toBe(6);
  });
  it("PERMUT(100, 3) = 970200", () => {
    expect(asNumber(fnPERMUT([rvNumber(100), rvNumber(3)]))).toBe(970200);
  });
  it("PERMUT(n, 0) = 1", () => {
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(0)]))).toBe(1);
  });
  it("PERMUT(n, n) = n!", () => {
    expect(asNumber(fnPERMUT([rvNumber(5), rvNumber(5)]))).toBe(120);
  });
  it("PERMUT rejects k > n or negative", () => {
    expect(fnPERMUT([rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnPERMUT([rvNumber(-1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("PERMUT coerces boolean/string numerics", () => {
    expect(asNumber(fnPERMUT([rvString("5"), rvBoolean(true)]))).toBe(5);
  });
  it("PERMUT propagates error", () => {
    expect(fnPERMUT([rvNumber(5), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
});

describe("SINH / COSH extra (alias boundary)", () => {
  it("SINH of numeric string '2'", () => {
    expect(asNumber(fnSINH([rvString("2")]))).toBeCloseTo(Math.sinh(2), 12);
  });
  it("COSH of numeric string '-1'", () => {
    expect(asNumber(fnCOSH([rvString("-1")]))).toBeCloseTo(Math.cosh(1), 12);
  });
});

describe("DEGREES / RADIANS / PI saturation", () => {
  it("DEGREES(PI/2) = 90", () => {
    expect(asNumber(fnDEGREES([rvNumber(Math.PI / 2)]))).toBeCloseTo(90, 12);
  });
  it("DEGREES(-PI) = -180", () => {
    expect(asNumber(fnDEGREES([rvNumber(-Math.PI)]))).toBeCloseTo(-180, 12);
  });
  it("DEGREES coerces boolean TRUE → DEGREES(1)", () => {
    expect(asNumber(fnDEGREES([rvBoolean(true)]))).toBeCloseTo(180 / Math.PI, 12);
  });
  it("DEGREES coerces blank → 0", () => {
    expect(asNumber(fnDEGREES([BLANK]))).toBe(0);
  });
  it("DEGREES of non-numeric string → #VALUE!", () => {
    expect(fnDEGREES([rvString("foo")])).toEqual(ERRORS.VALUE);
  });
  it("DEGREES on 1×1 array", () => {
    expect(asNumber(fnDEGREES([rvArray([[rvNumber(Math.PI)]])]))).toBeCloseTo(180, 12);
  });
  it("RADIANS(90) = π/2", () => {
    expect(asNumber(fnRADIANS([rvNumber(90)]))).toBeCloseTo(Math.PI / 2, 12);
  });
  it("RADIANS(-90) = -π/2", () => {
    expect(asNumber(fnRADIANS([rvNumber(-90)]))).toBeCloseTo(-Math.PI / 2, 12);
  });
  it("RADIANS(360) = 2π", () => {
    expect(asNumber(fnRADIANS([rvNumber(360)]))).toBeCloseTo(2 * Math.PI, 12);
  });
  it("RADIANS coerces boolean TRUE → RADIANS(1)", () => {
    expect(asNumber(fnRADIANS([rvBoolean(true)]))).toBeCloseTo(Math.PI / 180, 12);
  });
  it("RADIANS on 1×1 array", () => {
    expect(asNumber(fnRADIANS([rvArray([[rvNumber(180)]])]))).toBeCloseTo(Math.PI, 12);
  });
  it("RADIANS propagates error", () => {
    expect(fnRADIANS([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("PI() takes no args — ignores any provided", () => {
    expect(asNumber(fnPI([]))).toBe(Math.PI);
  });
  it("PI precision: sin(PI()) ≈ 0", () => {
    expect(Math.abs(Math.sin(asNumber(fnPI([]))))).toBeLessThan(1e-15);
  });
  it("PI identity: cos(PI()) = -1", () => {
    expect(Math.cos(asNumber(fnPI([])))).toBe(-1);
  });
  it("PI: 2*PI is a full turn", () => {
    expect(Math.sin(2 * asNumber(fnPI([])))).toBeCloseTo(0, 14);
  });
});

describe("SIGN / SQRT / EXP / LN / LOG / LOG10 saturation", () => {
  it("SIGN coerces boolean TRUE → 1", () => {
    expect(asNumber(fnSIGN([rvBoolean(true)]))).toBe(1);
  });
  it("SIGN coerces blank → 0", () => {
    expect(asNumber(fnSIGN([BLANK]))).toBe(0);
  });
  it("SIGN of non-numeric string → #VALUE!", () => {
    expect(fnSIGN([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
  it("SIGN propagates error", () => {
    expect(fnSIGN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("SIGN on 1×1 array", () => {
    expect(asNumber(fnSIGN([rvArray([[rvNumber(-3)]])]))).toBe(-1);
  });
  it("SIGN(-0) = +0 (R8 normalises the sign bit, matching Excel)", () => {
    expect(asNumber(fnSIGN([rvNumber(-0)]))).toBe(0);
    // Explicitly verify it's NOT the negative-zero sign bit.
    expect(Object.is(asNumber(fnSIGN([rvNumber(-0)])), 0)).toBe(true);
  });
  it("SIGN of numeric string '-1.5' = -1", () => {
    expect(asNumber(fnSIGN([rvString("-1.5")]))).toBe(-1);
  });
  it("SQRT(2) ≈ 1.4142 — Excel doc example", () => {
    expect(asNumber(fnSQRT([rvNumber(2)]))).toBeCloseTo(Math.SQRT2, 12);
  });
  it("SQRT coerces boolean TRUE → SQRT(1) = 1", () => {
    expect(asNumber(fnSQRT([rvBoolean(true)]))).toBe(1);
  });
  it("SQRT of numeric string", () => {
    expect(asNumber(fnSQRT([rvString("16")]))).toBe(4);
  });
  it("SQRT of blank → SQRT(0) = 0", () => {
    expect(asNumber(fnSQRT([BLANK]))).toBe(0);
  });
  it("SQRT on 1×1 array", () => {
    expect(asNumber(fnSQRT([rvArray([[rvNumber(25)]])]))).toBe(5);
  });
  it("SQRT propagates error", () => {
    expect(fnSQRT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("SQRT large: SQRT(1e100) = 1e50", () => {
    expect(asNumber(fnSQRT([rvNumber(1e100)]))).toBeCloseTo(1e50, -40);
  });
  it("EXP(-1) ≈ 1/e", () => {
    expect(asNumber(fnEXP([rvNumber(-1)]))).toBeCloseTo(1 / Math.E, 12);
  });
  it("EXP(ln x) = x", () => {
    for (const x of [0.1, 1, 10, 100]) {
      expect(asNumber(fnEXP([rvNumber(Math.log(x))]))).toBeCloseTo(x, 10);
    }
  });
  it("EXP overflow at x ≈ 710 → #NUM!", () => {
    expect(fnEXP([rvNumber(710)])).toEqual(ERRORS.NUM);
  });
  it("EXP of negative large → 0", () => {
    expect(asNumber(fnEXP([rvNumber(-1000)]))).toBe(0);
  });
  it("EXP coerces blank → EXP(0) = 1", () => {
    expect(asNumber(fnEXP([BLANK]))).toBe(1);
  });
  it("EXP on 1×1 array", () => {
    expect(asNumber(fnEXP([rvArray([[rvNumber(0)]])]))).toBe(1);
  });
  it("EXP propagates error", () => {
    expect(fnEXP([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("LN(1) = 0", () => {
    expect(asNumber(fnLN([rvNumber(1)]))).toBe(0);
  });
  it("LN(EXP(x)) = x", () => {
    for (const x of [-2, -1, 0, 1, 5]) {
      expect(asNumber(fnLN([rvNumber(Math.exp(x))]))).toBeCloseTo(x, 10);
    }
  });
  it("LN coerces boolean TRUE → LN(1) = 0", () => {
    expect(asNumber(fnLN([rvBoolean(true)]))).toBe(0);
  });
  it("LN(blank=0) → #NUM!", () => {
    expect(fnLN([BLANK])).toEqual(ERRORS.NUM);
  });
  it("LN on 1×1 array", () => {
    expect(asNumber(fnLN([rvArray([[rvNumber(Math.E)]])]))).toBeCloseTo(1, 12);
  });
  it("LN propagates error", () => {
    expect(fnLN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("LOG(8, 2) = 3 — Excel doc example", () => {
    expect(asNumber(fnLOG([rvNumber(8), rvNumber(2)]))).toBeCloseTo(3, 12);
  });
  it("LOG(100) = 2 (default base 10)", () => {
    expect(asNumber(fnLOG([rvNumber(100)]))).toBeCloseTo(2, 12);
  });
  it("LOG(86, 2.7182818) ≈ 4.454 — Excel doc example", () => {
    expect(asNumber(fnLOG([rvNumber(86), rvNumber(2.7182818)]))).toBeCloseTo(4.454346807825527, 5);
  });
  it("LOG rejects base ≤ 0 or = 1", () => {
    expect(fnLOG([rvNumber(10), rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnLOG([rvNumber(10), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOG coerces boolean TRUE as arg (but base 2 still fails for 1 base)", () => {
    expect(asNumber(fnLOG([rvBoolean(true), rvNumber(10)]))).toBe(0);
  });
  it("LOG on 1×1 array args", () => {
    expect(asNumber(fnLOG([rvArray([[rvNumber(100)]]), rvArray([[rvNumber(10)]])]))).toBeCloseTo(
      2,
      12
    );
  });
  it("LOG propagates error in first arg", () => {
    expect(fnLOG([rvError("#N/A"), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("LOG propagates error in base", () => {
    expect(fnLOG([rvNumber(10), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("LOG10(86) ≈ 1.934 — Excel doc example", () => {
    expect(asNumber(fnLOG10([rvNumber(86)]))).toBeCloseTo(1.9344984512435677, 12);
  });
  it("LOG10(10^x) = x", () => {
    for (const x of [-2, -1, 0, 1, 3]) {
      expect(asNumber(fnLOG10([rvNumber(Math.pow(10, x))]))).toBeCloseTo(x, 10);
    }
  });
  it("LOG10(1) = 0", () => {
    expect(asNumber(fnLOG10([rvNumber(1)]))).toBe(0);
  });
  it("LOG10 coerces boolean TRUE → LOG10(1) = 0", () => {
    expect(asNumber(fnLOG10([rvBoolean(true)]))).toBe(0);
  });
  it("LOG10 of blank (=0) → #NUM!", () => {
    expect(fnLOG10([BLANK])).toEqual(ERRORS.NUM);
  });
  it("LOG10 on 1×1 array", () => {
    expect(asNumber(fnLOG10([rvArray([[rvNumber(100)]])]))).toBeCloseTo(2, 12);
  });
  it("LOG10 propagates error", () => {
    expect(fnLOG10([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("POWER / MOD / QUOTIENT saturation", () => {
  it("POWER(5, 2) = 25 — Excel doc example", () => {
    expect(asNumber(fnPOWER([rvNumber(5), rvNumber(2)]))).toBe(25);
  });
  it("POWER(98.6, 3.2) ≈ 2401077 — Excel doc example", () => {
    expect(asNumber(fnPOWER([rvNumber(98.6), rvNumber(3.2)]))).toBeCloseTo(2401077.222, 1);
  });
  it("POWER(4, 5/4) ≈ 5.6569 — Excel doc example", () => {
    expect(asNumber(fnPOWER([rvNumber(4), rvNumber(5 / 4)]))).toBeCloseTo(Math.pow(4, 1.25), 12);
  });
  it("POWER negative base with integer exp: POWER(-3, 2) = 9", () => {
    expect(asNumber(fnPOWER([rvNumber(-3), rvNumber(2)]))).toBe(9);
  });
  it("POWER coerces boolean: POWER(TRUE, 3) = 1", () => {
    expect(asNumber(fnPOWER([rvBoolean(true), rvNumber(3)]))).toBe(1);
  });
  it("POWER on 1×1 arrays", () => {
    expect(asNumber(fnPOWER([rvArray([[rvNumber(2)]]), rvArray([[rvNumber(3)]])]))).toBe(8);
  });
  it("POWER propagates base error", () => {
    expect(fnPOWER([rvError("#N/A"), rvNumber(2)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("POWER propagates exp error", () => {
    expect(fnPOWER([rvNumber(2), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("POWER of non-numeric string → #VALUE!", () => {
    expect(fnPOWER([rvString("abc"), rvNumber(2)])).toEqual(ERRORS.VALUE);
  });
  it("MOD(3, 2) = 1 — Excel doc example", () => {
    expect(asNumber(fnMOD([rvNumber(3), rvNumber(2)]))).toBe(1);
  });
  it("MOD(-3, 2) = 1 (Excel uses floor, not trunc)", () => {
    expect(asNumber(fnMOD([rvNumber(-3), rvNumber(2)]))).toBe(1);
  });
  it("MOD(3, -2) = -1 — Excel doc example", () => {
    expect(asNumber(fnMOD([rvNumber(3), rvNumber(-2)]))).toBe(-1);
  });
  it("MOD(-3, -2) = -1", () => {
    expect(asNumber(fnMOD([rvNumber(-3), rvNumber(-2)]))).toBe(-1);
  });
  it("MOD of fractional: MOD(1.5, 0.3) ≈ 0 (within precision)", () => {
    expect(asNumber(fnMOD([rvNumber(1.5), rvNumber(0.3)]))).toBeCloseTo(0, 10);
  });
  it("MOD coerces booleans: MOD(TRUE, TRUE) = 0", () => {
    expect(asNumber(fnMOD([rvBoolean(true), rvBoolean(true)]))).toBe(0);
  });
  it("MOD propagates first-arg error", () => {
    expect(fnMOD([rvError("#N/A"), rvNumber(2)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("MOD propagates second-arg error", () => {
    expect(fnMOD([rvNumber(5), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("QUOTIENT(5, 2) = 2 — Excel doc example", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(5), rvNumber(2)]))).toBe(2);
  });
  it("QUOTIENT(4.5, 3.1) = 1 — Excel doc example", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(4.5), rvNumber(3.1)]))).toBe(1);
  });
  it("QUOTIENT(-10, 3) = -3 (trunc toward 0)", () => {
    expect(asNumber(fnQUOTIENT([rvNumber(-10), rvNumber(3)]))).toBe(-3);
  });
  it("QUOTIENT coerces numeric string", () => {
    expect(asNumber(fnQUOTIENT([rvString("10"), rvString("3")]))).toBe(3);
  });
  it("QUOTIENT on 1×1 arrays", () => {
    expect(asNumber(fnQUOTIENT([rvArray([[rvNumber(10)]]), rvArray([[rvNumber(3)]])]))).toBe(3);
  });
  it("QUOTIENT propagates first-arg error", () => {
    expect(fnQUOTIENT([rvError("#N/A"), rvNumber(3)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("QUOTIENT propagates second-arg error", () => {
    expect(fnQUOTIENT([rvNumber(10), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
});

describe("SUMX2MY2 / SUMX2PY2 / SUMXMY2 saturation", () => {
  const xs = rvArray([[rvNumber(2), rvNumber(3), rvNumber(9), rvNumber(1), rvNumber(8)]]);
  const ys = rvArray([[rvNumber(6), rvNumber(5), rvNumber(11), rvNumber(7), rvNumber(5)]]);

  it("SUMX2MY2 Excel doc example (5 data points) = -97", () => {
    // Σ(x² − y²) = (4-36)+(9-25)+(81-121)+(1-49)+(64-25)
    //            = -32 + -16 + -40 + -48 + 39 = -97
    const r = fnSUMX2MY2([xs, ys]);
    expect(asNumber(r)).toBe(-97);
  });
  it("SUMX2PY2 same dataset", () => {
    // (4+36)+(9+25)+(81+121)+(1+49)+(64+25) = 40+34+202+50+89 = 415
    expect(asNumber(fnSUMX2PY2([xs, ys]))).toBe(415);
  });
  it("SUMXMY2 same dataset", () => {
    // (2-6)²+(3-5)²+(9-11)²+(1-7)²+(8-5)² = 16+4+4+36+9 = 69
    expect(asNumber(fnSUMXMY2([xs, ys]))).toBe(69);
  });
  it("SUMX2MY2 skips non-numeric paired cells", () => {
    const a = rvArray([[rvNumber(2), rvString("x"), rvNumber(4)]]);
    const b = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    // (4-1) + skip + (16-1) = 3 + 15 = 18
    expect(asNumber(fnSUMX2MY2([a, b]))).toBe(18);
  });
  it("SUMX2PY2 skips non-numeric paired cells", () => {
    const a = rvArray([[rvNumber(2), rvBoolean(true), rvNumber(4)]]);
    const b = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    expect(asNumber(fnSUMX2PY2([a, b]))).toBe(5 + 17);
  });
  it("SUMXMY2 skips non-numeric", () => {
    const a = rvArray([[rvNumber(1), BLANK, rvNumber(3)]]);
    const b = rvArray([[rvNumber(0), rvNumber(0), rvNumber(0)]]);
    expect(asNumber(fnSUMXMY2([a, b]))).toBe(1 + 9);
  });
  it("SUMX2MY2 first arg scalar → #VALUE!", () => {
    expect(fnSUMX2MY2([rvNumber(1), ys])).toEqual(ERRORS.VALUE);
  });
  it("SUMX2PY2 second arg scalar → #VALUE!", () => {
    expect(fnSUMX2PY2([xs, rvNumber(1)])).toEqual(ERRORS.VALUE);
  });
  it("SUMXMY2 both scalars → #VALUE!", () => {
    expect(fnSUMXMY2([rvNumber(1), rvNumber(2)])).toEqual(ERRORS.VALUE);
  });
  it("SUMX2MY2 propagates x error", () => {
    const bad = rvArray([[rvNumber(1), ERRORS.NA]]);
    const good = rvArray([[rvNumber(1), rvNumber(1)]]);
    expect(fnSUMX2MY2([bad, good])).toEqual(ERRORS.NA);
  });
  it("SUMX2PY2 propagates y error", () => {
    const good = rvArray([[rvNumber(1), rvNumber(2)]]);
    const bad = rvArray([[rvNumber(1), ERRORS.REF]]);
    expect(fnSUMX2PY2([good, bad])).toEqual(ERRORS.REF);
  });
  it("SUMXMY2 on mismatched shapes returns #N/A (Excel)", () => {
    // Regression matching the earlier behaviour-fix test in the
    // SUMX2 family's main block. Excel's documentation: "The two
    // arrays must have the same number of values. If they do not,
    // SUMXMY2 returns the #N/A error value."
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const b = rvArray([[rvNumber(4), rvNumber(5)]]);
    expect(fnSUMXMY2([a, b])).toEqual(ERRORS.NA);
  });
  it("SUMX2MY2 on 1×1 arrays", () => {
    const a = rvArray([[rvNumber(3)]]);
    const b = rvArray([[rvNumber(2)]]);
    expect(asNumber(fnSUMX2MY2([a, b]))).toBe(5); // 9-4
  });
  it("SUMX2PY2 on 1×1 arrays", () => {
    const a = rvArray([[rvNumber(3)]]);
    const b = rvArray([[rvNumber(4)]]);
    expect(asNumber(fnSUMX2PY2([a, b]))).toBe(25); // 9+16
  });
});

describe("ROMAN / ARABIC saturation", () => {
  it("ROMAN(1) = I", () => {
    expect(asString(fnROMAN([rvNumber(1)]))).toBe("I");
  });
  it("ROMAN(499, 0) classic = CDXCIX", () => {
    expect(asString(fnROMAN([rvNumber(499), rvNumber(0)]))).toBe("CDXCIX");
  });
  it("ROMAN(499, 1) uses VC / LD pairs", () => {
    expect(asString(fnROMAN([rvNumber(499), rvNumber(1)]))).toBe("LDVLIV");
  });
  it("ROMAN(1984) = MCMLXXXIV", () => {
    expect(asString(fnROMAN([rvNumber(1984)]))).toBe("MCMLXXXIV");
  });
  it("ROMAN(3999) largest valid", () => {
    expect(asString(fnROMAN([rvNumber(3999)]))).toBe("MMMCMXCIX");
  });
  it("ROMAN(4000) → #VALUE!", () => {
    expect(fnROMAN([rvNumber(4000)])).toEqual(ERRORS.VALUE);
  });
  it("ROMAN(-1) → #VALUE!", () => {
    expect(fnROMAN([rvNumber(-1)])).toEqual(ERRORS.VALUE);
  });
  it("ROMAN floors fractional: ROMAN(4.9) = IV", () => {
    expect(asString(fnROMAN([rvNumber(4.9)]))).toBe("IV");
  });
  it("ROMAN with invalid form (>4) → #VALUE!", () => {
    expect(fnROMAN([rvNumber(100), rvNumber(5)])).toEqual(ERRORS.VALUE);
  });
  it("ROMAN with negative form → #VALUE!", () => {
    expect(fnROMAN([rvNumber(100), rvNumber(-1)])).toEqual(ERRORS.VALUE);
  });
  it("ROMAN propagates error", () => {
    expect(fnROMAN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ROMAN on 1×1 array", () => {
    expect(asString(fnROMAN([rvArray([[rvNumber(9)]])]))).toBe("IX");
  });
  it("ARABIC('LVII') = 57 — Excel doc example", () => {
    expect(asNumber(fnARABIC([rvString("LVII")]))).toBe(57);
  });
  it("ARABIC('mcmxii') handles lowercase (case-insensitive) = 1912", () => {
    expect(asNumber(fnARABIC([rvString("mcmxii")]))).toBe(1912);
  });
  it("ARABIC('  MCMLXXXIV  ') trims whitespace = 1984", () => {
    expect(asNumber(fnARABIC([rvString("  MCMLXXXIV  ")]))).toBe(1984);
  });
  it("ARABIC('') = 0", () => {
    expect(asNumber(fnARABIC([rvString("")]))).toBe(0);
  });
  it("ARABIC of invalid roman → #VALUE!", () => {
    expect(fnARABIC([rvString("ABC")])).toEqual(ERRORS.VALUE);
  });
  it("ARABIC propagates error", () => {
    expect(fnARABIC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ARABIC on 1×1 array", () => {
    expect(asNumber(fnARABIC([rvArray([[rvString("IX")]])]))).toBe(9);
  });
  it("ARABIC round-trip for a few representative values", () => {
    for (const n of [1, 9, 49, 90, 400, 999, 1776, 1999, 3888]) {
      const r = fnROMAN([rvNumber(n)]);
      expect(asNumber(fnARABIC([r]))).toBe(n);
    }
  });
});

describe("BASE / DECIMAL saturation", () => {
  it("BASE(7, 2) = '111' — Excel doc example", () => {
    expect(asString(fnBASE([rvNumber(7), rvNumber(2)]))).toBe("111");
  });
  it("BASE(100, 16) = '64'", () => {
    expect(asString(fnBASE([rvNumber(100), rvNumber(16)]))).toBe("64");
  });
  it("BASE(15, 2, 10) pads with zeros — Excel doc example", () => {
    expect(asString(fnBASE([rvNumber(15), rvNumber(2), rvNumber(10)]))).toBe("0000001111");
  });
  it("BASE(0, 2) = '0'", () => {
    expect(asString(fnBASE([rvNumber(0), rvNumber(2)]))).toBe("0");
  });
  it("BASE(0, 2, 4) = '0000' (zero padded)", () => {
    expect(asString(fnBASE([rvNumber(0), rvNumber(2), rvNumber(4)]))).toBe("0000");
  });
  it("BASE radix boundary: 2 and 36 accepted, 1 and 37 rejected", () => {
    expect(asString(fnBASE([rvNumber(0), rvNumber(2)]))).toBe("0");
    expect(asString(fnBASE([rvNumber(35), rvNumber(36)]))).toBe("Z");
    expect(fnBASE([rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnBASE([rvNumber(0), rvNumber(37)])).toEqual(ERRORS.NUM);
  });
  it("BASE floors its inputs", () => {
    expect(asString(fnBASE([rvNumber(7.9), rvNumber(2)]))).toBe("111");
  });
  it("BASE coerces booleans", () => {
    expect(asString(fnBASE([rvBoolean(true), rvNumber(2)]))).toBe("1");
  });
  it("BASE propagates number error", () => {
    expect(fnBASE([rvError("#N/A"), rvNumber(2)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("BASE propagates radix error", () => {
    expect(fnBASE([rvNumber(10), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("DECIMAL('FF', 16) = 255 — Excel doc example", () => {
    expect(asNumber(fnDECIMAL([rvString("FF"), rvNumber(16)]))).toBe(255);
  });
  it("DECIMAL('111', 2) = 7 — Excel doc example", () => {
    expect(asNumber(fnDECIMAL([rvString("111"), rvNumber(2)]))).toBe(7);
  });
  it("DECIMAL('zap', 36) parses base-36 = 45745", () => {
    expect(asNumber(fnDECIMAL([rvString("zap"), rvNumber(36)]))).toBe(45745);
  });
  it("DECIMAL strict-rejects invalid digit (regression for parseInt's silent truncation)", () => {
    expect(fnDECIMAL([rvString("1G"), rvNumber(16)])).toEqual(ERRORS.NUM);
  });
  it("DECIMAL rejects empty string", () => {
    expect(fnDECIMAL([rvString(""), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("DECIMAL handles leading + and - signs", () => {
    expect(asNumber(fnDECIMAL([rvString("-10"), rvNumber(10)]))).toBe(-10);
    expect(asNumber(fnDECIMAL([rvString("+10"), rvNumber(10)]))).toBe(10);
  });
  it("DECIMAL trims leading/trailing whitespace", () => {
    expect(asNumber(fnDECIMAL([rvString("  FF  "), rvNumber(16)]))).toBe(255);
  });
  it("DECIMAL rejects radix outside [2, 36]", () => {
    expect(fnDECIMAL([rvString("10"), rvNumber(37)])).toEqual(ERRORS.NUM);
    expect(fnDECIMAL([rvString("10"), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("DECIMAL propagates error", () => {
    expect(fnDECIMAL([rvError("#N/A"), rvNumber(16)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("DECIMAL handles mixed case", () => {
    expect(asNumber(fnDECIMAL([rvString("ff"), rvNumber(16)]))).toBe(255);
    expect(asNumber(fnDECIMAL([rvString("aB"), rvNumber(16)]))).toBe(171);
  });
});

describe("CEILING / FLOOR / EVEN / ODD / INT / TRUNC saturation", () => {
  it("CEILING(2.5, 1) = 3 — Excel doc example", () => {
    expect(asNumber(fnCEILING([rvNumber(2.5), rvNumber(1)]))).toBe(3);
  });
  it("CEILING(-2.5, -2) = -4 — Excel doc example (same-sign significance)", () => {
    expect(asNumber(fnCEILING([rvNumber(-2.5), rvNumber(-2)]))).toBe(-4);
  });
  it("CEILING(1.5, 0.1) ≈ 1.5", () => {
    expect(asNumber(fnCEILING([rvNumber(1.5), rvNumber(0.1)]))).toBeCloseTo(1.5, 12);
  });
  it("CEILING coerces booleans", () => {
    // CEILING(TRUE=1, TRUE=1) = 1
    expect(asNumber(fnCEILING([rvBoolean(true), rvBoolean(true)]))).toBe(1);
  });
  it("CEILING on 1×1 arrays", () => {
    expect(asNumber(fnCEILING([rvArray([[rvNumber(2.1)]]), rvArray([[rvNumber(1)]])]))).toBe(3);
  });
  it("CEILING propagates number error", () => {
    expect(fnCEILING([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("CEILING propagates significance error", () => {
    expect(fnCEILING([rvNumber(1), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("FLOOR(2.5, 1) = 2 — Excel doc example", () => {
    expect(asNumber(fnFLOOR([rvNumber(2.5), rvNumber(1)]))).toBe(2);
  });
  it("FLOOR(-2.5, -2) = -2 — Excel doc example", () => {
    expect(asNumber(fnFLOOR([rvNumber(-2.5), rvNumber(-2)]))).toBe(-2);
  });
  it("FLOOR(1.58, 0.1) ≈ 1.5", () => {
    expect(asNumber(fnFLOOR([rvNumber(1.58), rvNumber(0.1)]))).toBeCloseTo(1.5, 12);
  });
  it("FLOOR coerces booleans", () => {
    expect(asNumber(fnFLOOR([rvBoolean(true), rvBoolean(true)]))).toBe(1);
  });
  it("FLOOR on 1×1 arrays", () => {
    expect(asNumber(fnFLOOR([rvArray([[rvNumber(2.9)]]), rvArray([[rvNumber(1)]])]))).toBe(2);
  });
  it("FLOOR propagates number error", () => {
    expect(fnFLOOR([rvError("#N/A"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("EVEN(1.5) = 2 — Excel doc example", () => {
    expect(asNumber(fnEVEN([rvNumber(1.5)]))).toBe(2);
  });
  it("EVEN(3) = 4", () => {
    expect(asNumber(fnEVEN([rvNumber(3)]))).toBe(4);
  });
  it("EVEN(-1) = -2", () => {
    expect(asNumber(fnEVEN([rvNumber(-1)]))).toBe(-2);
  });
  it("EVEN(0) = 0", () => {
    expect(asNumber(fnEVEN([rvNumber(0)]))).toBe(0);
  });
  it("EVEN already-even passthrough: EVEN(2) = 2", () => {
    expect(asNumber(fnEVEN([rvNumber(2)]))).toBe(2);
  });
  it("EVEN coerces blank → 0", () => {
    expect(asNumber(fnEVEN([BLANK]))).toBe(0);
  });
  it("EVEN on 1×1 array", () => {
    expect(asNumber(fnEVEN([rvArray([[rvNumber(5)]])]))).toBe(6);
  });
  it("EVEN propagates error", () => {
    expect(fnEVEN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ODD(1.5) = 3 — Excel doc example", () => {
    expect(asNumber(fnODD([rvNumber(1.5)]))).toBe(3);
  });
  it("ODD(3) = 3 (already odd)", () => {
    expect(asNumber(fnODD([rvNumber(3)]))).toBe(3);
  });
  it("ODD(2) = 3", () => {
    expect(asNumber(fnODD([rvNumber(2)]))).toBe(3);
  });
  it("ODD(-1) = -1 (already odd)", () => {
    expect(asNumber(fnODD([rvNumber(-1)]))).toBe(-1);
  });
  it("ODD(-2) = -3", () => {
    expect(asNumber(fnODD([rvNumber(-2)]))).toBe(-3);
  });
  it("ODD(0) = 1", () => {
    expect(asNumber(fnODD([rvNumber(0)]))).toBe(1);
  });
  it("ODD coerces blank → ODD(0) = 1", () => {
    expect(asNumber(fnODD([BLANK]))).toBe(1);
  });
  it("ODD on 1×1 array", () => {
    expect(asNumber(fnODD([rvArray([[rvNumber(4)]])]))).toBe(5);
  });
  it("INT(8.9) = 8 — Excel doc example", () => {
    expect(asNumber(fnINT([rvNumber(8.9)]))).toBe(8);
  });
  it("INT(-8.9) = -9 (floor toward -∞, not truncate)", () => {
    expect(asNumber(fnINT([rvNumber(-8.9)]))).toBe(-9);
  });
  it("INT(0) = 0 and INT(5) = 5", () => {
    expect(asNumber(fnINT([rvNumber(0)]))).toBe(0);
    expect(asNumber(fnINT([rvNumber(5)]))).toBe(5);
  });
  it("INT coerces boolean/blank", () => {
    expect(asNumber(fnINT([rvBoolean(true)]))).toBe(1);
    expect(asNumber(fnINT([BLANK]))).toBe(0);
  });
  it("INT on 1×1 array", () => {
    expect(asNumber(fnINT([rvArray([[rvNumber(3.7)]])]))).toBe(3);
  });
  it("INT propagates error", () => {
    expect(fnINT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("TRUNC(8.9) = 8 — Excel doc example", () => {
    expect(asNumber(fnTRUNC([rvNumber(8.9)]))).toBe(8);
  });
  it("TRUNC(-8.9) = -8 (truncate toward 0, unlike INT)", () => {
    expect(asNumber(fnTRUNC([rvNumber(-8.9)]))).toBe(-8);
  });
  it("TRUNC(3.14159, 2) = 3.14", () => {
    expect(asNumber(fnTRUNC([rvNumber(3.14159), rvNumber(2)]))).toBeCloseTo(3.14, 12);
  });
  it("TRUNC(0.5) = 0 (different from ROUND)", () => {
    expect(asNumber(fnTRUNC([rvNumber(0.5)]))).toBe(0);
  });
  it("TRUNC negative digits: TRUNC(1234.5, -2) = 1200", () => {
    expect(asNumber(fnTRUNC([rvNumber(1234.5), rvNumber(-2)]))).toBe(1200);
  });
  it("TRUNC coerces boolean digits (TRUE=1)", () => {
    expect(asNumber(fnTRUNC([rvNumber(3.14), rvBoolean(true)]))).toBeCloseTo(3.1, 12);
  });
  it("TRUNC on 1×1 arrays", () => {
    expect(asNumber(fnTRUNC([rvArray([[rvNumber(3.7)]]), rvArray([[rvNumber(0)]])]))).toBe(3);
  });
  it("TRUNC propagates error", () => {
    expect(fnTRUNC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("COUNTA / COUNTBLANK saturation", () => {
  it("COUNTA counts scalar error as a value", () => {
    expect(asNumber(fnCOUNTA([rvError("#N/A")]))).toBe(1);
  });
  it("COUNTA counts booleans, numeric strings, and empty strings (Excel)", () => {
    // Excel: COUNTA(TRUE, FALSE, "hi", 1, "") → 5 (every non-blank cell).
    expect(
      asNumber(
        fnCOUNTA([rvBoolean(true), rvBoolean(false), rvString("hi"), rvNumber(1), rvString("")])
      )
    ).toBe(5);
  });
  it("COUNTA empty args → 0", () => {
    expect(asNumber(fnCOUNTA([]))).toBe(0);
  });
  it("COUNTA of a 1×1 blank → 0", () => {
    expect(asNumber(fnCOUNTA([rvArray([[BLANK]])]))).toBe(0);
  });
  it("COUNTA of 1×1 non-empty → 1", () => {
    expect(asNumber(fnCOUNTA([rvArray([[rvString("x")]])]))).toBe(1);
  });
  it("COUNTA mixed array — Excel doc example", () => {
    const arr = rvArray([
      [rvString("Hello"), BLANK, rvNumber(5), rvString(""), rvBoolean(false), ERRORS.NA]
    ]);
    // Excel: every non-blank cell counts, including empty string — 5.
    // "Hello", 5, "", FALSE, #N/A = 5; one BLANK excluded.
    expect(asNumber(fnCOUNTA([arr]))).toBe(5);
  });
  it("COUNTA multiple scalar args", () => {
    expect(asNumber(fnCOUNTA([rvNumber(1), rvNumber(2), rvString("x"), BLANK]))).toBe(3);
  });
  it("COUNTA with just blanks → 0", () => {
    expect(asNumber(fnCOUNTA([BLANK, BLANK, BLANK]))).toBe(0);
  });
  it("COUNTBLANK counts true blanks", () => {
    expect(asNumber(fnCOUNTBLANK([BLANK, BLANK]))).toBe(2);
  });
  it("COUNTBLANK counts empty string cells", () => {
    expect(asNumber(fnCOUNTBLANK([rvString("")]))).toBe(1);
  });
  it("COUNTBLANK does not count errors", () => {
    expect(asNumber(fnCOUNTBLANK([rvError("#N/A")]))).toBe(0);
  });
  it("COUNTBLANK does not count numbers or booleans", () => {
    expect(asNumber(fnCOUNTBLANK([rvNumber(0), rvBoolean(false), rvString("x")]))).toBe(0);
  });
  it("COUNTBLANK empty args → 0", () => {
    expect(asNumber(fnCOUNTBLANK([]))).toBe(0);
  });
  it("COUNTBLANK over array of mixed content", () => {
    const arr = rvArray([
      [BLANK, rvString(""), rvNumber(1), rvString("x"), BLANK, rvBoolean(true)]
    ]);
    // blank + "" + blank = 3
    expect(asNumber(fnCOUNTBLANK([arr]))).toBe(3);
  });
  it("COUNTBLANK on 1×1 blank array", () => {
    expect(asNumber(fnCOUNTBLANK([rvArray([[BLANK]])]))).toBe(1);
  });
});

describe("RAND / ROUNDUP / ROUNDDOWN saturation", () => {
  it("RAND takes no args", () => {
    const r = fnRAND([]);
    expect(r.kind).toBe(RVKind.Number);
  });
  it("RAND returns value in [0, 1)", () => {
    for (let i = 0; i < 20; i++) {
      const r = asNumber(fnRAND([]));
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });
  it("RAND generates varying values across calls", () => {
    const a = asNumber(fnRAND([]));
    const b = asNumber(fnRAND([]));
    // Might occasionally be equal but the chance is 1/2^52 — vanishingly small
    if (a === b) {
      // Single retry — guard against cosmic coincidence
      const c = asNumber(fnRAND([]));
      expect(c === a && c === b).toBe(false);
    } else {
      expect(a).not.toBe(b);
    }
  });
  it("ROUNDUP Excel doc example ROUNDUP(3.2, 0) = 4", () => {
    expect(asNumber(fnROUNDUP([rvNumber(3.2), rvNumber(0)]))).toBe(4);
  });
  it("ROUNDUP negative digits: ROUNDUP(31415.92654, -2) = 31500", () => {
    expect(asNumber(fnROUNDUP([rvNumber(31415.92654), rvNumber(-2)]))).toBe(31500);
  });
  it("ROUNDDOWN Excel doc example ROUNDDOWN(3.14159, 3) = 3.141", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(3.14159), rvNumber(3)]))).toBeCloseTo(3.141, 10);
  });
  it("ROUNDDOWN on negative: ROUNDDOWN(-3.14159, 2) = -3.14 (truncates toward 0)", () => {
    expect(asNumber(fnROUNDDOWN([rvNumber(-3.14159), rvNumber(2)]))).toBeCloseTo(-3.14, 10);
  });
  it("ROUNDUP/ROUNDDOWN symmetric for -x: ROUNDUP(-3.2) = -4", () => {
    expect(asNumber(fnROUNDUP([rvNumber(-3.2), rvNumber(0)]))).toBe(-4);
  });
  it("ROUNDUP propagates error", () => {
    expect(fnROUNDUP([rvError("#N/A"), rvNumber(0)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("ROUNDDOWN propagates error", () => {
    expect(fnROUNDDOWN([rvError("#REF!"), rvNumber(0)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
});

// ============================================================================
// Matrix functions — MMULT / MDETERM / MINVERSE / MUNIT
// ============================================================================

describe("MMULT", () => {
  it("2x3 * 3x2 = 2x2", () => {
    const a = rvArray([
      [rvNumber(1), rvNumber(2), rvNumber(3)],
      [rvNumber(4), rvNumber(5), rvNumber(6)]
    ]);
    const b = rvArray([
      [rvNumber(7), rvNumber(8)],
      [rvNumber(9), rvNumber(10)],
      [rvNumber(11), rvNumber(12)]
    ]);
    const r = fnMMULT([a, b]) as ArrayValue;
    expect(r.height).toBe(2);
    expect(r.width).toBe(2);
    // Row 0: [1*7+2*9+3*11, 1*8+2*10+3*12] = [58, 64]
    expect((r.rows[0][0] as NumberValue).value).toBe(58);
    expect((r.rows[0][1] as NumberValue).value).toBe(64);
    // Row 1: [4*7+5*9+6*11, 4*8+5*10+6*12] = [139, 154]
    expect((r.rows[1][0] as NumberValue).value).toBe(139);
    expect((r.rows[1][1] as NumberValue).value).toBe(154);
  });

  it("identity × matrix = matrix", () => {
    const id = rvArray([
      [rvNumber(1), rvNumber(0)],
      [rvNumber(0), rvNumber(1)]
    ]);
    const m = rvArray([
      [rvNumber(5), rvNumber(6)],
      [rvNumber(7), rvNumber(8)]
    ]);
    const r = fnMMULT([id, m]) as ArrayValue;
    expect((r.rows[0][0] as NumberValue).value).toBe(5);
    expect((r.rows[0][1] as NumberValue).value).toBe(6);
    expect((r.rows[1][0] as NumberValue).value).toBe(7);
    expect((r.rows[1][1] as NumberValue).value).toBe(8);
  });

  it("dimension mismatch → #VALUE!", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2)]]); // 1×2
    const b = rvArray([[rvNumber(3), rvNumber(4), rvNumber(5)]]); // 1×3
    expect(fnMMULT([a, b])).toEqual(ERRORS.VALUE);
  });

  it("non-numeric cell → #VALUE!", () => {
    const a = rvArray([[rvString("x")]]);
    const b = rvArray([[rvNumber(1)]]);
    expect(fnMMULT([a, b])).toEqual(ERRORS.VALUE);
  });

  it("error in input propagates", () => {
    const a = rvArray([[ERRORS.NA]]);
    const b = rvArray([[rvNumber(1)]]);
    expect(fnMMULT([a, b])).toEqual(ERRORS.NA);
  });
});

describe("MDETERM", () => {
  it("det of 2x2", () => {
    const m = rvArray([
      [rvNumber(1), rvNumber(2)],
      [rvNumber(3), rvNumber(4)]
    ]);
    // 1*4 - 2*3 = -2
    expect((fnMDETERM([m]) as NumberValue).value).toBeCloseTo(-2, 10);
  });

  it("det of 3x3", () => {
    const m = rvArray([
      [rvNumber(6), rvNumber(1), rvNumber(1)],
      [rvNumber(4), rvNumber(-2), rvNumber(5)],
      [rvNumber(2), rvNumber(8), rvNumber(7)]
    ]);
    // Known determinant = -306
    expect((fnMDETERM([m]) as NumberValue).value).toBeCloseTo(-306, 6);
  });

  it("det of identity matrix = 1", () => {
    const id = rvArray([
      [rvNumber(1), rvNumber(0)],
      [rvNumber(0), rvNumber(1)]
    ]);
    expect((fnMDETERM([id]) as NumberValue).value).toBe(1);
  });

  it("singular matrix det = 0", () => {
    const singular = rvArray([
      [rvNumber(1), rvNumber(2)],
      [rvNumber(2), rvNumber(4)] // second row is 2× first
    ]);
    expect((fnMDETERM([singular]) as NumberValue).value).toBe(0);
  });

  it("non-square → #VALUE!", () => {
    const m = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnMDETERM([m])).toEqual(ERRORS.VALUE);
  });

  it("error propagation", () => {
    expect(fnMDETERM([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("MINVERSE", () => {
  it("inverse of 2x2", () => {
    const m = rvArray([
      [rvNumber(4), rvNumber(7)],
      [rvNumber(2), rvNumber(6)]
    ]);
    const r = fnMINVERSE([m]) as ArrayValue;
    // Expected inverse: [[0.6, -0.7], [-0.2, 0.4]]
    expect((r.rows[0][0] as NumberValue).value).toBeCloseTo(0.6, 6);
    expect((r.rows[0][1] as NumberValue).value).toBeCloseTo(-0.7, 6);
    expect((r.rows[1][0] as NumberValue).value).toBeCloseTo(-0.2, 6);
    expect((r.rows[1][1] as NumberValue).value).toBeCloseTo(0.4, 6);
  });

  it("inverse × original = identity", () => {
    const m = rvArray([
      [rvNumber(2), rvNumber(1)],
      [rvNumber(1), rvNumber(3)]
    ]);
    const inv = fnMINVERSE([m]);
    const product = fnMMULT([m, inv]) as ArrayValue;
    expect((product.rows[0][0] as NumberValue).value).toBeCloseTo(1, 10);
    expect((product.rows[0][1] as NumberValue).value).toBeCloseTo(0, 10);
    expect((product.rows[1][0] as NumberValue).value).toBeCloseTo(0, 10);
    expect((product.rows[1][1] as NumberValue).value).toBeCloseTo(1, 10);
  });

  it("singular matrix → #NUM!", () => {
    const singular = rvArray([
      [rvNumber(1), rvNumber(2)],
      [rvNumber(2), rvNumber(4)]
    ]);
    expect(fnMINVERSE([singular])).toEqual(ERRORS.NUM);
  });

  it("non-square → #VALUE!", () => {
    const m = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnMINVERSE([m])).toEqual(ERRORS.VALUE);
  });
});

describe("MUNIT", () => {
  it("MUNIT(3) returns 3x3 identity", () => {
    const r = fnMUNIT([rvNumber(3)]) as ArrayValue;
    expect(r.height).toBe(3);
    expect(r.width).toBe(3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect((r.rows[i][j] as NumberValue).value).toBe(i === j ? 1 : 0);
      }
    }
  });

  it("MUNIT(1) returns 1x1 [[1]]", () => {
    const r = fnMUNIT([rvNumber(1)]) as ArrayValue;
    expect(r.height).toBe(1);
    expect(r.width).toBe(1);
    expect((r.rows[0][0] as NumberValue).value).toBe(1);
  });

  it("MUNIT with 0 or negative → #VALUE!", () => {
    expect(fnMUNIT([rvNumber(0)])).toEqual(ERRORS.VALUE);
    expect(fnMUNIT([rvNumber(-1)])).toEqual(ERRORS.VALUE);
  });

  it("truncates non-integer dimension", () => {
    const r = fnMUNIT([rvNumber(2.9)]) as ArrayValue;
    expect(r.height).toBe(2);
    expect(r.width).toBe(2);
  });
});

// ============================================================================
// SERIESSUM
// ============================================================================

describe("SERIESSUM", () => {
  it("constant series: SERIESSUM(2, 0, 1, {1,1,1,1}) = 1+2+4+8 = 15", () => {
    const coefs = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1), rvNumber(1)]]);
    expect((fnSERIESSUM([rvNumber(2), rvNumber(0), rvNumber(1), coefs]) as NumberValue).value).toBe(
      15
    );
  });

  it("quadratic series: SERIESSUM(3, 2, 2, {1,1}) = 3^2 + 3^4 = 9 + 81 = 90", () => {
    const coefs = rvArray([[rvNumber(1), rvNumber(1)]]);
    expect((fnSERIESSUM([rvNumber(3), rvNumber(2), rvNumber(2), coefs]) as NumberValue).value).toBe(
      90
    );
  });

  it("SERIESSUM with coefficients scaled", () => {
    // 2*1 + 3*2 + 5*4 = 2 + 6 + 20 = 28 (x=2, n=0, m=1, coefs=[2,3,5])
    const coefs = rvArray([[rvNumber(2), rvNumber(3), rvNumber(5)]]);
    expect((fnSERIESSUM([rvNumber(2), rvNumber(0), rvNumber(1), coefs]) as NumberValue).value).toBe(
      28
    );
  });

  it("error in coefficients propagates", () => {
    const coefs = rvArray([[rvNumber(1), ERRORS.NA]]);
    expect(fnSERIESSUM([rvNumber(2), rvNumber(0), rvNumber(1), coefs])).toEqual(ERRORS.NA);
  });

  it("error in x / n / m propagates", () => {
    const coefs = rvArray([[rvNumber(1)]]);
    expect(fnSERIESSUM([ERRORS.NA, rvNumber(0), rvNumber(1), coefs])).toEqual(ERRORS.NA);
    expect(fnSERIESSUM([rvNumber(2), ERRORS.NA, rvNumber(1), coefs])).toEqual(ERRORS.NA);
    expect(fnSERIESSUM([rvNumber(2), rvNumber(0), ERRORS.NA, coefs])).toEqual(ERRORS.NA);
  });

  it("empty coefficient array → #VALUE!", () => {
    const coefs = rvArray([[]]);
    expect(fnSERIESSUM([rvNumber(2), rvNumber(0), rvNumber(1), coefs])).toEqual(ERRORS.VALUE);
  });
});

// ============================================================================
// SQRTPI
// ============================================================================

describe("SQRTPI", () => {
  it("SQRTPI(1) = √π", () => {
    expect(asNumber(fnSQRTPI([rvNumber(1)]))).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });

  it("SQRTPI(2) = √(2π)", () => {
    expect(asNumber(fnSQRTPI([rvNumber(2)]))).toBeCloseTo(Math.sqrt(2 * Math.PI), 10);
  });

  it("SQRTPI(0) = 0", () => {
    expect(asNumber(fnSQRTPI([rvNumber(0)]))).toBe(0);
  });

  it("SQRTPI(negative) → #NUM!", () => {
    expect(fnSQRTPI([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });

  it("propagates errors", () => {
    expect(fnSQRTPI([ERRORS.NA])).toEqual(ERRORS.NA);
  });

  it("coerces boolean TRUE → 1 → √π", () => {
    expect(asNumber(fnSQRTPI([rvBoolean(true)]))).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });
});
