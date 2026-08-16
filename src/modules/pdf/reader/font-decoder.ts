/**
 * PDF font decoder for text extraction.
 *
 * Handles the mapping from character codes in content streams to Unicode
 * strings. Supports all major PDF font types:
 *
 * - Type 1 fonts (standard 14 + custom with /Encoding)
 * - TrueType fonts (with /Encoding and /ToUnicode)
 * - Type 0 (CID) composite fonts (with /ToUnicode CMap)
 * - Type 3 fonts (with /Encoding and /ToUnicode)
 *
 * @see PDF Reference 1.7, Chapter 5 - Text
 * @see PDF Reference 1.7, §5.5 - Character Encoding
 */

import { parseTtf } from "@pdf/font/ttf-parser";
import type { CMap } from "@pdf/reader/cmap-parser";
import { parseCMap } from "@pdf/reader/cmap-parser";
import type { PdfDocument } from "@pdf/reader/pdf-document";
import type { PdfDictValue, PdfObject, PdfArrayValue } from "@pdf/reader/pdf-parser";
import {
  isPdfDict,
  isPdfRef,
  isPdfArray,
  dictGetName,
  dictGetNumber,
  dictGetArray
} from "@pdf/reader/pdf-parser";

// =============================================================================
// Types
// =============================================================================

/**
 * A resolved font used for text extraction.
 */
export interface ResolvedFont {
  /** Font name */
  name: string;
  /** Font subtype: Type1, TrueType, Type0, Type3, CIDFontType0, CIDFontType2, MMType1 */
  subtype: string;
  /** ToUnicode CMap (if available) */
  toUnicode: CMap | null;
  /** Encoding lookup: char code → unicode string */
  encoding: Map<number, string>;
  /** Number of bytes per character code (1 for simple fonts, 1-2 for CID fonts) */
  bytesPerCode: number;
  /** Base font name */
  baseFontName: string;
  /** Whether this is a symbolic font */
  isSymbolic: boolean;
  /** Character widths (code → width in thousandths of text space units) */
  widths: Map<number, number>;
  /** Default width */
  defaultWidth: number;
  /** Missing width for characters not in widths table */
  missingWidth: number;
  /**
   * Whether the font uses the Identity-H / Identity-V CMap.
   *
   * Identity means "character code equals CID". It says nothing about Unicode:
   * a CID is an index into the font, so recovering text still requires either a
   * ToUnicode CMap or the embedded font's own cmap (see `cidToUnicode`).
   */
  isIdentityEncoding: boolean;
  /**
   * CID → Unicode recovered from the embedded font program, used only when the
   * font has no ToUnicode CMap.
   */
  cidToUnicode: Map<number, string> | null;
  /** Writing mode: 0 = horizontal, 1 = vertical */
  wmode: number;
}

// =============================================================================
// Standard 14 Font Names
// =============================================================================

/**
 * The 14 standard PDF fonts and their default encoding families.
 * "winansi" → WinAnsiEncoding, "symbol" → SymbolEncoding, "zapf" → ZapfDingbatsEncoding
 */
const STANDARD_14_FONTS: Record<string, "winansi" | "symbol" | "zapf"> = {
  Courier: "winansi",
  "Courier-Bold": "winansi",
  "Courier-Oblique": "winansi",
  "Courier-BoldOblique": "winansi",
  Helvetica: "winansi",
  "Helvetica-Bold": "winansi",
  "Helvetica-Oblique": "winansi",
  "Helvetica-BoldOblique": "winansi",
  "Times-Roman": "winansi",
  "Times-Bold": "winansi",
  "Times-Italic": "winansi",
  "Times-BoldItalic": "winansi",
  Symbol: "symbol",
  ZapfDingbats: "zapf"
};

/**
 * Detect the standard 14 font family from a BaseFont name.
 * Handles common variants like "ABCDEF+Helvetica-Bold".
 */
function detectStandard14(baseFontName: string): "winansi" | "symbol" | "zapf" | null {
  // Strip subset prefix (e.g. "ABCDEF+Helvetica" → "Helvetica")
  const stripped = baseFontName.includes("+")
    ? baseFontName.substring(baseFontName.indexOf("+") + 1)
    : baseFontName;

  // Direct match
  const direct = STANDARD_14_FONTS[stripped];
  if (direct) {
    return direct;
  }

  // Prefix match for variants (e.g. "Helvetica-Narrow" → winansi)
  const lower = stripped.toLowerCase();
  if (lower.startsWith("courier") || lower.startsWith("helvetica") || lower.startsWith("times")) {
    return "winansi";
  }
  if (lower === "symbol" || lower.startsWith("symbol")) {
    return "symbol";
  }
  if (lower === "zapfdingbats" || lower.startsWith("zapfdingbats")) {
    return "zapf";
  }

  return null;
}

// =============================================================================
// Font Resolution
// =============================================================================

/**
 * Resolve a PDF font dictionary into a ResolvedFont for text extraction.
 */
export function resolveFont(fontDict: PdfDictValue, doc: PdfDocument): ResolvedFont {
  const subtype = dictGetName(fontDict, "Subtype") ?? "Type1";
  const baseFontName = dictGetName(fontDict, "BaseFont") ?? "Unknown";
  const name = dictGetName(fontDict, "Name") ?? baseFontName;

  // Parse ToUnicode CMap
  const toUnicode = parseToUnicode(fontDict, doc);

  // Detect Identity-H / Identity-V encoding for Type0 fonts
  let isIdentityEncoding = false;
  let wmode = 0;

  if (subtype === "Type0") {
    const encodingVal = fontDict.get("Encoding");
    if (typeof encodingVal === "string") {
      if (encodingVal === "Identity-H" || encodingVal === "Identity-V") {
        isIdentityEncoding = true;
        wmode = encodingVal === "Identity-V" ? 1 : 0;
      } else if (encodingVal.endsWith("-V")) {
        wmode = 1;
      }
    } else if (isPdfRef(encodingVal)) {
      // Could be a CMap stream; check for WMode
      const cmapDict = doc.derefDict(encodingVal);
      if (cmapDict) {
        wmode = dictGetNumber(cmapDict, "WMode") ?? 0;
      }
    }
  }

  // Determine encoding
  const encoding = buildEncoding(fontDict, subtype, baseFontName, doc);

  // Determine bytes per code
  let bytesPerCode = 1;
  if (subtype === "Type0") {
    bytesPerCode = toUnicode?.bytesPerCode ?? 2;
  }

  // Check if symbolic
  const descriptor = resolveDescriptor(fontDict, doc);
  const flags = descriptor ? (dictGetNumber(descriptor, "Flags") ?? 0) : 0;
  const isSymbolic = (flags & 4) !== 0;

  // Build widths map
  const { widths, defaultWidth, missingWidth } = buildWidths(fontDict, subtype, descriptor, doc);

  // Producers may omit ToUnicode entirely. For an Identity CID font the codes
  // are glyph indices, so the embedded font's own cmap can be inverted to
  // recover the text instead of guessing that a CID is a Unicode scalar.
  const cidToUnicode =
    !toUnicode && isIdentityEncoding
      ? buildCidToUnicodeFromEmbeddedFont(fontDict, descriptor, doc)
      : null;

  return {
    name,
    subtype,
    toUnicode,
    encoding,
    bytesPerCode,
    baseFontName,
    isSymbolic,
    widths,
    defaultWidth,
    missingWidth,
    isIdentityEncoding,
    cidToUnicode,
    wmode
  };
}

/**
 * Decode character codes to Unicode text using a resolved font.
 */
export function decodeText(codes: Uint8Array, font: ResolvedFont): string {
  let result = "";
  for (const code of splitCharacterCodes(codes, font)) {
    result += lookupChar(code, font);
  }
  return result;
}

/**
 * Split a show-text string into character codes.
 *
 * Simple fonts use one byte per code. For CID fonts the codespace ranges of the
 * font's CMap decide how many bytes each code occupies, and PDF allows 1 to 4.
 *
 * Every consumer — text extraction and width accumulation — goes through this
 * one function, because they must agree on the split: if one consumed two bytes
 * where the other consumed one, every following glyph would be mis-decoded or
 * mis-positioned.
 */
