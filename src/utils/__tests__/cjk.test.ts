import { describe, it, expect } from "vitest";

import {
  _GLYPH_FORM_SOURCES,
  _GLYPH_FORM_TABLES,
  addCjkLanguageEvidence,
  canBreakBetween,
  concludeCjkLanguage,
  createCjkLanguageEvidence,
  detectCjkLanguage,
  hasCjk,
  isCjkBreakable,
  segmentForWrap,
  splitByScript,
  wrapUnitsOf
} from "../cjk";

const cp = (s: string): number => s.codePointAt(0)!;

describe("segmentForWrap — Latin behaviour is preserved", () => {
  // These four cases are the documented behaviour of the space/hyphen scanner
  // this module replaced in `excel/utils/text-metrics.ts`.
  it("should break after a space, keeping the space with the text before it", () => {
    expect(segmentForWrap("Hello World")).toEqual(["Hello ", "World"]);
  });

  it("should keep a run of spaces as its own segment", () => {
    expect(segmentForWrap("a  b")).toEqual(["a ", " ", "b"]);
  });

  it("should break after a hyphen, never before", () => {
    expect(segmentForWrap("one-two-three")).toEqual(["one-", "two-", "three"]);
  });

  it("should never break inside a Latin word", () => {
    expect(segmentForWrap("unbreakable")).toEqual(["unbreakable"]);
  });

  it("should treat a tab as a break opportunity", () => {
    expect(segmentForWrap("a\tb")).toEqual(["a\t", "b"]);
  });

  it("should return an empty list for empty input", () => {
    expect(segmentForWrap("")).toEqual([]);
  });
});

describe("segmentForWrap — the bug this module fixes", () => {
  // Before this module, every wrapping loop split on whitespace, so a CJK
  // paragraph was one token: an Excel cell reported one line however long the
  // text, and PDF/chart labels overflowed without wrapping.
  it("should break between adjacent ideographs", () => {
    expect(segmentForWrap("中文报表")).toEqual(["中", "文", "报", "表"]);
  });

  it("should segment a long Chinese sentence into per-character pieces", () => {
    const text = "这是一段很长的中文文本需要在单元格里自动换行显示出来";
    const segments = segmentForWrap(text);
    // 26 characters, none of them kinsoku-glued.
    expect(segments).toHaveLength(26);
    expect(segments.join("")).toBe(text);
  });

  it("should break between kana", () => {
    expect(segmentForWrap("かなカナ")).toEqual(["か", "な", "カ", "ナ"]);
  });

  it("should break between Hangul syllables", () => {
    expect(segmentForWrap("한국어")).toEqual(["한", "국", "어"]);
  });

  it("should break at the boundary between Latin and an ideograph", () => {
    expect(segmentForWrap("PDF导出")).toEqual(["PDF", "导", "出"]);
  });

  it("should never lose or reorder input", () => {
    for (const text of [
      "中文报表 2024",
      "Mixed 混排 ABC 123 中文 abc",
      "总计：￥1,234.56 元（含税）",
      "甲乙丙。丁戊己！庚辛",
      "「引用」『引用』【标题】",
      "ひらがな、カタカナ。漢字！",
      "a  b\tc-d 中文"
    ]) {
      expect(segmentForWrap(text).join("")).toBe(text);
    }
  });
});

