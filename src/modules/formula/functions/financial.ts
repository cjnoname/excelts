/**
 * Financial Functions — Native RuntimeValue implementation.
 */

import { flattenNumbers, firstError } from "@formula/functions/_shared";
import type { FunctionRuntimeContext } from "@formula/runtime/function-context";
import { DEFAULT_FUNCTION_CONTEXT } from "@formula/runtime/function-context";
import type { RuntimeValue, NumberValue, ErrorValue } from "@formula/runtime/values";
import {
  RVKind,
  ERRORS,
  isError,
  isArray,
  toNumberRV,
  toBooleanRV,
  topLeft,
  rvNumber,
  rvBoolean
} from "@formula/runtime/values";
import { partsToSerial, serialToParts } from "@utils/excel-serial";
import { excelToDate } from "@utils/utils.base";

/**
 * Convert an Excel serial to a UTC `Date`, honouring the active date1904 mode.
 *
 * All date math in this module must read fields with the `getUTC*` family
 * because `excelToDate()` returns a `Date` whose UTC timeline corresponds
 * to the Excel serial. Using local-time accessors would make bond maths
 * drift by a day whenever the host lives west of UTC.
 */
function toDate(serial: number, context: FunctionRuntimeContext): Date {
  return excelToDate(serial, context.date1904);
}

// ============================================================================
// Type alias for native function signature
// ============================================================================

// ============================================================================
// Financial Functions
// ============================================================================

export function fnPMT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const nper = toNumberRV(topLeft(args[1]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[2]));
  if (isError(pv)) {
    return pv;
  }
  const fv = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(fv)) {
    return fv;
  }
  const type = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  // Excel collapses any truthy `type` to 1 and any falsy to 0. Passing a
  // non-binary number silently changed the PMT result; normalise up front
  // so callers can't smuggle intermediate values in.
  const typeBit = type.value ? 1 : 0;
  // The simplified closed-form PMT divides by `nper` (rate=0 branch) or by
  // `(1+rate)^nper - 1` (rate!=0 branch). Both collapse at nper=0, so we
  // return #DIV/0! before attempting the math. The explicit guard matches
  // Excel's behaviour on PMT(0, 0, …) and PMT(r, 0, …).
  // Any `nper = 0` collapses the annuity equation (there are no periods
  // over which to amortise). Regardless of `rate`, this is #DIV/0! —
  // previously only the `rate = 0 && nper = 0` branch was guarded, so
  // `PMT(0.05, 0, 1000)` produced NaN and silently serialised as null.
  if (nper.value === 0) {
    return ERRORS.DIV0;
  }
  if (rate.value === 0) {
    return rvNumber(-(pv.value + fv.value) / nper.value);
  }
  const pvif = Math.pow(1 + rate.value, nper.value);
  return rvNumber(
    -(rate.value * (pv.value * pvif + fv.value)) / (pvif - 1) / (1 + rate.value * typeBit)
  );
}

export function fnFV(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const nper = toNumberRV(topLeft(args[1]));
  if (isError(nper)) {
    return nper;
  }
  const pmt = toNumberRV(topLeft(args[2]));
  if (isError(pmt)) {
    return pmt;
  }
  const pv = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(pv)) {
    return pv;
  }
  const type = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  const typeBit = type.value ? 1 : 0;
  // At rate=0 the formula reduces to `-(pv + pmt*nper)`; when both rate
  // and nper are zero the underlying annuity equation is mathematically
  // undefined (no periods over which to accrue), so Excel returns
  // #DIV/0! — guard explicitly to keep the behaviour obvious.
  if (nper.value === 0 && rate.value === 0) {
    return ERRORS.DIV0;
  }
  if (rate.value === 0) {
    return rvNumber(-(pv.value + pmt.value * nper.value));
  }
  const pvif = Math.pow(1 + rate.value, nper.value);
  return rvNumber(
    -(pv.value * pvif + pmt.value * (1 + rate.value * typeBit) * ((pvif - 1) / rate.value))
  );
}

export function fnPV(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const nper = toNumberRV(topLeft(args[1]));
  if (isError(nper)) {
    return nper;
  }
  const pmt = toNumberRV(topLeft(args[2]));
  if (isError(pmt)) {
    return pmt;
  }
  const fv = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(fv)) {
    return fv;
  }
  const type = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  const typeBit = type.value ? 1 : 0;
  // Same boundary as FV/PMT: at rate=0 and nper=0 the annuity is
  // mathematically undefined, so surface #DIV/0! instead of the
  // coincidentally-finite `-fv` that the formula would otherwise yield.
  if (nper.value === 0 && rate.value === 0) {
    return ERRORS.DIV0;
  }
  if (rate.value === 0) {
    return rvNumber(-pmt.value * nper.value - fv.value);
  }
  const pvif = Math.pow(1 + rate.value, nper.value);
  return rvNumber(
    -(fv.value + pmt.value * (1 + rate.value * typeBit) * ((pvif - 1) / rate.value)) / pvif
  );
}

export function fnNPV(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  // NPV divides each cash flow by `(1 + rate)^i`. When `1 + rate == 0`
  // (i.e. rate == -1) the discount factor is zero for every period and
  // the series is undefined — Excel returns #DIV/0!. Guard explicitly so
  // we don't fall through to Infinity/NaN in the pow-and-divide below.
  if (1 + rate.value === 0) {
    return ERRORS.DIV0;
  }
  const values: number[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (isArray(a)) {
      for (const row of a.rows) {
        for (const cell of row) {
          // Propagate errors encountered inside the cash-flow range —
          // previously silently filtered, hiding `#N/A` / `#DIV/0!`
          // that should surface as the NPV result.
          if (cell.kind === RVKind.Error) {
            return cell;
          }
          if (cell.kind === RVKind.Number) {
            values.push(cell.value);
          }
        }
      }
    } else {
      const n = toNumberRV(a);
      if (isError(n)) {
        return n;
      }
      values.push(n.value);
    }
  }
  // Excel requires at least one cash flow; `NPV(rate)` with nothing to
  // discount is a #VALUE! in the desktop app. (The previous code happily
  // returned 0, which could mask buggy callers.)
  if (values.length === 0) {
    return ERRORS.VALUE;
  }
  let npv = 0;
  for (let i = 0; i < values.length; i++) {
    npv += values[i] / Math.pow(1 + rate.value, i + 1);
  }
  return isFinite(npv) ? rvNumber(npv) : ERRORS.NUM;
}

export function fnIRR(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  if (!isArray(args[0])) {
    return ERRORS.VALUE;
  }
  const values: number[] = [];
  for (const row of args[0].rows) {
    for (const cell of row) {
      if (cell.kind === RVKind.Number) {
        values.push(cell.value);
      }
    }
  }
  if (values.length < 2) {
    return ERRORS.NUM;
  }
  // Excel requires at least one sign change in the cash-flow series — an
  // IRR cannot exist for an all-positive or all-negative stream. Without
  // this guard, Newton would drift toward an asymptote near g = -1 and
  // might return a spurious "converged" value.
  let hasPos = false;
  let hasNeg = false;
  for (const v of values) {
    if (v > 0) {
      hasPos = true;
    }
    if (v < 0) {
      hasNeg = true;
    }
  }
  if (!hasPos || !hasNeg) {
    return ERRORS.NUM;
  }
  // Excel's `guess` argument defaults to 0.1 when omitted. A user-supplied
  // BLANK (e.g. `IRR(B2:B6, )` with an empty second slot) should also fall
  // back to 0.1 — without this the Newton scan starts at `g = 0`, which
  // sits exactly at the discount-factor singularity of several cash-flow
  // shapes and can fail to converge. Genuine numeric guesses (including 0
  // explicitly supplied as a number) are honoured as given.
  const guessRV =
    args.length > 1 && args[1].kind !== RVKind.Blank ? toNumberRV(topLeft(args[1])) : rvNumber(0.1);
  if (isError(guessRV)) {
    return guessRV;
  }
  const npvAt = (g: number): number => {
    let s = 0;
    for (let i = 0; i < values.length; i++) {
      s += values[i] / Math.pow(1 + g, i);
    }
    return s;
  };
  // Bracket a root by scanning a reasonable rate range once; then Newton
  // refines within the bracket. This is more robust than pure Newton from
  // a single starting point, which for multi-sign flows can wander to a
  // different root or diverge.
  let g = guessRV.value;
  for (let iter = 0; iter < 100; iter++) {
    let npv = 0;
    let dnpv = 0;
    for (let i = 0; i < values.length; i++) {
      const p = Math.pow(1 + g, i);
      if (!isFinite(p) || p === 0) {
        break;
      }
      npv += values[i] / p;
      dnpv -= (i * values[i]) / (p * (1 + g));
    }
    if (!isFinite(npv) || !isFinite(dnpv) || Math.abs(dnpv) < 1e-15) {
      break;
    }
    const newGuess = g - npv / dnpv;
    if (!isFinite(newGuess) || newGuess <= -1) {
      break;
    }
    if (Math.abs(newGuess - g) < 1e-10) {
      return rvNumber(newGuess);
    }
    g = newGuess;
  }
  // Newton failed to converge: fall back to a bracketing search over a
  // wide range to at least find *some* root.
  const sampleRates = [-0.99, -0.5, -0.1, 0, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  let prevG = sampleRates[0];
  let prevV = npvAt(prevG);
  for (let i = 1; i < sampleRates.length; i++) {
    const currG = sampleRates[i];
    const currV = npvAt(currG);
    if (isFinite(prevV) && isFinite(currV) && prevV * currV < 0) {
      // Bisection within [prevG, currG].
      let lo = prevG;
      let hi = currG;
      let loV = prevV;
      for (let b = 0; b < 100; b++) {
        const mid = (lo + hi) / 2;
        const midV = npvAt(mid);
        if (!isFinite(midV)) {
          break;
        }
        if (Math.abs(midV) < 1e-10 || hi - lo < 1e-12) {
          return rvNumber(mid);
        }
        if (loV * midV < 0) {
          hi = mid;
        } else {
          lo = mid;
          loV = midV;
        }
      }
      return rvNumber((lo + hi) / 2);
    }
    prevG = currG;
    prevV = currV;
  }
  return ERRORS.NUM;
}

export function fnNPER(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const pmt = toNumberRV(topLeft(args[1]));
  if (isError(pmt)) {
    return pmt;
  }
  const pv = toNumberRV(topLeft(args[2]));
  if (isError(pv)) {
    return pv;
  }
  const fv = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(fv)) {
    return fv;
  }
  const type = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  // When rate=0 NPER reduces to `-(pv + fv) / pmt`; a zero payment on a
  // zero-rate loan has no solution (no periods can make the balance
  // amortise), so surface #DIV/0! rather than NaN.
  if (rate.value === 0 && pmt.value === 0) {
    return ERRORS.DIV0;
  }
  if (rate.value === 0) {
    return rvNumber(-(pv.value + fv.value) / pmt.value);
  }
  const num = pmt.value * (1 + rate.value * type.value) - fv.value * rate.value;
  const den = pv.value * rate.value + pmt.value * (1 + rate.value * type.value);
  if (num / den <= 0) {
    return ERRORS.NUM;
  }
  const result = Math.log(num / den) / Math.log(1 + rate.value);
  // A negative NPER is mathematically valid (it represents "how many
  // periods ago did this cashflow happen") but has no financial meaning
  // in Excel — the documented convention is that NPER models a forward-
  // looking loan/annuity. Reject negatives rather than returning them as
  // silently-wrong period counts. (R8 quirk from worker audit)
  if (!Number.isFinite(result) || result < 0) {
    return ERRORS.NUM;
  }
  return rvNumber(result);
}

