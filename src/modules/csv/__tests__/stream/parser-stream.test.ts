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

import { CsvError } from "@csv/errors";
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

// =============================================================================
// Chunk-Boundary Scan Complexity
// =============================================================================

/**
 * Streaming buffers a partial row until more data arrives, and everything already
 * buffered used to be re-examined on each chunk. A row shorter than a chunk hides that —
 * the re-examined tail is one short row — but a row *longer* than a chunk was re-read from
 * its start every chunk, so it cost O(chunks x rowBytes), orders of magnitude more than
 * parsing the same bytes once.
 *
 * There were two independent reasons per chunk, and both are gone:
 *
 * 1. The row was re-*parsed*. Standard mode now waits for a row terminator before
 *    scanning again, and fastMode records how far it has already searched.
 * 2. The buffer was re-*copied*. `buffer += chunk` only builds a rope, but any string
 *    operation on that rope flattens it, so merely looking for a terminator copied every
 *    byte buffered so far. Both modes now search
 *    the arriving chunk instead and leave the buffer untouched until there is something to
 *    find.
 *
 * Together those make the cost of a row independent of how the row was delivered, which is
 * what the gates below assert: the same input delivered whole and in small pieces, where
 * only the chunk count differs. Both sides parse identical bytes into identical rows, so
 * they allocate alike and a GC pause is as likely in either — which an earlier version of
 * these gates got wrong by comparing against a *different* shape of input, where the
 * smaller measurement inflated far more than the larger one and hid the bug.
 */
