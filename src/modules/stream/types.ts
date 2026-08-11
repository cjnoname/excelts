/**
 * Stream Module - Shared Types
 *
 * Common type definitions for stream operations across Node.js and Browser.
 * These types provide a unified interface regardless of the underlying implementation.
 */

// =============================================================================
// Stream Options
// =============================================================================

/**
 * Common options for creating streams (readable, writable, or transform)
 */
export interface StreamOptions {
  /** High water mark for backpressure (bytes) */
  highWaterMark?: number;
  /** Enable object mode (non-binary data) */
  objectMode?: boolean;
}

/** Options for creating readable streams */
export type ReadableStreamOptions = StreamOptions;

/** Options for creating writable streams */
export type WritableStreamOptions = StreamOptions;

/** Options for creating transform streams */
export type TransformStreamOptions = StreamOptions;

/**
 * Options for creating duplex streams
 */
export interface DuplexStreamOptions {
  /** Enable object mode for both read and write sides (Node compatibility) */
  objectMode?: boolean;
  /** High water mark for both sides (Node compatibility) */
  highWaterMark?: number;
  /** Allow half-open (Node compatibility) */
  allowHalfOpen?: boolean;
  /** High water mark for read side */
  readableHighWaterMark?: number;
  /** High water mark for write side */
  writableHighWaterMark?: number;
  /** Enable object mode for read side */
  readableObjectMode?: boolean;
  /** Enable object mode for write side */
  writableObjectMode?: boolean;
}

// =============================================================================
// Callback Types
// =============================================================================

/**
 * Callback for stream transform/flush operations
 */
export type StreamCallback<T = Uint8Array> = (error?: Error | null, data?: T) => void;

/**
 * Callback for transform operations
 */
export type TransformCallback<T = Uint8Array> = StreamCallback<T>;

/**
 * Callback for flush operations
 */
export type FlushCallback<T = Uint8Array> = StreamCallback<T>;

/**
 * Callback for write operations
 */
export type WriteCallback = (error?: Error | null) => void;

/**
 * Callback for destroy operations
 */
export type DestroyCallback = (error?: Error | null) => void;

// =============================================================================
// Stream Interfaces
// =============================================================================

/**
 * Event listener type
 */
export type EventListener = (...args: any[]) => void;

/**
 * Minimal duck-typed emitter shape for utilities that accept any emitter-like object.
 */
export type EventEmitterLike = {
  on?: (event: string, listener: (...args: any[]) => void) => any;
  once?: (event: string, listener: (...args: any[]) => void) => any;
  off?: (event: string, listener: (...args: any[]) => void) => any;
  removeListener?: (event: string, listener: (...args: any[]) => void) => any;
};

/**
 * Common event emitter interface
 */
export interface IEventEmitter {
  on(event: string, listener: EventListener): this;
  once(event: string, listener: EventListener): this;
  off(event: string, listener: EventListener): this;
  removeListener(event: string | symbol, listener: EventListener): this;
  emit(event: string, ...args: any[]): boolean;
  removeAllListeners(event?: string): this;
}

// =============================================================================
// Minimal public stream-like shapes (for cross-env function signatures)
// =============================================================================

/**
 * Minimal readable-like stream shape used by `pipeline`/`finished` signatures.
 * Kept intentionally permissive so both Node streams and browser wrappers match.
 */
export interface ReadableLike extends IEventEmitter {
  pipe(destination: any): any;
  destroy?(error?: Error): void;
  readableEnded?: boolean;
}

/**
 * Minimal writable-like stream shape used by `pipeline`/`finished` signatures.
 * Kept intentionally permissive so both Node streams and browser wrappers match.
 */
export interface WritableLike extends IEventEmitter {
  write(chunk: any, ...args: any[]): any;
  end(...args: any[]): any;
  destroy?(error?: Error): void;
  writableFinished?: boolean;
}

/**
 * Stream-like union accepted by `finished` across Node and browser.
 * Includes Web Streams to support browser-native and Node's WHATWG streams.
 *
 * `pipeline` accepts more — see {@link PipelineStageLike}.
 */
export type PipelineStreamLike =
  | ReadableLike
  | WritableLike
  | (ReadableLike & WritableLike)
  | ReadableStream<any>
  | WritableStream<any>
  | TransformStream<any, any>;

/**
 * A generator/async-generator transform stage: `fn(source) => (Async)Iterable`.
 *
 * Only valid in the middle of a pipeline — a trailing function argument is
 * always read as the completion callback.
 */
export type PipelineGeneratorStage = (
  source: AsyncIterable<any>
) => AsyncIterable<unknown> | Iterable<unknown>;

/**
 * Everything `pipeline` accepts as a stage: streams (including Web Streams),
 * a bare (async) iterable as the source, and generator transform stages.
 */
export type PipelineStageLike =
  | PipelineStreamLike
  | Iterable<unknown>
  | AsyncIterable<unknown>
  | PipelineGeneratorStage;

/**
 * Common readable stream interface
 */
