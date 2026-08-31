/**
 * CSV Scanner Implementation
 *
 * High-performance CSV scanner using indexOf-based batch scanning.
 * Provides both synchronous and streaming interfaces.
 *
 * Key optimizations:
 * 1. Use indexOf to find delimiter/quote/newline positions in bulk
 * 2. Use slice to extract field values (avoids char-by-char concatenation)
 * 3. Minimize function call overhead by inlining hot paths
 *
 * @example Basic usage
 * ```ts
 * import { createScanner, scanAllRows } from '@csv/parse/scanner/scanner';
 *
 * // One-shot parsing
 * const rows = scanAllRows('a,b,c\n1,2,3\n');
 *
 * // Or use scanner instance
 * const scanner = createScanner({ delimiter: '\t' });
 * const result = scanner.scanRow('a\tb\tc\n');
 * ```
 *
 * @example Streaming usage
 * ```ts
 * import { scanRowsAsync } from '@csv/parse/scanner/scanner';
 *
 * async function* readChunks() {
 *   yield 'a,b,c\n';
 *   yield '1,2,3\n';
 * }
 *
 * for await (const row of scanRowsAsync(readChunks())) {
 *   console.log(row.fields);
 * }
 * ```
 */

import type {
  ScannerConfig,
  FieldScanResult,
  RowScanResult,
  Scanner
} from "@csv/parse/scanner/types";
import { DEFAULT_SCANNER_CONFIG, createScannerState } from "@csv/parse/scanner/types";

// =============================================================================
// Re-exports from types
// =============================================================================

export type { ScannerConfig, RowScanResult, Scanner } from "@csv/parse/scanner/types";
export { DEFAULT_SCANNER_CONFIG } from "@csv/parse/scanner/types";

// =============================================================================
// Helper Functions
// =============================================================================

const CHAR_LF = 10;
const CHAR_CR = 13;

/** Characters that must be escaped to match a delimiter literally inside a pattern. */
const REGEXP_METACHARACTERS = /[\\^$.*+?()[\]{}|]/g;

/**
 * Per-delimiter cache of "next delimiter or line terminator" patterns.
 *
 * Keyed by delimiter string rather than held in a `WeakMap` because the key is a
 * primitive. Bounded because a server may accept delimiters from many independent
 * requests; a module-level cache must not retain every one forever.
 */
const FIELD_TERMINATOR_PATTERNS = new Map<string, RegExp>();
const MAX_FIELD_TERMINATOR_PATTERNS = 32;

/**
 * Longest delimiter still embedded in a pattern.
 *
 * A delimiter is interpolated into the terminator pattern, and an engine rejects a pattern
 * that grows too large — `new RegExp` throws `SyntaxError` on a delimiter of a few tens of
 * thousands of characters, which the previous `indexOf` search accepted. Beyond this the
 * search falls back to scanning for a line terminator and confirming the delimiter with
 * `startsWith`, which is the same answer by slower means.
 */
const MAX_PATTERN_DELIMITER_LENGTH = 1000;

/**
 * Check if position is at a delimiter (supports multi-character delimiters).
 */
function isAtDelimiter(input: string, pos: number, delimiter: string): boolean {
  if (delimiter.length === 0) {
    return false;
  }
  if (delimiter.length === 1) {
    return input[pos] === delimiter;
  }
  return input.startsWith(delimiter, pos);
}

function fieldTerminatorPattern(delimiter: string): RegExp {
  let pattern = FIELD_TERMINATOR_PATTERNS.get(delimiter);
  if (pattern === undefined) {
    // The delimiter comes first so that it wins a tie, matching the precedence the
    // hand-rolled scan below applies when a delimiter is itself a line terminator.
    const escaped = delimiter.replace(REGEXP_METACHARACTERS, char => `\\${char}`);
    // Empty delimiter means there is no field separator at this level; the high-level
    // parser uses it to request auto-detection. Omitting it here avoids a zero-width first
    // alternative that would return the same position forever.
    pattern = new RegExp(escaped === "" ? "\\r\\n?|\\n" : `${escaped}|\\r\\n?|\\n`, "g");
    if (FIELD_TERMINATOR_PATTERNS.size >= MAX_FIELD_TERMINATOR_PATTERNS) {
      const oldest = FIELD_TERMINATOR_PATTERNS.keys().next().value;
      if (oldest !== undefined) {
        FIELD_TERMINATOR_PATTERNS.delete(oldest);
      }
    }
    FIELD_TERMINATOR_PATTERNS.set(delimiter, pattern);
  }
  return pattern;
}

