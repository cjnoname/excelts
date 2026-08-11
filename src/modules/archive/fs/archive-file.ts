/**
 * Unified ArchiveFile class supporting both ZIP and TAR formats.
 *
 * The class provides a common API for creating, reading, and modifying archives,
 * with format-specific features available based on the `format` option.
 *
 * @example Create a ZIP archive (default)
 * ```ts
 * const archive = new ArchiveFile();
 * archive.addFile("./readme.md");
 * archive.addDirectory("./src");
 * await archive.writeToFile("./output.zip");
 * ```
 *
 * @example Create a TAR archive
 * ```ts
 * const archive = new ArchiveFile({ format: "tar" });
 * archive.addFile("./readme.md");
 * archive.addDirectory("./src");
 * await archive.writeToFile("./output.tar");
 * ```
 *
 * @example Create a gzipped TAR archive
 * ```ts
 * const archive = new ArchiveFile({ format: "tar", gzip: true });
 * archive.addFile("./readme.md");
 * await archive.writeToFile("./output.tar.gz");
 * ```
 *
 * @module
 */

import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";

import { gzipSync, gunzipSync } from "@archive/compression/compress";
import { createGzipStream } from "@archive/compression/streaming-compress";
import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import { ArchiveError, createAbortError } from "@archive/core/errors";
import type { ZipStringEncoding } from "@archive/core/text";
import type { ArchiveFormat } from "@archive/core/types";
import type {
  AddFileOptions,
  AddDirectoryOptions,
  AddGlobOptions,
  AddTarFileOptions,
  AddTarDirectoryOptions,
  AddTarGlobOptions,
  ExtractToOptions,
  ArchiveFileOptions,
  ArchiveFileOptionsZip,
  ArchiveFileOptionsTar,
  OpenArchiveOptions,
  OpenArchiveOptionsZip,
  OpenArchiveOptionsTar,
  WriteZipOptions,
  WriteArchiveOptions,
  ArchiveEntryInfo,
  ZipEntryInfo,
  ZipFileOptions,
  OverwriteStrategy,
  ArchiveWarning,
  ArchiveStreamOptions,
  ArchiveStreamProgress,
  ArchiveStreamOperation,
  TransformFunction,
  TransformEntryData
} from "@archive/fs/types";
import type { ArchiveSink } from "@archive/io/archive-sink";
import { pipeIterableToSink } from "@archive/io/archive-sink";
import { collectUint8ArrayStream, toAsyncIterable } from "@archive/io/archive-source";
import { TarArchive, TarReader } from "@archive/tar/tar-archive";
import { TAR_TYPE } from "@archive/tar/tar-constants";
import { isDirectory as isTarDirectory } from "@archive/tar/tar-entry-info";
import type { ZipEntryRecord } from "@archive/unzip/zip-parser";
import { ZipParser } from "@archive/unzip/zip-parser";
import type { ZipPathOptions } from "@archive/zip-spec/zip-path";
import { joinZipPath, normalizeZipPath } from "@archive/zip-spec/zip-path";
import { ZipArchive } from "@archive/zip/zip-archive";
import type { ZipEntry } from "@archive/zip/zip-bytes";
import { createZip, createZipSync } from "@archive/zip/zip-bytes";
import { ZipEditView } from "@archive/zip/zip-edit-view";
import { textEncoder as utf8Encoder } from "@utils/binary";
import type { FileEntry } from "@utils/fs";
import {
  traverseDirectory,
  traverseDirectorySync,
  glob as globFiles,
  globSync as globFilesSync,
  ensureDir,
  ensureDirSync,
  fileExists,
  fileExistsSync,
  readFileBytes,
  readFileBytesSync,
  writeFileBytes,
  writeFileBytesSync,
  setFileTime,
  setFileTimeSync,
  safeStats,
  safeStatsSync,
  createSymlink,
  createSymlinkSync,
  chmod,
  chmodSync,
  supportsUnixPermissions
} from "@utils/fs";

// =============================================================================
// Transform Helpers (internal)
// =============================================================================

function applyTransform(
  entry: FileEntry,
  prefix: string | undefined,
  transform?: TransformFunction
): TransformEntryData | null {
  const data: TransformEntryData = {
    name: entry.relativePath,
    isDirectory: entry.isDirectory,
    size: entry.size,
    mtime: entry.mtime,
    atime: entry.atime,
    ctime: entry.ctime,
    birthTime: entry.birthTime,
    mode: entry.mode,
    prefix
  };
  if (!transform) {
    return data;
  }
  const result = transform(data);
  return result === false ? null : (result ?? data);
}

function mergeToZipOptions(t: TransformEntryData, opts: AddFileOptions): AddFileOptions {
  return {
    ...opts,
    modTime: t.mtime,
    atime: t.atime,
    ctime: t.ctime,
    birthTime: t.birthTime,
    mode: t.mode ?? opts.mode
  };
}

function mergeToTarOptions(t: TransformEntryData, opts: AddTarFileOptions): AddTarFileOptions {
  return { ...opts, modTime: t.mtime, mode: t.mode ?? opts.mode };
}

// =============================================================================
// ZIP Helper Types
// =============================================================================

interface ZipPendingFileEntry {
  type: "file";
  localPath: string;
  zipPath: string;
  options: AddFileOptions;
}

interface ZipPendingBufferEntry {
  type: "buffer";
  data: Uint8Array;
  zipPath: string;
  options: AddFileOptions;
}

interface ZipPendingStreamEntry {
  type: "stream";
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  zipPath: string;
  options: AddFileOptions;
}

interface ZipPendingDirectoryEntry {
  type: "directory";
  localPath: string;
  options: AddDirectoryOptions;
}

interface ZipPendingGlobEntry {
  type: "glob";
  pattern: string;
  options: AddGlobOptions;
}

interface ZipPendingSymlinkEntry {
  type: "symlink";
  zipPath: string;
  target: string;
  mode?: number;
}

type ZipPendingEntry =
  | ZipPendingFileEntry
  | ZipPendingBufferEntry
  | ZipPendingStreamEntry
  | ZipPendingDirectoryEntry
  | ZipPendingGlobEntry
  | ZipPendingSymlinkEntry;

// =============================================================================
// TAR Helper Types
// =============================================================================

type TarPendingEntry =
  | { type: "file"; localPath: string; tarPath: string; options: AddTarFileOptions }
  | { type: "buffer"; data: Uint8Array; tarPath: string; options: AddTarFileOptions }
  | {
      type: "stream";
      stream: AsyncIterable<Uint8Array>;
      tarPath: string;
      options: AddTarFileOptions;
    }
  | { type: "directory"; localPath: string; options: AddTarDirectoryOptions }
  | { type: "glob"; pattern: string; options: AddTarGlobOptions }
  | { type: "symlink"; tarPath: string; target: string; mode?: number };

// =============================================================================
// ZIP Helper Functions
// =============================================================================

/**
 * Resolve effective ZIP path options for an operation.
 */
function resolveZipPathOptions(globalOptions: ZipFileOptions): ZipPathOptions {
  return {
    mode: "legacy",
    ...(globalOptions.path ?? {})
  };
}

type ZipModeOptions = { mode?: number };

function resolveEntryMode(
  kind: "file" | "directory",
  globalOptions: ZipFileOptions,
  localOptions?: ZipModeOptions,
  fsMode?: number
): number | undefined {
  if (!(globalOptions.writePermissions ?? false)) {
    return undefined;
  }

  if (localOptions?.mode !== undefined) {
    return localOptions.mode;
  }

  if ((globalOptions.preservePermissions ?? false) && fsMode !== undefined) {
    return fsMode;
  }

  if (kind === "directory") {
    return 0o040755;
  }
  return 0o100644;
}

function buildDirectoryEntry(
  zipPath: string,
  fsEntry: FileEntry,
  globalOptions: ZipFileOptions,
  localOptions: AddDirectoryOptions
): ZipEntry {
  return {
    name: zipPath + "/",
    data: EMPTY_UINT8ARRAY,
    level: 0,
    modTime: fsEntry.mtime,
    atime: fsEntry.atime,
    ctime: fsEntry.ctime,
    birthTime: fsEntry.birthTime,
    mode: resolveEntryMode("directory", globalOptions, localOptions, fsEntry.mode),
    msDosAttributes: localOptions.msDosAttributes,
    encoding: localOptions.encoding ?? globalOptions.encoding
  };
}

/**
 * Check for path traversal attack and throw if detected.
 */
function assertNoPathTraversal(targetPath: string, baseDir: string, entryPath: string): void {
  if (!targetPath.startsWith(baseDir + path.sep) && targetPath !== baseDir) {
    throw new ArchiveError(`Path traversal detected: ${entryPath}`);
  }
}

/**
 * Get effective Unix mode for extraction.
 * If the archive entry has no mode info (mode=0), returns sensible defaults.
 *
 * @param mode - The mode from the archive entry
 * @param kind - "file" or "directory"
 * @returns Effective mode with permission bits
 */
function getEffectiveMode(mode: number, kind: "file" | "directory"): number {
  // Extract permission bits (lower 12 bits: rwx for owner/group/other + sticky/setuid/setgid)
  const permBits = mode & 0o7777;

  if (permBits !== 0) {
    // Entry has permission info
    return permBits;
  }

  // No permission info (e.g., Windows-created ZIP) - use defaults
  // Default: directories 0o755 (rwxr-xr-x), files 0o644 (rw-r--r--)
  return kind === "directory" ? 0o755 : 0o644;
}

/**
 * Assert that the archive format is ZIP, throw a descriptive error otherwise.
 */
function assertZipFormat(format: ArchiveFormat, methodName: string): asserts format is "zip" {
  if (format !== "zip") {
    throw new ArchiveError(`${methodName} is only available for ZIP archives`);
  }
}

/**
 * Throw a descriptive error for TAR methods that don't support sync operations.
 */
function throwTarSyncNotSupported(methodName: string): never {
  throw new ArchiveError(`${methodName} is not supported for TAR archives (use async version)`);
}

const DEFAULT_IO_CONCURRENCY = 8;

function isIgnorableFsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

type WarningCallback = ((warning: ArchiveWarning) => void) | undefined;

function emitExtractWarning(
  onWarning: WarningCallback,
  entryPath: string,
  targetPath: string,
  err: unknown
): void {
  if (!onWarning) {
    return;
  }
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const errMessage = err instanceof Error ? err.message : String(err);
  // For filesystem errors with a code, use a generic message; otherwise preserve the original
  const message =
    code != null
      ? `Skipping extraction due to filesystem error (${String(code)})`
      : errMessage || "Skipping extraction due to error";
  onWarning({ operation: "extract", entryPath, targetPath, message, error: err });
}

/**
 * Try a filesystem operation, emit warning and return false if it's an ignorable error.
 * Throws if the error is not ignorable.
 */
async function tryFsOpWithWarning(
  fn: () => Promise<void>,
  onWarning: WarningCallback,
  entryPath: string,
  targetPath: string
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    if (isIgnorableFsError(err)) {
      emitExtractWarning(onWarning, entryPath, targetPath, err);
      return false;
    }
    throw err;
  }
}

/**
 * Synchronous version of tryFsOpWithWarning.
 */
function tryFsOpWithWarningSync(
  fn: () => void,
  onWarning: WarningCallback,
  entryPath: string,
  targetPath: string
): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    if (isIgnorableFsError(err)) {
      emitExtractWarning(onWarning, entryPath, targetPath, err);
      return false;
    }
    throw err;
  }
}

async function processInOrderWithConcurrency<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
  concurrency: number,
  task: (item: T) => Promise<() => void>
): Promise<void> {
  const inFlight = new Map<number, Promise<() => void>>();
  let index = 0;
  let next = 0;

  for await (const item of iterable) {
    const current = index++;
    inFlight.set(current, task(item));

    while (inFlight.size >= concurrency) {
      const apply = await inFlight.get(next)!;
      inFlight.delete(next);
      next++;
      apply();
    }
  }

  while (next < index) {
    const apply = await inFlight.get(next)!;
    inFlight.delete(next);
    next++;
    apply();
  }
}

/** Default mode for TAR directories */
const TAR_DIR_MODE = 0o755;

/**
 * Core logic for shouldExtract - shared between async and sync versions.
 */
function shouldExtractCore(
  exists: boolean,
  entryMtime: Date,
  strategy: OverwriteStrategy,
  targetPath: string,
  getStats: () => { mtime: Date } | null
): boolean {
  if (!exists) {
    return true;
  }

  switch (strategy) {
    case "skip":
      return false;

    case "overwrite":
      return true;

    case "error":
      throw new ArchiveError(`File already exists: ${targetPath}`);

    case "newer": {
      const stats = getStats();
      if (!stats) {
        return true;
      }
      return entryMtime > stats.mtime;
    }

    default:
      throw new ArchiveError(`Unknown overwrite strategy: ${strategy}`);
  }
}

/**
 * Check if extraction should proceed based on overwrite strategy.
 */
async function shouldExtract(
  targetPath: string,
  entryMtime: Date,
  strategy: OverwriteStrategy
): Promise<boolean> {
  const exists = await fileExists(targetPath);
  if (strategy === "newer" && exists) {
    const stats = await safeStats(targetPath);
    return shouldExtractCore(exists, entryMtime, strategy, targetPath, () => stats);
  }
  return shouldExtractCore(exists, entryMtime, strategy, targetPath, () => null);
}

/**
 * Synchronous version of shouldExtract.
 */
