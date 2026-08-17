/**
 * Standard Font Metrics — shared between Word layout and PDF rendering.
 *
 * Provides width data for the 14 standard PDF fonts (Helvetica, Times, Courier families).
 * Used for text measurement without requiring actual font files.
 *
 * Character widths are specified in 1/1000 of a text unit. To get the actual width
 * of a character at a given font size:
 *   width_in_points = (charWidth / 1000) * fontSize
 *
 * @see PDF Reference 1.7, Appendix D - Standard Type 1 Fonts
 * @see Adobe Font Metrics files (AFM) for canonical widths
 */

// =============================================================================
// Helvetica Metrics (afm data: Helvetica)
// =============================================================================

/**
 * Character widths for ASCII 32-126.
 * Values are in thousandths of a unit of text space.
 */

// prettier-ignore
const HELVETICA_WIDTHS: Record<number, number> = {
  32:278,33:278,34:355,35:556,36:556,37:889,38:667,39:191,40:333,41:333,
  42:389,43:584,44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,
  52:556,53:556,54:556,55:556,56:556,57:556,58:278,59:278,60:584,61:584,
  62:584,63:556,64:1015,65:667,66:667,67:722,68:722,69:667,70:611,71:778,
  72:722,73:278,74:500,75:667,76:556,77:833,78:722,79:778,80:667,81:778,
  82:722,83:667,84:611,85:722,86:667,87:944,88:667,89:667,90:611,91:278,
  92:278,93:278,94:469,95:556,96:333,97:556,98:556,99:500,100:556,101:556,
  102:278,103:556,104:556,105:222,106:222,107:500,108:222,109:833,110:556,
  111:556,112:556,113:556,114:333,115:500,116:278,117:556,118:500,119:722,
  120:500,121:500,122:500,123:334,124:260,125:334,126:584
};

// prettier-ignore
const HELVETICA_BOLD_WIDTHS: Record<number, number> = {
  32:278,33:333,34:474,35:556,36:556,37:889,38:722,39:238,40:333,41:333,
  42:389,43:584,44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,
  52:556,53:556,54:556,55:556,56:556,57:556,58:333,59:333,60:584,61:584,
  62:584,63:611,64:975,65:722,66:722,67:722,68:722,69:667,70:611,71:778,
  72:722,73:278,74:556,75:722,76:611,77:833,78:722,79:778,80:667,81:778,
  82:722,83:667,84:611,85:722,86:667,87:944,88:667,89:667,90:611,91:333,
  92:278,93:333,94:584,95:556,96:333,97:556,98:611,99:556,100:611,101:556,
  102:333,103:611,104:611,105:278,106:278,107:556,108:278,109:889,110:611,
  111:611,112:611,113:611,114:389,115:556,116:333,117:611,118:556,119:778,
  120:556,121:556,122:500,123:389,124:280,125:389,126:584
};

// prettier-ignore
const TIMES_ROMAN_WIDTHS: Record<number, number> = {
  32:250,33:333,34:408,35:500,36:500,37:833,38:778,39:180,40:333,41:333,
  42:500,43:564,44:250,45:333,46:250,47:278,48:500,49:500,50:500,51:500,
  52:500,53:500,54:500,55:500,56:500,57:500,58:278,59:278,60:564,61:564,
  62:564,63:444,64:921,65:722,66:667,67:667,68:722,69:611,70:556,71:722,
  72:722,73:333,74:389,75:722,76:611,77:889,78:722,79:722,80:556,81:722,
  82:667,83:556,84:611,85:722,86:722,87:944,88:722,89:722,90:611,91:333,
  92:278,93:333,94:469,95:500,96:333,97:444,98:500,99:444,100:500,101:444,
  102:333,103:500,104:500,105:278,106:278,107:500,108:278,109:778,110:500,
  111:500,112:500,113:500,114:333,115:389,116:278,117:500,118:500,119:722,
  120:500,121:500,122:444,123:480,124:200,125:480,126:541
};

