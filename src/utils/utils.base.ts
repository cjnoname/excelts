/**
 * Base utility functions shared between Node.js and Browser
 * All functions use standard Web APIs that work in both environments
 * (Node.js 16+ supports atob/btoa/TextEncoder/TextDecoder globally)
 */

import { isNode } from "@utils/env";
import { partsToSerial, partsToUtcDate, serialToParts, utcDateToParts } from "@utils/excel-serial";

// =============================================================================
// Base64 utilities (with native Buffer optimization for Node.js)
// =============================================================================

/**
 * Convert base64 string to Uint8Array
 * Uses native Buffer in Node.js for better performance
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  // Node.js: use native Buffer (fast, C++ implementation)
  if (isNode()) {
    return Buffer.from(base64, "base64");
  }
  // Browser: use atob
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// =============================================================================
// Basic utilities
// =============================================================================

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Date utilities
// =============================================================================

/**
 * A `Date` as an Excel date serial.
 *
 * **The `Date` is read as a calendar value, not as an instant** — its *UTC* fields are taken to
 * be the spreadsheet's wall-clock date and time. That is the convention the whole library
 * follows (see `@utils/excel-serial`), and it is why `new Date(Date.UTC(2024, 0, 15))` is the
 * form to pass. A locally-constructed `new Date(2024, 0, 15)` names a different instant in
 * every timezone, so it converts to a different serial in every timezone; in UTC+8 it yields
 * 45305.667, which Excel displays as 2024-01-14 16:00.
 *
 * `Date` cannot express which of its two readings is meant, which is the whole problem. Prefer
 * {@link partsToSerial} internally, and `Cell.setValue` with a Temporal `Plain*` or an
 * `ExcelDateTimeParts` externally, where the value says what it is.
 */
export function dateToExcel(d: Date, date1904?: boolean): number {
  return partsToSerial(utcDateToParts(d), date1904);
}

/**
 * An Excel date serial as a `Date` carrying the calendar value in its **UTC** fields.
 *
 * The counterpart of {@link dateToExcel}, and the reason every consumer of a date cell in this
 * codebase reads it with `getUTC*`. A caller who wants the value without the ambiguity should
 * use `Cell.getDateParts` or `Cell.getTemporal`.
 */
export function excelToDate(v: number, date1904?: boolean): Date {
  return partsToUtcDate(serialToParts(v, date1904));
}

/**
 * Parse an OOXML date string into a Date object.
 * OOXML dates like "2024-01-15T00:00:00" lack a timezone suffix,
 * which some JS engines parse as local time. Appending "Z" forces UTC.
 */
export function parseOoxmlDate(raw: string): Date {
  return new Date(raw.endsWith("Z") ? raw : raw + "Z");
}

// =============================================================================
// OOXML escape utilities (ST_Xstring, ISO/IEC 29500 clause 22.4.2.4)
// =============================================================================

/**
 * Pattern matching OOXML `_xHHHH_` escape sequences (case-insensitive hex).
 *
 * Per the OOXML spec, `_xHHHH_` encodes a Unicode code point where HHHH is
 * a 4-digit hexadecimal number. The spec uses uppercase, but real-world files
 * from third-party tools (Google Sheets, LibreOffice, etc.) may use lowercase.
 */
const ooxmlEscapeRegex = /_x([0-9A-Fa-f]{4})_/g;

/**
 * Decode OOXML `_xHHHH_` escape sequences in a string.
 *
 * Used when reading text content from `<t>` elements in shared strings,
 * rich text runs, and inline strings. The replacement works left-to-right,
 * so `_x005F_x000D_` correctly decodes to the literal string `_x000D_`
 * (the `_x005F_` decodes to `_`, consuming the match).
 */
