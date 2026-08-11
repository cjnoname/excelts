import {
  DEFAULT_ZIP_LEVEL,
  DEFAULT_ZIP_TIMESTAMPS,
  REPRODUCIBLE_ZIP_MOD_TIME
} from "@archive/core/defaults";
import { throwIfAborted, toError, ArchiveError } from "@archive/core/errors";
import type { ZipStringCodec, ZipStringEncoding } from "@archive/core/text";
import { encodeZipStringWithCodec, resolveZipStringCodec } from "@archive/core/text";
import type { ArchiveSink } from "@archive/io/archive-sink";
import { collect, pipeIterableToSink } from "@archive/io/archive-sink";
import type { ArchiveSource } from "@archive/io/archive-source";
import {
  toAsyncIterable,
  collectUint8ArrayStream,
  toUint8ArraySync,
  isSyncArchiveSource,
  isInMemoryArchiveSource,
  resolveArchiveSourceToBuffer
} from "@archive/io/archive-source";
import type { RandomAccessReader, HttpRangeReaderOptions } from "@archive/io/random-access";
import { createBufferReader, HttpRangeReader } from "@archive/io/random-access";
import { RemoteZipReader } from "@archive/unzip/remote-zip-reader";
import type { ZipEntryOptions } from "@archive/zip";
import type { ZipTimestampMode } from "@archive/zip-spec/timestamps";
import { dateToZipDos } from "@archive/zip-spec/timestamps";
import type { ZipEntryRecord } from "@archive/zip-spec/zip-entry-info";
import type { ZipPathOptions } from "@archive/zip-spec/zip-path";
import type { Zip64Mode } from "@archive/zip-spec/zip-records";
import { FLAG_ENCRYPTED } from "@archive/zip-spec/zip-records";
import type { ZipOperation, ZipProgress, ZipStreamOptions } from "@archive/zip/progress";
import { ZipDeflateFile, ZipRawFile } from "@archive/zip/stream";
import type { ZipRawEntry, ZipEntry } from "@archive/zip/zip-bytes";
import { createZip, createZipSync } from "@archive/zip/zip-bytes";
import type { ZipEditPlan } from "@archive/zip/zip-edit-plan";
import type { SetViewEntry } from "@archive/zip/zip-edit-view";
import { ZipEditView } from "@archive/zip/zip-edit-view";
import { buildZipDeflateFileOptions } from "@archive/zip/zip-entry-options";
import { createZipOperation } from "@archive/zip/zip-output-pipeline";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Warning issued when an entry cannot be preserved and will be skipped.
 */
export interface ZipEditWarning {
  /** The entry name that triggered the warning */
  entry: string;
  /** Warning code for programmatic handling */
  code: "raw_unavailable" | "encryption_unsupported" | "unknown";
  /** Human-readable description */
  message: string;
}

/**
 * Options for opening and editing a ZIP archive.
 */
export interface ZipEditOptions {
  // --- Read options ---

  /** Whether to decode entry names/comments from UTF-8. Default: true */
  decodeStrings?: boolean;

  /** Optional string encoding for legacy (non-UTF8) names/comments. */
  encoding?: ZipStringEncoding;

  /** Password for decrypting encrypted entries (only needed for extraction, not passthrough). */
  password?: string | Uint8Array;

  /**
   * How to handle passthrough of unchanged entries.
   *
   * - `"strict"` (default): require raw passthrough data to be available; otherwise throw.
   * - `"best-effort"`: if raw passthrough data is unavailable, fall back to extracting and
   *   re-adding the entry (may increase CPU/memory usage). If extraction also fails, the entry
   *   is skipped and a warning is emitted (if `onWarning` is set).
   */
  preserve?: "strict" | "best-effort";

  // --- Write defaults ---

  /** Default compression level (0=store, 1-9=deflate). Default: 6 */
  level?: number;

  /** Timestamp mode for new/updated entries. Default: "extended" (or "dos" if reproducible) */
  timestamps?: ZipTimestampMode;

  /** Archive-level comment */
  comment?: string;

