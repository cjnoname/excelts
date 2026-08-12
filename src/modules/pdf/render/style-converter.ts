/**
 * Converts input styles to PDF rendering parameters.
 *
 * Maps font, color, border, fill, and alignment properties
 * to their PDF equivalents for the layout engine and page renderer.
 *
 * This module is fully independent of the Excel module — it works with
 * the PDF module's own style interfaces (PdfFontStyle, PdfFillData, etc.).
 */

import type {
  PdfColor,
  LayoutBorder,
  LayoutBorders,
  PdfColorData,
  PdfFontStyle,
  PdfFillData,
  PdfBorderSideData,
  PdfBordersData,
  PdfAlignmentData
} from "@pdf/types";
import { CELL_THEME_PALETTE, hexToRgb01, applyTintRgb01 } from "@utils/theme-colors";

// =============================================================================
// Color Conversion
// =============================================================================

/**
 * Convert an ARGB color string to PDF RGB color.
 * Handles "AARRGGBB" (8-char) and "RRGGBB" (6-char) formats.
 * PDF uses 0-1 floats for each component.
 */
export function argbToPdfColor(argb: string | undefined): PdfColor | null {
  if (!argb || argb.length < 6) {
    return null;
  }
  return hexToRgb01(argb);
}

/**
 * Convert a color data object to PDF color.
 * Handles ARGB, theme-based, and indexed colors.
 */
export function excelColorToPdf(color: Partial<PdfColorData> | undefined): PdfColor | null {
  if (!color) {
    return null;
  }

  // ARGB takes priority
  if (color.argb) {
    return argbToPdfColor(color.argb);
  }

  // Theme colors with optional tint
  if (color.theme !== undefined) {
    const base = themeColorToPdf(color.theme);
    if (!base) {
      return null;
    }
    const tint = color.tint;
    if (tint !== undefined && tint !== 0) {
      return applyTint(base, tint);
    }
    return base;
  }

  // Indexed colors (legacy Excel color palette)
  if (color.indexed !== undefined) {
    return indexedColorToPdf(color.indexed);
  }

  return null;
}

/**
 * Map a cell-colour theme index to a PDF colour using the default Office
 * palette in SpreadsheetML cell order (0=lt1, 1=dk1, 2=lt2, 3=dk2, …).
 */
function themeColorToPdf(themeIndex: number): PdfColor | null {
  if (themeIndex >= 0 && themeIndex < CELL_THEME_PALETTE.length) {
    return hexToRgb01(CELL_THEME_PALETTE[themeIndex]);
  }
  return null;
}

/**
 * Standard Excel indexed color palette (56 colors + system colors).
 * Index 0–7: legacy base colors
 * Index 8–63: standard palette (indices 8–63)
 * Index 64: system foreground (black)
 * Index 65: system background (white)
 *
 * @see ECMA-376 §18.8.27 — indexedColors
 */
const INDEXED_COLORS: string[] = [
  // 0–7: legacy base colors (same as 8–15 but less commonly used directly)
  "000000", // 0: Black
  "FFFFFF", // 1: White
  "FF0000", // 2: Red
  "00FF00", // 3: Green
  "0000FF", // 4: Blue
  "FFFF00", // 5: Yellow
  "FF00FF", // 6: Magenta
  "00FFFF", // 7: Cyan
  // 8–63: standard palette
  "000000", // 8: Black
  "FFFFFF", // 9: White
  "FF0000", // 10: Red
  "00FF00", // 11: Green
  "0000FF", // 12: Blue
  "FFFF00", // 13: Yellow
  "FF00FF", // 14: Magenta
  "00FFFF", // 15: Cyan
  "800000", // 16: Dark Red
  "008000", // 17: Dark Green
  "000080", // 18: Dark Blue (Navy)
  "808000", // 19: Dark Yellow (Olive)
  "800080", // 20: Purple
  "008080", // 21: Teal
  "C0C0C0", // 22: Silver
  "808080", // 23: Gray
  "9999FF", // 24: Periwinkle
  "993366", // 25: Plum
  "FFFFCC", // 26: Ivory
  "CCFFFF", // 27: Light Cyan
  "660066", // 28: Dark Purple
  "FF8080", // 29: Coral
  "0066CC", // 30: Ocean Blue
  "CCCCFF", // 31: Ice Blue
  "000080", // 32: Dark Blue
  "FF00FF", // 33: Pink
  "FFFF00", // 34: Yellow
  "00FFFF", // 35: Cyan
  "800080", // 36: Purple
  "800000", // 37: Dark Red
  "008080", // 38: Teal
  "0000FF", // 39: Blue
  "00CCFF", // 40: Sky Blue
  "CCFFFF", // 41: Light Turquoise
  "CCFFCC", // 42: Light Green
  "FFFF99", // 43: Light Yellow
  "99CCFF", // 44: Pale Blue
  "FF99CC", // 45: Rose
  "CC99FF", // 46: Lavender
  "FFCC99", // 47: Tan
  "3366FF", // 48: Light Blue
  "33CCCC", // 49: Aqua
  "99CC00", // 50: Lime
  "FFCC00", // 51: Gold
  "FF9900", // 52: Light Orange
  "FF6600", // 53: Orange
  "666699", // 54: Blue Gray
  "969696", // 55: Gray 40%
  "003366", // 56: Dark Teal
  "339966", // 57: Sea Green
  "003300", // 58: Very Dark Green
  "333300", // 59: Dark Olive
  "993300", // 60: Brown
  "993366", // 61: Plum
  "333399", // 62: Indigo
  "333333" // 63: Gray 80%
];

