/**
 * Stream kernel - the stream classes
 *
 * Ports of Node.js `Readable`, `Duplex`, `Transform` and `PassThrough`. They
 * share one module because they depend on each other both ways:
 * `Readable.prototype.compose` builds a `Duplex`, which is a `Readable`. Node
 * resolves that with a lazy CommonJS `require`; here the classes sit together
 * and hand themselves to `compose` / `pipeline` / `Duplex.from` as a
 * `StreamKernel`, so the dependency is static and there is no registration a
 * bundler could tree-shake away.
 *
 * The algorithms live in `readable-impl.ts` and `writable.ts`; these classes
 * hold the public surface.
 */

import { composeImpl } from "@stream/kernel/compose-impl";
import { construct, destroy, destroyer, errorOrDestroy, undestroy } from "@stream/kernel/destroy";
import { duplexify } from "@stream/kernel/duplexify";
import { eos } from "@stream/kernel/end-of-stream";
import {
  createAbortError,
  errInvalidArgType,
  errMethodNotImplemented
} from "@stream/kernel/errors";
import { from } from "@stream/kernel/from";
import { Stream } from "@stream/kernel/legacy";
import * as operators from "@stream/kernel/operators";
import type { OperatorOptions } from "@stream/kernel/operators";
import {
  addChunkPushByteMode,
  addChunkPushObjectMode,
  addChunkUnshiftByteMode,
  addChunkUnshiftObjectMode,
  emitReadable,
  initReadable,
  onReadableConstructed,
  pipeImpl,
  readImpl,
  scheduleResume,
  streamToAsyncIterator,
  updateReadableListening
} from "@stream/kernel/readable-impl";
import type { StateOptions, StreamKernel } from "@stream/kernel/state";
import {
  ReadableState,
  decoderEnd,
  decoderWrite,
  getHighWaterMark,
  kIsDuplex,
  nextTick,
  normalizeEncodingName
} from "@stream/kernel/state";
import {
  duplexFromWeb,
  duplexToWeb,
  readableFromWeb,
  readableToWeb
} from "@stream/kernel/web-adapters";
import {
  Writable,
  createWritableState,
  initWritable,
  onWritableConstructed
} from "@stream/kernel/writable";
import type { WritableOptions, WritableSide } from "@stream/kernel/writable";
import type {
  DuplexStreamOptions,
  ReadableStreamOptions,
  TransformCallback,
  WritableLike,
  WriteCallback
} from "@stream/types";
import { createStreamDecoder } from "@utils/binary";

// =============================================================================
// Readable
// =============================================================================

export interface ReadableOptions<T = any> extends ReadableStreamOptions, StateOptions {
  signal?: AbortSignal;
  read?: (this: Readable<T>, size: number) => void;
  destroy?: (
    this: Readable<T>,
    error: Error | null,
    callback: (error?: Error | null) => void
  ) => void;
  construct?: (this: Readable<T>, callback: (error?: Error | null) => void) => void;
}

/** What `Readable.from` takes: Node's, with a Web stream read as an async iterable. */
type ReadableSourceLike<T> = Iterable<T> | AsyncIterable<T> | ReadableStream<T>;

/**
 * Type parameters default to `any`, as Node's own (non-generic) classes do, so
 * code written for both builds type-checks the same; pass them to opt in.
 */
export class Readable<T = any> extends Stream {
  _readableState: ReadableState;

  _construct?(callback: (error?: Error | null) => void): void;

  /** Installed below where the runtime has `Symbol.asyncDispose`, for `await using`. */
  declare [Symbol.asyncDispose]: () => Promise<void>;

  constructor(options?: ReadableOptions<T>) {
    super();
    if ((new.target as { [kIsDuplex]?: boolean })[kIsDuplex]) {
      // Duplex sets up both sides and runs one construct() for them.
      this._readableState = new ReadableState(options, true);
      return;
    }
    this._readableState = new ReadableState(options, false);
    initReadable(this, options);
    if (this._construct != null) {
      construct(this, () => onReadableConstructed(this));
    }
  }

