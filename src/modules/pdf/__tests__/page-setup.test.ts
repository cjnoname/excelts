/**
 * Excel `pageSetup` print settings → PDF.
 *
 * Every setting is exercised end-to-end through `excelToPdf` (bridge →
 * option resolution → layout → render), because the contract users care about
 * is "what my Page Setup dialog says is what the PDF does".
 */
import {
  cellSetAlignment,
  cellSetBorder,
  cellSetFill,
  cellSetFont,
  cellSetNote
} from "@excel/core/cell";
import { chartsheetPageSetup, chartsheetSetPageSetup } from "@excel/core/chartsheet";
import { addWorkbookImage } from "@excel/core/workbook-core";
import { addColumnChart, addImage, getCell, mergeCells } from "@excel/core/worksheet";
import { Cell, Column, Row, Workbook } from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";
import { extractTextFromPage } from "@pdf/reader/content-interpreter";
import { PdfDocument } from "@pdf/reader/pdf-document";
import { CELL_PADDING_V } from "@pdf/render/constants";
import { getFontAscent, getFontDescent } from "@utils/font-metrics";
import { EMU_PER_INCH } from "@utils/units";
import { describe, expect, it } from "vitest";

import { TINY_PNG, decompressPdfContent, expectAllGray, pdfColorOps } from "./test-helpers";
import { buildTtfWithCmap } from "./ttf-test-utils";

function configuredAsciiFonts() {
  const regular = buildTtfWithCmap([{ start: 0x20, end: 0x7e, delta: 1 - 0x20 }], 96, {
    familyName: "Configured Regular"
  });
  const bold = buildTtfWithCmap([{ start: 0x20, end: 0x7e, delta: 1 - 0x20 }], 96, {
    familyName: "Configured Bold"
  });
  return { default: { regular, bold } };
}

/** Baseline 8x8 JPEG header with three components — enough for DCTDecode wiring. */
const MINIMAL_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x08, 0x03, 0x01, 0x11,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9
]);

/** 1x1 PNG with an alpha channel, fully transparent. */
const TRANSPARENT_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0x60, 0x60,
  0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x87, 0xa1, 0x4b, 0x54, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Text fragments per page, in page order. */
function textPerPage(pdfBytes: Uint8Array): string[][] {
  const doc = new PdfDocument(pdfBytes);
  return doc.getPages().map(p => extractTextFromPage(p, doc).map(f => f.text));
}

function pageCount(pdfBytes: Uint8Array): number {
  return new PdfDocument(pdfBytes).getPages().length;
}

/** Leftmost text x on the first page. */
function leftMostX(pdfBytes: Uint8Array): number {
  const doc = new PdfDocument(pdfBytes);
  const frags = extractTextFromPage(doc.getPages()[0], doc);
  return Math.min(...frags.map(f => f.x));
}

/** A grid of `C<col>R<row>` markers, `cols` wide and `rows` tall. */
function markerSheet(cols: number, rows: number, width = 12) {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Grid");
  for (let c = 1; c <= cols; c++) {
    Column.setWidth(ws, c, width);
    for (let r = 1; r <= rows; r++) {
      Cell.setValue(ws, r, c, `C${c}R${r}`);
    }
  }
  return { wb, ws };
}

// -----------------------------------------------------------------------------
// Page order
// -----------------------------------------------------------------------------

describe("pageSetup.pageOrder", () => {
  // 20 columns overflow the page width and 60 rows overflow its height, so the
  // sheet paginates in both directions and the traversal order is observable.
  const build = () => markerSheet(20, 60);

  it("should default to downThenOver, finishing a column band before moving right", async () => {
    const { wb } = build();
    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));

    expect(pages.length).toBeGreaterThanOrEqual(4);
    // Page 1 starts at the top-left.
    expect(pages[0]).toContain("C1R1");
    // Page 2 continues *down* the same columns, so column 1 is still present
    // and row 1 is gone.
    expect(pages[1].some(t => t.startsWith("C1R"))).toBe(true);
    expect(pages[1]).not.toContain("C1R1");
  });

  it("should walk overThenDown when asked", async () => {
    const { wb } = build();
    const pages = textPerPage(
      await excelToPdf(wb, { fitToPage: false, pageOrder: "overThenDown" })
    );

    expect(pages[0]).toContain("C1R1");
    // Page 2 moves *right*: still row 1, but past the first column band.
    expect(pages[1]).not.toContain("C1R1");
    expect(pages[1].some(t => t.endsWith("R1"))).toBe(true);
  });

  it("should read the order from the worksheet", async () => {
    const { wb, ws } = build();
    ws.pageSetup.pageOrder = "overThenDown";
    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));
    expect(pages[1].some(t => t.endsWith("R1"))).toBe(true);
  });

  it("should keep an image on the page holding its anchor under either order", async () => {
    // Page order changes the array position of every page, and image placement
    // resolves by scanning that array — the anchor must still win.
    const make = () => {
      const { wb, ws } = markerSheet(20, 60);
      const id = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
      addImage(ws, id, { tl: { col: 0, row: 0 }, br: { col: 2, row: 3 } });
      return wb;
    };

    for (const pageOrder of ["downThenOver", "overThenDown"] as const) {
      const doc = new PdfDocument(await excelToPdf(make(), { fitToPage: false, pageOrder }));
      const pages = doc.getPages();
      const withImage = pages.filter(p => {
        const res = doc.derefDict(p.get("Resources"));
        return res ? res.get("XObject") !== undefined : false;
      });
      // Exactly one page carries the image, and it is the one holding A1.
      expect(withImage).toHaveLength(1);
      expect(extractTextFromPage(withImage[0], doc).map(f => f.text)).toContain("C1R1");
    }
  });
});

// -----------------------------------------------------------------------------
// Repeated columns (printTitlesColumn)
// -----------------------------------------------------------------------------

