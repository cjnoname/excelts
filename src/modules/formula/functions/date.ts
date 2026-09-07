/**
 * Date / Time Functions — Native RuntimeValue implementation.
 *
 * All Date objects returned by `excelToDate()` represent an Excel serial on
 * the UTC timeline (midnight UTC for the corresponding date). Consequently
 * every field accessor must be the UTC variant (`getUTCFullYear`,
 * `getUTCMonth`, …) and every `Date` constructed from y/m/d components must
 * be built with `Date.UTC(...)`. Using local-time accessors would make
 * results depend on the host timezone — e.g. `YEAR(DATE(2024,1,1))` would
 * return 2023 when evaluated on a machine west of UTC at midnight UTC.
 *
 * Exceptions (intentionally use local time):
 * - `TODAY` / `NOW` — read the user's wall clock, which is genuinely in the
 *   local timezone. The Excel serial is then constructed using
 *   `Date.UTC(year, month, day)` so that the resulting serial round-trips
 *   correctly through `excelToDate()`.
 */

import { argToNumber, checkError } from "@formula/functions/_shared";
import type { FunctionRuntimeContext } from "@formula/runtime/function-context";
import { DEFAULT_FUNCTION_CONTEXT } from "@formula/runtime/function-context";
import type { RuntimeValue, ErrorValue } from "@formula/runtime/values";
import {
  RVKind,
  ERRORS,
  isError,
  isArray,
  toNumberRV,
  toStringRV,
  toBooleanRV,
  topLeft,
  rvNumber,
  rvBoolean
} from "@formula/runtime/values";
import type { ExcelDateTimeParts } from "@utils/excel-serial";
import { serialToParts } from "@utils/excel-serial";
import { dateToExcel, excelToDate } from "@utils/utils.base";

// ============================================================================
// Type alias for native function signature
// ============================================================================

// ============================================================================
// Helpers
// ============================================================================

/** Convert an Excel serial to a UTC `Date`, honouring the active date1904 mode. */
function toDate(serial: number, context: FunctionRuntimeContext): Date {
  return excelToDate(serial, context.date1904);
}

/**
 * An Excel serial as calendar fields, honouring the active date1904 mode.
 *
 * **Used by the field accessors instead of `toDate`, because a `Date` cannot hold serial 60.**
 * That serial is Excel's fictitious 1900-02-29, and a `Date` built from those fields normalises
 * to 1900-03-01 — so `MONTH(60)` came back as 3 where Excel says 2. The parts carry the phantom
 * as plain numbers, which is the whole reason they exist.
 *
 * Arithmetic functions below still go through `toDate`: they step days and months rather than
 * reading a calendar field, and Excel's own answers around the phantom are not self-consistent
 * there either.
 */
function toParts(serial: number, context: FunctionRuntimeContext): ExcelDateTimeParts {
  return serialToParts(serial, context.date1904);
}

/** Convert a UTC `Date` back to an Excel serial, honouring the active date1904 mode. */
function fromDate(d: Date, context: FunctionRuntimeContext): number {
  return dateToExcel(d, context.date1904);
}

/** Collect holiday serial numbers from a RuntimeValue argument (array or scalar). */
function collectHolidays(arg: RuntimeValue): Set<number> | ErrorValue {
  const set = new Set<number>();
  if (isArray(arg)) {
    for (const row of arg.rows) {
      for (const cell of row) {
        // Propagate errors from the holidays list rather than silently
        // skipping them — Excel surfaces `#N/A` from a holiday cell.
        if (cell.kind === RVKind.Error) {
          return cell;
        }
        if (cell.kind === RVKind.Number) {
          set.add(Math.floor(cell.value));
        }
      }
    }
  } else {
    if (arg.kind === RVKind.Error) {
      return arg;
    }
    const n = toNumberRV(arg);
    if (n.kind === RVKind.Number) {
      set.add(Math.floor(n.value));
    }
  }
  return set;
}

// ============================================================================
// Date Functions
// ============================================================================

