/**
 * Type definitions for the PDF module.
 * Covers input data models, export options, page layout, and internal rendering models.
 *
 * The input data models (PdfWorkbook, PdfSheetData, etc.) are fully independent of
 * the Excel module, allowing the PDF engine to be used standalone.
 */

// =============================================================================
// PDF Input Data Model (Excel-independent)
// =============================================================================

/**
 * Cell value type discriminator for the PDF engine.
 */
export const PdfCellType = {
  Empty: 0,
  String: 1,
  Number: 2,
  Boolean: 3,
  Date: 4,
  RichText: 5,
  Error: 6,
  Formula: 7,
  Hyperlink: 8,
  Merge: 9
} as const;

export type PdfCellTypeValue = (typeof PdfCellType)[keyof typeof PdfCellType];

/** Color data used across the PDF input model. */
export interface PdfColorData {
  argb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

/** Font style in the PDF input model. */
export interface PdfFontStyle {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean | string;
  color?: PdfColorData;
}

/** Fill data in the PDF input model. */
export interface PdfFillData {
  type: "pattern" | "gradient";
  pattern?: string;
  fgColor?: PdfColorData;
  stops?: Array<{ position?: number; color: PdfColorData }>;
}

/** A single border edge in the PDF input model. */
export interface PdfBorderSideData {
  style?: string;
  color?: PdfColorData;
}

/** Border data in the PDF input model. */
export interface PdfBordersData {
  top?: Partial<PdfBorderSideData>;
  right?: Partial<PdfBorderSideData>;
  bottom?: Partial<PdfBorderSideData>;
  left?: Partial<PdfBorderSideData>;
}

/** Alignment data in the PDF input model. */
export interface PdfAlignmentData {
  horizontal?: string;
  vertical?: string;
  wrapText?: boolean;
  indent?: number;
  textRotation?: number;
}

/** Cell style in the PDF input model. */
export interface PdfCellStyle {
  font?: Partial<PdfFontStyle>;
  numFmt?: string | { formatCode: string };
  fill?: PdfFillData;
  border?: Partial<PdfBordersData>;
  alignment?: Partial<PdfAlignmentData>;
}

/** A single run of rich text. */
export interface PdfRichTextRunData {
  text: string;
  font?: Partial<PdfFontStyle>;
}

/** A cell in the PDF input model. */
export interface PdfCellData {
  type: PdfCellTypeValue;
  value: unknown;
  /** Pre-computed display text */
  text: string;
  style?: Partial<PdfCellStyle>;
  hyperlink?: string;
  /** Formula result (for formula cells) */
  result?: unknown;
  /** Column number (1-based) */
  col: number;
}

/** A row in the PDF input model. */
export interface PdfRowData {
  hidden?: boolean;
  height?: number;
  /** Whether the height was explicitly set by the user (vs auto-calculated) */
  customHeight?: boolean;
  /** Cells keyed by 1-based column number */
  cells: Map<number, PdfCellData>;
}

/** A column in the PDF input model. */
export interface PdfColumnData {
  hidden?: boolean;
  width?: number;
}

/** Page setup configuration. */
export interface PdfPageSetupData {
  orientation?: string;
  paperSize?: number;
  margins?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    header?: number;
    footer?: number;
  };
  scale?: number;
  printTitlesRow?: string;
  showGridLines?: boolean;
  printArea?: string;
  firstPageNumber?: number;
}

export type PdfHeaderFooterField =
  | "pageNumber"
  | "pageCount"
  | "sheetName"
  | "fileName"
  | "filePath"
  | "date"
  | "time"
  | "image";

export interface PdfHeaderFooterRun {
  text?: string;
  field?: PdfHeaderFooterField;
  /** Offset used by Excel's `&P+N` / `&P-N` page-number syntax. */
  offset?: number;
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
  color?: PdfColor;
}

export interface PdfHeaderFooterContent {
  left: PdfHeaderFooterRun[];
  center: PdfHeaderFooterRun[];
  right: PdfHeaderFooterRun[];
}

