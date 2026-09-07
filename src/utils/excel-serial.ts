/**
 * The Excel date serial, expressed as a calendar value rather than as an instant.
 *
 * **The distinction this module exists to make.** A spreadsheet date is a *civil* value — a
 * date on a wall calendar, a time on a wall clock — with no timezone and no instant attached.
 * A JavaScript `Date` is the opposite: a single point on the epoch timeline, whose calendar
 * fields exist only relative to a timezone you have to name. The two are not the same kind of
 * thing, and every date bug this library has had came from a place that treated them as if
 * they were.
 *
 * The rest of the codebase papered over that with a convention: a `Date` carrying a
 * spreadsheet value has the civil fields in its **UTC** fields, so every reader uses `getUTC*`
 * and every writer builds with `Date.UTC(...)`. That convention is correct and is kept, but it
 * was only ever expressed in comments — and it could not be expressed in a *type*, because
 * `Date` has no room to say which of its two readings is meant.
 *
 * {@link ExcelDateTimeParts} is that room. It is the library's internal canonical form for a
 * date cell: broken-out civil fields, no timezone, no instant. `serialToParts` and
 * `partsToSerial` convert to and from the stored number without constructing a `Date` at any
 * point, so no host timezone can reach them and there is nothing to get wrong.
 *
 * `Date` remains the public read type for compatibility, and `dateToExcel`/`excelToDate` in
 * `utils.base` remain its bridge. But the conversions the library performs on its own behalf
 * — a chart cache, a data-validation bound, a coupon date — go through parts, and anything
 * that wants an unambiguous value can ask for parts (`Cell.getDateParts`) or for a Temporal
 * `Plain*` (`Cell.getTemporal`) instead.
 *
 * **The serial model, stated exactly**, because two plausible ones differ and the choice is
 * observable:
 *
 * - Serial 0 is 1899-12-30 under the 1900 epoch, 1904-01-01 under the 1904 epoch.
 * - The mapping is **linear**: there is no fictitious 1900-02-29. Excel has one (its serial 60),
 *   which is why the 1900 epoch is anchored two days before 1900-01-01 rather than one: the
 *   shift absorbs the phantom day so that every serial from 61 (1900-03-01) onward agrees with
 *   Excel exactly. The 59 serials below that are off by one against Excel — the price of not
 *   modelling a day that does not exist, and the same price every other library pays.
 * - The fractional part is the time of day, `0.5` being noon. It is *not* rounded to a whole
 *   day, so a datetime survives the round trip.
 *
 * This is the model `excelToDate` has always implemented; it is written down here rather than
 * left to be re-derived from an expression involving 25569.
 *
 * Layer 0: no module imports.
 */

/**
 * Days from 1970-01-01 to 1899-12-30, i.e. the serial of the Unix epoch under the 1900 epoch.
 *
 * The number every spreadsheet library carries. Named so a reader does not have to recognise it.
 */
export const EXCEL_1900_EPOCH_OFFSET = 25569;

/**
 * Days between the 1900 and 1904 epochs — 1904-01-01 minus 1899-12-30.
 *
 * Four years and a day, the extra day being 1900-02-29's absence from the real calendar rather
 * than anything about the epochs themselves.
 */
export const EXCEL_1904_EPOCH_DELTA = 1462;

/** Milliseconds in a day. Excel serials have no leap seconds, so this is exact. */
export const MS_PER_DAY = 86_400_000;

/**
 * A date and time on a calendar, with no timezone and no instant.
 *
 * `month` and `day` are 1-based, matching both Excel and `Temporal.PlainDate`, and deliberately
 * unlike `Date`'s 0-based month — a silent off-by-one between two nearly identical shapes is
 * worse than the inconvenience of them differing visibly.
 */
export interface ExcelDateTimeParts {
  /** Full year. May be below 1900 or above 9999 for a serial outside the usual range. */
  readonly year: number;
  /** Month, 1–12. */
  readonly month: number;
  /** Day of month, 1–31. */
  readonly day: number;
  /** Hour, 0–23. */
  readonly hour: number;
  /** Minute, 0–59. */
  readonly minute: number;
  /** Second, 0–59. */
  readonly second: number;
  /** Millisecond, 0–999. */
  readonly millisecond: number;
}

