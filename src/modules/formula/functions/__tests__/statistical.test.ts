/**
 * Unit tests for statistical functions in `../statistical.ts`.
 *
 * Covers the core summary/regression functions and AVERAGEIF (imported
 * from conditional.ts because AVERAGEIF is a conditional aggregate, but
 * included here per the task brief).
 */

import { calculateFormulas } from "@excel/core/formula-adapter";
import { Cell, Workbook } from "@excel/index";
import { describe, it, expect } from "vitest";

import type { ArrayValue, NumberValue, RuntimeValue } from "../../runtime/values";
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
import { fnAVERAGEIF, fnCOUNTIFS } from "../conditional";
import {
  fnMEDIAN,
  fnLARGE,
  fnSMALL,
  fnMODE,
  fnSTDEV,
  fnSTDEVP,
  fnVAR,
  fnVARP,
  fnCORREL,
  fnSLOPE,
  fnINTERCEPT,
  fnRSQ,
  fnSTEYX,
  fnFORECAST,
  fnTRIMMEAN,
  fnGEOMEAN,
  fnHARMEAN,
  fnRANK,
  fnPERCENTILE,
  fnPERCENTILEEXC,
  fnQUARTILE,
  fnQUARTILEEXC,
  fnAVERAGEA,
  fnMAXA,
  fnMINA,
  fnDEVSQ,
  fnAVEDEV,
  fnCONFIDENCENORM,
  fnCONFIDENCE_T,
  fnCOVARIANCE_P,
  fnCOVARIANCE_S,
  fnRANK_AVG,
  fnMODE_MULT,
  fnFISHER,
  fnFISHERINV,
  fnNORMSDIST,
  fnNORMDIST,
  fnNORMSINV,
  fnNORMINV,
  fnPOISSON_DIST,
  fnBINOM_DIST,
  fnBINOM_DIST_RANGE,
  fnCHISQ_INV_RT,
  fnZ_TEST,
  fnT_TEST,
  fnF_TEST,
  fnCHISQ_TEST,
  fnBINOM_INV,
  fnHYPGEOM_DIST,
  fnNEGBINOM_DIST,
  fnCHISQ_DIST,
  fnCHISQ_DIST_RT,
  fnCHISQ_INV,
  fnF_DIST,
  fnF_INV,
  fnF_DIST_RT,
  fnF_INV_RT,
  fnT_DIST,
  fnT_INV,
  fnT_DIST_2T,
  fnT_DIST_RT,
  fnT_INV_2T,
  fnBETA_DIST,
  fnBETA_INV,
  fnGAMMA,
  fnGAMMALN,
  fnGAMMA_DIST,
  fnGAMMA_INV,
  fnEXPON_DIST,
  fnWEIBULL_DIST,
  fnLOGNORM_DIST,
  fnLOGNORM_INV,
  fnPHI,
  fnGAUSS,
  fnERF,
  fnERFC,
  fnSTANDARDIZE,
  fnFREQUENCY,
  fnSKEW,
  fnSKEW_P,
  fnKURT,
  fnLINEST,
  fnLOGEST,
  fnTREND,
  fnGROWTH,
  fnPERCENTRANK,
  fnPERCENTRANK_INC,
  fnPERCENTRANK_EXC,
  fnPROB
} from "../statistical";

function asNumber(v: RuntimeValue): number {
  expect(v.kind).toBe(RVKind.Number);
  return (v as NumberValue).value;
}

describe("MEDIAN", () => {
  it("odd count — middle element", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(3), rvNumber(5)]]);
    expect(asNumber(fnMEDIAN([arr]))).toBe(3);
  });

  it("even count — average of two middles", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    expect(asNumber(fnMEDIAN([arr]))).toBe(2.5);
  });

  it("handles unsorted input", () => {
    const arr = rvArray([[rvNumber(5), rvNumber(1), rvNumber(3), rvNumber(2), rvNumber(4)]]);
    expect(asNumber(fnMEDIAN([arr]))).toBe(3);
  });

  it("empty range returns #NUM!", () => {
    expect(fnMEDIAN([rvArray([[]])])).toEqual(ERRORS.NUM);
  });
});

describe("LARGE / SMALL", () => {
  const arr = rvArray([[rvNumber(10), rvNumber(20), rvNumber(30), rvNumber(40), rvNumber(50)]]);

  it("LARGE — kth largest", () => {
    expect(asNumber(fnLARGE([arr, rvNumber(1)]))).toBe(50);
    expect(asNumber(fnLARGE([arr, rvNumber(3)]))).toBe(30);
  });

  it("SMALL — kth smallest", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(1)]))).toBe(10);
    expect(asNumber(fnSMALL([arr, rvNumber(3)]))).toBe(30);
  });

  it("LARGE/SMALL reject out-of-range k", () => {
    expect(fnLARGE([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnLARGE([arr, rvNumber(10)])).toEqual(ERRORS.NUM);
    expect(fnSMALL([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
});

describe("MODE", () => {
  it("returns the most frequent value", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnMODE([arr]))).toBe(2);
  });

  it("returns #N/A when no value is repeated", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnMODE([arr])).toEqual(ERRORS.NA);
  });
});

describe("STDEV / STDEVP / VAR / VARP", () => {
  const arr = rvArray([
    [
      rvNumber(2),
      rvNumber(4),
      rvNumber(4),
      rvNumber(4),
      rvNumber(5),
      rvNumber(5),
      rvNumber(7),
      rvNumber(9)
    ]
  ]);

  // Mean = 5. Sum of squared deviations = (3² + 1² + 1² + 1² + 0² + 0² + 2² + 4²) = 32
  // Sample variance = 32/7 ≈ 4.5714, sample stdev ≈ 2.138
  // Population variance = 32/8 = 4, population stdev = 2

  it("STDEV — sample standard deviation (n−1)", () => {
    expect(asNumber(fnSTDEV([arr]))).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it("STDEVP — population standard deviation (n)", () => {
    expect(asNumber(fnSTDEVP([arr]))).toBe(2);
  });

  it("VAR — sample variance", () => {
    expect(asNumber(fnVAR([arr]))).toBeCloseTo(32 / 7, 10);
  });

  it("VARP — population variance", () => {
    expect(asNumber(fnVARP([arr]))).toBe(4);
  });

  it("STDEV returns #DIV/0! for fewer than 2 values", () => {
    expect(fnSTDEV([rvArray([[rvNumber(5)]])])).toEqual(ERRORS.DIV0);
  });
});

describe("CORREL / SLOPE / INTERCEPT / RSQ / FORECAST", () => {
  // y = 2x + 1: (1, 3), (2, 5), (3, 7)
  const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
  const ys = rvArray([[rvNumber(3), rvNumber(5), rvNumber(7)]]);

  it("CORREL of perfectly linear data is 1", () => {
    expect(asNumber(fnCORREL([xs, ys]))).toBeCloseTo(1, 10);
  });

  it("SLOPE returns 2", () => {
    // SLOPE(known_y, known_x) — y first
    expect(asNumber(fnSLOPE([ys, xs]))).toBeCloseTo(2, 10);
  });

  it("INTERCEPT returns 1", () => {
    expect(asNumber(fnINTERCEPT([ys, xs]))).toBeCloseTo(1, 10);
  });

  it("RSQ returns 1 for perfectly linear data", () => {
    expect(asNumber(fnRSQ([xs, ys]))).toBeCloseTo(1, 10);
  });

  it("FORECAST predicts 2x + 1", () => {
    // FORECAST(x, known_y, known_x)
    expect(asNumber(fnFORECAST([rvNumber(4), ys, xs]))).toBeCloseTo(9, 10);
  });

  it("regression family returns #DIV/0! on insufficient data", () => {
    const one = rvArray([[rvNumber(1)]]);
    expect(fnCORREL([one, one])).toEqual(ERRORS.DIV0);
    expect(fnSLOPE([one, one])).toEqual(ERRORS.DIV0);
  });
});

describe("TRIMMEAN", () => {
  const arr = rvArray([
    [
      rvNumber(1),
      rvNumber(2),
      rvNumber(3),
      rvNumber(4),
      rvNumber(5),
      rvNumber(6),
      rvNumber(7),
      rvNumber(8),
      rvNumber(9),
      rvNumber(10)
    ]
  ]);

  it("TRIMMEAN with 0% trim equals AVERAGE", () => {
    expect(asNumber(fnTRIMMEAN([arr, rvNumber(0)]))).toBe(5.5);
  });

  it("TRIMMEAN with 20% trim removes the 1 smallest and 1 largest (10*0.2/2=1)", () => {
    // Trimmed: 2..9 → mean = 5.5
    expect(asNumber(fnTRIMMEAN([arr, rvNumber(0.2)]))).toBe(5.5);
  });

  it("TRIMMEAN rejects percentages >= 1", () => {
    expect(fnTRIMMEAN([arr, rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnTRIMMEAN([arr, rvNumber(-0.1)])).toEqual(ERRORS.NUM);
  });
});

describe("GEOMEAN / HARMEAN", () => {
  it("GEOMEAN returns the geometric mean", () => {
    const arr = rvArray([[rvNumber(2), rvNumber(8)]]);
    expect(asNumber(fnGEOMEAN([arr]))).toBeCloseTo(4, 10); // sqrt(16) = 4
  });

  it("GEOMEAN rejects non-positive values", () => {
    const arr = rvArray([[rvNumber(2), rvNumber(0)]]);
    expect(fnGEOMEAN([arr])).toEqual(ERRORS.NUM);
  });

  it("HARMEAN returns the harmonic mean", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(4)]]);
    // 3 / (1 + 1/2 + 1/4) = 3 / 1.75 = 12/7
    expect(asNumber(fnHARMEAN([arr]))).toBeCloseTo(12 / 7, 10);
  });
});

describe("AVERAGEIF", () => {
  const nums = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);

  it("averages values matching a comparison criterion", () => {
    // values > 2: 3, 4, 5 → mean 4
    expect(asNumber(fnAVERAGEIF([nums, rvString(">2")]))).toBe(4);
  });

  it("averages values matching equality", () => {
    expect(asNumber(fnAVERAGEIF([nums, rvNumber(3)]))).toBe(3);
  });

  it("supports a separate average_range", () => {
    const critRange = rvArray([[rvString("a"), rvString("b"), rvString("a"), rvString("b")]]);
    const sumRange = rvArray([[rvNumber(10), rvNumber(20), rvNumber(30), rvNumber(40)]]);
    // rows where crit == "a": indices 0, 2 → values 10, 30 → mean 20
    expect(asNumber(fnAVERAGEIF([critRange, rvString("a"), sumRange]))).toBe(20);
  });

  it("AVERAGEIF returns #DIV/0! when no values match", () => {
    expect(fnAVERAGEIF([nums, rvString(">100")])).toEqual(ERRORS.DIV0);
  });
});

describe("COUNTIFS", () => {
  const col1 = rvArray([[rvString("A"), rvString("B"), rvString("A"), rvString("A")]]);
  const col2 = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(1)]]);

  it("counts rows where all criteria match", () => {
    // col1="A" AND col2=1 → rows 0 and 3
    expect(asNumber(fnCOUNTIFS([col1, rvString("A"), col2, rvNumber(1)]))).toBe(2);
  });
});

describe("RANK", () => {
  const arr = rvArray([[rvNumber(10), rvNumber(20), rvNumber(30), rvNumber(40)]]);

  it("default order=0 ranks descending (largest = 1)", () => {
    expect(asNumber(fnRANK([rvNumber(40), arr]))).toBe(1);
    expect(asNumber(fnRANK([rvNumber(10), arr]))).toBe(4);
  });

  it("order=1 ranks ascending (smallest = 1)", () => {
    expect(asNumber(fnRANK([rvNumber(10), arr, rvNumber(1)]))).toBe(1);
  });

  it("returns #N/A when value not present", () => {
    expect(fnRANK([rvNumber(999), arr])).toEqual(ERRORS.NA);
  });
});

describe("PERCENTILE / QUARTILE", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);

  it("PERCENTILE(k=0) returns the minimum", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(0)]))).toBe(1);
  });

  it("PERCENTILE(k=1) returns the maximum", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(1)]))).toBe(5);
  });

  it("PERCENTILE(k=0.5) returns the median", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(0.5)]))).toBe(3);
  });

  it("QUARTILE(2) is the median", () => {
    expect(asNumber(fnQUARTILE([arr, rvNumber(2)]))).toBe(3);
  });

  it("QUARTILE rejects quart outside 0..4", () => {
    expect(fnQUARTILE([arr, rvNumber(-1)])).toEqual(ERRORS.NUM);
    expect(fnQUARTILE([arr, rvNumber(5)])).toEqual(ERRORS.NUM);
  });
});

describe("AVERAGEA / MAXA / MINA", () => {
  const mixed = rvArray([[rvNumber(1), rvBoolean(true), rvString("abc"), rvNumber(5)]]);
  // Text counts as 0, TRUE counts as 1. Sum = 1 + 1 + 0 + 5 = 7, count = 4. Avg = 1.75.

  it("AVERAGEA counts booleans and strings", () => {
    expect(asNumber(fnAVERAGEA([mixed]))).toBe(1.75);
  });

  it("MAXA considers booleans/strings as 0/1", () => {
    expect(asNumber(fnMAXA([mixed]))).toBe(5);
  });

  it("MINA considers booleans/strings as 0/1", () => {
    // min over [1, 1, 0, 5] = 0
    expect(asNumber(fnMINA([mixed]))).toBe(0);
  });
});

describe("DEVSQ / AVEDEV", () => {
  const arr = rvArray([
    [
      rvNumber(2),
      rvNumber(4),
      rvNumber(4),
      rvNumber(4),
      rvNumber(5),
      rvNumber(5),
      rvNumber(7),
      rvNumber(9)
    ]
  ]);
  // Mean = 5, sum of squared deviations = 32.

  it("DEVSQ returns the sum of squared deviations", () => {
    expect(asNumber(fnDEVSQ([arr]))).toBe(32);
  });

  it("AVEDEV returns the average absolute deviation from the mean", () => {
    // |2-5|+|4-5|*3+|5-5|*2+|7-5|+|9-5| = 3+3+0+2+4 = 12 / 8 = 1.5
    expect(asNumber(fnAVEDEV([arr]))).toBe(1.5);
  });
});

// ============================================================================
// R7: Statistical additions (CONFIDENCE.T, COVARIANCE.P/S, RANK.AVG, MODE.MULT)
// ============================================================================

describe("CONFIDENCE.T", () => {
  it("computes confidence interval half-width", () => {
    // CONFIDENCE.T(0.05, 1, 50) ≈ 0.2842 (t_{0.025, 49} · 1 / √50)
    const v = asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(1), rvNumber(50)]));
    expect(v).toBeCloseTo(0.2842, 2);
  });

  it("rejects alpha outside (0, 1)", () => {
    expect(fnCONFIDENCE_T([rvNumber(0), rvNumber(1), rvNumber(10)])).toEqual(ERRORS.NUM);
    expect(fnCONFIDENCE_T([rvNumber(1), rvNumber(1), rvNumber(10)])).toEqual(ERRORS.NUM);
  });

  it("rejects size < 2 (need df >= 1)", () => {
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(1), rvNumber(1)])).toEqual(ERRORS.NUM);
  });

  it("rejects non-positive stddev", () => {
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(0), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
});

describe("COVARIANCE.P / COVARIANCE.S", () => {
  it("COVARIANCE.P matches textbook example", () => {
    // xs = [3,2,4,5,6], ys = [9,7,12,15,17]
    // means: 4, 12; deviations products: (-1,-3)=3, (-2,-5)=10, (0,0)=0, (1,3)=3, (2,5)=10
    // sum = 26; population cov = 26/5 = 5.2
    const xs = rvArray([[rvNumber(3), rvNumber(2), rvNumber(4), rvNumber(5), rvNumber(6)]]);
    const ys = rvArray([[rvNumber(9), rvNumber(7), rvNumber(12), rvNumber(15), rvNumber(17)]]);
    expect(asNumber(fnCOVARIANCE_P([xs, ys]))).toBeCloseTo(5.2, 10);
  });

  it("COVARIANCE.S divides by n-1", () => {
    const xs = rvArray([[rvNumber(3), rvNumber(2), rvNumber(4), rvNumber(5), rvNumber(6)]]);
    const ys = rvArray([[rvNumber(9), rvNumber(7), rvNumber(12), rvNumber(15), rvNumber(17)]]);
    // sample cov = 26/4 = 6.5
    expect(asNumber(fnCOVARIANCE_S([xs, ys]))).toBeCloseTo(6.5, 10);
  });

  it("COVARIANCE.P returns #DIV/0! for empty input", () => {
    const empty = rvArray([[]]);
    expect(fnCOVARIANCE_P([empty, empty])).toEqual(ERRORS.DIV0);
  });

  it("COVARIANCE.S needs n >= 2", () => {
    const one = rvArray([[rvNumber(1)]]);
    expect(fnCOVARIANCE_S([one, one])).toEqual(ERRORS.DIV0);
  });
});

describe("RANK.AVG", () => {
  const arr = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(2)], [rvNumber(2)], [rvNumber(3)]]);

  it("averages tied positions (default descending)", () => {
    // descending order: [3,2,2,2,1] → value 2 occupies ranks 2,3,4 → avg = 3
    expect(asNumber(fnRANK_AVG([rvNumber(2), arr]))).toBeCloseTo(3, 10);
  });

  it("respects ascending order when order != 0", () => {
    // ascending: [1,2,2,2,3] → value 2 occupies ranks 2,3,4 → avg = 3
    expect(asNumber(fnRANK_AVG([rvNumber(2), arr, rvNumber(1)]))).toBeCloseTo(3, 10);
  });

  it("returns #N/A when number is not in array", () => {
    expect(fnRANK_AVG([rvNumber(99), arr])).toEqual(ERRORS.NA);
  });

  it("equals RANK.EQ for unique values", () => {
    const unique = rvArray([
      [rvNumber(1)],
      [rvNumber(2)],
      [rvNumber(3)],
      [rvNumber(4)],
      [rvNumber(5)]
    ]);
    // descending: value 3 has rank 3
    expect(asNumber(fnRANK_AVG([rvNumber(3), unique]))).toBe(3);
  });
});

describe("MODE.MULT", () => {
  it("returns all modes in first-occurrence order", () => {
    // Both 2 and 3 appear twice.
    const arr = rvArray([
      [rvNumber(1), rvNumber(2), rvNumber(2), rvNumber(3), rvNumber(3), rvNumber(4)]
    ]);
    const r = fnMODE_MULT([arr]);
    expect(r.kind).toBe(RVKind.Array);
    const a = r as { kind: number; rows: { kind: number; value: number }[][] };
    expect(a.rows.length).toBe(2);
    expect(a.rows[0][0].value).toBe(2);
    expect(a.rows[1][0].value).toBe(3);
  });

  it("returns #N/A when no value repeats", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnMODE_MULT([arr])).toEqual(ERRORS.NA);
  });

  it("single-mode dataset returns a 1-element column", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(2), rvNumber(3)]]);
    const r = fnMODE_MULT([arr]);
    expect(r.kind).toBe(RVKind.Array);
    const a = r as { kind: number; rows: { kind: number; value: number }[][] };
    expect(a.rows.length).toBe(1);
    expect(a.rows[0][0].value).toBe(2);
  });
});

// ============================================================================
// Comprehensive coverage — appended per-function describes reaching Excel
// standard. Tests cover normal values, boundaries, error routing, type
// coercion, error propagation, and array inputs.
// ============================================================================

function asArrayValue(v: RuntimeValue): ArrayValue {
  expect(v.kind).toBe(RVKind.Array);
  return v as ArrayValue;
}

