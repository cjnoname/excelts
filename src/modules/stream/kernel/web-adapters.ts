/**
 * Stream kernel - Web Streams interop
 *
 * Port of Node.js `lib/internal/webstreams/adapters.js`. Each adapter drives
 * the other side only through its public API — `write()` / `end()` /
 * `destroy()` on a Node-style stream, the reader / writer on a Web stream —
 * so neither side's state machine is bypassed and there is one owner of each
 * queue. The stream classes are passed in, so the Node entry uses these same
 * adapters with `node:stream`'s classes.
 *
 * Every adapter takes an `AdapterMode`. The classes' `fromWeb` / `toWeb`
 * statics use `"node"`: what Node ships, defects included, so the same code
 * behaves the same on both entries (the Node entry's classes are
 * `node:stream`'s own). The module's `readableFromWeb` / `readableToWeb` /
 * `writableFromWeb` / `writableToWeb` use `"safe"`, which fixes five of those
 * defects:
 *
 * - a `null` read fails with ERR_STREAM_NULL_VALUES; Node pushes it, which
 *   ends the stream and silently drops what follows;
 * - the lock is handed back once the adapter is done; Node keeps it for good;
 * - a Web write made while 'drain' is pending still reaches `write()`; Node
 *   resolves it without writing, losing the chunk;
 * - a byte-mode Readable after `setEncoding()` is sized in characters; Node's
 *   `ByteLengthQueuingStrategy` cannot size a string and errors the stream;
 * - `toWeb` removes its own listeners from the source once done; Node leaves
 *   them attached.
 */

import { destroyer } from "@stream/kernel/destroy";
import { addAbortSignalNoValidate, eos } from "@stream/kernel/end-of-stream";
import {
  createAbortError,
  errInvalidArgType,
  errStreamNullValues,
  errStreamPrematureClose,
  validateObject
} from "@stream/kernel/errors";
import { encodeStringChunk, nextTick, normalizeEncodingName } from "@stream/kernel/state";
import {
  isDestroyed,
  isReadable,
  isReadableStream,
  isWritable,
  isWritableEnded,
  isWritableStream
} from "@stream/kernel/stream-utils";

type StreamCtor = new (options?: any) => any;
type Listener = (...args: any[]) => void;

