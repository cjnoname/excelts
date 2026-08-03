/**
 * Statistical Functions
 *
 * Native RuntimeValue implementations.
 */

import {
  argToNumber,
  flattenAll,
  flattenNumbers,
  firstError,
  forEachNumber
} from "@formula/functions/_shared";
import type {
  RuntimeValue,
  ScalarValue,
  NumberValue,
  ErrorValue,
  ArrayValue
} from "@formula/runtime/values";
import {
  RVKind,
  ERRORS,
  rvNumber,
  rvArray,
  toNumberRV,
  toBooleanRV,
  topLeft,
  isError
} from "@formula/runtime/values";

// ============================================================================
// Local Helpers
// ============================================================================

/**
 * Extract a boolean from a single arg. Returns the boolean or ErrorValue.
 */
function boolArg(
  args: RuntimeValue[],
  idx: number
): { ok: true; value: boolean } | { ok: false; error: ErrorValue } {
  const rv = toBooleanRV(topLeft(args[idx]));
  if (rv.kind === RVKind.Error) {
    return { ok: false, error: rv };
  }
  return { ok: true, value: rv.value };
}

/**
 * Check if an arg is an array.
 */
function isArrayArg(arg: RuntimeValue): boolean {
  return arg.kind === RVKind.Array;
}

// ============================================================================
// MEDIAN, LARGE, SMALL, RANK
// ============================================================================

/**
 * Quickselect: returns the k-th smallest element (0-indexed) of `arr`
 * in-place, in expected O(n) time.
 *
 * Uses Hoare partitioning with a "median of three" pivot choice for
 * resilience against already-sorted and adversarial inputs. The input
 * array is reorganised around the pivot — callers that need the original
 * order must pass a copy.
 */
function quickselect(arr: number[], k: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    // median-of-three pivot
    const mid = (lo + hi) >> 1;
    const a = arr[lo];
    const b = arr[mid];
    const c = arr[hi];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i] < pivot) {
        i++;
      }
      while (arr[j] > pivot) {
        j--;
      }
      if (i <= j) {
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      // pivot settled at k
      return arr[k];
    }
  }
  return arr[k];
}

export function fnMEDIAN(args: RuntimeValue[]): RuntimeValue {
  const values = toNumberArray(args);
  if (!Array.isArray(values)) {
    return values;
  }
  const n = values.length;
  if (n === 0) {
    return ERRORS.NUM;
  }
  const mid = n >> 1;
  if (n % 2 !== 0) {
    return rvNumber(quickselect(values, mid));
  }
  // Even count: average of (n/2 − 1)-th and (n/2)-th smallest. Use
  // quickselect twice — but the second search can be limited to the upper
  // half produced by the first call, since quickselect leaves that region
  // sorted w.r.t. the pivot.
  const hi = quickselect(values, mid);
  // After selecting index `mid`, every element at position < mid is ≤ hi.
  // The lower of the two middle values is the max of that prefix.
  let lo = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < mid; i++) {
    if (values[i] > lo) {
      lo = values[i];
    }
  }
  return rvNumber((lo + hi) / 2);
}

export function fnLARGE(args: RuntimeValue[]): RuntimeValue {
  const nums = flattenNumbers([args[0]]);
  const err = firstError(nums);
  if (err) {
    return err;
  }
  const values = (nums as NumberValue[]).map(n => n.value);
  // k can be an array (Excel broadcasts); when it is, return an array
  // with the same shape where each cell holds LARGE at that k.
  if (args[1].kind === RVKind.Array) {
    const kArr = args[1];
    // Sort once when the array contains more than a single cell — k is
    // O(1) afterwards. quickselect per-cell would allocate a fresh
    // `values.slice()` for every k, which quickly becomes quadratic
    // when LARGE(A1:A100, {1;2;3;…}) evaluates over long ranges.
    const totalCells = kArr.height * kArr.width;
    const sortedDesc = totalCells > 1 ? values.slice().sort((a, b) => b - a) : null;
    const outRows: ScalarValue[][] = [];
    for (const row of kArr.rows) {
      const outRow: ScalarValue[] = [];
      for (const cell of row) {
        if (cell.kind === RVKind.Error) {
          outRow.push(cell);
          continue;
        }
        const kn = toNumberRV(cell);
        if (kn.kind === RVKind.Error) {
          outRow.push(kn);
          continue;
        }
        const kInt = Math.floor(kn.value);
        if (kInt < 1 || kInt > values.length) {
          outRow.push(ERRORS.NUM);
          continue;
        }
        if (sortedDesc) {
          outRow.push(rvNumber(sortedDesc[kInt - 1]));
        } else {
          // Single-cell k — quickselect is cheaper than a full sort.
          outRow.push(rvNumber(quickselect(values.slice(), values.length - kInt)));
        }
      }
      outRows.push(outRow);
    }
    return rvArray(outRows);
  }
  const k = argToNumber(args[1]);
  if (k.kind === RVKind.Error) {
    return k;
  }
  const kInt = Math.floor(k.value);
  if (kInt < 1 || kInt > values.length) {
    return ERRORS.NUM;
  }
  return rvNumber(quickselect(values, values.length - kInt));
}

export function fnSMALL(args: RuntimeValue[]): RuntimeValue {
  const nums = flattenNumbers([args[0]]);
  const err = firstError(nums);
  if (err) {
    return err;
  }
  const values = (nums as NumberValue[]).map(n => n.value);
  if (args[1].kind === RVKind.Array) {
    const kArr = args[1];
    // Multi-cell k → sort once ascending, index in O(1). See LARGE for
    // the same optimisation and rationale.
    const totalCells = kArr.height * kArr.width;
    const sortedAsc = totalCells > 1 ? values.slice().sort((a, b) => a - b) : null;
    const outRows: ScalarValue[][] = [];
    for (const row of kArr.rows) {
      const outRow: ScalarValue[] = [];
      for (const cell of row) {
        if (cell.kind === RVKind.Error) {
          outRow.push(cell);
          continue;
        }
        const kn = toNumberRV(cell);
        if (kn.kind === RVKind.Error) {
          outRow.push(kn);
          continue;
        }
        const kInt = Math.floor(kn.value);
        if (kInt < 1 || kInt > values.length) {
          outRow.push(ERRORS.NUM);
          continue;
        }
        if (sortedAsc) {
          outRow.push(rvNumber(sortedAsc[kInt - 1]));
        } else {
          outRow.push(rvNumber(quickselect(values.slice(), kInt - 1)));
        }
      }
      outRows.push(outRow);
    }
    return rvArray(outRows);
  }
  const k = argToNumber(args[1]);
  if (k.kind === RVKind.Error) {
    return k;
  }
  const kInt = Math.floor(k.value);
  if (kInt < 1 || kInt > values.length) {
    return ERRORS.NUM;
  }
  return rvNumber(quickselect(values, kInt - 1));
}

export function fnRANK(args: RuntimeValue[]): RuntimeValue {
  const num = argToNumber(args[0]);
  if (num.kind === RVKind.Error) {
    return num;
  }
  const nums = flattenNumbers([args[1]]);
  const err = firstError(nums);
  if (err) {
    return err;
  }
  const orderRV = args.length > 2 ? argToNumber(args[2]) : rvNumber(0);
  if (orderRV.kind === RVKind.Error) {
    return orderRV;
  }
  const order = orderRV.value;
  const sorted =
    order === 0
      ? (nums as NumberValue[])
          .map(n => n.value)
          .slice()
          .sort((a, b) => b - a)
      : (nums as NumberValue[])
          .map(n => n.value)
          .slice()
          .sort((a, b) => a - b);
  const idx = sorted.indexOf(num.value);
  return idx === -1 ? ERRORS.NA : rvNumber(idx + 1);
}

// ============================================================================
// STDEV, STDEVP, VAR, VARP
// ============================================================================

/**
 * Compute mean and sum of squared deviations from mean. Used by the
 * STDEV/STDEVP/VAR/VARP family to share a single pass through the data.
 * Returns `null` when there is no data at all (callers decide whether that
 * should be `#DIV/0!` or zero given the sample/population convention).
 */
/**
 * Single-pass mean + sum-of-squared-deviations using Welford's online
 * algorithm. Returns `null` when the array is empty.
 *
 * Welford's recurrence keeps the sum of squared deviations numerically
 * stable (avoids the catastrophic cancellation that bites
 * `Σx² - (Σx)²/n` for datasets with a large mean and small variance).
 * Costs one pass rather than two — meaningful on multi-thousand-cell
 * ranges feeding STDEV / VAR / their variants.
 */
function computeMeanAndSumSq(
  nums: readonly number[]
): { n: number; mean: number; sumSq: number } | null {
  const n = nums.length;
  if (n === 0) {
    return null;
  }
  let mean = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = nums[i];
    const delta = x - mean;
    mean += delta / (i + 1);
    // `x - mean` uses the *updated* mean — this product form is the
    // identity that makes Welford's recurrence equal the second-pass
    // `(x - final_mean)²` sum exactly.
    sumSq += delta * (x - mean);
  }
  return { n, mean, sumSq };
}

/** Resolve {args} to `number[]` or an error. Shared by STDEV/VAR family. */
function toNumberArray(args: RuntimeValue[]): number[] | ErrorValue {
  const out: number[] = [];
  const err = forEachNumber(args, n => out.push(n));
  return err ?? out;
}

export function fnSTDEV(args: RuntimeValue[]): RuntimeValue {
  const nums = toNumberArray(args);
  if (!Array.isArray(nums)) {
    return nums;
  }
  const stats = computeMeanAndSumSq(nums);
  if (!stats || stats.n < 2) {
    return ERRORS.DIV0;
  }
  return rvNumber(Math.sqrt(stats.sumSq / (stats.n - 1)));
}

export function fnSTDEVP(args: RuntimeValue[]): RuntimeValue {
  const nums = toNumberArray(args);
  if (!Array.isArray(nums)) {
    return nums;
  }
  const stats = computeMeanAndSumSq(nums);
  if (!stats) {
    return ERRORS.DIV0;
  }
  return rvNumber(Math.sqrt(stats.sumSq / stats.n));
}

export function fnVAR(args: RuntimeValue[]): RuntimeValue {
  const nums = toNumberArray(args);
  if (!Array.isArray(nums)) {
    return nums;
  }
  const stats = computeMeanAndSumSq(nums);
  if (!stats || stats.n < 2) {
    return ERRORS.DIV0;
  }
  return rvNumber(stats.sumSq / (stats.n - 1));
}

export function fnVARP(args: RuntimeValue[]): RuntimeValue {
  const nums = toNumberArray(args);
  if (!Array.isArray(nums)) {
    return nums;
  }
  const stats = computeMeanAndSumSq(nums);
  if (!stats) {
    return ERRORS.DIV0;
  }
  return rvNumber(stats.sumSq / stats.n);
}

// ============================================================================
// Advanced Statistical Functions — private math helpers
// ============================================================================

// Peter Acklam's rational approximation for the standard normal inverse CDF.
// Accuracy: |error| < 1.15e-9 across the full range (0, 1).
function normSInv(p: number): number {
  if (p <= 0 || p >= 1) {
    return NaN;
  }
  if (p < 0.5) {
    return -normSInv(1 - p);
  }
  // Coefficients for rational approximation
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239;

  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;

  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;

  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    // Rational approximation for lower region
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
  if (p <= pHigh) {
    // Rational approximation for central region
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  }
  // Upper region — use symmetry
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
  );
}

