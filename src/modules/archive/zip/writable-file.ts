/**
 * Writable file interface for streaming ZIP creation.
 *
 * This interface defines the contract between file writers (compressors, passthrough)
 * and the StreamingZip pipeline.
 *
 * @module
 */

/**
 * Central directory entry information required by the ZIP writer.
 *
 * This represents the metadata for a single entry in the Central Directory.
 * Field names match ZIP specification naming conventions.
 */
export interface ZipCentralDirEntry {
  /** File name as UTF-8 encoded bytes */
  name: Uint8Array;
  /** Extra field data (may include ZIP64, timestamps, etc.) */
  extraField: Uint8Array;
  /** File comment as UTF-8 encoded bytes */
  comment: Uint8Array;
  /** General purpose bit flags */
  flags: number;
  /** CRC-32 of uncompressed data */
  crc: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Uncompressed size in bytes */
  uncompressedSize: number;
  /** Compression method (0=store, 8=deflate, 99=AES) */
  compressionMethod: number;
  /** MS-DOS time */
  dosTime: number;
  /** MS-DOS date */
  dosDate: number;
  /** Offset of local file header from start of archive */
  offset: number;
  /** Whether this entry uses ZIP64 extensions */
  zip64: boolean;
  /** External file attributes (platform-specific) */
  externalAttributes: number;
  /** Version made by (optional, defaults to standard) */
  versionMadeBy?: number;
}

/**
 * Minimal interface required by the StreamingZip pipeline.
 *
 * Implemented by:
 * - `ZipDeflateFile` - Compresses and optionally encrypts data chunk by chunk
 * - `ZipRawFile` - Passes through pre-compressed/pre-encrypted data
 *
 * The writer lifecycle:
 * 1. Writer is created and added to StreamingZip via `add()`
 * 2. StreamingZip sets `ondata` and `onerror` callbacks
 * 3. StreamingZip calls `start()` if present (for passthrough writers)
 * 4. Writer emits data via `ondata(data, false)` for each chunk
 * 5. Writer emits final data via `ondata(data, true)` when done
 * 6. `getCentralDirectoryEntryInfo()` returns metadata for CD
 */
export interface ZipWritableFile {
  /**
   * Callback invoked when output data is ready.
   *
   * @param data - Output bytes (local header, compressed data, data descriptor)
   * @param final - True if this is the last chunk for this entry
   */
  ondata: ((data: Uint8Array, final: boolean) => void | Promise<void>) | null;

  /**
   * Callback invoked when an error occurs.
   *
   * @param err - The error that occurred
   */
  onerror: ((err: Error) => void) | null;

  /**
   * Get the Central Directory entry information for this file.
   *
   * This is called after the file has completed writing to get
   * the final metadata (CRC, sizes, etc.) for the Central Directory.
   *
   * @returns Entry info or null if not yet available
   */
  getCentralDirectoryEntryInfo(): ZipCentralDirEntry | null;

  /**
   * Abort writing this entry.
   *
   * @param reason - Optional abort reason
   */
  abort(reason?: unknown): void;

  /**
   * Optional hook to begin producing output.
   *
   * Some writers (e.g. passthrough raw entries) only start emitting data
   * once this is called. This allows the StreamingZip to control when
   * the writer begins output.
   */
  start?(): Promise<void>;
}
