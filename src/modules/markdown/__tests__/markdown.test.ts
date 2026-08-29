/**
 * Markdown Module Tests
 *
 * Comprehensive tests covering:
 * - Parser: basic tables, alignment, escaping, edge cases, error handling
 * - Formatter: basic output, padding, alignment, escaping, compact mode
 * - Workbook integration: readMarkdown, writeMarkdown, round-trip fidelity
 * - parseMarkdownAll: multi-table document parsing
 */

import {
  readMarkdown,
  readMarkdownAll,
  writeMarkdown,
  writeMarkdownBuffer
} from "@excel/bridge/markdown-bridge";
import { readMarkdownFile } from "@excel/bridge/markdown-bridge.node";
import { cellGetValue, cellSetValue } from "@excel/core/cell";
import type { WorkbookData } from "@excel/core/workbook-core";
import { getSheetName, rowGetCell } from "@excel/core/worksheet";
import { Workbook, Worksheet } from "@excel/index";
import { MarkdownParseError } from "@markdown/errors";
import { formatMarkdown } from "@markdown/format/index";
import { parseMarkdown, parseMarkdownAll } from "@markdown/parse/index";
import { describe, it, expect, beforeEach } from "vitest";

// =============================================================================
// Parser Tests
// =============================================================================

describe("parseMarkdown", () => {
  describe("basic parsing", () => {
    it("should parse a simple table", () => {
      const input = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([
        ["Alice", "30"],
        ["Bob", "25"]
      ]);
      expect(result.alignments).toEqual(["none", "none"]);
    });

    it("should parse a table without leading/trailing pipes", () => {
      const input = "Name | Age\n--- | ---\nAlice | 30\nBob | 25";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([
        ["Alice", "30"],
        ["Bob", "25"]
      ]);
    });

    it("should parse a single-column table", () => {
      const input = "| Name |\n| --- |\n| Alice |\n| Bob |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name"]);
      expect(result.rows).toEqual([["Alice"], ["Bob"]]);
    });

    it("should parse a table with only headers and no data rows", () => {
      const input = "| Name | Age |\n| --- | --- |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([]);
    });

    it("should parse a table with many columns", () => {
      const input = "| A | B | C | D | E |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |";
      const result = parseMarkdown(input);

      expect(result.headers).toHaveLength(5);
      expect(result.rows[0]).toHaveLength(5);
    });
  });

  describe("alignment detection", () => {
    it("should detect left alignment", () => {
      const input = "| Name |\n| :--- |\n| Alice |";
      const result = parseMarkdown(input);
      expect(result.alignments).toEqual(["left"]);
    });

    it("should detect right alignment", () => {
      const input = "| Amount |\n| ---: |\n| 100 |";
      const result = parseMarkdown(input);
      expect(result.alignments).toEqual(["right"]);
    });

    it("should detect center alignment", () => {
      const input = "| Status |\n| :---: |\n| Active |";
      const result = parseMarkdown(input);
      expect(result.alignments).toEqual(["center"]);
    });

    it("should detect mixed alignments", () => {
      const input =
        "| Left | Center | Right | None |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |";
      const result = parseMarkdown(input);
      expect(result.alignments).toEqual(["left", "center", "right", "none"]);
    });

    it("should handle long dashes in separator", () => {
      const input = "| Name |\n| :------: |\n| Alice |";
      const result = parseMarkdown(input);
      expect(result.alignments).toEqual(["center"]);
    });
  });

  describe("trimming and unescaping", () => {
    it("should trim cell whitespace by default", () => {
      const input = "|  Name  |  Age  |\n| --- | --- |\n|  Alice  |  30  |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows[0]).toEqual(["Alice", "30"]);
    });

    it("should preserve whitespace when trim is false", () => {
      const input = "|  Name  |  Age  |\n| --- | --- |\n|  Alice  |  30  |";
      const result = parseMarkdown(input, { trim: false });

      expect(result.headers).toEqual(["  Name  ", "  Age  "]);
      expect(result.rows[0]).toEqual(["  Alice  ", "  30  "]);
    });

    it("should unescape pipe characters", () => {
      const input = "| Formula |\n| --- |\n| a \\| b |";
      const result = parseMarkdown(input);
      expect(result.rows[0]).toEqual(["a | b"]);
    });

    it("should unescape backslashes", () => {
      const input = "| Path |\n| --- |\n| C:\\\\Users |";
      const result = parseMarkdown(input);
      expect(result.rows[0]).toEqual(["C:\\Users"]);
    });

    it("should not unescape when disabled", () => {
      const input = "| Formula |\n| --- |\n| a \\| b |";
      const result = parseMarkdown(input, { unescape: false });
      // With unescape disabled, the escaped pipe is preserved as literal characters
      // The parser still splits on unescaped pipes correctly
      expect(result.rows[0][0]).toContain("\\|");
    });
  });

  describe("column count normalization", () => {
    it("should pad rows with fewer columns", () => {
      const input = "| A | B | C |\n| --- | --- | --- |\n| 1 |";
      const result = parseMarkdown(input);

      expect(result.rows[0]).toEqual(["1", "", ""]);
    });

    it("should truncate rows with more columns", () => {
      const input = "| A | B |\n| --- | --- |\n| 1 | 2 | 3 | 4 |";
      const result = parseMarkdown(input);

      expect(result.rows[0]).toHaveLength(2);
      expect(result.rows[0]).toEqual(["1", "2"]);
    });
  });

  describe("options", () => {
    it("should skip empty rows by default", () => {
      const input = "| A |\n| --- |\n|  |\n| value |";
      const result = parseMarkdown(input);
      expect(result.rows).toEqual([["value"]]);
    });

    it("should keep empty rows when skipEmptyRows is false", () => {
      const input = "| A |\n| --- |\n|  |\n| value |";
      const result = parseMarkdown(input, { skipEmptyRows: false });
      expect(result.rows).toEqual([[""], ["value"]]);
    });

    it("should limit rows with maxRows", () => {
      const rows = Array.from({ length: 100 }, (_, i) => `| row${i} |`).join("\n");
      const input = `| Name |\n| --- |\n${rows}`;
      const result = parseMarkdown(input, { maxRows: 5 });

      expect(result.rows).toHaveLength(5);
      expect(result.rows[0]).toEqual(["row0"]);
      expect(result.rows[4]).toEqual(["row4"]);
    });
  });

  describe("non-table content", () => {
    it("should skip leading text before the table", () => {
      const input = "# Title\n\nSome text here.\n\n| Name | Age |\n| --- | --- |\n| Alice | 30 |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([["Alice", "30"]]);
    });

    it("should stop at trailing non-table content", () => {
      const input = "| Name |\n| --- |\n| Alice |\n\nSome text after table.\n\n| Other | Table |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name"]);
      expect(result.rows).toEqual([["Alice"]]);
    });

    it("should stop at empty line after table", () => {
      const input = "| A |\n| --- |\n| 1 |\n| 2 |\n\n| B |\n| --- |\n| 3 |";
      const result = parseMarkdown(input);

      expect(result.rows).toEqual([["1"], ["2"]]);
    });

    it("should not swallow prose containing a pipe after a piped table", () => {
      const input = "| A |\n| --- |\n| 1 |\nThis sentence uses a | pipe.";
      const result = parseMarkdown(input);

      expect(result.rows).toEqual([["1"]]);
    });

    it("should not swallow prose with pipe after a multi-column piped table", () => {
      const input = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\nSome text | more text";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([["Alice", "30"]]);
    });

    it("should still parse non-piped tables (no leading pipe)", () => {
      const input = "Name | Age\n--- | ---\nAlice | 30\nBob | 25";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([
        ["Alice", "30"],
        ["Bob", "25"]
      ]);
    });
  });

  describe("error handling", () => {
    it("should throw MarkdownParseError when no table is found", () => {
      expect(() => parseMarkdown("just some text")).toThrow(MarkdownParseError);
    });

    it("should throw MarkdownParseError for empty input", () => {
      expect(() => parseMarkdown("")).toThrow(MarkdownParseError);
    });

    it("should throw MarkdownParseError for header without separator", () => {
      expect(() => parseMarkdown("| Name | Age |")).toThrow(MarkdownParseError);
    });

    it("should throw MarkdownParseError for separator without header", () => {
      expect(() => parseMarkdown("| --- | --- |")).toThrow(MarkdownParseError);
    });

    it("should have line number in error", () => {
      try {
        parseMarkdown("no table here");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MarkdownParseError);
        expect((e as MarkdownParseError).line).toBe(1);
      }
    });

    it("should report actual line count for multi-line input with no table", () => {
      try {
        parseMarkdown("line 1\nline 2\nline 3\nline 4\nline 5");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MarkdownParseError);
        expect((e as MarkdownParseError).line).toBe(5);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle Windows-style line endings (CRLF)", () => {
      const input = "| Name |\r\n| --- |\r\n| Alice |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name"]);
      expect(result.rows).toEqual([["Alice"]]);
    });

    it("should handle old Mac line endings (CR)", () => {
      const input = "| Name |\r| --- |\r| Alice |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name"]);
      expect(result.rows).toEqual([["Alice"]]);
    });

    it("should handle compact tables without spaces", () => {
      const input = "|Name|Age|\n|---|---|\n|Alice|30|";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["Name", "Age"]);
      expect(result.rows).toEqual([["Alice", "30"]]);
    });

    it("should handle cells with special characters", () => {
      const input = "| Symbol |\n| --- |\n| <div> |\n| `code` |\n| **bold** |";
      const result = parseMarkdown(input);

      expect(result.rows).toEqual([["<div>"], ["`code`"], ["**bold**"]]);
    });

    it("should handle single-dash separator", () => {
      const input = "| A |\n| - |\n| 1 |";
      const result = parseMarkdown(input);
      expect(result.headers).toEqual(["A"]);
    });

    it("should handle unicode content", () => {
      const input = "| \u540d\u524d | \u5e74\u9f62 |\n| --- | --- |\n| \u592a\u90ce | 30 |";
      const result = parseMarkdown(input);

      expect(result.headers).toEqual(["\u540d\u524d", "\u5e74\u9f62"]);
      expect(result.rows).toEqual([["\u592a\u90ce", "30"]]);
    });

    it("should handle emoji content", () => {
      const input = "| Icon | Name |\n| --- | --- |\n| \ud83d\ude00 | Smile |";
      const result = parseMarkdown(input);
      expect(result.rows[0]).toEqual(["\ud83d\ude00", "Smile"]);
    });

    it("should handle cells with only whitespace", () => {
      const input = "| A | B |\n| --- | --- |\n|   |   |";
      const result = parseMarkdown(input, { skipEmptyRows: false });
      // With trim=true (default), whitespace cells become empty
      expect(result.rows[0]).toEqual(["", ""]);
    });

    it("should handle many escaped pipes in a single cell", () => {
      const input = "| A |\n| --- |\n| a \\| b \\| c \\| d |";
      const result = parseMarkdown(input);
      expect(result.rows[0]).toEqual(["a | b | c | d"]);
    });

    it("should handle adjacent escaped characters", () => {
      const input = "| A |\n| --- |\n| \\|\\|\\\\ |";
      const result = parseMarkdown(input);
      expect(result.rows[0]).toEqual(["||\\"]); // \| \| \\ → || \
    });

    it("should handle a table with trailing escaped pipe", () => {
      const input = "| A |\n| --- |\n| test\\|";
      const result = parseMarkdown(input);
      // trailing pipe is escaped, so it's part of the content
      expect(result.rows[0][0]).toContain("|");
    });

    it("should handle double-backslash before trailing pipe (\\\\|)", () => {
      // \\| at end = escaped backslash + real trailing pipe
      const input = "| A |\n| --- |\n| foo\\\\|";
      const result = parseMarkdown(input);
      // The trailing pipe is real (even number of backslashes before it)
      // After unescaping: foo\  (the \\ becomes \)
      expect(result.rows[0]).toEqual(["foo\\"]);
    });

    it("should handle triple-backslash before trailing pipe (\\\\\\|)", () => {
      // \\\| at end = escaped backslash + escaped pipe
      const input = "| A |\n| --- |\n| foo\\\\\\|";
      const result = parseMarkdown(input);
      // The trailing pipe is escaped (odd number of backslashes)
      // foo + \\ (→\) + \| (→|) = "foo\|"
      expect(result.rows[0][0]).toContain("|");
    });
  });

  describe("multiline cell support (convertBr)", () => {
    it("should convert <br> to newline when convertBr is true", () => {
      const input = "| Note |\n| --- |\n| Line1<br>Line2 |";
      const result = parseMarkdown(input, { convertBr: true });
      expect(result.rows[0]).toEqual(["Line1\nLine2"]);
    });

    it("should convert <br/> to newline when convertBr is true", () => {
      const input = "| Note |\n| --- |\n| Line1<br/>Line2 |";
      const result = parseMarkdown(input, { convertBr: true });
      expect(result.rows[0]).toEqual(["Line1\nLine2"]);
    });

    it("should convert <br /> to newline when convertBr is true", () => {
      const input = "| Note |\n| --- |\n| Line1<br />Line2 |";
      const result = parseMarkdown(input, { convertBr: true });
      expect(result.rows[0]).toEqual(["Line1\nLine2"]);
    });

    it("should handle case-insensitive <BR> tags", () => {
      const input = "| Note |\n| --- |\n| Line1<BR>Line2<Br>Line3 |";
      const result = parseMarkdown(input, { convertBr: true });
      expect(result.rows[0]).toEqual(["Line1\nLine2\nLine3"]);
    });

    it("should NOT convert <br> when convertBr is false (default)", () => {
      const input = "| Note |\n| --- |\n| Line1<br>Line2 |";
      const result = parseMarkdown(input);
      expect(result.rows[0]).toEqual(["Line1<br>Line2"]);
    });

    it("should convert <br> in headers too", () => {
      const input = "| Multi<br>Line |\n| --- |\n| data |";
      const result = parseMarkdown(input, { convertBr: true });
      expect(result.headers).toEqual(["Multi\nLine"]);
    });

    it("should handle multiple <br> in one cell", () => {
      const input = "| Note |\n| --- |\n| A<br>B<br>C<br>D |";
      const result = parseMarkdown(input, { convertBr: true });
      expect(result.rows[0]).toEqual(["A\nB\nC\nD"]);
    });
  });
});

