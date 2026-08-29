import type { Font } from "@excel/types";
import { calculateWrappedLineCount } from "@excel/utils/text-metrics";
/**
 * Full-width character measurement.
 *
 * These widths were previously derived from a per-font `wideFactor` multiplied by
 * a digit width — an estimate multiplied by a fallback. Measured against the real
 * advances of every CJK font on a Mac, the declared factors over-stated Heiti by
 * 22%, AppleGothic by 55% and NanumGothic by 47%.
 *
 * A full-width character advances by exactly one em, and that is a property of the
 * character, not the face.
 */
import { describe, it, expect } from "vitest";

import { getCharAdvance, getDefaultFontMetrics } from "../font-data";
import type { MeasuredFont } from "../text-measure";
import { measureTextWidthPx } from "../text-measure";

const emPx = (sizePt: number): number => (sizePt / 72) * 96;

describe("full-width advance", () => {
  it("should measure one ideograph as one em, whatever the face", () => {
    for (const size of [9, 12, 18, 24]) {
      const expected = emPx(size); // integral for these sizes
      for (const name of [
        "SimSun",
        "宋体",
        "Heiti SC",
        "Songti SC",
        "Microsoft YaHei",
        "微软雅黑",
        "AppleGothic",
        "NanumGothic",
        "MS Gothic",
        "Calibri" // no CJK glyphs of its own, but the character still advances one em
      ]) {
        expect(measureTextWidthPx("中", { name, size }), `${name} @${size}pt`).toBe(expected);
      }
    }
  });

  it("should not widen an ideograph for bold or italic", () => {
    // A CJK face draws its bold at the same advance.
    const plain = measureTextWidthPx("中文报表", { name: "SimSun", size: 12 });
    expect(measureTextWidthPx("中文报表", { name: "SimSun", size: 12, bold: true })).toBe(plain);
    expect(measureTextWidthPx("中文报表", { name: "SimSun", size: 12, italic: true })).toBe(plain);
  });

  it("should scale linearly with the character count", () => {
    const one = measureTextWidthPx("中", { name: "SimSun", size: 12 });
    expect(measureTextWidthPx("中".repeat(10), { name: "SimSun", size: 12 })).toBe(one * 10);
  });

  it("should give every CJK face the same width for the same text", () => {
    // The per-font factors made these differ by up to 55%.
    const widths = ["SimSun", "Heiti SC", "Songti SC", "AppleGothic", "NanumGothic"].map(name =>
      measureTextWidthPx("一二三四五六七八九十", { name, size: 12 })
    );
    expect(new Set(widths).size).toBe(1);
  });

  it("should give an ideograph exactly one em, not two digit widths", () => {
    // The two measurement paths disagreed by 5%: one used the em, the other two
    // digit widths. Asserted against the em directly rather than by summing a
    // per-character helper — the width and wrap paths now share one accumulator
    // (see "wrapping and width measurement share one model" below), so a helper
    // that neither of them uses could not witness a disagreement between them.
    for (const name of ["SimSun", "Heiti SC", "Calibri"]) {
      const size = 12;
      const emPx = Math.ceil((size / 72) * 96);
      const text = "一二三四五六七八九十甲乙";
      expect(measureTextWidthPx(text, { name, size }), name).toBe([...text].length * emPx);
    }
  });

  it("should still measure Latin text from the font's own metrics", () => {
    // The change must not have flattened Latin differences.
    const a = measureTextWidthPx("Report 2024", { name: "Calibri", size: 12 });
    const b = measureTextWidthPx("Report 2024", { name: "Courier New", size: 12 });
    expect(a).not.toBe(b);
  });
});

describe("getCharAdvance uses the shared full-width table", () => {
  // Measured through `getCharAdvance` directly, not through `measureTextWidthPx`:
  // `charPx` short-circuits on `isWideCharacter` and returns one em before it reaches
  // this function, so a test that went the long way round would pass whatever this
  // function did. That is exactly what the first version of this test did.
  const metrics = getDefaultFontMetrics();

  it("gives a full em to everything the shared predicate calls wide", () => {
    // The private range list this replaced covered ideographs and kana but not Hangul
    // Jamo, the Yi syllabary, the fullwidth signs, the vertical and small
    // compatibility forms, CJK Extension G, or any emoji.
    for (const cp of [0x1100, 0xa000, 0xffe5, 0xfe30, 0xfe10, 0x1f600, 0x30000]) {
      expect(getCharAdvance(metrics, cp)).toBe(metrics.cjkAdvance);
    }
  });

  it("still gives a full em to ideographs, kana and fullwidth forms", () => {
    for (const cp of [0x4e2d, 0x3042, 0x30a2, 0xac00, 0xff21, 0xff01]) {
      expect(getCharAdvance(metrics, cp)).toBe(metrics.cjkAdvance);
    }
  });

  it("does not reserve an em for unassigned code points", () => {
    // The one thing the private list did that was reachable: `U+3040`, `U+D7A4–D7AF`
    // and `U+2FFFE–2FFFF` are unassigned or noncharacters, and it gave them a full em.
    for (const cp of [0x3040, 0xd7a4, 0xd7af, 0x2fffe]) {
      expect(getCharAdvance(metrics, cp)).not.toBe(metrics.cjkAdvance);
    }
  });

  it("keeps Latin narrow", () => {
    expect(getCharAdvance(metrics, 0x41)).toBeLessThan(metrics.cjkAdvance);
  });
});

