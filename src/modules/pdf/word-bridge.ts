/**
 * Word-to-PDF Bridge
 *
 * Converts a Word document (`DocxDocument`) to PDF.
 *
 * The bridge is a thin translation layer:
 *
 *   DocxDocument
 *      │
 *      │  layoutDocumentFull()  ← @word/layout
 *      ▼
 *   LayoutDocument (positioned PageContent variants)
 *      │
 *      │  renderLayoutDocumentToPdf()  ← ./word-layout-to-pdf
 *      ▼
 *   PdfDocumentBuilder → bytes
 *
 * Every flow decision (line wrapping, page breaks, table sizing,
 * float positioning) lives in `@word/layout`. This file only handles
 * option mapping, optional chart-renderer auto-detection, and the
 * final `builder.build()` serialization.
 *
 * Like `excel-bridge.ts`, this is the ONLY file in the PDF module that
 * imports from `@word`.
 *
 * @example
 * ```typescript
 * import { Io } from "documonster/word";
 * import { Pdf } from "documonster/pdf";
 *
 * const doc = await Io.read(docxBytes);
 * const pdfBytes = await Pdf.fromDocx(doc);
 * ```
 */

import type { PdfPageBuilder } from "@pdf/builder/document-builder";
import { isWinAnsiCodePoint } from "@pdf/core/pdf-stream";
import { compilePdfFontConfig } from "@pdf/font/font-config";
import type { PdfFontConfig } from "@pdf/font/font-config";
import { FontManager } from "@pdf/font/font-manager";
import { findSystemFontForCodePoints } from "@pdf/font/system-fonts";
import type { RenderLayoutOptions } from "@pdf/word-layout-to-pdf";
import { renderLayoutDocumentToPdf } from "@pdf/word-layout-to-pdf";
import { twipsToPt } from "@utils/units";
import { walkDocument } from "@word/core/walker";
import type { FullLayoutOptions, PageGeometryOverride } from "@word/layout/layout-full";
import { layoutDocumentFull, predictBulletGlyphs } from "@word/layout/layout-full";
import type { LayoutChart, LayoutDocument, PageContent } from "@word/layout/layout-model";
import type { Chart, ChartContent, ChartExContent, DocxDocument } from "@word/types";

// Re-export the Word document type used in this bridge's public signature so
// the `Pdf` surface can type its lazy `fromDocx` wrapper without importing
// from `@word` directly — only bridge files may cross into `@word`.
export type { DocxDocument } from "@word/types";

/** Options for DOCX → PDF conversion. */
export interface DocxToPdfOptions {
  /** Page width in points (default: from document sectPr or 612 US Letter). */
  readonly pageWidth?: number;
  /** Page height in points (default: from document sectPr or 792 US Letter). */
  readonly pageHeight?: number;
  /** Top margin in points (default: from sectPr or 72). */
  readonly marginTop?: number;
  /** Bottom margin in points (default: from sectPr or 72). */
  readonly marginBottom?: number;
  /** Left margin in points (default: from sectPr or 72). */
  readonly marginLeft?: number;
  /** Right margin in points (default: from sectPr or 72). */
  readonly marginRight?: number;
  /** Default font family (default: "Helvetica"). */
  readonly defaultFont?: string;
  /** Default font size in points (default: 11). */
  readonly defaultFontSize?: number;
  /**
   * Embedded families used both to measure Word layout and to render PDF text.
   * Family names and aliases match Word font names case-insensitively; configured
   * fallback is applied per grapheme. OpenType shaping, bidi reordering, and
   * color emoji are not supported.
   */
  readonly fonts?: PdfFontConfig;
  /**
   * Receive non-fatal font diagnostics raised while converting.
   *
   * @see `PdfExportOptions.onWarning`
   */
  readonly onWarning?: (message: string) => void;
  /**
   * Header band distance from the top edge of the page, in points
   * (default: section's `pgMar.header`, or 36pt / 0.5").
   *
   * Header paragraphs are laid out starting at this y-offset from the
   * page top. Overriding it moves the entire header band — useful when
   * the source document declares no section properties or you want to
   * tighten / loosen the header position without touching `marginTop`.
   */
  readonly headerMargin?: number;
  /**
   * Footer band distance from the bottom edge of the page, in points
   * (default: section's `pgMar.footer`, or 36pt / 0.5").
   *
   * The footer band's top sits at `pageHeight - footerMargin`. The
   * footnote stack (if any) is placed directly above this line.
   */
  readonly footerMargin?: number;
  /**
   * Optional high-quality chart renderer callback.
   *
   * When provided, Word charts are rendered using the injected renderer
   * instead of the built-in simplified renderer. This allows consumers
   * to plug in the Excel chart renderer for publication-quality output:
   *
   * ```typescript
   * import { Pdf } from "documonster/pdf";
   * const pdfBytes = await Pdf.fromDocx(doc, {
   *   chartRenderer: await Pdf.wordChartRenderer()
   * });
   * ```
   *
   * The callback receives the original Word `Chart` definition (taken
   * from the source `ChartContent`), a `PdfPageBuilder`, and the
   * destination rectangle in PDF coordinates. The implementation
   * should draw the chart into the rectangle.
   *
   * Return `false` to decline a chart. The translator then falls back
   * to the built-in layout-aware Excel renderer (which also handles
   * `chartEx` charts), then to the inline `LayoutChart.svg` if present,
   * and finally to a placeholder rectangle with the chart title
   * centred. Return `void` or `true` to indicate the chart was handled.
   *
   * Note: `chartEx` charts (sunburst / treemap / waterfall / funnel /
   * boxWhisker / …) never reach this `Chart`-typed callback because
   * there is no classic `Chart` instance to pass. They are rendered by
   * the built-in layout-aware renderer instead (full vector output).
   */
  readonly chartRenderer?: (
    chart: Chart,
    page: PdfPageBuilder,
    rect: { x: number; y: number; width: number; height: number }
  ) => boolean | void;
}

