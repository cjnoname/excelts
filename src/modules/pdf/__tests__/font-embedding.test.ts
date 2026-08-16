import { createWorkbook, addWorksheet } from "@excel/core/workbook";
import { Cell } from "@excel/index";
import { PdfFontError } from "@pdf/errors";
import { embedTtfFont } from "@pdf/font/font-embedder";
import { FontManager } from "@pdf/font/font-manager";
import { parseTtf } from "@pdf/font/ttf-parser";
import { PdfDocument } from "@pdf/reader/pdf-document";
import { isPdfArray, isPdfDict } from "@pdf/reader/pdf-parser";
import { readPdf } from "@pdf/reader/pdf-reader";
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

    const doc = new PdfDocument(pdf);
    const resources = doc.derefDict(doc.getPages()[0].get("Resources"));
    const fonts = resources && doc.derefDict(resources.get("Font"));
    const type0 = fonts && doc.derefDict(fonts.get("EF1"));
    const descendants = type0?.get("DescendantFonts");
    const cidFont = isPdfArray(descendants) ? doc.derefDict(descendants[0]) : null;
    const descriptor = cidFont && doc.derefDict(cidFont.get("FontDescriptor"));
    const fontStreamRef = descriptor?.get("FontFile2");
    const fontStream = doc.derefStreamWithObjNum(fontStreamRef);
    expect(fontStream).not.toBeNull();
    const subset = fontStream
      ? doc.getStreamData(fontStream.stream, fontStream.objNum, fontStream.gen)
      : new Uint8Array();
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
