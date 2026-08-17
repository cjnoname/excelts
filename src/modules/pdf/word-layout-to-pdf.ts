/**
 * Word `LayoutDocument` → PDF translation layer.
 *
 * Part of the Word→PDF bridge family (used only by `word-bridge.ts`).
 * Consumes the fully-positioned `LayoutDocument` produced by
 * `@word/layout/layout-full` and emits PDF operators via
 * `PdfDocumentBuilder`. Because it consumes Word's layout model, this
 * file is one of the bridge files permitted to import from `@word`
 * (see AGENTS.md). Coordinate translation is the only logic
 * here — every flow decision (line wrapping, page breaks, table cell
 * sizing, float positioning, footnote placement) has already been
 * resolved by the layout engine.
 *
 * The Word layout coordinate system uses points with origin at the
 * top-left of the **content area** of each page (not the page itself),
 * with Y increasing downwards. The PDF coordinate system uses points
 * with origin at the bottom-left of the page and Y increasing upwards.
 * `pdfY = pageHeight - (geometry.marginTop + layoutY) - lineHeight`,
 * with the per-element `lineHeight` baked into rect.height for non-
 * paragraph variants and per-line for paragraphs.
 */

import type { PdfPageBuilder } from "@pdf/builder/document-builder";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import type { PdfFontConfig } from "@pdf/font/font-config";
import type { PdfColor } from "@pdf/types";
import { hexToRgb01 } from "@utils/theme-colors";
import type {
  LayoutAltChunk,
  LayoutChart,
  LayoutCheckBox,
  LayoutDocument,
  LayoutFloat,
  LayoutImage,
  LayoutMath,
  LayoutBorderEdge,
  LayoutOpaqueDrawing,
  LayoutPage,
  LayoutParagraph,
  LayoutSdt,
  LayoutShape,
  LayoutTable,
  LayoutTableOfContents,
  LayoutTextBox,
  LineBox,
  PageContent,
  PageGeometry,
  PositionedInlineImage,
  PositionedRun
} from "@word/layout/layout-model";

/** Options for rendering a LayoutDocument into a PdfDocumentBuilder. */
export interface RenderLayoutOptions {
  /** Document title (sets PDF metadata). */
  readonly title?: string;
  /** Document author (sets PDF metadata). */
  readonly author?: string;
  /** Document subject. */
  readonly subject?: string;
  /** Document creator (defaults to "documonster"). */
  readonly creator?: string;
  /** Default font family used when a paragraph run has no explicit font. */
  readonly defaultFont?: string;
  /** Default font size in points. */
  readonly defaultFontSize?: number;
  /** Font families compiled before the first PDF page is created. */
  readonly fonts?: PdfFontConfig;
  /**
   * Receive non-fatal font diagnostics raised while building the PDF.
   *
   * @see `PdfExportOptions.onWarning`
   */
  readonly onWarning?: (message: string) => void;
  /**
   * Optional pluggable chart renderer. Receives the bounding rect
   * (already translated into PDF coordinates) and the layout chart
   * info; the implementation paints onto `page` directly.
   *
   * Return value semantics:
   * - `true` (or `void`) — the renderer handled this chart; no further
   *   fallback drawing happens.
   * - `false` — the renderer declined this chart (e.g. it only knows
   *   how to draw a specific chart family); the translator falls back
   *   to its built-in path (inline `LayoutChart.svg` if present,
   *   otherwise a placeholder box with the chart title).
   *
   * The boolean variant lets a chart-aware host plug in a renderer
   * that handles classic `<c:chart>` while still letting `chartEx`
   * variants fall through to the simple placeholder.
   */
  readonly chartRenderer?: (
    chart: LayoutChart,
    page: PdfPageBuilder,
    rect: { x: number; y: number; width: number; height: number }
  ) => boolean | void;
}

const BLACK: PdfColor = { r: 0, g: 0, b: 0 };

/**
 * Render a `LayoutDocument` into a freshly-constructed
 * `PdfDocumentBuilder`. Call `.build()` on the returned builder to get
 * the final PDF bytes; alternatively use {@link layoutToPdfBytes}.
 */