function shouldExtractSync(
  targetPath: string,
  entryMtime: Date,
  strategy: OverwriteStrategy
): boolean {
  const exists = fileExistsSync(targetPath);
  return shouldExtractCore(exists, entryMtime, strategy, targetPath, () =>
    safeStatsSync(targetPath)
  );
}

/**
 * Collect all chunks from an async iterable or ReadableStream.
 */
async function collectStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  return collectUint8ArrayStream(stream);
}

/**
 * Convert AddDirectoryOptions/AddGlobOptions filter to FileEntry filter.
 */
type TraverseFilter = (entry: {
  relativePath: string;
  isDirectory: boolean;
  size: number;
}) => boolean;

function wrapFilter(
  filter: ((path: string, stats: { isDirectory: boolean; size: number }) => boolean) | undefined
): TraverseFilter | undefined {
  return filter
    ? e => filter(e.relativePath, { isDirectory: e.isDirectory, size: e.size })
    : undefined;
}

/**
 * Map a ZipParser entry to ArchiveEntryInfo format.
 */
function mapZipEntryToInfo(e: ZipEntryRecord): ZipEntryInfo {
  return {
    path: e.path,
    isDirectory: e.type === "directory",
    size: e.uncompressedSize,
    compressedSize: e.compressedSize,
    lastModified: e.lastModified,
    crc32: e.crc32,
    isEncrypted: e.isEncrypted,
    encryptionMethod:
      e.encryptionMethod === "aes"
        ? "aes"
        : e.encryptionMethod === "zipcrypto"
          ? "zipcrypto"
          : undefined,
    aesKeyStrength: e.aesKeyStrength,
    comment: e.comment
  };
}

/**
 * Build a ZipEntry from common parameters.
 */
function buildZipEntry(
  name: string,
  data: Uint8Array,
  entryOptions: AddFileOptions,
  globalOptions: ZipFileOptions,
  globalPassword: string | Uint8Array | undefined,
  fsMetadata?: {
    modTime?: Date;
    mode?: number;
    atime?: Date;
    ctime?: Date;
    birthTime?: Date;
  }
): ZipEntry {
  const mode = resolveEntryMode("file", globalOptions, entryOptions, fsMetadata?.mode);
  const externalAttributes = entryOptions.externalAttributes;

  return {
    name,
    data,
    level: entryOptions.level ?? globalOptions.level,
    modTime: entryOptions.modTime ?? fsMetadata?.modTime ?? new Date(),
    atime: entryOptions.atime ?? fsMetadata?.atime,
    ctime: entryOptions.ctime ?? fsMetadata?.ctime,
    birthTime: entryOptions.birthTime ?? fsMetadata?.birthTime,
    comment: entryOptions.comment,
    encoding: entryOptions.encoding ?? globalOptions.encoding,
    encryptionMethod: entryOptions.encryptionMethod ?? globalOptions.encryptionMethod,
    password: entryOptions.password ?? globalPassword,
    mode,
    msDosAttributes: entryOptions.msDosAttributes,
    externalAttributes
  };
}

/**
 * Build a ZipEntry for preserving an existing entry (no update).
 */
function buildPreservedEntry(
  existingEntry: { path: string; lastModified: Date; comment: string; externalAttributes: number },
  data: Uint8Array,
  globalOptions: ZipFileOptions,
  globalPassword: string | Uint8Array | undefined
): ZipEntry {
  return {
    name: existingEntry.path,
    data,
    level: globalOptions.level,
    modTime: existingEntry.lastModified,
    comment: existingEntry.comment,
    encoding: globalOptions.encoding,
    encryptionMethod: globalOptions.encryptionMethod,
    password: globalPassword,
    externalAttributes: existingEntry.externalAttributes
  };
}

/**
 * Build a symlink ZipEntry.
 */
function buildSymlinkEntry(
  zipPath: string,
  target: string,
  mode?: number,
  encoding?: ZipStringEncoding
): ZipEntry {
  return {
    name: zipPath,
    data: utf8Encoder.encode(target),
    level: 0,
    modTime: new Date(),
    mode: mode ?? 0o120777,
    encoding
  };
}

/**
 * Check overwrite strategy and return whether to proceed.
 */
function checkOverwriteStrategy(
  exists: boolean,
  targetPath: string,
  overwrite: OverwriteStrategy
): boolean {
  if (!exists) {
    return true;
  }

  switch (overwrite) {
    case "skip":
      return false;
    case "error":
      throw new ArchiveError(`File already exists: ${targetPath}`);
    case "overwrite":
    case "newer":
      return true;
    default:
      throw new ArchiveError(`Unknown overwrite strategy: ${overwrite}`);
  }
}

// =============================================================================
// TAR Helper Functions
// =============================================================================

function normalizeTarPath(name: string, prefix?: string): string {
  let result = name.replace(/\\/g, "/");
  result = result.replace(/^\/+/, "");
  if (prefix) {
    let normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\/+/, "");
    // Trim trailing slashes without regex to avoid ReDoS on long '/' runs
    let end = normalizedPrefix.length;
    while (end > 0 && normalizedPrefix[end - 1] === "/") {
      end--;
    }
    normalizedPrefix = normalizedPrefix.slice(0, end);
    result = normalizedPrefix ? `${normalizedPrefix}/${result}` : result;
  }
  return result;
}
/**
 * Build TAR entry add options from pending entry options and optional file stats.
 */
function buildTarAddOptions(
  entryOptions: AddTarFileOptions,
  stats?: { mode?: number; mtime?: Date } | null
): { mode?: number; mtime?: Date; uid?: number; gid?: number; uname?: string; gname?: string } {
  return {
    mode: entryOptions.mode ?? stats?.mode,
    mtime: entryOptions.modTime ?? stats?.mtime,
    uid: entryOptions.uid,
    gid: entryOptions.gid,
    uname: entryOptions.uname,
    gname: entryOptions.gname
  };
}

/**
 * Build TAR symlink entry options.
 * Type "2" is the symlink type per RFC 1062.
 */
function buildTarSymlinkOptions(target: string, mode?: number) {
  return {
    type: TAR_TYPE.SYMLINK, // TAR symlink type (RFC 1062)
    linkname: target,
    mode
  };
}

/**
 * Wrap a streaming operation to conform to ArchiveStreamOperation interface.
 */
function wrapStreamOperation(
  op: {
    iterable: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
    abort: (reason?: unknown) => void;
    pointer: () => number;
    progress: () => ArchiveStreamProgress;
  },
  overrideIterable?: AsyncIterable<Uint8Array>
): ArchiveStreamOperation {
  return {
    iterable: overrideIterable ?? op.iterable,
    signal: op.signal,
    abort: reason => op.abort(reason),
    pointer: () => op.pointer(),
    progress: () => op.progress()
  };
}

// =============================================================================
// ZIP Entry Processing Types (for shared async/sync logic)
// =============================================================================

/**
 * Context for processing ZIP entries, supporting both async and sync operations.
 */
interface ZipBuildContext {
  entries: ZipEntry[];
  globalOptions: ZipFileOptions;
  globalPassword: string | Uint8Array | undefined;
  pathOptions: ZipPathOptions;
  bytesWritten: number;
  checkAbort?: () => void;
  /** I/O concurrency limit for directory/glob operations */
  concurrency: number;
}

/**
 * File system operations abstraction for async/sync ZIP building.
 */
interface ZipFsOps {
  readFile: (path: string) => Uint8Array | Promise<Uint8Array>;
  getStats: (path: string) => ReturnType<typeof safeStatsSync> | ReturnType<typeof safeStats>;
  traverseDir: typeof traverseDirectory | typeof traverseDirectorySync;
  globFiles: typeof globFiles | typeof globFilesSync;
  collectStream?: (
    stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
  ) => Promise<Uint8Array>;
}

/**
 * Process a single ZIP pending entry and add to context.entries.
 * Works for both async and sync modes via the fsOps abstraction.
 */
async function processZipPendingEntry(
  pending: ZipPendingEntry,
  ctx: ZipBuildContext,
  fsOps: ZipFsOps
): Promise<void> {
  ctx.checkAbort?.();

  switch (pending.type) {
    case "file": {
      const data = await fsOps.readFile(pending.localPath);
      const stats = await fsOps.getStats(pending.localPath);
      ctx.entries.push(
        buildZipEntry(
          pending.zipPath,
          data,
          pending.options,
          ctx.globalOptions,
          ctx.globalPassword,
          {
            modTime: stats?.mtime,
            mode: stats?.mode,
            atime: stats?.atime,
            ctime: stats?.ctime,
            birthTime: stats?.birthtime
          }
        )
      );
      ctx.bytesWritten += data.length;
      break;
    }

    case "buffer": {
      ctx.entries.push(
        buildZipEntry(
          pending.zipPath,
          pending.data,
          pending.options,
          ctx.globalOptions,
          ctx.globalPassword
        )
      );
      ctx.bytesWritten += pending.data.length;
      break;
    }

    case "stream": {
      if (!fsOps.collectStream) {
        throw new ArchiveError("Stream entries cannot be processed synchronously.");
      }
      const data = await fsOps.collectStream(pending.stream);
      ctx.entries.push(
        buildZipEntry(pending.zipPath, data, pending.options, ctx.globalOptions, ctx.globalPassword)
      );
      ctx.bytesWritten += data.length;
      break;
    }

    case "symlink": {
      const symlinkEntry = buildSymlinkEntry(
        pending.zipPath,
        pending.target,
        pending.mode,
        ctx.globalOptions.encoding
      );
      ctx.entries.push(symlinkEntry);
      ctx.bytesWritten += symlinkEntry.data.length;
      break;
    }

    case "directory": {
      const { prefix, includeRoot = true, recursive = true, filter, transform } = pending.options;
      const dirName = path.basename(pending.localPath);
      const basePrefix = prefix ?? (includeRoot ? dirName : "");

      const traverseResult = fsOps.traverseDir(pending.localPath, {
        recursive,
        followSymlinks: pending.options.followSymlinks,
        // Only use filter if no transform is provided (transform supersedes filter)
        filter: transform ? undefined : wrapFilter(filter)
      });

      await processInOrderWithConcurrency<FileEntry>(
        traverseResult,
        ctx.concurrency,
        async (entry: FileEntry) => {
          ctx.checkAbort?.();

          // Apply transform function if provided
          const transformed = applyTransform(entry, basePrefix, transform);
          if (transformed === null) {
            // Entry was filtered out by transform returning false
            return () => {};
          }

          // Use transformed name and prefix
          const effectivePrefix = transformed.prefix ?? basePrefix;
          const zipPath = joinZipPath(ctx.pathOptions, effectivePrefix, transformed.name);

          if (entry.isDirectory) {
            return () => {
              ctx.entries.push(
                buildDirectoryEntry(
                  zipPath,
                  {
                    ...entry,
                    mtime: transformed.mtime,
                    atime: transformed.atime ?? entry.atime,
                    ctime: transformed.ctime ?? entry.ctime,
                    birthTime: transformed.birthTime ?? entry.birthTime,
                    mode: transformed.mode ?? entry.mode
                  },
                  ctx.globalOptions,
                  pending.options
                )
              );
            };
          }

          const data = await fsOps.readFile(entry.absolutePath);
          const mergedOptions = transform
            ? mergeToZipOptions(transformed, pending.options)
            : pending.options;

          return () => {
            ctx.entries.push(
              buildZipEntry(zipPath, data, mergedOptions, ctx.globalOptions, ctx.globalPassword, {
                modTime: transformed.mtime,
                mode: transformed.mode ?? entry.mode,
                atime: transformed.atime ?? entry.atime,
                ctime: transformed.ctime ?? entry.ctime,
                birthTime: transformed.birthTime ?? entry.birthTime
              })
            );
            ctx.bytesWritten += data.length;
          };
        }
      );
      break;
    }

    case "glob": {
      const { cwd, prefix, ignore, dot, followSymlinks, filter, transform } = pending.options;

      const globResult = fsOps.globFiles(pending.pattern, {
        cwd,
        ignore,
        dot,
        followSymlinks,
        // Only use filter if no transform is provided (transform supersedes filter)
        filter: transform ? undefined : wrapFilter(filter)
      });

      await processInOrderWithConcurrency<FileEntry>(
        globResult,
        ctx.concurrency,
        async (entry: FileEntry) => {
          ctx.checkAbort?.();

          // Apply transform function if provided
          const transformed = applyTransform(entry, prefix, transform);
          if (transformed === null) {
            // Entry was filtered out by transform returning false
            return () => {};
          }

          // Use transformed name and prefix
          const effectivePrefix = transformed.prefix ?? prefix ?? "";
          const zipPath = joinZipPath(ctx.pathOptions, effectivePrefix, transformed.name);
          const data = await fsOps.readFile(entry.absolutePath);
          const mergedOptions = transform
            ? mergeToZipOptions(transformed, pending.options)
            : pending.options;

          return () => {
            ctx.entries.push(
              buildZipEntry(zipPath, data, mergedOptions, ctx.globalOptions, ctx.globalPassword, {
                modTime: transformed.mtime,
                mode: transformed.mode ?? entry.mode,
                atime: transformed.atime ?? entry.atime,
                ctime: transformed.ctime ?? entry.ctime,
                birthTime: transformed.birthTime ?? entry.birthTime
              })
            );
            ctx.bytesWritten += data.length;
          };
        }
      );
      break;
    }
  }
}

// =============================================================================
// ArchiveFile Class
// =============================================================================

