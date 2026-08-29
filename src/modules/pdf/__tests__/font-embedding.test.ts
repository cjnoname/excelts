import { createWorkbook, addWorksheet } from "@excel/core/workbook";
import { Cell } from "@excel/index";
import { PdfFontError } from "@pdf/errors";
import { collectEmbeddedGlyphUses, embedTtfFont } from "@pdf/font/font-embedder";
import { FontManager } from "@pdf/font/font-manager";
import { parseTtf } from "@pdf/font/ttf-parser";
import type { TtfFont } from "@pdf/font/ttf-parser";
import { PdfDocument } from "@pdf/reader/pdf-document";
import { isPdfArray, isPdfDict } from "@pdf/reader/pdf-parser";
import { readPdf } from "@pdf/reader/pdf-reader";
import { countGlyphAdvances } from "@utils/cjk";
/**
 * Tests for TrueType font parsing, subsetting, and embedding.
 */
import { describe, it, expect } from "vitest";

import {
  buildAliasedGidTtf,
  buildMinimalTtf,
  buildSparseGidTtf,
  buildTtfWithCmap
} from "./ttf-test-utils";

// =============================================================================
// Helpers
// =============================================================================

/** Pull the embedded subset font program (`FontFile2`) out of a finished PDF. */
function extractSubsetProgram(pdf: Uint8Array): Uint8Array {
  const doc = new PdfDocument(pdf);
  const resources = doc.derefDict(doc.getPages()[0].get("Resources"));
  const fonts = resources && doc.derefDict(resources.get("Font"));
  const type0 = fonts && doc.derefDict(fonts.get("EF1"));
  const descendants = type0?.get("DescendantFonts");
  const cidFont = isPdfArray(descendants) ? doc.derefDict(descendants[0]) : null;
  const descriptor = cidFont && doc.derefDict(cidFont.get("FontDescriptor"));
  const fontStream = doc.derefStreamWithObjNum(descriptor?.get("FontFile2"));
  if (!fontStream) {
    throw new Error("the PDF carries no embedded font program");
  }
  return doc.getStreamData(fontStream.stream, fontStream.objNum, fontStream.gen);
}

/** Read the `xMin` out of a glyph's own outline header in `glyf`. */
function outlineXMin(font: TtfFont, gid: number): number {
  const glyf = font.tables.get("glyf");
  const start = font.glyphOffsets[gid];
  if (!glyf || font.glyphOffsets[gid + 1] - start === 0) {
    throw new Error(`glyph ${gid} has no outline`);
  }
  const view = new DataView(font.data.buffer, font.data.byteOffset, font.data.byteLength);
  return view.getInt16(glyf.offset + start + 2, false);
}

/** Read the `hhea` horizontal extremes straight out of a font's bytes. */
function hheaExtremes(font: TtfFont): {
  advanceWidthMax: number;
  minLeftSideBearing: number;
  minRightSideBearing: number;
  xMaxExtent: number;
} {
  const hhea = font.tables.get("hhea")!;
  const view = new DataView(font.data.buffer, font.data.byteOffset, font.data.byteLength);
  return {
    advanceWidthMax: view.getUint16(hhea.offset + 10, false),
    minLeftSideBearing: view.getInt16(hhea.offset + 12, false),
    minRightSideBearing: view.getInt16(hhea.offset + 14, false),
    xMaxExtent: view.getInt16(hhea.offset + 16, false)
  };
}

/** The raw bytes of one table. */
function tableBytes(font: TtfFont, tag: string): Uint8Array {
  const entry = font.tables.get(tag)!;
  return font.data.subarray(entry.offset, entry.offset + entry.length);
}

/** Overwrite the long-format `loca` offsets, to forge a broken glyph index. */
function withLocaOffsets(ttf: Uint8Array, offsets: number[]): Uint8Array {
  const loca = parseTtf(ttf).tables.get("loca")!;
  const forged = new Uint8Array(ttf);
  const view = new DataView(forged.buffer);
  offsets.forEach((offset, i) => view.setUint32(loca.offset + i * 4, offset, false));
  return forged;
}

/**
 * Turn one glyph into a description with no contours, keeping its bounding box.
 * The spec allows this — such a glyph may still carry instructions — and its box
 * must not be mistaken for ink.
 */
function withoutContours(ttf: Uint8Array, gid: number): Uint8Array {
  const font = parseTtf(ttf);
  const glyf = font.tables.get("glyf")!;
  const forged = new Uint8Array(ttf);
  new DataView(forged.buffer).setInt16(glyf.offset + font.glyphOffsets[gid], 0, false);
  return forged;
}

/**
 * Rewrite one table's directory entry, to build a font that misdeclares where
 * its table lives.
 */ function patchTableEntry(
  ttf: Uint8Array,
  tag: string,
  patch: { offset?: number; length?: number }
): Uint8Array {
  const forged = new Uint8Array(ttf);
  const view = new DataView(forged.buffer);
  const numTables = view.getUint16(4, false);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const found = String.fromCharCode(...forged.subarray(record, record + 4));
    if (found !== tag) {
      continue;
    }
    if (patch.offset !== undefined) {
      view.setUint32(record + 8, patch.offset, false);
    }
    if (patch.length !== undefined) {
      view.setUint32(record + 12, patch.length, false);
    }
    return forged;
  }
  throw new Error(`table '${tag}' is not in the directory`);
}

// =============================================================================
// Tests
// =============================================================================