/**
 * How far to scan for a field terminator character by character before handing the
 * rest to the regex engine.
 *
 * A field ends at the first delimiter or line terminator, so this is *one* search,
 * not one per candidate character — see the note on {@link scanUnquotedField} for
 * why searching per candidate was quadratic.
 *
 * Two mechanisms rather than one because they win in different places: a `charCodeAt`
 * loop costs nothing to start and wins on the short fields real CSV is made of. The regex
 * engine searches far faster once it is running but pays a match object per call, and wins
 * once fields reach several hundred characters.
 * Scanning a bounded prefix inline and falling back keeps the common case on the
 * loop and bounds the loss on a long field to that prefix. A limit of 16 was the
 * best of 16/32/64 at every field width tried.
 */
const INLINE_TERMINATOR_SCAN_LIMIT = 16;

/**
 * Find the next delimiter or line terminator at or after `start`.
 *
 * @returns Index of the terminator, or -1 if the rest of the input has none.
 */
function findFieldTerminator(input: string, start: number, delimiter: string): number {
  const len = input.length;
  const inlineEnd = Math.min(len, start + INLINE_TERMINATOR_SCAN_LIMIT);

  if (delimiter.length === 1) {
    const delimiterCode = delimiter.charCodeAt(0);
    for (let pos = start; pos < inlineEnd; pos++) {
      const code = input.charCodeAt(pos);
      if (code === delimiterCode || code === CHAR_LF || code === CHAR_CR) {
        return pos;
      }
    }
  } else {
    // Also covers the empty delimiter, whose `charCodeAt(0)` is NaN and so never matches:
    // with no field separator, only a line terminator ends a field.
    const firstCode = delimiter.charCodeAt(0);
    for (let pos = start; pos < inlineEnd; pos++) {
      const code = input.charCodeAt(pos);
      if (code === CHAR_LF || code === CHAR_CR) {
        return pos;
      }
      if (code === firstCode && input.startsWith(delimiter, pos)) {
        return pos;
      }
    }
  }

  if (inlineEnd === len) {
    return -1;
  }

  if (delimiter.length > MAX_PATTERN_DELIMITER_LENGTH) {
    // Too long to embed in a pattern. A delimiter that long cannot occur often, so scanning
    // for line terminators and confirming the delimiter at each candidate start costs little.
    for (let pos = inlineEnd; pos < len; pos++) {
      const code = input.charCodeAt(pos);
      if (code === CHAR_LF || code === CHAR_CR) {
        return pos;
      }
      if (code === delimiter.charCodeAt(0) && input.startsWith(delimiter, pos)) {
        return pos;
      }
    }
    return -1;
  }

  const pattern = fieldTerminatorPattern(delimiter);
  pattern.lastIndex = inlineEnd;
  const match = pattern.exec(input);
  return match === null ? -1 : match.index;
}

interface RecordBoundaryState {
  inQuotes: boolean;
  atFieldStart: boolean;
  delimiterPrefix: number;
  pendingQuote: boolean;
  quoteDelimiterPrefix: number;
  pendingEscape: boolean;
}

function createRecordBoundaryState(): RecordBoundaryState {
  return {
    inQuotes: false,
    atFieldStart: true,
    delimiterPrefix: 0,
    pendingQuote: false,
    quoteDelimiterPrefix: 0,
    pendingEscape: false
  };
}

/** Prefix table for streaming delimiter matching, including self-overlapping delimiters. */
function delimiterPrefixTable(delimiter: string): number[] {
  const table = new Array<number>(delimiter.length).fill(0);
  for (let i = 1, prefix = 0; i < delimiter.length; i++) {
    while (prefix > 0 && delimiter[i] !== delimiter[prefix]) {
      prefix = table[prefix - 1];
    }
    if (delimiter[i] === delimiter[prefix]) {
      prefix++;
    }
    table[i] = prefix;
  }
  return table;
}

/**
 * Incrementally find a row terminator outside quoted fields.
 *
 * This is deliberately a lexer, not a second CSV parser: it retains only enough state to
 * know whether CR/LF ends the record. It never produces a field or decides its value; once
 * it finds a possible boundary, {@link scanRow} reads the buffered row authoritatively.
 */
