/**
 * Stream kernel - Readable algorithms
 *
 * Port of Node.js `lib/internal/streams/readable.js`, minus the class itself
 * (see `classes.ts`). All state lives in one `ReadableState`; every consumer —
 * `read()`, `'data'`, `'readable'`, `pipe()` and async iteration — goes through
 * the same buffer and the same `read()` algorithm, so they cannot see different
 * data or a different end.
 */

import { destroyer, errorOrDestroy } from "@stream/kernel/destroy";
import { addAbortSignalNoValidate, eos } from "@stream/kernel/end-of-stream";
import {
  aggregateTwoErrors,
  errInvalidArgType,
  errOutOfRange,
  errStreamPushAfterEof,
  errStreamUnshiftAfterEndEvent
} from "@stream/kernel/errors";
import { prependListener } from "@stream/kernel/legacy";
import type { ReadableCore, ReadableState } from "@stream/kernel/state";
import {
  decoderEnd,
  decoderWrite,
  encodeStringChunk,
  nextTick,
  normalizeEncodingName,
  viewToBytes
} from "@stream/kernel/state";
import { concatUint8Arrays, createStreamDecoder } from "@utils/binary";

const nop = (): void => {};

// =============================================================================
// Construction
// =============================================================================

/** Apply the options shared by Readable and Duplex. */
export function initReadable(
  stream: ReadableCore,
  options?: {
    read?: (size: number) => void;
    destroy?: ReadableCore["_destroy"];
    construct?: ReadableCore["_construct"];
    signal?: AbortSignal;
  }
): void {
  if (!options) {
    return;
  }
  if (typeof options.read === "function") {
    stream._read = options.read;
  }
  if (typeof options.destroy === "function") {
    stream._destroy = options.destroy;
  }
  if (typeof options.construct === "function") {
    stream._construct = options.construct;
  }
  if (options.signal) {
    addAbortSignalNoValidate(options.signal, stream);
  }
}

export function onReadableConstructed(stream: ReadableCore): void {
  const state = stream._readableState;
  if (state.needReadable) {
    maybeReadMore(stream, state);
  }
}

// =============================================================================
// push / unshift
// =============================================================================

function normalizeByteChunk(
  stream: ReadableCore,
  state: ReadableState,
  chunk: any,
  encoding: string | undefined
): { chunk: any; encoding: string } | null {
  if (typeof chunk === "string") {
    const enc = normalizeEncodingName(encoding || state.defaultEncoding);
    if (state.encoding !== enc) {
      return { chunk: encodeStringChunk(chunk, enc), encoding: "" };
    }
    return { chunk, encoding: enc };
  }
  if (chunk instanceof Uint8Array) {
    return { chunk, encoding: "" };
  }
  if (ArrayBuffer.isView(chunk)) {
    return { chunk: viewToBytes(chunk), encoding: "" };
  }
  if (chunk !== undefined) {
    errorOrDestroy(
      stream,
      errInvalidArgType("chunk", ["string", "Buffer", "TypedArray", "DataView"], chunk)
    );
    return null;
  }
  return { chunk, encoding: "" };
}

export function addChunkPushByteMode(
  stream: ReadableCore,
  state: ReadableState,
  rawChunk: any,
  encoding: string | undefined
): boolean {
  if (rawChunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }

  const normalized = normalizeByteChunk(stream, state, rawChunk, encoding);
  if (!normalized) {
    return false;
  }
  let chunk = normalized.chunk;

  if (!chunk || chunk.length <= 0) {
    state.reading = false;
    maybeReadMore(stream, state);
    return canPushMore(state);
  }

  if (state.ended) {
    errorOrDestroy(stream, errStreamPushAfterEof());
    return false;
  }

  if (state.destroyed || state.errored) {
    return false;
  }

  state.reading = false;
  if (state.decoder && !normalized.encoding) {
    chunk = decoderWrite(state.decoder, chunk);
    if (chunk.length === 0) {
      maybeReadMore(stream, state);
      return canPushMore(state);
    }
  }

  addChunk(stream, state, chunk, false);
  return canPushMore(state);
}

