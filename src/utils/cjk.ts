/**
 * Line-breaking for East Asian text.
 *
 * Every wrapping loop in this repository was written for a script that separates
 * its words with spaces, and each one independently did the same thing:
 *
 * ```ts
 * const words = line.split(/\s+/);   // or /(\s+)/, or a manual space/hyphen scan
 * ```
 *
 * Chinese, Japanese and Korean do not put spaces between words, so a CJK
 * paragraph comes out of that as a *single* token. The consequences were not
 * cosmetic:
 *
 * - An Excel cell with `wrapText: true` reported **one** line no matter how long
 *   the text was, so `autoFitRows` left the row at a single line's height and
 *   Excel clipped the content.
 * - The same text in a PDF table overflowed its cell and never wrapped.
 * - Chart and diagram labels never wrapped.
 * - A Word paragraph became one unbreakable atom, so mixed Chinese/English text
 *   pushed the whole run to the next line and left a hole at the end of the
 *   previous one.
 *
 * This module owns the one rule those callers were missing, and it lives at
 * Layer 0 because all four of them (`excel`, `pdf`, `draw`, `word`) need it and
 * no two of them may import each other.
 *
 * ## Scope: a deliberate subset of UAX #14
 *
 * The Unicode line-breaking algorithm is a pair-table over 40-odd classes. What
 * these callers need is much smaller, and pretending otherwise would be a large
 * amount of machinery producing the same answer:
 *
 * - **A break is allowed between two adjacent ideographs.** That single rule is
 *   what makes CJK wrap at all, and it is the whole fix for the bugs above.
 * - **Kinsoku (禁則) is honoured**: a closing bracket or a full stop may not
 *   begin a line, and an opening bracket may not end one. Without this, wrapping
 *   CJK is worse than not wrapping it — a line starting with `。` or `）` is
 *   immediately visible as broken typesetting, which is why Word, InDesign and
 *   every browser implement it.
 * - Latin behaviour is preserved exactly: break after a space or a hyphen, never
 *   inside a word.
 *
 * Not attempted: hyphenation dictionaries, Thai/Khmer/Lao word segmentation
 * (which needs a dictionary, not a table), and Korean word-level breaking
 * (Hangul is treated as breakable per syllable, which is what browsers do by
 * default for `word-break: normal` on Hangul without spaces).
 *
 * ## The design that makes kinsoku free
 *
 * {@link segmentForWrap} returns the pieces a line may be assembled from, and
 * **glues a prohibited character to the neighbour it must stay with**. So
 * `甲（乙）丙` segments as `["甲", "（乙）", "丙"]`, not as four characters.
 *
 * That matters because it means every existing "accumulate width per token,
 * flush when it overflows" loop gets kinsoku without changing its logic — the
 * prohibition is expressed in the token boundaries rather than as a rule the
 * caller has to remember. Callers that need the raw opportunities instead (the
 * Word layout engine, which measures per atom) can use
 * {@link canBreakBetween} directly.
 */

// Every rule in this module is applied per grapheme cluster, not per code point.
// Per code point is wrong for any character built from more than one: `中` followed
// by U+FE0F, or a base character followed by a combining mark, was split into two
// pieces and — worse — `splitByScript` then handed the base to the East Asian face
// and the mark to the Latin one, so the mark was positioned against the wrong font.
import { graphemeClusters } from "./grapheme";

// =============================================================================
// Character classes
// =============================================================================

/**
 * Code points a line may not **begin** with — closing brackets, sentence-final
 * punctuation, iteration marks, and the small kana.
 *
 * These are glued to the *preceding* segment.
 */