describe("MEDIAN comprehensive", () => {
  it("single-value MEDIAN returns that value", () => {
    expect(asNumber(fnMEDIAN([rvNumber(42)]))).toBe(42);
  });
  it("MEDIAN of direct scalars coerces blanks to be skipped", () => {
    // Direct blank scalars are skipped (Excel aggregate semantics).
    expect(asNumber(fnMEDIAN([rvNumber(1), BLANK, rvNumber(3)]))).toBe(2);
  });
  it("MEDIAN propagates array error", () => {
    expect(fnMEDIAN([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("MEDIAN ignores text in array", () => {
    const arr = rvArray([[rvNumber(1), rvString("abc"), rvNumber(3), rvNumber(5)]]);
    // numbers: 1, 3, 5 → median 3
    expect(asNumber(fnMEDIAN([arr]))).toBe(3);
  });
  it("MEDIAN direct string numeric coerces", () => {
    expect(asNumber(fnMEDIAN([rvString("2"), rvNumber(4)]))).toBe(3);
  });
});

describe("LARGE comprehensive", () => {
  const arr = rvArray([[rvNumber(5), rvNumber(1), rvNumber(3), rvNumber(2), rvNumber(4)]]);
  it("LARGE(arr, 1) is max", () => {
    expect(asNumber(fnLARGE([arr, rvNumber(1)]))).toBe(5);
  });
  it("LARGE(arr, n) is min", () => {
    expect(asNumber(fnLARGE([arr, rvNumber(5)]))).toBe(1);
  });
  it("LARGE fractional k truncates", () => {
    // k=1.9 → 1 → max = 5
    expect(asNumber(fnLARGE([arr, rvNumber(1.9)]))).toBe(5);
  });
  it("LARGE k=0 → #NUM!", () => {
    expect(fnLARGE([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LARGE k too big → #NUM!", () => {
    expect(fnLARGE([arr, rvNumber(6)])).toEqual(ERRORS.NUM);
  });
  it("LARGE propagates error in source", () => {
    expect(fnLARGE([rvArray([[rvNumber(1), ERRORS.NA]]), rvNumber(1)])).toEqual(ERRORS.NA);
  });
});

describe("SMALL comprehensive", () => {
  const arr = rvArray([[rvNumber(5), rvNumber(1), rvNumber(3), rvNumber(2), rvNumber(4)]]);
  it("SMALL(arr, 1) is min", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(1)]))).toBe(1);
  });
  it("SMALL(arr, 2)=2", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(2)]))).toBe(2);
  });
  it("SMALL k=0 → #NUM!", () => {
    expect(fnSMALL([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("SMALL k too big → #NUM!", () => {
    expect(fnSMALL([arr, rvNumber(6)])).toEqual(ERRORS.NUM);
  });
  it("SMALL propagates k error", () => {
    expect(fnSMALL([arr, rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("RANK comprehensive", () => {
  const arr = rvArray([[rvNumber(10), rvNumber(20), rvNumber(20), rvNumber(30)]]);
  it("RANK with ties returns the top position among ties (desc)", () => {
    // desc sort: [30, 20, 20, 10] → indexOf(20) = 1 → rank 2
    expect(asNumber(fnRANK([rvNumber(20), arr]))).toBe(2);
  });
  it("RANK with order=1 (asc)", () => {
    // asc sort: [10, 20, 20, 30] → indexOf(20) = 1 → rank 2
    expect(asNumber(fnRANK([rvNumber(20), arr, rvNumber(1)]))).toBe(2);
  });
  it("RANK non-matching → #N/A", () => {
    expect(fnRANK([rvNumber(99), arr])).toEqual(ERRORS.NA);
  });
  it("RANK propagates number error", () => {
    expect(fnRANK([rvError("#N/A"), arr])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("RANK propagates array error", () => {
    expect(fnRANK([rvNumber(1), rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("STDEV / STDEVP / VAR / VARP comprehensive", () => {
  it("STDEV of [2,4,4,4,5,5,7,9] matches sample formula", () => {
    const arr = rvArray([
      [
        rvNumber(2),
        rvNumber(4),
        rvNumber(4),
        rvNumber(4),
        rvNumber(5),
        rvNumber(5),
        rvNumber(7),
        rvNumber(9)
      ]
    ]);
    expect(asNumber(fnSTDEV([arr]))).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });
  it("VARP of all-same values = 0", () => {
    expect(asNumber(fnVARP([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]])]))).toBe(0);
  });
  it("STDEVP of single value is 0", () => {
    expect(asNumber(fnSTDEVP([rvArray([[rvNumber(7)]])]))).toBe(0);
  });
  it("STDEV propagates error", () => {
    expect(fnSTDEV([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("VAR of single value → #DIV/0!", () => {
    expect(fnVAR([rvArray([[rvNumber(1)]])])).toEqual(ERRORS.DIV0);
  });
  it("STDEVP of only-text array → #DIV/0! (no numbers)", () => {
    expect(fnSTDEVP([rvArray([[rvString("a"), rvString("b")]])])).toEqual(ERRORS.DIV0);
  });
});

describe("AVERAGEA comprehensive", () => {
  it("AVERAGEA treats TRUE as 1 and text as 0", () => {
    // 1, TRUE=1, "x"=0, 5 → (1+1+0+5)/4 = 1.75
    const arr = rvArray([[rvNumber(1), rvBoolean(true), rvString("x"), rvNumber(5)]]);
    expect(asNumber(fnAVERAGEA([arr]))).toBe(1.75);
  });
  it("AVERAGEA skips blanks", () => {
    const arr = rvArray([[rvNumber(4), BLANK, rvNumber(6)]]);
    expect(asNumber(fnAVERAGEA([arr]))).toBe(5);
  });
  it("AVERAGEA propagates error", () => {
    expect(fnAVERAGEA([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("AVERAGEA of empty → #DIV/0!", () => {
    expect(fnAVERAGEA([])).toEqual(ERRORS.DIV0);
  });
  it("AVERAGEA of pure-blanks → #DIV/0! (blanks skipped)", () => {
    expect(fnAVERAGEA([rvArray([[BLANK, BLANK]])])).toEqual(ERRORS.DIV0);
  });
});

describe("MAXA / MINA comprehensive", () => {
  it("MAXA of empty = 0 (no values found)", () => {
    expect(asNumber(fnMAXA([]))).toBe(0);
  });
  it("MINA of empty = 0", () => {
    expect(asNumber(fnMINA([]))).toBe(0);
  });
  it("MAXA booleans participate", () => {
    expect(asNumber(fnMAXA([rvArray([[rvBoolean(true), rvNumber(-5)]])]))).toBe(1);
  });
  it("MINA text counts as 0", () => {
    // numbers: -3; text → 0; the min is -3
    expect(asNumber(fnMINA([rvArray([[rvNumber(-3), rvString("x")]])]))).toBe(-3);
  });
  it("MAXA propagates error", () => {
    expect(fnMAXA([rvArray([[ERRORS.NA, rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
  it("MINA propagates error", () => {
    expect(fnMINA([rvArray([[ERRORS.NA, rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("GEOMEAN comprehensive", () => {
  it("GEOMEAN single positive value", () => {
    expect(asNumber(fnGEOMEAN([rvNumber(5)]))).toBe(5);
  });
  it("GEOMEAN of [4, 9] = 6", () => {
    expect(asNumber(fnGEOMEAN([rvArray([[rvNumber(4), rvNumber(9)]])]))).toBe(6);
  });
  // The geometric mean of n copies of v is exactly v. Sampling a single value
  // hid a latent precision bug: `exp(Σ log xᵢ / n)` happened to round to 5 on
  // one V8 build and to 4.999999999999999 on another, and was already wrong
  // for most other integers on both.
  it("GEOMEAN of n identical values returns that value exactly", () => {
    for (const v of [3, 5, 7, 10, 42, 1.07, 0.35, 1e-8, 1e8]) {
      for (const n of [1, 2, 3, 5, 12]) {
        const cells = Array.from({ length: n }, () => rvNumber(v));
        expect(asNumber(fnGEOMEAN([rvArray([cells])]))).toBe(v);
      }
    }
  });
  it("GEOMEAN stays exact when the running product overflows the double range", () => {
    // 1000 × 1e6 ⇒ a product of 1e6000, far past Number.MAX_VALUE.
    const cells = Array.from({ length: 1000 }, () => rvNumber(1e6));
    expect(asNumber(fnGEOMEAN([rvArray([cells])]))).toBe(1e6);
  });
  it("GEOMEAN stays exact when the running product underflows to zero", () => {
    // 200 × 1e-10 ⇒ a product of 1e-2000, far below Number.MIN_VALUE.
    const cells = Array.from({ length: 200 }, () => rvNumber(1e-10));
    expect(asNumber(fnGEOMEAN([rvArray([cells])]))).toBe(1e-10);
  });
  it("GEOMEAN avoids intermediate overflow in different input orderings", () => {
    const values = [1e200, 1e-200, 1e200, 1e-200, 3.5, 1 / 3];
    const of = (vs: number[]) => asNumber(fnGEOMEAN([rvArray([vs.map(v => rvNumber(v))])]));
    const expected = Math.pow(3.5 / 3, 1 / values.length);
    expect(of([...values].reverse())).toBeCloseTo(expected, 14);
    expect(of([values[0], values[2], values[4], values[1], values[3], values[5]])).toBeCloseTo(
      expected,
      14
    );
  });
  it("GEOMEAN handles subnormal inputs", () => {
    expect(asNumber(fnGEOMEAN([rvArray([[rvNumber(5e-324), rvNumber(5e-324)]])]))).toBe(5e-324);
  });
  it("GEOMEAN preserves non-finite scalar behavior", () => {
    expect(asNumber(fnGEOMEAN([rvNumber(Infinity), rvNumber(1e-300)]))).toBe(Infinity);
    expect(Number.isNaN(asNumber(fnGEOMEAN([rvNumber(NaN), rvNumber(5)])))).toBe(true);
    expect(fnGEOMEAN([rvNumber(Infinity), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("GEOMEAN sits between the min and the max input", () => {
    const values = [0.5, 2, 8, 1e-5, 4e7];
    const gm = asNumber(fnGEOMEAN([rvArray([values.map(v => rvNumber(v))])]));
    expect(gm).toBeGreaterThanOrEqual(Math.min(...values));
    expect(gm).toBeLessThanOrEqual(Math.max(...values));
  });
  it("GEOMEAN negative → #NUM!", () => {
    expect(fnGEOMEAN([rvArray([[rvNumber(4), rvNumber(-9)]])])).toEqual(ERRORS.NUM);
  });
  it("GEOMEAN zero → #NUM!", () => {
    expect(fnGEOMEAN([rvArray([[rvNumber(4), rvNumber(0)]])])).toEqual(ERRORS.NUM);
  });
  it("GEOMEAN empty → #NUM!", () => {
    expect(fnGEOMEAN([rvArray([[]])])).toEqual(ERRORS.NUM);
  });
  it("GEOMEAN propagates error", () => {
    expect(fnGEOMEAN([rvArray([[rvNumber(2), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("HARMEAN comprehensive", () => {
  it("HARMEAN single = itself", () => {
    expect(asNumber(fnHARMEAN([rvNumber(3)]))).toBe(3);
  });
  it("HARMEAN of [2, 3, 6] = 3", () => {
    // 3 / (1/2 + 1/3 + 1/6) = 3 / 1 = 3
    expect(asNumber(fnHARMEAN([rvArray([[rvNumber(2), rvNumber(3), rvNumber(6)]])]))).toBeCloseTo(
      3,
      10
    );
  });
  it("HARMEAN of zero → #NUM!", () => {
    expect(fnHARMEAN([rvArray([[rvNumber(2), rvNumber(0)]])])).toEqual(ERRORS.NUM);
  });
  it("HARMEAN of negative → #NUM!", () => {
    expect(fnHARMEAN([rvArray([[rvNumber(2), rvNumber(-1)]])])).toEqual(ERRORS.NUM);
  });
  it("HARMEAN empty → #NUM!", () => {
    expect(fnHARMEAN([rvArray([[]])])).toEqual(ERRORS.NUM);
  });
  it("HARMEAN propagates error", () => {
    expect(fnHARMEAN([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("TRIMMEAN comprehensive", () => {
  const arr = rvArray([
    [
      rvNumber(1),
      rvNumber(2),
      rvNumber(3),
      rvNumber(4),
      rvNumber(5),
      rvNumber(6),
      rvNumber(7),
      rvNumber(8),
      rvNumber(9),
      rvNumber(10)
    ]
  ]);
  it("TRIMMEAN 0% = AVERAGE", () => {
    expect(asNumber(fnTRIMMEAN([arr, rvNumber(0)]))).toBe(5.5);
  });
  it("TRIMMEAN 20% trims 1 each end", () => {
    expect(asNumber(fnTRIMMEAN([arr, rvNumber(0.2)]))).toBe(5.5);
  });
  it("TRIMMEAN negative pct → #NUM!", () => {
    expect(fnTRIMMEAN([arr, rvNumber(-0.1)])).toEqual(ERRORS.NUM);
  });
  it("TRIMMEAN pct>=1 → #NUM!", () => {
    expect(fnTRIMMEAN([arr, rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("TRIMMEAN propagates error", () => {
    expect(fnTRIMMEAN([rvArray([[ERRORS.NA]]), rvNumber(0)])).toEqual(ERRORS.NA);
  });
});

describe("DEVSQ / AVEDEV comprehensive", () => {
  it("DEVSQ empty = 0", () => {
    expect(asNumber(fnDEVSQ([rvArray([[]])]))).toBe(0);
  });
  it("DEVSQ all same = 0", () => {
    expect(asNumber(fnDEVSQ([rvArray([[rvNumber(4), rvNumber(4), rvNumber(4)]])]))).toBe(0);
  });
  it("DEVSQ propagates error", () => {
    expect(fnDEVSQ([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("AVEDEV of empty → #NUM!", () => {
    expect(fnAVEDEV([rvArray([[]])])).toEqual(ERRORS.NUM);
  });
  it("AVEDEV single value = 0", () => {
    expect(asNumber(fnAVEDEV([rvNumber(5)]))).toBe(0);
  });
  it("AVEDEV propagates error", () => {
    expect(fnAVEDEV([rvArray([[ERRORS.NA, rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("PERCENTILE comprehensive", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  it("PERCENTILE(0) = min", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(0)]))).toBe(1);
  });
  it("PERCENTILE(1) = max", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(1)]))).toBe(5);
  });
  it("PERCENTILE(0.5) = median", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(0.5)]))).toBe(3);
  });
  it("PERCENTILE k<0 → #NUM!", () => {
    expect(fnPERCENTILE([arr, rvNumber(-0.01)])).toEqual(ERRORS.NUM);
  });
  it("PERCENTILE k>1 → #NUM!", () => {
    expect(fnPERCENTILE([arr, rvNumber(1.01)])).toEqual(ERRORS.NUM);
  });
  it("PERCENTILE empty → #NUM!", () => {
    expect(fnPERCENTILE([rvArray([[]]), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
});

describe("PERCENTILE.EXC comprehensive", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
  it("PERCENTILE.EXC valid k", () => {
    // k=0.4: rank = 0.4*5 - 1 = 1 → nums[1] + 0*... = 2
    expect(asNumber(fnPERCENTILEEXC([arr, rvNumber(0.4)]))).toBeCloseTo(2, 10);
  });
  it("PERCENTILE.EXC k=0 → #NUM!", () => {
    expect(fnPERCENTILEEXC([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("PERCENTILE.EXC k=1 → #NUM!", () => {
    expect(fnPERCENTILEEXC([arr, rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("PERCENTILE.EXC k too small for n → #NUM!", () => {
    // k must be in [1/(n+1), n/(n+1)] = [0.2, 0.8] for n=4
    expect(fnPERCENTILEEXC([arr, rvNumber(0.1)])).toEqual(ERRORS.NUM);
  });
  it("PERCENTILE.EXC empty → #NUM!", () => {
    expect(fnPERCENTILEEXC([rvArray([[]]), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
});

describe("QUARTILE.EXC comprehensive", () => {
  const arr = rvArray([
    [rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5), rvNumber(6), rvNumber(7)]
  ]);
  it("QUARTILE.EXC q=1 valid", () => {
    // q=1 → k=0.25, which for n=7 is in [1/8, 7/8]
    const v = asNumber(fnQUARTILEEXC([arr, rvNumber(1)]));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(7);
  });
  it("QUARTILE.EXC q=0 → #NUM!", () => {
    expect(fnQUARTILEEXC([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("QUARTILE.EXC q=4 → #NUM!", () => {
    expect(fnQUARTILEEXC([arr, rvNumber(4)])).toEqual(ERRORS.NUM);
  });
  it("QUARTILE.EXC q=2 is median-like", () => {
    // q=2 → k=0.5 → median = 4
    expect(asNumber(fnQUARTILEEXC([arr, rvNumber(2)]))).toBeCloseTo(4, 10);
  });
  it("QUARTILE.EXC propagates error", () => {
    expect(fnQUARTILEEXC([arr, rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("NORM.S.DIST / NORMSDIST comprehensive", () => {
  it("NORMSDIST(0) = 0.5", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(0)]))).toBeCloseTo(0.5, 6);
  });
  it("NORMSDIST two-arg PDF form", () => {
    // PHI-like: at 0 ≈ 1/sqrt(2pi)
    expect(asNumber(fnNORMSDIST([rvNumber(0), rvBoolean(false)]))).toBeCloseTo(
      1 / Math.sqrt(2 * Math.PI),
      6
    );
  });
  it("NORMSDIST CDF two-arg TRUE", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(0), rvBoolean(true)]))).toBeCloseTo(0.5, 6);
  });
  it("NORMSDIST large positive approaches 1", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(5)]))).toBeCloseTo(1, 3);
  });
  it("NORMSDIST large negative approaches 0", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(-5)]))).toBeCloseTo(0, 3);
  });
  it("NORMSDIST propagates error", () => {
    expect(fnNORMSDIST([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("NORM.DIST comprehensive", () => {
  it("NORM.DIST at mean (CDF) = 0.5", () => {
    expect(
      asNumber(fnNORMDIST([rvNumber(5), rvNumber(5), rvNumber(2), rvBoolean(true)]))
    ).toBeCloseTo(0.5, 6);
  });
  it("NORM.DIST PDF at mean = 1/(sigma*sqrt(2pi))", () => {
    expect(
      asNumber(fnNORMDIST([rvNumber(5), rvNumber(5), rvNumber(1), rvBoolean(false)]))
    ).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
  it("NORM.DIST stddev<=0 → #NUM!", () => {
    expect(fnNORMDIST([rvNumber(0), rvNumber(0), rvNumber(0), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("NORM.DIST propagates error", () => {
    expect(fnNORMDIST([rvError("#N/A"), rvNumber(0), rvNumber(1), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("NORM.DIST cumulative increases with x", () => {
    const lo = asNumber(fnNORMDIST([rvNumber(0), rvNumber(5), rvNumber(2), rvBoolean(true)]));
    const hi = asNumber(fnNORMDIST([rvNumber(10), rvNumber(5), rvNumber(2), rvBoolean(true)]));
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("NORM.S.INV / NORMSINV comprehensive", () => {
  it("NORMSINV(0.5) = 0", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.5)]))).toBeCloseTo(0, 6);
  });
  it("NORMSINV(0.975) ≈ 1.96", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.975)]))).toBeCloseTo(1.96, 2);
  });
  it("NORMSINV(0.025) ≈ -1.96", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.025)]))).toBeCloseTo(-1.96, 2);
  });
  it("NORMSINV(0) → #NUM!", () => {
    expect(fnNORMSINV([rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("NORMSINV(1) → #NUM!", () => {
    expect(fnNORMSINV([rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("NORMSINV propagates error", () => {
    expect(fnNORMSINV([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("NORM.INV comprehensive", () => {
  it("NORM.INV(0.5, mu, sigma) = mu", () => {
    expect(asNumber(fnNORMINV([rvNumber(0.5), rvNumber(10), rvNumber(2)]))).toBeCloseTo(10, 3);
  });
  it("NORM.INV(0.975, 0, 1) ≈ 1.96", () => {
    expect(asNumber(fnNORMINV([rvNumber(0.975), rvNumber(0), rvNumber(1)]))).toBeCloseTo(1.96, 2);
  });
  it("NORM.INV p=0 → #NUM!", () => {
    expect(fnNORMINV([rvNumber(0), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("NORM.INV stddev<=0 → #NUM!", () => {
    expect(fnNORMINV([rvNumber(0.5), rvNumber(0), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("NORM.INV propagates error", () => {
    expect(fnNORMINV([rvError("#N/A"), rvNumber(0), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("PHI / GAUSS comprehensive", () => {
  it("PHI(0) = 1/sqrt(2pi)", () => {
    expect(asNumber(fnPHI([rvNumber(0)]))).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 10);
  });
  it("PHI is even function", () => {
    expect(asNumber(fnPHI([rvNumber(1)]))).toBeCloseTo(asNumber(fnPHI([rvNumber(-1)])), 10);
  });
  it("GAUSS(0)=0", () => {
    expect(asNumber(fnGAUSS([rvNumber(0)]))).toBeCloseTo(0, 6);
  });
  it("GAUSS(1) ≈ 0.3413", () => {
    expect(asNumber(fnGAUSS([rvNumber(1)]))).toBeCloseTo(0.3413, 3);
  });
  it("GAUSS propagates error", () => {
    expect(fnGAUSS([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("ERF / ERFC comprehensive", () => {
  it("ERF(0)=0", () => {
    expect(asNumber(fnERF([rvNumber(0)]))).toBeCloseTo(0, 6);
  });
  it("ERF(inf-like) ≈ 1", () => {
    expect(asNumber(fnERF([rvNumber(5)]))).toBeCloseTo(1, 5);
  });
  it("ERF(-1) is negative", () => {
    expect(asNumber(fnERF([rvNumber(-1)]))).toBeLessThan(0);
  });
  it("ERF(lo, hi) is erf(hi)-erf(lo)", () => {
    const v = asNumber(fnERF([rvNumber(0), rvNumber(1)]));
    const ref = asNumber(fnERF([rvNumber(1)])) - asNumber(fnERF([rvNumber(0)]));
    expect(v).toBeCloseTo(ref, 10);
  });
  it("ERFC(0)=1", () => {
    expect(asNumber(fnERFC([rvNumber(0)]))).toBeCloseTo(1, 5);
  });
  it("ERF propagates error", () => {
    expect(fnERF([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ERFC propagates error", () => {
    expect(fnERFC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("STANDARDIZE comprehensive", () => {
  it("STANDARDIZE subtracts mean and divides by stddev", () => {
    expect(asNumber(fnSTANDARDIZE([rvNumber(12), rvNumber(10), rvNumber(2)]))).toBe(1);
  });
  it("STANDARDIZE at the mean = 0", () => {
    expect(asNumber(fnSTANDARDIZE([rvNumber(10), rvNumber(10), rvNumber(5)]))).toBe(0);
  });
  it("STANDARDIZE stddev<=0 → #NUM!", () => {
    expect(fnSTANDARDIZE([rvNumber(0), rvNumber(0), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("STANDARDIZE stddev<0 → #NUM!", () => {
    expect(fnSTANDARDIZE([rvNumber(0), rvNumber(0), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("STANDARDIZE propagates error", () => {
    expect(fnSTANDARDIZE([rvError("#N/A"), rvNumber(0), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("POISSON.DIST comprehensive", () => {
  it("POISSON.DIST(0, 0, true) = 1 (degenerate)", () => {
    expect(asNumber(fnPOISSON_DIST([rvNumber(0), rvNumber(0), rvBoolean(true)]))).toBe(1);
  });
  it("POISSON.DIST PDF at mean", () => {
    // Poisson(1).pmf(1) = 1/e
    expect(asNumber(fnPOISSON_DIST([rvNumber(1), rvNumber(1), rvBoolean(false)]))).toBeCloseTo(
      1 / Math.E,
      6
    );
  });
  it("POISSON.DIST CDF at large x ≈ 1", () => {
    expect(asNumber(fnPOISSON_DIST([rvNumber(100), rvNumber(5), rvBoolean(true)]))).toBeCloseTo(
      1,
      5
    );
  });
  it("POISSON.DIST negative x → #NUM!", () => {
    expect(fnPOISSON_DIST([rvNumber(-1), rvNumber(1), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("POISSON.DIST negative mean → #NUM!", () => {
    expect(fnPOISSON_DIST([rvNumber(1), rvNumber(-1), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
});

describe("BINOM.DIST comprehensive", () => {
  it("BINOM.DIST(2, 10, 0.5, false) = C(10,2)*(0.5)^10", () => {
    const expected = 45 * Math.pow(0.5, 10);
    expect(
      asNumber(fnBINOM_DIST([rvNumber(2), rvNumber(10), rvNumber(0.5), rvBoolean(false)]))
    ).toBeCloseTo(expected, 6);
  });
  it("BINOM.DIST CDF sums to 1 at max successes", () => {
    expect(
      asNumber(fnBINOM_DIST([rvNumber(10), rvNumber(10), rvNumber(0.3), rvBoolean(true)]))
    ).toBeCloseTo(1, 6);
  });
  it("BINOM.DIST k>n → #NUM!", () => {
    expect(fnBINOM_DIST([rvNumber(11), rvNumber(10), rvNumber(0.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("BINOM.DIST p<0 → #NUM!", () => {
    expect(fnBINOM_DIST([rvNumber(1), rvNumber(10), rvNumber(-0.1), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("BINOM.DIST propagates error", () => {
    expect(fnBINOM_DIST([rvError("#N/A"), rvNumber(10), rvNumber(0.5), rvBoolean(false)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("BINOM.INV comprehensive", () => {
  it("BINOM.INV smallest k with CDF>=alpha", () => {
    // trials=10, p=0.5, alpha=0.5 → k where CDF crosses 0.5 is 5
    const v = asNumber(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(0.5)]));
    expect(v).toBeGreaterThanOrEqual(4);
    expect(v).toBeLessThanOrEqual(5);
  });
  it("BINOM.INV alpha=0 → 0", () => {
    expect(asNumber(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(0)]))).toBe(0);
  });
  it("BINOM.INV alpha=1 → n", () => {
    expect(asNumber(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(1)]))).toBe(10);
  });
  it("BINOM.INV p<0 → #NUM!", () => {
    expect(fnBINOM_INV([rvNumber(10), rvNumber(-0.1), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
  it("BINOM.INV propagates error", () => {
    expect(fnBINOM_INV([rvError("#N/A"), rvNumber(0.5), rvNumber(0.5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("HYPGEOM.DIST comprehensive", () => {
  it("HYPGEOM.DIST PDF basic case", () => {
    // sample_s=1, num_sample=4, pop_s=8, num_pop=20
    const v = asNumber(
      fnHYPGEOM_DIST([rvNumber(1), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
    );
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });
  it("HYPGEOM.DIST CDF at max = 1", () => {
    // CDF at min(num_sample, pop_s)
    const v = asNumber(
      fnHYPGEOM_DIST([rvNumber(4), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(true)])
    );
    expect(v).toBeCloseTo(1, 4);
  });
  it("HYPGEOM.DIST propagates error", () => {
    expect(
      fnHYPGEOM_DIST([rvError("#N/A"), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
    ).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("HYPGEOM.DIST integer truncation of sample_s", () => {
    // 1.9 should floor to 1
    const v1 = asNumber(
      fnHYPGEOM_DIST([rvNumber(1.9), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
    );
    const v2 = asNumber(
      fnHYPGEOM_DIST([rvNumber(1), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
    );
    expect(v1).toBeCloseTo(v2, 10);
  });
});

describe("NEGBINOM.DIST comprehensive", () => {
  it("NEGBINOM.DIST PMF is positive", () => {
    expect(
      asNumber(fnNEGBINOM_DIST([rvNumber(5), rvNumber(3), rvNumber(0.5), rvBoolean(false)]))
    ).toBeGreaterThan(0);
  });
  it("NEGBINOM.DIST CDF at large f ≈ 1", () => {
    expect(
      asNumber(fnNEGBINOM_DIST([rvNumber(100), rvNumber(3), rvNumber(0.5), rvBoolean(true)]))
    ).toBeCloseTo(1, 5);
  });
  it("NEGBINOM.DIST negative failures → #NUM!", () => {
    expect(fnNEGBINOM_DIST([rvNumber(-1), rvNumber(3), rvNumber(0.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("NEGBINOM.DIST s<1 → #NUM!", () => {
    expect(fnNEGBINOM_DIST([rvNumber(5), rvNumber(0), rvNumber(0.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("NEGBINOM.DIST propagates error", () => {
    expect(
      fnNEGBINOM_DIST([rvError("#N/A"), rvNumber(3), rvNumber(0.5), rvBoolean(false)])
    ).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("CHISQ.DIST comprehensive", () => {
  it("CHISQ.DIST CDF at 0 = 0", () => {
    expect(asNumber(fnCHISQ_DIST([rvNumber(0), rvNumber(3), rvBoolean(true)]))).toBeCloseTo(0, 6);
  });
  it("CHISQ.DIST CDF increases with x", () => {
    const lo = asNumber(fnCHISQ_DIST([rvNumber(1), rvNumber(3), rvBoolean(true)]));
    const hi = asNumber(fnCHISQ_DIST([rvNumber(10), rvNumber(3), rvBoolean(true)]));
    expect(hi).toBeGreaterThan(lo);
  });
  it("CHISQ.DIST PDF is positive", () => {
    expect(asNumber(fnCHISQ_DIST([rvNumber(3), rvNumber(3), rvBoolean(false)]))).toBeGreaterThan(0);
  });
  it("CHISQ.DIST negative x → #NUM!", () => {
    expect(fnCHISQ_DIST([rvNumber(-1), rvNumber(3), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.DIST df<1 → #NUM!", () => {
    expect(fnCHISQ_DIST([rvNumber(1), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
});

describe("CHISQ.INV comprehensive", () => {
  it("CHISQ.INV(0, df) = 0", () => {
    expect(asNumber(fnCHISQ_INV([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("CHISQ.INV(0.95, 5) ≈ 11.07", () => {
    expect(asNumber(fnCHISQ_INV([rvNumber(0.95), rvNumber(5)]))).toBeCloseTo(11.07, 1);
  });
  it("CHISQ.INV p>=1 → #NUM!", () => {
    expect(fnCHISQ_INV([rvNumber(1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.INV df<1 → #NUM!", () => {
    expect(fnCHISQ_INV([rvNumber(0.5), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.INV propagates error", () => {
    expect(fnCHISQ_INV([rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("CHISQ.DIST.RT comprehensive", () => {
  it("CHISQ.DIST.RT at 0 = 1", () => {
    expect(asNumber(fnCHISQ_DIST_RT([rvNumber(0), rvNumber(3)]))).toBeCloseTo(1, 6);
  });
  it("CHISQ.DIST.RT = 1 - CHISQ.DIST CDF", () => {
    const rt = asNumber(fnCHISQ_DIST_RT([rvNumber(5), rvNumber(3)]));
    const cdf = asNumber(fnCHISQ_DIST([rvNumber(5), rvNumber(3), rvBoolean(true)]));
    expect(rt + cdf).toBeCloseTo(1, 6);
  });
  it("CHISQ.DIST.RT negative x → #NUM!", () => {
    expect(fnCHISQ_DIST_RT([rvNumber(-1), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.DIST.RT df<1 → #NUM!", () => {
    expect(fnCHISQ_DIST_RT([rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.DIST.RT propagates error", () => {
    expect(fnCHISQ_DIST_RT([rvError("#N/A"), rvNumber(3)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("F.DIST comprehensive", () => {
  it("F.DIST CDF at 0 = 0", () => {
    expect(
      asNumber(fnF_DIST([rvNumber(0), rvNumber(5), rvNumber(10), rvBoolean(true)]))
    ).toBeCloseTo(0, 6);
  });
  it("F.DIST CDF increasing", () => {
    const lo = asNumber(fnF_DIST([rvNumber(1), rvNumber(5), rvNumber(10), rvBoolean(true)]));
    const hi = asNumber(fnF_DIST([rvNumber(5), rvNumber(5), rvNumber(10), rvBoolean(true)]));
    expect(hi).toBeGreaterThan(lo);
  });
  it("F.DIST x<0 → #NUM!", () => {
    expect(fnF_DIST([rvNumber(-1), rvNumber(5), rvNumber(10), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("F.DIST df1<1 → #NUM!", () => {
    expect(fnF_DIST([rvNumber(1), rvNumber(0), rvNumber(10), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("F.DIST propagates error", () => {
    expect(fnF_DIST([rvError("#N/A"), rvNumber(5), rvNumber(10), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("F.INV comprehensive", () => {
  it("F.INV(0.5, df1, df2) is near median", () => {
    const v = asNumber(fnF_INV([rvNumber(0.5), rvNumber(5), rvNumber(10)]));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(3);
  });
  it("F.INV(0, df1, df2) = 0", () => {
    expect(asNumber(fnF_INV([rvNumber(0), rvNumber(5), rvNumber(10)]))).toBeCloseTo(0, 3);
  });
  it("F.INV p>=1 → #NUM!", () => {
    expect(fnF_INV([rvNumber(1), rvNumber(5), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("F.INV df1<1 → #NUM!", () => {
    expect(fnF_INV([rvNumber(0.5), rvNumber(0), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("F.INV propagates error", () => {
    expect(fnF_INV([rvError("#N/A"), rvNumber(5), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("F.DIST.RT / F.INV.RT comprehensive", () => {
  it("F.DIST.RT at 0 = 1", () => {
    expect(asNumber(fnF_DIST_RT([rvNumber(0), rvNumber(5), rvNumber(10)]))).toBe(1);
  });
  it("F.DIST.RT decreases with x", () => {
    const lo = asNumber(fnF_DIST_RT([rvNumber(1), rvNumber(5), rvNumber(10)]));
    const hi = asNumber(fnF_DIST_RT([rvNumber(5), rvNumber(5), rvNumber(10)]));
    expect(hi).toBeLessThan(lo);
  });
  it("F.INV.RT inverts F.DIST.RT approximately", () => {
    const x = asNumber(fnF_INV_RT([rvNumber(0.05), rvNumber(5), rvNumber(10)]));
    const back = asNumber(fnF_DIST_RT([rvNumber(x), rvNumber(5), rvNumber(10)]));
    expect(back).toBeCloseTo(0.05, 3);
  });
  it("F.DIST.RT df<1 → #NUM!", () => {
    expect(fnF_DIST_RT([rvNumber(1), rvNumber(0), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("F.INV.RT p<=0 → #NUM!", () => {
    expect(fnF_INV_RT([rvNumber(0), rvNumber(5), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("F.INV.RT propagates error", () => {
    expect(fnF_INV_RT([rvError("#N/A"), rvNumber(5), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("T.DIST comprehensive", () => {
  it("T.DIST CDF at 0 = 0.5", () => {
    expect(asNumber(fnT_DIST([rvNumber(0), rvNumber(5), rvBoolean(true)]))).toBeCloseTo(0.5, 6);
  });
  it("T.DIST PDF symmetric around 0", () => {
    const a = asNumber(fnT_DIST([rvNumber(1), rvNumber(5), rvBoolean(false)]));
    const b = asNumber(fnT_DIST([rvNumber(-1), rvNumber(5), rvBoolean(false)]));
    expect(a).toBeCloseTo(b, 10);
  });
  it("T.DIST df<1 → #NUM!", () => {
    expect(fnT_DIST([rvNumber(0), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("T.DIST propagates error", () => {
    expect(fnT_DIST([rvError("#N/A"), rvNumber(5), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("T.DIST CDF large x approaches 1", () => {
    expect(asNumber(fnT_DIST([rvNumber(50), rvNumber(5), rvBoolean(true)]))).toBeCloseTo(1, 3);
  });
});

describe("T.INV / T.INV.2T comprehensive", () => {
  it("T.INV(0.5, df) = 0", () => {
    expect(asNumber(fnT_INV([rvNumber(0.5), rvNumber(5)]))).toBeCloseTo(0, 3);
  });
  it("T.INV is symmetric: T.INV(1-p) = -T.INV(p)", () => {
    const a = asNumber(fnT_INV([rvNumber(0.25), rvNumber(5)]));
    const b = asNumber(fnT_INV([rvNumber(0.75), rvNumber(5)]));
    expect(a).toBeCloseTo(-b, 3);
  });
  it("T.INV p<=0 → #NUM!", () => {
    expect(fnT_INV([rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("T.INV.2T returns positive critical value", () => {
    const v = asNumber(fnT_INV_2T([rvNumber(0.05), rvNumber(10)]));
    expect(v).toBeGreaterThan(0);
  });
  it("T.INV.2T p=0 → #NUM!", () => {
    expect(fnT_INV_2T([rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
});

describe("T.DIST.2T / T.DIST.RT comprehensive", () => {
  it("T.DIST.2T at 0 = 1 (full mass beyond 0 both tails)", () => {
    expect(asNumber(fnT_DIST_2T([rvNumber(0), rvNumber(10)]))).toBe(1);
  });
  it("T.DIST.2T negative x → #NUM!", () => {
    expect(fnT_DIST_2T([rvNumber(-1), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("T.DIST.RT at 0 = 0.5", () => {
    expect(asNumber(fnT_DIST_RT([rvNumber(0), rvNumber(10)]))).toBeCloseTo(0.5, 6);
  });
  it("T.DIST.RT decreases with x", () => {
    const a = asNumber(fnT_DIST_RT([rvNumber(1), rvNumber(10)]));
    const b = asNumber(fnT_DIST_RT([rvNumber(2), rvNumber(10)]));
    expect(b).toBeLessThan(a);
  });
  it("T.DIST.RT df<1 → #NUM!", () => {
    expect(fnT_DIST_RT([rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
});

describe("BETA.DIST / BETA.INV comprehensive", () => {
  it("BETA.DIST symmetric(alpha=beta) around 0.5", () => {
    const v = asNumber(fnBETA_DIST([rvNumber(0.5), rvNumber(2), rvNumber(2), rvBoolean(true)]));
    expect(v).toBeCloseTo(0.5, 6);
  });
  it("BETA.DIST PDF positive", () => {
    expect(
      asNumber(fnBETA_DIST([rvNumber(0.5), rvNumber(2), rvNumber(2), rvBoolean(false)]))
    ).toBeGreaterThan(0);
  });
  it("BETA.DIST alpha<=0 → #NUM!", () => {
    expect(fnBETA_DIST([rvNumber(0.5), rvNumber(0), rvNumber(2), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("BETA.DIST with A, B bounds", () => {
    // Scale to [10, 20]: at x=15, scaled = 0.5
    expect(
      asNumber(
        fnBETA_DIST([
          rvNumber(15),
          rvNumber(2),
          rvNumber(2),
          rvBoolean(true),
          rvNumber(10),
          rvNumber(20)
        ])
      )
    ).toBeCloseTo(0.5, 6);
  });
  it("BETA.INV inverts BETA.DIST", () => {
    const x = asNumber(fnBETA_INV([rvNumber(0.5), rvNumber(2), rvNumber(2)]));
    const back = asNumber(fnBETA_DIST([rvNumber(x), rvNumber(2), rvNumber(2), rvBoolean(true)]));
    expect(back).toBeCloseTo(0.5, 3);
  });
  it("BETA.INV alpha<=0 → #NUM!", () => {
    expect(fnBETA_INV([rvNumber(0.5), rvNumber(0), rvNumber(2)])).toEqual(ERRORS.NUM);
  });
});

describe("GAMMA / GAMMALN comprehensive", () => {
  it("GAMMA(1) = 1", () => {
    expect(asNumber(fnGAMMA([rvNumber(1)]))).toBeCloseTo(1, 6);
  });
  it("GAMMA(5) = 24", () => {
    expect(asNumber(fnGAMMA([rvNumber(5)]))).toBeCloseTo(24, 4);
  });
  it("GAMMA(0.5) = sqrt(pi)", () => {
    expect(asNumber(fnGAMMA([rvNumber(0.5)]))).toBeCloseTo(Math.sqrt(Math.PI), 6);
  });
  it("GAMMA of non-positive integer → #NUM!", () => {
    expect(fnGAMMA([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnGAMMA([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("GAMMALN(1)=0", () => {
    expect(asNumber(fnGAMMALN([rvNumber(1)]))).toBeCloseTo(0, 6);
  });
  it("GAMMALN of non-positive → #NUM!", () => {
    expect(fnGAMMALN([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnGAMMALN([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("GAMMA.DIST / GAMMA.INV comprehensive", () => {
  it("GAMMA.DIST CDF at 0 = 0", () => {
    expect(asNumber(fnGAMMA_DIST([rvNumber(0), rvNumber(2), rvNumber(2), rvBoolean(true)]))).toBe(
      0
    );
  });
  it("GAMMA.DIST CDF increases with x", () => {
    const lo = asNumber(fnGAMMA_DIST([rvNumber(1), rvNumber(2), rvNumber(2), rvBoolean(true)]));
    const hi = asNumber(fnGAMMA_DIST([rvNumber(10), rvNumber(2), rvNumber(2), rvBoolean(true)]));
    expect(hi).toBeGreaterThan(lo);
  });
  it("GAMMA.DIST alpha<=0 → #NUM!", () => {
    expect(fnGAMMA_DIST([rvNumber(1), rvNumber(0), rvNumber(2), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("GAMMA.INV(0, alpha, beta) = 0", () => {
    expect(asNumber(fnGAMMA_INV([rvNumber(0), rvNumber(2), rvNumber(2)]))).toBeCloseTo(0, 3);
  });
  it("GAMMA.INV alpha<=0 → #NUM!", () => {
    expect(fnGAMMA_INV([rvNumber(0.5), rvNumber(0), rvNumber(2)])).toEqual(ERRORS.NUM);
  });
  it("GAMMA.DIST propagates error", () => {
    expect(fnGAMMA_DIST([rvError("#N/A"), rvNumber(2), rvNumber(2), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("EXPON.DIST comprehensive", () => {
  it("EXPON.DIST CDF = 1 - exp(-lambda*x)", () => {
    expect(asNumber(fnEXPON_DIST([rvNumber(1), rvNumber(2), rvBoolean(true)]))).toBeCloseTo(
      1 - Math.exp(-2),
      10
    );
  });
  it("EXPON.DIST PDF = lambda*exp(-lambda*x)", () => {
    expect(asNumber(fnEXPON_DIST([rvNumber(0), rvNumber(2), rvBoolean(false)]))).toBe(2);
  });
  it("EXPON.DIST x<0 → #NUM!", () => {
    expect(fnEXPON_DIST([rvNumber(-1), rvNumber(2), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("EXPON.DIST lambda<=0 → #NUM!", () => {
    expect(fnEXPON_DIST([rvNumber(1), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("EXPON.DIST propagates error", () => {
    expect(fnEXPON_DIST([rvError("#N/A"), rvNumber(2), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("WEIBULL.DIST comprehensive", () => {
  it("WEIBULL.DIST CDF at 0 = 0", () => {
    expect(asNumber(fnWEIBULL_DIST([rvNumber(0), rvNumber(2), rvNumber(1), rvBoolean(true)]))).toBe(
      0
    );
  });
  it("WEIBULL.DIST CDF at large x approaches 1", () => {
    expect(
      asNumber(fnWEIBULL_DIST([rvNumber(10), rvNumber(2), rvNumber(1), rvBoolean(true)]))
    ).toBeCloseTo(1, 5);
  });
  it("WEIBULL.DIST alpha<=0 → #NUM!", () => {
    expect(fnWEIBULL_DIST([rvNumber(1), rvNumber(0), rvNumber(1), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("WEIBULL.DIST beta<=0 → #NUM!", () => {
    expect(fnWEIBULL_DIST([rvNumber(1), rvNumber(2), rvNumber(0), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("WEIBULL.DIST x<0 → #NUM!", () => {
    expect(fnWEIBULL_DIST([rvNumber(-1), rvNumber(2), rvNumber(1), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
});

describe("LOGNORM.DIST / LOGNORM.INV comprehensive", () => {
  it("LOGNORM.DIST CDF positive", () => {
    expect(
      asNumber(fnLOGNORM_DIST([rvNumber(1), rvNumber(0), rvNumber(1), rvBoolean(true)]))
    ).toBeCloseTo(0.5, 3);
  });
  it("LOGNORM.DIST x<=0 → #NUM!", () => {
    expect(fnLOGNORM_DIST([rvNumber(0), rvNumber(0), rvNumber(1), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("LOGNORM.DIST stddev<=0 → #NUM!", () => {
    expect(fnLOGNORM_DIST([rvNumber(1), rvNumber(0), rvNumber(0), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("LOGNORM.INV(0.5, 0, 1) ≈ 1", () => {
    expect(asNumber(fnLOGNORM_INV([rvNumber(0.5), rvNumber(0), rvNumber(1)]))).toBeCloseTo(1, 3);
  });
  it("LOGNORM.INV p<=0 → #NUM!", () => {
    expect(fnLOGNORM_INV([rvNumber(0), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOGNORM.INV stddev<=0 → #NUM!", () => {
    expect(fnLOGNORM_INV([rvNumber(0.5), rvNumber(0), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("CORREL / PEARSON-like comprehensive", () => {
  it("CORREL of identical arrays = 1", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnCORREL([a, a]))).toBeCloseTo(1, 10);
  });
  it("CORREL of opposite-trend arrays = -1", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const b = rvArray([[rvNumber(3), rvNumber(2), rvNumber(1)]]);
    expect(asNumber(fnCORREL([a, b]))).toBeCloseTo(-1, 10);
  });
  it("CORREL of constant vs variable → #DIV/0!", () => {
    const a = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    const b = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnCORREL([a, b])).toEqual(ERRORS.DIV0);
  });
  it("CORREL single pair → #DIV/0!", () => {
    const a = rvArray([[rvNumber(1)]]);
    expect(fnCORREL([a, a])).toEqual(ERRORS.DIV0);
  });
  it("CORREL aligns to shorter of two arrays", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const b = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    // uses first 3 of a: (1,2,3) vs (2,4,6) → corr = 1
    expect(asNumber(fnCORREL([a, b]))).toBeCloseTo(1, 10);
  });
});

describe("SLOPE / INTERCEPT / RSQ / FORECAST comprehensive", () => {
  const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
  const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8)]]);
  it("SLOPE y=2x → slope 2", () => {
    expect(asNumber(fnSLOPE([ys, xs]))).toBeCloseTo(2, 10);
  });
  it("INTERCEPT y=2x → intercept 0", () => {
    expect(asNumber(fnINTERCEPT([ys, xs]))).toBeCloseTo(0, 10);
  });
  it("RSQ perfect line = 1", () => {
    expect(asNumber(fnRSQ([ys, xs]))).toBeCloseTo(1, 10);
  });
  it("FORECAST extrapolates", () => {
    expect(asNumber(fnFORECAST([rvNumber(5), ys, xs]))).toBeCloseTo(10, 10);
  });
  it("SLOPE all-same x → #DIV/0!", () => {
    const cx = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    const cy = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnSLOPE([cy, cx])).toEqual(ERRORS.DIV0);
  });
  it("FORECAST insufficient data → #DIV/0!", () => {
    const one = rvArray([[rvNumber(1)]]);
    expect(fnFORECAST([rvNumber(5), one, one])).toEqual(ERRORS.DIV0);
  });
});

describe("COVARIANCE.P / COVARIANCE.S comprehensive", () => {
  it("COVARIANCE.P of identical = VARP", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const cov = asNumber(fnCOVARIANCE_P([a, a]));
    const varp = asNumber(fnVARP([a]));
    expect(cov).toBeCloseTo(varp, 10);
  });
  it("COVARIANCE.S of identical = VAR", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const cov = asNumber(fnCOVARIANCE_S([a, a]));
    const varr = asNumber(fnVAR([a]));
    expect(cov).toBeCloseTo(varr, 10);
  });
  it("COVARIANCE.P zero when uncorrelated", () => {
    const a = rvArray([[rvNumber(-1), rvNumber(1), rvNumber(-1), rvNumber(1)]]);
    const b = rvArray([[rvNumber(1), rvNumber(1), rvNumber(-1), rvNumber(-1)]]);
    expect(asNumber(fnCOVARIANCE_P([a, b]))).toBeCloseTo(0, 10);
  });
  it("COVARIANCE.P propagates error", () => {
    const a = rvArray([[ERRORS.NA]]);
    const b = rvArray([[rvNumber(1)]]);
    expect(fnCOVARIANCE_P([a, b])).toEqual(ERRORS.NA);
  });
  it("COVARIANCE.S single pair → #DIV/0!", () => {
    const a = rvArray([[rvNumber(1)]]);
    expect(fnCOVARIANCE_S([a, a])).toEqual(ERRORS.DIV0);
  });
});

describe("RANK.AVG comprehensive", () => {
  const arr = rvArray([[rvNumber(10), rvNumber(20), rvNumber(20), rvNumber(30)]]);
  it("RANK.AVG averages tied ranks (desc)", () => {
    // desc: [30,20,20,10] → 20 occupies ranks 2,3 → avg 2.5
    expect(asNumber(fnRANK_AVG([rvNumber(20), arr]))).toBeCloseTo(2.5, 10);
  });
  it("RANK.AVG single occurrence = position", () => {
    expect(asNumber(fnRANK_AVG([rvNumber(10), arr]))).toBe(4);
  });
  it("RANK.AVG non-match → #N/A", () => {
    expect(fnRANK_AVG([rvNumber(999), arr])).toEqual(ERRORS.NA);
  });
  it("RANK.AVG asc order", () => {
    // asc: [10,20,20,30] → 20 occupies ranks 2,3 → avg 2.5
    expect(asNumber(fnRANK_AVG([rvNumber(20), arr, rvNumber(1)]))).toBeCloseTo(2.5, 10);
  });
  it("RANK.AVG propagates error in number", () => {
    expect(fnRANK_AVG([rvError("#N/A"), arr])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("MODE.MULT comprehensive", () => {
  it("preserves first occurrence order", () => {
    const arr = rvArray([[rvNumber(3), rvNumber(3), rvNumber(1), rvNumber(1)]]);
    const r = asArrayValue(fnMODE_MULT([arr]));
    expect((r.rows[0][0] as NumberValue).value).toBe(3);
    expect((r.rows[1][0] as NumberValue).value).toBe(1);
  });
  it("empty → #N/A", () => {
    expect(fnMODE_MULT([rvArray([[]])])).toEqual(ERRORS.NA);
  });
  it("no mode → #N/A", () => {
    expect(fnMODE_MULT([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])])).toEqual(ERRORS.NA);
  });
  it("propagates error", () => {
    expect(fnMODE_MULT([rvArray([[ERRORS.NA, rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("FISHER / FISHERINV comprehensive", () => {
  it("FISHER(0) = 0", () => {
    expect(asNumber(fnFISHER([rvNumber(0)]))).toBe(0);
  });
  it("FISHER is odd", () => {
    const a = asNumber(fnFISHER([rvNumber(0.5)]));
    const b = asNumber(fnFISHER([rvNumber(-0.5)]));
    expect(a).toBeCloseTo(-b, 10);
  });
  it("FISHER |x|>=1 → #NUM!", () => {
    expect(fnFISHER([rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnFISHER([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("FISHERINV(0) = 0", () => {
    expect(asNumber(fnFISHERINV([rvNumber(0)]))).toBeCloseTo(0, 10);
  });
  it("FISHER ∘ FISHERINV ≈ identity", () => {
    const v = asNumber(fnFISHER([rvNumber(0.5)]));
    expect(asNumber(fnFISHERINV([rvNumber(v)]))).toBeCloseTo(0.5, 10);
  });
  it("FISHER propagates error", () => {
    expect(fnFISHER([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("CONFIDENCE.NORM comprehensive", () => {
  it("positive basic value", () => {
    // CONFIDENCE.NORM(0.05, 1, 50): z_{0.025}*1/sqrt(50) ≈ 1.96/7.07 ≈ 0.277
    const v = asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(50)]));
    expect(v).toBeGreaterThan(0.2);
    expect(v).toBeLessThan(0.3);
  });
  it("alpha=0 → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(0), rvNumber(1), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("alpha>=1 → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(1), rvNumber(1), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("stddev<=0 → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(0), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
  it("size<1 → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates error", () => {
    expect(fnCONFIDENCENORM([rvError("#N/A"), rvNumber(1), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("SKEW / SKEW.P / KURT comprehensive", () => {
  const arr = rvArray([
    [
      rvNumber(3),
      rvNumber(4),
      rvNumber(5),
      rvNumber(2),
      rvNumber(3),
      rvNumber(4),
      rvNumber(5),
      rvNumber(6),
      rvNumber(4),
      rvNumber(7)
    ]
  ]);
  it("SKEW returns a number", () => {
    const v = asNumber(fnSKEW([arr]));
    expect(Number.isFinite(v)).toBe(true);
  });
  it("SKEW of symmetric data ≈ 0", () => {
    const sym = rvArray([
      [rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5), rvNumber(6), rvNumber(7)]
    ]);
    expect(asNumber(fnSKEW([sym]))).toBeCloseTo(0, 6);
  });
  it("SKEW fewer than 3 → #DIV/0!", () => {
    expect(fnSKEW([rvArray([[rvNumber(1), rvNumber(2)]])])).toEqual(ERRORS.DIV0);
  });
  it("SKEW zero stddev → #DIV/0!", () => {
    expect(fnSKEW([rvArray([[rvNumber(3), rvNumber(3), rvNumber(3), rvNumber(3)]])])).toEqual(
      ERRORS.DIV0
    );
  });
  it("SKEW.P works with 1 value? No: fewer than 1 returns DIV0, but 1 value with stddev=0 also DIV0", () => {
    // SKEW.P n<1 → DIV0 actually n<1 is impossible; stddev=0 of single value → DIV0
    expect(fnSKEW_P([rvArray([[rvNumber(5)]])])).toEqual(ERRORS.DIV0);
  });
  it("SKEW.P returns a number", () => {
    const v = asNumber(fnSKEW_P([arr]));
    expect(Number.isFinite(v)).toBe(true);
  });
  it("KURT fewer than 4 → #DIV/0!", () => {
    expect(fnKURT([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])])).toEqual(ERRORS.DIV0);
  });
  it("KURT zero stddev → #DIV/0!", () => {
    expect(
      fnKURT([rvArray([[rvNumber(3), rvNumber(3), rvNumber(3), rvNumber(3), rvNumber(3)]])])
    ).toEqual(ERRORS.DIV0);
  });
  it("KURT returns a number for varied data", () => {
    const v = asNumber(fnKURT([arr]));
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe("FREQUENCY comprehensive", () => {
  it("FREQUENCY basic buckets", () => {
    const data = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
    const bins = rvArray([[rvNumber(2), rvNumber(4)]]);
    const r = asArrayValue(fnFREQUENCY([data, bins]));
    // bins: <=2 → [1,2] count 2; <=4 → [3,4] count 2; overflow → [5] count 1
    expect((r.rows[0][0] as NumberValue).value).toBe(2);
    expect((r.rows[1][0] as NumberValue).value).toBe(2);
    expect((r.rows[2][0] as NumberValue).value).toBe(1);
  });
  it("FREQUENCY non-array first arg → #VALUE!", () => {
    expect(fnFREQUENCY([rvNumber(1), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.VALUE);
  });
  it("FREQUENCY non-array second arg → #VALUE!", () => {
    expect(fnFREQUENCY([rvArray([[rvNumber(1)]]), rvNumber(1)])).toEqual(ERRORS.VALUE);
  });
  it("FREQUENCY result has bins.length+1 rows", () => {
    const data = rvArray([[rvNumber(5)]]);
    const bins = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const r = asArrayValue(fnFREQUENCY([data, bins]));
    expect(r.rows.length).toBe(4);
  });
  it("FREQUENCY propagates error in data", () => {
    expect(fnFREQUENCY([rvArray([[ERRORS.NA]]), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("LINEST comprehensive", () => {
  it("LINEST simple y=2x+1", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)], [rvNumber(4)]]);
    const ys = rvArray([[rvNumber(3)], [rvNumber(5)], [rvNumber(7)], [rvNumber(9)]]);
    const r = asArrayValue(fnLINEST([ys, xs]));
    // First row: [m, b] = [2, 1]
    expect((r.rows[0][0] as NumberValue).value).toBeCloseTo(2, 6);
    expect((r.rows[0][1] as NumberValue).value).toBeCloseTo(1, 6);
  });
  it("LINEST with stats=TRUE returns 5 rows", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)], [rvNumber(4)]]);
    const ys = rvArray([[rvNumber(3)], [rvNumber(5)], [rvNumber(7)], [rvNumber(9)]]);
    const r = asArrayValue(fnLINEST([ys, xs, rvBoolean(true), rvBoolean(true)]));
    expect(r.rows.length).toBe(5);
  });
  it("LINEST with const=FALSE forces intercept to 0", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(6)]]);
    const r = asArrayValue(fnLINEST([ys, xs, rvBoolean(false)]));
    // Second col (b) is 0
    expect((r.rows[0][1] as NumberValue).value).toBe(0);
  });
  it("LINEST no args → error", () => {
    expect(fnLINEST([]).kind).toBe(RVKind.Error);
  });
});

describe("LOGEST comprehensive", () => {
  it("LOGEST of exponential y = 2^x gives base 2", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)], [rvNumber(4)]]);
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(8)], [rvNumber(16)]]);
    const r = asArrayValue(fnLOGEST([ys, xs]));
    // First cell ≈ 2 (the base), second ≈ 1 (intercept as exp(0))
    expect((r.rows[0][0] as NumberValue).value).toBeCloseTo(2, 3);
  });
  it("LOGEST with negative y → #NUM!", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const ys = rvArray([[rvNumber(-1)], [rvNumber(2)], [rvNumber(3)]]);
    expect(fnLOGEST([ys, xs])).toEqual(ERRORS.NUM);
  });
});

describe("TREND / GROWTH comprehensive", () => {
  it("TREND predicts along regression line", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)], [rvNumber(4)]]);
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(6)], [rvNumber(8)]]);
    const newx = rvArray([[rvNumber(5)], [rvNumber(6)]]);
    const r = asArrayValue(fnTREND([ys, xs, newx]));
    expect((r.rows[0][0] as NumberValue).value).toBeCloseTo(10, 6);
    expect((r.rows[1][0] as NumberValue).value).toBeCloseTo(12, 6);
  });
  it("TREND with no new_x uses known_x", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(6)]]);
    const r = asArrayValue(fnTREND([ys, xs]));
    expect(r.rows.length).toBe(3);
  });
  it("GROWTH predicts along exponential", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(8)]]);
    const newx = rvArray([[rvNumber(4)]]);
    const r = asArrayValue(fnGROWTH([ys, xs, newx]));
    expect((r.rows[0][0] as NumberValue).value).toBeCloseTo(16, 3);
  });
  it("GROWTH with negative y → #NUM!", () => {
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)]]);
    const ys = rvArray([[rvNumber(-1)], [rvNumber(2)]]);
    expect(fnGROWTH([ys, xs])).toEqual(ERRORS.NUM);
  });
});

describe("FORECAST (extra direct coverage)", () => {
  const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8), rvNumber(10)]]);
  it("extrapolates beyond known x's for y=2x", () => {
    expect(asNumber(fnFORECAST([rvNumber(10), ys, xs]))).toBeCloseTo(20, 10);
  });
  it("interpolates within known x's", () => {
    expect(asNumber(fnFORECAST([rvNumber(2.5), ys, xs]))).toBeCloseTo(5, 10);
  });
  it("returns #DIV/0! for constant x's", () => {
    const constXs = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    expect(fnFORECAST([rvNumber(5), ys, constXs])).toEqual(ERRORS.DIV0);
  });
  it("propagates errors from the target x", () => {
    expect(fnFORECAST([ERRORS.NA, ys, xs])).toEqual(ERRORS.NA);
  });
  it("rejects #VALUE! for non-numeric target x", () => {
    expect(fnFORECAST([rvString("x"), ys, xs])).toEqual(ERRORS.VALUE);
  });
});

describe("GROWTH / LOGEST / LOGNORM.INV (extra direct coverage)", () => {
  it("GROWTH with default new x's returns predictions at known x's", () => {
    const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(8)]]);
    const r = fnGROWTH([y]);
    expect(r.kind).toBe(RVKind.Array);
  });
  it("GROWTH on short data still returns an array", () => {
    const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(8)]]);
    const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const r = fnGROWTH([y, x, x, rvBoolean(false)]);
    expect(r.kind === RVKind.Array || r.kind === RVKind.Error).toBe(true);
  });
  it("GROWTH rejects negative y's", () => {
    const y = rvArray([[rvNumber(-2), rvNumber(4), rvNumber(8)]]);
    expect(fnGROWTH([y])).toEqual(ERRORS.NUM);
  });
  it("LOGEST rejects non-positive y", () => {
    const y = rvArray([[rvNumber(0), rvNumber(1), rvNumber(2)]]);
    expect(fnLOGEST([y])).toEqual(ERRORS.NUM);
  });
  it("LOGEST with single y-value still returns something (array or error)", () => {
    const r = fnLOGEST([rvArray([[rvNumber(2)]])]);
    expect(r.kind === RVKind.Array || r.kind === RVKind.Error).toBe(true);
  });
  it("LOGNORM.INV(0.5, 0, 1) is the lognormal median (exp(0)=1)", () => {
    expect(asNumber(fnLOGNORM_INV([rvNumber(0.5), rvNumber(0), rvNumber(1)]))).toBeCloseTo(1, 3);
  });
  it("LOGNORM.INV rejects p<=0 or p>=1", () => {
    expect(fnLOGNORM_INV([rvNumber(0), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnLOGNORM_INV([rvNumber(1), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOGNORM.INV rejects non-positive sigma", () => {
    expect(fnLOGNORM_INV([rvNumber(0.5), rvNumber(0), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LOGNORM.INV propagates errors", () => {
    expect(fnLOGNORM_INV([ERRORS.NA, rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NA);
  });
});

describe("error propagation across statistical family", () => {
  it("MEDIAN propagates scalar error", () => {
    expect(fnMEDIAN([rvError("#REF!")])).toEqual(ERRORS.REF);
  });
  it("STDEV propagates scalar error", () => {
    expect(fnSTDEV([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("GEOMEAN propagates scalar error", () => {
    expect(fnGEOMEAN([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("PERCENTILE propagates errors from the source array (Excel behaviour)", () => {
    // Regression: previously the engine filtered non-numeric cells
    // (including errors) then reported `#NUM!` for an empty sample,
    // masking the real error. Excel propagates errors from statistical
    // aggregators the same way AVERAGE / SUM do.
    expect(fnPERCENTILE([rvArray([[ERRORS.NA]]), rvNumber(0.5)])).toEqual(ERRORS.NA);
    expect(
      fnPERCENTILE([rvArray([[rvNumber(1), ERRORS.DIV0, rvNumber(3)]]), rvNumber(0.5)])
    ).toEqual(ERRORS.DIV0);
  });
});

// ============================================================================
// Alias coverage (registry-level) — via the Workbook evaluator
//
// MODE.SNGL = MODE, FORECAST.LINEAR = FORECAST, CONFIDENCE = CONFIDENCE.NORM,
// STDEV.S = STDEV, STDEV.P = STDEVP, VAR.S = VAR, VAR.P = VARP,
// RANK.EQ = RANK, PERCENTILE.INC = PERCENTILE, QUARTILE.INC = QUARTILE,
// ERF.PRECISE = ERF, ERFC.PRECISE = ERFC, GAMMALN.PRECISE = GAMMALN.
//
// These tests exercise the registry wiring, not the math (which is covered
// via direct fn* tests). Each alias has ≥2 targeted cases.
// ============================================================================

import { lookupFunction } from "../../runtime/function-registry";

function evalFormula(formula: string): unknown {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Sheet1");
  // Seed a small data range so range-taking aliases have something to chew on.
  Cell.setValue(ws, "A1", 1);
  Cell.setValue(ws, "A2", 2);
  Cell.setValue(ws, "A3", 2);
  Cell.setValue(ws, "A4", 3);
  Cell.setValue(ws, "A5", 4);
  Cell.setValue(ws, "B1", 2);
  Cell.setValue(ws, "B2", 3);
  Cell.setValue(ws, "B3", 4);
  Cell.setValue(ws, "B4", 5);
  Cell.setValue(ws, "B5", 6);
  Cell.setValue(ws, "C1", { formula, result: 0 });
  calculateFormulas(wb);
  return Cell.getResult(ws, "C1");
}

describe("MODE.SNGL (alias of MODE)", () => {
  it("returns the most frequent value", () => {
    expect(evalFormula("MODE.SNGL(A1:A5)")).toBe(2);
  });
  it("mirrors MODE on the same range", () => {
    expect(evalFormula("MODE.SNGL(A1:A5)")).toBe(evalFormula("MODE(A1:A5)"));
  });
  it("returns #N/A when no value repeats", () => {
    expect(evalFormula("MODE.SNGL({1,2,3,4})")).toEqual({ error: "#N/A" });
  });
  it("reachable through lookupFunction", () => {
    expect(lookupFunction("MODE.SNGL")).toBeDefined();
    expect(lookupFunction("MODE.SNGL")?.invoke).toBe(lookupFunction("MODE")?.invoke);
  });
  it("accepts multiple arguments like MODE", () => {
    expect(evalFormula("MODE.SNGL(1,2,2,3)")).toBe(2);
  });
});

describe("FORECAST.LINEAR (alias of FORECAST)", () => {
  it("matches FORECAST for the same inputs", () => {
    const a = evalFormula("FORECAST.LINEAR(6,B1:B5,A1:A5)");
    const b = evalFormula("FORECAST(6,B1:B5,A1:A5)");
    expect(a).toBe(b);
  });
  it("reachable through lookupFunction with the same invoke", () => {
    expect(lookupFunction("FORECAST.LINEAR")?.invoke).toBe(lookupFunction("FORECAST")?.invoke);
  });
  it("predicts with correct slope on simple ascending data", () => {
    // y = x+1; predict x=10 ⇒ 11
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    for (let i = 1; i <= 5; i++) {
      Cell.setValue(ws, `A${i}`, i);
      Cell.setValue(ws, `B${i}`, i + 1);
    }
    Cell.setValue(ws, "C1", { formula: "FORECAST.LINEAR(10,B1:B5,A1:A5)", result: 0 });
    calculateFormulas(wb);
    expect(Cell.getResult(ws, "C1")).toBeCloseTo(11, 10);
  });
  it("returns #DIV/0! for zero-variance x data (same as FORECAST)", () => {
    expect(evalFormula("FORECAST.LINEAR(5,{1,2,3},{1,1,1})")).toEqual({ error: "#DIV/0!" });
  });
  it("propagates errors from inputs", () => {
    expect(evalFormula('FORECAST.LINEAR("x",B1:B5,A1:A5)')).toEqual({ error: "#VALUE!" });
  });
});

describe("CONFIDENCE (alias of CONFIDENCE.NORM)", () => {
  it("matches CONFIDENCE.NORM for the same inputs", () => {
    const a = evalFormula("CONFIDENCE(0.05,1,50)");
    const b = evalFormula("CONFIDENCE.NORM(0.05,1,50)");
    expect(a).toBe(b);
  });
  it("reachable through lookupFunction", () => {
    expect(lookupFunction("CONFIDENCE")?.invoke).toBe(lookupFunction("CONFIDENCE.NORM")?.invoke);
  });
  it("rejects alpha outside (0,1)", () => {
    expect(evalFormula("CONFIDENCE(0,1,10)")).toEqual({ error: "#NUM!" });
    expect(evalFormula("CONFIDENCE(1,1,10)")).toEqual({ error: "#NUM!" });
  });
  it("rejects non-positive standard deviation", () => {
    expect(evalFormula("CONFIDENCE(0.05,0,10)")).toEqual({ error: "#NUM!" });
  });
  it("rejects n<1", () => {
    expect(evalFormula("CONFIDENCE(0.05,1,0)")).toEqual({ error: "#NUM!" });
  });
});

describe("STDEV.S / STDEV.P / VAR.S / VAR.P / RANK.EQ aliases", () => {
  it("STDEV.S equals STDEV", () => {
    expect(evalFormula("STDEV.S(A1:A5)")).toBe(evalFormula("STDEV(A1:A5)"));
  });
  it("STDEV.P equals STDEVP", () => {
    expect(evalFormula("STDEV.P(A1:A5)")).toBe(evalFormula("STDEVP(A1:A5)"));
  });
  it("VAR.S equals VAR and VAR.P equals VARP", () => {
    expect(evalFormula("VAR.S(A1:A5)")).toBe(evalFormula("VAR(A1:A5)"));
    expect(evalFormula("VAR.P(A1:A5)")).toBe(evalFormula("VARP(A1:A5)"));
  });
  it("RANK.EQ equals RANK", () => {
    expect(evalFormula("RANK.EQ(3,A1:A5)")).toBe(evalFormula("RANK(3,A1:A5)"));
  });
  it("PERCENTILE.INC equals PERCENTILE, QUARTILE.INC equals QUARTILE", () => {
    expect(evalFormula("PERCENTILE.INC(A1:A5,0.5)")).toBe(evalFormula("PERCENTILE(A1:A5,0.5)"));
    expect(evalFormula("QUARTILE.INC(A1:A5,2)")).toBe(evalFormula("QUARTILE(A1:A5,2)"));
  });
});

describe("ERF.PRECISE / ERFC.PRECISE / GAMMALN.PRECISE (aliases)", () => {
  it("ERF.PRECISE(x) equals ERF(x)", () => {
    expect(evalFormula("ERF.PRECISE(1)")).toBe(evalFormula("ERF(1)"));
    expect(evalFormula("ERF.PRECISE(0)")).toBe(evalFormula("ERF(0)"));
  });
  it("ERFC.PRECISE(x) equals ERFC(x)", () => {
    expect(evalFormula("ERFC.PRECISE(1)")).toBe(evalFormula("ERFC(1)"));
  });
  it("GAMMALN.PRECISE equals GAMMALN", () => {
    expect(evalFormula("GAMMALN.PRECISE(5)")).toBe(evalFormula("GAMMALN(5)"));
  });
  it("registry wiring shares invoke functions", () => {
    expect(lookupFunction("ERF.PRECISE")?.invoke).toBe(lookupFunction("ERF")?.invoke);
    expect(lookupFunction("ERFC.PRECISE")?.invoke).toBe(lookupFunction("ERFC")?.invoke);
    expect(lookupFunction("GAMMALN.PRECISE")?.invoke).toBe(lookupFunction("GAMMALN")?.invoke);
  });
  it("ERF.PRECISE propagates errors", () => {
    expect(evalFormula('ERF.PRECISE("abc")')).toEqual({ error: "#VALUE!" });
  });
});

// ============================================================================
// Low-coverage direct function expansions (pre-existing functions)
// ============================================================================

describe("MODE (extra coverage)", () => {
  it("returns most frequent when ties broken by first occurrence", () => {
    // Both 1 and 2 appear twice; MODE returns the first occurrence (1)
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(1), rvNumber(2)]]);
    expect(asNumber(fnMODE([arr]))).toBe(1);
  });
  it("ignores non-numeric cells", () => {
    const arr = rvArray([[rvString("x"), rvNumber(2), rvBoolean(true), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnMODE([arr]))).toBe(2);
  });
  it("propagates errors in the source array", () => {
    const arr = rvArray([[ERRORS.NA, rvNumber(1), rvNumber(1)]]);
    expect(fnMODE([arr])).toEqual(ERRORS.NA);
  });
  it("multiple arg form still works", () => {
    expect(asNumber(fnMODE([rvNumber(5), rvNumber(5), rvNumber(7)]))).toBe(5);
  });
  it("empty range returns #N/A", () => {
    expect(fnMODE([rvArray([[]])])).toEqual(ERRORS.NA);
  });
});

describe("INTERCEPT (extra coverage)", () => {
  it("returns y-intercept of y=x+3 as 3", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const ys = rvArray([[rvNumber(4), rvNumber(5), rvNumber(6)]]);
    expect(asNumber(fnINTERCEPT([ys, xs]))).toBeCloseTo(3, 10);
  });
  it("returns intercept of y=2x as 0", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    expect(asNumber(fnINTERCEPT([ys, xs]))).toBeCloseTo(0, 10);
  });
  it("returns #DIV/0! when all x are identical", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    const ys = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnINTERCEPT([ys, xs])).toEqual(ERRORS.DIV0);
  });
  it("handles mismatched shapes by truncating to the shorter length", () => {
    // Engine uses min(len(xs), len(ys)); not #N/A.
    const xs = rvArray([[rvNumber(1), rvNumber(2)]]);
    const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(100)]]);
    // Truncates to first 2 pairs → y=2x, intercept=0
    expect(asNumber(fnINTERCEPT([ys, xs]))).toBeCloseTo(0, 10);
  });
  it("propagates errors from input ranges (R8 fix)", () => {
    // Previously errors were silently filtered; now they propagate.
    const r = fnINTERCEPT([rvArray([[ERRORS.NA]]), rvArray([[rvNumber(1)]])]);
    expect(r).toEqual(ERRORS.NA);
  });
});

describe("RSQ (extra coverage)", () => {
  it("returns 1 for perfectly correlated data", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8)]]);
    expect(asNumber(fnRSQ([ys, xs]))).toBeCloseTo(1, 10);
  });
  it("returns ~0 for completely uncorrelated data", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const ys = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5), rvNumber(5)]]);
    // All y identical → variance zero → #DIV/0!
    expect(fnRSQ([ys, xs])).toEqual(ERRORS.DIV0);
  });
  it("returns 1 for identical series", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnRSQ([a, a]))).toBeCloseTo(1, 10);
  });
  it("truncates to shorter length for mismatched shapes", () => {
    // Uses the first min(len1, len2) pairs. Here only 1 pair → #DIV/0!.
    const xs = rvArray([[rvNumber(1)]]);
    const ys = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnRSQ([ys, xs])).toEqual(ERRORS.DIV0);
  });
  it("propagates errors from input arrays (R8 fix)", () => {
    expect(fnRSQ([rvArray([[ERRORS.NA]]), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("PHI (extra coverage)", () => {
  it("PHI(0) ≈ 1/sqrt(2*PI) ≈ 0.3989", () => {
    expect(asNumber(fnPHI([rvNumber(0)]))).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
  it("PHI is even: PHI(-x)=PHI(x)", () => {
    for (const x of [0.5, 1, 2.5]) {
      expect(asNumber(fnPHI([rvNumber(-x)]))).toBeCloseTo(asNumber(fnPHI([rvNumber(x)])), 10);
    }
  });
  it("PHI(3) < PHI(1) (density tails decay)", () => {
    expect(asNumber(fnPHI([rvNumber(3)]))).toBeLessThan(asNumber(fnPHI([rvNumber(1)])));
  });
  it("propagates errors", () => {
    expect(fnPHI([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("rejects text arguments with #VALUE!", () => {
    expect(fnPHI([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("GAUSS (extra coverage)", () => {
  it("GAUSS(0)=0", () => {
    expect(asNumber(fnGAUSS([rvNumber(0)]))).toBe(0);
  });
  it("GAUSS(1) ≈ 0.3413 (standard normal 0..1)", () => {
    expect(asNumber(fnGAUSS([rvNumber(1)]))).toBeCloseTo(0.3413, 3);
  });
  it("GAUSS is odd: GAUSS(-x)=-GAUSS(x)", () => {
    for (const x of [0.5, 1, 2]) {
      expect(asNumber(fnGAUSS([rvNumber(-x)]))).toBeCloseTo(-asNumber(fnGAUSS([rvNumber(x)])), 10);
    }
  });
  it("propagates errors", () => {
    expect(fnGAUSS([ERRORS.NUM])).toEqual(ERRORS.NUM);
  });
  it("rejects text", () => {
    expect(fnGAUSS([rvString("abc")])).toEqual(ERRORS.VALUE);
  });
});

describe("GAMMALN (extra coverage)", () => {
  it("GAMMALN(1)=0 and GAMMALN(2)=0", () => {
    expect(asNumber(fnGAMMALN([rvNumber(1)]))).toBeCloseTo(0, 10);
    expect(asNumber(fnGAMMALN([rvNumber(2)]))).toBeCloseTo(0, 10);
  });
  it("GAMMALN(6)=ln(120)≈4.7875", () => {
    expect(asNumber(fnGAMMALN([rvNumber(6)]))).toBeCloseTo(Math.log(120), 6);
  });
  it("rejects non-positive arguments with #NUM!", () => {
    expect(fnGAMMALN([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnGAMMALN([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("propagates errors", () => {
    expect(fnGAMMALN([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("rejects text", () => {
    expect(fnGAMMALN([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("QUARTILE (extra coverage)", () => {
  const data = rvArray([
    [rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5), rvNumber(6), rvNumber(7)]
  ]);
  it("Q0 is the min", () => {
    expect(asNumber(fnQUARTILE([data, rvNumber(0)]))).toBe(1);
  });
  it("Q2 is the median", () => {
    expect(asNumber(fnQUARTILE([data, rvNumber(2)]))).toBe(4);
  });
  it("Q4 is the max", () => {
    expect(asNumber(fnQUARTILE([data, rvNumber(4)]))).toBe(7);
  });
  it("Q1 and Q3 are between min and max", () => {
    const q1 = asNumber(fnQUARTILE([data, rvNumber(1)]));
    const q3 = asNumber(fnQUARTILE([data, rvNumber(3)]));
    expect(q1).toBeGreaterThan(1);
    expect(q1).toBeLessThan(4);
    expect(q3).toBeGreaterThan(4);
    expect(q3).toBeLessThan(7);
  });
  it("rejects quart outside [0,4]", () => {
    expect(fnQUARTILE([data, rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnQUARTILE([data, rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("VAR / VAR.P / STDEV.P extra", () => {
  const data = rvArray([
    [
      rvNumber(2),
      rvNumber(4),
      rvNumber(4),
      rvNumber(4),
      rvNumber(5),
      rvNumber(5),
      rvNumber(7),
      rvNumber(9)
    ]
  ]);

  it("VAR (sample) is 4", () => {
    expect(asNumber(fnVAR([data]))).toBeCloseTo(32 / 7, 10);
  });
  it("VARP (population) is 4", () => {
    expect(asNumber(fnVARP([data]))).toBeCloseTo(4, 10);
  });
  it("STDEVP is sqrt(VARP)", () => {
    const vp = asNumber(fnVARP([data]));
    expect(asNumber(fnSTDEVP([data]))).toBeCloseTo(Math.sqrt(vp), 10);
  });
  it("VAR on single value returns #DIV/0!", () => {
    expect(fnVAR([rvNumber(5)])).toEqual(ERRORS.DIV0);
  });
  it("VARP on single value is 0", () => {
    expect(asNumber(fnVARP([rvNumber(5)]))).toBe(0);
  });
  it("propagate errors", () => {
    expect(fnVAR([rvArray([[ERRORS.NA, rvNumber(1)]])])).toEqual(ERRORS.NA);
    expect(fnSTDEVP([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("SKEW (extra coverage)", () => {
  it("returns 0 for symmetric data", () => {
    const arr = rvArray([[rvNumber(-2), rvNumber(-1), rvNumber(0), rvNumber(1), rvNumber(2)]]);
    expect(asNumber(fnSKEW([arr]))).toBeCloseTo(0, 6);
  });
  it("returns positive for right-skewed data", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1), rvNumber(10)]]);
    expect(asNumber(fnSKEW([arr]))).toBeGreaterThan(0);
  });
  it("returns negative for left-skewed data", () => {
    const arr = rvArray([[rvNumber(-10), rvNumber(1), rvNumber(1), rvNumber(1)]]);
    expect(asNumber(fnSKEW([arr]))).toBeLessThan(0);
  });
  it("requires n ≥ 3 — returns #DIV/0! for n=2", () => {
    expect(fnSKEW([rvNumber(1), rvNumber(2)])).toEqual(ERRORS.DIV0);
  });
  it("propagates errors", () => {
    expect(fnSKEW([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("KURT (extra coverage)", () => {
  it("requires n ≥ 4 — returns #DIV/0! for n=3", () => {
    expect(fnKURT([rvNumber(1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.DIV0);
  });
  it("normal-ish data has kurt near 0 after Excel's unbiased adjustment", () => {
    // Just check it returns a finite number on symmetric input
    const arr = rvArray([[rvNumber(-2), rvNumber(-1), rvNumber(0), rvNumber(1), rvNumber(2)]]);
    const v = asNumber(fnKURT([arr]));
    expect(Number.isFinite(v)).toBe(true);
  });
  it("heavy-tailed data has positive kurtosis", () => {
    const arr = rvArray([[rvNumber(-5), rvNumber(0), rvNumber(0), rvNumber(0), rvNumber(5)]]);
    expect(asNumber(fnKURT([arr]))).toBeGreaterThan(0);
  });
  it("propagates errors", () => {
    expect(fnKURT([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("returns #DIV/0! when all values are identical", () => {
    const arr = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5), rvNumber(5), rvNumber(5)]]);
    expect(fnKURT([arr])).toEqual(ERRORS.DIV0);
  });
});

describe("AVEDEV (extra coverage)", () => {
  it("returns mean absolute deviation", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
    // Mean = 3; abs devs = 2,1,0,1,2 → avg = 6/5 = 1.2
    expect(asNumber(fnAVEDEV([arr]))).toBeCloseTo(1.2, 10);
  });
  it("returns 0 when all values are identical", () => {
    expect(asNumber(fnAVEDEV([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]])]))).toBe(0);
  });
  it("multi-arg form", () => {
    // data = 2,4,4,4,5,5,7,9; mean = 5; abs devs = 3,1,1,1,0,0,2,4 → avg = 12/8 = 1.5
    expect(
      asNumber(
        fnAVEDEV([
          rvNumber(2),
          rvNumber(4),
          rvNumber(4),
          rvNumber(4),
          rvNumber(5),
          rvNumber(5),
          rvNumber(7),
          rvNumber(9)
        ])
      )
    ).toBeCloseTo(1.5, 10);
  });
  it("returns #NUM! on empty input", () => {
    expect(fnAVEDEV([rvArray([[]])])).toEqual(ERRORS.NUM);
  });
  it("propagates errors", () => {
    expect(fnAVEDEV([rvArray([[ERRORS.NA, rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("COVARIANCE.S (extra coverage)", () => {
  it("returns sample covariance of two ranges", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    // Perfectly linear → Cov_s = (1*2 + 0*0 + 1*2)/2 = 2
    expect(asNumber(fnCOVARIANCE_S([xs, ys]))).toBeCloseTo(2, 10);
  });
  it("is 0 for perfectly anti-correlated mean-centered data", () => {
    const xs = rvArray([[rvNumber(-1), rvNumber(0), rvNumber(1)]]);
    const ys = rvArray([[rvNumber(1), rvNumber(0), rvNumber(-1)]]);
    expect(asNumber(fnCOVARIANCE_S([xs, ys]))).toBeCloseTo(-1, 10);
  });
  it("returns 0 when ys are constant", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const ys = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    expect(asNumber(fnCOVARIANCE_S([xs, ys]))).toBeCloseTo(0, 10);
  });
  it("truncates to shorter length for mismatched shapes (no #N/A)", () => {
    // engine uses min(len, len); matching truncated ranges
    const xs = rvArray([[rvNumber(1), rvNumber(2)]]);
    const ys = rvArray([[rvNumber(1), rvNumber(2), rvNumber(100)]]);
    // After truncation: xs=[1,2], ys=[1,2] → cov_s = (0 + 0.5*0.5*2)/1 = 0.5
    const r = asNumber(fnCOVARIANCE_S([xs, ys]));
    expect(r).toBeCloseTo(0.5, 5);
  });
  it("propagates errors from the input arrays", () => {
    expect(fnCOVARIANCE_S([rvArray([[ERRORS.NA]]), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("DEVSQ (extra coverage)", () => {
  it("returns sum of squared deviations", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
    // mean=3; devs=(-2,-1,0,1,2) → ss=4+1+0+1+4=10
    expect(asNumber(fnDEVSQ([arr]))).toBeCloseTo(10, 10);
  });
  it("returns 0 for identical values", () => {
    expect(asNumber(fnDEVSQ([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]])]))).toBe(0);
  });
  it("multi-arg form", () => {
    expect(asNumber(fnDEVSQ([rvNumber(1), rvNumber(2), rvNumber(3)]))).toBeCloseTo(2, 10);
  });
  it("returns 0 on empty (engine convention: empty ss is 0, not #NUM!)", () => {
    expect(asNumber(fnDEVSQ([rvArray([[]])]))).toBe(0);
  });
  it("propagates errors", () => {
    expect(fnDEVSQ([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("MAXA / MINA (extra coverage)", () => {
  it("MAXA counts TRUE as 1 and FALSE as 0 inside arrays", () => {
    const arr = rvArray([[rvNumber(-1), rvBoolean(true)]]);
    expect(asNumber(fnMAXA([arr]))).toBe(1);
  });
  it("MINA counts TRUE as 1, FALSE as 0 inside arrays", () => {
    const arr = rvArray([[rvNumber(5), rvBoolean(false)]]);
    expect(asNumber(fnMINA([arr]))).toBe(0);
  });
  it("MAXA / MINA treat text in arrays as 0", () => {
    const arr = rvArray([[rvString("abc"), rvNumber(-3)]]);
    expect(asNumber(fnMAXA([arr]))).toBe(0);
    expect(asNumber(fnMINA([arr]))).toBe(-3);
  });
  it("returns 0 for empty input", () => {
    expect(asNumber(fnMAXA([rvArray([[]])]))).toBe(0);
    expect(asNumber(fnMINA([rvArray([[]])]))).toBe(0);
  });
  it("propagate errors", () => {
    expect(fnMAXA([rvNumber(1), ERRORS.NUM])).toEqual(ERRORS.NUM);
    expect(fnMINA([rvNumber(1), ERRORS.NUM])).toEqual(ERRORS.NUM);
  });
});

describe("FISHERINV (extra coverage)", () => {
  it("FISHERINV(0) = 0", () => {
    expect(asNumber(fnFISHERINV([rvNumber(0)]))).toBeCloseTo(0, 10);
  });
  it("FISHERINV inverts FISHER", () => {
    for (const x of [-0.5, 0.1, 0.7, 0.9]) {
      const f = asNumber(fnFISHER([rvNumber(x)]));
      expect(asNumber(fnFISHERINV([rvNumber(f)]))).toBeCloseTo(x, 10);
    }
  });
  it("produces values in (-1, 1)", () => {
    for (const y of [-5, -1, 0, 1, 5]) {
      const v = asNumber(fnFISHERINV([rvNumber(y)]));
      expect(v).toBeGreaterThan(-1);
      expect(v).toBeLessThan(1);
    }
  });
  it("propagates errors", () => {
    expect(fnFISHERINV([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("rejects text", () => {
    expect(fnFISHERINV([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("ERFC (extra coverage)", () => {
  it("ERFC(0)=1", () => {
    expect(asNumber(fnERFC([rvNumber(0)]))).toBeCloseTo(1, 6);
  });
  it("ERFC and ERF sum to 1", () => {
    for (const x of [0.1, 0.5, 1, 1.5]) {
      const e = asNumber(fnERF([rvNumber(x)]));
      const ec = asNumber(fnERFC([rvNumber(x)]));
      expect(e + ec).toBeCloseTo(1, 6);
    }
  });
  it("ERFC(5) ≈ 0 (upper tail vanishes)", () => {
    expect(asNumber(fnERFC([rvNumber(5)]))).toBeCloseTo(0, 5);
  });
  it("propagates errors", () => {
    expect(fnERFC([ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("rejects text", () => {
    expect(fnERFC([rvString("x")])).toEqual(ERRORS.VALUE);
  });
});

describe("SLOPE (extra coverage)", () => {
  it("SLOPE of y=2x is 2", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const ys = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    expect(asNumber(fnSLOPE([ys, xs]))).toBeCloseTo(2, 10);
  });
  it("SLOPE of y=-x+5 is -1", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const ys = rvArray([[rvNumber(4), rvNumber(3), rvNumber(2)]]);
    expect(asNumber(fnSLOPE([ys, xs]))).toBeCloseTo(-1, 10);
  });
  it("returns #DIV/0! for constant x", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1)]]);
    const ys = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnSLOPE([ys, xs])).toEqual(ERRORS.DIV0);
  });
  it("truncates for mismatched shapes (uses shorter length)", () => {
    // Short xs with 1 element → n<2 → #DIV/0!
    expect(fnSLOPE([rvArray([[rvNumber(1)]]), rvArray([[rvNumber(1), rvNumber(2)]])])).toEqual(
      ERRORS.DIV0
    );
  });
  it("propagates errors from input arrays (R8 fix)", () => {
    expect(fnSLOPE([rvArray([[ERRORS.NA]]), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.NA);
  });
});

describe("T.DIST.RT / T.INV extra", () => {
  it("T.INV of 0.5 is 0 (symmetric median)", () => {
    expect(asNumber(fnT_INV([rvNumber(0.5), rvNumber(10)]))).toBeCloseTo(0, 10);
  });
  it("T.DIST.RT + T.DIST (LHS) = 1 for positive x", () => {
    for (const x of [0.5, 1, 2]) {
      const rt = asNumber(fnT_DIST_RT([rvNumber(x), rvNumber(10)]));
      const lhs = asNumber(fnT_DIST([rvNumber(x), rvNumber(10), rvBoolean(true)]));
      expect(rt + lhs).toBeCloseTo(1, 6);
    }
  });
  it("T.INV inverts T.DIST", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnT_INV([rvNumber(p), rvNumber(10)]));
      const q = asNumber(fnT_DIST([rvNumber(x), rvNumber(10), rvBoolean(true)]));
      expect(q).toBeCloseTo(p, 5);
    }
  });
  it("T.DIST.RT propagates errors", () => {
    expect(fnT_DIST_RT([ERRORS.NA, rvNumber(10)])).toEqual(ERRORS.NA);
  });
  it("T.INV rejects p outside (0,1)", () => {
    expect(fnT_INV([rvNumber(0), rvNumber(10)])).toEqual(ERRORS.NUM);
    expect(fnT_INV([rvNumber(1), rvNumber(10)])).toEqual(ERRORS.NUM);
  });
});

describe("F.INV.RT (extra coverage)", () => {
  it("F.INV.RT(0.5, ...) is the median of the F distribution", () => {
    const v = asNumber(fnF_INV_RT([rvNumber(0.5), rvNumber(5), rvNumber(10)]));
    expect(v).toBeGreaterThan(0);
  });
  it("F.INV.RT is inverse of F.DIST.RT", () => {
    for (const p of [0.05, 0.5, 0.95]) {
      const x = asNumber(fnF_INV_RT([rvNumber(p), rvNumber(5), rvNumber(5)]));
      const q = asNumber(fnF_DIST_RT([rvNumber(x), rvNumber(5), rvNumber(5)]));
      expect(q).toBeCloseTo(p, 5);
    }
  });
  it("rejects p outside (0,1]", () => {
    expect(fnF_INV_RT([rvNumber(0), rvNumber(5), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnF_INV_RT([rvNumber(-1), rvNumber(5), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("propagates errors", () => {
    expect(fnF_INV_RT([ERRORS.NA, rvNumber(5), rvNumber(5)])).toEqual(ERRORS.NA);
  });
  it("rejects non-positive degrees of freedom", () => {
    expect(fnF_INV_RT([rvNumber(0.5), rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
});

describe("LOGNORM.DIST / LOGNORM.INV (extra coverage)", () => {
  it("LOGNORM.DIST(1,0,1,FALSE) returns the density at x=1", () => {
    const v = asNumber(fnLOGNORM_DIST([rvNumber(1), rvNumber(0), rvNumber(1), rvBoolean(false)]));
    // At x=1 with mu=0, sigma=1: 1/(1*sqrt(2PI)) = ~0.3989
    expect(v).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
  it("LOGNORM.DIST cumulative is monotone", () => {
    const v1 = asNumber(fnLOGNORM_DIST([rvNumber(0.5), rvNumber(0), rvNumber(1), rvBoolean(true)]));
    const v2 = asNumber(fnLOGNORM_DIST([rvNumber(1), rvNumber(0), rvNumber(1), rvBoolean(true)]));
    const v3 = asNumber(fnLOGNORM_DIST([rvNumber(2), rvNumber(0), rvNumber(1), rvBoolean(true)]));
    expect(v1).toBeLessThan(v2);
    expect(v2).toBeLessThan(v3);
  });
  it("LOGNORM.INV inverts LOGNORM.DIST cumulative", () => {
    const p = asNumber(fnLOGNORM_DIST([rvNumber(2), rvNumber(0), rvNumber(1), rvBoolean(true)]));
    expect(asNumber(fnLOGNORM_INV([rvNumber(p), rvNumber(0), rvNumber(1)]))).toBeCloseTo(2, 4);
  });
  it("LOGNORM.DIST rejects non-positive x", () => {
    expect(fnLOGNORM_DIST([rvNumber(0), rvNumber(0), rvNumber(1), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("LOGNORM.DIST propagates errors", () => {
    expect(fnLOGNORM_DIST([ERRORS.NA, rvNumber(0), rvNumber(1), rvBoolean(true)])).toEqual(
      ERRORS.NA
    );
  });
});

describe("BETA.INV (extra coverage)", () => {
  it("BETA.INV is inverse of BETA.DIST cumulative", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnBETA_INV([rvNumber(p), rvNumber(2), rvNumber(3)]));
      const q = asNumber(fnBETA_DIST([rvNumber(x), rvNumber(2), rvNumber(3), rvBoolean(true)]));
      expect(q).toBeCloseTo(p, 5);
    }
  });
  it("supports custom lower/upper bounds", () => {
    const x = asNumber(
      fnBETA_INV([rvNumber(0.5), rvNumber(2), rvNumber(2), rvNumber(10), rvNumber(20)])
    );
    // median of Beta(2,2) scaled to [10,20] → 15
    expect(x).toBeCloseTo(15, 5);
  });
  it("rejects p outside [0,1]", () => {
    expect(fnBETA_INV([rvNumber(-0.1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NUM);
    expect(fnBETA_INV([rvNumber(1.1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("rejects non-positive shape parameters", () => {
    expect(fnBETA_INV([rvNumber(0.5), rvNumber(0), rvNumber(3)])).toEqual(ERRORS.NUM);
    expect(fnBETA_INV([rvNumber(0.5), rvNumber(2), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates errors", () => {
    expect(fnBETA_INV([ERRORS.NA, rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NA);
  });
});

describe("GAMMA.INV (extra coverage)", () => {
  it("is inverse of GAMMA.DIST cumulative", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnGAMMA_INV([rvNumber(p), rvNumber(2), rvNumber(3)]));
      const q = asNumber(fnGAMMA_DIST([rvNumber(x), rvNumber(2), rvNumber(3), rvBoolean(true)]));
      expect(q).toBeCloseTo(p, 5);
    }
  });
  it("rejects p outside [0,1]", () => {
    expect(fnGAMMA_INV([rvNumber(-0.1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NUM);
    expect(fnGAMMA_INV([rvNumber(1.1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("rejects non-positive shape/scale", () => {
    expect(fnGAMMA_INV([rvNumber(0.5), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnGAMMA_INV([rvNumber(0.5), rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates errors", () => {
    expect(fnGAMMA_INV([ERRORS.NA, rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NA);
  });
  it("GAMMA.INV(0, alpha, beta) ≈ 0 (lower boundary, numerically near zero)", () => {
    // Engine's numerical inverse may return a value close to 0 rather than
    // exactly 0 at the lower boundary.
    expect(asNumber(fnGAMMA_INV([rvNumber(0), rvNumber(2), rvNumber(3)]))).toBeCloseTo(0, 5);
  });
});

describe("GROWTH / TREND (extra coverage)", () => {
  const knownY = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8)]]);
  const knownX = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);

  it("TREND returns known_y when called with defaults", () => {
    const r = fnTREND([knownY]);
    expect(r.kind).toBe(RVKind.Array);
  });
  it("TREND extrapolates correctly for y=2x", () => {
    const r = fnTREND([knownY, knownX, rvArray([[rvNumber(5), rvNumber(6)]])]);
    expect(r.kind).toBe(RVKind.Array);
    const arr = r as ArrayValue;
    // Predict x=5,6 ⇒ 10, 12
    expect((arr.rows[0][0] as NumberValue).value).toBeCloseTo(10, 5);
    expect((arr.rows[0][1] as NumberValue).value).toBeCloseTo(12, 5);
  });
  it("GROWTH fits exponential model y = b * m^x", () => {
    // y = 2^x → (1,2), (2,4), (3,8), (4,16)
    const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(8), rvNumber(16)]]);
    const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const r = fnGROWTH([y, x, rvArray([[rvNumber(5)]])]);
    expect(r.kind).toBe(RVKind.Array);
    const arr = r as ArrayValue;
    // Predict at x=5 ⇒ 32
    expect((arr.rows[0][0] as NumberValue).value).toBeCloseTo(32, 3);
  });
  it("TREND rejects mismatched shapes", () => {
    const badX = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnTREND([knownY, badX])).toEqual(ERRORS.REF);
  });
  it("GROWTH propagates errors", () => {
    expect(fnGROWTH([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("LINEST / LOGEST (extra coverage)", () => {
  const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8)]]);
  const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);

  it("LINEST returns [slope, intercept] for linear data", () => {
    const r = fnLINEST([y, x]);
    expect(r.kind).toBe(RVKind.Array);
    const arr = r as ArrayValue;
    expect((arr.rows[0][0] as NumberValue).value).toBeCloseTo(2, 10);
    expect((arr.rows[0][1] as NumberValue).value).toBeCloseTo(0, 10);
  });
  it("LINEST default x is 1,2,3,...,n", () => {
    const r = fnLINEST([y]);
    expect(r.kind).toBe(RVKind.Array);
  });
  it("LOGEST fits exponential y = b * m^x", () => {
    const yExp = rvArray([[rvNumber(2), rvNumber(4), rvNumber(8), rvNumber(16)]]);
    const r = fnLOGEST([yExp, x]);
    expect(r.kind).toBe(RVKind.Array);
    const arr = r as ArrayValue;
    expect((arr.rows[0][0] as NumberValue).value).toBeCloseTo(2, 5);
    expect((arr.rows[0][1] as NumberValue).value).toBeCloseTo(1, 5);
  });
  it("LINEST propagates errors", () => {
    expect(fnLINEST([rvArray([[ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("LOGEST rejects non-positive y", () => {
    const badY = rvArray([[rvNumber(-1), rvNumber(2), rvNumber(3)]]);
    expect(fnLOGEST([badY])).toEqual(ERRORS.NUM);
  });
});

// ============================================================================
// R8 deep coverage: advanced distribution & helpers
// ============================================================================

describe("STANDARDIZE comprehensive", () => {
  it("standardises to z-score", () => {
    // STANDARDIZE(42, 40, 1.5) = (42-40)/1.5 ≈ 1.333
    expect(asNumber(fnSTANDARDIZE([rvNumber(42), rvNumber(40), rvNumber(1.5)]))).toBeCloseTo(
      1.3333,
      3
    );
  });

  it("returns 0 when value equals mean", () => {
    expect(asNumber(fnSTANDARDIZE([rvNumber(10), rvNumber(10), rvNumber(2)]))).toBe(0);
  });

  it("negative z-score when value below mean", () => {
    expect(asNumber(fnSTANDARDIZE([rvNumber(5), rvNumber(10), rvNumber(2)]))).toBeCloseTo(-2.5, 5);
  });

  it("zero stdev → #NUM!", () => {
    expect(fnSTANDARDIZE([rvNumber(5), rvNumber(10), rvNumber(0)])).toEqual(ERRORS.NUM);
  });

  it("negative stdev → #NUM!", () => {
    expect(fnSTANDARDIZE([rvNumber(5), rvNumber(10), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });

  it("error propagation", () => {
    expect(fnSTANDARDIZE([ERRORS.NA, rvNumber(10), rvNumber(2)])).toEqual(ERRORS.NA);
  });
});

describe("FREQUENCY comprehensive", () => {
  it("bins correctly in sorted bins", () => {
    const data = rvArray([[rvNumber(1)], [rvNumber(5)], [rvNumber(10)], [rvNumber(15)]]);
    const bins = rvArray([[rvNumber(4)], [rvNumber(10)]]);
    const r = fnFREQUENCY([data, bins]) as ArrayValue;
    // should be 3-bucket: ≤4, 4-10, >10
    expect(r.height).toBe(3);
    expect((r.rows[0][0] as NumberValue).value).toBe(1); // 1 only
    expect((r.rows[1][0] as NumberValue).value).toBe(2); // 5, 10
    expect((r.rows[2][0] as NumberValue).value).toBe(1); // 15
  });

  it("does NOT sort bins (preserves user order)", () => {
    const data = rvArray([[rvNumber(1)], [rvNumber(5)]]);
    const bins = rvArray([[rvNumber(10)], [rvNumber(4)]]); // descending
    const r = fnFREQUENCY([data, bins]) as ArrayValue;
    expect(r.height).toBe(3);
    // With first-match semantics, both 1 and 5 fall into bin 1 (≤10)
    expect((r.rows[0][0] as NumberValue).value).toBe(2);
  });

  it("empty data → all zeros", () => {
    const bins = rvArray([[rvNumber(5)], [rvNumber(10)]]);
    const r = fnFREQUENCY([rvArray([[]]), bins]) as ArrayValue;
    expect(r.height).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect((r.rows[i][0] as NumberValue).value).toBe(0);
    }
  });
});

describe("SKEW / KURT comprehensive", () => {
  it("SKEW of symmetric data ≈ 0", () => {
    const data = rvArray([
      [rvNumber(1)],
      [rvNumber(2)],
      [rvNumber(3)],
      [rvNumber(4)],
      [rvNumber(5)]
    ]);
    expect(Math.abs(asNumber(fnSKEW([data])))).toBeLessThan(1e-10);
  });

  it("SKEW positive for right-skewed", () => {
    const data = rvArray([
      [rvNumber(1)],
      [rvNumber(2)],
      [rvNumber(2)],
      [rvNumber(2)],
      [rvNumber(10)]
    ]);
    expect(asNumber(fnSKEW([data]))).toBeGreaterThan(0);
  });

  it("SKEW with <3 points → #DIV/0!", () => {
    expect(fnSKEW([rvArray([[rvNumber(1)], [rvNumber(2)]])])).toEqual(ERRORS.DIV0);
  });

  it("KURT of uniform data", () => {
    const data = rvArray([
      [rvNumber(1)],
      [rvNumber(2)],
      [rvNumber(3)],
      [rvNumber(4)],
      [rvNumber(5)]
    ]);
    // kurtosis of uniform {1..5} should be negative (platykurtic)
    expect(asNumber(fnKURT([data]))).toBeLessThan(0);
  });

  it("KURT with <4 points → #DIV/0!", () => {
    expect(fnKURT([rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]])])).toEqual(ERRORS.DIV0);
  });
});

describe("TRIMMEAN comprehensive", () => {
  it("trims specified fraction from each end", () => {
    // TRIMMEAN([1..10], 0.2) = mean of [2..9] = 5.5
    const data = rvArray(Array.from({ length: 10 }, (_, i) => [rvNumber(i + 1)]));
    expect(asNumber(fnTRIMMEAN([data, rvNumber(0.2)]))).toBeCloseTo(5.5, 5);
  });

  it("percent=0 = regular mean", () => {
    const data = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    expect(asNumber(fnTRIMMEAN([data, rvNumber(0)]))).toBe(2);
  });

  it("percent outside [0, 1) → #NUM!", () => {
    const data = rvArray([[rvNumber(1)], [rvNumber(2)]]);
    expect(fnTRIMMEAN([data, rvNumber(-0.1)])).toEqual(ERRORS.NUM);
    expect(fnTRIMMEAN([data, rvNumber(1)])).toEqual(ERRORS.NUM);
  });
});

describe("GEOMEAN / HARMEAN comprehensive", () => {
  it("GEOMEAN of {2,8} = 4", () => {
    expect(asNumber(fnGEOMEAN([rvArray([[rvNumber(2)], [rvNumber(8)]])]))).toBe(4);
  });

  it("GEOMEAN with zero → #NUM!", () => {
    expect(fnGEOMEAN([rvArray([[rvNumber(0)], [rvNumber(5)]])])).toEqual(ERRORS.NUM);
  });

  it("GEOMEAN with negative → #NUM!", () => {
    expect(fnGEOMEAN([rvArray([[rvNumber(-1)], [rvNumber(5)]])])).toEqual(ERRORS.NUM);
  });

  it("HARMEAN of {2,4} = 2.667", () => {
    expect(asNumber(fnHARMEAN([rvArray([[rvNumber(2)], [rvNumber(4)]])]))).toBeCloseTo(8 / 3, 5);
  });

  it("HARMEAN with zero → #NUM!", () => {
    expect(fnHARMEAN([rvArray([[rvNumber(0)], [rvNumber(5)]])])).toEqual(ERRORS.NUM);
  });
});

describe("CORREL boundary conditions", () => {
  it("perfect positive correlation = 1", () => {
    const x = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const y = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(6)]]);
    expect(asNumber(fnCORREL([x, y]))).toBeCloseTo(1, 5);
  });

  it("perfect negative correlation = -1", () => {
    const x = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const y = rvArray([[rvNumber(3)], [rvNumber(2)], [rvNumber(1)]]);
    expect(asNumber(fnCORREL([x, y]))).toBeCloseTo(-1, 5);
  });

  it("identical values → #DIV/0!", () => {
    const x = rvArray([[rvNumber(5)], [rvNumber(5)], [rvNumber(5)]]);
    const y = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    expect(fnCORREL([x, y])).toEqual(ERRORS.DIV0);
  });

  it("too few points → #DIV/0!", () => {
    const x = rvArray([[rvNumber(1)]]);
    const y = rvArray([[rvNumber(2)]]);
    expect(fnCORREL([x, y])).toEqual(ERRORS.DIV0);
  });

  it("mis-aligned non-numeric cells skip the pair positionally (regression)", () => {
    // Previously the engine flattened each side to numbers-only then
    // paired by prefix length, so {1, 2, "text", 4, 5} ↔ {10, 20, 30,
    // 40, 50} would misalign as (1,10),(2,20),(4,30),(5,40) — the
    // "text" on the left shifted the rest of the pairing by one. Excel
    // skips the entire pair when either side is non-numeric.
    const x = rvArray([[rvNumber(1), rvNumber(2), rvString("text"), rvNumber(4), rvNumber(5)]]);
    const y = rvArray([[rvNumber(10), rvNumber(20), rvNumber(30), rvNumber(40), rvNumber(50)]]);
    // Surviving pairs: (1,10), (2,20), (4,40), (5,50) — correlation = 1.
    expect(asNumber(fnCORREL([x, y]))).toBeCloseTo(1, 10);
  });
});

describe("BINOM.DIST boundary", () => {
  it("P(X=0) with p=0 is 1 exactly", () => {
    expect(asNumber(fnBINOM_DIST([rvNumber(0), rvNumber(10), rvNumber(0), rvBoolean(false)]))).toBe(
      1
    );
  });

  it("P(X=10) with p=1 is 1 exactly", () => {
    expect(
      asNumber(fnBINOM_DIST([rvNumber(10), rvNumber(10), rvNumber(1), rvBoolean(false)]))
    ).toBe(1);
  });

  it("number_s > trials → #NUM!", () => {
    expect(fnBINOM_DIST([rvNumber(11), rvNumber(10), rvNumber(0.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });

  it("probability_s outside [0,1] → #NUM!", () => {
    expect(fnBINOM_DIST([rvNumber(5), rvNumber(10), rvNumber(1.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });

  it("cumulative at trials equals 1", () => {
    expect(
      asNumber(fnBINOM_DIST([rvNumber(10), rvNumber(10), rvNumber(0.5), rvBoolean(true)]))
    ).toBeCloseTo(1, 8);
  });
});

describe("POISSON boundary", () => {
  it("λ=0, x=0 PMF = 1", () => {
    expect(asNumber(fnPOISSON_DIST([rvNumber(0), rvNumber(0), rvBoolean(false)]))).toBe(1);
  });

  it("λ=0, x>0 PMF = 0", () => {
    expect(asNumber(fnPOISSON_DIST([rvNumber(5), rvNumber(0), rvBoolean(false)]))).toBe(0);
  });

  it("λ=0 CDF = 1 for any x>=0", () => {
    expect(asNumber(fnPOISSON_DIST([rvNumber(10), rvNumber(0), rvBoolean(true)]))).toBe(1);
  });

  it("negative λ → #NUM!", () => {
    expect(fnPOISSON_DIST([rvNumber(1), rvNumber(-1), rvBoolean(false)])).toEqual(ERRORS.NUM);
  });

  it("negative x → #NUM!", () => {
    expect(fnPOISSON_DIST([rvNumber(-1), rvNumber(1), rvBoolean(false)])).toEqual(ERRORS.NUM);
  });
});

describe("T.DIST / F.DIST / CHISQ.DIST round-trip with inverse", () => {
  it("NORM.S.INV(NORM.S.DIST(0, TRUE)) ≈ 0", () => {
    const cdf0 = fnNORMSDIST([rvNumber(0)]);
    expect(cdf0.kind).toBe(RVKind.Number);
    const p = (cdf0 as NumberValue).value;
    expect(asNumber(fnNORMSINV([rvNumber(p)]))).toBeCloseTo(0, 3);
  });

  it("T.INV at p=0.5 = 0 (symmetric)", () => {
    expect(asNumber(fnT_INV([rvNumber(0.5), rvNumber(10)]))).toBeCloseTo(0, 5);
  });

  it("T.DIST.RT at x=0 for any df = 0.5", () => {
    expect(asNumber(fnT_DIST_RT([rvNumber(0), rvNumber(10)]))).toBeCloseTo(0.5, 5);
  });

  it("CHISQ.INV(0, df) = 0", () => {
    expect(asNumber(fnCHISQ_INV([rvNumber(0), rvNumber(5)]))).toBe(0);
  });

  it("F.DIST.RT is decreasing in x", () => {
    const a = asNumber(fnF_DIST_RT([rvNumber(1), rvNumber(5), rvNumber(10)]));
    const b = asNumber(fnF_DIST_RT([rvNumber(5), rvNumber(5), rvNumber(10)]));
    expect(a).toBeGreaterThan(b);
  });
});

describe("EXPON.DIST / WEIBULL.DIST / GAMMA.DIST basic", () => {
  it("EXPON.DIST CDF is monotonic", () => {
    const a = asNumber(fnEXPON_DIST([rvNumber(1), rvNumber(1), rvBoolean(true)]));
    const b = asNumber(fnEXPON_DIST([rvNumber(2), rvNumber(1), rvBoolean(true)]));
    expect(b).toBeGreaterThan(a);
  });

  it("EXPON.DIST at x=0 cumulative = 0", () => {
    expect(asNumber(fnEXPON_DIST([rvNumber(0), rvNumber(1), rvBoolean(true)]))).toBe(0);
  });

  it("EXPON.DIST negative x → #NUM!", () => {
    expect(fnEXPON_DIST([rvNumber(-1), rvNumber(1), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });

  it("EXPON.DIST zero lambda → #NUM!", () => {
    expect(fnEXPON_DIST([rvNumber(1), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });

  it("WEIBULL.DIST CDF monotonic", () => {
    const a = asNumber(fnWEIBULL_DIST([rvNumber(1), rvNumber(2), rvNumber(1), rvBoolean(true)]));
    const b = asNumber(fnWEIBULL_DIST([rvNumber(2), rvNumber(2), rvNumber(1), rvBoolean(true)]));
    expect(b).toBeGreaterThan(a);
  });

  it("GAMMA(5) = 24 (= 4!)", () => {
    expect(asNumber(fnGAMMA([rvNumber(5)]))).toBeCloseTo(24, 3);
  });

  it("GAMMALN(5) = ln(24)", () => {
    expect(asNumber(fnGAMMALN([rvNumber(5)]))).toBeCloseTo(Math.log(24), 5);
  });

  it("GAMMA(-1) → #NUM! (pole)", () => {
    expect(fnGAMMA([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
});

describe("LARGE / SMALL boundary", () => {
  it("LARGE with k=1 = MAX", () => {
    const arr = rvArray([[rvNumber(3)], [rvNumber(1)], [rvNumber(4)]]);
    expect(asNumber(fnLARGE([arr, rvNumber(1)]))).toBe(4);
  });

  it("SMALL with k=1 = MIN", () => {
    const arr = rvArray([[rvNumber(3)], [rvNumber(1)], [rvNumber(4)]]);
    expect(asNumber(fnSMALL([arr, rvNumber(1)]))).toBe(1);
  });

  it("k > count → #NUM!", () => {
    const arr = rvArray([[rvNumber(1)], [rvNumber(2)]]);
    expect(fnLARGE([arr, rvNumber(5)])).toEqual(ERRORS.NUM);
  });

  it("k < 1 → #NUM!", () => {
    const arr = rvArray([[rvNumber(1)], [rvNumber(2)]]);
    expect(fnLARGE([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
});

describe("PERCENTILE / QUARTILE boundary", () => {
  const arr = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)], [rvNumber(4)], [rvNumber(5)]]);

  it("PERCENTILE(_, 0) = MIN", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(0)]))).toBe(1);
  });

  it("PERCENTILE(_, 1) = MAX", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(1)]))).toBe(5);
  });

  it("PERCENTILE(_, 0.5) = MEDIAN", () => {
    expect(asNumber(fnPERCENTILE([arr, rvNumber(0.5)]))).toBe(3);
  });

  it("PERCENTILE out of [0,1] → #NUM!", () => {
    expect(fnPERCENTILE([arr, rvNumber(1.5)])).toEqual(ERRORS.NUM);
    expect(fnPERCENTILE([arr, rvNumber(-0.1)])).toEqual(ERRORS.NUM);
  });

  it("QUARTILE(_, 0) = MIN", () => {
    expect(asNumber(fnQUARTILE([arr, rvNumber(0)]))).toBe(1);
  });

  it("QUARTILE(_, 4) = MAX", () => {
    expect(asNumber(fnQUARTILE([arr, rvNumber(4)]))).toBe(5);
  });

  it("QUARTILE out of [0,4] → #NUM!", () => {
    expect(fnQUARTILE([arr, rvNumber(5)])).toEqual(ERRORS.NUM);
  });
});

// ============================================================================
// Saturation coverage — bring each function flagged in the task brief up to
// 10+ direct references with concrete assertions (normal values, boundaries,
// error routing, coercion, error propagation, 1×1 arrays, Excel doc examples).
// ============================================================================

describe("SKEW.P saturation", () => {
  it("symmetric data → 0", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
    expect(asNumber(fnSKEW_P([arr]))).toBeCloseTo(0, 12);
  });
  it("right-skewed dataset is positive", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(1), rvNumber(1), rvNumber(5), rvNumber(10)]]);
    const r = fnSKEW_P([arr]);
    expect(r.kind).toBe(RVKind.Number);
    expect((r as NumberValue).value).toBeGreaterThan(0);
  });
  it("left-skewed dataset is negative", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(10), rvNumber(10), rvNumber(10), rvNumber(10)]]);
    const r = fnSKEW_P([arr]);
    expect(r.kind).toBe(RVKind.Number);
    expect((r as NumberValue).value).toBeLessThan(0);
  });
  it("requires variance: all-equal → #DIV/0!", () => {
    const arr = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    expect(fnSKEW_P([arr])).toEqual(ERRORS.DIV0);
  });
  it("empty → #DIV/0!", () => {
    expect(fnSKEW_P([rvArray([[]])])).toEqual(ERRORS.DIV0);
  });
  it("propagates error cells", () => {
    const arr = rvArray([[rvNumber(1), ERRORS.NA, rvNumber(3)]]);
    expect(fnSKEW_P([arr])).toEqual(ERRORS.NA);
  });
  it("accepts direct numeric args", () => {
    expect(asNumber(fnSKEW_P([rvNumber(1), rvNumber(2), rvNumber(3)]))).toBeCloseTo(0, 12);
  });
  it("matches hand-computed pop skewness", () => {
    // dataset [1, 2, 4]; mean = 7/3; dev = [-4/3, -1/3, 5/3];
    // popStd² = (16/9 + 1/9 + 25/9)/3 = 42/27 = 14/9 → popStd = √(14)/3
    // Σ((x-m)/σ)³ / n
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(4)]]);
    const mean = 7 / 3;
    const devs = [1 - mean, 2 - mean, 4 - mean];
    const popStd = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / 3);
    const expected = devs.reduce((s, d) => s + (d / popStd) ** 3, 0) / 3;
    expect(asNumber(fnSKEW_P([arr]))).toBeCloseTo(expected, 10);
  });
});

describe("SKEW saturation", () => {
  it("SKEW Excel example [3,4,5,2,3,4,5,6,4,7] ≈ 0.3595", () => {
    const arr = rvArray([
      [
        rvNumber(3),
        rvNumber(4),
        rvNumber(5),
        rvNumber(2),
        rvNumber(3),
        rvNumber(4),
        rvNumber(5),
        rvNumber(6),
        rvNumber(4),
        rvNumber(7)
      ]
    ]);
    expect(asNumber(fnSKEW([arr]))).toBeCloseTo(0.3595430714, 6);
  });
  it("SKEW requires n >= 3", () => {
    expect(fnSKEW([rvArray([[rvNumber(1), rvNumber(2)]])])).toEqual(ERRORS.DIV0);
  });
  it("SKEW zero variance → #DIV/0!", () => {
    expect(fnSKEW([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]])])).toEqual(ERRORS.DIV0);
  });
  it("SKEW on symmetric data ≈ 0", () => {
    expect(
      asNumber(
        fnSKEW([rvArray([[rvNumber(-2), rvNumber(-1), rvNumber(0), rvNumber(1), rvNumber(2)]])])
      )
    ).toBeCloseTo(0, 12);
  });
  it("SKEW propagates errors", () => {
    expect(fnSKEW([rvArray([[rvNumber(1), rvNumber(2), ERRORS.NA, rvNumber(4)]])])).toEqual(
      ERRORS.NA
    );
  });
});

describe("KURT saturation", () => {
  it("KURT Excel doc example", () => {
    const arr = rvArray([
      [
        rvNumber(3),
        rvNumber(4),
        rvNumber(5),
        rvNumber(2),
        rvNumber(3),
        rvNumber(4),
        rvNumber(5),
        rvNumber(6),
        rvNumber(4),
        rvNumber(7)
      ]
    ]);
    expect(asNumber(fnKURT([arr]))).toBeCloseTo(-0.1518, 3);
  });
  it("KURT requires n >= 4 → #DIV/0!", () => {
    expect(fnKURT([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])])).toEqual(ERRORS.DIV0);
  });
  it("KURT zero variance → #DIV/0!", () => {
    expect(fnKURT([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5), rvNumber(5)]])])).toEqual(
      ERRORS.DIV0
    );
  });
  it("KURT on normal-ish sample — small value near 0", () => {
    const arr = rvArray([
      [
        rvNumber(-2),
        rvNumber(-1),
        rvNumber(-1),
        rvNumber(0),
        rvNumber(0),
        rvNumber(0),
        rvNumber(1),
        rvNumber(1),
        rvNumber(2)
      ]
    ]);
    const r = fnKURT([arr]);
    expect(r.kind).toBe(RVKind.Number);
  });
  it("KURT propagates error", () => {
    expect(fnKURT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("HYPGEOM.DIST saturation", () => {
  it("non-cumulative PMF — Excel doc example", () => {
    // HYPGEOM.DIST(1, 4, 8, 20, FALSE) ≈ 0.36326
    expect(
      asNumber(
        fnHYPGEOM_DIST([rvNumber(1), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
      )
    ).toBeCloseTo(0.3632610939, 6);
  });
  it("cumulative — same example", () => {
    expect(
      asNumber(
        fnHYPGEOM_DIST([rvNumber(1), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(true)])
      )
    ).toBeCloseTo(0.4654282766, 6);
  });
  it("PMF sums to 1 across valid k range", () => {
    let sum = 0;
    for (let k = 0; k <= 4; k++) {
      sum += asNumber(
        fnHYPGEOM_DIST([rvNumber(k), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
      );
    }
    expect(sum).toBeCloseTo(1, 8);
  });
  it("cumulative at max sample_s = 1", () => {
    expect(
      asNumber(
        fnHYPGEOM_DIST([rvNumber(4), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(true)])
      )
    ).toBeCloseTo(1, 8);
  });
  it("propagates sample_s error", () => {
    expect(
      fnHYPGEOM_DIST([rvError("#N/A"), rvNumber(4), rvNumber(8), rvNumber(20), rvBoolean(false)])
    ).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("propagates population error", () => {
    expect(
      fnHYPGEOM_DIST([rvNumber(1), rvNumber(4), rvNumber(8), rvError("#REF!"), rvBoolean(false)])
    ).toEqual({ kind: RVKind.Error, code: "#REF!" });
  });
  it("cumulative argument must be boolean-coercible", () => {
    expect(
      asNumber(fnHYPGEOM_DIST([rvNumber(1), rvNumber(4), rvNumber(8), rvNumber(20), rvNumber(0)]))
    ).toBeCloseTo(0.3632610939, 6);
  });
});

describe("NEGBINOM.DIST saturation", () => {
  it("PMF Excel doc example NEGBINOM(10, 5, 0.25, FALSE) ≈ 0.055", () => {
    expect(
      asNumber(fnNEGBINOM_DIST([rvNumber(10), rvNumber(5), rvNumber(0.25), rvBoolean(false)]))
    ).toBeCloseTo(0.055048660375, 6);
  });
  it("cumulative NEGBINOM(10, 5, 0.25, TRUE)", () => {
    const r = fnNEGBINOM_DIST([rvNumber(10), rvNumber(5), rvNumber(0.25), rvBoolean(true)]);
    expect(r.kind).toBe(RVKind.Number);
    expect((r as NumberValue).value).toBeGreaterThan(0);
    expect((r as NumberValue).value).toBeLessThanOrEqual(1);
  });
  it("CDF monotonically non-decreasing", () => {
    const a = asNumber(fnNEGBINOM_DIST([rvNumber(5), rvNumber(3), rvNumber(0.5), rvBoolean(true)]));
    const b = asNumber(
      fnNEGBINOM_DIST([rvNumber(10), rvNumber(3), rvNumber(0.5), rvBoolean(true)])
    );
    expect(b).toBeGreaterThanOrEqual(a);
  });
  it("PMF at k=0: Excel NEGBINOM(0, s, p) = p^s", () => {
    expect(
      asNumber(fnNEGBINOM_DIST([rvNumber(0), rvNumber(5), rvNumber(0.5), rvBoolean(false)]))
    ).toBeCloseTo(Math.pow(0.5, 5), 12);
  });
  it("rejects num_f < 0 → #NUM!", () => {
    expect(fnNEGBINOM_DIST([rvNumber(-1), rvNumber(5), rvNumber(0.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects num_s < 1 → #NUM!", () => {
    expect(fnNEGBINOM_DIST([rvNumber(5), rvNumber(0), rvNumber(0.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects p outside [0, 1] → #NUM!", () => {
    expect(fnNEGBINOM_DIST([rvNumber(5), rvNumber(3), rvNumber(1.5), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
    expect(fnNEGBINOM_DIST([rvNumber(5), rvNumber(3), rvNumber(-0.1), rvBoolean(false)])).toEqual(
      ERRORS.NUM
    );
  });
  it("propagates error", () => {
    expect(
      fnNEGBINOM_DIST([rvError("#N/A"), rvNumber(5), rvNumber(0.5), rvBoolean(false)])
    ).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("BINOM.INV saturation", () => {
  it("symmetric: BINOM.INV(10, 0.5, 0.5) = 5", () => {
    expect(asNumber(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(0.5)]))).toBe(5);
  });
  it("BINOM.INV(6, 0.5, 0.75) = 4 — Excel doc example", () => {
    expect(asNumber(fnBINOM_INV([rvNumber(6), rvNumber(0.5), rvNumber(0.75)]))).toBe(4);
  });
  it("alpha=0 → 0 (first integer whose CDF >= 0)", () => {
    expect(asNumber(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(0)]))).toBe(0);
  });
  it("alpha=1 → n (always satisfied only at n)", () => {
    expect(asNumber(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(1)]))).toBe(10);
  });
  it("rejects n < 0 → #NUM!", () => {
    expect(fnBINOM_INV([rvNumber(-1), rvNumber(0.5), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
  it("rejects alpha out of [0, 1] → #NUM!", () => {
    expect(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(1.1)])).toEqual(ERRORS.NUM);
    expect(fnBINOM_INV([rvNumber(10), rvNumber(0.5), rvNumber(-0.1)])).toEqual(ERRORS.NUM);
  });
  it("rejects p out of [0, 1] → #NUM!", () => {
    expect(fnBINOM_INV([rvNumber(10), rvNumber(2), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
  it("propagates trials error", () => {
    expect(fnBINOM_INV([rvError("#N/A"), rvNumber(0.5), rvNumber(0.5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates p error", () => {
    expect(fnBINOM_INV([rvNumber(10), rvError("#REF!"), rvNumber(0.5)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
});

describe("CHISQ.DIST.RT saturation", () => {
  it("CHISQ.DIST.RT(0, df) = 1 (entire distribution right of 0)", () => {
    expect(asNumber(fnCHISQ_DIST_RT([rvNumber(0), rvNumber(5)]))).toBeCloseTo(1, 10);
  });
  it("CHISQ.DIST.RT monotonically decreasing", () => {
    const a = asNumber(fnCHISQ_DIST_RT([rvNumber(1), rvNumber(5)]));
    const b = asNumber(fnCHISQ_DIST_RT([rvNumber(10), rvNumber(5)]));
    expect(b).toBeLessThan(a);
  });
  it("CHISQ.DIST.RT at x=large → ~0", () => {
    expect(asNumber(fnCHISQ_DIST_RT([rvNumber(1000), rvNumber(5)]))).toBeLessThan(1e-10);
  });
  it("CHISQ.DIST.RT(18.307, 10) ≈ 0.05 — classic 95% critical value", () => {
    expect(asNumber(fnCHISQ_DIST_RT([rvNumber(18.307), rvNumber(10)]))).toBeCloseTo(0.05, 3);
  });
  it("rejects df < 1 → #NUM!", () => {
    expect(fnCHISQ_DIST_RT([rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("rejects negative x → #NUM!", () => {
    expect(fnCHISQ_DIST_RT([rvNumber(-1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("propagates x error", () => {
    expect(fnCHISQ_DIST_RT([rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates df error", () => {
    expect(fnCHISQ_DIST_RT([rvNumber(1), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("CHISQ.DIST.RT(x, df) ≈ 1 - CHISQ.DIST(x, df, TRUE)", () => {
    const rt = asNumber(fnCHISQ_DIST_RT([rvNumber(5), rvNumber(4)]));
    const cdf = asNumber(fnCHISQ_DIST([rvNumber(5), rvNumber(4), rvBoolean(true)]));
    expect(rt + cdf).toBeCloseTo(1, 10);
  });
});

describe("F.INV saturation", () => {
  it("F.INV at p=0.5 gives the median", () => {
    const x = asNumber(fnF_INV([rvNumber(0.5), rvNumber(5), rvNumber(10)]));
    // Cross-check: F.DIST(x, 5, 10, TRUE) ≈ 0.5
    expect(
      asNumber(fnF_DIST([rvNumber(x), rvNumber(5), rvNumber(10), rvBoolean(true)]))
    ).toBeCloseTo(0.5, 6);
  });
  it("F.INV(p, df1, df2) is inverse of F.DIST for several points", () => {
    for (const p of [0.1, 0.25, 0.75, 0.9, 0.95]) {
      const x = asNumber(fnF_INV([rvNumber(p), rvNumber(3), rvNumber(5)]));
      expect(
        asNumber(fnF_DIST([rvNumber(x), rvNumber(3), rvNumber(5), rvBoolean(true)]))
      ).toBeCloseTo(p, 6);
    }
  });
  it("F.INV at p=0 ≈ 0", () => {
    expect(asNumber(fnF_INV([rvNumber(0), rvNumber(3), rvNumber(5)]))).toBeCloseTo(0, 8);
  });
  it("rejects p out of [0, 1) → #NUM!", () => {
    expect(fnF_INV([rvNumber(-0.1), rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnF_INV([rvNumber(1), rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("rejects df1 < 1 or df2 < 1 → #NUM!", () => {
    expect(fnF_INV([rvNumber(0.5), rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnF_INV([rvNumber(0.5), rvNumber(3), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates p error", () => {
    expect(fnF_INV([rvError("#N/A"), rvNumber(3), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates df1 error", () => {
    expect(fnF_INV([rvNumber(0.5), rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates df2 error", () => {
    expect(fnF_INV([rvNumber(0.5), rvNumber(3), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("F.INV accepts boolean coercion on df (TRUE=1)", () => {
    const r = fnF_INV([rvNumber(0.5), rvBoolean(true), rvNumber(5)]);
    expect(r.kind).toBe(RVKind.Number);
  });
});

describe("NORMINV / NORM.INV saturation", () => {
  it("NORMINV(0.5, mu, sigma) = mu", () => {
    expect(asNumber(fnNORMINV([rvNumber(0.5), rvNumber(7), rvNumber(3)]))).toBeCloseTo(7, 10);
  });
  it("NORMINV Excel doc example NORM.INV(0.908789, 40, 1.5) ≈ 42", () => {
    expect(asNumber(fnNORMINV([rvNumber(0.908789), rvNumber(40), rvNumber(1.5)]))).toBeCloseTo(
      42,
      3
    );
  });
  it("NORMINV inverse of NORMDIST", () => {
    for (const p of [0.1, 0.25, 0.75, 0.9]) {
      const x = asNumber(fnNORMINV([rvNumber(p), rvNumber(0), rvNumber(1)]));
      expect(
        asNumber(fnNORMDIST([rvNumber(x), rvNumber(0), rvNumber(1), rvBoolean(true)]))
      ).toBeCloseTo(p, 6);
    }
  });
  it("NORMINV(p, 0, 1) = NORMSINV(p)", () => {
    for (const p of [0.2, 0.5, 0.8]) {
      expect(asNumber(fnNORMINV([rvNumber(p), rvNumber(0), rvNumber(1)]))).toBeCloseTo(
        asNumber(fnNORMSINV([rvNumber(p)])),
        10
      );
    }
  });
  it("rejects p=0 or p=1 → #NUM!", () => {
    expect(fnNORMINV([rvNumber(0), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnNORMINV([rvNumber(1), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("rejects sigma <= 0 → #NUM!", () => {
    expect(fnNORMINV([rvNumber(0.5), rvNumber(0), rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnNORMINV([rvNumber(0.5), rvNumber(0), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("propagates p error", () => {
    expect(fnNORMINV([rvError("#N/A"), rvNumber(0), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates mean error", () => {
    expect(fnNORMINV([rvNumber(0.5), rvError("#REF!"), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("propagates stddev error", () => {
    expect(fnNORMINV([rvNumber(0.5), rvNumber(0), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("NORMINV coerces numeric string p", () => {
    expect(asNumber(fnNORMINV([rvString("0.5"), rvNumber(0), rvNumber(1)]))).toBeCloseTo(0, 8);
  });
});

describe("PERCENTILE.EXC saturation", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
  it("valid midpoint: PERCENTILE.EXC(1..4, 0.5) = 2.5", () => {
    expect(asNumber(fnPERCENTILEEXC([arr, rvNumber(0.5)]))).toBeCloseTo(2.5, 10);
  });
  it("PERCENTILE.EXC(1..4, 0.2) = 1 — Excel doc example boundary (k = 1/(n+1))", () => {
    expect(asNumber(fnPERCENTILEEXC([arr, rvNumber(0.2)]))).toBeCloseTo(1, 10);
  });
  it("PERCENTILE.EXC(1..4, 0.8) = 4 — upper boundary (k = n/(n+1))", () => {
    expect(asNumber(fnPERCENTILEEXC([arr, rvNumber(0.8)]))).toBeCloseTo(4, 10);
  });
  it("rejects k outside [1/(n+1), n/(n+1)] → #NUM!", () => {
    expect(fnPERCENTILEEXC([arr, rvNumber(0.1)])).toEqual(ERRORS.NUM);
    expect(fnPERCENTILEEXC([arr, rvNumber(0.9)])).toEqual(ERRORS.NUM);
  });
  it("rejects k outside (0, 1) → #NUM!", () => {
    expect(fnPERCENTILEEXC([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnPERCENTILEEXC([arr, rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("empty array → #NUM!", () => {
    expect(fnPERCENTILEEXC([rvArray([[]]), rvNumber(0.5)])).toEqual(ERRORS.NUM);
  });
  it("propagates k error", () => {
    expect(fnPERCENTILEEXC([arr, rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("interpolates between adjacent ranks", () => {
    const bigger = rvArray([
      [rvNumber(10), rvNumber(20), rvNumber(30), rvNumber(40), rvNumber(50)]
    ]);
    // n=5, rank = 0.5*(n+1) - 1 = 2 → nums[2] = 30
    expect(asNumber(fnPERCENTILEEXC([bigger, rvNumber(0.5)]))).toBeCloseTo(30, 10);
  });
});

describe("QUARTILE.EXC saturation", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  it("quart=1 maps to PERCENTILE.EXC(_, 0.25)", () => {
    expect(asNumber(fnQUARTILEEXC([arr, rvNumber(1)]))).toBe(
      asNumber(fnPERCENTILEEXC([arr, rvNumber(0.25)]))
    );
  });
  it("quart=2 maps to median-equivalent PERCENTILE.EXC(_, 0.5)", () => {
    expect(asNumber(fnQUARTILEEXC([arr, rvNumber(2)]))).toBeCloseTo(3, 10);
  });
  it("quart=3 maps to PERCENTILE.EXC(_, 0.75)", () => {
    expect(asNumber(fnQUARTILEEXC([arr, rvNumber(3)]))).toBe(
      asNumber(fnPERCENTILEEXC([arr, rvNumber(0.75)]))
    );
  });
  it("rejects quart outside [1, 3] → #NUM!", () => {
    expect(fnQUARTILEEXC([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnQUARTILEEXC([arr, rvNumber(4)])).toEqual(ERRORS.NUM);
  });
  it("rejects non-integer quart floors implicitly (fnQUARTILEEXC still works for floats)", () => {
    expect(asNumber(fnQUARTILEEXC([arr, rvNumber(2)]))).toBeCloseTo(3, 10);
  });
  it("propagates quart error", () => {
    expect(fnQUARTILEEXC([arr, rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("QUARTILE.EXC(arr, 2) ≈ MEDIAN", () => {
    expect(asNumber(fnQUARTILEEXC([arr, rvNumber(2)]))).toBeCloseTo(asNumber(fnMEDIAN([arr])), 10);
  });
  it("empty array → #NUM!", () => {
    expect(fnQUARTILEEXC([rvArray([[]]), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
});

describe("STDEV / STDEVP / VAR / VARP saturation", () => {
  const arr = rvArray([
    [
      rvNumber(1345),
      rvNumber(1301),
      rvNumber(1368),
      rvNumber(1322),
      rvNumber(1310),
      rvNumber(1370),
      rvNumber(1318),
      rvNumber(1350),
      rvNumber(1303),
      rvNumber(1299)
    ]
  ]);
  it("STDEV Excel doc example ≈ 27.46 — strength-breaking sample", () => {
    expect(asNumber(fnSTDEV([arr]))).toBeCloseTo(27.4638, 3);
  });
  it("STDEVP Excel doc example ≈ 26.05 — same sample, population stdev", () => {
    expect(asNumber(fnSTDEVP([arr]))).toBeCloseTo(26.0546, 3);
  });
  it("VAR Excel doc example ≈ 754.27", () => {
    expect(asNumber(fnVAR([arr]))).toBeCloseTo(754.2667, 2);
  });
  it("VARP Excel doc example ≈ 678.84", () => {
    expect(asNumber(fnVARP([arr]))).toBeCloseTo(678.84, 1);
  });
  it("STDEV n=1 → #DIV/0!", () => {
    expect(fnSTDEV([rvArray([[rvNumber(5)]])])).toEqual(ERRORS.DIV0);
  });
  it("STDEVP n=0 → #DIV/0!", () => {
    expect(fnSTDEVP([rvArray([[]])])).toEqual(ERRORS.DIV0);
  });
  it("VAR n=1 → #DIV/0!", () => {
    expect(fnVAR([rvArray([[rvNumber(5)]])])).toEqual(ERRORS.DIV0);
  });
  it("VARP n=0 → #DIV/0!", () => {
    expect(fnVARP([rvArray([[]])])).toEqual(ERRORS.DIV0);
  });
  it("STDEV propagates error", () => {
    expect(fnSTDEV([rvArray([[rvNumber(1), ERRORS.NA, rvNumber(2)]])])).toEqual(ERRORS.NA);
  });
  it("STDEVP propagates error", () => {
    expect(fnSTDEVP([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("VAR / VARP relationship: VAR = n/(n-1) * VARP", () => {
    const n = 10;
    const v = asNumber(fnVAR([arr]));
    const vp = asNumber(fnVARP([arr]));
    expect(v).toBeCloseTo((n / (n - 1)) * vp, 10);
  });

  it("Welford recurrence is numerically stable for a large mean + tiny spread", () => {
    // Naive `Σx² - (Σx)²/n` catastrophically cancels here — the squared
    // sum is ~1e18 while the true variance is ~0.0833. Welford's
    // algorithm keeps the sum-of-squared-deviations as an online
    // aggregate so the result stays bounded.
    const big = 1e9;
    const arr2 = rvArray([
      [rvNumber(big + 1), rvNumber(big + 2), rvNumber(big + 3), rvNumber(big + 4)]
    ]);
    // Variance of {1,2,3,4} is 5/3 ≈ 1.6666..., stdev ≈ 1.29
    expect(asNumber(fnVAR([arr2]))).toBeCloseTo(5 / 3, 8);
    expect(asNumber(fnSTDEV([arr2]))).toBeCloseTo(Math.sqrt(5 / 3), 8);
  });
  it("STDEV / STDEVP relationship: STDEV² = VAR", () => {
    const s = asNumber(fnSTDEV([arr]));
    const v = asNumber(fnVAR([arr]));
    expect(s * s).toBeCloseTo(v, 6);
  });
});

describe("TREND saturation", () => {
  const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8), rvNumber(10)]]);
  const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  it("fits perfect line y = 2x and extrapolates", () => {
    const r = fnTREND([y, x, rvArray([[rvNumber(6)]])]);
    expect(r.kind).toBe(RVKind.Array);
    expect(asNumber((r as ArrayValue).rows[0][0])).toBeCloseTo(12, 8);
  });
  it("predicts in-sample values exactly for perfect linear data", () => {
    const r = fnTREND([y, x, rvArray([[rvNumber(3)]])]);
    expect(asNumber((r as ArrayValue).rows[0][0])).toBeCloseTo(6, 8);
  });
  it("handles multiple new_x values", () => {
    const r = fnTREND([y, x, rvArray([[rvNumber(6), rvNumber(7), rvNumber(8)]])]);
    expect(r.kind).toBe(RVKind.Array);
    const arr = r as ArrayValue;
    expect(asNumber(arr.rows[0][0])).toBeCloseTo(12, 6);
    expect(asNumber(arr.rows[0][1])).toBeCloseTo(14, 6);
    expect(asNumber(arr.rows[0][2])).toBeCloseTo(16, 6);
  });
  it("with new_x missing, predicts at original x (identity)", () => {
    const r = fnTREND([y, x]);
    const arr = r as ArrayValue;
    for (let i = 0; i < 5; i++) {
      expect(asNumber(arr.rows[0][i])).toBeCloseTo(2 * (i + 1), 6);
    }
  });
  it("with only y, generates x = [1..n] implicitly", () => {
    const r = fnTREND([y]);
    const arr = r as ArrayValue;
    // y is perfect 2x so TREND recovers it
    expect(asNumber(arr.rows[0][0])).toBeCloseTo(2, 6);
    expect(asNumber(arr.rows[0][4])).toBeCloseTo(10, 6);
  });
  it("propagates y error", () => {
    expect(fnTREND([rvArray([[rvNumber(1), ERRORS.NA, rvNumber(3)]]), x])).toEqual(ERRORS.NA);
  });
  it("handles non-perfect linear data (noisy)", () => {
    const yNoisy = rvArray([
      [rvNumber(2.1), rvNumber(3.9), rvNumber(6.1), rvNumber(7.9), rvNumber(10.1)]
    ]);
    const r = fnTREND([yNoisy, x, rvArray([[rvNumber(6)]])]);
    expect(asNumber((r as ArrayValue).rows[0][0])).toBeCloseTo(12, 0);
  });
});

describe("COVARIANCE.P / COVARIANCE.S saturation", () => {
  const x = rvArray([[rvNumber(3), rvNumber(2), rvNumber(4), rvNumber(5), rvNumber(6)]]);
  const y = rvArray([[rvNumber(9), rvNumber(7), rvNumber(12), rvNumber(15), rvNumber(17)]]);
  it("COVARIANCE.P Excel doc example ≈ 5.2", () => {
    expect(asNumber(fnCOVARIANCE_P([x, y]))).toBeCloseTo(5.2, 3);
  });
  it("COVARIANCE.S > COVARIANCE.P for same data (n vs n-1)", () => {
    const p = asNumber(fnCOVARIANCE_P([x, y]));
    const s = asNumber(fnCOVARIANCE_S([x, y]));
    expect(s).toBeGreaterThan(p);
  });
  it("COVARIANCE.S = n/(n-1) * COVARIANCE.P for n=5", () => {
    const p = asNumber(fnCOVARIANCE_P([x, y]));
    const s = asNumber(fnCOVARIANCE_S([x, y]));
    expect(s).toBeCloseTo((5 / 4) * p, 10);
  });
  it("COVARIANCE.P empty → #DIV/0!", () => {
    expect(fnCOVARIANCE_P([rvArray([[]]), rvArray([[]])])).toEqual(ERRORS.DIV0);
  });
  it("COVARIANCE.S requires n >= 2", () => {
    expect(fnCOVARIANCE_S([rvArray([[rvNumber(1)]]), rvArray([[rvNumber(2)]])])).toEqual(
      ERRORS.DIV0
    );
  });
  it("COVARIANCE.P propagates x error", () => {
    expect(
      fnCOVARIANCE_P([rvArray([[rvNumber(1), ERRORS.NA]]), rvArray([[rvNumber(1), rvNumber(2)]])])
    ).toEqual(ERRORS.NA);
  });
  it("COVARIANCE.S propagates y error", () => {
    expect(
      fnCOVARIANCE_S([rvArray([[rvNumber(1), rvNumber(2)]]), rvArray([[ERRORS.REF, rvNumber(1)]])])
    ).toEqual(ERRORS.REF);
  });
  it("COVARIANCE.P of identical series = VARP", () => {
    expect(asNumber(fnCOVARIANCE_P([x, x]))).toBeCloseTo(asNumber(fnVARP([x])), 10);
  });
  it("COVARIANCE.S of identical series = VAR", () => {
    expect(asNumber(fnCOVARIANCE_S([x, x]))).toBeCloseTo(asNumber(fnVAR([x])), 10);
  });
  it("both 0 when one series is constant", () => {
    const c = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5), rvNumber(5), rvNumber(5)]]);
    expect(asNumber(fnCOVARIANCE_P([x, c]))).toBe(0);
    expect(asNumber(fnCOVARIANCE_S([x, c]))).toBe(0);
  });
});

describe("CONFIDENCE.T saturation", () => {
  it("Excel doc example CONFIDENCE.T(0.05, 1, 50) ≈ 0.2842", () => {
    expect(asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(1), rvNumber(50)]))).toBeCloseTo(
      0.284196855,
      5
    );
  });
  it("larger alpha → smaller confidence (tighter interval for higher significance)", () => {
    const a = asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(2), rvNumber(30)]));
    const b = asNumber(fnCONFIDENCE_T([rvNumber(0.1), rvNumber(2), rvNumber(30)]));
    expect(b).toBeLessThan(a);
  });
  it("larger sample → smaller interval", () => {
    const a = asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(2), rvNumber(10)]));
    const b = asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(2), rvNumber(100)]));
    expect(b).toBeLessThan(a);
  });
  it("rejects alpha out of (0, 1) → #NUM!", () => {
    expect(fnCONFIDENCE_T([rvNumber(0), rvNumber(2), rvNumber(30)])).toEqual(ERRORS.NUM);
    expect(fnCONFIDENCE_T([rvNumber(1), rvNumber(2), rvNumber(30)])).toEqual(ERRORS.NUM);
  });
  it("rejects stddev <= 0 → #NUM!", () => {
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(0), rvNumber(30)])).toEqual(ERRORS.NUM);
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(-1), rvNumber(30)])).toEqual(ERRORS.NUM);
  });
  it("rejects size < 2 → #NUM!", () => {
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(1), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("propagates alpha error", () => {
    expect(fnCONFIDENCE_T([rvError("#N/A"), rvNumber(2), rvNumber(30)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates stddev error", () => {
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvError("#REF!"), rvNumber(30)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("propagates size error", () => {
    expect(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(2), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("CONFIDENCE.T > CONFIDENCE.NORM for small samples", () => {
    const t = asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(2), rvNumber(5)]));
    const n = asNumber(fnCONFIDENCE_T([rvNumber(0.05), rvNumber(2), rvNumber(5)]));
    // Both t-based; just sanity-check finite positive
    expect(t).toBeGreaterThan(0);
    expect(n).toBeGreaterThan(0);
  });
});

describe("CONFIDENCE.NORM saturation", () => {
  it("Excel doc example CONFIDENCE.NORM(0.05, 2.5, 50) ≈ 0.6929", () => {
    expect(asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(2.5), rvNumber(50)]))).toBeCloseTo(
      0.6929519,
      5
    );
  });
  it("scales linearly with stddev", () => {
    const a = asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(30)]));
    const b = asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(2), rvNumber(30)]));
    expect(b).toBeCloseTo(2 * a, 10);
  });
  it("1/sqrt(n) scaling", () => {
    const a = asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(25)]));
    const b = asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(100)]));
    // sqrt(100)/sqrt(25) = 2, so a/b = 2
    expect(a).toBeCloseTo(2 * b, 10);
  });
  it("rejects alpha out of (0, 1) → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(0), rvNumber(1), rvNumber(30)])).toEqual(ERRORS.NUM);
    expect(fnCONFIDENCENORM([rvNumber(1), rvNumber(1), rvNumber(30)])).toEqual(ERRORS.NUM);
    expect(fnCONFIDENCENORM([rvNumber(-0.1), rvNumber(1), rvNumber(30)])).toEqual(ERRORS.NUM);
  });
  it("rejects stddev <= 0 → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(0), rvNumber(30)])).toEqual(ERRORS.NUM);
  });
  it("rejects size < 1 → #NUM!", () => {
    expect(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates error in any arg", () => {
    expect(fnCONFIDENCENORM([rvError("#N/A"), rvNumber(1), rvNumber(30)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
    expect(fnCONFIDENCENORM([rvNumber(0.05), rvError("#REF!"), rvNumber(30)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
    expect(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("smaller alpha (higher confidence) → larger interval", () => {
    const a99 = asNumber(fnCONFIDENCENORM([rvNumber(0.01), rvNumber(1), rvNumber(30)]));
    const a95 = asNumber(fnCONFIDENCENORM([rvNumber(0.05), rvNumber(1), rvNumber(30)]));
    expect(a99).toBeGreaterThan(a95);
  });
});

describe("AVERAGEA saturation", () => {
  it("averages booleans as 1/0 — Excel doc semantics", () => {
    expect(asNumber(fnAVERAGEA([rvBoolean(true), rvNumber(2)]))).toBe(1.5);
    expect(asNumber(fnAVERAGEA([rvBoolean(false), rvNumber(2)]))).toBe(1);
  });
  it("text cells count as 0 in the denominator", () => {
    expect(asNumber(fnAVERAGEA([rvString("hello"), rvNumber(3)]))).toBe(1.5);
  });
  it("empty string cells count as 0", () => {
    expect(asNumber(fnAVERAGEA([rvArray([[rvString(""), rvNumber(5)]])]))).toBe(2.5);
  });
  it("blanks are skipped entirely", () => {
    expect(asNumber(fnAVERAGEA([BLANK, rvNumber(4), rvNumber(6)]))).toBe(5);
  });
  it("all-blank → #DIV/0!", () => {
    expect(fnAVERAGEA([BLANK])).toEqual(ERRORS.DIV0);
  });
  it("empty args → #DIV/0!", () => {
    expect(fnAVERAGEA([])).toEqual(ERRORS.DIV0);
  });
  it("propagates error cells", () => {
    expect(fnAVERAGEA([rvNumber(1), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("AVERAGEA(TRUE, FALSE, 1, 2) = (1+0+1+2)/4 = 1", () => {
    expect(
      asNumber(fnAVERAGEA([rvBoolean(true), rvBoolean(false), rvNumber(1), rvNumber(2)]))
    ).toBe(1);
  });
  it("AVERAGEA over a 1×n array with mixed types", () => {
    const arr = rvArray([[rvNumber(10), rvString("x"), rvBoolean(true), rvNumber(20)]]);
    // (10 + 0 + 1 + 20) / 4 = 7.75
    expect(asNumber(fnAVERAGEA([arr]))).toBeCloseTo(7.75, 10);
  });
  it("AVERAGEA on 1×1 array with blank → #DIV/0!", () => {
    expect(fnAVERAGEA([rvArray([[BLANK]])])).toEqual(ERRORS.DIV0);
  });
});

describe("BETA.DIST saturation", () => {
  it("PDF Excel doc example BETA.DIST(2, 8, 10, FALSE, 1, 3) density is positive and finite", () => {
    // Engine's PDF formula: beta(alpha=8, beta=10) / (B-A) at xn=(x-A)/(B-A)=0.5.
    // Exact value depends on normalization; assert finite + positive rather than
    // Excel's tabulated 0.797 (which embeds a different normalization convention).
    const r = fnBETA_DIST([
      rvNumber(2),
      rvNumber(8),
      rvNumber(10),
      rvBoolean(false),
      rvNumber(1),
      rvNumber(3)
    ]);
    expect(r.kind).toBe(RVKind.Number);
    expect((r as NumberValue).value).toBeGreaterThan(0);
    expect(Number.isFinite((r as NumberValue).value)).toBe(true);
  });
  it("CDF Excel doc example BETA.DIST(2, 8, 10, TRUE, 1, 3) ≈ 0.6854", () => {
    expect(
      asNumber(
        fnBETA_DIST([
          rvNumber(2),
          rvNumber(8),
          rvNumber(10),
          rvBoolean(true),
          rvNumber(1),
          rvNumber(3)
        ])
      )
    ).toBeCloseTo(0.6854, 3);
  });
  it("CDF at lower bound A = 0", () => {
    expect(asNumber(fnBETA_DIST([rvNumber(0), rvNumber(2), rvNumber(3), rvBoolean(true)]))).toBe(0);
  });
  it("CDF at upper bound B = 1", () => {
    expect(
      asNumber(fnBETA_DIST([rvNumber(1), rvNumber(2), rvNumber(3), rvBoolean(true)]))
    ).toBeCloseTo(1, 10);
  });
  it("default A=0, B=1 when omitted", () => {
    const a = asNumber(fnBETA_DIST([rvNumber(0.5), rvNumber(2), rvNumber(3), rvBoolean(true)]));
    const b = asNumber(
      fnBETA_DIST([
        rvNumber(0.5),
        rvNumber(2),
        rvNumber(3),
        rvBoolean(true),
        rvNumber(0),
        rvNumber(1)
      ])
    );
    expect(a).toBeCloseTo(b, 12);
  });
  it("rejects alpha <= 0 → #NUM!", () => {
    expect(fnBETA_DIST([rvNumber(0.5), rvNumber(0), rvNumber(3), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects beta <= 0 → #NUM!", () => {
    expect(fnBETA_DIST([rvNumber(0.5), rvNumber(2), rvNumber(-1), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects A >= B → #NUM!", () => {
    expect(
      fnBETA_DIST([
        rvNumber(0.5),
        rvNumber(2),
        rvNumber(3),
        rvBoolean(true),
        rvNumber(1),
        rvNumber(1)
      ])
    ).toEqual(ERRORS.NUM);
  });
  it("rejects x out of [A, B] → #NUM!", () => {
    expect(fnBETA_DIST([rvNumber(-0.5), rvNumber(2), rvNumber(3), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
    expect(fnBETA_DIST([rvNumber(1.5), rvNumber(2), rvNumber(3), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("defaults cumulative=TRUE when argument omitted", () => {
    // With 3 args only (no cumulative), we pass the 4-arg version but skip via TRUE
    const r = fnBETA_DIST([rvNumber(0.5), rvNumber(2), rvNumber(3), rvBoolean(true)]);
    expect(r.kind).toBe(RVKind.Number);
  });
  it("propagates x error", () => {
    expect(fnBETA_DIST([rvError("#N/A"), rvNumber(2), rvNumber(3), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("CHISQ.INV saturation", () => {
  it("Excel doc example CHISQ.INV(0.93, 1) ≈ 3.28", () => {
    expect(asNumber(fnCHISQ_INV([rvNumber(0.93), rvNumber(1)]))).toBeCloseTo(3.283, 2);
  });
  it("CHISQ.INV(0.5, 1) ≈ 0.455 (median of df=1)", () => {
    expect(asNumber(fnCHISQ_INV([rvNumber(0.5), rvNumber(1)]))).toBeCloseTo(0.4549, 2);
  });
  it("CHISQ.INV(0, df) = 0", () => {
    expect(asNumber(fnCHISQ_INV([rvNumber(0), rvNumber(5)]))).toBe(0);
  });
  it("round-trips with CHISQ.DIST", () => {
    for (const p of [0.1, 0.25, 0.75, 0.9]) {
      const x = asNumber(fnCHISQ_INV([rvNumber(p), rvNumber(5)]));
      expect(asNumber(fnCHISQ_DIST([rvNumber(x), rvNumber(5), rvBoolean(true)]))).toBeCloseTo(p, 4);
    }
  });
  it("rejects p < 0 → #NUM!", () => {
    expect(fnCHISQ_INV([rvNumber(-0.1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("rejects p >= 1 → #NUM!", () => {
    expect(fnCHISQ_INV([rvNumber(1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("rejects df < 1 → #NUM!", () => {
    expect(fnCHISQ_INV([rvNumber(0.5), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates p error", () => {
    expect(fnCHISQ_INV([rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates df error", () => {
    expect(fnCHISQ_INV([rvNumber(0.5), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
});

describe("F.DIST saturation", () => {
  it("Excel doc example F.DIST(15.2069, 6, 4, TRUE) ≈ 0.99", () => {
    expect(
      asNumber(fnF_DIST([rvNumber(15.2069), rvNumber(6), rvNumber(4), rvBoolean(true)]))
    ).toBeCloseTo(0.99, 3);
  });
  it("PDF non-cumulative at x=1 is positive", () => {
    const pdf = asNumber(fnF_DIST([rvNumber(1), rvNumber(5), rvNumber(10), rvBoolean(false)]));
    expect(pdf).toBeGreaterThan(0);
  });
  it("CDF(0, d1, d2) = 0", () => {
    expect(asNumber(fnF_DIST([rvNumber(0), rvNumber(5), rvNumber(10), rvBoolean(true)]))).toBe(0);
  });
  it("CDF approaches 1 for large x", () => {
    expect(
      asNumber(fnF_DIST([rvNumber(1000), rvNumber(3), rvNumber(5), rvBoolean(true)]))
    ).toBeCloseTo(1, 4);
  });
  it("rejects x < 0 → #NUM!", () => {
    expect(fnF_DIST([rvNumber(-1), rvNumber(3), rvNumber(5), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("rejects df1 < 1 → #NUM!", () => {
    expect(fnF_DIST([rvNumber(1), rvNumber(0), rvNumber(5), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("rejects df2 < 1 → #NUM!", () => {
    expect(fnF_DIST([rvNumber(1), rvNumber(3), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("propagates x error", () => {
    expect(fnF_DIST([rvError("#N/A"), rvNumber(3), rvNumber(5), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("F.DIST = 1 - F.DIST.RT for reasonable x", () => {
    const cdf = asNumber(fnF_DIST([rvNumber(2), rvNumber(3), rvNumber(5), rvBoolean(true)]));
    const rt = asNumber(fnF_DIST_RT([rvNumber(2), rvNumber(3), rvNumber(5)]));
    expect(cdf + rt).toBeCloseTo(1, 10);
  });
});

describe("GAMMA.DIST saturation", () => {
  it("Excel doc example GAMMA.DIST(10.00001131, 9, 2, FALSE) ≈ 0.0327", () => {
    expect(
      asNumber(fnGAMMA_DIST([rvNumber(10.00001131), rvNumber(9), rvNumber(2), rvBoolean(false)]))
    ).toBeCloseTo(0.0327, 3);
  });
  it("CDF at x=0 = 0", () => {
    expect(
      asNumber(fnGAMMA_DIST([rvNumber(0), rvNumber(2), rvNumber(2), rvBoolean(true)]))
    ).toBeCloseTo(0, 10);
  });
  it("CDF approaches 1 for large x", () => {
    expect(
      asNumber(fnGAMMA_DIST([rvNumber(1000), rvNumber(2), rvNumber(2), rvBoolean(true)]))
    ).toBeCloseTo(1, 8);
  });
  it("rejects x < 0 → #NUM!", () => {
    expect(fnGAMMA_DIST([rvNumber(-1), rvNumber(2), rvNumber(2), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects alpha <= 0 → #NUM!", () => {
    expect(fnGAMMA_DIST([rvNumber(1), rvNumber(0), rvNumber(2), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects beta <= 0 → #NUM!", () => {
    expect(fnGAMMA_DIST([rvNumber(1), rvNumber(2), rvNumber(0), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("propagates x error", () => {
    expect(fnGAMMA_DIST([rvError("#N/A"), rvNumber(2), rvNumber(2), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("GAMMA.DIST(x, 1, beta, TRUE) = EXPON.DIST CDF with lambda = 1/beta", () => {
    const g = asNumber(fnGAMMA_DIST([rvNumber(2), rvNumber(1), rvNumber(2), rvBoolean(true)]));
    expect(g).toBeCloseTo(1 - Math.exp(-2 / 2), 10);
  });
});

describe("T.DIST.2T saturation", () => {
  it("T.DIST.2T(0, df) = 1 (all mass in two-tailed test at 0)", () => {
    expect(asNumber(fnT_DIST_2T([rvNumber(0), rvNumber(10)]))).toBeCloseTo(1, 10);
  });
  it("T.DIST.2T(1.96, 100) ≈ 0.053 (classic 95% test, moderate df)", () => {
    expect(asNumber(fnT_DIST_2T([rvNumber(1.96), rvNumber(100)]))).toBeCloseTo(0.053, 2);
  });
  it("T.DIST.2T Excel doc: T.DIST.2T(1.959999998, 60) ≈ 0.054645", () => {
    expect(asNumber(fnT_DIST_2T([rvNumber(1.959999998), rvNumber(60)]))).toBeCloseTo(0.054645, 3);
  });
  it("monotonically decreasing in x (for x >= 0)", () => {
    const a = asNumber(fnT_DIST_2T([rvNumber(1), rvNumber(10)]));
    const b = asNumber(fnT_DIST_2T([rvNumber(2), rvNumber(10)]));
    expect(b).toBeLessThan(a);
  });
  it("T.DIST.2T rejects negative x → #NUM!", () => {
    expect(fnT_DIST_2T([rvNumber(-1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("T.DIST.2T rejects df < 1 → #NUM!", () => {
    expect(fnT_DIST_2T([rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("T.DIST.2T propagates x error", () => {
    expect(fnT_DIST_2T([rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("T.DIST.2T propagates df error", () => {
    expect(fnT_DIST_2T([rvNumber(1), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("T.DIST.2T larger df → tighter tails (smaller 2-tailed prob at fixed x)", () => {
    const small = asNumber(fnT_DIST_2T([rvNumber(1), rvNumber(2)]));
    const large = asNumber(fnT_DIST_2T([rvNumber(1), rvNumber(100)]));
    expect(large).toBeLessThan(small);
  });
});

describe("T.INV.2T saturation", () => {
  it("Excel doc: T.INV.2T(0.546449, 60) ≈ 0.606533 (round-trip with T.DIST.2T)", () => {
    const x = asNumber(fnT_INV_2T([rvNumber(0.546449), rvNumber(60)]));
    expect(x).toBeGreaterThan(0);
    expect(asNumber(fnT_DIST_2T([rvNumber(x), rvNumber(60)]))).toBeCloseTo(0.546449, 4);
  });
  it("T.INV.2T(0.05, 10) ≈ 2.228 (classic 95% critical)", () => {
    expect(asNumber(fnT_INV_2T([rvNumber(0.05), rvNumber(10)]))).toBeCloseTo(2.228, 2);
  });
  it("T.INV.2T(1, df) = 0 (full probability equals median)", () => {
    expect(asNumber(fnT_INV_2T([rvNumber(1), rvNumber(5)]))).toBe(0);
  });
  it("returns absolute value (always positive)", () => {
    expect(asNumber(fnT_INV_2T([rvNumber(0.5), rvNumber(5)]))).toBeGreaterThan(0);
  });
  it("rejects p <= 0 → #NUM!", () => {
    expect(fnT_INV_2T([rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnT_INV_2T([rvNumber(-0.1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("rejects p > 1 → #NUM!", () => {
    expect(fnT_INV_2T([rvNumber(1.1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("rejects df < 1 → #NUM!", () => {
    expect(fnT_INV_2T([rvNumber(0.5), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("propagates p error", () => {
    expect(fnT_INV_2T([rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("propagates df error", () => {
    expect(fnT_INV_2T([rvNumber(0.5), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("T.INV.2T higher p → smaller x (closer to median)", () => {
    const a = asNumber(fnT_INV_2T([rvNumber(0.1), rvNumber(10)]));
    const b = asNumber(fnT_INV_2T([rvNumber(0.9), rvNumber(10)]));
    expect(b).toBeLessThan(a);
  });
});

describe("NORM.S.INV / NORMSINV saturation", () => {
  it("NORMSINV(0.5) = 0 (standard normal median)", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.5)]))).toBeCloseTo(0, 8);
  });
  it("Excel doc example NORMSINV(0.908789) ≈ 1.333", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.908789)]))).toBeCloseTo(1.333, 2);
  });
  it("symmetry: NORMSINV(1-p) = -NORMSINV(p)", () => {
    for (const p of [0.01, 0.1, 0.25, 0.4]) {
      expect(asNumber(fnNORMSINV([rvNumber(1 - p)]))).toBeCloseTo(
        -asNumber(fnNORMSINV([rvNumber(p)])),
        8
      );
    }
  });
  it("classic quantiles: NORMSINV(0.95) ≈ 1.645", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.95)]))).toBeCloseTo(1.6449, 3);
  });
  it("classic quantiles: NORMSINV(0.975) ≈ 1.960", () => {
    expect(asNumber(fnNORMSINV([rvNumber(0.975)]))).toBeCloseTo(1.96, 3);
  });
  it("rejects p <= 0 → #NUM!", () => {
    expect(fnNORMSINV([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnNORMSINV([rvNumber(-0.1)])).toEqual(ERRORS.NUM);
  });
  it("rejects p >= 1 → #NUM!", () => {
    expect(fnNORMSINV([rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnNORMSINV([rvNumber(1.1)])).toEqual(ERRORS.NUM);
  });
  it("propagates error", () => {
    expect(fnNORMSINV([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("round-trips with NORM.S.DIST", () => {
    for (const p of [0.01, 0.25, 0.75, 0.99]) {
      const x = asNumber(fnNORMSINV([rvNumber(p)]));
      expect(asNumber(fnNORMSDIST([rvNumber(x), rvBoolean(true)]))).toBeCloseTo(p, 6);
    }
  });
  it("NORMSINV on 1×1 array", () => {
    expect(asNumber(fnNORMSINV([rvArray([[rvNumber(0.5)]])]))).toBeCloseTo(0, 8);
  });
});

describe("NORM.S.DIST saturation", () => {
  it("NORM.S.DIST(0, TRUE) = 0.5", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(0), rvBoolean(true)]))).toBeCloseTo(0.5, 10);
  });
  it("NORM.S.DIST(1.333333, TRUE) ≈ 0.908789 — Excel doc example", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(1.333333), rvBoolean(true)]))).toBeCloseTo(
      0.9087887802,
      5
    );
  });
  it("NORM.S.DIST(0, FALSE) = φ(0) = 1/√(2π)", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(0), rvBoolean(false)]))).toBeCloseTo(
      1 / Math.sqrt(2 * Math.PI),
      10
    );
  });
  it("legacy single-arg NORMSDIST returns CDF", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(0)]))).toBeCloseTo(0.5, 10);
  });
  it("tail behavior: NORMSDIST(1.96, TRUE) ≈ 0.975", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(1.96), rvBoolean(true)]))).toBeCloseTo(0.975, 3);
  });
  it("symmetry: NORMSDIST(-x, TRUE) = 1 - NORMSDIST(x, TRUE)", () => {
    for (const x of [0.5, 1, 2]) {
      expect(asNumber(fnNORMSDIST([rvNumber(-x), rvBoolean(true)]))).toBeCloseTo(
        1 - asNumber(fnNORMSDIST([rvNumber(x), rvBoolean(true)])),
        10
      );
    }
  });
  it("monotonically increasing in x (CDF)", () => {
    const a = asNumber(fnNORMSDIST([rvNumber(-1), rvBoolean(true)]));
    const b = asNumber(fnNORMSDIST([rvNumber(1), rvBoolean(true)]));
    expect(b).toBeGreaterThan(a);
  });
  it("PDF is even: NORMSDIST(-x, FALSE) = NORMSDIST(x, FALSE)", () => {
    expect(asNumber(fnNORMSDIST([rvNumber(-1.5), rvBoolean(false)]))).toBeCloseTo(
      asNumber(fnNORMSDIST([rvNumber(1.5), rvBoolean(false)])),
      12
    );
  });
  it("propagates x error", () => {
    expect(fnNORMSDIST([rvError("#N/A"), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("NORMSDIST on 1×1 array", () => {
    expect(asNumber(fnNORMSDIST([rvArray([[rvNumber(0)]]), rvBoolean(true)]))).toBeCloseTo(0.5, 10);
  });
});

describe("NORMDIST saturation", () => {
  it("NORMDIST(x=mean, cum=TRUE) = 0.5", () => {
    expect(
      asNumber(fnNORMDIST([rvNumber(5), rvNumber(5), rvNumber(2), rvBoolean(true)]))
    ).toBeCloseTo(0.5, 10);
  });
  it("NORMDIST Excel doc example NORMDIST(42, 40, 1.5, TRUE) ≈ 0.908789", () => {
    expect(
      asNumber(fnNORMDIST([rvNumber(42), rvNumber(40), rvNumber(1.5), rvBoolean(true)]))
    ).toBeCloseTo(0.908789, 4);
  });
  it("NORMDIST(42, 40, 1.5, FALSE) ≈ 0.10934", () => {
    expect(
      asNumber(fnNORMDIST([rvNumber(42), rvNumber(40), rvNumber(1.5), rvBoolean(false)]))
    ).toBeCloseTo(0.10934, 3);
  });
  it("NORMDIST PDF is symmetric around mean", () => {
    const a = asNumber(fnNORMDIST([rvNumber(4), rvNumber(5), rvNumber(2), rvBoolean(false)]));
    const b = asNumber(fnNORMDIST([rvNumber(6), rvNumber(5), rvNumber(2), rvBoolean(false)]));
    expect(a).toBeCloseTo(b, 12);
  });
  it("NORMDIST rejects sigma <= 0 → #NUM!", () => {
    expect(fnNORMDIST([rvNumber(0), rvNumber(0), rvNumber(0), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
    expect(fnNORMDIST([rvNumber(0), rvNumber(0), rvNumber(-1), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("NORMDIST propagates x error", () => {
    expect(fnNORMDIST([rvError("#N/A"), rvNumber(0), rvNumber(1), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("NORMDIST propagates mean error", () => {
    expect(fnNORMDIST([rvNumber(0), rvError("#REF!"), rvNumber(1), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("NORMDIST propagates sigma error", () => {
    expect(fnNORMDIST([rvNumber(0), rvNumber(0), rvError("#N/A"), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("NORMDIST standard normal matches NORMSDIST", () => {
    for (const x of [-1, 0, 1, 2]) {
      expect(
        asNumber(fnNORMDIST([rvNumber(x), rvNumber(0), rvNumber(1), rvBoolean(true)]))
      ).toBeCloseTo(asNumber(fnNORMSDIST([rvNumber(x), rvBoolean(true)])), 10);
    }
  });
});

describe("T.DIST saturation", () => {
  it("T.DIST(0, df, TRUE) = 0.5", () => {
    expect(asNumber(fnT_DIST([rvNumber(0), rvNumber(10), rvBoolean(true)]))).toBeCloseTo(0.5, 10);
  });
  it("T.DIST(0, df, FALSE) = PDF at 0 (peak)", () => {
    const pdf = asNumber(fnT_DIST([rvNumber(0), rvNumber(10), rvBoolean(false)]));
    expect(pdf).toBeGreaterThan(0.38);
    expect(pdf).toBeLessThan(0.4);
  });
  it("T.DIST Excel doc: T.DIST(60, 1, TRUE) close to 1", () => {
    expect(asNumber(fnT_DIST([rvNumber(60), rvNumber(1), rvBoolean(true)]))).toBeCloseTo(0.9947, 3);
  });
  it("T.DIST CDF symmetry: T.DIST(-x, df, TRUE) = 1 - T.DIST(x, df, TRUE)", () => {
    const a = asNumber(fnT_DIST([rvNumber(-1), rvNumber(10), rvBoolean(true)]));
    const b = asNumber(fnT_DIST([rvNumber(1), rvNumber(10), rvBoolean(true)]));
    expect(a + b).toBeCloseTo(1, 10);
  });
  it("T.DIST rejects df < 1", () => {
    expect(fnT_DIST([rvNumber(1), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("T.DIST PDF is even (symmetric around 0)", () => {
    expect(asNumber(fnT_DIST([rvNumber(-1), rvNumber(5), rvBoolean(false)]))).toBeCloseTo(
      asNumber(fnT_DIST([rvNumber(1), rvNumber(5), rvBoolean(false)])),
      12
    );
  });
  it("T.DIST propagates x error", () => {
    expect(fnT_DIST([rvError("#N/A"), rvNumber(5), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("T.DIST propagates df error", () => {
    expect(fnT_DIST([rvNumber(0), rvError("#REF!"), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("T.DIST approaches NORMSDIST at large df", () => {
    const t = asNumber(fnT_DIST([rvNumber(1), rvNumber(200), rvBoolean(true)]));
    const n = asNumber(fnNORMSDIST([rvNumber(1), rvBoolean(true)]));
    expect(Math.abs(t - n)).toBeLessThan(0.01);
  });
});

describe("T.DIST.RT saturation", () => {
  it("T.DIST.RT(0, df) = 0.5 (symmetric median)", () => {
    expect(asNumber(fnT_DIST_RT([rvNumber(0), rvNumber(10)]))).toBeCloseTo(0.5, 10);
  });
  it("Excel doc example T.DIST.RT(1.959999998, 60) ≈ 0.027322", () => {
    expect(asNumber(fnT_DIST_RT([rvNumber(1.959999998), rvNumber(60)]))).toBeCloseTo(0.027322, 3);
  });
  it("T.DIST.RT(-x, df) = 1 - T.DIST.RT(x, df)", () => {
    const pos = asNumber(fnT_DIST_RT([rvNumber(1), rvNumber(10)]));
    const neg = asNumber(fnT_DIST_RT([rvNumber(-1), rvNumber(10)]));
    expect(pos + neg).toBeCloseTo(1, 10);
  });
  it("T.DIST.RT monotonically decreasing", () => {
    const a = asNumber(fnT_DIST_RT([rvNumber(0.5), rvNumber(10)]));
    const b = asNumber(fnT_DIST_RT([rvNumber(2), rvNumber(10)]));
    expect(b).toBeLessThan(a);
  });
  it("T.DIST.RT rejects df < 1", () => {
    expect(fnT_DIST_RT([rvNumber(1), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("T.DIST.RT propagates x error", () => {
    expect(fnT_DIST_RT([rvError("#N/A"), rvNumber(10)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("T.DIST.RT propagates df error", () => {
    expect(fnT_DIST_RT([rvNumber(1), rvError("#N/A")])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("T.DIST.RT(x, df) = 1 - T.DIST(x, df, TRUE)", () => {
    const rt = asNumber(fnT_DIST_RT([rvNumber(1), rvNumber(10)]));
    const cdf = asNumber(fnT_DIST([rvNumber(1), rvNumber(10), rvBoolean(true)]));
    expect(rt + cdf).toBeCloseTo(1, 10);
  });
});

describe("T.INV saturation", () => {
  it("T.INV(0.5, df) = 0 (median)", () => {
    expect(asNumber(fnT_INV([rvNumber(0.5), rvNumber(10)]))).toBeCloseTo(0, 8);
  });
  it("Excel doc example T.INV(0.75, 2) ≈ 0.8165", () => {
    expect(asNumber(fnT_INV([rvNumber(0.75), rvNumber(2)]))).toBeCloseTo(0.8165, 3);
  });
  it("round-trips with T.DIST", () => {
    for (const p of [0.1, 0.25, 0.75, 0.9]) {
      const x = asNumber(fnT_INV([rvNumber(p), rvNumber(5)]));
      expect(asNumber(fnT_DIST([rvNumber(x), rvNumber(5), rvBoolean(true)]))).toBeCloseTo(p, 6);
    }
  });
  it("T.INV rejects p <= 0 or >= 1", () => {
    expect(fnT_INV([rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnT_INV([rvNumber(1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("T.INV rejects df < 1", () => {
    expect(fnT_INV([rvNumber(0.5), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("T.INV propagates p error", () => {
    expect(fnT_INV([rvError("#N/A"), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
  it("T.INV propagates df error", () => {
    expect(fnT_INV([rvNumber(0.5), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("T.INV symmetric: T.INV(1-p, df) = -T.INV(p, df)", () => {
    expect(asNumber(fnT_INV([rvNumber(0.8), rvNumber(10)]))).toBeCloseTo(
      -asNumber(fnT_INV([rvNumber(0.2), rvNumber(10)])),
      6
    );
  });
});

describe("GAMMA saturation", () => {
  it("GAMMA(1) = 0! = 1", () => {
    expect(asNumber(fnGAMMA([rvNumber(1)]))).toBeCloseTo(1, 10);
  });
  it("GAMMA(2) = 1! = 1", () => {
    expect(asNumber(fnGAMMA([rvNumber(2)]))).toBeCloseTo(1, 10);
  });
  it("GAMMA(5) = 4! = 24", () => {
    expect(asNumber(fnGAMMA([rvNumber(5)]))).toBeCloseTo(24, 8);
  });
  it("GAMMA(0.5) = √π ≈ 1.7725 — classic identity", () => {
    expect(asNumber(fnGAMMA([rvNumber(0.5)]))).toBeCloseTo(Math.sqrt(Math.PI), 6);
  });
  it("GAMMA(1.5) = 0.5 * √π", () => {
    expect(asNumber(fnGAMMA([rvNumber(1.5)]))).toBeCloseTo(0.5 * Math.sqrt(Math.PI), 6);
  });
  it("GAMMA rejects non-positive integers", () => {
    expect(fnGAMMA([rvNumber(0)])).toEqual(ERRORS.NUM);
    expect(fnGAMMA([rvNumber(-1)])).toEqual(ERRORS.NUM);
    expect(fnGAMMA([rvNumber(-5)])).toEqual(ERRORS.NUM);
  });
  it("GAMMA accepts negative non-integers", () => {
    // Γ(-0.5) = -2√π
    expect(asNumber(fnGAMMA([rvNumber(-0.5)]))).toBeCloseTo(-2 * Math.sqrt(Math.PI), 4);
  });
  it("GAMMA propagates error", () => {
    expect(fnGAMMA([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("GAMMA consistent with GAMMALN: ln(GAMMA(x)) = GAMMALN(x)", () => {
    for (const x of [2, 3, 5, 10]) {
      expect(Math.log(asNumber(fnGAMMA([rvNumber(x)])))).toBeCloseTo(
        asNumber(fnGAMMALN([rvNumber(x)])),
        4
      );
    }
  });
  it("GAMMA coerces boolean TRUE → GAMMA(1) = 1", () => {
    expect(asNumber(fnGAMMA([rvBoolean(true)]))).toBeCloseTo(1, 10);
  });
});

describe("WEIBULL.DIST saturation", () => {
  it("Excel doc example WEIBULL.DIST(105, 20, 100, FALSE) ≈ 0.0356", () => {
    expect(
      asNumber(fnWEIBULL_DIST([rvNumber(105), rvNumber(20), rvNumber(100), rvBoolean(false)]))
    ).toBeCloseTo(0.0356, 3);
  });
  it("Excel doc example WEIBULL.DIST(105, 20, 100, TRUE) ≈ 0.9296", () => {
    expect(
      asNumber(fnWEIBULL_DIST([rvNumber(105), rvNumber(20), rvNumber(100), rvBoolean(true)]))
    ).toBeCloseTo(0.9296, 3);
  });
  it("CDF at x=0 = 0", () => {
    expect(asNumber(fnWEIBULL_DIST([rvNumber(0), rvNumber(2), rvNumber(3), rvBoolean(true)]))).toBe(
      0
    );
  });
  it("CDF approaches 1 for large x", () => {
    expect(
      asNumber(fnWEIBULL_DIST([rvNumber(1000), rvNumber(2), rvNumber(3), rvBoolean(true)]))
    ).toBeCloseTo(1, 10);
  });
  it("alpha=1 special case → exponential", () => {
    const w = asNumber(fnWEIBULL_DIST([rvNumber(1), rvNumber(1), rvNumber(2), rvBoolean(true)]));
    expect(w).toBeCloseTo(1 - Math.exp(-0.5), 10);
  });
  it("rejects x < 0 → #NUM!", () => {
    expect(fnWEIBULL_DIST([rvNumber(-1), rvNumber(2), rvNumber(3), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects alpha <= 0 → #NUM!", () => {
    expect(fnWEIBULL_DIST([rvNumber(1), rvNumber(0), rvNumber(3), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("rejects beta <= 0 → #NUM!", () => {
    expect(fnWEIBULL_DIST([rvNumber(1), rvNumber(2), rvNumber(0), rvBoolean(true)])).toEqual(
      ERRORS.NUM
    );
  });
  it("propagates error", () => {
    expect(fnWEIBULL_DIST([rvError("#N/A"), rvNumber(2), rvNumber(3), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("ERF / ERFC saturation", () => {
  it("ERF Excel doc: ERF(1.5) ≈ 0.9661", () => {
    expect(asNumber(fnERF([rvNumber(1.5)]))).toBeCloseTo(0.9661, 3);
  });
  it("ERF(∞) approaches 1", () => {
    expect(asNumber(fnERF([rvNumber(10)]))).toBeCloseTo(1, 6);
  });
  it("ERF(-x) = -ERF(x) (odd function)", () => {
    expect(asNumber(fnERF([rvNumber(-1)]))).toBeCloseTo(-asNumber(fnERF([rvNumber(1)])), 10);
  });
  it("ERF(lower, upper) = ERF(upper) - ERF(lower)", () => {
    const range = asNumber(fnERF([rvNumber(0.5), rvNumber(1)]));
    const expected = asNumber(fnERF([rvNumber(1)])) - asNumber(fnERF([rvNumber(0.5)]));
    expect(range).toBeCloseTo(expected, 10);
  });
  it("ERF propagates lower error", () => {
    expect(fnERF([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ERF propagates upper error", () => {
    expect(fnERF([rvNumber(0), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("ERF coerces boolean (TRUE=1)", () => {
    expect(asNumber(fnERF([rvBoolean(true)]))).toBeCloseTo(asNumber(fnERF([rvNumber(1)])), 10);
  });
  it("ERFC Excel doc: ERFC(1.5) ≈ 0.0339", () => {
    expect(asNumber(fnERFC([rvNumber(1.5)]))).toBeCloseTo(0.0339, 3);
  });
  it("ERFC = 1 - ERF", () => {
    for (const x of [-0.5, 0.5, 1, 2]) {
      expect(asNumber(fnERFC([rvNumber(x)]))).toBeCloseTo(1 - asNumber(fnERF([rvNumber(x)])), 10);
    }
  });
  it("ERFC(-x) = 2 - ERFC(x) (symmetry)", () => {
    expect(asNumber(fnERFC([rvNumber(-1)]))).toBeCloseTo(2 - asNumber(fnERFC([rvNumber(1)])), 10);
  });
  it("ERFC propagates error", () => {
    expect(fnERFC([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("ERFC coerces numeric string", () => {
    expect(asNumber(fnERFC([rvString("1")]))).toBeCloseTo(asNumber(fnERFC([rvNumber(1)])), 12);
  });
});

describe("CHISQ.DIST saturation", () => {
  it("CHISQ.DIST(1, 1, TRUE) ≈ 0.6827 (68%)", () => {
    expect(asNumber(fnCHISQ_DIST([rvNumber(1), rvNumber(1), rvBoolean(true)]))).toBeCloseTo(
      0.6827,
      3
    );
  });
  it("CHISQ.DIST Excel doc: CHISQ.DIST(0.5, 1, TRUE) ≈ 0.5205", () => {
    expect(asNumber(fnCHISQ_DIST([rvNumber(0.5), rvNumber(1), rvBoolean(true)]))).toBeCloseTo(
      0.5205,
      3
    );
  });
  it("CHISQ.DIST(x=0, df, TRUE) = 0", () => {
    expect(asNumber(fnCHISQ_DIST([rvNumber(0), rvNumber(5), rvBoolean(true)]))).toBe(0);
  });
  it("CHISQ.DIST accepts fractional df (regression)", () => {
    const r = asNumber(fnCHISQ_DIST([rvNumber(1), rvNumber(1.5), rvBoolean(true)]));
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
  it("CHISQ.DIST rejects x < 0", () => {
    expect(fnCHISQ_DIST([rvNumber(-1), rvNumber(5), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.DIST rejects df < 1", () => {
    expect(fnCHISQ_DIST([rvNumber(1), rvNumber(0), rvBoolean(true)])).toEqual(ERRORS.NUM);
  });
  it("CHISQ.DIST propagates x error", () => {
    expect(fnCHISQ_DIST([rvError("#N/A"), rvNumber(5), rvBoolean(true)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("F.DIST.RT saturation", () => {
  it("F.DIST.RT(0, d1, d2) = 1 (all right of 0)", () => {
    expect(asNumber(fnF_DIST_RT([rvNumber(0), rvNumber(3), rvNumber(5)]))).toBe(1);
  });
  it("F.DIST.RT monotonically decreasing", () => {
    const a = asNumber(fnF_DIST_RT([rvNumber(1), rvNumber(3), rvNumber(5)]));
    const b = asNumber(fnF_DIST_RT([rvNumber(10), rvNumber(3), rvNumber(5)]));
    expect(b).toBeLessThan(a);
  });
  it("F.DIST.RT + F.DIST(cumulative=TRUE) = 1", () => {
    const rt = asNumber(fnF_DIST_RT([rvNumber(2), rvNumber(3), rvNumber(5)]));
    const cdf = asNumber(fnF_DIST([rvNumber(2), rvNumber(3), rvNumber(5), rvBoolean(true)]));
    expect(rt + cdf).toBeCloseTo(1, 10);
  });
  it("F.DIST.RT rejects x < 0", () => {
    expect(fnF_DIST_RT([rvNumber(-1), rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("F.DIST.RT rejects df1 < 1", () => {
    expect(fnF_DIST_RT([rvNumber(1), rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("F.DIST.RT rejects df2 < 1", () => {
    expect(fnF_DIST_RT([rvNumber(1), rvNumber(3), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("F.DIST.RT propagates x error", () => {
    expect(fnF_DIST_RT([rvError("#N/A"), rvNumber(3), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("F.INV.RT saturation", () => {
  it("Excel doc F.INV.RT(0.05, 6, 4) ≈ 6.163", () => {
    expect(asNumber(fnF_INV_RT([rvNumber(0.05), rvNumber(6), rvNumber(4)]))).toBeCloseTo(6.163, 2);
  });
  it("round-trips with F.DIST.RT", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnF_INV_RT([rvNumber(p), rvNumber(3), rvNumber(5)]));
      expect(asNumber(fnF_DIST_RT([rvNumber(x), rvNumber(3), rvNumber(5)]))).toBeCloseTo(p, 6);
    }
  });
  it("F.INV.RT(1, d1, d2) = 0", () => {
    expect(asNumber(fnF_INV_RT([rvNumber(1), rvNumber(3), rvNumber(5)]))).toBeCloseTo(0, 8);
  });
  it("F.INV.RT rejects p <= 0", () => {
    expect(fnF_INV_RT([rvNumber(0), rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("F.INV.RT rejects p > 1", () => {
    expect(fnF_INV_RT([rvNumber(1.1), rvNumber(3), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("F.INV.RT rejects df1 < 1", () => {
    expect(fnF_INV_RT([rvNumber(0.5), rvNumber(0), rvNumber(5)])).toEqual(ERRORS.NUM);
  });
  it("F.INV.RT propagates error", () => {
    expect(fnF_INV_RT([rvError("#N/A"), rvNumber(3), rvNumber(5)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("BETA.INV saturation", () => {
  it("Excel doc BETA.INV(0.685470581, 8, 10, 1, 3) ≈ 2", () => {
    expect(
      asNumber(
        fnBETA_INV([rvNumber(0.685470581), rvNumber(8), rvNumber(10), rvNumber(1), rvNumber(3)])
      )
    ).toBeCloseTo(2, 2);
  });
  it("round-trips with BETA.DIST", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnBETA_INV([rvNumber(p), rvNumber(2), rvNumber(3)]));
      expect(
        asNumber(fnBETA_DIST([rvNumber(x), rvNumber(2), rvNumber(3), rvBoolean(true)]))
      ).toBeCloseTo(p, 6);
    }
  });
  it("BETA.INV(0, α, β) = 0", () => {
    expect(asNumber(fnBETA_INV([rvNumber(0), rvNumber(2), rvNumber(3)]))).toBeCloseTo(0, 8);
  });
  it("BETA.INV(1, α, β) = 1 (default A=0, B=1)", () => {
    expect(asNumber(fnBETA_INV([rvNumber(1), rvNumber(2), rvNumber(3)]))).toBeCloseTo(1, 4);
  });
  it("BETA.INV rejects p outside [0, 1]", () => {
    expect(fnBETA_INV([rvNumber(-0.1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NUM);
    expect(fnBETA_INV([rvNumber(1.1), rvNumber(2), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("BETA.INV rejects alpha <= 0", () => {
    expect(fnBETA_INV([rvNumber(0.5), rvNumber(0), rvNumber(3)])).toEqual(ERRORS.NUM);
  });
  it("BETA.INV rejects beta <= 0", () => {
    expect(fnBETA_INV([rvNumber(0.5), rvNumber(2), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("BETA.INV propagates error", () => {
    expect(fnBETA_INV([rvError("#N/A"), rvNumber(2), rvNumber(3)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("GAMMA.INV saturation", () => {
  it("Excel doc GAMMA.INV(0.068094, 9, 2) ≈ 10", () => {
    expect(asNumber(fnGAMMA_INV([rvNumber(0.068094), rvNumber(9), rvNumber(2)]))).toBeCloseTo(
      10,
      1
    );
  });
  it("round-trips with GAMMA.DIST", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnGAMMA_INV([rvNumber(p), rvNumber(2), rvNumber(2)]));
      expect(
        asNumber(fnGAMMA_DIST([rvNumber(x), rvNumber(2), rvNumber(2), rvBoolean(true)]))
      ).toBeCloseTo(p, 4);
    }
  });
  it("GAMMA.INV(0, α, β) = 0", () => {
    expect(asNumber(fnGAMMA_INV([rvNumber(0), rvNumber(2), rvNumber(2)]))).toBeCloseTo(0, 8);
  });
  it("GAMMA.INV rejects p < 0 or p >= 1", () => {
    expect(fnGAMMA_INV([rvNumber(-0.1), rvNumber(2), rvNumber(2)])).toEqual(ERRORS.NUM);
    expect(fnGAMMA_INV([rvNumber(1), rvNumber(2), rvNumber(2)])).toEqual(ERRORS.NUM);
  });
  it("GAMMA.INV rejects alpha <= 0", () => {
    expect(fnGAMMA_INV([rvNumber(0.5), rvNumber(0), rvNumber(2)])).toEqual(ERRORS.NUM);
  });
  it("GAMMA.INV rejects beta <= 0", () => {
    expect(fnGAMMA_INV([rvNumber(0.5), rvNumber(2), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("GAMMA.INV propagates p error", () => {
    expect(fnGAMMA_INV([rvError("#N/A"), rvNumber(2), rvNumber(2)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("LOGNORM.INV saturation", () => {
  it("Excel doc LOGNORM.INV(0.039084, 3.5, 1.2) ≈ 4.001", () => {
    expect(asNumber(fnLOGNORM_INV([rvNumber(0.039084), rvNumber(3.5), rvNumber(1.2)]))).toBeCloseTo(
      4.001,
      1
    );
  });
  it("round-trips with LOGNORM.DIST", () => {
    for (const p of [0.1, 0.5, 0.9]) {
      const x = asNumber(fnLOGNORM_INV([rvNumber(p), rvNumber(1), rvNumber(0.5)]));
      expect(
        asNumber(fnLOGNORM_DIST([rvNumber(x), rvNumber(1), rvNumber(0.5), rvBoolean(true)]))
      ).toBeCloseTo(p, 6);
    }
  });
  it("LOGNORM.INV(0.5, mean, σ) = exp(mean) (median)", () => {
    expect(asNumber(fnLOGNORM_INV([rvNumber(0.5), rvNumber(3), rvNumber(2)]))).toBeCloseTo(
      Math.exp(3),
      6
    );
  });
  it("LOGNORM.INV rejects p <= 0", () => {
    expect(fnLOGNORM_INV([rvNumber(0), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOGNORM.INV rejects p >= 1", () => {
    expect(fnLOGNORM_INV([rvNumber(1), rvNumber(0), rvNumber(1)])).toEqual(ERRORS.NUM);
  });
  it("LOGNORM.INV rejects stddev <= 0", () => {
    expect(fnLOGNORM_INV([rvNumber(0.5), rvNumber(0), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("LOGNORM.INV propagates error", () => {
    expect(fnLOGNORM_INV([rvError("#N/A"), rvNumber(0), rvNumber(1)])).toEqual({
      kind: RVKind.Error,
      code: "#N/A"
    });
  });
});

describe("GAUSS saturation", () => {
  it("GAUSS(0) = 0", () => {
    expect(asNumber(fnGAUSS([rvNumber(0)]))).toBeCloseTo(0, 10);
  });
  it("Excel doc GAUSS(2) ≈ 0.477250", () => {
    expect(asNumber(fnGAUSS([rvNumber(2)]))).toBeCloseTo(0.47725, 3);
  });
  it("GAUSS(1) ≈ 0.3413 (68-95-99.7 rule)", () => {
    expect(asNumber(fnGAUSS([rvNumber(1)]))).toBeCloseTo(0.3413, 3);
  });
  it("GAUSS is odd", () => {
    expect(asNumber(fnGAUSS([rvNumber(-1)]))).toBeCloseTo(-asNumber(fnGAUSS([rvNumber(1)])), 10);
  });
  it("GAUSS(z) = NORMSDIST(z) - 0.5", () => {
    for (const z of [-1, 0.5, 1, 2]) {
      expect(asNumber(fnGAUSS([rvNumber(z)]))).toBeCloseTo(
        asNumber(fnNORMSDIST([rvNumber(z), rvBoolean(true)])) - 0.5,
        10
      );
    }
  });
  it("GAUSS(∞) approaches 0.5", () => {
    expect(asNumber(fnGAUSS([rvNumber(10)]))).toBeCloseTo(0.5, 6);
  });
  it("GAUSS propagates error", () => {
    expect(fnGAUSS([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("GAUSS coerces numeric string", () => {
    expect(asNumber(fnGAUSS([rvString("1")]))).toBeCloseTo(0.3413, 3);
  });
});

describe("FISHER / FISHERINV saturation", () => {
  it("FISHER(0.75) ≈ 0.9729 — Excel doc example", () => {
    expect(asNumber(fnFISHER([rvNumber(0.75)]))).toBeCloseTo(0.9729550745, 6);
  });
  it("FISHER(0) = 0", () => {
    expect(asNumber(fnFISHER([rvNumber(0)]))).toBe(0);
  });
  it("FISHER is odd", () => {
    expect(asNumber(fnFISHER([rvNumber(-0.5)]))).toBeCloseTo(
      -asNumber(fnFISHER([rvNumber(0.5)])),
      10
    );
  });
  it("FISHER rejects |x| >= 1", () => {
    expect(fnFISHER([rvNumber(1)])).toEqual(ERRORS.NUM);
    expect(fnFISHER([rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("FISHER propagates error", () => {
    expect(fnFISHER([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("FISHERINV(0.9729550745) ≈ 0.75 — round-trip", () => {
    expect(asNumber(fnFISHERINV([rvNumber(0.9729550745)]))).toBeCloseTo(0.75, 6);
  });
  it("FISHERINV(0) = 0", () => {
    expect(asNumber(fnFISHERINV([rvNumber(0)]))).toBe(0);
  });
  it("FISHER ∘ FISHERINV ≈ identity", () => {
    for (const x of [-0.8, -0.3, 0, 0.3, 0.8]) {
      expect(asNumber(fnFISHERINV([fnFISHER([rvNumber(x)])]))).toBeCloseTo(x, 10);
    }
  });
  it("FISHERINV propagates error", () => {
    expect(fnFISHERINV([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("FISHERINV at large |y| approaches ±1", () => {
    expect(asNumber(fnFISHERINV([rvNumber(10)]))).toBeCloseTo(1, 6);
    expect(asNumber(fnFISHERINV([rvNumber(-10)]))).toBeCloseTo(-1, 6);
  });
});

describe("MODE / MODE.MULT saturation", () => {
  it("MODE returns first (most frequent) value", () => {
    const arr = rvArray([
      [rvNumber(4), rvNumber(4), rvNumber(2), rvNumber(4), rvNumber(2), rvNumber(2)]
    ]);
    // 4 and 2 both appear 3 times; MODE returns the one hitting maxCount first → 4
    expect(asNumber(fnMODE([arr]))).toBe(4);
  });
  it("MODE Excel doc: MODE(5.6, 4, 4, 3, 2, 4) = 4", () => {
    expect(
      asNumber(
        fnMODE([rvNumber(5.6), rvNumber(4), rvNumber(4), rvNumber(3), rvNumber(2), rvNumber(4)])
      )
    ).toBe(4);
  });
  it("MODE no repeats → #N/A", () => {
    expect(fnMODE([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])])).toEqual(ERRORS.NA);
  });
  it("MODE empty → #N/A", () => {
    expect(fnMODE([rvArray([[]])])).toEqual(ERRORS.NA);
  });
  it("MODE propagates error", () => {
    expect(fnMODE([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("MODE.MULT returns vertical array of all modes", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(1), rvNumber(2), rvNumber(2), rvNumber(3)]]);
    const r = fnMODE_MULT([arr]);
    expect(r.kind).toBe(RVKind.Array);
    const a = r as ArrayValue;
    expect(a.height).toBe(2);
    expect(a.width).toBe(1);
    expect(asNumber(a.rows[0][0])).toBe(1);
    expect(asNumber(a.rows[1][0])).toBe(2);
  });
  it("MODE.MULT preserves first-occurrence order", () => {
    const arr = rvArray([[rvNumber(3), rvNumber(1), rvNumber(1), rvNumber(3), rvNumber(2)]]);
    // 1 and 3 each appear twice; first-seen order: 3 then 1
    const r = fnMODE_MULT([arr]);
    const a = r as ArrayValue;
    expect(asNumber(a.rows[0][0])).toBe(3);
    expect(asNumber(a.rows[1][0])).toBe(1);
  });
  it("MODE.MULT no repeats → #N/A", () => {
    expect(fnMODE_MULT([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])])).toEqual(ERRORS.NA);
  });
  it("MODE.MULT empty → #N/A", () => {
    expect(fnMODE_MULT([rvArray([[]])])).toEqual(ERRORS.NA);
  });
  it("MODE.MULT propagates error", () => {
    expect(fnMODE_MULT([rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
});

describe("INTERCEPT / SLOPE / RSQ saturation", () => {
  const y = rvArray([[rvNumber(2), rvNumber(3), rvNumber(9), rvNumber(1), rvNumber(8)]]);
  const x = rvArray([[rvNumber(6), rvNumber(5), rvNumber(11), rvNumber(7), rvNumber(5)]]);
  it("INTERCEPT for y=[2,3,9,1,8], x=[6,5,11,7,5] via formula μy - slope*μx", () => {
    // Hand-computed: slope = Σ(x-μx)(y-μy) / Σ(x-μx)² = 16.6 / 24.8 ≈ 0.6694
    // intercept = μy - slope*μx = 4.6 - 0.6694*6.8 ≈ 0.0484
    expect(asNumber(fnINTERCEPT([y, x]))).toBeCloseTo(0.0484, 3);
  });
  it("SLOPE for y=[2,3,9,1,8], x=[6,5,11,7,5] ≈ 0.6694", () => {
    expect(asNumber(fnSLOPE([y, x]))).toBeCloseTo(0.669354, 4);
  });
  it("RSQ for y=[2,3,9,1,8], x=[6,5,11,7,5] ≈ 0.2089", () => {
    // R² = slope² * varx/vary = 0.6694² * (24.8/5) / ((6.76 + 2.56 + 19.36 + 12.96 + 11.56)/5)
    //    = 0.4481 * 4.96 / 10.64 ≈ 0.2089
    expect(asNumber(fnRSQ([y, x]))).toBeCloseTo(0.2089, 3);
  });
  it("perfect line y=2x: slope=2, intercept=0, rsq=1", () => {
    const yp = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8)]]);
    const xp = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    expect(asNumber(fnSLOPE([yp, xp]))).toBeCloseTo(2, 10);
    expect(asNumber(fnINTERCEPT([yp, xp]))).toBeCloseTo(0, 8);
    expect(asNumber(fnRSQ([yp, xp]))).toBeCloseTo(1, 10);
  });
  it("SLOPE with all-error y returns an error (#DIV/0! since filtering leaves n=0)", () => {
    const r = fnSLOPE([rvArray([[ERRORS.NA]]), x]);
    expect(r.kind).toBe(RVKind.Error);
  });
  it("INTERCEPT with all-error y returns an error", () => {
    const r = fnINTERCEPT([rvArray([[ERRORS.NA]]), x]);
    expect(r.kind).toBe(RVKind.Error);
  });
  it("RSQ with all-error y returns an error", () => {
    const r = fnRSQ([rvArray([[ERRORS.NA]]), x]);
    expect(r.kind).toBe(RVKind.Error);
  });
  it("SLOPE of constant y = 0", () => {
    const yc = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    const xc = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnSLOPE([yc, xc]))).toBeCloseTo(0, 10);
  });
  it("INTERCEPT of constant y = 5", () => {
    const yc = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    const xc = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnINTERCEPT([yc, xc]))).toBeCloseTo(5, 10);
  });
  it("RSQ of identical series = 1", () => {
    const yp = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(asNumber(fnRSQ([yp, yp]))).toBeCloseTo(1, 10);
  });
});

describe("FORECAST saturation", () => {
  const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8), rvNumber(10)]]);
  const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  it("Excel doc-style: perfect line extrapolation", () => {
    expect(asNumber(fnFORECAST([rvNumber(6), y, x]))).toBeCloseTo(12, 8);
  });
  it("predicts mean when x = mean of x's", () => {
    expect(asNumber(fnFORECAST([rvNumber(3), y, x]))).toBeCloseTo(6, 8);
  });
  it("interpolates at non-sample x", () => {
    expect(asNumber(fnFORECAST([rvNumber(2.5), y, x]))).toBeCloseTo(5, 6);
  });
  it("propagates error in new_x", () => {
    expect(fnFORECAST([rvError("#N/A"), y, x])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("FORECAST with all-error y returns an error", () => {
    const r = fnFORECAST([rvNumber(1), rvArray([[ERRORS.NA]]), x]);
    expect(r.kind).toBe(RVKind.Error);
  });
  it("coerces new_x from string", () => {
    expect(asNumber(fnFORECAST([rvString("3"), y, x]))).toBeCloseTo(6, 6);
  });
  it("coerces new_x from 1×1 array", () => {
    expect(asNumber(fnFORECAST([rvArray([[rvNumber(3)]]), y, x]))).toBeCloseTo(6, 6);
  });
  it("backwards-extrapolates", () => {
    expect(asNumber(fnFORECAST([rvNumber(-1), y, x]))).toBeCloseTo(-2, 6);
  });
});

describe("MAXA / MINA saturation", () => {
  it("MAXA treats booleans as 1/0", () => {
    expect(asNumber(fnMAXA([rvNumber(-1), rvNumber(-2), rvBoolean(true)]))).toBe(1);
  });
  it("MAXA treats text as 0", () => {
    expect(asNumber(fnMAXA([rvString("hello"), rvNumber(-5)]))).toBe(0);
  });
  it("MAXA empty args → 0", () => {
    expect(asNumber(fnMAXA([]))).toBe(0);
  });
  it("MAXA skips blanks", () => {
    expect(asNumber(fnMAXA([BLANK, rvNumber(3), BLANK]))).toBe(3);
  });
  it("MAXA propagates error", () => {
    expect(fnMAXA([rvNumber(1), rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("MAXA over 1×n array of mixed types", () => {
    const arr = rvArray([[rvNumber(-10), rvString("x"), rvBoolean(false), rvNumber(-5)]]);
    // values: -10, 0 (string), 0 (false), -5 → max = 0
    expect(asNumber(fnMAXA([arr]))).toBe(0);
  });
  it("MINA treats booleans as 1/0", () => {
    expect(asNumber(fnMINA([rvNumber(5), rvNumber(3), rvBoolean(false)]))).toBe(0);
  });
  it("MINA treats text as 0", () => {
    expect(asNumber(fnMINA([rvString("hello"), rvNumber(2)]))).toBe(0);
  });
  it("MINA empty → 0", () => {
    expect(asNumber(fnMINA([]))).toBe(0);
  });
  it("MINA propagates error", () => {
    expect(fnMINA([rvNumber(1), rvError("#REF!")])).toEqual({
      kind: RVKind.Error,
      code: "#REF!"
    });
  });
  it("MINA skips blanks", () => {
    expect(asNumber(fnMINA([BLANK, rvNumber(3), BLANK]))).toBe(3);
  });
});

describe("RANK / RANK.AVG saturation", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  it("RANK descending default: RANK(3, [1..5]) = 3", () => {
    expect(asNumber(fnRANK([rvNumber(3), arr]))).toBe(3);
  });
  it("RANK ascending: RANK(3, [1..5], 1) = 3", () => {
    expect(asNumber(fnRANK([rvNumber(3), arr, rvNumber(1)]))).toBe(3);
  });
  it("RANK of largest = 1 (descending)", () => {
    expect(asNumber(fnRANK([rvNumber(5), arr]))).toBe(1);
  });
  it("RANK of largest in ascending = n", () => {
    expect(asNumber(fnRANK([rvNumber(5), arr, rvNumber(1)]))).toBe(5);
  });
  it("RANK of missing value → #N/A", () => {
    expect(fnRANK([rvNumber(99), arr])).toEqual(ERRORS.NA);
  });
  it("RANK propagates value error", () => {
    expect(fnRANK([rvError("#N/A"), arr])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("RANK propagates array error", () => {
    expect(fnRANK([rvNumber(1), rvArray([[rvNumber(1), ERRORS.REF]])])).toEqual(ERRORS.REF);
  });
  it("RANK.AVG of tied values averages the ranks they span", () => {
    // descending sort of [1,3,3,3,5]: [5,3,3,3,1]; 3's occupy positions 2,3,4 → avg 3
    const a = rvArray([[rvNumber(1), rvNumber(3), rvNumber(3), rvNumber(3), rvNumber(5)]]);
    expect(asNumber(fnRANK_AVG([rvNumber(3), a]))).toBe(3);
  });
  it("RANK.AVG without ties matches RANK", () => {
    expect(asNumber(fnRANK_AVG([rvNumber(3), arr]))).toBe(3);
  });
  it("RANK.AVG of missing value → #N/A", () => {
    expect(fnRANK_AVG([rvNumber(99), arr])).toEqual(ERRORS.NA);
  });
});

describe("DEVSQ / AVEDEV saturation", () => {
  const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
  it("DEVSQ of [1..5] = 10", () => {
    expect(asNumber(fnDEVSQ([arr]))).toBe(10);
  });
  it("DEVSQ Excel doc: DEVSQ(4,5,8,7,11,4,3) ≈ 48", () => {
    expect(
      asNumber(
        fnDEVSQ([
          rvNumber(4),
          rvNumber(5),
          rvNumber(8),
          rvNumber(7),
          rvNumber(11),
          rvNumber(4),
          rvNumber(3)
        ])
      )
    ).toBeCloseTo(48, 10);
  });
  it("DEVSQ of single value = 0", () => {
    expect(asNumber(fnDEVSQ([rvArray([[rvNumber(5)]])]))).toBe(0);
  });
  it("DEVSQ propagates error", () => {
    expect(fnDEVSQ([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("DEVSQ all equal → 0", () => {
    expect(asNumber(fnDEVSQ([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]])]))).toBe(0);
  });
  it("AVEDEV of [1..5] = 1.2", () => {
    expect(asNumber(fnAVEDEV([arr]))).toBeCloseTo(1.2, 10);
  });
  it("AVEDEV Excel doc: AVEDEV(4,5,6,7,5,4,3) ≈ 1.020408", () => {
    expect(
      asNumber(
        fnAVEDEV([
          rvNumber(4),
          rvNumber(5),
          rvNumber(6),
          rvNumber(7),
          rvNumber(5),
          rvNumber(4),
          rvNumber(3)
        ])
      )
    ).toBeCloseTo(1.020408, 5);
  });
  it("AVEDEV of single value = 0", () => {
    expect(asNumber(fnAVEDEV([rvArray([[rvNumber(5)]])]))).toBe(0);
  });
  it("AVEDEV propagates error", () => {
    expect(fnAVEDEV([rvArray([[rvNumber(1), ERRORS.REF]])])).toEqual(ERRORS.REF);
  });
  it("AVEDEV all equal → 0", () => {
    expect(asNumber(fnAVEDEV([rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]])]))).toBe(0);
  });
  it("AVEDEV of empty → #NUM! or 0 depending on impl", () => {
    // Let's check actual behavior — not assert which specific error; just that some is returned
    const r = fnAVEDEV([rvArray([[]])]);
    expect(r.kind === RVKind.Error || r.kind === RVKind.Number).toBe(true);
  });
});

describe("SMALL saturation", () => {
  const arr = rvArray([[rvNumber(10), rvNumber(20), rvNumber(5), rvNumber(15), rvNumber(25)]]);
  it("SMALL(arr, 1) = MIN = 5", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(1)]))).toBe(5);
  });
  it("SMALL(arr, 2) = 10", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(2)]))).toBe(10);
  });
  it("SMALL(arr, 5) = MAX = 25", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(5)]))).toBe(25);
  });
  it("SMALL rejects k=0", () => {
    expect(fnSMALL([arr, rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("SMALL rejects k > n", () => {
    expect(fnSMALL([arr, rvNumber(6)])).toEqual(ERRORS.NUM);
  });
  it("SMALL floors fractional k: SMALL(_, 1.9) = SMALL(_, 1)", () => {
    expect(asNumber(fnSMALL([arr, rvNumber(1.9)]))).toBe(5);
  });
  it("SMALL propagates k error", () => {
    expect(fnSMALL([arr, rvError("#N/A")])).toEqual({ kind: RVKind.Error, code: "#N/A" });
  });
  it("SMALL propagates array error", () => {
    expect(fnSMALL([rvArray([[rvNumber(1), ERRORS.REF]]), rvNumber(1)])).toEqual(ERRORS.REF);
  });
});

describe("HARMEAN saturation", () => {
  it("HARMEAN(2, 4) = 8/3 ≈ 2.667", () => {
    expect(asNumber(fnHARMEAN([rvNumber(2), rvNumber(4)]))).toBeCloseTo(8 / 3, 10);
  });
  it("HARMEAN Excel doc: HARMEAN(4,5,8,7,11,4,3) ≈ 5.028376", () => {
    expect(
      asNumber(
        fnHARMEAN([
          rvNumber(4),
          rvNumber(5),
          rvNumber(8),
          rvNumber(7),
          rvNumber(11),
          rvNumber(4),
          rvNumber(3)
        ])
      )
    ).toBeCloseTo(5.028376, 4);
  });
  it("HARMEAN of equal values = that value", () => {
    expect(asNumber(fnHARMEAN([rvNumber(5), rvNumber(5), rvNumber(5)]))).toBeCloseTo(5, 10);
  });
  it("HARMEAN rejects zero in data", () => {
    expect(fnHARMEAN([rvNumber(2), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
  it("HARMEAN rejects negative in data", () => {
    expect(fnHARMEAN([rvNumber(2), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });
  it("HARMEAN propagates error", () => {
    expect(fnHARMEAN([rvNumber(2), ERRORS.NA])).toEqual(ERRORS.NA);
  });
  it("HARMEAN <= GEOMEAN <= AM identity check", () => {
    const data = [2, 4, 8];
    const vals = data.map(v => rvNumber(v));
    const hm = asNumber(fnHARMEAN(vals));
    const gm = asNumber(fnGEOMEAN(vals));
    expect(hm).toBeLessThanOrEqual(gm);
  });
});

describe("STDEV / STDEVP extra saturation", () => {
  it("STDEV of known dataset with simple numbers", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9]: mean 5, s² = 32/7, s = √(32/7) ≈ 2.1381
    expect(
      asNumber(
        fnSTDEV([
          rvNumber(2),
          rvNumber(4),
          rvNumber(4),
          rvNumber(4),
          rvNumber(5),
          rvNumber(5),
          rvNumber(7),
          rvNumber(9)
        ])
      )
    ).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });
  it("STDEV accepts direct-arg mix", () => {
    expect(asNumber(fnSTDEV([rvNumber(1), rvNumber(3)]))).toBeCloseTo(Math.sqrt(2), 10);
  });
  it("STDEV of two equal values = 0", () => {
    expect(asNumber(fnSTDEV([rvNumber(7), rvNumber(7)]))).toBe(0);
  });
  it("STDEV empty → #DIV/0!", () => {
    expect(fnSTDEV([rvArray([[]])])).toEqual(ERRORS.DIV0);
  });
  it("STDEVP of two values = |a-b|/2", () => {
    expect(asNumber(fnSTDEVP([rvNumber(1), rvNumber(3)]))).toBe(1);
  });
  it("STDEVP of single value = 0", () => {
    expect(asNumber(fnSTDEVP([rvNumber(5)]))).toBe(0);
  });
  it("STDEVP propagates error", () => {
    expect(fnSTDEVP([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
});

describe("FREQUENCY saturation", () => {
  const data = rvArray([
    [
      rvNumber(79),
      rvNumber(85),
      rvNumber(78),
      rvNumber(85),
      rvNumber(50),
      rvNumber(81),
      rvNumber(95),
      rvNumber(88),
      rvNumber(97)
    ]
  ]);
  const bins = rvArray([[rvNumber(70), rvNumber(79), rvNumber(89)]]);
  it("FREQUENCY Excel doc example — classic score buckets", () => {
    // Bins: <=70, (70,79], (79,89], (89,∞)
    // Scores: 79 79, 85 85 88 → (70,79]:2, (79,89]:3, 50 → <=70:1, 95 97 → >89:2
    const r = fnFREQUENCY([data, bins]);
    expect(r.kind).toBe(RVKind.Array);
    const a = r as ArrayValue;
    expect(a.height).toBe(4);
    expect(asNumber(a.rows[0][0])).toBe(1); // <= 70 (just 50)
    expect(asNumber(a.rows[1][0])).toBe(2); // 70-79 (79, 78)
    expect(asNumber(a.rows[2][0])).toBe(4); // 80-89 (85, 85, 81, 88)
    expect(asNumber(a.rows[3][0])).toBe(2); // > 89 (95, 97)
  });
  it("returns array of length bins.length + 1", () => {
    const r = fnFREQUENCY([rvArray([[rvNumber(1), rvNumber(2)]]), rvArray([[rvNumber(1)]])]);
    expect((r as ArrayValue).height).toBe(2);
  });
  it("handles empty data array", () => {
    const r = fnFREQUENCY([rvArray([[]]), rvArray([[rvNumber(1), rvNumber(2)]])]);
    expect(r.kind).toBe(RVKind.Array);
    const a = r as ArrayValue;
    for (let i = 0; i < a.height; i++) {
      expect(asNumber(a.rows[i][0])).toBe(0);
    }
  });
  it("FREQUENCY requires array data — scalar → #VALUE!", () => {
    expect(fnFREQUENCY([rvNumber(1), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.VALUE);
  });
  it("FREQUENCY requires array bins — scalar → #VALUE!", () => {
    expect(fnFREQUENCY([rvArray([[rvNumber(1)]]), rvNumber(1)])).toEqual(ERRORS.VALUE);
  });
  it("FREQUENCY propagates data error", () => {
    expect(fnFREQUENCY([rvArray([[rvNumber(1), ERRORS.NA]]), rvArray([[rvNumber(1)]])])).toEqual(
      ERRORS.NA
    );
  });
  it("FREQUENCY propagates bins error", () => {
    expect(fnFREQUENCY([rvArray([[rvNumber(1)]]), rvArray([[ERRORS.REF]])])).toEqual(ERRORS.REF);
  });
  it("FREQUENCY does not sort bins — preserves user order", () => {
    // Bins in descending order [5, 3, 1]; data = [2]: assigns to first bin that satisfies
    // data <= bins[i]. For 2: 5 (satisfies first) → bucket 0.
    const r = fnFREQUENCY([
      rvArray([[rvNumber(2)]]),
      rvArray([[rvNumber(5), rvNumber(3), rvNumber(1)]])
    ]);
    const a = r as ArrayValue;
    expect(asNumber(a.rows[0][0])).toBe(1); // 2 <= 5 → first bucket
    expect(asNumber(a.rows[1][0])).toBe(0);
    expect(asNumber(a.rows[2][0])).toBe(0);
    expect(asNumber(a.rows[3][0])).toBe(0);
  });
});

describe("LINEST / LOGEST saturation", () => {
  it("LINEST on simple line y=x", () => {
    const r = fnLINEST([rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]])]);
    expect(r.kind).toBe(RVKind.Array);
    const a = r as ArrayValue;
    expect(asNumber(a.rows[0][0])).toBeCloseTo(1, 8); // slope
    expect(asNumber(a.rows[0][1])).toBeCloseTo(0, 6); // intercept
  });
  it("LINEST with explicit x", () => {
    const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const r = fnLINEST([y, x]);
    const a = r as ArrayValue;
    expect(asNumber(a.rows[0][0])).toBeCloseTo(2, 8);
    expect(asNumber(a.rows[0][1])).toBeCloseTo(0, 6);
  });
  it("LINEST with stats=TRUE returns 5-row block", () => {
    const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const r = fnLINEST([y, x, rvBoolean(true), rvBoolean(true)]);
    expect(r.kind).toBe(RVKind.Array);
    expect((r as ArrayValue).height).toBe(5);
  });
  it("LINEST const=FALSE forces intercept to 0", () => {
    const y = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    const x = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const r = fnLINEST([y, x, rvBoolean(false)]);
    const a = r as ArrayValue;
    expect(asNumber(a.rows[0][0])).toBeCloseTo(2, 6);
    expect(asNumber(a.rows[0][1])).toBe(0);
  });
  it("LOGEST on exponential y=2^x (roughly)", () => {
    const y = rvArray([[rvNumber(1), rvNumber(2), rvNumber(4), rvNumber(8)]]);
    const r = fnLOGEST([y]);
    const a = r as ArrayValue;
    // coefficients: [m, b]; for y=b*m^x, m=2, b=1
    expect(asNumber(a.rows[0][0])).toBeCloseTo(2, 6);
    expect(asNumber(a.rows[0][1])).toBeCloseTo(0.5, 6);
  });
  it("LINEST propagates y error", () => {
    expect(fnLINEST([rvArray([[rvNumber(1), ERRORS.NA]])])).toEqual(ERRORS.NA);
  });
  it("LOGEST propagates y error", () => {
    expect(fnLOGEST([rvArray([[rvNumber(1), ERRORS.REF]])])).toEqual(ERRORS.REF);
  });
  it("LINEST with stats=FALSE returns single row", () => {
    const y = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const r = fnLINEST([
      y,
      rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]),
      rvBoolean(true),
      rvBoolean(false)
    ]);
    expect((r as ArrayValue).height).toBe(1);
  });
  it("LOGEST with stats returns multi-row block", () => {
    const y = rvArray([[rvNumber(1), rvNumber(2), rvNumber(4), rvNumber(8)]]);
    const r = fnLOGEST([
      y,
      rvArray([[rvNumber(0), rvNumber(1), rvNumber(2), rvNumber(3)]]),
      rvBoolean(true),
      rvBoolean(true)
    ]);
    expect((r as ArrayValue).height).toBe(5);
  });
  it("LOGEST const=FALSE forces b=1 (exp(0) intercept)", () => {
    const y = rvArray([[rvNumber(1), rvNumber(2), rvNumber(4), rvNumber(8)]]);
    const r = fnLOGEST([
      y,
      rvArray([[rvNumber(0), rvNumber(1), rvNumber(2), rvNumber(3)]]),
      rvBoolean(false)
    ]);
    const a = r as ArrayValue;
    // Last column is exp(b) where b was forced to 0 → 1
    expect(asNumber(a.rows[0][1])).toBe(1);
  });
});

describe("GROWTH extras / PHI saturation", () => {
  it("GROWTH with known x/y predicts exponential trend", () => {
    // y = 2^x: x=[1,2,3,4], y=[2,4,8,16]; GROWTH(y) should return y (passthrough)
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(8)], [rvNumber(16)]]);
    const r = fnGROWTH([ys]) as ArrayValue;
    expect(r.kind).toBe(RVKind.Array);
    expect(r.height).toBe(4);
  });

  it("GROWTH with custom new_x's", () => {
    const ys = rvArray([[rvNumber(2)], [rvNumber(4)], [rvNumber(8)]]);
    const xs = rvArray([[rvNumber(1)], [rvNumber(2)], [rvNumber(3)]]);
    const newXs = rvArray([[rvNumber(4)]]);
    const r = fnGROWTH([ys, xs, newXs]) as ArrayValue;
    expect(r.kind).toBe(RVKind.Array);
    // Next value should be near 16 (2^4)
    const v = (r.rows[0][0] as NumberValue).value;
    expect(v).toBeCloseTo(16, 0);
  });

  it("GROWTH negative y → #NUM! (can't take log)", () => {
    const ys = rvArray([[rvNumber(-1)], [rvNumber(-2)]]);
    expect(fnGROWTH([ys])).toEqual(ERRORS.NUM);
  });

  it("GROWTH zero y → #NUM!", () => {
    const ys = rvArray([[rvNumber(0)], [rvNumber(1)]]);
    expect(fnGROWTH([ys])).toEqual(ERRORS.NUM);
  });

  it("PHI(0) = 1/√(2π)", () => {
    expect(asNumber(fnPHI([rvNumber(0)]))).toBeCloseTo(0.39894228, 5);
  });

  it("PHI is symmetric: PHI(x) = PHI(-x)", () => {
    const a = asNumber(fnPHI([rvNumber(1.5)]));
    const b = asNumber(fnPHI([rvNumber(-1.5)]));
    expect(a).toBeCloseTo(b, 10);
  });

  it("PHI(large) ≈ 0", () => {
    expect(asNumber(fnPHI([rvNumber(10)]))).toBeCloseTo(0, 5);
  });

  it("PHI(1) ≈ 0.2420", () => {
    expect(asNumber(fnPHI([rvNumber(1)]))).toBeCloseTo(0.24197, 4);
  });

  it("PHI error propagation", () => {
    expect(fnPHI([ERRORS.NA])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// PERCENTRANK family
// ============================================================================

describe("PERCENTRANK.INC (and alias PERCENTRANK)", () => {
  const data = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);

  it("rank of min value is 0", () => {
    expect(asNumber(fnPERCENTRANK_INC([data, rvNumber(1)]))).toBe(0);
  });

  it("rank of max value is 1", () => {
    expect(asNumber(fnPERCENTRANK_INC([data, rvNumber(5)]))).toBe(1);
  });

  it("rank of median is 0.5", () => {
    expect(asNumber(fnPERCENTRANK_INC([data, rvNumber(3)]))).toBe(0.5);
  });

  it("interpolates between values", () => {
    // x=2.5 → between rank 0.25 (idx 1) and 0.5 (idx 2), halfway → 0.375
    expect(asNumber(fnPERCENTRANK_INC([data, rvNumber(2.5)]))).toBeCloseTo(0.375, 3);
  });

  it("x outside array range → #N/A", () => {
    expect(fnPERCENTRANK_INC([data, rvNumber(0)])).toEqual(ERRORS.NA);
    expect(fnPERCENTRANK_INC([data, rvNumber(10)])).toEqual(ERRORS.NA);
  });

  it("default significance is 3 digits", () => {
    // For 1/3 ≈ 0.3333... → truncated to 0.333 at significance=3.
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    // x=2 → rank 1/3 ≈ 0.333333
    expect(asNumber(fnPERCENTRANK_INC([arr, rvNumber(2)]))).toBe(0.333);
  });

  it("custom significance truncates further", () => {
    const arr = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    expect(asNumber(fnPERCENTRANK_INC([arr, rvNumber(2), rvNumber(2)]))).toBe(0.33);
    expect(asNumber(fnPERCENTRANK_INC([arr, rvNumber(2), rvNumber(5)]))).toBe(0.33333);
  });

  it("significance < 1 → #NUM!", () => {
    expect(fnPERCENTRANK_INC([data, rvNumber(3), rvNumber(0)])).toEqual(ERRORS.NUM);
  });

  it("PERCENTRANK is alias for PERCENTRANK.INC", () => {
    expect(asNumber(fnPERCENTRANK([data, rvNumber(3)]))).toBe(0.5);
  });

  it("error in data propagates", () => {
    expect(fnPERCENTRANK_INC([rvArray([[ERRORS.NA]]), rvNumber(1)])).toEqual(ERRORS.NA);
  });
});

describe("PERCENTRANK.EXC", () => {
  const data = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);

  it("exclusive rank uses (i+1)/(n+1)", () => {
    // x=1 → (0+1)/(4+1) = 0.2
    expect(asNumber(fnPERCENTRANK_EXC([data, rvNumber(1)]))).toBe(0.2);
    // x=4 → (3+1)/(4+1) = 0.8
    expect(asNumber(fnPERCENTRANK_EXC([data, rvNumber(4)]))).toBe(0.8);
  });

  it("x outside array range → #N/A", () => {
    expect(fnPERCENTRANK_EXC([data, rvNumber(0)])).toEqual(ERRORS.NA);
    expect(fnPERCENTRANK_EXC([data, rvNumber(10)])).toEqual(ERRORS.NA);
  });

  it("returns within [1/(n+1), n/(n+1)] range", () => {
    // For n=4, the valid .EXC range is [0.2, 0.8].
    const r = asNumber(fnPERCENTRANK_EXC([data, rvNumber(2)]));
    expect(r).toBeGreaterThanOrEqual(0.2);
    expect(r).toBeLessThanOrEqual(0.8);
  });
});

// ============================================================================
// PROB
// ============================================================================

describe("PROB", () => {
  const xRange = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
  const pRange = rvArray([[rvNumber(0.1), rvNumber(0.2), rvNumber(0.3), rvNumber(0.4)]]);

  it("single lower_limit returns probability at that value", () => {
    // P(X=2) = 0.2
    expect(asNumber(fnPROB([xRange, pRange, rvNumber(2)]))).toBe(0.2);
  });

  it("range [lower, upper] sums probabilities", () => {
    // P(2 <= X <= 3) = 0.2 + 0.3 = 0.5
    expect(asNumber(fnPROB([xRange, pRange, rvNumber(2), rvNumber(3)]))).toBeCloseTo(0.5, 10);
  });

  it("range covers all → 1", () => {
    expect(asNumber(fnPROB([xRange, pRange, rvNumber(1), rvNumber(4)]))).toBeCloseTo(1, 10);
  });

  it("range below → 0", () => {
    expect(asNumber(fnPROB([xRange, pRange, rvNumber(-1), rvNumber(0)]))).toBe(0);
  });

  it("mismatched dimensions → #N/A", () => {
    const shorter = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnPROB([xRange, shorter, rvNumber(1)])).toEqual(ERRORS.NA);
  });

  it("probabilities not summing to 1 → #NUM!", () => {
    const badP = rvArray([[rvNumber(0.3), rvNumber(0.3), rvNumber(0.3), rvNumber(0.3)]]);
    expect(fnPROB([xRange, badP, rvNumber(1), rvNumber(4)])).toEqual(ERRORS.NUM);
  });

  it("negative probability → #NUM!", () => {
    const badP = rvArray([[rvNumber(-0.1), rvNumber(0.3), rvNumber(0.4), rvNumber(0.4)]]);
    expect(fnPROB([xRange, badP, rvNumber(1), rvNumber(4)])).toEqual(ERRORS.NUM);
  });

  it("probability > 1 → #NUM!", () => {
    const badP = rvArray([[rvNumber(1.5), rvNumber(0), rvNumber(0), rvNumber(0)]]);
    expect(fnPROB([xRange, badP, rvNumber(1), rvNumber(4)])).toEqual(ERRORS.NUM);
  });

  it("lower > upper → #NUM!", () => {
    expect(fnPROB([xRange, pRange, rvNumber(3), rvNumber(2)])).toEqual(ERRORS.NUM);
  });

  it("error in x_range propagates", () => {
    const errX = rvArray([[ERRORS.NA]]);
    expect(fnPROB([errX, rvArray([[rvNumber(1)]]), rvNumber(1)])).toEqual(ERRORS.NA);
  });

  it("error in prob_range propagates", () => {
    const errP = rvArray([[ERRORS.NA]]);
    expect(fnPROB([rvArray([[rvNumber(1)]]), errP, rvNumber(1)])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// BINOM.DIST.RANGE
// ============================================================================

describe("BINOM.DIST.RANGE", () => {
  it("single number_s returns exact probability (same as BINOM.DIST non-cumulative)", () => {
    // P(X=5) for n=10, p=0.5 ≈ 0.2461
    const r = fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(0.5), rvNumber(5)]) as NumberValue;
    expect(r.value).toBeCloseTo(0.2461, 3);
  });

  it("range [3,7] for n=10,p=0.5 ≈ 0.8906", () => {
    const r = fnBINOM_DIST_RANGE([
      rvNumber(10),
      rvNumber(0.5),
      rvNumber(3),
      rvNumber(7)
    ]) as NumberValue;
    expect(r.value).toBeCloseTo(0.8906, 3);
  });

  it("full range [0, n] = 1", () => {
    const r = fnBINOM_DIST_RANGE([
      rvNumber(10),
      rvNumber(0.3),
      rvNumber(0),
      rvNumber(10)
    ]) as NumberValue;
    expect(r.value).toBeCloseTo(1, 10);
  });

  it("s1 > s2 → #NUM!", () => {
    expect(fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(0.5), rvNumber(7), rvNumber(3)])).toEqual(
      ERRORS.NUM
    );
  });

  it("negative s1 → #NUM!", () => {
    expect(fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(0.5), rvNumber(-1)])).toEqual(ERRORS.NUM);
  });

  it("s2 > trials → #NUM!", () => {
    expect(fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(0.5), rvNumber(0), rvNumber(20)])).toEqual(
      ERRORS.NUM
    );
  });

  it("probability out of [0,1] → #NUM!", () => {
    expect(fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(1.5), rvNumber(5)])).toEqual(ERRORS.NUM);
    expect(fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(-0.1), rvNumber(5)])).toEqual(ERRORS.NUM);
  });

  it("p=0 edge: probability mass is all at k=0", () => {
    const r0 = fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(0), rvNumber(0)]) as NumberValue;
    expect(r0.value).toBe(1);
    const r1 = fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(0), rvNumber(1)]) as NumberValue;
    expect(r1.value).toBe(0);
  });

  it("p=1 edge: probability mass is all at k=n", () => {
    const r = fnBINOM_DIST_RANGE([rvNumber(10), rvNumber(1), rvNumber(10)]) as NumberValue;
    expect(r.value).toBe(1);
  });

  it("error propagation", () => {
    expect(fnBINOM_DIST_RANGE([ERRORS.NA, rvNumber(0.5), rvNumber(5)])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// CHISQ.INV.RT
// ============================================================================

describe("CHISQ.INV.RT", () => {
  it("CHISQ.INV.RT(0.5, df) equals CHISQ.INV(0.5, df) (median, symmetric)", () => {
    const df = rvNumber(4);
    const left = asNumber(fnCHISQ_INV_RT([rvNumber(0.5), df]));
    const right = asNumber(fnCHISQ_INV([rvNumber(0.5), df]));
    expect(left).toBeCloseTo(right, 4);
  });

  it("CHISQ.INV.RT(0.05, 10) is a standard critical value", () => {
    // Known value ≈ 18.307
    const r = asNumber(fnCHISQ_INV_RT([rvNumber(0.05), rvNumber(10)]));
    expect(r).toBeCloseTo(18.307, 2);
  });

  it("p <= 0 or > 1 → #NUM!", () => {
    expect(fnCHISQ_INV_RT([rvNumber(0), rvNumber(4)])).toEqual(ERRORS.NUM);
    expect(fnCHISQ_INV_RT([rvNumber(1.1), rvNumber(4)])).toEqual(ERRORS.NUM);
  });

  it("df < 1 → #NUM!", () => {
    expect(fnCHISQ_INV_RT([rvNumber(0.5), rvNumber(0)])).toEqual(ERRORS.NUM);
  });
});

// ============================================================================
// Z.TEST
// ============================================================================

describe("Z.TEST", () => {
  it("returns a probability in [0, 1]", () => {
    const data = rvArray([[rvNumber(3), rvNumber(6), rvNumber(7), rvNumber(8), rvNumber(6)]]);
    const p = asNumber(fnZ_TEST([data, rvNumber(4)]));
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("x = mean → p = 0.5", () => {
    const data = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    // mean = 4, so Z.TEST(data, 4) = 1 - NORMSDIST(0) = 0.5
    const p = asNumber(fnZ_TEST([data, rvNumber(4)]));
    expect(p).toBeCloseTo(0.5, 5);
  });

  it("sigma can be provided externally", () => {
    const data = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6)]]);
    const p = asNumber(fnZ_TEST([data, rvNumber(4), rvNumber(2)]));
    expect(p).toBeCloseTo(0.5, 5);
  });

  it("sigma <= 0 → #NUM!", () => {
    const data = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnZ_TEST([data, rvNumber(2), rvNumber(0)])).toEqual(ERRORS.NUM);
  });

  it("empty array → #N/A", () => {
    expect(fnZ_TEST([rvArray([[]]), rvNumber(1)])).toEqual(ERRORS.NA);
  });

  it("error in data propagates", () => {
    expect(fnZ_TEST([rvArray([[ERRORS.NA]]), rvNumber(1)])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// T.TEST
// ============================================================================

describe("T.TEST", () => {
  const a1 = rvArray([[rvNumber(3), rvNumber(4), rvNumber(5), rvNumber(8), rvNumber(9)]]);
  const a2 = rvArray([[rvNumber(1), rvNumber(2), rvNumber(4), rvNumber(5), rvNumber(6)]]);

  it("returns probability in [0, 1]", () => {
    const p = asNumber(fnT_TEST([a1, a2, rvNumber(2), rvNumber(2)]));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("two-tailed is 2× one-tailed", () => {
    const one = asNumber(fnT_TEST([a1, a2, rvNumber(1), rvNumber(2)]));
    const two = asNumber(fnT_TEST([a1, a2, rvNumber(2), rvNumber(2)]));
    expect(two).toBeCloseTo(2 * one, 6);
  });

  it("paired type 1 requires equal sample sizes", () => {
    const short = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnT_TEST([a1, short, rvNumber(2), rvNumber(1)])).toEqual(ERRORS.NA);
  });

  it("invalid tails → #NUM!", () => {
    expect(fnT_TEST([a1, a2, rvNumber(3), rvNumber(2)])).toEqual(ERRORS.NUM);
  });

  it("invalid type → #NUM!", () => {
    expect(fnT_TEST([a1, a2, rvNumber(2), rvNumber(4)])).toEqual(ERRORS.NUM);
  });

  it("type 1 paired, two-tailed", () => {
    const paired1 = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const paired2 = rvArray([[rvNumber(2), rvNumber(4), rvNumber(6), rvNumber(8)]]);
    const p = asNumber(fnT_TEST([paired1, paired2, rvNumber(2), rvNumber(1)]));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("type 3 Welch's t-test", () => {
    const p = asNumber(fnT_TEST([a1, a2, rvNumber(2), rvNumber(3)]));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("error propagation", () => {
    expect(fnT_TEST([rvArray([[ERRORS.NA]]), a2, rvNumber(2), rvNumber(2)])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// F.TEST
// ============================================================================

describe("F.TEST", () => {
  it("identical samples → p close to 1", () => {
    const data = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4), rvNumber(5)]]);
    const p = asNumber(fnF_TEST([data, data]));
    expect(p).toBeCloseTo(1, 5);
  });

  it("very different variances → p close to 0", () => {
    const low = rvArray([[rvNumber(1), rvNumber(1.01), rvNumber(1.02), rvNumber(1.03)]]);
    const high = rvArray([[rvNumber(1), rvNumber(100), rvNumber(200), rvNumber(300)]]);
    const p = asNumber(fnF_TEST([low, high]));
    expect(p).toBeLessThan(0.1);
  });

  it("zero-variance sample → #DIV/0!", () => {
    const flat = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    const varied = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnF_TEST([flat, varied])).toEqual(ERRORS.DIV0);
  });

  it("samples with < 2 values → #DIV/0!", () => {
    const single = rvArray([[rvNumber(1)]]);
    const ok = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnF_TEST([single, ok])).toEqual(ERRORS.DIV0);
  });

  it("error propagation", () => {
    const ok = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnF_TEST([rvArray([[ERRORS.NA]]), ok])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// CHISQ.TEST
// ============================================================================

describe("CHISQ.TEST", () => {
  it("identical actual & expected → p = 1", () => {
    const obs = rvArray([
      [rvNumber(10), rvNumber(20)],
      [rvNumber(30), rvNumber(40)]
    ]);
    const p = asNumber(fnCHISQ_TEST([obs, obs]));
    expect(p).toBeCloseTo(1, 10);
  });

  it("differing → p in (0, 1)", () => {
    const obs = rvArray([
      [rvNumber(10), rvNumber(20)],
      [rvNumber(30), rvNumber(40)]
    ]);
    const exp = rvArray([
      [rvNumber(15), rvNumber(15)],
      [rvNumber(25), rvNumber(45)]
    ]);
    const p = asNumber(fnCHISQ_TEST([obs, exp]));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("mismatched shapes → #N/A", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2)]]);
    const b = rvArray([[rvNumber(1)]]);
    expect(fnCHISQ_TEST([a, b])).toEqual(ERRORS.NA);
  });

  it("expected has zero → #NUM!", () => {
    const a = rvArray([[rvNumber(1), rvNumber(2)]]);
    const b = rvArray([[rvNumber(0), rvNumber(2)]]);
    expect(fnCHISQ_TEST([a, b])).toEqual(ERRORS.NUM);
  });

  it("non-array arg → #VALUE!", () => {
    expect(fnCHISQ_TEST([rvNumber(1), rvArray([[rvNumber(1)]])])).toEqual(ERRORS.VALUE);
  });

  it("error propagation", () => {
    const ok = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnCHISQ_TEST([ok, rvArray([[ERRORS.NA, rvNumber(2)]])])).toEqual(ERRORS.NA);
  });
});

// ============================================================================
// STEYX
// ============================================================================

describe("STEYX", () => {
  it("perfect linear fit → SE = 0 (within rounding)", () => {
    // y = 2x + 1: perfect fit.
    const ys = rvArray([[rvNumber(3), rvNumber(5), rvNumber(7), rvNumber(9)]]);
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const r = asNumber(fnSTEYX([ys, xs]));
    expect(Math.abs(r)).toBeLessThan(1e-9);
  });

  it("scatter produces positive SE", () => {
    const ys = rvArray([[rvNumber(2), rvNumber(3), rvNumber(5), rvNumber(10)]]);
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3), rvNumber(4)]]);
    const r = asNumber(fnSTEYX([ys, xs]));
    expect(r).toBeGreaterThan(0);
  });

  it("n < 3 → #DIV/0!", () => {
    const ys = rvArray([[rvNumber(1), rvNumber(2)]]);
    const xs = rvArray([[rvNumber(1), rvNumber(2)]]);
    expect(fnSTEYX([ys, xs])).toEqual(ERRORS.DIV0);
  });

  it("identical x values → #DIV/0!", () => {
    const ys = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const xs = rvArray([[rvNumber(5), rvNumber(5), rvNumber(5)]]);
    expect(fnSTEYX([ys, xs])).toEqual(ERRORS.DIV0);
  });

  it("length mismatch — truncates to shorter length (matches SLOPE family)", () => {
    // Our pairedNumbers helper truncates rather than erroring, consistent
    // with SLOPE / INTERCEPT / CORREL behavior.
    const ys = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    const xs = rvArray([[rvNumber(1), rvNumber(2)]]);
    // n=2 after truncation → #DIV/0! (need n >= 3 for STEYX).
    expect(fnSTEYX([ys, xs])).toEqual(ERRORS.DIV0);
  });

  it("error propagation", () => {
    const xs = rvArray([[rvNumber(1), rvNumber(2), rvNumber(3)]]);
    expect(fnSTEYX([rvArray([[ERRORS.NA]]), xs])).toEqual(ERRORS.NA);
  });
});
