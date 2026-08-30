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

// =============================================================================
// Little-endian scalar IO
// =============================================================================

// Every binary container this library speaks — ZIP local/central headers, BIFF12
// records, CFB sector tables, PNG's one big-endian exception aside — is a stream
// of little-endian fixed-width integers. This section is the single
// implementation of that, and it lives at Layer 0 because `archive/` (ZIP),
// `excel/` (BIFF12) and `word/` (CFB) all need it and none of them may import
// each other.
//
// Two shapes, and the split is about allocation rather than taste:
//
//   * The free functions take an explicit offset and use byte arithmetic, so a
//     handful of reads at known positions costs nothing. Reaching for a
//     `DataView` here would allocate one per call.
//   * `BinaryReader` caches a single `DataView` and advances a cursor, which is
//     what you want when decoding a record field by field. `getFloat64` has no
//     cheap byte-arithmetic equivalent, so sequential decoding needs the view
//     anyway.
//
// Mixing the two up is a measurable mistake in both directions, which is why
// both are here with the reason attached.
//
// Both shapes reject an out-of-range read rather than returning a value built
// from missing bytes. That is not defensive habit: indexing past the end of a
// `Uint8Array` yields `undefined`, and `undefined | 0` is `0`, so a truncated
// four-byte field silently reads as a plausible smaller number. A ZIP with two
// bytes where a signature belongs would report "invalid signature" instead of
// "truncated", and a CRC field short by one byte would report a mismatch — both
// blaming the wrong thing at the wrong offset. `DataView` throws here, and
// replacing it with byte arithmetic must not quietly give that up.

/** Assert that `count` bytes are readable at `offset`. */
function requireBytes(bytes: Uint8Array, offset: number, count: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + count > bytes.length) {
    throw new RangeError(
      `cannot read ${count} byte(s) at offset ${offset}: length is ${bytes.length}`
    );
  }
}

/** Read an unsigned 16-bit little-endian integer at `offset`. */
export function readUint16LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 2);
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

/** Read an unsigned 32-bit little-endian integer at `offset`. */
export function readUint32LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 4);
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** Read a signed 32-bit little-endian integer at `offset`. */
export function readInt32LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 4);
  return (
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
  );
}

/** Encode an unsigned 16-bit little-endian integer as 2 bytes. */
export function writeUint16LE(value: number): Uint8Array {
  const out = new Uint8Array(2);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  return out;
}

/** Encode an unsigned 32-bit little-endian integer as 4 bytes. */
export function writeUint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

// A shared 8-byte scratch view for the float conversions in the free-function
// path. Allocating a DataView to encode one number is the thing this section
// exists to avoid, and the conversions are synchronous and non-reentrant, so one
// scratch buffer is safe.
const _scratch = new DataView(new ArrayBuffer(8));

/** Read a 64-bit little-endian IEEE 754 double at `offset`. */
export function readFloat64LE(bytes: Uint8Array, offset: number): number {
  requireBytes(bytes, offset, 8);
  for (let i = 0; i < 8; i++) {
    _scratch.setUint8(i, bytes[offset + i]);
  }
  return _scratch.getFloat64(0, true);
}

/** Encode a 64-bit little-endian IEEE 754 double as 8 bytes. */
export function writeFloat64LE(value: number): Uint8Array {
  _scratch.setFloat64(0, value, true);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = _scratch.getUint8(i);
  }
  return out;
}

/**
 * Sequential little-endian reader over a byte range.
 *
 * The `DataView` is built once in the constructor rather than per read — a
 * record decoder performs tens of reads per record and hundreds of thousands per
 * worksheet, and allocating a view for each one both costs an allocation and
 * stops the read from inlining.
 *
 * Every read is bounds-checked and reports the cursor position, because the
 * alternative — letting `DataView` throw its own `RangeError` — tells you that
 * something was out of range but not where you were in the stream, which is the
 * only useful part when the input is a few megabytes of binary records.
 */
export class BinaryReader {
  private readonly view: DataView;
  private readonly data: Uint8Array;
  private readonly label: string;
  private offset: number;

  /**
   * @param data   Bytes to read. Views are honoured; the reader never copies.
   * @param offset Initial cursor position, relative to `data`.
   * @param label  Named in bounds-error messages, e.g. a part or record name.
   */
  constructor(data: Uint8Array, offset = 0, label = "binary stream") {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.label = label;
    this.offset = 0;
    this.position = offset;
  }

