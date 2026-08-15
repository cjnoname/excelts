import { inflateSync } from "node:zlib";

import { createWorkbook, addWorksheet } from "@excel/core/workbook";
import { Cell } from "@excel/index";
import { PdfWriter } from "@pdf/core/pdf-writer";
import { PdfRenderError } from "@pdf/errors";
import type { ExcelToPdfOptions } from "@pdf/excel-bridge";
import { FontManager } from "@pdf/font/font-manager";
import { parseTtf } from "@pdf/font/ttf-parser";
/**
 * Tests for embedding one TrueType face per style, so a document that embeds a
 * font for its Unicode coverage keeps its bold and italic runs.
 */
import { describe, it, expect } from "vitest";

import { buildTtfWithCmap } from "./ttf-test-utils";

// =============================================================================
// Fixtures
// =============================================================================

/**
 * A face covering 'A' and 'B', identified by its family name and given a
 * distinct advance width per face so measurements prove *which* face answered.
 */
function buildFace(family: string, advance: number): Uint8Array {
  return buildTtfWithCmap([{ start: 0x41, end: 0x42, delta: -0x40 }], 3, {
    advanceWidths: [500, advance, advance],
    familyName: family,
    postScriptName: `${family}-Regular`
  });
}

const REGULAR = buildFace("FaceRegular", 600);
const BOLD = buildFace("FaceBold", 700);
const ITALIC = buildFace("FaceItalic", 800);
const BOLD_ITALIC = buildFace("FaceBoldItalic", 900);

/** All four faces registered on a fresh manager. */
function managerWithAllFaces(): FontManager {
  const fm = new FontManager();
  fm.registerEmbeddedFontFace(parseTtf(REGULAR), "regular");
  fm.registerEmbeddedFontFace(parseTtf(BOLD), "bold");
  fm.registerEmbeddedFontFace(parseTtf(ITALIC), "italic");
  fm.registerEmbeddedFontFace(parseTtf(BOLD_ITALIC), "boldItalic");
  return fm;
}

/**
 * The advance width one em of 'A' occupies at size 1000 — a stand-in for face
 * identity, since each fixture face uses a different advance.
 */
function faceWidth(fm: FontManager, bold: boolean, italic: boolean): number {
  return fm.measureText("A", fm.resolveFont("Arial", bold, italic), 1000);
}

// =============================================================================
// FontManager — face resolution
// =============================================================================

