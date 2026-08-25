/**
 * DOCX Module - Markdown to DOCX Converter
 *
 * Converts a GFM (GitHub Flavored Markdown) string into DOCX document body content.
 * Handles common Markdown elements: headings, paragraphs, bold, italic, strikethrough,
 * code, links, images, lists, tables, blockquotes, horizontal rules, and fenced code blocks.
 *
 * @example
 * ```ts
 * import { markdownToDocx } from "documonster/word/markdown";
 * import { Io } from "documonster/word";
 *
 * const doc = markdownToDocx("# Hello\n\nWorld **bold**");
 * const buffer = await Io.toBuffer(doc);
 * ```
 *
 * @stability experimental
 */

import { mapToStandardFont, measureTextWidth, styledFontVariant } from "@utils/font-metrics";
import { emuToPt, ptToTwips, twipsToPt } from "@utils/units";
import { sanitizeUrl } from "@word/core/internal-utils";
import { isRun } from "@word/core/text-utils";
import {
  DEFAULT_FONT_SIZE_HALF_PT,
  DEFAULT_PAGE_MARGIN_TWIPS,
  DEFAULT_PAGE_WIDTH_TWIPS
} from "@word/layout/layout-constants";
import type {
  AbstractNumbering,
  Alignment,
  BodyContent,
  DocDefaults,
  DocxDocument,
  Emu,
  FootnoteDef,
  Hyperlink,
  ImageDef,
  ImageMediaType,
  LevelSuffix,
  NumberingInstance,
  Paragraph,
  ParagraphChild,
  ParagraphProperties,
  Run,
  RunProperties,
  StyleDef,
  Table,
  TableCell,
  TableCellProperties,
  TableProperties,
  TableRow,
  TableWidth,
  Twips
} from "@word/types";

// =============================================================================
// Public API
// =============================================================================

/** Options for Markdown to DOCX conversion. */
export interface MarkdownImportOptions {
  /** Default font family for body text. */
  readonly defaultFont?: string;
  /** Default font size in half-points (default: 24 = 12pt). */
  readonly defaultFontSize?: number;
  /** Code font family (default: "Courier New"). */
  readonly codeFont?: string;
  /**
   * Code font size in half-points. Defaults to the body size, matching
   * `code { font-size: 1em }` in VS Code's Markdown preview stylesheet.
   */
  readonly codeFontSize?: number;
  /**
   * The measure the body will be laid out in, in twips.
   *
   * Table columns are sized against it and a fenced code block is fitted to it,
   * because both are decisions only the producer can make — a `w:tblGrid` and a
   * run size are what the DOCX carries, not an instruction to work them out
   * later. Defaults to the page `markdownToDocx` emits for: US Letter less two
   * one-inch margins.
   *
   * Splicing the body into a host document with a different measure should say
   * so here. Getting it wrong degrades rather than breaks: a table keeps its
   * proportions, since the layout rescales a `pct`-width table to whatever
   * measure it finds, and a code block is set a little small or wraps.
   */
  readonly contentWidth?: Twips;
  /**
   * What to do with a fenced code block whose longest line is wider than the
   * measure.
   *
   * `"shrink"` (the default) sets the block smaller until the line fits, down to
   * {@link MIN_CODE_FONT_SCALE} of the code font size. Column alignment is half
   * of what preformatted text means — an ASCII tree, a table of commands, a
   * comment column — and wrapping destroys it for the whole block, not just the
   * line that overflowed. The preview this converter targets never has to
   * choose, because `pre` there scrolls.
   *
   * `"wrap"` keeps the size and breaks the long lines instead.
   */
  readonly codeBlockFit?: "shrink" | "wrap";
  /** Custom image resolver — given a URL, return image data or undefined to skip. */
  readonly resolveImage?: (
    url: string,
    alt: string
  ) => MarkdownImageData | undefined | Promise<MarkdownImageData | undefined>;
}

/** Resolved image data for embedding. */
export interface MarkdownImageData {
  readonly data: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly width?: number; // EMU
  readonly height?: number; // EMU
  /**
   * Raster (PNG) fallback for vector images. Required by Word for `svg`
   * images so non-SVG-aware viewers have something to display. When the
   * media type is `svg` and this is omitted, the packager synthesizes a
   * transparent placeholder PNG automatically.
   */
  readonly fallbackData?: Uint8Array;
}

/**
 * Result of {@link markdownToDocxBody} — the parsed body content plus the
 * supporting document-level definitions it references.
 *
 * Lists, footnotes and images are *not* self-contained: a list paragraph
 * references a numbering id, a footnote reference run references a
 * `FootnoteDef`, and an inline image references an `ImageDef`. Splicing the
 * `body` alone into a host document that lacks these definitions yields
 * invalid OOXML. Merge the relevant arrays into the host document (or its
 * builder state) alongside the body.
 */
export interface MarkdownBodyResult {
  readonly body: BodyContent[];
  readonly abstractNumberings: AbstractNumbering[];
  readonly numberingInstances: NumberingInstance[];
  readonly footnotes: FootnoteDef[];
  readonly images: ImageDef[];
  /**
   * The style definitions the body refers to by name.
   *
   * The body's paragraphs carry `Heading1…6`, `Quote`, `CodeBlock` and
   * `ListParagraph` as *references*; every visual property — a heading's rule, a
   * quote's bar, a code block's frame and background, a list's tight spacing —
   * lives in these definitions. Splicing the body into a host document without
   * them leaves the text unstyled, so they are returned rather than left for the
   * caller to guess at.
   */
  readonly styles: StyleDef[];
  /**
   * Document defaults the body assumes: 11pt body text on a 1.57 line, and the
   * space below each paragraph. A host document with different defaults will
   * render the body at its own size and leading.
   */
  readonly docDefaults: DocDefaults;
}

/**
 * Convert a Markdown string into a complete DocxDocument.
 *
 * Supports the full GFM feature set including inline images (embedded via the
 * `resolveImage` callback) and footnotes (`[^id]` references with `[^id]: …`
 * definitions). Because image resolution and document packaging are inherently
 * asynchronous, this function is async.
 *
 * @param markdown - The GFM Markdown string.
 * @param options - Optional conversion settings.
 * @returns A Promise resolving to a DocxDocument ready to be packaged.
 */
export async function markdownToDocx(
  markdown: string,
  options?: MarkdownImportOptions
): Promise<DocxDocument> {
  const { body, state } = await markdownToDocxBodyInternal(markdown, options);
  return {
    body,
    docDefaults: defaultMarkdownDocDefaults(),
    styles: defaultMarkdownStyles(),
    abstractNumberings: state.abstractNumberings,
    numberingInstances: state.numberingInstances,
    ...(state.footnotes.length > 0 ? { footnotes: state.footnotes } : {}),
    ...(state.images.length > 0 ? { images: state.images } : {})
  };
}

/**
 * Convert a Markdown string into DOCX body content plus the supporting
 * document-level definitions it references.
 *
 * **Caveat — body content is not self-contained.** The returned `body` may
 * reference:
 *   - **Numbering** (`abstractNumberings` / `numberingInstances`) — used by
 *     bullet / numbered / task lists.
 *   - **Footnotes** (`footnotes`) — referenced by footnote-reference runs.
 *   - **Images** (`images`) — referenced by inline image runs.
 *   - **Styles** (`styles`) — `Heading1…6`, `Quote`, `CodeBlock` and
 *     `ListParagraph`, which carry all of the formatting the body only
 *     references by name.
 *   - **Document defaults** (`docDefaults`) — the body text size and leading the
 *     spacing was calculated against.
 *
 * Splice the relevant arrays into your host document alongside the body, or
 * use the higher-level {@link markdownToDocx} which returns a complete
 * `DocxDocument` with everything populated.
 *
 * @param markdown - The GFM Markdown string.
 * @param options - Optional conversion settings.
 * @returns A Promise resolving to the body and its supporting definitions.
 */
export async function markdownToDocxBody(
  markdown: string,
  options?: MarkdownImportOptions
): Promise<MarkdownBodyResult> {
  const { body, state } = await markdownToDocxBodyInternal(markdown, options);
  return {
    body,
    abstractNumberings: state.abstractNumberings,
    numberingInstances: state.numberingInstances,
    footnotes: state.footnotes,
    images: state.images,
    styles: defaultMarkdownStyles(),
    docDefaults: defaultMarkdownDocDefaults()
  };
}

/**
 * Internal implementation: converts markdown and returns both body and state.
 */
async function markdownToDocxBodyInternal(
  markdown: string,
  options?: MarkdownImportOptions
): Promise<{ body: BodyContent[]; state: ConversionState }> {
  const state = createState();
  const opts: Required<Pick<MarkdownImportOptions, "codeFont" | "codeFontSize">> &
    MarkdownImportOptions = {
    codeFont: "Courier New",
    codeFontSize: pxHalfPt(BODY_PX),
    ...options
  };

  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // First pass: extract footnote definitions (`[^id]: …`) so references can
  // resolve regardless of definition order, then parse the remaining blocks.
  const { lines: contentLines, definitions } = extractFootnoteDefinitions(lines);
  state.footnoteDefinitions = definitions;
  const blocks = parseMarkdownBlocks(contentLines, 0, contentLines.length);
  const body = await convertBlocks(blocks, opts, state);
  // Emit footnote definitions that were actually referenced, in reference order.
  await finalizeFootnotes(state, opts);
  return { body, state };
}

// =============================================================================
// AST Types (internal)
// =============================================================================

interface HeadingBlock {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  inlines: InlineNode[];
}

interface ParagraphBlock {
  type: "paragraph";
  inlines: InlineNode[];
}

interface BlockquoteBlock {
  type: "blockquote";
  children: Block[];
}

interface FencedCodeBlock {
  type: "fencedCode";
  language: string;
  code: string;
}

interface ThematicBreakBlock {
  type: "thematicBreak";
}

