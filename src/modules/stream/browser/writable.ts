/**
 * Browser Stream - Writable
 */

import { deferTask, inDeferredContext } from "@stream/browser/microtask-context";
import { Readable } from "@stream/browser/readable";
import { stringToEncodedBytes } from "@stream/core/binary-chunk";
import { parseEndArgs } from "@stream/core/end-args";
import { getDefaultHighWaterMark } from "@stream/core/utils";
import { StreamStateError } from "@stream/errors";
import type { WritableStreamOptions, WritableLike } from "@stream/types";
import { decodeBytesToString } from "@utils/binary";
import { createAbortError } from "@utils/errors";
import { EventEmitter } from "@utils/event-emitter";

/**
 * Shared toString implementation for Uint8Array chunks converted from strings.
 * Uses `this`-binding to avoid per-chunk closure allocation.
 * Supports all Node.js Buffer encodings (hex, base64, base64url, ascii, etc.).
 */
function encodedBytesToString(this: Uint8Array, enc?: string): string {
  return decodeBytesToString(this, enc ?? "utf-8");
}

// =============================================================================
// Writable Stream Wrapper
// =============================================================================

/**
 * Extended Writable options that match Node.js API
 */
export interface WritableOptions<T = Uint8Array> extends WritableStreamOptions {
  stream?: WritableStream<T>;
  autoDestroy?: boolean;
  emitClose?: boolean;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  signal?: AbortSignal;
  write?: (
    this: Writable<T>,
    chunk: T,
    encoding: string,
    callback: (error?: Error | null) => void
  ) => void;
  final?: (this: Writable<T>, callback: (error?: Error | null) => void) => void;
  destroy?: (
    this: Writable<T>,
    error: Error | null,
    callback: (error?: Error | null) => void
  ) => void;
  construct?: (this: Writable<T>, callback: (error?: Error | null) => void) => void;
  writev?: (
    this: Writable<T>,
    chunks: Array<{ chunk: T; encoding: string }>,
    callback: (error?: Error | null) => void
  ) => void;
}

/**
 * A wrapper around Web WritableStream that provides Node.js-like API
 */
export class Writable<T = Uint8Array> extends EventEmitter {
  /**
   * Allow duck-typed instanceof checks.
   * Node.js Duplex passes `instanceof Writable` via Symbol.hasInstance.
   * Our browser Duplex composes a Writable, so we use Symbol.hasInstance
   * to check for key Writable-like methods/properties.
   */
  static [Symbol.hasInstance](instance: unknown): boolean {
    if (instance == null || typeof instance !== "object") {
      return false;
    }
    // Fast path: actual Writable prototype
    if (Object.prototype.isPrototypeOf.call(Writable.prototype, instance)) {
      return true;
    }
    // Duck-type: must have key Writable methods and the stream brand
    const o = instance as Record<string, unknown>;
    return (
      o.__documonster_stream === true &&
      typeof o.write === "function" &&
      typeof o.end === "function" &&
      typeof o.on === "function" &&
      "writableFinished" in instance
    );
  }

  private _stream: WritableStream<T> | null = null;
  private _writer: WritableStreamDefaultWriter<T> | null = null;
  private _ended: boolean = false;
  private _finished: boolean = false;
  /** @internal Set by Transform._scheduleEnd to allow _doFinish to emit synchronously */
  _syncFinish: boolean = false;
  private _destroyed: boolean = false;
  private _errored: Error | null = null;
  private _errorEmitted: boolean = false;
  private _closed: boolean = false;
  private _writableLength: number = 0;
  private _needDrain: boolean = false;
  private _corked: number = 0;
  private _corkedChunks: Array<{
    chunk: T;
    encoding: string;
    callback?: (error?: Error | null) => void;
  }> = [];
  private _defaultEncoding: string = "utf8";
  private _ownsStream: boolean = false;
  /** When true, _doWrite calls _writeFunc directly (no Web WritableStream). */
  private _directWrite: boolean = false;
  /**
   * Write queue for direct-write mode.  When a _writeFunc callback is pending
   * (async), subsequent writes are buffered here and drained one-at-a-time,
   * matching Node.js Writable semantics.
   */
  private _writeQueue: Array<{
    chunk: T;
    chunkSize: number;
    encoding: string;
    callback?: (error?: Error | null) => void;
  }> = [];
  /** Whether a _writeFunc call is currently in-flight (callback not yet invoked). */
  private _writing: boolean = false;
  /** Pending end() operation waiting for the write queue to drain. */
  private _pendingEnd: { cb?: () => void } | null = null;
  // User-provided write function (Node.js compatibility)
  private _writeFunc?: (
    chunk: T,
    encoding: string,
    callback: (error?: Error | null) => void
  ) => void;
  // User-provided final function (Node.js compatibility)
  private _finalFunc?: (callback: (error?: Error | null) => void) => void;
  private _objectMode: boolean;
  private _highWaterMark: number;
  private _autoDestroy: boolean;
  private _emitClose: boolean;
  // User-provided construct function (Node.js compatibility)
  private _constructFunc?: (callback: (error?: Error | null) => void) => void;
  private _constructed: boolean = true;
  // User-provided writev function (batch write, Node.js compatibility)
  private _writevFunc?: (
    chunks: Array<{ chunk: T; encoding: string }>,
    callback: (error?: Error | null) => void
  ) => void;
  /** Resolved writev function (from options, subclass, or null). Cached at construction. */
  private _resolvedWritev:
    | ((
        chunks: Array<{ chunk: T; encoding: string }>,
        callback: (error?: Error | null) => void
      ) => void)
    | null = null;
  private _decodeStrings: boolean;

  /**
   * Optional lifecycle hooks a subclass may define (Node.js convention). The
   * base class does not implement them as own methods; they only exist when a
   * subclass (or a constructor option) provides them, which the guards before
   * each call site verify.
   * @internal
   */
  _write?(chunk: T, encoding: string, callback: (error?: Error | null) => void): void;
  /** @internal */
  _construct?(callback: (error?: Error | null) => void): void;

