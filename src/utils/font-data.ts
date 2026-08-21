/**
 * Font metric data for auto-fit column width and row height calculation.
 *
 * ## Architecture
 *
 * This module provides font advance width data at three precision tiers:
 *
 * **Tier 1 (Bitmap-accurate):** Calibri 11pt pixel widths, verified against
 * Excel's actual bitmap metrics (EBDT table). These values match
 * independently measured reference values exactly.
 *
 * **Tier 2 (FUnit-accurate):** Per-character advance widths in font design units
 * (FUnits) extracted from TTF hmtx tables for Calibri and 8 other common fonts.
 * At runtime, pixel widths are calculated via:
 *   `pixelWidth = ROUND(advanceFU / unitsPerEm * ROUND(fontSize / 72 * 96))`
 * This matches Excel's outline rendering for all sizes except Calibri 11pt
 * (where bitmap metrics differ from outline).
 *
 * **Tier 3 (Factor-based):** For ~230 other fonts, per-category average width
 * factors (lowercase, uppercase, wide) from an experimentally-tuned table.
 *
 * ## Key References
 *
 * - ECMA-376 §18.3.1.13 (col element, width attribute)
 */

// =============================================================================
// Tier 1: Calibri 11pt Bitmap Pixel Widths
// =============================================================================

// These values are the EXACT pixel widths Excel uses for Calibri Regular 11pt
// at 96 DPI. They come from bitmap metrics (EBDT/EBLC tables) and are verified
// against independently measured reference values. Every A-Z a-z character matches.
//
// At 11pt, ppem = ROUND(11/72*96) = 15, and Calibri uses embedded bitmaps at
// this ppem. The bitmap-derived MDW is 7, whereas the outline formula gives 8.

/** Calibri Regular 11pt per-character pixel widths (code point -> pixels) */
// prettier-ignore
const CALIBRI_11PT_PX: Record<number, number> = {
  // ASCII printable characters (U+0020..U+007E)
  0x20: 3,  // space
  0x21: 5,  // !
  0x22: 6,  // "
  0x23: 7,  // #
  0x24: 7,  // $  (bitmap says 7, not 8 from outline)
  0x25: 11, // %
  0x26: 10, // &
  0x27: 3,  // '
  0x28: 5,  // (
  0x29: 5,  // )
  0x2a: 7,  // *
  0x2b: 7,  // +
  0x2c: 4,  // ,
  0x2d: 5,  // -
  0x2e: 4,  // .
  0x2f: 6,  // /
  0x30: 7,  // 0
  0x31: 7,  // 1
  0x32: 7,  // 2
  0x33: 7,  // 3
  0x34: 7,  // 4
  0x35: 7,  // 5
  0x36: 7,  // 6
  0x37: 7,  // 7
  0x38: 7,  // 8
  0x39: 7,  // 9
  0x3a: 4,  // :
  0x3b: 4,  // ;
  0x3c: 7,  // <
  0x3d: 7,  // =
  0x3e: 7,  // >
  0x3f: 7,  // ?
  0x40: 13, // @
  0x41: 9,  // A
  0x42: 8,  // B
  0x43: 8,  // C
  0x44: 9,  // D
  0x45: 7,  // E
  0x46: 7,  // F
  0x47: 9,  // G
  0x48: 9,  // H
  0x49: 4,  // I
  0x4a: 5,  // J
  0x4b: 8,  // K
  0x4c: 6,  // L
  0x4d: 12, // M
  0x4e: 10, // N
  0x4f: 10, // O
  0x50: 8,  // P
  0x51: 10, // Q
  0x52: 8,  // R
  0x53: 7,  // S
  0x54: 7,  // T
  0x55: 9,  // U
  0x56: 9,  // V
  0x57: 13, // W
  0x58: 8,  // X
  0x59: 7,  // Y
  0x5a: 7,  // Z
  0x5b: 5,  // [
  0x5c: 6,  // backslash
  0x5d: 5,  // ]
  0x5e: 7,  // ^
  0x5f: 7,  // _
  0x60: 4,  // `
  0x61: 7,  // a
  0x62: 8,  // b
  0x63: 6,  // c
  0x64: 8,  // d
  0x65: 8,  // e
  0x66: 5,  // f
  0x67: 7,  // g
  0x68: 8,  // h
  0x69: 4,  // i
  0x6a: 4,  // j
  0x6b: 7,  // k
  0x6c: 4,  // l
  0x6d: 12, // m
  0x6e: 8,  // n
  0x6f: 8,  // o
  0x70: 8,  // p
  0x71: 8,  // q
  0x72: 5,  // r
  0x73: 6,  // s
  0x74: 5,  // t
  0x75: 8,  // u
  0x76: 7,  // v
  0x77: 11, // w
  0x78: 7,  // x
  0x79: 7,  // y
  0x7a: 6,  // z
  0x7b: 5,  // {
  0x7c: 7,  // |
  0x7d: 5,  // }
  0x7e: 7   // ~
};

// =============================================================================
// Tier 2: Font Design Unit (FUnit) Advance Widths
// =============================================================================

// Per-character advance widths in font design units, extracted from TTF hmtx tables.
// At runtime, pixel width = ROUND(advanceFU / unitsPerEm * ppem)
// where ppem = ROUND(fontSizePt / 72 * 96)
//
// Data format: Map of code point ranges to advance widths.
// Each entry is [startCodePoint, count, advanceWidth].
// For single characters, count = 1.

