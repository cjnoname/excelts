/**
 * Type definitions for Documonster
 * This file exports all public types used by the library
 */

import type { ErrorValue } from "@excel/core/enums";
import type { TemporalPlainValue } from "@excel/core/temporal";

// ============================================================================
// Paper Size
// ============================================================================
/**
 * Common OOXML paper-size codes, as convenience constants.
 *
 * `PageSetup.paperSize` stays a plain `number` on purpose: OOXML defines ~120
 * codes and this list is only the handful people ask for by name, so typing the
 * field as this union would reject perfectly valid codes (Letter = 1, A3 = 8, …).
 * A constant object rather than a TS `enum` so it tree-shakes when unused.
 */
export const PaperSize = {
  Legal: 5,
  Executive: 7,
  A4: 9,
  A5: 11,
  B5: 13,
  Envelope_10: 20,
  Envelope_DL: 27,
  Envelope_C5: 28,
  Envelope_B5: 34,
  Envelope_Monarch: 37,
  Double_Japan_Postcard_Rotated: 82,
  K16_197x273_mm: 119
} as const;
export type PaperSize = (typeof PaperSize)[keyof typeof PaperSize];

// ============================================================================
// Color Types
// ============================================================================
export interface Color {
  argb: string;
  theme: number;
  /** Tint applied to a theme color, in `[-1, 1]`. Present on theme-based colors. */
  tint?: number;
  /** Legacy indexed-palette color (xlsx `indexed` attribute). */
  indexed?: number;
}

// ============================================================================
// Font Types
// ============================================================================
export interface Font {
  name: string;
  size: number;
  family: number;
  scheme: "minor" | "major" | "none";
  charset: number;
  color: Partial<Color>;
  bold: boolean;
  italic: boolean;
  underline: boolean | "none" | "single" | "double" | "singleAccounting" | "doubleAccounting";
  vertAlign: "superscript" | "subscript";
  strike: boolean;
  outline: boolean;
  condense: boolean;
  extend: boolean;
  shadow: boolean;
}

// ============================================================================
// Alignment Types
// ============================================================================
export interface Alignment {
  horizontal: "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
  vertical: "top" | "middle" | "bottom" | "distributed" | "justify";
  wrapText: boolean;
  shrinkToFit: boolean;
  indent: number;
  readingOrder: "rtl" | "ltr";
  textRotation: number | "vertical";
}

// ============================================================================
// Protection Types
// ============================================================================
export interface Protection {
  locked: boolean;
  hidden: boolean;
}

// ============================================================================
// Border Types
// ============================================================================
export type BorderStyle =
  | "thin"
  | "dotted"
  | "hair"
  | "medium"
  | "double"
  | "thick"
  | "dashed"
  | "dashDot"
  | "dashDotDot"
  | "slantDashDot"
  | "mediumDashed"
  | "mediumDashDotDot"
  | "mediumDashDot";

export interface Border {
  style: BorderStyle;
  color: Partial<Color>;
}

export interface BorderDiagonal extends Border {
  up: boolean;
  down: boolean;
}

export interface Borders {
  top: Partial<Border>;
  left: Partial<Border>;
  bottom: Partial<Border>;
  right: Partial<Border>;
  diagonal: Partial<BorderDiagonal>;
}

// ============================================================================
// Fill Types
// ============================================================================
export type FillPatterns =
  | "none"
  | "solid"
  | "darkVertical"
  | "darkHorizontal"
  | "darkGrid"
  | "darkTrellis"
  | "darkDown"
  | "darkUp"
  | "lightVertical"
  | "lightHorizontal"
  | "lightGrid"
  | "lightTrellis"
  | "lightDown"
  | "lightUp"
  | "darkGray"
  | "mediumGray"
  | "lightGray"
  | "gray125"
  | "gray0625";

export interface FillPattern {
  type: "pattern";
  pattern: FillPatterns;
  fgColor?: Partial<Color>;
  bgColor?: Partial<Color>;
}

export interface GradientStop {
  position: number;
  color: Partial<Color>;
}

export interface FillGradientAngle {
  type: "gradient";
  gradient: "angle";
  degree: number;
  stops: GradientStop[];
}

export interface FillGradientPath {
  type: "gradient";
  gradient: "path";
  center: { left: number; top: number };
  stops: GradientStop[];
}

export type Fill = FillPattern | FillGradientAngle | FillGradientPath;

// ============================================================================
// Style Type
// ============================================================================
export interface NumFmt {
  id: number;
  formatCode: string;
}

// Base style properties shared between input and output
interface StyleBase {
  font: Partial<Font>;
  alignment: Partial<Alignment>;
  protection: Partial<Protection>;
  border: Partial<Borders>;
  fill: Fill;
}

