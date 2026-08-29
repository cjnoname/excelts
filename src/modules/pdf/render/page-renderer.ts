/**
 * Page renderer for PDF generation.
 *
 * Takes LayoutPage objects (produced by the layout engine) and renders them
 * as PDF content streams. Handles:
 * - Cell background fills
 * - Cell borders (with proper overlap handling)
 * - Text rendering with alignment, wrapping, and clipping
 * - Grid lines
 * - Page headers (sheet names) and footers (page numbers)
 */

import { parseImageDimensions } from "@pdf/builder/image-utils";
import { pdfNumber } from "@pdf/core/pdf-object";
import { PdfContentStream } from "@pdf/core/pdf-stream";
import type { FontManager } from "@pdf/font/font-manager";
import {
  CELL_PADDING_H,
  CELL_PADDING_V,
  LINE_HEIGHT_FACTOR,
  INDENT_WIDTH,
  HEADING_FILL,
  HEADING_RULE,
  HEADING_TEXT,
  COMMENT_FILL,
  COMMENT_BORDER,
  COMMENT_MARKER_COLOR
} from "@pdf/render/constants";
import { toGrayscale } from "@pdf/render/style-converter";
import type {
  LayoutPage,
  LayoutCell,
  LayoutBorder,
  LayoutRichTextRun,
  ResolvedPdfOptions,
  PdfRect,
  PdfTextWatermark,
  PdfImageWatermark,
  PdfWatermark,
  PdfColor,
  PdfHeaderFooterContent,
  PdfHeaderFooterRun
} from "@pdf/types";
import { countGlyphAdvances, isGlyphlessControl, segmentForWrap, wrapUnitsOf } from "@utils/cjk";
import { graphemeClusters } from "@utils/grapheme";

// =============================================================================
// Border-aware Padding
// =============================================================================

/**
 * Compute cell padding that accounts for border width.
 *
 * PDF strokes are centred on the path, so half the border width extends
 * inward into the cell.  `borderInsets` already contains the resolved
 * half-width for each side (accounting for shared-edge resolution where a
 * neighbour may draw the line but it still intrudes into this cell).
 */
interface CellPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function computeCellPadding(cell: LayoutCell, scaleFactor = 1): CellPadding {
  return {
    left: (CELL_PADDING_H + cell.borderInsets.left) * scaleFactor,
    right: (CELL_PADDING_H + cell.borderInsets.right) * scaleFactor,
    top: (CELL_PADDING_V + cell.borderInsets.top) * scaleFactor,
    bottom: (CELL_PADDING_V + cell.borderInsets.bottom) * scaleFactor
  };
}

// =============================================================================
// Page Renderer
// =============================================================================

/**
 * Result of rendering a page.
 */
export interface PageRenderResult {
  stream: PdfContentStream;
  /** Set of unique alpha values (0-1) used on this page. Empty if all opaque. */
  alphaValues: Set<number>;
}

/**
 * Render a single page to a PDF content stream.
 */
export function renderPage(
  page: LayoutPage,
  options: ResolvedPdfOptions,
  fontManager: FontManager,
  totalPages: number
): PageRenderResult {
  const stream = new PdfContentStream();
  const alphaValues = new Set<number>();

  // --- Step 1: Draw grid lines (behind everything) ---
  if (options.showGridLines) {
    drawGridLines(stream, page, options);
  }

  // --- Step 2: Draw cell backgrounds ---
  for (const cell of page.cells) {
    if (cell.fillColor) {
      drawCellFill(stream, cell, alphaValues);
    }
  }

  // --- Step 3: Erase grid lines in text overflow regions ---
  // In Excel, text overflowing into adjacent empty cells hides gridlines
  // underneath. We draw white over the overflow area before drawing borders
  // so that borders remain crisp and unaffected.
  for (const cell of page.cells) {
    if (!cell.textOverflowWidth || cell.textOverflowWidth <= 0) {
      continue;
    }
    const overflowLeft = cell.rect.x + cell.rect.width;
    const overflowRight = overflowLeft + cell.textOverflowWidth;
    const cellY = cell.rect.y;
    const cellH = cell.rect.height;

    // Find neighbor cells whose x range overlaps the overflow region and
    // are on the same row (same y and height).
    // Collect filled sub-ranges to skip.
    const filledRanges: Array<{ left: number; right: number }> = [];
    for (const other of page.cells) {
      if (other === cell || !other.fillColor) {
        continue;
      }
      // Same row check: same y position and height
      if (Math.abs(other.rect.y - cellY) > 0.01 || Math.abs(other.rect.height - cellH) > 0.01) {
        continue;
      }
      const oLeft = other.rect.x;
      const oRight = oLeft + other.rect.width;
      // Check overlap with overflow region
      if (oRight > overflowLeft && oLeft < overflowRight) {
        filledRanges.push({
          left: Math.max(oLeft, overflowLeft),
          right: Math.min(oRight, overflowRight)
        });
      }
    }

    // Draw white in unfilled portions of the overflow area
    if (filledRanges.length === 0) {
      stream.fillRect(overflowLeft, cellY, cell.textOverflowWidth, cellH, { r: 1, g: 1, b: 1 });
    } else {
      // Sort filled ranges and draw white in gaps
      filledRanges.sort((a, b) => a.left - b.left);
      let cursor = overflowLeft;
      for (const fr of filledRanges) {
        if (fr.left > cursor) {
          stream.fillRect(cursor, cellY, fr.left - cursor, cellH, { r: 1, g: 1, b: 1 });
        }
        cursor = Math.max(cursor, fr.right);
      }
      if (cursor < overflowRight) {
        stream.fillRect(cursor, cellY, overflowRight - cursor, cellH, { r: 1, g: 1, b: 1 });
      }
    }
  }

  // --- Step 4: Draw cell borders (after overflow erase so borders stay crisp) ---
  for (const cell of page.cells) {
    drawCellBorders(stream, cell);
  }

  // --- Step 5: Draw cell text ---
  const sf = page.scaleFactor;
  for (const cell of page.cells) {
    if (cell.text || cell.richText) {
      drawCellText(stream, cell, fontManager, alphaValues, sf);
    }
  }

  // --- Step 5b: Draw printed row/column headings ---
  if (options.showRowColHeaders) {
    drawRowColHeadings(stream, page, options, fontManager);
  }

  // --- Step 5c: Draw comment boxes over the grid ---
  if (page.commentBoxes?.length) {
    drawCommentBoxes(stream, page, options, fontManager);
  }

  // --- Step 5: Draw page header (sheet name) ---
  const excelHeader = selectHeaderFooter(page, "header");
  const excelFooter = selectHeaderFooter(page, "footer");
  if (excelHeader !== undefined) {
    if (excelHeader) {
      drawExcelHeaderFooter(stream, page, options, fontManager, excelHeader, "header");
    }
  } else if (options.showSheetNames) {
    drawPageHeader(stream, page, options, fontManager);
  }

  // --- Step 6: Draw page footer (page number) ---
  if (excelFooter !== undefined) {
    if (excelFooter) {
      drawExcelHeaderFooter(stream, page, options, fontManager, excelFooter, "footer");
    }
  } else if (options.showPageNumbers) {
    drawPageFooter(stream, page, options, fontManager, totalPages);
  }

  return { stream, alphaValues };
}

export function selectHeaderFooter(
  page: LayoutPage,
  kind: "header" | "footer"
): PdfHeaderFooterContent | null | undefined {
  const hf = page.headerFooter;
  if (!hf) {
    return undefined;
  }
  const suffix = kind === "header" ? "Header" : "Footer";
  if (hf.differentFirst && page.sheetPageIndex === 1) {
    return hf[`first${suffix}` as "firstHeader" | "firstFooter"] ?? null;
  }
  if (hf.differentOddEven && page.sheetPageNumber % 2 === 0) {
    return hf[`even${suffix}` as "evenHeader" | "evenFooter"] ?? null;
  }
  return hf[`odd${suffix}` as "oddHeader" | "oddFooter"];
}

export function resolveHeaderFooterRunText(run: PdfHeaderFooterRun, page: LayoutPage): string {
  if (run.text !== undefined) {
    return run.text;
  }
  switch (run.field) {
    case "pageNumber":
      return String(page.sheetPageNumber + (run.offset ?? 0));
    case "pageCount":
      return String(page.sheetPageCount);
    case "sheetName":
      return page.sheetName;
    case "fileName":
      return page.options.sourceFileName;
    case "filePath":
      return page.options.sourceFilePath;
    case "date": {
      const date = page.options.headerFooterDate;
      return formatHeaderFooterDate(date, page.options.headerFooterLocale, "date");
    }
    case "time": {
      const date = page.options.headerFooterDate;
      return formatHeaderFooterDate(date, page.options.headerFooterLocale, "time");
    }
    default:
      return "";
  }
}

function resolveHeaderFooterFontFamily(run: PdfHeaderFooterRun, page: LayoutPage): string {
  return run.fontFamily || page.options.defaultFontFamily;
}

const HEADER_FOOTER_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric"
};

const HEADER_FOOTER_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit"
};