export function fnRATE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const nper = toNumberRV(topLeft(args[0]));
  if (isError(nper)) {
    return nper;
  }
  const pmt = toNumberRV(topLeft(args[1]));
  if (isError(pmt)) {
    return pmt;
  }
  const pv = toNumberRV(topLeft(args[2]));
  if (isError(pv)) {
    return pv;
  }
  const fv = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(fv)) {
    return fv;
  }
  const type = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  // Blank → default 0.1 (see IRR / XIRR for rationale). For `fv` and
  // `type` a blank coerces to 0 via `toNumberRV`, which matches Excel's
  // documented defaults, so those are left as-is.
  const guess =
    args.length > 5 && args[5].kind !== RVKind.Blank ? toNumberRV(topLeft(args[5])) : rvNumber(0.1);
  if (isError(guess)) {
    return guess;
  }
  let g = guess.value;
  const nperV = nper.value;
  const pmtV = pmt.value;
  const pvV = pv.value;
  const fvV = fv.value;
  const typeV = type.value;
  if (nperV <= 0) {
    return ERRORS.NUM;
  }
  // Newton-Raphson. f(g) = PV·(1+g)^n + PMT·(1+g·type)·((1+g)^n − 1)/g + FV.
  //
  // The analytic derivative of the PMT term contains a 1/g² factor and a
  // `(1+g)^n − 1` cancellation, both of which lose precision as g → 0. To
  // handle that regime robustly we switch to a centred finite difference
  // when |g| is small; the finite-difference derivative is exactly what the
  // Newton iteration needs and stays well-conditioned down to g = 0 (we
  // pick the step size ~sqrt(eps) to balance truncation vs rounding error).
  const EPS = 1e-7;
  const f = (x: number): number => {
    if (Math.abs(x) < 1e-12) {
      // g = 0 limit: f(0) = PV + PMT·n + FV (the (1+g·type) factor → 1 and
      // the ((1+g)^n − 1)/g factor → n).
      return pvV + pmtV * nperV + fvV;
    }
    const pvifLocal = Math.pow(1 + x, nperV);
    return pvV * pvifLocal + pmtV * (1 + x * typeV) * ((pvifLocal - 1) / x) + fvV;
  };
  for (let iter = 0; iter < 100; iter++) {
    if (g <= -1) {
      g = -0.99;
    }
    const fg = f(g);
    let df: number;
    if (Math.abs(g) < EPS) {
      const h = 1e-5;
      df = (f(g + h) - f(g - h)) / (2 * h);
    } else {
      const pvif = Math.pow(1 + g, nperV);
      const fvifa = (pvif - 1) / g;
      df =
        nperV * pvV * Math.pow(1 + g, nperV - 1) +
        (pmtV * (1 + g * typeV) * (nperV * Math.pow(1 + g, nperV - 1) * g - pvif + 1)) / (g * g) +
        (typeV ? pmtV * fvifa : 0);
    }
    if (!isFinite(df) || Math.abs(df) < 1e-15) {
      break;
    }
    const newGuess = g - fg / df;
    if (!isFinite(newGuess)) {
      break;
    }
    if (Math.abs(newGuess - g) < 1e-10) {
      return rvNumber(newGuess);
    }
    g = newGuess;
  }
  // Did not converge after 100 iterations
  return ERRORS.NUM;
}

export function fnSLN(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const cost = toNumberRV(topLeft(args[0]));
  if (isError(cost)) {
    return cost;
  }
  const salvage = toNumberRV(topLeft(args[1]));
  if (isError(salvage)) {
    return salvage;
  }
  const life = toNumberRV(topLeft(args[2]));
  if (isError(life)) {
    return life;
  }
  if (life.value === 0) {
    return ERRORS.DIV0;
  }
  return rvNumber((cost.value - salvage.value) / life.value);
}

/**
 * SYD — Sum-of-years'-digits depreciation.
 *
 *   SYD(cost, salvage, life, per)
 *
 * The depreciation assigned to period `per` by the sum-of-years'-digits
 * method: `(cost - salvage) * (life - per + 1) * 2 / (life * (life + 1))`.
 * Excel rejects `life = 0` and period outside [1, life] with #NUM!.
 */
export function fnSYD(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const cost = toNumberRV(topLeft(args[0]));
  if (isError(cost)) {
    return cost;
  }
  const salvage = toNumberRV(topLeft(args[1]));
  if (isError(salvage)) {
    return salvage;
  }
  const life = toNumberRV(topLeft(args[2]));
  if (isError(life)) {
    return life;
  }
  const per = toNumberRV(topLeft(args[3]));
  if (isError(per)) {
    return per;
  }
  if (life.value <= 0 || per.value < 1 || per.value > life.value) {
    return ERRORS.NUM;
  }
  return rvNumber(
    ((cost.value - salvage.value) * (life.value - per.value + 1) * 2) /
      (life.value * (life.value + 1))
  );
}

/**
 * VDB — Variable Declining Balance depreciation.
 *
 *   VDB(cost, salvage, life, start_period, end_period, [factor], [no_switch])
 *
 * Applies declining-balance depreciation (with a default factor of 2
 * for double-declining) between two fractional periods. By default
 * (`no_switch = FALSE`) the method silently switches to straight-line
 * when that yields a larger deduction, matching Excel's documented
 * behaviour. `no_switch = TRUE` forces declining-balance for all
 * periods.
 */
export function fnVDB(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const cost = toNumberRV(topLeft(args[0]));
  if (isError(cost)) {
    return cost;
  }
  const salvage = toNumberRV(topLeft(args[1]));
  if (isError(salvage)) {
    return salvage;
  }
  const life = toNumberRV(topLeft(args[2]));
  if (isError(life)) {
    return life;
  }
  const start = toNumberRV(topLeft(args[3]));
  if (isError(start)) {
    return start;
  }
  const end = toNumberRV(topLeft(args[4]));
  if (isError(end)) {
    return end;
  }
  const factorRV =
    args.length > 5 && args[5].kind !== RVKind.Blank ? toNumberRV(topLeft(args[5])) : rvNumber(2);
  if (isError(factorRV)) {
    return factorRV;
  }
  const noSwitchRV =
    args.length > 6 && args[6].kind !== RVKind.Blank
      ? toBooleanRV(topLeft(args[6]))
      : rvBoolean(false);
  if (isError(noSwitchRV)) {
    return noSwitchRV;
  }
  const c = cost.value;
  const s = salvage.value;
  const l = life.value;
  const sp = start.value;
  const ep = end.value;
  const factor = factorRV.value;
  const noSwitch = noSwitchRV.value;
  if (c < 0 || s < 0 || l <= 0 || factor <= 0 || sp < 0 || ep <= sp || ep > l) {
    return ERRORS.NUM;
  }
  // Walk the integer period boundaries that lie inside [sp, ep] and
  // accumulate the declining-balance depreciation per whole period; clip
  // the fractional period pieces at the two endpoints. Excel's DDB
  // behaviour is already "clamp so book value never dips below salvage",
  // so we replicate that here.
  const periodDepn = (book: number, periodLen: number): number => {
    const decline = Math.min(book * (factor / l) * periodLen, book - s);
    return decline < 0 ? 0 : decline;
  };
  let book = c;
  let total = 0;
  // Optional switch to straight-line: once DB deduction would be less
  // than the equivalent SL deduction, Excel keeps running SL for the
  // remaining whole periods. Handled by tracking `switched` below.
  let switched = false;
  let p = 0;
  while (p < l) {
    const lo = Math.max(sp, p);
    const hi = Math.min(ep, p + 1);
    if (hi > lo) {
      const frac = hi - lo;
      let dep: number;
      if (!noSwitch && !switched) {
        const dbDep = book * (factor / l) * frac;
        const slDep = ((book - s) / (l - p)) * frac;
        if (slDep > dbDep) {
          switched = true;
          dep = slDep;
        } else {
          dep = periodDepn(book, frac);
        }
      } else if (switched) {
        dep = ((book - s) / Math.max(1e-10, l - p)) * frac;
      } else {
        dep = periodDepn(book, frac);
      }
      total += dep;
      book -= dep;
    }
    p++;
    if (book <= s || p >= ep) {
      break;
    }
  }
  return rvNumber(total);
}

