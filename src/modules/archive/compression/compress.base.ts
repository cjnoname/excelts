/**
 * Base compression utilities using Web Streams API
 * Shared between Node.js and Browser implementations
 *
 * Uses CompressionStream/DecompressionStream API with "deflate-raw" format
 * (raw DEFLATE without zlib header/trailer, required for ZIP files)
 *
 * Browser fallback: For browsers without deflate-raw support (Firefox < 113, Safari < 16.4),
 * see deflate-fallback.ts for pure JS implementation
 */

import { ByteQueue } from "@archive/core/byte-queue";
import { ArchiveError } from "@archive/core/errors";

/**
 * Compression options
 */
export interface CompressOptions {
  /**
   * Compression level (0-9)
   * - 0: No compression (STORE)
   * - 1: Fastest compression
   * - 6: Default compression (good balance)
   * - 9: Best compression (slowest)
   *
   * Note: CompressionStream does not support level configuration,
   * it uses a fixed level (~6)
   */
  level?: number;

  /**
   * Threshold (in bytes) to choose sync vs async path (Node.js only).
   * - Node.js: inputs <= threshold use sync zlib (avoid threadpool overhead)
   *
   * This option is ignored in browsers.
   * Default: 8MB.
   */
  thresholdBytes?: number;

  /**
   * Use Web Workers for compression/decompression (browser only).
   * - true: Always use worker
   * - false: Never use worker
   * - undefined: Auto-detect based on data size (use worker when >= autoWorkerThreshold)
   *
   * Note: This option is ignored in Node.js (which uses native zlib thread pool).
   */
  useWorker?: boolean;

  /**
   * Threshold (in bytes) for auto-worker decision (browser only).
   * When useWorker is undefined, data >= this threshold will use workers.
   *
   * Default: 1MB.
   */
  autoWorkerThreshold?: number;

  /**
   * Allow transferring the input buffer to the worker (browser only).
   * When true, the input buffer will be transferred (zero-copy) and become unusable.
   *
   * Use this for better performance when you don't need the input data after compression.
   */
  allowTransfer?: boolean;

  /**
   * Abort signal for cancellation when using worker pool (browser only).
   *
   * Note: This option is ignored in Node.js.
   */
  signal?: AbortSignal;
}

/**
 * Default threshold (in bytes) to choose the lower-overhead path.
 *
 * This is a performance knob, not a correctness requirement.
 * Default: 8MB.
 */
export const DEFAULT_COMPRESS_THRESHOLD_BYTES = 8 * 1024 * 1024;

/**
 * Resolve the effective threshold bytes.
 */
export function resolveCompressThresholdBytes(options: CompressOptions): number {
  const value = options.thresholdBytes;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_COMPRESS_THRESHOLD_BYTES;
  }
  return value;
}

/**
 * Check if CompressionStream is available
 */
export function hasCompressionStream(): boolean {
  return typeof CompressionStream !== "undefined";
}

/**
 * Non-cached probe for CompressionStream("deflate-raw") support.
 *
 * Prefer this in code paths that want up-to-date environment checks
 * (e.g. tests that stub globals).
 */
