/**
 * Pure Uint8Array-based ZIP parser
 * Works in both Node.js and browser environments
 * No dependency on Node.js stream module
 */

import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import { FileTooLargeError } from "@archive/core/errors";
import type { ZipStringEncoding } from "@archive/core/text";
import {
  processEntryData,
  processEntryDataSync,
  readEntryCompressedData
} from "@archive/unzip/zip-extract-core";
import type { ZipEntryRecord } from "@archive/zip-spec/zip-entry-info";
import { parseZipArchiveFromBuffer } from "@archive/zip-spec/zip-parser-core";

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function assertEntryExtractableInMemory(entry: ZipEntryRecord): void {
  // This parser extracts into memory. If ZIP64 values exceed JS safe integers,
  // callers need a random-access + streaming extraction path (not implemented here).
  if (
    entry.uncompressedSize64 !== undefined &&
    entry.uncompressedSize64 > MAX_SAFE_INTEGER_BIGINT
  ) {
    throw new FileTooLargeError(entry.path, "ZIP64 size > 2^53-1");
  }
  if (entry.compressedSize64 !== undefined && entry.compressedSize64 > MAX_SAFE_INTEGER_BIGINT) {
    throw new FileTooLargeError(entry.path, "ZIP64 size > 2^53-1");
  }
  if (
    entry.localHeaderOffset64 !== undefined &&
    entry.localHeaderOffset64 > MAX_SAFE_INTEGER_BIGINT
  ) {
    throw new FileTooLargeError(entry.path, "ZIP64 offset > 2^53-1");
  }
}

export type { ZipEntryRecord } from "@archive/zip-spec/zip-entry-info";

/**
 * ZIP parsing options
 */
export interface ZipParseOptions {
  /** Whether to decode file names as UTF-8 (default: true) */
  decodeStrings?: boolean;

  /** Optional string encoding for legacy (non-UTF8) names/comments. */
  encoding?: ZipStringEncoding;

  /** Password for encrypted entries */
  password?: string | Uint8Array;
}

/**
 * Result of parsing a ZIP archive.
 */
interface ZipArchiveParseResult {
  entries: ZipEntryRecord[];
  comment: string;
}

/**
 * Parse ZIP archive including entries and archive comment.
 */
function parseZipArchive(data: Uint8Array, options: ZipParseOptions = {}): ZipArchiveParseResult {
  return parseZipArchiveFromBuffer(data, {
    decodeStrings: options.decodeStrings,
    encoding: options.encoding
  });
}

/**
 * Extraction options with optional password support.
 */
export interface ExtractOptions {
  /** Password for encrypted entries */
  password?: string | Uint8Array;
}

/**
 * Extract file data for a specific entry (async)
 */
async function extractEntryData(
  data: Uint8Array,
  entry: ZipEntryRecord,
  options: ExtractOptions = {}
): Promise<Uint8Array> {
  if (entry.type === "directory") {
    return EMPTY_UINT8ARRAY;
  }

  assertEntryExtractableInMemory(entry);

  const compressedData = readEntryCompressedData(data, entry);
  return processEntryData(entry, compressedData, options.password);
}

/**
 * Extract file data synchronously (only supports ZipCrypto, not AES)
 */
function extractEntryDataSync(
  data: Uint8Array,
  entry: ZipEntryRecord,
  options: ExtractOptions = {}
): Uint8Array {
  if (entry.type === "directory") {
    return EMPTY_UINT8ARRAY;
  }

  assertEntryExtractableInMemory(entry);

  const compressedData = readEntryCompressedData(data, entry);
  return processEntryDataSync(entry, compressedData, options.password);
}

/**
 * High-level ZIP parser class
 */
export class ZipParser {
  private data: Uint8Array;
  private entries: ZipEntryRecord[];
  private entryMap: Map<string, ZipEntryRecord>;
  private password?: string | Uint8Array;
  private archiveComment: string;

  constructor(data: Uint8Array | ArrayBuffer, options: ZipParseOptions = {}) {
    this.data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const result = parseZipArchive(this.data, options);
    this.entries = result.entries;
    this.archiveComment = result.comment;
    this.entryMap = new Map(this.entries.map(e => [e.path, e]));
    this.password = options.password;
  }

  /**
   * Set the password for encrypted entries.
   */
  setPassword(password: string | Uint8Array | undefined): void {
    this.password = password;
  }

  /**
   * Get all entries in the ZIP file
   */
  getEntries(): ZipEntryRecord[] {
    return this.entries;
  }

  /**
   * Get entry by path
   */
  getEntry(path: string): ZipEntryRecord | undefined {
    return this.entryMap.get(path);
  }

