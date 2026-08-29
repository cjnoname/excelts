/**
 * PDF Exporter - Main orchestrator for PDF document generation.
 *
 * Coordinates the layout engine, page renderer, font manager, and PDF writer
 * to produce a complete PDF document from a PdfWorkbook data structure.
 *
 * This module is fully independent of the Excel module.
 * It is used internally by the public `pdf()` and `excelToPdf()` APIs.
 */

import { writeImageXObject } from "@pdf/builder/image-utils";
import { initEncryption } from "@pdf/core/encryption";
import { PdfDict, pdfRef, pdfNumber, pdfString as pdfStr } from "@pdf/core/pdf-object";
import { PdfContentStream, isWinAnsiCodePoint } from "@pdf/core/pdf-stream";
import { PdfWriter } from "@pdf/core/pdf-writer";
import { PdfError, PdfFontError, PdfRenderError } from "@pdf/errors";
import { compilePdfFontConfig } from "@pdf/font/font-config";
import { FontManager } from "@pdf/font/font-manager";
import { findSystemFontForCodePoints } from "@pdf/font/system-fonts";
import { parseTtf } from "@pdf/font/ttf-parser";
import { createChartSurface } from "@pdf/render/chart-surface";
import { layoutChartsheet, layoutSheet } from "@pdf/render/layout-engine";
import {
  renderPage,
  alphaGsName,
  renderWatermark,
  resolveHeaderFooterRunText,
  selectHeaderFooter
} from "@pdf/render/page-renderer";
import { argbToPdfColor, toGrayscale } from "@pdf/render/style-converter";
import type {
  PdfWorkbook,
  PdfWorkbookSheet,
  PdfExportOptions,
  ResolvedPdfOptions,
  PdfPageSize,
  PdfMargins,
  PdfColor,
  PdfOrientation,
  PdfPageOrder,
  PdfCellErrorMode,
  PdfCellCommentMode,
  PdfPageSetupData,
  PdfRepeatBand,
  LayoutPage,
  LayoutChart,
  PdfWatermark
} from "@pdf/types";
import { PageSizes, PdfCellType, isPdfChartsheet } from "@pdf/types";
import { addCjkLanguageEvidence, concludeCjkLanguage, createCjkLanguageEvidence } from "@utils/cjk";
import type { CjkLanguage, CjkLanguageEvidence } from "@utils/cjk";
import { yieldToEventLoop } from "@utils/utils.base";

// =============================================================================
// Public API
// =============================================================================

/**
 * Export a PdfWorkbook to PDF format.
 * Yields to the event loop between each output page during layout and rendering.
 *
 * @param workbook - The workbook data to export
 * @param options - Export options controlling layout, pagination, and appearance
 * @returns Promise of PDF file as a Uint8Array
 * @throws {PdfError} If the workbook has no sheets or export fails
 */
export async function exportPdf(
  workbook: PdfWorkbook,
  options?: PdfExportOptions
): Promise<Uint8Array> {
  // Bind the header/footer substitutions once so `&F` / `&Z` / `&D` / `&T`
  // resolve identically on every sheet and page of this export.
  const headerFooter = options?.headerFooter;
  const resolvedInput: PdfExportOptions = {
    ...options,
    headerFooter: {
      ...headerFooter,
      fileName: headerFooter?.fileName ?? workbook.sourceFileName,
      filePath: headerFooter?.filePath ?? workbook.sourceFilePath,
      locale: headerFooter?.locale ?? workbook.locale,
      date: headerFooter?.date ?? new Date()
    }
  };
  const ctx = await prepareExport(workbook, resolvedInput);

  for (const sheet of ctx.sheets) {
    await layoutSheetInto(ctx, sheet, resolvedInput);
  }

  return finishExport(ctx, workbook, resolvedInput);
}

// =============================================================================
// Internal — Shared Pipeline
// =============================================================================

/** Shared state for the export pipeline. */
interface ExportContext {
  sheets: PdfWorkbookSheet[];
  fontManager: FontManager;
  writer: PdfWriter;
  allPages: LayoutPage[];
}

/**
 * Shared setup: validate sheets, create font manager and writer,
 * register embedded font.
 */
async function prepareExport(
  workbook: PdfWorkbook,
  options?: PdfExportOptions
): Promise<ExportContext> {
  const sheets = selectSheets(workbook, options?.sheets);

  if (sheets.length === 0) {
    throw new PdfError("No sheets to export. The workbook is empty or no sheets matched.");
  }

  if (options?.font && options.fonts) {
    throw new PdfFontError("`font` and `fonts` cannot be used together");
  }

  let fontManager: FontManager;
  if (options?.fonts) {
    try {
      fontManager = new FontManager(compilePdfFontConfig(options.fonts));
    } catch (err) {
      if (err instanceof PdfFontError) {
        throw err;
      }
      throw new PdfRenderError("Failed to configure PDF fonts", { cause: err });
    }
  } else {
    fontManager = new FontManager();
  }
  const writer = new PdfWriter();

  // User-provided fonts can be registered immediately. Automatic discovery is
  // delayed until after layout/preflight, when headers, footers, watermarks,
  // and vector charts have all reported their Unicode text.
  const fontData = options?.font ?? null;

  // `disableFontAutoDiscovery` gates both discovery sites — this one and the
  // post-layout widening below. Gating only one would make the option depend on
  // whether a header, a watermark or a chart happened to introduce a character the
  // cells did not, which is not a distinction a caller asking for deterministic
  // output can reason about.
  // Walked at most once. `collectNonWinAnsi` visits every header, footer, cell and
  // rich-text run of every sheet; it is a pure function of `sheets`, which nothing
  // between the two former call sites modified, so the second walk produced the same
  // answer at full cost. The language tally the seeding path threw away is reused
  // here too.
  let collected: ReturnType<typeof collectNonWinAnsi> | undefined;
  const nonWinAnsi = (): ReturnType<typeof collectNonWinAnsi> =>
    (collected ??= collectNonWinAnsi(sheets));

  if (!fontData && !options?.fonts && options?.disableFontAutoDiscovery !== true) {
    const found = nonWinAnsi();
    registerSystemFontForCodePoints(
      fontManager,
      found.codePoints,
      options?.preferSystemFonts,
      options?.textLanguage,
      concludeCjkLanguage(found.evidence)
    );
  }

  if (fontData) {
    try {
      const ttf = parseTtf(fontData);
      fontManager.registerEmbeddedFont(ttf);
    } catch (err) {
      if (options?.font) {
        // Only throw if the user explicitly provided a font
        if (err instanceof PdfFontError) {
          throw err;
        }
        throw new PdfFontError("Failed to parse TrueType font", { cause: err });
      }
      // Auto-discovered font failed to parse — silently fall back to Type1 + Type3
    }
  }

  // Type3 metrics are part of layout, not a side effect of writing resources.
  // Seed the repertoire now and load its real widths before any wrapping,
  // alignment or pagination decision is made.
  //
  // Unconditionally, because "a face is embedded" does not mean "every character has a
  // glyph". Auto-discovery is no longer required to cover the symbols Type3 can draw,
  // so an incomplete fallback is the ordinary case: guarding this on
  // `hasEmbeddedFont()` measured every character the face lacked at the 600 default and
  // then drew it at its real Type3 width. `U+2003` EM SPACE is 1000 and `U+200B` ZERO
  // WIDTH SPACE is 0, so the error is 40% of an em per character, not a rounding
  // difference — enough to move a line break or a page.
  //
  // `prepare()` itself only reads the widths of code points that still need Type3, so
  // for a face that does cover everything this seeds the repertoire and loads nothing.
  //
  // Two exclusions, and the distinction between them is the point. A *configured* font
  // set plans every run against a named family, so its `trackText` requires the
  // resource `resolveFont` returned and it never reaches Type3 — seeding a bare
  // repertoire there throws. A face the caller embedded *explicitly* covers the
  // document by contract, so it needs no Type3 widths; seeding anyway widened its
  // subset and renumbered its CIDs.
  //
  // An auto-discovered fallback is neither: it is a best-effort guess that is now
  // allowed to miss the symbols Type3 can draw, so it is exactly the case that must be
  // seeded. `hasEmbeddedFont()` cannot express that — it is true for both — which is
  // why this asks `hasFallbackFont()` instead.
  const explicitFace = fontManager.hasEmbeddedFont() && !fontManager.hasFallbackFont();
  if (!fontManager.hasConfiguredFonts() && !explicitFace) {
    for (const codePoint of nonWinAnsi().codePoints) {
      fontManager.trackText(String.fromCodePoint(codePoint));
    }
    await fontManager.prepare();
  }

  return { sheets, fontManager, writer, allPages: [] };
}

