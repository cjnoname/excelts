/**
 * Binary Utilities
 *
 * Cached TextEncoder/TextDecoder instances and core Uint8Array operations.
 * Platform-neutral — used across the entire codebase.
 */

// =============================================================================
// Cached TextEncoder/TextDecoder instances
// =============================================================================

/**
 * Cached TextEncoder instance for UTF-8 encoding
 */
export const textEncoder = new TextEncoder();

/**
 * Cached TextDecoder instance for UTF-8 decoding
 * ignoreBOM: true - preserves BOM in output to match Node.js behavior
 */
export const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// Cache non-default decoders by encoding to avoid repeated allocations.
const _decoderCache = new Map<string, TextDecoder>();

function normalizeEncodingLabel(encoding?: string): string {
  const normalized = (encoding ?? "utf-8").trim().toLowerCase();
  if (normalized === "" || normalized === "utf8" || normalized === "utf-8") {
    return "utf-8";
  }
  if (normalized === "utf16le" || normalized === "utf-16le") {
    return "utf-16le";
  }
  if (normalized === "ucs2" || normalized === "ucs-2") {
    return "utf-16le";
  }
  if (normalized === "binary") {
    return "latin1";
  }
  return normalized;
}

/**
 * Get a cached TextDecoder instance.
 *
 * Note: For the default UTF-8 path we reuse the module-level `textDecoder`.
 */
export function getTextDecoder(encoding?: string): TextDecoder {
  const key = normalizeEncodingLabel(encoding);
  if (key === "utf-8") {
    return textDecoder;
  }
  let decoder = _decoderCache.get(key);
  if (!decoder) {
    decoder = createTextDecoderOrTypeError(key);
    _decoderCache.set(key, decoder);
  }
  return decoder;
}

/**
 * Create a new TextDecoder instance.
 *
 * Use this for streaming decode (`decode(..., { stream: true })`) to avoid
 * sharing mutable decoder state across concurrent operations.
 */
export function createTextDecoder(encoding?: string): TextDecoder {
  return createTextDecoderOrTypeError(normalizeEncodingLabel(encoding), { ignoreBOM: true });
}

function createTextDecoderOrTypeError(encoding: string, options?: TextDecoderOptions): TextDecoder {
  try {
    return new TextDecoder(encoding, options);
  } catch (cause) {
    throw new TypeError(`Unsupported text encoding: ${encoding}`, { cause });
  }
}

// =============================================================================
// StreamDecoder — Unified streaming decoder (Node.js StringDecoder parity)
// =============================================================================

/**
 * Minimal streaming decoder interface compatible with a subset of `TextDecoder`.
 * Used by the browser Readable's `setEncoding()` to support encodings that
 * `TextDecoder` does not handle (`hex`, `base64`, `base64url`, `ascii`).
 */
export interface StreamDecoder {
  decode(input: Uint8Array, options?: { stream?: boolean }): string;
}

/**
 * Create a streaming decoder for the given encoding.
 *
 * For encodings natively supported by `TextDecoder` (utf-8, latin1, utf-16le,
 * etc.) this returns a real `TextDecoder`.  For Node.js-only encodings
 * (`hex`, `base64`, `base64url`, `ascii`) it returns a custom implementation
 * that matches `StringDecoder` semantics — including stateful buffering for
 * `base64` (3-byte grouping) and 7-bit masking for `ascii`.
 */
export function createStreamDecoder(encoding?: string): StreamDecoder {
  const enc = normalizeEncodingLabel(encoding);
  switch (enc) {
    case "hex":
      return { decode: hexStreamDecode };
    case "base64":
      return new Base64StreamDecoder(false);
    case "base64url":
      return new Base64StreamDecoder(true);
    case "ascii":
      return { decode: asciiStreamDecode };
    default:
      // All other encodings are handled by TextDecoder.
      return createTextDecoderOrTypeError(enc, { ignoreBOM: true });
  }
}

// -- Hex decoder --------------------------------------------------------------

/** Pre-computed lookup table for byte→hex (avoids per-byte toString(16)). */
const hexTable: string[] = /* @__PURE__ */ (() => {
  const t = new Array<string>(256);
  for (let i = 0; i < 256; i++) {
    t[i] = i.toString(16).padStart(2, "0");
  }
  return t;
})();

/** Decode bytes as a lowercase hex string. Stateless. */
function hexStreamDecode(input: Uint8Array): string {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    result += hexTable[input[i]!];
  }
  return result;
}

