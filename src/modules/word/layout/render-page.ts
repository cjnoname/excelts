/**
 * Word Document Page Renderer — SVG Output
 *
 * Renders DOCX document pages to SVG strings for visual preview.
 * Uses the layout engine for pagination and produces approximate
 * visual representations of document content.
 *
 * @stability experimental
 */

import { parseSvgAttributes, parseSvgNumberList } from "@utils/svg-lex";
import { SCRIPT_BASELINE_SHIFT_FACTOR } from "@word/layout/layout-constants";
import { layoutDocumentFull } from "@word/layout/layout-full";
import type {
  LayoutBorderEdge,
  LayoutChart,
  LayoutCheckBox,
  LayoutDocument,
  LayoutFloat,
  LayoutImage,
  LayoutMath,
  LayoutParagraph,
  LayoutRect,
  LayoutSdt,
  LayoutShape,
  LayoutTable,
  LayoutTableOfContents,
  LayoutTextBox,
  PageContent,
  PageGeometry
} from "@word/layout/layout-model";
import type { DocxDocument } from "@word/types";
import { xmlEncode, xmlEncodeAttr } from "@xml/encode";

// =============================================================================
// Public API Types
// =============================================================================

/** Options for rendering document pages to SVG. */
export interface RenderOptions {
  /** Output SVG width in pixels. If not set, derived from page dimensions. */
  readonly width?: number;
  /** Output SVG height in pixels. If not set, derived from page dimensions. */
  readonly height?: number;
  /** Font family mapping: document font name → SVG font-family value. */
  readonly fonts?: ReadonlyMap<string, string>;
  /** Background color (CSS color string). Default: "white". */
  readonly backgroundColor?: string;
  /** Scale factor for the output. Default: 1.0. */
  readonly scale?: number;
  /**
   * Render a chart to an SVG fragment.
   *
   * Charts cannot be drawn from inside this module: the layout carries the
   * source `Chart` / `ChartEx` payload but rendering one means reaching the
   * Excel chart engine, and `word/` may only do that through
   * `word/bridge/excel-bridge`. Without an injected renderer every chart fell
   * back to a titled placeholder box — `LayoutChart.svg` was declared but
   * nothing on the normal layout path ever populated it, so
   * `renderDocumentToSvg` could not produce a chart at all.
   *
   * Pass `renderWordChartSvg` from `documonster/word/excel` to get real charts.
   * The fragment is inlined inside a `<g transform="translate(x y)">`, so it
   * should be authored at the origin with the chart's own width/height. Return
   * `undefined` to keep the placeholder.
   *
   * Consulted by all SVG entry points, which share the positioned layout.
   */
  readonly renderChart?: (chart: LayoutChart) => string | undefined;
}

/** Sanitize a string into a valid 6-digit hex color, or undefined. */
function sanitizeHexColor(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const stripped = raw.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(stripped) || /^[0-9a-fA-F]{3}$/.test(stripped)) {
    return stripped;
  }
  return undefined;
}

/**
 * Open a clipping region for the given rectangle, in page coordinates.
 *
 * A nested `<svg>` establishes a viewport that clips its content, and giving it
 * a `viewBox` equal to the same rectangle keeps the inner coordinate system
 * identical to the outer one — so children keep using absolute page
 * coordinates. This is deliberately *not* `clipPath` + `clip-path="url(#id)"`:
 * an `id` lives in a document-wide namespace, so two pages of the same document
 * embedded in one HTML file would collide and the second page would silently
 * clip against the first page's rectangle. A viewport carries no name and
 * therefore cannot collide.
 */
function clipViewportOpen(x: number, y: number, width: number, height: number): string {
  const box = `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`;
  return (
    `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" ` +
    `height="${height.toFixed(2)}" viewBox="${box}" overflow="hidden">`
  );
}

const CLIP_VIEWPORT_CLOSE = "</svg>";

/**
 * The `font-family` value for a run's font name.
 *
 * An explicit mapping is used verbatim — the caller is naming a CSS value. With
 * no mapping the document's own name is quoted and paired with the generic
 * family it most likely belongs to, so a viewer without that exact face still
 * picks a serif for a serif and a monospace for a monospace instead of falling
 * back to its default proportional font. The name is quoted because a document
 * font name is not necessarily a valid CSS identifier sequence — it may start
 * with a digit or contain a comma, either of which would otherwise change or
 * invalidate the family list.
 */
