/**
 * Remote ZIP Reader - On-demand ZIP archive reading via HTTP Range requests
 *
 * This module provides efficient access to ZIP archives stored on remote servers.
 * Instead of downloading the entire archive, it uses HTTP Range requests to:
 *
 * 1. Read the End of Central Directory (EOCD) from the end of the file
 * 2. Read the Central Directory to get file metadata
 * 3. Read individual entries on demand
 *
 * This can dramatically reduce bandwidth usage when you only need a few files
 * from a large archive.
 *
 * @module
 */

import { crc32 } from "@archive/compression/crc32";
import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import type { ZipStringEncoding } from "@archive/core/text";
import { resolveZipStringCodec } from "@archive/core/text";
import {
  zipCryptoVerifyPassword,
  aesVerifyPassword,
  AES_PASSWORD_VERIFY_LENGTH,
  AES_SALT_LENGTH,
  ZIP_CRYPTO_HEADER_SIZE
} from "@archive/crypto";
import { pipeIterableToSink } from "@archive/io/archive-sink";
import type { RandomAccessReader, HttpRangeReaderOptions } from "@archive/io/random-access";
import { HttpRangeReader } from "@archive/io/random-access";
import {
  processEntryData,
  processEntryDataStream,
  LOCAL_HEADER_FIXED_SIZE
} from "@archive/unzip/zip-extract-core";
import { BinaryReader } from "@archive/zip-spec/binary";
import type { ZipEntryRecord } from "@archive/zip-spec/zip-entry-info";
import type { EOCDInfo, ZIP64EOCDInfo } from "@archive/zip-spec/zip-parser-core";
import {
  EOCD_MAX_SEARCH_SIZE,
  ZIP64_EOCD_LOCATOR_SIZE,
  findEOCDSignature,
  parseEOCD,
  parseZIP64EOCDLocator,
  parseZIP64EOCD,
  applyZIP64ToEOCD,
  parseCentralDirectory
} from "@archive/zip-spec/zip-parser-core";
import { LOCAL_FILE_HEADER_SIG } from "@archive/zip-spec/zip-records";

/**
 * Options for RemoteZipReader
 */
export interface RemoteZipReaderOptions {
  /**
   * Password for encrypted entries.
   */
  password?: string | Uint8Array;

  /**
   * Whether to decode file names as UTF-8.
   * @default true
   */
  decodeStrings?: boolean;

  /** Optional string encoding for legacy (non-UTF8) names/comments. */
  encoding?: ZipStringEncoding;

  /**
   * Abort signal for cancellation.
   */
  signal?: AbortSignal;

  /**
   * Whether to validate CRC32 checksum after extraction.
   * @default false
   */
  checkCrc32?: boolean;
}

/**
 * Options for extracting entries
 */
export interface ExtractOptions {
  /**
   * Password for encrypted entries (overrides constructor password).
   */
  password?: string | Uint8Array;

  /**
   * Whether to validate CRC32 checksum after extraction.
   * Overrides the constructor option.
   */
  checkCrc32?: boolean;

  /**
   * Progress callback for large file extraction.
   * Called with current bytes processed and total bytes.
   */
  onprogress?: (current: number, total: number) => void;
}

/**
 * Options for reading raw (compressed) entry data.
 */
