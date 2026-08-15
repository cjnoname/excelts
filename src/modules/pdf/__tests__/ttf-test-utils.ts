/**
 * Shared TTF test utilities.
 *
 * Provides helpers for building minimal valid TrueType fonts with controllable
 * cmap coverage. Used by font-embedding, system-fonts, and pdf-exporter tests.
 */

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function encodeUtf16BE(str: string): Uint8Array {
  const buf = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[i * 2] = (code >> 8) & 0xff;
    buf[i * 2 + 1] = code & 0xff;
  }
  return buf;
}

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) {
    total += a.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function buildCmapFormat4(
  segments: Array<{ start: number; end: number; delta: number }>
): Uint8Array {
  // Add the final 0xFFFF segment
  const allSegs = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
  const segCount = allSegs.length;

  // cmap header + encoding record + format 4 subtable
  const headerSize = 4; // version + numTables
  const encodingSize = 8; // one encoding record
  const subtableOffset = headerSize + encodingSize;

  const format4Size = 14 + segCount * 8 + 2; // 14 byte header + 4 arrays × segCount × 2 + reservedPad
  const totalSize = subtableOffset + format4Size;
  const buf = new Uint8Array(totalSize);
  const v = new DataView(buf.buffer);
  let off = 0;

  // cmap header
  v.setUint16(off, 0, false);
  off += 2; // version
  v.setUint16(off, 1, false);
  off += 2; // numTables

  // encoding record
  v.setUint16(off, 3, false);
  off += 2; // platformID = Windows
  v.setUint16(off, 1, false);
  off += 2; // encodingID = Unicode BMP
  v.setUint32(off, subtableOffset, false);
  off += 4;

  // format 4 subtable
  v.setUint16(off, 4, false);
  off += 2; // format
  v.setUint16(off, format4Size, false);
  off += 2; // length
  v.setUint16(off, 0, false);
  off += 2; // language
  v.setUint16(off, segCount * 2, false);
  off += 2; // segCountX2
  v.setUint16(off, 0, false);
  off += 2; // searchRange (simplified)
  v.setUint16(off, 0, false);
  off += 2; // entrySelector
  v.setUint16(off, 0, false);
  off += 2; // rangeShift

  // endCode array
  for (const s of allSegs) {
    v.setUint16(off, s.end, false);
    off += 2;
  }
  v.setUint16(off, 0, false);
  off += 2; // reservedPad

  // startCode array
  for (const s of allSegs) {
    v.setUint16(off, s.start, false);
    off += 2;
  }

  // idDelta array
  for (const s of allSegs) {
    v.setInt16(off, s.delta, false);
    off += 2;
  }

  // idRangeOffset array (all zeros = use delta)
  for (let i = 0; i < segCount; i++) {
    v.setUint16(off, 0, false);
    off += 2;
  }

  return buf;
}

function assembleTtfFromTables(tables: Array<{ tag: string; data: Uint8Array }>): Uint8Array {
  const numTables = tables.length;
  const headerSize = 12 + numTables * 16;

  let dataOffset = headerSize;
  const entries: Array<{ tag: string; data: Uint8Array; offset: number }> = [];

  for (const { tag, data } of tables) {
    const paddedLen = (data.length + 3) & ~3;
    const padded = new Uint8Array(paddedLen);
    padded.set(data);
    entries.push({ tag, data: padded, offset: dataOffset });
    dataOffset += paddedLen;
  }

  const result = new Uint8Array(dataOffset);
  const v = new DataView(result.buffer);
  let off = 0;

  // Offset table
  v.setUint32(off, 0x00010000, false);
  off += 4;
  v.setUint16(off, numTables, false);
  off += 2;
  const pow2 = Math.pow(2, Math.floor(Math.log2(numTables)));
  v.setUint16(off, pow2 * 16, false);
  off += 2;
  v.setUint16(off, Math.floor(Math.log2(numTables)), false);
  off += 2;
  v.setUint16(off, numTables * 16 - pow2 * 16, false);
  off += 2;

  // Table directory
  for (const entry of entries) {
    for (let i = 0; i < 4; i++) {
      result[off++] = entry.tag.charCodeAt(i);
    }
    v.setUint32(off, 0, false);
    off += 4; // checksum (skip)
    v.setUint32(off, entry.offset, false);
    off += 4;
    v.setUint32(off, entry.data.length, false);
    off += 4;
  }

  // Table data
  for (const entry of entries) {
    result.set(entry.data, entry.offset);
  }

  return result;
}

// ---------------------------------------------------------------------------
// High-level TTF builders
// ---------------------------------------------------------------------------

/** Options for {@link buildTtfWithCmap}. */
interface TtfBuildOptions {
  /** Per-glyph advance widths. Length must equal `numGlyphs`. Falls back to 500 for each glyph. */
  advanceWidths?: number[];
  /**
   * Per-glyph left side bearings. Length must equal `numGlyphs`. Falls back to 0
   * for each glyph. May be negative, as it is for glyphs like `j` whose outline
   * reaches left of the pen position.
   */
  leftSideBearings?: number[];
  /** Font family name written into the `name` table. Defaults to `"TestFont"`. */
  familyName?: string;
  /** PostScript name written into the `name` table. Defaults to `"<familyName>-Regular"`. */
  postScriptName?: string;
}

/**
 * Build a minimal valid TTF whose cmap covers the given Unicode ranges.
 * Each segment maps [start..end] → glyphs via `delta` (idDelta).
 * `numGlyphs` must be >= max mapped glyph id + 1.
 */
export function buildTtfWithCmap(
  segments: Array<{ start: number; end: number; delta: number }>,
  numGlyphs: number,
  options?: TtfBuildOptions
): Uint8Array {
  const widths = options?.advanceWidths;
  const bearings = options?.leftSideBearings;
  const family = options?.familyName ?? "TestFont";
  const ps = options?.postScriptName ?? `${family}-Regular`;

  const tables: Array<{ tag: string; data: Uint8Array }> = [];

  // head
  const head = new Uint8Array(54);
  const headV = new DataView(head.buffer);
  headV.setUint32(0, 0x00010000, false);
  headV.setUint32(4, 0x00010000, false);
  headV.setUint32(12, 0x5f0f3cf5, false);
  headV.setUint16(16, 0x000b, false);
  headV.setUint16(18, 1000, false);
  headV.setInt16(36, 0, false);
  headV.setInt16(38, -200, false);
  headV.setInt16(40, 800, false);
  headV.setInt16(42, 800, false);
  headV.setInt16(50, 1, false); // indexToLocFormat = long
  tables.push({ tag: "head", data: head });

  // hhea
  const hhea = new Uint8Array(36);
  const hheaV = new DataView(hhea.buffer);
  hheaV.setUint32(0, 0x00010000, false);
  hheaV.setInt16(4, 800, false);
  hheaV.setInt16(6, -200, false);
  hheaV.setUint16(10, 600, false);
  hheaV.setUint16(34, numGlyphs, false);
  tables.push({ tag: "hhea", data: hhea });

  // maxp
  const maxp = new Uint8Array(6);
  const maxpV = new DataView(maxp.buffer);
  maxpV.setUint32(0, 0x00005000, false);
  maxpV.setUint16(4, numGlyphs, false);
  tables.push({ tag: "maxp", data: maxp });

  // OS/2
  const os2 = new Uint8Array(96);
  const os2V = new DataView(os2.buffer);
  os2V.setUint16(0, 4, false);
  os2V.setInt16(2, 500, false);
  os2V.setUint16(4, 400, false);
  os2V.setInt16(68, 800, false);
  os2V.setInt16(70, -200, false);
  os2V.setUint16(74, 800, false);
  os2V.setUint16(76, 200, false);
  os2V.setInt16(88, 700, false);
  tables.push({ tag: "OS/2", data: os2 });

  // post
  const post = new Uint8Array(32);
  new DataView(post.buffer).setUint32(0, 0x00030000, false);
  tables.push({ tag: "post", data: post });

  // name
  const familyStr = encodeUtf16BE(family);
  const psStr = encodeUtf16BE(ps);
  const storageData = concatArrays([familyStr, psStr]);
  const nameHeaderSize = 6 + 2 * 12;
  const nameTable = new Uint8Array(nameHeaderSize + storageData.length);
  const nameV = new DataView(nameTable.buffer);
  let off = 0;
  nameV.setUint16(off, 0, false);
  off += 2;
  nameV.setUint16(off, 2, false);
  off += 2;
  nameV.setUint16(off, nameHeaderSize, false);
  off += 2;
  // Record 1: familyName
  nameV.setUint16(off, 3, false);
  off += 2;
  nameV.setUint16(off, 1, false);
  off += 2;
  nameV.setUint16(off, 0x0409, false);
  off += 2;
  nameV.setUint16(off, 1, false);
  off += 2;
  nameV.setUint16(off, familyStr.length, false);
  off += 2;
  nameV.setUint16(off, 0, false);
  off += 2;
  // Record 2: postScriptName
  nameV.setUint16(off, 3, false);
  off += 2;
  nameV.setUint16(off, 1, false);
  off += 2;
  nameV.setUint16(off, 0x0409, false);
  off += 2;
  nameV.setUint16(off, 6, false);
  off += 2;
  nameV.setUint16(off, psStr.length, false);
  off += 2;
  nameV.setUint16(off, familyStr.length, false);
  nameTable.set(storageData, nameHeaderSize);
  tables.push({ tag: "name", data: nameTable });

  // cmap
  tables.push({ tag: "cmap", data: buildCmapFormat4(segments) });

  // hmtx
  const hmtx = new Uint8Array(numGlyphs * 4);
  const hmtxV = new DataView(hmtx.buffer);
  for (let i = 0; i < numGlyphs; i++) {
    hmtxV.setUint16(i * 4, widths?.[i] ?? 500, false);
    hmtxV.setInt16(i * 4 + 2, bearings?.[i] ?? 0, false);
  }
  tables.push({ tag: "hmtx", data: hmtx });

  // loca (long format)
  const loca = new Uint8Array((numGlyphs + 1) * 4);
  tables.push({ tag: "loca", data: loca });

  // glyf (empty)
  tables.push({ tag: "glyf", data: new Uint8Array(0) });

  return assembleTtfFromTables(tables);
}

/**
 * Build a minimal valid TrueType font for testing.
 * Contains glyphs for .notdef (width 500), 'A' (width 600), 'B' (width 550).
 */
export function buildMinimalTtf(): Uint8Array {
  return buildTtfWithCmap(
    [{ start: 0x41, end: 0x42, delta: -0x40 }], // A→1, B→2
    3, // .notdef + A + B
    { advanceWidths: [500, 600, 550] }
  );
}

/**
 * Build a TTF where A→GID 5, B→GID 8 (non-sequential, non-starting-from-1).
 * This ensures the subset GID remapping is actually tested.
 * Widths: 500, 510, 520, ... (incrementing by 10 per glyph).
 */
export function buildSparseGidTtf(): Uint8Array {
  const widths = Array.from({ length: 10 }, (_, i) => 500 + i * 10);
  return buildTtfWithCmap(
    [
      { start: 0x41, end: 0x41, delta: 5 - 0x41 }, // A→5
      { start: 0x42, end: 0x42, delta: 8 - 0x42 } // B→8
    ],
    10,
    {
      advanceWidths: widths,
      familyName: "SparseFont",
      postScriptName: "SparseFont-Regular"
    }
  );
}