function isProhibitedLineStart(cp: number): boolean {
  // Fast path: the overwhelming majority of characters are ideographs or Latin.
  if (cp < 0x21) {
    return false;
  }

  switch (cp) {
    // --- ASCII / halfwidth closing and terminating ---
    case 0x21: // !
    case 0x25: // %
    case 0x29: // )
    case 0x2c: // ,
    case 0x2e: // .
    case 0x3a: // :
    case 0x3b: // ;
    case 0x3f: // ?
    case 0x5d: // ]
    case 0x7d: // }
    // --- General punctuation ---
    case 0x2013: // – en dash
    case 0x2014: // — em dash (Chinese 破折号; a pair must not be split)
    case 0x2019: // ’
    case 0x201d: // ”
    case 0x2025: // ‥
    case 0x2026: // … ellipsis
    case 0x2030: // ‰
    case 0x2032: // ′
    case 0x2033: // ″
    case 0x203c: // ‼
    case 0x2047: // ⁇
    case 0x2048: // ⁈
    case 0x2049: // ⁉
    case 0x2103: // ℃
    case 0x00b0: // °
    case 0x00a2: // ¢
    case 0x00b7: // ·  middle dot (Chinese interpunct)
      return true;
    default:
      break;
  }

  // --- CJK symbols and punctuation (U+3000–U+303F) ---
  if (cp >= 0x3001 && cp <= 0x303f) {
    switch (cp) {
      case 0x3001: // 、
      case 0x3002: // 。
      case 0x3005: // 々 iteration mark
      case 0x3009: // 〉
      case 0x300b: // 》
      case 0x300d: // 」
      case 0x300f: // 』
      case 0x3011: // 】
      case 0x3015: // 〕
      case 0x3017: // 〗
      case 0x3019: // 〙
      case 0x301b: // 〛
      case 0x301c: // 〜
      case 0x301f: // 〟
      case 0x303b: // 〻
        return true;
      default:
        return false;
    }
  }

  // --- Small kana and kana marks: these attach to the preceding mora ---
  // ぁぃぅぇぉっゃゅょゎ / ァィゥェォッャュョヮ / ーゝゞヽヾ
  switch (cp) {
    case 0x3041: // ぁ
    case 0x3043: // ぃ
    case 0x3045: // ぅ
    case 0x3047: // ぇ
    case 0x3049: // ぉ
    case 0x3063: // っ
    case 0x3083: // ゃ
    case 0x3085: // ゅ
    case 0x3087: // ょ
    case 0x308e: // ゎ
    case 0x3095: // ゕ
    case 0x3096: // ゖ
    case 0x309b: // ゛
    case 0x309c: // ゜
    case 0x309d: // ゝ
    case 0x309e: // ゞ
    case 0x30a1: // ァ
    case 0x30a3: // ィ
    case 0x30a5: // ゥ
    case 0x30a7: // ェ
    case 0x30a9: // ォ
    case 0x30c3: // ッ
    case 0x30e3: // ャ
    case 0x30e5: // ュ
    case 0x30e7: // ョ
    case 0x30ee: // ヮ
    case 0x30f5: // ヵ
    case 0x30f6: // ヶ
    case 0x30fb: // ・
    case 0x30fc: // ー prolonged sound mark
    case 0x30fd: // ヽ
    case 0x30fe: // ヾ
      return true;
    default:
      break;
  }

  // --- Halfwidth and fullwidth forms (U+FF00–U+FFEF) ---
  switch (cp) {
    case 0xff01: // ！
    case 0xff05: // ％
    case 0xff09: // ）
    case 0xff0c: // ，
    case 0xff0e: // ．
    case 0xff1a: // ：
    case 0xff1b: // ；
    case 0xff1f: // ？
    case 0xff3d: // ］
    case 0xff5d: // ｝
    case 0xff60: // ｠
    case 0xff61: // ｡
    case 0xff63: // ｣
    case 0xff64: // ､
    case 0xff65: // ･
    case 0xff70: // ｰ
    case 0xff9e: // ﾞ
    case 0xff9f: // ﾟ
      return true;
    default:
      return false;
  }
}

/**
 * Code points a line may not **end** with — opening brackets and currency signs
 * that bind to the number after them.
 *
 * These are glued to the *following* segment.
 */