function svgFontFamily(fontName: string, fonts?: ReadonlyMap<string, string>): string {
  const mapped = fonts?.get(fontName);
  if (mapped) {
    return mapped;
  }
  // A CSS string cannot hold a raw double quote, and a backslash starts an
  // escape sequence that would swallow the next characters. Drop both rather
  // than emit a declaration the viewer parses differently than it reads.
  const quoted = fontName.replace(/["\\]/g, "").trim();
  const lower = fontName.toLowerCase();
  const generic =
    lower.includes("times") || lower.includes("roman") || lower.includes("serif")
      ? "serif"
      : lower.includes("courier") || lower.includes("mono") || lower.includes("consolas")
        ? "monospace"
        : "sans-serif";
  // An empty name would make `"", sans-serif` — an invalid list entry. The
  // generic family alone is still a usable declaration.
  return quoted.length > 0 ? `"${quoted}", ${generic}` : generic;
}

/**
 * Render a specific page of a DOCX document to an SVG string.
 *
 * @param doc - The parsed DOCX document
 * @param pageNumber - 1-based page number to render
 * @param options - Rendering options
 * @returns SVG string for the specified page
 *
 * @stability experimental
 */
export function renderPageToSvg(
  doc: DocxDocument,
  pageNumber: number,
  options?: RenderOptions
): string {
  // Use the same positioned layout as `renderDocumentToSvg` and the PDF
  // bridge. The old estimate-driven renderer had its own paragraph/table
  // implementation, so exact-line clipping, scripts, inline-image baselines,
  // nested tables and vAlign all diverged from every other surface.
  // No `measureText` override: the engine's own fallback measures through
  // `styledFontVariant`, so a bold or italic run is measured with the bold or
  // italic face. Passing a callback that drops those flags made every bold run
  // measure as regular, so later runs on the line overlapped it.
  const layout = layoutDocumentFull(doc);

  return renderPageFromLayout(layout, pageNumber, options);
}

/**
 * Render all pages of a DOCX document to SVG strings.
 *
 * @param doc - The parsed DOCX document
 * @param options - Rendering options
 * @returns Array of SVG strings, one per page
 *
 * @stability experimental
 */
export function renderDocumentToSvg(doc: DocxDocument, options?: RenderOptions): string[] {
  // Rendered from the positioned layout, the same model the PDF renderer
  // consumes. The previous route went straight from the document through the
  // paginating *estimate* and a deliberately simplified cell renderer, so its
  // output disagreed with `renderPageFromLayout` and with the PDF: cell text was
  // truncated with an ellipsis instead of wrapped, nested tables in cells were
  // dropped, and paragraph borders and shading never appeared. One path cannot
  // drift from itself.
  // No `measureText` override: the engine's own fallback measures through
  // `styledFontVariant`, so a bold or italic run is measured with the bold or
  // italic face. Passing a callback that drops those flags made every bold run
  // measure as regular, so later runs on the line overlapped it.
  const layout = layoutDocumentFull(doc);

  const svgPages: string[] = [];
  for (let page = 1; page <= layout.totalPages; page++) {
    svgPages.push(renderPageFromLayout(layout, page, options));
  }
  return svgPages;
}

/** Build the final SVG document string from rendered elements. */
function buildSvgDocument(
  elements: string[],
  pageWidthPt: number,
  pageHeightPt: number,
  options: RenderOptions | undefined
): string {
  const scale = options?.scale ?? 1.0;
  const bgColor = options?.backgroundColor ?? "white";

  // Determine output dimensions
  let outputWidth: number;
  let outputHeight: number;

  if (options?.width && options?.height) {
    outputWidth = options.width;
    outputHeight = options.height;
  } else if (options?.width) {
    outputWidth = options.width;
    outputHeight = (pageHeightPt / pageWidthPt) * options.width;
  } else if (options?.height) {
    outputHeight = options.height;
    outputWidth = (pageWidthPt / pageHeightPt) * options.height;
  } else {
    outputWidth = pageWidthPt * scale;
    outputHeight = pageHeightPt * scale;
  }

  const viewBox = `0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth.toFixed(2)}" height="${outputHeight.toFixed(2)}" viewBox="${viewBox}">\n`;
  svg += `  <rect width="100%" height="100%" fill="${xmlEncodeAttr(bgColor)}"/>\n`;

  for (const element of elements) {
    svg += `  ${element}\n`;
  }

  svg += `</svg>`;
  return svg;
}

// =============================================================================
// New API: Render from pre-computed LayoutDocument (no re-layout)
// =============================================================================

/**
 * Render a page from a pre-computed LayoutDocument to SVG.
 * This avoids re-computing layout — just serializes positioned elements to SVG.
 *
 * @param layout - A LayoutDocument produced by layoutDocumentFull().
 * @param pageNumber - 1-based page number to render.
 * @param options - Rendering options (scale, dimensions, background color).
 * @returns SVG string.
 *
 * @stability experimental
 */
export function renderPageFromLayout(
  layout: LayoutDocument,
  pageNumber: number,
  options?: RenderOptions
): string {
  if (pageNumber < 1 || pageNumber > layout.totalPages) {
    throw new RangeError(
      `Page number ${pageNumber} out of range. Document has ${layout.totalPages} page(s).`
    );
  }

  const page = layout.pages[pageNumber - 1];
  const { geometry } = page;
  const elements: string[] = [];

  // Header / footer paragraphs and tables come with layout-y already
  // expressed as a page-absolute offset (the layout engine adds the
  // section's `pgMar.header` to header content and starts footer
  // content at `pageHeight - pgMar.footer`). Use a geometry with
  // `marginTop: 0` so SVG y-coordinates resolve straight from
  // layout-y. Tables in header / footer are uncommon but legal —
  // dispatch through the same renderers used for body content.
  const bandGeometry: PageGeometry = { ...geometry, marginTop: 0 };
  if (page.header) {
    for (const item of page.header) {
      if (item.type === "paragraph") {
        renderLayoutParagraphToSvg(item, bandGeometry, elements, options?.fonts);
      } else {
        renderLayoutTableToSvg(item, bandGeometry, elements, options?.fonts);
      }
    }
  }

  // Render each positioned content element. Every PageContent variant is
  // handled — most non-paragraph/table types degrade to a placeholder rect
  // (charts, shapes, opaque drawings), an inline glyph (check-boxes, math),
  // or a recursive descent (text-boxes, SDTs). Adding a new PageContent
  // variant is a build error here until a case is added.
  for (const item of page.content) {
    switch (item.type) {
      case "paragraph":
        renderLayoutParagraphToSvg(item, geometry, elements, options?.fonts);
        break;
      case "table":
        renderLayoutTableToSvg(item, geometry, elements, options?.fonts);
        break;
      case "image":
        renderLayoutImageToSvg(item, geometry, elements);
        break;
      case "float":
        renderLayoutFloatToSvg(item, geometry, elements, options?.fonts);
        break;
      case "textBox":
        renderLayoutTextBoxToSvg(item, geometry, elements, options);
        break;
      case "shape":
        renderLayoutShapeToSvg(item, geometry, elements, options);
        break;
      case "chart":
        renderLayoutChartToSvg(item, geometry, elements, options);
        break;
      case "sdt":
        renderLayoutSdtToSvg(item, geometry, elements, options);
        break;
      case "math":
        renderLayoutMathToSvg(item, geometry, elements);
        break;
      case "checkBox":
        renderLayoutCheckBoxToSvg(item, geometry, elements);
        break;
      case "tableOfContents":
        renderLayoutTocToSvg(item, geometry, elements, options?.fonts);
        break;
      case "altChunk":
        renderLayoutPlaceholderToSvg(item.rect, geometry, `[${item.contentType}]`, elements);
        break;
      case "opaqueDrawing":
        renderLayoutPlaceholderToSvg(item.rect, geometry, "[drawing]", elements);
        break;
      default: {
        const _exhaustive: never = item;
        throw new Error(
          `renderPageFromLayout: unhandled PageContent ${(_exhaustive as { type: string }).type}`
        );
      }
    }
  }

  // Footer — `bandGeometry` (declared near the header above) shares the
  // same "layout-y is page-absolute" rule for both bands.
  if (page.footer) {
    for (const item of page.footer) {
      if (item.type === "paragraph") {
        renderLayoutParagraphToSvg(item, bandGeometry, elements, options?.fonts);
      } else {
        renderLayoutTableToSvg(item, bandGeometry, elements, options?.fonts);
      }
    }
  }

  // Footnote separator (drawn above the footnote area; see ECMA-376
  // §17.11.10). Same coordinate convention as bands: the layout y
  // value is page-absolute.
  if (page.footnoteSeparator) {
    const sep = page.footnoteSeparator;
    const ruleWidth = sep.kind === "separator" ? geometry.contentWidth / 3 : geometry.contentWidth;
    const x1 = geometry.marginLeft;
    const x2 = x1 + ruleWidth;
    elements.push(
      `<line x1="${x1.toFixed(2)}" y1="${sep.y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${sep.y.toFixed(2)}" stroke="black" stroke-width="0.5"/>`
    );
  }

  // Footnote area paragraphs (page-absolute y, like header/footer).
  if (page.footnoteArea) {
    for (const para of page.footnoteArea) {
      renderLayoutParagraphToSvg(para, bandGeometry, elements, options?.fonts);
    }
  }

  return buildSvgDocument(elements, geometry.width, geometry.height, options);
}

/** Render a LayoutParagraph to SVG text elements. */
function renderLayoutParagraphToSvg(
  para: LayoutParagraph,
  geometry: PageGeometry,
  elements: string[],
  fonts?: ReadonlyMap<string, string>
): void {
  renderParagraphDecorationToSvg(para, geometry, elements);
  for (const line of para.lines) {
    const lineY = geometry.marginTop + para.rect.y + line.y + line.baseline;
    const lineTopY = geometry.marginTop + para.rect.y + line.y;
    // Run x is relative to the paragraph's own origin, exactly as the PDF
    // renderer treats it. Omitting `rect.x` happened to work for a top-level
    // paragraph (always 0) and silently dropped a table cell's left margin.
    const lineX = geometry.marginLeft + para.rect.x;
    for (const item of line.runs) {
      if (item.type === "image") {
        // Inline image: anchored on the line's baseline, matching Word's
        // default for in-line images. Empty data → emit
        // nothing rather than an invalid <image href> with empty src.
        if (item.data.length === 0) {
          continue;
        }
        const x = lineX + item.x;
        const yBottom = lineTopY + line.baseline;
        const yTop = yBottom - item.height;
        const dataUri = `data:${item.mimeType};base64,${bytesToBase64(item.data)}`;
        elements.push(
          `<image x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${item.width.toFixed(2)}" height="${item.height.toFixed(2)}" href="${xmlEncodeAttr(dataUri)}"/>`
        );
        continue;
      }
      const run = item;
      const x = lineX + run.x;
      // Sub/superscript: shift the SVG baseline. SVG y-axis points
      // downward (opposite of PDF), so superscript moves UP (smaller
      // y) and subscript moves DOWN (larger y) — opposite signs from
      // the PDF code.
      let runY = lineY;
      if (run.verticalAlign === "superscript") {
        runY = lineY - run.fontSize * SCRIPT_BASELINE_SHIFT_FACTOR;
      } else if (run.verticalAlign === "subscript") {
        runY = lineY + run.fontSize * SCRIPT_BASELINE_SHIFT_FACTOR;
      }
      let attrs = `x="${x.toFixed(2)}" y="${runY.toFixed(2)}"`;
      attrs += ` font-family="${xmlEncodeAttr(svgFontFamily(run.font, fonts))}"`;
      attrs += ` font-size="${run.fontSize.toFixed(1)}"`;
      if (run.bold) {
        attrs += ` font-weight="bold"`;
      }
      if (run.italic) {
        attrs += ` font-style="italic"`;
      }
      if (run.color) {
        const safe = sanitizeHexColor(run.color);
        if (safe) {
          attrs += ` fill="#${safe}"`;
        }
      }
      if (run.underline) {
        attrs += ` text-decoration="underline"`;
      } else if (run.strikethrough) {
        attrs += ` text-decoration="line-through"`;
      }
      const escapedText = xmlEncode(run.text);
      if (escapedText.length > 0) {
        elements.push(`<text ${attrs}>${escapedText}</text>`);
      }
    }
  }
}

/** Render a LayoutTable to SVG (borders + cell content). */
/**
 * Paint a paragraph's shading and borders (`w:shd`, `w:pBdr`) into the SVG.
 *
 * Mirrors the PDF renderer exactly — the resolved edges and box come from the
 * layout model, so the two outputs cannot drift apart.
 */
function renderParagraphDecorationToSvg(
  para: LayoutParagraph,
  geometry: PageGeometry,
  elements: string[]
): void {
  const insets = para.decorationInsets;
  if (!insets) {
    return;
  }
  // Derived from `rect`, which the caller has already translated and which a
  // page split has already resized.
  const box = {
    width: Math.max(0, para.rect.width - insets.left - insets.right),
    height: Math.max(0, para.rect.height - insets.top - insets.bottom)
  };
  const x = geometry.marginLeft + para.rect.x + insets.left;
  const y = geometry.marginTop + para.rect.y + insets.top;

  if (para.backgroundColor) {
    const fill = sanitizeHexColor(para.backgroundColor);
    if (fill) {
      const pad = para.borders?.left?.space ?? 0;
      elements.push(
        `<rect x="${(x - pad).toFixed(2)}" y="${y.toFixed(2)}" width="${(box.width + pad * 2).toFixed(2)}" height="${box.height.toFixed(2)}" fill="#${fill}" stroke="none"/>`
      );
    }
  }

  const borders = para.borders;
  if (!borders) {
    return;
  }
  const line = (edge: LayoutBorderEdge, x1: number, y1: number, x2: number, y2: number): void => {
    const color = sanitizeHexColor(edge.color) ?? "000000";
    elements.push(
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#${color}" stroke-width="${edge.width.toFixed(2)}"/>`
    );
  };
  const right = x + box.width;
  const bottom = y + box.height;
  if (borders.top) {
    const ty = y - borders.top.space;
    line(borders.top, x, ty, right, ty);
  }
  if (borders.bottom) {
    const by = bottom + borders.bottom.space;
    line(borders.bottom, x, by, right, by);
  }
  if (borders.left) {
    const lx = x - borders.left.space;
    line(borders.left, lx, y, lx, bottom);
  }
  if (borders.right) {
    const rx = right + borders.right.space;
    line(borders.right, rx, y, rx, bottom);
  }
}

function renderLayoutTableToSvg(
  table: LayoutTable,
  geometry: PageGeometry,
  elements: string[],
  fonts?: ReadonlyMap<string, string>
): void {
  // Draw cell borders and content
  for (const cell of table.cells) {
    const cellX = geometry.marginLeft + table.rect.x + cell.rect.x;
    const cellY = geometry.marginTop + table.rect.y + cell.rect.y;
    const w = cell.rect.width;
    const h = cell.rect.height;

    // Background
    if (cell.backgroundColor) {
      const safeBg = sanitizeHexColor(cell.backgroundColor);
      if (safeBg) {
        elements.push(
          `<rect x="${cellX.toFixed(2)}" y="${cellY.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#${safeBg}" stroke="none"/>`
        );
      }
    }

    // Border
    elements.push(
      `<rect x="${cellX.toFixed(2)}" y="${cellY.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="none" stroke="#cccccc" stroke-width="0.5"/>`
    );

    // Cell content — paragraphs and nested tables, translated into page space by
    // the cell's origin on *both* axes. Dropping the block's own `rect.x` lost
    // the cell's left margin, and skipping nested tables meant the same layout
    // rendered differently in SVG than in PDF.
    const originX = table.rect.x + cell.rect.x;
    const originY = table.rect.y + cell.rect.y;
    if (cell.clipToBounds) {
      elements.push(clipViewportOpen(cellX, cellY, w, h));
    }
    for (const content of cell.content) {
      if (content.type === "paragraph") {
        renderLayoutParagraphToSvg(
          {
            ...content,
            rect: { ...content.rect, x: originX + content.rect.x, y: originY + content.rect.y }
          },
          geometry,
          elements,
          fonts
        );
      } else {
        renderLayoutTableToSvg(
          {
            ...content,
            rect: { ...content.rect, x: originX + content.rect.x, y: originY + content.rect.y }
          },
          geometry,
          elements,
          fonts
        );
      }
    }
    if (cell.clipToBounds) {
      elements.push(CLIP_VIEWPORT_CLOSE);
    }
  }
}

// =============================================================================
// SVG renderers — extended PageContent variants
// =============================================================================

function absRect(rect: LayoutRect, geometry: PageGeometry): LayoutRect {
  return {
    x: geometry.marginLeft + rect.x,
    y: geometry.marginTop + rect.y,
    width: rect.width,
    height: rect.height
  };
}

function pushPlaceholder(
  abs: LayoutRect,
  fillStroke: { fill?: string; stroke?: string; strokeWidth?: number },
  elements: string[]
): void {
  const fill = fillStroke.fill ?? "none";
  const stroke = fillStroke.stroke ?? "#bbbbbb";
  const sw = (fillStroke.strokeWidth ?? 0.5).toFixed(2);
  elements.push(
    `<rect x="${abs.x.toFixed(2)}" y="${abs.y.toFixed(2)}" width="${abs.width.toFixed(2)}" height="${abs.height.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
  );
}

function renderLayoutImageToSvg(
  img: LayoutImage,
  geometry: PageGeometry,
  elements: string[]
): void {
  const abs = absRect(img.rect, geometry);
  if (img.data.length === 0) {
    pushPlaceholder(abs, { stroke: "#888888" }, elements);
    return;
  }
  const dataUri = `data:${img.mimeType};base64,${bytesToBase64(img.data)}`;
  elements.push(
    `<image x="${abs.x.toFixed(2)}" y="${abs.y.toFixed(2)}" width="${abs.width.toFixed(2)}" height="${abs.height.toFixed(2)}" href="${xmlEncodeAttr(dataUri)}"/>`
  );
}

function renderLayoutFloatToSvg(
  float: LayoutFloat,
  geometry: PageGeometry,
  elements: string[],
  fonts?: ReadonlyMap<string, string>
): void {
  // Floats currently always wrap a LayoutImage. Behind-text floats render
  // before main content in document order; SVG is painters-algorithm so a
  // dedicated z-ordering pass would belong upstream — for now rendering
  // order matches `page.content` order which is good enough.
  if (float.content.type === "image") {
    renderLayoutImageToSvg(float.content, geometry, elements);
  } else {
    renderLayoutParagraphToSvg(float.content, geometry, elements, fonts);
  }
}

function renderLayoutTextBoxToSvg(
  tb: LayoutTextBox,
  geometry: PageGeometry,
  elements: string[],
  options?: RenderOptions
): void {
  const abs = absRect(tb.rect, geometry);
  const safeStroke = tb.border ? sanitizeHexColor(tb.border.color) : undefined;
  const safeFill = tb.background ? sanitizeHexColor(tb.background) : undefined;
  pushPlaceholder(
    abs,
    {
      fill: safeFill ? `#${safeFill}` : undefined,
      stroke: safeStroke ? `#${safeStroke}` : undefined,
      strokeWidth: tb.border?.width
    },
    elements
  );
  // Translate inner content by the text-box origin and recurse through the
  // generic SVG dispatcher so nested content (paragraphs, tables, even
  // shapes) renders correctly.
  const innerGeometry: PageGeometry = {
    ...geometry,
    marginLeft: geometry.marginLeft + tb.rect.x,
    marginTop: geometry.marginTop + tb.rect.y
  };
  renderPageContentList(tb.content, innerGeometry, elements, options);
}

function renderLayoutShapeToSvg(
  shape: LayoutShape,
  geometry: PageGeometry,
  elements: string[],
  options?: RenderOptions
): void {
  const abs = absRect(shape.rect, geometry);
  // `sanitizeHexColor` returns undefined for anything that is not a 3- or
  // 6-digit hex, and interpolating that straight into the attribute emitted the
  // literal string `fill="#undefined"` — invalid SVG that no renderer accepts.
  // The layout only strips a leading `#` (see `normaliseHex`) and never
  // validates, so any out-of-contract colour reaching this point produced broken
  // output. Fall back to the no-paint / default-stroke values instead.
  const safeFill = sanitizeHexColor(shape.fillColor);
  const safeStroke = sanitizeHexColor(shape.strokeColor);
  const fill = safeFill ? `#${safeFill}` : "none";
  const stroke = safeStroke ? `#${safeStroke}` : "#888888";
  const sw = (shape.strokeWidth ?? 0.75).toFixed(2);

  // Map a few common preset shapes; everything else falls back to a rect.
  if (shape.preset === "ellipse" || shape.preset === "oval") {
    const cx = (abs.x + abs.width / 2).toFixed(2);
    const cy = (abs.y + abs.height / 2).toFixed(2);
    const rx = (abs.width / 2).toFixed(2);
    const ry = (abs.height / 2).toFixed(2);
    elements.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
    );
  } else if (shape.preset === "line") {
    elements.push(
      `<line x1="${abs.x.toFixed(2)}" y1="${abs.y.toFixed(2)}" x2="${(abs.x + abs.width).toFixed(2)}" y2="${(abs.y + abs.height).toFixed(2)}" stroke="${stroke}" stroke-width="${sw}"/>`
    );
  } else {
    elements.push(
      `<rect x="${abs.x.toFixed(2)}" y="${abs.y.toFixed(2)}" width="${abs.width.toFixed(2)}" height="${abs.height.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`
    );
  }

  if (shape.textContent && shape.textContent.length > 0) {
    const innerGeometry: PageGeometry = {
      ...geometry,
      marginLeft: geometry.marginLeft + shape.rect.x,
      marginTop: geometry.marginTop + shape.rect.y
    };
    renderPageContentList(shape.textContent, innerGeometry, elements, options);
  }
}