/**
 * Days from 1970-01-01 to a civil date, by Howard Hinnant's algorithm.
 *
 * Exact in integers for any year, with no `Date` and therefore no timezone. `month` is 1-based.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** The inverse of {@link daysFromCivil}. Returns a 1-based month. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

/**
 * Shift a day count on the Unix timeline onto the Excel serial scale.
 *
 * The 1904 term is subtracted *after* the 1900 offset is added rather than folded into a single
 * constant. Folding them is the same value in exact arithmetic but not in floating point, and
 * this expression is the one every serial in every file this library has ever written was
 * produced by. Changing its association shifts the last ULP, which is visible in a `<v>`.
 */
function toSerialScale(days: number, date1904: boolean | undefined): number {
  return EXCEL_1900_EPOCH_OFFSET + days - (date1904 ? EXCEL_1904_EPOCH_DELTA : 0);
}

/** The inverse of {@link toSerialScale}, in the same association. */
function fromSerialScale(serial: number, date1904: boolean | undefined): number {
  return serial - EXCEL_1900_EPOCH_OFFSET + (date1904 ? EXCEL_1904_EPOCH_DELTA : 0);
}

/**
 * The day count, on the Unix timeline, that the *old linear* model gave Excel's serial 60.
 *
 * The pivot for the phantom-day correction below. Expressed against the linear model rather than
 * as a civil date because that is the quantity the arithmetic actually compares.
 */
const SERIAL_60_DAYS = 60 - EXCEL_1900_EPOCH_OFFSET;

/**
 * Whether these calendar fields name Excel's fictitious 1900-02-29.
 *
 * Only under the 1900 epoch: the 1904 system has no phantom day, because it starts after the
 * date Lotus 1-2-3 got wrong.
 */
function isPhantomLeapDay(
  year: number,
  month: number,
  day: number,
  date1904: boolean | undefined
): boolean {
  return !date1904 && year === 1900 && month === 2 && day === 29;
}

/**
 * An Excel date serial as calendar fields.
 *
 * The time of day is recovered by rounding the serial to the nearest millisecond *first* and
 * then splitting, which matters because a serial is a float and a time such as 09:30 is not
 * exactly representable: splitting before rounding turns 09:30:00.000 into 09:29:59.999.
 *
 * **Serials below 61 are corrected for the phantom day.** See {@link EXCEL_1900_EPOCH_OFFSET};
 * the shift is applied here rather than folded into the epoch constant so that every serial from
 * 61 onward — which is every date a real workbook contains — goes through arithmetic identical to
 * what this library has always used, down to the last bit.
 *
 * Serial 60 has no counterpart on the calendar, so it is reported as the fields `1900-02-29`.
 * Those are numbers, and numbers can say that; a `Date` cannot, and neither can Temporal. The
 * two functions that have to produce one — {@link partsToUtcDate} and `partsToTemporal` — say so
 * in their own terms rather than having this one lie about the input.
 *
 * @param serial - The stored cell value. Fractional part is the time of day.
 * @param date1904 - The workbook's epoch flag. Defaults to the 1900 epoch.
 *
 * @example
 * ```ts
 * import { serialToParts } from "@utils/excel-serial";
 *
 * serialToParts(45306);   // { year: 2024, month: 1, day: 15, hour: 0, ... }
 * serialToParts(45306.5); // ... hour: 12
 * serialToParts(1);       // { year: 1900, month: 1, day: 1, ... } — Excel's serial 1
 * ```
 */
export function serialToParts(serial: number, date1904?: boolean): ExcelDateTimeParts {
  const totalMs = Math.round(fromSerialScale(serial, date1904) * MS_PER_DAY);
  // Floor rather than truncate: a serial before the Unix epoch is negative, and truncation
  // would round it towards zero, i.e. forward in time, putting the date a day late.
  let days = Math.floor(totalMs / MS_PER_DAY);
  let rem = totalMs - days * MS_PER_DAY; // [0, MS_PER_DAY)
  let phantom = false;
  if (date1904 !== true) {
    if (days === SERIAL_60_DAYS) {
      phantom = true;
    } else if (days < SERIAL_60_DAYS) {
      // Below the phantom, every real date is one day later than the linear model claims.
      days += 1;
    }
  }
  const { year, month, day } = phantom ? { year: 1900, month: 2, day: 29 } : civilFromDays(days);
  const millisecond = rem % 1000;
  rem = (rem - millisecond) / 1000;
  const second = rem % 60;
  rem = (rem - second) / 60;
  const minute = rem % 60;
  const hour = (rem - minute) / 60;
  return { year, month, day, hour, minute, second, millisecond };
}

