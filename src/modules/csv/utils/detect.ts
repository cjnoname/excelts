/**
 * CSV Detection Utilities
 *
 * Auto-detection of CSV characteristics:
 * - Delimiter detection (comma, tab, semicolon, pipe, etc.)
 * - Line ending detection (LF, CRLF, CR)
 * - Quote character normalization
 *
 * This module is part of the csv/utils subsystem:
 * - detect.ts: Auto-detection of CSV format
 * - row.ts: Row format conversions (RowHashArray, headers)
 * - dynamic-typing.ts: Type coercion (string -> number/boolean/date)
 * - number.ts: Number parsing utilities
 * - generate.ts: Test data generation
 */

import { CsvError } from "@csv/errors";
import { scanRow } from "@csv/parse/scanner";

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Escape special regex characters
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize quote option to { enabled, char } form.
 * Centralizes the quote/false/null handling logic.
 */
export function normalizeQuoteOption(option: string | false | null | undefined): {
  enabled: boolean;
  char: string;
} {
  if (option === false || option === null) {
    return { enabled: false, char: "" };
  }
  return { enabled: true, char: option ?? '"' };
}

/**
 * Normalize escape option to { enabled, char } form.
 * Consistent with normalizeQuoteOption API design.
 *
 * @param escapeOption - User's escape option (string, false, null, or undefined)
 * @param quoteChar - The quote character (used as default when escape is undefined)
 * @returns { enabled: boolean, char: string }
 *   - enabled=false, char="" when explicitly disabled (false/null)
 *   - enabled=true, char=quoteChar when undefined (default behavior)
 *   - enabled=true, char=escapeOption when string provided
 */
export function normalizeEscapeOption(
  escapeOption: string | false | null | undefined,
  quoteChar: string
): { enabled: boolean; char: string } {
  if (escapeOption === false || escapeOption === null) {
    return { enabled: false, char: "" };
  }
  return { enabled: true, char: escapeOption ?? quoteChar };
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Common CSV delimiters to try during auto-detection
 * Order matters - comma is most common, then semicolon (European), tab, pipe
 */
export const AUTO_DETECT_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Candidates a detector will weigh.
 *
 * Shared with `CsvParserStream` because the two must agree: an empty list once meant "no
 * candidates, fall back to comma" here and "not configured, use the defaults" there, so the
 * same options produced different delimiters from `Csv.parse` and a streamed parse. An empty
 * list is read as "unset", which is what a caller passing one is asking for.
 */
export function delimiterCandidates(delimitersToGuess?: readonly string[]): readonly string[] {
  return delimitersToGuess && delimitersToGuess.length > 0
    ? delimitersToGuess
    : AUTO_DETECT_DELIMITERS;
}

/**
 * Default delimiter when auto-detection fails
 */
const DEFAULT_DELIMITER = ",";

/**
 * Characters that trigger formula escaping (CSV injection prevention).
 * Per OWASP recommendations, these characters at the start of a field
 * could be interpreted as formulas by spreadsheet applications.
 *
 * @see https://owasp.org/www-community/attacks/CSV_Injection
 */
const FORMULA_ESCAPE_CHARS = new Set([
  "=", // Equals - formula prefix
  "+", // Plus - formula prefix
  "-", // Minus - formula prefix
  "@", // At - formula prefix
  "\t", // Tab (0x09)
  "\r", // Carriage return (0x0D)
  "\n", // Line feed (0x0A)
  "\uFF1D", // ＝ (full-width equals)
  "\uFF0B", // ＋ (full-width plus)
  "\uFF0D", // － (full-width minus)
  "\uFF20" // ＠ (full-width at)
]);

// =============================================================================
// BOM and Formula Detection
// =============================================================================

/**
 * Apply a `beforeFirstChunk` hook and strip any BOM, in that order.
 *
 * Shared by `Csv.parse` and `CsvParserStream` so the hook cannot be validated on one path and
 * ignored on the other, and so a hook is free to introduce or remove a BOM either way.
 *
 * @throws CsvError when the hook returns something that is neither a string nor nullish.
 */
export function applyFirstChunkPreprocessing(
  input: string,
  beforeFirstChunk: ((chunk: string) => string | void) | undefined
): string {
  let text = input;
  if (beforeFirstChunk) {
    const result = beforeFirstChunk(text);
    if (typeof result === "string") {
      text = result;
    } else if (result !== undefined && result !== null) {
      throw new CsvError(
        `beforeFirstChunk must return a string or undefined, got ${typeof result}`
      );
    }
  }
  return stripBom(text);
}

/**
 * Strip UTF-8 BOM (Byte Order Mark) from start of string if present.
 * Excel exports UTF-8 CSV files with BOM (\ufeff).
 *
 * @param input - String to process
 * @returns String without BOM
 */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/**
 * Check if a string starts with a formula escape character.
 * Used for CSV injection prevention.
 */
export function startsWithFormulaChar(str: string): boolean {
  return str.length > 0 && FORMULA_ESCAPE_CHARS.has(str[0]);
}

// =============================================================================
// Line Break Detection
// =============================================================================

/**
 * Detect the line terminator used in a string.
 * Uses quote-aware detection to avoid detecting newlines inside quoted fields.
 *
 * @param input - String to analyze
 * @param quote - Quote character (default: '"')
 * @returns Detected line terminator or '\n' as default
 *
 * @example
 * detectLinebreak('a,b\r\nc,d') // '\r\n'
 * detectLinebreak('a,b\nc,d') // '\n'
 * detectLinebreak('a,b\rc,d') // '\r'
 * detectLinebreak('a,b,c') // '\n' (default)
 * detectLinebreak('"a\nb",c\r\nd') // '\r\n' (ignores newline in quotes)
 */
export function detectLinebreak(input: string, quote = '"'): string {
  let inQuote = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // Handle quote toggle (including escaped quotes "")
    if (char === quote) {
      // Check for escaped quote (two consecutive quotes)
      if (inQuote && input[i + 1] === quote) {
        i++; // Skip the escaped quote
        continue;
      }
      inQuote = !inQuote;
      continue;
    }

    // Skip characters inside quotes
    if (inQuote) {
      continue;
    }

    // Detect line ending outside of quotes
    if (char === "\r") {
      return input[i + 1] === "\n" ? "\r\n" : "\r";
    }
    if (char === "\n") {
      return "\n";
    }
  }

  // No line ending found outside quotes, default to \n
  return "\n";
}

