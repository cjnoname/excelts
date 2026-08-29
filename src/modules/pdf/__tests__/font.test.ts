import { FontManager, resolvePdfFontName } from "@pdf/font/font-manager";
import {
  measureText,
  getFontAscent,
  getFontDescent,
  getLineHeight,
  getCharWidth,
  isStandardFont,
  getStandardFontNames
} from "@pdf/font/metrics";
import { isFullWidthCodePoint } from "@utils/font-metrics";
/**
 * Tests for PDF font metrics and font manager.
 */
import { describe, it, expect } from "vitest";

describe("Font Metrics", () => {
  describe("getCharWidth", () => {
    it("should return width for ASCII space in Helvetica", () => {
      const width = getCharWidth(32, "Helvetica"); // space
      expect(width).toBe(278);
    });

    it("should return width for letter A in Helvetica", () => {
      const width = getCharWidth(65, "Helvetica"); // 'A'
      expect(width).toBe(667);
    });

    it("should return monospace width for Courier", () => {
      const widthA = getCharWidth(65, "Courier");
      const widthZ = getCharWidth(90, "Courier");
      expect(widthA).toBe(600);
      expect(widthZ).toBe(600);
    });

    it("should fallback to Helvetica for unknown fonts", () => {
      const width = getCharWidth(65, "UnknownFont");
      expect(width).toBe(getCharWidth(65, "Helvetica"));
    });

    it("should return a full em for full-width characters", () => {
      // No standard-14 face has an ideograph, so the renderer substitutes a
      // face that does — and that face advances by a full em. Measuring these
      // at the Latin average (513) understated a CJK run by half, so the text
      // positioned after it overlapped the glyphs.
      expect(getCharWidth(0x4e2d, "Helvetica")).toBe(1000); // U+4E2D ideograph
      expect(getCharWidth(0x3042, "Helvetica")).toBe(1000); // U+3042 hiragana
      expect(getCharWidth(0xac00, "Helvetica")).toBe(1000); // U+AC00 hangul syllable
      expect(getCharWidth(0xff21, "Helvetica")).toBe(1000); // fullwidth A
      // Monospace is no exception: the substituted face still decides.
      expect(getCharWidth(0x4e2d, "Courier")).toBe(1000);
    });

    it("should still return the average width for unmapped narrow characters", () => {
      // U+0450 (Cyrillic ѐ) is narrow and absent from the Helvetica table.
      expect(getCharWidth(0x0450, "Helvetica")).toBe(513);
    });

    it("should count an astral character once, not once per surrogate", () => {
      // U+1F600 is one full-width glyph; iterating UTF-16 units doubled it.
      expect(measureText("\u{1F600}", "Helvetica", 10)).toBeCloseTo(10, 5);
    });
  });

  describe("measureText", () => {
    it("should return 0 for empty string", () => {
      expect(measureText("", "Helvetica", 12)).toBe(0);
    });

    it("should measure a simple word", () => {
      const width = measureText("Hello", "Helvetica", 12);
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThan(100);
    });

    it("should scale with font size", () => {
      const width12 = measureText("Test", "Helvetica", 12);
      const width24 = measureText("Test", "Helvetica", 24);
      expect(width24).toBeCloseTo(width12 * 2, 1);
    });

    it("should vary by font family", () => {
      const helvetica = measureText("Test", "Helvetica", 12);
      const times = measureText("Test", "Times-Roman", 12);
      expect(helvetica).not.toBe(times);
    });

    it("should give same width for all Courier chars", () => {
      const widthA = measureText("A", "Courier", 12);
      const widthW = measureText("W", "Courier", 12);
      expect(widthA).toBe(widthW);
    });
  });

  describe("getFontAscent", () => {
    it("should return positive ascent", () => {
      const ascent = getFontAscent("Helvetica", 12);
      expect(ascent).toBeGreaterThan(0);
    });

    it("should scale with font size", () => {
      const a12 = getFontAscent("Helvetica", 12);
      const a24 = getFontAscent("Helvetica", 24);
      expect(a24).toBeCloseTo(a12 * 2, 1);
    });
  });

  describe("getFontDescent", () => {
    it("should return negative descent", () => {
      const descent = getFontDescent("Helvetica", 12);
      expect(descent).toBeLessThan(0);
    });
  });

  describe("getLineHeight", () => {
    it("should return ascent minus descent", () => {
      const lineHeight = getLineHeight("Helvetica", 12);
      const ascent = getFontAscent("Helvetica", 12);
      const descent = getFontDescent("Helvetica", 12);
      expect(lineHeight).toBeCloseTo(ascent - descent, 4);
    });
  });

  describe("isStandardFont", () => {
    it("should recognize standard fonts", () => {
      expect(isStandardFont("Helvetica")).toBe(true);
      expect(isStandardFont("Helvetica-Bold")).toBe(true);
      expect(isStandardFont("Times-Roman")).toBe(true);
      expect(isStandardFont("Courier")).toBe(true);
    });

    it("should reject non-standard fonts", () => {
      expect(isStandardFont("Arial")).toBe(false);
      expect(isStandardFont("Calibri")).toBe(false);
    });
  });

  describe("getStandardFontNames", () => {
    it("should return all 12 standard fonts", () => {
      const names = getStandardFontNames();
      expect(names.length).toBe(12);
      expect(names).toContain("Helvetica");
      expect(names).toContain("Helvetica-Bold");
      expect(names).toContain("Helvetica-Oblique");
      expect(names).toContain("Helvetica-BoldOblique");
      expect(names).toContain("Times-Roman");
      expect(names).toContain("Times-Bold");
      expect(names).toContain("Times-Italic");
      expect(names).toContain("Times-BoldItalic");
      expect(names).toContain("Courier");
      expect(names).toContain("Courier-Bold");
      expect(names).toContain("Courier-Oblique");
      expect(names).toContain("Courier-BoldOblique");
    });
  });
});

