/**
 * CSV Scanner Tests
 *
 * Tests the high-performance field scanner and parseWithScanner function.
 * Consolidated from scanner.test.ts and scanner-integration.test.ts.
 *
 * Coverage:
 * - Basic field parsing (quoted and unquoted)
 * - Multi-character delimiters
 * - Escape sequences (RFC 4180)
 * - Newline handling (LF, CR, CRLF)
 * - Streaming with chunk boundaries
 * - Low-level scanner functions
 * - parseWithScanner integration
 */

import { createParseConfig } from "@csv/parse/config";
import type { RowProcessResult } from "@csv/parse/row-processor";
import {
  createScanner,
  scanAllRows,
  scanRowsAsync,
  scanRow,
  scanQuotedField,
  scanUnquotedField,
  DEFAULT_SCANNER_CONFIG
} from "@csv/parse/scanner";
import type { ScannerConfig, RowScanResult } from "@csv/parse/scanner";
import { createParseState } from "@csv/parse/state";
import { parseWithScanner } from "@csv/parse/sync";
import type { CsvParseOptions, CsvRecordError } from "@csv/types";
import { describe, it, expect } from "vitest";

// =============================================================================
// Test Helpers
// =============================================================================

function parseWithScanner_(
  input: string,
  options: CsvParseOptions = {}
): { results: RowProcessResult[]; errors: CsvRecordError[] } {
  const { config, processedInput } = createParseConfig({ input, options });
  const state = createParseState(config);
  const errors: CsvRecordError[] = [];
  const results = [...parseWithScanner(processedInput!, config, state, errors)];
  return { results, errors };
}

function expectRow(input: string, options: CsvParseOptions, expectedRows: string[][]): void {
  const { results } = parseWithScanner_(input, options);
  const actualRows = results.filter(r => !r.skipped && r.row).map(r => r.row);
  expect(actualRows).toEqual(expectedRows);
}

// =============================================================================
// Scanner - Basic Parsing
// =============================================================================

