/**
 * Stream kernel - Writable
 *
 * Port of Node.js `lib/internal/streams/writable.js`. Every write — from
 * `write()`, `end(chunk)`, a corked batch, a pipe or the Web adapter — enters
 * the same queue in `WritableState` and is dispatched by one scheduler, so
 * `_write` / `_writev` never overlap and `'finish'` waits for all of them.
 */

import {
  destroy as destroyImpl,
  errorOrDestroy,
  construct,
  undestroy
} from "@stream/kernel/destroy";
import { addAbortSignalNoValidate, eos } from "@stream/kernel/end-of-stream";
import {
  createAbortError,
  errInvalidArgType,
  errMethodNotImplemented,
  errMultipleCallback,
  errStreamAlreadyFinished,
  errStreamCannotPipe,
  errStreamDestroyed,
  errStreamNullValues,
  errStreamWriteAfterEnd,
  errUnknownEncoding
} from "@stream/kernel/errors";
import { Stream } from "@stream/kernel/legacy";
import type { StateOptions, WritableCore, WriteRequest } from "@stream/kernel/state";
import {
  WritableState,
  encodeStringChunk,
  isEncoding,
  nextTick,
  normalizeEncodingName,
  viewToBytes
} from "@stream/kernel/state";
import { writableFromWeb, writableToWeb } from "@stream/kernel/web-adapters";
import type { WritableStreamOptions, WriteCallback } from "@stream/types";

export interface WritableOptions<T = any> extends WritableStreamOptions, StateOptions {
  signal?: AbortSignal;
  write?: (this: Writable<T>, chunk: T, encoding: string, callback: WriteCallback) => void;
  writev?: (
    this: Writable<T>,
    chunks: Array<{ chunk: T; encoding: string }>,
    callback: WriteCallback
  ) => void;
  final?: (this: Writable<T>, callback: WriteCallback) => void;
  destroy?: (this: Writable<T>, error: Error | null, callback: WriteCallback) => void;
  construct?: (this: Writable<T>, callback: WriteCallback) => void;
}

/**
 * The writable half of the stream interface. `Writable` implements it and
 * `Duplex` shares the very same functions, so both run one write algorithm.
 */
export interface WritableSide<T> {
  _writableState: WritableState;
  write(chunk: T, callback?: WriteCallback): boolean;
  write(chunk: T, encoding?: string | null, callback?: WriteCallback): boolean;
  end(callback?: () => void): this;
  end(chunk: T, callback?: () => void): this;
  end(chunk: T, encoding?: string | null, callback?: () => void): this;
  cork(): void;
  uncork(): void;
  setDefaultEncoding(encoding: string): this;
  _write(chunk: T, encoding: string, callback: WriteCallback): void;
  /** Optional, as in Node: a subclass may define it as a method. */
  _writev?(chunks: Array<{ chunk: T; encoding: string }>, callback: WriteCallback): void;
  _final?(callback: WriteCallback): void;
  _construct?(callback: WriteCallback): void;
  writable: boolean;
  readonly writableHighWaterMark: number;
  readonly writableObjectMode: boolean;
  readonly writableBuffer: WriteRequest[];
  readonly writableLength: number;
  readonly writableFinished: boolean;
  readonly writableCorked: number;
  readonly writableEnded: boolean;
  readonly writableNeedDrain: boolean;
}

const nop = (): void => {};

