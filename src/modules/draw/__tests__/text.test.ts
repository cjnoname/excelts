/**
 * Text measurement, in the terms a display-list producer works in.
 *
 * The measurement itself is exercised by the Excel column-autofit tests, which is where
 * the advance tables came from. What is new here is the wrapper: the unit conversion,
 * which has been got wrong before, and `wrapText`, which had no implementation at all
 * outside the chart module.
 */

import { POINTS_PER_PIXEL, measureText, widestText, wrapText } from "@draw/index";
import type { DrawTextStyle } from "@draw/index";
import { measureTextWidthPx } from "@utils/text-measure";
import { describe, expect, it } from "vitest";

const style = (over: Partial<DrawTextStyle> = {}): DrawTextStyle => ({
  size: 12,
  family: "arial",
  ...over
});

describe("measuring text for a display list", () => {
  it("reports width in the list's units, not in CSS pixels", () => {
    // `measureTextWidthPx` returns a pixel width for a point size, so it carries a 96/72
    // scale. A display list draws text at `style.size` units — SVG writes
    // `font-size="${size}"` and the PDF surface passes the number through as points — so
    // a pixel width over-reports every label by 4/3. That mistake pushed legends wider,
    // shifted centred titles left, and ellipsised axis labels that fit.
    const text = "Quarterly revenue";
    const pixels = measureTextWidthPx(text, {
      name: "arial",
      size: 12,
      bold: false,
      italic: false
    });
    expect(measureText(text, style())).toBeCloseTo(pixels * POINTS_PER_PIXEL, 6);
    expect(POINTS_PER_PIXEL).toBeCloseTo(0.75, 6);
  });

  it("returns zero for empty text rather than a font's worth of nothing", () => {
    expect(measureText("", style())).toBe(0);
  });

  it("grows with the font size", () => {
    expect(measureText("Widget", style({ size: 24 }))).toBeGreaterThan(
      measureText("Widget", style({ size: 12 }))
    );
  });

  it("makes bold wider than regular", () => {
    expect(measureText("Widget", style({ bold: true }))).toBeGreaterThan(
      measureText("Widget", style())
    );
  });

  it("measures a proportional face proportionally", () => {
    // The point of carrying advance tables at all: `iiii` is not `WWWW`.
    expect(measureText("WWWW", style())).toBeGreaterThan(measureText("iiii", style()) * 2);
  });

  it("reports the widest line of multi-line text", () => {
    // What a box drawn around the text has to be.
    const width = measureText("i\nWWWWWWWW", style());
    expect(width).toBeCloseTo(measureText("WWWWWWWW", style()), 6);
  });

  it("falls back to a default face when the style names none", () => {
    expect(measureText("Widget", { size: 12 })).toBeGreaterThan(0);
  });
});

describe("wrapping text to a width", () => {
  it("breaks at spaces once a line would overflow", () => {
    const lines = wrapText("alpha beta gamma delta", style(), measureText("alpha beta", style()));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).not.toMatch(/^\s|\s$/);
    }
  });

  it("keeps every line inside the limit when it can", () => {
    const limit = measureText("alpha beta", style());
    for (const line of wrapText("alpha beta gamma delta epsilon", style(), limit)) {
      expect(measureText(line, style())).toBeLessThanOrEqual(limit);
    }
  });

  it("loses no words", () => {
    const source = "alpha beta gamma delta epsilon zeta";
    const lines = wrapText(source, style(), measureText("alpha beta", style()));
    expect(lines.join(" ").split(/\s+/)).toEqual(source.split(" "));
  });

  it("leaves a word longer than the limit on its own line", () => {
    // Breaking inside a word needs hyphenation rules to look like anything but a bug.
    const lines = wrapText(
      "short Unbreakablylongword short",
      style(),
      measureText("short", style())
    );
    expect(lines).toContain("Unbreakablylongword");
  });

  it("honours the author's own newlines", () => {
    // They are deliberate breaks; wrapping must not swallow them.
    const lines = wrapText("first\nsecond", style(), 10_000);
    expect(lines).toEqual(["first", "second"]);
  });

  it("wraps within a paragraph without merging it into the next", () => {
    const lines = wrapText("alpha beta\ngamma", style(), measureText("alpha", style()));
    expect(lines[lines.length - 1]).toBe("gamma");
  });

  it("returns the paragraphs unchanged when the limit is meaningless", () => {
    // A zero or negative width has no wrap that satisfies it; reporting the input beats
    // returning one word per line or looping.
    expect(wrapText("alpha beta", style(), 0)).toEqual(["alpha beta"]);
    expect(wrapText("alpha beta", style(), -5)).toEqual(["alpha beta"]);
  });

  it("returns a single empty line for empty text", () => {
    expect(wrapText("", style(), 100)).toEqual([""]);
  });
});

describe("the widest of several strings", () => {
  const style: DrawTextStyle = { size: 12, family: "sans-serif" };

  it("measures zero for nothing, rather than -Infinity", () => {
    // `Math.max(...[])` is `-Infinity`, which does not throw: it flows into whatever width was
    // being computed and turns a layout into NaN somewhere else entirely. Sizing a gutter for
    // no labels asks for no room.
    expect(widestText([], style)).toBe(0);
  });

  it("agrees with measuring the longest entry directly", () => {
    const texts = ["i", "medium", "the longest label here"];
    expect(widestText(texts, style)).toBe(measureText("the longest label here", style));
  });

  it("compares width and not character count", () => {
    // Proportional metrics: at equal length the wide glyphs win, and a helper that compared
    // `length` could not tell the two apart at all.
    expect(widestText(["MMMM", "iiii"], style)).toBe(measureText("MMMM", style));
    // The converse, so this cannot pass by always preferring the first entry: enough narrow
    // glyphs do outrun fewer wide ones.
    expect(widestText(["MMMM", "iiiiii"], style)).toBe(measureText("iiiiii", style));
  });
});

describe("wrapText — East Asian text", () => {
  // A Chinese chart label or diagram caption was one unbreakable token, so it
  // never wrapped however narrow the box. Break opportunities now come from
  // `@utils/cjk`.
  const style = { size: 10 };

  it("should wrap Chinese text", () => {
    const lines = wrapText("这是一段很长的中文文本需要在单元格里自动换行显示出来", style, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("这是一段很长的中文文本需要在单元格里自动换行显示出来");
  });

  it("should keep every line within the limit", () => {
    const lines = wrapText("季度环比同比增长率毛利净利营业收入成本费用", style, 50);
    for (const line of lines) {
      expect(measureText(line, style)).toBeLessThanOrEqual(50);
    }
  });

  it("should not start a line with sentence-final punctuation", () => {
    const lines = wrapText("甲乙丙丁戊己庚辛。壬癸子丑寅卯", style, 40);
    for (const line of lines.slice(1)) {
      expect(line.startsWith("。")).toBe(false);
      expect(line.startsWith("，")).toBe(false);
    }
  });

  it("should still honour explicit newlines", () => {
    expect(wrapText("第一行\n第二行", style, 500)).toEqual(["第一行", "第二行"]);
  });

  it("should wrap Japanese and Korean", () => {
    expect(wrapText("これはとても長い日本語のテキストです", style, 40).length).toBeGreaterThan(1);
    expect(wrapText("이것은매우긴한국어텍스트입니다", style, 40).length).toBeGreaterThan(1);
  });
});