/**
 * Convert a `DocxDocument` to PDF bytes.
 *
 * @param doc - The DOCX document model (from `readDocx` or `Document.build()`).
 * @param options - Page geometry, fonts, optional chart renderer, …
 * @returns PDF bytes ready to write to disk or stream over HTTP.
 */
export async function docxToPdf(
  doc: DocxDocument,
  options?: DocxToPdfOptions
): Promise<Uint8Array> {
  // 1. Resolve effective page geometry. Section properties win unless the
  //    caller explicitly overrode an axis. Margins are independent: the
  //    section's margins are applied unless the caller overrode them.
  const layoutOptions = mapToLayoutOptions(doc, options);
  const withFontMetrics = (manager: FontManager): FullLayoutOptions => ({
    ...layoutOptions,
    measureText: (text, fontName, fontSize, bold = false, italic = false) => {
      const resourceName = manager.resolveFont(fontName, bold, italic);
      return manager.measureText(text, resourceName, fontSize);
    },
    // The layout splits a line box's leading around the ink it holds, so it
    // needs the extents of the faces this document actually embeds — the
    // standard-font tables it falls back to would clip a taller face's
    // descenders against the following line.
    measureTextMetrics: (text, fontName, fontSize, bold = false, italic = false) => {
      const resourceName = manager.resolveFont(fontName, bold, italic);
      return manager.measureTextMetrics(text, resourceName, fontSize);
    }
  });

  // 2. Try to obtain the built-in, layout-aware Excel chart renderer.
  //    It handles BOTH classic `<c:chart>` and modern `<cx:chartSpace>`
  //    ChartEx families (sunburst / treemap / waterfall / …). It is used
  //    directly when the caller supplies no `chartRenderer`, and as the
  //    fallback for ChartEx (which the public `Chart`-typed callback
  //    cannot express) or whenever a user callback declines a chart.
  let builtInLayoutRenderer:
    | ((
        chart: LayoutChart,
        page: PdfPageBuilder,
        rect: { x: number; y: number; width: number; height: number }
      ) => boolean | void)
    | undefined;
  try {
    const mod = await import("@pdf/word-chart-bridge");
    if (typeof mod.createWordLayoutChartPdfRenderer === "function") {
      builtInLayoutRenderer = mod.createWordLayoutChartPdfRenderer();
    }
  } catch {
    // Chart support not available — placeholder rendering takes over.
  }

  // 3. Choose the faces the layout will measure with, *before* laying out.
  //     Without configured families, `build()` auto-embeds a system face for
  //     whatever WinAnsi cannot encode, and the baseline arithmetic has to see
  //     that face's extents. The set is predicted from the source text plus the
  //     glyphs the layout is known to inject — list-marker symbols, which Word
  //     authors as Symbol/Wingdings private-use code points and the engine
  //     rewrites (`predictBulletGlyphs` derives them from that very rewrite, so
  //     there is no second copy of its table). Every other injection is ASCII (a
  //     footnote's number) or already present in the source (a TOC entry).
  // `undefined` when the caller configured families: those are authoritative, so
  // there is nothing to predict and nothing to verify afterwards.
  const predicted = options?.fonts ? undefined : predictNonWinAnsiCodePoints(doc);
  let fontManager = options?.fonts
    ? new FontManager(compilePdfFontConfig(options.fonts))
    : await resolveFallbackFontManager(predicted!);
  let layout = layoutDocumentFull(doc, fontManager ? withFontMetrics(fontManager) : layoutOptions);

  // 3a. Verify the prediction against what was actually laid out. Walking the
  //     finished runs is far cheaper than laying out again, so the common case
  //     stays a single pass while an inexact prediction still self-corrects
  //     rather than measuring with one face and drawing with another. Reaching
  //     here twice is impossible: the second prediction *is* the observation.
  if (predicted) {
    const drawn = collectLayoutNonWinAnsiCodePoints(layout);
    if (!sameCodePoints(drawn, predicted)) {
      fontManager = await resolveFallbackFontManager(drawn);
      layout = layoutDocumentFull(doc, fontManager ? withFontMetrics(fontManager) : layoutOptions);
    }
  }

  // 4. Build a render-options object for the PDF translator. The
  //    chart-rendering precedence is:
  //      a. classic chart + user callback → user callback (its `false`
  //         return falls through to the built-in layout renderer);
  //      b. ChartEx, or classic chart with no user callback, or a
  //         declined user callback → built-in layout-aware renderer;
  //      c. neither available / both decline → translator fallback
  //         (inline SVG, then a titled placeholder box).
  const userChartRenderer = options?.chartRenderer;
  const renderOptions: RenderLayoutOptions = {
    title: doc.coreProperties?.title,
    author: doc.coreProperties?.creator,
    subject: doc.coreProperties?.subject,
    defaultFont: options?.defaultFont ?? "Helvetica",
    defaultFontSize: options?.defaultFontSize ?? 11,
    fonts: options?.fonts,
    onWarning: options?.onWarning,
    chartRenderer:
      userChartRenderer || builtInLayoutRenderer
        ? (layoutChart, page, rect): boolean | void => {
            const src = layoutChart.source as ChartContent | ChartExContent | undefined;
            // (a) Classic chart with a user-supplied callback: honour it
            //     first. Only fall through to the built-in renderer when
            //     it explicitly declines (`false`).
            if (userChartRenderer && src && src.type === "chart") {
              const handled = userChartRenderer(src.chart, page, rect);
              if (handled !== false) {
                return handled;
              }
            }
            // (b) Built-in layout-aware renderer handles classic charts
            //     without a user callback AND all ChartEx charts.
            if (builtInLayoutRenderer) {
              return builtInLayoutRenderer(layoutChart, page, rect);
            }
            // (c) Decline so the translator's placeholder runs instead of
            //     leaving a blank slot.
            return false;
          }
        : undefined
  };

  const builder = renderLayoutDocumentToPdf(layout, renderOptions);
  return builder.build();
}