export class Writable<T = any> extends Stream implements WritableSide<T> {
  static override [Symbol.hasInstance](instance: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, instance)) {
      return true;
    }
    if (this !== Writable) {
      return false;
    }
    // A Duplex is a Writable too, through its writable state.
    return (
      !!instance &&
      (instance as { _writableState?: unknown })._writableState instanceof WritableState
    );
  }

  _writableState: WritableState;

  _writev?(chunks: Array<{ chunk: T; encoding: string }>, callback: WriteCallback): void;
  _final?(callback: WriteCallback): void;
  _construct?(callback: WriteCallback): void;

  /** Installed below where the runtime has `Symbol.asyncDispose`, for `await using`. */
  declare [Symbol.asyncDispose]: () => Promise<void>;

  constructor(options?: WritableOptions<T>) {
    super();
    this._writableState = createWritableState(this, options, false);
    initWritable(this, options);
    if (this._construct != null) {
      construct(this, () => onWritableConstructed(this));
    }
  }

  static fromWeb<T>(
    writableStream: WritableStream<T>,
    options?: WritableStreamOptions & { decodeStrings?: boolean; signal?: AbortSignal }
  ): Writable<T> {
    return writableFromWeb(Writable, writableStream, options, "node") as Writable<T>;
  }

  static toWeb<T>(streamWritable: Writable<T>): WritableStream<T> {
    return writableToWeb(streamWritable, "node");
  }

  /** Writables cannot be piped from. */
  pipe(): void {
    errorOrDestroy(this, errStreamCannotPipe());
  }

  write(chunk: T, callback?: WriteCallback): boolean;
  write(chunk: T, encoding?: string | null, callback?: WriteCallback): boolean;
  write(chunk: T, encoding?: string | null | WriteCallback, cb?: WriteCallback): boolean {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = null;
    }
    return writeImpl(this, chunk, encoding, cb) === true;
  }

  cork(): void {
    this._writableState.corked++;
  }

  uncork(): void {
    const state = this._writableState;
    if (state.corked) {
      state.corked--;
      if (!state.writing) {
        clearBuffer(this, state);
      }
    }
  }

  setDefaultEncoding(encoding: string): this {
    const enc = typeof encoding === "string" ? encoding.toLowerCase() : encoding;
    if (!isEncoding(enc)) {
      throw errUnknownEncoding(encoding);
    }
    this._writableState.defaultEncoding = normalizeEncodingName(enc);
    return this;
  }

  _write(chunk: T, encoding: string, cb: WriteCallback): void {
    if (this._writev) {
      this._writev([{ chunk, encoding }], cb);
    } else {
      throw errMethodNotImplemented("_write()");
    }
  }

  end(callback?: () => void): this;
  end(chunk: T, callback?: () => void): this;
  end(chunk: T, encoding?: string | null, callback?: () => void): this;
  end(chunk?: T | (() => void), encoding?: string | null | (() => void), cb?: WriteCallback): this {
    const state = this._writableState;

    if (typeof chunk === "function") {
      cb = chunk as WriteCallback;
      chunk = undefined;
      encoding = null;
    } else if (typeof encoding === "function") {
      cb = encoding as WriteCallback;
      encoding = null;
    }

    let err: Error | undefined;
    if (chunk != null) {
      const ret = writeImpl(this, chunk as T, encoding as string | null | undefined);
      if (ret instanceof Error) {
        err = ret;
      }
    }

    // end() fully uncorks.
    if (state.corked) {
      state.corked = 1;
      this.uncork();
    }

    if (err) {
      // Reported by writeImpl.
    } else if (!state.ending && !state.errored) {
      // Forgiving on purpose: a redundant end() is harmless, an error here is not.
      state.ending = true;
      finishMaybe(this, state, true);
      state.ended = true;
    } else if (state.finished) {
      err = errStreamAlreadyFinished("end");
    } else if (state.destroyed) {
      err = errStreamDestroyed("end");
    }

    if (typeof cb === "function") {
      const callback = cb;
      if (err) {
        const e = err;
        nextTick(() => callback(e));
      } else if (state.errored) {
        const e = state.errored;
        nextTick(() => callback(e));
      } else if (state.finished) {
        nextTick(() => callback(null));
      } else {
        state.onFinished.push(callback);
      }
    }
    return this;
  }

  destroy(error?: Error | null, callback?: WriteCallback): this {
    const state = this._writableState;
    // Fail pending write and end() callbacks.
    if (!state.destroyed && (state.bufferedRequestCount > 0 || state.onFinished.length > 0)) {
      nextTick(() => errorBuffer(state));
    }
    destroyImpl.call(this, error, callback);
    return this;
  }

  _undestroy(): void {
    undestroy.call(this);
  }

  _destroy(error: Error | null, callback: WriteCallback): void {
    callback(error);
  }

  get closed(): boolean {
    return this._writableState ? this._writableState.closed : false;
  }

  get destroyed(): boolean {
    return this._writableState ? this._writableState.destroyed : false;
  }

  set destroyed(value: boolean) {
    if (this._writableState) {
      this._writableState.destroyed = value;
    }
  }

  get errored(): Error | null {
    return this._writableState ? this._writableState.errored : null;
  }

  get writable(): boolean {
    const w = this._writableState;
    // w.writable === false: the writable side of a Duplex was disabled.
    return !!w && w.writable !== false && !w.ending && !w.ended && !w.destroyed && !w.errored;
  }

  set writable(value: boolean) {
    if (this._writableState) {
      this._writableState.writable = !!value;
    }
  }

  get writableFinished(): boolean {
    return this._writableState ? this._writableState.finished : false;
  }

  get writableObjectMode(): boolean {
    return this._writableState ? this._writableState.objectMode : false;
  }

  get writableBuffer(): WriteRequest[] {
    return this._writableState?.getBuffer();
  }

  get writableEnded(): boolean {
    return this._writableState ? this._writableState.ending : false;
  }

  get writableNeedDrain(): boolean {
    const w = this._writableState;
    return w ? !w.destroyed && !w.ending && w.needDrain : false;
  }

  get writableHighWaterMark(): number {
    return this._writableState?.highWaterMark;
  }

  get writableCorked(): number {
    return this._writableState ? this._writableState.corked : 0;
  }

  get writableLength(): number {
    return this._writableState?.length;
  }

  get writableAborted(): boolean {
    const w = this._writableState;
    return w.writable !== false && (w.destroyed || !!w.errored) && !w.finished;
  }
}

