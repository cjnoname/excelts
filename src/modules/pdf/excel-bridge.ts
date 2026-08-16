/**
 * Excel-to-PDF Bridge
 *
 * Converts Excel Workbook data into the PDF module's independent data model.
 * Among the PDF module's files, this one (together with `word-bridge.ts`
 * and `word-chart-bridge.ts`) is permitted to reach across module
 * boundaries; this file imports only from `@excel`. Word-chart rendering
 * (which needs both `@word` types and the `@excel` chart engine) lives in
 * `word-chart-bridge.ts`.
 *
 * @example
 * ```typescript
 * import { Workbook } from "documonster/excel";
 * import { excelToPdf } from "documonster/pdf";
 *
 * const workbook = Workbook.create();
 * // ... build workbook ...
 * const pdf = await excelToPdf(workbook);
 * ```
 */

import type {
  ChartHandle,
  ChartExModel,
  ChartModel,
  ChartPdfDrawingSurface,
  RegionMapDataOptions
} from "@excel/chart";
// Chart runtime is imported statically. The chart modules depend only on the
// excel `*-core` data layer, so excel→PDF conversion pulls in chart rendering
// only when the bundler can reach it (i.e. when `excelToPdf` is used). No
// install step is required.
import { fillChartExCachesForRendering } from "@excel/chart/bridge/excel-chart-host";
import { chartChartExModel, chartChartModel } from "@excel/chart/chart-handle";
import {
  canRenderChartExAsVectorPdf,
  drawChartExPdf,
  renderChartExPng
} from "@excel/chart/render/chart-ex-renderer";
import { drawChartPdf, renderChartPng } from "@excel/chart/render/chart-renderer";
import { anchorCol, anchorRow } from "@excel/core/anchor";
import {
  cellCol,
  cellComment,
  cellGetValue,
  cellHyperlink,
  cellResult,
  cellText,
  cellType,
  mergeCellStyle
} from "@excel/core/cell";
import type { CellData } from "@excel/core/cell";
import type { ChartsheetData } from "@excel/core/chartsheet";
import {
  chartsheetChartExModel,
  chartsheetChartModel,
  chartsheetModel,
  chartsheetName,
  chartsheetPageSetup,
  chartsheetPageMargins,
  chartsheetState
} from "@excel/core/chartsheet";
import { ValueType } from "@excel/core/enums";
import type { NoteData } from "@excel/core/note";
import type { RowData } from "@excel/core/row";
import { computeSparklineGeometry } from "@excel/core/sparkline";
import type { SparklineGroup } from "@excel/core/sparkline";
import { getChartsheets, getImage, getWorksheets } from "@excel/core/workbook";
import { getWorksheet } from "@excel/core/workbook-core";
// Use the browser base class so the public `excelToPdf(workbook)` signature is
// callable from both the Node entry (where `Workbook` is the Node subclass —
// trivially assignable to the base) and the browser entry (where `Workbook` is
// already the base). Importing the Node alias `@excel/workbook` would force
// browser consumers to satisfy `xlsx.readFile`/`writeFile`, which the browser
// XLSX surface intentionally omits.
import type { Workbook } from "@excel/core/workbook.browser";
import {
  findCell,
  findRow,
  getCharts,
  getImages,
  getHasMerges,
  getSheetDimensions,
  getSheetModel,
  getSheetName,
  getSheetWorkbook,
  getWatermark,
  getSparklineGroups
} from "@excel/core/worksheet";
import type { Worksheet } from "@excel/core/worksheet";
import type {
  Style,
  Font,
  Color,
  Fill,
  Border,
  Borders,
  Alignment,
  CellRichTextValue,
  HeaderFooter
} from "@excel/types";
import { formatCellValue } from "@excel/utils/cell-format";
import { PdfDocumentBuilder } from "@pdf/builder/document-builder";
import type { PdfFontConfig } from "@pdf/font/font-config";
import { exportPdf } from "@pdf/render/pdf-exporter";
import type {
  PdfWorkbook,
  PdfSheetData,
  PdfWorkbookSheet,
  PdfChartsheetData,
  PdfRowData,
  PdfCellData,
  PdfColumnData,
  PdfCellStyle,
  PdfFillData,
  PdfColorData,
  PdfFontStyle,
  PdfBordersData,
  PdfBorderSideData,
  PdfAlignmentData,
  PdfPageSetupData,
  PdfHeaderFooterContent,
  PdfHeaderFooterData,
  PdfHeaderFooterRun,
  PdfSheetImage,
  PdfSheetChart,
  PdfSheetComment,
  PdfCommentAnchor,
  PdfAnchorRange,
  PdfExportOptions,
  PdfCellTypeValue
} from "@pdf/types";
import { PdfCellType } from "@pdf/types";
import { hexToRgb01 } from "@utils/theme-colors";
import { emuToPx } from "@utils/units";
import { base64ToUint8Array } from "@utils/utils.base";

// =============================================================================
// Public API
// =============================================================================

// Re-export the Excel object-model types used in this bridge's public
// signatures so the `Pdf` surface can type its lazy converter wrappers
// (`fromExcel`/`fromChart`) without importing from `@excel` directly —
// only bridge files may cross into `@excel`.
export type { Workbook } from "@excel/core/workbook.browser";
export type { ChartHandle } from "@excel/core/worksheet-core";

/**
 * Options for {@link excelToPdf} — the PDF export options plus the Excel-only
 * `recalculate` hook.
 *
 * `recalculate` is declared here rather than on `PdfExportOptions` because it
 * is typed against the Excel workbook, which only bridge files may reference.
 */
export interface ExcelToPdfOptions extends PdfExportOptions {
  /**
   * Optional formula recalculator, injected to avoid a static dependency on
   * the ~200 KB formula engine. Pass `calculateFormulas` from
   * `documonster/excel/formula` to recompute formula results before export;
   * omit it to use the workbook's existing cached results. Explicit
   * replacement for the old formula host-registry — only opt-in callers pull
   * the engine into their bundle.
   */
  recalculate?: (workbook: Workbook) => void;
}

/**
 * Export an Excel Workbook directly to PDF.
 *
 * This is a convenience function that converts the Workbook to the PDF module's
 * data model and then generates the PDF.
 * Yields to the event loop between each output page during layout and rendering.
 *
 * @param workbook - An Excel Workbook instance
 * @param options  - PDF export options
 * @returns Promise of PDF file as a Uint8Array
 */
export async function excelToPdf(
  workbook: Workbook,
  options?: ExcelToPdfOptions
): Promise<Uint8Array> {
  // Recalculate all formulas before conversion so that formula results
  // reflect the latest cell values (fixes stale cached results from XLSX).
  //
  // The formula engine is opt-in via explicit injection: callers pass
  // `{ recalculate: calculateFormulas }` (from `documonster/excel/formula`) to
  // recompute; callers who don't fall back to the cached results the XLSX
  // shipped with. This keeps the ~200 KB engine out of bundles that only
  // export already-computed workbooks — no host-registry needed.
  options?.recalculate?.(workbook);

  const pdfWorkbook = await excelWorkbookToPdf(workbook, options);
  return exportPdf(pdfWorkbook, options);
}

/**
 * Options for {@link chartToPdf}.
 */