  get position(): number {
    return this.offset;
  }

  /**
   * Move the cursor.
   *
   * Validated for the same reason the reads are: a position derived from a
   * declared offset in the input can be negative, fractional or past the end, and
   * an unvalidated cursor turns that into a `remaining` of `NaN` or a negative
   * number. From there every subsequent bounds check silently passes or fails for
   * the wrong reason, and the error surfaces far from the field that was wrong.
   */
  set position(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > this.data.length) {
      throw new RangeError(
        `${this.label}: cannot seek to ${value} — length is ${this.data.length}`
      );
    }
    this.offset = value;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  /** The bytes this reader was constructed over, unsliced. */
  get bytes(): Uint8Array {
    return this.data;
  }

  /**
   * Assert that `length` more bytes are available.
   *
   * Public because a decoder that is about to read a variable-length field
   * usually wants to reject an absurd declared length before allocating for it,
   * rather than after.
   */
  require(length: number): void {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new RangeError(
        `${this.label}: truncated at byte ${this.offset} — need ${length} byte(s), ${this.remaining} remain`
      );
    }
  }

  readUint8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt8(): number {
    this.require(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readInt16(): number {
    this.require(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readInt32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readBigUint64(): bigint {
    this.require(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /** Read `length` bytes as a view into the source — never a copy. */
  readBytes(length: number): Uint8Array {
    this.require(length);
    const bytes = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  skip(length: number): void {
    this.require(length);
    this.offset += length;
  }

  /**
   * A view into the source between two absolute positions.
   *
   * Deliberately `subarray` semantics — clamped, negative indices count from the
   * end — because that is what a method named `slice` is expected to do, and the
   * ZIP parsers are written against it. It is not a bounds-checked read: use the
   * cursor reads when a short range should be reported as truncation.
   */
  slice(start: number, end: number): Uint8Array {
    return this.data.subarray(start, end);
  }

  /** Read a uint32 at an absolute offset without moving the cursor. */
  peekUint32(offset: number): number {
    // `Number.isInteger` first: every comparison against `NaN` is false, so a
    // range check alone lets `NaN` through, and `DataView` then coerces it to 0
    // and returns the *first* uint32 in the stream as though it were the one
    // asked for.
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > this.data.length) {
      throw new RangeError(
        `${this.label}: cannot peek 4 byte(s) at ${offset} — length is ${this.data.length}`
      );
    }
    return this.view.getUint32(offset, true);
  }
}

/**
 * Growable little-endian byte sink.
 *
 * Chunks are collected and joined once on `toUint8Array()`, which is both faster
 * and simpler than repeatedly reallocating a single buffer, and it lets a caller
 * hand over an already-built payload with `writeBytes` without a copy into an
 * intermediate.
 */
export class BinaryWriter {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;

  /** Bytes written so far. */
  get length(): number {
    return this.total;
  }

  writeUint8(value: number): this {
    return this.push(Uint8Array.of(value & 0xff));
  }

  writeUint16(value: number): this {
    return this.push(writeUint16LE(value));
  }

  writeUint32(value: number): this {
    return this.push(writeUint32LE(value));
  }

  writeInt32(value: number): this {
    return this.push(writeUint32LE(value >>> 0));
  }

  writeFloat64(value: number): this {
    return this.push(writeFloat64LE(value));
  }

  /** Append bytes verbatim. The chunk is referenced, not copied. */
  writeBytes(chunk: Uint8Array): this {
    return chunk.length === 0 ? this : this.push(chunk);
  }

  /** Append `count` zero bytes — reserved or unused spec fields. */
  writeZeros(count: number): this {
    // A count, unlike a value, has no sensible coercion. `writeZeros(1.9)` would
    // be truncated to one byte by `Uint8Array` and `writeZeros(-4)` silently does
    // nothing, so a caller that mis-derived a reserved-field width from the input
    // would emit a differently shaped record and find out much later.
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`byte count must be a non-negative integer: ${count}`);
    }
    return count === 0 ? this : this.push(new Uint8Array(count));
  }

  toUint8Array(): Uint8Array {
    return concatUint8Arrays(this.chunks, this.total);
  }

  private push(chunk: Uint8Array): this {
    this.chunks.push(chunk);
    this.total += chunk.length;
    return this;
  }
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