/**
 * A cell style.
 *
 * `numFmt` is a format-code string (`"#,##0.00"`) — both when you set it and
 * when you read it back, including from a parsed workbook (the reader resolves
 * `numFmtId` to its format code). The `NumFmt` arm exists because styles.xml
 * carries the `{ id, formatCode }` pair; it is accepted by the setters and by
 * the writer, but the library itself never stores one on a cell.
 */
export interface Style extends StyleBase {
  numFmt: string | NumFmt;
  /** Name of the workbook-level named cell style this cell references, if any. */
  styleName?: string;
}

// ============================================================================
// Named Cell Style Types
// ============================================================================

/**
 * A workbook-level named cell style (OOXML `cellStyle`), e.g. "Heading 1".
 * Named styles are defined once on the workbook and referenced by cells via
 * {@link Style.styleName}. They surface in the Excel "Cell Styles" gallery and
 * are used by accessibility software to identify document structure.
 *
 * All visual facets are optional; a named style may set only the properties it
 * needs (e.g. just a font). `numFmt` accepts a format-code string (the same
 * form as {@link Style.numFmt}).
 */
export interface NamedStyle {
  font?: Partial<Font>;
  alignment?: Partial<Alignment>;
  protection?: Partial<Protection>;
  border?: Partial<Borders>;
  fill?: Fill;
  numFmt?: string;
  /**
   * Built-in style id (OOXML `builtinId`). Set only by the built-in presets
   * (Heading 1 = 16, Title = 15, …); omit for fully custom styles.
   */
  builtinId?: number;
  /** Hidden from the Excel "Cell Styles" gallery. Preserved for round-trip. */
  hidden?: boolean;
  /** Marks a customised built-in style. Preserved for round-trip. */
  customBuiltin?: boolean;
  /** Outline level (RowLevel_/ColLevel_ styles). Preserved for round-trip. */
  iLevel?: number;
}

// ============================================================================
// Margins Types
// ============================================================================
export interface Margins {
  top: number;
  left: number;
  bottom: number;
  right: number;
  header: number;
  footer: number;
}

// ============================================================================
// Page Setup Types
// ============================================================================
export interface PageSetup {
  margins: Margins;
  orientation: string;
  horizontalDpi?: number;
  verticalDpi?: number;
  fitToPage: boolean;
  fitToWidth: number;
  fitToHeight: number;
  scale: number;
  pageOrder: string;
  blackAndWhite: boolean;
  draft: boolean;
  cellComments: string;
  errors: string;
  paperSize?: number;
  showRowColHeaders: boolean;
  showGridLines: boolean;
  firstPageNumber?: number;
  /** Whether the source explicitly enables `firstPageNumber`. */
  useFirstPageNumber?: boolean;
  horizontalCentered: boolean;
  verticalCentered: boolean;
  rowBreaks?: RowBreak[];
  printArea?: string;
  printTitlesRow?: string;
  printTitlesColumn?: string;
}

// ============================================================================
// Header Footer Types
// ============================================================================
export interface HeaderFooter {
  differentFirst: boolean;
  differentOddEven: boolean;
  /** Scale header/footer formatting with the printed document. OOXML default: true. */
  scaleWithDoc?: boolean;
  /** Align left/right header/footer sections with page margins. OOXML default: true. */
  alignWithMargins?: boolean;
  oddHeader: string | null;
  oddFooter: string | null;
  evenHeader: string | null;
  evenFooter: string | null;
  firstHeader: string | null;
  firstFooter: string | null;
}

// ============================================================================
// Worksheet View Types
// ============================================================================
export interface WorksheetViewCommon {
  rightToLeft?: boolean;
  activeCell?: string;
  showRuler?: boolean;
  showRowColHeaders?: boolean;
  showGridLines?: boolean;
  zoomScale?: number;
  zoomScaleNormal?: number;
}

export interface WorksheetViewNormal {
  state: "normal";
  style: "pageBreakPreview" | "pageLayout";
}

export interface WorksheetViewFrozen {
  state: "frozen";
  style?: "pageBreakPreview";
  xSplit?: number;
  ySplit?: number;
  topLeftCell?: string;
}

export interface WorksheetViewSplit {
  state: "split";
  style?: "pageBreakPreview" | "pageLayout";
  xSplit?: number;
  ySplit?: number;
  topLeftCell?: string;
  activePane?: "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
}

export type WorksheetView = WorksheetViewCommon &
  (WorksheetViewNormal | WorksheetViewFrozen | WorksheetViewSplit);

// ============================================================================
// Worksheet Properties Types
// ============================================================================
export interface WorksheetProperties {
  tabColor: Partial<Color>;
  /**
   * The sheet's VBA code name — how a macro refers to it, independent of its visible name.
   *
   * Optional because most sheets have none, and because a workbook with no VBA project has no use
   * for one. It matters when there *is* a project: the macros address sheets by this name, so a
   * read-modify-write that preserved `vbaProject.bin` and dropped the code names would produce a
   * workbook whose macros no longer resolve their own sheets.
   */
  codeName?: string;
  outlineLevelCol: number;
  outlineLevelRow: number;
  outlineProperties: {
    summaryBelow: boolean;
    summaryRight: boolean;
  };
  defaultRowHeight: number;
  defaultColWidth?: number;
  dyDescent?: number;
  showGridLines: boolean;
}

