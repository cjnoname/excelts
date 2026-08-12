/**
 * Shared rendering constants used by both the layout engine and page renderer.
 *
 * Keeping these in one place ensures row-height computation and text rendering
 * use exactly the same values, preventing clipped or overlapping content.
 */

/** Horizontal cell padding in points (left + right = 2 × CELL_PADDING_H). */
export const CELL_PADDING_H = 3;

/** Vertical cell padding in points (top + bottom = 2 × CELL_PADDING_V). */
export const CELL_PADDING_V = 2;

/**
 * Line-height multiplier applied to the font size.
 *
 * Excel's default row height for an 11pt font is 15pt, which after removing
 * vertical padding (2 × 2 = 4pt) leaves 11pt × 1.0 — but Excel also adds
 * internal leading. A factor of 1.2 matches standard PDF/typographic practice
 * and keeps text readable without inflating row heights.
 */
export const LINE_HEIGHT_FACTOR = 1.2;

/** Width of one indent level in points (~3 characters at 11pt). */
export const INDENT_WIDTH = 10;

/**
 * Excel column widths are measured in characters of the default font's digit width.
 * For Calibri 11pt (the default), maxDigitWidth ≈ 7 pixels at 96 DPI. The
 * per-column pixel padding (4px text margin + 1px gridline) is derived inside
 * `charWidthToPixel` (`@utils/units`); see that helper for the exact formula.
 * To convert the resulting pixels to PDF points multiply by `PX_TO_PT` (72/96).
 */
export const MAX_DIGIT_WIDTH_PX = 7;
export const PX_TO_PT = 72 / 96; // 0.75

/**
 * Font size of the printed row-number / column-letter headings, in points.
 *
 * Deliberately independent of the grid's print scale: headings are a reading
 * aid rather than content, so a fixed size stays legible even when the grid is
 * shrunk to fit, and lets the layout reserve exactly the space it draws.
 */
export const HEADING_FONT_SIZE = 8;

/** Padding around a heading label, in points (applied on both sides). */
export const HEADING_PADDING = 3;

/** Background shade and rule color of the heading bands. */
export const HEADING_FILL = { r: 0.94, g: 0.94, b: 0.94 };
export const HEADING_RULE = { r: 0.6, g: 0.6, b: 0.6 };
export const HEADING_TEXT = { r: 0.2, g: 0.2, b: 0.2 };

/**
 * Lower bound when solving "fit to N pages", matching the 10% floor of Excel's
 * Page Setup scaling. A target that is unreachable at this scale — typically
 * because manual page breaks force more pages than requested — yields more than
 * N pages rather than shrinking the grid into illegibility.
 */
export const FIT_MIN_SCALE = 0.1;

/**
 * Side length of the red corner marker Excel draws on a commented cell, in
 * points at 100% scale.
 */
export const COMMENT_MARKER_SIZE = 4;

/** Comment box fill, border and text colors, matching Excel's note styling. */
export const COMMENT_FILL = { r: 1, g: 1, b: 0.88 };
export const COMMENT_BORDER = { r: 0.4, g: 0.4, b: 0.4 };
export const COMMENT_MARKER_COLOR = { r: 0.8, g: 0, b: 0 };

/**
 * Overflow tolerance when packing columns into a page, in points.
 *
 * Scaled point widths accumulate rounding error, so a column that mathematically
 * fits can measure a hair too wide. Rows need no such slack because their
 * heights are not derived from a character-width conversion.
 */
export const COLUMN_FIT_EPSILON = 0.01;

/**
 * Height of the bands reserved for the fallback sheet-name header and
 * page-number footer, in points. Excel header/footers use their own margins;
 * these are the simple `showSheetNames` / `showPageNumbers` bands.
 */
export const SHEET_NAME_BAND_HEIGHT = 20;
export const PAGE_NUMBER_BAND_HEIGHT = 20;