/**
 * Layout a single sheet and append its pages to the context.
 *
 * Dispatches on `sheet.kind`: chartsheets produce exactly one page via
 * {@link layoutChartsheet}; cell-grid worksheets go through the full
 * pagination pipeline via {@link layoutSheet}.
 */
async function layoutSheetInto(
  ctx: ExportContext,
  sheet: PdfWorkbookSheet,
  options?: PdfExportOptions
): Promise<void> {
  try {
    const resolved = resolveOptions(options, sheet);
    const pages = isPdfChartsheet(sheet)
      ? layoutChartsheet(sheet, resolved)
      : await layoutSheet(sheet, resolved, ctx.fontManager);
    // Loop rather than `push(...pages)`: a sheet's page count grows with its
    // rows and has no ceiling, and a spread would turn that count into an
    // argument list. See `PdfContentStream.append` for the same hazard.
    for (const page of pages) {
      ctx.allPages.push(page);
    }
  } catch (err) {
    throw new PdfRenderError(`Failed to layout sheet "${sheet.name}"`, { cause: err });
  }
}

/**
 * After layout: fix page numbers, track fonts, write resources,
 * render pages, and build the final PDF binary.
 */
async function finishExport(
  ctx: ExportContext,
  workbook: PdfWorkbook,
  options?: PdfExportOptions
): Promise<Uint8Array> {
  const { allPages, fontManager, writer, sheets } = ctx;
  const documentOptions = resolveOptions(options, sheets[0]);

  ensureAtLeastOnePage(allPages, documentOptions, sheets);
  // Same exclusions as the seeding above.
  if (
    !fontManager.hasConfiguredFonts() &&
    !(fontManager.hasEmbeddedFont() && !fontManager.hasFallbackFont())
  ) {
    for (const codePoint of collectNonWinAnsi(sheets).codePoints) {
      fontManager.trackText(String.fromCodePoint(codePoint));
    }
  }
  fixPageNumbers(allPages);
  trackFontsForHeaders(allPages, fontManager);
  const chartCache = preflightCharts(allPages, fontManager);

  // Track watermark fonts
  const watermark = documentOptions.watermark;
  if (watermark && watermark.type === "text") {
    const wmFontFamily = watermark.fontFamily ?? "Helvetica";
    const wmBold = watermark.bold ?? false;
    const wmItalic = watermark.italic ?? false;
    const resourceName = fontManager.resolveFont(wmFontFamily, wmBold, wmItalic);
    fontManager.trackText(watermark.text, resourceName);
  }

  if (options?.disableFontAutoDiscovery !== true) {
    registerAutoDiscoveredFont(fontManager, options?.preferSystemFonts, options?.textLanguage);
  }

  const fontObjectMap = await fontManager.writeFontResources(writer);
  const { pageObjNums, sheetFirstPage, pagesTreeObjNum } = await renderAllPages(
    allPages,
    fontManager,
    writer,
    fontObjectMap,
    chartCache,
    watermark
  );

  // Every text run has now been routed, so coverage gaps are fully known.
  if (options?.onWarning) {
    fontManager.reportDiagnostics(options.onWarning);
  }

  return buildFinalPdf(
    writer,
    pageObjNums,
    pagesTreeObjNum,
    sheetFirstPage,
    documentOptions,
    workbook,
    options
  );
}
interface PreparedChart {
  stream: PdfContentStream;
  alphaValues: Set<number>;
}

type ChartRenderCache = WeakMap<LayoutChart, PreparedChart>;

function preflightCharts(allPages: LayoutPage[], fontManager: FontManager): ChartRenderCache {
  const cache: ChartRenderCache = new WeakMap();
  for (const page of allPages) {
    for (const chart of page.charts) {
      if (!chart.drawVector) {
        continue;
      }
      const stream = new PdfContentStream();
      const alphaValues = new Set<number>();
      // Black-and-white is a per-sheet print option, and each page carries the
      // options of the sheet that produced it.
      const surface = createChartSurface(
        stream,
        fontManager,
        alphaValues,
        page.options.blackAndWhite
      );
      chart.drawVector(surface, constrainChartAspectRatio(chart.rect));
      cache.set(chart, { stream, alphaValues });
    }
  }
  return cache;
}