// prettier-ignore
const TIMES_BOLD_WIDTHS: Record<number, number> = {
  32:250,33:333,34:555,35:500,36:500,37:1000,38:833,39:278,40:333,41:333,
  42:500,43:570,44:250,45:333,46:250,47:278,48:500,49:500,50:500,51:500,
  52:500,53:500,54:500,55:500,56:500,57:500,58:333,59:333,60:570,61:570,
  62:570,63:500,64:930,65:722,66:667,67:722,68:722,69:667,70:611,71:778,
  72:778,73:389,74:500,75:778,76:667,77:944,78:722,79:778,80:611,81:778,
  82:722,83:556,84:667,85:722,86:722,87:1000,88:722,89:722,90:667,91:333,
  92:278,93:333,94:581,95:500,96:333,97:500,98:556,99:444,100:556,101:444,
  102:333,103:500,104:556,105:278,106:333,107:556,108:278,109:833,110:556,
  111:500,112:556,113:556,114:444,115:389,116:333,117:556,118:500,119:722,
  120:500,121:500,122:444,123:394,124:220,125:394,126:520
};

// Courier is monospaced - every character is 600 units wide
const COURIER_WIDTH = 600;

// =============================================================================
// Font Descriptor Data
// =============================================================================

/**
 * Font descriptor data for ascent, descent, and other metrics.
 * Values are in font units (1/1000 of a text unit).
 */
interface FontDescriptor {
  ascent: number;
  descent: number;
  capHeight: number;
  avgWidth: number;
  widths: Record<number, number> | null; // null for monospaced
  monoWidth?: number;
}

const FONT_DESCRIPTORS: Record<string, FontDescriptor> = {
  Helvetica: {
    ascent: 718,
    descent: -207,
    capHeight: 718,
    avgWidth: 513,
    widths: HELVETICA_WIDTHS
  },
  "Helvetica-Bold": {
    ascent: 718,
    descent: -207,
    capHeight: 718,
    avgWidth: 535,
    widths: HELVETICA_BOLD_WIDTHS
  },
  "Helvetica-Oblique": {
    ascent: 718,
    descent: -207,
    capHeight: 718,
    avgWidth: 513,
    widths: HELVETICA_WIDTHS // same widths as regular
  },
  "Helvetica-BoldOblique": {
    ascent: 718,
    descent: -207,
    capHeight: 718,
    avgWidth: 535,
    widths: HELVETICA_BOLD_WIDTHS
  },
  "Times-Roman": {
    ascent: 683,
    descent: -217,
    capHeight: 662,
    avgWidth: 478,
    widths: TIMES_ROMAN_WIDTHS
  },
  "Times-Bold": {
    ascent: 683,
    descent: -217,
    capHeight: 676,
    avgWidth: 505,
    widths: TIMES_BOLD_WIDTHS
  },
  "Times-Italic": {
    ascent: 683,
    descent: -217,
    capHeight: 653,
    avgWidth: 478,
    widths: TIMES_ROMAN_WIDTHS // approximate
  },
  "Times-BoldItalic": {
    ascent: 683,
    descent: -217,
    capHeight: 669,
    avgWidth: 505,
    widths: TIMES_BOLD_WIDTHS // approximate
  },
  Courier: {
    ascent: 629,
    descent: -157,
    capHeight: 562,
    avgWidth: 600,
    widths: null,
    monoWidth: COURIER_WIDTH
  },
  "Courier-Bold": {
    ascent: 629,
    descent: -157,
    capHeight: 562,
    avgWidth: 600,
    widths: null,
    monoWidth: COURIER_WIDTH
  },
  "Courier-Oblique": {
    ascent: 629,
    descent: -157,
    capHeight: 562,
    avgWidth: 600,
    widths: null,
    monoWidth: COURIER_WIDTH
  },
  "Courier-BoldOblique": {
    ascent: 629,
    descent: -157,
    capHeight: 562,
    avgWidth: 600,
    widths: null,
    monoWidth: COURIER_WIDTH
  }
};

// =============================================================================
// Font Name Mapping
// =============================================================================