describe("TrueType Font Parser", () => {
  it("should parse a minimal TrueType font", () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);

    expect(font.familyName).toBe("TestFont");
    expect(font.postScriptName).toBe("TestFont-Regular");
    expect(font.unitsPerEm).toBe(1000);
    expect(font.ascent).toBe(800);
    expect(font.descent).toBe(-200);
    expect(font.numGlyphs).toBe(3);
  });

  it("should read cmap correctly", () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);

    expect(font.cmap.get(0x41)).toBe(1); // 'A' → glyph 1
    expect(font.cmap.get(0x42)).toBe(2); // 'B' → glyph 2
    expect(font.cmap.get(0x43)).toBeUndefined(); // 'C' not mapped
  });

  it("should read advance widths correctly", () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);

    expect(font.advanceWidths[0]).toBe(500); // .notdef
    expect(font.advanceWidths[1]).toBe(600); // glyph 1 ('A')
    expect(font.advanceWidths[2]).toBe(550); // glyph 2 ('B')
  });

  it("should read font bounding box", () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);

    expect(font.bbox).toEqual([0, -200, 800, 800]);
  });

  it("should reject CFF OpenType fonts", () => {
    const data = new Uint8Array(64);
    // 'OTTO' signature
    data[0] = 0x4f;
    data[1] = 0x54;
    data[2] = 0x54;
    data[3] = 0x4f;
    expect(() => parseTtf(data)).toThrow(PdfFontError);
  });

  // A TrueType wrapper is not a promise of TrueType outlines. macOS ships the
  // faces CoreText renders Chinese with as sfntVersion 0x00010000 carrying a
  // private `hvgl` table and no `glyf`: it used to parse, report full CJK
  // coverage, and then subset to nothing — a 2 KB PDF with every glyph blank
  // and no error raised.
  it("should reject a TrueType font whose outlines are not in glyf", () => {
    const noGlyf = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      omitTables: ["glyf"],
      extraTableTags: ["hvgl"]
    });
    expect(() => parseTtf(noGlyf)).toThrow(PdfFontError);
    expect(() => parseTtf(noGlyf)).toThrow(/no 'glyf' table/);
  });

  it("should reject a TrueType font with no loca table", () => {
    const noLoca = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      omitTables: ["loca"]
    });
    expect(() => parseTtf(noLoca)).toThrow(/no 'loca' table/);
  });

  it("should reject invalid data", () => {
    expect(() => parseTtf(new Uint8Array([0, 0, 0, 0, 0, 0]))).toThrow(PdfFontError);
  });

  it("reads an OS/2 table that stops where version 0 ends", () => {
    // Version 0 is 78 bytes and has no sCapHeight; the reader consumes exactly
    // those 78 bytes, so this is the boundary where bounding reads to the
    // declared extent either works or starts rejecting old fonts.
    const ttf = buildMinimalTtf();
    const legacy = new Uint8Array(patchTableEntry(ttf, "OS/2", { length: 78 }));
    const os2 = parseTtf(ttf).tables.get("OS/2")!;
    new DataView(legacy.buffer).setUint16(os2.offset, 0, false); // version 0

    const font = parseTtf(legacy);

    expect(font.ascent).toBe(800);
    expect(font.capHeight).toBe(Math.round(800 * 0.7)); // estimated, not read
  });

  it("names the table when one is too short for what it describes", () => {
    // Fonts are untrusted input. A table that cannot hold its own contents has
    // to be diagnosed as such, rather than reading into whatever follows it or
    // off the end of the file — which a DataView reports as a bare RangeError
    // that says nothing about the font.
    const ttf = buildMinimalTtf();

    expect(() => parseTtf(patchTableEntry(ttf, "head", { length: 4 }))).toThrow(
      /table 'head' is truncated/
    );
    expect(() => parseTtf(patchTableEntry(ttf, "cmap", { length: 4 }))).toThrow(PdfFontError);
    expect(() => parseTtf(patchTableEntry(ttf, "name", { length: 8 }))).toThrow(PdfFontError);
  });

  it("keeps a font whose loca is shorter than its glyph count", () => {
    // A loca/maxp glyph count mismatch is a mismatch, not a reason to reject:
    // the offsets that are there stay usable and the glyphs behind them read as
    // empty, which is how FreeType treats the same font.
    const ttf = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      outlineXMins: [10, 20, 30]
    });
    const complete = parseTtf(ttf);
    expect(Array.from(complete.glyphOffsets)).toEqual([0, 24, 48, 72]);

    // Room for two of the four offsets.
    const font = parseTtf(patchTableEntry(ttf, "loca", { length: 8 }));

    expect(Array.from(font.glyphOffsets)).toEqual([0, 24, 24, 24]);
  });

  it("clamps loca offsets that reach past the end of glyf", () => {
    // These offsets are the only thing that turns a glyph ID into a byte range,
    // and the subsetter copies whatever range it is handed. An offset past the
    // end of glyf would reach into the table that follows it.
    const ttf = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      outlineXMins: [10, 20, 30]
    });
    const glyfLength = parseTtf(ttf).tables.get("glyf")!.length;
    const forged = withLocaOffsets(ttf, [0, 24, 0xffff, 0xffff]);

    const font = parseTtf(forged);

    expect(glyfLength).toBe(72);
    expect(Array.from(font.glyphOffsets)).toEqual([0, 24, glyfLength, glyfLength]);
  });

  it("collapses loca offsets that run backwards", () => {
    // A decreasing pair describes a negative length. Reading it as an empty
    // glyph keeps every byte range inside glyf and in order.
    const ttf = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      outlineXMins: [10, 20, 30]
    });
    const font = parseTtf(withLocaOffsets(ttf, [0, 48, 24, 72]));

    expect(Array.from(font.glyphOffsets)).toEqual([0, 48, 48, 72]);
  });
});