function isProhibitedLineEnd(cp: number): boolean {
  if (cp < 0x23) {
    return false;
  }

  switch (cp) {
    // --- ASCII / halfwidth opening ---
    case 0x23: // #
    case 0x24: // $
    case 0x28: // (
    case 0x5b: // [
    case 0x7b: // {
    // --- Currency and quotes that open ---
    case 0x00a3: // £
    case 0x00a5: // ¥
    case 0x20ac: // €
    case 0x2018: // ‘
    case 0x201c: // “
      return true;
    default:
      break;
  }

  // --- CJK opening brackets ---
  switch (cp) {
    case 0x3008: // 〈
    case 0x300a: // 《
    case 0x300c: // 「
    case 0x300e: // 『
    case 0x3010: // 【
    case 0x3014: // 〔
    case 0x3016: // 〖
    case 0x3018: // 〘
    case 0x301a: // 〚
    case 0x301d: // 〝
      return true;
    default:
      break;
  }

  // --- Fullwidth opening ---
  switch (cp) {
    case 0xff03: // ＃
    case 0xff04: // ＄
    case 0xff08: // （
    case 0xff3b: // ［
    case 0xff5b: // ｛
    case 0xff5f: // ｟
    case 0xff62: // ｢
    case 0xffe1: // ￡
    case 0xffe5: // ￥
      return true;
    default:
      return false;
  }
}

/**
 * Whether a break may occur on either side of this code point purely because of
 * what it is — i.e. it is an East Asian character that does not need a space to
 * mark a word boundary.
 *
 * Kana is included: Japanese wraps between mora, with the small kana handled by
 * {@link isProhibitedLineStart}. Hangul syllables are included because text
 * written without spaces would otherwise not wrap at all.
 */
export function isCjkBreakable(cp: number): boolean {
  return (
    // CJK symbols and punctuation, Hiragana, Katakana, Bopomofo, Hangul Compat
    // Jamo, Kanbun, Bopomofo Extended, CJK Strokes, Katakana Phonetic Ext.
    (cp >= 0x3000 && cp <= 0x31ff) ||
    // Enclosed CJK Letters and Months, CJK Compatibility
    (cp >= 0x3200 && cp <= 0x33ff) ||
    // CJK Unified Ideographs Extension A + CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x9fff) ||
    // Yi Syllables and Radicals
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // Hangul Syllables, plus the Jamo that compose them. Decomposed Hangul is
    // still Hangul: leaving `U+1100–11FF` out made a decomposed string one
    // unbreakable atom — it never wrapped, and a justified line containing it
    // counted zero opportunities and was left unstretched. `isHangul` below
    // already included them, so the two disagreed about the same characters.
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    // CJK Compatibility Ideographs
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Vertical forms, CJK Compatibility Forms, Small Form Variants
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    // Fullwidth forms (ideographic space through fullwidth macron)
    (cp >= 0xff01 && cp <= 0xff60) ||
    // Halfwidth katakana
    (cp >= 0xff61 && cp <= 0xffdc) ||
    // Supplementary ideographic planes: Ext. B–I, Compatibility Supplement
    (cp >= 0x20000 && cp <= 0x3ffff)
  );
}

function isWrapSpace(cp: number): boolean {
  return (
    cp === 0x20 || // space
    cp === 0x09 || // tab
    cp === 0x3000 // ideographic space
  );
}

/**
 * Whitespace and joiners that explicitly forbid a break on either side.
 *
 * These exist to *prevent* the break that their neighbours would otherwise
 * allow, so they have to be checked before the ideograph rule — a no-break space
 * between two ideographs was being treated as an ordinary break opportunity, and
 * the callers that trim a line's trailing whitespace then deleted it outright.
 */
function isNoBreakGlue(cp: number): boolean {
  return (
    cp === 0x00a0 || // NO-BREAK SPACE
    cp === 0x202f || // NARROW NO-BREAK SPACE
    cp === 0x2007 || // FIGURE SPACE
    cp === 0x2011 || // NON-BREAKING HYPHEN
    cp === 0x2060 || // WORD JOINER
    cp === 0xfeff // ZERO WIDTH NO-BREAK SPACE (BOM used as WJ)
  );
}

// =============================================================================
// Break opportunities
// =============================================================================

/**
 * Whether a line may be broken between two adjacent code points.
 *
 * Kinsoku is checked first and wins: it is a prohibition, so it overrides the
 * opportunity that the ideograph rule would otherwise grant. Getting this order
 * wrong is what puts a `。` at the start of a line.
 *
 * @param prev - The code point before the candidate break
 * @param next - The code point after the candidate break
 */
