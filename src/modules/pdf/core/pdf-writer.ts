/**
 * PDF file writer.
 *
 * Assembles a complete PDF 2.0 document from indirect objects.
 * Handles the four sections of a PDF file:
 * 1. Header (%PDF-2.0)
 * 2. Body (indirect objects)
 * 3. Cross-reference table
 * 4. Trailer (with document catalog reference)
 *
 * Also provides {@link buildIncremental} for appending incremental updates
 * to an existing PDF without rewriting the original bytes.
 *
 * Encryption uses AES-256 (V=5, R=5) per ISO 32000-2:2020.
 *
 * @see ISO 32000-2:2020, Chapter 7.5 — File Structure
 */

import { zlibSync } from "@archive/compression/compress";
import type { EncryptionState } from "@pdf/core/encryption";
import { encryptData } from "@pdf/core/encryption";
import { PdfDict, pdfRef, pdfString, pdfHexString, pdfDate, pdfNumber } from "@pdf/core/pdf-object";
import type { PdfContentStream } from "@pdf/core/pdf-stream";
import { PdfStructureError } from "@pdf/errors";
import { concatUint8Arrays } from "@utils/binary";

// =============================================================================
// Types
// =============================================================================

interface PdfIndirectObject {
  objectNumber: number;
  /** Byte offset of the object in the output buffer */
  offset: number;
  /** Serialized content (between `N 0 obj` and `endobj`) */
  content: string;
}

interface PdfStreamObject extends PdfIndirectObject {
  streamData: Uint8Array;
}

// =============================================================================
// PDF Writer
// =============================================================================

/**
 * Constructs a valid PDF 2.0 file from a set of indirect objects.
 *
 * Usage:
 * 1. Allocate object numbers with allocObject()
 * 2. Add objects with addObject() or addStreamObject()
 * 3. Call build() to produce the final Uint8Array
 */
export class PdfWriter {
  private nextObjectNumber = 1;
  private objects: Array<PdfIndirectObject | PdfStreamObject> = [];
  private catalogRef = 0;
  private infoRef = 0;
  private encryption: EncryptionState | null = null;
  private pdfVersion = "2.0";

  /**
   * Set the PDF version string (e.g. "1.4", "1.7", "2.0").
   * Default is "2.0".
   */
  setVersion(version: string): void {
    this.pdfVersion = version;
  }

  /**
   * Enable encryption for this document.
   */
  setEncryption(state: EncryptionState): void {
    this.encryption = state;
  }

  // ===========================================================================
  // Object Management
  // ===========================================================================

  /**
   * Allocate the next object number without adding content yet.
   * Use this for forward references (e.g., page references in the page tree).
   */
  allocObject(): number {
    return this.nextObjectNumber++;
  }

  /**
   * Add a dictionary object to the PDF.
   * @param objectNumber - Previously allocated object number
   * @param dict - The dictionary content
   */
  addObject(objectNumber: number, dict: PdfDict | string): void {
    this.objects.push({
      objectNumber,
      offset: 0,
      content: typeof dict === "string" ? dict : dict.toString()
    });
  }

  /**
   * Add a stream object (dictionary + binary stream data) to the PDF.
   * The /Length key is automatically added to the dictionary.
   *
   * @param objectNumber - Previously allocated object number
   * @param dict - The stream dictionary
   * @param data - Stream content (PdfContentStream or raw Uint8Array)
   * @param options - Optional settings (e.g. `{ compress: false }` to skip zlib)
   */
  addStreamObject(objectNumber: number, dict: PdfDict, stream: PdfContentStream): void;
  addStreamObject(objectNumber: number, dict: PdfDict, data: Uint8Array): void;
  addStreamObject(
    objectNumber: number,
    dict: PdfDict,
    data: Uint8Array,
    options: { compress?: boolean }
  ): void;
  addStreamObject(
    objectNumber: number,
    dict: PdfDict,
    data: PdfContentStream | Uint8Array,
    options?: { compress?: boolean }
  ): void {
    let streamData = data instanceof Uint8Array ? data : data.toUint8Array();
    const compress = options?.compress ?? true;

    // Compress with zlib (RFC 1950) for PDF /FlateDecode
    if (compress && streamData.length > 256 && !dict.toString().includes("/Filter")) {
      const compressed = zlibSync(streamData, { level: 6 });
      if (compressed.length < streamData.length) {
        dict.set("Filter", "/FlateDecode");
        streamData = compressed;
      }
    }

    // NOTE: Stream encryption is deferred to build() time so that
    // setEncryption() can be called after all objects are added.
    // We store a "needsEncryption" flag; the /Length is set in build()
    // after potential encryption changes the size.
    dict.set("Length", pdfNumber(streamData.length));
    (this.objects as PdfStreamObject[]).push({
      objectNumber,
      offset: 0,
      content: dict.toString(),
      streamData
    });
  }