function recordBoundaryArrived(
  incoming: string,
  state: RecordBoundaryState,
  config: ScannerConfig,
  delimiterTable: number[]
): boolean {
  const { delimiter, quote, escape, quoteEnabled, relaxQuotes } = config;
  let chunk = incoming;
  let pos = 0;

  // A relaxed closing-quote candidate ended the previous chunk after matching part of a
  // multi-character delimiter. Try to finish it before treating those characters as quoted
  // content. On failure, prepend the already-consumed prefix and lex it once more inside the
  // field; it may itself contain a quote or escape and cannot simply be discarded.
  if (state.quoteDelimiterPrefix > 0) {
    const carried = state.quoteDelimiterPrefix;
    let matched = 0;
    while (
      matched < chunk.length &&
      carried + matched < delimiter.length &&
      chunk[matched] === delimiter[carried + matched]
    ) {
      matched++;
    }
    if (carried + matched === delimiter.length) {
      state.inQuotes = false;
      state.atFieldStart = true;
      state.quoteDelimiterPrefix = 0;
      pos = matched;
    } else if (matched === chunk.length) {
      state.quoteDelimiterPrefix += matched;
      return false;
    } else {
      chunk = delimiter.slice(0, carried) + chunk;
      state.quoteDelimiterPrefix = 0;
    }
  }

  while (pos < chunk.length) {
    const char = chunk[pos];

    if (state.inQuotes) {
      if (state.quoteDelimiterPrefix > 0) {
        if (char === delimiter[state.quoteDelimiterPrefix]) {
          state.quoteDelimiterPrefix++;
          pos++;
          if (state.quoteDelimiterPrefix === delimiter.length) {
            state.inQuotes = false;
            state.atFieldStart = true;
            state.quoteDelimiterPrefix = 0;
          }
          continue;
        }
        // The quote was literal; a failed delimiter candidate is quoted content.
        const replay = state.quoteDelimiterPrefix;
        state.pendingQuote = false;
        state.quoteDelimiterPrefix = 0;
        pos -= replay;
        continue;
      }

      if (state.pendingEscape) {
        state.pendingEscape = false;
        if (char === quote || char === escape) {
          pos++;
          continue;
        }
        // Literal escape; inspect this character normally.
      }

      if (state.pendingQuote) {
        state.pendingQuote = false;
        if (escape === quote && char === quote) {
          pos++;
          continue;
        }
        if (!relaxQuotes) {
          state.inQuotes = false;
          state.atFieldStart = false;
          continue; // Reprocess the character outside the field.
        }
        if (char === "\n" || char === "\r") {
          return true;
        }
        if (delimiter !== "" && char === delimiter[0]) {
          if (delimiter.length === 1) {
            state.inQuotes = false;
            state.atFieldStart = true;
          } else {
            state.quoteDelimiterPrefix = 1;
          }
          pos++;
          continue;
        }
        // Relaxed quote is content; inspect this character inside the field.
      }

      if (escape !== quote && char === escape) {
        state.pendingEscape = true;
        pos++;
        continue;
      }
      if (char === quote) {
        state.pendingQuote = true;
      }
      pos++;
      continue;
    }

    if (char === "\n" || char === "\r") {
      return true;
    }
    if (state.atFieldStart && quoteEnabled && char === quote) {
      state.inQuotes = true;
      state.atFieldStart = false;
      state.delimiterPrefix = 0;
      pos++;
      continue;
    }

    if (delimiter !== "") {
      let prefix = state.delimiterPrefix;
      while (prefix > 0 && char !== delimiter[prefix]) {
        prefix = delimiterTable[prefix - 1];
      }
      if (char === delimiter[prefix]) {
        prefix++;
      }
      if (prefix === delimiter.length) {
        state.atFieldStart = true;
        state.delimiterPrefix = 0;
        pos++;
        continue;
      }
      state.delimiterPrefix = prefix;
    }

    state.atFieldStart = false;
    pos++;
  }

  return false;
}

// =============================================================================
// Quoted Field Scanning
// =============================================================================

/**
 * Scan a quoted field starting at the opening quote.
 *
 * Handles:
 * - Escaped quotes (RFC 4180: "" -> ")
 * - Backslash escapes when escape !== quote
 * - CRLF normalization inside quoted fields (CRLF -> LF)
 * - relaxQuotes mode (allow unescaped quotes mid-field)
 *
 * Performance optimization: Uses array to collect segments instead of
 * string concatenation to avoid O(n²) string building in fields with
 * many escaped quotes or embedded newlines.
 *
 * @param input - Input string
 * @param start - Position of opening quote
 * @param config - Scanner configuration
 * @param isEof - Whether this is the end of input
 * @returns Field scan result
 */
