/**
 * CMap parser for PDF text extraction.
 *
 * Parses /ToUnicode CMap programs to build character code → Unicode mappings.
 * This is essential for extracting text from PDFs that use CIDFonts or
 * custom encodings.
 *
 * Supports:
 * - beginbfchar / endbfchar (single character mappings)
 * - beginbfrange / endbfrange (range mappings, including array form)
 * - begincodespacerange / endcodespacerange
 * - Multi-byte character codes (1-4 bytes)
 * - UTF-16BE encoded target strings (including surrogate pairs)
 *
 * @see PDF Reference 1.7, §5.9 - ToUnicode CMaps
 * @see Adobe Technical Note #5411 - CMap Resources
 */

import { PdfTokenizer, TokenType } from "@pdf/reader/pdf-tokenizer";

// =============================================================================
// Types
// =============================================================================

/** A code space range defining valid input code ranges */
interface CodeSpaceRange {
  low: number;
  high: number;
  bytes: number;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * A parsed CMap that maps character codes to Unicode strings.
 */
export class CMap {
  private codeSpaceRanges: CodeSpaceRange[] = [];
  private bfChars: Map<number, string> = new Map();
  private bfRanges: Array<{ low: number; high: number; mapping: string | string[] }> = [];
  /** Number of bytes per character code (detected from codespace ranges) */
  declare bytesPerCode: number;

  constructor() {
    this.bytesPerCode = 1;
  }