  /**
   * Return all stored objects for inspection (e.g., incremental update remapping).
   * Stream objects include their binary data.
   */
  getObjects(): Array<{
    objectNumber: number;
    content: string;
    streamData?: Uint8Array;
  }> {
    return this.objects.map(o => {
      const result: { objectNumber: number; content: string; streamData?: Uint8Array } = {
        objectNumber: o.objectNumber,
        content: o.content
      };
      if ("streamData" in o) {
        result.streamData = (o as PdfStreamObject).streamData;
      }
      return result;
    });
  }

  /**
   * Set the document catalog object number.
   * This is required and references the root of the document structure.
   */
  setCatalog(objectNumber: number): void {
    this.catalogRef = objectNumber;
  }

  // ===========================================================================
  // Document Info Dictionary
  // ===========================================================================

  /**
   * Create and add the document information dictionary.
   */
  addInfoDict(options: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
  }): number {
    const objNum = this.allocObject();
    const dict = new PdfDict();

    if (options.title) {
      dict.set("Title", pdfString(options.title));
    }
    if (options.author) {
      dict.set("Author", pdfString(options.author));
    }
    if (options.subject) {
      dict.set("Subject", pdfString(options.subject));
    }
    if (options.creator) {
      dict.set("Creator", pdfString(options.creator));
    }
    dict.set("Producer", pdfString("documonster"));
    dict.set("CreationDate", pdfDate(new Date()));

    this.addObject(objNum, dict);
    this.infoRef = objNum;
    return objNum;
  }

  // ===========================================================================
  // Page Tree Helpers
  // ===========================================================================

  /**
   * Create and add a Page dictionary.
   */
  addPage(options: {
    parentRef: number;
    width: number;
    height: number;
    contentsRef: number | string;
    resourcesRef: number;
    annotRefs?: number[];
    /**
     * Declare a transparency group for the page. Required whenever the content
     * uses transparency features (constant alpha, soft masks, blend modes):
     * without it the backdrop a blend composites against is implementation
     * defined, and a consumer that ignores the blend mode can paint a
     * `/Saturation` overlay as opaque black.
     */
    transparencyGroup?: boolean;
  }): number {
    const objNum = this.allocObject();
    const mediaBox = `[0 0 ${pdfNumber(options.width)} ${pdfNumber(options.height)}]`;
    const contentsValue =
      typeof options.contentsRef === "string" ? options.contentsRef : pdfRef(options.contentsRef);
    const dict = new PdfDict()
      .set("Type", "/Page")
      .set("Parent", pdfRef(options.parentRef))
      .set("MediaBox", mediaBox)
      .set("Contents", contentsValue)
      .set("Resources", pdfRef(options.resourcesRef));
    if (options.transparencyGroup) {
      dict.set("Group", "<< /S /Transparency /CS /DeviceRGB /I false /K false >>");
    }
    if (options.annotRefs && options.annotRefs.length > 0) {
      dict.set("Annots", "[" + options.annotRefs.map(r => pdfRef(r)).join(" ") + "]");
    }
    this.addObject(objNum, dict);
    return objNum;
  }

  /**
   * Create and add the Catalog dictionary.
   *
   * @param pagesRef - Object number of the Pages tree root
   * @param optionsOrOutlinesRef - Either an outlinesRef number (legacy) or an options object
   */
  addCatalog(
    pagesRef: number,
    optionsOrOutlinesRef?:
      | number
      | {
          outlinesRef?: number;
          extraEntries?: Array<[key: string, value: string]>;
        }
  ): number {
    const resolvedOptions =
      typeof optionsOrOutlinesRef === "number"
        ? { outlinesRef: optionsOrOutlinesRef }
        : (optionsOrOutlinesRef ?? {});

    const objNum = this.allocObject();
    const dict = new PdfDict().set("Type", "/Catalog").set("Pages", pdfRef(pagesRef));
    if (resolvedOptions.outlinesRef) {
      dict.set("Outlines", pdfRef(resolvedOptions.outlinesRef));
      dict.set("PageMode", "/UseOutlines");
    }
    if (resolvedOptions.extraEntries) {
      for (const [key, value] of resolvedOptions.extraEntries) {
        dict.set(key, value);
      }
    }
    this.addObject(objNum, dict);
    this.setCatalog(objNum);
    return objNum;
  }

  // ===========================================================================
  // Build
  // ===========================================================================

  /**
   * Build the complete PDF file as a Uint8Array.
   */
  build(): Uint8Array {
    if (this.catalogRef === 0) {
      throw new PdfStructureError("No catalog object set. Call addCatalog() before build().");
    }

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let byteOffset = 0;

    // --- Header ---
    // Include a comment with high bytes to signal binary content per PDF spec §3.4.1
    const headerStr = `%PDF-${this.pdfVersion}\n`;
    const headerStrBytes = encoder.encode(headerStr);
    chunks.push(headerStrBytes);
    byteOffset += headerStrBytes.length;
    // Binary comment: raw high-bit bytes (not via TextEncoder to avoid UTF-8 multibyte)
    const binaryComment = new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
    chunks.push(binaryComment);
    byteOffset += binaryComment.length;

    // Sort objects by object number for deterministic output
    this.objects.sort((a, b) => a.objectNumber - b.objectNumber);

    // Pre-allocate encrypt object number (content written later, after body)
    const encryptObjNum = this.encryption ? this.allocObject() : 0;

    // --- Body (indirect objects) ---
    for (const obj of this.objects) {
      obj.offset = byteOffset;

      const objHeader = `${obj.objectNumber} 0 obj\n`;
      const objHeaderBytes = encoder.encode(objHeader);
      chunks.push(objHeaderBytes);
      byteOffset += objHeaderBytes.length;

      // Encrypt string literals in object content (if encryption enabled)
      let content = obj.content;
      if (this.encryption && obj.objectNumber !== encryptObjNum) {
        content = encryptStringsInContent(
          content,
          obj.objectNumber,
          0,
          this.encryption.encryptionKey
        );
      }

      // If this is a stream object, encrypt stream data and update /Length
      let streamBytes: Uint8Array | null = null;
      if ("streamData" in obj && obj.streamData) {
        streamBytes = obj.streamData;
        if (this.encryption && obj.objectNumber !== encryptObjNum) {
          streamBytes = encryptData(
            streamBytes,
            obj.objectNumber,
            0,
            this.encryption.encryptionKey
          );
          // Update /Length in content to reflect encrypted size
          content = content.replace(/\/Length \d+/, `/Length ${streamBytes.length}`);
        }
      }

      const contentBytes = encoder.encode(content + "\n");
      chunks.push(contentBytes);
      byteOffset += contentBytes.length;

      // Write stream data if present
      if (streamBytes) {
        const streamStart = encoder.encode("stream\n");
        chunks.push(streamStart);
        byteOffset += streamStart.length;

        chunks.push(streamBytes);
        byteOffset += streamBytes.length;

        const streamEnd = encoder.encode("\nendstream\n");
        chunks.push(streamEnd);
        byteOffset += streamEnd.length;
      }

      const objFooter = encoder.encode("endobj\n");
      chunks.push(objFooter);
      byteOffset += objFooter.length;
    }

    // --- Encrypt dictionary (V=5, R=5, AES-256) ---
    if (this.encryption) {
      const encDict = new PdfDict()
        .set("Filter", "/Standard")
        .set("V", "5")
        .set("R", "5")
        .set("Length", "256")
        .set("P", String(this.encryption.permissions))
        .set("O", pdfHexString(this.encryption.oValue))
        .set("U", pdfHexString(this.encryption.uValue))
        .set("OE", pdfHexString(this.encryption.oeValue))
        .set("UE", pdfHexString(this.encryption.ueValue))
        .set("Perms", pdfHexString(this.encryption.permsValue))
        .set("EncryptMetadata", "true")
        .set(
          "CF",
          "<< /StdCF << /Type /CryptFilter /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >>"
        )
        .set("StmF", "/StdCF")
        .set("StrF", "/StdCF");
      const encContent = encDict.toString();
      const encObj: PdfIndirectObject = {
        objectNumber: encryptObjNum,
        offset: byteOffset,
        content: encContent
      };
      this.objects.push(encObj);

      const encHeader = encoder.encode(`${encryptObjNum} 0 obj\n`);
      chunks.push(encHeader);
      byteOffset += encHeader.length;
      const encBody = encoder.encode(encContent + "\n");
      chunks.push(encBody);
      byteOffset += encBody.length;
      const encFooter = encoder.encode("endobj\n");
      chunks.push(encFooter);
      byteOffset += encFooter.length;
    }

    // --- Cross-Reference Table ---
    const xrefOffset = byteOffset;

    const objMap = new Map<number, PdfIndirectObject>();
    for (const obj of this.objects) {
      objMap.set(obj.objectNumber, obj);
    }
    const maxObjNum = this.objects.reduce((max, o) => Math.max(max, o.objectNumber), 0);

    const xrefLines: string[] = [];
    xrefLines.push("xref");
    xrefLines.push(`0 ${maxObjNum + 1}`);

    // Build a proper free list per PDF spec §3.4.3:
    // Object 0 is always free and points to the next free object.
    // Each free entry's first field is the next free object number.
    // Generation number is 65535 for never-used entries.
    // The last free entry points back to 0.
    const freeObjects: number[] = [0];
    for (let i = 1; i <= maxObjNum; i++) {
      if (!objMap.has(i)) {
        freeObjects.push(i);
      }
    }

    // Build next-free linked list
    const nextFree = new Map<number, number>();
    for (let i = 0; i < freeObjects.length - 1; i++) {
      nextFree.set(freeObjects[i], freeObjects[i + 1]);
    }
    nextFree.set(freeObjects[freeObjects.length - 1], 0); // last points to 0

    // Object 0: head of free list
    const obj0Next = (nextFree.get(0) ?? 0).toString().padStart(10, "0");
    xrefLines.push(`${obj0Next} 65535 f `);

    for (let i = 1; i <= maxObjNum; i++) {
      const obj = objMap.get(i);
      if (obj) {
        const offsetStr = obj.offset.toString().padStart(10, "0");
        xrefLines.push(`${offsetStr} 00000 n `);
      } else {
        const nextObj = (nextFree.get(i) ?? 0).toString().padStart(10, "0");
        xrefLines.push(`${nextObj} 65535 f `);
      }
    }

    const xrefStr = xrefLines.join("\n") + "\n";
    const xrefBytes = encoder.encode(xrefStr);
    chunks.push(xrefBytes);

    // --- Trailer ---
    let trailerStr = "trailer\n<<\n";
    trailerStr += `/Size ${maxObjNum + 1}\n`;
    trailerStr += `/Root ${pdfRef(this.catalogRef)}\n`;
    if (this.infoRef > 0) {
      trailerStr += `/Info ${pdfRef(this.infoRef)}\n`;
    }
    if (encryptObjNum > 0) {
      trailerStr += `/Encrypt ${pdfRef(encryptObjNum)}\n`;
      trailerStr += `/ID [${pdfHexString(this.encryption!.fileId)} ${pdfHexString(this.encryption!.fileId)}]\n`;
    }
    trailerStr += ">>\n";
    trailerStr += "startxref\n";
    trailerStr += `${xrefOffset}\n`;
    trailerStr += "%%EOF\n";

    const trailerBytes = encoder.encode(trailerStr);
    chunks.push(trailerBytes);

    // --- Concatenate all chunks ---
    return concatUint8Arrays(chunks);
  }
}

