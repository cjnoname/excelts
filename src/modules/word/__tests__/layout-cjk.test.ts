/**
 * CJK line breaking in the Word layout engine.
 *
 * `layout-break-opportunities.test.ts` is entirely Courier Latin by design, so
 * nothing exercised an ideograph. The tokenizer split on whitespace only, which
 * made a whole Chinese paragraph one atom — and the `WrapAtom.glued` doc comment
 * stated that as the rule: *"A line may break at whitespace, and after a hard
 * break — nowhere else."* The consequences asserted below were both real.
 */

import { describe, it, expect } from "vitest";

import { layoutDocument } from "../layout/layout";
import { layoutDocumentFull } from "../layout/layout-full";
import type { BodyContent, DocxDocument, Paragraph, SectionProperties } from "../types";

/** One paragraph of plain text. */
function para(text: string): Paragraph {
  return { type: "paragraph", children: [{ content: [{ type: "text", text }] }] };
}

/** A paragraph whose text is split across two runs, to test run boundaries. */
function twoRunPara(a: string, b: string): Paragraph {
  return {
    type: "paragraph",
    children: [{ content: [{ type: "text", text: a }] }, { content: [{ type: "text", text: b }] }]
  };
}

/**
 * Lay out one paragraph with a fixed per-character width, and return the text of
 * each line.
 *
 * A uniform measure makes the column a character count, so the expectations
 * below read as "N characters per line" rather than as point arithmetic.
 */
function linesOf(p: Paragraph, charWidth: number): string[] {
  const doc: DocxDocument = { body: [p] };
  const laid = layoutDocumentFull(doc, {
    measureText: text => [...text].length * charWidth
  }).pages[0]!.content[0]!;
  if (laid.type !== "paragraph") {
    throw new Error("expected paragraph");
  }
  return laid.lines.map(line =>
    line.runs.map(run => ("text" in run ? (run.text as string) : "")).join("")
  );
}

// 468pt content width (US Letter, 1in margins) / 39pt per char = 12 chars per line.
const TWELVE_PER_LINE = 39;

describe("CJK line breaking", () => {
  it("should break a Chinese paragraph into multiple lines", () => {
    const lines = linesOf(para("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未"), TWELVE_PER_LINE);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未");
  });

  it("should fill the first line instead of pushing the whole run down", () => {
    // The defect: `"Note: "` plus a space-less Chinese run produced
    // ["Note:", "这是一段没有空格的中文文", "字用来测试换行"] — line 1 used 6 of
    // 20 columns because the Chinese was one atom that could not start there.
    const lines = linesOf(para("Note: 这是一段没有空格的中文文字用来测试换行"), TWELVE_PER_LINE);
    const first = [...lines[0]].length;
    expect(first).toBeGreaterThan(6);
    expect(first).toBeLessThanOrEqual(12);
  });

  it("should keep every line inside the content width", () => {
    const doc: DocxDocument = { body: [para("这是一段没有空格的中文".repeat(6))] };
    const laid = layoutDocumentFull(doc).pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    let right = 0;
    for (const line of laid.lines) {
      for (const run of line.runs) {
        right = Math.max(right, run.x + run.width);
      }
    }
    expect(right).toBeLessThanOrEqual(468);
  });

  it("should break between ideographs that came from different runs", () => {
    // `gluedToPrevious` only looked at the atom kind, so two ideographs in two
    // runs were one unbreakable cluster.
    const lines = linesOf(twoRunPara("甲乙丙丁戊己庚辛", "壬癸子丑寅卯辰巳"), TWELVE_PER_LINE);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳");
  });

  it("should still glue Latin across a run boundary", () => {
    // The behaviour `glued` exists for: `` `sybase.ts`, `` is two runs and one
    // word, and the comma must not be orphaned onto the next line.
    const lines = linesOf(twoRunPara("aaaa bbbb cccc", ", dddd"), TWELVE_PER_LINE);
    expect(lines.some(l => l.trimStart().startsWith(","))).toBe(false);
  });

  it("should not lose or duplicate text when wrapping", () => {
    // Space-less input must survive exactly.
    for (const text of [
      "中文报表二零二四年度营业额毛利率与增长趋势分析",
      "ひらがなカタカナ漢字がまざっているテキストです",
      "한국어텍스트도줄바꿈이되어야합니다"
    ]) {
      expect(linesOf(para(text), TWELVE_PER_LINE).join("")).toBe(text);
    }

    // Mixed input is compared without whitespace: a space sitting exactly at a
    // break is consumed by it, which is correct typesetting rather than loss.
    const mixed = "Mixed 混排 ABC 123 中文 abc 测试 xyz 汇总";
    expect(linesOf(para(mixed), TWELVE_PER_LINE).join("").replace(/\s+/g, "")).toBe(
      mixed.replace(/\s+/g, "")
    );
  });
});