// Node's prototype carries an explicit `null`; `_writev` is otherwise typed as
// the optional method a subclass defines.
(Writable.prototype as { _writev: unknown })._writev = null;

if (typeof Symbol.asyncDispose === "symbol") {
  Object.defineProperty(Writable.prototype, Symbol.asyncDispose, {
    configurable: true,
    writable: true,
    value: async function (this: Writable<unknown>): Promise<void> {
      if (!this.destroyed) {
        this.destroy(this.writableFinished ? null : createAbortError());
      }
      await new Promise<void>((resolve, reject) => {
        eos(this, err => (err && err.name !== "AbortError" ? reject(err) : resolve()));
      });
    }
  });
}

// =============================================================================
// Construction
// =============================================================================

export function createWritableState(
  stream: WritableCore,
  options: StateOptions | undefined,
  isDuplex: boolean
): WritableState {
  return new WritableState(options, isDuplex, er => onwrite(stream, er));
}

/** Apply the options shared by Writable and Duplex. */
export function initWritable(stream: WritableCore, options?: WritableOptions<any>): void {
  if (!options) {
    return;
  }
  if (typeof options.write === "function") {
    stream._write = options.write;
  }
  if (typeof options.writev === "function") {
    stream._writev = options.writev;
  }
  if (typeof options.destroy === "function") {
    stream._destroy = options.destroy;
  }
  if (typeof options.final === "function") {
    stream._final = options.final;
  }
  if (typeof options.construct === "function") {
    stream._construct = options.construct;
  }
  if (options.signal) {
    addAbortSignalNoValidate(options.signal, stream);
  }
}

export function onWritableConstructed(stream: WritableCore): void {
  const state: WritableState = stream._writableState;
  if (!state.writing) {
    clearBuffer(stream, state);
  }
  if (state.ending) {
    finishMaybe(stream, state);
  }
}

// =============================================================================
// write()
// =============================================================================