function registerAutoDiscoveredFont(
  fontManager: FontManager,
  preferredFamilies: readonly string[] | undefined,
  textLanguage: CjkLanguage | undefined
): void {
  // A fallback face already in hand is *not* the end of the question. Discovery
  // runs once before layout, from the cell text alone, but a header, a footer, a
  // text watermark and a vector chart's labels report their characters only
  // afterwards — so a face chosen for the body could be missing a character that
  // arrived later, and returning here left it to a Type3 NOTDEF box. The builder
  // already reconsidered an incomplete face; this pipeline did not, so the same
  // document came out with tofu through `Pdf.create` and correct through
  // `Pdf.Builder`.
  //
  // A face the caller embedded explicitly is never revisited: `embedFont` is a
  // statement about the document, not a best-effort guess.
  const uncoveredByFallback = fontManager.hasFallbackFont()
    ? fontManager.getUncoveredFallbackCodePoints()
    : null;
  if (fontManager.hasEmbeddedFont() && (uncoveredByFallback?.size ?? 0) === 0) {
    return;
  }
  const codePoints = fontManager.getType3CodePoints();
  if (codePoints.size === 0) {
    return;
  }
  registerSystemFontForCodePoints(
    fontManager,
    codePoints,
    preferredFamilies,
    textLanguage,
    // The manager counted the evidence as every run was tracked.
    fontManager.getTextLanguage(),
    true
  );
}

function registerSystemFontForCodePoints(
  fontManager: FontManager,
  codePoints: ReadonlySet<number>,
  preferredFamilies: readonly string[] | undefined,
  textLanguage: CjkLanguage | undefined,
  detectedLanguage: CjkLanguage | undefined,
  widening = false
): void {
  const ttf = findSystemFontForCodePoints(
    codePoints,
    preferredFamilies ?? [],
    // Han-unified code points cover Chinese, Japanese and Korean alike, so a
    // face picked by coverage alone can draw Chinese in a Japanese hand. The
    // language is counted from the text itself (see `collectNonWinAnsi`) rather
    // than inferred from `codePoints`, which is a Set and has no multiplicity.
    textLanguage ?? detectedLanguage
  );
  if (ttf) {
    // A discovered font lends glyphs for the code points WinAnsi cannot encode;
    // it does not become the document font. Registering it as the document font
    // routed every cell through one regular face, so a single CJK character
    // stripped bold and italic from the whole workbook.
    //
    // `widening` marks the second, post-layout attempt. That one goes through
    // `widenFallbackFont`, which refuses a face that would change a width layout has
    // already used — two CJK faces agree on every ideograph but not on the 345
    // non-Latin-1 code points they share.
    if (widening) {
      if (!fontManager.widenFallbackFont(ttf)) {
        return;
      }
    } else {
      fontManager.registerFallbackFont(ttf);
    }
    // Reported by `reportDiagnostics`, so every pipeline says the same thing.
    fontManager.noteAutoDiscoveredFont(ttf.familyName, codePoints.size);
  }
}

function ensureAtLeastOnePage(
  allPages: LayoutPage[],
  documentOptions: ResolvedPdfOptions,
  sheets: PdfWorkbookSheet[]
): void {
  if (allPages.length === 0) {
    allPages.push({
      pageNumber: 1,
      sheetPageNumber: 1,
      sheetPageIndex: 1,
      sheetPageCount: 1,
      firstPageNumber: undefined,
      options: documentOptions,
      cells: [],
      width: documentOptions.pageSize.width,
      height: documentOptions.pageSize.height,
      sheetName: sheets[0]?.name ?? "Sheet1",
      sheetCols: [],
      columnOffsets: [],
      columnWidths: [],
      sheetRows: [],
      rowYPositions: [],
      rowHeights: [],
      images: [],
      charts: [],
      scaleFactor: 1
    });
  }
}

function fixPageNumbers(allPages: LayoutPage[]): void {
  let automaticPageNumber = 1;
  for (let i = 0; i < allPages.length; i++) {
    const page = allPages[i];
    page.pageNumber = i + 1;
    if (page.sheetPageIndex === 1 && page.firstPageNumber !== undefined) {
      automaticPageNumber = page.firstPageNumber;
    }
    page.sheetPageNumber = automaticPageNumber++;
    page.sheetPageCount = allPages.length;
  }
}

function trackFontsForHeaders(allPages: LayoutPage[], fontManager: FontManager): void {
  for (const page of allPages) {
    if (page.options.showSheetNames) {
      const resourceName = fontManager.resolveFont(page.options.defaultFontFamily, true, false);
      fontManager.trackText(page.sheetName, resourceName);
    }
    if (page.options.showPageNumbers) {
      const resourceName = fontManager.resolveFont(page.options.defaultFontFamily, false, false);
      fontManager.trackText(`Page ${page.pageNumber} of ${allPages.length}`, resourceName);
    }
  }

  for (const page of allPages) {
    for (const content of [
      selectHeaderFooter(page, "header"),
      selectHeaderFooter(page, "footer")
    ]) {
      if (!content) {
        continue;
      }
      for (const runs of [content.left, content.center, content.right]) {
        for (const run of runs) {
          if (run.field === "image") {
            continue;
          }
          const text = resolveHeaderFooterRunText(run, page);
          const resourceName = fontManager.resolveFont(
            run.fontFamily || page.options.defaultFontFamily,
            run.bold,
            run.italic
          );
          fontManager.trackText(text, resourceName);
        }
      }
    }
  }
}

interface RenderResult {
  pageObjNums: number[];
  sheetFirstPage: Map<string, number>;
  pagesTreeObjNum: number;
}

/**
 * Reuses one image XObject per distinct payload. Keyed twice over because the
 * same bytes yield a different object in black-and-white mode.
 */
type ImageObjectCache = WeakMap<Uint8Array, Map<boolean, number>>;

async function renderAllPages(
  allPages: LayoutPage[],
  fontManager: FontManager,
  writer: PdfWriter,
  fontObjectMap: Map<string, number>,
  chartCache: ChartRenderCache,
  watermark?: PdfWatermark
): Promise<RenderResult> {
  const pageObjNums: number[] = [];
  const pagesTreeObjNum = writer.allocObject();
  const sheetFirstPage = new Map<string, number>();
  const totalPages = allPages.length;
  const imageObjectCache: ImageObjectCache = new WeakMap();

  for (let i = 0; i < allPages.length; i++) {
    renderSinglePage(
      allPages[i],
      fontManager,
      writer,
      fontObjectMap,
      chartCache,
      imageObjectCache,
      totalPages,
      pageObjNums,
      pagesTreeObjNum,
      sheetFirstPage,
      watermark
    );
    if (i < allPages.length - 1) {
      await yieldToEventLoop();
    }
  }

  return { pageObjNums, sheetFirstPage, pagesTreeObjNum };
}