describe("Font Name Resolution", () => {
  describe("resolvePdfFontName", () => {
    it("should map Arial to Helvetica family", () => {
      expect(resolvePdfFontName("Arial", false, false)).toBe("Helvetica");
      expect(resolvePdfFontName("Arial", true, false)).toBe("Helvetica-Bold");
      expect(resolvePdfFontName("Arial", false, true)).toBe("Helvetica-Oblique");
      expect(resolvePdfFontName("Arial", true, true)).toBe("Helvetica-BoldOblique");
    });

    it("should map Calibri to Helvetica family", () => {
      expect(resolvePdfFontName("Calibri", false, false)).toBe("Helvetica");
      expect(resolvePdfFontName("Calibri", true, false)).toBe("Helvetica-Bold");
    });

    it("should map Times New Roman to Times family", () => {
      expect(resolvePdfFontName("Times New Roman", false, false)).toBe("Times-Roman");
      expect(resolvePdfFontName("Times New Roman", true, false)).toBe("Times-Bold");
      expect(resolvePdfFontName("Times New Roman", false, true)).toBe("Times-Italic");
      expect(resolvePdfFontName("Times New Roman", true, true)).toBe("Times-BoldItalic");
    });

    it("should map Courier New to Courier family", () => {
      expect(resolvePdfFontName("Courier New", false, false)).toBe("Courier");
      expect(resolvePdfFontName("Courier New", true, false)).toBe("Courier-Bold");
      expect(resolvePdfFontName("Courier New", false, true)).toBe("Courier-Oblique");
    });

    it("should map Consolas to Courier family", () => {
      expect(resolvePdfFontName("Consolas", false, false)).toBe("Courier");
    });

    it("should fall back to Helvetica for unknown fonts", () => {
      expect(resolvePdfFontName("FancyFont", false, false)).toBe("Helvetica");
      expect(resolvePdfFontName("FancyFont", true, false)).toBe("Helvetica-Bold");
    });

    it("should be case-insensitive", () => {
      expect(resolvePdfFontName("ARIAL", false, false)).toBe("Helvetica");
      expect(resolvePdfFontName("times new roman", true, true)).toBe("Times-BoldItalic");
    });
  });
});

