/**
 * `Pdf` namespace surface — PDF writing, reading, building, editing,
 * conversion, and digital signatures.
 *
 * `import { Pdf } from "documonster/pdf"` →
 *   `Pdf.create(rows)`, `Pdf.read(bytes)`, `new Pdf.Builder()`,
 *   `new Pdf.Editor()`, `Pdf.sign(...)`, `Pdf.verifySignature(...)`,
 *   `await Pdf.fromExcel(wb)`, `await Pdf.fromDocx(doc)`.
 *
 * The cross-module converters (`fromExcel`/`fromDocx`/`fromChart`/
 * `wordChartRenderer`) are **lazily loaded** via dynamic `import()`: they
 * statically pull the excel / word object models, so wiring them as plain
 * re-exports would force every `Pdf.create` consumer to bundle excel+word
 * (~hundreds of KB). The dynamic boundary keeps the core PDF engine
 * tree-shakeable — a consumer who never calls a converter never bundles the
 * source module. (Verified by scripts/treeshake-verify.ts.)
 */
import { PdfDocumentBuilder, PdfPageBuilder, parseSvgPath } from "@pdf/builder/document-builder";
import type {
  ChartHandle,
  ChartToPdfOptions,
  ExcelToPdfOptions,
  Workbook
} from "@pdf/excel-bridge";
import type { DocxDocument, DocxToPdfOptions } from "@pdf/word-bridge";
import type { WordChart } from "@pdf/word-chart-bridge";

// --- Writing (core engine, statically linked) ---
export { pdf as create } from "@pdf/pdf";

// --- Reading ---
export { readPdf as read } from "@pdf/reader/pdf-reader";

// --- Building (imported above; re-exported under namespace-friendly names) ---
export { PdfDocumentBuilder as Builder, PdfPageBuilder as PageBuilder, parseSvgPath };

// --- Editing ---
export { PdfEditor as Editor, PdfEditorPage as EditorPage } from "@pdf/builder/pdf-editor";

// --- Digital signatures ---
export {
  verifyPdfSignature as verifySignature,
  signPdf as sign,
  buildSignatureDictPlaceholder,
  asn1Parse
} from "@pdf/core/digital-signature";

// --- Page-size presets ---
export { PageSizes } from "@pdf/types";

// --- Cross-module converters (lazy: pull excel / word only when called) ---

/** Convert an Excel workbook to a PDF. Dynamically loads the excel bridge. */
export async function fromExcel(
  workbook: Workbook,
  options?: ExcelToPdfOptions
): Promise<Uint8Array> {
  const { excelToPdf } = await import("@pdf/excel-bridge");
  return excelToPdf(workbook, options);
}

/** Render a single chart handle to a PDF. Dynamically loads the excel bridge. */
export async function fromChart(
  chart: ChartHandle,
  options?: ChartToPdfOptions
): Promise<Uint8Array> {
  const { chartToPdf } = await import("@pdf/excel-bridge");
  return chartToPdf(chart, options);
}

/** Convert a DOCX document to a PDF. Dynamically loads the word bridge. */
export async function fromDocx(doc: DocxDocument, options?: DocxToPdfOptions): Promise<Uint8Array> {
  const { docxToPdf } = await import("@pdf/word-bridge");
  return docxToPdf(doc, options);
}

/**
 * Build the Word-chart → PDF renderer callback for `docxToPdf`'s
 * `chartRenderer` option. Dynamically loads the word-chart bridge
 * (Word chart types + the Excel chart engine).
 */
export async function wordChartRenderer(): Promise<
  (
    chart: WordChart,
    page: PdfPageBuilder,
    rect: { x: number; y: number; width: number; height: number }
  ) => void
> {
  const { createWordChartPdfRenderer } = await import("@pdf/word-chart-bridge");
  return createWordChartPdfRenderer();
}
