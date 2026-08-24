/**
 * DOCX Module - Base Exports (Platform Independent)
 *
 * Shared exports for both Node.js and browser environments.
 *
 * Each export is annotated with a `@stability` tag:
 *
 * - `@stability stable` — Public API. Backwards-compatible changes only;
 *   semver-major bumps for any breaking changes.
 * - `@stability experimental` — Public but evolving. The shape may change
 *   without a major version bump while we collect feedback. Consumers
 *   should pin to exact minor versions if they rely on these.
 * - `@stability preserve-only` — Round-trip preservation types. They exist
 *   so reading and writing a DOCX is loss-less; the underlying schema is
 *   not yet promised to be ergonomic. Avoid building features on top of
 *   them unless you also handle the underlying OOXML directly.
 *
 * Tree-shakeable subpaths: HTML/Markdown/Excel/PDF integrations live under
 * `documonster/word/{html,markdown,excel}` and `documonster/pdf` — they are not
 * re-exported here so bundlers can drop them when unused.
 */

// --- Stable API ---
/** @stability stable */
export type {
  // Units
  HalfPoint,
  Twips,
  Emu,
  EighthPoint,
  HexColor,

  // Shading & Border enums
  ShadingType,
  BorderStyle,

  // Page & Section
  PageOrientation,
  PageSize,
  PageMargins,
  ColumnDef,
  SectionColumns,
  SectionBreakType,
  PageNumberFormat,
  HeaderFooterType,
  HeaderFooterRef,
  PageVerticalAlign,
  DocumentGridType,
  Border,
  ArtBorderType,
  PageBorders,
  SectionProperties,

  // Run
  UnderlineStyle,
  VerticalAlign,
  HighlightColor,
  FontSpec,
  Shading,
  UnderlineSpec,
  TextEffect,
  EmphasisMarkType,
  EastAsianCombineBrackets,
  EastAsianLayoutSpec,
  ColorSpec,
  RunProperties,

  // Run Content
  RunContent,
  TextContent,
  BreakContent,
  TabContent,
  PositionalTabContent,
  RubyContent,
  RubyAlign,
  RubyProperties,
  SymbolContent,
  FootnoteRefContent,
  EndnoteRefContent,
  FieldContent,
  InlineImageContent,
  CarriageReturnContent,
  NoBreakHyphenContent,
  SoftHyphenContent,
  LastRenderedPageBreakContent,
  AnnotationReferenceContent,
  PageNumberType,
  DateFieldContent,
  Run,

  // Track Changes
  RevisionInfo,
  InsertedRun,
  DeletedRun,
  MovedFromRun,
  MovedToRun,
  MoveRangeMarker,
  CustomXmlTrackingMarker,
  ParagraphPropertyChange,
  RunPropertyChange,
  SectionPropertyChange,
  TableRowRevision,

  // Comments
  CommentDef,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference,

  // Paragraph
  Alignment,
  LineSpacingRule,
  LineSpacing,
  Indentation,
  TabStopType,
  TabStopLeader,
  TabStop,
  PositionalTabAlignment,
  PositionalTabRelativeTo,
  PositionalTabLeader,
  ParagraphBorders,
  NumberingRef,
  FrameAnchorType,
  DropCapType,
  ParagraphFrame,
  ParagraphProperties,
  Paragraph,
  Hyperlink,
  BookmarkStart,
  BookmarkEnd,
  ParagraphChild,

  // Table
  TableWidth,
  TableBorders,
  TableCellMargins,
  TableLayout,
  TableLook,
  TableFloat,
  TableProperties,
  RowHeightRule,
  TableRowProperties,
  VerticalCellAlign,
  TextDirection,
  VerticalMerge,
  TableCellProperties,
  TableCell,
  TableRow,
  Table,

  // Floating Image
  HorizontalPositionRelative,
  VerticalPositionRelative,
  WrapStyle,
  WrapTextSide,
  WrapMargins,
  FloatingImage,

  // Drawing shapes
  DrawingShape,
  PresetShapeType,

  // Charts
  Chart,
  ChartType,
  ChartSeries,
  ChartLegendPosition,
  ChartAxis,
  ChartContent,
  ChartExContent,
  ChartExData,
  ChartExSeriesData,
  ChartTrendline,
  ChartTrendlineType,
  ChartErrorBars,
  ChartErrorBarDirection,
  ChartErrorBarType,
  ChartDataLabels,
  ChartDataLabelPosition,

  // Alt chunks (embedded HTML/RTF content)
  AltChunk,

  // Web settings & people (collaboration metadata)
  WebSettings,
  PersonInfo,

  // Notes type enum
  NoteType,
  FootnoteProperties,
  EndnoteProperties,
  NoteNumberFormat,
  NoteNumberRestart,

  // Table revision types
  TablePropertyChange,
  TableRowPropertyChange,
  TableCellPropertyChange,
  CellMergeRevision,

  // Document type
  DocxDocumentType,

  // TOC
  TableOfContents,

  // Math
  MathRun,
  MathFraction,
  MathSuperScript,
  MathSubScript,
  MathSubSuperScript,
  MathPreSubSuperScript,
  MathPhantom,
  MathGroupChar,
  MathBorderBox,
  MathRadical,
  MathDelimiter,
  MathNary,
  MathFunction,
  MathLimit,
  MathMatrix,
  MathAccent,
  MathBar,
  MathBox,
  MathEquationArray,
  MathContent,
  MathBlock,

  // TextBox
  TextBox,

  // CheckBox
  CheckBox,

  // SDT
  SdtListItem,
  SdtDateProperties,
  SdtProperties,
  SdtDataBinding,
  SdtCheckboxProperties,
  SdtRepeatingSectionProperties,
  StructuredDocumentTag,
  CustomXmlPart,

  // Form Fields
  FormFieldType,
  FormField,
  TextFormField,
  CheckBoxFormField,
  DropDownFormField,

  // Watermark
  Watermark,
  TextWatermark,
  ImageWatermark,

  // Body
  BodyContent,

  // Styles
  StyleType,
  TableStyleConditionType,
  TableStyleConditionalFormat,
  StyleDef,
  DocDefaults,

  // Numbering
  NumberFormat,
  LevelJustification,
  LevelSuffix,
  NumberingLevel,
  MultiLevelType,
  AbstractNumbering,
  LevelOverride,
  NumberingInstance,
  NumPicBullet,

  // Headers/Footers
  HeaderFooterContent,
  HeaderDef,
  FooterDef,

  // Footnotes/Endnotes
  FootnoteDef,
  EndnoteDef,

  // Images
  ImageMediaType,
  ImageDef,

  // Font Table
  FontFamily,
  FontPitch,
  FontDef,
  EmbeddedFont,

  // Settings
  ProtectionType,
  HyphenationSettings,
  DocumentSettings,
  CompatSetting,
  CompatFlag,

  // Document Background
  DocumentBackground,
  DocumentTheme,
  ThemeColorScheme,
  ThemeFontScheme,
  ThemeFont,
  ThemeFormatScheme,
  ThemeColorName,

  // Custom Properties
  CustomPropertyValue,
  CustomProperty,

  // Core/App Properties
  CoreProperties,
  AppProperties,

  // Document
  DocxDocument,
  DocxOptions
} from "@word/types";

