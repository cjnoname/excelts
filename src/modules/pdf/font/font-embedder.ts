/**
 * TrueType font subsetting and PDF embedding.
 *
 * Takes a parsed TrueType font and the used text,
 * and produces:
 * 1. A subsetted font program (binary TTF with only the needed glyphs)
 * 2. A CID-to-GID mapping for the CIDFont dictionary
 * 3. A ToUnicode CMap for text extraction/search
 * 4. Width arrays for the PDF font descriptor
 *
 * PDF embedding uses a Type0 (composite) font structure:
 *   Type0 font → CIDFont (CIDFontType2) → embedded TrueType font program
 *
 * CIDs identify encoded Unicode sequences independently from glyph IDs.
 * Character codes in the content stream are 2-byte big-endian CIDs.
 *
 * @see PDF Reference 1.7, §5.6 - Composite Fonts
 * @see PDF Reference 1.7, §5.9 - ToUnicode CMaps
 */

import { zlibSync } from "@archive/compression/compress";
import { PdfDict, pdfName, pdfNumber, pdfRef, pdfArray } from "@pdf/core/pdf-object";
import type { PdfWriter } from "@pdf/core/pdf-writer";
import { PdfFontError } from "@pdf/errors";
import type { TtfFont } from "@pdf/font/ttf-parser";
import { concatUint8Arrays } from "@utils/binary";
import { isGlyphlessControl } from "@utils/cjk";
// Subsetting maps a whole cluster — a base character together with the variation
// selectors and joiners after it — to a single CID, so anything choosing a *face*
// per character has to agree on these boundaries. Splitting mid-cluster leaves the
// tail looking up a sequence that was never registered, which encodes as `.notdef`.
import { graphemeClusters } from "@utils/grapheme";

// =============================================================================
// Types
// =============================================================================

/**
 * Result of embedding a font into a PDF.
 */
export interface EmbeddedFont {
  /** PDF resource name (e.g., "EF1") */
  resourceName: string;

  /** Object number of the Type0 font dictionary */
  fontObjNum: number;

  /** The parsed TTF font */
  font: TtfFont;

  /**
   * Legacy map from single Unicode code points to CIDs.
   * Multi-code-point sequences are available through `sequenceToCid`.
   */
  unicodeToCid: Map<number, number>;

  /** Map from an extracted Unicode sequence to its CID. */
  sequenceToCid: Map<string, number>;

  /** Encode text with the same grapheme/sequence rules used while subsetting. */
  encodeText(text: string): readonly number[];

  /** Advance widths in font units, indexed by CID */
  cidWidths: number[];
}

// =============================================================================
// Font Embedder
// =============================================================================

/**
 * Embed a TrueType font into a PDF document.
 *
 * @param writer - The PDF writer to add objects to
 * @param font - Parsed TrueType font
 * @param usedText - Text runs, or a legacy set of Unicode code points
 * @param resourceName - PDF resource name (e.g., "EF1")
 * @returns Embedded font info
 */