interface ListBlock {
  type: "list";
  ordered: boolean;
  start: number;
  items: ListItemBlock[];
}

interface ListItemBlock {
  type: "listItem";
  checked?: boolean; // for task lists
  children: Block[];
}

interface TableBlock {
  type: "table";
  headers: InlineNode[][];
  alignments: (Alignment | undefined)[];
  rows: InlineNode[][][];
}

interface HtmlBlock {
  type: "html";
  content: string;
}

type Block =
  | HeadingBlock
  | ParagraphBlock
  | BlockquoteBlock
  | FencedCodeBlock
  | ThematicBreakBlock
  | ListBlock
  | TableBlock
  | HtmlBlock;

// Inline AST
interface TextInline {
  type: "text";
  text: string;
}
interface BoldInline {
  type: "bold";
  children: InlineNode[];
}
interface ItalicInline {
  type: "italic";
  children: InlineNode[];
}
interface StrikethroughInline {
  type: "strikethrough";
  children: InlineNode[];
}
interface CodeInline {
  type: "code";
  text: string;
}
interface LinkInline {
  type: "link";
  url: string;
  title?: string;
  children: InlineNode[];
}
interface ImageInline {
  type: "image";
  url: string;
  alt: string;
  title?: string;
}
interface LineBreakInline {
  type: "lineBreak";
}
interface FootnoteRefInline {
  type: "footnoteRef";
  /** The markdown footnote label (e.g. "1" from `[^1]`). */
  label: string;
}

type InlineNode =
  | TextInline
  | BoldInline
  | ItalicInline
  | StrikethroughInline
  | CodeInline
  | LinkInline
  | ImageInline
  | LineBreakInline
  | FootnoteRefInline;

// =============================================================================
// Shared state for numbering (per-invocation)
// =============================================================================

interface ConversionState {
  abstractNumberings: AbstractNumbering[];
  numberingInstances: NumberingInstance[];
  nextNumId: number;
  bulletNumId: number | undefined;
  orderedNumId: number | undefined;
  /** Emitted footnote definitions, in first-reference order. */
  footnotes: FootnoteDef[];
  /** Embedded inline images. */
  images: ImageDef[];
  /** Footnote definition bodies keyed by markdown label (`[^label]: …`). */
  footnoteDefinitions: Map<string, string>;
  /** Maps a markdown footnote label to its assigned numeric footnote id. */
  footnoteIds: Map<string, number>;
  /** Footnote labels in first-reference order (drives definition emission). */
  footnoteOrder: string[];
  nextFootnoteId: number;
  nextImageId: number;
  nextDrawingId: number;
}

function createState(): ConversionState {
  return {
    abstractNumberings: [],
    numberingInstances: [],
    nextNumId: 1,
    bulletNumId: undefined,
    orderedNumId: undefined,
    footnotes: [],
    images: [],
    footnoteDefinitions: new Map(),
    footnoteIds: new Map(),
    footnoteOrder: [],
    nextFootnoteId: 1,
    nextImageId: 1,
    nextDrawingId: 1
  };
}

// =============================================================================
// Footnote definition extraction (first pass)
// =============================================================================

/**
 * Matches a footnote definition line: `[^label]: content`.
 * Continuation lines (indented under a definition) are folded in.
 */
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:\s?(.*)$/;

/**
 * Strip footnote definitions (`[^id]: …`) out of the line stream before block
 * parsing, returning the remaining content lines plus a label→text map. A
 * definition may span continuation lines that are indented by at least one
 * space; those are joined with a single space.
 */
function extractFootnoteDefinitions(lines: string[]): {
  lines: string[];
  definitions: Map<string, string>;
} {
  const definitions = new Map<string, string>();
  const contentLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    // Preserve fenced code blocks verbatim — a `[^id]:`-looking line inside a
    // code fence is code, not a footnote definition.
    const fenceMatch = lines[i].match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const closeRe = new RegExp(`^${fence[0]}{${fence.length},}$`);
      contentLines.push(lines[i]);
      i++;
      while (i < lines.length) {
        contentLines.push(lines[i]);
        const isClose = closeRe.test(lines[i].trim());
        i++;
        if (isClose) {
          break;
        }
      }
      continue;
    }

    const match = lines[i].match(FOOTNOTE_DEF_RE);
    if (match) {
      const label = match[1];
      const parts: string[] = [match[2]];
      i++;
      // Fold indented continuation lines into the definition.
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      definitions.set(label, parts.join(" ").trim());
      continue;
    }
    contentLines.push(lines[i]);
    i++;
  }
  return { lines: contentLines, definitions };
}

/**
 * After conversion, emit a `FootnoteDef` for every footnote that was actually
 * referenced, in reference order. References to undefined labels still get a
 * footnote (with empty content) so the reference mark remains valid OOXML.
 */
function finalizeFootnotes(state: ConversionState, opts: ConvertOpts): Promise<void> {
  return (async () => {
    for (const label of state.footnoteOrder) {
      const id = state.footnoteIds.get(label);
      if (id === undefined) {
        continue;
      }
      const text = state.footnoteDefinitions.get(label) ?? "";
      const inlines = parseInlines(text);
      const para = await convertParagraph(inlines, opts, state, { style: "FootnoteText" });
      state.footnotes.push({ id, content: [para] });
    }
  })();
}

/**
 * Resolve (or assign) the numeric footnote id for a markdown label, recording
 * reference order on first use.
 */
function resolveFootnoteId(label: string, state: ConversionState): number {
  const existing = state.footnoteIds.get(label);
  if (existing !== undefined) {
    return existing;
  }
  const id = state.nextFootnoteId++;
  state.footnoteIds.set(label, id);
  state.footnoteOrder.push(label);
  return id;
}

// =============================================================================
// Block Parser
// =============================================================================

function parseMarkdownBlocks(lines: string[], start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i];

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block (``` or ~~~)
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const language = fenceMatch[2].trim();
      const codeLines: string[] = [];
      i++;
      while (i < end) {
        const trimmed = lines[i].trim();
        // CommonMark: closing fence must use same char and be at least as long
        if (
          trimmed.length >= fence.length &&
          new RegExp(`^${fence[0]}{${fence.length},}$`).test(trimmed)
        ) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "fencedCode", language, code: codeLines.join("\n") });
      continue;
    }

    // ATX Heading (# to ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const inlines = parseInlines(headingMatch[2].trim());
      blocks.push({ type: "heading", level, inlines });
      i++;
      continue;
    }

    // Setext heading (underline with === or ---)
    if (i + 1 < end) {
      const nextLine = lines[i + 1];
      if (/^={3,}\s*$/.test(nextLine)) {
        blocks.push({ type: "heading", level: 1, inlines: parseInlines(line.trim()) });
        i += 2;
        continue;
      }
      if (/^-{3,}\s*$/.test(nextLine) && !/^\s*[-*]\s/.test(line)) {
        blocks.push({ type: "heading", level: 2, inlines: parseInlines(line.trim()) });
        i += 2;
        continue;
      }
    }

    // Thematic break (---, ***, ___)
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "thematicBreak" });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (
        i < end &&
        (lines[i].startsWith(">") || (lines[i].trim() !== "" && !isBlockStart(lines[i])))
      ) {
        if (lines[i].startsWith(">")) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
        } else {
          quoteLines.push(lines[i]);
        }
        i++;
      }
      const children = parseMarkdownBlocks(quoteLines, 0, quoteLines.length);
      blocks.push({ type: "blockquote", children });
      continue;
    }

    // Unordered list
    if (/^(\s*)([-*+])\s/.test(line)) {
      const result = parseList(lines, i, end, false);
      blocks.push(result.block);
      i = result.nextIndex;
      continue;
    }

    // Ordered list
    if (/^(\s*)(\d+)[.)]\s/.test(line)) {
      const result = parseList(lines, i, end, true);
      blocks.push(result.block);
      i = result.nextIndex;
      continue;
    }

    // GFM Table
    if (i + 1 < end && isTableRow(line) && isTableSeparator(lines[i + 1])) {
      const result = parseTable(lines, i, end);
      blocks.push(result.block);
      i = result.nextIndex;
      continue;
    }

    // HTML block (raw HTML starting with <)
    if (/^<[a-zA-Z]/.test(line) && !line.startsWith("<a ") && !line.startsWith("<img ")) {
      const htmlLines: string[] = [];
      while (i < end && lines[i].trim() !== "") {
        htmlLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "html", content: htmlLines.join("\n") });
      continue;
    }

    // Paragraph (default) — collect consecutive non-blank, non-block-start lines.
    // Additionally treat the start of a GFM table (a row immediately followed
    // by a separator row) as a block boundary even without a blank line in
    // between, matching the behavior of CommonMark/GFM parsers.
    const paraLines: string[] = [];
    while (i < end && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      if (i + 1 < end && isTableRow(lines[i]) && isTableSeparator(lines[i + 1])) {
        break;
      }
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const text = paraLines.join("\n");
      blocks.push({ type: "paragraph", inlines: parseInlines(text) });
    }
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  if (/^#{1,6}\s/.test(line)) {
    return true;
  }
  if (/^(`{3,}|~{3,})/.test(line)) {
    return true;
  }
  if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
    return true;
  }
  if (line.startsWith(">")) {
    return true;
  }
  if (/^(\s*)([-*+])\s/.test(line)) {
    return true;
  }
  if (/^(\s*)(\d+)[.)]\s/.test(line)) {
    return true;
  }
  if (/^<[a-zA-Z]/.test(line) && !line.startsWith("<a ") && !line.startsWith("<img ")) {
    return true;
  }
  return false;
}

// =============================================================================
// List Parser
// =============================================================================

