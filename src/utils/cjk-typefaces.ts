/**
 * Which East Asian script a typeface is for.
 *
 * Two separate places need this and neither may import the other: the Word writer
 * decides whether a bare font name should claim `w:rFonts/@w:eastAsia`, and the
 * Excel writer decides which `<charset>` a `<font>` declares. Keeping one table at
 * Layer 0 is what stops the two from drifting.
 *
 * ## What this is not
 *
 * A name is not a guarantee. This answers "is this typeface intended for East
 * Asian text, and for which region" from its family name alone, which is the only
 * information available at serialisation time — no font file is open. It is used
 * for *declarations* (an OOXML attribute) and never to decide whether a glyph can
 * actually be drawn; that question is answered by reading a font's `cmap`.
 *
 * Localized names are listed alongside the English ones because the localized
 * form is what a host application writes: a Chinese Windows Excel stores 微软雅黑,
 * never "Microsoft YaHei".
 */

import type { CjkLanguage } from "./cjk";

/**
 * Family names to the script they are drawn for.
 *
 * Pan-CJK families are deliberately **absent**: `Noto Sans CJK`, `Source Han
 * Sans` and `Droid Sans Fallback` cover all four regions, so claiming any single
 * one of them would be a fabrication — and for Excel would emit a `<charset>`
 * asserting something the font does not say. They resolve to `undefined`, which
 * callers treat as "East Asian, region unknown" through
 * {@link isEastAsianTypeface}.
 */
const SCRIPT_BY_FAMILY: Readonly<Record<string, CjkLanguage>> = {
  // --- Simplified Chinese ---
  simsun: "zh-Hans",
  宋体: "zh-Hans",
  nsimsun: "zh-Hans",
  新宋体: "zh-Hans",
  simhei: "zh-Hans",
  黑体: "zh-Hans",
  dengxian: "zh-Hans",
  等线: "zh-Hans",
  "dengxian light": "zh-Hans",
  "microsoft yahei": "zh-Hans",
  微软雅黑: "zh-Hans",
  "microsoft yahei ui": "zh-Hans",
  "微软雅黑 ui": "zh-Hans",
  fangsong: "zh-Hans",
  仿宋: "zh-Hans",
  kaiti: "zh-Hans",
  楷体: "zh-Hans",
  simkai: "zh-Hans",
  simfang: "zh-Hans",
  youyuan: "zh-Hans",
  幼圆: "zh-Hans",
  lisu: "zh-Hans",
  隶书: "zh-Hans",
  stsong: "zh-Hans",
  华文宋体: "zh-Hans",
  stheiti: "zh-Hans",
  华文细黑: "zh-Hans",
  stkaiti: "zh-Hans",
  华文楷体: "zh-Hans",
  stfangsong: "zh-Hans",
  华文仿宋: "zh-Hans",
  "pingfang sc": "zh-Hans",
  "苹方-简": "zh-Hans",
  "heiti sc": "zh-Hans",
  "songti sc": "zh-Hans",
  "kaiti sc": "zh-Hans",
  "yuanti sc": "zh-Hans",
  "lantinghei sc": "zh-Hans",
  "hiragino sans gb": "zh-Hans",
  "noto sans sc": "zh-Hans",
  "noto serif sc": "zh-Hans",
  "wenquanyi micro hei": "zh-Hans",
  "wenquanyi zen hei": "zh-Hans",
  文泉驿微米黑: "zh-Hans",

  // --- Traditional Chinese ---
  pmingliu: "zh-Hant",
  新細明體: "zh-Hant",
  mingliu: "zh-Hant",
  細明體: "zh-Hant",
  "microsoft jhenghei": "zh-Hant",
  微軟正黑體: "zh-Hant",
  "microsoft jhenghei ui": "zh-Hant",
  "dfkai-sb": "zh-Hant",
  標楷體: "zh-Hant",
  "pingfang tc": "zh-Hant",
  "pingfang hk": "zh-Hant",
  "蘋方-繁": "zh-Hant",
  "heiti tc": "zh-Hant",
  "songti tc": "zh-Hant",
  "kaiti tc": "zh-Hant",
  "yuanti tc": "zh-Hant",
  "lihei pro": "zh-Hant",
  "lisong pro": "zh-Hant",
  biaukai: "zh-Hant",
  "apple ligothic": "zh-Hant",
  "apple lisung": "zh-Hant",
  "noto sans tc": "zh-Hant",
  "noto serif tc": "zh-Hant",

  // --- Japanese ---
  "ms gothic": "ja",
  "ｍｓ ゴシック": "ja",
  "ms pgothic": "ja",
  "ｍｓ pゴシック": "ja",
  "ms mincho": "ja",
  "ｍｓ 明朝": "ja",
  "ms pmincho": "ja",
  meiryo: "ja",
  メイリオ: "ja",
  "meiryo ui": "ja",
  "yu gothic": "ja",
  游ゴシック: "ja",
  "yu gothic ui": "ja",
  "yu mincho": "ja",
  游明朝: "ja",
  osaka: "ja",
  "hiragino kaku gothic pron": "ja",
  "ヒラギノ角ゴ pron w3": "ja",
  "hiragino sans": "ja",
  "hiragino mincho pron": "ja",
  "hiragino maru gothic pron": "ja",
  "biz udgothic": "ja",
  "biz udmincho": "ja",
  klee: "ja",
  "noto sans jp": "ja",
  "noto serif jp": "ja",
  ipagothic: "ja",
  ipaexgothic: "ja",

  // --- Korean ---
  "malgun gothic": "ko",
  "맑은 고딕": "ko",
  batang: "ko",
  바탕: "ko",
  gulim: "ko",
  굴림: "ko",
  dotum: "ko",
  돋움: "ko",
  gungsuh: "ko",
  "apple sd gothic neo": "ko",
  applegothic: "ko",
  applemyungjo: "ko",
  nanumgothic: "ko",
  "nanum gothic": "ko",
  나눔고딕: "ko",
  nanummyeongjo: "ko",
  "noto sans kr": "ko",
  "noto serif kr": "ko"
};