export interface ChartToPdfOptions {
  /** PDF page width in points. Default: max(chart width + 72, 400). */
  pageWidth?: number;
  /** PDF page height in points. Default: max(chart height + 72, 300). */
  pageHeight?: number;
  /** Chart render width in points. Default: 520. */
  width?: number;
  /** Chart render height in points. Default: 360. */
  height?: number;
  /**
   * Left margin in points between the chart and the page edge. Default: 36.
   * Used as top margin too so the chart sits in a 36-pt gutter.
   */
  margin?: number;
  /**
   * Force rasterisation even for classic charts. Default: `false`
   * (classic charts render as vector PDF content; ChartEx charts
   * also render as vector when their layout IDs are supported — see
   * `VECTOR_PDF_CHART_EX_LAYOUT_IDS` and the "ChartEx PDF" note in
   * `src/modules/excel/README.md`). When `true`, all chart types go
   * through the SVG → PNG → image-XObject raster pipeline.
   */
  forceRaster?: boolean;
  /** PNG raster scale multiplier when rasterising. Default: 2 (for crisp text). */
  rasterScale?: number;
  /** Document metadata forwarded to the resulting PDF. */
  title?: string;
  author?: string;
  /** Embedded typefaces used by selectable vector-chart text. */
  fonts?: PdfFontConfig;
  /**
   * Receive non-fatal font diagnostics raised while rendering.
   *
   * @see `PdfExportOptions.onWarning`
   */
  onWarning?: (message: string) => void;
  /**
   * ChartEx `regionMap` data. When supplied, the vector PDF path
   * uses the TopoJSON polygons (matched via `match` rules) instead
   * of the centroid preview. Ignored for non-regionMap layouts and
   * when the chart rasterises. Mirrors `renderChartExSvg`'s
   * `regionMap` option so a single caller-side object works for
   * both backends.
   */
  regionMap?: RegionMapDataOptions;
}

/**
 * Render a single {@link Chart} to a standalone one-page PDF.
 *
 * The output is a **zero-dependency deterministic preview**, not an
 * Excel-pixel-perfect rendering. Use this for server-side reports,
 * thumbnails, and CI artefacts where the goal is a recognisable chart
 * without a headless Office dependency. When pixel-identical output
 * matters (publication-grade reports, Excel/LibreOffice-compatible
 * formatting), round-trip the `.xlsx` through
 * `soffice --convert-to pdf` — the byte-preserving round-trip in this
 * library makes that a safe handoff. See `src/modules/excel/README.md`
 * → "Rendering scope" for the complete boundary list.
 *
 * Classic charts take the **vector** path: the chart is drawn directly
 * onto the page via `drawChartPdf`, so text stays selectable and shapes
 * remain resolution-independent. ChartEx charts whose layout IDs are in
 * `VECTOR_PDF_CHART_EX_LAYOUT_IDS` also take the vector path via
 * `drawChartExPdf`; unsupported layouts (if any) and charts where
 * `forceRaster: true` is set fall through to the SVG → PNG → image-XObject
 * raster pipeline.
 *
 * Lives in `excel-bridge.ts` because invoking the PDF builder from the
 * chart module would cross the Layer 4 → Layer 5 import boundary
 * documented in `AGENTS.md`. Consumers import it from
 * `documonster/pdf` alongside `excelToPdf`.
 */
export async function chartToPdf(
  chart: ChartHandle,
  options: ChartToPdfOptions = {}
): Promise<Uint8Array> {
  const width = options.width ?? 520;
  const height = options.height ?? 360;
  const margin = options.margin ?? 36;
  const pageWidth = options.pageWidth ?? Math.max(width + margin * 2, 400);
  const pageHeight = options.pageHeight ?? Math.max(height + margin * 2, 300);

  const doc = new PdfDocumentBuilder({ fonts: options.fonts });
  if (options.onWarning) {
    doc.onWarning(options.onWarning);
  }
  if (options.title || options.author) {
    doc.setMetadata({
      title: options.title,
      author: options.author
    });
  }
  const page = doc.addPage({ width: pageWidth, height: pageHeight });

  const isChartEx = chartChartExModel(chart) !== undefined;
  // ChartEx charts whose every series has a layoutId in
  // VECTOR_PDF_CHART_EX_LAYOUT_IDS take the vector route alongside
  // classic charts. As of the regionMap port this covers every ChartEx
  // layout the builder currently emits. Anything else — or any chart
  // the caller explicitly asks to rasterise via `forceRaster` — falls
  // through to the SVG → PNG → image-XObject pipeline.
  const chartExModel = chartChartExModel(chart);
  const chartExVectorable =
    isChartEx && chartExModel !== undefined && canRenderChartExAsVectorPdf(chartExModel);
  const useRaster = options.forceRaster === true || (isChartEx && !chartExVectorable);

  if (!useRaster) {
    if (isChartEx && chartExModel !== undefined) {
      drawChartExPdf(
        page,
        chartExModel,
        {
          x: margin,
          y: pageHeight - margin - height,
          width,
          height
        },
        { title: options.title, regionMap: options.regionMap }
      );
      return doc.build();
    }
    // Vector path for classic charts.
    const model = chartChartModel(chart);
    if (!model) {
      throw new Error(
        "chartToPdf: Chart has neither a classic model nor a ChartEx model to render"
      );
    }
    drawChartPdf(page, model, {
      x: margin,
      y: pageHeight - margin - height,
      width,
      height
    });
    return doc.build();
  }

  // Raster path: produce a PNG, then embed it on the page. Uses scale
  // 2× by default so the PDF viewer shows crisp text even when zoomed
  // into a 150 % magnification. Callers who need larger prints can
  // bump `rasterScale`; anything above 4 rapidly grows the PDF size.
  const scale = options.rasterScale ?? 2;
  const pngBytes = isChartEx
    ? await renderChartExPng(chartChartExModel(chart)!, {
        width,
        height,
        scale
      })
    : await renderChartPng(chartChartModel(chart)!, { width, height, scale });
  page.drawImage({
    data: pngBytes,
    format: "png",
    x: margin,
    y: pageHeight - margin - height,
    width,
    height
  });
  return doc.build();
}

/**
 * Convert an Excel Workbook to the internal PdfWorkbook data structure.
 *
 * Async because two conversion paths hand off work that may be off-thread:
 *  - Non-whitelisted ChartEx layouts are rasterised to PNG at collection
 *    time via `renderChartExPng` (so the exporter never blocks on chart
 *    rendering).
 *  - Chartsheets follow the same per-chart rasterisation rule.
 *
 * Worksheets and chartsheets are merged into a single `sheets` array in
 * tab order (`orderNo`), matching what Excel / LibreOffice would print.
 * Chartsheets without an orderNo fall to the end, mirroring how Excel
 * treats sheets with missing tab positions.
 */
async function excelWorkbookToPdf(
  workbook: Workbook,
  options?: PdfExportOptions
): Promise<PdfWorkbook> {
  const worksheetResults = await Promise.all(
    getWorksheets(workbook).map(ws => convertSheet(ws, workbook, options))
  );
  const chartsheetResults = await Promise.all(
    getChartsheets(workbook).map(cs => convertChartsheet(cs, workbook, options))
  );

  const combined: PdfWorkbookSheet[] = [...worksheetResults, ...chartsheetResults];
  combined.sort(
    (a, b) => (a.orderNo ?? Number.POSITIVE_INFINITY) - (b.orderNo ?? Number.POSITIVE_INFINITY)
  );

  return {
    title: workbook.title || undefined,
    creator: workbook.creator || undefined,
    subject: workbook.subject || undefined,
    sourceFilePath: workbook.sourceFilePath ? dirname(workbook.sourceFilePath) : undefined,
    sourceFileName: workbook.sourceFilePath ? basename(workbook.sourceFilePath) : undefined,
    locale: workbook.language,
    sheets: combined
  };
}

// =============================================================================
// Sheet Conversion
// =============================================================================