describe("FontManager multi-face resolution", () => {
  it("routes each style to its own face", () => {
    const fm = managerWithAllFaces();

    expect(faceWidth(fm, false, false)).toBeCloseTo(600, 5);
    expect(faceWidth(fm, true, false)).toBeCloseTo(700, 5);
    expect(faceWidth(fm, false, true)).toBeCloseTo(800, 5);
    expect(faceWidth(fm, true, true)).toBeCloseTo(900, 5);
  });

  it("gives every style its own PDF resource", () => {
    const fm = managerWithAllFaces();
    const names = new Set([
      fm.resolveFont("Arial", false, false),
      fm.resolveFont("Arial", true, false),
      fm.resolveFont("Arial", false, true),
      fm.resolveFont("Arial", true, true)
    ]);

    expect(names.size).toBe(4);
  });

  it("keeps a single registered font on every style — the pre-existing behaviour", () => {
    const fm = new FontManager();
    fm.registerEmbeddedFont(parseTtf(REGULAR));

    const regular = fm.resolveFont("Arial", false, false);
    expect(fm.resolveFont("Arial", true, false)).toBe(regular);
    expect(fm.resolveFont("Arial", false, true)).toBe(regular);
    expect(fm.resolveFont("Arial", true, true)).toBe(regular);
    expect(regular).toBe(fm.getEmbeddedResourceName());
  });

  it("falls back to regular for styles that were not supplied", () => {
    const fm = new FontManager();
    fm.registerEmbeddedFontFace(parseTtf(REGULAR), "regular");
    fm.registerEmbeddedFontFace(parseTtf(BOLD), "bold");

    // bold has its own face; italic was not supplied, so regular draws it.
    expect(faceWidth(fm, true, false)).toBeCloseTo(700, 5);
    expect(faceWidth(fm, false, true)).toBeCloseTo(600, 5);
  });

  it("prefers bold over italic for bold+italic when boldItalic is missing", () => {
    const fm = new FontManager();
    fm.registerEmbeddedFontFace(parseTtf(REGULAR), "regular");
    fm.registerEmbeddedFontFace(parseTtf(BOLD), "bold");
    fm.registerEmbeddedFontFace(parseTtf(ITALIC), "italic");

    expect(faceWidth(fm, true, true)).toBeCloseTo(700, 5);
  });

  it("uses italic for bold+italic when only italic is supplied", () => {
    const fm = new FontManager();
    fm.registerEmbeddedFontFace(parseTtf(REGULAR), "regular");
    fm.registerEmbeddedFontFace(parseTtf(ITALIC), "italic");

    expect(faceWidth(fm, true, true)).toBeCloseTo(800, 5);
  });

  it("replaces a style when it is registered twice", () => {
    const fm = new FontManager();
    fm.registerEmbeddedFontFace(parseTtf(REGULAR), "regular");
    const first = fm.registerEmbeddedFontFace(parseTtf(BOLD), "bold");
    const second = fm.registerEmbeddedFontFace(parseTtf(BOLD_ITALIC), "bold");

    expect(second).not.toBe(first);
    expect(fm.resolveFont("Arial", true, false)).toBe(second);
    expect(fm.isEmbeddedFont(first)).toBe(false);
    expect(faceWidth(fm, true, false)).toBeCloseTo(900, 5);
  });

  it("reports embedded state and suppresses the Type3 fallback", () => {
    const fm = managerWithAllFaces();

    expect(fm.hasEmbeddedFont()).toBe(true);
    // 'č' (U+010D) is outside WinAnsi — with faces embedded it is drawn by
    // one of them rather than by a Type3 fallback glyph.
    expect(fm.needsType3(0x10d)).toBe(false);
    expect(fm.isEmbeddedFont(fm.resolveFont("Arial", true, false))).toBe(true);
  });

  it("defaults to the regular face for the document resource name", () => {
    const fm = managerWithAllFaces();

    expect(fm.getEmbeddedResourceName()).toBe(fm.resolveFont("Arial", false, false));
  });
});

// =============================================================================
// FontManager — per-face metrics, deferred routing, encoding
// =============================================================================

describe("FontManager multi-face metrics and encoding", () => {
  it("measures each face with its own advance widths", () => {
    const fm = managerWithAllFaces();
    const regular = fm.resolveFont("Arial", false, false);
    const bold = fm.resolveFont("Arial", true, false);

    // 'AB' = 2 glyphs, at size 10: regular 2*600/1000*10, bold 2*700/1000*10
    expect(fm.measureText("AB", regular, 10)).toBeCloseTo(12, 5);
    expect(fm.measureText("AB", bold, 10)).toBeCloseTo(14, 5);
  });

  it("reports per-face vertical metrics", () => {
    const fm = managerWithAllFaces();
    const bold = fm.resolveFont("Arial", true, false);

    // The fixture faces share ascent 800 / descent -200 over 1000 units.
    expect(fm.getFontAscent(bold, 10)).toBeCloseTo(8, 5);
    expect(fm.getFontDescent(bold, 10)).toBeCloseTo(-2, 5);
    expect(fm.getLineHeight(bold, 10)).toBeCloseTo(10, 5);
  });

  it("routes a deferred Type1 resource to the face matching its style", () => {
    const fm = managerWithAllFaces();
    const type1Bold = fm.ensureFont("Helvetica-Bold");
    const type1Italic = fm.ensureFont("Times-Italic");
    const type1BoldItalic = fm.ensureFont("Helvetica-BoldOblique");
    const type1Plain = fm.ensureFont("Times-Roman");

    expect(fm.resolveRenderResourceName(type1Bold)).toBe(fm.resolveFont("Arial", true, false));
    expect(fm.resolveRenderResourceName(type1Italic)).toBe(fm.resolveFont("Arial", false, true));
    expect(fm.resolveRenderResourceName(type1BoldItalic)).toBe(fm.resolveFont("Arial", true, true));
    expect(fm.resolveRenderResourceName(type1Plain)).toBe(fm.resolveFont("Arial", false, false));
  });

  it("leaves a resource that is already a face untouched", () => {
    const fm = managerWithAllFaces();
    const bold = fm.resolveFont("Arial", true, false);

    expect(fm.resolveRenderResourceName(bold)).toBe(bold);
  });

  it("gives each face its own subset CID mapping", async () => {
    const fm = managerWithAllFaces();
    fm.trackText("AB");

    const writer = new PdfWriter();
    await fm.writeFontResources(writer);

    // Every face subsets the same code points, so each encodes 'AB' through
    // its own map — and each map has to exist.
    for (const [bold, italic] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true]
    ] as const) {
      const resourceName = fm.resolveFont("Arial", bold, italic);
      expect(fm.encodeText("AB", resourceName)).toBe("<00010002>");
    }
  });

  it("returns null when encoding against a non-embedded resource", async () => {
    const fm = managerWithAllFaces();
    fm.trackText("AB");
    const writer = new PdfWriter();
    await fm.writeFontResources(writer);

    expect(fm.encodeText("AB", fm.ensureFont("Helvetica"))).toBeNull();
  });
});