export function scanQuotedField(
  input: string,
  start: number,
  config: ScannerConfig,
  isEof: boolean
): FieldScanResult {
  const { quote, escape, delimiter, relaxQuotes } = config;
  const len = input.length;

  // Skip opening quote
  let pos = start + 1;
  // Lazy-initialized array for collecting segments when escaped quotes or CR normalization occur.
  // null means no segments yet (common fast path: no escaping needed).
  let segments: string[] | null = null;
  let segmentStart = pos;

  // Helper to build final value from segments
  const buildValue = (endPos: number): string => {
    const lastSegment = endPos > segmentStart ? input.slice(segmentStart, endPos) : "";
    if (segments === null) {
      return lastSegment;
    }
    if (lastSegment) {
      segments.push(lastSegment);
    }
    return segments.length === 1 ? segments[0] : segments.join("");
  };

  while (pos < len) {
    const char = input[pos];

    // Check for escape sequence
    if (escape && char === escape) {
      // Look ahead for escaped quote
      if (pos + 1 < len && input[pos + 1] === quote) {
        // Escaped quote: add segment up to escape, then add the quote char
        if (pos > segmentStart) {
          (segments ??= []).push(input.slice(segmentStart, pos));
        }
        (segments ??= []).push(quote);
        pos += 2; // Skip escape + quote
        segmentStart = pos;
        continue;
      }

      // Handle escape + escape (e.g., \\ → \) when escape !== quote
      if (escape !== quote && pos + 1 < len && input[pos + 1] === escape) {
        // Escaped escape: add segment up to first escape, then add one escape char
        if (pos > segmentStart) {
          (segments ??= []).push(input.slice(segmentStart, pos));
        }
        (segments ??= []).push(escape);
        pos += 2; // Skip escape + escape
        segmentStart = pos;
        continue;
      }

      // If escape === quote, this might be the closing quote
      if (escape === quote) {
        // Check what follows
        if (pos + 1 >= len) {
          // At buffer boundary - need more data
          if (!isEof) {
            return {
              value: buildValue(pos),
              quoted: true,
              endPos: pos,
              needMore: true,
              resumePos: start // Resume from the opening quote
            };
          }
          // At EOF with quote at end - treat as closing quote
          return {
            value: buildValue(pos),
            quoted: true,
            endPos: pos + 1, // After closing quote
            needMore: false
          };
        }

        const nextChar = input[pos + 1];

        // Check if this is a closing quote (followed by delimiter, newline, or EOF)
        if (
          (delimiter.length === 1
            ? nextChar === delimiter
            : isAtDelimiter(input, pos + 1, delimiter)) ||
          nextChar === "\n" ||
          nextChar === "\r"
        ) {
          // Closing quote - add segment and return
          return {
            value: buildValue(pos),
            quoted: true,
            endPos: pos + 1, // Position after the closing quote
            needMore: false
          };
        }

        // relaxQuotes: treat mid-field quote as literal (preserve the quote character)
        if (relaxQuotes) {
          if (pos > segmentStart) {
            (segments ??= []).push(input.slice(segmentStart, pos));
          }
          (segments ??= []).push(quote);
          pos++;
          segmentStart = pos;
          continue;
        }

        // Strict mode: this is a closing quote, anything after is an error
        // but we'll let the caller handle malformed data
        return {
          value: buildValue(pos),
          quoted: true,
          endPos: pos + 1,
          needMore: false
        };
      }
    }

    // Check for closing quote (when escape !== quote)
    if (char === quote && escape !== quote) {
      // Look ahead
      if (pos + 1 >= len) {
        if (!isEof) {
          return {
            value: buildValue(pos),
            quoted: true,
            endPos: pos,
            needMore: true,
            resumePos: start
          };
        }
        // EOF: closing quote
        return {
          value: buildValue(pos),
          quoted: true,
          endPos: pos + 1,
          needMore: false
        };
      }

      const nextChar = input[pos + 1];
      if (
        (delimiter.length === 1
          ? nextChar === delimiter
          : isAtDelimiter(input, pos + 1, delimiter)) ||
        nextChar === "\n" ||
        nextChar === "\r"
      ) {
        return {
          value: buildValue(pos),
          quoted: true,
          endPos: pos + 1,
          needMore: false
        };
      }

      // relaxQuotes: treat mid-field quote as literal (preserve the quote character)
      if (relaxQuotes) {
        if (pos > segmentStart) {
          (segments ??= []).push(input.slice(segmentStart, pos));
        }
        (segments ??= []).push(quote);
        pos++;
        segmentStart = pos;
        continue;
      }

      // Closing quote with trailing garbage
      return {
        value: buildValue(pos),
        quoted: true,
        endPos: pos + 1,
        needMore: false
      };
    }

    // ==========================================================================
    // CR/CRLF Handling in Quoted Fields
    // ==========================================================================
    // RFC 4180 allows CRLF within quoted fields, and different platforms may use
    // different line endings (LF on Unix, CRLF on Windows, CR on old Mac).
    //
    // Our normalization strategy:
    // 1. CRLF (\r\n) -> LF (\n)  - Windows line ending normalized to Unix
    // 2. CR (\r) alone -> LF (\n) - Old Mac line ending normalized to Unix
    // 3. LF (\n) alone -> kept as-is
    //
    // This ensures consistent output regardless of input line ending style,
    // matching the behavior of most modern CSV libraries.
    // ==========================================================================
    if (char === "\r") {
      if (pos + 1 < len) {
        if (input[pos + 1] === "\n") {
          // CRLF -> LF
          if (pos > segmentStart) {
            (segments ??= []).push(input.slice(segmentStart, pos));
          }
          (segments ??= []).push("\n");
          pos += 2;
          segmentStart = pos;
          continue;
        }
        // Standalone CR -> LF
        if (pos > segmentStart) {
          (segments ??= []).push(input.slice(segmentStart, pos));
        }
        (segments ??= []).push("\n");
        pos++;
        segmentStart = pos;
        continue;
      }
      // CR at buffer end - need more data to determine CRLF
      if (!isEof) {
        return {
          value: buildValue(pos),
          quoted: true,
          endPos: pos,
          needMore: true,
          resumePos: start
        };
      }
      // EOF: treat as LF
      if (pos > segmentStart) {
        (segments ??= []).push(input.slice(segmentStart, pos));
      }
      (segments ??= []).push("\n");
      pos++;
      segmentStart = pos;
      continue;
    }

    pos++;
  }

  // Reached end of input while inside quoted field
  if (!isEof) {
    return {
      value: buildValue(pos),
      quoted: true,
      endPos: pos,
      needMore: true,
      resumePos: start
    };
  }

  // EOF with unterminated quote - return what we have
  return {
    value: buildValue(pos),
    quoted: true,
    endPos: pos,
    needMore: false,
    unterminated: true // Mark as unterminated quote
  };
}