export function splitCharacterCodes(codes: Uint8Array, font: ResolvedFont): Iterable<number> {
  // A `bytesPerCode` of 2 on a non-Type0 font still means two-byte codes.
  // For genuinely single-byte fonts the input already *is* the code sequence,
  // so it is handed back as-is rather than copied into an array.
  if (font.subtype !== "Type0" && font.bytesPerCode !== 2) {
    return codes;
  }

  const result: number[] = [];
  let i = 0;

  while (i < codes.length) {
    let codeLen = font.toUnicode?.hasCodeSpaceRanges ? font.toUnicode.getCodeLength(codes[i]) : 0;

    // No codespace ranges: Identity and most CID encodings are two-byte, which
    // is also what `bytesPerCode` reports for them.
    if (codeLen < 1) {
      codeLen = Math.min(Math.max(font.bytesPerCode, 1), 4);
    }
    // Never read past the end of the string.
    codeLen = Math.min(codeLen, codes.length - i);

    let code = 0;
    for (let byte = 0; byte < codeLen; byte++) {
      code = (code << 8) | codes[i + byte];
    }
    result.push(code);
    i += codeLen;
  }

  return result;
}

/**
 * Look up a single character code using the font's encoding chain.
 * Priority: ToUnicode → Identity encoding → Encoding map → direct char code → byte passthrough.
 */
function lookupChar(code: number, font: ResolvedFont): string {
  // 1. ToUnicode CMap (highest priority — most reliable for multilingual)
  if (font.toUnicode) {
    const mapped = font.toUnicode.lookup(code);
    if (mapped !== undefined) {
      return mapped;
    }
  }

  // 2. Identity CID font with no ToUnicode: invert the embedded font's cmap.
  //    A CID is a glyph index, so it must be translated through the font — the
  //    code is not itself a Unicode scalar.
  if (font.cidToUnicode) {
    const viaFont = font.cidToUnicode.get(code);
    if (viaFont !== undefined) {
      return viaFont;
    }
  }

  // 3. Encoding map
  const encoded = font.encoding.get(code);
  if (encoded !== undefined) {
    return encoded;
  }

  // 4. Direct code point (for standard Latin characters)
  if (code >= 0x20 && code <= 0x7e) {
    return String.fromCharCode(code);
  }

  // 5. Last resort: pass through byte value as code point.
  //    Many fonts use Unicode-ordered glyphs, so the raw code often works.
  if (code > 0x7e && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
    return String.fromCodePoint(code);
  }

  // 6. Unmapped — return replacement character
  return "\uFFFD";
}

// =============================================================================
// ToUnicode CMap
// =============================================================================

function parseToUnicode(fontDict: PdfDictValue, doc: PdfDocument): CMap | null {
  const toUnicodeRef = fontDict.get("ToUnicode");
  if (!toUnicodeRef) {
    // A Type0 font may carry ToUnicode on its descendant CIDFont instead.
    const cidToUnicode = resolveDescendantCIDFont(fontDict, doc)?.get("ToUnicode");
    return cidToUnicode ? resolveToUnicode(cidToUnicode, doc) : null;
  }

  return resolveToUnicode(toUnicodeRef, doc);
}

function resolveToUnicode(ref: PdfObject, doc: PdfDocument): CMap | null {
  const result = doc.derefStreamWithObjNum(ref);
  if (!result) {
    return null;
  }

  try {
    const data = doc.getStreamData(result.stream, result.objNum, result.gen);
    return parseCMap(data);
  } catch {
    return null;
  }
}

// =============================================================================
// Encoding
// =============================================================================

function buildEncoding(
  fontDict: PdfDictValue,
  subtype: string,
  baseFontName: string,
  doc: PdfDocument
): Map<number, string> {
  const encoding = new Map<number, string>();

  // For Type0 fonts, encoding is handled by the CMap
  if (subtype === "Type0") {
    return encoding;
  }

  const encodingObj = fontDict.get("Encoding");

  if (typeof encodingObj === "string") {
    // Named encoding
    applyNamedEncoding(encoding, encodingObj);
  } else if (isPdfDict(encodingObj)) {
    // Encoding dictionary
    const baseEncoding = dictGetName(encodingObj, "BaseEncoding");
    if (baseEncoding) {
      applyNamedEncoding(encoding, baseEncoding);
    } else {
      // Default base encoding depends on font type/name
      applyDefaultBaseEncoding(encoding, subtype, baseFontName);
    }

    // Apply Differences array
    const differences = dictGetArray(encodingObj, "Differences");
    if (differences) {
      applyDifferences(encoding, differences);
    }
  } else if (isPdfRef(encodingObj)) {
    const resolved = doc.derefDict(encodingObj);
    if (resolved) {
      const baseEncoding = dictGetName(resolved, "BaseEncoding");
      if (baseEncoding) {
        applyNamedEncoding(encoding, baseEncoding);
      } else {
        applyDefaultBaseEncoding(encoding, subtype, baseFontName);
      }
      const differences = dictGetArray(resolved, "Differences");
      if (differences) {
        applyDifferences(encoding, differences);
      }
    }
  } else {
    // No encoding specified — use defaults based on font type and name
    applyDefaultBaseEncoding(encoding, subtype, baseFontName);
  }

  return encoding;
}

/**
 * Apply the correct default base encoding based on font subtype and BaseFont name.
 * - Symbol → SymbolEncoding
 * - ZapfDingbats → ZapfDingbatsEncoding
 * - TrueType / Helvetica / Times / Courier families → WinAnsiEncoding
 * - Other Type1 → StandardEncoding
 */
function applyDefaultBaseEncoding(
  encoding: Map<number, string>,
  subtype: string,
  baseFontName: string
): void {
  const std14 = detectStandard14(baseFontName);
  if (std14 === "symbol") {
    applyNamedEncoding(encoding, "SymbolEncoding");
  } else if (std14 === "zapf") {
    applyNamedEncoding(encoding, "ZapfDingbatsEncoding");
  } else if (subtype === "TrueType" || std14 === "winansi") {
    applyNamedEncoding(encoding, "WinAnsiEncoding");
  } else {
    applyNamedEncoding(encoding, "StandardEncoding");
  }
}

// =============================================================================
// Named Encodings
// =============================================================================

function applyNamedEncoding(encoding: Map<number, string>, name: string): void {
  let table: Record<number, string>;

  switch (name) {
    case "WinAnsiEncoding":
      table = WIN_ANSI_ENCODING;
      break;
    case "MacRomanEncoding":
      table = MAC_ROMAN_ENCODING;
      break;
    case "StandardEncoding":
      table = STANDARD_ENCODING;
      break;
    case "MacExpertEncoding":
      table = MAC_EXPERT_ENCODING;
      break;
    case "SymbolEncoding":
      table = SYMBOL_ENCODING;
      break;
    case "ZapfDingbatsEncoding":
      table = ZAPF_DINGBATS_ENCODING;
      break;
    default:
      table = WIN_ANSI_ENCODING;
      break;
  }

  for (const [code, char] of Object.entries(table)) {
    encoding.set(Number(code), char);
  }
}

/**
 * Apply a /Differences array to an encoding.
 * Format: [code1 /name1 /name2 ... codeN /nameN ...]
 */
function applyDifferences(encoding: Map<number, string>, differences: PdfArrayValue): void {
  let code = 0;
  for (const item of differences) {
    if (typeof item === "number") {
      code = item;
    } else if (typeof item === "string") {
      const unicode = glyphNameToUnicode(item);
      if (unicode) {
        encoding.set(code, unicode);
      }
      code++;
    }
  }
}

// =============================================================================
// CID Font Structure
// =============================================================================

/**
 * Resolve a Type0 font's descendant CIDFont dictionary.
 *
 * A Type0 font delegates its widths, `CIDToGIDMap` and font descriptor to a
 * descendant CIDFont, and PDF 32000-1 9.7.4 permits exactly one. Returns null
 * for every other subtype, so callers can use it as a combined "is this a CID
 * font, and if so give me its CIDFont dict" test.
 */
function resolveDescendantCIDFont(fontDict: PdfDictValue, doc: PdfDocument): PdfDictValue | null {
  if (dictGetName(fontDict, "Subtype") !== "Type0") {
    return null;
  }
  const descendants = dictGetArray(fontDict, "DescendantFonts");
  if (!descendants || descendants.length === 0) {
    return null;
  }
  return doc.derefDict(descendants[0]);
}

// =============================================================================
// Font Descriptor
// =============================================================================