export type WorksheetState = "visible" | "hidden" | "veryHidden";

export type AutoFilter =
  | string
  | {
      from: string | { row: number; col: number };
      to: string | { row: number; col: number };
    };

export interface WorksheetProtection {
  objects: boolean;
  scenarios: boolean;
  selectLockedCells: boolean;
  selectUnlockedCells: boolean;
  formatCells: boolean;
  formatColumns: boolean;
  formatRows: boolean;
  insertColumns: boolean;
  insertRows: boolean;
  insertHyperlinks: boolean;
  deleteColumns: boolean;
  deleteRows: boolean;
  sort: boolean;
  autoFilter: boolean;
  pivotTables: boolean;
  spinCount: number;
}

// ============================================================================
// Workbook View Types
// ============================================================================
export interface WorkbookView {
  x: number;
  y: number;
  width: number;
  height: number;
  firstSheet: number;
  activeTab: number;
  visibility: string;
}

// ============================================================================
// Workbook Properties Types
// ============================================================================
export interface WorkbookProperties {
  date1904: boolean;
}

export interface WorkbookProtection {
  lockStructure: boolean;
  lockWindows: boolean;
  lockRevision: boolean;
  spinCount: number;
}

export interface CalculationProperties {
  fullCalcOnLoad: boolean;
  /** Enable iterative calculation for circular references */
  iterate?: boolean;
  /** Maximum number of iterations (default 100) */
  iterateCount?: number;
  /** Convergence threshold (default 0.001) */
  iterateDelta?: number;
}

// ============================================================================
// Cell Value Types
// ============================================================================
export interface CellErrorValue {
  error: ErrorValue;
}

export interface RichText {
  text: string;
  font?: Partial<Font>;
}

export interface CellRichTextValue {
  richText: RichText[];
}

export interface CellHyperlinkValue {
  /**
   * Plain-text display for the hyperlink. Always a string.
   *
   * When `richText` is also set, this field mirrors the concatenated
   * `.text` of every run in `richText` (flattened representation).
   */
  text: string;
  /**
   * Optional rich-text runs providing formatted display for the hyperlink.
   * When present, `text` must equal the concatenation of each run's `.text`.
   */
  richText?: RichText[];
  hyperlink: string;
  tooltip?: string;
}

/**
 * Input shape for assigning a hyperlink cell value.
 *
 * Accepts either:
 *   - a plain-text hyperlink (`text + hyperlink`), OR
 *   - a rich-text hyperlink (`richText + hyperlink`) — `text` is auto-derived
 *     by flattening the runs, so callers do not have to repeat it.
 *
 * The output shape (`CellHyperlinkValue` returned from `cell.value`) always
 * has `text: string` populated.
 */
export type CellHyperlinkValueInput =
  | {
      text: string;
      richText?: RichText[];
      hyperlink: string;
      tooltip?: string;
    }
  | {
      text?: string;
      richText: RichText[];
      hyperlink: string;
      tooltip?: string;
    };

/**
 * Input shape for assigning a formula cell that also carries a hyperlink.
 *
 * Loaded workbooks may present a formula cell with an attached hyperlink
 * (e.g. `=HYPERLINK(...)` style or a `<hyperlink ref="..."/>` entry pointing
 * at a formula cell). On the public surface such cells are classified as
 * Hyperlink (`cell.type === ValueType.Hyperlink`) with the formula's result
 * as display text, while `cell.model.formula` is preserved for round-trip.
 *
 * Use this shape to construct that combination directly without going
 * through `cell.model`.
 */
export interface CellFormulaHyperlinkValue {
  formula: string;
  result?: number | string | boolean | Date | CellErrorValue;
  hyperlink: string;
  tooltip?: string;
}

export interface CellFormulaValue {
  formula: string;
  result?: number | string | boolean | Date | CellErrorValue;
  date1904?: boolean;
}

/** Array formula that spans multiple cells */
export interface CellArrayFormulaValue {
  formula: string;
  result?: number | string | boolean | Date | CellErrorValue;
  /** Must be "array" for array formulas */
  shareType: "array";
  /** The range this array formula applies to, e.g. "A1:B2" */
  ref: string;
  /**
   * Mark this as an Excel 365 dynamic array formula (FILTER, SORT, UNIQUE, etc.).
   * Dynamic array formulas differ from legacy CSE (Ctrl+Shift+Enter) array formulas:
   * - The `ref` typically points to the formula cell itself (spill is dynamic)
   * - Excel writes a `cm` attribute on the `<c>` element linking to `xl/metadata.xml`
   * - The metadata marks the formula with `<xda:dynamicArrayProperties fDynamic="1"/>`
   */
  isDynamicArray?: boolean;
}

