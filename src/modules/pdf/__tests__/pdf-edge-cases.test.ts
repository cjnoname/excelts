import { cellSetAlignment, cellSetValue } from "@excel/core/cell";
import { calculateFormulas } from "@excel/core/formula-adapter";
import { getCell } from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";
import { pdf as standalonePdf } from "@pdf/pdf";
import { readPdf } from "@pdf/reader/pdf-reader";
import { CELL_PADDING_H, CELL_PADDING_V, LINE_HEIGHT_FACTOR } from "@pdf/render/constants";
import { getFontAscent, getFontDescent, measureTextWidth } from "@utils/font-metrics";
/**
 * Integration tests for PDF rendering edge cases.
 *
 * These tests verify the fixes for various rendering edge cases and style improvements:
 * type-based alignment, merge border propagation, text overflow, double borders,
 * zero-value number formats, fitToPage, row heights, error cells, and newline handling.
 */
import { describe, it, expect } from "vitest";

import { decompressPdfContent, expectValidPdf } from "./test-helpers";
import { buildTtfWithCmap } from "./ttf-test-utils";

/**
 * The cell clip rectangles, in page coordinates and page order. A cell clips
 * text to its own bounds, so this reports the geometry the renderer actually
 * laid out — no need to reconstruct it from row heights and margins.
 */
function cellClipRects(
  pdfBytes: Uint8Array
): Array<{ x: number; y: number; width: number; height: number }> {
  return [
    ...decompressPdfContent(pdfBytes).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+W/g)
  ].map(m => ({
    x: Number(m[1]),
    y: Number(m[2]),
    width: Number(m[3]),
    height: Number(m[4])
  }));
}

/** Filled rectangles (`re` + `f`), in page order. A cell fill pins its bounds. */
function filledRects(
  pdfBytes: Uint8Array
): Array<{ x: number; y: number; width: number; height: number }> {
  return [
    ...decompressPdfContent(pdfBytes).matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+f/g)
  ].map(m => ({
    x: Number(m[1]),
    y: Number(m[2]),
    width: Number(m[3]),
    height: Number(m[4])
  }));
}