describe("grapheme cluster measurement", () => {
  // Widths were summed per code point, so anything built from more than one was
  // charged for each: measured at 12pt, `👍🏽` came to 32px for a single glyph,
  // `🇨🇳` 32px for one flag and `👩‍👩‍👧‍👦` 94px for one emoji. That inflated
  // auto-fit column widths and produced extra wrapped lines.
  const em = 16; // 12pt

  it("should charge one advance per cluster, not per code point", () => {
    for (const text of ["中\uFE0F", "👍🏽", "🇨🇳", "👩‍👩‍👧‍👦"]) {
      expect(measureTextWidthPx(text, { name: "SimSun", size: 12 }), JSON.stringify(text)).toBe(em);
    }
  });

  it("should treat VS16 as a request for emoji presentation", () => {
    // `✈` is narrow as text and full-width as `✈️`, so the selector decides.
    expect(measureTextWidthPx("✈\uFE0F", { name: "SimSun", size: 12 })).toBe(em);
    expect(measureTextWidthPx("✈", { name: "SimSun", size: 12 })).toBeLessThan(em);
  });

  it("should not charge separately for a combining mark", () => {
    const composed = measureTextWidthPx("é", { name: "Calibri", size: 12 });
    const decomposed = measureTextWidthPx("e\u0301", { name: "Calibri", size: 12 });
    expect(decomposed).toBe(composed);
  });

  it("should measure a mixed string as the sum of its clusters", () => {
    // Two ideographs, one flag, three ASCII letters.
    const text = "报表🇨🇳abc";
    const parts =
      measureTextWidthPx("报表", { name: "SimSun", size: 12 }) +
      measureTextWidthPx("🇨🇳", { name: "SimSun", size: 12 }) +
      measureTextWidthPx("abc", { name: "SimSun", size: 12 });
    expect(measureTextWidthPx(text, { name: "SimSun", size: 12 })).toBe(parts);
  });
});

describe("wrapping and width measurement share one model", () => {
  // These were two models. Width measured a whole line and applied the
  // adjustments that belong to it; wrapping summed a per-character measurement and
  // so skipped them. A cell whose column was set to the width path's own answer
  // still reported three lines, on 26 of 42 font/text combinations — every
  // superscript cell, and every face with no registered metrics, which is most of
  // them.
  const FONTS: { label: string; font?: Partial<MeasuredFont> }[] = [
    { label: "Calibri 11 (default)", font: undefined },
    { label: "Calibri 11 superscript", font: { vertAlign: "superscript" } },
    { label: "Calibri 11 subscript", font: { vertAlign: "subscript" } },
    { label: "unknown face", font: { name: "Mystery Face", size: 11 } },
    { label: "unknown face bold", font: { name: "Mystery Face", size: 11, bold: true } },
    { label: "unknown face italic", font: { name: "Mystery Face", size: 11, italic: true } },
    {
      label: "unknown face bold superscript",
      font: { name: "Mystery Face", size: 9, bold: true, vertAlign: "superscript" }
    },
    { label: "宋体 12", font: { name: "宋体", size: 12 } },
    { label: "Arial 14 bold", font: { name: "Arial", size: 14, bold: true } }
  ];

  const TEXTS = [
    "abc def ghi",
    "中中。文",
    "Hello World",
    "é é",
    "報表 Report",
    "0123456789",
    "混合 mixed 内容",
    "one-two-three",
    "中\u0301文"
  ];

  for (const { label, font } of FONTS) {
    it.each(TEXTS)(`should fit %j on one line at its own measured width — ${label}`, text => {
      const width = measureTextWidthPx(text, font);
      expect(calculateWrappedLineCount(text, width, font as Partial<Font>)).toBe(1);
    });
  }

  it("should scale superscript once, not once per character", () => {
    // `measureClusterPx` applied the 0.6 for full-width characters and the line
    // applied it again, so an ideograph measured 36% of its width — narrowing an
    // auto-fit column enough to clip it.
    for (const text of ["中", "中中", "中文报表"]) {
      const plain = measureTextWidthPx(text, undefined);
      const superscript = measureTextWidthPx(text, { vertAlign: "superscript" });
      expect(superscript / plain).toBeCloseTo(0.6, 2);
    }
  });
});