  /**
   * Path normalization mode for entry names.
   * - `false` (default): no normalization, names are used as-is
   * - `{ mode: "safe" }`: normalize and reject unsafe paths (recommended)
   * - `{ mode: "posix" }`: normalize but allow any path
   * - `{ mode: "legacy" }`: minimal normalization (backslash → slash)
   */
  path?: false | ZipPathOptions;

  /** Default modification time for new entries. */
  modTime?: Date;

  /**
   * If true, use reproducible defaults:
   * - `modTime` = 1980-01-01 00:00:00
   * - `timestamps` = "dos"
   */
  reproducible?: boolean;

  /** If true (default), auto-store incompressible data instead of deflating. */
  smartStore?: boolean;

  /** ZIP64 mode: "auto" (default), true (force), or false (disable). */
  zip64?: Zip64Mode;

  // --- Streaming/progress options ---

  /** AbortSignal for cancellation support */
  signal?: AbortSignal;

  /** Progress callback */
  onProgress?: (p: ZipProgress) => void;

  /** Minimum interval between progress updates (ms) */
  progressIntervalMs?: number;

  /**
   * Callback for warnings (e.g., entries that cannot be preserved).
   * If not provided, warnings are silently ignored.
   */
  onWarning?: (warning: ZipEditWarning) => void;
}

export interface ZipEditUrlOptions extends ZipEditOptions, HttpRangeReaderOptions {}

/**
 * Internal representation of a preserved raw entry.
 */
interface PreservedEntry {
  outName: string;
  info: ZipEntryRecord;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isRandomAccessReader(value: unknown): value is RandomAccessReader {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<RandomAccessReader>).size === "number" &&
    typeof (value as Partial<RandomAccessReader>).read === "function"
  );
}

function getPreservedBaseFlags(info: ZipEntryRecord): number {
  // Preserve only bits that must match the raw payload.
  // Writer-controlled bits (e.g. UTF-8, data descriptor) are intentionally not preserved.
  return info.isEncrypted ? FLAG_ENCRYPTED : 0;
}

function buildPreservedRawEntry(
  outName: string,
  info: ZipEntryRecord,
  compressedData: Uint8Array,
  encoding?: ZipStringEncoding
): ZipRawEntry {
  const flags = getPreservedBaseFlags(info);
  return {
    name: outName,
    compressedData,
    crc32: info.crc32,
    uncompressedSize: info.uncompressedSize,
    compressionMethod: info.compressionMethod,
    modTime: info.lastModified,
    comment: info.comment,
    encoding,
    extraField: info.extraField,
    flags: flags || undefined,
    externalAttributes: info.externalAttributes,
    versionMadeBy: info.versionMadeBy
  };
}

/**
 * High-level editor for an existing ZIP archive.
 *
 * ## Features
 * - **Cross-platform**: Works in both Node.js and browsers (in-memory)
 * - **Filesystem-like API**: `set()`, `delete()`, `rename()`, `has()`
 * - **Efficient passthrough**: Unchanged entries preserve raw compressed bytes (no re-compression)
 * - **Dual output**: Both streaming (`stream()`) and non-streaming (`bytes()`) output
 * - **Progress & cancellation**: Full `AbortSignal` and progress callback support
 *
 * ## Usage
 * ```ts
 * const editor = await editZip(existingZipBytes);
 * editor.delete("old-file.txt");
 * editor.set("new-file.txt", "hello world");
 * editor.rename("foo.txt", "bar.txt");
 * const output = await editor.bytes();
 * ```
 *
 * ## Path Normalization
 * By default, entry names are used as-is. Use the `path` option to enable normalization:
 * - `{ mode: "safe" }` — Recommended. Normalizes and rejects unsafe paths (absolute, `..` traversal).
 * - `{ mode: "posix" }` — Normalizes but allows any path.
 * - `{ mode: "legacy" }` — Minimal normalization (backslash → slash).
 *
 * ## Rename Semantics
 * `rename(from, to)` will **overwrite** `to` if it already exists (like `mv -f`).
 */
