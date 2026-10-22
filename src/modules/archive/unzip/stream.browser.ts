/**
 * ZIP Stream Parser - Browser Version
 *
 * A streaming ZIP parser for browsers using native DecompressionStream.
 * Falls back to pure JavaScript implementation for older browsers.
 * Uses the browser Duplex stream implementation for compatibility.
 */

import { hasDeflateRawDecompressionStream } from "@archive/compression/compress.base";
import { inflateRaw as fallbackInflateRaw } from "@archive/compression/deflate-fallback";
import { ByteQueue } from "@archive/core/byte-queue";
import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import { toError } from "@archive/core/errors";
import type {
  CrxHeader,
  EntryProps,
  EntryVars,
  ParseDriverState,
  ParseOptions
} from "@archive/unzip/parser-core";
import { DATA_DESCRIPTOR_SIGNATURE_BYTES } from "@archive/unzip/parser-core";
import { PatternScanner } from "@archive/unzip/pattern-scanner";
import type {
  PullStreamPublicApi,
  InflateFactory,
  ParseEmitter,
  ParseIO,
  ZipEntry
} from "@archive/unzip/stream.base";
import {
  runParseLoop,
  DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK,
  streamUntilValidatedDataDescriptor
} from "@archive/unzip/stream.base";
import { Duplex, PassThrough } from "@stream";
import { concatUint8Arrays } from "@utils/binary";

// =============================================================================
// Worker protocol
// =============================================================================

/**
 * Messages posted back from the inline inflate worker to the main thread.
 * Discriminated by the `t` tag.
 */
type InflateWorkerMessage =
  | { t: "data"; chunk: Uint8Array }
  | { t: "end" }
  | { t: "aborted" }
  | { t: "ack"; id: number }
  | { t: "error"; message?: string };

/**
 * Async iterator returned by the custom entry-queue iterator. Mirrors the shape
 * Node's `Duplex[Symbol.asyncIterator]` expects, including `[Symbol.asyncDispose]`.
 */
interface DisposableEntryIterator extends AsyncIterator<ZipEntry, undefined>, AsyncDisposable {
  [Symbol.asyncIterator](): DisposableEntryIterator;
}

// =============================================================================
// Browser InflateRaw using DecompressionStream
// =============================================================================

/**
 * Duplex stream that wraps browser's native DecompressionStream.
 * Handles the "Junk found after end of compressed data" error gracefully
 * by treating it as end of stream when using data descriptors.
 *
 * Uses Duplex instead of Transform because DecompressionStream's output
 * is inherently async and doesn't fit the Transform's sync callback model.
 */
class BrowserInflateRaw extends Duplex {
  private decompressionStream: DecompressionStream;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private reading = false;
  private writeClosed = false;
  private _junkError = false;
  private _bytesIn = 0;
  private _bytesOut = 0;
  private _readingDone = false;
  // Backpressure: when `push()` returns false, the reader loop parks on this
  // resolver. `_read()` (called by Node when the consumer wants more bytes)
  // resolves it so the loop continues. Without this, a slow consumer would
  // cause unbounded growth of the Duplex's internal readable buffer.
  private _readPullResolver: (() => void) | null = null;
  private _readingDonePromise: Promise<void>;
  private _resolveReadingDone!: () => void;
  // Track pending write count for proper ordering
  private _pendingWrites = 0;
  private _writeFinishedPromise: Promise<void> | null = null;
  private _resolveWriteFinished: (() => void) | null = null;

  constructor() {
    // Pass write handler to Duplex so pipe() calls our write method
    // Also pass final handler to close the DecompressionStream when _writable ends
    super({
      // Keep the internal buffer bounded; this stream is used in tight parse loops.
      writableHighWaterMark: 512 * 1024,
      readableHighWaterMark: 512 * 1024,
      write: (chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) => {
        this._doWrite(chunk, callback);
      },
      final: (callback: (error?: Error | null) => void) => {
        this._closeWriter(() => {
          callback();
        });
      }
    });
    this.decompressionStream = new DecompressionStream("deflate-raw");
    this.writer =
      this.decompressionStream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    this.reader = this.decompressionStream.readable.getReader();
    this._readingDonePromise = new Promise(resolve => {
      this._resolveReadingDone = resolve;
    });
    this._startReading();
  }

