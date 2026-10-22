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

/**
 * A Web `ReadableStream` as a Node-style Readable of the platform's class,
 * typed by what it yields. The default is byte mode, as in Node: every chunk
 * reads back as a `Uint8Array`, and only strings and binary views can be
 * carried. `objectMode: true` passes chunks through; an `encoding` decodes
 * them to strings. A mode known only at run time gets every possibility.
 */
export interface ReadableFromWeb {
  (
    stream: ReadableStream<string | ArrayBufferView>,
    options: WebReadableOptions & { encoding: string }
  ): IReadable<string>;
  <T>(
    stream: ReadableStream<T>,
    options: WebReadableOptions & { objectMode: true; encoding?: undefined }
  ): IReadable<T>;
  (
    stream: ReadableStream<string | ArrayBufferView>,
    options?: WebReadableOptions & { objectMode?: false; encoding?: undefined }
  ): IReadable<Uint8Array>;
  /**
   * A mode known only at run time — a `boolean`, or options held in a
   * variable. It may be bytes, so the stream must carry what byte mode can.
   */
  <T extends string | ArrayBufferView>(
    stream: ReadableStream<T>,
    options?: WebReadableOptions
  ): IReadable<T | Uint8Array | string>;
}

/** A Web `WritableStream` as a Node-style Writable of the platform's class. */
export type WritableFromWeb = <T = any>(
  stream: WritableStream<T>,
  options?: WebWritableOptions
) => IWritable<T>;

export function makeReadableFromWeb(Readable: StreamCtor): ReadableFromWeb {
  return (stream: ReadableStream, options?: WebReadableOptions) =>
    adaptReadableFromWeb(Readable, stream, options);
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
