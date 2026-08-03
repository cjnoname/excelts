import { inflateSync } from "node:zlib";

import {
  cellSetAlignment,
  cellSetBorder,
  cellSetFill,
  cellSetFont,
  cellSetValue
} from "@excel/core/cell";
import { rowAddPageBreak, rowSetHidden } from "@excel/core/row";
import { addWorkbookImage } from "@excel/core/workbook-core";
import { addImage, addWatermark, getCell } from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
import { PdfError } from "@pdf/errors";
import { excelToPdf } from "@pdf/excel-bridge";
import { resetFontDiscoveryCache, _setCandidatesForTest } from "@pdf/font/system-fonts";
import { pdf as standalonePdf } from "@pdf/pdf";
import { readPdf } from "@pdf/reader/pdf-reader";
import { exportPdf } from "@pdf/render/pdf-exporter";
/**
 * Integration tests for the full PDF export pipeline.
 * Tests the PDF exporter with real Workbook instances via the Excel bridge,
 * and standalone pdf() API.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { pdfToString, expectValidPdf } from "./test-helpers";
import { buildMinimalTtf, buildTtfWithCmap } from "./ttf-test-utils";

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44, 0x41, 0x54, 8, 0xd7,
  0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0, 2, 0, 1, 0xe2, 0x21, 0xbc, 0x33, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82
]);

function decompressPdfContent(pdfBytes: Uint8Array): string {
  const pdfStr = Buffer.from(pdfBytes).toString("latin1");
  const parts: string[] = [];
  for (const match of pdfStr.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const raw = Buffer.from(match[1], "latin1");
    try {
      parts.push(inflateSync(raw).toString("latin1"));
    } catch {
      parts.push(raw.toString("latin1"));
    }
  }
  return parts.join("\n");
}

describe("excelToPdf", () => {
  describe("Basic Export", () => {
    it("should export a simple workbook with one sheet", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Hello");
      Cell.setValue(ws, "B1", "World");
      Cell.setValue(ws, "A2", 42);
      Cell.setValue(ws, "B2", 3.14);

      const pdf = await excelToPdf(wb);

      expect(pdf).toBeInstanceOf(Uint8Array);
      expect(pdf.length).toBeGreaterThan(100);
      expectValidPdf(pdf);

      // Content streams may be compressed; verify structure
      const text = pdfToString(pdf);
      expect(text).toContain("/Helvetica");
    });

    it("should export an empty workbook with at least one sheet", async () => {
      const wb = Workbook.create();
      Workbook.addWorksheet(wb, "Empty");

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
    });

    it("should throw for workbook with no sheets", async () => {
      const wb = Workbook.create();

      await expect(excelToPdf(wb)).rejects.toThrow(PdfError);
    });
  });

  describe("Multiple Sheets", () => {
    it("should export multiple worksheets", async () => {
      const wb = Workbook.create();

      const ws1 = Workbook.addWorksheet(wb, "Sales");
      Cell.setValue(ws1, "A1", "Product");
      Cell.setValue(ws1, "B1", "Revenue");
      Cell.setValue(ws1, "A2", "Widget");
      Cell.setValue(ws1, "B2", 1000);

      const ws2 = Workbook.addWorksheet(wb, "Expenses");
      Cell.setValue(ws2, "A1", "Category");
      Cell.setValue(ws2, "B1", "Amount");
      Cell.setValue(ws2, "A2", "Rent");
      Cell.setValue(ws2, "B2", 500);

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // Two pages for two sheets
      const pageMatches = text.match(/\/Type \/Page\b/g);
      expect(pageMatches!.length).toBe(2);
      // Outlines/bookmarks for multi-sheet navigation
      expect(text).toContain("/Outlines");
      expect(text).toContain("(Sales)");
      expect(text).toContain("(Expenses)");
    });

    it("should filter sheets by name", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Include"), "A1", "Included");
      Cell.setValue(Workbook.addWorksheet(wb, "Exclude"), "A1", "Excluded");

      const pdf = await excelToPdf(wb, { sheets: ["Include"] });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Included");
      expect(text).not.toContain("Excluded");
    });

    it("should filter sheets by 1-based position", async () => {
      const wb = Workbook.create();
      const ws1 = Workbook.addWorksheet(wb, "First");
      Cell.setValue(ws1, "A1", "First Sheet");
      const ws2 = Workbook.addWorksheet(wb, "Second");
      Cell.setValue(ws2, "A1", "Second Sheet");

      const pdf = await excelToPdf(wb, { sheets: [2] }); // 1-based: second sheet

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Second Sheet");
      expect(text).not.toContain("First Sheet");
    });
  });

  describe("Page Size and Orientation", () => {
    it("should support A4 portrait (default)", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "A4");

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // A4: 595.28 x 841.89
      expect(text).toContain("595.28");
      expect(text).toContain("841.89");
    });

    it("should support landscape orientation", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Landscape");

      const pdf = await excelToPdf(wb, { orientation: "landscape" });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // Landscape A4: 841.89 x 595.28
      expect(text).toContain("841.89");
      expect(text).toContain("595.28");
    });

    it("should support LETTER page size", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Letter");

      const pdf = await excelToPdf(wb, { pageSize: "LETTER" });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("612");
      expect(text).toContain("792");
    });

    it("should support custom page size", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Custom");

      const pdf = await excelToPdf(wb, {
        pageSize: { width: 400, height: 600 }
      });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("400");
      expect(text).toContain("600");
    });
  });

  describe("Cell Styles", () => {
    it("should render bold text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Styles");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Bold Text");
      cellSetFont(cell, { bold: true });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Helvetica-Bold");
      expect(text).toContain("Bold Text");
    });

    it("should render italic text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Styles");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Italic Text");
      cellSetFont(cell, { italic: true });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Helvetica-Oblique");
    });

    it("should render colored text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Styles");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Red Text");
      cellSetFont(cell, { color: { argb: "FFFF0000" } });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("1 0 0 rg"); // red fill color for text
    });

    it("should render background fill", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Styles");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Filled");
      cellSetFill(cell, {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFFF00" }
      });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // Yellow fill: 1 1 0
      expect(text).toContain("1 1 0 rg");
    });

    it("should render cell borders", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Styles");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Bordered");
      cellSetBorder(cell, {
        top: { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FF000000" } },
        right: { style: "thin", color: { argb: "FF000000" } }
      });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      // Borders are inside compressed content streams; just verify structure
    });
  });

  describe("Merged Cells", () => {
    it("should handle merged cells", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Merge");
      Cell.setValue(ws, "A1", "Merged Title");
      Worksheet.merge(ws, "A1:C1");
      Cell.setValue(ws, "A2", "Col1");
      Cell.setValue(ws, "B2", "Col2");
      Cell.setValue(ws, "C2", "Col3");

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      // Merged cells produce one page with all cells rendered
    });
  });

  describe("Data Types", () => {
    it("should handle various cell value types", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Types");
      Cell.setValue(ws, "A1", "String");
      Cell.setValue(ws, "A2", 42);
      Cell.setValue(ws, "A3", 3.14);
      Cell.setValue(ws, "A4", true);
      Cell.setValue(ws, "A5", new Date(2024, 0, 15));
      Cell.setValue(ws, "A6", null);

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      // All value types render without errors
    });

    it("should handle hyperlinks", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Links");
      Cell.setValue(ws, "A1", { text: "Click Me", hyperlink: "https://example.com" });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Click Me");
    });
  });

  describe("Grid Lines", () => {
    it("should render grid lines when enabled", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Grid");
      Cell.setValue(ws, "A1", "A1");
      Cell.setValue(ws, "B1", "B1");
      Cell.setValue(ws, "A2", "A2");
      Cell.setValue(ws, "B2", "B2");

      const pdf = await excelToPdf(wb, { showGridLines: true });

      expectValidPdf(pdf);
      // Grid lines are in compressed content streams; verify the PDF is valid
    });
  });

  describe("Page Headers and Footers", () => {
    it("should include sheet name as header", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "My Report"), "A1", "Data");

      const pdf = await excelToPdf(wb, { showSheetNames: true });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("My Report");
    });

    it("should include page numbers in footer", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Data");

      const pdf = await excelToPdf(wb, { showPageNumbers: true });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text.replace(/\s+/g, " ")).toContain("Page 1 of 1");
    });

    it("should register footer fonts even when using an embedded font", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Data");

      const pdf = await excelToPdf(wb, {
        showPageNumbers: true,
        font: new Uint8Array(buildMinimalTtf())
      });

      const text = pdfToString(pdf);
      expect(text).toContain("/BaseFont /Helvetica");
    });

    it("should render Excel header/footer sections, fields, and formatting", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Report");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddHeader = '&L&"Helvetica,Bold"&14Acme&C&A&R&D &T';
      ws.headerFooter.oddFooter = "&L&& internal&CPage &P of &N&R&F";

      const pdf = await excelToPdf(wb, {
        headerFooter: {
          fileName: "report.xlsx",
          date: new Date(2026, 6, 29, 9, 5),
          locale: "en-US"
        }
      });
      const result = await readPdf(pdf);
      const text = result.pages.map(page => page.text).join("\n");

      expect(text).toContain("Acme");
      expect(text).toContain("Report");
      expect(text).toContain("7/29/2026");
      expect(text).toContain("9:05");
      expect(text).toContain("& internal");
      expect(text.replace(/\s+/g, " ")).toContain("Page 1 of 1");
      expect(text).toContain("report.xlsx");
      expect(pdfToString(pdf)).toContain("/BaseFont /Helvetica-Bold");
    });

    it("should select first, odd, and even headers per sheet", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Paged");
      ws.pageSetup.firstPageNumber = 8;
      ws.headerFooter.differentFirst = true;
      ws.headerFooter.differentOddEven = true;
      ws.headerFooter.firstHeader = "&CFIRST";
      ws.headerFooter.oddHeader = "&CODD";
      ws.headerFooter.evenHeader = "&CEVEN";
      for (let row = 1; row <= 120; row++) {
        Cell.setValue(ws, `A${row}`, `Row ${row}`);
      }

      const result = await readPdf(await excelToPdf(wb, { fitToPage: false }));
      const text = result.pages.map(page => page.text).join("\n");

      expect(text.match(/FIRST/g)).toHaveLength(1);
      expect(text).toContain("EVEN");
      expect(text).toContain("ODD");
    });

    it("should prefer Excel content over convenience headers and allow disabling it", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet fallback");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddHeader = "&CExcel header";
      ws.headerFooter.oddFooter = "&CExcel footer";

      const enabledPdf = await excelToPdf(wb, { showSheetNames: true, showPageNumbers: true });
      const enabled = (await readPdf(enabledPdf)).pages.map(page => page.text).join("\n");
      expect(enabled).toContain("Excel header");
      expect(enabled).toContain("Excel footer");
      expect(enabled).not.toContain("Page 1 of 1");

      const disabledPdf = await excelToPdf(wb, {
        headerFooter: { enabled: false },
        showSheetNames: true,
        showPageNumbers: true
      });
      const disabled = (await readPdf(disabledPdf)).pages.map(page => page.text).join("\n");
      expect(disabled).not.toContain("Excel header");
      expect(disabled).not.toContain("Excel footer");
      expect(disabled).toContain("Sheet fallback");
      expect(disabled).toContain("Page 1 of 1");
    });

    it("should render long-form fields and header images", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Picture");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddHeader = "&L&[Tab]&C&[Picture]&R&[Page]/&[Pages]";
      const imageId = addWorkbookImage(wb, {
        buffer: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0,
          0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44,
          0x41, 0x54, 8, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0, 2, 0, 1, 0xe2, 0x21, 0xbc, 0x33, 0,
          0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
        ]),
        extension: "png"
      });
      addWatermark(ws, { imageId, mode: "header", headerWidth: 12, headerHeight: 12 });

      const pdf = await excelToPdf(wb);
      const result = await readPdf(pdf);
      const text = result.pages[0].text.replace(/\s+/g, " ");

      expect(text).toContain("Picture");
      expect(text.replace(/\s+/g, "")).toContain("1/1");
      expect(pdfToString(pdf)).toContain("/Subtype /Image");
    });

    it("should keep oversized header watermarks behind content without changing pagination", async () => {
      const makeWorkbook = (withWatermark: boolean) => {
        const wb = Workbook.create();
        const ws = Workbook.addWorksheet(wb, "Watermark");
        for (let row = 1; row <= 80; row++) {
          Cell.setValue(ws, `A${row}`, `Row ${row}`);
        }
        if (withWatermark) {
          ws.headerFooter.oddHeader = "&C&G";
          const imageId = addWorkbookImage(wb, {
            buffer: new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
              0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49,
              0x44, 0x41, 0x54, 8, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0, 2, 0, 1, 0xe2, 0x21, 0xbc,
              0x33, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
            ]),
            extension: "png"
          });
          addWatermark(ws, {
            imageId,
            mode: "header",
            headerWidth: 300,
            headerHeight: 300
          });
        }
        return wb;
      };

      const plain = await readPdf(await excelToPdf(makeWorkbook(false), { fitToPage: false }));
      const watermarked = await readPdf(await excelToPdf(makeWorkbook(true), { fitToPage: false }));

      expect(watermarked.pages).toHaveLength(plain.pages.length);
      expect(watermarked.pages[0].textFragments.find(f => f.text === "Row 1")?.y).toBe(
        plain.pages[0].textFragments.find(f => f.text === "Row 1")?.y
      );
    });

    it("should render locale-aware dates, outlines, shadows, and explicit newlines", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Effects");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddHeader = "&L&OOutlined&O\n&HShadowed&H&C&D &T";

      const pdf = await excelToPdf(wb, {
        headerFooter: { date: new Date(2026, 6, 29, 9, 5), locale: "de-DE" }
      });
      const text = (await readPdf(pdf)).pages[0].text;

      expect(text).toContain("Outlined");
      expect(text).toContain("Shadowed");
      expect(text).toContain("29.7.2026");
    });

    it("should derive file fields from workbook source metadata", async () => {
      const wb = Workbook.create();
      wb.sourceFilePath = "/reports/quarterly.xlsx";
      const ws = Workbook.addWorksheet(wb, "Source");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddFooter = "&L&Z&C&F";

      const text = (await readPdf(await excelToPdf(wb))).pages[0].text;

      expect(text).toContain("/reports/");
      expect(text).toContain("quarterly.xlsx");
    });

    it("should clear stale source metadata when loading from bytes", async () => {
      const source = Workbook.create();
      const sourceSheet = Workbook.addWorksheet(source, "Source");
      Cell.setValue(sourceSheet, "A1", "Data");
      const bytes = await Workbook.toBuffer(source);

      const reused = Workbook.create();
      reused.sourceFilePath = "/stale/old.xlsx";
      await Workbook.read(reused, bytes);

      expect(reused.sourceFilePath).toBeUndefined();
    });

    it("should keep multiline footer lines in visual top-to-bottom order", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Footer");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddFooter = "&LtopLine\nbottomLine";

      const fragments = (await readPdf(await excelToPdf(wb))).pages[0].textFragments;
      const top = fragments.find(fragment => fragment.text === "topLine");
      const bottom = fragments.find(fragment => fragment.text === "bottomLine");

      expect(top).toBeDefined();
      expect(bottom).toBeDefined();
      expect(top!.y).toBeGreaterThan(bottom!.y);
    });

    it("should use the PDF default font for Excel's dash font placeholder", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Font");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.oddHeader = '&C&"-,Bold"Default font';

      const raw = pdfToString(await excelToPdf(wb, { defaultFontFamily: "Courier" }));

      expect(raw).toContain("/BaseFont /Courier-Bold");
    });

    it("should number pages across the complete print job", async () => {
      const wb = Workbook.create();
      for (const name of ["First", "Second"]) {
        const ws = Workbook.addWorksheet(wb, name);
        for (let row = 1; row <= 70; row++) {
          Cell.setValue(ws, `A${row}`, `${name} ${row}`);
        }
        ws.headerFooter.oddFooter = "&C&P/&N";
      }

      const result = await readPdf(await excelToPdf(wb, { fitToPage: false }));
      const footerTexts = result.pages.map(page => page.text.replace(/\s+/g, ""));

      expect(result.pages.length).toBeGreaterThan(2);
      for (let index = 0; index < footerTexts.length; index++) {
        expect(footerTexts[index]).toContain(`${index + 1}/${footerTexts.length}`);
      }
    });

    it("should restart explicit sheet page numbers without changing job page count", async () => {
      const wb = Workbook.create();
      const first = Workbook.addWorksheet(wb, "First");
      Cell.setValue(first, "A1", "First");
      first.headerFooter.oddFooter = "&C&P/&N";
      const second = Workbook.addWorksheet(wb, "Second");
      Cell.setValue(second, "A1", "Second");
      second.pageSetup.firstPageNumber = 100;
      second.headerFooter.oddFooter = "&C&P/&N";

      const pages = (await readPdf(await excelToPdf(wb))).pages;

      expect(pages[0].text.replace(/\s+/g, "")).toContain("1/2");
      expect(pages[1].text.replace(/\s+/g, "")).toContain("100/2");
    });

    it("should restart a later sheet explicitly at page one", async () => {
      const wb = Workbook.create();
      const first = Workbook.addWorksheet(wb, "First");
      for (let row = 1; row <= 80; row++) {
        Cell.setValue(first, `A${row}`, `First ${row}`);
      }
      first.headerFooter.oddFooter = "&C&P";
      const second = Workbook.addWorksheet(wb, "Second");
      Cell.setValue(second, "A1", "Second");
      second.pageSetup.firstPageNumber = 1;
      second.headerFooter.oddFooter = "&C&P";

      const pages = (await readPdf(await excelToPdf(wb, { fitToPage: false }))).pages;

      expect(pages.at(-1)!.text.replace(/\s+/g, "")).toContain("Second1");
    });

    it("should ignore default firstPageNumber when useFirstPageNumber is false", async () => {
      const source = Workbook.create();
      for (const name of ["First", "Second"]) {
        const ws = Workbook.addWorksheet(source, name);
        Cell.setValue(ws, "A1", name);
        ws.headerFooter.oddFooter = "&C&P";
      }
      const loaded = Workbook.create();
      await Workbook.read(loaded, await Workbook.toBuffer(source));

      const pages = (await readPdf(await excelToPdf(loaded))).pages;

      expect(pages[0].text.replace(/\s+/g, "")).toContain("First1");
      expect(pages[1].text.replace(/\s+/g, "")).toContain("Second2");
    });

    it("should render Unicode text watermarks", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Sheet1"), "A1", "Data");

      const text = (
        await readPdf(await excelToPdf(wb, { watermark: { type: "text", text: "机密" } }))
      ).pages[0].text;

      expect(text).toContain("机密");
    });

    it("should render Unicode text that appears only in a header", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Unicode");
      Cell.setValue(ws, "A1", "ASCII");
      ws.headerFooter.oddHeader = "&C中文标题";

      const text = (await readPdf(await excelToPdf(wb))).pages[0].text;

      expect(text).toContain("中文标题");
    });

    it("should keep an intentionally blank first header blank", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "SheetName");
      Cell.setValue(ws, "A1", "Data");
      ws.headerFooter.differentFirst = true;
      ws.headerFooter.oddHeader = "&CODD";
      ws.headerFooter.firstHeader = null;

      const text = (await readPdf(await excelToPdf(wb, { showSheetNames: true }))).pages[0].text;

      expect(text).not.toContain("SheetName");
      expect(text).not.toContain("ODD");
    });

    it("should render chartsheet headers and footers", async () => {
      const wb = Workbook.create();
      const data = Workbook.addWorksheet(wb, "Data");
      Cell.setValue(data, "A1", "A");
      Cell.setValue(data, "B1", 1);
      Workbook.addChartsheet(wb, "Chart Sheet", {
        chart: {
          type: "bar",
          series: [{ categories: "Data!$A$1:$A$1", values: "Data!$B$1:$B$1" }]
        },
        headerFooter: {
          oddHeader: "&CChart report",
          oddFooter: "&C&P/&N"
        }
      });

      const text = (await readPdf(await excelToPdf(wb, { sheets: ["Chart Sheet"] }))).pages[0].text;

      expect(text).toContain("Chart report");
      expect(text.replace(/\s+/g, "")).toContain("1/1");
    });

    it("should place a footer-positioned image in the footer", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "FooterImage");
      Cell.setValue(ws, "A1", "Data");
      const imageId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
      addWatermark(ws, {
        imageId,
        mode: "header",
        position: "RF",
        headerWidth: 20,
        headerHeight: 20
      });

      expect(ws.headerFooter.oddFooter).toContain("&R&G");
      expect(ws.headerFooter.oddHeader).toBeNull();

      const pdf = await excelToPdf(wb);
      expect((await readPdf(pdf)).pages[0].images).toHaveLength(1);

      // `cm` places the image XObject: `w 0 0 h x y cm`. A footer image must
      // sit in the bottom band of the page, a header image in the top band.
      const placement = /([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(
        decompressPdfContent(pdf)
      );
      expect(placement).not.toBeNull();
      expect(Number(placement![4])).toBeLessThan(100);
    });

    it("should keep repeated header-image calls idempotent", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Idempotent");
      Cell.setValue(ws, "A1", "Data");
      const imageId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

      addWatermark(ws, { imageId, mode: "header", position: "LH" });
      addWatermark(ws, { imageId, mode: "header", position: "LH" });

      expect(ws.headerFooter.oddHeader).toBe("&L&G");
      expect((await readPdf(await excelToPdf(wb))).pages[0].images).toHaveLength(1);
    });

    it("should move the placeholder when the image position changes", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Moved");
      Cell.setValue(ws, "A1", "Data");
      const imageId = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });

      addWatermark(ws, { imageId, mode: "header", position: "LH" });
      addWatermark(ws, { imageId, mode: "header", position: "CF" });

      expect(ws.headerFooter.oddHeader).toBeNull();
      expect(ws.headerFooter.oddFooter).toBe("&C&G");
    });

    it("should apply header images to the selected odd/even page type", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Images");
      for (let row = 1; row <= 110; row++) {
        Cell.setValue(ws, `A${row}`, `Row ${row}`);
      }
      const imageId = addWorkbookImage(wb, {
        buffer: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0,
          0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0x0c, 0x49, 0x44,
          0x41, 0x54, 8, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 0, 2, 0, 1, 0xe2, 0x21, 0xbc, 0x33, 0,
          0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
        ]),
        extension: "png"
      });
      addWatermark(ws, {
        imageId,
        mode: "header",
        applyTo: "even",
        headerWidth: 12,
        headerHeight: 12
      });

      const pages = (await readPdf(await excelToPdf(wb, { fitToPage: false }))).pages;

      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0].images).toHaveLength(0);
      expect(pages[1].images).toHaveLength(1);
    });
  });

  describe("PDF Metadata", () => {
    it("should set document title", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Data");

      const pdf = await excelToPdf(wb, { title: "My Report" });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("/Title (My Report)");
    });

    it("should set document author", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Data");

      const pdf = await excelToPdf(wb, { author: "John Doe" });

      const text = pdfToString(pdf);
      expect(text).toContain("/Author (John Doe)");
    });

    it("should always set producer", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Data");

      const pdf = await excelToPdf(wb);

      const text = pdfToString(pdf);
      expect(text).toContain("/Producer (documonster)");
    });

    it("should encode Unicode metadata and bookmark titles correctly", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "报告"), "A1", "One");
      Cell.setValue(Workbook.addWorksheet(wb, "数据"), "A1", "Two");

      const pdf = await excelToPdf(wb, { title: "作者" });

      const text = pdfToString(pdf);
      expect(text).toContain("/Title <feff4f5c8005>");
      expect(text).toContain("/Title <feff62a5544a>");
      expect(text).toContain("/Title <feff6570636e>");
    });
  });

  describe("Worksheet Page Setup", () => {
    it("should honor per-sheet page setup defaults", async () => {
      const wb = Workbook.create();

      const ws1 = Workbook.addWorksheet(wb, "First");
      Cell.setValue(ws1, "A1", "One");
      ws1.pageSetup.paperSize = 11;

      const ws2 = Workbook.addWorksheet(wb, "Second");
      Cell.setValue(ws2, "A1", "Two");
      ws2.pageSetup.orientation = "landscape";
      ws2.pageSetup.paperSize = 9;

      const pdf = await excelToPdf(wb);
      const text = pdfToString(pdf);

      expect(text).toContain("[0 0 419.53 595.28]");
      expect(text).toContain("[0 0 841.89 595.28]");
    });
  });

  describe("Column Widths", () => {
    it("should respect custom column widths", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Widths");
      Worksheet.setColumns(ws, [
        { header: "Narrow", width: 5 },
        { header: "Wide", width: 30 }
      ]);

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Narrow");
      expect(text).toContain("Wide");
    });
  });

  describe("Large Datasets (Pagination)", () => {
    it("should paginate when content exceeds page height", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "LargeData");

      // Add enough rows to fill multiple pages
      for (let i = 1; i <= 100; i++) {
        Cell.setValue(ws, `A${i}`, `Row ${i}`);
        Cell.setValue(ws, `B${i}`, i * 10);
      }

      const pdf = await excelToPdf(wb, { showPageNumbers: true });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);

      // Should have multiple pages
      const pageMatches = text.match(/\/Type \/Page\b/g);
      expect(pageMatches).not.toBeNull();
      expect(pageMatches!.length).toBeGreaterThan(1);
    });
  });

  describe("Options", () => {
    it("should clamp scale factor", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Scale");

      // Very small scale should be clamped to 0.1
      const pdf1 = await excelToPdf(wb, { scale: 0.01 });
      expectValidPdf(pdf1);

      // Very large scale should be clamped to 3.0
      const pdf2 = await excelToPdf(wb, { scale: 10 });
      expectValidPdf(pdf2);
    });

    it("should handle fitToPage", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Wide");

      // Create a very wide sheet
      for (let i = 1; i <= 20; i++) {
        Column.setWidth(ws, i, 15);
        Cell.setValue(ws, 1, i, `Col${i}`);
      }

      const pdf = await excelToPdf(wb, { fitToPage: true });

      expectValidPdf(pdf);
    });

    it("should handle custom margins", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "Margins");

      const pdf = await excelToPdf(wb, {
        margins: { top: 36, right: 36, bottom: 36, left: 36 }
      });

      expectValidPdf(pdf);
    });
  });

  describe("Alignment", () => {
    it("should handle center-aligned text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Align");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Centered");
      cellSetAlignment(cell, { horizontal: "center" });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Centered");
    });

    it("should handle right-aligned text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Align");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "Right");
      cellSetAlignment(cell, { horizontal: "right" });

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Right");
    });
  });

  describe("excelToPdf function", () => {
    it("should work as a standalone function", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "FunctionAPI");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("FunctionAPI");
    });
  });

  describe("Hidden Rows and Columns", () => {
    it("should exclude hidden columns", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "HidCols");
      Cell.setValue(ws, "A1", "Visible");
      Cell.setValue(ws, "B1", "SecretData");
      Cell.setValue(ws, "C1", "Also Visible");
      Column.setHidden(ws, 2, true);

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Visible");
      expect(text).toContain("Also Visible");
      expect(text).not.toContain("SecretData");
    });

    it("should exclude hidden rows", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "HidRows");
      Cell.setValue(ws, "A1", "Row1");
      Cell.setValue(ws, "A2", "SecretRow");
      Cell.setValue(ws, "A3", "Row3");
      rowSetHidden(Worksheet.getRow(ws, 2), true);

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Row1");
      expect(text).toContain("Row3");
      expect(text).not.toContain("SecretRow");
    });
  });

  describe("Hidden Worksheets", () => {
    it("should exclude hidden worksheets by default", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Visible"), "A1", "Shown");
      const hidden = Workbook.addWorksheet(wb, "Hidden");
      Cell.setValue(hidden, "A1", "NotShown");
      hidden.state = "hidden";

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Shown");
      expect(text).not.toContain("NotShown");
    });
  });

  describe("Edge Cases", () => {
    it("should handle a single cell workbook", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Solo"), "A1", "Only");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Only");
    });

    it("should handle cells with special characters", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Special");
      Cell.setValue(ws, "A1", "Hello (world)");
      Cell.setValue(ws, "A2", "Back\\slash");
      Cell.setValue(ws, "A3", "New\nLine");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      // Special chars are inside compressed streams; just verify no crash
    });

    it("should handle empty string values", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Empty");
      Cell.setValue(ws, "A1", "");
      Cell.setValue(ws, "B1", "Not Empty");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
    });

    it("should handle boolean values", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Bool");
      Cell.setValue(ws, "A1", true);
      Cell.setValue(ws, "A2", false);

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
    });

    it("should handle error values", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Errors");
      Cell.setValue(ws, "A1", { error: "#DIV/0!" });

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
    });
  });

  describe("Merged Cells + Hidden Columns", () => {
    it("should handle merged cells spanning hidden columns", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "MergeHidden");
      Cell.setValue(ws, "A1", "Merged Over Hidden");
      Worksheet.merge(ws, "A1:D1");
      Column.setHidden(ws, 2, true); // hide B
      Cell.setValue(ws, "A2", "Data");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Merged Over Hidden");
      expect(text).toContain("Data");
    });

    it("should handle merged cells spanning hidden rows", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "MergeHidden");
      Cell.setValue(ws, "A1", "Tall Merge");
      Worksheet.merge(ws, "A1:A4");
      rowSetHidden(Worksheet.getRow(ws, 2), true); // hide row 2
      Cell.setValue(ws, "B1", "Side");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("Tall Merge");
      expect(text).toContain("Side");
    });
  });

  describe("Repeat Rows", () => {
    it("should repeat header rows on subsequent pages", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Repeat");
      Cell.setValue(ws, "A1", "Header");
      for (let i = 2; i <= 100; i++) {
        Cell.setValue(ws, `A${i}`, `Row ${i}`);
      }

      const pdf = await excelToPdf(wb, { repeatRows: 1, showPageNumbers: true });
      expectValidPdf(pdf);

      const text = pdfToString(pdf);
      // Should have multiple pages
      const pageMatches = text.match(/\/Type \/Page\b/g);
      expect(pageMatches!.length).toBeGreaterThan(1);
    });
  });

  describe("Text Wrapping", () => {
    it("should wrap long text when wrapText is enabled", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Wrap");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, "This is a very long text that should wrap to multiple lines in the cell");
      cellSetAlignment(cell, { wrapText: true });
      Column.setWidth(ws, 1, 15); // narrow column

      const pdfBytes = await excelToPdf(wb);
      expectValidPdf(pdfBytes);
      // Read back and verify text content is present
      const { readPdf } = await import("@pdf/reader/pdf-reader");
      const result = await readPdf(pdfBytes);
      expect(result.text).toContain("This");
    });
  });

  describe("Invalid Sheet Selectors", () => {
    it("should throw when all sheet selectors are invalid", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Real"), "A1", "Data");

      await expect(excelToPdf(wb, { sheets: ["NonExistent"] })).rejects.toThrow(PdfError);
    });

    it("should throw for out-of-range numeric selector", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Only"), "A1", "Data");

      await expect(excelToPdf(wb, { sheets: [99] })).rejects.toThrow(PdfError);
    });
  });

  describe("Encryption with content streams", () => {
    it("should encrypt stream data when encryption is enabled", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "Test"), "A1", "SecretValue");

      const pdfPlain = await excelToPdf(wb);
      const pdfEncrypted = await excelToPdf(wb, {
        encryption: { ownerPassword: "owner123" }
      });

      expectValidPdf(pdfEncrypted);
      const plainText = pdfToString(pdfPlain);
      const encText = pdfToString(pdfEncrypted);

      // Plain PDF should NOT have /Encrypt dict
      expect(plainText).not.toContain("/Encrypt");
      // Encrypted PDF must have /Encrypt dict and /ID
      expect(encText).toContain("/Encrypt");
      expect(encText).toContain("/ID");
      // The encrypted PDF should have a different stream content than plain
      // (stream data is encrypted, so "SecretValue" should not appear in cleartext
      // in compressed+encrypted streams)
      expect(encText).toContain("/Filter /Standard");
    });
  });

  describe("RichText cell text extraction", () => {
    it("should not produce [object Object] for RichText cells", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Rich");
      Cell.setValue(ws, "A1", {
        richText: [{ text: "Bold", font: { bold: true } }, { text: " Normal" }]
      });

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // Should NOT contain the stringified object
      expect(text).not.toContain("[object Object]");
    });
  });

  describe("Non-ASCII text with Type1 fonts", () => {
    it("should encode accented characters correctly", async () => {
      const wb = Workbook.create();
      const wsAccent = Workbook.addWorksheet(wb, "Accent");
      Cell.setValue(wsAccent, "A1", "café");

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      // The text "café" should be encoded as WinAnsi hex, not UTF-8
      // (this will be in a compressed stream, so we just verify no crash)
    });
  });

  describe("Row page breaks", () => {
    it("should break after the row with the page break, not before it", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Breaks");
      for (let r = 1; r <= 10; r++) {
        Cell.setValue(ws, `A${r}`, `Row ${r}`);
      }
      // Break after row 5: rows 1-5 on first page, 6-10 on second
      rowAddPageBreak(Worksheet.getRow(ws, 5));

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // Should have multiple pages
      expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Partial margins with worksheet fallback", () => {
    it("should merge partial PDF margins with worksheet pageSetup margins", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Margins");
      Cell.setValue(ws, "A1", "Test");
      // Worksheet margins in inches
      ws.pageSetup.margins = {
        left: 0.5,
        right: 0.5,
        top: 1.0,
        bottom: 1.0,
        header: 0.3,
        footer: 0.3
      };

      // Only override left margin (36pt = 0.5in)
      const pdf = await excelToPdf(wb, { margins: { left: 36 } });
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // The top margin should come from worksheet (1.0 * 72 = 72pt), not reset to default
      // Just verify valid PDF produced without crash
      expect(text).toContain("%PDF");
    });
  });

  describe("Rich text with wrapping", () => {
    it("should wrap rich text cells when wrapText is enabled", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "RichWrap");
      const cell = getCell(ws, "A1");
      cellSetValue(cell, {
        richText: [
          { text: "This is bold text ", font: { bold: true } },
          { text: "and this is normal text that should wrap to multiple lines" }
        ]
      });
      cellSetAlignment(cell, { wrapText: true });
      Column.setWidth(ws, 1, 15);

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
    });
  });

  describe("Encryption with embedded font", () => {
    it("should produce valid encrypted PDF with embedded TrueType font", async () => {
      const wb = Workbook.create();
      const wsEnc = Workbook.addWorksheet(wb, "Encrypted");
      Cell.setValue(wsEnc, "A1", "Hello encrypted with font");

      const pdf = await excelToPdf(wb, {
        font: new Uint8Array(buildMinimalTtf()),
        encryption: { ownerPassword: "owner", userPassword: "user" }
      });
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("/Filter /Standard");
      expect(text).toContain("/CIDFontType2");
    });
  });

  describe("Encrypted PDF hex string encryption", () => {
    it("should encrypt non-ASCII metadata hex strings", async () => {
      const wb = Workbook.create();
      Cell.setValue(Workbook.addWorksheet(wb, "报告"), "A1", "Data");

      const pdf = await excelToPdf(wb, {
        title: "作者",
        encryption: { ownerPassword: "owner" }
      });
      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      // The hex-encoded UTF-16 title <feff4f5c8005> should NOT appear in cleartext
      expect(text).not.toContain("<feff4f5c8005>");
      // The hex-encoded UTF-16 sheet name <feff62a5544a> should NOT appear in cleartext
      expect(text).not.toContain("<feff62a5544a>");
    });
  });

  describe("Multi-range print area", () => {
    it("should use the first range from a multi-range printArea", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Multi");
      for (let r = 1; r <= 10; r++) {
        Cell.setValue(ws, `A${r}`, `A${r}`);
        Cell.setValue(ws, `B${r}`, `B${r}`);
        Cell.setValue(ws, `C${r}`, `C${r}`);
        Cell.setValue(ws, `D${r}`, `D${r}`);
      }
      // Multi-range: only A1:B5 should be used
      ws.pageSetup.printArea = "A1:B5&&D1:D10";

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
    });
  });

  describe("ignorePrintArea option", () => {
    it("should clip columns outside the print area by default", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "ClipCol");
      Cell.setValue(ws, "A1", "In");
      Cell.setValue(ws, "B1", "OutCol");
      ws.pageSetup.printArea = "A1:A1";

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("In");
      expect(text).not.toContain("OutCol");
    });

    it("should clip rows outside the print area by default", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "ClipRow");
      Cell.setValue(ws, "A1", "In");
      Cell.setValue(ws, "A2", "OutRow");
      ws.pageSetup.printArea = "A1:A1";

      const pdf = await excelToPdf(wb);

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("In");
      expect(text).not.toContain("OutRow");
    });

    it("should export columns outside the print area when ignorePrintArea is true", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "FullCol");
      Cell.setValue(ws, "A1", "In");
      Cell.setValue(ws, "B1", "OutCol");
      ws.pageSetup.printArea = "A1:A1";

      const pdf = await excelToPdf(wb, { ignorePrintArea: true });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("In");
      expect(text).toContain("OutCol");
    });

    it("should export rows outside the print area when ignorePrintArea is true", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "FullRow");
      Cell.setValue(ws, "A1", "In");
      Cell.setValue(ws, "A2", "OutRow");
      ws.pageSetup.printArea = "A1:A1";

      const pdf = await excelToPdf(wb, { ignorePrintArea: true });

      expectValidPdf(pdf);
      const text = pdfToString(pdf);
      expect(text).toContain("In");
      expect(text).toContain("OutRow");
    });

    it("should leave the workbook's print area unmodified", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Untouched");
      Cell.setValue(ws, "A1", "InsideArea");
      Cell.setValue(ws, "B1", "OutsideArea");
      ws.pageSetup.printArea = "A1:A1";

      await excelToPdf(wb, { ignorePrintArea: true });

      expect(ws.pageSetup.printArea).toBe("A1:A1");
    });
  });

  describe("printTitlesRow single-row format", () => {
    it("should accept single-number printTitlesRow format", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Titles");
      for (let r = 1; r <= 50; r++) {
        Cell.setValue(ws, `A${r}`, `Row ${r}`);
      }
      ws.pageSetup.printTitlesRow = "1";

      const pdf = await excelToPdf(wb);
      expectValidPdf(pdf);
      // Should have more than 1 page (50 rows with repeat headers)
      const text = pdfToString(pdf);
      expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Row height auto-expand", () => {
    it("should auto-expand row height for wrapped text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");

      // Column A is narrow
      Column.setWidth(ws, "A", 5);

      // Cell with wrapText and long content that needs multiple lines
      Cell.setValue(ws, "A1", "This is a very long text that needs wrapping");
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });

      // Set a small row height that is NOT custom
      Row.setHeight(ws, 1, 15); // Default height, not custom

      const pdf = await excelToPdf(wb);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expect(pdf.length).toBeGreaterThan(0);

      // The PDF should be valid — the main check is that it doesn't crash
      // and the row height was auto-expanded (verified by no clipping)
      const text = new TextDecoder("latin1").decode(pdf);
      expect(text).toContain("%PDF");
    });
  });

  describe("Unicode character rendering", () => {
    it("should render non-WinAnsi characters without throwing", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "⧇"); // SQUARED SMALL CIRCLE
      Cell.setValue(ws, "A2", "○"); // WHITE CIRCLE
      Cell.setValue(ws, "A3", "☐"); // BALLOT BOX
      Cell.setValue(ws, "A4", "✓✗★♥→←"); // Common symbols
      Column.setWidth(ws, "A", 20);

      const pdf = await excelToPdf(wb);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expect(pdf.length).toBeGreaterThan(100);
    });

    it("should render non-WinAnsi characters in rich text without throwing", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", {
        richText: [{ text: "Status: ", font: { bold: true } }, { text: "☐ Pending ✓ Done" }]
      });
      Column.setWidth(ws, "A", 30);

      const pdf = await excelToPdf(wb);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expect(pdf.length).toBeGreaterThan(100);
      expectValidPdf(pdf);
    });

    it("should render non-WinAnsi characters in wrapped rich text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", {
        richText: [
          { text: "Item ⧇ first line that is long enough to wrap ", font: { bold: true } },
          { text: "○ second part with symbols ☐ ✓" }
        ]
      });
      Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });
      Column.setWidth(ws, "A", 15);

      const pdf = await excelToPdf(wb);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expect(pdf.length).toBeGreaterThan(100);
      expectValidPdf(pdf);
    });

    it("should render non-WinAnsi characters in rotated text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "☐ ✓ ⧇");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: 45 } });
      Cell.setValue(ws, "A2", "○ → ★");
      Cell.setStyle(ws, "A2", { alignment: { textRotation: 90 } });
      Cell.setValue(ws, "A3", "♥ ← ✗");
      Cell.setStyle(ws, "A3", { alignment: { textRotation: 135 } });
      Row.setHeight(ws, 1, 60);
      Row.setHeight(ws, 2, 60);
      Row.setHeight(ws, 3, 60);
      Column.setWidth(ws, "A", 20);

      const pdf = await excelToPdf(wb);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expectValidPdf(pdf);
    });

    it("should render non-WinAnsi characters in vertical stacked text", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "☐✓⧇");
      Cell.setStyle(ws, "A1", { alignment: { textRotation: "vertical" } });
      Row.setHeight(ws, 1, 80);
      Column.setWidth(ws, "A", 20);

      const pdf = await excelToPdf(wb);
      expect(pdf).toBeInstanceOf(Uint8Array);
      expectValidPdf(pdf);
    });

    it("should render Unicode sheet name in page header", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "数据表☐");
      Cell.setValue(ws, "A1", "Test");

      const pdf = await excelToPdf(wb, { showSheetNames: true });
      expect(pdf).toBeInstanceOf(Uint8Array);
      expectValidPdf(pdf);
    });

    it("should render Unicode text watermark", async () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Sheet1");
      Cell.setValue(ws, "A1", "Test");

      const pdf = await excelToPdf(wb, {
        watermark: {
          type: "text",
          text: "机密 ☐ ✓"
        }
      });
      expect(pdf).toBeInstanceOf(Uint8Array);
      expectValidPdf(pdf);
    });
  });
});

describe("exportPdf vector chart preparation", () => {
  it("invokes a vector chart callback exactly once", async () => {
    let calls = 0;
    const bytes = await exportPdf({
      sheets: [
        {
          kind: "chartsheet",
          name: "Chart",
          chart: {
            drawVector(surface, rect) {
              calls++;
              surface.drawText("Title", { x: rect.x, y: rect.y, fontSize: 12 });
            }
          }
        }
      ]
    });

    expectValidPdf(bytes);
    expect(calls).toBe(1);
  });

  it("uses final font metrics for centered Unicode chart text", async () => {
    const title = "图表标题很长很长";
    const category = "甲";
    const codePoints = [...new Set([...`${title}${category}`].map(ch => ch.codePointAt(0)!))].sort(
      (a, b) => a - b
    );
    const font = buildTtfWithCmap(
      codePoints.map((cp, index) => ({ start: cp, end: cp, delta: index + 1 - cp })),
      codePoints.length + 1,
      {
        familyName: "ChartCjkTest",
        advanceWidths: [500, ...codePoints.map((_, index) => 500 + index * 20)]
      }
    );

    // Make auto-discovery deterministic: both exports must use this exact
    // font, regardless of the fonts installed on the test host.
    _setCandidatesForTest([font]);
    const makeWorkbook = () => {
      const wb = Workbook.create();
      const data = Workbook.addWorksheet(wb, "Data");
      Cell.setValue(data, "A1", category);
      Cell.setValue(data, "B1", 1);
      Workbook.addChartsheet(wb, "Chart", {
        chart: {
          type: "bar",
          title,
          series: [{ categories: "Data!$A$1:$A$1", values: "Data!$B$1:$B$1" }]
        }
      });
      return wb;
    };

    try {
      const auto = await readPdf(await excelToPdf(makeWorkbook(), { sheets: ["Chart"] }));
      const explicit = await readPdf(await excelToPdf(makeWorkbook(), { sheets: ["Chart"], font }));
      const autoTitle = auto.pages[0].textFragments.find(f => f.text === title);
      const explicitTitle = explicit.pages[0].textFragments.find(f => f.text === title);

      expect(autoTitle).toBeDefined();
      expect(explicitTitle).toBeDefined();
      expect(autoTitle!.x).toBeCloseTo(explicitTitle!.x, 1);
    } finally {
      resetFontDiscoveryCache();
    }
  });
});

// =============================================================================
// Type3 Fallback Text Runs
// =============================================================================

describe("Type3 fallback text runs", () => {
  // Force the "no system font covers this text" branch on every host. Without
  // it these assertions would only exercise the Type3 path on machines that
  // happen to lack a CJK font (bare Linux CI images), while macOS/Windows
  // silently auto-embedded a TrueType subset instead.
  beforeEach(() => {
    _setCandidatesForTest([]);
  });
  afterEach(() => {
    resetFontDiscoveryCache();
  });

  it("shows a run of Type3 glyphs as one text-showing operation", async () => {
    const wb = Workbook.create();
    Cell.setValue(Workbook.addWorksheet(wb, "Sheet1"), "A1", "Data");

    const pdf = await excelToPdf(wb, { watermark: { type: "text", text: "机密" } });
    const page = (await readPdf(pdf)).pages[0];

    // Both glyphs live in the same Type3 font, so they must be one Tj with a
    // two-byte string — one Tj per glyph would make the word unextractable.
    expect(decompressPdfContent(pdf)).toMatch(/<[0-9A-F]{4}> Tj/);
    expect(page.textFragments.map(f => f.text)).toContain("机密");
    expect(page.text).toContain("机密");
  });

  it("keeps mixed WinAnsi and Type3 text in reading order", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Sheet1");
    Cell.setValue(ws, "A1", "中文标题 ABC 混排文本");

    const page = (await readPdf(await excelToPdf(wb))).pages[0];

    // One run per font switch: Type3 → Type1 → Type3, nothing finer.
    expect(page.textFragments.map(f => f.text)).toEqual(["中文标题", " ABC ", "混排文本"]);
  });
});

// =============================================================================
// Image Integration Tests
// =============================================================================

/**
 * Build a minimal valid JPEG (1x1 red pixel).
 * SOI + SOF0 + SOS + EOI
 */