function formatHeaderFooterDate(
  date: Date,
  locale: string | undefined,
  kind: "date" | "time"
): string {
  const options = kind === "date" ? HEADER_FOOTER_DATE_OPTIONS : HEADER_FOOTER_TIME_OPTIONS;
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // Unknown/invalid locale tag — fall back to the runtime default rather
    // than failing the whole export for one header field.
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

// =============================================================================
// Grid Lines
// =============================================================================

function drawGridLines(
  stream: PdfContentStream,
  page: LayoutPage,
  options: ResolvedPdfOptions
): void {
  if (page.columnWidths.length === 0 || page.rowHeights.length === 0) {
    return;
  }

  const color = options.gridLineColor;
  const lineWidth = 0.25;

  stream.save();
  stream.setStrokeColor(color);
  stream.setLineWidth(lineWidth);

  // Vertical grid lines
  const topY = page.rowYPositions[0];
  const lastRowIdx = page.rowYPositions.length - 1;
  const bottomY = page.rowYPositions[lastRowIdx] - page.rowHeights[lastRowIdx];

  for (let i = 0; i <= page.columnWidths.length; i++) {
    const x =
      i < page.columnWidths.length
        ? page.columnOffsets[i]
        : page.columnOffsets[i - 1] + page.columnWidths[i - 1];
    stream.moveTo(x, topY);
    stream.lineTo(x, bottomY);
  }

  // Horizontal grid lines
  const leftX = page.columnOffsets[0];
  const lastColIdx = page.columnOffsets.length - 1;
  const rightX = page.columnOffsets[lastColIdx] + page.columnWidths[lastColIdx];

  for (let i = 0; i <= page.rowYPositions.length; i++) {
    const y =
      i < page.rowYPositions.length
        ? page.rowYPositions[i]
        : page.rowYPositions[i - 1] - page.rowHeights[i - 1];
    stream.moveTo(leftX, y);
    stream.lineTo(rightX, y);
  }

  stream.stroke();
  stream.restore();
}

// =============================================================================
// Cell Fill
// =============================================================================

function drawCellFill(stream: PdfContentStream, cell: LayoutCell, alphaValues: Set<number>): void {
  if (!cell.fillColor) {
    return;
  }
  const alpha = cell.fillColor.a;
  if (alpha !== undefined && alpha < 1) {
    // Use ExtGState for transparency
    const gsName = alphaGsName(alpha);
    alphaValues.add(alpha);
    stream.save();
    stream.setGraphicsState(gsName);
    stream.fillRect(cell.rect.x, cell.rect.y, cell.rect.width, cell.rect.height, cell.fillColor);
    stream.restore();
  } else {
    stream.fillRect(cell.rect.x, cell.rect.y, cell.rect.width, cell.rect.height, cell.fillColor);
  }
}

// =============================================================================
// Rotation Helpers
// =============================================================================

/**
 * Convert Excel textRotation to standard signed degrees.
 * Excel uses 1-90 for CCW and 91-180 for CW (where 91 = -1°, 180 = -90°).
 * Returns 0 for non-numeric values (e.g. "vertical").
 */
function excelRotationToDegrees(textRotation: number | "vertical"): number {
  if (typeof textRotation !== "number") {
    return 0;
  }
  return textRotation <= 90 ? textRotation : -(textRotation - 90);
}

// =============================================================================
// Cell Borders
// =============================================================================

/**
 * Compute the horizontal slant offset for parallelogram borders.
 * For general rotation angles (not 0°/90°), Excel renders cell borders as a
 * parallelogram whose left/right edges tilt to match the text rotation angle.
 * Returns 0 for straight borders (no rotation, 90°, -90°, or vertical stacked).
 */
function computeSlantOffset(textRotation: number | "vertical", height: number): number {
  const degrees = excelRotationToDegrees(textRotation);
  if (degrees === 0) {
    return 0;
  }
  const absDeg = Math.abs(degrees);
  if (absDeg < 0.01 || absDeg > 89.99) {
    return 0;
  }
  const radians = (absDeg * Math.PI) / 180;
  const offset = (height * Math.cos(radians)) / Math.sin(radians);
  return degrees < 0 ? -offset : offset;
}

function drawCellBorders(stream: PdfContentStream, cell: LayoutCell): void {
  const { rect, borders, textRotation } = cell;
  const { x, y, width, height } = rect;

  // Compute slant for parallelogram borders on general-angle rotated cells
  const slant = computeSlantOffset(textRotation, height);

  if (borders.top) {
    drawBorderLine(stream, borders.top, x + slant, y + height, x + width + slant, y + height, true);
  }
  if (borders.bottom) {
    drawBorderLine(stream, borders.bottom, x, y, x + width, y, true);
  }
  if (borders.left) {
    drawBorderLine(stream, borders.left, x, y, x + slant, y + height, false);
  }
  if (borders.right) {
    drawBorderLine(stream, borders.right, x + width, y, x + width + slant, y + height, false);
  }
}

function drawBorderLine(
  stream: PdfContentStream,
  border: LayoutBorder,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  isHorizontal: boolean
): void {
  if (border.isDouble) {
    // Draw two parallel thin lines with a small gap between them
    const offset = 0.4;
    const thinWidth = Math.min(border.width, 0.25);
    if (isHorizontal) {
      stream.drawLine(
        x1,
        y1 + offset,
        x2,
        y2 + offset,
        border.color,
        thinWidth,
        border.dashPattern
      );
      stream.drawLine(
        x1,
        y1 - offset,
        x2,
        y2 - offset,
        border.color,
        thinWidth,
        border.dashPattern
      );
    } else {
      stream.drawLine(
        x1 + offset,
        y1,
        x2 + offset,
        y2,
        border.color,
        thinWidth,
        border.dashPattern
      );
      stream.drawLine(
        x1 - offset,
        y1,
        x2 - offset,
        y2,
        border.color,
        thinWidth,
        border.dashPattern
      );
    }
  } else {
    stream.drawLine(x1, y1, x2, y2, border.color, border.width, border.dashPattern);
  }
}

// =============================================================================
// Cell Text
// =============================================================================

function drawCellText(
  stream: PdfContentStream,
  cell: LayoutCell,
  fontManager: FontManager,
  alphaValues: Set<number>,
  scaleFactor = 1
): void {
  const { rect, text, fontSize, horizontalAlign, verticalAlign, wrapText } = cell;

  if (!text && !cell.richText) {
    return;
  }

  const pad = computeCellPadding(cell, scaleFactor);
  const availWidth = rect.width - pad.left - pad.right;
  const availHeight = rect.height - pad.top - pad.bottom;
  if (availWidth <= 0 || availHeight <= 0) {
    return;
  }

  const indentPts = cell.indent * INDENT_WIDTH * scaleFactor;

  // Clip to cell bounds (extend for text overflow into adjacent empty cells)
  // For rotated text with slanted borders, use a parallelogram clip path
  const clipWidth = rect.width + (cell.textOverflowWidth || 0);
  stream.save();

  const slantClip = computeSlantOffset(cell.textRotation, rect.height);

  if (slantClip !== 0) {
    // Parallelogram clip: bottom-left, bottom-right, top-right (shifted), top-left (shifted)
    stream.moveTo(rect.x, rect.y);
    stream.lineTo(rect.x + clipWidth, rect.y);
    stream.lineTo(rect.x + clipWidth + slantClip, rect.y + rect.height);
    stream.lineTo(rect.x + slantClip, rect.y + rect.height);
    stream.closePath();
  } else {
    stream.rect(rect.x, rect.y, clipWidth, rect.height);
  }
  stream.clip();
  stream.endPath();

  // Apply text color alpha if needed
  const textAlpha = cell.textColor.a;
  if (textAlpha !== undefined && textAlpha < 1) {
    alphaValues.add(textAlpha);
    stream.setGraphicsState(alphaGsName(textAlpha));
  }

  // Handle text rotation
  if (cell.textRotation === "vertical") {
    drawVerticalStackedText(stream, cell, fontManager, indentPts, scaleFactor);
    stream.restore();
    return;
  }
  if (typeof cell.textRotation === "number" && cell.textRotation !== 0) {
    drawRotatedText(stream, cell, fontManager, indentPts, scaleFactor);
    stream.restore();
    return;
  }

  // Handle rich text runs
  if (cell.richText && cell.richText.length > 0) {
    drawRichText(stream, cell, fontManager, indentPts, scaleFactor);
    stream.restore();
    return;
  }

  // --- Plain text rendering ---
  const resourceName = fontManager.resolveFont(cell.fontFamily, cell.bold, cell.italic);

  const measure = (s: string) => fontManager.measureText(s, resourceName, fontSize);
  const effectiveWidth = availWidth - indentPts;
  // Always split on explicit newlines; additionally word-wrap if wrapText is set
  const lines = wrapText ? wrapTextLines(text, measure, effectiveWidth) : text.split(/\r?\n/);

  const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
  const lineMetrics = lines.map(line =>
    fontManager.measureTextMetrics(line, resourceName, fontSize)
  );
  // Union every line's actual ink interval. Looking only at the first ascent
  // and last descent misses a taller fallback face on a middle line; lending
  // that middle face's metrics to both outer lines adds phantom padding.
  let inkTop = Number.NEGATIVE_INFINITY;
  let inkBottom = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lineMetrics.length; i++) {
    const baselineOffset = -i * lineHeight;
    inkTop = Math.max(inkTop, baselineOffset + lineMetrics[i].ascent);
    inkBottom = Math.min(inkBottom, baselineOffset + lineMetrics[i].descent);
  }
  const ascent = inkTop;
  const blockHeight = inkTop - inkBottom;
  const textStartY = computeTextStartY(
    verticalAlign,
    rect,
    blockHeight,
    ascent,
    pad.top,
    pad.bottom
  );

  stream.setFillColor(cell.textColor);

  const useType3 = fontManager.hasType3Fonts() && !fontManager.hasEmbeddedFont();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineY = textStartY - i * lineHeight;
    // Already measured with the ascent and descent above. The two agree to within
    // a few ulps — bit for bit on the configured path, and within 4e-11pt on the
    // legacy mixed path, where `measureText` scales per character while this scales
    // once — so measuring again only re-routes the same string for no gain.
    const textX = computeTextX(
      horizontalAlign,
      rect,
      lineMetrics[i].width,
      indentPts,
      pad.left,
      pad.right
    );

    emitTextWithType3(stream, line, textX, lineY, resourceName, fontSize, fontManager, useType3);
  }

  drawTextDecorations(
    stream,
    cell,
    lines,
    lineHeight,
    textStartY,
    measure,
    resourceName,
    fontManager,
    indentPts,
    pad
  );
  stream.restore();
}

// =============================================================================
// Rich Text Rendering
// =============================================================================

function drawRichText(
  stream: PdfContentStream,
  cell: LayoutCell,
  fontManager: FontManager,
  indentPts: number,
  scaleFactor = 1
): void {
  const { rect, horizontalAlign, verticalAlign, wrapText } = cell;
  const runs = cell.richText!;
  const pad = computeCellPadding(cell, scaleFactor);

  // Helper: resolve resource name for a run
  const runResource = (run: LayoutRichTextRun) =>
    fontManager.resolveFont(run.fontFamily, run.bold, run.italic);

  // --- Wrapping path ---
  if (wrapText) {
    const availWidth = rect.width - pad.left - pad.right - indentPts;
    if (availWidth <= 0) {
      return;
    }

    // Build a character-to-run mapping so we know which run each char belongs to
    const fullText = runs.map(r => r.text).join("");
    const runForChar: number[] = [];
    for (let ri = 0; ri < runs.length; ri++) {
      for (let ci = 0; ci < runs[ri].text.length; ci++) {
        runForChar.push(ri);
      }
    }

    // Run-aware word-wrap using each character's actual run font size
    const runResources: string[] = runs.map(r => runResource(r));
    const runFontSizes: number[] = runs.map(r => r.fontSize);

    // Word-wrap using actual per-run measurements — returns character ranges
    const lineRanges = wrapRichTextLines(
      fullText,
      runForChar,
      runFontSizes,
      runResources,
      fontManager,
      availWidth
    );

    // Compute per-line heights from the faces that actually draw the line.
    const lineHeights: number[] = [];
    const lineAscents: number[] = [];
    const lineDescents: number[] = [];
    for (const range of lineRanges) {
      let lineMaxFont = cell.fontSize;
      for (let ci = range.start; ci < range.end; ci++) {
        const ri = runForChar[ci] ?? 0;
        if (runs[ri].fontSize > lineMaxFont) {
          lineMaxFont = runs[ri].fontSize;
        }
      }
      let lineAscent = 0;
      let lineDescent = 0;
      if (range.start === range.end) {
        // An explicit blank line still has the face and size of the run that
        // owns the newline (or, for a trailing blank line, the run immediately
        // before it). Without these metrics a leading blank line has zero
        // ascent and a trailing one zero descent, which moves middle/bottom
        // aligned rich text by a full font ascent.
        const ri = runForChar[range.start] ?? runForChar[range.start - 1] ?? 0;
        lineMaxFont = Math.max(lineMaxFont, runs[ri].fontSize);
        const metrics = fontManager.measureTextMetrics("", runResources[ri], runs[ri].fontSize);
        lineAscent = metrics.ascent;
        lineDescent = metrics.descent;
      }
      for (let ci = range.start; ci < range.end;) {
        const ri = runForChar[ci] ?? 0;
        let end = ci + 1;
        while (end < range.end && runForChar[end] === ri) {
          end++;
        }
        const metrics = fontManager.measureTextMetrics(
          fullText.slice(ci, end),
          runResources[ri],
          runs[ri].fontSize
        );
        lineAscent = Math.max(lineAscent, metrics.ascent);
        lineDescent = Math.min(lineDescent, metrics.descent);
        ci = end;
      }
      lineAscents.push(lineAscent);
      lineDescents.push(lineDescent);
      lineHeights.push(Math.max(lineMaxFont * LINE_HEIGHT_FACTOR, lineAscent - lineDescent));
    }

    // Union every line's actual ink interval at its variable baseline offset.
    // Looking only at the first ascent and last descent misses a taller middle
    // run, which then shifts centred text or gets clipped despite sufficient row
    // height.
    let inkTop = Number.NEGATIVE_INFINITY;
    let inkBottom = Number.POSITIVE_INFINITY;
    let baselineOffset = 0;
    for (let i = 0; i < lineHeights.length; i++) {
      inkTop = Math.max(inkTop, baselineOffset + lineAscents[i]);
      inkBottom = Math.min(inkBottom, baselineOffset + lineDescents[i]);
      baselineOffset -= lineHeights[i];
    }
    const ascent = inkTop;
    const blockHeight = inkTop - inkBottom;
    const textStartY = computeTextStartY(
      verticalAlign,
      rect,
      blockHeight,
      ascent,
      pad.top,
      pad.bottom
    );

    let cumulativeY = 0;
    for (let li = 0; li < lineRanges.length; li++) {
      const lineY = textStartY - cumulativeY;
      cumulativeY += lineHeights[li];
      const { start: lineStart, end: lineEnd } = lineRanges[li];

      // Split the line into segments by run
      const segments: Array<{ run: LayoutRichTextRun; text: string; resourceName: string }> = [];
      for (let ci = lineStart; ci < lineEnd; ci++) {
        const ri = runForChar[ci] ?? runForChar.length - 1;
        const last = segments[segments.length - 1];
        if (last && last.run === runs[ri]) {
          last.text += fullText[ci];
        } else {
          segments.push({
            run: runs[ri],
            text: fullText[ci],
            resourceName: runResources[ri]
          });
        }
      }

      // Measure total line width for alignment
      let lineWidth = 0;
      for (const seg of segments) {
        lineWidth += fontManager.measureText(seg.text, seg.resourceName, seg.run.fontSize);
      }

      let textX = computeTextX(horizontalAlign, rect, lineWidth, indentPts, pad.left, pad.right);
      const useType3 = fontManager.hasType3Fonts() && !fontManager.hasEmbeddedFont();
      for (const seg of segments) {
        const { run, text, resourceName } = seg;

        stream.setFillColor(run.textColor);
        const segWidth = emitTextWithType3(
          stream,
          text,
          textX,
          lineY,
          resourceName,
          run.fontSize,
          fontManager,
          useType3
        );

        if (run.strike) {
          const descent = fontManager.measureTextMetrics(text, resourceName, run.fontSize).descent;
          const y = lineY + descent + run.fontSize * 0.3;
          stream.drawLine(textX, y, textX + segWidth, y, run.textColor, 0.5);
        }
        if (run.underline) {
          const descent = fontManager.measureTextMetrics(text, resourceName, run.fontSize).descent;
          const y = lineY + descent * 0.5;
          stream.drawLine(textX, y, textX + segWidth, y, run.textColor, 0.5);
        }

        textX += segWidth;
      }
    }
    return;
  }

  // --- Single-line (no wrap) path ---
  // Measure total width of all runs
  let totalWidth = 0;
  const runMetrics: Array<{
    resourceName: string;
    width: number;
    ascent: number;
    descent: number;
  }> = [];
  for (const run of runs) {
    const resourceName = runResource(run);
    const metrics = fontManager.measureTextMetrics(run.text, resourceName, run.fontSize);
    runMetrics.push({ resourceName, ...metrics });
    totalWidth += metrics.width;
  }

  const ascent = Math.max(...runMetrics.map(metrics => metrics.ascent));
  const descent = Math.min(...runMetrics.map(metrics => metrics.descent));
  const textStartY = computeTextStartY(
    verticalAlign,
    rect,
    ascent - descent,
    ascent,
    pad.top,
    pad.bottom
  );
  let textX = computeTextX(horizontalAlign, rect, totalWidth, indentPts, pad.left, pad.right);
  const useType3 = fontManager.hasType3Fonts() && !fontManager.hasEmbeddedFont();

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const { resourceName } = runMetrics[i];

    stream.setFillColor(run.textColor);
    const runWidth = emitTextWithType3(
      stream,
      run.text,
      textX,
      textStartY,
      resourceName,
      run.fontSize,
      fontManager,
      useType3
    );

    // Draw per-run decorations (strikethrough, underline)
    if (run.strike) {
      const runDescent = runMetrics[i].descent;
      const y = textStartY + runDescent + run.fontSize * 0.3;
      stream.drawLine(textX, y, textX + runWidth, y, run.textColor, 0.5);
    }
    if (run.underline) {
      const runDescent = runMetrics[i].descent;
      const y = textStartY + runDescent * 0.5;
      stream.drawLine(textX, y, textX + runWidth, y, run.textColor, 0.5);
    }

    textX += runWidth;
  }
}

