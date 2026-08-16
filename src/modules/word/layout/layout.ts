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

import { isHyperlink, isRun } from "@word/core/text-utils";
import {
  DEFAULT_PAGE_HEIGHT_TWIPS,
  DEFAULT_PAGE_MARGIN_TWIPS,
  DEFAULT_PAGE_WIDTH_TWIPS
} from "@word/layout/layout-constants";
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
  SectionBreakType,
  SectionColumns,
  SectionProperties,
  Table
} from "@word/types";

// =============================================================================
// Public API Types
// =============================================================================

/** 分页结果：每个 body content 的页面位置 */
export interface LayoutResult {
  /** 总页数 */
  readonly pageCount: number;
  /** 每一节的页数 */
  readonly sectionPageCounts: readonly number[];
  /** 每个 body content 项的页码（1-based） */
  readonly contentPages: readonly number[];
  /** 每个 body content 项的所在节（0-based） */
  readonly contentSections: readonly number[];
  /** 书签名 → 页码 的映射 */
  readonly bookmarkPages: ReadonlyMap<string, number>;
}

/** 布局选项 */
export interface LayoutOptions {
  /** 默认字号（半磅），默认 24 (= 12pt) */
  readonly defaultFontSize?: number;
  /** 默认每行字符数估算（用于行高计算），默认 80 */
  readonly defaultCharsPerLine?: number;
  /** 平均字符宽度（twips），默认基于 12pt 字体 */
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
}

// =============================================================================
// Internal Constants
// =============================================================================

/** 默认字号 (半磅): 24 = 12pt */
const DEFAULT_FONT_SIZE_HALF_PT = 24;
/** 默认每行字符数 */
const DEFAULT_CHARS_PER_LINE = 80;
/** auto spacing (段前/段后自动间距)，约 100 twips ≈ 5pt */
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

/** 从 SectionProperties 计算可用内容高度 (twips) */
function computeAvailableHeight(sp: SectionProperties | undefined): number {
  const height = sp?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;
  const marginTop = sp?.margins?.top ?? DEFAULT_PAGE_MARGIN_TWIPS;
  const marginBottom = sp?.margins?.bottom ?? DEFAULT_PAGE_MARGIN_TWIPS;

  // 可用高度 = 页面高度 - 上边距 - 下边距
  // Word 中 header/footer 区域位于 margin 内部，不额外占用正文空间。
  // 简化模型：不考虑 header/footer 溢出正文区域的情况。
  return Math.max(0, height - marginTop - marginBottom);
}

/** 从 SectionProperties 计算可用内容宽度 (twips) */
function computeAvailableWidth(sp: SectionProperties | undefined): number {
  const width = sp?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
  const marginLeft = sp?.margins?.left ?? DEFAULT_PAGE_MARGIN_TWIPS;
  const marginRight = sp?.margins?.right ?? DEFAULT_PAGE_MARGIN_TWIPS;
  const gutter = sp?.margins?.gutter ?? 0;
  return Math.max(0, width - marginLeft - marginRight - gutter);
}

/**
 * 根据字号计算单行行高 (twips)。
 * 标准排版: 行高 ≈ 字号 × 1.2
 * halfPt 24 (12pt) → 行高 14.4pt = 288 twips
 */
function baseLineHeight(fontSizeHalfPt: number): number {
  const ptSize = fontSizeHalfPt / 2;
  return Math.round(ptSize * 1.2 * 20); // pt → twips: ×20
}

/**
 * 根据 LineSpacing 配置计算实际行高 (twips)。
 * - auto: value 以 240ths 为单位 (240=单倍, 360=1.5倍, 480=双倍)
 * - exact: value 即为 twips
 * - atLeast: value 为最小值 (twips)，取 max(value, baseLine)
 */
