/**
 * Layout Document Model
 *
 * Structured output of the layout engine. Contains positioned elements
 * that can be consumed by any renderer (SVG, PDF, Canvas, etc.).
 *
 * The layout engine (`layout.ts`) produces this model from a DocxDocument.
 * Renderers consume it to produce visual output.
 *
 * Coverage: every variant of `BodyContent` from `../types` produces a
 * corresponding `PageContent` variant. The compile-time exhaustiveness
 * check in `layout-full.ts` enforces this — adding a new BodyContent
 * type is a build error until a corresponding PageContent variant is
 * added here and a layout function is wired up.
 */

/** A rectangle in page coordinates. */
export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A positioned text run within a line box. */
export interface PositionedRun {
  readonly type?: "text"; // optional discriminator (default = text)
  readonly text: string;
  readonly x: number; // x offset from line start
  readonly width: number;
  readonly font: string;
  readonly fontSize: number; // points (already scaled for sub/superscript)
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: string; // hex RGB
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  /**
   * Vertical alignment relative to the line's baseline. When
   * `"superscript"` or `"subscript"`, the run's `fontSize` is already
   * shrunk (~0.65× of the source size) and renderers must shift the
   * draw baseline by `±fontSize × 0.33` so the glyphs sit above /
   * below the surrounding text in the conventional way.
   */
  readonly verticalAlign?: "superscript" | "subscript";
  /**
   * Extra advance to add after every character, in points, for a justified line.
   *
   * `w:jc="both"` stretches a line to the full column width. Latin does that by
   * widening the spaces between words ({@link wordSpacing}), but East Asian text
   * has no spaces to widen — the convention there is to distribute the slack
   * between characters instead, which is what this expresses. A line of Chinese
   * could not be justified at all without it, and `w:jc="both"` rendered as
   * left-aligned.
   *
   * `width` already includes the total this adds, so a caller measuring or
   * hit-testing the run needs no correction. Renderers apply it with PDF's `Tc`
   * operator or SVG's `letter-spacing`.
   */
  readonly charSpacing?: number;
  /**
   * Extra advance to add to every space character, in points, for a justified
   * line.
   *
   * The Latin half of the same mechanism. `width` already includes it.
   * Renderers apply it with PDF's `Tw` operator or SVG's `word-spacing`.
   */
  readonly wordSpacing?: number;
}

/**
 * A positioned inline image within a line box. Width and height are
 * already in points (the layout engine converts from EMU). `data` /
 * `mimeType` come from the document's image registry — a missing rId
 * yields an empty `data` byte array so renderers can draw a
 * placeholder without crashing.
 */
export interface PositionedInlineImage {
  readonly type: "image";
  readonly x: number; // x offset from line start
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly altText?: string;
}

/**
 * Item within a `LineBox` — either a positioned text run or an
 * inline image. The latter is rendered alongside text using the same
 * line's baseline.
 */
export type LineBoxItem = PositionedRun | PositionedInlineImage;

/** A line box — a single line of text within a paragraph. */
export interface LineBox {
  readonly y: number; // y offset from paragraph start
  readonly height: number;
  readonly baseline: number; // distance from top of line to baseline
  /**
   * Items on the line. For backwards-compatibility the field is still
   * named `runs`, but its element type now includes inline images.
   * Renderers that previously assumed every entry was a text run
   * should narrow on `item.type === "image"` first.
   */
  readonly runs: readonly LineBoxItem[];
  readonly alignment: "left" | "center" | "right" | "justify";
}

/** A positioned paragraph on a page. */
/** A drawn border edge: stroke width in points, `RRGGBB` colour, and its gap from the content. */
export interface LayoutBorderEdge {
  readonly width: number;
  readonly color: string;
  /** Gap between the border and the content it surrounds, in points (`w:space`). */
  readonly space: number;
}

/** The four drawable edges of a block. */
export interface LayoutBorders {
  readonly top?: LayoutBorderEdge;
  readonly bottom?: LayoutBorderEdge;
  readonly left?: LayoutBorderEdge;
  readonly right?: LayoutBorderEdge;
}