export class ZipEditor {
  private readonly _remote: RemoteZipReader;
  private readonly _reader: RandomAccessReader;
  private readonly _onWarning?: (warning: ZipEditWarning) => void;

  /** Original entries for quick lookup (never mutated). */
  private readonly _baseEntries: Map<string, ZipEntryRecord>;

  /** Final output view managed by ZipEditView. */
  private readonly _view: ZipEditView<ZipEntryRecord>;

  private readonly _options: {
    level: number;
    timestamps: ZipTimestampMode;
    comment?: string;
    modTime: Date;
    smartStore: boolean;
    zip64: Zip64Mode;
    path: false | ZipPathOptions;
    encoding?: ZipStringEncoding;
    preserve: "strict" | "best-effort";
  };
  private readonly _streamDefaults: {
    signal?: AbortSignal;
    onProgress?: (p: ZipProgress) => void;
    progressIntervalMs?: number;
  };
  private readonly _stringCodec: ZipStringCodec;

  private constructor(
    input: { reader: RandomAccessReader; remote: RemoteZipReader },
    options: ZipEditOptions
  ) {
    this._reader = input.reader;
    this._remote = input.remote;

    this._onWarning = options.onWarning;

    const originalComment = this._remote.getZipComment();

    const reproducible = options.reproducible ?? false;
    const defaultModTime = reproducible ? REPRODUCIBLE_ZIP_MOD_TIME : new Date();

    this._options = {
      level: options.level ?? DEFAULT_ZIP_LEVEL,
      timestamps: options.timestamps ?? (reproducible ? "dos" : DEFAULT_ZIP_TIMESTAMPS),
      comment: options.comment ?? (originalComment || undefined),
      modTime: options.modTime ?? defaultModTime,
      smartStore: options.smartStore ?? true,
      zip64: options.zip64 ?? "auto",
      path: options.path ?? false,
      encoding: options.encoding,
      preserve: options.preserve ?? "strict"
    };

    this._stringCodec = resolveZipStringCodec(options.encoding);
    this._streamDefaults = {
      signal: options.signal,
      onProgress: options.onProgress,
      progressIntervalMs: options.progressIntervalMs
    };

    this._baseEntries = new Map();
    this._view = new ZipEditView({ path: this._options.path });

    const entries = this._remote.getEntries();
    for (const info of entries) {
      this._baseEntries.set(info.path, info);
    }
    this._view.initFromEntries(entries, e => e.path);
  }

  /**
   * Open an existing ZIP archive for editing.
   *
   * @param source - The ZIP data (Uint8Array, ArrayBuffer, Blob, string, or async iterable)
   * @param options - Edit options
   * @returns A new `ZipEditor` instance
   *
   * @example
   * ```ts
   * // From Uint8Array
   * const editor = await ZipEditor.open(zipBytes);
   *
   * // From fetch response
   * const response = await fetch("/archive.zip");
   * const editor = await ZipEditor.open(response.body!);
   *
   * // With options
   * const editor = await ZipEditor.open(zipBytes, {
   *   path: { mode: "safe" },
   *   onWarning: (w) => console.warn(w.message)
   * });
   * ```
   */
  static async open(
    source: ArchiveSource | RandomAccessReader,
    options: ZipEditOptions = {}
  ): Promise<ZipEditor> {
    if (isRandomAccessReader(source)) {
      return ZipEditor.openReader(source, options);
    }

    // Normalize any ArchiveSource into an in-memory buffer, then use RemoteZipReader
    // (via BufferReader) for a single unified read path.
    const bytes = await resolveArchiveSourceToBuffer(source, { signal: options.signal });

    return ZipEditor.openReader(createBufferReader(bytes), options);
  }

  static async openReader(
    reader: RandomAccessReader,
    options: ZipEditOptions = {}
  ): Promise<ZipEditor> {
    const remote = await RemoteZipReader.fromReader(reader, {
      decodeStrings: options.decodeStrings,
      password: options.password,
      signal: options.signal,
      encoding: options.encoding
    });
    return new ZipEditor({ reader, remote }, options);
  }