/**
 * TODAY — today's date (at the user's local timezone).
 *
 * The user's concept of "today" is based on their wall clock, so we read
 * local-time fields from `new Date()`. The resulting y/m/d components are
 * then packed into a UTC serial so downstream date arithmetic is consistent.
 */
export function fnTODAY(
  _args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const now = new Date();
  return rvNumber(
    fromDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())), context)
  );
}

/**
 * NOW — current date and time.
 *
 * Excel stores the result as an untimezoned serial, but the user expects
 * their local wall-clock reading. `dateToExcel(new Date())` effectively
 * takes `Date.now()` in UTC-ms; any conversion to the user's timezone
 * would require tz metadata we do not have. We therefore keep the current
 * UTC-ms based conversion, matching historical behaviour.
 */
export function fnNOW(
  _args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const now = new Date();
  return rvNumber(fromDate(now, context));
}

export function fnYEAR(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  return rvNumber(toParts(n.value, context).year);
}

export function fnMONTH(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  return rvNumber(toParts(n.value, context).month);
}

export function fnDAY(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  return rvNumber(toParts(n.value, context).day);
}

export function fnDATE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const year = argToNumber(args[0]);
  if (isError(year)) {
    return year;
  }
  const month = argToNumber(args[1]);
  if (isError(month)) {
    return month;
  }
  const day = argToNumber(args[2]);
  if (isError(day)) {
    return day;
  }

  // Excel's DATE interprets a year in [0, 1899] as (year + 1900). JavaScript's
  // Date constructor already applies this convention for [0, 99], but it does
  // NOT apply it for [100, 1899] — we have to do it ourselves. Years below 0
  // or above 9999 are rejected as #NUM! (Excel's documented range).
  let y = Math.trunc(year.value);
  if (y < 0 || y > 9999) {
    return ERRORS.NUM;
  }
  if (y < 1900) {
    // Excel's DATE interprets a year in [0, 1899] as (year + 1900). After this
    // coercion `y` is in [1900, 3799], always within Excel's [1900, 9999] range.
    y += 1900;
  }

  // Lotus 1-2-3 bug: DATE(1900,2,29) should return serial 60 even though
  // 1900 is not a leap year. JavaScript's Date constructor rolls Feb 29, 1900
  // forward to March 1, 1900, so we handle this specially. Run this check
  // *after* the `y < 1900 → y + 1900` coercion so that `DATE(0, 2, 29)` and
  // `DATE(1900, 2, 29)` resolve to the same serial (R6-P1-1).
  if (y === 1900 && month.value === 2 && day.value === 29) {
    return rvNumber(60); // The fictitious Feb 29, 1900
  }

  const d = new Date(Date.UTC(y, month.value - 1, day.value));
  // The `Date.UTC` constructor maps two-digit years through its own legacy
  // rule (+1900), so for `y` in [0, 99] we end up with the same value we
  // already coerced above. Force the full year to be safe — but preserve
  // month/day carry-over from out-of-range values (Excel allows DATE(2024,
  // 13, 1) → 2025-01-01).
  if (y < 100) {
    d.setUTCFullYear(y);
  }
  return rvNumber(fromDate(d, context));
}

export function fnTIME(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const hour = argToNumber(args[0]);
  if (isError(hour)) {
    return hour;
  }
  const minute = argToNumber(args[1]);
  if (isError(minute)) {
    return minute;
  }
  const second = argToNumber(args[2]);
  if (isError(second)) {
    return second;
  }
  // Excel's TIME rejects negative arguments outright and wraps anything >= 24
  // hours back into the [0, 1) fraction-of-day range. Without the modulo,
  // `TIME(25, 0, 0)` would produce a value > 1, which breaks downstream
  // date-time arithmetic that expects a pure time fraction.
  if (hour.value < 0 || minute.value < 0 || second.value < 0) {
    return ERRORS.NUM;
  }
  const total = (hour.value * 3600 + minute.value * 60 + second.value) / 86400;
  // total could still be >= 1 if e.g. hour=25; wrap into [0, 1).
  return rvNumber(total - Math.floor(total));
}