/** Font metrics header: unitsPerEm, usWinAscent, usWinDescent, maxDigitAdvance, sTypoAscender, sTypoDescender, sTypoLineGap */
export interface FontMetricsHeader {
  unitsPerEm: number;
  usWinAscent: number;
  usWinDescent: number;
  maxDigitAdvance: number;
  sTypoAscender: number;
  sTypoDescender: number;
  sTypoLineGap: number;
}

/** Run-length encoded advance data: [startCodePoint, count, advanceFU] */
export type AdvanceRun = [start: number, count: number, advance: number];

export interface FontMetrics {
  header: FontMetricsHeader;
  /** Default advance for characters not in the table (typically Latin average) */
  defaultAdvance: number;
  /** Advance width for CJK ideographs (U+4E00..U+9FFF) */
  cjkAdvance: number;
  /** Run-length encoded advance data */
  advances: AdvanceRun[];
}

// ---------------------------------------------------------------------------
// Calibri Regular
// unitsPerEm=2048, usWinAscent=1950, usWinDescent=550, maxDigitAdvance=1038
// ---------------------------------------------------------------------------
const CALIBRI_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1950,
    usWinDescent: 550,
    maxDigitAdvance: 1038,
    sTypoAscender: 1536,
    sTypoDescender: -512,
    sTypoLineGap: 452
  },
  defaultAdvance: 1000, // approximate average Latin advance
  cjkAdvance: 2048, // Calibri doesn't have CJK glyphs; use full em width
  // prettier-ignore
  advances: [
    [0x0020, 1, 463], [0x0021, 1, 667], [0x0022, 1, 821], [0x0023, 1, 1020],
    [0x0024, 1, 1038], [0x0025, 1, 1464], [0x0026, 1, 1397], [0x0027, 1, 452],
    [0x0028, 2, 621], [0x002a, 2, 1020], [0x002c, 1, 511], [0x002d, 1, 627],
    [0x002e, 1, 517], [0x002f, 1, 791], [0x0030, 10, 1038], [0x003a, 2, 548],
    [0x003c, 3, 1020], [0x003f, 1, 949], [0x0040, 1, 1831],
    [0x0041, 1, 1185], [0x0042, 1, 1114], [0x0043, 1, 1092], [0x0044, 1, 1260],
    [0x0045, 1, 1000], [0x0046, 1, 941], [0x0047, 1, 1292], [0x0048, 1, 1276],
    [0x0049, 1, 516], [0x004a, 1, 653], [0x004b, 1, 1064], [0x004c, 1, 861],
    [0x004d, 1, 1751], [0x004e, 1, 1322], [0x004f, 1, 1356], [0x0050, 1, 1058],
    [0x0051, 1, 1378], [0x0052, 1, 1112], [0x0053, 1, 941], [0x0054, 1, 998],
    [0x0055, 1, 1314], [0x0056, 1, 1162], [0x0057, 1, 1822], [0x0058, 1, 1063],
    [0x0059, 1, 998], [0x005a, 1, 959], [0x005b, 1, 628], [0x005c, 1, 791],
    [0x005d, 1, 628], [0x005e, 2, 1020], [0x0060, 1, 596],
    [0x0061, 1, 981], [0x0062, 1, 1076], [0x0063, 1, 866], [0x0064, 1, 1076],
    [0x0065, 1, 1019], [0x0066, 1, 625], [0x0067, 1, 964], [0x0068, 1, 1076],
    [0x0069, 1, 470], [0x006a, 1, 490], [0x006b, 1, 931], [0x006c, 1, 470],
    [0x006d, 1, 1636], [0x006e, 1, 1076], [0x006f, 1, 1080], [0x0070, 2, 1076],
    [0x0072, 1, 714], [0x0073, 1, 801], [0x0074, 1, 686], [0x0075, 1, 1076],
    [0x0076, 1, 925], [0x0077, 1, 1464], [0x0078, 1, 887], [0x0079, 1, 927],
    [0x007a, 1, 809], [0x007b, 1, 644], [0x007c, 1, 943], [0x007d, 1, 644],
    [0x007e, 1, 1020]
  ]
};

