/**
 * Word Document Layout Engine — Advanced Pagination Model
 *
 * Provides page-break calculation for DOCX documents with support for:
 * - Precise line-by-line text wrapping with greedy algorithm
 * - CJK full-width character width awareness
 * - First-line indent / hanging indent
 * - Tab stop positioning
 * - Contextual spacing (paragraph spacing collapse)
 * - Widow & Orphan control
 * - Footnote/Endnote space reservation
 * - Table cell content height calculation
 * - Inline image height contribution
 * - Numbering (bullet/number) indent calculation
 *
 * Units reminder:
 *   1 inch = 1440 twips
 *   1 pt   = 20 twips
 *   Default US Letter: 12240 × 15840 twips, margins 1440 each
 *   Half-point 24 = 12pt font; line height ~14.4pt = 288 twips (single-spaced)
 */

import { splitByScript } from "@utils/cjk";
import {
  getFontAscent,
  getFontDescent,
  isFullWidthCodePoint,
  styledFontVariant
} from "@utils/font-metrics";
import { isHyperlink, isRun } from "@word/core/text-utils";
import {
  DEFAULT_FONT_SIZE_HALF_PT,
  DEFAULT_PAGE_HEIGHT_TWIPS,
  DEFAULT_PAGE_MARGIN_TWIPS,
  DEFAULT_PAGE_WIDTH_TWIPS,
  LINE_HEIGHT_FACTOR,
  SCRIPT_BASELINE_SHIFT_FACTOR,
  SCRIPT_FONT_SIZE_RATIO,
  mergeRunProperties,
  minimumRowHeightPt,
  resolveCellMarginsTwips,
  resolveColumnWidthsTwips,
  resolveHeadingScale
} from "@word/layout/layout-constants";
import { resolveWordLineMetrics } from "@word/layout/line-metrics";
import { resolveRunStyle, resolveStyle } from "@word/query/style-resolve";
import type {
  BodyContent,
  DocxDocument,
  DrawingShape,
  FloatingImage,
  FontSpec,
  LineSpacing,
  Paragraph,
  ParagraphChild,
  ParagraphProperties,
  Run,
  RunProperties,
  SectionBreakType,
  SectionColumns,
  SectionProperties,
  Table
} from "@word/types";

// =============================================================================
// Public API Types
// =============================================================================

/** Pagination result: the page each body-content item lands on. */
export interface LayoutResult {
  /** Total number of pages. */
  readonly pageCount: number;
  /** Page count of each section. */
  readonly sectionPageCounts: readonly number[];
  /** Page number of each body-content item (1-based). */
  readonly contentPages: readonly number[];
  /** Section index of each body-content item (0-based). */
  readonly contentSections: readonly number[];
  /** Bookmark name → page number. */
  readonly bookmarkPages: ReadonlyMap<string, number>;
  /**
   * Whether each body-content item must start a new page regardless of fit.
   *
   * Set by an explicit page break (`w:pageBreakBefore`, a `w:br` of type
   * `page`) or a section break. The positioner re-flows content to its own
   * measurements, so it needs to tell "the estimate ran out of room here" —
   * which it may legitimately disagree with — from "the document demands a
   * break here", which it must honour.
   */
  readonly forcedBreakBefore: readonly boolean[];
}

/** Layout options. */
export interface LayoutOptions {
  /** Default font size in half-points; defaults to 22 (= 11pt, Word's default). */
  readonly defaultFontSize?: number;
  /** Estimated characters per line (used for line-height math); defaults to 80. */
  readonly defaultCharsPerLine?: number;
  /** Average character width in twips; derived from a 12pt font by default. */
  readonly averageCharWidth?: number;
  /**
   * Optional text measurement function for precise layout.
   * Should return the width of the text in points.
   * Uses heuristic character-count estimation if not provided.
   *
   * @example
   * ```ts
   * import { measureTextWidth, mapToStandardFont } from "@utils/font-metrics";
   * const options: LayoutOptions = {
   *   measureText: (text, font, size) => measureTextWidth(text, mapToStandardFont(font), size)
   * };
   * ```
   */
  readonly measureText?: (
    text: string,
    fontName: string,
    fontSize: number,
    bold?: boolean,
    italic?: boolean
  ) => number;

  /**
   * Optional font extent lookup, in points, for precise baseline placement.
   *
   * A line box is taller than the glyphs it holds, and where the surplus goes
   * decides where the text sits: the baseline belongs at `halfLeading + ascent`
   * from the top of the box. Without real extents the engine falls back to the
   * built-in standard-font tables, which are right for the base 14 faces but
   * not for an embedded one — a face with a tall ink box would have
   * its descenders clipped by the line below.
   *
   * `descent` is negative, as font metrics report it.
   *
   * The callback should query the same font engine as `measureText`; `text` is
   * provided because fallback faces may differ glyph-by-glyph.
   */
  readonly measureTextMetrics?: (
    text: string,
    fontName: string,
    fontSize: number,
    bold?: boolean,
    italic?: boolean
  ) => { ascent: number; descent: number };
}

// =============================================================================
// Internal Constants
// =============================================================================

/** Default characters per line. */
const DEFAULT_CHARS_PER_LINE = 80;
/** Auto spacing (automatic space before/after a paragraph): ~100 twips ≈ 5pt. */
const AUTO_SPACING_TWIPS = 100;
/** Default tab stop interval (twips) — Word default is 0.5 inch = 720 twips */
const DEFAULT_TAB_INTERVAL = 720;
/** Footnote separator height (twips): line + spacing ≈ 200 twips */
const FOOTNOTE_SEPARATOR_HEIGHT = 200;
/** Estimated height per footnote reference (single line + spacing) */
const FOOTNOTE_ENTRY_HEIGHT = 300;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * A paragraph's *effective* properties: the style chain (own props → named
 * style → … → docDefaults) collapsed into one view.
 *
 * Pagination has to see exactly what the renderer sees. Reading
 * `para.properties` directly makes every value a named style contributes
 * invisible — spacing, indents, font size — so a document whose headings get
 * their 24pt size and their space-before from a `Heading1` style is estimated
 * as if every paragraph were default-sized body text with no spacing. The
 * estimate then packs far more onto a page than actually fits and the second
 * pass, which does resolve styles, overflows the bottom margin.
 */
interface ResolvedParagraph {
  /** Effective paragraph properties (spacing, indent, keep flags, …). */
  readonly properties: ParagraphProperties | undefined;
  /** Run properties a run inherits when it declares none of its own. */
  readonly runProperties: RunProperties | undefined;
}

/**
 * Style resolution for the in-flight `layoutDocument` call.
 *
 * Mirrors the `activeDoc` slot in `layout-full.ts`: pagination walks
 * paragraphs through tables, footnotes and text boxes, and threading `doc`
 * through every one of those signatures buys nothing. Layout is fully
 * synchronous (no `await`), so a single shared slot is safe. The cache makes
 * the per-paragraph `resolveStyle` (which builds a style map on each call)
 * a once-per-paragraph cost.
 */
let activeStyleCache: Map<Paragraph, ResolvedParagraph> | undefined;
/** Memoised {@link effectiveRunProperties}, same lifetime as `activeStyleCache`. */
let activeRunPropsCache: WeakMap<Run, RunProperties | undefined> | undefined;
let activeDoc: DocxDocument | undefined;

/** Effective properties for `para`, or the raw ones when no document is active. */
function resolved(para: Paragraph): ResolvedParagraph {
  if (!activeDoc || !activeStyleCache) {
    return { properties: para.properties, runProperties: undefined };
  }
  let hit = activeStyleCache.get(para);
  if (!hit) {
    const style = resolveStyle(activeDoc, para);
    // `resolveStyle` drops `style` from the merged result (it is the selector,
    // not an inherited value). Keep it so callers can still recognise a
    // "Heading2" style name.
    hit = {
      properties: para.properties?.style
        ? { ...style.paragraphProperties, style: para.properties.style }
        : style.paragraphProperties,
      runProperties: style.runProperties
    };
    activeStyleCache.set(para, hit);
  }
  return hit;
}