export function embedTtfFont(
  writer: PdfWriter,
  font: TtfFont,
  usedText: Set<number> | Iterable<string> | Iterable<EmbeddedGlyphUse>,
  resourceName: string
): EmbeddedFont {
  // --- Step 1: Build the glyph subset ---
  // Map: original glyph ID → new glyph ID in subset
  // Map: Unicode code point → CID, then CID → subset glyph ID
  const { oldToNewGid, unicodeToCid, sequenceToCid, cidToGid, cidWidths, usedGlyphIds } =
    buildSubsetMapping(font, usedText);

  // --- Step 2: Create the subsetted font program ---
  const subsetData = subsetTtfFont(font, usedGlyphIds, oldToNewGid);

  // --- Step 3: Compress and write the font program stream ---
  const compressedFont = zlibSync(subsetData, { level: 6 });
  const fontStreamObjNum = writer.allocObject();
  const fontStreamDict = new PdfDict()
    .set("Length", pdfNumber(compressedFont.length))
    .set("Length1", pdfNumber(subsetData.length))
    .set("Filter", "/FlateDecode");
  writer.addStreamObject(fontStreamObjNum, fontStreamDict, compressedFont);

  // --- Step 4: Create the font descriptor ---
  const scale = 1000 / font.unitsPerEm;
  const descriptorObjNum = writer.allocObject();
  const descriptorDict = new PdfDict()
    .set("Type", "/FontDescriptor")
    .set("FontName", pdfName(font.postScriptName + "-Subset"))
    .set("Flags", pdfNumber(font.flags))
    .set("FontBBox", pdfArray(font.bbox.map(v => pdfNumber(Math.round(v * scale)))))
    .set("ItalicAngle", pdfNumber(font.italicAngle))
    .set("Ascent", pdfNumber(Math.round(font.ascent * scale)))
    .set("Descent", pdfNumber(Math.round(font.descent * scale)))
    .set("CapHeight", pdfNumber(Math.round(font.capHeight * scale)))
    .set("StemV", pdfNumber(font.stemV))
    .set("FontFile2", pdfRef(fontStreamObjNum));
  writer.addObject(descriptorObjNum, descriptorDict);

  // --- Step 5: Build the CID width array (W entry) ---
  const wArray = buildWidthArray(cidWidths, font.unitsPerEm);

  // --- Step 6: Write the binary CID-to-GID map ---
  const cidToGidMap = buildCidToGidMap(cidToGid);
  const compressedCidToGidMap = zlibSync(cidToGidMap, { level: 6 });
  const cidToGidMapObjNum = writer.allocObject();
  const cidToGidMapDict = new PdfDict()
    .set("Length", pdfNumber(compressedCidToGidMap.length))
    .set("Filter", "/FlateDecode");
  writer.addStreamObject(cidToGidMapObjNum, cidToGidMapDict, compressedCidToGidMap);

  // --- Step 7: Create the CIDFont dictionary ---
  const cidFontObjNum = writer.allocObject();
  const cidFontDict = new PdfDict()
    .set("Type", "/Font")
    .set("Subtype", "/CIDFontType2")
    .set("BaseFont", pdfName(font.postScriptName + "-Subset"))
    .set("CIDSystemInfo", "<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>")
    .set("FontDescriptor", pdfRef(descriptorObjNum))
    .set("DW", pdfNumber(1000))
    .set("W", wArray)
    .set("CIDToGIDMap", pdfRef(cidToGidMapObjNum));
  writer.addObject(cidFontObjNum, cidFontDict);

  // --- Step 8: Create the ToUnicode CMap ---
  const toUnicodeCmap = buildToUnicodeCMap(sequenceToCid);
  const compressedCmap = zlibSync(toUnicodeCmap, { level: 6 });
  const toUnicodeObjNum = writer.allocObject();
  const toUnicodeDict = new PdfDict()
    .set("Length", pdfNumber(compressedCmap.length))
    .set("Filter", "/FlateDecode");
  writer.addStreamObject(toUnicodeObjNum, toUnicodeDict, compressedCmap);

  // --- Step 9: Create the Type0 font dictionary ---
  const fontObjNum = writer.allocObject();
  const type0Dict = new PdfDict()
    .set("Type", "/Font")
    .set("Subtype", "/Type0")
    .set("BaseFont", pdfName(font.postScriptName + "-Subset"))
    .set("Encoding", "/Identity-H")
    .set("DescendantFonts", pdfArray([pdfRef(cidFontObjNum)]))
    .set("ToUnicode", pdfRef(toUnicodeObjNum));
  writer.addObject(fontObjNum, type0Dict);

  return {
    resourceName,
    fontObjNum,
    font,
    unicodeToCid,
    sequenceToCid,
    encodeText: text => encodeUnicodeSequences(text, sequenceToCid),
    cidWidths
  };
}

// =============================================================================
// Subset Mapping
// =============================================================================

interface SubsetMapping {
  /** Map from original glyph ID → new glyph ID in subset */
  oldToNewGid: Map<number, number>;
  /** Map from Unicode code point → CID */
  unicodeToCid: Map<number, number>;
  /** Map from Unicode sequence → CID */
  sequenceToCid: Map<string, number>;
  /** Map from CID → subset GID */
  cidToGid: number[];
  /** Widths indexed by CID */
  cidWidths: number[];
  /** Set of all original glyph IDs needed */
  usedGlyphIds: Set<number>;
}

export interface EmbeddedGlyphUse {
  readonly codePoint: number;
  readonly sequence: string;
}

