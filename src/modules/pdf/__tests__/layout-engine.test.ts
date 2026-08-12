/**
 * Focused tests for layout engine pagination helpers and page placement.
 */
import { FontManager } from "@pdf/font/font-manager";
import { layoutSheet, paginateRows } from "@pdf/render/layout-engine";
import type {
  PdfCellData,
  PdfColumnData,
  PdfRowData,
  PdfSheetData,
  ResolvedPdfOptions,
  PdfPageSetupData
} from "@pdf/types";
import { PdfCellType } from "@pdf/types";
import { describe, expect, it } from "vitest";

describe("layout-engine pagination", () => {
  it("should repeat header rows on subsequent pages", () => {
    const pages = paginateRows([10, 10, 10, 10], 25, 1, new Set());
    expect(pages).toEqual([
      [0, 1],
      [0, 2],
      [0, 3]
    ]);
  });

  it("should avoid emitting repeat-row-only pages when headers cannot fit with body rows", () => {
    const pages = paginateRows([30, 30, 10], 35, 2, new Set());
    expect(pages).toEqual([[0], [1], [2]]);
  });

  it("should honor manual row breaks", () => {
    const pages = paginateRows([10, 10, 10, 10], 100, 0, new Set([2]));
    expect(pages).toEqual([
      [0, 1],
      [2, 3]
    ]);
  });

  // A manual break used to stay "active" after the repeated title rows were
  // re-added, so the loop flushed title-only pages forever and the export died
  // with a heap OOM. Each of these terminates and yields finite pages.
  it("should terminate when repeat rows meet a manual break", () => {
    expect(paginateRows([10, 10, 10, 10], 100, 1, new Set([2]))).toEqual([
      [0, 1],
      [0, 2, 3]
    ]);
  });

  it("should terminate with multiple breaks and a repeated prefix", () => {
    expect(paginateRows([10, 10, 10, 10], 100, 1, new Set([1, 3]))).toEqual([
      [0],
      [0, 1, 2],
      [0, 3]
    ]);
  });

  it("should terminate when the repeat count spans the break", () => {
    expect(paginateRows([10, 10, 10, 10], 100, 2, new Set([1]))).toEqual([[0], [0, 1, 2, 3]]);
  });
});

// =============================================================================
// Page placement — "Center on page" (Excel printOptions)
// =============================================================================

const MARGIN = 72;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

function buildSheet(
  colCount: number,
  rowCount: number,
  colWidth: number,
  pageSetup?: PdfPageSetupData
): PdfSheetData {
  const columns = new Map<number, PdfColumnData>();
  for (let c = 1; c <= colCount; c++) {
    columns.set(c, { width: colWidth });
  }
  const rows = new Map<number, PdfRowData>();
  for (let r = 1; r <= rowCount; r++) {
    const cells = new Map<number, PdfCellData>();
    for (let c = 1; c <= colCount; c++) {
      cells.set(c, {
        type: PdfCellType.String,
        value: `R${r}C${c}`,
        text: `R${r}C${c}`,
        col: c
      });
    }
    rows.set(r, { cells });
  }
  return {
    name: "Sheet1",
    bounds: { top: 1, left: 1, bottom: rowCount, right: colCount },
    columns,
    rows,
    pageSetup
  };
}

function buildOptions(overrides: Partial<ResolvedPdfOptions> = {}): ResolvedPdfOptions {
  return {
    pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    orientation: "portrait",
    margins: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
    ignorePrintArea: false,
    fitToPage: true,
    scale: 1,
    fitToWidth: 0,
    fitToHeight: 0,
    showGridLines: false,
    gridLineColor: { r: 0.8, g: 0.8, b: 0.8 },
    showRowColHeaders: false,
    horizontalCentered: false,
    verticalCentered: false,
    pageOrder: "downThenOver",
    blackAndWhite: false,
    draft: false,
    errors: "displayed",
    cellComments: "none",
    repeatRows: false,
    repeatCols: false,
    defaultFontFamily: "Helvetica",
    defaultFontSize: 11,
    showSheetNames: false,
    showPageNumbers: false,
    includeHeadersFooters: false,
    headerMargin: 21.6,
    footerMargin: 21.6,
    sourceFileName: "",
    sourceFilePath: "",
    headerFooterDate: new Date(0),
    title: "",
    author: "",
    subject: "",
    creator: "documonster",
    ...overrides
  };
}

describe("layout-engine page placement", () => {
  it("should left-align a narrow sheet by default (issue #203)", async () => {
    const pages = await layoutSheet(buildSheet(2, 5, 12), buildOptions(), new FontManager());

    expect(pages).toHaveLength(1);
    expect(pages[0].columnOffsets[0]).toBeCloseTo(MARGIN, 5);
  });

  it("should center a narrow sheet horizontally when horizontalCentered is set", async () => {
    const sheet = buildSheet(2, 5, 12);
    const pages = await layoutSheet(
      sheet,
      buildOptions({ horizontalCentered: true }),
      new FontManager()
    );

    const contentWidth = PAGE_WIDTH - 2 * MARGIN;
    const tableWidth = pages[0].columnWidths.reduce((s, w) => s + w, 0);
    expect(tableWidth).toBeLessThan(contentWidth);
    expect(pages[0].columnOffsets[0]).toBeCloseTo(MARGIN + (contentWidth - tableWidth) / 2, 5);
  });

  it("should keep all horizontal page groups left-aligned by default", async () => {
    // 30 columns at width 12 overflow the content area, so the last column
    // group is narrower than the page — it must still start at the margin.
    const pages = await layoutSheet(
      buildSheet(30, 3, 12),
      buildOptions({ fitToPage: false }),
      new FontManager()
    );

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.columnOffsets[0]).toBeCloseTo(MARGIN, 5);
    }
  });

  it("should top-align rows by default", async () => {
    const pages = await layoutSheet(buildSheet(2, 5, 12), buildOptions(), new FontManager());

    expect(pages[0].rowYPositions[0]).toBeCloseTo(PAGE_HEIGHT - MARGIN, 5);
  });

  it("should center rows vertically when verticalCentered is set", async () => {
    const sheet = buildSheet(2, 5, 12);
    const pages = await layoutSheet(
      sheet,
      buildOptions({ verticalCentered: true }),
      new FontManager()
    );

    const availableHeight = PAGE_HEIGHT - 2 * MARGIN;
    const tableHeight = pages[0].rowHeights.reduce((s, h) => s + h, 0);
    expect(pages[0].rowYPositions[0]).toBeCloseTo(
      PAGE_HEIGHT - MARGIN - (availableHeight - tableHeight) / 2,
      5
    );
  });

  it("should derive centering from the sheet pageSetup when no option is given", async () => {
    // resolveOptions() (pdf-exporter) performs the pageSetup fallback; this
    // asserts the layout engine honours whatever the resolved flag says.
    const sheet = buildSheet(2, 5, 12, { horizontalCentered: true });
    const left = await layoutSheet(sheet, buildOptions(), new FontManager());
    const centered = await layoutSheet(
      sheet,
      buildOptions({ horizontalCentered: true }),
      new FontManager()
    );

    expect(left[0].columnOffsets[0]).toBeCloseTo(MARGIN, 5);
    expect(centered[0].columnOffsets[0]).toBeGreaterThan(MARGIN);
  });
});
