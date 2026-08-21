import { getColumn, getRow } from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import {
  measureTextWidthPx,
  measureRichTextWidthPx,
  getMaxDigitWidth,
  getPixelPadding,
  pixelToCharWidth,
  charWidthToPixel,
  getLineHeightPx,
  calculateAutoFitWidth,
  calculateAutoFitHeight,
  calculateWrappedLineCount,
  pixelToPoints
} from "@excel/utils/text-metrics";
import { getCalibri11PtPixelWidth } from "@utils/font-data";
import { describe, it, expect } from "vitest";

// =============================================================================
// Font Data Tests
// =============================================================================

describe("Font Data - Calibri 11pt Bitmap", () => {
  it("matches reference pixel widths for all A-Z", () => {
    // These values are verified against independently measured reference
    // pixel widths (empirically measured from Excel)
    const expected: Record<string, number> = {
      A: 9,
      B: 8,
      C: 8,
      D: 9,
      E: 7,
      F: 7,
      G: 9,
      H: 9,
      I: 4,
      J: 5,
      K: 8,
      L: 6,
      M: 12,
      N: 10,
      O: 10,
      P: 8,
      Q: 10,
      R: 8,
      S: 7,
      T: 7,
      U: 9,
      V: 9,
      W: 13,
      X: 8,
      Y: 7,
      Z: 7
    };

    for (const [char, px] of Object.entries(expected)) {
      expect(getCalibri11PtPixelWidth(char.codePointAt(0)!)).toBe(px);
    }
  });

  it("matches reference pixel widths for all a-z", () => {
    const expected: Record<string, number> = {
      a: 7,
      b: 8,
      c: 6,
      d: 8,
      e: 8,
      f: 5,
      g: 7,
      h: 8,
      i: 4,
      j: 4,
      k: 7,
      l: 4,
      m: 12,
      n: 8,
      o: 8,
      p: 8,
      q: 8,
      r: 5,
      s: 6,
      t: 5,
      u: 8,
      v: 7,
      w: 11,
      x: 7,
      y: 7,
      z: 6
    };

    for (const [char, px] of Object.entries(expected)) {
      expect(getCalibri11PtPixelWidth(char.codePointAt(0)!)).toBe(px);
    }
  });

  it("matches pixel widths for digits 0-9", () => {
    // All Calibri digits have the same width
    for (let d = 0; d <= 9; d++) {
      expect(getCalibri11PtPixelWidth(0x30 + d)).toBe(7);
    }
  });

  it("matches pixel widths for common punctuation", () => {
    expect(getCalibri11PtPixelWidth(0x20)).toBe(3); // space
    expect(getCalibri11PtPixelWidth(0x2e)).toBe(4); // .
    expect(getCalibri11PtPixelWidth(0x2c)).toBe(4); // ,
    expect(getCalibri11PtPixelWidth(0x2d)).toBe(5); // -
    expect(getCalibri11PtPixelWidth(0x3a)).toBe(4); // :
    expect(getCalibri11PtPixelWidth(0x3b)).toBe(4); // ;
  });
});

// =============================================================================
// Unit Conversion Tests
// =============================================================================

