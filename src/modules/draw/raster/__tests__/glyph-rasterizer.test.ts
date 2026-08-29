/**
 * Tests for the chart glyph rasterizer's horizontal metrics handling.
 */

import { parseRasterFont, rasterizeGlyph } from "@draw/raster/glyph-rasterizer";
import { describe, it, expect } from "vitest";

// =============================================================================
// Fixture
// =============================================================================

/** How a fixture glyph is described in `glyf`. */
type GlyphShape =
  | { kind: "empty" }
  | { kind: "simple"; xMin: number }
  | { kind: "composite"; xMin: number; component: number; useMyMetrics: boolean };

interface GlyphSpec {
  advanceWidth: number;
  leftSideBearing: number;
  shape: GlyphShape;
}

const ARGS_ARE_XY_VALUES = 0x0002;
const USE_MY_METRICS = 0x0200;

/**
 * Assemble a font file from tables, padding each to a 4-byte boundary.
 *
 * The rasterizer parses fonts itself and depends on nothing outside its module,
 * so its fixture is built here rather than shared with the PDF font tests.
 */
function assemble(tables: Array<{ tag: string; data: Uint8Array }>): Uint8Array {
  const header = 12 + tables.length * 16;
  let cursor = header;
  const placed = tables.map(({ tag, data }) => {
    const padded = new Uint8Array((data.length + 3) & ~3);
    padded.set(data);
    const entry = { tag, data: padded, offset: cursor };
    cursor += padded.length;
    return entry;
  });

  const file = new Uint8Array(cursor);
  const v = new DataView(file.buffer);
  v.setUint32(0, 0x00010000, false);
  v.setUint16(4, tables.length, false);
  placed.forEach((entry, i) => {
    const rec = 12 + i * 16;
    for (let c = 0; c < 4; c++) {
      file[rec + c] = entry.tag.charCodeAt(c);
    }
    v.setUint32(rec + 8, entry.offset, false);
    v.setUint32(rec + 12, entry.data.length, false);
    file.set(entry.data, entry.offset);
  });
  return file;
}

/** A one-contour glyph of two on-curve points, spanning `xMin`..`xMin + 100`. */
function simpleGlyph(xMin: number): Uint8Array {
  const glyph = new Uint8Array(24);
  const v = new DataView(glyph.buffer);
  v.setInt16(0, 1, false); // numberOfContours
  v.setInt16(2, xMin, false); // xMin
  v.setInt16(4, 0, false); // yMin
  v.setInt16(6, xMin + 100, false); // xMax
  v.setInt16(8, 100, false); // yMax
  v.setUint16(10, 1, false); // endPtsOfContours[0]
  v.setUint16(12, 0, false); // instructionLength
  glyph[14] = 0x01; // both points on-curve, coordinates as int16 deltas
  glyph[15] = 0x01;
  v.setInt16(16, xMin, false); // x[0]
  v.setInt16(18, 100, false); // x[1]
  v.setInt16(20, 0, false); // y[0]
  v.setInt16(22, 100, false); // y[1]
  return glyph;
}

/** A composite of one component placed at the origin, optionally lending metrics. */
function compositeGlyph(xMin: number, component: number, useMyMetrics: boolean): Uint8Array {
  const glyph = new Uint8Array(16);
  const v = new DataView(glyph.buffer);
  v.setInt16(0, -1, false); // numberOfContours: composite
  v.setInt16(2, xMin, false);
  v.setInt16(4, 0, false);
  v.setInt16(6, xMin + 100, false);
  v.setInt16(8, 100, false);
  v.setUint16(10, ARGS_ARE_XY_VALUES | (useMyMetrics ? USE_MY_METRICS : 0), false);
  v.setUint16(12, component, false);
  glyph[14] = 0; // dx as int8
  glyph[15] = 0; // dy as int8
  return glyph;
}

function glyphBytes(shape: GlyphShape): Uint8Array {
  switch (shape.kind) {
    case "empty":
      return new Uint8Array(0);
    case "simple":
      return simpleGlyph(shape.xMin);
    case "composite":
      return compositeGlyph(shape.xMin, shape.component, shape.useMyMetrics);
  }
}

/**
 * Which `cmap` encoding record the fixture advertises.
 *
 * A real font chooses this, and the choice is not cosmetic: several macOS system
 * fonts publish a Unicode-platform subtable and nothing on the Windows platform.
 */
