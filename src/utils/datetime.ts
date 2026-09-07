/**
 * High-performance native date parsing and formatting utilities
 *
 * Zero external dependencies. Optimized for CSV batch processing.
 * Uses character code operations and lookup tables for maximum speed.
 */

// ============================================================================
// Types
// ============================================================================

/** Supported date format strings */
export type DateFormat =
  | "YYYY-MM-DD[T]HH:mm:ssZ"
  | "YYYY-MM-DD[T]HH:mm:ss"
  | "YYYY-MM-DD[T]HH:mm:ss.SSSZ"
  | "YYYY-MM-DD"
  | "YYYY-MM-DD HH:mm:ss"
  | "MM-DD-YYYY"
  | "MM-DD-YYYY HH:mm:ss"
  | "MM/DD/YYYY HH:mm:ss"
  | "DD-MM-YYYY"
  | "DD-MM-YYYY HH:mm:ss"
  | "DD/MM/YYYY HH:mm:ss";

// ============================================================================
// Constants - Pre-computed lookup tables for zero-allocation operations
// ============================================================================

// Padding lookup (0-59 covers hours, minutes, seconds, and months/days)
const PAD2 = Array.from({ length: 60 }, (_, i) => (i < 10 ? `0${i}` : `${i}`));

// Character codes for fast comparison
const C_0 = 48;
const C_DASH = 45;
const C_SLASH = 47;
const C_COLON = 58;
const C_T = 84;
const C_SPACE = 32;
const C_Z = 90;
const C_PLUS = 43;
const C_DOT = 46;

// ============================================================================
// Low-level utilities (inlined for JIT optimization)
// ============================================================================

// Inline digit extraction - avoid function call overhead
// Using bitwise OR for integer coercion (faster than Math.floor)
function digit2(s: string, i: number) {
  return ((s.charCodeAt(i) - C_0) * 10 + s.charCodeAt(i + 1) - C_0) | 0;
}
function digit4(s: string, i: number) {
  return (
    ((s.charCodeAt(i) - C_0) * 1000 +
      (s.charCodeAt(i + 1) - C_0) * 100 +
      (s.charCodeAt(i + 2) - C_0) * 10 +
      s.charCodeAt(i + 3) -
      C_0) |
    0
  );
}

// Days in month lookup (index 0 unused, 1-12 for Jan-Dec)
// Using 31 for Feb; actual validation done by Date constructor
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validateDate(y: number, m: number, d: number): Date | null {
  // Fast bounds check using lookup table
  if (m < 1 || m > 12 || d < 1 || d > DAYS_IN_MONTH[m]) {
    return null;
  }
  const date = new Date(y, m - 1, d);
  // Check for overflow (e.g., Feb 30 -> Mar 2)
  return date.getMonth() === m - 1 ? date : null;
}

function validateDateTime(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  s: number
): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > DAYS_IN_MONTH[m]) {
    return null;
  }
  if (h > 23 || min > 59 || s > 59) {
    return null;
  }
  return new Date(y, m - 1, d, h, min, s);
}

// ============================================================================
// Specialized parsers
// ============================================================================
//
// **Each one checks its own width, and that is not redundant with the dispatch tables.** These were written to
// be selected by length first — the width is in every comment below — and so they only verified their
// *separators*: `parseISO` looked for dashes at positions 4 and 7 and nothing else. Every caller that reached
// them by any other route therefore got a silent prefix match. `createIsoDateParser` flattened the length table
// into a list, and `createDateParser` tries the caller's formats in order, so
// `"2020-01-15T00:00:00.000Z"` was matched by the *ten-character* date parser (through the first) and by the
// *nineteen-character* datetime parser (through the second). Both build with `new Date(y, m - 1, d, ...)` —
// local time — so an explicit `Z` was read as local and the value landed a day early in UTC+8.
//
// The precondition was real; it was simply unstated and unenforced, and `PARSERS` already length-guarded the two
// entries where that had been noticed. Stating it in each function is what makes the tables an optimisation
// rather than a correctness requirement, and it costs one integer compare in front of the character compares
// that were already there.

// YYYY-MM-DD (10 chars)
function parseISO(s: string): Date | null {
  if (s.length !== 10) {
    return null;
  }
  if (s.charCodeAt(4) !== C_DASH || s.charCodeAt(7) !== C_DASH) {
    return null;
  }
  return validateDate(digit4(s, 0), digit2(s, 5), digit2(s, 8));
}