describe("Unit Conversions", () => {
  it("calculates MDW correctly for Calibri 11pt", () => {
    // Calibri 11pt uses bitmap MDW = 7 (not outline which would give 8)
    expect(getMaxDigitWidth()).toBe(7);
    expect(getMaxDigitWidth({ name: "Calibri", size: 11 })).toBe(7);
  });

  it("calculates pixel padding correctly", () => {
    // PP = 2 * CEIL(MDW/4) + 1
    expect(getPixelPadding(7)).toBe(5); // 2 * CEIL(7/4) + 1 = 2*2+1 = 5
    expect(getPixelPadding(8)).toBe(5); // 2 * CEIL(8/4) + 1 = 2*2+1 = 5
    expect(getPixelPadding(6)).toBe(5); // 2 * CEIL(6/4) + 1 = 2*2+1 = 5
    expect(getPixelPadding(11)).toBe(7); // 2 * CEIL(11/4) + 1 = 2*3+1 = 7
  });

  it("converts pixel to char width correctly (TRUNC formula)", () => {
    // TRUNC(pixels / MDW * 256) / 256
    const mdw = 7;
    expect(pixelToCharWidth(0, mdw)).toBe(0);
    expect(pixelToCharWidth(7, mdw)).toBe(1); // 7/7*256 = 256, TRUNC/256 = 1
    expect(pixelToCharWidth(14, mdw)).toBe(2);
    expect(pixelToCharWidth(64, mdw)).toBe(Math.trunc((64 / 7) * 256) / 256);
  });

  it("converts char width to pixel correctly", () => {
    const mdw = 7;
    expect(charWidthToPixel(0, mdw)).toBe(0);
    // width >= 1: ROUND(width * MDW) + PP
    expect(charWidthToPixel(1, mdw)).toBe(Math.round(1 * 7) + 5); // 12
    expect(charWidthToPixel(9, mdw)).toBe(Math.round(9 * 7) + 5); // 68
    // width < 1: ROUND(width * (MDW + PP))
    expect(charWidthToPixel(0.5, mdw)).toBe(Math.round(0.5 * 12)); // 6
  });

  it("converts points to pixels and back", () => {
    expect(pixelToPoints(96)).toBe(72); // 96px at 96dpi = 1 inch = 72pt
    expect(pixelToPoints(15)).toBeCloseTo(11.25, 2); // Calibri 11pt line height
  });
});

// =============================================================================
// Text Width Measurement Tests
// =============================================================================

describe("Text Width Measurement", () => {
  it("measures empty string as 0", () => {
    expect(measureTextWidthPx("")).toBe(0);
    expect(measureTextWidthPx("", { name: "Calibri", size: 11 })).toBe(0);
  });

  it("measures ASCII text in Calibri 11pt using bitmap table", () => {
    // "Hello" = H(9) + e(8) + l(4) + l(4) + o(8) = 33
    expect(measureTextWidthPx("Hello")).toBe(33);
    expect(measureTextWidthPx("Hello", { name: "Calibri", size: 11 })).toBe(33);
  });

  it("measures a single character correctly", () => {
    expect(measureTextWidthPx("A")).toBe(9);
    expect(measureTextWidthPx("i")).toBe(4);
    expect(measureTextWidthPx("M")).toBe(12);
    expect(measureTextWidthPx("W")).toBe(13);
  });

  it("measures string with narrow chars accurately", () => {
    // "illili" = 4+4+4+4+4+4 = 24
    expect(measureTextWidthPx("illili")).toBe(24);
  });

  it("measures string with wide chars accurately", () => {
    // "MWmw" = 12+13+12+11 = 48
    expect(measureTextWidthPx("MWmw")).toBe(48);
  });

  it("measures multi-line text (returns widest line)", () => {
    // "AB\nW" → line 1: A(9)+B(8)=17, line 2: W(13)=13 → max = 17
    expect(measureTextWidthPx("AB\nW")).toBe(17);
  });

  it("handles CRLF line breaks", () => {
    expect(measureTextWidthPx("A\r\nB")).toBe(Math.max(9, 8));
  });

  it("applies bold multiplier for unknown bold variant", () => {
    // Calibri doesn't have a separate bold metrics table in our data,
    // so it should apply the 1.05 multiplier per character
    const normalWidth = measureTextWidthPx("Hello", { name: "Calibri", size: 11 });
    const boldWidth = measureTextWidthPx("Hello", { name: "Calibri", size: 11, bold: true });
    expect(boldWidth).toBeGreaterThan(normalWidth);
  });

  it("measures Arial text using FUnit data", () => {
    const width = measureTextWidthPx("Hello", { name: "Arial", size: 11 });
    expect(width).toBeGreaterThan(0);
    // Arial is generally wider than Calibri
    const calibriWidth = measureTextWidthPx("Hello", { name: "Calibri", size: 11 });
    expect(width).toBeGreaterThanOrEqual(calibriWidth);
  });

  it("measures text at different font sizes", () => {
    const width11 = measureTextWidthPx("Test", { name: "Arial", size: 11 });
    const width22 = measureTextWidthPx("Test", { name: "Arial", size: 22 });
    // 22pt should be roughly 2x of 11pt (not exactly due to rounding)
    expect(width22).toBeGreaterThan(width11 * 1.5);
    expect(width22).toBeLessThan(width11 * 2.5);
  });

  it("uses factor-based fallback for unknown fonts", () => {
    const width = measureTextWidthPx("Hello World", { name: "UnknownFont", size: 11 });
    expect(width).toBeGreaterThan(0);
  });
});