describe("Font Embedding Utilities", () => {
  it("keeps the legacy scalar Set input", async () => {
    const { PdfWriter } = await import("@pdf/core/pdf-writer");
    const embedded = embedTtfFont(
      new PdfWriter(),
      parseTtf(buildMinimalTtf()),
      new Set([0x41, 0x42]),
      "EF1"
    );

    expect(embedded.unicodeToCid).toEqual(
      new Map([
        [0x41, 1],
        [0x42, 2]
      ])
    );
    expect(embedded.encodeText("AB")).toEqual([1, 2]);
  });

  it("should encode text via FontManager", async () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);
    const fm = new FontManager();
    fm.registerEmbeddedFont(font);
    fm.trackText("AB");

    const { PdfWriter } = await import("@pdf/core/pdf-writer");
    const writer = new PdfWriter();
    fm.writeFontResources(writer);

    const encoded = fm.encodeText("AB", fm.getEmbeddedResourceName());
    expect(encoded).toBe("<00010002>");
  });

  it("should use .notdef (0) for unmapped characters", async () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);
    const fm = new FontManager();
    fm.registerEmbeddedFont(font);
    fm.trackText("A");

    const { PdfWriter } = await import("@pdf/core/pdf-writer");
    const writer = new PdfWriter();
    fm.writeFontResources(writer);

    const encoded = fm.encodeText("AC", fm.getEmbeddedResourceName());
    expect(encoded).toBe("<00010000>");
  });

  it("should measure text with embedded font metrics", () => {
    const ttfData = buildMinimalTtf();
    const font = parseTtf(ttfData);
    const fm = new FontManager();
    fm.registerEmbeddedFont(font);

    const resourceName = fm.getEmbeddedResourceName();
    const width = fm.measureText("AB", resourceName, 12);
    // A=600, B=550 in font units, unitsPerEm=1000
    // (600 + 550) / 1000 * 12 = 13.8
    expect(width).toBeCloseTo(13.8, 1);
  });
});