/**
 * How far a block's decoration is inset from its `rect`, in points.
 *
 * Borders and shading surround the *text*, not the paragraph's space-before and
 * space-after, and they span the indented text column rather than the full
 * content width. Expressing that as insets rather than as a second rectangle is
 * deliberate: `rect` is translated when a paragraph is laid inside a table cell,
 * a text box or a footnote, and it is resized when a paragraph is split across a
 * page break. Anything carrying its own copy of the position silently desyncs at
 * every one of those points — a split shaded paragraph painted its full
 * unsplit height on both pages.
 */
export interface LayoutDecorationInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface LayoutParagraph {
  readonly type: "paragraph";
  readonly rect: LayoutRect;
  readonly lines: readonly LineBox[];
  readonly sourceIndex: number; // index in doc.body
  /**
   * Paragraph borders (`w:pBdr`), already resolved to stroke widths and colours.
   *
   * This is what a themed heading rule, a block quote's left bar and a code
   * block's frame are made of, so a renderer that ignores it cannot reproduce
   * any of them.
   */
  readonly borders?: LayoutBorders;
  /** Paragraph background shading (`w:shd`) as a bare `RRGGBB` hex string. */
  readonly backgroundColor?: string;
  /** Where the borders and shading sit relative to `rect`. */
  readonly decorationInsets?: LayoutDecorationInsets;
  /**
   * Footnote / endnote ids referenced from each line, parallel to `lines`.
   *
   * A paragraph split across a page boundary keeps only the entries for the lines
   * it kept, so each note is claimed by the page its reference actually landed
   * on rather than by the page the paragraph began on.
   */
  readonly lineNoteIds?: readonly (readonly number[])[];
  /**
   * Indices of lines after which a `w:br w:type="page"` demands a page break.
   *
   * The break belongs *inside* the paragraph: the lines before it stay where they
   * are and the rest continues on the next page. Treating the paragraph as a unit
   * and moving all of it put the text preceding the break on the wrong page.
   */
  readonly pageBreakAfterLines?: readonly number[];
  /**
   * Bookmark names starting on each line, parallel to `lines`.
   *
   * Sliced with the lines when a paragraph is split, so a bookmark in the part
   * that spilled onto the next page resolves to that page.
   */
  readonly lineBookmarks?: readonly (readonly string[])[];
}

/** A positioned table on a page. */
export interface LayoutTable {
  readonly type: "table";
  readonly rect: LayoutRect;
  readonly cells: readonly LayoutTableCell[];
  readonly sourceIndex: number;
}

/** A positioned table cell. */
export interface LayoutTableCell {
  /**
   * Position within the table, on both axes.
   *
   * Renderers add the table's own origin. Emitting an absolute `y` here while
   * `x` stayed table-relative made them add the table's `y` twice, so every
   * table that did not begin at the top of a page drew its contents that far
   * below where the layout had placed them.
   */
  readonly rect: LayoutRect;
  readonly row: number;
  readonly col: number;
  readonly content: readonly (LayoutParagraph | LayoutTable)[];
  /** Exact-height row whose overflowing content must be clipped to this cell. */
  readonly clipToBounds?: boolean;
  readonly backgroundColor?: string;
  readonly borders?: {
    readonly top?: { width: number; color: string };
    readonly bottom?: { width: number; color: string };
    readonly left?: { width: number; color: string };
    readonly right?: { width: number; color: string };
  };
}

/** A positioned image on a page. */
export interface LayoutImage {
  readonly type: "image";
  readonly rect: LayoutRect;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly altText?: string;
  readonly sourceIndex: number;
}

/**
 * How a {@link LayoutFloat} interacts with the surrounding text flow.
 * Mirrors ECMA-376 `<wp:wrapXxx>` elements without prescribing a
 * particular implementation: the layout engine consumes `topAndBottom`
 * to push the in-flow cursor below the float; other styles are
 * preserved here for downstream renderers (or future per-line
 * exclusion-zone wrapping) and currently degrade to no wrap on the
 * built-in body cursor.
 */