function writeImpl(
  stream: WritableCore,
  chunk: any,
  encoding: string | null | undefined,
  cb?: WriteCallback
): boolean | Error {
  const state: WritableState = stream._writableState;

  if (cb == null || typeof cb !== "function") {
    cb = nop;
  }

  if (chunk === null) {
    throw errStreamNullValues();
  }

  let enc: string;
  if (!state.objectMode) {
    if (!encoding) {
      enc = state.defaultEncoding;
    } else if (encoding !== "buffer" && !isEncoding(encoding)) {
      throw errUnknownEncoding(encoding);
    } else {
      enc = encoding === "buffer" ? "buffer" : normalizeEncodingName(encoding);
    }

    if (typeof chunk === "string") {
      if (enc === "buffer") {
        throw errUnknownEncoding(enc);
      }
      if (state.decodeStrings) {
        chunk = encodeStringChunk(chunk, enc);
        enc = "buffer";
      }
    } else if (chunk instanceof Uint8Array) {
      enc = "buffer";
    } else if (ArrayBuffer.isView(chunk)) {
      chunk = viewToBytes(chunk);
      enc = "buffer";
    } else {
      throw errInvalidArgType("chunk", ["string", "Buffer", "TypedArray", "DataView"], chunk);
    }
  } else {
    // Object mode passes the caller's encoding through untouched (usually undefined).
    enc = encoding as string;
  }

  let err: Error | undefined;
  if (state.ending) {
    err = errStreamWriteAfterEnd();
  } else if (state.destroyed) {
    err = errStreamDestroyed("write");
  }

  if (err) {
    const callback = cb;
    const e = err;
    nextTick(() => callback(e));
    errorOrDestroy(stream, err, true);
    return err;
  }

  state.pendingcb++;
  return writeOrBuffer(stream, state, chunk, enc, cb);
}

/** Write now if idle, otherwise queue behind the write in progress. */
function writeOrBuffer(
  stream: WritableCore,
  state: WritableState,
  chunk: any,
  encoding: string,
  callback: WriteCallback
): boolean {
  const len = state.objectMode ? 1 : chunk.length;
  state.length += len;

  if (state.writing || state.errored || state.corked || !state.constructed) {
    state.buffered.push({ chunk, encoding, callback });
    if (state.allBuffers && encoding !== "buffer") {
      state.allBuffers = false;
    }
    if (state.allNoop && callback !== nop) {
      state.allNoop = false;
    }
  } else {
    state.writelen = len;
    if (callback !== nop) {
      state.writecb = callback;
    }
    state.writing = true;
    state.sync = true;
    state.expectWriteCb = true;
    stream._write(chunk, encoding, state.onwrite);
    state.sync = false;
  }

  const ret = state.length < state.highWaterMark || state.length === 0;
  if (!ret) {
    state.needDrain = true;
  }
  // false once errored or destroyed, to break `while (stream.write(x))` loops.
  return ret && !state.destroyed && !state.errored;
}

function doWrite(
  stream: WritableCore,
  state: WritableState,
  writev: boolean,
  len: number,
  chunk: any,
  encoding: string,
  cb: WriteCallback
): void {
  state.writelen = len;
  if (cb !== nop) {
    state.writecb = cb;
  }
  state.writing = true;
  state.sync = true;
  state.expectWriteCb = true;
  if (state.destroyed) {
    state.onwrite(errStreamDestroyed("write"));
  } else if (writev) {
    // Only reached from clearBuffer, which batches solely when _writev exists.
    stream._writev!(chunk, state.onwrite);
  } else {
    stream._write(chunk, encoding, state.onwrite);
  }
  state.sync = false;
}

function onwriteError(
  stream: WritableCore,
  state: WritableState,
  er: Error,
  cb: WriteCallback
): void {
  --state.pendingcb;
  cb(er);
  // The error belongs to one write; the queued ones fail as destroyed.
  errorBuffer(state);
  // 'error' must follow the write callback.
  errorOrDestroy(stream, er);
}