// Standard normal CDF approximation (Abramowitz & Stegun 7.1.26). The
// approximation has max error ~7.5e-8 — good enough for GAUSS/NORM.S.DIST
// but it does NOT evaluate to exactly 0.5 at x = 0 (the erf kernel leaves
// a residual ≈ 5e-10). Excel-facing callers expect symmetry around 0, so
// we short-circuit that single point.
function normSDist(x: number): number {
  if (x === 0) {
    return 0.5;
  }
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// Standard normal PDF
function normSPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ============================================================================
// Normal Distribution Functions
// ============================================================================

export function fnNORMSDIST(args: RuntimeValue[]): RuntimeValue {
  const z = argToNumber(args[0]);
  if (z.kind === RVKind.Error) {
    return z;
  }
  // Legacy NORM.S.DIST compatibility: single arg = CDF
  if (args.length > 1) {
    const cum = boolArg(args, 1);
    if (!cum.ok) {
      return cum.error;
    }
    return rvNumber(cum.value ? normSDist(z.value) : normSPdf(z.value));
  }
  return rvNumber(normSDist(z.value));
}

export function fnNORMDIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const mean = argToNumber(args[1]);
  if (mean.kind === RVKind.Error) {
    return mean;
  }
  const stddev = argToNumber(args[2]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  if (stddev.value <= 0) {
    return ERRORS.NUM;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  const zVal = (x.value - mean.value) / stddev.value;
  if (cum.value) {
    return rvNumber(normSDist(zVal));
  }
  return rvNumber(normSPdf(zVal) / stddev.value);
}

export function fnNORMSINV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  if (p.value <= 0 || p.value >= 1) {
    return ERRORS.NUM;
  }
  return rvNumber(normSInv(p.value));
}

export function fnNORMINV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const mean = argToNumber(args[1]);
  if (mean.kind === RVKind.Error) {
    return mean;
  }
  const stddev = argToNumber(args[2]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  if (p.value <= 0 || p.value >= 1 || stddev.value <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber(mean.value + stddev.value * normSInv(p.value));
}

// ============================================================================
// PERCENTILE, QUARTILE, MODE
// ============================================================================

export function fnPERCENTILE(args: RuntimeValue[]): RuntimeValue {
  // Propagate errors from within the range — `flattenNumbers` returns
  // both numbers and errors, and previously we silently filtered errors
  // out by `.kind === Number`, producing a bogus percentile on ranges
  // that contained `#N/A`. Surface the error like AVERAGE / SUM do.
  const raw = flattenNumbers([args[0]]);
  const err = firstError(raw);
  if (err) {
    return err;
  }
  const nums = (raw as NumberValue[]).map(n => n.value);
  const k = argToNumber(args[1]);
  if (k.kind === RVKind.Error) {
    return k;
  }
  if (k.value < 0 || k.value > 1 || nums.length === 0) {
    return ERRORS.NUM;
  }
  nums.sort((a, b) => a - b);
  const n = nums.length;
  if (n === 1) {
    return rvNumber(nums[0]);
  }
  const rank = k.value * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const frac = rank - lower;
  return rvNumber(nums[lower] + frac * (nums[upper] - nums[lower]));
}

export function fnPERCENTILEEXC(args: RuntimeValue[]): RuntimeValue {
  const raw = flattenNumbers([args[0]]);
  const err = firstError(raw);
  if (err) {
    return err;
  }
  const nums = (raw as NumberValue[]).map(n => n.value);
  const k = argToNumber(args[1]);
  if (k.kind === RVKind.Error) {
    return k;
  }
  const n = nums.length;
  if (k.value <= 0 || k.value >= 1 || n === 0) {
    return ERRORS.NUM;
  }
  if (k.value < 1 / (n + 1) || k.value > n / (n + 1)) {
    return ERRORS.NUM;
  }
  nums.sort((a, b) => a - b);
  const rank = k.value * (n + 1) - 1;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const frac = rank - lower;
  return rvNumber(
    nums[Math.max(0, lower)] + frac * (nums[Math.min(n - 1, upper)] - nums[Math.max(0, lower)])
  );
}

export function fnQUARTILE(args: RuntimeValue[]): RuntimeValue {
  const quart = argToNumber(args[1]);
  if (quart.kind === RVKind.Error) {
    return quart;
  }
  if (quart.value < 0 || quart.value > 4) {
    return ERRORS.NUM;
  }
  return fnPERCENTILE([args[0], rvNumber(quart.value / 4)]);
}

export function fnQUARTILEEXC(args: RuntimeValue[]): RuntimeValue {
  const quart = argToNumber(args[1]);
  if (quart.kind === RVKind.Error) {
    return quart;
  }
  if (quart.value < 1 || quart.value > 3) {
    return ERRORS.NUM;
  }
  return fnPERCENTILEEXC([args[0], rvNumber(quart.value / 4)]);
}

export function fnMODE(args: RuntimeValue[]): RuntimeValue {
  const all = flattenNumbers(args);
  const err = firstError(all);
  if (err) {
    return err;
  }
  const nums = (all as NumberValue[]).map(n => n.value);
  if (nums.length === 0) {
    return ERRORS.NA;
  }
  const counts = new Map<number, number>();
  let maxCount = 0;
  let mode = nums[0];
  for (const n of nums) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > maxCount) {
      maxCount = c;
      mode = n;
    }
  }
  return maxCount > 1 ? rvNumber(mode) : ERRORS.NA;
}

/**
 * MODE.MULT — returns a vertical array of every mode (dynamic array).
 * When the dataset is multimodal Excel spills all of them; for a single
 * mode it behaves like MODE.SNGL.
 */
export function fnMODE_MULT(args: RuntimeValue[]): RuntimeValue {
  const all = flattenNumbers(args);
  const err = firstError(all);
  if (err) {
    return err;
  }
  const nums = (all as NumberValue[]).map(n => n.value);
  if (nums.length === 0) {
    return ERRORS.NA;
  }
  const counts = new Map<number, number>();
  for (const n of nums) {
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let maxCount = 0;
  for (const c of counts.values()) {
    if (c > maxCount) {
      maxCount = c;
    }
  }
  if (maxCount < 2) {
    return ERRORS.NA;
  }
  // Preserve first-occurrence order as Excel does (not sorted).
  const seen = new Set<number>();
  const modes: number[] = [];
  for (const n of nums) {
    if (!seen.has(n) && counts.get(n) === maxCount) {
      seen.add(n);
      modes.push(n);
    }
  }
  return rvArray(modes.map(m => [rvNumber(m)]));
}

// ============================================================================
// Paired-array functions: CORREL, SLOPE, INTERCEPT, RSQ, FORECAST
// ============================================================================

/**
 * Extract matching pairs of numbers from two array arguments, filtering to
 * numeric cells only (matching Excel's CORREL/SLOPE/INTERCEPT conventions).
 * Returns the shorter prefix-length pair aligned by position.
 */
function pairedNumbers(
  args: RuntimeValue[],
  aIdx: number,
  bIdx: number
): { xs: number[]; ys: number[] } | ErrorValue {
  // Walk both ranges in lockstep so the x/y pairing preserves the
  // source position. Excel's CORREL / SLOPE / INTERCEPT skip any pair
  // where either side is non-numeric (text, blank, boolean) — they do
  // NOT drop the non-numeric cells from one side and then pair by
  // surviving position, which would realign unrelated values.
  const aArg = args[aIdx];
  const bArg = args[bIdx];
  const aCells: ScalarValue[] = [];
  const bCells: ScalarValue[] = [];
  collectCells(aArg, aCells);
  collectCells(bArg, bCells);
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(aCells.length, bCells.length);
  for (let i = 0; i < n; i++) {
    const a = aCells[i];
    const b = bCells[i];
    if (a.kind === RVKind.Error) {
      return a;
    }
    if (b.kind === RVKind.Error) {
      return b;
    }
    if (a.kind === RVKind.Number && b.kind === RVKind.Number) {
      xs.push(a.value);
      ys.push(b.value);
    }
  }
  return { xs, ys };
}

/** Walk a runtime value and push every scalar cell (in row-major order). */
function collectCells(arg: RuntimeValue, out: ScalarValue[]): void {
  if (arg.kind === RVKind.Array) {
    for (const row of arg.rows) {
      for (const cell of row) {
        out.push(cell);
      }
    }
  } else if (arg.kind !== RVKind.Reference && arg.kind !== RVKind.Lambda) {
    out.push(arg);
  }
}

/**
 * Compute paired-array sums used by the simple linear regression family.
 * Returns null when either input is empty. Callers determine whether
 * n < 2 is #DIV/0! or acceptable.
 */
interface PairedSums {
  n: number;
  meanX: number;
  meanY: number;
  /** Σ (xᵢ − x̄)(yᵢ − ȳ) */
  sxy: number;
  /** Σ (xᵢ − x̄)² */
  sxx: number;
  /** Σ (yᵢ − ȳ)² */
  syy: number;
}
function pairedSums(xs: readonly number[], ys: readonly number[]): PairedSums | null {
  const n = xs.length;
  if (n === 0) {
    return null;
  }
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return { n, meanX, meanY, sxy, sxx, syy };
}

export function fnCORREL(args: RuntimeValue[]): RuntimeValue {
  const paired = pairedNumbers(args, 0, 1);
  if ("code" in paired) {
    return paired;
  }
  const { xs, ys } = paired;
  const s = pairedSums(xs, ys);
  if (!s || s.n < 2) {
    return ERRORS.DIV0;
  }
  const denom = Math.sqrt(s.sxx * s.syy);
  return denom === 0 ? ERRORS.DIV0 : rvNumber(s.sxy / denom);
}

export function fnSLOPE(args: RuntimeValue[]): RuntimeValue {
  // SLOPE(known_y, known_x) — note the argument order (y first, x second).
  const paired = pairedNumbers(args, 0, 1);
  if ("code" in paired) {
    return paired;
  }
  const { xs: ys, ys: xs } = paired;
  const s = pairedSums(xs, ys);
  if (!s || s.n < 2) {
    return ERRORS.DIV0;
  }
  return s.sxx === 0 ? ERRORS.DIV0 : rvNumber(s.sxy / s.sxx);
}

export function fnINTERCEPT(args: RuntimeValue[]): RuntimeValue {
  const paired = pairedNumbers(args, 0, 1);
  if ("code" in paired) {
    return paired;
  }
  const { xs: ys, ys: xs } = paired;
  const s = pairedSums(xs, ys);
  if (!s || s.n < 2) {
    return ERRORS.DIV0;
  }
  if (s.sxx === 0) {
    return ERRORS.DIV0;
  }
  const slope = s.sxy / s.sxx;
  return rvNumber(s.meanY - slope * s.meanX);
}

export function fnRSQ(args: RuntimeValue[]): RuntimeValue {
  const r = fnCORREL(args);
  if (isError(r)) {
    return r;
  }
  return rvNumber((r as NumberValue).value ** 2);
}

/**
 * STEYX(known_y, known_x) — standard error of the predicted y-value for
 * each x in a regression. Matches Excel's definition:
 *   SE = sqrt((1/(n-2)) × (S_yy − S_xy² / S_xx))
 * where S_xx, S_yy, S_xy are centred sums of squares / cross-product.
 */
export function fnSTEYX(args: RuntimeValue[]): RuntimeValue {
  // STEYX(known_y, known_x) — y-first ordering, like SLOPE/INTERCEPT.
  const paired = pairedNumbers(args, 0, 1);
  if ("code" in paired) {
    return paired;
  }
  const { xs: ys, ys: xs } = paired;
  const s = pairedSums(xs, ys);
  if (!s || s.n < 3) {
    return ERRORS.DIV0;
  }
  if (s.sxx === 0) {
    return ERRORS.DIV0;
  }
  const numer = s.syy - (s.sxy * s.sxy) / s.sxx;
  if (numer < 0) {
    // Floating-point noise when the regression is essentially perfect.
    return rvNumber(0);
  }
  return rvNumber(Math.sqrt(numer / (s.n - 2)));
}

export function fnFORECAST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  // FORECAST(x, known_y, known_x) — same y-first argument order as SLOPE.
  const paired = pairedNumbers(args, 1, 2);
  if ("code" in paired) {
    return paired;
  }
  const { xs: ys, ys: xs } = paired;
  const s = pairedSums(xs, ys);
  if (!s || s.n < 2) {
    return ERRORS.DIV0;
  }
  if (s.sxx === 0) {
    return ERRORS.DIV0;
  }
  const slope = s.sxy / s.sxx;
  const intercept = s.meanY - slope * s.meanX;
  return rvNumber(intercept + slope * x.value);
}

// ============================================================================
// FACT, FACTDOUBLE, COMBIN, COMBINA, PERMUT
// Re-exported from math.ts — canonical definitions live there.
// ============================================================================

export { fnFACT, fnFACTDOUBLE, fnCOMBIN, fnCOMBINA, fnPERMUT } from "@formula/functions/math";

// ============================================================================
// GEOMEAN, HARMEAN, TRIMMEAN, DEVSQ, AVEDEV
// ============================================================================

// Scratch view used to read the binary exponent of a double. Reused across
// calls; JavaScript is single-threaded and the reads below never re-enter.
const doubleBits = /* @__PURE__ */ new DataView(new ArrayBuffer(8));

/** Smallest positive normal double (2^-1022). */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Split the product of every positive finite number visited by `forEachNumber`
 * into a mantissa in [1, 2) and a binary exponent, so that
 * `Π xᵢ = mantissa * 2^exp2` (subject only to normal floating-point rounding
 * in the mantissa multiplications).
 *
 * Multiplying by a power of two only shifts the exponent field, so the running
 * rescale is loss-free: the mantissa can never overflow to Infinity nor decay
 * into the subnormal range, whatever the magnitude or the ordering of the
 * inputs. The final root therefore retains full double precision without a
 * log-domain approximation.
 */
function splitPositiveProduct(args: RuntimeValue[]): {
  mantissa: number;
  exp2: number;
  count: number;
  firstValue: number;
  allIdentical: boolean;
  hasInfinity: boolean;
  hasNaN: boolean;
  outOfRange: boolean;
  err: ErrorValue | null;
} {
  let mantissa = 1;
  let exp2 = 0;
  let count = 0;
  let firstValue = NaN;
  let allIdentical = true;
  let hasInfinity = false;
  let hasNaN = false;
  let outOfRange = false;
  const err = forEachNumber(args, n => {
    if (count === 0) {
      firstValue = n;
    } else if (n !== firstValue) {
      allIdentical = false;
    }
    count++;
    if (n <= 0) {
      outOfRange = true;
      return;
    }
    if (Number.isNaN(n)) {
      hasNaN = true;
      return;
    }
    if (n === Infinity) {
      hasInfinity = true;
      return;
    }
    doubleBits.setFloat64(0, n);
    let high = doubleBits.getUint32(0);
    let exponent = ((high >>> 20) & 0x7ff) - 1023;
    if (exponent === -1023) {
      // Subnormal input: scale into the normal range (exactly) and re-read.
      doubleBits.setFloat64(0, n * 2 ** 64);
      high = doubleBits.getUint32(0);
      exponent = ((high >>> 20) & 0x7ff) - 1087;
    }
    // Force the exponent field to 0 (biased 1023) to isolate the mantissa.
    doubleBits.setUint32(0, (high & 0x800fffff) | (1023 << 20));
    mantissa *= doubleBits.getFloat64(0);
    exp2 += exponent;
    if (mantissa >= 2) {
      // Two factors in [1, 2) multiply to < 4, so one halving re-normalises.
      mantissa *= 0.5;
      exp2 += 1;
    }
  });
  return {
    mantissa,
    exp2,
    count,
    firstValue,
    allIdentical,
    hasInfinity,
    hasNaN,
    outOfRange,
    err
  };
}