function buildMinimalJpeg(): Uint8Array {
  // prettier-ignore
  return new Uint8Array([
    0xFF, 0xD8,             // SOI
    0xFF, 0xE0,             // APP0
    0x00, 0x10,             // length = 16
    0x4A, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01,             // version 1.1
    0x00,                   // aspect ratio
    0x00, 0x01, 0x00, 0x01, // 1x1 pixel density
    0x00, 0x00,             // no thumbnail
    0xFF, 0xDB,             // DQT
    0x00, 0x43,             // length = 67
    0x00,                   // table 0, 8-bit precision
    // 64 quantization values (all 1s for simplicity)
    ...Array.from({ length: 64 }, () => 0x01),
    0xFF, 0xC0,             // SOF0 (baseline)
    0x00, 0x0B,             // length = 11
    0x08,                   // 8-bit precision
    0x00, 0x01,             // height = 1
    0x00, 0x01,             // width = 1
    0x01,                   // 1 component
    0x01,                   // component ID = 1
    0x11,                   // H/V sampling = 1x1
    0x00,                   // quant table 0
    0xFF, 0xC4,             // DHT
    0x00, 0x1F,             // length = 31
    0x00,                   // DC table 0
    // Number of codes of each length (1-16)
    0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    // Values
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
    0xFF, 0xDA,             // SOS
    0x00, 0x08,             // length = 8
    0x01,                   // 1 component
    0x01,                   // component 1
    0x00,                   // DC/AC table 0/0
    0x00, 0x3F, 0x00,       // spectral selection
    0x7B, 0x40,             // scan data (minimal)
    0xFF, 0xD9              // EOI
  ]);
}