  // Internal write implementation
  private _doWrite(chunk: Uint8Array, callback?: (error?: Error | null) => void): void {
    if (this._junkError) {
      // Already got junk error, don't write more
      if (callback) {
        callback();
      }
      return;
    }

    this._bytesIn += chunk.length;
    this._pendingWrites++;

    this.writer
      .write(chunk)
      .then(() => {
        this._pendingWrites--;
        if (this._pendingWrites === 0 && this._resolveWriteFinished) {
          this._resolveWriteFinished();
        }
        if (callback) {
          callback();
        }
      })
      .catch(e => {
        this._pendingWrites--;
        if (this._pendingWrites === 0 && this._resolveWriteFinished) {
          this._resolveWriteFinished();
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Junk") || msg.includes("junk")) {
          this._junkError = true;
          if (callback) {
            callback();
          }
        } else {
          if (callback) {
            callback(e);
          } else {
            this.emit("error", e);
          }
        }
      });
  }

  /**
   * Park the reader loop until the consumer pulls more data. Resolved by
   * the next `_read()` invocation from Node, which signals that the
   * Duplex's readable buffer has room again.
   */
  private _waitForReadablePull(): Promise<void> {
    if (this._readPullResolver) {
      // Should not happen — only one push site at a time.
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this._readPullResolver = resolve;
    });
  }

  override _read(_size: number): void {
    // Consumer wants more bytes. Wake the reader loop if it parked on
    // backpressure.
    const resolver = this._readPullResolver;
    if (resolver) {
      this._readPullResolver = null;
      resolver();
    }
  }

  private async _startReading(): Promise<void> {
    if (this.reading) {
      return;
    }
    this.reading = true;

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) {
          break;
        }
        this._bytesOut += value.length;

        // Push to the Duplex's readable side. If the consumer is slow,
        // `push()` returns false; pause our reader-loop until the consumer
        // pulls. Without this, a fast WebStream decompressor could overrun
        // the Duplex's readable buffer and accumulate megabytes of
        // decompressed data with no consumer.
        if (!this.push(value)) {
          await this._waitForReadablePull();
        }
      }
    } catch (e) {
      // "Junk found after end of compressed data" is expected when using data descriptors
      // because we can't know the exact compressed size upfront
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Junk") || msg.includes("junk")) {
        this._junkError = true;
        // This is OK - we've read all decompressed data
      } else {
        // Re-throw other errors
        this.emit("error", e);
      }
    } finally {
      this._readingDone = true;
      this._resolveReadingDone();
      // Signal end of readable side
      this.push(null);
    }
  }

  private _closeWriter(callback?: () => void): void {
    if (this.writeClosed) {
      this._readingDonePromise.then(() => {
        if (callback) {
          callback();
        }
      });
      return;
    }
    this.writeClosed = true;

    // Wait for pending writes to complete before closing
    const waitForWrites =
      this._pendingWrites > 0
        ? new Promise<void>(resolve => {
            this._writeFinishedPromise = new Promise(r => {
              this._resolveWriteFinished = r;
            });
            this._writeFinishedPromise.then(resolve);
          })
        : Promise.resolve();

    waitForWrites
      .then(() => this.writer.close())
      .catch(() => {})
      .finally(() => {
        this._readingDonePromise.then(() => {
          if (callback) {
            callback();
          }
        });
      });
  }

  override destroy(error?: Error | null): this {
    if (!this.writeClosed) {
      this.writer.abort(error ?? undefined).catch(() => {});
    }
    this.reader.cancel(error ?? undefined).catch(() => {});
    // Wake the reader-loop's backpressure waiter if any so `_startReading()`
    // can unwind cleanly instead of hanging on a never-resolved promise.
    const resolver = this._readPullResolver;
    if (resolver) {
      this._readPullResolver = null;
      resolver();
    }
    return super.destroy(error ?? undefined);
  }
}

// =============================================================================
// Worker-based InflateRaw (optional)
// =============================================================================

let _inflateWorkerUrl: string | null = null;

