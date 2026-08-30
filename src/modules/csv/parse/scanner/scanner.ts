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

/**
 * Matches the next line terminator: CRLF, lone CR, or LF. Global so `exec`
 * resumes from `lastIndex` and returns the first terminator after it.
 *
 * One combined search is what keeps field scanning linear. Two separate
 * `indexOf("\n")` / `indexOf("\r")` calls look equivalent, but each call scans to
 * the end of the input when its character is absent — and every field of an
 * LF-only file (or a CR-only file) pays that full scan, so parsing became
 * O(fields × bytes): ~40 s for a 6.5 MB, 50 000-row LF file that takes ~60 ms
 * with CRLF endings.
 */
const NEWLINE_PATTERN = /\r\n?|\n/g;

/**
 * Find the next newline position and determine its type.
 *
 * @returns [position, length] where length is 1 for \n/\r, 2 for \r\n, or [-1, 0] if not found
 */
function findNewline(input: string, start: number): [number, number] {
  NEWLINE_PATTERN.lastIndex = start;
  const match = NEWLINE_PATTERN.exec(input);

  // Neither found
  if (match === null) {
    return [-1, 0];
  }

  const pos = match.index;
  const terminator = match[0];

  if (terminator === "\n") {
    return [pos, 1];
  }

  if (terminator === "\r\n") {
    return [pos, 2];
  }

  // Lone CR with more input after it
  if (pos + 1 < input.length) {
    return [pos, 1];
  }

  // CR at end of buffer - might be CRLF, need more data
  return [pos, -1]; // -1 signals "maybe CRLF"
}

/**
 * Check if position is at a delimiter (supports multi-character delimiters).
 */
function isAtDelimiter(input: string, pos: number, delimiter: string): boolean {
  if (delimiter.length === 1) {
    return input[pos] === delimiter;
  }
  return input.startsWith(delimiter, pos);
}

/**
 * Find the next delimiter position (supports multi-character delimiters).
 */
function findDelimiter(input: string, start: number, delimiter: string): number {
  return input.indexOf(delimiter, start);
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
 * Scan an unquoted field using indexOf for batch searching.
 *
 * This is the performance-critical path for most CSV files.
 * Uses indexOf to find the next delimiter or newline in O(n) time
 * with optimized native string search.
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

  // Find next delimiter
  const delimPos = findDelimiter(input, start, delimiter);

  // Find next newline
  const [newlinePos, newlineLen] = findNewline(input, start);

  // Determine which comes first
  let endPos: number;
  let atNewline = false;

  if (delimPos === -1 && newlinePos === -1) {
    // Neither found - field extends to end of input
    if (!isEof) {
      return {
        value: input.slice(start),
        quoted: false,
        endPos: len,
        needMore: true,
        resumePos: start
      };
    }
    // EOF: field is rest of input
    return {
      value: input.slice(start),
      quoted: false,
      endPos: len,
      needMore: false
    };
  }

  if (delimPos === -1) {
    // Only newline found
    endPos = newlinePos;
    atNewline = true;
  } else if (newlinePos === -1) {
    // Only delimiter found
    endPos = delimPos;
  } else if (delimPos < newlinePos) {
    // Delimiter comes first
    endPos = delimPos;
  } else {
    // Newline comes first
    endPos = newlinePos;
    atNewline = true;
  }

  // Check for ambiguous CR at buffer boundary
  if (atNewline && newlineLen === -1 && !isEof) {
    // CR at end of buffer, might be CRLF
    return {
      value: input.slice(start, endPos),
      quoted: false,
      endPos,
      needMore: true,
      resumePos: start
    };
  }

  const value = input.slice(start, endPos);

  return {
    value,
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
  const resolvedConfig: ScannerConfig = {
    ...DEFAULT_SCANNER_CONFIG,
    ...config
  };

  let state = createScannerState();

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
      // Append to buffer, adjusting position if needed
      state.buffer += chunk;
    },

    nextRow(): RowScanResult | null {
      if (state.position >= state.buffer.length) {
        return null;
      }

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
        // Not enough data for a complete row
        // Keep buffer intact, will get more data from feed()
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