export function fnDB(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const cost = toNumberRV(topLeft(args[0]));
  if (isError(cost)) {
    return cost;
  }
  const salvage = toNumberRV(topLeft(args[1]));
  if (isError(salvage)) {
    return salvage;
  }
  const life = toNumberRV(topLeft(args[2]));
  if (isError(life)) {
    return life;
  }
  const period = toNumberRV(topLeft(args[3]));
  if (isError(period)) {
    return period;
  }
  // Blank `month` → Excel default 12 (full first year). Without the
  // blank guard, `toNumberRV(BLANK)` coerces to 0 which then trips the
  // `month < 1` validation below, silently surfacing #NUM! for
  // `DB(cost, salvage, life, period, )`.
  const month =
    args.length > 4 && args[4].kind !== RVKind.Blank ? toNumberRV(topLeft(args[4])) : rvNumber(12);
  if (isError(month)) {
    return month;
  }
  // Excel validates: cost >= 0, salvage >= 0, life > 0, period > 0, 1 <= month <= 12.
  // Also period must be <= life + 1 (the "stub" trailing month period).
  if (
    cost.value < 0 ||
    salvage.value < 0 ||
    life.value <= 0 ||
    period.value < 1 ||
    month.value < 1 ||
    month.value > 12 ||
    period.value > life.value + 1
  ) {
    return ERRORS.NUM;
  }
  if (cost.value === 0) {
    return rvNumber(0);
  }
  // Depreciation rate rounded to 3 decimal places per Excel's published formula.
  const rate =
    salvage.value === 0
      ? 1
      : Math.round((1 - Math.pow(salvage.value / cost.value, 1 / life.value)) * 1000) / 1000;
  // The "trailing stub" period is ceil(life) + 1 when the first year is partial
  // (month < 12) and equals ceil(life) when month === 12.
  const stubPeriod = month.value === 12 ? Math.ceil(life.value) : Math.ceil(life.value) + 1;
  let totalDepreciation = 0;
  let depn = 0;
  const periods = Math.min(Math.floor(period.value), stubPeriod);
  for (let p = 1; p <= periods; p++) {
    if (p === 1) {
      depn = (cost.value * rate * month.value) / 12;
    } else if (p === stubPeriod) {
      depn = ((cost.value - totalDepreciation) * rate * (12 - month.value)) / 12;
    } else {
      depn = (cost.value - totalDepreciation) * rate;
    }
    totalDepreciation += depn;
  }
  return rvNumber(depn);
}

export function fnDDB(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const cost = toNumberRV(topLeft(args[0]));
  if (isError(cost)) {
    return cost;
  }
  const salvage = toNumberRV(topLeft(args[1]));
  if (isError(salvage)) {
    return salvage;
  }
  const life = toNumberRV(topLeft(args[2]));
  if (isError(life)) {
    return life;
  }
  const period = toNumberRV(topLeft(args[3]));
  if (isError(period)) {
    return period;
  }
  // Blank `factor` → Excel default 2 (double declining). See DB/IRR for
  // why blank must be distinguished from an explicit 0.
  const factor =
    args.length > 4 && args[4].kind !== RVKind.Blank ? toNumberRV(topLeft(args[4])) : rvNumber(2);
  if (isError(factor)) {
    return factor;
  }
  // Excel validates: cost, salvage >= 0; life, period, factor > 0; period <= life.
  if (
    cost.value < 0 ||
    salvage.value < 0 ||
    life.value <= 0 ||
    period.value < 1 ||
    period.value > life.value ||
    factor.value <= 0
  ) {
    return ERRORS.NUM;
  }
  let bookValue = cost.value;
  let depn = 0;
  const periods = Math.floor(period.value);
  for (let p = 1; p <= periods; p++) {
    depn = Math.min(bookValue * (factor.value / life.value), bookValue - salvage.value);
    if (depn < 0) {
      depn = 0;
    }
    bookValue -= depn;
  }
  return rvNumber(depn);
}

/** Internal PMT computation that returns a raw number (for IPMT/PPMT/CUMPRINC/CUMIPMT). */
function pmtRaw(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) {
    return -(pv + fv) / nper;
  }
  const pvif = Math.pow(1 + rate, nper);
  return -(rate * (pv * pvif + fv)) / (pvif - 1) / (1 + rate * type);
}

/**
 * Internal IPMT computation that returns a raw number.
 *
 * Excel's IPMT reports the interest portion of a period as a cash flow
 * *out* — i.e. negative when the loan principal is positive (you pay
 * interest). The balance-accumulation loop above produces a positive
 * running balance for a positive `pv`, so the `bal * rate` product
 * would also be positive; we negate at return to match Excel's sign
 * convention. The CUMIPMT / PPMT paths that consume this helper rely
 * on the sign being correct so `IPMT + PPMT ≡ PMT` holds.
 */
function ipmtRaw(
  rate: number,
  per: number,
  nper: number,
  pv: number,
  fv: number,
  type: number
): number {
  const pmt = pmtRaw(rate, nper, pv, fv, type);
  if (rate === 0) {
    return 0;
  }
  // Compute FV of original loan at period (per-1)
  let bal = pv;
  for (let i = 1; i < per; i++) {
    bal = bal * (1 + rate) + pmt * (1 + rate * type);
  }
  const ipmt = type === 1 && per === 1 ? 0 : -bal * rate;
  return type === 1 ? ipmt / (1 + rate) : ipmt;
}

export function fnIPMT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const per = toNumberRV(topLeft(args[1]));
  if (isError(per)) {
    return per;
  }
  const nper = toNumberRV(topLeft(args[2]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[3]));
  if (isError(pv)) {
    return pv;
  }
  const fv = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(fv)) {
    return fv;
  }
  const type = args.length > 5 ? toNumberRV(topLeft(args[5])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  return rvNumber(ipmtRaw(rate.value, per.value, nper.value, pv.value, fv.value, type.value));
}

export function fnPPMT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const per = toNumberRV(topLeft(args[1]));
  if (isError(per)) {
    return per;
  }
  const nper = toNumberRV(topLeft(args[2]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[3]));
  if (isError(pv)) {
    return pv;
  }
  const fv = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(fv)) {
    return fv;
  }
  const type = args.length > 5 ? toNumberRV(topLeft(args[5])) : rvNumber(0);
  if (isError(type)) {
    return type;
  }
  const pmtVal = pmtRaw(rate.value, nper.value, pv.value, fv.value, type.value);
  const ipmtVal = ipmtRaw(rate.value, per.value, nper.value, pv.value, fv.value, type.value);
  return rvNumber(pmtVal - ipmtVal);
}

/**
 * FVSCHEDULE — future value with a schedule of varying rates.
 *
 *   FVSCHEDULE(principal, schedule)
 *
 * Compounds `principal` through each rate in `schedule`:
 *   FV = principal · ∏(1 + rᵢ)
 *
 * Excel treats blanks in the schedule as zero (no-op compounding) and
 * propagates any error it encounters. Text values produce #VALUE!.
 */
export function fnFVSCHEDULE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const principal = toNumberRV(topLeft(args[0]));
  if (isError(principal)) {
    return principal;
  }
  const scheduleArg = args[1];
  let fv = principal.value;
  const visit = (v: RuntimeValue): ErrorValue | null => {
    if (v.kind === RVKind.Error) {
      return v;
    }
    if (v.kind === RVKind.Blank) {
      return null;
    } // treat blanks as 0%
    if (v.kind === RVKind.Number) {
      fv *= 1 + v.value;
      return null;
    }
    if (v.kind === RVKind.Boolean) {
      fv *= 1 + (v.value ? 1 : 0);
      return null;
    }
    // Strings / other: Excel surfaces #VALUE!
    return ERRORS.VALUE;
  };
  if (scheduleArg.kind === RVKind.Array) {
    for (const row of scheduleArg.rows) {
      for (const cell of row) {
        const err = visit(cell);
        if (err) {
          return err;
        }
      }
    }
  } else {
    const err = visit(scheduleArg);
    if (err) {
      return err;
    }
  }
  return rvNumber(fv);
}

/**
 * PDURATION — number of periods required for an investment to reach a
 * specified value.
 *
 *   PDURATION(rate, pv, fv) = (log fv − log pv) / log(1 + rate)
 *
 * Excel requires `rate > 0` and `pv, fv > 0`.
 */