  /**
   * Get a zero-copy view of the raw (compressed) entry payload.
   *
   * Notes:
   * - This returns the bytes as stored in the ZIP (compressed and possibly encrypted).
   * - The returned Uint8Array is a view into the original ZIP buffer.
   * - This does NOT include the local file header, extra field, or data descriptor.
   */
  getRawCompressedData(path: string): Uint8Array | null {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    // This helper returns a subarray view into the original `data`.
    return readEntryCompressedData(this.data, entry);
  }

  /**
   * Get raw (compressed) payload together with its parsed entry info.
   */
  getRawEntry(path: string): { info: ZipEntryRecord; compressedData: Uint8Array } | null {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    return { info: entry, compressedData: readEntryCompressedData(this.data, entry) };
  }

  /**
   * Check if entry exists
   */
  hasEntry(path: string): boolean {
    return this.entryMap.has(path);
  }

  /**
   * Get the number of child entries in a directory.
   *
   * Returns the count of entries whose paths start with the directory prefix,
   * excluding the directory entry itself. For non-directory entries, returns 0.
   *
   * @param path - Directory path (with or without trailing slash)
   * @returns Number of child entries
   */
  childCount(path: string): number {
    const direct = this.entryMap.get(path);
    if (direct && direct.type !== "directory") {
      return 0;
    }

    const slashPath = path.endsWith("/") ? path : path + "/";
    const dirEntry = direct?.type === "directory" ? direct : this.entryMap.get(slashPath);

    // If there is no explicit directory entry, still support implicit directories
    // as long as there are entries under the prefix.
    const prefix = (dirEntry?.path ?? slashPath).endsWith("/")
      ? (dirEntry?.path ?? slashPath)
      : (dirEntry?.path ?? slashPath) + "/";

    let count = 0;
    for (const e of this.entries) {
      if (e.path.startsWith(prefix) && e.path !== prefix) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the archive comment.
   */
  getZipComment(): string {
    return this.archiveComment;
  }

  /**
   * Check if the archive contains encrypted entries
   */
  hasEncryptedEntries(): boolean {
    return this.entries.some(e => e.isEncrypted);
  }

  /**
   * Get all encrypted entries
   */
  getEncryptedEntries(): ZipEntryRecord[] {
    return this.entries.filter(e => e.isEncrypted);
  }

  /**
   * List all file paths
   */
  listFiles(): string[] {
    return this.entries.map(e => e.path);
  }

  /**
   * Extract a single file (async)
   * @param path - File path within the archive
   * @param password - Optional password for this entry (overrides constructor password)
   */
  async extract(path: string, password?: string | Uint8Array): Promise<Uint8Array | null> {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    return extractEntryData(this.data, entry, { password: password ?? this.password });
  }

  /**
   * Extract a single file (sync)
   *
   * Note: AES-encrypted files cannot be extracted synchronously.
   * Use the async extract() method for AES-encrypted files.
   *
   * @param path - File path within the archive
   * @param password - Optional password for this entry (overrides constructor password)
   */
  extractSync(path: string, password?: string | Uint8Array): Uint8Array | null {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    return extractEntryDataSync(this.data, entry, { password: password ?? this.password });
  }

  /**
   * Extract all files (async)
   * @param password - Optional password for encrypted entries (overrides constructor password)
   */
  async extractAll(password?: string | Uint8Array): Promise<Map<string, Uint8Array>> {
    const result = new Map<string, Uint8Array>();
    const pw = password ?? this.password;
    for (const entry of this.entries) {
      const data = await extractEntryData(this.data, entry, { password: pw });
      result.set(entry.path, data);
    }
    return result;
  }

  /**
   * Extract all files (sync)
   * Returns object with file paths as keys and Uint8Array content as values
   *
   * Note: AES-encrypted files cannot be extracted synchronously.
   * Use the async extractAll() method if the archive contains AES-encrypted files.
   *
   * @param password - Optional password for encrypted entries (overrides constructor password)
   */
  extractAllSync(password?: string | Uint8Array): Record<string, Uint8Array> {
    const result: Record<string, Uint8Array> = {};
    const pw = password ?? this.password;
    for (const entry of this.entries) {
      result[entry.path] = extractEntryDataSync(this.data, entry, { password: pw });
    }
    return result;
  }

  /**
   * Iterate over entries with async callback
   * @param callback - Callback for each entry
   * @param password - Optional password for encrypted entries (overrides constructor password)
   */
  async forEach(
    callback: (
      entry: ZipEntryRecord,
      getData: () => Promise<Uint8Array>
    ) => Promise<boolean | void>,
    password?: string | Uint8Array
  ): Promise<void> {
    const pw = password ?? this.password;
    for (const entry of this.entries) {
      let dataPromise: Promise<Uint8Array> | null = null;
      const getData = () => {
        if (!dataPromise) {
          dataPromise = extractEntryData(this.data, entry, { password: pw });
        }
        return dataPromise;
      };

      const shouldContinue = await callback(entry, getData);
      if (shouldContinue === false) {
        break;
      }
    }
  }
}