function computeLineHeight(spacing: LineSpacing | undefined, fontSizeHalfPt: number): number {
  const baseLine = baseLineHeight(fontSizeHalfPt);

  if (!spacing?.line) {
    return baseLine;
  }

  const rule = spacing.lineRule ?? "auto";
  switch (rule) {
    case "auto": {
      // spacing.line 以 240ths of a line 为单位
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

/** 提取段落的有效字号 (半磅) */
function getParagraphFontSize(
  props: ParagraphProperties | undefined,
  defaultFontSize: number
): number {
  // 段落标记的 run properties 可以指示字号
  return props?.markRunProperties?.size ?? defaultFontSize;
}

/** 从 Run 的 font 属性中提取字体名 */
function getRunFontName(run: Run): string {
  const font = run.properties?.font;
  if (!font) {
    return "Calibri";
  }
  if (typeof font === "string") {
    return font;
  }
  return (font as FontSpec).ascii ?? (font as FontSpec).hAnsi ?? "Calibri";
}

/** 提取 Run 中的纯文本内容 */
function getRunText(run: Run): string {
  let text = "";
  for (const item of run.content) {
    switch (item.type) {
      case "text":
        text += item.text;
        break;
      case "tab":
        text += "    "; // tab 约等于 4 个字符
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
 * Check if a character is CJK (full-width) — takes approximately 2x the width of Latin chars.
 * Covers CJK Unified Ideographs, Katakana, Hiragana, Hangul, fullwidth forms, etc.
 */
function isCjkChar(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK Radicals, Kangxi, Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
    (code >= 0x20000 && code <= 0x2fa1f) // CJK Extension B-F, Compatibility Supplement
  );
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
 * 使用 measureText 回调计算段落总文本宽度 (points)。
 * 对每个 Run 根据其字体和字号分别测量，然后求和。
 */
function measureParagraphTextWidth(
  children: readonly ParagraphChild[],
  defaultFontSize: number,
  measureFn: (text: string, fontName: string, fontSize: number) => number
): number {
  let totalWidth = 0;
  for (const child of children) {
    if (isRun(child)) {
      const text = getRunText(child);
      if (text.length > 0) {
        const fontName = getRunFontName(child);
        const fontSize = (child.properties?.size ?? defaultFontSize) / 2; // half-pt → pt
        totalWidth += measureFn(text, fontName, fontSize);
      }
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        const text = getRunText(run);
        if (text.length > 0) {
          const fontName = getRunFontName(run);
          const fontSize = (run.properties?.size ?? defaultFontSize) / 2;
          totalWidth += measureFn(text, fontName, fontSize);
        }
      }
    }
  }
  return totalWidth;
}

/** 获取段落中 run 的最大字号 */
function getMaxRunFontSize(children: readonly ParagraphChild[], defaultFontSize: number): number {
  let maxSize = 0;
  for (const child of children) {
    if (isRun(child)) {
      const size = child.properties?.size ?? defaultFontSize;
      if (size > maxSize) {
        maxSize = size;
      }
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        const size = run.properties?.size ?? defaultFontSize;
        if (size > maxSize) {
          maxSize = size;
        }
      }
    }
  }
  return maxSize || defaultFontSize;
}

/** 检查段落 run content 中是否有 page break */
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

/** 检查段落 run content 中是否有 column break */
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
 * 估算段落高度 (twips)。
 *
 * 高度 = spaceBefore + (行数 × 行高) + spaceAfter
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
  measureTextFn?: (text: string, fontName: string, fontSize: number) => number
): number {
  const props = para.properties;
  const spacing = props?.spacing;

  // 段前间距
  let spaceBefore = 0;
  if (spacing?.beforeAutoSpacing) {
    spaceBefore = AUTO_SPACING_TWIPS;
  } else if (spacing?.before != null) {
    spaceBefore = spacing.before;
  }

  // 段后间距
  let spaceAfter = 0;
  if (spacing?.afterAutoSpacing) {
    spaceAfter = AUTO_SPACING_TWIPS;
  } else if (spacing?.after != null) {
    spaceAfter = spacing.after;
  }

  // 确定段落字号
  const fontSize = getMaxRunFontSize(para.children, getParagraphFontSize(props, defaultFontSize));

  // 计算行高
  const lineHeight = computeLineHeight(spacing, fontSize);

  // Check if inline images increase the effective line height
  const imgMaxHeight = getInlineImageMaxHeight(para.children);
  const effectiveLineHeight = Math.max(lineHeight, imgMaxHeight);

  // 计算行数
  let lineCount: number;
  if (measureTextFn) {
    // 精确测量：考虑首行/后续行不同宽度
    const [firstLineW, subsequentW] = computeParagraphLineWidths(props, availableWidth);
    const textWidthPt = measureParagraphTextWidth(para.children, defaultFontSize, measureTextFn);
    const textWidthTwips = textWidthPt * 20; // 1pt = 20 twips

    // Count hard line breaks in the paragraph
    const breakCount = countBreakElements(para.children);

    if (breakCount > 0) {
      // If there are hard breaks, use word-based line counting for accuracy
      const charWidth = averageCharWidth > 0 ? averageCharWidth : 120;
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
    const charWidth = averageCharWidth > 0 ? averageCharWidth : 120;

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

/** 估算表格单行高度 (twips)，考虑单元格内容 */
function estimateRowHeight(
  table: Table,
  rowIndex: number,
  defaultFontSize: number,
  availableWidth: number,
  defaultCharsPerLine: number,
  averageCharWidth: number,
  measureTextFn?: (text: string, fontName: string, fontSize: number) => number
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
  const colWidths = table.columnWidths;

  let maxCellHeight = 0;
  for (let c = 0; c < colCount; c++) {
    const cell = row.cells[c];
    // Estimate cell width from column widths or divide equally
    let cellWidth: number;
    if (colWidths && c < colWidths.length) {
      const gridSpan = cell.properties?.gridSpan ?? 1;
      cellWidth = 0;
      for (let g = 0; g < gridSpan && c + g < colWidths.length; g++) {
        cellWidth += colWidths[c + g];
      }
    } else {
      cellWidth = Math.floor(availableWidth / Math.max(1, colCount));
    }

    // Subtract cell margins (default ~108 twips each side in Word)
    const cellMarginLeft = 108;
    const cellMarginRight = 108;
    const cellContentWidth = Math.max(1, cellWidth - cellMarginLeft - cellMarginRight);

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
          measureTextFn
        );
      } else if (content.type === "table") {
        cellHeight += estimateTableHeight(
          content,
          defaultFontSize,
          cellContentWidth,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn
        );
      }
    }

    // Add cell top/bottom padding (default ~40 twips each)
    cellHeight += 80;

    if (cellHeight > maxCellHeight) {
      maxCellHeight = cellHeight;
    }
  }

  // Respect "atLeast" height constraint
  if (row.properties?.height?.value) {
    return Math.max(row.properties.height.value, maxCellHeight);
  }

  // Minimum height: at least one line
  const minHeight = baseLineHeight(defaultFontSize) + 80;
  return Math.max(minHeight, maxCellHeight);
}

/** 估算表格总高度 (twips) */
function estimateTableHeight(
  table: Table,
  defaultFontSize: number,
  availableWidth: number,
  defaultCharsPerLine: number,
  averageCharWidth: number,
  measureTextFn?: (text: string, fontName: string, fontSize: number) => number
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
      measureTextFn
    );
  }
  return total;
}

/** EMU → twips 转换 (1 inch = 914400 EMU = 1440 twips) */
function emuToTwips(emu: number): number {
  return Math.round(emu / 635);
}

/** 计算浮动图片在文档流中占用的高度 (twips)。
 *  - "topAndBottom" 包裹模式：图片占据垂直空间
 *  - 其他浮动模式：不占用正文流空间
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

/** 计算 DrawingShape 在文档流中占用的高度 (twips)。 */
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

/** 计算可用列宽（考虑多栏布局） */
function computeColumnWidth(availableWidth: number, columns: SectionColumns | undefined): number {
  if (!columns) {
    return availableWidth;
  }
  const count = columns.count ?? 1;
  if (count <= 1) {
    return availableWidth;
  }
  const space = columns.space ?? 720; // 默认 0.5 inch 间距
  // 总宽度 = count * colWidth + (count - 1) * space
  // colWidth = (totalWidth - (count - 1) * space) / count
  return Math.max(1, Math.floor((availableWidth - (count - 1) * space) / count));
}

/** 收集段落中的书签 */
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
 * 对文档进行分页布局计算。
 * 返回每个 body content 所在的页码和总页数。
 */
export function layoutDocument(doc: DocxDocument, options?: LayoutOptions): LayoutResult {
  const defaultFontSize = options?.defaultFontSize ?? DEFAULT_FONT_SIZE_HALF_PT;
  const defaultCharsPerLine = options?.defaultCharsPerLine ?? DEFAULT_CHARS_PER_LINE;
  // 平均字符宽度 (twips): 12pt 字体约 6pt 宽 = 120 twips
  const averageCharWidth =
    options?.averageCharWidth ?? Math.round((defaultFontSize / 2) * 0.5 * 20);
  const measureTextFn = options?.measureText;

  const body = doc.body;
  const contentPages: number[] = [];
  const contentSections: number[] = [];
  const bookmarkPages = new Map<string, number>();
  const sectionPageCounts: number[] = [];

  // 布局状态
  let currentPage = 1; // 1-based 页码
  let currentSection = 0; // 0-based 节号
  let sectionStartPage = 1; // 当前节起始页码
  let currentY = 0; // 当前页面 Y 偏移 (twips from top of content area)

  // 多栏状态
  let currentColumn = 0; // 当前列（0-based）
  let columnCount = 1; // 当前节的列数

  // 当前节的页面属性（从最后一个 section properties 开始）
  // 文档结构：每个节的 SectionProperties 出现在该节最后一个段落的属性中，
  // 而文档最终节的属性在 doc.sectionProperties 中
  let currentSectionProps = findFirstSectionProps(body) ?? doc.sectionProperties;
  let availableHeight = computeAvailableHeight(currentSectionProps);
  let availableWidth = computeAvailableWidth(currentSectionProps);
  // 实际可用列宽（考虑多栏）
  let effectiveWidth = computeColumnWidth(availableWidth, currentSectionProps?.columns);

  /** 更新列数和有效宽度 */
  function updateColumnLayout(): void {
    columnCount = currentSectionProps?.columns?.count ?? 1;
    if (columnCount < 1) {
      columnCount = 1;
    }
    effectiveWidth = computeColumnWidth(availableWidth, currentSectionProps?.columns);
  }

  // 初始化多栏
  updateColumnLayout();

  /** 开始新页 */
  function newPage(): void {
    currentPage++;
    currentY = 0;
    currentColumn = 0;
  }

  /** 进入下一列（多栏布局），如果已在最后一列则换页 */
  function nextColumn(): void {
    if (columnCount > 1 && currentColumn < columnCount - 1) {
      currentColumn++;
      currentY = 0;
    } else {
      newPage();
    }
  }

  /** 开始新节 */
  function newSection(
    breakType: SectionBreakType,
    nextSectionProps: SectionProperties | undefined
  ): void {
    // 记录当前节的页数
    sectionPageCounts.push(currentPage - sectionStartPage + 1);

    currentSection++;
    const nextProps = nextSectionProps ?? doc.sectionProperties;

    switch (breakType) {
      case "nextPage":
        newPage();
        break;
      case "evenPage": {
        // 跳到下一个偶数页
        newPage();
        if (currentPage % 2 !== 0) {
          newPage();
        }
        break;
      }
      case "oddPage": {
        // 跳到下一个奇数页
        newPage();
        if (currentPage % 2 !== 1) {
          newPage();
        }
        break;
      }
      case "continuous": {
        // 如果页面设置（尺寸）改变，则需要分页
        const currentWidth = currentSectionProps?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
        const currentHeight = currentSectionProps?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;
        const nextWidth = nextProps?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
        const nextHeight = nextProps?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;

        if (currentWidth !== nextWidth || currentHeight !== nextHeight) {
          newPage();
        }
        // 否则继续在当前位置
        break;
      }
      case "nextColumn":
        // 多栏布局下进入下一列
        nextColumn();
        break;
    }

    sectionStartPage = currentPage;
    currentSectionProps = nextProps;
    availableHeight = computeAvailableHeight(currentSectionProps);
    availableWidth = computeAvailableWidth(currentSectionProps);
    updateColumnLayout();
  }

  /** 尝试在当前页添加内容，如果放不下则分页 */
  function addContent(height: number): void {
    if (currentY + height > availableHeight && currentY > 0) {
      // 当前页/列放不下，移到下一页/列
      if (columnCount > 1 && currentColumn < columnCount - 1) {
        nextColumn();
      } else {
        newPage();
      }
    }
    currentY += height;
  }

  /** 表格跨页布局：逐行分配，处理 cantSplit 和 header 行重复 */
  function layoutTable(table: Table): void {
    const totalHeight = estimateTableHeight(
      table,
      defaultFontSize,
      effectiveWidth,
      defaultCharsPerLine,
      averageCharWidth,
      measureTextFn
    );

    // 快速路径：如果表格整体能放入当前页剩余空间，直接放入
    if (currentY + totalHeight <= availableHeight) {
      currentY += totalHeight;
      return;
    }

    // 如果当前页完全空且表格仍放不下，则需要跨页处理
    // 如果当前页非空且放不下第一行，先换页
    const firstRowHeight = estimateRowHeight(
      table,
      0,
      defaultFontSize,
      effectiveWidth,
      defaultCharsPerLine,
      averageCharWidth,
      measureTextFn
    );
    if (currentY > 0 && currentY + firstRowHeight > availableHeight) {
      if (columnCount > 1 && currentColumn < columnCount - 1) {
        nextColumn();
      } else {
        newPage();
      }
    }

    // 确定 header 行（tableHeader = true 的行在每页重复）
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
          measureTextFn
        );
      } else {
        break; // header 行必须从第一行开始连续
      }
    }

    // 逐行布局
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      const rowHeight = estimateRowHeight(
        table,
        r,
        defaultFontSize,
        effectiveWidth,
        defaultCharsPerLine,
        averageCharWidth,
        measureTextFn
      );

      // header 行在新页开头已经由 headerHeight 预留
      if (headerRows.includes(r)) {
        // header 行直接放入
        currentY += rowHeight;
        continue;
      }

      // cantSplit: 该行不能被分页拆分 — 如果放不下，必须整行移到下一页
      const cantSplit = row.properties?.cantSplit ?? false;

      if (cantSplit || rowHeight <= availableHeight) {
        // 检查当前页是否还能放下这一行
        if (currentY + rowHeight > availableHeight) {
          // 需要换页/换列
          if (columnCount > 1 && currentColumn < columnCount - 1) {
            nextColumn();
          } else {
            newPage();
          }
          // 新页顶部先放 header 行
          currentY += headerHeight;
        }
      } else {
        // 行高超过整个页面高度（极端情况），只能直接放
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
  // 遍历 body content
  // =========================================================================

  for (let i = 0; i < body.length; i++) {
    const item = body[i];

    switch (item.type) {
      case "paragraph": {
        const para = item;
        const props = para.properties;

        // 收集书签
        collectBookmarks(para.children, currentPage, bookmarkPages);

        // 检查段落 sectionProperties（节内分节符）
        // 注意：带 sectionProperties 的段落是其所属节的最后一个段落
        // sectionProperties 定义了当前节的页面设置
        if (props?.sectionProperties) {
          // 先渲染该段落本身
          const paraHeight = estimateParagraphHeight(
            para,
            effectiveWidth,
            defaultFontSize,
            defaultCharsPerLine,
            averageCharWidth,
            measureTextFn
          );
          handleParagraphLayout(para, paraHeight, i, body);
          contentPages.push(currentPage);
          contentSections.push(currentSection);

          // 然后开始新节
          const nextSP = findNextSectionProps(body, i + 1) ?? doc.sectionProperties;
          newSection(props.sectionProperties.breakType ?? "nextPage", nextSP);
          break;
        }

        // pageBreakBefore: 强制在段落前分页
        if (props?.pageBreakBefore && currentY > 0) {
          newPage();
        }

        // 检查 run 中是否有 page break
        if (hasPageBreakInRuns(para.children) && currentY > 0) {
          newPage();
        }

        // column break: 多栏布局下进入下一列
        if (hasColumnBreakInRuns(para.children) && currentY > 0) {
          nextColumn();
        }

        const paraHeight = estimateParagraphHeight(
          para,
          effectiveWidth,
          defaultFontSize,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn
        );

        handleParagraphLayout(para, paraHeight, i, body);

        contentPages.push(currentPage);
        contentSections.push(currentSection);
        break;
      }

      case "table": {
        const tableStartPage = currentPage;
        layoutTable(item);
        contentPages.push(tableStartPage);
        contentSections.push(currentSection);
        break;
      }

      default: {
        // FloatingImage, TableOfContents, MathBlock, TextBox, CheckBox,
        // DrawingShape, OpaqueDrawing, ChartContent, AltChunk, SDT
        const minHeight = baseLineHeight(defaultFontSize);
        if (item.type === "tableOfContents") {
          // TOC 通常有多个段落
          const tocParas = (item as { cachedParagraphs?: readonly Paragraph[] }).cachedParagraphs;
          const tocHeight = tocParas
            ? tocParas.length * baseLineHeight(defaultFontSize)
            : minHeight * 5;
          addContent(tocHeight);
        } else if (item.type === "floatingImage") {
          // 根据 wrap style 判断是否占用正文流空间
          const imgHeight = estimateFloatingImageHeight(item as FloatingImage);
          if (imgHeight > 0) {
            addContent(imgHeight);
          }
          // 其他浮动模式不占用正文流空间
        } else if (item.type === "drawingShape") {
          // 根据 wrap style 和尺寸计算占用高度
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
        break;
      }
    }
  }

  // 记录最后一个节的页数
  sectionPageCounts.push(currentPage - sectionStartPage + 1);

  return {
    pageCount: currentPage,
    sectionPageCounts,
    contentPages,
    contentSections,
    bookmarkPages
  };

  // =========================================================================
  // 段落布局辅助（处理 keepNext, keepLines, widowControl, orphanControl）
  // =========================================================================

  function handleParagraphLayout(
    para: Paragraph,
    paraHeight: number,
    index: number,
    bodyContent: readonly BodyContent[]
  ): void {
    const props = para.properties;
    const spacing = props?.spacing;
    const fontSize = getMaxRunFontSize(para.children, getParagraphFontSize(props, defaultFontSize));
    const lineHeight = computeLineHeight(spacing, fontSize);

    // 计算段落行数（CJK-aware）
    let lineCount: number;
    if (measureTextFn) {
      const [firstLineW, subsequentW] = computeParagraphLineWidths(props, effectiveWidth);
      const textWidthPt = measureParagraphTextWidth(para.children, defaultFontSize, measureTextFn);
      const textWidthTwips = textWidthPt * 20;

      // Count hard line breaks in the paragraph
      const breakCount = countBreakElements(para.children);

      if (breakCount > 0) {
        // If there are hard breaks, use word-based line counting for accuracy
        const charWidth = averageCharWidth > 0 ? averageCharWidth : 120;
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
      const charWidth = averageCharWidth > 0 ? averageCharWidth : 120;
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

    // keepLines: 整段必须在同一页
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

    // widowControl: 避免只有 1 行在当前页（至少 2 行，或者整段移走）
    // orphanControl: 避免最后 1 行单独在下一页（确保至少 2 行在下一页）
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

    // keepNext: 当前段落需要和下一个段落在同一页
    if (props?.keepNext && index + 1 < bodyContent.length) {
      const nextItem = bodyContent[index + 1];
      if (nextItem.type === "paragraph") {
        const nextHeight = estimateParagraphHeight(
          nextItem,
          effectiveWidth,
          defaultFontSize,
          defaultCharsPerLine,
          averageCharWidth,
          measureTextFn
        );
        // 如果两个段落一起放不下当前页，把当前段移到下一页
        if (currentY + paraHeight + nextHeight > availableHeight && currentY > 0) {
          if (columnCount > 1 && currentColumn < columnCount - 1) {
            nextColumn();
          } else {
            newPage();
          }
        }
      }
    }

    // 普通添加
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
 * 在 body 中查找第一个节的 SectionProperties。
 * 文档中，每个节（除最后一节）的属性在该节最后一个段落的 pPr/sectPr 中。
 * 这里找第一个含 sectionProperties 的段落之前的区域所适用的属性。
 * 由于第一个节的属性就是第一个 sectPr（如果存在），我们返回它。
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
 * 从指定位置开始查找下一个节的 SectionProperties。
 * 返回 body[startIndex..] 中第一个包含 sectionProperties 的段落的 sectionProperties。
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
