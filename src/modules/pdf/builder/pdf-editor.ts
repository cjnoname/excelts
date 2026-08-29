/**
 * PDF editor — modify existing PDF documents.
 *
 * Supports:
 * - Adding new pages with free-form content
 * - Adding text/shapes/images to existing pages (overlay)
 * - Filling form fields (AcroForm)
 * - Copying pages from other PDFs (merge)
 * - Preserving page properties (Rotate, CropBox, etc.) and metadata
 *
 * Note: save() rebuilds the PDF from scratch rather than using incremental
 * updates. This is simpler and more reliable but means object numbers change
 * and existing digital signatures will be invalidated.
 *
 * @example Edit an existing PDF:
 * ```typescript
 * import { Pdf } from "documonster/pdf";
 *
 * const editor = Pdf.Editor.load(existingPdfBytes);
 * editor.getPage(0).drawText("APPROVED", { x: 200, y: 400, fontSize: 48, color: { r: 0, g: 0.5, b: 0 } });
 * editor.setFormField("name", "John Doe");
 * const result = await editor.save();
 * ```
 */

import { PdfPageBuilder } from "@pdf/builder/document-builder";
import type {
  DrawTextOptions,
  DrawRectOptions,
  DrawCircleOptions,
  DrawEllipseOptions,
  DrawLineOptions,
  DrawImageOptions,
  DrawPathOptions,
  PathOp,
  PageOptions,
  AnnotationOptions,
  FormFieldOptions,
  PdfSignatureOptions
} from "@pdf/builder/document-builder";
import { generateTextFieldAppearance, buildAppearanceBBox } from "@pdf/builder/form-appearance";
import { writeImageXObject, parseImageDimensions } from "@pdf/builder/image-utils";
import {
  parseResourceDict,
  mergeResourceDicts,
  serializeResourceDict
} from "@pdf/builder/resource-merger";
import type { PdfResourceDict } from "@pdf/builder/resource-merger";
import { PdfDict, pdfRef, pdfString, pdfHexString, pdfNumber } from "@pdf/core/pdf-object";
import type { PdfContentStream } from "@pdf/core/pdf-stream";
import { PdfWriter, buildIncremental } from "@pdf/core/pdf-writer";
import { PdfStructureError } from "@pdf/errors";
import { FontManager } from "@pdf/font/font-manager";
import { parseTtf } from "@pdf/font/ttf-parser";
import { extractFormFields } from "@pdf/reader/form-extractor";
import type { PdfFormField } from "@pdf/reader/form-extractor";
import { extractMetadata } from "@pdf/reader/metadata-reader";
import { initDecryption, isEncrypted } from "@pdf/reader/pdf-decrypt";
import { PdfDocument } from "@pdf/reader/pdf-document";
import {
  isPdfArray,
  isPdfRef,
  dictGetName,
  dictGetNumber,
  decodePdfStringBytes
} from "@pdf/reader/pdf-parser";
import type { PdfDictValue, PdfObject, PdfRef } from "@pdf/reader/pdf-parser";
import { alphaGsName } from "@pdf/render/page-renderer";

// =============================================================================
// Types
// =============================================================================

/** Options for loading a PDF for editing. */
export interface LoadOptions {
  /** Password for encrypted PDFs. */
  password?: string;
}

// =============================================================================
// PdfEditorPage
// =============================================================================

/**
 * Proxy for an existing page that allows overlaying new content.
 * New content is drawn on top of existing content via a separate content stream.
 */
export class PdfEditorPage {
  /** @internal */
  readonly _overlay: PdfPageBuilder;
  /** @internal */
  readonly _pageIndex: number;
  /** @internal */
  readonly _width: number;
  /** @internal */
  readonly _height: number;

  /** @internal */
  constructor(
    pageIndex: number,
    width: number,
    height: number,
    fontManager: FontManager,
    resourcePrefix = ""
  ) {
    this._pageIndex = pageIndex;
    this._width = width;
    this._height = height;
    this._overlay = new PdfPageBuilder(width, height, fontManager, resourcePrefix);
  }

  /** Page width in points. */
  get width(): number {
    return this._width;
  }

  /** Page height in points. */
  get height(): number {
    return this._height;
  }

  /**
   * Measure the width of a text string in points.
   */
  measureText(
    text: string,
    options?: {
      fontSize?: number;
      fontFamily?: string;
      bold?: boolean;
      italic?: boolean;
    }
  ): number {
    return this._overlay.measureText(text, options);
  }

  /**
   * Draw text on this existing page (overlaid on top).
   */
  drawText(text: string, options: DrawTextOptions): this {
    this._overlay.drawText(text, options);
    return this;
  }

  /**
   * Draw a rectangle on this existing page.
   */
  drawRect(options: DrawRectOptions): this {
    this._overlay.drawRect(options);
    return this;
  }

  /**
   * Draw a circle on this existing page.
   */
  drawCircle(options: DrawCircleOptions): this {
    this._overlay.drawCircle(options);
    return this;
  }

  /**
   * Draw an ellipse on this existing page.
   */
  drawEllipse(options: DrawEllipseOptions): this {
    this._overlay.drawEllipse(options);
    return this;
  }

  /**
   * Draw a line on this existing page.
   */
  drawLine(options: DrawLineOptions): this {
    this._overlay.drawLine(options);
    return this;
  }

  /**
   * Draw an image on this existing page.
   */
  drawImage(options: DrawImageOptions): this {
    this._overlay.drawImage(options);
    return this;
  }

  /**
   * Get the raw overlay content stream.
   */
  getContentStream(): PdfContentStream {
    return this._overlay._stream;
  }

  /**
   * Add an annotation to this existing page (Highlight, Text, FreeText, Stamp, etc.).
   */
  addAnnotation(options: AnnotationOptions): this {
    this._overlay.addAnnotation(options);
    return this;
  }

  /**
   * Add a form field to this existing page.
   */
  addFormField(options: FormFieldOptions): this {
    this._overlay.addFormField(options);
    return this;
  }

  /**
   * Draw an SVG path on this existing page.
   */
  drawSvgPath(d: string, options?: DrawPathOptions): this {
    this._overlay.drawSvgPath(d, options);
    return this;
  }

  /**
   * Draw a complex path from a list of path operations.
   */
  drawPath(ops: PathOp[], options?: DrawPathOptions): this {
    this._overlay.drawPath(ops, options);
    return this;
  }

  /** @internal */
  _hasOverlay(): boolean {
    return (
      this._overlay._stream.hasContent() ||
      this._overlay._images.length > 0 ||
      this._overlay._builderAnnotations.length > 0 ||
      this._overlay._formFields.length > 0
    );
  }
}

// =============================================================================
// PdfEditor
// =============================================================================

/**
 * Editor for modifying existing PDF documents.
 *
 * Load an existing PDF, overlay content on existing pages, fill form fields,
 * add new pages, copy pages from other documents, and save.
 */
export class PdfEditor {
  private _doc: PdfDocument;
  private _password: string;
  private _pages: PdfEditorPage[] = [];
  private _newPages: PdfPageBuilder[] = [];
  private _fontManager: FontManager;
  /** Prefix that isolates every overlay resource from the original document. */
  private _overlayResourcePrefix: string;
  private _formFieldUpdates = new Map<string, string>();
  private _copiedPages: CopiedPage[] = [];
  /** @internal - Indices of original pages to remove on save */
  private _removedPageIndices = new Set<number>();
  /** @internal - True during saveIncremental() to preserve original refs */
  private _isIncrementalSave = false;
  /** @internal - Rotation overrides for original pages: index → degrees (0/90/180/270) */
  private _rotationOverrides = new Map<number, number>();
  private _signaturePlaceholder: string | null = null;
  /** @internal - Writer reference during save(), for deep-clone */
  private _writerForSave: PdfWriter | null = null;
  /** @internal - Cache of cloned indirect refs: "objNum:gen" → new objNum in writer */
  private _clonedRefs = new Map<string, number>();