export interface PdfHeaderFooterImage {
  data: Uint8Array;
  format: "jpeg" | "png";
  width: number;
  height: number;
  position: "LH" | "CH" | "RH" | "LF" | "CF" | "RF";
}

export interface PdfHeaderFooterData {
  differentFirst: boolean;
  differentOddEven: boolean;
  scaleWithDoc: boolean;
  alignWithMargins: boolean;
  oddHeader?: PdfHeaderFooterContent;
  oddFooter?: PdfHeaderFooterContent;
  evenHeader?: PdfHeaderFooterContent;
  evenFooter?: PdfHeaderFooterContent;
  firstHeader?: PdfHeaderFooterContent;
  firstFooter?: PdfHeaderFooterContent;
  images: PdfHeaderFooterImage[];
}

/** Anchor range shared by embedded images and charts. */
export interface PdfAnchorRange {
  tl: {
    col: number;
    row: number;
    nativeCol?: number;
    nativeRow?: number;
    nativeColOff?: number;
    nativeRowOff?: number;
  };
  br?: {
    col: number;
    row: number;
    nativeCol?: number;
    nativeRow?: number;
    nativeColOff?: number;
    nativeRowOff?: number;
  };
  /**
   * Image variant uses pixels (px × 0.75 = pt).
   * Chart variant uses EMU (cx / 9525 = pt).
   * The layout engine picks the correct conversion via `extUnit`.
   */
  ext?: { width: number; height: number };
  /** Unit of measure for `ext`. Defaults to "px" for backwards compatibility. */
  extUnit?: "px" | "emu";
}

/** An image embedded in a sheet. */
export interface PdfSheetImage {
  data: Uint8Array;
  format: "jpeg" | "png";
  range: PdfAnchorRange;
}

/**
 * Path operator set understood by {@link PdfChartDrawingSurface}.`drawPath`.
 * Structurally compatible with `ChartPdfPathOp` from `@excel/chart` so the
 * excel-bridge can forward between the two at the cast boundary.
 */
export type PdfChartPathOp =
  | { op: "move"; x: number; y: number }
  | { op: "line"; x: number; y: number }
  | { op: "curve"; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
  | { op: "close" };

/**
 * Drawing surface used by vector chart renderers when embedded in a PDF page.
 *
 * Structurally compatible with `ChartPdfDrawingSurface` from the Excel chart
 * renderer. Declared locally in the PDF layer so the rendering pipeline does
 * not need to import chart types — only `excel-bridge.ts` (the documented
 * layer-crossing file) forwards real chart models to the surface.
 *
 * All coordinates are in **PDF points with bottom-left origin**, matching the
 * convention the chart renderer emits after its internal Y-flip.
 */
export interface PdfChartDrawingSurface {
  drawRect(options: {
    x: number;
    y: number;
    width: number;
    height: number;
    fill?: PdfColor;
    stroke?: PdfColor;
    lineWidth?: number;
  }): unknown;
  drawLine(options: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color?: PdfColor;
    lineWidth?: number;
    dashPattern?: number[];
  }): unknown;
  drawText(
    text: string,
    options: {
      x: number;
      y: number;
      fontSize?: number;
      color?: PdfColor;
      rotation?: number;
      anchor?: "start" | "middle" | "end";
      bold?: boolean;
      italic?: boolean;
      fontFamily?: string;
    }
  ): unknown;
  drawCircle?(options: {
    cx: number;
    cy: number;
    r: number;
    fill?: PdfColor;
    stroke?: PdfColor;
    lineWidth?: number;
  }): unknown;
  drawPath?(
    ops: PdfChartPathOp[],
    options?: {
      fill?: PdfColor;
      stroke?: PdfColor;
      closePath?: boolean;
      lineWidth?: number;
      dashPattern?: number[];
    }
  ): unknown;
}