export function renderLayoutDocumentToPdf(
  layout: LayoutDocument,
  options: RenderLayoutOptions = {}
): PdfDocumentBuilder {
  const builder = new PdfDocumentBuilder({ fonts: options.fonts });
  if (options.onWarning) {
    builder.onWarning(options.onWarning);
  }
  if (options.title || options.author || options.subject) {
    builder.setMetadata({
      title: options.title,
      author: options.author,
      subject: options.subject,
      creator: options.creator
    });
  }

  for (const page of layout.pages) {
    const pdfPage = builder.addPage({
      width: page.geometry.width,
      height: page.geometry.height
    });
    renderLayoutPage(pdfPage, page, options);
  }

  return builder;
}

/** Convenience: render and immediately serialise to PDF bytes. */
export async function layoutToPdfBytes(
  layout: LayoutDocument,
  options: RenderLayoutOptions = {}
): Promise<Uint8Array> {
  const builder = renderLayoutDocumentToPdf(layout, options);
  return builder.build();
}

// =============================================================================
// Internal: per-page rendering
// =============================================================================

function renderLayoutPage(
  pdfPage: PdfPageBuilder,
  page: LayoutPage,
  opts: RenderLayoutOptions
): void {
  // Header / footer paragraphs are positioned with layout-y already
  // expressed as a page-absolute offset (the layout engine adds
  // `pgMar.header` to header content and starts footer content at
  // `pageHeight - pgMar.footer`). Renderers therefore treat header /
  // footer geometry as if the page had zero top margin so layout-y
  // maps straight to the absolute page position via `toPdfY`.
  const bandGeometry: PageGeometry = { ...page.geometry, marginTop: 0 };
  if (page.header) {
    for (const item of page.header) {
      renderHeaderFooterItem(pdfPage, item, bandGeometry, opts);
    }
  }
  // Body
  for (const item of page.content) {
    renderPageContent(pdfPage, item, page.geometry, opts);
  }
  if (page.footer) {
    for (const item of page.footer) {
      renderHeaderFooterItem(pdfPage, item, bandGeometry, opts);
    }
  }
  // Footnote area (rendered above the footer band). The optional
  // separator above it follows ECMA-376 §17.11.10's convention:
  //   - "separator" → ⅓-content-width rule (page introduces fresh notes)
  //   - "continuationSeparator" → full-content-width rule (deferred from
  //     previous page).
  if (page.footnoteSeparator) {
    const sep = page.footnoteSeparator;
    const xStart = page.geometry.marginLeft;
    const ruleWidth =
      sep.kind === "separator" ? page.geometry.contentWidth / 3 : page.geometry.contentWidth;
    const yPdf = toPdfY({ ...page.geometry, marginTop: 0 } as PageGeometry, sep.y);
    pdfPage.drawLine({
      x1: xStart,
      y1: yPdf,
      x2: xStart + ruleWidth,
      y2: yPdf,
      color: BLACK,
      lineWidth: 0.5
    });
  }
  if (page.footnoteArea) {
    for (const para of page.footnoteArea) {
      renderParagraph(pdfPage, para, bandGeometry, opts);
    }
  }
}

/** Dispatch helper for `header` / `footer` whose entries can be paragraphs or tables. */
function renderHeaderFooterItem(
  pdfPage: PdfPageBuilder,
  item: LayoutParagraph | LayoutTable,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  if (item.type === "paragraph") {
    renderParagraph(pdfPage, item, geometry, opts);
  } else {
    renderTable(pdfPage, item, geometry, opts);
  }
}

function renderPageContent(
  pdfPage: PdfPageBuilder,
  item: PageContent,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  switch (item.type) {
    case "paragraph":
      renderParagraph(pdfPage, item, geometry, opts);
      break;
    case "table":
      renderTable(pdfPage, item, geometry, opts);
      break;
    case "image":
      renderImage(pdfPage, item, geometry);
      break;
    case "float":
      renderFloat(pdfPage, item, geometry, opts);
      break;
    case "textBox":
      renderTextBox(pdfPage, item, geometry, opts);
      break;
    case "shape":
      renderShape(pdfPage, item, geometry, opts);
      break;
    case "chart":
      renderChart(pdfPage, item, geometry, opts);
      break;
    case "sdt":
      renderSdt(pdfPage, item, geometry, opts);
      break;
    case "math":
      renderMath(pdfPage, item, geometry, opts);
      break;
    case "checkBox":
      renderCheckBox(pdfPage, item, geometry);
      break;
    case "tableOfContents":
      renderToc(pdfPage, item, geometry, opts);
      break;
    case "altChunk":
      renderAltChunkPlaceholder(pdfPage, item, geometry);
      break;
    case "opaqueDrawing":
      renderOpaqueDrawingPlaceholder(pdfPage, item, geometry);
      break;
    default: {
      const _exhaustive: never = item;
      throw new Error(
        `renderLayoutDocumentToPdf: unhandled PageContent ${(_exhaustive as { type: string }).type}`
      );
    }
  }
}