function resolveDescriptor(fontDict: PdfDictValue, doc: PdfDocument): PdfDictValue | null {
  const descRef = fontDict.get("FontDescriptor");
  if (descRef) {
    return doc.derefDict(descRef);
  }

  // A Type0 font's descriptor lives on its descendant CIDFont.
  const cidDesc = resolveDescendantCIDFont(fontDict, doc)?.get("FontDescriptor");
  return cidDesc ? doc.derefDict(cidDesc) : null;
}

/**
 * Read an explicit `CIDToGIDMap` stream as CID → glyph index.
 *
 * Returns null for `/Identity`, a missing entry, or an unreadable stream, all of
 * which mean the CID can be used as the glyph index directly.
 */
function readCidToGidMap(fontDict: PdfDictValue, doc: PdfDocument): Uint16Array | null {
  const entry = resolveDescendantCIDFont(fontDict, doc)?.get("CIDToGIDMap");
  if (!entry || typeof entry === "string") {
    return null;
  }
  const stream = doc.derefStreamWithObjNum(entry);
  if (!stream) {
    return null;
  }
  const data = doc.getStreamData(stream.stream, stream.objNum, stream.gen);
  const count = Math.floor(data.length / 2);
  const map = new Uint16Array(count);
  for (let cid = 0; cid < count; cid++) {
    map[cid] = (data[cid * 2] << 8) | data[cid * 2 + 1];
  }
  return count > 0 ? map : null;
}

/**
 * Invert an embedded TrueType font's cmap to map CID → Unicode.
 *
 * Only used for Identity CID fonts without a ToUnicode CMap. With
 * `CIDToGIDMap /Identity` the CID is the glyph index directly; an explicit
 * CIDToGIDMap stream is applied first. Returns null when the font program is
 * absent or unparseable, in which case extraction falls back to the heuristics
 * further down `lookupChar`.
 */
function buildCidToUnicodeFromEmbeddedFont(
  fontDict: PdfDictValue,
  descriptor: PdfDictValue | null,
  doc: PdfDocument
): Map<number, string> | null {
  if (!descriptor) {
    return null;
  }
  const fontFile = descriptor.get("FontFile2");
  if (!fontFile) {
    return null;
  }
  try {
    const stream = doc.derefStreamWithObjNum(fontFile);
    if (!stream) {
      return null;
    }
    const data = doc.getStreamData(stream.stream, stream.objNum, stream.gen);
    if (data.length === 0) {
      return null;
    }
    const font = parseTtf(data);
    const gidToUnicode = new Map<number, string>();
    for (const [codePoint, gid] of font.cmap) {
      if (gid > 0 && !gidToUnicode.has(gid)) {
        gidToUnicode.set(gid, String.fromCodePoint(codePoint));
      }
    }
    if (gidToUnicode.size === 0) {
      return null;
    }

    // CIDToGIDMap may remap CIDs onto glyph indices. `/Identity` (or an absent
    // entry) means CID == GID; a stream holds one big-endian u16 GID per CID.
    const cidToGid = readCidToGidMap(fontDict, doc);
    if (!cidToGid) {
      return gidToUnicode;
    }
    const result = new Map<number, string>();
    for (let cid = 0; cid < cidToGid.length; cid++) {
      const unicode = gidToUnicode.get(cidToGid[cid]);
      if (unicode !== undefined) {
        result.set(cid, unicode);
      }
    }
    return result.size > 0 ? result : null;
  } catch {
    // A broken or unsupported font program must not break text extraction.
    return null;
  }
}

// =============================================================================
// Widths
// =============================================================================

function buildWidths(
  fontDict: PdfDictValue,
  subtype: string,
  descriptor: PdfDictValue | null,
  doc: PdfDocument
): { widths: Map<number, number>; defaultWidth: number; missingWidth: number } {
  const widths = new Map<number, number>();
  let defaultWidth = 1000;
  let missingWidth = 0;

  if (descriptor) {
    missingWidth = dictGetNumber(descriptor, "MissingWidth") ?? 0;
  }

  const cidFont = resolveDescendantCIDFont(fontDict, doc);
  if (cidFont) {
    // CID font widths
    defaultWidth = dictGetNumber(cidFont, "DW") ?? 1000;
    const wArray = dictGetArray(cidFont, "W");
    if (wArray) {
      parseCIDWidths(wArray, widths, doc);
    }
  } else {
    // Simple font widths
    const firstChar = dictGetNumber(fontDict, "FirstChar") ?? 0;
    const widthsArray = dictGetArray(fontDict, "Widths");
    if (widthsArray) {
      for (let i = 0; i < widthsArray.length; i++) {
        const w = widthsArray[i];
        if (typeof w === "number") {
          widths.set(firstChar + i, w);
        }
      }
    }
  }

  return { widths, defaultWidth, missingWidth };
}

/**
 * Parse CID font /W array.
 * Format: [cid [w1 w2 ...]] or [cidFirst cidLast w]
 */
function parseCIDWidths(
  wArray: PdfArrayValue,
  widths: Map<number, number>,
  _doc: PdfDocument
): void {
  let i = 0;
  while (i < wArray.length) {
    const first = wArray[i] as number;
    i++;
    if (i >= wArray.length) {
      break;
    }

    const next = wArray[i];
    if (isPdfArray(next)) {
      // [cid [w1 w2 ...]]
      for (let j = 0; j < next.length; j++) {
        widths.set(first + j, next[j] as number);
      }
      i++;
    } else if (typeof next === "number") {
      // [cidFirst cidLast w]
      const last = next;
      i++;
      if (i < wArray.length) {
        const w = wArray[i] as number;
        for (let cid = first; cid <= last; cid++) {
          widths.set(cid, w);
        }
        i++;
      }
    } else {
      i++;
    }
  }
}

/**
 * Get the character width for a given code.
 */
export function getCharWidth(code: number, font: ResolvedFont): number {
  const w = font.widths.get(code);
  if (w !== undefined) {
    return w;
  }
  return font.missingWidth || font.defaultWidth;
}

// =============================================================================
// Glyph Name to Unicode Mapping (Adobe Glyph List)
// =============================================================================

/**
 * Map an Adobe glyph name to its Unicode string.
 * Uses the Adobe Glyph List (AGL) plus common extensions.
 */
function glyphNameToUnicode(name: string): string | undefined {
  // Check predefined table
  const mapped = GLYPH_TO_UNICODE[name];
  if (mapped !== undefined) {
    return String.fromCodePoint(mapped);
  }

  // Handle uniXXXX form
  if (name.startsWith("uni") && name.length >= 7) {
    const hex = name.substring(3);
    const cp = parseInt(hex, 16);
    if (!isNaN(cp) && cp > 0) {
      return String.fromCodePoint(cp);
    }
  }

  // Handle uXXXX / uXXXXX form
  if (name.startsWith("u") && name.length >= 5) {
    const hex = name.substring(1);
    const cp = parseInt(hex, 16);
    if (!isNaN(cp) && cp > 0) {
      return String.fromCodePoint(cp);
    }
  }

  return undefined;
}

// =============================================================================
// Encoding Tables
// =============================================================================

/**
 * WinAnsi (Windows-1252) encoding.
 * Maps byte values to Unicode characters.
 */
const WIN_ANSI_ENCODING: Record<number, string> = /* @__PURE__ */ (() => {
  const table: Record<number, string> = {};
  // Standard ASCII printable range
  for (let i = 0x20; i <= 0x7e; i++) {
    table[i] = String.fromCharCode(i);
  }
  // High range (0xA0-0xFF) maps directly
  for (let i = 0xa0; i <= 0xff; i++) {
    table[i] = String.fromCharCode(i);
  }
  // 0x80-0x9F special mappings
  const special: Record<number, number> = {
    0x80: 0x20ac,
    0x82: 0x201a,
    0x83: 0x0192,
    0x84: 0x201e,
    0x85: 0x2026,
    0x86: 0x2020,
    0x87: 0x2021,
    0x88: 0x02c6,
    0x89: 0x2030,
    0x8a: 0x0160,
    0x8b: 0x2039,
    0x8c: 0x0152,
    0x8e: 0x017d,
    0x91: 0x2018,
    0x92: 0x2019,
    0x93: 0x201c,
    0x94: 0x201d,
    0x95: 0x2022,
    0x96: 0x2013,
    0x97: 0x2014,
    0x98: 0x02dc,
    0x99: 0x2122,
    0x9a: 0x0161,
    0x9b: 0x203a,
    0x9c: 0x0153,
    0x9e: 0x017e,
    0x9f: 0x0178
  };
  for (const [code, cp] of Object.entries(special)) {
    table[Number(code)] = String.fromCodePoint(cp);
  }
  return table;
})();