/**
 * A chart embedded in a sheet.
 *
 * Either provides a `drawVector` callback (preferred — selectable text,
 * resolution-independent shapes) or a pre-rasterised `raster` payload that
 * falls through to the image XObject pipeline. Exactly one of the two should
 * be populated; if both are present the renderer prefers `drawVector`.
 */
export interface PdfSheetChart {
  range: PdfAnchorRange;
  /**
   * Vector renderer. Bound in `excel-bridge.ts` over the concrete chart
   * model; the PDF pipeline invokes it with a surface that adapts the
   * current page's content stream. `rect` is in PDF page coordinates
   * (bottom-left origin).
   */
  drawVector?: (
    surface: PdfChartDrawingSurface,
    rect: { x: number; y: number; width: number; height: number }
  ) => void;
  /**
   * Raster fallback used when the chart has no vector path (currently only
   * ChartEx layouts not in the `VECTOR_PDF_CHART_EX_LAYOUT_IDS` whitelist).
   */
  raster?: { data: Uint8Array; format: "png" | "jpeg" };
}

/** A single cell-grid sheet in the PDF input model. */
export interface PdfSheetData {
  /**
   * Discriminator. Optional for backwards compatibility — when absent the
   * exporter treats the sheet as a regular cell-grid worksheet.
   */
  kind?: "worksheet";
  name: string;
  state?: "visible" | "hidden" | "veryHidden";
  /**
   * Tab order from the source workbook. Used by `excelToPdf` to interleave
   * worksheets and chartsheets in the same order Excel would display them.
   * Optional; when absent the sheet keeps its array position.
   */
  orderNo?: number;
  /** Data bounds (1-based) */
  bounds: { top: number; left: number; bottom: number; right: number };
  /** Columns keyed by 1-based column number */
  columns: Map<number, PdfColumnData>;
  /** Rows keyed by 1-based row number */
  rows: Map<number, PdfRowData>;
  /** Merge ranges in "A1:B2" format */
  merges?: string[];
  pageSetup?: PdfPageSetupData;
  /** Parsed printable headers and footers inherited from the source worksheet. */
  headerFooter?: PdfHeaderFooterData;
  /** Row numbers where manual page breaks occur */
  rowBreaks?: number[];
  /** Column numbers where manual page breaks occur */
  colBreaks?: number[];
  /** Embedded images */
  images?: PdfSheetImage[];
  /** Embedded charts (classic + ChartEx) */
  charts?: PdfSheetChart[];
}

/**
 * A chartsheet — a single-chart "sheet" with no cell grid.
 *
 * Excel stores chartsheets under `xl/chartsheets/sheetN.xml`, parallel to
 * the worksheet family. A chartsheet has no rows/columns/cells; the entire
 * printed canvas is one chart. The PDF pipeline honours that semantic: a
 * chartsheet produces exactly one LayoutPage with a single chart filling
 * the content area (below the optional header, above the optional footer).
 */
export interface PdfChartsheetData {
  kind: "chartsheet";
  name: string;
  state?: "visible" | "hidden" | "veryHidden";
  /** Tab order — used to interleave with worksheets. See {@link PdfSheetData.orderNo}. */
  orderNo?: number;
  /**
   * Page orientation override. Excel's chartsheets default to landscape
   * (wider canvas suits most charts) and we keep that default when this
   * field is absent.
   */
  orientation?: "portrait" | "landscape";
  /** The single chart that fills the sheet canvas. */
  chart: {
    drawVector?: PdfSheetChart["drawVector"];
    raster?: PdfSheetChart["raster"];
  };
  /**
   * Optional page setup overrides. Only a subset of the worksheet
   * `PdfPageSetupData` is meaningful here (chartsheets don't have
   * gridlines, print titles, row/col breaks, etc.). The renderer reads
   * `orientation` off `this.orientation` first, then falls back to
   * `pageSetup?.orientation`.
   */
  pageSetup?: PdfPageSetupData;
  headerFooter?: PdfHeaderFooterData;
}

