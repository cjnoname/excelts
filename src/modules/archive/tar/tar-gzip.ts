/**
 * TAR + Gzip (tar.gz / tgz) Support
 *
 * Provides utilities for creating and extracting gzip-compressed TAR archives.
 * Uses the unified compress module for compression/decompression.
 */

import { gunzip } from "@archive/compression/compress";
import { createGzipStream } from "@archive/compression/streaming-compress";
import { DEFAULT_COMPRESS_LEVEL } from "@archive/core/defaults";
import { collect } from "@archive/io/archive-sink";
import type { ArchiveSource } from "@archive/io/archive-source";
import { toUint8Array, isInMemoryArchiveSource, toAsyncIterable } from "@archive/io/archive-source";
import { gzipTarChunks } from "@archive/tar/gzip-tar-stream";
import type { TarArchiveOptions } from "@archive/tar/tar-archive";
import { TarArchive, addEntries } from "@archive/tar/tar-archive";
import type { TarEntry, TarParseOptions } from "@archive/tar/tar-parser";
import { parseTar, untar } from "@archive/tar/tar-parser";

export interface TarGzOptions extends TarArchiveOptions {
  /** Compression level (0-9, default: 6) */
  level?: number;
}

// Use TarParseOptions directly since we don't need gzip-specific parse options
export type ParseTarGzOptions = TarParseOptions;

/**
 * TarGz Archive Builder
 *
 * Creates gzip-compressed TAR archives (.tar.gz / .tgz)
 *
 * @example
 * ```ts
 * const archive = new TarGzArchive({ level: 6 });
 * archive.add("file.txt", "Hello, World!");
 * const bytes = await archive.bytes();
 * ```
 */
export class TarGzArchive extends TarArchive {
  private readonly _gzLevel: number;

  constructor(options: TarGzOptions = {}) {
    super(options);
    this._gzLevel = options.level ?? DEFAULT_COMPRESS_LEVEL;
  }

  /**
   * Generate compressed archive as async iterable (true streaming)
   */
  override async *stream(): AsyncIterable<Uint8Array> {
    const gzipStream = createGzipStream({ level: this._gzLevel });
    yield* gzipTarChunks(super.stream(), gzipStream);
  }
}

/**
 * Create a gzip-compressed TAR archive
 */
export async function targz(
  entries: Map<string, ArchiveSource> | Array<{ name: string; source: ArchiveSource }>,
  options: TarGzOptions = {}
): Promise<Uint8Array> {
  const archive = new TarGzArchive(options);
  addEntries(archive, entries);
  return archive.bytes();
}

/**
 * Helper to get compressed data from any archive source
 */
async function getCompressedData(source: ArchiveSource, signal?: AbortSignal): Promise<Uint8Array> {
  if (isInMemoryArchiveSource(source)) {
    return toUint8Array(source);
  }
  return collect(toAsyncIterable(source, { signal }));
}

/**
 * Parse a gzip-compressed TAR archive
 *
 * @param source - Compressed archive data
 * @param options - Parse options
 * @returns Array of TAR entries
 */
export async function parseTarGz(
  source: ArchiveSource,
  options: ParseTarGzOptions = {}
): Promise<TarEntry[]> {
  const compressed = await getCompressedData(source, options.signal);
  return parseTar(await gunzip(compressed), options);
}

/**
 * Parse a gzip-compressed TAR archive as async iterable stream
 */
export async function* parseTarGzStream(
  source: ArchiveSource,
  options: ParseTarGzOptions = {}
): AsyncIterable<TarEntry> {
  // For gzip, we need to decompress completely first
  // Streaming decompression of gzip is possible but adds complexity
  yield* await parseTarGz(source, options);
}

/**
 * Extract gzip-compressed TAR archive to Map
 *
 * @param source - Compressed archive data
 * @param options - Parse options
 * @returns Map of path → { info, data }
 */
export async function untargz(
  source: ArchiveSource,
  options: ParseTarGzOptions = {}
): Promise<Map<string, { info: TarEntry["info"]; data: Uint8Array }>> {
  const compressed = await getCompressedData(source, options.signal);
  return untar(await gunzip(compressed), options);
}