// --- Preserve-only API (round-trip preservation, no full editing support) ---
/** @stability preserve-only */
export type {
  OpaquePart,
  OpaqueRelationship,
  OpaqueDrawing,
  OpaqueRunContent,
  OpaqueParagraphChild,
  OleObjectPart
} from "@word/types";

// --- Stable API ---
/** @stability stable */
export {
  DocxError,
  DocxParseError,
  DocxWriteError,
  DocxMissingPartError,
  DocxInvalidStructureError,
  DocxUnsupportedFeatureError,
  DocxEncryptedError,
  DocxDecryptionError,
  DocxLimitExceededError,
  isDocxError
} from "@word/errors";

// --- Stable API ---

// --- Stable API ---
/** @stability stable */
export * as Document from "@word/builder/document-handle";
/** @stability stable */
export type { DocumentHandle } from "@word/builder/document-handle";

// =============================================================================
// Domain namespaces — public value API (tree-shaken via `export * as`).
// Functions live in `surface/*.ts`; the shared data-model types stay exported
// flat from `./types` above. Mirrors the excel module's surface structure.
// =============================================================================
export * as Build from "@word/surface/build";
export * as Units from "@word/surface/units";
export * as Theme from "@word/surface/theme";
export * as Query from "@word/surface/query";
export * as Io from "@word/surface/io";
export * as Template from "@word/surface/template";
export * as Convert from "@word/surface/convert";
export * as Font from "@word/surface/font";
export * as Layout from "@word/surface/layout";
export * as Security from "@word/surface/security";
export * as Ole from "@word/surface/ole";
export * as Vba from "@word/surface/vba";
export * as Glossary from "@word/surface/glossary";
export * as Styles from "@word/surface/styles";
export * as Diff from "@word/surface/diff";
export * as Validation from "@word/surface/validation";
export * as Streaming from "@word/surface/streaming";
export * as RenderContext from "@word/surface/render-context";