async function convertSheet(
  ws: Worksheet,
  workbook: Workbook,
  options?: PdfExportOptions
): Promise<PdfSheetData> {
  const dimensions = getSheetDimensions(ws);
  const hasData = dimensions && dimensions.top > 0 && dimensions.left > 0;

  const bounds = hasData
    ? {
        top: dimensions.top,
        left: dimensions.left,
        bottom: dimensions.bottom,
        right: dimensions.right
      }
    : { top: 0, left: 0, bottom: 0, right: 0 };

  // Expand bounds to include cells that only have styles (borders, fills, fonts)
  // but no values — these are not tracked by dimensions. This also establishes
  // bounds for a sheet whose only content is styled cells.
  let hasContent = hasData;
  // Scan every materialised slot, not just the rows inside the value
  // dimensions: a style-only cell can sit above, left of, or below them just
  // as easily as to the right.
  //
  // `rowEachCell({ includeEmpty: true })` used to create every hole up to
  // `row.cells.length`, and those virtual cells inherited row/column styles.
  // Resolve the same style without writing the virtual cell back to the row.
  // Only style matters here: `dimensions` already covers every non-Null cell
  // (see `rowDimensions`), so a cell carrying a value is always inside bounds.
  for (let r = 1; r <= ws._rows.length; r++) {
    const row = ws._rows[r - 1];
    if (!row) {
      continue;
    }
    for (let c = 1; c <= row.cells.length; c++) {
      const cell = row.cells[c - 1];
      const style = cell ? cell.style : inheritedCellStyle(ws, row, c);
      if (!hasRenderableCellStyle(style)) {
        continue;
      }
      if (!hasContent) {
        bounds.top = bounds.bottom = r;
        bounds.left = bounds.right = c;
        hasContent = true;
        continue;
      }
      if (r < bounds.top) {
        bounds.top = r;
      } else if (r > bounds.bottom) {
        bounds.bottom = r;
      }
      if (c < bounds.left) {
        bounds.left = c;
      } else if (c > bounds.right) {
        bounds.right = c;
      }
    }
  }

  // Convert columns
  const columns = new Map<number, PdfColumnData>();
  if (hasContent) {
    for (let c = bounds.left; c <= bounds.right; c++) {
      // `getColumn` extends `ws._columns`; export must not. An absent column has
      // no explicit width or hidden flag, which is what the renderer defaults to.
      const col = ws._columns[c - 1];
      columns.set(c, {
        hidden: col?.hidden || undefined,
        width: col?.width ?? undefined
      });
    }
  }

  // Convert rows
  const rows = new Map<number, PdfRowData>();
  if (hasContent) {
    for (let r = bounds.top; r <= bounds.bottom; r++) {
      const row = findRow(ws, r);
      if (!row) {
        continue;
      }

      const cells = new Map<number, PdfCellData>();
      for (let c = 1; c <= row.cells.length; c++) {
        const cell = row.cells[c - 1];
        if (cell) {
          const hasValue = cellType(cell) !== ValueType.Null && cellType(cell) !== ValueType.Merge;
          if (hasValue || hasRenderableCellStyle(cell.style)) {
            cells.set(c, convertCell(cell));
          }
        } else {
          const style = inheritedCellStyle(ws, row, c);
          if (hasRenderableCellStyle(style)) {
            cells.set(c, convertEmptyCell(c, style));
          }
        }
      }

      rows.set(r, {
        hidden: row.hidden || undefined,
        height: row.height ?? undefined,
        customHeight: row.customHeight || undefined,
        cells
      });
    }
  }

  // Convert merges
  const mergeCellsModel = getHasMerges(ws) ? getSheetModel(ws).mergeCells : undefined;
  const merges = mergeCellsModel ? [...mergeCellsModel] : undefined;

  // Convert pageSetup
  const ps = ws.pageSetup;
  const pageSetup: PdfPageSetupData | undefined = ps
    ? {
        orientation: ps.orientation,
        paperSize: ps.paperSize,
        margins: ps.margins
          ? {
              left: ps.margins.left,
              right: ps.margins.right,
              top: ps.margins.top,
              bottom: ps.margins.bottom,
              header: ps.margins.header,
              footer: ps.margins.footer
            }
          : undefined,
        scale: ps.scale,
        fitToPage: ps.fitToPage,
        fitToWidth: ps.fitToWidth,
        fitToHeight: ps.fitToHeight,
        printTitlesRow: ps.printTitlesRow,
        printTitlesColumn: ps.printTitlesColumn,
        showGridLines: ps.showGridLines,
        showRowColHeaders: ps.showRowColHeaders,
        printArea: ps.printArea,
        firstPageNumber: ps.useFirstPageNumber === false ? undefined : ps.firstPageNumber,
        pageOrder: ps.pageOrder,
        blackAndWhite: ps.blackAndWhite,
        draft: ps.draft,
        errors: ps.errors,
        cellComments: ps.cellComments,
        horizontalCentered: ps.horizontalCentered,
        verticalCentered: ps.verticalCentered
      }
    : undefined;

  // Convert row/col breaks
  const rowBreaks: number[] | undefined = ws.rowBreaks?.map((b: { id: number }) => b.id);
  const colBreaks: number[] | undefined = ws.colBreaks?.map((b: { id: number }) => b.id);

  // Convert images and charts. Both are floating objects anchored to
  // cells, and both need to participate in bounds expansion so the
  // layout engine allocates pages that cover their anchor rows/cols.
  //
  // Draft quality prints no graphics, so skip collection entirely rather than
  // gathering (and rasterizing ChartEx layouts) only to drop the result during
  // layout: draft exists to be cheap, and a rasterizer failure must not sink an
  // export that would not have shown the graphic anyway. The precedence here
  // mirrors `resolveOptions`; the layout engine still gates on the resolved
  // flag, so this stays a pure optimization.
  const comments = collectComments(ws);
  const draftQuality = options?.draft ?? ws.pageSetup?.draft ?? false;
  const images = draftQuality ? undefined : collectImages(ws, workbook);
  const charts = draftQuality ? undefined : await collectCharts(ws);
  const sparklineCharts = draftQuality ? undefined : collectSparklineCharts(ws);

  // Merge sparkline micro-charts with regular charts
  const allCharts = charts
    ? sparklineCharts
      ? [...charts, ...sparklineCharts]
      : charts
    : sparklineCharts || undefined;

  const anchoredRanges: PdfAnchorRange[] = [];
  if (images) {
    for (const img of images) {
      anchoredRanges.push(img.range);
    }
  }
  if (allCharts) {
    for (const ch of allCharts) {
      anchoredRanges.push(ch.range);
    }
  }

  if (anchoredRanges.length > 0) {
    for (const range of anchoredRanges) {
      const tl = range.tl;
      const tlCol = (tl.nativeCol ?? tl.col ?? 0) + 1; // 0-indexed → 1-indexed
      const tlRow = (tl.nativeRow ?? tl.row ?? 0) + 1;
      if (bounds.top === 0 && bounds.left === 0) {
        bounds.top = 1;
        bounds.left = 1;
      }
      if (tlCol > bounds.right) {
        bounds.right = tlCol;
      }
      if (tlRow > bounds.bottom) {
        bounds.bottom = tlRow;
      }

      // Also extend to bottom-right anchor if present
      if (range.br) {
        const br = range.br;
        const brCol = (br.nativeCol ?? br.col ?? 0) + 1;
        const brRow = (br.nativeRow ?? br.row ?? 0) + 1;
        if (brCol > bounds.right) {
          bounds.right = brCol;
        }
        if (brRow > bounds.bottom) {
          bounds.bottom = brRow;
        }
      }
    }

    // Ensure columns/rows exist for extended bounds
    for (let c = bounds.left; c <= bounds.right; c++) {
      if (!columns.has(c)) {
        const col = ws._columns[c - 1];
        columns.set(c, {
          hidden: col?.hidden || undefined,
          width: col?.width ?? undefined
        });
      }
    }
    for (let r = bounds.top; r <= bounds.bottom; r++) {
      if (!rows.has(r)) {
        rows.set(r, { cells: new Map() });
      }
    }
  }

  return {
    kind: "worksheet",
    name: getSheetName(ws),
    state: ws.state ?? "visible",
    orderNo: ws.orderNo,
    bounds,
    columns,
    rows,
    merges,
    pageSetup,
    headerFooter: convertHeaderFooter(ws, workbook, draftQuality),
    rowBreaks,
    colBreaks,
    images,
    charts: allCharts,
    comments
  };
}