describe("CJK kinsoku (禁則)", () => {
  // All four prohibitions were violated before: a naive per-character break puts
  // 。, ）and ，at the head of a line and leaves （ at the end of one.
  it("should not begin a line with sentence-final punctuation", () => {
    for (const [text, mark] of [
      ["甲乙丙丁戊己庚辛壬癸子丑。后面还有更多的文字内容", "。"],
      ["甲乙丙丁戊己庚辛壬癸子丑，后面还有更多的文字内容", "，"],
      ["甲乙丙丁戊己庚辛壬癸子丑、后面还有更多的文字内容", "、"],
      ["甲乙丙丁戊己庚辛壬癸子丑！后面还有更多的文字内容", "！"],
      ["甲乙丙丁戊己庚辛壬癸子丑？后面还有更多的文字内容", "？"]
    ] as const) {
      const lines = linesOf(para(text), TWELVE_PER_LINE);
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line.startsWith(mark), `${mark} began a line in ${JSON.stringify(lines)}`).toBe(
          false
        );
      }
    }
  });

  it("should not begin a line with a closing bracket", () => {
    const lines = linesOf(para("甲乙丙丁戊己庚辛壬癸子（丑）后面还有更多文字"), TWELVE_PER_LINE);
    for (const line of lines) {
      expect(line.startsWith("）")).toBe(false);
    }
  });

  it("should not end a line with an opening bracket", () => {
    const lines = linesOf(para("甲乙丙丁戊己庚辛壬癸子（丑寅卯辰巳午未申"), TWELVE_PER_LINE);
    for (const line of lines) {
      expect(line.trimEnd().endsWith("（")).toBe(false);
    }
  });

  it("should not split a doubled dash or ellipsis", () => {
    for (const text of [
      "甲乙丙丁戊己庚辛壬癸子——丑寅卯辰巳午未申",
      "甲乙丙丁戊己庚辛壬癸子……丑寅卯辰巳午未申"
    ]) {
      const lines = linesOf(para(text), TWELVE_PER_LINE);
      for (const line of lines) {
        // A line may hold both dashes or neither, never exactly one at an edge.
        expect(line.startsWith("—") && !line.startsWith("——")).toBe(false);
        expect(line.startsWith("…") && !line.startsWith("……")).toBe(false);
      }
    }
  });
});

describe("w:eastAsia typeface reaches the layout", () => {
  /** Record which typeface each measured stretch was measured with. */
  function measuredWith(p: Paragraph): Array<{ text: string; font: string }> {
    const seen: Array<{ text: string; font: string }> = [];
    layoutDocumentFull(
      { body: [p] },
      {
        measureText: (text, font) => {
          seen.push({ text, font: font ?? "?" });
          return [...text].length * 10;
        }
      }
    );
    return seen;
  }

  it("should measure Chinese with eastAsia and Latin with ascii", () => {
    // The defect: `resolveRunFontName` read `w:ascii` only, so this run was
    // measured entirely against Calibri and the typeface the author named for
    // Chinese never reached layout — nor, through it, the PDF bridge.
    const p: Paragraph = {
      type: "paragraph",
      children: [
        {
          properties: { font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "SimSun" } },
          content: [{ type: "text", text: "报表Report" }]
        }
      ]
    };
    const seen = measuredWith(p);
    const zh = seen.filter(s => s.text.includes("报") || s.text.includes("表"));
    const en = seen.filter(s => /Report|Rep|ort/.test(s.text));
    expect(zh.length).toBeGreaterThan(0);
    expect(en.length).toBeGreaterThan(0);
    for (const s of zh) {
      expect(s.font, `Chinese measured with ${s.font}`).toBe("SimSun");
    }
    for (const s of en) {
      expect(s.font, `Latin measured with ${s.font}`).toBe("Calibri");
    }
  });

  it("should apply a string typeface to both scripts", () => {
    const p: Paragraph = {
      type: "paragraph",
      children: [
        { properties: { font: "SimSun" }, content: [{ type: "text", text: "报表Report" }] }
      ]
    };
    for (const s of measuredWith(p)) {
      expect(s.font).toBe("SimSun");
    }
  });

  it("should fall back to the Latin name when eastAsia is absent", () => {
    const p: Paragraph = {
      type: "paragraph",
      children: [
        { properties: { font: { ascii: "Arial" } }, content: [{ type: "text", text: "报表" }] }
      ]
    };
    for (const s of measuredWith(p)) {
      expect(s.font).toBe("Arial");
    }
  });
});