// -- Base64 / Base64url decoder -----------------------------------------------

const _b64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const _b64UrlChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

class Base64StreamDecoder implements StreamDecoder {
  private _remainder: Uint8Array | null = null;
  private _chars: string;

  constructor(urlSafe: boolean) {
    this._chars = urlSafe ? _b64UrlChars : _b64Chars;
  }

  decode(input: Uint8Array, options?: { stream?: boolean }): string {
    let data: Uint8Array;
    if (this._remainder) {
      const merged = new Uint8Array(this._remainder.length + input.length);
      merged.set(this._remainder);
      merged.set(input, this._remainder.length);
      data = merged;
    } else {
      data = input;
    }

    const streaming = options?.stream ?? false;

    // Base64 encodes 3 bytes into 4 chars. In streaming mode, hold back
    // any incomplete group so the next chunk can complete it.
    if (streaming) {
      const excess = data.length % 3;
      const processLen = data.length - excess;
      this._remainder = excess > 0 ? data.slice(processLen) : null;
      return processLen > 0 ? this._encodeBytes(data, processLen) : "";
    }

    // Non-streaming (final flush): encode everything including partial group.
    this._remainder = null;
    return data.length > 0 ? this._encodeBytes(data, data.length) : "";
  }

  private _encodeBytes(data: Uint8Array, len: number): string {
    const chars = this._chars;
    const urlSafe = chars === _b64UrlChars;
    let result = "";

    let i = 0;
    // Encode complete 3-byte groups.
    for (; i + 2 < len; i += 3) {
      const b0 = data[i]!;
      const b1 = data[i + 1]!;
      const b2 = data[i + 2]!;
      result +=
        chars[b0 >>> 2]! +
        chars[((b0 & 0x03) << 4) | (b1 >>> 4)]! +
        chars[((b1 & 0x0f) << 2) | (b2 >>> 6)]! +
        chars[b2 & 0x3f]!;
    }

    // Handle remaining 1 or 2 bytes (with padding for standard base64).
    const remaining = len - i;
    if (remaining === 1) {
      const b0 = data[i]!;
      result += chars[b0 >>> 2]! + chars[(b0 & 0x03) << 4]!;
      if (!urlSafe) {
        result += "==";
      }
    } else if (remaining === 2) {
      const b0 = data[i]!;
      const b1 = data[i + 1]!;
      result +=
        chars[b0 >>> 2]! + chars[((b0 & 0x03) << 4) | (b1 >>> 4)]! + chars[(b1 & 0x0f) << 2]!;
      if (!urlSafe) {
        result += "=";
      }
    }

    return result;
  }
}

// -- ASCII decoder (7-bit masking, matches Node.js StringDecoder) -------------

/** Decode bytes as ASCII (7-bit masked). Stateless. */
function asciiStreamDecode(input: Uint8Array): string {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    result += String.fromCharCode(input[i]! & 0x7f);
  }
  return result;
}

// =============================================================================
// One-shot byte→string decode (Node.js Buffer.toString parity)
// =============================================================================

/** Encode bytes as a lowercase hex string (pure function, no state). */
function _hexEncode(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += hexTable[bytes[i]!];
  }
  return result;
}

/** Encode bytes as base64 / base64url (pure function, no state). */
function _base64Encode(bytes: Uint8Array, urlSafe: boolean): string {
  const chars = urlSafe ? _b64UrlChars : _b64Chars;
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    result +=
      chars[b0 >>> 2]! +
      chars[((b0 & 0x03) << 4) | (b1 >>> 4)]! +
      chars[((b1 & 0x0f) << 2) | (b2 >>> 6)]! +
      chars[b2 & 0x3f]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    result += chars[b0 >>> 2]! + chars[(b0 & 0x03) << 4]!;
    if (!urlSafe) {
      result += "==";
    }
  } else if (remaining === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    result += chars[b0 >>> 2]! + chars[((b0 & 0x03) << 4) | (b1 >>> 4)]! + chars[(b1 & 0x0f) << 2]!;
    if (!urlSafe) {
      result += "=";
    }
  }
  return result;
}

/** Decode bytes as 7-bit ASCII (pure function, no state). */
function _asciiEncode(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i]! & 0x7f);
  }
  return result;
}

