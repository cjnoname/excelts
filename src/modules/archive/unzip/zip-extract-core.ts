/**
 * Core ZIP extraction logic - shared between ZipParser and RemoteZipReader.
 *
 * This module provides unified functions for:
 * - Decrypting entry data (AES and ZipCrypto)
 * - Decompressing entry data
 * - Reading local file header
 * - CRC32 validation
 *
 * @module
 */

import { decompress, decompressSync } from "@archive/compression/compress";
import { crc32, crc32Finalize, crc32Update } from "@archive/compression/crc32";
import { createInflateStream } from "@archive/compression/streaming-compress";
import {
  ArchiveError,
  Crc32MismatchError,
  DecryptionError,
  EntrySizeMismatchError,
  FileTooLargeError,
  PasswordRequiredError,
  UnsupportedCompressionError,
  throwIfAborted,
  toError
} from "@archive/core/errors";
import {
  ZIP_CRYPTO_HEADER_SIZE,
  aesDecrypt,
  zipCryptoDecrypt,
  zipCryptoDecryptByte,
  zipCryptoInitKeys
} from "@archive/crypto";
import { collect } from "@archive/io/archive-sink";
import { BinaryReader } from "@archive/zip-spec/binary";
import type { ZipEntryRecord } from "@archive/zip-spec/zip-entry-info";
import {
  COMPRESSION_DEFLATE,
  COMPRESSION_STORE,
  LOCAL_FILE_HEADER_SIG
} from "@archive/zip-spec/zip-records";
import { eventedReadableToAsyncIterableNoDestroy } from "@stream/core/evented-readable-to-async-iterable";
import { concatUint8Arrays } from "@utils/binary";

/**
 * Local file header fixed size (30 bytes)
 */
export const LOCAL_HEADER_FIXED_SIZE = 30;

/**
 * Options for extracting entry data
 */
export interface ExtractCoreOptions {
  /** Password for encrypted entries */
  password?: string | Uint8Array;
  /** Whether to validate CRC32 checksum after extraction */
  checkCrc32?: boolean;
  /**
   * Whether to validate that the decompressed size matches the declared size.
   * This is a security feature to detect ZIP bombs and corrupted archives.
   * When enabled, extraction will abort early if too many bytes are produced.
   * @default true
   */
  validateEntrySizes?: boolean;
}

/**
 * Maximum allowed uncompressed entry size for non-streaming extraction (512 MB).
 * This is a pre-decompression check based on the declared size in the ZIP metadata.
 * It prevents memory exhaustion from archives that declare very large output sizes.
 * The streaming extraction path (processEntryDataStream) has its own byte-level checks.
 */
const DEFAULT_MAX_ENTRY_SIZE = 512 * 1024 * 1024;

/**
 * Process compressed (and possibly encrypted) entry data to get the final content.
 *
 * This is the core extraction logic used by both ZipParser and RemoteZipReader.
 *
 * @param entry - Entry metadata
 * @param compressedData - Raw compressed (and possibly encrypted) data from the ZIP
 * @param password - Optional password for decryption
 * @param checkCrc32 - Whether to validate CRC32 checksum (default: false)
 * @param validateEntrySizes - Whether to validate decompressed size matches declared size (default: true)
 * @returns Decompressed entry content
 */
