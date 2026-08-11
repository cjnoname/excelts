/**
 * Archive (ZIP) module - unified ZIP + Unzip implementation (browser type surface).
 *
 * This file mirrors [src/modules/archive/index.ts] but explicitly re-exports
 * browser-specific implementations so we can enforce export-surface parity.
 */

export * from "@archive/index.base";

// CRC32
export { crc32, crc32Update, crc32Finalize } from "@archive/compression/crc32.browser";

// Compression
export {
  compress,
  compressSync,
  decompress,
  decompressSync,
  gzip,
  gunzip,
  gzipSync,
  gunzipSync,
  isGzipData,
  hasCompressionStream,
  hasWorkerSupport,
  hasGzipCompressionStream,
  hasGzipDecompressionStream,
  // GZIP constants (RFC 1952)
  GZIP_ID1,
  GZIP_ID2,
  // Zlib (RFC 1950)
  zlib,
  unzlib,
  zlibSync,
  unzlibSync,
  isZlibData,
  ZLIB_CM_DEFLATE,
  ZLIB_CINFO_MAX,
  ZLIB_MIN_SIZE,
  // Auto-detect decompression
  decompressAuto,
  decompressAutoSync,
  detectCompressionFormat,
  type CompressOptions
} from "@archive/compression/compress.browser";

// Streaming compression
export {
  createDeflateStream,
  createInflateStream,
  createGzipStream,
  createGunzipStream,
  createZlibStream,
  createUnzlibStream,
  hasDeflateRaw,
  type StreamCompressOptions,
  type StreamingCodec,
  type DeflateStream,
  type InflateStream,
  type GzipStream,
  type GunzipStream,
  type ZlibStream,
  type UnzlibStream
} from "@archive/compression/streaming-compress.browser";

// Worker Pool
export {
  WorkerPool,
  getDefaultWorkerPool,
  terminateDefaultWorkerPool,
  deflateWithPool,
  inflateWithPool,
  deflateBatchWithPool,
  inflateBatchWithPool,
  type WorkerPoolOptions,
  type WorkerPoolStats,
  type TaskOptions,
  type TaskResult,
  type WorkerTaskType
} from "@archive/compression/worker-pool/index.browser";