export function fnGEOMEAN(args: RuntimeValue[]): RuntimeValue {
  const product = splitPositiveProduct(args);
  const { mantissa, exp2, count } = product;
  const { firstValue, allIdentical, hasInfinity, hasNaN, outOfRange, err } = product;
  if (err) {
    return err;
  }
  if (outOfRange || count === 0) {
    return ERRORS.NUM;
  }
  // This identity is exact and avoids asking an approximated root operation to
  // reconstruct a value already present in the input.
  if (allIdentical) {
    return rvNumber(firstValue);
  }
  // Preserve the old non-finite behavior. Formula values are normally finite,
  // but RuntimeValue is public and permits callers to construct these values.
  if (hasNaN) {
    return rvNumber(NaN);
  }
  if (hasInfinity) {
    return rvNumber(Infinity);
  }
  // GEOMEAN = (mantissa * 2^exp2)^(1/count) = mantissa^(1/count) * 2^(exp2/count).
  // Peel off the integral part of exp2/count: scaling by 2^quotient afterwards
  // is exact, which keeps the whole dynamic range out of `Math.pow` and leaves
  // it a tiny, well-conditioned argument.
  const quotient = Math.trunc(exp2 / count);
  const remainder = exp2 - quotient * count;
  const scaled = mantissa * 2 ** remainder;
  // A single `Math.pow` minimizes rounding and preserves common exact cases
  // (GEOMEAN(4, 9) is 6, not 5.999999999999999). Never use the algebraically
  // equivalent `Math.exp(Σ log xᵢ / count)`: `Math.log`/`Math.exp` are only
  // "implementation-approximated" by the spec, so that form is both inaccurate
  // (it inflates each log's error by the magnitude of the result) and
  // engine-dependent — `Math.exp(Math.log(5))` is 5 under Node.js' V8 and
  // 4.999999999999999 under Chromium's.
  const root =
    scaled >= MIN_NORMAL && scaled < Infinity
      ? Math.pow(scaled, 1 / count)
      : // |remainder| < count, so 2^remainder only leaves the double range for
        // very large samples. Take the two roots separately (one extra rounding).
        Math.pow(mantissa, 1 / count) * Math.pow(2, remainder / count);
  // Split the exact power-of-two scaling in half so it cannot overflow or turn
  // subnormal on the way to a representable result.
  const half = Math.trunc(quotient / 2);
  return rvNumber(root * 2 ** half * 2 ** (quotient - half));
}

export function fnHARMEAN(args: RuntimeValue[]): RuntimeValue {
  let recipSum = 0;
  let count = 0;
  let outOfRange = false;
  const err = forEachNumber(args, n => {
    if (n <= 0) {
      outOfRange = true;
      return;
    }
    recipSum += 1 / n;
    count++;
  });
  if (err) {
    return err;
  }
  if (outOfRange || count === 0) {
    return ERRORS.NUM;
  }
  return rvNumber(count / recipSum);
}

export function fnTRIMMEAN(args: RuntimeValue[]): RuntimeValue {
  const all = flattenNumbers([args[0]]);
  const err = firstError(all);
  if (err) {
    return err;
  }
  const nums = (all as NumberValue[]).map(n => n.value);
  const pct = argToNumber(args[1]);
  if (pct.kind === RVKind.Error) {
    return pct;
  }
  if (pct.value < 0 || pct.value >= 1) {
    return ERRORS.NUM;
  }
  nums.sort((a, b) => a - b);
  const trimCount = Math.floor((nums.length * pct.value) / 2);
  const trimmed = nums.slice(trimCount, nums.length - trimCount);
  if (trimmed.length === 0) {
    return ERRORS.DIV0;
  }
  return rvNumber(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
}

export function fnDEVSQ(args: RuntimeValue[]): RuntimeValue {
  const rawNums = flattenNumbers(args);
  const err = firstError(rawNums);
  if (err) {
    return err;
  }
  const nums = rawNums as NumberValue[];
  if (nums.length === 0) {
    return rvNumber(0);
  }
  let sum = 0;
  for (const n of nums) {
    sum += n.value;
  }
  const mean = sum / nums.length;
  let result = 0;
  for (const n of nums) {
    result += (n.value - mean) ** 2;
  }
  return rvNumber(result);
}

export function fnAVEDEV(args: RuntimeValue[]): RuntimeValue {
  const rawNums = flattenNumbers(args);
  const err = firstError(rawNums);
  if (err) {
    return err;
  }
  const nums = rawNums as NumberValue[];
  if (nums.length === 0) {
    return ERRORS.NUM;
  }
  let sum = 0;
  for (const n of nums) {
    sum += n.value;
  }
  const mean = sum / nums.length;
  let result = 0;
  for (const n of nums) {
    result += Math.abs(n.value - mean);
  }
  return rvNumber(result / nums.length);
}

// ============================================================================
// CONFIDENCE, FISHER, AVERAGEA, MAXA, MINA
// ============================================================================

export function fnCONFIDENCENORM(args: RuntimeValue[]): RuntimeValue {
  const alpha = argToNumber(args[0]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const stddev = argToNumber(args[1]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  const size = argToNumber(args[2]);
  if (size.kind === RVKind.Error) {
    return size;
  }
  if (alpha.value <= 0 || alpha.value >= 1 || stddev.value <= 0 || size.value < 1) {
    return ERRORS.NUM;
  }
  return rvNumber((normSInv(1 - alpha.value / 2) * stddev.value) / Math.sqrt(size.value));
}

/**
 * CONFIDENCE.T — confidence interval half-width for the mean using the
 * Student's t distribution (small sample / unknown population variance).
 */
export function fnCONFIDENCE_T(args: RuntimeValue[]): RuntimeValue {
  const alpha = argToNumber(args[0]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const stddev = argToNumber(args[1]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  const size = argToNumber(args[2]);
  if (size.kind === RVKind.Error) {
    return size;
  }
  if (alpha.value <= 0 || alpha.value >= 1 || stddev.value <= 0 || size.value < 2) {
    return ERRORS.NUM;
  }
  // Reuse the engine's existing T.INV.2T to pull the two-tailed critical
  // value; avoids duplicating the Newton search. Excel uses df = n − 1.
  const tCrit = fnT_INV_2T([rvNumber(alpha.value), rvNumber(size.value - 1)]);
  if (isError(tCrit)) {
    return tCrit;
  }
  const t = (tCrit as NumberValue).value;
  return rvNumber((t * stddev.value) / Math.sqrt(size.value));
}

/**
 * Shared helper: walk two numeric arrays element-wise, filtering to
 * matching-position numeric pairs only (Excel skips rows where either
 * side is non-numeric).
 */
function pairedNumericValues(
  a: RuntimeValue,
  b: RuntimeValue
): { xs: number[]; ys: number[] } | ErrorValue {
  // Walk both ranges in lockstep so pair alignment survives non-numeric
  // cells. Previously `flattenNumbers` dropped text / blanks before the
  // zip, which silently shifted the rest of the pairs and produced a
  // spurious covariance. Excel's COVARIANCE.P / .S pair cells by
  // position and skip only the pairs where either side is non-numeric.
  const aCells: ScalarValue[] = [];
  const bCells: ScalarValue[] = [];
  collectCells(a, aCells);
  collectCells(b, bCells);
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(aCells.length, bCells.length);
  for (let i = 0; i < n; i++) {
    const x = aCells[i];
    const y = bCells[i];
    if (x.kind === RVKind.Error) {
      return x;
    }
    if (y.kind === RVKind.Error) {
      return y;
    }
    if (x.kind === RVKind.Number && y.kind === RVKind.Number) {
      xs.push(x.value);
      ys.push(y.value);
    }
  }
  return { xs, ys };
}

/** COVARIANCE.P — population covariance. */
export function fnCOVARIANCE_P(args: RuntimeValue[]): RuntimeValue {
  const pairs = pairedNumericValues(args[0], args[1]);
  if ((pairs as ErrorValue).kind === RVKind.Error) {
    return pairs as ErrorValue;
  }
  const { xs, ys } = pairs as { xs: number[]; ys: number[] };
  const n = xs.length;
  if (n === 0) {
    return ERRORS.DIV0;
  }
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += (xs[i] - mx) * (ys[i] - my);
  }
  return rvNumber(s / n);
}

/** COVARIANCE.S — sample covariance (divide by n-1). */
export function fnCOVARIANCE_S(args: RuntimeValue[]): RuntimeValue {
  const pairs = pairedNumericValues(args[0], args[1]);
  if ((pairs as ErrorValue).kind === RVKind.Error) {
    return pairs as ErrorValue;
  }
  const { xs, ys } = pairs as { xs: number[]; ys: number[] };
  const n = xs.length;
  if (n < 2) {
    return ERRORS.DIV0;
  }
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += (xs[i] - mx) * (ys[i] - my);
  }
  return rvNumber(s / (n - 1));
}

/**
 * RANK.AVG — average-tie rank. Identical to RANK.EQ except that tied
 * positions return the average of the ranks they would otherwise span.
 */
export function fnRANK_AVG(args: RuntimeValue[]): RuntimeValue {
  const numberRV = argToNumber(args[0]);
  if (numberRV.kind === RVKind.Error) {
    return numberRV;
  }
  const rawArr = flattenNumbers([args[1]]);
  const arrErr = firstError(rawArr);
  if (arrErr) {
    return arrErr;
  }
  const nums = (rawArr as NumberValue[]).map(n => n.value);
  const orderRV = args.length > 2 ? argToNumber(args[2]) : rvNumber(0);
  if (orderRV.kind === RVKind.Error) {
    return orderRV;
  }
  const ascending = orderRV.value !== 0;
  const sorted = nums.slice().sort((a, b) => (ascending ? a - b : b - a));
  // Find the range of indices that equal `number`; RANK.AVG returns the
  // average rank over that range.
  const target = numberRV.value;
  let first = -1;
  let last = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] === target) {
      if (first === -1) {
        first = i;
      }
      last = i;
    }
  }
  if (first === -1) {
    return ERRORS.NA;
  }
  // Ranks are 1-based; average of first+1 .. last+1.
  return rvNumber((first + last + 2) / 2);
}

export function fnFISHER(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  if (x.value <= -1 || x.value >= 1) {
    return ERRORS.NUM;
  }
  return rvNumber(0.5 * Math.log((1 + x.value) / (1 - x.value)));
}

export function fnFISHERINV(args: RuntimeValue[]): RuntimeValue {
  const y = argToNumber(args[0]);
  if (y.kind === RVKind.Error) {
    return y;
  }
  const e2y = Math.exp(2 * y.value);
  return rvNumber((e2y - 1) / (e2y + 1));
}

export function fnAVERAGEA(args: RuntimeValue[]): RuntimeValue {
  const all = flattenAll(args);
  if (all.length === 0) {
    return ERRORS.DIV0;
  }
  let sum = 0;
  let count = 0;
  for (const v of all) {
    if (v.kind === RVKind.Blank) {
      continue;
    }
    if (v.kind === RVKind.Error) {
      return v;
    }
    if (v.kind === RVKind.Number) {
      sum += v.value;
    } else if (v.kind === RVKind.Boolean) {
      sum += v.value ? 1 : 0;
    }
    // Text = 0 for AVERAGEA (no addition needed)
    count++;
  }
  return count === 0 ? ERRORS.DIV0 : rvNumber(sum / count);
}

export function fnMAXA(args: RuntimeValue[]): RuntimeValue {
  return reduceAValue(args, -Infinity, (best, n) => (n > best ? n : best));
}

export function fnMINA(args: RuntimeValue[]): RuntimeValue {
  return reduceAValue(args, Infinity, (best, n) => (n < best ? n : best));
}

/**
 * Shared MAXA / MINA reducer. Excel's `*A` variants differ from MAX / MIN
 * only in how they treat text and booleans inside ranges:
 *   - Number → its value
 *   - Boolean → 1 / 0
 *   - String → 0 (NOT skipped like MAX / MIN)
 *   - Blank  → skipped
 *   - Error  → propagated
 *
 * When no non-blank cells are seen, both return 0 (the untouched
 * identity fallback matches Excel's historical behaviour).
 */
function reduceAValue(
  args: RuntimeValue[],
  identity: number,
  fold: (best: number, v: number) => number
): RuntimeValue {
  let best = identity;
  let found = false;
  const all = flattenAll(args);
  for (const v of all) {
    if (v.kind === RVKind.Blank) {
      continue;
    }
    if (v.kind === RVKind.Error) {
      return v;
    }
    const n =
      v.kind === RVKind.Number ? v.value : v.kind === RVKind.Boolean ? (v.value ? 1 : 0) : 0; // text counts as 0 for MAXA / MINA.
    best = fold(best, n);
    found = true;
  }
  return rvNumber(found ? best : 0);
}

// ============================================================================
// Private helpers for distributions (pure number → number, unchanged)
// ============================================================================

function gammaFn(z: number): number {
  if (z < 0.5) {
    return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  }
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

function lnGamma(x: number): number {
  return Math.log(gammaFn(x));
}

function betaIncomplete(x: number, a: number, b: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - betaIncomplete(1 - x, b, a);
  }
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // For extreme (a, b) the front factor underflows to 0 or overflows to
  // Infinity (e.g. T.DIST.2T at df >= 300 computes betaIncomplete with
  // a around 150 and x near 0.004; Math.log(x)*a dips below -650, so
  // Math.exp returns 0 and subsequent `f *= c * d` multiplications can
  // produce 0 * Infinity = NaN in the continued-fraction loop). Short-
  // circuit those pathological inputs: a zero front dominates the
  // series, so the integrated value is effectively 0.
  if (!Number.isFinite(front) || front === 0) {
    return 0;
  }
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) {
    d = 1e-30;
  }
  d = 1 / d;
  let f = d;
  for (let m = 1; m <= 200; m++) {
    let num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) {
      d = 1e-30;
    }
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) {
      c = 1e-30;
    }
    d = 1 / d;
    f *= c * d;
    num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) {
      d = 1e-30;
    }
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) {
      c = 1e-30;
    }
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) {
      break;
    }
  }
  return front * f;
}

