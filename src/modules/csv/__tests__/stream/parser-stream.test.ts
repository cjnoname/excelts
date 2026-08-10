/**
 * CsvParserStream Tests
 *
 * Tests for the streaming CSV parser (CsvParserStream).
 *
 * Coverage:
 * - Basic parsing from readable streams
 * - Chunked input handling
 * - Quoted fields
 * - Parser options (delimiter, trim, skipEmptyLines, comment, etc.)
 * - Headers mode
 * - Line endings (LF, CRLF, CR)
 * - Transform functions
 * - Error handling
 */

import { Csv } from "@csv/index";
import { CsvParserStream } from "@csv/stream";
import type { ChunkMeta, Row } from "@csv/types";
import { Readable } from "@stream";
import { describe, it, expect } from "vitest";

// =============================================================================
// Test Helpers
// =============================================================================

function collectRows(parser: CsvParserStream): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const rows: any[] = [];
    parser.on("data", (row: any) => rows.push(row));
    parser.on("end", () => resolve(rows));
    parser.on("error", reject);
  });
}

// =============================================================================
// Basic Parsing
// =============================================================================

describe("CsvParserStream - Basic Parsing", () => {
  it("should parse CSV from readable stream", async () => {
    const input = "a,b,c\n1,2,3\n4,5,6";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("should handle chunked input", async () => {
    const chunks = ["a,b", ",c\n1,", "2,3\n4,5", ",6"];
    const readable = Readable.from(chunks);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("should handle Buffer input", async () => {
    const input = Buffer.from("a,b,c\n1,2,3");
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should emit data events", async () => {
    const input = "a,b,c\n1,2,3";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    readable.pipe(parser);

    parser.on("data", row => {
      rows.push(row);
    });

    await new Promise<void>(resolve => parser.on("end", resolve));

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should preserve chunk rows and callback semantics across readable backpressure", async () => {
    const callbackChunks: { rows: Row[]; meta: ChunkMeta }[] = [];
    const parser = new CsvParserStream({
      chunkSize: 20,
      chunk: (rows, meta) => {
        callbackChunks.push({ rows: rows.map(row => [...(row as unknown[])] as Row), meta });
      }
    });
    // The default object-mode readable HWM is 16, so ending 50 rows before
    // consuming deterministically applies backpressure in the first chunk.
    const expectedRows = Array.from({ length: 50 }, (_, index) => [
      String(index),
      `value-${index}`
    ]);

    parser.end(expectedRows.map(row => row.join(",")).join("\n"));

    const rows: Row[] = [];
    for await (const row of parser) {
      rows.push(row as Row);
    }

    expect(rows).toEqual(expectedRows);
    expect(callbackChunks).toEqual([
      {
        rows: expectedRows.slice(0, 20),
        meta: { cursor: 0, rowCount: 20, isFirstChunk: true, isLastChunk: false }
      },
      {
        rows: expectedRows.slice(20, 40),
        meta: { cursor: 20, rowCount: 20, isFirstChunk: false, isLastChunk: false }
      },
      {
        rows: expectedRows.slice(40),
        meta: { cursor: 40, rowCount: 10, isFirstChunk: false, isLastChunk: true }
      }
    ]);
  });
});

// =============================================================================
// Quoted Fields
// =============================================================================

describe("CsvParserStream - Quoted Fields", () => {
  it("should parse quoted fields with commas", async () => {
    const input = '"hello, world",test\n"a,b",c';
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["hello, world", "test"],
      ["a,b", "c"]
    ]);
  });

  it("should parse quoted fields with newlines", async () => {
    const input = '"line1\nline2",test';
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([["line1\nline2", "test"]]);
  });

  it("should parse escaped quotes", async () => {
    const input = '"He said ""Hello""",test';
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([['He said "Hello"', "test"]]);
  });

  it("should handle quoted field split across chunks", async () => {
    const chunks = ['"hello, ', 'world",test'];
    const readable = Readable.from(chunks);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([["hello, world", "test"]]);
  });
});

// =============================================================================
// Options
// =============================================================================

describe("CsvParserStream - Options", () => {
  it("should support custom delimiter", async () => {
    const input = "a;b;c\n1;2;3";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ delimiter: ";" });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should support tab delimiter (TSV)", async () => {
    const input = "a\tb\tc\n1\t2\t3";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ delimiter: "\t" });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should trim whitespace when trim option is true", async () => {
    const input = " a , b , c \n 1 , 2 , 3 ";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ trim: true });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should skip empty lines when skipEmptyLines is true", async () => {
    const input = "a,b\n\n1,2\n\n3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ skipEmptyLines: true });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("should skip comment lines", async () => {
    const input = "a,b\n# comment\n1,2";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ comment: "#" });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("should limit rows with maxRows option", async () => {
    const input = "a,b\n1,2\n3,4\n5,6\n7,8";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ maxRows: 2 });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows[0]).toEqual(["a", "b"]);
    expect(rows[1]).toEqual(["1", "2"]);
  });

  it("should skip initial lines with skipLines option", async () => {
    const input = "header line\ncomment\na,b\n1,2";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ skipLines: 2 });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("should disable quoting when quote is null", async () => {
    const input = '"hello",world';
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ quote: null });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([['"hello"', "world"]]);
  });

  it("should auto-detect delimiter when delimiter is empty string", async () => {
    const input = "a;b;c\n1;2;3\n4;5;6";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ delimiter: "" });

    const rows: string[][] = [];
    let detectedDelimiter: string | undefined;

    parser.on("delimiter", (delimiter: string) => {
      detectedDelimiter = delimiter;
    });

    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(detectedDelimiter).toBe(";");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("should auto-detect tab delimiter", async () => {
    const input = "a\tb\tc\n1\t2\t3";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ delimiter: "" });

    const rows: string[][] = [];
    let detectedDelimiter: string | undefined;

    parser.on("delimiter", (delimiter: string) => {
      detectedDelimiter = delimiter;
    });

    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(detectedDelimiter).toBe("\t");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should auto-detect delimiter with chunked input", async () => {
    const chunks = ["a;b", ";c\n1;", "2;3\n4;5", ";6"];
    const readable = Readable.from(chunks);
    const parser = new CsvParserStream({ delimiter: "" });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("should respect skipEmptyLines in fastMode", async () => {
    // With skipEmptyLines: false, empty lines should be included as empty rows
    const input = "a,b\n\n1,2\n\n3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ fastMode: true, skipEmptyLines: false });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    // Empty lines are now properly preserved when skipEmptyLines is false
    expect(rows).toEqual([["a", "b"], [""], ["1", "2"], [""], ["3", "4"]]);
  });

  it("should skip empty lines in fastMode when skipEmptyLines is true", async () => {
    const input = "a,b\n\n1,2\n\n3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ fastMode: true, skipEmptyLines: true });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("should skip delimiter-only rows when configured in fastMode", async () => {
    const input = "a,b\n,\n1,2\n,,\n3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ fastMode: true, skipEmptyLines: true });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });
});