describe("CsvParserStream - Chunk-Boundary Scan Complexity", () => {
  function feedInChunks(csv: string, chunkSize: number, options = {}): Promise<any[]> {
    const chunks: string[] = [];
    for (let i = 0; i < csv.length; i += chunkSize) {
      chunks.push(csv.slice(i, i + chunkSize));
    }
    const parser = new CsvParserStream(options);
    const collected = collectRows(parser);
    Readable.from(chunks).pipe(parser);
    return collected;
  }

  async function msToParse(csv: string, chunkSize: number, options = {}) {
    const start = performance.now();
    const rows = await feedInChunks(csv, chunkSize, options);
    return { rows, ms: performance.now() - start };
  }

  /**
   * Best of `attempts`, since these are wall-clock numbers in the tens of milliseconds and
   * a single GC pause is a large fraction of one. Both sides of every ratio below use this,
   * so neither is the noisier one.
   */
  async function bestMsToParse(csv: string, chunkSize: number, options = {}, attempts = 3) {
    let best = Infinity;
    let rows: any[] = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      const run = await msToParse(csv, chunkSize, options);
      best = Math.min(best, run.ms);
      rows = run.rows;
    }
    return { rows, ms: best };
  }

  /**
   * One long row delivered whole against the same row in 8 KB pieces. Delivered whole there
   * is nothing that could be re-examined, so it is the cost of parsing this row once; in
   * pieces, any cost that grew with the chunk count shows up against it.
   *
   * The bound is deliberately two orders of magnitude looser than the effect it looks for.
   * Correct implementations are insensitive to the chunk count; broken ones differ by well
   * over an order of magnitude. An earlier version of this gate chose chunk sizes that
   * produced only a single-digit effect and then
   * tried to resolve it against a threshold — which failed in both directions, because a
   * measurement of a few tens of milliseconds taken while the rest of the suite runs in
   * parallel varies by about that much. A wall clock cannot reliably resolve a small multiple
   * under that noise; an order-of-magnitude gap needs no resolving.
   *
   * The floor on the denominator is what keeps the bound above that noise rather than
   * proportional to a tiny baseline. It makes this partly an absolute budget, which is worth
   * naming, but leaves generous room for a correct implementation while the defect remains
   * comfortably beyond it.
   */
  /** One row whose single quoted field is `mb` megabytes of `unit` repeated. */
  function oneQuotedField(mb: number, unit: string): string {
    return `a,"${unit.repeat(Math.round((mb * 1048576) / unit.length))}",z\n`;
  }

  /** One row of `fields` unquoted 500-character fields. */
  function oneLongRow(fields: number, ending: string): string {
    return Array.from({ length: fields }, (_, c) => "x".repeat(500) + c).join(",") + ending;
  }

  it.each([
    // Sized per case so that a regression fails quickly but by a wide margin.
    ["standard mode", {}, () => oneLongRow(2000, "\n")],
    ["fastMode", { fastMode: true }, () => oneLongRow(8000, "\n")],
    [
      "fastMode with a multi-character lineEnding",
      { fastMode: true, lineEnding: "||" },
      () => oneLongRow(16000, "||")
    ],
    // A quoted field holds row terminators without being ended by them, so waiting on a
    // terminator wakes the scan on every chunk and re-reads the field. Relaxed quoting is kept
    // as a second shape because it decides a closing quote by what follows it, which is the
    // part of the boundary lexer a stricter grammar never exercises.
    ["a quoted field holding newlines", {}, () => oneQuotedField(2, `${"y".repeat(79)}\n`)],
    [
      "a relaxed quoted field holding interior quotes and newlines",
      { relaxQuotes: true },
      () => oneQuotedField(2, 'abcdefgh"x\n')
    ],
    [
      "a row holding many quoted fields",
      {},
      () => `${Array.from({ length: 8000 }, () => '"x"').join(",")}\n`
    ],
    [
      "delimiter detection through an initial multi-line quoted record",
      { delimiter: "" },
      () => `"${`${"x".repeat(63)}\n`.repeat(2000)}tail",b\n`
    ]
  ])("costs the same however the row is chunked (%s)", async (_label, options, build) => {
    const csv = build();

    const whole = await bestMsToParse(csv, csv.length, options, 2);
    const chunked = await bestMsToParse(csv, 8 * 1024, options, 2);

    expect(whole.rows).toHaveLength(1);
    expect(chunked.rows).toEqual(whole.rows);
    expect(chunked.ms).toBeLessThan(Math.max(whole.ms, 60) * 10);
  });

  /**
   * Auto-detection must not re-score its candidates once per record it skips. These shapes
   * starve the sample — a comment never joins it, and an unterminated quoted record has no
   * boundary yet — so the skip loop runs once per line, which is where a rescan compounds.
   *
   * Compared against a smaller input of the same shape rather than against a different
   * chunking, because the defect is quadratic in the number of records and shows up whether
   * the input arrives whole or in pieces. Measured on the broken form the larger input is over
   * fifty times the smaller; correct, it is under twice.
   */
  it.each([
    [
      "a long comment prefix",
      { delimiter: "", comment: "#" },
      (n: number) => `${`#${"x".repeat(60)}\n`.repeat(n)}a;b\n1;2\n`
    ],
    [
      "a long multi-line first quoted record",
      { delimiter: "" },
      (n: number) => `"${`${"x".repeat(63)}\n`.repeat(n)}tail";b\n1;2\n`
    ]
  ])(
    "detects the delimiter in time linear in the skipped prefix (%s)",
    async (_l, options, build) => {
      const small = await bestMsToParse(build(500), 64 * 1024, options, 2);
      const large = await bestMsToParse(build(4000), 64 * 1024, options, 2);

      // Whatever the detector concludes, a streamed parse must conclude the same as a batch
      // one, and must not take longer because the skipped prefix is longer.
      expect(small.rows).toEqual(Csv.parse(build(500), options));
      expect(large.rows).toEqual(Csv.parse(build(4000), options));
      expect(large.ms).toBeLessThan(Math.max(small.ms, 60) * 10);
    }
  );

  for (const fastMode of [false, true]) {
    const mode = fastMode ? "fastMode" : "standard mode";

    // The mark held across chunks must not swallow a line ending that straddles it.
    it(`finds a CRLF split across the chunk boundary (${mode})`, async () => {
      const rows = await feedInChunks("a,b\r\nc,d\r\ne,f\r\n", 4, { fastMode });

      expect(rows).toEqual([
        ["a", "b"],
        ["c", "d"],
        ["e", "f"]
      ]);
    });

    it(`finds a lone CR at a chunk boundary (${mode})`, async () => {
      const rows = await feedInChunks("a,b\rc,d\re,f\r", 4, { fastMode });

      expect(rows).toEqual([
        ["a", "b"],
        ["c", "d"],
        ["e", "f"]
      ]);
    });

    it(`parses one character at a time (${mode})`, async () => {
      const rows = await feedInChunks("a,b\r\nc,d\ne,f\rg,h", 1, { fastMode });

      expect(rows).toEqual([
        ["a", "b"],
        ["c", "d"],
        ["e", "f"],
        ["g", "h"]
      ]);
    });

    it(`parses a row longer than the chunk one character at a time (${mode})`, async () => {
      const rows = await feedInChunks(`${"a".repeat(40)},${"b".repeat(40)}\r\n`, 1, {
        fastMode
      });

      expect(rows).toEqual([["a".repeat(40), "b".repeat(40)]]);
    });
  }

  // A multi-character lineEnding can straddle the mark by more than one character, so
  // fastMode has to back the mark off by the whole ending less one.
  it.each([2, 3, 5, 7])(
    "finds a multi-character lineEnding split across a %i-character chunk (fastMode)",
    async chunkSize => {
      const rows = await feedInChunks("a,b||c,d||e,f||", chunkSize, {
        fastMode: true,
        lineEnding: "||"
      });

      expect(rows).toEqual([
        ["a", "b"],
        ["c", "d"],
        ["e", "f"]
      ]);
    }
  );

  it.each([
    [
      "||",
      ["a,b|||", "c,d||"],
      [
        ["a", "b"],
        ["|c", "d"]
      ]
    ],
    ["aa", ["xaaa", "yaa"], [["x"], ["ay"]]],
    ["abab", ["xababab", "yabab"], [["x"], ["aby"]]]
  ])(
    "keeps the unmatched prefix of a self-overlapping lineEnding (%s)",
    async (lineEnding, chunks, expected) => {
      const parser = new CsvParserStream({ fastMode: true, lineEnding });
      const collected = collectRows(parser);
      Readable.from(chunks).pipe(parser);

      expect(await collected).toEqual(expected);
    }
  );

  it("keeps a trailing CR as data with a custom lineEnding", async () => {
    const parser = new CsvParserStream({
      fastMode: true,
      lineEnding: "||",
      info: true,
      raw: true
    });
    const collected = collectRows(parser);
    Readable.from(["a,b\r"]).pipe(parser);

    expect(await collected).toEqual([
      {
        record: ["a", "b\r"],
        info: expect.objectContaining({ line: 1, offset: 0, raw: "a,b\r" })
      }
    ]);
  });

  it("does not count CR or LF content as lines with a custom lineEnding", async () => {
    const parser = new CsvParserStream({
      fastMode: true,
      lineEnding: "||",
      info: true,
      raw: true,
      toLine: 2
    });
    const collected = collectRows(parser);
    Readable.from(["a\rb||c\nd||"]).pipe(parser);

    const rows = await collected;
    expect(rows.map(row => row.record)).toEqual([["a\rb"], ["c\nd"]]);
    expect(rows.map(row => row.info.line)).toEqual([1, 2]);
    expect(rows.map(row => row.info.raw)).toEqual(["a\rb", "c\nd"]);
  });

  it("waits for a complete first data line before auto-detecting the delimiter", async () => {
    const parser = new CsvParserStream({ fastMode: true, delimiter: "" });
    const collected = collectRows(parser);
    Readable.from(["a", ";b;c\n", "1;2;3\n"]).pipe(parser);

    expect(await collected).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("does not mistake the continuation of a split comment for a data line", async () => {
    const parser = new CsvParserStream({ fastMode: true, delimiter: "", comment: "#" });
    const collected = collectRows(parser);
    Readable.from(["# a long com", "ment\na", ";b;c\n", "1;2;3\n"]).pipe(parser);

    expect(await collected).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("does not auto-detect from a newline inside the first quoted field", async () => {
    const parser = new CsvParserStream({ delimiter: "" });
    const collected = collectRows(parser);
    Readable.from(['"a\n', 'b";c;d\n', "1;2;3\n"]).pipe(parser);

    expect(await collected).toEqual([
      ["a\nb", "c", "d"],
      ["1", "2", "3"]
    ]);
  });

  /**
   * Streaming and `Csv.parse` must not disagree, which for auto-detection means the stream
   * cannot commit on a smaller sample than the batch detector scores. These are the shapes
   * where a prefix and the whole input point at different delimiters.
   */
  it.each([
    ['a,b;"x\ny";c;d\n1;2;3;4\n', ";"],
    ['a,"x;b;c\n1;2;3\n', ";"],
    ["a;b\n1;2\n", ";"],
    ["a,b\n1,2\n", ","]
  ])("agrees with Csv.parse about the delimiter for %j", async (input, expectedDelimiter) => {
    const options = { delimiter: "", delimitersToGuess: [",", ";"] };
    const sync = Csv.parse(input, options) as string[][];

    const parser = new CsvParserStream(options);
    let detected = "";
    parser.on("delimiter", value => {
      detected = value;
    });
    const collected = collectRows(parser);
    Readable.from(input.split("")).pipe(parser);

    expect(await collected).toEqual(sync);
    expect(detected).toBe(expectedDelimiter);
  });

  /**
   * A candidate that has not yet been asked to consume anything must not be mistaken for one
   * that cannot. Readiness treats a candidate holding a sample's worth of undigested text as
   * unable to complete another record — true only once its scanner has been drained, and the
   * check used to run before that. Any first chunk of at least that size therefore looked
   * stuck, and the delimiter was decided on however much text happened to arrive first.
   *
   * The records here are wider than the sample bound, so the prefix that arrives in one chunk
   * ends mid-record, and the truncated tail scored as if it were whole. 65536 is not arbitrary:
   * it is `fs.createReadStream`'s default `highWaterMark`, so a file on disk is delivered in
   * exactly the pieces that triggered this.
   */
  it("detects the same delimiter whatever the first chunk size", async () => {
    const record = `a,b,c${"x".repeat(8989)};d;e;f`;
    const csv = `${Array.from({ length: 12 }, () => record).join("\n")}\n`;
    const options = { delimiter: "", columnMismatch: { less: "pad", more: "keep" } } as const;
    const expected = Csv.parse(csv, options);

    for (const chunkSize of [65536, 65600, 66000, 70000, 80000, csv.length]) {
      expect(await feedInChunks(csv, chunkSize, options)).toEqual(expected);
    }
  });

  /**
   * `lineEnding` reaches the detector only in fastMode, because only fastMode ends records at
   * it; standard mode always ends them at CR/LF, so sampling by `||` there would weigh the
   * candidates on boundaries the parse never uses — and on a boundary the batch detector does
   * not use either, which is how the two come to disagree.
   *
   * The cost of that choice is what this gate holds down. Standard mode finds no CR/LF here,
   * so the input is one record and detection cannot conclude before end of input: every
   * candidate is fed the whole file. That is linear and it is the price of batch and stream
   * scoring the same sample, but it is only linear if deciding does not re-read what is
   * buffered — a per-chunk rescan turns this shape quadratic.
   */
  it("stays linear when standard mode never reaches the configured lineEnding", async () => {
    const options = { delimiter: "", lineEnding: "||" } as const;
    const build = (mb: number) => "a;bbbbbbbb;ccccccccc||".repeat(Math.round((mb * 1048576) / 22));

    const small = await bestMsToParse(build(2), 64 * 1024, options, 2);
    const large = await bestMsToParse(build(8), 64 * 1024, options, 2);

    expect(small.rows).toEqual(Csv.parse(build(2), options));
    expect(large.rows).toEqual(Csv.parse(build(8), options));
    // Four times the input, so a linear detector stays well inside a tenfold bound.
    expect(large.ms).toBeLessThan(Math.max(small.ms, 60) * 10);
  });

  /**
   * With quoting off, a lone quote is data. Detection coerced a disabled quote back to `"`,
   * so it scored by a grammar the parse would not use and could pick a different delimiter
   * from the one the rows were then split on.
   */
  it("detects with quoting disabled rather than assuming a quote character", async () => {
    const options = { delimiter: "", quote: false } as const;
    const csv = '"x;y;z\na;b;c\nd;e;f\ng;h;i\nj;k;l\n';

    const parser = new CsvParserStream(options);
    let detected = "";
    parser.on("delimiter", (value: string) => {
      detected = value;
    });
    const collected = collectRows(parser);
    Readable.from(csv.split("")).pipe(parser);

    expect(await collected).toEqual(Csv.parse(csv, options));
    expect(detected).toBe(";");
  });

  it("does not spin on an input whose records are all blank with a custom lineEnding", async () => {
    // The detection loop used to trim its own input while holding a stale length bound.
    const options = { delimiter: "", fastMode: true, lineEnding: "||" };
    for (const input of ["||", "\n||", "a||"]) {
      expect(await feedInChunks(input, input.length, options)).toEqual(Csv.parse(input, options));
      expect(await feedInChunks(input, 1, options)).toEqual(Csv.parse(input, options));
    }
  });

  it("releases the detection sample once the delimiter is committed", async () => {
    // A candidate whose quoting never closes must not hold the stream until end of input.
    const header = 'h1;h2,"x;h3;h4';
    const csv = `${header}\n${Array.from({ length: 40000 }, (_, i) => `a${i};b${i};c${i};d${i}`).join("\n")}\n`;
    let firstRowAfter = -1;
    let fed = 0;

    const parser = new CsvParserStream({ delimiter: "" });
    parser.on("data", () => {
      if (firstRowAfter === -1) {
        firstRowAfter = fed;
      }
    });
    const collected = collectRows(parser);
    const chunks: string[] = [];
    for (let i = 0; i < csv.length; i += 8192) {
      chunks.push(csv.slice(i, i + 8192));
    }
    Readable.from(
      (function* () {
        for (const chunk of chunks) {
          fed += chunk.length;
          yield chunk;
        }
      })()
    ).pipe(parser);

    expect(await collected).toEqual(Csv.parse(csv, { delimiter: "" }));
    expect(firstRowAfter).toBeGreaterThan(0);
    // Bounded by the detection sample, not by the file: it used to be the whole input.
    expect(firstRowAfter).toBeLessThan(csv.length / 4);
  });

  // Same options must mean the same thing to Csv.parse and to a stream. An empty candidate list
  // once meant "no candidates, fall back to comma" to one and "not configured, use the
  // defaults" to the other, so both the agreement and the chosen delimiter are asserted.
  it("reads an empty delimitersToGuess as unset, like Csv.parse", async () => {
    const options = { delimiter: "", delimitersToGuess: [] as string[] };
    const input = "a;b\n1;2\n";
    const expected = [
      ["a", "b"],
      ["1", "2"]
    ];

    expect(Csv.parse(input, options)).toEqual(expected);
    expect(await feedInChunks(input, input.length, options)).toEqual(expected);
    expect(await feedInChunks(input, 3, options)).toEqual(expected);
  });

  // A CR at end of input terminates a record under the default grammar, so the batch splitter
  // yields the empty record after it. The stream used to drop the CR and emit nothing.
  it.each(["a\n\r", "a\r", "\r", "a\n\r\n", "a,b\rc,d\r"])(
    "ends fastMode input on a trailing CR the same way as Csv.parse (%j)",
    async input => {
      const options = { fastMode: true };
      const expected = Csv.parse(input, options);

      expect(await feedInChunks(input, input.length, options)).toEqual(expected);
      expect(await feedInChunks(input, 1, options)).toEqual(expected);
    }
  );

  describe("first-chunk preprocessing matches Csv.parse", () => {
    it("rejects a beforeFirstChunk return value that is not a string", async () => {
      const options = { beforeFirstChunk: (() => 123) as never };

      expect(() => Csv.parse("a,b\n", options)).toThrow(CsvError);
      await expect(feedInChunks("a,b\n", 4, options)).rejects.toThrow(CsvError);
    });

    it("runs the hook even when the stream carries no data", async () => {
      const options = { delimiter: ";", beforeFirstChunk: () => "a;b\n" };

      expect(await feedInChunks("", 1, options)).toEqual(Csv.parse("", options));
    });

    it("strips a BOM the hook leaves behind, after the hook has run", async () => {
      const options = { beforeFirstChunk: (chunk: string) => `\uFEFF${chunk}` };
      const input = "a,b\n";

      expect(await feedInChunks(input, 2, options)).toEqual(Csv.parse(input, options));
    });
  });

  it("uses every candidate delimiter to classify quotes before auto-detection", async () => {
    const parser = new CsvParserStream({ delimiter: "" });
    const collected = collectRows(parser);
    // The comma before the quote makes a temporary comma scanner see the quote mid-field,
    // while the real semicolon delimiter makes it the start of a quoted field.
    Readable.from(['a,b;"x\n', 'y";c;d\n1;2;3;4\n']).pipe(parser);

    expect(await collected).toEqual([
      ["a,b", "x\ny", "c", "d"],
      ["1", "2", "3", "4"]
    ]);
  });

  it("keeps delimiter detection chunk-independent with a custom lineEnding", async () => {
    const options = {
      delimiter: "",
      fastMode: true,
      lineEnding: "||",
      delimitersToGuess: [",", ";"]
    };
    const input = "a,b,c,d;e||x;y||p;q||m;n||";
    const expected = [
      ["a,b,c,d", "e"],
      ["x", "y"],
      ["p", "q"],
      ["m", "n"]
    ];

    expect(await feedInChunks(input, input.length, options)).toEqual(expected);
    expect(await feedInChunks(input, 12, options)).toEqual(expected);
  });

  // Detection commits once it holds the sample the batch detector reads, without waiting for
  // end of input. A custom lineEnding counts records by its own separator, which is the part
  // that was structurally unable to advance at all.
  it("emits once the detection sample is complete, without waiting for EOF", () => {
    const parser = new CsvParserStream({
      delimiter: "",
      fastMode: true,
      lineEnding: "||",
      delimitersToGuess: [",", ";"]
    });
    const rows: string[][] = [];
    parser.on("data", row => rows.push(row as string[]));

    parser.write(`${Array.from({ length: 10 }, (_, i) => `a${i};b${i}`).join("||")}||`);

    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows[0]).toEqual(["a0", "b0"]);
  });

  it.each([
    [
      "a distinct escape",
      '"a\\",,x";b;c\n"a\\",,x";d;e\n',
      { escape: "\\" },
      [
        ['a",,x', "b", "c"],
        ['a",,x', "d", "e"]
      ]
    ],
    [
      "relaxed quotes",
      '"a"x,,y";b;c\n"a"x,,y";d;e\n',
      { relaxQuotes: true },
      [
        ['a"x,,y', "b", "c"],
        ['a"x,,y', "d", "e"]
      ]
    ]
  ])(
    "uses the parser's actual quote semantics when detecting with %s",
    async (_, input, extra, expected) => {
      const options = { delimiter: "", delimitersToGuess: [",", ";"], ...extra };

      expect(await feedInChunks(input, input.length, options)).toEqual(expected);
      expect(await feedInChunks(input, 7, options)).toEqual(expected);
    }
  );

  it("uses the custom lineEnding to decide when auto-detection has a complete record", async () => {
    const parser = new CsvParserStream({ delimiter: "", fastMode: true, lineEnding: "||" });
    const collected = collectRows(parser);
    Readable.from(["a\rb", ";c|", "|1;2;3||"]).pipe(parser);

    expect(await collected).toEqual([
      ["a\rb", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("applies beforeFirstChunk to the first decoded text, not an empty UTF-8 fragment", async () => {
    const seen: string[] = [];
    const parser = new CsvParserStream({
      beforeFirstChunk(chunk) {
        seen.push(chunk);
        return chunk.replace("€", "currency");
      }
    });
    const collected = collectRows(parser);
    parser.write(new Uint8Array([0xe2]));
    parser.end(new Uint8Array([0x82, 0xac, 0x2c, 0x78, 0x0a]));

    expect(await collected).toEqual([["currency", "x"]]);
    expect(seen).toEqual(["€,x\n"]);
  });

  it("applies beforeFirstChunk when the decoder produces its first text at EOF", async () => {
    const seen: string[] = [];
    const parser = new CsvParserStream({
      beforeFirstChunk(chunk) {
        seen.push(chunk);
        return chunk.replace("�", "replacement");
      }
    });
    const collected = collectRows(parser);
    parser.end(new Uint8Array([0xe2]));

    expect(await collected).toEqual([["replacement"]]);
    expect(seen).toEqual(["�"]);
  });

  // A quoted field may hold row terminators, so finding one does not mean the row is
  // complete. Standard mode must not mistake it for one.
  it("parses a quoted field holding newlines across chunk boundaries", async () => {
    const embedded = "line1\nline2\r\nline3\rline4";
    const rows = await feedInChunks(`a,"${embedded}",z\nb,c,d\n`, 3);

    expect(rows).toEqual([
      ["a", "line1\nline2\nline3\nline4", "z"],
      ["b", "c", "d"]
    ]);
  });

  it("parses a quoted field longer than the chunk", async () => {
    const big = "y".repeat(200_000);
    const rows = await feedInChunks(`a,"${big}"\n`, 4096);

    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe(big);
  });
});

// =============================================================================
// Chunking Equivalence
// =============================================================================

/**
 * Chunking must not change the answer. That is a claim worth testing exhaustively rather
 * than by example, because the streaming scanner now *waits* rather than re-reading the
 * buffer on every chunk, and what it waits for depends on why it stalled: a row terminator
 * normally, but a closing quote while a quoted field is open.
 *
 * The quote case is decided by run parity — under RFC 4180 a quote is literal only as half
 * of a `""` pair, so an odd-length run of quotes closes the field — and the run may be split
 * across a chunk boundary. That is exactly the kind of rule that is right for every input
 * someone thought of and wrong for the one they did not, and its failure mode is the bad
 * one: a wait that never ends holds the row back to end of input rather than corrupting it
 * visibly.
 *
 * So every shape below is fed at every chunk size from one character upward, and compared
 * against the same input delivered whole. One character at a time is the case that splits
 * every run, every CRLF and every escape.
 */
describe("CsvParserStream - Chunking Equivalence", () => {
  const cases: Array<[string, string, object, string[][]]> = [
    [
      "plain",
      "a,b\nc,d\n",
      {},
      [
        ["a", "b"],
        ["c", "d"]
      ]
    ],
    ["escaped quote", '"a""b",c\n', {}, [['a"b', "c"]]],
    ["empty quoted", '"",""\n', {}, [["", ""]]],
    ["quoted mixed newlines", 'a,"b\nc\r\nd\re",f\n', {}, [["a", "b\nc\nd\ne", "f"]]],
    [
      "JSON-like quoted content",
      'id,payload\n1,"{\n  ""k"": ""v""\n}"\n',
      {},
      [
        ["id", "payload"],
        ["1", '{\n  "k": "v"\n}']
      ]
    ],
    ["unterminated quote", '"abc', {}, [["abc"]]],
    ["relaxed interior quote", '"a"b",c\n', { relaxQuotes: true }, [['a"b', "c"]]],
    [
      "relaxed quote before a split multi-character delimiter",
      '"a"||b\n',
      { relaxQuotes: true, delimiter: "||" },
      [["a", "b"]]
    ],
    [
      "distinct escape",
      '"a\\"b",c\n"d\\\\e",f\n',
      { escape: "\\" },
      [
        ['a"b', "c"],
        ["d\\e", "f"]
      ]
    ],
    [
      "relaxed distinct escape",
      '"a\\"b"c",d\n',
      { escape: "\\", relaxQuotes: true },
      [['a"b"c', "d"]]
    ],
    ["custom quote", "'a,b',c\n", { quote: "'" }, [["a,b", "c"]]],
    ["quoting disabled", '"a,b",c\n', { quote: null }, [['"a', 'b"', "c"]]],
    ["multi-character delimiter", "a||b|c||d\n", { delimiter: "||" }, [["a", "b|c", "d"]]],
    ["fastMode", '"a,b",c\n', { fastMode: true }, [['"a', 'b"', "c"]]],
    [
      "no trailing newline",
      "a,b\nc,d",
      {},
      [
        ["a", "b"],
        ["c", "d"]
      ]
    ],
    [
      "empty fields",
      "a,,b\n,,\n",
      {},
      [
        ["a", "", "b"],
        ["", "", ""]
      ]
    ]
  ];

  function feed(csv: string, chunkSize: number, options: object): Promise<any[]> {
    const chunks: string[] = [];
    for (let i = 0; i < csv.length; i += chunkSize) {
      chunks.push(csv.slice(i, i + chunkSize));
    }
    const parser = new CsvParserStream(options);
    const collected = collectRows(parser);
    Readable.from(chunks.length > 0 ? chunks : [""]).pipe(parser);
    return collected;
  }

  it.each(cases)(
    "%s parses correctly at every chunk size",
    async (_name, csv, options, expected) => {
      const whole = await feed(csv, csv.length || 1, options);
      expect(whole).toEqual(expected);

      for (let chunkSize = 1; chunkSize <= Math.min(csv.length, 12); chunkSize++) {
        expect(await feed(csv, chunkSize, options)).toEqual(whole);
      }
      for (const chunkSize of [16, 64, 1024]) {
        expect(await feed(csv, chunkSize, options)).toEqual(whole);
      }
    }
  );

  /**
   * A quote run split across a boundary is the state the wait carries between chunks, and it is
   * swept exhaustively over run length, offset and chunk size at the scanner level, where the
   * drive is synchronous. One end-to-end shape here confirms the stream carries that state
   * through the decoder and event plumbing rather than re-testing the scanner through it.
   */
  it("carries a split quote run through the stream", async () => {
    const csv = '"aa""""b",z\n"c""d",e\n';
    const whole = await feed(csv, csv.length, {});

    for (const chunkSize of [1, 2, 3, 5, 8]) {
      expect(await feed(csv, chunkSize, {})).toEqual(whole);
    }
  });
});
