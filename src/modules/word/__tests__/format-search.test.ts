/**
 * DOCX Module - Format Search Tests
 */

import { describe, it, expect } from "vitest";

import { searchByFormat, countByFormat, getUsedFormats } from "../query/format-search";
import type {
  DocxDocument,
  Paragraph,
  Run,
  Table,
  TableRow,
  TableCell,
  RunProperties
} from "../types";

// =============================================================================
// Helpers
// =============================================================================

function makeDoc(paragraphs: (Paragraph | Table)[]): DocxDocument {
  return { body: paragraphs };
}

function makePara(runs: Run[], style?: string): Paragraph {
  return {
    type: "paragraph",
    properties: style ? { style } : undefined,
    children: runs
  };
}

function makeRun(text: string, props?: RunProperties): Run {
  return {
    content: [{ type: "text", text }],
    properties: props
  };
}

function makeTable(cells: Paragraph[][]): Table {
  const rows: TableRow[] = cells.map(cellParagraphs => ({
    cells: cellParagraphs.map((para): TableCell => ({
      content: [para]
    }))
  }));
  return { type: "table", rows };
}

// =============================================================================
// Tests
// =============================================================================

describe("format-search", () => {
  describe("searchByFormat", () => {
    it("finds all bold runs", () => {
      const doc = makeDoc([
        makePara([
          makeRun("normal text"),
          makeRun("bold text", { bold: true }),
          makeRun("also bold", { bold: true, italic: true })
        ]),
        makePara([makeRun("another bold", { bold: true })])
      ]);

      const results = searchByFormat(doc, { bold: true });

      expect(results).toHaveLength(3);
      expect(results[0]!.text).toBe("bold text");
      expect(results[0]!.bodyIndex).toBe(0);
      expect(results[0]!.runIndex).toBe(1);
      expect(results[0]!.location).toBe("body");
      expect(results[1]!.text).toBe("also bold");
      expect(results[2]!.text).toBe("another bold");
      expect(results[2]!.bodyIndex).toBe(1);
      expect(results[2]!.runIndex).toBe(0);
    });

    it("finds runs with specific color", () => {
      const doc = makeDoc([
        makePara([
          makeRun("red text", { color: "FF0000" }),
          makeRun("blue text", { color: "0000FF" }),
          makeRun("also red", { color: "ff0000" })
        ])
      ]);

      const results = searchByFormat(doc, { color: "FF0000" });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("red text");
      expect(results[1]!.text).toBe("also red");
    });

    it("finds runs with color using ColorSpec object", () => {
      const doc = makeDoc([
        makePara([
          makeRun("themed red", { color: { val: "FF0000", themeColor: "accent1" } }),
          makeRun("plain text")
        ])
      ]);

      const results = searchByFormat(doc, { color: "ff0000" });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("themed red");
    });

    it("matches font case-insensitively", () => {
      const doc = makeDoc([
        makePara([
          makeRun("arial text", { font: "Arial" }),
          makeRun("times text", { font: "Times New Roman" }),
          makeRun("also arial", { font: "arial" })
        ])
      ]);

      const results = searchByFormat(doc, { font: "ARIAL" });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("arial text");
      expect(results[1]!.text).toBe("also arial");
    });

    it("matches font with FontSpec object", () => {
      const doc = makeDoc([
        makePara([
          makeRun("font spec run", { font: { ascii: "Calibri", hAnsi: "Calibri" } }),
          makeRun("plain run")
        ])
      ]);

      const results = searchByFormat(doc, { font: "calibri" });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("font spec run");
    });

    it("filters by paragraphStyle", () => {
      const doc = makeDoc([
        makePara([makeRun("heading text", { bold: true })], "Heading1"),
        makePara([makeRun("body bold", { bold: true })], "Normal"),
        makePara([makeRun("no style bold", { bold: true })])
      ]);

      const results = searchByFormat(doc, { paragraphStyle: "Heading1" });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("heading text");
      expect(results[0]!.paragraphStyle).toBe("Heading1");
    });

    it("filters by textMatch string", () => {
      const doc = makeDoc([
        makePara([
          makeRun("TODO: fix bug", { bold: true }),
          makeRun("normal bold", { bold: true }),
          makeRun("TODO: review", { bold: true })
        ])
      ]);

      const results = searchByFormat(doc, { bold: true, textMatch: "TODO" });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("TODO: fix bug");
      expect(results[1]!.text).toBe("TODO: review");
    });

    it("filters by textMatch regex", () => {
      const doc = makeDoc([
        makePara([
          makeRun("Error: something failed", { color: "FF0000" }),
          makeRun("Warning: be careful", { color: "FF0000" }),
          makeRun("info message", { color: "FF0000" })
        ])
      ]);

      const results = searchByFormat(doc, { color: "FF0000", textMatch: /^(Error|Warning):/ });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("Error: something failed");
      expect(results[1]!.text).toBe("Warning: be careful");
    });

    it("matches across runs even with /g RegExp (lastIndex must not bleed)", () => {
      // A `/g` regex retains lastIndex across `.test()` calls; a stateful
      // pattern would silently skip matches in later runs. The implementation
      // must reset lastIndex per call.
      const doc = makeDoc([
        makePara([
          makeRun("alpha TODO one", { bold: true }),
          makeRun("beta TODO two", { bold: true }),
          makeRun("gamma TODO three", { bold: true })
        ])
      ]);

      const pattern = /TODO/g;
      const results = searchByFormat(doc, { bold: true, textMatch: pattern });
      expect(results).toHaveLength(3);
    });

    it("uses AND logic for multiple criteria (bold + italic)", () => {
      const doc = makeDoc([
        makePara([
          makeRun("bold only", { bold: true }),
          makeRun("italic only", { italic: true }),
          makeRun("bold and italic", { bold: true, italic: true }),
          makeRun("plain text")
        ])
      ]);

      const results = searchByFormat(doc, { bold: true, italic: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("bold and italic");
    });

    it("matches underline criteria", () => {
      const doc = makeDoc([
        makePara([
          makeRun("underlined", { underline: "single" }),
          makeRun("not underlined"),
          makeRun("also underlined", { underline: true })
        ])
      ]);

      const results = searchByFormat(doc, { underline: true });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("underlined");
      expect(results[1]!.text).toBe("also underlined");
    });

    it("matches strikethrough criteria", () => {
      const doc = makeDoc([makePara([makeRun("struck", { strike: true }), makeRun("normal")])]);

      const results = searchByFormat(doc, { strike: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("struck");
    });

    it("matches font size criteria", () => {
      const doc = makeDoc([
        makePara([
          makeRun("big text", { size: 48 }),
          makeRun("small text", { size: 20 }),
          makeRun("also big", { size: 48 })
        ])
      ]);

      const results = searchByFormat(doc, { size: 48 });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("big text");
      expect(results[1]!.text).toBe("also big");
    });

    it("matches highlight criteria", () => {
      const doc = makeDoc([
        makePara([makeRun("highlighted", { highlight: "yellow" }), makeRun("not highlighted")])
      ]);

      const results = searchByFormat(doc, { highlight: "yellow" });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("highlighted");
    });

    it("matches superscript criteria", () => {
      const doc = makeDoc([
        makePara([
          makeRun("normal"),
          makeRun("sup", { vertAlign: "superscript" }),
          makeRun("sub", { vertAlign: "subscript" })
        ])
      ]);

      const results = searchByFormat(doc, { superscript: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("sup");
    });

    it("matches subscript criteria", () => {
      const doc = makeDoc([
        makePara([
          makeRun("normal"),
          makeRun("sup", { vertAlign: "superscript" }),
          makeRun("sub", { vertAlign: "subscript" })
        ])
      ]);

      const results = searchByFormat(doc, { subscript: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("sub");
    });

    it("matches caps criteria", () => {
      const doc = makeDoc([makePara([makeRun("caps text", { caps: true }), makeRun("normal")])]);

      const results = searchByFormat(doc, { caps: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("caps text");
    });

    it("matches smallCaps criteria", () => {
      const doc = makeDoc([
        makePara([makeRun("small caps", { smallCaps: true }), makeRun("normal")])
      ]);

      const results = searchByFormat(doc, { smallCaps: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("small caps");
    });

    it("matches hidden criteria", () => {
      const doc = makeDoc([
        makePara([makeRun("hidden text", { vanish: true }), makeRun("visible text")])
      ]);

      const results = searchByFormat(doc, { hidden: true });

      expect(results).toHaveLength(1);
      expect(results[0]!.text).toBe("hidden text");
    });

    it("matches characterStyle criteria", () => {
      const doc = makeDoc([
        makePara([
          makeRun("styled", { style: "Emphasis" }),
          makeRun("unstyled"),
          makeRun("also styled", { style: "Emphasis" })
        ])
      ]);

      const results = searchByFormat(doc, { characterStyle: "Emphasis" });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("styled");
      expect(results[1]!.text).toBe("also styled");
    });

    it("searches inside table cells", () => {
      const table = makeTable([
        [makePara([makeRun("cell bold", { bold: true })])],
        [makePara([makeRun("cell normal")])]
      ]);
      const doc = makeDoc([makePara([makeRun("body bold", { bold: true })]), table]);

      const results = searchByFormat(doc, { bold: true });

      expect(results).toHaveLength(2);
      expect(results[0]!.text).toBe("body bold");
      expect(results[0]!.bodyIndex).toBe(0);
      expect(results[1]!.text).toBe("cell bold");
      expect(results[1]!.bodyIndex).toBe(1);
    });

    it("returns empty array when no matches", () => {
      const doc = makeDoc([makePara([makeRun("plain text"), makeRun("more plain")])]);

      const results = searchByFormat(doc, { bold: true });

      expect(results).toHaveLength(0);
      expect(results).toEqual([]);
    });

    it("returns empty results for empty document", () => {
      const doc = makeDoc([]);

      const results = searchByFormat(doc, { bold: true });

      expect(results).toHaveLength(0);
      expect(results).toEqual([]);
    });

    it("returns all runs when criteria is empty", () => {
      const doc = makeDoc([makePara([makeRun("one"), makeRun("two", { bold: true })])]);

      const results = searchByFormat(doc, {});

      expect(results).toHaveLength(2);
    });
  });

  describe("countByFormat", () => {
    it("returns count of matching runs", () => {
      const doc = makeDoc([
        makePara([
          makeRun("bold1", { bold: true }),
          makeRun("normal"),
          makeRun("bold2", { bold: true })
        ]),
        makePara([makeRun("bold3", { bold: true })])
      ]);

      const count = countByFormat(doc, { bold: true });

      expect(count).toBe(3);
    });

    it("returns 0 for no matches", () => {
      const doc = makeDoc([makePara([makeRun("plain")])]);

      const count = countByFormat(doc, { italic: true });

      expect(count).toBe(0);
    });

    it("returns 0 for empty document", () => {
      const doc = makeDoc([]);

      const count = countByFormat(doc, { bold: true });

      expect(count).toBe(0);
    });
  });

  describe("getUsedFormats", () => {
    it("returns unique formats used in document", () => {
      const doc = makeDoc([
        makePara([
          makeRun("bold1", { bold: true }),
          makeRun("bold2", { bold: true }),
          makeRun("italic", { italic: true }),
          makeRun("bold italic", { bold: true, italic: true })
        ])
      ]);

      const formats = getUsedFormats(doc);

      expect(formats).toHaveLength(3);
    });

    it("returns empty array for document with no formatting", () => {
      const doc = makeDoc([makePara([makeRun("plain text")])]);

      const formats = getUsedFormats(doc);

      expect(formats).toHaveLength(0);
    });

    it("returns empty array for empty document", () => {
      const doc = makeDoc([]);

      const formats = getUsedFormats(doc);

      expect(formats).toHaveLength(0);
    });

    it("deduplicates formats with same properties", () => {
      const doc = makeDoc([
        makePara([
          makeRun("run1", { bold: true, size: 24 }),
          makeRun("run2", { bold: true, size: 24 }),
          makeRun("run3", { bold: true, size: 28 })
        ])
      ]);

      const formats = getUsedFormats(doc);

      expect(formats).toHaveLength(2);
    });

    it("collects formats from table cells", () => {
      const table = makeTable([
        [makePara([makeRun("cell text", { bold: true, color: "FF0000" })])]
      ]);
      const doc = makeDoc([makePara([makeRun("body text", { italic: true })]), table]);

      const formats = getUsedFormats(doc);

      expect(formats).toHaveLength(2);
      const hasBoldRed = formats.some(f => f.bold === true && f.color === "FF0000");
      const hasItalic = formats.some(f => f.italic === true);
      expect(hasBoldRed).toBe(true);
      expect(hasItalic).toBe(true);
    });
  });
});
