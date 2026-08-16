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

import { measureTextWidth, styledFontVariant } from "@utils/font-metrics";
import { ommlToMathML } from "@word/advanced/math-convert";
import { extractMathText, isHyperlink, isRun } from "@word/core/text-utils";
import { layoutDocument } from "@word/layout/layout";
import type { LayoutOptions, LayoutResult } from "@word/layout/layout";
import {
  DEFAULT_PAGE_HEIGHT_TWIPS,
  DEFAULT_PAGE_MARGIN_TWIPS,
  DEFAULT_PAGE_WIDTH_TWIPS
} from "@word/layout/layout-constants";
import type {
  LayoutAltChunk,
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
import { resolveStyle } from "@word/query/style-resolve";
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
  ParagraphChild,
  ParagraphProperties,
  NumberFormat,
  Run,
  StructuredDocumentTag,
  Table,
  TableBorders,
  TableOfContents,
  TextBox
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
  // without threading the map through every container function. Layout runs
  // fully synchronously (no `await`), so a single shared slot is safe.
  const listMarkers = computeListMarkers(doc);
  activeListMarkers = listMarkers;
  activeDoc = doc;
  try {
    return layoutDocumentFullInner(doc, options, layoutResult, listMarkers);
  } finally {
    activeListMarkers = undefined;
    activeDoc = undefined;
  }
}

/** Active list-marker map for the in-flight layout (see layoutDocumentFull). */
let activeListMarkers: ReadonlyMap<Paragraph, ListMarker> | undefined;

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
  const bodyPageCount = layoutResult.pageCount;
  let pendingFootnoteIds: readonly number[] = [];

  for (let pageNum = 1; pageNum <= bodyPageCount; pageNum++) {
    const result = buildPage(doc, pageNum, layoutResult, options, pendingFootnoteIds, listMarkers);
    pages.push(result.page);
    pendingFootnoteIds = result.deferredFootnoteIds;
  }

  // Defensive: if the last page still has deferred footnotes, append
  // a synthetic page that hosts them. Without this, references would
  // silently lose their content. This is rare (it only fires when an
  // oversized footnote stack on the last body page didn't fit).
  if (pendingFootnoteIds.length > 0 && bodyPageCount > 0) {
    const overflowResult = buildPage(
      doc,
      bodyPageCount + 1,
      // Reuse the last page's `LayoutResult` shape: contentPages
      // entries for already-placed body items still point at earlier
      // pages, so the synthetic page won't pick up extra body
      // content; only the carried footnote queue renders.
      layoutResult,
      options,
      pendingFootnoteIds,
      listMarkers
    );
    pages.push(overflowResult.page);
  }

  return {
    pages,
    totalPages: pages.length,
    bookmarkPages: layoutResult.bookmarkPages,
    sectionBreaks: computeSectionBreaks(layoutResult)
  };
}

// =============================================================================
// Internal: Page Building
// =============================================================================

const DEFAULT_FONT_SIZE_PT = 12;

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
}

