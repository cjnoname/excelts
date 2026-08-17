/**
 * TrueType font file parser.
 *
 * Reads a TrueType (.ttf) or TrueType-flavored OpenType (.otf) font file
 * and extracts the tables needed for PDF font embedding:
 * - head: font header (units per em, index format)
 * - hhea: horizontal header (ascent, descent, line gap, number of hmetrics)
 * - maxp: maximum profile (number of glyphs)
 * - OS/2: OS/2 and Windows metrics (weights, widths, unicode ranges)
 * - cmap: character-to-glyph mapping (we use format 4 for BMP or format 12 for full Unicode)
 * - hmtx: horizontal metrics (advance width and left side bearing per glyph)
 * - post: PostScript name mapping
 * - loca: glyph location index (offsets into glyf table)
 * - glyf: glyph outlines (needed for subsetting)
 * - name: naming table (font family name, style, etc.)
 *
 * TrueType is Big Endian throughout.
 *
 * @see https://docs.microsoft.com/en-us/typography/opentype/spec/
 */

import { PdfFontError } from "@pdf/errors";

// =============================================================================
// Security Limits
// =============================================================================

/**
 * Maximum number of groups allowed in a cmap format 12 table.
 * The cmap format 12 numGroups field is u32 (max ~4 billion).
 * A malicious font could declare billions of groups to cause CPU exhaustion.
 * 65536 groups is more than sufficient for any legitimate font.
 */
const MAX_CMAP12_GROUPS = 65_536;

/**
 * Maximum number of total codepoints expanded from cmap format 12 groups.
 * Unicode has 1,114,112 valid codepoints (U+0000 to U+10FFFF).
 * Legitimate fonts map a subset of these. We cap at 2M to allow
 * generous coverage while preventing memory exhaustion.
 */
const MAX_CMAP12_TOTAL_CODEPOINTS = 2_000_000;

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed TrueType font data needed for PDF embedding.
 */
export interface TtfFont {
  /** Raw font file bytes */
  readonly data: Uint8Array;

  /** Font family name (from name table, nameID 1) */
  readonly familyName: string;

  /** PostScript name (from name table, nameID 6) */
  readonly postScriptName: string;

  /** Units per em (from head table) */
  readonly unitsPerEm: number;

  /** Ascent in font units (from OS/2 sTypoAscender or hhea ascent) */
  readonly ascent: number;

  /** Descent in font units (negative, from OS/2 sTypoDescender or hhea descent) */
  readonly descent: number;

  /** Cap height in font units (from OS/2 sCapHeight, or estimated) */
  readonly capHeight: number;

  /** Italic angle in degrees (from post table) */
  readonly italicAngle: number;

  /** Font flags for PDF font descriptor */
  readonly flags: number;

  /** Font bounding box [xMin, yMin, xMax, yMax] in font units */
  readonly bbox: [number, number, number, number];

  /** StemV approximation for PDF font descriptor */
  readonly stemV: number;

  /** Number of glyphs in the font */
  readonly numGlyphs: number;

  /** Index-to-location format (0 = short offsets, 1 = long offsets) */
  readonly indexToLocFormat: number;

  /** Number of horizontal metrics entries (from hhea) */
  readonly numHMetrics: number;

  /** Table directory: tag → { offset, length } */
  readonly tables: Map<string, TableEntry>;

  /** Character-to-glyph ID mapping (Unicode code point → glyph ID) */
  readonly cmap: Map<number, number>;

  /** Advance widths per glyph ID (in font units) */
  readonly advanceWidths: Uint16Array;

  /**
   * Left side bearings per glyph ID (in font units), which may be negative.
   *
   * Before drawing, a TrueType rasterizer translates the outline by
   * `lsb - xMin`, so the ink lands at `pen + lsb` — the bearing, not the
   * outline's own `xMin`, decides where the glyph is painted inside its
   * advance width. FreeType does this unconditionally (`TT_Load_Glyph`, which
   * makes pdfium/Chrome, Poppler and MuPDF follow), and Acrobat behaves the
   * same. Anything that rewrites `hmtx` must therefore carry these through
   * next to the outlines they belong to.
   */
  readonly leftSideBearings: Int16Array;

  /** Glyph offsets (from loca table), used for subsetting */
  readonly glyphOffsets: Uint32Array;
}

