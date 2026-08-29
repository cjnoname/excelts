/**
 * Members expected on the `Archive` domain namespace
 * (`export * as Archive`). Platform-agnostic high-level API, available in all
 * environments (Node.js + browser).
 */
export const ARCHIVE_NAMESPACE_EXPORTS = [
  // ArchiveSource adapters
  "toAsyncIterable",
  "toReadableStream",

  // High-level archive API
  "zip",
  "editZip",
  "editZipUrl",
  "unzip",
  "ZipArchive",
  "ZipEditor",
  "ZipEditPlan",
  "ZipReader",
  "UnzipEntry",

  // TAR archive support (basic - no gzip)
  "TAR_BLOCK_SIZE",
  "TAR_TYPE",
  "TarArchive",
  "TarReader",
  "createTarReaderEntry",
  "createTarArchive",
  "createTarReader",
  "tar",
  "tarSync",
  "parseTar",
  "parseTarStream",
  "untar",
  "isTarFile",
  "isTarDirectory",
  "isTarSymlink",
  "isTarHardLink",
  "isTarDataEntry",

  // Random access / HTTP Range reading
  "HttpRangeReader",
  "createBufferReader",
  "RemoteZipReader",

  // Abort utilities
  "createAbortError",
  "isAbortError",
  "throwIfAborted",

  // Crypto - ZipCrypto
  "zipCryptoInitKeys",
  "zipCryptoDecrypt",
  "zipCryptoEncrypt",
  "ZIP_CRYPTO_HEADER_SIZE",

  // Crypto - AES
  "aesDecrypt",
  "aesEncrypt",
  "aesEncryptedSize",
  "buildAesExtraField",
  "randomBytes",
  "getAesKeyStrength",
  "encryptionMethodFromAesKeyStrength",
  "getEncryptionMethodName",
  "isAesEncryption",

  // AES constants
  "AES_AUTH_CODE_LENGTH",
  "AES_EXTRA_FIELD_ID",
  "AES_KEY_LENGTH",
  "AES_PASSWORD_VERIFY_LENGTH",
  "AES_SALT_LENGTH",
  "AES_VENDOR_ID",
  "AES_VERSION_AE1",
  "AES_VERSION_AE2",
  "COMPRESSION_METHOD_AES",

  // Binary / encoding utilities
  "base64ToUint8Array",
  "uint8ArrayToBase64",
  "concatUint8Arrays",
  "stringToUint8Array",
  "uint8ArrayToString"
] as const;

/**
 * Core top-level archive exports available in all environments
 * (Node.js + browser). The high-level API now lives on the `Archive`
 * namespace; the top level keeps the domain namespace, platform-specific
 * compression/CRC primitives, and error classes.
 */
export const ARCHIVE_BROWSER_EXPORTS = [
  // Domain namespace
  "Archive",

  // CRC32 (platform-specific implementation)
  "crc32",
  "crc32Update",
  "crc32Finalize",

  // Compression
  "compress",
  "compressSync",
  "decompress",
  "decompressSync",
  "hasCompressionStream",
  "hasWorkerSupport",

  // Streaming compression
  "createDeflateStream",
  "createInflateStream",
  "createGzipStream",
  "createGunzipStream",
  "createZlibStream",
  "createUnzlibStream",
  "hasDeflateRaw",
  "hasGzipCompressionStream",
  "hasGzipDecompressionStream",
  "isGzipData",

  // GZIP compression (available in both Node.js and browser)
  "gzip",
  "gunzip",
  "gzipSync",
  "gunzipSync",
  "GZIP_ID1",
  "GZIP_ID2",

  // Zlib compression (RFC 1950)
  "zlib",
  "unzlib",
  "zlibSync",
  "unzlibSync",
  "isZlibData",
  "ZLIB_CM_DEFLATE",
  "ZLIB_CINFO_MAX",
  "ZLIB_MIN_SIZE",

  // Auto-detect decompression
  "decompressAuto",
  "decompressAutoSync",
  "detectCompressionFormat",

  // PNG encoding — a DEFLATE stream plus CRC-32-checked chunks, so it lives
  // beside the two primitives it is built from.
  "encodePng",

  // Worker Pool (browser-only functionality, stub in Node)
  "WorkerPool",
  "getDefaultWorkerPool",
  "terminateDefaultWorkerPool",
  "deflateWithPool",
  "inflateWithPool",
  "deflateBatchWithPool",
  "inflateBatchWithPool",

  // Error types
  "ArchiveError",
  "AbortError",
  "ZipParseError",
  "InvalidZipSignatureError",
  "EocdNotFoundError",
  "Crc32MismatchError",
  "EntrySizeMismatchError",
  "DecryptionError",
  "PasswordRequiredError",
  "RangeNotSupportedError",
  "HttpRangeError",
  "FileTooLargeError",
  "UnsupportedCompressionError"
] as const;

/**
 * File system convenience layer exports (Node.js only)
 */
export const ARCHIVE_NODE_EXPORTS = [
  // Node stream adapter
  "toNodeReadable",

  "ArchiveFile",
  "traverseDirectory",
  "traverseDirectorySync",
  "glob",
  "globSync",
  "globToRegex",
  "matchGlob",
  "matchGlobAny",
  "ensureDir",
  "ensureDirSync",
  "fileExists",
  "fileExistsSync",
  "readFileBytes",
  "readFileBytesSync",
  "writeFileBytes",
  "writeFileBytesSync",
  "setFileTime",
  "setFileTimeSync",
  "safeStats",
  "safeStatsSync",
  "readFileText",
  "readFileTextSync",
  "writeFileText",
  "writeFileTextSync",
  "remove",
  "removeSync",
  "copyFile",
  "copyFileSync",
  "createReadStream",
  "createWriteStream",
  "createTempDir",
  "createTempDirSync",

  // TAR + Gzip support (Node.js only - requires zlib for streaming)
  "TarGzArchive",
  "targz",
  "parseTarGz",
  "parseTarGzStream",
  "untargz"
] as const;

/**
 * All archive exports (Node.js environment)
 */
export const ARCHIVE_RUNTIME_EXPORTS = [
  ...ARCHIVE_BROWSER_EXPORTS,
  ...ARCHIVE_NODE_EXPORTS
] as const;

export type ArchiveNamespaceExport = (typeof ARCHIVE_NAMESPACE_EXPORTS)[number];
export type ArchiveBrowserExport = (typeof ARCHIVE_BROWSER_EXPORTS)[number];
export type ArchiveNodeExport = (typeof ARCHIVE_NODE_EXPORTS)[number];
export type ArchiveRuntimeExport = (typeof ARCHIVE_RUNTIME_EXPORTS)[number];

export function getRuntimeExportKeys(moduleNamespace: object): string[] {
  return Object.keys(moduleNamespace).sort();
}