// =============================================================================
// Unquoted Field Scanning
// =============================================================================

/**
 * Scan an unquoted field.
 *
 * This is the performance-critical path for most CSV files: a field ends at the
 * first delimiter or line terminator, so one search for "whichever comes first"
 * settles it.
 *
 * Searching per candidate instead — `indexOf(delimiter)`, `indexOf("\n")` and
 * `indexOf("\r")`, then taking the minimum — is what this replaced, and it was
 * quadratic. A character the input does not contain has no match to stop at, so
 * its search walks to the end of the input before returning -1, and *every field*
 * pays that walk: O(fields x bytes). An LF-only file (Unix, LibreOffice, anything
 * script-generated) has no "\r", so it paid it on the newline search; a
 * single-column file, or any file whose remaining rows hold no delimiter, paid it
 * on the delimiter search. LF-only files were orders of magnitude slower than the
 * same data with CRLF endings — CRLF being the one case where both characters are
 * always a few bytes away. `lineEnding` could not help: this scan
 * never consulted it.
 *
 * @param input - Input string
 * @param start - Starting position
 * @param config - Scanner configuration
 * @param isEof - Whether this is the end of input
 * @returns Field scan result
 */
export function scanUnquotedField(
  input: string,
  start: number,
  config: ScannerConfig,
  isEof: boolean
): FieldScanResult {
  const { delimiter } = config;
  const len = input.length;

  const endPos = findFieldTerminator(input, start, delimiter);

  // No delimiter and no newline - field extends to end of input
  if (endPos === -1) {
    return {
      value: input.slice(start),
      quoted: false,
      endPos: len,
      needMore: !isEof,
      resumePos: isEof ? undefined : start
    };
  }

  // A CR with nothing after it may yet turn out to be a CRLF, so the row ending
  // cannot be classified until the next chunk arrives.
  if (!isEof && endPos + 1 >= len && input.charCodeAt(endPos) === CHAR_CR) {
    return {
      value: input.slice(start, endPos),
      quoted: false,
      endPos,
      needMore: true,
      resumePos: start
    };
  }

  return {
    value: input.slice(start, endPos),
    quoted: false,
    endPos,
    needMore: false
  };
}

// =============================================================================
// Row Scanning
// =============================================================================

/**
 * Scan a complete row from the input string.
 *
 * @param input - Input string
 * @param start - Starting position
 * @param config - Scanner configuration
 * @param isEof - Whether this is the end of input
 * @param outFields - Optional reusable array for fields (will be cleared)
 * @param outQuoted - Optional reusable array for quoted flags (will be cleared)
 * @returns Row scan result with rawStart/rawEnd for zero-copy raw row extraction
 */
