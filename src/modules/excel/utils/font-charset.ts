/**
 * Windows charset numbers for East Asian typefaces.
 *
 * A `<font>` in `styles.xml` declares its script with `<charset val="…"/>`, and
 * that is how a consumer knows to substitute another East Asian face rather than a
 * Latin one when the named typeface is absent. Excel always writes it — a Chinese
 * Windows Excel stores `name="等线" family="2" charset="134"`.
 *
 * The region mapping itself lives in `@utils/cjk-typefaces`, shared with the Word
 * writer, which needs the same knowledge to decide whether a font name should
 * claim `w:rFonts/@w:eastAsia`. This file is only the region → charset step.
 *
 * The numbers are the Windows `LOGFONT.lfCharSet` values OOXML inherits
 * (ECMA-376 §18.8.18). `styles.xml` writes them in decimal; `fontTable.xml` in a
 * `.docx` writes the same values in hex, so 134 there is 86.
 */

import { eastAsianScriptOf } from "@utils/cjk-typefaces";

/** `SHIFTJIS_CHARSET` (128), `HANGUL_CHARSET` (129), `GB2312_CHARSET` (134), `CHINESEBIG5_CHARSET` (136). */
const CHARSET_BY_SCRIPT = {
  ja: 128,
  ko: 129,
  "zh-Hans": 134,
  "zh-Hant": 136
} as const;

/**
 * The charset a typeface declares, or `undefined` when it declares none.
 *
 * `undefined` covers both a Latin face and a **pan-CJK** one. That second case is
 * deliberate: `Noto Sans CJK`, `Source Han Sans` and `Droid Sans Fallback` cover
 * all four regions, so picking one would assert something the font does not — and
 * a wrong charset biases a consumer's font substitution toward the wrong region,
 * which is the very failure this whole area is about. Omitting the attribute says
 * "not stated", which is true.
 *
 * A Latin face likewise gets nothing rather than an explicit `charset="0"`
 * (`ANSI_CHARSET`): that is a different statement, and a workbook that never
 * carried one should not gain it.
 */
export function inferFontCharset(fontName: string): number | undefined {
  const script = eastAsianScriptOf(fontName);
  return script ? CHARSET_BY_SCRIPT[script] : undefined;
}
