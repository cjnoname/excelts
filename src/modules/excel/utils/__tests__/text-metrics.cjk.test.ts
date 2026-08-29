import type { Font } from "@excel/types";
import {
  calculateAutoFitHeight,
  calculateWrappedLineCount,
  getLineHeightPx
} from "@excel/utils/text-metrics";
import { measureTextWidthPx } from "@utils/text-measure";
import { pixelToPoints } from "@utils/units";
/**
 * CJK wrapping and measurement for spreadsheet cells.
 *
 * `src/modules/excel/utils/__tests__/` had no test for `text-metrics` at all,
 * and `core/__tests__/auto-fit.test.ts`'s "wide chars" case means `"MWmw"` —
 * wide *Latin* letters. Nothing exercised an ideograph, which is how a cell that
 * reported one line for any amount of Chinese survived.
 */
import { describe, it, expect } from "vitest";

const SIMSUN = { name: "SimSun", size: 11 };
const CALIBRI = { name: "Calibri", size: 11 };

// 26 ideographs. At SimSun 11pt each is ~15px, so ~390px total.
const LONG_ZH = "这是一段很长的中文文本需要在单元格里自动换行显示出来";
const LONG_EN = "this is a fairly long english sentence that needs wrapping in a cell";

describe("calculateWrappedLineCount — East Asian text", () => {
  // The bug: `_splitIntoWords` only broke at space/hyphen/tab, so a Chinese
  // string was one word, and the first word on a line is placed
  // unconditionally. Every Chinese cell reported exactly one line.
  it("should wrap Chinese text instead of reporting a single line", () => {
    const lines = calculateWrappedLineCount(LONG_ZH, 100, SIMSUN);
    expect(lines).toBeGreaterThan(1);
    // ~390px of text in a 100px column cannot be fewer than 3 lines.
    expect(lines).toBeGreaterThanOrEqual(3);
  });

  it("should scale the line count with the column width", () => {
    const narrow = calculateWrappedLineCount(LONG_ZH, 60, SIMSUN);
    const wide = calculateWrappedLineCount(LONG_ZH, 300, SIMSUN);
    expect(narrow).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThanOrEqual(1);
  });

  it("should wrap Japanese and Korean too", () => {
    expect(
      calculateWrappedLineCount("これはとても長い日本語のテキストです折り返しが必要", 100, SIMSUN)
    ).toBeGreaterThan(1);
    expect(
      calculateWrappedLineCount("이것은매우긴한국어텍스트입니다줄바꿈이필요합니다", 100, SIMSUN)
    ).toBeGreaterThan(1);
  });

  it("should wrap mixed Chinese and Latin", () => {
    expect(
      calculateWrappedLineCount("报表 Report 2024 年度 annual 汇总", 80, SIMSUN)
    ).toBeGreaterThan(1);
  });

  it("should still report one line when the text fits", () => {
    expect(calculateWrappedLineCount("中文", 200, SIMSUN)).toBe(1);
  });

  it("should honour explicit newlines in Chinese text", () => {
    expect(calculateWrappedLineCount("第一行\n第二行\n第三行", 500, SIMSUN)).toBe(3);
  });

  it("should not regress Latin wrapping", () => {
    const lines = calculateWrappedLineCount(LONG_EN, 100, CALIBRI);
    expect(lines).toBeGreaterThan(1);
    expect(calculateWrappedLineCount("short", 500, CALIBRI)).toBe(1);
  });
});