interface CmapEncoding {
  platformID: number;
  encodingID: number;
}

/** Windows Unicode BMP — what the overwhelming majority of fonts carry. */
const WINDOWS_BMP: CmapEncoding = { platformID: 3, encodingID: 1 };

/** Build a font whose glyphs are `specs`, with 'A' mapped to glyph 1 onwards. */
function buildFont(specs: GlyphSpec[], encoding: CmapEncoding = WINDOWS_BMP): Uint8Array {
  const numGlyphs = specs.length;

  const head = new Uint8Array(54);
  const headV = new DataView(head.buffer);
  headV.setUint32(0, 0x00010000, false);
  headV.setUint16(18, 1000, false); // unitsPerEm
  headV.setInt16(50, 1, false); // indexToLocFormat = long

  const hhea = new Uint8Array(36);
  const hheaV = new DataView(hhea.buffer);
  hheaV.setUint32(0, 0x00010000, false);
  hheaV.setInt16(4, 800, false); // ascent
  hheaV.setInt16(6, -200, false); // descent
  hheaV.setUint16(34, numGlyphs, false); // numberOfHMetrics

  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint16(4, numGlyphs, false);

  // cmap: one format 4 subtable mapping 'A'… onto glyph 1…
  const lastChar = 0x41 + numGlyphs - 2;
  const segments = [
    { start: 0x41, end: lastChar, delta: 1 - 0x41 },
    { start: 0xffff, end: 0xffff, delta: 1 }
  ];
  const subtableLength = 14 + segments.length * 8 + 2;
  const cmap = new Uint8Array(12 + subtableLength);
  const cmapV = new DataView(cmap.buffer);
  cmapV.setUint16(2, 1, false); // numTables
  cmapV.setUint16(4, encoding.platformID, false);
  cmapV.setUint16(6, encoding.encodingID, false);
  cmapV.setUint32(8, 12, false); // subtable offset
  cmapV.setUint16(12, 4, false); // format
  cmapV.setUint16(14, subtableLength, false);
  cmapV.setUint16(18, segments.length * 2, false); // segCountX2
  let at = 26;
  segments.forEach(s => {
    cmapV.setUint16(at, s.end, false);
    at += 2;
  });
  at += 2; // reservedPad
  segments.forEach(s => {
    cmapV.setUint16(at, s.start, false);
    at += 2;
  });
  segments.forEach(s => {
    cmapV.setInt16(at, s.delta, false);
    at += 2;
  });

  const hmtx = new Uint8Array(numGlyphs * 4);
  const hmtxV = new DataView(hmtx.buffer);
  specs.forEach((spec, i) => {
    hmtxV.setUint16(i * 4, spec.advanceWidth, false);
    hmtxV.setInt16(i * 4 + 2, spec.leftSideBearing, false);
  });

  const glyphs = specs.map(spec => glyphBytes(spec.shape));
  const loca = new Uint8Array((numGlyphs + 1) * 4);
  const locaV = new DataView(loca.buffer);
  let glyfLength = 0;
  glyphs.forEach((glyph, i) => {
    locaV.setUint32(i * 4, glyfLength, false);
    glyfLength += glyph.length;
  });
  locaV.setUint32(numGlyphs * 4, glyfLength, false);

  const glyf = new Uint8Array(glyfLength);
  let writeAt = 0;
  glyphs.forEach(glyph => {
    glyf.set(glyph, writeAt);
    writeAt += glyph.length;
  });

  return assemble([
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "maxp", data: maxp },
    { tag: "cmap", data: cmap },
    { tag: "hmtx", data: hmtx },
    { tag: "loca", data: loca },
    { tag: "glyf", data: glyf }
  ]);
}

// .notdef, then: a well-formed glyph, one whose bearing disagrees with its
// outline, a composite that claims its component's metrics, a composite that
// does not, and a glyph with no outline at all.
const A = 0x41;
const B = 0x42;
const C = 0x43;
const D = 0x44;
const E = 0x45;
const SPECS: GlyphSpec[] = [
  { advanceWidth: 500, leftSideBearing: 0, shape: { kind: "empty" } },
  { advanceWidth: 600, leftSideBearing: 120, shape: { kind: "simple", xMin: 120 } },
  { advanceWidth: 610, leftSideBearing: -40, shape: { kind: "simple", xMin: 120 } },
  {
    advanceWidth: 999,
    leftSideBearing: 500,
    shape: { kind: "composite", xMin: 120, component: 2, useMyMetrics: true }
  },
  {
    advanceWidth: 620,
    leftSideBearing: 300,
    shape: { kind: "composite", xMin: 120, component: 2, useMyMetrics: false }
  },
  { advanceWidth: 250, leftSideBearing: 0, shape: { kind: "empty" } }
];