/**
 * Uniform factor that fits an SVG fragment's own declared size into `width` x
 * `height`.
 *
 * Returns 1 when the fragment declares no usable size (nothing to correct), so
 * the common case emits a plain translate.
 */
function svgFragmentScale(fragment: string, width: number, height: number): number {
  const root = /<svg\b([^>]*)>/i.exec(fragment);
  if (!root || width <= 0 || height <= 0) {
    return 1;
  }
  const attrs = parseSvgAttributes(root[1]);
  const viewBox = parseSvgNumberList(attrs.viewBox);
  const declaredWidth = Number.parseFloat(attrs.width ?? "") || viewBox[2];
  const declaredHeight = Number.parseFloat(attrs.height ?? "") || viewBox[3];
  if (
    !Number.isFinite(declaredWidth) ||
    !Number.isFinite(declaredHeight) ||
    declaredWidth <= 0 ||
    declaredHeight <= 0
  ) {
    return 1;
  }
  return Math.min(width / declaredWidth, height / declaredHeight);
}

function renderLayoutChartToSvg(
  chart: LayoutChart,
  geometry: PageGeometry,
  elements: string[],
  options?: RenderOptions
): void {
  const abs = absRect(chart.rect, geometry);
  // A pre-rendered fragment on the layout wins; otherwise ask the caller's
  // renderer. Only when neither is available do we fall back to a placeholder.
  const svg = chart.svg ?? options?.renderChart?.(chart);
  if (svg) {
    // Inline the fragment inside a <g> that translates it to the chart's page
    // position and scales it to the chart's box. The scale matters because a
    // fragment normally declares its own size in a different unit — the Excel
    // bridge renders at 96 DPI while the layout rect is in points, so without
    // this the chart overflowed its box by exactly 4/3.
    const scale = svgFragmentScale(svg, abs.width, abs.height);
    const transform =
      scale === 1
        ? `translate(${abs.x.toFixed(2)} ${abs.y.toFixed(2)})`
        : `translate(${abs.x.toFixed(2)} ${abs.y.toFixed(2)}) scale(${scale.toFixed(6)})`;
    elements.push(`<g transform="${transform}">${svg}</g>`);
    return;
  }
  pushPlaceholder(abs, { stroke: "#666666" }, elements);
  if (chart.title) {
    const cx = abs.x + abs.width / 2;
    const cy = abs.y + abs.height / 2;
    elements.push(
      `<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica" font-size="10" fill="#444444">${xmlEncode(chart.title)}</text>`
    );
  }
}

