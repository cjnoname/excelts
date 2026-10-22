/**
 * Web Streams conversions with the module's guarantees, on both entry points.
 *
 * `Readable.fromWeb` / `.toWeb` and friends stay exactly what each platform's
 * classes provide — on the Node entry, Node's own, with Node's known defects
 * (see the README). These functions run the module's adapters instead, with
 * that platform's classes, so the same call behaves the same on both:
 *
 * - no chunk is lost: a write made while `'drain'` is pending still reaches the
 *   Node-style stream, and a `null` read from a Web stream fails it rather than
 *   ending it early;
 * - strings from `setEncoding()` can be queued;
 * - the lock on a Web stream is handed back once the adapted stream ends,
 *   errors or is destroyed, and is never taken at all when adapting fails;
 * - the adapters remove their own listeners when they are done.
 */

import {
  readableFromWeb as adaptReadableFromWeb,
  readableToWeb as adaptReadableToWeb,
  writableFromWeb as adaptWritableFromWeb,
  writableToWeb as adaptWritableToWeb
} from "@stream/kernel/web-adapters";
import type { IReadable, IWritable } from "@stream/types";

/** Options for adapting a Web `ReadableStream` into a Node-style Readable. */
export interface WebReadableOptions {
  objectMode?: boolean;
  highWaterMark?: number;
  encoding?: string;
  signal?: AbortSignal;
}

/** Options for adapting a Web `WritableStream` into a Node-style Writable. */
export interface WebWritableOptions {
  objectMode?: boolean;
  highWaterMark?: number;
  decodeStrings?: boolean;
  signal?: AbortSignal;
}

type StreamCtor = new (options?: any) => any;

/** A Web `ReadableStream` as a Node-style Readable of the platform's class. */
export type ReadableFromWeb = <T = any>(
  stream: ReadableStream<T>,
  options?: WebReadableOptions
) => IReadable<T>;

/** A Web `WritableStream` as a Node-style Writable of the platform's class. */
export type WritableFromWeb = <T = any>(
  stream: WritableStream<T>,
  options?: WebWritableOptions
) => IWritable<T>;

export function makeReadableFromWeb(Readable: StreamCtor): ReadableFromWeb {
  return (stream, options) => adaptReadableFromWeb(Readable, stream, options);
}

export function makeWritableFromWeb(Writable: StreamCtor): WritableFromWeb {
  return (stream, options) => adaptWritableFromWeb(Writable, stream, options);
}

/** A Node-style Readable as a Web `ReadableStream`. */
export function readableToWeb<T = any>(
  stream: IReadable<T>,
  options?: { strategy?: QueuingStrategy<T> }
): ReadableStream<T> {
  return adaptReadableToWeb<T>(stream, options);
}

/** A Node-style Writable as a Web `WritableStream`. */
export function writableToWeb<T = any>(stream: IWritable<T>): WritableStream<T> {
  return adaptWritableToWeb<T>(stream);
}
