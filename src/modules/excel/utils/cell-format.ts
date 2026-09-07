// oxlint-disable no-control-regex
/**
 * Excel Cell Format Parser
 * A simplified implementation for formatting cell values according to Excel numFmt patterns
 * Supports: General, percentages, decimals, thousands separators, dates, currencies,
 * scientific notation, fractions, elapsed time, and more
 */

import type { NumFmt } from "@excel/types";
import { excelToDate, splitFormatSections, dateToExcel } from "@utils/utils";

// =============================================================================
// Built-in Format Table (Excel numFmtId to format string mapping)
// =============================================================================

const TABLE_FMT: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@"
};

/**
 * Default mapping for numFmtId that should map to other formats
 * Based on Excel's behavior for certain format IDs
 */
const DEFAULT_MAP: Record<number, number> = {
  // 5 -> 37 ... 8 -> 40
  5: 37,
  6: 38,
  7: 39,
  8: 40,
  // 23-26 -> 0
  23: 0,
  24: 0,
  25: 0,
  26: 0,
  // 27-31 -> 14
  27: 14,
  28: 14,
  29: 14,
  30: 14,
  31: 14,
  // 50-58 -> 14
  50: 14,
  51: 14,
  52: 14,
  53: 14,
  54: 14,
  55: 14,
  56: 14,
  57: 14,
  58: 14,
  // 59-62 -> 1-4
  59: 1,
  60: 2,
  61: 3,
  62: 4,
  // 67-68 -> 9-10
  67: 9,
  68: 10,
  // 72-75 -> 14-17
  72: 14,
  73: 15,
  74: 16,
  75: 17,
  // 76-78 -> 20-22
  76: 20,
  77: 21,
  78: 22,
  // 79-81 -> 45-47
  79: 45,
  80: 46,
  81: 47
};

/**
 * Get format string from numFmtId
 * Handles default mappings for certain format IDs
 */