export function addChunkPushObjectMode(
  stream: ReadableCore,
  state: ReadableState,
  chunk: any,
  encoding: string | undefined
): boolean {
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }

  if (state.ended) {
    errorOrDestroy(stream, errStreamPushAfterEof());
    return false;
  }

  if (state.destroyed || state.errored) {
    return false;
  }

  state.reading = false;
  if (state.decoder && !encoding && chunk instanceof Uint8Array) {
    chunk = decoderWrite(state.decoder, chunk);
  }

  addChunk(stream, state, chunk, false);
  return canPushMore(state);
}

export function addChunkUnshiftByteMode(
  stream: ReadableCore,
  state: ReadableState,
  rawChunk: any,
  encoding: string | undefined
): boolean {
  if (rawChunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }

  let chunk = rawChunk;
  if (typeof chunk === "string") {
    const enc = normalizeEncodingName(encoding || state.defaultEncoding);
    if (state.encoding !== enc) {
      const bytes = encodeStringChunk(chunk, enc);
      // With an encoding set the buffer holds strings in that encoding.
      chunk = state.encoding ? decoderWrite(createStreamDecoder(state.encoding), bytes) : bytes;
    }
  } else if (ArrayBuffer.isView(chunk)) {
    chunk = viewToBytes(chunk);
  } else if (chunk !== undefined) {
    errorOrDestroy(
      stream,
      errInvalidArgType("chunk", ["string", "Buffer", "TypedArray", "DataView"], chunk)
    );
    return false;
  }

  if (!(chunk && chunk.length > 0)) {
    return canPushMore(state);
  }
  return addChunkUnshiftValue(stream, state, chunk);
}

export function addChunkUnshiftObjectMode(
  stream: ReadableCore,
  state: ReadableState,
  chunk: any
): boolean {
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }
  return addChunkUnshiftValue(stream, state, chunk);
}

function addChunkUnshiftValue(stream: ReadableCore, state: ReadableState, chunk: any): boolean {
  if (state.endEmitted) {
    errorOrDestroy(stream, errStreamUnshiftAfterEndEvent());
  } else if (state.destroyed || state.errored) {
    return false;
  } else {
    addChunk(stream, state, chunk, true);
  }
  return canPushMore(state);
}

function canPushMore(state: ReadableState): boolean {
  // Below the mark — or empty, which keeps a highWaterMark of 0 moving.
  return !state.ended && (state.length < state.highWaterMark || state.length === 0);
}

function addChunk(
  stream: ReadableCore,
  state: ReadableState,
  chunk: any,
  addToFront: boolean
): void {
  if (state.flowing === true && !state.sync && state.dataListening && state.length === 0) {
    // Nothing buffered and a consumer waiting: hand the chunk over directly.
    if (state.multiAwaitDrain) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
    }
    state.dataEmitted = true;
    stream.emit("data", chunk);
  } else {
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) {
      if (state.bufferIndex > 0) {
        state.buffer[--state.bufferIndex] = chunk;
      } else {
        state.buffer.unshift(chunk);
      }
    } else {
      state.buffer.push(chunk);
    }
    if (state.needReadable) {
      emitReadable(stream);
    }
  }
  maybeReadMore(stream, state);
}

// =============================================================================
// read()
// =============================================================================

const MAX_HWM = 0x40000000;

function computeNewHighWaterMark(n: number): number {
  if (n > MAX_HWM) {
    throw errOutOfRange("size", "<= 1GiB", n);
  }
  // Next power of two, so the mark does not creep up in tiny steps.
  n--;
  n |= n >>> 1;
  n |= n >>> 2;
  n |= n >>> 4;
  n |= n >>> 8;
  n |= n >>> 16;
  n++;
  return n;
}