  private constructor(data: Uint8Array, password: string) {
    this._doc = new PdfDocument(data);
    this._password = password;
    this._overlayResourcePrefix = this._chooseOverlayResourcePrefix();
    this._fontManager = new FontManager(undefined, this._overlayResourcePrefix);

    // Handle encryption
    if (isEncrypted(this._doc)) {
      const success = initDecryption(this._doc, password);
      if (!success) {
        throw new PdfStructureError("Failed to decrypt PDF: incorrect password");
      }
    }

    // Initialize page proxies
    const pagesInfo = this._doc.getPagesWithObjInfo();
    for (let i = 0; i < pagesInfo.length; i++) {
      const { dict } = pagesInfo[i];
      const dims = this._doc.resolvePageBox(dict) ?? {
        width: 612,
        height: 792
      };
      this._pages.push(
        new PdfEditorPage(
          i,
          dims.width,
          dims.height,
          this._fontManager,
          this._overlayResourcePrefix
        )
      );
    }
  }

  /**
   * Load a PDF for editing.
   *
   * @param data - Raw PDF file bytes
   * @param options - Load options (e.g., password)
   * @returns A PdfEditor instance
   */
  static load(data: Uint8Array, options?: LoadOptions): PdfEditor {
    return new PdfEditor(data, options?.password ?? "");
  }

  /** Number of existing pages. */
  get pageCount(): number {
    return this._pages.length;
  }

  /**
   * Get an existing page for editing (overlaying content).
   *
   * @param index - 0-based page index
   */
  getPage(index: number): PdfEditorPage {
    if (index < 0 || index >= this._pages.length) {
      throw new PdfStructureError(`Page index ${index} out of range (0-${this._pages.length - 1})`);
    }
    return this._pages[index];
  }

  /**
   * Add a new blank page to the end of the document.
   */
  addPage(options?: PageOptions): PdfPageBuilder {
    const width = options?.width ?? 595.28;
    const height = options?.height ?? 841.89;
    const page = new PdfPageBuilder(width, height, this._fontManager, this._overlayResourcePrefix);
    this._newPages.push(page);
    return page;
  }

  /**
   * Remove a page from the document.
   *
   * @param index - 0-based page index (of original pages only)
   */
  removePage(index: number): this {
    if (index < 0 || index >= this._pages.length) {
      throw new PdfStructureError(`Page index ${index} out of range (0-${this._pages.length - 1})`);
    }
    this._removedPageIndices.add(index);
    return this;
  }

  /**
   * Set the rotation of an existing page.
   *
   * @param index - 0-based page index (of original pages only)
   * @param degrees - Rotation in degrees (must be 0, 90, 180, or 270)
   */
  rotatePage(index: number, degrees: number): this {
    if (index < 0 || index >= this._pages.length) {
      throw new PdfStructureError(`Page index ${index} out of range (0-${this._pages.length - 1})`);
    }
    if (degrees !== 0 && degrees !== 90 && degrees !== 180 && degrees !== 270) {
      throw new PdfStructureError(`Invalid rotation ${degrees}: must be 0, 90, 180, or 270`);
    }
    this._rotationOverrides.set(index, degrees);
    return this;
  }

  /**
   * Split the document: save each page (or a subset) as a separate PDF.
   *
   * @param pageIndices - 0-based page indices to extract. Omit to split all pages.
   * @returns Array of Uint8Array, one per requested page.
   */
  async splitPages(pageIndices?: number[]): Promise<Uint8Array[]> {
    const pagesInfo = this._doc.getPagesWithObjInfo();
    const indices = pageIndices ?? Array.from({ length: pagesInfo.length }, (_, i) => i);
    const results: Uint8Array[] = [];

    for (const idx of indices) {
      if (idx < 0 || idx >= pagesInfo.length) {
        continue;
      }

      // Create a single-page editor from original bytes and save it
      const singlePageEditor = PdfEditor.load(this._doc.data, {
        password: this._password
      });
      // Remove all pages except the one we want
      for (let i = 0; i < pagesInfo.length; i++) {
        if (i !== idx) {
          singlePageEditor.removePage(i);
        }
      }
      results.push(await singlePageEditor.save());
    }

    return results;
  }

  /**
   * Pick a deterministic resource prefix absent from every original page.
   *
   * Overlay content is merged into each page resource dictionary. Fonts,
   * images, and ExtGState entries therefore need a private namespace; otherwise
   * an overlay `/EF1` or `/Im1` silently replaces the original page resource and
   * corrupts content that was already there.
   */
  private _chooseOverlayResourcePrefix(): string {
    const used = new Set<string>();
    for (const { dict } of this._doc.getPagesWithObjInfo()) {
      const resources = this._doc.resolvePageResources(dict);
      for (const category of ["Font", "XObject", "ExtGState"]) {
        const value = resources.get(category);
        const subDict = value ? this._doc.derefDict(value) : null;
        if (!subDict) {
          continue;
        }
        for (const name of subDict.keys()) {
          used.add(name);
        }
      }
    }
    let id = 1;
    while ([...used].some(name => name.startsWith(`DMO${id}_`))) {
      id++;
    }
    return `DMO${id}_`;
  }

  /**
   * Embed a TrueType font for Unicode/CJK support.
   */
  embedFont(fontBytes: Uint8Array): this {
    const ttfFont = parseTtf(fontBytes);
    this._fontManager.registerEmbeddedFont(ttfFont);
    return this;
  }

  // ===========================================================================
  // Form Fields
  // ===========================================================================

  /**
   * Set the value of a form field.
   * The field is identified by its fully qualified name (e.g., "form.address.city").
   *
   * @param fieldName - Fully qualified field name
   * @param value - New value to set
   */
  setFormField(fieldName: string, value: string): this {
    this._formFieldUpdates.set(fieldName, value);
    return this;
  }

  /**
   * Set multiple form field values at once.
   *
   * @param fields - Object mapping field names to values
   */
  setFormFields(fields: Record<string, string>): this {
    for (const [name, value] of Object.entries(fields)) {
      this._formFieldUpdates.set(name, value);
    }
    return this;
  }

  /**
   * Get current form fields (before any modifications).
   */
  getFormFields(): PdfFormField[] {
    return extractFormFields(this._doc);
  }

  // ===========================================================================
  // Page Copy / Merge
  // ===========================================================================

  /**
   * Copy pages from another PDF document into this document.
   *
   * @param sourcePdf - Raw bytes of the source PDF
   * @param pageIndices - 0-based page indices to copy. Omit to copy all pages.
   * @param options - Load options for the source PDF (e.g., password)
   */
  copyPagesFrom(sourcePdf: Uint8Array, pageIndices?: number[], options?: LoadOptions): this {
    const sourceDoc = new PdfDocument(sourcePdf);

    if (isEncrypted(sourceDoc)) {
      const success = initDecryption(sourceDoc, options?.password ?? "");
      if (!success) {
        throw new PdfStructureError("Failed to decrypt source PDF for page copy");
      }
    }

    const sourcePagesInfo = sourceDoc.getPagesWithObjInfo();
    const indices = pageIndices ?? Array.from({ length: sourcePagesInfo.length }, (_, i) => i);

    for (const idx of indices) {
      if (idx < 0 || idx >= sourcePagesInfo.length) {
        continue;
      }

      const { dict: pageDict } = sourcePagesInfo[idx];
      const dims = sourceDoc.resolvePageBox(pageDict) ?? {
        width: 612,
        height: 792
      };

      // Collect all content streams from the source page
      const contentStreams = this._collectContentStreams(sourceDoc, pageDict);

      this._copiedPages.push({
        width: dims.width,
        height: dims.height,
        contentStreams,
        sourceDoc,
        sourcePageDict: pageDict
      });
    }

    return this;
  }

  // ===========================================================================
  // Save
  // ===========================================================================

  /**
   * Save the modified PDF.
   *
   * Rebuilds the PDF from scratch — content streams, resources, and page
   * properties are deep-cloned into a new document. Original metadata and
   * XMP streams are preserved. Digital signatures will be invalidated.
   *
   * @returns The modified PDF as Uint8Array
   */
  async save(): Promise<Uint8Array> {
    // Rebuild the PDF (not incremental update — simpler and more reliable)
    const writer = new PdfWriter();
    this._writerForSave = writer;
    this._clonedRefs = new Map();
    this._fontManager.beginBuild();

    try {
      return await this._buildFullSave(writer);
    } finally {
      this._fontManager.endBuild();
      this._writerForSave = null;
      this._clonedRefs.clear();
    }
  }