/**
 * Convert an indexed color to PDF color.
 * Index 64 = system foreground (black), 65 = system background (white).
 */
function indexedColorToPdf(index: number): PdfColor | null {
  if (index === 64) {
    return { r: 0, g: 0, b: 0 }; // System foreground (black)
  }
  if (index === 65) {
    return { r: 1, g: 1, b: 1 }; // System background (white)
  }
  if (index >= 0 && index < INDEXED_COLORS.length) {
    return argbToPdfColor(INDEXED_COLORS[index]) ?? null;
  }
  return null;
}

/**
 * Apply a tint value to a color.
 * Tint range: -1.0 (fully dark) to +1.0 (fully light).
 * Negative tint darkens, positive tint lightens.
 *
 * @see OOXML §18.8.19 - tint formula
 */
export function applyTint(color: PdfColor, tint: number): PdfColor {
  return applyTintRgb01(color, tint);
}

/**
 * Convert a color to its luminance-preserving grayscale equivalent, using the
 * Rec. 601 luma weights. Backs Excel's "Black and white" print option: hues are
 * discarded while relative lightness — and therefore contrast — is kept.
 *
 * Opacity is carried through untouched; dropping it would make transparent
 * chart fills opaque.
 */
export function toGrayscale(color: PdfColor): PdfColor {
  const luma = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
  return color.a === undefined
    ? { r: luma, g: luma, b: luma }
    : { r: luma, g: luma, b: luma, a: color.a };
}

/** Grayscale every edge of a border set, preserving `null` edges. */
export function grayscaleBorders(borders: LayoutBorders): LayoutBorders {
  const convert = (b: LayoutBorder | null): LayoutBorder | null =>
    b === null ? null : { ...b, color: toGrayscale(b.color) };
  return {
    top: convert(borders.top),
    right: convert(borders.right),
    bottom: convert(borders.bottom),
    left: convert(borders.left)
  };
}

/**
 * Default colors used in PDF rendering.
 */
export const DEFAULT_COLORS = {
  black: { r: 0, g: 0, b: 0 } as PdfColor,
  white: { r: 1, g: 1, b: 1 } as PdfColor,
  gridLine: { r: 0.816, g: 0.816, b: 0.816 } as PdfColor
};

// =============================================================================
// Font Conversion
// =============================================================================

/**
 * Extract font properties for PDF rendering.
 */
export function extractFontProperties(
  font: Partial<PdfFontStyle> | undefined,
  defaultFamily: string,
  defaultSize: number
): {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  textColor: PdfColor;
} {
  const fontFamily = font?.name ?? defaultFamily;
  const fontSize = font?.size ?? defaultSize;
  const bold = font?.bold ?? false;
  const italic = font?.italic ?? false;
  const strike = font?.strike ?? false;
  const underline = !!(font?.underline && font.underline !== "none");
  const textColor = excelColorToPdf(font?.color) ?? DEFAULT_COLORS.black;

  return { fontFamily, fontSize, bold, italic, strike, underline, textColor };
}

// =============================================================================
// Fill Conversion
// =============================================================================

/**
 * Convert a fill to a PDF background color.
 * Only pattern fills with "solid" pattern are supported as PDF backgrounds.
 * Other patterns are approximated or ignored.
 */
