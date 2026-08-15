import { inflateSync } from "node:zlib";

import { createWorkbook, addWorksheet } from "@excel/core/workbook";
import { Cell } from "@excel/index";
import { PdfWriter } from "@pdf/core/pdf-writer";
import { PdfFontError } from "@pdf/errors";
import { embedTtfFont } from "@pdf/font/font-embedder";
import { FontManager } from "@pdf/font/font-manager";
import { parseTtf } from "@pdf/font/ttf-parser";
/**
 * Tests for TrueType font parsing, subsetting, and embedding.
 */
import { describe, it, expect } from "vitest";

import { buildMinimalTtf, buildSparseGidTtf, buildTtfWithCmap } from "./ttf-test-utils";

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

  it("should reject invalid data", () => {
    expect(() => parseTtf(new Uint8Array([0, 0, 0, 0, 0, 0]))).toThrow(PdfFontError);
  });
});

describe("Font Embedding Utilities", () => {
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

describe("Subset Horizontal Metrics", () => {
  // A→GID 5, B→GID 8, so the subset has to remap as well as copy.
  const BEARINGS = [40, 0, 0, 0, 0, -35, 0, 0, 120, 0];
  const WIDTHS = Array.from({ length: 10 }, (_, i) => 500 + i * 10);

  function buildBearingTtf(): Uint8Array {
    return buildTtfWithCmap(
      [
        { start: 0x41, end: 0x41, delta: 5 - 0x41 },
        { start: 0x42, end: 0x42, delta: 8 - 0x42 }
      ],
      10,
      { advanceWidths: WIDTHS, leftSideBearings: BEARINGS }
    );
  }

  /** Inflate the subset font program the embedder wrote into `writer`. */
  function subsetProgram(writer: PdfWriter): Uint8Array {
    const stream = writer.getObjects().find(o => o.content.includes("/Length1"));
    if (!stream?.streamData) {
      throw new Error("no embedded font program was written");
    }
    return new Uint8Array(inflateSync(stream.streamData));
  }

  it("should read left side bearings, including negative ones", () => {
    const font = parseTtf(buildBearingTtf());

    expect(font.leftSideBearings[0]).toBe(40);
    expect(font.leftSideBearings[5]).toBe(-35); // 'A'
    expect(font.leftSideBearings[8]).toBe(120); // 'B'
  });

  it("should carry left side bearings into the subset font", () => {
    // A rasterizer positions an outline by translating it by `lsb - xMin`, so a
    // subset that drops the bearing draws every glyph's ink at the pen position
    // instead of at `pen + xMin`. The damage is invisible in the advance widths
    // and shows up as glyphs drifting inside their own advance — most visibly
    // for a glyph like 'j', whose outline reaches left of the pen.
    const writer = new PdfWriter();
    const font = parseTtf(buildBearingTtf());
    embedTtfFont(writer, font, new Set([0x41, 0x42]), "EF1");

    // Used glyphs sorted: [.notdef, 5, 8] → subset GIDs [0, 1, 2].
    const subset = parseTtf(subsetProgram(writer));

    expect(subset.numGlyphs).toBe(3);
    expect(Array.from(subset.leftSideBearings)).toEqual([40, -35, 120]);
    expect(Array.from(subset.advanceWidths)).toEqual([WIDTHS[0], WIDTHS[5], WIDTHS[8]]);
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
});
