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
import { graphemeClusters } from "./grapheme";

/** Screen resolution the pixel widths are expressed in. */
const DPI = 96;
/** Points per inch, for converting a point size to CSS pixels. */
const POINTS_PER_INCH = 72;

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
 * Bold adjustment is the caller's, via the 1.05 multiplier.
 * For other fonts/sizes with FUnit data, uses outline formula (Tier 2).
 */
function getCharPixelWidth(
  codePoint: number,
  fontName: string,
  fontSize: number,
  metrics: FontMetrics
): number {
  // Tier 1: Calibri 11pt bitmap (used for both regular and bold base measurement)
  if (fontName === "calibri" && fontSize === DEFAULT_FONT_SIZE) {
    const px = getCalibri11PtPixelWidth(codePoint);
    if (px !== undefined) {
      return px;
    }
    // Character not in bitmap table; fall through to Tier 2
  }

  // Tier 2: FUnit outline calculation. Always available — the metrics are required,
  // and `getCharAdvance` falls back to the face's `defaultAdvance` for a code point
  // it has no entry for, so this never has to report "no data".
  const advanceFU = getCharAdvance(metrics, codePoint);
  const ppem = Math.round((fontSize / 72) * DPI);
  return Math.round((advanceFU / metrics.header.unitsPerEm) * ppem);
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
/**
 * A line's width before the adjustments that apply to the line as a whole.
 *
 * The fields are additive, which is the point: a caller assembling a line one
 * word at a time can accumulate the parts, ask what the total *would* measure,
 * and commit only if it fits — without measuring the growing line again for every
 * word, and without a second model of how a width is arrived at.
 *
 * That second model is what this replaces. Wrapping summed a per-character
 * measurement while width measured the whole line, so the two disagreed for every
 * font whose adjustments are not per-character: superscript text wrapped as if it
 * were full size, and a face with no registered metrics was estimated by two
 * different formulas. A cell set to the width path's own answer still reported
 * three lines.
 */
export interface LineWidthParts {
  /** Tier 1 & 2: summed cluster advances, unscaled. */
  advance: number;
  /** Tier 3: unit counts, by category. */
  lower: number;
  upper: number;
  wide: number;
}

/** Accumulate and evaluate {@link LineWidthParts} for one resolved font. */
export interface LineMeasurer {
  /** A zeroed accumulator. */
  create(): LineWidthParts;
  reset(parts: LineWidthParts): void;
  /** Add one grapheme cluster. */
  addCluster(parts: LineWidthParts, cluster: string): void;
  /**
   * Add one ASCII character by code unit.
   *
   * Every ASCII character is its own grapheme cluster, so this is the same
   * addition without allocating a one-character string or consulting the segmenter.
   */
  addAscii(parts: LineWidthParts, charCode: number): void;
  /** `dst += src`. */
  addParts(dst: LineWidthParts, src: LineWidthParts): void;
  /** The pixel width of the parts, applying the line-level adjustments. */
  px(parts: LineWidthParts): number;
  /** The pixel width of `a + b`, without modifying either. */
  pxOfSum(a: LineWidthParts, b: LineWidthParts): number;
}

export function createLineMeasurer(
  resolved: ResolvedFont,
  metrics: FontMetrics | undefined
): LineMeasurer {
  // Everything that depends only on the font, computed once. `hasBoldMetrics`
  // lower-cased the face name for *every character measured* — a predicate constant
  // over the whole line that cost about a third of the measuring time for bold text.
  // The rest (`getMaxDigitWidth`, the em, the tier decision) were recomputed per
  // call rather than per character, but they belong here for the same reason.
  //
  // The `1.05` / `1.02` multipliers and their `Math.ceil` stay *per character*: they
  // round each advance, so hoisting them to the line would change every width.
  const useGlyphs =
    metrics !== undefined || (resolved.name === "calibri" && resolved.size === DEFAULT_FONT_SIZE);
  const factors = useGlyphs ? undefined : getFontWidthFactors(resolved.name);
  const lowerFactor = factors?.[0] ?? 1.0;
  const upperFactor = factors?.[1] ?? 1.3;
  const maxDigitWidth = getMaxDigitWidth({ name: resolved.name, size: resolved.size });
  const emPx = (resolved.size / POINTS_PER_INCH) * DPI;
  const wideAdvance = Math.ceil(emPx);
  const boldWidens = Boolean(resolved.bold) && !hasBoldMetrics(resolved.name);
  const italicWidens = Boolean(resolved.italic);
  const glyphMetrics = metrics ?? getDefaultFontMetrics();
  const scratch: LineWidthParts = { advance: 0, lower: 0, upper: 0, wide: 0 };

  /**
   * One character's advance, with the font's constants already resolved.
   *
   * A full-width character advances by one em whatever the face, so it never goes
   * through the per-face glyph lookup. Without that the two measurement
   * paths disagreed: `measureTextWidthPx` gave twelve ideographs 176px (one em
   * each) while the per-character path gave 168px (two digit widths each), so a
   * cell's width and its wrapped line count came from different numbers.
   *
   * Superscript scaling is *not* applied here: it belongs to the line (see `px`),
   * and doing it in both places scaled an ideograph twice, to 36% instead of 60%.
   */
  const charPx = (codePoint: number): number => {
    if (isWideCharacter(codePoint)) {
      return wideAdvance; // bold and italic do not widen an ideograph
    }
    // Only reached when `useGlyphs`, so the metrics are always present.
    let charWidth = getCharPixelWidth(codePoint, resolved.name, resolved.size, glyphMetrics);
    if (boldWidens) {
      charWidth = Math.ceil(charWidth * 1.05);
    }
    if (italicWidens) {
      charWidth = Math.ceil(charWidth * 1.02);
    }
    return charWidth;
  };

  /** One grapheme cluster's advance; the cluster's width belongs to its base. */
  const clusterPx = (cluster: string): number => {
    const base = clusterBaseCodePoint(cluster);
    if (!isWideCharacter(base) && hasEmojiPresentationSelector(cluster)) {
      return wideAdvance;
    }
    return charPx(base);
  };

  const px = (parts: LineWidthParts): number => {
    if (useGlyphs) {
      // Superscript and subscript render at ~60% size. Applied once, here: the
      // per-cluster measurement used to apply it as well for full-width
      // characters, so an ideograph was scaled twice and came out at 36%.
      return resolved.vertAlign ? Math.ceil(parts.advance * 0.6) : parts.advance;
    }
    let width =
      (parts.lower * lowerFactor + parts.upper * upperFactor) * (resolved.size / DEFAULT_FONT_SIZE);
    if (resolved.bold) {
      width *= 1.05;
    }
    if (resolved.italic) {
      width *= 1.02;
    }
    if (resolved.vertAlign) {
      width *= 0.6;
    }
    let value = width * maxDigitWidth;
    if (parts.wide > 0) {
      value += (parts.wide / 2) * emPx * (resolved.vertAlign ? 0.6 : 1);
    }
    return Math.ceil(value);
  };

  return {
    create: () => ({ advance: 0, lower: 0, upper: 0, wide: 0 }),
    reset(parts) {
      parts.advance = 0;
      parts.lower = 0;
      parts.upper = 0;
      parts.wide = 0;
    },
    addCluster(parts, cluster) {
      if (useGlyphs) {
        parts.advance += clusterPx(cluster);
        return;
      }
      const cp = clusterBaseCodePoint(cluster);
      if (isWideCharacter(cp) || hasEmojiPresentationSelector(cluster)) {
        parts.wide += 2;
      } else if (cluster >= "A" && cluster <= "Z") {
        parts.upper++;
      } else {
        parts.lower++;
      }
    },
    addAscii(parts, charCode) {
      if (useGlyphs) {
        parts.advance += charPx(charCode);
        return;
      }
      // ASCII is never full-width and never carries a presentation selector.
      if (charCode >= 0x41 && charCode <= 0x5a) {
        parts.upper++;
      } else {
        parts.lower++;
      }
    },
    addParts(dst, src) {
      dst.advance += src.advance;
      dst.lower += src.lower;
      dst.upper += src.upper;
      dst.wide += src.wide;
    },
    px,
    pxOfSum(a, b) {
      scratch.advance = a.advance + b.advance;
      scratch.lower = a.lower + b.lower;
      scratch.upper = a.upper + b.upper;
      scratch.wide = a.wide + b.wide;
      return px(scratch);
    }
  };
}

function measureLineWidthPx(
  line: string,
  resolved: ResolvedFont,
  metrics: FontMetrics | undefined
): number {
  if (!line) {
    return 0;
  }

  // One model, shared with the wrap path — see {@link LineWidthParts}.
  const measurer = createLineMeasurer(resolved, metrics);
  const parts = measurer.create();
  addLine(measurer, parts, line);
  return measurer.px(parts);
}

/**
 * Add a whole line to an accumulator, taking the ASCII fast path when it applies.
 *
 * The width path calls this; the wrap path interleaves break decisions between the
 * characters, so it runs the same two branches itself against the same `isAscii`
 * and the same `addAscii`/`addCluster`. Having the fast path on one side only is
 * what this closes: `autoFitColumns` over 24,000 Latin cells spent 275 ms handing
 * every character to `Intl.Segmenter` and allocating a one-character string for it,
 * where the wrap path over the same cells spent a third of that.
 *
 * The input must not contain a line break: `\r\n` is a single grapheme cluster but
 * two ASCII code units, so the two branches would disagree about it. Callers split
 * into lines first.
 *
 * Grapheme clusters, not code points, on the general path. A base character
 * together with its variation selector, combining marks, emoji modifier or ZWJ
 * partners occupies one advance; summing per code point charged for each of them.
 * Measured at 12pt, `👍🏽` came out 32px (two ems for one glyph), `🇨🇳` 32px for one
 * flag, `👩‍👩‍👧‍👦` 94px for a single emoji, and `é` 20px — which inflated auto-fit
 * column widths and produced extra wrapped lines.
 */
export function addLine(measurer: LineMeasurer, parts: LineWidthParts, line: string): void {
  if (isAscii(line)) {
    for (let i = 0; i < line.length; i++) {
      measurer.addAscii(parts, line.charCodeAt(i));
    }
    return;
  }
  for (const cluster of graphemeClusters(line)) {
    measurer.addCluster(parts, cluster);
  }
}

/**
 * Whether every code unit is ASCII, so each is its own grapheme cluster.
 *
 * That range holds no combining marks, no surrogate pairs and no emoji sequences,
 * so the clusters are the code units and neither the segmenter nor a per-character
 * string is needed.
 */
export function isAscii(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * The code point that decides a grapheme cluster's advance.
 *
 * A cluster's width belongs to its base character; the variation selectors,
 * combining marks, emoji modifiers and ZWJ partners after it select or compose a
 * glyph rather than adding advances of their own.
 */
function clusterBaseCodePoint(cluster: string): number {
  return cluster.codePointAt(0) ?? 0;
}

/**
 * Whether a cluster asks for emoji presentation through VS16.
 *
 * `U+FE0F` means "draw the preceding character as an emoji", and an emoji
 * presentation is full-width even when the base character's own East Asian Width
 * is Neutral. `✈` is 0.5em as text and 1em as `✈️`, so the selector has to be
 * consulted rather than only the base.
 */
function hasEmojiPresentationSelector(cluster: string): boolean {
  return cluster.includes("\uFE0F");
}

/**
 * Replace a lone carriage return with a line feed, preserving every offset.
 *
 * The line-break vocabulary was not shared. Excel's metrics accept CR, LF and
 * CRLF, while the PDF renderer split on `/\r?\n/` and scanned for `"\n"` — so a
 * lone `\r` was not a break there at all: the row was given two lines of height
 * and then drawn as one, with the CR passed through to the content stream where it
 * surfaced as a replacement character (`a\rb` → `a?b`).
 *
 * Rewriting only a CR that is *not* followed by LF keeps the string the same
 * length, which matters because rich text is addressed by offset: its runs, and
 * the wrap units derived from them, index into this exact string. A normalisation
 * that collapsed CRLF would move every offset after it.
 */
export function normalizeLoneCarriageReturns(text: string): string {
  // A cheap scan first: the overwhelming majority of text contains no CR at all.
  if (!text.includes("\r")) {
    return text;
  }
  return text.replace(/\r(?!\n)/gu, "\n");
}