/**
 * The font size (half-points) a run inherits from its paragraph's style
 * chain, falling back to the document-wide default when the chain is silent.
 */
function inheritedFontSize(res: ResolvedParagraph, defaultFontSize: number): number {
  return res.runProperties?.size ?? defaultFontSize;
}

/** The font name a run inherits from its paragraph's style chain. */
function inheritedFontName(res: ResolvedParagraph): string | undefined {
  const font = res.runProperties?.font;
  if (!font) {
    return undefined;
  }
  return typeof font === "string" ? font : ((font as FontSpec).ascii ?? (font as FontSpec).hAnsi);
}

/** Usable content height in twips, from SectionProperties. */
function computeAvailableHeight(sp: SectionProperties | undefined): number {
  const height = sp?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;
  const marginTop = sp?.margins?.top ?? DEFAULT_PAGE_MARGIN_TWIPS;
  const marginBottom = sp?.margins?.bottom ?? DEFAULT_PAGE_MARGIN_TWIPS;

  // Usable height = page height - top margin - bottom margin.
  // In Word the header/footer areas live inside the margins and take no extra
  // body space. Simplified model: a header/footer overflowing into the body
  // area is not accounted for.
  return Math.max(0, height - marginTop - marginBottom);
}

/** Usable content width in twips, from SectionProperties. */
function computeAvailableWidth(sp: SectionProperties | undefined): number {
  const width = sp?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
  const marginLeft = sp?.margins?.left ?? DEFAULT_PAGE_MARGIN_TWIPS;
  const marginRight = sp?.margins?.right ?? DEFAULT_PAGE_MARGIN_TWIPS;
  const gutter = sp?.margins?.gutter ?? 0;
  return Math.max(0, width - marginLeft - marginRight - gutter);
}

/**
 * Single-spaced line height in twips for a given font size.
 *
 * Shares `LINE_HEIGHT_FACTOR` with the positioner so the two passes derive the
 * same natural height from the same font size.
 * halfPt 22 (11pt) → 13.2pt = 264 twips.
 */
function baseLineHeight(fontSizeHalfPt: number): number {
  const ptSize = fontSizeHalfPt / 2;
  return Math.round(ptSize * LINE_HEIGHT_FACTOR * 20); // pt → twips: ×20
}

/**
 * Effective line height in twips for a LineSpacing configuration.
 * - auto:    value is in 240ths of a line (240 = single, 360 = 1.5×, 480 = double)
 * - exact:   value is the height in twips
 * - atLeast: value is a floor in twips — max(value, baseLine)
 */
function computeLineHeight(spacing: LineSpacing | undefined, fontSizeHalfPt: number): number {
  const baseLine = baseLineHeight(fontSizeHalfPt);

  if (!spacing?.line) {
    return baseLine;
  }

  const rule = spacing.lineRule ?? "auto";
  switch (rule) {
    case "auto": {
      // spacing.line is expressed in 240ths of a line.
      const multiplier = spacing.line / 240;
      return Math.round(baseLine * multiplier);
    }
    case "exact":
      return spacing.line;
    case "atLeast":
      return Math.max(spacing.line, baseLine);
    default:
      return baseLine;
  }
}

/** The paragraph's effective font size, in half-points. */
/**
 * The size an *empty* paragraph's line box takes, in half-points.
 *
 * `w:pPr/w:rPr/w:sz` describes the paragraph **mark** — the pilcrow — and nothing
 * else. Using it as the default for every run that declares no size of its own is
 * a different statement, and a wrong one: an 8pt mark shrank the body text with it
 * (a 60-paragraph document reported one page and paginated to two), and a 36pt mark
 * inflated it sixfold (15 pages reported against 3). It governs the line height
 * only when there is no run to measure, which is what the positioned pass does.
 */
function paragraphMarkFontSize(
  props: ParagraphProperties | undefined,
  defaultFontSize: number
): number {
  return props?.markRunProperties?.size ?? defaultFontSize;
}

/**
 * Average character width (twips) for a paragraph whose largest run is
 * `fontSize` half-points, given a document-wide average measured at
 * `defaultFontSize`.
 *
 * A 24pt heading's glyphs are twice as wide as 12pt body text, so counting its
 * lines with the body-text average lets twice as many characters "fit" on a
 * line — the estimator then reports one line where the renderer produces two.
 */
function scaledCharWidth(
  averageCharWidth: number,
  fontSize: number,
  defaultFontSize: number
): number {
  const base = averageCharWidth > 0 ? averageCharWidth : 120;
  if (fontSize <= 0 || defaultFontSize <= 0 || fontSize === defaultFontSize) {
    return base;
  }
  return (base * fontSize) / defaultFontSize;
}

/**
 * The Latin and East Asian typefaces a run draws with.
 *
 * Takes the merged properties rather than the raw run so a caller that has
 * already resolved them — every caller does, to read the size and the
 * bold/italic flags — does not pay for a second `resolveRunStyle`, which
 * rebuilds a style map each time.
 *
 * `w:rFonts` names them separately and this pass read `w:ascii` only, so a run
 * carrying `w:eastAsia="宋体"` was measured against the Latin face — the
 * typeface the author asked for reached neither pagination nor the PDF bridge.
 *
 * `eastAsia` falls back to the Latin name rather than to `"Calibri"`: naming one
 * typeface for a run means it for the whole run.
 */
function getRunFonts(
  props: RunProperties | undefined,
  inherited?: string
): { ascii: string; eastAsia: string } {
  const font = props?.font;
  if (!font) {
    const name = inherited ?? "Calibri";
    return { ascii: name, eastAsia: name };
  }
  if (typeof font === "string") {
    return { ascii: font, eastAsia: font };
  }
  const spec = font as FontSpec;
  const ascii = spec.ascii ?? spec.hAnsi ?? inherited ?? "Calibri";
  return { ascii, eastAsia: spec.eastAsia ?? ascii };
}

/**
 * Measure text with the run's own pair of typefaces, one stretch per script.
 *
 * Uniform text takes a single measurement, so Latin-only input is unchanged.
 */
function measureRunByScript(
  text: string,
  props: RunProperties | undefined,
  inherited: string | undefined,
  fontSize: number,
  measureFn: (t: string, f: string, s: number, b?: boolean, i?: boolean) => number
): number {
  const fonts = getRunFonts(props, inherited);
  if (fonts.ascii === fonts.eastAsia) {
    return measureFn(text, fonts.ascii, fontSize, props?.bold, props?.italic);
  }
  let total = 0;
  for (const run of splitByScript(text)) {
    total += measureFn(
      run.text,
      run.cjk ? fonts.eastAsia : fonts.ascii,
      fontSize,
      props?.bold,
      props?.italic
    );
  }
  return total;
}

/**
 * The extreme vertical metrics of every face a run draws with.
 *
 * Ascent and descent belong to a face, so a mixed run cannot sum them — but it
 * cannot pick one either. This used to take the East Asian face whenever the text
 * contained any CJK, on the stated grounds that "the CJK face is the taller". That
 * is not true of real faces: measured against the OS/2 typo metrics, Songti SC and
 * Heiti SC give 0.86em ascent, while Helvetica Neue gives 0.95em and Hoefler Text
 * 1.01em — so a Latin face inside a mostly-Chinese run was measured against the
 * shorter CJK face and the estimate came out *below* the positioned pass.
 *
 * That inverted the invariant this pass exists to hold (see
 * {@link estimateParagraphLineHeight}): with `w:ascii="Hoefler Text"` and
 * `w:eastAsia="Songti SC"` the estimate was 25% short, so `pageCount` reported one
 * page where the positioned pass produced two — and `NUMPAGES`, `PAGE`, TOC page
 * numbers and `PAGEREF` are all derived from that number.
 *
 * Same shape as `measureRunMetrics` in the positioned pass, which is what keeps
 * the two from disagreeing again.
 */