export function decodeOoxmlEscape(text: string): string {
  return text.replace(ooxmlEscapeRegex, (match, $1) => {
    const code = parseInt($1, 16);
    // Reject characters that are invalid in XML 1.0:
    // - NUL (0x00)
    // - ASCII control chars except TAB(0x09), LF(0x0A), CR(0x0D)
    // - DEL (0x7F)
    // - Lone surrogates (0xD800-0xDFFF)
    // - Non-characters (0xFFFE, 0xFFFF)
    if (
      code === 0 ||
      (code >= 0x01 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      // Invalid character — leave the escape sequence as-is
      return match;
    }
    return String.fromCharCode(code);
  });
}

/**
 * Encode literal `_xHHHH_` patterns in a string for OOXML output.
 *
 * If a string naturally contains the pattern `_xHHHH_` (e.g., the user typed
 * `_x000D_`), the leading underscore must be escaped as `_x005F_` to prevent
 * readers from misinterpreting it as an escape sequence.
 *
 * Roundtrip guarantee: `decodeOoxmlEscape(encodeOoxmlEscape(s)) === s`
 */
export function encodeOoxmlEscape(text: string): string {
  return text.replace(ooxmlEscapeRegex, "_x005F_x$1_");
}

/**
 * Characters that XML attribute-value normalisation replaces with spaces
 * (XML 1.0 §3.3.3). When writing OOXML attribute values we must encode
 * these as `_xHHHH_` so that the original characters survive a round-trip.
 */
const xmlAttrUnsafeRe = /[\t\n\r]/g;
const xmlAttrUnsafeMap: Record<string, string> = {
  "\t": "_x0009_",
  "\n": "_x000A_",
  "\r": "_x000D_"
};

/**
 * Encode a string for safe use in an OOXML **XML attribute** value.
 *
 * Two transformations are applied (order matters):
 * 1. Literal `_xHHHH_` patterns are escaped (`_x005F_xHHHH_`) so readers
 *    do not misinterpret them as escape sequences.
 * 2. Characters that XML attribute-value normalisation would mangle
 *    (`\t`, `\n`, `\r`) are encoded as `_x0009_`, `_x000A_`, `_x000D_`.
 *
 * This is the write-side counterpart of {@link decodeOoxmlEscape}.
 * Use `encodeOoxmlEscape` for element **text** content and this function
 * for **attribute** values.
 */
export function encodeOoxmlAttr(text: string): string {
  // Step 1 – protect literal _xHHHH_ patterns (must come first so that
  // the _xHHHH_ sequences produced in step 2 are not double-escaped).
  let result = text.replace(ooxmlEscapeRegex, "_x005F_x$1_");
  // Step 2 – encode characters unsafe in XML attributes.
  result = result.replace(xmlAttrUnsafeRe, ch => xmlAttrUnsafeMap[ch]);
  return result;
}

// =============================================================================
// Parsing utilities
// =============================================================================

export function validInt(value: string | number): number {
  const i = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isNaN(i) ? 0 : i;
}

/**
 * Split an Excel numFmt string by semicolons, respecting quoted strings and brackets.
 *
 * Excel numFmt can have up to 4 sections: `positive ; negative ; zero ; text`.
 * Semicolons inside `"..."` (literal text) or `[...]` (locale/color tags) must NOT
 * be treated as section separators.
 */
export function splitFormatSections(fmt: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  let inBracket = false;

  for (let i = 0; i < fmt.length; i++) {
    const char = fmt[i];

    if (char === '"' && !inBracket) {
      inQuote = !inQuote;
      current += char;
    } else if (char === "[" && !inQuote) {
      inBracket = true;
      current += char;
    } else if (char === "]" && !inQuote) {
      inBracket = false;
      current += char;
    } else if (char === ";" && !inQuote && !inBracket) {
      sections.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  sections.push(current);
  return sections;
}

/** Reusable regex — no capture groups, so safe for `test()`. */
const DATE_FMT_RE = /[ymdhMsb]/;

/** Strips bracket expressions `[...]` and quoted literals `"..."` from a format string. */
const STRIP_BRACKETS_QUOTES_RE = /\[[^\]]*\]|"[^"]*"/g;

/** Cache for isDateFmt results — typically only 5-20 unique formats per workbook,
 *  but each may be tested hundreds of thousands of times during reconcile. */
const _isDateFmtCache = new Map<string, boolean>();

export function isDateFmt(fmt: string | null | undefined): boolean {
  if (!fmt) {
    return false;
  }
  const cached = _isDateFmtCache.get(fmt);
  if (cached !== undefined) {
    return cached;
  }
  // Only the first section (used for positive numbers / dates) determines
  // whether the format represents a date.  The "@" text placeholder may
  // legitimately appear in later sections as a text fallback (e.g. "mm/dd/yyyy;@").
  const firstSection = splitFormatSections(fmt)[0];

  // Strip bracket expressions [...] (locale/color tags) and quoted literals "..."
  // before any further checks so that characters inside them are ignored.
  const clean = firstSection.replace(STRIP_BRACKETS_QUOTES_RE, "");

  // "@" in the cleaned section means it's a text format, not a date format.
  let result: boolean;
  if (clean.indexOf("@") > -1) {
    result = false;
  } else {
    result = DATE_FMT_RE.test(clean);
  }
  _isDateFmtCache.set(fmt, result);
  return result;
}

export function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

// =============================================================================
// Collection utilities
// =============================================================================

export function* range(start: number, stop: number, step: number = 1): Generator<number> {
  const compareOrder = step > 0 ? (a: number, b: number) => a < b : (a: number, b: number) => a > b;
  for (let value = start; compareOrder(value, stop); value += step) {
    yield value;
  }
}

export function toSortedArray<T>(values: Iterable<T>): T[] {
  const result = Array.from(values);
  if (result.length <= 1) {
    return result;
  }
  // All numbers → numeric sort
  if (result.every(item => Number.isFinite(item))) {
    return result.sort((a, b) => (a as number) - (b as number));
  }
  // All Dates → chronological sort
  if (result.every(item => item instanceof Date)) {
    return result.sort((a, b) => (a as Date).getTime() - (b as Date).getTime());
  }
  // Mixed types → type-aware sort: numbers first (numerically), then dates (chronologically), then strings (lexicographic)
  return result.sort((a, b) => {
    const ta = sortTypeRank(a);
    const tb = sortTypeRank(b);
    if (ta !== tb) {
      return ta - tb;
    }
    // Same type group
    if (ta === 0) {
      return (a as number) - (b as number);
    }
    if (ta === 1) {
      return (a as Date).getTime() - (b as Date).getTime();
    }
    return String(a).localeCompare(String(b));
  });
}

/** Rank for mixed-type sort: numbers=0, dates=1, everything else=2 */
function sortTypeRank(v: unknown): number {
  if (Number.isFinite(v)) {
    return 0;
  }
  if (v instanceof Date) {
    return 1;
  }
  return 2;
}

// =============================================================================
// Buffer utilities (cross-platform)
// =============================================================================

const textDecoder = new TextDecoder("utf-8");

let latin1Decoder: TextDecoder | undefined;
let _latin1DecoderResolved = false;

function getLatin1Decoder(): TextDecoder | undefined {
  if (!_latin1DecoderResolved) {
    _latin1DecoderResolved = true;
    try {
      latin1Decoder = new TextDecoder("latin1");
    } catch {
      latin1Decoder = undefined;
    }
  }
  return latin1Decoder;
}

/**
 * Convert a Buffer, ArrayBuffer, or Uint8Array to a UTF-8 string
 * Works in both Node.js and browser environments
 */
export function bufferToString(chunk: ArrayBuffer | Uint8Array | string): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return textDecoder.decode(chunk);
}