describe("pageSetup.printTitlesColumn", () => {
  it("should repeat the leading columns on every horizontal page", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.printTitlesColumn = "A:B";

    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("C1R1");
      expect(page).toContain("C2R1");
    }
  });

  it("should accept a single repeated column", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.printTitlesColumn = "A";
    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));
    for (const page of pages) {
      expect(page).toContain("C1R1");
    }
    // Column B is not a title, so it must not appear on the last page.
    expect(pages[pages.length - 1]).not.toContain("C2R1");
  });

  it("should repeat a title band that sits inside the printed range", async () => {
    // Excel does not require titles to start at column A. C:D repeats on every
    // page *after* the first, and the first page keeps its natural order.
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.printTitlesColumn = "C:D";
    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("C3R1");
      expect(page).toContain("C4R1");
    }
    // First page is not reshuffled: A and B still precede the title band.
    expect(pages[0]).toContain("C1R1");
    expect(pages[0]).toContain("C2R1");
    // Later pages carry the titles but not the untitled leading columns.
    expect(pages[1]).not.toContain("C1R1");
  });

  it("should repeat title columns that sit outside the print area", async () => {
    // Excel's "Columns to repeat at left" is independent of the print area:
    // printing E:T must still show A:B down the left of every page.
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.printArea = "E1:T3";
    ws.pageSetup.printTitlesColumn = "A:B";

    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("C1R1");
      expect(page).toContain("C2R1");
    }
    // Columns C and D are neither titles nor inside the print area.
    expect(pages.flat()).not.toContain("C3R1");
    expect(pages.flat()).not.toContain("C4R1");
  });

  it("should repeat title rows that sit outside the print area", async () => {
    const { wb, ws } = markerSheet(2, 200);
    ws.pageSetup.printArea = "A50:B200";
    ws.pageSetup.printTitlesRow = "1:2";

    const pages = textPerPage(await excelToPdf(wb));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("C1R1");
      expect(page).toContain("C1R2");
    }
    // Row 3 is outside both the titles and the print area.
    expect(pages.flat()).not.toContain("C1R3");
  });

  it("should not emit a page holding only the repeated columns", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.printTitlesColumn = "A:B";
    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));
    for (const page of pages) {
      // Every page must carry at least one non-title column.
      expect(page.some(t => !t.startsWith("C1R") && !t.startsWith("C2R"))).toBe(true);
    }
  });

  it("should honor an explicit repeatCols option over the worksheet", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.printTitlesColumn = "A:B";
    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false, repeatCols: false }));
    expect(pages[pages.length - 1]).not.toContain("C1R1");
  });

  it("should repeat a row title band that does not start at row 1", async () => {
    // "3:5" means rows 3-5, not "the first five rows".
    const { wb, ws } = markerSheet(2, 120);
    ws.pageSetup.printTitlesRow = "3:5";
    const pages = textPerPage(await excelToPdf(wb));

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("C1R3");
      expect(page).toContain("C1R5");
    }
    // Rows 1-2 are not titles, so they only appear on the first page.
    expect(pages[0]).toContain("C1R1");
    expect(pages[1]).not.toContain("C1R1");
  });

  it("should combine title bands with hidden tracks and manual breaks", async () => {
    const { wb, ws } = markerSheet(12, 40);
    Column.setHidden(ws, 3, true); // hide C, inside the title band
    ws.pageSetup.printTitlesColumn = "B:D";
    ws.pageSetup.printTitlesRow = "2:3";
    Row.addPageBreak(ws, 10);

    const pages = textPerPage(await excelToPdf(wb, { fitToPage: false }));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      // Visible members of the bands repeat; the hidden one never appears.
      expect(page).toContain("C2R2");
      expect(page).toContain("C4R2");
      expect(page.some(t => t.startsWith("C3R"))).toBe(false);
    }
  });

  it("should let an explicit repeatRows: false suppress printTitlesRow", async () => {
    const { wb, ws } = markerSheet(2, 120);
    ws.pageSetup.printTitlesRow = "1";

    const repeated = textPerPage(await excelToPdf(wb));
    expect(repeated.length).toBeGreaterThan(1);
    expect(repeated[1]).toContain("C1R1"); // title row repeated

    const suppressed = textPerPage(await excelToPdf(wb, { repeatRows: false }));
    expect(suppressed[1]).not.toContain("C1R1");
  });
});

// -----------------------------------------------------------------------------
// Scaling
// -----------------------------------------------------------------------------

