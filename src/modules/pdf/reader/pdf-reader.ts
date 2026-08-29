/**
 * PDF reader — public API.
 *
 * Provides a high-level, zero-dependency interface for reading PDF files.
 * Supports:
 * - Text extraction with multilingual support (WinAnsi, MacRoman, CJK via
 *   ToUnicode CMap, Identity-H/V, Symbol, ZapfDingbats)
 * - Image extraction (JPEG, JPEG2000, raw/Flate, CCITT, JBIG2)
 * - Annotation extraction (links, comments, highlights, stamps, etc.)
 * - Form field extraction (AcroForm: text inputs, checkboxes, radio buttons, dropdowns)
 * - Metadata reading (Info dictionary + XMP)
 * - Encrypted PDFs:
 *   - RC4 (40-bit and 128-bit) — tested via roundtrip
 *   - AES-128 (V=4, R=4) — implemented, requires external test fixtures
 *   - AES-256 (V=5, R=5) — implemented, requires external test fixtures
 * - Cross-reference tables and streams (PDF 1.5+)
 * - Incremental updates and xref recovery
 *
 * @example Text extraction:
 * ```typescript
 * import { Pdf } from "documonster/pdf";
 *
 * const doc = await Pdf.read(pdfBytes);
 * console.log(doc.text);           // All text from all pages
 * console.log(doc.pages[0].text);  // Text from page 1
 * ```
 *
 * @example Image extraction:
 * ```typescript
 * const doc = await Pdf.read(pdfBytes);
 * for (const image of doc.pages[0].images) {
 *   console.log(image.format, image.width, image.height);
 *   fs.writeFileSync(`image.${image.format}`, image.data);
 * }
 * ```
 *
 * @example Metadata:
 * ```typescript
 * const doc = await Pdf.read(pdfBytes);
 * console.log(doc.metadata.title);
 * console.log(doc.metadata.author);
 * console.log(doc.metadata.pageCount);
 * ```
 *
 * @example Encrypted PDF:
 * ```typescript
 * const doc = await Pdf.read(pdfBytes, { password: "secret" });
 * ```
 */

import { PdfStructureError } from "@pdf/errors";
import { extractAnnotationsFromPage } from "@pdf/reader/annotation-extractor";
import type { PdfAnnotation } from "@pdf/reader/annotation-extractor";
import { extractBookmarks } from "@pdf/reader/bookmark-extractor";
import type { PdfBookmark } from "@pdf/reader/bookmark-extractor";
import { extractTextFromPage } from "@pdf/reader/content-interpreter";
import type { TextFragment } from "@pdf/reader/content-interpreter";
import { extractFormFields } from "@pdf/reader/form-extractor";
import type { PdfFormField } from "@pdf/reader/form-extractor";
import { extractImagesFromPage } from "@pdf/reader/image-extractor";
import type { ExtractedImage } from "@pdf/reader/image-extractor";
import { extractMetadata } from "@pdf/reader/metadata-reader";
import type { PdfMetadata } from "@pdf/reader/metadata-reader";
import { initDecryption, isEncrypted } from "@pdf/reader/pdf-decrypt";
import { PdfDocument } from "@pdf/reader/pdf-document";
import type { PdfDictValue } from "@pdf/reader/pdf-parser";
import { extractTables } from "@pdf/reader/table-extractor";
import type { PdfTable } from "@pdf/reader/table-extractor";
import { reconstructText, reconstructTextLines } from "@pdf/reader/text-reconstruction";
import type { TextLine } from "@pdf/reader/text-reconstruction";
import { yieldToEventLoop } from "@utils/utils.base";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for reading a PDF.
 */
export interface ReadPdfOptions {
  /**
   * Password for encrypted PDFs.
   * Can be either the user password or owner password.
   * @default ""
   */
  password?: string;

  /**
   * Which pages to extract (1-based).
   * If omitted, all pages are extracted.
   * @example [1, 3, 5] — extract pages 1, 3, and 5
   */
  pages?: number[];

  /**
   * Whether to extract text.
   * @default true
   */
  extractText?: boolean;

  /**
   * Whether to extract images.
   * @default true
   */
  extractImages?: boolean;

