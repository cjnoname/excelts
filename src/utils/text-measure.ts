/**
 * Glyph-advance text measurement.
 *
 * Layer 0, so that anything which draws text can measure it first. The advance tables
 * and the tiered measurement around them were reachable only from `@excel/utils`, which
 * put them out of reach of the drawing engine and of any producer sitting beside it: a
 * diagram lays its boxes out around the text they contain, so a producer that cannot
 * measure text cannot size anything.
 *
 * Nothing here knows about spreadsheets. The Excel-specific measurement — autofit column
 * widths, wrapped line counts, rich text, cell formats — stays in
 * `@excel/utils/text-metrics`, which now calls into this.
 *
 * Three tiers, in order of preference:
 *
 * 1. Real per-glyph advances from an embedded metrics table.
 * 2. Calibri 11pt, whose pixel widths are tabulated exactly because it is Excel's
 *    default and its column arithmetic depends on them.
 * 3. Category averages — lowercase, uppercase, wide — for a face with no table. A
 *    guess, but a bounded one, and better than assuming a monospace grid.
 */

import {
  getCharAdvance,
  getCalibri11PtPixelWidth,
  getDefaultFontMetrics,
  getFontMetrics,
  getFontWidthFactors,
  hasBoldMetrics,
  isWideCharacter
} from "./font-data";
import type { FontMetrics } from "./font-data";

/** Screen resolution the pixel widths are expressed in. */
const DPI = 96;

/** Excel's default font, and the one the exact table covers. */
const DEFAULT_FONT_SIZE = 11;
const DEFAULT_FONT_NAME = "Calibri";

/** Maximum digit width of Calibri 11pt, in pixels — the unit Excel sizes columns in. */
const CALIBRI_11PT_MDW = 7;

/**
 * The font properties measurement depends on.
 *
 * A deliberate subset: `Font` in the Excel module carries colour, underline, strike and
 * a theme reference, none of which change an advance width. Declaring the subset here is
 * what keeps this file free of the Excel type graph.
 */
export interface MeasuredFont {
  name: string;
  size: number;
  bold: boolean;
  italic: boolean;
  vertAlign?: "superscript" | "subscript";
}

/** Resolved font parameters for measurement */
interface ResolvedFont {
  name: string;
  size: number;
  bold: boolean;
  italic: boolean;
  vertAlign?: "superscript" | "subscript";
}

/**
 * Calculate the pixel width of a single character given font parameters.
 *
 * For Calibri 11pt (both regular and bold), uses the bitmap pixel table (Tier 1).
 * Bold adjustment is handled by the caller via the 1.05 multiplier.
 * For other fonts/sizes with FUnit data, uses outline formula (Tier 2).
 * Returns undefined if no data is available for this font (use Tier 3).
 */
function getCharPixelWidth(
  codePoint: number,
  fontName: string,
  fontSize: number,
  _bold: boolean,
  metrics: FontMetrics | undefined
): number | undefined {
  // Tier 1: Calibri 11pt bitmap (used for both regular and bold base measurement)
  if (fontName === "calibri" && fontSize === DEFAULT_FONT_SIZE) {
    const px = getCalibri11PtPixelWidth(codePoint);
    if (px !== undefined) {
      return px;
    }
    // Character not in bitmap table; fall through to Tier 2
  }

  // Tier 2: FUnit outline calculation
  if (metrics) {
    const advanceFU = getCharAdvance(metrics, codePoint);
    const ppem = Math.round((fontSize / 72) * DPI);
    return Math.round((advanceFU / metrics.header.unitsPerEm) * ppem);
  }

  return undefined;
}

/**
 * Calculate the Max Digit Width (MDW) in pixels for a given font.
 *
 * Special case: Calibri 11pt returns 7 (bitmap metrics override).
 * For other fonts: MDW = ROUND(maxDigitAdvanceFU / unitsPerEm * ppem)
 */
export function getMaxDigitWidth(font?: Partial<MeasuredFont>): number {
  const name = (font?.name ?? DEFAULT_FONT_NAME).toLowerCase();
  const size = font?.size ?? DEFAULT_FONT_SIZE;

  // Calibri 11pt: bitmap MDW = 7
  if (name === "calibri" && size === DEFAULT_FONT_SIZE) {
    return CALIBRI_11PT_MDW;
  }

  const metrics = getFontMetrics(name);
  if (metrics) {
    const ppem = Math.round((size / 72) * DPI);
    return Math.round((metrics.header.maxDigitAdvance / metrics.header.unitsPerEm) * ppem);
  }

  // Fallback: scale from Calibri proportionally
  return Math.max(1, Math.round(CALIBRI_11PT_MDW * (size / DEFAULT_FONT_SIZE)));
}

/**
 * Resolve a partial Font to concrete measurement parameters.
 */
export function resolveFont(font?: Partial<MeasuredFont>): ResolvedFont {
  return {
    name: (font?.name ?? DEFAULT_FONT_NAME).toLowerCase(),
    size: font?.size ?? DEFAULT_FONT_SIZE,
    bold: font?.bold ?? false,
    italic: font?.italic ?? false,
    vertAlign: font?.vertAlign
  };
}