describe("pageSetup scaling", () => {
  it("should honor the sheet's scale percentage (was silently dropped)", async () => {
    const { wb, ws } = markerSheet(20, 3);
    const full = pageCount(await excelToPdf(wb, { fitToPage: false }));
    expect(full).toBeGreaterThan(1);

    ws.pageSetup.fitToPage = false;
    ws.pageSetup.scale = 40;
    // 40% shrinks the grid enough to need fewer horizontal pages.
    expect(pageCount(await excelToPdf(wb))).toBeLessThan(full);
  });

  it("should let an explicit scale option override the sheet", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.fitToPage = false;
    ws.pageSetup.scale = 40;
    const scaled = pageCount(await excelToPdf(wb));
    const overridden = pageCount(await excelToPdf(wb, { scale: 1, fitToPage: false }));
    expect(overridden).toBeGreaterThan(scaled);
  });

  it("should shrink to fitToWidth pages", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.fitToHeight = 0;
    expect(pageCount(await excelToPdf(wb))).toBe(1);
  });

  it("should shrink to fitToHeight pages", async () => {
    const { wb, ws } = markerSheet(2, 200);
    const tall = pageCount(await excelToPdf(wb));
    expect(tall).toBeGreaterThan(1);

    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 0;
    ws.pageSetup.fitToHeight = 1;
    expect(pageCount(await excelToPdf(wb))).toBe(1);
  });

  it("should never enlarge content that already fits, like Excel", async () => {
    const { wb, ws } = markerSheet(2, 3);
    const plain = leftMostX(await excelToPdf(wb));
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.fitToHeight = 1;
    // Same origin and same page count — no upscaling.
    expect(leftMostX(await excelToPdf(wb))).toBeCloseTo(plain, 5);
    expect(pageCount(await excelToPdf(wb))).toBe(1);
  });

  it("should ignore the sheet scale while in fit-to-page mode, as Excel does", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.scale = 10; // Excel greys this out when "Fit to" is selected.
    expect(pageCount(await excelToPdf(wb))).toBe(1);
  });

  it("should accept fitToWidth / fitToHeight as explicit options", async () => {
    const { wb } = markerSheet(20, 3);
    expect(pageCount(await excelToPdf(wb, { fitToPage: false }))).toBeGreaterThan(1);
    expect(pageCount(await excelToPdf(wb, { fitToWidth: 1 }))).toBe(1);

    const { wb: tall } = markerSheet(2, 200);
    expect(pageCount(await excelToPdf(tall))).toBeGreaterThan(1);
    expect(pageCount(await excelToPdf(tall, { fitToHeight: 1 }))).toBe(1);
  });

  it("should keep fitToPage to one page when scale enlarges", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    // ~300pt unscaled against a 451pt content area: fits at 1.0, overflows at 2.0.
    for (let c = 1; c <= 5; c++) {
      Column.setWidth(ws, c, 10);
      Cell.setValue(ws, 1, c, `C${c}`);
    }
    expect(pageCount(await excelToPdf(wb))).toBe(1);
    // fitToPage means "shrink to one page wide"; `scale` must not break it.
    expect(pageCount(await excelToPdf(wb, { scale: 2 }))).toBe(1);
  });

  it("should not shrink twice when scale already reduces under fitToPage", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    for (let c = 1; c <= 30; c++) {
      Column.setWidth(ws, c, 12);
      Cell.setValue(ws, 1, c, `C${c}`);
    }
    const rightEdge = (b: Uint8Array) => {
      const doc = new PdfDocument(b);
      const frags = extractTextFromPage(doc.getPages()[0], doc);
      return Math.max(...frags.map(f => f.x + f.width));
    };
    // Both land on one page, so both should fill it to the same extent —
    // `scale: 0.8` used to compound with the fit ratio and under-fill.
    expect(rightEdge(await excelToPdf(wb, { scale: 0.8 }))).toBeCloseTo(
      rightEdge(await excelToPdf(wb)),
      0
    );
  });

  it("should apply explicit scale before solving fit-to-N constraints", async () => {
    const { wb } = markerSheet(20, 3);
    // The fit solver returns a multiplier on top of `scale`. Treating its
    // candidate as the final scale makes this combination spill back to 2 pages.
    expect(pageCount(await excelToPdf(wb, { scale: 2, fitToWidth: 1 }))).toBe(1);

    const { wb: tall } = markerSheet(2, 200);
    expect(pageCount(await excelToPdf(tall, { scale: 2, fitToHeight: 1 }))).toBe(1);
  });

  it("should let an explicit fitToWidth override the sheet's fit constraint", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    // 0 removes the constraint, falling back to actual size across many pages.
    expect(pageCount(await excelToPdf(wb, { fitToWidth: 0 }))).toBeGreaterThan(1);
  });

  it("should guarantee the page count for indivisible wide columns", async () => {
    // Three columns at ~60% of the content width occupy "1.8 pages" by area but
    // pack into three. A total-size ratio would not shrink at all.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Wide");
    for (let c = 1; c <= 3; c++) {
      Column.setWidth(ws, c, 48);
      Cell.setValue(ws, 1, c, `C${c}`);
    }
    expect(pageCount(await excelToPdf(wb, { fitToPage: false }))).toBe(3);
    expect(pageCount(await excelToPdf(wb, { fitToWidth: 2 }))).toBeLessThanOrEqual(2);
    expect(pageCount(await excelToPdf(wb, { fitToWidth: 1 }))).toBe(1);
  });

  it("should count the repeated title column against the fit target", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Titles");
    Column.setWidth(ws, 1, 40);
    for (let c = 2; c <= 9; c++) {
      Column.setWidth(ws, c, 20);
    }
    for (let c = 1; c <= 9; c++) {
      Cell.setValue(ws, 1, c, `C${c}`);
    }
    ws.pageSetup.printTitlesColumn = "A";
    expect(pageCount(await excelToPdf(wb, { fitToWidth: 2 }))).toBeLessThanOrEqual(2);
  });

  it("should let an explicit fitToPage: false beat the sheet's fit-to mode", async () => {
    const { wb, ws } = markerSheet(20, 3);
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    expect(pageCount(await excelToPdf(wb))).toBe(1);
    // "Do not auto-scale" must win over the workbook it is meant to override.
    expect(pageCount(await excelToPdf(wb, { fitToPage: false }))).toBeGreaterThan(1);
  });

  it("should apply the sheet's 400% scale without clamping to 300%", async () => {
    const build = (pct: number) => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      Cell.setValue(ws, "A1", "M");
      ws.pageSetup.fitToPage = false;
      ws.pageSetup.scale = pct;
      return wb;
    };
    const sizeAt = async (pct: number) => {
      const doc = new PdfDocument(await excelToPdf(build(pct)));
      return extractTextFromPage(doc.getPages()[0], doc)[0].fontSize;
    };
    expect(await sizeAt(400)).toBeGreaterThan(await sizeAt(300));
  });

  it("should fit wrapped text to fitToHeight exactly", async () => {
    // Wrapped rows used to be approximate: `countWrapLines` scaled the column
    // width but not the padding, so shrinking appeared to add wrapped lines and
    // the linear probe under-shrank.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "W");
    Column.setWidth(ws, 1, 18);
    const long = "The quick brown fox jumps over the lazy dog and keeps running far away";
    for (let r = 1; r <= 60; r++) {
      Cell.setValue(ws, r, 1, `${r} ${long}`);
      cellSetAlignment(getCell(ws, `A${r}`), { wrapText: true });
    }

    expect(pageCount(await excelToPdf(wb))).toBeGreaterThan(1);
    expect(pageCount(await excelToPdf(wb, { fitToHeight: 1 }))).toBe(1);
  });

  it("should stop at the 10% floor instead of shrinking without limit", async () => {
    // Manual breaks force three pages no matter the scale, so `fitToWidth: 1`
    // is unreachable. The grid must stay legible rather than collapse.
    const { wb, ws } = markerSheet(9, 3);
    ws.colBreaks = [
      { id: 3, max: 1048575, man: 1 },
      { id: 6, max: 1048575, man: 1 }
    ] as never;
    ws.pageSetup.printArea = "A1:I3";

    const pdf = await excelToPdf(wb, { fitToWidth: 1 });
    const doc = new PdfDocument(pdf);
    // The target cannot be met; more than one page is correct.
    expect(doc.getPages().length).toBeGreaterThan(1);
    // Font size proves we did not scale below Excel's 10% floor.
    const size = extractTextFromPage(doc.getPages()[0], doc)[0].fontSize;
    expect(size).toBeGreaterThanOrEqual(11 * 0.1 - 0.01);
  });

  it("should treat fitToWidth: 2 as at most two pages wide", async () => {
    const { wb } = markerSheet(40, 3);
    expect(pageCount(await excelToPdf(wb, { fitToWidth: 2 }))).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// Black and white
// -----------------------------------------------------------------------------

describe("pageSetup.blackAndWhite", () => {
  function coloredSheet() {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Colors");
    const cell = getCell(ws, "A1");
    Cell.setValue(ws, "A1", "Red text");
    cellSetFont(cell, { color: { argb: "FFFF0000" } });
    cellSetFill(cell, { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } });
    return { wb, ws };
  }

  it("should emit saturated colors by default", async () => {
    const { wb } = coloredSheet();
    const colors = pdfColorOps(await excelToPdf(wb));
    expect(colors.some(([r, g, b]) => r !== g || g !== b)).toBe(true);
  });

  it("should grayscale every fill and text color", async () => {
    const { wb } = coloredSheet();
    expectAllGray(pdfColorOps(await excelToPdf(wb, { blackAndWhite: true })));
  });

  it("should read the flag from the worksheet", async () => {
    const { wb, ws } = coloredSheet();
    ws.pageSetup.blackAndWhite = true;
    expectAllGray(pdfColorOps(await excelToPdf(wb)));
  });

  it("should preserve relative lightness rather than flattening to black", async () => {
    const { wb } = coloredSheet();
    const colors = pdfColorOps(await excelToPdf(wb, { blackAndWhite: true }));
    // The green fill is light, the red text dark — both must survive as
    // distinguishable grays.
    const grays = colors.map(([r]) => r);
    expect(Math.max(...grays) - Math.min(...grays)).toBeGreaterThan(0.1);
  });

  it("should grayscale chart colors, which bypass the cell style pipeline", async () => {
    const build = () => {
      const wb = Workbook.create();
      const data = Workbook.addWorksheet(wb, "Data");
      Cell.setValue(data, "A1", "cat");
      Cell.setValue(data, "B1", 5);
      Workbook.addChartsheet(wb, "Chart", {
        chart: {
          type: "bar",
          series: [{ categories: "Data!$A$1:$A$1", values: "Data!$B$1:$B$1" }]
        }
      });
      return wb;
    };

    const plain = pdfColorOps(await excelToPdf(build(), { sheets: ["Chart"] }));
    expect(plain.some(([r, g, b]) => Math.abs(r - g) > 0.01 || Math.abs(g - b) > 0.01)).toBe(true);

    expectAllGray(
      pdfColorOps(await excelToPdf(build(), { sheets: ["Chart"], blackAndWhite: true }))
    );
  });

  it("should grayscale header/footer run colors", async () => {
    const build = () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "HF");
      Cell.setValue(ws, "A1", "x");
      ws.headerFooter.oddHeader = "&L&KFF0000Red header";
      return wb;
    };

    const plain = pdfColorOps(await excelToPdf(build()));
    expect(plain.some(([r, g, b]) => Math.abs(r - g) > 0.01 || Math.abs(g - b) > 0.01)).toBe(true);

    expectAllGray(pdfColorOps(await excelToPdf(build(), { blackAndWhite: true })));
  });

  it("should grayscale text watermarks", async () => {
    const build = () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "WM");
      Cell.setValue(ws, "A1", "x");
      return wb;
    };
    const watermark = {
      type: "text" as const,
      text: "DRAFT",
      color: { r: 1, g: 0, b: 0 }
    };

    const plain = pdfColorOps(await excelToPdf(build(), { watermark }));
    expect(plain.some(([r, g, b]) => Math.abs(r - g) > 0.01 || Math.abs(g - b) > 0.01)).toBe(true);

    expectAllGray(pdfColorOps(await excelToPdf(build(), { watermark, blackAndWhite: true })));
  });

  it("should convert PNG pixels to grayscale, not overlay them", async () => {
    const build = () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Pic");
      Cell.setValue(ws, "A1", "x");
      const id = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
      addImage(ws, id, { tl: { col: 1, row: 1 }, br: { col: 3, row: 5 } });
      return wb;
    };

    const color = Buffer.from(await excelToPdf(build())).toString("latin1");
    expect(color).toContain("/DeviceRGB");

    // PNG is decoded here anyway, so this is a real pixel conversion: three RGB
    // components collapse into one luma component.
    const bw = Buffer.from(await excelToPdf(build(), { blackAndWhite: true })).toString("latin1");
    expect(bw).toContain("/ColorSpace /DeviceGray");
    // Emphatically *not* the blend-overlay shortcut, which blackens transparency.
    expect(bw).not.toContain("/Saturation");
  });

  it("should keep a transparent PNG transparent when grayscaling", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Alpha");
    Cell.setValue(ws, "A1", "x");
    const id = addWorkbookImage(wb, { buffer: TRANSPARENT_PNG, extension: "png" });
    addImage(ws, id, { tl: { col: 1, row: 1 }, br: { col: 3, row: 5 } });

    const bw = await excelToPdf(wb, { blackAndWhite: true });
    const raw = Buffer.from(bw).toString("latin1");
    // Alpha lives in a separate SMask, so converting the color samples cannot
    // touch it. No opaque black rectangle may be painted over the image either.
    expect(raw).toContain("/SMask");
    expect(raw).not.toContain("/Saturation");
    expect(decompressPdfContent(bw)).not.toMatch(/0 0 0 rg\s+[\d.]+ [\d.]+ [\d.]+ [\d.]+ re\s+f/);
  });

  it("should grayscale a JPEG through a DeviceN luma space", async () => {
    const build = () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "Jpg");
      Cell.setValue(ws, "A1", "x");
      const id = addWorkbookImage(wb, { buffer: MINIMAL_JPEG, extension: "jpeg" });
      addImage(ws, id, { tl: { col: 1, row: 1 }, br: { col: 3, row: 5 } });
      return wb;
    };

    expect(Buffer.from(await excelToPdf(build())).toString("latin1")).toContain("/DeviceRGB");

    // No JPEG decoder is needed: the DCTDecode samples are kept and reinterpreted
    // through a tint transform, so this is a per-pixel conversion rather than a
    // paint on top.
    const bw = Buffer.from(await excelToPdf(build(), { blackAndWhite: true })).toString("latin1");
    expect(bw).toContain("/DeviceN");
    expect(bw).toContain("/FunctionType 4");
    expect(bw).toContain("/DCTDecode");
    expect(bw).toContain("0.114 mul exch 0.587 mul add exch 0.299 mul add");
  });

  it("should cache color and grayscale variants of one image separately", async () => {
    // The XObject cache is keyed by payload; without a second key the two modes
    // would share an object and one of them would be wrong.
    const wb = Workbook.create();
    const a = Workbook.addWorksheet(wb, "A");
    Cell.setValue(a, "A1", "x");
    const id = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addImage(a, id, { tl: { col: 1, row: 1 }, br: { col: 3, row: 5 } });

    const bw = Buffer.from(await excelToPdf(wb, { blackAndWhite: true })).toString("latin1");
    expect(bw).toContain("/ColorSpace /DeviceGray");
    expect(bw).not.toContain("/ColorSpace /DeviceRGB");
  });

  it("should keep chart transparency when grayscaling", async () => {
    // toGrayscale must carry `a` through, or translucent chart fills turn opaque.
    const wb = Workbook.create();
    const data = Workbook.addWorksheet(wb, "Data");
    Cell.setValue(data, "A1", "cat");
    Cell.setValue(data, "B1", 5);
    Workbook.addChartsheet(wb, "Chart", {
      chart: {
        type: "bar",
        series: [{ categories: "Data!$A$1:$A$1", values: "Data!$B$1:$B$1" }]
      }
    });

    const opaque = await excelToPdf(wb, { sheets: ["Chart"] });
    const gray = await excelToPdf(wb, { sheets: ["Chart"], blackAndWhite: true });
    // The set of registered alpha ExtGStates must be unchanged by grayscaling.
    const alphas = (b: Uint8Array) =>
      [
        ...Buffer.from(b)
          .toString("latin1")
          .matchAll(/\/GS[\w.]+/g)
      ]
        .map(m => m[0])
        .sort();
    expect(alphas(gray)).toEqual(alphas(opaque));
  });
});

