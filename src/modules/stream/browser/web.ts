/**
 * Browser Stream - Web Streams conversions and `toWritable`
 *
 * Its own module so that converting a Writable does not keep the Readable
 * side of the kernel in a bundle.
 */

import { makeReadableFromWeb, makeWritableFromWeb } from "@stream/core/web-conversions";
import type { ReadableFromWeb, WritableFromWeb } from "@stream/core/web-conversions";
import { Readable } from "@stream/kernel/classes";
import { isWritableStream } from "@stream/kernel/stream-utils";
import { Writable } from "@stream/kernel/writable";
import type { WritableLike } from "@stream/types";

/** A Web `ReadableStream` as a Readable, with the module's guarantees; see `web-conversions`. */
export const readableFromWeb: ReadableFromWeb = /* @__PURE__ */ makeReadableFromWeb(Readable);

/** A Web `WritableStream` as a Writable, with the module's guarantees; see `web-conversions`. */
export const writableFromWeb: WritableFromWeb = /* @__PURE__ */ makeWritableFromWeb(Writable);

export { readableToWeb, writableToWeb } from "@stream/core/web-conversions";

/**
 * Normalize a user-provided writable into one this module can drive: a Web
 * `WritableStream` is adapted, anything Node-like is used as is.
 */
export function toWritable<T = Uint8Array>(stream: WritableLike | WritableStream<T>): WritableLike {
  if (isWritableStream(stream)) {
    return writableFromWeb(stream as WritableStream<T>) as unknown as WritableLike;
  }
  return stream as WritableLike;
}