function gammaIncomplete(a: number, x: number): number {
  if (x < 0) {
    return 0;
  }
  if (x === 0) {
    return 0;
  }
  if (x < a + 1) {
    let sum = 1 / a;
    let term = 1 / a;
    for (let n = 1; n <= 200; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) {
        break;
      }
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  const b0 = x + 1 - a;
  let ci = 1e30;
  let d = 1 / b0;
  let f = d;
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a);
    const bn = x + 2 * i + 1 - a;
    d = bn + an * d;
    if (Math.abs(d) < 1e-30) {
      d = 1e-30;
    }
    ci = bn + an / ci;
    if (Math.abs(ci) < 1e-30) {
      ci = 1e-30;
    }
    d = 1 / d;
    const delta = d * ci;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) {
      break;
    }
  }
  return 1 - f * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

// ============================================================================
// More Statistical Distribution Functions
// ============================================================================

export function fnPOISSON_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const mean = argToNumber(args[1]);
  if (mean.kind === RVKind.Error) {
    return mean;
  }
  const cum = boolArg(args, 2);
  if (!cum.ok) {
    return cum.error;
  }
  const k = Math.floor(x.value);
  if (k < 0 || mean.value < 0) {
    return ERRORS.NUM;
  }
  // Degenerate mean = 0: the Poisson distribution concentrates all mass at
  // k = 0. The textbook PMF formula evaluates `k * log(0) = -Infinity`
  // multiplied by `k = 0`, yielding `NaN`, so we short-circuit.
  if (mean.value === 0) {
    if (!cum.value) {
      return rvNumber(k === 0 ? 1 : 0);
    }
    return rvNumber(1); // CDF is 1 at every k >= 0
  }
  if (!cum.value) {
    return rvNumber(Math.exp(-mean.value + k * Math.log(mean.value) - lnGamma(k + 1)));
  }
  return rvNumber(1 - gammaIncomplete(k + 1, mean.value));
}

export function fnBINOM_DIST(args: RuntimeValue[]): RuntimeValue {
  const numS = argToNumber(args[0]);
  if (numS.kind === RVKind.Error) {
    return numS;
  }
  const trials = argToNumber(args[1]);
  if (trials.kind === RVKind.Error) {
    return trials;
  }
  const probS = argToNumber(args[2]);
  if (probS.kind === RVKind.Error) {
    return probS;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  const k = Math.floor(numS.value);
  const n = Math.floor(trials.value);
  if (k < 0 || n < 0 || k > n || probS.value < 0 || probS.value > 1) {
    return ERRORS.NUM;
  }
  const pmf = (ki: number): number => {
    // Degenerate p = 0 or p = 1 edges: the textbook formula multiplies
    // the log of 0 by 0 (for the absent term), producing NaN. Handle
    // these analytically — all mass is at k = 0 when p = 0, or at k = n
    // when p = 1.
    if (probS.value === 0) {
      return ki === 0 ? 1 : 0;
    }
    if (probS.value === 1) {
      return ki === n ? 1 : 0;
    }
    const lnC = lnGamma(n + 1) - lnGamma(ki + 1) - lnGamma(n - ki + 1);
    return Math.exp(lnC + ki * Math.log(probS.value) + (n - ki) * Math.log(1 - probS.value));
  };
  if (!cum.value) {
    return rvNumber(pmf(k));
  }
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += pmf(i);
  }
  return rvNumber(sum);
}

/**
 * BINOM.DIST.RANGE(trials, probability, number_s, [number_s2]) —
 * probability of a binomial trial outcome between `number_s` and
 * `number_s2` (inclusive). When `number_s2` is omitted, returns the
 * probability of exactly `number_s` successes.
 */
export function fnBINOM_DIST_RANGE(args: RuntimeValue[]): RuntimeValue {
  const trialsV = argToNumber(args[0]);
  if (trialsV.kind === RVKind.Error) {
    return trialsV;
  }
  const probV = argToNumber(args[1]);
  if (probV.kind === RVKind.Error) {
    return probV;
  }
  const s1V = argToNumber(args[2]);
  if (s1V.kind === RVKind.Error) {
    return s1V;
  }
  const s2V = args.length > 3 ? argToNumber(args[3]) : s1V;
  if (s2V.kind === RVKind.Error) {
    return s2V;
  }

  const n = Math.floor(trialsV.value);
  const s1 = Math.floor(s1V.value);
  const s2 = Math.floor(s2V.value);
  const p = probV.value;
  if (n < 0 || p < 0 || p > 1) {
    return ERRORS.NUM;
  }
  if (s1 < 0 || s1 > n) {
    return ERRORS.NUM;
  }
  if (s2 < s1 || s2 > n) {
    return ERRORS.NUM;
  }

  const pmf = (ki: number): number => {
    if (p === 0) {
      return ki === 0 ? 1 : 0;
    }
    if (p === 1) {
      return ki === n ? 1 : 0;
    }
    const lnC = lnGamma(n + 1) - lnGamma(ki + 1) - lnGamma(n - ki + 1);
    return Math.exp(lnC + ki * Math.log(p) + (n - ki) * Math.log(1 - p));
  };
  let sum = 0;
  for (let i = s1; i <= s2; i++) {
    sum += pmf(i);
  }
  return rvNumber(sum);
}

export function fnBINOM_INV(args: RuntimeValue[]): RuntimeValue {
  const trials = argToNumber(args[0]);
  if (trials.kind === RVKind.Error) {
    return trials;
  }
  const probS = argToNumber(args[1]);
  if (probS.kind === RVKind.Error) {
    return probS;
  }
  const alpha = argToNumber(args[2]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const n = Math.floor(trials.value);
  if (n < 0 || probS.value < 0 || probS.value > 1 || alpha.value < 0 || alpha.value > 1) {
    return ERRORS.NUM;
  }
  let cdf = 0;
  for (let k = 0; k <= n; k++) {
    const lnC = lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
    cdf += Math.exp(lnC + k * Math.log(probS.value) + (n - k) * Math.log(1 - probS.value));
    if (cdf >= alpha.value) {
      return rvNumber(k);
    }
  }
  return rvNumber(n);
}

export function fnHYPGEOM_DIST(args: RuntimeValue[]): RuntimeValue {
  const sampleS = argToNumber(args[0]);
  if (sampleS.kind === RVKind.Error) {
    return sampleS;
  }
  const numberSample = argToNumber(args[1]);
  if (numberSample.kind === RVKind.Error) {
    return numberSample;
  }
  const popS = argToNumber(args[2]);
  if (popS.kind === RVKind.Error) {
    return popS;
  }
  const numberPop = argToNumber(args[3]);
  if (numberPop.kind === RVKind.Error) {
    return numberPop;
  }
  const cum = boolArg(args, 4);
  if (!cum.ok) {
    return cum.error;
  }
  const ss = Math.floor(sampleS.value);
  const ns = Math.floor(numberSample.value);
  const ps = Math.floor(popS.value);
  const np = Math.floor(numberPop.value);
  const pmf = (k: number): number =>
    Math.exp(
      lnGamma(ps + 1) -
        lnGamma(k + 1) -
        lnGamma(ps - k + 1) +
        lnGamma(np - ps + 1) -
        lnGamma(ns - k + 1) -
        lnGamma(np - ps - ns + k + 1) -
        lnGamma(np + 1) +
        lnGamma(ns + 1) +
        lnGamma(np - ns + 1)
    );
  if (!cum.value) {
    return rvNumber(pmf(ss));
  }
  let sum = 0;
  for (let k = 0; k <= ss; k++) {
    sum += pmf(k);
  }
  return rvNumber(sum);
}

export function fnNEGBINOM_DIST(args: RuntimeValue[]): RuntimeValue {
  const numF = argToNumber(args[0]);
  if (numF.kind === RVKind.Error) {
    return numF;
  }
  const numS = argToNumber(args[1]);
  if (numS.kind === RVKind.Error) {
    return numS;
  }
  const probS = argToNumber(args[2]);
  if (probS.kind === RVKind.Error) {
    return probS;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  const f = Math.floor(numF.value);
  const s = Math.floor(numS.value);
  if (f < 0 || s < 1 || probS.value < 0 || probS.value > 1) {
    return ERRORS.NUM;
  }
  const pmf = (k: number): number => {
    const lnC = lnGamma(k + s) - lnGamma(s) - lnGamma(k + 1);
    return Math.exp(lnC + s * Math.log(probS.value) + k * Math.log(1 - probS.value));
  };
  if (!cum.value) {
    return rvNumber(pmf(f));
  }
  let sum = 0;
  for (let k = 0; k <= f; k++) {
    sum += pmf(k);
  }
  return rvNumber(sum);
}

export function fnCHISQ_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  const cum = boolArg(args, 2);
  if (!cum.ok) {
    return cum.error;
  }
  if (x.value < 0 || df.value < 1) {
    return ERRORS.NUM;
  }
  // Excel's CHISQ.DIST accepts non-integer degrees of freedom; the
  // incomplete-gamma formula is defined for any positive `df/2`. We used
  // to Math.floor() df, which silently returned the chi-square for the
  // nearest smaller integer df and produced visibly wrong densities for
  // fractional inputs.
  if (cum.value) {
    return rvNumber(gammaIncomplete(df.value / 2, x.value / 2));
  }
  const halfK = df.value / 2;
  return rvNumber(Math.exp((halfK - 1) * Math.log(x.value / 2) - x.value / 2 - lnGamma(halfK)) / 2);
}

export function fnCHISQ_INV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (p.value < 0 || p.value >= 1 || df.value < 1) {
    return ERRORS.NUM;
  }
  // P = 0 → x = 0 exactly. Without the short-circuit, Newton from x = df
  // would compute `(0 - 0) / pdf` = 0 on the first iteration (fine), but
  // rounding drift can push x negative, triggering the clamp to 0.001 and
  // returning a non-zero result.
  if (p.value === 0) {
    return rvNumber(0);
  }
  let x = df.value;
  for (let iter = 0; iter < 100; iter++) {
    const cdf = gammaIncomplete(df.value / 2, x / 2);
    const halfK = df.value / 2;
    const pdf = Math.exp((halfK - 1) * Math.log(x / 2) - x / 2 - lnGamma(halfK)) / 2;
    if (Math.abs(pdf) < 1e-15) {
      break;
    }
    const delta = (cdf - p.value) / pdf;
    x -= delta;
    if (x <= 0) {
      x = 0.001;
    }
    if (Math.abs(delta) < 1e-10) {
      break;
    }
  }
  return rvNumber(x);
}

export function fnCHISQ_DIST_RT(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (x.value < 0 || df.value < 1) {
    return ERRORS.NUM;
  }
  return rvNumber(1 - gammaIncomplete(df.value / 2, x.value / 2));
}

/**
 * CHISQ.INV.RT(probability, df) — right-tailed inverse of chi-square.
 * Equivalent to CHISQ.INV(1 - probability, df). Probabilities of 0 or 1
 * return +∞ or 0 respectively; values outside (0, 1] are #NUM!.
 */
export function fnCHISQ_INV_RT(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (p.value <= 0 || p.value > 1 || df.value < 1) {
    return ERRORS.NUM;
  }
  // Re-use CHISQ.INV with the complementary probability.
  return fnCHISQ_INV([rvNumber(1 - p.value), df]);
}

export function fnF_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df1 = argToNumber(args[1]);
  if (df1.kind === RVKind.Error) {
    return df1;
  }
  const df2 = argToNumber(args[2]);
  if (df2.kind === RVKind.Error) {
    return df2;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  if (x.value < 0 || df1.value < 1 || df2.value < 1) {
    return ERRORS.NUM;
  }
  // Accept fractional df. See CHISQ.DIST comment — the betaIncomplete/lnGamma
  // formulas below are defined for any positive df, so there is no reason
  // to truncate.
  const d1 = df1.value;
  const d2 = df2.value;
  if (cum.value) {
    return rvNumber(betaIncomplete((d1 * x.value) / (d1 * x.value + d2), d1 / 2, d2 / 2));
  }
  const num =
    (Math.pow(d1 * x.value, d1 / 2) * Math.pow(d2, d2 / 2)) /
    Math.pow(d1 * x.value + d2, (d1 + d2) / 2);
  const denom = x.value * Math.exp(lnGamma(d1 / 2) + lnGamma(d2 / 2) - lnGamma((d1 + d2) / 2));
  return rvNumber(denom === 0 ? 0 : num / denom);
}

export function fnF_INV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const df1 = argToNumber(args[1]);
  if (df1.kind === RVKind.Error) {
    return df1;
  }
  const df2 = argToNumber(args[2]);
  if (df2.kind === RVKind.Error) {
    return df2;
  }
  if (p.value < 0 || p.value >= 1 || df1.value < 1 || df2.value < 1) {
    return ERRORS.NUM;
  }
  const d1 = df1.value;
  const d2 = df2.value;
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const cdf = betaIncomplete((d1 * mid) / (d1 * mid + d2), d1 / 2, d2 / 2);
    if (cdf < p.value) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-10) {
      break;
    }
  }
  return rvNumber((lo + hi) / 2);
}

export function fnT_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  const cum = boolArg(args, 2);
  if (!cum.ok) {
    return cum.error;
  }
  if (df.value < 1) {
    return ERRORS.NUM;
  }
  const v = df.value;
  if (cum.value) {
    const t = v / (v + x.value * x.value);
    const halfBeta = 0.5 * betaIncomplete(t, v / 2, 0.5);
    return rvNumber(x.value >= 0 ? 1 - halfBeta : halfBeta);
  }
  return rvNumber(
    Math.exp(lnGamma((v + 1) / 2) - lnGamma(v / 2)) /
      (Math.sqrt(v * Math.PI) * Math.pow(1 + (x.value * x.value) / v, (v + 1) / 2))
  );
}