export function scanRow(
  input: string,
  start: number,
  config: ScannerConfig,
  isEof: boolean,
  outFields?: string[],
  outQuoted?: boolean[]
): RowScanResult {
  const { delimiter, quote, quoteEnabled } = config;
  const delimLen = delimiter.length;
  const len = input.length;

  // Reuse provided arrays or create new ones
  const fields: string[] = outFields ?? [];
  const quoted: boolean[] = outQuoted ?? [];

  // Clear arrays if reusing
  if (outFields) {
    outFields.length = 0;
  }
  if (outQuoted) {
    outQuoted.length = 0;
  }

  let pos = start;
  let hasUnterminatedQuote = false;

  // Track raw row boundaries for zero-copy extraction
  const rawStart = start;

  while (pos < len) {
    const char = input[pos];

    // Check for quoted field
    if (quoteEnabled && char === quote) {
      const result = scanQuotedField(input, pos, config, isEof);

      if (result.needMore) {
        return {
          fields,
          quoted,
          endPos: pos,
          complete: false,
          needMore: true,
          resumePos: result.resumePos ?? start,
          rawStart,
          rawEnd: pos
        };
      }

      // Track unterminated quote
      if (result.unterminated) {
        hasUnterminatedQuote = true;
      }

      fields.push(result.value);
      quoted.push(true);
      pos = result.endPos;

      // After closing quote, expect delimiter or newline
      if (pos < len) {
        if (isAtDelimiter(input, pos, delimiter)) {
          pos += delimLen;
          // Check if delimiter is at end of input - need to add trailing empty field
          if (pos >= len && isEof) {
            fields.push("");
            quoted.push(false);
          }
          continue;
        }

        // Check for newline
        const nextChar = input[pos];
        if (nextChar === "\n") {
          return {
            fields,
            quoted,
            endPos: pos + 1,
            complete: true,
            needMore: false,
            newline: "\n",
            rawStart,
            rawEnd: pos
          };
        }
        if (nextChar === "\r") {
          if (pos + 1 < len) {
            if (input[pos + 1] === "\n") {
              return {
                fields,
                quoted,
                endPos: pos + 2,
                complete: true,
                needMore: false,
                newline: "\r\n",
                rawStart,
                rawEnd: pos
              };
            }
            return {
              fields,
              quoted,
              endPos: pos + 1,
              complete: true,
              needMore: false,
              newline: "\r",
              rawStart,
              rawEnd: pos
            };
          }
          // CR at buffer end
          if (!isEof) {
            return {
              fields,
              quoted,
              endPos: pos,
              complete: false,
              needMore: true,
              resumePos: start,
              rawStart,
              rawEnd: pos
            };
          }
          return {
            fields,
            quoted,
            endPos: pos + 1,
            complete: true,
            needMore: false,
            newline: "\r",
            rawStart,
            rawEnd: pos
          };
        }

        // Unexpected character after closing quote - skip it (lenient parsing)
        // This handles cases like: "value"garbage,next
        // We could also throw an error here for strict mode
        pos++;
        // Find next delimiter or newline
        while (pos < len) {
          if (isAtDelimiter(input, pos, delimiter)) {
            pos += delimLen;
            break;
          }
          if (input[pos] === "\n" || input[pos] === "\r") {
            break;
          }
          pos++;
        }
        continue;
      }

      // End of input after closing quote
      continue;
    }

    // Unquoted field
    const result = scanUnquotedField(input, pos, config, isEof);

    if (result.needMore) {
      // Save partial progress
      fields.push(result.value);
      quoted.push(false);
      return {
        fields,
        quoted,
        endPos: result.endPos,
        complete: false,
        needMore: true,
        resumePos: result.resumePos ?? start,
        rawStart,
        rawEnd: result.endPos
      };
    }

    fields.push(result.value);
    quoted.push(false);
    pos = result.endPos;

    // Check what ended the field
    if (pos < len) {
      if (isAtDelimiter(input, pos, delimiter)) {
        pos += delimLen;
        // Check if delimiter is at end of input - need to add trailing empty field
        if (pos >= len && isEof) {
          fields.push("");
          quoted.push(false);
        }
        continue;
      }

      // Must be a newline
      const char = input[pos];
      if (char === "\n") {
        return {
          fields,
          quoted,
          endPos: pos + 1,
          complete: true,
          needMore: false,
          newline: "\n",
          rawStart,
          rawEnd: pos
        };
      }
      if (char === "\r") {
        if (pos + 1 < len && input[pos + 1] === "\n") {
          return {
            fields,
            quoted,
            endPos: pos + 2,
            complete: true,
            needMore: false,
            newline: "\r\n",
            rawStart,
            rawEnd: pos
          };
        }
        // Standalone CR or at buffer end handled in scanUnquotedField
        return {
          fields,
          quoted,
          endPos: pos + 1,
          complete: true,
          needMore: false,
          newline: "\r",
          rawStart,
          rawEnd: pos
        };
      }
    }
  }

  // Reached end of input
  if (isEof) {
    // At EOF, if we have any fields, it's a complete row
    if (fields.length > 0 || pos > start) {
      return {
        fields,
        quoted,
        endPos: pos,
        complete: true,
        needMore: false,
        unterminatedQuote: hasUnterminatedQuote || undefined,
        rawStart,
        rawEnd: pos
      };
    }
  }

  // Not at EOF and no newline found
  return {
    fields,
    quoted,
    endPos: pos,
    complete: false,
    needMore: !isEof,
    resumePos: start,
    unterminatedQuote: hasUnterminatedQuote || undefined,
    rawStart,
    rawEnd: pos
  };
}