/** What the toWeb adapters drive on a Node-style Readable — Node's own or the kernel's. */
interface ReadableSource {
  readonly _readableState: object;
  readonly readableObjectMode: boolean;
  readonly readableHighWaterMark: number;
  pause(): unknown;
  resume(): unknown;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

/** What the toWeb adapters drive on a Node-style Writable. */
interface WritableTarget {
  readonly writableObjectMode: boolean;
  readonly writableHighWaterMark: number;
  readonly writableNeedDrain: boolean;
  write(chunk: unknown): boolean;
  end(): unknown;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

function isReadableSource(value: unknown): value is ReadableSource {
  return typeof (value as { _readableState?: unknown } | null)?._readableState === "object";
}

function isWritableTarget(value: unknown): value is WritableTarget {
  const v = value as { write?: unknown; on?: unknown } | null;
  return typeof v?.write === "function" && typeof v?.on === "function";
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noop = (): void => {};

function assertUnlocked(stream: ReadableStream | WritableStream): void {
  if (stream.locked) {
    throw new TypeError("The stream is locked, so it cannot be adapted");
  }
}

/** zlib's failure codes: every `Z_*` constant below zero. */
const ZLIB_FAILURES = new Set([
  "Z_NEED_DICT",
  "Z_ERRNO",
  "Z_STREAM_ERROR",
  "Z_DATA_ERROR",
  "Z_MEM_ERROR",
  "Z_BUF_ERROR",
  "Z_VERSION_ERROR"
]);

/**
 * Node's translation of a Node-style stream's failure into what the Web side
 * reports: a premature close is an abort, and a zlib or Brotli failure a
 * `TypeError` carrying the original code.
 */
function handleKnownInternalErrors(cause: Error | null | undefined): Error | null | undefined {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (code === "ERR_STREAM_PREMATURE_CLOSE") {
    return createAbortError(cause);
  }
  if (typeof code === "string" && (ZLIB_FAILURES.has(code) || code.startsWith("ERR__ERROR_"))) {
    const error = new TypeError(undefined, { cause });
    Object.defineProperty(error, "code", {
      value: code,
      writable: true,
      enumerable: true,
      configurable: true
    });
    return error;
  }
  return cause;
}

/** Queue size of a byte-mode chunk: bytes for binary data, characters for a string. */
function chunkSize(chunk: any): number {
  return chunk?.byteLength ?? chunk?.length ?? 1;
}

/** Settle a Node-style callback from a promise without leaking a rejection. */
function settleInto(promise: Promise<unknown>, done: (err?: Error | null) => void): void {
  promise.then(
    () => done(),
    err => done(err as Error)
  );
}

function encodeForWeb(
  chunk: unknown,
  encoding: string,
  decodeStrings: boolean,
  objectMode: boolean
): unknown {
  if (typeof chunk === "string" && decodeStrings && !objectMode) {
    return encodeStringChunk(chunk, normalizeEncodingName(encoding || "utf8"));
  }
  return chunk;
}

/**
 * `"node"`: what Node ships, defects included — the classes' statics. `"safe"`:
 * the module's own conversions, with Node's defects fixed (see above).
 */
type AdapterMode = "node" | "safe";

// =============================================================================
// Node-style Readable  ⇄  ReadableStream
// =============================================================================

export function readableToWeb<T>(
  streamReadable: unknown,
  options: { strategy?: QueuingStrategy<T> } = {},
  mode: AdapterMode = "safe"
): ReadableStream<T> {
  if (!isReadableSource(streamReadable)) {
    throw errInvalidArgType("streamReadable", "stream.Readable", streamReadable);
  }
  validateObject(options, "options");

  let controller!: ReadableStreamDefaultController<T>;
  let wasCanceled = false;
  const readable = isReadable(streamReadable);
  const objectMode = streamReadable.readableObjectMode;

  const source: UnderlyingDefaultSource<T> = {
    start(c) {
      controller = c;
    },
    cancel(reason) {
      wasCanceled = true;
      detach();
      destroyer(streamReadable, reason);
    }
  };

  let strategy: QueuingStrategy<T> | undefined;
  if (readable) {
    source.pull = () => {
      streamReadable.resume();
    };
    const highWaterMark = streamReadable.readableHighWaterMark;
    // Byte mode measures bytes — or characters, once setEncoding() turned the
    // chunks into strings, which ByteLengthQueuingStrategy cannot size.
    strategy =
      options.strategy ??
      (objectMode
        ? new CountQueuingStrategy({ highWaterMark })
        : mode === "node"
          ? (new ByteLengthQueuingStrategy({ highWaterMark }) as QueuingStrategy<T>)
          : { highWaterMark, size: chunkSize });
  }
  const readableStream = new ReadableStream<T>(source, strategy);

  const onData = (chunk: T): void => {
    controller.enqueue(chunk);
    if ((controller.desiredSize ?? 0) <= 0) {
      streamReadable.pause();
    }
  };
  // The adapter's own listener goes once the Web stream is done with the source.
  // Node leaves its listener on the source.
  const detach = (): void => {
    if (mode === "node") {
      return;
    }
    streamReadable.removeListener("data", onData);
  };

  // A half-open Duplex completes its readable side without its writable one.
  let cleanup = noop;
  cleanup = eos(streamReadable, { writable: false, synchronous: true }, cause => {
    const error = handleKnownInternalErrors(cause);
    cleanup();
    detach();
    // Swallow a legacy stream's late duplicate 'error' after completion.
    streamReadable.on("error", noop);
    if (wasCanceled) {
      return;
    }
    wasCanceled = true;
    if (error) {
      controller.error(error);
      return;
    }
    controller.close();
  });

  if (wasCanceled) {
    cleanup();
  } else if (readable) {
    streamReadable.pause();
    streamReadable.on("data", onData);
  }

  return readableStream;
}

export function readableFromWeb(
  ReadableCtor: StreamCtor,
  readableStream: ReadableStream,
  options: {
    highWaterMark?: number;
    encoding?: string;
    objectMode?: boolean;
    signal?: AbortSignal;
  } = {},
  mode: AdapterMode = "safe"
): any {
  if (!isReadableStream(readableStream)) {
    throw errInvalidArgType("readableStream", "ReadableStream", readableStream);
  }
  validateObject(options, "options");
  assertUnlocked(readableStream);
  const { highWaterMark, encoding, objectMode = false, signal } = options;

  // Constructed before the reader is taken: invalid options then throw with
  // the Web stream still untouched.
  const readable = new ReadableCtor({
    objectMode,
    highWaterMark,
    encoding,

    read() {
      reader.read().then(
        chunk => {
          if (chunk.done) {
            releaseReader();
            readable.push(null);
          } else if (chunk.value === null && mode === "safe") {
            // push(null) would end the stream and drop what follows.
            destroyer(readable, errStreamNullValues());
          } else {
            readable.push(chunk.value);
          }
        },
        error => destroyer(readable, error)
      );
    },

    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      // Cancel the source so it can release what it holds, read or not, then
      // hand the lock back.
      const done = (): void => {
        releaseReader();
        callback(error);
      };
      if (!closed) {
        reader.cancel(error).then(done, done);
        return;
      }
      done();
    }
  });

  const reader = readableStream.getReader();
  let closed = false;
  let released = false;
  const releaseReader = (): void => {
    if (!released && mode === "safe") {
      released = true;
      reader.releaseLock();
    }
  };

  reader.closed.then(
    () => {
      closed = true;
    },
    error => {
      closed = true;
      // Releasing the lock rejects `closed`; that is not a failure.
      if (!released) {
        destroyer(readable, error);
      }
    }
  );

  // Attached last: an already-aborted signal destroys at once, which needs the reader.
  if (signal) {
    addAbortSignalNoValidate(signal, readable);
  }
  return readable;
}

// =============================================================================
// Node-style Writable  ⇄  WritableStream
// =============================================================================

export function writableToWeb<T>(
  streamWritable: unknown,
  mode: AdapterMode = "safe"
): WritableStream<T> {
  if (!isWritableTarget(streamWritable)) {
    throw errInvalidArgType("streamWritable", "stream.Writable", streamWritable);
  }

  if (isDestroyed(streamWritable) || !isWritable(streamWritable)) {
    const writable = new WritableStream<T>();
    writable.close();
    return writable;
  }

  const highWaterMark = streamWritable.writableHighWaterMark;
  const strategy: QueuingStrategy<T> = streamWritable.writableObjectMode
    ? new CountQueuingStrategy({ highWaterMark })
    : { highWaterMark, size: chunkSize };

  let controller: WritableStreamDefaultController | undefined;
  let backpressure: Deferred | undefined;
  let closed: Deferred | undefined;

  const onDrain = (): void => backpressure?.resolve();
  const cleanup = eos(streamWritable, cause => {
    const error = handleKnownInternalErrors(cause);
    cleanup();
    if (mode === "safe") {
      streamWritable.removeListener("drain", onDrain);
    }
    streamWritable.on("error", noop);
    if (error != null) {
      backpressure?.reject(error);
      if (closed !== undefined) {
        closed.reject(error);
        closed = undefined;
      }
      controller?.error(error);
      controller = undefined;
      return;
    }
    if (closed !== undefined) {
      closed.resolve();
      closed = undefined;
      return;
    }
    controller?.error(createAbortError());
    controller = undefined;
  });

  streamWritable.on("drain", onDrain);

  // Writes go through write() / end() / destroy(), i.e. through the
  // Writable's own queue and lifecycle, never around them.
  return new WritableStream<T>(
    {
      start(c) {
        controller = c;
      },
      write(chunk: any) {
        if (!streamWritable.writableObjectMode && chunk instanceof ArrayBuffer) {
          chunk = new Uint8Array(chunk);
        }
        // Always hand the chunk over — a Writable accepts writes past its mark —
        // then wait for 'drain' if it asked for one. Node skips the write while
        // a drain is pending, which drops the chunk.
        const skipped = mode === "node" && streamWritable.writableNeedDrain;
        if (skipped || !streamWritable.write(chunk)) {
          if (!streamWritable.writableNeedDrain) {
            return undefined;
          }
          const pending = deferred();
          backpressure = pending;
          return pending.promise.finally(() => {
            backpressure = undefined;
          });
        }
        return undefined;
      },
      abort(reason) {
        destroyer(streamWritable, reason);
      },
      close() {
        if (closed === undefined && !isWritableEnded(streamWritable)) {
          closed = deferred();
          streamWritable.end();
          return closed.promise;
        }
        controller = undefined;
        return Promise.resolve();
      }
    },
    strategy
  );
}

export function writableFromWeb(
  WritableCtor: StreamCtor,
  writableStream: WritableStream,
  options: {
    highWaterMark?: number;
    decodeStrings?: boolean;
    objectMode?: boolean;
    signal?: AbortSignal;
  } = {},
  mode: AdapterMode = "safe"
): any {
  if (!isWritableStream(writableStream)) {
    throw errInvalidArgType("writableStream", "WritableStream", writableStream);
  }
  validateObject(options, "options");
  assertUnlocked(writableStream);
  const { highWaterMark, decodeStrings = true, objectMode = false, signal } = options;

  const writable = new WritableCtor({
    highWaterMark,
    objectMode,
    decodeStrings,

    writev(chunks: Array<{ chunk: unknown }>, callback: (error?: Error | null) => void) {
      settleInto(
        writer.ready.then(() => Promise.all(chunks.map(data => writer.write(data.chunk)))),
        guarded(callback)
      );
    },

    write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void) {
      const data = encodeForWeb(chunk, encoding, decodeStrings, objectMode);
      settleInto(
        writer.ready.then(() => writer.write(data)),
        guarded(callback)
      );
    },

    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      const done = (): void => {
        releaseWriter();
        callback(error);
      };
      if (!closed) {
        (error != null ? writer.abort(error) : writer.close()).then(done, done);
        return;
      }
      done();
    },

    final(callback: (error?: Error | null) => void) {
      if (!closed) {
        settleInto(writer.close(), guarded(callback));
      }
    }
  });