describe("justified alignment (w:jc=both)", () => {
  /** Right edge of each line, and the spacing that stretched it. */
  function justified(text: string, alignment: "both" | "left") {
    const p: Paragraph = {
      type: "paragraph",
      properties: { alignment },
      children: [{ content: [{ type: "text", text }] }]
    };
    const laid = layoutDocumentFull({ body: [p] }, { measureText: t => [...t].length * 10 })
      .pages[0]!.content[0]!;
    if (laid.type !== "paragraph") {
      throw new Error("expected paragraph");
    }
    return laid.lines.map(line => ({
      right: Math.max(...line.runs.map(r => r.x + r.width)),
      alignment: line.alignment,
      charSpacing: line.runs
        .map(r => ("charSpacing" in r ? r.charSpacing : undefined))
        .find(v => v),
      wordSpacing: line.runs.map(r => ("wordSpacing" in r ? r.wordSpacing : undefined)).find(v => v)
    }));
  }

  const CONTENT_WIDTH = 468; // US Letter, 1in margins
  // 100 ideographs at 10pt = 1000pt, so three lines in a 468pt column.
  const LONG_ZH = "甲乙丙丁戊己庚辛壬癸".repeat(10);

  // `w:jc="both"` reached the layout model as `"justify"` and no renderer
  // consumed it, so justified text — the default for Chinese body copy — drew
  // left-aligned.
  it("should stretch every Chinese line but the last to the full column", () => {
    const lines = justified(LONG_ZH, "both");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(0, -1)) {
      expect(line.right).toBeCloseTo(CONTENT_WIDTH, 5);
      expect(line.charSpacing).toBeGreaterThan(0);
    }
  });

  it("should leave the last line at its natural width", () => {
    const lines = justified(LONG_ZH, "both");
    const last = lines[lines.length - 1];
    expect(last.right).toBeLessThan(CONTENT_WIDTH);
    expect(last.charSpacing).toBeUndefined();
  });

  it("should never overflow the column", () => {
    // `Tc` and `letter-spacing` add after *every* character including the last,
    // so dividing the slack by the inter-character gaps overshoots.
    for (const line of justified(LONG_ZH, "both")) {
      expect(line.right).toBeLessThanOrEqual(CONTENT_WIDTH);
    }
  });

  it("should not stretch a left-aligned paragraph", () => {
    for (const line of justified(LONG_ZH, "left")) {
      expect(line.charSpacing).toBeUndefined();
      expect(line.wordSpacing).toBeUndefined();
      expect(line.right).toBeLessThan(CONTENT_WIDTH);
    }
  });

  it("should widen spaces rather than characters for Latin text", () => {
    // Latin justification is a word-spacing adjustment; using character spacing
    // on it would space out the inside of every word.
    const lines = justified(
      "the quick brown fox jumps over the lazy dog and then runs away again quickly now",
      "both"
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].wordSpacing).toBeGreaterThan(0);
    expect(lines[0].charSpacing).toBeUndefined();
    expect(lines[0].right).toBeCloseTo(CONTENT_WIDTH, 5);
  });

  it("should decide per line, not per paragraph", () => {
    // A Chinese line inside an otherwise English paragraph is still spaced as
    // Chinese, because the line itself has no spaces to widen.
    const lines = justified(
      `${"甲乙丙丁戊己庚辛壬癸".repeat(5)} and some english words here too`,
      "both"
    );
    const cjkLine = lines.find(l => l.charSpacing !== undefined);
    expect(cjkLine).toBeDefined();
  });
});