// -----------------------------------------------------------------------------
// Draft quality
// -----------------------------------------------------------------------------

describe("pageSetup.draft", () => {
  function sheetWithImage() {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Pics");
    Cell.setValue(ws, "A1", "content");
    const id = addWorkbookImage(wb, { buffer: TINY_PNG, extension: "png" });
    addImage(ws, id, { tl: { col: 1, row: 1 }, br: { col: 3, row: 5 } });
    return { wb, ws };
  }

  it("should embed images normally", async () => {
    const { wb } = sheetWithImage();
    const text = Buffer.from(await excelToPdf(wb)).toString("latin1");
    expect(text).toContain("/Image");
  });

  it("should omit images in draft quality", async () => {
    const { wb } = sheetWithImage();
    const text = Buffer.from(await excelToPdf(wb, { draft: true })).toString("latin1");
    expect(text).not.toContain("/Image");
  });

  it("should read the flag from the worksheet and still print cells", async () => {
    const { wb, ws } = sheetWithImage();
    ws.pageSetup.draft = true;
    const pdf = await excelToPdf(wb);
    expect(Buffer.from(pdf).toString("latin1")).not.toContain("/Image");
    expect(textPerPage(pdf)[0].join("")).toContain("content");
  });

  // Note: the "draft must not rasterize" path is enforced in `convertChartsheet`
  // / `convertSheet` before any chart work happens, but it cannot be asserted
  // through the public API — every ChartEx layoutId is in the vector whitelist,
  // so `renderChartExPng` is unreachable for a workbook built in-process.
  it("should read draft from a chartsheet's own print options", async () => {
    const build = (draft: boolean) => {
      const wb = Workbook.create();
      const data = Workbook.addWorksheet(wb, "Data");
      Cell.setValue(data, "A1", "cat");
      Cell.setValue(data, "B1", 5);
      const cs = Workbook.addChartsheet(wb, "Chart", {
        chart: {
          type: "bar",
          series: [{ categories: "Data!$A$1:$A$1", values: "Data!$B$1:$B$1" }]
        }
      });
      if (draft) {
        chartsheetSetPageSetup(cs, { ...(chartsheetPageSetup(cs) ?? {}), draft: true });
      }
      return wb;
    };
    const plain = await excelToPdf(build(false), { sheets: ["Chart"] });
    const drafted = await excelToPdf(build(true), { sheets: ["Chart"] });
    expect(decompressPdfContent(drafted).length).toBeLessThan(
      decompressPdfContent(plain).length / 2
    );
  });

  it("should omit a chartsheet's chart but still emit its page", async () => {
    const build = () => {
      const wb = Workbook.create();
      const data = Workbook.addWorksheet(wb, "Data");
      Cell.setValue(data, "A1", "cat");
      Cell.setValue(data, "B1", 5);
      Workbook.addChartsheet(wb, "Chart", {
        chart: {
          type: "bar",
          series: [{ categories: "Data!$A$1:$A$1", values: "Data!$B$1:$B$1" }]
        }
      });
      return wb;
    };

    const plain = await excelToPdf(build(), { sheets: ["Chart"] });
    const draft = await excelToPdf(build(), { sheets: ["Chart"], draft: true });

    // The page survives — Excel keeps it in the page count too — but the chart
    // vectors are gone, so the content stream shrinks dramatically.
    expect(pageCount(draft)).toBe(pageCount(plain));
    expect(decompressPdfContent(draft).length).toBeLessThan(decompressPdfContent(plain).length / 2);
  });
});

