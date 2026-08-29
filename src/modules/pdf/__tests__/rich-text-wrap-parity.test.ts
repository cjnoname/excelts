/**
 * The reserved line count must be the drawn line count.
 *
 * The layout pass reserves a row's height from a line count; the renderer draws the
 * lines. Each used to carry its own transcription of the wrapping rule, and they
 * disagreed twice:
 *
 * - Only the renderer was updated for East Asian breaking, so a Chinese rich-text
 *   cell reserved one line, drew six, and overprinted itself into a smear.
 * - The layout compared `measureRange(lineStart, wordEnd)` against the width while
 *   the renderer accumulated per appended word, so a paragraph's leading whitespace
 *   was charged to the first line in one and not the other: `"   aaa bbb ccc ddd"`
 *   reserved three lines and drew two.
 *
 * Both now call `wrapRichTextLines`, so the count *is* the length of the list that
 * gets drawn. This asserts that directly rather than through page geometry, where a
 * row's height also carries padding and the tallest run's ink and an off-by-one line
 * is not cleanly separable.
 */
import { FontManager } from "@pdf/font/font-manager";
import { parseTtf } from "@pdf/font/ttf-parser";
import { _countRichTextWrapLines } from "@pdf/render/layout-engine";
import { wrapRichTextLines } from "@pdf/render/page-renderer";
import type { PdfRichTextRunData, ResolvedPdfOptions } from "@pdf/types";
import { describe, expect, it } from "vitest";

import { buildTtfWithCmap } from "./ttf-test-utils";

const OPTIONS = {
  defaultFontFamily: "Helvetica",
  defaultFontSize: 11
} as unknown as ResolvedPdfOptions;

interface Run {
  text: string;
  font: { size: number };
}

/** Both counts for the same input, computed the way each pipeline computes it. */
function counts(
  runs: readonly Run[],
  width: number,
  fontManager: FontManager
): { reserved: number; drawn: number } {
  const text = runs.map(r => r.text).join("");
  const reserved = _countRichTextWrapLines(
    text,
    runs as unknown as PdfRichTextRunData[],
    width,
    fontManager,
    OPTIONS,
    undefined
  );
  const runForChar: number[] = [];
  runs.forEach((run, ri) => {
    for (let i = 0; i < run.text.length; i++) {
      runForChar.push(ri);
    }
  });
  const drawn = wrapRichTextLines(
    text,
    runForChar,
    runs.map(r => r.font.size),
    runs.map(() => fontManager.resolveFont("Helvetica", false, false)),
    fontManager,
    width
  ).length;
  return { reserved, drawn: Math.max(1, drawn) };
}

describe("reserved lines equal drawn lines", () => {
  // The five inputs that diverged when the layout charged leading whitespace.
  it.each([
    ["leading spaces", "   aaa bbb ccc ddd"],
    ["only leading spaces", "      aaa bbb"],
    ["ideographic spaces", "\u3000\u3000中文报表内容"],
    ["a leading indent after a newline", "aaa bbb\n   ccc ddd eee"],
    ["leading tabs", "\t\taaa bbb ccc"],
    ["plain CJK", "这是一段很长的中文文字内容需要换行"],
    ["kinsoku", "甲乙丙丁戊己庚辛。壬癸"],
    ["empty", ""],
    ["only a newline", "\n"],
    ["CRLF paragraphs", "aaa\r\nbbb\r\nccc"]
  ])("should agree for %s", (_label, text) => {
    for (const width of [8, 12, 20, 30, 45, 60, 90]) {
      const { reserved, drawn } = counts([{ text, font: { size: 11 } }], width, new FontManager());
      expect(reserved, `width ${width}`).toBe(drawn);
    }
  });

  it("should agree when every character is its own run", () => {
    // Maximises the number of run boundaries, which is where the two measurements
    // used to split differently.
    for (const body of ["aaa bbb ccc ddd", "  aa bb cc dd", "中文报表数据统计", "。）中文"]) {
      for (const size of [7, 11, 13.7, 20]) {
        for (const width of [12, 23, 40, 67]) {
          const runs = [...body].map(ch => ({ text: ch, font: { size } }));
          const { reserved, drawn } = counts(runs, width, new FontManager());
          expect(reserved, `${body} @${size}/${width}`).toBe(drawn);
        }
      }
    }
  });

  it("should agree with an embedded face and mixed run sizes", () => {
    const chars = [...new Set([..."aabbccdd 中文报表一二三。）"])].map(c => c.codePointAt(0)!);
    const face = parseTtf(
      buildTtfWithCmap(
        chars.map((cp, i) => ({ start: cp, end: cp, delta: 10 + i - cp })),
        chars.length + 20,
        {
          familyName: "ParityTest",
          postScriptName: "ParityTest-Regular",
          advanceWidths: [500, ...chars.map((_, i) => 301 + i * 7)]
        }
      )
    );
    const runs: Run[] = [
      { text: "中文", font: { size: 18 } },
      { text: " aabb ccdd ", font: { size: 7 } },
      { text: "报表一二三。", font: { size: 13 } }
    ];
    for (const width of [10, 18, 26, 38, 55, 80]) {
      const fontManager = new FontManager();
      fontManager.registerFallbackFont(face);
      const { reserved, drawn } = counts(runs, width, fontManager);
      expect(reserved, `width ${width}`).toBe(drawn);
    }
  });
});