export function fnPDURATION(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const pv = toNumberRV(topLeft(args[1]));
  if (isError(pv)) {
    return pv;
  }
  const fv = toNumberRV(topLeft(args[2]));
  if (isError(fv)) {
    return fv;
  }
  if (rate.value <= 0 || pv.value <= 0 || fv.value <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((Math.log(fv.value) - Math.log(pv.value)) / Math.log(1 + rate.value));
}

/**
 * RRI — equivalent interest rate for the growth of an investment.
 *
 *   RRI(nper, pv, fv) = (fv / pv)^(1/nper) − 1
 *
 * Excel requires `nper > 0`, `pv > 0`, `fv >= 0`.
 */
export function fnRRI(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const nper = toNumberRV(topLeft(args[0]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[1]));
  if (isError(pv)) {
    return pv;
  }
  const fv = toNumberRV(topLeft(args[2]));
  if (isError(fv)) {
    return fv;
  }
  if (nper.value <= 0 || pv.value <= 0 || fv.value < 0) {
    return ERRORS.NUM;
  }
  return rvNumber(Math.pow(fv.value / pv.value, 1 / nper.value) - 1);
}

export function fnEFFECT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const nomRate = toNumberRV(topLeft(args[0]));
  if (isError(nomRate)) {
    return nomRate;
  }
  const npery = toNumberRV(topLeft(args[1]));
  if (isError(npery)) {
    return npery;
  }
  if (nomRate.value <= 0 || npery.value < 1) {
    return ERRORS.NUM;
  }
  return rvNumber(
    Math.pow(1 + nomRate.value / Math.floor(npery.value), Math.floor(npery.value)) - 1
  );
}

export function fnNOMINAL(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const effRate = toNumberRV(topLeft(args[0]));
  if (isError(effRate)) {
    return effRate;
  }
  const npery = toNumberRV(topLeft(args[1]));
  if (isError(npery)) {
    return npery;
  }
  if (effRate.value <= 0 || npery.value < 1) {
    return ERRORS.NUM;
  }
  const np = Math.floor(npery.value);
  return rvNumber(np * (Math.pow(effRate.value + 1, 1 / np) - 1));
}

export function fnXNPV(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  if (!isArray(args[1]) || !isArray(args[2])) {
    return ERRORS.VALUE;
  }
  // Excel requires rate > -1. At rate = -1 the discount factor is
  // singular; below -1 `Math.pow(negative, non-integer)` yields NaN
  // for most date offsets.
  if (rate.value <= -1) {
    return ERRORS.NUM;
  }
  const rawValues = flattenNumbers([args[1]]);
  const valuesErr = firstError(rawValues);
  if (valuesErr) {
    return valuesErr;
  }
  const rawDates = flattenNumbers([args[2]]);
  const datesErr = firstError(rawDates);
  if (datesErr) {
    return datesErr;
  }
  const values = (rawValues as NumberValue[]).map(n => n.value);
  const dates = (rawDates as NumberValue[]).map(n => n.value);
  if (values.length === 0 || values.length !== dates.length) {
    return ERRORS.NUM;
  }
  const d0 = dates[0];
  let npv = 0;
  for (let i = 0; i < values.length; i++) {
    npv += values[i] / Math.pow(1 + rate.value, (dates[i] - d0) / 365);
  }
  return isFinite(npv) ? rvNumber(npv) : ERRORS.NUM;
}

export function fnXIRR(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  if (!isArray(args[0]) || !isArray(args[1])) {
    return ERRORS.VALUE;
  }
  const rawValues = flattenNumbers([args[0]]);
  const valuesErr = firstError(rawValues);
  if (valuesErr) {
    return valuesErr;
  }
  const rawDates = flattenNumbers([args[1]]);
  const datesErr = firstError(rawDates);
  if (datesErr) {
    return datesErr;
  }
  const values = (rawValues as NumberValue[]).map(n => n.value);
  const dates = (rawDates as NumberValue[]).map(n => n.value);
  if (values.length < 2 || values.length !== dates.length) {
    return ERRORS.NUM;
  }
  // Excel's XIRR requires both at least one positive and at least one
  // negative cash flow, same as IRR. Without this guard Newton would drift
  // toward the singularity at rate = -1 with no valid root.
  let xHasPos = false;
  let xHasNeg = false;
  for (const v of values) {
    if (v > 0) {
      xHasPos = true;
    }
    if (v < 0) {
      xHasNeg = true;
    }
  }
  if (!xHasPos || !xHasNeg) {
    return ERRORS.NUM;
  }
  // Blank third slot → default 0.1, same rationale as IRR above.
  const guessRV =
    args.length > 2 && args[2].kind !== RVKind.Blank ? toNumberRV(topLeft(args[2])) : rvNumber(0.1);
  if (isError(guessRV)) {
    return guessRV;
  }
  const d0 = dates[0];
  const xnpvAt = (g: number): number => {
    if (g <= -1) {
      return Number.NaN;
    }
    let s = 0;
    for (let i = 0; i < values.length; i++) {
      const t = (dates[i] - d0) / 365;
      const p = Math.pow(1 + g, t);
      if (!isFinite(p)) {
        return Number.NaN;
      }
      s += values[i] / p;
    }
    return s;
  };
  let g = guessRV.value;
  for (let iter = 0; iter < 100; iter++) {
    let npv = 0;
    let dnpv = 0;
    for (let i = 0; i < values.length; i++) {
      const t = (dates[i] - d0) / 365;
      npv += values[i] / Math.pow(1 + g, t);
      dnpv -= (t * values[i]) / Math.pow(1 + g, t + 1);
    }
    if (!isFinite(npv) || !isFinite(dnpv) || Math.abs(dnpv) < 1e-15) {
      break;
    }
    const newG = g - npv / dnpv;
    if (!isFinite(newG) || newG <= -1) {
      break;
    }
    if (Math.abs(newG - g) < 1e-10) {
      return rvNumber(newG);
    }
    g = newG;
  }
  // Newton failed — fall back to bisection.
  const xSampleRates = [-0.99, -0.5, -0.1, 0, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  let xPrev = xSampleRates[0];
  let xPrevV = xnpvAt(xPrev);
  for (let i = 1; i < xSampleRates.length; i++) {
    const curr = xSampleRates[i];
    const currV = xnpvAt(curr);
    if (isFinite(xPrevV) && isFinite(currV) && xPrevV * currV < 0) {
      let lo = xPrev;
      let hi = curr;
      let loV = xPrevV;
      for (let b = 0; b < 100; b++) {
        const mid = (lo + hi) / 2;
        const midV = xnpvAt(mid);
        if (!isFinite(midV)) {
          break;
        }
        if (Math.abs(midV) < 1e-10 || hi - lo < 1e-12) {
          return rvNumber(mid);
        }
        if (loV * midV < 0) {
          hi = mid;
        } else {
          lo = mid;
          loV = midV;
        }
      }
      return rvNumber((lo + hi) / 2);
    }
    xPrev = curr;
    xPrevV = currV;
  }
  return ERRORS.NUM;
}

export function fnMIRR(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  if (!isArray(args[0])) {
    return ERRORS.VALUE;
  }
  const rawValues = flattenNumbers([args[0]]);
  const valuesErr = firstError(rawValues);
  if (valuesErr) {
    return valuesErr;
  }
  const values = (rawValues as NumberValue[]).map(n => n.value);
  const financeRate = toNumberRV(topLeft(args[1]));
  if (isError(financeRate)) {
    return financeRate;
  }
  const reinvestRate = toNumberRV(topLeft(args[2]));
  if (isError(reinvestRate)) {
    return reinvestRate;
  }
  const n = values.length;
  if (n < 2) {
    return ERRORS.NUM;
  }
  // Guard the singularities at rate = -1. Without this the pow()s below
  // become division by zero and produce Infinity/NaN.
  if (financeRate.value === -1 || reinvestRate.value === -1) {
    return ERRORS.DIV0;
  }
  let npvPos = 0;
  let npvNeg = 0;
  for (let i = 0; i < n; i++) {
    if (values[i] >= 0) {
      npvPos += values[i] * Math.pow(1 + reinvestRate.value, n - 1 - i);
    } else {
      npvNeg += values[i] / Math.pow(1 + financeRate.value, i);
    }
  }
  if (npvNeg === 0) {
    return ERRORS.DIV0;
  }
  return rvNumber(Math.pow(-npvPos / npvNeg, 1 / (n - 1)) - 1);
}

export function fnISPMT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const per = toNumberRV(topLeft(args[1]));
  if (isError(per)) {
    return per;
  }
  const nper = toNumberRV(topLeft(args[2]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[3]));
  if (isError(pv)) {
    return pv;
  }
  // ISPMT's straight-line formula divides by `nper`; zero periods leave
  // the interest undefined, matching Excel's #DIV/0! on ISPMT(…, 0, …).
  if (nper.value === 0) {
    return ERRORS.DIV0;
  }
  return rvNumber(pv.value * rate.value * (per.value / nper.value - 1));
}

export function fnCUMPRINC(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const nper = toNumberRV(topLeft(args[1]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[2]));
  if (isError(pv)) {
    return pv;
  }
  const startPeriod = toNumberRV(topLeft(args[3]));
  if (isError(startPeriod)) {
    return startPeriod;
  }
  const endPeriod = toNumberRV(topLeft(args[4]));
  if (isError(endPeriod)) {
    return endPeriod;
  }
  const type = toNumberRV(topLeft(args[5]));
  if (isError(type)) {
    return type;
  }
  if (rate.value <= 0 || nper.value <= 0 || pv.value <= 0) {
    return ERRORS.NUM;
  }
  // Excel requires 1 ≤ start ≤ end ≤ nper and type ∈ {0, 1}.
  const s = Math.floor(startPeriod.value);
  const e = Math.floor(endPeriod.value);
  const n = Math.floor(nper.value);
  if (s < 1 || e < s || e > n) {
    return ERRORS.NUM;
  }
  if (type.value !== 0 && type.value !== 1) {
    return ERRORS.NUM;
  }
  let cumPrinc = 0;
  // PMT is constant across all periods — hoist it out of the loop
  // rather than recomputing the same value `e - s + 1` times.
  const pmtVal = pmtRaw(rate.value, nper.value, pv.value, 0, type.value);
  for (let p = s; p <= e; p++) {
    const ipmtVal = ipmtRaw(rate.value, p, nper.value, pv.value, 0, type.value);
    cumPrinc += pmtVal - ipmtVal;
  }
  return rvNumber(cumPrinc);
}