export interface CellSharedFormulaValue {
  sharedFormula: string;
  readonly formula?: string;
  result?: number | string | boolean | Date | CellErrorValue;
  date1904?: boolean;
}

export interface CellCheckboxValue {
  /** Indicates this is a checkbox value */
  checkbox: boolean;
}

export type CellValue =
  | null
  | number
  | string
  | boolean
  | Date
  | undefined
  | CellErrorValue
  | CellRichTextValue
  | CellHyperlinkValue
  | CellFormulaValue
  | CellArrayFormulaValue
  | CellSharedFormulaValue
  | CellCheckboxValue;

/**
 * Input variant of {@link CellValue} used when assigning to `cell.value`.
 *
 * Accepts the same shapes as `CellValue` plus more permissive forms that
 * the runtime normalizes:
 *   - `CellHyperlinkValueInput` — rich-text hyperlinks may omit `text`
 *     (it will be derived from `richText`).
 *   - `CellFormulaHyperlinkValue` — formula cells may carry a `hyperlink`.
 *
 * `cell.value` (the getter) still returns the canonical `CellValue` shape.
 */
export type CellValueInput =
  | null
  | number
  | string
  | boolean
  | Date
  // The three civil Temporal types, which say what a `Date` cannot: whether the value is a date, a time or
  // both. Added to the *input* union only — `CellValue`, what a read returns, is deliberately unchanged, so no
  // exhaustive `switch` over a cell value can break and no consumer has to have Temporal to compile. Each
  // resolves to `never` where the consumer's `lib` lacks `esnext.temporal`, which removes the member rather
  // than producing an error in a declaration file they did not write. See `@excel/core/temporal`.
  | TemporalPlainValue
  | undefined
  | CellErrorValue
  | CellRichTextValue
  | CellHyperlinkValueInput
  | CellFormulaValue
  | CellArrayFormulaValue
  | CellSharedFormulaValue
  | CellCheckboxValue
  | CellFormulaHyperlinkValue;

// ============================================================================
// Comment Types
// ============================================================================
export interface CommentMargins {
  insetmode: "auto" | "custom";
  inset: number[];
}

export interface CommentProtection {
  locked: "True" | "False";
  lockText: "True" | "False";
}

export type CommentEditAs = "twoCells" | "oneCells" | "absolute";

export interface Comment {
  texts?: RichText[];
  margins?: Partial<CommentMargins>;
  protection?: Partial<CommentProtection>;
  editAs?: CommentEditAs;
  /**
   * Office 365 threaded-comment conversation anchored at the same
   * cell. When present, Excel surfaces the modern reply UI; the
   * classic VML note still renders as a fallback for older viewers.
   *
   * The first entry in the list is the top-level comment; subsequent
   * entries with `parentId === first.id` are replies to it. Nested
   * threads beyond two levels are not supported by Excel itself.
   */
  threadedComments?: ThreadedComment[];
}

/**
 * A single entry in a threaded-comment conversation
 * (`xl/threadedComments/threadedComment{N}.xml` →
 * `<threadedComment ref="…" personId="…" id="…" parentId="…">`).
 *
 * `id` is a GUID-braced string Excel expects to uniquely identify the
 * comment within the sheet; callers may omit it and let the writer
 * synthesise one. `personId` must reference an entry in the
 * workbook-level {@link ThreadedCommentPerson} list — the writer
 * enforces this by adding any dangling `personId` to the list with a
 * placeholder displayName.
 */
export interface ThreadedComment {
  /** `{GUID}`-style id; auto-generated if absent. */
  id?: string;
  /**
   * Id of the parent comment when this entry is a reply. Absent for
   * top-level comments.
   */
  parentId?: string;
  /** Reference to the author in the workbook persons list. */
  personId: string;
  /** Creation timestamp as an ISO-8601 string. */
  date?: string;
  /** Plain-text body. @mentions are expressed separately via {@link mentions}. */
  text: string;
  /**
   * Structured `@mention` markers inside `text`. `startIndex`/`length`
   * point at the substring Excel shows as a clickable mention.
   */
  mentions?: ThreadedCommentMention[];
  /**
   * Whether Excel marks this comment as "resolved". Corresponds to
   * `done="1"` on the commentExt element. When undefined, Excel treats
   * the thread as open.
   */
  done?: boolean;
}

export interface ThreadedCommentMention {
  mentionId?: string;
  mentionPersonId: string;
  startIndex: number;
  length: number;
}

/**
 * Workbook-level person directory referenced by threaded comments.
 * Written as `xl/persons/person.xml`; one `<person>` element per
 * unique commenter.
 */
