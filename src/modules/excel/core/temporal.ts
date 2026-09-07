/**
 * Temporal `Plain*` values as spreadsheet dates and times.
 *
 * **Why this is worth having, stated as a defect rather than as a preference.** A spreadsheet date is a civil
 * value — a date on a calendar, a time on a clock, no timezone. A JavaScript `Date` is an instant. The library
 * has always bridged the two by convention (a `Date` carries the civil value in its *UTC* fields), and that
 * convention is correct, but it is unwritable in a type and therefore unguessable by a caller. The form nearly
 * every JavaScript programmer reaches for —
 *
 * ```ts
 * Cell.setValue(sheet, "A1", new Date(2024, 0, 15));
 * ```
 *
 * — is the wrong one, and fails *quietly and only outside UTC*: in UTC+8 it stores 45305.667, which Excel shows
 * as 2024-01-14 16:00. Nothing in the API can tell you, because both readings of that `Date` are legitimate and
 * it does not say which was meant.
 *
 * `Temporal.PlainDate` says which. That is the whole argument: not that Temporal is newer, but that the ambiguity
 * this library keeps tripping over does not exist in it.
 *
 * A second thing falls out that `Date` cannot express at all. `Date` conflates three cell kinds, and the number
 * format is what tells them apart — so a time-of-day written as a `Date` gets the default *date* format and shows
 * as `12-30-1899`. The three `Plain*` types are exactly that missing distinction, so a `PlainTime` can be given a
 * time format and a `PlainDate` a date one, without a caller having to know that a bare `Date` needs help.
 *
 * ## Availability
 *
 * Temporal is **not** available on this package's supported floor — not Node 22 or 24, not Safari, not Chrome
 * before 144 — and the zero-dependency rule forbids a polyfill. So it is opt-in on both sides and nothing here
 * touches the default surface:
 *
 * - **Types** are derived from `globalThis` by a conditional type rather than by naming the `Temporal` namespace.
 *   A consumer whose `lib` lacks `esnext.temporal` gets `never` and the member collapses; naming the namespace
 *   directly would give them `TS2503` in a declaration file they did not write.
 * - **Runtime** detection is `Symbol.toStringTag`, never `instanceof Temporal.PlainDate`. Evaluating that
 *   expression on Node 22 throws a `ReferenceError` at module scope, which would break `import` of
 *   `documonster/excel` for every consumer whether or not they use any of this. It is also the only form that
 *   works across realms.
 * - **`CellValue`** — the *read* type — is untouched. Only `CellValueInput` grows, which cannot break an
 *   exhaustive `switch`.
 *
 * A caller on an older runtime is not shut out: `Cell.getDateParts` returns {@link ExcelDateTimeParts}, and
 * `Temporal.PlainDate.from(parts)` is one line. The parts *are* the interchange format; Temporal is the ergonomic
 * skin over it.
 *
 * ## What is deliberately refused
 *
 * `Temporal.Instant` and `Temporal.ZonedDateTime` are instants, not civil values. Storing one requires choosing a
 * timezone to flatten it in, and there is no defensible default — so they are rejected by name, with the one-call
 * fix in the message. Guessing is how this module's subject matter became a bug in the first place.
 * `PlainYearMonth` and `PlainMonthDay` are incomplete dates and are refused for the same reason.
 */
import { ExcelError } from "@excel/errors";
import type { ExcelDateTimeParts } from "@utils/excel-serial";
import { MS_PER_DAY, isExcelPhantomDay, partsToSerial, serialToParts } from "@utils/excel-serial";

/**
 * `Temporal.PlainDate`, or `never` where the runtime's type definitions do not have it.
 *
 * Written as a structural query on `globalThis` rather than as `Temporal.PlainDate` so that the emitted `.d.ts`
 * defers the decision to whoever imports it. TypeScript preserves the conditional type through declaration emit,
 * so this resolves in the consumer's `lib`, not in this package's.
 */
export type PlainDate = typeof globalThis extends {
  Temporal: { PlainDate: new (...args: never[]) => infer T };
}
  ? T
  : never;

/** `Temporal.PlainTime`, or `never`. See {@link PlainDate}. */
export type PlainTime = typeof globalThis extends {
  Temporal: { PlainTime: new (...args: never[]) => infer T };
}
  ? T
  : never;

/** `Temporal.PlainDateTime`, or `never`. See {@link PlainDate}. */
export type PlainDateTime = typeof globalThis extends {
  Temporal: { PlainDateTime: new (...args: never[]) => infer T };
}
  ? T
  : never;

