import { inflateSync } from "node:zlib";

import { cellSetAlignment, cellSetFont, cellSetValue } from "@excel/core/cell";
import { getCell } from "@excel/core/worksheet";
import { Cell, Column, Row, Sparkline, Workbook, Worksheet } from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";
import { describe, it, expect } from "vitest";

/**
 * Tests for PDF style rendering:
 * - Rich text runs inherit cell-level font properties (size, bold, italic)
 * - Text overflow suppresses internal vertical borders
 * - Indexed colors are correctly resolved
 * - Bounds expansion to include style-only cells beyond dimensions
 */

/** Decompress PDF content streams and return as a single string. */
function decompressPdfContent(pdfBytes: Uint8Array): string {
  const pdfStr = Buffer.from(pdfBytes).toString("latin1");
  const regex = /stream\r?\n([\s\S]*?)endstream/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(pdfStr)) !== null) {
    const raw = Buffer.from(m[1], "latin1");
    try {
      parts.push(inflateSync(raw).toString("latin1"));
    } catch {
      parts.push(raw.toString("latin1"));
    }
  }
  return parts.join("\n");
}

describe("PDF style rendering", () => {
  describe("Unmaterialised inherited styles", () => {
    async function renderColumnFill(materialise: boolean) {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      const fill = {
        type: "pattern" as const,
        pattern: "solid" as const,
        fgColor: { argb: "FFFF0000" }
      };
      Column.setStyle(ws, 2, { fill });
      Cell.setValue(ws, "A1", "A");
      Cell.setValue(ws, "C1", "C");
      if (materialise) {
        Cell.setStyle(ws, "B1", { fill });
      }

      const pdf = await excelToPdf(wb);
      return { content: decompressPdfContent(pdf), ws };
    }

    it("renders inherited column styles without materialising the empty cell", async () => {
      const virtual = await renderColumnFill(false);
      const explicit = await renderColumnFill(true);

      expect(virtual.content).toBe(explicit.content);
      expect(virtual.ws._rows[0]?.cells[1]).toBeUndefined();
    });

    it("renders inherited row font and border without materialising the empty cell", async () => {
      const inherited = {
        font: { bold: true },
        border: {
          top: { style: "thin" as const },
          bottom: { style: "thin" as const }
        }
      };
      const render = async (materialise: boolean) => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        Row.setStyle(ws, 1, inherited);
        Cell.setValue(ws, "A1", "A");
        Cell.setValue(ws, "C1", "C");
        if (materialise) {
          Cell.setStyle(ws, "B1", inherited);
        }
        return { content: decompressPdfContent(await excelToPdf(wb)), ws };
      };

      const virtual = await render(false);
      const explicit = await render(true);
      expect(virtual.content).toBe(explicit.content);
      expect(virtual.ws._rows[0]?.cells[1]).toBeUndefined();
    });

    it("renders a sheet whose only content is a styled cell", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setStyle(ws, "C3", {
        fill: {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFF0000" }
        }
      });

      // Style-only cells are deliberately excluded from worksheet dimensions.
      expect(Worksheet.dimensions(ws)).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });

      const content = decompressPdfContent(await excelToPdf(wb));
      expect((content.match(/1 0 0 rg/g) ?? []).length).toBe(1);
    });

    it("includes style-only cells above, left of, and below the value dimensions", async () => {
      const RED = {
        type: "pattern" as const,
        pattern: "solid" as const,
        fgColor: { argb: "FFFF0000" }
      };
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      // Only C3 carries a value, so `dimensions` is exactly C3:C3. The fills sit
      // above/left (A1), below (C9) and right (E3) of it.
      Cell.setValue(ws, "C3", "v");
      Cell.setStyle(ws, "A1", { fill: RED });
      Cell.setStyle(ws, "C9", { fill: RED });
      Cell.setStyle(ws, "E3", { fill: RED });

      expect(Worksheet.dimensions(ws)).toEqual({ top: 3, left: 3, bottom: 3, right: 3 });

      const content = decompressPdfContent(await excelToPdf(wb));
      // Bounds used to grow rightward only, so A1 and C9 were dropped.
      expect((content.match(/1 0 0 rg/g) ?? []).length).toBe(3);
    });

    it("expands PDF bounds for an inherited style to the right of the value dimensions", async () => {
      const inherited = {
        fill: {
          type: "pattern" as const,
          pattern: "solid" as const,
          fgColor: { argb: "FF00FF00" }
        }
      };
      const render = async (materialise: boolean) => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Sheet1");
        Column.setStyle(ws, 4, inherited);
        Cell.setValue(ws, "A1", "A");
        // E1 establishes row.cells.length = 5, then removing it leaves holes D1/E1
        // beyond the value dimensions while preserving the row's right extent.
        Cell.setValue(ws, "E1", "temporary");
        Cell.setValue(ws, "E1", null);
        if (materialise) {
          Cell.setStyle(ws, "D1", inherited);
        }
        return { content: decompressPdfContent(await excelToPdf(wb)), ws };
      };

      const virtual = await render(false);
      const explicit = await render(true);
      expect(virtual.content).toBe(explicit.content);
      expect(virtual.ws._rows[0]?.cells[3]).toBeUndefined();
    });

    it("does not materialise holes while converting rows", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "A");
      Cell.setValue(ws, "C1", "C");

      expect(ws._rows[0]?.cells[1]).toBeUndefined();
      await excelToPdf(wb);
      expect(ws._rows[0]?.cells[1]).toBeUndefined();
    });

    it("does not materialise cells on a sparkline's source worksheet", async () => {
      const wb = Workbook.create();
      const data = Workbook.addWorksheet(wb, "Data");
      Column.setStyle(data, 2, { numFmt: "0.00%" });
      Worksheet.addAoa(data, [[1, null, 3, 4, 5]]);
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "spark");
      Sparkline.add(ws, {
        type: "line",
        sparklines: [{ dataRef: "Data!A1:E1", cellRef: "B1" }]
      });

      expect(data._rows[0]?.cells[1]).toBeUndefined();
      await excelToPdf(wb);
      expect(data._rows[0]?.cells[1]).toBeUndefined();
    });
  });

  describe("Bug 1: Rich text inherits cell font properties", () => {
    it("should use cell font size for runs without explicit size", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 30);

      // Cell has font size 8, first run has no font (should inherit 8pt)
      const cell = getCell(ws, "A1");
      cellSetValue(cell, {
        richText: [{ text: "Hello " }, { text: "World", font: { size: 7 } }]
      });
      cellSetFont(cell, { size: 8, name: "Arial" });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // 8pt scaled should appear in Tf operator for the first run
      // 7pt scaled should appear for the second run
      const fontOps = content.match(/\/F\d+ ([\d.]+) Tf/g) || [];
      const sizes = fontOps.map(op => parseFloat(op.split(" ")[1]));

      // We should NOT see the global default 11pt (or its scaled equivalent)
      // Both runs should have sizes derived from 8pt or 7pt
      // scaleFactor maps 8 -> some value and 7 -> a smaller value
      // The key assertion: we have at least 2 different sizes, and no 11pt
      expect(sizes.length).toBeGreaterThanOrEqual(2);
      // All sizes should be <= 8 * scaleFactor (no 11pt leak)
      const maxSize = Math.max(...sizes);
      const minSize = Math.min(...sizes);
      // ratio should be close to 8/7 ≈ 1.14 (not 11/7 ≈ 1.57)
      expect(maxSize / minSize).toBeCloseTo(8 / 7, 1);
    });

    it("should inherit bold from cell style for runs without explicit bold", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 30);

      const cell = getCell(ws, "A1");
      cellSetValue(cell, {
        richText: [
          { text: "Bold text " }, // no font → inherits cell bold
          { text: "Normal", font: { bold: false, size: 10 } } // explicit non-bold
        ]
      });
      cellSetFont(cell, { bold: true, size: 10, name: "Arial" });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // F2 = bold font resource (Helvetica-Bold or similar)
      // The first run should use bold (F2), second should use regular (F1)
      const fontOps = content.match(/\/F\d+ [\d.]+ Tf/g) || [];
      const boldOps = fontOps.filter(op => op.startsWith("/F2"));
      const regularOps = fontOps.filter(op => op.startsWith("/F1"));

      expect(boldOps.length).toBeGreaterThan(0);
      expect(regularOps.length).toBeGreaterThan(0);
    });

    it("should NOT inherit bold when run has its own rPr without bold", async () => {
      // Reproduces Issue #154: "Test Code" (bold from cell) + "(Tests X)" (has rPr
      // with size/color but no <b/>, so should NOT be bold)
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 30);

      const cell = getCell(ws, "A1");
      cellSetValue(cell, {
        richText: [
          { text: "Test Code " }, // no font → inherits cell bold
          { text: "(Tests X)", font: { size: 7, name: "Arial" } } // has rPr but no <b/>
        ]
      });
      cellSetFont(cell, { bold: true, size: 8, name: "Arial" });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // First run should use bold font (F2), second should use regular (F1)
      const fontOps = content.match(/\/F\d+ [\d.]+ Tf/g) || [];
      const boldOps = fontOps.filter(op => op.startsWith("/F2"));
      const regularOps = fontOps.filter(op => op.startsWith("/F1"));

      // "Test Code " → bold (inherited from cell)
      expect(boldOps.length).toBeGreaterThan(0);
      // "(Tests X)" → NOT bold (run has its own font without bold)
      expect(regularOps.length).toBeGreaterThan(0);
    });

    it("should inherit italic from cell style for runs without explicit italic", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 30);

      const cell = getCell(ws, "A1");
      cellSetValue(cell, {
        richText: [
          { text: "Italic " }, // no font → inherits cell italic
          { text: "Normal", font: { italic: false, size: 10 } }
        ]
      });
      cellSetFont(cell, { italic: true, size: 10, name: "Arial" });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // Two different font resources should be used (italic vs regular),
      // confirming the first run inherited italic and got a different font
      // than the second run which explicitly has italic:false.
      const fontOps = content.match(/\/F\d+ [\d.]+ Tf/g) || [];
      const uniqueFonts = new Set(fontOps.map(op => op.split(" ")[0]));
      expect(uniqueFonts.size).toBe(2);
    });
  });

  describe("Bug 2: Text overflow hides internal vertical borders", () => {
    it("should suppress vertical borders in overflow region", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Very narrow columns — text will overflow from A1 into B1, C1
      Column.setWidth(ws, 1, 3);
      Column.setWidth(ws, 2, 3);
      Column.setWidth(ws, 3, 3);
      Column.setWidth(ws, 4, 3);

      // A1 has text that overflows; B1, C1 empty
      Cell.setValue(ws, "A1", "A VERY LONG TEXT THAT OVERFLOWS");
      Cell.setStyle(ws, "A1", { font: { size: 10 } });

      // All cells have thin borders on all sides
      for (let col = 1; col <= 4; col++) {
        Cell.setStyle(ws, 1, col, {
          border: {
            top: { style: "thin" },
            right: { style: "thin" },
            bottom: { style: "thin" },
            left: { style: "thin" }
          }
        });
      }
      // D1 has text to block overflow
      Cell.setValue(ws, "D1", "STOP");
      Cell.setStyle(ws, "D1", { font: { size: 10 } });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // Count stroke operations (S) — with overflow border suppression,
      // there should be fewer strokes than if all 4*4=16 borders were drawn
      const strokeCount = (content.match(/^S$/gm) || []).length;

      // Without suppression: 4 cells * 4 borders = 16, minus shared edges resolved
      // With suppression: internal vertical borders in overflow area removed
      // At minimum, A1's right border and B1's left border should be suppressed
      // We verify the count is less than the maximum possible
      expect(strokeCount).toBeLessThan(16);
    });

    it("should not suppress borders when text does not overflow", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Wide columns — text fits
      Column.setWidth(ws, 1, 40);
      Column.setWidth(ws, 2, 40);

      Cell.setValue(ws, "A1", "Short");
      Cell.setStyle(ws, "A1", { font: { size: 10 } });

      for (let col = 1; col <= 2; col++) {
        Cell.setStyle(ws, 1, col, {
          border: {
            top: { style: "thin" },
            right: { style: "thin" },
            bottom: { style: "thin" },
            left: { style: "thin" }
          }
        });
      }

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // All borders should be drawn (minus shared edge resolution)
      // A1.right and B1.left are shared — one is suppressed by resolveSharedBorders
      // So we expect: A1(top,bottom,left) + A1.right/B1.left (one wins) + B1(top,right,bottom)
      // = at least 6 strokes
      const strokeCount = (content.match(/^S$/gm) || []).length;
      expect(strokeCount).toBeGreaterThanOrEqual(6);
    });
  });

  describe("Bug 3: Indexed colors", () => {
    it("should resolve indexed color 64 (system foreground) to black", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);

      Cell.setValue(ws, "A1", "Test");
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thin", color: { indexed: 64 } as any }
        }
      });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // Should have a black stroke (0 0 0 RG)
      expect(content).toContain("0 0 0 RG");
    });

    it("should resolve indexed color 10 (Red) for font color", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);

      Cell.setValue(ws, "A1", "Red text");
      Cell.setStyle(ws, "A1", { font: { color: { indexed: 10 } as any, size: 10 } });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // indexed:10 = #FF0000 → 1 0 0 rg
      expect(content).toContain("1 0 0 rg");
    });

    it("should resolve indexed color 62 (Indigo) for font color", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);

      Cell.setValue(ws, "A1", "Indigo text");
      Cell.setStyle(ws, "A1", { font: { color: { indexed: 62 } as any, size: 10 } });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // indexed:62 = #333399 → 0.2 0.2 0.6 rg
      expect(content).toContain("0.2 0.2 0.6 rg");
    });

    it("should resolve indexed color in rich text runs", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 20);

      Cell.setValue(ws, "A1", {
        richText: [
          { text: "Normal " },
          { text: "Blue", font: { color: { indexed: 39 } as any, size: 10 } }
        ]
      });
      Cell.setStyle(ws, "A1", { font: { size: 10 } });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // indexed:39 = #0000FF → 0 0 1 rg
      expect(content).toContain("0 0 1 rg");
    });
  });

  describe("Bounds expansion for style-only cells", () => {
    it("should include cells with borders beyond value-based dimensions", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Only A1 has a value (dimensions will report right=1)
      Cell.setValue(ws, "A1", "Data");
      Cell.setStyle(ws, "A1", { font: { size: 10 } });

      // D1 has only a border, no value — should still be included in PDF
      Cell.setStyle(ws, "D1", {
        border: {
          top: { style: "medium" },
          bottom: { style: "medium" }
        }
      });
      // Set column widths so we can verify D is rendered
      Column.setWidth(ws, 1, 10);
      Column.setWidth(ws, 2, 10);
      Column.setWidth(ws, 3, 10);
      Column.setWidth(ws, 4, 10);

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // The PDF should contain stroke operations for the medium border on D1
      // Medium border width = 0.5, so look for setLineWidth(0.5) → "0.5 w"
      expect(content).toContain("0.5 w");
    });

    it("should include cells with fill beyond value-based dimensions", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      Cell.setValue(ws, "A1", "Data");
      Cell.setStyle(ws, "A1", { font: { size: 10 } });

      // C1 has only a fill — should be included
      Cell.setStyle(ws, "C1", {
        fill: {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFF0000" }
        }
      });
      Column.setWidth(ws, 1, 10);
      Column.setWidth(ws, 2, 10);
      Column.setWidth(ws, 3, 10);

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // Red fill → 1 0 0 rg followed by rect fill
      expect(content).toContain("1 0 0 rg");
    });
  });

  describe("Issue #154: Border thickness distinction", () => {
    it("should produce visually distinct line widths for thin vs medium borders", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 15);
      Column.setWidth(ws, 2, 15);

      Cell.setValue(ws, "A1", "Thin");
      Cell.setStyle(ws, "A1", { font: { size: 10 } });
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thin", color: { argb: "FF000000" } },
          bottom: { style: "thin", color: { argb: "FF000000" } }
        }
      });

      Cell.setValue(ws, "B1", "Medium");
      Cell.setStyle(ws, "B1", { font: { size: 10 } });
      Cell.setStyle(ws, "B1", {
        border: {
          top: { style: "medium", color: { argb: "FF000000" } },
          bottom: { style: "medium", color: { argb: "FF000000" } }
        }
      });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // thin = 0.25pt, medium = 0.5pt — both should appear in PDF content
      expect(content).toContain("0.25 w");
      expect(content).toContain("0.5 w");
    });

    it("should produce distinct widths for thin, medium, and thick", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10);

      Cell.setValue(ws, "A1", "Test");
      Cell.setStyle(ws, "A1", { font: { size: 10 } });
      Cell.setStyle(ws, "A1", {
        border: {
          top: { style: "thin", color: { argb: "FF000000" } },
          bottom: { style: "medium", color: { argb: "FF000000" } },
          left: { style: "thick", color: { argb: "FF000000" } }
        }
      });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // All three widths should be distinct and present
      expect(content).toContain("0.25 w");
      expect(content).toContain("0.5 w");
      expect(content).toContain("1 w");
    });
  });

  describe("Issue #154: Rich text per-line height in wrap mode", () => {
    it("should use per-line max font size for line height in wrapped rich text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Column.setWidth(ws, 1, 10); // narrow to force wrapping

      const cell = getCell(ws, "A1");
      cellSetValue(cell, {
        richText: [
          { text: "Big ", font: { size: 14 } },
          { text: "text\n", font: { size: 14 } },
          { text: "small text", font: { size: 7 } }
        ]
      });
      cellSetFont(cell, { size: 10 });
      cellSetAlignment(cell, { wrapText: true });

      const pdf = await excelToPdf(wb);
      const content = decompressPdfContent(pdf);

      // The PDF should render the two different font sizes
      // 14pt and 7pt scaled by scaleFactor should produce different Tf sizes
      const fontOps = content.match(/\/F\d+ ([\d.]+) Tf/g) || [];
      const sizes = fontOps.map(op => parseFloat(op.split(" ")[1]));

      // Should have at least two distinct sizes
      const uniqueSizes = [...new Set(sizes)];
      expect(uniqueSizes.length).toBeGreaterThanOrEqual(2);

      // The ratio between largest and smallest should be close to 14/7 = 2
      const maxSize = Math.max(...sizes);
      const minSize = Math.min(...sizes);
      expect(maxSize / minSize).toBeCloseTo(2, 0);
    });
  });
});