export interface ThreadedCommentPerson {
  /** `{GUID}`-style id referenced by `threadedComment/@personId`. */
  id: string;
  /** Display name shown in the UI (e.g. "Jane Doe"). */
  displayName: string;
  /** Provider user id (e.g. "jane@example.com", "S-1-5-…"). */
  userId?: string;
  /**
   * Identity provider — "AD" (Active Directory), "PeoplePicker",
   * "None". Excel preserves unknown values verbatim.
   */
  providerId?: string;
}

// ============================================================================
// Data Validation Types
// ============================================================================
export type DataValidationOperator =
  | "between"
  | "notBetween"
  | "equal"
  | "notEqual"
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqual"
  | "lessThanOrEqual";

/** Base properties shared by all data validation types */
interface DataValidationBase {
  allowBlank?: boolean;
  error?: string;
  errorTitle?: string;
  errorStyle?: string;
  prompt?: string;
  promptTitle?: string;
  showErrorMessage?: boolean;
  showInputMessage?: boolean;
}

/** Data validation that requires formulae and operator */
export interface DataValidationWithFormulae extends DataValidationBase {
  type: "list" | "whole" | "decimal" | "date" | "textLength" | "custom";
  formulae: (string | number | Date)[];
  operator?: DataValidationOperator;
}

/** Data validation type 'any' - no formulae needed */
export interface DataValidationAny extends DataValidationBase {
  type: "any";
}

export type DataValidationRule = DataValidationWithFormulae | DataValidationAny;

// ============================================================================
// Image Types
// ============================================================================
export interface ImageData {
  extension: "jpeg" | "png" | "gif";
  base64?: string;
  filename?: string;
  buffer?: Uint8Array;
  /**
   * Reference the image as an **external link** instead of embedding its bytes.
   *
   * When set (and `buffer`/`base64`/`filename` are all omitted), the image is
   * written as a linked DrawingML picture (`<a:blip r:link>`) whose relationship
   * uses `TargetMode="External"`. No bytes are stored in the `.xlsx` package, so
   * the file size stays small. The value may be either:
   *
   * - an absolute/relative URL (e.g. `"https://example.com/logo.png"`), or
   * - a local file path (e.g. `"file:///C:/images/logo.png"` or `"images/logo.png"`).
   *
   * Note: Excel treats linked images as volatile — a moved/missing target shows a
   * broken-image placeholder, and modern Excel may not auto-load remote URLs for
   * security reasons. Use embedding (`buffer`/`base64`) when self-contained files
   * are required.
   */
  link?: string;
  /**
   * Attach a scalable SVG alongside a raster fallback.
   *
   * Excel stores SVG pictures as a raster `a:blip` (the `extension`/`buffer`/
   * `base64`/`filename` on this object — typically a PNG) plus an
   * `asvg:svgBlip` extension pointing at the vector data. The raster image is
   * what older Excel versions and non-SVG consumers render, so it is required;
   * modern Excel renders the crisp SVG. This library does **not** rasterize —
   * you supply both the SVG bytes and the raster fallback you want embedded.
   */
  svg?: {
    /** SVG bytes (mutually use one of buffer/base64/filename). */
    buffer?: Uint8Array;
    /** Base64-encoded SVG. */
    base64?: string;
    /** Path to an `.svg` file (Node only). */
    filename?: string;
  };
}

/** Anchor position for image placement */
export interface ImageAnchor {
  col: number;
  row: number;
  nativeCol?: number;
  nativeRow?: number;
  nativeColOff?: number;
  nativeRowOff?: number;
}

/** Range input for addImage - can be a string like "A1:B2" or an object */
export type AddImageRange =
  | string
  | {
      /** Top-left anchor position */
      tl: ImageAnchor | string;
      /** Bottom-right anchor position (optional if ext is provided) */
      br?: ImageAnchor | string;
      /** Image dimensions (alternative to br) */
      ext?: { width: number; height: number };
      /** How the image behaves when cells are resized */
      editAs?: "oneCell" | "twoCell" | "absolute";
      /** Hyperlink for the image */
      hyperlinks?: { hyperlink?: string; tooltip?: string };
    }
  | {
      /** Absolute position in pixels — mutually exclusive with tl/br. */
      pos: { x: number; y: number };
      /** Image dimensions in pixels (required for absolute positioning). */
      ext: { width: number; height: number };
      /** Hyperlink for the image */
      hyperlinks?: { hyperlink?: string; tooltip?: string };
    };

// ============================================================================
// Shape Types
// ============================================================================

/**
 * Preset geometry for a drawing shape. Mirrors the OOXML `prst` vocabulary;
 * the most common presets are surfaced here, but any valid preset name is
 * accepted as a fallback `string`.
 */
export type ShapeType =
  | "rect"
  | "roundRect"
  | "ellipse"
  | "triangle"
  | "line"
  | "rightArrow"
  | "leftArrow"
  | "upArrow"
  | "downArrow"
  | "diamond"
  | "hexagon"
  | "star5"
  | (string & {});