export interface TableEntry {
  readonly offset: number;
  readonly length: number;
}

// =============================================================================
// Big Endian Reader
// =============================================================================

/**
 * Big-endian reader bounded to the region it may read.
 *
 * Every table is read through a reader limited to that table's declared extent,
 * so a table too short for the contents it describes fails as a `PdfFontError`
 * naming the table, instead of quietly reading whatever bytes follow it — or
 * running off the end of the file, which a `DataView` reports as an opaque
 * `RangeError`. Fonts are untrusted input; the diagnosis has to say which table
 * is broken.
 */
class BEReader {
  private view: DataView;
  private data: Uint8Array;
  /** Exclusive end of the readable region. */
  private limit: number;
  /** What the region is, for error messages. */
  private region: string;
  offset: number;

  constructor(data: Uint8Array, offset = 0, limit = data.length, region = "font") {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = offset;
    this.limit = Math.min(limit, data.length);
    this.region = region;
  }

  /** Claim `bytes` at the current offset and step over them. */
  private take(bytes: number): number {
    const at = this.claim(this.offset, bytes);
    this.offset = at + bytes;
    return at;
  }

  /** Claim `bytes` at an absolute offset, leaving the cursor alone. */
  private claim(at: number, bytes: number): number {
    if (at < 0 || at + bytes > this.limit) {
      throw new PdfFontError(
        `Invalid TrueType font: ${this.region} is truncated ` +
          `(wanted ${bytes} byte(s) at ${at}, region ends at ${this.limit})`
      );
    }
    return at;
  }

  /** Whether `bytes` more can be read, for a region with an optional tail. */
  canRead(bytes: number): boolean {
    return this.offset + bytes <= this.limit;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), false);
  }

  i16(): number {
    return this.view.getInt16(this.take(2), false);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), false);
  }

  i32(): number {
    return this.view.getInt32(this.take(4), false);
  }

  /** Read a Fixed 16.16 number */
  fixed(): number {
    const v = this.i32();
    return v / 65536;
  }

  bytes(len: number): Uint8Array {
    const at = this.take(len);
    return this.data.subarray(at, at + len);
  }

  tag(): string {
    return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
  }

  skip(n: number): void {
    this.take(n);
  }

  /** A reader at another position in the same region. */
  at(offset: number): BEReader {
    return new BEReader(this.data, offset, this.limit, this.region);
  }

  /** A reader over one table, bounded to what the table directory declares. */
  atTable(tag: string, entry: TableEntry): BEReader {
    return new BEReader(this.data, entry.offset, entry.offset + entry.length, `table '${tag}'`);
  }

  u16At(offset: number): number {
    return this.view.getUint16(this.claim(offset, 2), false);
  }

  u32At(offset: number): number {
    return this.view.getUint32(this.claim(offset, 4), false);
  }

  i16At(offset: number): number {
    return this.view.getInt16(this.claim(offset, 2), false);
  }
}

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse a TrueType font file.
 *
 * @param data - Raw .ttf or .otf file bytes
 * @returns Parsed font data
 * @throws {PdfFontError} If the font is invalid or unsupported
 */
export function parseTtf(data: Uint8Array, collectionIndex = 0): TtfFont {
  if (!Number.isFinite(collectionIndex) || !Number.isInteger(collectionIndex)) {
    throw new PdfFontError("TrueType collection index must be a finite integer");
  }
  if (collectionIndex < 0) {
    throw new PdfFontError("TrueType collection index must not be negative");
  }
  if (data.byteLength < 4) {
    throw new PdfFontError("Invalid TrueType font: header is truncated");
  }

  const r = new BEReader(data);

  // --- Check for TTC (TrueType Collection) ---
  const magic = r.u32();
  if (magic === 0x74746366) {
    // 'ttcf' — TrueType Collection
    if (data.byteLength < 12) {
      throw new PdfFontError("Invalid TrueType Collection: header is truncated");
    }
    const version = r.u32();
    if (version !== 0x00010000 && version !== 0x00020000) {
      throw new PdfFontError(
        `Invalid TrueType Collection: unsupported version 0x${version.toString(16)}`
      );
    }
    const numFonts = r.u32();
    if (numFonts === 0) {
      throw new PdfFontError("TrueType Collection is empty (0 fonts)");
    }
    if (numFonts > Math.floor((data.byteLength - 12) / 4)) {
      throw new PdfFontError("Invalid TrueType Collection: font offset table is truncated");
    }
    if (collectionIndex >= numFonts) {
      throw new PdfFontError(
        `TrueType collection index ${collectionIndex} is out of range (0-${numFonts - 1})`
      );
    }
    const fontOffset = r.u32At(12 + collectionIndex * 4);
    if (fontOffset > data.byteLength - 12) {
      throw new PdfFontError(
        `Invalid TrueType Collection: font ${collectionIndex} header is out of range`
      );
    }
    return parseTtfAtOffset(data, fontOffset);
  }

  if (collectionIndex !== 0) {
    throw new PdfFontError("TrueType collection index must be 0 for a non-collection font");
  }
  if (data.byteLength < 12) {
    throw new PdfFontError("Invalid TrueType font: header is truncated");
  }

  // Not TTC — parse as regular TTF starting from the magic we already read
  return parseTtfFromMagic(data, r, magic);
}