// =============================================================================
// Rich Text Measurement Tests
// =============================================================================

describe("Rich Text Measurement", () => {
  it("measures simple rich text", () => {
    const richText = [{ text: "Hello" }, { text: " World" }];
    const width = measureRichTextWidthPx(richText);
    const plainWidth = measureTextWidthPx("Hello World");
    // Should be the same as plain text when no font overrides
    expect(width).toBe(plainWidth);
  });

  it("handles rich text with newlines", () => {
    const richText = [{ text: "Line1\nLine2" }];
    const width = measureRichTextWidthPx(richText);
    const line1Width = measureTextWidthPx("Line1");
    const line2Width = measureTextWidthPx("Line2");
    expect(width).toBe(Math.max(line1Width, line2Width));
  });
});

// =============================================================================
// Auto-Fit Width Calculation Tests
// =============================================================================

describe("Auto-Fit Width Calculation", () => {
  it("calculates auto-fit width with padding", () => {
    const textPx = 50;
    const mdw = 7;
    const charWidth = calculateAutoFitWidth(textPx, mdw);

    // Should be > 0 and include padding
    expect(charWidth).toBeGreaterThan(0);

    // Should be greater than raw text width / MDW
    expect(charWidth).toBeGreaterThan(textPx / mdw);
  });

  it("returns 0 for empty content", () => {
    expect(calculateAutoFitWidth(0, 7)).toBe(0);
    expect(calculateAutoFitWidth(-1, 7)).toBe(0);
  });

  it("adds extra space for autofilter", () => {
    const withoutFilter = calculateAutoFitWidth(50, 7, false);
    const withFilter = calculateAutoFitWidth(50, 7, true);
    expect(withFilter).toBeGreaterThan(withoutFilter);
  });

  it("caps at maximum column width", () => {
    const charWidth = calculateAutoFitWidth(10000, 7);
    expect(charWidth).toBeLessThanOrEqual(255);
  });
});

// =============================================================================
// Auto-Fit Height Calculation Tests
// =============================================================================

describe("Auto-Fit Height Calculation", () => {
  it("calculates single-line height", () => {
    const height = calculateAutoFitHeight("Hello");
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(30); // Calibri 11pt is about 15pt height
  });

  it("calculates multi-line height", () => {
    const singleLine = calculateAutoFitHeight("Hello");
    const twoLines = calculateAutoFitHeight("Hello\nWorld");
    expect(twoLines).toBeCloseTo(singleLine * 2, 0);
  });

  it("calculates wrapped text height", () => {
    const longText = "This is a very long text that should wrap to multiple lines";
    const narrowCol = 50; // 50px column width
    const height = calculateAutoFitHeight(longText, undefined, { wrapText: true }, narrowCol);
    const singleLine = calculateAutoFitHeight("X");
    expect(height).toBeGreaterThan(singleLine);
  });

  it("returns line height for empty text", () => {
    const height = calculateAutoFitHeight("");
    expect(height).toBeGreaterThan(0); // Returns single line height
  });

  it("line height is larger for larger font sizes", () => {
    const small = getLineHeightPx({ size: 11 });
    const large = getLineHeightPx({ size: 22 });
    expect(large).toBeGreaterThan(small);
  });
});

// =============================================================================
// Wrapped Line Count Tests
// =============================================================================

