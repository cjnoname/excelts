/**
 * Stream kernel - internal state
 *
 * One `ReadableState` and/or one `WritableState` per stream object. They are
 * the single owner of every flag and queue the stream has: a Duplex holds both
 * on one object, it never nests a second stream. Behaviour lives in plain
 * functions in `readable-impl.ts` / `writable.ts`; these are data.
 *
 * The layout follows Node.js `lib/internal/streams` so the algorithms can be
 * compared line by line.
 */

import { stringToEncodedBytes } from "@stream/core/binary-chunk";
import { errInvalidArgValue, errUnknownEncoding, validateInteger } from "@stream/kernel/errors";
import { createStreamDecoder, decodeBytesToString } from "@utils/binary";
import type { StreamDecoder } from "@utils/binary";

// =============================================================================
// Scheduling
// =============================================================================

const tickQueue: Array<() => void> = [];
let tickHead = 0;
let tickScheduled = false;

function drainTicks(): void {
  try {
    while (tickHead < tickQueue.length) {
      const fn = tickQueue[tickHead]!;
      tickQueue[tickHead++] = undefined!;
      fn();
    }
    tickQueue.length = 0;
    tickHead = 0;
    tickScheduled = false;
  } catch (err) {
    // A throwing callback must not strand the rest of the queue.
    queueMicrotask(drainTicks);
    throw err;
  }
}

/**
 * `process.nextTick` for the browser.
 *
 * Ticks scheduled while the queue drains run in the same drain, before any
 * promise reaction — the ordering Node guarantees and stream state machines
 * depend on (e.g. `'finish'` → `'close'` with no `await` able to observe the
 * gap). A plain `queueMicrotask` per call would interleave with promises.
 */
export function nextTick(fn: () => void): void {
  tickQueue.push(fn);
  if (!tickScheduled) {
    tickScheduled = true;
    queueMicrotask(drainTicks);
  }
}

// =============================================================================
// Options
// =============================================================================

/** Static marker on `Duplex`: its constructor builds both states itself. */
export const kIsDuplex = Symbol("kIsDuplex");

export interface StateOptions {
  objectMode?: boolean;
  readableObjectMode?: boolean;
  writableObjectMode?: boolean;
  highWaterMark?: number;
  readableHighWaterMark?: number;
  writableHighWaterMark?: number;
  emitClose?: boolean;
  autoDestroy?: boolean;
  encoding?: string;
  defaultEncoding?: string;
  decodeStrings?: boolean;
}

// Node's `lib/internal/streams/state.js`: the defaults new streams take, and
// the setter that changes them for every stream created afterwards.
let defaultHighWaterMarkBytes = 64 * 1024;
let defaultHighWaterMarkObjectMode = 16;

export function getDefaultHighWaterMark(objectMode: boolean): number {
  return objectMode ? defaultHighWaterMarkObjectMode : defaultHighWaterMarkBytes;
}

export function setDefaultHighWaterMark(objectMode: boolean, value: number): void {
  validateInteger(value, "value", 0);
  if (objectMode) {
    defaultHighWaterMarkObjectMode = value;
  } else {
    defaultHighWaterMarkBytes = value;
  }
}

function getHighWaterMark(
  options: StateOptions | undefined,
  objectMode: boolean,
  duplexKey: "readableHighWaterMark" | "writableHighWaterMark",
  isDuplex: boolean
): number {
  const hwm =
    options?.highWaterMark != null ? options.highWaterMark : isDuplex ? options?.[duplexKey] : null;
  if (hwm != null) {
    if (!Number.isInteger(hwm) || hwm < 0) {
      throw errInvalidArgValue(isDuplex ? `options.${duplexKey}` : "options.highWaterMark", hwm);
    }
    return hwm;
  }
  return getDefaultHighWaterMark(objectMode);
}

export { getHighWaterMark };

const ENCODINGS = new Set([
  "utf8",
  "utf-8",
  "ucs2",
  "ucs-2",
  "utf16le",
  "utf-16le",
  "latin1",
  "binary",
  "base64",
  "base64url",
  "hex",
  "ascii"
]);

export function isEncoding(encoding: unknown): encoding is string {
  return typeof encoding === "string" && ENCODINGS.has(encoding.toLowerCase());
}

function normalizeDefaultEncoding(encoding: string | undefined): string {
  if (encoding == null || encoding === "utf8" || encoding === "utf-8") {
    return "utf8";
  }
  if (!isEncoding(encoding)) {
    throw errUnknownEncoding(encoding);
  }
  return encoding.toLowerCase();
}

// =============================================================================
// Shared flags
// =============================================================================