// =============================================================================
// Coordinate helpers
// =============================================================================

/**
 * Translate a layout-space (top-left, Y-down) point to PDF space
 * (bottom-left, Y-up). Layout positions are stored relative to the
 * content area; we add the page margin to get the page-absolute layout
 * coordinate, then flip Y.
 */
function toPdfY(geometry: PageGeometry, layoutY: number): number {
  return geometry.height - geometry.marginTop - layoutY;
}

function toPdfX(geometry: PageGeometry, layoutX: number): number {
  return geometry.marginLeft + layoutX;
}

function hexToColor(hex: string | undefined): PdfColor | undefined {
  return hexToRgb01(hex) ?? undefined;
}

// =============================================================================
// Renderers — primitive variants
// =============================================================================

function renderParagraph(
  pdfPage: PdfPageBuilder,
  para: LayoutParagraph,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  // Shading first, then borders, then text — so a code block's background sits
  // behind its frame and its frame behind its glyphs.
  renderParagraphDecoration(pdfPage, para, geometry);
  for (const line of para.lines) {
    renderLine(pdfPage, para, line, geometry, opts);
  }
}

/**
 * Paint a paragraph's shading and borders (`w:shd`, `w:pBdr`).
 *
 * These are what a themed heading rule, a block quote's left bar and a code
 * block's frame are drawn from. Each edge is offset outwards by its own
 * `w:space`, which is how Word separates a rule from the text above it.
 */
function renderParagraphDecoration(
  pdfPage: PdfPageBuilder,
  para: LayoutParagraph,
  geometry: PageGeometry
): void {
  const insets = para.decorationInsets;
  if (!insets) {
    return;
  }
  // Derived from `rect`, which the caller has already translated (a cell, a text
  // box) and which a page split has already resized.
  const box = {
    x: para.rect.x + insets.left,
    y: para.rect.y + insets.top,
    width: Math.max(0, para.rect.width - insets.left - insets.right),
    height: Math.max(0, para.rect.height - insets.top - insets.bottom)
  };

  if (para.backgroundColor) {
    const fill = hexToColor(para.backgroundColor);
    if (fill) {
      const pad = para.borders?.left?.space ?? 0;
      pdfPage.drawRect({
        x: toPdfX(geometry, box.x - pad),
        y: toPdfY(geometry, box.y + box.height),
        width: box.width + pad * 2,
        height: box.height,
        fill
      });
    }
  }

  const borders = para.borders;
  if (!borders) {
    return;
  }
  const left = toPdfX(geometry, box.x);
  const right = toPdfX(geometry, box.x + box.width);
  const top = toPdfY(geometry, box.y);
  const bottom = toPdfY(geometry, box.y + box.height);

  const stroke = (edge: LayoutBorderEdge, x1: number, y1: number, x2: number, y2: number): void => {
    const color = hexToColor(edge.color) ?? BLACK;
    pdfPage.drawLine({ x1, y1, x2, y2, color, lineWidth: edge.width });
  };

  if (borders.top) {
    const y = top + borders.top.space;
    stroke(borders.top, left, y, right, y);
  }
  if (borders.bottom) {
    const y = bottom - borders.bottom.space;
    stroke(borders.bottom, left, y, right, y);
  }
  if (borders.left) {
    const x = left - borders.left.space;
    stroke(borders.left, x, bottom, x, top);
  }
  if (borders.right) {
    const x = right + borders.right.space;
    stroke(borders.right, x, bottom, x, top);
  }
}