  // ---------------------------------------------------------------------------
  // Factories and Web interop
  // ---------------------------------------------------------------------------

  /**
   * Values are awaited, as Node awaits them, so the stream yields what each
   * resolves to. Object mode is the default; with `objectMode: false` every
   * chunk reads back as a `Uint8Array`.
   */
  static from<T>(
    iterable: ReadableSourceLike<T>,
    options?: ReadableOptions<Awaited<T>> & { objectMode?: true }
  ): Readable<Awaited<T>>;
  static from(
    iterable: ReadableSourceLike<string | ArrayBufferView>,
    options: ReadableOptions<Uint8Array> & { objectMode: false }
  ): Readable<Uint8Array>;
  static from<T>(iterable: ReadableSourceLike<T>, options?: ReadableOptions): Readable;
  static from(iterable: unknown, options?: ReadableOptions): Readable {
    return from(Readable, iterable, options as Record<string, unknown>) as Readable;
  }

  /**
   * Untyped, as Node declares it: what it yields depends on the mode (bytes by
   * default, decoded strings with an `encoding`). The module's
   * `readableFromWeb` types each case.
   */
  static fromWeb(
    readableStream: ReadableStream,
    options?: ReadableStreamOptions & { encoding?: string; signal?: AbortSignal }
  ): Readable {
    return readableFromWeb(Readable, readableStream, options, "node") as Readable;
  }

  static toWeb<T>(
    streamReadable: Readable<T>,
    options?: { strategy?: QueuingStrategy<T> }
  ): ReadableStream<T> {
    return readableToWeb(streamReadable, options, "node");
  }

  static wrap<T>(src: any, options?: ReadableOptions<T>): Readable<T> {
    return new Readable<T>({
      objectMode: src.readableObjectMode ?? src.objectMode ?? true,
      ...options,
      destroy(err, callback) {
        destroyer(src, err);
        callback(err);
      }
    }).wrap(src);
  }

  // ---------------------------------------------------------------------------
  // Producer side
  // ---------------------------------------------------------------------------

  /**
   * Add a chunk to the read buffer. Returns `false` once the buffer reaches
   * `highWaterMark`; the producer should then wait for the next `_read()`.
   */
  push(chunk: T | null, encoding?: string): boolean {
    const state = this._readableState;
    return state.objectMode
      ? addChunkPushObjectMode(this, state, chunk, encoding)
      : addChunkPushByteMode(this, state, chunk, encoding);
  }

  /** Put a chunk back at the front of the read buffer. */
  unshift(chunk: T | null, encoding?: string): boolean {
    const state = this._readableState;
    return state.objectMode
      ? addChunkUnshiftObjectMode(this, state, chunk)
      : addChunkUnshiftByteMode(this, state, chunk, encoding);
  }

  _read(_size: number): void {
    throw errMethodNotImplemented("_read()");
  }

  // ---------------------------------------------------------------------------
  // Consumer side
  // ---------------------------------------------------------------------------

  read(n?: number): T | null {
    return readImpl(this, n) as T | null;
  }

  isPaused(): boolean {
    const state = this._readableState;
    return state.paused === true || state.flowing === false;
  }

  setEncoding(encoding: string): this {
    const state = this._readableState;
    const decoder = createStreamDecoder(encoding);
    state.decoder = decoder;
    state.encoding = normalizeEncodingName(encoding);

    // Re-decode what is already buffered so every later read is a string.
    let content = "";
    for (let i = state.bufferIndex; i < state.buffer.length; i++) {
      const data = state.buffer[i];
      content += typeof data === "string" ? data : decoderWrite(decoder, data);
    }
    if (state.ended) {
      content += decoderEnd(decoder);
    }
    state.buffer.length = 0;
    state.bufferIndex = 0;
    if (content !== "") {
      state.buffer.push(content);
    }
    state.length = content.length;
    return this;
  }