// =============================================================================
// PDF inspection helpers
// =============================================================================

/**
 * The PDF's content operators as text.
 *
 * Content streams are Flate-compressed once they grow past a few operators, so
 * a document large enough to carry several styles has to be inflated before its
 * `Tf` / `Tj` operators can be read. Streams that are not Flate — font files,
 * anything already raw — simply fail to inflate and are skipped.
 */
function inflateContent(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const parts: string[] = [];
  let index = 0;
  for (;;) {
    const open = raw.indexOf("stream", index);
    if (open < 0) {
      break;
    }
    const close = raw.indexOf("endstream", open);
    if (close < 0) {
      break;
    }
    // Skip the EOL after `stream` — CRLF or LF — and the one before `endstream`.
    let start = open + "stream".length;
    if (raw[start] === 0x0d) {
      start++;
    }
    if (raw[start] === 0x0a) {
      start++;
    }
    try {
      parts.push(inflateSync(raw.subarray(start, close)).toString("latin1"));
    } catch {
      // Not a Flate stream — nothing to read here.
    }
    // Past the whole keyword — "endstream" itself contains "stream".
    index = close + "endstream".length;
  }
  return parts.join("\n");
}

/**
 * Map each font resource name in the PDF to the BaseFont it resolves to, by
 * following the page Resources entry to the font object it references.
 */
function baseFontByResource(pdf: string): Map<string, string> {
  const objectNumbers = new Map<string, string>();
  for (const [, resourceName, objNum] of pdf.matchAll(/\/(EF\d+|F\d+)\s+(\d+)\s+0\s+R/g)) {
    objectNumbers.set(resourceName, objNum);
  }

  const result = new Map<string, string>();
  for (const [resourceName, objNum] of objectNumbers) {
    const start = pdf.indexOf(`\n${objNum} 0 obj`);
    if (start < 0) {
      continue;
    }
    const body = pdf.slice(start, pdf.indexOf("endobj", start));
    const baseFont = /\/BaseFont\s*\/(\S+?)[\s/>]/.exec(body);
    if (baseFont) {
      result.set(resourceName, baseFont[1]);
    }
  }
  return result;
}

/**
 * The PDF's bytes as text. latin1, not utf-8: the file interleaves ASCII syntax
 * with binary font data, and a 1:1 byte mapping keeps both intact.
 */
function pdfText(pdf: Uint8Array): string {
  return Buffer.from(pdf).toString("latin1");
}

/**
 * The BaseFont behind every text-showing operation, in content-stream order.
 * A `Tf` selects a font resource and every following `Tj` draws with it.
 */
function drawnBaseFonts(pdf: Uint8Array): string[] {
  const resources = baseFontByResource(pdfText(pdf));
  const content = inflateContent(pdf);
  const drawn: string[] = [];
  let current = "";
  for (const [, selected] of content.matchAll(
    /\/(EF\d+|F\d+) [\d.]+ Tf|(?:<[0-9A-F]*>|\(.*?\)) Tj/g
  )) {
    if (selected) {
      current = resources.get(selected) ?? selected;
    } else if (current) {
      drawn.push(current);
    }
  }
  return drawn;
}