  /**
   * Open a remote ZIP archive for editing using HTTP Range requests.
   */
  static async openUrl(url: string, options: ZipEditUrlOptions = {}): Promise<ZipEditor> {
    const reader = await HttpRangeReader.open(url, options);
    return ZipEditor.openReader(reader, options);
  }

  /**
   * Close underlying resources (only relevant for reader-backed editors).
   */
  async close(): Promise<void> {
    await this._remote.close();
  }

  /**
   * Get a snapshot of the original parsed entries (ignores pending edits).
   *
   * Use this to inspect the archive before making changes.
   */
  getEntries(): ZipEntryRecord[] {
    return Array.from(this._baseEntries.values());
  }

  /**
   * Check if an entry exists (considering pending edits).
   *
   * @param name - Entry name to check
   * @returns `true` if the entry exists and is not deleted
   */
  has(name: string): boolean {
    return this._view.has(name);
  }

  /**
   * Delete an entry from the archive.
   *
   * @param name - Entry name to delete
   * @returns `true` if the entry existed and was deleted, `false` otherwise
   */
  delete(name: string): boolean {
    return this._view.delete(name);
  }

  /**
   * Delete a directory and all its contents recursively.
   *
   * This method deletes the directory entry itself (if it exists) and all entries
   * whose paths start with the directory prefix. Similar to `rm -rf` behavior.
   *
   * @param prefix - The directory path prefix to delete (with or without trailing slash)
   * @returns The number of entries deleted
   *
   * @example
   * ```ts
   * // Delete "assets/" folder and all files inside it
   * const deletedCount = editor.deleteDirectory("assets");
   *
   * // With trailing slash (same result)
   * editor.deleteDirectory("assets/");
   *
   * // Delete nested directory
   * editor.deleteDirectory("src/components/old");
   * ```
   */
  deleteDirectory(prefix: string): number {
    return this._view.deleteDirectory(prefix);
  }

  /**
   * Add or update an entry.
   *
   * If an entry with the same name already exists, it will be replaced.
   *
   * @param name - Entry name (path in the archive)
   * @param source - Entry data (Uint8Array, string, Blob, or async iterable)
   * @param options - Per-entry options (level, modTime, etc.)
   * @returns `this` for chaining
   *
   * @example
   * ```ts
   * editor
   *   .set("readme.txt", "Hello World")
   *   .set("data.bin", binaryData, { level: 0 })  // store without compression
   *   .set("config.json", JSON.stringify(config));
   * ```
   */
  set(name: string, source: ArchiveSource, options?: ZipEntryOptions): this {
    this._view.set(name, source, options);
    return this;
  }

  /**
   * Rename an entry.
   *
   * **Overwrite behavior**: If an entry with the target name already exists,
   * it will be replaced (similar to `mv -f`).
   *
   * @param from - Current entry name
   * @param to - New entry name
   * @returns `true` if the rename was successful, `false` if source doesn't exist
   *
   * @example
   * ```ts
   * editor.rename("old-name.txt", "new-name.txt");
   * ```
   */
  rename(from: string, to: string): boolean {
    return this._view.rename(from, to);
  }

  /**
   * Set or update the archive-level comment.
   *
   * @param comment - Comment string (or `undefined` to remove)
   * @returns `this` for chaining
   */
  setComment(comment?: string): this {
    this._options.comment = comment;
    return this;
  }

  /**
   * Apply a reusable edit plan to this editor.
   */
  apply(plan: ZipEditPlan): this {
    plan.applyTo(this);
    return this;
  }

  /**
   * Get a list of entry names that will appear in the output archive.
   * This accounts for deletes, renames, and additions.
   */
  getOutputEntryNames(): string[] {
    return this._view.getOutputNames().sort();
  }

  private _getBuildOptions() {
    return {
      level: this._options.level,
      timestamps: this._options.timestamps,
      modTime: this._options.modTime,
      comment: this._options.comment,
      smartStore: this._options.smartStore,
      zip64: this._options.zip64,
      path: this._options.path,
      encoding: this._options.encoding
    };
  }