  /** @internal Full rebuild implementation, extracted for try/finally cleanup. */
  private async _buildFullSave(writer: PdfWriter): Promise<Uint8Array> {
    for (const page of this._pages) {
      page._overlay._stream.preflight();
    }
    for (const page of this._newPages) {
      page._stream.preflight();
    }
    // Write font resources for any overlay content
    const fontObjectMap = await this._fontManager.writeFontResources(writer);
    const fontDictStr = this._fontManager.buildFontDictString(fontObjectMap);

    const pagesTreeObjNum = writer.allocObject();
    const pageObjNums: number[] = [];

    // Re-emit existing pages
    const pagesInfo = this._doc.getPagesWithObjInfo();
    for (let i = 0; i < pagesInfo.length; i++) {
      // Skip removed pages
      if (this._removedPageIndices.has(i)) {
        continue;
      }

      const { dict: pageDict } = pagesInfo[i];
      const dims = this._doc.resolvePageBox(pageDict) ?? {
        width: 612,
        height: 792
      };
      const editorPage = this._pages[i];

      // Get original content streams
      const originalStreams = this._collectContentStreams(this._doc, pageDict);
      const originalResources = this._serializeResources(this._doc, pageDict);

      // Combine original + overlay content
      const allContentRefs: number[] = [];

      // Write original content streams
      for (const streamData of originalStreams) {
        const objNum = writer.allocObject();
        writer.addStreamObject(objNum, new PdfDict(), streamData);
        allContentRefs.push(objNum);
      }

      // Write overlay content stream if present
      let overlayResourcesStr = "";
      if (editorPage._hasOverlay()) {
        const overlayObjNum = writer.allocObject();
        writer.addStreamObject(overlayObjNum, new PdfDict(), editorPage._overlay._stream);
        allContentRefs.push(overlayObjNum);

        // Build overlay-specific resources (fonts, images, ExtGState) as
        // structured dict. ExtGState is required whenever the overlay
        // page builder captured non-opaque colours via `_applyAlpha`;
        // without it the emitted `gs` operators would reference
        // undefined resources.
        const imageXObjectMap = this._writeOverlayImages(writer, editorPage._overlay);
        const overlayDict = this._buildOverlayResourceDict(
          writer,
          editorPage._overlay,
          fontDictStr,
          imageXObjectMap
        );
        overlayResourcesStr = serializeResourceDict(overlayDict);
      }

      // Write resources (merge original + overlay)
      const resourcesObjNum = writer.allocObject();
      const mergedResources = this._mergeResourceStrings(originalResources, overlayResourcesStr);
      writer.addObject(resourcesObjNum, mergedResources || "<< >>");

      // Write page dict
      const contentsStr =
        allContentRefs.length === 1
          ? pdfRef(allContentRefs[0])
          : `[${allContentRefs.map(r => pdfRef(r)).join(" ")}]`;

      // Apply form field updates to annotations
      const annotRefs = this._writeFormFieldUpdates(writer, pageDict, i);

      // Write overlay builder annotations (Highlight, Text, FreeText, Stamp, etc.)
      for (const annot of editorPage._overlay._builderAnnotations) {
        const annotObjNum = writer.allocObject();
        const rect = `[${pdfNumber(annot.rect[0])} ${pdfNumber(annot.rect[1])} ${pdfNumber(annot.rect[2])} ${pdfNumber(annot.rect[3])}]`;
        const annotDict = new PdfDict()
          .set("Type", "/Annot")
          .set("Subtype", `/${annot.subtype}`)
          .set("Rect", rect)
          .set("F", "4");
        for (const [key, value] of annot.entries) {
          annotDict.set(key, value);
        }
        writer.addObject(annotObjNum, annotDict);
        annotRefs.push(annotObjNum);
      }

      // Write overlay form fields
      for (const field of editorPage._overlay._formFields) {
        if (field.options.type === "radio") {
          // Radio group: parent field + child widgets
          const parentObjNum = writer.allocObject();
          const childRefs: number[] = [];
          let ff = 1 << 15; // Radio
          ff |= 1 << 14; // NoToggleToOff
          if (field.options.readOnly) {
            ff |= 1;
          }
          if (field.options.required) {
            ff |= 1 << 1;
          }

          for (const btn of field.options.buttons) {
            const childObjNum = writer.allocObject();
            const rect = `[${btn.rect.map(v => pdfNumber(v)).join(" ")}]`;
            const isSelected = field.options.selected === btn.value;
            const apState = isSelected ? `/${btn.value}` : "/Off";
            const childDict = new PdfDict()
              .set("Type", "/Annot")
              .set("Subtype", "/Widget")
              .set("Rect", rect)
              .set("Parent", pdfRef(parentObjNum))
              .set("AS", apState)
              .set("AP", `<< /N << /${btn.value} null /Off null >> >>`);
            writer.addObject(childObjNum, childDict);
            childRefs.push(childObjNum);
            annotRefs.push(childObjNum); // Children go into page /Annots
          }

          const parentDict = new PdfDict()
            .set("FT", "/Btn")
            .set("T", pdfString(field.options.name))
            .set("Ff", String(ff))
            .set("Kids", `[${childRefs.map(r => pdfRef(r)).join(" ")}]`);
          if (field.options.selected) {
            parentDict.set("V", `/${field.options.selected}`);
          }
          writer.addObject(parentObjNum, parentDict);
          // Parent does NOT go into annotRefs (not a visual annotation)
        } else {
          // Single-widget fields: text, checkbox, dropdown
          const fieldObjNum = writer.allocObject();
          const r = field.options.rect;
          const rect = `[${pdfNumber(r[0])} ${pdfNumber(r[1])} ${pdfNumber(r[2])} ${pdfNumber(r[3])}]`;
          const fieldDict = new PdfDict()
            .set("Type", "/Annot")
            .set("Subtype", "/Widget")
            .set("Rect", rect)
            .set("T", pdfString(field.options.name))
            .set(
              "FT",
              field.options.type === "text"
                ? "/Tx"
                : field.options.type === "checkbox"
                  ? "/Btn"
                  : "/Ch"
            );
          if (field.options.value) {
            fieldDict.set("V", pdfString(field.options.value));
          }
          fieldDict.set("DA", pdfString("/Helv 12 Tf 0 g"));
          writer.addObject(fieldObjNum, fieldDict);
          annotRefs.push(fieldObjNum);
        }
      }

      const pageDict2 = new PdfDict()
        .set("Type", "/Page")
        .set("Parent", pdfRef(pagesTreeObjNum))
        .set("MediaBox", `[0 0 ${pdfNumber(dims.width)} ${pdfNumber(dims.height)}]`)
        .set("Contents", contentsStr)
        .set("Resources", pdfRef(resourcesObjNum));

      // Preserve page-level properties from the original page dict
      this._copyPageProperties(pageDict, pageDict2);

      // Apply rotation override if set
      const rotationOverride = this._rotationOverrides.get(i);
      if (rotationOverride !== undefined) {
        if (rotationOverride === 0) {
          // Remove rotation (unset the key)
          pageDict2.delete("Rotate");
        } else {
          pageDict2.set("Rotate", String(rotationOverride));
        }
      }

      if (annotRefs.length > 0) {
        pageDict2.set("Annots", `[${annotRefs.map(r => pdfRef(r)).join(" ")}]`);
      }

      const pageObjNum = writer.allocObject();
      writer.addObject(pageObjNum, pageDict2);
      pageObjNums.push(pageObjNum);
    }

    // Write copied pages
    for (const copied of this._copiedPages) {
      const contentRefs: number[] = [];
      for (const streamData of copied.contentStreams) {
        const objNum = writer.allocObject();
        writer.addStreamObject(objNum, new PdfDict(), streamData);
        contentRefs.push(objNum);
      }

      // Deep-clone resources from the source document
      const resourcesStr = this._serializeResources(copied.sourceDoc, copied.sourcePageDict);
      const resourcesObjNum = writer.allocObject();
      writer.addObject(resourcesObjNum, resourcesStr || "<< >>");

      const contentsStr =
        contentRefs.length === 1
          ? pdfRef(contentRefs[0])
          : `[${contentRefs.map(r => pdfRef(r)).join(" ")}]`;

      const pageDict = new PdfDict()
        .set("Type", "/Page")
        .set("Parent", pdfRef(pagesTreeObjNum))
        .set("MediaBox", `[0 0 ${pdfNumber(copied.width)} ${pdfNumber(copied.height)}]`)
        .set("Contents", contentsStr)
        .set("Resources", pdfRef(resourcesObjNum));

      // Preserve page properties from source page
      this._copyPageProperties(copied.sourcePageDict, pageDict, copied.sourceDoc);

      const pageObjNum = writer.allocObject();
      writer.addObject(pageObjNum, pageDict);
      pageObjNums.push(pageObjNum);
    }

    // Write new pages
    for (const page of this._newPages) {
      const imageXObjectMap = this._writeOverlayImages(writer, page);
      let xobjDictStr = "";
      if (imageXObjectMap.size > 0) {
        const entries = [...imageXObjectMap.entries()]
          .map(([name, objNum]) => `/${name} ${pdfRef(objNum)}`)
          .join(" ");
        xobjDictStr = `<< ${entries} >>`;
      }

      const contentObjNum = writer.allocObject();
      writer.addStreamObject(contentObjNum, new PdfDict(), page._stream);

      // Materialise the page's alpha ExtGState entries. The builder
      // captured them via `_applyAlpha` while painting; without this
      // block the `gs` operators in the content stream would reference
      // undefined resources. Matches `document-builder.ts:1417-1430`.
      let gsDictStr = "";
      if (page._alphaValues.size > 0) {
        const gsEntries: string[] = [];
        for (const alpha of page._alphaValues) {
          const gsObjNum = writer.allocObject();
          const gsDict = new PdfDict()
            .set("Type", "/ExtGState")
            .set("ca", pdfNumber(alpha))
            .set("CA", pdfNumber(alpha));
          writer.addObject(gsObjNum, gsDict);
          gsEntries.push(`/${alphaGsName(alpha, this._overlayResourcePrefix)} ${pdfRef(gsObjNum)}`);
        }
        gsDictStr = `<< ${gsEntries.join(" ")} >>`;
      }

      const resourcesObjNum = writer.allocObject();
      let resStr = "<< ";
      if (fontDictStr) {
        resStr += `/Font ${fontDictStr} `;
      }
      if (xobjDictStr) {
        resStr += `/XObject ${xobjDictStr} `;
      }
      if (gsDictStr) {
        resStr += `/ExtGState ${gsDictStr} `;
      }
      resStr += ">>";
      writer.addObject(resourcesObjNum, resStr);

      const pageObjNum = writer.addPage({
        parentRef: pagesTreeObjNum,
        width: page._width,
        height: page._height,
        contentsRef: contentObjNum,
        resourcesRef: resourcesObjNum
      });
      pageObjNums.push(pageObjNum);
    }

    // Pages tree
    const kidsStr = pageObjNums.map(n => pdfRef(n)).join(" ");
    writer.addObject(
      pagesTreeObjNum,
      new PdfDict()
        .set("Type", "/Pages")
        .set("Kids", `[${kidsStr}]`)
        .set("Count", String(pageObjNums.length))
    );

    // Catalog — with optional AcroForm
    const catalogObjNum = writer.allocObject();
    const catalogDict = new PdfDict().set("Type", "/Catalog").set("Pages", pdfRef(pagesTreeObjNum));

    // If we have form field updates, write an AcroForm dict
    if (this._formFieldUpdates.size > 0) {
      try {
        const catalog = this._doc.getCatalog();
        const acroFormRef = catalog.get("AcroForm");
        if (acroFormRef) {
          const acroFormStr = this._deepSerialize(this._doc, acroFormRef);
          // Insert /NeedAppearances into the cloned dict
          if (acroFormStr && acroFormStr.startsWith("<<")) {
            catalogDict.set("AcroForm", acroFormStr.replace("<<", "<< /NeedAppearances true"));
          } else {
            catalogDict.set("AcroForm", "<< /NeedAppearances true >>");
          }
        } else {
          catalogDict.set("AcroForm", "<< /NeedAppearances true >>");
        }
      } catch {
        catalogDict.set("AcroForm", "<< /NeedAppearances true >>");
      }
    }

    // Preserve XMP metadata stream from original catalog
    try {
      const originalCatalog = this._doc.getCatalog();
      const metadataRef = originalCatalog.get("Metadata");
      if (metadataRef) {
        const clonedRef = this._deepSerialize(this._doc, metadataRef);
        if (clonedRef) {
          catalogDict.set("Metadata", clonedRef);
        }
      }
    } catch {
      // If catalog is inaccessible, skip XMP preservation
    }

    writer.addObject(catalogObjNum, catalogDict);
    writer.setCatalog(catalogObjNum);

    // Inject signature placeholder if signing is in progress
    if (this._signaturePlaceholder) {
      const sigDictObjNum = writer.allocObject();
      writer.addObject(sigDictObjNum, this._signaturePlaceholder);

      const sigWidgetObjNum = writer.allocObject();
      const sigWidgetDict = new PdfDict()
        .set("Type", "/Annot")
        .set("Subtype", "/Widget")
        .set("FT", "/Sig")
        .set("Rect", "[0 0 0 0]")
        .set("T", pdfString("Signature1"))
        .set("V", pdfRef(sigDictObjNum))
        .set("F", "4");
      writer.addObject(sigWidgetObjNum, sigWidgetDict);

      // Patch catalog to include signature widget in AcroForm with SigFlags
      // Grab existing fields from the catalog dict string representation
      const catalogStr = catalogDict.toString();
      const existingFieldsMatch = catalogStr.match(/\/Fields\s*\[([^\]]*)\]/);
      const existingFields = existingFieldsMatch ? existingFieldsMatch[1].trim() : "";
      const sigFieldRef = pdfRef(sigWidgetObjNum);
      const allFieldRefs = existingFields ? `${existingFields} ${sigFieldRef}` : sigFieldRef;
      catalogDict.set("AcroForm", `<< /Fields [${allFieldRefs}] /SigFlags 3 >>`);
      writer.addObject(catalogObjNum, catalogDict);
    }