/**
 * Non-conditional view of the ZIP-mode mutable state fields of {@link ArchiveFile}.
 *
 * The class declares these fields conditionally on the format parameter `F`
 * (`F extends "zip" ? T : null`). This interface mirrors the resolved `"zip"`
 * branch so the internal `_setZipState` setter can type its `value` argument
 * precisely without the format generic getting in the way.
 */
interface ArchiveZipState {
  _zipData: Uint8Array | null;
  _zipParser: ZipParser | null;
  _zipPassword: string | Uint8Array | undefined;
  _zipEditView: ZipEditView<ZipEntryRecord> | null;
  _zipAbortController: AbortController | null;
  _zipBytesWritten: number;
  _zipPendingEntries: ZipPendingEntry[];
  _zipSourcePath: string | null;
}

/**
 * Unified archive file class supporting both ZIP and TAR formats.
 *
 * This class provides file system integration for creating and reading archives.
 *
 * @template F - Archive format ("zip" or "tar")
 */
export class ArchiveFile<F extends ArchiveFormat = "zip"> {
  private readonly _format: F;

  // ===========================================================================
  // ZIP State
  // ===========================================================================
  private _zipOptions: F extends "zip" ? ZipFileOptions : null;
  private _zipPendingEntries: F extends "zip" ? ZipPendingEntry[] : null;
  private _zipData: F extends "zip" ? Uint8Array | null : null;
  private _zipParser: F extends "zip" ? ZipParser | null : null;
  private _zipSourcePath: F extends "zip" ? string | null : null;
  private _zipPassword: F extends "zip" ? string | Uint8Array | undefined : null;
  private _zipEditView: F extends "zip" ? ZipEditView<ZipEntryRecord> | null : null;
  private _zipAbortController: F extends "zip" ? AbortController | null : null;
  private _zipBytesWritten: F extends "zip" ? number : null;

  // ===========================================================================
  // TAR State
  // ===========================================================================
  private readonly _tarArchive: F extends "tar" ? TarArchive : null;
  private _tarReader: F extends "tar" ? TarReader | null : null;
  private readonly _tarPendingEntries: F extends "tar" ? TarPendingEntry[] : null;
  private readonly _tarOptions: F extends "tar" ? ArchiveFileOptionsTar : null;

  // =============================================================================
  // Constructors
  // =============================================================================

  /**
   * Create a new ZIP archive file.
   */
  constructor(options?: ArchiveFileOptionsZip);
  /**
   * Create a new TAR archive file.
   */
  constructor(options: ArchiveFileOptionsTar);
  /**
   * Create a new archive file with the specified format.
   */
  constructor(options?: ArchiveFileOptions);
  constructor(options: ArchiveFileOptions = {}) {
    const format = (options.format ?? "zip") as F;
    this._format = format;

    if (format === "zip") {
      // ZIP mode
      const zipOptions = options as ArchiveFileOptionsZip;
      this._zipOptions = zipOptions as F extends "zip" ? ZipFileOptions : null;
      this._zipPendingEntries = [] as unknown as F extends "zip" ? ZipPendingEntry[] : null;
      this._zipData = null as F extends "zip" ? Uint8Array | null : null;
      this._zipParser = null as F extends "zip" ? ZipParser | null : null;
      this._zipSourcePath = null as F extends "zip" ? string | null : null;
      this._zipPassword = zipOptions.password as F extends "zip"
        ? string | Uint8Array | undefined
        : null;
      this._zipEditView = null as F extends "zip" ? ZipEditView<ZipEntryRecord> | null : null;
      this._zipAbortController = null as F extends "zip" ? AbortController | null : null;
      this._zipBytesWritten = 0 as F extends "zip" ? number : null;

      // TAR fields null
      this._tarArchive = null as F extends "tar" ? TarArchive : null;
      this._tarReader = null as F extends "tar" ? TarReader | null : null;
      this._tarPendingEntries = null as F extends "tar" ? TarPendingEntry[] : null;
      this._tarOptions = null as F extends "tar" ? ArchiveFileOptionsTar : null;
    } else {
      // TAR mode
      const tarOptions = options as ArchiveFileOptionsTar;
      this._tarArchive = new TarArchive() as F extends "tar" ? TarArchive : null;
      this._tarReader = null as F extends "tar" ? TarReader | null : null;
      this._tarPendingEntries = [] as unknown as F extends "tar" ? TarPendingEntry[] : null;
      this._tarOptions = tarOptions as F extends "tar" ? ArchiveFileOptionsTar : null;

      // ZIP fields null
      this._zipOptions = null as F extends "zip" ? ZipFileOptions : null;
      this._zipPendingEntries = null as F extends "zip" ? ZipPendingEntry[] : null;
      this._zipData = null as F extends "zip" ? Uint8Array | null : null;
      this._zipParser = null as F extends "zip" ? ZipParser | null : null;
      this._zipSourcePath = null as F extends "zip" ? string | null : null;
      this._zipPassword = null as F extends "zip" ? string | Uint8Array | undefined : null;
      this._zipEditView = null as F extends "zip" ? ZipEditView<ZipEntryRecord> | null : null;
      this._zipAbortController = null as F extends "zip" ? AbortController | null : null;
      this._zipBytesWritten = null as F extends "zip" ? number : null;
    }
  }

  // ===========================================================================
  // ZIP Internal Methods
  // ===========================================================================

  /**
   * Get the ZIP creation options for createZip/createZipSync.
   */
  private _getCreateZipOptions() {
    const opts = this._zipOptions as ZipFileOptions;
    return {
      level: opts.level,
      timestamps: opts.timestamps,
      comment: opts.comment,
      zip64: opts.zip64,
      modTime: opts.modTime,
      reproducible: opts.reproducible,
      smartStore: opts.smartStore,
      encryptionMethod: opts.encryptionMethod,
      password: this._zipPassword as string | Uint8Array | undefined
    };
  }

  // ===========================================================================
  // ZIP State Accessors (type-safe helpers to reduce casts)
  // ===========================================================================

  /** Get ZIP options (throws if not ZIP format) */
  private get _zip_options(): ZipFileOptions {
    return this._zipOptions as ZipFileOptions;
  }

  /** Get ZIP pending entries array */
  private get _zip_pending(): ZipPendingEntry[] {
    return this._zipPendingEntries as ZipPendingEntry[];
  }

  /** Get ZIP parser (may be null) */
  private get _zip_parser(): ZipParser | null {
    return this._zipParser as ZipParser | null;
  }

  /** Get ZIP password */
  private get _zip_password(): string | Uint8Array | undefined {
    return this._zipPassword as string | Uint8Array | undefined;
  }

  /** Get ZIP edit view (may be null) */
  private get _zip_editView(): ZipEditView<ZipEntryRecord> | null {
    return this._zipEditView as ZipEditView<ZipEntryRecord> | null;
  }

  /** Get TAR pending entries array */
  private get _tar_pending(): TarPendingEntry[] {
    return this._tarPendingEntries as TarPendingEntry[];
  }

  /** Get TAR archive */
  private get _tar_archive(): TarArchive {
    return this._tarArchive as TarArchive;
  }

  /** Get TAR options */
  private get _tar_options(): ArchiveFileOptionsTar {
    return this._tarOptions as ArchiveFileOptionsTar;
  }

  /** Set a ZIP state field */
  /**
   * Set a ZIP state field.
   *
   * The ZIP state fields are conditionally typed on the archive format `F`
   * (`F extends "zip" ? T : null`). Within this generic class `F` is unresolved,
   * so a precise per-key value type cannot be expressed. Callers only invoke this
   * in the ZIP branch with the correct value type; the assignment is funneled
   * through a single localized cast.
   */
  private _setZipState<
    K extends
      | "_zipData"
      | "_zipParser"
      | "_zipPassword"
      | "_zipEditView"
      | "_zipAbortController"
      | "_zipBytesWritten"
      | "_zipPendingEntries"
      | "_zipSourcePath"
  >(key: K, value: ArchiveZipState[K]): void {
    (this as unknown as ArchiveZipState)[key] = value;
  }

  /** Set the TAR reader for read mode */
  private _setTarReader(reader: TarReader): void {
    this._tarReader = reader as F extends "tar" ? TarReader | null : null;
  }