function parseList(
  lines: string[],
  start: number,
  end: number,
  ordered: boolean
): { block: ListBlock; nextIndex: number } {
  const items: ListItemBlock[] = [];
  let i = start;
  const startNum = ordered ? parseInt(lines[i].match(/^(\s*)(\d+)/)?.[2] ?? "1", 10) : 1;

  // Determine the marker pattern for this list
  const baseIndent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;

  while (i < end) {
    const line = lines[i];
    const itemMatch = ordered
      ? line.match(/^(\s*)(\d+)[.)]\s(.*)$/)
      : line.match(/^(\s*)([-*+])\s(.*)$/);

    if (!itemMatch) {
      break;
    }

    const indent = itemMatch[1].length;
    if (indent > baseIndent + 1) {
      break;
    } // Sub-list item belongs to parent

    const firstLine = itemMatch[3];
    i++;

    // Collect continuation lines (indented more than marker)
    const itemLines: string[] = [firstLine];
    const contIndent = indent + (ordered ? itemMatch[2].length + 2 : 2);

    while (i < end) {
      const nextLine = lines[i];
      if (nextLine.trim() === "") {
        // Check if next non-blank line continues this item
        if (i + 1 < end && lines[i + 1].startsWith(" ".repeat(contIndent))) {
          itemLines.push("");
          i++;
        } else {
          break;
        }
      } else if (nextLine.startsWith(" ".repeat(contIndent))) {
        itemLines.push(nextLine.slice(contIndent));
        i++;
      } else {
        break;
      }
    }

    // Check for task list checkbox
    let checked: boolean | undefined;
    if (itemLines[0].startsWith("[x] ") || itemLines[0].startsWith("[X] ")) {
      checked = true;
      itemLines[0] = itemLines[0].slice(4);
    } else if (itemLines[0].startsWith("[ ] ")) {
      checked = false;
      itemLines[0] = itemLines[0].slice(4);
    }

    // Parse item content — could contain sub-blocks
    const children = parseMarkdownBlocks(itemLines, 0, itemLines.length);
    // If no blocks were created but we have text, wrap in paragraph
    if (children.length === 0 && firstLine.trim()) {
      children.push({ type: "paragraph", inlines: parseInlines(firstLine) });
    }
    items.push({ type: "listItem", checked, children });
  }

  return {
    block: { type: "list", ordered, start: startNum, items },
    nextIndex: i
  };
}

// =============================================================================
// Table Parser
// =============================================================================

function isTableRow(line: string): boolean {
  return line.includes("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function parseTableCells(line: string): string[] {
  // Remove leading/trailing pipe
  let s = line.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|")) {
    s = s.slice(0, -1);
  }

  // Split by unescaped pipe
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      current += s[i + 1];
      i++;
    } else if (s[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += s[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignments(line: string): (Alignment | undefined)[] {
  const cells = parseTableCells(line);
  return cells.map(cell => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) {
      return "center" as Alignment;
    }
    if (right) {
      return "end" as Alignment;
    }
    if (left) {
      return "start" as Alignment;
    }
    return undefined;
  });
}

function parseTable(
  lines: string[],
  start: number,
  end: number
): { block: TableBlock; nextIndex: number } {
  const headerCells = parseTableCells(lines[start]);
  const alignments = parseTableAlignments(lines[start + 1]);
  const rows: InlineNode[][][] = [];

  let i = start + 2;
  while (i < end && isTableRow(lines[i]) && lines[i].trim() !== "") {
    const cells = parseTableCells(lines[i]);
    rows.push(cells.map(c => parseInlines(c)));
    i++;
  }

  return {
    block: {
      type: "table",
      headers: headerCells.map(c => parseInlines(c)),
      alignments,
      rows
    },
    nextIndex: i
  };
}

// =============================================================================
// Inline Parser
// =============================================================================

function parseInlines(text: string): InlineNode[] {
  // Emphasis is resolved in a second pass over this list, so a delimiter run is
  // recorded here rather than matched here — see `processEmphasis`.
  const sentinel: EmphasisItem = {};
  let tail = sentinel;
  const append = (item: EmphasisItem): void => {
    item.prev = tail;
    tail.next = item;
    tail = item;
  };
  const appendNode = (node: InlineNode): void => append({ node });
  let i = 0;

  while (i < text.length) {
    // Escaped character
    if (text[i] === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1])) {
      appendNode({ type: "text", text: text[i + 1] });
      i += 2;
      continue;
    }

    // Line break (two trailing spaces + newline, or backslash + newline)
    if (text[i] === "\n") {
      // Check for hard break (two spaces before \n)
      const lastNode = tail.node;
      if (lastNode && lastNode.type === "text" && lastNode.text.endsWith("  ")) {
        lastNode.text = lastNode.text.slice(0, -2);
        appendNode({ type: "lineBreak" });
      } else if (i > 0 && text[i - 1] === "\\") {
        // Backslash line break
        if (lastNode && lastNode.type === "text") {
          lastNode.text = lastNode.text.slice(0, -1);
        }
        appendNode({ type: "lineBreak" });
      } else {
        // Soft line break → space
        appendNode({ type: "text", text: " " });
      }
      i++;
      continue;
    }

    // Inline code (backtick)
    if (text[i] === "`") {
      const result = parseInlineCode(text, i);
      if (result) {
        appendNode(result.node);
        i = result.end;
        continue;
      }
    }

    // Image ![alt](url "title")
    if (text[i] === "!" && text[i + 1] === "[") {
      const result = parseImage(text, i);
      if (result) {
        appendNode(result.node);
        i = result.end;
        continue;
      }
    }

    // Footnote reference [^label]
    if (text[i] === "[" && text[i + 1] === "^") {
      const result = parseFootnoteRef(text, i);
      if (result) {
        appendNode(result.node);
        i = result.end;
        continue;
      }
    }

    // Link [text](url "title")
    if (text[i] === "[") {
      const result = parseLink(text, i);
      if (result) {
        appendNode(result.node);
        i = result.end;
        continue;
      }
    }

    // Autolink <url>
    if (text[i] === "<") {
      const result = parseAutolink(text, i);
      if (result) {
        appendNode(result.node);
        i = result.end;
        continue;
      }
    }

    // A run of `*` or `_`. Whether it opens emphasis, closes it or stays literal
    // is not decidable here — it depends on the runs that follow.
    if (text[i] === "*" || text[i] === "_") {
      const ch = text[i];
      const run = delimiterRun(text, i, ch);
      const count = run.end - run.start;
      append({
        run: {
          ch,
          count,
          length: count,
          canOpen: delimiterCanOpen(text, run.start, run.end, ch),
          canClose: delimiterCanClose(text, run.start, run.end, ch)
        }
      });
      i = run.end;
      continue;
    }

    // Strikethrough ~~text~~
    if (text[i] === "~" && text[i + 1] === "~") {
      const result = parseStrikethrough(text, i);
      if (result) {
        appendNode(result.node);
        i = result.end;
        continue;
      }
    }

    // Plain text — accumulate until next special character
    let textEnd = i;
    while (textEnd < text.length && !isInlineSpecial(text, textEnd)) {
      textEnd++;
    }
    if (textEnd > i) {
      appendNode({ type: "text", text: text.slice(i, textEnd) });
      i = textEnd;
    } else {
      // Single special char that didn't match any pattern — treat as text
      appendNode({ type: "text", text: text[i] });
      i++;
    }
  }

  return mergeTextNodes(processEmphasis(sentinel));
}

function isInlineSpecial(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === "\\" || ch === "`" || ch === "[" || ch === "!" || ch === "<" || ch === "\n") {
    return true;
  }
  if (ch === "*" || ch === "_") {
    return true;
  }
  if (ch === "~" && text[i + 1] === "~") {
    return true;
  }
  return false;
}

function mergeTextNodes(nodes: InlineNode[]): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of nodes) {
    const prev = result[result.length - 1];
    if (node.type === "text" && prev && prev.type === "text") {
      (prev as { text: string }).text += node.text;
    } else {
      result.push(node);
    }
  }
  return result;
}

function parseInlineCode(text: string, start: number): { node: CodeInline; end: number } | null {
  // Count opening backticks
  let ticks = 0;
  let i = start;
  while (i < text.length && text[i] === "`") {
    ticks++;
    i++;
  }

  // Find matching closing backticks
  const closePattern = "`".repeat(ticks);
  const closeIdx = text.indexOf(closePattern, i);
  if (closeIdx < 0) {
    return null;
  }

  // Verify it's exactly the right number of backticks
  const afterClose = closeIdx + ticks;
  if (afterClose < text.length && text[afterClose] === "`") {
    return null;
  }

  let code = text.slice(i, closeIdx);
  // Strip one leading and one trailing space if both exist (GFM rule)
  if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ")) {
    code = code.slice(1, -1);
  }

  return { node: { type: "code", text: code }, end: afterClose };
}

function parseFootnoteRef(
  text: string,
  start: number
): { node: FootnoteRefInline; end: number } | null {
  // [^label] — label may not contain ']' or whitespace.
  const match = text.slice(start).match(/^\[\^([^\]\s]+)\]/);
  if (!match) {
    return null;
  }
  return {
    node: { type: "footnoteRef", label: match[1] },
    end: start + match[0].length
  };
}

function parseImage(text: string, start: number): { node: ImageInline; end: number } | null {
  // ![alt](url "title")
  const altStart = start + 2; // skip "!["
  const altEnd = findClosingBracket(text, altStart - 1);
  if (altEnd < 0) {
    return null;
  }

  const alt = text.slice(altStart, altEnd);

  if (text[altEnd + 1] !== "(") {
    return null;
  }
  const urlResult = parseLinkDest(text, altEnd + 2);
  if (!urlResult) {
    return null;
  }

  return {
    node: { type: "image", url: urlResult.url, alt, title: urlResult.title },
    end: urlResult.end
  };
}