describe("segmentForWrap — kinsoku (禁則)", () => {
  // A line beginning with 。 or ） is immediately visible as broken typesetting,
  // which is why wrapping CJK without kinsoku is worse than not wrapping it.
  it("should glue sentence-final punctuation to the preceding character", () => {
    expect(segmentForWrap("甲乙丙。丁")).toEqual(["甲", "乙", "丙。", "丁"]);
    expect(segmentForWrap("甲乙，丙")).toEqual(["甲", "乙，", "丙"]);
    expect(segmentForWrap("甲乙、丙")).toEqual(["甲", "乙、", "丙"]);
    expect(segmentForWrap("甲乙？丙")).toEqual(["甲", "乙？", "丙"]);
    expect(segmentForWrap("甲乙！丙")).toEqual(["甲", "乙！", "丙"]);
    expect(segmentForWrap("甲乙：丙")).toEqual(["甲", "乙：", "丙"]);
    expect(segmentForWrap("甲乙；丙")).toEqual(["甲", "乙；", "丙"]);
  });

  it("should keep a bracketed group whole at both ends", () => {
    expect(segmentForWrap("甲（乙）丙")).toEqual(["甲", "（乙）", "丙"]);
    expect(segmentForWrap("甲「乙」丙")).toEqual(["甲", "「乙」", "丙"]);
    expect(segmentForWrap("甲【乙】丙")).toEqual(["甲", "【乙】", "丙"]);
    expect(segmentForWrap("甲《乙》丙")).toEqual(["甲", "《乙》", "丙"]);
  });

  it("should not split a doubled dash or ellipsis", () => {
    // 破折号 and 省略号 are written as pairs in Chinese; splitting one is wrong.
    expect(segmentForWrap("甲——乙")).toEqual(["甲——", "乙"]);
    expect(segmentForWrap("甲……乙")).toEqual(["甲……", "乙"]);
  });

  it("should keep a currency sign with the number it introduces", () => {
    expect(segmentForWrap("计￥5元")).toEqual(["计", "￥5", "元"]);
  });

  it("should glue small kana to the preceding mora", () => {
    // きょ is one mora, so the small ょ belongs with き — not with the う after it.
    expect(segmentForWrap("きょう")).toEqual(["きょ", "う"]);
    expect(segmentForWrap("ちょっと")).toEqual(["ちょっ", "と"]);
  });

  it("should glue the prolonged sound mark to the preceding kana", () => {
    expect(segmentForWrap("コーヒー")).toEqual(["コー", "ヒー"]);
  });

  it("should glue a percent sign and degree symbol to the number", () => {
    expect(segmentForWrap("增长20%了")).toEqual(["增", "长", "20%", "了"]);
    expect(segmentForWrap("温度30℃时")).toEqual(["温", "度", "30℃", "时"]);
  });

  it("should never produce a segment starting with a prohibited character", () => {
    const text = "报表（2024年度）：营业额、毛利率与增长趋势。附录——数据来源……完";
    for (const seg of segmentForWrap(text)) {
      const first = seg.codePointAt(0)!;
      // A prohibited-start character may only appear as a segment's first
      // character when the segment is the very first of the paragraph.
      if (seg !== segmentForWrap(text)[0]) {
        expect(
          [0x3002, 0x3001, 0xff0c, 0xff09, 0x300d, 0x2026, 0x2014].includes(first),
          `segment ${JSON.stringify(seg)} starts with a prohibited character`
        ).toBe(false);
      }
    }
  });

  it("should never produce a segment ending with a prohibited character", () => {
    const text = "报表（2024）「引用」【标题】《书名》";
    for (const seg of segmentForWrap(text)) {
      const chars = [...seg];
      const last = chars[chars.length - 1].codePointAt(0)!;
      expect(
        [0xff08, 0x300c, 0x3010, 0x300a].includes(last),
        `segment ${JSON.stringify(seg)} ends with a prohibited character`
      ).toBe(false);
    }
  });
});

describe("canBreakBetween", () => {
  it("should let a prohibition override the ideograph opportunity", () => {
    // Both sides are East Asian, so the ideograph rule alone would allow it.
    expect(canBreakBetween(cp("丙"), cp("。"))).toBe(false);
    expect(canBreakBetween(cp("（"), cp("乙"))).toBe(false);
    expect(canBreakBetween(cp("甲"), cp("乙"))).toBe(true);
  });

  it("should not break inside Latin", () => {
    expect(canBreakBetween(cp("a"), cp("b"))).toBe(false);
  });

  it("should break after but not before a space", () => {
    expect(canBreakBetween(cp(" "), cp("a"))).toBe(true);
    expect(canBreakBetween(cp("a"), cp(" "))).toBe(false);
  });
});

describe("isCjkBreakable", () => {
  it("should accept the ranges that wrap per character", () => {
    for (const c of ["中", "文", "あ", "ア", "한", "㈱", "㐀", "豈", "！", "。"]) {
      expect(isCjkBreakable(cp(c)), c).toBe(true);
    }
  });

  it("should accept supplementary-plane ideographs", () => {
    expect(isCjkBreakable(0x20000)).toBe(true); // Ext. B
    expect(isCjkBreakable(0x2a6df)).toBe(true);
  });

  it("should reject Latin, Cyrillic and Greek", () => {
    for (const c of ["A", "z", "0", "-", " ", "Я", "α", "é"]) {
      expect(isCjkBreakable(cp(c)), c).toBe(false);
    }
  });
});

describe("hasCjk", () => {
  it("should detect East Asian text", () => {
    expect(hasCjk("中文")).toBe(true);
    expect(hasCjk("report 报表")).toBe(true);
    expect(hasCjk("ひらがな")).toBe(true);
  });

  it("should reject pure Latin", () => {
    expect(hasCjk("plain ASCII text 123")).toBe(false);
    expect(hasCjk("")).toBe(false);
  });
});

