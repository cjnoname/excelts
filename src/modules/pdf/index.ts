/**
 * PDF module for documonster.
 *
 * A full-featured, zero-dependency PDF engine for both writing and reading.
 *
 * @example Standalone PDF generation:
 * ```typescript
 * import { pdf } from "documonster/pdf";
 *
 * const bytes = await pdf([
 *   ["Product", "Revenue"],
 *   ["Widget", 1000],
 *   ["Gadget", 2500]
 * ]);
 * ```
 *
 * @example From Excel Workbook:
 * ```typescript
 * import { Workbook, Worksheet } from "documonster/excel";
 * import { Pdf } from "documonster/pdf";
 *
 * const workbook = Workbook.create();
 * const sheet = Workbook.addWorksheet(workbook, "Sales");
 * Worksheet.addRow(sheet, ["Product", "Revenue"]);
 * const bytes = await Pdf.fromExcel(workbook);
 * ```
 *
 * @example Read PDF — extract text, images, and metadata:
 * ```typescript
 * import { readPdf } from "documonster/pdf";
 *
 * const result = await readPdf(pdfBytes);
 * console.log(result.text);               // All text
 * console.log(result.pages[0].text);      // Page 1 text
 * console.log(result.pages[0].images);    // Page 1 images
 * console.log(result.pages[0].annotations); // Page 1 annotations
 * console.log(result.metadata.title);     // Document title
 * console.log(result.formFields);         // Form fields
 * ```
 *
 * @module pdf
 */

// =============================================================================
// Public API — the `Pdf` domain namespace (tree-shaken via `export * as`)
// =============================================================================

export * as Pdf from "@pdf/surface/pdf";

// Conversion option types (the converter functions live on `Pdf.*`).
export type { ChartToPdfOptions, ExcelToPdfOptions } from "@pdf/excel-bridge";
export type { DocxToPdfOptions } from "@pdf/word-bridge";

// =============================================================================
// Types — Writing
// =============================================================================

export type { PdfCell, PdfRow, PdfColumn, PdfSheet, PdfBook, PdfImage, PdfInput } from "@pdf/pdf";

export type {
  PdfExportOptions,
  PdfEmbeddedFontFaces,
  PdfOrientation,
  PdfPageOrder,
  PdfCellErrorMode,
  PdfPageSize,
  PdfMargins,
  PdfColor,
  PageSizeName,
  PdfWatermark,
  PdfTextWatermark,
  PdfImageWatermark,
  PdfWatermarkFilter
} from "@pdf/types";

// =============================================================================
// Types — Reading
// =============================================================================

export type { ReadPdfOptions, ReadPdfResult, ReadPdfPage } from "@pdf/reader/pdf-reader";
export type { PdfMetadata } from "@pdf/reader/metadata-reader";
export type { ExtractedImage } from "@pdf/reader/image-extractor";
export type { TextLine } from "@pdf/reader/text-reconstruction";
export type { PdfAnnotation, PdfRect } from "@pdf/reader/annotation-extractor";
export type { PdfFormField, PdfFormFieldType } from "@pdf/reader/form-extractor";
export type { PdfBookmark } from "@pdf/reader/bookmark-extractor";
export type { PdfTable, PdfTableRow, PdfTableCell } from "@pdf/reader/table-extractor";

// =============================================================================
// Types — Building
// =============================================================================

export type {
  PageOptions,
  DrawSvgOptions,
  DrawTextOptions,
  DrawRectOptions,
  DrawCircleOptions,
  DrawEllipseOptions,
  DrawLineOptions,
  DrawPathOptions,
  DrawImageOptions,
  DocumentMetadata,
  PathOp,
  TocOptions,
  AnnotationType,
  AnnotationOptions,
  TextMarkupAnnotationOptions,
  TextAnnotationOptions,
  FreeTextAnnotationOptions,
  StampAnnotationOptions,
  FormFieldOptions,
  TextFieldOptions,
  CheckboxOptions,
  DropdownOptions,
  RadioGroupOptions,
  PdfSignatureOptions
} from "@pdf/builder/document-builder";
export type { LoadOptions } from "@pdf/builder/pdf-editor";
/** What `page.getContentStream()` returns. */
export type { PdfContentStream } from "@pdf/core/pdf-stream";

// =============================================================================
// Types — Digital Signatures
// =============================================================================

export type {
  SignatureVerificationResult,
  CmsSignedData,
  SignOptions,
  Asn1Node
} from "@pdf/core/digital-signature";

// =============================================================================
// Errors
// =============================================================================

export { PdfError, PdfRenderError, PdfFontError, PdfStructureError, isPdfError } from "@pdf/errors";