  private _buildPreservedRawFile(
    outName: string,
    info: ZipEntryRecord,
    compressedData: AsyncIterable<Uint8Array>,
    zip64: Zip64Mode
  ): ZipRawFile {
    const { dosTime, dosDate } = dateToZipDos(info.lastModified);
    return new ZipRawFile(outName, {
      compressedData,
      crc32: info.crc32,
      compressedSize: info.compressedSize,
      uncompressedSize: info.uncompressedSize,
      compressionMethod: info.compressionMethod,
      flags: getPreservedBaseFlags(info),
      comment: encodeZipStringWithCodec(info.comment, this._stringCodec),
      extraField: info.extraField,
      dosTime,
      dosDate,
      zip64,
      externalAttributes: info.externalAttributes,
      versionMadeBy: info.versionMadeBy,
      codec: this._stringCodec
    });
  }

  private _buildPreservedRawEntry(
    outName: string,
    info: ZipEntryRecord,
    compressedData: Uint8Array
  ): ZipRawEntry {
    return buildPreservedRawEntry(outName, info, compressedData, this._options.encoding);
  }

  private _emitWarning(entry: string, code: ZipEditWarning["code"], message: string): void {
    if (this._onWarning) {
      this._onWarning({ entry, code, message });
    }
  }

  private _buildRawPreservedEntries(): PreservedEntry[] {
    return this._view.getBaseEntries().map(e => ({ outName: e.name, info: e.info }));
  }

  private _buildSetEntries(): SetViewEntry[] {
    return this._view.getSetEntries();
  }

  /**
   * Get the output as an async iterable of chunks.
   *
   * This is the most memory-efficient way to get the output for large archives.
   *
   * @param options - Streaming options (signal, onProgress)
   * @returns An async iterable of Uint8Array chunks
   *
   * @example
   * ```ts
   * const chunks: Uint8Array[] = [];
   * for await (const chunk of editor.stream()) {
   *   chunks.push(chunk);
   * }
   * ```
   */
  stream(options: ZipStreamOptions = {}): AsyncIterable<Uint8Array> {
    return this.operation(options).iterable;
  }