/**
 * Parse a TTF font starting at a given byte offset within the data.
 * Used for TTC collections where each font starts at a different offset.
 */
function parseTtfAtOffset(data: Uint8Array, offset: number): TtfFont {
  const r = new BEReader(data, offset);
  const magic = r.u32();
  return parseTtfFromMagic(data, r, magic);
}

/**
 * Core TTF parsing after the first 4 bytes (sfVersion) have been read.
 */
function parseTtfFromMagic(data: Uint8Array, r: BEReader, sfVersion: number): TtfFont {
  // --- Offset table ---
  // TrueType: 0x00010000 or 'true' (0x74727565)
  // OpenType with CFF: 'OTTO' (0x4F54544F) — not supported for subsetting
  if (sfVersion !== 0x00010000 && sfVersion !== 0x74727565) {
    if (sfVersion === 0x4f54544f) {
      throw new PdfFontError(
        "CFF-flavored OpenType (.otf) is not supported. Use a TrueType (.ttf) font."
      );
    }
    throw new PdfFontError(`Invalid TrueType font: bad sfVersion 0x${sfVersion.toString(16)}`);
  }

  const fontOffset = r.offset - 4;
  if (fontOffset < 0 || fontOffset > data.byteLength - 12) {
    throw new PdfFontError("Invalid TrueType font: header is truncated");
  }
  const numTables = r.u16();
  r.skip(6); // searchRange, entrySelector, rangeShift
  if (numTables > Math.floor((data.byteLength - r.offset) / 16)) {
    throw new PdfFontError("Invalid TrueType font: table directory is truncated");
  }

  // --- Table directory ---
  const tables = new Map<string, TableEntry>();
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    r.skip(4); // checksum
    const offset = r.u32();
    const length = r.u32();
    if (offset > data.byteLength || length > data.byteLength - offset) {
      throw new PdfFontError(`Invalid TrueType font: table '${tag}' is out of range`);
    }
    tables.set(tag, { offset, length });
  }

  // --- Validate required tables ---
  const required = ["head", "hhea", "maxp", "cmap", "hmtx"];
  for (const t of required) {
    if (!tables.has(t)) {
      throw new PdfFontError(`Missing required table '${t}' in TrueType font`);
    }
  }

  // --- head table ---
  const head = readHead(r, tables.get("head")!);

  // --- hhea table ---
  const hhea = readHhea(r, tables.get("hhea")!);

  // --- maxp table ---
  const maxp = readMaxp(r, tables.get("maxp")!);

  // --- OS/2 table (optional but common) ---
  const os2 = tables.has("OS/2") ? readOs2(r, tables.get("OS/2")!) : null;

  // --- post table ---
  const post = tables.has("post") ? readPost(r, tables.get("post")!) : null;

  // --- name table ---
  const names = tables.has("name") ? readName(r, tables.get("name")!) : null;

  // --- cmap table ---
  const cmap = readCmap(r, tables.get("cmap")!);

  // --- hmtx table ---
  const { advanceWidths, leftSideBearings } = readHmtx(
    r,
    tables.get("hmtx")!,
    hhea.numHMetrics,
    maxp.numGlyphs
  );

  // --- loca table ---
  const glyphOffsets =
    tables.has("loca") && tables.has("glyf")
      ? readLoca(
          r,
          tables.get("loca")!,
          maxp.numGlyphs,
          head.indexToLocFormat,
          tables.get("glyf")!.length
        )
      : new Uint32Array(maxp.numGlyphs + 1);

  // --- Compute font descriptor values ---
  const ascent = os2?.sTypoAscender ?? hhea.ascent;
  const descent = os2?.sTypoDescender ?? hhea.descent;
  const capHeight = os2?.sCapHeight ?? Math.round(ascent * 0.7);

  let flags = 0;
  // Bit 1 (FixedPitch): check post.isFixedPitch
  if (post?.isFixedPitch) {
    flags |= 1;
  }
  // Bit 3 (Symbolic): we mark non-symbolic since we use Unicode
  // Bit 6 (Italic): check head.macStyle bit 1 or post.italicAngle != 0
  if (head.macStyle & 0x02) {
    flags |= 1 << 6;
  }
  // Bit 2 (Serif): approximate from OS/2 sFamilyClass
  // Bit 5 (Nonsymbolic): we always set this for Unicode fonts
  flags |= 1 << 5; // Nonsymbolic

  // StemV approximation from weight class
  const weight = os2?.usWeightClass ?? 400;
  const stemV = Math.round(50 + (weight / 65) ** 2);

  const familyName = names?.familyName ?? "Unknown";
  const postScriptName = names?.postScriptName ?? familyName.replace(/\s+/g, "");

  return {
    data,
    familyName,
    postScriptName,
    unitsPerEm: head.unitsPerEm,
    ascent,
    descent,
    capHeight,
    italicAngle: post?.italicAngle ?? 0,
    flags,
    bbox: [head.xMin, head.yMin, head.xMax, head.yMax],
    stemV,
    numGlyphs: maxp.numGlyphs,
    indexToLocFormat: head.indexToLocFormat,
    numHMetrics: hhea.numHMetrics,
    tables,
    cmap,
    advanceWidths,
    leftSideBearings,
    glyphOffsets
  };
}