export function fnT_INV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (p.value <= 0 || p.value >= 1 || df.value < 1) {
    return ERRORS.NUM;
  }
  let x = normSInv(p.value);
  const v = df.value;
  for (let iter = 0; iter < 100; iter++) {
    const t = v / (v + x * x);
    const halfBeta = 0.5 * betaIncomplete(t, v / 2, 0.5);
    const cdf = x >= 0 ? 1 - halfBeta : halfBeta;
    const pdf =
      Math.exp(lnGamma((v + 1) / 2) - lnGamma(v / 2)) /
      (Math.sqrt(v * Math.PI) * Math.pow(1 + (x * x) / v, (v + 1) / 2));
    if (Math.abs(pdf) < 1e-15) {
      break;
    }
    const delta = (cdf - p.value) / pdf;
    x -= delta;
    if (Math.abs(delta) < 1e-10) {
      break;
    }
  }
  return rvNumber(x);
}

export function fnT_DIST_2T(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (x.value < 0 || df.value < 1) {
    return ERRORS.NUM;
  }
  const v = df.value;
  return rvNumber(betaIncomplete(v / (v + x.value * x.value), v / 2, 0.5));
}

export function fnT_DIST_RT(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (df.value < 1) {
    return ERRORS.NUM;
  }
  const v = df.value;
  const halfBeta = 0.5 * betaIncomplete(v / (v + x.value * x.value), v / 2, 0.5);
  // T.DIST.RT(x, df) = right-tail = 1 - CDF(x)
  // For x >= 0: right-tail = halfBeta
  // For x < 0: right-tail = 1 - halfBeta
  return rvNumber(x.value >= 0 ? halfBeta : 1 - halfBeta);
}

export function fnT_INV_2T(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const df = argToNumber(args[1]);
  if (df.kind === RVKind.Error) {
    return df;
  }
  if (p.value <= 0 || p.value > 1 || df.value < 1) {
    return ERRORS.NUM;
  }
  const result = fnT_INV([rvNumber(1 - p.value / 2), args[1]]);
  if (isError(result)) {
    return result;
  }
  return rvNumber(Math.abs((result as NumberValue).value));
}

// ============================================================================
// BETA, GAMMA, EXPON, WEIBULL, LOGNORM distributions
// ============================================================================

export function fnBETA_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const alpha = argToNumber(args[1]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const beta = argToNumber(args[2]);
  if (beta.kind === RVKind.Error) {
    return beta;
  }
  let cumVal = true;
  if (args.length > 3) {
    const cum = boolArg(args, 3);
    if (!cum.ok) {
      return cum.error;
    }
    cumVal = cum.value;
  }
  let A = 0;
  if (args.length > 4) {
    const aRV = argToNumber(args[4]);
    if (aRV.kind === RVKind.Error) {
      return aRV;
    }
    A = aRV.value;
  }
  let B = 1;
  if (args.length > 5) {
    const bRV = argToNumber(args[5]);
    if (bRV.kind === RVKind.Error) {
      return bRV;
    }
    B = bRV.value;
  }
  if (alpha.value <= 0 || beta.value <= 0 || B <= A) {
    return ERRORS.NUM;
  }
  const xn = (x.value - A) / (B - A);
  if (xn < 0 || xn > 1) {
    return ERRORS.NUM;
  }
  if (cumVal) {
    return rvNumber(betaIncomplete(xn, alpha.value, beta.value));
  }
  return rvNumber(
    Math.exp(
      (alpha.value - 1) * Math.log(xn) +
        (beta.value - 1) * Math.log(1 - xn) -
        lnGamma(alpha.value) -
        lnGamma(beta.value) +
        lnGamma(alpha.value + beta.value)
    ) /
      (B - A)
  );
}

export function fnBETA_INV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const alpha = argToNumber(args[1]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const beta = argToNumber(args[2]);
  if (beta.kind === RVKind.Error) {
    return beta;
  }
  let A = 0;
  if (args.length > 3) {
    const aRV = argToNumber(args[3]);
    if (aRV.kind === RVKind.Error) {
      return aRV;
    }
    A = aRV.value;
  }
  let B = 1;
  if (args.length > 4) {
    const bRV = argToNumber(args[4]);
    if (bRV.kind === RVKind.Error) {
      return bRV;
    }
    B = bRV.value;
  }
  if (p.value < 0 || p.value > 1 || alpha.value <= 0 || beta.value <= 0) {
    return ERRORS.NUM;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (betaIncomplete(mid, alpha.value, beta.value) < p.value) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-12) {
      break;
    }
  }
  return rvNumber(A + ((lo + hi) / 2) * (B - A));
}

export function fnGAMMA(args: RuntimeValue[]): RuntimeValue {
  const n = argToNumber(args[0]);
  if (n.kind === RVKind.Error) {
    return n;
  }
  if (n.value <= 0 && n.value === Math.floor(n.value)) {
    return ERRORS.NUM;
  }
  return rvNumber(gammaFn(n.value));
}

export function fnGAMMALN(args: RuntimeValue[]): RuntimeValue {
  const n = argToNumber(args[0]);
  if (n.kind === RVKind.Error) {
    return n;
  }
  if (n.value <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber(lnGamma(n.value));
}

export function fnGAMMA_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const alpha = argToNumber(args[1]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const beta = argToNumber(args[2]);
  if (beta.kind === RVKind.Error) {
    return beta;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  if (x.value < 0 || alpha.value <= 0 || beta.value <= 0) {
    return ERRORS.NUM;
  }
  if (cum.value) {
    return rvNumber(gammaIncomplete(alpha.value, x.value / beta.value));
  }
  return rvNumber(
    Math.exp(
      (alpha.value - 1) * Math.log(x.value) -
        x.value / beta.value -
        alpha.value * Math.log(beta.value) -
        lnGamma(alpha.value)
    )
  );
}

export function fnGAMMA_INV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const alpha = argToNumber(args[1]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const beta = argToNumber(args[2]);
  if (beta.kind === RVKind.Error) {
    return beta;
  }
  if (p.value < 0 || p.value >= 1 || alpha.value <= 0 || beta.value <= 0) {
    return ERRORS.NUM;
  }
  let lo = 0;
  let hi = Math.max(alpha.value * beta.value * 10, 100);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (gammaIncomplete(alpha.value, mid / beta.value) < p.value) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-10) {
      break;
    }
  }
  return rvNumber((lo + hi) / 2);
}

export function fnEXPON_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const lambda = argToNumber(args[1]);
  if (lambda.kind === RVKind.Error) {
    return lambda;
  }
  const cum = boolArg(args, 2);
  if (!cum.ok) {
    return cum.error;
  }
  if (x.value < 0 || lambda.value <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber(
    cum.value
      ? 1 - Math.exp(-lambda.value * x.value)
      : lambda.value * Math.exp(-lambda.value * x.value)
  );
}

export function fnWEIBULL_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const alpha = argToNumber(args[1]);
  if (alpha.kind === RVKind.Error) {
    return alpha;
  }
  const beta = argToNumber(args[2]);
  if (beta.kind === RVKind.Error) {
    return beta;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  if (x.value < 0 || alpha.value <= 0 || beta.value <= 0) {
    return ERRORS.NUM;
  }
  if (cum.value) {
    return rvNumber(1 - Math.exp(-Math.pow(x.value / beta.value, alpha.value)));
  }
  return rvNumber(
    (alpha.value / beta.value) *
      Math.pow(x.value / beta.value, alpha.value - 1) *
      Math.exp(-Math.pow(x.value / beta.value, alpha.value))
  );
}

export function fnLOGNORM_DIST(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const mean = argToNumber(args[1]);
  if (mean.kind === RVKind.Error) {
    return mean;
  }
  const stddev = argToNumber(args[2]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  const cum = boolArg(args, 3);
  if (!cum.ok) {
    return cum.error;
  }
  if (x.value <= 0 || stddev.value <= 0) {
    return ERRORS.NUM;
  }
  const z = (Math.log(x.value) - mean.value) / stddev.value;
  if (cum.value) {
    return rvNumber(normSDist(z));
  }
  return rvNumber(normSPdf(z) / (x.value * stddev.value));
}

export function fnLOGNORM_INV(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const mean = argToNumber(args[1]);
  if (mean.kind === RVKind.Error) {
    return mean;
  }
  const stddev = argToNumber(args[2]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  if (p.value <= 0 || p.value >= 1 || stddev.value <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber(Math.exp(mean.value + stddev.value * normSInv(p.value)));
}

export function fnPHI(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  return x.kind === RVKind.Error ? x : rvNumber(normSPdf(x.value));
}

export function fnGAUSS(args: RuntimeValue[]): RuntimeValue {
  const z = argToNumber(args[0]);
  return z.kind === RVKind.Error ? z : rvNumber(normSDist(z.value) - 0.5);
}

// ============================================================================
// ERF, ERFC, STANDARDIZE
// ============================================================================

function erfFn(x: number): number {
  // Exact at 0 — the rational approximation below leaves a ~7e-10 drift at
  // t = 1 / (1 + p·0) = 1, which is visible to callers that expect
  // `ERF(0) === 0` (and especially to `ERFC(0) === 1`).
  if (x === 0) {
    return 0;
  }
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function fnERF(args: RuntimeValue[]): RuntimeValue {
  const lower = argToNumber(args[0]);
  if (lower.kind === RVKind.Error) {
    return lower;
  }
  // Blank 2nd arg → behave like an omitted upper bound, i.e. return
  // `erf(lower)`. Previously a blank coerced to 0 and flipped the sign
  // of the result via `erf(0) − erf(lower)`.
  if (args.length > 1 && args[1].kind !== RVKind.Blank) {
    const upper = argToNumber(args[1]);
    if (upper.kind === RVKind.Error) {
      return upper;
    }
    return rvNumber(erfFn(upper.value) - erfFn(lower.value));
  }
  return rvNumber(erfFn(lower.value));
}

export function fnERFC(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  return x.kind === RVKind.Error ? x : rvNumber(1 - erfFn(x.value));
}

export function fnSTANDARDIZE(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const mean = argToNumber(args[1]);
  if (mean.kind === RVKind.Error) {
    return mean;
  }
  const stddev = argToNumber(args[2]);
  if (stddev.kind === RVKind.Error) {
    return stddev;
  }
  if (stddev.value <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((x.value - mean.value) / stddev.value);
}

// ============================================================================
// Array-returning functions: FREQUENCY, GROWTH, TREND, LINEST, LOGEST
// ============================================================================

export function fnFREQUENCY(args: RuntimeValue[]): RuntimeValue {
  if (!isArrayArg(args[0]) || !isArrayArg(args[1])) {
    return ERRORS.VALUE;
  }
  const rawData = flattenNumbers([args[0]]);
  const dataErr = firstError(rawData);
  if (dataErr) {
    return dataErr;
  }
  const data = (rawData as NumberValue[]).map(n => n.value);
  const rawBins = flattenNumbers([args[1]]);
  const binsErr = firstError(rawBins);
  if (binsErr) {
    return binsErr;
  }
  const bins = (rawBins as NumberValue[]).map(n => n.value);
  // IMPORTANT: do NOT sort `bins`. Excel's FREQUENCY bucketises data into
  // the bins as the user supplied them — both the output count order and
  // the bucket boundaries follow the original sequence. Sorting would
  // silently reshuffle the result array, which is a common historical
  // implementation mistake.
  //
  // For each datum we assign it to the first bin `i` whose upper bound
  // satisfies `data <= bins[i]`; if no such bin exists the datum falls
  // into the overflow bucket at index `bins.length`. This matches Excel's
  // semantics for any bin order (monotonic or not).
  const result: ScalarValue[][] = [];
  const counts = new Array<number>(bins.length + 1).fill(0);
  for (const d of data) {
    let assigned = false;
    for (let i = 0; i < bins.length; i++) {
      if (d <= bins[i]) {
        counts[i]++;
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      counts[bins.length]++;
    }
  }
  for (const c of counts) {
    result.push([rvNumber(c)]);
  }
  return rvArray(result);
}

// ============================================================================
// Multivariate regression helpers (LINEST / LOGEST / TREND / GROWTH)
// ============================================================================

/**
 * Extract a numeric matrix from an ArrayValue and preserve orientation.
 *
 * Excel's regression family accepts both row vectors and column vectors for the
 * dependent variable `y` and for each independent variable column in `X`. We
 * preserve whether the input was laid out by rows (one observation per row) or
 * by columns (one observation per column) so we can match the output shape.
 *
 * Returns:
 *   - `rows` / `cols`: the numeric matrix as a row-major 2D array of numbers
 *   - `orientation`: "row" if the original array had one row (shape 1×N),
 *                    "col" if one column (shape M×1),
 *                    "matrix" otherwise
 *   - `err`: the first #-error encountered, if any (non-numeric cells → #VALUE!)
 */
type Matrix = { data: number[][]; rows: number; cols: number };
type Orientation = "row" | "col" | "matrix";

/** Narrow `T | ErrorValue` to `ErrorValue`. */
function isErr<T extends object>(v: T | ErrorValue): v is ErrorValue {
  return (v as { kind?: number }).kind === RVKind.Error;
}

function extractMatrix(arg: RuntimeValue): { m: Matrix; orient: Orientation } | ErrorValue {
  if (arg.kind !== RVKind.Array) {
    const sv = topLeft(arg);
    if (sv.kind === RVKind.Error) {
      return sv;
    }
    const n = toNumberRV(sv);
    if (n.kind === RVKind.Error) {
      return n;
    }
    return { m: { data: [[n.value]], rows: 1, cols: 1 }, orient: "row" };
  }
  const data: number[][] = [];
  for (const row of arg.rows) {
    const out: number[] = [];
    for (const cell of row) {
      if (cell.kind === RVKind.Error) {
        return cell;
      }
      if (cell.kind === RVKind.Number) {
        out.push(cell.value);
      } else if (cell.kind === RVKind.Blank) {
        return ERRORS.VALUE;
      } else {
        const n = toNumberRV(cell);
        if (n.kind === RVKind.Error) {
          return n;
        }
        out.push(n.value);
      }
    }
    data.push(out);
  }
  const rows = arg.height;
  const cols = arg.width;
  const orient: Orientation = rows === 1 ? "row" : cols === 1 ? "col" : "matrix";
  return { m: { data, rows, cols }, orient };
}

/**
 * Normalize the `known_x's` argument to a design matrix X of shape [n, k],
 * where n is the number of observations and k is the number of predictor
 * variables. Excel infers k from the orientation of known_x's: when y is a
 * column vector (or square), each column of known_x's is one predictor; when
 * y is a row vector, each row of known_x's is one predictor.
 */
function buildDesignMatrix(
  m: Matrix,
  nObs: number,
  yOrient: Orientation
): { X: number[][]; k: number; xOrient: Orientation } | ErrorValue {
  // Decide orientation of predictors based on y's orientation and matrix shape
  let byRows: boolean;
  let xOrient: Orientation;
  if (m.rows === 1) {
    // Row vector of length n: single predictor, one observation per column
    byRows = false;
    xOrient = "row";
  } else if (m.cols === 1) {
    // Column vector of length n: single predictor, one observation per row
    byRows = true;
    xOrient = "col";
  } else if (yOrient === "row") {
    // y is a row vector: predictors are rows of known_x's
    byRows = false;
    xOrient = "row";
  } else {
    // y is a column/matrix: predictors are columns of known_x's
    byRows = true;
    xOrient = "col";
  }
  const n = byRows ? m.rows : m.cols;
  const k = byRows ? m.cols : m.rows;
  if (n !== nObs) {
    return ERRORS.REF;
  }
  const X: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < k; j++) {
      row.push(byRows ? m.data[i][j] : m.data[j][i]);
    }
    X.push(row);
  }
  return { X, k, xOrient };
}

/** Solve (A^T A) β = A^T b via Gauss–Jordan on the augmented matrix. */
function solveNormalEquations(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const k = A[0]?.length ?? 0;
  // Build augmented [AᵀA | Aᵀb]
  const aug: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) {
        s += A[r][i] * A[r][j];
      }
      aug[i][j] = s;
    }
    let sb = 0;
    for (let r = 0; r < n; r++) {
      sb += A[r][i] * b[r];
    }
    aug[i][k] = sb;
  }
  // Gauss–Jordan with partial pivoting
  for (let i = 0; i < k; i++) {
    let piv = i;
    for (let r = i + 1; r < k; r++) {
      if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) {
        piv = r;
      }
    }
    if (Math.abs(aug[piv][i]) < 1e-12) {
      return null;
    }
    if (piv !== i) {
      [aug[i], aug[piv]] = [aug[piv], aug[i]];
    }
    const d = aug[i][i];
    for (let j = i; j <= k; j++) {
      aug[i][j] /= d;
    }
    for (let r = 0; r < k; r++) {
      if (r === i) {
        continue;
      }
      const f = aug[r][i];
      if (f === 0) {
        continue;
      }
      for (let j = i; j <= k; j++) {
        aug[r][j] -= f * aug[i][j];
      }
    }
  }
  return aug.map(row => row[k]);
}