  const writer = writableStream.getWriter();
  let closed = false;
  let released = false;
  const releaseWriter = (): void => {
    if (!released && mode === "safe") {
      released = true;
      writer.releaseLock();
    }
  };

  function guarded(callback: (error?: Error | null) => void): (error?: Error | null) => void {
    return error => {
      try {
        callback(error);
      } catch (err) {
        nextTick(() => destroyer(writable, err as Error));
      }
    };
  }

  writer.closed.then(
    () => {
      closed = true;
      if (isWritableEnded(writable)) {
        releaseWriter();
      } else {
        // The sink closed before the Writable ended: that is a premature close.
        destroyer(writable, errStreamPrematureClose());
      }
    },
    error => {
      closed = true;
      // Releasing the lock rejects `closed`; that is not a failure.
      if (!released) {
        destroyer(writable, error);
      }
    }
  );

  // Attached last: an already-aborted signal destroys at once, which needs the writer.
  if (signal) {
    addAbortSignalNoValidate(signal, writable);
  }
  return writable;
}

// =============================================================================
// Duplex  ⇄  { readable, writable }
// =============================================================================

export function duplexToWeb<R, W>(
  duplex: unknown,
  mode: AdapterMode = "safe"
): {
  readable: ReadableStream<R>;
  writable: WritableStream<W>;
} {
  if (
    !isReadableSource(duplex) ||
    !isWritableTarget(duplex) ||
    typeof (duplex as { _writableState?: unknown })._writableState !== "object"
  ) {
    throw errInvalidArgType("duplex", "stream.Duplex", duplex);
  }

  if (isDestroyed(duplex)) {
    const writable = new WritableStream<W>();
    const readable = new ReadableStream<R>();
    writable.close();
    readable.cancel();
    return { readable, writable };
  }

  const writable = isWritable(duplex) ? writableToWeb<W>(duplex, mode) : new WritableStream<W>();
  if (!isWritable(duplex)) {
    writable.close();
  }

  const readable = isReadable(duplex)
    ? readableToWeb<R>(duplex, {}, mode)
    : new ReadableStream<R>();
  if (!isReadable(duplex)) {
    readable.cancel();
  }

  return { readable, writable };
}

