/**
 * Node.js Stream - Web Streams conversions and `toWritable`, over Node's classes.
 */

import { Readable, Writable } from "stream";

import { isWritableStream } from "@stream/core/type-guards";
import { makeReadableFromWeb, makeWritableFromWeb } from "@stream/core/web-conversions";
import type { ReadableFromWeb, WritableFromWeb } from "@stream/core/web-conversions";
import type { WritableLike } from "@stream/types";

/**
 * Normalize a user-provided writable into one this module can drive: a Web
 * `WritableStream` is adapted, anything Node-like is used as is.
 *
 * The signature names no Node class, so the browser declaration of the same
 * function does not need `@types/node`.
 */
export function toWritable<T = Uint8Array>(stream: WritableLike | WritableStream<T>): WritableLike {
  if (!isWritableStream(stream) || stream instanceof Writable) {
    return stream as WritableLike;
  }
  // The module's own adapter: it drives the Web stream through its writer only
  // (so it also runs on Bun, whose `Writable.fromWeb` misbehaves) and aborts it
  // when the returned Writable is destroyed.
  return writableFromWeb(stream as WritableStream<T>) as unknown as WritableLike;
}

/** A Web `ReadableStream` as a Readable, with the module's guarantees; see `web-conversions`. */
export const readableFromWeb: ReadableFromWeb = /* @__PURE__ */ makeReadableFromWeb(Readable);

/** A Web `WritableStream` as a Writable, with the module's guarantees; see `web-conversions`. */
export const writableFromWeb: WritableFromWeb = /* @__PURE__ */ makeWritableFromWeb(Writable);

export { readableToWeb, writableToWeb } from "@stream/core/web-conversions";