function howMuchToRead(n: number, state: ReadableState): number {
  if (n <= 0 || (state.length === 0 && state.ended)) {
    return 0;
  }
  if (state.objectMode) {
    return 1;
  }
  if (Number.isNaN(n)) {
    // Without a size, hand out one buffered chunk at a time.
    if (!state.decoder && state.length) {
      return state.buffer[state.bufferIndex].length;
    }
    if (state.flowing === true && state.length) {
      return state.buffer[state.bufferIndex].length;
    }
    return state.length;
  }
  if (n <= state.length) {
    return n;
  }
  return state.ended ? state.length : 0;
}

export function readImpl(stream: ReadableCore, size: number | undefined): unknown {
  let n: number;
  if (size === undefined) {
    n = NaN;
  } else if (!Number.isInteger(size)) {
    n = Number.parseInt(String(size), 10);
  } else {
    n = size;
  }
  const state = stream._readableState;
  const nOrig = n;

  if (n > state.highWaterMark) {
    state.highWaterMark = computeNewHighWaterMark(n);
  }

  if (n !== 0) {
    state.emittedReadable = false;
  }

  // read(0) with enough buffered just (re-)announces 'readable'.
  if (
    n === 0 &&
    state.needReadable &&
    ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) ||
      state.ended)
  ) {
    if (state.length === 0 && state.ended) {
      endReadable(stream);
    } else {
      emitReadable(stream);
    }
    return null;
  }

  n = howMuchToRead(n, state);

  if (n === 0 && state.ended) {
    if (state.length === 0) {
      endReadable(stream);
    }
    return null;
  }

  // Decide whether to call _read() *before* taking data out of the buffer:
  // a synchronous _read (PassThrough, Transform) can fill the buffer in the
  // call, which then changes how much this read() can return.
  let doRead = state.needReadable;
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
  }

  if (state.reading || state.ended || state.destroyed || state.errored || !state.constructed) {
    doRead = false;
  } else if (doRead) {
    state.reading = true;
    state.sync = true;
    if (state.length === 0) {
      state.needReadable = true;
    }
    try {
      stream._read(state.highWaterMark);
    } catch (err) {
      errorOrDestroy(stream, err as Error);
    }
    state.sync = false;
    // A synchronous push() cleared `reading`; recompute against the new buffer.
    if (!state.reading) {
      n = howMuchToRead(nOrig, state);
    }
  }

  const ret: unknown = n > 0 ? fromList(n, state) : null;

  if (ret === null) {
    state.needReadable = state.needReadable || state.length <= state.highWaterMark;
    n = 0;
  } else {
    state.length -= n;
    if (state.multiAwaitDrain) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
    }
  }

  if (state.length === 0) {
    // Nothing buffered: be told as soon as something arrives.
    if (!state.ended) {
      state.needReadable = true;
    }
    // A read() past EOF ends the stream.
    if (nOrig !== n && state.ended) {
      endReadable(stream);
    }
  }

  if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
    state.dataEmitted = true;
    stream.emit("data", ret);
  }

  return ret;
}

function sliceChunk(chunk: any, start: number, end?: number): any {
  return typeof chunk === "string" ? chunk.slice(start, end) : chunk.subarray(start, end);
}