function renderSinglePage(
  page: LayoutPage,
  fontManager: FontManager,
  writer: PdfWriter,
  fontObjectMap: Map<string, number>,
  chartCache: ChartRenderCache,
  imageObjectCache: ImageObjectCache,
  totalPages: number,
  pageObjNums: number[],
  pagesTreeObjNum: number,
  sheetFirstPage: Map<string, number>,
  watermark?: PdfWatermark
): void {
  try {
    const { stream: contentStream, alphaValues } = renderPage(
      page,
      page.options,
      fontManager,
      totalPages
    );

    // Handle images: create XObject Image entries and draw them
    const imageXObjects = new Map<string, number>();
    // Raster payloads are converted when the XObject is written — a real pixel
    // conversion for PNG, a `/DeviceN` luma space for JPEG — so no overlay is
    // painted and transparency is preserved.
    const grayscaleRaster = page.options.blackAndWhite;
    let headerImageContentObjNum: number | undefined;
    const headerContent = selectHeaderFooter(page, "header");
    const footerContent = selectHeaderFooter(page, "footer");
    const headerImages = page.headerFooter?.images ?? [];
    const activePositions = new Set([
      ...headerFooterImagePositions(headerContent, "H"),
      ...headerFooterImagePositions(footerContent, "F")
    ]);
    if (headerImages.length > 0 && activePositions.size > 0) {
      const imageStream = new PdfContentStream();
      const alignWithMargins = page.headerFooter?.alignWithMargins !== false;
      const leftEdge = alignWithMargins ? page.options.margins.left : 18;
      const rightEdge = alignWithMargins
        ? page.width - page.options.margins.right
        : page.width - 18;
      // `scaleWithDoc` governs the whole header/footer, not just its text, so a
      // logo has to shrink with the grid the same way the runs do.
      const hfScale = page.headerFooter?.scaleWithDoc === false ? 1 : page.scaleFactor;
      for (let index = 0; index < headerImages.length; index++) {
        const headerImage = headerImages[index];
        if (!activePositions.has(headerImage.position)) {
          continue;
        }
        const imageName = `HfIm${index + 1}`;
        imageXObjects.set(
          imageName,
          getOrWriteImageObject(
            writer,
            imageObjectCache,
            headerImage.data,
            headerImage.format,
            grayscaleRaster
          )
        );
        const drawWidth = headerImage.width * hfScale;
        const drawHeight = headerImage.height * hfScale;
        const placement = headerFooterImagePlacement(headerImage.position);
        const imageX =
          placement.section === "left"
            ? leftEdge
            : placement.section === "right"
              ? rightEdge - drawWidth
              : (page.width - drawWidth) / 2;
        const imageY =
          placement.kind === "header"
            ? page.height - page.options.headerMargin - drawHeight
            : page.options.footerMargin;
        imageStream.drawImage(imageName, imageX, imageY, drawWidth, drawHeight);
      }
      headerImageContentObjNum = writer.allocObject();
      writer.addStreamObject(headerImageContentObjNum, new PdfDict(), imageStream);
    }
    if (page.images.length > 0) {
      for (let imgIdx = 0; imgIdx < page.images.length; imgIdx++) {
        const img = page.images[imgIdx];
        const imgName = `Im${imgIdx + 1}`;
        const imgObjNum = getOrWriteImageObject(
          writer,
          imageObjectCache,
          img.data,
          img.format,
          grayscaleRaster
        );
        imageXObjects.set(imgName, imgObjNum);
        contentStream.drawImage(imgName, img.rect.x, img.rect.y, img.rect.width, img.rect.height);
      }
    }

    // Handle charts. Two paths:
    //  - `drawVector` charts go through a {@link createChartSurface}
    //    adapter so the vector PDF operators (lines, text, shapes) land
    //    in the same content stream as the cells. Text stays selectable
    //    and the chart scales crisply at any zoom level.
    //  - `raster` charts fall back to the image XObject pipeline, which
    //    is identical to an embedded PNG. Used only for ChartEx layouts
    //    outside the vector-render whitelist.
    if (page.charts.length > 0) {
      let rasterCounter = page.images.length;
      for (const chart of page.charts) {
        if (chart.drawVector) {
          const prepared = chartCache.get(chart);
          if (!prepared) {
            throw new PdfRenderError("Vector chart was not prepared before font resources");
          }
          contentStream.append(prepared.stream);
          for (const alpha of prepared.alphaValues) {
            alphaValues.add(alpha);
          }
          continue;
        }
        if (chart.raster) {
          const imgName = `Im${++rasterCounter}`;
          const imgObjNum = getOrWriteImageObject(
            writer,
            imageObjectCache,
            chart.raster.data,
            chart.raster.format,
            grayscaleRaster
          );
          imageXObjects.set(imgName, imgObjNum);
          contentStream.drawImage(
            imgName,
            chart.rect.x,
            chart.rect.y,
            chart.rect.width,
            chart.rect.height
          );
        }
      }
    }

    // --- Render watermark into a separate content stream ---
    // PDF supports Contents as an array of stream references. The watermark stream
    // is placed BEFORE the main content stream so it renders behind everything.
    let watermarkContentObjNum: number | undefined;
    const shouldApplyWatermark = watermark && isWatermarkApplicable(watermark, page);
    if (shouldApplyWatermark) {
      const wmContentStream = new PdfContentStream();
      const wmResult = renderWatermark(wmContentStream, page, watermark, fontManager);

      // Register watermark alpha values in the shared set
      for (const alpha of wmResult.alphaValues) {
        alphaValues.add(alpha);
      }

      // Register watermark image XObjects
      for (const wmImg of wmResult.imageXObjects) {
        const imgObjNum = getOrWriteImageObject(
          writer,
          imageObjectCache,
          wmImg.data,
          wmImg.format,
          grayscaleRaster
        );
        imageXObjects.set(wmImg.name, imgObjNum);
      }

      // Write watermark content stream object
      watermarkContentObjNum = writer.allocObject();
      writer.addStreamObject(watermarkContentObjNum, new PdfDict(), wmContentStream);
    }

    // Add main content stream object
    const contentObjNum = writer.allocObject();
    writer.addStreamObject(contentObjNum, new PdfDict(), contentStream);

    // Build Contents reference — array if watermark exists, single ref otherwise.
    // placement "under" (default): watermark stream first, then content
    // placement "over": content first, then watermark stream on top
    let contentsRef: string;
    if (watermarkContentObjNum || headerImageContentObjNum) {
      const placement = watermark?.placement ?? "under";
      const underRefs = [headerImageContentObjNum, watermarkContentObjNum]
        .filter((value): value is number => value !== undefined)
        .map(pdfRef);
      if (placement === "over") {
        const overRef = watermarkContentObjNum ? ` ${pdfRef(watermarkContentObjNum)}` : "";
        const headerRef = headerImageContentObjNum ? `${pdfRef(headerImageContentObjNum)} ` : "";
        contentsRef = `[${headerRef}${pdfRef(contentObjNum)}${overRef}]`;
      } else {
        contentsRef = `[${underRefs.join(" ")} ${pdfRef(contentObjNum)}]`;
      }
    } else {
      contentsRef = pdfRef(contentObjNum);
    }

    // Add resources dictionary object
    const resourcesObjNum = writer.allocObject();
    const fontDictStr = fontManager.buildFontDictString(fontObjectMap);
    const resourcesDict = new PdfDict().set("Font", fontDictStr);
    if (imageXObjects.size > 0) {
      const xobjParts = ["<<"];
      for (const [name, objNum] of imageXObjects) {
        xobjParts.push(`/${name} ${pdfRef(objNum)}`);
      }
      xobjParts.push(">>");
      resourcesDict.set("XObject", xobjParts.join("\n"));
    }
    if (alphaValues.size > 0) {
      const gsParts = ["<<"];
      for (const alpha of alphaValues) {
        const gsObjNum = writer.allocObject();
        const gsDict = new PdfDict()
          .set("Type", "/ExtGState")
          .set("ca", pdfNumber(alpha))
          .set("CA", pdfNumber(alpha));
        writer.addObject(gsObjNum, gsDict);
        gsParts.push(`/${alphaGsName(alpha)} ${pdfRef(gsObjNum)}`);
      }
      gsParts.push(">>");
      resourcesDict.set("ExtGState", gsParts.join("\n"));
    }
    writer.addObject(resourcesObjNum, resourcesDict);

    // Create link annotations for hyperlinks
    const annotRefs: number[] = [];
    for (const cell of page.cells) {
      if (cell.hyperlink) {
        const annotObjNum = writer.allocObject();
        const rect = `[${pdfNumber(cell.rect.x)} ${pdfNumber(cell.rect.y)} ${pdfNumber(cell.rect.x + cell.rect.width)} ${pdfNumber(cell.rect.y + cell.rect.height)}]`;
        const annotDict = new PdfDict()
          .set("Type", "/Annot")
          .set("Subtype", "/Link")
          .set("Rect", rect)
          .set("Border", "[0 0 0]")
          .set(
            "A",
            `<< /Type /Action /S /URI /URI (${cell.hyperlink.replace(/[()\\]/g, "\\$&")}) >>`
          );
        writer.addObject(annotObjNum, annotDict);
        annotRefs.push(annotObjNum);
      }
    }

    // Add page object
    const pageObjNum = writer.addPage({
      parentRef: pagesTreeObjNum,
      width: page.width,
      height: page.height,
      contentsRef: contentsRef,
      resourcesRef: resourcesObjNum,
      // Constant alpha needs a defined backdrop.
      transparencyGroup: alphaValues.size > 0,
      annotRefs: annotRefs.length > 0 ? annotRefs : undefined
    });

    pageObjNums.push(pageObjNum);

    if (!sheetFirstPage.has(page.sheetName)) {
      sheetFirstPage.set(page.sheetName, pageObjNums.length - 1);
    }
  } catch (err) {
    throw new PdfRenderError(`Failed to render page ${page.pageNumber} of "${page.sheetName}"`, {
      cause: err
    });
  }
}