function buildSubsetMapping(
  font: TtfFont,
  usedText: Set<number> | Iterable<string> | Iterable<EmbeddedGlyphUse>
): SubsetMapping {
  const usedGlyphIds = new Set<number>();
  const sequenceToOrigGid = new Map<string, number>();
  const entries: Array<string | number | EmbeddedGlyphUse> = [];
  for (const value of usedText) {
    entries.push(value);
  }
  const legacyScalars = entries.every(value => typeof value === "number");
  const textRuns = entries.every(value => typeof value === "string");
  const glyphUses = entries.every(
    value =>
      typeof value === "object" && value !== null && "codePoint" in value && "sequence" in value
  );
  if (!legacyScalars && !textRuns && !glyphUses) {
    throw new PdfFontError(
      "Embedded font usage must contain only code points, only text runs, or only glyph uses"
    );
  }

  // Always include glyph 0 (.notdef)
  usedGlyphIds.add(0);

  // Map every visible use to its glyph ID. Missing glyphs deliberately map
  // to GID 0 rather than disappearing from the encoding plan: the page still
  // shows .notdef, but a distinct CID + ToUnicode entry preserves the original
  // character for copy/search/accessibility.
  const uses: EmbeddedGlyphUse[] = legacyScalars
    ? (entries as number[]).map(codePoint => ({
        codePoint,
        sequence: String.fromCodePoint(codePoint)
      }))
    : textRuns
      ? (entries as string[]).flatMap(text => collectEmbeddedGlyphUses(text))
      : (entries as EmbeddedGlyphUse[]);
  for (const use of uses) {
    const gid = isGlyphlessControl(use.codePoint)
      ? (font.cmap.get(0x20) ?? 0)
      : (font.cmap.get(use.codePoint) ?? 0);
    if (!sequenceToOrigGid.has(use.sequence)) {
      sequenceToOrigGid.set(use.sequence, gid);
      if (gid > 0) {
        usedGlyphIds.add(gid);
      }
    }
  }

  // Recursively discover composite glyph components
  const glyfTable = font.tables.get("glyf");
  if (glyfTable) {
    const glyfOffset = glyfTable.offset;
    const discovered = new Set(usedGlyphIds);
    const queue = Array.from(discovered);
    while (queue.length > 0) {
      const gid = queue.pop()!;
      const components = getCompositeComponents(font, gid, glyfOffset);
      for (const compGid of components) {
        if (!discovered.has(compGid)) {
          discovered.add(compGid);
          usedGlyphIds.add(compGid);
          queue.push(compGid);
        }
      }
    }
  }

  // Sort original glyph IDs to get a deterministic ordering
  const sortedGids = Array.from(usedGlyphIds).sort((a, b) => a - b);

  // Build old → new GID mapping
  const oldToNewGid = new Map<number, number>();
  for (let i = 0; i < sortedGids.length; i++) {
    oldToNewGid.set(sortedGids[i], i);
  }

  // Assign one CID per Unicode sequence. Multiple sequences may deliberately
  // use the same subset glyph while retaining distinct ToUnicode mappings.
  const unicodeToCid = new Map<number, number>();
  const sequenceToCid = new Map<string, number>();
  const cidToGid = [0];
  const cidWidths = [font.advanceWidths[0] ?? 0];

  for (const [sequence, origGid] of sequenceToOrigGid) {
    const cid = cidToGid.length;
    if (cid > 0xffff) {
      throw new PdfFontError(
        "A single embedded font face cannot encode more than 65,535 distinct Unicode sequences"
      );
    }
    sequenceToCid.set(sequence, cid);
    const codePoints = Array.from(sequence, char => char.codePointAt(0)!);
    if (codePoints.length === 1) {
      unicodeToCid.set(codePoints[0], cid);
    }
    cidToGid.push(oldToNewGid.get(origGid)!);
    cidWidths.push(isGlyphlessControl(codePoints[0]) ? 0 : (font.advanceWidths[origGid] ?? 0));
  }

  return {
    oldToNewGid,
    unicodeToCid,
    sequenceToCid,
    cidToGid,
    cidWidths,
    usedGlyphIds
  };
}

export function collectEmbeddedGlyphUses(text: string): EmbeddedGlyphUse[] {
  const result: Array<{ codePoint: number; sequence: string }> = [];
  let leadingControls = "";
  for (const cluster of graphemeClusters(text)) {
    let clusterHasVisibleGlyph = false;
    for (const char of cluster) {
      const codePoint = char.codePointAt(0)!;
      if (isGlyphlessControl(codePoint)) {
        if (clusterHasVisibleGlyph) {
          result[result.length - 1].sequence += char;
        } else {
          leadingControls += char;
        }
        continue;
      }
      result.push({ codePoint, sequence: leadingControls + char });
      leadingControls = "";
      clusterHasVisibleGlyph = true;
    }
  }
  if (leadingControls && result.length > 0) {
    result[result.length - 1].sequence += leadingControls;
  }
  return result;
}