/**
 * Collect every comment on a worksheet, in row-major order.
 *
 * Two sources are merged: classic notes stored on the cell (`_comment`, the
 * VML-backed kind) and Office 365 threaded comments held on the sheet. Only the
 * text and author are needed — the printed form is an end-of-sheet list, not a
 * positioned box — so the VML geometry is deliberately ignored.
 */
function collectComments(ws: Worksheet): PdfSheetComment[] | undefined {
  const collected: PdfSheetComment[] = [];

  for (const row of ws._rows ?? []) {
    if (!row) {
      continue;
    }
    for (const cell of row.cells ?? []) {
      if (!cell) {
        continue;
      }
      const note = cellComment(cell);
      const text = noteText(note?.note);
      if (text) {
        collected.push({
          ref: cell.address,
          text,
          author: note?.author,
          anchor: parseVmlAnchor(note?.note)
        });
      }
    }
  }

  for (const entry of ws.threadedComments ?? []) {
    const text = entry.comment.text?.trim();
    if (text) {
      collected.push({ ref: entry.ref, text, author: entry.comment.personId });
    }
  }

  return collected.length > 0 ? collected : undefined;
}

/**
 * Decode a VML comment anchor into fractional sheet coordinates.
 *
 * `<x:Anchor>` holds eight integers: for each edge a column/row index followed
 * by an offset into it, measured in 1/68 of a column and 1/18 of a row (the
 * reciprocals Excel uses when it writes the value). Returns `undefined` when the
 * note has no anchor, so callers fall back to Excel's default placement.
 */
function parseVmlAnchor(note: NoteData["note"]): PdfCommentAnchor | undefined {
  if (!note || typeof note === "string" || typeof note.anchor !== "string") {
    return undefined;
  }
  const parts = note.anchor.split(",").map(p => Number(p.trim()));
  if (parts.length !== 8 || parts.some(n => !Number.isFinite(n))) {
    return undefined;
  }
  const [l, lf, t, tf, r, rf, b, bf] = parts;
  return {
    left: l + lf / 68,
    top: t + tf / 18,
    right: r + rf / 68,
    bottom: b + bf / 18
  };
}

/** Flatten a note body, which may be plain text or a rich `NoteConfig`. */
function noteText(note: NoteData["note"]): string | undefined {
  if (typeof note === "string") {
    return note.trim() || undefined;
  }
  if (note && typeof note === "object" && Array.isArray(note.texts)) {
    const joined = note.texts
      .map(t => (typeof t === "string" ? t : (t.text ?? "")))
      .join("")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

// =============================================================================
// Header / Footer Conversion
// =============================================================================

interface HeaderFooterStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  doubleUnderline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
  outline: boolean;
  shadow: boolean;
  color?: { r: number; g: number; b: number };
}

function convertHeaderFooter(
  ws: Worksheet,
  workbook: Workbook,
  draftQuality = false
): PdfHeaderFooterData | undefined {
  const source = ws.headerFooter;
  const fields = [
    source.oddHeader,
    source.oddFooter,
    source.evenHeader,
    source.evenFooter,
    source.firstHeader,
    source.firstFooter
  ];
  // Draft quality prints no graphics, header pictures included, so skip
  // collecting them rather than embedding XObjects nothing will draw.
  const images = draftQuality ? [] : convertHeaderFooterImages(ws, workbook);
  if (!fields.some(Boolean) && images.length === 0) {
    return undefined;
  }

  return {
    differentFirst: source.differentFirst,
    differentOddEven: source.differentOddEven,
    scaleWithDoc: source.scaleWithDoc ?? true,
    alignWithMargins: source.alignWithMargins ?? true,
    oddHeader: parseHeaderFooter(source.oddHeader),
    oddFooter: parseHeaderFooter(source.oddFooter),
    evenHeader: parseHeaderFooter(source.evenHeader),
    evenFooter: parseHeaderFooter(source.evenFooter),
    firstHeader: parseHeaderFooter(source.firstHeader),
    firstFooter: parseHeaderFooter(source.firstFooter),
    images
  };
}

function convertHeaderFooterModel(
  source: Partial<HeaderFooter> | undefined,
  images: PdfHeaderFooterData["images"] = []
): PdfHeaderFooterData | undefined {
  if (!source && images.length === 0) {
    return undefined;
  }
  source ??= {};
  const values = [
    source.oddHeader,
    source.oddFooter,
    source.evenHeader,
    source.evenFooter,
    source.firstHeader,
    source.firstFooter
  ];
  if (!values.some(Boolean) && images.length === 0) {
    return undefined;
  }
  return {
    differentFirst: source.differentFirst ?? false,
    differentOddEven: source.differentOddEven ?? false,
    scaleWithDoc: source.scaleWithDoc ?? true,
    alignWithMargins: source.alignWithMargins ?? true,
    oddHeader: parseHeaderFooter(source.oddHeader ?? null),
    oddFooter: parseHeaderFooter(source.oddFooter ?? null),
    evenHeader: parseHeaderFooter(source.evenHeader ?? null),
    evenFooter: parseHeaderFooter(source.evenFooter ?? null),
    firstHeader: parseHeaderFooter(source.firstHeader ?? null),
    firstFooter: parseHeaderFooter(source.firstFooter ?? null),
    images
  };
}

function convertHeaderFooterImages(
  ws: Worksheet,
  workbook: Workbook
): PdfHeaderFooterData["images"] {
  const headerImages = getSheetModel(ws).media.filter(image => image.type === "headerImage");
  const watermark = getWatermark(ws);
  if (headerImages.length === 0 && watermark?.mode === "header") {
    headerImages.push({
      type: "headerImage",
      imageId: String(watermark.imageId),
      headerWidth: watermark.headerWidth,
      headerHeight: watermark.headerHeight,
      position: "CH"
    });
  }
  return headerImages.flatMap(image => {
    const media = getImage(workbook, image.imageId);
    const format = media?.extension === "jpg" ? "jpeg" : media?.extension;
    const data =
      media?.buffer instanceof Uint8Array
        ? media.buffer
        : media?.base64
          ? base64ToUint8Array(media.base64)
          : undefined;
    if (!data?.length || (format !== "png" && format !== "jpeg")) {
      return [];
    }
    return [
      {
        data,
        format,
        width: image.headerWidth ?? 467.25,
        height: image.headerHeight ?? 311.25,
        position: image.position ?? "CH"
      }
    ];
  });
}

function parseHeaderFooter(value: string | null): PdfHeaderFooterContent | undefined {
  if (!value) {
    return undefined;
  }
  const content: PdfHeaderFooterContent = { left: [], center: [], right: [] };
  let section: keyof PdfHeaderFooterContent = "center";
  let style: HeaderFooterStyle = {
    fontFamily: "",
    fontSize: 11,
    bold: false,
    italic: false,
    underline: false,
    doubleUnderline: false,
    strike: false,
    superscript: false,
    subscript: false,
    outline: false,
    shadow: false
  };
  let text = "";

  const flush = (): void => {
    if (!text) {
      return;
    }
    content[section].push({ text, ...style });
    text = "";
  };
  const pushField = (field: PdfHeaderFooterRun["field"], offset?: number): void => {
    flush();
    content[section].push({ field, offset, ...style });
  };

  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "&") {
      text += value[i];
      continue;
    }
    const code = value[++i];
    if (code === undefined) {
      text += "&";
      break;
    }
    if (code === "&") {
      text += "&";
      continue;
    }
    if (code === "[") {
      const end = value.indexOf("]", i + 1);
      if (end !== -1) {
        const namedField = value.slice(i + 1, end).toLowerCase();
        const namedFieldMap: Record<string, NonNullable<PdfHeaderFooterRun["field"]>> = {
          page: "pageNumber",
          pages: "pageCount",
          tab: "sheetName",
          file: "fileName",
          path: "filePath",
          date: "date",
          time: "time",
          picture: "image"
        };
        if (namedFieldMap[namedField]) {
          pushField(namedFieldMap[namedField]);
          i = end;
          continue;
        }
      }
    }
    if (code === "L" || code === "C" || code === "R") {
      flush();
      section = code === "L" ? "left" : code === "R" ? "right" : "center";
      continue;
    }
    if (code === '"') {
      const end = value.indexOf('"', i + 1);
      if (end === -1) {
        text += '&"';
        continue;
      }
      flush();
      const fontSpec = value.slice(i + 1, end);
      const comma = fontSpec.lastIndexOf(",");
      const family = comma >= 0 ? fontSpec.slice(0, comma) : fontSpec;
      const styleName = comma >= 0 ? fontSpec.slice(comma + 1) : "";
      style = {
        ...style,
        fontFamily: family === "-" ? "" : family || style.fontFamily,
        bold: /bold/i.test(styleName),
        italic: /italic/i.test(styleName)
      };
      i = end;
      continue;
    }
    if (/\d/.test(code)) {
      let end = i + 1;
      while (end < value.length && /\d/.test(value[end])) {
        end++;
      }
      flush();
      style = { ...style, fontSize: Number(value.slice(i, end)) };
      i = end - 1;
      continue;
    }
    if (code === "K") {
      const colorText = value.slice(i + 1, i + 7);
      if (/^[0-9A-Fa-f]{6}$/.test(colorText)) {
        flush();
        style = { ...style, color: hexToRgb01(colorText) ?? undefined };
        i += 6;
      }
      continue;
    }
    if (code === "P") {
      const offsetMatch = /^[+-]\d+/.exec(value.slice(i + 1));
      pushField("pageNumber", offsetMatch ? Number(offsetMatch[0]) : undefined);
      if (offsetMatch) {
        i += offsetMatch[0].length;
      }
      continue;
    }
    const fieldMap: Partial<Record<string, NonNullable<PdfHeaderFooterRun["field"]>>> = {
      N: "pageCount",
      A: "sheetName",
      F: "fileName",
      Z: "filePath",
      D: "date",
      T: "time",
      G: "image"
    };
    if (fieldMap[code]) {
      pushField(fieldMap[code]);
      continue;
    }
    const toggle = (key: keyof HeaderFooterStyle): void => {
      flush();
      style = { ...style, [key]: !style[key] };
    };
    if (code === "B") {
      toggle("bold");
    } else if (code === "I") {
      toggle("italic");
    } else if (code === "U") {
      toggle("underline");
    } else if (code === "E") {
      toggle("doubleUnderline");
    } else if (code === "S") {
      toggle("strike");
    } else if (code === "X") {
      toggle("superscript");
    } else if (code === "Y") {
      toggle("subscript");
    } else if (code === "O") {
      toggle("outline");
    } else if (code === "H") {
      toggle("shadow");
    } else {
      text += `&${code}`;
    }
  }
  flush();
  return content.left.length || content.center.length || content.right.length ? content : undefined;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSeparator >= 0 ? path.slice(0, lastSeparator + 1) : "";
}