export function fnCUMIPMT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const rate = toNumberRV(topLeft(args[0]));
  if (isError(rate)) {
    return rate;
  }
  const nper = toNumberRV(topLeft(args[1]));
  if (isError(nper)) {
    return nper;
  }
  const pv = toNumberRV(topLeft(args[2]));
  if (isError(pv)) {
    return pv;
  }
  const startPeriod = toNumberRV(topLeft(args[3]));
  if (isError(startPeriod)) {
    return startPeriod;
  }
  const endPeriod = toNumberRV(topLeft(args[4]));
  if (isError(endPeriod)) {
    return endPeriod;
  }
  const type = toNumberRV(topLeft(args[5]));
  if (isError(type)) {
    return type;
  }
  if (rate.value <= 0 || nper.value <= 0 || pv.value <= 0) {
    return ERRORS.NUM;
  }
  const sI = Math.floor(startPeriod.value);
  const eI = Math.floor(endPeriod.value);
  const nI = Math.floor(nper.value);
  if (sI < 1 || eI < sI || eI > nI) {
    return ERRORS.NUM;
  }
  if (type.value !== 0 && type.value !== 1) {
    return ERRORS.NUM;
  }
  let cumIpmt = 0;
  for (let p = sI; p <= eI; p++) {
    cumIpmt += ipmtRaw(rate.value, p, nper.value, pv.value, 0, type.value);
  }
  return rvNumber(cumIpmt);
}

export function fnDOLLARDE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const fractionalDollar = toNumberRV(topLeft(args[0]));
  if (isError(fractionalDollar)) {
    return fractionalDollar;
  }
  const fraction = toNumberRV(topLeft(args[1]));
  if (isError(fraction)) {
    return fraction;
  }
  if (fraction.value < 1) {
    return ERRORS.NUM;
  }
  const f = Math.floor(fraction.value);
  const intPart = Math.trunc(fractionalDollar.value);
  const fracPart = Math.abs(fractionalDollar.value) - Math.abs(intPart);
  // The fractional portion of a "fractional dollar" encodes a numerator
  // with as many digits as the denominator. For fraction = 16, `0.02`
  // means 2/16 (= 0.125), not 0.02/16 (= 0.00125). Multiplying by
  // `10^ceil(log10(f))` promotes `0.02` → 2 so the subsequent divide by
  // `f` recovers the correct rational value. The old code divided
  // *before* the scale-up, which silently shrank the result by the
  // power of ten.
  const scale = f === 1 ? 1 : Math.pow(10, Math.ceil(Math.log10(f)));
  const numerator = fracPart * scale;
  const sign = fractionalDollar.value < 0 ? -1 : 1;
  return rvNumber(sign * (Math.abs(intPart) + numerator / f));
}

export function fnDOLLARFR(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const decimalDollar = toNumberRV(topLeft(args[0]));
  if (isError(decimalDollar)) {
    return decimalDollar;
  }
  const fraction = toNumberRV(topLeft(args[1]));
  if (isError(fraction)) {
    return fraction;
  }
  if (fraction.value < 1) {
    return ERRORS.NUM;
  }
  const f = Math.floor(fraction.value);
  const intPart = Math.trunc(decimalDollar.value);
  const fracPart = Math.abs(decimalDollar.value) - Math.abs(intPart);
  // DOLLARFR is the inverse of DOLLARDE. The fractional output slot must
  // encode a numerator in a fixed-width decimal column so that, say,
  // `2/16 = 0.125` round-trips to `0.02` (two digits after the point
  // because 16 needs two decimal digits to represent numerators up to
  // 15). The previous code divided by the scale *after* multiplying,
  // which moved the numerator into the wrong decimal column and made
  // DOLLARFR(1.125, 16) return 1.2 instead of 1.02.
  const scale = f === 1 ? 1 : Math.pow(10, Math.ceil(Math.log10(f)));
  const numerator = fracPart * f;
  const sign = decimalDollar.value < 0 ? -1 : 1;
  return rvNumber(sign * (Math.abs(intPart) + numerator / scale));
}

/**
 * Common sanity check for the `basis` argument shared across the
 * discount/rate family of bond helpers. Excel rejects anything outside
 * `{0, 1, 2, 3, 4}` with `#NUM!`; previously these functions silently
 * fell back to basis 0 which produced subtly wrong year-fractions.
 */
function validateBasis(basis: number): ErrorValue | null {
  const b = Math.floor(basis);
  if (b < 0 || b > 4) {
    return ERRORS.NUM;
  }
  return null;
}

export function fnDISC(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlement = toNumberRV(topLeft(args[0]));
  if (isError(settlement)) {
    return settlement;
  }
  const maturity = toNumberRV(topLeft(args[1]));
  if (isError(maturity)) {
    return maturity;
  }
  const pr = toNumberRV(topLeft(args[2]));
  if (isError(pr)) {
    return pr;
  }
  const redemption = toNumberRV(topLeft(args[3]));
  if (isError(redemption)) {
    return redemption;
  }
  const basis = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(basis)) {
    return basis;
  }
  const basisErr = validateBasis(basis.value);
  if (basisErr) {
    return basisErr;
  }
  if (maturity.value <= settlement.value || redemption.value <= 0 || pr.value <= 0) {
    return ERRORS.NUM;
  }
  // Use the same day-count fraction engine the other bond functions rely
  // on so DISC with basis 0 (30/360) and basis 4 (European 30/360)
  // actually differ instead of both collapsing to Actual/360.
  const dcf = dayCountFraction(settlement.value, maturity.value, Math.floor(basis.value), context);
  if (dcf <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((redemption.value - pr.value) / redemption.value / dcf);
}

export function fnPRICEDISC(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlement = toNumberRV(topLeft(args[0]));
  if (isError(settlement)) {
    return settlement;
  }
  const maturity = toNumberRV(topLeft(args[1]));
  if (isError(maturity)) {
    return maturity;
  }
  const disc = toNumberRV(topLeft(args[2]));
  if (isError(disc)) {
    return disc;
  }
  const redemption = toNumberRV(topLeft(args[3]));
  if (isError(redemption)) {
    return redemption;
  }
  const basis = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(basis)) {
    return basis;
  }
  const basisErr = validateBasis(basis.value);
  if (basisErr) {
    return basisErr;
  }
  if (maturity.value <= settlement.value || disc.value <= 0 || redemption.value <= 0) {
    return ERRORS.NUM;
  }
  const dcf = dayCountFraction(settlement.value, maturity.value, Math.floor(basis.value), context);
  return rvNumber(redemption.value - disc.value * redemption.value * dcf);
}

export function fnYIELDDISC(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlement = toNumberRV(topLeft(args[0]));
  if (isError(settlement)) {
    return settlement;
  }
  const maturity = toNumberRV(topLeft(args[1]));
  if (isError(maturity)) {
    return maturity;
  }
  const pr = toNumberRV(topLeft(args[2]));
  if (isError(pr)) {
    return pr;
  }
  const redemption = toNumberRV(topLeft(args[3]));
  if (isError(redemption)) {
    return redemption;
  }
  const basis = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(basis)) {
    return basis;
  }
  const basisErr = validateBasis(basis.value);
  if (basisErr) {
    return basisErr;
  }
  if (maturity.value <= settlement.value || pr.value <= 0 || redemption.value <= 0) {
    return ERRORS.NUM;
  }
  const dcf = dayCountFraction(settlement.value, maturity.value, Math.floor(basis.value), context);
  if (dcf <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((redemption.value - pr.value) / pr.value / dcf);
}

export function fnRECEIVED(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlement = toNumberRV(topLeft(args[0]));
  if (isError(settlement)) {
    return settlement;
  }
  const maturity = toNumberRV(topLeft(args[1]));
  if (isError(maturity)) {
    return maturity;
  }
  const investment = toNumberRV(topLeft(args[2]));
  if (isError(investment)) {
    return investment;
  }
  const disc = toNumberRV(topLeft(args[3]));
  if (isError(disc)) {
    return disc;
  }
  const basis = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(basis)) {
    return basis;
  }
  const basisErr = validateBasis(basis.value);
  if (basisErr) {
    return basisErr;
  }
  if (maturity.value <= settlement.value || investment.value <= 0 || disc.value <= 0) {
    return ERRORS.NUM;
  }
  const dcf = dayCountFraction(settlement.value, maturity.value, Math.floor(basis.value), context);
  const denom = 1 - disc.value * dcf;
  if (denom === 0) {
    return ERRORS.NUM;
  }
  return rvNumber(investment.value / denom);
}