/** Any of the three civil Temporal types this library accepts as a cell value. */
export type TemporalPlainValue = PlainDate | PlainTime | PlainDateTime;

/** Which of the three a value is — the distinction `Date` cannot carry. */
export type TemporalKind = "date" | "time" | "dateTime";

/**
 * The `Symbol.toStringTag` each type carries, and the kind it maps to.
 *
 * A `Map`, not an object literal. `tag in ACCEPTED` on a literal walks the prototype chain, so a value tagged
 * `"constructor"` or `"toString"` answered *true* and the lookup then produced `Object.prototype.constructor` —
 * a function — where a `TemporalKind` was expected. A `Map` has no inherited keys.
 */
const ACCEPTED = new Map<string, TemporalKind>([
  ["Temporal.PlainDate", "date"],
  ["Temporal.PlainTime", "time"],
  ["Temporal.PlainDateTime", "dateTime"]
]);

/**
 * Temporal types that are *not* civil values, and what to call to get one.
 *
 * Refused by name with the fix in the message. The alternative — picking a timezone — is precisely the silent
 * choice this module exists to eliminate. A `Map` for the reason above.
 */
const REFUSED = new Map<string, string>([
  [
    "Temporal.Instant",
    "an Instant is a point in time, not a calendar value; call .toZonedDateTimeISO(timeZone).toPlainDateTime() to choose the timezone explicitly"
  ],
  [
    "Temporal.ZonedDateTime",
    "a ZonedDateTime carries a timezone that a spreadsheet cell cannot store; call .toPlainDateTime(), .toPlainDate() or .toPlainTime()"
  ],
  ["Temporal.PlainYearMonth", "a PlainYearMonth has no day; call .toPlainDate({ day: 1 })"],
  ["Temporal.PlainMonthDay", "a PlainMonthDay has no year; call .toPlainDate({ year })"],
  [
    "Temporal.Duration",
    "a Duration is a length of time, not a date; store .total({ unit: 'days' })"
  ]
]);

/** The numeric fields each kind must carry for a structural match to be believed. */
const REQUIRED_FIELDS: Readonly<Record<TemporalKind, readonly string[]>> = {
  date: ["year", "month", "day"],
  time: ["hour", "minute", "second"],
  dateTime: ["year", "month", "day", "hour", "minute", "second"]
};

/**
 * The `Symbol.toStringTag` of a value, if it has a string one.
 *
 * Read **once** per classification and threaded through, rather than re-read by each of `temporalRefusal`,
 * `Value.getType` and `temporalToParts`. A getter may return a different string each time it is called, and
 * three independent reads let one object be classified, refused and converted as three different things. A
 * throwing getter is caught too: a value that cannot be interrogated is simply not a Temporal value, which is
 * what it was before this module existed.
 */
function tagOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const tag = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
    return typeof tag === "string" ? tag : undefined;
  } catch {
    return undefined;
  }
}

/** What this module thinks a value is: one of the three civil kinds, a named refusal, or nothing. */
export interface TemporalVerdict {
  readonly kind?: TemporalKind;
  readonly refusal?: string;
}

const NOT_TEMPORAL: TemporalVerdict = {};

/**
 * Classify a value as a civil Temporal value, a refused Temporal type, or neither.
 *
 * **Branded where it can be, structural only as a fallback.** When the host has `Temporal`, an `instanceof`
 * against the real constructors is unforgeable and is tried first. It is not sufficient alone — a value from a
 * worker, an iframe or a polyfill belongs to another realm and would be missed — so a tag match is also
 * accepted, but only when the object actually carries the numeric fields that kind is made of.
 *
 * That second condition is what keeps this from being a behaviour change for existing callers. A plain object
 * that happens to be tagged `"Temporal.PlainDate"` but has no `year`/`month`/`day` is still stored as JSON,
 * exactly as before; forging one now means supplying a complete, coherent value, at which point storing it as a
 * date is what the caller asked for.
 */
export function classifyTemporal(value: unknown): TemporalVerdict {
  if (typeof value !== "object" || value === null) {
    return NOT_TEMPORAL;
  }
  const branded = brandedKind(value);
  if (branded !== undefined) {
    return { kind: branded };
  }
  const tag = tagOf(value);
  if (tag === undefined) {
    return NOT_TEMPORAL;
  }
  const refusal = REFUSED.get(tag);
  if (refusal !== undefined) {
    return { refusal };
  }
  const kind = ACCEPTED.get(tag);
  if (kind === undefined) {
    return NOT_TEMPORAL;
  }
  return hasNumericFields(value, REQUIRED_FIELDS[kind]) ? { kind } : NOT_TEMPORAL;
}