export function fnHOUR(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  if (n.value < 0) {
    return ERRORS.NUM;
  }
  const totalSeconds = Math.round((n.value % 1) * 86400);
  return rvNumber(Math.floor(totalSeconds / 3600) % 24);
}

export function fnMINUTE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  if (n.value < 0) {
    return ERRORS.NUM;
  }
  const totalSeconds = Math.round((n.value % 1) * 86400);
  return rvNumber(Math.floor(totalSeconds / 60) % 60);
}

export function fnSECOND(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  if (n.value < 0) {
    return ERRORS.NUM;
  }
  const totalSeconds = Math.round((n.value % 1) * 86400);
  return rvNumber(totalSeconds % 60);
}

export function fnWEEKDAY(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  const d = toDate(n.value, context);
  // Blank `return_type` → Excel default 1 (Sun=1..Sat=7). Without the
  // blank guard, `argToNumber(BLANK)` coerces to 0 which falls to the
  // default branch and yields a spurious #NUM! for `WEEKDAY(date, )`.
  const returnType =
    args.length > 1 && args[1].kind !== RVKind.Blank ? argToNumber(args[1]) : rvNumber(1);
  if (isError(returnType)) {
    return returnType;
  }
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  switch (returnType.value) {
    case 1:
      return rvNumber(day + 1); // 1=Sun, 7=Sat
    case 2:
      return rvNumber(day === 0 ? 7 : day); // 1=Mon, 7=Sun
    case 3:
      return rvNumber(day === 0 ? 6 : day - 1); // 0=Mon, 6=Sun
    case 11: // Mon=1..Sun=7
    case 12: // Tue=1..Mon=7
    case 13: // Wed=1..Tue=7
    case 14: // Thu=1..Wed=7
    case 15: // Fri=1..Thu=7
    case 16: // Sat=1..Fri=7
    case 17: // Sun=1..Sat=7
      return rvNumber(((((day - (returnType.value - 10)) % 7) + 7) % 7) + 1);
    default:
      return ERRORS.NUM;
  }
}

export function fnEOMONTH(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startDate = argToNumber(args[0]);
  if (isError(startDate)) {
    return startDate;
  }
  const months = argToNumber(args[1]);
  if (isError(months)) {
    return months;
  }
  // Excel truncates `months` toward zero before doing month arithmetic.
  // `Date.UTC` happens to truncate too, but the explicit `Math.trunc`
  // makes the contract visible and protects against engines that might
  // not (or against a future refactor that routes through a different
  // date constructor).
  const m = Math.trunc(months.value);
  const d = toDate(startDate.value, context);
  const result = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0));
  return rvNumber(fromDate(result, context));
}

export function fnEDATE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startDate = argToNumber(args[0]);
  if (isError(startDate)) {
    return startDate;
  }
  const months = argToNumber(args[1]);
  if (isError(months)) {
    return months;
  }
  const m = Math.trunc(months.value);
  const d = toDate(startDate.value, context);
  // Excel clamps to the last day of the target month when the source day
  // would overflow (e.g. `EDATE(2024-01-31, 1)` → 2024-02-29, not rolling
  // forward into March). JS Date.UTC rolls over by default, so we detect
  // the overflow and clamp explicitly. To do so we first construct the
  // 1st of the target month, read `daysInMonth` via the "day 0 of next
  // month" trick, and cap the original day at that.
  const targetYearMonth = d.getUTCMonth() + m;
  const firstOfTarget = new Date(Date.UTC(d.getUTCFullYear(), targetYearMonth, 1));
  const lastDayOfTarget = new Date(
    Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(d.getUTCDate(), lastDayOfTarget);
  const result = new Date(
    Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), clampedDay)
  );
  return rvNumber(fromDate(result, context));
}