  /**
   * Whether to extract metadata.
   * @default true
   */
  extractMetadata?: boolean;

  /**
   * Whether to extract annotations (links, comments, highlights, etc.).
   * @default true
   */
  extractAnnotations?: boolean;

  /**
   * Whether to extract form fields (AcroForm: text inputs, checkboxes, dropdowns, etc.).
   * @default true
   */
  extractFormFields?: boolean;

  /**
   * Whether to extract bookmarks (document outline / table of contents).
   * @default true
   */
  extractBookmarks?: boolean;

  /**
   * Whether to extract tables from pages using text positioning heuristics.
   * Opt-in since table detection is heavier than plain text extraction.
   * @default false
   */
  extractTables?: boolean;
}

/**
 * A single page from a read PDF.
 */
export interface ReadPdfPage {
  /** 1-based page number */
  pageNumber: number;
  /** Extracted text content */
  text: string;
  /** Structured text lines with position information */
  textLines: TextLine[];
  /** Raw text fragments with exact positions */
  textFragments: TextFragment[];
  /** Extracted images */
  images: ExtractedImage[];
  /** Extracted annotations (links, comments, highlights, etc.) */
  annotations: PdfAnnotation[];
  /** Tables detected from text fragment positioning (opt-in via extractTables) */
  tables: PdfTable[];
  /** Page width in points */
  width: number;
  /** Page height in points */
  height: number;
  /** Warnings encountered during extraction (non-fatal errors) */
  warnings: string[];
}

/**
 * Result of reading a PDF.
 */
