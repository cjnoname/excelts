/**
 * Layout engine for PDF generation.
 *
 * Takes a PdfSheetData and produces LayoutPage objects that describe exactly
 * where each cell, border, and piece of text should be drawn on each PDF page.
 *
 * This module is fully independent of the Excel module — it works with
 * the PDF module's own data model (PdfSheetData, PdfCellData, etc.).
 *
 * Key responsibilities:
 * - Convert column widths (character units) to PDF points
 * - Convert row heights (points already, but may need scaling)
 * - Handle merged cells spanning multiple rows/columns
 * - Paginate content across multiple pages
 * - Handle fitToPage scaling
 * - Handle repeated header rows
 * - Skip hidden rows and columns
 */

import type { FontManager } from "@pdf/font/font-manager";
import {
  CELL_PADDING_H,
  CELL_PADDING_V,
  LINE_HEIGHT_FACTOR,
  INDENT_WIDTH,
  MAX_DIGIT_WIDTH_PX,
  PX_TO_PT,
  HEADING_FONT_SIZE,
  HEADING_PADDING,
  COMMENT_MARKER_SIZE,
  COLUMN_FIT_EPSILON,
  SHEET_NAME_BAND_HEIGHT,
  PAGE_NUMBER_BAND_HEIGHT,
  FIT_MIN_SCALE
} from "@pdf/render/constants";
import { wrapRichTextLines, wrapTextLines } from "@pdf/render/page-renderer";
import {
  extractFontProperties,
  excelFillToPdfColor,
  excelBordersToPdf,
  excelHAlignToPdf,
  excelVAlignToPdf,
  borderStyleToLineWidth,
  toGrayscale,
  grayscaleBorders
} from "@pdf/render/style-converter";
import type {
  PdfSheetData,
  PdfChartsheetData,
  PdfCellData,
  PdfCellStyle,
  PdfRowData,
  PdfRichTextRunData,
  PdfFontStyle,
  PdfSheetImage,
  PdfSheetChart,
  PdfAlignmentData,
  PdfCellTypeValue,
  ResolvedPdfOptions,
  PdfCellErrorMode,
  PdfRepeatBand,
  PdfSheetComment,
  PdfCommentAnchor,
  LayoutCommentBox,
  LayoutHeadings,
  LayoutPage,
  LayoutChart,
  LayoutCell,
  LayoutBorder,
  LayoutRichTextRun
} from "@pdf/types";
import { PdfCellType } from "@pdf/types";
import { emuToPt, charWidthToPixel } from "@utils/units";
import { yieldToEventLoop } from "@utils/utils.base";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_COLUMN_WIDTH = 8.43;
const DEFAULT_ROW_HEIGHT = 15;
const MIN_COLUMN_WIDTH = 3;

// =============================================================================
// Type-based Default Alignment
// =============================================================================

/**
 * Resolve horizontal alignment, using Excel's type-based defaults when
 * no explicit alignment is set (or when alignment is "general"):
 * - Numbers/Dates → right
 * - Booleans/Errors → center
 * - Text/RichText/Hyperlink → left
 * - Formulas → based on result type
 */
function resolveHorizontalAlign(
  alignment: Partial<PdfAlignmentData> | undefined,
  cellType: PdfCellTypeValue | undefined,
  formulaResult?: unknown
): "left" | "center" | "right" {
  // If explicitly set (and not "general"), use the explicit alignment
  if (alignment?.horizontal && alignment.horizontal !== "general") {
    return excelHAlignToPdf(alignment);
  }

  // Use type-based default
  if (cellType !== undefined) {
    switch (cellType) {
      case PdfCellType.Number:
      case PdfCellType.Date:
        return "right";
      case PdfCellType.Boolean:
      case PdfCellType.Error:
        return "center";
      case PdfCellType.Formula:
        if (typeof formulaResult === "number" || formulaResult instanceof Date) {
          return "right";
        }
        if (typeof formulaResult === "boolean") {
          return "center";
        }
        return "left";
      default:
        return "left";
    }
  }

  return "left";
}

// =============================================================================
// Layout Engine
// =============================================================================

/**
 * Compute the layout for a sheet across one or more PDF pages.
 * Yields to the event loop between each output page.
 */
export async function layoutSheet(
  sheet: PdfSheetData,
  options: ResolvedPdfOptions,
  fontManager: FontManager
): Promise<LayoutPage[]> {
  const ctx = prepareLayout(sheet, options, fontManager);
  if (!ctx) {
    return [createEmptyPage(sheet, options)];
  }

  const layoutPages: LayoutPage[] = [];
  const totalOutputPages = ctx.rowPages.length * ctx.colGroups.length;

  // Excel's "Page order". `downThenOver` (Excel's default) walks each column
  // band top to bottom before moving right; `overThenDown` walks each row band
  // left to right before moving down. Only the nesting differs, so pick which
  // axis is outer rather than materialising every pair.
  const overThenDown = options.pageOrder === "overThenDown";
  const outer: number[][] = overThenDown ? ctx.rowPages : ctx.colGroups;
  const inner: number[][] = overThenDown ? ctx.colGroups : ctx.rowPages;

  for (const outerTracks of outer) {
    for (const innerTracks of inner) {
      const rowPage = overThenDown ? outerTracks : innerTracks;
      const colGroup = overThenDown ? innerTracks : outerTracks;
      layoutPages.push(
        buildPageLayout(ctx, rowPage, colGroup, layoutPages.length, sheet, options, fontManager)
      );
      if (layoutPages.length < totalOutputPages) {
        await yieldToEventLoop();
      }
    }
  }

  // Draft quality omits graphics, matching Excel's "Draft quality" option.
  if (layoutPages.length > 0 && sheet.images && !options.draft) {
    assignImagesToPages(sheet.images, layoutPages, ctx.scaleFactor);
  }
  if (layoutPages.length > 0 && sheet.charts && !options.draft) {
    assignChartsToPages(sheet.charts, layoutPages, ctx.scaleFactor);
  }

  // Excel's "Comments: at end of sheet" — appended after the grid so the page
  // numbering below covers them too.
  if (options.cellComments === "atEnd" && sheet.comments?.length) {
    layoutPages.push(...buildCommentPages(sheet, sheet.comments, options, fontManager));
  }

  // Only the per-sheet index is settled here; `fixPageNumbers` in the exporter
  // owns `pageNumber`, `sheetPageNumber` and the document-wide `sheetPageCount`.
  for (let i = 0; i < layoutPages.length; i++) {
    layoutPages[i].sheetPageIndex = i + 1;
  }

  return layoutPages;
}

/**
 * Produce the layout for a chartsheet — a single PDF page whose entire
 * content area is covered by one chart.
 *
 * Chartsheets have no row/column grid, so we bypass the cell-layout
 * pipeline entirely. Page dimensions come from `options.pageSize`, with
 * orientation overridden by the chartsheet's own `orientation` field
 * (Excel's chartsheet convention defaults to landscape; see the
 * `CHARTSHEET_EMU_CX/CY` constants that define the drawing canvas in
 * `xlsx.browser.ts`).
 *
 * The returned LayoutPage has:
 *  - `cells = []` (no grid to render)
 *  - `charts` containing one full-content-area chart
 *  - all other cell-grid arrays empty
 *
 * The existing `renderSinglePage` in `pdf-exporter.ts` already handles
 * pages with zero cells and a non-empty `charts` array via the shared
 * chart-rendering path, so no exporter changes are needed here.
 */
export function layoutChartsheet(
  sheet: PdfChartsheetData,
  documentOptions: ResolvedPdfOptions
): LayoutPage[] {
  // Chartsheet orientation override — independent of the document
  // default. We clone the options so neighbouring worksheets aren't
  // affected when a single chartsheet flips to portrait.
  const orientation: ResolvedPdfOptions["orientation"] =
    sheet.orientation ?? documentOptions.orientation;
  const options: ResolvedPdfOptions = { ...documentOptions, orientation };

  const { width: pageWidth, height: pageHeight } = pageDimensions(options);

  const margins = options.margins;
  const headerHeight = options.showSheetNames ? SHEET_NAME_BAND_HEIGHT : 0;
  const footerHeight = options.showPageNumbers ? PAGE_NUMBER_BAND_HEIGHT : 0;
  const contentX = margins.left;
  const contentY = margins.bottom + footerHeight;
  const contentWidth = pageWidth - margins.left - margins.right;
  const contentHeight = pageHeight - margins.top - margins.bottom - headerHeight - footerHeight;

  const chart: LayoutChart = {
    rect: {
      x: contentX,
      y: contentY,
      width: Math.max(0, contentWidth),
      height: Math.max(0, contentHeight)
    },
    drawVector: sheet.chart.drawVector,
    raster: sheet.chart.raster
  };

  return [
    {
      ...blankPage(sheet, options),
      // Draft quality omits graphics. A chartsheet is nothing but a graphic, so
      // the page is still emitted — Excel likewise prints a blank sheet rather
      // than dropping it from the page count.
      charts: options.draft ? [] : [chart]
    }
  ];
}

// =============================================================================
// Internal — Shared Layout Pipeline
// =============================================================================

/**
 * Page dimensions for the resolved options, with landscape applied.
 *
 * `pageSize` is always stored portrait-wise, so every consumer has to swap the
 * axes itself; centralised here so the four layout entry points cannot disagree.
 */
function pageDimensions(options: ResolvedPdfOptions): { width: number; height: number } {
  const { width, height } = options.pageSize;
  return options.orientation === "landscape" ? { width: height, height: width } : { width, height };
}

/**
 * A `LayoutPage` with every field at its empty value.
 *
 * The shape has ~20 members and four construction sites; building them from one
 * skeleton means a new field cannot be forgotten in three of them.
 */