  /** Find pending ZIP entry index by normalized path, or -1 if missing. */
  private _findZipPendingIndex(zipPath: string): number {
    for (let i = 0; i < this._zip_pending.length; i++) {
      const pending = this._zip_pending[i]!;
      if ("zipPath" in pending && pending.zipPath === zipPath) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Initialize a ZIP archive from existing ZIP data.
   */
  private _initZipFromData(
    data: Uint8Array,
    password?: string | Uint8Array,
    sourcePath?: string,
    encoding?: ZipStringEncoding
  ): void {
    this._setZipState("_zipData", data);
    this._setZipState("_zipParser", new ZipParser(data, { password, encoding }));
    this._setZipState("_zipPassword", password);
    if (sourcePath) {
      this._setZipState("_zipSourcePath", sourcePath);
    }
    // Initialize edit view with existing entries
    const editView = new ZipEditView<ZipEntryRecord>({
      path: resolveZipPathOptions(this._zip_options)
    });
    editView.initFromEntries(this._zip_parser!.getEntries(), (e: ZipEntryRecord) => e.path);
    this._setZipState("_zipEditView", editView);
  }

  /**
   * Initialize a TAR archive from raw data.
   */
  private _initTarFromData(data: Uint8Array, gzip?: boolean): void {
    let tarData = data;
    if (gzip) {
      tarData = gunzipSync(data);
    }
    this._setTarReader(new TarReader(tarData));
  }

  /**
   * Shared factory logic for creating an archive from data.
   */
  private static _fromData(
    data: Uint8Array,
    options: OpenArchiveOptions,
    sourcePath?: string,
    autoDetectGzip?: boolean
  ): ArchiveFile<ArchiveFormat> {
    const format = options.format ?? "zip";

    if (format === "zip") {
      const archive = new ArchiveFile<"zip">({ format: "zip" });
      const zipOptions = options as OpenArchiveOptionsZip;
      archive._initZipFromData(data, zipOptions.password, sourcePath, zipOptions.encoding);
      return archive;
    } else {
      const archive = new ArchiveFile<"tar">(options as ArchiveFileOptionsTar);
      const tarOptions = options as OpenArchiveOptionsTar;
      const shouldGunzip = tarOptions.gzip || autoDetectGzip;
      archive._initTarFromData(data, shouldGunzip);
      return archive;
    }
  }

  // =============================================================================
  // Static Factory Methods
  // =============================================================================

  /**
   * Create an ArchiveFile from a file on disk.
   */
  static fromFile(filePath: string, options?: OpenArchiveOptionsZip): Promise<ArchiveFile<"zip">>;
  static fromFile(filePath: string, options: OpenArchiveOptionsTar): Promise<ArchiveFile<"tar">>;
  static async fromFile(
    filePath: string,
    options: OpenArchiveOptions = {}
  ): Promise<ArchiveFile<ArchiveFormat>> {
    const data = await readFileBytes(filePath);
    const autoDetectGzip = filePath.endsWith(".gz") || filePath.endsWith(".tgz");
    return ArchiveFile._fromData(data, options, path.resolve(filePath), autoDetectGzip);
  }

  /**
   * Create an ArchiveFile from a file on disk (sync).
   */
  static fromFileSync(filePath: string, options?: OpenArchiveOptionsZip): ArchiveFile<"zip">;
  static fromFileSync(filePath: string, options: OpenArchiveOptionsTar): ArchiveFile<"tar">;
  static fromFileSync(
    filePath: string,
    options: OpenArchiveOptions = {}
  ): ArchiveFile<ArchiveFormat> {
    const data = readFileBytesSync(filePath);
    const autoDetectGzip = filePath.endsWith(".gz") || filePath.endsWith(".tgz");
    return ArchiveFile._fromData(data, options, path.resolve(filePath), autoDetectGzip);
  }

  /**
   * Create an ArchiveFile from a buffer.
   */
  static fromBuffer(data: Uint8Array, options?: OpenArchiveOptionsZip): ArchiveFile<"zip">;
  static fromBuffer(data: Uint8Array, options: OpenArchiveOptionsTar): ArchiveFile<"tar">;
  static fromBuffer(
    data: Uint8Array,
    options: OpenArchiveOptions = {}
  ): ArchiveFile<ArchiveFormat> {
    return ArchiveFile._fromData(data, options);
  }

  // =============================================================================
  // Properties
  // =============================================================================

  /**
   * Get the archive format.
   */
  get format(): F {
    return this._format;
  }

  /**
   * Get the number of entries in the archive.
   *
   * - For ZIP: Returns the exact count from parser (read mode) or pending entries (write mode).
   * - For TAR in read mode: Returns 0 (TAR is stream-based, use getEntryCountAsync() for actual count).
   * - For TAR in write mode: Returns the pending entry count.
   */
  get entryCount(): number {
    if (this._format === "zip") {
      if (this._zip_parser) {
        return this._zip_parser.getEntries().length;
      }
      return this._zip_pending.length;
    } else {
      // TAR read mode: entries are stream-based, cannot get count without iterating
      // For write mode, return pending entries count
      if (this._tarReader) {
        // Note: TarReader doesn't expose entry count directly due to streaming nature
        // Users should use getEntryCountAsync() to iterate and count if needed
        return 0;
      }
      return this._tar_pending.length;
    }
  }

  /**
   * Get the exact entry count asynchronously.
   *
   * This method is useful for TAR archives in read mode, where entries must be
   * iterated to count them (due to the stream-based nature of TAR).
   *
   * For ZIP archives, this returns the same value as `entryCount`.
   *
   * @returns The number of entries in the archive
   */
  async getEntryCountAsync(): Promise<number> {
    if (this._format === "zip") {
      return this.entryCount;
    } else {
      if (!this._tarReader) {
        // Write mode: return pending count
        return this._tar_pending.length;
      }
      // Read mode: iterate entries to count
      const entries = await this.getEntries();
      return entries.length;
    }
  }

  /**
   * Get the source file path if the archive was loaded from disk.
   */
  get sourcePath(): string | null {
    if (this._format === "zip") {
      return this._zipSourcePath as string | null;
    }
    return null; // TAR doesn't track source path
  }

  /**
   * Check if the current operation has been aborted (ZIP only).
   */
  get aborted(): boolean {
    if (this._format === "zip") {
      return (this._zipAbortController as AbortController | null)?.signal.aborted ?? false;
    }
    return false;
  }

  // =============================================================================
  // Adding Files (Write Mode)
  // =============================================================================

  /**
   * Add a file from disk to the archive.
   */
  addFile(filePath: string, options?: F extends "tar" ? AddTarFileOptions : AddFileOptions): this {
    if (this._format === "zip") {
      const opts = (options ?? {}) as AddFileOptions;
      const resolvedPath = path.resolve(filePath);
      const pathOptions = resolveZipPathOptions(this._zip_options);
      const zipPath = joinZipPath(
        pathOptions,
        opts.prefix ?? "",
        opts.name ?? path.basename(filePath)
      );

      this._zip_pending.push({
        type: "file",
        localPath: resolvedPath,
        zipPath,
        options: opts
      });
    } else {
      const opts = (options ?? {}) as AddTarFileOptions;
      const tarPath = normalizeTarPath(opts.name ?? path.basename(filePath), opts.prefix);
      this._tar_pending.push({
        type: "file",
        localPath: path.resolve(filePath),
        tarPath,
        options: opts
      });
    }
    return this;
  }

  /**
   * Add a buffer to the archive.
   */
  addBuffer(
    data: Uint8Array,
    name: string,
    options?: F extends "tar" ? AddTarFileOptions : AddFileOptions
  ): this {
    if (this._format === "zip") {
      const opts = (options ?? {}) as AddFileOptions;
      const pathOptions = resolveZipPathOptions(this._zip_options);
      this._zip_pending.push({
        type: "buffer",
        data,
        zipPath: normalizeZipPath(name, pathOptions),
        options: opts
      });
    } else {
      const opts = (options ?? {}) as AddTarFileOptions;
      const tarPath = normalizeTarPath(name, opts.prefix);
      this._tar_pending.push({
        type: "buffer",
        data,
        tarPath,
        options: opts
      });
    }
    return this;
  }

  /**
   * Add text content to the archive.
   */
  addText(
    content: string,
    name: string,
    options?: F extends "tar" ? AddTarFileOptions : AddFileOptions
  ): this {
    return this.addBuffer(utf8Encoder.encode(content), name, options);
  }

  /**
   * Add a stream to the archive.
   */
  appendStream(
    stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
    name: string,
    options?: F extends "tar" ? AddTarFileOptions : AddFileOptions
  ): this {
    if (this._format === "zip") {
      const opts = (options ?? {}) as AddFileOptions;
      const pathOptions = resolveZipPathOptions(this._zip_options);
      this._zip_pending.push({
        type: "stream",
        stream,
        zipPath: normalizeZipPath(name, pathOptions),
        options: opts
      });
    } else {
      const opts = (options ?? {}) as AddTarFileOptions;
      const tarPath = normalizeTarPath(name, opts.prefix);
      this._tar_pending.push({
        type: "stream",
        stream: stream as AsyncIterable<Uint8Array>,
        tarPath,
        options: opts
      });
    }
    return this;
  }

  /**
   * Add a symbolic link to the archive.
   */
  symlink(name: string, target: string, mode?: number): this {
    if (this._format === "zip") {
      const pathOptions = resolveZipPathOptions(this._zip_options);
      this._zip_pending.push({
        type: "symlink",
        zipPath: normalizeZipPath(name, pathOptions),
        target,
        mode
      });
    } else {
      const tarPath = normalizeTarPath(name);
      this._tar_pending.push({
        type: "symlink",
        tarPath,
        target,
        mode
      });
    }
    return this;
  }

  /**
   * Add a directory recursively to the archive.
   */
  addDirectory(
    dirPath: string,
    options?: F extends "tar" ? AddTarDirectoryOptions : AddDirectoryOptions
  ): this {
    if (this._format === "zip") {
      this._zip_pending.push({
        type: "directory",
        localPath: path.resolve(dirPath),
        options: (options ?? {}) as AddDirectoryOptions
      });
    } else {
      this._tar_pending.push({
        type: "directory",
        localPath: path.resolve(dirPath),
        options: (options ?? {}) as AddTarDirectoryOptions
      });
    }
    return this;
  }

  /**
   * Add files matching a glob pattern to the archive.
   */
  addGlob(pattern: string, options?: F extends "tar" ? AddTarGlobOptions : AddGlobOptions): this {
    if (this._format === "zip") {
      this._zip_pending.push({
        type: "glob",
        pattern,
        options: (options ?? {}) as AddGlobOptions
      });
    } else {
      this._tar_pending.push({
        type: "glob",
        pattern,
        options: (options ?? {}) as AddTarGlobOptions
      });
    }
    return this;
  }

  // =============================================================================
  // ZIP Edit API
  // =============================================================================

  /**
   * Check if an entry exists (ZIP only).
   */
  has(entryPath: string): F extends "zip" ? boolean : never {
    assertZipFormat(this._format, "has()");

    // Check edit view first (original archive entries)
    if (this._zip_editView?.has(entryPath)) {
      return true as F extends "zip" ? boolean : never;
    }
    // Check pending entries
    const normalizedPath = normalizeZipPath(entryPath, resolveZipPathOptions(this._zip_options));
    for (let i = 0; i < this._zip_pending.length; i++) {
      const pending = this._zip_pending[i]!;
      if ("zipPath" in pending && pending.zipPath === normalizedPath) {
        return true as F extends "zip" ? boolean : never;
      }
    }
    return false as F extends "zip" ? boolean : never;
  }

  /**
   * Delete an entry (ZIP only).
   */
  delete(entryPath: string): F extends "zip" ? boolean : never {
    assertZipFormat(this._format, "delete()");

    // Check if entry exists in edit view (original archive)
    if (this._zip_editView?.has(entryPath)) {
      return this._zip_editView.delete(entryPath) as F extends "zip" ? boolean : never;
    }

    // Check if entry exists in pending entries
    const normalizedPath = normalizeZipPath(entryPath, resolveZipPathOptions(this._zip_options));
    let index = -1;
    for (let i = 0; i < this._zip_pending.length; i++) {
      const pending = this._zip_pending[i]!;
      if ("zipPath" in pending && pending.zipPath === normalizedPath) {
        index = i;
        break;
      }
    }

    if (index >= 0) {
      this._zip_pending.splice(index, 1);
      return true as F extends "zip" ? boolean : never;
    }

    return false as F extends "zip" ? boolean : never;
  }

  /**
   * Set/replace an entry (ZIP only).
   */
  set(
    entryPath: string,
    data: Uint8Array | string,
    options?: AddFileOptions
  ): F extends "zip" ? this : never {
    assertZipFormat(this._format, "set()");

    const bytes = typeof data === "string" ? utf8Encoder.encode(data) : data;
    const opts = options ?? {};

    // If entry exists in edit view, update it there
    if (this._zip_editView?.has(entryPath)) {
      this._zip_editView.set(entryPath, bytes, opts);
      return this as F extends "zip" ? this : never;
    }

    // Check if entry exists in pending entries
    const normalizedPath = normalizeZipPath(entryPath, resolveZipPathOptions(this._zip_options));
    const index = this._findZipPendingIndex(normalizedPath);

    if (index >= 0) {
      // Replace existing pending entry
      this._zip_pending[index] = {
        type: "buffer",
        data: bytes,
        zipPath: normalizedPath,
        options: opts
      };
    } else {
      // Add as new pending entry
      this._zip_pending.push({
        type: "buffer",
        data: bytes,
        zipPath: normalizedPath,
        options: opts
      });
    }

    return this as F extends "zip" ? this : never;
  }

  /**
   * Rename an entry (ZIP only).
   */
  rename(oldPath: string, newPath: string): F extends "zip" ? boolean : never {
    assertZipFormat(this._format, "rename()");

    // Try rename in edit view first
    if (this._zip_editView?.rename(oldPath, newPath)) {
      return true as F extends "zip" ? boolean : never;
    }

    // Check pending entries
    const pathOptions = resolveZipPathOptions(this._zip_options);
    const normalizedFrom = normalizeZipPath(oldPath, pathOptions);
    const normalizedTo = normalizeZipPath(newPath, pathOptions);

    if (normalizedFrom === normalizedTo) {
      return this.has(oldPath) as F extends "zip" ? boolean : never;
    }

    const index = this._findZipPendingIndex(normalizedFrom);

    if (index >= 0) {
      // Remove any existing entry with target name
      const toIndex = this._findZipPendingIndex(normalizedTo);
      if (toIndex >= 0 && toIndex !== index) {
        this._zip_pending.splice(toIndex, 1);
      }

      // Rename the entry
      const adjustedIndex = toIndex >= 0 && toIndex < index ? index - 1 : index;
      const entry = this._zip_pending[adjustedIndex]!;
      if ("zipPath" in entry) {
        entry.zipPath = normalizedTo;
      }
      return true as F extends "zip" ? boolean : never;
    }

    return false as F extends "zip" ? boolean : never;
  }

  /**
   * Set a password for encryption (ZIP only).
   */
  setPassword(password: string | Uint8Array | undefined): F extends "zip" ? this : never {
    assertZipFormat(this._format, "setPassword()");
    this._setZipState("_zipPassword", password);
    if (this._zip_parser) {
      this._zip_parser.setPassword(password);
    }
    return this as F extends "zip" ? this : never;
  }

  // =============================================================================
  // Building (Write Mode)
  // =============================================================================

  /**
   * Build the archive and return as a buffer.
   */
  async toBuffer(): Promise<Uint8Array> {
    if (this._format === "zip") {
      return this._buildZip();
    } else {
      return this._buildTar();
    }
  }

  /**
   * Build the archive and return as a buffer (sync).
   */
  toBufferSync(): Uint8Array {
    if (this._format === "zip") {
      return this._buildZipSync();
    } else {
      return this._buildTarSync();
    }
  }

  /**
   * Alias for toBuffer().
   */
  async bytes(): Promise<Uint8Array> {
    return this.toBuffer();
  }

  /**
   * Alias for toBufferSync().
   */
  bytesSync(): Uint8Array {
    return this.toBufferSync();
  }

  /**
   * Write the archive to a file.
   */
  async writeToFile(filePath: string, options?: WriteArchiveOptions): Promise<void> {
    if (this._format === "zip") {
      const { overwrite = "error" } = (options ?? {}) as WriteZipOptions;
      const targetPath = path.resolve(filePath);

      const exists = await fileExists(targetPath);
      if (!checkOverwriteStrategy(exists, targetPath, overwrite)) {
        return;
      }

      const data = await this.toBuffer();
      await ensureDir(path.dirname(targetPath));
      await writeFileBytes(targetPath, data);
    } else {
      const data = await this.toBuffer();
      await ensureDir(path.dirname(filePath));
      await writeFileBytes(filePath, data);
    }
  }

  /**
   * Write the archive to a file (sync).
   */
  writeToFileSync(filePath: string, options?: WriteArchiveOptions): void {
    if (this._format === "zip") {
      const { overwrite = "error" } = (options ?? {}) as WriteZipOptions;
      const targetPath = path.resolve(filePath);

      const exists = fileExistsSync(targetPath);
      if (!checkOverwriteStrategy(exists, targetPath, overwrite)) {
        return;
      }

      const data = this.toBufferSync();
      ensureDirSync(path.dirname(targetPath));
      writeFileBytesSync(targetPath, data);
    } else {
      const data = this.toBufferSync();
      ensureDirSync(path.dirname(filePath));
      writeFileBytesSync(filePath, data);
    }
  }

  // =============================================================================
  // Streaming (Write Mode)
  // =============================================================================

  /**
   * Generate archive as an async iterable stream.
   *
   * This is the most memory-efficient way to create archives, as it streams
   * data directly from sources to output without buffering the entire archive.
   *
   * @example
   * ```ts
   * const archive = new ArchiveFile();
   * archive.addFile("large-file.bin");
   * archive.addDirectory("./data");
   *
   * // Recommended: pipeTo() handles backpressure end-to-end.
   * await archive.pipeTo(createWriteStream("output.zip"));
   *
   * // Or stream manually — REMEMBER to honor backpressure on the sink:
   * import { once } from "node:events";
   * const writeStream = createWriteStream("output.zip");
   * for await (const chunk of archive.stream()) {
   *   if (!writeStream.write(chunk)) {
   *     await once(writeStream, "drain");
   *   }
   * }
   * writeStream.end();
   * ```
   */
  stream(options: ArchiveStreamOptions = {}): AsyncIterable<Uint8Array> {
    return this.operation(options).iterable;
  }

  /**
   * Get streaming operation with abort/progress control.
   *
   * @example
   * ```ts
   * const op = archive.operation({
   *   onProgress: (p) => console.log(`${p.entriesDone}/${p.entriesTotal}`),
   * });
   *
   * // Read chunks
   * for await (const chunk of op.iterable) {
   *   process(chunk);
   * }
   *
   * // Or abort if needed
   * op.abort();
   * ```
   */
  operation(options: ArchiveStreamOptions = {}): ArchiveStreamOperation {
    if (this._format === "zip") {
      return this._buildZipStream(options);
    } else {
      return this._buildTarStream(options);
    }
  }

  /**
   * Pipe archive stream to a sink (WritableStream or Node.js Writable).
   *
   * @example
   * ```ts
   * // Node.js Writable
   * await archive.pipeTo(createWriteStream("output.zip"));
   *
   * // Web WritableStream
   * await archive.pipeTo(writableStream);
   * ```
   */
  async pipeTo(sink: ArchiveSink, options: ArchiveStreamOptions = {}): Promise<void> {
    await pipeIterableToSink(this.stream(options), sink);
  }

  /**
   * Stream archive directly to a file.
   *
   * This is the most efficient way to write large archives to disk,
   * as it avoids buffering the entire archive in memory.
   *
   * @example
   * ```ts
   * const archive = new ArchiveFile();
   * archive.addDirectory("./huge-folder");
   * await archive.streamToFile("output.zip", {
   *   onProgress: (p) => console.log(`${p.bytesOut} bytes written`),
   * });
   * ```
   */
  async streamToFile(
    filePath: string,
    options: ArchiveStreamOptions & WriteArchiveOptions = {}
  ): Promise<void> {
    const targetPath = path.resolve(filePath);
    const { overwrite = "error" } = options;

    const exists = await fileExists(targetPath);
    if (!checkOverwriteStrategy(exists, targetPath, overwrite)) {
      return;
    }

    await ensureDir(path.dirname(targetPath));

    const writeStream = createWriteStream(targetPath);
    try {
      await this.pipeTo(writeStream, options);
    } catch (err) {
      // Clean up partial file on error
      writeStream.destroy();
      throw err;
    }
  }

  // =============================================================================
  // Reading (Read Mode)
  // =============================================================================

  /**
   * Get all entry info objects.
   */
  async getEntries(): Promise<ArchiveEntryInfo[]> {
    if (this._format === "zip") {
      if (!this._zipParser) {
        throw new ArchiveError(
          "Cannot read entries: archive not loaded. Use fromFile() or fromBuffer()."
        );
      }

      const zipEntries = this._zip_parser!.getEntries();
      const entries = new Array<ArchiveEntryInfo>(zipEntries.length);
      for (let i = 0; i < zipEntries.length; i++) {
        entries[i] = mapZipEntryToInfo(zipEntries[i]!);
      }
      return entries;
    } else {
      if (!this._tarReader) {
        throw new ArchiveError("Cannot read entries: archive is in write mode");
      }
      const entries: ArchiveEntryInfo[] = [];
      for await (const entry of (this._tarReader as TarReader).entries()) {
        const info = entry.info;
        entries.push({
          path: info.path,
          size: info.size,
          mtime: info.mtime,
          mode: info.mode,
          uid: info.uid,
          gid: info.gid,
          uname: info.uname,
          gname: info.gname,
          linkname: info.linkname,
          type: info.type,
          isDirectory: isTarDirectory(info)
        });
      }
      return entries;
    }
  }

  /**
   * Get all entry info objects (sync).
   */
  getEntriesSync(): ArchiveEntryInfo[] {
    if (this._format === "zip") {
      if (!this._zipParser) {
        throw new ArchiveError("Cannot read entries: archive not loaded.");
      }
      const zipEntries = this._zip_parser!.getEntries();
      const entries = new Array<ArchiveEntryInfo>(zipEntries.length);
      for (let i = 0; i < zipEntries.length; i++) {
        entries[i] = mapZipEntryToInfo(zipEntries[i]!);
      }
      return entries;
    } else {
      throwTarSyncNotSupported("getEntriesSync");
    }
  }

  /**
   * Get entry names (file paths).
   */
  getEntryNames(): string[] {
    if (this._format === "zip" && this._zip_parser) {
      return this._zip_parser.listFiles();
    }

    const entries = this.getEntriesSync();
    const names = new Array<string>(entries.length);
    for (let i = 0; i < entries.length; i++) {
      names[i] = entries[i]!.path;
    }
    return names;
  }

  /**
   * Get a specific entry's info.
   */
  getEntry(entryPath: string): ZipEntryInfo | null {
    assertZipFormat(this._format, "getEntry()");
    if (!this._zip_parser) {
      throw new ArchiveError("Cannot read entries: archive not loaded.");
    }

    const entry = this._zip_parser.getEntry(entryPath);
    if (!entry) {
      return null;
    }

    return mapZipEntryToInfo(entry);
  }

  /**
   * Read an entry as bytes.
   */
  async readEntry(entryPath: string, password?: string | Uint8Array): Promise<Uint8Array | null> {
    if (this._format === "zip") {
      if (!this._zipParser) {
        throw new ArchiveError("Cannot read entry: archive not loaded.");
      }
      return this._zip_parser!.extract(entryPath, password ?? this._zip_password);
    } else {
      if (!this._tarReader) {
        throw new ArchiveError("Cannot read entry: archive is in write mode");
      }
      return (this._tarReader as TarReader).bytes(entryPath);
    }
  }

  /**
   * Read an entry as bytes (sync).
   */
  readEntrySync(entryPath: string, password?: string | Uint8Array): Uint8Array | null {
    if (this._format === "zip") {
      if (!this._zipParser) {
        throw new ArchiveError("Cannot read entry: archive not loaded.");
      }
      return this._zip_parser!.extractSync(entryPath, password ?? this._zip_password);
    } else {
      throwTarSyncNotSupported("readEntrySync");
    }
  }

  /**
   * Read an entry as text.
   */
  async readAsText(entryPath: string, encoding: string = "utf-8"): Promise<string | null> {
    const data = await this.readEntry(entryPath);
    if (!data) {
      return null;
    }
    const decoder = new TextDecoder(encoding);
    return decoder.decode(data);
  }

  /**
   * Read an entry as text (sync).
   */
  readAsTextSync(entryPath: string, encoding: string = "utf-8"): string | null {
    if (this._format === "zip") {
      const data = this.readEntrySync(entryPath);
      if (!data) {
        return null;
      }
      return new TextDecoder(encoding).decode(data);
    } else {
      throwTarSyncNotSupported("readAsTextSync");
    }
  }

  /**
   * Extract the archive to a directory.
   */
  async extractTo(targetDir: string, options: ExtractToOptions = {}): Promise<void> {
    if (this._format === "zip") {
      await this._extractZip(targetDir, options);
    } else {
      await this._extractTar(targetDir, options);
    }
  }

  /**
   * Extract the archive to a directory (sync).
   */
  extractToSync(targetDir: string, options: ExtractToOptions = {}): void {
    if (this._format === "zip") {
      this._extractZipSync(targetDir, options);
    } else {
      throwTarSyncNotSupported("extractToSync");
    }
  }

  /**
   * Extract a single entry to a file (ZIP only).
   */
  async extractEntryTo(
    entryPath: string,
    targetPath: string,
    options: ExtractToOptions = {}
  ): Promise<boolean> {
    assertZipFormat(this._format, "extractEntryTo()");

    if (!this._zipParser) {
      throw new ArchiveError("Cannot extract: archive not loaded.");
    }

    const entry = this._zip_parser!.getEntry(entryPath);
    if (!entry) {
      return false;
    }

    const { overwrite = "error", preserveTimestamps = true, password } = options;
    const resolvedTarget = path.resolve(targetPath);

    if (entry.type === "directory") {
      await ensureDir(resolvedTarget);
      return true;
    }

    if (!(await shouldExtract(resolvedTarget, entry.lastModified, overwrite))) {
      return false;
    }

    await ensureDir(path.dirname(resolvedTarget));

    const data = await this._zip_parser!.extract(entryPath, password ?? this._zip_password);
    if (data) {
      await writeFileBytes(resolvedTarget, data);

      if (preserveTimestamps) {
        await setFileTime(resolvedTarget, entry.lastModified);
      }
    }

    return true;
  }

  /**
   * Synchronously extract a single entry to a file (ZIP only).
   */
  extractEntryToSync(
    entryPath: string,
    targetPath: string,
    options: ExtractToOptions = {}
  ): boolean {
    assertZipFormat(this._format, "extractEntryToSync()");

    if (!this._zipParser) {
      throw new ArchiveError("Cannot extract: archive not loaded.");
    }

    const entry = this._zip_parser!.getEntry(entryPath);
    if (!entry) {
      return false;
    }

    const { overwrite = "error", preserveTimestamps = true, password } = options;
    const resolvedTarget = path.resolve(targetPath);

    if (entry.type === "directory") {
      ensureDirSync(resolvedTarget);
      return true;
    }

    if (!shouldExtractSync(resolvedTarget, entry.lastModified, overwrite)) {
      return false;
    }

    ensureDirSync(path.dirname(resolvedTarget));

    const data = this._zip_parser!.extractSync(entryPath, password ?? this._zip_password);
    if (data) {
      writeFileBytesSync(resolvedTarget, data);

      if (preserveTimestamps) {
        setFileTimeSync(resolvedTarget, entry.lastModified);
      }
    }

    return true;
  }

  // =============================================================================
  // ZIP Utility Methods
  // =============================================================================

  /**
   * Check if the archive contains encrypted entries (ZIP only).
   */
  hasEncryptedEntries(): boolean {
    if (this._format !== "zip" || !this._zipParser) {
      return false;
    }
    return this._zip_parser!.hasEncryptedEntries();
  }

  /**
   * Get the archive comment (ZIP only).
   */
  getZipComment(): string {
    assertZipFormat(this._format, "getZipComment()");
    if (this._zipParser) {
      return this._zip_parser!.getZipComment();
    }
    return this._zip_options.comment ?? "";
  }

  /**
   * Set or update the archive comment (ZIP only).
   */
  addZipComment(comment: string): this {
    assertZipFormat(this._format, "addZipComment()");
    this._zip_options.comment = comment;
    return this;
  }

  /**
   * Get the comment for a specific entry (ZIP only).
   */
  getZipEntryComment(entryPath: string): string | null {
    assertZipFormat(this._format, "getZipEntryComment()");
    const entry = this.getEntry(entryPath);
    return entry?.comment ?? null;
  }

  /**
   * Check if there are pending modifications.
   */
  hasPendingChanges(): boolean {
    if (this._format === "zip") {
      return this._zip_pending.length > 0 || (this._zip_editView?.hasChanges() ?? false);
    } else {
      return this._tar_pending.length > 0;
    }
  }

  /**
   * Abort the current operation (ZIP only).
   */
  abort(): this {
    if (this._format === "zip" && this._zipAbortController) {
      (this._zipAbortController as AbortController).abort();
      this._setZipState("_zipAbortController", null);
    }
    return this;
  }

  /**
   * Get the number of bytes written so far (ZIP only).
   */
  pointer(): number {
    assertZipFormat(this._format, "pointer()");
    if (this._zipData) {
      return (this._zipData as Uint8Array).length;
    }
    return this._zipBytesWritten as number;
  }

  /**
   * Get the AbortSignal for the current operation (ZIP only).
   */
  getAbortSignal(): AbortSignal | undefined {
    if (this._format === "zip") {
      return (this._zipAbortController as AbortController | null)?.signal;
    }
    return undefined;
  }

  // =============================================================================
  // Private Methods - ZIP Building
  // =============================================================================

  private async _buildZip(): Promise<Uint8Array> {
    // Create abort controller for this operation
    this._setZipState("_zipAbortController", new AbortController());
    const signal = (this._zipAbortController as AbortController).signal;

    // Reset bytes counter
    this._setZipState("_zipBytesWritten", 0);

    // Check if we can return cached data
    if (this._zipData && !this.hasPendingChanges()) {
      this._setZipState("_zipAbortController", null);
      return this._zipData as Uint8Array;
    }

    // Helper to check abort status
    const checkAbort = () => {
      if (signal.aborted) {
        throw createAbortError();
      }
    };

    const globalOptions = this._zip_options;
    const globalPassword = this._zip_password;

    // Build context for entry processing
    const ctx: ZipBuildContext = {
      entries: [],
      globalOptions,
      globalPassword,
      pathOptions: resolveZipPathOptions(globalOptions),
      bytesWritten: 0,
      checkAbort,
      concurrency: globalOptions.concurrency ?? DEFAULT_IO_CONCURRENCY
    };

    // Async file system operations
    const fsOps: ZipFsOps = {
      readFile: readFileBytes,
      getStats: safeStats,
      traverseDir: traverseDirectory,
      globFiles: globFiles,
      collectStream: collectStream
    };

    // Process entries from edit view (existing archive with modifications)
    if (this._zip_editView && this._zip_parser) {
      // Process base (preserved) entries
      for (const { info } of this._zip_editView.getBaseEntries()) {
        checkAbort();
        const data = await this._zip_parser.extract(info.path, globalPassword);
        if (data) {
          ctx.entries.push(buildPreservedEntry(info, data, globalOptions, globalPassword));
          ctx.bytesWritten += data.length;
        }
      }

      // Process set (updated) entries
      for (const setEntry of this._zip_editView.getSetEntries()) {
        checkAbort();
        const data = setEntry.source as Uint8Array;
        const options = (setEntry.options as AddFileOptions) ?? {};
        ctx.entries.push(
          buildZipEntry(setEntry.name, data, options, globalOptions, globalPassword)
        );
        ctx.bytesWritten += data.length;
      }
    }

    // Process pending entries using shared logic
    for (let i = 0; i < this._zip_pending.length; i++) {
      await processZipPendingEntry(this._zip_pending[i]!, ctx, fsOps);
    }

    checkAbort();

    // Build ZIP
    const zipData = await createZip(ctx.entries, this._getCreateZipOptions());
    this._setZipState("_zipData", zipData);
    this._setZipState("_zipBytesWritten", zipData.length);

    // Clear pending changes after building
    this._setZipState("_zipPendingEntries", []);
    if (this._zip_editView && this._zip_parser) {
      // Re-initialize edit view from the new zip data (all changes applied)
      const newParser = new ZipParser(zipData, { password: globalPassword });
      this._setZipState("_zipParser", newParser);
      this._zip_editView.initFromEntries(newParser.getEntries(), (e: ZipEntryRecord) => e.path);
    }
    this._setZipState("_zipAbortController", null);

    return zipData;
  }

  private _buildZipSync(): Uint8Array {
    // Check if we can return cached data
    if (this._zipData && !this.hasPendingChanges()) {
      return this._zipData as Uint8Array;
    }

    // Check for stream entries which can't be processed synchronously
    let hasStreamEntry = false;
    for (let i = 0; i < this._zip_pending.length; i++) {
      if (this._zip_pending[i]!.type === "stream") {
        hasStreamEntry = true;
        break;
      }
    }
    if (hasStreamEntry) {
      throw new ArchiveError(
        "Stream entries cannot be processed synchronously. Use toBuffer() instead."
      );
    }

    const globalOptions = this._zip_options;
    const globalPassword = this._zip_password;

    // Build context for entry processing
    const ctx: ZipBuildContext = {
      entries: [],
      globalOptions,
      globalPassword,
      pathOptions: resolveZipPathOptions(globalOptions),
      bytesWritten: 0,
      concurrency: globalOptions.concurrency ?? DEFAULT_IO_CONCURRENCY
    };

    // Sync file system operations (no collectStream - streams not supported)
    const fsOps: ZipFsOps = {
      readFile: readFileBytesSync,
      getStats: safeStatsSync,
      traverseDir: traverseDirectorySync,
      globFiles: globFilesSync
      // No collectStream - will throw if stream entry encountered
    };

    // Process entries from edit view (existing archive with modifications)
    if (this._zip_editView && this._zip_parser) {
      // Process base (preserved) entries
      for (const { info } of this._zip_editView.getBaseEntries()) {
        const data = this._zip_parser.extractSync(info.path, globalPassword);
        if (data) {
          ctx.entries.push(buildPreservedEntry(info, data, globalOptions, globalPassword));
        }
      }

      // Process set (updated) entries
      for (const setEntry of this._zip_editView.getSetEntries()) {
        const data = setEntry.source as Uint8Array;
        const options = (setEntry.options as AddFileOptions) ?? {};
        ctx.entries.push(
          buildZipEntry(setEntry.name, data, options, globalOptions, globalPassword)
        );
      }
    }

    // Process pending entries using shared logic
    // Note: We use a sync wrapper since processZipPendingEntry is async but
    // the sync fsOps make it effectively synchronous (for await works with sync iterables)
    for (let i = 0; i < this._zip_pending.length; i++) {
      const pending = this._zip_pending[i]!;
      // Inline sync processing to avoid async/await overhead
      this._processZipPendingEntrySync(pending, ctx, fsOps);
    }

    const zipData = createZipSync(ctx.entries, this._getCreateZipOptions());
    this._setZipState("_zipData", zipData);

    // Clear pending changes after building
    this._setZipState("_zipPendingEntries", []);
    if (this._zip_editView && this._zip_parser) {
      // Re-initialize edit view from the new zip data (all changes applied)
      const newParser = new ZipParser(zipData, { password: globalPassword });
      this._setZipState("_zipParser", newParser);
      this._zip_editView.initFromEntries(newParser.getEntries(), (e: ZipEntryRecord) => e.path);
    }

    return zipData;
  }

  /**
   * Synchronous version of pending entry processing.
   * Avoids the async overhead when all operations are sync.
   */
  private _processZipPendingEntrySync(
    pending: ZipPendingEntry,
    ctx: ZipBuildContext,
    fsOps: ZipFsOps
  ): void {
    switch (pending.type) {
      case "file": {
        const data = fsOps.readFile(pending.localPath) as Uint8Array;
        const stats = fsOps.getStats(pending.localPath) as ReturnType<typeof safeStatsSync>;
        ctx.entries.push(
          buildZipEntry(
            pending.zipPath,
            data,
            pending.options,
            ctx.globalOptions,
            ctx.globalPassword,
            {
              modTime: stats?.mtime,
              mode: stats?.mode,
              atime: stats?.atime,
              ctime: stats?.ctime,
              birthTime: stats?.birthtime
            }
          )
        );
        ctx.bytesWritten += data.length;
        break;
      }

      case "buffer": {
        ctx.entries.push(
          buildZipEntry(
            pending.zipPath,
            pending.data,
            pending.options,
            ctx.globalOptions,
            ctx.globalPassword
          )
        );
        ctx.bytesWritten += pending.data.length;
        break;
      }

      case "stream": {
        throw new ArchiveError("Stream entries cannot be processed synchronously.");
      }

      case "symlink": {
        const symlinkEntry = buildSymlinkEntry(
          pending.zipPath,
          pending.target,
          pending.mode,
          ctx.globalOptions.encoding
        );
        ctx.entries.push(symlinkEntry);
        ctx.bytesWritten += symlinkEntry.data.length;
        break;
      }

      case "directory": {
        const { prefix, includeRoot = true, recursive = true, filter } = pending.options;
        const dirName = path.basename(pending.localPath);
        const basePrefix = prefix ?? (includeRoot ? dirName : "");

        for (const entry of fsOps.traverseDir(pending.localPath, {
          recursive,
          followSymlinks: pending.options.followSymlinks,
          filter: wrapFilter(filter)
        }) as Iterable<FileEntry>) {
          const zipPath = joinZipPath(ctx.pathOptions, basePrefix, entry.relativePath);

          if (entry.isDirectory) {
            ctx.entries.push(
              buildDirectoryEntry(zipPath, entry, ctx.globalOptions, pending.options)
            );
          } else {
            const data = fsOps.readFile(entry.absolutePath) as Uint8Array;
            ctx.entries.push(
              buildZipEntry(zipPath, data, pending.options, ctx.globalOptions, ctx.globalPassword, {
                modTime: entry.mtime,
                mode: entry.mode,
                atime: entry.atime,
                ctime: entry.ctime,
                birthTime: entry.birthTime
              })
            );
            ctx.bytesWritten += data.length;
          }
        }
        break;
      }

      case "glob": {
        const { cwd, prefix, ignore, dot, followSymlinks, filter } = pending.options;

        for (const entry of fsOps.globFiles(pending.pattern, {
          cwd,
          ignore,
          dot,
          followSymlinks,
          filter: wrapFilter(filter)
        }) as Iterable<FileEntry>) {
          const zipPath = joinZipPath(ctx.pathOptions, prefix ?? "", entry.relativePath);
          const data = fsOps.readFile(entry.absolutePath) as Uint8Array;
          ctx.entries.push(
            buildZipEntry(zipPath, data, pending.options, ctx.globalOptions, ctx.globalPassword, {
              modTime: entry.mtime,
              mode: entry.mode,
              atime: entry.atime,
              ctime: entry.ctime,
              birthTime: entry.birthTime
            })
          );
          ctx.bytesWritten += data.length;
        }
        break;
      }
    }
  }

  // =============================================================================
  // Private Methods - ZIP Extraction
  // =============================================================================

  private async _extractZip(targetDir: string, options: ExtractToOptions): Promise<void> {
    if (!this._zipParser) {
      throw new ArchiveError("Cannot extract: archive not loaded. Use fromFile() or fromBuffer().");
    }

    const parser = this._zip_parser!;

    const {
      overwrite = "error",
      filter,
      preserveTimestamps = true,
      preservePermissions = supportsUnixPermissions(),
      createSymlinks = true,
      password,
      signal,
      onProgress,
      onWarning
    } = options;

    const resolvedTarget = path.resolve(targetDir);
    const entries = parser.getEntries();
    const totalEntries = entries.length;
    let extractedEntries = 0;
    let bytesWritten = 0;
    const effectivePassword = password ?? this._zip_password;
    const textDecoder = new TextDecoder();

    // Deferred symlinks - process after all files/dirs to ensure targets exist
    const deferredSymlinks: Array<{
      entry: ZipEntryRecord;
      targetPath: string;
      linkTarget: string;
    }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      // Check abort signal
      if (signal?.aborted) {
        throw createAbortError();
      }

      // Apply filter (pass isDirectory for both dirs and symlinks pointing to dirs)
      if (filter && !filter(entry.path, entry.type === "directory")) {
        continue;
      }

      const targetPath = path.join(resolvedTarget, entry.path);
      assertNoPathTraversal(targetPath, resolvedTarget, entry.path);

      if (entry.type === "directory") {
        // --- Directory ---
        if (
          !(await tryFsOpWithWarning(
            () => ensureDir(targetPath),
            onWarning,
            entry.path,
            targetPath
          ))
        ) {
          continue;
        }

        // Set directory permissions
        if (preservePermissions) {
          const dirMode = getEffectiveMode(entry.mode, "directory");
          await tryFsOpWithWarning(
            () => chmod(targetPath, dirMode & 0o7777), // Strip file type bits
            onWarning,
            entry.path,
            targetPath
          );
        }
      } else if (entry.type === "symlink") {
        // --- Symlink ---
        if (!createSymlinks) {
          // Skip symlinks if disabled
          continue;
        }

        // Extract symlink target (content of the entry is the link target path)
        const data = await parser.extract(entry.path, effectivePassword);
        if (!data) {
          continue;
        }

        const linkTarget = textDecoder.decode(data);

        // Validate symlink target doesn't escape the extraction directory
        const resolvedLinkTarget = path.resolve(path.dirname(targetPath), linkTarget);
        if (
          !resolvedLinkTarget.startsWith(resolvedTarget + path.sep) &&
          resolvedLinkTarget !== resolvedTarget
        ) {
          // Symlink points outside extraction directory - emit warning and skip
          emitExtractWarning(
            onWarning,
            entry.path,
            targetPath,
            new Error(`Symlink target "${linkTarget}" points outside extraction directory`)
          );
          continue;
        }

        // Defer symlink creation to ensure target exists
        deferredSymlinks.push({ entry, targetPath, linkTarget });
      } else {
        // --- Regular File ---
        // Check overwrite strategy
        let shouldWrite: boolean;
        try {
          shouldWrite = await shouldExtract(targetPath, entry.lastModified, overwrite);
        } catch (err) {
          if (isIgnorableFsError(err)) {
            emitExtractWarning(onWarning, entry.path, targetPath, err);
            continue;
          }
          throw err;
        }

        if (!shouldWrite) {
          continue;
        }

        // Ensure parent directory exists
        if (
          !(await tryFsOpWithWarning(
            () => ensureDir(path.dirname(targetPath)),
            onWarning,
            entry.path,
            targetPath
          ))
        ) {
          continue;
        }

        // Extract file content
        const data = await parser.extract(entry.path, effectivePassword);
        if (data) {
          let writeSuccess: boolean;
          try {
            await writeFileBytes(targetPath, data);
            bytesWritten += data.length;
            writeSuccess = true;
          } catch (err) {
            if (isIgnorableFsError(err)) {
              emitExtractWarning(onWarning, entry.path, targetPath, err);
              continue;
            }
            throw err;
          }

          if (writeSuccess) {
            // Set file permissions
            if (preservePermissions) {
              const fileMode = getEffectiveMode(entry.mode, "file");
              await tryFsOpWithWarning(
                () => chmod(targetPath, fileMode & 0o7777),
                onWarning,
                entry.path,
                targetPath
              );
            }

            // Set timestamps
            if (preserveTimestamps) {
              await tryFsOpWithWarning(
                () => setFileTime(targetPath, entry.lastModified),
                onWarning,
                entry.path,
                targetPath
              );
            }
          }
        }
      }

      extractedEntries++;

      // Report progress
      if (onProgress) {
        onProgress({
          currentEntry: entry.path,
          totalEntries,
          extractedEntries,
          bytesWritten
        });
      }
    }

    // Process deferred symlinks
    for (let i = 0; i < deferredSymlinks.length; i++) {
      const deferred = deferredSymlinks[i]!;
      const { entry, targetPath, linkTarget } = deferred;
      if (signal?.aborted) {
        throw createAbortError();
      }

      // Check overwrite strategy for symlink
      let shouldWrite: boolean;
      try {
        shouldWrite = await shouldExtract(targetPath, entry.lastModified, overwrite);
      } catch (err) {
        if (isIgnorableFsError(err)) {
          emitExtractWarning(onWarning, entry.path, targetPath, err);
          continue;
        }
        throw err;
      }

      if (!shouldWrite) {
        continue;
      }

      // Ensure parent directory exists
      if (
        !(await tryFsOpWithWarning(
          () => ensureDir(path.dirname(targetPath)),
          onWarning,
          entry.path,
          targetPath
        ))
      ) {
        continue;
      }

      // Create symlink
      const symlinkCreated = await tryFsOpWithWarning(
        () => createSymlink(linkTarget, targetPath),
        onWarning,
        entry.path,
        targetPath
      );

      if (symlinkCreated) {
        extractedEntries++;

        if (onProgress) {
          onProgress({
            currentEntry: entry.path,
            totalEntries,
            extractedEntries,
            bytesWritten
          });
        }
      }
    }
  }

  private _extractZipSync(targetDir: string, options: ExtractToOptions): void {
    if (!this._zipParser) {
      throw new ArchiveError("Cannot extract: archive not loaded.");
    }

    const parser = this._zip_parser!;

    const {
      overwrite = "error",
      filter,
      preserveTimestamps = true,
      preservePermissions = supportsUnixPermissions(),
      createSymlinks = true,
      password,
      signal,
      onProgress,
      onWarning
    } = options;

    const resolvedTarget = path.resolve(targetDir);
    const entries = parser.getEntries();
    const totalEntries = entries.length;
    let extractedEntries = 0;
    let bytesWritten = 0;
    const effectivePassword = password ?? this._zip_password;
    const textDecoder = new TextDecoder();

    // Deferred symlinks - process after all files/dirs to ensure targets exist
    const deferredSymlinks: Array<{
      entry: ZipEntryRecord;
      targetPath: string;
      linkTarget: string;
    }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      // Check abort signal
      if (signal?.aborted) {
        throw createAbortError();
      }

      // Apply filter
      if (filter && !filter(entry.path, entry.type === "directory")) {
        continue;
      }

      const targetPath = path.join(resolvedTarget, entry.path);
      assertNoPathTraversal(targetPath, resolvedTarget, entry.path);

      if (entry.type === "directory") {
        // --- Directory ---
        if (
          !tryFsOpWithWarningSync(
            () => ensureDirSync(targetPath),
            onWarning,
            entry.path,
            targetPath
          )
        ) {
          continue;
        }

        // Set directory permissions
        if (preservePermissions) {
          const dirMode = getEffectiveMode(entry.mode, "directory");
          tryFsOpWithWarningSync(
            () => chmodSync(targetPath, dirMode & 0o7777),
            onWarning,
            entry.path,
            targetPath
          );
        }
      } else if (entry.type === "symlink") {
        // --- Symlink ---
        if (!createSymlinks) {
          continue;
        }

        // Extract symlink target
        const data = parser.extractSync(entry.path, effectivePassword);
        if (!data) {
          continue;
        }

        const linkTarget = textDecoder.decode(data);

        // Validate symlink target doesn't escape the extraction directory
        const resolvedLinkTarget = path.resolve(path.dirname(targetPath), linkTarget);
        if (
          !resolvedLinkTarget.startsWith(resolvedTarget + path.sep) &&
          resolvedLinkTarget !== resolvedTarget
        ) {
          emitExtractWarning(
            onWarning,
            entry.path,
            targetPath,
            new Error(`Symlink target "${linkTarget}" points outside extraction directory`)
          );
          continue;
        }

        // Defer symlink creation
        deferredSymlinks.push({ entry, targetPath, linkTarget });
      } else {
        // --- Regular File ---
        let shouldWrite: boolean;
        try {
          shouldWrite = shouldExtractSync(targetPath, entry.lastModified, overwrite);
        } catch (err) {
          if (isIgnorableFsError(err)) {
            emitExtractWarning(onWarning, entry.path, targetPath, err);
            continue;
          }
          throw err;
        }

        if (!shouldWrite) {
          continue;
        }

        if (
          !tryFsOpWithWarningSync(
            () => ensureDirSync(path.dirname(targetPath)),
            onWarning,
            entry.path,
            targetPath
          )
        ) {
          continue;
        }

        const data = parser.extractSync(entry.path, effectivePassword);
        if (data) {
          let writeSuccess: boolean;
          try {
            writeFileBytesSync(targetPath, data);
            bytesWritten += data.length;
            writeSuccess = true;
          } catch (err) {
            if (isIgnorableFsError(err)) {
              emitExtractWarning(onWarning, entry.path, targetPath, err);
              continue;
            }
            throw err;
          }

          if (writeSuccess) {
            if (preservePermissions) {
              const fileMode = getEffectiveMode(entry.mode, "file");
              tryFsOpWithWarningSync(
                () => chmodSync(targetPath, fileMode & 0o7777),
                onWarning,
                entry.path,
                targetPath
              );
            }

            if (preserveTimestamps) {
              tryFsOpWithWarningSync(
                () => setFileTimeSync(targetPath, entry.lastModified),
                onWarning,
                entry.path,
                targetPath
              );
            }
          }
        }
      }

      extractedEntries++;

      if (onProgress) {
        onProgress({
          currentEntry: entry.path,
          totalEntries,
          extractedEntries,
          bytesWritten
        });
      }
    }

    // Process deferred symlinks
    for (let i = 0; i < deferredSymlinks.length; i++) {
      const deferred = deferredSymlinks[i]!;
      const { entry, targetPath, linkTarget } = deferred;
      if (signal?.aborted) {
        throw createAbortError();
      }

      let shouldWrite: boolean;
      try {
        shouldWrite = shouldExtractSync(targetPath, entry.lastModified, overwrite);
      } catch (err) {
        if (isIgnorableFsError(err)) {
          emitExtractWarning(onWarning, entry.path, targetPath, err);
          continue;
        }
        throw err;
      }

      if (!shouldWrite) {
        continue;
      }

      if (
        !tryFsOpWithWarningSync(
          () => ensureDirSync(path.dirname(targetPath)),
          onWarning,
          entry.path,
          targetPath
        )
      ) {
        continue;
      }

      const symlinkCreated = tryFsOpWithWarningSync(
        () => createSymlinkSync(linkTarget, targetPath),
        onWarning,
        entry.path,
        targetPath
      );

      if (symlinkCreated) {
        extractedEntries++;

        if (onProgress) {
          onProgress({
            currentEntry: entry.path,
            totalEntries,
            extractedEntries,
            bytesWritten
          });
        }
      }
    }
  }