describe("Horizontal Metrics", () => {
  // A→GID 5, B→GID 8, so a subset has to remap as well as copy. 'A' carries a
  // negative bearing, like real glyphs ('j', 'f') whose ink reaches left of the
  // pen; 'B' carries a large positive one.
  const WIDTHS = Array.from({ length: 10 }, (_, i) => 500 + i * 10);
  const BEARINGS = [40, 0, 0, 0, 0, -35, 0, 0, 120, 0];
  const SPARSE_SEGMENTS = [
    { start: 0x41, end: 0x41, delta: 5 - 0x41 },
    { start: 0x42, end: 0x42, delta: 8 - 0x42 }
  ];

  function buildBearingTtf(options?: { numHMetrics?: number }): Uint8Array {
    return buildTtfWithCmap(SPARSE_SEGMENTS, 10, {
      advanceWidths: WIDTHS,
      leftSideBearings: BEARINGS,
      numHMetrics: options?.numHMetrics
    });
  }

  /** One value per glyph behind the third long record, for the tail fixtures. */
  function tail(value: number): number[] {
    return Array.from({ length: 10 - 3 }, () => value);
  }

  it("reads a left side bearing per glyph, including negative ones", () => {
    const font = parseTtf(buildBearingTtf());

    expect(Array.from(font.leftSideBearings)).toEqual(BEARINGS);
    expect(Array.from(font.advanceWidths)).toEqual(WIDTHS);
  });

  it("reads the bearings stored in the monospaced tail", () => {
    // Courier New ships 3 long records for 3151 glyphs: past the last record the
    // advance width is shared and only the bearing is stored, in a trailing
    // int16 array. Reading just the records would leave those glyphs at 0.
    const font = parseTtf(buildBearingTtf({ numHMetrics: 3 }));

    expect(font.numHMetrics).toBe(3);
    expect(Array.from(font.leftSideBearings)).toEqual(BEARINGS);
    expect(Array.from(font.advanceWidths)).toEqual([...WIDTHS.slice(0, 3), ...tail(WIDTHS[2])]);
  });

  it("falls back to a zero bearing when hmtx omits its trailing array", () => {
    // The directory declares room for the long records only. The records still
    // have to be read; the glyphs behind them have no bearing to read.
    const ttf = buildBearingTtf({ numHMetrics: 3 });
    const font = parseTtf(patchTableEntry(ttf, "hmtx", { length: 3 * 4 }));

    expect(Array.from(font.leftSideBearings)).toEqual([...BEARINGS.slice(0, 3), ...tail(0)]);
    expect(Array.from(font.advanceWidths)).toEqual([...WIDTHS.slice(0, 3), ...tail(WIDTHS[2])]);
  });

  it("rejects an hmtx whose declared extent runs past the end of the file", () => {
    // The table directory is range-checked against the buffer when it is read,
    // which is what lets the metrics reader trust a table's declared extent.
    // If that check ever goes away, readHmtx starts reading off the end.
    const ttf = buildBearingTtf({ numHMetrics: 3 });
    const forged = patchTableEntry(ttf, "hmtx", { offset: ttf.length - 12 });

    expect(() => parseTtf(forged)).toThrow(PdfFontError);
  });

  it("carries left side bearings into the subset, remapped with the glyph IDs", async () => {
    // The rasterizer translates each outline by `lsb - xMin`, so a subset that
    // drops the bearing paints every glyph's ink at the pen position instead of
    // at `pen + lsb`. Advance widths stay correct either way, which is why the
    // damage survived: it never shows up in line lengths, only in glyphs
    // drifting inside their own advance.
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Bearings");
    Cell.setValue(ws, "A1", "AB");

    const pdf = await excelToPdf(wb, { font: buildBearingTtf() });
    const subset = parseTtf(extractSubsetProgram(pdf));

    // Used glyphs sorted: [.notdef, 5, 8] → subset GIDs [0, 1, 2].
    expect(subset.numGlyphs).toBe(3);
    expect(Array.from(subset.leftSideBearings)).toEqual([BEARINGS[0], BEARINGS[5], BEARINGS[8]]);
    expect(Array.from(subset.advanceWidths)).toEqual([WIDTHS[0], WIDTHS[5], WIDTHS[8]]);
    // Every subset glyph spells out its own metrics, so nothing is inherited
    // from a monospaced tail that no longer matches the new glyph order.
    expect(subset.numHMetrics).toBe(3);
  });

  it("keeps the bearings of a source font that stores them in a tail", async () => {
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Bearings");
    Cell.setValue(ws, "A1", "AB");

    const pdf = await excelToPdf(wb, { font: buildBearingTtf({ numHMetrics: 3 }) });
    const subset = parseTtf(extractSubsetProgram(pdf));

    // GID 5 and GID 8 both live past the third record: their bearings come from
    // the trailing array and their advance width from the last record.
    expect(Array.from(subset.leftSideBearings)).toEqual([BEARINGS[0], BEARINGS[5], BEARINGS[8]]);
    expect(Array.from(subset.advanceWidths)).toEqual([WIDTHS[0], WIDTHS[2], WIDTHS[2]]);
  });

  it("keeps every bearing paired with the outline it belongs to", async () => {
    // A bearing only places ink correctly while it stays next to its own
    // outline: hmtx row N describes glyf entry N. A well-formed font has the two
    // agreeing (lsb === xMin) and subsetting reorders both, so checking that
    // they still agree afterwards is what proves the ink lands at `pen + lsb`
    // rather than under some other glyph's bearing.
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Bearings");
    Cell.setValue(ws, "A1", "AB");

    const pdf = await excelToPdf(wb, {
      font: buildTtfWithCmap(SPARSE_SEGMENTS, 10, {
        advanceWidths: WIDTHS,
        leftSideBearings: BEARINGS,
        outlineXMins: BEARINGS
      })
    });
    const subset = parseTtf(extractSubsetProgram(pdf));

    const xMins = Array.from({ length: subset.numGlyphs }, (_, gid) => outlineXMin(subset, gid));
    expect(xMins).toEqual([BEARINGS[0], BEARINGS[5], BEARINGS[8]]);
    expect(Array.from(subset.leftSideBearings)).toEqual(xMins);
  });

  it("republishes the hhea extremes for the glyphs the subset keeps", async () => {
    // Every outline in the fixture is 100 units wide, so the extremes follow
    // from the three glyphs that survive: [.notdef, A, B].
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Bearings");
    Cell.setValue(ws, "A1", "AB");

    const source = buildTtfWithCmap(SPARSE_SEGMENTS, 10, {
      advanceWidths: WIDTHS,
      leftSideBearings: BEARINGS,
      outlineXMins: BEARINGS
    });
    const subset = parseTtf(extractSubsetProgram(await excelToPdf(wb, { font: source })));

    const kept = [0, 5, 8];
    expect(hheaExtremes(subset)).toEqual({
      advanceWidthMax: Math.max(...kept.map(gid => WIDTHS[gid])),
      minLeftSideBearing: Math.min(...kept.map(gid => BEARINGS[gid])),
      minRightSideBearing: Math.min(...kept.map(gid => WIDTHS[gid] - (BEARINGS[gid] + 100))),
      xMaxExtent: Math.max(...kept.map(gid => BEARINGS[gid] + 100))
    });
    // None of that is what the source font said.
    expect(hheaExtremes(parseTtf(source))).toEqual({
      advanceWidthMax: 600,
      minLeftSideBearing: 0,
      minRightSideBearing: 0,
      xMaxExtent: 0
    });
  });

  it("republishes advanceWidthMax even when no glyph has an outline", async () => {
    // An empty glyph still has an advance width, so advanceWidthMax is defined
    // for it and has to be measured. The three bearing-derived fields are not
    // defined without contours, and keep whatever the source font said.
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Empty");
    Cell.setValue(ws, "A1", "AB");

    // No outlineXMins, so every glyph is empty.
    const source = buildBearingTtf();
    const subset = parseTtf(extractSubsetProgram(await excelToPdf(wb, { font: source })));

    const kept = [0, 5, 8];
    expect(hheaExtremes(subset).advanceWidthMax).toBe(Math.max(...kept.map(gid => WIDTHS[gid])));
    // …which is not what the source published.
    expect(hheaExtremes(parseTtf(source)).advanceWidthMax).toBe(600);

    const sourceTrio = hheaExtremes(parseTtf(source));
    const subsetTrio = hheaExtremes(subset);
    expect(subsetTrio.minLeftSideBearing).toBe(sourceTrio.minLeftSideBearing);
    expect(subsetTrio.minRightSideBearing).toBe(sourceTrio.minRightSideBearing);
    expect(subsetTrio.xMaxExtent).toBe(sourceTrio.xMaxExtent);
  });

  it("ignores a glyph with no contours when measuring the hhea extremes", async () => {
    // The spec defines the bearing extremes over glyphs with contours. A glyph
    // may carry a description and still have none — only instructions on its
    // phantom points — and its bounding box says nothing about ink.
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Zero");
    Cell.setValue(ws, "A1", "AB");

    const source = buildTtfWithCmap(SPARSE_SEGMENTS, 10, {
      advanceWidths: WIDTHS,
      leftSideBearings: BEARINGS,
      outlineXMins: BEARINGS
    });
    // 'A' is GID 5, the glyph carrying the smallest bearing (-35).
    const subset = parseTtf(
      extractSubsetProgram(await excelToPdf(wb, { font: withoutContours(source, 5) }))
    );

    // Without GID 5, the minimum comes from .notdef (40) and 'B' (120).
    expect(hheaExtremes(subset).minLeftSideBearing).toBe(BEARINGS[0]);
  });

  it("embeds nothing from outside glyf when loca is broken", async () => {
    // The subsetter copies the byte range each glyph's offsets describe. With a
    // loca pointing past glyf, that range would be the table that follows it —
    // so the clamp in the parser is what keeps foreign bytes out of the PDF.
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Broken");
    Cell.setValue(ws, "A1", "AB");

    const source = buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
      outlineXMins: [10, 20, 30]
    });
    const pdf = await excelToPdf(wb, {
      font: withLocaOffsets(source, [0, 0xffff, 0xffff, 0xffff])
    });
    const subset = parseTtf(extractSubsetProgram(pdf));

    // Clamping leaves glyph 0 owning the whole of glyf and the rest empty. The
    // point is the ceiling: what got embedded is glyf and nothing behind it.
    const sourceGlyf = tableBytes(parseTtf(source), "glyf");
    expect(Array.from(tableBytes(subset, "glyf"))).toEqual(Array.from(sourceGlyf));
    expect(Array.from(subset.glyphOffsets)).toEqual([
      0,
      sourceGlyf.length,
      sourceGlyf.length,
      sourceGlyf.length
    ]);
  });
});