function renderLayoutSdtToSvg(
  sdt: LayoutSdt,
  geometry: PageGeometry,
  elements: string[],
  options?: RenderOptions
): void {
  // SDT is transparent visually; recurse into its children using the
  // page-relative geometry but offset by the SDT's own rect.
  const innerGeometry: PageGeometry = {
    ...geometry,
    marginLeft: geometry.marginLeft + sdt.rect.x,
    marginTop: geometry.marginTop + sdt.rect.y
  };
  renderPageContentList(sdt.content, innerGeometry, elements, options);
}

function renderLayoutMathToSvg(math: LayoutMath, geometry: PageGeometry, elements: string[]): void {
  const abs = absRect(math.rect, geometry);
  // Render the plain-text fallback. Renderers that want true math display
  // can read `math.mathML` from the layout document directly.
  elements.push(
    `<text x="${abs.x.toFixed(2)}" y="${(abs.y + abs.height * 0.8).toFixed(2)}" font-family="serif" font-style="italic" font-size="${(abs.height * 0.7).toFixed(1)}" fill="#000">${xmlEncode(math.text)}</text>`
  );
}

function renderLayoutCheckBoxToSvg(
  cb: LayoutCheckBox,
  geometry: PageGeometry,
  elements: string[]
): void {
  const abs = absRect(cb.rect, geometry);
  // Draw the actual square so the rendered output is independent of font
  // availability.
  elements.push(
    `<rect x="${abs.x.toFixed(2)}" y="${abs.y.toFixed(2)}" width="${abs.height.toFixed(2)}" height="${abs.height.toFixed(2)}" fill="white" stroke="#000" stroke-width="0.75"/>`
  );
  if (cb.checked) {
    const x1 = abs.x + abs.height * 0.2;
    const y1 = abs.y + abs.height * 0.55;
    const x2 = abs.x + abs.height * 0.45;
    const y2 = abs.y + abs.height * 0.8;
    const x3 = abs.x + abs.height * 0.85;
    const y3 = abs.y + abs.height * 0.2;
    elements.push(
      `<polyline points="${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)} ${x3.toFixed(2)},${y3.toFixed(2)}" fill="none" stroke="#000" stroke-width="1"/>`
    );
  }
}