describe("FontManager", () => {
  it("should register and track fonts", () => {
    const fm = new FontManager();
    const r1 = fm.ensureFont("Helvetica");
    const r2 = fm.ensureFont("Helvetica-Bold");
    const r3 = fm.ensureFont("Helvetica"); // should return same as r1

    expect(r1).toBe("F1");
    expect(r2).toBe("F2");
    expect(r3).toBe("F1"); // same font, same resource name
  });

  it("should resolve Excel font names", () => {
    const fm = new FontManager();
    const r1 = fm.resolveFont("Arial", false, false);
    const r2 = fm.resolveFont("Arial", true, false);

    expect(r1).not.toBe(r2);
    expect(fm.getPdfFontName(r1)).toBe("Helvetica");
    expect(fm.getPdfFontName(r2)).toBe("Helvetica-Bold");
  });

  it("should measure text through font manager", () => {
    const fm = new FontManager();
    const resource = fm.ensureFont("Helvetica");
    const width = fm.measureText("Hello", resource, 12);
    expect(width).toBeGreaterThan(0);
  });

  it("should return font ascent/descent", () => {
    const fm = new FontManager();
    const resource = fm.ensureFont("Helvetica");
    expect(fm.getFontAscent(resource, 12)).toBeGreaterThan(0);
    expect(fm.getFontDescent(resource, 12)).toBeLessThan(0);
    expect(fm.getLineHeight(resource, 12)).toBeGreaterThan(0);
  });

  it("should list registered fonts", () => {
    const fm = new FontManager();
    fm.ensureFont("Helvetica");
    fm.ensureFont("Courier");

    const fonts = fm.getRegisteredFonts();
    expect(fonts).toHaveLength(2);
    expect(fonts.find(f => f.pdfFontName === "Helvetica")).toBeDefined();
    expect(fonts.find(f => f.pdfFontName === "Courier")).toBeDefined();
  });
});

describe("emoji and zero-width metrics", () => {
  it("measures emoji outside the smiley block as full width", () => {
    // The range list stopped at U+1F64F, so a rocket measured half the width of a
    // grinning face and every line containing one wrapped in the wrong place.
    for (const cp of [0x1f600, 0x1f680, 0x1f9c0, 0x1f1e6, 0x2728, 0x274c, 0x2b50, 0x26a1]) {
      expect(getCharWidth(cp, "Helvetica")).toBe(1000);
    }
  });

  it("does not treat arrows, dashes and symbols as full-width", () => {
    // Widening whole blocks would have caught these, which are not emoji. They
    // take their own width from the table (an em dash really is one em wide in
    // Helvetica) rather than the full-em rule that covers substituted faces.
    for (const cp of [0x2192, 0x2014, 0x00a9, 0x2264]) {
      expect(isFullWidthCodePoint(cp)).toBe(false);
    }
    expect(getCharWidth(0x2192, "Helvetica")).toBe(513); // no glyph: average
    expect(getCharWidth(0x2264, "Helvetica")).toBe(513); // no glyph: average
    expect(getCharWidth(0x00a9, "Helvetica")).toBe(737); // copyright, from AFM
  });

  it("charges nothing for joiners and variation selectors", () => {
    // They shape their neighbours rather than drawing. Charging each an average
    // width measured a four-person family emoji as five and a half characters.
    for (const cp of [0x200d, 0xfe0f, 0x200b, 0x2060, 0xfeff]) {
      expect(getCharWidth(cp, "Helvetica")).toBe(0);
    }
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    // Four glyphs at 10pt, and nothing for the three joiners between them.
    expect(measureText(family, "Helvetica", 10)).toBeCloseTo(40, 5);
  });
});