// =============================================================================
// Table Readers
// =============================================================================

interface HeadData {
  unitsPerEm: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  macStyle: number;
  indexToLocFormat: number;
}

function readHead(r: BEReader, entry: TableEntry): HeadData {
  const tr = r.atTable("head", entry);
  tr.skip(4); // majorVersion, minorVersion
  tr.skip(4); // fontRevision (Fixed)
  tr.skip(4); // checksumAdjustment
  tr.skip(4); // magicNumber
  tr.skip(2); // flags
  const unitsPerEm = tr.u16();
  tr.skip(16); // created, modified (LONGDATETIME × 2)
  const xMin = tr.i16();
  const yMin = tr.i16();
  const xMax = tr.i16();
  const yMax = tr.i16();
  const macStyle = tr.u16();
  tr.skip(2); // lowestRecPPEM
  tr.skip(2); // fontDirectionHint
  const indexToLocFormat = tr.i16();
  return { unitsPerEm, xMin, yMin, xMax, yMax, macStyle, indexToLocFormat };
}

interface HheaData {
  ascent: number;
  descent: number;
  lineGap: number;
  numHMetrics: number;
}

function readHhea(r: BEReader, entry: TableEntry): HheaData {
  const tr = r.atTable("hhea", entry);
  tr.skip(4); // majorVersion, minorVersion
  const ascent = tr.i16();
  const descent = tr.i16();
  const lineGap = tr.i16();
  tr.skip(2); // advanceWidthMax
  tr.skip(2 * 11); // 11 more int16/uint16 fields
  const numHMetrics = tr.u16();
  return { ascent, descent, lineGap, numHMetrics };
}

interface MaxpData {
  numGlyphs: number;
}

function readMaxp(r: BEReader, entry: TableEntry): MaxpData {
  const tr = r.atTable("maxp", entry);
  tr.skip(4); // version
  const numGlyphs = tr.u16();
  return { numGlyphs };
}

interface Os2Data {
  usWeightClass: number;
  sTypoAscender: number;
  sTypoDescender: number;
  sCapHeight: number;
}