// =============================================================================
// Rotated Text
// =============================================================================

function drawRotatedText(
  stream: PdfContentStream,
  cell: LayoutCell,
  fontManager: FontManager,
  indentPts: number,
  scaleFactor = 1
): void {
  const { rect, wrapText } = cell;
  let { fontSize } = cell;
  const pad = computeCellPadding(cell, scaleFactor);
  const resourceName = fontManager.resolveFont(cell.fontFamily, cell.bold, cell.italic);

  // Convert Excel rotation to degrees
  const degrees = excelRotationToDegrees(cell.textRotation);

  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const absSin = Math.abs(sin);
  const absCos = Math.abs(cos);

  const maxWidth = rect.width - pad.left - pad.right;
  const maxHeight = rect.height - pad.top - pad.bottom;

  // Available length along the text flow direction for wrapping
  let availTextLength: number;
  if (absSin > 0.01 && absCos > 0.01) {
    availTextLength = Math.min(maxHeight / absSin, maxWidth / absCos);
  } else if (absSin > 0.01) {
    availTextLength = maxHeight / absSin;
  } else {
    availTextLength = maxWidth;
  }

  const measure = (s: string) => fontManager.measureText(s, resourceName, fontSize);

  // Split on explicit newlines first, then optionally word-wrap each paragraph
  let lines: string[];
  if (wrapText) {
    lines = wrapTextLines(cell.text, measure, Math.max(availTextLength - 1, 1));
  } else {
    lines = cell.text.split(/\r?\n/);
  }

  /**
   * The text block's per-line ink, at a given size, plus a bounding box for any
   * rotation of it.
   *
   * `boundsAt` transforms each line's own ink rectangle and unions the corners,
   * which is what both fitting and placement need. The cruder
   * `maxLineWidth × blockHeight` overestimates whenever the widest line and the
   * tallest face are different lines, shrinking text that would have fitted.
   */
  const measureBlock = (size: number) => {
    const lineHeight = size * LINE_HEIGHT_FACTOR;
    const metrics = lines.map(line => fontManager.measureTextMetrics(line, resourceName, size));
    const widths = metrics.map(m => m.width);
    let ccwLeft = Number.POSITIVE_INFINITY;
    let ccwRight = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < metrics.length; i++) {
      // Rotated +90° the columns advance right and the ascent points left. The
      // -90° case is the exact mirror of this range (see `cwLeft` / `cwRight`),
      // so only one of the two is measured.
      ccwLeft = Math.min(ccwLeft, i * lineHeight - metrics[i].ascent);
      ccwRight = Math.max(ccwRight, i * lineHeight - metrics[i].descent);
    }
    /**
     * Bounding box of the block rotated by (cos, sin), in a space whose origin
     * is the first line's baseline start. Also reports that box's centre, so a
     * caller can align the visible ink rather than a nominal rectangle.
     */
    const boundsAt = (cosA: number, sinA: number) => {
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < metrics.length; i++) {
        const halfWidth = widths[i] / 2;
        const baselineY = -(i - (metrics.length - 1) / 2) * lineHeight;
        for (const x of [-halfWidth, halfWidth]) {
          for (const y of [baselineY + metrics[i].descent, baselineY + metrics[i].ascent]) {
            const rx = x * cosA - y * sinA;
            const ry = x * sinA + y * cosA;
            minX = Math.min(minX, rx);
            maxX = Math.max(maxX, rx);
            minY = Math.min(minY, ry);
            maxY = Math.max(maxY, ry);
          }
        }
      }
      return {
        width: maxX - minX,
        height: maxY - minY,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2
      };
    };
    return { lineHeight, boundsAt, ccwLeft, ccwRight };
  };

  let block = measureBlock(fontSize);

  // For non-wrapping text: scale font down if the rotated bounding box exceeds cell
  if (!wrapText) {
    const { width: rotatedWidth, height: rotatedHeight } = block.boundsAt(cos, sin);
    if (maxWidth > 0 && maxHeight > 0 && (rotatedWidth > maxWidth || rotatedHeight > maxHeight)) {
      const fitScale = Math.min(maxWidth / rotatedWidth, maxHeight / rotatedHeight);
      if (fitScale < 1) {
        fontSize = fontSize * fitScale;
        block = measureBlock(fontSize);
      }
    }
  }

  const is90 = Math.abs(degrees - 90) < 0.01;
  const isMinus90 = Math.abs(degrees + 90) < 0.01;

  stream.setFillColor(cell.textColor);

  if (is90) {
    // Text reads bottom-to-top. Each line becomes a column drawn left-to-right.
    drawRotated90(stream, cell, lines, fontManager, resourceName, fontSize, block, pad);
  } else if (isMinus90) {
    // Text reads top-to-bottom. Each line becomes a column drawn right-to-left.
    drawRotatedMinus90(stream, cell, lines, fontManager, resourceName, fontSize, block, pad);
  } else {
    // General rotation — center multi-line text block in cell
    drawRotatedGeneral(
      stream,
      cell,
      lines,
      fontManager,
      resourceName,
      fontSize,
      block,
      cos,
      sin,
      indentPts
    );
  }
}

/**
 * A rotated text block, measured at the size it will be drawn.
 *
 * Every extent here is the block's real ink, unioned across its lines: a line
 * box's leading is not part of it, so rotation cannot charge that leading to
 * whichever side it happens to point at. `ccw*` / `cw*` are the column ranges
 * the axis-swapped 90° cases place against; `boundsAt` is the rotated bounding
 * box every other angle needs.
 */
interface RotatedTextBlock {
  readonly lineHeight: number;
  /** Bounding box, and its centre, of the block rotated by (cos, sin). */
  readonly boundsAt: (
    cos: number,
    sin: number
  ) => { width: number; height: number; centerX: number; centerY: number };
  /**
   * Horizontal span of the columns when rotated +90°, relative to the first
   * column's origin. The -90° span is its exact mirror — negating and swapping
   * the two bounds — because that rotation reverses both the column advance and
   * the direction the ascent points.
   */
  readonly ccwLeft: number;
  readonly ccwRight: number;
}

/** 90° CCW: text reads bottom-to-top, lines stack left-to-right. */
function drawRotated90(
  stream: PdfContentStream,
  cell: LayoutCell,
  lines: string[],
  fontManager: FontManager,
  resourceName: string,
  fontSize: number,
  block: RotatedTextBlock,
  pad: CellPadding
): void {
  const { rect, horizontalAlign, verticalAlign } = cell;
  const { lineHeight, ccwLeft, ccwRight } = block;
  // Rotated 90° CCW the ascent points at page-left, so the block's ink spans
  // `blockWidth` horizontally, starting `ascent` left of the first column.
  let startX: number;
  if (horizontalAlign === "center") {
    startX = rect.x + rect.width / 2 - (ccwLeft + ccwRight) / 2;
  } else if (horizontalAlign === "right") {
    startX = rect.x + rect.width - pad.right - ccwRight;
  } else {
    // left (default)
    startX = rect.x + pad.left - ccwLeft;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWidth = fontManager.measureText(line, resourceName, fontSize);
    const colX = startX + i * lineHeight;

    // verticalAlign controls Y placement (text flows upward from ty)
    // In PDF coords: higher y = top of cell
    let ty: number;
    if (verticalAlign === "top") {
      // text at top → text end near top → ty starts at bottom so text reaches top
      ty = rect.y + rect.height - pad.top - lineWidth;
    } else if (verticalAlign === "middle") {
      ty = rect.y + (rect.height - lineWidth) / 2;
    } else {
      // bottom (default) → text at bottom → ty near bottom
      ty = rect.y + pad.bottom;
    }
    ty = Math.max(ty, rect.y + pad.bottom);

    emitTextWithMatrix(stream, fontManager, {
      text: line,
      matrix: [0, 1, -1, 0, colX, ty],
      resourceName,
      fontSize
    });
  }
}

/** -90° (270° CW): text reads top-to-bottom, lines stack right-to-left. */
function drawRotatedMinus90(
  stream: PdfContentStream,
  cell: LayoutCell,
  lines: string[],
  fontManager: FontManager,
  resourceName: string,
  fontSize: number,
  block: RotatedTextBlock,
  pad: CellPadding
): void {
  const { rect, horizontalAlign, verticalAlign } = cell;
  const { lineHeight, ccwLeft, ccwRight } = block;
  // Mirror of the +90° span: see `RotatedTextBlock.ccwLeft`.
  const cwLeft = -ccwRight;
  const cwRight = -ccwLeft;
  // Rotated -90° the ascent points at page-right, so the first column — the
  // rightmost one — carries the block's right edge `ascent` past its origin,
  // and the columns then step left.
  let startX: number;
  if (horizontalAlign === "center") {
    startX = rect.x + rect.width / 2 - (cwLeft + cwRight) / 2;
  } else if (horizontalAlign === "right") {
    startX = rect.x + rect.width - pad.right - cwRight;
  } else {
    // left (default)
    startX = rect.x + pad.left - cwLeft;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWidth = fontManager.measureText(line, resourceName, fontSize);
    const colX = startX - i * lineHeight;

    // verticalAlign controls Y placement (text flows downward from ty)
    // In PDF coords: higher y = top of cell; text drawn downward = toward lower y
    let ty: number;
    if (verticalAlign === "top") {
      // text at top → ty near top (high PDF y)
      ty = rect.y + rect.height - pad.top;
    } else if (verticalAlign === "middle") {
      ty = rect.y + (rect.height + lineWidth) / 2;
    } else {
      // bottom (default) → text at bottom → ty so text ends at bottom
      ty = rect.y + pad.bottom + lineWidth;
    }
    ty = Math.min(ty, rect.y + rect.height - pad.top);

    emitTextWithMatrix(stream, fontManager, {
      text: line,
      matrix: [0, -1, 1, 0, colX, ty],
      resourceName,
      fontSize
    });
  }
}