describe("a page barely taller than one line", () => {
  // `sliceParagraphAtLine` was reached with a cut point equal to the line count,
  // so the tail was empty and reading its first line for the shift threw
  // `Cannot read properties of undefined (reading 'y')`. An over-tall line at the
  // top of a page has to stay there — there is no emptier page to move it to — and
  // when it is the paragraph's only line there is nothing left to continue.
  const para = (text: string, size?: number): BodyContent =>
    ({
      type: "paragraph",
      children: [{ content: [{ type: "text", text, ...(size ? { properties: { size } } : {}) }] }]
    }) as BodyContent;

  // Twips: 1pt = 20.
  const micro: SectionProperties = {
    pageSize: { width: 3000, height: 700 },
    margins: { top: 300, bottom: 300, left: 200, right: 200 }
  };
  const nano: SectionProperties = {
    pageSize: { width: 2000, height: 500 },
    margins: { top: 200, bottom: 200, left: 100, right: 100 }
  };

  it.each([
    ["a single line taller than the text area", [para("中", 400)], micro],
    ["CJK that must break across many pages", [para("中文报表".repeat(20), 150)], micro],
    ["one over-tall paragraph each", Array.from({ length: 5 }, () => para("中文", 120)), micro],
    ["an unbreakable Latin word", [para("Wwwww".repeat(10), 180)], nano],
    [
      "mixed scripts",
      Array.from({ length: 6 }, (_, i) => para(i % 2 ? "中文报表内容" : "Latin text here", 100)),
      nano
    ]
  ])("should lay out %s without throwing", (_label, body, sectionProperties) => {
    const laid = layoutDocumentFull({ body, sectionProperties });
    expect(laid.pages.length).toBeGreaterThan(0);
    // Nothing is dropped: every paragraph still reaches a page.
    expect(laid.pages.flatMap(p => p.content).length).toBeGreaterThanOrEqual(body.length);
  });
});

describe("the pagination estimate never under-reserves for a mixed run", () => {
  // `estimateParagraphLineHeight` documents the invariant it exists to hold: it
  // "can never place more on a page than the positioned pass can fit". It broke it
  // for a single run containing both scripts, because it took the East Asian face's
  // metrics on the stated grounds that "the CJK face is the taller". Real faces say
  // otherwise — Songti SC and Heiti SC give 0.86em ascent, Helvetica Neue 0.95em and
  // Hoefler Text 1.01em — so a tall Latin face inside a mostly-Chinese run was
  // measured against the shorter CJK face and the estimate came out 25% short.
  //
  // `pageCount` is not a private detail: `NUMPAGES`, `PAGE`, TOC page numbers and
  // `PAGEREF` are all resolved from it, so an under-estimate prints "1" in the
  // footer of a document that paginates to two.
  const TALL_ASCII = "TallAscii";
  const SHORT_CJK = "ShortCjk";

  const measureTextMetrics = (
    _text: string,
    font: string,
    size: number
  ): { ascent: number; descent: number } =>
    font === TALL_ASCII
      ? { ascent: size * 1.0, descent: -size * 0.5 }
      : { ascent: size * 0.86, descent: -size * 0.14 };

  const mixedParagraph = (): BodyContent =>
    ({
      type: "paragraph",
      children: [
        {
          properties: {
            font: { ascii: TALL_ASCII, hAnsi: TALL_ASCII, eastAsia: SHORT_CJK },
            size: 24
          },
          content: [{ type: "text", text: "报表Report" }]
        }
      ]
    }) as BodyContent;

  it.each([1, 10, 34, 40, 45, 70, 90, 120])(
    "should agree with the positioned pass for %i paragraphs",
    count => {
      const body = Array.from({ length: count }, mixedParagraph);
      const coarse = layoutDocument({ body }, { measureTextMetrics });
      const positioned = layoutDocumentFull({ body }, { measureTextMetrics });
      // Equality, not just "not fewer": over-reserving is permitted by the doc but
      // would silently drift, and the two measure the same thing now.
      expect(coarse.pageCount).toBe(positioned.pages.length);
    }
  );

  it("should reserve the taller Latin face's ink, not the CJK face's", () => {
    const requested: string[] = [];
    layoutDocument(
      { body: [mixedParagraph()] },
      {
        measureTextMetrics: (text, font, size) => {
          requested.push(font);
          return measureTextMetrics(text, font, size);
        }
      }
    );
    // Both faces are consulted; taking one and hoping was the defect.
    expect(new Set(requested)).toEqual(new Set([TALL_ASCII, SHORT_CJK]));
  });
});