// =============================================================================
// Cell Conversion
// =============================================================================

function convertCell(cell: CellData): PdfCellData {
  const type = mapValueType(cellType(cell));
  const text = getCellDisplayText(cell);
  const style = convertCellStyle(cell.style);

  return {
    type,
    value: convertCellValue(cell),
    text,
    style,
    hyperlink: cellHyperlink(cell) || undefined,
    result: cellResult(cell) ?? undefined,
    col: cellCol(cell)
  };
}

/** Resolve the style a cell would inherit if it were materialised. */
function inheritedCellStyle(ws: Worksheet, row: RowData, col: number): Partial<Style> {
  return mergeCellStyle(row.style, ws._columns[col - 1]?.style ?? {}, {});
}

/** The renderer only includes style-only cells for visible formatting. */
function hasRenderableCellStyle(style: Partial<Style>): boolean {
  return Boolean(
    (style.border &&
      (style.border.top || style.border.right || style.border.bottom || style.border.left)) ||
    style.fill ||
    style.font
  );
}

/** PDF counterpart of an unmaterialised, styled Excel cell. */
function convertEmptyCell(col: number, style: Partial<Style>): PdfCellData {
  return {
    type: PdfCellType.Empty,
    value: null,
    text: "",
    style: convertCellStyle(style),
    col
  };
}

function mapValueType(vt: number): PdfCellTypeValue {
  switch (vt) {
    case ValueType.Null:
      return PdfCellType.Empty;
    case ValueType.Merge:
      return PdfCellType.Merge;
    case ValueType.Number:
      return PdfCellType.Number;
    case ValueType.String:
    case ValueType.SharedString:
      return PdfCellType.String;
    case ValueType.Date:
      return PdfCellType.Date;
    case ValueType.Hyperlink:
      return PdfCellType.Hyperlink;
    case ValueType.Formula:
      return PdfCellType.Formula;
    case ValueType.RichText:
      return PdfCellType.RichText;
    case ValueType.Boolean:
      return PdfCellType.Boolean;
    case ValueType.Error:
      return PdfCellType.Error;
    default:
      return PdfCellType.String;
  }
}

/**
 * Get display text for a cell, applying numFmt formatting.
 */
function getCellDisplayText(cell: CellData): string {
  if (!cell) {
    return "";
  }

  switch (cellType(cell)) {
    case ValueType.Null:
    case ValueType.Merge:
      return "";
    case ValueType.RichText:
    case ValueType.Hyperlink:
      return cellText(cell) ?? "";
    case ValueType.Error: {
      const errValue = cellGetValue(cell) as { error?: string } | undefined;
      return errValue?.error ?? cellText(cell) ?? "";
    }
    case ValueType.Formula: {
      const result = cellResult(cell);
      if (result !== undefined && result !== null) {
        if (typeof result === "object" && "error" in result) {
          return result.error;
        }
        return formatCellValueSafe(result, cell.style?.numFmt);
      }
      return cellText(cell) ?? "";
    }
    default: {
      const value = cellGetValue(cell);
      if (value === null || value === undefined) {
        return "";
      }
      return formatCellValueSafe(value, cell.style?.numFmt);
    }
  }
}

function formatCellValueSafe(
  value: unknown,
  numFmt: string | { formatCode: string } | undefined
): string {
  const fmt = typeof numFmt === "string" ? numFmt : numFmt?.formatCode;
  if (fmt && (typeof value === "number" || value instanceof Date || typeof value === "boolean")) {
    try {
      return formatCellValue(value, fmt);
    } catch {
      // Fall through to default
    }
  }
  if (value instanceof Date) {
    return value.toLocaleDateString();
  }
  return String(value);
}

function convertCellValue(cell: CellData): unknown {
  if (cellType(cell) === ValueType.RichText) {
    // Preserve richText structure for the PDF engine
    const rtValue = cellGetValue(cell) as CellRichTextValue | undefined;
    if (rtValue?.richText) {
      return {
        richText: rtValue.richText.map(run => ({
          text: run.text,
          font: run.font ? convertFontStyle(run.font) : undefined
        }))
      };
    }
  }
  return cellGetValue(cell);
}

// =============================================================================
// Style Conversion
// =============================================================================

function convertCellStyle(style: Partial<Style>): Partial<PdfCellStyle> | undefined {
  if (!style) {
    return undefined;
  }

  return {
    font: style.font ? convertFontStyle(style.font) : undefined,
    numFmt: style.numFmt,
    fill: style.fill ? convertFill(style.fill) : undefined,
    border: style.border ? convertBorders(style.border) : undefined,
    alignment: style.alignment ? convertAlignment(style.alignment) : undefined
  };
}

function convertFontStyle(font: Partial<Font>): Partial<PdfFontStyle> {
  return {
    name: font.name,
    size: font.size,
    bold: font.bold,
    italic: font.italic,
    strike: font.strike,
    underline: font.underline,
    color: font.color ? convertColor(font.color) : undefined
  };
}