  resume(): this {
    const state = this._readableState;
    if (state.destroyed) {
      return this;
    }
    if (state.flowing !== true) {
      // Flow only if nobody listens for 'readable'.
      state.flowing = !state.readableListening;
      scheduleResume(this, state);
    }
    state.paused = false;
    return this;
  }

  pause(): this {
    const state = this._readableState;
    if (state.destroyed) {
      return this;
    }
    if (state.flowing !== false) {
      state.flowing = false;
      this.emit("pause");
    }
    state.paused = true;
    return this;
  }

  pipe<W extends WritableLike>(dest: W, pipeOpts?: { end?: boolean }): W {
    pipeImpl(this, dest, pipeOpts);
    return dest;
  }

  unpipe(dest?: WritableLike): this {
    const state = this._readableState;
    if (state.pipes.length === 0) {
      return this;
    }

    if (!dest) {
      const dests = state.pipes;
      state.pipes = [];
      this.pause();
      for (const d of dests) {
        d.emit("unpipe", this, { hasUnpiped: false });
      }
      return this;
    }

    const index = state.pipes.indexOf(dest);
    if (index === -1) {
      return this;
    }
    state.pipes.splice(index, 1);
    if (state.pipes.length === 0) {
      this.pause();
    }
    dest.emit("unpipe", this, { hasUnpiped: false });
    return this;
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    Stream.prototype.on.call(this, event, listener);
    const state = this._readableState;

    if (event === "data") {
      state.dataListening = true;
      // Let resume() be a no-op below when someone listens for 'readable'.
      state.readableListening = this.listenerCount("readable") > 0 || state.readableListening;
      if (state.flowing !== false) {
        this.resume();
      }
    } else if (event === "readable") {
      if (!state.endEmitted && !state.readableListening) {
        state.readableListening = true;
        state.needReadable = true;
        state.flowing = false;
        state.emittedReadable = false;
        if (state.length) {
          emitReadable(this);
        } else if (!state.reading) {
          nextTick(() => this.read(0));
        }
      }
    }
    return this;
  }

