/**
 * CSV Parse Tests - RFC 4180 Compliance
 *
 * Tests the CSV parser for compliance with RFC 4180:
 * @see https://tools.ietf.org/html/rfc4180
 *
 * RFC 4180 Key Points:
 * 1. Each record is on a separate line, delimited by CRLF
 * 2. Optional header line with same format as records
 * 3. Fields are separated by commas
 * 4. Fields containing commas, double-quotes, or line breaks must be enclosed in double-quotes
 * 5. Double-quotes in fields are escaped by doubling them
 * 6. Spaces are part of the field and should not be trimmed
 */

import { Csv } from "@csv/index";
import { describe, it, expect } from "vitest";

// =============================================================================
// Basic Parsing
// =============================================================================
describe("Basic Parsing", () => {
  it("should parse simple CSV with commas", () => {
    const input = "a,b,c\n1,2,3";
    const result = Csv.parse(input);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle CRLF line endings (RFC 4180 standard)", () => {
    const input = "a,b,c\r\n1,2,3\r\n4,5,6";
    const result = Csv.parse(input);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("should handle CR only line endings", () => {
    const input = "a,b,c\r1,2,3";
    const result = Csv.parse(input);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle LF only line endings", () => {
    const input = "a,b,c\n1,2,3";
    const result = Csv.parse(input);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle empty input", () => {
    const result = Csv.parse("");
    expect(result).toEqual([]);
  });

  it("should handle single field", () => {
    const result = Csv.parse("hello");
    expect(result).toEqual([["hello"]]);
  });

  it("should handle single row with multiple fields", () => {
    const result = Csv.parse("a,b,c,d,e");
    expect(result).toEqual([["a", "b", "c", "d", "e"]]);
  });

  it("should handle trailing newline", () => {
    const input = "a,b,c\n1,2,3\n";
    const result = Csv.parse(input);
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });
});

// =============================================================================
// Quoted Fields (RFC 4180 Section 2.5, 2.6, 2.7)
// =============================================================================
describe("Quoted Fields", () => {
  it("should parse quoted fields containing commas", () => {
    const input = '"hello, world",test';
    const result = Csv.parse(input);
    expect(result).toEqual([["hello, world", "test"]]);
  });

  it("should parse quoted fields containing newlines", () => {
    const input = '"line1\nline2",test';
    const result = Csv.parse(input);
    expect(result).toEqual([["line1\nline2", "test"]]);
  });

  it("should parse quoted fields containing CRLF", () => {
    const input = '"line1\r\nline2",test';
    const result = Csv.parse(input);
    // After normalization, \r\n becomes \n
    expect(result).toEqual([["line1\nline2", "test"]]);
  });

  it("should parse escaped double-quotes (RFC 4180 Section 2.7)", () => {
    const input = '"He said ""Hello""",test';
    const result = Csv.parse(input);
    expect(result).toEqual([['He said "Hello"', "test"]]);
  });

  it("should handle multiple escaped quotes", () => {
    const input = '"""quoted""",""""';
    const result = Csv.parse(input);
    expect(result).toEqual([['"quoted"', '"']]);
  });

  it("should handle empty quoted field", () => {
    const input = '"",test,""';
    const result = Csv.parse(input);
    expect(result).toEqual([["", "test", ""]]);
  });

  it("should handle quoted field at end of row", () => {
    const input = 'a,b,"c,d"';
    const result = Csv.parse(input);
    expect(result).toEqual([["a", "b", "c,d"]]);
  });

  it("should handle quoted field at start of row", () => {
    const input = '"a,b",c,d';
    const result = Csv.parse(input);
    expect(result).toEqual([["a,b", "c", "d"]]);
  });

  it("should handle all quoted fields", () => {
    const input = '"a","b","c"';
    const result = Csv.parse(input);
    expect(result).toEqual([["a", "b", "c"]]);
  });

  it("should handle quoted fields with only quotes inside", () => {
    const input = '""""';
    const result = Csv.parse(input);
    expect(result).toEqual([['"']]);
  });
});

// =============================================================================
// Empty Fields and Rows
// =============================================================================
describe("Empty Fields and Rows", () => {
  it("should handle empty fields", () => {
    const input = "a,,c";
    const result = Csv.parse(input);
    expect(result).toEqual([["a", "", "c"]]);
  });

  it("should handle multiple consecutive empty fields", () => {
    const input = "a,,,d";
    const result = Csv.parse(input);
    expect(result).toEqual([["a", "", "", "d"]]);
  });

  it("should handle empty field at start", () => {
    const input = ",b,c";
    const result = Csv.parse(input);
    expect(result).toEqual([["", "b", "c"]]);
  });

  it("should handle empty field at end", () => {
    const input = "a,b,";
    const result = Csv.parse(input);
    expect(result).toEqual([["a", "b", ""]]);
  });

  it("should handle row with only empty fields", () => {
    const input = ",,";
    const result = Csv.parse(input);
    expect(result).toEqual([["", "", ""]]);
  });

  it("should handle empty rows when skipEmptyLines is false", () => {
    const input = "a,b\n\nc,d";
    const result = Csv.parse(input, { skipEmptyLines: false });
    expect(result).toEqual([["a", "b"], [""], ["c", "d"]]);
  });

  it("should skip empty rows when skipEmptyLines is true", () => {
    const input = "a,b\n\nc,d";
    const result = Csv.parse(input, { skipEmptyLines: true });
    expect(result).toEqual([
      ["a", "b"],
      ["c", "d"]
    ]);
  });
});

// =============================================================================
// Whitespace Handling (RFC 4180 Section 2.4)
// =============================================================================
describe("Whitespace Handling", () => {
  it("should preserve leading/trailing spaces by default (RFC 4180)", () => {
    const input = " a , b , c ";
    const result = Csv.parse(input);
    expect(result).toEqual([[" a ", " b ", " c "]]);
  });

  it("should trim whitespace when trim option is true", () => {
    const input = " a , b , c ";
    const result = Csv.parse(input, { trim: true });
    expect(result).toEqual([["a", "b", "c"]]);
  });

  it("should preserve spaces inside quoted fields", () => {
    const input = '" a "," b "';
    const result = Csv.parse(input);
    expect(result).toEqual([[" a ", " b "]]);
  });

  it("should preserve tabs as part of field", () => {
    const input = "a\tb,c";
    const result = Csv.parse(input);
    expect(result).toEqual([["a\tb", "c"]]);
  });
});

// =============================================================================
// Custom Delimiters
// =============================================================================
describe("Custom Delimiters", () => {
  it("should support tab delimiter (TSV)", () => {
    const input = "a\tb\tc\n1\t2\t3";
    const result = Csv.parse(input, { delimiter: "\t" });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should support semicolon delimiter", () => {
    const input = "a;b;c\n1;2;3";
    const result = Csv.parse(input, { delimiter: ";" });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should support pipe delimiter", () => {
    const input = "a|b|c\n1|2|3";
    const result = Csv.parse(input, { delimiter: "|" });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle quoted fields with custom delimiter", () => {
    const input = '"a;b";c;d';
    const result = Csv.parse(input, { delimiter: ";" });
    expect(result).toEqual([["a;b", "c", "d"]]);
  });
});

// =============================================================================
// Custom Quote Character
// =============================================================================
describe("Custom Quote Character", () => {
  it("should support single quote as quote character", () => {
    const input = "'hello, world',test";
    const result = Csv.parse(input, { quote: "'" });
    expect(result).toEqual([["hello, world", "test"]]);
  });

  it("should handle escaped single quotes", () => {
    const input = "'It''s a test',value";
    const result = Csv.parse(input, { quote: "'", escape: "'" });
    expect(result).toEqual([["It's a test", "value"]]);
  });

  it("should disable quoting when quote is null", () => {
    const input = '"hello",world';
    const result = Csv.parse(input, { quote: null });
    // Without quoting, the quotes are literal characters
    expect(result).toEqual([['"hello"', "world"]]);
  });

  it("should disable quoting when quote is false", () => {
    const input = '"hello",world';
    const result = Csv.parse(input, { quote: false });
    expect(result).toEqual([['"hello"', "world"]]);
  });
});

// =============================================================================
// Headers
// =============================================================================
describe("Headers", () => {
  it("should return objects when headers option is true", () => {
    const input = "name,age,city\nAlice,30,NYC\nBob,25,LA";
    const result = Csv.parse(input, { headers: true }) as any;
    expect(result.headers).toEqual(["name", "age", "city"]);
    expect(result.rows).toEqual([
      { name: "Alice", age: "30", city: "NYC" },
      { name: "Bob", age: "25", city: "LA" }
    ]);
  });

  it("should handle missing fields in data rows with pad option", () => {
    const input = "a,b,c\n1,2";
    const result = Csv.parse(input, {
      headers: true,
      columnMismatch: { less: "pad", more: "error" }
    }) as any;
    expect(result.rows).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("should handle extra fields in data rows with truncate option", () => {
    const input = "a,b\n1,2,3";
    const result = Csv.parse(input, {
      headers: true,
      columnMismatch: { less: "error", more: "truncate" }
    }) as any;
    expect(result.rows).toEqual([{ a: "1", b: "2" }]);
  });
});

// =============================================================================
// Skip Lines and Comments
// =============================================================================
describe("Skip Lines and Comments", () => {
  it("should skip lines at beginning", () => {
    const input = "header line\ncomment line\na,b,c\n1,2,3";
    const result = Csv.parse(input, { skipLines: 2 });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should skip comment lines", () => {
    const input = "a,b,c\n# this is a comment\n1,2,3";
    const result = Csv.parse(input, { comment: "#" });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle multiple comment lines", () => {
    const input = "# comment 1\n# comment 2\na,b,c";
    const result = Csv.parse(input, { comment: "#" });
    expect(result).toEqual([["a", "b", "c"]]);
  });
});

// =============================================================================
// Max Rows
// =============================================================================
describe("Max Rows", () => {
  it("should limit number of rows parsed", () => {
    const input = "a,b\n1,2\n3,4\n5,6\n7,8";
    const result = Csv.parse(input, { maxRows: 2 });
    expect(result).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("should handle maxRows with headers", () => {
    const input = "name,age\nAlice,30\nBob,25\nCharlie,35";
    const result = Csv.parse(input, { headers: true, maxRows: 2 }) as any;
    expect(result.headers).toEqual(["name", "age"]);
    expect(result.rows).toHaveLength(2);
  });
});

// =============================================================================
// Max Row Bytes (Security Feature)
// =============================================================================
describe("Max Row Bytes", () => {
  it("should throw error when row exceeds maxRowBytes in standard mode", () => {
    const input = "a,b,c\n123456789,data,more";
    expect(() => Csv.parse(input, { maxRowBytes: 10 })).toThrow(
      "Row exceeds the maximum size of 10 bytes"
    );
  });

  it("should allow rows under maxRowBytes limit", () => {
    const input = "a,b,c\n1,2,3";
    const result = Csv.parse(input, { maxRowBytes: 100 });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should throw error for unclosed quotes that exceed limit", () => {
    const input = 'a,b\n"very long content that never closes';
    expect(() => Csv.parse(input, { maxRowBytes: 20 })).toThrow(
      "Row exceeds the maximum size of 20 bytes"
    );
  });

  it("should reset byte counter for each row", () => {
    const input = "12345\nabcde\nfghij";
    const result = Csv.parse(input, { maxRowBytes: 10 });
    expect(result).toEqual([["12345"], ["abcde"], ["fghij"]]);
  });

  it("should not apply limit when maxRowBytes is undefined", () => {
    const input = "a".repeat(10000);
    const result = Csv.parse(input);
    expect((result as string[][])[0][0]).toHaveLength(10000);
  });
});

// =============================================================================
// fastMode
// =============================================================================
describe("fastMode", () => {
  it("should parse simple CSV in fastMode", () => {
    const input = "a,b,c\n1,2,3";
    const result = Csv.parse(input, { fastMode: true });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle custom delimiter in fastMode", () => {
    const input = "a;b;c\n1;2;3";
    const result = Csv.parse(input, { fastMode: true, delimiter: ";" });
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"]
    ]);
  });

  it("should handle empty string in fastMode", () => {
    // Empty string with fastMode - no rows
    const result = Csv.parse("", { fastMode: true });
    expect(result).toEqual([]);

    // With skipEmptyLines: true, same behavior
    const result2 = Csv.parse("", { fastMode: true, skipEmptyLines: true });
    expect(result2).toEqual([]);
  });

  it("should handle single field in fastMode", () => {
    const result = Csv.parse("value", { fastMode: true }) as string[][];
    expect(result).toEqual([["value"]]);
  });
});

// =============================================================================
// Csv.parseRows (Async Generator)
// =============================================================================
describe("parseCsvRows", () => {
  it("should parse CSV with async generator", async () => {
    const input = "a,b,c\n1,2,3\n4,5,6";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input)) {
      rows.push(row);
    }
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("should support headers in async generator", async () => {
    const input = "name,age\nAlice,30\nBob,25";
    const rows: any[] = [];
    for await (const row of Csv.parseRows(input, { headers: true })) {
      rows.push(row);
    }
    expect(rows).toEqual([
      { name: "Alice", age: "30" },
      { name: "Bob", age: "25" }
    ]);
  });

  it("should support async iterable input", async () => {
    async function* generateChunks() {
      yield "a,b,c\n";
      yield "1,2,3\n";
      yield "4,5,6";
    }
    const rows: any[] = [];
    for await (const row of Csv.parseRows(generateChunks())) {
      rows.push(row);
    }
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  // A `data` listener puts the parser in flowing mode, so a slow consumer used to have the
  // whole input read into an unbounded queue behind it.
  it("stops reading ahead when the consumer stops pulling", async () => {
    const total = 20000;
    let produced = 0;
    async function* generateChunks() {
      for (let i = 0; i < total; i++) {
        produced++;
        yield `${i},x\n`;
      }
    }

    const iterator = Csv.parseRows(generateChunks())[Symbol.asyncIterator]();
    await iterator.next();
    await new Promise(resolve => setTimeout(resolve, 100));
    const readAhead = produced;
    await iterator.return?.(undefined);

    expect(readAhead).toBeGreaterThan(0);
    expect(readAhead).toBeLessThan(total / 4);

    let consumed = 0;
    for await (const _row of Csv.parseRows(generateChunks())) {
      consumed++;
    }
    expect(consumed).toBe(total);
  });
});

// =============================================================================
// Roundtrip Verification
// =============================================================================
describe("Roundtrip", () => {
  it("parses and re-parses consistently", () => {
    const original = "a,b,c\n1,2,3\n4,5,6";
    const parsed = Csv.parse(original) as string[][];
    // Re-parse should give same result
    expect(parsed).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"]
    ]);
  });

  it("handles quoted fields in roundtrip", () => {
    const input = '"hello, world",test\n"line1\nline2",value';
    const parsed = Csv.parse(input) as string[][];
    expect(parsed[0][0]).toBe("hello, world");
    expect(parsed[1][0]).toBe("line1\nline2");
  });
});