describe("Font Integration with excelToPdf", () => {
  it("should export PDF with embedded font", async () => {
    const { excelToPdf } = await import("@pdf/excel-bridge");

    const ttfData = buildMinimalTtf();

    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Test");
    Cell.setValue(ws, "A1", "AB");

    const pdf = await excelToPdf(wb, { font: ttfData });

    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(100);

    const text = new TextDecoder().decode(pdf);
    expect(text).toContain("%PDF-2.0");
    expect(text).toContain("%%EOF");
    expect(text).toContain("/Type0");
    expect(text).toContain("/CIDFontType2");
    expect(text).toContain("/Identity-H");
    expect(text).toContain("TestFont-Regular-Subset");
    expect(text).toContain("/FlateDecode");
    expect(text).toContain("/ToUnicode");
    expect(text).toContain("<00010002> Tj"); // 'AB' as subset GIDs 1,2
  });

  it("should correctly remap non-sequential glyph IDs in subset", async () => {
    // This test catches the critical bug where original GIDs are used instead of
    // remapped subset GIDs. The font maps A→GID 5 and B→GID 8. After subsetting
    // to [.notdef, A, B], the new GIDs should be [0, 1, 2].
    // Content stream must contain <00010002>, NOT <00050008>.
    const { excelToPdf } = await import("@pdf/excel-bridge");

    const ttfData = buildSparseGidTtf();

    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Test");
    Cell.setValue(ws, "A1", "AB");

    const pdf = await excelToPdf(wb, { font: ttfData });
    const text = new TextDecoder().decode(pdf);

    expect(text).toContain("%PDF-2.0");
    // Subset GIDs: .notdef=0, A=1, B=2
    expect(text).toContain("<00010002> Tj");
    // Must NOT contain original GIDs
    expect(text).not.toContain("<00050008>");
  });

  it("writes a valid whole-font checksum for the embedded subset", async () => {
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Test");
    Cell.setValue(ws, "A1", "AB");
    const pdf = await excelToPdf(wb, { font: buildMinimalTtf() });

    const subset = extractSubsetProgram(pdf);
    const view = new DataView(subset.buffer, subset.byteOffset, subset.byteLength);
    let checksum = 0;
    for (let offset = 0; offset + 4 <= subset.length; offset += 4) {
      checksum = (checksum + view.getUint32(offset, false)) >>> 0;
    }
    expect(checksum).toBe(0xb1b0afba);
  });

  it("should keep aliased Unicode code points as distinct CIDs", async () => {
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Test");
    Cell.setValue(ws, "A1", "AΑ");

    const pdf = await excelToPdf(wb, { font: buildAliasedGidTtf() });
    const serialized = new TextDecoder().decode(pdf);
    expect(serialized).toContain("<00010002> Tj");
    expect(serialized).not.toContain("/CIDToGIDMap /Identity");
    expect(serialized).toContain("/W [0 [500 550 550]]");

    const doc = new PdfDocument(pdf);
    const resources = doc.derefDict(doc.getPages()[0].get("Resources"));
    const fonts = resources && doc.derefDict(resources.get("Font"));
    const type0 = fonts && doc.derefDict(fonts.get("EF1"));
    const descendants = type0?.get("DescendantFonts");
    expect(isPdfArray(descendants)).toBe(true);
    const cidFont = isPdfArray(descendants) ? doc.derefDict(descendants[0]) : null;
    const mapRef = cidFont?.get("CIDToGIDMap");
    const mapStream = doc.derefStreamWithObjNum(mapRef);
    expect(mapStream).not.toBeNull();
    const map = mapStream
      ? doc.getStreamData(mapStream.stream, mapStream.objNum, mapStream.gen)
      : new Uint8Array();
    expect(Array.from(map)).toEqual([0, 0, 0, 1, 0, 1]);
    expect(isPdfDict(cidFont)).toBe(true);

    const roundtrip = await readPdf(pdf, { extractImages: false });
    expect(roundtrip.text).toContain("AΑ");
  });

  it("roundtrips variation selectors and ZWJ sequences through a real PDF", async () => {
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const heart = 0x2764;
    const sun = 0x2600;
    const font = buildTtfWithCmap(
      [
        { start: 0x41, end: 0x41, delta: 1 - 0x41 },
        { start: heart, end: heart, delta: 2 - heart },
        { start: sun, end: sun, delta: 3 - sun }
      ],
      4,
      { advanceWidths: [500, 600, 600, 600] }
    );
    const text = "A\ufe0f❤\u200d☀";
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Sequences");
    Cell.setValue(ws, "A1", text);

    const pdf = await excelToPdf(wb, { font });
    const serialized = new TextDecoder().decode(pdf);
    expect(serialized).toContain("<000100020003> Tj");

    const roundtrip = await readPdf(pdf, { extractImages: false });
    expect(roundtrip.text).toContain(text);
  });

  it("assigns distinct CIDs to Unicode sequences sharing one GID", async () => {
    const { excelToPdf } = await import("@pdf/excel-bridge");
    const eAcute = 0x00e9;
    const font = buildTtfWithCmap(
      [
        { start: 0x41, end: 0x41, delta: 1 - 0x41 },
        { start: 0x65, end: 0x65, delta: 2 - 0x65 },
        { start: eAcute, end: eAcute, delta: 2 - eAcute },
        { start: 0x0301, end: 0x0301, delta: 3 - 0x0301 }
      ],
      4,
      { advanceWidths: [500, 600, 550, 0] }
    );
    const text = "AA\ufe0féée\u0301";
    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Aliases");
    Cell.setValue(ws, "A1", text);

    const pdf = await excelToPdf(wb, { font });
    const serialized = new TextDecoder().decode(pdf);
    expect(serialized).toContain("<000100020003000300040005> Tj");

    const roundtrip = await readPdf(pdf, { extractImages: false });
    expect(roundtrip.text).toContain(text);
  });

  it("roundtrips routed configured-font sequences", async () => {
    const { Pdf } = await import("@pdf/index");
    const heart = 0x2764;
    const sun = 0x2600;
    const font = buildTtfWithCmap(
      [
        { start: 0x41, end: 0x41, delta: 1 - 0x41 },
        { start: heart, end: heart, delta: 2 - heart },
        { start: sun, end: sun, delta: 3 - sun }
      ],
      4
    );
    const text = "A\ufe0f❤\u200d☀";
    const doc = new Pdf.Builder({ fonts: { default: { regular: font } } });
    doc.addPage().drawText(text, { x: 72, y: 720 });

    const roundtrip = await Pdf.read(await doc.build());
    expect(roundtrip.text).toContain(text);
  });
});

