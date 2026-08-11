/**
 * Archive (ZIP) module - unified ZIP + Unzip implementation.
 *
 * This module is intended to be extractable as a standalone package.
 * It groups all ZIP creation and extraction utilities in one place.
 */

export * from "@archive/index.base";

// CRC32
export { crc32, crc32Update, crc32Finalize } from "@archive/compression/crc32";

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
} from "@archive/compression/compress";

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
} from "@archive/compression/streaming-compress";

// Worker Pool (stub exports for API parity - only functional in browser)
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
} from "@archive/compression/worker-pool";

// Node.js file system convenience layer
export * from "@archive/fs";

// Node stream adapter helpers
export { toNodeReadable } from "@archive/io/archive-source.node";

// TAR + Gzip support (Node.js only - requires zlib)
export {
  TarGzArchive,
  targz,
  parseTarGz,
  parseTarGzStream,
  untargz,
  type TarGzOptions,
  type ParseTarGzOptions
} from "@archive/tar/tar-gzip";