/** Take `n` bytes (or one object) off the front of the buffer. */
function fromList(n: number, state: ReadableState): unknown {
  const stateLength = state.length;
  if (stateLength === 0) {
    return null;
  }

  let idx = state.bufferIndex;
  const buf = state.buffer;
  const len = buf.length;
  let ret: any;

  if (state.objectMode) {
    ret = buf[idx];
    buf[idx++] = null;
  } else if (!n || n >= stateLength) {
    // Everything that is buffered.
    if (state.decoder) {
      ret = "";
      while (idx < len) {
        ret += buf[idx];
        buf[idx++] = null;
      }
    } else if (len - idx === 1) {
      ret = buf[idx];
      buf[idx++] = null;
    } else {
      const parts: Uint8Array[] = [];
      while (idx < len) {
        parts.push(buf[idx]);
        buf[idx++] = null;
      }
      ret = concatUint8Arrays(parts, stateLength);
    }
  } else {
    const first = buf[idx];
    const firstLength = first.length;
    if (n < firstLength) {
      ret = sliceChunk(first, 0, n);
      buf[idx] = sliceChunk(first, n);
    } else if (n === firstLength) {
      ret = first;
      buf[idx++] = null;
    } else if (state.decoder) {
      ret = "";
      while (idx < len) {
        const str = buf[idx];
        if (n > str.length) {
          ret += str;
          n -= str.length;
          buf[idx++] = null;
        } else {
          if (n === str.length) {
            ret += str;
            buf[idx++] = null;
          } else {
            ret += str.slice(0, n);
            buf[idx] = str.slice(n);
          }
          break;
        }
      }
    } else {
      ret = new Uint8Array(n);
      const retLen = n;
      while (idx < len) {
        const data: Uint8Array = buf[idx];
        if (n > data.length) {
          ret.set(data, retLen - n);
          n -= data.length;
          buf[idx++] = null;
        } else {
          if (n === data.length) {
            ret.set(data, retLen - n);
            buf[idx++] = null;
          } else {
            ret.set(data.subarray(0, n), retLen - n);
            buf[idx] = data.subarray(n);
          }
          break;
        }
      }
    }
  }

  if (idx === len) {
    state.buffer.length = 0;
    state.bufferIndex = 0;
  } else if (idx > 1024) {
    state.buffer.splice(0, idx);
    state.bufferIndex = 0;
  } else {
    state.bufferIndex = idx;
  }
  return ret;
}

function onEofChunk(stream: ReadableCore, state: ReadableState): void {
  if (state.ended) {
    return;
  }
  if (state.decoder) {
    const chunk = decoderEnd(state.decoder);
    if (chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  if (state.sync) {
    // Inside read(): defer, or flow() could re-enter read().
    emitReadable(stream);
  } else {
    state.needReadable = false;
    state.emittedReadable = true;
    emitReadableNT(stream);
  }
}

export function emitReadable(stream: ReadableCore): void {
  const state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(() => emitReadableNT(stream));
  }
}

function emitReadableNT(stream: ReadableCore): void {
  const state = stream._readableState;
  if (!state.destroyed && !state.errored && (state.length || state.ended)) {
    stream.emit("readable");
    state.emittedReadable = false;
  }

  // Another 'readable' is needed if we are paused, not ended, and below the mark.
  state.needReadable =
    state.needReadable ||
    (state.flowing !== true && !state.ended && state.length <= state.highWaterMark);
  flow(stream);
}

function maybeReadMore(stream: ReadableCore, state: ReadableState): void {
  if (!state.readingMore && !state.reading && state.constructed) {
    state.readingMore = true;
    nextTick(() => maybeReadMoreNT(stream, state));
  }
}

function maybeReadMoreNT(stream: ReadableCore, state: ReadableState): void {
  // Fill the buffer up to the mark, or keep a flowing stream fed. A pending
  // async _read (reading === true) ends the loop; its push() comes back here.
  while (
    !state.reading &&
    !state.ended &&
    (state.length < state.highWaterMark || (state.flowing === true && state.length === 0))
  ) {
    const len = state.length;
    stream.read(0);
    if (len === state.length) {
      break;
    }
  }
  state.readingMore = false;
}

export function updateReadableListening(stream: ReadableCore): void {
  const state = stream._readableState;
  state.readableListening = stream.listenerCount("readable") > 0;

  if (state.paused === false && state.resumeScheduled) {
    // A resume() is pending: it must flow when it runs.
    state.flowing = true;
  } else if (state.dataListening) {
    stream.resume();
  } else if (!state.readableListening) {
    state.flowing = null;
  }
}

export function scheduleResume(stream: ReadableCore, state: ReadableState): void {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    nextTick(() => resumeNT(stream, state));
  }
}

function resumeNT(stream: ReadableCore, state: ReadableState): void {
  if (!state.reading) {
    stream.read(0);
  }
  state.resumeScheduled = false;
  stream.emit("resume");
  flow(stream);
  if (state.flowing === true && !state.reading) {
    stream.read(0);
  }
}