describe("detectCjkLanguage", () => {
  it("should settle Japanese on a single kana", () => {
    expect(detectCjkLanguage("これは日本語です")).toBe("ja");
    expect(detectCjkLanguage("カタカナ")).toBe("ja");
    // One kana beside otherwise Chinese-looking Han text is still decisive.
    expect(detectCjkLanguage("日本語の報告書です")).toBe("ja");
  });

  it("should settle Korean on Hangul", () => {
    expect(detectCjkLanguage("이것은한국어입니다")).toBe("ko");
    expect(detectCjkLanguage("한국")).toBe("ko");
  });

  it("should tell Simplified from Traditional Chinese", () => {
    expect(detectCjkLanguage("这是简体中文的报表内容")).toBe("zh-Hans");
    expect(detectCjkLanguage("這是繁體中文的報表內容")).toBe("zh-Hant");
    expect(detectCjkLanguage("国家开门问学习")).toBe("zh-Hans");
    expect(detectCjkLanguage("國家開門問學習")).toBe("zh-Hant");
  });

  it("should report no evidence for characters common to all of CJK", () => {
    // 「直骨今次令包」are Han-unified: same code points everywhere, different
    // shapes. Nothing in the text says which hand to draw them in.
    expect(detectCjkLanguage("直骨今次令包")).toBeUndefined();
    expect(detectCjkLanguage("2024")).toBeUndefined();
    expect(detectCjkLanguage("")).toBeUndefined();
    expect(detectCjkLanguage("plain latin")).toBeUndefined();
  });

  it("should decide by weight of evidence when a document mixes forms", () => {
    // 说/說 are genuinely exclusive; 国 is not (Japanese writes it the same way),
    // so it carries no evidence and cannot be used to test weighting.
    expect(detectCjkLanguage("说说说說")).toBe("zh-Hans");
    expect(detectCjkLanguage("說說說说")).toBe("zh-Hant");
  });

  it("should count multiplicity, not mere presence", () => {
    // The PDF pipelines used to hand a `Set` to the detector, which reduced every
    // document to "does this character occur at all" and made this undecidable.
    const evidence = createCjkLanguageEvidence();
    addCjkLanguageEvidence(evidence, "说说说說");
    expect(evidence.hans).toBe(3);
    expect(evidence.hant).toBe(1);
    expect(concludeCjkLanguage(evidence)).toBe("zh-Hans");
  });

  it("should never mistake kana-free Japanese for Chinese", () => {
    // The failure that motivated the rewrite: 国, 会, 体, 学, 医 are Simplified
    // Chinese *and* modern Japanese, so listing them scored 国際会議 as zh-Hans
    // and Japanese was then drawn with Chinese glyph forms.
    for (const text of [
      "国際会議",
      "会社案内",
      "医学部",
      "体育館",
      "日本語",
      "東京都",
      "株式会社"
    ]) {
      const got = detectCjkLanguage(text);
      expect(got === undefined || got === "ja", `${text} -> ${got}`).toBe(true);
    }
  });

  it("should identify Japanese from shinjitai alone", () => {
    for (const text of ["実験結果", "駅前広場", "経済産業省"]) {
      expect(detectCjkLanguage(text), text).toBe("ja");
    }
  });

  it("should not let one quoted kana decide a Chinese document", () => {
    expect(detectCjkLanguage("这是一份很长的简体中文文档ア")).toBe("zh-Hans");
  });
});

