import {
  ArchiveError,
  createAbortError,
  createLinkedAbortController,
  throwIfAborted,
  toError,
  suppressUnhandledRejection
} from "@archive/core/errors";
import { ProgressEmitter } from "@archive/core/progress";
import type { ZipStringEncoding } from "@archive/core/text";
import type { ArchiveFormat } from "@archive/core/types";
import type { ArchiveSink } from "@archive/io/archive-sink";
import { pipeIterableToSink } from "@archive/io/archive-sink";
import type { ArchiveSource } from "@archive/io/archive-source";
import { isInMemoryArchiveSource, toAsyncIterable, toUint8Array } from "@archive/io/archive-source";
import type { TarReaderProgress } from "@archive/tar/tar-archive";
import type { UnzipOperation, UnzipProgress, UnzipStreamOptions } from "@archive/unzip/progress";
import type { ParseOptions, ZipEntry as ParseZipEntry } from "@archive/unzip/stream";
import { createParse } from "@archive/unzip/stream";
import {
  processEntryData,
  processEntryDataStream,
  readEntryCompressedData
} from "@archive/unzip/zip-extract-core";
import type { ZipEntryRecord, ZipParseOptions } from "@archive/unzip/zip-parser";
import { ZipParser } from "@archive/unzip/zip-parser";
import type { ZipEntryEncryptionMethod, ZipEntryType } from "@archive/zip-spec/zip-entry-info";
import { isSymlink } from "@archive/zip-spec/zip-entry-info";
import { COMPRESSION_AES } from "@archive/zip-spec/zip-records";
import { eventedReadableToAsyncIterableNoDestroy } from "@stream/core/evented-readable-to-async-iterable";
import { isWritableStream } from "@stream/core/type-guards";
import { getTextDecoder } from "@utils/binary";

function attachAbortToParseEntry(entry: ParseZipEntry, signal: AbortSignal): void {
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    signal.removeEventListener("abort", onAbort);
  };

  const onAbort = () => {
    cleanup();
    try {
      entry.destroy(createAbortError(signal.reason));
    } catch {
      entry.autodrain();
    }
  };

  if (signal.aborted) {
    onAbort();
    return;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  entry.once("end", cleanup);
  entry.once("close", cleanup);
  entry.once("error", cleanup);
}

/**
 * Build a ZipEntryRecord from a streaming ParseZipEntry's local file header data.
 * This enables processEntryData (decrypt + decompress) for streaming-mode entries.
 */
function buildEntryInfoFromParseEntry(entry: ParseZipEntry): ZipEntryRecord {
  const vars = entry.vars;
  const flags = vars.flags ?? 0;
  const compressionMethod = vars.compressionMethod ?? 0;
  const isEncrypted = (flags & 0x01) !== 0 || compressionMethod === COMPRESSION_AES;
  const aesInfo = entry.extraFields?.aesInfo;

  let encryptionMethod: ZipEntryEncryptionMethod = "none";
  if (isEncrypted) {
    if (compressionMethod === COMPRESSION_AES && aesInfo) {
      encryptionMethod = "aes";
    } else {
      encryptionMethod = "zipcrypto";
    }
  }

  return {
    path: entry.path,
    type: entry.type === "Directory" ? "directory" : "file",
    compressedSize: vars.compressedSize ?? 0,
    uncompressedSize: vars.uncompressedSize ?? 0,
    compressionMethod,
    crc32: vars.crc32 ?? 0,
    lastModified: vars.lastModifiedDateTime ?? new Date(0),
    localHeaderOffset: 0,
    comment: "",
    externalAttributes: 0,
    mode: 0,
    isEncrypted,
    encryptionMethod,
    aesVersion: aesInfo?.version,
    aesKeyStrength: aesInfo?.keyStrength,
    originalCompressionMethod: aesInfo?.compressionMethod,
    dosTime: vars.lastModifiedTime ?? undefined
  };
}

/**
 * Convert an AsyncIterable to a WHATWG ReadableStream.
 */