export interface RawEntryReadOptions {
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Options for streaming raw (compressed) entry data.
 */
export interface RawEntryStreamOptions extends RawEntryReadOptions {
  /** Chunk size for range reads. Default: 64 KiB */
  chunkSize?: number;
}

/**
 * Options for opening a remote ZIP file via URL
 */
export interface RemoteZipOpenOptions extends RemoteZipReaderOptions, HttpRangeReaderOptions {}

/**
 * Statistics about remote ZIP reading operations
 */
export interface RemoteZipStats {
  /** Total size of the ZIP file */
  totalSize: number;
  /** Number of entries in the archive */
  entryCount: number;
  /** HTTP request statistics (if using HttpRangeReader) */
  http?: {
    requestCount: number;
    bytesDownloaded: number;
    downloadedPercent: number;
  };
}

/**
 * Error thrown when CRC32 validation fails
 */
export { Crc32MismatchError } from "@archive/core/errors";
import {
  ArchiveError,
  Crc32MismatchError,
  EocdNotFoundError,
  throwIfAborted
} from "@archive/core/errors";

/**
 * Remote ZIP Reader
 *
 * Provides on-demand access to ZIP archives via random access reading.
 * Only downloads the parts of the archive that are actually needed.
 *
 * @example
 * ```ts
 * // Open a remote ZIP file
 * const reader = await RemoteZipReader.open("https://example.com/large-archive.zip");
 *
 * // List entries without downloading file content
 * for (const entry of reader.getEntries()) {
 *   console.log(entry.path, entry.uncompressedSize);
 * }
 *
 * // Extract just one file
 * const data = await reader.extract("important-file.txt");
 *
 * // Check how much was downloaded
 * console.log(reader.getStats());
 *
 * await reader.close();
 * ```
 */
export class RemoteZipReader {
  private readonly reader: RandomAccessReader;
  private readonly options: RemoteZipReaderOptions;
  private entries: ZipEntryRecord[] = [];
  private entryMap: Map<string, ZipEntryRecord> = new Map();
  private archiveComment = "";
  private initialized = false;
  private httpReader?: HttpRangeReader;

  private readonly dataOffsetCache = new WeakMap<ZipEntryRecord, number>();
  private _hasEncryptedEntries: boolean | null = null;
  private _decoder?: ReturnType<typeof resolveZipStringCodec>;

  private constructor(
    reader: RandomAccessReader,
    options: RemoteZipReaderOptions = {},
    httpReader?: HttpRangeReader
  ) {
    this.reader = reader;
    this.options = options;
    this.httpReader = httpReader;
    if (options.encoding) {
      this._decoder = resolveZipStringCodec(options.encoding);
    }
  }

  private get _encodingDecoder() {
    return this._decoder;
  }

  /**
   * Open a remote ZIP file via URL.
   *
   * @param url - URL of the ZIP file
   * @param options - Reader options
   * @returns Initialized RemoteZipReader
   */
  static async open(url: string, options: RemoteZipOpenOptions = {}): Promise<RemoteZipReader> {
    const httpReader = await HttpRangeReader.open(url, options);
    const instance = new RemoteZipReader(httpReader, options, httpReader);
    await instance.init();
    return instance;
  }

  /**
   * Create a RemoteZipReader from any RandomAccessReader.
   *
   * @param reader - A random access reader
   * @param options - Reader options
   * @returns Initialized RemoteZipReader
   */
  static async fromReader(
    reader: RandomAccessReader,
    options: RemoteZipReaderOptions = {}
  ): Promise<RemoteZipReader> {
    const instance = new RemoteZipReader(reader, options);
    await instance.init();
    return instance;
  }

  /**
   * Initialize the reader by parsing EOCD and Central Directory.
   */
  private async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const { eocd } = await this.readEOCD();
    await this.readCentralDirectory(eocd);
    this.initialized = true;
  }