  override removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    Stream.prototype.removeListener.call(this, event, listener);
    const state = this._readableState;
    if (event === "readable") {
      // Deferred so a once('readable') → read() → once('readable') cycle keeps
      // the stream paused rather than flipping into flowing mode in between.
      nextTick(() => updateReadableListening(this));
    } else if (event === "data" && this.listenerCount("data") === 0) {
      state.dataListening = false;
    }
    return this;
  }

  override removeAllListeners(event?: string | symbol): this {
    Stream.prototype.removeAllListeners.call(this, event);
    if (event === "readable" || event === undefined) {
      nextTick(() => updateReadableListening(this));
    }
    return this;
  }

  /** Adopt an old-style (`'data'` / `'end'` emitting) stream as this stream's source. */
  wrap(stream: any): this {
    let paused = false;

    stream.on("data", (chunk: T) => {
      if (!this.push(chunk) && stream.pause) {
        paused = true;
        stream.pause();
      }
    });
    stream.on("end", () => {
      this.push(null);
    });
    stream.on("error", (err: Error) => {
      errorOrDestroy(this, err);
    });
    stream.on("close", () => {
      this.destroy();
    });
    stream.on("destroy", () => {
      this.destroy();
    });

    this._read = () => {
      if (paused && stream.resume) {
        paused = false;
        stream.resume();
      }
    };

    // Proxy the wrapped stream's other methods, as Node does.
    for (const key of Object.keys(stream)) {
      if ((this as any)[key] === undefined && typeof stream[key] === "function") {
        (this as any)[key] = stream[key].bind(stream);
      }
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  destroy(error?: Error | null, callback?: (error?: Error | null) => void): this {
    destroy.call(this, error, callback);
    return this;
  }

  _undestroy(): void {
    undestroy.call(this);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    callback(error);
  }

  // ---------------------------------------------------------------------------
  // Async iteration and helpers
  // ---------------------------------------------------------------------------

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return streamToAsyncIterator(this, undefined, wrapLegacy) as AsyncIterableIterator<T>;
  }

  iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<T> {
    if (options !== undefined && (options === null || typeof options !== "object")) {
      throw errInvalidArgType("options", "Object", options);
    }
    return streamToAsyncIterator(this, options, wrapLegacy) as AsyncIterableIterator<T>;
  }

  map<U>(
    fn: (data: T, options: { signal: AbortSignal }) => U | Promise<U>,
    options?: OperatorOptions
  ): Readable<U> {
    return Readable.from(operators.map.call(this, fn, options)) as Readable<U>;
  }

  filter(
    fn: (data: T, options: { signal: AbortSignal }) => unknown,
    options?: OperatorOptions
  ): Readable<T> {
    return Readable.from(operators.filter.call(this, fn, options)) as Readable<T>;
  }

  flatMap<U>(
    fn: (
      data: T,
      options: { signal: AbortSignal }
    ) => Iterable<U> | AsyncIterable<U> | Promise<Iterable<U> | AsyncIterable<U>>,
    options?: OperatorOptions
  ): Readable<U> {
    return Readable.from(operators.flatMap.call(this, fn, options)) as Readable<U>;
  }

  drop(limit: number, options?: { signal?: AbortSignal }): Readable<T> {
    return Readable.from(operators.drop.call(this, limit, options)) as Readable<T>;
  }

  take(limit: number, options?: { signal?: AbortSignal }): Readable<T> {
    return Readable.from(operators.take.call(this, limit, options)) as Readable<T>;
  }

  forEach(
    fn: (data: T, options: { signal: AbortSignal }) => void | Promise<void>,
    options?: OperatorOptions
  ): Promise<void> {
    return operators.forEach.call(this, fn, options);
  }

  toArray(options?: { signal?: AbortSignal }): Promise<T[]> {
    return operators.toArray.call(this, options) as Promise<T[]>;
  }

  some(
    fn: (data: T, options: { signal: AbortSignal }) => unknown,
    options?: OperatorOptions
  ): Promise<boolean> {
    return operators.some.call(this, fn, options);
  }

  every(
    fn: (data: T, options: { signal: AbortSignal }) => unknown,
    options?: OperatorOptions
  ): Promise<boolean> {
    return operators.every.call(this, fn, options);
  }

  find(
    fn: (data: T, options: { signal: AbortSignal }) => unknown,
    options?: OperatorOptions
  ): Promise<T | undefined> {
    return operators.find.call(this, fn, options) as Promise<T | undefined>;
  }

  reduce<U = T>(
    fn: (previous: U, data: T, options: { signal: AbortSignal }) => U | Promise<U>,
    ...rest: [initial?: U, options?: { signal?: AbortSignal }]
  ): Promise<U> {
    return operators.reduce.call(this, fn, ...rest) as Promise<U>;
  }

  compose<U = unknown>(stream: unknown, options?: { signal?: AbortSignal }): Readable<U> {
    if (options != null && typeof options !== "object") {
      throw errInvalidArgType("options", "Object", options);
    }
    if (options?.signal != null && !(options.signal instanceof AbortSignal)) {
      throw errInvalidArgType("options.signal", "AbortSignal", options.signal);
    }
    const composed = composeImpl(kernel, this, stream) as Readable<U>;
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        composed.destroy(createAbortError(signal.reason));
      } else {
        const onAbort = (): void => {
          composed.destroy(createAbortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        eos(composed, () => signal.removeEventListener("abort", onAbort));
      }
    }
    return composed;
  }

  // ---------------------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------------------

  get readable(): boolean {
    const r = this._readableState;
    // r.readable === false: the readable side of a Duplex was disabled.
    return !!r && r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
  }

  set readable(value: boolean) {
    if (this._readableState) {
      this._readableState.readable = !!value;
    }
  }

  get readableDidRead(): boolean {
    return this._readableState.dataEmitted;
  }

  get readableAborted(): boolean {
    const r = this._readableState;
    return !!(r.readable !== false && (r.destroyed || r.errored) && !r.endEmitted);
  }

  get readableHighWaterMark(): number {
    return this._readableState.highWaterMark;
  }

  get readableBuffer(): T[] {
    const r = this._readableState;
    return r.buffer.slice(r.bufferIndex);
  }

  get readableFlowing(): boolean | null {
    return this._readableState.flowing;
  }

  set readableFlowing(value: boolean | null) {
    if (this._readableState) {
      this._readableState.flowing = value;
    }
  }

  get readableLength(): number {
    return this._readableState.length;
  }

  get readableObjectMode(): boolean {
    return this._readableState ? this._readableState.objectMode : false;
  }

  get readableEncoding(): string | null {
    return this._readableState ? this._readableState.encoding : null;
  }

  get errored(): Error | null {
    return this._readableState ? this._readableState.errored : null;
  }

  get closed(): boolean {
    return this._readableState ? this._readableState.closed : false;
  }

  get destroyed(): boolean {
    return this._readableState ? this._readableState.destroyed : false;
  }

  set destroyed(value: boolean) {
    if (this._readableState) {
      this._readableState.destroyed = value;
    }
  }

  get readableEnded(): boolean {
    return this._readableState ? this._readableState.endEmitted : false;
  }
}