describe("Scanner - Basic Parsing", () => {
  it("should parse simple unquoted fields", () => {
    const rows = scanAllRows("a,b,c\n");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
    expect(rows[0].quoted).toEqual([false, false, false]);
  });

  it("should parse multiple rows", () => {
    const rows = scanAllRows("a,b,c\n1,2,3\nx,y,z\n");
    expect(rows).toHaveLength(3);
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
    expect(rows[1].fields).toEqual(["1", "2", "3"]);
    expect(rows[2].fields).toEqual(["x", "y", "z"]);
  });

  it("should parse row without trailing newline", () => {
    const rows = scanAllRows("a,b,c");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
    expect(rows[0].complete).toBe(true);
  });

  it("should parse empty fields", () => {
    const rows = scanAllRows(",b,\n");
    expect(rows[0].fields).toEqual(["", "b", ""]);
  });

  it("should parse single field", () => {
    const rows = scanAllRows("hello\n");
    expect(rows[0].fields).toEqual(["hello"]);
  });

  it("should handle empty input", () => {
    const rows = scanAllRows("");
    expect(rows).toHaveLength(0);
  });

  it("should parse empty row as single empty field", () => {
    const rows = scanAllRows("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual([""]);
  });
});

// =============================================================================
// Scanner - Quoted Fields
// =============================================================================

describe("Scanner - Quoted Fields", () => {
  it("should parse simple quoted field", () => {
    const rows = scanAllRows('"hello",world\n');
    expect(rows[0].fields).toEqual(["hello", "world"]);
    expect(rows[0].quoted).toEqual([true, false]);
  });

  it("should parse quoted field with delimiter inside", () => {
    const rows = scanAllRows('"a,b",c\n');
    expect(rows[0].fields).toEqual(["a,b", "c"]);
  });

  it("should parse quoted field with newline inside", () => {
    const rows = scanAllRows('"line1\nline2",b\n');
    expect(rows[0].fields).toEqual(["line1\nline2", "b"]);
  });

  it("should parse quoted field with CRLF inside (normalized to LF)", () => {
    const rows = scanAllRows('"line1\r\nline2",b\n');
    expect(rows[0].fields).toEqual(["line1\nline2", "b"]);
  });

  it('should handle escaped quotes (RFC 4180: "")', () => {
    const rows = scanAllRows('"say ""hello""",b\n');
    expect(rows[0].fields).toEqual(['say "hello"', "b"]);
  });

  it("should handle empty quoted field", () => {
    const rows = scanAllRows('"",b\n');
    expect(rows[0].fields).toEqual(["", "b"]);
  });

  it("should handle adjacent quoted fields", () => {
    const rows = scanAllRows('"a","b","c"\n');
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
    expect(rows[0].quoted).toEqual([true, true, true]);
  });

  it("should handle quoted field with only quotes", () => {
    const rows = scanAllRows('""""\n');
    expect(rows[0].fields).toEqual(['"']);
  });

  it("should handle consecutive escaped quotes", () => {
    const rows = scanAllRows('"a""""b"\n');
    expect(rows[0].fields).toEqual(['a""b']);
  });

  it("should handle field ending with escaped quote", () => {
    const rows = scanAllRows('"test"""\n');
    expect(rows[0].fields).toEqual(['test"']);
  });
});

// =============================================================================
// Scanner - Multi-character Delimiters
// =============================================================================

describe("Scanner - Multi-character Delimiters", () => {
  it("should parse with || delimiter", () => {
    const rows = scanAllRows("a||b||c\n", { delimiter: "||" });
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
  });

  it("should parse with tab-tab delimiter", () => {
    const rows = scanAllRows("a\t\tb\t\tc\n", { delimiter: "\t\t" });
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
  });

  it("should parse quoted field with multi-char delimiter inside", () => {
    const rows = scanAllRows('"a||b"||c\n', { delimiter: "||" });
    expect(rows[0].fields).toEqual(["a||b", "c"]);
  });

  it("should not confuse partial delimiter match", () => {
    const rows = scanAllRows("a|b||c\n", { delimiter: "||" });
    expect(rows[0].fields).toEqual(["a|b", "c"]);
  });
});

// =============================================================================
// Scanner - Newline Handling
// =============================================================================

describe("Scanner - Newline Handling", () => {
  it("should handle LF line endings", () => {
    const rows = scanAllRows("a,b\nc,d\n");
    expect(rows).toHaveLength(2);
    expect(rows[0].newline).toBe("\n");
  });

  it("should handle CRLF line endings", () => {
    const rows = scanAllRows("a,b\r\nc,d\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[0].newline).toBe("\r\n");
    expect(rows[1].newline).toBe("\r\n");
  });

  it("should handle CR line endings", () => {
    const rows = scanAllRows("a,b\rc,d\r");
    expect(rows).toHaveLength(2);
    expect(rows[0].newline).toBe("\r");
  });

  it("should handle mixed line endings", () => {
    const rows = scanAllRows("a,b\nc,d\r\ne,f\r");
    expect(rows).toHaveLength(3);
    expect(rows[0].newline).toBe("\n");
    expect(rows[1].newline).toBe("\r\n");
    expect(rows[2].newline).toBe("\r");
  });
  // A large input is the case that reaches the regex hand-off for every field, and the one
  // where a per-candidate search used to go quadratic. Whichever terminator a file uses, the
  // fields must come out identical and each row must report the terminator it actually had.
  it("scans large LF-only and CR-only inputs to the same fields as CRLF", () => {
    const rowCount = 5000;
    const body = Array.from(
      { length: rowCount },
      (_, i) => `r${i},alpha,beta,gamma,${i * 7},"quoted, field",delta`
    );

    const lf = scanAllRows(`${body.join("\n")}\n`);
    const cr = scanAllRows(`${body.join("\r")}\r`);
    const crlf = scanAllRows(`${body.join("\r\n")}\r\n`);

    expect(lf).toHaveLength(rowCount);
    expect(cr.map(row => row.fields)).toEqual(lf.map(row => row.fields));
    expect(crlf.map(row => row.fields)).toEqual(lf.map(row => row.fields));
    expect(new Set(lf.map(row => row.newline))).toEqual(new Set(["\n"]));
    expect(new Set(cr.map(row => row.newline))).toEqual(new Set(["\r"]));
    expect(new Set(crlf.map(row => row.newline))).toEqual(new Set(["\r\n"]));
  });
});

// =============================================================================
// Scanner - Field Terminator Search
// =============================================================================

/**
 * A field ends at the first delimiter or line terminator, and the scanner finds it with
 * one search: a bounded character-by-character scan that hands off to a regex when the
 * field turns out to be long. These cases pin the parts of that search a shorter input
 * would never reach — the hand-off boundary, and the delimiters that are awkward to
 * express in a pattern.
 *
 * Searching per candidate instead (one `indexOf` each for the delimiter, LF and CR) was
 * quadratic: a character the input lacks has no match to stop at, so its search walks to
 * the end of the input, once per field. The perf gates for that live in
 * csv-large-data.test.ts; these are the correctness half.
 */
describe("Scanner - Field Terminator Search", () => {
  // The inline scan runs 16 characters before the regex takes over, so a terminator
  // landing on either side of that (and exactly on it) exercises different code.
  it.each([0, 1, 14, 15, 16, 17, 18, 31, 32, 33, 100])(
    "finds a delimiter %i characters into a field",
    width => {
      const first = "a".repeat(width);
      const rows = scanAllRows(`${first},second\n`);

      expect(rows).toHaveLength(1);
      expect(rows[0].fields).toEqual([first, "second"]);
    }
  );

  it.each([0, 1, 15, 16, 17, 33])("finds a line ending %i characters into a field", width => {
    const only = "a".repeat(width);

    expect(scanAllRows(`${only}\nnext\n`)[0].fields).toEqual([only]);
    expect(scanAllRows(`${only}\r\nnext\r\n`)[0].fields).toEqual([only]);
    expect(scanAllRows(`${only}\rnext\r`)[0].fields).toEqual([only]);
    expect(scanAllRows(`${only}\r\nnext\r\n`)[0].newline).toBe("\r\n");
  });

  it("keeps the terminator search past the inline limit from crossing a row", () => {
    // Every field is longer than the inline scan window, so every field is found by the
    // regex hand-off rather than the loop.
    const long = "x".repeat(40);
    const rows = scanAllRows(`${long}0,${long}1\n${long}2,${long}3\n`);

    expect(rows).toHaveLength(2);
    expect(rows[0].fields).toEqual([`${long}0`, `${long}1`]);
    expect(rows[1].fields).toEqual([`${long}2`, `${long}3`]);
  });

  // A delimiter is interpolated into a pattern, so anything with meaning there has to
  // survive as a literal.
  it.each(["|", ".", "$", "^", "*", "+", "?", "(", ")", "[", "]", "{", "}", "\\"])(
    "treats %s as a literal delimiter",
    delimiter => {
      const rows = scanAllRows(`a${delimiter}b\nc${delimiter}d\n`, { delimiter });

      expect(rows).toHaveLength(2);
      expect(rows[0].fields).toEqual(["a", "b"]);
      expect(rows[1].fields).toEqual(["c", "d"]);
    }
  );

  it.each(["|", ".", "\\"])(
    "treats %s as a literal delimiter past the inline scan limit",
    delimiter => {
      const long = "y".repeat(40);
      const rows = scanAllRows(`${long}${delimiter}${long}\n`, { delimiter });

      expect(rows[0].fields).toEqual([long, long]);
    }
  );

  it.each(["||", "::", "<>", "\t\t"])("supports the multi-character delimiter %s", delimiter => {
    const rows = scanAllRows(`a${delimiter}b${delimiter}c\n`, { delimiter });

    expect(rows[0].fields).toEqual(["a", "b", "c"]);
  });

  it("supports a multi-character delimiter past the inline scan limit", () => {
    const long = "z".repeat(40);
    const rows = scanAllRows(`${long}||${long}\n`, { delimiter: "||" });

    expect(rows[0].fields).toEqual([long, long]);
  });

  it("does not mistake a partial multi-character delimiter for the whole one", () => {
    const rows = scanAllRows("a|b||c\n", { delimiter: "||" });

    expect(rows[0].fields).toEqual(["a|b", "c"]);
  });

  it("does not mistake a partial multi-character delimiter past the inline limit", () => {
    const long = "w".repeat(40);
    const rows = scanAllRows(`${long}|${long}||tail\n`, { delimiter: "||" });

    expect(rows[0].fields).toEqual([`${long}|${long}`, "tail"]);
  });

  // A delimiter is interpolated into a pattern, and the engine rejects one that grows too
  // large — on first execution, not at construction. The previous indexOf-based search had no
  // such limit, so neither may this one. Fields must exceed the inline scan window for the
  // pattern to be reached at all.
  it("splits on a delimiter far too long to embed in a pattern", () => {
    const delimiter = "x".repeat(100_000);
    const long = "A".repeat(40);
    const rows = scanAllRows(`${long}${delimiter}B\n${long}${delimiter}D\n`, { delimiter });

    expect(rows.map(row => row.fields)).toEqual([
      [long, "B"],
      [long, "D"]
    ]);
  });

  it("treats an empty delimiter as no field separator at any field length", () => {
    const short = "a".repeat(15);
    const long = "b".repeat(40);

    expect(scanAllRows(`${short}\n${long}`, { delimiter: "" }).map(row => row.fields)).toEqual([
      [short],
      [long]
    ]);
  });

  // A delimiter that is itself a line terminator is pathological but reachable through
  // the public options, and the search has to resolve the tie the same way everywhere.
  it.each(["\n", "\r", "\r\n"])(
    "resolves %j used as both delimiter and line terminator",
    delimiter => {
      const rows = scanAllRows(`a${delimiter}b${delimiter}`, { delimiter });

      expect(rows.flatMap(row => row.fields).filter(field => field !== "")).toEqual(["a", "b"]);
    }
  );
});

// =============================================================================
// Scanner - relaxQuotes Mode
// =============================================================================

describe("Scanner - relaxQuotes Mode", () => {
  it("should allow unescaped quotes mid-field when relaxQuotes is true", () => {
    const rows = scanAllRows('a"b,c\n', { relaxQuotes: true });
    expect(rows[0].fields).toEqual(['a"b', "c"]);
  });

  it("should handle quotes inside quoted field with relaxQuotes", () => {
    const rows = scanAllRows('"a"b",c\n', { relaxQuotes: true });
    // First field starts with quote, contains unescaped quote, ends at next delimiter
    expect(rows[0].fields[0]).toContain("a");
    expect(rows[0].fields[1]).toBe("c");
  });
});

// =============================================================================
// Scanner - Disabled Quoting
// =============================================================================

describe("Scanner - Disabled Quoting", () => {
  it("should treat quotes as regular characters when quoteEnabled is false", () => {
    const rows = scanAllRows('"a,b",c\n', { quoteEnabled: false });
    expect(rows[0].fields).toEqual(['"a', 'b"', "c"]);
  });

  it("should not process escape sequences when quoteEnabled is false", () => {
    const rows = scanAllRows('a""b,c\n', { quoteEnabled: false });
    expect(rows[0].fields).toEqual(['a""b', "c"]);
  });
});

// =============================================================================
// Scanner - Streaming
// =============================================================================

describe("Scanner - Streaming", () => {
  it("should handle complete rows in chunks", () => {
    const scanner = createScanner();
    scanner.feed("a,b,c\n");

    const row = scanner.nextRow();
    expect(row).not.toBeNull();
    expect(row!.fields).toEqual(["a", "b", "c"]);
  });

  it("should handle row spanning multiple chunks", () => {
    const scanner = createScanner();
    scanner.feed("a,b");
    expect(scanner.nextRow()).toBeNull(); // Incomplete

    scanner.feed(",c\n");
    const row = scanner.nextRow();
    expect(row).not.toBeNull();
    expect(row!.fields).toEqual(["a", "b", "c"]);
  });

  it("should handle quoted field spanning chunks", () => {
    const scanner = createScanner();
    scanner.feed('"hello ');
    expect(scanner.nextRow()).toBeNull();

    scanner.feed('world",b\n');
    const row = scanner.nextRow();
    expect(row).not.toBeNull();
    expect(row!.fields).toEqual(["hello world", "b"]);
  });

  it("should handle CRLF split across chunks", () => {
    const scanner = createScanner();
    scanner.feed("a,b\r");
    expect(scanner.nextRow()).toBeNull(); // CR might be followed by LF

    scanner.feed("\nc,d\n");
    const row1 = scanner.nextRow();
    expect(row1).not.toBeNull();
    expect(row1!.fields).toEqual(["a", "b"]);
    expect(row1!.newline).toBe("\r\n");

    const row2 = scanner.nextRow();
    expect(row2!.fields).toEqual(["c", "d"]);
  });

  it("should flush remaining data at EOF", () => {
    const scanner = createScanner();
    scanner.feed("a,b,c");

    expect(scanner.nextRow()).toBeNull();

    const row = scanner.flush();
    expect(row).not.toBeNull();
    expect(row!.fields).toEqual(["a", "b", "c"]);
  });

  it("should handle multiple rows in one chunk", () => {
    const scanner = createScanner();
    scanner.feed("a,b\nc,d\ne,f\n");

    // Note: Scanner reuses internal arrays for performance, so we must copy fields
    const rows: string[][] = [];
    let row;
    while ((row = scanner.nextRow()) !== null) {
      rows.push([...row.fields]);
    }

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(["a", "b"]);
    expect(rows[1]).toEqual(["c", "d"]);
    expect(rows[2]).toEqual(["e", "f"]);
  });

  it("should reset scanner state", () => {
    const scanner = createScanner();
    scanner.feed("a,b,c\n");
    scanner.nextRow();

    scanner.reset();
    expect(scanner.getBuffer()).toBe("");

    scanner.feed("x,y,z\n");
    const row = scanner.nextRow();
    expect(row!.fields).toEqual(["x", "y", "z"]);
  });
});

// =============================================================================
// Scanner - Async Iterator
// =============================================================================

describe("Scanner - Async Iterator", () => {
  it("should iterate over rows from async chunks", async () => {
    async function* chunks() {
      yield "a,b,c\n";
      yield "1,2,3\n";
    }

    // Note: Scanner reuses internal arrays for performance, so we must copy fields
    const rows: string[][] = [];
    for await (const row of scanRowsAsync(chunks())) {
      rows.push([...row.fields]);
    }

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["a", "b", "c"]);
    expect(rows[1]).toEqual(["1", "2", "3"]);
  });

  it("should handle row spanning async chunks", async () => {
    async function* chunks() {
      yield "a,";
      yield "b,";
      yield "c\n";
    }

    const rows: RowScanResult[] = [];
    for await (const row of scanRowsAsync(chunks())) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
  });

  it("should flush final row without newline", async () => {
    async function* chunks() {
      yield "a,b,c";
    }

    const rows: RowScanResult[] = [];
    for await (const row of scanRowsAsync(chunks())) {
      rows.push(row);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0].fields).toEqual(["a", "b", "c"]);
  });
});