/** General rotation — center a multi-line text block in the cell. */
function drawRotatedGeneral(
  stream: PdfContentStream,
  cell: LayoutCell,
  lines: string[],
  fontManager: FontManager,
  resourceName: string,
  fontSize: number,
  block: RotatedTextBlock,
  cos: number,
  sin: number,
  indentPts: number
): void {
  const { rect, horizontalAlign, verticalAlign } = cell;
  const { lineHeight } = block;
  // Use border-aware padding (no scaleFactor — font size is already scaled by caller)
  const pad = computeCellPadding(cell);

  // The visible ink, rotated. Aligning against this rather than a nominal
  // `maxLineWidth × blockHeight` rectangle keeps a tall face on one line from
  // padding the other lines, and subtracting its centre below is what makes the
  // ink — not that rectangle — land on the alignment point.
  const {
    width: rotatedWidth,
    height: rotatedHeight,
    centerX: localCenterX,
    centerY: localCenterY
  } = block.boundsAt(cos, sin);

  // Compute slant offset to match parallelogram border shape
  const slantShift = computeSlantOffset(cell.textRotation, rect.height) / 2;

  // Determine vertical position first, then horizontal (because slant depends on Y position)
  const indentOffset =
    horizontalAlign === "left" ? indentPts / 2 : horizontalAlign === "right" ? -indentPts / 2 : 0;

  let cy: number;
  if (verticalAlign === "top") {
    cy = rect.y + rect.height - pad.top - rotatedHeight / 2;
  } else if (verticalAlign === "bottom") {
    cy = rect.y + pad.bottom + rotatedHeight / 2;
  } else {
    // middle (default)
    cy = rect.y + rect.height / 2;
  }

  // For slanted parallelogram, the horizontal offset depends on the vertical position
  // At bottom (y), left edge is at x; at top (y+height), left edge is at x+slantOffset
  // At cy, the horizontal shift is proportional: slantOffset * (cy - y) / height
  const verticalRatio = rect.height > 0 ? (cy - rect.y) / rect.height : 0.5;
  const slantAtCy = slantShift * 2 * verticalRatio; // slantShift*2 = full slantOffset

  let cx: number;
  if (horizontalAlign === "right") {
    cx = rect.x + rect.width - pad.right - rotatedWidth / 2 + indentOffset + slantAtCy;
  } else if (horizontalAlign === "left") {
    cx = rect.x + pad.left + rotatedWidth / 2 + indentOffset + slantAtCy;
  } else {
    // center (default for rotated)
    cx = rect.x + rect.width / 2 + indentOffset + slantAtCy;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWidth = fontManager.measureText(line, resourceName, fontSize);
    const lineOffset = (i - (lines.length - 1) / 2) * lineHeight;
    const offsetX = -lineWidth / 2;
    const offsetY = -lineOffset;

    const tx = cx + offsetX * cos - offsetY * sin - localCenterX;
    const ty = cy + offsetX * sin + offsetY * cos - localCenterY;

    emitTextWithMatrix(stream, fontManager, {
      text: line,
      matrix: [cos, sin, -sin, cos, tx, ty],
      resourceName,
      fontSize
    });
  }
}

/** Emit a text string with hex encoding if available, onto a sink stream. */
function emitText(
  stream: PdfContentStream,
  fontManager: FontManager,
  text: string,
  resourceName: string,
  wordSpacing = 0,
  fontSize = 0
): void {
  const hex = fontManager.encodeText(text, resourceName);
  if (hex === null) {
    stream.showText(text);
    return;
  }
  if (wordSpacing !== 0 && fontSize > 0 && text.includes(" ")) {
    stream.showTextHexWithAdjustments(
      cidWordSpacingRun(fontManager, text, resourceName, wordSpacing, fontSize)
    );
    return;
  }
  stream.showTextHex(hex);
}

/**
 * A justified run for a CIDFont, as alternating hex strings and displacements.
 *
 * `Tw` cannot deliver word spacing here — PDF 32000-1 §9.3.3 applies it to a
 * single-byte code 32 only, and every code in an `Identity-H` CIDFont is two
 * bytes — so the gap is opened with an explicit `TJ` adjustment after each space
 * instead. Emitting `Tw` anyway is what made a justified Latin line fall 11–17pt
 * short of a 468pt column while the layout believed it had filled it.
 *
 * `TJ` numbers are thousandths of a unit of *text* space, and are subtracted from
 * the displacement — hence the negative sign and the division by the font size.
 */
function cidWordSpacingRun(
  fontManager: FontManager,
  text: string,
  resourceName: string,
  wordSpacing: number,
  fontSize: number
): (string | number)[] {
  const adjustment = (-wordSpacing / fontSize) * 1000;
  const parts: (string | number)[] = [];
  // Split *after* each space so the space keeps its own advance and only the extra
  // gap is added, exactly as `Tw` would have done.
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") {
      continue;
    }
    const chunk = text.slice(start, i + 1);
    const hex = fontManager.encodeText(chunk, resourceName);
    if (hex !== null) {
      parts.push(hex);
    }
    parts.push(adjustment);
    start = i + 1;
  }
  if (start < text.length) {
    const hex = fontManager.encodeText(text.slice(start), resourceName);
    if (hex !== null) {
      parts.push(hex);
    }
  }
  return parts;
}

/**
 * Render a text string with a custom text matrix, using Type3-aware splitting
 * when needed.  For each sub-run the matrix origin is advanced along the
 * text direction (cos, sin) by the rendered width.
 *
 * The emitted operators are written as a *deferred* fragment (see
 * `PdfContentStream.deferred`). The fragment is only evaluated at
 * serialization time, by which point `PdfDocumentBuilder.build()` has
 * finalised the document's fonts (auto-discovered embedded CIDFont,
 * Type3 fallback, or plain Type1). This is essential: at draw time the
 * font manager has not yet decided whether a non-WinAnsi code point (e.g.
 * U+2192 →) will be served by an embedded font or a Type3 glyph, so eager
 * encoding would irreversibly degrade those characters to spaces via the
 * WinAnsi fallback. Deferring the encode keeps the fragment at its exact
 * draw-order slot (preserving z-order) while choosing the correct bytes
 * once fonts are known.
 *
 * The `useType3` argument is the caller's *draw-time* guess and is ignored;
 * the deferred body recomputes the routing from the now-settled font
 * manager state.
 */
export interface TextMatrixOptions {
  text: string;
  matrix: [a: number, b: number, c: number, d: number, tx: number, ty: number];
  resourceName: string;
  fontSize: number;
  renderingMode?: 0 | 1 | 2;
}

function emitTextWithMatrix(
  stream: PdfContentStream,
  fontManager: FontManager,
  options: TextMatrixOptions
): void {
  const [a, b, c, d, tx, ty] = options.matrix;
  stream.deferred(
    () =>
      renderTextBlock(
        options.text,
        a,
        b,
        c,
        d,
        tx,
        ty,
        options.resourceName,
        options.fontSize,
        fontManager,
        options.renderingMode ?? 0
      ),
    () => fontManager.trackText(options.text, options.resourceName)
  );
}

/** Options for a deferred, font-aware text block (see `emitTextBlock`). */
export interface TextBlockOptions {
  /** The text to draw (may contain `\n` when `maxWidth` is set). */
  text: string;
  /** Left/anchor x in unrotated page space. */
  x: number;
  /** Baseline y of the first line in unrotated page space. */
  y: number;
  /** Draw-time-resolved Type1 resource name; re-routed at build time. */
  type1ResourceName?: string;
  /** Deferred font request used by the free-form builder. */
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  fontSize: number;
  /** Horizontal anchor; applied per line (including each wrapped line). */
  anchor: "start" | "middle" | "end";
  /** Word-wrap width in points; enables multi-line layout when set. */
  maxWidth?: number;
  /** Line-height multiple applied to `fontSize` for wrapped lines. */
  lineHeightFactor: number;
  /** Clockwise rotation in degrees about (x, y); applied to every line. */
  rotation: number;
  /**
   * Extra advance after every character, in points (PDF `Tc`).
   *
   * Used to justify East Asian text, which has no spaces to widen. Included in
   * measurement so anchored text stays anchored.
   */
  charSpacing?: number;
  /** Extra advance on every space, in points (PDF `Tw`). The Latin equivalent. */
  wordSpacing?: number;
}

/**
 * Emit a text block as a single *deferred* fragment so that anchor
 * alignment, word wrapping, and glyph encoding are all computed at
 * serialization time — after `PdfDocumentBuilder.build()` has finalised the
 * document's fonts.
 *
 * This matters because text measurement (anchor offset, line breaking) must
 * use the *same* font that ultimately renders the glyphs. At draw time the
 * font may still be unresolved (a non-WinAnsi run can trigger a build-time
 * auto-embed of a system CIDFont), so measuring against the provisional
 * Type1/Helvetica metrics would misplace centred/right-aligned text and
 * break lines at the wrong points. Deferring keeps measurement and encoding
 * consistent while preserving the fragment's draw-order slot (z-order).
 */
export function emitTextBlock(
  stream: PdfContentStream,
  options: TextBlockOptions,
  fontManager: FontManager
): void {
  let resourceName = options.type1ResourceName;
  const resolveResource = () => {
    resourceName ??= fontManager.resolveFont(
      options.fontFamily ?? "Helvetica",
      options.bold ?? false,
      options.italic ?? false
    );
    return resourceName;
  };
  stream.deferred(
    () => renderTextBlockLayout({ ...options, type1ResourceName: resolveResource() }, fontManager),
    () => fontManager.trackText(options.text, resolveResource())
  );
}

/**
 * Lay out and render a text block from the font manager's *current*
 * (build-time) state. Resolves the render resource name once and uses it for
 * both measurement and encoding so the two never disagree.
 *
 * Layout is computed in the text's *local* coordinate frame — x grows along
 * the baseline, y grows upward — then mapped to page space through the
 * rotation matrix. This makes anchor alignment, multi-line word wrapping, and
 * rotation compose correctly together: each line is offset by its anchor
 * shift (along local x) and its line index (down local y), and a single
 * rotation maps the whole block into place. Upright text (rotation 0) reduces
 * to the identity mapping.
 */
function renderTextBlockLayout(
  options: TextBlockOptions & { type1ResourceName: string },
  fontManager: FontManager
): string {
  const { text, x, y, type1ResourceName, fontSize, anchor, maxWidth, lineHeightFactor, rotation } =
    options;
  const charSpacing = options.charSpacing ?? 0;
  const wordSpacing = options.wordSpacing ?? 0;

  // Resolve the resource name once; measurement and rendering share it so a
  // build-time auto-embedded CIDFont (or Type3 fallback) is measured with the
  // metrics that will actually render the glyphs.
  const measureResource = fontManager.resolveRenderResourceName(type1ResourceName);
  // Justification spacing is part of the advance, so measurement has to include
  // it or an anchored line would be positioned from the wrong width.
  const measure = (s: string) =>
    fontManager.measureText(s, measureResource, fontSize) +
    justifyAdvance(s, charSpacing, wordSpacing);

  const lines = maxWidth ? wrapTextLines(text, measure, maxWidth) : [text];
  const leading = fontSize * lineHeightFactor;

  // Rotation matrix [a b; c d] = [cos sin; -sin cos]; identity when upright.
  const theta = (rotation * Math.PI) / 180;
  const cos = rotation === 0 ? 1 : Math.cos(theta);
  const sin = rotation === 0 ? 0 : Math.sin(theta);
  const anchorFactor = anchor === "middle" ? 0.5 : anchor === "end" ? 1 : 0;

  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Local-frame origin of this line: anchor shift along x, line index down y.
    const localX = anchorFactor === 0 ? 0 : -measure(lines[i]) * anchorFactor;
    const localY = -i * leading;
    // Map local origin into page space through the rotation matrix.
    const tx = x + localX * cos + localY * -sin;
    const ty = y + localX * sin + localY * cos;
    parts.push(
      renderTextBlock(
        lines[i],
        cos,
        sin,
        -sin,
        cos,
        tx,
        ty,
        type1ResourceName,
        fontSize,
        fontManager,
        0,
        charSpacing,
        wordSpacing
      )
    );
  }
  const body = parts.join("\n");
  if (charSpacing === 0 && wordSpacing === 0) {
    return body;
  }
  // `Tc`/`Tw` are text state, so they belong to the graphics state and are
  // restored by the enclosing `q`/`Q`. They are still reset explicitly: a caller
  // may emit this fragment without a save/restore pair, and leaking a character
  // spacing onto everything drawn afterwards is a far worse failure than the two
  // extra operators.
  //
  // `Tw` is emitted even though a CIDFont segment delivers its word spacing
  // through `TJ` instead (see `cidWordSpacingRun`): with an `Identity-H` encoding
  // every code is two bytes, so `Tw` matches nothing and cannot double-apply.
  // A Type1 or Type3 segment in the same block is a simple font, where `Tw` is
  // exactly the right mechanism and `emitText` leaves it to do the work.
  return `${pdfNumber(charSpacing)} Tc ${pdfNumber(wordSpacing)} Tw\n${body}\n0 Tc 0 Tw`;
}

/**
 * The width justification spacing adds to a stretch of text.
 *
 * `Tc` advances once per glyph and `Tw` only on byte 32, so this must agree with
 * both the renderer's operators and the layout engine's `justificationWidth` —
 * three places that all have to compute the same number, or a line's measured
 * width stops matching what is drawn.
 */
function justifyAdvance(text: string, charSpacing: number, wordSpacing: number): number {
  if (charSpacing === 0 && wordSpacing === 0) {
    return 0;
  }
  // `countGlyphAdvances`, not a per-code-point count: `Tc` is added after every
  // glyph shown, and a variation selector or ZWJ is folded into the glyph before it
  // rather than drawing one.
  //
  // A space is itself a drawn glyph, so it takes `Tc` as well as `Tw` — which is
  // why the glyph count is taken over the whole string and the spaces subtracted,
  // rather than building a space-free copy of it just to count what is left.
  let spaces = 0;
  for (const char of text) {
    if (char === " ") {
      spaces++;
    }
  }
  return spaces * wordSpacing + charSpacing * (countGlyphAdvances(text) - spaces);
}

/**
 * Produce the PDF operator string for a positioned text run, choosing the
 * encoding from the font manager's *current* (build-time) state:
 *   - embedded font  → single BT/ET with CIDFont hex encoding
 *   - Type3 fallback → split into runs of WinAnsi (Type1) and same-resource
 *     Type3 characters, one BT/ET per run
 *   - neither        → single BT/ET with Type1/WinAnsi encoding
 *
 * Must only be called after font resolution (i.e. from a deferred fragment).
 */