function flow(stream: ReadableCore): void {
  const state = stream._readableState;
  while (state.flowing === true && stream.read() !== null) {
    // read() emits 'data'
  }
}

function endReadable(stream: ReadableCore): void {
  const state = stream._readableState;
  if (!state.endEmitted && !state.endScheduled) {
    state.ended = true;
    state.endScheduled = true;
    nextTick(() => endReadableNT(state, stream));
  }
}

function endReadableNT(state: ReadableState, stream: ReadableCore): void {
  state.endScheduled = false;

  // An unshift() since scheduling puts data back; then there is no end yet.
  if (!state.errored && !state.closeEmitted && !state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.emit("end");

    if (stream.writable && stream.allowHalfOpen === false) {
      nextTick(() => {
        if (stream.writable && !stream.writableEnded && !stream.destroyed) {
          stream.end?.();
        }
      });
    } else if (state.autoDestroy) {
      // A Duplex is destroyed once both sides are done.
      const wState = stream._writableState;
      const autoDestroy =
        !wState || (wState.autoDestroy && (wState.finished || wState.writable === false));
      if (autoDestroy) {
        stream.destroy();
      }
    }
  }
}

// =============================================================================
// pipe()
// =============================================================================

export function pipeImpl(src: ReadableCore, dest: any, pipeOpts?: { end?: boolean }): void {
  const state = src._readableState;

  if (state.pipes.length === 1 && !state.multiAwaitDrain) {
    state.multiAwaitDrain = true;
    state.awaitDrainWriters = new Set(state.awaitDrainWriters ? [state.awaitDrainWriters] : []);
  }

  state.pipes.push(dest);

  const doEnd = !pipeOpts || pipeOpts.end !== false;
  const endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) {
    nextTick(endFn);
  } else {
    src.once("end", endFn);
  }

  dest.on("unpipe", onunpipe);
  function onunpipe(readable: unknown, unpipeInfo?: { hasUnpiped: boolean }): void {
    if (readable === src && unpipeInfo && !unpipeInfo.hasUnpiped) {
      unpipeInfo.hasUnpiped = true;
      cleanup();
    }
  }

  function onend(): void {
    dest.end();
  }

  let ondrain: (() => void) | undefined;
  let cleanedUp = false;

  function cleanup(): void {
    dest.removeListener("close", onclose);
    dest.removeListener("finish", onfinish);
    if (ondrain) {
      dest.removeListener("drain", ondrain);
    }
    dest.removeListener("error", onerror);
    dest.removeListener("unpipe", onunpipe);
    src.removeListener("end", onend);
    src.removeListener("end", unpipe);
    src.removeListener("data", ondata);
    cleanedUp = true;

    // Stop waiting on this destination's 'drain', or the source never resumes.
    if (ondrain && state.awaitDrainWriters) {
      ondrain();
    }
  }

  function pause(): void {
    // An unpipe() during dest.write() must not leave the source paused.
    if (!cleanedUp) {
      if (state.pipes.length === 1 && state.pipes[0] === dest) {
        state.awaitDrainWriters = dest;
        state.multiAwaitDrain = false;
      } else if (state.pipes.length > 1 && state.pipes.includes(dest)) {
        state.awaitDrainWriters.add(dest);
      }
      src.pause();
    }
    if (!ondrain) {
      ondrain = pipeOnDrain(src, dest);
      dest.on("drain", ondrain);
    }
  }

  src.on("data", ondata);
  function ondata(chunk: unknown): void {
    try {
      if (dest.write(chunk) === false) {
        pause();
      }
    } catch (error) {
      dest.destroy(error);
    }
  }

  // Stop piping into a failed destination, without swallowing its error.
  function onerror(er: Error): void {
    unpipe();
    dest.removeListener("error", onerror);
    if (dest.listenerCount("error") === 0) {
      const s = dest._writableState || dest._readableState;
      if (s && !s.errorEmitted) {
        errorOrDestroy(dest, er);
      } else {
        dest.emit("error", er);
      }
    }
  }
  prependListener(dest, "error", onerror);

  function onclose(): void {
    dest.removeListener("finish", onfinish);
    unpipe();
  }
  dest.once("close", onclose);
  function onfinish(): void {
    dest.removeListener("close", onclose);
    unpipe();
  }
  dest.once("finish", onfinish);

  function unpipe(): void {
    src.unpipe(dest);
  }

  dest.emit("pipe", src);

  if (dest.writableNeedDrain === true) {
    pause();
  } else if (state.flowing !== true) {
    src.resume();
  }
}