function getOrWriteImageObject(
  writer: PdfWriter,
  cache: ImageObjectCache,
  data: Uint8Array,
  format: "png" | "jpeg",
  grayscale = false
): number {
  let variants = cache.get(data);
  if (variants === undefined) {
    variants = new Map();
    cache.set(data, variants);
  }
  const existing = variants.get(grayscale);
  if (existing !== undefined) {
    return existing;
  }
  const objectNumber = writeImageXObject(writer, data, format, grayscale);
  variants.set(grayscale, objectNumber);
  return objectNumber;
}

function headerFooterImagePositions(
  content: ReturnType<typeof selectHeaderFooter>,
  kind: "H" | "F"
): Array<"LH" | "CH" | "RH" | "LF" | "CF" | "RF"> {
  if (!content) {
    return [];
  }
  const sections: Array<"LH" | "CH" | "RH" | "LF" | "CF" | "RF"> = [];
  for (const section of ["left", "center", "right"] as const) {
    if (content[section].some(run => run.field === "image")) {
      sections.push(`${section === "left" ? "L" : section === "right" ? "R" : "C"}${kind}`);
    }
  }
  return sections;
}

function headerFooterImagePlacement(position: "LH" | "CH" | "RH" | "LF" | "CF" | "RF"): {
  section: "left" | "center" | "right";
  kind: "header" | "footer";
} {
  return {
    section: position[0] === "L" ? "left" : position[0] === "R" ? "right" : "center",
    kind: position[1] === "H" ? "header" : "footer"
  };
}

function buildFinalPdf(
  writer: PdfWriter,
  pageObjNums: number[],
  pagesTreeObjNum: number,
  sheetFirstPage: Map<string, number>,
  documentOptions: ResolvedPdfOptions,
  workbook: PdfWorkbook,
  options?: PdfExportOptions
): Uint8Array {
  // --- Step 4: Build page tree ---
  const pagesKids = "[" + pageObjNums.map(n => pdfRef(n)).join(" ") + "]";
  const pagesDict = new PdfDict()
    .set("Type", "/Pages")
    .set("Kids", pagesKids)
    .set("Count", String(pageObjNums.length));
  writer.addObject(pagesTreeObjNum, pagesDict);

  // --- Step 5: Build outlines (bookmarks) for sheet navigation ---
  let outlinesRef: number | undefined;
  if (sheetFirstPage.size > 1) {
    outlinesRef = buildOutlines(writer, sheetFirstPage, pageObjNums);
  }

  // --- Step 6: Build catalog ---
  writer.addCatalog(pagesTreeObjNum, outlinesRef);

  // --- Step 7: Add document info ---
  writer.addInfoDict({
    title: documentOptions.title || workbook.title || undefined,
    author: documentOptions.author || workbook.creator || undefined,
    subject: documentOptions.subject || workbook.subject || undefined,
    creator: documentOptions.creator
  });

  // --- Step 8: Enable encryption if requested ---
  if (options?.encryption) {
    const encState = initEncryption(options.encryption);
    writer.setEncryption(encState);
  }

  // --- Step 9: Build the PDF ---
  return writer.build();
}