  constructor(options?: WritableOptions<T>) {
    super();
    this._objectMode = options?.objectMode ?? false;
    this._highWaterMark = options?.highWaterMark ?? getDefaultHighWaterMark(this._objectMode);
    this._autoDestroy = options?.autoDestroy ?? true;
    this._emitClose = options?.emitClose ?? true;
    this._decodeStrings = options?.decodeStrings ?? true;
    this._defaultEncoding = options?.defaultEncoding ?? "utf8";

    if (options?.stream) {
      // Wrapping an existing Web WritableStream: proxy writes to the underlying
      // stream and ignore user-provided write/final/destroy/construct/writev
      // hooks (matching Node.js behavior where the {stream} option creates a
      // transparent proxy with its own write/final handlers).
      this._stream = options.stream;
      this._ownsStream = false;
      this._directWrite = false;
    } else {
      // Store user-provided write function
      if (options?.write) {
        this._writeFunc = options.write.bind(this);
      }
      // Store user-provided final function (option takes precedence over prototype)
      if (options?.final) {
        this._finalFunc = options.final.bind(this);
      } else {
        // Node.js: detect subclass _final on the prototype chain, matching
        // the pattern used for _write / _writev detection.
        const subclassFinal = this._getSubclassFinal();
        if (subclassFinal) {
          this._finalFunc = subclassFinal;
        }
      }

      // Store user-provided destroy function
      if (options?.destroy) {
        this._destroy = options.destroy.bind(this);
      }

      // Store user-provided construct function
      if (options?.construct) {
        this._constructFunc = options.construct.bind(this);
      }

      // Store user-provided writev function
      if (options?.writev) {
        this._writevFunc = options.writev.bind(this);
      }

      this._ownsStream = true;

      // When we own the stream AND have a user-provided _writeFunc, we bypass
      // Web WritableStream entirely and call _writeFunc directly with a
      // Node.js-style write queue.  This ensures:
      //  - Synchronous callbacks execute synchronously (fixes cork/uncork, write-during-data)
      //  - Async callbacks are properly serialized (fixes Transform async pipeline)
      //  - end()/final waits for all in-flight writes (fixes premature end)
      if (this._writeFunc) {
        this._directWrite = true;
        this._stream = null;
      } else {
        // Check if this is a subclass with _construct — if so, we need direct-write
        // mode to properly gate writes until construction completes. Detect subclass
        // _write on the prototype and wrap it as _writeFunc.
        const hasConstruct = options?.construct || this._hasSubclassConstruct();
        const subclassWrite = this._getSubclassWrite();
        if (hasConstruct && subclassWrite) {
          this._writeFunc = subclassWrite;
          this._directWrite = true;
          this._stream = null;
        } else {
          this._directWrite = false;
          this._stream = new WritableStream<T>({
            write: async chunk => {
              // Subclass _write path (no user-provided _writeFunc)
              if (this._write) {
                await new Promise<void>((resolve, reject) => {
                  this._write!(chunk, "utf8", (err?: Error | null) => {
                    if (err) {
                      reject(err);
                    } else {
                      resolve();
                    }
                  });
                });
              }
            },
            close: async () => {
              // Node.js: _final is called before finish is emitted.
              // When using the Web WritableStream path (no direct-write mode),
              // we must still honour a subclass _final if it was detected.
              if (this._finalFunc) {
                const finalErr = await new Promise<Error | null>(resolve => {
                  this._finalFunc!((err?: Error | null) => {
                    resolve(err ?? null);
                  });
                });
                if (finalErr) {
                  // Node.js: _final error → emit error, do NOT emit finish.
                  this._errored = finalErr;
                  this._errorEmitted = true;
                  this.emit("error", finalErr);
                  if (this._autoDestroy) {
                    this.destroy(finalErr);
                  }
                  return;
                }
              }
              this._finished = true;
              this.emit("finish");
              if (this._autoDestroy) {
                this.destroy();
              }
            },
            abort: reason => {
              this.emit("error", reason);
            }
          });
        }
      }
    }

    // M1: signal constructor option — destroy stream when signal aborts
    if (options?.signal) {
      this._setupAbortSignal(options.signal);
    }

    // Cache resolved writev at construction time to avoid prototype walk per drain
    this._resolvedWritev = this._writevFunc ?? this._getWritevHook();

    // L2: _construct hook — if provided, delay writes until constructed
    this._maybeConstruct();
  }

  /**
   * Run _construct if provided (via options or subclass override).
   * Delays write operations until the callback fires.
   */
  private _maybeConstruct(): void {
    const hasConstructHook = this._constructFunc || this._hasSubclassConstruct();
    if (!hasConstructHook) {
      return;
    }
    this._constructed = false;
    deferTask(() => {
      const fn = this._constructFunc ?? this._construct!.bind(this);
      fn(err => {
        if (err) {
          this.destroy(err);
          return;
        }
        this._constructed = true;
        // Drain any writes that were queued while not yet constructed
        if (this._directWrite && this._writeQueue.length > 0 && !this._writing) {
          this._writing = true;
          this._drainWriteQueue();
        } else if (this._pendingEnd && !this._writing) {
          // If end() was called during construct with no queued writes
          const { cb } = this._pendingEnd;
          this._pendingEnd = null;
          this._doFinish(cb);
        }
      });
    });
  }

