/**
 * The `w:lang` and `w:rFonts/@w:eastAsia` a document's own text implies.
 *
 * Without `w:lang/@w:eastAsia`, Word proofs East Asian text in the *Latin* language:
 * every Chinese word arrives underlined as a spelling mistake, because an English
 * dictionary is being asked about it. Declaring nothing is not neutral — it means
 * `en-US` in practice.
 *
 * Derived from the text rather than assumed, which is what makes it safe to state at
 * all. Hardcoding `zh-CN` in a generic entry point would be wrong for the same reason
 * it was reverted once before: it also serves English, Japanese and Korean documents,
 * and applying Simplified Chinese proofing to Japanese is worse than applying none.
 * With the content in hand this is a statement about it.
 *
 * Shared by the Markdown importer and `Document.build` because it is one fact about
 * one question. Keeping a copy per call site is how the two would drift into
 * disagreeing about the same document.
 *
 * @module
 */

import { detectCjkLanguage, hasCjk } from "@utils/cjk";
import type { FontSpec, RunProperties } from "@word/types";

/**
 * Locale tag and body face per language.
 *
 * The face is the conventional body font for the locale — the one Word itself writes,
 * so the file opens the way a Word-authored document would.
 *
 * It is deliberately *not* the face `@pdf/font/system-fonts` embeds, and the two are
 * answering different questions. A DOCX carries a font *name* that every reader
 * resolves for itself, so the portable choice is the locale's conventional face
 * (`SimSun`), even on a host that does not have it. A PDF carries embedded outlines,
 * so it must name a face that exists *here* — on macOS that is `Songti SC`. Trying to
 * make the two strings equal would mean either naming a macOS-only face in a file
 * meant to travel, or embedding a font the host does not have.
 */
const BY_LANGUAGE = {
  "zh-Hans": { tag: "zh-CN", font: "SimSun" },
  "zh-Hant": { tag: "zh-TW", font: "PMingLiU" },
  ja: { tag: "ja-JP", font: "Yu Gothic" },
  ko: { tag: "ko-KR", font: "Malgun Gothic" }
} as const;

interface EastAsianDefaults {
  readonly language: { readonly val: string; readonly eastAsia: string };
  readonly eastAsiaFont: string;
}

/**
 * What `text` implies, or `undefined` when it contains no East Asian characters.
 *
 * Presence decides *whether* to declare and detection decides *which*: two separate
 * questions, and answering only the second leaves the common case unfixed.
 * `detectCjkLanguage` needs glyph forms that separate Simplified from Traditional, so
 * a short document like `销售业绩概述` is undecidable — and would have gone on being
 * proofed as English, which is the whole bug.
 *
 * Undecidable Han therefore falls back to Simplified Chinese. That is not a coin
 * toss: `selectSystemFont` resolves the identical ambiguity the identical way
 * (`language ?? "zh-Hans"`), citing Chromium's `ComputeScriptForHan`. The two must
 * agree, or a PDF set in a Simplified face would accompany a DOCX claiming Japanese
 * proofing.
 */
export function eastAsianDefaultsFor(text: string): EastAsianDefaults | undefined {
  if (!hasCjk(text)) {
    return undefined;
  }
  const { tag, font } = BY_LANGUAGE[detectCjkLanguage(text) ?? "zh-Hans"];
  return { language: { val: "en-US", eastAsia: tag }, eastAsiaFont: font };
}

/**
 * Merge derived East Asian defaults into run properties, without overwriting anything
 * the caller stated.
 *
 * Field by field: a caller who set `language.eastAsia` has answered the question, and
 * a caller who named an `eastAsia` face has chosen one. Neither is second-guessed.
 */
export function withEastAsianDefaults(
  rPr: RunProperties | undefined,
  derived: EastAsianDefaults
): RunProperties {
  const existing = rPr ?? {};
  const currentFont = existing.font;
  const fontSpec: FontSpec =
    typeof currentFont === "string"
      ? { ascii: currentFont, hAnsi: currentFont, eastAsia: derived.eastAsiaFont }
      : { ...currentFont, eastAsia: currentFont?.eastAsia ?? derived.eastAsiaFont };
  const language = {
    val: existing.language?.val ?? derived.language.val,
    eastAsia: existing.language?.eastAsia ?? derived.language.eastAsia,
    ...(existing.language?.bidi === undefined ? {} : { bidi: existing.language.bidi })
  };
  return { ...existing, font: fontSpec, language };
}