/**
 * Union of sheet shapes accepted by {@link PdfWorkbook.sheets}.
 *
 * Named `PdfWorkbookSheet` (not `PdfSheet`) because `PdfSheet` already
 * denotes a different user-facing input type in `pdf.ts` — the simple
 * "pass me a 2D array or a single sheet description" shape.
 */
export type PdfWorkbookSheet = PdfSheetData | PdfChartsheetData;

/** Type guard distinguishing chartsheets from cell-grid worksheets. */
export function isPdfChartsheet(sheet: PdfWorkbookSheet): sheet is PdfChartsheetData {
  return sheet.kind === "chartsheet";
}

/**
 * A workbook data structure for PDF generation.
 * This is a plain data object — not tied to the Excel module.
 */
export interface PdfWorkbook {
  title?: string;
  creator?: string;
  subject?: string;
  sourceFileName?: string;
  sourceFilePath?: string;
  locale?: string;
  sheets: PdfWorkbookSheet[];
}

// =============================================================================
// Page Size Definitions
// =============================================================================

/**
 * Standard page sizes in PDF points (1 point = 1/72 inch).
 */
export interface PdfPageSize {
  /** Width in points */
  width: number;
  /** Height in points */
  height: number;
}

/**
 * Predefined page size names.
 */
export type PageSizeName = "A3" | "A4" | "A5" | "LETTER" | "LEGAL" | "TABLOID";

/**
 * Predefined page sizes.
 */
export const PageSizes: Record<PageSizeName, PdfPageSize> = {
  A3: { width: 841.89, height: 1190.55 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 },
  TABLOID: { width: 792, height: 1224 }
};

// =============================================================================
// PDF Export Options
// =============================================================================

/**
 * Page orientation for PDF export.
 */
export type PdfOrientation = "portrait" | "landscape";

/**
 * Excel header/footer rendering options.
 *
 * Excel resolves `&F`, `&Z`, `&D`, and `&T` against the host application's
 * document and locale. A standalone exporter has no such context, so these
 * fields supply it. When omitted, `&F` / `&Z` fall back to the workbook's
 * recorded source path, and `&D` / `&T` use the export time and workbook
 * language.
 */
export interface PdfHeaderFooterOptions {
  /**
   * Whether to render headers and footers defined by the source worksheet.
   * @default true
   */
  enabled?: boolean;
  /** File name substituted for `&F`. */
  fileName?: string;
  /** Directory substituted for `&Z`. */
  filePath?: string;
  /** Date/time used by `&D` and `&T`. Defaults to the export time. */
  date?: Date;
  /** Locale used by `&D` and `&T`. Falls back to the workbook language. */
  locale?: string;
}

/**
 * Options for controlling PDF export behavior.
 */
export interface PdfExportOptions {
  /**
   * Page size. Can be a predefined name or custom dimensions.
   * @default "A4"
   */
  pageSize?: PageSizeName | PdfPageSize;

  /**
   * Page orientation. If not set, uses the sheet's pageSetup.orientation.
   * @default "portrait"
   */
  orientation?: PdfOrientation;

  /**
   * Page margins in points (1/72 inch).
   * @default { top: 72, right: 72, bottom: 72, left: 72 }
   */
  margins?: Partial<PdfMargins>;

  /**
   * Which sheets to include. Accepts sheet names or 1-based positions.
   * If omitted, all visible sheets are included.
   */
  sheets?: (string | number)[];

  /**
   * Whether to ignore each worksheet's print area when exporting.
   * When true, the entire used range of every sheet is exported, regardless
   * of any `pageSetup.printArea` defined on the worksheet. The workbook itself
   * is left unmodified.
   * @default false
   */
  ignorePrintArea?: boolean;

  /**
   * Whether to auto-fit column widths to page width.
   * When true, columns are scaled proportionally to fit the page.
   * @default true
   */
  fitToPage?: boolean;

  /**
   * Scale factor (0.1 to 3.0). Applied after fitToPage.
   * @default 1.0
   */
  scale?: number;