// =============================================================================
// String Encryption Helper
// =============================================================================

/**
 * Encrypt all PDF string literals `(...)` in an object's content.
 * PDF spec §3.5 requires all strings (except those in the Encrypt dict) to be encrypted.
 * After encryption, strings are replaced with hex strings `<...>`.
 *
 * Uses a character-by-character parser instead of regex to correctly handle
 * nested escaped parentheses and backslashes like `(a\\(b\\)c)`.
 */
function encryptStringsInContent(
  content: string,
  objectNumber: number,
  generation: number,
  encryptionKey: Uint8Array
): string {
  const encoder = new TextEncoder();
  const result: string[] = [];
  let i = 0;

  while (i < content.length) {
    if (content[i] === "(") {
      // Parse a balanced parenthesized string, respecting \ escapes
      const start = i;
      i++; // skip opening '('
      let inner = "";
      let depth = 1;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === "\\") {
          // Escaped character — consume both chars
          inner += content[i] + (content[i + 1] ?? "");
          i += 2;
        } else if (ch === "(") {
          depth++;
          inner += ch;
          i++;
        } else if (ch === ")") {
          depth--;
          if (depth > 0) {
            inner += ch;
          }
          i++;
        } else {
          inner += ch;
          i++;
        }
      }

      if (depth !== 0) {
        // Malformed — emit as-is
        result.push(content.slice(start, i));
        continue;
      }

      // Unescape the PDF string to get raw bytes
      const unescaped = unescapePdfString(inner);
      const rawBytes = encoder.encode(unescaped);
      const encrypted = encryptData(rawBytes, objectNumber, generation, encryptionKey);
      result.push(pdfHexString(encrypted));
    } else if (content[i] === "<" && content[i + 1] === "<") {
      // Dict delimiter << — emit both chars and skip
      result.push("<<");
      i += 2;
    } else if (content[i] === ">" && content[i + 1] === ">") {
      // Dict delimiter >> — emit both chars and skip
      result.push(">>");
      i += 2;
    } else if (content[i] === "<") {
      // Parse a hex string <...>
      i++; // skip opening '<'
      let hex = "";
      while (i < content.length && content[i] !== ">") {
        hex += content[i];
        i++;
      }
      if (i < content.length) {
        i++; // skip closing '>'
      }

      // Decode hex to raw bytes
      const cleanHex = hex.replace(/\s/g, "");
      if (cleanHex.length === 0) {
        result.push("<>");
        continue;
      }
      const rawBytes = new Uint8Array(Math.ceil(cleanHex.length / 2));
      for (let h = 0; h < rawBytes.length; h++) {
        rawBytes[h] = parseInt(cleanHex.substring(h * 2, h * 2 + 2).padEnd(2, "0"), 16);
      }
      const encrypted = encryptData(rawBytes, objectNumber, generation, encryptionKey);
      result.push(pdfHexString(encrypted));
    } else {
      result.push(content[i]);
      i++;
    }
  }

  return result.join("");
}

