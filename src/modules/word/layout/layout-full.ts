/**
 * Full Layout Engine — produces a complete LayoutDocument with positioned elements.
 *
 * Uses the pagination result from layoutDocument() for page assignments,
 * then computes precise positions (x, y, width, height) for every body
 * element on each page.
 *
 * This is the bridge between the page-number-only LayoutResult and the
 * fully positioned LayoutDocument that renderers (SVG, PDF, Canvas) can consume.
 *
 * Coverage: every variant of `BodyContent` from `../types` produces a
 * `PageContent` variant in the output. The `default:` branch of the
 * dispatch switch in `buildPage()` is a `never`-typed exhaustiveness
 * guard — adding a new body variant without a matching layout function
 * is a build error, never a silent drop.
 */

import {
  getFontAscent,
  getFontDescent,
  measureTextWidth,
  styledFontVariant
} from "@utils/font-metrics";
import { ommlToMathML } from "@word/advanced/math-convert";
import { extractMathText, isHyperlink, isRun } from "@word/core/text-utils";
import { layoutDocument } from "@word/layout/layout";
import type { LayoutOptions, LayoutResult } from "@word/layout/layout";
import {
  DEFAULT_FONT_SIZE_PT,
  DEFAULT_PAGE_HEIGHT_TWIPS,
  DEFAULT_PAGE_MARGIN_TWIPS,
  DEFAULT_PAGE_WIDTH_TWIPS,
  LINE_HEIGHT_FACTOR,
  SCRIPT_BASELINE_SHIFT_FACTOR,
  SCRIPT_FONT_SIZE_RATIO,
  resolveCellMarginsTwips
} from "@word/layout/layout-constants";
import type {
  LayoutAltChunk,
  LayoutBorderEdge,
  LayoutBorders,
  LayoutChart,
  LayoutCheckBox,
  LayoutDocument,
  LayoutFloat,
  LayoutImage,
  LayoutMath,
  LayoutOpaqueDrawing,
  LayoutPage,
  LayoutParagraph,
  LayoutSdt,
  LayoutShape,
  LayoutTable,
  LayoutTableCell,
  LayoutTableOfContents,
  LayoutTextBox,
  LineBox,
  LineBoxItem,
  PageContent,
  PageGeometry
} from "@word/layout/layout-model";
import { resolveWordLineMetrics } from "@word/layout/line-metrics";
import {
  resolveRunStyle,
  resolveShadingFill,
  resolveStyle,
  resolveTableCellFill
} from "@word/query/style-resolve";
import type { StyleResolveContext } from "@word/query/style-resolve";
import type {
  AltChunk,
  BodyContent,
  Border,
  ChartContent,
  ChartExContent,
  CheckBox,
  DocxDocument,
  DrawingShape,
  FloatingImage,
  FootnoteDef,
  ImageDef,
  InlineImageContent,
  MathBlock,
  OpaqueDrawing,
  Paragraph,
  ParagraphBorders,
  ParagraphChild,
  ParagraphProperties,
  NumberFormat,
  Run,
  SectionProperties,
  StructuredDocumentTag,
  Table,
  TableBorders,
  TableCellProperties,
  TableOfContents,
  TableProperties,
  TextBox,
  VerticalCellAlign
} from "@word/types";
import { EMU_PER_POINT, twipsToPt } from "@word/units";

// =============================================================================
// Public API
// =============================================================================

/**
 * Page geometry overrides for {@link FullLayoutOptions}. All fields are
 * in points. Any field not supplied falls back to the corresponding
 * value resolved from `doc.sectionProperties` (or the engine defaults).
 */
export interface PageGeometryOverride {
  readonly pageWidth?: number;
  readonly pageHeight?: number;
  readonly marginTop?: number;
  readonly marginBottom?: number;
  readonly marginLeft?: number;
  readonly marginRight?: number;
  /**
   * Distance of the header band from the top edge of the page, in
   * points. Overrides the section's `pgMar.header`. Header paragraphs
   * are laid out starting at this y-offset from the page top.
   */
  readonly headerMargin?: number;
  /**
   * Distance of the footer band from the bottom edge of the page, in
   * points. Overrides the section's `pgMar.footer`. The footer band's
   * top is placed at `pageHeight - footerMargin`.
   */
  readonly footerMargin?: number;
}

/** Options for the full layout engine. */
export interface FullLayoutOptions extends LayoutOptions {
  /** Font map for font-family resolution (name → actual font). */
  readonly fonts?: ReadonlyMap<string, string>;
  /**
   * Override the page geometry resolved from `doc.sectionProperties`.
   * Used by hosts that drive layout with their own page model (e.g. the
   * PDF bridge translating `DocxToPdfOptions.pageWidth` into a layout
   * geometry override). Any unspecified field falls back to the
   * section properties / engine defaults.
   */
  readonly pageGeometry?: PageGeometryOverride;
}

/**
 * Perform full document layout, producing a LayoutDocument with precise positions.
 *
 * @param doc - The parsed DOCX document.
 * @param options - Layout and font options.
 * @returns A fully positioned LayoutDocument.
 */
export function layoutDocumentFull(doc: DocxDocument, options?: FullLayoutOptions): LayoutDocument {
  // First pass: get page assignments via the existing lightweight layout
  const layoutResult = layoutDocument(doc, options);

  // Resolve list markers once over the whole document so ordered-list
  // counters increment correctly across pages. Stored in a module-level
  // context so that every `layoutParagraph` call — including those reached
  // through tables, text boxes, SDTs, footnotes, etc. — can render markers
  // without threading the map through every container function.
  const listMarkers = computeListMarkers(doc);
  // The previous values are restored rather than cleared. Layout is
  // synchronous, but it is not un-reentrant: a caller's `measureText` callback
  // can lay out another document (to size a caption, say), and clearing the
  // slots on the way out of the inner call left the outer one resolving styles,
  // list markers and contextual spacing against nothing for every remaining
  // paragraph. `layout.ts` already saves and restores; this now matches.
  const previousListMarkers = activeListMarkers;
  const previousDoc = activeDoc;
  const previousContextualSpacing = activeContextualSpacing;
  activeListMarkers = listMarkers;
  activeDoc = doc;
  // `w:contextualSpacing` needs each paragraph's *siblings*, which no single
  // `layoutParagraph` call can see. Resolved once here for the same reason and
  // through the same mechanism as the list markers.
  activeContextualSpacing = computeContextualSpacing(doc);
  try {
    return layoutDocumentFullInner(doc, options, layoutResult, listMarkers);
  } finally {
    activeListMarkers = previousListMarkers;
    activeDoc = previousDoc;
    activeContextualSpacing = previousContextualSpacing;
  }
}

/** Active list-marker map for the in-flight layout (see layoutDocumentFull). */
let activeListMarkers: ReadonlyMap<Paragraph, ListMarker> | undefined;

/** Active contextual-spacing map for the in-flight layout. */
let activeContextualSpacing: ReadonlyMap<Paragraph, ContextualSpacing> | undefined;

/**
 * Active document for the in-flight layout, so `layoutParagraph` can resolve
 * paragraph-style run properties (size/color/font) via `resolveStyle` without
 * threading `doc` through every container function. Layout is synchronous so a
 * single shared slot is safe.
 */
let activeDoc: DocxDocument | undefined;

function layoutDocumentFullInner(
  doc: DocxDocument,
  options: FullLayoutOptions | undefined,
  layoutResult: LayoutResult,
  listMarkers: ReadonlyMap<Paragraph, ListMarker>
): LayoutDocument {
  // Second pass: compute precise positions for each page. Footnote
  // ids that don't fit on a given page are carried over to the next
  // (a later page may still have room thanks to less body content
  // or fewer of its own newly-introduced notes).
  const pages: LayoutPage[] = [];
  let pendingFootnoteIds: readonly number[] = [];
  // Blocks the previous page could not hold. Pass 2 measures for real, so it —
  // not the estimating paginator — decides what fits; see `BuildPageResult`.
  let carried: readonly CarriedBlock[] = [];
  // Where the flow has got to in `doc.body`; see `FlowCursor`.
  const flow: FlowCursor = { nextItem: 0 };

  // Each section brings its own paper size, margins and headers, so every page
  // has to know which one it belongs to and how far into it it is (`titlePage`
  // selects the "first" header on a section's own first page).
  const sectionPropsList = collectSectionProperties(doc);
  const sectionOf = (itemIndex: number): number =>
    layoutResult.contentSections[itemIndex] ?? sectionPropsList.length - 1;
  let sectionIndex = doc.body.length > 0 ? sectionOf(0) : sectionPropsList.length - 1;
  let pageInSection = 1;

  // Emit pages until the body is exhausted and nothing is left carried. Every
  // iteration either advances `flow.nextItem` or places part of a carried block
  // (a page that starts empty always places at least one line or row — see
  // `splitLayoutParagraph`), so this terminates. `maxPages` only guards a
  // degenerate geometry with no usable content height at all.
  const maxPages = 20_000;
  do {
    const result = buildPage(
      doc,
      pages.length + 1,
      layoutResult,
      options,
      pendingFootnoteIds,
      listMarkers,
      carried,
      flow,
      { index: sectionIndex, props: sectionPropsList[sectionIndex], pageInSection }
    );
    pages.push(result.page);
    pendingFootnoteIds = result.deferredFootnoteIds;
    if (result.page.content.length === 0 && carried.length > 0) {
      // Nothing could be placed at all — stop rather than loop forever.
      break;
    }
    carried = result.carriedContent;

    // Which section the next page belongs to. Anything still carried belongs to
    // the section it came from, so the section only advances once the carry is
    // clear and the flow has crossed a boundary.
    const nextSection =
      carried.length === 0 && flow.nextItem < doc.body.length
        ? sectionOf(flow.nextItem)
        : sectionIndex;
    if (nextSection !== sectionIndex) {
      // The closing section's break type decides the parity the next one starts
      // on; Word inserts a blank page to reach it.
      const boundary = sectionBoundary(
        sectionPropsList[sectionIndex],
        sectionPropsList[nextSection]
      );
      sectionIndex = nextSection;
      pageInSection = 1;
      const nextPageNumber = pages.length + 1;
      const wrongParity =
        (boundary.parity === "odd" && nextPageNumber % 2 === 0) ||
        (boundary.parity === "even" && nextPageNumber % 2 === 1);
      if (wrongParity && pages.length < maxPages) {
        const blank = buildPage(
          doc,
          nextPageNumber,
          layoutResult,
          options,
          [],
          listMarkers,
          [],
          undefined,
          { index: sectionIndex, props: sectionPropsList[sectionIndex], pageInSection: 0 }
        );
        pages.push(blank.page);
      }
    } else {
      pageInSection++;
    }
  } while ((flow.nextItem < doc.body.length || carried.length > 0) && pages.length < maxPages);

  // Notes still queued after the body runs out get pages of their own, until the
  // queue drains. One extra page is not enough: three notes each nearly a page
  // tall put the first on the body page, the second on the extra page, and
  // dropped the third entirely.
  while (pendingFootnoteIds.length > 0 && pages.length > 0 && pages.length < maxPages) {
    const overflowResult = buildPage(
      doc,
      pages.length + 1,
      layoutResult,
      options,
      pendingFootnoteIds,
      listMarkers
      // No flow cursor and no carried content: this page hosts only the
      // deferred footnote queue.
    );
    pages.push(overflowResult.page);
    const remaining = overflowResult.deferredFootnoteIds;
    if (remaining.length >= pendingFootnoteIds.length) {
      // A note taller than a whole page can never shrink the queue; it is laid
      // out on this page (overflowing it) rather than looping forever.
      break;
    }
    pendingFootnoteIds = remaining;
  }

  // Bookmark pages and section-break page indices have to describe the pages
  // that were actually produced, not the estimate's. Both are remapped through
  // where pass 2 really put each body item.
  const itemPage = new Map<number, number>();
  for (const page of pages) {
    for (const block of page.content) {
      if (block.sourceIndex >= 0 && !itemPage.has(block.sourceIndex)) {
        itemPage.set(block.sourceIndex, page.pageNumber);
      }
    }
  }

  return {
    pages,
    totalPages: pages.length,
    bookmarkPages: remapBookmarkPages(pages, layoutResult),
    sectionBreaks: computeSectionBreaks(layoutResult, itemPage)
  };
}

/**
 * Bookmark name → page number, keyed to the pages pass 2 produced.
 *
 * The paginator records the page it *estimated* for each bookmark; once pass 2
 * re-flows content to its own measurements those numbers can be off by a page or
 * more, which would send a PDF outline entry to the wrong place.
 */
function remapBookmarkPages(
  pages_: readonly LayoutPage[],
  fallback: LayoutResult
): ReadonlyMap<string, number> {
  const pages = new Map<string, number>();
  // Read the placed blocks rather than the source body: a paragraph split across
  // a page boundary reports per-line bookmark names, so a bookmark in the part
  // that spilled over resolves to the page it actually landed on instead of the
  // page the paragraph started on.
  for (const page of pages_) {
    const visit = (blocks: readonly PageContent[] | readonly (LayoutParagraph | LayoutTable)[]) => {
      for (const block of blocks) {
        if (block.type === "paragraph") {
          for (const names of block.lineBookmarks ?? []) {
            for (const name of names) {
              if (!pages.has(name)) {
                pages.set(name, page.pageNumber);
              }
            }
          }
        } else if (block.type === "table") {
          for (const cell of block.cells) {
            visit(cell.content);
          }
        }
      }
    };
    visit(page.content);
  }
  // Anything pass 2 never placed keeps the paginator's estimate.
  for (const [name, page] of fallback.bookmarkPages) {
    if (!pages.has(name)) {
      pages.set(name, page);
    }
  }
  return pages;
}

// =============================================================================
// Internal: Page Building
// =============================================================================

/**
 * Per-line wrap exclusion zone (a horizontal band that text must avoid).
 *
 * `xLeft`/`xRight` are content-area-relative coordinates: 0 is the
 * left edge of the content area, `contentWidth` the right edge.
 * `yTop`/`yBottom` are relative to the top of the page's content area.
 * `wrapSide` mirrors ECMA-376's `<wp:wrapSquare wrapText="…">`:
 * `"left"` means text wraps on the float's left side only (i.e. the
 * float blocks the right portion of every line it intersects); `"right"`
 * is the mirror; `"bothSides"` blocks the float's exact horizontal
 * extent and lets text flow both to its left and right; `"largest"`
 * picks whichever side is wider on each line.
 */
interface WrapExclusion {
  readonly xLeft: number;
  readonly xRight: number;
  readonly yTop: number;
  readonly yBottom: number;
  readonly wrapSide: "left" | "right" | "bothSides" | "largest";
}

/**
 * Page-scoped context threaded through `layoutParagraph` so each line
 * can avoid the exclusion zones declared by floats that come earlier
 * on the page. Floats with `wrap.style ∈ { "square" | "tight" |
 * "through" }` populate this; other styles are handled at the
 * cursor-advancement layer in `buildPage`.
 */
interface PageLayoutContext {
  readonly exclusions: readonly WrapExclusion[];
  /** Content-area width — `contentWidth` for the page. */
  readonly contentWidth: number;
}

/**
 * Compute the longest available horizontal slot on the line whose
 * vertical span is `[lineY, lineY + lineHeight)`. Returns `xOffset`
 * (relative to the content-area's left edge) and `width`. When no
 * exclusion intersects the line the result is `{ xOffset: 0, width:
 * contentWidth }` (full width).
 *
 * Algorithm:
 *  1. Collect all exclusions whose y-band intersects the line.
 *  2. For each, derive the "blocked" x-interval on the content axis
 *     based on `wrapSide`:
 *      - `bothSides` blocks `[xLeft, xRight]` only.
 *      - `left` blocks `[xLeft, contentWidth]` (text wraps on the
 *         float's left side only).
 *      - `right` blocks `[0, xRight]`.
 *      - `largest` picks whichever side of the float is wider; the
 *         narrower side is blocked.
 *  3. Subtract every blocked interval from `[0, contentWidth]` and
 *     return the longest remaining gap.
 */
function availableSlotForLine(
  ctx: PageLayoutContext,
  lineY: number,
  lineHeight: number
): { xOffset: number; width: number } {
  const lineBottom = lineY + lineHeight;
  const blocked: { lo: number; hi: number }[] = [];
  for (const ex of ctx.exclusions) {
    // Strict overlap check: a line that just touches the float's
    // bottom edge (`lineY === ex.yBottom`) does NOT need to wrap.
    if (lineBottom <= ex.yTop || lineY >= ex.yBottom) {
      continue;
    }
    const exLeft = Math.max(0, ex.xLeft);
    const exRight = Math.min(ctx.contentWidth, ex.xRight);
    if (exLeft >= exRight) {
      continue;
    }
    switch (ex.wrapSide) {
      case "bothSides":
        blocked.push({ lo: exLeft, hi: exRight });
        break;
      case "left":
        // Float blocks the right half of the line.
        blocked.push({ lo: exLeft, hi: ctx.contentWidth });
        break;
      case "right":
        blocked.push({ lo: 0, hi: exRight });
        break;
      case "largest": {
        const leftSpace = exLeft;
        const rightSpace = ctx.contentWidth - exRight;
        if (rightSpace >= leftSpace) {
          // Wrap on the right (block to the left of the float).
          blocked.push({ lo: 0, hi: exRight });
        } else {
          blocked.push({ lo: exLeft, hi: ctx.contentWidth });
        }
        break;
      }
    }
  }

  if (blocked.length === 0) {
    return { xOffset: 0, width: ctx.contentWidth };
  }

  // Merge overlapping blocked intervals.
  blocked.sort((a, b) => a.lo - b.lo);
  const merged: { lo: number; hi: number }[] = [];
  for (const seg of blocked) {
    const last = merged[merged.length - 1];
    if (last && seg.lo <= last.hi) {
      last.hi = Math.max(last.hi, seg.hi);
    } else {
      merged.push({ lo: seg.lo, hi: seg.hi });
    }
  }

  // Build available gaps in [0, contentWidth] minus the merged blocks.
  const gaps: { x: number; width: number }[] = [];
  let cursor = 0;
  for (const seg of merged) {
    if (seg.lo > cursor) {
      gaps.push({ x: cursor, width: seg.lo - cursor });
    }
    cursor = Math.max(cursor, seg.hi);
  }
  if (cursor < ctx.contentWidth) {
    gaps.push({ x: cursor, width: ctx.contentWidth - cursor });
  }

  if (gaps.length === 0) {
    // Line entirely blocked. Fall back to full content width to avoid
    // pathological zero-width wraps that would loop forever; the line
    // visually overlaps the float (fail-safe behaviour).
    return { xOffset: 0, width: ctx.contentWidth };
  }
  // Pick the widest gap.
  let best = gaps[0];
  for (let i = 1; i < gaps.length; i++) {
    if (gaps[i].width > best.width) {
      best = gaps[i];
    }
  }
  return { xOffset: best.x, width: best.width };
}

/**
 * Build a single page. Returns the laid `LayoutPage` plus any
 * footnote ids that didn't fit and need to be carried to the next
 * page's footnote area. Callers must thread the deferred ids through
 * by passing them in as `pendingFootnoteIds` for the subsequent
 * page.
 */