/** Compute inverse of k×k symmetric positive-definite matrix via Gauss–Jordan. */
function invertSquareMatrix(M: number[][]): number[][] | null {
  const k = M.length;
  const aug: number[][] = Array.from({ length: k }, (_, i) => {
    const row = new Array<number>(2 * k).fill(0);
    for (let j = 0; j < k; j++) {
      row[j] = M[i][j];
    }
    row[k + i] = 1;
    return row;
  });
  for (let i = 0; i < k; i++) {
    let piv = i;
    for (let r = i + 1; r < k; r++) {
      if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) {
        piv = r;
      }
    }
    if (Math.abs(aug[piv][i]) < 1e-12) {
      return null;
    }
    if (piv !== i) {
      [aug[i], aug[piv]] = [aug[piv], aug[i]];
    }
    const d = aug[i][i];
    for (let j = 0; j < 2 * k; j++) {
      aug[i][j] /= d;
    }
    for (let r = 0; r < k; r++) {
      if (r === i) {
        continue;
      }
      const f = aug[r][i];
      if (f === 0) {
        continue;
      }
      for (let j = 0; j < 2 * k; j++) {
        aug[r][j] -= f * aug[i][j];
      }
    }
  }
  return aug.map(row => row.slice(k));
}

/**
 * Common least-squares core used by LINEST / LOGEST / TREND / GROWTH.
 *
 * Builds the design matrix (optionally augmented with an intercept column),
 * solves the normal equations for the coefficient vector, and — when stats are
 * requested — also computes the regression statistics block that Excel emits
 * as a 5×(k+1) matrix.
 *
 * `logMode` indicates a LOGEST/GROWTH call: `y` must be positive and is
 * replaced by `ln(y)` before regression. Coefficients are kept in log space
 * and reported back un-exponentiated (the callers exp them where needed).
 */
interface LeastSquaresInput {
  /** y values as a flat vector of length n (in the original domain). */
  y: number[];
  /** Design matrix of regressor columns [n, k] (without intercept column). */
  X: number[][];
  /** Whether an intercept column (all-ones) should be included. */
  includeIntercept: boolean;
  logMode: boolean;
}
interface LeastSquaresResult {
  /** Coefficients ordered as [mk, m(k-1), ..., m1, b] to match Excel's output. */
  coeffs: number[];
  /** SE of each coefficient, same order as `coeffs`. Undefined when stats not computed. */
  seCoeffs?: number[];
  /** R² */
  r2?: number;
  /** Standard error of the y estimate (sey). */
  sey?: number;
  /** F statistic. */
  fStat?: number;
  /** Residual degrees of freedom. */
  df?: number;
  /** Regression sum of squares. */
  ssReg?: number;
  /** Residual sum of squares. */
  ssResid?: number;
}
function runLeastSquares(
  input: LeastSquaresInput,
  withStats: boolean
): LeastSquaresResult | ErrorValue {
  const { includeIntercept, logMode } = input;
  const n = input.y.length;
  const k = input.X[0]?.length ?? 0;
  if (n < 1 || k < 1) {
    return ERRORS.VALUE;
  }

  // y in log domain for LOGEST/GROWTH
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const yi = input.y[i];
    if (logMode) {
      if (yi <= 0) {
        return ERRORS.NUM;
      }
      y[i] = Math.log(yi);
    } else {
      y[i] = yi;
    }
  }

  // Augment X with intercept column (as the last column → Excel puts b at the end)
  const kAug = includeIntercept ? k + 1 : k;
  const A: number[][] = new Array<number[]>(n);
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(kAug);
    for (let j = 0; j < k; j++) {
      row[j] = input.X[i][j];
    }
    if (includeIntercept) {
      row[k] = 1;
    }
    A[i] = row;
  }

  const beta = solveNormalEquations(A, y);
  if (beta === null) {
    return ERRORS.NUM;
  }

  // Excel orders coefficients as [mk, m(k-1), ..., m1, b] — reverse the slope
  // portion but keep the intercept last.
  const coeffs: number[] = [];
  for (let j = k - 1; j >= 0; j--) {
    coeffs.push(beta[j]);
  }
  if (includeIntercept) {
    coeffs.push(beta[k]);
  } else {
    coeffs.push(0);
  }

  if (!withStats) {
    return { coeffs };
  }

  // Residuals, sums of squares
  const yhat = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < kAug; j++) {
      s += A[i][j] * beta[j];
    }
    yhat[i] = s;
  }
  let ybar = 0;
  if (includeIntercept) {
    for (const v of y) {
      ybar += v;
    }
    ybar /= n;
  }
  let ssResid = 0,
    ssTot = 0,
    ssReg = 0;
  for (let i = 0; i < n; i++) {
    ssResid += (y[i] - yhat[i]) ** 2;
    ssTot += (y[i] - ybar) ** 2;
    ssReg += (yhat[i] - ybar) ** 2;
  }
  const df = n - kAug;
  const r2 = ssTot === 0 ? 1 : 1 - ssResid / ssTot;
  const sey = df > 0 ? Math.sqrt(ssResid / df) : 0;
  const fStat = df > 0 && ssResid > 0 ? ssReg / k / (ssResid / df) : Number.POSITIVE_INFINITY;

  // Standard errors: diag(sey² · (AᵀA)⁻¹)
  const AtA: number[][] = Array.from({ length: kAug }, () => new Array<number>(kAug).fill(0));
  for (let i = 0; i < kAug; i++) {
    for (let j = 0; j < kAug; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) {
        s += A[r][i] * A[r][j];
      }
      AtA[i][j] = s;
    }
  }
  const inv = invertSquareMatrix(AtA);
  const seCoeffs: number[] = [];
  if (inv) {
    for (let j = k - 1; j >= 0; j--) {
      const v = sey * sey * inv[j][j];
      seCoeffs.push(v >= 0 ? Math.sqrt(v) : 0);
    }
    if (includeIntercept) {
      const v = sey * sey * inv[k][k];
      seCoeffs.push(v >= 0 ? Math.sqrt(v) : 0);
    } else {
      seCoeffs.push(0);
    }
  } else {
    // Cannot invert — fill with NaN per Excel behavior (but we use 0 since
    // downstream consumers expect numbers).
    for (let j = 0; j <= k; j++) {
      seCoeffs.push(0);
    }
  }

  return { coeffs, seCoeffs, r2, sey, fStat, df, ssReg, ssResid };
}

/** Build Excel's 5×(k+1) LINEST stats block. */
function buildStatsBlock(res: LeastSquaresResult): ScalarValue[][] {
  const kPlus1 = res.coeffs.length;
  const row1 = res.coeffs.map(v => rvNumber(v));
  const row2: ScalarValue[] = (res.seCoeffs ?? []).map(v => rvNumber(v));
  // Row 3: r² in col 0, sey in col 1, then #N/A for k+1 ≥ 3
  const row3: ScalarValue[] = new Array<ScalarValue>(kPlus1).fill(ERRORS.NA);
  row3[0] = rvNumber(res.r2 ?? 0);
  if (kPlus1 >= 2) {
    row3[1] = rvNumber(res.sey ?? 0);
  }
  // Row 4: F in col 0, df in col 1, then #N/A
  const row4: ScalarValue[] = new Array<ScalarValue>(kPlus1).fill(ERRORS.NA);
  row4[0] = rvNumber(res.fStat ?? 0);
  if (kPlus1 >= 2) {
    row4[1] = rvNumber(res.df ?? 0);
  }
  // Row 5: ssReg in col 0, ssResid in col 1, then #N/A
  const row5: ScalarValue[] = new Array<ScalarValue>(kPlus1).fill(ERRORS.NA);
  row5[0] = rvNumber(res.ssReg ?? 0);
  if (kPlus1 >= 2) {
    row5[1] = rvNumber(res.ssResid ?? 0);
  }
  return [row1, row2, row3, row4, row5];
}

/** Parse known_y / known_x from args, returning design matrix and orientation info. */
function parseRegressionInputs(
  args: RuntimeValue[]
):
  | { y: number[]; X: number[][]; k: number; yOrient: Orientation; xOrient: Orientation }
  | ErrorValue {
  if (!args[0]) {
    return ERRORS.VALUE;
  }
  const yInfo = extractMatrix(args[0]);
  if (isErr(yInfo)) {
    return yInfo;
  }
  const y: number[] = [];
  for (const row of yInfo.m.data) {
    for (const v of row) {
      y.push(v);
    }
  }
  const nObs = y.length;
  if (nObs < 1) {
    return ERRORS.VALUE;
  }
  if (args.length > 1 && args[1].kind !== RVKind.Blank) {
    const xInfo = extractMatrix(args[1]);
    if (isErr(xInfo)) {
      return xInfo;
    }
    const built = buildDesignMatrix(xInfo.m, nObs, yInfo.orient);
    if (isErr(built)) {
      return built;
    }
    return { y, X: built.X, k: built.k, yOrient: yInfo.orient, xOrient: built.xOrient };
  }
  // Default known_x's = 1..n as a column vector
  const X: number[][] = y.map((_, i) => [i + 1]);
  return { y, X, k: 1, yOrient: yInfo.orient, xOrient: yInfo.orient };
}

/** Parse new_x (third arg of TREND/GROWTH). Returns new-X matrix [m, k] and output orientation. */
function parseNewX(
  arg: RuntimeValue | undefined,
  fallback: number[][],
  k: number,
  xOrient: Orientation
): { X: number[][]; outOrient: Orientation } | ErrorValue {
  if (!arg || arg.kind === RVKind.Blank) {
    return { X: fallback, outOrient: xOrient };
  }
  const info = extractMatrix(arg);
  if (isErr(info)) {
    return info;
  }
  const m = info.m;
  // Determine orientation: need one of the dimensions to equal k (the number of predictors)
  if (k === 1) {
    // Single predictor → flatten whatever shape was given
    const X: number[][] = [];
    for (const row of m.data) {
      for (const v of row) {
        X.push([v]);
      }
    }
    const outOrient: Orientation = m.rows === 1 ? "row" : "col";
    return { X, outOrient };
  }
  // Multi-predictor: match orientation with known_x's
  if (xOrient === "col" || xOrient === "matrix") {
    // Each row is one observation with k columns of predictors
    if (m.cols !== k) {
      return ERRORS.REF;
    }
    return { X: m.data.map(r => r.slice()), outOrient: "col" };
  }
  // xOrient === "row": each column is one observation
  if (m.rows !== k) {
    return ERRORS.REF;
  }
  const X: number[][] = [];
  for (let c = 0; c < m.cols; c++) {
    const row: number[] = [];
    for (let r = 0; r < k; r++) {
      row.push(m.data[r][c]);
    }
    X.push(row);
  }
  return { X, outOrient: "row" };
}

/** Emit an array of predictions matching the requested output orientation. */
function emitPredictions(values: number[], outOrient: Orientation): RuntimeValue {
  if (outOrient === "row") {
    return rvArray([values.map(v => rvNumber(v))]);
  }
  return rvArray(values.map(v => [rvNumber(v)]));
}