/**
 * A font engine for the faces `PdfDocumentBuilder.build()` will auto-embed, or
 * `undefined` when the laid-out text is entirely WinAnsi and the built-in
 * standard-font tables are already exact.
 *
 * The predicate is the same one `build()` applies to the text it has drawn
 * (`isWinAnsiCodePoint`), so both hand the same kind of set to the same
 * deterministic `findSystemFontForCodePoints`.
 *
 * The set is a *lower bound*, not a proof of agreement: a chart renderer paints
 * its own category and value labels straight onto the page, and those strings
 * are not visible in the layout model at all. If such a label needs a code point
 * nothing else in the document uses, `build()` will widen the set and may land
 * on a different face than the one measured here. Everything the layout itself
 * positions — paragraphs, tables, headers, footers, footnotes, text boxes,
 * shapes, math, chart titles — is covered.
 */
async function resolveFallbackFontManager(
  codePoints: ReadonlySet<number>
): Promise<FontManager | undefined> {
  if (codePoints.size === 0) {
    return undefined;
  }
  const fontManager = new FontManager();
  const fallback = findSystemFontForCodePoints(codePoints);
  if (fallback) {
    fontManager.registerFallbackFont(fallback);
    return fontManager;
  }
  // No system face covers the document, so `build()` will fall back to Type3
  // glyphs. Load their real widths before anything wraps a line against them.
  for (const cp of codePoints) {
    fontManager.trackText(String.fromCodePoint(cp));
  }
  await fontManager.prepare();
  return fontManager;
}

/**
 * Code points the layout is expected to draw that WinAnsi cannot encode, derived
 * from the source model plus the glyphs the engine injects.
 */
function predictNonWinAnsiCodePoints(doc: DocxDocument): Set<number> {
  const out = new Set<number>();
  const addText = (text: string) => {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (!isWinAnsiCodePoint(cp)) {
        out.add(cp);
      }
    }
  };
  walkDocument(doc, {
    visitRunContent(content) {
      if (content.type === "text") {
        addText(content.text);
      } else if (content.type === "symbol") {
        addText(content.char);
      }
    }
  });
  for (const glyph of predictBulletGlyphs(doc)) {
    addText(glyph);
  }
  return out;
}

/** Whether two code-point sets hold exactly the same members. */
function sameCodePoints(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const cp of a) {
    if (!b.has(cp)) {
      return false;
    }
  }
  return true;
}