function blankPage(
  sheet: PdfSheetData | PdfChartsheetData,
  options: ResolvedPdfOptions
): LayoutPage {
  const { width, height } = pageDimensions(options);
  return {
    pageNumber: 1,
    sheetPageNumber: sheet.pageSetup?.firstPageNumber ?? 1,
    sheetPageIndex: 1,
    sheetPageCount: 1,
    firstPageNumber: sheet.pageSetup?.firstPageNumber,
    options,
    cells: [],
    width,
    height,
    sheetName: sheet.name,
    sheetCols: [],
    columnOffsets: [],
    columnWidths: [],
    sheetRows: [],
    rowYPositions: [],
    rowHeights: [],
    images: [],
    charts: [],
    scaleFactor: 1,
    headerFooter: options.includeHeadersFooters ? sheet.headerFooter : undefined
  };
}

/** Pre-computed layout context for the layout pipeline. */
interface LayoutContext {
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
  /** Vertical space left for the cell grid after header/footer bands. */
  availableHeight: number;
  headerHeight: number;
  scaleFactor: number;
  scaledColumnWidths: number[];
  rowHeights: number[];
  visibleRows: number[];
  visibleCols: number[];
  mergeMap: Map<string, MergeInfo>;
  rowPages: number[][];
  colGroups: number[][];
  margins: { top: number; right: number; bottom: number; left: number };
  /** Row/column heading band geometry, when printing headings. */
  headings?: LayoutHeadings;
}

/**
 * Steps 1–5: compute columns, scale, rows, merges, pagination.
 * Returns null if the sheet has no visible columns (→ caller should emit an empty page).
 */
function prepareLayout(
  sheet: PdfSheetData,
  options: ResolvedPdfOptions,
  fontManager: FontManager
): LayoutContext | null {
  const { margins } = options;

  const { width: pageWidth, height: pageHeight } = pageDimensions(options);

  const headerHeight = options.showSheetNames ? SHEET_NAME_BAND_HEIGHT : 0;
  const printRange = getPrintRange(sheet, options);

  // Excel's "Row and column headings". The bands are deliberately *not*
  // scaled with the grid: they are a print aid rather than content, and a
  // fixed size stays legible at small print scales while letting us reserve
  // exactly the space we later draw into.
  const headings = options.showRowColHeaders
    ? computeHeadingMetrics(sheet, printRange, fontManager, options)
    : undefined;
  const gutterWidth = headings?.gutterWidth ?? 0;
  const bandHeight = headings?.bandHeight ?? 0;

  const contentWidth = pageWidth - margins.left - margins.right - gutterWidth;
  const contentHeight = pageHeight - margins.top - margins.bottom - bandHeight;

  // --- Step 1: Visible columns and widths (title columns lead) ---
  const { columnWidths, visibleCols, repeatColIndices } = computeColumnWidths(
    sheet,
    printRange,
    options.repeatCols
  );
  if (visibleCols.length === 0) {
    return null;
  }

  // --- Step 2: Scale ---
  // Rows are measured once, unscaled: heights are linear in the print scale, so
  // the fit solver can probe by multiplying instead of re-measuring.
  const natural = computeRowHeights(sheet, printRange, fontManager, options, options.repeatRows);
  // Break sets are derived once: the fit solver paginates ~25 times per axis.
  const rowBreaks = buildBreakSet(sheet.rowBreaks ?? [], natural.visibleRows);
  const colBreaks = buildBreakSet(sheet.colBreaks ?? [], visibleCols);
  const totalTableWidth = columnWidths.reduce((sum, w) => sum + w, 0);
  const footerHeight = options.showPageNumbers ? PAGE_NUMBER_BAND_HEIGHT : 0;
  const availableHeight = contentHeight - headerHeight - footerHeight;
  let scaleFactor = options.scale;

  if (options.fitToWidth > 0 || options.fitToHeight > 0) {
    // Excel's "Fit to N page(s) wide by M tall". Like Excel, this only ever
    // shrinks — a grid smaller than the target is left at actual size.
    //
    // A total-size ratio alone does not deliver the promise: pagination packs
    // indivisible columns/rows greedily, and repeated title bands consume space
    // on every page after the first. Three columns at 60% of the page width fit
    // "1.8 pages" by area yet still need three pages. So the ratio is only a
    // starting upper bound, which we then tighten against the real packer.
    let fit = 1;
    // Excel's 10% floor applies to the *final* scale, so express it relative to
    // the factor already in play.
    const minFit = Math.min(1, FIT_MIN_SCALE / scaleFactor);
    if (options.fitToWidth > 0 && totalTableWidth > 0) {
      fit = Math.min(fit, (contentWidth * options.fitToWidth) / (totalTableWidth * scaleFactor));
      fit = tightenToPageCount(
        candidate =>
          paginateTracks(
            columnWidths.map(w => w * scaleFactor * candidate),
            contentWidth,
            repeatColIndices,
            colBreaks,
            COLUMN_FIT_EPSILON
          ).length,
        options.fitToWidth,
        fit,
        minFit
      );
    }
    if (options.fitToHeight > 0 && availableHeight > 0) {
      const totalTableHeight = natural.rowHeights.reduce((sum, h) => sum + h, 0);
      if (totalTableHeight > 0) {
        let heightFit = Math.min(
          fit,
          (availableHeight * options.fitToHeight) / (totalTableHeight * scaleFactor)
        );
        heightFit = tightenToPageCount(
          candidate =>
            paginateTracks(
              natural.rowHeights.map(h => h * scaleFactor * candidate),
              availableHeight,
              natural.repeatRowIndices,
              rowBreaks
            ).length,
          options.fitToHeight,
          heightFit,
          minFit
        );
        fit = Math.min(fit, heightFit);
      }
    }
    if (fit < 1) {
      scaleFactor = Math.max(scaleFactor * fit, FIT_MIN_SCALE);
    }
  } else if (options.fitToPage && totalTableWidth > 0) {
    // Same contract as `fitToWidth: 1`: it is the *final* width that must fit
    // one page, so `scale` belongs inside the ratio rather than multiplied on
    // top of it. Dividing by the running factor makes this `min(scale,
    // contentWidth / totalTableWidth)`, which neither overflows when `scale`
    // enlarges nor shrinks twice when it already reduces.
    const fitScale = contentWidth / (totalTableWidth * scaleFactor);
    if (fitScale < 1) {
      scaleFactor *= fitScale;
    }
  }
  const scaledColumnWidths = columnWidths.map(w => w * scaleFactor);

  // --- Step 3: Apply the final scale to the measured heights ---
  const rowHeights = natural.rowHeights.map(h => h * scaleFactor);
  const { visibleRows, repeatRowIndices } = natural;

  // --- Step 4: Merge map ---
  const mergeMap = buildMergeMap(sheet);

  // --- Step 5: Paginate ---
  const rowPages = paginateTracks(rowHeights, availableHeight, repeatRowIndices, rowBreaks);
  const colGroups = paginateTracks(
    scaledColumnWidths,
    contentWidth,
    repeatColIndices,
    colBreaks,
    COLUMN_FIT_EPSILON
  );

  return {
    pageWidth,
    pageHeight,
    contentWidth,
    availableHeight,
    headerHeight,
    scaleFactor,
    scaledColumnWidths,
    rowHeights,
    visibleRows,
    visibleCols,
    mergeMap,
    rowPages,
    colGroups,
    margins,
    headings
  };
}

/**
 * Size the row-number gutter and column-letter band for Excel's "Row and
 * column headings" print option.
 *
 * The gutter is sized from the widest row label that can appear in the printed
 * range, so the grid origin is stable across pages instead of jittering as row
 * numbers gain digits.
 */
function computeHeadingMetrics(
  sheet: PdfSheetData,
  printRange: PrintRange | null,
  fontManager: FontManager,
  options: ResolvedPdfOptions
): LayoutHeadings {
  const fontSize = HEADING_FONT_SIZE;
  const resourceName = fontManager.resolveFont(options.defaultFontFamily, false, false);

  const lastRow = printRange?.endRow ?? sheet.bounds.bottom;
  const widestLabel = String(Math.max(1, lastRow));
  fontManager.trackText(widestLabel, resourceName);
  const labelWidth = fontManager.measureText(widestLabel, resourceName, fontSize);

  return {
    gutterWidth: labelWidth + 2 * HEADING_PADDING,
    bandHeight: fontSize + 2 * HEADING_PADDING,
    fontSize
  };
}