  // =============================================================================
  // Private Methods - TAR Building
  // =============================================================================

  private async _buildTar(): Promise<Uint8Array> {
    const archive = this._tar_archive;
    const pending = this._tar_pending;
    const opts = this._tar_options;

    // Process all pending entries
    for (let i = 0; i < pending.length; i++) {
      await this._processTarEntry(archive, pending[i]!);
    }

    // Build and optionally compress
    let data = await archive.bytes();

    if (opts?.gzip) {
      data = gzipSync(data, { level: opts.gzipLevel });
    }

    return data;
  }

  private _buildTarSync(): Uint8Array {
    const archive = this._tar_archive;
    const pending = this._tar_pending;
    const opts = this._tar_options;

    // Process all pending entries (sync)
    for (let i = 0; i < pending.length; i++) {
      this._processTarEntrySync(archive, pending[i]!);
    }

    // Build and optionally compress
    let data = archive.bytesSync();

    if (opts?.gzip) {
      data = gzipSync(data, { level: opts.gzipLevel });
    }

    return data;
  }

  private async _processTarEntry(archive: TarArchive, entry: TarPendingEntry): Promise<void> {
    switch (entry.type) {
      case "file": {
        const data = await readFileBytes(entry.localPath);
        const stats = await safeStats(entry.localPath);
        archive.add(entry.tarPath, data, buildTarAddOptions(entry.options, stats));
        break;
      }

      case "buffer": {
        archive.add(entry.tarPath, entry.data, buildTarAddOptions(entry.options, null));
        break;
      }

      case "stream": {
        const data = await collectStream(entry.stream);
        archive.add(entry.tarPath, data, buildTarAddOptions(entry.options, null));
        break;
      }

      case "symlink": {
        archive.add(entry.tarPath, "", buildTarSymlinkOptions(entry.target, entry.mode));
        break;
      }

      case "directory": {
        const { filter, transform } = entry.options;
        const tarConcurrency = this._tar_options?.concurrency ?? DEFAULT_IO_CONCURRENCY;
        const fileIterable = traverseDirectory(entry.localPath, {
          recursive: entry.options.recursive ?? true,
          followSymlinks: entry.options.followSymlinks,
          // Only use filter if no transform is provided (transform supersedes filter)
          filter: transform ? undefined : wrapFilter(filter)
        });

        await processInOrderWithConcurrency<FileEntry>(
          fileIterable,
          tarConcurrency,
          async (file: FileEntry) => {
            // Apply transform function if provided
            const transformed = applyTransform(file, entry.options.prefix, transform);
            if (transformed === null) {
              // Entry was filtered out by transform returning false
              return () => {};
            }

            // Use transformed name and prefix
            const effectivePrefix = transformed.prefix ?? entry.options.prefix;
            const tarPath = normalizeTarPath(transformed.name, effectivePrefix);

            if (file.isDirectory) {
              return () => {
                archive.add(tarPath + "/", "", { mode: TAR_DIR_MODE });
              };
            }

            const data = await readFileBytes(file.absolutePath);
            const mergedOptions = transform
              ? mergeToTarOptions(transformed, entry.options)
              : entry.options;

            return () => {
              // Note: TAR only supports mode and mtime (no atime/ctime/birthTime)
              archive.add(
                tarPath,
                data,
                buildTarAddOptions(mergedOptions, {
                  mtime: transformed.mtime,
                  mode: transformed.mode ?? file.mode
                })
              );
            };
          }
        );
        break;
      }

      case "glob": {
        const cwd = entry.options.cwd ?? process.cwd();
        const { filter, transform } = entry.options;
        const tarConcurrency = this._tar_options?.concurrency ?? DEFAULT_IO_CONCURRENCY;
        const fileIterable = globFiles(entry.pattern, {
          cwd,
          dot: entry.options.dot,
          followSymlinks: entry.options.followSymlinks,
          ignore: entry.options.ignore,
          // Only use filter if no transform is provided (transform supersedes filter)
          filter: transform ? undefined : wrapFilter(filter)
        });

        await processInOrderWithConcurrency<FileEntry>(
          fileIterable,
          tarConcurrency,
          async (file: FileEntry) => {
            // Apply transform function if provided
            const transformed = applyTransform(file, entry.options.prefix, transform);
            if (transformed === null) {
              // Entry was filtered out by transform returning false
              return () => {};
            }

            // Use transformed name and prefix
            const effectivePrefix = transformed.prefix ?? entry.options.prefix;
            const tarPath = normalizeTarPath(transformed.name, effectivePrefix);

            if (file.isDirectory) {
              return () => {
                archive.add(tarPath + "/", "", { mode: TAR_DIR_MODE });
              };
            }

            const data = await readFileBytes(file.absolutePath);
            const mergedOptions = transform
              ? mergeToTarOptions(transformed, entry.options)
              : entry.options;

            return () => {
              // Note: TAR only supports mode and mtime (no atime/ctime/birthTime)
              archive.add(
                tarPath,
                data,
                buildTarAddOptions(mergedOptions, {
                  mtime: transformed.mtime,
                  mode: transformed.mode ?? file.mode
                })
              );
            };
          }
        );
        break;
      }
    }
  }

