/**
 * Browser Stream - Factory functions
 */

import { createCollector } from "@stream/browser/collector";
import { Duplex } from "@stream/browser/duplex";
import { PassThrough } from "@stream/browser/passthrough";
import { Readable, pumpAsyncIterableToReadable } from "@stream/browser/readable";
import { Transform } from "@stream/browser/transform";
import { Writable } from "@stream/browser/writable";
import { BufferedStream, createStringChunk, createByteChunk } from "@stream/buffered-stream";
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

// =============================================================================
// Stream Creation Functions
// =============================================================================

/**
 * Create a readable stream with custom read implementation
 */
export function createReadable<T = Uint8Array>(
  options?: ReadableStreamOptions & {
    read?: (this: Readable<T>, size?: number) => void;
    destroy?: (error: Error | null, callback: (error: Error | null) => void) => void;
  }
): IReadable<T> {
  // Readable already supports Node-style `read()` via the constructor option.
  // Keep this helper minimal to avoid accidental double-read behavior.
  return new Readable<T>(options);
}

/**
 * Create a readable stream from an async iterable
 */
export function createReadableFromAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  options?: ReadableStreamOptions
): IReadable<T> {
  const readable = new Readable<T>({ ...options, objectMode: options?.objectMode ?? true });

  pumpAsyncIterableToReadable(readable, iterable);

  return readable;
}

/**
 * Create a readable stream from an array
 */
export function createReadableFromArray<T>(
  data: T[],
  options?: ReadableStreamOptions
): IReadable<T> {
  let index = 0;
  const readable = new Readable<T>({
    ...options,
    objectMode: options?.objectMode ?? true,
    read() {
      // Push data when read is called
      while (index < data.length) {
        const chunk = data[index++];
        if (chunk === undefined) {
          continue; // see the note on the Node factory: not a value a stream carries
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

  return readable;
}

/**
 * Create a writable stream with custom write implementation
 */
export function createWritable<T = Uint8Array>(
  options?: WritableStreamOptions & {
    write?: (chunk: T, encoding: string, callback: (error?: Error | null) => void) => void;
    final?: (callback: (error?: Error | null) => void) => void;
    destroy?: (error: Error | null, callback: (error: Error | null) => void) => void;
  }
): IWritable<T> {
  // Writable already supports Node-style `write()` / `final()` via the constructor.
  return new Writable<T>(options);
}

/**
 * Create a transform stream from a transform function.
 *
 * The shorthand `transformFn` (1-2 params, returns value) is wrapped into
 * a proper Node.js-style callback-based transform so that the return value
 * is delivered via `callback(null, data)` — matching the Node.js factory.
 */
export function createTransform<TInput = Uint8Array, TOutput = Uint8Array>(
  transformFn: (chunk: TInput, encoding?: string) => TOutput | Promise<TOutput>,
  options?: TransformStreamOptions & {
    flush?: () => TOutput | Promise<TOutput> | void;
  }
): ITransform<TInput, TOutput> {
  return new Transform<TInput, TOutput>({
    ...options,
    transform(
      this: Transform<TInput, TOutput>,
      chunk: TInput,
      encoding: string,
      callback: (error?: Error | null, data?: TOutput) => void
    ) {
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
            .catch(err => callback(err as Error));
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
      ? function (
          this: Transform<TInput, TOutput>,
          callback: (error?: Error | null, data?: TOutput) => void
        ) {
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
                .catch(err => callback(err as Error));
            } else if (result !== undefined) {
              callback(null, result as TOutput);
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

// createCollector is now defined in collector.ts and re-exported here for convenience.
export { createCollector };

/**
 * Create a passthrough stream
 */
export function createPassThrough<T = unknown>(options?: TransformStreamOptions): IPassThrough<T> {
  return new PassThrough(options);
}

/**
 * Create a duplex stream from a pair of readable and writable streams
 */
export function createDuplex<TRead = Uint8Array, TWrite = Uint8Array>(
  options?: DuplexStreamOptions & {
    readable?: unknown;
    writable?: unknown;
    allowHalfOpen?: boolean;
    objectMode?: boolean;
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
): IDuplex<TRead, TWrite> {
  return new Duplex<TRead, TWrite>({
    highWaterMark: options?.highWaterMark,
    objectMode: options?.objectMode,
    allowHalfOpen: options?.allowHalfOpen,
    readableHighWaterMark: options?.readableHighWaterMark,
    writableHighWaterMark: options?.writableHighWaterMark,
    readableObjectMode: options?.readableObjectMode,
    writableObjectMode: options?.writableObjectMode,
    read: options?.read as ((this: Duplex<TRead, TWrite>, size?: number) => void) | undefined,
    write: options?.write,
    final: options?.final,
    destroy: options?.destroy
  });
}

/**
 * Create a readable stream from a generator function
 */
export function createReadableFromGenerator<T>(
  generator: () => AsyncGenerator<T, void, unknown>,
  options?: ReadableStreamOptions
): IReadable<T> {
  const readable = new Readable<T>({ ...options, objectMode: options?.objectMode ?? true });

  pumpAsyncIterableToReadable(readable, generator());

  return readable;
}

/**
 * Create a readable stream from a Promise
 */
export function createReadableFromPromise<T>(
  promise: Promise<T>,
  options?: ReadableStreamOptions
): IReadable<T> {
  const readable = new Readable<T>({ ...options, objectMode: options?.objectMode ?? true });

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

// Reusable read callback for createEmptyReadable (pull-based, matches Node behavior).
// Boundary: this single shared hook is reused across every Readable<T>
// instantiation, so its `this` is left open (Readable is invariant in T).
function emptyRead(this: Readable<any>): void {
  this.push(null);
}

/**
 * Create a readable stream that emits nothing and immediately ends
 */
export function createEmptyReadable<T = Uint8Array>(options?: ReadableStreamOptions): IReadable<T> {
  return new Readable<T>({
    ...options,
    read: emptyRead
  });
}

// Reusable null write handler
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
export function createNullWritable<T = unknown>(options?: WritableStreamOptions): IWritable<T> {
  return new Writable<T>({
    ...options,
    write: nullWrite
  });
}