/**
 * MacRoman encoding.
 */
const MAC_ROMAN_ENCODING: Record<number, string> = /* @__PURE__ */ (() => {
  const table: Record<number, string> = {};
  for (let i = 0x20; i <= 0x7e; i++) {
    table[i] = String.fromCharCode(i);
  }
  const mac: number[] = [
    0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3,
    0x00e5, 0x00e7, 0x00e9, 0x00e8, 0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
    0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc, 0x2020, 0x00b0, 0x00a2, 0x00a3,
    0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
    0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa,
    0x00ba, 0x2126, 0x00e6, 0x00f8, 0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
    0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201c, 0x201d,
    0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
    0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce,
    0x00cf, 0x00cc, 0x00d3, 0x00d4, 0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
    0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7
  ];
  for (let i = 0; i < mac.length; i++) {
    table[0x80 + i] = String.fromCodePoint(mac[i]);
  }
  return table;
})();

/**
 * Standard encoding (for Type 1 fonts).
 * Only includes the characters that differ from ASCII.
 */
const STANDARD_ENCODING: Record<number, string> = /* @__PURE__ */ (() => {
  const table: Record<number, string> = {};
  for (let i = 0x20; i <= 0x7e; i++) {
    table[i] = String.fromCharCode(i);
  }
  // Standard encoding differences
  const diffs: Record<number, number> = {
    0xa1: 0x00a1,
    0xa2: 0x00a2,
    0xa3: 0x00a3,
    0xa4: 0x2044,
    0xa5: 0x00a5,
    0xa6: 0x0192,
    0xa7: 0x00a7,
    0xa8: 0x00a4,
    0xa9: 0x0027,
    0xaa: 0x201c,
    0xab: 0x00ab,
    0xac: 0x2039,
    0xad: 0x203a,
    0xae: 0xfb01,
    0xaf: 0xfb02,
    0xb1: 0x2013,
    0xb2: 0x2020,
    0xb3: 0x2021,
    0xb4: 0x00b7,
    0xb6: 0x00b6,
    0xb7: 0x2022,
    0xb8: 0x201a,
    0xb9: 0x201e,
    0xba: 0x201d,
    0xbb: 0x00bb,
    0xbc: 0x2026,
    0xbd: 0x2030,
    0xc1: 0x0060,
    0xc2: 0x00b4,
    0xc3: 0x02c6,
    0xc4: 0x02dc,
    0xc5: 0x00af,
    0xc6: 0x02d8,
    0xc7: 0x02d9,
    0xc8: 0x00a8,
    0xca: 0x02da,
    0xcb: 0x00b8,
    0xcc: 0x02dd,
    0xcd: 0x02db,
    0xce: 0x02c7,
    0xcf: 0x2014,
    0xe1: 0x00c6,
    0xe3: 0x00aa,
    0xe8: 0x0141,
    0xe9: 0x00d8,
    0xea: 0x0152,
    0xeb: 0x00ba,
    0xf1: 0x00e6,
    0xf5: 0x0131,
    0xf8: 0x0142,
    0xf9: 0x00f8,
    0xfa: 0x0153,
    0xfb: 0x00df
  };
  for (const [code, cp] of Object.entries(diffs)) {
    table[Number(code)] = String.fromCodePoint(cp);
  }
  return table;
})();

/**
 * MacExpert encoding — used by expert subset fonts for oldstyle numerals,
 * small caps, fractions, and other typographic alternates.
 *
 * @see Adobe Technical Note #5014 — "Adobe Standard Encoding"
 */
const MAC_EXPERT_ENCODING: Record<number, string> = /* @__PURE__ */ (() => {
  const table: Record<number, string> = {};

  // Complete MacExpert encoding map (code → Unicode code point)
  const mappings: Record<number, number> = {
    0x20: 0x0020, // space
    0x21: 0xf721, // exclamsmall
    0x22: 0xf6e2, // Hungarumlautsmall
    0x23: 0xf7a2, // centoldstyle
    0x24: 0xf724, // dollaroldstyle
    0x25: 0xf6e4, // dollarsuperior
    0x26: 0xf726, // ampersandsmall
    0x27: 0xf7b4, // Acutesmall
    0x28: 0x207d, // parenleftsuperior
    0x29: 0x207e, // parenrightsuperior
    0x2a: 0x2025, // twodotenleader
    0x2b: 0x2024, // onedotenleader
    0x2c: 0x002c, // comma
    0x2d: 0x002d, // hyphen
    0x2e: 0x002e, // period
    0x2f: 0x2044, // fraction
    0x30: 0xf730, // zerooldstyle
    0x31: 0xf731, // oneoldstyle
    0x32: 0xf732, // twooldstyle
    0x33: 0xf733, // threeoldstyle
    0x34: 0xf734, // fouroldstyle
    0x35: 0xf735, // fiveoldstyle
    0x36: 0xf736, // sixoldstyle
    0x37: 0xf737, // sevenoldstyle
    0x38: 0xf738, // eightoldstyle
    0x39: 0xf739, // nineoldstyle
    0x3a: 0x003a, // colon
    0x3b: 0x003b, // semicolon
    0x3d: 0xf6de, // threequartersemdash
    0x3f: 0xf73f, // questionsmall
    0x44: 0xf7f0, // Ethsmall
    0x47: 0x00bc, // onequarter
    0x48: 0x00bd, // onehalf
    0x49: 0x00be, // threequarters
    0x4a: 0x215b, // oneeighth
    0x4b: 0x215c, // threeeighths
    0x4c: 0x215d, // fiveeighths
    0x4d: 0x215e, // seveneighths
    0x4e: 0x2153, // onethird
    0x4f: 0x2154, // twothirds
    0x56: 0xfb00, // ff
    0x57: 0xfb01, // fi
    0x58: 0xfb02, // fl
    0x59: 0xfb03, // ffi
    0x5a: 0xfb04, // ffl
    0x5b: 0x208d, // parenleftinferior
    0x5d: 0x208e, // parenrightinferior
    0x5e: 0xf6f6, // Circumflexsmall
    0x5f: 0xf6e5, // hypheninferior
    0x60: 0xf760, // Gravesmall
    0x61: 0xf761, // Asmall
    0x62: 0xf762, // Bsmall
    0x63: 0xf763, // Csmall
    0x64: 0xf764, // Dsmall
    0x65: 0xf765, // Esmall
    0x66: 0xf766, // Fsmall
    0x67: 0xf767, // Gsmall
    0x68: 0xf768, // Hsmall
    0x69: 0xf769, // Ismall
    0x6a: 0xf76a, // Jsmall
    0x6b: 0xf76b, // Ksmall
    0x6c: 0xf76c, // Lsmall
    0x6d: 0xf76d, // Msmall
    0x6e: 0xf76e, // Nsmall
    0x6f: 0xf76f, // Osmall
    0x70: 0xf770, // Psmall
    0x71: 0xf771, // Qsmall
    0x72: 0xf772, // Rsmall
    0x73: 0xf773, // Ssmall
    0x74: 0xf774, // Tsmall
    0x75: 0xf775, // Usmall
    0x76: 0xf776, // Vsmall
    0x77: 0xf777, // Wsmall
    0x78: 0xf778, // Xsmall
    0x79: 0xf779, // Ysmall
    0x7a: 0xf77a, // Zsmall
    0x7b: 0x20a1, // colonmonetary
    0x7c: 0xf6dc, // onefitted
    0x7d: 0xf6dd, // rupiah
    0x7e: 0xf6fe, // Tildesmall
    0x81: 0xf6e9, // asabornemedial (exclamdownsmall)
    0x82: 0xf6e0, // centinferior
    0x87: 0xf7e1, // Abornemedialsmall (Aacutesmall)
    0x88: 0xf7e0, // Agravesmall
    0x89: 0xf7e2, // Acircumflexsmall
    0x8a: 0xf7e4, // Adieresissmall
    0x8b: 0xf7e3, // Atildesmall
    0x8c: 0xf7e5, // Aringsmall
    0x8d: 0xf7e7, // Ccedillasmall
    0x8e: 0xf7e9, // Eacutesmall
    0x8f: 0xf7e8, // Egravesmall
    0x90: 0xf7ea, // Ecircumflexsmall
    0x91: 0xf7eb, // Edieresissmall
    0x92: 0xf7ed, // Iacutesmall
    0x93: 0xf7ec, // Igravesmall
    0x94: 0xf7ee, // Icircumflexsmall
    0x95: 0xf7ef, // Idieresissmall
    0x96: 0xf7f1, // Ntildesmall
    0x97: 0xf7f3, // Oacutesmall
    0x98: 0xf7f2, // Ogravesmall
    0x99: 0xf7f4, // Ocircumflexsmall
    0x9a: 0xf7f6, // Odieresissmall
    0x9b: 0xf7f5, // Otildesmall
    0x9c: 0xf7fa, // Uacutesmall
    0x9d: 0xf7f9, // Ugravesmall
    0x9e: 0xf7fb, // Ucircumflexsmall
    0x9f: 0xf7fc, // Udieresissmall
    0xa1: 0x2078, // eightsuperior
    0xa2: 0x2084, // fourinferior
    0xa3: 0x2083, // threeinferior
    0xa4: 0x2086, // sixinferior
    0xa5: 0x2088, // eightinferior
    0xa6: 0x2087, // seveninferior
    0xa7: 0xf6fd, // Scaronsmall
    0xa9: 0xf6df, // centsuperiror
    0xaa: 0x2082, // twoinferior
    0xac: 0xf7a8, // Dieresissmall
    0xad: 0xf6f5, // Caronsmall
    0xae: 0xf6f0, // osabornemedialsuperior
    0xaf: 0x2085, // fiveinferior
    0xb1: 0xf6e1, // commainferior
    0xb2: 0xf6e7, // periodinferior
    0xb3: 0xf7fd, // Yacutesmall
    0xb4: 0xf6e3, // dollarinferior
    0xb7: 0xf7fe, // Thornsmall
    0xb8: 0xf6e8, // nineinferior
    0xb9: 0xf6e6, // zeroinferior
    0xba: 0x2080, // zeroinferior (alternate)
    0xbb: 0xf6e4, // dollarsuperior (alt)
    0xbc: 0xf7b0, // Degreesmall (alt)
    0xc1: 0xf6f1, // Agravesmall (alt)
    0xc2: 0xf7b4, // Acutesmall (alt)
    0xc7: 0xf6f4, // Brevesmall
    0xc8: 0xf7af, // Macronsmall
    0xca: 0xf6f2, // Dotaccentsmall
    0xcb: 0xf7b8, // Cedillasmall
    0xcd: 0xf6f3, // Ogoneksmall
    0xce: 0xf6ed, // Ringabovesmall (alt)
    0xcf: 0xf6f7, // Ringsmall
    0xd0: 0x2013, // endash
    0xd1: 0xf6e8, // nineinferior (alt)
    0xd6: 0xf7e6, // AEsmall
    0xd8: 0xf7f8, // Oslashsmall
    0xda: 0xf7bf, // questiondownsmall
    0xdb: 0x2081, // oneinferior
    0xdc: 0xf6f9, // Lslashsmall
    0xe1: 0xf7e6, // AEsmall (alt)
    0xe6: 0xf7e6, // AEsmall (dup)
    0xe8: 0xf7ec, // Igravesmall (alt)
    0xe9: 0xf7f8, // Oslashsmall (alt)
    0xea: 0xf7ea, // OEsmall
    0xeb: 0xf7ba, // Ordmasculinesmall
    0xf1: 0xf7e6, // aesmall
    0xf5: 0x0131, // dotlessi
    0xf8: 0xf7ec, // lslashsmall (alt)
    0xf9: 0xf7f8, // oslashsmall
    0xfa: 0xf7ea, // oesmall
    0xfb: 0x00df // germandbls
  };

  for (const [code, cp] of Object.entries(mappings)) {
    table[Number(code)] = String.fromCodePoint(cp);
  }
  return table;
})();