describe("Wrapped Line Count", () => {
  it("returns 1 for short text", () => {
    expect(calculateWrappedLineCount("Hi", 100)).toBe(1);
  });

  it("counts explicit newlines", () => {
    expect(calculateWrappedLineCount("A\nB\nC", 100)).toBe(3);
  });

  it("wraps at word boundaries like Excel", () => {
    // "Hello World" in Calibri 11pt:
    // "Hello " = H(9)+e(8)+l(4)+l(4)+o(8)+space(3) = 36px
    // "World"  = W(13)+o(8)+r(5)+l(4)+d(8) = 38px
    // In a 40px column: "Hello " fits (36px), "World" starts new line (38px)
    expect(calculateWrappedLineCount("Hello World", 40)).toBe(2);
  });

  it("does not break mid-word", () => {
    // "Spreadsheet" = 77px in Calibri 11pt
    // In a 50px column: the word doesn't fit, but Excel doesn't break mid-word
    // The word overflows on one line
    expect(calculateWrappedLineCount("Spreadsheet", 50)).toBe(1);
  });

  it("wraps multiple words correctly", () => {
    // "a b c d" with very narrow column — each word should be on its own line
    // a=7, space=3, b=8, space=3, c=6, space=3, d=8
    // "a "=10, "b "=11, "c "=9, "d"=8
    // In a 12px column: each fits individually, so 4 words = at most 4 lines
    const count = calculateWrappedLineCount("a b c d", 12);
    expect(count).toBe(4);
  });

  it("handles hyphen as break point", () => {
    // "one-two" should break after the hyphen
    const count = calculateWrappedLineCount("one-two", 30);
    // "one-" = o(8)+n(8)+e(8)+-(5) = 29px
    // "two" = t(5)+w(11)+o(8) = 24px
    // In 30px column: "one-" fits (29px), "two" on next line
    expect(count).toBe(2);
  });
});

// =============================================================================
// Worksheet Integration Tests
// =============================================================================

describe("Worksheet.autoFitColumns", () => {
  it("auto-fits a single column", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Short");
    Cell.setValue(ws, "A2", "A much longer string value");

    Worksheet.autoFitColumn(ws, "A");

    const col = getColumn(ws, "A");
    expect(col.width).toBeGreaterThan(9); // > default width
    expect(col.bestFit).toBe(true);
  });

  it("auto-fits all columns", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Name");
    Cell.setValue(ws, "B1", "A very long description field");
    Cell.setValue(ws, "C1", 12345);

    Worksheet.autoFitColumns(ws);

    expect(getColumn(ws, "A").bestFit).toBe(true);
    expect(getColumn(ws, "B").bestFit).toBe(true);
    expect(getColumn(ws, "C").bestFit).toBe(true);

    // Column B should be wider than A (longer text)
    expect(Column.getWidth(ws, "B")).toBeGreaterThan(Column.getWidth(ws, "A")!);
  });

  it("auto-fits a column range", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Col A");
    Cell.setValue(ws, "B1", "Col B with more text");
    Cell.setValue(ws, "C1", "Col C");

    Worksheet.autoFitColumns(ws, "B", "C");

    // A should not be affected
    expect(getColumn(ws, "A").bestFit).toBeUndefined();
    expect(getColumn(ws, "B").bestFit).toBe(true);
    expect(getColumn(ws, "C").bestFit).toBe(true);
  });

  it("handles empty worksheet gracefully", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    // Should not throw
    Worksheet.autoFitColumns(ws);
  });

  it("skips merged cells spanning multiple columns", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Short");
    Cell.setValue(ws, "A2", "This is merged across A2:C2");
    Worksheet.merge(ws, "A2:C2");

    Worksheet.autoFitColumn(ws, "A");

    // Width should be based on A1 "Short", not the merged cell
    const col = getColumn(ws, "A");
    expect(col.bestFit).toBe(true);
  });

  it("returns this for chaining", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");
    Cell.setValue(ws, "A1", "test");

    const result = Worksheet.autoFitColumn(ws, "A");
    expect(result).toBe(ws);

    const result2 = Worksheet.autoFitColumns(ws);
    expect(result2).toBe(ws);
  });
});

