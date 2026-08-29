import { describe, it, expect } from "vitest";

import { describeCodePointBlocks, unicodeBlockName } from "../unicode-blocks";

const cp = (s: string): number => s.codePointAt(0)!;

describe("unicodeBlockName", () => {
  it("should name the CJK blocks a Chinese document reaches", () => {
    expect(unicodeBlockName(cp("中"))).toBe("CJK Unified Ideographs");
    expect(unicodeBlockName(cp("，"))).toBe("Halfwidth and Fullwidth Forms");
    expect(unicodeBlockName(cp("。"))).toBe("CJK Symbols and Punctuation");
    expect(unicodeBlockName(cp("あ"))).toBe("Hiragana");
    expect(unicodeBlockName(cp("ア"))).toBe("Katakana");
    expect(unicodeBlockName(cp("한"))).toBe("Hangul Syllables");
    expect(unicodeBlockName(cp("㐀"))).toBe("CJK Unified Ideographs Extension A");
  });

  it("should name supplementary-plane ideographs", () => {
    expect(unicodeBlockName(0x20000)).toBe("CJK Unified Ideographs Extension B");
    expect(unicodeBlockName(0x2a700)).toBe("CJK Unified Ideographs Extension C");
  });

  it("should name non-CJK blocks", () => {
    expect(unicodeBlockName(cp("A"))).toBe("Basic Latin");
    expect(unicodeBlockName(cp("é"))).toBe("Latin-1 Supplement");
    expect(unicodeBlockName(cp("Я"))).toBe("Cyrillic");
    expect(unicodeBlockName(cp("α"))).toBe("Greek and Coptic");
    expect(unicodeBlockName(cp("ا"))).toBe("Arabic");
    expect(unicodeBlockName(cp("ท"))).toBe("Thai");
    expect(unicodeBlockName(cp("→"))).toBe("Arrows");
    expect(unicodeBlockName(cp("★"))).toBe("Miscellaneous Symbols");
    expect(unicodeBlockName(0x1f600)).toBe("Emoticons");
  });

  it("should fall back to the plane for an unlisted code point", () => {
    expect(unicodeBlockName(0x0870)).toBe("Basic Multilingual Plane");
    expect(unicodeBlockName(0xe0000)).toBe("Supplementary Special-purpose Plane");
    expect(unicodeBlockName(0xf0000)).toBe("Private Use / unassigned");
  });

  it("should be correct at every block boundary it lists", () => {
    // A binary search over ranges is easy to get wrong by one at the edges.
    expect(unicodeBlockName(0x4dff)).toBe("Yijing Hexagram Symbols");
    expect(unicodeBlockName(0x4e00)).toBe("CJK Unified Ideographs");
    expect(unicodeBlockName(0x9fff)).toBe("CJK Unified Ideographs");
    expect(unicodeBlockName(0xa000)).toBe("Yi Syllables");
  });
});

describe("describeCodePointBlocks", () => {
  // The point of this function: a warning listing `U+4E2D, U+6587, U+62A5` says
  // how many characters are missing but not what they are, so it cannot tell the
  // author which font to install.
  it("should name the block, its count and an example", () => {
    const out = describeCodePointBlocks([cp("中"), cp("文"), cp("报")]);
    expect(out).toContain("CJK Unified Ideographs");
    expect(out).toContain("(3,");
    expect(out).toMatch(/U\+[0-9A-F]{4}/);
  });

  it("should order blocks by how many code points fall in each", () => {
    const out = describeCodePointBlocks([cp("中"), cp("文"), cp("报"), cp("→")]);
    expect(out.indexOf("CJK Unified Ideographs")).toBeLessThan(out.indexOf("Arrows"));
  });

  it("should summarise the tail rather than list every block", () => {
    const out = describeCodePointBlocks(
      [cp("中"), cp("あ"), cp("한"), cp("Я"), cp("α"), cp("ا"), cp("ท")],
      3
    );
    expect(out).toMatch(/and \d+ more block\(s\)/);
  });

  it("should use a stable example — the lowest code point in the block", () => {
    const a = describeCodePointBlocks([cp("文"), cp("中")]);
    const b = describeCodePointBlocks([cp("中"), cp("文")]);
    expect(a).toBe(b);
    expect(a).toContain("中"); // U+4E2D < U+6587
  });

  it("should return an empty string for no code points", () => {
    expect(describeCodePointBlocks([])).toBe("");
  });
});