// =============================================================================
// Scanner Factory
// =============================================================================

/**
 * Create a new CSV scanner with the given configuration.
 *
 * @param config - Partial scanner configuration (defaults applied)
 * @returns Scanner instance
 *
 * @example Basic usage
 * ```ts
 * const scanner = createScanner({ delimiter: "," });
 * const result = scanner.scanRow('a,b,c\n');
 * console.log(result.fields); // ["a", "b", "c"]
 * ```
 *
 * @example Streaming usage
 * ```ts
 * const scanner = createScanner({ delimiter: "\t" });
 *
 * // Process chunks as they arrive
 * scanner.feed("name\tage\n");
 * scanner.feed("Alice\t30\n");
 *
 * let row;
 * while ((row = scanner.nextRow()) !== null) {
 *   console.log(row.fields);
 * }
 * ```
 */
export function createScanner(config?: Partial<ScannerConfig>): Scanner {
  // Waiting state caches facts derived from the configuration across feed() calls, so
  // mutating the exposed config mid-row would invalidate that state. Freeze it both in the
  // type and at runtime rather than presenting `readonly config` whose members remain mutable.
  const resolvedConfig: ScannerConfig = Object.freeze({
    ...DEFAULT_SCANNER_CONFIG,
    ...config
  });

  let state = createScannerState();

  const boundaryState = createRecordBoundaryState();
  const delimiterTable = delimiterPrefixTable(resolvedConfig.delimiter);

  // Whether the last nextRow() came up short for want of data. While set, only the small
  // boundary lexer runs on arriving chunks; the buffered row is left untouched.
  let awaitingMore = false;

  // Whether that lexer has found a record-ending CR/LF outside quoted fields.
  let wakeArrived = false;

  // Whether the last character fed was a CR, which is the one form of incomplete row
  // that the next character resolves whatever it is. Recorded here because reading the
  // buffer's last character would flatten it — see feed().
  let lastFedCharIsCR = false;

  // Reusable arrays for streaming mode (S3 optimization)
  // Safe to reuse because:
  // - fields: CsvParserStream always uses .map() which creates new array
  // - quoted: buildRecordInfo copies the array before exposing to user
  const reuseFields: string[] = [];
  const reuseQuoted: boolean[] = [];

  return {
    get config() {
      return resolvedConfig;
    },

    scanRow(input: string, offset = 0, isEof = false): RowScanResult {
      // Sync mode: don't reuse arrays (caller may store results)
      return scanRow(input, offset, resolvedConfig, isEof);
    },

    feed(chunk: string): void {
      if (chunk.length === 0) {
        return;
      }

      // While a row is stalled, look for what it is waiting for in the *arriving chunk* and
      // never in the buffer. `state.buffer += chunk` only builds a rope, which is free, but
      // any string operation on that rope flattens it — copying every byte buffered so far,
      // once per chunk, which is O(bytes^2/chunk) and dwarfs the linear cost of searching
      // the pieces themselves.
      //
      // The small recognizers behind wakesOn carry any quote, escape or delimiter prefix that
      // can straddle this boundary.
      if (
        awaitingMore &&
        !wakeArrived &&
        recordBoundaryArrived(chunk, boundaryState, resolvedConfig, delimiterTable)
      ) {
        wakeArrived = true;
      }
      lastFedCharIsCR = chunk.charCodeAt(chunk.length - 1) === CHAR_CR;

      state.buffer += chunk;
    },

    nextRow(): RowScanResult | null {
      // Checked before the buffer is touched at all, so that waiting costs nothing.
      if (awaitingMore && !wakeArrived) {
        return null;
      }

      if (state.position >= state.buffer.length) {
        return null;
      }

      awaitingMore = false;
      wakeArrived = false;

      // Streaming mode: reuse arrays for reduced allocations
      const result = scanRow(
        state.buffer,
        state.position,
        resolvedConfig,
        false,
        reuseFields,
        reuseQuoted
      );

      if (result.needMore) {
        // Not enough data for a complete row. A row can only complete in streaming mode by
        // reaching a row terminator — `complete` at end of input is reached through flush(),
        // which passes isEof — so re-running this scan before the missing piece arrives only
        // re-parses the same fields, and a row longer than a chunk cost O(chunks x rowBytes)
        // that way.
        //
        // Which piece is missing matters. An unclosed quoted field is waiting for its quote,
        // and the newlines such a field commonly holds are not row terminators: waiting on a
        // terminator instead would wake this scan on every chunk and re-read the field from
        // its opening quote, which is the same quadratic by another route.
        //
        // The exception to both is a trailing CR: whether it is a lone CR or half a CRLF is
        // decided by the very next character, whatever that is, so there is nothing to wait
        // for.
        awaitingMore = !lastFedCharIsCR;
        if (awaitingMore) {
          Object.assign(boundaryState, createRecordBoundaryState());
          recordBoundaryArrived(
            state.buffer.slice(state.position),
            boundaryState,
            resolvedConfig,
            delimiterTable
          );
        }
        return null;
      }

      if (result.complete) {
        // Extract raw row BEFORE potentially compacting the buffer
        // This enables zero-copy raw row extraction in streaming mode
        result.raw = state.buffer.slice(result.rawStart, result.rawEnd);

        state.position = result.endPos;

        // Compact buffer when:
        // 1. We've consumed more than 64KB of data, OR
        // 2. We've consumed more than 50% of the buffer (prevents unbounded growth)
        const consumedBytes = state.position;
        const bufferLength = state.buffer.length;
        if (consumedBytes > 65536 || (consumedBytes > bufferLength / 2 && consumedBytes > 4096)) {
          state.buffer = state.buffer.slice(state.position);
          state.position = 0;
        }

        return result;
      }

      // Incomplete row without needMore - shouldn't happen in streaming
      return null;
    },

    flush(): RowScanResult | null {
      if (state.position >= state.buffer.length) {
        return null;
      }

      // At EOF, scan remaining data as complete (reuse arrays)
      const result = scanRow(
        state.buffer,
        state.position,
        resolvedConfig,
        true,
        reuseFields,
        reuseQuoted
      );

      if (result.fields.length === 0 && result.endPos === state.position) {
        return null;
      }

      // Extract raw row for streaming mode
      result.raw = state.buffer.slice(result.rawStart, result.rawEnd);

      state.position = result.endPos;
      return result;
    },

    reset(): void {
      state = createScannerState();
      awaitingMore = false;
      wakeArrived = false;
      lastFedCharIsCR = false;
      Object.assign(boundaryState, createRecordBoundaryState());
      // Clear reusable arrays
      reuseFields.length = 0;
      reuseQuoted.length = 0;
    },

    getBuffer(): string {
      return state.buffer.slice(state.position);
    }
  };
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Scan all rows from a complete input string.
 *
 * This is a convenience function for parsing complete CSV data in one call.
 * For large files or streaming data, use the Scanner interface instead.
 *
 * @param input - Complete CSV input string
 * @param config - Scanner configuration
 * @returns Array of row scan results
 *
 * @example
 * ```ts
 * const rows = scanAllRows('a,b,c\n1,2,3\n', { delimiter: ',' });
 * // rows = [
 * //   { fields: ['a', 'b', 'c'], quoted: [false, false, false], ... },
 * //   { fields: ['1', '2', '3'], quoted: [false, false, false], ... }
 * // ]
 * ```
 */
export function scanAllRows(input: string, config?: Partial<ScannerConfig>): RowScanResult[] {
  const resolvedConfig: ScannerConfig = {
    ...DEFAULT_SCANNER_CONFIG,
    ...config
  };

  const results: RowScanResult[] = [];
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    const result = scanRow(input, pos, resolvedConfig, true);

    if (result.fields.length > 0 || result.endPos > pos) {
      results.push(result);
    }

    if (result.endPos <= pos) {
      // Safety: prevent infinite loop
      break;
    }

    pos = result.endPos;
  }

  return results;
}

/**
 * Create an async iterator for scanning rows from chunks.
 *
 * @param chunks - Async iterable of string chunks
 * @param config - Scanner configuration
 * @returns Async iterator of row scan results
 *
 * @example
 * ```ts
 * const chunks = (async function*() {
 *   yield 'a,b,c\n';
 *   yield '1,2,3\n';
 * })();
 *
 * for await (const row of scanRowsAsync(chunks, { delimiter: ',' })) {
 *   console.log(row.fields);
 * }
 * ```
 */
export async function* scanRowsAsync(
  chunks: AsyncIterable<string>,
  config?: Partial<ScannerConfig>
): AsyncGenerator<RowScanResult, void, undefined> {
  const scanner = createScanner(config);

  for await (const chunk of chunks) {
    scanner.feed(chunk);

    let row: RowScanResult | null;
    while ((row = scanner.nextRow()) !== null) {
      yield row;
    }
  }

  // Flush remaining data
  const lastRow = scanner.flush();
  if (lastRow !== null) {
    yield lastRow;
  }
}