export function fnINTRATE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlement = toNumberRV(topLeft(args[0]));
  if (isError(settlement)) {
    return settlement;
  }
  const maturity = toNumberRV(topLeft(args[1]));
  if (isError(maturity)) {
    return maturity;
  }
  const investment = toNumberRV(topLeft(args[2]));
  if (isError(investment)) {
    return investment;
  }
  const redemption = toNumberRV(topLeft(args[3]));
  if (isError(redemption)) {
    return redemption;
  }
  const basis = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(basis)) {
    return basis;
  }
  const basisErr = validateBasis(basis.value);
  if (basisErr) {
    return basisErr;
  }
  if (maturity.value <= settlement.value || investment.value <= 0 || redemption.value <= 0) {
    return ERRORS.NUM;
  }
  const dcf = dayCountFraction(settlement.value, maturity.value, Math.floor(basis.value), context);
  if (dcf <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((redemption.value - investment.value) / investment.value / dcf);
}

// ============================================================================
// Bond Math — day-count conventions and coupon helpers
// ============================================================================

/**
 * Day-count fraction between two Excel date serials under a given basis.
 *
 * Implements:
 *   basis 0 — US (NASD) 30/360 with end-of-month adjustments.
 *   basis 1 — Actual/Actual (year length from the spanning year).
 *   basis 2 — Actual/360.
 *   basis 3 — Actual/365.
 *   basis 4 — European 30/360.
 *
 * Unknown basis values fall back to basis 0 for safety.
 */
function yearBasisDays(basis: number): number {
  // Approximate denominator used when converting a day-count fraction
  // back to raw days (for PRICE's A / E accrual ratio). The Actual/
  // Actual bucket uses 365.25 as an average-year constant; since PRICE
  // only needs the ratio A/E the small inaccuracy cancels out.
  switch (basis) {
    case 0:
    case 2:
    case 4:
      return 360;
    case 3:
      return 365;
    case 1:
    default:
      return 365.25;
  }
}

function dayCountFraction(
  startSerial: number,
  endSerial: number,
  basis: number,
  context: FunctionRuntimeContext
): number {
  const startD = toDate(startSerial, context);
  const endD = toDate(endSerial, context);
  const diffDays = Math.floor(endSerial) - Math.floor(startSerial);

  switch (basis) {
    case 1: {
      // Actual/Actual (ISDA convention). See YEARFRAC in date.ts for the
      // rationale — the previous simple averaging produced visibly wrong
      // results like YEARFRAC(2020-01-01, 2021-01-01) ≈ 1.001 instead of 1.
      const y1 = startD.getUTCFullYear();
      const y2 = endD.getUTCFullYear();
      if (y1 === y2) {
        const yearDays = (Date.UTC(y1 + 1, 0, 1) - Date.UTC(y1, 0, 1)) / 86400000;
        return diffDays / yearDays;
      }
      let leapDays = 0;
      let nonLeapDays = 0;
      const sdMs = startD.getTime();
      const edMs = endD.getTime();
      for (let y = y1; y <= y2; y++) {
        const yStart = Math.max(sdMs, Date.UTC(y, 0, 1));
        const yEnd = Math.min(edMs, Date.UTC(y + 1, 0, 1));
        if (yEnd <= yStart) {
          continue;
        }
        const d = (yEnd - yStart) / 86400000;
        const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
        if (isLeap) {
          leapDays += d;
        } else {
          nonLeapDays += d;
        }
      }
      return leapDays / 366 + nonLeapDays / 365;
    }
    case 2:
      return diffDays / 360;
    case 3:
      return diffDays / 365;
    case 4: {
      const d1 = Math.min(startD.getUTCDate(), 30);
      const d2 = Math.min(endD.getUTCDate(), 30);
      const m1 = startD.getUTCMonth() + 1;
      const m2 = endD.getUTCMonth() + 1;
      const y1 = startD.getUTCFullYear();
      const y2 = endD.getUTCFullYear();
      return ((y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1)) / 360;
    }
    case 0:
    default: {
      let d1 = startD.getUTCDate();
      const m1 = startD.getUTCMonth() + 1;
      const y1 = startD.getUTCFullYear();
      let d2 = endD.getUTCDate();
      const m2 = endD.getUTCMonth() + 1;
      const y2 = endD.getUTCFullYear();
      if (d1 === 31) {
        d1 = 30;
      }
      if (d2 === 31 && d1 >= 30) {
        d2 = 30;
      }
      return ((y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1)) / 360;
    }
  }
}

/**
 * Subtract (or add) `months` from an Excel date serial, clamping to month-end
 * as needed.
 *
 * Calendar arithmetic on {@link ExcelDateTimeParts}, so no `Date` and no
 * timezone is involved at any point. This previously went through `Date.UTC`
 * against a fourth hand-written spelling of the Excel epoch; the discipline
 * it needed to stay correct is now a property of the types instead of a
 * paragraph of commentary.
 */
function addMonthsToSerial(
  serial: number,
  months: number,
  context: FunctionRuntimeContext
): number {
  const { year, month, day } = serialToParts(serial, context.date1904);
  const total = month - 1 + months;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = (((total % 12) + 12) % 12) + 1;
  // Clamp to month end, so Jan-31 + 1 month is Feb-28/29 rather than Mar-3.
  // Day 0 of the following month is that month's last day, the same carry
  // rule `Date.UTC` applies.
  const lastDay = serialToParts(
    partsToSerial({ year: targetYear, month: targetMonth + 1, day: 0 }, context.date1904),
    context.date1904
  ).day;
  return partsToSerial(
    { year: targetYear, month: targetMonth, day: Math.min(day, lastDay) },
    context.date1904
  );
}

/**
 * Find the next coupon date on or after settlement, given a maturity date
 * and coupon frequency (1=annual, 2=semi-annual, 4=quarterly).
 *
 * Computed by stepping backward from maturity by (12/frequency) months
 * until the resulting date is ≤ settlement, then stepping one coupon forward.
 */
function nextCouponAfter(
  settlement: number,
  maturity: number,
  frequency: number,
  context: FunctionRuntimeContext
): number {
  const stepMonths = Math.round(12 / frequency);
  let cur = maturity;
  // Step backward until just before or at settlement.
  while (cur > settlement) {
    const prev = addMonthsToSerial(cur, -stepMonths, context);
    if (prev <= settlement) {
      return cur;
    }
    cur = prev;
  }
  return cur;
}

/**
 * Find the previous coupon date (on or before settlement).
 */
function prevCouponOnOrBefore(
  settlement: number,
  maturity: number,
  frequency: number,
  context: FunctionRuntimeContext
): number {
  const stepMonths = Math.round(12 / frequency);
  let cur = maturity;
  while (cur > settlement) {
    cur = addMonthsToSerial(cur, -stepMonths, context);
  }
  return cur;
}

/**
 * Count coupon periods between settlement and maturity (rounded up).
 */
function couponsBetween(
  settlement: number,
  maturity: number,
  frequency: number,
  context: FunctionRuntimeContext
): number {
  const stepMonths = Math.round(12 / frequency);
  let count = 0;
  let cur = maturity;
  while (cur > settlement) {
    cur = addMonthsToSerial(cur, -stepMonths, context);
    count++;
  }
  return count;
}

/**
 * Validate the basic bond arguments (frequency and basis). Returns null if
 * valid, or the appropriate #NUM! error.
 */
function validateBondBasis(frequency: number, basis: number): ErrorValue | null {
  if (frequency !== 1 && frequency !== 2 && frequency !== 4) {
    return ERRORS.NUM;
  }
  if (basis < 0 || basis > 4) {
    return ERRORS.NUM;
  }
  return null;
}

/**
 * PRICE(settlement, maturity, rate, yield, redemption, frequency, [basis])
 *
 * Price per $100 face value of a security that pays periodic interest.
 * Excel formula (standard case, more than one coupon period remaining):
 *
 *   P = [redemption / (1 + y/f)^(N - 1 + DSC/E)]
 *     + Σ_{k=1..N} [100 * r / f / (1 + y/f)^(k - 1 + DSC/E)]
 *     - 100 * r / f * A/E
 *
 * Where:
 *   f  = frequency
 *   N  = number of coupons from settlement to maturity
 *   DSC = days from settlement to next coupon
 *   E   = days in coupon period containing settlement
 *   A   = days from beginning of coupon period to settlement
 */
export function fnPRICE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const rateRV = toNumberRV(topLeft(args[2]));
  if (isError(rateRV)) {
    return rateRV;
  }
  const yieldRV = toNumberRV(topLeft(args[3]));
  if (isError(yieldRV)) {
    return yieldRV;
  }
  const redemptionRV = toNumberRV(topLeft(args[4]));
  if (isError(redemptionRV)) {
    return redemptionRV;
  }
  const frequencyRV = toNumberRV(topLeft(args[5]));
  if (isError(frequencyRV)) {
    return frequencyRV;
  }
  const basisRV = args.length > 6 ? toNumberRV(topLeft(args[6])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const rate = rateRV.value;
  const yld = yieldRV.value;
  const redemption = redemptionRV.value;
  const frequency = Math.floor(frequencyRV.value);
  const basis = Math.floor(basisRV.value);

  if (settlement >= maturity || rate < 0 || yld < 0 || redemption <= 0) {
    return ERRORS.NUM;
  }
  const basisErr = validateBondBasis(frequency, basis);
  if (basisErr) {
    return basisErr;
  }

  const nextCoupon = nextCouponAfter(settlement, maturity, frequency, context);
  const prevCoupon = prevCouponOnOrBefore(settlement, maturity, frequency, context);
  // Period length E, accrued A, and days-to-next-coupon DSC must all
  // honour the selected basis. The previous implementation used raw
  // `floor(next) - floor(prev)` day counts, which is correct for basis
  // 1/2/3 (Actual/something) but off by up to ~5 days for basis 0 and 4
  // (30/360). Using `dayCountFraction` — which already implements every
  // basis — keeps PRICE consistent with YIELD and the rest of the bond
  // family.
  const e = dayCountFraction(prevCoupon, nextCoupon, basis, context) * yearBasisDays(basis);
  const a = dayCountFraction(prevCoupon, settlement, basis, context) * yearBasisDays(basis);
  const dscDays = e - a;
  // Fractional position in period (DSC/E).
  const dscE = e === 0 ? 0 : dscDays / e;

  const N = couponsBetween(settlement, maturity, frequency, context);
  const couponAmt = (100 * rate) / frequency;
  const discountBase = 1 + yld / frequency;

  let price = redemption / Math.pow(discountBase, N - 1 + dscE);
  for (let k = 1; k <= N; k++) {
    price += couponAmt / Math.pow(discountBase, k - 1 + dscE);
  }
  price -= couponAmt * (a / e);
  return rvNumber(price);
}