/** Resume the source only once every destination it waits on has drained. */
function pipeOnDrain(src: ReadableCore, dest: unknown): () => void {
  return () => {
    const state = src._readableState;
    if (state.awaitDrainWriters === dest) {
      state.awaitDrainWriters = null;
    } else if (state.multiAwaitDrain) {
      state.awaitDrainWriters.delete(dest);
    }
    if ((!state.awaitDrainWriters || state.awaitDrainWriters.size === 0) && state.dataListening) {
      src.resume();
    }
  };
}

// =============================================================================
// Async iteration
// =============================================================================

export function streamToAsyncIterator(
  source: unknown,
  options: { destroyOnReturn?: boolean } | undefined,
  wrap: (legacy: unknown) => ReadableCore
): AsyncIterableIterator<unknown> & { stream: unknown } {
  // A legacy stream (no read()) is adopted into a Readable first.
  const stream =
    typeof (source as { read?: unknown }).read === "function"
      ? (source as ReadableCore)
      : wrap(source);
  const iter = createAsyncIterator(stream, options) as AsyncIterableIterator<unknown> & {
    stream: unknown;
  };
  iter.stream = stream;
  return iter;
}

type IterRequest =
  | { type: "next"; resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void }
  | { type: "return"; value: unknown; resolve: (r: IteratorResult<unknown>) => void }
  | { type: "throw"; value: unknown; reject: (e: unknown) => void };

/**
 * Async iterator over a Readable. It reads through `read()` and keeps no
 * buffer of its own; concurrent `next()` calls are queued and served in order.
 */