Readable.prototype.addListener = Readable.prototype.on;
Readable.prototype.off = Readable.prototype.removeListener;

if (typeof Symbol.asyncDispose === "symbol") {
  Object.defineProperty(Readable.prototype, Symbol.asyncDispose, {
    configurable: true,
    writable: true,
    value: async function (this: Readable<unknown>): Promise<void> {
      let error: Error | null = null;
      if (!this.destroyed) {
        error = this.readableEnded ? null : createAbortError();
        this.destroy(error);
      }
      await new Promise<void>((resolve, reject) => {
        eos(this, err => (err && err !== error ? reject(err) : resolve()));
      });
    }
  });
}

function wrapLegacy(legacy: unknown): Readable {
  return Readable.wrap(legacy, { objectMode: true });
}

// =============================================================================
// Duplex
// =============================================================================

export interface DuplexOptions<TRead = any, TWrite = any>
  extends
    DuplexStreamOptions,
    Omit<ReadableOptions<TRead>, "read" | "destroy" | "construct">,
    Omit<WritableOptions<TWrite>, "write" | "writev" | "final" | "destroy" | "construct"> {
  readable?: boolean;
  writable?: boolean;
  read?: (this: Duplex<TRead, TWrite>, size: number) => void;
  write?: (
    this: Duplex<TRead, TWrite>,
    chunk: TWrite,
    encoding: string,
    callback: WriteCallback
  ) => void;
  writev?: (
    this: Duplex<TRead, TWrite>,
    chunks: Array<{ chunk: TWrite; encoding: string }>,
    callback: WriteCallback
  ) => void;
  final?: (this: Duplex<TRead, TWrite>, callback: WriteCallback) => void;
  destroy?: (this: Duplex<TRead, TWrite>, error: Error | null, callback: WriteCallback) => void;
  construct?: (this: Duplex<TRead, TWrite>, callback: WriteCallback) => void;
}