// =============================================================================
// Delimiter Detection
// =============================================================================

/**
 * Auto-detect the delimiter used in a CSV string
 *
 * Algorithm:
 * 1. Sample the first few lines (up to 10) for analysis
 * 2. For each candidate delimiter:
 *    - Count occurrences per line (respecting quotes)
 *    - Check consistency: all lines should have the same count
 *    - Higher count = more fields = better delimiter candidate
 * 3. Choose the delimiter with highest consistent field count
 *
 * Tie-breaking rules (in priority order):
 * 1. Lowest delta (variance) wins - more consistent field counts across lines
 * 2. On delta tie, highest avgFieldCount wins - more fields per row
 * 3. On complete tie, array order wins - first delimiter in delimitersToGuess
 *    (default order: comma, semicolon, tab, pipe)
 *
 * @param input - CSV string to analyze
 * @param quote - Quote character (default: '"')
 * @param delimitersToGuess - Custom list of delimiters to try (default: [",", ";", "\t", "|"])
 * @returns Detected delimiter or first delimiter in list
 *
 * @example
 * detectDelimiter('a,b,c\n1,2,3') // ','
 * detectDelimiter('a;b;c\n1;2;3') // ';'
 * detectDelimiter('a\tb\tc\n1\t2\t3') // '\t'
 * detectDelimiter('a:b:c\n1:2:3', '"', [':']) // ':'
 */