export interface LayoutFloatWrap {
  readonly style: "square" | "tight" | "through" | "topAndBottom" | "none";
  /** Which side(s) text may flow on (square/tight/through only). */
  readonly side?: "bothSides" | "left" | "right" | "largest";
  /** Padding around the float in points. */
  readonly margins?: {
    readonly top?: number;
    readonly bottom?: number;
    readonly left?: number;
    readonly right?: number;
  };
}

/** A positioned floating object on a page. */
export interface LayoutFloat {
  readonly type: "float";
  readonly rect: LayoutRect;
  readonly content: LayoutImage | LayoutParagraph;
  readonly behindText?: boolean;
  /**
   * Wrap behaviour declared by the source. Layout consumes
   * `topAndBottom` to advance the body cursor over the float; other
   * styles are recorded but the body wrap is not performed (renderers
   * may implement their own per-line exclusion if required).
   */
  readonly wrap?: LayoutFloatWrap;
  readonly sourceIndex: number;
}

/** A positioned text-box (frame containing flowed body content). */
export interface LayoutTextBox {
  readonly type: "textBox";
  readonly rect: LayoutRect;
  /** Inner content already positioned relative to `rect`. */
  readonly content: readonly PageContent[];
  readonly border?: { readonly width: number; readonly color: string };
  readonly background?: string;
  readonly sourceIndex: number;
}

/** A positioned drawing shape (rectangle, ellipse, callout, …). */
export interface LayoutShape {
  readonly type: "shape";
  readonly rect: LayoutRect;
  /** OOXML preset shape type (e.g. "rect", "ellipse", "rightArrow"). */
  readonly preset: string;
  readonly fillColor?: string;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
  /** Optional inner text-content positioned relative to the shape. */
  readonly textContent?: readonly PageContent[];
  readonly sourceIndex: number;
}

/** A positioned chart placeholder. */
export interface LayoutChart {
  readonly type: "chart";
  readonly rect: LayoutRect;
  /** Chart family — selects the renderer to use. */
  readonly chartKind: "chart" | "chartEx";
  /** Optional pre-rendered SVG (eagerly-rendered charts). */
  readonly svg?: string;
  /** Title from the source chart, if any. */
  readonly title?: string;
  readonly altText?: string;
  /**
   * Original `ChartContent` / `ChartExContent` payload from the source
   * document. Carried so renderers (PDF, custom) can hand the rich data
   * to plug-in chart renderers without re-walking the docx body.
   *
   * Typed as `unknown` here to keep `layout-model` free of optional
   * `import type { ChartContent }` cycles; consumers narrow as needed.
   */
  readonly source?: unknown;
  readonly sourceIndex: number;
}

/** A positioned structured-document-tag (transparent flow container). */
export interface LayoutSdt {
  readonly type: "sdt";
  readonly rect: LayoutRect;
  readonly content: readonly PageContent[];
  readonly tag?: string;
  readonly alias?: string;
  readonly sourceIndex: number;
}

/** A positioned math block. */
export interface LayoutMath {
  readonly type: "math";
  readonly rect: LayoutRect;
  /** Plain-text fallback — always present. */
  readonly text: string;
  /** MathML rendering — present when conversion succeeded. */
  readonly mathML?: string;
  readonly sourceIndex: number;
}

/** A positioned check-box glyph. */
export interface LayoutCheckBox {
  readonly type: "checkBox";
  readonly rect: LayoutRect;
  readonly checked: boolean;
  /** Glyph used for the box (Unicode fallback when font is unavailable). */
  readonly glyph: string;
  readonly fontSize: number;
  readonly sourceIndex: number;
}

/** A positioned table-of-contents stub. */
export interface LayoutTableOfContents {
  readonly type: "tableOfContents";
  readonly rect: LayoutRect;
  /** Cached entries when the source document has them; empty otherwise. */
  readonly entries: readonly LayoutParagraph[];
  readonly sourceIndex: number;
}