function buildPage(
  doc: DocxDocument,
  pageNumber: number,
  layout: LayoutResult,
  options: FullLayoutOptions | undefined,
  pendingFootnoteIds: readonly number[],
  listMarkers?: ReadonlyMap<Paragraph, ListMarker>
): BuildPageResult {
  const sectionProps = doc.sectionProperties;
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
   * Wrap exclusion zones from floats with `square` / `tight` /
   * `through` wrap, populated as we iterate so subsequent paragraphs
   * (later in document order) avoid them line-by-line. Floats that
   * appear AFTER a paragraph in the source do not push back into
   * preceding lines — this matches Word's behaviour where re-flow on
   * insertion happens at edit time, not render time.
   */
  const pageExclusions: WrapExclusion[] = [];

  let cursorY = 0; // relative to content area top

  for (let i = 0; i < doc.body.length; i++) {
    if (layout.contentPages[i] !== pageNumber) {
      continue;
    }

    const item = doc.body[i];
    collectFootnoteRefsFromBody(item, footnoteRefIds);
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
        content.push({ ...laid, sourceIndex: i });
        cursorY = laid.rect.y + laid.rect.height;
        break;
      }
      case "table": {
        const laid = layoutTable(item, cursorY, geometry.contentWidth, i, options, imageMap);
        content.push(laid);
        cursorY = laid.rect.y + laid.rect.height;
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
  }

  const header = layoutHeader(doc, pageNumber, geometry, options, imageMap);
  const footer = layoutFooter(doc, pageNumber, geometry, options, imageMap);

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
    deferredFootnoteIds: footnoteResult.deferred
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
  titlePage: boolean,
  evenAndOdd: boolean
): { readonly type: string; readonly rId: string } | undefined {
  const find = (t: string): { readonly type: string; readonly rId: string } | undefined =>
    refs.find(r => r.type === t);

  if (titlePage && pageNumber === 1) {
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
  geometry: PageGeometry,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): (LayoutParagraph | LayoutTable)[] {
  const refs = doc.sectionProperties?.headers;
  if (!refs || refs.length === 0) {
    return [];
  }
  const titlePage = doc.sectionProperties?.titlePage === true;
  const evenAndOdd = doc.settings?.evenAndOddHeaders === true;
  const ref = pickHeaderFooterRef(refs, pageNumber, titlePage, evenAndOdd);
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
  geometry: PageGeometry,
  options: FullLayoutOptions | undefined,
  imageMap: ReadonlyMap<string, ImageDef>
): (LayoutParagraph | LayoutTable)[] {
  const refs = doc.sectionProperties?.footers;
  if (!refs || refs.length === 0) {
    return [];
  }
  const titlePage = doc.sectionProperties?.titlePage === true;
  const evenAndOdd = doc.settings?.evenAndOddHeaders === true;
  const ref = pickHeaderFooterRef(refs, pageNumber, titlePage, evenAndOdd);
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

function computeSectionBreaks(layout: LayoutResult): number[] {
  const breaks: number[] = [0]; // First section starts at page 0
  let prevSection = 0;
  for (let i = 0; i < layout.contentPages.length; i++) {
    const section = layout.contentSections[i];
    if (section > prevSection) {
      breaks.push(layout.contentPages[i] - 1);
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
    const indentPt = (level + 1) * 36; // 0.5" per level

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
  listMarkers?: ReadonlyMap<Paragraph, ListMarker>
): LayoutParagraph {
  const props = para.properties;
  const spacing = props?.spacing;
  // Resolve effective run properties from the paragraph's style chain. When
  // the style supplies a concrete font size we honour it; only when it does
  // not do we fall back to the heuristic heading scale so headings stay
  // distinct in documents lacking a styles table.
  const styleRunProps = activeDoc ? resolveStyle(activeDoc, para).runProperties : undefined;
  const styleHasSize = styleRunProps?.size != null;
  const headingScale = styleHasSize ? 1 : getHeadingFontScale(getHeadingLevel(props));

  // Space before
  let spaceBefore = 0;
  if (spacing?.beforeAutoSpacing) {
    spaceBefore = 5;
  } else if (spacing?.before != null) {
    spaceBefore = twipsToPt(spacing.before);
  }

  const indent = props?.indent;
  // Prefer an explicitly threaded map; fall back to the active layout's
  // shared map so list markers also render inside tables, text boxes, SDTs,
  // footnotes, etc. (whose layoutParagraph calls don't thread it through).
  const marker = (listMarkers ?? activeListMarkers)?.get(para);
  // List paragraphs are indented by their numbering level; the marker text
  // is injected as a leading run below. An explicit paragraph indent (rare on
  // list items) still wins when larger.
  const markerIndentPt = marker ? marker.indentPt : 0;
  const leftIndentPt = Math.max(indent?.left ? twipsToPt(indent.left) : 0, markerIndentPt);
  const firstLineIndentPt = indent?.firstLine ? twipsToPt(indent.firstLine) : 0;
  const alignment = props?.alignment ?? "left";

  // Line height
  let lineHeightPt = DEFAULT_FONT_SIZE_PT * 1.2;
  if (spacing?.line) {
    const rule = spacing.lineRule ?? "auto";
    switch (rule) {
      case "exact":
        lineHeightPt = twipsToPt(spacing.line);
        break;
      case "atLeast":
        lineHeightPt = Math.max(twipsToPt(spacing.line), lineHeightPt);
        break;
      case "auto":
        lineHeightPt = DEFAULT_FONT_SIZE_PT * 1.2 * (spacing.line / 240);
        break;
    }
  }
  lineHeightPt *= headingScale;

  // Collect runs
  const segments = mergeStyleRunProps(collectParagraphSegments(para), styleRunProps);
  // Inject the list marker (bullet / number) as a leading text run so it
  // renders inline at the start of the first line, inheriting the first
  // text run's formatting (font / size) for visual consistency.
  if (marker) {
    let firstRunProps: Run["properties"];
    for (const s of segments) {
      if (!("type" in s) || s.type === undefined) {
        firstRunProps = (s as TextSegment).properties;
        break;
      }
    }
    segments.unshift({ text: marker.text, properties: firstRunProps });
  }
  const fullAvailableWidth = contentWidth - leftIndentPt;

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

    // Calculate line width for alignment, and find the tallest item
    // so the line's height accommodates inline images.
    let lineWidth = 0;
    let lineMaxHeight = lineHeightPt;
    for (const seg of lineSegments) {
      if ("type" in seg && seg.type === "image") {
        const w = emuToPt(seg.content.width);
        const h = emuToPt(seg.content.height);
        lineWidth += w;
        if (h > lineMaxHeight) {
          lineMaxHeight = h;
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

    lineBoxes.push({
      y: yOffset,
      height: lineMaxHeight,
      // Baseline for text sits at 80% of line height; for an
      // image-dominant line this puts the image's bottom near the
      // baseline, matching Word's default inline-image alignment.
      baseline: lineMaxHeight * 0.8,
      runs,
      alignment: mappedAlignment
    });

    yOffset += lineMaxHeight;
  }

  // If empty paragraph, still advance by one line
  if (lineBoxes.length === 0) {
    yOffset += lineHeightPt;
  }

  // Space after
  let spaceAfter = 0;
  if (spacing?.afterAutoSpacing) {
    spaceAfter = 5;
  } else if (spacing?.after != null) {
    spaceAfter = twipsToPt(spacing.after);
  }

  const totalHeight = yOffset + spaceAfter;

  return {
    type: "paragraph",
    rect: { x: 0, y: startY, width: contentWidth, height: totalHeight },
    lines: lineBoxes,
    sourceIndex: 0 // overwritten by caller
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

  for (let ri = 0; ri < table.rows.length; ri++) {
    const row = table.rows[ri];
    let maxRowHeight = DEFAULT_FONT_SIZE_PT * 1.5; // minimum row height

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
      let cellCursorY = 2; // cell padding top

      for (const block of cell.content) {
        if (block.type === "paragraph") {
          const laid = layoutParagraph(
            block,
            cellCursorY,
            cellWidth - 4,
            options,
            undefined,
            imageMap
          );
          cellContent.push({ ...laid, sourceIndex: -1 });
          cellCursorY = laid.rect.y + laid.rect.height;
        } else if (block.type === "table") {
          // Nested table: lay it out within the cell's content width and
          // stack it below preceding content. The PDF/SVG renderers
          // already translate nested `LayoutTable` rects by the cell
          // origin, so emitting it here is all that's needed.
          const laidNested = layoutTable(block, cellCursorY, cellWidth - 4, -1, options, imageMap);
          cellContent.push(laidNested);
          cellCursorY = laidNested.rect.y + laidNested.rect.height;
        }
      }

      const cellHeight = cellCursorY + 2; // cell padding bottom
      if (cellHeight > maxRowHeight) {
        maxRowHeight = cellHeight;
      }

      cells.push({
        rect: { x: cellX, y: startY + cursorY, width: cellWidth, height: cellHeight },
        row: ri,
        col: ci,
        content: cellContent,
        borders: resolveCellBorders(
          table.properties?.borders,
          cell.properties?.borders,
          ri === 0,
          ri === table.rows.length - 1,
          startCol === 0,
          endCol >= colWidths.length
        )
      });

      gridCol += span;
    }

    // Normalize cell heights to row max
    for (const c of cells) {
      if (c.row === ri) {
        (c as { rect: { height: number } }).rect.height = maxRowHeight;
      }
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

  const top = edge(cellBorders?.top, tableBorders?.top, tableBorders?.insideH, isTopRow);
  const bottom = edge(
    cellBorders?.bottom,
    tableBorders?.bottom,
    tableBorders?.insideH,
    isBottomRow
  );
  const left = edge(cellBorders?.left, tableBorders?.left, tableBorders?.insideV, isLeftCol);
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
 * Paragraph-level token: either a text segment or an inline image.
 * Returned by `collectParagraphSegments` so wrap algorithms can
 * thread images through without losing them.
 */
type ParagraphSegment = TextSegment | ImageSegment;

/**
 * Walk a paragraph's children and emit a flat sequence of paragraph
 * segments — text runs preserve their formatting; inline images become
 * dedicated `ImageSegment` tokens so the wrap engine treats them as
 * unbreakable atoms positioned in document order. Hyperlinks are
 * descended into; bookmark / comment / track-change wrappers are
 * ignored for layout purposes.
 */
function collectParagraphSegments(para: Paragraph): ParagraphSegment[] {
  const segments: ParagraphSegment[] = [];
  for (const child of para.children) {
    if (isRun(child)) {
      pushRunSegments(child, segments);
    } else if (isHyperlink(child)) {
      for (const run of child.children) {
        pushRunSegments(run, segments);
      }
    }
  }
  return segments;
}

/**
 * Overlay resolved paragraph-style run properties under each segment's own
 * (inline) properties, so style-defined size/color/font apply when a run does
 * not override them. Inline run properties always win.
 */
function mergeStyleRunProps(
  segments: ParagraphSegment[],
  styleRunProps: Run["properties"] | undefined
): ParagraphSegment[] {
  if (!styleRunProps) {
    return segments;
  }
  return segments.map(seg => {
    const own = seg.properties;
    const merged = own ? { ...styleRunProps, ...own } : styleRunProps;
    return { ...seg, properties: merged } as ParagraphSegment;
  });
}

/**
 * Emit `ParagraphSegment` tokens for a single run, preserving the
 * relative order of text fragments and inline images. Consecutive
 * text-bearing entries are coalesced into one `TextSegment` so the
 * wrap engine sees fewer atoms.
 */
function pushRunSegments(run: Run, out: ParagraphSegment[]): void {
  let pending = "";
  for (const item of run.content) {
    if (item.type === "text") {
      pending += item.text;
    } else if (item.type === "tab") {
      pending += "    ";
    } else if (item.type === "break") {
      pending += "\n";
    } else if (item.type === "image") {
      if (pending.length > 0) {
        out.push({ text: pending, properties: run.properties });
        pending = "";
      }
      out.push({ type: "image", content: item, properties: run.properties });
    }
  }
  if (pending.length > 0) {
    out.push({ text: pending, properties: run.properties });
  }
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
  // Tokenize all segments into a flat sequence of "atoms" (words,
  // whitespace, and inline images) carrying their measured width.
  // Inline images are unbreakable atoms with `isImage: true`; they
  // never split on whitespace.
  type Atom = {
    readonly width: number;
    readonly isSpace: boolean;
    readonly isImage: boolean;
    readonly text?: string;
    readonly properties?: Run["properties"];
    readonly imageContent?: InlineImageContent;
  };
  const atoms: Atom[] = [];
  for (const seg of segments) {
    if ("type" in seg && seg.type === "image") {
      atoms.push({
        width: emuToPt(seg.content.width),
        isSpace: false,
        isImage: true,
        properties: seg.properties,
        imageContent: seg.content
      });
      continue;
    }
    const fontSize = getRunFontSizePt(seg.properties) * headingScale;
    const fontName = resolveRunFontName(seg.properties);
    // Split on runs of whitespace, keeping the whitespace tokens so
    // wrapping can decide whether to drop trailing space at line end.
    const tokens = seg.text.split(/(\s+)/);
    for (const tok of tokens) {
      if (tok.length === 0) {
        continue;
      }
      atoms.push({
        text: tok,
        width: measureLayoutText(
          tok,
          fontName,
          fontSize,
          options,
          seg.properties?.bold,
          seg.properties?.italic
        ),
        properties: seg.properties,
        isSpace: /^\s+$/.test(tok),
        isImage: false
      });
    }
  }

  const lines: ParagraphSegment[][] = [];
  const slots: { xOffset: number; width: number }[] = [];

  if (atoms.length === 0) {
    return { lines, slots };
  }

  let cursorAtom = 0;
  let lineIdx = 0;
  while (cursorAtom < atoms.length) {
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

    // Greedily pack atoms into the line until the next atom would
    // overflow `usable`. A leading whitespace atom on a fresh line is
    // dropped (matches typical text engines).
    if (atoms[cursorAtom].isSpace) {
      cursorAtom++;
      if (cursorAtom >= atoms.length) {
        break;
      }
    }
    const lineAtoms: Atom[] = [];
    let lineWidth = 0;
    while (cursorAtom < atoms.length) {
      const atom = atoms[cursorAtom];
      const next = lineWidth + atom.width;
      if (next > usable && lineAtoms.length > 0) {
        // Atom would overflow; commit the line and go to next.
        break;
      }
      lineAtoms.push(atom);
      lineWidth = next;
      cursorAtom++;
    }
    // Trim trailing whitespace so alignment computation is correct.
    // Don't trim trailing image atoms (they're not whitespace).
    while (lineAtoms.length > 0 && lineAtoms[lineAtoms.length - 1].isSpace) {
      const drop = lineAtoms.pop()!;
      lineWidth -= drop.width;
    }

    // Reassemble the line into `ParagraphSegment[]`. Adjacent text
    // atoms with identical properties merge; image atoms remain
    // standalone.
    const merged: ParagraphSegment[] = [];
    for (const atom of lineAtoms) {
      if (atom.isImage) {
        merged.push({
          type: "image",
          content: atom.imageContent!,
          properties: atom.properties
        });
        continue;
      }
      const last = merged[merged.length - 1];
      const lastIsText = last && !("type" in last);
      if (lastIsText && (last as TextSegment).properties === atom.properties) {
        merged[merged.length - 1] = {
          text: (last as TextSegment).text + atom.text!,
          properties: atom.properties
        };
      } else {
        merged.push({ text: atom.text!, properties: atom.properties });
      }
    }

    lines.push(merged);
    slots.push({ xOffset: lineXOffset, width: usable });
    lineIdx++;

    if (lineIdx > 100_000) {
      // Defensive — degenerate inputs shouldn't loop the engine.
      break;
    }
  }

  return { lines, slots };
}

function wrapSegmentsToLines(
  segments: ParagraphSegment[],
  availableWidth: number,
  firstLineIndent: number,
  headingScale: number,
  options: FullLayoutOptions | undefined
): ParagraphSegment[][] {
  const lines: ParagraphSegment[][] = [];
  let currentLine: ParagraphSegment[] = [];
  let currentLineWidth = 0;
  let isFirstLine = true;
  let effectiveWidth = availableWidth - firstLineIndent;

  const flushLine = (): void => {
    lines.push(currentLine);
    currentLine = [];
    currentLineWidth = 0;
    if (isFirstLine) {
      isFirstLine = false;
      effectiveWidth = availableWidth;
    }
  };

  for (const segment of segments) {
    if ("type" in segment && segment.type === "image") {
      // Inline images are unbreakable atoms.  Width comes from the
      // source EMU; if the image alone exceeds the line we still
      // place it (avoids losing content) — the renderer will overflow
      // visually on that line, matching Word's behaviour for
      // oversized inline images.
      const imageWidth = emuToPt(segment.content.width);
      const fitsCurrent =
        currentLineWidth + imageWidth <= effectiveWidth || currentLine.length === 0;
      if (!fitsCurrent) {
        flushLine();
      }
      currentLine.push(segment);
      currentLineWidth += imageWidth;
      continue;
    }

    const text = segment.text;
    const fontSize = getRunFontSizePt(segment.properties) * headingScale;
    const fontName = resolveRunFontName(segment.properties);
    const segmentWidth = measureLayoutText(
      text,
      fontName,
      fontSize,
      options,
      segment.properties?.bold,
      segment.properties?.italic
    );

    if (currentLineWidth + segmentWidth <= effectiveWidth) {
      // Whole segment fits on the current line — fast path.
      currentLine.push(segment);
      currentLineWidth += segmentWidth;
    } else {
      // Segment does not fit — split it into words and wrap. The inner
      // loop's `currentLine.length === 0 && bufferedText.length === 0`
      // guard guarantees at least one word per line (preventing a dead
      // loop when even a single word is wider than the line).
      const words = text.split(/(\s+)/);
      let bufferedText = "";
      let bufferedWidth = 0;

      for (const word of words) {
        const wordWidth = measureLayoutText(
          word,
          fontName,
          fontSize,
          options,
          segment.properties?.bold,
          segment.properties?.italic
        );
        if (
          currentLineWidth + bufferedWidth + wordWidth <= effectiveWidth ||
          (currentLine.length === 0 && bufferedText.length === 0)
        ) {
          bufferedText += word;
          bufferedWidth += wordWidth;
        } else {
          if (bufferedText.length > 0) {
            currentLine.push({ text: bufferedText, properties: segment.properties });
          }
          flushLine();
          bufferedText = word;
          bufferedWidth = wordWidth;
        }
      }
      if (bufferedText.length > 0) {
        currentLine.push({ text: bufferedText, properties: segment.properties });
        currentLineWidth += bufferedWidth;
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
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
    return base * 0.65;
  }
  return base;
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