  private _processTarEntrySync(archive: TarArchive, entry: TarPendingEntry): void {
    switch (entry.type) {
      case "file": {
        const data = readFileBytesSync(entry.localPath);
        const stats = safeStatsSync(entry.localPath);
        archive.add(entry.tarPath, data, buildTarAddOptions(entry.options, stats));
        break;
      }

      case "buffer": {
        archive.add(entry.tarPath, entry.data, buildTarAddOptions(entry.options, null));
        break;
      }

      case "stream": {
        throw new ArchiveError("Stream entries cannot be processed synchronously");
      }

      case "symlink": {
        archive.add(entry.tarPath, "", buildTarSymlinkOptions(entry.target, entry.mode));
        break;
      }

      case "directory": {
        const { filter, transform } = entry.options;
        for (const file of traverseDirectorySync(entry.localPath, {
          recursive: entry.options.recursive ?? true,
          followSymlinks: entry.options.followSymlinks,
          // Only use filter if no transform is provided (transform supersedes filter)
          filter: transform ? undefined : wrapFilter(filter)
        })) {
          this._addTarFileEntrySync(archive, file, entry.options, entry.options.prefix, transform);
        }
        break;
      }

      case "glob": {
        const cwd = entry.options.cwd ?? process.cwd();
        const { filter, transform } = entry.options;
        for (const file of globFilesSync(entry.pattern, {
          cwd,
          dot: entry.options.dot,
          followSymlinks: entry.options.followSymlinks,
          ignore: entry.options.ignore,
          // Only use filter if no transform is provided (transform supersedes filter)
          filter: transform ? undefined : wrapFilter(filter)
        })) {
          this._addTarFileEntrySync(archive, file, entry.options, entry.options.prefix, transform);
        }
        break;
      }
    }
  }