function asyncIterableToReadableStream<T>(
  iterable: AsyncIterable<T>,
  onCancel?: (reason: unknown) => void
): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let cancelled = false;

  return new ReadableStream<T>({
    async pull(controller) {
      if (cancelled) {
        controller.close();
        return;
      }

      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(toError(e));
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await iterator.return?.();
      } catch {
        // ignore
      }
      onCancel?.(reason);
    }
  });
}

type PipeToOptions = {
  preventClose?: boolean;
  preventAbort?: boolean;
  preventCancel?: boolean;
  signal?: AbortSignal;
};

export interface UnzipOptions {
  /**
   * Archive format: "zip" (default) or "tar".
   * Note: format dispatch is handled by `unzip()`.
   */
  format?: ArchiveFormat;

  decodeStrings?: boolean;
  /** Optional string encoding for legacy (non-UTF8) names/comments. */
  encoding?: ZipStringEncoding;
  parse?: ParseOptions;

  /** Password for encrypted entries (ZIP only). */
  password?: string | Uint8Array;

  /** Default abort signal used by streaming operations. */
  signal?: AbortSignal;

  /** Default progress callback used by streaming operations. */
  onProgress?: (p: UnzipProgress) => void;

  /** Default throttle for progress callbacks. */
  progressIntervalMs?: number;
}

export type { UnzipOperation, UnzipProgress, UnzipStreamOptions } from "@archive/unzip/progress";

export class UnzipEntry {
  readonly path: string;
  /** Entry type: file, directory, or symlink */
  readonly type: ZipEntryType;
  /**
   * For symlinks, returns the target path after calling bytes().
   * Before extraction, this is undefined.
   */
  linkTarget?: string;
  /**
   * Unix file mode/permissions (0 if unavailable).
   */
  readonly mode: number;
  /** Whether this entry is encrypted (ZipCrypto or AES). */
  readonly isEncrypted: boolean;

  private readonly _data?: Uint8Array;
  private readonly _info?: ZipEntryRecord;
  private readonly _password?: string | Uint8Array;
  private readonly _parseEntry?: ParseZipEntry;
  private readonly _onBytesOut?: (path: string, type: ZipEntryType, bytes: number) => void;
  private readonly _signal?: AbortSignal;

  constructor(
    args:
      | { kind: "buffer"; data: Uint8Array; info: ZipEntryRecord; password?: string | Uint8Array }
      | { kind: "stream"; entry: ParseZipEntry; password?: string | Uint8Array },
    hooks: {
      onBytesOut?: (path: string, type: ZipEntryType, bytes: number) => void;
      signal?: AbortSignal;
    } = {}
  ) {
    if (args.kind === "buffer") {
      this._data = args.data;
      this._info = args.info;
      this._password = args.password;
      this.path = args.info.path;
      this.type = args.info.type;
      this.mode = args.info.mode;
      this.isEncrypted = args.info.isEncrypted;
    } else {
      this._parseEntry = args.entry;
      this._password = args.password;
      this.path = args.entry.path;
      // Streaming parser cannot detect symlinks (requires Central Directory)
      this.type = args.entry.type === "Directory" ? "directory" : "file";
      this.mode = 0;
      const flags = args.entry.vars.flags ?? 0;
      this.isEncrypted = (flags & 0x01) !== 0 || args.entry.vars.compressionMethod === 99;

      // For encrypted entries the streaming parser passes through raw ciphertext
      // (inflate is skipped). Build a ZipEntryRecord so processEntryData can
      // handle decryption + decompression in bytes()/stream().
      if (this.isEncrypted) {
        this._info = buildEntryInfoFromParseEntry(args.entry);
      }
    }

    this._onBytesOut = hooks.onBytesOut;
    this._signal = hooks.signal;

    // If this entry is backed by a streaming parser entry, ensure it is
    // interrupted on abort so consumers don't hang waiting for more chunks.
    if (this._parseEntry && this._signal) {
      attachAbortToParseEntry(this._parseEntry, this._signal);
    }
  }