function renderTextBlock(
  text: string,
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
  type1ResourceName: string,
  fontSize: number,
  fontManager: FontManager,
  renderingMode: 0 | 1 | 2 = 0,
  charSpacing = 0,
  wordSpacing = 0
): string {
  const sink = new PdfContentStream();

  const routed = fontManager.routeText(text, type1ResourceName);
  if (routed.some(segment => segment.resourceName !== type1ResourceName)) {
    let curTx = tx;
    let curTy = ty;
    for (const segment of routed) {
      sink.beginText();
      if (renderingMode !== 0) {
        sink.setTextRenderingMode(renderingMode);
      }
      sink.setFont(segment.resourceName, fontSize);
      sink.setTextMatrix(a, b, c, d, curTx, curTy);
      emitText(sink, fontManager, segment.text, segment.resourceName, wordSpacing, fontSize);
      sink.endText();
      // The renderer applies `Tc`/`Tw` to this segment, so the origin of the
      // next one has to move by that too. Advancing by the font's natural width
      // alone made every segment after the first overlap the one before it.
      const width =
        segment.width * fontSize + justifyAdvance(segment.text, charSpacing, wordSpacing);
      curTx += a * width;
      curTy += b * width;
    }
    return sink.toString();
  }

  // Per-code-point splitting applies whenever some code points are drawn by a
  // face other than the requested Type1 one: Type3 glyphs, or an embedded
  // *fallback* face lending glyphs. A *document* font (explicit `embedFont`)
  // draws the whole run itself, so no splitting is involved.
  const useSplit =
    (fontManager.hasType3Fonts() || fontManager.hasFallbackFont()) &&
    !(fontManager.hasEmbeddedFont() && !fontManager.hasFallbackFont());

  if (!useSplit) {
    const resourceName = fontManager.resolveRenderResourceName(type1ResourceName);
    sink.beginText();
    if (renderingMode !== 0) {
      sink.setTextRenderingMode(renderingMode);
    }
    sink.setFont(resourceName, fontSize);
    sink.setTextMatrix(a, b, c, d, tx, ty);
    emitText(sink, fontManager, text, resourceName, wordSpacing, fontSize);
    sink.endText();
    return sink.toString();
  }

  // Split path: alternate between the requested Type1 face and the faces that
  // lend individual glyphs, advancing the origin along the text direction.
  const runs = splitTextRuns(text, fontManager);
  let curTx = tx;
  let curTy = ty;
  for (const run of runs) {
    const resourceName = run.resourceName ?? type1ResourceName;
    sink.beginText();
    if (renderingMode !== 0) {
      sink.setTextRenderingMode(renderingMode);
    }
    sink.setFont(resourceName, fontSize);
    sink.setTextMatrix(a, b, c, d, curTx, curTy);
    if (run.type3Hex !== null) {
      sink.showTextHex(run.type3Hex);
    } else {
      emitText(sink, fontManager, run.text, resourceName, wordSpacing, fontSize);
    }
    sink.endText();
    const w =
      fontManager.measureText(run.text, resourceName, fontSize) +
      justifyAdvance(run.text, charSpacing, wordSpacing);
    // Advance along the text direction (first column of the matrix)
    curTx += a * w;
    curTy += b * w;
  }
  return sink.toString();
}

// =============================================================================
// Mixed-Font Text Run Splitting
// =============================================================================

/** A run of text drawn by exactly one font resource. */
interface TextRun {
  /** The text content of this run. */
  text: string;
  /**
   * The resource that draws it, or null to use the caller's Type1 resource.
   * Set for Type3 fallback fonts and for an embedded fallback face.
   */
  resourceName: string | null;
  /**
   * Non-null for a Type3 run: the run's single-byte codes for one `Tj`
   * (`<XXYY…>`). Type3 fonts are single-byte encoded, so a whole run of them
   * becomes one text-showing operation.
   */
  type3Hex: string | null;
}

/** A cluster with its joiners and variation selectors removed. */
function stripShapingControls(cluster: string): string {
  let out = "";
  for (const char of cluster) {
    if (!isGlyphlessControl(char.codePointAt(0)!)) {
      out += char;
    }
  }
  return out;
}

/**
 * Split a line of text into the fewest possible runs, where each run is
 * rendered by exactly one font resource.
 *
 * Consecutive characters the requested Type1 face can draw merge into one run;
 * so do consecutive characters that resolve to the *same* fallback resource —
 * whether that is an embedded fallback face or one Type3 partition. A boundary
 * appears only where the resource actually changes: at a WinAnsi/non-WinAnsi
 * transition, at a Type3 partition boundary (every 255 distinct non-WinAnsi
 * code points), or between Type3 and embedded-fallback coverage.
 *
 * Merging matters beyond stream size: one `Tj` per glyph makes every glyph a
 * separate text-showing operation, so PDF text extractors (including this
 * package's reader) recover `机`, `密` as two fragments instead of the word
 * `机密`. Keeping runs whole preserves word boundaries for copy/paste and
 * search.
 *
 * Non-WinAnsi characters that no face can draw join the Type1 run (the WinAnsi
 * encoder renders them as a space).
 */
function splitTextRuns(text: string, fontManager: FontManager): TextRun[] {
  const runs: TextRun[] = [];

  // The run being accumulated. `pendingResource` is null for a Type1 run;
  // `pendingCodePoints` is only needed by Type3 runs (to build the hex).
  let pendingText = "";
  let pendingResource: string | null = null;
  let pendingIsType3 = false;
  let pendingCodePoints: number[] = [];

  const flush = () => {
    if (!pendingText) {
      return;
    }
    const hex =
      pendingIsType3 && pendingResource !== null
        ? fontManager.encodeType3Run(pendingCodePoints, pendingResource)
        : null;
    // A Type3 resource that cannot encode the run is unusable — fall back to
    // the caller's Type1 face rather than emitting a broken show operator.
    const usable = !pendingIsType3 || hex !== null;
    runs.push({
      text: pendingText,
      resourceName: usable ? pendingResource : null,
      type3Hex: hex
    });
    pendingText = "";
    pendingResource = null;
    pendingIsType3 = false;
    pendingCodePoints = [];
  };

  // Whole grapheme clusters, not code points. Subsetting registers a cluster —
  // base plus the variation selectors and joiners that follow it — under one
  // sequence, so cutting inside one leaves the tail looking up a sequence that
  // was never registered and it encodes as `.notdef`: drawing "A\uFE0F❤\uFE0F"
  // put `A` on the Type1 face, sent the lone selector to the fallback, and lost
  // the heart entirely.
  for (const cluster of graphemeClusters(text)) {
    // The cluster's face is decided by the character it actually draws; the
    // shaping controls travel with it. A control alone never chooses a face.
    let base = cluster.codePointAt(0)!;
    for (const char of cluster) {
      const cp = char.codePointAt(0)!;
      if (!isGlyphlessControl(cp)) {
        base = cp;
        break;
      }
    }

    const fallback = fontManager.fallbackResourceFor(base);
    const isType3 = fallback === null && fontManager.needsType3(base);
    const resource =
      fallback ?? (isType3 ? (fontManager.resolveType3(base)?.resourceName ?? null) : null);

    if (resource !== pendingResource || (resource !== null && isType3 !== pendingIsType3)) {
      flush();
      pendingResource = resource;
      pendingIsType3 = resource !== null && isType3;
    }
    // The standard-14 faces have no glyph for a shaping control and the WinAnsi
    // encoder substitutes a space for anything it cannot represent — which put a
    // stray space after every character carrying a variation selector. A face
    // that *can* represent them keeps the whole cluster, because its subset is
    // keyed by the full sequence.
    pendingText += resource === null ? stripShapingControls(cluster) : cluster;
    if (pendingIsType3) {
      // Type3 fonts are single-byte encoded and have no notion of a cluster;
      // only the drawable code points get a glyph.
      for (const char of cluster) {
        const cp = char.codePointAt(0)!;
        if (!isGlyphlessControl(cp)) {
          pendingCodePoints.push(cp);
        }
      }
    }
  }

  flush();
  return runs;
}

/**
 * Render a text string at (textX, textY) using Type3-aware splitting when needed.
 * Returns the rendered width so the caller can advance textX.
 */
function emitTextWithType3(
  stream: PdfContentStream,
  text: string,
  textX: number,
  textY: number,
  type1ResourceName: string,
  fontSize: number,
  fontManager: FontManager,
  useType3: boolean
): number {
  emitTextWithMatrix(stream, fontManager, {
    text,
    matrix: [1, 0, 0, 1, textX, textY],
    resourceName: type1ResourceName,
    fontSize
  });
  return fontManager.measureText(text, type1ResourceName, fontSize);
}

/**
 * Pitch of Excel's stacked (`textRotation = 255`) text, as fractions of the font
 * size. Excel does not publish either value, and these read correctly from 8 pt
 * to 36 pt. They are deliberately *not* `LINE_HEIGHT_FACTOR`: that spaces
 * wrapped lines of horizontal text, where consecutive lines rarely collide,
 * whereas a column of upright glyphs stacks full-height forms directly above one
 * another and needs the looser step. Only the pitch is approximate — where the
 * column starts is derived from real ink metrics.
 */
const VERTICAL_STACK_METRICS = {
  /** Baseline-to-baseline step down a column. */
  CHAR_ADVANCE: 1.3,
  /** Centre-to-centre step across columns. */
  COLUMN_PITCH: 1.4
} as const;

/**
 * Draw vertical stacked text (each character top-to-bottom).
 * Newlines (\n) start a new column to the right.
 */
function drawVerticalStackedText(
  stream: PdfContentStream,
  cell: LayoutCell,
  fontManager: FontManager,
  _indentPts: number,
  scaleFactor = 1
): void {
  const { rect, text, fontSize, horizontalAlign, verticalAlign } = cell;
  const pad = computeCellPadding(cell, scaleFactor);
  const resourceName = fontManager.resolveFont(cell.fontFamily, cell.bold, cell.italic);

  const charHeight = fontSize * VERTICAL_STACK_METRICS.CHAR_ADVANCE;
  const { ascent, descent } = fontManager.measureTextMetrics(text, resourceName, fontSize);

  // Split on newlines — each segment becomes a new column
  const columns = text.split(/\r?\n/);
  const columnWidth = fontSize * VERTICAL_STACK_METRICS.COLUMN_PITCH;
  const totalColumnsWidth = columns.length * columnWidth;

  // Horizontal alignment controls column X positioning
  let startX: number;
  if (horizontalAlign === "center") {
    startX = rect.x + rect.width / 2 - totalColumnsWidth / 2 + columnWidth / 2;
  } else if (horizontalAlign === "right") {
    startX = rect.x + rect.width - pad.right - totalColumnsWidth + columnWidth / 2;
  } else {
    // left (default)
    startX = rect.x + pad.left + columnWidth / 2;
  }

  stream.setFillColor(cell.textColor);

  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const colText = columns[colIdx];
    const colX = startX + colIdx * columnWidth;

    // Vertical alignment controls starting Y position (PDF y-axis: higher = top of cell)
    let currentY = computeTextStartY(
      verticalAlign,
      rect,
      computeTextBlockHeight(colText.length, charHeight, ascent, descent),
      ascent,
      pad.top,
      pad.bottom
    );

    for (const ch of colText) {
      if (currentY < rect.y + pad.bottom) {
        break;
      }
      const charWidth = fontManager.measureText(ch, resourceName, fontSize);

      emitTextWithMatrix(stream, fontManager, {
        text: ch,
        matrix: [1, 0, 0, 1, colX - charWidth / 2, currentY],
        resourceName,
        fontSize
      });
      currentY -= charHeight;
    }
  }
}

// =============================================================================
// Alpha / ExtGState Helpers
// =============================================================================

/**
 * Generate a deterministic ExtGState resource name for a given alpha value.
 * Uses 4 decimal digits to avoid collisions between close alpha values.
 * E.g. alpha=0.504 → "GS5040", alpha=0.506 → "GS5060"
 */
export function alphaGsName(alpha: number, resourcePrefix = ""): string {
  return `${resourcePrefix}GS${Math.round(alpha * 10000)}`;
}

// =============================================================================
// Text Layout Helpers
// =============================================================================

/**
 * Baseline of the **first** line, given where the text block must sit.
 *
 * `textBlockHeight` is the distance from the first line's ascent to the last
 * line's descent — the block the three alignments are measured against. For a
 * stack of `n` lines set `(n - 1) * lineHeight + (ascent - descent)`; note that
 * `n * lineHeight` is *not* the same thing, because a line box carries leading
 * that no glyph occupies. Passing the taller value pushes the block up by that
 * leading (~0.28 × font size for Helvetica, ~0.41 × for Courier), so
 * bottom-aligned text floats above its inset and centred text sits above the
 * cell's middle — the top inset stays exact because it is derived from `ascent`
 * alone. Feed it ink extents and all three alignments agree.
 */
