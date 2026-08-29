/**
 * PDF object parser.
 *
 * Parses PDF tokens into typed PDF objects: dictionaries, arrays, strings,
 * numbers, booleans, names, null, indirect references, and streams.
 *
 * @see PDF Reference 1.7, Chapter 3 - Objects
 */

import { PdfStructureError } from "@pdf/errors";
import { TokenType } from "@pdf/reader/pdf-tokenizer";
import type { Token, PdfTokenizer } from "@pdf/reader/pdf-tokenizer";

// =============================================================================
// PDF Object Types
// =============================================================================

/** A PDF indirect object reference: `N gen R` */
export interface PdfRef {
  readonly type: "ref";
  readonly objNum: number;
  readonly gen: number;
}

/** A PDF stream: dictionary + raw data bytes */
export interface PdfStream {
  readonly type: "stream";
  readonly dict: PdfDictValue;
  readonly data: Uint8Array;
}

/** A PDF dictionary: key-value pairs where keys are names */
export type PdfDictValue = Map<string, PdfObject>;

/** A PDF array */
export type PdfArrayValue = PdfObject[];

/**
 * Union type for all possible PDF object values.
 */
export type PdfObject =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | PdfRef
  | PdfDictValue
  | PdfArrayValue
  | PdfStream;

// =============================================================================
// Type Guards
// =============================================================================

export function isPdfRef(obj: PdfObject | undefined): obj is PdfRef {
  return obj !== null && typeof obj === "object" && "type" in obj && obj.type === "ref";
}

export function isPdfStream(obj: PdfObject | undefined): obj is PdfStream {
  return obj !== null && typeof obj === "object" && "type" in obj && obj.type === "stream";
}

export function isPdfDict(obj: PdfObject | undefined): obj is PdfDictValue {
  return obj instanceof Map;
}

export function isPdfArray(obj: PdfObject | undefined): obj is PdfArrayValue {
  return Array.isArray(obj);
}

// =============================================================================
// Dictionary Helpers
// =============================================================================

/** Get a string value from a PDF dictionary */
export function dictGetName(dict: PdfDictValue, key: string): string | undefined {
  const val = dict.get(key);
  return typeof val === "string" ? val : undefined;
}

/** Get a number value from a PDF dictionary */
export function dictGetNumber(dict: PdfDictValue, key: string): number | undefined {
  const val = dict.get(key);
  return typeof val === "number" ? val : undefined;
}

/** Get a boolean value from a PDF dictionary */
export function dictGetBool(dict: PdfDictValue, key: string): boolean | undefined {
  const val = dict.get(key);
  return typeof val === "boolean" ? val : undefined;
}

/** Get an array value from a PDF dictionary */
export function dictGetArray(dict: PdfDictValue, key: string): PdfArrayValue | undefined {
  const val = dict.get(key);
  return isPdfArray(val) ? val : undefined;
}

/** Get a ref from a PDF dictionary */
export function dictGetRef(dict: PdfDictValue, key: string): PdfRef | undefined {
  const val = dict.get(key);
  return isPdfRef(val) ? val : undefined;
}

/** Get bytes (string as Uint8Array) from a PDF dictionary */
export function dictGetBytes(dict: PdfDictValue, key: string): Uint8Array | undefined {
  const val = dict.get(key);
  return val instanceof Uint8Array ? val : undefined;
}

/**
 * Decode PDF string bytes to a JavaScript string.
 * Handles UTF-16BE (BOM = FEFF) and PDFDocEncoding (Latin-1 superset).
 */
export function decodePdfStringBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE
    let result = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
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
    return result;
  }

  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }

  // PDFDocEncoding (identical to Latin-1 / ISO 8859-1 for 0x00-0xFF,
  // with some differences in 0x80-0x9F range)
  return decodePdfDocEncoding(bytes);
}

/** Decode bytes using PDFDocEncoding */
function decodePdfDocEncoding(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const mapped = PDF_DOC_ENCODING[b];
    result += mapped !== undefined ? String.fromCodePoint(mapped) : String.fromCharCode(b);
  }
  return result;
}

/**
 * PDFDocEncoding differences from Latin-1 in the 0x80-0xAD range.
 * @see PDF Reference 1.7, Table D.2
 */
const PDF_DOC_ENCODING: Record<number, number> = {
  0x80: 0x2022, // •
  0x81: 0x2020, // †
  0x82: 0x2021, // ‡
  0x83: 0x2026, // …
  0x84: 0x2014, // —
  0x85: 0x2013, // –
  0x86: 0x0192, // ƒ
  0x87: 0x2044, // ⁄
  0x88: 0x2039, // ‹
  0x89: 0x203a, // ›
  0x8a: 0x2212, // −
  0x8b: 0x2030, // ‰
  0x8c: 0x201e, // „
  0x8d: 0x201c, // "
  0x8e: 0x201d, // "
  0x8f: 0x2018, // '
  0x90: 0x2019, // '
  0x91: 0x201a, // ‚
  0x92: 0x2122, // ™
  0x93: 0xfb01, // fi
  0x94: 0xfb02, // fl
  0x95: 0x0141, // Ł
  0x96: 0x0152, // Œ
  0x97: 0x0160, // Š
  0x98: 0x0178, // Ÿ
  0x99: 0x017d, // Ž
  0x9a: 0x0131, // ı
  0x9b: 0x0142, // ł
  0x9c: 0x0153, // œ
  0x9d: 0x0161, // š
  0x9e: 0x017e, // ž
  0xa0: 0x20ac, // €
  0xad: 0x02c7 //  ˇ
};