function getInflateWorkerUrl(customUrl?: string): string {
  if (typeof customUrl === "string" && customUrl.length > 0) {
    return customUrl;
  }
  if (_inflateWorkerUrl) {
    return _inflateWorkerUrl;
  }

  // Inline worker to avoid bundler-specific worker loaders.
  // It streams deflate-raw through DecompressionStream and posts decompressed chunks back.
  const code = `
let ds;
let writer;
let reader;
let junkError = false;
let pendingWrites = 0;

function isJunkErrorMessage(msg) {
  return typeof msg === 'string' && (msg.includes('Junk') || msg.includes('junk'));
}

async function ensureStarted() {
  if (ds) return;
  ds = new DecompressionStream('deflate-raw');
  writer = ds.writable.getWriter();
  reader = ds.readable.getReader();

  (async () => {
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        const chunk = r.value;
        postMessage({ t: 'data', chunk }, [chunk.buffer]);
      }
      postMessage({ t: 'end' });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (isJunkErrorMessage(msg)) {
        junkError = true;
        postMessage({ t: 'end' });
      } else {
        postMessage({ t: 'error', message: msg });
      }
    }
  })();
}

onmessage = async (ev) => {
  const msg = ev.data;
  try {
    await ensureStarted();
    if (msg.t === 'write') {
      if (junkError) {
        postMessage({ t: 'ack', id: msg.id });
        return;
      }
      pendingWrites++;
      await writer.write(msg.chunk);
      pendingWrites--;
      postMessage({ t: 'ack', id: msg.id });
      return;
    }
    if (msg.t === 'close') {
      // Wait for in-flight writes to finish (best-effort).
      while (pendingWrites > 0) {
        await new Promise(r => setTimeout(r, 0));
      }
      try { await writer.close(); } catch (_) {}
      postMessage({ t: 'closed' });
      return;
    }
    if (msg.t === 'abort') {
      try { await writer.abort(); } catch (_) {}
      postMessage({ t: 'aborted' });
      return;
    }
  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    postMessage({ t: 'error', message: m, id: msg && msg.id });
  }
};
`;

  const blob = new Blob([code], { type: "text/javascript" });
  _inflateWorkerUrl = URL.createObjectURL(blob);
  return _inflateWorkerUrl;
}

class WorkerInflateRaw extends Duplex {
  private readonly worker: Worker;
  private _nextId = 1;
  private _pendingAcks = new Map<number, (err?: Error | null) => void>();
  private _workerClosed = false;
  private _junkError = false;
  private _terminated = false;

  constructor(workerUrl?: string) {
    super({
      // Output is pushed as the worker replies, not on demand.
      read() {},
      write: (chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) => {
        this._doWrite(chunk, callback);
      },
      final: (callback: (error?: Error | null) => void) => {
        this._doClose(callback);
      }
    });

    const url = getInflateWorkerUrl(workerUrl);
    this.worker = new Worker(url);

    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as InflateWorkerMessage | null | undefined;
      if (!msg || typeof msg.t !== "string") {
        return;
      }

      if (msg.t === "data") {
        const chunk = msg.chunk;
        this.push(chunk);
        return;
      }

      if (msg.t === "end") {
        this.push(null);
        this._terminateWorker();
        return;
      }

      if (msg.t === "aborted") {
        this._terminateWorker();
        return;
      }

      if (msg.t === "ack") {
        const id = msg.id;
        const cb = this._pendingAcks.get(id);
        if (cb) {
          this._pendingAcks.delete(id);
          cb();
        }
        return;
      }

      if (msg.t === "error") {
        const message = typeof msg.message === "string" ? msg.message : "Worker inflate error";
        if (message.includes("Junk") || message.includes("junk")) {
          this._junkError = true;
          // Treat as end-of-stream.
          this.push(null);
          this._terminateWorker();
          // Resolve any pending writes.
          this._settlePendingAcks();
          return;
        }

        const err = new Error(message);
        // Fail any pending writes.
        this._settlePendingAcks(err);
        this.emit("error", err);
        this._terminateWorker();
        return;
      }
    };