  /**
   * Read and parse the End of Central Directory record.
   */
  private async readEOCD(): Promise<{
    eocd: EOCDInfo;
    zip64Eocd: ZIP64EOCDInfo | null;
  }> {
    const size = this.reader.size;
    const decodeStrings = this.options.decodeStrings ?? true;

    // Read enough to find EOCD (it's at the end, but may have a comment)
    const searchSize = Math.min(size, EOCD_MAX_SEARCH_SIZE);
    const tailData = await this.reader.read(size - searchSize, size);

    // Search backwards for EOCD signature with validation
    const eocdLocalOffset = findEOCDSignature(tailData, true);
    if (eocdLocalOffset === -1) {
      throw new EocdNotFoundError();
    }

    // Parse EOCD using shared function
    const { eocd, comment } = parseEOCD(
      tailData,
      eocdLocalOffset,
      decodeStrings,
      this._encodingDecoder
    );
    this.archiveComment = comment;

    // Check for ZIP64
    let zip64Eocd: ZIP64EOCDInfo | null = null;

    // The actual file offset of EOCD
    const eocdFileOffset = size - searchSize + eocdLocalOffset;

    // ZIP64 EOCD Locator is right before the regular EOCD
    if (eocdFileOffset >= ZIP64_EOCD_LOCATOR_SIZE) {
      // Check if we already have the locator in our tail data
      const locatorLocalOffset = eocdLocalOffset - ZIP64_EOCD_LOCATOR_SIZE;

      let locatorData: Uint8Array;
      if (locatorLocalOffset >= 0) {
        locatorData = tailData.subarray(
          locatorLocalOffset,
          locatorLocalOffset + ZIP64_EOCD_LOCATOR_SIZE
        );
      } else {
        // Need to read it separately
        locatorData = await this.reader.read(
          eocdFileOffset - ZIP64_EOCD_LOCATOR_SIZE,
          eocdFileOffset
        );
      }

      const zip64EocdFileOffset = parseZIP64EOCDLocator(locatorData, 0);
      if (zip64EocdFileOffset >= 0) {
        // Read ZIP64 EOCD (56 bytes fixed)
        const zip64EocdData = await this.reader.read(zip64EocdFileOffset, zip64EocdFileOffset + 56);
        zip64Eocd = parseZIP64EOCD(zip64EocdData, 0);

        if (zip64Eocd) {
          applyZIP64ToEOCD(eocd, zip64Eocd);
        }
      }
    }

    return { eocd, zip64Eocd };
  }