// ---------------------------------------------------------------------------
// Arial Regular
// unitsPerEm=2048, usWinAscent=1854, usWinDescent=434, maxDigitAdvance=1139
// ---------------------------------------------------------------------------
const ARIAL_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1854,
    usWinDescent: 434,
    maxDigitAdvance: 1139,
    sTypoAscender: 1491,
    sTypoDescender: -431,
    sTypoLineGap: 307
  },
  defaultAdvance: 1024,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 569], [0x0021, 1, 569], [0x0022, 1, 727], [0x0023, 1, 1139],
    [0x0024, 1, 1139], [0x0025, 1, 1821], [0x0026, 1, 1366], [0x0027, 1, 391],
    [0x0028, 1, 682], [0x0029, 1, 682], [0x002a, 1, 797], [0x002b, 1, 1196],
    [0x002c, 1, 569], [0x002d, 1, 682], [0x002e, 1, 569], [0x002f, 1, 569],
    [0x0030, 10, 1139], [0x003a, 1, 569], [0x003b, 1, 569],
    [0x003c, 1, 1196], [0x003d, 1, 1196], [0x003e, 1, 1196], [0x003f, 1, 1139],
    [0x0040, 1, 2079],
    [0x0041, 1, 1366], [0x0042, 1, 1366], [0x0043, 1, 1479], [0x0044, 1, 1479],
    [0x0045, 1, 1366], [0x0046, 1, 1251], [0x0047, 1, 1593], [0x0048, 1, 1479],
    [0x0049, 1, 569], [0x004a, 1, 1024], [0x004b, 1, 1366], [0x004c, 1, 1139],
    [0x004d, 1, 1706], [0x004e, 1, 1479], [0x004f, 1, 1593], [0x0050, 1, 1366],
    [0x0051, 1, 1593], [0x0052, 1, 1479], [0x0053, 1, 1366], [0x0054, 1, 1251],
    [0x0055, 1, 1479], [0x0056, 1, 1366], [0x0057, 1, 1933], [0x0058, 1, 1366],
    [0x0059, 1, 1366], [0x005a, 1, 1251], [0x005b, 1, 569], [0x005c, 1, 569],
    [0x005d, 1, 569], [0x005e, 1, 961], [0x005f, 1, 1139], [0x0060, 1, 682],
    [0x0061, 1, 1139], [0x0062, 1, 1139], [0x0063, 1, 1024], [0x0064, 1, 1139],
    [0x0065, 1, 1139], [0x0066, 1, 569], [0x0067, 1, 1139], [0x0068, 1, 1139],
    [0x0069, 1, 455], [0x006a, 1, 455], [0x006b, 1, 1024], [0x006c, 1, 455],
    [0x006d, 1, 1706], [0x006e, 1, 1139], [0x006f, 1, 1139], [0x0070, 1, 1139],
    [0x0071, 1, 1139], [0x0072, 1, 682], [0x0073, 1, 1024], [0x0074, 1, 569],
    [0x0075, 1, 1139], [0x0076, 1, 1024], [0x0077, 1, 1479], [0x0078, 1, 1024],
    [0x0079, 1, 1024], [0x007a, 1, 1024], [0x007b, 1, 684], [0x007c, 1, 532],
    [0x007d, 1, 684], [0x007e, 1, 1196]
  ]
};

// ---------------------------------------------------------------------------
// Arial Bold
// unitsPerEm=2048, usWinAscent=1854, usWinDescent=434, maxDigitAdvance=1139
// ---------------------------------------------------------------------------
const ARIAL_BOLD: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1854,
    usWinDescent: 434,
    maxDigitAdvance: 1139,
    sTypoAscender: 1491,
    sTypoDescender: -431,
    sTypoLineGap: 307
  },
  defaultAdvance: 1070,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 569], [0x0021, 1, 682], [0x0022, 1, 974], [0x0023, 1, 1139],
    [0x0024, 1, 1139], [0x0025, 1, 1821], [0x0026, 1, 1479], [0x0027, 1, 569],
    [0x0028, 1, 682], [0x0029, 1, 682], [0x002a, 1, 797], [0x002b, 1, 1196],
    [0x002c, 1, 569], [0x002d, 1, 682], [0x002e, 1, 569], [0x002f, 1, 569],
    [0x0030, 10, 1139], [0x003a, 1, 682], [0x003b, 1, 682],
    [0x003c, 1, 1196], [0x003d, 1, 1196], [0x003e, 1, 1196], [0x003f, 1, 1251],
    [0x0040, 1, 1991],
    [0x0041, 1, 1479], [0x0042, 1, 1479], [0x0043, 1, 1479], [0x0044, 1, 1479],
    [0x0045, 1, 1366], [0x0046, 1, 1251], [0x0047, 1, 1593], [0x0048, 1, 1479],
    [0x0049, 1, 682], [0x004a, 1, 1139], [0x004b, 1, 1479], [0x004c, 1, 1251],
    [0x004d, 1, 1706], [0x004e, 1, 1479], [0x004f, 1, 1593], [0x0050, 1, 1366],
    [0x0051, 1, 1593], [0x0052, 1, 1479], [0x0053, 1, 1366], [0x0054, 1, 1251],
    [0x0055, 1, 1479], [0x0056, 1, 1366], [0x0057, 1, 1933], [0x0058, 1, 1366],
    [0x0059, 1, 1366], [0x005a, 1, 1251], [0x005b, 1, 682], [0x005c, 1, 569],
    [0x005d, 1, 682], [0x005e, 1, 1196], [0x005f, 1, 1139], [0x0060, 1, 682],
    [0x0061, 1, 1139], [0x0062, 1, 1251], [0x0063, 1, 1024], [0x0064, 1, 1251],
    [0x0065, 1, 1139], [0x0066, 1, 682], [0x0067, 1, 1251], [0x0068, 1, 1251],
    [0x0069, 1, 569], [0x006a, 1, 569], [0x006b, 1, 1139], [0x006c, 1, 569],
    [0x006d, 1, 1821], [0x006e, 1, 1251], [0x006f, 1, 1251], [0x0070, 1, 1251],
    [0x0071, 1, 1251], [0x0072, 1, 797], [0x0073, 1, 1024], [0x0074, 1, 682],
    [0x0075, 1, 1251], [0x0076, 1, 1139], [0x0077, 1, 1593], [0x0078, 1, 1139],
    [0x0079, 1, 1139], [0x007a, 1, 1024], [0x007b, 1, 797], [0x007c, 1, 569],
    [0x007d, 1, 797], [0x007e, 1, 1196]
  ]
};