// Declaration merge: the writable half is installed from Writable.prototype below.
// oxlint-disable-next-line no-unused-vars, typescript/no-empty-interface, typescript/no-empty-object-type, typescript/no-unsafe-declaration-merging
export interface Duplex<TRead = any, TWrite = any> extends WritableSide<TWrite> {}

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export class Duplex<TRead = any, TWrite = any> extends Readable<TRead> {
  static readonly [kIsDuplex] = true;

  allowHalfOpen: boolean;

  constructor(options?: DuplexOptions<TRead, TWrite>) {
    super(options as ReadableOptions<TRead>);
    this._writableState = createWritableState(this, options, true);

    if (options) {
      this.allowHalfOpen = options.allowHalfOpen !== false;

      if (options.readable === false) {
        this._readableState.readable = false;
        this._readableState.ended = true;
        this._readableState.endEmitted = true;
      }
      if (options.writable === false) {
        this._writableState.writable = false;
        this._writableState.ending = true;
        this._writableState.ended = true;
        this._writableState.finished = true;
      }

      initReadable(this as Readable<any>, options as ReadableOptions<any>);
      initWritable(this, options as WritableOptions<any>);
    } else {
      this.allowHalfOpen = true;
    }

    if (this._construct != null) {
      construct(this, () => {
        onReadableConstructed(this);
        onWritableConstructed(this);
      });
    }
  }

  static override from<R = Uint8Array, W = Uint8Array>(body: unknown): Duplex<R, W> {
    return duplexify(kernel, body, "body") as Duplex<R, W>;
  }

  /**
   * Not accepted, as in Node (use `Readable.fromWeb` or `Duplex.from`). This
   * overload exists only because Duplex inherits Readable's static side here;
   * it comes first so that `Parameters` / `ReturnType`, which read the last
   * overload, see the real one below, as they do on `node:stream`.
   */
  static override fromWeb(readableStream: never, options?: never): never;
  /**
   * Adapt a Web `{ readable, writable }` pair (a `TransformStream`, say) into a
   * Duplex. Untyped, as Node declares it: what the readable side yields depends
   * on the mode.
   */
  static override fromWeb(
    pair: { readable: ReadableStream; writable: WritableStream },
    options?: DuplexStreamOptions & {
      encoding?: string;
      decodeStrings?: boolean;
      signal?: AbortSignal;
    }
  ): Duplex;
  static override fromWeb(pair: any, options?: any): Duplex {
    return duplexFromWeb(Duplex, pair, options, "node");
  }

  /**
   * Not accepted, as in Node (use `Readable.toWeb`). Placed first for the same
   * reason as `fromWeb`'s.
   */
  static override toWeb(streamReadable: never, options?: never): never;
  /** The Web `{ readable, writable }` pair of a Duplex. */
  static override toWeb<R = Uint8Array, W = Uint8Array>(
    duplex: Duplex<R, W>
  ): { readable: ReadableStream<R>; writable: WritableStream<W> };
  static override toWeb(duplex: unknown): unknown {
    return duplexToWeb(duplex, "node");
  }

  override get destroyed(): boolean {
    if (this._readableState === undefined || this._writableState === undefined) {
      return false;
    }
    return this._readableState.destroyed && this._writableState.destroyed;
  }

  override set destroyed(value: boolean) {
    if (this._readableState && this._writableState) {
      this._readableState.destroyed = value;
      this._writableState.destroyed = value;
    }
  }
}

// The accessors Node's Duplex takes from Writable; `destroyed`, `closed` and
// `errored` stay Duplex/Readable's, and `writableAborted` is Writable-only.
const DUPLEX_WRITABLE_ACCESSORS = new Set([
  "writable",
  "writableHighWaterMark",
  "writableObjectMode",
  "writableBuffer",
  "writableLength",
  "writableFinished",
  "writableCorked",
  "writableEnded",
  "writableNeedDrain"
]);

// Install the writable half: the same function objects as Writable's, so a
// Duplex runs exactly the Writable algorithm on its own WritableState.
for (const key of Object.getOwnPropertyNames(Writable.prototype)) {
  if (key === "constructor") {
    continue;
  }
  const descriptor = Object.getOwnPropertyDescriptor(Writable.prototype, key)!;
  if (descriptor.get || descriptor.set) {
    if (DUPLEX_WRITABLE_ACCESSORS.has(key)) {
      Object.defineProperty(Duplex.prototype, key, descriptor);
    }
  } else if (!(Duplex.prototype as any)[key]) {
    Object.defineProperty(Duplex.prototype, key, descriptor);
  }
}
Duplex.prototype.destroy = Writable.prototype.destroy as unknown as typeof Duplex.prototype.destroy;