export function fnDATEDIF(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const endN = argToNumber(args[1]);
  if (isError(endN)) {
    return endN;
  }
  // DATEDIF requires end >= start; otherwise #NUM! per Excel.
  if (endN.value < startN.value) {
    return ERRORS.NUM;
  }
  const unit = toStringRV(topLeft(args[2])).toUpperCase();
  const startD = toDate(startN.value, context);
  const endD = toDate(endN.value, context);
  const sy = startD.getUTCFullYear();
  const sm = startD.getUTCMonth();
  const sd = startD.getUTCDate();
  const ey = endD.getUTCFullYear();
  const em = endD.getUTCMonth();
  const ed = endD.getUTCDate();
  switch (unit) {
    case "Y":
      return rvNumber(ey - sy - (em < sm || (em === sm && ed < sd) ? 1 : 0));
    case "M":
      return rvNumber((ey - sy) * 12 + em - sm - (ed < sd ? 1 : 0));
    case "D":
      return rvNumber(Math.floor((endD.getTime() - startD.getTime()) / 86400000));
    case "MD": {
      // Days between the dates, ignoring months and years.
      // If end.day >= start.day → ed - sd; otherwise borrow days from the
      // previous month of endD (last-day-of-prev-month - start.day + end.day).
      if (ed >= sd) {
        return rvNumber(ed - sd);
      }
      // days in the month before endD's month
      const daysInPrevMonth = new Date(Date.UTC(ey, em, 0)).getUTCDate();
      return rvNumber(daysInPrevMonth - sd + ed);
    }
    case "YM": {
      // Months between the dates, ignoring days and years.
      let months = em - sm;
      if (ed < sd) {
        months -= 1;
      }
      if (months < 0) {
        months += 12;
      }
      return rvNumber(months);
    }
    case "YD": {
      // Days between the dates as though they were in the same year, ignoring years.
      // Align endD to startD's year (or next year if end < start in same-year terms).
      const sameYearEnd = Date.UTC(sy, em, ed);
      const startUTC = Date.UTC(sy, sm, sd);
      let diff = sameYearEnd - startUTC;
      if (diff < 0) {
        // end falls earlier in the year than start → roll forward one year
        const nextYearEnd = Date.UTC(sy + 1, em, ed);
        diff = nextYearEnd - startUTC;
      }
      return rvNumber(Math.floor(diff / 86400000));
    }
    default:
      return ERRORS.NUM;
  }
}

export function fnDAYS(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const end = argToNumber(args[0]);
  if (isError(end)) {
    return end;
  }
  const start = argToNumber(args[1]);
  if (isError(start)) {
    return start;
  }
  return rvNumber(Math.floor(end.value) - Math.floor(start.value));
}