/** Options for `Worksheet.addShape`. */
export interface AddShapeOptions {
  /** Preset geometry (defaults to `"rect"`). */
  type?: ShapeType;
  /** Where the shape sits — a cell range (e.g. `"B2:D5"`) or anchor object. */
  range: AddImageRange;
  /** Solid fill colour as hex RGB (e.g. `"FF0000"`). Omit for no fill. */
  fillColor?: string;
  /** Outline colour as hex RGB (e.g. `"000000"`). */
  lineColor?: string;
  /** Outline width in points. */
  lineWidth?: number;
  /** Optional centred text label. */
  text?: string;
  /** Display name (defaults to `"Shape N"`). */
  name?: string;
}

/** Internal serialized model for a worksheet shape. */
export interface ShapeModel {
  type: "shape";
  shapeType: string;
  range: AddImageRange;
  fillColor?: string;
  lineColor?: string;
  lineWidth?: number;
  text?: string;
  name?: string;
  /**
   * Resolved anchor coordinates, filled in by the worksheet model getter so
   * the serializer doesn't need range-parsing logic. Mirrors the three image
   * anchoring modes: two-cell (`tl`+`br`), one-cell (`tl`+`ext`) and absolute
   * (`pos`+`ext`). Internal only.
   */
  anchorRange?: {
    tl: { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number };
    br?: { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number };
    ext?: { width?: number; height?: number };
    pos?: { x: number; y: number };
    editAs?: string;
  };
}

// ============================================================================
// Watermark Types
// ============================================================================

/**
 * Watermark placement mode in the Excel worksheet.
 *
 * - `"overlay"` — Places the watermark image as a DrawingML picture on top of cells.
 *   Visible on screen AND when printed. Supports transparency via `<a:alphaModFix>`.
 *   Users can move/delete the watermark unless the sheet is protected.
 *
 * - `"header"` — Places the watermark image in the page header using VML.
 *   Renders behind cell content. Visible in Page Layout view and Print Preview.
 *   Cannot be accidentally moved/deleted. The standard "true watermark" approach.
 */
export type WatermarkMode = "overlay" | "header";

/**
 * Options for adding a watermark to a worksheet.
 *
 * @example Overlay watermark (visible on screen + prints):
 * ```typescript
 * const imgId = workbook.addImage({ buffer: pngData, extension: "png" });
 * worksheet.addWatermark({
 *   imageId: imgId,
 *   mode: "overlay",
 *   opacity: 0.15
 * });
 * ```
 *
 * @example Header watermark (behind content, prints correctly):
 * ```typescript
 * const imgId = workbook.addImage({ buffer: pngData, extension: "png" });
 * worksheet.addWatermark({
 *   imageId: imgId,
 *   mode: "header"
 * });
 * ```
 *
 * @example Footer image in the right-hand section:
 * ```typescript
 * worksheet.addWatermark({ imageId: imgId, mode: "header", position: "RF" });
 * ```
 *
 * In `"header"` mode the call updates `worksheet.headerFooter` immediately:
 * the `&G` image placeholder is written into the fields selected by
 * `position` and `applyTo`, and `differentOddEven` / `differentFirst` are set
 * when those page types are targeted. `removeWatermark()` strips the
 * placeholder again, and repeated `addWatermark()` calls replace the previous
 * image (and its placeholder) rather than accumulating.
 */
export interface WatermarkOptions {
  /** Image ID obtained from `workbook.addImage()`. */
  imageId: string | number;
  /**
   * Watermark placement mode.
   * @default "overlay"
   */
  mode?: WatermarkMode;
  /**
   * Opacity for overlay mode (0 = fully transparent, 1 = fully opaque).
   * Expressed as a percentage in OOXML (e.g. 0.15 = 15000 out of 100000).
   * Only applies to `"overlay"` mode. In `"header"` mode, transparency
   * must be baked into the image itself (use a PNG with alpha channel).
   * @default 0.15
   */
  opacity?: number;
  /**
   * Image width in points (for "header" mode VML rendering).
   * @default 467.25
   */
  headerWidth?: number;
  /**
   * Image height in points (for "header" mode VML rendering).
   * @default 311.25
   */
  headerHeight?: number;
  /**
   * Which header sections to apply the watermark to (only for "header" mode).
   *
   * - `"all"` — applies to oddHeader, evenHeader, and firstHeader
   * - `"odd"` — applies only to oddHeader (standard pages)
   * - `"even"` — applies only to evenHeader
   * - `"first"` — applies only to firstHeader
   *
   * @default "odd" — when odd/even and first-page variants are disabled,
   * the standard odd field is the shared header/footer for every page.
   */
  applyTo?: "all" | "odd" | "even" | "first";
  /**
   * Which header/footer section the image occupies (only for `"header"` mode).
   *
   * Excel defines six header/footer image sections:
   * `"LH"`/`"CH"`/`"RH"` for the left/centre/right header and
   * `"LF"`/`"CF"`/`"RF"` for the left/centre/right footer. The chosen section
   * decides both the VML shape id and which field receives the `&G`
   * placeholder — a footer position writes into `oddFooter`/`evenFooter`/
   * `firstFooter` rather than the header fields.
   *
   * This convenience API manages one watermark image at a time; calling it
   * again replaces the previous API-owned watermark, and targeting a section
   * that already holds an image replaces that occupant.
   *
   * For per-section control — including images loaded from an existing
   * workbook — use the `HeaderFooterImage` namespace (`set` / `list` /
   * `remove`), which addresses all six sections independently.
   *
   * @default "CH"
   */
  position?: HeaderFooterImagePosition;
}