function convertColor(color: Partial<Color>): PdfColorData {
  return {
    argb: color.argb,
    theme: color.theme,
    tint: color.tint,
    indexed: color.indexed
  };
}

function convertFill(fill: Fill): PdfFillData {
  if (fill.type === "gradient") {
    return {
      type: "gradient",
      stops: fill.stops.map(s => ({
        position: s.position,
        color: convertColor(s.color)
      }))
    };
  }
  return {
    type: "pattern",
    pattern: fill.pattern,
    fgColor: fill.fgColor ? convertColor(fill.fgColor) : undefined
  };
}

function convertBorderSide(border: Partial<Border>): Partial<PdfBorderSideData> {
  return {
    style: border.style,
    color: border.color ? convertColor(border.color) : undefined
  };
}

function convertBorders(borders: Partial<Borders>): Partial<PdfBordersData> {
  return {
    top: borders.top ? convertBorderSide(borders.top) : undefined,
    right: borders.right ? convertBorderSide(borders.right) : undefined,
    bottom: borders.bottom ? convertBorderSide(borders.bottom) : undefined,
    left: borders.left ? convertBorderSide(borders.left) : undefined
  };
}

function convertAlignment(alignment: Partial<Alignment>): Partial<PdfAlignmentData> {
  return {
    horizontal: alignment.horizontal,
    vertical: alignment.vertical,
    wrapText: alignment.wrapText,
    indent: alignment.indent,
    // Excel encodes stacked text as the literal "vertical"; the PDF layout
    // engine represents it as the sentinel rotation 255 (see layout-engine).
    // Passing the string straight through (as the old `any` did) silently
    // dropped vertical rotation because the engine only matches `=== 255`.
    textRotation: alignment.textRotation === "vertical" ? 255 : alignment.textRotation
  };
}

// =============================================================================
// Image Collection
// =============================================================================

function collectImages(ws: Worksheet, workbook: Workbook): PdfSheetImage[] | undefined {
  const wsImages = getImages(ws);
  if (!wsImages || !Array.isArray(wsImages) || wsImages.length === 0) {
    return undefined;
  }

  const images: PdfSheetImage[] = [];

  for (const wsImage of wsImages) {
    if (!wsImage.range?.tl) {
      continue;
    }

    const imageId = wsImage.imageId;
    const mediaItem = getImage(workbook, Number(imageId));
    if (!mediaItem) {
      continue;
    }

    // Get image data
    let data: Uint8Array | undefined;
    if (mediaItem.buffer instanceof Uint8Array) {
      data = mediaItem.buffer;
    } else if (mediaItem.base64) {
      data = base64ToUint8Array(mediaItem.base64);
    }
    if (!data || data.length === 0) {
      continue;
    }

    const format = mediaItem.extension as string;
    if (format !== "jpeg" && format !== "png") {
      continue;
    }

    images.push({
      data,
      format: format as "jpeg" | "png",
      range: {
        tl: {
          col: anchorCol(wsImage.range.tl),
          row: anchorRow(wsImage.range.tl),
          nativeCol: wsImage.range.tl.nativeCol,
          nativeRow: wsImage.range.tl.nativeRow,
          nativeColOff: wsImage.range.tl.nativeColOff,
          nativeRowOff: wsImage.range.tl.nativeRowOff
        },
        br: wsImage.range.br
          ? {
              col: anchorCol(wsImage.range.br),
              row: anchorRow(wsImage.range.br),
              nativeCol: wsImage.range.br.nativeCol,
              nativeRow: wsImage.range.br.nativeRow,
              nativeColOff: wsImage.range.br.nativeColOff,
              nativeRowOff: wsImage.range.br.nativeRowOff
            }
          : undefined,
        ext: wsImage.range.ext
          ? {
              width: wsImage.range.ext.width ?? 0,
              height: wsImage.range.ext.height ?? 0
            }
          : undefined,
        // Images historically store ext as pixels — the layout engine
        // converts px→pt at assignment time (px × 0.75 = pt).
        extUnit: wsImage.range.ext ? ("px" as const) : undefined
      }
    });
  }

  return images.length > 0 ? images : undefined;
}

// =============================================================================
// Chart Collection
// =============================================================================

/**
 * Gather every embedded chart on a worksheet and wrap it in a
 * {@link PdfSheetChart} the layout engine can place.
 *
 * - **Classic charts** and **whitelisted ChartEx layouts** get a
 *   `drawVector` closure pinned over the chart model. The closure is
 *   invoked later by the PDF exporter against a drawing surface adapted
 *   over the page's content stream (see `render/chart-surface.ts`), so
 *   the chart ends up as real PDF geometry — selectable text, crisp
 *   shapes at any zoom.
 * - **ChartEx layouts outside the whitelist** are rasterised up-front
 *   via `renderChartExPng` and attached as a raster payload. The
 *   exporter then treats the PNG as an image XObject. The raster size
 *   is derived from the anchor extent (with a sensible fallback), and
 *   the PDF viewer stretches the bitmap to the final rect.
 *
 * Pivot charts inherit the classic path — they are regular `Chart`
 * objects with a `pivotSource` tag, and their model renders like any
 * other classic chart.
 */
async function collectCharts(ws: Worksheet): Promise<PdfSheetChart[] | undefined> {
  const wsCharts = getCharts(ws);
  if (wsCharts.length === 0) {
    return undefined;
  }

  const charts: PdfSheetChart[] = [];
  for (const chart of wsCharts) {
    const range = chartAnchorRange(chart);
    if (!range) {
      continue;
    }

    const classicModel = chartChartModel(chart);
    const chartExModel = chartChartExModel(chart);

    if (classicModel) {
      // Classic chart → vector path.
      const drawVector: PdfSheetChart["drawVector"] = (surface, rect) => {
        drawChartPdf(surface as unknown as ChartPdfDrawingSurface, classicModel as ChartModel, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        });
      };
      charts.push({ range, drawVector });
      continue;
    }

    if (chartExModel) {
      // Hierarchical ChartEx (treemap/sunburst) marks its dims with
      // `_skipCache` to prevent the XLSX writer from emitting flat
      // cache levels (which confuses Excel). For PDF rendering we need
      // the data in-memory, so temporarily lift the flag, fill caches
      // from the worksheet, then restore it.
      ensureChartExCachesFilled(chartExModel, ws);

      if (canRenderChartExAsVectorPdf(chartExModel)) {
        // Whitelisted ChartEx layout → vector path.
        const drawVector: PdfSheetChart["drawVector"] = (surface, rect) => {
          drawChartExPdf(
            surface as unknown as ChartPdfDrawingSurface,
            chartExModel as ChartExModel,
            { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          );
        };
        charts.push({ range, drawVector });
      } else {
        // Non-whitelisted ChartEx layout → raster path.
        const { widthPx, heightPx } = estimateChartPixelSize(range);
        const png = await renderChartExPng(chartExModel, {
          width: widthPx,
          height: heightPx,
          scale: 2
        });
        charts.push({
          range,
          raster: { data: png, format: "png" }
        });
      }
      continue;
    }

    // Chart has neither model — likely a placeholder or unparsed
    // `rawXml` shape. Rasterise nothing, skip silently; the cells
    // underneath remain visible.
  }

  return charts.length > 0 ? charts : undefined;
}

/**
 * Convert worksheet sparkline groups into micro-chart entries that flow
 * through the same chart rendering pipeline. Each sparkline becomes a
 * `PdfSheetChart` anchored to its `cellRef` cell (one cell wide, one
 * row tall) with a `drawVector` callback that paints the sparkline's
 * geometry (line polyline or column bars) directly into the PDF page.
 */