export function computeTextStartY(
  verticalAlign: "top" | "middle" | "bottom",
  rect: PdfRect,
  textBlockHeight: number,
  ascent: number,
  padVTop = CELL_PADDING_V,
  padVBottom = padVTop
): number {
  let y: number;
  switch (verticalAlign) {
    case "top":
      y = rect.y + rect.height - padVTop - ascent;
      break;
    case "middle":
      y = rect.y + rect.height / 2 + textBlockHeight / 2 - ascent;
      break;
    case "bottom":
    default:
      y = rect.y + padVBottom + (textBlockHeight - ascent);
      break;
  }
  // When the block does not fit, the alignment cannot be honoured and something
  // has to be sacrificed. Pull it down to the top-aligned baseline: the reader
  // then loses the tail of the text rather than its first line, which is what
  // Excel's own clipping leaves legible in a too-short row. Note this makes a
  // bottom- or middle-aligned block in such a row render as top-aligned.
  const topAlignedY = rect.y + rect.height - padVTop - ascent;
  if (y > topAlignedY) {
    y = topAlignedY;
  }
  // Last resort for a cell shorter than a single ascent: keep the baseline
  // inside the cell so the glyphs cannot be drawn under the row below. This
  // does not reserve room for descenders — at this size nothing fits, and the
  // cell clip is what actually contains the overflow.
  const minY = rect.y + padVBottom;
  if (y < minY) {
    y = minY;
  }
  return y;
}

/**
 * Height of a stack of `lineCount` lines from the first ascent to the last
 * descent, i.e. the `textBlockHeight` `computeTextStartY` expects. `descent` is
 * negative, as the font metrics report it.
 */
export function computeTextBlockHeight(
  lineCount: number,
  lineHeight: number,
  ascent: number,
  descent: number
): number {
  return Math.max(0, lineCount - 1) * lineHeight + (ascent - descent);
}

export function computeTextX(
  align: "left" | "center" | "right",
  rect: { x: number; width: number },
  textWidth: number,
  indentPts = 0,
  padHLeft = CELL_PADDING_H,
  padHRight = padHLeft
): number {
  let x: number;
  switch (align) {
    case "center":
      x = rect.x + (rect.width - textWidth) / 2;
      break;
    case "right":
      x = rect.x + rect.width - padHRight - textWidth;
      break;
    default:
      x = rect.x + padHLeft + indentPts;
      break;
  }
  // Clamp: don't start before cell left edge
  const minX = rect.x + padHLeft;
  if (x < minX) {
    x = minX;
  }
  return x;
}

function drawTextDecorations(
  stream: PdfContentStream,
  cell: LayoutCell,
  lines: string[],
  lineHeight: number,
  textStartY: number,
  measure: (s: string) => number,
  resourceName: string,
  fontManager: FontManager,
  indentPts: number,
  pad?: CellPadding
): void {
  if (cell.strike) {
    const descent = fontManager.measureTextMetrics(
      lines[0] ?? "",
      resourceName,
      cell.fontSize
    ).descent;
    const strikeY = textStartY + descent + cell.fontSize * 0.3;
    for (let i = 0; i < lines.length; i++) {
      const lineY = strikeY - i * lineHeight;
      const lw = measure(lines[i]);
      const startX = computeTextX(
        cell.horizontalAlign,
        cell.rect,
        lw,
        indentPts,
        pad?.left,
        pad?.right
      );
      stream.drawLine(startX, lineY, startX + lw, lineY, cell.textColor, 0.5);
    }
  }
  if (cell.underline) {
    const descent = fontManager.measureTextMetrics(
      lines[0] ?? "",
      resourceName,
      cell.fontSize
    ).descent;
    const underlineOffset = descent * 0.5;
    for (let i = 0; i < lines.length; i++) {
      const lineY = textStartY - i * lineHeight + underlineOffset;
      const lw = measure(lines[i]);
      const startX = computeTextX(
        cell.horizontalAlign,
        cell.rect,
        lw,
        indentPts,
        pad?.left,
        pad?.right
      );
      stream.drawLine(startX, lineY, startX + lw, lineY, cell.textColor, 0.5);
    }
  }
}

// =============================================================================
// Text Wrapping
// =============================================================================

/**
 * Wrap text into lines that fit within the given width.
 * Uses a greedy word-wrap algorithm.
 */
export function wrapTextLines(
  text: string,
  measure: (s: string) => number,
  maxWidth: number
): string[] {
  if (!text) {
    return [""];
  }

  const paragraphs = text.split(/\r?\n/);
  const allLines: string[] = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      allLines.push("");
      continue;
    }

    // Segments carry their own trailing whitespace, so they are concatenated
    // rather than re-joined with a space. The previous `split(/\s+/)` +
    // `+= " " + word` pair also silently collapsed runs of whitespace, which
    // this no longer does — the cell's own spacing is the author's.
    //
    // Trailing whitespace counts toward the *accumulated* width (the next
    // segment starts after it) but not toward the width being tested, because a
    // space at the end of a line does not occupy the column. Charging it would
    // wrap one segment too early — `"aa bb"` at width 5 would become two lines.
    const words = segmentForWrap(paragraph);
    let currentLine = "";
    let currentWidth = 0;

    for (const word of words) {
      const visible = word.trimEnd();
      const visibleWidth = measure(visible);
      const fullWidth = visible.length === word.length ? visibleWidth : measure(word);

      if (!currentLine) {
        currentLine = word;
        currentWidth = fullWidth;
        continue;
      }

      if (currentWidth + visibleWidth <= maxWidth) {
        currentLine += word;
        currentWidth += fullWidth;
      } else {
        allLines.push(currentLine.trimEnd());
        // Whitespace that lands at a break is consumed by it.
        if (visible === "") {
          currentLine = "";
          currentWidth = 0;
        } else {
          currentLine = word;
          currentWidth = fullWidth;
        }
      }
    }

    if (currentLine) {
      allLines.push(currentLine.trimEnd());
    }
  }

  return allLines.length > 0 ? allLines : [""];
}

/**
 * Word-wrap rich text using per-run font measurements.
 *
 * Unlike `wrapTextLines` which uses a single measure function, this measures
 * each character span at its actual run's font size. This produces correct
 * line breaks when runs have very different sizes (e.g. a 16pt heading followed
 * by 7pt body text).
 *
 * Returns an array of { start, end } character ranges in fullText for each line.
 * This avoids the need for indexOf-based re-positioning which can fail with
 * duplicate text content.
 */
export interface RichTextLineRange {
  start: number;
  end: number;
}

/**
 * Measure a substring of rich text, each span at its own run's font.
 *
 * Shared with the layout pass, which builds `runFontSizes` and `runResources` from
 * a different source but needs the same arithmetic — and, crucially, the same
 * *segmentation*: measuring `[a,c)` in one call and `[a,b) + [b,c)` in two sums
 * different sets of per-run measurements, which is a floating-point difference the
 * two passes must not have between them.
 */
export function measureRichTextRange(
  fullText: string,
  runForChar: readonly number[],
  runFontSizes: readonly number[],
  runResources: readonly string[],
  fontManager: FontManager,
  start: number,
  end: number
): number {
  if (start >= end) {
    return 0;
  }
  let width = 0;
  let segStart = start;
  let currentRi = runForChar[start] ?? 0;
  for (let i = start + 1; i <= end; i++) {
    const ri = i < end ? (runForChar[i] ?? currentRi) : -1;
    if (ri !== currentRi) {
      const seg = fullText.slice(segStart, i);
      width += fontManager.measureText(seg, runResources[currentRi], runFontSizes[currentRi]);
      segStart = i;
      currentRi = ri;
    }
  }
  return width;
}

/**
 * Break rich text into the lines it will be drawn as.
 *
 * **The** rich-text wrapping rule, in one place. The layout pass needs the line
 * *count* to reserve a row's height and the renderer needs the line *ranges* to
 * draw them, and each used to carry its own transcription — the layout's copy
 * comparing `measureRange(lineStart, wordEnd)` against the width while the
 * renderer accumulated `lineWidth += measureRange(previousEnd, wordEnd)`.
 *
 * Those are not the same computation, and they disagreed: with leading whitespace
 * in a paragraph the layout charged the indent to the first line and the renderer
 * did not, so `"   aaa bbb ccc ddd"` reserved three lines and drew two. Earlier the
 * same split had a worse consequence — only the renderer's copy was updated for
 * East Asian breaking, so a Chinese cell reserved one line, drew six, and
 * overprinted itself. The count is now the length of the list that is drawn.
 */
export function wrapRichTextLines(
  fullText: string,
  runForChar: readonly number[],
  runFontSizes: readonly number[],
  runResources: readonly string[],
  fontManager: FontManager,
  maxWidth: number
): RichTextLineRange[] {
  if (!fullText) {
    return [{ start: 0, end: 0 }];
  }

  const measureRange = (start: number, end: number): number =>
    measureRichTextRange(fullText, runForChar, runFontSizes, runResources, fontManager, start, end);

  const allLines: RichTextLineRange[] = [];
  let globalOffset = 0;
  const len = fullText.length;

  // Process paragraph by paragraph (split on newlines)
  while (globalOffset <= len) {
    // Find end of current paragraph
    let paraEnd = fullText.indexOf("\n", globalOffset);
    if (paraEnd === -1) {
      paraEnd = len;
    }

    if (paraEnd === globalOffset) {
      // Empty paragraph
      allLines.push({ start: globalOffset, end: globalOffset });
      globalOffset = paraEnd + 1;
      continue;
    }

    // Handle \r\n: exclude \r from paragraph content
    const paraContentEnd =
      paraEnd > globalOffset && fullText[paraEnd - 1] === "\r" ? paraEnd - 1 : paraEnd;

    if (paraContentEnd === globalOffset) {
      // Paragraph was just \r\n — treat as empty
      allLines.push({ start: globalOffset, end: globalOffset });
      globalOffset = paraEnd + 1;
      continue;
    }

    // Word-wrap this paragraph
    const paraText = fullText.slice(globalOffset, paraContentEnd);
    // Find the placement units within this paragraph.
    //
    // These used to be "runs of non-whitespace", which gave a Chinese paragraph
    // exactly one unit — so it was placed unconditionally as the first word on
    // the line and overflowed the cell however narrow it was. A unit is now
    // delimited by a break opportunity (`@utils/cjk`): after a space or hyphen
    // for Latin, and between characters for East Asian text, with kinsoku
    // applied so a line cannot begin with `。` or `）`. For Latin input the
    // units are identical to the whitespace runs this replaced.
    const units = wrapUnitsOf(paraText);
    const wordStarts = units.map(u => u.start);
    const wordEnds = units.map(u => u.visibleEnd);

    let lineStart = globalOffset;
    let lineEnd = globalOffset;
    let lineWidth = 0;

    for (let wi = 0; wi < wordStarts.length; wi++) {
      const wordStart = globalOffset + wordStarts[wi];
      const wordEnd = globalOffset + wordEnds[wi];
      if (lineEnd === lineStart) {
        // First word on line — always take it.
        lineEnd = wordEnd;
        lineWidth = measureRange(wordStart, wordEnd);
        continue;
      }
      // Widths are additive in the PDF font model (there is no shaping or
      // kerning stage), so measure only the newly appended whitespace + word.
      // Re-measuring the growing line on every word is quadratic for comments
      // and other long rich-text paragraphs.
      const appendedWidth = measureRange(lineEnd, wordEnd);
      if (lineWidth + appendedWidth <= maxWidth) {
        lineEnd = wordEnd;
        lineWidth += appendedWidth;
      } else {
        allLines.push({ start: lineStart, end: lineEnd });
        lineStart = wordStart;
        lineEnd = wordEnd;
        lineWidth = measureRange(wordStart, wordEnd);
      }
    }

    // Emit last line of paragraph
    if (lineEnd > lineStart || wordStarts.length === 0) {
      allLines.push({ start: lineStart, end: Math.max(lineEnd, lineStart) });
    }

    globalOffset = paraEnd + 1;
    if (paraEnd === len) {
      break;
    }
  }

  return allLines.length > 0 ? allLines : [{ start: 0, end: 0 }];
}

// =============================================================================
// Page Header / Footer
// =============================================================================

/**
 * Proportional constants for Excel header/footer text effects. Excel does not
 * publish exact metrics for these, so the ratios are approximations chosen to
 * read correctly between 8 pt and 36 pt.
 */
const HEADER_FOOTER_METRICS = {
  /** Baseline inset from the top of the header band. */
  ASCENT_RATIO: 0.75,
  /** Baseline inset from the bottom of the footer band. */
  DESCENT_RATIO: 0.25,
  /** `&X` superscript rise, as a fraction of font size. */
  SUPERSCRIPT_RISE: 0.35,
  /** `&Y` subscript drop, as a fraction of font size. */
  SUBSCRIPT_DROP: 0.2,
  /** `&S` strike-through height, as a fraction of font size. */
  STRIKE_RATIO: 0.3,
  /** `&O` outline stroke width, as a fraction of font size. */
  OUTLINE_WIDTH_RATIO: 1 / 30,
  /** Gutter used when `alignWithMargins` is disabled. */
  UNPINNED_EDGE_INSET: 18
} as const;