// YYYY-MM-DDTHH:mm:ss (19 chars)
function parseISOT(s: string): Date | null {
  if (s.length !== 19) {
    return null;
  }
  if (
    s.charCodeAt(4) !== C_DASH ||
    s.charCodeAt(7) !== C_DASH ||
    s.charCodeAt(10) !== C_T ||
    s.charCodeAt(13) !== C_COLON ||
    s.charCodeAt(16) !== C_COLON
  ) {
    return null;
  }
  return validateDateTime(
    digit4(s, 0),
    digit2(s, 5),
    digit2(s, 8),
    digit2(s, 11),
    digit2(s, 14),
    digit2(s, 17)
  );
}

// YYYY-MM-DD HH:mm:ss (19 chars, space separator)
function parseISOSpace(s: string): Date | null {
  if (s.length !== 19) {
    return null;
  }
  if (
    s.charCodeAt(4) !== C_DASH ||
    s.charCodeAt(7) !== C_DASH ||
    s.charCodeAt(10) !== C_SPACE ||
    s.charCodeAt(13) !== C_COLON ||
    s.charCodeAt(16) !== C_COLON
  ) {
    return null;
  }
  return validateDateTime(
    digit4(s, 0),
    digit2(s, 5),
    digit2(s, 8),
    digit2(s, 11),
    digit2(s, 14),
    digit2(s, 17)
  );
}