function collectSparklineCharts(ws: Worksheet): PdfSheetChart[] | undefined {
  const groups = getSparklineGroups(ws);
  if (!groups || groups.length === 0) {
    return undefined;
  }

  const charts: PdfSheetChart[] = [];
  for (const group of groups) {
    for (const sparkline of group.sparklines) {
      const { dataRef, cellRef } = sparkline;
      if (!cellRef) {
        continue;
      }
      // Parse cellRef (e.g. "N3") to get row/col
      const cellMatch = cellRef.match(/^([A-Z]+)(\d+)$/i);
      if (!cellMatch) {
        continue;
      }
      const col = colLetterToNumber(cellMatch[1]);
      const row = parseInt(cellMatch[2], 10);

      // Resolve data values from the worksheet
      const values = resolveSparklineData(ws, dataRef);
      if (values.length === 0) {
        continue;
      }

      // Build anchor: the sparkline occupies exactly one cell
      const range: PdfAnchorRange = {
        tl: { col: col - 1, row: row - 1, nativeCol: col - 1, nativeRow: row - 1 },
        br: { col, row, nativeCol: col, nativeRow: row }
      };

      const drawVector: PdfSheetChart["drawVector"] = (surface, rect) => {
        drawSparklinePdf(surface, group, values, rect);
      };
      charts.push({ range, drawVector });
    }
  }
  return charts.length > 0 ? charts : undefined;
}

/** Convert column letter(s) to 1-based number. */
function colLetterToNumber(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) & 0x1f);
  }
  return n;
}

/** Resolve sparkline data reference to numeric values. */
function resolveSparklineData(ws: Worksheet, dataRef: string): number[] {
  if (!dataRef) {
    return [];
  }
  // dataRef is like "Sheet1!B3:M3" or "'Regional KPIs'!B3:M3"
  // Strip sheet prefix — sparklines always reference the same workbook
  const bangIdx = dataRef.lastIndexOf("!");
  const rangeStr = bangIdx >= 0 ? dataRef.slice(bangIdx + 1) : dataRef;
  // Determine the source worksheet
  let sourceWs: Worksheet = ws;
  if (bangIdx >= 0) {
    let sheetName = dataRef.slice(0, bangIdx);
    // Remove surrounding quotes
    if (sheetName.startsWith("'") && sheetName.endsWith("'")) {
      sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
    }
    const found = getWorksheet(getSheetWorkbook(ws), sheetName);
    if (found) {
      sourceWs = found;
    }
  }
  // Parse range (e.g. "$B$3:$M$3" or "A1:K1")
  const clean = rangeStr.replace(/\$/g, "");
  const parts = clean.split(":");
  if (parts.length !== 2) {
    return [];
  }
  const startMatch = parts[0].match(/^([A-Z]+)(\d+)$/i);
  const endMatch = parts[1].match(/^([A-Z]+)(\d+)$/i);
  if (!startMatch || !endMatch) {
    return [];
  }
  const startCol = colLetterToNumber(startMatch[1]);
  const startRow = parseInt(startMatch[2], 10);
  const endCol = colLetterToNumber(endMatch[1]);
  const endRow = parseInt(endMatch[2], 10);

  // `findCell`, not `getCell`: `sourceWs` is frequently a *different* worksheet
  // from the one being rendered, so materialising here would have let a PDF
  // export mutate an unrelated sheet. A missing cell plots as NaN, exactly as an
  // existing non-numeric one does.
  const readNumber = (row: number, col: number): number => {
    const cell = findCell(sourceWs, row, col);
    if (!cell) {
      return NaN;
    }
    const value = cellGetValue(cell);
    const v = typeof value === "number" ? value : (cellResult(cell) ?? NaN);
    return typeof v === "number" ? v : NaN;
  };

  const values: number[] = [];
  if (startRow === endRow) {
    // Horizontal range
    for (let c = startCol; c <= endCol; c++) {
      values.push(readNumber(startRow, c));
    }
  } else {
    // Vertical range
    for (let r = startRow; r <= endRow; r++) {
      values.push(readNumber(r, startCol));
    }
  }
  return values;
}

/**
 * Draw a single sparkline into a PDF rect. Delegates all geometry (axis
 * ranging, marker placement, bar/line layout) to the shared
 * `computeSparklineGeometry` so the PDF output matches the SVG preview
 * exactly — the y-down geometry coordinates are flipped into the PDF page's
 * y-up space here.
 */
function drawSparklinePdf(
  surface: {
    drawRect(o: {
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: { r: number; g: number; b: number };
    }): unknown;
    drawLine(o: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color?: { r: number; g: number; b: number };
      lineWidth?: number;
    }): unknown;
    drawCircle?(o: {
      cx: number;
      cy: number;
      r: number;
      fill?: { r: number; g: number; b: number };
    }): unknown;
  },
  group: SparklineGroup,
  values: number[],
  rect: { x: number; y: number; width: number; height: number }
): void {
  const { x, y, width, height } = rect;
  if (width <= 0 || height <= 0 || values.length === 0) {
    return;
  }

  const primitives = computeSparklineGeometry(group, values, {
    width,
    height,
    padding: 2
  });

  // Geometry is box-local and y-down; the PDF page is y-up with `rect.y` at
  // the bottom edge, so flip vertically and translate into page space.
  const px = (gx: number): number => x + gx;
  const py = (gy: number): number => y + (height - gy);
  const rgb = (hex: string): { r: number; g: number; b: number } | undefined => {
    const c = hexToRgb01(hex);
    return c ? { r: c.r, g: c.g, b: c.b } : undefined;
  };

  for (const p of primitives) {
    switch (p.kind) {
      case "rect": {
        // drawRect's y is the bottom of the rect in y-up space; the
        // geometry rect's (gx, gy) is its top-left in y-down space.
        surface.drawRect({
          x: px(p.x),
          y: py(p.y + p.height),
          width: p.width,
          height: p.height,
          fill: rgb(p.color)
        });
        break;
      }
      case "polyline": {
        for (let i = 1; i < p.points.length; i++) {
          surface.drawLine({
            x1: px(p.points[i - 1].x),
            y1: py(p.points[i - 1].y),
            x2: px(p.points[i].x),
            y2: py(p.points[i].y),
            color: rgb(p.color),
            lineWidth: p.width
          });
        }
        break;
      }
      case "circle":
        surface.drawCircle?.({ cx: px(p.cx), cy: py(p.cy), r: p.r, fill: rgb(p.color) });
        break;
      case "axis":
        surface.drawLine({
          x1: px(p.x1),
          y1: py(p.y1),
          x2: px(p.x2),
          y2: py(p.y2),
          color: rgb(p.color),
          lineWidth: 0.5
        });
        break;
    }
  }
}

/**
 * Translate a `Chart.range` into the PDF layer's anchor shape. Returns
 * `undefined` for charts that Documonster could not anchor to any cell
 * (extremely rare — usually indicates a corrupt drawing relationship).
 */
function chartAnchorRange(chart: ChartHandle): PdfAnchorRange | undefined {
  const r = chart.range;
  if (!r?.tl) {
    return undefined;
  }

  const tl = r.tl;
  const br = r.br;

  return {
    tl: {
      col: anchorCol(tl),
      row: anchorRow(tl),
      nativeCol: tl.nativeCol,
      nativeRow: tl.nativeRow,
      nativeColOff: tl.nativeColOff,
      nativeRowOff: tl.nativeRowOff
    },
    br: br
      ? {
          col: anchorCol(br),
          row: anchorRow(br),
          nativeCol: br.nativeCol,
          nativeRow: br.nativeRow,
          nativeColOff: br.nativeColOff,
          nativeRowOff: br.nativeRowOff
        }
      : undefined,
    // Chart anchors store ext as EMU (`cx`, `cy`). Pass the values
    // through unchanged; the layout engine converts EMU→pt for charts
    // (÷12700) and px→pt for images (×0.75) based on `extUnit`.
    ext: r.ext ? { width: r.ext.cx, height: r.ext.cy } : undefined,
    extUnit: r.ext ? "emu" : undefined
  };
}

