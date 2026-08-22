/**
 * Dates, for the Gantt chart.
 *
 * A Gantt bar is a span, so the parser has to do arithmetic on calendar dates, and this
 * module has no dependencies to do it with. `Date` itself is enough — the one thing to be
 * careful about is the local timezone, which turns `new Date("2024-01-01")` into the
 * evening of the 31st west of Greenwich and shifts every bar by a day. Everything here is
 * therefore UTC, and only ever formatted back through the UTC getters.
 */

/** Milliseconds in a day; every duration is expressed as a multiple of a unit like this. */
const DAY = 86_400_000;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: DAY,
  w: DAY * 7
};

/**
 * Parse a date.
 *
 * Handles the ISO forms Mermaid's default `dateFormat` covers — `YYYY-MM-DD`, with an
 * optional time — and returns `undefined` rather than `NaN` for anything else, so a
 * caller can tell "not a date" from "a date in 1970".
 */
export function parseDate(text: string): number | undefined {
  const trimmed = text.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const value = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0)
  );
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a duration such as `5d`, `2w`, `36h`.
 *
 * A bare number is days, which is what Mermaid assumes and what an author writing `30`
 * beside a date almost always means.
 */
export function parseDuration(text: string): number | undefined {
  // Case-sensitive, because `m` is a minute and `M` is a month. Matching case-insensitively
  // read `1M` as one minute, so a month-long task finished sixty seconds after it started.
  // `M` and `y` are deliberately absent from the pattern: they have no fixed length, and
  // {@link parseCalendarDuration} is what reads them.
  const match = /^(\d+(?:\.\d+)?)\s*(ms|[smhdw])?$/.exec(text.trim());
  if (match) {
    const unit = UNITS[match[2] ?? "d"];
    return unit === undefined ? undefined : Number(match[1]) * unit;
  }
  // The units with no case-sensitive twin are still accepted either way, so `1D` reads.
  const relaxed = /^(\d+(?:\.\d+)?)\s*(MS|[SHDW])$/.exec(text.trim());
  return relaxed === null
    ? undefined
    : Number(relaxed[1]) * (UNITS[relaxed[2].toLowerCase()] ?? DAY);
}

/**
 * A calendar duration — months or years — as written.
 *
 * Separate from {@link parseDuration} because it cannot be reduced to a length: a month is
 * not a fixed number of milliseconds, and pretending otherwise drifts by days over a year.
 */
export function parseCalendarDuration(text: string): { months: number } | undefined {
  const match = /^(\d+)\s*(M|y)$/.exec(text.trim());
  return match === null ? undefined : { months: Number(match[1]) * (match[2] === "y" ? 12 : 1) };
}

/** Add whole months to a UTC time, clamping the day into the target month. */
export function addMonths(time: number, months: number): number {
  const date = new Date(time);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  );
}

/**
 * Parse a date written in a Mermaid `dateFormat`.
 *
 * The field order is what the formats in practice differ by, so `YYYY`, `MM`, `DD` and an
 * optional time are honoured and anything else returns `undefined` — which lets the caller
 * say it could not read the date instead of silently reading a different one.
 */
export function parseWithFormat(text: string, format: string): number | undefined {
  const tokens = [...format.matchAll(/YYYY|MM|DD|HH|mm|ss/g)];
  if (tokens.length === 0) {
    return undefined;
  }
  const escape = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern = "^";
  let at = 0;
  for (const token of tokens) {
    pattern += escape(format.slice(at, token.index));
    pattern += token[0] === "YYYY" ? "(\\d{4})" : "(\\d{1,2})";
    at = token.index + token[0].length;
  }
  pattern += `${escape(format.slice(at))}$`;

  const match = new RegExp(pattern).exec(text.trim());
  if (!match) {
    return undefined;
  }
  const field: Record<string, number> = {};
  tokens.forEach((token, index) => {
    field[token[0]] = Number(match[index + 1]);
  });
  if (field.YYYY === undefined || field.MM === undefined || field.DD === undefined) {
    return undefined;
  }
  const value = Date.UTC(
    field.YYYY,
    field.MM - 1,
    field.DD,
    field.HH ?? 0,
    field.mm ?? 0,
    field.ss ?? 0
  );
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Advance `from` by `length`, skipping the days a chart excludes.
 *
 * A plan that excludes weekends is making a claim about *working* time, so a two-day task
 * starting on a Friday ends on the Tuesday. Adding the length outright made the bar span the
 * weekend, and every task chained after it inherited the error.
 */
export function addWorkingTime(
  from: number,
  length: number,
  excluded: ReadonlySet<number>
): number {
  if (excluded.size === 0) {
    return from + length;
  }
  let remaining = length;
  let at = from;
  let guard = 0;
  while (remaining > 0 && guard < 100_000) {
    guard++;
    const dayStart = Math.floor(at / DAY) * DAY;
    const nextDay = dayStart + DAY;
    if (excluded.has(new Date(dayStart).getUTCDay())) {
      at = nextDay;
      continue;
    }
    const usable = Math.min(remaining, nextDay - at);
    at += usable;
    remaining -= usable;
  }
  return at;
}

/** Month abbreviations, at module scope: an axis calls the formatter once per tick. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `D MMM`, for an axis that already says which year it is in. */
export function formatAxisDate(time: number, span: number): string {
  const date = new Date(time);
  // Over a long span the day is noise; over a short one the month is.
  if (span > DAY * 400) {
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }
  if (span > DAY * 45) {
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  }
  return `${date.getUTCDate()}/${date.getUTCMonth() + 1}`;
}

/**
 * Tick positions for an axis covering `[from, to]`.
 *
 * The step is chosen so the labels stay readable rather than to a fixed count: days for a
 * short project, weeks for a quarter, months for a year and more. Month steps advance by
 * calendar month rather than by 30 days, or the labels drift off the first of the month.
 */
export function axisTicks(from: number, to: number, maxTicks: number): number[] {
  const span = Math.max(1, to - from);
  const ticks: number[] = [];

  const monthly = span > DAY * 120;
  if (monthly) {
    const step = span > DAY * 730 ? 6 : span > DAY * 400 ? 3 : 1;
    const start = new Date(from);
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();
    for (;;) {
      const at = Date.UTC(year, month, 1);
      if (at > to) {
        break;
      }
      if (at >= from) {
        ticks.push(at);
      }
      month += step;
      year += Math.floor(month / 12);
      month = ((month % 12) + 12) % 12;
      if (ticks.length > maxTicks * 2) {
        break;
      }
    }
    return ticks;
  }

  const candidates = [DAY, DAY * 2, DAY * 7, DAY * 14, DAY * 30];
  const step = candidates.find(value => span / value <= maxTicks) ?? DAY * 30;
  // Start on a whole day so the labels sit on dates rather than on times.
  const first = Math.ceil(from / DAY) * DAY;
  for (let at = first; at <= to; at += step) {
    ticks.push(at);
  }
  return ticks;
}

export { DAY };