  /**
   * Process extracted bytes: populate linkTarget for symlinks and notify progress.
   */
  private _processExtractedBytes(bytes: Uint8Array): Uint8Array {
    // For symlinks, the data content is the target path
    if (isSymlink(this.type) && bytes.length > 0) {
      this.linkTarget = getTextDecoder().decode(bytes);
    }
    if (this._onBytesOut && bytes.length) {
      this._onBytesOut(this.path, this.type, bytes.length);
    }
    return bytes;
  }

  async bytes(): Promise<Uint8Array> {
    if (this._data && this._info) {
      // Use shared extraction core for buffer mode
      const compressedData = readEntryCompressedData(this._data, this._info);
      const bytes = await processEntryData(this._info, compressedData, this._password);
      return this._processExtractedBytes(bytes);
    }
    if (this._parseEntry) {
      const data = await this._parseEntry.buffer();
      // In Node.js, `entry.buffer()` may return a Buffer, which causes
      // deep-equality mismatches against Uint8Array in tests.
      let bytes =
        typeof Buffer !== "undefined" && data instanceof Buffer
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : data;

      // Encrypted entries in streaming mode carry raw ciphertext (inflate is
      // skipped by readFileRecord). Decrypt + decompress via processEntryData,
      // the same path used by buffer mode.
      if (this._info && this.isEncrypted) {
        bytes = await processEntryData(this._info, bytes, this._password);
      }

      return this._processExtractedBytes(bytes);
    }
    return new Uint8Array(0);
  }