  /**
   * Check if a subclass defines _construct on its own prototype.
   * Node.js does NOT have _construct on any stream prototype — it only exists
   * when provided via constructor options or defined by a subclass.
   */
  private _hasSubclassConstruct(): boolean {
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== Writable.prototype && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, "_construct")) {
        return true;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  }

  /**
   * Detect subclass _write on the prototype and return a bound function.
   * Returns null if no subclass _write is found.
   */
  private _getSubclassWrite():
    | ((chunk: T, encoding: string, callback: (error?: Error | null) => void) => void)
    | null {
    let proto: object = Object.getPrototypeOf(this);
    while (proto && proto !== Writable.prototype && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, "_write")) {
        return (
          (proto as Record<string, unknown>)._write as (
            chunk: T,
            encoding: string,
            callback: (error?: Error | null) => void
          ) => void
        ).bind(this);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  /**
   * Detect subclass _final on the prototype and return a bound function.
   * Returns null if no subclass _final is found.
   * Matches Node.js behavior where a subclass can define _final() on its
   * prototype and have it called during the end() sequence.
   */
  private _getSubclassFinal(): ((callback: (error?: Error | null) => void) => void) | null {
    let proto: object = Object.getPrototypeOf(this);
    while (proto && proto !== Writable.prototype && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, "_final")) {
        return (
          (proto as Record<string, unknown>)._final as (
            callback: (error?: Error | null) => void
          ) => void
        ).bind(this);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  /**
   * Base writev method - can be overridden by subclasses for batch writing.
   * If overridden, called instead of individual _write for corked chunks.
   * Value is `null` on the prototype (matches Node.js Writable.prototype._writev === null).
   * Assigned via prototype after the class definition.
   */
  declare _writev:
    | ((
        chunks: Array<{ chunk: T; encoding: string }>,
        callback: (error?: Error | null) => void
      ) => void)
    | null;

  /** Detect subclass _writev override or option-provided writev. */
  private _getWritevHook():
    | ((
        chunks: Array<{ chunk: T; encoding: string }>,
        callback: (error?: Error | null) => void
      ) => void)
    | null {
    const proto = Object.getPrototypeOf(this);
    if (proto._writev && proto._writev !== Writable.prototype._writev) {
      return proto._writev.bind(this);
    }
    return null;
  }

  /**
   * Wire up an AbortSignal to destroy this stream on abort.
   */
  private _setupAbortSignal(signal: AbortSignal): void {
    if (signal.aborted) {
      this.destroy(createAbortError(signal.reason));
      return;
    }

    const onAbort = (): void => {
      cleanup();
      this.destroy(createAbortError(signal.reason));
    };

    const onDone = (): void => {
      cleanup();
    };

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      this.off("close", onDone);
      this.off("finish", onDone);
      this.off("error", onDone);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    this.on("close", onDone);
    this.on("finish", onDone);
    this.on("error", onDone);
  }

  /**
   * Set default encoding for string writes
   */
  setDefaultEncoding(encoding: string): this {
    // Validate encoding (Node.js throws ERR_UNKNOWN_ENCODING)
    stringToEncodedBytes("", encoding);
    this._defaultEncoding = encoding;
    return this;
  }

  /**
   * Buffer writes until uncork() is called
   */
  cork(): void {
    this._corked++;
  }

  /**
   * Flush buffered writes from cork()
   */
  uncork(): void {
    if (this._corked > 0) {
      this._corked--;
    }

    if (this._corked === 0) {
      const chunks = this._corkedChunks;
      this._corkedChunks = [];

      if (chunks.length === 0) {
        return;
      }

      // Reset _writableLength for corked chunks first — _doWrite will re-add
      // each chunk's size, so we must subtract the corked total to avoid
      // double-counting (write() already added the size when buffering).
      for (const { chunk } of chunks) {
        this._writableLength -= this._getChunkSize(chunk);
      }

      // L3: If _writev is available and there are multiple chunks, batch them
      const writevFn = this._resolvedWritev;
      if (writevFn && chunks.length > 1) {
        const batchChunks = chunks.map(({ chunk, encoding }) => ({ chunk, encoding }));
        const totalSize = batchChunks.reduce(
          (sum, { chunk }) => sum + this._getChunkSize(chunk),
          0
        );
        this._writableLength += totalSize;
        this._writing = true;

        try {
          writevFn(batchChunks, err => {
            this._writableLength -= totalSize;
            this._writing = false;

            if (err) {
              if (!this._destroyed) {
                this._errored = err;
                this.emit("error", err);
                if (this._autoDestroy) {
                  this.destroy(err);
                }
              }
              // Call individual callbacks with error
              for (const { callback } of chunks) {
                callback?.(err);
              }
              return;
            }

            if (this._needDrain && this._writableLength < this._highWaterMark) {
              this._needDrain = false;
              deferTask(() => this.emit("drain"));
            }

            // Call individual callbacks with success
            for (const { callback } of chunks) {
              callback?.(null);
            }

            // Drain any remaining queued writes or finalize
            this._drainWriteQueue();
          });
        } catch (err) {
          this._writableLength -= totalSize;
          this._writing = false;
          const error = err instanceof Error ? err : new Error(String(err));
          if (!this._destroyed) {
            this._errored = error;
            this.emit("error", error);
            if (this._autoDestroy) {
              this.destroy(error);
            }
          }
          for (const { callback } of chunks) {
            callback?.(error);
          }
        }
      } else {
        // No _writev or single chunk — flush one at a time
        for (const { chunk, encoding, callback } of chunks) {
          this._doWrite(chunk, encoding, callback);
        }
      }
    }
  }

  /**
   * Write data to the stream
   */
  write(chunk: T, callback?: (error?: Error | null) => void): boolean;
  write(chunk: T, encoding?: string, callback?: (error?: Error | null) => void): boolean;
  write(
    chunk: T,
    encodingOrCallback?: string | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    // Node.js: writing null is always an error (even in object mode).
    // Node.js throws this synchronously and does NOT emit an error event.
    if (chunk === null) {
      const err = new TypeError("May not write null values to stream") as TypeError & {
        code: string;
      };
      err.code = "ERR_STREAM_NULL_VALUES";
      throw err;
    }

    if (this._destroyed || this._ended) {
      // Node.js distinguishes write-after-destroy (ERR_STREAM_DESTROYED) from
      // write-after-end (ERR_STREAM_WRITE_AFTER_END).
      const isDestroyed = this._destroyed && !this._ended;
      const err = new Error(
        isDestroyed ? "Cannot call write after a stream was destroyed" : "write after end"
      ) as Error & { code: string };
      err.code = isDestroyed ? "ERR_STREAM_DESTROYED" : "ERR_STREAM_WRITE_AFTER_END";
      const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      // Node.js: set errored synchronously on write-after-end
      if (!this._errored) {
        this._errored = err;
      }
      // Node.js: callback is deferred via process.nextTick, not called synchronously.
      // The callback fires BEFORE the error event (both deferred).
      if (cb) {
        deferTask(() => cb(err));
      }
      // Node.js: only emit 'error' for write-after-end when NOT destroyed,
      // and only emit once. Setting _errorEmitted here is intentional — a stream
      // should only ever emit one 'error' event (including from later destroy()).
      if (!this._destroyed && !this._errorEmitted) {
        this._errorEmitted = true;
        deferTask(() => this.emit("error", err));
      }
      return false;
    }

    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : this._defaultEncoding;
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;

    // If corked, buffer the write
    if (this._corked > 0) {
      const normalized = this._normalizeWriteChunk(chunk, encoding);
      this._corkedChunks.push({
        chunk: normalized.chunk,
        encoding: normalized.encoding,
        callback: cb
      });
      const chunkSize = this._getChunkSize(normalized.chunk, normalized.encoding);
      this._writableLength += chunkSize;
      const ok = this._writableLength < this._highWaterMark;
      if (!ok) {
        this._needDrain = true;
      }
      return ok;
    }

    const normalized = this._normalizeWriteChunk(chunk, encoding);
    const ok = this._doWrite(normalized.chunk, normalized.encoding, cb);
    if (!ok) {
      this._needDrain = true;
    }
    return ok;
  }

  private _doWrite(chunk: T, encoding: string, callback?: (error?: Error | null) => void): boolean {
    const chunkSize = this._getChunkSize(chunk, encoding);
    this._writableLength += chunkSize;

    if (this._directWrite) {
      // Direct-write path: call _writeFunc directly, with Node.js-style
      // serialization — only one _writeFunc is in-flight at a time.
      // Also queue if _construct has not yet completed.
      if (this._writing || !this._constructed) {
        // Queue the write for later — will be drained when the current
        // _writeFunc callback fires or when _construct completes.
        this._writeQueue.push({ chunk, chunkSize, encoding, callback });
      } else {
        this._writing = true;
        this._callWriteFunc(chunk, chunkSize, encoding, callback);
      }
    } else {
      // Async path: use Web WritableStream (external stream or subclass _write)
      const writer = this._getWriter();
      writer
        .write(chunk)
        .then(() => {
          this._writableLength -= chunkSize;
          if (this._needDrain && this._writableLength < this._highWaterMark) {
            this._needDrain = false;
            deferTask(() => this.emit("drain"));
          }
          callback?.(null);
        })
        .catch(err => {
          this._writableLength -= chunkSize;
          if (!this._destroyed) {
            this._errored = err;
            this._errorEmitted = true;
            this.emit("error", err);
            if (this._autoDestroy) {
              this.destroy(err);
            }
          }
          callback?.(err);
        });
    }

    // Return false if we've exceeded high water mark (for backpressure)
    return this._writableLength < this._highWaterMark;
  }

  /**
   * Call _writeFunc for a single chunk. When the callback fires (sync or async),
   * drain the next entry from _writeQueue, or run the pending end() if the
   * queue is empty.
   */
  private _callWriteFunc(
    chunk: T,
    chunkSize: number,
    encoding: string,
    callback?: (error?: Error | null) => void
  ): void {
    try {
      // Node.js passes undefined as encoding in objectMode
      const enc = this._objectMode ? (undefined as unknown as string) : encoding;
      // Guard against user code calling the callback more than once.
      // Node.js has a similar guard in `onwrite()` (lib/internal/streams/writable.js).
      let cbCalled = false;
      // Track whether the callback is invoked synchronously (before _writeFunc
      // returns).  Node.js defers error emission and the write callback via
      // process.nextTick when the callback fires synchronously; when it fires
      // asynchronously (e.g. in a setTimeout / Promise callback), the error
      // and callback execute synchronously in that async context.
      let sync = true;
      this._writeFunc!(chunk, enc, err => {
        if (cbCalled) {
          // Node.js throws ERR_MULTIPLE_CALLBACK on double invocation.
          const multiErr = new Error("Callback called multiple times") as Error & { code: string };
          multiErr.code = "ERR_MULTIPLE_CALLBACK";
          this.destroy(multiErr);
          return;
        }
        cbCalled = true;

        if (err) {
          this._writableLength -= chunkSize;
          if (!this._destroyed) {
            this._errored = err;
            this._errorEmitted = true;
            if (sync) {
              // Node.js: synchronous callback → defer both callback and error
              // via process.nextTick.  Callback fires first, then error event.
              deferTask(() => {
                callback?.(err);
                this.emit("error", err);
                if (this._autoDestroy) {
                  this.destroy(err);
                }
              });
            } else {
              // Async callback → execute synchronously (matches Node.js).
              callback?.(err);
              this.emit("error", err);
              if (this._autoDestroy) {
                this.destroy(err);
              }
            }
          } else {
            callback?.(err);
          }
          // On error, drain remaining queued writes with the error and
          // don't process pending end.
          this._writing = false;
          this._flushWriteQueueOnError(err);
          // If end() was called and destroy() didn't already claim _pendingEnd
          // (e.g. autoDestroy is false), notify the end() callback of the error.
          if (this._pendingEnd) {
            const { cb: endCb } = this._pendingEnd;
            this._pendingEnd = null;
            (endCb as (err?: Error) => void)?.(err);
          }
          return;
        }

        this._writableLength -= chunkSize;
        if (this._needDrain && this._writableLength < this._highWaterMark) {
          this._needDrain = false;
          deferTask(() => this.emit("drain"));
        }
        callback?.(null);

        // Drain next queued write, or finalize if end() is pending.
        this._drainWriteQueue();
      });
      sync = false;
    } catch (err) {
      this._writableLength -= chunkSize;
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this._destroyed) {
        this._errored = error;
        this.emit("error", error);
        if (this._autoDestroy) {
          this.destroy(error);
        }
      }
      callback?.(error);
      this._writing = false;
      this._flushWriteQueueOnError(error);
      // If end() was called and destroy() didn't already claim _pendingEnd,
      // notify the end() callback of the error.
      if (this._pendingEnd) {
        const { cb: endCb } = this._pendingEnd;
        this._pendingEnd = null;
        (endCb as (err?: Error) => void)?.(error);
      }
    }
  }

  /** Process the next queued write, or run pending end(). */
  private _drainWriteQueue(): void {
    if (this._writeQueue.length === 0) {
      this._writing = false;
      // If end() was called while writes were in-flight, finalize now.
      if (this._pendingEnd) {
        const { cb } = this._pendingEnd;
        this._pendingEnd = null;
        this._doFinish(cb);
      }
      return;
    }

    // If _writev is available and there are multiple queued chunks, batch them.
    // This matches Node.js behavior where _writev is used for naturally-queued
    // writes, not just on uncork.
    const writevFn = this._resolvedWritev;
    if (writevFn && this._writeQueue.length > 1) {
      // Swap array instead of splice(0) to avoid O(n) copy
      const chunks = this._writeQueue;
      this._writeQueue = [];
      let totalSize = 0;
      const batchChunks = new Array<{ chunk: T; encoding: string }>(chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        const entry = chunks[i]!;
        batchChunks[i] = { chunk: entry.chunk, encoding: entry.encoding };
        totalSize += entry.chunkSize;
      }

      try {
        writevFn(batchChunks, err => {
          if (err) {
            this._writableLength -= totalSize;
            if (!this._destroyed) {
              this._errored = err;
              this._errorEmitted = true;
              this.emit("error", err);
            }
            for (const entry of chunks) {
              entry.callback?.(err);
            }
            this._writing = false;
            this._flushWriteQueueOnError(err);
            return;
          }

          this._writableLength -= totalSize;
          if (this._needDrain && this._writableLength < this._highWaterMark) {
            this._needDrain = false;
            deferTask(() => this.emit("drain"));
          }
          for (const entry of chunks) {
            entry.callback?.(null);
          }

          // Continue draining (more writes may have arrived during _writev)
          this._drainWriteQueue();
        });
      } catch (err) {
        this._writableLength -= totalSize;
        this._writing = false;
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this._destroyed) {
          this._errored = error;
          this.emit("error", error);
        }
        for (const entry of chunks) {
          entry.callback?.(error);
        }
      }
    } else {
      // Single queued write — use _write
      const next = this._writeQueue.shift()!;
      this._callWriteFunc(next.chunk, next.chunkSize, next.encoding, next.callback);
    }
  }

  /** Discard queued writes after an error. */
  private _flushWriteQueueOnError(err: Error): void {
    const queue = this._writeQueue;
    this._writeQueue = [];
    for (const entry of queue) {
      this._writableLength -= entry.chunkSize;
      entry.callback?.(err);
    }
  }

  /**
   * Run _finalFunc and emit finish/close.
   * Events are deferred via deferTask to match Node.js process.nextTick
   * behavior, so listeners registered after end() can still receive them.
   */
  private _doFinish(cb?: () => void): void {
    if (this._finalFunc) {
      this._finalFunc(err => {
        if (err) {
          this._errorEmitted = true;
          this.emit("error", err);
          // Match Node.js: auto-destroy and emit close after _final error.
          // Store cb in _pendingEnd so destroy() fires it after close
          // (Node.js ordering: error → close → end-cb).
          if (cb) {
            this._pendingEnd = { cb };
          }
          if (this._autoDestroy && !this._destroyed) {
            this.destroy(err);
          }
          return;
        }
        const doFinish = (): void => {
          // If destroyed between end() and this microtask, suppress finish
          // and let destroy() handle close emission. Fire the end-cb so the
          // caller is notified (Node.js fires it via the 'close' listener).
          if (this._destroyed) {
            cb?.();
            return;
          }
          this._finished = true;
          // Node.js ordering: prefinish → end-cb → finish → autoDestroy
          this.emit("prefinish");
          cb?.();
          this.emit("finish");
          // Node.js: autoDestroy calls destroy() after finish, which emits
          // close.  Without autoDestroy, close only fires on explicit destroy().
          if (this._autoDestroy) {
            this.destroy();
          }
        };
        // When Transform signals _syncFinish (via _scheduleEnd for simple
        // Transforms with no pipe destinations), emit finish synchronously
        // to keep it ahead of user Promises. Otherwise defer as usual.
        if (this._syncFinish) {
          this._syncFinish = false;
          doFinish();
        } else {
          deferTask(doFinish);
        }
      });
    } else {
      const doFinish = (): void => {
        // If destroyed between end() and this microtask, suppress finish
        // and let destroy() handle close emission.
        if (this._destroyed) {
          cb?.();
          return;
        }
        this._finished = true;
        // Node.js ordering: prefinish → end-cb → finish → autoDestroy
        this.emit("prefinish");
        cb?.();
        this.emit("finish");
        // Node.js: autoDestroy calls destroy() after finish, which emits
        // close.  Without autoDestroy, close only fires on explicit destroy().
        if (this._autoDestroy) {
          this.destroy();
        }
      };
      // When already in a deferred context (e.g. end() called from a
      // pipe end-listener or Transform's _scheduleEnd), execute finish
      // synchronously to keep it ahead of user Promises — matching
      // Node.js process.nextTick nesting behavior.
      //
      // This only affects plain Writables without _finalFunc. Transform's
      // internal writable always has _finalFunc, so it takes the branch
      // above (with _syncFinish gating) instead of this one.
      if (inDeferredContext()) {
        doFinish();
      } else {
        deferTask(doFinish);
      }
    }
  }

  private _getChunkSize(chunk: T, encoding?: string): number {
    if (this._objectMode) {
      return 1;
    }
    if (chunk instanceof Uint8Array) {
      return chunk.byteLength;
    }
    if (typeof chunk === "string") {
      return getStringByteLength(chunk, encoding);
    }
    return 0;
  }

  private _normalizeWriteChunk(chunk: T, encoding: string): { chunk: T; encoding: string } {
    // In Node.js, decodeStrings: true converts strings to Buffer and sets encoding
    // to "buffer". We match that behavior by converting strings to Uint8Array.
    if (this._objectMode || typeof chunk !== "string") {
      return { chunk, encoding };
    }
    if (!this._decodeStrings) {
      // When decodeStrings is explicitly false, pass the original encoding through
      return { chunk, encoding };
    }
    // decodeStrings: true (default) — convert string to Uint8Array matching Node.js
    // behavior where strings are converted to Buffer with encoding set to "buffer".
    // We also override toString() so that it behaves like Node.js Buffer.toString(),
    // which returns a UTF-8 decoded string by default (not comma-separated byte values).
    const encoded = stringToEncodedBytes(chunk, encoding);
    (encoded as { toString: (enc?: string) => string }).toString = encodedBytesToString;
    // Boundary: decodeStrings materializes string chunks into bytes; the encoded
    // Uint8Array is the runtime chunk for element type T.
    return { chunk: encoded as unknown as T, encoding: "buffer" };
  }

  /**
   * End the stream
   */
  end(callback?: () => void): this;
  end(chunk: T, callback?: () => void): this;
  end(chunk: T, encoding?: string, callback?: () => void): this;
  end(
    chunkOrCallback?: T | (() => void),
    encodingOrCallback?: string | (() => void),
    callback?: () => void
  ): this {
    if (this._ended) {
      const {
        chunk,
        encoding,
        cb: endCb
      } = parseEndArgs<T>(chunkOrCallback, encodingOrCallback, callback);

      // Node invokes the end() callback with an error in some paths (write-after-
      // end / already-finished). `parseEndArgs` types it `() => void`, so view it
      // through an error-accepting signature for those Node-parity invocations.
      const errCb = endCb as ((error?: Error | null) => void) | undefined;

      // If a chunk was provided, this is a write-after-end error (Node.js behavior).
      if (chunk !== undefined) {
        this.write(chunk, encoding ?? this._defaultEncoding, err => {
          errCb?.(err ?? null);
        });
        return this;
      }

      // If we've already finished, Node.js calls the callback with
      // ERR_STREAM_ALREADY_FINISHED (but does not emit an error event).
      if (this._finished && endCb) {
        const err = new Error("Cannot call end after a stream was finished") as Error & {
          code: string;
        };
        err.code = "ERR_STREAM_ALREADY_FINISHED";
        deferTask(() => errCb!(err));
      } else {
        // Otherwise, a redundant end() is a no-op; if a callback was provided,
        // Node.js calls it with no error.
        deferTask(() => errCb?.(null));
      }
      return this;
    }

    this._ended = true;
    // Node.js: end() resets writable state. Any prior setter override is cleared
    // so the getter reflects the true ended state.
    this._writableOverride = undefined;

    const { chunk, encoding, cb } = parseEndArgs<T>(chunkOrCallback, encodingOrCallback, callback);

    // Node.js: end() auto-uncorks. If the stream is corked, flush all buffered
    // writes before finalizing so that cork() → write() → end() doesn't lose data.
    if (this._corked > 0) {
      this._corked = 1;
      this.uncork();
    }

    if (this._directWrite) {
      // Direct-write path: enqueue final chunk (if any), then wait for the
      // write queue to drain before running _finalFunc + emitting finish.
      if (chunk !== undefined) {
        // Normalize the end chunk (decodeStrings etc.) just like write()
        const normalized = this._normalizeWriteChunk(chunk, encoding ?? this._defaultEncoding);
        this._doWrite(normalized.chunk, normalized.encoding);
      }

      // If the write errored synchronously (e.g. _writeFunc called back with
      // an error before returning), the stream may already be destroyed/errored.
      // Node.js propagates the write error to the end() callback.
      if (this._errored) {
        const endErr = this._errored;
        deferTask(() => (cb as (err?: Error) => void)?.(endErr));
        return this;
      }

      // If writes are still in-flight or queued, defer finalization.
      if (this._writing || this._writeQueue.length > 0) {
        this._pendingEnd = { cb };
      } else {
        this._doFinish(cb);
      }
      return this;
    }

    // Async end path — uses Web WritableStream.
    const finish = async (): Promise<void> => {
      try {
        const writer = this._getWriter();
        if (chunk !== undefined) {
          // Normalize the end chunk (decodeStrings etc.) just like write() — matches
          // the direct-write path above and Node.js behavior.
          const { chunk: normalized } = this._normalizeWriteChunk(
            chunk,
            encoding ?? this._defaultEncoding
          );
          await writer.write(normalized);
        }
        await writer.close();

        if (this._writer === writer) {
          this._writer = null;
          try {
            writer.releaseLock();
          } catch {
            // Ignore
          }
        }

        // If we own the underlying Web WritableStream, its `close()` handler already
        // emits finish/close. For external streams, we must emit finish ourselves.
        if (!this._ownsStream) {
          this._finished = true;
          this.emit("finish");
          if (this._autoDestroy) {
            this.destroy();
          }
        }
        if (cb) {
          cb();
        }
      } catch (err) {
        this.emit("error", err);
      }
    };

    finish();
    return this;
  }

  /**
   * Destroy the stream
   */
  destroy(error?: Error): this {
    if (this._destroyed) {
      return this;
    }

    this._destroyed = true;
    // Node.js: destroy() resets writable override so getter reflects true state
    this._writableOverride = undefined;

    // Set state synchronously (matches Node.js), defer event emission via deferTask
    // to match Node.js process.nextTick behavior
    if (error && !this._errored) {
      this._errored = error;
    }

    // Cancel pending writes in the write queue (matches Node.js behavior).
    // Node.js discards queued writes on destroy, invoking their callbacks with
    // the destroy error so callers are notified.
    if (this._writeQueue.length > 0) {
      this._flushWriteQueueOnError(
        error ?? new Error("Cannot call write after a stream was destroyed")
      );
    }
    // Also flush corked chunks — if the stream is destroyed while corked,
    // pending corked-chunk callbacks must be notified.
    if (this._corkedChunks.length > 0) {
      const destroyErr = error ?? new Error("Cannot call write after a stream was destroyed");
      for (const entry of this._corkedChunks) {
        entry.callback?.(destroyErr);
      }
      this._corkedChunks = [];
    }
    // Node.js invokes the end() callback even when destroy() is called
    // while writes are pending.  Fire it asynchronously (after error/close).
    const pendingEndCb = this._pendingEnd?.cb;
    this._pendingEnd = null;
    this._writing = false;

    if (this._writer) {
      const writer = this._writer;
      this._writer = null;
      writer
        .abort(error)
        .catch(() => {})
        .finally(() => {
          try {
            writer.releaseLock();
          } catch {
            // Ignore
          }
        });
    }

    // If subclass overrides _destroy, call it and wait for callback before
    // emitting error/close (matches Node.js behavior).
    const afterDestroy = (finalError?: Error | null): void => {
      // Node.js: _destroy's callback determines whether an error is emitted.
      // - cb(null) or cb() or cb(undefined): suppress the original error
      // - cb(new Error(...)): replace with the new error, emit it
      // Node.js checks `if (err)` on the callback argument, so null/undefined/no-arg
      // all suppress the error. Only a truthy error value triggers the error event.
      const err = finalError || null;
      if (err) {
        this._errored = err;
      }
      this._closed = true;
      const doEmit = (): void => {
        if (err && !this._errorEmitted) {
          this._errorEmitted = true;
          this.emit("error", err);
        }
        if (this._emitClose) {
          this.emit("close");
        }
        // Node.js fires the end() callback after close, even on destroy.
        // Pass the error so the end() caller is notified of the failure.
        (pendingEndCb as (err?: Error | null) => void)?.(err);
      };
      // When already inside a deferTask callback (e.g. autoDestroy after
      // 'finish') and there is no async _destroy hook, emit synchronously.
      // This matches Node.js where nested process.nextTick runs before
      // interleaved Promise.then callbacks.
      // Only apply when the stream finished naturally (autoDestroy path) —
      // user-initiated destroy() from within a listener must still defer
      // so that async cleanup can complete.
      if (inDeferredContext() && !this._hasDestroyHook() && this._finished) {
        doEmit();
      } else {
        deferTask(doEmit);
      }
    };

    if (this._hasDestroyHook()) {
      try {
        this._destroy(error ?? null, afterDestroy);
      } catch (err) {
        afterDestroy(err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      afterDestroy(error);
    }
    return this;
  }

  /**
   * Override in subclass to customise destroy behaviour.
   * Call `callback(err)` when cleanup is complete.
   */
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    callback(error);
  }

  /**
   * Reverse the effects of destroy() so the stream can potentially be reused.
   * Matches Node.js _undestroy() which resets destroyed and closed flags.
   */
  _undestroy(): void {
    this._destroyed = false;
    this._closed = false;
    this._errored = null;
    this._errorEmitted = false;
  }

  /** Check if _destroy has been overridden by a subclass or constructor option. */
  private _hasDestroyHook(): boolean {
    return (
      Object.prototype.hasOwnProperty.call(this, "_destroy") ||
      Object.getPrototypeOf(this)._destroy !== Writable.prototype._destroy
    );
  }

  /**
   * Synchronous dispose — destroys the stream.
   * Matches Node.js Symbol.dispose support (v20+, experimental).
   */
  [Symbol.dispose](): void {
    if (!this._destroyed) {
      this.destroy();
    }
  }

  /**
   * Async dispose support (using await).
   * Destroys the stream and resolves after the 'close' event.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    // Match Node.js behavior:
    // 1. If not yet destroyed, destroy the stream (always resolves)
    // 2. If already destroyed by someone else, reject with "Premature close"
    //    unless the stream ended gracefully (writableFinished)
    const selfInitiated = !this._destroyed;
    if (selfInitiated) {
      this.destroy();
    }
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        if (selfInitiated || this._finished) {
          resolve();
        } else {
          reject(new Error("Premature close"));
        }
      };
      if (this._closed) {
        settle();
      } else {
        this.once("close", settle);
      }
    });
  }

  /**
   * Get the underlying Web WritableStream (internal).
   * @internal
   */
  private get _webStream(): WritableStream<T> {
    if (!this._stream) {
      // Lazily create a Web WritableStream for sync-write Writables that need interop.
      this._stream = new WritableStream<T>({
        write: chunk =>
          new Promise<void>((resolve, reject) => {
            // Boundary: Node passes undefined as the encoding in objectMode.
            const enc = this._objectMode ? (undefined as unknown as string) : this._defaultEncoding;
            this._writeFunc!(chunk, enc, err => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          }),
        close: async () => {
          if (this._finalFunc) {
            await new Promise<void>((resolve, reject) => {
              this._finalFunc!(err => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            });
          }
        },
        abort: reason => {
          this.emit("error", reason);
        }
      });
    }
    return this._stream;
  }

  private _writableOverride: boolean | undefined;

  get writable(): boolean {
    if (this._writableOverride !== undefined) {
      return this._writableOverride;
    }
    return !this._destroyed && !this._ended;
  }

  set writable(val: boolean) {
    // Node.js setter is a no-op compatibility shim — it stores the override
    // value but does NOT modify _ended or any other internal state.
    this._writableOverride = val;
  }

  get writableEnded(): boolean {
    return this._ended;
  }

  get writableFinished(): boolean {
    return this._finished;
  }

  get writableLength(): number {
    return this._writableLength;
  }

  /** Whether the stream has been destroyed */
  get destroyed(): boolean {
    return this._destroyed;
  }

  set destroyed(val: boolean) {
    this._destroyed = val;
  }

  /** The error that destroyed the stream, or null */
  get errored(): Error | null {
    return this._errored;
  }

  /** Whether the stream has been closed */
  get closed(): boolean {
    return this._closed;
  }

  /** Whether the stream needs drain (write() returned false and drain not yet emitted) */
  get writableNeedDrain(): boolean {
    return this._needDrain;
  }

  /** How many times cork() has been called without uncork() */
  get writableCorked(): number {
    return this._corked;
  }

  /** Whether the stream was destroyed or errored before finishing */
  get writableAborted(): boolean {
    // Node.js: writable !== false && (destroyed || errored) && !finished
    // The 'writable !== false' check is for when user explicitly sets stream.writable = false.
    // We check _writableOverride (not the computed getter which returns false after destroy).
    if (this._writableOverride === false) {
      return false;
    }
    return (this._destroyed || !!this._errored) && !this._finished;
  }

  /** Whether the stream is in object mode */
  get writableObjectMode(): boolean {
    return this._objectMode;
  }

  get writableHighWaterMark(): number {
    return this._highWaterMark;
  }

  /**
   * Get the internal buffer contents as an array (matches Node.js behavior)
   */
  get writableBuffer(): T[] {
    const chunks: T[] = this._corkedChunks.map(entry => entry.chunk);
    for (const entry of this._writeQueue) {
      chunks.push(entry.chunk);
    }
    return chunks;
  }

  /**
   * Pipe is not supported on Writable streams (matches Node.js behavior).
   * Node's Writable emits ERR_STREAM_CANNOT_PIPE asynchronously and returns undefined.
   */
  pipe(): undefined {
    const err = new StreamStateError("pipe", "not readable") as StreamStateError & { code: string };
    err.code = "ERR_STREAM_CANNOT_PIPE";
    // Node.js emits the error asynchronously (via process.nextTick).
    // In the browser we use deferTask for the same deferred semantics.
    deferTask(() => this.emit("error", err));
    return undefined;
  }

  private _getWriter(): WritableStreamDefaultWriter<T> {
    if (!this._writer) {
      this._writer = this._webStream.getWriter();
    }
    return this._writer;
  }

  // =========================================================================
  // Static Methods (Node.js compatibility)
  // =========================================================================

  /**
   * Check if a stream has been disturbed (data read or piped).
   * In Node.js this is inherited from the Stream base class and exists on
   * ALL stream classes (Readable, Writable, Duplex, Transform, PassThrough).
   * Delegates to Readable.isDisturbed, checking internal _readable for Duplex/Transform.
   */
  static isDisturbed(stream: unknown): boolean {
    if (stream && typeof stream === "object") {
      const inner = (stream as { _readable?: unknown })._readable;
      if (inner instanceof Readable) {
        return Readable.isDisturbed(inner);
      }
    }
    return Readable.isDisturbed(stream as Readable<unknown>);
  }

  /**
   * Convert a Web WritableStream to Node.js Writable
   */
  static fromWeb<T>(webStream: WritableStream<T>, options?: WritableStreamOptions): Writable<T> {
    return new Writable<T>({ ...options, stream: webStream });
  }

  /**
   * Convert a Node.js Writable to Web WritableStream
   */
  static toWeb<T>(nodeStream: Writable<T>): WritableStream<T> {
    return nodeStream._webStream;
  }
}

// Node.js: Writable.prototype._writev === null (not undefined).
Writable.prototype._writev = null;

// Node.js: Writable.prototype._write throws ERR_METHOD_NOT_IMPLEMENTED.
// This must exist on the prototype so that subclasses can call super._write()
// and so that `_getSubclassWrite()` can detect overrides correctly.
// Node.js throws synchronously (does NOT call the callback).
Writable.prototype._write = function _write(
  _chunk: unknown,
  _encoding: string,
  _callback: (error?: Error | null) => void
): void {
  const err = new Error("The _write() method is not implemented") as Error & { code: string };
  err.code = "ERR_METHOD_NOT_IMPLEMENTED";
  throw err;
};

// =============================================================================
// Cross-environment stream normalization
// =============================================================================

/**
 * Normalize a user-provided writable into this module's Writable.
 * Keeps Web/Node branching at the stream-module boundary.
 *
 * A Node `Writable` is accepted too — it satisfies the structural
 * {@link WritableLike}. This variant deliberately does not name Node's class:
 * doing so pulled `@types/node` into the browser declaration graph.
 */
export function toWritable<T = Uint8Array>(stream: WritableLike | WritableStream<T>): WritableLike {
  if (stream instanceof Writable) {
    return stream;
  }

  // Web WritableStream
  if ((stream as { getWriter?: unknown }).getWriter) {
    return new Writable<T>({ stream: stream as WritableStream<T> });
  }

  // Already a Node-like writable (e.g. StreamBuf)
  return stream as WritableLike;
}

function getStringByteLength(value: string, encoding?: string): number {
  const normalized = (encoding ?? "utf8").toLowerCase();
  if (normalized === "ascii" || normalized === "latin1" || normalized === "binary") {
    return value.length;
  }
  if (normalized === "utf16le" || normalized === "utf-16le" || normalized === "ucs2") {
    return value.length * 2;
  }
  // Compute UTF-8 byte length without allocating TextEncoder or encoded buffer
  return utf8ByteLength(value);
}

/**
 * Compute the UTF-8 byte length of a string without allocating a TextEncoder
 * or an intermediate Uint8Array. Handles surrogate pairs correctly.
 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair — 4 bytes for the full codepoint
      bytes += 4;
      i++; // skip low surrogate
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