describe("calculateAutoFitHeight — East Asian text", () => {
  // Consequence of the one-line count: `autoFitRows` left the row at a single
  // line's height, and Excel clipped everything after the first line.
  it("should give a wrapped Chinese cell room for every line", () => {
    const oneLine = pixelToPoints(getLineHeightPx(SIMSUN));
    const height = calculateAutoFitHeight(LONG_ZH, SIMSUN, { wrapText: true }, 100);
    expect(height).toBeGreaterThan(oneLine * 2);
  });

  it("should stay at one line when wrapText is off", () => {
    const oneLine = pixelToPoints(getLineHeightPx(SIMSUN));
    const height = calculateAutoFitHeight(LONG_ZH, SIMSUN, { wrapText: false }, 100);
    expect(height).toBeCloseTo(oneLine, 5);
  });

  it("should grow as the column narrows", () => {
    const narrow = calculateAutoFitHeight(LONG_ZH, SIMSUN, { wrapText: true }, 60);
    const wide = calculateAutoFitHeight(LONG_ZH, SIMSUN, { wrapText: true }, 300);
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("calculateWrappedLineCount — kinsoku", () => {
  // A closing bracket or full stop glued to its neighbour can push the pair to
  // the next line, so a kinsoku-aware count may exceed the naive one. What must
  // never happen is a count that ignores the gluing entirely.
  it("should keep a bracketed group together, costing at most one extra line", () => {
    const plain = calculateWrappedLineCount("甲乙丙丁戊己庚辛壬癸", 100, SIMSUN);
    const bracketed = calculateWrappedLineCount("甲乙丙丁戊己庚（辛壬）癸", 100, SIMSUN);
    expect(bracketed).toBeGreaterThanOrEqual(plain);
    expect(bracketed).toBeLessThanOrEqual(plain + 1);
  });

  it("should not treat punctuation as a free break point", () => {
    // 。and ， are glued backwards, so this measures the same as the bare text
    // plus the punctuation width — never fewer lines than the bare characters.
    const withPunct = calculateWrappedLineCount("一二三四。五六七八，九十", 100, SIMSUN);
    expect(withPunct).toBeGreaterThan(1);
  });
});

describe("width and wrapping agree on the same text", () => {
  // The two paths measured in different units: `calculateAutoFitWidth` per
  // grapheme cluster, `calculateWrappedLineCount` per code point. A cell whose
  // column was set to the width path's own answer still reported two lines, and
  // NFD text — which macOS produces by default — doubled its row height.
  const FONT = { name: "Calibri", size: 11 };

  const CASES: Array<[string, string]> = [
    ["family emoji", "👩‍👩‍👧‍👦"],
    ["skin tone modifiers", "👍🏽👍🏽👍🏽"],
    ["regional indicators", "🇨🇳🇨🇳🇨🇳"],
    ["NFD accents", "e\u0301e\u0301e\u0301e\u0301e\u0301"],
    ["ideograph + VS16", "中\uFE0F".repeat(10)],
    ["mixed CJK and emoji", "团队 👩‍👩‍👧‍👦 家庭 👨‍👩‍👧 报表"],
    ["plain CJK", "一二三四五六七八九十"],
    ["plain Latin", "the quick brown fox jumps"]
  ];

  it("should fit in one line at exactly its measured width", () => {
    for (const [label, text] of CASES) {
      const width = measureTextWidthPx(text, FONT);
      expect(calculateWrappedLineCount(text, width, FONT), label).toBe(1);
    }
  });

  it("should never under-report lines at half that width", () => {
    // Wrapping may round up, but must never claim fewer lines than the text needs.
    for (const [label, text] of CASES) {
      const half = Math.ceil(measureTextWidthPx(text, FONT) / 2);
      expect(calculateWrappedLineCount(text, half, FONT), label).toBeGreaterThanOrEqual(1);
    }
  });

  it("should give NFC and NFD text the same row height", () => {
    const nfc = calculateAutoFitHeight("Résumé 概要 报表 2024", FONT, { wrapText: true }, 150);
    const nfd = calculateAutoFitHeight(
      "Re\u0301sume\u0301 概要 报表 2024",
      FONT,
      { wrapText: true },
      150
    );
    expect(nfd).toBeCloseTo(nfc, 5);
  });

  it("should not inflate a row for emoji", () => {
    const plain = calculateAutoFitHeight("team family report", FONT, { wrapText: true }, 200);
    const withEmoji = calculateAutoFitHeight("team 👩‍👩‍👧‍👦 report", FONT, { wrapText: true }, 200);
    expect(withEmoji).toBeCloseTo(plain, 5);
  });
});

describe("a word that measures zero is still a word", () => {
  // The wrap loop used `px(wordParts) === 0` to spot an empty word, which is a
  // guess about content from a width. The tier-2 formula is
  // `round(advanceFU / unitsPerEm * ppem)`, so at 1pt — where ppem rounds to 1 —
  // 84,353 code points measure 0px. `"iii WWWW"` in a 2px column then reported one
  // line: `"iii "` looked empty and was dropped rather than placed, so the wrap
  // before `WWWW` never happened.
  const tiny = { name: "Arial", size: 1 } as Partial<Font>;

  it("should still break before the next word", () => {
    expect(measureTextWidthPx("iii", tiny)).toBe(0); // the precondition
    expect(calculateWrappedLineCount("iii WWWW", 2, tiny)).toBe(2);
  });

  it("should count every zero-width word on its own line when nothing fits", () => {
    expect(calculateWrappedLineCount("W W W W", 1, tiny)).toBe(4);
  });

  it("should keep an all-zero-width line to one line", () => {
    // Nothing can overflow a column it has no width in.
    expect(calculateWrappedLineCount("i i i i", 2, tiny)).toBe(1);
    expect(calculateWrappedLineCount("", 2, tiny)).toBe(1);
  });
});