// =============================================================================
// Sheet Selection
// =============================================================================

/**
 * Select which sheets to export based on the options.
 */
function selectSheets(workbook: PdfWorkbook, sheets?: (string | number)[]): PdfWorkbookSheet[] {
  const allSheets = workbook.sheets;

  if (!sheets || sheets.length === 0) {
    // Export all visible sheets
    return allSheets.filter(ws => ws.state !== "hidden" && ws.state !== "veryHidden");
  }

  const result: PdfWorkbookSheet[] = [];
  for (const selector of sheets) {
    if (typeof selector === "string") {
      const ws = allSheets.find(s => s.name.toLowerCase() === selector.toLowerCase());
      if (ws) {
        result.push(ws);
      }
    } else if (typeof selector === "number") {
      // 1-based position in the sheets array
      const ws = allSheets[selector - 1];
      if (ws) {
        result.push(ws);
      }
    }
  }

  return result;
}

// =============================================================================
// Options Resolution
// =============================================================================

/**
 * Parse an Excel "Columns to repeat at left" reference (`printTitlesColumn`)
 * into an absolute column band, e.g. `"A:B"` → `{ first: 1, last: 2 }`.
 *
 * Returns `null` for anything that is not a column range.
 */
function parseTitlesColumnBand(ref: string): PdfRepeatBand | null {
  const match = ref
    .replace(/\$/g, "")
    .toUpperCase()
    .match(/^([A-Z]+)(?::([A-Z]+))?$/);
  if (!match) {
    return null;
  }
  const first = columnLettersToNumber(match[1]);
  const last = match[2] ? columnLettersToNumber(match[2]) : first;
  if (last < first) {
    return null;
  }
  return { first, last };
}

/**
 * Parse an Excel "Rows to repeat at top" reference (`printTitlesRow`) into an
 * absolute row band, e.g. `"1:3"` → `{ first: 1, last: 3 }`.
 */
function parseTitlesRowBand(ref: string): PdfRepeatBand | null {
  const match = ref.replace(/\$/g, "").match(/^(\d+)(?::(\d+))?$/);
  if (!match) {
    return null;
  }
  const first = parseInt(match[1], 10);
  const last = match[2] ? parseInt(match[2], 10) : first;
  if (first < 1 || last < first) {
    return null;
  }
  return { first, last };
}

function columnLettersToNumber(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
}

function normalizePageOrder(value: string | undefined): PdfPageOrder {
  return value === "overThenDown" ? "overThenDown" : "downThenOver";
}

/** Excel writes `None` / `asDisplayed` / `atEnd`. */
function normalizeCommentMode(value: string | undefined): PdfCellCommentMode {
  if (value === "atEnd" || value === "asDisplayed") {
    return value;
  }
  return "none";
}

function normalizeErrorMode(value: string | undefined): PdfCellErrorMode {
  switch (value) {
    case "blank":
    case "dash":
    case "NA":
      return value;
    default:
      return "displayed";
  }
}

/**
 * Reconcile documonster's scaling options with Excel's two mutually exclusive
 * scaling modes (Page Setup → Scaling):
 *
 *  - **"Adjust to N %"** — `pageSetup.scale`, with `pageSetup.fitToPage` off.
 *  - **"Fit to N pages wide by M tall"** — `pageSetup.fitToWidth` /
 *    `fitToHeight`, with `pageSetup.fitToPage` on. Excel ignores `scale` here.
 *
 * Neither mode ever enlarges: Excel caps fit-to-page scaling at 100%.
 *
 * `PdfExportOptions.fitToPage` is documonster's own convenience default
 * ("shrink to one page wide"). It only applies when neither the caller nor the
 * sheet expresses a scaling intent, so a sheet that asks for 80% is not
 * shrunk twice.
 */
function resolveScaling(
  options: PdfExportOptions | undefined,
  ps: PdfPageSetupData | undefined
): { fitToPage: boolean; scale: number; fitToWidth: number; fitToHeight: number } {
  const clampPages = (n: number | undefined): number =>
    n === undefined || !Number.isFinite(n) || n <= 0 ? 0 : Math.floor(n);

  const callerFit = options?.fitToWidth !== undefined || options?.fitToHeight !== undefined;
  const sheetFitMode = ps?.fitToPage === true;

  let fitToWidth = 0;
  let fitToHeight = 0;
  if (callerFit) {
    fitToWidth = clampPages(options?.fitToWidth);
    fitToHeight = clampPages(options?.fitToHeight);
  } else if (sheetFitMode && options?.scale === undefined && options?.fitToPage !== false) {
    // `fitToPage: false` is the caller saying "do not auto-scale"; it has to
    // beat the sheet's own fit-to-N mode, or an explicit option would lose to
    // the workbook it is meant to override.
    fitToWidth = clampPages(ps?.fitToWidth);
    fitToHeight = clampPages(ps?.fitToHeight);
  }

  // A sheet in "Adjust to N %" mode with a non-default percentage.
  const sheetScalePercent =
    !sheetFitMode && ps?.scale !== undefined && ps.scale !== 100 ? ps.scale / 100 : undefined;

  // Excel's Page Setup allows 10–400%, so the ceiling is 4.0 rather than 3.0.
  const scale = Math.max(0.1, Math.min(4.0, options?.scale ?? sheetScalePercent ?? 1.0));

  const hasFitConstraint = fitToWidth > 0 || fitToHeight > 0;
  const fitToPage =
    options?.fitToPage ?? !(hasFitConstraint || sheetScalePercent !== undefined || callerFit);

  return { fitToPage, scale, fitToWidth, fitToHeight };
}

/**
 * Resolve user options with defaults.
 */