/** The callback `_write` / `_writev` receive. */
function onwrite(stream: WritableCore, er?: Error | null): void {
  const state: WritableState = stream._writableState;

  if (!state.expectWriteCb) {
    errorOrDestroy(stream, errMultipleCallback());
    return;
  }

  const sync = state.sync;
  const cb = state.writecb ?? nop;

  state.writecb = null;
  state.writing = false;
  state.expectWriteCb = false;
  state.length -= state.writelen;
  state.writelen = 0;

  if (er) {
    if (!state.errored) {
      state.errored = er;
    }
    // A Duplex's readable side fails with it.
    if (stream._readableState && !stream._readableState.errored) {
      stream._readableState.errored = er;
    }
    if (sync) {
      nextTick(() => onwriteError(stream, state, er, cb));
    } else {
      onwriteError(stream, state, er, cb);
    }
    return;
  }

  if (state.bufferedRequestCount > 0) {
    clearBuffer(stream, state);
  }

  if (sync) {
    // A synchronous _write: defer the user callback and 'drain' so they never
    // run inside the write() that caused them. Repeated callbacks are batched.
    const needDrain = state.needDrain && state.length === 0;
    // Node writes `state[kState] & kDestroyed !== 0`, which by precedence is
    // `state[kState] & 1` — the object-mode bit. Object-mode writes therefore
    // complete a tick later, which moves 'finish' behind other streams' events
    // (a piped source's 'close', for one). Kept, so event order matches Node.
    const needTick = needDrain || state.destroyed || state.objectMode || cb !== nop;

    if (cb === nop) {
      if (!state.afterWritePending && needTick) {
        state.afterWritePending = true;
        nextTick(() => afterWrite(stream, state, 1, cb));
      } else {
        state.pendingcb--;
        if (state.ending) {
          finishMaybe(stream, state, true);
        }
      }
    } else if (state.afterWriteTickInfo !== null && state.afterWriteTickInfo.cb === cb) {
      state.afterWriteTickInfo.count++;
    } else if (needTick) {
      const info = { count: 1, cb, stream, state };
      state.afterWriteTickInfo = info;
      state.afterWritePending = true;
      nextTick(() => afterWriteTick(info));
    } else {
      state.pendingcb--;
      if (state.ending) {
        finishMaybe(stream, state, true);
      }
    }
  } else {
    afterWrite(stream, state, 1, cb);
  }
}

function afterWriteTick(info: {
  count: number;
  cb: WriteCallback;
  stream: WritableCore;
  state: WritableState;
}): void {
  info.state.afterWriteTickInfo = null;
  afterWrite(info.stream, info.state, info.count, info.cb);
}

function afterWrite(
  stream: WritableCore,
  state: WritableState,
  count: number,
  cb: WriteCallback
): void {
  state.afterWritePending = false;

  const needDrain = !state.ending && !state.destroyed && state.needDrain && state.length === 0;
  if (needDrain) {
    state.needDrain = false;
    stream.emit("drain");
  }

  while (count-- > 0) {
    state.pendingcb--;
    cb(null);
  }

  if (state.destroyed) {
    errorBuffer(state);
  }

  if (state.ending) {
    finishMaybe(stream, state, true);
  }
}

/** Fail every queued write and end() callback. */
function errorBuffer(state: WritableState): void {
  if (state.writing) {
    return;
  }

  for (let n = state.bufferedIndex; n < state.buffered.length; ++n) {
    const { chunk, callback } = state.buffered[n]!;
    state.length -= state.objectMode ? 1 : chunk.length;
    callback(state.errored ?? errStreamDestroyed("write"));
  }

  callFinishedCallbacks(state, state.errored ?? errStreamDestroyed("end"));
  resetBuffer(state);
}

function resetBuffer(state: WritableState): void {
  state.buffered = [];
  state.bufferedIndex = 0;
  state.allBuffers = true;
  state.allNoop = true;
}

