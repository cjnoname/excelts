/**
 * Unicode block names, for diagnostics.
 *
 * When a document contains characters no embedded font covers, the page shows
 * `.notdef` boxes and the only signal a caller gets is a warning listing code
 * points: `U+4E2D, U+6587, U+62A5`. That is a hex dump — it says nothing about
 * *what* is missing, so it cannot tell you which font to add.
 *
 * matplotlib solves the same problem in the glyph itself: since 3.11 it renders
 * missing characters with Unicode's Last Resort font, whose glyphs are boxes with
 * the block's name printed inside. Naming the block is the part that carries the
 * information — "CJK Unified Ideographs" tells you to install a Chinese font,
 * "Arabic" tells you something else entirely — and a warning can carry it without
 * needing a font to draw it.
 *
 * Only assigned ranges that a document realistically contains are listed. An
 * unlisted code point reports its plane instead, which is still more use than a
 * bare number.
 */

interface UnicodeBlock {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/** Sorted by `start`, so a lookup can binary-search. */
const BLOCKS: readonly UnicodeBlock[] = [
  { start: 0x0000, end: 0x007f, name: "Basic Latin" },
  { start: 0x0080, end: 0x00ff, name: "Latin-1 Supplement" },
  { start: 0x0100, end: 0x017f, name: "Latin Extended-A" },
  { start: 0x0180, end: 0x024f, name: "Latin Extended-B" },
  { start: 0x0250, end: 0x02af, name: "IPA Extensions" },
  { start: 0x02b0, end: 0x02ff, name: "Spacing Modifier Letters" },
  { start: 0x0300, end: 0x036f, name: "Combining Diacritical Marks" },
  { start: 0x0370, end: 0x03ff, name: "Greek and Coptic" },
  { start: 0x0400, end: 0x04ff, name: "Cyrillic" },
  { start: 0x0500, end: 0x052f, name: "Cyrillic Supplement" },
  { start: 0x0530, end: 0x058f, name: "Armenian" },
  { start: 0x0590, end: 0x05ff, name: "Hebrew" },
  { start: 0x0600, end: 0x06ff, name: "Arabic" },
  { start: 0x0700, end: 0x074f, name: "Syriac" },
  { start: 0x0780, end: 0x07bf, name: "Thaana" },
  { start: 0x0900, end: 0x097f, name: "Devanagari" },
  { start: 0x0980, end: 0x09ff, name: "Bengali" },
  { start: 0x0a00, end: 0x0a7f, name: "Gurmukhi" },
  { start: 0x0a80, end: 0x0aff, name: "Gujarati" },
  { start: 0x0b00, end: 0x0b7f, name: "Oriya" },
  { start: 0x0b80, end: 0x0bff, name: "Tamil" },
  { start: 0x0c00, end: 0x0c7f, name: "Telugu" },
  { start: 0x0c80, end: 0x0cff, name: "Kannada" },
  { start: 0x0d00, end: 0x0d7f, name: "Malayalam" },
  { start: 0x0d80, end: 0x0dff, name: "Sinhala" },
  { start: 0x0e00, end: 0x0e7f, name: "Thai" },
  { start: 0x0e80, end: 0x0eff, name: "Lao" },
  { start: 0x0f00, end: 0x0fff, name: "Tibetan" },
  { start: 0x1000, end: 0x109f, name: "Myanmar" },
  { start: 0x10a0, end: 0x10ff, name: "Georgian" },
  { start: 0x1100, end: 0x11ff, name: "Hangul Jamo" },
  { start: 0x1200, end: 0x137f, name: "Ethiopic" },
  { start: 0x13a0, end: 0x13ff, name: "Cherokee" },
  { start: 0x1780, end: 0x17ff, name: "Khmer" },
  { start: 0x1800, end: 0x18af, name: "Mongolian" },
  { start: 0x1e00, end: 0x1eff, name: "Latin Extended Additional" },
  { start: 0x1f00, end: 0x1fff, name: "Greek Extended" },
  { start: 0x2000, end: 0x206f, name: "General Punctuation" },
  { start: 0x2070, end: 0x209f, name: "Superscripts and Subscripts" },
  { start: 0x20a0, end: 0x20cf, name: "Currency Symbols" },
  { start: 0x2100, end: 0x214f, name: "Letterlike Symbols" },
  { start: 0x2150, end: 0x218f, name: "Number Forms" },
  { start: 0x2190, end: 0x21ff, name: "Arrows" },
  { start: 0x2200, end: 0x22ff, name: "Mathematical Operators" },
  { start: 0x2300, end: 0x23ff, name: "Miscellaneous Technical" },
  { start: 0x2400, end: 0x243f, name: "Control Pictures" },
  { start: 0x2460, end: 0x24ff, name: "Enclosed Alphanumerics" },
  { start: 0x2500, end: 0x257f, name: "Box Drawing" },
  { start: 0x2580, end: 0x259f, name: "Block Elements" },
  { start: 0x25a0, end: 0x25ff, name: "Geometric Shapes" },
  { start: 0x2600, end: 0x26ff, name: "Miscellaneous Symbols" },
  { start: 0x2700, end: 0x27bf, name: "Dingbats" },
  { start: 0x2800, end: 0x28ff, name: "Braille Patterns" },
  { start: 0x2b00, end: 0x2bff, name: "Miscellaneous Symbols and Arrows" },
  { start: 0x2e80, end: 0x2eff, name: "CJK Radicals Supplement" },
  { start: 0x2f00, end: 0x2fdf, name: "Kangxi Radicals" },
  { start: 0x3000, end: 0x303f, name: "CJK Symbols and Punctuation" },
  { start: 0x3040, end: 0x309f, name: "Hiragana" },
  { start: 0x30a0, end: 0x30ff, name: "Katakana" },
  { start: 0x3100, end: 0x312f, name: "Bopomofo" },
  { start: 0x3130, end: 0x318f, name: "Hangul Compatibility Jamo" },
  { start: 0x3190, end: 0x319f, name: "Kanbun" },
  { start: 0x31f0, end: 0x31ff, name: "Katakana Phonetic Extensions" },
  { start: 0x3200, end: 0x32ff, name: "Enclosed CJK Letters and Months" },
  { start: 0x3300, end: 0x33ff, name: "CJK Compatibility" },
  { start: 0x3400, end: 0x4dbf, name: "CJK Unified Ideographs Extension A" },
  { start: 0x4dc0, end: 0x4dff, name: "Yijing Hexagram Symbols" },
  { start: 0x4e00, end: 0x9fff, name: "CJK Unified Ideographs" },
  { start: 0xa000, end: 0xa48f, name: "Yi Syllables" },
  { start: 0xa960, end: 0xa97f, name: "Hangul Jamo Extended-A" },
  { start: 0xac00, end: 0xd7af, name: "Hangul Syllables" },
  { start: 0xf900, end: 0xfaff, name: "CJK Compatibility Ideographs" },
  { start: 0xfb00, end: 0xfb4f, name: "Alphabetic Presentation Forms" },
  { start: 0xfe10, end: 0xfe1f, name: "Vertical Forms" },
  { start: 0xfe30, end: 0xfe4f, name: "CJK Compatibility Forms" },
  { start: 0xfe50, end: 0xfe6f, name: "Small Form Variants" },
  { start: 0xfe70, end: 0xfeff, name: "Arabic Presentation Forms-B" },
  { start: 0xff00, end: 0xffef, name: "Halfwidth and Fullwidth Forms" },
  { start: 0x1f300, end: 0x1f5ff, name: "Miscellaneous Symbols and Pictographs" },
  { start: 0x1f600, end: 0x1f64f, name: "Emoticons" },
  { start: 0x1f680, end: 0x1f6ff, name: "Transport and Map Symbols" },
  { start: 0x1f900, end: 0x1f9ff, name: "Supplemental Symbols and Pictographs" },
  { start: 0x20000, end: 0x2a6df, name: "CJK Unified Ideographs Extension B" },
  { start: 0x2a700, end: 0x2b73f, name: "CJK Unified Ideographs Extension C" },
  { start: 0x2b740, end: 0x2b81f, name: "CJK Unified Ideographs Extension D" },
  { start: 0x2b820, end: 0x2ceaf, name: "CJK Unified Ideographs Extension E" },
  { start: 0x2ceb0, end: 0x2ebef, name: "CJK Unified Ideographs Extension F" },
  { start: 0x2ebf0, end: 0x2ee5f, name: "CJK Unified Ideographs Extension I" },
  { start: 0x2f800, end: 0x2fa1f, name: "CJK Compatibility Ideographs Supplement" },
  { start: 0x30000, end: 0x3134f, name: "CJK Unified Ideographs Extension G" },
  { start: 0x31350, end: 0x323af, name: "CJK Unified Ideographs Extension H" }
];

/**
 * The name of the Unicode block a code point belongs to.
 *
 * Falls back to the plane for an unlisted code point, which still narrows it
 * down far more than the number alone.
 */
export function unicodeBlockName(codePoint: number): string {
  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const block = BLOCKS[mid];
    if (codePoint < block.start) {
      hi = mid - 1;
    } else if (codePoint > block.end) {
      lo = mid + 1;
    } else {
      return block.name;
    }
  }
  const plane = Math.floor(codePoint / 0x10000);
  switch (plane) {
    case 0:
      return "Basic Multilingual Plane";
    case 1:
      return "Supplementary Multilingual Plane";
    case 2:
    case 3:
      return "Supplementary Ideographic Plane";
    case 14:
      return "Supplementary Special-purpose Plane";
    default:
      return "Private Use / unassigned";
  }
}

