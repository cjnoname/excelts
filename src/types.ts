/**
 * Type definitions for ExcelTS
 * This file exports all public types used by the library
 */

import type { IAnchor } from "./doc/anchor.js";

// ============================================================================
// Buffer type for browser compatibility
// ============================================================================
export type Buffer = ArrayBuffer;

// ============================================================================
// Paper Size Enum
// ============================================================================
export enum PaperSize {
  Legal = 5,
  Executive = 7,
  A4 = 9,
  A5 = 11,
  B5 = 13,
  Envelope_10 = 20,
  Envelope_DL = 27,
  Envelope_C5 = 28,
  Envelope_B5 = 34,
  Envelope_Monarch = 37,
  Double_Japan_Postcard_Rotated = 82,
  K16_197x273_mm = 119
}

// ============================================================================
// Color Types
// ============================================================================
export interface Color {
  argb: string;
  theme: number;
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
export interface Style {
  numFmt: string;
  font: Partial<Font>;
  alignment: Partial<Alignment>;
  protection: Partial<Protection>;
  border: Partial<Borders>;
  fill: Fill;
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
  orientation: "portrait" | "landscape";
  horizontalDpi: number;
  verticalDpi: number;
  fitToPage: boolean;
  fitToWidth: number;
  fitToHeight: number;
  scale: number;
  pageOrder: "downThenOver" | "overThenDown";
  blackAndWhite: boolean;
  draft: boolean;
  cellComments: "atEnd" | "asDisplayed" | "None";
  errors: "dash" | "blank" | "NA" | "displayed";
  paperSize: PaperSize;
  showRowColHeaders: boolean;
  showGridLines: boolean;
  firstPageNumber: number;
  horizontalCentered: boolean;
  verticalCentered: boolean;
  printArea: string;
  printTitlesRow: string;
  printTitlesColumn: string;
}

// ============================================================================
// Header Footer Types
// ============================================================================
export interface HeaderFooter {
  differentFirst: boolean;
  differentOddEven: boolean;
  oddHeader: string;
  oddFooter: string;
  evenHeader: string;
  evenFooter: string;
  firstHeader: string;
  firstFooter: string;
}

// ============================================================================
// Worksheet View Types
// ============================================================================
export interface WorksheetViewCommon {
  rightToLeft: boolean;
  activeCell: string;
  showRuler: boolean;
  showRowColHeaders: boolean;
  showGridLines: boolean;
  zoomScale: number;
  zoomScaleNormal: number;
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
  outlineLevelCol: number;
  outlineLevelRow: number;
  outlineProperties: {
    summaryBelow: boolean;
    summaryRight: boolean;
  };
  defaultRowHeight: number;
  defaultColWidth?: number;
  dyDescent: number;
  showGridLines: boolean;
}

export type WorksheetState = "visible" | "hidden" | "veryHidden";

export type AutoFilter =
  | string
  | {
      from: string | { row: number; column: number };
      to: string | { row: number; column: number };
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

export interface CalculationProperties {
  fullCalcOnLoad: boolean;
}

// ============================================================================
// Cell Value Types
// ============================================================================
export interface CellErrorValue {
  error: "#N/A" | "#REF!" | "#NAME?" | "#DIV/0!" | "#NULL!" | "#VALUE!" | "#NUM!";
}

export interface RichText {
  text: string;
  font?: Partial<Font>;
}

export interface CellRichTextValue {
  richText: RichText[];
}

export interface CellHyperlinkValue {
  text: string;
  hyperlink: string;
  tooltip?: string;
}

export interface CellFormulaValue {
  formula: string;
  result?: number | string | boolean | Date | CellErrorValue;
  date1904?: boolean;
}

export interface CellSharedFormulaValue {
  sharedFormula: string;
  readonly formula?: string;
  result?: number | string | boolean | Date | CellErrorValue;
  date1904?: boolean;
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
  | CellSharedFormulaValue;

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

export interface DataValidation {
  type: "list" | "whole" | "decimal" | "date" | "textLength" | "custom";
  formulae: any[];
  allowBlank?: boolean;
  operator?: DataValidationOperator;
  error?: string;
  errorTitle?: string;
  errorStyle?: string;
  prompt?: string;
  promptTitle?: string;
  showErrorMessage?: boolean;
  showInputMessage?: boolean;
}

// ============================================================================
// Image Types
// ============================================================================
export interface Image {
  extension: "jpeg" | "png" | "gif";
  base64?: string;
  filename?: string;
  buffer?: Buffer;
}

export interface ImageRange {
  tl: IAnchor;
  br: IAnchor;
}

export interface ImagePosition {
  tl: { col: number; row: number };
  ext: { width: number; height: number };
}

export interface ImageHyperlinkValue {
  hyperlink: string;
  tooltip?: string;
}

// ============================================================================
// Location and Address Types
// ============================================================================
export type Location = {
  top: number;
  left: number;
  bottom: number;
  right: number;
};

export type Address = {
  sheetName?: string;
  address: string;
  col: number;
  row: number;
  $col$row: string;
};

// ============================================================================
// Row and Column Types
// ============================================================================
export type RowValues = CellValue[] | { [key: string]: CellValue } | undefined | null;

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

export interface Cvfo {
  type: CfvoTypes;
  value?: number;
}

export interface ConditionalFormattingBaseRule {
  priority: number;
  style?: Partial<Style>;
}

export interface ExpressionRuleType extends ConditionalFormattingBaseRule {
  type: "expression";
  formulae?: any[];
}

export interface CellIsRuleType extends ConditionalFormattingBaseRule {
  type: "cellIs";
  formulae?: any[];
  operator?: CellIsOperators;
}

export interface Top10RuleType extends ConditionalFormattingBaseRule {
  type: "top10";
  rank: number;
  percent: boolean;
  bottom: boolean;
}

export interface AboveAverageRuleType extends ConditionalFormattingBaseRule {
  type: "aboveAverage";
  aboveAverage: boolean;
}

export interface ColorScaleRuleType extends ConditionalFormattingBaseRule {
  type: "colorScale";
  cfvo?: Cvfo[];
  color?: Partial<Color>[];
}

export interface IconSetRuleType extends ConditionalFormattingBaseRule {
  type: "iconSet";
  showValue?: boolean;
  reverse?: boolean;
  custom?: boolean;
  iconSet?: IconSetTypes;
  cfvo?: Cvfo[];
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
  cfvo?: Cvfo[];
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
  style?: Partial<Style>;
}

export interface TableProperties {
  name: string;
  displayName?: string;
  ref: string;
  headerRow?: boolean;
  totalsRow?: boolean;
  style?: TableStyleProperties;
  columns: TableColumnProperties[];
  rows: any[][];
}

export type TableColumn = Required<TableColumnProperties>;

// ============================================================================
// XLSX Types
// ============================================================================
export interface JSZipGeneratorOptions {
  compression: "STORE" | "DEFLATE";
  compressionOptions: null | {
    level: number;
  };
}

export interface XlsxReadOptions {
  ignoreNodes?: string[];
  maxRows?: number;
  maxCols?: number;
}

export interface XlsxWriteOptions {
  zip?: Partial<JSZipGeneratorOptions>;
  useSharedStrings?: boolean;
  useStyles?: boolean;
}

// ============================================================================
// Media Types
// ============================================================================
export interface Media {
  type: string;
  name: string;
  extension: string;
  buffer: Buffer;
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
}

// ============================================================================
// Defined Names Types
// ============================================================================
export interface DefinedNamesRanges {
  name: string;
  ranges: string[];
}

export type DefinedNamesModel = DefinedNamesRanges[];

// ============================================================================
// Row Break Types
// ============================================================================
export interface RowBreak {
  id: number;
  max: number;
  min: number;
  man: number;
}
