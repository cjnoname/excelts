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

  it("should scan large LF-only and CR-only inputs to the same fields as CRLF", () => {
    const rowCount = 5000;
    const body = Array.from(
      { length: rowCount },
      (_, i) => `r${i},alpha,beta,gamma,${i * 7},"quoted, field",delta`
    );

    const lf = scanAllRows(body.join("\n") + "\n");
    const cr = scanAllRows(body.join("\r") + "\r");
    const crlf = scanAllRows(body.join("\r\n") + "\r\n");

    expect(lf).toHaveLength(rowCount);
    expect(cr.map(row => row.fields)).toEqual(lf.map(row => row.fields));
    expect(crlf.map(row => row.fields)).toEqual(lf.map(row => row.fields));
    expect(new Set(lf.map(row => row.newline))).toEqual(new Set(["\n"]));
    expect(new Set(cr.map(row => row.newline))).toEqual(new Set(["\r"]));
    expect(new Set(crlf.map(row => row.newline))).toEqual(new Set(["\r\n"]));
  });
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