/**
 * The kind of a value that is genuinely one of this realm's Temporal instances.
 *
 * Reads the global rather than closing over it, because a polyfill may be installed after this module loads.
 * The shape is checked before any property is touched, so this cannot throw on Node 22, where merely evaluating
 * `Temporal.PlainDate` is a `ReferenceError`.
 */
function brandedKind(value: object): TemporalKind | undefined {
  const temporal = (globalThis as { Temporal?: Record<string, unknown> }).Temporal;
  if (typeof temporal !== "object" || temporal === null) {
    return undefined;
  }
  for (const [name, kind] of [
    ["PlainDate", "date"],
    ["PlainTime", "time"],
    ["PlainDateTime", "dateTime"]
  ] as const) {
    const ctor = temporal[name];
    if (typeof ctor === "function" && value instanceof (ctor as new (...args: never[]) => object)) {
      return kind;
    }
  }
  return undefined;
}

/** Whether every named field reads as a finite number. */
function hasNumericFields(value: object, names: readonly string[]): boolean {
  try {
    for (const name of names) {
      if (!Number.isFinite((value as Record<string, unknown>)[name])) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a value is one of the three civil Temporal types.
 *
 * By brand where possible and by tag-plus-shape otherwise; never by tag alone. See {@link classifyTemporal}.
 */
export function isTemporalPlainValue(value: unknown): value is TemporalPlainValue {
  return classifyTemporal(value).kind !== undefined;
}

/**
 * Which of the three a value is.
 *
 * Returns `undefined` for anything else, so a caller can branch without a second lookup.
 */
export function temporalKindOf(value: unknown): TemporalKind | undefined {
  return classifyTemporal(value).kind;
}

/**
 * The message for a Temporal type that is not a civil value, or `undefined` if this is not one.
 *
 * Separate from {@link isTemporalPlainValue} so the caller decides *when* to refuse: `Value.getType` must not
 * throw while merely classifying, but `setValue` should not quietly store an `Instant` as `[object Object]`.
 */
export function temporalRefusal(value: unknown): string | undefined {
  return classifyTemporal(value).refusal;
}

/**
 * The calendar date of serial 0 under each epoch — the anchor a time-only value hangs on.
 *
 * Derived rather than written down, so the two can never disagree with `serialToParts`, which is the function
 * that actually defines them.
 */
const ZERO_DAY_1900 = serialToParts(0, false);
const ZERO_DAY_1904 = serialToParts(0, true);

/** Read a numeric ISO-calendar field off a Temporal value, defaulting a field the type does not have. */
function field(value: object, name: string): number {
  const raw = (value as Record<string, unknown>)[name];
  return typeof raw === "number" ? raw : 0;
}

/**
 * A civil Temporal value as {@link ExcelDateTimeParts}.
 *
 * **Re-anchored to the ISO calendar first.** `Temporal.PlainDate.from({ …, calendar: "hebrew" })` reports
 * `year`/`month`/`day` in *that* calendar — 5784-05-05 for what ISO calls 2024-01-15 — while an Excel serial
 * counts proleptic Gregorian days and has no notion of a calendar at all. Reading the fields directly would
 * store a date 3,760 years out. `PlainTime` has no calendar, hence the guard.
 *
 * **Sub-millisecond precision is rounded away**, because it cannot survive the destination: an Excel serial is a
 * float64 count of days, so near the present its resolution is about a microsecond, and every other part of this
 * library — and Excel itself — works in whole milliseconds. Rounding rather than throwing, because a `PlainTime`
 * taken from a clock has nanoseconds and refusing it would be hostile.
 *
 * A `PlainTime` yields the fields of the workbook's own zero date, which is what makes its serial the bare
 * fraction of a day Excel reads as a time. **That date is not a constant.** Serial 0 is 1899-12-30 under the
 * 1900 epoch and 1904-01-01 under the 1904 one, so anchoring every time at 1899-12-30 wrote `-1461.6` into a
 * 1904 workbook — a negative serial, which Excel renders as `########`. It round-tripped through this library
 * regardless, because the reader applied the same epoch and a time-only format takes the fraction anyway; only
 * the file was wrong. Hence `date1904`.
 */
export function temporalToParts(value: TemporalPlainValue, date1904 = false): ExcelDateTimeParts {
  const kind = temporalKindOf(value);
  if (kind === undefined) {
    throw new ExcelError("Not a Temporal PlainDate, PlainTime or PlainDateTime");
  }
  const withCalendar = (value as { withCalendar?: (id: string) => object }).withCalendar;
  const iso =
    typeof withCalendar === "function" ? withCalendar.call(value, "iso8601") : (value as object);

  const zero = date1904 ? ZERO_DAY_1904 : ZERO_DAY_1900;
  // **Rounded as one quantity, then decomposed — not field by field.** Adding the sub-millisecond remainder
  // straight onto `millisecond` let it reach 1000, which is not a millisecond field at all:
  // `23:59:59.999999999` produced `{ hour: 23, minute: 59, second: 59, millisecond: 1000 }`, and a `PlainTime`
  // built from that carried into the next day and was written as serial 1 rather than a fraction below 1.
  const nanosInDay =
    ((field(iso, "hour") * 60 + field(iso, "minute")) * 60 + field(iso, "second")) * 1e9 +
    field(iso, "millisecond") * 1e6 +
    field(iso, "microsecond") * 1000 +
    field(iso, "nanosecond");
  let msInDay = Math.round(nanosInDay / 1e6);
  let dayCarry = 0;
  if (msInDay >= MS_PER_DAY) {
    msInDay -= MS_PER_DAY;
    dayCarry = 1;
  }
  const millisecond = msInDay % 1000;
  const totalSeconds = (msInDay - millisecond) / 1000;
  const second = totalSeconds % 60;
  const totalMinutes = (totalSeconds - second) / 60;
  const minute = totalMinutes % 60;
  const hour = (totalMinutes - minute) / 60;

  if (kind === "time") {
    // The day carry is dropped on purpose: a time of day has no date to carry into, and wrapping keeps the
    // serial the bare fraction the format will render.
    return { ...zero, hour, minute, second, millisecond };
  }
  const base = { year: field(iso, "year"), month: field(iso, "month"), day: field(iso, "day") };
  const carried =
    dayCarry === 0
      ? base
      : serialToParts(partsToSerial({ ...base, day: base.day + 1 }, date1904), date1904);
  return {
    year: carried.year,
    month: carried.month,
    day: carried.day,
    hour,
    minute,
    second,
    millisecond
  };
}

/** Whether the host runtime has Temporal at all. */
export function hasTemporal(): boolean {
  return typeof (globalThis as { Temporal?: unknown }).Temporal === "object";
}

/**
 * The three constructors this module calls, and nothing else.
 *
 * A structural interface rather than `typeof Temporal`, for the same reason the type aliases above are
 * structural: naming the namespace would make this file fail to compile wherever `esnext.temporal` is absent,
 * which is most of the runtimes the package supports.
 */
interface TemporalFactories {
  readonly PlainDate: { from: (input: unknown) => PlainDate };
  readonly PlainTime: { from: (input: unknown) => PlainTime };
  readonly PlainDateTime: { from: (input: unknown) => PlainDateTime };
}

/**
 * The `Temporal` namespace, or a refusal naming what is missing.
 *
 * The single place the global is read, so the error text is written once and the failure is a documented one
 * rather than `TypeError: Cannot read properties of undefined`.
 */
export function requireTemporal(): TemporalFactories {
  const temporal = (globalThis as { Temporal?: unknown }).Temporal;
  if (typeof temporal !== "object" || temporal === null) {
    throw new ExcelError(
      "Temporal is not available in this runtime. It needs Node 26+, Chrome 144+, Firefox 139+, Bun 1.4+ or " +
        "Deno 2.7+, and this package adds no polyfill. Use Cell.getDateParts for the same value as plain " +
        "calendar fields, which works everywhere."
    );
  }
  return temporal as TemporalFactories;
}

/**
 * {@link ExcelDateTimeParts} as the Temporal type matching `kind`.
 *
 * The inverse of {@link temporalToParts}, and the read half of the surface. Built through `from` with a field
 * object rather than a constructor, so an out-of-range field is Temporal's own `RangeError` naming the field
 * rather than a silent carry.
 */
export function partsToTemporal(
  parts: ExcelDateTimeParts,
  kind: TemporalKind,
  date1904 = false
): TemporalPlainValue {
  const temporal = requireTemporal();
  if (kind !== "time" && isExcelPhantomDay(parts, date1904)) {
    throw new ExcelError(
      "This is Excel serial 60, its fictitious 1900-02-29. That day does not exist in the ISO calendar, so " +
        "it has no Temporal representation. Use Cell.getDateParts, which reports the fields as Excel stores " +
        "them."
    );
  }
  switch (kind) {
    case "date":
      return temporal.PlainDate.from({ year: parts.year, month: parts.month, day: parts.day });
    case "time":
      return temporal.PlainTime.from({
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
        millisecond: parts.millisecond
      });
    case "dateTime":
      return temporal.PlainDateTime.from(parts);
  }
}