// =============================================================================
// Scanner - Edge Cases
// =============================================================================

describe("Scanner - Edge Cases", () => {
  it("should handle single character", () => {
    const rows = scanAllRows("a");
    expect(rows[0].fields).toEqual(["a"]);
  });

  it("should handle only delimiter", () => {
    const rows = scanAllRows(",\n");
    expect(rows[0].fields).toEqual(["", ""]);
  });

  it("should handle many empty fields", () => {
    const rows = scanAllRows(",,,,\n");
    expect(rows[0].fields).toEqual(["", "", "", "", ""]);
  });

  it("should handle large field", () => {
    const largeValue = "x".repeat(100000);
    const rows = scanAllRows(`${largeValue},b\n`);
    expect(rows[0].fields[0]).toBe(largeValue);
    expect(rows[0].fields[1]).toBe("b");
  });

  it("should handle many columns", () => {
    const columns = Array.from({ length: 1000 }, (_, i) => `col${i}`);
    const input = columns.join(",") + "\n";
    const rows = scanAllRows(input);
    expect(rows[0].fields).toHaveLength(1000);
    expect(rows[0].fields[0]).toBe("col0");
    expect(rows[0].fields[999]).toBe("col999");
  });
});

// =============================================================================
// Low-Level Scanner Functions
// =============================================================================