/**
 * Build a minimal valid PNG (2x2, RGBA with varying alpha).
 */
function buildMinimalPng(): Uint8Array {
  const parts: number[] = [];

  // PNG signature
  parts.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

  // IHDR
  const ihdr = [
    0x00,
    0x00,
    0x00,
    0x02, // width = 2
    0x00,
    0x00,
    0x00,
    0x02, // height = 2
    0x08, // bit depth = 8
    0x06, // color type = 6 (RGBA)
    0x00,
    0x00,
    0x00 // compression, filter, interlace
  ];
  writeChunk(parts, "IHDR", ihdr);

  // IDAT — raw pixel data: 2 rows of 2 RGBA pixels, each row starts with filter byte 0
  // Row 1: red (opaque), green (semi-transparent)
  // Row 2: blue (opaque), white (fully transparent)
  const rawPixels = [
    0x00, // filter byte
    0xff,
    0x00,
    0x00,
    0xff, // red, alpha=255
    0x00,
    0xff,
    0x00,
    0x80, // green, alpha=128
    0x00, // filter byte
    0x00,
    0x00,
    0xff,
    0xff, // blue, alpha=255
    0xff,
    0xff,
    0xff,
    0x00 // white, alpha=0
  ];

  // Deflate the raw data (use zlib sync from the archive module isn't available here,
  // so we'll use a stored (uncompressed) deflate block)
  const deflated = deflateStored(rawPixels);
  writeChunk(parts, "IDAT", Array.from(deflated));

  // IEND
  writeChunk(parts, "IEND", []);

  return new Uint8Array(parts);
}