/**
 * Maps common font family names to the closest standard PDF font.
 */
const FONT_FAMILY_MAP: Record<string, string> = {
  // Sans-serif → Helvetica
  helvetica: "Helvetica",
  arial: "Helvetica",
  calibri: "Helvetica",
  "segoe ui": "Helvetica",
  "trebuchet ms": "Helvetica",
  verdana: "Helvetica",
  tahoma: "Helvetica",
  "gill sans": "Helvetica",
  "franklin gothic": "Helvetica",
  "lucida sans": "Helvetica",
  aptos: "Helvetica",
  // Serif → Times-Roman
  "times new roman": "Times-Roman",
  times: "Times-Roman",
  georgia: "Times-Roman",
  garamond: "Times-Roman",
  "book antiqua": "Times-Roman",
  palatino: "Times-Roman",
  "palatino linotype": "Times-Roman",
  cambria: "Times-Roman",
  "century schoolbook": "Times-Roman",
  // Monospace → Courier
  "courier new": "Courier",
  courier: "Courier",
  consolas: "Courier",
  "lucida console": "Courier",
  monaco: "Courier",
  "andale mono": "Courier",
  "cascadia code": "Courier",
  "cascadia mono": "Courier",
  menlo: "Courier"
};

// =============================================================================
// Public API
// =============================================================================

/**
 * BMP code points with a default emoji presentation, which Unicode gives East
 * Asian Width `W`.
 *
 * They sit inside otherwise-narrow blocks (Miscellaneous Symbols, Dingbats), so
 * a block-level range would make arrows and typographic symbols full-width too.
 */
function isWideBmpEmoji(cp: number): boolean {
  return (
    (cp >= 0x231a && cp <= 0x231b) || // watch, hourglass
    (cp >= 0x23e9 && cp <= 0x23ec) || // fast-forward … fast down
    cp === 0x23f0 || // alarm clock
    cp === 0x23f3 || // hourglass flowing sand
    (cp >= 0x25fd && cp <= 0x25fe) || // small squares
    (cp >= 0x2614 && cp <= 0x2615) || // umbrella with rain, hot beverage
    (cp >= 0x2648 && cp <= 0x2653) || // zodiac
    cp === 0x267f || // wheelchair
    cp === 0x2693 || // anchor
    cp === 0x26a1 || // high voltage
    (cp >= 0x26aa && cp <= 0x26ab) || // medium circles
    (cp >= 0x26bd && cp <= 0x26be) || // soccer, baseball
    (cp >= 0x26c4 && cp <= 0x26c5) || // snowman, sun behind cloud
    cp === 0x26ce || // ophiuchus
    cp === 0x26d4 || // no entry
    cp === 0x26ea || // church
    (cp >= 0x26f2 && cp <= 0x26f3) || // fountain, golf
    cp === 0x26f5 || // sailboat
    cp === 0x26fa || // tent
    cp === 0x26fd || // fuel pump
    cp === 0x2705 || // white heavy check mark
    (cp >= 0x270a && cp <= 0x270b) || // raised fist, raised hand
    cp === 0x2728 || // sparkles
    cp === 0x274c || // cross mark
    cp === 0x274e || // negative squared cross mark
    (cp >= 0x2753 && cp <= 0x2755) || // question / exclamation marks
    cp === 0x2757 || // heavy exclamation
    (cp >= 0x2795 && cp <= 0x2797) || // heavy plus / minus / division
    cp === 0x27b0 || // curly loop
    cp === 0x27bf || // double curly loop
    (cp >= 0x2b1b && cp <= 0x2b1c) || // black / white large square
    cp === 0x2b50 || // white medium star
    cp === 0x2b55 // heavy large circle
  );
}

/**
 * Whether a code point is East Asian Wide or Fullwidth, i.e. drawn one em wide.
 *
 * Every real font advances an ideograph, a kana, a Hangul syllable or a
 * fullwidth form by a full em, independently of the Latin face that was asked
 * for — a renderer that cannot draw them substitutes a face that can. Measuring
 * them with a Latin average width (~0.5 em) therefore understates a CJK run by
 * about half, and text positioned from that measurement collides with whatever
 * follows it.
 *
 * Ranges follow Unicode's East Asian Width property (values `W` and `F`).
 */