  /**
   * Add a file entry from directory/glob traversal to the TAR archive (sync version).
   */
  private _addTarFileEntrySync(
    archive: TarArchive,
    file: FileEntry,
    options: AddTarDirectoryOptions | AddTarGlobOptions,
    prefix: string | undefined,
    transform: TransformFunction | undefined
  ): void {
    // Apply transform function if provided
    const transformed = applyTransform(file, prefix, transform);
    if (transformed === null) {
      // Entry was filtered out by transform returning false
      return;
    }

    // Use transformed name and prefix
    const effectivePrefix = transformed.prefix ?? prefix;
    const tarPath = normalizeTarPath(transformed.name, effectivePrefix);

    if (file.isDirectory) {
      archive.add(tarPath + "/", "", { mode: TAR_DIR_MODE });
    } else {
      const data = readFileBytesSync(file.absolutePath);
      const mergedOptions = transform ? mergeToTarOptions(transformed, options) : options;

      // Note: TAR only supports mode and mtime (no atime/ctime/birthTime)
      archive.add(
        tarPath,
        data,
        buildTarAddOptions(mergedOptions, {
          mtime: transformed.mtime,
          mode: transformed.mode ?? file.mode
        })
      );
    }
  }

  // =============================================================================
  // Private Methods - Streaming Build
  // =============================================================================