describe("auto-discovered fallback fonts", () => {
  /** A face covering `→` (U+2192) and nothing else interesting. */
  const arrowFont = () =>
    parseTtf(buildTtfWithCmap([{ start: 0x2192, end: 0x2192, delta: 1 - 0x2192 }], 2));

  it("keeps the requested Type1 face for text the standard fonts can draw", () => {
    const manager = new FontManager();
    manager.registerFallbackFont(arrowFont());
    const bold = manager.resolveFont("Helvetica", true, false);
    // A fallback face lends glyphs; it must not become the document font, or a
    // single non-WinAnsi character would strip bold from the whole document.
    expect(manager.resolveRenderResourceName(bold)).toBe(bold);
    expect(manager.hasFallbackFont()).toBe(true);
  });

  it("takes over the whole run for an explicitly embedded document font", () => {
    const manager = new FontManager();
    const resource = manager.registerEmbeddedFont(arrowFont());
    const bold = manager.resolveFont("Helvetica", true, false);
    // `embedFont` means "render this document with this font" — unchanged.
    expect(manager.resolveRenderResourceName(bold)).toBe(resource);
    expect(manager.hasFallbackFont()).toBe(false);
  });

  it("routes only the code points WinAnsi cannot encode to the fallback face", () => {
    const manager = new FontManager();
    const resource = manager.registerFallbackFont(arrowFont());
    expect(manager.fallbackResourceFor(0x2192)).toBe(resource); // →
    expect(manager.fallbackResourceFor(0x41)).toBeNull(); // A — WinAnsi
    // A code point the fallback has no glyph for still needs a Type3 glyph.
    expect(manager.fallbackResourceFor(0x4e2d)).toBeNull(); // U+4E2D, outside the face
    expect(manager.needsType3(0x4e2d)).toBe(true);
    expect(manager.needsType3(0x2192)).toBe(false);
    expect(manager.needsType3(0x41)).toBe(false);
  });

  it("measures each code point with the face that draws it", () => {
    const manager = new FontManager();
    manager.registerFallbackFont(arrowFont());
    const plain = manager.resolveFont("Helvetica", false, false);
    const bold = manager.resolveFont("Helvetica", true, false);
    // Bold metrics must still differ from regular: measuring everything with
    // one fallback face is what desynchronised layout from rendering.
    // ("i" is 222/1000 in Helvetica and 278/1000 in Helvetica-Bold.)
    expect(manager.measureText("iiii", bold, 12)).not.toBeCloseTo(
      manager.measureText("iiii", plain, 12),
      3
    );
    // A mixed run costs the Type1 width of "A" plus the fallback's advance.
    const mixed = manager.measureText("A\u2192", plain, 12);
    const latinOnly = manager.measureText("A", plain, 12);
    expect(mixed).toBeGreaterThan(latinOnly);
  });

  it("loads real Type3 widths for code points an incomplete fallback lacks", async () => {
    // `prepare()` used to skip the Type3 metrics whenever *any* face was embedded,
    // on the assumption that an embedded face covers everything. Auto-discovery no
    // longer requires total coverage, so an incomplete fallback is ordinary — and
    // the 600 default it fell back to is wrong for most of these code points.
    // `U+2003` EM SPACE is 1000 and `U+200B` ZERO WIDTH SPACE is 0.
    const manager = new FontManager();
    manager.registerFallbackFont(arrowFont());
    const plain = manager.resolveFont("Helvetica", false, false);
    manager.trackText("\u2003", plain);
    manager.trackText("\u200b", plain);
    await manager.prepare();

    const em = manager.measureText("\u2003", plain, 100);
    const zero = manager.measureText("\u200b", plain, 100);

    // 1000/1000 em and 0/1000 em, not 600/1000 for both.
    expect(em).toBeCloseTo(100, 3);
    expect(zero).toBeCloseTo(0, 3);
    expect(em).not.toBeCloseTo(zero, 3);
  });

  it("separates characters Type3 can draw from real tofu", async () => {
    // Two different outcomes, and one sentence cannot describe both. Type3 has a glyph
    // for `☐` and none for `中`, so the checkbox draws correctly while the ideograph is
    // a `.notdef` box — reporting them together promised NOTDEF for a character that
    // renders fine, and sent the reader after a font they did not need for it.
    const manager = new FontManager();
    manager.registerFallbackFont(arrowFont());
    const plain = manager.resolveFont("Helvetica", false, false);
    manager.trackText("\u2610\u4e2d", plain); // both outside the arrow-only face
    await manager.prepare();

    const warnings: string[] = [];
    manager.reportDiagnostics(message => warnings.push(message));
    const joined = warnings.join(" ");

    // The ideograph is named as tofu, the checkbox as a Type3 substitution.
    expect(joined).toContain("no glyph in any available font");
    expect(joined).toMatch(/CJK Unified Ideographs/);
    expect(joined).toContain("built-in Type3 glyphs");
    expect(joined).toMatch(/Miscellaneous Symbols/);
    // And it never claims nothing is embedded when a face is.
    expect(joined).not.toContain("no TrueType font is embedded");
  });

  it("says nothing about tofu when Type3 covers every missing character", async () => {
    const manager = new FontManager();
    manager.registerFallbackFont(arrowFont());
    const plain = manager.resolveFont("Helvetica", false, false);
    manager.trackText("\u2610", plain);
    await manager.prepare();

    const warnings: string[] = [];
    manager.reportDiagnostics(message => warnings.push(message));
    const joined = warnings.join(" ");

    expect(joined).toContain("built-in Type3 glyphs");
    expect(joined).not.toContain("no glyph in any available font");
  });

  it("still reports tofu when no face is embedded at all", async () => {
    const manager = new FontManager();
    const plain = manager.resolveFont("Helvetica", false, false);
    manager.trackText("\u4e2d", plain);
    await manager.prepare();

    const warnings: string[] = [];
    manager.reportDiagnostics(message => warnings.push(message));

    expect(warnings.join(" ")).toContain("no glyph in any available font");
  });

  it("preserves bold, italic and monospace in a document containing an arrow", async () => {
    const { Pdf } = await import("@pdf/index");
    const doc = new Pdf.Builder();
    const page = doc.addPage();
    page.drawText("bold", { x: 72, y: 720, bold: true });
    page.drawText("italic", { x: 72, y: 700, italic: true });
    page.drawText("mono", { x: 72, y: 680, fontFamily: "Courier New" });
    page.drawText("arrow \u2192", { x: 72, y: 660 });
    const bytes = await doc.build();
    const text = Buffer.from(bytes).toString("latin1");

    // All three standard faces must survive alongside whatever draws the arrow.
    expect(text).toContain("/Helvetica-Bold");
    expect(text).toContain("/Helvetica-Oblique");
    expect(text).toContain("/Courier");
  });
});