/** Dispatch queued writes: one `_writev` for the batch, or `_write` one by one. */
function clearBuffer(stream: WritableCore, state: WritableState): void {
  if (
    state.destroyed ||
    state.bufferProcessing ||
    state.corked ||
    !state.constructed ||
    state.bufferedRequestCount === 0
  ) {
    return;
  }

  const buffered = state.buffered;
  const bufferedLength = buffered.length - state.bufferedIndex;
  let i = state.bufferedIndex;

  state.bufferProcessing = true;
  if (bufferedLength > 1 && stream._writev) {
    state.pendingcb -= bufferedLength - 1;

    const callback: WriteCallback = state.allNoop
      ? nop
      : err => {
          for (let n = i; n < buffered.length; ++n) {
            buffered[n]!.callback(err);
          }
        };
    // `_writev` may consume the array it is given; hand it a copy whenever the
    // completion callback still needs the originals.
    const chunks = (state.allNoop && i === 0 ? buffered : buffered.slice(i)) as WriteRequest[] & {
      allBuffers?: boolean;
    };
    chunks.allBuffers = state.allBuffers;

    doWrite(stream, state, true, state.length, chunks, "", callback);
    resetBuffer(state);
  } else {
    do {
      const { chunk, encoding, callback } = buffered[i]!;
      buffered[i++] = null!;
      const len = state.objectMode ? 1 : chunk.length;
      doWrite(stream, state, false, len, chunk, encoding, callback);
    } while (i < buffered.length && !state.writing);

    if (i === buffered.length) {
      resetBuffer(state);
    } else if (i > 256) {
      buffered.splice(0, i);
      state.bufferedIndex = 0;
    } else {
      state.bufferedIndex = i;
    }
  }
  state.bufferProcessing = false;
}

// =============================================================================
// end() → 'prefinish' → 'finish'
// =============================================================================

function needFinish(state: WritableState): boolean {
  return (
    state.ending &&
    !state.destroyed &&
    state.constructed &&
    !state.finished &&
    !state.writing &&
    !state.errorEmitted &&
    !state.closeEmitted &&
    !state.errored &&
    state.bufferedRequestCount === 0 &&
    state.length === 0
  );
}

function onFinish(stream: WritableCore, state: WritableState, err?: Error | null): void {
  if (state.prefinished) {
    errorOrDestroy(stream, err ?? errMultipleCallback());
    return;
  }
  state.pendingcb--;
  if (err) {
    callFinishedCallbacks(state, err);
    errorOrDestroy(stream, err, state.sync);
  } else if (needFinish(state)) {
    state.prefinished = true;
    stream.emit("prefinish");
    // 'finish' stays asynchronous relative to the _final callback.
    state.pendingcb++;
    nextTick(() => finish(stream, state));
  }
}

function prefinish(stream: WritableCore, state: WritableState): void {
  if (state.prefinished || state.finalCalled) {
    return;
  }
  if (typeof stream._final === "function" && !state.destroyed) {
    state.finalCalled = true;
    state.sync = true;
    state.pendingcb++;
    try {
      stream._final((err?: Error | null) => onFinish(stream, state, err));
    } catch (err) {
      onFinish(stream, state, err as Error);
    }
    state.sync = false;
  } else {
    state.finalCalled = true;
    state.prefinished = true;
    stream.emit("prefinish");
  }
}

function finishMaybe(stream: WritableCore, state: WritableState, sync?: boolean): void {
  if (!needFinish(state)) {
    return;
  }
  prefinish(stream, state);
  if (state.pendingcb === 0) {
    if (sync) {
      state.pendingcb++;
      nextTick(() => {
        if (needFinish(state)) {
          finish(stream, state);
        } else {
          state.pendingcb--;
        }
      });
    } else if (needFinish(state)) {
      state.pendingcb++;
      finish(stream, state);
    }
  }
}

function finish(stream: WritableCore, state: WritableState): void {
  state.pendingcb--;
  state.finished = true;

  callFinishedCallbacks(state, null);
  stream.emit("finish");

  if (state.autoDestroy) {
    // A Duplex is destroyed once both sides are done.
    const rState = stream._readableState;
    const autoDestroy =
      !rState || (rState.autoDestroy && (rState.endEmitted || rState.readable === false));
    if (autoDestroy) {
      stream.destroy();
    }
  }
}

function callFinishedCallbacks(state: WritableState, err: Error | null): void {
  if (state.onFinished.length === 0) {
    return;
  }
  const callbacks = state.onFinished;
  state.onFinished = [];
  for (const cb of callbacks) {
    cb(err);
  }
}