describe("scanQuotedField", () => {
  const config: ScannerConfig = DEFAULT_SCANNER_CONFIG;

  it("should parse simple quoted field", () => {
    const result = scanQuotedField('"hello",', 0, config, true);
    expect(result.value).toBe("hello");
    expect(result.quoted).toBe(true);
    expect(result.endPos).toBe(7); // After closing quote
    expect(result.needMore).toBe(false);
  });

  it("should handle escaped quote", () => {
    const result = scanQuotedField('"say ""hi""",', 0, config, true);
    expect(result.value).toBe('say "hi"');
    expect(result.needMore).toBe(false);
  });

  it("should request more data when incomplete", () => {
    const result = scanQuotedField('"incomplete', 0, config, false);
    expect(result.needMore).toBe(true);
    expect(result.resumePos).toBe(0);
  });

  it("should handle quote at EOF", () => {
    const result = scanQuotedField('"value"', 0, config, true);
    expect(result.value).toBe("value");
    expect(result.needMore).toBe(false);
  });
});

describe("scanUnquotedField", () => {
  const config: ScannerConfig = DEFAULT_SCANNER_CONFIG;

  it("should parse field until delimiter", () => {
    const result = scanUnquotedField("hello,world", 0, config, true);
    expect(result.value).toBe("hello");
    expect(result.endPos).toBe(5);
    expect(result.needMore).toBe(false);
  });

  it("should parse field until newline", () => {
    const result = scanUnquotedField("hello\n", 0, config, true);
    expect(result.value).toBe("hello");
    expect(result.endPos).toBe(5);
  });

  it("should request more data when no terminator found", () => {
    const result = scanUnquotedField("hello", 0, config, false);
    expect(result.needMore).toBe(true);
  });

  it("should handle empty field", () => {
    const result = scanUnquotedField(",next", 0, config, true);
    expect(result.value).toBe("");
    expect(result.endPos).toBe(0);
  });
});