function parseLink(text: string, start: number): { node: LinkInline; end: number } | null {
  const textEnd = findClosingBracket(text, start);
  if (textEnd < 0) {
    return null;
  }

  const linkText = text.slice(start + 1, textEnd);

  if (text[textEnd + 1] !== "(") {
    return null;
  }
  const urlResult = parseLinkDest(text, textEnd + 2);
  if (!urlResult) {
    return null;
  }

  return {
    node: {
      type: "link",
      url: urlResult.url,
      title: urlResult.title,
      children: parseInlines(linkText)
    },
    end: urlResult.end
  };
}

function parseAutolink(text: string, start: number): { node: LinkInline; end: number } | null {
  const closeIdx = text.indexOf(">", start + 1);
  if (closeIdx < 0) {
    return null;
  }

  const content = text.slice(start + 1, closeIdx);
  // Must be a URL (https?://) or email
  if (/^https?:\/\//.test(content) || /^[^@]+@[^@]+\.[^@]+$/.test(content)) {
    const url = content.includes("@") && !content.includes("://") ? `mailto:${content}` : content;
    return {
      node: {
        type: "link",
        url,
        children: [{ type: "text", text: content }]
      },
      end: closeIdx + 1
    };
  }
  return null;
}

function parseLinkDest(
  text: string,
  start: number
): { url: string; title?: string; end: number } | null {
  let i = start;
  // Skip whitespace
  while (i < text.length && text[i] === " ") {
    i++;
  }

  if (i >= text.length) {
    return null;
  }

  // Parse URL (possibly in angle brackets)
  let url: string;
  if (text[i] === "<") {
    const closeAngle = text.indexOf(">", i + 1);
    if (closeAngle < 0) {
      return null;
    }
    url = text.slice(i + 1, closeAngle);
    i = closeAngle + 1;
  } else {
    const urlStart = i;
    let parens = 0;
    while (i < text.length && text[i] !== " " && text[i] !== "\t") {
      const ch = text[i];
      if (ch === "(") {
        parens++;
      } else if (ch === ")") {
        if (parens === 0) {
          break;
        }
        parens--;
      }
      i++;
    }
    url = text.slice(urlStart, i);
  }

  // Skip whitespace
  while (i < text.length && (text[i] === " " || text[i] === "\t")) {
    i++;
  }

  // Parse optional title
  let title: string | undefined;
  if (i < text.length && (text[i] === '"' || text[i] === "'")) {
    const quote = text[i];
    const titleStart = i + 1;
    const titleEnd = text.indexOf(quote, titleStart);
    if (titleEnd >= 0) {
      title = text.slice(titleStart, titleEnd);
      i = titleEnd + 1;
    }
  }

  // Skip whitespace and expect ")"
  while (i < text.length && text[i] === " ") {
    i++;
  }
  if (text[i] !== ")") {
    return null;
  }

  return { url, title, end: i + 1 };
}

function findClosingBracket(text: string, start: number): number {
  // start points to "[", find matching "]"
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i++; // skip escaped char
      continue;
    }
    if (text[i] === "[") {
      depth++;
    }
    if (text[i] === "]") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Unicode whitespace, per CommonMark's definition — with the start and end of
 * the text counting as whitespace, which is what makes a delimiter at either
 * edge flanking.
 */
function isMarkdownWhitespace(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    /[\t\n\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(ch)
  );
}

/**
 * Punctuation, per CommonMark: an ASCII punctuation character, or anything in
 * the Unicode general categories `Pc Pd Pe Pf Pi Po Ps`. Symbol categories are
 * deliberately excluded, so an arrow is not punctuation.
 */
function isMarkdownPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && (/[!-/:-@[-`{-~]/.test(ch) || /\p{P}/u.test(ch));
}

/**
 * The extent of the delimiter run of `ch` that covers `index`.
 *
 * Flanking is a property of the whole run, not of the one, two or three
 * characters a caller happens to be matching: in `processed__,` the run is both
 * underscores, and testing only the first would read the second as the character
 * that follows it.
 */
function delimiterRun(text: string, index: number, ch: string): { start: number; end: number } {
  let start = index;
  while (start > 0 && text[start - 1] === ch) {
    start--;
  }
  let end = index;
  while (end < text.length && text[end] === ch) {
    end++;
  }
  return { start, end };
}

/**
 * Whether a delimiter run can open, or close, emphasis.
 *
 * CommonMark 0.30 §6.2. A run is *left-flanking* when it is not followed by
 * whitespace and either is not followed by punctuation or is preceded by
 * whitespace or punctuation; *right-flanking* is the mirror image. `*` may open
 * when left-flanking and close when right-flanking; `_` carries the extra rule
 * that keeps it out of the middle of a word, and that rule was only ever applied
 * to a *single* underscore here. So `processed__, registration__` — where
 * neither run can open, both being preceded by a letter and followed by
 * punctuation — came out as bold text with the underscores eaten, where GitHub
 * renders all four of them literally.
 */
function delimiterCanOpen(text: string, start: number, end: number, ch: string): boolean {
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  const left = isLeftFlanking(before, after);
  if (ch !== "_") {
    return left;
  }
  return left && (!isRightFlanking(before, after) || isMarkdownPunctuation(before));
}

function delimiterCanClose(text: string, start: number, end: number, ch: string): boolean {
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  const right = isRightFlanking(before, after);
  if (ch !== "_") {
    return right;
  }
  return right && (!isLeftFlanking(before, after) || isMarkdownPunctuation(after));
}

function isLeftFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isMarkdownWhitespace(after)) {
    return false;
  }
  return (
    !isMarkdownPunctuation(after) || isMarkdownWhitespace(before) || isMarkdownPunctuation(before)
  );
}

function isRightFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isMarkdownWhitespace(before)) {
    return false;
  }
  return (
    !isMarkdownPunctuation(before) || isMarkdownWhitespace(after) || isMarkdownPunctuation(after)
  );
}

/**
 * An entry in the inline list emphasis is resolved over: either a finished
 * inline node, or a run of `*` / `_` whose role is not yet decided.
 *
 * A doubly linked list rather than an array because the algorithm below splices
 * a matched pair's content out of the middle repeatedly, and walks backwards from
 * a closer to find its opener.
 */
interface EmphasisItem {
  /** A completed inline node. Mutually exclusive with `run`. */
  node?: InlineNode;
  /** An unmatched delimiter run. */
  run?: {
    readonly ch: string;
    /** Characters not yet consumed by a match; what is left is literal text. */
    count: number;
    /** The run's length as written — the "rule of 3" is stated in those terms. */
    readonly length: number;
    readonly canOpen: boolean;
    readonly canClose: boolean;
  };
  prev?: EmphasisItem;
  next?: EmphasisItem;
}

/**
 * Resolve emphasis over a flat list of inline items.
 *
 * This is CommonMark 0.30 §6.2's *process emphasis* procedure, delimiter stack
 * and all. The parser used to scan forward from an opener for a closing
 * delimiter and recurse on what lay between, which cannot express the cases the
 * spec is careful about, and cannot be patched into doing so:
 *
 * - `*(**foo**)*` closed the outer run on the *first* `*` of the inner one and
 *   produced `<em>(**foo</em>*)*`.
 * - `**foo*` came out as `<em>*foo</em>` instead of `*<em>foo</em>`, because the
 *   opener's length was decided before its partner was known.
 * - `*foo**bar**baz*` split into three sibling emphases instead of one
 *   containing a strong.
 *
 * Working *backwards from each closer* is what gets those right: a closer takes
 * the nearest opener, one to two characters are consumed from each end, and
 * whatever is left of either run stays on the stack for the next round — which
 * is how `***foo***` becomes an `<em>` wrapping a `<strong>` in two passes over
 * the same pair.
 */
function processEmphasis(sentinel: EmphasisItem): InlineNode[] {
  /**
   * How far back a failed search already went, keyed by the closer's delimiter,
   * its length mod 3 and whether it could also open. Without it a run of
   * unmatchable delimiters rescans the whole list for each one.
   */
  const openersBottom = new Map<string, EmphasisItem | undefined>();

  const isStackedCloser = (item: EmphasisItem): boolean =>
    item.run !== undefined && item.run.count > 0 && item.run.canClose;

  const nextCloser = (from: EmphasisItem | undefined): EmphasisItem | undefined => {
    let item = from;
    while (item !== undefined && !isStackedCloser(item)) {
      item = item.next;
    }
    return item;
  };

  const unlink = (item: EmphasisItem): void => {
    if (item.prev !== undefined) {
      item.prev.next = item.next;
    }
    if (item.next !== undefined) {
      item.next.prev = item.prev;
    }
  };

  let closer = nextCloser(sentinel.next);
  while (closer !== undefined) {
    const closerRun = closer.run!;
    const key = `${closerRun.ch}${closerRun.length % 3}${closerRun.canOpen ? "o" : ""}`;
    const bottom = openersBottom.get(key);

    let opener: EmphasisItem | undefined;
    for (let candidate = closer.prev; candidate !== undefined; candidate = candidate.prev) {
      if (candidate === bottom || candidate === sentinel) {
        break;
      }
      const run = candidate.run;
      if (run === undefined || run.count === 0 || run.ch !== closerRun.ch || !run.canOpen) {
        continue;
      }
      // The "rule of 3": when either run could serve as both ends, a pair whose
      // original lengths sum to a multiple of three is rejected — unless both
      // lengths are themselves multiples of three. It is what keeps
      // `*foo**bar**baz*` from pairing the `*` with the first `**`.
      const sumIsMultipleOfThree = (run.length + closerRun.length) % 3 === 0;
      const bothMultiplesOfThree = run.length % 3 === 0 && closerRun.length % 3 === 0;
      if ((closerRun.canOpen || run.canClose) && sumIsMultipleOfThree && !bothMultiplesOfThree) {
        continue;
      }
      opener = candidate;
      break;
    }

    if (opener === undefined) {
      openersBottom.set(key, closer.prev);
      const skipped = closer;
      closer = nextCloser(closer.next);
      // A run that cannot open either will never match anything, so it leaves
      // the stack and stays as the literal text it already carries.
      if (!skipped.run!.canOpen) {
        skipped.node = { type: "text", text: skipped.run!.ch.repeat(skipped.run!.count) };
        skipped.run = undefined;
      }
      continue;
    }

    const openerRun = opener.run!;
    // Two delimiters make strong emphasis, one makes emphasis; a longer run is
    // consumed two at a time across successive rounds.
    const used = openerRun.count >= 2 && closerRun.count >= 2 ? 2 : 1;

    // Everything between the pair becomes the content. Delimiters still
    // unmatched in there had their chance and are literal text.
    const children: InlineNode[] = [];
    for (let item = opener.next; item !== undefined && item !== closer; item = item.next) {
      if (item.node !== undefined) {
        children.push(item.node);
      } else if (item.run !== undefined && item.run.count > 0) {
        children.push({ type: "text", text: item.run.ch.repeat(item.run.count) });
      }
    }
    const wrapper: EmphasisItem = {
      node: used === 2 ? { type: "bold", children } : { type: "italic", children },
      prev: opener,
      next: closer
    };
    opener.next = wrapper;
    closer.prev = wrapper;

    openerRun.count -= used;
    closerRun.count -= used;
    if (openerRun.count === 0) {
      unlink(opener);
    }
    if (closerRun.count === 0) {
      const following = closer.next;
      unlink(closer);
      closer = nextCloser(following);
    }
    // Otherwise the same closer goes round again against what is left of the
    // opener — `***foo***` is one pair matched twice.
  }

  const out: InlineNode[] = [];
  for (let item = sentinel.next; item !== undefined; item = item.next) {
    if (item.node !== undefined) {
      out.push(item.node);
    } else if (item.run !== undefined && item.run.count > 0) {
      out.push({ type: "text", text: item.run.ch.repeat(item.run.count) });
    }
  }
  return out;
}

function parseStrikethrough(
  text: string,
  start: number
): { node: StrikethroughInline; end: number } | null {
  const closeIdx = text.indexOf("~~", start + 2);
  if (closeIdx < 0) {
    return null;
  }
  const inner = text.slice(start + 2, closeIdx);
  if (inner.trim() === "") {
    return null;
  }
  return {
    node: { type: "strikethrough", children: parseInlines(inner) },
    end: closeIdx + 2
  };
}

// =============================================================================
// AST to DOCX Conversion
// =============================================================================

type ConvertOpts = Required<Pick<MarkdownImportOptions, "codeFont" | "codeFontSize">> &
  MarkdownImportOptions;

async function convertBlocks(
  blocks: Block[],
  opts: ConvertOpts,
  state: ConversionState
): Promise<BodyContent[]> {
  const result: BodyContent[] = [];
  for (const block of blocks) {
    const converted = await convertBlock(block, opts, 0, state);
    result.push(...converted);
  }
  return result;
}

async function convertBlock(
  block: Block,
  opts: ConvertOpts,
  listLevel: number,
  state: ConversionState
): Promise<BodyContent[]> {
  switch (block.type) {
    case "heading":
      return [await convertHeading(block, opts, state)];
    case "paragraph":
      return [await convertParagraph(block.inlines, opts, state)];
    case "blockquote":
      return convertBlockquote(block, opts, state);
    case "fencedCode":
      return [convertFencedCode(block, opts)];
    case "thematicBreak":
      return [convertThematicBreak()];
    case "list":
      return convertList(block, opts, listLevel, state);
    case "table":
      return [await convertTable(block, opts, state)];
    case "html":
      // Pass through as plain text paragraph
      return [
        makeParagraph([makeRun(block.content, { font: opts.codeFont, size: opts.codeFontSize })], {
          style: "CodeBlock"
        })
      ];
    default:
      return [];
  }
}

async function convertHeading(
  block: HeadingBlock,
  opts: ConvertOpts,
  state: ConversionState
): Promise<Paragraph> {
  const children = await inlinesToRuns(block.inlines, opts, state, true);
  return {
    type: "paragraph",
    properties: {
      style: `Heading${block.level}`,
      outlineLevel: (block.level - 1) as 0 | 1 | 2 | 3 | 4 | 5
    },
    children
  };
}

async function convertParagraph(
  inlines: InlineNode[],
  opts: ConvertOpts,
  state: ConversionState,
  props?: ParagraphProperties
): Promise<Paragraph> {
  const children = await inlinesToRuns(inlines, opts, state, false);
  return {
    type: "paragraph",
    properties: props,
    children
  };
}

async function convertBlockquote(
  block: BlockquoteBlock,
  opts: ConvertOpts,
  state: ConversionState
): Promise<BodyContent[]> {
  // Convert blockquote children with "Quote" style and left indent
  const result: BodyContent[] = [];
  for (const child of block.children) {
    const converted = await convertBlock(child, opts, 0, state);
    for (const item of converted) {
      if (item.type === "paragraph") {
        // Geometry and the bar live in the `Quote` style (see
        // `defaultMarkdownStyles`), so the paragraph only names it — but only
        // when it has no style of its own. A fenced code block or a heading
        // inside a quote keeps its own style; overwriting it stripped the code
        // block's frame, background and leading, and flattened headings to body
        // text.
        result.push(
          item.properties?.style
            ? item
            : { ...item, properties: { ...item.properties, style: "Quote" } }
        );
      } else {
        result.push(item);
      }
    }
  }
  return result;
}

function convertFencedCode(block: FencedCodeBlock, opts: ConvertOpts): Paragraph {
  const lines = block.code.split("\n");
  const size = fitCodeFontSize(lines, opts);
  const runs: ParagraphChild[] = [];
  for (let i = 0; i < lines.length; i++) {
    runs.push(makeRun(lines[i], { font: opts.codeFont, size }));
    if (i < lines.length - 1) {
      runs.push(makeRun("", undefined, [{ type: "break" }]));
    }
  }
  return {
    type: "paragraph",
    // Padding, frame, background and line height all live in the `CodeBlock`
    // style (see `defaultMarkdownStyles`), so the paragraph only names it.
    properties: { style: "CodeBlock" },
    children: runs
  };
}

/**
 * How small a code block may be set, as a fraction of the code font size.
 *
 * At the 11pt default this floors at 6.5pt, which holds about 113 monospace
 * columns in a Letter measure — past the 80 of tradition and the 100–120 every
 * formatter in use defaults to, so in practice a block either fits or was never
 * meant for a page. It is a floor rather than an unbounded shrink because one
 * 400-character line should not be allowed to render the other twenty lines
 * unreadable; past it, wrapping is the honest answer.
 */
const MIN_CODE_FONT_SCALE = 0.6;

/**
 * The font size, in half-points, at which a code block's longest line fits.
 *
 * Sizing is **per block**, so a block that needs no shrinking gets none. The
 * alternative — one size for every block in the document — would let a single
 * pathological listing shrink all the others, which trades a real cost for a
 * consistency nothing else in the document has either (a heading is not the size
 * of a paragraph).
 *
 * Measurement is linear in the size, so the ratio of the measure to the widest
 * line gives the answer in one step. Both it and the floor round *down* to the
 * half-point `w:sz` can express: rounding either up would not fit, which is the
 * whole point.
 */
function fitCodeFontSize(lines: readonly string[], opts: ConvertOpts): number {
  const size = opts.codeFontSize;
  if (opts.codeBlockFit === "wrap") {
    return size;
  }
  // `CodeBlock` indents by `pre { padding: 16px }` on both sides.
  const available = twipsToPt(contentWidthTwips(opts) - 2 * pxTwips(16));
  if (available <= 0) {
    return size;
  }
  const font = styledFontVariant(mapToStandardFont(opts.codeFont));
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, measureTextWidth(line, font, size / 2));
  }
  if (widest <= available) {
    return size;
  }
  const fitted = Math.floor(size * (available / widest));
  return Math.max(1, Math.floor(size * MIN_CODE_FONT_SCALE), fitted);
}

function convertThematicBreak(): Paragraph {
  return {
    type: "paragraph",
    properties: {
      thematicBreak: true,
      // `hr { height: 1px; border-bottom: 1px solid }`.
      borders: {
        bottom: { style: "single", size: 8, color: COLORS.rule, space: 0 }
      },
      spacing: { before: pxTwips(16), after: pxTwips(16) }
    },
    children: []
  };
}

async function convertList(
  block: ListBlock,
  opts: ConvertOpts,
  parentLevel: number,
  state: ConversionState
): Promise<BodyContent[]> {
  // Ordered lists with a non-default `start` need their own numbering
  // instance so the override actually takes effect — sharing one numId
  // across all lists would force every list to start at the same number.
  const numId =
    block.ordered && block.start !== 1
      ? createOrderedNumberingWithStart(block.start, state)
      : getOrCreateNumbering(block.ordered, state);
  const result: BodyContent[] = [];

  for (const item of block.items) {
    let firstBlock = true;
    for (const child of item.children) {
      if (child.type === "list") {
        // Nested list — increase level
        const nested = await convertList(child, opts, parentLevel + 1, state);
        result.push(...nested);
      } else if (child.type === "paragraph") {
        if (firstBlock) {
          // First paragraph gets list numbering. `ListParagraph` is how Word
          // represents a list item, and its `contextualSpacing` is what keeps
          // consecutive items tight while still separating the list from the
          // body text around it.
          const props: ParagraphProperties = {
            style: "ListParagraph",
            numbering: { numId, level: parentLevel }
          };
          const para = await convertParagraph(child.inlines, opts, state, props);

          // Handle task list checkbox prefix
          if (item.checked !== undefined) {
            const checkbox = item.checked ? "☑ " : "☐ ";
            const existingChildren = [...para.children];
            const checkRun = makeRun(checkbox);
            result.push({
              ...para,
              children: [checkRun, ...existingChildren]
            });
          } else {
            result.push(para);
          }
          firstBlock = false;
        } else {
          // Continuation paragraphs — indented but no numbering
          const props: ParagraphProperties = {
            style: "ListParagraph",
            indent: { left: 720 * (parentLevel + 1) }
          };
          result.push(await convertParagraph(child.inlines, opts, state, props));
        }
      } else {
        const converted = await convertBlock(child, opts, parentLevel, state);
        result.push(...converted);
        firstBlock = false;
      }
    }
  }

  return result;
}

async function convertTable(
  block: TableBlock,
  opts: ConvertOpts,
  state: ConversionState
): Promise<Table> {
  const colCount = block.headers.length;

  // Header row
  const headerCells: TableCell[] = [];
  for (let ci = 0; ci < block.headers.length; ci++) {
    const cell = block.headers[ci];
    // `th { border-bottom: 1px solid <darker> }` — the header is marked by a
    // heavier rule and bold text, not by a fill. The sheet gives `th` no
    // background at all.
    const cellProps: TableCellProperties = {
      verticalAlign: "center",
      borders: { bottom: { style: "single", size: 8, color: COLORS.headerRule } }
    };
    const para = await convertParagraph(cell, opts, state, cellParagraphProps(block, ci));
    // Bold header text
    const boldPara: Paragraph = {
      ...para,
      children: para.children.map(child => {
        if (isRun(child)) {
          return { ...child, properties: { ...child.properties, bold: true } };
        }
        return child;
      })
    };
    headerCells.push({ properties: cellProps, content: [boldPara] });
  }

  // Data rows
  const dataRows: TableRow[] = [];
  for (const rowCells of block.rows) {
    const cells: TableCell[] = [];
    for (let ci = 0; ci < colCount; ci++) {
      const cellInlines = ci < rowCells.length ? rowCells[ci] : [];
      const para = await convertParagraph(cellInlines, opts, state, cellParagraphProps(block, ci));
      cells.push({ content: [para] });
    }
    dataRows.push({ cells });
  }

  const allRows: TableRow[] = [
    { properties: { tableHeader: true }, cells: headerCells },
    ...dataRows
  ];

  // `table { border-collapse: collapse }` with rules only *between* body rows
  // (`table > tbody > tr + tr > td { border-top: 1px solid }`). There is no
  // outer frame and no vertical rule — a grid is exactly what the preview
  // avoids, and it is most of why a Markdown table reads cleanly there.
  const borders: Required<TableProperties>["borders"] = {
    top: { style: "none" },
    bottom: { style: "none" },
    left: { style: "none" },
    right: { style: "none" },
    insideH: { style: "single", size: 8, color: COLORS.rule },
    insideV: { style: "none" }
  };

  const tableWidth: TableWidth = { type: "pct", value: 5000 }; // 100%

  const horizontalPadding = pxTwips(10);
  const tableProps: TableProperties = {
    width: tableWidth,
    borders,
    // `th, td { padding: 5px 10px }`.
    cellMargins: {
      top: { value: pxTwips(5), type: "dxa" },
      bottom: { value: pxTwips(5), type: "dxa" },
      left: { value: horizontalPadding, type: "dxa" },
      right: { value: horizontalPadding, type: "dxa" }
    },
    layout: "autofit"
  };

  return {
    type: "table",
    properties: tableProps,
    columnWidths: sizeTableColumns(allRows, colCount, horizontalPadding, contentWidthTwips(opts)),
    rows: allRows
  };
}

/**
 * Paragraph properties for a table cell.
 *
 * The zeroed `after` is the point. A cell in the preview holds inline content
 * directly — `<td>text</td>`, with no `<p>` wrapper — so it never picks up
 * `p { margin-bottom: 16px }`. Letting the cell paragraph inherit the document
 * default's `after` instead added 12.55pt of dead space inside every cell,
 * which made a one-line row 37.7pt tall against the 25.2pt the padding and
 * leading actually call for: a fifteen-row table spilled onto a second page and
 * every row looked like it had a blank line under it.
 *
 * `line` is deliberately left to inherit, so a cell leads at the body's 1.57.
 */
function cellParagraphProps(block: TableBlock, columnIndex: number): ParagraphProperties {
  return {
    alignment: block.alignments[columnIndex],
    spacing: { after: 0 }
  };
}

// =============================================================================
// Table Column Sizing
// =============================================================================

/**
 * The measure to size against when the caller names none: the US Letter page
 * `markdownToDocx` emits for, less its one-inch margins.
 */
const DEFAULT_CONTENT_WIDTH_TWIPS = DEFAULT_PAGE_WIDTH_TWIPS - 2 * DEFAULT_PAGE_MARGIN_TWIPS;

/** The measure this conversion sizes tables and code blocks against, in twips. */
function contentWidthTwips(opts: ConvertOpts): Twips {
  const declared = opts.contentWidth;
  return declared !== undefined && declared > 0 ? declared : DEFAULT_CONTENT_WIDTH_TWIPS;
}

/** A column's intrinsic widths, in twips, excluding cell padding. */
interface IntrinsicWidths {
  /** Widest run of non-whitespace — the narrowest the column can get. */
  min: number;
  /** All of the content on one line — the widest it can usefully get. */
  max: number;
}

/**
 * Size a Markdown table's columns from the width of what they hold.
 *
 * Without this the table carries no grid, and both the DOCX writer and the
 * layout fall back to dividing the measure equally — so a `Layer` / `Runtime`
 * column got the same 234pt as the prose beside it, wasting half the table
 * while the other column wrapped every row. Nothing downstream will do this
 * for us: `w:tblLayout w:type="autofit"` is advisory, Word renders the grid it
 * is given, and CSS `table-layout: auto` sizing is a decision the *producer*
 * has to make because only it knows the text.
 *
 * The distribution is CSS 2.1 §17.5.2.2's automatic layout, which is what the
 * Markdown preview this converter targets actually runs: columns get their
 * minimum, and the slack up to the measure is shared out in proportion to how
 * much each column could still use.
 */
function sizeTableColumns(
  rows: readonly TableRow[],
  colCount: number,
  horizontalPadding: number,
  measure: Twips
): Twips[] | undefined {
  if (colCount <= 0) {
    return undefined;
  }
  const padding = horizontalPadding * 2;
  const columns: IntrinsicWidths[] = Array.from({ length: colCount }, () => ({ min: 0, max: 0 }));
  for (const row of rows) {
    for (let ci = 0; ci < Math.min(row.cells.length, colCount); ci++) {
      const cell = measureCellIntrinsics(row.cells[ci]);
      const col = columns[ci];
      col.min = Math.max(col.min, cell.min);
      col.max = Math.max(col.max, cell.max);
    }
  }

  // Padding is per column and unavoidable, so it comes off the measure before
  // the content competes for what is left.
  const available = Math.max(colCount, measure - padding * colCount);
  const mins = columns.map(c => Math.min(c.min, available));
  const maxs = columns.map((c, i) => Math.max(c.max, mins[i]));
  const totalMin = sum(mins);
  const totalMax = sum(maxs);

  let content: number[];
  if (totalMax <= available) {
    // Everything fits on one line. The table is 100% wide, so the slack is
    // shared in proportion to how much each column holds.
    content =
      totalMax > 0
        ? maxs.map(w => (w / totalMax) * available)
        : maxs.map(() => available / colCount);
  } else if (totalMin < available) {
    // The usual case: start from the minimum and give each column a share of
    // the slack proportional to how much more it could use.
    const slack = available - totalMin;
    const growth = maxs.map((w, i) => w - mins[i]);
    const totalGrowth = sum(growth);
    content =
      totalGrowth > 0
        ? mins.map((w, i) => w + (growth[i] / totalGrowth) * slack)
        : mins.map(w => w + slack / colCount);
  } else {
    // Even the minima overflow — an unbreakable token wider than its share.
    // Scale them down together and let the line breaker break inside words,
    // which is what a browser does too.
    content =
      totalMin > 0
        ? mins.map(w => (w / totalMin) * available)
        : mins.map(() => available / colCount);
  }

  const widths = content.map(w => Math.max(1, Math.round(w + padding)));
  // Absorb the rounding residue into the widest column, so the grid sums to the
  // measure exactly and the table's right edge lands on the margin.
  const residue = measure - sum(widths);
  if (residue !== 0) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[widest]) {
        widest = i;
      }
    }
    widths[widest] = Math.max(1, widths[widest] + residue);
  }
  return widths;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

/**
 * Measure one cell's intrinsic widths.
 *
 * `min` is the widest run of non-whitespace, and it is tracked *across* run
 * boundaries on purpose: `` `sybase.ts`, `` is one unbreakable token even
 * though the code span and the comma are separate runs, and a column narrower
 * than that will be forced to break between them.
 */
function measureCellIntrinsics(cell: TableCell): IntrinsicWidths {
  let min = 0;
  let max = 0;
  for (const block of cell.content) {
    if (block.type !== "paragraph") {
      continue;
    }
    let lineWidth = 0;
    let token = 0;
    for (const segment of cellTextSegments(block.children)) {
      if (segment.type === "break") {
        max = Math.max(max, lineWidth);
        min = Math.max(min, token);
        lineWidth = 0;
        token = 0;
        continue;
      }
      if (segment.type === "atom") {
        lineWidth += segment.width;
        token += segment.width;
        continue;
      }
      for (const piece of segment.text.split(/(\s+)/)) {
        if (piece.length === 0) {
          continue;
        }
        const width = ptToTwips(measureTextWidth(piece, segment.font, segment.sizeHalfPt / 2));
        lineWidth += width;
        if (/^\s+$/.test(piece)) {
          min = Math.max(min, token);
          token = 0;
        } else {
          token += width;
        }
      }
    }
    max = Math.max(max, lineWidth);
    min = Math.max(min, token);
  }
  return { min, max };
}

/** A measurable piece of a cell: styled text, an inline atom, or a line break. */
type CellSegment =
  | {
      readonly type: "text";
      readonly text: string;
      readonly font: string;
      readonly sizeHalfPt: number;
    }
  | { readonly type: "atom"; readonly width: Twips }
  | { readonly type: "break" };

/** Flatten a cell paragraph's children into measurable segments. */
function* cellTextSegments(children: readonly ParagraphChild[]): Generator<CellSegment> {
  for (const child of children) {
    if ("type" in child && child.type === "hyperlink") {
      yield* cellTextSegments(child.children);
      continue;
    }
    if (!isRun(child)) {
      continue;
    }
    const props = child.properties;
    const family = typeof props?.font === "string" ? props.font : props?.font?.ascii;
    const font = styledFontVariant(
      mapToStandardFont(family ?? DEFAULT_CELL_FONT),
      props?.bold,
      props?.italic
    );
    const sizeHalfPt = props?.size ?? DEFAULT_FONT_SIZE_HALF_PT;
    for (const content of child.content) {
      switch (content.type) {
        case "text":
          yield { type: "text", text: content.text, font, sizeHalfPt };
          break;
        case "tab":
          yield { type: "text", text: " ", font, sizeHalfPt };
          break;
        case "break":
          yield { type: "break" };
          break;
        case "image":
          yield { type: "atom", width: ptToTwips(emuToPt(content.width)) };
          break;
        default:
          break;
      }
    }
  }
}

/** The family `docDefaults` gives a run that names none. */
const DEFAULT_CELL_FONT = "Calibri";

// =============================================================================
// Inline to Run Conversion
// =============================================================================

async function inlinesToRuns(
  inlines: InlineNode[],
  opts: ConvertOpts,
  state: ConversionState,
  isHeading: boolean
): Promise<ParagraphChild[]> {
  const result: ParagraphChild[] = [];
  for (const node of inlines) {
    await inlineToRuns(node, result, {}, opts, state, isHeading);
  }
  return result;
}

async function inlineToRuns(
  node: InlineNode,
  output: ParagraphChild[],
  inheritedProps: RunProperties,
  opts: ConvertOpts,
  state: ConversionState,
  isHeading: boolean
): Promise<void> {
  switch (node.type) {
    case "text": {
      // Headings derive their font/size from the named Heading style; only
      // body text picks up the document default font/size.
      const textProps: RunProperties = isHeading
        ? inheritedProps
        : {
            ...inheritedProps,
            ...(opts.defaultFont && !inheritedProps.font ? { font: opts.defaultFont } : {}),
            ...(opts.defaultFontSize && !inheritedProps.size ? { size: opts.defaultFontSize } : {})
          };
      output.push(makeRun(node.text, textProps));
      break;
    }

    case "bold":
      for (const child of node.children) {
        await inlineToRuns(
          child,
          output,
          { ...inheritedProps, bold: true },
          opts,
          state,
          isHeading
        );
      }
      break;

    case "italic":
      for (const child of node.children) {
        await inlineToRuns(
          child,
          output,
          { ...inheritedProps, italic: true },
          opts,
          state,
          isHeading
        );
      }
      break;

    case "strikethrough":
      for (const child of node.children) {
        await inlineToRuns(
          child,
          output,
          { ...inheritedProps, strike: true },
          opts,
          state,
          isHeading
        );
      }
      break;

    case "code":
      output.push(
        makeRun(node.text, {
          ...inheritedProps,
          font: opts.codeFont ?? "Courier New",
          // `code { font-size: 1em }` — inline code matches body size. The
          // stylesheet gives a background to `pre`, not to inline `code`.
          size: opts.codeFontSize ?? pxHalfPt(BODY_PX)
        })
      );
      break;

    case "link": {
      const linkChildren: Run[] = [];
      for (const child of node.children) {
        const tempOutput: ParagraphChild[] = [];
        await inlineToRuns(
          child,
          tempOutput,
          // `a { text-decoration: none }` — colour alone marks a link.
          { ...inheritedProps, color: COLORS.link },
          opts,
          state,
          isHeading
        );
        for (const run of tempOutput) {
          if ("content" in run) {
            linkChildren.push(run as Run);
          }
        }
      }
      const safeUrl = sanitizeUrl(node.url);
      const link: Hyperlink = {
        type: "hyperlink",
        url: safeUrl ?? "",
        tooltip: node.title,
        children: linkChildren
      };
      output.push(link);
      break;
    }

    case "image": {
      const run = await resolveImageRun(node, inheritedProps, opts, state);
      output.push(run);
      break;
    }

    case "footnoteRef": {
      const id = resolveFootnoteId(node.label, state);
      output.push({
        properties: { ...inheritedProps, style: "FootnoteReference" },
        content: [{ type: "footnoteRef", id }]
      });
      break;
    }

    case "lineBreak":
      output.push(makeRun("", undefined, [{ type: "break" }]));
      break;
  }
}

/**
 * Resolve an inline image. If `resolveImage` returns image data, embed it as a
 * real `InlineImageContent` run and register the media in `state.images`;
 * otherwise fall back to an italic `[Image: alt]` placeholder so the output
 * remains valid.
 */
async function resolveImageRun(
  node: ImageInline,
  inheritedProps: RunProperties,
  opts: ConvertOpts,
  state: ConversionState
): Promise<Run> {
  const data = opts.resolveImage ? await opts.resolveImage(node.url, node.alt) : undefined;
  if (!data) {
    return makeRun(`[Image: ${node.alt || node.url}]`, {
      ...inheritedProps,
      italic: true,
      color: "666666"
    });
  }

  const n = state.nextImageId++;
  const fileName = `image${n}.${imageExtension(data.mediaType)}`;
  const rId = `mdimg${n}`;
  // For SVG, the packager auto-splits the PNG fallback into its own media
  // part, assigns a second relationship, and back-fills `svgRId` on the inline
  // image — so we only ever push a single ImageDef and a single rId here.
  state.images.push({
    data: data.data,
    mediaType: data.mediaType,
    fileName,
    rId,
    ...(data.fallbackData ? { fallbackData: data.fallbackData } : {})
  });

  const DEFAULT_DIM = 914400 as Emu; // 1 inch fallback when no size given
  return {
    content: [
      {
        type: "image",
        rId,
        width: (data.width ?? DEFAULT_DIM) as Emu,
        height: (data.height ?? DEFAULT_DIM) as Emu,
        altText: node.alt || undefined,
        name: node.alt || fileName,
        drawingId: state.nextDrawingId++
      }
    ]
  };
}

/** Map an image media type to its word/media/ file extension. */
function imageExtension(mediaType: ImageMediaType): string {
  return mediaType === "jpeg" ? "jpg" : mediaType;
}

// =============================================================================
// Numbering Helpers
// =============================================================================

function getOrCreateNumbering(ordered: boolean, state: ConversionState): number {
  if (ordered && state.orderedNumId !== undefined) {
    return state.orderedNumId;
  }
  if (!ordered && state.bulletNumId !== undefined) {
    return state.bulletNumId;
  }

  const abstractNumId = state.nextNumId;
  const numId = state.nextNumId;
  state.nextNumId++;

  const levels = ordered
    ? [
        {
          level: 0,
          format: "decimal" as const,
          text: "%1.",
          start: 1,
          indent: { left: 720, hanging: 360 }
        },
        {
          level: 1,
          format: "lowerLetter" as const,
          text: "%2.",
          start: 1,
          indent: { left: 1440, hanging: 360 }
        },
        {
          level: 2,
          format: "lowerRoman" as const,
          text: "%3.",
          start: 1,
          indent: { left: 2160, hanging: 360 }
        },
        {
          level: 3,
          format: "decimal" as const,
          text: "%4.",
          start: 1,
          indent: { left: 2880, hanging: 360 }
        },
        {
          level: 4,
          format: "lowerLetter" as const,
          text: "%5.",
          start: 1,
          indent: { left: 3600, hanging: 360 }
        },
        {
          level: 5,
          format: "lowerRoman" as const,
          text: "%6.",
          start: 1,
          indent: { left: 4320, hanging: 360 }
        }
      ]
    : [
        {
          level: 0,
          format: "bullet" as const,
          text: "•",
          start: 1,
          indent: { left: 720, hanging: 360 }
        },
        {
          level: 1,
          format: "bullet" as const,
          text: "◦",
          start: 1,
          indent: { left: 1440, hanging: 360 }
        },
        {
          level: 2,
          format: "bullet" as const,
          text: "▪",
          start: 1,
          indent: { left: 2160, hanging: 360 }
        },
        {
          level: 3,
          format: "bullet" as const,
          text: "•",
          start: 1,
          indent: { left: 2880, hanging: 360 }
        },
        {
          level: 4,
          format: "bullet" as const,
          text: "◦",
          start: 1,
          indent: { left: 3600, hanging: 360 }
        },
        {
          level: 5,
          format: "bullet" as const,
          text: "▪",
          start: 1,
          indent: { left: 4320, hanging: 360 }
        }
      ];

  const tabSuffix: LevelSuffix = "tab";
  const abstractNumbering: AbstractNumbering = {
    abstractNumId,
    levels: levels.map(l => ({
      level: l.level,
      format: l.format,
      text: l.text,
      start: l.start,
      paragraphProperties: { indent: l.indent },
      suffix: tabSuffix
    }))
  };

  const numberingInstance: NumberingInstance = {
    numId,
    abstractNumId
  };

  state.abstractNumberings.push(abstractNumbering);
  state.numberingInstances.push(numberingInstance);

  if (ordered) {
    state.orderedNumId = numId;
  } else {
    state.bulletNumId = numId;
  }

  return numId;
}

/**
 * Create a fresh ordered numbering instance with a startOverride at level 0.
 * Re-uses the shared ordered abstract numbering (creating it on demand) so
 * we don't duplicate the level definitions for every numbered list that has
 * a non-default starting number.
 */
function createOrderedNumberingWithStart(start: number, state: ConversionState): number {
  // Ensure the shared ordered abstract numbering exists.
  const baseNumId = getOrCreateNumbering(true, state);
  const baseInstance = state.numberingInstances.find(n => n.numId === baseNumId);
  const abstractNumId = baseInstance?.abstractNumId ?? baseNumId;

  const numId = state.nextNumId;
  state.nextNumId++;

  state.numberingInstances.push({
    numId,
    abstractNumId,
    overrides: [{ level: 0, startOverride: start }]
  });

  return numId;
}

// =============================================================================
// Run Construction Helpers
// =============================================================================

function makeRun(
  text: string,
  properties?: RunProperties,
  extraContent?: Array<{ type: string }>
): Run {
  const content: Array<{ type: "text"; text: string } | { type: "break"; breakType?: string }> = [];

  if (extraContent) {
    for (const item of extraContent) {
      content.push(item as { type: "break" });
    }
  }

  if (text) {
    content.push({ type: "text", text });
  }

  const run: Run = { content: content as Run["content"] };
  if (properties && Object.keys(properties).length > 0) {
    return { ...run, properties };
  }
  return run;
}

function makeParagraph(children: ParagraphChild[], properties?: ParagraphProperties): Paragraph {
  return { type: "paragraph", properties, children };
}

// =============================================================================
// Default Styles
// =============================================================================

/**
 * Typographic defaults for rendered Markdown, ported from the stylesheet VS
 * Code's built-in Markdown preview uses
 * (`extensions/markdown-language-features/media/markdown.css`).
 *
 * That sheet is tuned for reading prose on screen at 14px with a 22px line, and
 * its proportions are what make the preview legible: a 1.57 line height, a
 * uniform 24px above / 16px below every heading, rules under h1 and h2, a bar
 * beside block quotes, and tables ruled horizontally only. The values below keep
 * those *ratios* but re-base the body text to 11pt, which is the size a printed
 * page wants — so `px * 11/14` converts a CSS length here.
 *
 * Two deliberate deviations from the sheet:
 *   - `h1 { margin-top: 0 }` assumes the h1 is a document title at the very top
 *     of a scrolling view. On a paginated page a mid-document h1 needs the same
 *     air as the others, so it keeps the 24px equivalent.
 *   - `font-weight: 600` has no equivalent in the PDF standard-14 faces, which
 *     offer regular and bold only; headings therefore render bold.
 */

/** CSS pixels → points, at the 14px → 11pt re-basing described above. */
const PX = 11 / 14;
/** CSS pixels → twips. */
const pxTwips = (px: number): number => Math.round(px * PX * 20);
/** CSS pixels → half-points (the unit `w:sz` uses). */
const pxHalfPt = (px: number): number => Math.round(px * PX * 2);
/**
 * A CSS `line-height` multiple → `w:spacing/@w:line` in 240ths.
 *
 * The engine derives a line's natural height as `fontSize * 1.2`, so a CSS
 * multiple has to be expressed relative to that rather than to the font size.
 */
const lineHeight = (multiple: number): number => Math.round((240 * multiple) / 1.2);

/** `--markdown-font-size: 14px` with `--markdown-line-height: 22px`. */
const BODY_PX = 14;
const BODY_LINE = 22 / BODY_PX;

/**
 * Light-theme colours, flattened against the surface each one is painted on.
 *
 * Two stylesheets are in play. `markdown.css` ships with the extension and sets
 * the `rgba(...)` rule colours below; the *webview host* (`pre/index.html`)
 * supplies the theme-variable colours — including the block quote's, which
 * `markdown.css` leaves entirely to it. Reading only the extension's sheet is
 * how the quote lost its blue bar and its tint once already.
 */
const COLORS = {
  /** `rgba(0, 0, 0, 0.18)` — h1/h2 rules, `hr`, and table row rules. */
  rule: "D1D1D1",
  /** `rgba(0, 0, 0, 0.69)` — the heavier rule under a table header. */
  headerRule: "4F4F4F",
  /** `textLink.foreground` — `#006AB1`. */
  link: "006AB1",
  /** `textCodeBlock.background` — `#dcdcdc66`, i.e. `#DCDCDC` at 40% on white. */
  codeBackground: "F1F1F1",
  /**
   * `textBlockQuote.background` — `#f2f2f2`, applied by the host's
   *
   *     blockquote { background: var(--vscode-textBlockQuote-background); }
   */
  quoteBackground: "F2F2F2",
  /**
   * `textBlockQuote.border` — `#007acc80`, half-transparent blue, from the
   * host's companion `border-color` rule.
   *
   * The bar paints over the quote's own background rather than the page, so it
   * flattens to `#007ACC` at 50% over `#F2F2F2` — not over white.
   */
  quoteBar: "79B6DF"
} as const;

/** Every heading: `margin: 24px 0 16px`, `line-height: 1.25`, semibold. */
const HEADING_SPACING = {
  before: pxTwips(24),
  after: pxTwips(16),
  line: lineHeight(1.25),
  lineRule: "auto" as const
};

function defaultMarkdownDocDefaults(): DocDefaults {
  return {
    // `html, body { font-size: 14px; line-height: 22px }` and
    // `p { margin-bottom: 16px }`.
    paragraphProperties: {
      spacing: { after: pxTwips(16), line: lineHeight(BODY_LINE), lineRule: "auto" }
    },
    runProperties: { size: pxHalfPt(BODY_PX), font: "Calibri" }
  };
}

/** A heading style: `font-size` in `em`, plus the shared heading spacing. */
function headingStyle(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  em: number,
  options?: { readonly rule?: boolean; readonly italic?: boolean }
) {
  const sizeHalfPt = pxHalfPt(BODY_PX * em);
  return {
    type: "paragraph" as const,
    styleId: `Heading${level}`,
    name: `heading ${level}`,
    basedOn: "Normal",
    next: "Normal",
    paragraphProperties: {
      spacing: HEADING_SPACING,
      outlineLevel: (level - 1) as 0 | 1 | 2 | 3 | 4 | 5,
      keepNext: true,
      // `h1`/`h2 { padding-bottom: 0.3em; border-bottom: 1px solid }` — the rule
      // that visually separates a section from what follows it.
      ...(options?.rule
        ? {
            borders: {
              bottom: {
                style: "single" as const,
                size: 4,
                color: COLORS.rule,
                space: Math.round(0.3 * em * BODY_PX * PX)
              }
            }
          }
        : {})
    },
    runProperties: {
      size: sizeHalfPt,
      bold: true,
      ...(options?.italic ? { italic: true } : {})
    }
  };
}

function defaultMarkdownStyles() {
  return [
    // Normal — the base every other style here points at via basedOn.
    // Without it, Word logs a "missing referenced style" warning when
    // opening the document.
    {
      type: "paragraph" as const,
      styleId: "Normal",
      name: "Normal",
      isDefault: true,
      qFormat: true
    },
    headingStyle(1, 2, { rule: true }),
    headingStyle(2, 1.5, { rule: true }),
    headingStyle(3, 1.25),
    headingStyle(4, 1),
    headingStyle(5, 0.875),
    headingStyle(6, 0.85),
    {
      // `ul, ol { margin-bottom: 0.7em }` with items themselves left tight —
      // `contextualSpacing` is how Word expresses "no space between siblings".
      type: "paragraph" as const,
      styleId: "ListParagraph",
      name: "List Paragraph",
      basedOn: "Normal",
      qFormat: true,
      paragraphProperties: {
        contextualSpacing: true,
        spacing: { after: pxTwips(0.7 * BODY_PX) }
      }
    },
    {
      // `blockquote { padding: 0 16px 0 10px; border-left: 5px solid }` from the
      // extension's sheet, plus the host's background and border colour. What
      // neither does is italicise or grey the text: the bar and the tint alone
      // mark the quote.
      type: "paragraph" as const,
      styleId: "Quote",
      name: "Quote",
      basedOn: "Normal",
      paragraphProperties: {
        indent: { left: pxTwips(10 + 5), right: pxTwips(16) },
        shading: { fill: COLORS.quoteBackground, pattern: "clear" as const },
        borders: {
          left: {
            style: "single" as const,
            size: 5 * 8,
            color: COLORS.quoteBar,
            space: Math.round(10 * PX)
          }
        }
      }
    },
    {
      // `pre { padding: 16px; border: 1px solid; background }` and
      // `code { font-size: 1em; line-height: 1.357em }` — note the code font is
      // the *same size* as body text, not smaller.
      type: "paragraph" as const,
      styleId: "CodeBlock",
      name: "Code Block",
      basedOn: "Normal",
      paragraphProperties: {
        indent: { left: pxTwips(16), right: pxTwips(16) },
        spacing: {
          before: pxTwips(16),
          after: pxTwips(16),
          line: lineHeight(1.357),
          lineRule: "auto" as const
        },
        // `pre` asks for `border: 1px solid var(--vscode-widget-border)`, but
        // `widget.border` has no value outside the high-contrast themes, so the
        // declaration never computes and a code block is marked by its background
        // alone. (The copy button beside it spells out a fallback colour; `pre`
        // deliberately does not.)
        shading: { fill: COLORS.codeBackground, pattern: "clear" as const }
      },
      runProperties: { font: "Courier New", size: pxHalfPt(BODY_PX) }
    },
    {
      // Character style applied to the in-text footnote reference mark so it
      // renders as a superscript number, matching Word's built-in style.
      type: "character" as const,
      styleId: "FootnoteReference",
      name: "footnote reference",
      runProperties: { vertAlign: "superscript" as const }
    },
    {
      // Paragraph style for footnote body text (smaller font, like Word).
      type: "paragraph" as const,
      styleId: "FootnoteText",
      name: "footnote text",
      basedOn: "Normal",
      runProperties: { size: pxHalfPt(BODY_PX * 0.85) }
    }
  ];
}