/** Leftmost point of an outline, i.e. where the glyph's ink begins. */
function inkStart(font: ReturnType<typeof parseRasterFont>, codePoint: number): number {
  const outline = font.getOutline(codePoint);
  if (!outline) {
    throw new Error(`no glyph for U+${codePoint.toString(16)}`);
  }
  return Math.min(...outline.contours.flat().map(pt => pt.x));
}

// =============================================================================
// Tests
// =============================================================================

describe("Glyph Rasterizer Horizontal Metrics", () => {
  it("starts the ink at the left side bearing", () => {
    // Outline coordinates begin at the glyph's xMin, but a rasterizer translates
    // the outline by `lsb - xMin` before drawing, which lands the ink at
    // `pen + lsb`. In a well-formed font the two agree and nothing moves.
    const font = parseRasterFont(buildFont(SPECS));

    expect(inkStart(font, A)).toBe(120);
    expect(font.getOutline(A)?.advanceWidth).toBe(600);
  });

  it("honors a bearing that disagrees with the outline", () => {
    // Around 0.4% of glyphs in shipped fonts disagree — by up to 0.35 em in
    // Times New Roman Italic. The bearing wins, because that is what every
    // FreeType-based renderer draws.
    const font = parseRasterFont(buildFont(SPECS));

    expect(inkStart(font, B)).toBe(-40);
  });

  it("takes a composite's metrics from the component that claims them", () => {
    // USE_MY_METRICS forces the composite's advance and bearing to be the
    // component's: an i-circumflex measures as the dotless i it is built from.
    // The composite's own hmtx entry — 999/500 here — is not used at all.
    const font = parseRasterFont(buildFont(SPECS));

    expect(font.getOutline(C)?.advanceWidth).toBe(610);
    expect(inkStart(font, C)).toBe(-40);
  });

  it("keeps a composite's own metrics when no component claims them", () => {
    const font = parseRasterFont(buildFont(SPECS));

    expect(font.getOutline(D)?.advanceWidth).toBe(620);
    expect(inkStart(font, D)).toBe(300);
  });

  it("reports the real advance width of a glyph with no outline", () => {
    // A space has no ink but still moves the pen, and by what the font says
    // rather than a guessed fraction of an em.
    const font = parseRasterFont(buildFont(SPECS));
    const outline = font.getOutline(E);

    expect(outline?.contours).toEqual([]);
    expect(outline?.advanceWidth).toBe(250);
  });

  it("places the rasterized bitmap at the bearing", () => {
    // The bitmap offset is what the chart renderer adds to the pen position, so
    // this is the value that actually decides where the ink lands on the page.
    const font = parseRasterFont(buildFont(SPECS));
    const unitsPerEm = font.unitsPerEm;
    const fontSize = 100;

    const wellFormed = rasterizeGlyph(font.getOutline(A)!, fontSize, unitsPerEm);
    const disagreeing = rasterizeGlyph(font.getOutline(B)!, fontSize, unitsPerEm);

    // 120/1000 em at 100px is 12px, less one pixel of padding.
    expect(wellFormed.offsetX).toBe(11);
    // -40/1000 em is -4px, so this glyph's ink starts left of the pen.
    expect(disagreeing.offsetX).toBe(-5);
  });

  it("keeps the ink at the bearing for a monospaced tail glyph", () => {
    // Cut numberOfHMetrics to 1: every glyph past the first shares its advance
    // width and keeps its own bearing in the trailing int16 array.
    const specs = SPECS.slice(0, 2);
    const ttf = buildFont(specs);
    const forged = new Uint8Array(ttf);
    const view = new DataView(forged.buffer);
    for (let i = 0; i < view.getUint16(4, false); i++) {
      const rec = 12 + i * 16;
      const name = String.fromCharCode(...forged.subarray(rec, rec + 4));
      const offset = view.getUint32(rec + 8, false);
      if (name === "hhea") {
        view.setUint16(offset + 34, 1, false);
      }
      if (name === "hmtx") {
        view.setUint16(offset + 4, 250, false); // trailing bearing for glyph 1
        view.setUint32(rec + 12, 6, false); // 1 long record + 1 bearing
      }
    }

    const font = parseRasterFont(forged);
    expect(inkStart(font, A)).toBe(250);
    expect(font.getOutline(A)?.advanceWidth).toBe(500); // shared with glyph 0
  });

  it("returns the same outline object for repeated lookups", () => {
    // The chart renderer measures a label and then draws it, keying its
    // rasterization cache on the outline object. A fresh object per call would
    // make that cache miss every time and re-rasterize every glyph.
    const font = parseRasterFont(buildFont(SPECS));

    expect(font.getOutline(A)).toBe(font.getOutline(A));
    expect(font.getOutline(0x2764)).toBeUndefined();
  });

  it("survives a composite that references itself", () => {
    // A cycle in the component graph would recurse until the stack gives out.
    const specs: GlyphSpec[] = [
      { advanceWidth: 500, leftSideBearing: 0, shape: { kind: "empty" } },
      {
        advanceWidth: 600,
        leftSideBearing: 0,
        shape: { kind: "composite", xMin: 0, component: 1, useMyMetrics: false }
      }
    ];
    const font = parseRasterFont(buildFont(specs));

    expect(font.getOutline(A)?.contours).toEqual([]);
    expect(font.getOutline(A)?.advanceWidth).toBe(600);
  });

  it("keeps a broken glyph index inside glyf", () => {
    // Offsets past the end of glyf would hand the outline parser bytes from the
    // table that follows it.
    const ttf = buildFont(SPECS);
    const forged = new Uint8Array(ttf);
    const view = new DataView(forged.buffer);
    let locaOffset = 0;
    let glyfLength = 0;
    for (let i = 0; i < view.getUint16(4, false); i++) {
      const rec = 12 + i * 16;
      const name = String.fromCharCode(...forged.subarray(rec, rec + 4));
      if (name === "loca") {
        locaOffset = view.getUint32(rec + 8, false);
      }
      if (name === "glyf") {
        glyfLength = view.getUint32(rec + 12, false);
      }
    }
    // Point every glyph past the end of glyf.
    for (let i = 0; i <= SPECS.length; i++) {
      view.setUint32(locaOffset + i * 4, 0xffff, false);
    }

    const font = parseRasterFont(forged);

    expect(glyfLength).toBeGreaterThan(0);
    // Clamped to the end of glyf, so every glyph is empty rather than garbage.
    expect(font.getOutline(A)?.contours).toEqual([]);
  });
});

