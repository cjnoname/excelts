/**
 * Type definitions for the PDF module.
 * Covers input data models, export options, page layout, and internal rendering models.
 *
 * The input data models (PdfWorkbook, PdfSheetData, etc.) are fully independent of
 * the Excel module, allowing the PDF engine to be used standalone.
 */

import type { PdfFontConfig } from "@pdf/font/font-config";
import type { CjkLanguage } from "@utils/cjk";

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
  /** Excel's scaling percentage (10–400, where 100 = actual size). */
  scale?: number;
  /**
   * Whether Excel's "Fit to N page(s) wide by M tall" scaling mode is active
   * (`<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`). When true,
   * {@link fitToWidth} / {@link fitToHeight} drive the scale and
   * {@link scale} is ignored — the two are mutually exclusive in Excel's UI.
   */
  fitToPage?: boolean;
  /** Pages wide to fit into. `0` means "unlimited" (no width constraint). */
  fitToWidth?: number;
  /** Pages tall to fit into. `0` means "unlimited" (no height constraint). */
  fitToHeight?: number;
  printTitlesRow?: string;
  /** Repeated columns, e.g. `"A:B"` or `"A"` (Excel's "Columns to repeat at left"). */
  printTitlesColumn?: string;
  showGridLines?: boolean;
  /** Print row numbers and column letters (`<printOptions headings="1"/>`). */
  showRowColHeaders?: boolean;
  printArea?: string;
  firstPageNumber?: number;
  /**
   * Order in which pages of a multi-page sheet are emitted.
   * Excel's default is `"downThenOver"`.
   */
  pageOrder?: string;
  /** Render the sheet without color (Excel's "Black and white" print option). */
  blackAndWhite?: boolean;
  /** Draft quality — skips graphics (images and charts). */
  draft?: boolean;
  /** How error values are printed: `displayed` | `blank` | `dash` | `NA`. */
  errors?: string;
  /** How comments print: `None` | `asDisplayed` | `atEnd`. */
  cellComments?: string;
  /**
   * Excel's "Center on page → Horizontally" print option
   * (`<printOptions horizontalCentered="1"/>`). When false/absent the
   * printed grid starts at the left margin.
   */
  horizontalCentered?: boolean;
  /**
   * Excel's "Center on page → Vertically" print option
   * (`<printOptions verticalCentered="1"/>`). When false/absent the
   * printed grid starts at the top margin.
   */
  verticalCentered?: boolean;
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
  /** Cell comments and notes, in row-major order. */
  comments?: PdfSheetComment[];
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
 * Order in which the pages of a multi-page sheet are emitted, mirroring
 * Excel's "Page order" setting.
 */
export type PdfPageOrder = "downThenOver" | "overThenDown";

/**
 * How cells holding an error value are printed, mirroring Excel's
 * "Cell errors as" setting.
 */
export type PdfCellErrorMode = "displayed" | "blank" | "dash" | "NA";

/**
 * How cell comments are printed, mirroring Excel's "Comments and notes"
 * print option.
 */
export type PdfCellCommentMode = "none" | "atEnd" | "asDisplayed";

/**
 * Comment box placement, in fractional sheet coordinates.
 *
 * Excel stores this as a VML anchor: eight integers giving a column/row plus an
 * offset in 1/68 of a column and 1/18 of a row. Those are pre-divided here so
 * the layout engine only has to interpolate against its own track geometry.
 * All values are 0-based, matching the VML convention.
 */
export interface PdfCommentAnchor {
  /** Left edge, in columns. `2.5` is halfway across the third column. */
  left: number;
  /** Top edge, in rows. */
  top: number;
  /** Right edge, in columns. */
  right: number;
  /** Bottom edge, in rows. */
  bottom: number;
}

/** A single printed cell comment. */
export interface PdfSheetComment {
  /** Cell address the comment is attached to, e.g. `"B7"`. */
  ref: string;
  /** Plain-text body. */
  text: string;
  /** Author, when the source recorded one. */
  author?: string;
  /**
   * Where the comment box sits on the sheet, when the source recorded a VML
   * anchor. Consumed by `cellComments: "asDisplayed"`; absent comments fall back
   * to Excel's default offset from their cell.
   */
  anchor?: PdfCommentAnchor;
}

/**
 * An inclusive band of repeated title rows or columns, in absolute 1-based
 * sheet coordinates.
 *
 * Absolute rather than a count, because Excel's "Rows/Columns to repeat" are
 * independent of the print area: a sheet printing `C5:H50` can still repeat
 * `A:B` at the left of every page.
 */