/** @stability stable */
export type { SearchResult, DocumentHeading, DocumentSection } from "@word/query/search";

/** @stability stable */
export type { MergeOptions } from "@word/query/merge";

/** @stability stable */
export type { SplitOptions } from "@word/query/split";

/** @stability stable */
export type { RevisionEntry } from "@word/query/revisions";

/** @stability stable */
export type {
  StyleResolveContext,
  ResolvedParagraphStyle,
  ResolvedRunStyle,
  ResolvedNumberingLevel
} from "@word/query/style-resolve";

/** @stability stable */
export type { CompatibilityMode } from "@word/query/compat";

/** @stability stable */
export type { FormFieldEntry } from "@word/query/form-fields";

/** @stability stable */
export type {
  PatchContent,
  PatchOperation,
  PatchOptions,
  CompiledTemplate
} from "@word/document-io";

// Incremental edit API (low-level efficient editing)
export type { IncrementalEdit, IncrementalEditOptions } from "@word/incremental-edit";

// --- Stable API ---

/** @stability stable */
export type { ReadDocxOptions } from "@word/reader/docx-reader";

// --- Experimental API ---
/** @stability experimental */
export type { DiffChangeType, DiffEntry, DiffSummary, DiffResult } from "@word/advanced/diff";

/** @stability experimental */
export type {
  TemplateOptions,
  TemplateImage,
  TemplateRichText,
  TemplateSubDocument,
  TemplateChart,
  TemplateHtmlChunk,
  TemplateTag
} from "@word/template/template-engine";

// --- Stable API ---
/** @stability stable */
export type { FlatOpcPart } from "@word/convert/flat-opc";

// --- Experimental API ---
/** @stability experimental */
export type {
  StreamingDocxOptions,
  StreamingProgressCallback
} from "@word/writer/streaming-writer";

/** @stability experimental */
export type { StreamingReadOptions, StreamingDocxMetadata } from "@word/reader/streaming-reader";

/** @stability experimental */
export type {
  ValidationSeverity,
  ValidationIssue,
  ValidationResult,
  ValidationOptions
} from "@word/advanced/validation";

// Font embedding
/** @stability stable */
export type { FontEmbedStyle, EmbedFontOptions, EmbedFontResult } from "@word/font/font-embed";

// --- Experimental API ---
/** @stability experimental */
export type {
  OleObject,
  OleObjectType,
  OleDisplayAs,
  OleExtractionResult,
  OleEmbeddingResult
} from "@word/advanced/ole-objects";

/** @stability experimental */
export type {
  BuildingBlockGallery,
  BuildingBlock,
  GlossaryDocument
} from "@word/advanced/glossary";

// Document protection
/** @stability stable */
export type {
  ProtectionEditType,
  ProtectionHashAlgorithm,
  DocumentProtectionOptions,
  ProtectionState
} from "@word/security/document-protection";

// Style mapping DSL
/** @stability stable */
export type {
  MappingSourceType,
  MappingCondition,
  MappingTarget,
  StyleMappingRule,
  StyleMap,
  StyleMapOptions
} from "@word/advanced/style-map";

