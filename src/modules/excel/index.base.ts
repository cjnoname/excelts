/**
 * documonster/excel — base exports (platform independent).
 *
 * Shared domain dot-namespaces + error classes for both the Node and browser
 * entries. The two platform-specific namespaces (`Workbook`, `Stream`) are
 * NOT here — each entry (`index.ts` / `index.browser.ts`) re-exports this base
 * and then adds its own platform variant of those two. Mirrors the word
 * module's `index.base.ts` structure.
 *
 *   import { Workbook, Worksheet, Cell, Chart } from "documonster/excel";
 *   const wb = Workbook.create();
 *   const ws = Workbook.addWorksheet(wb, "Sheet1");
 *   Cell.setValue(ws, "A1", 42);
 *   const buf = await Workbook.toBuffer(wb);
 *
 * Each namespace is an ESM namespace re-export over a physical `surface/*.ts`
 * module of flat functions, which tree-shakes per-member on rolldown / rspack.
 *
 * The public **types** are exported flat, under their declared names — see the
 * "Public types" section below and the "Types" section of the module README.
 */

// --- Domain namespaces (platform-independent) ---
export * as Worksheet from "@excel/surface/worksheet";
export * as Cell from "@excel/surface/cell";
export * as Row from "@excel/surface/row";
export * as Column from "@excel/surface/column";
export * as Range from "@excel/surface/range";
export * as Chart from "@excel/surface/chart";
export * as Table from "@excel/surface/table";
export * as Image from "@excel/surface/image";
export * as Pivot from "@excel/surface/pivot";
export * as Sparkline from "@excel/surface/sparkline";
export * as Form from "@excel/surface/form";
export * as Chartsheet from "@excel/surface/chartsheet";
export * as DataValidation from "@excel/surface/data-validation";
export * as DefinedNames from "@excel/surface/defined-names";
export * as Note from "@excel/surface/note";
export * as Address from "@excel/surface/address";
export * as Anchor from "@excel/surface/anchor";
export * as Watermark from "@excel/surface/watermark";
export * as HeaderFooterImage from "@excel/surface/header-footer-image";
export * as Format from "@excel/surface/format";

export type {
  XlsbInputStream,
  XlsbReadable,
  XlsbWritable,
  XlsbReadOptions,
  XlsbStreamOptions,
  XlsbWriteOptions
} from "@excel/core/xlsb-io";

// ---------------------------------------------------------------------------
// Public types (platform-independent)
//
// Flat, declared-name re-exports — the same convention every other module uses
// (`word`, `csv`, `xml`, `archive`, `pdf`, `stream`): a type has exactly one
// public name, and it is the name TypeScript prints in errors and hovers.
//
// The one deliberate exception is handles. Where a namespace already publishes
// a `Handle` alias (`Worksheet.Handle`, `Workbook.Handle`, `Table.Handle`, …)
// that alias IS the public name, so the underlying `WorksheetData` /
// `WorkbookData` / … interfaces are not re-exported here — a second name for
// the same type would be worse than none. Cell / row / column handles have no
// such alias, so their declared names are public (see below).
//
// The two platform-specific groups (workbook IO / streaming option types) are
// added by `index.ts` and `index.browser.ts`, next to their namespaces.
// ---------------------------------------------------------------------------

// Style vocabulary — `Cell.setStyle`, `Row.setStyle`, `Column.setStyle`,
// `Table` column styles and `Workbook.defineCellStyle` all speak these.
export type {
  Style,
  Alignment,
  Border,
  BorderDiagonal,
  BorderStyle,
  Borders,
  Color,
  Fill,
  FillGradientAngle,
  FillGradientPath,
  FillPattern,
  FillPatterns,
  Font,
  GradientStop,
  NamedStyle,
  NumFmt,
  Protection,
  RichText
} from "@excel/types";
export type { NamedStyleEntry } from "@excel/core/workbook-core";
/** Recursively `readonly` view of a type — see `ColumnView` / `CellView`. */
export type { DeepReadonly } from "@utils/types";
export type { BuiltinCellStyle } from "@excel/core/builtin-cell-styles";

// Cell values — what `Cell.getValue` returns and `Cell.setValue` accepts.
export type {
  CellValue,
  CellValueInput,
  CellArrayFormulaValue,
  CellCheckboxValue,
  CellErrorValue,
  CellFormulaHyperlinkValue,
  CellFormulaValue,
  CellHyperlinkValue,
  CellHyperlinkValueInput,
  CellRichTextValue,
  CellSharedFormulaValue
} from "@excel/types";
// `CellData` / `RowData` / `ColumnData` are the cell/row/column handles. Unlike
// the other handles they have no `X.Handle` alias, so the declared name is the
// public one. Handles that DO have one (`Worksheet.Handle`, `Workbook.Handle`,
// `Table.Handle`, …) are deliberately NOT re-exported flat: one type, one name.
export type {
  CellData,
  CellModel,
  CellValueType,
  CellValueInputType,
  CellView,
  FormulaResult
} from "@excel/core/cell";
/**
 * The cell-value kinds (`Cell.getType` / `Cell.getEffectiveType`), the formula
 * kinds (`CellModel.formulaType`) and the Excel error strings. Each is a plain
 * constant lookup object that doubles as its own type, so `ValueType.Number`
 * works as a value and `ValueType` as a type — and each tree-shakes away when
 * unused (unlike a TS `enum`, which cannot be eliminated).
 */
export { ValueType, FormulaType, ErrorValue } from "@excel/core/enums";
/** Convenience OOXML paper-size codes for `PageSetup.paperSize`. */
export { PaperSize } from "@excel/types";