function resolveOptions(
  options: PdfExportOptions | undefined,
  sheet?: PdfWorkbookSheet
): ResolvedPdfOptions {
  // Use sheet's pageSetup as fallback for unspecified options. Chartsheets
  // expose a narrower pageSetup shape (`CT_CsPageSetup`) — the fields we
  // care about (orientation, paperSize, margins) live in the same places
  // so the same destructuring works.
  const ps = sheet?.pageSetup;

  const pageSize = resolvePageSize(options?.pageSize, ps?.paperSize);
  // Chartsheets carry their own `orientation` override (Excel defaults
  // to landscape for chartsheets); if set, it wins over the pageSetup
  // fallback. Note: `layoutChartsheet` applies the same rule in its
  // own clone of the resolved options, so selecting orientation here
  // is only the document-level hint.
  const chartsheetOrientation = sheet && isPdfChartsheet(sheet) ? sheet.orientation : undefined;
  const orientation: PdfOrientation =
    options?.orientation ??
    chartsheetOrientation ??
    (ps?.orientation === "landscape" ? "landscape" : "portrait");
  const margins = resolveMargins(options?.margins, ps?.margins);

  const blackAndWhite = options?.blackAndWhite ?? ps?.blackAndWhite ?? false;

  const gridLineColorStr = options?.gridLineColor ?? "FFD0D0D0";
  const gridLineColorRaw: PdfColor = argbToPdfColor(gridLineColorStr) ?? {
    r: 0.816,
    g: 0.816,
    b: 0.816
  };
  const gridLineColor = blackAndWhite ? toGrayscale(gridLineColorRaw) : gridLineColorRaw;

  // Repeated title rows/columns fall back to the sheet's print titles. Only
  // PdfSheetData carries them — chartsheets have no repeated bands. An
  // explicitly passed `false` suppresses the sheet setting, so "not provided"
  // (undefined) and "provided as off" must stay distinguishable.
  const isWorksheet = Boolean(sheet) && !isPdfChartsheet(sheet!);
  // A caller-supplied count means "the first N rows/columns of the sheet"; the
  // sheet's own print titles are absolute ranges that may sit outside the print
  // area, so both normalise to an absolute band.
  const countToBand = (n: number | false): PdfRepeatBand | false =>
    typeof n === "number" && n > 0 ? { first: 1, last: n } : false;

  let repeatRows: PdfRepeatBand | false = false;
  if (options?.repeatRows !== undefined) {
    repeatRows = countToBand(options.repeatRows);
  } else if (isWorksheet && ps?.printTitlesRow) {
    repeatRows = parseTitlesRowBand(ps.printTitlesRow) ?? false;
  }

  let repeatCols: PdfRepeatBand | false = false;
  if (options?.repeatCols !== undefined) {
    repeatCols = countToBand(options.repeatCols);
  } else if (isWorksheet && ps?.printTitlesColumn) {
    repeatCols = parseTitlesColumnBand(ps.printTitlesColumn) ?? false;
  }

  const { fitToPage, scale, fitToWidth, fitToHeight } = resolveScaling(options, ps);

  return {
    pageSize,
    orientation,
    margins,
    ignorePrintArea: options?.ignorePrintArea ?? false,
    fitToPage,
    scale,
    fitToWidth,
    fitToHeight,
    showGridLines: options?.showGridLines ?? ps?.showGridLines ?? false,
    gridLineColor,
    showRowColHeaders: options?.showRowColHeaders ?? ps?.showRowColHeaders ?? false,
    horizontalCentered: options?.horizontalCentered ?? ps?.horizontalCentered ?? false,
    verticalCentered: options?.verticalCentered ?? ps?.verticalCentered ?? false,
    pageOrder: options?.pageOrder ?? normalizePageOrder(ps?.pageOrder),
    blackAndWhite,
    draft: options?.draft ?? ps?.draft ?? false,
    errors: options?.errors ?? normalizeErrorMode(ps?.errors),
    cellComments: options?.cellComments ?? normalizeCommentMode(ps?.cellComments),
    repeatRows,
    repeatCols,
    defaultFontFamily: options?.defaultFontFamily ?? "Helvetica",
    defaultFontSize: options?.defaultFontSize ?? 11,
    showSheetNames: options?.showSheetNames ?? false,
    showPageNumbers: options?.showPageNumbers ?? false,
    includeHeadersFooters: options?.headerFooter?.enabled ?? true,
    headerMargin: (ps?.margins?.header ?? 0.3) * 72,
    footerMargin: (ps?.margins?.footer ?? 0.3) * 72,
    sourceFileName: options?.headerFooter?.fileName ?? "",
    sourceFilePath: options?.headerFooter?.filePath ?? "",
    headerFooterDate: options?.headerFooter?.date ?? new Date(),
    headerFooterLocale: options?.headerFooter?.locale,
    title: options?.title ?? "",
    author: options?.author ?? "",
    subject: options?.subject ?? "",
    creator: options?.creator ?? "documonster",
    watermark: options?.watermark
  };
}

/** Map PaperSize enum values to PDF page sizes. */
const PAPER_SIZE_MAP: Record<number, PdfPageSize> = {
  1: PageSizes.LETTER,
  5: PageSizes.LEGAL,
  9: PageSizes.A4,
  8: PageSizes.A3,
  11: PageSizes.A5,
  17: PageSizes.TABLOID
};

function resolvePageSize(
  size: PdfExportOptions["pageSize"] | undefined,
  paperSize?: number
): PdfPageSize {
  if (size) {
    if (typeof size === "string") {
      return PageSizes[size] ?? PageSizes.A4;
    }
    return size;
  }
  // Fallback to sheet paperSize
  if (paperSize !== undefined) {
    return PAPER_SIZE_MAP[paperSize] ?? PageSizes.A4;
  }
  return PageSizes.A4;
}

/**
 * Resolve margins with defaults. Sheet margins are in inches, convert to points (×72).
 * When partial PDF margins are specified, unset sides fall back to sheet margins,
 * then to the default 72pt (1 inch).
 */
function resolveMargins(
  margins?: Partial<PdfMargins>,
  wsMargins?: { left: number; right: number; top: number; bottom: number }
): PdfMargins {
  // Build a base from sheet pageSetup margins (inches → points), or default 72pt
  const base: PdfMargins = wsMargins
    ? {
        top: wsMargins.top * 72,
        right: wsMargins.right * 72,
        bottom: wsMargins.bottom * 72,
        left: wsMargins.left * 72
      }
    : { top: 72, right: 72, bottom: 72, left: 72 };

  if (!margins) {
    return base;
  }

  return {
    top: margins.top ?? base.top,
    right: margins.right ?? base.right,
    bottom: margins.bottom ?? base.bottom,
    left: margins.left ?? base.left
  };
}

// =============================================================================
// PDF Outlines (Bookmarks)
// =============================================================================