function unescapePdfString(value: string): string {
  let result = "";

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      result += ch;
      continue;
    }

    const next = value[i + 1];
    if (next === undefined) {
      result += "\\";
      break;
    }

    switch (next) {
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "(":
        result += "(";
        break;
      case ")":
        result += ")";
        break;
      case "\\":
        result += "\\";
        break;
      default:
        result += next;
        break;
    }
    i++;
  }

  return result;
}

// =============================================================================
// Incremental Update
// =============================================================================

/**
 * Build an incremental update that appends new/modified objects to an
 * existing PDF without rewriting the original bytes.
 *
 * The result is `originalData + "\n" + new objects + xref + trailer + %%EOF`.
 * The new trailer's `/Prev` points to the original xref offset so that PDF
 * readers can follow the chain of incremental updates.
 *
 * @param originalData - The original, unmodified PDF bytes (preserved byte-for-byte)
 * @param modifiedObjects - Map of object number → serialized content.
 *   Values are either a plain string (for non-stream objects) or
 *   `{ dict, data }` for stream objects.
 * @param newTrailerEntries - Additional/override entries for the new trailer.
 *   Keys like `/Root`, `/Info`, `/Encrypt`, `/ID` are preserved from the
 *   original trailer by default but can be overridden here.
 *
 * @see ISO 32000-2:2020, §7.5.6 — Incremental Updates
 */