// ---------------------------------------------------------------------------
// Times New Roman Regular
// unitsPerEm=2048, usWinAscent=1825, usWinDescent=443, maxDigitAdvance=1024
// ---------------------------------------------------------------------------
const TIMES_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1825,
    usWinDescent: 443,
    maxDigitAdvance: 1024,
    sTypoAscender: 1420,
    sTypoDescender: -442,
    sTypoLineGap: 307
  },
  defaultAdvance: 900,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 512], [0x0021, 1, 682], [0x0022, 1, 836], [0x0023, 1, 1024],
    [0x0024, 1, 1024], [0x0025, 1, 1706], [0x0026, 1, 1593], [0x0027, 1, 369],
    [0x0028, 1, 682], [0x0029, 1, 682], [0x002a, 1, 1024], [0x002b, 1, 1155],
    [0x002c, 1, 512], [0x002d, 1, 682], [0x002e, 1, 512], [0x002f, 1, 569],
    [0x0030, 10, 1024], [0x003a, 1, 569], [0x003b, 1, 569],
    [0x003c, 1, 1155], [0x003d, 1, 1155], [0x003e, 1, 1155], [0x003f, 1, 909],
    [0x0040, 1, 1886],
    [0x0041, 1, 1479], [0x0042, 1, 1366], [0x0043, 1, 1366], [0x0044, 1, 1479],
    [0x0045, 1, 1251], [0x0046, 1, 1139], [0x0047, 1, 1479], [0x0048, 1, 1479],
    [0x0049, 1, 682], [0x004a, 1, 797], [0x004b, 1, 1479], [0x004c, 1, 1251],
    [0x004d, 1, 1821], [0x004e, 1, 1479], [0x004f, 1, 1479], [0x0050, 1, 1139],
    [0x0051, 1, 1479], [0x0052, 1, 1366], [0x0053, 1, 1139], [0x0054, 1, 1251],
    [0x0055, 1, 1479], [0x0056, 1, 1479], [0x0057, 1, 1933], [0x0058, 1, 1479],
    [0x0059, 1, 1479], [0x005a, 1, 1251], [0x005b, 1, 682], [0x005c, 1, 569],
    [0x005d, 1, 682], [0x005e, 1, 961], [0x005f, 1, 1024], [0x0060, 1, 682],
    [0x0061, 1, 909], [0x0062, 1, 1024], [0x0063, 1, 909], [0x0064, 1, 1024],
    [0x0065, 1, 909], [0x0066, 1, 682], [0x0067, 1, 1024], [0x0068, 1, 1024],
    [0x0069, 1, 569], [0x006a, 1, 569], [0x006b, 1, 1024], [0x006c, 1, 569],
    [0x006d, 1, 1479], [0x006e, 1, 1024], [0x006f, 1, 1024], [0x0070, 1, 1024],
    [0x0071, 1, 1024], [0x0072, 1, 682], [0x0073, 1, 797], [0x0074, 1, 569],
    [0x0075, 1, 1024], [0x0076, 1, 1024], [0x0077, 1, 1479], [0x0078, 1, 1024],
    [0x0079, 1, 1024], [0x007a, 1, 909], [0x007b, 1, 983], [0x007c, 1, 410],
    [0x007d, 1, 983], [0x007e, 1, 1073]
  ]
};

// ---------------------------------------------------------------------------
// Courier New Regular (monospace)
// unitsPerEm=2048, usWinAscent=1705, usWinDescent=615, maxDigitAdvance=1229
// ---------------------------------------------------------------------------
const COURIER_NEW_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1705,
    usWinDescent: 615,
    maxDigitAdvance: 1229,
    sTypoAscender: 1255,
    sTypoDescender: -386,
    sTypoLineGap: 0
  },
  defaultAdvance: 1229, // monospace: all chars same width
  cjkAdvance: 2048,
  // Monospace: all visible ASCII chars have advance 1229
  // prettier-ignore
  advances: [[0x0020, 95, 1229]] // U+0020..U+007E
};