// Rows and columns.
export type { RowObject, RowValues } from "@excel/types";
export type { RowData, RowModel } from "@excel/core/row";
export type {
  ColumnData,
  ColumnDefn,
  ColumnHeaderValue,
  ColumnModel,
  ColumnView
} from "@excel/core/column";

// Addresses and ranges.
export type { DecodedAddress } from "@excel/types";
export type { CellAddress, Origin, SheetRange } from "@excel/utils/address";
export type { DecodedRange } from "@excel/utils/col-cache";
export type { RangeInput } from "@excel/core/range";

// Worksheet-level structure.
export type {
  AutoFilter,
  ColBreak,
  HeaderFooter,
  IgnoredError,
  Location,
  Margins,
  PageSetup,
  RowBreak,
  WorksheetProperties,
  WorksheetProtection,
  WorksheetState,
  WorksheetView,
  WorksheetViewCommon,
  WorksheetViewFrozen,
  WorksheetViewNormal,
  WorksheetViewSplit
} from "@excel/types";
export type { AutoFilterCriteria, SheetProtection } from "@excel/core/worksheet-core";
export type {
  AddAOAOptions,
  AddJSONOptions,
  SheetToJSONOptions,
  WorksheetModel
} from "@excel/core/worksheet";

// Conditional formatting — `Worksheet.addConditionalFormatting`.
export type {
  AboveAverageRuleType,
  CellIsOperators,
  CellIsRuleType,
  Cfvo,
  CfvoTypes,
  ColorScaleRuleType,
  ConditionalFormattingBaseRule,
  ConditionalFormattingOptions,
  ConditionalFormattingRule,
  ContainsTextOperators,
  ContainsTextRuleType,
  DataBarRuleType,
  ExpressionRuleType,
  IconSetRuleType,
  IconSetTypes,
  TimePeriodRuleType,
  TimePeriodTypes,
  Top10RuleType
} from "@excel/types";

// Data validation.
export type {
  DataValidationAny,
  DataValidationOperator,
  DataValidationRule,
  DataValidationWithFormulae
} from "@excel/types";
export type { DataValidationModel } from "@excel/core/data-validations";

// Notes and comments.
export type {
  Comment,
  CommentEditAs,
  CommentMargins,
  CommentProtection,
  ThreadedComment,
  ThreadedCommentMention,
  ThreadedCommentPerson
} from "@excel/types";
export type { NoteConfig, NoteModel, NoteText } from "@excel/core/cell";

// Tables.
export type { TableColumnProperties, TableProperties, TableStyleProperties } from "@excel/types";
export type { TableColumnView, TableModel } from "@excel/core/table";

// Images, shapes, drawing anchors, watermarks.
export type {
  AddImageRange,
  AddShapeOptions,
  HeaderFooterImagePosition,
  ImageAnchor,
  ImageData,
  ShapeModel,
  ShapeType,
  WatermarkMode,
  WatermarkOptions
} from "@excel/types";
export type {
  BackgroundImageModel,
  HeaderImageModel,
  ImageAbsolutePosition,
  ImageExtent,
  ImageHyperlinks,
  ImageModel,
  ImageModelInput,
  ImageRange,
  ImageRangeInput,
  ImageRangeModel,
  PlacedImageModel,
  WatermarkImageModel
} from "@excel/core/image";
export type { AnchorInput, AnchorModel } from "@excel/core/anchor";
export type { HeaderFooterImageEntry, HeaderFooterImageOptions } from "@excel/core/worksheet";

// Defined names, form controls, sparklines, chartsheets.
export type { DefinedNameModel, SyntaxProbe } from "@excel/core/defined-names";
export type {
  CheckboxState,
  FormCheckboxModel,
  FormCheckboxOptions,
  FormControlAnchor,
  FormControlRange
} from "@excel/core/form-control";
export type {
  AddSparklineGroupOptions,
  SparklineAxisType,
  SparklineColor,
  SparklineGroup,
  SparklineItem,
  SparklineType
} from "@excel/core/sparkline";
export type {
  AddChartsheetOptions,
  AddPivotChartsheetOptions,
  ChartsheetModel,
  ChartsheetOptions,
  ChartsheetViewOptions
} from "@excel/core/chartsheet";
export type { ChartHandle } from "@excel/core/worksheet-core";

// Workbook-level (platform-independent parts).
export type {
  AddWorksheetOptions,
  CalculationProperties,
  WorkbookProperties,
  WorkbookProtection,
  WorkbookView
} from "@excel/types";
export type {
  XlsxReadOptions,
  XlsxWriteOptions,
  WorkbookFormat,
  WorkbookReadOptions,
  WorkbookWriteOptions,
  WorkbookStreamOptions
} from "@excel/core/xlsx-io";
export type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
export type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
export type {
  ExternalLinkCachedSheet,
  ExternalLinkModel,
  WorkbookMedia,
  WorkbookModel,
  WorkbookProtectionModel
} from "@excel/core/workbook.browser";
// Reachable from `WorkbookModel.opaqueParts` / `.opaqueDrops`, so a caller that
// inspects either needs to be able to name what it got back.
export type {
  OpaqueDrop,
  OpaqueDropReason,
  OpaquePart,
  OpaqueRelationship,
  OpaqueSourceRelationship
} from "@excel/core/opaque-part";

// --- Errors (extend BaseError; consistent with every other module's entry) ---
export {
  ExcelError,
  isExcelError,
  WorksheetNameError,
  InvalidAddressError,
  ColumnOutOfBoundsError,
  RowOutOfBoundsError,
  MergeConflictError,
  InvalidValueTypeError,
  XlsbParseError,
  ExcelNotSupportedError,
  ExcelFileError,
  ExcelStreamStateError,
  ExcelDownloadError,
  PivotTableError,
  ChartOptionsError,
  TableError,
  ImageError,
  MaxItemsExceededError
} from "@excel/errors";