function renderLine(
  pdfPage: PdfPageBuilder,
  para: LayoutParagraph,
  line: LineBox,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  // Layout y stores the top-of-line offset within the paragraph; baseline
  // is the distance from that top to the glyph baseline. PDF wants the
  // baseline as the y argument to drawText.
  const baselineLayoutY = para.rect.y + line.y + line.baseline;
  const baselinePdfY = toPdfY(geometry, baselineLayoutY);
  // Top edge of the line for inline image placement.
  const lineTopLayoutY = para.rect.y + line.y;

  for (const item of line.runs) {
    if (item.type === "image") {
      renderInlineImage(pdfPage, item, para.rect.x, lineTopLayoutY, line.height, geometry);
    } else {
      renderRun(pdfPage, item, para.rect.x, baselinePdfY, geometry, opts);
    }
  }
}

function renderInlineImage(
  pdfPage: PdfPageBuilder,
  item: PositionedInlineImage,
  paragraphX: number,
  lineTopLayoutY: number,
  lineHeight: number,
  geometry: PageGeometry
): void {
  if (item.data.length === 0) {
    return;
  }
  const format = inferImageFormat(item.mimeType);
  if (!format) {
    return;
  }
  const x = toPdfX(geometry, paragraphX + item.x);
  // Inline images sit on the line's baseline; translate the layout
  // top-of-line into PDF coordinates and place the image's bottom
  // edge there. When the image is shorter than the line, it
  // bottom-aligns within the line — matches Word's default for inline
  // images.
  const imageBottomLayoutY = lineTopLayoutY + Math.min(lineHeight, item.height);
  const yPdf = toPdfY(geometry, imageBottomLayoutY);
  pdfPage.drawImage({
    data: item.data,
    format,
    x,
    y: yPdf,
    width: item.width,
    height: item.height
  });
}

function renderRun(
  pdfPage: PdfPageBuilder,
  run: PositionedRun,
  paragraphX: number,
  baselinePdfY: number,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  const x = toPdfX(geometry, paragraphX + run.x);
  const fontFamily = run.font || opts.defaultFont || "Helvetica";
  const fontSize = run.fontSize || opts.defaultFontSize || 11;
  const color = hexToColor(run.color) ?? BLACK;

  // Sub/superscript: shift the draw baseline by ⅓ of the (already
  // scaled) font size. Word's actual offset is closer to half the
  // surrounding-text size, but applying a third here matches the
  // visual position users see in modern Word builds well enough for
  // generated PDFs and keeps the run inside the line box even when
  // the surrounding text is the same size as the source.
  let drawBaselineY = baselinePdfY;
  if (run.verticalAlign === "superscript") {
    drawBaselineY = baselinePdfY + fontSize * 0.33;
  } else if (run.verticalAlign === "subscript") {
    drawBaselineY = baselinePdfY - fontSize * 0.33;
  }

  if (run.text.length > 0) {
    pdfPage.drawText(run.text, {
      x,
      y: drawBaselineY,
      fontFamily,
      fontSize,
      bold: run.bold,
      italic: run.italic,
      color
    });
  }

  // Underline / strikethrough — draw 1pt-thick lines at the conventional
  // offsets relative to the (possibly shifted) baseline.
  if (run.underline && run.text.length > 0) {
    const underlineY = drawBaselineY - fontSize * 0.12;
    pdfPage.drawLine({
      x1: x,
      y1: underlineY,
      x2: x + run.width,
      y2: underlineY,
      color,
      lineWidth: Math.max(0.5, fontSize * 0.05)
    });
  }
  if (run.strikethrough && run.text.length > 0) {
    const strikeY = drawBaselineY + fontSize * 0.3;
    pdfPage.drawLine({
      x1: x,
      y1: strikeY,
      x2: x + run.width,
      y2: strikeY,
      color,
      lineWidth: Math.max(0.5, fontSize * 0.05)
    });
  }
}