/**
 * Symbol font encoding.
 * Maps byte values to Unicode characters for the Symbol font.
 *
 * @see Adobe Symbol Encoding
 */
const SYMBOL_ENCODING: Record<number, string> = /* @__PURE__ */ (() => {
  const table: Record<number, string> = {};

  // 0x20–0x7E: Symbol-specific mappings
  const mappings: Record<number, number> = {
    0x20: 0x0020, // space
    0x21: 0x0021, // exclam
    0x22: 0x2200, // universal
    0x23: 0x0023, // numbersign
    0x24: 0x2203, // existential
    0x25: 0x0025, // percent
    0x26: 0x0026, // ampersand
    0x27: 0x220b, // suchthat
    0x28: 0x0028, // parenleft
    0x29: 0x0029, // parenright
    0x2a: 0x2217, // asteriskmath
    0x2b: 0x002b, // plus
    0x2c: 0x002c, // comma
    0x2d: 0x2212, // minus
    0x2e: 0x002e, // period
    0x2f: 0x002f, // slash
    0x30: 0x0030, // zero
    0x31: 0x0031, // one
    0x32: 0x0032, // two
    0x33: 0x0033, // three
    0x34: 0x0034, // four
    0x35: 0x0035, // five
    0x36: 0x0036, // six
    0x37: 0x0037, // seven
    0x38: 0x0038, // eight
    0x39: 0x0039, // nine
    0x3a: 0x003a, // colon
    0x3b: 0x003b, // semicolon
    0x3c: 0x003c, // less
    0x3d: 0x003d, // equal
    0x3e: 0x003e, // greater
    0x3f: 0x003f, // question
    0x40: 0x2245, // congruent
    0x41: 0x0391, // Alpha
    0x42: 0x0392, // Beta
    0x43: 0x03a7, // Chi
    0x44: 0x0394, // Delta
    0x45: 0x0395, // Epsilon
    0x46: 0x03a6, // Phi
    0x47: 0x0393, // Gamma
    0x48: 0x0397, // Eta
    0x49: 0x0399, // Iota
    0x4a: 0x03d1, // theta1
    0x4b: 0x039a, // Kappa
    0x4c: 0x039b, // Lambda
    0x4d: 0x039c, // Mu
    0x4e: 0x039d, // Nu
    0x4f: 0x039f, // Omicron
    0x50: 0x03a0, // Pi
    0x51: 0x0398, // Theta
    0x52: 0x03a1, // Rho
    0x53: 0x03a3, // Sigma
    0x54: 0x03a4, // Tau
    0x55: 0x03a5, // Upsilon
    0x56: 0x03c2, // sigma1
    0x57: 0x03a9, // Omega
    0x58: 0x039e, // Xi
    0x59: 0x03a8, // Psi
    0x5a: 0x0396, // Zeta
    0x5b: 0x005b, // bracketleft
    0x5c: 0x2234, // therefore
    0x5d: 0x005d, // bracketright
    0x5e: 0x22a5, // perpendicular
    0x5f: 0x005f, // underscore
    0x60: 0xf8e5, // radicalex
    0x61: 0x03b1, // alpha
    0x62: 0x03b2, // beta
    0x63: 0x03c7, // chi
    0x64: 0x03b4, // delta
    0x65: 0x03b5, // epsilon
    0x66: 0x03c6, // phi
    0x67: 0x03b3, // gamma
    0x68: 0x03b7, // eta
    0x69: 0x03b9, // iota
    0x6a: 0x03d5, // phi1
    0x6b: 0x03ba, // kappa
    0x6c: 0x03bb, // lambda
    0x6d: 0x03bc, // mu
    0x6e: 0x03bd, // nu
    0x6f: 0x03bf, // omicron
    0x70: 0x03c0, // pi
    0x71: 0x03b8, // theta
    0x72: 0x03c1, // rho
    0x73: 0x03c3, // sigma
    0x74: 0x03c4, // tau
    0x75: 0x03c5, // upsilon
    0x76: 0x03d6, // omega1
    0x77: 0x03c9, // omega
    0x78: 0x03be, // xi
    0x79: 0x03c8, // psi
    0x7a: 0x03b6, // zeta
    0x7b: 0x007b, // braceleft
    0x7c: 0x007c, // bar
    0x7d: 0x007d, // braceright
    0x7e: 0x223c, // similar
    0xa0: 0x20ac, // Euro
    0xa1: 0x03d2, // Upsilon1
    0xa2: 0x2032, // minute
    0xa3: 0x2264, // lessequal
    0xa4: 0x2044, // fraction
    0xa5: 0x221e, // infinity
    0xa6: 0x0192, // florin
    0xa7: 0x2663, // club
    0xa8: 0x2666, // diamond
    0xa9: 0x2665, // heart
    0xaa: 0x2660, // spade
    0xab: 0x2194, // arrowboth
    0xac: 0x2190, // arrowleft
    0xad: 0x2191, // arrowup
    0xae: 0x2192, // arrowright
    0xaf: 0x2193, // arrowdown
    0xb0: 0x00b0, // degree
    0xb1: 0x00b1, // plusminus
    0xb2: 0x2033, // second
    0xb3: 0x2265, // greaterequal
    0xb4: 0x00d7, // multiply
    0xb5: 0x221d, // proportional
    0xb6: 0x2202, // partialdiff
    0xb7: 0x2022, // bullet
    0xb8: 0x00f7, // divide
    0xb9: 0x2260, // notequal
    0xba: 0x2261, // equivalence
    0xbb: 0x2248, // approxequal
    0xbc: 0x2026, // ellipsis
    0xbd: 0xf8e6, // arrowvertex
    0xbe: 0xf8e7, // arrowhorizex
    0xbf: 0x21b5, // carriagereturn
    0xc0: 0x2135, // aleph
    0xc1: 0x2111, // Ifraktur
    0xc2: 0x211c, // Rfraktur
    0xc3: 0x2118, // weierstrass
    0xc4: 0x2297, // circlemultiply
    0xc5: 0x2295, // circleplus
    0xc6: 0x2205, // emptyset
    0xc7: 0x2229, // intersection
    0xc8: 0x222a, // union
    0xc9: 0x2283, // propersuperset
    0xca: 0x2287, // reflexsuperset
    0xcb: 0x2284, // notsubset
    0xcc: 0x2282, // propersubset
    0xcd: 0x2286, // reflexsubset
    0xce: 0x2208, // element
    0xcf: 0x2209, // notelement
    0xd0: 0x2220, // angle
    0xd1: 0x2207, // gradient
    0xd2: 0xf6da, // registerserif
    0xd3: 0xf6d9, // copyrightserif
    0xd4: 0xf6db, // trademarkserif
    0xd5: 0x220f, // product
    0xd6: 0x221a, // radical
    0xd7: 0x22c5, // dotmath
    0xd8: 0x00ac, // logicalnot
    0xd9: 0x2227, // logicaland
    0xda: 0x2228, // logicalor
    0xdb: 0x21d4, // arrowdblboth
    0xdc: 0x21d0, // arrowdblleft
    0xdd: 0x21d1, // arrowdblup
    0xde: 0x21d2, // arrowdblright
    0xdf: 0x21d3, // arrowdbldown
    0xe0: 0x25ca, // lozenge
    0xe1: 0x2329, // angleleft
    0xe2: 0xf8e8, // registersans
    0xe3: 0xf8e9, // copyrightsans
    0xe4: 0xf8ea, // trademarksans
    0xe5: 0x2211, // summation
    0xe6: 0xf8eb, // parenlefttp
    0xe7: 0xf8ec, // parenleftex
    0xe8: 0xf8ed, // parenleftbt
    0xe9: 0xf8ee, // bracketlefttp
    0xea: 0xf8ef, // bracketleftex
    0xeb: 0xf8f0, // bracketleftbt
    0xec: 0xf8f1, // bracelefttp
    0xed: 0xf8f2, // braceleftmid
    0xee: 0xf8f3, // braceleftbt
    0xef: 0xf8f4, // braceex
    0xf1: 0x232a, // angleright
    0xf2: 0x222b, // integral
    0xf3: 0x2320, // integraltp
    0xf4: 0xf8f5, // integralex
    0xf5: 0x2321, // integralbt
    0xf6: 0xf8f6, // parenrighttp
    0xf7: 0xf8f7, // parenrightex
    0xf8: 0xf8f8, // parenrightbt
    0xf9: 0xf8f9, // bracketrighttp
    0xfa: 0xf8fa, // bracketrightex
    0xfb: 0xf8fb, // bracketrightbt
    0xfc: 0xf8fc, // bracerighttp
    0xfd: 0xf8fd, // bracerightmid
    0xfe: 0xf8fe // bracerightbt
  };

  for (const [code, cp] of Object.entries(mappings)) {
    table[Number(code)] = String.fromCodePoint(cp);
  }
  return table;
})();