/**
 * Pan-CJK families: East Asian, but not for any one region.
 *
 * Listed separately so {@link isEastAsianTypeface} can say yes while
 * {@link eastAsianScriptOf} correctly says "which region" is unanswerable.
 */
const PAN_CJK_FAMILIES: ReadonlySet<string> = new Set([
  "noto sans cjk sc",
  "noto sans cjk tc",
  "noto sans cjk jp",
  "noto sans cjk kr",
  "noto sans cjk hk",
  "noto serif cjk sc",
  "noto serif cjk tc",
  "noto serif cjk jp",
  "noto serif cjk kr",
  "source han sans",
  "source han sans sc",
  "source han sans tc",
  "source han sans hc",
  "source han sans j",
  "source han sans k",
  "source han sans cn",
  "source han serif",
  "source han serif sc",
  "思源黑体",
  "思源宋体",
  "droid sans fallback",
  "arial unicode ms"
]);

function normalize(fontName: string): string {
  return fontName.trim().toLowerCase();
}

/**
 * The region a typeface is drawn for, or `undefined` when it is not East Asian or
 * is pan-CJK.
 */
export function eastAsianScriptOf(fontName: string): CjkLanguage | undefined {
  return SCRIPT_BY_FAMILY[normalize(fontName)];
}

/**
 * Whether a typeface is intended for East Asian text at all.
 *
 * The Word writer uses this to decide whether a bare `{ font: "…" }` should claim
 * `w:rFonts/@w:eastAsia`. A Latin family must not: pointing ideographs at
 * `Calibri Light` or `Courier New` — which the built-in heading styles and HTML
 * import respectively pass — replaces the inherited East Asian face with one that
 * has no CJK glyphs at all.
 */
export function isEastAsianTypeface(fontName: string): boolean {
  const key = normalize(fontName);
  return key in SCRIPT_BY_FAMILY || PAN_CJK_FAMILIES.has(key);
}