/**
 * Convert Uint8Array to base64 string
 * Uses native Buffer in Node.js, optimized chunked conversion in browser
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (isNode()) {
    return Buffer.from(bytes).toString("base64");
  }

  // Browser: fastest path when latin1 TextDecoder exists.
  // Some environments can still throw on `btoa(...)` (e.g. if decoding yields non-Latin1 chars),
  // so fall back to a guaranteed-binary string conversion.
  if (getLatin1Decoder()) {
    try {
      return btoa(latin1Decoder!.decode(bytes));
    } catch {
      // fall through
    }
  }

  // Browser: chunked String.fromCharCode to avoid stack overflow and reduce string concatenation
  const CHUNK_SIZE = 0x8000; // 32KB chunks
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    // Spread the chunk (a Uint8Array is an iterable of numbers) so the call is
    // type-checked against `fromCharCode(...codes: number[])` without an `any`
    // cast; chunk size stays within the engine's argument-count limit.
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(chunks.join(""));
}

/**
 * Convert string to UTF-16LE Uint8Array (used for Excel password hashing)
 */
export function stringToUtf16Le(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes;
}

// =============================================================================
// Async utilities
// =============================================================================

/**
 * Yield to the event loop via a macrotask.
 * Uses `setTimeout(0)` which works in both Node.js and browsers.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