    this.worker.onerror = (e: ErrorEvent) => {
      const err = new Error(e.message ?? "Worker error");
      this._settlePendingAcks(err);
      this.emit("error", err);
      this._terminateWorker();
    };
  }

  private _settlePendingAcks(err?: Error): void {
    if (this._pendingAcks.size === 0) {
      return;
    }

    for (const cb of this._pendingAcks.values()) {
      cb(err);
    }
    this._pendingAcks.clear();
  }

  private _terminateWorker(): void {
    if (this._terminated) {
      return;
    }
    this._terminated = true;
    try {
      this.worker.terminate();
    } catch {
      // ignore
    }
  }

  private _doWrite(chunk: Uint8Array, callback: (error?: Error | null) => void): void {
    if (this._workerClosed || this._junkError) {
      callback();
      return;
    }

    const id = this._nextId++;
    this._pendingAcks.set(id, callback);

    // Transfer the underlying ArrayBuffer to reduce copies.
    // If chunk is a view into a larger buffer, slice to avoid transferring unrelated bytes.
    const transferable =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk
        : chunk.slice();

    this.worker.postMessage({ t: "write", id, chunk: transferable }, [transferable.buffer]);
  }

  private _doClose(callback: (error?: Error | null) => void): void {
    if (this._workerClosed) {
      callback();
      return;
    }
    this._workerClosed = true;

    this.worker.postMessage({ t: "close" });
    callback();
  }

  override destroy(error?: Error | null): this {
    if (!this._workerClosed) {
      this._workerClosed = true;
      try {
        this.worker.postMessage({ t: "abort" });
      } catch {
        // ignore
      }
    }

    this._terminateWorker();

    return super.destroy(error ?? undefined);
  }
}

// =============================================================================
// Fallback InflateRaw for browsers without DecompressionStream
// =============================================================================

/**
 * Fallback Inflate that buffers all data, then decompresses at end.
 * Used for older browsers without native DecompressionStream support.
 */
class FallbackInflateRaw extends Duplex {
  private chunks: Uint8Array[] = [];
  private _finished = false;

  constructor() {
    super({
      write: (chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) => {
        if (this._finished) {
          callback(new Error("write after end"));
          return;
        }
        this.chunks.push(chunk);
        callback();
      },
      final: (callback: (error?: Error | null) => void) => {
        this._decompress(callback);
      }
    });
  }

  // Output is pushed when decompression completes, not on demand.
  override _read(): void {}

  private _decompress(callback: (error?: Error | null) => void): void {
    try {
      // Combine all chunks
      const data = concatUint8Arrays(this.chunks);

      // Decompress using fallback
      const decompressed = fallbackInflateRaw(data);
      this.push(decompressed);
      this.push(null);
      this._finished = true;
      callback();
    } catch (err) {
      callback(toError(err));
    }
  }

  override destroy(error?: Error | null): this {
    this._finished = true;
    this.chunks = [];
    return super.destroy(error ?? undefined);
  }
}

// =============================================================================
// Factory function with fallback
// =============================================================================

function createInflateRaw(): Duplex {
  if (hasDeflateRawDecompressionStream()) {
    return new BrowserInflateRaw();
  } else {
    return new FallbackInflateRaw();
  }
}

// =============================================================================
// Utilities
// =============================================================================

const dataDescriptorSignature = DATA_DESCRIPTOR_SIGNATURE_BYTES;

// =============================================================================
// Types
// =============================================================================

export type { CrxHeader, EntryProps, EntryVars, ParseOptions, ZipEntry };

export type ParseStream = Duplex & {
  promise(): Promise<void>;
} & PullStreamPublicApi & {
    crxHeader?: CrxHeader;
  };