  /**
   * Read and parse the Central Directory.
   */
  private async readCentralDirectory(eocd: EOCDInfo): Promise<void> {
    const decodeStrings = this.options.decodeStrings ?? true;

    // Handle empty archives
    if (eocd.totalEntries === 0 || eocd.centralDirSize === 0) {
      this.entries = [];
      return;
    }

    // Read the entire central directory in one request
    const centralDirData = await this.reader.read(
      eocd.centralDirOffset,
      eocd.centralDirOffset + eocd.centralDirSize
    );

    // Use shared parsing function
    this.entries = parseCentralDirectory(centralDirData, eocd.totalEntries, {
      decodeStrings,
      encoding: this.options.encoding
    });

    // Build entryMap
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      this.entryMap.set(entry.path, entry);
    }
  }

  /**
   * Get all entries in the ZIP file.
   */
  getEntries(): readonly ZipEntryRecord[] {
    return this.entries;
  }

  /**
   * Get entry by path.
   */
  getEntry(path: string): ZipEntryRecord | undefined {
    return this.entryMap.get(path);
  }

  /**
   * Check if entry exists.
   */
  hasEntry(path: string): boolean {
    return this.entryMap.has(path);
  }

  /**
   * Get the archive comment.
   */
  getZipComment(): string {
    return this.archiveComment;
  }

  /**
   * Get raw (compressed) entry payload as a single Uint8Array.
   *
   * Notes:
   * - This returns the bytes as stored in the ZIP (compressed and possibly encrypted).
   * - The returned bytes do NOT include the local file header, extra field, or data descriptor.
   * - For large entries, prefer {@link getRawCompressedStream}.
   */
  async getRawCompressedData(
    pathOrEntry: string | ZipEntryRecord,
    options: RawEntryReadOptions = {}
  ): Promise<Uint8Array | null> {
    const entry = typeof pathOrEntry === "string" ? this.entryMap.get(pathOrEntry) : pathOrEntry;
    if (!entry) {
      return null;
    }

    const signal = options.signal ?? this.options.signal;
    throwIfAborted(signal);

    if (entry.compressedSize === 0) {
      return EMPTY_UINT8ARRAY;
    }

    const dataOffset = await this.getEntryDataOffset(entry);
    throwIfAborted(signal);

    return this.reader.read(dataOffset, dataOffset + entry.compressedSize);
  }

  /**
   * Get raw (compressed) entry payload as an async iterable.
   *
   * This is the most memory-efficient way to read raw entry bytes.
   */
  getRawCompressedStream(
    pathOrEntry: string | ZipEntryRecord,
    options: RawEntryStreamOptions = {}
  ): AsyncIterable<Uint8Array> | null {
    const entry = typeof pathOrEntry === "string" ? this.entryMap.get(pathOrEntry) : pathOrEntry;
    if (!entry) {
      return null;
    }

    const signal = options.signal ?? this.options.signal;
    const chunkSize = Math.max(1, options.chunkSize ?? 64 * 1024);
    const reader = this.reader;
    const getOffset = async (): Promise<number> => this.getEntryDataOffset(entry);

    return {
      async *[Symbol.asyncIterator]() {
        throwIfAborted(signal);

        if (entry.compressedSize === 0) {
          return;
        }

        const dataOffset = await getOffset();
        let offset = 0;
        while (offset < entry.compressedSize) {
          throwIfAborted(signal);

          const end = Math.min(entry.compressedSize, offset + chunkSize);
          yield await reader.read(dataOffset + offset, dataOffset + end);
          offset = end;
        }
      }
    };
  }

  /**
   * Get a raw entry (metadata + compressed payload).
   */
  async getRawEntry(
    path: string,
    options: RawEntryReadOptions = {}
  ): Promise<{ entry: ZipEntryRecord; compressedData: Uint8Array } | null> {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    const compressedData = await this.getRawCompressedData(entry, options);
    if (!compressedData) {
      return null;
    }
    return { entry, compressedData };
  }

  /**
   * Get a raw entry stream (metadata + async iterable compressed payload).
   */
  getRawEntryStream(
    path: string,
    options: RawEntryStreamOptions = {}
  ): { entry: ZipEntryRecord; compressedData: AsyncIterable<Uint8Array> } | null {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    const compressedData = this.getRawCompressedStream(entry, options);
    if (!compressedData) {
      return null;
    }
    return { entry, compressedData };
  }

  /**
   * List all file paths.
   */
  listFiles(): string[] {
    return [...this.entryMap.keys()];
  }

  /**
   * Get the number of file entries (excluding directories).
   */
  getFileCount(): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i]!.type !== "directory") {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the number of directory entries.
   */
  getDirectoryCount(): number {
    let count = 0;
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i]!.type === "directory") {
        count++;
      }
    }
    return count;
  }

  /**
   * Filter entries by a predicate function.
   *
   * @param predicate - Function to test each entry
   * @returns Array of entries that pass the test
   */
  filterEntries(predicate: (entry: ZipEntryRecord) => boolean): ZipEntryRecord[] {
    const results: ZipEntryRecord[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (predicate(entry)) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Find entries matching a glob-like pattern.
   * Supports * (any characters) and ? (single character).
   *
   * @param pattern - Glob pattern (e.g., "*.txt", "folder/*", "**\/data.json")
   * @returns Array of matching entries
   */
  findEntries(pattern: string): ZipEntryRecord[] {
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "{{GLOBSTAR}}")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, ".")
          .replace(/\{\{GLOBSTAR\}\}/g, ".*") +
        "$"
    );
    const results: ZipEntryRecord[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (regex.test(entry.path)) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Check if the archive contains encrypted entries.
   * Result is cached after first call for performance.
   */
  hasEncryptedEntries(): boolean {
    if (this._hasEncryptedEntries === null) {
      let hasEncrypted = false;
      for (let i = 0; i < this.entries.length; i++) {
        if (this.entries[i]!.isEncrypted) {
          hasEncrypted = true;
          break;
        }
      }
      this._hasEncryptedEntries = hasEncrypted;
    }
    return this._hasEncryptedEntries;
  }

  /**
   * Extract a single file.
   *
   * @param path - File path within the archive
   * @param options - Extract options or password
   * @returns File data, or null if entry not found
   */
  async extract(
    path: string,
    options?: ExtractOptions | string | Uint8Array
  ): Promise<Uint8Array | null> {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    const opts = this.normalizeExtractOptions(options);
    return this.extractEntry(entry, opts);
  }

  /**
   * Extract a specific entry.
   *
   * @param entry - Entry to extract
   * @param options - Extract options or password
   * @returns File data
   */
  async extractEntry(
    entry: ZipEntryRecord,
    options?: ExtractOptions | string | Uint8Array
  ): Promise<Uint8Array> {
    const opts = this.normalizeExtractOptions(options);
    const password = opts.password ?? this.options.password;
    const shouldCheckCrc = opts.checkCrc32 ?? this.options.checkCrc32 ?? false;

    if (entry.type === "directory") {
      return EMPTY_UINT8ARRAY;
    }

    const dataOffset = await this.getEntryDataOffset(entry);

    opts.onprogress?.(0, entry.compressedSize);

    // Read compressed data
    const compressedData = await this.reader.read(dataOffset, dataOffset + entry.compressedSize);

    // Report progress for download
    opts.onprogress?.(entry.compressedSize, entry.compressedSize);

    return this.processEntryCompressedData(entry, compressedData, password, shouldCheckCrc);
  }

  private async processEntryCompressedData(
    entry: ZipEntryRecord,
    compressedData: Uint8Array,
    password: string | Uint8Array | undefined,
    shouldCheckCrc: boolean
  ): Promise<Uint8Array> {
    // Use shared extraction core logic
    return processEntryData(entry, compressedData, password, shouldCheckCrc);
  }

  /**
   * Normalize extract options from various input formats.
   */
  private normalizeExtractOptions(options?: ExtractOptions | string | Uint8Array): ExtractOptions {
    if (!options) {
      return {};
    }
    if (typeof options === "string" || options instanceof Uint8Array) {
      return { password: options };
    }
    return options;
  }

  /**
   * Extract all files from the archive.
   * This is a convenience method that calls extractMultiple with all file paths.
   *
   * @param options - Extract options or password
   * @returns Map of path to file data (directories are excluded)
   */
  async extractAll(
    options?: ExtractOptions | string | Uint8Array
  ): Promise<Map<string, Uint8Array>> {
    const filePaths: string[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.type !== "directory") {
        filePaths.push(entry.path);
      }
    }
    return this.extractMultiple(filePaths, options);
  }

  /**
   * Extract multiple entries efficiently.
   * Entries are sorted by offset to minimize seeks/requests.
   *
   * @param paths - File paths to extract
   * @param options - Extract options or password
   * @returns Map of path to file data
   */
  async extractMultiple(
    paths: string[],
    options?: ExtractOptions | string | Uint8Array
  ): Promise<Map<string, Uint8Array>> {
    const result = new Map<string, Uint8Array>();
    const opts = this.normalizeExtractOptions(options);

    // Get entries and sort by offset for efficient sequential reading
    const entriesToExtract: Array<{ path: string; entry: ZipEntryRecord }> = [];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]!;
      const entry = this.entryMap.get(path);
      if (entry) {
        entriesToExtract.push({ path, entry });
      }
    }
    entriesToExtract.sort((a, b) => a.entry.localHeaderOffset - b.entry.localHeaderOffset);

    if (entriesToExtract.length === 0) {
      return result;
    }

    // Calculate total size for progress
    let totalSize = 0;
    for (let i = 0; i < entriesToExtract.length; i++) {
      totalSize += entriesToExtract[i]!.entry.compressedSize;
    }
    let processedSize = 0;

    // Pre-compute data offsets in batches to avoid per-entry local header reads.
    // This dramatically reduces HTTP Range request count when using HttpRangeReader.
    const MAX_HEADER_BATCH_BYTES = 64 * 1024;
    const MAX_HEADER_GAP_BYTES = 4 * 1024;

    for (let i = 0; i < entriesToExtract.length;) {
      const firstOffset = entriesToExtract[i].entry.localHeaderOffset;
      const batchStart = firstOffset;
      let batchEnd = batchStart + LOCAL_HEADER_FIXED_SIZE;

      let j = i + 1;
      for (; j < entriesToExtract.length; j++) {
        const nextOffset = entriesToExtract[j].entry.localHeaderOffset;
        const nextEnd = nextOffset + LOCAL_HEADER_FIXED_SIZE;

        if (nextOffset - batchEnd > MAX_HEADER_GAP_BYTES) {
          break;
        }
        const expandedEnd = Math.max(batchEnd, nextEnd);
        if (expandedEnd - batchStart > MAX_HEADER_BATCH_BYTES) {
          break;
        }
        batchEnd = expandedEnd;
      }

      const batch = await this.reader.read(batchStart, batchEnd);

      for (let k = i; k < j; k++) {
        const entry = entriesToExtract[k].entry;
        if (this.dataOffsetCache.has(entry)) {
          continue;
        }

        const rel = entry.localHeaderOffset - batchStart;
        if (rel < 0 || rel + LOCAL_HEADER_FIXED_SIZE > batch.length) {
          await this.getEntryDataOffset(entry);
          continue;
        }

        const headerReader = new BinaryReader(batch, rel);
        const sig = headerReader.readUint32();
        if (sig !== LOCAL_FILE_HEADER_SIG) {
          await this.getEntryDataOffset(entry);
          continue;
        }

        headerReader.skip(22);
        const fileNameLength = headerReader.readUint16();
        const extraFieldLength = headerReader.readUint16();

        const dataOffset =
          entry.localHeaderOffset + LOCAL_HEADER_FIXED_SIZE + fileNameLength + extraFieldLength;
        this.dataOffsetCache.set(entry, dataOffset);
      }

      i = j;
    }

    // Extract in data batches (contiguous-ish reads), then slice per entry.
    const MAX_DATA_BATCH_BYTES = 4 * 1024 * 1024;
    const MAX_DATA_GAP_BYTES = 64 * 1024;

    // Pre-compute options that are the same for all entries
    const password = opts.password ?? this.options.password;
    const shouldCheckCrc = opts.checkCrc32 ?? this.options.checkCrc32 ?? false;

    for (let i = 0; i < entriesToExtract.length;) {
      // Skip directories (no data to read)
      if (entriesToExtract[i].entry.type === "directory") {
        opts.onprogress?.(processedSize, totalSize);
        result.set(entriesToExtract[i].path, EMPTY_UINT8ARRAY);
        i++;
        continue;
      }

      const firstEntry = entriesToExtract[i].entry;
      const firstDataOffset = await this.getEntryDataOffset(firstEntry);
      const batchStart = firstDataOffset;
      let batchEnd = firstDataOffset + firstEntry.compressedSize;

      let j = i + 1;
      for (; j < entriesToExtract.length; j++) {
        const nextEntry = entriesToExtract[j].entry;
        if (nextEntry.type === "directory") {
          break;
        }

        const nextDataOffset = await this.getEntryDataOffset(nextEntry);
        const nextEnd = nextDataOffset + nextEntry.compressedSize;

        if (nextDataOffset - batchEnd > MAX_DATA_GAP_BYTES) {
          break;
        }

        const expandedEnd = Math.max(batchEnd, nextEnd);
        if (expandedEnd - batchStart > MAX_DATA_BATCH_BYTES && j > i + 1) {
          break;
        }

        batchEnd = expandedEnd;
      }

      const batch = await this.reader.read(batchStart, batchEnd);

      for (let k = i; k < j; k++) {
        const { path, entry } = entriesToExtract[k];

        if (entry.type === "directory") {
          opts.onprogress?.(processedSize, totalSize);
          result.set(path, EMPTY_UINT8ARRAY);
          continue;
        }

        const dataOffset = await this.getEntryDataOffset(entry);
        const rel = dataOffset - batchStart;
        const end = rel + entry.compressedSize;

        let compressedData: Uint8Array;
        if (rel < 0 || end > batch.length) {
          // Fallback for unexpected layout
          compressedData = await this.reader.read(dataOffset, dataOffset + entry.compressedSize);
        } else {
          compressedData = batch.subarray(rel, end);
        }

        opts.onprogress?.(processedSize, totalSize);
        const data = await this.processEntryCompressedData(
          entry,
          compressedData,
          password,
          shouldCheckCrc
        );
        result.set(path, data);
        processedSize += entry.compressedSize;
      }

      i = j;
    }

    return result;
  }

  /**
   * Iterate over entries with async callback.
   *
   * @param callback - Callback for each entry. Return false to stop iteration.
   * @param options - Extract options or password
   */
  async forEach(
    callback: (
      entry: ZipEntryRecord,
      getData: () => Promise<Uint8Array>
    ) => Promise<boolean | void>,
    options?: ExtractOptions | string | Uint8Array
  ): Promise<void> {
    for await (const { entry, getData } of this.entriesGenerator(options)) {
      const shouldContinue = await callback(entry, getData);
      if (shouldContinue === false) {
        break;
      }
    }
  }

  /**
   * Async generator to iterate over entries one by one.
   * Useful for processing large archives without loading all entries into memory.
   *
   * @example
   * ```ts
   * for await (const { entry, getData } of reader.entriesGenerator()) {
   *   if (entry.path.endsWith('.json')) {
   *     const data = await getData();
   *     console.log(JSON.parse(new TextDecoder().decode(data)));
   *   }
   * }
   * ```
   */
  async *entriesGenerator(
    options?: ExtractOptions | string | Uint8Array
  ): AsyncGenerator<{ entry: ZipEntryRecord; getData: () => Promise<Uint8Array> }> {
    const opts = this.normalizeExtractOptions(options);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      let dataPromise: Promise<Uint8Array> | null = null;
      const getData = () => {
        if (!dataPromise) {
          dataPromise = this.extractEntry(entry, opts);
        }
        return dataPromise;
      };

      yield { entry, getData };
    }
  }

  /**
   * Check if a password is correct for an encrypted entry without extracting the full file.
   * This is much faster than extracting the file as it only reads the encryption header.
   *
   * @param path - File path within the archive
   * @param password - Password to check
   * @returns true if password is correct, false if incorrect, null if entry not found or not encrypted
   */
  async checkPassword(path: string, password: string | Uint8Array): Promise<boolean | null> {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    return this.checkEntryPassword(entry, password);
  }

  /**
   * Check if a password is correct for an encrypted entry.
   *
   * @param entry - Entry to check
   * @param password - Password to check
   * @returns true if password is correct, false if incorrect, null if not encrypted
   */
  async checkEntryPassword(
    entry: ZipEntryRecord,
    password: string | Uint8Array
  ): Promise<boolean | null> {
    if (!entry.isEncrypted) {
      return null;
    }

    const dataOffset = await this.getEntryDataOffset(entry);

    if (entry.encryptionMethod === "zipcrypto") {
      // ZipCrypto: Only need the encryption header
      const encryptionHeader = await this.reader.read(
        dataOffset,
        dataOffset + ZIP_CRYPTO_HEADER_SIZE
      );
      return zipCryptoVerifyPassword(encryptionHeader, password, entry.crc32, entry.dosTime);
    } else if (entry.encryptionMethod === "aes" && entry.aesKeyStrength) {
      // AES: read salt + password verification bytes only (fast path)
      // Salt size: 8 bytes for 128-bit, 12 bytes for 192-bit, 16 bytes for 256-bit
      // Password verification: 2 bytes
      const saltSize = AES_SALT_LENGTH[entry.aesKeyStrength];
      const headerSize = saltSize + AES_PASSWORD_VERIFY_LENGTH;
      const aesHeader = await this.reader.read(dataOffset, dataOffset + headerSize);
      return aesVerifyPassword(aesHeader, password, entry.aesKeyStrength);
    }

    return null;
  }

  private async getEntryDataOffset(entry: ZipEntryRecord): Promise<number> {
    const cached = this.dataOffsetCache.get(entry);
    if (cached !== undefined) {
      return cached;
    }

    // Local header is fixed size + variable filename + extra field
    const localHeaderData = await this.reader.read(
      entry.localHeaderOffset,
      entry.localHeaderOffset + LOCAL_HEADER_FIXED_SIZE
    );

    const headerReader = new BinaryReader(localHeaderData, 0);
    const sig = headerReader.readUint32();
    if (sig !== LOCAL_FILE_HEADER_SIG) {
      throw new ArchiveError(`Invalid local file header signature for "${entry.path}"`);
    }

    headerReader.skip(22); // skip to filename length
    const fileNameLength = headerReader.readUint16();
    const extraFieldLength = headerReader.readUint16();

    const dataOffset =
      entry.localHeaderOffset + LOCAL_HEADER_FIXED_SIZE + fileNameLength + extraFieldLength;
    this.dataOffsetCache.set(entry, dataOffset);
    return dataOffset;
  }

  /**
   * Extract to a WritableStream (streaming output).
   * Useful for large files to avoid loading the entire content into memory.
   *
   * @param path - File path within the archive
   * @param writable - WritableStream to write the extracted data to
   * @param options - Extract options or password
   * @returns true if extraction succeeded, false if entry not found
   */
  async extractToStream(
    path: string,
    writable: WritableStream<Uint8Array>,
    options?: ExtractOptions | string | Uint8Array
  ): Promise<boolean> {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return false;
    }

    const opts = this.normalizeExtractOptions(options);
    const signal = this.options.signal;

    // AES cannot be truly streamed because HMAC verification needs full ciphertext.
    if (entry.encryptionMethod === "aes") {
      const data = await this.extractEntry(entry, opts);
      const writer = writable.getWriter();
      try {
        await writer.write(data);
        await writer.close();
      } finally {
        writer.releaseLock();
      }
      return true;
    }

    const checkCrc32 = opts.checkCrc32 ?? this.options.checkCrc32 ?? false;
    const password = opts.password ?? this.options.password;

    const raw = this.getRawCompressedStream(entry, { signal });
    if (!raw) {
      return false;
    }

    let processed = 0;
    const tracked = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of raw) {
          processed += chunk.length;
          opts.onprogress?.(processed, entry.compressedSize);
          yield chunk;
        }
      }
    } satisfies AsyncIterable<Uint8Array>;

    const out = processEntryDataStream(entry, tracked, { password, checkCrc32, signal });
    await pipeIterableToSink(out, writable);

    return true;
  }

  /**
   * Verify CRC32 for an entry without returning the data.
   * Useful for integrity checking.
   *
   * @param path - File path within the archive
   * @param options - Extract options (password if encrypted)
   * @returns true if CRC32 matches, throws Crc32MismatchError if not, null if entry not found
   */
  async verifyCrc32(
    path: string,
    options?: ExtractOptions | string | Uint8Array
  ): Promise<boolean | null> {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }

    // AES-encrypted entries don't use CRC32
    if (entry.encryptionMethod === "aes") {
      return true;
    }

    const opts = this.normalizeExtractOptions(options);
    const data = await this.extractEntry(entry, { ...opts, checkCrc32: false });
    const actualCrc = crc32(data);

    if (actualCrc !== entry.crc32) {
      throw new Crc32MismatchError(entry.path, entry.crc32, actualCrc);
    }

    return true;
  }

  /**
   * Get statistics about the reader's operations.
   */
  getStats(): RemoteZipStats {
    const stats: RemoteZipStats = {
      totalSize: this.reader.size,
      entryCount: this.entries.length
    };

    if (this.httpReader) {
      const httpStats = this.httpReader.getStats();
      stats.http = {
        requestCount: httpStats.requestCount,
        bytesDownloaded: httpStats.bytesDownloaded,
        downloadedPercent: httpStats.downloadedPercent
      };
    }

    return stats;
  }

  /**
   * Close the reader and release resources.
   */
  async close(): Promise<void> {
    await this.reader.close?.();
  }
}
