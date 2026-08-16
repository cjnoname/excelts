/**
 * Detection of text features this PDF font pipeline does not implement.
 *
 * The embedder maps each code point to one glyph, in logical order, with no
 * substitution or positioning. That is correct for Latin, Greek, Cyrillic, CJK,
 * and most other scripts, but three families of text need more:
 *
 * - **Complex scripts** need OpenType shaping (GSUB/GPOS): Arabic contextual
 *   forms, Indic reordering and conjuncts, Thai mark stacking. Rendering them
 *   one glyph per code point produces disconnected or misordered output.
 * - **Bidirectional text** needs the Unicode Bidi Algorithm to reorder runs;
 *   PDF stores glyphs in visual order, so RTL text comes out reversed.
 * - **Color emoji** live in `COLR`/`CBDT`/`sbix`/`SVG ` tables, which a `glyf`
 *   embedder cannot render; the monochrome outline is used if present.
 *
 * Rather than emit wrong text silently, these are reported through the caller's
 * `onWarning` hook.
 *
 * Script membership is tested with Unicode property escapes rather than
 * hand-written code point ranges: the engine's own Unicode tables are correct
 * by construction and stay current, whereas a hand-rolled range table is a
 * standing source of both misses and false positives.
 */

/** A script whose correct rendering requires OpenType shaping. */
interface ScriptPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const SHAPING_SCRIPTS: readonly ScriptPattern[] = [
  { name: "Arabic", pattern: /\p{Script=Arabic}/u },
  { name: "Syriac", pattern: /\p{Script=Syriac}/u },
  { name: "Thaana", pattern: /\p{Script=Thaana}/u },
  { name: "Mandaic", pattern: /\p{Script=Mandaic}/u },
  { name: "NKo", pattern: /\p{Script=Nko}/u },
  { name: "Adlam", pattern: /\p{Script=Adlam}/u },
  { name: "Devanagari", pattern: /\p{Script=Devanagari}/u },
  { name: "Bengali", pattern: /\p{Script=Bengali}/u },
  { name: "Gurmukhi", pattern: /\p{Script=Gurmukhi}/u },
  { name: "Gujarati", pattern: /\p{Script=Gujarati}/u },
  { name: "Oriya", pattern: /\p{Script=Oriya}/u },
  { name: "Tamil", pattern: /\p{Script=Tamil}/u },
  { name: "Telugu", pattern: /\p{Script=Telugu}/u },
  { name: "Kannada", pattern: /\p{Script=Kannada}/u },
  { name: "Malayalam", pattern: /\p{Script=Malayalam}/u },
  { name: "Sinhala", pattern: /\p{Script=Sinhala}/u },
  { name: "Thai", pattern: /\p{Script=Thai}/u },
  { name: "Lao", pattern: /\p{Script=Lao}/u },
  { name: "Tibetan", pattern: /\p{Script=Tibetan}/u },
  { name: "Myanmar", pattern: /\p{Script=Myanmar}/u },
  { name: "Khmer", pattern: /\p{Script=Khmer}/u },
  { name: "Javanese", pattern: /\p{Script=Javanese}/u },
  { name: "Balinese", pattern: /\p{Script=Balinese}/u },
  { name: "Tifinagh", pattern: /\p{Script=Tifinagh}/u }
];

/**
 * Right-to-left scripts, plus the explicit bidi formatting and isolate controls.
 *
 * `Bidi_Class` is not exposed to property escapes, so the RTL scripts are named
 * individually. Hebrew is here but not in `SHAPING_SCRIPTS` — it needs bidi
 * reordering, not shaping.
 */
const RTL_PATTERN =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Phoenician}\p{Script=Imperial_Aramaic}\p{Script=Kharoshthi}\p{Script=Old_Turkic}\p{Script=Avestan}\p{Script=Hanifi_Rohingya}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Text made only of these needs neither shaping nor reordering. Checking this
 * first means the overwhelmingly common case — Latin, CJK, Cyrillic, Greek and
 * shared punctuation/digits — costs a single scan and skips every script test.
 */
const SIMPLE_TEXT_PATTERN =
  /^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]*$/u;

/** Tables that hold color glyph data. */
const COLOR_TABLE_TAGS = ["COLR", "CBDT", "sbix", "SVG "] as const;

/**
 * Text features seen across a whole document, accumulated as text is routed.
 *
 * Accumulating rather than warning per run keeps a 100k-cell sheet from
 * producing 100k identical warnings.
 */
export class TextFeatureReport {
  private readonly shapingScripts = new Set<string>();
  private readonly colorFontFamilies = new Set<string>();
  private hasBidi = false;

  /** Record the features present in one text run. */
  noteText(text: string): void {
    if (text.length === 0 || SIMPLE_TEXT_PATTERN.test(text)) {
      return;
    }
    if (!this.hasBidi && RTL_PATTERN.test(text)) {
      this.hasBidi = true;
    }
    for (const script of SHAPING_SCRIPTS) {
      // A script already recorded needs no further scanning.
      if (!this.shapingScripts.has(script.name) && script.pattern.test(text)) {
        this.shapingScripts.add(script.name);
      }
    }
  }

  /** Record that an embedded face carries color glyph tables. */
  noteFontTables(familyName: string, tables: ReadonlyMap<string, unknown>): void {
    if (COLOR_TABLE_TAGS.some(tag => tables.has(tag))) {
      this.colorFontFamilies.add(familyName);
    }
  }

  /** Emit one warning per detected feature. */
  report(warn: (message: string) => void): void {
    if (this.shapingScripts.size > 0) {
      warn(
        `Text contains ${[...this.shapingScripts].sort().join(", ")}, which requires ` +
          "OpenType shaping (GSUB/GPOS). This PDF writer maps one glyph per code point, " +
          "so contextual forms, reordering and mark positioning are not applied and the " +
          "text will render incorrectly. Pre-shape the text, or render it as an image."
      );
    }
    if (this.hasBidi) {
      warn(
        "Text contains right-to-left characters. PDF stores glyphs in visual order and " +
          "this writer does not run the Unicode Bidi Algorithm, so right-to-left runs " +
          "will appear in the wrong order. Reorder the text before drawing it."
      );
    }
    if (this.colorFontFamilies.size > 0) {
      warn(
        `Embedded font(s) ${[...this.colorFontFamilies].sort().join(", ")} carry color ` +
          "glyph tables (COLR/CBDT/sbix/SVG), which this writer does not embed. Affected " +
          "characters render as monochrome outlines, or as .notdef when no outline exists."
      );
    }
  }
}