/**
 * ZapfDingbats font encoding.
 * Maps byte values to Unicode dingbat characters.
 *
 * @see Adobe ZapfDingbats Encoding
 */
const ZAPF_DINGBATS_ENCODING: Record<number, string> = /* @__PURE__ */ (() => {
  const table: Record<number, string> = {};

  const mappings: Record<number, number> = {
    0x20: 0x0020, // space
    0x21: 0x2701, // upperLeftOrLowerRightArrow
    0x22: 0x2702, // scissors
    0x23: 0x2703, // scissorsHollow
    0x24: 0x2704, // scissorsCutting
    0x25: 0x260e, // telephone
    0x26: 0x2706, // telephoneLocationSign
    0x27: 0x2707, // tapeDrive
    0x28: 0x2708, // airplane
    0x29: 0x2709, // envelope
    0x2a: 0x261b, // rightHandPointingIndex
    0x2b: 0x261e, // rightHandPointingIndex2
    0x2c: 0x270c, // victoryHand
    0x2d: 0x270d, // writingHand
    0x2e: 0x270e, // lowerRightPencil
    0x2f: 0x270f, // pencil
    0x30: 0x2710, // upperRightPencil
    0x31: 0x2711, // whiteNib
    0x32: 0x2712, // blackNib
    0x33: 0x2713, // checkMark
    0x34: 0x2714, // heavyCheckMark
    0x35: 0x2715, // multiplicationX
    0x36: 0x2716, // heavyMultiplicationX
    0x37: 0x2717, // ballotX
    0x38: 0x2718, // heavyBallotX
    0x39: 0x2719, // outlinedGreekCross
    0x3a: 0x271a, // heavyGreekCross
    0x3b: 0x271b, // openCentreCross
    0x3c: 0x271c, // heavyOpenCentreCross
    0x3d: 0x271d, // latinCross
    0x3e: 0x271e, // shadowedWhiteLatinCross
    0x3f: 0x271f, // outlinedLatinCross
    0x40: 0x2720, // malteseCross
    0x41: 0x2721, // starOfDavid
    0x42: 0x2722, // fourTeasedropStar
    0x43: 0x2723, // fourBalloonStar
    0x44: 0x2724, // heavyFourBalloonStar
    0x45: 0x2725, // fourClubStar
    0x46: 0x2726, // blackFourPointedStar
    0x47: 0x2727, // whiteFourPointedStar
    0x48: 0x2605, // blackStar
    0x49: 0x2729, // stressOutlinedWhiteStar
    0x4a: 0x272a, // circledWhiteStar
    0x4b: 0x272b, // openCentreBlackStar
    0x4c: 0x272c, // blackCentreWhiteStar
    0x4d: 0x272d, // outlinedBlackStar
    0x4e: 0x272e, // heavyOutlinedBlackStar
    0x4f: 0x272f, // pinnwheelStar
    0x50: 0x2730, // shadowedWhiteStar
    0x51: 0x2731, // heavyAsterisk
    0x52: 0x2732, // openCentreAsterisk
    0x53: 0x2733, // eightSpokedAsterisk
    0x54: 0x2734, // eightPointedBlackStar
    0x55: 0x2735, // eightPointedPinnwheelStar
    0x56: 0x2736, // sixPointedBlackStar
    0x57: 0x2737, // eightPointedRecoiledStar
    0x58: 0x2738, // heavyEightPointedRecoiledStar
    0x59: 0x2739, // twelveFoldPinnwheelStar
    0x5a: 0x273a, // sixteenPointedAsterisk
    0x5b: 0x273b, // tearDropSpokedAsterisk
    0x5c: 0x273c, // openCentreTearDropSpokedAsterisk
    0x5d: 0x273d, // heavyTearDropSpokedAsterisk
    0x5e: 0x273e, // sixFloweredAsterisk
    0x5f: 0x273f, // openCentreSixFloweredAsterisk
    0x60: 0x2740, // heavySixFloweredAsterisk
    0x61: 0x2741, // eightPetalledOutlinedBlackFloral
    0x62: 0x2742, // circledOpenCentreEightPointedStar
    0x63: 0x2743, // heavyTearDropSpokedPinnwheelAsterisk
    0x64: 0x2744, // snowflake
    0x65: 0x2745, // tightTrifoliateSnowflake
    0x66: 0x2746, // heavyChevronSnowflake
    0x67: 0x2747, // sparkle
    0x68: 0x2748, // heavySparkle
    0x69: 0x2749, // balloonSpokedAsterisk
    0x6a: 0x274a, // eightTearDropSpokedPropellerAsterisk
    0x6b: 0x274b, // heavyEightTearDropSpokedPropellerAsterisk
    0x6c: 0x25cf, // blackCircle
    0x6d: 0x274d, // shadowedWhiteCircle
    0x6e: 0x25a0, // blackSquare
    0x6f: 0x274f, // lowerRightDropShadowedWhiteSquare
    0x70: 0x2750, // upperRightDropShadowedWhiteSquare
    0x71: 0x2751, // lowerRightShadowedWhiteSquare
    0x72: 0x2752, // upperRightShadowedWhiteSquare
    0x73: 0x25b2, // blackUpPointingTriangle
    0x74: 0x25bc, // blackDownPointingTriangle
    0x75: 0x25c6, // blackDiamond
    0x76: 0x2756, // blackDiamondMinusWhiteX
    0x77: 0x25d7, // rightHalfBlackCircle
    0x78: 0x2758, // lightVerticalBar
    0x79: 0x2759, // mediumVerticalBar
    0x7a: 0x275a, // heavyVerticalBar
    0x7b: 0x275b, // heavySingleTurnedCommaQuotation
    0x7c: 0x275c, // heavySingleCommaQuotation
    0x7d: 0x275d, // heavyDoubleTurnedCommaQuotation
    0x7e: 0x275e, // heavyDoubleCommaQuotation
    0x80: 0xf8d7, // curvedStemParagraphSignOrnament
    0x81: 0xf8d8, // heavyExclamationMarkOrnament
    0x82: 0xf8d9, // heavyHeartExclamationMarkOrnament
    0x83: 0xf8da, // heavyBlackHeartOrnament
    0x84: 0xf8db, // rotatedHeavyBlackHeartBullet
    0x85: 0xf8dc, // floralHeart
    0x86: 0xf8dd, // rotatedFloralHeartBullet
    0x87: 0xf8de, // mediumLeftParenthesisOrnament
    0x88: 0xf8df, // mediumRightParenthesisOrnament
    0x89: 0xf8e0, // mediumFlattenedLeftParenthesisOrnament
    0x8a: 0xf8e1, // mediumFlattenedRightParenthesisOrnament
    0x8b: 0xf8e2, // mediumPointingRightIndex
    0x8c: 0xf8e3, // mediumPointingLeftIndex
    0x8d: 0xf8e4, // mediumPointingUpIndex
    0xa1: 0x2761, // curvedStemParagraphSignOrnament2
    0xa2: 0x2762, // heavyExclamationMarkOrnament2
    0xa3: 0x2763, // heavyHeartExclamationMarkOrnament2
    0xa4: 0x2764, // heavyBlackHeart
    0xa5: 0x2765, // rotatedHeavyBlackHeartBullet2
    0xa6: 0x2766, // floralHeart2
    0xa7: 0x2767, // rotatedFloralHeartBullet2
    0xa8: 0x2663, // blackClubSuit
    0xa9: 0x2666, // blackDiamondSuit
    0xaa: 0x2665, // blackHeartSuit
    0xab: 0x2660, // blackSpadeSuit
    0xac: 0x2460, // circledDigitOne
    0xad: 0x2461, // circledDigitTwo
    0xae: 0x2462, // circledDigitThree
    0xaf: 0x2463, // circledDigitFour
    0xb0: 0x2464, // circledDigitFive
    0xb1: 0x2465, // circledDigitSix
    0xb2: 0x2466, // circledDigitSeven
    0xb3: 0x2467, // circledDigitEight
    0xb4: 0x2468, // circledDigitNine
    0xb5: 0x2469, // circledNumberTen
    0xb6: 0x2776, // dingbatNegativeCircledDigitOne
    0xb7: 0x2777, // dingbatNegativeCircledDigitTwo
    0xb8: 0x2778, // dingbatNegativeCircledDigitThree
    0xb9: 0x2779, // dingbatNegativeCircledDigitFour
    0xba: 0x277a, // dingbatNegativeCircledDigitFive
    0xbb: 0x277b, // dingbatNegativeCircledDigitSix
    0xbc: 0x277c, // dingbatNegativeCircledDigitSeven
    0xbd: 0x277d, // dingbatNegativeCircledDigitEight
    0xbe: 0x277e, // dingbatNegativeCircledDigitNine
    0xbf: 0x277f, // dingbatNegativeCircledNumberTen
    0xc0: 0x2780, // dingbatCircledSanSerifDigitOne
    0xc1: 0x2781, // dingbatCircledSanSerifDigitTwo
    0xc2: 0x2782, // dingbatCircledSanSerifDigitThree
    0xc3: 0x2783, // dingbatCircledSanSerifDigitFour
    0xc4: 0x2784, // dingbatCircledSanSerifDigitFive
    0xc5: 0x2785, // dingbatCircledSanSerifDigitSix
    0xc6: 0x2786, // dingbatCircledSanSerifDigitSeven
    0xc7: 0x2787, // dingbatCircledSanSerifDigitEight
    0xc8: 0x2788, // dingbatCircledSanSerifDigitNine
    0xc9: 0x2789, // dingbatCircledSanSerifNumberTen
    0xca: 0x278a, // dingbatNegativeCircledSanSerifDigitOne
    0xcb: 0x278b, // dingbatNegativeCircledSanSerifDigitTwo
    0xcc: 0x278c, // dingbatNegativeCircledSanSerifDigitThree
    0xcd: 0x278d, // dingbatNegativeCircledSanSerifDigitFour
    0xce: 0x278e, // dingbatNegativeCircledSanSerifDigitFive
    0xcf: 0x278f, // dingbatNegativeCircledSanSerifDigitSix
    0xd0: 0x2790, // dingbatNegativeCircledSanSerifDigitSeven
    0xd1: 0x2791, // dingbatNegativeCircledSanSerifDigitEight
    0xd2: 0x2792, // dingbatNegativeCircledSanSerifDigitNine
    0xd3: 0x2793, // dingbatNegativeCircledSanSerifNumberTen
    0xd4: 0x2794, // heavyWideHeadedRightArrow
    0xd5: 0x2795, // heavyPlusSign (alt)
    0xd6: 0x2796, // heavyMinusSign (alt)
    0xd7: 0x2797, // heavyDivisionSign (alt)
    0xd8: 0x2798, // heavySouthEastArrow
    0xd9: 0x2799, // heavyRightArrow
    0xda: 0x279a, // heavyNorthEastArrow
    0xdb: 0x279b, // draftingPointRightArrow
    0xdc: 0x279c, // heavyRoundTippedRightArrow
    0xdd: 0x279d, // triangleHeadedRightArrow
    0xde: 0x279e, // heavyTriangleHeadedRightArrow
    0xdf: 0x279f, // dashedTriangleHeadedRightArrow
    0xe0: 0x27a0, // heavyDashedTriangleHeadedRightArrow
    0xe1: 0x27a1, // blackRightArrow
    0xe2: 0x27a2, // threeDTopLightedRightArrowHead
    0xe3: 0x27a3, // threeDBottomLightedRightArrowHead
    0xe4: 0x27a4, // blackRightArrowHead
    0xe5: 0x27a5, // heavyBlackCurvedDownAndRightArrow
    0xe6: 0x27a6, // heavyBlackCurvedUpAndRightArrow
    0xe7: 0x27a7, // squeezedBlackRightArrow
    0xe8: 0x27a8, // heavyConcavePointedBlackRightArrow
    0xe9: 0x27a9, // rightShadedWhiteRightArrow
    0xea: 0x27aa, // leftShadedWhiteRightArrow
    0xeb: 0x27ab, // backTiltedShadowedWhiteRightArrow
    0xec: 0x27ac, // frontTiltedShadowedWhiteRightArrow
    0xed: 0x27ad, // heavyLowerRightShadowedWhiteRightArrow
    0xee: 0x27ae, // heavyUpperRightShadowedWhiteRightArrow
    0xef: 0x27af, // notchedLowerRightShadowedWhiteRightArrow
    0xf1: 0x27b1, // notchedUpperRightShadowedWhiteRightArrow
    0xf2: 0x27b2, // circledHeavyWhiteRightArrow
    0xf3: 0x27b3, // whiteFeatheredRightArrow
    0xf4: 0x27b4, // blackFeatheredSouthEastArrow
    0xf5: 0x27b5, // blackFeatheredRightArrow
    0xf6: 0x27b6, // blackFeatheredNorthEastArrow
    0xf7: 0x27b7, // heavyBlackFeatheredSouthEastArrow
    0xf8: 0x27b8, // heavyBlackFeatheredRightArrow
    0xf9: 0x27b9, // heavyBlackFeatheredNorthEastArrow
    0xfa: 0x27ba, // tearDropBarbedRightArrow
    0xfb: 0x27bb, // heavyTearDropShankedRightArrow
    0xfc: 0x27bc, // wedgeTailedRightArrow
    0xfd: 0x27bd, // heavyWedgeTailedRightArrow
    0xfe: 0x27be // openOutlinedRightArrow
  };

  for (const [code, cp] of Object.entries(mappings)) {
    table[Number(code)] = String.fromCodePoint(cp);
  }
  return table;
})();