/**
 * Summarise code points as a list of block names with counts and one example
 * each, ordered by how many code points fall in each.
 *
 * This is what a diagnostic should say instead of listing hex: `"CJK Unified
 * Ideographs (42, e.g. 中 U+4E2D)"` names the font to install, while
 * `"U+4E2D, U+6587, …"` names nothing.
 *
 * @param codePoints - The code points to describe
 * @param maxBlocks - How many blocks to name before summarising the remainder
 */
export function describeCodePointBlocks(codePoints: Iterable<number>, maxBlocks = 4): string {
  const blocks = new Map<string, { count: number; sample: number }>();
  for (const cp of codePoints) {
    const name = unicodeBlockName(cp);
    const entry = blocks.get(name);
    if (entry === undefined) {
      blocks.set(name, { count: 1, sample: cp });
    } else {
      entry.count++;
      // Keep the lowest code point as the example: it is the most
      // representative, and stable across iteration order.
      if (cp < entry.sample) {
        entry.sample = cp;
      }
    }
  }
  if (blocks.size === 0) {
    return "";
  }

  const ordered = [...blocks.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[1].sample - b[1].sample
  );
  const shown = ordered.slice(0, maxBlocks).map(([name, { count, sample }]) => {
    const hex = `U+${sample.toString(16).toUpperCase().padStart(4, "0")}`;
    return `${name} (${count}, e.g. ${String.fromCodePoint(sample)} ${hex})`;
  });
  const remaining = ordered.length - shown.length;
  return remaining > 0 ? `${shown.join("; ")}; and ${remaining} more block(s)` : shown.join("; ");
}