function createAsyncIterator(
  stream: ReadableCore,
  options?: { destroyOnReturn?: boolean }
): AsyncIterableIterator<unknown> {
  let callback: () => void = nop;
  // undefined: active, null: ended cleanly, otherwise the error.
  let error: Error | null | undefined;
  let started = false;
  let completed = false;
  let inFlight = false;
  let queue: IterRequest[] | null = null;
  let draining = false;
  let cleanup: () => void = nop;

  const onReadable = (): void => {
    const cb = callback;
    callback = nop;
    cb();
  };
  const waitForData = (): Promise<void> =>
    new Promise<void>(resolve => {
      callback = resolve;
    });

  function start(): void {
    started = true;
    stream.on("readable", onReadable);
    cleanup = eos(stream, { writable: false }, err => {
      error = err ? aggregateTwoErrors(error, err) : null;
      const cb = callback;
      callback = nop;
      cb();
    });
  }

  function finalize(): void {
    completed = true;
    const preserveHalfOpenDuplex =
      error === null &&
      stream.allowHalfOpen === true &&
      stream.writable === true &&
      stream.writableEnded !== true;

    if (
      (error || options?.destroyOnReturn !== false) &&
      (error === undefined || stream._readableState.autoDestroy) &&
      !preserveHalfOpenDuplex
    ) {
      destroyer(stream, null);
    } else {
      stream.removeListener("readable", onReadable);
      cleanup();
    }
  }

  function settleError(err: unknown, reject: (e: unknown) => void): void {
    error = aggregateTwoErrors(error, err as Error);
    finalize();
    reject(error);
  }

  function drain(): void {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (!inFlight && queue!.length > 0) {
        const req = queue!.shift()!;
        if (req.type === "next") {
          processNext(req.resolve, req.reject);
        } else if (req.type === "return") {
          processReturn(req.value, req.resolve);
        } else {
          processThrow(req.value, req.reject);
        }
      }
    } finally {
      draining = false;
    }
  }

  function settle(): void {
    inFlight = false;
    if (queue !== null) {
      drain();
    }
  }

  function pump(resolve: (r: IteratorResult<unknown>) => void, reject: (e: unknown) => void): void {
    const chunk = stream.destroyed ? null : stream.read();
    if (chunk !== null) {
      const then = (chunk as { then?: unknown }).then;
      if (typeof then === "function") {
        then.call(
          chunk,
          (value: unknown) => {
            inFlight = false;
            resolve({ done: false, value });
            if (queue !== null) {
              drain();
            }
          },
          (err: unknown) => {
            inFlight = false;
            settleError(err, reject);
            if (queue !== null) {
              drain();
            }
          }
        );
        return;
      }
      inFlight = false;
      resolve({ done: false, value: chunk });
      if (queue !== null) {
        drain();
      }
    } else if (error) {
      inFlight = false;
      settleError(error, reject);
      if (queue !== null) {
        drain();
      }
    } else if (error === null) {
      inFlight = false;
      finalize();
      resolve({ done: true, value: undefined });
      if (queue !== null) {
        drain();
      }
    } else {
      waitForData().then(() => pump(resolve, reject));
    }
  }

  function processNext(
    resolve: (r: IteratorResult<unknown>) => void,
    reject: (e: unknown) => void
  ): void {
    if (completed) {
      resolve({ done: true, value: undefined });
      return;
    }
    if (!started) {
      start();
    }
    inFlight = true;
    pump(resolve, reject);
  }

  function processReturn(value: unknown, resolve: (r: IteratorResult<unknown>) => void): void {
    if (!completed) {
      if (started) {
        finalize();
      } else {
        completed = true;
      }
    }
    resolve({ done: true, value });
  }

  function processThrow(err: unknown, reject: (e: unknown) => void): void {
    if (completed || !started) {
      completed = true;
      reject(err);
      return;
    }
    settleError(err, reject);
  }

  const enqueue = (req: IterRequest): void => {
    (queue ??= []).push(req);
  };

  return {
    next(): Promise<IteratorResult<unknown>> {
      if (!inFlight && !completed) {
        if (!started) {
          start();
        }
        // Fast path: a chunk is already buffered.
        const chunk = stream.destroyed ? null : stream.read();
        if (chunk !== null) {
          const then = (chunk as { then?: unknown }).then;
          if (typeof then === "function") {
            inFlight = true;
            return then.call(
              chunk,
              (value: unknown) => {
                settle();
                return { done: false, value };
              },
              (err: unknown) => {
                inFlight = false;
                error = aggregateTwoErrors(error, err as Error);
                finalize();
                if (queue !== null) {
                  drain();
                }
                throw error;
              }
            );
          }
          return Promise.resolve({ done: false, value: chunk });
        }
        if (error) {
          finalize();
          return Promise.reject(error);
        }
        if (error === null) {
          finalize();
          return Promise.resolve({ done: true, value: undefined });
        }
        inFlight = true;
        return new Promise((resolve, reject) => {
          waitForData().then(() => pump(resolve, reject));
        });
      }
      return new Promise((resolve, reject) => {
        if (inFlight) {
          enqueue({ type: "next", resolve, reject });
        } else {
          resolve({ done: true, value: undefined });
        }
      });
    },
    return(value?: unknown): Promise<IteratorResult<unknown>> {
      return new Promise(resolve => {
        if (inFlight) {
          enqueue({ type: "return", value, resolve });
        } else {
          processReturn(value, resolve);
        }
      });
    },
    throw(err?: unknown): Promise<IteratorResult<unknown>> {
      return new Promise((_resolve, reject) => {
        if (inFlight) {
          enqueue({ type: "throw", value: err, reject });
        } else {
          processThrow(err, reject);
        }
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