interface BuildPageResult {
  readonly page: LayoutPage;
  readonly deferredFootnoteIds: readonly number[];
  /**
   * Blocks (or block remainders) that did not fit and must start the next page.
   *
   * The paginator in `layout.ts` estimates heights independently and cannot
   * split a block at all — its item→page map holds exactly one page per body
   * item. Pass 2 has the real measurements, so it owns the final fit decision:
   * anything that would cross the bottom margin is split here and carried
   * forward. Without this, a table or a paragraph taller than the space left
   * simply ran off the page.
   */
  readonly carriedContent: readonly CarriedBlock[];
}

/** A laid-out block awaiting placement at the top of the next page. */
type CarriedBlock =
  | { readonly kind: "paragraph"; readonly block: LayoutParagraph }
  | { readonly kind: "table"; readonly block: LayoutTable; readonly headerRows: number };

/**
 * How far through `doc.body` page building has got, threaded from page to page.
 *
 * Pass 2 measures for real, so it — not the estimating paginator — decides which
 * page each block lands on. It walks the body once, filling each page until the
 * next block does not fit, and only honours the paginator's *forced* breaks.
 * Selecting items by the paginator's page number instead meant every
 * disagreement between the two showed up in the output: content overflowed the
 * bottom margin where the estimate was too optimistic, and pages stopped early,
 * leaving a blank gap, where it was too pessimistic.
 */
interface FlowCursor {
  /** Index of the next body item to place. */
  nextItem: number;
}

/**
 * Split a laid-out paragraph at a page boundary.
 *
 * `availableHeight` is the space left on the page, measured from the
 * paragraph's own top (`rect.y`). Lines that fit stay in `head`; the rest are
 * re-based to the top of the next page and returned as `tail`. `head` drops its
 * space-after (it does not end the paragraph) and `tail` drops its space-before.
 *
 * Word's widow/orphan control forbids leaving a single line stranded, so a
 * paragraph is only split where both sides keep at least two lines — unless the
 * paragraph is taller than a whole page, where refusing to split would put it
 * off the page altogether.
 *
 * `atPageTop` says the paragraph starts a fresh page, so moving it down again
 * would be pointless: at least one line is emitted even if it does not fit,
 * which is both what Word does with an over-tall line and what guarantees the
 * page loop makes progress instead of carrying the same block forever.
 */
function splitLayoutParagraph(
  para: LayoutParagraph,
  availableHeight: number,
  fullPageHeight: number,
  atPageTop: boolean
): { head: LayoutParagraph | null; tail: LayoutParagraph | null } {
  const lines = para.lines;
  if (lines.length === 0) {
    return atPageTop ? { head: para, tail: null } : { head: null, tail: para };
  }

  // How many leading lines fit in the space left.
  let fitCount = 0;
  while (fitCount < lines.length) {
    const line = lines[fitCount];
    if (line.y + line.height > availableHeight) {
      break;
    }
    fitCount++;
  }

  // A `w:br w:type="page"` inside the paragraph overrides fit: everything up to
  // and including its line stays, the rest continues on the next page. Widow
  // control does not apply — the author asked for the break.
  const forced = para.pageBreakAfterLines?.find(index => index + 1 <= fitCount);
  if (forced !== undefined && forced + 1 < lines.length) {
    return sliceParagraphAtLine(para, forced + 1);
  }

  if (fitCount >= lines.length) {
    // Every line fits and only the trailing space-after spills. Word does not
    // render space-after across a page break, so trim the box to its last line
    // rather than pushing a paragraph whose text fits onto the next page.
    const last = lines[lines.length - 1];
    const contentBottom = last.y + last.height;
    return {
      head:
        para.rect.height > availableHeight
          ? {
              ...para,
              rect: { ...para.rect, height: contentBottom },
              // The trimmed box ends at the text, so nothing is inset below it.
              ...(para.decorationInsets
                ? { decorationInsets: { ...para.decorationInsets, bottom: 0 } }
                : {})
            }
          : para,
      tail: null
    };
  }

  if (fitCount === 0) {
    if (!atPageTop) {
      return { head: null, tail: para };
    }
    fitCount = 1; // an over-tall line still has to go somewhere
  } else {
    const mustSplit = atPageTop || para.rect.height > fullPageHeight;
    const widowSafe = fitCount >= 2 && lines.length - fitCount >= 2;
    if (!widowSafe && !mustSplit) {
      return { head: null, tail: para };
    }
  }

  return sliceParagraphAtLine(para, fitCount);
}

/**
 * Cut a laid-out paragraph so that `count` lines stay and the rest continue at
 * the top of the next page.
 *
 * The head keeps its space-before but loses its space-after (it does not end the
 * paragraph); the tail is the mirror image. Insets are relative to `rect`, so
 * adjusting them is all the decoration needs. Per-line note ids are sliced
 * alongside the lines so each note follows its own reference.
 */
function sliceParagraphAtLine(
  para: LayoutParagraph,
  count: number
): { head: LayoutParagraph; tail: LayoutParagraph } {
  const headLines = para.lines.slice(0, count);
  const tailLines = para.lines.slice(count);
  const headBottom = headLines[headLines.length - 1].y + headLines[headLines.length - 1].height;
  const shift = tailLines[0].y;
  const insets = para.decorationInsets;
  const noteIds = para.lineNoteIds;
  const bookmarks = para.lineBookmarks;
  const breaks = para.pageBreakAfterLines;
  return {
    head: {
      ...para,
      rect: { ...para.rect, height: headBottom },
      lines: headLines,
      ...(noteIds ? { lineNoteIds: noteIds.slice(0, count) } : {}),
      ...(bookmarks ? { lineBookmarks: bookmarks.slice(0, count) } : {}),
      ...(breaks ? { pageBreakAfterLines: breaks.filter(i => i < count) } : {}),
      ...(insets ? { decorationInsets: { ...insets, bottom: 0 } } : {})
    },
    tail: {
      ...para,
      rect: { ...para.rect, y: 0, height: para.rect.height - shift },
      lines: tailLines.map(line => ({ ...line, y: line.y - shift })),
      ...(noteIds ? { lineNoteIds: noteIds.slice(count) } : {}),
      ...(bookmarks ? { lineBookmarks: bookmarks.slice(count) } : {}),
      ...(breaks
        ? { pageBreakAfterLines: breaks.filter(i => i >= count).map(i => i - count) }
        : {}),
      ...(insets ? { decorationInsets: { ...insets, top: 0 } } : {})
    }
  };
}

/**
 * Split a laid-out table at a page boundary, on a row edge.
 *
 * Rows are never broken mid-height: a row that does not fit entirely moves to
 * the next page whole. Rows marked `tableHeader` repeat at the top of the
 * continuation so a table spanning pages keeps its column labels — which is
 * what Word does and what the paginator in `layout.ts` already assumed.
 *
 * `atPageTop` has the same role as in `splitLayoutParagraph`: on a fresh page
 * at least one row is emitted, so a row taller than the page overflows rather
 * than being carried forever.
 */
function splitLayoutTable(
  table: LayoutTable,
  availableHeight: number,
  headerRowCount: number,
  atPageTop: boolean
): { head: LayoutTable | null; tail: LayoutTable | null } {
  if (table.cells.length === 0) {
    return { head: table, tail: null };
  }

  // Row boundaries in table-relative coordinates.
  const rowTop = new Map<number, number>();
  const rowBottom = new Map<number, number>();
  let maxRow = 0;
  for (const cell of table.cells) {
    const top = cell.rect.y;
    const bottom = top + cell.rect.height;
    rowTop.set(cell.row, Math.min(rowTop.get(cell.row) ?? top, top));
    rowBottom.set(cell.row, Math.max(rowBottom.get(cell.row) ?? bottom, bottom));
    maxRow = Math.max(maxRow, cell.row);
  }
  const rows = [...rowTop.keys()].sort((a, b) => a - b);

  // First row index (in `rows`) that does not fit in the space left.
  let fitRows = 0;
  while (fitRows < rows.length && (rowBottom.get(rows[fitRows]) ?? 0) <= availableHeight) {
    fitRows++;
  }

  if (fitRows >= rows.length) {
    return { head: table, tail: null };
  }

  if (fitRows === 0 || (fitRows <= headerRowCount && !atPageTop)) {
    // Nothing, or nothing but repeated header rows, would land here. Move the
    // table down rather than leave a dangling header — unless this is already a
    // fresh page, where at least one row has to be emitted.
    if (!atPageTop) {
      return { head: null, tail: table };
    }
    fitRows = Math.max(1, Math.min(headerRowCount + 1, rows.length));
  }

  const splitRow = rows[fitRows];
  const headCells = table.cells.filter(c => c.row < splitRow);
  const headHeight = rowBottom.get(rows[fitRows - 1]) ?? table.rect.height;

  // The continuation repeats the header rows, then continues from `splitRow`.
  const repeated = table.cells.filter(c => c.row < headerRowCount && c.row < splitRow);
  const repeatedHeight =
    repeated.length > 0 ? Math.max(...repeated.map(c => c.rect.y + c.rect.height)) : 0;
  const shift = (rowTop.get(splitRow) ?? 0) - repeatedHeight;

  const tailCells = [
    // Repeated header rows already sit at the top of the table.
    ...repeated,
    ...table.cells
      .filter(c => c.row >= splitRow)
      .map(c => ({ ...c, rect: { ...c.rect, y: c.rect.y - shift } }))
  ];

  return {
    head: {
      ...table,
      rect: { ...table.rect, height: headHeight },
      cells: headCells
    },
    tail: {
      ...table,
      rect: { ...table.rect, y: 0, height: table.rect.height - shift },
      cells: tailCells
    }
  };
}

/** Count the leading rows a table repeats on every page it spans. */
function countRepeatedHeaderRows(table: Table): number {
  let count = 0;
  for (const row of table.rows) {
    if (row.properties?.tableHeader !== true) {
      break;
    }
    count++;
  }
  return count;
}

/**
 * Every section's properties, indexed by the section numbers `layout.ts` reports
 * in `contentSections`.
 *
 * ECMA-376 stores a section's setup on the *last* paragraph of that section; the
 * final section's lives on `doc.sectionProperties`. Pass 2 used only the final
 * one for the whole document, so a document with sections rendered every page at
 * the last section's paper size and margins, and never broke where a section
 * boundary demanded it.
 */
function collectSectionProperties(doc: DocxDocument): (SectionProperties | undefined)[] {
  const sections: (SectionProperties | undefined)[] = [];
  for (const item of doc.body) {
    if (item.type === "paragraph" && item.properties?.sectionProperties) {
      sections.push(item.properties.sectionProperties);
    }
  }
  // The trailing section is the one described by the document-level properties.
  sections.push(doc.sectionProperties);
  return sections;
}

/**
 * How the boundary between two sections behaves.
 *
 * The break type lives on the sectPr of the section being *closed*, which is the
 * convention `layout.ts` already paginates by — the two passes have to agree or
 * they disagree about the page count. `continuous` keeps the following content on
 * the same page unless the paper size changes, which forces one regardless.
 */
function sectionBoundary(
  closing: SectionProperties | undefined,
  next: SectionProperties | undefined
): { readonly startsPage: boolean; readonly parity: "odd" | "even" | undefined } {
  const breakType = closing?.breakType ?? "nextPage";
  if (breakType === "continuous") {
    const sameWidth =
      (closing?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS) ===
      (next?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS);
    const sameHeight =
      (closing?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS) ===
      (next?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS);
    return { startsPage: !(sameWidth && sameHeight), parity: undefined };
  }
  return {
    startsPage: true,
    parity: breakType === "oddPage" ? "odd" : breakType === "evenPage" ? "even" : undefined
  };
}

/** The properties of section `index`, or the document's when out of range. */
function sectionPropsOf(doc: DocxDocument, index: number): SectionProperties | undefined {
  const sections = collectSectionProperties(doc);
  return sections[index] ?? doc.sectionProperties;
}