// =============================================================================
// Headers Mode
// =============================================================================

describe("CsvParserStream - Headers Mode", () => {
  it("should return objects when headers option is true", async () => {
    const input = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ headers: true });

    const rows: Record<string, string>[] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as Record<string, string>);
    }

    expect(rows).toEqual([
      { name: "Alice", age: "30", city: "NYC" },
      { name: "Bob", age: "25", city: "LA" }
    ]);
  });

  it("should handle missing fields in data rows", async () => {
    const input = "a,b,c\n1,2";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({
      headers: true,
      columnMismatch: { less: "pad", more: "error" }
    });

    const rows: Record<string, string>[] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as Record<string, string>);
    }

    expect(rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });
});

// =============================================================================
// Line Endings
// =============================================================================

describe("CsvParserStream - Line Endings", () => {
  it("should handle CRLF line endings", async () => {
    const input = "a,b\r\n1,2\r\n3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("should handle CR only line endings", async () => {
    const input = "a,b\r1,2\r3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("should handle LF only line endings", async () => {
    const input = "a,b\n1,2\n3,4";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });
});

// =============================================================================
// Transform Functions
// =============================================================================

describe("CsvParserStream - Transform Functions", () => {
  it("should support sync transform", async () => {
    const parser = new CsvParserStream({ headers: true });
    parser.transform((row: Record<string, string>) => ({
      firstName: row.first_name?.toUpperCase(),
      lastName: row.last_name?.toUpperCase()
    }));

    const input = "first_name,last_name\nbob,yukon\nsally,yukon";
    parser.end(input);

    const rows = await collectRows(parser);
    expect(rows).toEqual([
      { firstName: "BOB", lastName: "YUKON" },
      { firstName: "SALLY", lastName: "YUKON" }
    ]);
  });

  it("should support async transform", async () => {
    const parser = new CsvParserStream({ headers: true });
    parser.transform((row: Record<string, string>, cb: (err: Error | null, row?: any) => void) => {
      setImmediate(() => {
        cb(null, {
          firstName: row.first_name?.toUpperCase(),
          lastName: row.last_name?.toUpperCase()
        });
      });
    });

    const input = "first_name,last_name\nalice,smith";
    parser.end(input);

    const rows = await collectRows(parser);
    expect(rows).toEqual([{ firstName: "ALICE", lastName: "SMITH" }]);
  });

  it("should handle transform returning null to skip row", async () => {
    const parser = new CsvParserStream({ headers: true });
    parser.transform((row: Record<string, string>) => {
      if (row.skip === "true") {
        return null;
      }
      return row;
    });

    const input = "name,skip\nalice,false\nbob,true\ncharlie,false";
    parser.end(input);

    const rows = await collectRows(parser);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("alice");
    expect(rows[1].name).toBe("charlie");
  });
});