export function fnGROWTH(args: RuntimeValue[]): RuntimeValue {
  const parsed = parseRegressionInputs(args);
  if (isErr(parsed)) {
    return parsed;
  }
  const { y, X, k, xOrient } = parsed;
  const lsq = runLeastSquares({ y, X, includeIntercept: true, logMode: true }, false);
  if (isErr(lsq)) {
    return lsq;
  }
  // coeffs order: [mk, ..., m1, b]; slopes in log space correspond to positions [0..k-1]
  const b = lsq.coeffs[k];
  const slopes: number[] = new Array<number>(k);
  for (let j = 0; j < k; j++) {
    slopes[j] = lsq.coeffs[k - 1 - j];
  } // m1..mk
  const newInfo = parseNewX(args[2], X, k, xOrient);
  if (isErr(newInfo)) {
    return newInfo;
  }
  const preds: number[] = newInfo.X.map(row => {
    let lp = b;
    for (let j = 0; j < k; j++) {
      lp += slopes[j] * row[j];
    }
    return Math.exp(lp);
  });
  return emitPredictions(preds, newInfo.outOrient);
}

export function fnTREND(args: RuntimeValue[]): RuntimeValue {
  const parsed = parseRegressionInputs(args);
  if (isErr(parsed)) {
    return parsed;
  }
  const { y, X, k, xOrient } = parsed;
  const lsq = runLeastSquares({ y, X, includeIntercept: true, logMode: false }, false);
  if (isErr(lsq)) {
    return lsq;
  }
  const b = lsq.coeffs[k];
  const slopes: number[] = new Array<number>(k);
  for (let j = 0; j < k; j++) {
    slopes[j] = lsq.coeffs[k - 1 - j];
  }
  const newInfo = parseNewX(args[2], X, k, xOrient);
  if (isErr(newInfo)) {
    return newInfo;
  }
  const preds: number[] = newInfo.X.map(row => {
    let p = b;
    for (let j = 0; j < k; j++) {
      p += slopes[j] * row[j];
    }
    return p;
  });
  return emitPredictions(preds, newInfo.outOrient);
}

export function fnLINEST(args: RuntimeValue[]): RuntimeValue {
  const parsed = parseRegressionInputs(args);
  if (isErr(parsed)) {
    return parsed;
  }
  const { y, X } = parsed;
  // 3rd arg: const (default TRUE — include intercept). FALSE → force intercept = 0.
  let includeIntercept = true;
  if (args.length > 2 && args[2].kind !== RVKind.Blank) {
    const b = toBooleanRV(topLeft(args[2]));
    if (b.kind === RVKind.Error) {
      return b;
    }
    includeIntercept = b.value;
  }
  // 4th arg: stats (default FALSE).
  let withStats = false;
  if (args.length > 3 && args[3].kind !== RVKind.Blank) {
    const b = toBooleanRV(topLeft(args[3]));
    if (b.kind === RVKind.Error) {
      return b;
    }
    withStats = b.value;
  }
  const lsq = runLeastSquares({ y, X, includeIntercept, logMode: false }, withStats);
  if (isErr(lsq)) {
    return lsq;
  }
  if (withStats) {
    return rvArray(buildStatsBlock(lsq));
  }
  return rvArray([lsq.coeffs.map(v => rvNumber(v))]);
}

export function fnLOGEST(args: RuntimeValue[]): RuntimeValue {
  const parsed = parseRegressionInputs(args);
  if (isErr(parsed)) {
    return parsed;
  }
  const { y, X } = parsed;
  let includeIntercept = true;
  if (args.length > 2 && args[2].kind !== RVKind.Blank) {
    const b = toBooleanRV(topLeft(args[2]));
    if (b.kind === RVKind.Error) {
      return b;
    }
    includeIntercept = b.value;
  }
  let withStats = false;
  if (args.length > 3 && args[3].kind !== RVKind.Blank) {
    const b = toBooleanRV(topLeft(args[3]));
    if (b.kind === RVKind.Error) {
      return b;
    }
    withStats = b.value;
  }
  const lsq = runLeastSquares({ y, X, includeIntercept, logMode: true }, withStats);
  if (isErr(lsq)) {
    return lsq;
  }
  if (withStats) {
    // LOGEST reports exp-transformed slopes/intercept in row 1 but keeps rows 2-5 as LINEST
    const block = buildStatsBlock(lsq);
    block[0] = lsq.coeffs.map(v => rvNumber(Math.exp(v)));
    return rvArray(block);
  }
  return rvArray([lsq.coeffs.map(v => rvNumber(Math.exp(v)))]);
}

// ============================================================================
// F.DIST.RT, F.INV.RT — F-distribution right tail
// ============================================================================

/**
 * F.DIST.RT(x, d1, d2) — right-tail probability of the F-distribution.
 *
 * Equivalent to `1 - F.DIST(x, d1, d2, TRUE)`. Using the symmetry of the
 * regularized incomplete beta function, this can be expressed as
 * `I(d2/(d2 + d1*x), d2/2, d1/2)`, which avoids subtracting from 1 and
 * is numerically stable in the upper tail.
 */
export function fnF_DIST_RT(args: RuntimeValue[]): RuntimeValue {
  const x = argToNumber(args[0]);
  if (x.kind === RVKind.Error) {
    return x;
  }
  const df1 = argToNumber(args[1]);
  if (df1.kind === RVKind.Error) {
    return df1;
  }
  const df2 = argToNumber(args[2]);
  if (df2.kind === RVKind.Error) {
    return df2;
  }
  if (x.value < 0 || df1.value < 1 || df2.value < 1) {
    return ERRORS.NUM;
  }
  // At x=0 the right tail equals 1 (entire distribution above 0).
  if (x.value === 0) {
    return rvNumber(1);
  }
  const d1 = df1.value;
  const d2 = df2.value;
  // Right tail via symmetry: I(d2/(d2 + d1*x), d2/2, d1/2).
  return rvNumber(betaIncomplete(d2 / (d2 + d1 * x.value), d2 / 2, d1 / 2));
}

/**
 * F.INV.RT(p, d1, d2) — inverse right-tail of the F-distribution.
 * Returns x such that P(F > x) = p. Implemented via binary search on the
 * right-tail CDF (monotonically decreasing from 1 at x=0 to 0 at x=∞).
 */
export function fnF_INV_RT(args: RuntimeValue[]): RuntimeValue {
  const p = argToNumber(args[0]);
  if (p.kind === RVKind.Error) {
    return p;
  }
  const df1 = argToNumber(args[1]);
  if (df1.kind === RVKind.Error) {
    return df1;
  }
  const df2 = argToNumber(args[2]);
  if (df2.kind === RVKind.Error) {
    return df2;
  }
  if (p.value <= 0 || p.value > 1 || df1.value < 1 || df2.value < 1) {
    return ERRORS.NUM;
  }
  const d1 = df1.value;
  const d2 = df2.value;
  // Right-tail CDF at x: I(d2/(d2 + d1*x), d2/2, d1/2), decreases with x.
  let lo = 0;
  let hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const rt = betaIncomplete(d2 / (d2 + d1 * mid), d2 / 2, d1 / 2);
    if (rt > p.value) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-10) {
      break;
    }
  }
  return rvNumber((lo + hi) / 2);
}

// ============================================================================
// SKEW, SKEW.P, KURT
// ============================================================================

/**
 * SKEW — sample skewness.
 * Formula: n / ((n-1)(n-2)) * Σ((xi-mean)/s)^3, where s is the sample stdev.
 */
export function fnSKEW(args: RuntimeValue[]): RuntimeValue {
  const xs = toNumberArray(args);
  if (!Array.isArray(xs)) {
    return xs;
  }
  const n = xs.length;
  if (n < 3) {
    return ERRORS.DIV0;
  }
  // Single pass 1: mean.
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += xs[i];
  }
  const mean = sum / n;
  // Single pass 2: accumulate Σ(x−μ)² and Σ(x−μ)³ together. Computing
  // the cubed normalisation after the loop (dividing by stdev³) is
  // algebraically equivalent to Σ((x−μ)/s)³ and avoids the third pass.
  let sumSq = 0;
  let sumCube = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - mean;
    const d2 = d * d;
    sumSq += d2;
    sumCube += d2 * d;
  }
  const sampleStd = Math.sqrt(sumSq / (n - 1));
  if (sampleStd === 0) {
    return ERRORS.DIV0;
  }
  return rvNumber((n / ((n - 1) * (n - 2))) * (sumCube / (sampleStd * sampleStd * sampleStd)));
}

/**
 * SKEW.P — population skewness.
 * Formula: (1/n) * Σ((xi-mean)/σ)^3, where σ is the population stdev.
 */
export function fnSKEW_P(args: RuntimeValue[]): RuntimeValue {
  const xs = toNumberArray(args);
  if (!Array.isArray(xs)) {
    return xs;
  }
  const n = xs.length;
  if (n < 1) {
    return ERRORS.DIV0;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += xs[i];
  }
  const mean = sum / n;
  let sumSq = 0;
  let sumCube = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - mean;
    const d2 = d * d;
    sumSq += d2;
    sumCube += d2 * d;
  }
  const popStd = Math.sqrt(sumSq / n);
  if (popStd === 0) {
    return ERRORS.DIV0;
  }
  return rvNumber(sumCube / n / (popStd * popStd * popStd));
}

/**
 * KURT — sample excess kurtosis.
 * Formula: n(n+1) / ((n-1)(n-2)(n-3)) * Σ((xi-mean)/s)^4 - 3(n-1)^2 / ((n-2)(n-3)).
 */
export function fnKURT(args: RuntimeValue[]): RuntimeValue {
  const xs = toNumberArray(args);
  if (!Array.isArray(xs)) {
    return xs;
  }
  const n = xs.length;
  if (n < 4) {
    return ERRORS.DIV0;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += xs[i];
  }
  const mean = sum / n;
  // Single pass for Σ(x−μ)² and Σ(x−μ)⁴ — the `(x−μ)/s` normalisation
  // is factored out after the loop (divide by stdev⁴) so we don't need
  // to know `s` ahead of time.
  let sumSq = 0;
  let sumQuad = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - mean;
    const d2 = d * d;
    sumSq += d2;
    sumQuad += d2 * d2;
  }
  const sampleStd = Math.sqrt(sumSq / (n - 1));
  if (sampleStd === 0) {
    return ERRORS.DIV0;
  }
  const s4 = sampleStd * sampleStd;
  const term1 = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const term2 = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return rvNumber(term1 * (sumQuad / (s4 * s4)) - term2);
}

// ============================================================================
// PERCENTRANK family
// ============================================================================

/**
 * Compute PERCENTRANK's significance-truncated result.
 *
 * Excel's `significance` truncates the return value to that many
 * digits — `significance=3` (default) yields 0.123 rather than
 * 0.12345. It is a display truncation, not a rounding, so we
 * implement it by `floor(value * 10^n) / 10^n`.
 */
function truncateToSignificance(value: number, significance: number): number {
  if (significance < 1) {
    return Number.NaN;
  }
  // Significance must be an integer; Excel truncates toward zero.
  const n = Math.trunc(significance);
  const scale = Math.pow(10, n);
  return Math.floor(value * scale) / scale;
}

/**
 * Compute the PERCENTRANK.INC or PERCENTRANK.EXC value.
 *
 * For PERCENTRANK.INC (inclusive):
 *   rank = i / (n - 1) when x is at sorted index i (0-based, exact match),
 *   or linear interpolation between the two bracketing values.
 *   x < min or x > max → #N/A.
 *
 * For PERCENTRANK.EXC (exclusive):
 *   rank = (i + 1) / (n + 1) when x is at sorted index i (0-based, exact match).
 *   x outside [min, max] or rank outside [1/(n+1), n/(n+1)] → #N/A.
 */
function computePercentRank(sorted: number[], x: number, inclusive: boolean): number | null {
  const n = sorted.length;
  if (n === 0) {
    return null;
  }

  // Exact match: find the first index where sorted[i] === x.
  // Binary search for lower bound.
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] === x) {
      // Find first occurrence (ties go to earliest index).
      let i = mid;
      while (i > 0 && sorted[i - 1] === x) {
        i--;
      }
      found = i;
      break;
    }
    if (sorted[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found >= 0) {
    if (inclusive) {
      return n === 1 ? 1 : found / (n - 1);
    }
    return (found + 1) / (n + 1);
  }

  // Interpolation case — x is strictly between sorted[hi] and sorted[lo].
  // After the loop, lo = insertion point; hi = lo - 1.
  if (hi < 0 || lo >= n) {
    return null; // out of range
  }
  // Linear interpolation between the two neighbors.
  const lower = sorted[hi];
  const upper = sorted[lo];
  if (upper === lower) {
    // Degenerate — shouldn't happen given the exact-match check above.
    return null;
  }
  const fraction = (x - lower) / (upper - lower);
  if (inclusive) {
    if (n === 1) {
      return 1;
    }
    return (hi + fraction) / (n - 1);
  }
  const rank = (hi + 1 + fraction) / (n + 1);
  // PERCENTRANK.EXC return range is [1/(n+1), n/(n+1)].
  const minR = 1 / (n + 1);
  const maxR = n / (n + 1);
  if (rank < minR || rank > maxR) {
    return null;
  }
  return rank;
}

function fnPercentRankImpl(args: RuntimeValue[], inclusive: boolean): RuntimeValue {
  if (args.length < 2) {
    return ERRORS.VALUE;
  }
  const vals = flattenNumbers([args[0]]);
  const err = firstError(vals);
  if (err) {
    return err;
  }
  const xV = toNumberRV(topLeft(args[1]));
  if (isError(xV)) {
    return xV;
  }

  const significanceV = args.length > 2 ? toNumberRV(topLeft(args[2])) : rvNumber(3);
  if (isError(significanceV)) {
    return significanceV;
  }
  const significance = significanceV.value;
  if (significance < 1) {
    return ERRORS.NUM;
  }

  const nums = vals.map(v => (v as NumberValue).value);
  if (nums.length === 0) {
    return ERRORS.NUM;
  }
  const sorted = [...nums].sort((a, b) => a - b);

  const rank = computePercentRank(sorted, xV.value, inclusive);
  if (rank === null) {
    return ERRORS.NA;
  }
  const truncated = truncateToSignificance(rank, significance);
  if (Number.isNaN(truncated)) {
    return ERRORS.NUM;
  }
  return rvNumber(truncated);
}