function buildPage(
  doc: DocxDocument,
  pageNumber: number,
  layout: LayoutResult,
  options: FullLayoutOptions | undefined,
  pendingFootnoteIds: readonly number[],
  listMarkers?: ReadonlyMap<Paragraph, ListMarker>,
  carriedIn: readonly CarriedBlock[] = [],
  flow?: FlowCursor,
  section?: {
    readonly index: number;
    readonly props: SectionProperties | undefined;
    readonly pageInSection: number;
  }
): BuildPageResult {
  const sectionProps = section ? section.props : doc.sectionProperties;
  const geometry = computePageGeometry(sectionProps, options?.pageGeometry);
  const content: PageContent[] = [];
  const imageMap = buildImageMap(doc.images);
  /**
   * Footnote ids referenced from the raw `BodyContent` items assigned
   * to this page, collected as we iterate so the order is the
   * document-reading order. Pending ids carried over from the
   * previous page are queued ahead so they render before this page's
   * own newly-introduced notes.
   */
  const footnoteRefIds: number[] = [...pendingFootnoteIds];
  /**
   * Notes belonging to blocks this page could not hold at all. They follow their
   * block to the next page; leaving them here would print a note whose reference
   * is not on the page.
   */
  const carriedFootnoteRefs: number[] = [];

  /**
   * Wrap exclusion zones from floats with `square` / `tight` /
   * `through` wrap, populated as we iterate so subsequent paragraphs
   * (later in document order) avoid them line-by-line. Floats that
   * appear AFTER a paragraph in the source do not push back into
   * preceding lines — this matches Word's behaviour where re-flow on
   * insertion happens at edit time, not render time.
   */
  const pageExclusions: WrapExclusion[] = [];

  let cursorY = 0; // relative to content area top

  /**
   * Blocks this page could not hold. Once the first one overflows, everything
   * after it must follow — pushing a later block up past an earlier one would
   * reorder the document.
   */
  const carriedOut: CarriedBlock[] = [];

  /**
   * Collapse the space above the document's very first block.
   *
   * CSS collapses a container's first child's top margin, which is why VS Code's
   * stylesheet can write `h1 { margin-top: 0 }` and still give every other
   * heading 24px of air. Without it a document opens with its title pushed an
   * arbitrary distance below the top margin, which no typesetter would do.
   * Later pages keep their space-before: Word only drops it across a page break
   * when explicitly asked to (`w:suppressSpBfAfterPgBrk`).
   */
  const collapseLeadingSpace = (laid: LayoutParagraph): LayoutParagraph => {
    const lead = laid.lines[0]?.y ?? 0;
    if (lead <= 0) {
      return laid;
    }
    return {
      ...laid,
      rect: { ...laid.rect, height: laid.rect.height - lead },
      lines: laid.lines.map(line => ({ ...line, y: line.y - lead })),
      ...(laid.decorationInsets ? { decorationInsets: { ...laid.decorationInsets, top: 0 } } : {})
    };
  };

  /**
   * Place a paragraph, splitting it at the bottom margin when it does not fit.
   * Returns false once the page is closed, so the caller stops placing.
   */
  const placeParagraph = (laid: LayoutParagraph): boolean => {
    if (carriedOut.length > 0) {
      carriedOut.push({ kind: "paragraph", block: laid });
      return false;
    }
    const available = geometry.contentHeight - laid.rect.y;
    // An internal page break must be honoured even when the whole paragraph
    // would otherwise fit on this page.
    const forcedBreakLine = laid.pageBreakAfterLines?.[0];
    const hasForcedBreak = forcedBreakLine !== undefined && forcedBreakLine + 1 < laid.lines.length;
    if (laid.rect.height <= available && !hasForcedBreak) {
      content.push(laid);
      cursorY = laid.rect.y + laid.rect.height;
      return true;
    }
    if (
      hasForcedBreak &&
      laid.lines[forcedBreakLine].y + laid.lines[forcedBreakLine].height <= available
    ) {
      const cut = sliceParagraphAtLine(laid, forcedBreakLine + 1);
      content.push(cut.head);
      cursorY = cut.head.rect.y + cut.head.rect.height;
      carriedOut.push({ kind: "paragraph", block: cut.tail });
      return false;
    }
    const atPageTop = content.length === 0 && laid.rect.y <= 0.01;
    const { head, tail } = splitLayoutParagraph(laid, available, geometry.contentHeight, atPageTop);
    if (head) {
      content.push(head);
      cursorY = head.rect.y + head.rect.height;
    }
    if (tail) {
      carriedOut.push({ kind: "paragraph", block: tail });
      return false;
    }
    return true;
  };

  /** Place a table, splitting it on a row edge when it does not fit. */
  const placeTable = (laid: LayoutTable, headerRows: number): boolean => {
    if (carriedOut.length > 0) {
      carriedOut.push({ kind: "table", block: laid, headerRows });
      return false;
    }
    const available = geometry.contentHeight - laid.rect.y;
    if (laid.rect.height <= available) {
      content.push(laid);
      cursorY = laid.rect.y + laid.rect.height;
      return true;
    }
    const atPageTop = content.length === 0 && laid.rect.y <= 0.01;
    const { head, tail } = splitLayoutTable(laid, available, headerRows, atPageTop);
    if (head) {
      content.push(head);
      cursorY = head.rect.y + head.rect.height;
    }
    if (tail) {
      carriedOut.push({ kind: "table", block: tail, headerRows });
      return false;
    }
    return true;
  };

  // Remainders carried from the previous page go first, at the content top.
  for (const carried of carriedIn) {
    if (carried.kind === "paragraph") {
      const rebased: LayoutParagraph = {
        ...carried.block,
        rect: { ...carried.block.rect, y: cursorY }
      };
      if (!placeParagraph(rebased)) {
        break;
      }
    } else {
      // Cell rects are table-relative, so moving the table is enough.
      const rebased: LayoutTable = {
        ...carried.block,
        rect: { ...carried.block.rect, y: cursorY }
      };
      if (!placeTable(rebased, carried.headerRows)) {
        break;
      }
    }
  }

  // Which body items this page draws from. In flow mode the page takes items in
  // order from the shared cursor and stops when one no longer fits; otherwise
  // (the footnote-only spill page) it takes the paginator's assignment.
  const flowMode = flow !== undefined;
  const startItem = flowMode ? flow.nextItem : 0;
  let placedItems = 0;
  let stopFlow = false;

  /** A body item's effective `w:keepNext` — "do not end a page on me". */
  const keepsWithNext = (index: number): boolean => {
    const item = doc.body[index];
    if (!item || item.type !== "paragraph" || !activeDoc) {
      return false;
    }
    return resolveStyle(activeDoc, item).paragraphProperties.keepNext === true;
  };

  for (let i = startItem; i < doc.body.length; i++) {
    if (flowMode) {
      if (stopFlow || carriedOut.length > 0) {
        break;
      }
      // A forced break (explicit page break or section break) must be honoured
      // even when the rest of the page is empty.
      if (layout.forcedBreakBefore[i] && (content.length > 0 || placedItems > 0)) {
        break;
      }
      // A section boundary ends the page when the section being closed says so,
      // because the next section may use different paper, margins and headers.
      if (
        section !== undefined &&
        layout.contentSections[i] !== section.index &&
        (content.length > 0 || placedItems > 0) &&
        sectionBoundary(section.props, sectionPropsOf(doc, layout.contentSections[i])).startsPage
      ) {
        break;
      }
    } else if (layout.contentPages[i] !== pageNumber) {
      continue;
    }

    const item = doc.body[i];
    // Collected into a per-item list first. A block that turns out not to fit is
    // carried whole to the next page, and its notes have to travel with it —
    // adding them to the page's list up front left the note on a page whose
    // reference had moved on.
    const itemFootnoteRefs: number[] = [];
    collectFootnoteRefsFromBody(item, itemFootnoteRefs);
    const contentBefore = content.length;
    // A top-level paragraph reports which of its notes are referenced from which
    // line, so a split hands each note to the right page. Other block kinds are
    // not split, and their whole-item list is exact.
    const usesLineAttribution = item.type === "paragraph" && itemFootnoteRefs.length > 0;
    const pageContext: PageLayoutContext = {
      exclusions: pageExclusions,
      contentWidth: geometry.contentWidth
    };
    switch (item.type) {
      case "paragraph": {
        const laid = layoutParagraph(
          item,
          cursorY,
          geometry.contentWidth,
          options,
          pageContext,
          imageMap,
          listMarkers
        );
        const positioned = { ...laid, sourceIndex: i };
        if (
          !placeParagraph(
            pageNumber === 1 && content.length === 0 && startItem === 0
              ? collapseLeadingSpace(positioned)
              : positioned
          )
        ) {
          stopFlow = true;
        }
        break;
      }
      case "table": {
        const laid = layoutTable(item, cursorY, geometry.contentWidth, i, options, imageMap);
        if (!placeTable(laid, countRepeatedHeaderRows(item))) {
          stopFlow = true;
        }
        break;
      }
      case "floatingImage": {
        const laid = layoutFloatingImage(
          item,
          cursorY,
          geometry.contentWidth,
          geometry.contentHeight,
          geometry,
          i,
          imageMap
        );
        content.push(laid);
        // Cursor advancement strategy:
        //  - `wrap.style === "topAndBottom"` (or no wrap and not
        //    behindDoc) forces body content to clear the float
        //    vertically; advance the cursor to the float's bottom edge
        //    plus the wrap.bottom margin.
        //  - `square` / `tight` / `through` register an exclusion zone
        //    so subsequent paragraph wrap avoids the float laterally;
        //    the body cursor is NOT advanced (text wraps around).
        //  - Behind-document floats never displace text.
        //  - Inline-like floats (no anchor, no behindDoc) keep the
        //    backwards-compatible advance behaviour.
        const hasAnchor =
          item.simplePos != null ||
          item.horizontalPosition != null ||
          item.verticalPosition != null;
        const wrapStyle = item.wrap?.style;
        const isWrapAround =
          wrapStyle === "square" || wrapStyle === "tight" || wrapStyle === "through";
        const advanceCursor =
          (!hasAnchor && !item.behindDoc && !isWrapAround) || wrapStyle === "topAndBottom";
        if (advanceCursor) {
          const padBottom = item.wrap?.margins?.bottom ? emuToPt(item.wrap.margins.bottom) : 0;
          cursorY = laid.rect.y + laid.rect.height + padBottom;
        }
        if (isWrapAround && !item.behindDoc) {
          // Add an exclusion band covering the float's rect plus its
          // wrap padding margins. Subsequent paragraphs (later in doc
          // order) will wrap their lines around this rectangle.
          const padL = laid.wrap?.margins?.left ?? 0;
          const padR = laid.wrap?.margins?.right ?? 0;
          const padT = laid.wrap?.margins?.top ?? 0;
          const padB = laid.wrap?.margins?.bottom ?? 0;
          pageExclusions.push({
            xLeft: laid.rect.x - padL,
            xRight: laid.rect.x + laid.rect.width + padR,
            yTop: laid.rect.y - padT,
            yBottom: laid.rect.y + laid.rect.height + padB,
            wrapSide: laid.wrap?.side ?? "bothSides"
          });
        }
        break;
      }
      case "textBox": {
        const laid = layoutTextBox(item, cursorY, geometry.contentWidth, i, options, imageMap);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "drawingShape": {
        const laid = layoutDrawingShape(item, cursorY, geometry.contentWidth, i, options, imageMap);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "chart":
      case "chartEx": {
        const laid = layoutChart(item, cursorY, geometry.contentWidth, i);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "sdt": {
        const laid = layoutSdt(item, cursorY, geometry.contentWidth, i, options, imageMap);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "math": {
        const laid = layoutMath(item, cursorY, geometry.contentWidth, i, options);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "checkBox": {
        const laid = layoutCheckBox(item, cursorY, i, options);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "tableOfContents": {
        const laid = layoutTableOfContents(
          item,
          cursorY,
          geometry.contentWidth,
          i,
          options,
          imageMap
        );
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "altChunk": {
        const laid = layoutAltChunk(item, cursorY, geometry.contentWidth, i);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "opaqueDrawing": {
        const laid = layoutOpaqueDrawing(item, cursorY, geometry.contentWidth, i);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      default: {
        // Compile-time exhaustiveness check. Adding a new variant to
        // `BodyContent` triggers a TypeScript error here until a
        // corresponding case + layout function are added above. This
        // replaces the previous "Skip unsupported types" silent drop.
        const _exhaustive: never = item;
        throw new Error(
          `layoutDocumentFull: unhandled BodyContent variant ${
            (_exhaustive as { type: string }).type
          }`
        );
      }
    }

    // Whether any part of the item landed here decides where its notes go.
    if (itemFootnoteRefs.length > 0) {
      const placed = content.length > contentBefore;
      if (!placed) {
        carriedFootnoteRefs.push(...itemFootnoteRefs);
      } else if (usesLineAttribution) {
        // Split-aware: the placed slice reports its own lines' notes, and
        // whatever is left over travels with the carried remainder.
        const block = content[content.length - 1];
        const kept =
          block.type === "paragraph" && block.lineNoteIds
            ? block.lineNoteIds.flat()
            : itemFootnoteRefs;
        footnoteRefIds.push(...kept);
        const keptSet = new Set(kept);
        for (const id of itemFootnoteRefs) {
          if (!keptSet.has(id)) {
            carriedFootnoteRefs.push(id);
          }
        }
      } else {
        footnoteRefIds.push(...itemFootnoteRefs);
      }
    }

    if (flowMode) {
      // A block that was split leaves its remainder in `carriedOut`; the item
      // itself is done either way, so the cursor always advances and the flow
      // cannot revisit it.
      flow.nextItem = i + 1;
      placedItems++;
    }
  }

  if (flowMode) {
    // `w:keepNext` after the fact, rather than by looking ahead.
    //
    // A predictive check has to guess how much of the *next* block counts as
    // "started", and it has to do so for a whole chain of `keepNext` paragraphs
    // at once. Getting that wrong is expensive in both directions: demanding the
    // entire chain fit gave every heading in a run its own page, and the repeated
    // trial layouts were quadratic in the chain length.
    //
    // Deciding afterwards needs no prediction. If the page ends on a `keepNext`
    // paragraph and there is more to come, hand it to the next page — repeatedly,
    // so a run of headings travels together. The page must keep at least one
    // block, since a heading alone on a page is better than an empty one.
    const more = flow.nextItem < doc.body.length || carriedOut.length > 0;
    if (more) {
      // Length of the trailing run of `keepNext` paragraphs.
      let run = 0;
      while (run < content.length) {
        const block = content[content.length - 1 - run];
        if (block.type !== "paragraph" || block.sourceIndex < 0) {
          break;
        }
        if (!keepsWithNext(block.sourceIndex)) {
          break;
        }
        run++;
      }
      // Move the whole run down together — but only if something that is not
      // part of it stays behind. When the entire page is one `keepNext` run the
      // request cannot be met (a page has to hold something), and Word likewise
      // lets the break stand rather than emitting a page per paragraph.
      if (run > 0 && run < content.length) {
        const moved = content.splice(content.length - run, run);
        cursorY = moved[0].rect.y;
        for (let k = moved.length - 1; k >= 0; k--) {
          carriedOut.unshift({ kind: "paragraph", block: moved[k] as LayoutParagraph });
        }
      }
    }
  }

  const header = layoutHeader(
    doc,
    pageNumber,
    section?.pageInSection ?? pageNumber,
    sectionProps,
    geometry,
    options,
    imageMap
  );
  const footer = layoutFooter(
    doc,
    pageNumber,
    section?.pageInSection ?? pageNumber,
    sectionProps,
    geometry,
    options,
    imageMap
  );

  // Compute the absolute (page-y) lower edge of body content so the
  // footnote layout knows how much vertical room is actually free.
  // `cursorY` is content-area-relative; convert by adding `marginTop`.
  const bodyBottomPageY = geometry.marginTop + cursorY;
  const footnoteResult = layoutFootnotes(
    doc,
    footnoteRefIds,
    geometry,
    options,
    bodyBottomPageY,
    imageMap
  );

  // Decide whether the visual separator above the footnote area is the
  // standard "separator" or the wider "continuationSeparator".
  // A continuation page is one whose footnote area is *entirely*
  // composed of notes deferred from a previous page (no body item on
  // this page introduces a new reference). Detect by comparing the
  // footnote-id sequence against the supplied `pendingFootnoteIds`.
  let footnoteSeparator: LayoutPage["footnoteSeparator"] | undefined;
  if (footnoteResult.laid.length > 0) {
    const introducedHere = footnoteRefIds.length > pendingFootnoteIds.length;
    const sepKind: "separator" | "continuationSeparator" = introducedHere
      ? "separator"
      : "continuationSeparator";
    // Place the rule a few points above the first footnote paragraph.
    const stackTop = footnoteResult.laid[0].rect.y;
    footnoteSeparator = { y: stackTop - 4, kind: sepKind };
  }

  return {
    page: {
      pageNumber,
      geometry,
      content,
      ...(header.length > 0 ? { header } : {}),
      ...(footer.length > 0 ? { footer } : {}),
      ...(footnoteResult.laid.length > 0 ? { footnoteArea: footnoteResult.laid } : {}),
      ...(footnoteSeparator ? { footnoteSeparator } : {})
    },
    // Notes deferred for want of room come first; those following a carried
    // block come after, matching reading order on the next page.
    deferredFootnoteIds: [...footnoteResult.deferred, ...carriedFootnoteRefs],
    carriedContent: carriedOut
  };
}

/**
 * Build the footnote area for a page.
 *
 * Approach (see ECMA-376 §17.11.10 for the full rules):
 *  1. Caller supplies the ids of footnotes referenced by this page's
 *     body content (plus any deferred from the previous page) in
 *     document order.
 *  2. Look each id up in `doc.footnotes` (skipping `"separator"` and
 *     `"continuation*"` entries — those are presentation chrome that
 *     `LayoutPage.footnoteSeparator` carries instead).
 *  3. Lay each note out and greedily fit notes into the available
 *     vertical band between the body's bottom and `pageHeight -
 *     pgMar.footer`. Notes that don't fit are returned as `deferred`
 *     so the caller can attach them to the next page.
 *  4. The first note is always force-fit even if it overflows: silently
 *     dropping content is worse than overflowing slightly into the
 *     bottom margin (and a single note that's bigger than a page is
 *     pathological enough that no consumer expects perfection).
 *
 * Known visual limitation:
 *  - The body is paginated *without* knowing about footnote heights.
 *    On a page that's nearly full of body content **and** introduces
 *    many tall notes, the body's bottom can sit close to (or right
 *    at) the footnote stack's top — visually crowded but the data
 *    remains intact (no overlap thanks to the fit-or-defer logic
 *    above; the worst case is body and stack touching). Re-flowing
 *    body pagination based on per-page footnote height would require
 *    teaching `layoutDocument` (the first pass) about footnote sizes
 *    and is intentionally out of scope to keep the layout core
 *    single-pass.
 *
 *  - Each unique footnote id appears at most once on the page even
 *    if referenced multiple times (Word's behaviour).
 */
/**
 * Result of laying out a page's footnote area.
 *
 * `laid` are the positioned paragraphs ready to render; `deferred`
 * are footnote ids that didn't fit on the current page and should be
 * carried to the next page's footnote area (queued at the head so
 * they render before that page's own newly-referenced notes).
 */
interface FootnoteLayoutResult {
  readonly laid: readonly LayoutParagraph[];
  readonly deferred: readonly number[];
}

function layoutFootnotes(
  doc: DocxDocument,
  ids: readonly number[],
  geometry: PageGeometry,
  options: FullLayoutOptions | undefined,
  bodyBottomPageY: number,
  imageMap: ReadonlyMap<string, ImageDef>
): FootnoteLayoutResult {
  if (ids.length === 0 || !doc.footnotes || doc.footnotes.length === 0) {
    return { laid: [], deferred: [] };
  }
  const noteById = new Map<number, FootnoteDef>();
  for (const note of doc.footnotes) {
    const kind = note.type ?? "normal";
    if (kind === "normal") {
      noteById.set(note.id, note);
    }
  }

  const footerOffsetPt = geometry.height - geometry.footerOffset;
  /**
   * Vertical room available for the footnote stack on this page.
   * The stack must sit between `bodyBottomPageY` (top) and
   * `footerOffsetPt` (bottom); anything that doesn't fit gets
   * deferred. A small minimum is enforced so a page that's almost
   * full still flushes at least one footnote (the alternative —
   * deferring everything indefinitely — would loop forever in
   * pathological inputs).
   */
  const availableSpace = Math.max(0, footerOffsetPt - bodyBottomPageY);

  const seen = new Set<number>();
  const laidPerNote: LayoutParagraph[][] = [];
  const heightPerNote: number[] = [];
  const idsLaid: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const note = noteById.get(id);
    if (!note) {
      continue;
    }
    const note_paragraphs: LayoutParagraph[] = [];
    let cursor = 0;
    for (const para of note.content) {
      if (para.type !== "paragraph") {
        continue;
      }
      const p = layoutParagraph(para, cursor, geometry.contentWidth, options, undefined, imageMap);
      note_paragraphs.push(p);
      cursor = p.rect.y + p.rect.height;
    }
    laidPerNote.push(note_paragraphs);
    heightPerNote.push(cursor);
    idsLaid.push(id);
  }

  // Greedily fit notes into the available space. The first note is
  // always laid out — even if it overflows — so a page that
  // references a single oversized note still renders something
  // (avoids losing data); the renderer will visually clip into the
  // bottom margin in that pathological case.
  const fitNotes: LayoutParagraph[][] = [];
  const fitHeights: number[] = [];
  const deferred: number[] = [];
  let stackHeight = 0;
  for (let i = 0; i < idsLaid.length; i++) {
    const noteHeight = heightPerNote[i];
    const wouldBe = stackHeight + noteHeight;
    const fitsCleanly = wouldBe <= availableSpace;
    const isFirstAndForced = fitNotes.length === 0;
    if (fitsCleanly || isFirstAndForced) {
      fitNotes.push(laidPerNote[i]);
      fitHeights.push(noteHeight);
      stackHeight = wouldBe;
    } else {
      deferred.push(idsLaid[i]);
    }
  }

  if (fitNotes.length === 0) {
    return { laid: [], deferred };
  }

  // Translate the whole stack so its bottom edge is at footerOffsetPt.
  const top = footerOffsetPt - stackHeight;
  const flat: LayoutParagraph[] = [];
  let runningOffset = top;
  for (let i = 0; i < fitNotes.length; i++) {
    for (const p of fitNotes[i]) {
      flat.push({
        ...p,
        rect: { ...p.rect, y: p.rect.y + runningOffset }
      });
    }
    runningOffset += fitHeights[i];
  }
  return { laid: flat, deferred };
}

/**
 * Walk a `BodyContent` item's run-level descendants and append every
 * `FootnoteRefContent` id to `out`, in document order. Recurses into
 * the few container variants whose children embed paragraphs (textBox,
 * drawingShape, sdt, tableOfContents, table cells).
 */
function collectFootnoteRefsFromBody(item: BodyContent, out: number[]): void {
  switch (item.type) {
    case "paragraph":
      collectFootnoteRefsFromParagraph(item, out);
      return;
    case "table":
      for (const r of item.rows) {
        for (const c of r.cells) {
          for (const inner of c.content) {
            collectFootnoteRefsFromBody(inner, out);
          }
        }
      }
      return;
    case "textBox":
      for (const child of item.content) {
        collectFootnoteRefsFromBody(child, out);
      }
      return;
    case "drawingShape":
      if (item.textContent) {
        for (const child of item.textContent) {
          collectFootnoteRefsFromBody(child, out);
        }
      }
      return;
    case "sdt":
      for (const child of item.content) {
        if (child && typeof child === "object" && "type" in child) {
          collectFootnoteRefsFromBody(child as BodyContent, out);
        }
      }
      return;
    case "tableOfContents":
      if (item.cachedParagraphs) {
        for (const para of item.cachedParagraphs) {
          collectFootnoteRefsFromBody(para, out);
        }
      }
      return;
    case "floatingImage":
    case "math":
    case "checkBox":
    case "chart":
    case "chartEx":
    case "altChunk":
    case "opaqueDrawing":
      return;
    default: {
      const _exhaustive: never = item;
      void _exhaustive;
    }
  }
}

function collectFootnoteRefsFromParagraph(para: Paragraph, out: number[]): void {
  for (const child of para.children) {
    if ("type" in child && child.type === "hyperlink") {
      collectFootnoteRefsFromHyperlink(child, out);
    } else if (!("type" in child) || child.type === undefined) {
      // Plain Run (no `type` discriminator).
      collectFootnoteRefsFromRun(child as Run, out);
    } else if (
      child.type === "insertedRun" ||
      child.type === "deletedRun" ||
      child.type === "movedFromRun" ||
      child.type === "movedToRun"
    ) {
      // Tracked-change wrappers carry a single `run` (singular) per
      // ECMA-376 — see `InsertedRun.run`, `DeletedRun.run`, etc.
      collectFootnoteRefsFromRun(child.run, out);
    }
    // BookmarkStart / BookmarkEnd / Comment* / MoveRangeMarker /
    // CustomXmlTrackingMarker carry no runnable text — nothing to
    // collect.
  }
}

function collectFootnoteRefsFromHyperlink(
  link: { readonly children: readonly ParagraphChild[] },
  out: number[]
): void {
  for (const child of link.children) {
    if (!("type" in child) || child.type === undefined) {
      collectFootnoteRefsFromRun(child as Run, out);
    }
  }
}

function collectFootnoteRefsFromRun(run: Run, out: number[]): void {
  if (!run || !Array.isArray(run.content)) {
    return;
  }
  for (const c of run.content) {
    if (c.type === "footnoteRef") {
      out.push(c.id);
    }
  }
}

/**
 * Resolve which header reference to use for a given page within a
 * section, per ECMA-376 §17.10:
 *
 *  - `titlePage === true` and `pageNumber === 1` → the `"first"` reference
 *  - `evenAndOddHeaders === true` (settings) and even page number → `"even"`
 *  - otherwise → the `"default"` reference
 *
 * Each rule falls back to `"default"` (then to the first available ref)
 * if its preferred type isn't declared in the section's references.
 */
function pickHeaderFooterRef(
  refs: readonly { readonly type: string; readonly rId: string }[],
  pageNumber: number,
  pageInSection: number,
  titlePage: boolean,
  evenAndOdd: boolean
): { readonly type: string; readonly rId: string } | undefined {
  const find = (t: string): { readonly type: string; readonly rId: string } | undefined =>
    refs.find(r => r.type === t);

  // `titlePage` is per section — its "first" header belongs to the first page of
  // *that* section. Even/odd is per document, since it follows the printed page
  // number.
  if (titlePage && pageInSection === 1) {
    const first = find("first");
    if (first) {
      return first;
    }
  }
  if (evenAndOdd && pageNumber % 2 === 0) {
    const even = find("even");
    if (even) {
      return even;
    }
  }
  return find("default") ?? refs[0];
}

/**
 * Lay out the paragraphs and tables of the resolved header for a page.
 *
 * Resolution order: first/even/default per `pickHeaderFooterRef`.
 * The header band's local y-axis starts at the section's
 * `pgMar.header` (in pt) below the page top, mirroring Word's
 * "Header from top" setting; renderers consume the resulting layout-y
 * directly as a page-y offset.
 *
 * Tables in header content are laid out with the same `layoutTable`
 * that body content uses, and surfaced via the union type on
 * `LayoutPage.header` so renderers can pick them up alongside
 * paragraphs without a special path.
 */
function layoutHeader(
  doc: DocxDocument,
  pageNumber: number,
  pageInSection: number,
  sectionProps: SectionProperties | undefined,
  geometry: PageGeometry,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): (LayoutParagraph | LayoutTable)[] {
  const refs = sectionProps?.headers;
  if (!refs || refs.length === 0) {
    return [];
  }
  // `titlePage` picks the "first" reference on the first page *of its section*,
  // not of the document.
  const titlePage = sectionProps?.titlePage === true;
  const evenAndOdd = doc.settings?.evenAndOddHeaders === true;
  const ref = pickHeaderFooterRef(refs, pageNumber, pageInSection, titlePage, evenAndOdd);
  if (!ref) {
    return [];
  }
  const part = doc.headers?.get(ref.rId);
  if (!part) {
    return [];
  }
  const headerOffsetPt = geometry.headerOffset;
  return layoutHeaderFooterChildren(
    part.content.children,
    headerOffsetPt,
    geometry,
    options,
    imageMap
  );
}

function layoutFooter(
  doc: DocxDocument,
  pageNumber: number,
  pageInSection: number,
  sectionProps: SectionProperties | undefined,
  geometry: PageGeometry,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): (LayoutParagraph | LayoutTable)[] {
  const refs = sectionProps?.footers;
  if (!refs || refs.length === 0) {
    return [];
  }
  const titlePage = sectionProps?.titlePage === true;
  const evenAndOdd = doc.settings?.evenAndOddHeaders === true;
  const ref = pickHeaderFooterRef(refs, pageNumber, pageInSection, titlePage, evenAndOdd);
  if (!ref) {
    return [];
  }
  const part = doc.footers?.get(ref.rId);
  if (!part) {
    return [];
  }
  // Footer band starts at `pageHeight - pgMar.footer` so layout-y is
  // already a page-absolute coordinate (matching the header path,
  // where `pgMar.header` is the absolute offset of the band from the
  // page top). Renderers consume both bands with the same
  // "treat layout-y as page-y" rule.
  const footerOffsetPt = geometry.height - geometry.footerOffset;
  return layoutHeaderFooterChildren(
    part.content.children,
    footerOffsetPt,
    geometry,
    options,
    imageMap
  );
}

function layoutHeaderFooterChildren(
  children: readonly (Paragraph | Table)[],
  initialCursorY: number,
  geometry: PageGeometry,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): (LayoutParagraph | LayoutTable)[] {
  const out: (LayoutParagraph | LayoutTable)[] = [];
  let cursor = initialCursorY;
  for (let idx = 0; idx < children.length; idx++) {
    const child = children[idx];
    if (child.type === "paragraph") {
      const laid = layoutParagraph(
        child,
        cursor,
        geometry.contentWidth,
        options,
        undefined,
        imageMap
      );
      out.push(laid);
      cursor = laid.rect.y + laid.rect.height;
    } else if (child.type === "table") {
      const laid = layoutTable(child, cursor, geometry.contentWidth, idx, options, imageMap);
      out.push(laid);
      cursor = laid.rect.y + laid.rect.height;
    }
  }
  return out;
}

function computePageGeometry(
  sectionProps: DocxDocument["sectionProperties"],
  override?: PageGeometryOverride
): PageGeometry {
  const widthTwips = sectionProps?.pageSize?.width ?? DEFAULT_PAGE_WIDTH_TWIPS;
  const heightTwips = sectionProps?.pageSize?.height ?? DEFAULT_PAGE_HEIGHT_TWIPS;
  const sectionWidth = twipsToPt(widthTwips);
  const sectionHeight = twipsToPt(heightTwips);
  const sectionMarginTop = twipsToPt(sectionProps?.margins?.top ?? DEFAULT_PAGE_MARGIN_TWIPS);
  const sectionMarginBottom = twipsToPt(sectionProps?.margins?.bottom ?? DEFAULT_PAGE_MARGIN_TWIPS);
  const sectionMarginLeft = twipsToPt(sectionProps?.margins?.left ?? DEFAULT_PAGE_MARGIN_TWIPS);
  const sectionMarginRight = twipsToPt(sectionProps?.margins?.right ?? DEFAULT_PAGE_MARGIN_TWIPS);
  // Header / footer band offsets. Word's default `pgMar.header` /
  // `pgMar.footer` is 720 twips (0.5") — the same default used by the
  // header / footer layout helpers historically.
  const sectionHeaderOffset = twipsToPt(sectionProps?.margins?.header ?? 720);
  const sectionFooterOffset = twipsToPt(sectionProps?.margins?.footer ?? 720);

  // Per-axis override: callers (PDF bridge, custom hosts) may want to
  // pin the page size or margin on one axis without disturbing the
  // others — `pageWidth` doesn't imply overriding margins, etc.
  const width = override?.pageWidth ?? sectionWidth;
  const height = override?.pageHeight ?? sectionHeight;
  const marginTop = override?.marginTop ?? sectionMarginTop;
  const marginBottom = override?.marginBottom ?? sectionMarginBottom;
  const marginLeft = override?.marginLeft ?? sectionMarginLeft;
  const marginRight = override?.marginRight ?? sectionMarginRight;
  const headerOffset = override?.headerMargin ?? sectionHeaderOffset;
  const footerOffset = override?.footerMargin ?? sectionFooterOffset;

  return {
    width,
    height,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    contentWidth: width - marginLeft - marginRight,
    contentHeight: height - marginTop - marginBottom,
    headerOffset,
    footerOffset
  };
}

function computeSectionBreaks(
  layout: LayoutResult,
  itemPage: ReadonlyMap<number, number>
): number[] {
  const breaks: number[] = [0]; // First section starts at page 0
  let prevSection = 0;
  for (let i = 0; i < layout.contentPages.length; i++) {
    const section = layout.contentSections[i];
    if (section > prevSection) {
      // Prefer the page pass 2 actually placed the item on; fall back to the
      // paginator's estimate for an item pass 2 never emitted.
      const page = itemPage.get(i) ?? layout.contentPages[i];
      breaks.push(page - 1);
      prevSection = section;
    }
  }
  return breaks;
}

// =============================================================================
// Internal: Paragraph Layout
// =============================================================================

/** A resolved list marker for a numbered/bulleted paragraph. */
interface ListMarker {
  /** Marker text including trailing spacing (e.g. "•  ", "1.  ", "a.  "). */
  readonly text: string;
  /** Left indent in points for the list level. */
  readonly indentPt: number;
}

/**
 * Resolve list markers for every numbered / bulleted paragraph in the
 * document, in reading order, so ordered-list counters increment correctly
 * across paragraphs (and reset when a lower level reappears). Returns a map
 * keyed by the paragraph object.
 *
 * Markers are derived from `paragraph.properties.numbering` → the matching
 * `NumberingInstance` → its `AbstractNumbering` level definition. Bullet
 * levels emit their symbol; ordered levels emit a counter formatted per the
 * level's `NumberFormat` (decimal / lower-upper letter / lower-upper roman),
 * falling back to decimal for formats we don't render numerically.
 */
/** What a paragraph's neighbours change about its own spacing and decoration. */
interface ContextualSpacing {
  /** Suppress space-before (`w:contextualSpacing`, same style above). */
  readonly before: boolean;
  /** Suppress space-after (`w:contextualSpacing`, same style below). */
  readonly after: boolean;
  /** The paragraph above shares this one's borders and shading. */
  readonly mergeDecorationTop: boolean;
  /** The paragraph below shares this one's borders and shading. */
  readonly mergeDecorationBottom: boolean;
}

/**
 * Resolve `w:contextualSpacing` — "ignore spacing above and below when using
 * identical styles" — for every paragraph in the document.
 *
 * Word suppresses a paragraph's own space-before when the paragraph directly
 * above uses the same style, and its space-after when the one below does. That
 * is what keeps a bulleted list tight while still separating the list as a whole
 * from surrounding body text; Word's `ListParagraph` style sets the flag. The
 * layout engine ignored it, so every list item carried its full spacing and
 * lists rendered looser than in Word.
 *
 * Adjacency is judged among *siblings*, so each table cell, text box and
 * footnote forms its own run of paragraphs, and a non-paragraph block (a nested
 * table, an image frame) between two paragraphs breaks the run.
 */
function computeContextualSpacing(doc: DocxDocument): Map<Paragraph, ContextualSpacing> {
  const out = new Map<Paragraph, ContextualSpacing>();

  /**
   * A paragraph's decoration reduced to a comparable key, or "" for none.
   *
   * Two adjacent paragraphs sharing a key are one decorated block: a two-
   * paragraph block quote is one bar, a code block is one frame.
   */
  const decorationKey = (item: BodyContent | Paragraph | Table | undefined): string => {
    if (!item || item.type !== "paragraph") {
      return "";
    }
    const effective = resolveStyle(doc, item).paragraphProperties;
    const borders = resolveParagraphBorders(effective.borders);
    const fill = resolveShadingFill(effective.shading);
    if (!borders && !fill) {
      return "";
    }
    return JSON.stringify({ borders: borders ?? null, fill: fill ?? null });
  };

  const visit = (items: readonly BodyContent[] | readonly (Paragraph | Table)[]): void => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type === "table") {
        for (const row of item.rows) {
          for (const cell of row.cells) {
            visit(cell.content);
          }
        }
        continue;
      }
      if (item.type !== "paragraph") {
        continue;
      }
      const previous = items[i - 1];
      const next = items[i + 1];

      // Contextual spacing: the flag is inheritable (that is how
      // `ListParagraph` carries it) and compares by style identity.
      const effective = resolveStyle(doc, item).paragraphProperties;
      const styleId = item.properties?.style;
      const sameStyle = (other: (typeof items)[number] | undefined): boolean =>
        other?.type === "paragraph" && other.properties?.style === styleId;
      const contextual = effective.contextualSpacing === true;

      // Decoration runs: a shared bar or frame must not be interrupted by the
      // space between the paragraphs it spans, so the shared edge is not inset.
      const own = decorationKey(item);
      const mergeTop = own !== "" && decorationKey(previous) === own;
      const mergeBottom = own !== "" && decorationKey(next) === own;

      if (!contextual && !mergeTop && !mergeBottom) {
        continue;
      }
      out.set(item, {
        before: contextual && sameStyle(previous),
        after: contextual && sameStyle(next),
        mergeDecorationTop: mergeTop,
        mergeDecorationBottom: mergeBottom
      });
    }
  };

  visit(doc.body);
  return out;
}

function computeListMarkers(doc: DocxDocument): Map<Paragraph, ListMarker> {
  const markers = new Map<Paragraph, ListMarker>();
  const instances = doc.numberingInstances;
  const abstracts = doc.abstractNumberings;
  if (!instances || !abstracts || instances.length === 0 || abstracts.length === 0) {
    return markers;
  }

  const instById = new Map(instances.map(n => [n.numId, n]));
  const absById = new Map(abstracts.map(a => [a.abstractNumId, a]));

  // Per (numId) counters, one slot per level. Counters reset at deeper
  // levels when a shallower level advances.
  const counters = new Map<number, (number | undefined)[]>();
  // numIds whose list was interrupted by non-list content since their last
  // item; the next item with that numId restarts its numbering. This makes
  // two visually separate ordered lists (sharing a numId, separated by a
  // plain paragraph) each start at 1 — matching user expectation rather than
  // running a single continuous sequence.
  const interrupted = new Set<number>();
  // numIds seen at least once, so we know which to mark interrupted.
  const seenNumIds = new Set<number>();

  // Flatten paragraphs into document reading order (descending into tables),
  // so list continuity is judged across the whole body, not per-cell.
  const orderedParagraphs: Paragraph[] = [];
  const walk = (items: readonly BodyContent[] | readonly (Paragraph | Table)[]): void => {
    for (const item of items) {
      if (item.type === "paragraph") {
        orderedParagraphs.push(item);
      } else if (item.type === "table") {
        for (const row of item.rows) {
          for (const cell of row.cells) {
            walk(cell.content);
          }
        }
      }
    }
  };

  const resolveParagraphMarker = (para: Paragraph): void => {
    const numbering = para.properties?.numbering;
    if (!numbering) {
      // Non-list paragraph: any list seen so far is now interrupted, so a
      // later paragraph reusing the same numId restarts its sequence.
      for (const id of seenNumIds) {
        interrupted.add(id);
      }
      return;
    }
    const inst = instById.get(numbering.numId);
    if (!inst) {
      return;
    }
    const abs = absById.get(inst.abstractNumId);
    if (!abs) {
      return;
    }
    const level = numbering.level ?? 0;
    const levelDef =
      inst.overrides?.find(o => o.level === level)?.levelDef ??
      abs.levels.find(l => l.level === level);
    if (!levelDef) {
      return;
    }

    seenNumIds.add(numbering.numId);
    // Indent: prefer the numbering level's own `w:lvl/w:pPr/w:ind`, which is
    // where Word records a list's real geometry (and where any customised
    // list puts it). Only fall back to the conventional half inch per level
    // when the level definition is silent.
    const levelIndent = levelDef.paragraphProperties?.indent?.left;
    const indentPt = levelIndent != null ? twipsToPt(levelIndent) : (level + 1) * 36;

    if (levelDef.format === "bullet") {
      // Bullet symbol. Word authors bullets with Symbol/Wingdings private-use
      // code points (e.g. U+F0B7 ·, U+F0A7 ▪) that PDF standard fonts can't
      // render. Normalize the common ones to WinAnsi-renderable equivalents;
      // fall back to a round bullet when empty or unknown.
      const symbol = normalizeBulletGlyph(levelDef.text);
      markers.set(para, { text: `${symbol}  `, indentPt });
      // A bullet item does not clear the interruption flag for ordered
      // siblings, but it is itself a list item — keep it out of `interrupted`.
      interrupted.delete(numbering.numId);
      return;
    }

    // Ordered list: advance this level's counter and reset deeper levels.
    let levelCounts = counters.get(numbering.numId);
    if (!levelCounts) {
      levelCounts = [];
      counters.set(numbering.numId, levelCounts);
    }
    // If this numId's run was interrupted by non-list content, restart it.
    if (interrupted.has(numbering.numId)) {
      levelCounts.length = 0;
      interrupted.delete(numbering.numId);
    }
    const startOverride = inst.overrides?.find(o => o.level === level)?.startOverride;
    const start = startOverride ?? levelDef.start ?? 1;
    if (levelCounts[level] === undefined) {
      levelCounts[level] = start;
    } else {
      levelCounts[level]! += 1;
    }
    // Reset any deeper levels.
    for (let l = level + 1; l < levelCounts.length; l++) {
      levelCounts[l] = undefined;
    }

    const counter = levelCounts[level]!;
    const numeral = formatListCounter(counter, levelDef.format);
    // Honour the level's `text` template (e.g. "%1.") when present; else
    // fall back to "<n>.".
    const text = levelDef.text ? levelDef.text.replace(/%\d+/g, numeral) : `${numeral}.`;
    markers.set(para, { text: `${text}  `, indentPt });
  };

  walk(doc.body);
  for (const para of orderedParagraphs) {
    resolveParagraphMarker(para);
  }
  return markers;
}

/** Normalize a Word bullet glyph to a WinAnsi-renderable equivalent. */
/**
 * Bullet glyphs this engine can substitute for a level definition's own symbol.
 *
 * A host that has to know which faces a document needs *before* laying it out
 * (the PDF bridge, choosing a fallback font) cannot see these in the source
 * model: Word authors bullets as Symbol/Wingdings private-use code points and
 * the layout rewrites them. Exported so that prediction stays derived from the
 * one function that performs the rewrite rather than a second copy of its table.
 */
export function predictBulletGlyphs(doc: DocxDocument): string[] {
  const out: string[] = [];
  for (const abstract of doc.abstractNumberings ?? []) {
    for (const level of abstract.levels ?? []) {
      if (level.format === "bullet") {
        out.push(normalizeBulletGlyph(level.text));
      }
    }
  }
  return out;
}

function normalizeBulletGlyph(text: string | undefined): string {
  if (!text || text.length === 0) {
    return "\u2022"; // round bullet
  }
  const cp = text.codePointAt(0)!;
  switch (cp) {
    // Symbol-font private-use code points Word emits for default bullets.
    case 0xf0b7: // Symbol "·" → round bullet
    case 0x00b7: // middle dot
      return "\u2022";
    case 0xf0a7: // Symbol filled small square
    case 0xf0a8:
      return "\u25aa";
    case 0xf0fc: // Wingdings check
      return "\u2713";
    default:
      // Already a renderable glyph (e.g. "o", "-", "•") — keep it.
      return text;
  }
}

/** Format an ordered-list counter per its OOXML number format. */
function formatListCounter(n: number, format: NumberFormat): string {
  switch (format) {
    case "lowerLetter":
      return toAlpha(n).toLowerCase();
    case "upperLetter":
      return toAlpha(n).toUpperCase();
    case "lowerRoman":
      return toRoman(n).toLowerCase();
    case "upperRoman":
      return toRoman(n).toUpperCase();
    case "decimalZero":
      return n < 10 ? `0${n}` : String(n);
    default:
      // decimal and any non-numeric/locale formats we don't render.
      return String(n);
  }
}

/** 1 → "A", 26 → "Z", 27 → "AA" (spreadsheet-style alpha). */
function toAlpha(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s || "A";
}

/** Convert a positive integer to a Roman numeral (uppercase). */
function toRoman(n: number): string {
  if (n <= 0) {
    return String(n);
  }
  const table: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let v = n;
  let s = "";
  for (const [val, sym] of table) {
    while (v >= val) {
      s += sym;
      v -= val;
    }
  }
  return s;
}

function layoutParagraph(
  para: Paragraph,
  startY: number,
  contentWidth: number,
  options?: FullLayoutOptions,
  pageContext?: PageLayoutContext,
  imageMap?: ReadonlyMap<string, ImageDef>,
  listMarkers?: ReadonlyMap<Paragraph, ListMarker>,
  styleContext?: StyleResolveContext
): LayoutParagraph {
  const props = para.properties;
  // Resolve the effective paragraph *and* run properties from the style chain
  // (own props → Heading1 → Normal → docDefaults). Reading `para.properties`
  // directly would drop everything a named style contributes — which is where
  // heading spacing, quote indents and default body spacing live, so headings
  // ended up with zero space before/after and collided with their neighbours.
  //
  // `styleContext` carries the paragraph's position inside a table when there
  // is one, which is what lets a table style's conditional formats (header row,
  // banded rows, corner cells) reach the cell's text.
  const resolved = activeDoc ? resolveStyle(activeDoc, para, styleContext) : undefined;
  const styleRunProps = resolved?.runProperties;
  // `resolveStyle` strips `style` from the merged result (it is the selector,
  // not an inherited value); put it back so the heading-level heuristic can
  // still recognise a "Heading2" style name.
  const effective: ParagraphProperties | undefined = resolved
    ? props?.style
      ? { ...resolved.paragraphProperties, style: props.style }
      : resolved.paragraphProperties
    : props;
  const spacing = effective?.spacing;
  // When the style supplies a concrete font size we honour it; only when it
  // does not do we fall back to the heuristic heading scale so headings stay
  // distinct in documents lacking a styles table.
  const styleHasSize = styleRunProps?.size != null;
  const headingScale = styleHasSize ? 1 : getHeadingFontScale(getHeadingLevel(effective));

  // Space before. `w:contextualSpacing` drops it when the paragraph above uses
  // the same style (see `computeContextualSpacing`).
  const contextual = activeContextualSpacing?.get(para);
  let spaceBefore = 0;
  if (contextual?.before) {
    spaceBefore = 0;
  } else if (spacing?.beforeAutoSpacing) {
    spaceBefore = 5;
  } else if (spacing?.before != null) {
    spaceBefore = twipsToPt(spacing.before);
  }

  const indent = effective?.indent;
  // Prefer an explicitly threaded map; fall back to the active layout's
  // shared map so list markers also render inside tables, text boxes, SDTs,
  // footnotes, etc. (whose layoutParagraph calls don't thread it through).
  const marker = (listMarkers ?? activeListMarkers)?.get(para);
  // List paragraphs are indented by their numbering level; the marker text
  // is injected as a leading run below. An explicit paragraph indent (rare on
  // list items) still wins when larger.
  const markerIndentPt = marker ? marker.indentPt : 0;
  const leftIndentPt = Math.max(indent?.left ? twipsToPt(indent.left) : 0, markerIndentPt);
  const alignment = effective?.alignment ?? "left";

  // Collect runs
  const segments = collectParagraphSegments(para, styleRunProps);
  // Inject the list marker (bullet / number) as a leading text run so it
  // renders inline at the start of the first line, inheriting the first
  // text run's formatting (font / size) for visual consistency.
  let markerWidthPt = 0;
  if (marker) {
    let firstRunProps: Run["properties"];
    for (const s of segments) {
      if (isTextSegment(s)) {
        firstRunProps = s.properties;
        break;
      }
    }
    segments.unshift({ text: marker.text, properties: firstRunProps });
    markerWidthPt = measureLayoutText(
      marker.text,
      resolveRunFontName(firstRunProps),
      getRunFontSizePt(firstRunProps) * headingScale,
      options,
      firstRunProps?.bold,
      firstRunProps?.italic
    );
  }

  /**
   * How far the first line starts *left* of the paragraph's left indent.
   *
   * `w:hanging` states it directly. A list gets it implicitly: the marker is
   * injected inline, so hanging it by exactly its own width makes the text that
   * follows land on the left indent — and every wrapped line, which starts at
   * the left indent, then aligns with the text rather than sitting under the
   * marker. Without this a wrapped list item ran back out to the marker's
   * column, which is the single most obvious way a rendered list looks wrong.
   */
  const hangingIndentPt = indent?.hanging ? twipsToPt(indent.hanging) : marker ? markerWidthPt : 0;
  // A hanging indent is a negative first-line indent; the two are mutually
  // exclusive in OOXML, and `w:hanging` wins where both appear.
  const firstLineIndentPt =
    hangingIndentPt > 0 ? -hangingIndentPt : indent?.firstLine ? twipsToPt(indent.firstLine) : 0;

  // Line height. The natural height comes from the paragraph's largest run,
  // so a 24 pt heading gets a 24 pt-sized line box instead of the document
  // default's — without this every paragraph shared one 14.4 pt line height
  // and large text overlapped the text around it.
  const naturalLineHeightPt =
    naturalParagraphLineHeightPt(segments, props, styleRunProps) * headingScale;
  let lineHeightPt = naturalLineHeightPt;
  if (spacing?.line) {
    const rule = spacing.lineRule ?? "auto";
    switch (rule) {
      case "exact":
        lineHeightPt = twipsToPt(spacing.line);
        break;
      case "atLeast":
        lineHeightPt = Math.max(twipsToPt(spacing.line), naturalLineHeightPt);
        break;
      case "auto":
        lineHeightPt = naturalLineHeightPt * (spacing.line / 240);
        break;
    }
  }

  // The text column: the content width less both indents. Ignoring the right
  // indent let a block quote's or code block's right padding reduce nothing, so
  // its text ran to the same right edge as body text.
  const rightIndentForWrapPt = indent?.right ? twipsToPt(indent.right) : 0;
  const fullAvailableWidth = Math.max(1, contentWidth - leftIndentPt - rightIndentForWrapPt);

  // When a page has wrap exclusions (square / tight / through floats)
  // we wrap line-by-line, asking the page context for the widest free
  // slot at the line's actual y-position. Otherwise we use the
  // legacy single-width path which never re-evaluates width across
  // lines — this preserves the existing layout output for documents
  // with no wrap (the overwhelming majority).
  let lines: ParagraphSegment[][];
  let perLineSlots: { xOffset: number; width: number }[] | undefined;
  if (pageContext && pageContext.exclusions.length > 0) {
    const result = wrapSegmentsToLinesWithExclusions(
      segments,
      leftIndentPt,
      firstLineIndentPt,
      headingScale,
      lineHeightPt,
      startY + spaceBefore,
      pageContext,
      options
    );
    lines = result.lines;
    perLineSlots = result.slots;
  } else {
    lines = wrapSegmentsToLines(
      segments,
      fullAvailableWidth,
      firstLineIndentPt,
      headingScale,
      options
    );
  }

  // Build line boxes
  const lineBoxes: LineBox[] = [];
  const lineNoteIds: number[][] = [];
  const lineBookmarks: string[][] = [];
  const pageBreakAfterLines: number[] = [];
  let yOffset = spaceBefore;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineSegments = lines[lineIdx];
    const runs: LineBoxItem[] = [];
    // Resolve the line's effective slot. With exclusions each line has
    // its own usable [xOffset, width]; otherwise we keep the legacy
    // single-width behaviour and place the first line indent.
    const slot = perLineSlots?.[lineIdx] ?? {
      xOffset: 0,
      width: fullAvailableWidth
    };
    const lineLeftIndent = perLineSlots ? slot.xOffset : leftIndentPt;
    const lineAvailableWidth = perLineSlots ? slot.width : fullAvailableWidth;
    let xPos = lineIdx === 0 ? firstLineIndentPt : 0;

    // Calculate line width for alignment, and measure what the line holds so
    // its box can be sized around it: the ink extents of every face on the
    // line, plus the tallest inline image. An inline image sits *on* the
    // baseline, so it pushes the baseline down rather than only making the box
    // taller.
    let lineWidth = 0;
    let lineAscent = 0;
    let lineDescent = 0;
    let maxImageHeight = 0;
    for (const seg of lineSegments) {
      if ("type" in seg && seg.type === "break") {
        // A hard break draws nothing; it only ended the previous line.
        continue;
      }
      if ("type" in seg && seg.type === "image") {
        const w = emuToPt(seg.content.width);
        const h = emuToPt(seg.content.height);
        lineWidth += w;
        if (h > maxImageHeight) {
          maxImageHeight = h;
        }
      } else {
        const fontSize = getRunFontSizePt(seg.properties) * headingScale;
        const fontName = resolveRunFontName(seg.properties);
        lineWidth += measureLayoutText(
          seg.text,
          fontName,
          fontSize,
          options,
          seg.properties?.bold,
          seg.properties?.italic
        );
        const metrics = measureLayoutFontMetrics(
          seg.text,
          fontName,
          fontSize,
          options,
          seg.properties?.bold,
          seg.properties?.italic
        );
        const scriptShift =
          seg.properties?.vertAlign === "superscript"
            ? fontSize * SCRIPT_BASELINE_SHIFT_FACTOR
            : seg.properties?.vertAlign === "subscript"
              ? -fontSize * SCRIPT_BASELINE_SHIFT_FACTOR
              : 0;
        lineAscent = Math.max(lineAscent, metrics.ascent + scriptShift);
        lineDescent = Math.min(lineDescent, metrics.descent + scriptShift);
      }
    }

    // Apply alignment
    if (alignment === "center") {
      xPos = (lineAvailableWidth - lineWidth) / 2;
    } else if (alignment === "right" || alignment === "end") {
      xPos = lineAvailableWidth - lineWidth;
    }

    xPos += lineLeftIndent;

    for (const seg of lineSegments) {
      if ("type" in seg && seg.type === "break") {
        continue;
      }
      if ("type" in seg && seg.type === "image") {
        const widthPt = emuToPt(seg.content.width);
        const heightPt = emuToPt(seg.content.height);
        const img = seg.content.rId ? imageMap?.get(seg.content.rId) : undefined;
        runs.push({
          type: "image",
          x: xPos,
          width: widthPt,
          height: heightPt,
          data: img?.data ?? new Uint8Array(0),
          mimeType: mediaTypeToMime(img?.mediaType),
          altText: seg.content.altText
        });
        xPos += widthPt;
        continue;
      }
      const fontSize = getRunFontSizePt(seg.properties) * headingScale;
      const fontName = resolveRunFontName(seg.properties);
      const segWidth = measureLayoutText(
        seg.text,
        fontName,
        fontSize,
        options,
        seg.properties?.bold,
        seg.properties?.italic
      );

      runs.push({
        text: seg.text,
        x: xPos,
        width: segWidth,
        font: fontName,
        fontSize,
        bold: seg.properties?.bold || undefined,
        italic: seg.properties?.italic || undefined,
        color: resolveColorHex(seg.properties?.color),
        underline: seg.properties?.underline !== undefined ? true : undefined,
        strikethrough: seg.properties?.strike || undefined,
        verticalAlign:
          seg.properties?.vertAlign === "superscript" || seg.properties?.vertAlign === "subscript"
            ? seg.properties.vertAlign
            : undefined
      });

      xPos += segWidth;
    }

    const mappedAlignment =
      alignment === "both"
        ? "justify"
        : alignment === "end"
          ? "right"
          : alignment === "start"
            ? "left"
            : (alignment as "left" | "center" | "right" | "justify");

    const lineMetrics = resolveWordLineMetrics({
      nominalHeight: lineHeightPt,
      ascent: lineAscent,
      descent: lineDescent,
      imageAscent: maxImageHeight,
      exact: spacing?.lineRule === "exact"
    });
    const { baseline: lineBaseline, height: lineBoxHeight } = lineMetrics;

    lineBoxes.push({
      y: yOffset,
      height: lineBoxHeight,
      baseline: lineBaseline,
      runs,
      alignment: mappedAlignment
    });
    // Which notes are referenced from this line, so a page split can hand each
    // note to the page holding its reference.
    lineNoteIds.push(lineSegments.flatMap(seg => (isTextSegment(seg) ? (seg.noteIds ?? []) : [])));
    lineBookmarks.push(
      lineSegments.flatMap(seg => (isTextSegment(seg) ? (seg.bookmarks ?? []) : []))
    );
    if (lineSegments.some(seg => "type" in seg && seg.type === "break" && seg.pageBreak === true)) {
      pageBreakAfterLines.push(lineIdx);
    }

    yOffset += lineBoxHeight;
  }

  // An empty paragraph still occupies a line — except a thematic break, whose
  // whole content *is* its border. Reserving a line for it made a Markdown
  // `---` nearly three times as tall as the `hr` it stands for.
  if (lineBoxes.length === 0 && effective?.thematicBreak !== true) {
    yOffset += lineHeightPt;
  }

  // Space after — suppressed by `w:contextualSpacing` when the paragraph below
  // uses the same style.
  let spaceAfter = 0;
  if (contextual?.after) {
    spaceAfter = 0;
  } else if (spacing?.afterAutoSpacing) {
    spaceAfter = 5;
  } else if (spacing?.after != null) {
    spaceAfter = twipsToPt(spacing.after);
  }

  const totalHeight = yOffset + spaceAfter;

  // Where borders and shading sit relative to `rect`. Word paints them around
  // the *text*, so the space-before and space-after are inset away, and across
  // the indented text column rather than the full content width.
  let borders = resolveParagraphBorders(effective?.borders);
  const backgroundColor = resolveShadingFill(effective?.shading);
  const decorated = borders !== undefined || backgroundColor !== undefined;

  // Adjacent paragraphs sharing a decoration form one block — a two-paragraph
  // block quote is one bar, a fenced code block one frame. The shared edge is
  // not inset (so the bar and the fill run continuously through the space
  // between them) and its horizontal rule is dropped (so no line is drawn
  // across the middle of the block).
  if (borders && (contextual?.mergeDecorationTop || contextual?.mergeDecorationBottom)) {
    const { top, bottom, ...sides } = borders;
    // At an internal boundary the block's own top/bottom rule would cut across
    // the middle of it. `w:between` is the border OOXML defines *for* that
    // boundary; drawn as the lower paragraph's top edge it appears exactly once
    // per boundary. Absent a `w:between`, the boundary is left open.
    const between = resolveBorderEdge(effective?.borders?.between);
    borders = {
      ...sides,
      ...(contextual.mergeDecorationTop ? (between ? { top: between } : {}) : top ? { top } : {}),
      ...(contextual.mergeDecorationBottom ? {} : bottom ? { bottom } : {})
    };
  }

  return {
    type: "paragraph",
    rect: { x: 0, y: startY, width: contentWidth, height: totalHeight },
    lines: lineBoxes,
    ...(borders ? { borders } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(lineNoteIds.some(ids => ids.length > 0) ? { lineNoteIds } : {}),
    ...(lineBookmarks.some(names => names.length > 0) ? { lineBookmarks } : {}),
    ...(pageBreakAfterLines.length > 0 ? { pageBreakAfterLines } : {}),
    ...(decorated
      ? {
          decorationInsets: {
            left: leftIndentPt,
            right: rightIndentForWrapPt,
            top: contextual?.mergeDecorationTop ? 0 : spaceBefore,
            bottom: contextual?.mergeDecorationBottom ? 0 : spaceAfter
          }
        }
      : {}),
    sourceIndex: 0 // overwritten by caller
  };
}

/**
 * Resolve `w:pBdr` to drawable edges, or undefined when nothing is drawn.
 *
 * `w:sz` is in eighths of a point and `w:space` in whole points. A border
 * declared without a size is a hairline, matching how Word renders one.
 */
/**
 * One `w:pBdr` edge as a drawable stroke, or undefined when it draws nothing.
 *
 * `w:sz` is in eighths of a point and `w:space` in whole points. An edge declared
 * without a size is a hairline, which is how Word renders one.
 */
function resolveBorderEdge(b: Border | undefined): LayoutBorderEdge | undefined {
  if (!b || b.style === "none" || b.style === "nil") {
    return undefined;
  }
  const width = b.size != null ? b.size / 8 : 0.5;
  const color = !b.color || b.color === "auto" ? "000000" : b.color.replace(/^#/, "");
  return { width: Math.max(0.25, width), color, space: b.space ?? 0 };
}

function resolveParagraphBorders(borders: ParagraphBorders | undefined): LayoutBorders | undefined {
  if (!borders) {
    return undefined;
  }
  const top = resolveBorderEdge(borders.top);
  const bottom = resolveBorderEdge(borders.bottom);
  // `w:bar` is a vertical bar down the paragraph's leading edge — the same
  // stroke as `w:left` for a left-to-right layout.
  const left = resolveBorderEdge(borders.left ?? borders.bar);
  const right = resolveBorderEdge(borders.right);
  if (!top && !bottom && !left && !right) {
    return undefined;
  }
  return {
    ...(top ? { top } : {}),
    ...(bottom ? { bottom } : {}),
    ...(left ? { left } : {}),
    ...(right ? { right } : {})
  };
}

// =============================================================================
// Internal: Table Layout
// =============================================================================

function layoutTable(
  table: Table,
  startY: number,
  contentWidth: number,
  sourceIndex: number,
  options?: FullLayoutOptions,
  imageMap?: ReadonlyMap<string, ImageDef>
): LayoutTable {
  const numCols = table.rows.length > 0 ? table.rows[0].cells.length : 0;

  // Resolve per-column widths (in points). Prefer the table's explicit
  // `columnWidths` (twips) — populated e.g. by the Excel→Word bridge —
  // scaled to fit the available content width so a table authored wider
  // than the page still renders proportionally. Fall back to equal
  // division when no column widths are declared. This mirrors the
  // sister layout engine in `layout.ts` (which also honours
  // `columnWidths` + `gridSpan`).
  const colWidths = resolveColumnWidthsPt(table, numCols, contentWidth);
  // Prefix sums so a cell at column `ci` starts at `colOffsets[ci]` and
  // a `gridSpan` cell can sum the widths it covers.
  const colOffsets: number[] = [0];
  for (let i = 0; i < colWidths.length; i++) {
    colOffsets.push(colOffsets[i] + colWidths[i]);
  }

  const cells: LayoutTableCell[] = [];
  let cursorY = 0;

  // Table-style context, shared by every cell in this table. A table style's
  // conditional formats (`firstRow`, `lastRow`, banding, corner cells) are
  // resolved per cell position, so each cell's paragraphs need to know where
  // they sit. Without this, Word's built-in table styles lost their bold header
  // row and banded shading in the output.
  const totalRows = table.rows.length;
  const tableStyleId = table.properties?.style;
  const tblLook = table.properties?.look;

  for (let ri = 0; ri < table.rows.length; ri++) {
    const row = table.rows[ri];
    let maxRowHeight = DEFAULT_FONT_SIZE_PT * 1.5; // minimum row height
    // This row's cells with the `w:vAlign` each asked for. A cell is laid out
    // from its top margin because its final height is not known until every
    // cell in the row has been measured; the alignment is applied once the row
    // height settles, below.
    const rowCells: Array<{
      cell: LayoutTableCell;
      verticalAlign: VerticalCellAlign | undefined;
    }> = [];
    // `w:trHeight`: `exact` fixes the row height outright, `atLeast` raises the
    // floor. Ignoring it let a table with declared row heights render squashed —
    // and, now that this pass owns pagination, shifted everything after it.
    const declaredHeight = row.properties?.height;
    const declaredHeightPt =
      declaredHeight?.value != null ? twipsToPt(declaredHeight.value) : undefined;
    if (declaredHeightPt !== undefined && declaredHeight?.rule !== "auto") {
      maxRowHeight = Math.max(maxRowHeight, declaredHeightPt);
    }

    // Track the grid column each cell occupies, honouring gridSpan so a
    // 2-wide cell pushes the next cell two grid columns to the right.
    let gridCol = 0;
    for (let ci = 0; ci < row.cells.length; ci++) {
      const cell = row.cells[ci];
      const span = Math.max(1, cell.properties?.gridSpan ?? 1);
      const startCol = Math.min(gridCol, colWidths.length - 1);
      const endCol = Math.min(gridCol + span, colWidths.length);
      const cellX = colOffsets[startCol] ?? 0;
      const cellWidth = (colOffsets[endCol] ?? contentWidth) - cellX;
      const cellContent: (LayoutParagraph | LayoutTable)[] = [];
      // Word's cell margins (`w:tblCellMar` / `w:tcMar`) inset the content from
      // all four borders. Both the horizontal inset and the reduced wrap width
      // matter: subtracting the margins from the available width alone (as this
      // did) left every cell's text flush against its left border.
      const margins = resolveCellMarginsPt(table.properties, cell.properties);
      const innerWidth = Math.max(1, cellWidth - margins.left - margins.right);
      let cellCursorY = margins.top;
      const cellStyleContext: StyleResolveContext | undefined = tableStyleId
        ? {
            tableContext: {
              tableStyleId,
              tblLook,
              rowIndex: ri,
              colIndex: startCol,
              totalRows,
              totalCols: Math.max(numCols, colWidths.length),
              rowBandSize: table.properties?.rowBandSize,
              colBandSize: table.properties?.colBandSize
            }
          }
        : undefined;

      for (const block of cell.content) {
        if (block.type === "paragraph") {
          const laid = layoutParagraph(
            block,
            cellCursorY,
            innerWidth,
            options,
            undefined,
            imageMap,
            undefined,
            cellStyleContext
          );
          // Shift the content right by the left margin. Renderers position a
          // cell's content at `cell.rect.x + inner.rect.x`, so the inset has to
          // live in the block's own origin.
          cellContent.push({
            ...laid,
            rect: { ...laid.rect, x: laid.rect.x + margins.left },
            sourceIndex: -1
          });
          cellCursorY = laid.rect.y + laid.rect.height;
        } else if (block.type === "table") {
          // Nested table: lay it out within the cell's content width and
          // stack it below preceding content. The PDF/SVG renderers
          // already translate nested `LayoutTable` rects by the cell
          // origin, so emitting it here is all that's needed.
          const laidNested = layoutTable(block, cellCursorY, innerWidth, -1, options, imageMap);
          cellContent.push({
            ...laidNested,
            rect: { ...laidNested.rect, x: laidNested.rect.x + margins.left }
          });
          cellCursorY = laidNested.rect.y + laidNested.rect.height;
        }
      }

      const cellHeight = cellCursorY + margins.bottom;
      if (cellHeight > maxRowHeight) {
        maxRowHeight = cellHeight;
      }

      // Background shading: cell `w:shd` → table `w:shd` → the table style's
      // conditional formats (header band, row stripes, corner cells). Resolved
      // through the shared helper so this and the SVG renderer paint the same
      // colour — the field exists on `LayoutTableCell` and both renderers draw
      // it, but nothing ever filled it in, so every table came out white.
      const backgroundColor = activeDoc
        ? resolveTableCellFill(activeDoc, table, cell, {
            rowIndex: ri,
            colIndex: startCol,
            totalRows,
            totalCols: Math.max(numCols, colWidths.length)
          })
        : undefined;

      cells.push({
        // Table-relative, like `x`. Renderers add the table's origin to both;
        // emitting an absolute `y` here made them add it twice.
        rect: { x: cellX, y: cursorY, width: cellWidth, height: cellHeight },
        row: ri,
        col: ci,
        content: cellContent,
        ...(backgroundColor ? { backgroundColor } : {}),
        borders: resolveCellBorders(
          table.properties?.borders,
          cell.properties?.borders,
          ri === 0,
          ri === table.rows.length - 1,
          startCol === 0,
          endCol >= colWidths.length
        )
      });
      rowCells.push({
        cell: cells[cells.length - 1],
        verticalAlign: cell.properties?.verticalAlign
      });

      gridCol += span;
    }

    // An `exact` rule clamps the row even when its content is taller; Word
    // clips the overflow rather than growing the row.
    if (declaredHeightPt !== undefined && declaredHeight?.rule === "exact") {
      maxRowHeight = declaredHeightPt;
    }

    // Normalize cell heights to row max, then honour `w:vAlign`: a cell was
    // measured from its top margin, so anything but `top` has to move its
    // content down into the slack the row's tallest cell created.
    for (const { cell: c, verticalAlign } of rowCells) {
      // Only a cell whose content is genuinely taller than the settled row needs
      // bounding, which happens when an `exact` rule shortened the row. Marking
      // every exact cell would make renderers emit a clip that changes nothing.
      if (c.rect.height > maxRowHeight) {
        (c as { clipToBounds?: boolean }).clipToBounds = true;
      }
      shiftCellContentForVerticalAlign(c, verticalAlign, maxRowHeight);
      (c as { rect: { height: number } }).rect.height = maxRowHeight;
    }

    cursorY += maxRowHeight;
  }

  return {
    type: "table",
    rect: { x: 0, y: startY, width: contentWidth, height: cursorY },
    cells,
    sourceIndex
  };
}

/**
 * Move a cell's content down to satisfy `w:vAlign` once the row's height is
 * known.
 *
 * A cell is laid out top-down from its own top margin, because its final height
 * depends on the tallest cell in the row and that is not known until the whole
 * row has been measured. `center` and `bottom` therefore mean "translate the
 * finished content into the slack that appeared". Only the top-level blocks move:
 * a paragraph's lines are positioned relative to the paragraph, and a nested
 * table's cells relative to that table, so both follow their own origin.
 *
 * The cell's height at this point is still its natural content height — the
 * caller normalises it to the row height straight after.
 */
function shiftCellContentForVerticalAlign(
  cell: LayoutTableCell,
  verticalAlign: VerticalCellAlign | undefined,
  rowHeight: number
): void {
  if (!verticalAlign || verticalAlign === "top") {
    return;
  }
  // A `w:trHeight` of `exact` can leave the row shorter than its content, in
  // which case there is nothing to distribute and Word clips instead.
  const slack = rowHeight - cell.rect.height;
  if (slack <= 0) {
    return;
  }
  const shift = verticalAlign === "center" ? slack / 2 : slack;
  for (const block of cell.content) {
    (block as { rect: { y: number } }).rect.y += shift;
  }
}

/**
 * Resolve the four visible borders of a table cell into layout-model form
 * (`{ width: pt, color: hex }`). A cell's own border wins; otherwise the
 * table-level border applies — outer edges use `top/left/bottom/right`, inner
 * edges use `insideH/insideV`. OOXML border `size` is in eighths of a point.
 */
function resolveCellBorders(
  tableBorders: TableBorders | undefined,
  cellBorders: TableBorders | undefined,
  isTopRow: boolean,
  isBottomRow: boolean,
  isLeftCol: boolean,
  isRightCol: boolean
): LayoutTableCell["borders"] {
  const edge = (
    cellEdge: Border | undefined,
    outerEdge: Border | undefined,
    innerEdge: Border | undefined,
    isOuter: boolean
  ): { width: number; color: string } | undefined => {
    const b = cellEdge ?? (isOuter ? outerEdge : innerEdge);
    if (!b || b.style === "none" || b.style === "nil") {
      return undefined;
    }
    // `size` is in eighths of a point; default to a hairline (0.5pt) when
    // a border is declared without an explicit size.
    const width = b.size != null ? b.size / 8 : 0.5;
    const color = !b.color || b.color === "auto" ? "000000" : b.color;
    return { width: Math.max(0.25, width), color };
  };

  // `border-collapse`: every interior rule is shared by two cells and must be
  // drawn once. Each cell owns its bottom and right edges (plus the table's
  // outer top and left); the neighbour's coincident top/left is dropped unless
  // that cell declares one itself. Emitting both stroked every interior rule
  // twice, and the second stroke overpainted the first — a table style's darker
  // header rule came out in the lighter body-rule colour.
  const top = isTopRow
    ? edge(cellBorders?.top, tableBorders?.top, tableBorders?.insideH, true)
    : edge(cellBorders?.top, undefined, undefined, false);
  const bottom = edge(
    cellBorders?.bottom,
    tableBorders?.bottom,
    tableBorders?.insideH,
    isBottomRow
  );
  const left = isLeftCol
    ? edge(cellBorders?.left, tableBorders?.left, tableBorders?.insideV, true)
    : edge(cellBorders?.left, undefined, undefined, false);
  const right = edge(cellBorders?.right, tableBorders?.right, tableBorders?.insideV, isRightCol);

  if (!top && !bottom && !left && !right) {
    return undefined;
  }
  return {
    ...(top ? { top } : {}),
    ...(bottom ? { bottom } : {}),
    ...(left ? { left } : {}),
    ...(right ? { right } : {})
  };
}

/**
 * A cell's effective inner margins, converted to points.
 *
 * The cascade itself (cell `w:tcMar` → table `w:tblCellMar` → Word's defaults)
 * lives in `layout-constants` so the paginator derives exactly the same numbers;
 * a hardcoded guess in each was how the two passes came to disagree about how
 * tall every table row is.
 */
function resolveCellMarginsPt(
  tableProps: TableProperties | undefined,
  cellProps: TableCellProperties | undefined
): { top: number; right: number; bottom: number; left: number } {
  const twips = resolveCellMarginsTwips(tableProps, cellProps);
  return {
    top: twipsToPt(twips.top),
    right: twipsToPt(twips.right),
    bottom: twipsToPt(twips.bottom),
    left: twipsToPt(twips.left)
  };
}

/**
 * Resolve a table's per-column widths in points.
 *
 * If `table.columnWidths` (twips) is present and covers all columns, it
 * is used and proportionally scaled to fit `contentWidth` (so a table
 * authored wider than the page shrinks to fit rather than overflowing).
 * Otherwise the content width is divided equally among the columns.
 */
function resolveColumnWidthsPt(table: Table, numCols: number, contentWidth: number): number[] {
  if (numCols <= 0) {
    return [];
  }
  const declared = table.columnWidths;
  if (declared && declared.length >= numCols) {
    const pts = declared.slice(0, numCols).map(twipsToPt);
    const total = pts.reduce((a, b) => a + b, 0);
    if (total > 0) {
      // Scale to fit the content width (shrink overflow, expand
      // under-wide tables to use the full measure — matching how Word
      // distributes a table set to a percentage / auto width).
      const scale = contentWidth / total;
      return pts.map(w => w * scale);
    }
  }
  const equal = contentWidth / numCols;
  return new Array(numCols).fill(equal);
}

// =============================================================================
// Internal: Text Helpers
// =============================================================================

interface TextSegment {
  readonly type?: undefined;
  readonly text: string;
  readonly properties: Run["properties"];
  /**
   * Footnote / endnote ids whose reference mark this segment *is*.
   *
   * Carried through wrapping so the paragraph can report which line each note is
   * referenced from. That is what lets a paragraph split across a page boundary
   * hand each note to the page its reference actually landed on.
   */
  readonly noteIds?: readonly number[];
  /**
   * Bookmark names that start at this point in the paragraph.
   *
   * Carried through wrapping for the same reason as `noteIds`: a bookmark in the
   * part of a paragraph that spills onto the next page belongs to that page, and
   * the only way to know is to see which line its marker landed on.
   */
  readonly bookmarks?: readonly string[];
}

/**
 * Inline image segment within a paragraph. Carries the source
 * `InlineImageContent` so the wrap engine can treat it as an
 * unbreakable atom (own width / height in EMU) and the renderer can
 * pull bytes from `imageMap` later.
 */
interface ImageSegment {
  readonly type: "image";
  readonly content: InlineImageContent;
  /** Optional run properties the image inherits (color, etc.). */
  readonly properties?: Run["properties"];
}

/**
 * A hard line break (`<w:br/>`).
 *
 * It has to be its own token rather than a `"\n"` inside a text segment: the
 * wrap engines split text on `/\s+/`, which swallowed the newline as ordinary
 * whitespace, so every hard break vanished — a fenced code block collapsed onto
 * one line and Word's Shift+Enter did nothing.
 */
interface BreakSegment {
  readonly type: "break";
  /** Run properties the break inherits, so it can size an empty line. */
  readonly properties?: Run["properties"];
  /**
   * A `w:br w:type="page"` rather than a line break.
   *
   * It ends the line like any hard break, but it also ends the *page*. Treating
   * one as a plain line break — and separately telling the paginator to move the
   * whole paragraph down — put the text before the break on the wrong page.
   */
  readonly pageBreak?: boolean;
}

/**
 * Paragraph-level token: a text segment, an inline image, or a hard break.
 * Returned by `collectParagraphSegments` so wrap algorithms can
 * thread images through without losing them.
 */
type ParagraphSegment = TextSegment | ImageSegment | BreakSegment;

/** Whether a segment carries drawable text (as opposed to an image or a break). */
function isTextSegment(seg: ParagraphSegment): seg is TextSegment {
  return !("type" in seg) || seg.type === undefined;
}

/**
 * Walk a paragraph's children and emit a flat sequence of paragraph
 * segments — text runs preserve their formatting; inline images become
 * dedicated `ImageSegment` tokens so the wrap engine treats them as
 * unbreakable atoms positioned in document order. Hyperlinks are
 * descended into; bookmark / comment / track-change wrappers are
 * ignored for layout purposes.
 */
function collectParagraphSegments(
  para: Paragraph,
  styleRunProps: Run["properties"] | undefined
): ParagraphSegment[] {
  const segments: ParagraphSegment[] = [];
  for (const child of para.children) {
    if (isRun(child)) {
      pushRunSegments(child, segments, effectiveRunProps(child, styleRunProps));
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        pushRunSegments(run, segments, effectiveRunProps(run, styleRunProps));
      }
    } else if ("type" in child && child.type === "bookmarkStart" && "name" in child) {
      // An empty marker segment: it draws nothing, but it records the position so
      // a split can tell which page the bookmark ended up on.
      segments.push({ text: "", properties: undefined, bookmarks: [child.name] });
    }
  }
  return segments;
}

/**
 * A run's effective formatting: document defaults → paragraph style → the
 * run's own character style chain (`w:rStyle`) → its direct properties.
 *
 * `resolveRunStyle` implements exactly that precedence. Consulting only the
 * paragraph style made every *character* style invisible to layout — Word's
 * `Strong`, `Emphasis`, `Hyperlink` and `Code Char` among them — so a `Strong`
 * run was measured and drawn at body weight, and a run whose font size came
 * from a character style was measured with the wrong metrics and given a line
 * box sized for body text.
 *
 * The `run.properties.style` guard keeps the common case (no character style)
 * on the cheap object-spread path.
 */
function effectiveRunProps(
  run: Run,
  styleRunProps: Run["properties"] | undefined
): Run["properties"] {
  if (activeDoc && run.properties?.style) {
    return resolveRunStyle(activeDoc, run, styleRunProps).runProperties;
  }
  const own = run.properties;
  if (!styleRunProps) {
    return own;
  }
  return own ? { ...styleRunProps, ...own } : styleRunProps;
}

/**
 * Emit `ParagraphSegment` tokens for a single run, preserving the
 * relative order of text fragments and inline images. Consecutive
 * text-bearing entries are coalesced into one `TextSegment` so the
 * wrap engine sees fewer atoms.
 *
 * `properties` is the run's *effective* formatting (see `effectiveRunProps`),
 * not `run.properties` — every segment must carry the resolved values so
 * measurement, line height and drawing all agree.
 */
function pushRunSegments(run: Run, out: ParagraphSegment[], properties: Run["properties"]): void {
  let pending = "";
  const flush = () => {
    if (pending.length > 0) {
      out.push({ text: pending, properties });
      pending = "";
    }
  };
  for (const item of run.content) {
    if (item.type === "text") {
      pending += item.text;
    } else if (item.type === "tab") {
      pending += "    ";
    } else if (item.type === "break") {
      // A hard break ends the current line; see `BreakSegment`.
      flush();
      const isPageBreak = (item as { breakType?: string }).breakType === "page";
      out.push({ type: "break", properties, ...(isPageBreak ? { pageBreak: true } : {}) });
    } else if (item.type === "image") {
      flush();
      out.push({ type: "image", content: item, properties });
    } else if (item.type === "footnoteRef" || item.type === "endnoteRef") {
      // The reference mark itself. Without it a note printed at the foot of the
      // page with nothing in the text pointing at it — and, because the mark was
      // absent from the line boxes, there was no way to tell which page a
      // reference had landed on when its paragraph was split.
      flush();
      const mark = noteMarkFor(item.type, item.id);
      if (mark.length > 0) {
        out.push({ text: mark, properties, noteIds: [item.id] });
      }
    }
  }
  flush();
}

/**
 * The text of a note's reference mark: its position among the document's notes,
 * numbered from 1 as Word does by default.
 *
 * Ids at or below zero are the separator and continuation pseudo-notes ECMA-376
 * stores alongside the real ones; they are never referenced from the text.
 */
function noteMarkFor(kind: "footnoteRef" | "endnoteRef", id: number): string {
  const notes = kind === "footnoteRef" ? activeDoc?.footnotes : activeDoc?.endnotes;
  if (!notes) {
    return "";
  }
  const numbered = notes.filter(n => n.id > 0);
  const index = numbered.findIndex(n => n.id === id);
  return index >= 0 ? String(index + 1) : "";
}

/**
 * Wrap a paragraph's text segments into lines whose available widths
 * vary based on per-line wrap exclusions (square / tight / through
 * floats). Word-level break points only — character-level shaping is
 * out of scope for the layout engine.
 *
 * Returns both the per-line `TextSegment[]` and a parallel array of
 * `{ xOffset, width }` describing where each line is placed within
 * the content area. Callers use the slot to set per-line indent /
 * available width for alignment.
 */
/**
 * A unit of wrapping: a word, a run of whitespace, an inline image or a hard
 * break, carrying its measured width and whether a line may break before it.
 */
interface WrapAtom {
  readonly kind: "word" | "space" | "image" | "break";
  /** Measured width in points. Zero for a break and for a marker segment. */
  readonly width: number;
  /**
   * There is no break opportunity between this atom and the one before it.
   *
   * A line may break at whitespace, and after a hard break — nowhere else. Two
   * words that meet directly are one unbreakable cluster even when they came
   * from different runs, which is exactly what an inline code span and the
   * punctuation beside it are: `` `sybase.ts`, `` is two runs and one word.
   * Treating every run boundary as a break opportunity instead put that comma
   * alone at the head of the next line, and split `bridge (` from the code span
   * it had just opened.
   */
  readonly glued: boolean;
  /** Text of a word or space atom; empty for an image, a break or a marker. */
  readonly text: string;
  /**
   * The segment this atom came from, so reassembly keeps its run properties and
   * carries its note ids and bookmarks onto the line the atom landed on.
   */
  readonly segment: ParagraphSegment;
  /** Measurer for this atom's formatting, for a mid-word split. */
  readonly measure: (text: string) => number;
}

/** Measurer for atoms that carry no text. */
const MEASURE_NOTHING = (): number => 0;

/**
 * Split a paragraph's segments into wrap atoms.
 *
 * One tokenizer serves both wrappers below. They differ in how a line's width
 * is chosen — a fixed measure, or a slot between floats — not in what a line is
 * made of, and while each had its own tokenizer the two could disagree about
 * where a break was allowed.
 */
function tokenizeSegments(
  segments: readonly ParagraphSegment[],
  headingScale: number,
  options: FullLayoutOptions | undefined
): WrapAtom[] {
  const atoms: WrapAtom[] = [];
  // One memoised measurer per distinct formatting rather than per segment: a
  // paragraph of many short runs shares a handful of faces between them.
  const measurers = new Map<string, (text: string) => number>();
  const measurerFor = (properties: Run["properties"]): ((text: string) => number) => {
    const fontSize = getRunFontSizePt(properties) * headingScale;
    const fontName = resolveRunFontName(properties);
    const bold = properties?.bold === true;
    const italic = properties?.italic === true;
    const key = `${fontName}|${fontSize}|${bold ? "b" : ""}${italic ? "i" : ""}`;
    let measure = measurers.get(key);
    if (measure === undefined) {
      measure = memoizedWordMeasure(fontName, fontSize, options, bold, italic);
      measurers.set(key, measure);
    }
    return measure;
  };
  /** Whether an atom pushed now would be glued to the one before it. */
  const gluedToPrevious = (): boolean => {
    const previous = atoms[atoms.length - 1];
    return previous !== undefined && previous.kind !== "space" && previous.kind !== "break";
  };

  for (const segment of segments) {
    if ("type" in segment && segment.type === "break") {
      atoms.push({
        kind: "break",
        width: 0,
        glued: false,
        text: "",
        segment,
        measure: MEASURE_NOTHING
      });
      continue;
    }
    if ("type" in segment && segment.type === "image") {
      atoms.push({
        kind: "image",
        width: emuToPt(segment.content.width),
        glued: gluedToPrevious(),
        text: "",
        segment,
        measure: MEASURE_NOTHING
      });
      continue;
    }
    const measure = measurerFor(segment.properties);
    if (segment.text.length === 0) {
      // A marker segment draws nothing, but a bookmark or footnote reference it
      // carries has a position — so it travels with the word it sits inside
      // rather than opening a break opportunity of its own.
      atoms.push({ kind: "word", width: 0, glued: gluedToPrevious(), text: "", segment, measure });
      continue;
    }
    for (const token of segment.text.split(/(\s+)/)) {
      if (token.length === 0) {
        continue;
      }
      const isSpace = /^\s/.test(token);
      atoms.push({
        kind: isSpace ? "space" : "word",
        width: measure(token),
        glued: isSpace ? false : gluedToPrevious(),
        text: token,
        segment,
        measure
      });
    }
  }
  return atoms;
}

/** Whether an atom is a `w:br w:type="page"` (see `BreakSegment.pageBreak`). */
function isPageBreakAtom(atom: WrapAtom): boolean {
  const segment = atom.segment;
  return "type" in segment && segment.type === "break" && segment.pageBreak === true;
}

/**
 * How many atoms at the end of `placed` belong to the same unbreakable cluster
 * as `next`, and therefore have to move down with it.
 *
 * Zero when `next` may legally open a line, and zero when the cluster is the
 * whole line: a cluster wider than the measure has to break somewhere, and the
 * boundary already reached is as good a place as any.
 */
function gluedTailLength(placed: readonly WrapAtom[], next: WrapAtom): number {
  if (!next.glued) {
    return 0;
  }
  let count = 0;
  while (count < placed.length) {
    const atom = placed[placed.length - 1 - count];
    count++;
    if (!atom.glued) {
      break;
    }
  }
  return count >= placed.length ? 0 : count;
}

/**
 * Turn a line's atoms back into paragraph segments.
 *
 * Consecutive atoms from the same source segment merge, so a run that arrived
 * whole leaves whole: one segment per atom would make the renderer emit a
 * separately positioned string per word, re-adding by hand the spacing the wrap
 * had just measured.
 */
function reassembleLine(atoms: readonly WrapAtom[]): ParagraphSegment[] {
  const out: ParagraphSegment[] = [];
  let source: ParagraphSegment | undefined;
  let text = "";
  const flushText = (): void => {
    if (source !== undefined && isTextSegment(source)) {
      out.push(text === source.text ? source : { ...source, text });
    }
    source = undefined;
    text = "";
  };
  for (const atom of atoms) {
    if (atom.kind === "break" || atom.kind === "image") {
      flushText();
      out.push(atom.segment);
      continue;
    }
    if (atom.segment !== source) {
      flushText();
      source = atom.segment;
    }
    text += atom.text;
  }
  flushText();

  // Trailing spaces are invisible in left-aligned text but they widen the line
  // for centring and right-alignment, and they leave the paragraph's measured
  // width wrong.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!isTextSegment(last)) {
      break;
    }
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed === last.text) {
      break;
    }
    out.pop();
    if (trimmed.length > 0) {
      out.push({ ...last, text: trimmed });
      break;
    }
    // The segment drew nothing, but a bookmark or note reference it carries
    // still has a position on this line.
    if (last.noteIds !== undefined || last.bookmarks !== undefined) {
      out.push({ ...last, text: "" });
      break;
    }
  }
  return out;
}

function wrapSegmentsToLinesWithExclusions(
  segments: ParagraphSegment[],
  leftIndentPt: number,
  firstLineIndentPt: number,
  headingScale: number,
  lineHeightPt: number,
  paragraphTopPageY: number,
  pageContext: PageLayoutContext,
  options: FullLayoutOptions | undefined
): { lines: ParagraphSegment[][]; slots: { xOffset: number; width: number }[] } {
  const atoms = tokenizeSegments(segments, headingScale, options);
  const lines: ParagraphSegment[][] = [];
  const slots: { xOffset: number; width: number }[] = [];

  if (atoms.length === 0) {
    return { lines, slots };
  }

  let cursor = 0;
  let lineIdx = 0;
  // The first line of the paragraph is not the result of a wrap, so its leading
  // whitespace is the author's.
  let openedByWrap = false;
  while (cursor < atoms.length) {
    const lineY = paragraphTopPageY + lineIdx * lineHeightPt;
    const slot = availableSlotForLine(pageContext, lineY, lineHeightPt);

    // The first line of a paragraph may carry an extra `firstLineIndent`
    // (from `<w:ind firstLine="…"/>`) which subtracts from the usable
    // width on that line only. Subsequent lines use the full slot width
    // (offset by the paragraph's `leftIndentPt`, which is applied by
    // the caller's run x-positioning logic, not here).
    const indentForThisLine = lineIdx === 0 ? firstLineIndentPt : 0;
    let usable = slot.width - indentForThisLine;
    let lineXOffset = slot.xOffset + indentForThisLine;

    // Also subtract the paragraph's own leftIndentPt (which the legacy
    // path applies through `availableWidth = contentWidth -
    // leftIndentPt`). We mirror that here so wrap behaviour matches
    // when no exclusion is in play.
    if (slot.xOffset === 0 && leftIndentPt > 0) {
      usable -= leftIndentPt;
      lineXOffset += leftIndentPt;
    }

    if (usable <= 0) {
      // Pathological — the line is fully blocked or narrower than the
      // first-line indent. Skip the y position by advancing one line
      // height; placing zero-content lines indefinitely is worse than
      // leaving a small visual gap.
      lines.push([]);
      slots.push({ xOffset: lineXOffset, width: Math.max(0, usable) });
      lineIdx++;
      // Re-evaluate without retrying same atoms (no progress -> bail
      // after a sane number of retries to avoid infinite loops on a
      // degenerate page).
      if (lineIdx > 1000) {
        break;
      }
      continue;
    }

    // Whitespace that opens a *wrapped* line is dropped — it is the separator
    // the break consumed. After a hard break it is the author's (a code block's
    // indentation), so it stays.
    if (openedByWrap && atoms[cursor].kind === "space") {
      cursor++;
      if (cursor >= atoms.length) {
        break;
      }
    }
    openedByWrap = true;

    const lineAtoms: WrapAtom[] = [];
    let lineWidth = 0;
    // Every pass consumes an atom, shortens one, or closes a line that already
    // holds content, so this terminates.
    while (cursor < atoms.length) {
      const atom = atoms[cursor];
      if (atom.kind === "break") {
        // A leading page break is a break-before and leaves no blank line —
        // see the sister case in `wrapSegmentsToLines`.
        if (isPageBreakAtom(atom) && lines.length === 0 && lineAtoms.length === 0) {
          cursor++;
          openedByWrap = false;
          continue;
        }
        // A hard break closes this line even though there is room left, and
        // whatever follows keeps its leading whitespace. Kept on the line so a
        // page break's position survives (see `BreakSegment.pageBreak`).
        lineAtoms.push(atom);
        cursor++;
        openedByWrap = false;
        break;
      }
      if (lineWidth + atom.width <= usable) {
        lineAtoms.push(atom);
        lineWidth += atom.width;
        cursor++;
        continue;
      }
      // The atom overflows. Give back the cluster it belongs to, so the whole
      // cluster moves down together rather than breaking at a run boundary.
      const retreat = gluedTailLength(lineAtoms, atom);
      if (retreat > 0) {
        let keptWidth = lineWidth;
        for (let i = 0; i < retreat; i++) {
          keptWidth -= lineAtoms[lineAtoms.length - 1 - i].width;
        }
        if (keptWidth > 0) {
          lineAtoms.length -= retreat;
          cursor -= retreat;
          lineWidth = keptWidth;
          break;
        }
      }
      if (lineWidth > 0) {
        // Something is already on the line — try again on a fresh one.
        break;
      }
      // Alone on the line and still too wide: break inside the word, the way
      // CSS `overflow-wrap: break-word` does. An image is left whole — there is
      // nothing to break — and overflows as Word lets it.
      if (atom.kind === "word" && atom.text.length > 0) {
        const { head, tail } = splitTextToFit(atom.text, atom.measure, usable);
        if (tail.length > 0) {
          // Replace the atom with its remainder so the next line continues
          // from the break point.
          atoms[cursor] = { ...atom, text: tail, width: atom.measure(tail), glued: true };
          const headWidth = atom.measure(head);
          lineAtoms.push({ ...atom, text: head, width: headWidth });
          lineWidth += headWidth;
          break;
        }
      }
      lineAtoms.push(atom);
      lineWidth += atom.width;
      cursor++;
    }

    lines.push(reassembleLine(lineAtoms));
    slots.push({ xOffset: lineXOffset, width: usable });
    lineIdx++;

    if (lineIdx > 100_000) {
      // Defensive — degenerate inputs shouldn't loop the engine.
      break;
    }
  }

  return { lines, slots };
}

/**
 * A measuring function for one run's formatting, caching short strings.
 *
 * Character-level breaking measures the same code points repeatedly — a CJK
 * paragraph reuses a few hundred distinct glyphs across thousands of positions —
 * so the cache turns that from a hot path into a lookup.
 */
function memoizedWordMeasure(
  fontName: string,
  fontSize: number,
  options: FullLayoutOptions | undefined,
  bold: boolean | undefined,
  italic: boolean | undefined
): (text: string) => number {
  const cache = new Map<string, number>();
  return (text: string): number => {
    if (text.length > 8) {
      return measureLayoutText(text, fontName, fontSize, options, bold, italic);
    }
    const hit = cache.get(text);
    if (hit !== undefined) {
      return hit;
    }
    const width = measureLayoutText(text, fontName, fontSize, options, bold, italic);
    cache.set(text, width);
    return width;
  };
}

/**
 * The longest prefix of `text` that fits `room`, and the rest.
 *
 * Breaks fall on code-point boundaries, so a surrogate pair is never split into
 * two halves that render as replacement characters. At least one code point is
 * always taken, which guarantees the caller makes progress even in a column too
 * narrow for a single glyph.
 *
 * Widths are accumulated per code point rather than re-measuring every prefix:
 * the engine's own metrics are additive, and quadratic re-measurement of a long
 * CJK paragraph would dominate layout.
 */
function splitTextToFit(
  text: string,
  measure: (s: string) => number,
  room: number
): { head: string; tail: string } {
  let head = "";
  let width = 0;
  let index = 0;
  for (const ch of text) {
    const chWidth = measure(ch);
    if (head.length > 0 && width + chWidth > room) {
      break;
    }
    head += ch;
    width += chWidth;
    index += ch.length;
  }
  return { head, tail: text.slice(index) };
}

function wrapSegmentsToLines(
  segments: ParagraphSegment[],
  availableWidth: number,
  firstLineIndent: number,
  headingScale: number,
  options: FullLayoutOptions | undefined
): ParagraphSegment[][] {
  const atoms = tokenizeSegments(segments, headingScale, options);
  const lines: ParagraphSegment[][] = [];
  let line: WrapAtom[] = [];
  let lineWidth = 0;
  let isFirstLine = true;
  let effectiveWidth = availableWidth - firstLineIndent;
  /**
   * Whether the line being built was opened by a *wrap*, in which case
   * whitespace at its head is the separator the break consumed and keeping it
   * indents the line by a stray space. After a hard break — and at the start of
   * the paragraph — leading whitespace is the author's, and in a code block it
   * is the indentation.
   */
  let openedByWrap = false;

  const flushLine = (): void => {
    lines.push(reassembleLine(line));
    line = [];
    lineWidth = 0;
    if (isFirstLine) {
      isFirstLine = false;
      effectiveWidth = availableWidth;
    }
  };

  let index = 0;
  // Every pass consumes an atom, shortens one, or closes a line that already
  // holds content, so this terminates.
  while (index < atoms.length) {
    const atom = atoms[index];

    if (atom.kind === "break") {
      // A *page* break at the very start of a paragraph is a break-before: the
      // block-level machinery has already moved the paragraph, and Word leaves
      // no blank line behind. A leading *line* break does produce an empty line.
      if (isPageBreakAtom(atom) && lines.length === 0 && line.length === 0) {
        openedByWrap = false;
        index++;
        continue;
      }
      // A hard break closes the current line even though there is room left,
      // and whatever follows keeps its leading whitespace. The marker is kept on
      // the line so a page break's position is recoverable; the line-box builder
      // draws nothing for it.
      line.push(atom);
      flushLine();
      openedByWrap = false;
      index++;
      continue;
    }

    if (atom.kind === "space") {
      if (openedByWrap && lineWidth === 0) {
        index++;
        continue;
      }
      // A space that overflows is trailing whitespace, which `reassembleLine`
      // trims off the line it closes.
      line.push(atom);
      lineWidth += atom.width;
      index++;
      continue;
    }

    // A word or an inline image.
    if (lineWidth + atom.width <= effectiveWidth) {
      line.push(atom);
      lineWidth += atom.width;
      index++;
      continue;
    }

    // It does not fit. Give back the cluster it belongs to, so the whole
    // cluster moves down together rather than breaking at a run boundary.
    const retreat = gluedTailLength(line, atom);
    if (retreat > 0) {
      let keptWidth = lineWidth;
      for (let i = 0; i < retreat; i++) {
        keptWidth -= line[line.length - 1 - i].width;
      }
      if (keptWidth > 0) {
        line.length -= retreat;
        index -= retreat;
        lineWidth = keptWidth;
        flushLine();
        openedByWrap = true;
        continue;
      }
    }

    if (lineWidth > 0) {
      // Something is already on the line — try the atom again on a fresh one,
      // intact. Only a cluster that cannot fit a line *by itself* is broken.
      flushLine();
      openedByWrap = true;
      continue;
    }

    // Alone on the line and still too wide. An image is left whole — there is
    // nothing to break — and overflows the way Word lets it. A word breaks
    // inside, the way CSS `overflow-wrap: break-word` does: without that a long
    // URL, a hex digest or any space-less script ran off the right edge.
    if (atom.kind === "image" || atom.text.length === 0) {
      line.push(atom);
      lineWidth += atom.width;
      index++;
      continue;
    }
    const { head, tail } = splitTextToFit(atom.text, atom.measure, effectiveWidth);
    if (tail.length === 0) {
      line.push(atom);
      lineWidth += atom.width;
      index++;
      continue;
    }
    const headWidth = atom.measure(head);
    line.push({ ...atom, text: head, width: headWidth });
    lineWidth += headWidth;
    atoms[index] = { ...atom, text: tail, width: atom.measure(tail), glued: true };
    flushLine();
    openedByWrap = true;
  }

  if (line.length > 0) {
    // Through `flushLine`, so the last line has its trailing whitespace trimmed
    // like every other one.
    flushLine();
  }

  if (lines.length === 0 && segments.length > 0) {
    lines.push(segments);
  }

  return lines;
}

function getHeadingLevel(props: ParagraphProperties | undefined): number {
  if (!props) {
    return 0;
  }
  if (props.outlineLevel !== undefined && props.outlineLevel >= 0 && props.outlineLevel <= 5) {
    return props.outlineLevel + 1;
  }
  if (props.style) {
    const match = /^[Hh]eading\s*(\d)$/i.exec(props.style);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return 0;
}

function getHeadingFontScale(level: number): number {
  switch (level) {
    case 1:
      return 2.0;
    case 2:
      return 1.5;
    case 3:
      return 1.17;
    case 4:
      return 1.0;
    case 5:
      return 0.83;
    case 6:
      return 0.67;
    default:
      return 1.0;
  }
}

/**
 * Resolve the effective font size in points for a run.
 *
 * `<w:sz w:val="…"/>` is in half-points; we halve.
 *
 * Sub/superscript runs are conventionally rendered at ~65 % of the
 * surrounding text's size with a vertical baseline shift. The size
 * scaling lives here so every measurement (line width, line height,
 * wrap) sees the same value; the y-shift is applied at render time
 * via `PositionedRun.verticalAlign`.
 */
function getRunFontSizePt(props: Run["properties"]): number {
  const base = props?.size ? props.size / 2 : DEFAULT_FONT_SIZE_PT;
  if (props?.vertAlign === "superscript" || props?.vertAlign === "subscript") {
    return base * SCRIPT_FONT_SIZE_RATIO;
  }
  return base;
}

/**
 * The natural (single-spaced) line height of a paragraph, in points.
 *
 * Word sizes a line from the tallest run on it. We approximate that with the
 * paragraph's largest run font size — one height for the whole paragraph —
 * which keeps wrapping and pagination arithmetic simple while still giving a
 * 24 pt heading a 24 pt-sized line box.
 *
 * Sub/superscript runs are deliberately measured at their shrunken size (they
 * ride the surrounding text's line), and an empty paragraph falls back to its
 * paragraph-mark run properties, then the style's, then the document default.
 */
function naturalParagraphLineHeightPt(
  segments: readonly ParagraphSegment[],
  props: ParagraphProperties | undefined,
  styleRunProps: Run["properties"] | undefined
): number {
  let maxPt = 0;
  for (const seg of segments) {
    if (!isTextSegment(seg)) {
      continue;
    }
    const size = getRunFontSizePt(seg.properties);
    if (size > maxPt) {
      maxPt = size;
    }
  }
  if (maxPt === 0) {
    // Only images and/or hard breaks: fall back to the paragraph mark's size,
    // then the style's, then the document default, so an empty line still has
    // the height the author asked for.
    const fromBreak = segments.find(seg => "type" in seg && seg.type === "break")?.properties;
    maxPt = getRunFontSizePt(props?.markRunProperties ?? styleRunProps ?? fromBreak);
  }
  return maxPt * LINE_HEIGHT_FACTOR;
}

function resolveRunFontName(props: Run["properties"]): string {
  if (!props?.font) {
    return "Calibri";
  }
  if (typeof props.font === "string") {
    return props.font;
  }
  return (props.font as { ascii?: string }).ascii ?? "Calibri";
}

function measureLayoutText(
  text: string,
  fontName: string,
  fontSize: number,
  options: FullLayoutOptions | undefined,
  bold?: boolean,
  italic?: boolean
): number {
  if (options?.measureText) {
    return options.measureText(text, fontName, fontSize, bold, italic);
  }
  return measureTextWidth(text, styledFontVariant(fontName, bold, italic), fontSize);
}

function measureLayoutFontMetrics(
  text: string,
  fontName: string,
  fontSize: number,
  options: FullLayoutOptions | undefined,
  bold?: boolean,
  italic?: boolean
): { ascent: number; descent: number } {
  if (options?.measureTextMetrics) {
    return options.measureTextMetrics(text, fontName, fontSize, bold, italic);
  }
  const face = styledFontVariant(fontName, bold, italic);
  return { ascent: getFontAscent(face, fontSize), descent: getFontDescent(face, fontSize) };
}

function resolveColorHex(
  color: Run["properties"] extends { color?: infer C } ? C : unknown
): string | undefined {
  if (!color) {
    return undefined;
  }
  if (typeof color === "string") {
    return color;
  }
  // The `!color` check above already discarded `null`; an additional
  // `color !== null` test was always true and CodeQL flagged it as a
  // comparison between inconvertible types.
  if (typeof color === "object" && "value" in (color as object)) {
    return (color as { value: string }).value;
  }
  return undefined;
}

// =============================================================================
// Internal: Image / Geometry Helpers
// =============================================================================

function emuToPt(emu: number): number {
  return emu / EMU_PER_POINT;
}

/**
 * Convert the docx-internal `ImageMediaType` (`"png"`, `"jpeg"`, …)
 * to the standard MIME string consumers expect on
 * `LayoutImage.mimeType` / `PositionedInlineImage.mimeType`. Unknown
 * tags fall back to `application/octet-stream` so renderers can
 * decide whether to skip or draw a placeholder.
 */
function mediaTypeToMime(mt: string | undefined): string {
  switch (mt) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tiff":
      return "image/tiff";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "emf":
      return "image/x-emf";
    case "wmf":
      return "image/x-wmf";
    default:
      return "application/octet-stream";
  }
}

function buildImageMap(images: readonly ImageDef[] | undefined): Map<string, ImageDef> {
  const map = new Map<string, ImageDef>();
  if (!images) {
    return map;
  }
  for (const img of images) {
    if (img.rId) {
      map.set(img.rId, img);
    }
    // Some images carry additional rIds (header/footer parts use their own
    // local id space). Index by every known rId so layout can resolve
    // either flavour.
    if (Array.isArray((img as ImageDef & { altRIds?: string[] }).altRIds)) {
      for (const aux of (img as ImageDef & { altRIds: string[] }).altRIds) {
        map.set(aux, img);
      }
    }
  }
  return map;
}

// =============================================================================
// Internal: FloatingImage / TextBox / Shape / Chart / SDT / Math / CheckBox
// =============================================================================

/**
 * Resolve the page-content-area position of a floating image per
 * ECMA-376 §20.4.2.10. Layout coordinates have origin at the top-left
 * of the **content area**; floating-image anchors are normally
 * expressed against the **page** or **margin**, so we translate
 * accordingly.
 *
 * Resolution order:
 *  1. `simplePos="1"` (we currently see only `simplePos.x`/`simplePos.y`
 *     in the model; we treat its presence as the simplePos override)
 *     — page-absolute EMU.
 *  2. `horizontalPosition` / `verticalPosition` with `align` keywords
 *     (left/center/right/inside/outside, top/center/bottom).
 *  3. `horizontalPosition` / `verticalPosition` with `offset` (EMU)
 *     relative to the chosen `relativeTo` reference.
 *  4. Fall back to the cursor (inline-like behaviour).
 *
 * `relativeTo` reference points (subset we resolve):
 *  - `"page"` — page top-left corner
 *  - `"margin"` — margin box top-left corner (same as content area
 *    origin in our coordinate system)
 *  - `"column"` / `"character"` / `"paragraph"` etc. — fall back to the
 *    cursor; reproducing them faithfully would require column/text-flow
 *    info we don't keep at this stage.
 */
function resolveFloatingImageRect(
  fi: FloatingImage,
  cursorY: number,
  contentWidth: number,
  contentHeight: number,
  geometry: PageGeometry,
  widthPt: number,
  heightPt: number
): { x: number; y: number } {
  const usingSimplePos = fi.simplePos !== undefined;

  // 1. simplePos: page-absolute. Translate into content-area coords by
  //    subtracting the page margins.
  if (usingSimplePos) {
    const pageX = emuToPt(fi.simplePos!.x ?? 0);
    const pageY = emuToPt(fi.simplePos!.y ?? 0);
    return {
      x: pageX - geometry.marginLeft,
      y: pageY - geometry.marginTop
    };
  }

  // 2/3. positionH / positionV
  const xPt = resolveHorizontal(fi, contentWidth, geometry, widthPt) ?? 0;
  const yPt = resolveVertical(fi, cursorY, contentHeight, geometry, heightPt) ?? cursorY;

  return { x: xPt, y: yPt };
}

function resolveHorizontal(
  fi: FloatingImage,
  contentWidth: number,
  geometry: PageGeometry,
  widthPt: number
): number | undefined {
  const h = fi.horizontalPosition;
  if (!h) {
    return undefined;
  }
  const relTo = h.relativeTo ?? "column";
  // Reference origin (in content-area coordinates) and width to anchor against.
  let originX = 0;
  let refWidth = contentWidth;
  if (relTo === "page") {
    originX = -geometry.marginLeft;
    refWidth = geometry.width;
  } else if (relTo === "margin" || relTo === "leftMargin" || relTo === "rightMargin") {
    originX = 0;
    refWidth = contentWidth;
  } // else: column/character/insideMargin/outsideMargin — fall back to content area

  if (h.align) {
    switch (h.align) {
      case "left":
      case "inside":
        return originX;
      case "right":
      case "outside":
        return originX + refWidth - widthPt;
      case "center":
        return originX + (refWidth - widthPt) / 2;
    }
  }
  if (h.offset != null) {
    return originX + emuToPt(h.offset);
  }
  return undefined;
}

function resolveVertical(
  fi: FloatingImage,
  cursorY: number,
  contentHeight: number,
  geometry: PageGeometry,
  heightPt: number
): number | undefined {
  const v = fi.verticalPosition;
  if (!v) {
    return undefined;
  }
  const relTo = v.relativeTo ?? "paragraph";
  let originY = cursorY;
  let refHeight = contentHeight;
  if (relTo === "page") {
    originY = -geometry.marginTop;
    refHeight = geometry.height;
  } else if (relTo === "margin" || relTo === "topMargin" || relTo === "bottomMargin") {
    originY = 0;
    refHeight = contentHeight;
  } // else paragraph/line/text-anchored — keep cursor as origin

  if (v.align) {
    switch (v.align) {
      case "top":
      case "inside":
        return originY;
      case "bottom":
      case "outside":
        return originY + refHeight - heightPt;
      case "center":
        return originY + (refHeight - heightPt) / 2;
    }
  }
  if (v.offset != null) {
    return originY + emuToPt(v.offset);
  }
  return undefined;
}

function layoutFloatingImage(
  fi: FloatingImage,
  cursorY: number,
  contentWidth: number,
  contentHeight: number,
  geometry: PageGeometry,
  sourceIndex: number,
  imageMap: ReadonlyMap<string, ImageDef>
): LayoutFloat {
  const widthPt = emuToPt(fi.width);
  const heightPt = emuToPt(fi.height);
  const { x: xPt, y: yPt } = resolveFloatingImageRect(
    fi,
    cursorY,
    contentWidth,
    contentHeight,
    geometry,
    widthPt,
    heightPt
  );

  const img = fi.rId ? imageMap.get(fi.rId) : undefined;
  const imageContent: LayoutImage = img
    ? {
        type: "image",
        rect: { x: xPt, y: yPt, width: widthPt, height: heightPt },
        data: img.data,
        mimeType: mediaTypeToMime(img.mediaType),
        altText: fi.altText,
        sourceIndex
      }
    : {
        type: "image",
        rect: { x: xPt, y: yPt, width: widthPt, height: heightPt },
        data: new Uint8Array(0),
        mimeType: "application/octet-stream",
        altText: fi.altText,
        sourceIndex
      };

  return {
    type: "float",
    rect: { x: xPt, y: yPt, width: widthPt, height: heightPt },
    content: imageContent,
    behindText: fi.behindDoc === true,
    ...(fi.wrap ? { wrap: convertWrap(fi.wrap) } : {}),
    sourceIndex
  };
}

/**
 * Translate the source `FloatingImage.wrap` (with `WrapMargins` in EMU)
 * into the layout-side `LayoutFloatWrap` (with margins already in
 * points so renderers don't need to know about EMU).
 */
function convertWrap(wrap: NonNullable<FloatingImage["wrap"]>): NonNullable<LayoutFloat["wrap"]> {
  const out: {
    -readonly [K in keyof NonNullable<LayoutFloat["wrap"]>]: NonNullable<LayoutFloat["wrap"]>[K];
  } = {
    style: wrap.style
  };
  if (wrap.side) {
    out.side = wrap.side;
  }
  if (wrap.margins) {
    const m: {
      -readonly [K in keyof NonNullable<NonNullable<LayoutFloat["wrap"]>["margins"]>]: number;
    } = {};
    if (wrap.margins.top != null) {
      m.top = emuToPt(wrap.margins.top);
    }
    if (wrap.margins.bottom != null) {
      m.bottom = emuToPt(wrap.margins.bottom);
    }
    if (wrap.margins.left != null) {
      m.left = emuToPt(wrap.margins.left);
    }
    if (wrap.margins.right != null) {
      m.right = emuToPt(wrap.margins.right);
    }
    if (Object.keys(m).length > 0) {
      out.margins = m;
    }
  }
  return out;
}

function layoutTextBox(
  tb: TextBox,
  startY: number,
  contentWidth: number,
  sourceIndex: number,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): LayoutTextBox {
  const widthPt = tb.width != null ? twipsToPt(tb.width) : contentWidth;
  // Lay out inner paragraphs against the text-box width; their positions
  // are returned relative to the box's top-left so renderers translate
  // by `rect.x`/`rect.y`.
  const inner: PageContent[] = [];
  let innerCursor = 0;
  for (const child of tb.content) {
    const laid = layoutParagraph(child, innerCursor, widthPt, options, undefined, imageMap);
    inner.push({ ...laid, sourceIndex });
    innerCursor = laid.rect.y + laid.rect.height;
  }

  const heightPt = tb.height != null ? twipsToPt(tb.height) : Math.max(innerCursor, 12);

  return {
    type: "textBox",
    rect: { x: 0, y: startY, width: widthPt, height: heightPt },
    content: inner,
    border:
      tb.stroke && tb.strokeColor
        ? { width: 0.75, color: normaliseHex(tb.strokeColor) }
        : undefined,
    background: tb.fill && tb.fillColor ? normaliseHex(tb.fillColor) : undefined,
    sourceIndex
  };
}

function layoutDrawingShape(
  shape: DrawingShape,
  startY: number,
  contentWidth: number,
  sourceIndex: number,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): LayoutShape {
  const widthPt = emuToPt(shape.width);
  const heightPt = emuToPt(shape.height);
  const innerWidth = Math.min(widthPt, contentWidth);

  const innerContent: PageContent[] = [];
  if (shape.textContent && shape.textContent.length > 0) {
    let cursor = 0;
    for (const para of shape.textContent) {
      const laid = layoutParagraph(para, cursor, innerWidth, options, undefined, imageMap);
      innerContent.push({ ...laid, sourceIndex });
      cursor = laid.rect.y + laid.rect.height;
    }
  }

  return {
    type: "shape",
    rect: { x: 0, y: startY, width: widthPt, height: heightPt },
    preset: shape.shapeType,
    fillColor: shape.noFill ? undefined : normaliseHexOrUndefined(shape.fillColor),
    strokeColor: shape.noOutline ? undefined : normaliseHexOrUndefined(shape.outlineColor),
    strokeWidth: shape.outlineWidth != null ? emuToPt(shape.outlineWidth) : undefined,
    textContent: innerContent.length > 0 ? innerContent : undefined,
    sourceIndex
  };
}

function layoutChart(
  ch: ChartContent | ChartExContent,
  startY: number,
  contentWidth: number,
  sourceIndex: number
): LayoutChart {
  // Source dimensions:
  //  - ChartContent stores width/height inside the inner Chart model
  //    (writer emits `<wp:extent>` from `chart.width/height`; reader
  //    populates them from the original drawing's `<wp:extent>`).
  //  - ChartExContent carries width/height directly on the content.
  // Both fall back to a 6"×3.5" default that matches Microsoft Word's
  // default insert size when the source supplied none.
  const widthEmu = ch.type === "chart" ? (ch.chart?.width ?? 5_486_400) : (ch.width ?? 5_486_400);
  const heightEmu =
    ch.type === "chart" ? (ch.chart?.height ?? 3_200_400) : (ch.height ?? 3_200_400);
  const widthPt = Math.min(emuToPt(widthEmu), contentWidth);
  const heightPt = emuToPt(heightEmu);
  const title = ch.type === "chart" ? (ch.chart?.title ?? ch.name) : ch.name;

  return {
    type: "chart",
    rect: { x: 0, y: startY, width: widthPt, height: heightPt },
    chartKind: ch.type === "chart" ? "chart" : "chartEx",
    title,
    altText: ch.altText,
    source: ch,
    sourceIndex
  };
}

function layoutSdt(
  sdt: StructuredDocumentTag,
  startY: number,
  contentWidth: number,
  sourceIndex: number,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): LayoutSdt {
  // SDT is a transparent flow container in layout terms: lay out its
  // children inline and report a rect that encloses them. Inline-only
  // children (bare runs) are skipped — the SDT-as-block contract is
  // what layout cares about.
  const inner: PageContent[] = [];
  let cursor = 0;
  for (const child of sdt.content) {
    if ("type" in child) {
      if (child.type === "paragraph") {
        const laid = layoutParagraph(child, cursor, contentWidth, options, undefined, imageMap);
        inner.push({ ...laid, sourceIndex });
        cursor = laid.rect.y + laid.rect.height;
      } else if (child.type === "table") {
        const laid = layoutTable(child, cursor, contentWidth, sourceIndex, options, imageMap);
        inner.push(laid);
        cursor = laid.rect.y + laid.rect.height;
      }
      // Run-only SDT children are not flowed at the block level.
    }
  }

  return {
    type: "sdt",
    rect: { x: 0, y: startY, width: contentWidth, height: cursor },
    content: inner,
    tag: sdt.properties?.tag,
    alias: sdt.properties?.alias,
    sourceIndex
  };
}

function layoutMath(
  mb: MathBlock,
  startY: number,
  contentWidth: number,
  sourceIndex: number,
  options: FullLayoutOptions | undefined
): LayoutMath {
  const text = extractMathText(mb.content);
  let mathML: string | undefined;
  try {
    mathML = ommlToMathML(mb.content);
  } catch {
    mathML = undefined;
  }
  const fontSize = DEFAULT_FONT_SIZE_PT;
  const lineHeight = fontSize * 1.2;
  // Width is approximated from the plain-text fallback so renderers that
  // don't handle MathML still see a reasonable bounding box.
  const fontName = options?.fonts?.get("Cambria Math") ?? "Cambria Math";
  const widthPt = Math.min(measureLayoutText(text, fontName, fontSize, options), contentWidth);

  return {
    type: "math",
    rect: { x: 0, y: startY, width: widthPt, height: lineHeight },
    text,
    mathML,
    sourceIndex
  };
}

function layoutCheckBox(
  cb: CheckBox,
  startY: number,
  sourceIndex: number,
  options: FullLayoutOptions | undefined
): LayoutCheckBox {
  const fontSize = DEFAULT_FONT_SIZE_PT;
  const checked = cb.checked === true;
  const glyph = checked
    ? (cb.checkedState?.value ?? "\u2611") // ☑
    : (cb.uncheckedState?.value ?? "\u2610"); // ☐
  const fontName = cb.checkedState?.font ?? options?.fonts?.get("MS Gothic") ?? "MS Gothic";
  const widthPt = measureLayoutText(glyph, fontName, fontSize, options);
  return {
    type: "checkBox",
    rect: { x: 0, y: startY, width: widthPt, height: fontSize * 1.2 },
    checked,
    glyph,
    fontSize,
    sourceIndex
  };
}

function layoutTableOfContents(
  toc: TableOfContents,
  startY: number,
  contentWidth: number,
  sourceIndex: number,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): LayoutTableOfContents {
  const entries: LayoutParagraph[] = [];
  let cursor = 0;
  if (toc.cachedParagraphs && toc.cachedParagraphs.length > 0) {
    for (const para of toc.cachedParagraphs) {
      const laid = layoutParagraph(para, cursor, contentWidth, options, undefined, imageMap);
      entries.push({ ...laid, sourceIndex });
      cursor = laid.rect.y + laid.rect.height;
    }
  } else {
    // Stub: emit a single placeholder paragraph so renderers always have
    // something to render. Consumers wanting a real TOC should run
    // `updateTableOfContents()` before layout.
    const stub: Paragraph = {
      type: "paragraph",
      children: [{ content: [{ type: "text", text: "[Table of Contents]" }] }]
    };
    const laid = layoutParagraph(stub, 0, contentWidth, options, undefined, imageMap);
    entries.push({ ...laid, sourceIndex });
    cursor = laid.rect.height;
  }

  return {
    type: "tableOfContents",
    rect: { x: 0, y: startY, width: contentWidth, height: cursor },
    entries,
    sourceIndex
  };
}

function layoutAltChunk(
  ac: AltChunk,
  startY: number,
  contentWidth: number,
  sourceIndex: number
): LayoutAltChunk {
  // Layout cannot interpret HTML / RTF / MHT payloads; reserve a
  // placeholder rect proportional to a small fixed height so renderers
  // can show a substitution glyph or run their own foreign-content
  // pipeline.
  const heightPt = DEFAULT_FONT_SIZE_PT * 3;
  return {
    type: "altChunk",
    rect: { x: 0, y: startY, width: contentWidth, height: heightPt },
    contentType: ac.contentType ?? "application/octet-stream",
    fileName: ac.fileName,
    sourceIndex
  };
}

function layoutOpaqueDrawing(
  od: OpaqueDrawing,
  startY: number,
  contentWidth: number,
  sourceIndex: number
): LayoutOpaqueDrawing {
  // We have no idea how big the drawing is from XML alone; reserve a
  // square-ish placeholder roughly matching a typical chart slot. High-
  // fidelity renderers can re-parse `rawXml` if they need exact size.
  const heightPt = DEFAULT_FONT_SIZE_PT * 12;
  return {
    type: "opaqueDrawing",
    rect: { x: 0, y: startY, width: contentWidth, height: heightPt },
    rawXml: od.rawXml,
    sourceIndex
  };
}

function normaliseHex(hex: string): string {
  return hex.startsWith("#") ? hex.slice(1) : hex;
}

function normaliseHexOrUndefined(hex: string | undefined): string | undefined {
  return hex ? normaliseHex(hex) : undefined;
}