export interface ReadPdfResult {
  /** All text from all pages concatenated */
  text: string;
  /** Per-page results */
  pages: ReadPdfPage[];
  /** Document metadata */
  metadata: PdfMetadata;
  /** Form fields extracted from AcroForm (document-level) */
  formFields: PdfFormField[];
  /** Bookmarks (document outline) extracted from the outline tree */
  bookmarks: PdfBookmark[];
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Read a PDF file and extract text, images, and metadata.
 * Yields to the event loop between pages to avoid blocking.
 *
 * @param data - Raw PDF file bytes
 * @param options - Extraction options
 * @returns Promise of extracted content
 * @throws {PdfStructureError} If the PDF structure is invalid
 * @throws {PdfError} If decryption fails (wrong password)
 */
export async function readPdf(data: Uint8Array, options?: ReadPdfOptions): Promise<ReadPdfResult> {
  const { doc, opts, metadata, pagesInfo, pageIndicesToProcess } = prepareRead(data, options);

  const pages: ReadPdfPage[] = [];
  for (let i = 0; i < pageIndicesToProcess.length; i++) {
    const pageIdx = pageIndicesToProcess[i];
    pages.push(processPage(pagesInfo[pageIdx].dict, pageIdx, doc, opts));
    if (i < pageIndicesToProcess.length - 1) {
      await yieldToEventLoop();
    }
  }

  return finalizeRead(pages, pagesInfo.length, metadata, opts, doc);
}

// =============================================================================
// Internal — Shared Pipeline
// =============================================================================

interface ResolvedReadOptions {
  password: string;
  pages: number[] | undefined;
  extractText: boolean;
  extractImages: boolean;
  extractMetadata: boolean;
  extractAnnotations: boolean;
  extractFormFields: boolean;
  extractBookmarks: boolean;
  extractTables: boolean;
}

interface PreparedRead {
  doc: PdfDocument;
  opts: ResolvedReadOptions;
  metadata: PdfMetadata;
  pagesInfo: Array<{ dict: PdfDictValue; objNum: number; gen: number }>;
  pageIndicesToProcess: number[];
}

/**
 * Shared setup: parse document, handle encryption, extract metadata, resolve pages.
 */
function prepareRead(data: Uint8Array, options?: ReadPdfOptions): PreparedRead {
  const opts: ResolvedReadOptions = {
    password: options?.password ?? "",
    pages: options?.pages,
    extractText: options?.extractText ?? true,
    extractImages: options?.extractImages ?? true,
    extractMetadata: options?.extractMetadata ?? true,
    extractAnnotations: options?.extractAnnotations ?? true,
    extractFormFields: options?.extractFormFields ?? true,
    extractBookmarks: options?.extractBookmarks ?? true,
    extractTables: options?.extractTables ?? false
  };

  const doc = new PdfDocument(data);

  if (isEncrypted(doc)) {
    const success = initDecryption(doc, opts.password);
    if (!success) {
      throw new PdfStructureError("Failed to decrypt PDF: incorrect password");
    }
  }

  const metadata = opts.extractMetadata ? extractMetadata(doc) : createEmptyMetadata();
  const pagesInfo = doc.getPagesWithObjInfo();
  const pageIndicesToProcess = opts.pages
    ? opts.pages.map(p => p - 1).filter(p => p >= 0 && p < pagesInfo.length)
    : Array.from({ length: pagesInfo.length }, (_, i) => i);

  return { doc, opts, metadata, pagesInfo, pageIndicesToProcess };
}

/**
 * Process a single page: extract text, images, annotations, and dimensions.
 */
function processPage(
  pageDict: PdfDictValue,
  pageIdx: number,
  doc: PdfDocument,
  opts: ResolvedReadOptions
): ReadPdfPage {
  const pageNumber = pageIdx + 1;
  const warnings: string[] = [];

  let text = "";
  let textLines: TextLine[] = [];
  let textFragments: TextFragment[] = [];

  if (opts.extractText) {
    try {
      textFragments = extractTextFromPage(pageDict, doc);
      text = reconstructText(textFragments);
      textLines = reconstructTextLines(textFragments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Text extraction failed on page ${pageNumber}: ${msg}`);
    }
  }

  let images: ExtractedImage[] = [];
  if (opts.extractImages) {
    try {
      images = extractImagesFromPage(pageDict, doc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Image extraction failed on page ${pageNumber}: ${msg}`);
    }
  }

  let annotations: PdfAnnotation[] = [];
  if (opts.extractAnnotations) {
    try {
      annotations = extractAnnotationsFromPage(pageDict, doc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Annotation extraction failed on page ${pageNumber}: ${msg}`);
    }
  }

  const { width, height } = getPageDimensions(pageDict, doc);

  let tables: PdfTable[] = [];
  if (opts.extractTables) {
    try {
      tables = extractTables(textFragments, width, height);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Table extraction failed on page ${pageNumber}: ${msg}`);
    }
  }

  return {
    pageNumber,
    text,
    textLines,
    textFragments,
    images,
    annotations,
    tables,
    width,
    height,
    warnings
  };
}

/**
 * Finalize: concatenate text, update metadata page count, extract form fields.
 */
function finalizeRead(
  pages: ReadPdfPage[],
  totalPageCount: number,
  metadata: PdfMetadata,
  opts: ResolvedReadOptions,
  doc: PdfDocument
): ReadPdfResult {
  const allText = pages.map(p => p.text).join("\n\n");

  if (opts.extractMetadata) {
    metadata.pageCount = totalPageCount;
  }

  let formFields: PdfFormField[] = [];
  if (opts.extractFormFields) {
    try {
      formFields = extractFormFields(doc);
    } catch {
      // Non-fatal — just return empty
    }
  }

  let bookmarks: PdfBookmark[] = [];
  if (opts.extractBookmarks) {
    try {
      bookmarks = extractBookmarks(doc);
    } catch {
      // Non-fatal — just return empty
    }
  }

  return { text: allText, pages, metadata, formFields, bookmarks };
}

// =============================================================================
// Helpers
// =============================================================================

function getPageDimensions(
  pageDict: PdfDictValue,
  doc: PdfDocument
): { width: number; height: number } {
  return doc.resolvePageBox(pageDict) ?? { width: 612, height: 792 }; // Default: US Letter
}

function createEmptyMetadata(): PdfMetadata {
  return {
    title: "",
    author: "",
    subject: "",
    keywords: "",
    creator: "",
    producer: "",
    creationDate: null,
    modDate: null,
    pdfVersion: "",
    pageCount: 0,
    encrypted: false,
    pageSize: null,
    xmpXml: null,
    custom: {}
  };
}