export function probeDeflateRawCompressionStream(): boolean {
  try {
    if (typeof CompressionStream === "undefined") {
      return false;
    }
    new CompressionStream("deflate-raw");
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-cached probe for DecompressionStream("deflate-raw") support.
 */
export function probeDeflateRawDecompressionStream(): boolean {
  try {
    if (typeof DecompressionStream === "undefined") {
      return false;
    }
    new DecompressionStream("deflate-raw");
    return true;
  } catch {
    return false;
  }
}

let _hasDeflateRawCompressionStream: boolean | null = null;
let _hasDeflateRawDecompressionStream: boolean | null = null;

/**
 * Check if CompressionStream supports the "deflate-raw" format.
 *
 * This is a stricter check than {@link hasCompressionStream} because some
 * environments expose CompressionStream but do not support "deflate-raw".
 */
export function hasDeflateRawCompressionStream(): boolean {
  if (typeof CompressionStream === "undefined") {
    return false;
  }

  if (_hasDeflateRawCompressionStream !== null) {
    return _hasDeflateRawCompressionStream;
  }

  _hasDeflateRawCompressionStream = probeDeflateRawCompressionStream();

  return _hasDeflateRawCompressionStream;
}

/**
 * Check if DecompressionStream supports the "deflate-raw" format.
 */
export function hasDeflateRawDecompressionStream(): boolean {
  if (typeof DecompressionStream === "undefined") {
    return false;
  }

  if (_hasDeflateRawDecompressionStream !== null) {
    return _hasDeflateRawDecompressionStream;
  }

  _hasDeflateRawDecompressionStream = probeDeflateRawDecompressionStream();

  return _hasDeflateRawDecompressionStream;
}

/**
 * Cached check for full deflate-raw Web Streams support.
 *
 * Returns true only if BOTH CompressionStream("deflate-raw") and
 * DecompressionStream("deflate-raw") are supported.
 */
export function hasDeflateRawWebStreams(): boolean {
  return hasDeflateRawCompressionStream() && hasDeflateRawDecompressionStream();
}

export async function streamToUint8Array(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<Uint8Array> {
  const out = new ByteQueue();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out.append(value);
  }

  return out.read(out.length);
}

export async function transformWithStream(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  try {
    // Start reading immediately to avoid potential backpressure deadlocks
    // (writer.write/close may wait for the readable side to be consumed).
    const readPromise = streamToUint8Array(reader);

    await writer.write(data as BufferSource);
    await writer.close();

    return await readPromise;
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Compress using CompressionStream API
 * Uses "deflate-raw" format (required for ZIP files)
 *
 * @param data - Data to compress
 * @returns Compressed data
 */
export async function compressWithStream(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  return transformWithStream(data, cs);
}

/**
 * Decompress using DecompressionStream API
 *
 * @param data - Compressed data (deflate-raw format)
 * @returns Decompressed data
 */
export async function decompressWithStream(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  return transformWithStream(data, ds);
}

// =============================================================================
// Adler-32 Checksum (RFC 1950)
// =============================================================================

const ADLER32_MOD = 65521;

/**
 * Compute Adler-32 checksum of data.
 *
 * Adler-32 is used in the Zlib format trailer (RFC 1950).
 * It's faster than CRC32 but has weaker error detection.
 *
 * @param data - Input data
 * @returns 32-bit Adler-32 checksum
 */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;

  // Process in chunks of 5552 bytes to avoid overflow before modulo
  // 255 * 5552 = 1,415,760 < 2^31 - 1
  const chunkSize = 5552;

  for (let i = 0; i < data.length;) {
    const end = Math.min(i + chunkSize, data.length);
    while (i < end) {
      a += data[i++];
      b += a;
    }
    a %= ADLER32_MOD;
    b %= ADLER32_MOD;
  }

  return (b << 16) | a;
}

// =============================================================================
// GZIP Format Constants (RFC 1952)
// =============================================================================

/** GZIP magic number byte 1 */
export const GZIP_ID1 = 0x1f;

/** GZIP magic number byte 2 */
export const GZIP_ID2 = 0x8b;

/** Compression method: DEFLATE */
export const GZIP_CM_DEFLATE = 8;

// Header flags
export const GZIP_FLAG_FTEXT = 0x01;
export const GZIP_FLAG_FHCRC = 0x02;
export const GZIP_FLAG_FEXTRA = 0x04;
export const GZIP_FLAG_FNAME = 0x08;
export const GZIP_FLAG_FCOMMENT = 0x10;

/** Minimum valid GZIP size: 10-byte header + 8-byte trailer */
export const GZIP_MIN_SIZE = 18;

/**
 * Check if data appears to be GZIP compressed (magic number check)
 */
export function isGzipData(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === GZIP_ID1 && data[1] === GZIP_ID2;
}

// =============================================================================
// Native Stream Detection Factory
// =============================================================================

type StreamFormat = "deflate-raw" | "deflate" | "gzip";

/** Cache for stream format support detection */
const streamSupportCache: Record<string, boolean | null> = {};

/**
 * Factory to create cached stream format detection functions.
 * Reduces code duplication for hasGzip*, hasDeflate* etc.
 */
function createStreamFormatChecker(
  streamClass: "compression" | "decompression",
  format: StreamFormat
): () => boolean {
  const cacheKey = `${streamClass}:${format}`;

  return () => {
    const StreamCtor =
      streamClass === "compression"
        ? typeof CompressionStream !== "undefined"
          ? CompressionStream
          : undefined
        : typeof DecompressionStream !== "undefined"
          ? DecompressionStream
          : undefined;

    if (!StreamCtor) {
      return false;
    }

    const cached = streamSupportCache[cacheKey];
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    try {
      new StreamCtor(format as CompressionFormat);
      streamSupportCache[cacheKey] = true;
    } catch {
      streamSupportCache[cacheKey] = false;
    }
    return streamSupportCache[cacheKey]!;
  };
}

// GZIP stream detection
export const hasGzipCompressionStream = createStreamFormatChecker("compression", "gzip");
export const hasGzipDecompressionStream = createStreamFormatChecker("decompression", "gzip");

// Zlib ("deflate") stream detection
export const hasDeflateCompressionStream = createStreamFormatChecker("compression", "deflate");
export const hasDeflateDecompressionStream = createStreamFormatChecker("decompression", "deflate");

// =============================================================================
// Zlib Format Constants (RFC 1950)
// =============================================================================

/**
 * Zlib compression method: DEFLATE (8)
 * Stored in lower 4 bits of CMF byte
 */
export const ZLIB_CM_DEFLATE = 8;

/**
 * Maximum window size exponent for CINFO field (7 = 32KB window)
 * Stored in upper 4 bits of CMF byte
 */
export const ZLIB_CINFO_MAX = 7;

/**
 * Minimum valid Zlib size: 2-byte header + 4-byte Adler-32 trailer
 */
export const ZLIB_MIN_SIZE = 6;

/**
 * Check if data appears to be Zlib compressed.
 *
 * Zlib header format (RFC 1950):
 * - Byte 0 (CMF): CM (4 bits) + CINFO (4 bits)
 *   - CM must be 8 (DEFLATE)
 *   - CINFO must be <= 7
 * - Byte 1 (FLG): FCHECK (5 bits) + FDICT (1 bit) + FLEVEL (2 bits)
 *   - FCHECK: (CMF * 256 + FLG) % 31 == 0
 *
 * This distinguishes Zlib from:
 * - GZIP: starts with 0x1f 0x8b
 * - Raw DEFLATE: first byte typically doesn't satisfy zlib checksum
 */
export function isZlibData(data: Uint8Array): boolean {
  if (data.length < 2) {
    return false;
  }

  const cmf = data[0];
  const flg = data[1];

  // Check compression method is DEFLATE (lower 4 bits of CMF == 8)
  const cm = cmf & 0x0f;
  if (cm !== ZLIB_CM_DEFLATE) {
    return false;
  }

  // Check CINFO (upper 4 bits of CMF) is <= 7
  const cinfo = cmf >> 4;
  if (cinfo > ZLIB_CINFO_MAX) {
    return false;
  }

  // Check FCHECK: (CMF * 256 + FLG) must be divisible by 31
  const check = (cmf << 8) | flg;
  return check % 31 === 0;
}

/**
 * Detect the compression format of data.
 *
 * Returns:
 * - "gzip": GZIP format (RFC 1952)
 * - "zlib": Zlib format (RFC 1950)
 * - "deflate-raw": Raw DEFLATE (RFC 1951) or unknown
 */
export function detectCompressionFormat(data: Uint8Array): "gzip" | "zlib" | "deflate-raw" {
  if (isGzipData(data)) {
    return "gzip";
  }
  if (isZlibData(data)) {
    return "zlib";
  }
  return "deflate-raw";
}

// =============================================================================
// Zlib Header/Trailer Builders (for browser fallback)
// =============================================================================

/**
 * Pre-computed Zlib headers for common compression levels.
 * CMF=0x78 (CM=8 DEFLATE, CINFO=7 32KB window), FLG computed for FCHECK.
 */
const ZLIB_HEADERS: Record<number, Uint8Array> = {
  0: new Uint8Array([0x78, 0x01]), // FLEVEL=0 (fastest)
  1: new Uint8Array([0x78, 0x01]), // FLEVEL=0
  2: new Uint8Array([0x78, 0x5e]), // FLEVEL=1 (fast)
  3: new Uint8Array([0x78, 0x5e]), // FLEVEL=1
  4: new Uint8Array([0x78, 0x5e]), // FLEVEL=1
  5: new Uint8Array([0x78, 0x5e]), // FLEVEL=1
  6: new Uint8Array([0x78, 0x9c]), // FLEVEL=2 (default)
  7: new Uint8Array([0x78, 0xda]), // FLEVEL=3 (max)
  8: new Uint8Array([0x78, 0xda]), // FLEVEL=3
  9: new Uint8Array([0x78, 0xda]) // FLEVEL=3
};

/**
 * Get Zlib header for a given compression level.
 */
export function getZlibHeader(level: number): Uint8Array {
  return ZLIB_HEADERS[Math.max(0, Math.min(9, level))] ?? ZLIB_HEADERS[6];
}

/**
 * Build Zlib trailer (4 bytes) - Adler-32 checksum (big-endian)
 */
export function buildZlibTrailer(adlerValue: number): Uint8Array {
  const trailer = new Uint8Array(4);
  trailer[0] = (adlerValue >>> 24) & 0xff;
  trailer[1] = (adlerValue >>> 16) & 0xff;
  trailer[2] = (adlerValue >>> 8) & 0xff;
  trailer[3] = adlerValue & 0xff;
  return trailer;
}

/**
 * Parse Zlib header and extract offset to DEFLATE payload.
 * Returns the byte offset where raw DEFLATE data starts.
 * @throws If header is invalid or uses preset dictionary.
 */
export function parseZlibHeader(data: Uint8Array): number {
  if (data.length < ZLIB_MIN_SIZE) {
    throw new ArchiveError("Invalid zlib data (too small)");
  }

  const cmf = data[0];
  const flg = data[1];

  if ((cmf & 0x0f) !== ZLIB_CM_DEFLATE) {
    throw new ArchiveError("Invalid zlib compression method");
  }
  if (cmf >> 4 > ZLIB_CINFO_MAX) {
    throw new ArchiveError("Invalid zlib CINFO value");
  }
  if (((cmf << 8) | flg) % 31 !== 0) {
    throw new ArchiveError("Invalid zlib header checksum");
  }
  if (flg & 0x20) {
    throw new ArchiveError("Zlib preset dictionary not supported");
  }

  return 2; // header size without FDICT
}

/**
 * Read Adler-32 from Zlib trailer (big-endian).
 */
export function readZlibTrailer(data: Uint8Array): number {
  const off = data.length - 4;
  // Use >>> 0 to ensure unsigned 32-bit result
  return ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
}

/**
 * Verify Adler-32 checksum.
 * @throws If checksum doesn't match.
 */
export function verifyAdler32(data: Uint8Array, expected: number): void {
  const actual = adler32(data) >>> 0;
  if (actual !== expected >>> 0) {
    throw new ArchiveError("Invalid zlib data (Adler-32 mismatch)");
  }
}