describe("fallback fonts and grapheme clusters", () => {
  /** A face covering the heart and its presentation selector, nothing else. */
  const heartFont = () =>
    parseTtf(
      buildTtfWithCmap(
        [
          { start: 0x2764, end: 0x2764, delta: 1 - 0x2764 },
          { start: 0xfe0f, end: 0xfe0f, delta: 2 - 0xfe0f }
        ],
        3
      )
    );

  it("routes a whole cluster to one face, not its code points separately", () => {
    // Subsetting keys a cluster — base plus the selectors and joiners after it —
    // under one sequence. Choosing a face per code point sent a lone variation
    // selector to the fallback, where the sequence had never been registered, and
    // the glyph encoded as `.notdef`.
    const manager = new FontManager();
    const resource = manager.registerFallbackFont(heartFont());
    // The heart is non-WinAnsi and covered, so it belongs to the fallback…
    expect(manager.fallbackResourceFor(0x2764)).toBe(resource);
    // …while an ASCII base stays with the standard face, selector and all.
    expect(manager.fallbackResourceFor(0x41)).toBeNull();
  });

  it("keeps every drawable glyph when a document mixes both", async () => {
    const { Pdf } = await import("@pdf/index");
    const doc = new Pdf.Builder();
    doc.addPage().drawText("A\uFE0F\u2764\uFE0F ok", { x: 72, y: 700, fontSize: 12 });
    const roundtrip = await Pdf.read(await doc.build());
    // The heart survives; it used to encode as `.notdef` and extract as U+FFFD.
    expect(roundtrip.text).toContain("\u2764");
    expect(roundtrip.text).not.toContain("\uFFFD");

    // And the pieces sit flush against each other. A variation selector the
    // standard face cannot encode used to be drawn as a space, opening a gap
    // between the base character and what followed it. (The extracted string
    // gains a separator between fragments — that is the reader's own heuristic,
    // so geometry is what this asserts.)
    const fragments = roundtrip.pages[0]!.textFragments;
    const first = fragments.find(f => f.text.includes("A"))!;
    const heart = fragments.find(f => f.text.includes("\u2764"))!;
    // "A" at 12pt Helvetica advances 0.667 em = 8.004pt.
    expect(heart.x - first.x).toBeCloseTo(8.004, 2);
  });
});

