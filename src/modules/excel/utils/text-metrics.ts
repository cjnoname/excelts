/**
 * Text measurement engine for auto-fit column width and row height calculation.
 *
 * ## Algorithm Summary
 *
 * **Width calculation** follows a 3-tier approach:
 *
 * 1. **Calibri 11pt**: Use pre-computed bitmap pixel widths (exact match with Excel)
 * 2. **Known fonts at any size**: Use FUnit advance widths with the formula:
 *    `pixelWidth = ROUND(advanceFU / unitsPerEm * ROUND(fontSize / 72 * 96))`
 * 3. **Unknown fonts**: Fall back to category-average width factors
 *
 * **Height calculation** uses an independently verified formula:
 *    `lineHeight = (unitsPerEm + usWinDescent) / unitsPerEm * fontSizePx`
 *
 * **Unit conversions** follow the ECMA-376 spec:
 * - Column width in XLSX = `TRUNC(pixelWidth / MDW * 256) / 256`
 * - MDW = max digit width in pixels (Calibri 11pt: 7)
 * - Pixel Padding (PP) = `2 * CEIL(MDW / 4) + 1`
 *
 * ## Key References
 * - ECMA-376 §18.3.1.13 (col width)
 */

import { ValueType } from "@excel/core/enums";
import type { Font, Alignment, NumFmt, RichText } from "@excel/types";
import { getCellDisplayText } from "@excel/utils/cell-format";
import type { FontMetrics } from "@utils/font-data";
import { getFontMetrics } from "@utils/font-data";
import { _measureCharPx, measureTextWidthPx, resolveFont } from "@utils/text-measure";
import type { MeasuredFont } from "@utils/text-measure";
import { charWidthToPixel, getPixelPadding, pixelToCharWidth, pixelToPoints } from "@utils/units";

// =============================================================================
// Constants
// =============================================================================

/** Default DPI for Excel rendering */
const DPI = 96;

/** Default font size in points */
const DEFAULT_FONT_SIZE = 11;

/** Default font name */
const DEFAULT_FONT_NAME = "Calibri";

/** Maximum auto-fit column width in pixels (~255 characters) */
const MAX_AUTOFIT_WIDTH_PX = 1790;

/** Maximum auto-fit column width in character units */
const MAX_COLUMN_WIDTH = 255;

/** Autofilter dropdown arrow width in pixels at 96 DPI */
const AUTOFILTER_ARROW_PX = 16;

// =============================================================================
// Text Width Measurement
// =============================================================================

/**
 * Re-exported from `@utils/text-measure`, where the glyph-advance measurement now lives
 * so that the drawing engine and anything beside it can reach it. Kept exported here
 * because this is the path the Excel module has always imported it from, and a cell
 * measurer is where a reader looks for it.
 *
 * Re-exported straight from the source rather than through a local binding, so the
 * statement does not depend on an import appearing above it.
 */
export { getMaxDigitWidth, measureTextWidthPx } from "@utils/text-measure";
export type { MeasuredFont } from "@utils/text-measure";

/** A `Font` reduced to what measurement reads. */
type ResolvedFont = MeasuredFont;

// =============================================================================
// Rich Text Width Measurement
// =============================================================================

/**
 * Measure the pixel width of rich text (mixed fonts).
 * Each run may have a different font; width is summed per run.
 * Line breaks reset the accumulator.
 */
export function measureRichTextWidthPx(richText: RichText[], defaultFont?: Partial<Font>): number {
  let maxLineWidth = 0;
  let currentLineWidth = 0;

  for (const run of richText) {
    const font = run.font ? { ...defaultFont, ...run.font } : defaultFont;

    // Handle newlines within a run
    const parts = run.text.split(/\r\n|\r|\n/);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // New line: save current line width and reset
        if (currentLineWidth > maxLineWidth) {
          maxLineWidth = currentLineWidth;
        }
        currentLineWidth = 0;
      }
      if (parts[i]) {
        currentLineWidth += measureTextWidthPx(parts[i], font);
      }
    }
  }

  if (currentLineWidth > maxLineWidth) {
    maxLineWidth = currentLineWidth;
  }

  return maxLineWidth;
}

// =============================================================================
// Unit Conversions (ECMA-376 formulas)
// =============================================================================

/**
 * Column-width / pixel / point conversions live in the shared, dependency-free
 * `@utils/units` module so the PDF layout engine can reuse the exact same
 * formulae. Re-exported here to preserve the historical `@excel/utils/text-metrics`
 * import surface.
 */
export {
  getPixelPadding,
  pixelToCharWidth,
  charWidthToPixel,
  pixelToPoints,
  pointsToPixel
} from "@utils/units";

// =============================================================================
// Auto-Fit Column Width
// =============================================================================

/**
 * Calculate the auto-fit column width in character units for a cell's text.
 *
 * This is the main entry point for column auto-fit calculation.
 *
 * @param textWidthPx - The pixel width of the cell's text content
 * @param mdw - Max digit width in pixels for the workbook's default font
 * @param hasAutoFilter - Whether the column is part of an auto-filter
 * @returns Column width in Excel character units
 */