export async function processEntryData(
  entry: ZipEntryRecord,
  compressedData: Uint8Array,
  password?: string | Uint8Array,
  checkCrc32 = false,
  validateEntrySizes = true
): Promise<Uint8Array> {
  let result: Uint8Array;

  // Pre-decompression size check: reject entries whose *declared* uncompressed size
  // exceeds the limit. This catches archives that honestly declare very large entries
  // but does NOT protect against ZIP bombs that lie about their size (for that, use
  // the streaming path processEntryDataStream which validates actual output bytes).
  if (validateEntrySizes && entry.uncompressedSize > DEFAULT_MAX_ENTRY_SIZE) {
    throw new FileTooLargeError(
      entry.path,
      `declares uncompressed size of ${entry.uncompressedSize} bytes, ` +
        `which exceeds the maximum allowed size of ${DEFAULT_MAX_ENTRY_SIZE} bytes. ` +
        "Use the streaming API for large entries."
    );
  }

  // Handle encrypted entries
  if (entry.isEncrypted) {
    if (!password) {
      throw new PasswordRequiredError(entry.path);
    }

    if (entry.encryptionMethod === "aes" && entry.aesKeyStrength) {
      // AES decryption
      const decrypted = await aesDecrypt(compressedData, password, entry.aesKeyStrength);
      if (!decrypted) {
        throw new DecryptionError(entry.path);
      }

      // Decompress if needed (use original compression method)
      result = await decompressData(
        decrypted,
        entry.originalCompressionMethod ?? COMPRESSION_STORE,
        entry.path
      );
    } else if (entry.encryptionMethod === "zipcrypto") {
      // ZipCrypto decryption
      const decrypted = zipCryptoDecrypt(compressedData, password, entry.crc32, entry.dosTime);
      if (!decrypted) {
        throw new DecryptionError(entry.path);
      }

      result = await decompressData(decrypted, entry.compressionMethod, entry.path);
    } else {
      throw new DecryptionError(entry.path, "Unsupported encryption method");
    }
  } else {
    // Non-encrypted entry
    result = await decompressData(compressedData, entry.compressionMethod, entry.path);
  }

  // Validate entry size (ZIP bomb protection)
  if (validateEntrySizes && result.length !== entry.uncompressedSize) {
    const reason = result.length > entry.uncompressedSize ? "too-many-bytes" : "too-few-bytes";
    throw new EntrySizeMismatchError(entry.path, entry.uncompressedSize, result.length, reason);
  }

  // Validate CRC32
  // Note: AES-encrypted entries don't use CRC32 (they use HMAC instead)
  // ZipCrypto: Always verify CRC32 because header verification only checks 1 byte
  // (1/256 false positive rate with wrong password per ZIP spec)
  const shouldCheckCrc =
    entry.encryptionMethod === "zipcrypto" || (checkCrc32 && entry.encryptionMethod !== "aes");
  if (shouldCheckCrc) {
    const actualCrc = crc32(result);
    if (actualCrc !== entry.crc32) {
      throw new Crc32MismatchError(entry.path, entry.crc32, actualCrc);
    }
  }

  return result;
}

/**
 * Process compressed (and possibly encrypted) entry data synchronously.
 *
 * Note: AES-encrypted files cannot be processed synchronously because
 * the Web Crypto API is async. Use processEntryData() instead.
 *
 * @param entry - Entry metadata
 * @param compressedData - Raw compressed (and possibly encrypted) data from the ZIP
 * @param password - Optional password for decryption
 * @param validateEntrySizes - Whether to validate decompressed size matches declared size (default: true)
 * @returns Decompressed entry content
 * @throws Error if the entry uses AES encryption
 */
export function processEntryDataSync(
  entry: ZipEntryRecord,
  compressedData: Uint8Array,
  password?: string | Uint8Array,
  validateEntrySizes = true
): Uint8Array {
  let result: Uint8Array;

  // Pre-decompression size check (same as async version)
  if (validateEntrySizes && entry.uncompressedSize > DEFAULT_MAX_ENTRY_SIZE) {
    throw new FileTooLargeError(
      entry.path,
      `declares uncompressed size of ${entry.uncompressedSize} bytes, ` +
        `which exceeds the maximum allowed size of ${DEFAULT_MAX_ENTRY_SIZE} bytes. ` +
        "Use the streaming API for large entries."
    );
  }

  // Handle encrypted entries
  if (entry.isEncrypted) {
    if (!password) {
      throw new PasswordRequiredError(entry.path);
    }

    if (entry.encryptionMethod === "aes") {
      // AES requires async Web Crypto API
      throw new ArchiveError(
        `File "${entry.path}" uses AES encryption. Use the async extract() method instead of extractSync().`
      );
    } else if (entry.encryptionMethod === "zipcrypto") {
      // ZipCrypto decryption (synchronous)
      const decrypted = zipCryptoDecrypt(compressedData, password, entry.crc32, entry.dosTime);
      if (!decrypted) {
        throw new DecryptionError(entry.path);
      }

      result = decompressDataSync(decrypted, entry.compressionMethod, entry.path);

      // Always verify CRC32 for ZipCrypto because header verification only checks 1 byte
      // (1/256 false positive rate with wrong password per ZIP spec)
      const actualCrc = crc32(result);
      if (actualCrc !== entry.crc32) {
        throw new Crc32MismatchError(entry.path, entry.crc32, actualCrc);
      }
    } else {
      throw new DecryptionError(entry.path, "Unsupported encryption method");
    }
  } else {
    // Non-encrypted entry
    result = decompressDataSync(compressedData, entry.compressionMethod, entry.path);
  }

  // Validate entry size (ZIP bomb protection)
  if (validateEntrySizes && result.length !== entry.uncompressedSize) {
    const reason = result.length > entry.uncompressedSize ? "too-many-bytes" : "too-few-bytes";
    throw new EntrySizeMismatchError(entry.path, entry.uncompressedSize, result.length, reason);
  }

  return result;
}