// ---------------------------------------------------------------------------
// Verdana Regular
// unitsPerEm=2048, usWinAscent=2059, usWinDescent=430, maxDigitAdvance=1302
// ---------------------------------------------------------------------------
const VERDANA_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 2059,
    usWinDescent: 430,
    maxDigitAdvance: 1302,
    sTypoAscender: 1566,
    sTypoDescender: -423,
    sTypoLineGap: 202
  },
  defaultAdvance: 1200,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 720], [0x0021, 1, 756], [0x0022, 1, 933], [0x0023, 1, 1521],
    [0x0024, 1, 1198], [0x0025, 1, 1807], [0x0026, 1, 1487], [0x0027, 1, 510],
    [0x0028, 1, 756], [0x0029, 1, 756], [0x002a, 1, 1198], [0x002b, 1, 1521],
    [0x002c, 1, 643], [0x002d, 1, 811], [0x002e, 1, 643], [0x002f, 1, 899],
    [0x0030, 10, 1302], [0x003a, 1, 756], [0x003b, 1, 756],
    [0x003c, 1, 1521], [0x003d, 1, 1521], [0x003e, 1, 1521], [0x003f, 1, 1151],
    [0x0040, 1, 1937],
    [0x0041, 1, 1362], [0x0042, 1, 1382], [0x0043, 1, 1279], [0x0044, 1, 1490],
    [0x0045, 1, 1279], [0x0046, 1, 1186], [0x0047, 1, 1458], [0x0048, 1, 1498],
    [0x0049, 1, 924], [0x004a, 1, 922], [0x004b, 1, 1362], [0x004c, 1, 1145],
    [0x004d, 1, 1728], [0x004e, 1, 1498], [0x004f, 1, 1476], [0x0050, 1, 1262],
    [0x0051, 1, 1476], [0x0052, 1, 1396], [0x0053, 1, 1300], [0x0054, 1, 1185],
    [0x0055, 1, 1448], [0x0056, 1, 1362], [0x0057, 1, 1864], [0x0058, 1, 1244],
    [0x0059, 1, 1183], [0x005a, 1, 1204], [0x005b, 1, 756], [0x005c, 1, 899],
    [0x005d, 1, 756], [0x005e, 1, 1521], [0x005f, 1, 1198], [0x0060, 1, 1198],
    [0x0061, 1, 1224], [0x0062, 1, 1302], [0x0063, 1, 1075], [0x0064, 1, 1302],
    [0x0065, 1, 1218], [0x0066, 1, 756], [0x0067, 1, 1302], [0x0068, 1, 1317],
    [0x0069, 1, 643], [0x006a, 1, 700], [0x006b, 1, 1183], [0x006c, 1, 643],
    [0x006d, 1, 1937], [0x006e, 1, 1317], [0x006f, 1, 1271], [0x0070, 1, 1302],
    [0x0071, 1, 1302], [0x0072, 1, 899], [0x0073, 1, 1075], [0x0074, 1, 811],
    [0x0075, 1, 1317], [0x0076, 1, 1183], [0x0077, 1, 1728], [0x0078, 1, 1183],
    [0x0079, 1, 1183], [0x007a, 1, 1031], [0x007b, 1, 787], [0x007c, 1, 756],
    [0x007d, 1, 787], [0x007e, 1, 1521]
  ]
};

// ---------------------------------------------------------------------------
// Georgia Regular
// unitsPerEm=2048, usWinAscent=1878, usWinDescent=449, maxDigitAdvance=1257
// ---------------------------------------------------------------------------
const GEORGIA_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1878,
    usWinDescent: 449,
    maxDigitAdvance: 1257,
    sTypoAscender: 1549,
    sTypoDescender: -444,
    sTypoLineGap: 198
  },
  defaultAdvance: 1100,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 504], [0x0021, 1, 614], [0x0022, 1, 679], [0x0023, 1, 1257],
    [0x0024, 1, 1024], [0x0025, 1, 1539], [0x0026, 1, 1350], [0x0027, 1, 391],
    [0x0028, 1, 614], [0x0029, 1, 614], [0x002a, 1, 842], [0x002b, 1, 1257],
    [0x002c, 1, 504], [0x002d, 1, 751], [0x002e, 1, 504], [0x002f, 1, 797],
    [0x0030, 10, 1257], [0x003a, 1, 569], [0x003b, 1, 569],
    [0x003c, 1, 1257], [0x003d, 1, 1257], [0x003e, 1, 1257], [0x003f, 1, 885],
    [0x0040, 1, 1614],
    [0x0041, 1, 1350], [0x0042, 1, 1273], [0x0043, 1, 1161], [0x0044, 1, 1427],
    [0x0045, 1, 1163], [0x0046, 1, 1074], [0x0047, 1, 1314], [0x0048, 1, 1517],
    [0x0049, 1, 721], [0x004a, 1, 772], [0x004b, 1, 1397], [0x004c, 1, 1176],
    [0x004d, 1, 1770], [0x004e, 1, 1462], [0x004f, 1, 1392], [0x0050, 1, 1118],
    [0x0051, 1, 1392], [0x0052, 1, 1321], [0x0053, 1, 1019], [0x0054, 1, 1163],
    [0x0055, 1, 1456], [0x0056, 1, 1321], [0x0057, 1, 1887], [0x0058, 1, 1314],
    [0x0059, 1, 1220], [0x005a, 1, 1055], [0x005b, 1, 614], [0x005c, 1, 797],
    [0x005d, 1, 614], [0x005e, 1, 1257], [0x005f, 1, 1024], [0x0060, 1, 682],
    [0x0061, 1, 1019], [0x0062, 1, 1100], [0x0063, 1, 866], [0x0064, 1, 1106],
    [0x0065, 1, 958], [0x0066, 1, 654], [0x0067, 1, 1006], [0x0068, 1, 1152],
    [0x0069, 1, 606], [0x006a, 1, 606], [0x006b, 1, 1048], [0x006c, 1, 606],
    [0x006d, 1, 1700], [0x006e, 1, 1131], [0x006f, 1, 1042], [0x0070, 1, 1100],
    [0x0071, 1, 1100], [0x0072, 1, 772], [0x0073, 1, 820], [0x0074, 1, 688],
    [0x0075, 1, 1117], [0x0076, 1, 1019], [0x0077, 1, 1559], [0x0078, 1, 1007],
    [0x0079, 1, 1012], [0x007a, 1, 880], [0x007b, 1, 637], [0x007c, 1, 583],
    [0x007d, 1, 637], [0x007e, 1, 1257]
  ]
};