describe("WinAnsi repertoire metrics", () => {
  /**
   * Every code point `WinAnsiEncoding` can name: the twenty-seven cp1252
   * specials at 0x80–0x9F, then Latin-1 0xA0–0xFF.
   */
  const WIN_ANSI_NON_ASCII = [
    0x20ac,
    0x201a,
    0x0192,
    0x201e,
    0x2026,
    0x2020,
    0x2021,
    0x02c6,
    0x2030,
    0x0160,
    0x2039,
    0x0152,
    0x017d,
    0x2018,
    0x2019,
    0x201c,
    0x201d,
    0x2022,
    0x2013,
    0x2014,
    0x02dc,
    0x2122,
    0x0161,
    0x203a,
    0x0153,
    0x017e,
    0x0178,
    ...Array.from({ length: 0x60 }, (_, i) => 0xa0 + i)
  ];

  /** `avgWidth` per face — the value a table miss falls back to. */
  const AVERAGES: ReadonlyArray<readonly [string, number]> = [
    ["Helvetica", 513],
    ["Helvetica-Bold", 535],
    ["Times-Roman", 478],
    ["Times-Bold", 505]
  ];

  it("has a real width for every code point WinAnsi can encode", () => {
    // A standard-14 face reaches the PDF as `/BaseFont /Helvetica` with
    // `/Encoding /WinAnsiEncoding` and no embedded file, so the viewer advances
    // these bytes by their AFM width. Any that still fall through to `avgWidth`
    // are measured wrong at draw time, and because a run is placed at the x the
    // layout computed the error accumulates along the line.
    for (const [face, average] of AVERAGES) {
      const missing = WIN_ANSI_NON_ASCII.filter(cp => getCharWidth(cp, face) === average);
      expect(missing.map(cp => cp.toString(16))).toEqual([]);
    }
  });

  it("matches the AFM widths that the drawing side uses", () => {
    // The em dash is the one that showed: it reserved 513 and drew 1000, so
    // `— \`Admin\`` lost the space between them and rendered as `—Admin`.
    expect(getCharWidth(0x2014, "Helvetica")).toBe(1000); // emdash
    expect(getCharWidth(0x2013, "Helvetica")).toBe(556); // endash
    expect(getCharWidth(0x2019, "Helvetica")).toBe(222); // quoteright
    expect(getCharWidth(0x201d, "Helvetica")).toBe(333); // quotedblright
    expect(getCharWidth(0x2022, "Helvetica")).toBe(350); // bullet
    expect(getCharWidth(0x2026, "Helvetica")).toBe(1000); // ellipsis
    expect(getCharWidth(0x00a0, "Helvetica")).toBe(278); // nbsp advances like a space
    expect(getCharWidth(0x00e9, "Helvetica")).toBe(556); // eacute, like 'e'
    // Times-Roman is its own face, not Helvetica with different ASCII.
    expect(getCharWidth(0x2122, "Times-Roman")).toBe(980); // trademark
    expect(getCharWidth(0x00a9, "Times-Roman")).toBe(760); // copyright
    // Courier stays monospaced across the whole repertoire.
    for (const cp of WIN_ANSI_NON_ASCII) {
      expect(getCharWidth(cp, "Courier")).toBe(600);
    }
  });

  it("keeps avgWidth for code points a standard face has no glyph for", () => {
    // U+0450 (Cyrillic ѐ) and U+2192 (→) are outside WinAnsi entirely: the
    // renderer substitutes for them, so an average is the honest answer.
    expect(getCharWidth(0x0450, "Helvetica")).toBe(513);
    expect(getCharWidth(0x2192, "Helvetica")).toBe(513);
  });

  it("measures a run containing an em dash at its drawn width", () => {
    // The string from the report, at the size it was rendered.
    expect(measureText(") — global tier: ", "Helvetica", 11)).toBeCloseTo(74.58, 2);
  });
});