function columnNumberToLetters(col: number): string {
  let n = col;
  let label = "";
  while (n > 0) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/**
 * Largest scale ≤ `startScale` whose real pagination lands within `target`
 * pages, found by bisection.
 *
 * The caller passes a closure that re-paginates at a candidate scale, so the
 * answer respects indivisible columns/rows, manual breaks and repeated title
 * bands instead of trusting a total-size ratio. Returns `startScale` untouched
 * when it already fits, so nothing is shrunk needlessly.
 *
 * `minScale` is the floor the result may not go below. When the target is
 * unreachable even there — manual page breaks alone can force more pages than
 * requested — the floor is returned and the sheet simply spans more than
 * `target` pages, which is preferable to shrinking it into illegibility.
 */
function tightenToPageCount(
  pageCountAt: (scale: number) => number,
  target: number,
  startScale: number,
  minScale: number
): number {
  const start = Math.max(startScale, minScale);
  if (pageCountAt(start) <= target || start <= minScale) {
    return start;
  }
  let lo = minScale;
  let hi = start;
  if (pageCountAt(lo) > target) {
    return lo;
  }
  // 24 halvings resolve the scale to ~6e-8 of the starting bound, far below one
  // device pixel, and each probe is pure arithmetic over the track sizes.
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (pageCountAt(mid) <= target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Lay out Excel's "Comments at end of sheet" as extra pages.
 *
 * Each entry becomes an ordinary {@link LayoutCell} spanning the content width,
 * so the existing page renderer draws them with no special casing — including
 * word wrapping, which long comment bodies need. Pages are filled top to bottom
 * and a new one starts when the next entry would overflow.
 */
function buildCommentPages(
  sheet: PdfSheetData,
  comments: PdfSheetComment[],
  options: ResolvedPdfOptions,
  fontManager: FontManager
): LayoutPage[] {
  const { width: pageWidth, height: pageHeight } = pageDimensions(options);

  const { margins } = options;
  const headerHeight = options.showSheetNames ? SHEET_NAME_BAND_HEIGHT : 0;
  const footerHeight = options.showPageNumbers ? PAGE_NUMBER_BAND_HEIGHT : 0;
  const contentWidth = pageWidth - margins.left - margins.right;
  const top = pageHeight - margins.top - headerHeight;
  const bottom = margins.bottom + footerHeight;

  const fontSize = options.defaultFontSize;
  const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
  const textColor = { r: 0, g: 0, b: 0 };

  const pages: LayoutPage[] = [];
  let cells: LayoutCell[] = [];
  let cursor = top;

  const flush = () => {
    if (cells.length > 0) {
      pages.push({ ...blankPage(sheet, options), cells });
      cells = [];
      cursor = top;
    }
  };

  const push = (text: string, bold: boolean) => {
    const resourceName = fontManager.resolveFont(options.defaultFontFamily, bold, false);
    fontManager.trackText(text, resourceName);
    const measure = (value: string) => fontManager.measureText(value, resourceName, fontSize);
    const lines = wrapTextLines(text, measure, Math.max(contentWidth - 2 * CELL_PADDING_H, 1));
    const height = Math.max(lines.length, 1) * lineHeight + 2 * CELL_PADDING_V;
    if (cursor - height < bottom) {
      flush();
    }
    cells.push({
      text,
      rect: { x: margins.left, y: cursor - height, width: contentWidth, height },
      fontFamily: options.defaultFontFamily,
      fontSize,
      bold,
      italic: false,
      strike: false,
      underline: false,
      textColor,
      fillColor: null,
      horizontalAlign: "left",
      verticalAlign: "top",
      wrapText: true,
      borders: { top: null, right: null, bottom: null, left: null },
      borderInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      colSpan: 1,
      rowSpan: 1,
      hyperlink: null,
      richText: null,
      textRotation: 0,
      indent: 0,
      textOverflowWidth: 0
    });
    cursor -= height;
  };

  push(`${sheet.name} — comments`, true);
  for (const comment of comments) {
    const author = comment.author ? ` (${comment.author})` : "";
    push(`${comment.ref}${author}: ${comment.text}`, false);
  }
  flush();

  return pages;
}

/**
 * Build the LayoutPage for a single rowPage × colGroup combination.
 */
function buildPageLayout(
  ctx: LayoutContext,
  rowPage: number[],
  colGroup: number[],
  currentPageCount: number,
  sheet: PdfSheetData,
  options: ResolvedPdfOptions,
  fontManager: FontManager
): LayoutPage {
  const {
    scaledColumnWidths,
    rowHeights,
    visibleRows,
    visibleCols,
    mergeMap,
    pageWidth,
    pageHeight,
    contentWidth,
    availableHeight,
    headerHeight,
    scaleFactor,
    margins,
    headings
  } = ctx;

  const cells: LayoutCell[] = [];
  // The row-number gutter and column-letter band shift the grid origin right
  // and down respectively; both are 0 when headings are not printed.
  const gridLeft = margins.left + (headings?.gutterWidth ?? 0);
  const gridTop = pageHeight - margins.top - headerHeight - (headings?.bandHeight ?? 0);

  // Compute column offsets for this column group. Content starts at the left
  // margin, matching Excel's print behaviour; it is only centered when the
  // sheet (or the caller) asks for it via Excel's "Center on page →
  // Horizontally" print option.
  const groupColWidths = colGroup.map(ci => scaledColumnWidths[ci]);
  const groupTotalWidth = groupColWidths.reduce((s, w) => s + w, 0);
  const groupColOffsets: number[] = [];
  let gx = gridLeft;
  if (options.horizontalCentered && groupTotalWidth < contentWidth) {
    gx = gridLeft + (contentWidth - groupTotalWidth) / 2;
  }
  for (const w of groupColWidths) {
    groupColOffsets.push(gx);
    gx += w;
  }

  // Row Y positions. Same rule as above for the vertical axis.
  const rowYPositions: number[] = [];
  const pageRowHeights: number[] = [];
  let currentY = gridTop;
  if (options.verticalCentered) {
    const pageTotalHeight = rowPage.reduce(
      (sum, rowIdx) => sum + (rowHeights[rowIdx] ?? DEFAULT_ROW_HEIGHT * scaleFactor),
      0
    );
    if (pageTotalHeight < availableHeight) {
      currentY -= (availableHeight - pageTotalHeight) / 2;
    }
  }
  for (const rowIdx of rowPage) {
    const rowH = rowHeights[rowIdx] ?? DEFAULT_ROW_HEIGHT * scaleFactor;
    rowYPositions.push(currentY);
    pageRowHeights.push(rowH);
    currentY -= rowH;
  }

  // Build cells for this row page × column group
  const cellGrid = new Map<string, LayoutCell>();

  for (let ri = 0; ri < rowPage.length; ri++) {
    const visibleRowIdx = rowPage[ri];
    const wsRowNumber = visibleRows[visibleRowIdx];

    for (let gci = 0; gci < colGroup.length; gci++) {
      const ci = colGroup[gci];
      const wsColNumber = visibleCols[ci];

      const mergeKey = `${wsRowNumber}:${wsColNumber}`;
      const mergeInfo = mergeMap.get(mergeKey);
      if (mergeInfo && !mergeInfo.isMaster) {
        continue;
      }

      const row = sheet.rows.get(wsRowNumber);
      const cell = row?.cells.get(wsColNumber);

      let colSpan = 1;
      let rowSpan = 1;
      if (mergeInfo && mergeInfo.isMaster) {
        const mergeEndCol = wsColNumber + mergeInfo.colSpan - 1;
        colSpan = 0;
        for (let s = gci; s < colGroup.length; s++) {
          if (visibleCols[colGroup[s]] <= mergeEndCol) {
            colSpan++;
          } else {
            break;
          }
        }
        const mergeEndRow = wsRowNumber + mergeInfo.rowSpan - 1;
        rowSpan = 0;
        for (let s = visibleRowIdx; s < visibleRows.length; s++) {
          if (visibleRows[s] <= mergeEndRow) {
            rowSpan++;
          } else {
            break;
          }
        }
        colSpan = Math.max(colSpan, 1);
        rowSpan = Math.max(rowSpan, 1);
      }

      const cellX = groupColOffsets[gci];
      const cellY = rowYPositions[ri];
      let cellWidth = 0;
      for (let s = 0; s < colSpan && gci + s < groupColWidths.length; s++) {
        cellWidth += groupColWidths[gci + s];
      }
      let cellHeight = 0;
      for (let s = 0; s < rowSpan && ri + s < pageRowHeights.length; s++) {
        cellHeight += pageRowHeights[ri + s];
      }
      const rectY = cellY - cellHeight;

      cells.push(
        buildLayoutCell(
          cell,
          cellX,
          rectY,
          cellWidth,
          cellHeight,
          colSpan,
          rowSpan,
          options,
          fontManager,
          scaleFactor
        )
      );

      const layoutCell = cells[cells.length - 1];

      // Propagate merged cell borders from boundary cells
      if (mergeInfo?.isMaster) {
        propagateMergeBorders(layoutCell, mergeInfo, wsRowNumber, wsColNumber, sheet);
        // Propagation re-converts the boundary cell's border straight from the
        // Excel style, bypassing the conversion in `buildLayoutCell`, so the
        // black-and-white pass has to be reapplied to the result.
        if (options.blackAndWhite) {
          layoutCell.borders = grayscaleBorders(layoutCell.borders);
        }
      }

      cellGrid.set(`${ri}:${gci}`, layoutCell);
    }
  }

  // Resolve shared borders: on each shared edge between adjacent cells, keep
  // only the winning border for drawing but preserve insets for both cells.
  resolveSharedBorders(cellGrid, rowPage.length, colGroup.length);

  // Compute text overflow widths for non-wrapped cells
  computeTextOverflows(
    cellGrid,
    rowPage,
    colGroup,
    visibleRows,
    visibleCols,
    groupColWidths,
    mergeMap,
    fontManager
  );

  if (headings) {
    const resourceName = fontManager.resolveFont(options.defaultFontFamily, false, false);
    for (const col of colGroup) {
      fontManager.trackText(columnNumberToLetters(visibleCols[col]), resourceName);
    }
    for (const row of rowPage) {
      fontManager.trackText(String(visibleRows[row]), resourceName);
    }
  }

  return {
    pageNumber: currentPageCount + 1,
    sheetPageNumber: currentPageCount + 1,
    sheetPageIndex: currentPageCount + 1,
    sheetPageCount: 1,
    firstPageNumber: sheet.pageSetup?.firstPageNumber,
    options,
    cells,
    width: pageWidth,
    height: pageHeight,
    sheetName: sheet.name,
    sheetCols: colGroup.map(ci => visibleCols[ci]),
    columnOffsets: groupColOffsets,
    columnWidths: groupColWidths,
    sheetRows: rowPage.map(ri => visibleRows[ri]),
    rowYPositions,
    rowHeights: pageRowHeights,
    images: [],
    charts: [],
    scaleFactor,
    headings,
    commentBoxes:
      options.cellComments === "asDisplayed"
        ? placeCommentBoxes(
            sheet,
            colGroup.map(ci => visibleCols[ci]),
            groupColOffsets,
            groupColWidths,
            rowPage.map(ri => visibleRows[ri]),
            rowYPositions,
            pageRowHeights,
            options,
            scaleFactor,
            fontManager
          )
        : undefined,
    headerFooter: options.includeHeadersFooters ? sheet.headerFooter : undefined
  };
}

/**
 * Position each comment box on a page, for `cellComments: "asDisplayed"`.
 *
 * A comment is placed when its box overlaps the page's tracks. Fractional VML
 * coordinates are interpolated against the page's own column offsets and row
 * positions, so a box lands correctly even when the scale, hidden tracks or
 * repeated title bands have moved the grid around. Comments whose box falls
 * entirely outside the page are skipped, which keeps each one on a single page
 * rather than slicing it across the seam.
 */
function placeCommentBoxes(
  sheet: PdfSheetData,
  sheetCols: number[],
  columnOffsets: number[],
  columnWidths: number[],
  sheetRows: number[],
  rowYPositions: number[],
  rowHeights: number[],
  options: ResolvedPdfOptions,
  scaleFactor: number,
  fontManager: FontManager
): LayoutCommentBox[] | undefined {
  const comments = sheet.comments;
  if (!comments?.length || sheetCols.length === 0 || sheetRows.length === 0) {
    return undefined;
  }

  // VML coordinates are 0-based; the page tracks are 1-based sheet numbers.
  const xAt = (col: number): number | undefined => {
    const index = sheetCols.indexOf(Math.floor(col) + 1);
    if (index < 0) {
      return undefined;
    }
    return columnOffsets[index] + (col - Math.floor(col)) * columnWidths[index];
  };
  const yAt = (row: number): number | undefined => {
    const index = sheetRows.indexOf(Math.floor(row) + 1);
    if (index < 0) {
      return undefined;
    }
    return rowYPositions[index] - (row - Math.floor(row)) * rowHeights[index];
  };

  const boxes: LayoutCommentBox[] = [];
  for (const comment of comments) {
    const anchor = comment.anchor ?? defaultCommentAnchor(comment.ref);
    if (!anchor) {
      continue;
    }
    const left = xAt(anchor.left);
    const right = xAt(anchor.right);
    const top = yAt(anchor.top);
    const bottom = yAt(anchor.bottom);
    if (left === undefined || right === undefined || top === undefined || bottom === undefined) {
      continue;
    }

    const width = right - left;
    const height = top - bottom;
    if (width <= 0 || height <= 0) {
      continue;
    }

    const cell = parseCellRef(comment.ref);
    const markerCol = sheetCols.indexOf(cell.c + 1);
    const markerRow = sheetRows.indexOf(cell.r + 1);
    const author = comment.author ? `${comment.author}:\n` : "";
    const text = `${author}${comment.text}`;
    const resourceName = fontManager.resolveFont(options.defaultFontFamily, false, false);
    fontManager.trackText(text, resourceName);

    boxes.push({
      rect: { x: left, y: bottom, width, height },
      text,
      fontSize: options.defaultFontSize * scaleFactor,
      marker:
        markerCol >= 0 && markerRow >= 0
          ? {
              x: columnOffsets[markerCol] + columnWidths[markerCol],
              y: rowYPositions[markerRow],
              size: COMMENT_MARKER_SIZE * scaleFactor
            }
          : undefined
    });
  }

  return boxes.length > 0 ? boxes : undefined;
}

/**
 * Excel's default comment placement, used when the note carries no VML anchor.
 *
 * Mirrors the geometry Excel writes for a fresh comment: the box starts at the
 * commented cell's column, two rows above it, and spans two columns by four
 * rows.
 */
function defaultCommentAnchor(ref: string): PdfCommentAnchor | undefined {
  let cell: CellRef;
  try {
    cell = parseCellRef(ref);
  } catch {
    return undefined;
  }
  const left = cell.c + 6 / 68;
  const top = Math.max(cell.r - 2, 0) + 14 / 18;
  return { left, top, right: left + 2, bottom: top + 4 };
}

function createEmptyPage(sheet: PdfSheetData, options: ResolvedPdfOptions): LayoutPage {
  return blankPage(sheet, options);
}

// =============================================================================
// Range Parsing (standalone — no @excel dependency)
// =============================================================================

interface CellRef {
  /** 0-indexed column */
  c: number;
  /** 0-indexed row */
  r: number;
}

interface RangeRef {
  s: CellRef;
  e: CellRef;
}

/**
 * Parse a cell reference like "A1" into 0-indexed { c, r }.
 */
function parseCellRef(ref: string): CellRef {
  const upper = ref.replace(/\$/g, "").toUpperCase();
  let col = 0;
  let i = 0;
  while (i < upper.length && upper.charCodeAt(i) >= 65 && upper.charCodeAt(i) <= 90) {
    col = col * 26 + (upper.charCodeAt(i) - 64);
    i++;
  }
  const row = parseInt(upper.substring(i), 10);
  return { c: col - 1, r: row - 1 };
}

/**
 * Parse a range string like "A1:B2" into 0-indexed start/end.
 */
function parseRangeRef(range: string): RangeRef {
  const idx = range.indexOf(":");
  if (idx === -1) {
    const cell = parseCellRef(range);
    return { s: cell, e: { ...cell } };
  }
  return {
    s: parseCellRef(range.slice(0, idx)),
    e: parseCellRef(range.slice(idx + 1))
  };
}

// =============================================================================
// Print Range
// =============================================================================

interface PrintRange {
  startRow: number; // 1-based
  endRow: number;
  startCol: number;
  endCol: number;
}

/**
 * Get the print area range from the sheet's pageSetup.
 * Returns null if no print area is set, or if `ignorePrintArea` is enabled.
 */
function getPrintRange(sheet: PdfSheetData, options: ResolvedPdfOptions): PrintRange | null {
  if (options.ignorePrintArea) {
    return null;
  }
  const printArea = sheet.pageSetup?.printArea;
  if (!printArea || typeof printArea !== "string") {
    return null;
  }
  // printArea may be multi-range separated by "&&" (e.g. "A1:B2&&D1:E2").
  // Use the first range for PDF export.
  const firstRange = printArea.split("&&")[0].trim();
  if (!firstRange) {
    return null;
  }
  try {
    const range = parseRangeRef(firstRange);
    return {
      startRow: range.s.r + 1,
      endRow: range.e.r + 1,
      startCol: range.s.c + 1,
      endCol: range.e.c + 1
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Column Width Computation
// =============================================================================

function computeColumnWidths(
  sheet: PdfSheetData,
  printRange: PrintRange | null,
  titleBand?: PdfRepeatBand | false
): {
  columnWidths: number[];
  visibleCols: number[];
  repeatColIndices: number[];
} {
  const bounds = sheet.bounds;
  const hasData = bounds.top > 0 && bounds.left > 0;

  if (!hasData) {
    return { columnWidths: [], visibleCols: [], repeatColIndices: [] };
  }

  const startCol = printRange?.startCol ?? bounds.left;
  const endCol = printRange?.endCol ?? bounds.right;
  const columnWidths: number[] = [];
  const visibleCols: number[] = [];
  const emitted = new Set<number>();

  const push = (c: number) => {
    if (emitted.has(c)) {
      return;
    }
    const col = sheet.columns.get(c);
    if (col?.hidden) {
      return;
    }
    emitted.add(c);
    const excelWidth = col?.width ?? DEFAULT_COLUMN_WIDTH;
    const pixelWidth = charWidthToPixel(excelWidth, MAX_DIGIT_WIDTH_PX);
    const pointWidth = Math.max(pixelWidth * PX_TO_PT, MIN_COLUMN_WIDTH);
    columnWidths.push(pointWidth);
    visibleCols.push(c);
  };

  // Print titles are independent of the print area, so a band that is not
  // fully inside it must be emitted first: it prints down the left of every
  // page. A band wholly inside keeps the sheet's natural order, so the first
  // page is not reshuffled — only later pages get the repeated prefix.
  const titleFullyInside = titleBand && titleBand.first >= startCol && titleBand.last <= endCol;
  if (titleBand && !titleFullyInside) {
    for (let c = titleBand.first; c <= titleBand.last; c++) {
      push(c);
    }
  }

  for (let c = startCol; c <= endCol; c++) {
    push(c);
  }

  const repeatColIndices = titleBand
    ? visibleCols.flatMap((c, i) => (c >= titleBand.first && c <= titleBand.last ? [i] : []))
    : [];

  return { columnWidths, visibleCols, repeatColIndices };
}

// =============================================================================
// Row Height Computation
// =============================================================================

/**
 * Measure every printable row at 100% scale.
 *
 * Heights are deliberately unscaled: `countWrapLines` derives the wrapped line
 * count from ratios that are independent of the print scale, so a scaled height
 * is exactly `unscaled * scale`. Measuring once and multiplying avoids re-running
 * the most expensive step of layout for every probe of the fit solver.
 */
function computeRowHeights(
  sheet: PdfSheetData,
  printRange: PrintRange | null,
  fontManager: FontManager,
  options: ResolvedPdfOptions,
  titleBand?: PdfRepeatBand | false
): { rowHeights: number[]; visibleRows: number[]; repeatRowIndices: number[] } {
  const bounds = sheet.bounds;
  if (bounds.top <= 0) {
    return { rowHeights: [], visibleRows: [], repeatRowIndices: [] };
  }

  const startRow = printRange?.startRow ?? bounds.top;
  const endRow = printRange?.endRow ?? bounds.bottom;
  const rowHeights: number[] = [];
  const visibleRows: number[] = [];
  const emitted = new Set<number>();

  const push = (r: number) => {
    if (emitted.has(r)) {
      return;
    }
    const row = sheet.rows.get(r);
    if (row?.hidden) {
      return;
    }
    emitted.add(r);

    let height: number;
    if (row?.height && row.customHeight) {
      // Custom height explicitly set by user — use as-is
      height = row.height;
    } else if (row?.height) {
      // Excel auto-calculated height — use it as a baseline, but ensure
      // the row is tall enough for wrapped text.  The stored height may be
      // stale when columns are narrower in the PDF layout or when the PDF
      // uses different font metrics than the original Excel file.
      height = Math.max(row.height, autoRowHeight(row, sheet, fontManager, options));
    } else {
      // No height info: auto-size based on cell content
      height = autoRowHeight(row, sheet, fontManager, options);
    }

    rowHeights.push(height);
    visibleRows.push(r);
  };

  // Mirrors `computeColumnWidths`: a title band not fully inside the print area
  // leads, otherwise the sheet's natural row order is preserved.
  const titleFullyInside = titleBand && titleBand.first >= startRow && titleBand.last <= endRow;
  if (titleBand && !titleFullyInside) {
    for (let r = titleBand.first; r <= titleBand.last; r++) {
      push(r);
    }
  }

  for (let r = startRow; r <= endRow; r++) {
    push(r);
  }

  const repeatRowIndices = titleBand
    ? visibleRows.flatMap((r, i) => (r >= titleBand.first && r <= titleBand.last ? [i] : []))
    : [];

  return { rowHeights, visibleRows, repeatRowIndices };
}

/**
 * Compute the minimum row height required to display wrapped cell content.
 * Returns at least `DEFAULT_ROW_HEIGHT`.
 */
function autoRowHeight(
  row: PdfRowData | undefined,
  sheet: PdfSheetData,
  fontManager: FontManager,
  options: ResolvedPdfOptions
): number {
  let height = DEFAULT_ROW_HEIGHT;
  if (row) {
    for (const cell of row.cells.values()) {
      const fontSize = getCellFontSize(cell);
      const wrapLineCount = countWrapLines(cell, fontSize, sheet, fontManager, options);
      // Measured once: both the first line's box and, for rich text, every
      // subsequent line's box are derived from the same ink height.
      const inkHeight = cellFirstLineInkHeight(cell, fontSize, fontManager, options);
      // The positioned rich-text renderer lets a line grow beyond 1.2em when
      // one of its runs uses a face with taller ink. The estimator does not
      // retain each wrapped line's ranges, so reserve the largest possible line
      // box for every line; conservative height is preferable to clipping the
      // final line, and ordinary faces still resolve to the same 1.2em.
      const lineHeight =
        cell.type === PdfCellType.RichText
          ? Math.max(fontSize * LINE_HEIGHT_FACTOR, inkHeight)
          : fontSize * LINE_HEIGHT_FACTOR;
      // Account for border width: half of each border extends inward
      const borderTop = cell.style?.border?.top?.style
        ? borderStyleToLineWidth(cell.style.border.top.style) / 2
        : 0;
      const borderBottom = cell.style?.border?.bottom?.style
        ? borderStyleToLineWidth(cell.style.border.bottom.style) / 2
        : 0;
      const neededHeight =
        Math.max(fontSize, inkHeight) +
        (wrapLineCount - 1) * lineHeight +
        (CELL_PADDING_V + borderTop + borderBottom) * 2;
      if (neededHeight > height) {
        height = neededHeight;
      }
    }
  }
  return height;
}

/**
 * Ink height of the tallest face in a cell (`ascent - descent`).
 *
 * The renderer places a line by its ink box, so a face whose ink is taller than
 * its em square needs more room than `fontSize`: give it less and
 * `computeTextStartY` clamps the block against the top inset, which pushes
 * bottom-aligned descenders through the bottom border — the same asymmetry seen
 * from the other side. Callers pair this with `fontSize` as a floor, because
 * every standard Type1 face has a shorter ink box than that (Helvetica
 * 0.925 em) and shrinking those rows below the height Excel gives them would be
 * a regression in the common case.
 */
function cellFirstLineInkHeight(
  cell: PdfCellData,
  fontSize: number,
  fontManager: FontManager,
  options: ResolvedPdfOptions
): number {
  let ascent = 0;
  let descent = 0;
  // Measured across the whole cell rather than per line: the row only has to be
  // tall enough, and the extents of a single line can never exceed these.
  for (const face of cellFaces(cell, fontSize, options)) {
    const metrics = fontManager.measureTextMetrics(
      face.text,
      fontManager.resolveFont(face.fontFamily, face.bold, face.italic),
      face.fontSize
    );
    ascent = Math.max(ascent, metrics.ascent);
    descent = Math.min(descent, metrics.descent);
  }
  return ascent - descent;
}

/**
 * Every face that draws part of a cell, with the size it draws at. A plain cell
 * has one; a rich text cell has one per run, inheriting the cell font for the
 * slots a run leaves unset.
 */
function cellFaces(
  cell: PdfCellData,
  fontSize: number,
  options: ResolvedPdfOptions
): Array<{ text: string; fontFamily: string; fontSize: number; bold: boolean; italic: boolean }> {
  const cellFont = cell.style?.font;
  if (cell.type === PdfCellType.RichText) {
    const value = cell.value;
    if (value && typeof value === "object" && "richText" in value) {
      const runs = (value as { richText: PdfRichTextRunData[] }).richText;
      if (runs.length > 0) {
        return runs.map(run => ({
          text: run.text,
          ...extractFontProperties(
            run.font
              ? {
                  name: run.font.name ?? cellFont?.name,
                  size: run.font.size ?? cellFont?.size,
                  bold: run.font.bold ?? false,
                  italic: run.font.italic ?? false
                }
              : cellFont,
            options.defaultFontFamily,
            options.defaultFontSize
          )
        }));
      }
    }
  }
  const props = extractFontProperties(cellFont, options.defaultFontFamily, options.defaultFontSize);
  // `fontSize` already carries the largest size in the cell, scale included.
  return [
    {
      text: typeof cell.text === "string" ? cell.text : String(cell.text ?? ""),
      ...props,
      fontSize
    }
  ];
}

/**
 * Get the largest font size for a cell, checking rich text runs.
 */
function getCellFontSize(cell: PdfCellData): number {
  let fontSize = cell.style?.font?.size ?? 11;

  if (cell.type === PdfCellType.RichText) {
    const value = cell.value;
    if (value && typeof value === "object" && "richText" in value) {
      const runs = (value as { richText: PdfRichTextRunData[] }).richText;
      for (const run of runs) {
        const runSize = run.font?.size ?? fontSize;
        if (runSize > fontSize) {
          fontSize = runSize;
        }
      }
    }
  }

  return fontSize;
}

/**
 * Count the wrap-line count for a cell, using actual font measurements
 * so row heights match the page renderer exactly.
 */
function countWrapLines(
  cell: PdfCellData,
  fontSize: number,
  sheet: PdfSheetData,
  fontManager: FontManager,
  options: ResolvedPdfOptions
): number {
  const text = typeof cell.text === "string" ? cell.text : String(cell.text ?? "");
  const lineCount = Math.max(1, (text.match(/\n/g) ?? []).length + 1);

  if (!cell.style?.alignment?.wrapText || text.length === 0) {
    return lineCount;
  }

  const col = sheet.columns.get(cell.col);
  const colWidth = col?.width ?? DEFAULT_COLUMN_WIDTH;
  const colPts = charWidthToPixel(colWidth, MAX_DIGIT_WIDTH_PX) * PX_TO_PT;
  const indent = cell.style.alignment.indent ?? 0;
  const borderLeft = cell.style?.border?.left?.style
    ? borderStyleToLineWidth(cell.style.border.left.style) / 2
    : 0;
  const borderRight = cell.style?.border?.right?.style
    ? borderStyleToLineWidth(cell.style.border.right.style) / 2
    : 0;
  // Width, padding and font size are all unscaled here, which is what makes the
  // wrapped line count independent of the print scale.
  const padding =
    CELL_PADDING_H + borderLeft + (CELL_PADDING_H + borderRight) + indent * INDENT_WIDTH;
  const effectiveWidth = Math.max(colPts - padding, 1);

  // For rich text cells, use per-run font size measurement to match rendering
  if (cell.type === PdfCellType.RichText) {
    const value = cell.value;
    if (value && typeof value === "object" && "richText" in value) {
      const runs = (value as { richText: PdfRichTextRunData[] }).richText;
      if (runs.length > 0) {
        const wrappedCount = _countRichTextWrapLines(
          text,
          runs,
          effectiveWidth,
          fontManager,
          options,
          cell.style?.font
        );
        return Math.max(lineCount, wrappedCount);
      }
    }
  }

  const fontProps = extractFontProperties(
    cell.style.font,
    options.defaultFontFamily,
    options.defaultFontSize
  );
  const resourceName = fontManager.resolveFont(
    fontProps.fontFamily,
    fontProps.bold,
    fontProps.italic
  );
  const measure = (s: string) => fontManager.measureText(s, resourceName, fontSize);
  const wrappedLines = wrapTextLines(text, measure, effectiveWidth);

  return Math.max(lineCount, wrappedLines.length);
}

/**
 * Count wrap lines for a rich text cell using per-run font sizes.
 * This mirrors the logic in wrapRichTextLines (page-renderer) so that
 * the row height calculation matches the actual rendering.
 */
/**
 * The number of lines a rich-text cell wraps to.
 *
 * Exported so the reserve-equals-draw invariant can be asserted directly: this must
 * equal `wrapRichTextLines(...).length` for the same inputs, and it used to be a
 * second transcription of that function rather than a call to it.
 *
 * @internal
 */
export function _countRichTextWrapLines(
  text: string,
  runs: PdfRichTextRunData[],
  effectiveWidth: number,
  fontManager: FontManager,
  options: ResolvedPdfOptions,
  cellFont?: Partial<PdfFontStyle>
): number {
  // Use cell-level font as fallback for runs without their own font
  const defaultFamily = cellFont?.name ?? options.defaultFontFamily;
  const defaultSize = cellFont?.size ?? options.defaultFontSize;

  // Build character-to-run mapping
  const runForChar: number[] = [];
  for (let ri = 0; ri < runs.length; ri++) {
    for (let ci = 0; ci < runs[ri].text.length; ci++) {
      runForChar.push(ri);
    }
  }

  // Resolve font resources for each run (with cell font inheritance)
  const runResources: string[] = runs.map(run => {
    const effectiveRunFont: Partial<PdfFontStyle> | undefined = run.font
      ? {
          name: run.font.name ?? cellFont?.name,
          size: run.font.size ?? cellFont?.size,
          bold: run.font.bold ?? false,
          italic: run.font.italic ?? false,
          strike: run.font.strike ?? false,
          underline: run.font.underline ?? undefined,
          color: run.font.color ?? cellFont?.color
        }
      : cellFont;
    const fontProps = extractFontProperties(effectiveRunFont, defaultFamily, defaultSize);
    return fontManager.resolveFont(fontProps.fontFamily, fontProps.bold, fontProps.italic);
  });

  // Resolve scaled font sizes for each run
  const runFontSizes: number[] = runs.map(run => {
    const effectiveRunFont: Partial<PdfFontStyle> | undefined = run.font
      ? {
          name: run.font.name ?? cellFont?.name,
          size: run.font.size ?? cellFont?.size,
          bold: run.font.bold ?? false,
          italic: run.font.italic ?? false
        }
      : cellFont;
    const fontProps = extractFontProperties(effectiveRunFont, defaultFamily, defaultSize);
    return fontProps.fontSize;
  });

  // The renderer's own wrapping, so the reserved line count *is* the drawn line
  // count. This was a second transcription of it, and the two disagreed: the copy
  // here compared `measureRange(lineStart, wordEnd)` against the width while the
  // renderer accumulated per appended word, which charged a paragraph's leading
  // whitespace to the first line in one and not the other. Before that, only the
  // renderer had been updated for East Asian breaking, so a Chinese cell reserved
  // one line and drew six.
  return Math.max(
    1,
    wrapRichTextLines(text, runForChar, runFontSizes, runResources, fontManager, effectiveWidth)
      .length
  );
}

// =============================================================================
// Row Breaks
// =============================================================================

/**
 * Translate manual break positions from sheet track numbers into indices of the
 * printed track list.
 *
 * A break sits *after* its track, so the following index starts a new page.
 * Shared by both axes; computed once per sheet because the fit solver paginates
 * many times and must not rebuild the lookup on every probe.
 */
function buildBreakSet(breakTracks: number[], visibleTracks: number[]): Set<number> {
  const breaks = new Set<number>();
  if (breakTracks.length === 0) {
    return breaks;
  }
  const trackToIndex = new Map<number, number>();
  for (let i = 0; i < visibleTracks.length; i++) {
    trackToIndex.set(visibleTracks[i], i);
  }
  for (const track of breakTracks) {
    const index = trackToIndex.get(track);
    if (index !== undefined) {
      breaks.add(index + 1);
    }
  }
  return breaks;
}

// =============================================================================
// Merge Map
// =============================================================================

interface MergeInfo {
  isMaster: boolean;
  rowSpan: number;
  colSpan: number;
}

/**
 * Build a map of all merged cell regions.
 * Key: "row:col" (1-based), Value: merge info
 */
function buildMergeMap(sheet: PdfSheetData): Map<string, MergeInfo> {
  const map = new Map<string, MergeInfo>();

  const merges = sheet.merges;
  if (!merges || merges.length === 0) {
    return map;
  }

  for (const rangeStr of merges) {
    const range = parseRangeRef(rangeStr);
    const top = range.s.r + 1;
    const left = range.s.c + 1;
    const bottom = range.e.r + 1;
    const right = range.e.c + 1;

    const rowSpan = bottom - top + 1;
    const colSpan = right - left + 1;

    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        map.set(`${r}:${c}`, {
          isMaster: r === top && c === left,
          rowSpan,
          colSpan
        });
      }
    }
  }

  return map;
}

// =============================================================================
// Pagination
// =============================================================================

/**
 * Split a track list (rows or columns) into pages.
 *
 * One implementation serves both axes: heights against the available page
 * height, widths against the content width. The axes differ only in the overflow
 * tolerance, so `epsilon` is the sole parameter that distinguishes them —
 * columns need a small slack because scaled point widths accumulate rounding.
 *
 * `repeatIndices` are the tracks of a print-title band. They are re-emitted at
 * the start of every page after the first, which is why they are absolute
 * indices rather than a count: a band may sit in the middle of the printed range
 * (Excel allows `printTitlesColumn = "C:D"`).
 *
 * Manual breaks are honoured via `breaks`, holding the index that must start a
 * new page.
 */
function paginateTracks(
  sizes: number[],
  available: number,
  repeatIndices: number[],
  breaks: Set<number>,
  epsilon = 0
): number[][] {
  if (sizes.length === 0) {
    return [[]];
  }

  const pages: number[][] = [];
  let current: number[] = [];
  let used = 0;
  let isFirstPage = true;
  let repeatedPrefixCount = 0;
  const repeatSet = new Set(repeatIndices);

  const addRepeats = () => {
    repeatedPrefixCount = 0;
    for (const index of repeatIndices) {
      if (index >= sizes.length) {
        continue;
      }
      if (used + sizes[index] > available + epsilon && current.length > 0) {
        break;
      }
      current.push(index);
      used += sizes[index];
      repeatedPrefixCount++;
    }
  };

  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    // A manual break at `i` must fire at most once. Without this latch the break
    // stays true after the repeated title tracks are re-added, so the loop keeps
    // flushing title-only pages forever (heap exhaustion).
    let breakConsumed = false;

    for (;;) {
      const forceBreak = !breakConsumed && breaks.has(i) && current.length > 0;
      if ((forceBreak || used + size > available + epsilon) && current.length > 0) {
        if (forceBreak) {
          breakConsumed = true;
        }
        // Never emit a page holding nothing but the repeated prefix.
        if (!forceBreak && !isFirstPage && current.length === repeatedPrefixCount) {
          current = [];
          used = 0;
          repeatedPrefixCount = 0;
          continue;
        }
        pages.push(current);
        current = [];
        used = 0;
        repeatedPrefixCount = 0;
        isFirstPage = false;
        addRepeats();
        continue;
      }

      if (isFirstPage || !repeatSet.has(i) || !current.includes(i)) {
        current.push(i);
        used += size;
      }
      break;
    }
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

/**
 * Row pagination. Thin wrapper over {@link paginateTracks} that also accepts a
 * plain count, which reads better in the focused unit tests.
 */
export function paginateRows(
  rowHeights: number[],
  availableHeight: number,
  repeatRows: number | number[],
  rowBreaks: Set<number>
): number[][] {
  const repeatIndices = Array.isArray(repeatRows)
    ? repeatRows
    : Array.from({ length: Math.max(0, repeatRows) }, (_, i) => i);
  return paginateTracks(rowHeights, availableHeight, repeatIndices, rowBreaks);
}

// =============================================================================
// Cell Layout
// =============================================================================

function buildLayoutCell(
  cell: PdfCellData | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  colSpan: number,
  rowSpan: number,
  options: ResolvedPdfOptions,
  fontManager: FontManager,
  scaleFactor: number
): LayoutCell {
  const text = resolveErrorText(cell, options.errors);
  const style: Partial<PdfCellStyle> = cell?.style ?? {};

  const fontProps = extractFontProperties(
    style.font,
    options.defaultFontFamily,
    options.defaultFontSize
  );

  // Scale font size proportionally when fitToPage shrinks the layout
  const scaledFontSize = fontProps.fontSize * scaleFactor;

  const resourceName = fontManager.resolveFont(
    fontProps.fontFamily,
    fontProps.bold,
    fontProps.italic
  );
  fontManager.trackText(text, resourceName);

  // Rich text runs — pass cell-level font as the fallback for runs without
  // their own font definition (e.g. the first run often has no font object
  // and should inherit the cell's style font including bold/italic).
  const richText = buildRichTextRuns(cell, options, fontManager, scaleFactor, style.font);

  const rawBorders = excelBordersToPdf(style.border);
  const borders = options.blackAndWhite ? grayscaleBorders(rawBorders) : rawBorders;
  const rawFill = excelFillToPdfColor(style.fill);

  return {
    text,
    rect: { x, y, width, height },
    fontFamily: fontProps.fontFamily,
    fontSize: scaledFontSize,
    bold: fontProps.bold,
    italic: fontProps.italic,
    strike: fontProps.strike,
    underline: fontProps.underline,
    textColor: options.blackAndWhite ? toGrayscale(fontProps.textColor) : fontProps.textColor,
    fillColor: options.blackAndWhite && rawFill !== null ? toGrayscale(rawFill) : rawFill,
    horizontalAlign: resolveHorizontalAlign(style.alignment, cell?.type, cell?.result),
    verticalAlign: excelVAlignToPdf(style.alignment),
    wrapText: style.alignment?.wrapText ?? false,
    borders,
    borderInsets: {
      top: (borders.top?.width ?? 0) / 2,
      right: (borders.right?.width ?? 0) / 2,
      bottom: (borders.bottom?.width ?? 0) / 2,
      left: (borders.left?.width ?? 0) / 2
    },
    colSpan,
    rowSpan,
    hyperlink: cell?.hyperlink ?? null,
    richText,
    indent: style.alignment?.indent ?? 0,
    textRotation:
      style.alignment?.textRotation === 255 ? "vertical" : (style.alignment?.textRotation ?? 0),
    textOverflowWidth: 0
  };
}

// =============================================================================
// Shared-Edge Border Resolution
// =============================================================================

/**
 * Border precedence weight.
 *
 * When two adjacent cells both declare a border on a shared edge the winning
 * border is chosen by:  1. thicker wins,  2. solid beats dashed,
 * 3. double beats single,  4. darker colour wins (tie-break).
 *
 * Returns a numeric score – higher score wins.
 */
export function borderPrecedence(b: LayoutBorder): number {
  let score = b.width * 1000; // width dominates
  if (b.dashPattern.length === 0) {
    score += 100; // solid beats dashed
  }
  if (b.isDouble) {
    score += 50; // double beats single
  }
  // Darker colour = lower sum of RGB → higher score
  const brightness = b.color.r + b.color.g + b.color.b;
  score += (3 - brightness) * 10; // max RGB sum = 3 → adds up to 30
  return score;
}

/**
 * Resolve shared borders between adjacent cells.
 *
 * For each shared edge, determine the winning border (by precedence), then:
 * - The cell that "owns" the winning border keeps it in `borders` for drawing.
 * - The losing cell has that border side set to `null` (it won't draw).
 * - Both cells' `borderInsets` are updated to reflect the winning border's
 *   half-width, so text padding accounts for the line that is actually there.
 */
export function resolveSharedBorders(
  cellGrid: Map<string, LayoutCell>,
  rowCount: number,
  colCount: number
): void {
  for (let ri = 0; ri < rowCount; ri++) {
    for (let gci = 0; gci < colCount; gci++) {
      const cell = cellGrid.get(`${ri}:${gci}`);
      if (!cell) {
        continue;
      }

      // Horizontal shared edge: this cell's right border vs right neighbour's left
      if (cell.borders.right) {
        const rightNeighbor = cellGrid.get(`${ri}:${gci + 1}`);
        if (rightNeighbor?.borders.left) {
          const myScore = borderPrecedence(cell.borders.right);
          const theirScore = borderPrecedence(rightNeighbor.borders.left);
          if (theirScore > myScore) {
            // Neighbour wins — this cell stops drawing, but its inset = winner's half-width
            cell.borderInsets.right = rightNeighbor.borders.left.width / 2;
            cell.borders.right = null;
          } else {
            // This cell wins (or tie) — neighbour stops drawing
            rightNeighbor.borderInsets.left = cell.borders.right.width / 2;
            rightNeighbor.borders.left = null;
          }
        }
      }

      // Vertical shared edge: this cell's bottom border vs below neighbour's top
      if (cell.borders.bottom) {
        const belowNeighbor = cellGrid.get(`${ri + 1}:${gci}`);
        if (belowNeighbor?.borders.top) {
          const myScore = borderPrecedence(cell.borders.bottom);
          const theirScore = borderPrecedence(belowNeighbor.borders.top);
          if (theirScore > myScore) {
            cell.borderInsets.bottom = belowNeighbor.borders.top.width / 2;
            cell.borders.bottom = null;
          } else {
            belowNeighbor.borderInsets.top = cell.borders.bottom.width / 2;
            belowNeighbor.borders.top = null;
          }
        }
      }
    }
  }
}

// =============================================================================
// Image & Chart Placement
// =============================================================================

/**
 * Resolve an anchor's page-space rectangle by combining the `tl` / `br` /
 * `ext` fields of a {@link PdfSheetImage.range} or {@link PdfSheetChart.range}.
 *
 * The convention is identical for both object types:
 *  - `tl` locates the upper-left corner in sheet coordinates (`nativeCol`,
 *    `nativeRow`, + sub-cell offsets in EMU).
 *  - `br` — when present — locates the opposite corner, so the rect size is
 *    the difference.
 *  - `ext` — when present — overrides the size directly. Images use pixels
 *    (px × 0.75 = pt); charts use EMU (EMU / 12700 = pt). The `extUnit`
 *    field disambiguates. Historical callers that omit `extUnit` keep
 *    the legacy px behaviour.
 *
 * Returns `null` if the anchor does not land on any of the supplied
 * pages (e.g. the object is anchored below the printed area).
 */
function resolveAnchorRect(
  range: PdfSheetImage["range"],
  layoutPages: LayoutPage[],
  scaleFactor: number
): { page: LayoutPage; x: number; y: number; width: number; height: number } | null {
  const tl = range.tl;
  const tlCol = (tl.nativeCol ?? tl.col ?? 0) + 1; // 0-indexed → 1-indexed
  const tlRow = (tl.nativeRow ?? tl.row ?? 0) + 1;

  const targetPage = layoutPages.find(
    page => page.sheetCols.includes(tlCol) && page.sheetRows.includes(tlRow)
  );
  if (!targetPage) {
    return null;
  }

  const pageColIndex = targetPage.sheetCols.indexOf(tlCol);
  const pageRowIndex = targetPage.sheetRows.indexOf(tlRow);
  const baseX = targetPage.columnOffsets[pageColIndex] ?? targetPage.options.margins.left;
  const baseY =
    targetPage.rowYPositions[pageRowIndex] ??
    targetPage.height -
      targetPage.options.margins.top -
      (targetPage.options.showSheetNames ? SHEET_NAME_BAND_HEIGHT : 0);

  // Apply sub-cell offsets, scaled to match page layout.
  const tlColOff = (emuToPt(tl.nativeColOff ?? 0) || 0) * scaleFactor;
  const tlRowOff = (emuToPt(tl.nativeRowOff ?? 0) || 0) * scaleFactor;
  const x = baseX + tlColOff;
  const yTop = baseY - tlRowOff;

  // Determine width / height
  let width = 100;
  let height = 100;
  const extUnit = range.extUnit ?? "px";
  if (range.ext) {
    if (extUnit === "emu") {
      // EMU → pt (÷12700). Using the px factor (÷9525) here rendered every
      // EMU-sized chart 4/3 too large: a 4in chart came out 384pt instead of
      // 288pt, overflowing the content area and skewing its aspect ratio.
      width = emuToPt(range.ext.width) * scaleFactor;
      height = emuToPt(range.ext.height) * scaleFactor;
    } else {
      // Legacy pixel → pt (0.75 factor = 72/96 dpi)
      width = range.ext.width * 0.75 * scaleFactor;
      height = range.ext.height * 0.75 * scaleFactor;
    }
  } else if (range.br) {
    const br = range.br;
    const brCol = (br.nativeCol ?? br.col ?? 0) + 1;
    const brRow = (br.nativeRow ?? br.row ?? 0) + 1;
    const brPageColIndex = targetPage.sheetCols.indexOf(brCol);
    const brPageRowIndex = targetPage.sheetRows.indexOf(brRow);
    let brBaseX: number;
    let brBaseY: number;
    if (brPageColIndex >= 0) {
      brBaseX = targetPage.columnOffsets[brPageColIndex];
    } else {
      // br column is beyond this page — sum column widths from tl
      // through the last page column, then extrapolate remaining cols
      // at the average page column width so the chart stretches to its
      // intended width even when the page doesn't extend far enough.
      const lastCI = targetPage.sheetCols.length - 1;
      const lastPageCol = targetPage.sheetCols[lastCI] ?? tlCol;
      // End of the last column on this page:
      const lastColEnd =
        lastCI >= 0
          ? targetPage.columnOffsets[lastCI] + (targetPage.columnWidths[lastCI] ?? 0)
          : baseX;
      if (brCol <= lastPageCol) {
        // brCol should be on this page but indexOf missed — use end of
        // the closest column as a fallback.
        brBaseX = lastColEnd;
      } else {
        const avgColWidth =
          targetPage.columnWidths.length > 0
            ? targetPage.columnWidths.reduce((s, w) => s + w, 0) / targetPage.columnWidths.length
            : 48;
        const extraCols = brCol - lastPageCol;
        brBaseX = lastColEnd + extraCols * avgColWidth;
      }
    }
    if (brPageRowIndex >= 0) {
      brBaseY = targetPage.rowYPositions[brPageRowIndex];
    } else {
      // br row is beyond this page — accumulate row heights from tl
      // downward to compute the real chart height. In PDF coords,
      // rows stack downward (decreasing y). `baseY` (= yTop before
      // offsets) is the PDF y of the top of `tlRow`. Each subsequent
      // row's top y = previous row's top y - that row's height.
      const lastRI = targetPage.sheetRows.length - 1;
      const lastPageRow = targetPage.sheetRows[lastRI] ?? tlRow;
      if (brRow <= lastPageRow) {
        // brRow is on this page — sum heights from tl up to br.
        let accH = 0;
        for (let ri = pageRowIndex; ri <= lastRI; ri++) {
          if (targetPage.sheetRows[ri] >= brRow) {
            break;
          }
          accH += targetPage.rowHeights[ri] ?? 0;
        }
        brBaseY = baseY - accH;
      } else {
        // brRow exceeds the page — sum all rows from tl to end of page,
        // then extrapolate remaining rows at default height.
        let accH = 0;
        for (let ri = pageRowIndex; ri <= lastRI; ri++) {
          accH += targetPage.rowHeights[ri] ?? 0;
        }
        const remainingRows = brRow - lastPageRow - 1;
        accH += remainingRows * (15 * scaleFactor);
        brBaseY = baseY - accH;
      }
    }
    const brColOff = ((br.nativeColOff ?? 0) / 12700 || 0) * scaleFactor;
    const brRowOff = ((br.nativeRowOff ?? 0) / 12700 || 0) * scaleFactor;
    const brX = brBaseX + brColOff;
    const brYTop = brBaseY - brRowOff;
    width = brX - x;
    height = yTop - brYTop;
  }

  // Normalise to bottom-left y (PDF origin is bottom-left).
  // Clamp width to the page's content area; for height, if the chart's
  // anchor extends well below the page boundary (less than 50% of the
  // chart fits on this page), skip it entirely — drawing a severely
  // clipped chart is worse than omitting it. Otherwise keep the full
  // computed height so the chart renders at the correct aspect ratio
  // even if it slightly overflows the page bottom.
  const contentRight = targetPage.width - targetPage.options.margins.right;
  const contentBottom = targetPage.options.margins.bottom;
  const absWidth = Math.min(Math.abs(width), Math.max(0, contentRight - x));
  const absHeight = Math.abs(height);
  const availableHeight = Math.max(0, yTop - contentBottom);
  if (absHeight > 0 && availableHeight < absHeight * 0.5) {
    // Less than half the chart fits on this page — skip it.
    return null;
  }
  return {
    page: targetPage,
    x,
    y: yTop - absHeight,
    width: absWidth,
    height: absHeight
  };
}

/**
 * Assign pre-collected images to the pages that contain their top-left anchor.
 */
function assignImagesToPages(
  images: PdfSheetImage[],
  layoutPages: LayoutPage[],
  scaleFactor: number
): void {
  for (const img of images) {
    const placement = resolveAnchorRect(img.range, layoutPages, scaleFactor);
    if (!placement) {
      continue;
    }
    placement.page.images.push({
      data: img.data,
      format: img.format,
      rect: {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height
      }
    });
  }
}

/**
 * Assign pre-collected charts to the pages that contain their top-left
 * anchor. When a chart's anchor doesn't fit on any page (e.g. it spans
 * most of its height below the page boundary), place it full-page on
 * the next available page so it's not lost entirely.
 */
function assignChartsToPages(
  charts: PdfSheetChart[],
  layoutPages: LayoutPage[],
  scaleFactor: number
): void {
  for (const chart of charts) {
    const placement = resolveAnchorRect(chart.range, layoutPages, scaleFactor);
    if (placement) {
      placement.page.charts.push({
        rect: {
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height
        },
        drawVector: chart.drawVector,
        raster: chart.raster
      });
      continue;
    }
    // Chart didn't fit — find the page whose rows are closest to the
    // chart's tl row and place it full-content-area on that page (or
    // the next one if it exists). This handles charts whose tl anchor
    // is near a page break: rather than clipping them to a sliver, we
    // push them onto the following page at full size.
    const tl = chart.range.tl;
    const tlCol = (tl.nativeCol ?? tl.col ?? 0) + 1;
    const tlRow = (tl.nativeRow ?? tl.row ?? 0) + 1;

    // Restrict the search to the column band that holds the anchor, then walk
    // it in row order. Filtering before stepping keeps the result independent
    // of `pageOrder`: that setting decides the array order, but "the next page
    // down" is always the next row band within the same column band.
    const band = layoutPages.filter(page => page.sheetCols.includes(tlCol));
    const ordered = (band.length > 0 ? band : [...layoutPages]).sort(
      (a, b) => (a.sheetRows[0] ?? 0) - (b.sheetRows[0] ?? 0)
    );

    let targetPage: LayoutPage | undefined;
    for (let pi = 0; pi < ordered.length; pi++) {
      const page = ordered[pi];
      const lastPageRow = page.sheetRows[page.sheetRows.length - 1] ?? 0;
      if (lastPageRow >= tlRow - 1 && pi + 1 < ordered.length) {
        targetPage = ordered[pi + 1];
        break;
      }
      if (lastPageRow >= tlRow) {
        targetPage = page;
        break;
      }
    }
    if (!targetPage) {
      targetPage = ordered[ordered.length - 1];
    }
    if (targetPage) {
      const margins = targetPage.options.margins;
      const headerH = targetPage.options.showSheetNames ? SHEET_NAME_BAND_HEIGHT : 0;
      const contentX = margins.left;
      const contentY = margins.bottom;
      const contentW = targetPage.width - margins.left - margins.right;
      const contentH = targetPage.height - margins.top - margins.bottom - headerH;
      targetPage.charts.push({
        rect: { x: contentX, y: contentY, width: contentW, height: contentH },
        drawVector: chart.drawVector,
        raster: chart.raster
      });
    }
  }
}

// =============================================================================
// Merge Border Propagation
// =============================================================================

/**
 * Excel stores merged-cell borders on the boundary cells, not on the master.
 * Copy the right border from the rightmost column cell and the bottom border
 * from the bottom row cell so the layout cell renders them correctly.
 */
function propagateMergeBorders(
  layoutCell: LayoutCell,
  mergeInfo: MergeInfo,
  wsRowNumber: number,
  wsColNumber: number,
  sheet: PdfSheetData
): void {
  if (mergeInfo.colSpan > 1) {
    const rightCol = wsColNumber + mergeInfo.colSpan - 1;
    const rightCellData = sheet.rows.get(wsRowNumber)?.cells.get(rightCol);
    if (rightCellData?.style?.border?.right) {
      const converted = excelBordersToPdf({ right: rightCellData.style.border.right });
      if (converted.right) {
        layoutCell.borders.right = converted.right;
        layoutCell.borderInsets.right = converted.right.width / 2;
      }
    }
  }
  if (mergeInfo.rowSpan > 1) {
    const bottomRowNum = wsRowNumber + mergeInfo.rowSpan - 1;
    const bottomCellData = sheet.rows.get(bottomRowNum)?.cells.get(wsColNumber);
    if (bottomCellData?.style?.border?.bottom) {
      const converted = excelBordersToPdf({ bottom: bottomCellData.style.border.bottom });
      if (converted.bottom) {
        layoutCell.borders.bottom = converted.bottom;
        layoutCell.borderInsets.bottom = converted.bottom.width / 2;
      }
    }
  }
}

// =============================================================================
// Text Overflow Calculation
// =============================================================================

/**
 * In Excel, non-wrapped text overflows into adjacent empty cells.
 * Fill color alone does NOT block overflow — only text content does.
 * Computes `textOverflowWidth` for cells whose text exceeds the cell width.
 */
function computeTextOverflows(
  cellGrid: Map<string, LayoutCell>,
  rowPage: number[],
  colGroup: number[],
  visibleRows: number[],
  visibleCols: number[],
  groupColWidths: number[],
  mergeMap: Map<string, MergeInfo>,
  fontManager: FontManager
): void {
  for (let ri = 0; ri < rowPage.length; ri++) {
    for (let gci = 0; gci < colGroup.length; gci++) {
      const cell = cellGrid.get(`${ri}:${gci}`);
      if (
        !cell ||
        cell.wrapText ||
        cell.colSpan > 1 ||
        (!cell.text && !cell.richText) ||
        (typeof cell.textRotation === "number" && cell.textRotation !== 0) ||
        cell.textRotation === "vertical"
      ) {
        continue;
      }

      // Measure the total text width (plain text or rich text runs)
      let textWidth: number;
      if (cell.richText) {
        textWidth = 0;
        for (const run of cell.richText) {
          const resourceName = fontManager.resolveFont(run.fontFamily, run.bold, run.italic);
          textWidth += fontManager.measureText(run.text, resourceName, run.fontSize);
        }
      } else {
        const resourceName = fontManager.resolveFont(cell.fontFamily, cell.bold, cell.italic);
        textWidth = fontManager.measureText(cell.text, resourceName, cell.fontSize);
      }

      const cellContentWidth =
        cell.rect.width -
        (CELL_PADDING_H + cell.borderInsets.left) -
        (CELL_PADDING_H + cell.borderInsets.right);

      if (textWidth <= cellContentWidth) {
        continue;
      }

      const overflowNeeded = textWidth - cellContentWidth;
      let overflowAvailable = 0;

      for (let j = gci + 1; j < colGroup.length; j++) {
        const visibleRowIdx = rowPage[ri];
        const wsRow = visibleRows[visibleRowIdx];
        const wsCol = visibleCols[colGroup[j]];

        if (mergeMap.has(`${wsRow}:${wsCol}`)) {
          break;
        }

        const neighborCell = cellGrid.get(`${ri}:${j}`);
        if (neighborCell?.text || neighborCell?.richText) {
          break;
        }

        overflowAvailable += groupColWidths[j];
        if (overflowAvailable >= overflowNeeded) {
          break;
        }
      }

      if (overflowAvailable > 0) {
        cell.textOverflowWidth = Math.min(overflowNeeded, overflowAvailable);

        // Hide internal vertical borders in the overflow region.
        // In Excel, when text overflows into adjacent empty cells, the shared
        // vertical borders between them are not drawn (the text appears to
        // span across seamlessly). We suppress:
        // - The overflowing cell's right border
        // - Each covered neighbor's left border (and right border if fully covered)
        let accumulated = 0;
        const actualOverflow = cell.textOverflowWidth;

        // Remove the source cell's right border if text overflows
        cell.borders.right = null;

        for (let j = gci + 1; j < colGroup.length; j++) {
          const neighborCell = cellGrid.get(`${ri}:${j}`);
          if (!neighborCell) {
            break;
          }

          // Remove the neighbor's left border (shared edge with previous cell)
          neighborCell.borders.left = null;

          accumulated += groupColWidths[j];
          if (accumulated >= actualOverflow) {
            break;
          }

          // If fully covered, also remove the neighbor's right border
          neighborCell.borders.right = null;
        }
      }
    }
  }
}

// =============================================================================
// Rich Text
// =============================================================================

/**
 * Build rich text runs from a RichText cell.
 * Returns null for non-RichText cells.
 */
function buildRichTextRuns(
  cell: PdfCellData | undefined,
  options: ResolvedPdfOptions,
  fontManager: FontManager,
  scaleFactor: number,
  cellFont?: Partial<PdfFontStyle>
): LayoutRichTextRun[] | null {
  if (!cell || cell.type !== PdfCellType.RichText) {
    return null;
  }

  const value = cell.value;
  if (!value || typeof value !== "object" || !("richText" in value)) {
    return null;
  }

  const runs = (value as { richText: PdfRichTextRunData[] }).richText;
  if (runs.length === 0) {
    return null;
  }

  // Use cell-level font as fallback for runs without their own font,
  // falling back to global defaults only if cell font is not available.
  const defaultFamily = cellFont?.name ?? options.defaultFontFamily;
  const defaultSize = cellFont?.size ?? options.defaultFontSize;

  return runs.map(run => {
    // When a run has no font at all, use cell font entirely.
    // When a run has its own <rPr>, properties NOT listed in that <rPr> default
    // to their base values (false/undefined), NOT to the cell font.
    // Only `name` and `size` fall back to cell font (they define the typeface/size
    // context), but stylistic flags (bold, italic, strike, underline) do not
    // inherit from the cell — an absent <b/> means "not bold".
    const effectiveFont: Partial<PdfFontStyle> | undefined = run.font
      ? {
          name: run.font.name ?? cellFont?.name,
          size: run.font.size ?? cellFont?.size,
          bold: run.font.bold ?? false,
          italic: run.font.italic ?? false,
          strike: run.font.strike ?? false,
          underline: run.font.underline ?? undefined,
          color: run.font.color ?? cellFont?.color
        }
      : cellFont;

    const fontProps = extractFontProperties(effectiveFont, defaultFamily, defaultSize);

    const resourceName = fontManager.resolveFont(
      fontProps.fontFamily,
      fontProps.bold,
      fontProps.italic
    );
    fontManager.trackText(run.text, resourceName);

    return {
      text: run.text,
      fontFamily: fontProps.fontFamily,
      fontSize: fontProps.fontSize * scaleFactor,
      bold: fontProps.bold,
      italic: fontProps.italic,
      strike: fontProps.strike,
      underline: fontProps.underline,
      textColor: options.blackAndWhite ? toGrayscale(fontProps.textColor) : fontProps.textColor
    };
  });
}

/**
 * Apply Excel's "Cell errors as" print option to a cell's display text.
 *
 * Error values reach the PDF model in two shapes: a plain error cell
 * (`PdfCellType.Error`) and a formula whose computed result is an error
 * (`PdfCellType.Formula` with an `{ error }` result). Both must be substituted.
 */
function resolveErrorText(cell: PdfCellData | undefined, mode: PdfCellErrorMode): string {
  const text = cell?.text ?? "";
  if (mode === "displayed" || !cell) {
    return text;
  }
  const isError =
    cell.type === PdfCellType.Error ||
    (cell.type === PdfCellType.Formula &&
      typeof cell.result === "object" &&
      cell.result !== null &&
      "error" in cell.result);
  if (!isError) {
    return text;
  }
  switch (mode) {
    case "blank":
      return "";
    case "dash":
      return "--";
    case "NA":
      return "#N/A";
    default:
      return text;
  }
}