  /**
   * Whether to show grid lines on the page.
   * @default false
   */
  showGridLines?: boolean;

  /**
   * Grid line color as an ARGB hex string (e.g. "FFD0D0D0").
   * @default "FFD0D0D0"
   */
  gridLineColor?: string;

  /**
   * Whether to repeat row headers on each page.
   * Can be a number (row count from top) or false to disable.
   * @default false
   */
  repeatRows?: number | false;

  /**
   * Default font family for cells without an explicit font.
   * @default "Helvetica"
   */
  defaultFontFamily?: string;

  /**
   * Default font size in points for cells without an explicit font size.
   * @default 11
   */
  defaultFontSize?: number;

  /**
   * Whether to include sheet names as page headers.
   * @default false
   */
  showSheetNames?: boolean;

  /**
   * Whether to include page numbers in the footer.
   * @default false
   */
  showPageNumbers?: boolean;

  /**
   * Excel header/footer rendering. Excel-specific substitutions are grouped
   * here rather than flattened onto the top-level export options.
   */
  headerFooter?: PdfHeaderFooterOptions;

  /**
   * PDF document title metadata.
   */
  title?: string;

  /**
   * PDF document author metadata.
   */
  author?: string;

  /**
   * PDF document subject metadata.
   */
  subject?: string;

  /**
   * PDF document creator metadata.
   * @default "documonster"
   */
  creator?: string;

  /**
   * TrueType font file (.ttf) data for Unicode text support.
   * When provided, all text rendering uses this font, enabling
   * CJK (Chinese, Japanese, Korean), Arabic, Hindi, Cyrillic, and other scripts.
   *
   * Pass the raw bytes of a .ttf font file:
   * ```typescript
   * import { readFileSync } from "fs";
   * const font = readFileSync("NotoSansSC-Regular.ttf");
   * Pdf.fromExcel(workbook, { font });
   * ```
   */
  font?: Uint8Array;

  /**
   * Encryption options for password-protecting the PDF.
   *
   * @example
   * ```typescript
   * Pdf.fromExcel(workbook, {
   *   encryption: {
   *     ownerPassword: "secret",
   *     userPassword: "open",
   *     permissions: { print: true, copy: false }
   *   }
   * });
   * ```
   */
  encryption?: {
    /** User password (required to open). Empty string = no open password. */
    userPassword?: string;
    /** Owner password (grants full access). Required. */
    ownerPassword: string;
    /** Permissions when opened with user password. */
    permissions?: Partial<{
      print: boolean;
      modify: boolean;
      copy: boolean;
      annotate: boolean;
      fillForms: boolean;
      accessibility: boolean;
      assemble: boolean;
      printHighQuality: boolean;
    }>;
  };

  /**
   * Watermark to render on every page.
   * Supports text watermarks (e.g. "CONFIDENTIAL") and image watermarks (e.g. company logo).
   *
   * @example Text watermark:
   * ```typescript
   * watermark: {
   *   type: "text",
   *   text: "DRAFT",
   *   opacity: 0.1,
   *   rotation: -45
   * }
   * ```
   *
   * @example Image watermark:
   * ```typescript
   * watermark: {
   *   type: "image",
   *   data: logoPng,
   *   format: "png",
   *   opacity: 0.08
   * }
   * ```
   */
  watermark?: PdfWatermark;
}

// =============================================================================
// Watermark Options
// =============================================================================

/**
 * Text watermark configuration for PDF export.
 *
 * Renders semi-transparent text (e.g. "CONFIDENTIAL", "DRAFT") on every page.
 *
 * @example
 * ```typescript
 * const bytes = await pdf(data, {
 *   watermark: {
 *     type: "text",
 *     text: "CONFIDENTIAL",
 *     color: { r: 0.8, g: 0, b: 0 },
 *     opacity: 0.1,
 *     rotation: -45
 *   }
 * });
 * ```
 */