// =============================================================================
// Transform
// =============================================================================

export interface TransformOptions<TInput = any, TOutput = any> extends DuplexOptions<
  TOutput,
  TInput
> {
  transform?: (
    this: Transform<TInput, TOutput>,
    chunk: TInput,
    encoding: string,
    callback: TransformCallback<TOutput>
  ) => void;
  flush?: (this: Transform<TInput, TOutput>, callback: TransformCallback<TOutput>) => void;
}

export class Transform<TInput = any, TOutput = any> extends Duplex<TOutput, TInput> {
  _flush?(callback: TransformCallback<TOutput>): void;

  private _transformCallback: WriteCallback | null;

  constructor(options?: TransformOptions<TInput, TOutput>) {
    // A Transform buffers on the readable side only; with a readable mark of 0
    // the writable side must not buffer either, or data would sit there twice.
    if (options) {
      const readableHighWaterMark = getHighWaterMark(
        options,
        !!(options.objectMode || options.readableObjectMode),
        "readableHighWaterMark",
        true
      );
      if (readableHighWaterMark === 0) {
        options = {
          ...options,
          highWaterMark: undefined,
          readableHighWaterMark,
          writableHighWaterMark: options.writableHighWaterMark || 0
        };
      }
    }

    super(options);

    // _read is implemented and nothing else precedes the first call.
    this._readableState.sync = false;
    this._transformCallback = null;

    if (options) {
      if (typeof options.transform === "function") {
        this._transform = options.transform;
      }
      if (typeof options.flush === "function") {
        this._flush = options.flush;
      }
    }

    // Flush when the writable side finishes. Listening for 'prefinish' rather
    // than relying on _final keeps subclasses that override _final working.
    this.on("prefinish", prefinish);
  }

  _transform(_chunk: TInput, _encoding: string, _callback: TransformCallback<TOutput>): void {
    throw errMethodNotImplemented("_transform()");
  }

  override _final(cb?: WriteCallback): void {
    if (typeof this._flush === "function" && !this.destroyed) {
      this._flush((er, data) => {
        if (er) {
          if (cb) {
            cb(er);
          } else {
            this.destroy(er);
          }
          return;
        }
        if (data != null) {
          this.push(data);
        }
        this.push(null);
        cb?.();
      });
    } else {
      this.push(null);
      cb?.();
    }
  }

  override _write(chunk: TInput, encoding: string, callback: WriteCallback): void {
    const rState = this._readableState;
    const wState = this._writableState;
    const length = rState.length;

    this._transform(chunk, encoding, (err, val) => {
      if (err) {
        callback(err);
        return;
      }
      if (val != null) {
        this.push(val);
      }

      if (rState.ended) {
        // push(null) happened: let that state settle before the next write.
        nextTick(callback);
      } else if (wState.ended || length === rState.length || rState.length < rState.highWaterMark) {
        callback();
      } else {
        // The readable side is full: hold the write until it is read from.
        this._transformCallback = callback;
      }
    });
  }

  override _read(_size?: number): void {
    if (this._transformCallback) {
      const callback = this._transformCallback;
      this._transformCallback = null;
      callback();
    }
  }
}

function prefinish(this: Transform<unknown, unknown>): void {
  if (this._final !== Transform.prototype._final) {
    Transform.prototype._final.call(this);
  }
}

// =============================================================================
// PassThrough
// =============================================================================

/** A Transform that hands every chunk on unchanged. */
export class PassThrough<T = any> extends Transform<T, T> {
  override _transform(chunk: T, _encoding: string, callback: TransformCallback<T>): void {
    callback(null, chunk);
  }
}

/** The classes, for the algorithms that construct streams of their own. */
const kernel: StreamKernel = { Readable, Writable, Duplex, PassThrough };
export { kernel };