export function buildIncremental(
  originalData: Uint8Array,
  modifiedObjects: Map<number, string | { dict: PdfDict; data: Uint8Array }>,
  newTrailerEntries: Map<string, string>
): Uint8Array {
  if (modifiedObjects.size === 0) {
    return originalData;
  }

  const encoder = new TextEncoder();

  // --- Locate the original startxref offset ---
  const oldXrefOffset = findOriginalXrefOffset(originalData);

  // --- Extract original trailer entries we want to preserve ---
  const originalTrailerEntries = extractOriginalTrailerEntries(originalData);

  // --- Determine /Size for the new trailer ---
  // /Size must be one more than the highest object number across original + new
  const originalSize = originalTrailerEntries.get("Size") ?? "0";
  let maxObjNum = parseInt(originalSize, 10) - 1;
  for (const objNum of modifiedObjects.keys()) {
    if (objNum > maxObjNum) {
      maxObjNum = objNum;
    }
  }
  const newSize = maxObjNum + 1;

  // --- Build the appended body ---
  const chunks: Uint8Array[] = [];
  let byteOffset = originalData.length;

  // Start with a newline separator after the original %%EOF
  const separator = encoder.encode("\n");
  chunks.push(separator);
  byteOffset += separator.length;

  // Sort modified objects by object number for deterministic output
  const sortedObjects = [...modifiedObjects.entries()].sort((a, b) => a[0] - b[0]);

  // Track offsets for the xref entries
  const objectOffsets = new Map<number, number>();

  for (const [objNum, content] of sortedObjects) {
    objectOffsets.set(objNum, byteOffset);

    const objHeader = encoder.encode(`${objNum} 0 obj\n`);
    chunks.push(objHeader);
    byteOffset += objHeader.length;

    if (typeof content === "string") {
      // Non-stream object
      const contentBytes = encoder.encode(content + "\n");
      chunks.push(contentBytes);
      byteOffset += contentBytes.length;
    } else {
      // Stream object: dict + stream data
      let streamData = content.data;
      const dict = content.dict;

      // Compress if beneficial and not already filtered
      if (streamData.length > 256 && !dict.toString().includes("/Filter")) {
        const compressed = zlibSync(streamData, { level: 6 });
        if (compressed.length < streamData.length) {
          dict.set("Filter", "/FlateDecode");
          streamData = compressed;
        }
      }

      dict.set("Length", pdfNumber(streamData.length));

      const dictBytes = encoder.encode(dict.toString() + "\n");
      chunks.push(dictBytes);
      byteOffset += dictBytes.length;

      const streamStart = encoder.encode("stream\n");
      chunks.push(streamStart);
      byteOffset += streamStart.length;

      chunks.push(streamData);
      byteOffset += streamData.length;

      const streamEnd = encoder.encode("\nendstream\n");
      chunks.push(streamEnd);
      byteOffset += streamEnd.length;
    }

    const objFooter = encoder.encode("endobj\n");
    chunks.push(objFooter);
    byteOffset += objFooter.length;
  }

  // --- Build the new xref section ---
  const xrefOffset = byteOffset;

  // Group consecutive object numbers into subsections
  const objNums = [...objectOffsets.keys()].sort((a, b) => a - b);
  const subsections: Array<{ start: number; entries: Array<{ objNum: number; offset: number }> }> =
    [];

  for (const objNum of objNums) {
    const last = subsections[subsections.length - 1];
    if (last && objNum === last.start + last.entries.length) {
      // Consecutive — extend current subsection
      last.entries.push({ objNum, offset: objectOffsets.get(objNum)! });
    } else {
      // New subsection
      subsections.push({
        start: objNum,
        entries: [{ objNum, offset: objectOffsets.get(objNum)! }]
      });
    }
  }

  let xrefStr = "xref\n";
  for (const sub of subsections) {
    xrefStr += `${sub.start} ${sub.entries.length}\n`;
    for (const entry of sub.entries) {
      const offsetStr = entry.offset.toString().padStart(10, "0");
      xrefStr += `${offsetStr} 00000 n \n`;
    }
  }

  const xrefBytes = encoder.encode(xrefStr);
  chunks.push(xrefBytes);

  // --- Build the new trailer ---
  let trailerStr = "trailer\n<<\n";
  trailerStr += `/Size ${newSize}\n`;

  // Preserve original trailer keys: Root, Info, Encrypt, ID
  for (const key of ["Root", "Info", "Encrypt", "ID"]) {
    if (newTrailerEntries.has(key)) {
      trailerStr += `/${key} ${newTrailerEntries.get(key)!}\n`;
    } else if (originalTrailerEntries.has(key)) {
      trailerStr += `/${key} ${originalTrailerEntries.get(key)!}\n`;
    }
  }

  // Add any extra new trailer entries not already handled
  for (const [key, value] of newTrailerEntries) {
    if (key === "Root" || key === "Info" || key === "Encrypt" || key === "ID" || key === "Size") {
      continue; // Already handled above
    }
    trailerStr += `/${key} ${value}\n`;
  }

  // /Prev points to the original xref offset
  trailerStr += `/Prev ${oldXrefOffset}\n`;
  trailerStr += ">>\n";
  trailerStr += "startxref\n";
  trailerStr += `${xrefOffset}\n`;
  trailerStr += "%%EOF\n";

  const trailerBytes = encoder.encode(trailerStr);
  chunks.push(trailerBytes);

  // --- Concatenate: originalData + appended chunks ---
  return concatUint8Arrays([originalData, ...chunks]);
}