export interface PdfTextWatermark {
  type: "text";
  /** The watermark text to display. */
  text: string;
  /**
   * Font size in points.
   * @default 54
   */
  fontSize?: number;
  /**
   * Text color (RGB, each 0-1).
   * @default { r: 0.75, g: 0.75, b: 0.75 }
   */
  color?: PdfColor;
  /**
   * Opacity (0 = fully transparent, 1 = fully opaque).
   * @default 0.15
   */
  opacity?: number;
  /**
   * Rotation angle in degrees (positive = counter-clockwise).
   * @default -45
   */
  rotation?: number;
  /**
   * Font family name. Must be a standard PDF font (Type1) or the embedded font.
   * @default "Helvetica"
   */
  fontFamily?: string;
  /**
   * Whether to render in bold.
   * @default false
   */
  bold?: boolean;
  /**
   * Whether to render in italic.
   * @default false
   */
  italic?: boolean;
  /**
   * Position on the page. `"center"` places the watermark at the geometric center.
   * A custom `{ x, y }` object specifies the **center point** of the watermark
   * in PDF points (origin at bottom-left corner of the page).
   * @default "center"
   */
  position?: "center" | { x: number; y: number };
  /**
   * When true, the watermark text is tiled in a repeating grid across the entire page.
   * @default false
   */
  repeat?: boolean;
  /**
   * Horizontal spacing (in points) between repeated watermark tiles.
   * Only used when `repeat` is true.
   * @default 200
   */
  repeatSpacingX?: number;
  /**
   * Vertical spacing (in points) between repeated watermark tiles.
   * Only used when `repeat` is true.
   * @default 200
   */
  repeatSpacingY?: number;
}

/**
 * Image watermark configuration for PDF export.
 *
 * Embeds a semi-transparent image (e.g. company logo) on every page.
 *
 * @example
 * ```typescript
 * import { readFileSync } from "fs";
 * const logo = readFileSync("logo.png");
 *
 * const bytes = await pdf(data, {
 *   watermark: {
 *     type: "image",
 *     data: logo,
 *     format: "png",
 *     opacity: 0.08,
 *     scale: 0.4
 *   }
 * });
 * ```
 */
export interface PdfImageWatermark {
  type: "image";
  /** Raw image bytes (JPEG or PNG). */
  data: Uint8Array;
  /** Image format. */
  format: "jpeg" | "png";
  /**
   * Opacity (0 = fully transparent, 1 = fully opaque).
   * @default 0.15
   */
  opacity?: number;
  /**
   * Rotation angle in degrees (positive = counter-clockwise).
   * @default 0
   */
  rotation?: number;
  /**
   * Scale factor relative to the page size.
   * 0.5 means the image's largest dimension will be scaled to
   * 50% of the smaller page dimension (width or height).
   * Ignored when `width` and `height` are explicitly provided.
   * @default 0.5
   */
  scale?: number;
  /**
   * Explicit image width in PDF points. When set together with `height`,
   * overrides `scale` and renders the image at the exact specified dimensions.
   */
  width?: number;
  /**
   * Explicit image height in PDF points. When set together with `width`,
   * overrides `scale` and renders the image at the exact specified dimensions.
   */
  height?: number;
  /**
   * Position on the page. `"center"` places the watermark at the geometric center.
   * A custom `{ x, y }` object specifies the **center point** of the watermark
   * in PDF points (origin at bottom-left corner of the page).
   * @default "center"
   */
  position?: "center" | { x: number; y: number };
  /**
   * When true, the watermark image is tiled in a repeating grid across the entire page.
   * @default false
   */
  repeat?: boolean;
  /**
   * Horizontal spacing (in points) between repeated watermark tiles.
   * Only used when `repeat` is true.
   * @default 200
   */
  repeatSpacingX?: number;
  /**
   * Vertical spacing (in points) between repeated watermark tiles.
   * Only used when `repeat` is true.
   * @default 200
   */
  repeatSpacingY?: number;
}

/**
 * Common watermark filter and placement options shared by text and image watermarks.
 */
