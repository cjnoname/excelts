/**
 * Stream helpers shared by the Node and browser entry points.
 *
 * Everything here works on the public shape of a stream — async iteration,
 * a Web `ReadableStream`'s reader, the `readable*` / `writable*` getters — so
 * it is the same code on both platforms. A Web stream is read through its own
 * reader; it is not wrapped in a Node-style stream first.
 */

import { toStreamBytes } from "@stream/core/binary-chunk";
import { isAsyncIterable, isReadableStream } from "@stream/core/type-guards";
import { UnsupportedStreamTypeError } from "@stream/errors";
import type { ReadableLike, WritableLike } from "@stream/types";
import { concatUint8Arrays, createTextDecoder } from "@utils/binary";

/** A stream or anything else that can be iterated asynchronously. */
export type AsyncIterableStream = { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> };

/** `true` for an object with a Web `ReadableStream`'s `getReader()`. */
export const isReadableStreamLike = isReadableStream as (
  value: unknown
) => value is { getReader: () => any };

/**
 * Read a Web `ReadableStream` with `for await`, whether or not the platform's
 * `ReadableStream` is async-iterable itself. Every value is yielded as read —
 * `null` and `undefined` included, as `ReadableStream.prototype.values()` does —
 * so the caller decides what a value it cannot use means. Leaving the loop
 * early cancels the stream; the lock is released either way.
 */
export async function* readableStreamToAsyncIterable<T = Uint8Array>(stream: {
  getReader: () => any;
}): AsyncGenerator<T, void, unknown> {
  const reader = stream.getReader();
  let done = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        return;
      }
      yield result.value as T;
    }
  } finally {
    if (!done) {
      await reader.cancel?.().catch(() => {});
    }
    reader.releaseLock?.();
  }
}

/** Every chunk of a stream, in an array. */
export async function collect<T>(stream: {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}): Promise<T[]> {
  const result: T[] = [];
  for await (const chunk of stream) {
    result.push(chunk);
  }
  return result;
}

/** A whole stream decoded as UTF-8 text. */
export function text(stream: AsyncIterableStream): Promise<string> {
  return streamToString(stream as AsyncIterable<Uint8Array>);
}

/** A whole stream parsed as JSON. */
export async function json<T = unknown>(stream: AsyncIterableStream): Promise<T> {
  return JSON.parse(await text(stream)) as T;
}

/** A whole stream's bytes. */
export function bytes(stream: AsyncIterableStream): Promise<Uint8Array> {
  return streamToUint8Array(stream as AsyncIterable<Uint8Array>);
}

function toAsyncIterable<T>(
  stream: AsyncIterable<T> | ReadableStream<T>,
  name: string
): AsyncIterable<T> {
  if (isReadableStream(stream)) {
    return readableStreamToAsyncIterable<T>(stream);
  }
  if (isAsyncIterable(stream)) {
    return stream as AsyncIterable<T>;
  }
  throw new UnsupportedStreamTypeError(name, typeof stream);
}

/** Collect every byte of a stream. */
export async function streamToUint8Array(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of toAsyncIterable(stream, "streamToUint8Array")) {
    const bytes = toStreamBytes(chunk);
    if (!bytes) {
      throw new UnsupportedStreamTypeError("streamToUint8Array", typeof chunk);
    }
    chunks.push(bytes);
    totalLength += bytes.byteLength;
  }
  return concatUint8Arrays(chunks, totalLength);
}

/** Alias of {@link streamToUint8Array}, named after Node's `Buffer`. */
export function streamToBuffer(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  return streamToUint8Array(stream);
}

/** Decode a whole stream as text. */
export async function streamToString(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  encoding?: string
): Promise<string> {
  const decoder = createTextDecoder(encoding);
  let text = "";
  for await (const chunk of toAsyncIterable(stream, "streamToString")) {
    const bytes = toStreamBytes(chunk);
    if (!bytes) {
      throw new UnsupportedStreamTypeError("streamToString", typeof chunk);
    }
    text += decoder.decode(bytes, { stream: true });
  }
  return text + decoder.decode();
}

/** Consume a stream to its end, discarding the data. */
export async function drainStream(
  stream: AsyncIterable<unknown> | ReadableStream<unknown>
): Promise<void> {
  for await (const _chunk of toAsyncIterable(stream, "drainStream")) {
    // discard
  }
}

/** `true` for a Node-style readable stream that can still be read from. */
export function isReadable(stream: unknown): stream is ReadableLike {
  const s = stream as {
    read?: unknown;
    pipe?: unknown;
    destroyed?: boolean;
    readable?: boolean;
    readableEnded?: boolean;
  } | null;
  return (
    !!s &&
    typeof s.read === "function" &&
    typeof s.pipe === "function" &&
    !s.destroyed &&
    s.readable !== false &&
    s.readableEnded !== true
  );
}

/** `true` for a Node-style writable stream that can still be written to. */
export function isWritable(stream: unknown): stream is WritableLike {
  const s = stream as {
    write?: unknown;
    end?: unknown;
    destroyed?: boolean;
    writable?: boolean;
    writableEnded?: boolean;
  } | null;
  return (
    !!s &&
    typeof s.write === "function" &&
    typeof s.end === "function" &&
    !s.destroyed &&
    s.writable !== false &&
    s.writableEnded !== true
  );
}

const kIsDisturbed = Symbol.for("nodejs.stream.disturbed");

/**
 * `true` once a readable stream has been read from or aborted.
 *
 * Node's own Web streams answer through an internal symbol, which is consulted
 * first. Elsewhere a Web `ReadableStream` has no public "disturbed" flag, but
 * the Fetch spec makes it observable: `new Response(stream)` must throw for a
 * stream that is disturbed or locked, and does nothing to one that is neither —
 * it takes no lock and reads nothing. So an unlocked stream gets an exact
 * answer. A locked one cannot be told apart (locked-and-read and
 * locked-but-unread both throw) and reports `false`, as Node does for a stream
 * that is locked but not yet read.
 */
export function isDisturbed(stream: unknown): boolean {
  const s = stream as {
    [kIsDisturbed]?: boolean;
    readableDidRead?: boolean;
    readableAborted?: boolean;
  } | null;
  if (!s) {
    return false;
  }
  const known = s[kIsDisturbed] ?? (s.readableDidRead || s.readableAborted);
  if (known !== undefined) {
    return !!known;
  }
  if (isReadableStream(s) && !s.locked && typeof Response === "function") {
    try {
      new Response(s);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}