// -----------------------------------------------------------------------------
// Cell errors
// -----------------------------------------------------------------------------

describe("pageSetup.errors", () => {
  function errorSheet() {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Errors");
    Cell.setValue(ws, "A1", { error: "#DIV/0!" });
    Cell.setValue(ws, "A2", "keep me");
    return { wb, ws };
  }

  it("should print the error text by default", async () => {
    const { wb } = errorSheet();
    expect(textPerPage(await excelToPdf(wb))[0].join("")).toContain("#DIV/0!");
  });

  it("should blank error cells", async () => {
    const { wb } = errorSheet();
    const page = textPerPage(await excelToPdf(wb, { errors: "blank" }))[0].join("");
    expect(page).not.toContain("#DIV/0!");
    expect(page).toContain("keep me");
  });

  it("should dash error cells", async () => {
    const { wb } = errorSheet();
    const page = textPerPage(await excelToPdf(wb, { errors: "dash" }))[0].join("");
    expect(page).not.toContain("#DIV/0!");
    expect(page).toContain("--");
  });

  it("should print #N/A for error cells", async () => {
    const { wb } = errorSheet();
    const page = textPerPage(await excelToPdf(wb, { errors: "NA" }))[0].join("");
    expect(page).toContain("#N/A");
  });

  it("should read the mode from the worksheet", async () => {
    const { wb, ws } = errorSheet();
    ws.pageSetup.errors = "dash";
    const page = textPerPage(await excelToPdf(wb))[0].join("");
    expect(page).not.toContain("#DIV/0!");
    expect(page).toContain("--");
  });
});