  /**
   * Look up the Unicode string for a character code.
   * Uses binary search over sorted bfRanges for efficient lookup.
   */
  lookup(code: number): string | undefined {
    // Check bfchar mappings first (exact match)
    const charMapping = this.bfChars.get(code);
    if (charMapping !== undefined) {
      return charMapping;
    }

    // Check bfrange mappings using binary search
    const ranges = this.bfRanges;
    let lo = 0;
    let hi = ranges.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const range = ranges[mid];

      if (code < range.low) {
        hi = mid - 1;
      } else if (code > range.high) {
        lo = mid + 1;
      } else {
        // code is within this range
        if (typeof range.mapping === "string") {
          return offsetBfRangeDestination(range.mapping, code - range.low);
        }
        // Array mapping
        const index = code - range.low;
        if (index < range.mapping.length) {
          return range.mapping[index];
        }
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * Add a code space range.
   */
  addCodeSpaceRange(low: number, high: number, bytes: number): void {
    this.codeSpaceRanges.push({ low, high, bytes });
    if (bytes > this.bytesPerCode) {
      this.bytesPerCode = bytes;
    }
  }

  /**
   * Add a bfchar mapping.
   */
  addBfChar(code: number, unicode: string): void {
    this.bfChars.set(code, unicode);
  }

  /**
   * Add a bfrange mapping.
   */
  addBfRange(low: number, high: number, mapping: string | string[]): void {
    this.bfRanges.push({ low, high, mapping });
  }

  /**
   * Sort bfRanges by low value for binary search.
   * Should be called after all ranges have been added.
   */
  sortRanges(): void {
    this.bfRanges.sort((a, b) => a.low - b.low);
  }

  /**
   * Determine the code length (in bytes) for a given first byte,
   * using the codespace ranges. When multiple ranges match (e.g. a 1-byte
   * range covering 0x00-0xFF and a 2-byte range whose first byte overlaps),
   * returns the longest match per the PDF spec's greedy matching rule.
   * Falls back to bytesPerCode if no range matches.
   */
  getCodeLength(firstByte: number): number {
    let bestLen = 0;

    for (const range of this.codeSpaceRanges) {
      if (range.bytes === 1) {
        if (firstByte >= (range.low & 0xff) && firstByte <= (range.high & 0xff)) {
          if (bestLen < 1) {
            bestLen = 1;
          }
        }
      } else if (range.bytes === 2) {
        const highByteLow = (range.low >> 8) & 0xff;
        const highByteHigh = (range.high >> 8) & 0xff;
        if (firstByte >= highByteLow && firstByte <= highByteHigh) {
          if (bestLen < 2) {
            bestLen = 2;
          }
        }
      } else {
        // For multi-byte ranges (3+ bytes), check the high byte
        const hiLow = range.low >>> ((range.bytes - 1) * 8);
        const hiHigh = range.high >>> ((range.bytes - 1) * 8);
        if (firstByte >= hiLow && firstByte <= hiHigh) {
          if (range.bytes > bestLen) {
            bestLen = range.bytes;
          }
        }
      }
    }

    return bestLen > 0 ? bestLen : this.bytesPerCode; // fallback
  }

  /**
   * Check if this CMap has any mappings.
   */
  get isEmpty(): boolean {
    return this.bfChars.size === 0 && this.bfRanges.length === 0;
  }

  /**
   * Check if this CMap has codespace ranges defined.
   */
  get hasCodeSpaceRanges(): boolean {
    return this.codeSpaceRanges.length > 0;
  }
}

// =============================================================================
// CMap Parser
// =============================================================================

/**
 * Parse a CMap program (typically from a /ToUnicode stream).
 */
export function parseCMap(data: Uint8Array): CMap {
  const cmap = new CMap();
  const tokenizer = new PdfTokenizer(data);

  while (true) {
    const token = tokenizer.next();
    if (token.type === TokenType.EOF) {
      break;
    }

    if (token.type === TokenType.Keyword) {
      const kw = token.strValue!;

      if (kw === "begincodespacerange") {
        parseCodeSpaceRange(tokenizer, cmap);
      } else if (kw === "beginbfchar") {
        parseBfChar(tokenizer, cmap);
      } else if (kw === "beginbfrange") {
        parseBfRange(tokenizer, cmap);
      }
    }
  }

  // Sort bfRanges for binary search lookup
  cmap.sortRanges();

  return cmap;
}

/**
 * Parse codespacerange section.
 */
function parseCodeSpaceRange(tokenizer: PdfTokenizer, cmap: CMap): void {
  while (true) {
    const token = tokenizer.next();
    if (token.type === TokenType.EOF) {
      break;
    }
    if (token.type === TokenType.Keyword && token.strValue === "endcodespacerange") {
      break;
    }

    // Expect two hex strings: low high
    if (token.type === TokenType.HexString) {
      const lowBytes = token.rawBytes!;
      const highToken = tokenizer.next();
      if (highToken.type === TokenType.HexString) {
        const highBytes = highToken.rawBytes!;
        const low = bytesToInt(lowBytes);
        const high = bytesToInt(highBytes);
        cmap.addCodeSpaceRange(low, high, lowBytes.length);
      }
    }
  }
}

/**
 * Parse bfchar section.
 * Format: <srcCode> <dstString>
 */
function parseBfChar(tokenizer: PdfTokenizer, cmap: CMap): void {
  while (true) {
    const token = tokenizer.next();
    if (token.type === TokenType.EOF) {
      break;
    }
    if (token.type === TokenType.Keyword && token.strValue === "endbfchar") {
      break;
    }

    if (token.type === TokenType.HexString) {
      const code = bytesToInt(token.rawBytes!);
      const target = tokenizer.next();
      if (target.type === TokenType.HexString) {
        const unicode = decodeUtf16BE(target.rawBytes!);
        cmap.addBfChar(code, unicode);
      }
    }
  }
}

/**
 * Parse bfrange section.
 * Formats:
 *   <low> <high> <dstString>           — sequential mapping
 *   <low> <high> [<str1> <str2> ...]   — array mapping
 */
function parseBfRange(tokenizer: PdfTokenizer, cmap: CMap): void {
  while (true) {
    const token = tokenizer.next();
    if (token.type === TokenType.EOF) {
      break;
    }
    if (token.type === TokenType.Keyword && token.strValue === "endbfrange") {
      break;
    }

    if (token.type === TokenType.HexString) {
      const low = bytesToInt(token.rawBytes!);
      const highToken = tokenizer.next();
      if (highToken.type !== TokenType.HexString) {
        continue;
      }
      const high = bytesToInt(highToken.rawBytes!);

      const mappingToken = tokenizer.next();
      if (mappingToken.type === TokenType.HexString) {
        // Sequential mapping from base string
        const unicode = decodeUtf16BE(mappingToken.rawBytes!);
        cmap.addBfRange(low, high, unicode);
      } else if (mappingToken.type === TokenType.ArrayBegin) {
        // Array of individual mappings
        const mappings: string[] = [];
        while (true) {
          const elem = tokenizer.next();
          if (elem.type === TokenType.ArrayEnd || elem.type === TokenType.EOF) {
            break;
          }
          if (elem.type === TokenType.HexString) {
            mappings.push(decodeUtf16BE(elem.rawBytes!));
          }
        }
        cmap.addBfRange(low, high, mappings);
      }
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a byte array to a big-endian integer.
 * Uses multiplication instead of bitshift to avoid overflow for large codes.
 */
function bytesToInt(bytes: Uint8Array): number {
  let result = 0;
  for (let i = 0; i < bytes.length; i++) {
    result = result * 256 + bytes[i];
  }
  return result;
}

/**
 * Decode a UTF-16BE byte array to a JavaScript string.
 */
function decodeUtf16BE(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    // Handle surrogate pairs
    if (code >= 0xd800 && code <= 0xdbff && i + 3 < bytes.length) {
      const low = (bytes[i + 2] << 8) | bytes[i + 3];
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        result += String.fromCodePoint(cp);
        i += 2;
        continue;
      }
    }
    result += String.fromCharCode(code);
  }
  // Single-byte code: treat as direct character code
  if (bytes.length === 1) {
    return String.fromCharCode(bytes[0]);
  }
  return result;
}

/**
 * Apply a `bfrange` offset to its destination string.
 *
 * Per PDF 32000-1 9.10.3 a `bfrange` with a single destination string maps the
 * range by incrementing the *last* byte of that string, keeping the preceding
 * bytes fixed. So `<0000> <0002> <00410042>` maps to "AB", "AC", "AD" — the
 * destination may be several UTF-16 code units long (decomposed accents,
 * ligature expansions, emoji sequences), and all but the last are carried
 * through unchanged.
 *
 * Returns undefined when the increment would leave the last code unit's valid
 * space, which means the CMap's range is wider than its destination allows;
 * inventing a character there would silently corrupt extracted text.
 */
function offsetBfRangeDestination(destination: string, offset: number): string | undefined {
  if (destination.length === 0) {
    return undefined;
  }
  if (offset === 0) {
    return destination;
  }

  const lastIndex = destination.length - 1;
  const incremented = destination.charCodeAt(lastIndex) + offset;
  if (incremented < 0 || incremented > 0xffff) {
    return undefined;
  }
  // A destination ending in a surrogate pair must still end in one: the low
  // surrogate may only be replaced by another low surrogate.
  const precedingUnit = lastIndex > 0 ? destination.charCodeAt(lastIndex - 1) : 0;
  const endsWithSurrogatePair = precedingUnit >= 0xd800 && precedingUnit <= 0xdbff;
  if (endsWithSurrogatePair && (incremented < 0xdc00 || incremented > 0xdfff)) {
    return undefined;
  }
  // An unpaired surrogate is not a character.
  if (!endsWithSurrogatePair && incremented >= 0xd800 && incremented <= 0xdfff) {
    return undefined;
  }

  return destination.slice(0, lastIndex) + String.fromCharCode(incremented);
}