/**
 * Decode a Uint8Array to a string using the given encoding.
 *
 * Supports the full set of Node.js Buffer encodings:
 * `utf8`, `utf-8`, `latin1`, `binary`, `ascii`, `hex`, `base64`, `base64url`,
 * `utf16le`, `utf-16le`, `ucs2`, `ucs-2`.
 *
 * This is the browser-side equivalent of `Buffer.prototype.toString(encoding)`.
 * All encode paths are pure functions with no shared mutable state.
 */
export function decodeBytesToString(bytes: Uint8Array, encoding?: string): string {
  const enc = normalizeEncodingLabel(encoding);
  switch (enc) {
    case "hex":
      return _hexEncode(bytes);
    case "base64":
      return _base64Encode(bytes, false);
    case "base64url":
      return _base64Encode(bytes, true);
    case "ascii":
      return _asciiEncode(bytes);
    default:
      return getTextDecoder(enc).decode(bytes);
  }
}

// =============================================================================
// Binary Operations
// =============================================================================

/**
 * Convert string to Uint8Array using cached encoder
 */
export function stringToUint8Array(str: string): Uint8Array {
  return textEncoder.encode(str);
}

/**
 * Convert Uint8Array to string using cached decoder
 */
export function uint8ArrayToString(arr: Uint8Array, encoding?: string): string {
  return getTextDecoder(encoding).decode(arr);
}

/**
 * Concatenate multiple Uint8Arrays efficiently
 */
export function concatUint8Arrays(arrays: readonly Uint8Array[], totalLength?: number): Uint8Array {
  const len = arrays.length;
  if (len === 0) {
    return new Uint8Array(0);
  }
  if (len === 1) {
    const single = arrays[0];
    // Ensure we always return a plain Uint8Array, not a subclass (e.g. Buffer).
    if (single.constructor === Uint8Array) {
      return single;
    }
    return new Uint8Array(single.buffer, single.byteOffset, single.byteLength);
  }

  // Calculate total length with for loop for better performance
  if (totalLength === undefined) {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += arrays[i].length;
    }
    totalLength = sum;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < len; i++) {
    const arr = arrays[i];
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}

/**
 * Compare two Uint8Arrays for equality
 */
export function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  const len = a.length;
  if (len !== b.length) {
    return false;
  }
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Find pattern in Uint8Array.
 *
 * @param haystack  The array to search in
 * @param needle    The pattern to search for
 * @param start     Start index (inclusive, default 0)
 * @param end       End index (exclusive, default haystack.length) — limits the search
 *                  region without creating a subarray view
 */
export function uint8ArrayIndexOf(
  haystack: Uint8Array,
  needle: Uint8Array,
  start = 0,
  end?: number
): number {
  const needleLen = needle.length;
  if (needleLen === 0) {
    return start;
  }

  const haystackLen = end ?? haystack.length;
  if (needleLen > haystackLen) {
    return -1;
  }

  const firstByte = needle[0];
  const last = haystackLen - needleLen;

  for (let i = start; i <= last; i++) {
    // Quick check first byte
    if (haystack[i] !== firstByte) {
      continue;
    }
    // Check rest of pattern
    let matched = true;
    for (let j = 1; j < needleLen; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i;
    }
  }

  return -1;
}

/**
 * Convert any buffer-like input to Uint8Array
 */
export function toUint8Array(input: string | Uint8Array | ArrayBuffer | number[]): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof input === "string") {
    return textEncoder.encode(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input);
  }
  throw new TypeError(`Expected Uint8Array, got ${typeof input}`);
}

/**
 * Convert Uint8Array to a Node.js Buffer view when available.
 *
 * In browser environments this returns the original Uint8Array unchanged.
 */
export function uint8ArrayToNodeBufferView(data: Uint8Array): Uint8Array {
  const bufferCtor = (
    globalThis as {
      Buffer?: {
        from: (arrayBuffer: ArrayBufferLike, byteOffset?: number, length?: number) => Uint8Array;
      };
    }
  ).Buffer;

  if (!bufferCtor) {
    return data;
  }

  return bufferCtor.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Convert collected chunks to a string.
 *
 * Common logic shared by Node.js and browser Collector `toString()`:
 * - empty → ""
 * - string chunks → fast path (single return / join)
 * - binary chunks → decode via the provided `toUint8Array` callback
 */
export function chunksToString(chunks: unknown[], toBytes: () => Uint8Array): string {
  const len = chunks.length;
  if (len === 0) {
    return "";
  }

  const first = chunks[0];
  if (typeof first === "string") {
    if (len === 1) {
      return first;
    }
    return (chunks as string[]).join("");
  }

  return textDecoder.decode(toBytes());
}