export function canBreakBetween(prev: number, next: number): boolean {
  // Explicit no-break glue outranks everything, including the ideograph rule:
  // that is the whole purpose of U+00A0 and U+2060.
  if (isNoBreakGlue(prev) || isNoBreakGlue(next)) {
    return false;
  }

  // Kinsoku: prohibitions next.
  if (isProhibitedLineEnd(prev)) {
    return false;
  }
  if (isProhibitedLineStart(next)) {
    return false;
  }

  // A space always ends a segment, and is kept with the text before it so the
  // width of the space is charged to the line that already fits — which is what
  // Excel does, and what the callers replaced here already did.
  if (isWrapSpace(prev)) {
    return true;
  }
  if (isWrapSpace(next)) {
    return false;
  }

  // Break after a hyphen, never before it.
  if (prev === 0x2d || prev === 0xff0d) {
    return true;
  }
  if (next === 0x2d || next === 0xff0d) {
    return false;
  }

  // The rule this module exists for: adjacent East Asian characters may break.
  // Only one side needs to be East Asian — that is what lets a Latin word
  // butting against an ideograph break between the two.
  return isCjkBreakable(prev) || isCjkBreakable(next);
}

/**
 * Split text into the pieces a line may be assembled from.
 *
 * Every boundary in the result is a legal break point, and every piece is a
 * unit that must not be split further, so a caller wraps by accumulating pieces
 * and flushing when the next one would overflow.
 *
 * Kinsoku is already applied — a character that may not start a line is glued to
 * the piece before it, and one that may not end a line to the piece after it:
 *
 * ```ts
 * segmentForWrap("Hello World");   // ["Hello ", "World"]
 * segmentForWrap("one-two");       // ["one-", "two"]
 * segmentForWrap("中文报表");        // ["中", "文", "报", "表"]
 * segmentForWrap("甲乙丙。丁");      // ["甲", "乙", "丙。", "丁"]
 * segmentForWrap("甲（乙）丙");      // ["甲", "（乙）", "丙"]
 * segmentForWrap("总计 1,234 元");   // ["总", "计 ", "1,234 ", "元"]
 * ```
 *
 * The input must not contain newlines — callers split into paragraphs first,
 * because an explicit break is the author's own and wrapping must not move it.
 */
export function segmentForWrap(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const segments: string[] = [];
  let current = "";
  let prev = -1;

  // Clusters, not code points: a break may only fall on a cluster boundary, so a
  // base character never loses its variation selector or combining marks.
  for (const cluster of graphemeClusters(text)) {
    const cp = cluster.codePointAt(0)!;
    if (prev >= 0 && canBreakBetween(prev, cp)) {
      segments.push(current);
      current = cluster;
    } else {
      current += cluster;
    }
    // Line-breaking class belongs to the base, not to a trailing VS or combining
    // mark. Using the cluster's last code point made `中A` breakable but
    // `中\uFE0FA` and `中\u0301A` unbreakable — the same character lost a legal
    // boundary merely because it selected a glyph variant or carried a mark.
    prev = cp;
  }

  if (current !== "") {
    segments.push(current);
  }
  return segments;
}

/**
 * Whether text contains any character that wraps by the East Asian rule.
 *
 * Lets a caller keep a fast path: text that is entirely Latin needs no
 * segmentation beyond the space-splitting it already did.
 */
export function hasCjk(text: string): boolean {
  for (const char of text) {
    if (isCjkBreakable(char.codePointAt(0)!)) {
      return true;
    }
  }
  return false;
}

/** A maximal stretch of text that is either East Asian or not. */
export interface ScriptRun {
  readonly text: string;
  /** True when this stretch is East Asian and needs the `eastAsia` typeface. */
  readonly cjk: boolean;
}

/**
 * Split text into maximal single-script stretches.
 *
 * A `w:rFonts` element names a different typeface for Latin (`w:ascii`) and for
 * East Asian text (`w:eastAsia`), so `报表 Report` is two typefaces in one run
 * and measuring it with either one alone is wrong. Word resolves this per
 * character; splitting into runs is the same answer with one measurement per
 * stretch instead of per character.
 *
 * Returns a single run for uniform text, so a Latin-only caller pays nothing.
 */