function renderTable(
  pdfPage: PdfPageBuilder,
  table: LayoutTable,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  for (const cell of table.cells) {
    const xPdf = toPdfX(geometry, table.rect.x + cell.rect.x);
    const yPdf = toPdfY(geometry, table.rect.y + cell.rect.y + cell.rect.height);
    const w = cell.rect.width;
    const h = cell.rect.height;

    // Background
    if (cell.backgroundColor) {
      const fill = hexToColor(cell.backgroundColor);
      if (fill) {
        pdfPage.drawRect({ x: xPdf, y: yPdf, width: w, height: h, fill });
      }
    }

    // Borders
    const borders = cell.borders;
    if (borders) {
      if (borders.top) {
        const c = hexToColor(borders.top.color) ?? BLACK;
        pdfPage.drawLine({
          x1: xPdf,
          y1: yPdf + h,
          x2: xPdf + w,
          y2: yPdf + h,
          color: c,
          lineWidth: borders.top.width
        });
      }
      if (borders.bottom) {
        const c = hexToColor(borders.bottom.color) ?? BLACK;
        pdfPage.drawLine({
          x1: xPdf,
          y1: yPdf,
          x2: xPdf + w,
          y2: yPdf,
          color: c,
          lineWidth: borders.bottom.width
        });
      }
      if (borders.left) {
        const c = hexToColor(borders.left.color) ?? BLACK;
        pdfPage.drawLine({
          x1: xPdf,
          y1: yPdf,
          x2: xPdf,
          y2: yPdf + h,
          color: c,
          lineWidth: borders.left.width
        });
      }
      if (borders.right) {
        const c = hexToColor(borders.right.color) ?? BLACK;
        pdfPage.drawLine({
          x1: xPdf + w,
          y1: yPdf,
          x2: xPdf + w,
          y2: yPdf + h,
          color: c,
          lineWidth: borders.right.width
        });
      }
    }

    // Cell content — paragraphs and nested tables. Cell-internal
    // coordinates need to be offset by the cell's origin within the
    // table's origin. We rebuild a virtual paragraph/table with rects
    // translated into the page coordinate space and reuse the top-level
    // renderer so stroke/decoration logic stays in one place.
    for (const inner of cell.content) {
      if (inner.type === "paragraph") {
        renderParagraph(
          pdfPage,
          {
            ...inner,
            rect: {
              ...inner.rect,
              x: table.rect.x + cell.rect.x + inner.rect.x,
              y: table.rect.y + cell.rect.y + inner.rect.y
            }
          },
          geometry,
          opts
        );
      } else {
        renderTable(
          pdfPage,
          {
            ...inner,
            rect: {
              ...inner.rect,
              x: table.rect.x + cell.rect.x + inner.rect.x,
              y: table.rect.y + cell.rect.y + inner.rect.y
            }
          },
          geometry,
          opts
        );
      }
    }
  }
}

function renderImage(pdfPage: PdfPageBuilder, img: LayoutImage, geometry: PageGeometry): void {
  if (img.data.length === 0) {
    return;
  }
  const format = inferImageFormat(img.mimeType);
  if (!format) {
    return;
  }
  const xPdf = toPdfX(geometry, img.rect.x);
  const yPdf = toPdfY(geometry, img.rect.y + img.rect.height);
  pdfPage.drawImage({
    data: img.data,
    format,
    x: xPdf,
    y: yPdf,
    width: img.rect.width,
    height: img.rect.height
  });
}

/**
 * Map a MIME string to the format tag accepted by
 * `pdfPage.drawImage`. Layout always normalises image media-type to
 * standard MIME (`image/png` / `image/jpeg` / …) before reaching the
 * renderer, so we only handle that form. Returns `null` for formats
 * the PDF builder cannot embed; callers skip those silently rather
 * than emit a corrupt XObject.
 */
function inferImageFormat(mimeType: string): "jpeg" | "png" | null {
  const lower = mimeType.toLowerCase();
  if (lower === "image/jpeg") {
    return "jpeg";
  }
  if (lower === "image/png") {
    return "png";
  }
  return null;
}

function renderFloat(
  pdfPage: PdfPageBuilder,
  float: LayoutFloat,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  if (float.content.type === "image") {
    renderImage(pdfPage, float.content, geometry);
  } else {
    renderParagraph(pdfPage, float.content, geometry, opts);
  }
}