// YYYY-MM-DDTHH:mm:ssZ (20 chars)
function parseISOZ(s: string): Date | null {
  if (s.length !== 20) {
    return null;
  }
  if (s.charCodeAt(19) !== C_Z) {
    return null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// YYYY-MM-DDTHH:mm:ss.SSSZ (24 chars)
function parseISOMsZ(s: string): Date | null {
  if (s.length !== 24) {
    return null;
  }
  if (s.charCodeAt(19) !== C_DOT || s.charCodeAt(23) !== C_Z) {
    return null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// YYYY-MM-DDTHH:mm:ss+HH:mm (25 chars)
function parseISOOffset(s: string): Date | null {
  if (s.length !== 25) {
    return null;
  }
  const c = s.charCodeAt(19);
  if (c !== C_PLUS && c !== C_DASH) {
    return null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// YYYY-MM-DDTHH:mm:ss.SSS+HH:mm (29 chars)
function parseISOMsOffset(s: string): Date | null {
  if (s.length !== 29) {
    return null;
  }
  if (s.charCodeAt(19) !== C_DOT) {
    return null;
  }
  const c = s.charCodeAt(23);
  if (c !== C_PLUS && c !== C_DASH) {
    return null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// MM-DD-YYYY or MM/DD/YYYY (10 chars)
function parseUS(s: string): Date | null {
  if (s.length !== 10) {
    return null;
  }
  const sep = s.charCodeAt(2);
  if ((sep !== C_DASH && sep !== C_SLASH) || s.charCodeAt(5) !== sep) {
    return null;
  }
  return validateDate(digit4(s, 6), digit2(s, 0), digit2(s, 3));
}

// DD-MM-YYYY or DD/MM/YYYY (10 chars)
function parseEU(s: string): Date | null {
  if (s.length !== 10) {
    return null;
  }
  const sep = s.charCodeAt(2);
  if ((sep !== C_DASH && sep !== C_SLASH) || s.charCodeAt(5) !== sep) {
    return null;
  }
  return validateDate(digit4(s, 6), digit2(s, 3), digit2(s, 0));
}

// MM-DD-YYYY HH:mm:ss or MM/DD/YYYY HH:mm:ss (19 chars)
function parseUSTime(s: string): Date | null {
  if (s.length !== 19) {
    return null;
  }
  const sep = s.charCodeAt(2);
  if ((sep !== C_DASH && sep !== C_SLASH) || s.charCodeAt(5) !== sep) {
    return null;
  }
  if (
    s.charCodeAt(10) !== C_SPACE ||
    s.charCodeAt(13) !== C_COLON ||
    s.charCodeAt(16) !== C_COLON
  ) {
    return null;
  }
  return validateDateTime(
    digit4(s, 6),
    digit2(s, 0),
    digit2(s, 3),
    digit2(s, 11),
    digit2(s, 14),
    digit2(s, 17)
  );
}

// DD-MM-YYYY HH:mm:ss or DD/MM/YYYY HH:mm:ss (19 chars)
function parseEUTime(s: string): Date | null {
  if (s.length !== 19) {
    return null;
  }
  const sep = s.charCodeAt(2);
  if ((sep !== C_DASH && sep !== C_SLASH) || s.charCodeAt(5) !== sep) {
    return null;
  }
  if (
    s.charCodeAt(10) !== C_SPACE ||
    s.charCodeAt(13) !== C_COLON ||
    s.charCodeAt(16) !== C_COLON
  ) {
    return null;
  }
  return validateDateTime(
    digit4(s, 6),
    digit2(s, 3),
    digit2(s, 0),
    digit2(s, 11),
    digit2(s, 14),
    digit2(s, 17)
  );
}

// ============================================================================
// Format dispatch tables
// ============================================================================

type Parser = (s: string) => Date | null;

const PARSERS: Record<DateFormat, Parser> = {
  "YYYY-MM-DD": parseISO,
  "YYYY-MM-DD[T]HH:mm:ss": parseISOT,
  "YYYY-MM-DD HH:mm:ss": parseISOSpace,
  "YYYY-MM-DD[T]HH:mm:ssZ": s =>
    s.length === 20 ? parseISOZ(s) : s.length === 25 ? parseISOOffset(s) : null,
  "YYYY-MM-DD[T]HH:mm:ss.SSSZ": s =>
    s.length === 24 ? parseISOMsZ(s) : s.length === 29 ? parseISOMsOffset(s) : null,
  "MM-DD-YYYY": parseUS,
  "MM-DD-YYYY HH:mm:ss": parseUSTime,
  "MM/DD/YYYY HH:mm:ss": parseUSTime,
  "DD-MM-YYYY": parseEU,
  "DD-MM-YYYY HH:mm:ss": parseEUTime,
  "DD/MM/YYYY HH:mm:ss": parseEUTime
};

// Length-based auto-detection (ISO formats only, US/EU excluded due to ambiguity)
/**
 * Every ISO parser, for `createIsoDateParser`. US and EU forms are excluded because `01-02-2020` is ambiguous.
 *
 * **A flat list, and the order does not matter.** This was a table keyed by string length, which read as a
 * dispatch — but its only consumer flattened it and tried the parsers in sequence, so the key was documentation
 * that nothing enforced. That is how a twenty-four-character `…000Z` reached the ten-character parser and was
 * read as a local date, a day early east of UTC. Each parser now checks its own width, so no ordering and no
 * dispatch table is load-bearing; keeping one would be a second place for the widths to be stated and to drift.
 */
const AUTO_DETECT: Parser[] = [
  parseISO,
  parseISOT,
  parseISOSpace,
  parseISOZ,
  parseISOMsZ,
  parseISOOffset,
  parseISOMsOffset
];

// ============================================================================
// High-performance batch processors (function + interface based)
// ============================================================================

/**
 * Optimized date parser for batch processing.
 *
 * @example
 * const parser = createDateParser(["YYYY-MM-DD"]);
 * const dates = parser.parseAll(csvStrings);
 */
export interface DateParser {
  /** Parse single value */
  parse(value: string): Date | null;
  /** Parse array of values */
  parseAll(values: string[]): (Date | null)[];
  /** Parse and filter valid dates */
  parseValid(values: string[]): Date[];
}

/** Build a DateParser backed by the given parser functions */
function makeDateParser(fns: Parser[]): DateParser {
  const single = fns.length === 1;
  const fn0 = fns[0];

  function parse(value: string): Date | null {
    if (!value) {
      return null;
    }
    const s = value.trim();
    if (!s) {
      return null;
    }
    // Fast path for single parser
    if (single) {
      return fn0(s);
    }
    // Multi-parser path
    for (let i = 0, len = fns.length; i < len; i++) {
      const r = fns[i](s);
      if (r) {
        return r;
      }
    }
    return null;
  }

  function parseAll(values: string[]): (Date | null)[] {
    const len = values.length;
    const out = new Array<Date | null>(len);
    for (let i = 0; i < len; i++) {
      out[i] = parse(values[i]);
    }
    return out;
  }

  function parseValid(values: string[]): Date[] {
    const out: Date[] = [];
    for (let i = 0, len = values.length; i < len; i++) {
      const d = parse(values[i]);
      if (d) {
        out.push(d);
      }
    }
    return out;
  }

  return { parse, parseAll, parseValid };
}

/** Create parser for specific formats */
export function createDateParser(formats: readonly DateFormat[]): DateParser {
  return makeDateParser(formats.map(f => PARSERS[f]).filter(Boolean));
}

/** Create parser for auto-detecting ISO formats */
export function createIsoDateParser(): DateParser {
  return makeDateParser(AUTO_DETECT);
}

function tzOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const h = (Math.abs(off) / 60) | 0; // Bitwise OR faster than Math.floor
  const m = Math.abs(off) % 60;
  return `${sign}${PAD2[h]}:${PAD2[m]}`;
}

/**
 * Optimized date formatter for batch processing.
 *
 * @example
 * const formatter = createDateFormatter("YYYY-MM-DD", { utc: true });
 * const strings = formatter.formatAll(dates);
 */
export interface DateFormatter {
  /** Format single date */
  format(date: Date): string;
  /** Format array of dates */
  formatAll(dates: Date[]): string[];
}

/** Build a DateFormatter backed by the given format function */
function makeDateFormatter(fn: (d: Date) => string): DateFormatter {
  function format(date: Date): string {
    return fn(date);
  }

  function formatAll(dates: Date[]): string[] {
    const len = dates.length;
    const out = new Array<string>(len);
    for (let i = 0; i < len; i++) {
      out[i] = fn(dates[i]);
    }
    return out;
  }

  return { format, formatAll };
}

/** Create ISO formatter (fastest) */
export function createIsoDateFormatter(utc = false): DateFormatter {
  // Direct string building is faster than toISOString() + slice
  return utc
    ? makeDateFormatter(d => {
        if (!(d instanceof Date)) {
          return "";
        }
        const t = d.getTime();
        if (Number.isNaN(t)) {
          return "";
        } // NaN check
        const y = d.getUTCFullYear();
        const M = d.getUTCMonth() + 1;
        const D = d.getUTCDate();
        const H = d.getUTCHours();
        const m = d.getUTCMinutes();
        const s = d.getUTCSeconds();
        const ms = d.getUTCMilliseconds();
        return `${y}-${PAD2[M]}-${PAD2[D]}T${PAD2[H]}:${PAD2[m]}:${PAD2[s]}.${ms < 10 ? "00" + ms : ms < 100 ? "0" + ms : ms}Z`;
      })
    : makeDateFormatter(d => {
        if (!(d instanceof Date)) {
          return "";
        }
        const t = d.getTime();
        if (Number.isNaN(t)) {
          return "";
        } // NaN check
        const y = d.getFullYear();
        const M = d.getMonth() + 1;
        const D = d.getDate();
        const H = d.getHours();
        const m = d.getMinutes();
        const s = d.getSeconds();
        const ms = d.getMilliseconds();
        return `${y}-${PAD2[M]}-${PAD2[D]}T${PAD2[H]}:${PAD2[m]}:${PAD2[s]}.${ms < 10 ? "00" + ms : ms < 100 ? "0" + ms : ms}${tzOffset(d)}`;
      });
}

/** Create custom format formatter */
export function createDateFormatter(format: string, options?: { utc?: boolean }): DateFormatter {
  const utc = options?.utc ?? false;

  // Fast paths for common formats (no regex, direct string building)
  if (format === "YYYY-MM-DD") {
    return utc
      ? makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${d.getUTCFullYear()}-${PAD2[d.getUTCMonth() + 1]}-${PAD2[d.getUTCDate()]}`;
        })
      : makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${d.getFullYear()}-${PAD2[d.getMonth() + 1]}-${PAD2[d.getDate()]}`;
        });
  }

  if (format === "YYYY-MM-DD HH:mm:ss") {
    return utc
      ? makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${d.getUTCFullYear()}-${PAD2[d.getUTCMonth() + 1]}-${PAD2[d.getUTCDate()]} ${PAD2[d.getUTCHours()]}:${PAD2[d.getUTCMinutes()]}:${PAD2[d.getUTCSeconds()]}`;
        })
      : makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${d.getFullYear()}-${PAD2[d.getMonth() + 1]}-${PAD2[d.getDate()]} ${PAD2[d.getHours()]}:${PAD2[d.getMinutes()]}:${PAD2[d.getSeconds()]}`;
        });
  }

  if (format === "MM-DD-YYYY" || format === "MM/DD/YYYY") {
    const sep = format.charAt(2);
    return utc
      ? makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${PAD2[d.getUTCMonth() + 1]}${sep}${PAD2[d.getUTCDate()]}${sep}${d.getUTCFullYear()}`;
        })
      : makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${PAD2[d.getMonth() + 1]}${sep}${PAD2[d.getDate()]}${sep}${d.getFullYear()}`;
        });
  }

  if (format === "DD-MM-YYYY" || format === "DD/MM/YYYY") {
    const sep = format.charAt(2);
    return utc
      ? makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${PAD2[d.getUTCDate()]}${sep}${PAD2[d.getUTCMonth() + 1]}${sep}${d.getUTCFullYear()}`;
        })
      : makeDateFormatter(d => {
          if (!(d instanceof Date)) {
            return "";
          }
          const t = d.getTime();
          if (Number.isNaN(t)) {
            return "";
          }
          return `${PAD2[d.getDate()]}${sep}${PAD2[d.getMonth() + 1]}${sep}${d.getFullYear()}`;
        });
  }

  // Generic path with pre-compiled template
  return createGenericFormatter(format, utc);
}

/** Generic formatter for arbitrary formats */
function createGenericFormatter(format: string, utc: boolean): DateFormatter {
  // Pre-process escaped sections (e.g. [literal text] → placeholder)
  // Manual scan avoids regex backtracking on adversarial input
  const esc: string[] = [];
  const parts: string[] = [];
  let i = 0;
  while (i < format.length) {
    if (format[i] === "[") {
      const closeIdx = format.indexOf("]", i + 1);
      if (closeIdx !== -1) {
        esc.push(format.slice(i + 1, closeIdx));
        parts.push(`\x00${esc.length - 1}\x00`);
        i = closeIdx + 1;
      } else {
        // No closing bracket — treat '[' as literal
        parts.push(format[i]);
        i++;
      }
    } else {
      parts.push(format[i]);
      i++;
    }
  }
  const tpl = parts.join("");

  // Detect used tokens for conditional computation
  const hasY = tpl.includes("YYYY");
  const hasMs = tpl.includes("SSS");
  const hasM = tpl.includes("MM");
  const hasD = tpl.includes("DD");
  const hasH = tpl.includes("HH");
  const hasMin = tpl.includes("mm");
  const hasS = tpl.includes("ss");
  const hasZ = tpl.includes("Z");

  return makeDateFormatter(d => {
    if (!(d instanceof Date)) {
      return "";
    }
    const t = d.getTime();
    if (Number.isNaN(t)) {
      return "";
    }

    let out = tpl;
    if (hasY) {
      out = out.replace(/YYYY/g, String(utc ? d.getUTCFullYear() : d.getFullYear()));
    }
    if (hasMs) {
      const ms = utc ? d.getUTCMilliseconds() : d.getMilliseconds();
      out = out.replace(/SSS/g, ms < 10 ? `00${ms}` : ms < 100 ? `0${ms}` : String(ms));
    }
    if (hasM) {
      out = out.replace(/MM/g, PAD2[utc ? d.getUTCMonth() + 1 : d.getMonth() + 1]);
    }
    if (hasD) {
      out = out.replace(/DD/g, PAD2[utc ? d.getUTCDate() : d.getDate()]);
    }
    if (hasH) {
      out = out.replace(/HH/g, PAD2[utc ? d.getUTCHours() : d.getHours()]);
    }
    if (hasMin) {
      out = out.replace(/mm/g, PAD2[utc ? d.getUTCMinutes() : d.getMinutes()]);
    }
    if (hasS) {
      out = out.replace(/ss/g, PAD2[utc ? d.getUTCSeconds() : d.getSeconds()]);
    }
    if (hasZ) {
      out = out.replace(/Z/g, utc ? "Z" : tzOffset(d));
    }

    if (esc.length) {
      // oxlint-disable-next-line no-control-regex
      out = out.replace(/\x00(\d+)\x00/g, (_, i) => esc[+i]);
    }
    return out;
  });
}

/** Get supported format strings */
export function getSupportedFormats(): DateFormat[] {
  return Object.keys(PARSERS) as DateFormat[];
}