/**
 * Build a PDF outlines tree for sheet-level navigation.
 * Creates one bookmark entry per sheet, pointing to the first page.
 */
function buildOutlines(
  writer: PdfWriter,
  sheetFirstPage: Map<string, number>,
  pageObjNums: number[]
): number {
  const outlinesObjNum = writer.allocObject();
  const entries = Array.from(sheetFirstPage.entries());

  // Allocate outline item object numbers
  const itemObjNums: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    itemObjNums.push(writer.allocObject());
  }

  // Write outline items
  for (let i = 0; i < entries.length; i++) {
    const [sheetName, pageIndex] = entries[i];
    const pageObjNum = pageObjNums[pageIndex];
    const itemDict = new PdfDict()
      .set("Title", pdfStr(sheetName))
      .set("Parent", pdfRef(outlinesObjNum))
      .set("Dest", `[${pdfRef(pageObjNum)} /Fit]`);

    if (i > 0) {
      itemDict.set("Prev", pdfRef(itemObjNums[i - 1]));
    }
    if (i < entries.length - 1) {
      itemDict.set("Next", pdfRef(itemObjNums[i + 1]));
    }

    writer.addObject(itemObjNums[i], itemDict);
  }

  // Write outlines root
  const outlinesDict = new PdfDict()
    .set("Type", "/Outlines")
    .set("First", pdfRef(itemObjNums[0]))
    .set("Last", pdfRef(itemObjNums[itemObjNums.length - 1]))
    .set("Count", String(entries.length));
  writer.addObject(outlinesObjNum, outlinesDict);

  return outlinesObjNum;
}

// =============================================================================
// Watermark Filtering
// =============================================================================

/**
 * Check if a watermark should be applied to a specific page based on
 * optional page number and sheet name filters.
 */
function isWatermarkApplicable(watermark: PdfWatermark, page: LayoutPage): boolean {
  if (watermark.pages && watermark.pages.length > 0) {
    if (!watermark.pages.includes(page.pageNumber)) {
      return false;
    }
  }
  if (watermark.sheets && watermark.sheets.length > 0) {
    // Case-insensitive sheet name matching, consistent with the rest of the API
    const sheetLower = page.sheetName.toLowerCase();
    if (!watermark.sheets.some(s => s.toLowerCase() === sheetLower)) {
      return false;
    }
  }
  return true;
}

// =============================================================================
// Non-WinAnsi Detection
// =============================================================================

/**
 * Collect all non-WinAnsi code points from sheet text (single pass).
 * Returns an empty set if all text is WinAnsi-representable.
 *
 * Chartsheets are skipped — the chart surface renders text via the
 * same font manager but the characters come from the chart model (axis
 * labels, data labels, title), which gets tracked via `fontManager.trackText`
 * during rendering rather than here. This keeps the font-discovery scan
 * focused on cell text, which is where non-WinAnsi characters
 * overwhelmingly appear.
 */
function collectNonWinAnsi(sheets: PdfWorkbookSheet[]): {
  codePoints: Set<number>;
  evidence: CjkLanguageEvidence;
} {
  const result = new Set<number>();
  const evidence = createCjkLanguageEvidence();
  for (const sheet of sheets) {
    const headerFooter = sheet.headerFooter;
    if (headerFooter) {
      for (const content of [
        headerFooter.oddHeader,
        headerFooter.oddFooter,
        headerFooter.evenHeader,
        headerFooter.evenFooter,
        headerFooter.firstHeader,
        headerFooter.firstFooter
      ]) {
        if (!content) {
          continue;
        }
        for (const runs of [content.left, content.center, content.right]) {
          for (const run of runs) {
            collectFromText(run.text, result, evidence);
          }
        }
      }
    }
    if (isPdfChartsheet(sheet)) {
      continue;
    }
    for (const row of sheet.rows.values()) {
      for (const cell of row.cells.values()) {
        collectFromText(cell.text, result, evidence);
        if (
          cell.type === PdfCellType.RichText &&
          cell.value &&
          typeof cell.value === "object" &&
          "richText" in cell.value
        ) {
          const runs = (cell.value as { richText: Array<{ text?: string }> }).richText;
          for (const run of runs) {
            collectFromText(run.text, result, evidence);
          }
        }
      }
    }
  }
  return { codePoints: result, evidence };
}

function collectFromText(
  text: string | undefined,
  out: Set<number>,
  evidence: CjkLanguageEvidence
): void {
  if (!text) {
    return;
  }
  // Counted here, where the text still has its repetitions, because `out` is a
  // Set and cannot carry them.
  addCjkLanguageEvidence(evidence, text);
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++;
    }
    if (!isWinAnsiCodePoint(cp)) {
      out.add(cp);
    }
  }
}

// =============================================================================
// Chart Aspect Ratio Constraint
// =============================================================================

/**
 * Constrain a chart drawing rectangle to a reasonable aspect ratio.
 *
 * Charts render best at roughly 16:9 (landscape) to 4:3. When the
 * allocated page rect has an extreme ratio (e.g. very wide + short, or
 * very tall + narrow — common when the chart anchor spans many rows but
 * few columns or vice versa), letterbox the chart within the rect using
 * a target ratio of 16:9 so it renders with correct proportions.
 *
 * The returned rect is centred within the original rect.
 */
function constrainChartAspectRatio(rect: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const { x, y, width, height } = rect;
  if (width <= 0 || height <= 0) {
    return rect;
  }
  const ratio = width / height;
  // Target aspect ratio: 16:9 ≈ 1.78. Allow a generous range [1.0, 2.5]
  // before applying correction. This avoids touching charts that already
  // have a reasonable shape (e.g. 4:3 = 1.33, 16:9 = 1.78).
  const minRatio = 1.0;
  const maxRatio = 2.5;
  const targetRatio = 16 / 9; // 1.778

  if (ratio >= minRatio && ratio <= maxRatio) {
    // Already in acceptable range — use as-is.
    return rect;
  }

  let newWidth = width;
  let newHeight = height;
  if (ratio > maxRatio) {
    // Too wide — shrink width to fit target ratio within the height.
    newWidth = height * targetRatio;
  } else {
    // Too tall — shrink height to fit target ratio within the width.
    newHeight = width / targetRatio;
  }
  // Centre within the original rect.
  const dx = (width - newWidth) / 2;
  const dy = (height - newHeight) / 2;
  return {
    x: x + dx,
    y: y + dy,
    width: newWidth,
    height: newHeight
  };
}