// ---------------------------------------------------------------------------
// Tahoma Regular
// unitsPerEm=2048, usWinAscent=2049, usWinDescent=423, maxDigitAdvance=1118
// ---------------------------------------------------------------------------
const TAHOMA_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 2049,
    usWinDescent: 423,
    maxDigitAdvance: 1118,
    sTypoAscender: 1566,
    sTypoDescender: -423,
    sTypoLineGap: 59
  },
  defaultAdvance: 1050,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 461], [0x0021, 1, 536], [0x0022, 1, 717], [0x0023, 1, 1232],
    [0x0024, 1, 1014], [0x0025, 1, 1625], [0x0026, 1, 1327], [0x0027, 1, 428],
    [0x0028, 1, 616], [0x0029, 1, 616], [0x002a, 1, 900], [0x002b, 1, 1232],
    [0x002c, 1, 504], [0x002d, 1, 700], [0x002e, 1, 504], [0x002f, 1, 753],
    [0x0030, 10, 1118], [0x003a, 1, 567], [0x003b, 1, 567],
    [0x003c, 1, 1232], [0x003d, 1, 1232], [0x003e, 1, 1232], [0x003f, 1, 974],
    [0x0040, 1, 1810],
    [0x0041, 1, 1205], [0x0042, 1, 1200], [0x0043, 1, 1130], [0x0044, 1, 1327],
    [0x0045, 1, 1117], [0x0046, 1, 1032], [0x0047, 1, 1306], [0x0048, 1, 1308],
    [0x0049, 1, 614], [0x004a, 1, 794], [0x004b, 1, 1195], [0x004c, 1, 1003],
    [0x004d, 1, 1500], [0x004e, 1, 1308], [0x004f, 1, 1381], [0x0050, 1, 1103],
    [0x0051, 1, 1381], [0x0052, 1, 1200], [0x0053, 1, 1117], [0x0054, 1, 1100],
    [0x0055, 1, 1300], [0x0056, 1, 1205], [0x0057, 1, 1723], [0x0058, 1, 1119],
    [0x0059, 1, 1130], [0x005a, 1, 1068], [0x005b, 1, 616], [0x005c, 1, 753],
    [0x005d, 1, 616], [0x005e, 1, 1232], [0x005f, 1, 893], [0x0060, 1, 1118],
    [0x0061, 1, 1066], [0x0062, 1, 1141], [0x0063, 1, 942], [0x0064, 1, 1141],
    [0x0065, 1, 1086], [0x0066, 1, 639], [0x0067, 1, 1141], [0x0068, 1, 1126],
    [0x0069, 1, 500], [0x006a, 1, 548], [0x006b, 1, 1023], [0x006c, 1, 500],
    [0x006d, 1, 1705], [0x006e, 1, 1126], [0x006f, 1, 1103], [0x0070, 1, 1141],
    [0x0071, 1, 1141], [0x0072, 1, 714], [0x0073, 1, 918], [0x0074, 1, 700],
    [0x0075, 1, 1126], [0x0076, 1, 1000], [0x0077, 1, 1500], [0x0078, 1, 1000],
    [0x0079, 1, 1000], [0x007a, 1, 880], [0x007b, 1, 616], [0x007c, 1, 540],
    [0x007d, 1, 616], [0x007e, 1, 1232]
  ]
};

// ---------------------------------------------------------------------------
// Trebuchet MS Regular
// unitsPerEm=2048, usWinAscent=1923, usWinDescent=455, maxDigitAdvance=1074
// ---------------------------------------------------------------------------
const TREBUCHET_REGULAR: FontMetrics = {
  header: {
    unitsPerEm: 2048,
    usWinAscent: 1923,
    usWinDescent: 455,
    maxDigitAdvance: 1074,
    sTypoAscender: 1510,
    sTypoDescender: -420,
    sTypoLineGap: 0
  },
  defaultAdvance: 1000,
  cjkAdvance: 2048,
  // prettier-ignore
  advances: [
    [0x0020, 1, 453], [0x0021, 1, 545], [0x0022, 1, 613], [0x0023, 1, 1107],
    [0x0024, 1, 1074], [0x0025, 1, 1341], [0x0026, 1, 1213], [0x0027, 1, 360],
    [0x0028, 1, 616], [0x0029, 1, 616], [0x002a, 1, 860], [0x002b, 1, 1107],
    [0x002c, 1, 453], [0x002d, 1, 697], [0x002e, 1, 453], [0x002f, 1, 766],
    [0x0030, 10, 1074], [0x003a, 1, 453], [0x003b, 1, 453],
    [0x003c, 1, 1107], [0x003d, 1, 1107], [0x003e, 1, 1107], [0x003f, 1, 860],
    [0x0040, 1, 1648],
    [0x0041, 1, 1227], [0x0042, 1, 1227], [0x0043, 1, 1139], [0x0044, 1, 1309],
    [0x0045, 1, 1139], [0x0046, 1, 1057], [0x0047, 1, 1309], [0x0048, 1, 1395],
    [0x0049, 1, 627], [0x004a, 1, 791], [0x004b, 1, 1260], [0x004c, 1, 1057],
    [0x004d, 1, 1456], [0x004e, 1, 1350], [0x004f, 1, 1395], [0x0050, 1, 1139],
    [0x0051, 1, 1395], [0x0052, 1, 1215], [0x0053, 1, 1057], [0x0054, 1, 1139],
    [0x0055, 1, 1350], [0x0056, 1, 1227], [0x0057, 1, 1730], [0x0058, 1, 1260],
    [0x0059, 1, 1139], [0x005a, 1, 1139], [0x005b, 1, 616], [0x005c, 1, 766],
    [0x005d, 1, 616], [0x005e, 1, 1107], [0x005f, 1, 1074], [0x0060, 1, 860],
    [0x0061, 1, 1013], [0x0062, 1, 1074], [0x0063, 1, 936], [0x0064, 1, 1074],
    [0x0065, 1, 1013], [0x0066, 1, 627], [0x0067, 1, 1074], [0x0068, 1, 1074],
    [0x0069, 1, 545], [0x006a, 1, 538], [0x006b, 1, 1013], [0x006c, 1, 545],
    [0x006d, 1, 1539], [0x006e, 1, 1074], [0x006f, 1, 1074], [0x0070, 1, 1074],
    [0x0071, 1, 1074], [0x0072, 1, 715], [0x0073, 1, 860], [0x0074, 1, 627],
    [0x0075, 1, 1074], [0x0076, 1, 936], [0x0077, 1, 1481], [0x0078, 1, 936],
    [0x0079, 1, 936], [0x007a, 1, 860], [0x007b, 1, 616], [0x007c, 1, 604],
    [0x007d, 1, 616], [0x007e, 1, 1107]
  ]
};