/**
 * Find the xref offset stored after the last `startxref` keyword in the PDF.
 */
function findOriginalXrefOffset(data: Uint8Array): number {
  // Scan backward from the end to find "startxref"
  const keyword = "startxref";
  const decoder = new TextDecoder("latin1");

  // Search in the last 1024 bytes (%%EOF + startxref are typically near the end)
  const searchStart = Math.max(0, data.length - 1024);
  const tail = decoder.decode(data.subarray(searchStart));

  const idx = tail.lastIndexOf(keyword);
  if (idx < 0) {
    throw new PdfStructureError("Could not find startxref in original PDF");
  }

  // Extract the number after "startxref"
  const afterKeyword = tail.substring(idx + keyword.length).trim();
  const match = afterKeyword.match(/^(\d+)/);
  if (!match) {
    throw new PdfStructureError("Invalid startxref offset in original PDF");
  }

  return parseInt(match[1], 10);
}

/**
 * Extract key trailer entries from the original PDF as serialized strings.
 * This is a lightweight scan — it doesn't fully parse the trailer, just
 * extracts the values we need for preservation.
 */
function extractOriginalTrailerEntries(data: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  const decoder = new TextDecoder("latin1");

  // Find the last "trailer" keyword — scan backward
  const text = decoder.decode(data);

  // Find the last trailer dict. For PDFs with incremental updates,
  // we want the most recent (last) trailer.
  const trailerIdx = text.lastIndexOf("trailer");
  if (trailerIdx < 0) {
    // Could be an xref stream PDF — no traditional trailer
    return entries;
  }

  // Find the << >> dict after "trailer"
  const afterTrailer = text.substring(trailerIdx + 7);
  const dictStart = afterTrailer.indexOf("<<");
  if (dictStart < 0) {
    return entries;
  }

  // Find the matching >>
  let depth = 0;
  let dictEnd = -1;
  for (let i = dictStart; i < afterTrailer.length - 1; i++) {
    if (afterTrailer[i] === "<" && afterTrailer[i + 1] === "<") {
      depth++;
      i++;
    } else if (afterTrailer[i] === ">" && afterTrailer[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) {
        dictEnd = i + 1;
        break;
      }
    }
  }

  if (dictEnd < 0) {
    return entries;
  }

  const dictStr = afterTrailer.substring(dictStart, dictEnd);

  // Extract known keys with a simple regex-based approach
  for (const key of ["Root", "Info", "Encrypt", "ID", "Size"]) {
    const keyPattern = new RegExp(`/${key}\\s+(.+?)(?=\\s*/[A-Z]|\\s*>>)`, "s");
    const match = dictStr.match(keyPattern);
    if (match) {
      entries.set(key, match[1].trim());
    }
  }

  return entries;
}