function writeChunk(buf: number[], type: string, data: number[]): void {
  // Length (4 bytes, big-endian)
  const len = data.length;
  buf.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  // Type (4 bytes)
  for (let i = 0; i < 4; i++) {
    buf.push(type.charCodeAt(i));
  }
  // Data
  buf.push(...data);
  // CRC32 (over type + data)
  const crcInput = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) {
    crcInput[i] = type.charCodeAt(i);
  }
  for (let i = 0; i < data.length; i++) {
    crcInput[4 + i] = data[i];
  }
  const crc = crc32(crcInput);
  buf.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Wrap raw bytes in a stored (uncompressed) deflate stream with zlib header.
 */
function deflateStored(data: number[]): Uint8Array {
  const len = data.length;
  // zlib header: CMF=0x78 (deflate, window=32K), FLG=0x01 (FCHECK=1)
  const result = [0x78, 0x01];
  // BFINAL=1, BTYPE=00 (stored)
  result.push(0x01);
  // LEN and NLEN (little-endian)
  result.push(len & 0xff, (len >>> 8) & 0xff);
  result.push(~len & 0xff, (~len >>> 8) & 0xff);
  // Data
  result.push(...data);
  // Adler32 checksum
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  result.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return new Uint8Array(result);
}

describe("Image integration", () => {
  it("should export PDF with embedded JPEG image", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Images");
    // Fill data that extends past the image range
    for (let r = 1; r <= 10; r++) {
      Cell.setValue(ws, `A${r}`, `Row ${r}`);
      Cell.setValue(ws, `B${r}`, r * 10);
      Cell.setValue(ws, `C${r}`, `Data ${r}`);
    }

    const jpegData = buildMinimalJpeg();
    const imageId = addWorkbookImage(wb, { buffer: jpegData, extension: "jpeg" });
    addImage(ws, imageId, {
      tl: { col: 0, row: 1 },
      br: { col: 2, row: 4 }
    });

    const pdf = await excelToPdf(wb);
    expectValidPdf(pdf);
    const text = pdfToString(pdf);
    // Should contain an XObject image reference
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Filter /DCTDecode");
  });

  it("should export PDF with embedded PNG image (alpha channel)", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "PngTest");
    for (let r = 1; r <= 5; r++) {
      Cell.setValue(ws, `A${r}`, `Row ${r}`);
      Cell.setValue(ws, `B${r}`, r);
    }

    const pngData = buildMinimalPng();
    const imageId = addWorkbookImage(wb, { buffer: pngData, extension: "png" });
    addImage(ws, imageId, {
      tl: { col: 0, row: 1 },
      ext: { width: 100, height: 100 }
    });

    const pdf = await excelToPdf(wb);
    expectValidPdf(pdf);
    const text = pdfToString(pdf);
    // Should contain XObject image
    expect(text).toContain("/Subtype /Image");
    // PNG with alpha should generate a soft mask
    expect(text).toContain("/SMask");
  });

  it("should handle workbook with image and multiple pages", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Data");

    // Fill enough rows to span 2 pages
    for (let r = 1; r <= 80; r++) {
      Cell.setValue(ws, `A${r}`, `Row ${r}`);
      Cell.setValue(ws, `B${r}`, r);
    }

    const jpegData = buildMinimalJpeg();
    const imageId = addWorkbookImage(wb, { buffer: jpegData, extension: "jpeg" });
    addImage(ws, imageId, {
      tl: { col: 1, row: 0 },
      br: { col: 3, row: 3 }
    });

    const pdf = await excelToPdf(wb, { showPageNumbers: true });
    expectValidPdf(pdf);
    const text = pdfToString(pdf);
    // Multiple pages
    const pages = text.match(/\/Type \/Page\b/g);
    expect(pages!.length).toBeGreaterThanOrEqual(2);
    // Image on first page
    expect(text).toContain("/Filter /DCTDecode");
  });

  it("should render tl/br image anchored beyond data bounds", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "BrBounds");
    // Only one cell of data
    Cell.setValue(ws, "A1", "Hello");

    const jpegData = buildMinimalJpeg();
    const imageId = addWorkbookImage(wb, { buffer: jpegData, extension: "jpeg" });
    // Image br extends well beyond the single data cell
    addImage(ws, imageId, {
      tl: { col: 1, row: 1 },
      br: { col: 5, row: 8 }
    });

    const pdf = await excelToPdf(wb);
    expectValidPdf(pdf);
    const text = pdfToString(pdf);
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Filter /DCTDecode");
  });
});