export function fnISOWEEKNUM(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  const d = toDate(n.value, context);
  const temp = new Date(d.getTime());
  temp.setUTCDate(temp.getUTCDate() + 3 - ((temp.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(temp.getUTCFullYear(), 0, 4));
  return rvNumber(
    1 +
      Math.round(
        ((temp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
      )
  );
}

export function fnWEEKNUM(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const n = argToNumber(args[0]);
  if (isError(n)) {
    return n;
  }
  const d = toDate(n.value, context);
  // Blank `return_type` → Excel default 1 (Sunday start). See WEEKDAY
  // for the same rationale.
  const returnType =
    args.length > 1 && args[1].kind !== RVKind.Blank ? argToNumber(args[1]) : rvNumber(1);
  if (isError(returnType)) {
    return returnType;
  }
  const rt = returnType.value;
  // Type 21 is ISO 8601 week.
  if (rt === 21) {
    return fnISOWEEKNUM(args, context);
  }
  // Excel maps `return_type` to the day-of-week that starts the week:
  //   1  (default) → Sunday
  //   2  or 11     → Monday
  //   12 → Tuesday, 13 → Wednesday, … 17 → Saturday
  //   (16 → Friday, 17 → Saturday)
  // Any other value is #NUM!.
  let startDay: number; // 0 = Sunday … 6 = Saturday
  switch (rt) {
    case 1:
      startDay = 0;
      break;
    case 2:
    case 11:
      startDay = 1;
      break;
    case 12:
      startDay = 2;
      break;
    case 13:
      startDay = 3;
      break;
    case 14:
      startDay = 4;
      break;
    case 15:
      startDay = 5;
      break;
    case 16:
      startDay = 6;
      break;
    case 17:
      startDay = 0;
      break;
    default:
      return ERRORS.NUM;
  }
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const jan1Day = jan1.getUTCDay();
  const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  return rvNumber(Math.floor((dayOfYear + ((jan1Day - startDay + 7) % 7)) / 7) + 1);
}

function networkdaysHelper(
  startN: number,
  endN: number,
  holidays: Set<number>,
  context: FunctionRuntimeContext
): number {
  const s = Math.floor(Math.min(startN, endN));
  const e = Math.floor(Math.max(startN, endN));
  const sign = startN <= endN ? 1 : -1;
  // Closed-form weekday count: partition `[s, e]` into whole weeks plus
  // a tail. Each whole week contributes 5 weekdays, regardless of its
  // starting day-of-week. The tail contributes however many of its
  // remaining days fall on Monday..Friday.
  //
  // `getUTCDay()`: Sun=0, Mon=1, …, Sat=6. We compute `dow` once for
  // the start date and then just walk the `tail` days forward by
  // modular arithmetic — no Date allocations in the loop.
  const totalDays = e - s + 1;
  const weeks = Math.floor(totalDays / 7);
  const tail = totalDays % 7;
  let weekdays = weeks * 5;
  if (tail > 0) {
    const startDow = toDate(s, context).getUTCDay();
    for (let i = 0; i < tail; i++) {
      const dow = (startDow + i) % 7;
      if (dow !== 0 && dow !== 6) {
        weekdays++;
      }
    }
  } else {
    // When `totalDays` is an exact multiple of 7 the start DOW still
    // governs whether any holidays from the caller's list fall on a
    // weekday, so we stop here — no tail to walk.
  }
  // Subtract holidays that land on a weekday and fall within [s, e].
  if (holidays.size > 0) {
    for (const h of holidays) {
      if (h >= s && h <= e) {
        const dow = toDate(h, context).getUTCDay();
        if (dow !== 0 && dow !== 6) {
          weekdays--;
        }
      }
    }
  }
  return weekdays * sign;
}

export function fnNETWORKDAYS(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const endN = argToNumber(args[1]);
  if (isError(endN)) {
    return endN;
  }
  const holidays = args.length > 2 ? collectHolidays(args[2]) : new Set<number>();
  if (holidays instanceof Set) {
    return rvNumber(networkdaysHelper(startN.value, endN.value, holidays, context));
  }
  return holidays;
}

export function fnWORKDAY(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const days = argToNumber(args[1]);
  if (isError(days)) {
    return days;
  }
  const holidays = args.length > 2 ? collectHolidays(args[2]) : new Set<number>();
  if (!(holidays instanceof Set)) {
    return holidays;
  }
  let current = Math.floor(startN.value);
  // Excel truncates `days` toward zero. Without this, a fractional input
  // like 2.7 would walk extra iterations until the fractional remainder
  // underflowed past zero, silently producing a wrong result.
  const daysInt = Math.trunc(days.value);
  const step = daysInt >= 0 ? 1 : -1;
  let remaining = Math.abs(daysInt);
  while (remaining > 0) {
    current += step;
    const dt = toDate(current, context);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(current)) {
      remaining--;
    }
  }
  return rvNumber(current);
}

export function fnYEARFRAC(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const endN = argToNumber(args[1]);
  if (isError(endN)) {
    return endN;
  }
  const basis = args.length > 2 ? argToNumber(args[2]) : rvNumber(0);
  if (isError(basis)) {
    return basis;
  }
  const sd = toDate(Math.min(startN.value, endN.value), context);
  const ed = toDate(Math.max(startN.value, endN.value), context);
  const diffDays = Math.abs(Math.floor(endN.value) - Math.floor(startN.value));

  switch (basis.value) {
    case 0: {
      // US (NASD) 30/360
      let d1 = sd.getUTCDate();
      const m1 = sd.getUTCMonth() + 1;
      const y1 = sd.getUTCFullYear();
      let d2 = ed.getUTCDate();
      const m2 = ed.getUTCMonth() + 1;
      const y2 = ed.getUTCFullYear();
      // NASD adjustment rules
      if (d1 === 31) {
        d1 = 30;
      }
      if (d2 === 31 && d1 >= 30) {
        d2 = 30;
      }
      // Handle end-of-Feb for start date
      const feb1 = new Date(Date.UTC(y1, 1, 29)).getUTCMonth() === 1 ? 29 : 28;
      if (m1 === 2 && d1 === feb1) {
        d1 = 30;
        if (m2 === 2) {
          const feb2 = new Date(Date.UTC(y2, 1, 29)).getUTCMonth() === 1 ? 29 : 28;
          if (d2 === feb2) {
            d2 = 30;
          }
        }
      }
      const days30_360 = (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
      return rvNumber(days30_360 / 360);
    }
    case 1: {
      // Actual/Actual (ISDA convention, matches Excel's behaviour).
      //
      // Same-year is easy: divide by the length of that calendar year.
      // Across years we split the interval into its leap-year portion and
      // non-leap-year portion, then sum `leapDays/366 + nonLeapDays/365`.
      // This is the ISDA "Act/Act" rule; simple averaging of year lengths
      // (the previous implementation) produces visibly wrong answers like
      // `YEARFRAC("2020-01-01","2021-01-01",1) ≈ 1.001368` where Excel
      // returns exactly 1.
      const y1 = sd.getUTCFullYear();
      const y2 = ed.getUTCFullYear();
      if (y1 === y2) {
        const yearDays = (Date.UTC(y1 + 1, 0, 1) - Date.UTC(y1, 0, 1)) / 86400000;
        return rvNumber(diffDays / yearDays);
      }
      let leapDays = 0;
      let nonLeapDays = 0;
      const sdMs = sd.getTime();
      const edMs = ed.getTime();
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
      return rvNumber(leapDays / 366 + nonLeapDays / 365);
    }
    case 2: // Actual/360
      return rvNumber(diffDays / 360);
    case 3: // Actual/365
      return rvNumber(diffDays / 365);
    case 4: {
      // European 30/360
      const d1 = Math.min(sd.getUTCDate(), 30);
      const d2 = Math.min(ed.getUTCDate(), 30);
      const m1 = sd.getUTCMonth() + 1;
      const m2 = ed.getUTCMonth() + 1;
      const y1 = sd.getUTCFullYear();
      const y2 = ed.getUTCFullYear();
      const days30_360 = (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
      return rvNumber(days30_360 / 360);
    }
    default:
      return ERRORS.NUM;
  }
}

export function fnDATEVALUE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0])).trim();

  // Lotus 1-2-3 bug: "2/29/1900" or "February 29, 1900" etc. should return 60
  const lotus29 =
    /^(2[/-]29[/-]1900|1900[/-]2[/-]29|1900[/-]02[/-]29|02[/-]29[/-]1900|Feb(ruary)?\s+29[,]?\s+1900)$/i;
  if (lotus29.test(text)) {
    return rvNumber(60);
  }

  const parsed = parseDateOnly(text);
  if (!parsed) {
    return ERRORS.VALUE;
  }
  return rvNumber(fromDate(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)), context));
}