/**
 * YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis])
 *
 * Inverse of PRICE: solve numerically for yield such that PRICE(...y) = pr.
 * Uses bracketed bisection in [0, 1] (100% yield upper bound covers all
 * realistic bond scenarios) followed by a light Newton polish.
 */
export function fnYIELD(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const rateRV = toNumberRV(topLeft(args[2]));
  if (isError(rateRV)) {
    return rateRV;
  }
  const prRV = toNumberRV(topLeft(args[3]));
  if (isError(prRV)) {
    return prRV;
  }
  const redemptionRV = toNumberRV(topLeft(args[4]));
  if (isError(redemptionRV)) {
    return redemptionRV;
  }
  const frequencyRV = toNumberRV(topLeft(args[5]));
  if (isError(frequencyRV)) {
    return frequencyRV;
  }
  const basisRV = args.length > 6 ? toNumberRV(topLeft(args[6])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  if (prRV.value <= 0 || redemptionRV.value <= 0) {
    return ERRORS.NUM;
  }

  const priceAt = (y: number): number => {
    const result = fnPRICE(
      [settlementRV, maturityRV, rateRV, rvNumber(y), redemptionRV, frequencyRV, basisRV],
      context
    );
    if (result.kind !== RVKind.Number) {
      return NaN;
    }
    return result.value;
  };

  // Bisection in [0, 1].
  let lo = 0;
  let hi = 1;
  const fLo = priceAt(lo) - prRV.value;
  const fHi = priceAt(hi) - prRV.value;
  if (isNaN(fLo) || isNaN(fHi)) {
    return ERRORS.NUM;
  }
  if (fLo * fHi > 0) {
    // Try extending upper bound.
    hi = 10;
    if ((priceAt(hi) - prRV.value) * fLo > 0) {
      return ERRORS.NUM;
    }
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const f = priceAt(mid) - prRV.value;
    if (isNaN(f)) {
      return ERRORS.NUM;
    }
    // PRICE decreases as yield increases, so f = priceAtY - pr decreases.
    if (f > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-12) {
      break;
    }
  }
  return rvNumber((lo + hi) / 2);
}

/**
 * DURATION(settlement, maturity, coupon, yield, frequency, [basis])
 *
 * Macaulay duration of a bond: the weighted average time to cash flows,
 * weighted by present value. Expressed in years.
 */
export function fnDURATION(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const couponRV = toNumberRV(topLeft(args[2]));
  if (isError(couponRV)) {
    return couponRV;
  }
  const yieldRV = toNumberRV(topLeft(args[3]));
  if (isError(yieldRV)) {
    return yieldRV;
  }
  const frequencyRV = toNumberRV(topLeft(args[4]));
  if (isError(frequencyRV)) {
    return frequencyRV;
  }
  const basisRV = args.length > 5 ? toNumberRV(topLeft(args[5])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const coupon = couponRV.value;
  const yld = yieldRV.value;
  const frequency = Math.floor(frequencyRV.value);
  const basis = Math.floor(basisRV.value);

  if (settlement >= maturity || coupon < 0 || yld < 0) {
    return ERRORS.NUM;
  }
  const basisErr = validateBondBasis(frequency, basis);
  if (basisErr) {
    return basisErr;
  }

  const nextCoupon = nextCouponAfter(settlement, maturity, frequency, context);
  const prevCoupon = prevCouponOnOrBefore(settlement, maturity, frequency, context);
  const periodDays = Math.floor(nextCoupon) - Math.floor(prevCoupon);
  const dscDays = Math.floor(nextCoupon) - settlement;
  const dscE = periodDays === 0 ? 0 : dscDays / periodDays;
  const N = couponsBetween(settlement, maturity, frequency, context);
  const couponPerPeriod = (100 * coupon) / frequency;
  const discountBase = 1 + yld / frequency;

  let pv = 0;
  let weighted = 0;
  for (let k = 1; k <= N; k++) {
    const t = (k - 1 + dscE) / frequency; // time in years
    const cf = k === N ? couponPerPeriod + 100 : couponPerPeriod;
    const df = Math.pow(discountBase, k - 1 + dscE);
    pv += cf / df;
    weighted += (t * cf) / df;
  }
  if (pv === 0) {
    return ERRORS.NUM;
  }
  return rvNumber(weighted / pv);
}

/**
 * MDURATION — modified duration = DURATION / (1 + yield/frequency).
 */
export function fnMDURATION(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const dur = fnDURATION(args, context);
  if (dur.kind !== RVKind.Number) {
    return dur;
  }
  const yieldRV = toNumberRV(topLeft(args[3]));
  if (isError(yieldRV)) {
    return yieldRV;
  }
  const frequencyRV = toNumberRV(topLeft(args[4]));
  if (isError(frequencyRV)) {
    return frequencyRV;
  }
  return rvNumber(dur.value / (1 + yieldRV.value / frequencyRV.value));
}

/**
 * ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method])
 *
 * Accrued interest for a security that pays periodic interest.
 * The simplified implementation (calc_method TRUE, the default) treats
 * accrued interest from issue to settlement as par * rate * dcf(issue, settlement, basis).
 */
export function fnACCRINT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const issueRV = toNumberRV(topLeft(args[0]));
  if (isError(issueRV)) {
    return issueRV;
  }
  // first_interest (args[1]) is unused in the simplified implementation.
  const settlementRV = toNumberRV(topLeft(args[2]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const rateRV = toNumberRV(topLeft(args[3]));
  if (isError(rateRV)) {
    return rateRV;
  }
  const parRV = toNumberRV(topLeft(args[4]));
  if (isError(parRV)) {
    return parRV;
  }
  const frequencyRV = toNumberRV(topLeft(args[5]));
  if (isError(frequencyRV)) {
    return frequencyRV;
  }
  const basisRV = args.length > 6 ? toNumberRV(topLeft(args[6])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }
  // calc_method (args[7]) — we ignore the distinction between TRUE/FALSE
  // because the simplified semantics always accrue from issue date.

  const issue = Math.floor(issueRV.value);
  const settlement = Math.floor(settlementRV.value);
  const frequency = Math.floor(frequencyRV.value);
  const basis = Math.floor(basisRV.value);

  if (issue >= settlement || rateRV.value <= 0 || parRV.value <= 0) {
    return ERRORS.NUM;
  }
  const basisErr = validateBondBasis(frequency, basis);
  if (basisErr) {
    return basisErr;
  }

  const dcf = dayCountFraction(issue, settlement, basis, context);
  return rvNumber(parRV.value * rateRV.value * dcf);
}

/**
 * ACCRINTM(issue, settlement, rate, par, [basis]) — accrued interest
 * for a security that pays interest at maturity.
 *   result = par × rate × dayCountFraction(issue, settlement, basis, context)
 */
export function fnACCRINTM(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const issueRV = toNumberRV(topLeft(args[0]));
  if (isError(issueRV)) {
    return issueRV;
  }
  const settlementRV = toNumberRV(topLeft(args[1]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const rateRV = toNumberRV(topLeft(args[2]));
  if (isError(rateRV)) {
    return rateRV;
  }
  const parRV = toNumberRV(topLeft(args[3]));
  if (isError(parRV)) {
    return parRV;
  }
  const basisRV = args.length > 4 ? toNumberRV(topLeft(args[4])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  const issue = Math.floor(issueRV.value);
  const settlement = Math.floor(settlementRV.value);
  const basis = Math.floor(basisRV.value);
  if (issue >= settlement || rateRV.value <= 0 || parRV.value <= 0) {
    return ERRORS.NUM;
  }
  if (basis < 0 || basis > 4) {
    return ERRORS.NUM;
  }

  const dcf = dayCountFraction(issue, settlement, basis, context);
  return rvNumber(parRV.value * rateRV.value * dcf);
}

/**
 * TBILLPRICE(settlement, maturity, discount) — price per $100 face value.
 *   price = 100 × (1 - discount × DSM / 360)
 * where DSM is days from settlement to maturity.
 */
export function fnTBILLPRICE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const discountRV = toNumberRV(topLeft(args[2]));
  if (isError(discountRV)) {
    return discountRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const discount = discountRV.value;
  if (settlement >= maturity || discount <= 0) {
    return ERRORS.NUM;
  }
  // T-bills have a max maturity of 1 year (~365 days).
  const dsm = maturity - settlement;
  if (dsm > 365) {
    return ERRORS.NUM;
  }

  const price = 100 * (1 - (discount * dsm) / 360);
  if (price <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber(price);
}

/**
 * TBILLYIELD(settlement, maturity, pr) — bond-equivalent yield.
 *   yield = (100 - pr) / pr × (360 / DSM)
 */
export function fnTBILLYIELD(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const prRV = toNumberRV(topLeft(args[2]));
  if (isError(prRV)) {
    return prRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const pr = prRV.value;
  if (settlement >= maturity || pr <= 0) {
    return ERRORS.NUM;
  }
  const dsm = maturity - settlement;
  if (dsm > 365) {
    return ERRORS.NUM;
  }

  return rvNumber(((100 - pr) / pr) * (360 / dsm));
}

/**
 * TBILLEQ(settlement, maturity, discount) — bond equivalent yield.
 *   TBILLEQ = (365 × discount) / (360 - discount × DSM)
 */
export function fnTBILLEQ(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const discountRV = toNumberRV(topLeft(args[2]));
  if (isError(discountRV)) {
    return discountRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const discount = discountRV.value;
  if (settlement >= maturity || discount <= 0) {
    return ERRORS.NUM;
  }
  const dsm = maturity - settlement;
  if (dsm > 365) {
    return ERRORS.NUM;
  }

  const denom = 360 - discount * dsm;
  if (denom <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((365 * discount) / denom);
}

/**
 * PRICEMAT(settlement, maturity, issue, rate, yld, [basis]) —
 * price per $100 face value for a security that pays interest at maturity.
 *
 *   A = DCF(issue, settlement, basis)
 *   DSM = DCF(settlement, maturity, basis)
 *   DIM = DCF(issue, maturity, basis)
 *   price = (100 + DIM × rate × 100) / (1 + DSM × yld) - A × rate × 100
 */
export function fnPRICEMAT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const issueRV = toNumberRV(topLeft(args[2]));
  if (isError(issueRV)) {
    return issueRV;
  }
  const rateRV = toNumberRV(topLeft(args[3]));
  if (isError(rateRV)) {
    return rateRV;
  }
  const yldRV = toNumberRV(topLeft(args[4]));
  if (isError(yldRV)) {
    return yldRV;
  }
  const basisRV = args.length > 5 ? toNumberRV(topLeft(args[5])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const issue = Math.floor(issueRV.value);
  const rate = rateRV.value;
  const yld = yldRV.value;
  const basis = Math.floor(basisRV.value);
  if (settlement >= maturity || issue >= settlement) {
    return ERRORS.NUM;
  }
  if (rate < 0 || yld < 0) {
    return ERRORS.NUM;
  }
  if (basis < 0 || basis > 4) {
    return ERRORS.NUM;
  }

  const a = dayCountFraction(issue, settlement, basis, context);
  const dsm = dayCountFraction(settlement, maturity, basis, context);
  const dim = dayCountFraction(issue, maturity, basis, context);
  const numerator = 100 + dim * rate * 100;
  const denominator = 1 + dsm * yld;
  return rvNumber(numerator / denominator - a * rate * 100);
}

/**
 * YIELDMAT(settlement, maturity, issue, rate, pr, [basis]) —
 * annual yield for a security that pays interest at maturity.
 *
 *   A = DCF(issue, settlement, basis)
 *   DSM = DCF(settlement, maturity, basis)
 *   DIM = DCF(issue, maturity, basis)
 *   yield = ((1 + DIM × rate) / (pr/100 + A × rate) - 1) / DSM
 */
export function fnYIELDMAT(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const issueRV = toNumberRV(topLeft(args[2]));
  if (isError(issueRV)) {
    return issueRV;
  }
  const rateRV = toNumberRV(topLeft(args[3]));
  if (isError(rateRV)) {
    return rateRV;
  }
  const prRV = toNumberRV(topLeft(args[4]));
  if (isError(prRV)) {
    return prRV;
  }
  const basisRV = args.length > 5 ? toNumberRV(topLeft(args[5])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const issue = Math.floor(issueRV.value);
  const rate = rateRV.value;
  const pr = prRV.value;
  const basis = Math.floor(basisRV.value);
  if (settlement >= maturity || issue >= settlement) {
    return ERRORS.NUM;
  }
  if (rate < 0 || pr <= 0) {
    return ERRORS.NUM;
  }
  if (basis < 0 || basis > 4) {
    return ERRORS.NUM;
  }

  const a = dayCountFraction(issue, settlement, basis, context);
  const dsm = dayCountFraction(settlement, maturity, basis, context);
  const dim = dayCountFraction(issue, maturity, basis, context);
  if (dsm <= 0) {
    return ERRORS.NUM;
  }
  const numer = 1 + dim * rate;
  const denom = pr / 100 + a * rate;
  if (denom <= 0) {
    return ERRORS.NUM;
  }
  return rvNumber((numer / denom - 1) / dsm);
}

// ============================================================================
// COUP family — coupon-period queries
// ============================================================================

/**
 * Shared validation + parsing for the COUP family. Returns the parsed
 * settlement/maturity/frequency/basis values, or an error.
 */
function parseCoupArgs(
  args: RuntimeValue[]
): { settlement: number; maturity: number; frequency: number; basis: number } | ErrorValue {
  const settlementRV = toNumberRV(topLeft(args[0]));
  if (isError(settlementRV)) {
    return settlementRV;
  }
  const maturityRV = toNumberRV(topLeft(args[1]));
  if (isError(maturityRV)) {
    return maturityRV;
  }
  const frequencyRV = toNumberRV(topLeft(args[2]));
  if (isError(frequencyRV)) {
    return frequencyRV;
  }
  const basisRV = args.length > 3 ? toNumberRV(topLeft(args[3])) : rvNumber(0);
  if (isError(basisRV)) {
    return basisRV;
  }

  const settlement = Math.floor(settlementRV.value);
  const maturity = Math.floor(maturityRV.value);
  const frequency = Math.floor(frequencyRV.value);
  const basis = Math.floor(basisRV.value);
  if (settlement >= maturity) {
    return ERRORS.NUM;
  }

  const err = validateBondBasis(frequency, basis);
  if (err) {
    return err;
  }

  return { settlement, maturity, frequency, basis };
}

/**
 * COUPNCD(settlement, maturity, frequency, [basis]) — next coupon date
 * after settlement, as an Excel serial.
 */
export function fnCOUPNCD(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const p = parseCoupArgs(args);
  if ("kind" in p) {
    return p;
  }
  return rvNumber(nextCouponAfter(p.settlement, p.maturity, p.frequency, context));
}

/**
 * COUPPCD(settlement, maturity, frequency, [basis]) — previous coupon
 * date on or before settlement, as an Excel serial.
 */
export function fnCOUPPCD(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const p = parseCoupArgs(args);
  if ("kind" in p) {
    return p;
  }
  return rvNumber(prevCouponOnOrBefore(p.settlement, p.maturity, p.frequency, context));
}

/**
 * COUPNUM(settlement, maturity, frequency, [basis]) — number of
 * coupons payable between settlement and maturity, rounded up.
 */
export function fnCOUPNUM(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const p = parseCoupArgs(args);
  if ("kind" in p) {
    return p;
  }
  return rvNumber(couponsBetween(p.settlement, p.maturity, p.frequency, context));
}

/**
 * COUPDAYSNC(settlement, maturity, frequency, [basis]) — days from
 * settlement to the next coupon date.
 */
export function fnCOUPDAYSNC(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const p = parseCoupArgs(args);
  if ("kind" in p) {
    return p;
  }
  const next = nextCouponAfter(p.settlement, p.maturity, p.frequency, context);
  if (p.basis === 0 || p.basis === 4) {
    // 30/360 methods — Excel treats the period day-count via NASD-style
    // adjustment; dayCountFraction already handles this. Multiply by
    // 360 (days in 30/360 "year") to get days.
    return rvNumber(dayCountFraction(p.settlement, next, p.basis, context) * 360);
  }
  // Actual day count: plain serial difference works for basis 1/2/3.
  return rvNumber(next - p.settlement);
}

/**
 * COUPDAYBS(settlement, maturity, frequency, [basis]) — days from the
 * beginning of the coupon period to settlement.
 */
export function fnCOUPDAYBS(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const p = parseCoupArgs(args);
  if ("kind" in p) {
    return p;
  }
  const prev = prevCouponOnOrBefore(p.settlement, p.maturity, p.frequency, context);
  if (p.basis === 0 || p.basis === 4) {
    return rvNumber(dayCountFraction(prev, p.settlement, p.basis, context) * 360);
  }
  return rvNumber(p.settlement - prev);
}

/**
 * COUPDAYS(settlement, maturity, frequency, [basis]) — days in the
 * coupon period that contains settlement.
 */
export function fnCOUPDAYS(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const p = parseCoupArgs(args);
  if ("kind" in p) {
    return p;
  }
  const prev = prevCouponOnOrBefore(p.settlement, p.maturity, p.frequency, context);
  const next = nextCouponAfter(p.settlement, p.maturity, p.frequency, context);
  if (p.basis === 1) {
    // Actual/actual — actual days between the two coupon dates.
    return rvNumber(next - prev);
  }
  if (p.basis === 2 || p.basis === 3) {
    // Actual/360 or actual/365 — the period length is conventionally the
    // period basis divided by frequency (e.g. 360/freq, 365/freq).
    const yearDays = p.basis === 2 ? 360 : 365;
    return rvNumber(yearDays / p.frequency);
  }
  // 30/360 NASD or 30/360 European: 360/freq conventional.
  return rvNumber(360 / p.frequency);
}