/**
 * Embedded foreign content (`<w:altChunk>`). Layout cannot interpret HTML
 * / RTF / etc.; consumers either render the foreign payload themselves
 * (HTML inside an `<svg:foreignObject>`, for instance) or fall back to
 * a placeholder.
 */
export interface LayoutAltChunk {
  readonly type: "altChunk";
  readonly rect: LayoutRect;
  readonly contentType: string;
  readonly fileName?: string;
  readonly sourceIndex: number;
}

/**
 * Opaque drawing markup that the document model could not normalise.
 * Carried verbatim so high-fidelity renderers (e.g. an OOXML→OOXML
 * pipeline) can preserve the source markup.
 */
export interface LayoutOpaqueDrawing {
  readonly type: "opaqueDrawing";
  readonly rect: LayoutRect;
  readonly rawXml: string;
  readonly sourceIndex: number;
}

/** Content that appears on a single page. */
export type PageContent =
  | LayoutParagraph
  | LayoutTable
  | LayoutImage
  | LayoutFloat
  | LayoutTextBox
  | LayoutShape
  | LayoutChart
  | LayoutSdt
  | LayoutMath
  | LayoutCheckBox
  | LayoutTableOfContents
  | LayoutAltChunk
  | LayoutOpaqueDrawing;

/** Page geometry (margins, dimensions). */
export interface PageGeometry {
  readonly width: number; // total page width in points
  readonly height: number; // total page height in points
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  /** Usable content area. */
  readonly contentWidth: number;
  readonly contentHeight: number;
  /**
   * Distance of the header band from the top edge of the page, in
   * points (ECMA-376 `pgMar.header`). Header paragraphs are laid out
   * starting at this y-offset from the page top.
   */
  readonly headerOffset: number;
  /**
   * Distance of the footer band from the bottom edge of the page, in
   * points (ECMA-376 `pgMar.footer`). The footer band's top sits at
   * `height - footerOffset`.
   */
  readonly footerOffset: number;
}

/** A fully laid-out page. */
export interface LayoutPage {
  readonly pageNumber: number;
  readonly geometry: PageGeometry;
  readonly content: readonly PageContent[];
  /**
   * Header band content: paragraphs and (uncommonly) tables, laid out
   * with y starting at the section's `pgMar.header` distance from the
   * page top, x measured from `marginLeft`. Renderers translate the
   * band into page coordinates by treating layout-y as relative to
   * the page top (not the content area). `LayoutTable.cells` carry
   * absolute x relative to the band's origin.
   */
  readonly header?: readonly (LayoutParagraph | LayoutTable)[];
  /** Footer band content; symmetric to `header`. */
  readonly footer?: readonly (LayoutParagraph | LayoutTable)[];
  readonly footnoteArea?: readonly LayoutParagraph[];
  /**
   * Visual separator drawn between body and footnote area
   * (ECMA-376 §17.11.10).
   *
   * - `kind: "separator"` — drawn on pages that introduce their own
   *   newly-referenced footnotes; per Microsoft Word convention this
   *   is a short horizontal rule taking ~⅓ of the content width.
   * - `kind: "continuationSeparator"` — drawn on pages whose
   *   footnote area only carries notes deferred from a previous page;
   *   the rule spans the full content width to signal continuation.
   *
   * `y` is in page-absolute coordinates (same convention as
   * `footnoteArea[i].rect.y`) and points at the line's vertical
   * position. Renderers stroke a 0.5pt black line at this y;
   * the rule's left edge is `geometry.marginLeft` and its width is
   * `kind === "separator" ? geometry.contentWidth / 3 :
   * geometry.contentWidth`.
   *
   * Absent on pages with no footnote content.
   */
  readonly footnoteSeparator?: {
    readonly y: number;
    readonly kind: "separator" | "continuationSeparator";
  };
}

/** The complete layout result — a document broken into positioned pages. */
export interface LayoutDocument {
  readonly pages: readonly LayoutPage[];
  readonly totalPages: number;
  /** Bookmark → page number mapping. */
  readonly bookmarkPages: ReadonlyMap<string, number>;
  /** Section boundaries (page indices where sections start). */
  readonly sectionBreaks: readonly number[];
}