// -----------------------------------------------------------------------------
// Row and column headings
// -----------------------------------------------------------------------------

describe("pageSetup.showRowColHeaders", () => {
  function plainSheet() {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "Head");
    Cell.setValue(ws, "A1", "zzz");
    Cell.setValue(ws, "B1", "yyy");
    Cell.setValue(ws, "A2", "xxx");
    return { wb, ws };
  }

  it("should not print headings by default", async () => {
    const { wb } = plainSheet();
    const page = textPerPage(await excelToPdf(wb))[0];
    expect(page).not.toContain("A");
    expect(page).not.toContain("B");
  });

  it("should print column letters and row numbers", async () => {
    const { wb } = plainSheet();
    const page = textPerPage(await excelToPdf(wb, { showRowColHeaders: true }))[0];
    expect(page).toContain("A");
    expect(page).toContain("B");
    expect(page).toContain("1");
    expect(page).toContain("2");
  });

  it("should reserve heading labels during layout with configured fonts", async () => {
    const { wb } = plainSheet();
    const page = textPerPage(
      await excelToPdf(wb, { showRowColHeaders: true, fonts: configuredAsciiFonts() })
    )[0];
    expect(page).toContain("A");
    expect(page).toContain("2");
  });

  it("should shift the grid right to make room for the row gutter", async () => {
    const { wb } = plainSheet();
    const plain = leftMostX(await excelToPdf(wb));
    const withHeadings = leftMostX(await excelToPdf(wb, { showRowColHeaders: true }));
    // The gutter itself now owns the leftmost text, so the *cell* text moved
    // right: compare the x of a known cell value instead.
    const doc = new PdfDocument(await excelToPdf(wb, { showRowColHeaders: true }));
    const frags = extractTextFromPage(doc.getPages()[0], doc);
    const cellX = frags.find(f => f.text.includes("zzz"))!.x;
    expect(cellX).toBeGreaterThan(plain);
    expect(withHeadings).toBeLessThanOrEqual(cellX);
  });

  it("should read the flag from the worksheet", async () => {
    const { wb, ws } = plainSheet();
    ws.pageSetup.showRowColHeaders = true;
    expect(textPerPage(await excelToPdf(wb))[0]).toContain("A");
  });

  it("should keep headings legible when the grid is shrunk to fit", async () => {
    const { wb } = markerSheet(20, 3);
    const doc = new PdfDocument(await excelToPdf(wb, { showRowColHeaders: true }));
    const frags = extractTextFromPage(doc.getPages()[0], doc);
    const heading = frags.find(f => f.text === "A");
    const cell = frags.find(f => f.text === "C1R1");
    expect(heading).toBeDefined();
    expect(cell).toBeDefined();
    // Headings keep their fixed size while cell text scales down.
    expect(heading!.fontSize).toBeGreaterThan(cell!.fontSize);
  });

  it("should centre a heading label's ink in its band", async () => {
    const { wb } = plainSheet();
    const pdfBytes = await excelToPdf(wb, { showRowColHeaders: true });
    // The column band is the first rectangle the heading painter fills.
    const band = decompressPdfContent(pdfBytes).match(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+f/);
    expect(band).not.toBeNull();
    const bandBottom = Number(band![2]);
    const bandHeight = Number(band![4]);

    const doc = new PdfDocument(pdfBytes);
    const label = extractTextFromPage(doc.getPages()[0], doc).find(f => f.text === "A");
    expect(label).toBeDefined();

    const ascent = getFontAscent(label!.fontName, label!.fontSize);
    const descent = getFontDescent(label!.fontName, label!.fontSize);
    // Centred on the ink. Centring on the em square and guessing the descender
    // at 0.2 em instead leaves the label sitting low in the band.
    expect(label!.y + (ascent + descent) / 2).toBeCloseTo(bandBottom + bandHeight / 2, 1);
  });

  it("should label the correct columns on later horizontal pages", async () => {
    const { wb } = markerSheet(20, 3);
    const pages = textPerPage(
      await excelToPdf(wb, { fitToPage: false, showRowColHeaders: true, pageOrder: "overThenDown" })
    );
    expect(pages[0]).toContain("A");
    // The second horizontal page starts past column A.
    expect(pages[1]).not.toContain("A");
  });
});