export function splitByScript(text: string): ScriptRun[] {
  if (text.length === 0) {
    return [];
  }
  const runs: ScriptRun[] = [];
  let current = "";
  let currentCjk = false;
  let started = false;

  // Clusters, not code points. A combining mark and a variation selector carry
  // no script of their own, so classifying them individually split `中` from its
  // U+FE0F and sent the two to different typefaces.
  for (const cluster of graphemeClusters(text)) {
    const cjk = isCjkBreakable(cluster.codePointAt(0)!);
    if (!started) {
      current = cluster;
      currentCjk = cjk;
      started = true;
      continue;
    }
    if (cjk === currentCjk) {
      current += cluster;
    } else {
      runs.push({ text: current, cjk: currentCjk });
      current = cluster;
      currentCjk = cjk;
    }
  }
  runs.push({ text: current, cjk: currentCjk });
  return runs;
}

/**
 * Whether a code point is carried by the preceding glyph instead of drawing one.
 *
 * Zero-width joiners and the variation selectors select a glyph or bind their
 * neighbours together; they never receive an advance of their own. Combining
 * marks are deliberately *not* here: a mark that the face has a glyph for is
 * shown, and advances, like any other glyph.
 *
 * This is the same set the PDF font embedder folds into the preceding glyph's
 * sequence, and the single definition both it and the layout consult — they held
 * a copy each, which is how three places came to count the same thing three ways.
 */
export function isGlyphlessControl(codePoint: number): boolean {
  return (
    codePoint === 0x200c || // ZWNJ
    codePoint === 0x200d || // ZWJ
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) // ideographic variation selectors
  );
}

/**
 * Count the glyphs text will be drawn with, which is what `Tc` advances by.
 *
 * PDF character spacing is added after **every glyph shown**, so this is the
 * multiplier for a justified stretch — and the three places that needed it each
 * guessed differently. Counting grapheme clusters under-counted `中` + U+0301,
 * which is drawn as two glyphs; counting code points over-counted `辻` + IVS and
 * `👍` + VS16, which are drawn as one. Either way the layout believed a line was
 * a different width than the renderer drew, and the line missed its margin.
 */
export function countGlyphAdvances(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!isGlyphlessControl(char.codePointAt(0)!)) {
      count++;
    }
  }
  return count;
}

// =============================================================================
// Language detection
// =============================================================================

/**
 * The East Asian written languages that need different glyphs for the same
 * characters.
 *
 * Unicode Han Unification gives one code point to a character shared by Chinese,
 * Japanese and Korean, but the regional forms differ: 「者」has a stroke in
 * Japanese that Simplified Chinese does not, and 「骨」「今」「青」「每」are
 * drawn differently again. So a font chosen purely by *coverage* renders correct
 * text in the wrong hand — which is exactly what happened when `Arial Unicode MS`
 * (whose CJK repertoire is Monotype's Japanese set) was the first candidate
 * tried, and every Chinese document came out subtly wrong.
 */
export type CjkLanguage = "zh-Hans" | "zh-Hant" | "ja" | "ko";

/**
 * ## How the three glyph-form tables are built
 *
 * Each table must contain only characters written **one** way in its language and
 * differently in the other two. A character shared with another language is
 * evidence for nothing, and putting it in a table makes the detector confidently
 * wrong.
 *
 * That rule was broken twice while writing this, in both directions:
 *
 * - Listing "characters simplified in the PRC" ignored that post-war Japanese
 *   simplified many of the same ones — 国, 会, 体, 学, 医, 来, 内, 声, 点 are
 *   Simplified Chinese *and* modern Japanese. `国際会議` scored `zh-Hans`, so
 *   Japanese was drawn with Chinese glyph forms.
 * - Listing "traditional forms" ignored that Japanese kept the traditional shape
 *   of a great many characters — 語, 東, 館, 時, 問, 書, 車, 馬 are Traditional
 *   Chinese *and* everyday modern Japanese. `日本語` scored `zh-Hant`.
 *
 * Both slips survived a careful reading of the tables, so the exclusion is now
 * **executed rather than documented**: {@link SHARED_CJ_FORMS} lists the
 * characters Chinese and Japanese simplified identically, and the two tables that
 * could contain them are filtered through it at module load. Comments cannot be
 * relied on to hold a hand-written list of hundreds of characters correct.
 */

/**
 * Characters that Simplified Chinese and Japanese simplified to the **same**
 * shape.
 *
 * These can never be evidence: they distinguish neither language from the other,
 * only both from Traditional Chinese — which the traditional forms already do.
 */