export function duplexFromWeb(
  DuplexCtor: StreamCtor,
  pair: { readable: ReadableStream; writable: WritableStream } | undefined,
  options: {
    allowHalfOpen?: boolean;
    objectMode?: boolean;
    encoding?: string;
    decodeStrings?: boolean;
    highWaterMark?: number;
    signal?: AbortSignal;
  } = {},
  mode: AdapterMode = "safe"
): any {
  // A missing pair is an empty one, as Node's default parameter makes it.
  const given: unknown = pair === undefined ? {} : pair;
  validateObject(given, "pair");
  const { readable: readableStream, writable: writableStream } = given as {
    readable?: unknown;
    writable?: unknown;
  };
  if (!isReadableStream(readableStream)) {
    throw errInvalidArgType("pair.readable", "ReadableStream", readableStream);
  }
  if (!isWritableStream(writableStream)) {
    throw errInvalidArgType("pair.writable", "WritableStream", writableStream);
  }
  validateObject(options, "options");
  // Both sides are checked before either is taken: a failure part-way would
  // otherwise leave one lock held with nobody to release it.
  assertUnlocked(readableStream);
  assertUnlocked(writableStream);

  const {
    allowHalfOpen = false,
    objectMode = false,
    encoding,
    decodeStrings = true,
    highWaterMark,
    signal
  } = options;

  const duplex = new DuplexCtor({
    allowHalfOpen,
    highWaterMark,
    objectMode,
    encoding,
    decodeStrings,

    writev(chunks: Array<{ chunk: unknown }>, callback: (error?: Error | null) => void) {
      settleInto(
        writer.ready.then(() => Promise.all(chunks.map(data => writer.write(data.chunk)))),
        guarded(callback)
      );
    },

    write(chunk: unknown, enc: string, callback: (error?: Error | null) => void) {
      const data = encodeForWeb(chunk, enc, decodeStrings, objectMode);
      settleInto(
        writer.ready.then(() => writer.write(data)),
        guarded(callback)
      );
    },

    final(callback: (error?: Error | null) => void) {
      if (!writableClosed) {
        settleInto(writer.close(), guarded(callback));
      }
    },

    read() {
      reader.read().then(
        chunk => {
          if (chunk.done) {
            releaseReader();
            duplex.push(null);
          } else if (chunk.value === null && mode === "safe") {
            // push(null) would end the stream and drop what follows.
            destroyer(duplex, errStreamNullValues());
          } else {
            duplex.push(chunk.value);
          }
        },
        error => destroyer(duplex, error)
      );
    },

    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      const done = (): void => {
        releaseReader();
        releaseWriter();
        callback(error);
      };
      const pending: Promise<unknown>[] = [];
      if (!writableClosed && !writerReleased) {
        pending.push(writer.abort(error));
      }
      if (!readableClosed && !readerReleased) {
        pending.push(reader.cancel(error));
      }
      if (pending.length > 0) {
        // Every side is torn down before reporting, even if one rejects first.
        Promise.allSettled(pending).then(done);
        return;
      }
      done();
    }
  });

  const writer = writableStream.getWriter();
  const reader = readableStream.getReader();
  let writableClosed = false;
  let readableClosed = false;
  let writerReleased = false;
  let readerReleased = false;
  const releaseWriter = (): void => {
    if (!writerReleased && mode === "safe") {
      writerReleased = true;
      writer.releaseLock();
    }
  };
  const releaseReader = (): void => {
    if (!readerReleased && mode === "safe") {
      readerReleased = true;
      reader.releaseLock();
    }
  };

  function guarded(callback: (error?: Error | null) => void): (error?: Error | null) => void {
    return error => {
      try {
        callback(error);
      } catch (err) {
        nextTick(() => destroyer(duplex, err as Error));
      }
    };
  }

  writer.closed.then(
    () => {
      writableClosed = true;
      if (isWritableEnded(duplex)) {
        releaseWriter();
      } else {
        destroyer(duplex, errStreamPrematureClose());
      }
    },
    error => {
      // Only this side is closed: the readable is a separate stream and is
      // still open, so destroying the Duplex must still cancel it.
      writableClosed = true;
      // Releasing the lock rejects `closed`; that is not a failure.
      if (!writerReleased) {
        destroyer(duplex, error);
      }
    }
  );

  reader.closed.then(
    () => {
      readableClosed = true;
    },
    error => {
      readableClosed = true;
      if (!readerReleased) {
        destroyer(duplex, error);
      }
    }
  );

  // Attached last: an already-aborted signal destroys at once, which needs both locks.
  if (signal) {
    addAbortSignalNoValidate(signal, duplex);
  }
  return duplex;
}