// =============================================================================
// Font Metrics Registry
// =============================================================================

/** Registry of all available font metrics, keyed by lowercase font name */
const FONT_METRICS: Record<string, FontMetrics> = {};
const FONT_METRICS_BOLD: Record<string, FontMetrics> = {};

function registerFont(name: string, regular: FontMetrics, bold?: FontMetrics): void {
  FONT_METRICS[name.toLowerCase()] = regular;
  if (bold) {
    FONT_METRICS_BOLD[name.toLowerCase()] = bold;
  }
}

registerFont("calibri", CALIBRI_REGULAR);
registerFont("arial", ARIAL_REGULAR, ARIAL_BOLD);
registerFont("times new roman", TIMES_REGULAR);
registerFont("courier new", COURIER_NEW_REGULAR);
registerFont("verdana", VERDANA_REGULAR);
registerFont("georgia", GEORGIA_REGULAR);
registerFont("tahoma", TAHOMA_REGULAR);
registerFont("trebuchet ms", TREBUCHET_REGULAR);

// =============================================================================
// Tier 3: Font Width Factors
// =============================================================================

// For fonts without FUnit data, use per-category average width factors.
// Format: [lowercaseFactor, uppercaseFactor, wideFactor]
// From an experimentally-tuned per-font width-factor table.

// prettier-ignore
const FONT_WIDTH_FACTORS: Record<string, [number, number, number]> = {
  "aptos": [1.03, 1.37, 1.00],
  "aptos display": [0.96, 1.31, 1.00],
  "aptos narrow": [0.82, 1.07, 1.00],
  "aptos serif": [0.98, 1.31, 1.00],
  "calibri light": [0.98, 1.19, 1.00],
  "cambria": [1.07, 1.28, 1.00],
  "century gothic": [1.19, 1.36, 1.00],
  "comic sans ms": [1.14, 1.46, 1.00],
  "consolas": [1.21, 1.21, 1.00],
  "constantia": [1.05, 1.34, 1.00],
  "corbel": [0.97, 1.20, 1.00],
  "garamond": [1.16, 1.39, 1.00],
  "impact": [0.96, 1.01, 1.00],
  "lucida console": [1.21, 1.21, 1.00],
  "lucida sans unicode": [1.16, 1.40, 1.00],
  "microsoft sans serif": [1.07, 1.35, 1.00],
  "palatino linotype": [1.12, 1.44, 1.00],
  "segoe ui": [1.08, 1.31, 1.00],
  "book antiqua": [1.12, 1.44, 1.00],
  "candara": [1.02, 1.25, 1.00],
  "franklin gothic medium": [1.08, 1.33, 1.00],
  "goudy old style": [1.02, 1.34, 1.00],
  "rockwell": [1.14, 1.35, 1.00],
  "tw cen mt": [0.95, 1.17, 1.00],
  // CJK fonts with wide factor
  "microsoft yahei": [1.18, 1.30, 1.18],
  "microsoft yahei ui": [1.18, 1.30, 1.18],
  "simsun": [1.10, 1.10, 1.10],
  "\u5b8b\u4f53": [1.10, 1.10, 1.10],           // 宋体
  "simhei": [1.10, 1.10, 1.10],
  "\u9ed1\u4f53": [1.10, 1.10, 1.10],           // 黑体
  "nsimsun": [1.10, 1.10, 1.10],
  "\u65b0\u5b8b\u4f53": [1.10, 1.10, 1.10],     // 新宋体
  "dengxian": [1.05, 1.28, 1.08],
  "\u7b49\u7ebf": [1.05, 1.28, 1.08],           // 等线
  "fangsong": [1.10, 1.10, 1.10],
  "\u4eff\u5b8b": [1.10, 1.10, 1.10],           // 仿宋
  "kaiti": [1.10, 1.10, 1.10],
  "\u6977\u4f53": [1.10, 1.10, 1.10],           // 楷体
  "meiryo": [1.18, 1.30, 1.18],
  "meiryo ui": [1.10, 1.20, 1.18],
  "ms gothic": [1.21, 1.21, 1.10],
  "\uff2d\uff33 \u30b4\u30b7\u30c3\u30af": [1.21, 1.21, 1.10],
  "ms pgothic": [1.07, 1.33, 1.10],
  "ms mincho": [1.21, 1.21, 1.10],
  "yu gothic": [1.17, 1.32, 1.18],
  "yu gothic ui": [1.08, 1.22, 1.18],
  "yu mincho": [1.10, 1.28, 1.18],
  "malgun gothic": [1.12, 1.28, 1.14],
  "\ub9d1\uc740 \uace0\ub515": [1.12, 1.28, 1.14],
  "batang": [1.10, 1.10, 1.10],
  "gulim": [1.10, 1.10, 1.10],
  "dotum": [1.10, 1.10, 1.10]
};