  /**
   * Get the output as an async iterable with full operation control.
   *
   * Returns an object with the iterable plus progress tracking and abort methods.
   *
   * @param options - Streaming options
   * @returns A `ZipOperation` object
   *
   * @example
   * ```ts
   * const op = editor.operation({
   *   onProgress: (p) => console.log(`${p.entriesDone}/${p.entriesTotal}`)
   * });
   *
   * for await (const chunk of op.iterable) {
   *   // process chunk
   * }
   * ```
   */
  operation(options: ZipStreamOptions = {}): ZipOperation {
    const signalOpt = options.signal ?? this._streamDefaults.signal;
    const onProgress = options.onProgress ?? this._streamDefaults.onProgress;
    const progressIntervalMs =
      options.progressIntervalMs ?? this._streamDefaults.progressIntervalMs;

    const preservedMeta = this._buildRawPreservedEntries();
    const sets = this._buildSetEntries();

    return createZipOperation(
      preservedMeta.length + sets.length,
      {
        comment: this._options.comment,
        zip64: this._options.zip64,
        codec: this._stringCodec
      },
      { signal: signalOpt, onProgress, progressIntervalMs },
      async ({ zip, signal, progress }) => {
        // Classify preserved entries using the pipeline's linked signal so that
        // abort() properly cancels raw compressed streams.
        const preservedRaw: Array<PreservedEntry & { compressedData: AsyncIterable<Uint8Array> }> =
          [];
        const preservedRecompressed: Array<{
          name: string;
          info: ZipEntryRecord;
        }> = [];

        for (const p of preservedMeta) {
          const compressedData = this._remote.getRawCompressedStream(p.info.path, { signal });
          if (compressedData) {
            preservedRaw.push({ ...p, compressedData });
            continue;
          }

          this._emitWarning(
            p.info.path,
            "raw_unavailable",
            `Cannot read raw compressed payload for entry "${p.info.path}".`
          );

          if (this._options.preserve === "strict") {
            throw new ArchiveError(
              `Cannot preserve entry "${p.info.path}" because its raw compressed payload is unavailable.`
            );
          }

          // We cannot re-encrypt entries; best-effort must not silently output decrypted content.
          if (p.info.isEncrypted) {
            this._emitWarning(
              p.info.path,
              "encryption_unsupported",
              `Cannot best-effort preserve encrypted entry "${p.info.path}" without raw passthrough.`
            );
            continue;
          }

          // Best-effort fallback: extract and re-add the entry.
          preservedRecompressed.push({ name: p.outName, info: p.info });
        }

        // Update entriesTotal now that we know how many entries survived classification.
        const actualTotal = preservedRaw.length + preservedRecompressed.length + sets.length;
        progress.set("entriesTotal", actualTotal);

        // 1) Preserved entries: passthrough raw payload.
        for (let i = 0; i < preservedRaw.length; i++) {
          throwIfAborted(signal);

          const entry = preservedRaw[i]!;
          progress.update({ currentEntry: { name: entry.outName, index: i, bytesIn: 0 } });

          const rawFile = this._buildPreservedRawFile(
            entry.outName,
            entry.info,
            entry.compressedData,
            this._options.zip64
          );

          zip.add(rawFile);

          // StreamingZip auto-starts passthrough files; await completion for accurate progress.
          await rawFile.done();

          progress.set("entriesDone", progress.snapshot.entriesDone + 1);
        }

        // 1b) Best-effort preserved entries: extract and re-add.
        for (let k = 0; k < preservedRecompressed.length; k++) {
          throwIfAborted(signal);

          const idx = preservedRaw.length + k;
          const entry = preservedRecompressed[k]!;

          let entryBytesIn = 0;
          progress.update({ currentEntry: { name: entry.name, index: idx, bytesIn: 0 } });

          let data: Uint8Array;
          try {
            data = await this._remote.extractEntry(entry.info);
          } catch (e) {
            const err = toError(e);
            this._emitWarning(
              entry.info.path,
              "unknown",
              `Failed to extract entry "${entry.info.path}" for best-effort preserve: ${err.message}`
            );
            progress.set("entriesDone", progress.snapshot.entriesDone + 1);
            continue;
          }

          const fallbackLevel = entry.info.compressionMethod === 0 ? 0 : this._options.level;

          const file = new ZipDeflateFile(
            entry.name,
            buildZipDeflateFileOptions(
              {
                level: fallbackLevel,
                modTime: entry.info.lastModified,
                comment: entry.info.comment,
                externalAttributes: entry.info.externalAttributes,
                versionMadeBy: entry.info.versionMadeBy
              },
              {
                level: this._options.level,
                modTime: this._options.modTime,
                timestamps: this._options.timestamps,
                smartStore: this._options.smartStore,
                zip64: this._options.zip64,
                path: this._options.path,
                encoding: this._options.encoding
              }
            )
          );

          zip.add(file);
          entryBytesIn += data.length;
          progress.mutate(s => {
            s.bytesIn += data.length;
            s.currentEntry = { name: entry.name, index: idx, bytesIn: entryBytesIn };
          });
          await file.push(data, true);
          await file.outputCheckpoint();
          await file.complete();
          progress.set("entriesDone", progress.snapshot.entriesDone + 1);
        }

        // 2) Set/update entries: compress from source.
        for (let j = 0; j < sets.length; j++) {
          throwIfAborted(signal);

          const idx = preservedRaw.length + preservedRecompressed.length + j;
          const entry = sets[j]!;

          let entryBytesIn = 0;
          progress.update({ currentEntry: { name: entry.name, index: idx, bytesIn: 0 } });

          const file = new ZipDeflateFile(
            entry.name,
            buildZipDeflateFileOptions(entry.options, {
              level: this._options.level,
              modTime: this._options.modTime,
              timestamps: this._options.timestamps,
              smartStore: this._options.smartStore,
              zip64: this._options.zip64,
              path: this._options.path,
              encoding: this._options.encoding
            })
          );

          zip.add(file);

          const onChunk = (chunk: Uint8Array) => {
            entryBytesIn += chunk.length;
            progress.mutate(s => {
              s.bytesIn += chunk.length;
              s.currentEntry = { name: entry.name, index: idx, bytesIn: entryBytesIn };
            });
          };

          if (isSyncArchiveSource(entry.source)) {
            const bytes = toUint8ArraySync(entry.source);
            throwIfAborted(signal);
            onChunk(bytes);
            await file.push(bytes, true);
            await file.outputCheckpoint();
          } else {
            // Streaming path (includes Blob via toAsyncIterable(Blob) which prefers Blob.stream())
            for await (const chunk of toAsyncIterable(entry.source, { signal, onChunk })) {
              throwIfAborted(signal);
              await file.push(chunk, false);
              await file.outputCheckpoint();
            }
            throwIfAborted(signal);
            await file.push(new Uint8Array(0), true);
            await file.outputCheckpoint();
          }

          await file.complete();
          progress.set("entriesDone", progress.snapshot.entriesDone + 1);
        }

        throwIfAborted(signal);
        zip.end();
      }
    );
  }