/**
 * Decompress data based on compression method (async).
 */
async function decompressData(
  data: Uint8Array,
  compressionMethod: number,
  path: string
): Promise<Uint8Array> {
  if (compressionMethod === COMPRESSION_STORE) {
    return data;
  }
  if (compressionMethod === COMPRESSION_DEFLATE) {
    return decompress(data);
  }
  throw new UnsupportedCompressionError(compressionMethod);
}

async function* decryptZipCryptoStream(
  entry: ZipEntryRecord,
  encrypted: AsyncIterable<Uint8Array>,
  password: string | Uint8Array,
  options: { signal?: AbortSignal } = {}
): AsyncIterable<Uint8Array> {
  const { signal } = options;

  const state = zipCryptoInitKeys(password);
  const header = new Uint8Array(ZIP_CRYPTO_HEADER_SIZE);
  let headerOffset = 0;
  let verified = false;

  for await (const chunk of encrypted) {
    throwIfAborted(signal);

    let offset = 0;

    // Fill and verify header first.
    if (!verified) {
      while (headerOffset < ZIP_CRYPTO_HEADER_SIZE && offset < chunk.length) {
        header[headerOffset++] = chunk[offset++]!;
      }

      if (headerOffset < ZIP_CRYPTO_HEADER_SIZE) {
        continue;
      }

      // Decrypt header in-place and verify check byte.
      let lastPlain = 0;
      for (let i = 0; i < ZIP_CRYPTO_HEADER_SIZE; i++) {
        lastPlain = zipCryptoDecryptByte(state, header[i]!);
      }

      const crcHighByte = (entry.crc32 >>> 24) & 0xff;
      const timeHighByte = entry.dosTime !== undefined ? (entry.dosTime >>> 8) & 0xff : -1;
      if (lastPlain !== crcHighByte && lastPlain !== timeHighByte) {
        throw new DecryptionError(entry.path);
      }

      verified = true;
    }

    // Decrypt remaining bytes in this chunk.
    if (offset < chunk.length) {
      const out = new Uint8Array(chunk.length - offset);
      for (let i = 0; i < out.length; i++) {
        out[i] = zipCryptoDecryptByte(state, chunk[offset + i]!);
      }
      if (out.length) {
        yield out;
      }
    }
  }

  if (!verified) {
    throw new DecryptionError(entry.path);
  }
}