export function detectDelimiter(
  input: string,
  quote: string = '"',
  delimitersToGuess?: string[],
  comment?: string,
  // Accepted for call-site compatibility and deliberately unused: a record that is empty or
  // only whitespace is never scored, whatever this says, because it cannot indicate a
  // delimiter. See isScorableDetectionRecord.
  skipEmptyLines?: boolean | "greedy",
  scannerOptions?: { escape?: string; relaxQuotes?: boolean; lineEnding?: string }
): string {
  void skipEmptyLines;
  const delimiters = delimiterCandidates(delimitersToGuess);
  const defaultDelimiter = delimiters[0] ?? DEFAULT_DELIMITER;

  let bestDelimiter = defaultDelimiter;
  let bestDelta: number | undefined;
  let bestAvgFieldCount: number | undefined;

  for (const delimiter of delimiters) {
    // Quote recognition depends on field boundaries, and field boundaries depend on the
    // candidate delimiter. Parse each candidate with the real scanner rather than first
    // splitting lines with a delimiter-independent quote toggle; the latter mistakes a
    // mid-field quote for an opening quote under one candidate and not another.
    const fieldCounts = sampleFieldCounts(input, delimiter, quote, comment, scannerOptions);
    const { avgFieldCount, delta } = scoreFieldCounts(fieldCounts);

    // Require at least ~2 fields on average
    if (avgFieldCount <= 1.99) {
      continue;
    }

    if (
      bestDelta === undefined ||
      delta < bestDelta ||
      (delta === bestDelta &&
        (bestAvgFieldCount === undefined || avgFieldCount > bestAvgFieldCount))
    ) {
      bestDelta = delta;
      bestAvgFieldCount = avgFieldCount;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
}

/**
 * Records each delimiter candidate is scored on.
 *
 * Shared with `CsvParserStream`, which must wait for the same sample before committing so a
 * streamed parse and `Csv.parse` cannot disagree about the delimiter.
 */
export const DELIMITER_DETECTION_SAMPLE_RECORDS = 10;

/**
 * Characters of *scorable* records a candidate may be scored on.
 *
 * A candidate whose quoting never closes would otherwise have no sample and no end, which for
 * a stream means buffering the whole input before emitting anything. Blank and comment records
 * do not consume this budget — they are skipped, not scored — so a long comment prefix still
 * reaches the first data record. Both sides stop at the same record boundary.
 */
export const DELIMITER_DETECTION_SAMPLE_CHARS = 65536;

/**
 * Whether a record can contribute to a delimiter candidate's score.
 *
 * Shared with `CsvParserStream` so that a stream waits for exactly the records the batch
 * detector scores; a private copy of this rule on either side reopens the gap it closes.
 */
export function isScorableDetectionRecord(raw: string, comment?: string): boolean {
  if (comment && raw.startsWith(comment)) {
    return false;
  }
  return raw.trim() !== "";
}

/** Parse at most `DELIMITER_DETECTION_SAMPLE_RECORDS` meaningful records for one candidate. */
function sampleFieldCounts(
  input: string,
  delimiter: string,
  quote: string,
  comment: string | undefined,
  options: { escape?: string; relaxQuotes?: boolean; lineEnding?: string } | undefined
): number[] {
  const config = {
    delimiter,
    quote,
    escape: options?.escape ?? quote,
    quoteEnabled: quote !== "",
    relaxQuotes: options?.relaxQuotes ?? false
  };
  const counts: number[] = [];
  let offset = 0;

  let scoredChars = 0;

  while (
    offset < input.length &&
    counts.length < DELIMITER_DETECTION_SAMPLE_RECORDS &&
    scoredChars < DELIMITER_DETECTION_SAMPLE_CHARS
  ) {
    let raw: string;
    let fields: string[];
    let next: number;

    if (options?.lineEnding) {
      const at = input.indexOf(options.lineEnding, offset);
      const end = at === -1 ? input.length : at;
      raw = input.slice(offset, end);
      fields = scanRow(raw, 0, config, true).fields;
      next = at === -1 ? input.length : end + options.lineEnding.length;
    } else {
      const row = scanRow(input, offset, config, true);
      raw = input.slice(row.rawStart, row.rawEnd);
      fields = row.fields;
      next = row.endPos;
    }

    if (next <= offset) {
      break;
    }
    offset = next;

    if (!isScorableDetectionRecord(raw, comment)) {
      continue;
    }
    counts.push(fields.length);
    scoredChars += raw.length;
  }

  return counts;
}

/**
 * Score a delimiter candidate based on consistency and field count
 *
 * Returns 0 if:
 * - Delimiter not found in any line
 * - Field counts are inconsistent across lines
 *
 * Higher score = more fields per row with consistent counts
 */
function scoreFieldCounts(fieldCounts: number[]): { avgFieldCount: number; delta: number } {
  if (fieldCounts.length === 0) {
    return { avgFieldCount: 0, delta: Number.POSITIVE_INFINITY };
  }

  let delta = 0;
  let avgFieldCount = 0;
  let prevFieldCount: number | undefined;

  for (const fieldCount of fieldCounts) {
    avgFieldCount += fieldCount;

    if (prevFieldCount === undefined) {
      prevFieldCount = fieldCount;
      continue;
    }

    // Allow variability but prefer consistent counts
    delta += Math.abs(fieldCount - prevFieldCount);
    prevFieldCount = fieldCount;
  }

  avgFieldCount /= fieldCounts.length;

  return { avgFieldCount, delta };
}