/**
 * Calendar fields as an Excel date serial.
 *
 * The inverse of {@link serialToParts}. Fields out of range carry, the way `Date.UTC` does:
 * `{ month: 13 }` is January of the next year, and `{ day: 0 }` is the last day of the previous
 * month. That is relied on by month arithmetic such as `EDATE` and coupon-date stepping — and it
 * is why this stays permissive while the public `Cell.setDateParts` validates.
 *
 * `1900-02-29` is accepted and yields serial 60, Excel's own answer for a day that does not
 * exist. The carry rule would otherwise silently turn it into 1900-03-01 and serial 61.
 *
 * @param parts - Calendar fields. Missing time fields default to 0, so a date-only value needs
 *   only `year`, `month` and `day` and yields a whole-number serial.
 * @param date1904 - The workbook's epoch flag. Defaults to the 1900 epoch.
 */
export function partsToSerial(
  parts: Pick<ExcelDateTimeParts, "year" | "month" | "day"> & Partial<ExcelDateTimeParts>,
  date1904?: boolean
): number {
  const { year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 } = parts;
  const ms = ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
  if (isPhantomLeapDay(year, month, day, date1904)) {
    // Checked before the carry, which cannot distinguish the phantom from 1900-03-01.
    return toSerialScale((SERIAL_60_DAYS * MS_PER_DAY + ms) / MS_PER_DAY, date1904);
  }
  // Normalise the month before the day, so an out-of-range month lands on a real month and the
  // day's own overflow is then measured against it.
  const monthIndex = month - 1;
  const yearCarry = Math.floor(monthIndex / 12);
  let days = daysFromCivil(year + yearCarry, monthIndex - yearCarry * 12 + 1, day);
  if (date1904 !== true && days <= SERIAL_60_DAYS) {
    // Anything before 1900-03-01 sits one day lower on the serial scale, because Excel spends a
    // serial on a day the calendar does not have. `<=` and not `<`: the phantom's own day count
    // is 1900-03-01's, and it was already returned above.
    days -= 1;
  }
  // Accumulate in whole milliseconds and divide once. Adding `days` and `ms / MS_PER_DAY`
  // separately is the same value in exact arithmetic but not in floating point, and the two
  // disagree in the last ULP — enough to change the digits written into a `<v>` element.
  return toSerialScale((days * MS_PER_DAY + ms) / MS_PER_DAY, date1904);
}

/**
 * Whether these fields name Excel's fictitious 1900-02-29.
 *
 * Exported because the callers that must refuse it — the `Date` bridge and the Temporal
 * conversion — should say so by name rather than by re-testing three numbers each.
 */
export function isExcelPhantomDay(parts: ExcelDateTimeParts, date1904?: boolean): boolean {
  return isPhantomLeapDay(parts.year, parts.month, parts.day, date1904);
}

/**
 * Whether a serial carries a time of day.
 *
 * Compares against the millisecond the serial rounds to rather than testing `serial % 1`,
 * because a whole day arrived at by arithmetic is regularly 45306.000000000004.
 */
export function serialHasTime(serial: number, date1904?: boolean): boolean {
  return Math.round(fromSerialScale(serial, date1904) * MS_PER_DAY) % MS_PER_DAY !== 0;
}

/**
 * Calendar fields as a `Date` carrying them in its **UTC** fields.
 *
 * This is the one place the library crosses from a civil value to a `Date`, and the only place
 * that should: everywhere else, use the parts.
 *
 * **It is not `Date.UTC`.** `Date.UTC(99, 0, 1)` is 1999, not 99 — a legacy two-digit-year rule
 * that applies to years 0–99 and silently moves a serial in the first century by 1900 years.
 * Building the date and then calling `setUTCFullYear` bypasses it. Four call sites had each
 * discovered this separately.
 */
export function partsToUtcDate(parts: ExcelDateTimeParts): Date {
  const d = new Date(0);
  d.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  d.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return d;
}

/**
 * The **UTC** fields of a `Date`, read as calendar fields.
 *
 * The inverse of {@link partsToUtcDate}, and the entry point for a `Date` that reached the
 * library through its public API. Reading the UTC fields rather than the local ones is the
 * convention stated at the top of this file; a caller who meant the local fields has a
 * genuinely different value in mind and should pass parts or a Temporal `Plain*` instead.
 */
export function utcDateToParts(date: Date): ExcelDateTimeParts {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds()
  };
}
