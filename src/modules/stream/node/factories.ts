/**
 * Node.js Stream - Factory Functions
 *
 * Stream creation helper functions for Node.js.
 */

import { Readable, Transform, Duplex, PassThrough } from "stream";
import type { TransformCallback as NodeTransformCallback } from "stream";

import { BufferedStream, createStringChunk, createByteChunk } from "@stream/buffered-stream";
import { getDefaultHighWaterMark } from "@stream/core/utils";
import { PullStream } from "@stream/pull-stream";
import type {
  ReadableStreamOptions,
  WritableStreamOptions,
  TransformStreamOptions,
  DuplexStreamOptions,
  PullStreamOptions,
  BufferedStreamOptions,
  IReadable,
  IWritable,
  ITransform,
  IDuplex,
  IPassThrough
} from "@stream/types";

// Re-export shared stream classes
export { PullStream, BufferedStream, createStringChunk, createByteChunk };

/** Create a pull stream */
export function createPullStream(options?: PullStreamOptions): PullStream {
  return new PullStream(options);
}

/** Create a buffered stream */
export function createBufferedStream(options?: BufferedStreamOptions): BufferedStream {
  return new BufferedStream(options);
}

import { Writable } from "@stream/node/writable";

// =============================================================================
// Stream Creation Functions
// =============================================================================

/**
 * Ensure the options include a highWaterMark so that native Node.js streams
 * use the same default as the browser implementation (from common/utils.ts).
 * This matters on Node.js 20/21 where the native default is 16 KB instead of
 * the 64 KB we standardise on across both platforms.
 */
function withDefaultHWM<O extends { highWaterMark?: number; objectMode?: boolean }>(
  options: O | undefined
): O | { highWaterMark: number } {
  if (options?.highWaterMark != null) {
    return options;
  }
  const hwm = getDefaultHighWaterMark(options?.objectMode ?? false);
  return options ? { ...options, highWaterMark: hwm } : { highWaterMark: hwm };
}

/**
 * Create a readable stream from various sources
 */
export function createReadable<_T = Uint8Array>(
  options?: ReadableStreamOptions & {
    read?: (size: number) => void;
    destroy?: (error: Error | null, callback: (error: Error | null) => void) => void;
  }
): IReadable<_T> {
  return new Readable(withDefaultHWM(options));
}

/**
 * Create a readable stream from an async iterable
 */
export function createReadableFromAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  options?: ReadableStreamOptions
): IReadable<T> {
  const opts: Record<string, unknown> = {
    ...options,
    objectMode: options?.objectMode ?? true
  };
  return Readable.from(iterable, opts);
}

/**
 * Create a readable stream from an array.
 *
 * `undefined` entries are skipped. In object mode a stream's end-of-data signal *is*
 * `push(null)`, and `push(undefined)` is treated the same way — so an `undefined` in
 * the middle of the array used to end the stream early on Node and surface as a
 * `null` chunk in the browser. Node 26.8 turned the former into a hard
 * `Cannot read properties of undefined (reading 'then')` from the async iterator,
 * which is how a bug that had always been there became visible.
 *
 * Skipping is the only self-consistent reading: `0`, `""` and `false` are ordinary
 * values that must survive, and there is no in-band way to carry "a chunk whose
 * value is undefined" through a stream whose terminator is a nullish push.
 */
export function createReadableFromArray<T>(
  data: T[],
  options?: ReadableStreamOptions
): IReadable<T> {
  let index = 0;
  return new Readable({
    ...withDefaultHWM(options),
    objectMode: options?.objectMode ?? true,
    read() {
      while (index < data.length) {
        const chunk = data[index++];
        if (chunk === undefined) {
          continue; // not a value a stream can carry — see the note above
        }
        if (!this.push(chunk)) {
          // Backpressure - wait for next read
          return;
        }
      }
      // All data pushed, end the stream
      this.push(null);
    }
  });
}

/**
 * Create a writable stream
 */
export function createWritable<T = Uint8Array>(
  options?: WritableStreamOptions & {
    write?: (chunk: T, encoding: string, callback: (error?: Error | null) => void) => void;
    final?: (callback: (error?: Error | null) => void) => void;
    destroy?: (error: Error | null, callback: (error: Error | null) => void) => void;
  }
): IWritable<T> {
  return new Writable(options);
}

/**
 * Create a transform stream from a transform function
 */