export function getFormat(numFmtId: number): string {
  // Direct lookup first
  if (TABLE_FMT[numFmtId]) {
    return TABLE_FMT[numFmtId];
  }
  // Check default map
  if (DEFAULT_MAP[numFmtId] !== undefined) {
    return TABLE_FMT[DEFAULT_MAP[numFmtId]] ?? "General";
  }
  return "General";
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Pad number with leading zeros
 */
function pad0(num: number, len: number): string {
  let s = Math.round(num).toString();
  while (s.length < len) {
    s = "0" + s;
  }
  return s;
}

/**
 * Add thousand separators to a number string
 */
function commaify(s: string): string {
  const w = 3;
  if (s.length <= w) {
    return s;
  }
  const j = s.length % w;
  let o = s.substring(0, j);
  for (let i = j; i < s.length; i += w) {
    o += (o.length > 0 ? "," : "") + s.substring(i, i + w);
  }
  return o;
}

/**
 * Round a number to specified decimal places
 */
function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Process _ (underscore) placeholder - adds space with width of next character
 * Process * (asterisk) placeholder - repeats next character to fill width (simplified to single char)
 */
function processPlaceholders(fmt: string): string {
  // Replace _X with a space (skip next character, add space)
  let result = fmt.replace(/_./g, " ");
  // Replace *X with empty string (fill character, simplified)
  result = result.replace(/\*./g, "");
  return result;
}

// =============================================================================
// Format Detection
// =============================================================================

/**
 * Check if format is "General"
 */
function isGeneral(fmt: string): boolean {
  return /^General$/i.test(fmt.trim());
}

/**
 * Check if format is a date format
 */
function isDateFormat(fmt: string): boolean {
  // Remove color codes and conditions
  const cleaned = fmt.replace(/\[[^\]]*\]/g, "");
  // Check for date/time tokens (but not if it's just a number format with brackets)
  return /[ymdhs]/i.test(cleaned) && !/^[#0.,E%$\s()\-+]+$/i.test(cleaned);
}

// =============================================================================
// Date Formatting
// =============================================================================

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
// Single letter month abbreviation (J, F, M, A, M, J, J, A, S, O, N, D)
const MONTHS_LETTER = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Disambiguate each `mm` occurrence in a format string that has already been
 * placeholder-substituted for the other date/time tokens.
 *
 * Excel's rule: `mm` is minutes when it's adjacent to an hour or seconds
 * token (with no intervening date tokens); otherwise it's a zero-padded
 * month. This must be decided per occurrence — a single format string can
 * contain both roles (e.g. `"yyyy-mm-dd hh:mm:ss"`).
 *
 * The caller has already replaced `yyyy`/`yy` → `Y4/Y2`, month-name tokens
 * `mmmmm/mmmm/mmm` → `MN5/MN4/MN3`, `dd`/`d` → `D2/D1`, `hh`/`h` → `H2/H1`,
 * `ss`/`s` → `S2/S1`. So any remaining literal `mm` substrings here are
 * ambiguous between minute and month.
 *
 * Returns the input with each `mm` replaced by either `\x00MI2\x00` (minutes)
 * or `\x00M2\x00` (month, zero-padded).
 */
function resolveMonthOrMinute(s: string): string {
  // Tokens that, when present between an `mm` and a time anchor, break the
  // "adjacent time context" chain and push the `mm` back into month-land.
  const DATE_TOKEN = /\x00(?:Y[24]|D[12]|MN[345])\x00/;
  const HOUR_TOKEN = /\x00H[12]\x00/g;
  const SEC_TOKEN = /\x00S[12]\x00/g;

  let out = "";
  let work = s;
  let idx = work.search(/mm/i);
  while (idx !== -1) {
    const before = work.slice(0, idx);
    const after = work.slice(idx + 2);

    // Find the *nearest* hour token preceding this `mm` (scan from the right).
    let nearestHourIdx = -1;
    let m: RegExpExecArray | null;
    HOUR_TOKEN.lastIndex = 0;
    while ((m = HOUR_TOKEN.exec(before)) !== null) {
      nearestHourIdx = m.index;
    }
    // Find the *nearest* seconds token following this `mm`.
    SEC_TOKEN.lastIndex = 0;
    const secMatch = SEC_TOKEN.exec(after);
    const nearestSecIdx = secMatch ? secMatch.index : -1;

    const hourInRange = nearestHourIdx !== -1 && !DATE_TOKEN.test(before.slice(nearestHourIdx));
    const secInRange = nearestSecIdx !== -1 && !DATE_TOKEN.test(after.slice(0, nearestSecIdx));

    const isMinutes = hourInRange || secInRange;
    out += before + (isMinutes ? "\x00MI2\x00" : "\x00M2\x00");
    work = after;
    idx = work.search(/mm/i);
  }
  out += work;
  return out;
}

/**
 * Format a date value using Excel date format
 * @param serial Excel serial number (days since 1900-01-01)
 * @param fmt Format string
 *
 * **The hard-coded 1900 epoch is correct here, and is not a missing `date1904`.** This is reached from
 * `format(fmt, value)`, whose contract is a bare serial with no workbook attached — a serial with no epoch has
 * to assume one, and 1900 is the only defensible choice. On the path that actually carries a workbook's dates,
 * `formatCellValue` produces the serial with `dateToExcel(value)` — also 1900 — so the epoch cancels exactly and
 * a 1904 workbook's display text is right. Verified: the same cell renders identically under both settings.
 *
 * Threading `date1904` through would therefore change no output while widening a public signature, so it is
 * deliberately not done. Recorded because this reads like a bug on inspection, and has been reported as one.
 */
function formatDate(serial: number, fmt: string): string {
  // Extract time components directly from serial number (timezone-agnostic)
  const totalSeconds = Math.round(serial * 86400);
  const timeOfDay = totalSeconds % 86400;
  const hours = Math.floor(timeOfDay / 3600);
  const minutes = Math.floor((timeOfDay % 3600) / 60);
  const seconds = timeOfDay % 60;

  // For date components, use excelToDate but only for date parts
  const date = excelToDate(serial, false);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexed
  const day = date.getUTCDate();
  const dayOfWeek = date.getUTCDay();

  // Calculate fractional seconds from serial
  const fractionalSeconds = serial * 86400 - Math.floor(serial * 86400);

  // Check for AM/PM
  const hasAmPm = /AM\/PM|A\/P/i.test(fmt);
  const isPm = hours >= 12;
  // Standard 12-hour format: 0 and 12 both display as 12
  const hours12 = hours % 12 || 12;

  // Remove color codes like [Red], [Green], etc. but keep elapsed time brackets
  let result = fmt.replace(/\[(Red|Green|Blue|Yellow|Magenta|Cyan|White|Black|Color\d+)\]/gi, "");

  // Process _ and * placeholders
  result = processPlaceholders(result);

  // Handle fractional seconds (ss.0, ss.00, ss.000)
  const fracSecMatch = result.match(/ss\.(0+)/i);
  let fracSecStr = "";
  if (fracSecMatch) {
    const decPlaces = fracSecMatch[1].length;
    const fracPart = Math.round(fractionalSeconds * Math.pow(10, decPlaces));
    fracSecStr = fracPart.toString().padStart(decPlaces, "0");
    result = result.replace(/ss\.0+/gi, "\x00SF\x00");
  }

  // Process tokens - order matters! Longer patterns first.
  // Use placeholder tokens to avoid re-matching
  // Important: Use unique markers that don't contain the original pattern letters

  // Year
  result = result.replace(/yyyy/gi, "\x00Y4\x00");
  result = result.replace(/yy/gi, "\x00Y2\x00");

  // Month names (before numeric month) - order matters: longer patterns first
  result = result.replace(/mmmmm/gi, "\x00MN5\x00"); // Single letter month
  result = result.replace(/mmmm/gi, "\x00MN4\x00");
  result = result.replace(/mmm/gi, "\x00MN3\x00");

  // Day names (must be before dd and d)
  result = result.replace(/dddd/gi, "\x00DN4\x00");
  result = result.replace(/ddd/gi, "\x00DN3\x00");

  // Day numbers
  result = result.replace(/dd/gi, "\x00D2\x00");
  result = result.replace(/\bd\b/gi, "\x00D1\x00");

  // Hours
  result = result.replace(/hh/gi, "\x00H2\x00");
  result = result.replace(/\bh\b/gi, "\x00H1\x00");

  // Seconds (before mm to avoid confusion)
  result = result.replace(/ss/gi, "\x00S2\x00");
  result = result.replace(/\bs\b/gi, "\x00S1\x00");

  // Minutes/Month `mm` — position-dependent. Excel treats `mm` as minutes
  // when the nearest neighboring time-token is an hour (before) or a
  // seconds token (after); otherwise it's month. This must be decided **per
  // occurrence**, because a single format string can contain both roles —
  // e.g. in `"yyyy-mm-dd hh:mm:ss"` the first `mm` is month and the second
  // is minutes. A single global `hasTimeContext` flag would miscategorise
  // all `mm` as minutes in such mixed formats.
  result = resolveMonthOrMinute(result);
  result = result.replace(/\bm\b/gi, "\x00M1\x00");

  // AM/PM
  result = result.replace(/AM\/PM/gi, "\x00AMPM\x00");
  result = result.replace(/A\/P/gi, "\x00AP\x00");

  // Now replace placeholders with actual values
  const hourVal = hasAmPm ? hours12 : hours;

  result = result
    .replace(/\x00Y4\x00/g, year.toString())
    .replace(/\x00Y2\x00/g, (year % 100).toString().padStart(2, "0"))
    .replace(/\x00MN5\x00/g, MONTHS_LETTER[month])
    .replace(/\x00MN4\x00/g, MONTHS_LONG[month])
    .replace(/\x00MN3\x00/g, MONTHS_SHORT[month])
    .replace(/\x00M2\x00/g, (month + 1).toString().padStart(2, "0"))
    .replace(/\x00M1\x00/g, (month + 1).toString())
    .replace(/\x00DN4\x00/g, DAYS_LONG[dayOfWeek])
    .replace(/\x00DN3\x00/g, DAYS_SHORT[dayOfWeek])
    .replace(/\x00D2\x00/g, day.toString().padStart(2, "0"))
    .replace(/\x00D1\x00/g, day.toString())
    .replace(/\x00H2\x00/g, hourVal.toString().padStart(2, "0"))
    .replace(/\x00H1\x00/g, hourVal.toString())
    .replace(/\x00MI2\x00/g, minutes.toString().padStart(2, "0"))
    .replace(/\x00S2\x00/g, seconds.toString().padStart(2, "0"))
    .replace(/\x00S1\x00/g, seconds.toString())
    .replace(/\x00SF\x00/g, seconds.toString().padStart(2, "0") + "." + fracSecStr)
    .replace(/\x00AMPM\x00/g, isPm ? "PM" : "AM")
    .replace(/\x00AP\x00/g, isPm ? "P" : "A");

  // Clean up escape characters
  result = result.replace(/\\/g, "");

  return result;
}

// =============================================================================
// Number Formatting
// =============================================================================

/**
 * Format a number using "General" format
 */
function formatGeneral(val: number | string | boolean): string {
  if (typeof val === "boolean") {
    return val ? "TRUE" : "FALSE";
  }
  if (typeof val === "string") {
    return val;
  }
  // Number formatting - up to 11 significant digits
  if (Number.isInteger(val)) {
    return val.toString();
  }
  // For decimals, show up to 11 significant figures
  const str = val.toPrecision(11);
  // Remove trailing zeros after decimal point
  return str.replace(/\.?0+$/, "").replace(/\.?0+e/, "e");
}

/**
 * Format a percentage value
 * @param val The decimal value (e.g., 0.25 for 25%)
 * @param fmt The format string containing %
 */
function formatPercentage(val: number, fmt: string): string {
  // Count % signs
  const percentCount = (fmt.match(/%/g) ?? []).length;
  // Multiply value by 100 for each %
  const scaledVal = val * Math.pow(100, percentCount);

  // Remove % from format to process the number part
  const numFmt = fmt.replace(/%/g, "");

  // Format the number part
  const numStr = formatNumberPattern(scaledVal, numFmt || "0");

  // Add back the % signs
  return numStr + "%".repeat(percentCount);
}

/**
 * Format a number in scientific notation
 * @param val The number to format
 * @param fmt The format string (e.g., "0.00E+00")
 */
function formatScientific(val: number, fmt: string): string {
  const sign = val < 0 ? "-" : "";
  const absVal = Math.abs(val);

  if (absVal === 0) {
    // Handle zero
    const decMatch = fmt.match(/\.([0#]+)E/i);
    const decPlaces = decMatch ? decMatch[1].length : 2;
    return "0." + "0".repeat(decPlaces) + "E+00";
  }

  // Find decimal places from format
  const decMatch = fmt.match(/\.([0#]+)E/i);
  const decPlaces = decMatch ? decMatch[1].length : 2;

  // Check if format has explicit +
  const hasPlus = fmt.includes("E+");

  // Calculate exponent
  const exp = Math.floor(Math.log10(absVal));
  const mantissa = absVal / Math.pow(10, exp);

  // Round mantissa to specified decimal places
  const roundedMantissa = roundTo(mantissa, decPlaces);

  // Format mantissa
  const mantissaStr = roundedMantissa.toFixed(decPlaces);

  // Format exponent
  const expSign = exp >= 0 ? (hasPlus ? "+" : "") : "-";
  const expStr = pad0(Math.abs(exp), 2);

  return sign + mantissaStr + "E" + expSign + expStr;
}

/**
 * Convert decimal to fraction using continued fraction algorithm
 */
function toFraction(val: number, maxDenom: number): [number, number, number] {
  const sign = val < 0 ? -1 : 1;
  let absVal = Math.abs(val);
  const whole = Math.floor(absVal);
  absVal -= whole;

  if (absVal < 1e-10) {
    return [sign * whole, 0, 1];
  }

  let p0 = 0,
    p1 = 1;
  let q0 = 1,
    q1 = 0;
  let a = Math.floor(absVal);
  let p = a;
  let q = 1;

  while (q1 < maxDenom) {
    a = Math.floor(absVal);
    p = a * p1 + p0;
    q = a * q1 + q0;

    if (absVal - a < 1e-10) {
      break;
    }
    absVal = 1 / (absVal - a);

    p0 = p1;
    p1 = p;
    q0 = q1;
    q1 = q;
  }

  if (q > maxDenom) {
    q = q1;
    p = p1;
  }

  return [sign * whole, sign * p, q];
}

/**
 * Format a number as a fraction
 * @param val The number to format
 * @param fmt The format string (e.g., "# ?/?", "# ??/??")
 */
function formatFraction(val: number, fmt: string): string {
  const sign = val < 0 ? "-" : "";
  const absVal = Math.abs(val);

  // Check for fixed denominator (e.g., "# ?/8")
  const fixedDenomMatch = fmt.match(/\?+\s*\/\s*(\d+)/);
  if (fixedDenomMatch) {
    const denom = parseInt(fixedDenomMatch[1], 10);
    const whole = Math.floor(absVal);
    const frac = absVal - whole;
    const numer = Math.round(frac * denom);

    if (fmt.includes("#") || fmt.includes("0")) {
      // Mixed fraction
      if (numer === 0) {
        return sign + whole.toString();
      }
      return sign + (whole > 0 ? whole + " " : "") + numer + "/" + denom;
    }
    // Simple fraction
    return sign + (whole * denom + numer) + "/" + denom;
  }

  // Variable denominator - count ? to determine max digits
  const denomMatch = fmt.match(/\/\s*(\?+)/);
  const maxDigits = denomMatch ? denomMatch[1].length : 2;
  const maxDenom = Math.pow(10, maxDigits) - 1;

  const [whole, numer, denom] = toFraction(absVal, maxDenom);

  // Format based on whether we want mixed or improper fraction
  if (fmt.includes("#") && whole !== 0) {
    if (numer === 0) {
      return sign + Math.abs(whole).toString();
    }
    return sign + Math.abs(whole) + " " + Math.abs(numer) + "/" + denom;
  }

  if (numer === 0) {
    return whole === 0 ? "0" : sign + Math.abs(whole).toString();
  }

  // Improper fraction
  const totalNumer = Math.abs(whole) * denom + Math.abs(numer);
  return sign + totalNumer + "/" + denom;
}

/**
 * Format elapsed time (e.g., [h]:mm:ss for durations > 24 hours)
 */
function formatElapsedTime(serial: number, fmt: string): string {
  // serial is in days, convert to components
  const totalSeconds = Math.round(serial * 86400);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);

  const seconds = totalSeconds % 60;
  const minutes = totalMinutes % 60;
  const hours = totalHours;

  let result = fmt;

  // Replace elapsed time tokens
  if (/\[h+\]/i.test(result)) {
    result = result.replace(/\[h+\]/gi, hours.toString());
  }
  if (/\[m+\]/i.test(result)) {
    result = result.replace(/\[m+\]/gi, totalMinutes.toString());
  }
  if (/\[s+\]/i.test(result)) {
    result = result.replace(/\[s+\]/gi, totalSeconds.toString());
  }

  // Replace regular time tokens
  result = result.replace(/mm/gi, minutes.toString().padStart(2, "0"));
  result = result.replace(/ss/gi, seconds.toString().padStart(2, "0"));

  return result;
}

/**
 * Format a number with the given pattern
 * Handles patterns like "0", "00", "#,##0", "0-0", "000-0000" etc.
 */
function formatNumberPattern(val: number, fmt: string): string {
  const absVal = Math.abs(val);
  const sign = val < 0 ? "-" : "";

  // Handle trailing commas (divide by 1000 for each)
  let trailingCommas = 0;
  let workFmt = fmt;
  while (workFmt.endsWith(",")) {
    trailingCommas++;
    workFmt = workFmt.slice(0, -1);
  }
  const scaledVal = absVal / Math.pow(1000, trailingCommas);

  // Check for decimal point
  const decimalIdx = workFmt.indexOf(".");
  let intFmt = workFmt;
  let decFmt = "";

  if (decimalIdx !== -1) {
    intFmt = workFmt.substring(0, decimalIdx);
    decFmt = workFmt.substring(decimalIdx + 1);
  }

  // Count decimal places needed
  const decimalPlaces = decFmt.replace(/[^0#?]/g, "").length;

  // Round the value
  const roundedVal = roundTo(scaledVal, decimalPlaces);

  // When value is zero and the format has no required '0' digit placeholders,
  // '?' placeholders become spaces and '#' placeholders produce nothing.
  // This handles accounting format zero sections like "-"?? → "- " (dash + spaces).
  if (roundedVal === 0 && !intFmt.includes("0") && !decFmt.includes("0")) {
    let result = "";
    for (const ch of intFmt) {
      if (ch === "?") {
        result += " ";
      } else if (ch !== "#" && ch !== ",") {
        // Preserve literal characters (already unquoted at this point)
        result += ch;
      }
    }
    if (decimalPlaces > 0) {
      // Only emit the decimal point if the decimal format has '?' or '0' placeholders.
      // Pure '#' decimal digits produce nothing for zero values.
      const hasDecContent = /[0?]/.test(decFmt);
      if (hasDecContent) {
        result += ".";
        for (const ch of decFmt) {
          if (ch === "?") {
            result += " ";
          }
        }
      }
    }
    return sign + result;
  }

  // Split into integer and decimal parts
  const [intPart, decPart = ""] = roundedVal.toString().split(".");

  // Check if format has literal characters mixed with digit placeholders (like "0-0", "000-0000")
  // This is used for phone numbers, SSN, etc.
  const hasLiteralInFormat = /[0#?][^0#?,.\s][0#?]/.test(intFmt);

  let formattedInt: string;

  if (hasLiteralInFormat) {
    // Handle pattern with literals like "0-0", "000-0000", "00-00-00"
    // Count total digit placeholders
    const digitPlaceholders = intFmt.replace(/[^0#?]/g, "").length;

    // Pad the number to match the digit placeholder count
    let digits = intPart;
    if (digits.length < digitPlaceholders) {
      digits = "0".repeat(digitPlaceholders - digits.length) + digits;
    }

    // Build result by replacing placeholders with digits
    formattedInt = "";
    let digitIndex = digits.length - digitPlaceholders; // start position in digits string

    for (let i = 0; i < intFmt.length; i++) {
      const char = intFmt[i];
      if (char === "0" || char === "#" || char === "?") {
        if (digitIndex < digits.length) {
          formattedInt += digits[digitIndex];
          digitIndex++;
        }
      } else if (char !== ",") {
        // Literal character (like -, /, space, etc.) - but not comma (thousand separator)
        formattedInt += char;
      }
    }
  } else {
    // Standard number formatting
    formattedInt = intPart;

    // Add thousand separators if format has them
    if (intFmt.includes(",")) {
      formattedInt = commaify(intPart);
    }

    // Pad integer with leading zeros/spaces if needed
    // '0' placeholder → pad with "0", '?' placeholder → pad with " "
    const minIntDigits = (intFmt.match(/0/g) ?? []).length;
    const totalIntSlots = (intFmt.match(/[0?]/g) ?? []).length;
    if (formattedInt.length < minIntDigits) {
      formattedInt = "0".repeat(minIntDigits - formattedInt.length) + formattedInt;
    }
    if (formattedInt.length < totalIntSlots) {
      formattedInt = " ".repeat(totalIntSlots - formattedInt.length) + formattedInt;
    }

    // '#' integer placeholder: suppress "0" when there are no required '0' or '?' digits
    // and the integer value is zero (e.g. "#" format with value 0 → empty)
    if (formattedInt === "0" && minIntDigits === 0 && totalIntSlots === 0) {
      formattedInt = "";
    }
  }

  // Format decimal part
  let formattedDec = "";
  if (decimalPlaces > 0) {
    const rawDec = (decPart + "0".repeat(decimalPlaces)).substring(0, decimalPlaces);
    // Process each decimal digit position according to its placeholder:
    // '0' → always show digit, '?' → show digit or space, '#' → show digit or nothing (trim trailing)
    const decChars = rawDec.split("");
    // Walk from the end: '#' trailing zeros are removed, '?' trailing zeros become spaces
    for (let i = decFmt.length - 1; i >= 0; i--) {
      if (i >= decChars.length) {
        continue;
      }
      if (decFmt[i] === "#" && decChars[i] === "0") {
        decChars[i] = "";
      } else if (decFmt[i] === "?" && decChars[i] === "0") {
        decChars[i] = " ";
      } else {
        break; // stop at first non-zero or '0' placeholder
      }
    }
    const decStr = decChars.join("");
    // Only emit decimal point if there is content after it
    if (decStr.length > 0) {
      formattedDec = "." + decStr;
    }
  }

  return sign + formattedInt + formattedDec;
}

// =============================================================================
// Main Format Function
// =============================================================================

/**
 * Remove quoted literal text markers and return the literal characters
 * Also handles backslash escape sequences
 */
function processQuotedText(fmt: string): string {
  let result = "";
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '"') {
      // Find closing quote
      i++;
      while (i < fmt.length && fmt[i] !== '"') {
        result += fmt[i];
        i++;
      }
      i++; // skip closing quote
    } else if (fmt[i] === "\\" && i + 1 < fmt.length) {
      // Backslash escapes the next character
      i++;
      result += fmt[i];
      i++;
    } else {
      result += fmt[i];
      i++;
    }
  }
  return result;
}

/**
 * Check if a condition matches (e.g., [>100], [<=50])
 */
function checkCondition(val: number, condition: string): boolean {
  const match = condition.match(/\[(=|>|<|>=|<=|<>)(-?\d+(?:\.\d*)?)\]/);
  if (!match) {
    return false;
  }

  const op = match[1];
  const threshold = parseFloat(match[2]);

  switch (op) {
    case "=":
      return val === threshold;
    case ">":
      return val > threshold;
    case "<":
      return val < threshold;
    case ">=":
      return val >= threshold;
    case "<=":
      return val <= threshold;
    case "<>":
      return val !== threshold;
    default:
      return false;
  }
}

/**
 * Parse format string and handle positive/negative/zero/text sections
 * Excel format: positive;negative;zero;text
 * Also handles conditional formats like [>100]
 */
function chooseFormat(fmt: string, val: number | string | boolean): string {
  if (typeof val === "string") {
    // For text, use the 4th section if available, or just return as-is
    const sections = splitFormatSections(fmt);
    if (sections.length >= 4 && sections[3]) {
      // Process quoted text and replace @ with the value
      const textFmt = processQuotedText(sections[3]);
      return textFmt.replace(/@/g, val);
    }
    return val;
  }

  if (typeof val === "boolean") {
    return val ? "TRUE" : "FALSE";
  }

  const sections = splitFormatSections(fmt);

  // Check for conditional format in sections
  const condRegex = /\[(=|>|<|>=|<=|<>)-?\d+(?:\.\d*)?\]/;
  const hasCondition =
    (sections[0] && condRegex.test(sections[0])) || (sections[1] && condRegex.test(sections[1]));

  if (hasCondition && sections.length >= 2) {
    // Conditional format: check each section's condition
    for (let i = 0; i < Math.min(sections.length, 2); i++) {
      const condMatch = sections[i].match(/\[(=|>|<|>=|<=|<>)-?\d+(?:\.\d*)?\]/);
      if (condMatch && checkCondition(val as number, condMatch[0])) {
        return sections[i];
      }
    }
    // No condition matched, use last section
    return sections[sections.length > 2 ? 2 : 1];
  }

  if (sections.length === 1) {
    return sections[0];
  }

  if (sections.length === 2) {
    // positive/zero; negative
    return val >= 0 ? sections[0] : sections[1];
  }

  // 3+ sections: positive; negative; zero
  if (val > 0) {
    return sections[0];
  }
  if (val < 0) {
    return sections[1];
  }
  return sections[2] || sections[0];
}

/**
 * Check if format section is for negative values (2nd section in multi-section format)
 */
function isNegativeSection(fmt: string, selectedFmt: string): boolean {
  const sections = splitFormatSections(fmt);
  return sections.length >= 2 && sections[1] === selectedFmt;
}

/**
 * Main format function - formats a value according to Excel numFmt
 * @param fmt The Excel number format string (e.g., "0.00%", "#,##0", "yyyy-mm-dd")
 * @param val The value to format
 */
export function format(fmt: string, val: number | string | boolean): string {
  // Handle null/undefined
  if (val == null) {
    return "";
  }

  // Handle General format
  if (isGeneral(fmt)) {
    return formatGeneral(val);
  }

  // Handle string values
  if (typeof val === "string") {
    return chooseFormat(fmt, val) as string;
  }

  // Handle boolean values
  if (typeof val === "boolean") {
    return val ? "TRUE" : "FALSE";
  }

  // Now val is a number
  let numVal = val as number;

  // Choose the right format section based on value
  const selectedFmt = chooseFormat(fmt, numVal) as string;

  // If negative section is selected, use absolute value (format handles display)
  if (numVal < 0 && isNegativeSection(fmt, selectedFmt)) {
    numVal = Math.abs(numVal);
  }

  // Remove color codes like [Red], [Green], [Blue], etc.
  let cleanFmt = selectedFmt.replace(
    /\[(Red|Green|Blue|Yellow|Magenta|Cyan|White|Black|Color\d+)\]/gi,
    ""
  );

  // Remove condition codes like [>100], [<=50], etc.
  cleanFmt = cleanFmt.replace(/\[(>|<|>=|<=|=|<>)-?\d+(\.\d+)?\]/g, "");

  // Remove locale codes like [$-804], [$€-407], etc.
  cleanFmt = cleanFmt.replace(/\[\$[^\]]*\]/g, "");

  // Process _ and * placeholders
  cleanFmt = processPlaceholders(cleanFmt);

  // Process quoted text
  cleanFmt = processQuotedText(cleanFmt);

  // Check for elapsed time format [h]:mm:ss, [m]:ss, [s]
  if (/\[[hms]+\]/i.test(cleanFmt)) {
    return formatElapsedTime(numVal, cleanFmt);
  }

  // Check if this is a date format
  if (isDateFormat(cleanFmt)) {
    return formatDate(numVal, cleanFmt);
  }

  // Check for percentage
  if (cleanFmt.includes("%")) {
    return formatPercentage(numVal, cleanFmt);
  }

  // Check for scientific notation
  if (/E[+-]?/i.test(cleanFmt)) {
    return formatScientific(numVal, cleanFmt);
  }

  // Check for fraction format
  if (/\?+\s*\/\s*[\d?]+/.test(cleanFmt)) {
    return formatFraction(numVal, cleanFmt);
  }

  // Handle negative numbers in parentheses format
  if (cleanFmt.includes("(") && cleanFmt.includes(")") && numVal < 0) {
    const innerFmt = cleanFmt.replace(/\(|\)/g, "");
    return "(" + formatNumberPattern(-numVal, innerFmt) + ")";
  }

  // Handle text placeholder @
  if (cleanFmt === "@") {
    return numVal.toString();
  }

  // Handle currency symbol and literal text prefix/suffix
  let prefix = "";
  let suffix = "";

  // Extract currency/text prefix (includes $, ¥, €, etc. and quoted text)
  const prefixMatch = cleanFmt.match(/^([^#0?.,]+)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
    cleanFmt = cleanFmt.substring(prefixMatch[0].length);
  }

  // Extract suffix
  const suffixMatch = cleanFmt.match(/([^#0?.,]+)$/);
  if (suffixMatch && !suffixMatch[1].includes("%")) {
    suffix = suffixMatch[1];
    cleanFmt = cleanFmt.substring(0, cleanFmt.length - suffixMatch[0].length);
  }

  // Format the number
  const formattedNum = formatNumberPattern(numVal, cleanFmt);

  return prefix + formattedNum + suffix;
}

// =============================================================================
// Export
// =============================================================================

export const cellFormat = {
  format,
  getFormat,
  isDateFormat,
  isGeneral
};

// =============================================================================
// Display Text Helpers (used by Worksheet.toJSON)
// =============================================================================

/**
 * What a number format's codes say about the date and time parts of a serial.
 *
 * **One reading of a format, used by everything that needs one.** `isTimeOnlyFormat` and
 * `isDateDisplayFormat` each did this stripping and these four tests inline, and a third caller wanting the
 * date-vs-time-vs-both distinction would have written them a third time. That is how this codebase came to
 * have four disagreeing answers to "is this a date format"; the fix for one more caller is to stop having a
 * per-caller answer, not to add a fifth.
 *
 * The subtle field is `monthM`. A lone `m` is a *month* in `mmm-yy` and a *minute* in `h:mm`, and the only
 * cheap discriminator is whether the format also carries an hour or a second — which is why `hasTime` has to
 * be computed before the date question can be answered at all.
 */
interface FormatFacets {
  /** An elapsed-time format such as `[h]:mm:ss`, which measures a duration rather than naming a moment. */
  readonly elapsed: boolean;
  /** An hour, a second, or an AM/PM marker. */
  readonly hasTime: boolean;
  /** A year or a day code. */
  readonly hasYearOrDay: boolean;
  /** An `m` that reads as a month rather than as a minute. */
  readonly monthM: boolean;
}

/**
 * Read a format's date/time facets.
 *
 * Three things are removed before any code is looked for, and each was a way of reading a literal as a
 * directive:
 *
 * - **Everything after the first `;`.** A format's sections are positive, negative, zero and text, and only
 *   the first applies to a date cell's value. Judging `";;;dd"` by its fourth section called a hidden number
 *   format a date. Split with `splitFormatSections`, which knows that a `;` inside quotes or brackets is not
 *   a separator — the same function the readers' `isDateFmt` uses, so the two cannot drift.
 * - **Quoted literals**, so `#,##0" days"` is a number and not a day.
 * - **Backslash escapes**, so `\d0` is a literal `d` and not a day code. This was missed here, and `format()`
 *   a few hundred lines below had already learned it.
 *
 * `elapsed` matches `[h]`, `[hh]`, `[mm]`, `[ss]` and the rest, not just the single-character forms.
 * Requiring exactly one character meant `[hh]:mm` fell through to the date tests, where — its bracketed part
 * stripped and a bare `:mm` left behind — it was read as a **month** and reported as a date format.
 * `format()` had the right pattern already; this had a narrower copy of it.
 */
function formatFacets(fmt: string): FormatFacets {
  const section = splitFormatSections(fmt)[0] ?? "";
  const cleaned = section.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  const elapsed = /\[[hms]+\]/i.test(cleaned);
  const bare = cleaned.replace(/\[[^\]]*\]/g, "");
  const hasTime = /[hs]/i.test(bare) || /AM\/PM|A\/P/i.test(bare);
  return {
    elapsed,
    hasTime,
    hasYearOrDay: /[yd]/i.test(bare),
    monthM: /m/i.test(bare) && !hasTime
  };
}

/**
 * Check if format is a pure time format (no date components like y, m for month, d).
 * Time formats only contain: h, m (minutes in time context), s, AM/PM.
 * Excludes elapsed time formats like [h]:mm:ss which need the full serial number.
 */
export function isTimeOnlyFormat(fmt: string): boolean {
  const { elapsed, hasTime, hasYearOrDay, monthM } = formatFacets(fmt);
  return !elapsed && !hasYearOrDay && !monthM && hasTime;
}

/**
 * Check if format is a date format (contains y, d, or month-m).
 * More precise than the internal isDateFormat — correctly handles elapsed time
 * formats like [h]:mm:ss (not a date format) and distinguishes month-m from minute-m.
 */
export function isDateDisplayFormat(fmt: string): boolean {
  const { elapsed, hasYearOrDay, monthM } = formatFacets(fmt);
  return !elapsed && (hasYearOrDay || monthM);
}

/**
 * What a number format says a date-typed cell actually holds.
 *
 * **The format is the only record of the distinction.** A serial does not say whether its whole-day part or
 * its fraction is the point, and neither does the `Date` the model stores — so this is where
 * `Cell.getDateKind` and `Cell.getTemporal` get their answer, and why a time-of-day written without a format
 * renders as `12-30-1899`.
 *
 * **`"unknown"` and `"duration"` are real answers, not failures to produce one.** This returned `"dateTime"`
 * for an unformatted cell, a `General` cell, a plain number format and an elapsed-time format alike — which
 * dressed "I cannot tell" and "this is a length of time" up as a specific calendar kind, and left
 * `Cell.getTemporal` manufacturing a `PlainDateTime` for `[h]:mm:ss` that named a moment in 1899 for a value
 * meaning thirty-six hours. A caller can now see the difference and decide.
 */
export type DateFormatKind = "date" | "time" | "dateTime" | "duration" | "unknown";

export function dateFormatKind(fmt: string | undefined): DateFormatKind {
  if (fmt === undefined || fmt === "" || isGeneral(fmt)) {
    return "unknown";
  }
  const { elapsed, hasTime, hasYearOrDay, monthM } = formatFacets(fmt);
  if (elapsed) {
    return "duration";
  }
  const hasDate = hasYearOrDay || monthM;
  if (hasDate && hasTime) {
    return "dateTime";
  }
  if (hasDate) {
    return "date";
  }
  return hasTime ? "time" : "unknown";
}

/**
 * Default format applied to Date values whose numFmt is `General` or empty.
 *
 * Excel itself substitutes a locale-dependent short date in this case (US:
 * `m/d/yyyy`). We pick an ISO-like `yyyy-mm-dd` so consumers who never set a
 * `numFmt` still get a sensible, unambiguous rendering instead of the raw
 * Excel serial number.
 */
const DEFAULT_DATE_FORMAT = "yyyy-mm-dd";
const DEFAULT_DATETIME_FORMAT = "yyyy-mm-dd hh:mm:ss";

/**
 * Format a value according to the given format string.
 * Handles Date objects with timezone-independent Excel serial conversion.
 */
export function formatCellValue(
  value: Date | number | boolean | string,
  fmt: string,
  dateFormat?: string
): string {
  if (value instanceof Date) {
    let serial = dateToExcel(value);
    if (isTimeOnlyFormat(fmt)) {
      serial = serial % 1;
      if (serial < 0) {
        serial += 1;
      }
      return format(fmt, serial);
    }
    // For Date values whose numFmt is missing or General, Excel substitutes a
    // default short-date format. Without this, `format("General", serial)`
    // would emit the raw Excel serial (e.g. "43567") — almost never what the
    // caller wants. Pick a datetime-aware default based on whether the value
    // carries a non-midnight time component.
    let effectiveFmt: string;
    if (dateFormat && isDateDisplayFormat(fmt)) {
      effectiveFmt = dateFormat;
    } else if (!fmt || isGeneral(fmt)) {
      effectiveFmt = serial % 1 === 0 ? DEFAULT_DATE_FORMAT : DEFAULT_DATETIME_FORMAT;
    } else {
      effectiveFmt = fmt;
    }
    return format(effectiveFmt, serial);
  }
  return format(fmt, value);
}

// =============================================================================
// Cell Display Text
// =============================================================================

/** Minimal cell shape needed by {@link getCellDisplayText} — avoids importing Cell. */
interface CellLike {
  value: unknown;
  numFmt: string | NumFmt | undefined;
  text: string;
}

/**
 * Get the formatted display text for a cell value.
 *
 * Handles primitive values, Date objects, formula results, and falls back to
 * `cell.text` for complex types (rich text, hyperlinks, errors, etc.).
 *
 * @param cell       - A cell (or cell-like object) with `.value`, `.numFmt`, and `.text`
 * @param dateFormat - Optional custom date format override
 */
export function getCellDisplayText(cell: CellLike, dateFormat?: string): string {
  const value = cell.value;
  const numFmt = cell.numFmt;
  const fmt = typeof numFmt === "string" ? numFmt : (numFmt?.formatCode ?? "General");

  if (value == null) {
    return "";
  }

  if (
    value instanceof Date ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return formatCellValue(value, fmt, dateFormat);
  }

  // Formula type — use the result value
  if (typeof value === "object" && "formula" in value) {
    const result = (value as { formula: string; result?: unknown }).result;
    if (result == null) {
      return "";
    }
    if (
      result instanceof Date ||
      typeof result === "number" ||
      typeof result === "boolean" ||
      typeof result === "string"
    ) {
      return formatCellValue(result, fmt, dateFormat);
    }
  }

  // Fallback to cell.text for other types (rich text, hyperlink, error, etc.)
  return cell.text;
}
