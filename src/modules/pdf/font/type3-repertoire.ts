/**
 * Which code points the Type3 path can draw without any embedded face.
 *
 * `@pdf/font/type3-glyphs` and its four companion tables are 27,000 lines, loaded
 * through a dynamic `import()` so a plain-text PDF never bundles them. Two callers
 * need to know the *set* without the outlines, and neither can reach for that import:
 *
 *   - Font discovery decides whether a face that lacks a character is still the right
 *     one. It runs synchronously, and it must not pull the glyph tables into every
 *     bundle that embeds a font.
 *   - Coverage diagnostics decide whether a missing character will be drawn properly
 *     or will show up as a `.notdef` box, which are two different things to tell a
 *     caller.
 *
 * The set is compact enough to state directly: 2,881 code points in five contiguous
 * runs. `system-fonts.test.ts` walks every code point up to `U+2FFFF` and asserts that
 * {@link isType3Drawable} agrees with `lookupGlyph`, so the table cannot drift away
 * from the glyphs it describes without a test failing.
 *
 * @module
 */

const TYPE3_DRAWABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2000, 0x206f], // General Punctuation
  [0x20a0, 0x20cf], // Currency Symbols
  [0x2100, 0x23ff], // Letterlike … Miscellaneous Technical
  [0x2460, 0x2bff], // Enclosed Alphanumerics … Miscellaneous Symbols and Arrows
  [0xfeff, 0xfeff] // Zero width no-break space
];

/** Whether the Type3 path has a real glyph for this code point. */
export function isType3Drawable(codePoint: number): boolean {
  for (const [start, end] of TYPE3_DRAWABLE_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

/**
 * Whether only a real font can draw this code point, so no substitute will do.
 *
 * The inverse of {@link isType3Drawable}, named for the question font discovery asks:
 * it is the rule that lets a Chinese face that happens to lack `☐` still win, because
 * the checkbox is drawn by Type3 and its absence says nothing about whether the face
 * suits the text.
 *
 * It has to be the *exact* Type3 repertoire. Using `isCjkBreakable` for it lost text:
 * that predicate answers "may a line break here", so everything outside East Asian
 * script counted as substitutable — Cyrillic and Greek included. A face covering the
 * Han and nothing else therefore won for `中文报表 Кириллица Ελληνικά`, and the Cyrillic
 * and Greek then reached a Type3 path with no glyph for either: four characters
 * silently became `.notdef` boxes.
 */
export function requiresEmbeddedFace(codePoint: number): boolean {
  return !isType3Drawable(codePoint);
}