export function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo initial consonants
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals, Kangxi, CJK Symbols
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // Kana, Bopomofo, Kanbun, Enclosed CJK
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
    (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Extended-A
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // Vertical Forms
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK Compatibility / Small Forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth Forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth Signs
    // BMP symbols whose East Asian Width is W because they have an emoji
    // presentation by default (watches, zodiac, ball games, ✨, ❌, ⭐ …). The
    // surrounding blocks are narrow, so these have to be listed rather than
    // spanned.
    isWideBmpEmoji(codePoint) ||
    // Emoji and pictographs. `U+1F300–U+1FAFF` covers Misc Symbols and
    // Pictographs through Symbols and Pictographs Extended-A in one span,
    // which is what keeps rockets and hearts the same width as smileys.
    (codePoint >= 0x1f004 && codePoint <= 0x1f004) || // Mahjong red dragon
    (codePoint >= 0x1f0cf && codePoint <= 0x1f0cf) || // Playing card black joker
    (codePoint >= 0x1f18e && codePoint <= 0x1f18e) || // Negative squared AB
    (codePoint >= 0x1f191 && codePoint <= 0x1f19a) || // Squared CL … VS
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) || // Regional indicators (flags)
    (codePoint >= 0x1f200 && codePoint <= 0x1f2ff) || // Enclosed CJK / ideographic supplement
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // Emoji: pictographs through Ext-A
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) || // CJK Extension B–F
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) // CJK Extension G+
  );
}

/**
 * Whether a code point advances the pen by nothing at all.
 *
 * Joiners, variation selectors and other zero-width formatting characters shape
 * the glyphs around them; they are not glyphs. Charging each one an average
 * character width measured a four-person family emoji — one glyph — as five and
 * a half characters wide, which threw off every wrap and page break after it.
 */
export function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200b || // zero width space
    codePoint === 0x200c || // zero width non-joiner
    codePoint === 0x200d || // zero width joiner
    codePoint === 0x2060 || // word joiner
    codePoint === 0xfeff || // zero width no-break space (BOM)
    (codePoint >= 0x200e && codePoint <= 0x200f) || // LRM / RLM
    (codePoint >= 0x202a && codePoint <= 0x202e) || // bidi embedding / override
    (codePoint >= 0x2066 && codePoint <= 0x2069) || // bidi isolates
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || // variation selectors 1–16
    (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritical marks
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) // variation selectors supplement
  );
}

/** One em, in the thousandths-of-a-unit scale these metrics use. */
const FULL_WIDTH = 1000;

/**
 * Get the width of a character in a given font.
 * @param charCode - Unicode code point (or char code)
 * @param fontName - PDF standard font name
 * @returns Width in thousandths of a unit
 */
export function getCharWidth(charCode: number, fontName: string): number {
  // Zero-width formatting characters advance nothing.
  if (isZeroWidthCodePoint(charCode)) {
    return 0;
  }
  // Full-width code points are one em regardless of the requested family: the
  // standard-14 faces have no glyph for them, so whatever face the renderer
  // substitutes decides the advance, and that advance is a full em.
  if (isFullWidthCodePoint(charCode)) {
    return FULL_WIDTH;
  }
  const desc = FONT_DESCRIPTORS[fontName];
  if (!desc) {
    // Fall back to Helvetica
    return getCharWidth(charCode, "Helvetica");
  }
  if (desc.monoWidth !== undefined) {
    return desc.monoWidth;
  }
  return desc.widths?.[charCode] ?? desc.avgWidth;
}

/**
 * Measure the width of a text string in the given font and size.
 *
 * Iterates by code point, not UTF-16 code unit: counting a surrogate pair twice
 * would double the measured width of every astral character (emoji, rare CJK).
 *
 * @param text - The string to measure
 * @param fontName - PDF standard font name
 * @param fontSize - Font size in points
 * @returns Width in points
 */