/**
 * Measure the pixel width of a text string with a given font.
 *
 * Handles:
 * - Per-character precise measurement (Tier 1 & 2)
 * - Category-average fallback for unknown fonts (Tier 3)
 * - Multi-line text (returns width of widest line)
 * - Bold/italic modifiers
 * - Superscript/subscript scaling
 */
export function measureTextWidthPx(text: string, font?: Partial<MeasuredFont>): number {
  if (!text) {
    return 0;
  }

  const resolved = resolveFont(font);
  const metrics = getFontMetrics(resolved.name, resolved.bold);

  // Split by newlines, measure each line, return max
  const lines = text.split(/\r\n|\r|\n/);
  let maxWidth = 0;

  for (const line of lines) {
    const width = measureLineWidthPx(line, resolved, metrics);
    if (width > maxWidth) {
      maxWidth = width;
    }
  }

  return maxWidth;
}

/**
 * Measure a single line of text (no newlines) in pixels.
 */
function measureLineWidthPx(
  line: string,
  resolved: ResolvedFont,
  metrics: FontMetrics | undefined
): number {
  if (!line) {
    return 0;
  }

  // Try per-character measurement (Tier 1 & 2)
  if (metrics || (resolved.name === "calibri" && resolved.size === DEFAULT_FONT_SIZE)) {
    return measureLineWithGlyphs(line, resolved, metrics);
  }

  // Tier 3: Factor-based fallback
  return measureLineWithFactors(line, resolved);
}

/**
 * Tier 1 & 2: Per-character pixel width measurement.
 */
function measureLineWithGlyphs(
  line: string,
  resolved: ResolvedFont,
  metrics: FontMetrics | undefined
): number {
  let totalWidth = 0;

  for (const char of line) {
    totalWidth += _measureCharPx(char.codePointAt(0)!, resolved, metrics);
  }

  // Superscript/subscript renders at ~60% size
  if (resolved.vertAlign) {
    totalWidth = Math.ceil(totalWidth * 0.6);
  }

  return totalWidth;
}

/**
 * Tier 3: Factor-based width measurement for unknown fonts.
 * Uses category averages (lowercase, uppercase, wide).
 */
function measureLineWithFactors(line: string, resolved: ResolvedFont): number {
  const factors = getFontWidthFactors(resolved.name);
  const lowerFactor = factors?.[0] ?? 1.0;
  const upperFactor = factors?.[1] ?? 1.3;
  const wideFactor = factors?.[2] ?? 1.0;

  let lowerUnits = 0;
  let upperUnits = 0;
  let wideUnits = 0;

  for (const char of line) {
    const cp = char.codePointAt(0)!;
    if (isWideCharacter(cp)) {
      wideUnits += 2;
    } else if (char >= "A" && char <= "Z") {
      upperUnits++;
    } else {
      lowerUnits++;
    }
  }

  // Width in "character units" (where 1 unit = average char at 11pt)
  const charWidth =
    (lowerUnits * lowerFactor + upperUnits * upperFactor + wideUnits * wideFactor) *
    (resolved.size / DEFAULT_FONT_SIZE);

  // Apply bold/italic
  let width = charWidth;
  if (resolved.bold) {
    width *= 1.05;
  }
  if (resolved.italic) {
    width *= 1.02;
  }
  if (resolved.vertAlign) {
    width *= 0.6;
  }

  // Convert from character units to pixels using the font's MDW
  const mdw = getMaxDigitWidth({ name: resolved.name, size: resolved.size });
  return Math.ceil(width * mdw);
}

/**
 * Measure pixel width of a single character with font adjustments.
 * Shared by both width measurement and wrap calculation.
 */
export function _measureCharPx(
  codePoint: number,
  resolved: ResolvedFont,
  metrics: FontMetrics | undefined
): number {
  let charWidth: number;

  if (metrics || (resolved.name === "calibri" && resolved.size === DEFAULT_FONT_SIZE)) {
    const effectiveMetrics = metrics ?? getDefaultFontMetrics();
    charWidth =
      getCharPixelWidth(codePoint, resolved.name, resolved.size, resolved.bold, effectiveMetrics) ??
      Math.round(
        (effectiveMetrics.defaultAdvance / effectiveMetrics.header.unitsPerEm) *
          Math.round((resolved.size / 72) * DPI)
      );
  } else {
    charWidth = Math.ceil(
      (resolved.size / DEFAULT_FONT_SIZE) *
        getMaxDigitWidth({ name: resolved.name, size: resolved.size }) *
        (isWideCharacter(codePoint) ? 2 : 1)
    );
  }

  // Apply bold/italic multipliers
  if (resolved.bold && !hasBoldMetrics(resolved.name)) {
    charWidth = Math.ceil(charWidth * 1.05);
  }
  if (resolved.italic) {
    charWidth = Math.ceil(charWidth * 1.02);
  }

  return charWidth;
}