// =============================================================================
// Integration — excelToPdf with the `fonts` option
// =============================================================================

describe("excelToPdf with per-style font faces", () => {
  async function exportWith(options: ExcelToPdfOptions): Promise<Uint8Array> {
    const { excelToPdf } = await import("@pdf/excel-bridge");

    const wb = createWorkbook();
    const ws = addWorksheet(wb, "Test");
    Cell.setValue(ws, "A1", "AB");
    Cell.setStyle(ws, "A1", { font: { bold: true } });
    Cell.setValue(ws, "A2", "AB");
    Cell.setStyle(ws, "A2", { font: { italic: true } });
    Cell.setValue(ws, "A3", "AB");

    return excelToPdf(wb, options);
  }

  it("embeds one subset per supplied face", async () => {
    const text = pdfText(
      await exportWith({
        fonts: { regular: REGULAR, bold: BOLD, italic: ITALIC, boldItalic: BOLD_ITALIC }
      })
    );

    expect(text).toContain("%PDF-2.0");
    expect(text).toContain("FaceRegular-Regular-Subset");
    expect(text).toContain("FaceBold-Regular-Subset");
    expect(text).toContain("FaceItalic-Regular-Subset");
    expect(text).toContain("FaceBoldItalic-Regular-Subset");
  });

  it("draws each run with the face matching its style", async () => {
    const drawn = new Set(
      drawnBaseFonts(
        await exportWith({
          fonts: { regular: REGULAR, bold: BOLD, italic: ITALIC, boldItalic: BOLD_ITALIC }
        })
      )
    );

    // The sheet holds a bold cell, an italic cell and a plain cell, so all
    // three faces have to appear. Before per-style embedding every run drew
    // with the one embedded font.
    expect(drawn).toContain("FaceBold-Regular-Subset");
    expect(drawn).toContain("FaceItalic-Regular-Subset");
    expect(drawn).toContain("FaceRegular-Regular-Subset");
  });

  it("draws every run with the one face when a single font is given", async () => {
    const drawn = new Set(drawnBaseFonts(await exportWith({ font: REGULAR })));

    expect(drawn).toEqual(new Set(["FaceRegular-Regular-Subset"]));
  });

  it("draws bold runs with the regular face when no bold face was supplied", async () => {
    const drawn = new Set(
      drawnBaseFonts(await exportWith({ fonts: { regular: REGULAR, italic: ITALIC } }))
    );

    expect(drawn).toContain("FaceItalic-Regular-Subset");
    expect(drawn).toContain("FaceRegular-Regular-Subset");
    expect(drawn).not.toContain("FaceBold-Regular-Subset");
  });

  it("embeds only the faces that were supplied", async () => {
    const text = pdfText(await exportWith({ fonts: { regular: REGULAR, bold: BOLD } }));

    expect(text).toContain("FaceRegular-Regular-Subset");
    expect(text).toContain("FaceBold-Regular-Subset");
    expect(text).not.toContain("FaceItalic-Regular-Subset");
    expect(text).not.toContain("FaceBoldItalic-Regular-Subset");
  });

  it("takes precedence over the single-font option", async () => {
    const text = pdfText(await exportWith({ font: BOLD_ITALIC, fonts: { regular: REGULAR } }));

    expect(text).toContain("FaceRegular-Regular-Subset");
    expect(text).not.toContain("FaceBoldItalic-Regular-Subset");
  });

  it("throws when the regular face cannot be parsed", async () => {
    await expect(exportWith({ fonts: { regular: new Uint8Array([1, 2, 3, 4]) } })).rejects.toThrow(
      PdfRenderError
    );
  });

  it("skips an optional face that cannot be parsed", async () => {
    const text = pdfText(
      await exportWith({ fonts: { regular: REGULAR, bold: new Uint8Array([1, 2, 3, 4]) } })
    );

    // The document still renders, drawing bold runs with the regular face.
    expect(text).toContain("%PDF-2.0");
    expect(text).toContain("FaceRegular-Regular-Subset");
  });

  it("still embeds a single face for the `font` option", async () => {
    const text = pdfText(await exportWith({ font: REGULAR }));

    expect(text).toContain("FaceRegular-Regular-Subset");
    expect(text).not.toContain("FaceBold-Regular-Subset");
  });
});