export function fnTIMEVALUE(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const err = checkError(args[0]);
  if (err) {
    return err;
  }
  const text = toStringRV(topLeft(args[0])).trim();
  const parsed = parseTimeOnly(text);
  if (parsed === null) {
    return ERRORS.VALUE;
  }
  return rvNumber(parsed);
}

// ============================================================================
// Date / Time parsing (deterministic, independent of host locale)
//
// `new Date(text)` is unreliable across engines (Chrome parses "1/2/3" as
// US MDY, Node varies by version, and locale influences both). We hand-
// roll a small parser that accepts the formats Excel's DATEVALUE does and
// rejects everything else.
// ============================================================================

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

/** Parse a date-only string into `{y, m, d}` or `null` on rejection. */
function parseDateOnly(raw: string): { y: number; m: number; d: number } | null {
  const s = raw.trim();
  // Strip a trailing time component (e.g. "2024-01-15 14:30") — but only
  // split at a space that is followed by a digit, so a spelled-out date
  // like "Jan 15, 2024" (which has month-name and day-number separated
  // by spaces) survives for the "Mmm D, YYYY" matcher below.
  // A naive `indexOf(" ")` truncated "Jan 15, 2024" to just "Jan".
  const trailingTime = /^(.+?)\s(\d{1,2}:[\d:]+(?:\s*[AaPp]\.?[Mm]\.?)?)$/.exec(s);
  const datePart = trailingTime ? trailingTime[1].trim() : s;

  // ISO YYYY-MM-DD or YYYY/MM/DD
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(datePart);
  if (m) {
    return validateYmd(+m[1], +m[2], +m[3]);
  }
  // US M/D/YYYY or M-D-YYYY
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(datePart);
  if (m) {
    let y = +m[3];
    if (y < 100) {
      // Excel's pivot: 00-29 → 2000s, 30-99 → 1900s
      y += y < 30 ? 2000 : 1900;
    }
    return validateYmd(y, +m[1], +m[2]);
  }
  // D-Mmm-YY or D-Mmm-YYYY
  m = /^(\d{1,2})[ /-]([A-Za-z]{3,9})[ /-]?(\d{2,4})?$/.exec(datePart);
  if (m) {
    const month = MONTH_NAMES[m[2].toLowerCase()];
    if (!month) {
      return null;
    }
    // Excel's DATEVALUE substitutes the host's current calendar year when
    // the input omits a year (e.g. "15-Jan"). This matches Excel on the
    // desktop, but note that the return value is not stable across time
    // zones or years — tests that exercise this branch should freeze the
    // clock (or supply a year) if they need reproducibility.
    let y = m[3] ? +m[3] : new Date().getFullYear();
    if (y < 100) {
      y += y < 30 ? 2000 : 1900;
    }
    return validateYmd(y, month, +m[1]);
  }
  // "Mmm D, YYYY" or "Month D, YYYY"
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(datePart);
  if (m) {
    const month = MONTH_NAMES[m[1].toLowerCase()];
    if (!month) {
      return null;
    }
    let y = +m[3];
    if (y < 100) {
      y += y < 30 ? 2000 : 1900;
    }
    return validateYmd(y, month, +m[2]);
  }
  return null;
}