describe("glyph-form tables", () => {
  // Hand-written lists of hundreds of characters cannot be kept correct by
  // comment. Two separate slips shipped before this was executed instead:
  // Simplified forms Japanese shares, then traditional forms Japanese shares.
  const detectFor = (chars: string): Array<string | undefined> =>
    [...chars].map(c => detectCjkLanguage(c));

  it("should classify each table's members as exactly that language", () => {
    // One character from each table decides on its own, and never the wrong way.
    for (const [chars, want] of [
      ["这么说时问书车马东语门长风飞简丽压齿", "zh-Hans"],
      ["實廣點圖鐵經與歲對戰樣單發兩價氣這麼說臺灣號", "zh-Hant"],
      ["実県円駅鉄経済蔵雑齢広歳戦様単験読訳価気", "ja"]
    ] as const) {
      for (const [i, got] of detectFor(chars).entries()) {
        expect(got, `${[...chars][i]} -> ${got}, expected ${want}`).toBe(want);
      }
    }
  });

  it("should treat characters shared by Chinese and Japanese as no evidence", () => {
    // These are simplified identically in both, so they distinguish nothing.
    for (const char of "国会体学医来内声点数断礼恋乱争没尽双与万号台条虫画") {
      expect(detectCjkLanguage(char), char).toBeUndefined();
    }
  });

  it("should treat characters Japanese writes traditionally as no evidence", () => {
    for (const char of "語東館時問間書車馬鳥龍魚門長風飛") {
      expect(detectCjkLanguage(char), char).toBeUndefined();
    }
  });

  it("should keep the three tables pairwise disjoint", () => {
    const { simplified, traditional, japanese } = _GLYPH_FORM_TABLES;
    const pairs: Array<[string, Set<string>, string, Set<string>]> = [
      ["simplified", simplified, "traditional", traditional],
      ["simplified", simplified, "japanese", japanese],
      ["traditional", traditional, "japanese", japanese]
    ];
    for (const [aName, a, bName, b] of pairs) {
      const both = [...a].filter(c => b.has(c));
      expect(both, `${aName} ∩ ${bName} = ${both.join("")}`).toEqual([]);
    }
  });

  it("should not list a shared character in any table's source", () => {
    // This is the assertion that catches the mistake made three times while
    // writing these tables. `exclusive()` filters shared characters out, so a
    // table claiming one fails *silently* — listing the Japanese-only form 実 as
    // shared removed it from JAPANESE_ONLY and Japanese stopped being detectable.
    // Only the pre-filter sources can reveal the contradiction.
    const { shared } = _GLYPH_FORM_TABLES;
    for (const [name, source] of Object.entries(_GLYPH_FORM_SOURCES)) {
      const claimed = [...new Set(source)].filter(c => shared.has(c));
      expect(claimed, `${name} claims shared character(s): ${claimed.join("")}`).toEqual([]);
    }
  });

  it("should have non-empty tables after filtering", () => {
    // A future over-broad `SHARED_CJ_FORMS` could empty a table and silently
    // disable detection for that language.
    for (const [name, table] of Object.entries(_GLYPH_FORM_TABLES)) {
      expect(table.size, name).toBeGreaterThan(20);
    }
  });

  it("should agree with an incrementally accumulated tally", () => {
    // The pipelines accumulate as text streams past rather than keeping a copy.
    for (const text of ["这是简体中文", "這是繁體中文", "かな", "한글", "直骨今"]) {
      const evidence = createCjkLanguageEvidence();
      for (const char of text) {
        addCjkLanguageEvidence(evidence, char);
      }
      expect(concludeCjkLanguage(evidence), text).toBe(detectCjkLanguage(text));
    }
  });
});

describe("splitByScript", () => {
  it("should split at every script boundary", () => {
    expect(splitByScript("报表Report")).toEqual([
      { text: "报表", cjk: true },
      { text: "Report", cjk: false }
    ]);
    expect(splitByScript("a中b")).toEqual([
      { text: "a", cjk: false },
      { text: "中", cjk: true },
      { text: "b", cjk: false }
    ]);
  });

  it("should return a single run for uniform text", () => {
    expect(splitByScript("Report")).toEqual([{ text: "Report", cjk: false }]);
    expect(splitByScript("报表")).toEqual([{ text: "报表", cjk: true }]);
  });

  it("should be lossless", () => {
    for (const text of ["报表Report 2024", "Mixed 混排 abc", "ひらがなabc漢字"]) {
      expect(
        splitByScript(text)
          .map(r => r.text)
          .join("")
      ).toBe(text);
    }
  });

  it("should return nothing for empty input", () => {
    expect(splitByScript("")).toEqual([]);
  });
});

describe("grapheme clusters", () => {
  // Every rule used to be applied per code point, so a base character was split
  // from its variation selector or combining mark — and `splitByScript` then sent
  // the two to different typefaces.
  it("should keep a variation selector with its base character", () => {
    expect(segmentForWrap("中\uFE0F文")).toEqual(["中\uFE0F", "文"]);
    expect(splitByScript("中\uFE0F文")).toEqual([{ text: "中\uFE0F文", cjk: true }]);
  });

  it("should keep a combining mark with its base character", () => {
    expect(segmentForWrap("中\u0301文")).toEqual(["中\u0301", "文"]);
    expect(splitByScript("中\u0301文")).toEqual([{ text: "中\u0301文", cjk: true }]);
  });

  it("should keep emoji sequences whole", () => {
    expect(segmentForWrap("👩‍👩‍👧‍👦")).toEqual(["👩‍👩‍👧‍👦"]);
    expect(segmentForWrap("🇨🇳")).toEqual(["🇨🇳"]);
    expect(segmentForWrap("👍🏽")).toEqual(["👍🏽"]);
  });
});