// =============================================================================
// PDF Object Parser
// =============================================================================

/**
 * Parse a single PDF object from the tokenizer.
 *
 * Handles all PDF object types including dictionaries (with possible streams),
 * arrays, strings, numbers, names, booleans, null, and indirect references.
 */
export function parseObject(tokenizer: PdfTokenizer): PdfObject {
  const token = tokenizer.next();
  return parseObjectFromToken(tokenizer, token);
}

/**
 * Parse a PDF object given the first token has already been consumed.
 */
export function parseObjectFromToken(tokenizer: PdfTokenizer, token: Token): PdfObject {
  switch (token.type) {
    case TokenType.Number: {
      // Could be: number, or start of indirect ref (N gen R) or indirect obj (N gen obj)
      const num = token.numValue!;
      const savedPos = tokenizer.pos;
      const next = tokenizer.next();

      if (next.type === TokenType.Number) {
        const gen = next.numValue!;
        const next2 = tokenizer.next();

        if (next2.type === TokenType.Keyword && next2.strValue === "R") {
          // Indirect reference: N gen R
          return { type: "ref", objNum: num, gen } as PdfRef;
        }

        if (next2.type === TokenType.Keyword && next2.strValue === "obj") {
          // Indirect object definition: N gen obj ... endobj
          const obj = parseObject(tokenizer);
          // Check if it's a stream
          if (isPdfDict(obj)) {
            tokenizer.skipWhitespaceAndComments();
            const peekPos = tokenizer.pos;
            const maybeStream = tokenizer.next();
            if (maybeStream.type === TokenType.Keyword && maybeStream.strValue === "stream") {
              const length = dictGetNumber(obj, "Length") ?? -1;
              const streamData = tokenizer.readStreamContent(length);
              // Consume endobj
              const endobj = tokenizer.next();
              if (endobj.type !== TokenType.Keyword || endobj.strValue !== "endobj") {
                // Some PDFs don't have endobj after endstream — tolerate
                tokenizer.pos = endobj.offset;
              }
              return { type: "stream", dict: obj, data: streamData } as PdfStream;
            }
            // Not a stream — restore position
            tokenizer.pos = peekPos;
          }
          // Consume endobj
          tokenizer.skipWhitespaceAndComments();
          const peekEnd = tokenizer.pos;
          const endTok = tokenizer.next();
          if (endTok.type !== TokenType.Keyword || endTok.strValue !== "endobj") {
            tokenizer.pos = peekEnd;
          }
          return obj;
        }

        // Not a ref or obj definition — restore
        tokenizer.pos = savedPos;
        return num;
      }

      // Not followed by another number — just a number
      tokenizer.pos = savedPos;
      return num;
    }

    case TokenType.LiteralString:
    case TokenType.HexString:
      return token.rawBytes ?? new Uint8Array(0);

    case TokenType.Name:
      return token.strValue!;

    case TokenType.Boolean:
      return token.boolValue!;

    case TokenType.Null:
      return null;

    case TokenType.DictBegin:
      return parseDictionary(tokenizer);

    case TokenType.ArrayBegin:
      return parseArray(tokenizer);

    case TokenType.EOF:
      throw new PdfStructureError("Unexpected end of input while parsing PDF object");

    default:
      // Keywords like "endobj", "stream" etc. are unexpected in object context
      // Return them as-is for the caller to handle
      return token.strValue ?? null;
  }
}

/**
 * Parse a PDF dictionary (after the `<<` token has been consumed).
 */
function parseDictionary(tokenizer: PdfTokenizer): PdfDictValue {
  const dict: PdfDictValue = new Map();

  while (true) {
    const keyToken = tokenizer.next();
    if (keyToken.type === TokenType.DictEnd) {
      break;
    }
    if (keyToken.type === TokenType.EOF) {
      throw new PdfStructureError("Unexpected EOF in dictionary");
    }
    if (keyToken.type !== TokenType.Name) {
      // Some malformed PDFs have non-name keys — skip and try again
      continue;
    }

    const key = keyToken.strValue!;
    const value = parseObject(tokenizer);
    dict.set(key, value);
  }

  return dict;
}

/**
 * Parse a PDF array (after the `[` token has been consumed).
 */
function parseArray(tokenizer: PdfTokenizer): PdfArrayValue {
  const arr: PdfArrayValue = [];

  while (true) {
    const token = tokenizer.next();
    if (token.type === TokenType.ArrayEnd) {
      break;
    }
    if (token.type === TokenType.EOF) {
      throw new PdfStructureError("Unexpected EOF in array");
    }
    arr.push(parseObjectFromToken(tokenizer, token));
  }

  return arr;
}