  /**
   * Get the output as a single Uint8Array.
   *
   * This is the simplest output method. For large archives, consider using
   * `stream()` instead to avoid holding the entire output in memory.
   *
   * @param options - Streaming options (signal, onProgress)
   * @returns A Promise that resolves to the complete ZIP data
   *
   * @example
   * ```ts
   * const zipData = await editor.bytes();
   *
   * // With progress tracking
   * const zipData = await editor.bytes({
   *   onProgress: (p) => console.log(`${p.entriesDone}/${p.entriesTotal}`)
   * });
   * ```
   */
  async bytes(options: ZipStreamOptions = {}): Promise<Uint8Array> {
    const signalOpt = options.signal ?? this._streamDefaults.signal;
    const onProgress = options.onProgress ?? this._streamDefaults.onProgress;

    if (onProgress || signalOpt) {
      return collect(this.stream(options));
    }

    const preservedMeta = this._buildRawPreservedEntries();
    const sets = this._buildSetEntries();

    const allSourcesInMemory = sets.every(e => isInMemoryArchiveSource(e.source));
    const allSourcesSync = sets.every(e => isSyncArchiveSource(e.source));

    const rawEntries: ZipRawEntry[] = [];
    const recompressedPreserved: ZipEntry[] = [];

    for (const p of preservedMeta) {
      const compressedData = await this._remote.getRawCompressedData(p.info.path);
      if (compressedData) {
        rawEntries.push(this._buildPreservedRawEntry(p.outName, p.info, compressedData));
        continue;
      }

      this._emitWarning(
        p.info.path,
        "raw_unavailable",
        `Cannot read raw compressed payload for entry "${p.info.path}".`
      );

      if (this._options.preserve === "strict") {
        throw new ArchiveError(
          `Cannot preserve entry "${p.info.path}" because its raw compressed payload is unavailable.`
        );
      }

      // We cannot re-encrypt entries; best-effort must not silently output decrypted content.
      if (p.info.isEncrypted) {
        this._emitWarning(
          p.info.path,
          "encryption_unsupported",
          `Cannot best-effort preserve encrypted entry "${p.info.path}" without raw passthrough.`
        );
        continue;
      }

      // Best-effort fallback: extract and re-add.
      try {
        const data = await this._remote.extractEntry(p.info);
        const fallbackLevel = p.info.compressionMethod === 0 ? 0 : this._options.level;
        recompressedPreserved.push({
          name: p.outName,
          data,
          level: fallbackLevel,
          modTime: p.info.lastModified,
          comment: p.info.comment,
          externalAttributes: p.info.externalAttributes,
          versionMadeBy: p.info.versionMadeBy
        });
      } catch (e) {
        const err = toError(e);
        this._emitWarning(
          p.info.path,
          "unknown",
          `Failed to extract entry "${p.info.path}" for best-effort preserve: ${err.message}`
        );
        // Skip entry.
      }
    }

    // Fast path: all sources are sync primitives (can use sync API)
    if (allSourcesInMemory && allSourcesSync) {
      const normalEntries: ZipEntry[] = [
        ...recompressedPreserved,
        ...sets.map(entry => {
          // Type narrowing: we know source is in-memory and not Blob
          const src = entry.source as Uint8Array | ArrayBuffer | string;
          return {
            name: entry.name,
            data: toUint8ArraySync(src),
            level: entry.options?.level,
            modTime: entry.options?.modTime,
            atime: entry.options?.atime,
            ctime: entry.options?.ctime,
            birthTime: entry.options?.birthTime,
            comment: entry.options?.comment,
            mode: entry.options?.mode,
            msDosAttributes: entry.options?.msDosAttributes,
            externalAttributes: entry.options?.externalAttributes,
            versionMadeBy: entry.options?.versionMadeBy
          };
        })
      ];

      return createZipSync([...rawEntries, ...normalEntries], this._getBuildOptions());
    }

    // Async path: some sources need streaming collection (Blob or streaming)
    const resolvedEntries = await Promise.all(
      sets.map(async entry => {
        // Collect bytes from any source type
        let data: Uint8Array;
        if (isSyncArchiveSource(entry.source)) {
          data = toUint8ArraySync(entry.source);
        } else {
          // Streaming source: collect all chunks (includes Blob via toAsyncIterable(Blob) which prefers Blob.stream())
          data = await collectUint8ArrayStream(toAsyncIterable(entry.source));
        }

        return {
          name: entry.name,
          data,
          level: entry.options?.level,
          modTime: entry.options?.modTime,
          atime: entry.options?.atime,
          ctime: entry.options?.ctime,
          birthTime: entry.options?.birthTime,
          comment: entry.options?.comment,
          mode: entry.options?.mode,
          msDosAttributes: entry.options?.msDosAttributes,
          externalAttributes: entry.options?.externalAttributes,
          versionMadeBy: entry.options?.versionMadeBy
        };
      })
    );

    const normalEntries: ZipEntry[] = [...recompressedPreserved, ...resolvedEntries];

    return createZip([...rawEntries, ...normalEntries], this._getBuildOptions());
  }