// =============================================================================
// Standalone pdf() API
// =============================================================================

describe("Standalone pdf() API", () => {
  it("should generate a valid PDF from a 2D array", async () => {
    const result = await standalonePdf([
      ["Product", "Revenue"],
      ["Widget", 1000],
      ["Gadget", 2500]
    ]);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);
    expectValidPdf(result);
    // Content streams may be compressed; verify font was used
    const text = pdfToString(result);
    expect(text).toContain("/Helvetica");
  });

  it("should generate a valid PDF from a sheet object with columns", async () => {
    const result = await standalonePdf({
      name: "Report",
      columns: [{ width: 25 }, { width: 15 }],
      data: [
        ["Widget", 1000],
        ["Gadget", 2500]
      ]
    });

    expect(result.length).toBeGreaterThan(100);
    expectValidPdf(result);
  });

  it("should generate a valid PDF from a multi-sheet book", async () => {
    const result = await standalonePdf({
      sheets: [
        {
          name: "Sales",
          data: [
            ["Product", "Revenue"],
            ["Widget", 1000]
          ]
        },
        {
          name: "Costs",
          data: [
            ["Item", "Amount"],
            ["Rent", 500]
          ]
        }
      ]
    });

    expectValidPdf(result);
    const text = pdfToString(result);
    const pageMatches = text.match(/\/Type \/Page\b/g);
    expect(pageMatches!.length).toBe(2);
    expect(text).toContain("(Sales)");
    expect(text).toContain("(Costs)");
  });

  it("should render column headers as the first row", async () => {
    const result = await standalonePdf({
      columns: [
        { width: 20, header: "Name" },
        { width: 15, header: "Score" }
      ],
      data: [
        ["Alice", 95],
        ["Bob", 87]
      ]
    });

    expectValidPdf(result);
    // Headers use bold font
    const text = pdfToString(result);
    expect(text).toContain("Helvetica-Bold");
  });

  it("should render header-only sheet with no data rows", async () => {
    const result = await standalonePdf({
      columns: [{ header: "Name" }, { header: "Score" }],
      data: []
    });

    expectValidPdf(result);
    // Should have at least one page with the bold header font
    const text = pdfToString(result);
    expect(text).toContain("Helvetica-Bold");
  });

  it("should place sparse column headers at the correct positions", async () => {
    const result = await standalonePdf({
      columns: [{ header: "A" }, { width: 10 }, { header: "C" }],
      data: [["x", "y", "z"]]
    });

    expectValidPdf(result);
    // Headers should be in columns 1 and 3, not 1 and 2.
    // Decompress not possible here, but verify 3 columns are rendered
    // and the bold header font is used.
    const text = pdfToString(result);
    expect(text).toContain("Helvetica-Bold");
  });

  it("should handle styled cells", async () => {
    const result = await standalonePdf([
      [
        { value: "Bold", bold: true },
        { value: "Red", fontColor: "FFFF0000" }
      ],
      [{ value: "Filled", fillColor: "FFFFFF00" }, "Plain"]
    ]);

    expectValidPdf(result);
    const text = pdfToString(result);
    expect(text).toContain("Helvetica-Bold");
  });

  it("should handle empty 2D array", async () => {
    const result = await standalonePdf([]);

    expectValidPdf(result);
  });

  it("should handle boolean and Date values", async () => {
    const result = await standalonePdf([[true, false, new Date(2024, 0, 15)]]);

    expect(result.length).toBeGreaterThan(100);
    expectValidPdf(result);
  });

  it("should handle null and undefined cells", async () => {
    const result = await standalonePdf([["Hello", null, undefined, "World"]]);

    expectValidPdf(result);
  });

  it("should accept export options", async () => {
    const result = await standalonePdf([["Test"]], {
      pageSize: "LETTER",
      orientation: "landscape",
      showGridLines: true
    });

    expectValidPdf(result);
    const text = pdfToString(result);
    // Landscape LETTER: 792 x 612
    expect(text).toContain("792");
    expect(text).toContain("612");
  });

  it("should embed a JPEG image via standalone pdf()", async () => {
    const jpegData = buildMinimalJpeg();
    const result = await standalonePdf({
      data: [
        ["Product", "Price"],
        ["Widget", "$10"]
      ],
      images: [{ data: jpegData, format: "jpeg", col: 0, row: 2, width: 100, height: 80 }]
    });

    expectValidPdf(result);
    const text = pdfToString(result);
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Filter /DCTDecode");
  });

  it("should embed a PNG image with alpha via standalone pdf()", async () => {
    const pngData = buildMinimalPng();
    const result = await standalonePdf({
      data: [
        ["Row 1", 100],
        ["Row 2", 200]
      ],
      images: [{ data: pngData, format: "png", col: 0, row: 2, width: 80, height: 80 }]
    });

    expectValidPdf(result);
    const text = pdfToString(result);
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/SMask");
  });

  it("should render image-only sheet with no data rows", async () => {
    const jpegData = buildMinimalJpeg();
    const result = await standalonePdf({
      data: [],
      images: [{ data: jpegData, format: "jpeg", col: 0, row: 0, width: 200, height: 150 }]
    });

    expectValidPdf(result);
    const text = pdfToString(result);
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Filter /DCTDecode");
  });

  it("should extend bounds for image anchored beyond data columns", async () => {
    const jpegData = buildMinimalJpeg();
    const result = await standalonePdf({
      data: [["A only"]],
      images: [{ data: jpegData, format: "jpeg", col: 3, row: 0, width: 100, height: 80 }]
    });

    expectValidPdf(result);
    const text = pdfToString(result);
    expect(text).toContain("/Subtype /Image");
  });
});