  async *stream(): AsyncIterable<Uint8Array> {
    if (this._data && this._info) {
      // Symlinks are tiny and their target is resolved by bytes() via
      // _processExtractedBytes; keep the buffered path for them.
      if (this._info.type === "symlink") {
        const data = await this.bytes();
        if (data.length) {
          yield data;
        }
        return;
      }

      // True streaming for buffer-backed entries: inflate incrementally rather
      // than materializing the whole uncompressed entry up-front. This keeps
      // peak memory at O(inflate chunk) for large entries (e.g. a multi-MB
      // `word/document.xml` / xlsx `sheetN.xml`), which is what makes
      // SAX-driven streaming readers genuinely O(largest element) on an
      // in-memory package instead of O(full uncompressed part).
      //
      // The compressed bytes are fed in fixed-size slices rather than as a
      // single chunk. Feeding the whole entry in one `write()` lets the
      // decompressor (notably the browser's async `DecompressionStream`,
      // whose read loop runs ahead of the consumer) produce *all* output
      // before the consumer pulls the first chunk — collapsing the stream
      // back to O(full uncompressed part). Slicing the input interleaves
      // production with consumption so output is delivered incrementally on
      // every platform.
      const compressedData = readEntryCompressedData(this._data, this._info);
      const FEED_CHUNK = 65536;
      const feed = (async function* () {
        for (let off = 0; off < compressedData.length; off += FEED_CHUNK) {
          yield compressedData.subarray(off, off + FEED_CHUNK);
        }
      })();
      const outStream = processEntryDataStream(this._info, feed, {
        password: this._password,
        signal: this._signal
      });

      // Robustness: the browser's native streaming `DecompressionStream` can
      // intermittently reject input that is in fact valid deflate (observed in
      // Chromium under heavy concurrent stream creation). The non-streaming
      // `processEntryData` path already recovers from this by falling back to
      // the pure-JS inflater. Mirror that here: if the streaming inflate fails
      // *before producing any output* we have not yielded anything yet, so we
      // can safely re-decode the whole (already in-memory) entry via the
      // buffered path and yield the result as a single chunk. Once output has
      // started flowing we keep streaming; a mid-stream failure on valid data
      // has not been observed and would indicate genuine corruption.
      //
      // The first pull is handled separately from the rest so the two error
      // regimes are structurally distinct: a throw from the first `next()`
      // means "before any output" (recover); any throw once we are streaming
      // propagates unchanged. `iterator.return()` in `finally` reproduces the
      // automatic cleanup `for await` performs on early break/return/throw,
      // so the underlying decompress stream is always torn down.
      const iterator = outStream[Symbol.asyncIterator]();
      try {
        let first: IteratorResult<Uint8Array>;
        try {
          first = await iterator.next();
        } catch {
          // Fall back to the buffered decode (which itself falls back to
          // pure-JS inflate on native failure). Throws if genuinely corrupt.
          const recovered = await this.bytes();
          if (recovered.length) {
            if (this._onBytesOut) {
              this._onBytesOut(this.path, this.type, recovered.length);
            }
            yield recovered;
          }
          return;
        }
        // Streaming succeeded past the first pull: yield the first chunk and
        // the remainder. Any failure from here on is genuine mid-stream
        // corruption and propagates to the caller.
        for (let step = first; !step.done; step = await iterator.next()) {
          const chunk = step.value;
          if (this._onBytesOut && chunk.length) {
            this._onBytesOut(this.path, this.type, chunk.length);
          }
          yield chunk;
        }
      } finally {
        await iterator.return?.();
      }
      return;
    }

    if (this._parseEntry) {
      // ParseZipEntry is always a Node PassThrough, so it satisfies the evented
      // readable contract; adapt it to an AsyncIterable without destroying it.
      const iterable: AsyncIterable<Uint8Array> =
        eventedReadableToAsyncIterableNoDestroy<Uint8Array>(this._parseEntry);

      // Encrypted entries carry raw ciphertext in streaming mode (inflate is
      // skipped by readFileRecord). Pipe through processEntryDataStream which
      // handles decrypt + decompress in a true streaming fashion for ZipCrypto.
      // AES still buffers internally (HMAC needs full ciphertext) but the API
      // surface remains consistent.
      if (this.isEncrypted && this._info) {
        const outStream = processEntryDataStream(this._info, iterable, {
          password: this._password,
          signal: this._signal
        });

        let completed = false;
        try {
          for await (const chunk of outStream) {
            if (this._onBytesOut && chunk.length) {
              this._onBytesOut(this.path, this.type, chunk.length);
            }
            yield chunk;
          }
          completed = true;
        } finally {
          if (!completed) {
            try {
              this._parseEntry.autodrain();
            } catch {
              // Best effort cleanup only.
            }
          }
        }
        return;
      }

      let completed = false;
      try {
        for await (const chunk of iterable) {
          if (this._onBytesOut && chunk.length) {
            this._onBytesOut(this.path, this.type, chunk.length);
          }
          yield chunk;
        }
        completed = true;
      } finally {
        if (!completed) {
          try {
            this._parseEntry.autodrain();
          } catch {
            // Best effort cleanup only.
          }
        }
      }
    }
  }

  async pipeTo(sink: WritableStream<Uint8Array>, options?: PipeToOptions): Promise<void>;
  async pipeTo(sink: ArchiveSink): Promise<void>;
  async pipeTo(sink: ArchiveSink, options?: PipeToOptions): Promise<void> {
    // Prefer native Web Streams piping semantics when a WHATWG WritableStream is provided.
    // This supports standard options like `signal` / `preventClose` / `preventAbort`.
    if (isWritableStream(sink) && typeof this.readableStream().pipeTo === "function") {
      await this.readableStream().pipeTo(sink, options);
      return;
    }

    // Fallback to the library sink piping (supports Node-style Writable too).
    await pipeIterableToSink(this.stream(), sink);
  }

  readableStream(): ReadableStream<Uint8Array> {
    const parseEntry = this._parseEntry;

    return asyncIterableToReadableStream(this.stream(), reason => {
      if (parseEntry) {
        try {
          parseEntry.destroy?.(createAbortError(reason));
        } catch {
          try {
            parseEntry.autodrain?.();
          } catch {
            // ignore
          }
        }
      }
    });
  }