// -----------------------------------------------------------------------------
// Anchored object geometry
// -----------------------------------------------------------------------------

describe("EMU anchor extents", () => {
  it("should size an EMU chart extent in points, not pixels", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", "cat");
    Cell.setValue(ws, "B1", 5);
    addColumnChart(
      ws,
      { series: [{ categories: "S!$A$1:$A$1", values: "S!$B$1:$B$1" }] },
      { tl: "D2", ext: { cx: 4 * EMU_PER_INCH, cy: 2 * EMU_PER_INCH } }
    );

    // A 4in x 2in chart is 288pt x 144pt. The px factor (/9525) yielded
    // 384 x 192 — 4/3 too large.
    const content = decompressPdfContent(await excelToPdf(wb, { fitToPage: false }));
    const widths = [...content.matchAll(/([\d.]+)\s+([\d.]+)\s+re\b/g)].map(m => parseFloat(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    const maxRect = Math.max(...widths);
    expect(maxRect).toBeLessThan(300);
    expect(maxRect).toBeGreaterThan(280);
  });
});

// -----------------------------------------------------------------------------
// Merged cells vs. the repeated title band
// -----------------------------------------------------------------------------

describe("merged cells with print titles", () => {
  /** 8 header cells wide, uniform columns. */
  function gridSheet(cols = 8) {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    for (let c = 1; c <= cols; c++) {
      Column.setWidth(ws, c, 10);
      Cell.setValue(ws, 1, c, `H${c}`);
    }
    return { wb, ws };
  }

  function fragmentsOf(pdfBytes: Uint8Array) {
    const doc = new PdfDocument(pdfBytes);
    return doc
      .getPages()
      .map(p => extractTextFromPage(p, doc).map(f => ({ text: f.text, x: f.x })));
  }

  it("should span a merge over columns the print area excludes", async () => {
    // Injecting title columns makes the visible column list non-contiguous
    // ([A, B, E, F, G]). The merge must still start at B and cover only the
    // columns that are actually printed.
    const { wb, ws } = gridSheet();
    Cell.setValue(ws, 2, 2, "MERGED");
    mergeCells(ws, "B2:F2");
    ws.pageSetup.printArea = "E1:G3";
    ws.pageSetup.printTitlesColumn = "A:B";

    const page = fragmentsOf(await excelToPdf(wb, { fitToPage: false }))[0];
    const merged = page.find(f => f.text === "MERGED");
    const colB = page.find(f => f.text === "H2");
    expect(merged).toBeDefined();
    expect(colB).toBeDefined();
    expect(merged!.x).toBeCloseTo(colB!.x, 0);
  });

  it("should omit a merge whose master lies outside the print area", async () => {
    // Excel stores the value on the master only, so a master outside the
    // printed range prints nothing — the follower cells are genuinely empty.
    const { wb, ws } = gridSheet();
    Cell.setValue(ws, 2, 3, "MERGED");
    mergeCells(ws, "C2:F2");
    ws.pageSetup.printArea = "E1:G3";
    ws.pageSetup.printTitlesColumn = "A:B";

    const page = fragmentsOf(await excelToPdf(wb, { fitToPage: false }))[0];
    expect(page.map(f => f.text)).not.toContain("MERGED");
  });

  it("should grayscale a border propagated from a merge boundary", async () => {
    // `propagateMergeBorders` re-converts the boundary cell's border straight
    // from the Excel style, bypassing the cell-level conversion.
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "M");
    Cell.setValue(ws, "A1", "merged");
    cellSetBorder(getCell(ws, "B1"), {
      right: { style: "thick", color: { argb: "FF0000FF" } }
    });
    mergeCells(ws, "A1:B1");

    expectAllGray(pdfColorOps(await excelToPdf(wb, { blackAndWhite: true })));
  });

  it("should repeat a merge that lives inside the title band", async () => {
    const { wb, ws } = gridSheet(20);
    Cell.setValue(ws, 2, 1, "TITLE-MERGE");
    mergeCells(ws, "A2:B2");
    ws.pageSetup.printTitlesColumn = "A:B";

    const pages = fragmentsOf(await excelToPdf(wb, { fitToPage: false }));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.map(f => f.text)).toContain("TITLE-MERGE");
    }
  });
});

// -----------------------------------------------------------------------------
// Cell comments
// -----------------------------------------------------------------------------