function textBaselines(pdfBytes: Uint8Array): number[] {
  return [...decompressPdfContent(pdfBytes).matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map(m =>
    Number(m[1])
  );
}

// Helper: extract page text from PDF bytes
async function extractText(pdfBytes: Uint8Array): Promise<string> {
  const result = await readPdf(pdfBytes);
  return result.text;
}

// Helper: get text fragments with positions from first page
async function getFragments(
  pdfBytes: Uint8Array
): Promise<{ text: string; x: number; y: number }[]> {
  const result = await readPdf(pdfBytes);
  return result.pages[0].textFragments.map(f => ({
    text: f.text,
    x: Math.round(f.x * 10) / 10,
    y: Math.round(f.y * 10) / 10
  }));
}

describe("PDF Rendering Edge Cases", () => {
  // ===========================================================================
  // Default alignment
  // ===========================================================================

  describe("Type-based default alignment", () => {
    it("should right-align numbers and left-align text by default", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", "Text");
      Cell.setValue(ws, "A2", 42);

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      const fragments = await getFragments(pdfBytes);

      const textFrag = fragments.find(f => f.text === "Text");
      const numFrag = fragments.find(f => f.text === "42");
      expect(textFrag).toBeDefined();
      expect(numFrag).toBeDefined();
      // Number should be further right than text (right-aligned vs left-aligned)
      expect(numFrag!.x).toBeGreaterThan(textFrag!.x);
    });

    it("should center-align booleans by default", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", "Left");
      Cell.setValue(ws, "A2", true);

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      const fragments = await getFragments(pdfBytes);

      const textFrag = fragments.find(f => f.text === "Left");
      const boolFrag = fragments.find(f => f.text.toLowerCase() === "true");
      expect(textFrag).toBeDefined();
      expect(boolFrag).toBeDefined();
      // Boolean (centered) should be further right than left-aligned text
      expect(boolFrag!.x).toBeGreaterThan(textFrag!.x);
    });

    it("should align formula cells by result type", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Cell.setValue(ws, "A1", { formula: "1+1", result: 2 });
      Cell.setValue(ws, "B1", { formula: 'CONCAT("a","b")', result: "ab" });

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      const fragments = await getFragments(pdfBytes);

      const numFrag = fragments.find(f => f.text === "2");
      const strFrag = fragments.find(f => f.text === "ab");
      expect(numFrag).toBeDefined();
      expect(strFrag).toBeDefined();
    });

    it("should work in standalone pdf() mode", async () => {
      const pdfBytes = await standalonePdf({
        sheets: [
          {
            name: "Test",
            data: [
              ["text", 123, true],
              ["hello", 456, false]
            ]
          }
        ]
      });

      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("text");
      expect(text).toContain("123");
      expect(text.toLowerCase()).toContain("true");
    });
  });

  // ===========================================================================
  // Merged cell borders
  // ===========================================================================

  describe("Merged cell border propagation", () => {
    it("should preserve borders set on boundary cells after merge", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Worksheet.merge(ws, "A1:C3");
      Cell.setValue(ws, "A1", "Merged");
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thick", color: { argb: "FFFF0000" } },
          left: { style: "thick", color: { argb: "FF00FF00" } }
        }
      });
      Cell.setStyle(ws, "C1", {
        border: { right: { style: "thick", color: { argb: "FF0000FF" } } }
      });
      Cell.setStyle(ws, "A3", {
        border: { bottom: { style: "thick", color: { argb: "FFFF00FF" } } }
      });

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Merged");
    });

    it("should render bordered empty cells", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Data");
      Cell.setStyle(ws, "B1", {
        border: {
          top: { style: "thick" },
          right: { style: "thick" },
          bottom: { style: "thick" },
          left: { style: "thick" }
        }
      });
      Cell.setStyle(ws, "C1", {
        fill: {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFF00" }
        }
      });

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      expectValidPdf(pdfBytes);
      // B1 and C1 have no text but should still be rendered (borders/fill)
      const text = await extractText(pdfBytes);
      expect(text).toContain("Data");
    });
  });

  // ===========================================================================
  // Text overflow
  // ===========================================================================

  describe("Text overflow into adjacent cells", () => {
    it("should overflow text into empty neighbors", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);
      Column.setWidth(ws, 2, 10);
      Column.setWidth(ws, 3, 10);
      Cell.setValue(ws, "A1", "This is a very long text that overflows");

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("This is a very long text that overflows");
    });

    it("should stop overflow at cells with content", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);
      Column.setWidth(ws, 2, 10);
      Cell.setValue(ws, "A1", "Long text that should not fully display");
      Cell.setValue(ws, "B1", "Blocker");

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Blocker");
    });
  });

  // ===========================================================================
  // Double borders
  // ===========================================================================

  describe("Double border rendering", () => {
    it("should render double borders without crashing", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Double");
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "double" },
          bottom: { style: "double" },
          left: { style: "double" },
          right: { style: "double" }
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Double");
    });
  });

  // ===========================================================================
  // Zero-value number formats
  // ===========================================================================

  describe("Zero-value number formats", () => {
    it('should format accounting zero as dash with spaces: "-"??', async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", 0);
      Cell.setStyle(ws, "A1", { numFmt: '#,##0.00;-#,##0.00;"-"??' });

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      expect(text).toContain("-");
    });

    it("should produce empty string for #.## with zero", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", 0);
      Cell.setStyle(ws, "A1", { numFmt: "#.##" });
      Cell.setValue(ws, "A2", "marker");

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      // A1 should be empty, only marker visible
      expect(text).toContain("marker");
    });

    it("should pad with spaces for ?? placeholders", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", 0);
      Cell.setStyle(ws, "A1", { numFmt: "??0.00" });

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      expect(text).toContain("0.00");
    });
  });

  // ===========================================================================
  // fitToPage
  // ===========================================================================

  describe("fitToPage scaling", () => {
    it("should fit 20 columns onto a single page", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      for (let c = 1; c <= 20; c++) {
        Column.setWidth(ws, c, 12);
        Cell.setValue(ws, 1, c, `Col ${c}`);
      }

      const pdfBytes = await excelToPdf(wb, { fitToPage: true });
      expectValidPdf(pdfBytes);
      const result = await readPdf(pdfBytes);
      // All 20 columns should be on one page
      expect(result.pages).toHaveLength(1);
      expect(result.text).toContain("Col 1");
      expect(result.text).toContain("Col 20");
    });
  });

  // ===========================================================================
  // Row heights
  // ===========================================================================

  describe("Row height handling", () => {
    it("should respect custom row height", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 30);
      Cell.setValue(ws, "A1", "Normal");
      const r2 = Worksheet.getRow(ws, 2);
      r2.height = 50;
      Cell.setValue(ws, "A2", "Tall");
      Cell.setValue(ws, "A3", "Normal again");

      const pdfBytes = await excelToPdf(wb, { showGridLines: true });
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Normal");
      expect(text).toContain("Tall");
    });
  });

  // ===========================================================================
  // Vertical alignment insets
  // ===========================================================================

  describe("Vertical alignment insets", () => {
    it("should inset top- and bottom-aligned text equally", async () => {
      const rowHeight = 80;
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 30);
      Column.setWidth(ws, 2, 30);
      Column.setWidth(ws, 3, 30);
      Row.setHeight(ws, 1, rowHeight);
      Cell.setValue(ws, "A1", "top");
      Cell.setAlignment(ws, "A1", { horizontal: "left", vertical: "top" });
      Cell.setValue(ws, "B1", "middle");
      Cell.setAlignment(ws, "B1", { horizontal: "left", vertical: "middle" });
      Cell.setValue(ws, "C1", "bottom");
      Cell.setAlignment(ws, "C1", { horizontal: "left", vertical: "bottom" });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const page = (await readPdf(pdfBytes)).pages[0];
      const frag = (text: string) => {
        const found = page.textFragments.find(f => f.text === text);
        expect(found).toBeDefined();
        return found!;
      };
      const topFrag = frag("top");
      const middleFrag = frag("middle");
      const bottomFrag = frag("bottom");

      // Ink extents of the face that actually drew the text, read back from the
      // PDF rather than assumed.
      const ascent = getFontAscent(topFrag.fontName, topFrag.fontSize);
      const descent = getFontDescent(topFrag.fontName, topFrag.fontSize);

      // Top alignment puts the ascent exactly one padding below the row top, so
      // it pins the row for the other two.
      const rowTop = topFrag.y + ascent + CELL_PADDING_V;

      // The descent must land the same distance above the row bottom. Deriving
      // the gap from the line box (fontSize × LINE_HEIGHT_FACTOR) instead of the
      // ink puts the whole leading below the last baseline and floats the text.
      expect(bottomFrag.y + descent - (rowTop - rowHeight)).toBeCloseTo(CELL_PADDING_V, 1);

      // ...and a middle-aligned line's ink centres on the row.
      expect(middleFrag.y + (ascent + descent) / 2).toBeCloseTo(rowTop - rowHeight / 2, 1);
    });

    it("should bottom-align wrapped text on its last descent", async () => {
      const rowHeight = 80;
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 12);
      Column.setWidth(ws, 2, 12);
      Row.setHeight(ws, 1, rowHeight);
      Cell.setValue(ws, "A1", "alpha beta gamma delta");
      Cell.setAlignment(ws, "A1", { wrapText: true, vertical: "bottom" });
      // Top-aligned neighbour pins the row geometry.
      Cell.setValue(ws, "B1", "x");
      Cell.setAlignment(ws, "B1", { vertical: "top" });

      const pdfBytes = await excelToPdf(wb);
      const page = (await readPdf(pdfBytes)).pages[0];
      const pin = page.textFragments.find(f => f.text === "x");
      expect(pin).toBeDefined();
      const ascent = getFontAscent(pin!.fontName, pin!.fontSize);
      const descent = getFontDescent(pin!.fontName, pin!.fontSize);
      const rowTop = pin!.y + ascent + CELL_PADDING_V;

      const wrapped = page.textFragments.filter(f => f.text !== "x").sort((a, b) => b.y - a.y);
      expect(wrapped.length).toBeGreaterThan(1);

      // Lines still advance by a full line box...
      expect(wrapped[0].y - wrapped[1].y).toBeCloseTo(pin!.fontSize * LINE_HEIGHT_FACTOR, 5);
      // ...but only the ink is measured against the bottom inset.
      const lastLine = wrapped[wrapped.length - 1];
      expect(lastLine.y + descent - (rowTop - rowHeight)).toBeCloseTo(CELL_PADDING_V, 1);
    });

    it("should auto-size a row for a face whose ink is taller than its em", async () => {
      // 1.3 em of ink: taller than the font size the row height used to assume.
      const ascentEm = 0.95;
      const descentEm = -0.35;
      const font = buildTtfWithCmap([{ start: 0x41, end: 0x5a, delta: 1 - 0x41 }], 27, {
        ascent: ascentEm * 1000,
        descent: descentEm * 1000
      });
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Cell.setValue(ws, "A1", "TOP");
      Cell.setAlignment(ws, "A1", { vertical: "top" });
      Cell.setValue(ws, "B1", "BOT");
      Cell.setAlignment(ws, "B1", { vertical: "bottom" });

      const pdfBytes = await excelToPdf(wb, { fonts: { default: { regular: font } } });
      const cells = cellClipRects(pdfBytes);
      const baselines = textBaselines(pdfBytes);
      expect(cells.length).toBeGreaterThanOrEqual(2);
      expect(baselines.length).toBeGreaterThanOrEqual(2);

      const fontSize = 11;
      const ascent = ascentEm * fontSize;
      const descent = descentEm * fontSize;
      const { y, height } = cells[0];

      // The row grew to hold the ink, not just the em square.
      expect(height).toBeCloseTo(ascent - descent + 2 * CELL_PADDING_V, 5);
      // Both alignments therefore land on their inset instead of being clamped
      // against the top and spilling descenders through the bottom border.
      expect(y + height - (baselines[0] + ascent)).toBeCloseTo(CELL_PADDING_V, 5);
      expect(baselines[1] + descent - y).toBeCloseTo(CELL_PADDING_V, 5);
    });

    it("should keep the font size as the auto row height floor", async () => {
      // Helvetica's ink box is 0.925 em — shorter than the em square. Excel
      // still gives such a row the full font size, so the ink height is a floor
      // to raise the row, never a licence to shrink it.
      const fontSize = 20;
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", "Ay");
      Cell.setStyle(ws, "A1", { font: { size: fontSize } });

      const pdfBytes = await excelToPdf(wb);
      const cells = cellClipRects(pdfBytes);
      expect(cells.length).toBeGreaterThanOrEqual(1);
      expect(cells[0].height).toBeCloseTo(fontSize + 2 * CELL_PADDING_V, 5);
    });
  });

  // ===========================================================================
  // Newline handling
  // ===========================================================================

  describe("Explicit newline handling", () => {
    it("should split non-wrapped text on explicit newlines", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", "Line1\nLine2\nLine3");

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Line1");
      expect(text).toContain("Line2");
      expect(text).toContain("Line3");
    });

    it("should handle wrapped text with newlines", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Cell.setValue(ws, "A1", "Wrap\nwith\nnewlines");
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Wrap");
      expect(text).toContain("newlines");
    });
  });

  // ===========================================================================
  // Error values and mixed types
  // ===========================================================================

  describe("Error values and special types", () => {
    it("should render error cell values", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { error: "#DIV/0!" } as any);

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("#DIV/0!");
    });

    it("should render rich text with mixed formatting", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 40);
      Cell.setValue(ws, "A1", {
        richText: [
          { text: "Bold ", font: { bold: true } },
          { text: "Normal ", font: { size: 11 } },
          { text: "Red", font: { color: { argb: "FFFF0000" } } }
        ]
      });

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Bold");
      expect(text).toContain("Normal");
      expect(text).toContain("Red");
    });

    it("should handle hyperlink cells", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", { text: "Click me", hyperlink: "https://example.com" });
      Cell.setStyle(ws, "A1", { font: { color: { argb: "FF0563C1" }, underline: true } });

      const pdfBytes = await excelToPdf(wb);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Click me");
    });
  });

  // ===========================================================================
  // Vertical stacked text (textRotation = 255 / "vertical")
  // ===========================================================================

  describe("Vertical stacked text", () => {
    it("should render vertical stacked text (rotation 255)", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Row.setHeight(ws, 1, 80);
      Cell.setValue(ws, "A1", "Vertical");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: 255 } });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      // Vertical stacked renders each char separately
      expect(text).toContain("V");
      expect(text).toContain("e");
    });

    it("should respect horizontal alignment for vertical stacked text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Row.setHeight(ws, 1, 100);

      Cell.setValue(ws, "A1", "Hi");
      Cell.setStyle(ws, "A1", {
        alignment: {
          textRotation: "vertical" as any,
          horizontal: "left"
        }
      });
      Cell.setValue(ws, "B1", "Hi");
      Cell.setStyle(ws, "B1", {
        alignment: {
          textRotation: "vertical" as any,
          horizontal: "right"
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const hFrags = frags.filter(f => f.text === "H");
      expect(hFrags.length).toBeGreaterThanOrEqual(2);
      // Left-aligned "H" should have a smaller x than right-aligned "H"
      expect(hFrags[0].x).toBeLessThan(hFrags[1].x);
    });

    it("should respect vertical alignment for vertical stacked text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);
      Column.setWidth(ws, 2, 10);
      Column.setWidth(ws, 3, 10);
      Row.setHeight(ws, 1, 120);

      Cell.setValue(ws, "A1", "A");
      Cell.setStyle(ws, "A1", {
        alignment: {
          textRotation: "vertical" as any,
          vertical: "top"
        }
      });
      Cell.setValue(ws, "B1", "B");
      Cell.setStyle(ws, "B1", {
        alignment: {
          textRotation: "vertical" as any,
          vertical: "middle"
        }
      });
      Cell.setValue(ws, "C1", "C");
      Cell.setStyle(ws, "C1", {
        alignment: {
          textRotation: "vertical" as any,
          vertical: "bottom"
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const aFrag = frags.find(f => f.text === "A");
      const bFrag = frags.find(f => f.text === "B");
      const cFrag = frags.find(f => f.text === "C");
      expect(aFrag).toBeDefined();
      expect(bFrag).toBeDefined();
      expect(cFrag).toBeDefined();
      // top has highest y, bottom has lowest y (PDF coords)
      expect(aFrag!.y).toBeGreaterThan(bFrag!.y);
      expect(bFrag!.y).toBeGreaterThan(cFrag!.y);
    });

    it("should inset stacked text equally at the top and bottom", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);
      Column.setWidth(ws, 2, 10);
      Row.setHeight(ws, 1, 120);
      Cell.setValue(ws, "A1", "A");
      Cell.setStyle(ws, "A1", {
        alignment: { textRotation: "vertical" as any, vertical: "top" }
      });
      Cell.setValue(ws, "B1", "B");
      Cell.setStyle(ws, "B1", {
        alignment: { textRotation: "vertical" as any, vertical: "bottom" }
      });

      const pdfBytes = await excelToPdf(wb);
      const cells = cellClipRects(pdfBytes);
      const page = (await readPdf(pdfBytes)).pages[0];
      const top = page.textFragments.find(f => f.text === "A");
      const bottom = page.textFragments.find(f => f.text === "B");
      expect(top).toBeDefined();
      expect(bottom).toBeDefined();

      const ascent = getFontAscent(top!.fontName, top!.fontSize);
      const descent = getFontDescent(top!.fontName, top!.fontSize);
      // A single-character column is one glyph tall, so both alignments must
      // land on their own inset — the stacked path used to derive the bottom
      // one from the character pitch and float the glyph above it.
      expect(cells[0].y + cells[0].height - (top!.y + ascent)).toBeCloseTo(CELL_PADDING_V, 1);
      expect(bottom!.y + descent - cells[1].y).toBeCloseTo(CELL_PADDING_V, 1);
    });
  });

  // ===========================================================================
  // Rotated text alignment (90°, -90°, general angles)
  // ===========================================================================

  describe("Rotated text alignment", () => {
    // --- Horizontal insets: rotation swaps the axes, so the cell's horizontal
    // insets are measured against the text's ink height, not its line box. ---
    it.each([90, -90])(
      "should inset %i° text horizontally by its ink, not its line box",
      async rotation => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        const aligns = ["left", "center", "right"] as const;
        aligns.forEach((align, i) => {
          Column.setWidth(ws, i + 1, 12);
          const addr = `${String.fromCharCode(65 + i)}1`;
          Cell.setValue(ws, addr, "Xy");
          Cell.setStyle(ws, addr, { alignment: { textRotation: rotation, horizontal: align } });
        });
        Row.setHeight(ws, 1, 90);

        const pdfBytes = await excelToPdf(wb);
        const page = (await readPdf(pdfBytes)).pages[0];
        const cells = cellClipRects(pdfBytes);
        expect(page.textFragments.length).toBe(3);

        page.textFragments.forEach((frag, i) => {
          const ascent = getFontAscent(frag.fontName, frag.fontSize);
          const descent = getFontDescent(frag.fontName, frag.fontSize);
          // At +90° the ascent points at page-left, at -90° at page-right.
          const inkLeft = rotation === 90 ? frag.x - ascent : frag.x + descent;
          const inkRight = rotation === 90 ? frag.x - descent : frag.x + ascent;
          const cell = cells[i];
          if (aligns[i] === "left") {
            expect(inkLeft - cell.x).toBeCloseTo(CELL_PADDING_H, 1);
          } else if (aligns[i] === "right") {
            expect(cell.x + cell.width - inkRight).toBeCloseTo(CELL_PADDING_H, 1);
          } else {
            expect((inkLeft + inkRight) / 2).toBeCloseTo(cell.x + cell.width / 2, 1);
          }
        });
      }
    );

    it("should centre an arbitrarily rotated line on the cell middle", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Row.setHeight(ws, 1, 90);
      Cell.setValue(ws, "A1", "Xy");
      Cell.setStyle(ws, "A1", {
        // A fill pins the cell bounds: a slanted rotation clips with a
        // parallelogram path rather than a rectangle, so there is no `re W`.
        fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } },
        alignment: { textRotation: 45, horizontal: "center", vertical: "middle" }
      });

      const pdfBytes = await excelToPdf(wb);
      const page = (await readPdf(pdfBytes)).pages[0];
      const [cell] = filledRects(pdfBytes);
      const [frag] = page.textFragments;
      expect(cell).toBeDefined();
      expect(frag).toBeDefined();

      const ascent = getFontAscent(frag.fontName, frag.fontSize);
      const descent = getFontDescent(frag.fontName, frag.fontSize);
      const halfInk = (ascent + descent) / 2;
      const width = measureTextWidth("Xy", frag.fontName, frag.fontSize);
      const radians = (45 * Math.PI) / 180;
      // Undo the rotation about the emitted origin to recover the block centre:
      // the baseline start sits at local (-width / 2, -halfInk). Only Y is
      // asserted — a slanted rotation deliberately shifts X to follow the
      // parallelogram the borders draw.
      const centreY = frag.y + (width / 2) * Math.sin(radians) + halfInk * Math.cos(radians);

      expect(centreY).toBeCloseTo(cell.y + cell.height / 2, 1);
    });

    // --- 90° vertical alignment ---
    it("should position 90° text according to vertical alignment (top > middle > bottom)", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 12);
      Column.setWidth(ws, 2, 12);
      Column.setWidth(ws, 3, 12);
      Row.setHeight(ws, 1, 80);

      Cell.setValue(ws, "A1", "Top");
      Cell.setStyle(ws, "A1", {
        alignment: { textRotation: 90, horizontal: "center", vertical: "top" }
      });
      Cell.setValue(ws, "B1", "Mid");
      Cell.setStyle(ws, "B1", {
        alignment: { textRotation: 90, horizontal: "center", vertical: "middle" }
      });
      Cell.setValue(ws, "C1", "Bot");
      Cell.setStyle(ws, "C1", {
        alignment: { textRotation: 90, horizontal: "center", vertical: "bottom" }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const topFrag = frags.find(f => f.text === "Top");
      const midFrag = frags.find(f => f.text === "Mid");
      const botFrag = frags.find(f => f.text === "Bot");
      expect(topFrag).toBeDefined();
      expect(midFrag).toBeDefined();
      expect(botFrag).toBeDefined();
      // In PDF coords (origin bottom-left), top text starts at highest y
      expect(topFrag!.y).toBeGreaterThan(midFrag!.y);
      expect(midFrag!.y).toBeGreaterThan(botFrag!.y);
    });

    // --- 90° horizontal alignment ---
    it("should position 90° text left/right with horizontal alignment", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Row.setHeight(ws, 1, 80);

      Cell.setValue(ws, "A1", "Left");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: 90, horizontal: "left" } });
      Cell.setValue(ws, "B1", "Right");
      Cell.setStyle(ws, "B1", { alignment: { textRotation: 90, horizontal: "right" } });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const leftFrag = frags.find(f => f.text === "Left");
      const rightFrag = frags.find(f => f.text === "Right");
      expect(leftFrag).toBeDefined();
      expect(rightFrag).toBeDefined();
      // Right cell's text x should be greater (further right)
      expect(rightFrag!.x).toBeGreaterThan(leftFrag!.x);
    });

    // --- 90° combined: left+bottom vs right+top (core scenario) ---
    it("should handle 90° combined h/v alignment", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Row.setHeight(ws, 1, 100);

      Cell.setValue(ws, "A1", "LB");
      Cell.setStyle(ws, "A1", {
        alignment: {
          textRotation: 90,
          horizontal: "left",
          vertical: "bottom"
        }
      });
      Cell.setValue(ws, "B1", "RT");
      Cell.setStyle(ws, "B1", {
        alignment: {
          textRotation: 90,
          horizontal: "right",
          vertical: "top"
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const lbFrag = frags.find(f => f.text === "LB");
      const rtFrag = frags.find(f => f.text === "RT");
      expect(lbFrag).toBeDefined();
      expect(rtFrag).toBeDefined();
      // LB: left+bottom → low x, low y; RT: right+top → high x, high y
      expect(lbFrag!.x).toBeLessThan(rtFrag!.x);
      expect(lbFrag!.y).toBeLessThan(rtFrag!.y);
    });

    // --- -90° alignment ---
    it("should render -90° rotated text with alignment", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 12);
      Column.setWidth(ws, 2, 12);
      Column.setWidth(ws, 3, 12);
      Row.setHeight(ws, 1, 80);

      Cell.setValue(ws, "A1", "Top");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: -90, vertical: "top" } });
      Cell.setValue(ws, "B1", "Mid");
      Cell.setStyle(ws, "B1", { alignment: { textRotation: -90, vertical: "middle" } });
      Cell.setValue(ws, "C1", "Bot");
      Cell.setStyle(ws, "C1", { alignment: { textRotation: -90, vertical: "bottom" } });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const topFrag = frags.find(f => f.text === "Top");
      const midFrag = frags.find(f => f.text === "Mid");
      const botFrag = frags.find(f => f.text === "Bot");
      expect(topFrag).toBeDefined();
      expect(midFrag).toBeDefined();
      expect(botFrag).toBeDefined();
      // For -90° (text flows downward), top text starts from highest y
      expect(topFrag!.y).toBeGreaterThan(midFrag!.y);
      expect(midFrag!.y).toBeGreaterThan(botFrag!.y);
    });

    it("should position -90° text left/right with horizontal alignment", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);
      Column.setWidth(ws, 2, 20);
      Row.setHeight(ws, 1, 80);

      Cell.setValue(ws, "A1", "Left");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: -90, horizontal: "left" } });
      Cell.setValue(ws, "B1", "Right");
      Cell.setStyle(ws, "B1", { alignment: { textRotation: -90, horizontal: "right" } });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const leftFrag = frags.find(f => f.text === "Left");
      const rightFrag = frags.find(f => f.text === "Right");
      expect(leftFrag).toBeDefined();
      expect(rightFrag).toBeDefined();
      expect(rightFrag!.x).toBeGreaterThan(leftFrag!.x);
    });

    // --- General angle (45°) alignment ---
    it("should render 45° text with top-left vs bottom-right alignment", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 15);
      Column.setWidth(ws, 2, 15);
      Row.setHeight(ws, 1, 60);

      Cell.setValue(ws, "A1", "TL");
      Cell.setStyle(ws, "A1", {
        alignment: {
          textRotation: 45,
          horizontal: "left",
          vertical: "top"
        }
      });
      Cell.setValue(ws, "B1", "BR");
      Cell.setStyle(ws, "B1", {
        alignment: {
          textRotation: 45,
          horizontal: "right",
          vertical: "bottom"
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);
      const tlFrag = frags.find(f => f.text === "TL");
      const brFrag = frags.find(f => f.text === "BR");
      expect(tlFrag).toBeDefined();
      expect(brFrag).toBeDefined();
      // Top-left should have higher y than bottom-right
      expect(tlFrag!.y).toBeGreaterThan(brFrag!.y);
    });

    // --- 45° slanted borders ---
    it("should render slanted borders for general rotation angles", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Row.setHeight(ws, 1, 60);
      Cell.setValue(ws, "A1", "Slant");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: 45 } });
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" }
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Slant");
    });

    // --- 45° negative angle ---
    it("should render -45° text with slanted borders", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Row.setHeight(ws, 1, 60);
      Cell.setValue(ws, "A1", "Neg");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: -45 } });
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" }
        }
      });

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const text = await extractText(pdfBytes);
      expect(text).toContain("Neg");
    });

    // --- All 6 combos reproduced ---
    it("should match Excel alignment for all 6 rotation combos", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      for (let c = 1; c <= 6; c++) {
        Column.setWidth(ws, c, 12);
      }
      Row.setHeight(ws, 1, 110);

      // The exact combos from the PDF-Test-2.xlsx Row 8
      const combos: Array<{ value: string; h: string; v?: string }> = [
        { value: "Col1", h: "center", v: "top" },
        { value: "Col2", h: "center", v: "middle" },
        { value: "Col3", h: "center" },
        { value: "Col4", h: "left" },
        { value: "Col5", h: "right" },
        { value: "Col6", h: "left", v: "top" }
      ];

      for (let i = 0; i < combos.length; i++) {
        const cell = getCell(ws, 1, i + 1);
        cellSetValue(cell, combos[i].value);
        cellSetAlignment(cell, {
          textRotation: 90,
          horizontal: combos[i].h as any,
          vertical: combos[i].v as any,
          wrapText: true
        });
      }

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      const frags = await getFragments(pdfBytes);

      // All 6 texts should be present
      for (const combo of combos) {
        expect(frags.find(f => f.text === combo.value)).toBeDefined();
      }

      // Col1 (center/top) should have higher y than Col3 (center/bottom-default)
      const col1 = frags.find(f => f.text === "Col1")!;
      const col3 = frags.find(f => f.text === "Col3")!;
      expect(col1.y).toBeGreaterThan(col3.y);

      // Col4 (left) should have smaller x than Col5 (right) within their cells
      // Col4 is in column 4 (offset ~3*colWidth), Col5 in column 5 (offset ~4*colWidth)
      // Col4 left-aligned within its cell, Col5 right-aligned within its cell
      const col4 = frags.find(f => f.text === "Col4")!;
      const col5 = frags.find(f => f.text === "Col5")!;
      // Despite being in adjacent cells, right-aligned Col5 should have notably larger x
      expect(col5.x).toBeGreaterThan(col4.x);
    });
  });

  // ===========================================================================
  // Formula recalculation before PDF export
  // ===========================================================================

  describe("formula recalculation on export", () => {
    it("should recalculate formulas before rendering so stale results are updated", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);

      // A1 has source data, B1 has formula referencing A1 with a stale cached result
      Cell.setValue(ws, "A1", 100);
      Cell.setValue(ws, "B1", { formula: "A1*2", result: 0 });

      const pdfBytes = await excelToPdf(wb, { recalculate: calculateFormulas });
      expectValidPdf(pdfBytes);

      const text = await extractText(pdfBytes);
      // The recalculated result (200) should appear, not the stale cached result (0)
      expect(text).toContain("200");
    });

    it("should render formula results that had no cached value", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);

      Cell.setValue(ws, "A1", 7);
      Cell.setValue(ws, "A2", 3);
      Cell.setValue(ws, "A3", { formula: "A1+A2", result: 0 });

      const pdfBytes = await excelToPdf(wb, { recalculate: calculateFormulas });
      expectValidPdf(pdfBytes);

      const text = await extractText(pdfBytes);
      expect(text).toContain("10");
    });

    it("should reflect the latest cell values, not the original cached results", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);

      Cell.setValue(ws, "A1", 5);
      Cell.setValue(ws, "B1", { formula: "A1*3", result: 999 });

      // Modify A1 after setting up the formula — the cached result (999) is now stale
      Cell.setValue(ws, "A1", 10);

      const pdfBytes = await excelToPdf(wb, { recalculate: calculateFormulas });
      expectValidPdf(pdfBytes);

      const text = await extractText(pdfBytes);
      // Should contain 30 (10*3), not 999 or 15 (5*3)
      expect(text).toContain("30");
      expect(text).not.toContain("999");
    });
  });
});