/** Lifecycle fields shared by both sides; `destroy.ts` operates on these. */
interface LifecycleState {
  objectMode: boolean;
  highWaterMark: number;
  emitClose: boolean;
  autoDestroy: boolean;
  destroyed: boolean;
  closed: boolean;
  closeEmitted: boolean;
  errored: Error | null;
  errorEmitted: boolean;
  /** `false` while an async `_construct` is pending. */
  constructed: boolean;
  /** Set while a `_read` / `_write` call is on the stack. */
  sync: boolean;
}

// =============================================================================
// Readable
// =============================================================================

export class ReadableState implements LifecycleState {
  objectMode: boolean;
  highWaterMark: number;
  emitClose: boolean;
  autoDestroy: boolean;
  destroyed = false;
  closed = false;
  closeEmitted = false;
  errored: Error | null = null;
  errorEmitted = false;
  constructed = true;
  sync = true;

  buffer: any[] = [];
  bufferIndex = 0;
  length = 0;
  pipes: any[] = [];
  /** `null` until a consumer chooses flowing (true) or paused (false). */
  flowing: boolean | null = null;
  ended = false;
  endEmitted = false;
  endScheduled = false;
  reading = false;
  needReadable = false;
  emittedReadable = false;
  readableListening = false;
  resumeScheduled = false;
  /** `undefined` until pause()/resume() is called, mirroring Node's kHasPaused. */
  paused: boolean | undefined = undefined;
  dataListening = false;
  dataEmitted = false;
  readingMore = false;
  multiAwaitDrain = false;
  /** Destinations a pipe is waiting on for `'drain'`: null, one, or a Set. */
  awaitDrainWriters: any = null;
  defaultEncoding: string;
  decoder: StreamDecoder | null = null;
  encoding: string | null = null;
  /** Duplex with `readable: false`. */
  readable: boolean | undefined = undefined;

  constructor(options: StateOptions | undefined, isDuplex: boolean) {
    this.objectMode = !!(options?.objectMode || (isDuplex && options?.readableObjectMode));
    this.highWaterMark = getHighWaterMark(
      options,
      this.objectMode,
      "readableHighWaterMark",
      isDuplex
    );
    this.emitClose = options?.emitClose !== false;
    this.autoDestroy = options?.autoDestroy !== false;
    this.defaultEncoding = normalizeDefaultEncoding(options?.defaultEncoding);
    if (options?.encoding) {
      this.decoder = createStreamDecoder(options.encoding);
      this.encoding = normalizeEncodingName(options.encoding);
    }
  }
}

// =============================================================================
// Writable
// =============================================================================

export interface WriteRequest {
  chunk: any;
  encoding: string;
  callback: (error?: Error | null) => void;
}

export class WritableState implements LifecycleState {
  objectMode: boolean;
  highWaterMark: number;
  emitClose: boolean;
  autoDestroy: boolean;
  destroyed = false;
  closed = false;
  closeEmitted = false;
  errored: Error | null = null;
  errorEmitted = false;
  constructed = true;
  sync = true;

  decodeStrings: boolean;
  defaultEncoding: string;
  finalCalled = false;
  needDrain = false;
  /** `end()` has been called. */
  ending = false;
  /** `end()` has returned. */
  ended = false;
  finished = false;
  writing = false;
  bufferProcessing = false;
  prefinished = false;
  afterWritePending = false;
  expectWriteCb = false;
  /** Duplex with `writable: false`. */
  writable: boolean | undefined = undefined;
  /** Bytes (or objects) accepted but not yet acknowledged by `_write`. */
  length = 0;
  corked = 0;
  writelen = 0;
  writecb: ((error?: Error | null) => void) | null = null;
  afterWriteTickInfo: {
    count: number;
    cb: (error?: Error | null) => void;
    stream: any;
    state: WritableState;
  } | null = null;
  buffered: WriteRequest[] = [];
  bufferedIndex = 0;
  allBuffers = true;
  allNoop = true;
  /** Outstanding callbacks; must reach 0 before `'finish'`. */
  pendingcb = 0;
  onFinished: Array<(error?: Error | null) => void> = [];
  onwrite: (error?: Error | null) => void;

  constructor(
    options: StateOptions | undefined,
    isDuplex: boolean,
    onwrite: (error?: Error | null) => void
  ) {
    this.objectMode = !!(options?.objectMode || (isDuplex && options?.writableObjectMode));
    this.highWaterMark = getHighWaterMark(
      options,
      this.objectMode,
      "writableHighWaterMark",
      isDuplex
    );
    this.decodeStrings = options?.decodeStrings !== false;
    this.emitClose = options?.emitClose !== false;
    this.autoDestroy = options?.autoDestroy !== false;
    this.defaultEncoding = normalizeDefaultEncoding(options?.defaultEncoding);
    this.onwrite = onwrite;
  }