/** Validate a calendar date and return null for out-of-range components. */
function validateYmd(y: number, mo: number, d: number): { y: number; m: number; d: number } | null {
  if (y < 0 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) {
    return null;
  }
  // Day-of-month range check using UTC (leap years included).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return { y, m: mo, d };
}

/** Parse a time-only string into a fraction-of-day in [0, 1). */
function parseTimeOnly(raw: string): number | null {
  // Optional AM/PM suffix; captured case-insensitively.
  const m = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}(?:\.\d+)?))?(?:\s*([AaPp])\.?\s*[Mm]\.?)?$/.exec(
    raw
  );
  if (!m) {
    return null;
  }
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const sec = m[3] ? +m[3] : 0;
  if (min >= 60 || sec >= 60 || min < 0 || sec < 0) {
    return null;
  }
  if (m[4]) {
    const pm = m[4].toLowerCase() === "p";
    if (h < 1 || h > 12) {
      return null;
    }
    if (pm && h < 12) {
      h += 12;
    } else if (!pm && h === 12) {
      h = 0;
    }
  } else {
    if (h < 0 || h > 23) {
      return null;
    }
  }
  return (h * 3600 + min * 60 + sec) / 86400;
}

// ============================================================================
// More Date/Time Functions
// ============================================================================

export function fnDAYS360(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const endN = argToNumber(args[1]);
  if (isError(endN)) {
    return endN;
  }
  const methodRV = args.length > 2 ? toBooleanRV(topLeft(args[2])) : rvBoolean(false);
  if (isError(methodRV)) {
    return methodRV;
  }
  const method = methodRV.value;
  const sd = toDate(startN.value, context);
  const ed = toDate(endN.value, context);
  let d1 = sd.getUTCDate();
  let d2 = ed.getUTCDate();
  const m1 = sd.getUTCMonth() + 1;
  const m2 = ed.getUTCMonth() + 1;
  const y1 = sd.getUTCFullYear();
  const y2 = ed.getUTCFullYear();
  if (method) {
    if (d1 === 31) {
      d1 = 30;
    }
    if (d2 === 31) {
      d2 = 30;
    }
  } else {
    if (d1 === 31) {
      d1 = 30;
    }
    if (d2 === 31 && d1 >= 30) {
      d2 = 30;
    }
  }
  return rvNumber((y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1));
}