export interface IReadable<T = unknown> extends ReadableLike, AsyncIterable<T> {
  read(size?: number): T | null;
  destroy(error?: Error): any;
  pipe(destination: any): any;
  unpipe(destination?: any): this;
  pause(): this;
  resume(): this;
  isPaused(): boolean;
  readonly readable: boolean;
  readonly readableEnded: boolean;
  readonly readableLength: number;
  readonly readableHighWaterMark?: number;
  readonly readableObjectMode?: boolean;
  readonly readableFlowing?: boolean | null;
  readonly destroyed?: boolean;
}

/**
 * Common writable stream interface
 */
export interface IWritable<T = unknown> extends WritableLike {
  write(chunk: T, callback?: WriteCallback): boolean;
  write(chunk: T, encoding?: string, callback?: WriteCallback): boolean;
  end(callback?: () => void): this;
  end(chunk: T, callback?: () => void): this;
  end(chunk: T, encoding?: string, callback?: () => void): this;
  destroy(error?: Error): any;
  readonly writable: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly writableLength: number;
  readonly writableHighWaterMark?: number;
  readonly destroyed?: boolean;
}

/**
 * Common transform stream interface
 */
export interface ITransform<TInput = unknown, TOutput = unknown>
  extends IReadable<TOutput>, IWritable<TInput> {
  _transform(chunk: TInput, encoding: string, callback: TransformCallback<TOutput>): void;
  _flush?(callback: FlushCallback<TOutput>): void;
}

/**
 * Common duplex stream interface
 */
export interface IDuplex<TRead = unknown, TWrite = unknown>
  extends IReadable<TRead>, IWritable<TWrite> {}

// =============================================================================
// Pull Stream Interface
// =============================================================================

/**
 * Options for pull stream (reserved for future use)
 */
export type PullStreamOptions = {
  /**
   * Buffer high-water mark in bytes. When the readable buffer exceeds this
   * size, `write()` returns `false` to signal backpressure to the producer.
   * Once the buffer drops back to the low-water mark (half the HWM), a
   * `'drain'` event is emitted. Defaults to `Infinity` (no backpressure).
   *
   * Set this when the stream is fed by a fast producer with a slow `pull()`
   * consumer to keep memory bounded — the legacy default of `Infinity`
   * preserves existing behaviour for callers that drain promptly.
   */
  highWaterMark?: number;
};

/**
 * Pull stream interface - allows pulling data on demand
 */
export interface IPullStream extends IEventEmitter {
  write(chunk: Uint8Array): boolean;
  end(chunk?: Uint8Array): void;
  destroy(error?: Error): void;

  /** Pull exactly N bytes from buffer */
  pull(size: number): Promise<Uint8Array>;
  /** Pull until pattern is found */
  pullUntil(pattern: Uint8Array, includePattern?: boolean): Promise<Uint8Array>;
  /** Stream data until pattern */
  stream(eof: number | Uint8Array): IReadable<Uint8Array>;

  readonly length: number;
  readonly isFinished: boolean;
  readonly matchPosition: number | undefined;
}

// =============================================================================
// Buffered Stream Interface
// =============================================================================

/**
 * Options for buffered stream
 */
export interface BufferedStreamOptions {
  /** Batch size for internal read-write buffers */
  batchSize?: number;
}

/**
 * Buffered stream interface - manages internal buffering
 */
export interface IBufferedStream extends IEventEmitter {
  write(chunk: Uint8Array | string): boolean;
  read(size?: number): Uint8Array | null;
  end(chunk?: Uint8Array | string): void;
  destroy(error?: Error): void;
  toUint8Array(): Uint8Array;

  readonly bufferedLength: number;
  readonly isFinished: boolean;
}

// =============================================================================
// Passthrough Interface
// =============================================================================

/**
 * Passthrough stream - passes data through unchanged
 */
export type IPassThrough<T = Uint8Array> = ITransform<T, T>;

// =============================================================================
// Collector Interface
// =============================================================================

/**
 * Collector interface - collects all chunks
 */
export interface ICollector<T = unknown> extends IWritable<T> {
  readonly chunks: T[];
  readonly isFinished?: boolean;
}

// =============================================================================
// Pipeline Types
// =============================================================================

/**
 * Pipeline source - can be a readable stream or async iterable
 */
export type PipelineSource<T> = IReadable<T> | AsyncIterable<T> | Iterable<T>;

/**
 * Pipeline transform - a transform stream or function
 */
export type PipelineTransform<TIn, TOut> =
  | ITransform<TIn, TOut>
  | ((source: AsyncIterable<TIn>) => AsyncIterable<TOut>);

/**
 * Pipeline destination - a writable stream or async generator
 */
export type PipelineDestination<T, R> = IWritable<T> | ((source: AsyncIterable<T>) => Promise<R>);

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Data chunk interface for flexible chunk handling
 */
export interface DataChunk {
  readonly length: number;
  copy(target: Uint8Array, targetOffset: number, offset: number, length: number): number;
  toUint8Array(): Uint8Array;
}