function measureRunMetricsByScript(
  text: string,
  props: RunProperties | undefined,
  inherited: string | undefined,
  fontSize: number,
  measure: (
    text: string,
    font: string,
    size: number,
    bold?: boolean,
    italic?: boolean
  ) => { ascent: number; descent: number }
): { ascent: number; descent: number } {
  const fonts = getRunFonts(props, inherited);
  if (fonts.ascii === fonts.eastAsia) {
    return measure(text, fonts.ascii, fontSize, props?.bold, props?.italic);
  }
  let ascent = -Infinity;
  let descent = Infinity;
  for (const run of splitByScript(text)) {
    const m = measure(
      run.text,
      run.cjk ? fonts.eastAsia : fonts.ascii,
      fontSize,
      props?.bold,
      props?.italic
    );
    ascent = Math.max(ascent, m.ascent);
    descent = Math.min(descent, m.descent);
  }
  // Empty text yields no stretches; fall back to the Latin face for the metrics.
  return ascent === -Infinity
    ? measure(text, fonts.ascii, fontSize, props?.bold, props?.italic)
    : { ascent, descent };
}

/** Same character-style/direct-formatting merge the positioned pass uses. */
function effectiveRunProperties(run: Run, inherited?: RunProperties): RunProperties | undefined {
  // A run's inherited properties come from its own paragraph, so they are fixed
  // for a given run within one call — the result can be memoised. Three
  // consumers ask for it per run (largest size, text width, line extents), and
  // `resolveRunStyle` rebuilds a style map on every call.
  const cache = activeRunPropsCache;
  if (cache?.has(run)) {
    return cache.get(run);
  }
  const merged =
    activeDoc && run.properties?.style
      ? resolveRunStyle(activeDoc, run, inherited).runProperties
      : mergeRunProperties(inherited, run.properties);
  cache?.set(run, merged);
  return merged;
}

/** Plain text content of a run. */
function getRunText(run: Run): string {
  let text = "";
  for (const item of run.content) {
    switch (item.type) {
      case "text":
        text += item.text;
        break;
      case "tab":
        text += "    "; // a tab counts as roughly 4 characters
        break;
      case "symbol":
        text += " ";
        break;
      case "noBreakHyphen":
      case "softHyphen":
        text += "-";
        break;
      default:
        break;
    }
  }
  return text;
}

/**
 * Check if a character is full-width — roughly 2x the width of a Latin char.
 *
 * Delegates to the shared predicate so the paginator and the positioner classify
 * the same code points the same way; a disagreement here shows up as a page
 * whose contents do not fit the space the paginator budgeted for them.
 */
function isCjkChar(code: number): boolean {
  return isFullWidthCodePoint(code);
}

/**
 * Calculate the effective character width units for a text string.
 * CJK characters count as 2 units, Latin/other as 1 unit.
 */
function getEffectiveTextWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) {
      // Supplementary character (surrogate pair) — skip the low surrogate
      i++;
    }
    width += isCjkChar(code) ? 2 : 1;
  }
  return width;
}

/**
 * Word-based line count calculation using greedy line-breaking algorithm.
 *
 * Splits text at word boundaries (spaces, hyphens, CJK characters) and places
 * words on lines greedily. Accounts for tab stops at their actual positions.
 *
 * @param children - Paragraph children (runs and hyperlinks)
 * @param firstLineWidth - Available width for the first line (twips)
 * @param subsequentWidth - Available width for subsequent lines (twips)
 * @param averageCharWidth - Average character width (twips)
 * @param tabStops - Custom tab stop positions (twips from left margin)
 * @returns Number of lines the paragraph occupies
 */
function computeLineCountWordBased(
  children: readonly ParagraphChild[],
  firstLineWidth: number,
  subsequentWidth: number,
  averageCharWidth: number,
  tabStops?: readonly number[]
): number {
  // Collect all tokens (words, spaces, tabs, images) from all runs
  const tokens = collectTokens(children);
  if (tokens.length === 0) {
    return 1;
  }

  let lineCount = 1;
  let currentLineWidth = firstLineWidth;
  let xPos = 0; // Current x position on the line (in twips)

  for (const token of tokens) {
    if (token.type === "tab") {
      // Advance to next tab stop
      const nextTab = findNextTabStop(xPos, tabStops);
      if (nextTab > currentLineWidth) {
        // Tab would go past line end — wrap to next line
        lineCount++;
        currentLineWidth = subsequentWidth;
        xPos = 0;
      } else {
        xPos = nextTab;
      }
    } else if (token.type === "break") {
      // Hard line break
      lineCount++;
      currentLineWidth = subsequentWidth;
      xPos = 0;
    } else {
      // Word or image token
      const tokenWidth = token.width * averageCharWidth;

      if (xPos + tokenWidth > currentLineWidth && xPos > 0) {
        // Token doesn't fit — wrap to next line
        lineCount++;
        currentLineWidth = subsequentWidth;
        xPos = tokenWidth;
      } else {
        xPos += tokenWidth;
      }
    }
  }

  return lineCount;
}

/** Token types for line breaking */
interface WordToken {
  type: "word";
  width: number; // in character units (CJK-aware)
}
interface TabToken {
  type: "tab";
}
interface BreakToken {
  type: "break";
}
interface ImageToken {
  type: "image";
  width: number; // in character units
}
type LayoutToken = WordToken | TabToken | BreakToken | ImageToken;

/**
 * Collect tokens from paragraph children for line-breaking.
 * Splits text at break opportunities (spaces, after hyphens, between CJK chars).
 */
function collectTokens(children: readonly ParagraphChild[]): LayoutToken[] {
  const tokens: LayoutToken[] = [];

  for (const child of children) {
    if (isRun(child)) {
      collectRunTokens(child, tokens);
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        collectRunTokens(run, tokens);
      }
    }
  }

  return tokens;
}

function collectRunTokens(run: Run, tokens: LayoutToken[]): void {
  for (const item of run.content) {
    switch (item.type) {
      case "text": {
        // Split text into word tokens at break opportunities
        const words = splitIntoWords(item.text);
        for (const word of words) {
          if (word.length > 0) {
            tokens.push({ type: "word", width: getEffectiveTextWidth(word) });
          }
        }
        break;
      }
      case "tab":
        tokens.push({ type: "tab" });
        break;
      case "break":
        tokens.push({ type: "break" });
        break;
      case "image": {
        const img = item as { type: "image"; width?: number };
        const w = img.width ? Math.ceil(emuToTwips(img.width) / 120) : 10;
        tokens.push({ type: "image", width: w });
        break;
      }
      case "symbol":
        tokens.push({ type: "word", width: 1 });
        break;
      case "noBreakHyphen":
        tokens.push({ type: "word", width: 1 });
        break;
      default:
        break;
    }
  }
}

/**
 * Split text into words at break opportunities.
 * Break opportunities: after space, after hyphen, between CJK characters.
 * Spaces are included with the preceding word (trailing space model).
 */
function splitIntoWords(text: string): string[] {
  const words: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    if (code > 0xffff) {
      i++; // Skip surrogate pair low half
    }

    if (code === 0x20 || code === 0x0a) {
      // Space — attach to current word and break after
      current += ch;
      words.push(current);
      current = "";
    } else if (code === 0x2d || code === 0x2010 || code === 0x2011) {
      // Hyphen — break after hyphen
      current += ch;
      words.push(current);
      current = "";
    } else if (isCjkChar(code)) {
      // CJK characters: each is its own break opportunity
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      words.push(ch);
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    words.push(current);
  }

  return words;
}

/**
 * Find the next tab stop position (in twips) after the given x position.
 */
function findNextTabStop(xPos: number, tabStops?: readonly number[]): number {
  if (tabStops && tabStops.length > 0) {
    // Find the first tab stop after xPos
    for (const stop of tabStops) {
      if (stop > xPos) {
        return stop;
      }
    }
    // All defined stops passed — use interval from last stop
    const lastStop = tabStops[tabStops.length - 1];
    const interval = DEFAULT_TAB_INTERVAL;
    return lastStop + Math.ceil((xPos - lastStop) / interval) * interval + interval;
  }
  // Default: advance to next multiple of DEFAULT_TAB_INTERVAL
  return (Math.floor(xPos / DEFAULT_TAB_INTERVAL) + 1) * DEFAULT_TAB_INTERVAL;
}