// =============================================================================
// Error Handling
// =============================================================================

describe("CsvParserStream - Error Handling", () => {
  it("should handle malformed quoted field at end of stream", async () => {
    const input = '"unclosed quote';
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows.length).toBe(1);
    expect(rows[0][0]).toContain("unclosed");
  });

  it("should handle empty input", async () => {
    const input = "";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream();

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows.length).toBe(0);
  });

  it("should handle input with only whitespace when trim enabled", async () => {
    const input = "   \n   ";
    const readable = Readable.from([input]);
    const parser = new CsvParserStream({ trim: true, skipEmptyLines: true });

    const rows: string[][] = [];
    for await (const row of readable.pipe(parser)) {
      rows.push(row as string[]);
    }

    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// Csv.parseRows Streaming Options
// =============================================================================

describe("parseCsvRows - Streaming Options", () => {
  it("should support ltrim in streaming", async () => {
    const input = "  a,  b\n  1,  2";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, { ltrim: true })) {
      rows.push(row);
    }
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("should support rtrim in streaming", async () => {
    const input = "a  ,b  \n1  ,2  ";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, { rtrim: true })) {
      rows.push(row);
    }
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("should support skipRows in streaming", async () => {
    const input = "a,b\n1,2\n3,4\n5,6";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, { headers: true, skipRows: 1 })) {
      rows.push(row);
    }
    expect(rows).toEqual([
      { a: "3", b: "4" },
      { a: "5", b: "6" }
    ]);
  });

  it("should support skipEmptyLines in streaming", async () => {
    const input = "a,b\n\n1,2\n\n3,4";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, { skipEmptyLines: true })) {
      rows.push(row);
    }
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("should support columnMismatch truncate in streaming", async () => {
    const input = "a,b\n1,2,extra";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, {
      headers: true,
      columnMismatch: { less: "error", more: "truncate" }
    })) {
      rows.push(row);
    }
    expect(rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("should support dynamicTyping in streaming", async () => {
    const input = "name,age,active\nAlice,30,true\nBob,25,false";
    const rows: Record<string, unknown>[] = [];
    for await (const row of Csv.parseRows(input, {
      headers: true,
      dynamicTyping: true
    })) {
      rows.push(row as Record<string, unknown>);
    }
    expect(rows).toEqual([
      { name: "Alice", age: 30, active: true },
      { name: "Bob", age: 25, active: false }
    ]);
  });

  it("should handle comment lines in streaming", async () => {
    const input = "a,b\n# comment\n1,2\n# another\n3,4";
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(input, { comment: "#" })) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("should handle multiline quoted field in stream", async () => {
    const input = '"line1\nline2\nline3",value\nnormal,row';
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(input)) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["line1\nline2\nline3", "value"],
      ["normal", "row"]
    ]);
  });

  it("should handle skipEmptyLines greedy mode in streaming", async () => {
    const input = "a,b\n   \t  \nc,d\n\ne,f";
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(input, { skipEmptyLines: "greedy" })) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"]
    ]);
  });

  it("should handle maxRowBytes in streaming exactly at limit", async () => {
    const input = "abc,def\n123,456";
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(input, { maxRowBytes: 7 })) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["abc", "def"],
      ["123", "456"]
    ]);
  });

  it("should throw on maxRowBytes exceed in streaming", async () => {
    const input = "short\nthis_is_a_very_long_row_that_exceeds_limit";

    await expect(async () => {
      for await (const _row of Csv.parseRows(input, { maxRowBytes: 20 })) {
        // Consume the stream
      }
    }).rejects.toThrow("Row exceeds the maximum size of 20 bytes");
  });
});