  async text(encoding?: string): Promise<string> {
    const bytes = await this.bytes();
    return getTextDecoder(encoding).decode(bytes);
  }

  discard(): void {
    if (this._parseEntry) {
      this._parseEntry.autodrain();
    }
  }
}

export class ZipReader {
  private readonly _source: ArchiveSource;
  private readonly _options: UnzipOptions;
  private _bufferParser: ZipParser | null = null;
  private _bufferData: Uint8Array | null = null;

  constructor(source: ArchiveSource, options: UnzipOptions = {}) {
    this._source = source;
    this._options = options;
  }

  private get _encoding() {
    return this._options.encoding ?? this._options.parse?.encoding;
  }

  entries(options: UnzipStreamOptions = {}): AsyncIterable<UnzipEntry> {
    return this.operation(options).iterable;
  }

  entriesStream(options: UnzipStreamOptions = {}): ReadableStream<UnzipEntry> {
    const op = this.operation(options);

    return asyncIterableToReadableStream(op.iterable, reason => {
      try {
        op.abort(reason ?? "cancelled");
      } catch {
        // ignore
      }
    });
  }

  operation(options: UnzipStreamOptions = {}): UnzipOperation {
    const { controller, cleanup: cleanupAbortLink } = createLinkedAbortController(
      options.signal ?? this._options.signal
    );
    const signal = controller.signal;

    const onProgress = options.onProgress ?? this._options.onProgress;
    const progress = new ProgressEmitter<UnzipProgress>(
      {
        type: "unzip",
        phase: "running",
        bytesIn: 0,
        bytesOut: 0,
        entriesEmitted: 0
      },
      onProgress,
      { intervalMs: options.progressIntervalMs ?? this._options.progressIntervalMs }
    );

    const onBytesOut = (path: string, entryType: ZipEntryType, bytes: number): void => {
      progress.mutate(s => {
        s.bytesOut += bytes;
        const prev = s.currentEntry;
        s.currentEntry =
          prev && prev.path === path
            ? { ...prev, bytesOut: prev.bytesOut + bytes }
            : { path, entryType, bytesOut: bytes };
      });
    };

    const iterable = async function* (this: ZipReader): AsyncIterable<UnzipEntry> {
      try {
        throwIfAborted(signal);

        // Buffer mode
        if (isInMemoryArchiveSource(this._source)) {
          const bytes = await toUint8Array(this._source);
          throwIfAborted(signal);
          progress.update({ bytesIn: bytes.length });
          const parser = new ZipParser(bytes, {
            decodeStrings: this._options.decodeStrings,
            encoding: this._encoding
          } satisfies ZipParseOptions);
          const password = this._options.password;

          for (const info of parser.getEntries()) {
            throwIfAborted(signal);
            progress.mutate(s => {
              s.entriesEmitted += 1;
              s.currentEntry = { path: info.path, entryType: info.type, bytesOut: 0 };
            });
            yield new UnzipEntry(
              { kind: "buffer", data: bytes, info, password },
              { onBytesOut, signal }
            );
          }

          if (progress.snapshot.phase === "running") {
            progress.update({ phase: "done" });
          }
          return;
        }

        // Streaming mode
        const parse = createParse({ ...(this._options.parse ?? {}), forceStream: true });

        const parseDonePromise = parse.promise();
        // Ensure abort-driven rejections from the parser itself never surface as unhandled.
        suppressUnhandledRejection(parseDonePromise);

        const onAbort = () => {
          const err = createAbortError(signal.reason);
          progress.update({ phase: "aborted" });
          try {
            parse.destroy(err);
          } catch {
            // ignore
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const feedPromise = (async () => {
          try {
            for await (const chunk of toAsyncIterable(this._source, {
              signal,
              onChunk: c =>
                progress.mutate(s => {
                  s.bytesIn += c.length;
                })
            })) {
              throwIfAborted(signal);
              await new Promise<void>((resolve, reject) => {
                parse.write(chunk, (err?: Error | null) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                });
              });
            }

            throwIfAborted(signal);
            parse.end();
            await parseDonePromise;
          } catch (e) {
            const err = toError(e);
            parse.destroy(err);
            throw err;
          }
        })();

        // Avoid unhandled rejection warnings when the operation is aborted.
        suppressUnhandledRejection(feedPromise);

        const parseIter: AsyncIterator<ParseZipEntry> = (parse as AsyncIterable<ParseZipEntry>)[
          Symbol.asyncIterator
        ]();

        try {
          while (true) {
            const { value, done } = await parseIter.next();
            if (done) {
              break;
            }
            const entry = value;
            throwIfAborted(signal);
            progress.mutate(s => {
              s.entriesEmitted += 1;
              s.currentEntry = {
                path: entry.path,
                entryType: entry.type === "Directory" ? "directory" : "file",
                bytesOut: 0
              };
            });
            yield new UnzipEntry(
              { kind: "stream", entry, password: this._options.password },
              { onBytesOut, signal }
            );
          }

          await feedPromise;
          if (progress.snapshot.phase === "running") {
            progress.update({ phase: "done" });
          }
        } finally {
          signal.removeEventListener("abort", onAbort);

          // Ensure the parser iterator is closed and any abort-induced errors are observed.
          await parseIter.return?.().catch(() => {});

          // Ensure parser/feed completion does not surface as an unhandled rejection.
          await Promise.all([parseDonePromise, feedPromise]).catch(() => {});
        }
      } catch (e) {
        const err = toError(e);
        if (err.name === "AbortError") {
          progress.update({ phase: "aborted" });
        } else {
          progress.update({ phase: "error" });
        }
        throw err;
      } finally {
        if (progress.snapshot.phase === "running" && !signal.aborted) {
          try {
            controller.abort("cancelled");
          } catch {
            // ignore
          }
          progress.update({ phase: "aborted" });
        }
        cleanupAbortLink();
        progress.emitNow();
      }
    }.call(this);

    return {
      iterable,
      signal,
      abort(reason?: unknown) {
        controller.abort(reason);
      },
      pointer() {
        return progress.snapshot.bytesIn;
      },
      progress() {
        return progress.snapshotCopy();
      }
    };
  }

  private async _ensureBufferParser(): Promise<{ parser: ZipParser; data: Uint8Array }> {
    if (this._bufferParser && this._bufferData) {
      return { parser: this._bufferParser, data: this._bufferData };
    }

    if (isInMemoryArchiveSource(this._source)) {
      const bytes = await toUint8Array(this._source);
      this._bufferData = bytes;
      this._bufferParser = new ZipParser(bytes, {
        decodeStrings: this._options.decodeStrings,
        encoding: this._encoding
      } satisfies ZipParseOptions);
      return { parser: this._bufferParser, data: bytes };
    }

    throw new ArchiveError("This ZIP source is streaming; random access is not available");
  }

  async get(path: string): Promise<UnzipEntry | null> {
    const { parser, data } = await this._ensureBufferParser();
    const info = parser.getEntry(path);
    if (!info) {
      return null;
    }
    return new UnzipEntry({ kind: "buffer", data, info, password: this._options.password });
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const entry = await this.get(path);
    if (!entry) {
      return null;
    }
    return entry.bytes();
  }

  async close(): Promise<void> {
    // No persistent resources in buffer mode.
  }
}

/** Unzip options with format: "tar" */
export interface UnzipOptionsTar extends Omit<UnzipOptions, "onProgress"> {
  format: "tar";

  /**
   * Default progress callback used by streaming operations.
   *
   * TAR archives emit {@link TarReaderProgress} rather than {@link UnzipProgress}.
   */
  onProgress?: (p: TarReaderProgress) => void;
}

/** Unzip options with format: "zip" (or default) */
export interface UnzipOptionsZip extends UnzipOptions {
  format?: "zip";
}