describe("pageSetup.cellComments", () => {
  function commentSheet() {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", "body");
    cellSetNote(getCell(ws, "B7"), "Check this number");
    cellSetNote(getCell(ws, "C9"), "Second remark");
    return { wb, ws };
  }

  function pageTexts(pdfBytes: Uint8Array): string[] {
    const doc = new PdfDocument(pdfBytes);
    return doc.getPages().map(p =>
      extractTextFromPage(p, doc)
        .map(f => f.text)
        .join(" ")
    );
  }

  it("should not print comments by default", async () => {
    const { wb } = commentSheet();
    const pages = pageTexts(await excelToPdf(wb));
    expect(pages).toHaveLength(1);
    expect(pages[0]).not.toContain("Check this number");
  });

  it("should append a comment list for atEnd", async () => {
    const { wb } = commentSheet();
    const pages = pageTexts(await excelToPdf(wb, { cellComments: "atEnd" }));
    expect(pages).toHaveLength(2);
    // Grid first, then the list, addressed back to the source cells.
    expect(pages[0]).toContain("body");
    expect(pages[1]).toContain("B7: Check this number");
    expect(pages[1]).toContain("C9: Second remark");
  });

  it("should use the configured bold face for the atEnd title", async () => {
    const { wb } = commentSheet();
    const pdf = await excelToPdf(wb, {
      cellComments: "atEnd",
      fonts: configuredAsciiFonts()
    });
    expect(new TextDecoder("latin1").decode(pdf)).toContain("/Configured#20Bold-Regular-Subset");
  });

  it("should read the mode from the worksheet", async () => {
    const { wb, ws } = commentSheet();
    ws.pageSetup.cellComments = "atEnd";
    expect(pageTexts(await excelToPdf(wb))[1]).toContain("B7: Check this number");
  });

  it("should draw comment boxes on the sheet for asDisplayed", async () => {
    const grid = () => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      for (let r = 1; r <= 12; r++) {
        for (let c = 1; c <= 6; c++) {
          Cell.setValue(ws, r, c, `r${r}c${c}`);
        }
      }
      cellSetNote(getCell(ws, "B6"), "Look here");
      return wb;
    };

    const pdf = await excelToPdf(grid(), { cellComments: "asDisplayed" });
    // Drawn in place, so no extra page is appended.
    expect(pageTexts(pdf)).toHaveLength(1);
    expect(pageTexts(pdf)[0]).toContain("Look here");

    const content = decompressPdfContent(pdf);
    // Note-yellow box plus Excel's red corner marker on the commented cell.
    expect(content).toMatch(/1 1 0\.88 rg/);
    expect(content).toMatch(/0\.8 0 0 rg/);
  });

  it("should inset a displayed comment's first line by its ascent", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    for (let r = 1; r <= 12; r++) {
      for (let c = 1; c <= 6; c++) {
        Cell.setValue(ws, r, c, `r${r}c${c}`);
      }
    }
    cellSetNote(getCell(ws, "B6"), "Look here");

    const pdfBytes = await excelToPdf(wb, { cellComments: "asDisplayed" });
    const content = decompressPdfContent(pdfBytes);
    // The note box is the only note-yellow fill on the page.
    const box = content.match(/1 1 0\.88 rg\s+([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s+f/);
    expect(box).not.toBeNull();
    const boxTop = Number(box![2]) + Number(box![4]);

    const doc = new PdfDocument(pdfBytes);
    const line = extractTextFromPage(doc.getPages()[0], doc).find(f => f.text.includes("Look"));
    expect(line).toBeDefined();

    // The first line's ascent sits one padding below the box top. Stepping down
    // by the font size instead drops the note by font size minus ascent.
    const ascent = getFontAscent(line!.fontName, line!.fontSize);
    expect(boxTop - (line!.y + ascent)).toBeCloseTo(CELL_PADDING_V, 1);
  });

  it("should reserve asDisplayed comment text during configured-font layout", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    for (let row = 1; row <= 8; row++) {
      for (let col = 1; col <= 4; col++) {
        Cell.setValue(ws, row, col, `${row}:${col}`);
      }
    }
    cellSetNote(getCell(ws, "B6"), "Comment text");

    expect(
      pageTexts(
        await excelToPdf(wb, {
          cellComments: "asDisplayed",
          fonts: configuredAsciiFonts()
        })
      )[0]
    ).toContain("Comment text");
  });

  it("should honour an explicit VML anchor for asDisplayed", async () => {
    const build = (anchor?: string) => {
      const wb = Workbook.create();
      const ws = Workbook.addWorksheet(wb, "S");
      for (let r = 1; r <= 12; r++) {
        for (let c = 1; c <= 6; c++) {
          Cell.setValue(ws, r, c, `r${r}c${c}`);
        }
      }
      const note = anchor
        ? ({ texts: [{ text: "Anchored" }], anchor } as never)
        : ({ texts: [{ text: "Anchored" }] } as never);
      cellSetNote(getCell(ws, "B6"), note);
      return wb;
    };

    const at = async (anchor?: string) => {
      const doc = new PdfDocument(await excelToPdf(build(anchor), { cellComments: "asDisplayed" }));
      const frag = extractTextFromPage(doc.getPages()[0], doc).find(f => f.text === "Anchored");
      expect(frag).toBeDefined();
      return { x: frag!.x, y: frag!.y };
    };

    // "col, colOff/68, row, rowOff/18" per edge — a box over C2:E6 rather than
    // Excel's default offset from the cell.
    const anchored = await at("2, 0, 1, 0, 4, 0, 5, 0");
    const fallback = await at();
    expect(anchored.x).not.toBeCloseTo(fallback.x, 0);
    expect(anchored.y).not.toBeCloseTo(fallback.y, 0);
  });

  it("should still append the list for atEnd rather than drawing boxes", async () => {
    const { wb, ws } = commentSheet();
    ws.pageSetup.cellComments = "atEnd";
    const pdf = await excelToPdf(wb);
    expect(pageTexts(pdf)).toHaveLength(2);
    expect(decompressPdfContent(pdf)).not.toMatch(/1 1 0\.88 rg/);
  });

  it("should include the author when the note records one", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", "body");
    cellSetNote(getCell(ws, "A2"), { texts: [{ text: "Reviewed" }] });
    const cell = getCell(ws, "A2");
    // `noteCreate` stores the author alongside the body.
    (cell as unknown as { _comment: { author?: string } })._comment.author = "QA";

    expect(pageTexts(await excelToPdf(wb, { cellComments: "atEnd" }))[1]).toContain("(QA)");
  });

  it("should paginate a long comment list", async () => {
    const wb = Workbook.create();
    const ws = Workbook.addWorksheet(wb, "S");
    Cell.setValue(ws, "A1", "body");
    for (let r = 1; r <= 80; r++) {
      cellSetNote(getCell(ws, `E${r}`), `Remark number ${r} on this row`);
    }
    const pages = pageTexts(await excelToPdf(wb, { cellComments: "atEnd" }));
    // One grid page plus more than one comment page.
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[1]).toContain("E1: Remark number 1");
    expect(pages[pages.length - 1]).toContain("E80: Remark number 80");
  });
});