export function measureTextWidth(text: string, fontName: string, fontSize: number): number {
  let totalWidth = 0;
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!;
    if (codePoint > 0xffff) {
      i++; // skip the low surrogate
    }
    totalWidth += getCharWidth(codePoint, fontName);
  }
  return (totalWidth / 1000) * fontSize;
}

/**
 * Get the font ascent for a given font and size.
 * @param fontName - PDF standard font name
 * @param fontSize - Font size in points
 * @returns Ascent in points (positive, distance above baseline)
 */
export function getFontAscent(fontName: string, fontSize: number): number {
  const desc = FONT_DESCRIPTORS[fontName] ?? FONT_DESCRIPTORS["Helvetica"];
  return (desc.ascent / 1000) * fontSize;
}

/**
 * Get the font descent for a given font and size.
 * @param fontName - PDF standard font name
 * @param fontSize - Font size in points
 * @returns Descent in points (positive value representing distance below baseline)
 */
export function getFontDescent(fontName: string, fontSize: number): number {
  const desc = FONT_DESCRIPTORS[fontName] ?? FONT_DESCRIPTORS["Helvetica"];
  return (desc.descent / 1000) * fontSize;
}

/**
 * Get the total line height (ascent - descent) for a font.
 * @param fontName - PDF standard font name
 * @param fontSize - Font size in points
 * @returns Line height in points
 */
export function getLineHeight(fontName: string, fontSize: number): number {
  const desc = FONT_DESCRIPTORS[fontName] ?? FONT_DESCRIPTORS["Helvetica"];
  return ((desc.ascent - desc.descent) / 1000) * fontSize;
}

/**
 * Check if a font name is a known standard PDF font.
 */
export function isStandardFont(fontName: string): boolean {
  return fontName in FONT_DESCRIPTORS;
}

/**
 * Get all supported standard font names.
 */
export function getStandardFontNames(): string[] {
  return Object.keys(FONT_DESCRIPTORS);
}

/**
 * Map common font names (like "Arial", "Calibri") to closest standard font.
 * Returns the input unchanged if it's already a standard font name.
 * Falls back to "Helvetica" for unknown fonts.
 */
export function mapToStandardFont(fontName: string): string {
  // If it's already a standard font, return as-is
  if (fontName in FONT_DESCRIPTORS) {
    return fontName;
  }
  const lower = fontName.toLowerCase().trim();
  return FONT_FAMILY_MAP[lower] ?? "Helvetica";
}

/**
 * Given a standard PDF base font and bold/italic flags, return the matching
 * metric variant name (e.g. "Helvetica" + bold → "Helvetica-Bold"). This keeps
 * width measurement consistent with the glyphs that are actually drawn, so
 * bold/italic runs are measured with their true (wider) metrics rather than
 * the regular ones. Falls back to the base name when a variant is unknown.
 */
export function styledFontVariant(baseFont: string, bold?: boolean, italic?: boolean): string {
  const std = mapToStandardFont(baseFont);
  if (!bold && !italic) {
    return std;
  }

  // Determine the family from the resolved standard name.
  const isTimes = std.startsWith("Times");
  const isCourier = std.startsWith("Courier");

  let candidate: string;
  if (isTimes) {
    // Times family uses -Roman / -Bold / -Italic / -BoldItalic.
    if (bold && italic) {
      candidate = "Times-BoldItalic";
    } else if (bold) {
      candidate = "Times-Bold";
    } else {
      candidate = "Times-Italic";
    }
  } else {
    // Helvetica / Courier families use -Bold / -Oblique / -BoldOblique.
    const family = isCourier ? "Courier" : "Helvetica";
    if (bold && italic) {
      candidate = `${family}-BoldOblique`;
    } else if (bold) {
      candidate = `${family}-Bold`;
    } else {
      candidate = `${family}-Oblique`;
    }
  }

  return candidate in FONT_DESCRIPTORS ? candidate : std;
}