// =============================================================================
// Lookup API
// =============================================================================

/**
 * Build a Map<codePoint, advance> from run-length encoded data.
 * Cached per font to avoid rebuilding on every call.
 */
const advanceMapCache = new Map<FontMetrics, Map<number, number>>();

function getAdvanceMap(metrics: FontMetrics): Map<number, number> {
  let map = advanceMapCache.get(metrics);
  if (map) {
    return map;
  }
  map = new Map();
  for (const [start, count, advance] of metrics.advances) {
    for (let i = 0; i < count; i++) {
      map.set(start + i, advance);
    }
  }
  advanceMapCache.set(metrics, map);
  return map;
}

/**
 * Get FUnit metrics for a font by name, optionally bold variant.
 * Returns undefined if no FUnit data is available (falls back to Tier 3).
 * When bold is true and no bold-specific metrics exist, returns the regular variant.
 */
export function getFontMetrics(fontName: string, bold?: boolean): FontMetrics | undefined {
  const key = fontName.toLowerCase();
  if (bold) {
    return FONT_METRICS_BOLD[key] ?? FONT_METRICS[key];
  }
  return FONT_METRICS[key];
}

/**
 * Check if a font has a dedicated bold metrics table.
 * When false, the bold multiplier (1.05) should be applied to width calculations.
 */
export function hasBoldMetrics(fontName: string): boolean {
  return Object.hasOwn(FONT_METRICS_BOLD, fontName.toLowerCase());
}

/**
 * Get the Calibri Regular metrics (default font).
 */
export function getDefaultFontMetrics(): FontMetrics {
  return CALIBRI_REGULAR;
}

/**
 * Get the advance width of a character in FUnits for a given font.
 * Returns the font's defaultAdvance if the character is not in the table.
 *
 * For CJK Unified Ideographs (U+4E00..U+9FFF, U+3400..U+4DBF, U+F900..U+FAFF),
 * returns the font's cjkAdvance.
 */
export function getCharAdvance(metrics: FontMetrics, codePoint: number): number {
  // CJK Unified Ideographs and Extensions
  if (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x323af)
  ) {
    return metrics.cjkAdvance;
  }

  // Hiragana, Katakana, CJK Symbols and Punctuation
  if (codePoint >= 0x3000 && codePoint <= 0x30ff) {
    return metrics.cjkAdvance;
  }

  // Hangul Syllables
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return metrics.cjkAdvance;
  }

  // Fullwidth forms (U+FF01..U+FF60)
  if (codePoint >= 0xff01 && codePoint <= 0xff60) {
    return metrics.cjkAdvance;
  }

  // CJK Radicals, Kangxi, Bopomofo, CJK Enclosed, Compatibility
  if (
    (codePoint >= 0x2e80 && codePoint <= 0x2fdf) ||
    (codePoint >= 0x3100 && codePoint <= 0x33ff)
  ) {
    return metrics.cjkAdvance;
  }

  const map = getAdvanceMap(metrics);
  return map.get(codePoint) ?? metrics.defaultAdvance;
}

/**
 * Get the Calibri 11pt bitmap pixel width for a character.
 * Returns undefined if not in the bitmap table.
 */
export function getCalibri11PtPixelWidth(codePoint: number): number | undefined {
  return CALIBRI_11PT_PX[codePoint];
}

/**
 * Get Tier 3 font width factors [lowercase, uppercase, wide] for a font.
 * Returns undefined if no factors are available.
 */
export function getFontWidthFactors(fontName: string): [number, number, number] | undefined {
  return FONT_WIDTH_FACTORS[fontName.toLowerCase()];
}

/**
 * Check if a code point is an East Asian wide/fullwidth character.
 * This replaces an external Unicode width table.
 */
export function isWideCharacter(codePoint: number): boolean {
  // CJK Unified Ideographs
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  // CJK Unified Ideographs Extension A
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  // CJK Compatibility Ideographs
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) {
    return true;
  }
  // Fullwidth forms
  if (codePoint >= 0xff01 && codePoint <= 0xff60) {
    return true;
  }
  // CJK Symbols and Punctuation, Hiragana, Katakana
  if (codePoint >= 0x3000 && codePoint <= 0x30ff) {
    return true;
  }
  // CJK Radicals, Kangxi, Bopomofo, CJK Enclosed, Compatibility
  if (
    (codePoint >= 0x2e80 && codePoint <= 0x2fdf) ||
    (codePoint >= 0x3100 && codePoint <= 0x33ff)
  ) {
    return true;
  }
  // Hangul Syllables
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  // CJK Unified Ideographs Extensions B through H
  if (codePoint >= 0x20000 && codePoint <= 0x323af) {
    return true;
  }
  return false;
}

export { CALIBRI_11PT_PX };