describe("scanRow", () => {
  const config: ScannerConfig = DEFAULT_SCANNER_CONFIG;

  it("should scan complete row", () => {
    const result = scanRow("a,b,c\n", 0, config, true);
    expect(result.fields).toEqual(["a", "b", "c"]);
    expect(result.complete).toBe(true);
    expect(result.endPos).toBe(6);
  });

  it("should track quoted status", () => {
    const result = scanRow('"a",b,"c"\n', 0, config, true);
    expect(result.fields).toEqual(["a", "b", "c"]);
    expect(result.quoted).toEqual([true, false, true]);
  });

  it("should handle row at offset", () => {
    const result = scanRow("skip\na,b,c\n", 5, config, true);
    expect(result.fields).toEqual(["a", "b", "c"]);
  });

  it("should return needMore when incomplete", () => {
    const result = scanRow("a,b,c", 0, config, false);
    expect(result.needMore).toBe(true);
    expect(result.complete).toBe(false);
  });
});

// =============================================================================
// parseWithScanner Integration - Basic Parsing
// =============================================================================

describe("parseWithScanner - Basic Parsing", () => {
  it("should parse simple rows", () => {
    expectRow("a,b,c\n", {}, [["a", "b", "c"]]);
    expectRow("a,b,c\n1,2,3\n", {}, [
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
    expectRow("hello,world\n", {}, [["hello", "world"]]);
  });

  it("should handle empty fields", () => {
    expectRow(",b,\n", {}, [["", "b", ""]]);
    expectRow(",,\n", {}, [["", "", ""]]);
    expectRow("a,,c\n", {}, [["a", "", "c"]]);
  });

  it("should handle row without trailing newline", () => {
    expectRow("a,b,c", {}, [["a", "b", "c"]]);
    expectRow("hello", {}, [["hello"]]);
  });

  it("should handle empty input", () => {
    expectRow("", {}, []);
  });

  it("should handle single field", () => {
    expectRow("hello\n", {}, [["hello"]]);
    expectRow("hello", {}, [["hello"]]);
  });
});

// =============================================================================
// parseWithScanner Integration - Quoted Fields
// =============================================================================

describe("parseWithScanner - Quoted Fields", () => {
  it("should parse quoted fields", () => {
    expectRow('"hello",world\n', {}, [["hello", "world"]]);
    expectRow('"a,b",c\n', {}, [["a,b", "c"]]);
    expectRow('"line1\nline2",b\n', {}, [["line1\nline2", "b"]]);
  });

  it("should handle escaped quotes", () => {
    expectRow('"say ""hello""",b\n', {}, [['say "hello"', "b"]]);
    expectRow('""""\n', {}, [['"']]);
    expectRow('"a""""b"\n', {}, [['a""b']]);
  });

  it("should handle empty quoted fields", () => {
    expectRow('"",b\n', {}, [["", "b"]]);
    expectRow('"",""\n', {}, [["", ""]]);
  });

  it("should handle CRLF inside quotes (normalized to LF)", () => {
    expectRow('"line1\r\nline2",b\n', {}, [["line1\nline2", "b"]]);
  });
});

// =============================================================================
// parseWithScanner Integration - Newlines
// =============================================================================

describe("parseWithScanner - Newlines", () => {
  it("should handle LF line endings", () => {
    expectRow("a,b\nc,d\n", {}, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle CRLF line endings", () => {
    expectRow("a,b\r\nc,d\r\n", {}, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle CR line endings", () => {
    expectRow("a,b\rc,d\r", {}, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle mixed line endings", () => {
    expectRow("a,b\nc,d\r\ne,f\r", {}, [
      ["a", "b"],
      ["c", "d"],
      ["e", "f"]
    ]);
  });
});

// =============================================================================
// parseWithScanner Integration - Options
// =============================================================================

describe("parseWithScanner - Options", () => {
  it("should handle trim option", () => {
    expectRow("  a  ,  b  \n", { trim: true }, [["a", "b"]]);
    expectRow("  a  ,  b  \n", { ltrim: true }, [["a  ", "b  "]]);
    expectRow("  a  ,  b  \n", { rtrim: true }, [["  a", "  b"]]);
  });

  it("should handle skipEmptyLines", () => {
    expectRow("a,b\n\nc,d\n", { skipEmptyLines: true }, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle comment lines", () => {
    expectRow("a,b\n#comment\nc,d\n", { comment: "#" }, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle skipLines", () => {
    expectRow("skip1\nskip2\na,b\n", { skipLines: 2 }, [["a", "b"]]);
  });

  it("should handle maxRows", () => {
    expectRow("a,b\nc,d\ne,f\n", { maxRows: 2 }, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle toLine", () => {
    expectRow("a,b\nc,d\ne,f\n", { toLine: 2 }, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });

  it("should handle info option", () => {
    const { results } = parseWithScanner_("a,b\nc,d\n", { info: true });
    expect(results[0].info).toBeDefined();
    expect(results[0].info?.line).toBe(1);
  });

  it("should handle raw option", () => {
    const { results } = parseWithScanner_("a,b\nc,d\n", { info: true, raw: true });
    expect(results[0].info?.raw).toBe("a,b");
    expect(results[1].info?.raw).toBe("c,d");
  });

  it("should handle relaxQuotes", () => {
    expectRow('a"b,c\n', { relaxQuotes: true }, [['a"b', "c"]]);
  });

  it("should handle skipRecordsWithEmptyValues", () => {
    expectRow("a,b\n,,\nc,d\n", { skipRecordsWithEmptyValues: true }, [
      ["a", "b"],
      ["c", "d"]
    ]);
  });
});

// =============================================================================
// parseWithScanner Integration - Multi-char Delimiters
// =============================================================================

describe("parseWithScanner - Multi-char Delimiters", () => {
  it("should handle || delimiter", () => {
    expectRow("a||b||c\n", { delimiter: "||" }, [["a", "b", "c"]]);
  });

  it("should handle tab-tab delimiter", () => {
    expectRow("a\t\tb\t\tc\n", { delimiter: "\t\t" }, [["a", "b", "c"]]);
  });

  it("should handle quoted field with multi-char delimiter inside", () => {
    expectRow('"a||b"||c\n', { delimiter: "||" }, [["a||b", "c"]]);
  });
});

// =============================================================================
// parseWithScanner Integration - Column Mismatch
// =============================================================================

describe("parseWithScanner - Column Mismatch", () => {
  it("should handle too many fields with truncate", () => {
    const { results } = parseWithScanner_("a,b\n1,2,3\n", {
      headers: true,
      columnMismatch: { less: "error", more: "truncate" }
    });
    const dataRows = results.filter(r => !r.skipped && r.row);
    expect(dataRows[0].row).toEqual(["1", "2"]); // truncated from ["1","2","3"]
  });

  it("should handle too few fields with pad", () => {
    const { results } = parseWithScanner_("a,b,c\n1,2\n", {
      headers: true,
      columnMismatch: { less: "pad", more: "error" }
    });
    const dataRows = results.filter(r => !r.skipped && r.row);
    expect(dataRows[0].row).toEqual(["1", "2", ""]); // padded from ["1","2"]
  });
});

// =============================================================================
// parseWithScanner Integration - Edge Cases
// =============================================================================

describe("parseWithScanner - Edge Cases", () => {
  it("should handle large number of columns", () => {
    const cols = Array.from({ length: 100 }, (_, i) => `col${i}`);
    const { results } = parseWithScanner_(cols.join(",") + "\n", {});
    expect(results[0].row).toHaveLength(100);
  });

  it("should handle long field values", () => {
    const longValue = "x".repeat(10000);
    expectRow(`${longValue},b\n`, {}, [[longValue, "b"]]);
  });

  it("should handle many consecutive empty fields", () => {
    expectRow(",,,,,,,,,,\n", {}, [["", "", "", "", "", "", "", "", "", "", ""]]);
  });

  it("should handle field with only quotes", () => {
    expectRow('""""\n', {}, [['"']]);
  });

  it("should handle consecutive rows", () => {
    const rows = Array.from({ length: 100 }, (_, i) => `a${i},b${i},c${i}`);
    const { results } = parseWithScanner_(rows.join("\n") + "\n", {});
    expect(results).toHaveLength(100);
  });
});

// =============================================================================
// Scanner - Streaming Emits As Soon As A Row Completes
// =============================================================================

/**
 * A row must come out of `nextRow()` on the feed that completes it, not be left for
 * `flush()`. Output equality cannot check this — `flush()` is authoritative at end of input,
 * so a row that emerges late still emerges, with the same fields, in the same order — and a
 * suite of thousands of chunk-size comparisons duly passed while this was broken.
 *
 * What it costs when it is wrong is latency and buffer growth: rows arrive in a batch at the
 * end rather than as they parse, which is the point of streaming. It is asserted here rather
 * than through `CsvParserStream` because the scanner is synchronous, so "the row is available
 * now" is a fact rather than a race.
 *
 * The mechanism at risk is the wait: while a quoted field is open the scanner waits for a
 * quote rather than re-reading the buffer, and decides from run parity across chunk
 * boundaries whether one closed the field. Getting that parity wrong in the direction of
 * "still open" is exactly a late row.
 */
describe("Scanner - Streaming Emits As Soon As A Row Completes", () => {
  /** Feed `csv` in fixed-size pieces, collecting rows without ever calling flush(). */
  function rowsBeforeFlush(csv: string, chunkSize: number, config?: Partial<ScannerConfig>) {
    const scanner = createScanner(config);
    const rows: string[][] = [];
    for (let i = 0; i < csv.length; i += chunkSize) {
      scanner.feed(csv.slice(i, i + chunkSize));
      let row: RowScanResult | null;
      while ((row = scanner.nextRow()) !== null) {
        rows.push([...row.fields]);
      }
    }
    return rows;
  }

  it("emits a quoted row terminated by a newline without waiting for flush", () => {
    // Every run length, every offset, every chunk size: the run may be split anywhere, and a
    // chunk may consist of nothing but quotes with a partial run already carried into it.
    for (let runLength = 0; runLength <= 6; runLength++) {
      for (let prefixLength = 0; prefixLength <= 4; prefixLength++) {
        const csv = `"${"a".repeat(prefixLength)}${'"'.repeat(runLength)}b",z\n`;
        const expected = rowsBeforeFlush(csv, csv.length);
        expect(expected).toHaveLength(1);

        for (let chunkSize = 1; chunkSize <= csv.length; chunkSize++) {
          expect(rowsBeforeFlush(csv, chunkSize)).toEqual(expected);
        }
      }
    }
  });

  it("emits each of several quoted rows on the feed that completes it", () => {
    const csv = '"a""b",1\n"c\nd",2\n"","e""""f"\n';
    const whole = rowsBeforeFlush(csv, csv.length);
    expect(whole).toHaveLength(3);

    for (let chunkSize = 1; chunkSize <= csv.length; chunkSize++) {
      expect(rowsBeforeFlush(csv, chunkSize)).toEqual(whole);
    }
  });

  it("emits rows promptly with a distinct escape character", () => {
    const csv = '"a\\"b",1\n"c",2\n';
    const whole = rowsBeforeFlush(csv, csv.length, { escape: "\\" });
    expect(whole).toEqual([
      ['a"b', "1"],
      ["c", "2"]
    ]);

    for (let chunkSize = 1; chunkSize <= csv.length; chunkSize++) {
      expect(rowsBeforeFlush(csv, chunkSize, { escape: "\\" })).toEqual(whole);
    }
  });

  it("does not delay a relaxed quote whose multi-character delimiter crosses chunks", () => {
    const scanner = createScanner({ delimiter: "||", relaxQuotes: true });

    scanner.feed('"a"|');
    expect(scanner.nextRow()).toBeNull();
    scanner.feed("|b\nc,d\n");

    expect(scanner.nextRow()?.fields).toEqual(["a", "b"]);
    expect(scanner.nextRow()?.fields).toEqual(["c,d"]);
    expect(scanner.nextRow()).toBeNull();
  });

  it("replays a failed relaxed delimiter prefix that itself contains a quote", () => {
    const scanner = createScanner({ delimiter: 'a"x', escape: "\\", relaxQuotes: true });

    scanner.feed('"q"');
    expect(scanner.nextRow()).toBeNull();
    scanner.feed('a"\nsecond\n');

    expect([...(scanner.nextRow()?.fields ?? [])]).toEqual(['q"a']);
    expect([...(scanner.nextRow()?.fields ?? [])]).toEqual(["second"]);
  });

  it("exposes an immutable config because waiting state is derived from it", () => {
    const scanner = createScanner({ delimiter: "||" });

    expect(Object.isFrozen(scanner.config)).toBe(true);
    expect(() => {
      (scanner.config as { delimiter: string }).delimiter = ",";
    }).toThrow(TypeError);
    expect(scanner.config.delimiter).toBe("||");
    expect(Object.isFrozen(DEFAULT_SCANNER_CONFIG)).toBe(true);
  });

  it("emits unquoted rows promptly whatever the line ending", () => {
    // Compared against the same input delivered whole rather than against a row count: an
    // input ending in a bare CR legitimately holds its last row back, because whether that CR
    // is a line ending or half a CRLF is not decided until the next character or end of input.
    for (const csv of ["a,b\nc,d\n", "a,b\r\nc,d\r\n", "a,b\rc,d\r"]) {
      const whole = rowsBeforeFlush(csv, csv.length);

      for (let chunkSize = 1; chunkSize <= csv.length; chunkSize++) {
        expect(rowsBeforeFlush(csv, chunkSize)).toEqual(whole);
      }
    }
  });

  // An empty quoted field is the case where the opening quote sits next to the closing one,
  // so a count of the trailing quote run that included the opening quote would read this as
  // still open and hold the row back.
  it.each([
    ['a,"",b\n', "empty quoted field mid row"],
    ['"",x\n', "empty quoted field first"],
    ['x,""\n', "empty quoted field last"],
    ['"""",x\n', "quoted field holding one escaped quote"],
    ['"a","","b"\n', "empty quoted field between values"],
    ['"",""\n"y","z"\n', "empty quoted fields then a further row"]
  ])("emits %s promptly (%s)", csv => {
    const whole = rowsBeforeFlush(csv, csv.length);
    expect(whole).toHaveLength(csv.includes('\n"y"') ? 2 : 1);

    for (let chunkSize = 1; chunkSize <= csv.length; chunkSize++) {
      expect(rowsBeforeFlush(csv, chunkSize)).toEqual(whole);
    }
  });
});