// =============================================================================
// Async Iterable Input
// =============================================================================

describe("parseCsvRows - Async Iterable Input", () => {
  it("should stream parse from async iterable", async () => {
    async function* chunks() {
      yield "a,b,";
      yield "c\n1,2,3";
    }
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(chunks())) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle chunks splitting in middle of field", async () => {
    async function* chunks() {
      yield "hel";
      yield "lo,wor";
      yield "ld\n";
    }
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(chunks())) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([["hello", "world"]]);
  });

  it("should handle chunks splitting in middle of quoted field", async () => {
    async function* chunks() {
      yield '"hello, ';
      yield 'world",test\n';
    }
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(chunks())) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([["hello, world", "test"]]);
  });

  it("should handle escaped quotes in quoted field across chunks", async () => {
    async function* chunks() {
      yield '"hello ""';
      yield 'world""",test\n';
    }
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(chunks())) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([['hello "world"', "test"]]);
  });

  it("should handle CRLF split across chunks", async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield "a,b\r";
      yield "\nc,d\r\n";
      yield "e,f";
    }
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(chunks())) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"]
    ]);
  });

  it("should handle CRLF inside quoted field split across chunks", async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield 'a,"line1\r';
      yield '\nline2",b\n';
      yield "c,d,e";
    }
    const rows: string[][] = [];
    for await (const row of Csv.parseRows(chunks())) {
      rows.push(row as string[]);
    }
    expect(rows).toEqual([
      ["a", "line1\nline2", "b"],
      ["c", "d", "e"]
    ]);
  });
});

// =============================================================================
// info.offset Semantics (Streaming)
// =============================================================================

describe("CsvParserStream - info.offset", () => {
  it("should track character offset (not UTF-8 byte offset)", async () => {
    // "a,€\n" is 4 JS characters but 6 UTF-8 bytes.
    const input = "a,€\n1,2\n";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, { info: true })) {
      rows.push(row);
    }
    expect(rows[0].info.offset).toBe(0);
    expect(rows[1].info.offset).toBe(4);
  });

  it("should account for custom lineEnding in fastMode", async () => {
    const input = "a,b||1,2||3,4";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, {
      info: true,
      fastMode: true,
      lineEnding: "||"
    })) {
      rows.push(row);
    }
    expect(rows.map(r => r.record)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"]
    ]);
    // Offsets should advance by line length + custom line ending length (2 chars).
    expect(rows[0].info.offset).toBe(0);
    expect(rows[1].info.offset).toBe(5); // "a,b||" = 5 characters
    expect(rows[2].info.offset).toBe(10); // "a,b||1,2||" = 10 characters
  });
});