export function createParseClass(createInflateRawFn: InflateFactory): {
  new (opts?: ParseOptions): ParseStream;
} {
  /**
   * ZIP Stream Parser for browsers.
   *
   * Extends Duplex to be compatible with stream.pipe(zip) pattern.
   * - Writable side: accepts ZIP data
   * - Readable side: emits ZipEntry objects
   */
  return class Parse extends Duplex {
    private _opts: ParseOptions;
    private readonly _buffer = new ByteQueue();
    cb?: () => void;
    finished = false;
    match?: number;
    private _pendingResolve?: () => void;
    private _pendingDataPromise?: Promise<void>;
    private _driverState: ParseDriverState = {};
    private _parsingDone: Promise<void> = Promise.resolve();

    // Writable-side backpressure (browser-only)
    private _writeCb?: (err?: Error | null) => void;
    private readonly _inputHighWaterMarkBytes: number;
    private readonly _inputLowWaterMarkBytes: number;

    crxHeader?: CrxHeader;
    __emittedError?: Error;

    // ---------------------------------------------------------------
    // Parser completion — explicit deferred, independent of stream
    // lifecycle events. Mirrors the Node.js Parse implementation.
    // ---------------------------------------------------------------
    private _parserDoneFlag = false;
    private _parserError: Error | null = null;
    private _parserDeferred: {
      resolve: () => void;
      reject: (err: Error) => void;
    } | null = null;
    private _parserDonePromise: Promise<void> | null = null;

    // ---------------------------------------------------------------
    // Entry queue — custom [Symbol.asyncIterator] reads from here.
    // ---------------------------------------------------------------
    private _entryQueue: ZipEntry[] = [];
    private _entryWaiter: {
      resolve: (result: IteratorResult<ZipEntry, undefined>) => void;
      reject: (err: unknown) => void;
    } | null = null;
    private _entriesDone = false;

    constructor(opts: ParseOptions = {}) {
      super({
        objectMode: true,
        // Entries are pushed by the parse loop, not on demand.
        read() {},
        write: (chunk: Uint8Array, _encoding: string, callback: (err?: Error | null) => void) => {
          this._handleWrite(chunk, callback);
        },
        final: (callback: (err?: Error | null) => void) => {
          this.finished = true;
          this._maybeReleaseWriteCallback();
          this._wakeUp();
          this.emit("data-available");
          this.emit("chunk", false);
          this._parsingDone.then(() => callback()).catch(callback);
        }
      });

      this._opts = opts;

      // Route error events to the parser deferred.
      this.on("error", (err: Error) => {
        this._rejectParserDeferred(err);
        this._closeEntryQueue(err);
      });

      // Default values are intentionally conservative to avoid memory spikes
      // when parsing large archives under slow consumers.
      const hi = Math.max(64 * 1024, opts.inputHighWaterMarkBytes ?? 2 * 1024 * 1024);
      const lo = Math.max(32 * 1024, opts.inputLowWaterMarkBytes ?? Math.floor(hi / 4));
      this._inputHighWaterMarkBytes = hi;
      this._inputLowWaterMarkBytes = Math.min(lo, hi);

      const io: ParseIO = {
        pull: (length: number) => this.pull(length),
        pullUntil: (pattern: Uint8Array, includeEof?: boolean) =>
          this.pullUntil(pattern, includeEof),
        stream: (length: number) => this.stream(length),
        streamUntilDataDescriptor: () => this._streamUntilDataDescriptor(),
        setDone: () => {
          this.push(null);
        }
      };

      const emitter: ParseEmitter = {
        emitEntry: (entry: ZipEntry) => {
          this.emit("entry", entry);
        },
        pushEntry: (entry: ZipEntry) => {
          this.push(entry);
          this._enqueueEntry(entry);
        },
        // Browser version historically only pushed entries when forceStream=true.
        // Keep this behavior to avoid changing stream piping semantics.
        pushEntryIfPiped: (_entry: ZipEntry) => {
          // Always feed the entry queue regardless of pipe state.
          this._enqueueEntry(_entry);
          return;
        },
        emitCrxHeader: (header: CrxHeader) => {
          this.crxHeader = header;
          this.emit("crx-header", header);
        },
        emitError: (err: Error) => {
          this.__emittedError = err;
          this.emit("error", err);
        },
        emitClose: () => {
          this.emit("close");
        }
      };

      queueMicrotask(() => {
        // NOTE: We intentionally do NOT pass inflateRawSync to runParseLoop in browser.
        // Browser's native DecompressionStream is faster than our pure-JS fallback,
        // so we always use the streaming path for decompression in browsers.
        const inflateFactory: InflateFactory = () => {
          if (this._opts.useWorkerInflate && typeof Worker !== "undefined") {
            // Worker path requires DecompressionStream support.
            if (hasDeflateRawDecompressionStream()) {
              try {
                return new WorkerInflateRaw(this._opts.workerInflateUrl);
              } catch {
                // If Worker construction fails (e.g. CSP/CORS), fall back.
                return createInflateRawFn();
              }
            }
          }
          return createInflateRawFn();
        };

        this._parsingDone = runParseLoop(
          this._opts,
          io,
          emitter,
          inflateFactory,
          this._driverState
          // No inflateRawSync - always use streaming DecompressionStream in browser
        );
        this._parsingDone.then(
          () => {
            if (this.__emittedError) {
              this._rejectParserDeferred(this.__emittedError);
              this._closeEntryQueue(this.__emittedError);
            } else {
              this._resolveParserDeferred();
              this._closeEntryQueue();
            }
          },
          (e: Error) => {
            if (!this.__emittedError || this.__emittedError !== e) {
              this.__emittedError = e;
              this.emit("error", e);
            }
            this._rejectParserDeferred(e);
            this._closeEntryQueue(e);
            this.emit("close");
          }
        );
      });
    }

    private _handleWrite(chunk: Uint8Array, callback: (err?: Error | null) => void): void {
      this._buffer.append(chunk);

      // Apply writable backpressure by deferring the callback when the input buffer is large.
      // The callback will be released once the parser drains the buffer.
      if (this._buffer.length >= this._inputHighWaterMarkBytes) {
        this._writeCb = callback;
      } else {
        callback();
      }

      this._wakeUp();
      this.emit("data-available");
      this.emit("chunk");
    }

    get buffer(): Uint8Array {
      return this._buffer.view();
    }

    set buffer(value: Uint8Array) {
      this._buffer.reset(value);
    }

    private _wakeUp(): void {
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = undefined;
        this._pendingDataPromise = undefined;
        resolve();
      }
    }

    private _maybeReleaseWriteCallback(): void {
      if (!this._writeCb) {
        return;
      }
      if (this._buffer.length > this._inputLowWaterMarkBytes) {
        return;
      }

      const cb = this._writeCb;
      this._writeCb = undefined;
      cb();
    }

    private _waitForData(): Promise<void> {
      if (this._pendingDataPromise) {
        return this._pendingDataPromise;
      }

      this._pendingDataPromise = new Promise(resolve => {
        this._pendingResolve = resolve;
      });
      return this._pendingDataPromise;
    }

    private async _pullInternal(length: number): Promise<Uint8Array> {
      if (length === 0) {
        return EMPTY_UINT8ARRAY;
      }

      let remaining = length;
      let firstChunk: Uint8Array | null = null;
      let chunks: Uint8Array[] | null = null;

      const appendChunk = (chunk: Uint8Array): void => {
        if (chunk.length === 0) {
          return;
        }

        if (!firstChunk) {
          firstChunk = chunk;
          return;
        }

        if (!chunks) {
          chunks = [firstChunk, chunk];
          return;
        }

        chunks.push(chunk);
      };

      while (remaining > 0) {
        while (this._buffer.length === 0) {
          if (this.finished) {
            throw new Error("FILE_ENDED");
          }
          await this._waitForData();
        }

        const toRead = Math.min(remaining, this._buffer.length);
        appendChunk(this._buffer.read(toRead));
        remaining -= toRead;

        if (this._buffer.length === 0) {
          this._maybeReleaseWriteCallback();
        }
      }

      this._maybeReleaseWriteCallback();
      if (!firstChunk) {
        return EMPTY_UINT8ARRAY;
      }
      return chunks ? concatUint8Arrays(chunks) : firstChunk;
    }

    private async _pullUntilInternal(pattern: Uint8Array, includeEof = false): Promise<Uint8Array> {
      let firstChunk: Uint8Array | null = null;
      let chunks: Uint8Array[] | null = null;
      const scanner = new PatternScanner(pattern);
      const patternLen = pattern.length;

      const appendChunk = (chunk: Uint8Array): void => {
        if (chunk.length === 0) {
          return;
        }

        if (!firstChunk) {
          firstChunk = chunk;
          return;
        }

        if (!chunks) {
          chunks = [firstChunk, chunk];
          return;
        }

        chunks.push(chunk);
      };

      while (true) {
        const bufLen = this._buffer.length;
        const match = scanner.find(this._buffer);

        if (match !== -1) {
          this.match = match;
          const toRead = match + (includeEof ? patternLen : 0);
          if (toRead > 0) {
            appendChunk(this._buffer.read(toRead));
            this._maybeReleaseWriteCallback();
          }
          if (!firstChunk) {
            return EMPTY_UINT8ARRAY;
          }
          return chunks ? concatUint8Arrays(chunks) : firstChunk;
        }

        // No match yet. Avoid rescanning bytes that can't start a match.
        scanner.onNoMatch(bufLen);

        if (this.finished) {
          throw new Error("FILE_ENDED");
        }

        const safeLen = this._buffer.length - patternLen;
        if (safeLen > 0) {
          appendChunk(this._buffer.read(safeLen));
          scanner.onConsume(safeLen);
          this._maybeReleaseWriteCallback();
        }

        await this._waitForData();
      }
    }

    private _streamFixedLength(length: number): PassThrough {
      const output = new PassThrough({ highWaterMark: DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK });
      let remaining = length;
      let done = false;
      let waitingDrain = false;

      const onDrain = (): void => {
        waitingDrain = false;
        pull();
      };

      const pull = (): void => {
        if (done) {
          return;
        }

        if (waitingDrain) {
          return;
        }

        while (remaining > 0 && this._buffer.length > 0) {
          const toRead = Math.min(remaining, this._buffer.length);
          const chunk = this._buffer.read(toRead);
          remaining -= toRead;
          const ok = output.write(chunk);
          this._maybeReleaseWriteCallback();
          if (!ok) {
            waitingDrain = true;
            output.once("drain", onDrain);
            return;
          }
        }

        if (remaining === 0) {
          done = true;
          this.removeListener("data-available", pull);
          output.end();
        } else if (this.finished) {
          done = true;
          this.removeListener("data-available", pull);
          output.destroy(new Error("FILE_ENDED"));
        }
      };

      this.on("data-available", pull);
      queueMicrotask(() => pull());
      return output;
    }

    private _streamUntilPattern(pattern: Uint8Array, includeEof = false): PassThrough {
      const output = new PassThrough({ highWaterMark: DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK });
      let done = false;
      const patternLen = pattern.length;
      const scanner = new PatternScanner(pattern);
      let waitingDrain = false;

      const onDrain = (): void => {
        waitingDrain = false;
        pull();
      };

      const pull = (): void => {
        if (done || waitingDrain) {
          return;
        }

        while (true) {
          if (this._buffer.length <= 0) {
            break;
          }

          const bufLen = this._buffer.length;
          const match = scanner.find(this._buffer);

          if (match !== -1) {
            this.match = match;
            const endIndex = includeEof ? match + patternLen : match;
            if (endIndex > 0) {
              const ok = output.write(this._buffer.read(endIndex));
              scanner.onConsume(endIndex);
              this._maybeReleaseWriteCallback();
              if (!ok) {
                waitingDrain = true;
                output.once("drain", onDrain);
                return;
              }
            }
            done = true;
            this.removeListener("data-available", pull);
            output.end();
            return;
          }

          // No match yet. Avoid rescanning bytes that can't start a match.
          scanner.onNoMatch(bufLen);

          if (this.finished) {
            done = true;
            this.removeListener("data-available", pull);
            output.destroy(new Error("FILE_ENDED"));
            return;
          }

          const safeLen = bufLen - patternLen;
          if (safeLen <= 0) {
            // Keep enough bytes to detect a split signature.
            if (this._buffer.length <= patternLen) {
              this._maybeReleaseWriteCallback();
            }
            break;
          }

          const ok = output.write(this._buffer.read(safeLen));
          scanner.onConsume(safeLen);
          this._maybeReleaseWriteCallback();

          if (!ok) {
            waitingDrain = true;
            output.once("drain", onDrain);
            return;
          }
        }
      };

      this.on("data-available", pull);
      queueMicrotask(() => pull());
      return output;
    }

    stream(eof: number | Uint8Array, includeEof?: boolean): PassThrough {
      if (typeof eof === "number") {
        return this._streamFixedLength(eof);
      }
      return this._streamUntilPattern(eof, includeEof ?? false);
    }

    pull(eof: number | Uint8Array, includeEof?: boolean): Promise<Uint8Array> {
      if (eof === 0) {
        return Promise.resolve(EMPTY_UINT8ARRAY);
      }

      if (typeof eof === "number") {
        // Node-compatible behavior: if finished and not enough bytes, reject.
        if (this.finished && this._buffer.length < eof) {
          return Promise.reject(new Error("FILE_ENDED"));
        }
        if (this._buffer.length >= eof) {
          const out = this._buffer.read(eof);
          this._maybeReleaseWriteCallback();
          return Promise.resolve(out);
        }
        return this._pullInternal(eof);
      }

      // Pattern mode
      if (this.finished) {
        return Promise.reject(new Error("FILE_ENDED"));
      }
      return this._pullUntilInternal(eof, includeEof ?? false);
    }

    pullUntil(pattern: Uint8Array, includeEof?: boolean): Promise<Uint8Array> {
      return this.pull(pattern, includeEof);
    }

    private _streamUntilDataDescriptor(): PassThrough {
      return streamUntilValidatedDataDescriptor({
        source: {
          getLength: () => this._buffer.length,
          read: (length: number) => this._buffer.read(length),
          peekChunks: (length: number) => this._buffer.peekChunks(length),
          discard: (length: number) => this._buffer.discard(length),
          indexOfPattern: (pattern: Uint8Array, startIndex: number) =>
            this._buffer.indexOfPattern(pattern, startIndex),
          peekUint32LE: (offset: number) => this._buffer.peekUint32LE(offset),
          isFinished: () => this.finished,
          onDataAvailable: (cb: () => void) => {
            this.on("data-available", cb);
            return () => this.removeListener("data-available", cb);
          },
          maybeReleaseWriteCallback: () => this._maybeReleaseWriteCallback()
        },
        dataDescriptorSignature
      });
    }

    promise(): Promise<void> {
      if (this._parserDoneFlag) {
        return this._parserError ? Promise.reject(this._parserError) : Promise.resolve();
      }

      if (this._parserDonePromise) {
        return this._parserDonePromise;
      }

      this._parserDonePromise = new Promise<void>((resolve, reject) => {
        this._parserDeferred = { resolve, reject };
      });
      return this._parserDonePromise;
    }

    // ---------------------------------------------------------------
    // Parser completion deferred
    // ---------------------------------------------------------------

    private _resolveParserDeferred(): void {
      if (this._parserDoneFlag) {
        return;
      }
      this._parserDoneFlag = true;
      if (this._parserDeferred) {
        const { resolve } = this._parserDeferred;
        this._parserDeferred = null;
        resolve();
      }
    }

    private _rejectParserDeferred(err: Error): void {
      if (this._parserDoneFlag) {
        return;
      }
      this._parserDoneFlag = true;
      this._parserError = err;
      if (this._parserDeferred) {
        const { reject } = this._parserDeferred;
        this._parserDeferred = null;
        reject(err);
      }
    }

    // ---------------------------------------------------------------
    // Entry queue management
    // ---------------------------------------------------------------

    private _enqueueEntry(entry: ZipEntry): void {
      if (this._entryWaiter) {
        const { resolve } = this._entryWaiter;
        this._entryWaiter = null;
        resolve({ value: entry, done: false });
      } else {
        this._entryQueue.push(entry);
      }
    }

    private _closeEntryQueue(err?: Error): void {
      this._entriesDone = true;

      if (this._entryWaiter) {
        const waiter = this._entryWaiter;
        this._entryWaiter = null;
        if (err) {
          waiter.reject(err);
        } else {
          waiter.resolve({ value: undefined, done: true });
        }
      }
    }

    // ---------------------------------------------------------------
    // Custom async iterator
    // ---------------------------------------------------------------

    override [Symbol.asyncIterator](): DisposableEntryIterator {
      const iterator: DisposableEntryIterator = {
        next: (): Promise<IteratorResult<ZipEntry, undefined>> => {
          if (this._entryQueue.length > 0) {
            return Promise.resolve({ value: this._entryQueue.shift()!, done: false });
          }

          if (this._entriesDone) {
            if (this._parserError) {
              return Promise.reject(this._parserError);
            }
            return Promise.resolve({ value: undefined, done: true });
          }

          return new Promise<IteratorResult<ZipEntry, undefined>>((resolve, reject) => {
            this._entryWaiter = { resolve, reject };
          });
        },

        return: (): Promise<IteratorResult<ZipEntry, undefined>> => {
          this._entriesDone = true;
          this._entryQueue.length = 0;
          this._entryWaiter = null;
          return Promise.resolve({ value: undefined, done: true });
        },

        async [Symbol.asyncDispose](): Promise<void> {
          await iterator.return?.();
        },

        [Symbol.asyncIterator]() {
          return iterator;
        }
      };

      return iterator;
    }
  };
}

const BaseParse = /* @__PURE__ */ createParseClass(createInflateRaw);

export class Parse extends BaseParse {}

export function createParse(opts?: ParseOptions): ParseStream {
  return new Parse(opts);
}