/**
 * Compute the effective available width for text in a paragraph, accounting for:
 * - First line indent / hanging indent
 * - Numbering indent
 * Returns [firstLineWidth, subsequentLineWidth] in twips.
 */
function computeParagraphLineWidths(
  props: ParagraphProperties | undefined,
  availableWidth: number
): [number, number] {
  const indent = props?.indent;
  const leftIndent = indent?.left ?? 0;
  const rightIndent = indent?.right ?? 0;
  const firstLine = indent?.firstLine ?? 0;
  const hanging = indent?.hanging ?? 0;

  // Base width after left/right indents
  const baseWidth = Math.max(1, availableWidth - leftIndent - rightIndent);

  // firstLine means the first line is indented additionally (less available width)
  // hanging means subsequent lines are indented (first line gets extra width)
  if (hanging > 0) {
    return [Math.max(1, baseWidth + hanging), baseWidth];
  }
  if (firstLine > 0) {
    return [Math.max(1, baseWidth - firstLine), baseWidth];
  }
  return [baseWidth, baseWidth];
}

/**
 * Check if a paragraph has an inline image that contributes line height.
 * Returns the maximum image height in twips found in the paragraph, or 0.
 */
function getInlineImageMaxHeight(children: readonly ParagraphChild[]): number {
  let maxHeight = 0;
  for (const child of children) {
    if (isRun(child)) {
      for (const item of child.content) {
        if (item.type === "image") {
          const img = item as { type: "image"; height?: number };
          if (img.height) {
            const h = emuToTwips(img.height);
            if (h > maxHeight) {
              maxHeight = h;
            }
          }
        }
      }
    }
  }
  return maxHeight;
}

/**
 * Count footnote/endnote references in a paragraph.
 */