export interface PdfWatermarkFilter {
  /**
   * Restrict the watermark to specific page numbers (1-based, document-global).
   * When set, only pages whose number is in this array get the watermark.
   * If omitted, all pages receive the watermark.
   *
   * @example Only on the first page:
   * ```typescript
   * watermark: { type: "text", text: "COVER", pages: [1] }
   * ```
   */
  pages?: number[];

  /**
   * Restrict the watermark to specific sheet names (case-insensitive).
   * When set, only pages belonging to the named sheets get the watermark.
   * If omitted, all sheets receive the watermark.
   *
   * @example Only on the "Summary" sheet:
   * ```typescript
   * watermark: { type: "text", text: "DRAFT", sheets: ["Summary"] }
   * ```
   */
  sheets?: string[];

  /**
   * Watermark layering relative to page content.
   *
   * - `"under"` — watermark renders **behind** all page content including
   *   cell fills, borders, text, grid lines, headers, and footers (default)
   * - `"over"` — watermark renders **on top of** all page content
   *
   * @default "under"
   */
  placement?: "under" | "over";
}

/**
 * Watermark configuration — either text or image, with optional page/sheet filters.
 */
export type PdfWatermark = (PdfTextWatermark | PdfImageWatermark) & PdfWatermarkFilter;

// =============================================================================
// Internal Layout Models
// =============================================================================

/**
 * Page margins in PDF points.
 */
export interface PdfMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Resolved (normalized) export options with all defaults applied.
 */
export interface ResolvedPdfOptions {
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  margins: PdfMargins;
  ignorePrintArea: boolean;
  fitToPage: boolean;
  scale: number;
  showGridLines: boolean;
  gridLineColor: PdfColor;
  repeatRows: number | false;
  defaultFontFamily: string;
  defaultFontSize: number;
  showSheetNames: boolean;
  showPageNumbers: boolean;
  includeHeadersFooters: boolean;
  headerMargin: number;
  footerMargin: number;
  sourceFileName: string;
  sourceFilePath: string;
  headerFooterDate: Date;
  headerFooterLocale?: string;
  title: string;
  author: string;
  subject: string;
  creator: string;
  watermark?: PdfWatermark;
}

// =============================================================================
// Internal Rendering Types
// =============================================================================

/**
 * RGBA color used internally for PDF rendering.
 * Each component is 0-1. Alpha defaults to 1 (fully opaque) if omitted.
 */
export interface PdfColor {
  r: number;
  g: number;
  b: number;
  /** Opacity: 0 = fully transparent, 1 = fully opaque. Default 1. */
  a?: number;
}

/**
 * A rectangular region in PDF coordinate space (origin = bottom-left).
 */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A laid-out cell ready for rendering.
 */
export interface LayoutCell {
  /** Cell text content */
  text: string;
  /** Rectangle in page coordinates (PDF points, origin bottom-left) */
  rect: PdfRect;
  /** Font family resolved for this cell */
  fontFamily: string;
  /** Font size in points */
  fontSize: number;
  /** Whether the font is bold */
  bold: boolean;
  /** Whether the font is italic */
  italic: boolean;
  /** Whether the font has strikethrough */
  strike: boolean;
  /** Underline style */
  underline: boolean;
  /** Text color */
  textColor: PdfColor;
  /** Background fill color (null = transparent) */
  fillColor: PdfColor | null;
  /** Horizontal alignment */
  horizontalAlign: "left" | "center" | "right";
  /** Vertical alignment */
  verticalAlign: "top" | "middle" | "bottom";
  /** Whether text wrapping is enabled */
  wrapText: boolean;
  /** Border definitions for this cell (after shared-edge resolution: only edges this cell draws) */
  borders: LayoutBorders;
  /**
   * Effective border insets in points for text padding.
   *
   * On a shared edge the border line is drawn by only one of the two cells,
   * but it still visually intrudes into both.  These values record the actual
   * half-width intrusion on each side regardless of which cell draws the line.
   */
  borderInsets: { top: number; right: number; bottom: number; left: number };
  /** Number of columns this cell spans (for merged cells) */
  colSpan: number;
  /** Number of rows this cell spans (for merged cells) */
  rowSpan: number;
  /** Hyperlink URL (if this cell is a hyperlink) */
  hyperlink: string | null;
  /** Rich text runs (null if plain text) */
  richText: LayoutRichTextRun[] | null;
  /** Indent level (0 = none) */
  indent: number;
  /** Text rotation in degrees (0-90 ccw, 91-180 cw) or "vertical" for stacked */
  textRotation: number | "vertical";
  /** Extra width (in points) that text can overflow into adjacent empty cells */
  textOverflowWidth: number;
}