function readOs2(r: BEReader, entry: TableEntry): Os2Data {
  const tr = r.atTable("OS/2", entry);
  const version = tr.u16();
  tr.skip(2); // xAvgCharWidth
  const usWeightClass = tr.u16();
  tr.skip(2); // usWidthClass
  tr.skip(2); // fsType
  tr.skip(2 * 11); // ySubscript*, ySuperscript*, yStrikeout*, sFamilyClass
  tr.skip(10); // panose[10]
  tr.skip(4 * 4); // ulUnicodeRange 1-4
  tr.skip(4); // achVendID
  tr.skip(2); // fsSelection
  tr.skip(2); // usFirstCharIndex
  tr.skip(2); // usLastCharIndex
  const sTypoAscender = tr.i16();
  const sTypoDescender = tr.i16();
  tr.skip(2); // sTypoLineGap
  tr.skip(2); // usWinAscent
  tr.skip(2); // usWinDescent

  let sCapHeight: number;
  if (version >= 2) {
    tr.skip(4 * 2); // ulCodePageRange 1-2
    tr.skip(2); // sxHeight
    sCapHeight = tr.i16();
  } else {
    sCapHeight = Math.round(sTypoAscender * 0.7);
  }

  return { usWeightClass, sTypoAscender, sTypoDescender, sCapHeight };
}

interface PostData {
  italicAngle: number;
  isFixedPitch: boolean;
}

function readPost(r: BEReader, entry: TableEntry): PostData {
  const tr = r.atTable("post", entry);
  tr.skip(4); // version (Fixed)
  const italicAngle = tr.fixed();
  tr.skip(2); // underlinePosition
  tr.skip(2); // underlineThickness
  const isFixedPitch = tr.u32() !== 0;
  return { italicAngle, isFixedPitch };
}

interface NameData {
  familyName: string;
  postScriptName: string;
}

function readName(r: BEReader, entry: TableEntry): NameData {
  const base = entry.offset;
  const tr = r.atTable("name", entry);
  tr.skip(2); // format
  const count = tr.u16();
  const storageOffset = tr.u16();
  const stringStorageBase = base + storageOffset;

  let familyName = "";
  let postScriptName = "";

  for (let i = 0; i < count; i++) {
    const platformID = tr.u16();
    const encodingID = tr.u16();
    tr.skip(2); // languageID
    const nameID = tr.u16();
    const length = tr.u16();
    const offset = tr.u16();

    // We want nameID 1 (family) and nameID 6 (PostScript name)
    if (nameID !== 1 && nameID !== 6) {
      continue;
    }

    const strBytes = tr.at(stringStorageBase + offset).bytes(length);
    let str: string;

    if (platformID === 3 || platformID === 0) {
      // Windows (platformID=3) or Unicode (platformID=0): UTF-16BE
      str = decodeUtf16BE(strBytes);
    } else if (platformID === 1 && encodingID === 0) {
      // Macintosh Roman
      str = decodeMacRoman(strBytes);
    } else {
      continue;
    }

    if (nameID === 1 && !familyName) {
      familyName = str;
    }
    if (nameID === 6 && !postScriptName) {
      postScriptName = str;
    }
  }

  return {
    familyName: familyName || "Unknown",
    postScriptName: postScriptName || familyName || "Unknown"
  };
}

// =============================================================================
// cmap Table
// =============================================================================

/**
 * Read the cmap table and extract a Unicode code point → glyph ID mapping.
 * Prefers format 12 (full Unicode) over format 4 (BMP only).
 */
function readCmap(r: BEReader, entry: TableEntry): Map<number, number> {
  const base = entry.offset;
  const tr = r.atTable("cmap", entry);
  tr.skip(2); // version
  const numSubtables = tr.u16();

  let format4Offset = -1;
  let format12Offset = -1;

  for (let i = 0; i < numSubtables; i++) {
    const platformID = tr.u16();
    const encodingID = tr.u16();
    const subtableOffset = tr.u32();

    // Look for Unicode or Windows Unicode subtables
    const isUnicode =
      platformID === 0 || // Unicode platform
      (platformID === 3 && (encodingID === 1 || encodingID === 10)); // Windows Unicode BMP or full

    if (!isUnicode) {
      continue;
    }

    const format = tr.u16At(base + subtableOffset);
    if (format === 12 && format12Offset < 0) {
      format12Offset = base + subtableOffset;
    }
    if (format === 4 && format4Offset < 0) {
      format4Offset = base + subtableOffset;
    }
  }

  // Prefer format 12 (full Unicode support)
  if (format12Offset >= 0) {
    return readCmapFormat12(tr, format12Offset);
  }
  if (format4Offset >= 0) {
    return readCmapFormat4(tr, format4Offset);
  }

  throw new PdfFontError("No usable Unicode cmap subtable found in font");
}