// --- Experimental API ---
/** @stability experimental */
export type { VbaProjectInfo } from "@word/advanced/vba-project";

/** @stability experimental */
export type { LayoutResult, LayoutOptions } from "@word/layout/layout";
/** @stability experimental */
export type { FullLayoutOptions, PageGeometryOverride } from "@word/layout/layout-full";

/** @stability experimental */
export type { FieldUpdateOptions } from "@word/advanced/field-engine";

/** @stability experimental */
export type {
  StandardShapeType,
  SolidFill,
  GradientStop,
  GradientFill,
  PatternFill,
  NoFill,
  ShapeFill,
  LineDash,
  LineEndType,
  LineEndSize,
  ShapeOutline,
  ShadowEffect,
  GlowEffect,
  ReflectionEffect,
  Effect3D,
  ShapeEffects,
  TextVerticalAnchor,
  TextWrap,
  ShapeTextBody,
  CreateShapeOptions
} from "@word/advanced/drawing-shapes";

export type {
  ScriptType,
  BiDiDirection,
  ShapedCluster,
  ShapingOptions
} from "@word/font/text-shaping";

export type { HyphenationOptions, HyphenationPatterns } from "@word/font/hyphenation";

export type { FormatCriteria, FormatSearchResult } from "@word/query/format-search";

export type { RenderOptions } from "@word/layout/render-page";

export type { DataSource } from "@word/template/template-datasource";

export type {
  ChartBinding,
  ChartSeriesData,
  ChartTemplateData
} from "@word/template/template-chart";

// NOTE: renderToMarkdown, renderToHtml, htmlToDocx, excelToDocx, markdownToDocx are NOT exported
// from the main entry — they live in dedicated subpaths to ensure tree-shaking:
//   import { renderToMarkdown, markdownToDocx } from "documonster/word/markdown"
//   import { renderToHtml }     from "documonster/word/html"
//   import { excelToDocx }      from "documonster/word/excel"
// DOCX → PDF lives in the PDF module's lazy converter namespace:
//   import { Pdf } from "documonster/pdf"   // await Pdf.fromDocx(doc)

// --- Stable API ---
export type { EncryptOptions } from "@word/security/encryption";

// --- Security Policy ---
/** @stability experimental */
export type { WordSecurityPolicy } from "@word/security/policy";

// --- Render Context (experimental) ---
/** @stability experimental */
export type { WordRenderContext, IdGenerators } from "@word/writer/render-context";

// --- Document Transformer (experimental) ---
/** @stability experimental */
export type { DocxTransformer, MapOptions } from "@word/core/mapper";

// --- Document Walker (experimental) ---
/** @stability experimental */
export type { DocxVisitor, WalkPath, WalkOptions, VisitAction } from "@word/core/walker";

// --- Layout Model (experimental) ---
/** @stability experimental */
export type {
  LayoutDocument,
  LayoutPage,
  PageGeometry,
  PageContent,
  LayoutParagraph,
  LayoutTable,
  LayoutTableCell,
  LayoutImage,
  LayoutFloat,
  LayoutFloatWrap,
  LayoutTextBox,
  LayoutShape,
  LayoutChart,
  LayoutSdt,
  LayoutMath,
  LayoutCheckBox,
  LayoutTableOfContents,
  LayoutAltChunk,
  LayoutOpaqueDrawing,
  LineBox,
  LineBoxItem,
  PositionedInlineImage,
  PositionedRun
} from "@word/layout/layout-model";

// --- Conversion IR (experimental) ---
/** @stability experimental */
export type {
  SemanticDocument,
  SemanticBlock,
  SemanticInline,
  ConversionContext,
  ConversionWarning,
  ConversionAsset,
  ResolvedFormatting
} from "@word/convert/conversion-ir";
/** @stability experimental */
export type { DocxToSemanticOptions } from "@word/convert/docx-to-semantic";

// --- Model helpers ---
/** @stability experimental */
export type { AssetRef, MediaAsset } from "@word/types";