export interface PdfRepeatBand {
  /** First row/column of the band (1-based, inclusive). */
  first: number;
  /** Last row/column of the band (1-based, inclusive). */
  last: number;
}

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
   * Whether to shrink column widths so the grid fits the page width.
   * Never enlarges — content narrower than the page is left at actual size,
   * matching Excel's fit-to-page behaviour.
   *
   * This is the fallback used when neither the caller nor the sheet expresses a
   * fit-to-N or percentage scaling intent, so a sheet asking for 80% is not
   * shrunk twice. Passing it explicitly always wins, including over the sheet's
   * own fit-to-N mode.
   *
   * Note that {@link scale} is a *multiplier applied on top* of this and does
   * not disable it: `{ scale: 0.8 }` on an over-wide grid yields
   * `0.8 × fit-to-width`. Pass `fitToPage: false` alongside it for a plain 80%.
   * @default true
   */
  fitToPage?: boolean;

  /**
   * Scale factor (0.1 to 4.0), where `1.0` is actual size, multiplied with any
   * fit-to-page shrinking (see {@link fitToPage}). Overrides the sheet's
   * `pageSetup.scale`, which Excel stores as a 10–400 percentage.
   *
   * When omitted, the sheet's own scaling is used; see {@link fitToPage}.
   */
  scale?: number;

  /**
   * Shrink the grid so it spans at most this many pages horizontally,
   * mirroring Excel's "Fit to N page(s) wide". `0` removes the constraint.
   *
   * Like Excel, this only ever shrinks. When omitted, the sheet's
   * `pageSetup.fitToWidth` is used if its `fitToPage` mode is on.
   */
  fitToWidth?: number;

  /**
   * Shrink the grid so it spans at most this many pages vertically,
   * mirroring Excel's "Fit to M page(s) tall". `0` removes the constraint.
   *
   * Like Excel, this only ever shrinks. When omitted, the sheet's
   * `pageSetup.fitToHeight` is used if its `fitToPage` mode is on.
   */
  fitToHeight?: number;

  /**
   * Number of leading columns to repeat on every horizontal page, the
   * counterpart of {@link repeatRows}.
   *
   * When omitted, the sheet's `pageSetup.printTitlesColumn` ("Columns to
   * repeat at left", e.g. `"A:B"`) is used.
   * @default false
   */
  repeatCols?: number | false;

  /**
   * Print row numbers and column letters around the grid, mirroring Excel's
   * "Row and column headings" print option.
   *
   * When omitted, the sheet's `pageSetup.showRowColHeaders` is used.
   * @default false
   */
  showRowColHeaders?: boolean;

  /**
   * Order in which the pages of a multi-page sheet are emitted, mirroring
   * Excel's "Page order". `"downThenOver"` finishes each column band top to
   * bottom before moving right; `"overThenDown"` finishes each row band left
   * to right before moving down.
   *
   * When omitted, the sheet's `pageSetup.pageOrder` is used.
   * @default "downThenOver"
   */
  pageOrder?: PdfPageOrder;

  /**
   * Render vector content without color, mirroring Excel's "Black and white"
   * print option. Colors are converted to their luminance-preserving grayscale
   * equivalent, preserving opacity.
   *
   * Covers vector content (cell text, fills and borders, gridlines, the
   * row/column heading bands, chart vectors, `&K`-colored header/footer runs and
   * text watermarks) as well as raster content: PNG samples are converted to a
   * single luma component, and JPEG keeps its DCTDecode data but is reinterpreted
   * through a `/DeviceN` luma color space, so neither needs an overlay and
   * transparency is preserved.
   *
   * When omitted, the sheet's `pageSetup.blackAndWhite` is used.
   * @default false
   */
  blackAndWhite?: boolean;

  /**
   * Draft quality — omit images and charts, mirroring Excel's "Draft quality"
   * print option.
   *
   * When omitted, the sheet's `pageSetup.draft` is used.
   * @default false
   */
  draft?: boolean;

  /**
   * How cells holding an error value are printed, mirroring Excel's
   * "Cell errors as" print option.
   *
   * When omitted, the sheet's `pageSetup.errors` is used.
   * @default "displayed"
   */
  errors?: PdfCellErrorMode;

  /**
   * Whether cell comments and notes are printed, mirroring Excel's
   * "Comments and notes" print option.
   *
   * `"atEnd"` appends a list of every comment after the sheet's pages.
   * `"asDisplayed"` draws each comment as a box where it sits on the sheet,
   * plus the red corner marker Excel puts on the commented cell.
   *
   * When omitted, the sheet's `pageSetup.cellComments` is used.
   * @default "none"
   */
  cellComments?: PdfCellCommentMode;

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
   * Center the printed grid horizontally within the page's content area,
   * mirroring Excel's "Page Setup → Margins → Center on page → Horizontally".
   *
   * When omitted, the source sheet's `pageSetup.horizontalCentered` is used;
   * if that is unset too, content starts at the left margin.
   * @default false
   */
  horizontalCentered?: boolean;

  /**
   * Center the printed grid vertically within the page's content area,
   * mirroring Excel's "Page Setup → Margins → Center on page → Vertically".
   *
   * When omitted, the source sheet's `pageSetup.verticalCentered` is used;
   * if that is unset too, content starts at the top margin.
   * @default false
   */
  verticalCentered?: boolean;

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
   * Legacy single-font shortcut for TrueType font file (.ttf) data.
   * When provided, all text rendering uses this font. Prefer {@link fonts} for
   * named families, style faces, TrueType Collections, and fallback.
   *
   * Pass the raw bytes of a .ttf font file:
   * ```typescript
   * import { readFileSync } from "fs";
   * const font = readFileSync("NotoSansSC-Regular.ttf");
   * Pdf.fromExcel(workbook, { font });
   * ```
   *
   * Cannot be combined with {@link fonts}.
   */
  font?: Uint8Array;

  /**
   * Embedded TrueType typefaces used by PDF text planning.
   *
   * `default` serves document font names that are not explicitly configured.
   * Named families are matched case-insensitively through `name` and
   * `aliases`; only families listed in `fallbackFamilies` participate in
   * missing-glyph fallback. This keeps fallback deterministic instead of
   * borrowing from whichever configured font happens to come next.
   *
   * `fallbackFamilies` applies to text served by `default` as well as to text
   * that named a configured family. That matters because a document names the
   * fonts it was authored with — `Calibri`, `Courier New` — which a caller
   * configuring a CJK face has no reason to have configured, so `default` is the
   * common case rather than the exception.
   *
   * Each family requires `regular`. Missing style slots fall back to that
   * family's regular face. A source may select a face inside a TrueType
   * Collection through `collectionIndex`.
   *
   * The current renderer performs grapheme-safe font fallback but does not
   * perform OpenType shaping (GSUB/GPOS), bidi reordering, or color-emoji
   * rendering. A missing glyph is visibly rendered as `.notdef`, while its
   * original Unicode sequence remains in ToUnicode for copy, search, and text
   * extraction. Each embedded face is limited to 65,535 distinct Unicode
   * sequences in one PDF.
   *
   * Cannot be combined with the legacy {@link PdfExportOptions.font} option.
   */
  fonts?: PdfFontConfig;

  /**
   * Turn off the host font scan entirely.
   *
   * When neither {@link font} nor {@link fonts} is given and the document contains
   * characters WinAnsi cannot encode, the exporter scans the host's font
   * directories and borrows glyphs from whatever it finds. That is the difference
   * between a readable page and a row of `.notdef` boxes, but it makes the output
   * a function of the machine: a workbook exported on a Mac embeds Heiti SC, the
   * same workbook on a bare CI container embeds nothing and renders tofu.
   *
   * Not every character does, and {@link onWarning} distinguishes the two. Arrows,
   * box-drawing characters, dingbats, enclosed numerals and the rest of the symbol
   * blocks are drawn by built-in Type3 glyphs whether or not a face was found — those
   * are reported as a typeface inconsistency, not a loss. Ideographs, kana and Hangul
   * have no such substitute, and those are the ones that become `.notdef`.
   *
   * Set this when identical bytes across hosts matter more than legibility — a
   * golden-file test, a reproducible build, a signed document whose digest must
   * match. The characters keep their Unicode for copy and search either way; only
   * the glyphs are lost, and {@link onWarning} reports exactly which blocks.
   *
   * ```typescript
   * // Deterministic: either this font can draw the text or nothing can.
   * Pdf.fromExcel(workbook, {
   *   disableFontAutoDiscovery: true,
   *   fonts: { default: { regular: myFontBytes } }
   * });
   * ```
   *
   * Ignored when {@link font} or {@link fonts} is supplied, since no discovery
   * runs in that case. Node-only, like the scan it disables.
   *
   * @default false
   */
  disableFontAutoDiscovery?: boolean;

  /**
   * System font families that auto-discovery should prefer, in order, ahead of
   * its built-in preference list.
   *
   * When neither {@link font} nor {@link fonts} is given and the document
   * contains characters WinAnsi cannot encode, a best-effort scan of the host's
   * font directories picks a face to borrow glyphs from. The built-in order has
   * to choose something for every platform; naming families here says which
   * installed face you would rather have:
   *
   * ```typescript
   * Pdf.fromExcel(workbook, { preferSystemFonts: ["Heiti SC", "Songti SC"] });
   * ```
   *
   * Names are matched against the font's family name, case-insensitively, and
   * are also how a specific face inside a TrueType Collection is reached
   * (`"Heiti SC"` and `"Heiti TC"` are two faces of one `.ttc`). A family that
   * is not installed, cannot be parsed, or does not cover the document's
   * characters is skipped and the built-in order applies — this steers a
   * best-effort search rather than constraining it. Use {@link fonts} when a
   * specific face is a requirement.
   *
   * Node-only, and ignored when a font is supplied explicitly.
   */
  preferSystemFonts?: readonly string[];

  /**
   * The East Asian written language of the content, so auto-discovery picks a
   * face drawn in that regional hand.
   *
   * Unicode Han Unification gives Chinese, Japanese and Korean the same code
   * points for shared characters but not the same shapes — 「者」「骨」「今」
   * 「青」「每」are each drawn differently — so a font chosen purely by coverage
   * can be *correct and still wrong*: a Japanese face draws Chinese text that a
   * Chinese reader sees as malformed.
   *
   * ```typescript
   * Pdf.fromExcel(workbook, { textLanguage: "zh-Hans" });
   * ```
   *
   * Left unset, the language is inferred from the content's own characters (kana
   * settles Japanese, Hangul Korean, and characters unique to Simplified or
   * Traditional Chinese settle those). Text made only of forms common to all of
   * CJK carries no evidence and Chinese is preferred — a default rather than a
   * detection, which is the reason to state the language when you know it.
   *
   * Node-only, and ignored when a font is supplied explicitly.
   */
  textLanguage?: CjkLanguage;

  /**
   * Receive non-fatal font diagnostics raised while exporting.
   *
   * Currently raised for:
   *
   * - **characters no configured typeface covers.** They still carry their original
   *   Unicode for copy and search, but the page shows the `.notdef` glyph, and only
   *   the caller can decide which fallback family to add.
   * - **a system font auto-embedded on this host.** The page is readable, but the
   *   output is now a function of what the machine has installed — the same input
   *   on a bare container embeds nothing. Supply the font, or set
   *   {@link disableFontAutoDiscovery}, if the bytes have to be reproducible.
   *
   * Without this callback neither condition is visible.
   *
   * The callback is synchronous and may fire more than once per export.
   */
  onWarning?: (message: string) => void;

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
  /** Pages wide to shrink into; `0` means unconstrained. */
  fitToWidth: number;
  /** Pages tall to shrink into; `0` means unconstrained. */
  fitToHeight: number;
  showGridLines: boolean;
  gridLineColor: PdfColor;
  showRowColHeaders: boolean;
  horizontalCentered: boolean;
  verticalCentered: boolean;
  pageOrder: PdfPageOrder;
  blackAndWhite: boolean;
  draft: boolean;
  errors: PdfCellErrorMode;
  cellComments: PdfCellCommentMode;
  repeatRows: PdfRepeatBand | false;
  repeatCols: PdfRepeatBand | false;
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
  /**
   * Geometry of the printed row/column heading bands, when
   * {@link ResolvedPdfOptions.showRowColHeaders} is on. Absent otherwise.
   */
  headings?: LayoutHeadings;
  /**
   * Comment boxes to draw on this page, for
   * `cellComments: "asDisplayed"`. Empty otherwise.
   */
  commentBoxes?: LayoutCommentBox[];
  headerFooter?: PdfHeaderFooterData;
}

/**
 * A comment box positioned on the sheet, as Excel's "Comments: as displayed"
 * prints it, together with the corner marker on the commented cell.
 */
export interface LayoutCommentBox {
  /** Box outline in page coordinates. */
  rect: PdfRect;
  /** Comment body, already prefixed with the author when one is known. */
  text: string;
  /** Font size in points. */
  fontSize: number;
  /**
   * Corner marker on the commented cell, when that cell is on this page. Excel
   * draws a small red triangle in its top-right corner.
   */
  marker?: { x: number; y: number; size: number };
}

/**
 * Row-number gutter and column-letter band geometry for a page printed with
 * Excel's "Row and column headings" option.
 */
export interface LayoutHeadings {
  /** Width of the row-number gutter to the left of the grid, in points. */
  gutterWidth: number;
  /** Height of the column-letter band above the grid, in points. */
  bandHeight: number;
  /** Font size used for the heading labels, in points. */
  fontSize: number;
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