function encodeUnicodeSequences(
  text: string,
  sequenceToCid: ReadonlyMap<string, number>
): number[] {
  return collectEmbeddedGlyphUses(text).map(use => sequenceToCid.get(use.sequence) ?? 0);
}

/** Build the big-endian, two-byte-per-CID map required by CIDFontType2. */
function buildCidToGidMap(cidToGid: number[]): Uint8Array {
  const data = new Uint8Array(cidToGid.length * 2);
  const view = new DataView(data.buffer);
  for (let cid = 0; cid < cidToGid.length; cid++) {
    view.setUint16(cid * 2, cidToGid[cid], false);
  }
  return data;
}

// =============================================================================
// Font Subsetting
// =============================================================================

/**
 * Create a minimal TrueType font containing only the specified glyphs.
 *
 * We rebuild: head, hhea, maxp, post, cmap (format 12), hmtx, loca, glyf.
 * Other tables are dropped since PDF viewers don't need them.
 */
function subsetTtfFont(
  font: TtfFont,
  usedGlyphIds: Set<number>,
  oldToNewGid: Map<number, number>
): Uint8Array {
  const numGlyphs = oldToNewGid.size;
  const sortedOldGids = Array.from(usedGlyphIds).sort((a, b) => a - b);

  const glyfTable = font.tables.get("glyf");
  const glyfOffset = glyfTable?.offset ?? 0;

  // --- Rebuild glyf and loca ---
  const glyphDataParts: Uint8Array[] = [];
  const newOffsets: number[] = [];
  let currentOffset = 0;

  for (const oldGid of sortedOldGids) {
    newOffsets.push(currentOffset);
    const start = font.glyphOffsets[oldGid];
    const end = font.glyphOffsets[oldGid + 1];
    const glyphLen = end - start;

    if (glyphLen > 0) {
      const rawGlyph = font.data.subarray(glyfOffset + start, glyfOffset + end);

      // Remap component GIDs in composite glyphs
      const glyphData = remapCompositeGlyphIds(rawGlyph, oldToNewGid);

      glyphDataParts.push(glyphData);
      currentOffset += glyphLen;

      // Pad to 4-byte boundary
      const pad = (4 - (glyphLen % 4)) % 4;
      if (pad > 0) {
        glyphDataParts.push(new Uint8Array(pad));
        currentOffset += pad;
      }
    }
  }
  newOffsets.push(currentOffset); // end of last glyph

  const newGlyf = concatUint8Arrays(glyphDataParts);

  // Use long loca format for simplicity
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const locaView = new DataView(newLoca.buffer);
  for (let i = 0; i <= numGlyphs; i++) {
    locaView.setUint32(i * 4, newOffsets[i] ?? currentOffset, false);
  }

  // --- Rebuild hmtx ---
  // Both metrics are copied verbatim, and the bearing matters as much as the
  // advance width: the rasterizer translates each outline by `lsb - xMin`, so a
  // bearing that no longer belongs to the outline next to it moves the glyph
  // inside its own advance. Zeroing it draws every glyph's ink at the pen
  // position; deriving it from the copied outline's `xMin` would normalize away
  // the source font's own placement. Only the source value reproduces it.
  const newHmtx = new Uint8Array(numGlyphs * 4);
  const hmtxView = new DataView(newHmtx.buffer);
  for (let i = 0; i < sortedOldGids.length; i++) {
    const oldGid = sortedOldGids[i];
    hmtxView.setUint16(i * 4, font.advanceWidths[oldGid] ?? 0, false);
    hmtxView.setInt16(i * 4 + 2, font.leftSideBearings[oldGid] ?? 0, false);
  }

  // --- Rebuild cmap (format 12 for full Unicode) ---
  const newCmap = buildSubsetCmap(oldToNewGid, font.cmap);

  // --- Rebuild head ---
  const headEntry = font.tables.get("head")!;
  const newHead = new Uint8Array(
    font.data.subarray(headEntry.offset, headEntry.offset + headEntry.length)
  );
  const headView = new DataView(newHead.buffer, newHead.byteOffset, newHead.byteLength);
  // The whole-font checksum is computed only after all tables are assembled.
  // The head table checksum itself must be calculated with this field zeroed.
  headView.setUint32(8, 0, false); // checkSumAdjustment
  // Force long loca format
  headView.setInt16(50, 1, false); // indexToLocFormat = 1

  // --- Rebuild hhea ---
  const hheaEntry = font.tables.get("hhea")!;
  const newHhea = new Uint8Array(
    font.data.subarray(hheaEntry.offset, hheaEntry.offset + hheaEntry.length)
  );
  const hheaView = new DataView(newHhea.buffer, newHhea.byteOffset, newHhea.byteLength);
  hheaView.setUint16(34, numGlyphs, false); // numOfLongHorMetrics
  // The four horizontal extremes describe the glyphs the font actually carries,
  // so a subset has to publish its own. Copied from the source they would
  // describe glyphs that are no longer here.
  const extremes = measureHorizontalExtremes(font, sortedOldGids);
  hheaView.setUint16(10, extremes.advanceWidthMax, false);
  if (extremes.outline) {
    hheaView.setInt16(12, extremes.outline.minLeftSideBearing, false);
    hheaView.setInt16(14, extremes.outline.minRightSideBearing, false);
    hheaView.setInt16(16, extremes.outline.xMaxExtent, false);
  }

  // --- Rebuild maxp ---
  const maxpEntry = font.tables.get("maxp")!;
  const newMaxp = new Uint8Array(
    font.data.subarray(maxpEntry.offset, maxpEntry.offset + maxpEntry.length)
  );
  const maxpView = new DataView(newMaxp.buffer, newMaxp.byteOffset, newMaxp.byteLength);
  maxpView.setUint16(4, numGlyphs, false); // numGlyphs

  // --- Rebuild post (minimal version 3.0 — no glyph names) ---
  const newPost = new Uint8Array(32);
  const postView = new DataView(newPost.buffer);
  postView.setUint32(0, 0x00030000, false); // version 3.0
  // italicAngle, underlinePosition, etc. default to 0

  // --- Assemble the new font file ---
  const tableDefs: Array<[string, Uint8Array]> = [
    ["head", newHead],
    ["hhea", newHhea],
    ["maxp", newMaxp],
    ["post", newPost],
    ["cmap", newCmap],
    ["hmtx", newHmtx],
    ["loca", newLoca],
    ["glyf", newGlyf]
  ];

  return assembleTtf(tableDefs);
}