/**
 * Ensure a ChartEx model's data caches are populated for rendering.
 *
 * Hierarchical charts (treemap/sunburst) set `_skipCache` on their
 * string/numeric dimensions so the XLSX writer doesn't emit flat cache
 * levels (Excel rejects them). For PDF/image rendering the data must be
 * in-memory. This helper temporarily lifts the flag, calls
 * `fillChartExCaches`, then restores it so subsequent XLSX writes are
 * unaffected.
 */
function ensureChartExCachesFilled(model: ChartExModel, ws: Worksheet): void {
  const data = model.chartSpace?.chartData?.data;
  if (!data) {
    return;
  }
  // Check if any dimension is missing cache data
  const needsFill = data.some(entry => {
    const strNeedsData = entry.strDim && (!entry.strDim.levels || entry.strDim.levels.length === 0);
    const numNeedsData = entry.numDim && (!entry.numDim.levels || entry.numDim.levels.length === 0);
    return strNeedsData || numNeedsData;
  });
  if (!needsFill) {
    return;
  }
  try {
    fillChartExCachesForRendering(model, getSheetWorkbook(ws), ws);
  } catch {
    // Best-effort — rendering will proceed with whatever data is available.
  }
}

/**
 * Pick a PNG rasterisation size for a non-vectorable ChartEx layout.
 *
 * Strategy: use the anchor extent (EMU → pt → px at 96 dpi) when
 * available; otherwise fall back to a reasonable default that survives
 * half-page stretching without obvious artefacts. The exporter's
 * `rasterScale` is applied separately in `collectCharts`.
 */
function estimateChartPixelSize(range: PdfAnchorRange): {
  widthPx: number;
  heightPx: number;
} {
  if (range.ext && range.extUnit === "emu") {
    const widthPx = emuToPx(range.ext.width);
    const heightPx = emuToPx(range.ext.height);
    // 1 px at 96 dpi → 1/72-inch points, then back to px at 96 dpi (96/72).
    return {
      widthPx: Math.max(120, Math.round(widthPx * (96 / 72))),
      heightPx: Math.max(80, Math.round(heightPx * (96 / 72)))
    };
  }
  return { widthPx: 640, heightPx: 420 };
}

// =============================================================================
// Chartsheet Conversion
// =============================================================================

/**
 * Pixel dimensions used when rasterising a non-whitelisted ChartEx on a
 * chartsheet. Derived from Excel's own chartsheet canvas defaults
 * (A4 landscape minus default margins — see `CHARTSHEET_EMU_CX / CY`
 * in `xlsx.browser.ts`). 2× is applied by `renderChartExPng` via the
 * `scale` option so the PNG looks crisp at 150% zoom.
 */
const CHARTSHEET_RASTER_PX = { width: 1280, height: 720 } as const;

/**
 * Convert a {@link Chartsheet} into a {@link PdfChartsheetData}.
 *
 * A chartsheet is a "single chart fills the whole page" sheet type. Unlike
 * a cell-grid worksheet there is no row/column layout to reason about —
 * the chart just takes whatever content area the page margins leave.
 *
 * - **Classic chart** → vector `drawChartPdf` path (selectable text,
 *   crisp at any zoom).
 * - **ChartEx whitelisted layout** → vector `drawChartExPdf` path.
 * - **ChartEx outside the whitelist** → rasterised to PNG up-front via
 *   `renderChartExPng`; the PDF viewer stretches the bitmap to the final
 *   page rect.
 * - **No chart attached** → the chartsheet still produces a blank page
 *   (matches what Excel prints for a chartsheet whose chart was deleted
 *   but the sheet kept).
 */
async function convertChartsheet(
  cs: ChartsheetData,
  workbook: Workbook,
  options?: PdfExportOptions
): Promise<PdfChartsheetData> {
  const classicModel = chartsheetChartModel(cs);
  const chartExModel = chartsheetChartExModel(cs);

  // Resolve draft before touching the chart: a ChartEx outside the vector
  // whitelist would otherwise be rasterised at cost — and could fail — for a
  // page that prints no graphics at all. Precedence mirrors `resolveOptions`.
  const draftQuality = options?.draft ?? chartsheetPageSetup(cs)?.draft ?? false;

  // Draft quality prints no graphics, so the chart is simply never built.
  let chart: PdfChartsheetData["chart"] = {};

  if (!draftQuality && classicModel) {
    const model = classicModel;
    chart = {
      drawVector: (surface, rect) => {
        drawChartPdf(surface as unknown as ChartPdfDrawingSurface, model as ChartModel, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        });
      }
    };
  } else if (!draftQuality && chartExModel) {
    if (canRenderChartExAsVectorPdf(chartExModel)) {
      const model = chartExModel;
      chart = {
        drawVector: (surface, rect) => {
          drawChartExPdf(surface as unknown as ChartPdfDrawingSurface, model as ChartExModel, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          });
        }
      };
    } else {
      const png = await renderChartExPng(chartExModel, {
        width: CHARTSHEET_RASTER_PX.width,
        height: CHARTSHEET_RASTER_PX.height,
        scale: 2
      });
      chart = { raster: { data: png, format: "png" } };
    }
  }

  // Chartsheet orientation: explicit pageSetup wins. Excel's chartsheet
  // convention is landscape when unset (the CHARTSHEET_EMU_CX/CY pair in
  // xlsx.browser.ts is wider than tall), so we inherit that default.
  const explicitOrientation = chartsheetPageSetup(cs)?.orientation;
  const orientation: PdfChartsheetData["orientation"] =
    explicitOrientation === "portrait" || explicitOrientation === "landscape"
      ? explicitOrientation
      : "landscape";

  // Capture the native pageSetup for callers / exporter heuristics.
  // Chartsheet's `CT_CsPageSetup` is a subset of worksheet's `CT_PageSetup`;
  // the fields we surface here are the ones the PDF renderer knows how
  // to interpret. Unknown fields are silently dropped.
  const ps = chartsheetPageSetup(cs);
  const margins = chartsheetPageMargins(cs);
  const pageSetup: PdfPageSetupData | undefined =
    ps || margins
      ? {
          orientation: ps?.orientation,
          paperSize: ps?.paperSize,
          showGridLines: false,
          blackAndWhite: ps?.blackAndWhite,
          draft: ps?.draft,
          firstPageNumber: ps?.useFirstPageNumber === false ? undefined : ps?.firstPageNumber,
          margins: margins
            ? {
                left: margins.left ?? margins.l ?? 0.7,
                right: margins.right ?? margins.r ?? 0.7,
                top: margins.top ?? margins.t ?? 0.75,
                bottom: margins.bottom ?? margins.b ?? 0.75,
                header: margins.header,
                footer: margins.footer
              }
            : undefined
        }
      : undefined;

  return {
    kind: "chartsheet",
    name: chartsheetName(cs),
    state: chartsheetState(cs),
    orderNo: chartsheetModel(cs).orderNo,
    orientation,
    chart,
    pageSetup,
    headerFooter: convertHeaderFooterModel(
      chartsheetModel(cs).headerFooter,
      draftQuality ? [] : convertChartsheetHeaderImages(chartsheetModel(cs).headerImages, workbook)
    )
  };
}

function convertChartsheetHeaderImages(
  images: ReturnType<typeof chartsheetModel>["headerImages"],
  workbook: Workbook
): PdfHeaderFooterData["images"] {
  return (images ?? []).flatMap(image => {
    const media = getImage(workbook, image.imageId);
    const format = media?.extension === "jpg" ? "jpeg" : media?.extension;
    const data =
      media?.buffer instanceof Uint8Array
        ? media.buffer
        : media?.base64
          ? base64ToUint8Array(media.base64)
          : undefined;
    return data?.length && (format === "png" || format === "jpeg")
      ? [
          {
            data,
            format,
            width: image.width ?? 467.25,
            height: image.height ?? 311.25,
            position: image.position
          }
        ]
      : [];
  });
}