/**
 * Read cmap format 4 (Segment mapping to delta values).
 * Handles BMP code points (U+0000 to U+FFFF).
 */
function readCmapFormat4(r: BEReader, offset: number): Map<number, number> {
  const tr = r.at(offset);
  tr.skip(2); // format (4)
  tr.skip(2); // length
  tr.skip(2); // language
  const segCountX2 = tr.u16();
  const segCount = segCountX2 / 2;
  tr.skip(6); // searchRange, entrySelector, rangeShift

  const endCodes: number[] = [];
  for (let i = 0; i < segCount; i++) {
    endCodes.push(tr.u16());
  }
  tr.skip(2); // reservedPad

  const startCodes: number[] = [];
  for (let i = 0; i < segCount; i++) {
    startCodes.push(tr.u16());
  }

  const idDeltas: number[] = [];
  for (let i = 0; i < segCount; i++) {
    idDeltas.push(tr.i16());
  }

  const idRangeOffsetPos = tr.offset;
  const idRangeOffsets: number[] = [];
  for (let i = 0; i < segCount; i++) {
    idRangeOffsets.push(tr.u16());
  }

  const map = new Map<number, number>();

  for (let i = 0; i < segCount; i++) {
    const start = startCodes[i];
    const end = endCodes[i];
    const delta = idDeltas[i];
    const rangeOffset = idRangeOffsets[i];

    if (start === 0xffff) {
      break;
    }

    for (let cp = start; cp <= end; cp++) {
      let glyphId: number;
      if (rangeOffset === 0) {
        glyphId = (cp + delta) & 0xffff;
      } else {
        // Read from the glyph ID array
        const glyphOffset = idRangeOffsetPos + i * 2 + rangeOffset + (cp - start) * 2;
        glyphId = r.u16At(glyphOffset);
        if (glyphId !== 0) {
          glyphId = (glyphId + delta) & 0xffff;
        }
      }
      if (glyphId !== 0) {
        map.set(cp, glyphId);
      }
    }
  }

  return map;
}

/**
 * Read cmap format 12 (Segmented coverage).
 * Handles the full Unicode range (U+0000 to U+10FFFF).
 */
function readCmapFormat12(r: BEReader, offset: number): Map<number, number> {
  const tr = r.at(offset);
  tr.skip(2); // format (12)
  tr.skip(2); // reserved
  tr.skip(4); // length
  tr.skip(4); // language
  const numGroups = tr.u32();

  // Guard against malicious fonts with excessive group counts
  if (numGroups > MAX_CMAP12_GROUPS) {
    throw new PdfFontError(
      `cmap format 12 has ${numGroups} groups, exceeding limit of ${MAX_CMAP12_GROUPS}. ` +
        "The font file may be malicious or corrupted."
    );
  }

  const map = new Map<number, number>();
  let totalCodepoints = 0;

  for (let i = 0; i < numGroups; i++) {
    const startCharCode = tr.u32();
    const endCharCode = tr.u32();
    const startGlyphID = tr.u32();

    // Validate range is not excessively large
    const rangeSize = endCharCode >= startCharCode ? endCharCode - startCharCode + 1 : 0;
    totalCodepoints += rangeSize;
    if (totalCodepoints > MAX_CMAP12_TOTAL_CODEPOINTS) {
      throw new PdfFontError(
        `cmap format 12 maps too many codepoints (>${MAX_CMAP12_TOTAL_CODEPOINTS}). ` +
          "The font file may be malicious or corrupted."
      );
    }

    for (let cp = startCharCode; cp <= endCharCode; cp++) {
      map.set(cp, startGlyphID + (cp - startCharCode));
    }
  }

  return map;
}

// =============================================================================
// hmtx Table
// =============================================================================

interface HmtxData {
  advanceWidths: Uint16Array;
  leftSideBearings: Int16Array;
}