// =============================================================================
// parseMarkdownAll Tests
// =============================================================================

describe("parseMarkdownAll", () => {
  it("should parse multiple tables from a document", () => {
    const input = [
      "# Section 1",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Some text between tables.",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |"
    ].join("\n");

    const tables = parseMarkdownAll(input);

    expect(tables).toHaveLength(2);
    expect(tables[0].headers).toEqual(["A", "B"]);
    expect(tables[0].rows).toEqual([["1", "2"]]);
    expect(tables[1].headers).toEqual(["C", "D"]);
    expect(tables[1].rows).toEqual([["3", "4"]]);
  });

  it("should return empty array when no tables found", () => {
    const tables = parseMarkdownAll("just some text\nno tables here");
    expect(tables).toEqual([]);
  });

  it("should handle document with single table", () => {
    const input = "| A |\n| --- |\n| 1 |";
    const tables = parseMarkdownAll(input);

    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["A"]);
  });

  it("should apply maxRows per table", () => {
    const input = [
      "| A |",
      "| --- |",
      "| 1 |",
      "| 2 |",
      "| 3 |",
      "",
      "| B |",
      "| --- |",
      "| 4 |",
      "| 5 |",
      "| 6 |"
    ].join("\n");

    const tables = parseMarkdownAll(input, { maxRows: 2 });

    expect(tables).toHaveLength(2);
    expect(tables[0].rows).toHaveLength(2);
    expect(tables[1].rows).toHaveLength(2);
  });

  it("should apply convertBr across all tables", () => {
    const input = [
      "| Note |",
      "| --- |",
      "| A<br>B |",
      "",
      "| Info |",
      "| --- |",
      "| C<br/>D |"
    ].join("\n");

    const tables = parseMarkdownAll(input, { convertBr: true });

    expect(tables).toHaveLength(2);
    expect(tables[0].rows[0]).toEqual(["A\nB"]);
    expect(tables[1].rows[0]).toEqual(["C\nD"]);
  });
});

