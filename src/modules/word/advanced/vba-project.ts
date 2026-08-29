/**
 * DOCX Module - VBA Project (docm) Round-trip Support
 *
 * Provides support for preserving VBA macros during document read/write.
 * The VBA project binary lives on `DocxDocument.vbaProject` — that's what
 * `readDocx` populates and `packageDocx` writes back. This module exposes
 * convenience helpers around that field plus best-effort metadata
 * extraction.
 *
 * Note: This module does NOT execute or compile VBA code. It only
 * preserves the binary VBA project for round-trip fidelity.
 */

import type { DocxDocument, OpaquePart } from "@word/types";

// =============================================================================
// Types
// =============================================================================

/** VBA project metadata extracted from the document. */
export interface VbaProjectInfo {
  /** Whether a VBA project is present. */
  readonly hasVba: boolean;
  /** Path of the vbaProject.bin in the archive. */
  readonly projectPath?: string;
  /** Content type of the VBA project part. */
  readonly contentType?: string;
  /** Module names detected (best-effort extraction). */
  readonly moduleNames?: readonly string[];
  /** Size in bytes of the VBA project binary. */
  readonly sizeBytes?: number;
}

/** Content types for macro-enabled documents. */
export const DOCM_CONTENT_TYPES = {
  /** Content type for .docm main document part. */
  document: "application/vnd.ms-word.document.macroEnabled.main+xml",
  /** Content type for vbaProject.bin. */
  vbaProject: "application/vnd.ms-office.vbaProject",
  /** Content type for vbaData.xml. */
  vbaData: "application/vnd.ms-word.vbaData+xml"
} as const;

// =============================================================================
// VBA Detection & Extraction
// =============================================================================

/**
 * Get the raw VBA project binary data from the canonical location
 * (`doc.vbaProject`), falling back to `opaqueParts` for hand-built models.
 */
function findVbaBinary(doc: DocxDocument): Uint8Array | undefined {
  if (doc.vbaProject) {
    return doc.vbaProject;
  }
  if (doc.opaqueParts) {
    const part = doc.opaqueParts.find(p => isVbaProjectBin(p.path));
    if (part) {
      return part.data;
    }
  }
  return undefined;
}

/**
 * Check if a document contains a VBA project (is macro-enabled).
 *
 * @param doc - The parsed document.
 * @returns true if VBA macros are present.
 */
export function hasVbaProject(doc: DocxDocument): boolean {
  return findVbaBinary(doc) !== undefined;
}

/**
 * Extract VBA project metadata from a document.
 *
 * @param doc - The parsed document.
 * @returns VBA project info, or info with hasVba=false if not present.
 */
export function getVbaProjectInfo(doc: DocxDocument): VbaProjectInfo {
  const data = findVbaBinary(doc);
  if (!data) {
    return { hasVba: false };
  }
  const moduleNames = extractModuleNames(data);
  return {
    hasVba: true,
    projectPath: "word/vbaProject.bin",
    contentType: DOCM_CONTENT_TYPES.vbaProject,
    moduleNames,
    sizeBytes: data.length
  };
}

/**
 * Get the raw VBA project binary data.
 *
 * @param doc - The parsed document.
 * @returns The vbaProject.bin bytes, or undefined if not present.
 */
export function getVbaProjectData(doc: DocxDocument): Uint8Array | undefined {
  return findVbaBinary(doc);
}

/**
 * Add a VBA project to a document (making it a .docm).
 *
 * The VBA project binary should be a valid OLE2 compound document
 * containing the VBA modules. The first 8 bytes of an OLE2 file are the
 * fixed signature `D0 CF 11 E0 A1 B1 1A E1`; we sanity-check that here so
 * obviously-wrong inputs (e.g. a plain text file) fail eagerly instead of
 * producing a .docm that Word silently rejects.
 *
 * The data is stored in the canonical `DocxDocument.vbaProject` field —
 * `packageDocx` writes that field directly to `word/vbaProject.bin` and
 * registers the relationship + content type. Any pre-existing copies in
 * `opaqueParts` are removed so we don't emit two conflicting parts.
 *
 * @param doc - The document to add VBA to.
 * @param vbaProjectBin - The vbaProject.bin binary data (OLE2 compound).
 * @returns A new document with the VBA project embedded.
 */
export function addVbaProject(doc: DocxDocument, vbaProjectBin: Uint8Array): DocxDocument {
  if (!isOle2Header(vbaProjectBin)) {
    throw new Error(
      "addVbaProject: data does not start with the OLE2 compound document " +
        "signature (D0 CF 11 E0 A1 B1 1A E1). vbaProject.bin must be a valid " +
        "OLE2 compound file."
    );
  }
  const filteredParts = doc.opaqueParts
    ? doc.opaqueParts.filter(p => !isVbaPart(p.path))
    : undefined;
  // Word rejects a package that carries a vbaProject.bin but is declared
  // in [Content_Types].xml as the plain wordprocessingml document type.
  // Promote a regular `document`/`template` doc to its macro-enabled
  // counterpart so the content-type matches the .docm/.dotm extension
  // the user is about to write.
  let nextDocType = doc.docType;
  if (nextDocType === undefined || nextDocType === "document") {
    nextDocType = "macroEnabledDocument";
  } else if (nextDocType === "template") {
    nextDocType = "macroEnabledTemplate";
  }
  return {
    ...doc,
    docType: nextDocType,
    vbaProject: vbaProjectBin,
    ...(filteredParts !== undefined
      ? { opaqueParts: filteredParts.length > 0 ? filteredParts : undefined }
      : {})
  };
}