function countFootnoteRefs(children: readonly ParagraphChild[]): number {
  let count = 0;
  for (const child of children) {
    if (isRun(child)) {
      for (const item of child.content) {
        if (item.type === "footnoteRef" || item.type === "endnoteRef") {
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Count hard line break elements in a paragraph (type "break" without breakType "page"/"column").
 */
function countBreakElements(children: readonly ParagraphChild[]): number {
  let count = 0;
  for (const child of children) {
    if (isRun(child)) {
      for (const item of child.content) {
        if (item.type === "break") {
          const breakType = (item as { breakType?: string }).breakType;
          if (!breakType || breakType === "textWrapping") {
            count++;
          }
        }
      }
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        for (const item of run.content) {
          if (item.type === "break") {
            const breakType = (item as { breakType?: string }).breakType;
            if (!breakType || breakType === "textWrapping") {
              count++;
            }
          }
        }
      }
    }
  }
  return count;
}

/**
 * Total text width of a paragraph in points, via the `measureText` callback.
 * Each run is measured with its own font and size, then summed.
 */
function measureParagraphTextWidth(
  children: readonly ParagraphChild[],
  defaultFontSize: number,
  measureFn: (
    text: string,
    fontName: string,
    fontSize: number,
    bold?: boolean,
    italic?: boolean
  ) => number,
  inheritedFont?: string,
  inheritedProps?: RunProperties
): number {
  let totalWidth = 0;
  for (const child of children) {
    if (isRun(child)) {
      const text = getRunText(child);
      if (text.length > 0) {
        const props = effectiveRunProperties(child, inheritedProps);
        const fontSize = getRunLayoutFontSizePt(props, defaultFontSize);
        totalWidth += measureRunByScript(text, props, inheritedFont, fontSize, measureFn);
      }
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        const text = getRunText(run);
        if (text.length > 0) {
          const props = effectiveRunProperties(run, inheritedProps);
          const fontSize = getRunLayoutFontSizePt(props, defaultFontSize);
          totalWidth += measureRunByScript(text, props, inheritedFont, fontSize, measureFn);
        }
      }
    }
  }
  return totalWidth;
}

/** The largest run font size in a paragraph. */
function getMaxRunFontSize(
  children: readonly ParagraphChild[],
  defaultFontSize: number,
  inheritedProps?: RunProperties,
  emptyParagraphSize = defaultFontSize
): number {
  let maxSize = 0;
  for (const child of children) {
    if (isRun(child)) {
      const size =
        getRunLayoutFontSizePt(effectiveRunProperties(child, inheritedProps), defaultFontSize) * 2;
      if (size > maxSize) {
        maxSize = size;
      }
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        const size =
          getRunLayoutFontSizePt(effectiveRunProperties(run, inheritedProps), defaultFontSize) * 2;
        if (size > maxSize) {
          maxSize = size;
        }
      }
    }
  }
  // No run to measure: the paragraph mark's own size decides the line box.
  return maxSize || emptyParagraphSize;
}

/** Effective rendered size of a run; Word draws scripts at 65% of their source size. */
function getRunLayoutFontSizePt(
  properties: RunProperties | undefined,
  defaultFontSizeHalfPt: number
): number {
  const size = (properties?.size ?? defaultFontSizeHalfPt) / 2;
  return properties?.vertAlign === "superscript" || properties?.vertAlign === "subscript"
    ? size * SCRIPT_FONT_SIZE_RATIO
    : size;
}

/** Whether any run in the paragraph contains a page break. */
function hasPageBreakInRuns(children: readonly ParagraphChild[]): boolean {
  for (const child of children) {
    if (isRun(child)) {
      for (const item of child.content) {
        if (item.type === "break" && (item as { breakType?: string }).breakType === "page") {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Whether a page break precedes any of the paragraph's content.
 *
 * Only a *leading* break means "start this paragraph on a new page". One in the
 * middle splits the paragraph: the lines before it belong to the page it is
 * already on. Treating any break as a break-before moved the whole paragraph and
 * carried that leading text onto the wrong page.
 */
function hasLeadingPageBreak(children: readonly ParagraphChild[]): boolean {
  for (const child of children) {
    if (!isRun(child)) {
      continue;
    }
    for (const item of child.content) {
      if (item.type === "break") {
        if ((item as { breakType?: string }).breakType === "page") {
          return true;
        }
        continue;
      }
      if (item.type === "text" && item.text.length === 0) {
        continue;
      }
      // Anything else is real content: a later break splits rather than moves.
      return false;
    }
  }
  return false;
}

/** Whether any run in the paragraph contains a column break. */
function hasColumnBreakInRuns(children: readonly ParagraphChild[]): boolean {
  for (const child of children) {
    if (isRun(child)) {
      for (const item of child.content) {
        if (item.type === "break" && (item as { breakType?: string }).breakType === "column") {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Estimated paragraph height in twips.
 *
 * height = spaceBefore + (lineCount × lineHeight) + spaceAfter
 *
 * Line count calculation:
 * 1. If measureTextFn is provided → precise measurement
 * 2. Otherwise → CJK-aware effective width estimation with indent handling
 *
 * Also accounts for:
 * - Inline images that exceed line height
 * - First-line / hanging indent
 * - Tab stop positioning
 */
function estimateParagraphHeight(
  para: Paragraph,
  availableWidth: number,
  defaultFontSize: number,
  defaultCharsPerLine: number,
  averageCharWidth: number,
  measureTextFn?: (text: string, fontName: string, fontSize: number) => number,
  measureTextMetricsFn?: LayoutOptions["measureTextMetrics"]
): number {
  // Effective properties — style chain included. See `resolved`.
  const res = resolved(para);
  const props = res.properties;
  const spacing = props?.spacing;
  const inheritedSize = inheritedFontSize(res, defaultFontSize);
  const inheritedFont = inheritedFontName(res);

  // Space before
  let spaceBefore = 0;
  if (spacing?.beforeAutoSpacing) {
    spaceBefore = AUTO_SPACING_TWIPS;
  } else if (spacing?.before != null) {
    spaceBefore = spacing.before;
  }

  // Space after
  let spaceAfter = 0;
  if (spacing?.afterAutoSpacing) {
    spaceAfter = AUTO_SPACING_TWIPS;
  } else if (spacing?.after != null) {
    spaceAfter = spacing.after;
  }

  // A heading with no declared `w:sz` is drawn larger by a heuristic scale. The
  // positioned pass applies it and this one did not, so a run of `Heading 1`
  // paragraphs was estimated at body height — 40 of them reported one page and
  // paginated to two, which is the number `NUMPAGES`, `PAGE`, TOC entries and
  // `PAGEREF` are all resolved from. Same expression as the positioned pass, from
  // `layout-constants`.
  const headingScale = resolveHeadingScale(props, res.runProperties?.size);

  // Paragraph font size — a run that declares no size of its own inherits it
  // from the style chain.
  const fontSize = getMaxRunFontSize(
    para.children,
    inheritedSize,
    res.runProperties,
    paragraphMarkFontSize(props, inheritedSize)
  );

  // Line height. `headingScale` applies here and *only* here, matching the
  // positioned pass: it enlarges the line box of a heading that declares no
  // `w:sz`, but the runs are still measured — and therefore still wrapped — at
  // their own size. Scaling the width too turned a one-line heading into two and
  // over-reserved by 1.8×, which is as wrong for `NUMPAGES` as under-reserving.
  const lineHeight = computeLineHeight(spacing, fontSize) * headingScale;

  // Check if inline images increase the effective line height
  const imgMaxHeight = getInlineImageMaxHeight(para.children);
  const effectiveLineHeight = estimateParagraphLineHeight(
    para.children,
    inheritedSize,
    inheritedFont,
    res.runProperties,
    lineHeight,
    imgMaxHeight,
    spacing?.lineRule === "exact",
    measureTextMetricsFn
  );

  // Line count
  let lineCount: number;
  if (measureTextFn) {
    // Precise measurement: first and subsequent lines can have different widths.
    const [firstLineW, subsequentW] = computeParagraphLineWidths(props, availableWidth);
    const textWidthPt = measureParagraphTextWidth(
      para.children,
      inheritedSize,
      measureTextFn,
      inheritedFont,
      res.runProperties
    );
    const textWidthTwips = textWidthPt * 20; // 1pt = 20 twips

    // Count hard line breaks in the paragraph
    const breakCount = countBreakElements(para.children);

    if (breakCount > 0) {
      // If there are hard breaks, use word-based line counting for accuracy
      const charWidth = scaledCharWidth(averageCharWidth, fontSize, defaultFontSize);
      const tabStops = props?.tabs?.map(t => t.position).filter((p): p is number => p != null);
      lineCount = computeLineCountWordBased(
        para.children,
        firstLineW,
        subsequentW,
        charWidth,
        tabStops
      );
    } else if (textWidthTwips <= firstLineW) {
      lineCount = 1;
    } else {
      // First line fills firstLineW, remaining fills subsequentW
      const remaining = textWidthTwips - firstLineW;
      lineCount = 1 + Math.max(1, Math.ceil(remaining / subsequentW));
    }
  } else {
    // Word-based line breaking with CJK awareness and tab stop support
    const [firstLineW, subsequentW] = computeParagraphLineWidths(props, availableWidth);
    const charWidth = scaledCharWidth(averageCharWidth, fontSize, defaultFontSize);

    // Extract tab stop positions from paragraph properties
    const tabStops = props?.tabs?.map(t => t.position).filter((p): p is number => p != null);

    lineCount = computeLineCountWordBased(
      para.children,
      firstLineW,
      subsequentW,
      charWidth,
      tabStops
    );
  }

  return spaceBefore + lineCount * effectiveLineHeight + spaceAfter;
}

/**
 * Conservative per-line height for the pagination pass.
 *
 * This pass does not know which runs wrap onto which line, so it takes the
 * largest shifted ascent/descent across the paragraph. That may reserve a
 * little too much for a mixed-font paragraph, but it can never place more on a
 * page than the positioned pass can fit — the invariant widow/orphan,
 * keep-with-next and table pagination require.
 */
function estimateParagraphLineHeight(
  children: readonly ParagraphChild[],
  inheritedSizeHalfPt: number,
  inheritedFont: string | undefined,
  inheritedProps: RunProperties | undefined,
  nominalHeightTwips: number,
  imageHeightTwips: number,
  exact: boolean,
  measureTextMetricsFn: LayoutOptions["measureTextMetrics"]
): number {
  let ascent = 0;
  let descent = 0;
  const visitRun = (run: Run) => {
    const text = getRunText(run);
    const props = effectiveRunProperties(run, inheritedProps);
    const fontSize = getRunLayoutFontSizePt(props, inheritedSizeHalfPt);
    const metrics = measureRunMetricsByScript(
      text,
      props,
      inheritedFont,
      fontSize,
      measureTextMetricsFn ??
        ((t, font, size, bold, italic) => ({
          ascent: getFontAscent(styledFontVariant(font, bold, italic), size),
          descent: getFontDescent(styledFontVariant(font, bold, italic), size)
        }))
    );
    const shift =
      props?.vertAlign === "superscript"
        ? fontSize * SCRIPT_BASELINE_SHIFT_FACTOR
        : props?.vertAlign === "subscript"
          ? -fontSize * SCRIPT_BASELINE_SHIFT_FACTOR
          : 0;
    ascent = Math.max(ascent, metrics.ascent + shift);
    descent = Math.min(descent, metrics.descent + shift);
  };
  for (const child of children) {
    if (isRun(child)) {
      visitRun(child);
    } else if (isHyperlink(child)) {
      child.children.forEach(visitRun);
    }
  }
  const metrics = resolveWordLineMetrics({
    nominalHeight: nominalHeightTwips / 20,
    ascent,
    descent,
    imageAscent: imageHeightTwips / 20,
    exact
  });
  // Round up: this estimate must never claim a line is shorter than the
  // positioned pass will make it, or a page could be judged to have room it
  // does not have.
  return Math.ceil(metrics.height * 20);
}

/** Estimated height of one table row in twips, including cell content. */
function estimateRowHeight(
  table: Table,
  rowIndex: number,
  defaultFontSize: number,
  availableWidth: number,
  defaultCharsPerLine: number,
  averageCharWidth: number,
  measureTextFn?: (text: string, fontName: string, fontSize: number) => number,
  measureTextMetricsFn?: LayoutOptions["measureTextMetrics"]
): number {
  const row = table.rows[rowIndex];

  // If explicit height is set with "exact" rule, use it directly
  if (row.properties?.height?.value) {
    const rule = row.properties.height.rule;
    if (rule === "exact") {
      return row.properties.height.value;
    }
  }

  // Calculate the maximum content height across all cells in this row
  const colCount = row.cells.length;
  // Scaled to the measure, like the positioned pass: `w:tblGrid` is advisory, and a
  // grid wider than the page is shrunk to fit. Using the declared twips as-is
  // estimated a table from the Excel or HTML bridge with columns twice their drawn
  // width — half the wrapped lines, and a page count short of the truth.
  const colWidths = resolveColumnWidthsTwips(table, colCount, availableWidth);

  let maxCellHeight = 0;
  for (let c = 0; c < colCount; c++) {
    const cell = row.cells[c];
    const gridSpan = cell.properties?.gridSpan ?? 1;
    let cellWidth = 0;
    for (let g = 0; g < gridSpan && c + g < colWidths.length; g++) {
      cellWidth += colWidths[c + g];
    }

    // Inset by the cell's effective margins (`w:tcMar` → `w:tblCellMar` →
    // Word's defaults). Hardcoding the defaults here ignored any table that
    // declared its own, so this estimate and the positioner disagreed about both
    // the wrap width and the row height.
    const cellMargins = resolveCellMarginsTwips(table.properties, cell.properties);
    const cellContentWidth = Math.max(1, cellWidth - cellMargins.left - cellMargins.right);

    // Calculate height of cell content (paragraphs + nested tables)
    let cellHeight = 0;
    for (const content of cell.content) {
      if (content.type === "paragraph") {
        cellHeight += estimateParagraphHeight(
          content,
          cellContentWidth,
          defaultFontSize,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn,
          measureTextMetricsFn
        );
      } else if (content.type === "table") {
        cellHeight += estimateTableHeight(
          content,
          defaultFontSize,
          cellContentWidth,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn,
          measureTextMetricsFn
        );
      }
    }

    cellHeight += cellMargins.top + cellMargins.bottom;

    if (cellHeight > maxCellHeight) {
      maxCellHeight = cellHeight;
    }
  }

  // Respect "atLeast" height constraint
  if (row.properties?.height?.value) {
    return Math.max(row.properties.height.value, maxCellHeight);
  }

  // Minimum height: one line plus the table's own cell margins, from the same
  // function the positioned pass uses.
  const minHeight = minimumRowHeightPt(table.properties, defaultFontSize / 2) * 20;
  return Math.max(minHeight, maxCellHeight);
}

/** Estimated total table height in twips. */
function estimateTableHeight(
  table: Table,
  defaultFontSize: number,
  availableWidth: number,
  defaultCharsPerLine: number,
  averageCharWidth: number,
  measureTextFn?: (text: string, fontName: string, fontSize: number) => number,
  measureTextMetricsFn?: LayoutOptions["measureTextMetrics"]
): number {
  let total = 0;
  for (let i = 0; i < table.rows.length; i++) {
    total += estimateRowHeight(
      table,
      i,
      defaultFontSize,
      availableWidth,
      defaultCharsPerLine,
      averageCharWidth,
      measureTextFn,
      measureTextMetricsFn
    );
  }
  return total;
}

/** EMU → twips (1 inch = 914400 EMU = 1440 twips). */
function emuToTwips(emu: number): number {
  return Math.round(emu / 635);
}

/** Height a floating image occupies in the document flow, in twips.
 *  - "topAndBottom" wrapping: the image takes vertical space
 *  - other wrapping modes: no body-flow space is consumed
 */
function estimateFloatingImageHeight(img: FloatingImage): number {
  const wrapStyle = img.wrap?.style;
  // topAndBottom wrapping style causes the image to consume vertical space
  if (wrapStyle === "topAndBottom") {
    return emuToTwips(img.height);
  }
  // All other floating modes don't consume flow space
  return 0;
}

/** Height a DrawingShape occupies in the document flow, in twips. */
function estimateDrawingShapeHeight(shape: DrawingShape): number {
  const wrapStyle = shape.wrap?.style;
  // topAndBottom wrapping style causes the shape to consume vertical space
  if (wrapStyle === "topAndBottom") {
    return emuToTwips(shape.height);
  }
  // Inline/no-wrap shapes that appear in body content consume flow space
  if (!wrapStyle || wrapStyle === "none") {
    return emuToTwips(shape.height);
  }
  return 0;
}

/** Usable column width, accounting for a multi-column layout. */
function computeColumnWidth(availableWidth: number, columns: SectionColumns | undefined): number {
  if (!columns) {
    return availableWidth;
  }
  const count = columns.count ?? 1;
  if (count <= 1) {
    return availableWidth;
  }
  const space = columns.space ?? 720; // default 0.5 inch gutter
  // total width = count * colWidth + (count - 1) * space
  // colWidth = (totalWidth - (count - 1) * space) / count
  return Math.max(1, Math.floor((availableWidth - (count - 1) * space) / count));
}

/** Collect the bookmarks declared in a paragraph. */
function collectBookmarks(
  children: readonly ParagraphChild[],
  currentPage: number,
  bookmarkPages: Map<string, number>
): void {
  for (const child of children) {
    if (
      "type" in child &&
      (child as { type: string }).type === "bookmarkStart" &&
      "name" in child
    ) {
      const bookmark = child as { type: "bookmarkStart"; name: string };
      bookmarkPages.set(bookmark.name, currentPage);
    }
  }
}

// =============================================================================
// Main Layout Function
// =============================================================================

/**
 * Paginate the document.
 * Returns the page each body-content item lands on, plus the total page count.
 */
export function layoutDocument(doc: DocxDocument, options?: LayoutOptions): LayoutResult {
  // Paginating must see the same effective properties the renderer sees, so
  // style resolution is active for the whole call. See `resolved`.
  const previousDoc = activeDoc;
  const previousCache = activeStyleCache;
  const previousRunProps = activeRunPropsCache;
  activeDoc = doc;
  activeStyleCache = new Map();
  activeRunPropsCache = new WeakMap();
  try {
    return layoutDocumentInner(doc, options);
  } finally {
    activeDoc = previousDoc;
    activeStyleCache = previousCache;
    activeRunPropsCache = previousRunProps;
  }
}

function layoutDocumentInner(doc: DocxDocument, options?: LayoutOptions): LayoutResult {
  const defaultFontSize = options?.defaultFontSize ?? DEFAULT_FONT_SIZE_HALF_PT;
  const defaultCharsPerLine = options?.defaultCharsPerLine ?? DEFAULT_CHARS_PER_LINE;
  // Average character width in twips: a 12pt font is ~6pt wide = 120 twips.
  const averageCharWidth =
    options?.averageCharWidth ?? Math.round((defaultFontSize / 2) * 0.5 * 20);
  const measureTextFn = options?.measureText;
  const measureTextMetricsFn = options?.measureTextMetrics;

  const body = doc.body;
  const contentPages: number[] = [];
  const contentSections: number[] = [];
  // Which items the *document* demands start a new page — as opposed to the
  // ones this estimate merely ran out of room for. See `forcedBreakBefore`.
  const forcedBreakBefore: boolean[] = [];
  const bookmarkPages = new Map<string, number>();
  const sectionPageCounts: number[] = [];

  // Layout state
  let currentPage = 1; // 1-based page number
  let currentSection = 0; // 0-based section index
  let sectionStartPage = 1; // first page of the current section
  let currentY = 0; // Y offset on the current page (twips from content-area top)

  // Multi-column state
  let currentColumn = 0; // current column (0-based)
  let columnCount = 1; // column count of the current section

  // Page properties of the current section.
  // Document structure: a section's SectionProperties live on the properties of
  // its LAST paragraph; the final section's properties live on
  // `doc.sectionProperties`.
  let currentSectionProps = findFirstSectionProps(body) ?? doc.sectionProperties;
  let availableHeight = computeAvailableHeight(currentSectionProps);
  let availableWidth = computeAvailableWidth(currentSectionProps);
  // Effective usable column width (multi-column aware)
  let effectiveWidth = computeColumnWidth(availableWidth, currentSectionProps?.columns);

  /** Refresh the column count and effective width. */
  function updateColumnLayout(): void {
    columnCount = currentSectionProps?.columns?.count ?? 1;
    if (columnCount < 1) {
      columnCount = 1;
    }
    effectiveWidth = computeColumnWidth(availableWidth, currentSectionProps?.columns);
  }

  // Initialise multi-column state
  updateColumnLayout();

  /** Start a new page. */
  function newPage(): void {
    currentPage++;
    currentY = 0;
    currentColumn = 0;
  }

  /** Advance to the next column; start a new page when already in the last one. */
  function nextColumn(): void {
    if (columnCount > 1 && currentColumn < columnCount - 1) {
      currentColumn++;
      currentY = 0;
    } else {
      newPage();
    }
  }

  /** Start a new section. */
  function newSection(
    breakType: SectionBreakType,
    nextSectionProps: SectionProperties | undefined
  ): void {
    // Record the page count of the section being closed.
    sectionPageCounts.push(currentPage - sectionStartPage + 1);

    currentSection++;
    const nextProps = nextSectionProps ?? doc.sectionProperties;

    switch (breakType) {
      case "nextPage":
        newPage();
        break;
      case "evenPage": {
        // Skip to the next even page.
        newPage();
        if (currentPage % 2 !== 0) {
          newPage();
        }
        break;
      }
      case "oddPage": {
        // Skip to the next odd page.
        newPage();
        if (currentPage % 2 !== 1) {
          newPage();
        }
        break;
      }
      case "continuous": {
        // A change of page setup (size) forces a page break.
        const currentWidth = currentSectionProps?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
        const currentHeight = currentSectionProps?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;
        const nextWidth = nextProps?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
        const nextHeight = nextProps?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;

        if (currentWidth !== nextWidth || currentHeight !== nextHeight) {
          newPage();
        }
        // Otherwise continue at the current position.
        break;
      }
      case "nextColumn":
        // Multi-column layout: advance to the next column.
        nextColumn();
        break;
    }

    sectionStartPage = currentPage;
    currentSectionProps = nextProps;
    availableHeight = computeAvailableHeight(currentSectionProps);
    availableWidth = computeAvailableWidth(currentSectionProps);
    updateColumnLayout();
  }

  /** Add content to the current page, breaking to the next when it does not fit. */
  function addContent(height: number): void {
    if (currentY + height > availableHeight && currentY > 0) {
      // Does not fit the current page/column — move to the next one.
      if (columnCount > 1 && currentColumn < columnCount - 1) {
        nextColumn();
      } else {
        newPage();
      }
    }
    currentY += height;
  }

  /** Paginate a table row by row, honouring `cantSplit` and repeated header rows. */
  function layoutTable(table: Table): void {
    const totalHeight = estimateTableHeight(
      table,
      defaultFontSize,
      effectiveWidth,
      defaultCharsPerLine,
      averageCharWidth,
      measureTextFn,
      measureTextMetricsFn
    );

    // Fast path: the whole table fits in the space left on this page.
    if (currentY + totalHeight <= availableHeight) {
      currentY += totalHeight;
      return;
    }

    // The table must span pages. If this page already has content and the
    // first row does not fit, break before starting the table.
    const firstRowHeight = estimateRowHeight(
      table,
      0,
      defaultFontSize,
      effectiveWidth,
      defaultCharsPerLine,
      averageCharWidth,
      measureTextFn,
      measureTextMetricsFn
    );
    if (currentY > 0 && currentY + firstRowHeight > availableHeight) {
      if (columnCount > 1 && currentColumn < columnCount - 1) {
        nextColumn();
      } else {
        newPage();
      }
    }

    // Identify header rows (`tableHeader = true`), repeated on every page.
    let headerHeight = 0;
    const headerRows: number[] = [];
    for (let r = 0; r < table.rows.length; r++) {
      if (table.rows[r].properties?.tableHeader) {
        headerRows.push(r);
        headerHeight += estimateRowHeight(
          table,
          r,
          defaultFontSize,
          effectiveWidth,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn,
          measureTextMetricsFn
        );
      } else {
        break; // header rows must be a contiguous run starting at row 0
      }
    }

    // Lay out row by row.
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      const rowHeight = estimateRowHeight(
        table,
        r,
        defaultFontSize,
        effectiveWidth,
        defaultCharsPerLine,
        averageCharWidth,
        measureTextFn,
        measureTextMetricsFn
      );

      // Header rows are already reserved at the top of a new page via headerHeight.
      if (headerRows.includes(r)) {
        // Header rows are placed directly.
        currentY += rowHeight;
        continue;
      }

      // cantSplit: the row may not be split across pages — if it does not fit,
      // the whole row moves to the next page.
      const cantSplit = row.properties?.cantSplit ?? false;

      if (cantSplit || rowHeight <= availableHeight) {
        // Check whether the row still fits on the current page.
        if (currentY + rowHeight > availableHeight) {
          // Break to the next page/column.
          if (columnCount > 1 && currentColumn < columnCount - 1) {
            nextColumn();
          } else {
            newPage();
          }
          // Repeat the header rows at the top of the new page.
          currentY += headerHeight;
        }
      } else {
        // The row is taller than a whole page (degenerate case) — place it as is.
        if (currentY + rowHeight > availableHeight && currentY > 0) {
          if (columnCount > 1 && currentColumn < columnCount - 1) {
            nextColumn();
          } else {
            newPage();
          }
          currentY += headerHeight;
        }
      }

      currentY += rowHeight;
    }
  }

  // =========================================================================
  // Walk the body content.
  // =========================================================================

  for (let i = 0; i < body.length; i++) {
    const item = body[i];

    switch (item.type) {
      case "paragraph": {
        const para = item;
        const props = para.properties;

        // Collect bookmarks.
        collectBookmarks(para.children, currentPage, bookmarkPages);

        // Handle a paragraph-level sectionProperties (a section break).
        // Note: the paragraph carrying sectionProperties is the LAST paragraph of
        // its section, and those properties define that section's page setup.
        if (props?.sectionProperties) {
          // Lay out the paragraph itself first.
          const paraHeight = estimateParagraphHeight(
            para,
            effectiveWidth,
            defaultFontSize,
            defaultCharsPerLine,
            averageCharWidth,
            measureTextFn,
            measureTextMetricsFn
          );
          handleParagraphLayout(para, paraHeight, i, body);
          contentPages.push(currentPage);
          contentSections.push(currentSection);
          forcedBreakBefore.push(false);

          // Then open the next section.
          const nextSP = findNextSectionProps(body, i + 1) ?? doc.sectionProperties;
          newSection(props.sectionProperties.breakType ?? "nextPage", nextSP);
          break;
        }

        // pageBreakBefore: force a page break before this paragraph.
        // A named style can supply it (Word's "Heading 1, page break before"),
        // so read the style-resolved effective properties.
        // Only `w:pageBreakBefore` and a *leading* `w:br w:type="page"` move the
        // paragraph; an internal break is handled by splitting it (see
        // `hasLeadingPageBreak`).
        const wantsPageBreak =
          resolved(para).properties?.pageBreakBefore === true || hasLeadingPageBreak(para.children);
        if (wantsPageBreak && currentY > 0) {
          newPage();
        }
        // An internal break still consumes the rest of the page, which the
        // height estimate has to allow for or the paginator will under-count
        // pages badly on break-heavy documents.
        const hasInternalPageBreak = !wantsPageBreak && hasPageBreakInRuns(para.children);

        // column break: advance to the next column in a multi-column layout.
        if (hasColumnBreakInRuns(para.children) && currentY > 0) {
          nextColumn();
        }

        const paraHeight = estimateParagraphHeight(
          para,
          effectiveWidth,
          defaultFontSize,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn,
          measureTextMetricsFn
        );

        handleParagraphLayout(para, paraHeight, i, body);
        if (hasInternalPageBreak) {
          newPage();
        }

        contentPages.push(currentPage);
        contentSections.push(currentSection);
        forcedBreakBefore.push(wantsPageBreak);
        break;
      }

      case "table": {
        const tableStartPage = currentPage;
        layoutTable(item);
        contentPages.push(tableStartPage);
        contentSections.push(currentSection);
        forcedBreakBefore.push(false);
        break;
      }

      default: {
        // FloatingImage, TableOfContents, MathBlock, TextBox, CheckBox,
        // DrawingShape, OpaqueDrawing, ChartContent, AltChunk, SDT
        const minHeight = baseLineHeight(defaultFontSize);
        if (item.type === "tableOfContents") {
          // A table of contents usually spans several paragraphs.
          const tocParas = (item as { cachedParagraphs?: readonly Paragraph[] }).cachedParagraphs;
          const tocHeight = tocParas
            ? tocParas.length * baseLineHeight(defaultFontSize)
            : minHeight * 5;
          addContent(tocHeight);
        } else if (item.type === "floatingImage") {
          // Whether it consumes body-flow space depends on the wrap style.
          const imgHeight = estimateFloatingImageHeight(item as FloatingImage);
          if (imgHeight > 0) {
            addContent(imgHeight);
          }
          // Other floating modes consume no body-flow space.
        } else if (item.type === "drawingShape") {
          // Height consumed, from the wrap style and the shape's size.
          const shapeHeight = estimateDrawingShapeHeight(item as DrawingShape);
          if (shapeHeight > 0) {
            addContent(shapeHeight);
          } else {
            addContent(minHeight);
          }
        } else {
          addContent(minHeight);
        }
        contentPages.push(currentPage);
        contentSections.push(currentSection);
        forcedBreakBefore.push(false);
        break;
      }
    }
  }

  // Record the page count of the last section.
  sectionPageCounts.push(currentPage - sectionStartPage + 1);

  return {
    pageCount: currentPage,
    sectionPageCounts,
    contentPages,
    contentSections,
    bookmarkPages,
    forcedBreakBefore
  };

  // =========================================================================
  // Paragraph placement helpers (keepNext, keepLines, widowControl, orphanControl)
  // =========================================================================

  function handleParagraphLayout(
    para: Paragraph,
    paraHeight: number,
    index: number,
    bodyContent: readonly BodyContent[]
  ): void {
    // Effective properties — style chain included. See `resolved`.
    const res = resolved(para);
    const props = res.properties;
    const spacing = props?.spacing;
    const inheritedSize = inheritedFontSize(res, defaultFontSize);
    const inheritedFont = inheritedFontName(res);
    const fontSize = getMaxRunFontSize(
      para.children,
      inheritedSize,
      undefined,
      paragraphMarkFontSize(props, inheritedSize)
    );
    const lineHeight = computeLineHeight(spacing, fontSize);

    // Line count for the paragraph (CJK-aware).
    let lineCount: number;
    if (measureTextFn) {
      const [firstLineW, subsequentW] = computeParagraphLineWidths(props, effectiveWidth);
      const textWidthPt = measureParagraphTextWidth(
        para.children,
        inheritedSize,
        measureTextFn,
        inheritedFont
      );
      const textWidthTwips = textWidthPt * 20;

      // Count hard line breaks in the paragraph
      const breakCount = countBreakElements(para.children);

      if (breakCount > 0) {
        // If there are hard breaks, use word-based line counting for accuracy
        const charWidth = scaledCharWidth(averageCharWidth, fontSize, defaultFontSize);
        const tabStops = props?.tabs?.map(t => t.position).filter((p): p is number => p != null);
        lineCount = computeLineCountWordBased(
          para.children,
          firstLineW,
          subsequentW,
          charWidth,
          tabStops
        );
      } else if (textWidthTwips <= firstLineW) {
        lineCount = 1;
      } else {
        lineCount = 1 + Math.max(1, Math.ceil((textWidthTwips - firstLineW) / subsequentW));
      }
    } else {
      const [firstLineW, subsequentW] = computeParagraphLineWidths(props, effectiveWidth);
      const charWidth = scaledCharWidth(averageCharWidth, fontSize, defaultFontSize);
      const tabStops = props?.tabs?.map(t => t.position).filter((p): p is number => p != null);

      lineCount = computeLineCountWordBased(
        para.children,
        firstLineW,
        subsequentW,
        charWidth,
        tabStops
      );
    }

    // Contextual spacing: collapse space between paragraphs with same style
    if (props?.contextualSpacing && index > 0) {
      const prevItem = bodyContent[index - 1];
      if (prevItem.type === "paragraph" && prevItem.properties?.style === props.style) {
        // Collapse spaceBefore — already accounted for in paraHeight but we subtract it
        const spaceBefore = spacing?.before ?? 0;
        if (spaceBefore > 0) {
          // Adjust currentY back by the collapsed space
          currentY -= Math.min(spaceBefore, currentY);
        }
      }
    }

    // keepLines: the whole paragraph must stay on one page.
    if (props?.keepLines) {
      if (currentY + paraHeight > availableHeight && currentY > 0) {
        if (columnCount > 1 && currentColumn < columnCount - 1) {
          nextColumn();
        } else {
          newPage();
        }
      }
      currentY += paraHeight;
      // Footnote space reservation
      reserveFootnoteSpace(para);
      return;
    }

    // widowControl: never leave a single line behind on this page — keep at
    // least two, or move the whole paragraph.
    // orphanControl: never push a single last line onto the next page — ensure
    // at least two lines land there.
    if (props?.widowControl !== false && lineCount > 1) {
      let spaceBefore = 0;
      if (spacing?.beforeAutoSpacing) {
        spaceBefore = AUTO_SPACING_TWIPS;
      } else if (spacing?.before != null) {
        spaceBefore = spacing.before;
      }

      const remainingSpace = availableHeight - currentY;
      const linesOnCurrentPage = Math.floor(Math.max(0, remainingSpace - spaceBefore) / lineHeight);

      // Widow: only 1 line fits on current page → move whole paragraph
      if (linesOnCurrentPage === 1 && lineCount > 1) {
        if (currentY > 0) {
          if (columnCount > 1 && currentColumn < columnCount - 1) {
            nextColumn();
          } else {
            newPage();
          }
        }
      }
      // Orphan: only 1 line would be on next page → keep one more line with it
      else if (linesOnCurrentPage > 0 && linesOnCurrentPage === lineCount - 1) {
        // Move one line from current page to keep 2 lines on next page
        // Effectively: move (lineCount - linesOnCurrentPage + 1) lines to next page
        // → keep (linesOnCurrentPage - 1) lines on current page
        if (linesOnCurrentPage > 2) {
          // Can safely split: leave (lines - 2) on current page, 2 on next
          // Do nothing special — just let it split naturally, but ensure at least 2 on next
          // The simplest approach: move whole paragraph if splitting would leave orphan
          if (currentY > 0) {
            if (columnCount > 1 && currentColumn < columnCount - 1) {
              nextColumn();
            } else {
              newPage();
            }
          }
        }
      }
    }

    // keepNext: this paragraph must stay on the same page as the next one.
    if (props?.keepNext && index + 1 < bodyContent.length) {
      const nextItem = bodyContent[index + 1];
      if (nextItem.type === "paragraph") {
        const nextHeight = estimateParagraphHeight(
          nextItem,
          effectiveWidth,
          defaultFontSize,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn,
          measureTextMetricsFn
        );
        // If the pair does not fit on this page, move this paragraph down.
        if (currentY + paraHeight + nextHeight > availableHeight && currentY > 0) {
          if (columnCount > 1 && currentColumn < columnCount - 1) {
            nextColumn();
          } else {
            newPage();
          }
        }
      }
    }

    // Ordinary placement.
    addContent(paraHeight);

    // Footnote space reservation
    reserveFootnoteSpace(para);
  }

  /**
   * Reserve space at the bottom of the page for footnotes.
   * Each footnote reference in a paragraph adds to the page's footnote area.
   */
  function reserveFootnoteSpace(para: Paragraph): void {
    const fnCount = countFootnoteRefs(para.children);
    if (fnCount > 0) {
      // Add footnote separator once per page (tracked implicitly by adding space)
      const fnSpace = FOOTNOTE_SEPARATOR_HEIGHT + fnCount * FOOTNOTE_ENTRY_HEIGHT;
      // Reduce available height for this page
      // We implement this by advancing currentY (simplification)
      currentY += fnSpace;
      // If this pushes us past the page, let normal pagination handle it
      if (currentY > availableHeight) {
        newPage();
      }
    }
  }
}

// =============================================================================
// Section Properties Lookup Helpers
// =============================================================================

/**
 * Find the first section's SectionProperties in the body.
 *
 * Every section except the last carries its properties in the pPr/sectPr of its
 * last paragraph. The properties that apply to the region before the first
 * paragraph bearing sectionProperties are therefore that very first sectPr, so
 * that is what this returns.
 */
function findFirstSectionProps(body: readonly BodyContent[]): SectionProperties | undefined {
  for (const item of body) {
    if (item.type === "paragraph" && item.properties?.sectionProperties) {
      return item.properties.sectionProperties;
    }
  }
  return undefined;
}

/**
 * Find the next section's SectionProperties starting at a given index.
 * Returns the sectionProperties of the first paragraph in `body[startIndex..]`
 * that carries them.
 */
function findNextSectionProps(
  body: readonly BodyContent[],
  startIndex: number
): SectionProperties | undefined {
  for (let i = startIndex; i < body.length; i++) {
    const item = body[i];
    if (item.type === "paragraph" && item.properties?.sectionProperties) {
      return item.properties.sectionProperties;
    }
  }
  return undefined;
}