function renderTextBox(
  pdfPage: PdfPageBuilder,
  tb: LayoutTextBox,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  // Outline / fill of the box itself
  const xPdf = toPdfX(geometry, tb.rect.x);
  const yPdf = toPdfY(geometry, tb.rect.y + tb.rect.height);
  const fill = tb.background ? hexToColor(tb.background) : undefined;
  const stroke = tb.border ? hexToColor(tb.border.color) : undefined;
  if (fill || stroke) {
    pdfPage.drawRect({
      x: xPdf,
      y: yPdf,
      width: tb.rect.width,
      height: tb.rect.height,
      fill,
      stroke,
      lineWidth: tb.border?.width ?? 0.75
    });
  }
  // Inner content positions are already in page coordinates because the
  // layout engine flowed them with the box's own width and stored
  // absolute offsets. We just dispatch through the same content
  // renderer.
  const innerGeometry: PageGeometry = {
    ...geometry,
    marginLeft: geometry.marginLeft + tb.rect.x,
    marginTop: geometry.marginTop + tb.rect.y
  };
  for (const inner of tb.content) {
    renderPageContent(pdfPage, inner, innerGeometry, opts);
  }
}

function renderShape(
  pdfPage: PdfPageBuilder,
  shape: LayoutShape,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  const xPdf = toPdfX(geometry, shape.rect.x);
  const yPdf = toPdfY(geometry, shape.rect.y + shape.rect.height);
  const fill = shape.fillColor ? hexToColor(shape.fillColor) : undefined;
  const stroke = shape.strokeColor ? hexToColor(shape.strokeColor) : undefined;
  const lineWidth = shape.strokeWidth ?? 0.75;

  if (shape.preset === "ellipse" || shape.preset === "oval") {
    pdfPage.drawEllipse({
      cx: xPdf + shape.rect.width / 2,
      cy: yPdf + shape.rect.height / 2,
      rx: shape.rect.width / 2,
      ry: shape.rect.height / 2,
      fill,
      stroke,
      lineWidth
    });
  } else if (shape.preset === "line") {
    pdfPage.drawLine({
      x1: xPdf,
      y1: yPdf + shape.rect.height,
      x2: xPdf + shape.rect.width,
      y2: yPdf,
      color: stroke ?? BLACK,
      lineWidth
    });
  } else {
    pdfPage.drawRect({
      x: xPdf,
      y: yPdf,
      width: shape.rect.width,
      height: shape.rect.height,
      fill,
      stroke,
      lineWidth
    });
  }

  if (shape.textContent && shape.textContent.length > 0) {
    const innerGeometry: PageGeometry = {
      ...geometry,
      marginLeft: geometry.marginLeft + shape.rect.x,
      marginTop: geometry.marginTop + shape.rect.y
    };
    for (const inner of shape.textContent) {
      renderPageContent(pdfPage, inner, innerGeometry, opts);
    }
  }
}

function renderChart(
  pdfPage: PdfPageBuilder,
  chart: LayoutChart,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  const xPdf = toPdfX(geometry, chart.rect.x);
  const yPdf = toPdfY(geometry, chart.rect.y + chart.rect.height);
  const rect = { x: xPdf, y: yPdf, width: chart.rect.width, height: chart.rect.height };

  if (opts.chartRenderer) {
    // `false` means the renderer declined; only `void`/`true` short-
    // circuits the fallback path so consumers can plug in a renderer
    // that only handles a subset of chart families without wiping out
    // the placeholder for the rest.
    const result = opts.chartRenderer(chart, pdfPage, rect);
    if (result !== false) {
      return;
    }
  }

  if (chart.svg) {
    try {
      pdfPage.drawSvg({
        svg: chart.svg,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      });
      return;
    } catch {
      // Fall through to placeholder if SVG can't be embedded.
    }
  }

  // Placeholder rectangle + title
  pdfPage.drawRect({
    ...rect,
    stroke: { r: 0.5, g: 0.5, b: 0.5 },
    lineWidth: 0.75
  });
  if (chart.title) {
    pdfPage.drawText(chart.title, {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      fontSize: 10,
      anchor: "middle",
      color: { r: 0.3, g: 0.3, b: 0.3 }
    });
  }
}

function renderSdt(
  pdfPage: PdfPageBuilder,
  sdt: LayoutSdt,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  // SDT is transparent: dispatch each child relative to the SDT origin.
  const innerGeometry: PageGeometry = {
    ...geometry,
    marginLeft: geometry.marginLeft + sdt.rect.x,
    marginTop: geometry.marginTop + sdt.rect.y
  };
  for (const inner of sdt.content) {
    renderPageContent(pdfPage, inner, innerGeometry, opts);
  }
}