  /**
   * Pipe the output to a sink (e.g., a writable stream).
   *
   * @param sink - The sink to write to
   * @param options - Streaming options
   *
   * @example
   * ```ts
   * // Node.js: pipe to file
   * import { createWriteStream } from "fs";
   * await editor.pipeTo(createWriteStream("output.zip"));
   * ```
   */
  async pipeTo(sink: ArchiveSink, options: ZipStreamOptions = {}): Promise<void> {
    await pipeIterableToSink(this.stream(options), sink);
  }
}

/**
 * Open an existing ZIP archive for editing.
 *
 * This is a convenience function equivalent to `ZipEditor.open()`.
 *
 * @param source - The ZIP data
 * @param options - Edit options
 * @returns A new `ZipEditor` instance
 *
 * @example
 * ```ts
 * import { editZip, zip } from "@archive";
 *
 * // Create and edit
 * const original = await zip().add("a.txt", "hello").bytes();
 * const editor = await editZip(original);
 * editor.set("b.txt", "world");
 * const modified = await editor.bytes();
 *
 * // Edit with options
 * const editor = await editZip(original, {
 *   path: { mode: "safe" },
 *   reproducible: true,
 *   onWarning: (w) => console.warn(w.message)
 * });
 * ```
 */
export async function editZip(
  source: ArchiveSource | RandomAccessReader,
  options: ZipEditOptions = {}
): Promise<ZipEditor> {
  return ZipEditor.open(source, options);
}

/**
 * Open a remote ZIP archive for editing using HTTP Range requests.
 *
 * This is a convenience function equivalent to `ZipEditor.openUrl()`.
 */
export async function editZipUrl(url: string, options: ZipEditUrlOptions = {}): Promise<ZipEditor> {
  return ZipEditor.openUrl(url, options);
}