/** Excel header/footer image sections (left/centre/right × header/footer). */
export type HeaderFooterImagePosition = "LH" | "CH" | "RH" | "LF" | "CF" | "RF";

// ============================================================================
// Location and Address Types
// ============================================================================
export type Location = {
  top: number;
  left: number;
  bottom: number;
  right: number;
};

/**
 * A decoded cell address: the A1 string plus its resolved 1-based row/column,
 * optionally qualified by sheet name. This is what `colCache.decodeAddress`
 * produces and what `Cell.getFullAddress` / `Range.containsCell` speak.
 */
export type DecodedAddress = {
  sheetName?: string;
  address: string;
  col: number;
  row: number;
  $col$row?: string;
};

// ============================================================================
// Row and Column Types
// ============================================================================
/**
 * A keyed row: every column's `key` (set via `Worksheet.setColumns` or
 * `Column.setKey`) is looked up on this object, so only the keyed properties are
 * read. Dotted keys (`"address.city"`) walk nested objects.
 *
 * Declared `object` rather than `Record<string, unknown>` on purpose: a TS
 * `interface` (and any generic `T extends object`) has no index signature, so
 * `Record<string, unknown>` would reject every domain type and force callers to
 * write `rows as Record<string, unknown>[]`.
 */
export type RowObject = object;

/**
 * Row data: either positional cell values, or a {@link RowObject} consumed by
 * the column keys. Nested values are read as `unknown` because column keys may
 * be dotted paths (e.g. `address.city`) that `resolveColumnKeyValue` walks
 * before the leaf is coerced to a cell value.
 */
export type RowValues = CellValue[] | RowObject | undefined | null;

// ============================================================================
// Conditional Formatting Types
// ============================================================================
export type CellIsOperators = "equal" | "greaterThan" | "lessThan" | "between";

export type ContainsTextOperators =
  | "containsText"
  | "containsBlanks"
  | "notContainsBlanks"
  | "containsErrors"
  | "notContainsErrors";

export type TimePeriodTypes =
  | "lastWeek"
  | "thisWeek"
  | "nextWeek"
  | "yesterday"
  | "today"
  | "tomorrow"
  | "last7Days"
  | "lastMonth"
  | "thisMonth"
  | "nextMonth";

export type IconSetTypes =
  | "5Arrows"
  | "5ArrowsGray"
  | "5Boxes"
  | "5Quarters"
  | "5Rating"
  | "4Arrows"
  | "4ArrowsGray"
  | "4Rating"
  | "4RedToBlack"
  | "4TrafficLights"
  | "NoIcons"
  | "3Arrows"
  | "3ArrowsGray"
  | "3Flags"
  | "3Signs"
  | "3Stars"
  | "3Symbols"
  | "3Symbols2"
  | "3TrafficLights1"
  | "3TrafficLights2"
  | "3Triangles";

export type CfvoTypes =
  | "percentile"
  | "percent"
  | "num"
  | "min"
  | "max"
  | "formula"
  | "autoMin"
  | "autoMax";

export interface Cfvo {
  type: CfvoTypes;
  value?: number | string;
}

export interface ConditionalFormattingBaseRule {
  priority?: number;
  style?: Partial<Style>;
}

export interface ExpressionRuleType extends ConditionalFormattingBaseRule {
  type: "expression";
  formulae?: (string | number)[];
}

export interface CellIsRuleType extends ConditionalFormattingBaseRule {
  type: "cellIs";
  formulae?: (string | number)[];
  operator?: CellIsOperators;
}

export interface Top10RuleType extends ConditionalFormattingBaseRule {
  type: "top10";
  rank: number;
  percent: boolean;
  bottom?: boolean;
}

export interface AboveAverageRuleType extends ConditionalFormattingBaseRule {
  type: "aboveAverage";
  aboveAverage?: boolean;
}

export interface ColorScaleRuleType extends ConditionalFormattingBaseRule {
  type: "colorScale";
  cfvo?: Cfvo[];
  color?: Partial<Color>[];
}

export interface IconSetRuleType extends ConditionalFormattingBaseRule {
  type: "iconSet";
  showValue?: boolean;
  reverse?: boolean;
  custom?: boolean;
  iconSet?: IconSetTypes;
  cfvo?: Cfvo[];
}