function renderMath(
  pdfPage: PdfPageBuilder,
  math: LayoutMath,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  const xPdf = toPdfX(geometry, math.rect.x);
  const baselinePdfY = toPdfY(geometry, math.rect.y + math.rect.height * 0.8);
  pdfPage.drawText(math.text, {
    x: xPdf,
    y: baselinePdfY,
    fontFamily: opts.defaultFont ?? "Helvetica",
    fontSize: math.rect.height * 0.7,
    italic: true
  });
}

function renderCheckBox(pdfPage: PdfPageBuilder, cb: LayoutCheckBox, geometry: PageGeometry): void {
  const xPdf = toPdfX(geometry, cb.rect.x);
  const yPdf = toPdfY(geometry, cb.rect.y + cb.rect.height);
  const size = cb.rect.height * 0.85;
  pdfPage.drawRect({
    x: xPdf,
    y: yPdf,
    width: size,
    height: size,
    stroke: BLACK,
    lineWidth: 0.75
  });
  if (cb.checked) {
    // Draw a check mark using two line segments. Coordinates are in PDF
    // (Y up), so the visible "down-stroke" of the tick goes from a
    // higher y to a lower y on the left side, then back up on the right.
    const x1 = xPdf + size * 0.2;
    const y1 = yPdf + size * 0.5;
    const x2 = xPdf + size * 0.45;
    const y2 = yPdf + size * 0.25;
    const x3 = xPdf + size * 0.85;
    const y3 = yPdf + size * 0.75;
    pdfPage.drawLine({ x1, y1, x2, y2, color: BLACK, lineWidth: 1 });
    pdfPage.drawLine({ x1: x2, y1: y2, x2: x3, y2: y3, color: BLACK, lineWidth: 1 });
  }
}

function renderToc(
  pdfPage: PdfPageBuilder,
  toc: LayoutTableOfContents,
  geometry: PageGeometry,
  opts: RenderLayoutOptions
): void {
  // TOC entries already carry absolute (within content area) layout
  // positions, so they render directly.
  const innerGeometry: PageGeometry = {
    ...geometry,
    marginLeft: geometry.marginLeft + toc.rect.x,
    marginTop: geometry.marginTop + toc.rect.y
  };
  for (const para of toc.entries) {
    renderParagraph(pdfPage, para, innerGeometry, opts);
  }
}

function renderAltChunkPlaceholder(
  pdfPage: PdfPageBuilder,
  ac: LayoutAltChunk,
  geometry: PageGeometry
): void {
  const xPdf = toPdfX(geometry, ac.rect.x);
  const yPdf = toPdfY(geometry, ac.rect.y + ac.rect.height);
  pdfPage.drawRect({
    x: xPdf,
    y: yPdf,
    width: ac.rect.width,
    height: ac.rect.height,
    stroke: { r: 0.6, g: 0.6, b: 0.6 },
    lineWidth: 0.5
  });
  pdfPage.drawText(`[${ac.contentType}]`, {
    x: xPdf + ac.rect.width / 2,
    y: yPdf + ac.rect.height / 2,
    fontSize: 9,
    anchor: "middle",
    color: { r: 0.4, g: 0.4, b: 0.4 }
  });
}

function renderOpaqueDrawingPlaceholder(
  pdfPage: PdfPageBuilder,
  od: LayoutOpaqueDrawing,
  geometry: PageGeometry
): void {
  const xPdf = toPdfX(geometry, od.rect.x);
  const yPdf = toPdfY(geometry, od.rect.y + od.rect.height);
  pdfPage.drawRect({
    x: xPdf,
    y: yPdf,
    width: od.rect.width,
    height: od.rect.height,
    stroke: { r: 0.6, g: 0.6, b: 0.6 },
    lineWidth: 0.5
  });
  pdfPage.drawText("[drawing]", {
    x: xPdf + od.rect.width / 2,
    y: yPdf + od.rect.height / 2,
    fontSize: 9,
    anchor: "middle",
    color: { r: 0.4, g: 0.4, b: 0.4 }
  });
}