const SHARED_CJ_FORMS = new Set([
  // Simplified identically by both.
  ..."国会体学医来内声点数断礼恋乱争没尽双与万号台条虫画写区当独表温参",
  // Never simplified by either, so identical in all three — listed because the
  // traditional table would otherwise be tempted to claim them.
  ..."用作動車馬鳥魚門長風飛語東館間書問時者和平多少大小上下中文年月日分"
]);

/**
 * Source strings for the three tables, before {@link SHARED_CJ_FORMS} is applied.
 *
 * Exported for the test that asserts no table *claims* a shared character. The
 * filter alone is not enough: listing a Japanese-only form such as 実 in
 * `SHARED_CJ_FORMS` silently removed it from `JAPANESE_ONLY`, which is the third
 * variant of this same mistake and the reason it is now checked rather than
 * reasoned about.
 *
 * @internal
 */
export const _GLYPH_FORM_SOURCES = {
  simplified: "",
  traditional: "",
  japanese: ""
};

/** Remove anything shared, so a table cannot claim a character it must not. */
function exclusive(chars: string): Set<string> {
  const out = new Set<string>();
  for (const char of chars) {
    if (!SHARED_CJ_FORMS.has(char)) {
      out.add(char);
    }
  }
  return out;
}

/**
 * Simplified Chinese forms, written differently in both Traditional Chinese and
 * Japanese.
 *
 * Japanese generally kept the traditional shape of these, so the simplified form
 * is unique to the PRC: 说/説, 时/時, 问/問, 书/書, 车/車, 马/馬, 东/東, 语/語,
 * 门/門, 长/長, 风/風, 飞/飛. `这` and `么` have no Japanese counterpart at all.
 */
const SIMPLIFIED_ONLY = exclusive(
  (_GLYPH_FORM_SOURCES.simplified =
    "这么说时问间书车马鸟龙鱼东语门长风飞鸡鸭鹅" +
    "们为产儿个义乡买亚亲优传伤价众农历术乐观规视图归录" +
    "动轮报电话译认识边远进过样张单击备药觉带层战广厂丛丝岁" +
    "汉难阳阴云务劳态终纪红级约纸经组织给统绝维绿续网罗联节荣" +
    "设访证评诉词试诗诚误请读课谁调谈谢" +
    "钟钱铁银锁镇闭闻闲阅际陆陈队阶阵" +
    "饭饮饰饱饼馆头颜题实县圆驿济杂龄气劝关验压齿滨简丽")
);

/**
 * Traditional Chinese forms whose **Japanese** counterpart is a different
 * character.
 *
 * Only characters Japanese simplified are listed, so the traditional shape is not
 * shared with it: 實/実, 廣/広, 點/点, 圖/図, 鐵/鉄, 經/経, 與/与, 歲/歳, 對/対,
 * 戰/戦, 樣/様, 單/単, 發/発, 兩/両, 價/価, 氣/気, 觀/観, 關/関, 歸/帰, 驗/験,
 * 讀/読, 譯/訳, 國/国, 體/体, 學/学, 來/来, 會/会.
 *
 * Characters Japanese writes identically (語, 東, 館, 時, 問, 間, 書, 車, 馬, 鳥,
 * 龍, 魚, 門, 長, 風, 飛) are excluded by {@link SHARED_CJ_FORMS} rather than by
 * being left out here, because leaving them out by hand is exactly what failed.
 */
const TRADITIONAL_ONLY = exclusive(
  (_GLYPH_FORM_SOURCES.traditional =
    "實廣點圖鐵經與歲對戰樣單發兩價氣勸觀關歸驗讀譯壓醫齒濱盡" +
    "國體學來內聲數變豐斷禮證雜齡縣圓驛濟歡舊據舉虛峽狹曉驅勳" +
    "徑莖惠揭雞擴殼覺嶽樂渴卷陷龜犧溫謠搖應歐穩畫惡亂假藝擊權獻顯嚴" +
    "們這麼說臺灣號簡麗區寫參賣")
);

/**
 * Shinjitai forms unique to Japanese — used by neither Simplified nor
 * Traditional Chinese.
 *
 * Without these, kana-free Japanese had no positive evidence at all and fell
 * through to whichever Chinese table happened to match. They are what let `実験`,
 * `駅前` or `県庁` identify Japanese on their own.
 */