export function calculateAutoFitWidth(
  textWidthPx: number,
  mdw: number,
  hasAutoFilter?: boolean
): number {
  if (textWidthPx <= 0) {
    return 0;
  }

  // Padding formula:
  // oneSidePadding = CEIL(textWidth * 0.03 + mdw / 4)
  // totalWidth = textWidth + 2 * oneSidePadding + 1 (gridline)
  const oneSidePadding = Math.ceil(textWidthPx * 0.03 + mdw / 4);
  let totalPx = textWidthPx + 2 * oneSidePadding + 1;

  // Add autofilter dropdown space
  if (hasAutoFilter) {
    totalPx += AUTOFILTER_ARROW_PX;
  }

  // Clamp to maximum
  if (totalPx > MAX_AUTOFIT_WIDTH_PX) {
    totalPx = MAX_AUTOFIT_WIDTH_PX;
  }

  // Convert to character units
  const charWidth = pixelToCharWidth(totalPx, mdw);
  return Math.min(charWidth, MAX_COLUMN_WIDTH);
}

// =============================================================================
// Auto-Fit Row Height
// =============================================================================

/**
 * Calculate the line height in pixels for a font.
 *
 * Uses the formula:
 *   lineHeight = (unitsPerEm + usWinDescent) / unitsPerEm * fontSizePx
 *
 * This matches Excel's actual row height calculation.
 */
export function getLineHeightPx(font?: Partial<Font>): number {
  const name = (font?.name ?? DEFAULT_FONT_NAME).toLowerCase();
  const size = font?.size ?? DEFAULT_FONT_SIZE;
  const fontSizePx = Math.round((size / 72) * DPI);

  const metrics = getFontMetrics(name);
  if (metrics) {
    const { unitsPerEm, usWinDescent } = metrics.header;
    return ((unitsPerEm + usWinDescent) / unitsPerEm) * fontSizePx;
  }

  // Fallback: approximate. The ratio for most fonts is ~1.2 to 1.35.
  // Calibri is (2048 + 550) / 2048 = 1.268. Use 1.3 as a safe default.
  return fontSizePx * 1.3;
}

/**
 * Calculate the number of wrapped lines for text in a column of given width.
 *
 * Excel wraps text at word boundaries (spaces, hyphens) rather than at
 * arbitrary character positions. If a single word is wider than the column,
 * it overflows (Excel does not break mid-word in normal wrap mode).
 *
 * @param text - The cell text (may contain explicit newlines)
 * @param columnWidthPx - Available column width in pixels (content area, excluding padding)
 * @param font - Cell font
 * @returns Number of lines the text will occupy
 */
export function calculateWrappedLineCount(
  text: string,
  columnWidthPx: number,
  font?: Partial<Font>
): number {
  if (!text || columnWidthPx <= 0) {
    return 1;
  }

  const resolved = resolveFont(font);
  const metrics = getFontMetrics(resolved.name, resolved.bold);
  const lines = text.split(/\r\n|\r|\n/);
  let totalLines = 0;

  for (const line of lines) {
    if (!line) {
      totalLines++;
      continue;
    }

    totalLines += _countWrappedLines(line, columnWidthPx, resolved, metrics);
  }

  return totalLines;
}

/**
 * Count wrapped lines for a single line (no explicit newlines) using
 * word-boundary wrapping that matches Excel behavior.
 *
 * Excel breaks at spaces and hyphens. If a single word exceeds the column
 * width, the word overflows on its line (Excel does not mid-word break).
 */
function _countWrappedLines(
  line: string,
  columnWidthPx: number,
  resolved: ResolvedFont,
  metrics: FontMetrics | undefined
): number {
  // Split line into "words" — segments separated by spaces or hyphens.
  // The delimiter (space/hyphen) is included at the end of the preceding word,
  // matching how Excel accounts for space width before breaking.
  const words = _splitIntoWords(line);

  if (words.length === 0) {
    return 1;
  }

  let lineCount = 1;
  let currentWidth = 0;

  for (const word of words) {
    // Measure word width
    let wordWidth = 0;
    for (const char of word) {
      wordWidth += _measureCharPx(char.codePointAt(0)!, resolved, metrics);
    }

    if (currentWidth === 0) {
      // First word on line: always place it (even if wider than column)
      currentWidth = wordWidth;
    } else if (currentWidth + wordWidth > columnWidthPx) {
      // Word doesn't fit on current line: wrap
      lineCount++;
      currentWidth = wordWidth;
    } else {
      // Word fits: accumulate
      currentWidth += wordWidth;
    }
  }

  return lineCount;
}

/**
 * Split a line into words for wrapping purposes.
 * Delimiters (space, hyphen) are kept at the end of the preceding word.
 * This matches Excel's wrapping behavior where the space is consumed
 * before the line break.
 *
 * "Hello World" → ["Hello ", "World"]
 * "one-two-three" → ["one-", "two-", "three"]
 * "a  b" → ["a ", " ", "b"]
 */