// =============================================================================
// Formatter Tests
// =============================================================================

describe("formatMarkdown", () => {
  describe("basic formatting", () => {
    it("should format a simple table with padding", () => {
      const result = formatMarkdown(
        ["Name", "Age"],
        [
          ["Alice", "30"],
          ["Bob", "25"]
        ]
      );

      const lines = result.trimEnd().split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe("| Name  | Age |");
      expect(lines[1]).toContain("---");
      expect(lines[2]).toBe("| Alice | 30  |");
      expect(lines[3]).toBe("| Bob   | 25  |");
    });

    it("should produce trailing newline by default", () => {
      const result = formatMarkdown(["A"], [["1"]]);
      expect(result.endsWith("\n")).toBe(true);
    });

    it("should omit trailing newline when disabled", () => {
      const result = formatMarkdown(["A"], [["1"]], { trailingNewline: false });
      expect(result.endsWith("\n")).toBe(false);
    });

    it("should return empty string for zero columns", () => {
      const result = formatMarkdown([], []);
      expect(result).toBe("");
    });

    it("should handle headers with no data rows", () => {
      const result = formatMarkdown(["A", "B"], []);
      const lines = result.trimEnd().split("\n");
      expect(lines).toHaveLength(2); // header + separator only
    });
  });

  describe("alignment", () => {
    it("should format left-aligned columns", () => {
      const result = formatMarkdown(["Name"], [["Alice"]], { alignment: "left" });
      const lines = result.trimEnd().split("\n");
      expect(lines[1]).toMatch(/^\|:[-]+/);
    });

    it("should format right-aligned columns", () => {
      const result = formatMarkdown(["Amount"], [["100"]], { alignment: "right" });
      const lines = result.trimEnd().split("\n");
      expect(lines[1]).toMatch(/[-]+:\|$/);
    });

    it("should format center-aligned columns", () => {
      const result = formatMarkdown(["Status"], [["OK"]], { alignment: "center" });
      const lines = result.trimEnd().split("\n");
      expect(lines[1]).toMatch(/^\|:[-]+:\|$/);
    });

    it("should support per-column alignment via columns config", () => {
      const result = formatMarkdown(["Left", "Center", "Right"], [["a", "b", "c"]], {
        columns: [
          { header: "Left", alignment: "left" },
          { header: "Center", alignment: "center" },
          { header: "Right", alignment: "right" }
        ]
      });

      const lines = result.trimEnd().split("\n");
      const sep = lines[1];
      // Left column: starts with :|
      expect(sep).toMatch(/\|:[-]+[^:]\|/);
      // Right column: ends with :|
      expect(sep).toMatch(/[-]+:\|$/);
    });

    it("should format none-aligned columns with plain dashes", () => {
      const result = formatMarkdown(["A"], [["x"]], { alignment: "none" });
      const lines = result.trimEnd().split("\n");
      // "none" alignment: separator is all dashes, no colons
      expect(lines[1]).toMatch(/^\|[-]+\|$/);
      expect(lines[1]).not.toContain(":");
    });
  });

  describe("compact mode (no padding)", () => {
    it("should produce compact output without extra spaces", () => {
      const result = formatMarkdown(
        ["Name", "Age"],
        [
          ["Alice", "30"],
          ["Bob", "25"]
        ],
        { padding: false }
      );

      const lines = result.trimEnd().split("\n");
      expect(lines[0]).toBe("| Name | Age |");
      expect(lines[2]).toBe("| Alice | 30 |");
      expect(lines[3]).toBe("| Bob | 25 |");
    });
  });

  describe("escaping", () => {
    it("should escape pipe characters in cell content", () => {
      const result = formatMarkdown(["Formula"], [["a | b"]]);
      expect(result).toContain("a \\| b");
    });

    it("should escape backslashes in cell content", () => {
      const result = formatMarkdown(["Path"], [["C:\\Users"]]);
      expect(result).toContain("C:\\\\Users");
    });

    it("should not escape when disabled", () => {
      const result = formatMarkdown(["Value"], [["a | b"]], { escapeContent: false });
      expect(result).not.toContain("\\|");
    });
  });

  describe("value stringification", () => {
    it("should convert null/undefined to empty string", () => {
      const result = formatMarkdown(["A", "B"], [[null, undefined]]);
      const lines = result.trimEnd().split("\n");
      expect(lines[2]).toMatch(/\|\s+\|\s+\|/);
    });

    it("should convert numbers to strings", () => {
      const result = formatMarkdown(["Value"], [[42]]);
      expect(result).toContain("42");
    });

    it("should convert booleans to strings", () => {
      const result = formatMarkdown(["Value"], [[true]]);
      expect(result).toContain("true");
    });

    it("should convert Date to ISO string by default", () => {
      const date = new Date("2024-01-15T12:00:00.000Z");
      const result = formatMarkdown(["Date"], [[date]]);
      expect(result).toContain("2024-01-15T12:00:00.000Z");
    });

    it("should use custom stringify function", () => {
      const result = formatMarkdown(["Value"], [[42]], {
        stringify: v => `*${v}*`
      });
      expect(result).toContain("*42*");
    });
  });

  describe("column configuration", () => {
    it("should accept string array as columns", () => {
      const result = formatMarkdown(["ignored"], [["value"]], {
        columns: ["Custom Header"]
      });
      expect(result).toContain("Custom Header");
    });

    it("should accept MarkdownColumnConfig objects", () => {
      const result = formatMarkdown(["ignored"], [["value"]], {
        columns: [{ header: "Custom", alignment: "right", minWidth: 10 }]
      });
      expect(result).toContain("Custom");
      const lines = result.trimEnd().split("\n");
      expect(lines[1]).toMatch(/[-]+:\|$/);
    });
  });

  describe("multiline cell content", () => {
    it("should convert literal newlines in cell values to <br>", () => {
      const result = formatMarkdown(["Note"], [["Line1\nLine2"]]);
      expect(result).toContain("Line1<br>Line2");
    });

    it("should handle CRLF newlines in cell values", () => {
      const result = formatMarkdown(["Note"], [["Line1\r\nLine2"]]);
      expect(result).toContain("Line1<br>Line2");
    });

    it("should handle CR newlines in cell values", () => {
      const result = formatMarkdown(["Note"], [["Line1\rLine2"]]);
      expect(result).toContain("Line1<br>Line2");
    });

    it("should handle multiple newlines in one cell", () => {
      const result = formatMarkdown(["Note"], [["A\nB\nC\nD"]]);
      expect(result).toContain("A<br>B<br>C<br>D");
    });

    it("should convert newlines even when escapeContent is false", () => {
      const result = formatMarkdown(["Note"], [["Line1\nLine2"]], { escapeContent: false });
      expect(result).toContain("Line1<br>Line2");
    });

    it("should handle newlines in header values", () => {
      const result = formatMarkdown(["Multi\nLine"], [["data"]]);
      expect(result).toContain("Multi<br>Line");
    });
  });

  describe("multiline round-trip (format → parse)", () => {
    it("should preserve multiline cell content through format → parse round-trip", () => {
      const formatted = formatMarkdown(["Note"], [["Line1\nLine2"]]);
      const parsed = parseMarkdown(formatted, { convertBr: true });
      expect(parsed.rows[0]).toEqual(["Line1\nLine2"]);
    });

    it("should preserve multiple newlines through round-trip", () => {
      const formatted = formatMarkdown(["Text"], [["A\nB\nC"]]);
      const parsed = parseMarkdown(formatted, { convertBr: true });
      expect(parsed.rows[0]).toEqual(["A\nB\nC"]);
    });

    it("should preserve all alignment types through format → parse round-trip", () => {
      const formatted = formatMarkdown(["L", "C", "R", "N"], [["a", "b", "c", "d"]], {
        columns: [
          { header: "L", alignment: "left" },
          { header: "C", alignment: "center" },
          { header: "R", alignment: "right" },
          { header: "N", alignment: "none" }
        ]
      });
      const parsed = parseMarkdown(formatted);
      expect(parsed.alignments).toEqual(["left", "center", "right", "none"]);
    });

    it("should preserve escaped content through format → parse round-trip", () => {
      const formatted = formatMarkdown(["Data"], [["a | b \\ c"]]);
      const parsed = parseMarkdown(formatted);
      expect(parsed.rows[0]).toEqual(["a | b \\ c"]);
    });
  });

  describe("large table performance", () => {
    it("should handle tables with many rows efficiently", () => {
      const rowCount = 1000;
      const headers = ["ID", "Name", "Value"];
      const rows: string[][] = [];
      for (let i = 0; i < rowCount; i++) {
        rows.push([String(i), `name_${i}`, String(i * 100)]);
      }

      const formatted = formatMarkdown(headers, rows);
      const parsed = parseMarkdown(formatted);

      expect(parsed.headers).toEqual(headers);
      expect(parsed.rows).toHaveLength(rowCount);
      expect(parsed.rows[0]).toEqual(["0", "name_0", "0"]);
      expect(parsed.rows[rowCount - 1]).toEqual([
        String(rowCount - 1),
        `name_${rowCount - 1}`,
        String((rowCount - 1) * 100)
      ]);
    });

    it("should handle tables with many columns efficiently", () => {
      const colCount = 50;
      const headers = Array.from({ length: colCount }, (_, i) => `Col${i}`);
      const rows = [Array.from({ length: colCount }, (_, i) => `val${i}`)];

      const formatted = formatMarkdown(headers, rows);
      const parsed = parseMarkdown(formatted);

      expect(parsed.headers).toHaveLength(colCount);
      expect(parsed.rows[0]).toHaveLength(colCount);
    });
  });

  describe("CJK/Unicode display width", () => {
    it("should account for CJK character width in padding", () => {
      const result = formatMarkdown(
        ["Name", "\u540d\u524d"],
        [
          ["Alice", "\u592a\u90ce"],
          ["Bob", "\u6b21\u90ce"]
        ]
      );

      const lines = result.trimEnd().split("\n");
      // All lines should have the same visual length
      // CJK chars (名前, 太郎, 次郎) are 2 columns each
      // So "名前" = 4 cols, "太郎" = 4 cols — header "Name" = 4 cols → should match
      // Each line in the same column should have equal character widths
      expect(lines[0].length).toBe(lines[2].length);
      expect(lines[0].length).toBe(lines[3].length);
    });

    it("should handle emoji display width", () => {
      const result = formatMarkdown(
        ["Icon", "Name"],
        [
          ["\ud83d\ude00", "Smile"],
          ["\ud83d\udc4d", "Thumbs"]
        ]
      );

      // Should not throw and produce valid output
      const parsed = parseMarkdown(result);
      expect(parsed.headers).toEqual(["Icon", "Name"]);
      expect(parsed.rows[0]).toEqual(["\ud83d\ude00", "Smile"]);
    });

    it("should handle fullwidth characters in padding", () => {
      const result = formatMarkdown(
        ["Normal", "Full"],
        [["abc", "\uff21\uff22\uff23"]] // Ａ Ｂ Ｃ (fullwidth)
      );

      const lines = result.trimEnd().split("\n");
      // Verify valid markdown output
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("Normal");
    });

    it("should measure display width from the shared full-width table", () => {
      // Column padding used to come from a private range list here, a near-copy of
      // `isFullWidthCodePoint` that was wrong in both directions. Compared per
      // character against a Latin baseline of the same length, so the assertion is
      // about column width and not about byte counts.
      const columns = (cell: string): number => {
        const repeated = cell.repeat(8);
        const width = (value: string): number =>
          formatMarkdown(["h"], [[value]]).split("\n")[0].length;
        return (width(repeated) - width("a".repeat(8))) / 8 + 1;
      };

      // Two columns: BMP emoji and a CJK compatibility square were counted as one.
      for (const wide of ["\u231a", "\u2614", "\u2b50", "\u33c0", "\u4e2d", "\uff01"]) {
        expect(columns(wide)).toBe(2);
      }
      // One column: every surrogate pair was counted as two, but a supplementary
      // plane character is not automatically wide — these are East Asian Width N.
      for (const narrow of ["\u{1d400}", "\u{10000}", "A"]) {
        expect(columns(narrow)).toBe(1);
      }
      // Still two columns, from the plane that genuinely is wide.
      expect(columns("\u{1f600}")).toBe(2);
    });
  });

  describe("compact mode separator alignment", () => {
    it("should produce consistent separator width in compact mode", () => {
      const result = formatMarkdown(
        ["Name", "Age"],
        [
          ["Alice", "30"],
          ["Bob", "25"]
        ],
        { padding: false }
      );

      const lines = result.trimEnd().split("\n");
      // In compact mode, separator should still be valid markdown
      expect(lines[1]).toContain("---");
      // Each separator cell should have at least the same width as the padding spaces
      const sepCells = lines[1].split("|").filter(Boolean);
      for (const cell of sepCells) {
        expect(cell.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});

// =============================================================================
// Workbook Integration Tests
// =============================================================================

describe("Workbook Markdown integration", () => {
  let workbook: WorkbookData;

  beforeEach(() => {
    workbook = Workbook.create();
  });

  describe("readMarkdown", () => {
    it("should create a worksheet from Markdown table", () => {
      const markdown = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
      const ws = readMarkdown(workbook, markdown);

      expect(ws).toBeDefined();
      expect(getSheetName(ws)).toBeDefined();
      expect(Worksheet.rowCount(ws)).toBe(3); // 1 header + 2 data
    });

    it("should set header row correctly", () => {
      const markdown = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
      const ws = readMarkdown(workbook, markdown);

      const headerRow = Worksheet.getRow(ws, 1);
      expect(cellGetValue(rowGetCell(headerRow, 1))).toBe("Name");
      expect(cellGetValue(rowGetCell(headerRow, 2))).toBe("Age");
    });

    it("should set data rows correctly", () => {
      const markdown = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
      const ws = readMarkdown(workbook, markdown);

      const dataRow = Worksheet.getRow(ws, 2);
      expect(cellGetValue(rowGetCell(dataRow, 1))).toBe("Alice");
      expect(cellGetValue(rowGetCell(dataRow, 2))).toBe("30");
    });

    it("should use custom sheet name", () => {
      const markdown = "| A |\n| --- |\n| 1 |";
      const ws = readMarkdown(workbook, markdown, { sheetName: "MyData" });
      expect(getSheetName(ws)).toBe("MyData");
    });

    it("should apply custom value mapper", () => {
      const markdown = "| Value |\n| --- |\n| 42 |\n| hello |";
      const ws = readMarkdown(workbook, markdown, {
        map: (v, _col) => {
          const num = Number(v);
          return Number.isNaN(num) ? v : num;
        }
      });

      expect(cellGetValue(rowGetCell(Worksheet.getRow(ws, 2), 1))).toBe(42);
      expect(cellGetValue(rowGetCell(Worksheet.getRow(ws, 3), 1))).toBe("hello");
    });
  });

  describe("readMarkdownAll", () => {
    it("should create multiple worksheets from a multi-table document", () => {
      const markdown = [
        "# Section 1",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "Some text.",
        "",
        "| C | D |",
        "| --- | --- |",
        "| 3 | 4 |"
      ].join("\n");

      const sheets = readMarkdownAll(workbook, markdown);

      expect(sheets).toHaveLength(2);
      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[0], 1), 1))).toBe("A");
      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[0], 2), 1))).toBe("1");
      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[1], 1), 1))).toBe("C");
      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[1], 2), 1))).toBe("3");
    });

    it("should return empty array for document with no tables", () => {
      const sheets = readMarkdownAll(workbook, "just some text\nno tables here");
      expect(sheets).toEqual([]);
    });

    it("should use sheetName as prefix for worksheet names", () => {
      const markdown = "| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |";
      const sheets = readMarkdownAll(workbook, markdown, { sheetName: "Data" });

      expect(sheets).toHaveLength(2);
      expect(getSheetName(sheets[0])).toBe("Data");
      expect(getSheetName(sheets[1])).toBe("Data_2");
    });

    it("should apply value mapper to all tables", () => {
      const markdown = "| V |\n| --- |\n| 10 |\n\n| V |\n| --- |\n| 20 |";
      const sheets = readMarkdownAll(workbook, markdown, {
        map: v => {
          const n = Number(v);
          return Number.isNaN(n) ? v : n;
        }
      });

      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[0], 2), 1))).toBe(10);
      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[1], 2), 1))).toBe(20);
    });

    it("should preserve alignments on each worksheet", () => {
      const markdown = "| L |\n| :--- |\n| a |\n\n| R |\n| ---: |\n| b |";
      const sheets = readMarkdownAll(workbook, markdown);

      expect((sheets[0] as any)._markdownAlignments).toEqual(["left"]);
      expect((sheets[1] as any)._markdownAlignments).toEqual(["right"]);
    });

    it("should apply convertBr across all tables", () => {
      const markdown = "| N |\n| --- |\n| A<br>B |\n\n| N |\n| --- |\n| C<br>D |";
      const sheets = readMarkdownAll(workbook, markdown, { convertBr: true });

      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[0], 2), 1))).toBe("A\nB");
      expect(cellGetValue(rowGetCell(Worksheet.getRow(sheets[1], 2), 1))).toBe("C\nD");
    });
  });

  describe("writeMarkdown", () => {
    it("should write empty string for empty workbook", () => {
      const result = writeMarkdown(workbook);
      expect(result).toBe("");
    });

    it("should write a valid Markdown table", () => {
      const ws = Workbook.addWorksheet(workbook, "Test");
      Worksheet.addRow(ws, ["Name", "Age"]);
      Worksheet.addRow(ws, ["Alice", 30]);
      Worksheet.addRow(ws, ["Bob", 25]);

      const result = writeMarkdown(workbook);
      expect(result).toContain("| Name");
      expect(result).toContain("---");
      expect(result).toContain("Alice");
    });

    it("should write specific worksheet by name", () => {
      Workbook.addWorksheet(workbook, "Sheet1");
      const ws2 = Workbook.addWorksheet(workbook, "Sheet2");
      Worksheet.addRow(ws2, ["Specific"]);
      Worksheet.addRow(ws2, ["Data"]);

      const result = writeMarkdown(workbook, { sheetName: "Sheet2" });
      expect(result).toContain("Specific");
    });

    it("should handle null/undefined cell values", () => {
      const ws = Workbook.addWorksheet(workbook, "Test");
      Worksheet.addRow(ws, ["A", "B"]);
      Worksheet.addRow(ws, [null, undefined]);

      const result = writeMarkdown(workbook);
      expect(result).toBeDefined();
      // Should not throw
    });

    it("should handle sparse rows (non-contiguous columns)", () => {
      const ws = Workbook.addWorksheet(workbook, "Sparse");
      Worksheet.addRow(ws, ["A", "B", "C"]);
      // Create a sparse row: only set columns 1 and 3
      const row = Worksheet.addRow(ws, []);
      cellSetValue(rowGetCell(row, 1), "x");
      cellSetValue(rowGetCell(row, 3), "z");

      const result = writeMarkdown(workbook, { sheetName: "Sparse" });
      expect(result).toBeDefined();
      const parsed = parseMarkdown(result);
      expect(parsed.headers).toEqual(["A", "B", "C"]);
      expect(parsed.rows[0][0]).toBe("x");
      expect(parsed.rows[0][1]).toBe(""); // sparse gap → empty
      expect(parsed.rows[0][2]).toBe("z");
    });
  });

  describe("writeMarkdownBuffer", () => {
    it("should return a Uint8Array", () => {
      const ws = Workbook.addWorksheet(workbook, "Test");
      Worksheet.addRow(ws, ["Name"]);
      Worksheet.addRow(ws, ["Alice"]);

      const buffer = writeMarkdownBuffer(workbook);
      expect(buffer).toBeInstanceOf(Uint8Array);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it("should encode as UTF-8", () => {
      const ws = Workbook.addWorksheet(workbook, "Test");
      Worksheet.addRow(ws, ["\u540d\u524d"]);
      Worksheet.addRow(ws, ["\u592a\u90ce"]);

      const buffer = writeMarkdownBuffer(workbook);
      const text = new TextDecoder().decode(buffer);
      expect(text).toContain("\u540d\u524d");
      expect(text).toContain("\u592a\u90ce");
    });
  });

  describe("round-trip (readMarkdown -> writeMarkdown)", () => {
    it("should preserve data through round-trip", () => {
      const original =
        "| Name | Age | City |\n| --- | --- | --- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |";

      const _ws = readMarkdown(workbook, original);
      const output = writeMarkdown(workbook);

      // Parse the output to verify content
      const reparsed = parseMarkdown(output);
      expect(reparsed.headers).toEqual(["Name", "Age", "City"]);
      expect(reparsed.rows).toEqual([
        ["Alice", "30", "NYC"],
        ["Bob", "25", "LA"]
      ]);
    });

    it("should preserve alignment through round-trip", () => {
      const original = "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |";

      readMarkdown(workbook, original);
      const output = writeMarkdown(workbook);

      const reparsed = parseMarkdown(output);
      expect(reparsed.alignments).toEqual(["left", "center", "right"]);
    });

    it("should handle escaped content through round-trip", () => {
      const original = "| Formula |\n| --- |\n| a \\| b |";

      readMarkdown(workbook, original);
      const output = writeMarkdown(workbook);

      const reparsed = parseMarkdown(output);
      expect(reparsed.rows[0][0]).toBe("a | b");
    });

    it("should preserve multiline cell content through Workbook round-trip", () => {
      // Simulate multiline content: write a cell with newline, read it back
      const ws = Workbook.addWorksheet(workbook, "Multi");
      Worksheet.addRow(ws, ["Note"]);
      Worksheet.addRow(ws, ["Line1\nLine2"]);

      const markdown = writeMarkdown(workbook, { sheetName: "Multi" });
      // The formatter should convert \n to <br>
      expect(markdown).toContain("<br>");

      // Parse back with convertBr to restore the newline
      const wb2 = Workbook.create();
      const ws2 = readMarkdown(wb2, markdown, { convertBr: true });
      expect(cellGetValue(rowGetCell(Worksheet.getRow(ws2, 2), 1))).toBe("Line1\nLine2");
    });
  });

  describe("readMarkdownFile / writeMarkdownFile browser stubs", () => {
    it("readMarkdownFile should throw in browser context simulation", async () => {
      // The base class (browser) throws ExcelNotSupportedError.
      // In Node.js test environment, the Node override will actually try to read the file.
      // We test that readMarkdownFile with non-existent file throws.
      await expect(readMarkdownFile(workbook, "/nonexistent/path.md")).rejects.toThrow();
    });
  });
});

// =============================================================================
// Error class tests
// =============================================================================

describe("MarkdownError classes", () => {
  it("MarkdownParseError should have line number", () => {
    const error = new MarkdownParseError("test error", 42);
    expect(error.line).toBe(42);
    expect(error.message).toContain("42");
    expect(error.message).toContain("test error");
    expect(error.name).toBe("MarkdownParseError");
  });

  it("MarkdownParseError should support error cause", () => {
    const cause = new Error("original");
    const error = new MarkdownParseError("wrapped", 1, { cause });
    expect(error.cause).toBe(cause);
  });
});