    // Info dict — preserve original metadata
    const originalMeta = extractMetadata(this._doc);
    writer.addInfoDict({
      title: originalMeta.title || undefined,
      author: originalMeta.author || undefined,
      subject: originalMeta.subject || undefined,
      creator: originalMeta.creator || "documonster"
    });

    return writer.build();
  }

  /**
   * Save the modified PDF using incremental update.
   *
   * Appends new/modified objects after the original PDF bytes, preserving the
   * original data byte-for-byte. This is ideal for overlays and form field
   * updates on existing pages — it preserves digital signatures on unmodified
   * content and produces smaller output.
   *
   * Falls back to {@link save} (full rebuild) if structural changes are
   * present (new pages, copied pages, or removed pages).
   *
   * @returns The modified PDF as Uint8Array
   */
  async saveIncremental(): Promise<Uint8Array> {
    // Fall back to full rebuild if structural changes are present
    if (
      this._newPages.length > 0 ||
      this._copiedPages.length > 0 ||
      this._removedPageIndices.size > 0
    ) {
      return this.save();
    }

    // Fall back to full rebuild if rotation overrides are present
    if (this._rotationOverrides.size > 0) {
      return this.save();
    }

    // Fall back to full rebuild for xref-stream PDFs (no "trailer" keyword)
    const tailBytes = this._doc.data.subarray(Math.max(0, this._doc.data.length - 1024));
    const tailStr = new TextDecoder().decode(tailBytes);
    if (!tailStr.includes("trailer")) {
      return this.save();
    }

    // Check if there are any modifications at all
    const hasOverlays = this._pages.some(p => p._hasOverlay());
    const hasFormUpdates = this._formFieldUpdates.size > 0;

    if (!hasOverlays && !hasFormUpdates) {
      // No modifications — return the original bytes
      return this._doc.data;
    }

    this._isIncrementalSave = true;
    this._fontManager.beginBuild();
    try {
      return await this._buildIncrementalUpdate();
    } finally {
      this._fontManager.endBuild();
      this._isIncrementalSave = false;
      this._writerForSave = null;
      this._clonedRefs.clear();
    }
  }

  /** @internal — Core incremental update logic, separated for try/finally cleanup. */
  private async _buildIncrementalUpdate(): Promise<Uint8Array> {
    // Determine the next available object number from the original PDF's /Size
    const originalSize = dictGetNumber(this._doc.trailer, "Size") ?? 1;
    let nextObjNum = originalSize;

    // Collect modified objects: objNum → serialized content
    const modifiedObjects = new Map<number, string | { dict: PdfDict; data: Uint8Array }>();

    // Check what kinds of modifications exist
    const hasOverlays = this._pages.some(p => p._hasOverlay());

    // We need a temporary PdfWriter for font resources used in overlays
    const writer = new PdfWriter();
    this._writerForSave = writer;
    this._clonedRefs = new Map();

    let fontDictStr = "";
    // Map of writer objNum → actual new objNum we'll use in the incremental update
    const writerFontObjRemap = new Map<number, number>();

    if (hasOverlays) {
      for (const page of this._pages) {
        page._overlay._stream.preflight();
      }
      // Write font resources via the writer (to serialize font objects)
      const fontObjectMap = await this._fontManager.writeFontResources(writer);

      // Remap all writer-allocated objects (fonts + their dependencies like
      // CID font descriptors, ToUnicode CMaps, etc.) into the incremental
      // update's object number space.
      const writerObjects = writer.getObjects();
      for (const obj of writerObjects) {
        if (!writerFontObjRemap.has(obj.objectNumber)) {
          writerFontObjRemap.set(obj.objectNumber, nextObjNum++);
        }
      }

      // Write all font objects into modifiedObjects with remapped refs
      for (const obj of writerObjects) {
        const newObjNum = writerFontObjRemap.get(obj.objectNumber)!;
        const remappedContent = this._remapRefsInString(obj.content, writerFontObjRemap);
        if (obj.streamData) {
          // Parse the remapped content back into a PdfDict for stream objects
          modifiedObjects.set(newObjNum, {
            dict: PdfDict.fromRawString(remappedContent),
            data: obj.streamData
          });
        } else {
          modifiedObjects.set(newObjNum, remappedContent);
        }
      }

      // Build a remapped font dict string
      const rawFontDict = this._fontManager.buildFontDictString(fontObjectMap);
      fontDictStr = this._remapRefsInString(rawFontDict, writerFontObjRemap);
    }

    const pagesInfo = this._doc.getPagesWithObjInfo();

    for (let i = 0; i < pagesInfo.length; i++) {
      const editorPage = this._pages[i];
      const { dict: pageDict, objNum: pageObjNum } = pagesInfo[i];

      if (pageObjNum === 0) {
        // Can't do incremental update without knowing the page object number.
        // Fall back to full rebuild (finally block handles cleanup).
        return this.save();
      }

      const pageHasOverlay = editorPage._hasOverlay();
      const pageHasFormUpdates = this._hasFormUpdatesForPage(pageDict);

      if (!pageHasOverlay && !pageHasFormUpdates) {
        continue; // Page is unchanged
      }

      // Build the updated page dictionary. We start from the original page
      // dict's entries and modify only what's necessary.
      const updatedPageDict = new PdfDict();

      // Copy all existing entries from the original page dict
      for (const [key, val] of pageDict.entries()) {
        if (key === "Contents" && pageHasOverlay) {
          continue; // We'll rewrite /Contents below
        }
        if (key === "Resources" && pageHasOverlay) {
          continue; // We'll rewrite /Resources below
        }
        if (key === "Annots" && pageHasFormUpdates) {
          continue; // We'll rewrite /Annots below
        }
        updatedPageDict.set(key, this._serializeOriginalValue(val));
      }

      if (pageHasOverlay) {
        // Create a new content stream object for the overlay
        const overlayStreamData = editorPage._overlay._stream.toUint8Array();
        const overlayObjNum = nextObjNum++;
        modifiedObjects.set(overlayObjNum, {
          dict: new PdfDict(),
          data: overlayStreamData
        });

        // Build the new /Contents array: original refs + overlay ref
        const originalContentsObj = pageDict.get("Contents");
        const contentRefs = this._collectOriginalContentRefs(originalContentsObj);
        contentRefs.push(pdfRef(overlayObjNum));

        const contentsStr =
          contentRefs.length === 1 ? contentRefs[0] : `[${contentRefs.join(" ")}]`;
        updatedPageDict.set("Contents", contentsStr);

        // Build merged resources: original + overlay fonts/images
        const originalResources = this._serializeOriginalResources(this._doc, pageDict);

        // For overlay images, write them as new objects
        const imageObjMap = new Map<string, number>();
        for (let imgIdx = 0; imgIdx < editorPage._overlay._images.length; imgIdx++) {
          const img = editorPage._overlay._images[imgIdx];
          const imgName = `${this._overlayResourcePrefix}Im${imgIdx + 1}`;
          const imgObjNum = nextObjNum++;
          imageObjMap.set(imgName, imgObjNum);
          modifiedObjects.set(
            imgObjNum,
            this._buildImageXObjectForIncremental(img.data, img.format)
          );
        }

        // Build overlay resource string
        let overlayStr = "<< ";
        if (fontDictStr) {
          overlayStr += `/Font ${fontDictStr} `;
        }
        if (imageObjMap.size > 0) {
          const entries = [...imageObjMap.entries()]
            .map(([name, objNum]) => `/${name} ${pdfRef(objNum)}`)
            .join(" ");
          overlayStr += `/XObject << ${entries} >> `;
        }
        overlayStr += ">>";

        const mergedResources = this._mergeResourceStrings(originalResources, overlayStr);
        // Write merged resources as a new object
        const resourcesObjNum = nextObjNum++;
        modifiedObjects.set(resourcesObjNum, mergedResources || "<< >>");
        updatedPageDict.set("Resources", pdfRef(resourcesObjNum));
      }

      if (pageHasFormUpdates) {
        // Build updated annotations list
        const annotsResult = this._buildIncrementalAnnots(pageDict, modifiedObjects, nextObjNum);
        nextObjNum = annotsResult.nextObjNum;
        if (annotsResult.annotRefs.length > 0) {
          updatedPageDict.set(
            "Annots",
            `[${annotsResult.annotRefs.map(r => pdfRef(r)).join(" ")}]`
          );
        }
      }

      // Write the updated page dict as a modified object (same object number as original)
      modifiedObjects.set(pageObjNum, updatedPageDict.toString());
    }

    if (modifiedObjects.size === 0) {
      return this._doc.data;
    }

    return buildIncremental(this._doc.data, modifiedObjects, new Map());
  }

  /**
   * Check if a page has form field updates in its annotations.
   * @internal
   */
  private _hasFormUpdatesForPage(pageDict: PdfDictValue): boolean {
    if (this._formFieldUpdates.size === 0) {
      return false;
    }

    const annotsObj = pageDict.get("Annots");
    if (!annotsObj) {
      return false;
    }

    const annotsResolved = this._doc.deref(annotsObj);
    if (!isPdfArray(annotsResolved)) {
      return false;
    }

    for (const annotRef of annotsResolved) {
      const annotDict = this._doc.derefDict(annotRef);
      if (!annotDict) {
        continue;
      }

      const subtype = dictGetName(annotDict, "Subtype");
      if (subtype === "Widget") {
        const fieldName = this._resolveFieldName(annotDict);
        if (fieldName && this._formFieldUpdates.has(fieldName)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Collect original /Contents refs as serialized ref strings.
   * For incremental update — preserves original object references.
   * @internal
   */
  private _collectOriginalContentRefs(contentsObj: PdfObject | undefined): string[] {
    if (!contentsObj) {
      return [];
    }

    if (isPdfRef(contentsObj)) {
      // Could be a single ref to a stream, or a ref to an array
      const resolved = this._doc.deref(contentsObj);
      if (isPdfArray(resolved)) {
        return resolved
          .filter((item): item is PdfRef => isPdfRef(item))
          .map(item => pdfRef(item.objNum, item.gen));
      }
      return [pdfRef(contentsObj.objNum, contentsObj.gen)];
    }

    if (isPdfArray(contentsObj)) {
      return contentsObj
        .filter((item): item is PdfRef => isPdfRef(item))
        .map(item => pdfRef(item.objNum, item.gen));
    }

    return [];
  }

  /**
   * Serialize a page's Resources dict preserving original object references.
   * Unlike _serializeResources which deep-clones into the writer, this keeps
   * the original object numbers intact for incremental updates.
   * @internal
   */
  private _serializeOriginalResources(doc: PdfDocument, pageDict: PdfDictValue): string {
    const resourcesDict = doc.resolvePageResources(pageDict);
    if (!resourcesDict || resourcesDict.size === 0) {
      return "<< >>";
    }

    const parts: string[] = ["<<"];
    for (const [key, val] of resourcesDict.entries()) {
      const serialized = this._serializeOriginalValue(val);
      if (serialized) {
        parts.push(`/${key} ${serialized}`);
      }
    }
    parts.push(">>");
    return parts.join(" ");
  }

  /**
   * Serialize a PDF value from the original document, preserving original refs.
   * Unlike _deepSerialize which clones refs into a new writer, this keeps
   * the original object numbers intact.
   * @internal
   */
  private _serializeOriginalValue(val: PdfObject): string {
    if (val === null || val === undefined) {
      return "null";
    }
    if (typeof val === "string") {
      // In parsed PDF objects, string type = PDF name (without leading /)
      // Uint8Array = PDF string literal
      return "/" + val;
    }
    if (typeof val === "number") {
      return pdfNumber(val);
    }
    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }
    if (val instanceof Uint8Array) {
      return pdfHexString(val);
    }
    if (isPdfRef(val)) {
      return pdfRef(val.objNum, val.gen);
    }
    if (isPdfArray(val)) {
      const items = val.map(item => this._serializeOriginalValue(item));
      return `[${items.join(" ")}]`;
    }
    if (val instanceof Map) {
      const parts: string[] = ["<<"];
      for (const [k, v] of (val as PdfDictValue).entries()) {
        parts.push(`/${k} ${this._serializeOriginalValue(v)}`);
      }
      parts.push(">>");
      return parts.join(" ");
    }
    return "";
  }

  /**
   * Replace object number references in a serialized string.
   * Maps old obj numbers (from temporary writer) to new obj numbers.
   * @internal
   */
  private _remapRefsInString(str: string, remap: Map<number, number>): string {
    // Replace patterns like "N G R" where N is in the remap map.
    // Linear scan avoids polynomial backtracking on untrusted PDF content.
    const parts: string[] = [];
    let last = 0;
    let i = 0;
    const len = str.length;

    while (i < len) {
      // Look for a digit
      if (str.charCodeAt(i) < 0x30 || str.charCodeAt(i) > 0x39) {
        i++;
        continue;
      }
      // Parse first number (object number)
      const numStart = i;
      while (i < len && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x39) {
        i++;
      }
      // Must be followed by " <digits> R"
      if (i >= len || str.charCodeAt(i) !== 0x20) {
        continue;
      }
      const genStart = i + 1;
      let g = genStart;
      while (g < len && str.charCodeAt(g) >= 0x30 && str.charCodeAt(g) <= 0x39) {
        g++;
      }
      if (g === genStart || g >= len || str.charCodeAt(g) !== 0x20) {
        continue;
      }
      if (g + 1 >= len || str.charCodeAt(g + 1) !== 0x52 /* 'R' */) {
        continue;
      }
      // Ensure R is not followed by another word char (boundary check)
      const afterR = g + 2;
      if (
        afterR < len &&
        str.charCodeAt(afterR) > 0x20 &&
        str.charCodeAt(afterR) !== 0x2f /* '/' */ &&
        str.charCodeAt(afterR) !== 0x3e /* '>' */
      ) {
        continue;
      }

      const objNum = parseInt(str.slice(numStart, i), 10);
      const remapped = remap.get(objNum);
      if (remapped !== undefined) {
        parts.push(str.slice(last, numStart));
        parts.push(`${remapped} ${str.slice(genStart, g)} R`);
        last = afterR;
      }
      i = afterR;
    }

    if (last === 0) {
      return str;
    }
    parts.push(str.slice(last));
    return parts.join("");
  }

  /**
   * Build image XObject content for incremental update.
   * @internal
   */
  private _buildImageXObjectForIncremental(
    data: Uint8Array,
    format: string
  ): { dict: PdfDict; data: Uint8Array } {
    const dims = parseImageDimensions(data, format as "jpeg" | "png");
    const dict = new PdfDict()
      .set("Type", "/XObject")
      .set("Subtype", "/Image")
      .set("Width", pdfNumber(dims.width))
      .set("Height", pdfNumber(dims.height))
      .set("BitsPerComponent", "8")
      .set("ColorSpace", "/DeviceRGB");

    if (format === "jpeg") {
      dict.set("Filter", "/DCTDecode");
    }

    return { dict, data };
  }

  /**
   * Build updated annotations for incremental save.
   * Modified widgets get rewritten at their original object number;
   * unmodified annots keep original refs.
   * @internal
   */
  private _buildIncrementalAnnots(
    pageDict: PdfDictValue,
    modifiedObjects: Map<number, string | { dict: PdfDict; data: Uint8Array }>,
    nextObjNum: number
  ): { annotRefs: number[]; nextObjNum: number } {
    const annotsObj = pageDict.get("Annots");
    if (!annotsObj) {
      return { annotRefs: [], nextObjNum };
    }

    const annotsResolved = this._doc.deref(annotsObj);
    if (!isPdfArray(annotsResolved)) {
      return { annotRefs: [], nextObjNum };
    }

    const annotRefs: number[] = [];

    for (const annotRef of annotsResolved) {
      const annotDict = this._doc.derefDict(annotRef);
      if (!annotDict) {
        // Keep original ref if we can't resolve
        if (isPdfRef(annotRef)) {
          annotRefs.push(annotRef.objNum);
        }
        continue;
      }

      const subtype = dictGetName(annotDict, "Subtype");

      if (subtype === "Widget" && this._formFieldUpdates.size > 0) {
        const fieldName = this._resolveFieldName(annotDict);
        const newValue = fieldName ? this._formFieldUpdates.get(fieldName) : undefined;

        if (newValue !== undefined) {
          // Rewrite the annotation at its original object number
          const annotObjNum = isPdfRef(annotRef) ? annotRef.objNum : nextObjNum++;
          const newDict = this._buildModifiedWidgetDict(annotDict, newValue);
          modifiedObjects.set(annotObjNum, newDict);
          annotRefs.push(annotObjNum);
          continue;
        }
      }

      // Keep original annotation reference
      if (isPdfRef(annotRef)) {
        annotRefs.push(annotRef.objNum);
      } else {
        // Inline annotation — write as new object
        const annotObjNum = nextObjNum++;
        const serialized = this._serializeAnnotDict(annotDict);
        modifiedObjects.set(annotObjNum, serialized);
        annotRefs.push(annotObjNum);
      }
    }

    return { annotRefs, nextObjNum };
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /** Page-level keys to preserve when rebuilding page dicts. */
  private static readonly _PAGE_PRESERVE_KEYS = [
    "Rotate",
    "CropBox",
    "BleedBox",
    "TrimBox",
    "ArtBox",
    "Group",
    "UserUnit",
    "Tabs"
  ] as const;

  /** @internal - Copy preserved page properties from source to target dict. */
  private _copyPageProperties(source: PdfDictValue, target: PdfDict, doc?: PdfDocument): void {
    const resolveDoc = doc ?? this._doc;
    for (const key of PdfEditor._PAGE_PRESERVE_KEYS) {
      const val = source.get(key);
      if (val !== undefined && val !== null) {
        target.set(key, this._deepSerialize(resolveDoc, val));
      }
    }
  }

  /**
   * Sign this PDF with a digital signature.
   *
   * Performs a full save with an embedded PKCS#7 signature placeholder,
   * then fills in the real CMS SignedData.
   *
   * @param options - Certificate, private key, and optional signer metadata
   * @returns The signed PDF as Uint8Array
   *
   * @example
   * ```typescript
   * const editor = PdfEditor.load(pdfBytes);
   * const signed = await editor.sign({
   *   certificate: certDerBytes,
   *   privateKey: pkcs8DerBytes,
   *   name: "Jane Doe",
   *   reason: "Approval"
   * });
   * ```
   */
  async sign(options: PdfSignatureOptions): Promise<Uint8Array> {
    const { buildSignatureDictPlaceholder, signPdf } = await import("@pdf/core/digital-signature");

    const { dictString } = buildSignatureDictPlaceholder({
      name: options.name,
      reason: options.reason,
      location: options.location,
      contactInfo: options.contactInfo
    });

    // Inject the signature placeholder into the form field updates
    // so that save() includes it in the output
    this._signaturePlaceholder = dictString;
    let pdfWithPlaceholder: Uint8Array;
    try {
      pdfWithPlaceholder = await this.save();
    } finally {
      this._signaturePlaceholder = null;
    }

    return signPdf(pdfWithPlaceholder, options.certificate, options.privateKey);
  }

  /** @internal - Collect decoded content stream bytes from a page dict. */
  private _collectContentStreams(doc: PdfDocument, pageDict: PdfDictValue): Uint8Array[] {
    const contentsObj = pageDict.get("Contents");
    if (!contentsObj) {
      return [];
    }

    if (isPdfRef(contentsObj)) {
      const result = doc.derefStreamWithObjNum(contentsObj);
      if (result) {
        return [doc.getStreamData(result.stream, result.objNum, result.gen)];
      }
      // Could be a ref to an array
      const resolved = doc.deref(contentsObj);
      if (isPdfArray(resolved)) {
        return this._resolveStreamArray(doc, resolved);
      }
      return [];
    }

    if (isPdfArray(contentsObj)) {
      return this._resolveStreamArray(doc, contentsObj);
    }

    return [];
  }

  /** @internal */
  private _resolveStreamArray(doc: PdfDocument, arr: PdfObject[]): Uint8Array[] {
    const result: Uint8Array[] = [];
    for (const item of arr) {
      const r = doc.derefStreamWithObjNum(item);
      if (r) {
        result.push(doc.getStreamData(r.stream, r.objNum, r.gen));
      }
    }
    return result;
  }

  /** @internal - Serialize a page's Resources dict by deep-cloning objects into the writer. */
  private _serializeResources(doc: PdfDocument, pageDict: PdfDictValue): string {
    const resourcesDict = doc.resolvePageResources(pageDict);
    if (!resourcesDict || resourcesDict.size === 0) {
      return "<< >>";
    }

    // Deep-clone the resources dict into the writer.
    // We need to re-emit Font, XObject, ExtGState sub-dicts with their
    // referenced objects written as new indirect objects in the writer.
    return this._serializeDictToWriter(doc, resourcesDict);
  }

  /**
   * @internal - Recursively serialize a PdfDictValue, writing stream objects
   * as new indirect objects and converting refs to new writer refs.
   */
  private _serializeDictToWriter(doc: PdfDocument, dict: PdfDictValue): string {
    const parts: string[] = ["<<"];

    for (const [key, val] of dict.entries()) {
      const serialized = this._deepSerialize(doc, val);
      if (serialized) {
        parts.push(`/${key} ${serialized}`);
      }
    }

    parts.push(">>");
    return parts.join(" ");
  }

  /**
   * @internal - Deep-serialize a PDF value.
   * For indirect refs: resolve the target, write it as a new object in the writer,
   * and return a ref to the new object.
   * For dicts/arrays: recurse.
   */
  private _deepSerialize(doc: PdfDocument, val: PdfObject): string {
    if (val === null || val === undefined) {
      return "null";
    }
    if (typeof val === "string") {
      // In parsed PDF objects, string type = PDF name (without leading /)
      return "/" + val;
    }
    if (typeof val === "number") {
      return pdfNumber(val);
    }
    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }
    if (val instanceof Uint8Array) {
      return pdfHexString(val);
    }

    if (isPdfRef(val)) {
      // Check if this ref has already been cloned
      const docId = doc === this._doc ? "main" : `src${doc.data.length}`;
      const cacheKey = `${docId}:${val.objNum}:${val.gen}`;
      const cached = this._clonedRefs.get(cacheKey);
      if (cached !== undefined) {
        return pdfRef(cached);
      }

      // Try as stream first
      const streamResult = doc.derefStreamWithObjNum(val);
      if (streamResult) {
        const newObjNum = this._writerForSave!.allocObject();
        this._clonedRefs.set(cacheKey, newObjNum);

        // Get the decoded stream data
        const streamData = doc.getStreamData(
          streamResult.stream,
          streamResult.objNum,
          streamResult.gen
        );

        // Serialize the stream's dict (excluding /Length which will be set automatically)
        const streamDict = new PdfDict();
        for (const [k, v] of streamResult.stream.dict.entries()) {
          if (k === "Length" || k === "Filter" || k === "DecodeParms") {
            // Skip — the writer will re-compress and set these
            continue;
          }
          const sv = this._deepSerialize(doc, v);
          if (sv) {
            streamDict.set(k, sv);
          }
        }

        this._writerForSave!.addStreamObject(newObjNum, streamDict, streamData);
        return pdfRef(newObjNum);
      }

      // Try as regular dict/value
      const resolved = doc.deref(val);
      if (resolved instanceof Map) {
        const newObjNum = this._writerForSave!.allocObject();
        this._clonedRefs.set(cacheKey, newObjNum);
        const dictStr = this._serializeDictToWriter(doc, resolved as PdfDictValue);
        this._writerForSave!.addObject(newObjNum, dictStr);
        return pdfRef(newObjNum);
      }

      // Primitive value behind a ref — just inline it
      return this._deepSerialize(doc, resolved);
    }

    if (isPdfArray(val)) {
      const items = val.map(item => this._deepSerialize(doc, item));
      return `[${items.join(" ")}]`;
    }

    if (val instanceof Map) {
      return this._serializeDictToWriter(doc, val as PdfDictValue);
    }

    return "";
  }

  /** @internal */
  private _writeOverlayImages(writer: PdfWriter, page: PdfPageBuilder): Map<string, number> {
    const map = new Map<string, number>();
    for (let i = 0; i < page._images.length; i++) {
      const img = page._images[i];
      const imgName = `${this._overlayResourcePrefix}Im${i + 1}`;
      const objNum = writeImageXObject(writer, img.data, img.format);
      map.set(imgName, objNum);
    }
    return map;
  }

  /** @internal - Build overlay resources as a structured PdfResourceDict. */
  private _buildOverlayResourceDict(
    writer: PdfWriter,
    overlay: PdfPageBuilder | undefined,
    fontDictStr: string,
    imageXObjectMap: Map<string, number>
  ): PdfResourceDict {
    const dict: PdfResourceDict = new Map();

    if (fontDictStr) {
      // Parse the font dict string into structured entries
      // fontDictStr is already a `<< /F1 3 0 R ... >>` string
      const fontInner = fontDictStr.trim();
      if (fontInner.startsWith("<<") && fontInner.endsWith(">>")) {
        const parsed = parseResourceDict(`<< /Font ${fontInner} >>`);
        const fontMap = parsed.get("Font");
        if (fontMap) {
          dict.set("Font", fontMap);
        }
      }
    }

    if (imageXObjectMap.size > 0) {
      const xobjMap = new Map<string, string>();
      for (const [name, objNum] of imageXObjectMap) {
        xobjMap.set(name, pdfRef(objNum));
      }
      dict.set("XObject", xobjMap);
    }

    // Serialise `PdfPageBuilder._alphaValues` into an `/ExtGState` sub-dict.
    // Previously this path only wrote `/Font` + `/XObject`, so any alpha
    // emitted by `_applyAlpha` (e.g. a chart with filled radar / translucent
    // area rendered via `drawChartPdf`) left the `gs` operator pointing at
    // an undefined resource. The scheme matches `pdf-exporter.ts:377-389`
    // and `document-builder.ts` so the three pipelines stay name-compatible.
    if (overlay && overlay._alphaValues.size > 0) {
      const gsMap = new Map<string, string>();
      for (const alpha of overlay._alphaValues) {
        const gsObjNum = writer.allocObject();
        const gsDict = new PdfDict()
          .set("Type", "/ExtGState")
          .set("ca", pdfNumber(alpha))
          .set("CA", pdfNumber(alpha));
        writer.addObject(gsObjNum, gsDict);
        gsMap.set(alphaGsName(alpha, this._overlayResourcePrefix), pdfRef(gsObjNum));
      }
      dict.set("ExtGState", gsMap);
    }

    return dict;
  }

  /** @internal - Merge original and overlay resource strings via parsed object graph. */
  private _mergeResourceStrings(original: string, overlay: string): string {
    // If no overlay, return original
    if (!overlay || overlay === "<< >>") {
      return original;
    }
    // If no original, return overlay
    if (!original || original === "<< >>") {
      return overlay;
    }

    const origDict = parseResourceDict(original);
    const overlayDict = parseResourceDict(overlay);
    const merged = mergeResourceDicts(origDict, overlayDict);
    return serializeResourceDict(merged);
  }

  /** @internal - Write form field value updates as annotation objects. */
  private _writeFormFieldUpdates(
    writer: PdfWriter,
    pageDict: PdfDictValue,
    _pageIndex: number
  ): number[] {
    if (this._formFieldUpdates.size === 0) {
      return this._copyExistingAnnots(writer, pageDict);
    }

    // Get existing annotations
    const annotRefs = this._copyExistingAnnots(writer, pageDict);

    // We handle form field updates by modifying Widget annotations.
    // This is done during the annotation copy above — if we find a Widget
    // annotation whose field name matches an update, we modify its /V value.
    return annotRefs;
  }

  /** @internal */
  private _copyExistingAnnots(writer: PdfWriter, pageDict: PdfDictValue): number[] {
    const annotsObj = pageDict.get("Annots");
    if (!annotsObj) {
      return [];
    }

    const annotsResolved = this._doc.deref(annotsObj);
    if (!isPdfArray(annotsResolved)) {
      return [];
    }

    const annotRefs: number[] = [];

    for (const annotRef of annotsResolved) {
      const annotDict = this._doc.derefDict(annotRef);
      if (!annotDict) {
        continue;
      }

      const subtype = dictGetName(annotDict, "Subtype");
      const objNum = writer.allocObject();

      if (subtype === "Widget" && this._formFieldUpdates.size > 0) {
        // Check if this widget has a field name that matches an update
        const fieldName = this._resolveFieldName(annotDict);
        const newValue = fieldName ? this._formFieldUpdates.get(fieldName) : undefined;

        if (newValue !== undefined) {
          // Write a modified widget annotation with the new value
          const newDict = this._buildModifiedWidgetDict(annotDict, newValue);
          writer.addObject(objNum, newDict);
          annotRefs.push(objNum);
          continue;
        }
      }

      // Copy annotation as-is (serialize what we can)
      const serialized = this._serializeAnnotDict(annotDict);
      writer.addObject(objNum, serialized);
      annotRefs.push(objNum);
    }

    return annotRefs;
  }

  /** @internal */
  private _resolveFieldName(dict: PdfDictValue): string {
    const parts: string[] = [];
    let current: PdfDictValue | null | undefined = dict;
    const visited = new Set<string>();

    while (current) {
      const tVal = current.get("T");
      if (tVal) {
        const resolved = this._doc.deref(tVal);
        let name = "";
        if (typeof resolved === "string") {
          name = resolved;
        } else if (resolved instanceof Uint8Array) {
          name = decodePdfStringBytes(resolved);
        }
        if (name) {
          parts.unshift(name);
        }
      }

      const parentVal = current.get("Parent");
      if (!parentVal) {
        break;
      }

      // Cycle guard
      const key = String(parentVal);
      if (visited.has(key)) {
        break;
      }
      visited.add(key);

      current = this._doc.derefDict(parentVal);
    }

    return parts.join(".");
  }

  /** @internal */
  private _buildModifiedWidgetDict(originalDict: PdfDictValue, newValue: string): string {
    // Determine the field type (/FT) — may be directly on the widget or inherited from parent
    const fieldType = this._resolveFieldType(originalDict);

    // For text fields, generate an appearance stream instead of stripping /AP
    if (fieldType === "Tx" && this._writerForSave) {
      return this._buildTextFieldWidgetDict(originalDict, newValue);
    }

    // For non-text fields, fall back to stripping /AP (force viewer to regenerate)
    const parts: string[] = ["<<"];

    for (const [key, val] of originalDict.entries()) {
      if (key === "V" || key === "AP") {
        continue;
      }

      const serialized = this._serializePdfValue(val);
      if (serialized) {
        parts.push(`/${key} ${serialized}`);
      }
    }

    parts.push(`/V ${pdfString(newValue)}`);
    parts.push(">>");
    return parts.join(" ");
  }

  /**
   * @internal - Build a modified widget dict for a text field with an inline
   * appearance stream. The stream renders the field value so it is visible
   * in all viewers, even those that ignore /NeedAppearances.
   */
  private _buildTextFieldWidgetDict(originalDict: PdfDictValue, newValue: string): string {
    const writer = this._writerForSave!;

    // Extract the widget Rect for sizing the appearance
    const rect = this._resolveWidgetRect(originalDict);

    // Determine alignment from /Q entry (0=left, 1=center, 2=right)
    const qVal = originalDict.get("Q");
    let alignment: "left" | "center" | "right" = "left";
    if (qVal === 1) {
      alignment = "center";
    } else if (qVal === 2) {
      alignment = "right";
    }

    // Generate the appearance stream
    const { stream, resources } = generateTextFieldAppearance({
      value: newValue,
      rect,
      alignment
    });

    // Write the appearance stream as a Form XObject indirect object
    const apObjNum = writer.allocObject();
    const apDict = new PdfDict()
      .set("Type", "/XObject")
      .set("Subtype", "/Form")
      .set("BBox", buildAppearanceBBox(rect))
      .set("Resources", resources);
    writer.addStreamObject(apObjNum, apDict, stream, { compress: false });

    // Build the widget dict
    const parts: string[] = ["<<"];

    for (const [key, val] of originalDict.entries()) {
      if (key === "V" || key === "AP") {
        continue;
      }

      const serialized = this._serializePdfValue(val);
      if (serialized) {
        parts.push(`/${key} ${serialized}`);
      }
    }

    // Set the new value and appearance
    parts.push(`/V ${pdfString(newValue)}`);
    parts.push(`/AP << /N ${pdfRef(apObjNum)} >>`);

    parts.push(">>");
    return parts.join(" ");
  }

  /**
   * @internal - Resolve the field type (/FT) which may be inherited from a parent dict.
   */
  private _resolveFieldType(dict: PdfDictValue): string | undefined {
    let current: PdfDictValue | null | undefined = dict;
    const visited = new Set<string>();

    while (current) {
      const ft = dictGetName(current, "FT");
      if (ft) {
        return ft;
      }
      const parentVal = current.get("Parent");
      if (!parentVal) {
        break;
      }
      const key = String(parentVal);
      if (visited.has(key)) {
        break;
      }
      visited.add(key);
      current = this._doc.derefDict(parentVal);
    }
    return undefined;
  }

  /**
   * @internal - Extract the /Rect array from a widget annotation dict as [x1, y1, x2, y2].
   */
  private _resolveWidgetRect(dict: PdfDictValue): number[] {
    let rectVal = dict.get("Rect");
    if (rectVal) {
      rectVal = this._doc.deref(rectVal);
    }
    if (rectVal && isPdfArray(rectVal)) {
      return rectVal.map(v => (typeof v === "number" ? v : 0));
    }
    // Fallback: 0-size rect
    return [0, 0, 100, 20];
  }

  /** @internal */
  private _serializeAnnotDict(dict: PdfDictValue): string {
    const parts: string[] = ["<<"];

    for (const [key, val] of dict.entries()) {
      const serialized = this._serializePdfValue(val);
      if (serialized) {
        parts.push(`/${key} ${serialized}`);
      }
    }

    parts.push(">>");
    return parts.join(" ");
  }

  /** @internal */
  private _serializePdfValue(val: PdfObject): string {
    if (val === null || val === undefined) {
      return "null";
    }
    if (typeof val === "string") {
      // In parsed PDF objects, string type = PDF name (without leading /)
      return "/" + val;
    }
    if (typeof val === "number") {
      return pdfNumber(val);
    }
    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }
    if (val instanceof Uint8Array) {
      return pdfHexString(val);
    }
    if (isPdfRef(val)) {
      // During incremental save, original refs remain valid — preserve them as-is.
      // During full save, deep-clone into the new writer.
      if (this._writerForSave && !this._isIncrementalSave) {
        return this._deepSerialize(this._doc, val);
      }
      return `${val.objNum} ${val.gen} R`;
    }
    if (isPdfArray(val)) {
      const items = val.map(item => this._serializePdfValue(item));
      return `[${items.join(" ")}]`;
    }
    if (val instanceof Map) {
      const parts: string[] = ["<<"];
      for (const [k, v] of val.entries()) {
        const serialized = this._serializePdfValue(v as PdfObject);
        parts.push(`/${k} ${serialized}`);
      }
      parts.push(">>");
      return parts.join(" ");
    }
    return "";
  }
}

// =============================================================================
// Internal Types
// =============================================================================

interface CopiedPage {
  width: number;
  height: number;
  contentStreams: Uint8Array[];
  /** Source doc + page dict — for deferred resource deep-clone during save() */
  sourceDoc: PdfDocument;
  sourcePageDict: PdfDictValue;
}