function _splitIntoWords(line: string): string[] {
  const words: string[] = [];
  let current = "";

  for (const char of line) {
    current += char;
    // Break after spaces and hyphens
    if (char === " " || char === "-" || char === "\t") {
      words.push(current);
      current = "";
    }
  }
  if (current) {
    words.push(current);
  }

  return words;
}

/**
 * Calculate the auto-fit row height in points for a cell.
 *
 * @param text - Cell display text
 * @param font - Cell font
 * @param alignment - Cell alignment (for wrapText check)
 * @param columnWidthPx - Column content width in pixels (needed for wrapText)
 * @returns Row height in points
 */
export function calculateAutoFitHeight(
  text: string,
  font?: Partial<Font>,
  alignment?: Partial<Alignment>,
  columnWidthPx?: number
): number {
  if (!text) {
    return pixelToPoints(getLineHeightPx(font));
  }

  const lineHeightPx = getLineHeightPx(font);
  let lineCount: number;

  if (alignment?.wrapText && columnWidthPx && columnWidthPx > 0) {
    lineCount = calculateWrappedLineCount(text, columnWidthPx, font);
  } else {
    // Count explicit newlines only
    lineCount = text.split(/\r\n|\r|\n/).length;
  }

  return pixelToPoints(lineHeightPx * lineCount);
}

/**
 * Calculate the auto-fit row height for rich text.
 */
export function calculateRichTextAutoFitHeight(
  richText: RichText[],
  defaultFont?: Partial<Font>,
  alignment?: Partial<Alignment>,
  columnWidthPx?: number
): number {
  // Find the largest font in any run (determines line height)
  let maxFontSize = defaultFont?.size ?? DEFAULT_FONT_SIZE;
  let maxFontForHeight: Partial<Font> | undefined = defaultFont;

  for (const run of richText) {
    const runSize = run.font?.size ?? defaultFont?.size ?? DEFAULT_FONT_SIZE;
    if (runSize > maxFontSize) {
      maxFontSize = runSize;
      maxFontForHeight = run.font ? { ...defaultFont, ...run.font } : defaultFont;
    }
  }

  // Concatenate all text for line counting
  const fullText = richText.map(r => r.text).join("");

  return calculateAutoFitHeight(fullText, maxFontForHeight, alignment, columnWidthPx);
}

/**
 * Get the content area width of a column in pixels (excluding padding).
 *
 * @param charWidth - Column width in Excel character units
 * @param mdw - Max digit width
 * @returns Content width in pixels
 */
export function getColumnContentWidthPx(charWidth: number, mdw: number): number {
  const totalPx = charWidthToPixel(charWidth, mdw);
  const pp = getPixelPadding(mdw);
  return Math.max(0, totalPx - pp);
}

// =============================================================================
// Cell-Level Measurement Helpers
// =============================================================================

/**
 * Minimal cell shape used by cell-level measurement helpers.
 * Avoids importing the full `Cell` class to prevent circular dependencies.
 */
export interface MeasurableCell {
  readonly value: unknown;
  readonly numFmt: string | NumFmt | undefined;
  readonly text: string;
  readonly effectiveType: ValueType;
  readonly font: Partial<Font> | undefined;
  readonly alignment: Partial<Alignment> | undefined;
}

/**
 * Get the pixel width of a cell's display text.
 *
 * Handles all cell value types: string, number (formatted), date (formatted),
 * boolean, formula result, rich text, hyperlink, error.
 */
export function getCellTextWidthPx(cell: MeasurableCell): number {
  const cellType = cell.effectiveType;
  const font = cell.font;

  // Rich text: measure per-run with individual fonts
  if (cellType === ValueType.RichText) {
    const value = cell.value;
    if (value && typeof value === "object" && "richText" in value) {
      return measureRichTextWidthPx((value as { richText: RichText[] }).richText, font);
    }
  }

  // Get the display text (applies number formatting)
  const displayText = getCellDisplayText(cell);
  if (!displayText) {
    return 0;
  }

  return measureTextWidthPx(displayText, font);
}

/**
 * Get the height in points a cell needs.
 *
 * Considers wrapText alignment, indent, and explicit newlines.
 *
 * @param cell           - The cell to measure
 * @param mdw            - Max digit width in pixels
 * @param columnWidthPx  - Column content width in pixels (needed for wrapText cells)
 */
export function getCellHeightPt(cell: MeasurableCell, mdw: number, columnWidthPx?: number): number {
  const font = cell.font;
  const alignment = cell.alignment;
  const cellType = cell.effectiveType;

  // Rich text
  if (cellType === ValueType.RichText) {
    const value = cell.value;
    if (value && typeof value === "object" && "richText" in value) {
      return calculateRichTextAutoFitHeight(
        (value as { richText: RichText[] }).richText,
        font,
        alignment,
        columnWidthPx
      );
    }
  }

  const displayText = getCellDisplayText(cell);
  if (!displayText) {
    return 0;
  }

  const effectiveColWidthPx = alignment?.wrapText ? columnWidthPx : undefined;

  return calculateAutoFitHeight(displayText, font, alignment, effectiveColWidthPx);
}