const JAPANESE_ONLY = exclusive(
  (_GLYPH_FORM_SOURCES.japanese =
    "実県円駅鉄経済蔵雑齢広歳戦様単験読訳価気勧観関帰" +
    "圧悪謡揺応欧穏仮拡殻岳楽渇巻陥歓亀犠旧拠挙虚峡狭暁駆勲" +
    "径茎恵掲鶏芸撃権献顕厳変豊証歯浜" +
    "戯虜隠壊懐拝斎縄嬢壌譲醸嘱触寝慎尋随髄枢瀬繊禅遷薦壮聡")
);

/**
 * The resolved tables, for the test that asserts they are pairwise disjoint.
 *
 * @internal
 */
export const _GLYPH_FORM_TABLES = {
  simplified: SIMPLIFIED_ONLY,
  traditional: TRADITIONAL_ONLY,
  japanese: JAPANESE_ONLY,
  shared: SHARED_CJ_FORMS
};

function isKana(cp: number): boolean {
  return (
    (cp >= 0x3041 && cp <= 0x3096) || // Hiragana
    (cp >= 0x30a1 && cp <= 0x30fa) || // Katakana
    (cp >= 0xff66 && cp <= 0xff9d) // Halfwidth katakana
  );
}

function isHangul(cp: number): boolean {
  return (
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0x1100 && cp <= 0x11ff) || // Jamo
    (cp >= 0x3131 && cp <= 0x318e) // Compatibility Jamo
  );
}

/**
 * Infer the written language of East Asian text, or `undefined` when the text
 * carries no evidence either way.
 *
 * Evidence is **counted, not short-circuited**. The first version returned on the
 * first kana or Hangul it saw, which let a single quoted Japanese character
 * decide the language of an entire Chinese document. Every script and glyph-form
 * signal now contributes to a tally and the largest wins, so a document is
 * classified by what it is mostly made of.
 *
 * Kana and Hangul weigh more than a glyph-form hit because they are unambiguous —
 * neither appears in Chinese at all — while a single simplified or traditional
 * form is weaker evidence that can legitimately appear in the other language's
 * text. A tie, or no evidence at all, is `undefined`: text made only of forms
 * common to all of CJK (a date, a proper noun, `报表`) genuinely has no answer,
 * and saying so lets the caller apply its own default instead of having one
 * guessed here.
 *
 * This is a heuristic over content, so it is a fallback. A caller that knows the
 * language should state it.
 */
export function detectCjkLanguage(text: string): CjkLanguage | undefined {
  const evidence = createCjkLanguageEvidence();
  addCjkLanguageEvidence(evidence, text);
  return concludeCjkLanguage(evidence);
}

/**
 * Weight of one unambiguous script character (kana, Hangul) relative to one
 * glyph-form character.
 *
 * Kana cannot occur in Chinese and Hangul cannot occur in either Chinese or
 * Japanese, so each is worth more than a shared-character form — but only
 * slightly. At a weight of 4, one quoted katakana outweighed three simplified
 * characters and flipped an entire Chinese document to Japanese; a Japanese
 * document has kana on nearly every line, so it does not need a large multiplier
 * to win on volume.
 */
const SCRIPT_EVIDENCE_WEIGHT = 2;

/**
 * Running tally of language evidence, for text that arrives in pieces.
 *
 * The pipelines that need a language never hold the document's text: they walk it
 * once, keeping the *set* of code points they have to find a font for. Handing
 * that set to a detector loses multiplicity — `"国国国國"` becomes one Simplified
 * and one Traditional character and is undecidable — so the evidence is
 * accumulated as the text streams past instead, which costs four counters rather
 * than a second copy of the document.
 *
 * There is deliberately no detector that takes a collection of code points. One
 * existed, every caller passed it a `Set`, and the loss was invisible.
 */
export interface CjkLanguageEvidence {
  ja: number;
  ko: number;
  hans: number;
  hant: number;
}

/** A zeroed tally. */
export function createCjkLanguageEvidence(): CjkLanguageEvidence {
  return { ja: 0, ko: 0, hans: 0, hant: 0 };
}