/**
 * Read horizontal metrics: the advance width and the left side bearing of
 * every glyph.
 *
 * `hmtx` stores `numHMetrics` `longHorMetric` records (advance width + left
 * side bearing), followed by a bare int16 array carrying the bearings of the
 * remaining glyphs — the monospaced tail, whose advance width is the last one
 * spelled out. The tail is not exotic: Courier New ships 3 long records for
 * 3151 glyphs, so almost every bearing in it lives in that trailing array.
 *
 * Reads stop at the extent the table directory declares, and missing metrics
 * fall back to the last advance width and a zero bearing rather than failing the
 * parse. That is what FreeType does with the same font: `tt_face_get_metrics`
 * clamps to the table end, hands out a zero bearing once the trailing array runs
 * out, and reports zero for both when `numberOfHMetrics` is 0 — which the spec
 * forbids, and which leaves nothing here worth guessing at either.
 *
 * @see https://gitlab.freedesktop.org/freetype/freetype/-/blob/master/src/sfnt/ttmtx.c
 */
function readHmtx(
  r: BEReader,
  entry: TableEntry,
  numHMetrics: number,
  numGlyphs: number
): HmtxData {
  const advanceWidths = new Uint16Array(numGlyphs);
  const leftSideBearings = new Int16Array(numGlyphs);

  const tr = r.atTable("hmtx", entry);

  // --- longHorMetric records ---
  // A font that declares more records than it has glyphs is malformed; reading
  // past numGlyphs would only discard the values anyway.
  const longRecords = Math.min(numHMetrics, numGlyphs);
  let lastWidth = 0;
  let gid = 0;
  for (; gid < longRecords && tr.canRead(4); gid++) {
    lastWidth = tr.u16();
    advanceWidths[gid] = lastWidth;
    leftSideBearings[gid] = tr.i16();
  }

  // --- Monospaced tail ---
  // The trailing bearing array begins where the records end, so the reader only
  // sits on it if every declared record was there to be read.
  const atTailStart = gid === numHMetrics && numHMetrics > 0;
  for (; gid < numGlyphs; gid++) {
    advanceWidths[gid] = lastWidth;
    leftSideBearings[gid] = atTailStart && tr.canRead(2) ? tr.i16() : 0;
  }

  return { advanceWidths, leftSideBearings };
}

// =============================================================================
// loca Table
// =============================================================================

/**
 * Read glyph offsets from loca table.
 * Returns numGlyphs+1 offsets (the extra one marks the end of the last glyph).
 *
 * The offsets are the only thing standing between a glyph ID and a range of
 * bytes, so they are returned clamped into `glyf` and non-decreasing. Anything
 * else would hand consumers a byte range that reaches into a neighbouring table
 * or runs backwards — and the subsetter copies whatever range it is given.
 *
 * An offset that breaks either rule collapses onto its predecessor, which reads
 * as an empty glyph. FreeType refuses the same offsets for the same reason
 * (`tt_face_get_location` drops a glyph whose start is past `glyf_len`); where
 * it substitutes an upper bound for a non-monotonic pair, an empty glyph is the
 * safer answer here, because a wrong length is bytes that get embedded.
 */
function readLoca(
  r: BEReader,
  entry: TableEntry,
  numGlyphs: number,
  indexToLocFormat: number,
  glyfLength: number
): Uint32Array {
  const tr = r.atTable("loca", entry);
  const offsets = new Uint32Array(numGlyphs + 1);
  const width = indexToLocFormat === 0 ? 2 : 4;

  let last = 0;
  let previous = 0;
  for (let i = 0; i <= numGlyphs; i++) {
    if (tr.canRead(width)) {
      // Short format stores half the real offset, so it is always even
      last = indexToLocFormat === 0 ? tr.u16() * 2 : tr.u32();
    }
    previous = Math.min(Math.max(last, previous), glyfLength);
    offsets[i] = previous;
  }

  return offsets;
}

// =============================================================================
// String Decoders
// =============================================================================

function decodeUtf16BE(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    if (code >= 0xd800 && code <= 0xdbff && i + 3 < bytes.length) {
      const low = (bytes[i + 2] << 8) | bytes[i + 3];
      if (low >= 0xdc00 && low <= 0xdfff) {
        chars.push(String.fromCodePoint(((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000));
        i += 2;
        continue;
      }
    }
    chars.push(String.fromCharCode(code));
  }
  return chars.join("");
}

function decodeMacRoman(bytes: Uint8Array): string {
  // Mac Roman is close to ASCII for 0-127; for simplicity treat as Latin1
  const chars: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    chars.push(String.fromCharCode(bytes[i]));
  }
  return chars.join("");
}