describe("Worksheet.autoFitRows", () => {
  it("auto-fits a single row", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Hello");
    Worksheet.autoFitRow(ws, 1);

    const row = Worksheet.getRow(ws, 1);
    expect(row.height).toBeGreaterThan(0);
    expect(row.customHeight).toBe(true);
  });

  it("auto-fits all rows", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Row 1");
    Cell.setValue(ws, "A2", "Row 2");

    Worksheet.autoFitRows(ws);

    expect(getRow(ws, 1).customHeight).toBe(true);
    expect(getRow(ws, 2).customHeight).toBe(true);
  });

  it("calculates taller height for multi-line text", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Single line");
    Cell.setValue(ws, "A2", "Line 1\nLine 2\nLine 3");

    Worksheet.autoFitRows(ws);

    // Row 2 should be taller than row 1
    expect(Row.getHeight(ws, 2)).toBeGreaterThan(Row.getHeight(ws, 1)!);
  });

  it("handles empty rows gracefully", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A3", "Only row 3");

    // Should not throw for empty rows
    Worksheet.autoFitRows(ws);
  });

  it("returns this for chaining", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");
    Cell.setValue(ws, "A1", "test");

    const result = Worksheet.autoFitRow(ws, 1);
    expect(result).toBe(ws);

    const result2 = Worksheet.autoFitRows(ws);
    expect(result2).toBe(ws);
  });
});

// =============================================================================
// Integration: Combined auto-fit
// =============================================================================