interface HorizontalExtremes {
  /** Over every glyph, outline or not — an empty glyph still has an advance. */
  advanceWidthMax: number;
  /** Only glyphs that have contours have edges to measure. */
  outline: {
    minLeftSideBearing: number;
    minRightSideBearing: number;
    xMaxExtent: number;
  } | null;
}

/**
 * Measure the horizontal extremes `hhea` publishes, over the glyphs a subset
 * keeps.
 *
 * `advanceWidthMax` covers every glyph. The three bearing-derived values are
 * defined over glyphs *with contours* — the spec says to ignore empty glyphs,
 * and a glyph with no contours has no edges to be the minimum or maximum of.
 * They come back null when the subset has no contours at all, which leaves the
 * source values in place: there is nothing better to say.
 *
 * @see https://learn.microsoft.com/en-us/typography/opentype/spec/hhea
 */
function measureHorizontalExtremes(font: TtfFont, sortedOldGids: number[]): HorizontalExtremes {
  const glyfOffset = font.tables.get("glyf")?.offset ?? 0;
  const view = new DataView(font.data.buffer, font.data.byteOffset, font.data.byteLength);

  let advanceWidthMax = 0;
  let minLeftSideBearing = Number.POSITIVE_INFINITY;
  let minRightSideBearing = Number.POSITIVE_INFINITY;
  let xMaxExtent = Number.NEGATIVE_INFINITY;

  for (const oldGid of sortedOldGids) {
    const advanceWidth = font.advanceWidths[oldGid] ?? 0;
    advanceWidthMax = Math.max(advanceWidthMax, advanceWidth);

    const start = font.glyphOffsets[oldGid];
    const end = font.glyphOffsets[oldGid + 1];
    if (end - start < 10) {
      continue; // no glyph description at all
    }
    if (view.getInt16(glyfOffset + start, false) === 0) {
      continue; // a description, but no contours: nothing to measure
    }

    const leftSideBearing = font.leftSideBearings[oldGid] ?? 0;
    const xMin = view.getInt16(glyfOffset + start + 2, false);
    const xMax = view.getInt16(glyfOffset + start + 6, false);
    const inkWidth = xMax - xMin;

    minLeftSideBearing = Math.min(minLeftSideBearing, leftSideBearing);
    minRightSideBearing = Math.min(
      minRightSideBearing,
      advanceWidth - (leftSideBearing + inkWidth)
    );
    xMaxExtent = Math.max(xMaxExtent, leftSideBearing + inkWidth);
  }

  return {
    advanceWidthMax: clampToUint16(advanceWidthMax),
    outline: Number.isFinite(minLeftSideBearing)
      ? {
          minLeftSideBearing: clampToInt16(minLeftSideBearing),
          minRightSideBearing: clampToInt16(minRightSideBearing),
          xMaxExtent: clampToInt16(xMaxExtent)
        }
      : null
  };
}