/** Code points in the laid-out text that WinAnsi cannot encode. */
function collectLayoutNonWinAnsiCodePoints(layout: LayoutDocument): Set<number> {
  const out = new Set<number>();
  const addText = (text: string) => {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (!isWinAnsiCodePoint(cp)) {
        out.add(cp);
      }
    }
  };
  const visit = (items: readonly PageContent[]): void => {
    for (const item of items) {
      switch (item.type) {
        case "paragraph":
          for (const line of item.lines) {
            for (const run of line.runs) {
              if (run.type !== "image") {
                addText(run.text);
              }
            }
          }
          break;
        case "table":
          for (const cell of item.cells) {
            visit(cell.content);
          }
          break;
        case "textBox":
        case "sdt":
          visit(item.content);
          break;
        case "shape":
          if (item.textContent) {
            visit(item.textContent);
          }
          break;
        case "float":
          visit([item.content]);
          break;
        case "tableOfContents":
          visit(item.entries);
          break;
        case "math":
          // Drawn as plain text by `renderMath`, so it selects a face too.
          addText(item.text);
          break;
        case "chart":
          // The placeholder path draws the title as text.
          if (item.title) {
            addText(item.title);
          }
          break;
        default:
          break;
      }
    }
  };
  for (const page of layout.pages) {
    visit(page.content);
    if (page.header) {
      visit(page.header);
    }
    if (page.footer) {
      visit(page.footer);
    }
    if (page.footnoteArea) {
      visit(page.footnoteArea);
    }
  }
  return out;
}

// =============================================================================
// Internal: option mapping
// =============================================================================

/**
 * Resolve the effective page geometry from `DocxToPdfOptions`. Caller-
 * supplied overrides win; otherwise the document's section properties
 * provide the value (with `pageSize.orientation === "landscape"`
 * triggering the conventional width/height swap when sectPr supplies
 * portrait-oriented numbers); otherwise the layout engine's defaults
 * (US Letter, 1-inch margins) take over.
 *
 * `headerMargin` / `footerMargin` are forwarded to the layout engine
 * as header / footer band offsets (ECMA-376 `pgMar.header` /
 * `pgMar.footer`). When omitted, the section's own header / footer
 * margins apply; when neither exists the engine default of 36pt (0.5")
 * is used.
 */
function mapToLayoutOptions(
  doc: DocxDocument,
  options: DocxToPdfOptions | undefined
): FullLayoutOptions {
  const sectProps = doc.sectionProperties;

  // Section page size, applying the orientation swap so a landscape
  // sectPr written with portrait numerics still ends up wide.
  let sectionPageWidthPt: number | undefined;
  let sectionPageHeightPt: number | undefined;
  if (sectProps?.pageSize) {
    sectionPageWidthPt = twipsToPt(sectProps.pageSize.width);
    sectionPageHeightPt = twipsToPt(sectProps.pageSize.height);
    if (sectProps.pageSize.orientation === "landscape") {
      [sectionPageWidthPt, sectionPageHeightPt] = [sectionPageHeightPt, sectionPageWidthPt];
    }
  }

  const sectionMarginTopPt =
    sectProps?.margins?.top != null ? twipsToPt(sectProps.margins.top) : undefined;
  const sectionMarginBottomPt =
    sectProps?.margins?.bottom != null ? twipsToPt(sectProps.margins.bottom) : undefined;
  const sectionMarginLeftPt =
    sectProps?.margins?.left != null ? twipsToPt(sectProps.margins.left) : undefined;
  const sectionMarginRightPt =
    sectProps?.margins?.right != null ? twipsToPt(sectProps.margins.right) : undefined;

  const pageGeometry: PageGeometryOverride = {
    pageWidth: options?.pageWidth ?? sectionPageWidthPt,
    pageHeight: options?.pageHeight ?? sectionPageHeightPt,
    marginTop: options?.marginTop ?? sectionMarginTopPt,
    marginBottom: options?.marginBottom ?? sectionMarginBottomPt,
    marginLeft: options?.marginLeft ?? sectionMarginLeftPt,
    marginRight: options?.marginRight ?? sectionMarginRightPt,
    // Header / footer offsets: only forward an explicit caller value.
    // Leaving these undefined lets the layout engine fall back to the
    // section's `pgMar.header` / `pgMar.footer` (then the 36pt default).
    headerMargin: options?.headerMargin,
    footerMargin: options?.footerMargin
  };

  const layoutOpts: Mutable<FullLayoutOptions> = {};
  // Only attach pageGeometry when at least one axis is actually
  // overridden; otherwise the layout engine should apply its
  // section-property fallbacks unchanged.
  if (Object.values(pageGeometry).some(v => v !== undefined)) {
    layoutOpts.pageGeometry = pageGeometry;
  }
  return layoutOpts;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