describe("glyph advance counting agrees with the embedder", () => {
  // `Tc` is added after every glyph shown, so the number of glyphs is the
  // multiplier for a justified stretch. Three places needed it and each guessed:
  // the Word layout counted grapheme clusters, which under-counts `中` + U+0301
  // (drawn as two glyphs), and the PDF renderer counted code points, which
  // over-counts `辻` + IVS (drawn as one). The layout then believed a line was a
  // different width than was drawn and the line missed its margin.
  //
  // `countGlyphAdvances` is that single definition. The embedder decides what is
  // actually drawn, so this pins the two together — the check that would have
  // caught the drift.
  it.each([
    ["中文"],
    ["中\u0301文"],
    ["中\uFE0F文"],
    ["中\u{E0100}文"],
    ["辻\u{E0100}"],
    ["中\u200d文"],
    ["中\u200c文"],
    ["甲\u0301乙\u0301"],
    ["👍\uFE0F"],
    ["𠀀𠀁"],
    ["日本語"],
    ["e\u0301"],
    ["x\u0301\u0302"],
    ["a b c"]
  ])("should count the glyphs the embedder emits for %j", text => {
    expect(countGlyphAdvances(text)).toBe(collectEmbeddedGlyphUses(text).length);
  });
});

describe("widening a fallback face cannot change measured widths", () => {
  /** Two faces that agree on `A` but not on `Ā`, mirroring two real CJK families. */
  const narrow = (): TtfFont =>
    parseTtf(
      buildTtfWithCmap(
        [
          { start: 0x41, end: 0x41, delta: 1 - 0x41 },
          { start: 0x100, end: 0x100, delta: 2 - 0x100 }
        ],
        3,
        { familyName: "Narrow", advanceWidths: [500, 500, 700] }
      )
    );

  const wide = (): TtfFont =>
    parseTtf(
      buildTtfWithCmap(
        [
          { start: 0x41, end: 0x41, delta: 1 - 0x41 },
          { start: 0x100, end: 0x100, delta: 2 - 0x100 },
          { start: 0x4e2d, end: 0x4e2d, delta: 3 - 0x4e2d }
        ],
        4,
        { familyName: "Wide", advanceWidths: [500, 500, 740, 1000] }
      )
    );

  it("refuses a wider face that would re-measure an already drawn code point", () => {
    // Measured on the real families: 345 code points outside Latin-1 that `Kaiti SC`
    // and `Heiti SC` both cover have different advances — `Ā` is 0.699 em against
    // 0.740. Two CJK faces agree on every ideograph, because a full-width character is
    // one em, so a swap looks harmless right up to the first non-ideograph.
    const manager = new FontManager();
    manager.registerFallbackFont(narrow());
    const resource = manager.resolveFont("Helvetica", false, false);
    manager.trackText("\u0100", resource);
    const measured = manager.measureText("\u0100", resource, 1000);

    expect(manager.widenFallbackFont(wide())).toBe(false);
    expect(manager.measureText("\u0100", resource, 1000)).toBeCloseTo(measured, 6);
  });

  it("accepts a wider face that agrees on everything already drawn", () => {
    const manager = new FontManager();
    manager.registerFallbackFont(narrow());
    const resource = manager.resolveFont("Helvetica", false, false);
    // Only `A` has been drawn, and `A` is WinAnsi — nothing was measured through the
    // fallback, so the wider face is free to take over and cover `中` as well.
    manager.trackText("A", resource);

    expect(manager.widenFallbackFont(wide())).toBe(true);
    expect(manager.fallbackResourceFor(0x4e2d)).not.toBeNull();
  });

  it("registers straight away when there is no incumbent", () => {
    const manager = new FontManager();
    expect(manager.widenFallbackFont(wide())).toBe(true);
  });
});