/** Add every signal in `text` to a running tally. */
export function addCjkLanguageEvidence(evidence: CjkLanguageEvidence, text: string): void {
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (isKana(cp)) {
      evidence.ja += SCRIPT_EVIDENCE_WEIGHT;
      continue;
    }
    if (isHangul(cp)) {
      evidence.ko += SCRIPT_EVIDENCE_WEIGHT;
      continue;
    }
    if (JAPANESE_ONLY.has(char)) {
      evidence.ja++;
    } else if (SIMPLIFIED_ONLY.has(char)) {
      evidence.hans++;
    } else if (TRADITIONAL_ONLY.has(char)) {
      evidence.hant++;
    }
  }
}

/**
 * The language a tally points to, or `undefined` when it is empty or tied.
 *
 * A tie is genuinely undecided — returning either side would be a guess dressed
 * up as a detection.
 */
export function concludeCjkLanguage(evidence: CjkLanguageEvidence): CjkLanguage | undefined {
  const { ja, ko, hans, hant } = evidence;
  const best = Math.max(ja, ko, hans, hant);
  if (best === 0) {
    return undefined;
  }
  if ([ja, ko, hans, hant].filter(n => n === best).length > 1) {
    return undefined;
  }
  if (best === ja) {
    return "ja";
  }
  if (best === ko) {
    return "ko";
  }
  return best === hans ? "zh-Hans" : "zh-Hant";
}

/** A placement unit within a paragraph: `[start, visibleEnd)` offsets into it. */
export interface WrapUnit {
  /** Offset of the unit's first code unit. */
  readonly start: number;
  /**
   * Offset just past the unit's last *visible* code unit.
   *
   * Trailing whitespace belongs to the unit — it is charged when measuring the gap
   * to the next one — but not to the visible line, so it is excluded here.
   */
  readonly visibleEnd: number;
}

/**
 * Split a paragraph into the units a line may be assembled from, as offsets.
 *
 * This is {@link segmentForWrap} for callers that must work in offsets rather than
 * strings, because they carry per-character formatting alongside the text: a
 * spreadsheet's rich-text cell measures each span with its own font, so it cannot
 * reassemble the paragraph into new strings.
 *
 * It exists as one function because the logic had been transcribed twice — the
 * renderer that wraps rich text and the layout pass that predicts how tall the
 * result will be — and updating one copy for East Asian breaking left the other
 * still splitting on whitespace. The two then disagreed about the same cell: the
 * renderer produced eight lines where the height estimate had reserved one, and
 * the text overprinted itself into an unreadable smear. A third caller copying it
 * again would drift the same way.
 *
 * The input must not contain newlines; callers split into paragraphs first.
 */
export function wrapUnitsOf(paragraph: string): WrapUnit[] {
  // Grapheme clusters, not code points, with the break class read from each
  // cluster's *base*. Scanning code points let a break fall inside a cluster, so
  // `中` + U+0301 became two units and a narrow rich-text cell drew the base and
  // its combining mark on separate lines; a variation selector, an ideographic
  // variation sequence and a ZWJ split the same way. `segmentForWrap` has always
  // clustered, so the two disagreed about the same paragraph — which is the one
  // thing this function exists to prevent.
  const starts: number[] = [0];
  let prev = -1;
  let offset = 0;
  for (const cluster of graphemeClusters(paragraph)) {
    const base = cluster.codePointAt(0)!;
    if (prev >= 0 && canBreakBetween(prev, base)) {
      starts.push(offset);
    }
    prev = base;
    offset += cluster.length;
  }

  const units: WrapUnit[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const limit = s + 1 < starts.length ? starts[s + 1] : paragraph.length;
    // `isWrapSpace`, not a literal space-or-tab test: it is the same predicate
    // that decided the break, and it includes the ideographic space. The plain
    // path trims its line with `trimEnd()`, which drops U+3000 — so leaving it in
    // made `\u3000` between ideographs occupy two lines in a rich-text cell and
    // one in a plain one.
    let visibleEnd = limit;
    while (visibleEnd > start && isWrapSpace(paragraph.codePointAt(visibleEnd - 1)!)) {
      visibleEnd--;
    }
    if (visibleEnd === start) {
      continue; // whitespace-only: not a placement unit
    }
    units.push({ start, visibleEnd });
  }
  return units;
}