function renderLayoutTocToSvg(
  toc: LayoutTableOfContents,
  geometry: PageGeometry,
  elements: string[],
  fonts?: ReadonlyMap<string, string>
): void {
  // TOC is a list of LayoutParagraphs; render them with a y-offset by the
  // TOC's own rect.
  const innerGeometry: PageGeometry = {
    ...geometry,
    marginLeft: geometry.marginLeft + toc.rect.x,
    marginTop: geometry.marginTop + toc.rect.y
  };
  for (const p of toc.entries) {
    renderLayoutParagraphToSvg(p, innerGeometry, elements, fonts);
  }
}

function renderLayoutPlaceholderToSvg(
  rect: LayoutRect,
  geometry: PageGeometry,
  label: string,
  elements: string[]
): void {
  const abs = absRect(rect, geometry);
  pushPlaceholder(abs, { stroke: "#888888" }, elements);
  const cx = abs.x + abs.width / 2;
  const cy = abs.y + abs.height / 2;
  elements.push(
    `<text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica" font-size="9" fill="#666">${xmlEncode(label)}</text>`
  );
}

/** Recursive dispatch helper used by container variants (SDT, TextBox, Shape). */
function renderPageContentList(
  items: readonly PageContent[],
  geometry: PageGeometry,
  elements: string[],
  options?: RenderOptions
): void {
  for (const item of items) {
    switch (item.type) {
      case "paragraph":
        renderLayoutParagraphToSvg(item, geometry, elements, options?.fonts);
        break;
      case "table":
        renderLayoutTableToSvg(item, geometry, elements, options?.fonts);
        break;
      case "image":
        renderLayoutImageToSvg(item, geometry, elements);
        break;
      case "float":
        renderLayoutFloatToSvg(item, geometry, elements, options?.fonts);
        break;
      case "textBox":
        renderLayoutTextBoxToSvg(item, geometry, elements, options);
        break;
      case "shape":
        renderLayoutShapeToSvg(item, geometry, elements, options);
        break;
      case "chart":
        renderLayoutChartToSvg(item, geometry, elements, options);
        break;
      case "sdt":
        renderLayoutSdtToSvg(item, geometry, elements, options);
        break;
      case "math":
        renderLayoutMathToSvg(item, geometry, elements);
        break;
      case "checkBox":
        renderLayoutCheckBoxToSvg(item, geometry, elements);
        break;
      case "tableOfContents":
        renderLayoutTocToSvg(item, geometry, elements, options?.fonts);
        break;
      case "altChunk":
        renderLayoutPlaceholderToSvg(item.rect, geometry, `[${item.contentType}]`, elements);
        break;
      case "opaqueDrawing":
        renderLayoutPlaceholderToSvg(item.rect, geometry, "[drawing]", elements);
        break;
      default: {
        const _exhaustive: never = item;
        throw new Error(
          `renderPageContentList: unhandled PageContent ${(_exhaustive as { type: string }).type}`
        );
      }
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  // Same approach as core/internal-utils.ts to stay browser-friendly.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(binary);
  }
  // Node fallback
  const buf = (
    globalThis as {
      Buffer?: { from(data: string, enc: string): { toString(enc: string): string } };
    }
  ).Buffer;
  if (buf) {
    return buf.from(binary, "binary").toString("base64");
  }
  throw new Error("btoa / Buffer unavailable; cannot encode image data");
}