/** Keep a derived metric writable as an int16, however odd the source font is. */
function clampToInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/** Keep a derived metric writable as a uint16, however odd the source font is. */
function clampToUint16(value: number): number {
  return Math.max(0, Math.min(65535, value));
}

/**
 * Build a cmap subtable (format 12) for the subset font.
 * Maps original Unicode code points → new glyph IDs.
 */
function buildSubsetCmap(
  oldToNewGid: Map<number, number>,
  originalCmap: Map<number, number>
): Uint8Array {
  // Build groups for format 12
  const entries: Array<[number, number]> = []; // [codePoint, newGid]
  for (const [cp, origGid] of originalCmap) {
    const newGid = oldToNewGid.get(origGid);
    if (newGid !== undefined) {
      entries.push([cp, newGid]);
    }
  }
  entries.sort((a, b) => a[0] - b[0]);

  // Merge consecutive entries into groups
  interface Group {
    startCP: number;
    endCP: number;
    startGID: number;
  }
  const groups: Group[] = [];
  for (const [cp, gid] of entries) {
    const last = groups[groups.length - 1];
    if (last && cp === last.endCP + 1 && gid === last.startGID + (cp - last.startCP)) {
      last.endCP = cp;
    } else {
      groups.push({ startCP: cp, endCP: cp, startGID: gid });
    }
  }

  // Build the cmap table
  // Header: version (u16) + numTables (u16) = 4 bytes
  // Encoding record: platformID (u16) + encodingID (u16) + offset (u32) = 8 bytes
  // Format 12 subtable:
  //   format (u16) + reserved (u16) + length (u32) + language (u32) + numGroups (u32) = 16 bytes
  //   groups: (startCharCode (u32) + endCharCode (u32) + startGlyphID (u32)) * numGroups
  const subtableSize = 16 + groups.length * 12;
  const tableSize = 4 + 8 + subtableSize;
  const buf = new Uint8Array(tableSize);
  const v = new DataView(buf.buffer);
  let off = 0;

  // cmap header
  v.setUint16(off, 0, false);
  off += 2; // version
  v.setUint16(off, 1, false);
  off += 2; // numTables = 1

  // Encoding record (platform 3 = Windows, encoding 10 = Unicode full)
  v.setUint16(off, 3, false);
  off += 2; // platformID
  v.setUint16(off, 10, false);
  off += 2; // encodingID
  v.setUint32(off, 12, false);
  off += 4; // offset to subtable (4+8=12)

  // Format 12 subtable
  v.setUint16(off, 12, false);
  off += 2; // format
  v.setUint16(off, 0, false);
  off += 2; // reserved
  v.setUint32(off, subtableSize, false);
  off += 4; // length
  v.setUint32(off, 0, false);
  off += 4; // language
  v.setUint32(off, groups.length, false);
  off += 4; // numGroups

  for (const g of groups) {
    v.setUint32(off, g.startCP, false);
    off += 4;
    v.setUint32(off, g.endCP, false);
    off += 4;
    v.setUint32(off, g.startGID, false);
    off += 4;
  }

  return buf;
}

/**
 * Assemble a complete TrueType font file from table data.
 */