/** Map weekend-type code to the set of day-of-week indices (0=Sun..6=Sat) that are weekends. */
function getWeekendDays(weekendType: number): Set<number> {
  switch (weekendType) {
    case 1:
      return new Set([0, 6]); // Sat, Sun
    case 2:
      return new Set([0, 1]); // Sun, Mon
    case 3:
      return new Set([1, 2]); // Mon, Tue
    case 4:
      return new Set([2, 3]); // Tue, Wed
    case 5:
      return new Set([3, 4]); // Wed, Thu
    case 6:
      return new Set([4, 5]); // Thu, Fri
    case 7:
      return new Set([5, 6]); // Fri, Sat
    case 11:
      return new Set([0]); // Sun only
    case 12:
      return new Set([1]); // Mon only
    case 13:
      return new Set([2]); // Tue only
    case 14:
      return new Set([3]); // Wed only
    case 15:
      return new Set([4]); // Thu only
    case 16:
      return new Set([5]); // Fri only
    case 17:
      return new Set([6]); // Sat only
    default:
      return new Set([0, 6]); // Default: Sat, Sun
  }
}

export function fnNETWORKDAYS_INTL(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const endN = argToNumber(args[1]);
  if (isError(endN)) {
    return endN;
  }
  // Blank `weekend` → Excel default 1 (Sat+Sun). See getWeekendDays
  // default fallback.
  const weekendArg =
    args.length > 2 && args[2].kind !== RVKind.Blank ? argToNumber(args[2]) : rvNumber(1);
  if (isError(weekendArg)) {
    return weekendArg;
  }
  const holidays = args.length > 3 ? collectHolidays(args[3]) : new Set<number>();
  if (!(holidays instanceof Set)) {
    return holidays;
  }
  const weekendDays = getWeekendDays(weekendArg.value);
  const s = Math.floor(Math.min(startN.value, endN.value));
  const e = Math.floor(Math.max(startN.value, endN.value));
  const sign = startN.value <= endN.value ? 1 : -1;
  let count = 0;
  for (let d = s; d <= e; d++) {
    const dt = toDate(d, context);
    if (!weekendDays.has(dt.getUTCDay()) && !holidays.has(d)) {
      count++;
    }
  }
  return rvNumber(count * sign);
}

export function fnWORKDAY_INTL(
  args: RuntimeValue[],
  context: FunctionRuntimeContext = DEFAULT_FUNCTION_CONTEXT
): RuntimeValue {
  const startN = argToNumber(args[0]);
  if (isError(startN)) {
    return startN;
  }
  const days = argToNumber(args[1]);
  if (isError(days)) {
    return days;
  }
  // Blank `weekend` → Excel default 1 (Sat+Sun).
  const weekendArg =
    args.length > 2 && args[2].kind !== RVKind.Blank ? argToNumber(args[2]) : rvNumber(1);
  if (isError(weekendArg)) {
    return weekendArg;
  }
  const holidays = args.length > 3 ? collectHolidays(args[3]) : new Set<number>();
  if (!(holidays instanceof Set)) {
    return holidays;
  }
  const weekendDays = getWeekendDays(weekendArg.value);
  let current = Math.floor(startN.value);
  // Truncate `days` toward zero before stepping — see WORKDAY for the
  // same rationale. A fractional input like 2.7 would otherwise walk
  // extra iterations and silently produce the wrong result.
  const daysInt = Math.trunc(days.value);
  const step = daysInt >= 0 ? 1 : -1;
  let remaining = Math.abs(daysInt);
  while (remaining > 0) {
    current += step;
    const dt = toDate(current, context);
    if (!weekendDays.has(dt.getUTCDay()) && !holidays.has(current)) {
      remaining--;
    }
  }
  return rvNumber(current);
}