describe("Glyph Rasterizer cmap subtable selection", () => {
  // A Unicode-platform subtable is not an exotic fallback. macOS `STHeiti` and
  // `STFangsong` publish `(0,4)` and nothing on platform 3, and `Helvetica.ttc`
  // publishes `(0,3)` plus platform-1 subtables only — so a Windows-only scan
  // yielded an empty map and drew nothing at all, silently. `Helvetica.ttc` is
  // the rasteriser's own macOS fallback when Arial is absent, which made this
  // reachable for Latin text and not only for CJK.
  const UNICODE_ENCODINGS: Array<[string, CmapEncoding]> = [
    ["(0,3) Unicode BMP", { platformID: 0, encodingID: 3 }],
    ["(0,4) Unicode full repertoire", { platformID: 0, encodingID: 4 }],
    ["(0,6) Unicode full, later spec", { platformID: 0, encodingID: 6 }],
    ["(3,1) Windows BMP", { platformID: 3, encodingID: 1 }],
    ["(3,10) Windows full repertoire", { platformID: 3, encodingID: 10 }]
  ];

  it.each(UNICODE_ENCODINGS)("resolves glyphs through a %s subtable", (_label, encoding) => {
    const font = parseRasterFont(buildFont(SPECS, encoding));

    const outline = font.getOutline(A);
    expect(outline?.advanceWidth).toBe(600);
    expect(outline?.contours.length).toBeGreaterThan(0);
  });

  it("ignores a subtable on a non-Unicode platform", () => {
    // Platform 1 (Macintosh) is a legacy 8-bit encoding, not Unicode: reading it
    // as though the code points were Unicode maps the wrong glyphs.
    const font = parseRasterFont(buildFont(SPECS, { platformID: 1, encodingID: 0 }));

    expect(font.getOutline(A)).toBeUndefined();
  });
});