/** `&H` shadow colour — Excel renders a flat grey drop shadow. */
const HEADER_FOOTER_SHADOW_COLOR: PdfColor = { r: 0.5, g: 0.5, b: 0.5 };

function drawExcelHeaderFooter(
  stream: PdfContentStream,
  page: LayoutPage,
  options: ResolvedPdfOptions,
  fontManager: FontManager,
  content: PdfHeaderFooterContent,
  kind: "header" | "footer"
): void {
  const alignWithMargins = page.headerFooter?.alignWithMargins !== false;
  const leftEdge = alignWithMargins
    ? options.margins.left
    : HEADER_FOOTER_METRICS.UNPINNED_EDGE_INSET;
  const rightEdge = alignWithMargins
    ? page.width - options.margins.right
    : page.width - HEADER_FOOTER_METRICS.UNPINNED_EDGE_INSET;
  const center = page.width / 2;
  const baseline =
    kind === "header"
      ? page.height -
        options.headerMargin -
        maxRunFontSize(content) * HEADER_FOOTER_METRICS.ASCENT_RATIO
      : options.footerMargin - maxRunFontSize(content) * HEADER_FOOTER_METRICS.DESCENT_RATIO;

  drawHeaderFooterSection(
    stream,
    page,
    fontManager,
    content.left,
    leftEdge,
    baseline,
    "left",
    kind
  );
  drawHeaderFooterSection(
    stream,
    page,
    fontManager,
    content.center,
    center,
    baseline,
    "center",
    kind
  );
  drawHeaderFooterSection(
    stream,
    page,
    fontManager,
    content.right,
    rightEdge,
    baseline,
    "right",
    kind
  );
}

function maxRunFontSize(content: PdfHeaderFooterContent): number {
  let max = 11;
  for (const runs of [content.left, content.center, content.right]) {
    for (const run of runs) {
      max = Math.max(max, run.fontSize);
    }
  }
  return max;
}

function drawHeaderFooterSection(
  stream: PdfContentStream,
  page: LayoutPage,
  fontManager: FontManager,
  runs: PdfHeaderFooterRun[],
  anchorX: number,
  baseline: number,
  alignment: "left" | "center" | "right",
  kind: "header" | "footer"
): void {
  const lines: Array<Array<{ run: PdfHeaderFooterRun; text: string }>> = [[]];
  for (const run of runs.filter(run => run.field !== "image")) {
    const text = resolveHeaderFooterRunText(run, page);
    const parts = text.split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
      }
      if (parts[i]) {
        lines[lines.length - 1].push({ run, text: parts[i] });
      }
    }
  }
  const lineHeight =
    Math.max(11, maxRunFontSize({ left: runs, center: [], right: [] })) * LINE_HEIGHT_FACTOR;
  const firstBaseline = kind === "footer" ? baseline + (lines.length - 1) * lineHeight : baseline;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const resolved = resolveLineRuns(lines[lineIndex], page, fontManager);
    const totalWidth = resolved.reduce((sum, item) => sum + item.width, 0);
    let x =
      alignment === "center"
        ? anchorX - totalWidth / 2
        : alignment === "right"
          ? anchorX - totalWidth
          : anchorX;
    const lineBaseline = firstBaseline - lineIndex * lineHeight;

    for (const item of resolved) {
      const { run, text, resourceName, fontSize, width } = item;
      const shift = run.superscript
        ? fontSize * HEADER_FOOTER_METRICS.SUPERSCRIPT_RISE
        : run.subscript
          ? -fontSize * HEADER_FOOTER_METRICS.SUBSCRIPT_DROP
          : 0;
      // Header/footer runs carry their own `&K` colors, which bypass the cell
      // style pipeline — apply black-and-white here.
      const bw = page.options.blackAndWhite;
      const rawColor = run.color ?? { r: 0, g: 0, b: 0 };
      const color = bw ? toGrayscale(rawColor) : rawColor;
      stream.save();
      stream.setFillColor(color);
      stream.setStrokeColor(color);
      stream.setLineWidth(Math.max(0.25, fontSize * HEADER_FOOTER_METRICS.OUTLINE_WIDTH_RATIO));
      if (run.shadow) {
        stream.setFillColor(HEADER_FOOTER_SHADOW_COLOR);
        emitTextWithMatrix(stream, fontManager, {
          text,
          matrix: [1, 0, 0, 1, x + 1, lineBaseline + shift - 1],
          resourceName,
          fontSize
        });
        stream.setFillColor(color);
      }
      emitTextWithMatrix(stream, fontManager, {
        text,
        matrix: [1, 0, 0, 1, x, lineBaseline + shift],
        resourceName,
        fontSize,
        renderingMode: run.outline ? 1 : 0
      });
      const lineWidth = 0.5;
      const decorationY = lineBaseline - 1;
      if (run.underline || run.doubleUnderline) {
        stream.drawLine(x, decorationY, x + width, decorationY, color, lineWidth);
        if (run.doubleUnderline) {
          stream.drawLine(x, decorationY - 2, x + width, decorationY - 2, color, lineWidth);
        }
      }
      if (run.strike) {
        const strikeY = lineBaseline + fontSize * HEADER_FOOTER_METRICS.STRIKE_RATIO;
        stream.drawLine(x, strikeY, x + width, strikeY, color, lineWidth);
      }
      stream.restore();
      x += width;
    }
  }
}

function resolveLineRuns(
  line: Array<{ run: PdfHeaderFooterRun; text: string }>,
  page: LayoutPage,
  fontManager: FontManager
): Array<{
  run: PdfHeaderFooterRun;
  text: string;
  resourceName: string;
  fontSize: number;
  width: number;
}> {
  return line.map(({ run, text }) => {
    const resourceName = fontManager.resolveFont(
      resolveHeaderFooterFontFamily(run, page),
      run.bold,
      run.italic
    );
    const fontSize =
      run.fontSize * (page.headerFooter?.scaleWithDoc === false ? 1 : page.scaleFactor);
    const width = fontManager.measureText(text, resourceName, fontSize);
    return { run, text, resourceName, fontSize, width };
  });
}

// =============================================================================
// Row / Column Headings
// =============================================================================