/**
 * Remove VBA project from a document (converting .docm to .docx behavior).
 *
 * @param doc - The macro-enabled document.
 * @returns A new document without VBA parts.
 */
export function removeVbaProject(doc: DocxDocument): DocxDocument {
  // Demote the content type alongside removing the binary so the package
  // is identified as a plain .docx/.dotx going forward.
  let nextDocType = doc.docType;
  if (nextDocType === "macroEnabledDocument") {
    nextDocType = "document";
  } else if (nextDocType === "macroEnabledTemplate") {
    nextDocType = "template";
  }
  const next: DocxDocument = { ...doc, docType: nextDocType, vbaProject: undefined };
  if (doc.opaqueParts) {
    const filteredParts = doc.opaqueParts.filter(p => !isVbaPart(p.path));
    return {
      ...next,
      opaqueParts: filteredParts.length > 0 ? filteredParts : undefined
    };
  }
  return next;
}

/**
 * List all VBA-related parts in the document. Includes the canonical
 * `vbaProject` field (synthesised as an OpaquePart for ergonomics) plus
 * any auxiliary VBA parts (e.g. `vbaData.xml`) that survive in
 * `opaqueParts`.
 */
export function listVbaParts(doc: DocxDocument): readonly OpaquePart[] {
  const out: OpaquePart[] = [];
  if (doc.vbaProject) {
    out.push({
      path: "word/vbaProject.bin",
      data: doc.vbaProject,
      contentType: DOCM_CONTENT_TYPES.vbaProject
    });
  }
  if (doc.opaqueParts) {
    for (const p of doc.opaqueParts) {
      if (isVbaPart(p.path) && !p.path.toLowerCase().endsWith("vbaproject.bin")) {
        out.push(p);
      }
    }
  }
  return out;
}

// =============================================================================
// Internal Helpers
// =============================================================================

const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** Quick check that the first 8 bytes match the OLE2 compound document signature. */
function isOle2Header(data: Uint8Array): boolean {
  if (data.length < OLE2_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < OLE2_SIGNATURE.length; i++) {
    if (data[i] !== OLE2_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

function isVbaPart(path: string): boolean {
  // Match VBA-related parts strictly by file name to avoid catching
  // unrelated parts that merely contain the substring "vbaproject"
  // (e.g. `customXml/vbaProject_metadata.xml`). Both legacy locations
  // are recognised plus the conventional `word/_rels/vbaProject.bin.rels`.
  const lower = path.toLowerCase();
  if (lower === "word/vbaproject.bin" || lower.endsWith("/vbaproject.bin")) {
    return true;
  }
  if (lower === "word/vbadata.xml" || lower.endsWith("/vbadata.xml")) {
    return true;
  }
  if (lower === "word/_rels/vbaproject.bin.rels" || lower.endsWith("/_rels/vbaproject.bin.rels")) {
    return true;
  }
  return false;
}

function isVbaProjectBin(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "word/vbaproject.bin" || lower.endsWith("vbaproject.bin");
}

/**
 * Best-effort extraction of VBA module names from vbaProject.bin.
 * The binary is an OLE2 compound document; we scan for module name strings.
 */
function extractModuleNames(data: Uint8Array): string[] {
  const names: string[] = [];

  // Module names in VBA projects are typically stored as UTF-16LE strings
  // preceded by specific markers. We do a simple heuristic scan.
  const str = tryDecodeStrings(data);

  // Look for common VBA module patterns
  const modulePatterns = [/Module\d*\s*=\s*([^\r\n]+)/g, /Attribute VB_Name\s*=\s*"([^"]+)"/g];

  for (const pattern of modulePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(str)) !== null) {
      const name = match[1]!.trim();
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }

  // Also look for standard module names in the dir stream
  const stdNames = ["ThisDocument", "Module1", "Module2", "Module3", "Sheet1"];
  for (const stdName of stdNames) {
    if (str.includes(stdName) && !names.includes(stdName)) {
      names.push(stdName);
    }
  }

  return names;
}

function tryDecodeStrings(data: Uint8Array): string {
  // Extract printable ASCII sequences (for heuristic module name detection)
  let result = "";
  let current = "";
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (b >= 0x20 && b < 0x7f) {
      current += String.fromCharCode(b);
    } else {
      if (current.length >= 3) {
        result += current + "\n";
      }
      current = "";
    }
  }
  if (current.length >= 3) {
    result += current;
  }
  return result;
}