describe("no-break glue", () => {
  // These characters exist to forbid the break their neighbours would allow, so
  // they must outrank the ideograph rule. They did not, and the callers that trim
  // trailing whitespace then deleted them outright.
  it("should never break at a no-break space or joiner", () => {
    for (const glue of ["\u00A0", "\u202F", "\u2007", "\u2011", "\u2060"]) {
      expect(segmentForWrap(`中${glue}文`), JSON.stringify(glue)).toEqual([`中${glue}文`]);
    }
  });

  it("should still break at an ideographic space", () => {
    // U+3000 is ordinary breakable whitespace, unlike the glue above.
    expect(segmentForWrap("中\u3000文")).toEqual(["中\u3000", "文"]);
  });

  it("should not break Latin either side of a no-break space", () => {
    expect(segmentForWrap("10\u00A0kg")).toEqual(["10\u00A0kg"]);
  });
});

describe("decomposed Hangul", () => {
  // `isCjkBreakable` omitted the Jamo block while `isHangul` included it, so the
  // two disagreed about the same characters: a decomposed Hangul string became one
  // unbreakable atom that never wrapped, and a justified line containing it
  // counted zero opportunities and was left unstretched.
  const DECOMPOSED = "\u1112\u1161\u11ab\u1100\u116e\u11a8"; // 한국

  it("should treat Jamo as breakable", () => {
    for (const cp of [0x1100, 0x1161, 0x11a8, 0xa960, 0xd7b0]) {
      expect(isCjkBreakable(cp), `U+${cp.toString(16)}`).toBe(true);
    }
  });

  it("should wrap decomposed Hangul", () => {
    expect(segmentForWrap(DECOMPOSED).length).toBeGreaterThan(1);
    expect(segmentForWrap(DECOMPOSED).join("")).toBe(DECOMPOSED);
  });

  it("should agree with the precomposed form about being Hangul", () => {
    expect(detectCjkLanguage(DECOMPOSED)).toBe("ko");
    expect(detectCjkLanguage("한국")).toBe("ko");
  });
});

describe("wrapUnitsOf", () => {
  // Same break opportunities as `segmentForWrap`, expressed as offsets for callers
  // that carry per-character formatting alongside the text and so cannot rebuild
  // the paragraph into new strings. The two must never disagree: one decides how
  // tall a rich-text cell is and the other decides where its lines actually break,
  // and when they drifted the text overprinted itself.
  const unitsAsText = (text: string): string[] =>
    wrapUnitsOf(text).map(u => text.slice(u.start, u.visibleEnd));

  /** `segmentForWrap` reduced to visible units, which is what `wrapUnitsOf` returns. */
  const segmentsAsText = (text: string): string[] =>
    segmentForWrap(text)
      .map(s => s.replace(/[ \t\u3000]+$/u, ""))
      .filter(s => s !== "");

  it.each([
    ["中\u0301文"],
    ["中\uFE0F文"],
    ["中\u{E0100}文"],
    ["中\u200d文"],
    ["甲\u0301乙"],
    ["x\u0301\u0302y"],
    ["👩‍👩‍👧‍👦中"],
    ["🇨🇳中"],
    ["𠀀𠀁"],
    ["甲　乙"],
    ["甲　乙　丙"],
    ["中　"],
    ["　中"],
    ["a b"],
    ["a  b"],
    ["a\t b"],
    ["a\u00A0b"],
    ["one-two"],
    ["中。文"],
    ["（甲）乙"],
    ["ﬁ中"]
  ])("should agree with segmentForWrap on %j", text => {
    expect(unitsAsText(text)).toEqual(segmentsAsText(text));
  });

  it("should never break inside a grapheme cluster", () => {
    // Scanning code points put a boundary between a base and its combining mark,
    // so a narrow rich-text cell drew `中` and its accent on separate lines.
    expect(unitsAsText("中\u0301文")).toEqual(["中\u0301", "文"]);
    expect(unitsAsText("中\uFE0F文")).toEqual(["中\uFE0F", "文"]);
  });

  it("should exclude a trailing ideographic space from the visible unit", () => {
    // The plain path trims with `trimEnd()`, which drops U+3000. Keeping it made
    // the same text wrap differently in a rich-text cell.
    expect(unitsAsText("甲　乙")).toEqual(["甲", "乙"]);
  });

  it("should report offsets that index back into the paragraph", () => {
    const text = "中\u0301文A";
    for (const unit of wrapUnitsOf(text)) {
      expect(unit.visibleEnd).toBeGreaterThan(unit.start);
      expect(unit.visibleEnd).toBeLessThanOrEqual(text.length);
    }
  });
});