  /**
   * Build ZIP archive as a stream using the true streaming ZipArchive API.
   */
  private _buildZipStream(options: ArchiveStreamOptions): ArchiveStreamOperation {
    const zipArchive = new ZipArchive({
      level: this._zip_options.level,
      timestamps: this._zip_options.timestamps,
      comment: this._zip_options.comment,
      zip64: this._zip_options.zip64,
      modTime: this._zip_options.modTime,
      reproducible: this._zip_options.reproducible,
      smartStore: this._zip_options.smartStore,
      encoding: this._zip_options.encoding,
      signal: options.signal
    });

    const pathOptions = resolveZipPathOptions(this._zip_options);
    const globalOptions = this._zip_options;

    // Add entries from edit view if present (existing archive modifications)
    // Note: For streaming, edit view entries need special handling
    // We'll add them as buffer entries

    // Process pending entries and add them to ZipArchive with streaming sources
    for (let i = 0; i < this._zip_pending.length; i++) {
      const pending = this._zip_pending[i]!;
      switch (pending.type) {
        case "file": {
          // Use createReadStream for true streaming input
          const zipPath = pending.zipPath;
          const fileStream = createReadStream(pending.localPath);
          zipArchive.add(zipPath, fileStream, {
            level: pending.options.level ?? globalOptions.level,
            modTime: pending.options.modTime,
            comment: pending.options.comment,
            encoding: pending.options.encoding ?? globalOptions.encoding
          });
          break;
        }

        case "buffer": {
          zipArchive.add(pending.zipPath, pending.data, {
            level: pending.options.level ?? globalOptions.level,
            modTime: pending.options.modTime,
            comment: pending.options.comment,
            encoding: pending.options.encoding ?? globalOptions.encoding
          });
          break;
        }

        case "stream": {
          zipArchive.add(pending.zipPath, toAsyncIterable(pending.stream), {
            level: pending.options.level ?? globalOptions.level,
            modTime: pending.options.modTime,
            comment: pending.options.comment,
            encoding: pending.options.encoding ?? globalOptions.encoding
          });
          break;
        }

        case "symlink": {
          zipArchive.addSymlink(pending.zipPath, pending.target, {
            mode: pending.mode
          });
          break;
        }

        case "directory": {
          const { prefix, includeRoot = true, recursive = true, filter } = pending.options;
          const dirName = path.basename(pending.localPath);
          const basePrefix = prefix ?? (includeRoot ? dirName : "");

          // For directories, we need to traverse and add each file with streaming
          // This is done synchronously for the traversal but streaming for file content
          for (const entry of traverseDirectorySync(pending.localPath, {
            recursive,
            followSymlinks: pending.options.followSymlinks,
            filter: wrapFilter(filter)
          })) {
            const zipPath = joinZipPath(pathOptions, basePrefix, entry.relativePath);

            if (entry.isDirectory) {
              zipArchive.addDirectory(zipPath, {
                modTime: entry.mtime
              });
            } else {
              const fileStream = createReadStream(entry.absolutePath);
              zipArchive.add(zipPath, fileStream, {
                level: pending.options.level ?? globalOptions.level,
                modTime: entry.mtime,
                encoding: pending.options.encoding ?? globalOptions.encoding
              });
            }
          }
          break;
        }

        case "glob": {
          const { cwd, prefix, ignore, dot, followSymlinks, filter } = pending.options;

          for (const entry of globFilesSync(pending.pattern, {
            cwd,
            ignore,
            dot,
            followSymlinks,
            filter: wrapFilter(filter)
          })) {
            const zipPath = joinZipPath(pathOptions, prefix ?? "", entry.relativePath);

            if (entry.isDirectory) {
              zipArchive.addDirectory(zipPath, {
                modTime: entry.mtime
              });
            } else {
              const fileStream = createReadStream(entry.absolutePath);
              zipArchive.add(zipPath, fileStream, {
                level: pending.options.level ?? globalOptions.level,
                modTime: entry.mtime,
                encoding: pending.options.encoding ?? globalOptions.encoding
              });
            }
          }
          break;
        }
      }
    }

    // Get the operation from ZipArchive
    const zipOp = zipArchive.operation({
      signal: options.signal,
      onProgress: options.onProgress,
      progressIntervalMs: options.progressIntervalMs
    });

    return wrapStreamOperation(zipOp);
  }

  /**
   * Build TAR archive as a stream using the true streaming TarArchive API.
   */
  private _buildTarStream(options: ArchiveStreamOptions): ArchiveStreamOperation {
    const tarArchive = new TarArchive({
      modTime: this._tar_options?.modTime,
      signal: options.signal
    });

    // Process pending entries and add them to TarArchive with streaming sources
    for (let i = 0; i < this._tar_pending.length; i++) {
      const pending = this._tar_pending[i]!;
      switch (pending.type) {
        case "file": {
          // Use createReadStream for true streaming input
          const fileStream = createReadStream(pending.localPath);
          tarArchive.add(pending.tarPath, fileStream, buildTarAddOptions(pending.options, null));
          break;
        }

        case "buffer": {
          tarArchive.add(pending.tarPath, pending.data, buildTarAddOptions(pending.options, null));
          break;
        }

        case "stream": {
          tarArchive.add(
            pending.tarPath,
            toAsyncIterable(pending.stream),
            buildTarAddOptions(pending.options, null)
          );
          break;
        }

        case "symlink": {
          tarArchive.add(pending.tarPath, "", buildTarSymlinkOptions(pending.target, pending.mode));
          break;
        }

        case "directory": {
          const filter = wrapFilter(pending.options.filter);
          for (const file of traverseDirectorySync(pending.localPath, {
            recursive: pending.options.recursive ?? true,
            followSymlinks: pending.options.followSymlinks,
            filter
          })) {
            const tarPath = normalizeTarPath(file.relativePath, pending.options.prefix);

            if (file.isDirectory) {
              tarArchive.add(tarPath + "/", "", { mode: TAR_DIR_MODE });
            } else {
              const fileStream = createReadStream(file.absolutePath);
              tarArchive.add(tarPath, fileStream, buildTarAddOptions(pending.options, file));
            }
          }
          break;
        }

        case "glob": {
          const cwd = pending.options.cwd ?? process.cwd();
          const filter = wrapFilter(pending.options.filter);

          for (const file of globFilesSync(pending.pattern, {
            cwd,
            dot: pending.options.dot,
            followSymlinks: pending.options.followSymlinks,
            ignore: pending.options.ignore,
            filter
          })) {
            const tarPath = normalizeTarPath(file.relativePath, pending.options.prefix);

            if (file.isDirectory) {
              tarArchive.add(tarPath + "/", "", { mode: TAR_DIR_MODE });
            } else {
              const fileStream = createReadStream(file.absolutePath);
              tarArchive.add(tarPath, fileStream, buildTarAddOptions(pending.options, file));
            }
          }
          break;
        }
      }
    }

    // Get the operation from TarArchive
    const tarOp = tarArchive.operation({
      signal: options.signal,
      onProgress: options.onProgress,
      progressIntervalMs: options.progressIntervalMs
    });

    // Wrap with gzip if needed
    const opts = this._tar_options;
    let gzippedIterable: AsyncIterable<Uint8Array> | undefined;

    if (opts?.gzip) {
      // Create a gzip-wrapped async iterable
      const tarIterable = tarOp.iterable;
      const gzLevel = opts.gzipLevel;
      gzippedIterable = (async function* () {
        const gzipStream = createGzipStream({ level: gzLevel });
        const chunks: Uint8Array[] = [];
        let chunkHead = 0;

        const clearConsumedChunks = (): void => {
          if (chunkHead > 0) {
            chunks.length = 0;
            chunkHead = 0;
          }
        };

        function* drainChunks(): Iterable<Uint8Array> {
          while (chunkHead < chunks.length) {
            yield chunks[chunkHead++]!;
          }
          clearConsumedChunks();
        }

        // Eagerly attach an error listener so a mid-stream gzip failure is
        // captured and surfaced (instead of becoming an uncaught exception
        // when the listener-less Transform emits 'error' during our drain
        // await below). Stored in a closure variable so the drain await can
        // race against it.
        let gzipError: Error | null = null;
        const onGzipError = (err: Error) => {
          if (!gzipError) {
            gzipError = err;
          }
        };
        gzipStream.on("error", onGzipError);

        // Collect gzip output
        gzipStream.on("data", (chunk: Uint8Array) => {
          chunks.push(chunk);
        });

        try {
          // Pipe tar chunks through gzip. Honor `gzipStream.write()`'s
          // backpressure signal so the gzip Transform's internal buffer
          // can't grow unbounded if tar produces faster than gzip deflates.
          for await (const tarChunk of tarIterable) {
            if (gzipError) {
              // gzipError is captured as an Error (the closure annotation
              // says `Error | null`); rethrow rather than wrap to preserve
              // the original stack and message.
              // oxlint-disable-next-line no-throw-literal
              throw gzipError;
            }
            if (!gzipStream.write(tarChunk)) {
              // Race drain vs error so a mid-stream gzip failure rejects
              // promptly instead of leaving us parked on a 'drain' that
              // will never fire.
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  gzipStream.off("drain", onDrain);
                  gzipStream.off("error", onError);
                };
                const onDrain = () => {
                  cleanup();
                  resolve();
                };
                const onError = (err: Error) => {
                  cleanup();
                  reject(err);
                };
                gzipStream.once("drain", onDrain);
                gzipStream.once("error", onError);
              });
            }
            // Yield any available gzip output
            for (const chunk of drainChunks()) {
              yield chunk;
            }
          }

          // Finalize gzip stream — re-use the existing onGzipError listener
          // for the end() callback path, but wrap it as a Promise that
          // rejects on either error or accepts on end.
          await new Promise<void>((resolve, reject) => {
            if (gzipError) {
              reject(gzipError);
              return;
            }
            const onEndError = (err: Error) => {
              gzipStream.off("error", onEndError);
              reject(err);
            };
            gzipStream.once("error", onEndError);
            gzipStream.end(() => {
              gzipStream.off("error", onEndError);
              resolve();
            });
          });
        } finally {
          gzipStream.off("error", onGzipError);
        }

        // Yield remaining chunks
        for (const chunk of drainChunks()) {
          yield chunk;
        }
      })();
    }

    return wrapStreamOperation(tarOp, gzippedIterable);
  }

  // =============================================================================
  // Private Methods - TAR Extraction
  // =============================================================================

  private async _extractTar(targetDir: string, options: ExtractToOptions): Promise<void> {
    if (!this._tarReader) {
      throw new ArchiveError("Cannot extract: archive is in write mode");
    }

    const reader = this._tarReader as TarReader;
    const resolvedTargetDir = path.resolve(targetDir);
    const overwrite = options.overwrite ?? "overwrite";
    const filter = options.filter;
    const preserveTimestamps = options.preserveTimestamps ?? true;
    const signal = options.signal;
    const onProgress = options.onProgress;
    const onWarning = options.onWarning;

    // TAR is streamed; totalEntries unknown until fully consumed
    let extractedEntries = 0;
    let bytesWritten = 0;

    await ensureDir(resolvedTargetDir);

    for await (const entry of reader.entries()) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const entryPath = entry.path;
      const info = entry.info;
      const targetPath = path.resolve(resolvedTargetDir, entryPath);

      // Security: check for path traversal
      assertNoPathTraversal(targetPath, resolvedTargetDir, entryPath);

      if (filter && !filter(entryPath, isTarDirectory(info))) {
        continue;
      }

      if (isTarDirectory(info)) {
        if (
          !(await tryFsOpWithWarning(() => ensureDir(targetPath), onWarning, entryPath, targetPath))
        ) {
          continue;
        }
      } else {
        // Check overwrite strategy
        let shouldWrite: boolean;
        try {
          shouldWrite = await shouldExtract(targetPath, info.mtime, overwrite);
        } catch (err) {
          if (isIgnorableFsError(err)) {
            emitExtractWarning(onWarning, entryPath, targetPath, err);
            continue;
          }
          throw err;
        }

        if (shouldWrite) {
          let writeSuccess: boolean;
          try {
            await ensureDir(path.dirname(targetPath));
            const data = await entry.bytes();
            await writeFileBytes(targetPath, data);
            bytesWritten += data.length;
            writeSuccess = true;
          } catch (err) {
            if (isIgnorableFsError(err)) {
              emitExtractWarning(onWarning, entryPath, targetPath, err);
              continue;
            }
            throw err;
          }

          if (writeSuccess && preserveTimestamps) {
            // Best effort timestamp; ignore ignorable errors
            await tryFsOpWithWarning(
              () => setFileTime(targetPath, info.mtime),
              onWarning,
              entryPath,
              targetPath
            );
          }
        }
      }

      extractedEntries++;
      onProgress?.({
        currentEntry: entryPath,
        totalEntries: 0, // TAR: unknown until fully consumed
        extractedEntries,
        bytesWritten
      });
    }
  }
}