function assembleTtf(tables: Array<[string, Uint8Array]>): Uint8Array {
  const numTables = tables.length;

  // Offset table: 12 bytes
  // Table directory: numTables × 16 bytes
  const headerSize = 12 + numTables * 16;

  // Calculate total size and table offsets
  let dataOffset = headerSize;
  const tableEntries: Array<{
    tag: string;
    data: Uint8Array;
    originalLength: number;
    offset: number;
    checksum: number;
  }> = [];

  for (const [tag, data] of tables) {
    const originalLength = data.length;
    const paddedLen = (originalLength + 3) & ~3;
    const padded = new Uint8Array(paddedLen);
    padded.set(data);
    tableEntries.push({
      tag,
      data: padded,
      originalLength,
      offset: dataOffset,
      checksum: calcTableChecksum(padded)
    });
    dataOffset += paddedLen;
  }

  const totalSize = dataOffset;
  const result = new Uint8Array(totalSize);
  const v = new DataView(result.buffer);
  let off = 0;

  // --- Offset table ---
  v.setUint32(off, 0x00010000, false);
  off += 4; // sfVersion = TrueType
  v.setUint16(off, numTables, false);
  off += 2;
  // searchRange, entrySelector, rangeShift (approximate)
  const pow2 = Math.pow(2, Math.floor(Math.log2(numTables)));
  v.setUint16(off, pow2 * 16, false);
  off += 2; // searchRange
  v.setUint16(off, Math.floor(Math.log2(numTables)), false);
  off += 2; // entrySelector
  v.setUint16(off, numTables * 16 - pow2 * 16, false);
  off += 2; // rangeShift

  // --- Table directory ---
  for (const entry of tableEntries) {
    // Tag (4 bytes ASCII)
    for (let i = 0; i < 4; i++) {
      result[off++] = entry.tag.charCodeAt(i);
    }
    v.setUint32(off, entry.checksum, false);
    off += 4;
    v.setUint32(off, entry.offset, false);
    off += 4;
    v.setUint32(off, entry.originalLength, false);
    off += 4;
  }

  // --- Table data ---
  for (const entry of tableEntries) {
    result.set(entry.data, entry.offset);
  }

  // TrueType requires the checksum of the complete font (including the table
  // directory) to equal 0xB1B0AFBA. Strict viewers validate this even for an
  // embedded subset. `head.checkSumAdjustment` was zero while its table
  // checksum was calculated above; patch only the assembled table now.
  const head = tableEntries.find(entry => entry.tag === "head");
  if (head) {
    const totalChecksum = calcTableChecksum(result);
    v.setUint32(head.offset + 8, (0xb1b0afba - totalChecksum) >>> 0, false);
  }

  return result;
}

function calcTableChecksum(data: Uint8Array): number {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sum = 0;
  const nLongs = Math.floor(data.length / 4);
  for (let i = 0; i < nLongs; i++) {
    sum = (sum + v.getUint32(i * 4, false)) >>> 0;
  }
  return sum;
}

// =============================================================================
// ToUnicode CMap
// =============================================================================

/**
 * Build a ToUnicode CMap stream for PDF text extraction.
 * Maps CIDs to Unicode sequences.
 */
function buildToUnicodeCMap(sequenceToCid: Map<string, number>): Uint8Array {
  const entries = Array.from(sequenceToCid, ([sequence, cid]) => [cid, sequence] as const).sort(
    (a, b) => a[0] - b[0]
  );

  const lines: string[] = [];
  lines.push("/CIDInit /ProcSet findresource begin");
  lines.push("12 dict begin");
  lines.push("begincmap");
  lines.push("/CIDSystemInfo");
  lines.push("<< /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def");
  lines.push("/CMapName /Adobe-Identity-UCS def");
  lines.push("/CMapType 2 def");
  lines.push("1 begincodespacerange");
  lines.push("<0000> <FFFF>");
  lines.push("endcodespacerange");

  // Write in batches of 100 (PDF limit is 100 per beginbfchar)
  const batchSize = 100;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    lines.push(`${batch.length} beginbfchar`);
    for (const [cid, sequence] of batch) {
      const cidHex = cid.toString(16).toUpperCase().padStart(4, "0");
      const unicodeHex = Array.from(sequence, char => char.codePointAt(0)!)
        .map(codePoint => {
          if (codePoint <= 0xffff) {
            return codePoint.toString(16).toUpperCase().padStart(4, "0");
          }
          const hi = 0xd800 + ((codePoint - 0x10000) >> 10);
          const lo = 0xdc00 + ((codePoint - 0x10000) & 0x3ff);
          return `${hi.toString(16).toUpperCase().padStart(4, "0")}${lo
            .toString(16)
            .toUpperCase()
            .padStart(4, "0")}`;
        })
        .join("");
      lines.push(`<${cidHex}> <${unicodeHex}>`);
    }
    lines.push("endbfchar");
  }

  lines.push("endcmap");
  lines.push("CMapName currentdict /CMap defineresource pop");
  lines.push("end");
  lines.push("end");

  const cmapStr = lines.join("\n");
  return new TextEncoder().encode(cmapStr);
}