/** Convert a 1-based column number to its Excel letters (1 → "A", 27 → "AA"). */
function columnNumberToLetters(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Draw Excel's printed row numbers and column letters around the grid.
 *
 * The bands occupy space reserved by the layout engine (see
 * `computeHeadingMetrics`), so the grid origin already accounts for them and
 * nothing here can push content off the page.
 */
function drawRowColHeadings(
  stream: PdfContentStream,
  page: LayoutPage,
  options: ResolvedPdfOptions,
  fontManager: FontManager
): void {
  const headings = page.headings;
  if (!headings || page.columnWidths.length === 0 || page.rowHeights.length === 0) {
    return;
  }

  const { gutterWidth, bandHeight, fontSize } = headings;
  const resourceName = fontManager.resolveFont(options.defaultFontFamily, false, false);

  // The heading palette is already neutral gray, so black-and-white needs no
  // conversion here.
  const fill = HEADING_FILL;
  const rule = HEADING_RULE;
  const textColor = HEADING_TEXT;

  const gridLeft = page.columnOffsets[0];
  const lastCol = page.columnWidths.length - 1;
  const gridRight = page.columnOffsets[lastCol] + page.columnWidths[lastCol];
  const gridTop = page.rowYPositions[0];
  const lastRow = page.rowHeights.length - 1;
  const gridBottom = page.rowYPositions[lastRow] - page.rowHeights[lastRow];

  stream.save();

  // Band backgrounds: column letters above the grid, row numbers to its left,
  // plus the corner square where the two meet.
  stream.fillRect(gridLeft, gridTop, gridRight - gridLeft, bandHeight, fill);
  stream.fillRect(gridLeft - gutterWidth, gridBottom, gutterWidth, gridTop - gridBottom, fill);
  stream.fillRect(gridLeft - gutterWidth, gridTop, gutterWidth, bandHeight, fill);

  // Rules: one per column boundary through the top band, one per row boundary
  // through the gutter, and the two outer edges.
  stream.setStrokeColor(rule);
  stream.setLineWidth(0.25);
  for (let i = 0; i <= page.columnWidths.length; i++) {
    const x =
      i < page.columnWidths.length
        ? page.columnOffsets[i]
        : page.columnOffsets[i - 1] + page.columnWidths[i - 1];
    stream.moveTo(x, gridTop);
    stream.lineTo(x, gridTop + bandHeight);
  }
  for (let i = 0; i <= page.rowYPositions.length; i++) {
    const y =
      i < page.rowYPositions.length
        ? page.rowYPositions[i]
        : page.rowYPositions[i - 1] - page.rowHeights[i - 1];
    stream.moveTo(gridLeft - gutterWidth, y);
    stream.lineTo(gridLeft, y);
  }
  stream.moveTo(gridLeft - gutterWidth, gridTop + bandHeight);
  stream.lineTo(gridRight, gridTop + bandHeight);
  stream.moveTo(gridLeft - gutterWidth, gridBottom);
  stream.lineTo(gridLeft - gutterWidth, gridTop + bandHeight);
  stream.stroke();

  // Labels, centered in their band cell.
  stream.setFillColor(textColor);
  // Labels are `A`..`XFD` and row numbers — one face, so one measurement. This
  // is `computeTextStartY`'s middle case with no padding: centring on the em
  // square instead (`(band - fontSize) / 2 + fontSize * 0.2`) leans the label
  // low by half the difference between the em square and the ink.
  const labelAscent = fontManager.getFontAscent(resourceName, fontSize);
  const labelDescent = fontManager.getFontDescent(resourceName, fontSize);
  const labelBaseline = (bandBottom: number, bandSize: number) =>
    bandBottom + bandSize / 2 - (labelAscent + labelDescent) / 2;

  for (let i = 0; i < page.sheetCols.length; i++) {
    const label = columnNumberToLetters(page.sheetCols[i]);
    const w = fontManager.measureText(label, resourceName, fontSize);
    const x = page.columnOffsets[i] + (page.columnWidths[i] - w) / 2;
    emitTextWithMatrix(stream, fontManager, {
      text: label,
      matrix: [1, 0, 0, 1, x, labelBaseline(gridTop, bandHeight)],
      resourceName,
      fontSize
    });
  }

  for (let i = 0; i < page.sheetRows.length; i++) {
    const label = String(page.sheetRows[i]);
    const w = fontManager.measureText(label, resourceName, fontSize);
    const rowH = page.rowHeights[i];
    const x = gridLeft - gutterWidth + (gutterWidth - w) / 2;
    const y = labelBaseline(page.rowYPositions[i] - rowH, rowH);
    emitTextWithMatrix(stream, fontManager, {
      text: label,
      matrix: [1, 0, 0, 1, x, y],
      resourceName,
      fontSize
    });
  }

  stream.restore();
}

/**
 * Draw Excel's on-sheet comment boxes and their cell corner markers.
 *
 * Positioned by the layout engine, so this only has to paint: a pale note-yellow
 * box with a thin border, the wrapped body inside it, and the small red triangle
 * Excel puts in the commented cell's top-right corner.
 */
function drawCommentBoxes(
  stream: PdfContentStream,
  page: LayoutPage,
  options: ResolvedPdfOptions,
  fontManager: FontManager
): void {
  const boxes = page.commentBoxes;
  if (!boxes?.length) {
    return;
  }

  const bw = options.blackAndWhite;
  const fill = bw ? toGrayscale(COMMENT_FILL) : COMMENT_FILL;
  const border = bw ? toGrayscale(COMMENT_BORDER) : COMMENT_BORDER;
  const markerColor = bw ? toGrayscale(COMMENT_MARKER_COLOR) : COMMENT_MARKER_COLOR;
  const resourceName = fontManager.resolveFont(options.defaultFontFamily, false, false);

  for (const box of boxes) {
    const { rect } = box;
    stream.save();
    stream.fillRect(rect.x, rect.y, rect.width, rect.height, fill);
    stream.setStrokeColor(border);
    stream.setLineWidth(0.5);
    stream.rect(rect.x, rect.y, rect.width, rect.height);
    stream.stroke();

    // Body text, wrapped to the box and clipped by simply stopping once the
    // remaining height is used up.
    const lineHeight = box.fontSize * LINE_HEIGHT_FACTOR;
    const innerWidth = Math.max(rect.width - 2 * CELL_PADDING_H, 1);
    const measure = (t: string) => fontManager.measureText(t, resourceName, box.fontSize);
    const lines = box.text.split("\n").flatMap(part => wrapTextLines(part, measure, innerWidth));
    stream.setFillColor(bw ? toGrayscale({ r: 0, g: 0, b: 0 }) : { r: 0, g: 0, b: 0 });
    // Top-aligned like a cell: the first line's ascent sits one padding below
    // the box top. Stepping down by the font size instead would drop the whole
    // note by the difference between the em square and the ascent.
    const ascent = fontManager.measureTextMetrics(
      lines[0] ?? "",
      resourceName,
      box.fontSize
    ).ascent;
    let baseline = rect.y + rect.height - CELL_PADDING_V - ascent;

    stream.save();
    stream.rect(rect.x, rect.y, rect.width, rect.height).clip().endPath();
    for (const line of lines) {
      const descent = fontManager.measureTextMetrics(line, resourceName, box.fontSize).descent;
      if (baseline + descent < rect.y + CELL_PADDING_V) {
        break;
      }
      emitTextWithMatrix(stream, fontManager, {
        text: line,
        matrix: [1, 0, 0, 1, rect.x + CELL_PADDING_H, baseline],
        resourceName,
        fontSize: box.fontSize
      });
      baseline -= lineHeight;
    }
    stream.restore();
    stream.restore();

    if (box.marker) {
      const { x, y, size } = box.marker;
      stream.save();
      stream.setFillColor(markerColor);
      stream.moveTo(x - size, y);
      stream.lineTo(x, y);
      stream.lineTo(x, y - size);
      stream.closePath();
      stream.fill();
      stream.restore();
    }
  }
}

function drawPageHeader(
  stream: PdfContentStream,
  page: LayoutPage,
  options: ResolvedPdfOptions,
  fontManager: FontManager
): void {
  const headerFontSize = 10;
  const headerText = page.sheetName;
  const resourceName = fontManager.resolveFont(options.defaultFontFamily, true, false);

  const textWidth = fontManager.measureText(headerText, resourceName, headerFontSize);
  const x = (page.width - textWidth) / 2;
  const y = page.height - options.margins.top + 5;

  stream.save();
  stream.setFillColor({ r: 0.3, g: 0.3, b: 0.3 });
  emitTextWithMatrix(stream, fontManager, {
    text: headerText,
    matrix: [1, 0, 0, 1, x, y],
    resourceName,
    fontSize: headerFontSize
  });
  stream.restore();
}

function drawPageFooter(
  stream: PdfContentStream,
  page: LayoutPage,
  options: ResolvedPdfOptions,
  fontManager: FontManager,
  totalPages: number
): void {
  const footerFontSize = 9;
  const footerText = `Page ${page.pageNumber} of ${totalPages}`;
  const resourceName = fontManager.resolveFont(options.defaultFontFamily, false, false);

  const textWidth = fontManager.measureText(footerText, resourceName, footerFontSize);
  const x = (page.width - textWidth) / 2;
  const y = Math.max(5, options.margins.bottom - 15);

  stream.save();
  stream.setFillColor({ r: 0.5, g: 0.5, b: 0.5 });
  emitTextWithMatrix(stream, fontManager, {
    text: footerText,
    matrix: [1, 0, 0, 1, x, y],
    resourceName,
    fontSize: footerFontSize
  });
  stream.restore();
}

// =============================================================================
// Watermark Rendering
// =============================================================================

/** Default values for text watermarks. */
const TEXT_WM_DEFAULTS = {
  fontSize: 54,
  color: { r: 0.75, g: 0.75, b: 0.75 } as PdfColor,
  opacity: 0.15,
  rotation: -45,
  fontFamily: "Helvetica",
  bold: false,
  italic: false,
  repeatSpacingX: 200,
  repeatSpacingY: 200
};

/** Default values for image watermarks. */
const IMAGE_WM_DEFAULTS = {
  opacity: 0.15,
  rotation: 0,
  scale: 0.5,
  repeatSpacingX: 200,
  repeatSpacingY: 200
};

/** Minimum allowed spacing for repeat patterns (prevents infinite loops). */
const MIN_REPEAT_SPACING = 10;

/**
 * Result of rendering a watermark on a page.
 * Contains any alpha values and image XObjects that need to be registered
 * in the page's resource dictionary.
 */
export interface WatermarkRenderResult {
  /** Alpha values used by the watermark. */
  alphaValues: number[];
  /** Image XObject entries: name → raw image data + format. */
  imageXObjects: Array<{ name: string; data: Uint8Array; format: "jpeg" | "png" }>;
}

/**
 * Render a watermark onto a PDF content stream.
 * This should be called BEFORE the cell/grid content is rendered so the
 * watermark sits behind everything (under-content).
 */
export function renderWatermark(
  stream: PdfContentStream,
  page: LayoutPage,
  watermark: PdfWatermark,
  fontManager: FontManager
): WatermarkRenderResult {
  if (watermark.type === "text") {
    return renderTextWatermark(stream, page, normalizeTextWatermark(watermark), fontManager);
  }
  return renderImageWatermark(stream, page, normalizeImageWatermark(watermark));
}

/** Clamp/normalize text watermark options to safe ranges. */
function normalizeTextWatermark(wm: PdfTextWatermark): PdfTextWatermark {
  return {
    ...wm,
    opacity: clamp01(wm.opacity ?? TEXT_WM_DEFAULTS.opacity),
    fontSize: Math.max(1, wm.fontSize ?? TEXT_WM_DEFAULTS.fontSize),
    repeatSpacingX: Math.max(
      MIN_REPEAT_SPACING,
      wm.repeatSpacingX ?? TEXT_WM_DEFAULTS.repeatSpacingX
    ),
    repeatSpacingY: Math.max(
      MIN_REPEAT_SPACING,
      wm.repeatSpacingY ?? TEXT_WM_DEFAULTS.repeatSpacingY
    )
  };
}

/** Clamp/normalize image watermark options to safe ranges. */
function normalizeImageWatermark(wm: PdfImageWatermark): PdfImageWatermark {
  return {
    ...wm,
    opacity: clamp01(wm.opacity ?? IMAGE_WM_DEFAULTS.opacity),
    scale: Math.max(0.01, wm.scale ?? IMAGE_WM_DEFAULTS.scale),
    width: wm.width !== undefined ? Math.max(1, wm.width) : undefined,
    height: wm.height !== undefined ? Math.max(1, wm.height) : undefined,
    repeatSpacingX: Math.max(
      MIN_REPEAT_SPACING,
      wm.repeatSpacingX ?? IMAGE_WM_DEFAULTS.repeatSpacingX
    ),
    repeatSpacingY: Math.max(
      MIN_REPEAT_SPACING,
      wm.repeatSpacingY ?? IMAGE_WM_DEFAULTS.repeatSpacingY
    )
  };
}

/** Clamp a number to the 0..1 range. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Render a text watermark on a single page.
 */
function renderTextWatermark(
  stream: PdfContentStream,
  page: LayoutPage,
  watermark: PdfTextWatermark,
  fontManager: FontManager
): WatermarkRenderResult {
  const fontSize = watermark.fontSize ?? TEXT_WM_DEFAULTS.fontSize;
  const rawColor = watermark.color ?? TEXT_WM_DEFAULTS.color;
  const color = page.options.blackAndWhite ? toGrayscale(rawColor) : rawColor;
  const opacity = watermark.opacity ?? TEXT_WM_DEFAULTS.opacity;
  const rotation = watermark.rotation ?? TEXT_WM_DEFAULTS.rotation;
  const fontFamily = watermark.fontFamily ?? TEXT_WM_DEFAULTS.fontFamily;
  const bold = watermark.bold ?? TEXT_WM_DEFAULTS.bold;
  const italic = watermark.italic ?? TEXT_WM_DEFAULTS.italic;

  const resourceName = fontManager.resolveFont(fontFamily, bold, italic);

  const metrics = fontManager.measureTextMetrics(watermark.text, resourceName, fontSize);
  const textWidth = metrics.width;
  // Distance from the block's centre down to its baseline. Half the ascent —
  // never mind `0.7 * fontSize` for the ascent itself — ignores the descender
  // and rides the whole watermark high by half of it, which at watermark sizes
  // is several points off centre.
  const halfH = (metrics.ascent + metrics.descent) / 2;

  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const needsAlpha = opacity < 1;
  const gsName = needsAlpha ? alphaGsName(opacity) : "";

  const drawSingleWatermark = (cx: number, cy: number) => {
    // Center the text at (cx, cy), compensating for both width and ink height
    const halfW = textWidth / 2;
    const tx = cx - halfW * cos + halfH * sin;
    const ty = cy - halfW * sin - halfH * cos;

    stream.save();
    if (needsAlpha) {
      stream.setGraphicsState(gsName);
    }
    stream.setFillColor(color);
    emitTextWithMatrix(stream, fontManager, {
      text: watermark.text,
      matrix: [cos, sin, -sin, cos, tx, ty],
      resourceName,
      fontSize
    });
    stream.restore();
  };

  if (watermark.repeat) {
    const spacingX = watermark.repeatSpacingX ?? TEXT_WM_DEFAULTS.repeatSpacingX;
    const spacingY = watermark.repeatSpacingY ?? TEXT_WM_DEFAULTS.repeatSpacingY;
    renderRepeatedPattern(page.width, page.height, spacingX, spacingY, drawSingleWatermark);
  } else {
    const { cx, cy } = resolveWatermarkCenter(page, watermark.position);
    drawSingleWatermark(cx, cy);
  }

  return { alphaValues: needsAlpha ? [opacity] : [], imageXObjects: [] };
}

/**
 * Render an image watermark on a single page.
 */
function renderImageWatermark(
  stream: PdfContentStream,
  page: LayoutPage,
  watermark: PdfImageWatermark
): WatermarkRenderResult {
  const opacity = watermark.opacity ?? IMAGE_WM_DEFAULTS.opacity;
  const rotation = watermark.rotation ?? IMAGE_WM_DEFAULTS.rotation;
  const scale = watermark.scale ?? IMAGE_WM_DEFAULTS.scale;
  const needsAlpha = opacity < 1;

  // Determine image dimensions — use explicit width/height if provided,
  // otherwise parse actual dimensions from image data and scale proportionally
  let imgWidth: number;
  let imgHeight: number;
  if (watermark.width !== undefined && watermark.height !== undefined) {
    imgWidth = watermark.width;
    imgHeight = watermark.height;
  } else {
    const dims = parseImageDimensions(watermark.data, watermark.format);
    const minDim = Math.min(page.width, page.height);
    const targetSize = minDim * scale;
    const maxDim = Math.max(dims.width, dims.height);
    const ratio = maxDim > 0 ? targetSize / maxDim : 1;
    imgWidth = dims.width * ratio;
    imgHeight = dims.height * ratio;
  }

  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const gsName = needsAlpha ? alphaGsName(opacity) : "";
  const imgName = "WmImg";

  const drawSingleWatermark = (cx: number, cy: number) => {
    stream.save();
    if (needsAlpha) {
      stream.setGraphicsState(gsName);
    }
    const halfW = imgWidth / 2;
    const halfH = imgHeight / 2;
    const tx = cx - halfW * cos + halfH * sin;
    const ty = cy - halfW * sin - halfH * cos;

    stream.concat(imgWidth * cos, imgWidth * sin, -imgHeight * sin, imgHeight * cos, tx, ty);
    stream.doXObject(imgName);
    stream.restore();
  };

  if (watermark.repeat) {
    const spacingX = watermark.repeatSpacingX ?? IMAGE_WM_DEFAULTS.repeatSpacingX;
    const spacingY = watermark.repeatSpacingY ?? IMAGE_WM_DEFAULTS.repeatSpacingY;
    renderRepeatedPattern(page.width, page.height, spacingX, spacingY, drawSingleWatermark);
  } else {
    const { cx, cy } = resolveWatermarkCenter(page, watermark.position);
    drawSingleWatermark(cx, cy);
  }

  return {
    alphaValues: needsAlpha ? [opacity] : [],
    imageXObjects: [{ name: imgName, data: watermark.data, format: watermark.format }]
  };
}

/**
 * Parse image dimensions from raw JPEG or PNG data without a full decode.
 */
/**
 * Resolve the center position for a watermark on a given page.
 */
function resolveWatermarkCenter(
  page: LayoutPage,
  position?: "center" | { x: number; y: number }
): { cx: number; cy: number } {
  if (!position || position === "center") {
    return { cx: page.width / 2, cy: page.height / 2 };
  }
  return { cx: position.x, cy: position.y };
}

/**
 * Render a repeated pattern of watermarks across the entire page.
 * Uses a staggered grid for a natural diagonal tiling effect.
 */
function renderRepeatedPattern(
  pageWidth: number,
  pageHeight: number,
  spacingX: number,
  spacingY: number,
  drawFn: (cx: number, cy: number) => void
): void {
  // Start from beyond the page edges to ensure full coverage with rotation
  const margin = Math.max(pageWidth, pageHeight) * 0.5;
  let rowIndex = 0;

  for (let y = -margin; y < pageHeight + margin; y += spacingY) {
    // Stagger every other row by half the horizontal spacing
    const offsetX = rowIndex % 2 === 1 ? spacingX / 2 : 0;
    for (let x = -margin; x < pageWidth + margin; x += spacingX) {
      drawFn(x + offsetX, y);
    }
    rowIndex++;
  }
}