export function excelFillToPdfColor(fill: PdfFillData | undefined): PdfColor | null {
  if (!fill) {
    return null;
  }

  if (fill.type === "pattern") {
    if (fill.pattern === "solid" && fill.fgColor) {
      return excelColorToPdf(fill.fgColor);
    }
    if (fill.pattern === "none") {
      return null;
    }
    // For other patterns, use fgColor as approximation
    if (fill.fgColor) {
      return excelColorToPdf(fill.fgColor);
    }
  }

  if (fill.type === "gradient") {
    // For gradient fills, use the first stop color as approximation
    if (fill.stops && fill.stops.length > 0) {
      return excelColorToPdf(fill.stops[0].color);
    }
  }

  return null;
}

// =============================================================================
// Border Conversion
// =============================================================================

/**
 * Map border styles to PDF line widths (in points).
 *
 * Values match Excel's actual border weights as used historically by this
 * library. An earlier change doubled every width (0.25 → 0.5, 0.5 → 1,
 * 1 → 2) to make `thin` and `medium` more visually distinct in PDF
 * viewers, but that change made all borders heavier than Excel itself.
 * The 2× ratio between thin/medium and the 4× ratio between
 * thin/thick are preserved with the lighter values, so styles remain
 * distinguishable while matching Excel.
 *
 *   hair   = 0.1 pt
 *   thin   = 0.25 pt   (also dotted, dashed, dashDot, dashDotDot, slantDashDot, double)
 *   medium = 0.5 pt    (also mediumDashed, mediumDashDot, mediumDashDotDot)
 *   thick  = 1   pt
 */
export function borderStyleToLineWidth(style: string): number {
  switch (style) {
    case "hair":
      return 0.1;
    case "thin":
      return 0.25;
    case "medium":
      return 0.5;
    case "thick":
      return 1;
    case "double":
      return 0.25;
    case "dotted":
      return 0.25;
    case "dashed":
      return 0.25;
    case "dashDot":
      return 0.25;
    case "dashDotDot":
      return 0.25;
    case "slantDashDot":
      return 0.25;
    case "mediumDashed":
      return 0.5;
    case "mediumDashDot":
      return 0.5;
    case "mediumDashDotDot":
      return 0.5;
    default:
      return 0.25;
  }
}

/**
 * Map border styles to PDF dash patterns.
 * An empty array means a solid line.
 */
function borderStyleToDashPattern(style: string): number[] {
  switch (style) {
    case "dotted":
      return [1, 1];
    case "dashed":
    case "mediumDashed":
      return [3, 2];
    case "dashDot":
    case "mediumDashDot":
      return [3, 1, 1, 1];
    case "dashDotDot":
    case "mediumDashDotDot":
      return [3, 1, 1, 1, 1, 1];
    case "slantDashDot":
      return [4, 2, 1, 2];
    case "hair":
      return [0.5, 0.5];
    default:
      return [];
  }
}

/**
 * Convert a single border side to a PDF LayoutBorder.
 */
function convertBorder(border: Partial<PdfBorderSideData> | undefined): LayoutBorder | null {
  if (!border || !border.style) {
    return null;
  }

  return {
    width: borderStyleToLineWidth(border.style),
    color: excelColorToPdf(border.color) ?? DEFAULT_COLORS.black,
    dashPattern: borderStyleToDashPattern(border.style),
    isDouble: border.style === "double"
  };
}

/**
 * Convert border data to PDF LayoutBorders.
 */
export function excelBordersToPdf(borders: Partial<PdfBordersData> | undefined): LayoutBorders {
  if (!borders) {
    return { top: null, right: null, bottom: null, left: null };
  }

  return {
    top: convertBorder(borders.top),
    right: convertBorder(borders.right),
    bottom: convertBorder(borders.bottom),
    left: convertBorder(borders.left)
  };
}

// =============================================================================
// Alignment Conversion
// =============================================================================

/**
 * Convert horizontal alignment to PDF alignment.
 */
export function excelHAlignToPdf(
  alignment: Partial<PdfAlignmentData> | undefined
): "left" | "center" | "right" {
  if (!alignment?.horizontal) {
    return "left";
  }

  switch (alignment.horizontal) {
    case "center":
    case "centerContinuous":
      return "center";
    case "right":
      return "right";
    case "left":
    case "fill":
    case "justify":
    case "distributed":
    default:
      return "left";
  }
}

/**
 * Convert vertical alignment to PDF alignment.
 */
export function excelVAlignToPdf(
  alignment: Partial<PdfAlignmentData> | undefined
): "top" | "middle" | "bottom" {
  if (!alignment?.vertical) {
    return "bottom"; // Default is bottom
  }

  switch (alignment.vertical) {
    case "top":
      return "top";
    case "middle":
      return "middle";
    case "bottom":
    case "justify":
    case "distributed":
    default:
      return "bottom";
  }
}