// =============================================================================
// Adobe Glyph List (Core Subset)
// =============================================================================

/**
 * Maps Adobe glyph names to Unicode code points.
 * This is a comprehensive subset covering all commonly used glyphs.
 */
const GLYPH_TO_UNICODE: Record<string, number> = {
  // ASCII
  space: 0x0020,
  exclam: 0x0021,
  quotedbl: 0x0022,
  numbersign: 0x0023,
  dollar: 0x0024,
  percent: 0x0025,
  ampersand: 0x0026,
  quotesingle: 0x0027,
  parenleft: 0x0028,
  parenright: 0x0029,
  asterisk: 0x002a,
  plus: 0x002b,
  comma: 0x002c,
  hyphen: 0x002d,
  period: 0x002e,
  slash: 0x002f,
  zero: 0x0030,
  one: 0x0031,
  two: 0x0032,
  three: 0x0033,
  four: 0x0034,
  five: 0x0035,
  six: 0x0036,
  seven: 0x0037,
  eight: 0x0038,
  nine: 0x0039,
  colon: 0x003a,
  semicolon: 0x003b,
  less: 0x003c,
  equal: 0x003d,
  greater: 0x003e,
  question: 0x003f,
  at: 0x0040,
  A: 0x0041,
  B: 0x0042,
  C: 0x0043,
  D: 0x0044,
  E: 0x0045,
  F: 0x0046,
  G: 0x0047,
  H: 0x0048,
  I: 0x0049,
  J: 0x004a,
  K: 0x004b,
  L: 0x004c,
  M: 0x004d,
  N: 0x004e,
  O: 0x004f,
  P: 0x0050,
  Q: 0x0051,
  R: 0x0052,
  S: 0x0053,
  T: 0x0054,
  U: 0x0055,
  V: 0x0056,
  W: 0x0057,
  X: 0x0058,
  Y: 0x0059,
  Z: 0x005a,
  bracketleft: 0x005b,
  backslash: 0x005c,
  bracketright: 0x005d,
  asciicircum: 0x005e,
  underscore: 0x005f,
  grave: 0x0060,
  a: 0x0061,
  b: 0x0062,
  c: 0x0063,
  d: 0x0064,
  e: 0x0065,
  f: 0x0066,
  g: 0x0067,
  h: 0x0068,
  i: 0x0069,
  j: 0x006a,
  k: 0x006b,
  l: 0x006c,
  m: 0x006d,
  n: 0x006e,
  o: 0x006f,
  p: 0x0070,
  q: 0x0071,
  r: 0x0072,
  s: 0x0073,
  t: 0x0074,
  u: 0x0075,
  v: 0x0076,
  w: 0x0077,
  x: 0x0078,
  y: 0x0079,
  z: 0x007a,
  braceleft: 0x007b,
  bar: 0x007c,
  braceright: 0x007d,
  asciitilde: 0x007e,

  // Latin extended
  Agrave: 0x00c0,
  Aacute: 0x00c1,
  Acircumflex: 0x00c2,
  Atilde: 0x00c3,
  Adieresis: 0x00c4,
  Aring: 0x00c5,
  AE: 0x00c6,
  Ccedilla: 0x00c7,
  Egrave: 0x00c8,
  Eacute: 0x00c9,
  Ecircumflex: 0x00ca,
  Edieresis: 0x00cb,
  Igrave: 0x00cc,
  Iacute: 0x00cd,
  Icircumflex: 0x00ce,
  Idieresis: 0x00cf,
  Eth: 0x00d0,
  Ntilde: 0x00d1,
  Ograve: 0x00d2,
  Oacute: 0x00d3,
  Ocircumflex: 0x00d4,
  Otilde: 0x00d5,
  Odieresis: 0x00d6,
  Oslash: 0x00d8,
  Ugrave: 0x00d9,
  Uacute: 0x00da,
  Ucircumflex: 0x00db,
  Udieresis: 0x00dc,
  Yacute: 0x00dd,
  Thorn: 0x00de,
  germandbls: 0x00df,
  agrave: 0x00e0,
  aacute: 0x00e1,
  acircumflex: 0x00e2,
  atilde: 0x00e3,
  adieresis: 0x00e4,
  aring: 0x00e5,
  ae: 0x00e6,
  ccedilla: 0x00e7,
  egrave: 0x00e8,
  eacute: 0x00e9,
  ecircumflex: 0x00ea,
  edieresis: 0x00eb,
  igrave: 0x00ec,
  iacute: 0x00ed,
  icircumflex: 0x00ee,
  idieresis: 0x00ef,
  eth: 0x00f0,
  ntilde: 0x00f1,
  ograve: 0x00f2,
  oacute: 0x00f3,
  ocircumflex: 0x00f4,
  otilde: 0x00f5,
  odieresis: 0x00f6,
  oslash: 0x00f8,
  ugrave: 0x00f9,
  uacute: 0x00fa,
  ucircumflex: 0x00fb,
  udieresis: 0x00fc,
  yacute: 0x00fd,
  thorn: 0x00fe,
  ydieresis: 0x00ff,

  // Symbols and punctuation
  bullet: 0x2022,
  endash: 0x2013,
  emdash: 0x2014,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  quoteleft: 0x2018,
  quoteright: 0x2019,
  quotesinglbase: 0x201a,
  quotedblbase: 0x201e,
  dagger: 0x2020,
  daggerdbl: 0x2021,
  ellipsis: 0x2026,
  perthousand: 0x2030,
  guilsinglleft: 0x2039,
  guilsinglright: 0x203a,
  guillemotleft: 0x00ab,
  guillemotright: 0x00bb,
  fraction: 0x2044,
  fi: 0xfb01,
  fl: 0xfb02,
  minus: 0x2212,
  multiply: 0x00d7,
  divide: 0x00f7,
  degree: 0x00b0,
  cent: 0x00a2,
  sterling: 0x00a3,
  yen: 0x00a5,
  Euro: 0x20ac,
  copyright: 0x00a9,
  registered: 0x00ae,
  trademark: 0x2122,
  section: 0x00a7,
  paragraph: 0x00b6,
  Lslash: 0x0141,
  lslash: 0x0142,
  OE: 0x0152,
  oe: 0x0153,
  Scaron: 0x0160,
  scaron: 0x0161,
  Zcaron: 0x017d,
  zcaron: 0x017e,
  Ydieresis: 0x0178,
  dotlessi: 0x0131,
  circumflex: 0x02c6,
  tilde: 0x02dc,
  macron: 0x00af,
  breve: 0x02d8,
  dotaccent: 0x02d9,
  ring: 0x02da,
  cedilla: 0x00b8,
  hungarumlaut: 0x02dd,
  ogonek: 0x02db,
  caron: 0x02c7,
  florin: 0x0192,

  // Special
  nbspace: 0x00a0,
  sfthyphen: 0x00ad,
  exclamdown: 0x00a1,
  questiondown: 0x00bf,
  currency: 0x00a4,
  brokenbar: 0x00a6,
  dieresis: 0x00a8,
  ordfeminine: 0x00aa,
  ordmasculine: 0x00ba,
  logicalnot: 0x00ac,
  acute: 0x00b4,
  mu: 0x00b5,
  periodcentered: 0x00b7,
  onesuperior: 0x00b9,
  twosuperior: 0x00b2,
  threesuperior: 0x00b3,
  onequarter: 0x00bc,
  onehalf: 0x00bd,
  threequarters: 0x00be,
  plusminus: 0x00b1
};