export function createTransform<TInput = Uint8Array, TOutput = Uint8Array>(
  transformFn: (chunk: TInput, encoding?: string) => TOutput | Promise<TOutput>,
  options?: TransformStreamOptions & {
    flush?: () => TOutput | Promise<TOutput> | void;
  }
): ITransform<TInput, TOutput> {
  return new Transform({
    ...withDefaultHWM(options),
    transform(chunk: TInput, encoding: BufferEncoding, callback: NodeTransformCallback) {
      try {
        const result = transformFn(chunk, encoding);
        if (result instanceof Promise) {
          result
            .then(data => {
              if (data !== undefined) {
                callback(null, data);
              } else {
                callback();
              }
            })
            .catch(callback);
        } else {
          if (result !== undefined) {
            callback(null, result);
          } else {
            callback();
          }
        }
      } catch (err) {
        callback(err as Error);
      }
    },
    flush: options?.flush
      ? function (callback: NodeTransformCallback) {
          try {
            const result = options.flush!();
            if (result instanceof Promise) {
              result
                .then(data => {
                  if (data !== undefined) {
                    callback(null, data);
                  } else {
                    callback();
                  }
                })
                .catch(callback);
            } else if (result !== undefined) {
              callback(null, result);
            } else {
              callback();
            }
          } catch (err) {
            callback(err as Error);
          }
        }
      : undefined
  });
}

/**
 * Create a duplex stream
 */
export function createDuplex<_TRead = Uint8Array, TWrite = Uint8Array>(
  options?: DuplexStreamOptions & {
    readable?: unknown;
    writable?: unknown;
    allowHalfOpen?: boolean;
    objectMode?: boolean;
    // The hook `this` types are intentionally `any`: the Node and browser
    // `createDuplex` signatures must stay identical for the stream API parity
    // typecheck, and each platform's hooks bind to a different Duplex class.
    read?: (this: any, size: number) => void;
    write?: (
      this: any,
      chunk: TWrite,
      encoding: string,
      callback: (error?: Error | null) => void
    ) => void;
    final?: (this: any, callback: (error?: Error | null) => void) => void;
    destroy?: (this: any, error: Error | null, callback: (error: Error | null) => void) => void;
  }
): IDuplex<_TRead, TWrite> {
  const objMode = options?.objectMode ?? false;
  const defaultHWM = getDefaultHighWaterMark(objMode);
  return new Duplex({
    highWaterMark: options?.highWaterMark ?? defaultHWM,
    objectMode: options?.objectMode,
    allowHalfOpen: options?.allowHalfOpen,
    readableHighWaterMark: options?.readableHighWaterMark,
    writableHighWaterMark: options?.writableHighWaterMark,
    readableObjectMode: options?.readableObjectMode,
    writableObjectMode: options?.writableObjectMode,
    read: options?.read,
    write: options?.write,
    final: options?.final,
    destroy: options?.destroy
  });
}

/**
 * Create a passthrough stream
 */
export function createPassThrough<_T = unknown>(
  options?: TransformStreamOptions
): IPassThrough<_T> {
  return new PassThrough(withDefaultHWM(options));
}

/**
 * Create a readable stream from a generator function
 */
export function createReadableFromGenerator<T>(
  generator: () => AsyncGenerator<T, void, unknown>,
  options?: ReadableStreamOptions
): IReadable<T> {
  return Readable.from(generator(), {
    ...options,
    objectMode: options?.objectMode ?? true
  });
}

/**
 * Create a readable stream from a Promise
 */
export function createReadableFromPromise<T>(
  promise: Promise<T>,
  options?: ReadableStreamOptions
): IReadable<T> {
  const readable = new Readable({
    ...withDefaultHWM(options),
    objectMode: options?.objectMode ?? true,
    read() {}
  });

  promise
    .then(value => {
      readable.push(value);
      readable.push(null);
    })
    .catch(err => {
      readable.destroy(err);
    });

  return readable;
}

// Reusable empty read function
function emptyRead(this: Readable): void {
  this.push(null);
}

/**
 * Create a readable stream that emits nothing and immediately ends
 */
export function createEmptyReadable<_T = Uint8Array>(
  options?: ReadableStreamOptions
): IReadable<_T> {
  return new Readable({
    ...withDefaultHWM(options),
    read: emptyRead
  });
}

// Reusable null write function
function nullWrite(
  _chunk: unknown,
  _encoding: string,
  callback: (error?: Error | null) => void
): void {
  callback();
}

/**
 * Create a writable stream that discards all data (like /dev/null)
 */
export function createNullWritable<_T = unknown>(options?: WritableStreamOptions): IWritable<_T> {
  return new Writable({
    ...withDefaultHWM(options),
    write: nullWrite
  });
}