// =============================================================================
// Width Array
// =============================================================================

/**
 * Build the W (Widths) array for the CIDFont dictionary.
 * Format: [ cid [w1 w2 ...] cid [w1 w2 ...] ... ]
 *
 * We use the consecutive-widths format for efficiency:
 * [ firstCID [w1 w2 w3 ...] ]
 */
function buildWidthArray(cidWidths: number[], unitsPerEm: number): string {
  if (cidWidths.length === 0) {
    return "[]";
  }
  const scale = 1000 / unitsPerEm;
  const widths = cidWidths.map(w => pdfNumber(Math.round(w * scale)));
  return `[0 [${widths.join(" ")}]]`;
}

// =============================================================================
// Composite Glyph Handling
// =============================================================================

// TrueType composite glyph flags
const MORE_COMPONENTS = 0x0020;
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/**
 * Get component glyph IDs from a composite glyph.
 * Returns an empty array for simple glyphs or empty glyph slots.
 */
function getCompositeComponents(font: TtfFont, glyphId: number, glyfOffset: number): number[] {
  const start = font.glyphOffsets[glyphId];
  const end = font.glyphOffsets[glyphId + 1];
  if (end - start < 4) {
    return [];
  }

  const view = new DataView(font.data.buffer, font.data.byteOffset, font.data.byteLength);
  const absStart = glyfOffset + start;
  const numberOfContours = view.getInt16(absStart, false);

  if (numberOfContours >= 0) {
    // Simple glyph, no components
    return [];
  }

  // Composite glyph: skip header (10 bytes: numberOfContours + xMin + yMin + xMax + yMax)
  let offset = absStart + 10;
  const components: number[] = [];

  while (true) {
    const flags = view.getUint16(offset, false);
    offset += 2;
    const componentGid = view.getUint16(offset, false);
    offset += 2;
    components.push(componentGid);

    // Skip arguments based on flags
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      offset += 4; // two int16/uint16
    } else {
      offset += 2; // two int8/uint8
    }

    // Skip transform data
    if (flags & WE_HAVE_A_SCALE) {
      offset += 2; // one F2Dot14
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      offset += 4; // two F2Dot14
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      offset += 8; // four F2Dot14
    }

    if (!(flags & MORE_COMPONENTS)) {
      break;
    }
  }

  return components;
}

/**
 * Remap component glyph IDs in a composite glyph's data.
 * Returns a new Uint8Array with remapped GIDs, or the original if not composite.
 */
function remapCompositeGlyphIds(
  glyphData: Uint8Array,
  oldToNewGid: Map<number, number>
): Uint8Array {
  if (glyphData.length < 10) {
    return glyphData;
  }

  const view = new DataView(glyphData.buffer, glyphData.byteOffset, glyphData.byteLength);
  const numberOfContours = view.getInt16(0, false);

  if (numberOfContours >= 0) {
    // Simple glyph
    return glyphData;
  }

  // Clone to avoid mutating the original font data
  const copy = new Uint8Array(glyphData.length);
  copy.set(glyphData);
  const copyView = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);

  let offset = 10; // skip header

  while (true) {
    const flags = copyView.getUint16(offset, false);
    offset += 2;
    const oldGid = copyView.getUint16(offset, false);
    const newGid = oldToNewGid.get(oldGid) ?? 0;
    copyView.setUint16(offset, newGid, false);
    offset += 2;

    if (flags & ARG_1_AND_2_ARE_WORDS) {
      offset += 4;
    } else {
      offset += 2;
    }

    if (flags & WE_HAVE_A_SCALE) {
      offset += 2;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      offset += 4;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      offset += 8;
    }

    if (!(flags & MORE_COMPONENTS)) {
      break;
    }
  }

  return copy;
}