export function fnPERCENTRANK(args: RuntimeValue[]): RuntimeValue {
  return fnPercentRankImpl(args, true);
}
export function fnPERCENTRANK_INC(args: RuntimeValue[]): RuntimeValue {
  return fnPercentRankImpl(args, true);
}
export function fnPERCENTRANK_EXC(args: RuntimeValue[]): RuntimeValue {
  return fnPercentRankImpl(args, false);
}

// ============================================================================
// PROB — probability that values in X-range are between two limits
// ============================================================================

/**
 * PROB(x_range, prob_range, lower_limit, [upper_limit]) — probability that
 * values in x_range are between lower_limit and upper_limit inclusive.
 *
 * Excel rules:
 *   - x_range and prob_range must have the same dimensions
 *   - prob_range entries must sum to 1 (±ε); otherwise #NUM!
 *   - Any prob entry ≤ 0 or > 1 → #NUM!
 *   - upper_limit omitted → probability that x = lower_limit
 *   - Result is the sum of prob_range entries for which
 *     lower_limit ≤ x_range value ≤ upper_limit
 */
export function fnPROB(args: RuntimeValue[]): RuntimeValue {
  if (args.length < 3 || args.length > 4) {
    return ERRORS.VALUE;
  }
  const xVals = flattenNumbers([args[0]]);
  const xErr = firstError(xVals);
  if (xErr) {
    return xErr;
  }
  const pVals = flattenNumbers([args[1]]);
  const pErr = firstError(pVals);
  if (pErr) {
    return pErr;
  }
  if (xVals.length !== pVals.length) {
    return ERRORS.NA;
  }
  if (xVals.length === 0) {
    return ERRORS.NUM;
  }

  const lowerV = toNumberRV(topLeft(args[2]));
  if (isError(lowerV)) {
    return lowerV;
  }
  const upperV = args.length > 3 ? toNumberRV(topLeft(args[3])) : lowerV;
  if (isError(upperV)) {
    return upperV;
  }

  const lower = lowerV.value;
  const upper = upperV.value;
  if (lower > upper) {
    return ERRORS.NUM;
  }

  // Probabilities must be in (0, 1] and sum to 1.
  let total = 0;
  for (const p of pVals) {
    const pv = (p as NumberValue).value;
    if (pv <= 0 || pv > 1) {
      return ERRORS.NUM;
    }
    total += pv;
  }
  // Excel's tolerance is fairly loose — well within float noise.
  if (Math.abs(total - 1) > 1e-9) {
    return ERRORS.NUM;
  }

  let result = 0;
  for (let i = 0; i < xVals.length; i++) {
    const xv = (xVals[i] as NumberValue).value;
    if (xv >= lower && xv <= upper) {
      result += (pVals[i] as NumberValue).value;
    }
  }
  return rvNumber(result);
}

// ============================================================================
// Z.TEST, T.TEST, F.TEST, CHISQ.TEST — hypothesis tests
// ============================================================================

/**
 * Standard normal CDF — shared by Z.TEST and the T.TEST approximations.
 * Uses the same erf-based formula as fnNORMSDIST.
 */
function normalCDF(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation, same family used elsewhere.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Z.TEST(array, x, [sigma]) — one-tailed probability value for z-test.
 *   mean = AVERAGE(array), n = COUNT(array)
 *   sigma = provided OR sample standard deviation of array
 *   z = (mean - x) / (sigma / √n)
 *   Z.TEST = 1 - NORM.S.DIST(z, TRUE)
 */
export function fnZ_TEST(args: RuntimeValue[]): RuntimeValue {
  const vals = flattenNumbers([args[0]]);
  const err = firstError(vals);
  if (err) {
    return err;
  }
  const xV = toNumberRV(topLeft(args[1]));
  if (isError(xV)) {
    return xV;
  }
  const nums = vals.map(v => (v as NumberValue).value);
  if (nums.length === 0) {
    return ERRORS.NA;
  }
  const mean = nums.reduce((s, v) => s + v, 0) / nums.length;

  let sigma: number;
  if (args.length > 2) {
    const sigmaV = toNumberRV(topLeft(args[2]));
    if (isError(sigmaV)) {
      return sigmaV;
    }
    if (sigmaV.value <= 0) {
      return ERRORS.NUM;
    }
    sigma = sigmaV.value;
  } else {
    // Sample std dev.
    if (nums.length < 2) {
      return ERRORS.DIV0;
    }
    let ss = 0;
    for (const v of nums) {
      ss += (v - mean) * (v - mean);
    }
    sigma = Math.sqrt(ss / (nums.length - 1));
    if (sigma === 0) {
      return ERRORS.DIV0;
    }
  }

  const z = (mean - xV.value) / (sigma / Math.sqrt(nums.length));
  return rvNumber(1 - normalCDF(z));
}

/**
 * F.TEST(array1, array2) — two-tailed F-test probability comparing
 * the variances of two samples.
 *
 *   F = var(larger) / var(smaller)  (always >= 1)
 *   P = 2 × P(F_dist(df1, df2) > F)
 */
export function fnF_TEST(args: RuntimeValue[]): RuntimeValue {
  const v1 = flattenNumbers([args[0]]);
  const e1 = firstError(v1);
  if (e1) {
    return e1;
  }
  const v2 = flattenNumbers([args[1]]);
  const e2 = firstError(v2);
  if (e2) {
    return e2;
  }
  const a1 = v1.map(v => (v as NumberValue).value);
  const a2 = v2.map(v => (v as NumberValue).value);
  if (a1.length < 2 || a2.length < 2) {
    return ERRORS.DIV0;
  }

  const varOf = (xs: number[]): number => {
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    let ss = 0;
    for (const v of xs) {
      ss += (v - mean) * (v - mean);
    }
    return ss / (xs.length - 1);
  };
  const var1 = varOf(a1);
  const var2 = varOf(a2);
  if (var1 === 0 || var2 === 0) {
    return ERRORS.DIV0;
  }

  // Ensure f >= 1 so we evaluate the right tail.
  const f = var1 / var2;
  const df1 = a1.length - 1;
  const df2 = a2.length - 1;

  // Regularised incomplete beta: Ix(a,b).
  // F-distribution right-tail = I_{df2/(df2+df1*F)}(df2/2, df1/2).
  // Two-tailed p = 2 × min(right, left) = 2 × min(right, 1-right).
  const x = df2 / (df2 + df1 * f);
  const rightTail = incompleteBeta(x, df2 / 2, df1 / 2);
  const twoTail = 2 * Math.min(rightTail, 1 - rightTail);
  return rvNumber(twoTail);
}

/**
 * Regularised incomplete beta function I_x(a, b). Lentz's continued
 * fraction, adapted from Numerical Recipes §6.4. Sufficient precision
 * for probability-value calculations.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  const useFront = x < (a + 1) / (a + b + 2);
  const cf = (xx: number, aa: number, bb: number): number => {
    const maxIt = 200;
    const eps = 3e-7;
    const qab = aa + bb;
    const qap = aa + 1;
    const qam = aa - 1;
    let c = 1;
    let d = 1 - (qab * xx) / qap;
    if (Math.abs(d) < 1e-30) {
      d = 1e-30;
    }
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIt; m++) {
      const m2 = 2 * m;
      let aa2 = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
      d = 1 + aa2 * d;
      if (Math.abs(d) < 1e-30) {
        d = 1e-30;
      }
      c = 1 + aa2 / c;
      if (Math.abs(c) < 1e-30) {
        c = 1e-30;
      }
      d = 1 / d;
      h *= d * c;
      aa2 = (-(aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
      d = 1 + aa2 * d;
      if (Math.abs(d) < 1e-30) {
        d = 1e-30;
      }
      c = 1 + aa2 / c;
      if (Math.abs(c) < 1e-30) {
        c = 1e-30;
      }
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < eps) {
        break;
      }
    }
    return h;
  };
  if (useFront) {
    return (bt * cf(x, a, b)) / a;
  }
  return 1 - (bt * cf(1 - x, b, a)) / b;
}

/**
 * T.TEST(array1, array2, tails, type) — tails in {1, 2}, type in {1, 2, 3}.
 *   type 1: paired
 *   type 2: two-sample, equal variance
 *   type 3: two-sample, unequal variance (Welch's)
 */
export function fnT_TEST(args: RuntimeValue[]): RuntimeValue {
  const v1 = flattenNumbers([args[0]]);
  const e1 = firstError(v1);
  if (e1) {
    return e1;
  }
  const v2 = flattenNumbers([args[1]]);
  const e2 = firstError(v2);
  if (e2) {
    return e2;
  }
  const tailsV = toNumberRV(topLeft(args[2]));
  if (isError(tailsV)) {
    return tailsV;
  }
  const typeV = toNumberRV(topLeft(args[3]));
  if (isError(typeV)) {
    return typeV;
  }

  const tails = Math.trunc(tailsV.value);
  const type = Math.trunc(typeV.value);
  if (tails !== 1 && tails !== 2) {
    return ERRORS.NUM;
  }
  if (type !== 1 && type !== 2 && type !== 3) {
    return ERRORS.NUM;
  }

  const a1 = v1.map(v => (v as NumberValue).value);
  const a2 = v2.map(v => (v as NumberValue).value);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const sampleVar = (xs: number[], m: number) => {
    let ss = 0;
    for (const v of xs) {
      ss += (v - m) * (v - m);
    }
    return ss / (xs.length - 1);
  };

  let t: number;
  let df: number;

  if (type === 1) {
    // Paired
    if (a1.length !== a2.length) {
      return ERRORS.NA;
    }
    if (a1.length < 2) {
      return ERRORS.DIV0;
    }
    const diffs = a1.map((v, i) => v - a2[i]);
    const md = mean(diffs);
    const sd2 = sampleVar(diffs, md);
    if (sd2 === 0) {
      return ERRORS.DIV0;
    }
    t = md / Math.sqrt(sd2 / diffs.length);
    df = diffs.length - 1;
  } else if (type === 2) {
    // Two-sample, equal variance (pooled)
    const n1 = a1.length;
    const n2 = a2.length;
    if (n1 < 2 || n2 < 2) {
      return ERRORS.DIV0;
    }
    const m1 = mean(a1);
    const m2 = mean(a2);
    const s1 = sampleVar(a1, m1);
    const s2 = sampleVar(a2, m2);
    const sp2 = ((n1 - 1) * s1 + (n2 - 1) * s2) / (n1 + n2 - 2);
    if (sp2 === 0) {
      return ERRORS.DIV0;
    }
    t = (m1 - m2) / Math.sqrt(sp2 * (1 / n1 + 1 / n2));
    df = n1 + n2 - 2;
  } else {
    // Two-sample, unequal variance (Welch's)
    const n1 = a1.length;
    const n2 = a2.length;
    if (n1 < 2 || n2 < 2) {
      return ERRORS.DIV0;
    }
    const m1 = mean(a1);
    const m2 = mean(a2);
    const s1 = sampleVar(a1, m1);
    const s2 = sampleVar(a2, m2);
    if (s1 === 0 && s2 === 0) {
      return ERRORS.DIV0;
    }
    const se2 = s1 / n1 + s2 / n2;
    t = (m1 - m2) / Math.sqrt(se2);
    df = (se2 * se2) / (((s1 / n1) * (s1 / n1)) / (n1 - 1) + ((s2 / n2) * (s2 / n2)) / (n2 - 1));
  }

  // Two-tailed p = I_{df/(df + t^2)}(df/2, 1/2)
  const x = df / (df + t * t);
  const oneTail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return rvNumber(tails === 1 ? oneTail : 2 * oneTail);
}

/**
 * CHISQ.TEST(actual_range, expected_range) — chi-square independence test.
 *
 *   χ² = Σ (actual_i - expected_i)² / expected_i
 *   df = (rows-1)(cols-1) for a contingency table, or n-1 for 1-D
 *   p = 1 - CHISQ.DIST(χ², df, TRUE)
 */
export function fnCHISQ_TEST(args: RuntimeValue[]): RuntimeValue {
  if (args[0].kind !== RVKind.Array || args[1].kind !== RVKind.Array) {
    return ERRORS.VALUE;
  }
  const a = args[0] as ArrayValue;
  const e = args[1] as ArrayValue;
  if (a.height !== e.height || a.width !== e.width) {
    return ERRORS.NA;
  }
  let chi2 = 0;
  for (let r = 0; r < a.height; r++) {
    for (let c = 0; c < a.width; c++) {
      const av = a.rows[r][c];
      const ev = e.rows[r][c];
      if (av.kind === RVKind.Error) {
        return av;
      }
      if (ev.kind === RVKind.Error) {
        return ev;
      }
      if (av.kind !== RVKind.Number || ev.kind !== RVKind.Number) {
        return ERRORS.VALUE;
      }
      if (ev.value <= 0) {
        return ERRORS.NUM;
      }
      const diff = av.value - ev.value;
      chi2 += (diff * diff) / ev.value;
    }
  }
  // df: (rows-1)(cols-1) for contingency tables, n-1 for 1-D.
  let df: number;
  if (a.height === 1 || a.width === 1) {
    df = a.height * a.width - 1;
  } else {
    df = (a.height - 1) * (a.width - 1);
  }
  if (df < 1) {
    return ERRORS.NA;
  }
  // p = 1 - CHISQ.DIST.CDF(chi2, df) = right tail
  return rvNumber(1 - gammaIncomplete(df / 2, chi2 / 2));
}