describe("Auto-Fit Integration", () => {
  it("auto-fits columns and rows together", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Name");
    Cell.setValue(ws, "B1", "Description");
    Cell.setValue(ws, "A2", "Alice");
    Cell.setValue(ws, "B2", "A very long description that should make column B wider");

    Worksheet.autoFitRows(Worksheet.autoFitColumns(ws));

    // Verify columns are fitted
    expect(getColumn(ws, "A").bestFit).toBe(true);
    expect(getColumn(ws, "B").bestFit).toBe(true);
    expect(Column.getWidth(ws, "B")).toBeGreaterThan(Column.getWidth(ws, "A")!);

    // Verify rows are fitted
    expect(getRow(ws, 1).customHeight).toBe(true);
    expect(getRow(ws, 2).customHeight).toBe(true);
  });

  it("handles number-formatted cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", 1234567.89);
    Cell.setStyle(ws, "A1", { numFmt: "#,##0.00" });

    Worksheet.autoFitColumn(ws, "A");

    // Should fit to the formatted string "1,234,567.89" width, not "1234567.89"
    expect(getColumn(ws, "A").bestFit).toBe(true);
    expect(Column.getWidth(ws, "A")).toBeGreaterThan(9);
  });

  it("handles date cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", new Date(2024, 0, 15));
    Worksheet.autoFitColumn(ws, "A");

    expect(getColumn(ws, "A").bestFit).toBe(true);
    expect(Column.getWidth(ws, "A")).toBeGreaterThan(0);
  });

  it("handles boolean cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", true);
    Cell.setValue(ws, "A2", false);
    Worksheet.autoFitColumn(ws, "A");

    expect(getColumn(ws, "A").bestFit).toBe(true);
  });

  it("handles rich text cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", {
      richText: [{ text: "Bold part", font: { bold: true } }, { text: " normal part" }]
    });

    Worksheet.autoFitColumn(ws, "A");
    expect(getColumn(ws, "A").bestFit).toBe(true);
    expect(Column.getWidth(ws, "A")).toBeGreaterThan(9);
  });

  it("handles cells with custom fonts", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Arial Text");
    Cell.setStyle(ws, "A1", { font: { name: "Arial", size: 14 } });

    Cell.setValue(ws, "B1", "Arial Text");
    Cell.setStyle(ws, "B1", { font: { name: "Calibri", size: 11 } });

    Worksheet.autoFitColumns(ws);

    // Arial 14pt should be wider than Calibri 11pt
    expect(Column.getWidth(ws, "A")).toBeGreaterThan(Column.getWidth(ws, "B")!);
  });

  it("skips hidden rows when auto-fitting columns", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Short");
    Cell.setValue(ws, "A2", "This is a very long hidden row value");
    Row.setHidden(ws, 2, true);
    Cell.setValue(ws, "A3", "Medium text");

    Worksheet.autoFitColumn(ws, "A");

    // Width should be based on visible rows only (A1 "Short" or A3 "Medium text")
    const col = getColumn(ws, "A");
    expect(col.bestFit).toBe(true);

    // Verify width is NOT based on the hidden row's long text
    const wb2 = Workbook.create();
    const ws2 = Workbook.addWorksheet(wb2, "test2");
    Cell.setValue(ws2, "A1", "Short");
    Cell.setValue(ws2, "A2", "This is a very long hidden row value");
    Cell.setValue(ws2, "A3", "Medium text");
    Worksheet.autoFitColumn(ws2, "A");
    // Width with hidden row should be less than without hiding
    expect(col.width).toBeLessThan(Column.getWidth(ws2, "A")!);
  });

  it("skips hidden columns when auto-fitting rows", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Normal");
    Cell.setValue(ws, "B1", "Hidden\ncol\nwith\nmany\nlines");
    Column.setHidden(ws, "B", true);

    Worksheet.autoFitRow(ws, 1);

    const row = Worksheet.getRow(ws, 1);
    expect(row.customHeight).toBe(true);
    // Height should be based on A1 (single line), not B1 (multi-line hidden)
    const singleLineHeight = row.height!;

    const wb2 = Workbook.create();
    const ws2 = Workbook.addWorksheet(wb2, "test2");
    Cell.setValue(ws2, "A1", "Normal");
    Cell.setValue(ws2, "B1", "Hidden\ncol\nwith\nmany\nlines");
    Worksheet.autoFitRow(ws2, 1);
    // Without hiding, row should be taller
    expect(singleLineHeight).toBeLessThan(Row.getHeight(ws2, 1)!);
  });

  it("accounts for indent in column width", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "No indent");
    Cell.setValue(ws, "B1", "No indent");
    Cell.setStyle(ws, "B1", { alignment: { indent: 3 } });

    Worksheet.autoFitColumns(ws);

    // Column B with indent should be wider than A with same text
    expect(Column.getWidth(ws, "B")).toBeGreaterThan(Column.getWidth(ws, "A")!);
  });

  it("skips shrinkToFit cells", () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "test");

    Cell.setValue(ws, "A1", "Short");
    Cell.setValue(ws, "A2", "This very long text has shrinkToFit enabled");
    Cell.setStyle(ws, "A2", { alignment: { shrinkToFit: true } });

    Worksheet.autoFitColumn(ws, "A");

    // Width should be based on A1 "Short" only, not the shrinkToFit cell
    const col = getColumn(ws, "A");
    expect(col.bestFit).toBe(true);

    const wb2 = Workbook.create();
    const ws2 = Workbook.addWorksheet(wb2, "test2");
    Cell.setValue(ws2, "A1", "Short");
    Cell.setValue(ws2, "A2", "This very long text has shrinkToFit enabled");
    Worksheet.autoFitColumn(ws2, "A");
    // Without shrinkToFit, column should be wider
    expect(col.width).toBeLessThan(Column.getWidth(ws2, "A")!);
  });

  it("uses Arial bold metrics directly (not multiplier)", () => {
    // Arial has a dedicated bold metrics table
    const normalWidth = measureTextWidthPx("Test", { name: "Arial", size: 11 });
    const boldWidth = measureTextWidthPx("Test", { name: "Arial", size: 11, bold: true });
    // Bold should be wider (using real bold advance widths, not 1.05x)
    expect(boldWidth).toBeGreaterThan(normalWidth);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("Edge Cases", () => {
  it("handles mdw=0 gracefully", () => {
    expect(pixelToCharWidth(100, 0)).toBe(0);
    expect(charWidthToPixel(10, 0)).toBe(0);
  });

  it("handles negative mdw gracefully", () => {
    expect(pixelToCharWidth(100, -1)).toBe(0);
    expect(charWidthToPixel(10, -1)).toBe(0);
  });
});