  getBuffer(): WriteRequest[] {
    return this.buffered.slice(this.bufferedIndex);
  }

  get bufferedRequestCount(): number {
    return this.buffered.length - this.bufferedIndex;
  }
}

// =============================================================================
// Chunks
// =============================================================================

function encodedBytesToString(this: Uint8Array, encoding?: string): string {
  return decodeBytesToString(this, encoding ?? "utf8");
}

/**
 * `Buffer.from(string, encoding)` for the browser. The bytes keep a
 * `toString(encoding)` like a Buffer, so code that stringifies a chunk it
 * pushed as a string reads back the same text on both platforms.
 */
export function encodeStringChunk(str: string, encoding: string): Uint8Array {
  const bytes = stringToEncodedBytes(str, encoding);
  (bytes as { toString: (encoding?: string) => string }).toString = encodedBytesToString;
  return bytes;
}

/** A non-Uint8Array view (DataView, Int16Array, …) as bytes, without copying. */
export function viewToBytes(view: ArrayBufferView): Uint8Array {
  return view instanceof Uint8Array
    ? view
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function decoderWrite(decoder: StreamDecoder, chunk: Uint8Array): string {
  return decoder.decode(chunk, { stream: true });
}

export function decoderEnd(decoder: StreamDecoder): string {
  return decoder.decode(new Uint8Array(0));
}

export function normalizeEncodingName(encoding: string): string {
  const enc = encoding.toLowerCase();
  switch (enc) {
    case "utf-8":
      return "utf8";
    case "ucs2":
    case "ucs-2":
    case "utf-16le":
      return "utf16le";
    case "binary":
      return "latin1";
    default:
      return enc;
  }
}

// =============================================================================
// Kernel
// =============================================================================

type StreamCtor = (new (...args: any[]) => any) & Record<string, any>;

/**
 * The stream classes, handed to the algorithms that construct streams of their
 * own (`compose`, `pipeline`, `Duplex.from`). Passing them in keeps those
 * modules from importing the classes, which call back into them.
 */
export interface StreamKernel {
  Readable: StreamCtor;
  Writable: StreamCtor;
  Duplex: StreamCtor;
  PassThrough: StreamCtor;
}

/** What `pipeline` constructs or calls into: Duplex.from, a sink PassThrough, Readable iteration. */
export type PipelineKernel = Pick<StreamKernel, "Readable" | "Duplex" | "PassThrough">;

/** What `Duplex.from` constructs: the adapters and the Duplex itself. */
export type DuplexifyKernel = Pick<StreamKernel, "Readable" | "Writable" | "Duplex">;

// =============================================================================
// The kernel's own stream objects, as its algorithms see them
// =============================================================================

type Listener = (...args: any[]) => void;
type Callback = (error?: Error | null) => void;

/** What `destroy.ts` reads and writes on a stream: its states and destroy hooks. */
export interface DestroyableStream {
  _readableState?: ReadableState;
  _writableState?: WritableState;
  _destroy(error: Error | null, callback: Callback): void;
  _construct?(callback: Callback): void;
  destroy(error?: Error | null, callback?: Callback): unknown;
  emit(event: string | symbol, ...args: any[]): boolean;
  once(event: string | symbol, listener: Listener): unknown;
  listenerCount(event: string | symbol): number;
}

/**
 * A kernel Readable (or Duplex) as `readable-impl.ts` drives it. Typing the
 * algorithms against this, rather than `any`, makes the compiler check every
 * member they touch; the writable-side fields are the Duplex ones `'end'`
 * handling consults.
 */
export interface ReadableCore extends DestroyableStream {
  _readableState: ReadableState;
  _read(size: number): void;
  read(size?: number): unknown;
  push(chunk: unknown, encoding?: string): boolean;
  resume(): unknown;
  pause(): unknown;
  unpipe(destination?: unknown): unknown;
  on(event: string | symbol, listener: Listener): unknown;
  removeListener(event: string | symbol, listener: Listener): unknown;
  readonly destroyed: boolean;
  readonly writable?: boolean;
  readonly writableEnded?: boolean;
  allowHalfOpen?: boolean;
  end?(): unknown;
}

/** A kernel Writable (or Duplex) as `writable.ts` drives it. */
export interface WritableCore extends DestroyableStream {
  _writableState: WritableState;
  _write(chunk: any, encoding: string, callback: Callback): void;
  _writev?: ((chunks: WriteRequest[], callback: Callback) => void) | null;
  _final?(callback: Callback): void;
}