/**
 * A single run within a rich text cell.
 */
export interface LayoutRichTextRun {
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  textColor: PdfColor;
}

/**
 * Border definitions for a single cell.
 */
export interface LayoutBorders {
  top: LayoutBorder | null;
  right: LayoutBorder | null;
  bottom: LayoutBorder | null;
  left: LayoutBorder | null;
}

/**
 * A single border edge.
 */
export interface LayoutBorder {
  /** Line width in points */
  width: number;
  /** Border color */
  color: PdfColor;
  /** Dash pattern (empty array = solid) */
  dashPattern: number[];
  /** Whether this is a double-line border */
  isDouble?: boolean;
}

/**
 * A single page of laid-out content.
 */
export interface LayoutPage {
  /** Page number (1-based) */
  pageNumber: number;
  /** Page number within the source sheet, including its first-page offset. */
  sheetPageNumber: number;
  /** Physical page index within the source sheet (always starts at 1). */
  sheetPageIndex: number;
  /** Total number of pages in the selected print job (`&N`). */
  sheetPageCount: number;
  /** Explicit first page number from the source sheet, including explicit 1. */
  firstPageNumber?: number;
  /** Resolved rendering options for the sheet that produced this page */
  options: ResolvedPdfOptions;
  /** Cells to render on this page */
  cells: LayoutCell[];
  /** Page width in points */
  width: number;
  /** Page height in points */
  height: number;
  /** Sheet name for this page */
  sheetName: string;
  /** Sheet column numbers included on this page */
  sheetCols: number[];
  /** Column x-offsets (left edges) relative to page content area */
  columnOffsets: number[];
  /** Column widths in points */
  columnWidths: number[];
  /** Sheet row numbers included on this page */
  sheetRows: number[];
  /** Row y-offsets (top edges) in page coordinates (PDF bottom-left origin) */
  rowYPositions: number[];
  /** Row heights in points */
  rowHeights: number[];
  /** Images to render on this page */
  images: LayoutImage[];
  /** Charts to render on this page */
  charts: LayoutChart[];
  /** Scale factor applied to this page (for fitToPage) */
  scaleFactor: number;
  headerFooter?: PdfHeaderFooterData;
}

/**
 * A positioned image on a PDF page.
 */
export interface LayoutImage {
  /** Image data bytes (JPEG or PNG) */
  data: Uint8Array;
  /** Image format */
  format: "jpeg" | "png";
  /** Rectangle in page coordinates (PDF points, origin bottom-left) */
  rect: PdfRect;
}

/**
 * A positioned chart on a PDF page.
 *
 * Either `drawVector` (preferred) or `raster` must be provided; the exporter
 * prefers `drawVector` when both are present so the PDF keeps selectable
 * text and resolution-independent shapes.
 */
export interface LayoutChart {
  /** Rectangle in page coordinates (PDF points, origin bottom-left) */
  rect: PdfRect;
  /** Vector rendering callback, if the chart can be drawn as PDF geometry. */
  drawVector?: (
    surface: PdfChartDrawingSurface,
    rect: { x: number; y: number; width: number; height: number }
  ) => void;
  /** Raster fallback for charts that have no vector path. */
  raster?: { data: Uint8Array; format: "png" | "jpeg" };
}