async function* inflateRawStream(
  source: AsyncIterable<Uint8Array>,
  options: { signal?: AbortSignal } = {}
): AsyncIterable<Uint8Array> {
  const { signal } = options;

  const inflator = createInflateStream();

  // Consume the inflator's output through the pull-based adapter, which pauses
  // the stream after every chunk and only resumes on the consumer's next pull.
  // This propagates backpressure all the way to the decompressor (and, via its
  // write callbacks, to the input producer below) so a fast decompressor cannot
  // run ahead and buffer the whole entry — keeping peak memory at O(one chunk)
  // and making SAX-driven readers genuinely incremental. A flowing `on("data")`
  // fan-in into an unbounded queue would defeat that and inflate the whole part
  // up-front.
  //
  // Crucially we obtain the iterator (which attaches the "data"/"end"/"error"
  // listeners and pauses the stream) BEFORE starting the producer below. The
  // decompressor can reject input synchronously on the first write — without a
  // listener already attached, that "error" event would have no handler and
  // surface as an unhandled rejection.
  const iterator =
    eventedReadableToAsyncIterableNoDestroy<Uint8Array>(inflator)[Symbol.asyncIterator]();

  // Mirror the compressed input so we can re-run a deterministic pure-JS inflate
  // if the native streaming decompressor spuriously rejects valid data before
  // emitting any output (observed in Chromium under heavy concurrent
  // `DecompressionStream` creation — see compress.browser.ts). Buffering the
  // *compressed* bytes is bounded by the entry's on-disk size and only retained
  // until output starts flowing.
  const inputChunks: Uint8Array[] = [];
  let inputDrained = false;

  // Pump the compressed input into the inflator concurrently. Each `write()`
  // resolves via its callback, which the decompressor delays under backpressure,
  // so this loop self-throttles against the (paused) output side. On failure the
  // inflator is destroyed with the error: that surfaces through its "error"
  // event (forwarded by the iterator), so the consumer below rejects. The
  // producer itself never rejects, so it can never become an unhandled rejection.
  //
  // The source is always read to completion into `inputChunks` (even if the
  // inflator errors) so the pure-JS fallback below has the full compressed
  // entry available.
  const producer = (async () => {
    let writeFailed = false;
    try {
      for await (const chunk of source) {
        throwIfAborted(signal);
        inputChunks.push(chunk);
        if (writeFailed) {
          // Inflator already errored; keep draining source but skip writing.
          continue;
        }
        try {
          await new Promise<void>((resolve, reject) => {
            inflator.write(chunk, err => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          });
        } catch (e) {
          writeFailed = true;
          try {
            inflator.destroy(toError(e));
          } catch {
            // ignore
          }
        }
      }
      inputDrained = true;

      if (!writeFailed) {
        throwIfAborted(signal);
        await new Promise<void>((resolve, reject) => {
          inflator.end(err => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
    } catch (e) {
      inputDrained = true;
      try {
        inflator.destroy(toError(e));
      } catch {
        // ignore
      }
    }
  })();

  let producedOutput = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await iterator.next();
      if (done) {
        break;
      }
      producedOutput = true;
      yield value;
    }
  } catch (err) {
    throwIfAborted(signal);
    // A failure after output has started indicates genuine mid-stream
    // corruption — surface it. A failure before any output is the Chromium
    // spurious-rejection case: re-decode the (fully buffered) compressed input
    // with the deterministic pure-JS inflater, preserving streaming by
    // re-chunking the result so downstream consumers stay incremental.
    if (producedOutput) {
      throw err;
    }
    await iterator.return?.();
    await producer;
    if (!inputDrained) {
      // Source could not be fully buffered; cannot safely re-decode.
      throw err;
    }
    const compressed = concatUint8Arrays(inputChunks);
    const inflated = decompressSync(compressed);
    yield* chunkUint8Array(inflated, STREAM_RECHUNK_SIZE);
    return;
  } finally {
    // Stop the adapter (detaches listeners, pauses the stream), settle the
    // producer (it never rejects), and tear down the inflator.
    await iterator.return?.();
    await producer;
    try {
      inflator.destroy();
    } catch {
      // ignore
    }
  }
}

/** Output slice size used when re-chunking a fully-inflated buffer. */
const STREAM_RECHUNK_SIZE = 65536;

/** Split a buffer into fixed-size slices (views, no copy). */
function* chunkUint8Array(data: Uint8Array, size: number): Generator<Uint8Array> {
  for (let off = 0; off < data.length; off += size) {
    yield data.subarray(off, off + size);
  }
}

/**
 * Validate that the decompressed data size matches the declared size.
 * Throws early if too many bytes are produced (ZIP bomb protection).
 * Throws at the end if too few bytes are produced (corruption detection).
 */
async function* validateSizeStream(
  entry: ZipEntryRecord,
  source: AsyncIterable<Uint8Array>,
  options: { signal?: AbortSignal } = {}
): AsyncIterable<Uint8Array> {
  const { signal } = options;
  const expectedSize = entry.uncompressedSize;
  let totalBytes = 0;

  for await (const chunk of source) {
    throwIfAborted(signal);
    if (chunk.length) {
      totalBytes += chunk.length;
      // Early abort if too many bytes (ZIP bomb protection)
      if (totalBytes > expectedSize) {
        throw new EntrySizeMismatchError(entry.path, expectedSize, totalBytes, "too-many-bytes");
      }
      yield chunk;
    }
  }

  // Check if too few bytes at the end
  if (totalBytes < expectedSize) {
    throw new EntrySizeMismatchError(entry.path, expectedSize, totalBytes, "too-few-bytes");
  }
}

async function* validateCrc32Stream(
  entry: ZipEntryRecord,
  source: AsyncIterable<Uint8Array>,
  options: { signal?: AbortSignal } = {}
): AsyncIterable<Uint8Array> {
  const { signal } = options;
  let crc = 0xffffffff;
  for await (const chunk of source) {
    throwIfAborted(signal);
    if (chunk.length) {
      crc = crc32Update(crc, chunk);
      yield chunk;
    }
  }
  const actual = crc32Finalize(crc);
  if (actual !== entry.crc32) {
    throw new Crc32MismatchError(entry.path, entry.crc32, actual);
  }
}

/**
 * Apply validation streams (size and CRC32) to an output stream.
 * This centralizes the common pattern of chaining validation streams.
 */
function applyValidationStreams(
  entry: ZipEntryRecord,
  source: AsyncIterable<Uint8Array>,
  options: {
    validateEntrySizes: boolean;
    checkCrc32: boolean;
    signal?: AbortSignal;
  }
): AsyncIterable<Uint8Array> {
  const { validateEntrySizes, checkCrc32, signal } = options;
  let stream = source;

  // Size validation first (for early abort on ZIP bombs)
  if (validateEntrySizes) {
    stream = validateSizeStream(entry, stream, { signal });
  }

  // Then CRC32 validation
  if (checkCrc32) {
    stream = validateCrc32Stream(entry, stream, { signal });
  }

  return stream;
}

/**
 * Process entry data as an async iterable of output chunks.
 *
 * This avoids buffering the full output in memory for STORE/DEFLATE entries.
 *
 * Note: AES-encrypted entries cannot be truly streamed because HMAC verification
 * requires the full ciphertext; this function falls back to buffering for AES.
 */
export function processEntryDataStream(
  entry: ZipEntryRecord,
  compressedData: AsyncIterable<Uint8Array>,
  options: ExtractCoreOptions & { signal?: AbortSignal } = {}
): AsyncIterable<Uint8Array> {
  const { password, checkCrc32 = false, validateEntrySizes = true, signal } = options;

  async function* run(): AsyncIterable<Uint8Array> {
    throwIfAborted(signal);

    if (entry.type === "directory") {
      return;
    }

    // Encrypted cases
    if (entry.isEncrypted) {
      if (!password) {
        throw new PasswordRequiredError(entry.path);
      }

      if (entry.encryptionMethod === "aes" && entry.aesKeyStrength) {
        // AES requires full ciphertext to verify HMAC.
        const encrypted = await collect(compressedData);
        const decrypted = await aesDecrypt(encrypted, password, entry.aesKeyStrength);
        const method = entry.originalCompressionMethod ?? COMPRESSION_STORE;
        const out = await decompressData(decrypted, method, entry.path);

        // Validate size for AES entries (already fully buffered)
        if (validateEntrySizes && out.length !== entry.uncompressedSize) {
          const reason = out.length > entry.uncompressedSize ? "too-many-bytes" : "too-few-bytes";
          throw new EntrySizeMismatchError(entry.path, entry.uncompressedSize, out.length, reason);
        }

        if (out.length) {
          yield out;
        }
        return;
      }

      if (entry.encryptionMethod === "zipcrypto") {
        const decrypted = decryptZipCryptoStream(entry, compressedData, password, { signal });
        let outStream: AsyncIterable<Uint8Array>;

        if (entry.compressionMethod === COMPRESSION_STORE) {
          outStream = decrypted;
        } else if (entry.compressionMethod === COMPRESSION_DEFLATE) {
          outStream = inflateRawStream(decrypted, { signal });
        } else {
          throw new UnsupportedCompressionError(entry.compressionMethod);
        }

        // Apply validation streams - always check CRC32 for ZipCrypto
        // (header verification only checks 1 byte, 1/256 false positive rate)
        outStream = applyValidationStreams(entry, outStream, {
          validateEntrySizes,
          checkCrc32: true,
          signal
        });

        for await (const chunk of outStream) {
          yield chunk;
        }
        return;
      }

      // Fallback for other encryption methods.
      const encrypted = await collect(compressedData);
      // processEntryData already handles size validation internally
      const out = await processEntryData(
        entry,
        encrypted,
        password,
        checkCrc32,
        validateEntrySizes
      );

      if (out.length) {
        yield out;
      }
      return;
    }

    // Non-encrypted
    let outStream: AsyncIterable<Uint8Array>;
    if (entry.compressionMethod === COMPRESSION_STORE) {
      outStream = compressedData;
    } else if (entry.compressionMethod === COMPRESSION_DEFLATE) {
      outStream = inflateRawStream(compressedData, { signal });
    } else {
      throw new UnsupportedCompressionError(entry.compressionMethod);
    }

    // Apply validation streams using centralized helper
    outStream = applyValidationStreams(entry, outStream, {
      validateEntrySizes,
      checkCrc32,
      signal
    });

    for await (const chunk of outStream) {
      yield chunk;
    }
  }

  return run();
}

/**
 * Decompress data based on compression method (sync).
 */
function decompressDataSync(data: Uint8Array, compressionMethod: number, path: string): Uint8Array {
  if (compressionMethod === COMPRESSION_STORE) {
    return data;
  }
  if (compressionMethod === COMPRESSION_DEFLATE) {
    return decompressSync(data);
  }
  throw new UnsupportedCompressionError(compressionMethod);
}

/**
 * Read the data offset from a local file header.
 *
 * The data offset is the position after the local file header where
 * the actual compressed data begins.
 *
 * @param reader - Binary reader positioned at the local file header
 * @param expectedOffset - Expected offset (for error messages)
 * @returns Offset where the compressed data starts
 */
export function readLocalHeaderDataOffset(reader: BinaryReader, expectedOffset: number): number {
  const sig = reader.readUint32();
  if (sig !== LOCAL_FILE_HEADER_SIG) {
    throw new ArchiveError(`Invalid local file header signature at offset ${expectedOffset}`);
  }

  reader.skip(2); // version needed
  reader.skip(2); // flags
  reader.skip(2); // compression method
  reader.skip(2); // last mod time
  reader.skip(2); // last mod date
  reader.skip(4); // crc32
  reader.skip(4); // compressed size
  reader.skip(4); // uncompressed size
  const fileNameLength = reader.readUint16();
  const extraFieldLength = reader.readUint16();

  reader.skip(fileNameLength);
  reader.skip(extraFieldLength);

  return reader.position;
}

/**
 * Read compressed data for an entry from a buffer.
 *
 * @param data - Full ZIP buffer
 * @param entry - Entry to read
 * @returns Compressed data for the entry
 */
export function readEntryCompressedData(data: Uint8Array, entry: ZipEntryRecord): Uint8Array {
  const reader = new BinaryReader(data, entry.localHeaderOffset);
  const dataOffset = readLocalHeaderDataOffset(reader, entry.localHeaderOffset);
  return data.subarray(dataOffset, dataOffset + entry.compressedSize);
}