export interface ContainsTextRuleType extends ConditionalFormattingBaseRule {
  type: "containsText";
  operator?: ContainsTextOperators;
  text?: string;
}

export interface TimePeriodRuleType extends ConditionalFormattingBaseRule {
  type: "timePeriod";
  timePeriod?: TimePeriodTypes;
}

export interface DataBarRuleType extends ConditionalFormattingBaseRule {
  type: "dataBar";
  gradient?: boolean;
  minLength?: number;
  maxLength?: number;
  showValue?: boolean;
  border?: boolean;
  negativeBarColorSameAsPositive?: boolean;
  negativeBarBorderColorSameAsPositive?: boolean;
  axisPosition?: "auto" | "middle" | "none";
  direction?: "context" | "leftToRight" | "rightToLeft";
  cfvo?: Cfvo[];
  color?: Partial<Color>;
  negativeFillColor?: Partial<Color>;
  borderColor?: Partial<Color>;
  negativeBorderColor?: Partial<Color>;
  axisColor?: Partial<Color>;
}

export type ConditionalFormattingRule =
  | ExpressionRuleType
  | CellIsRuleType
  | Top10RuleType
  | AboveAverageRuleType
  | ColorScaleRuleType
  | IconSetRuleType
  | ContainsTextRuleType
  | TimePeriodRuleType
  | DataBarRuleType;

export interface ConditionalFormattingOptions {
  ref: string;
  rules: ConditionalFormattingRule[];
}

// ============================================================================
// Table Types
// ============================================================================
export interface TableStyleProperties {
  theme?: string;
  showFirstColumn?: boolean;
  showLastColumn?: boolean;
  showRowStripes?: boolean;
  showColumnStripes?: boolean;
}

export interface TableColumnProperties {
  name: string;
  filterButton?: boolean;
  totalsRowLabel?: string;
  totalsRowFunction?:
    | "none"
    | "average"
    | "countNums"
    | "count"
    | "max"
    | "min"
    | "stdDev"
    | "var"
    | "sum"
    | "custom";
  totalsRowFormula?: string;
  totalsRowResult?: CellFormulaValue["result"];
  /**
   * Formula applied to every data row in this column.
   * Corresponds to the OOXML `<calculatedColumnFormula>` element.
   */
  calculatedColumnFormula?: string;
  style?: Partial<Style>;
}

export interface TableProperties {
  name: string;
  displayName?: string;
  ref: string;
  headerRow?: boolean;
  totalsRow?: boolean;
  /**
   * When true, expands implicit structured references like [@A] to
   * TableName[[#This Row],[A]] when storing table row formulas.
   *
   * Default: false (keeps formulas as provided, e.g. [@A]).
   */
  qualifyImplicitStructuredReferences?: boolean;
  style?: TableStyleProperties;
  columns: TableColumnProperties[];
  /**
   * Table data rows. Each row is an array of cell values aligned with
   * `columns`. A cell may be any `CellValue` (scalars, dates, rich text,
   * hyperlinks, error values, ...) or a `CellFormulaValue` when the cell
   * stores a formula.
   */
  rows: Array<Array<CellValue | CellFormulaValue>>;
}

// ============================================================================
// Worksheet Options
// ============================================================================
export interface AddWorksheetOptions {
  properties?: Partial<WorksheetProperties>;
  pageSetup?: Partial<PageSetup>;
  headerFooter?: Partial<HeaderFooter>;
  views?: Array<Partial<WorksheetView>>;
  state?: WorksheetState;
  /** Specifies whether to use shared strings. Overrides workbook setting. */
  useSharedStrings?: boolean;
  /** Apply an auto filter to the worksheet */
  autoFilter?: AutoFilter;
}

// ============================================================================
// Row Break Types
// ============================================================================
export interface RowBreak {
  id: number;
  max: number;
  min?: number;
  man: number;
}

// ============================================================================
// Column Break Types
// ============================================================================
export interface ColBreak {
  id: number;
  max: number;
  min?: number;
  man: number;
}

// ============================================================================
// Ignored Error Types
// ============================================================================
export interface IgnoredError {
  /** Cell reference range, e.g. "A1:B10" or "A1:XFD1048576" */
  ref: string;
  /** Ignore "Number Stored as Text" errors (green triangle) */
  numberStoredAsText?: boolean;
  /** Ignore formula errors */
  formula?: boolean;
  /** Ignore formula range errors */
  formulaRange?: boolean;
  /** Ignore unlocked formula errors */
  unlockedFormula?: boolean;
  /** Ignore empty cell reference errors */
  emptyCellReference?: boolean;
  /** Ignore list data validation errors */
  listDataValidation?: boolean;
  /** Ignore calculated column errors */
  calculatedColumn?: boolean;
  /** Ignore eval errors */
  evalError?: boolean;
  /** Ignore two-digit text year errors */
  twoDigitTextYear?: boolean;
}
