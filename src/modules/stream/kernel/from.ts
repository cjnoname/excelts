/**
 * Stream kernel - Readable.from()
 *
 * Port of Node.js `lib/internal/streams/from.js`. The source iterator is
 * closed from `_destroy`, so leaving a stream early — `break` in a
 * `for await`, `destroy()`, an error downstream — always runs the source's
 * `finally` blocks and releases whatever it holds, whether or not another
 * `_read()` ever happens.
 */

import { aggregateTwoErrors, errInvalidArgType, errStreamNullValues } from "@stream/kernel/errors";
import { nextTick } from "@stream/kernel/state";

interface FromTarget {
  _read(size?: number): void;
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
  push(chunk: unknown): boolean;
  destroy(error?: Error | null): unknown;
}

export function from<R extends FromTarget>(
  ReadableCtor: new (options?: any) => R,
  iterable: unknown,
  opts?: Record<string, unknown>
): R {
  if (typeof iterable === "string") {
    return new ReadableCtor({
      objectMode: true,
      ...opts,
      read(this: R) {
        this.push(iterable);
        this.push(null);
      }
    });
  }

  let isAsync: boolean;
  let iterator: Iterator<unknown> | AsyncIterator<unknown>;
  const source = iterable as Partial<AsyncIterable<unknown> & Iterable<unknown>> | null | undefined;
  const asyncFactory = source?.[Symbol.asyncIterator];
  const syncFactory = source?.[Symbol.iterator];
  if (asyncFactory) {
    isAsync = true;
    iterator = asyncFactory.call(source);
  } else if (typeof (iterable as ReadableStream | null)?.getReader === "function") {
    // A ReadableStream where the platform has not made it async-iterable yet.
    isAsync = true;
    iterator = readerValues(iterable as ReadableStream);
  } else if (syncFactory) {
    isAsync = false;
    iterator = syncFactory.call(source);
  } else {
    throw errInvalidArgType("iterable", ["Iterable"], iterable);
  }

  const readable = new ReadableCtor({ objectMode: true, highWaterMark: 1, ...opts });
  const originalDestroy = readable._destroy;

  let reading = false;
  let isAsyncValues = false;

  readable._read = function () {
    if (!reading) {
      reading = true;
      if (isAsync) {
        nextAsync();
      } else if (isAsyncValues) {
        nextSyncWithAsyncValues();
      } else {
        nextSyncWithSyncValues();
      }
    }
  };

  readable._destroy = function (error, cb) {
    originalDestroy.call(this, error, destroyError => {
      const combinedError = destroyError || error;
      close(combinedError).then(
        () => nextTick(() => cb(combinedError)),
        closeError => nextTick(() => cb(aggregateTwoErrors(combinedError, closeError))!)
      );
    });
  };

  async function close(error: Error | null | undefined): Promise<void> {
    const hadError = error !== undefined && error !== null;
    if (hadError && typeof iterator.throw === "function") {
      const { value, done } = await iterator.throw(error);
      await value;
      if (done) {
        return;
      }
    }
    if (typeof iterator.return === "function") {
      const { value } = await iterator.return();
      await value;
    }
  }

  function nextSyncWithSyncValues(): void {
    for (;;) {
      try {
        const { value, done } = (iterator as Iterator<unknown>).next();
        if (done) {
          readable.push(null);
          return;
        }
        if (value && typeof (value as PromiseLike<unknown>).then === "function") {
          changeToAsyncValues(value as PromiseLike<unknown>);
          return;
        }
        if (value === null) {
          reading = false;
          throw errStreamNullValues();
        }
        if (readable.push(value)) {
          continue;
        }
        reading = false;
      } catch (err) {
        readable.destroy(err as Error);
      }
      break;
    }
  }

  async function changeToAsyncValues(value: PromiseLike<unknown>): Promise<void> {
    isAsyncValues = true;
    try {
      const res = await value;
      if (res === null) {
        reading = false;
        throw errStreamNullValues();
      }
      if (readable.push(res)) {
        nextSyncWithAsyncValues();
        return;
      }
      reading = false;
    } catch (err) {
      readable.destroy(err as Error);
    }
  }

  async function nextSyncWithAsyncValues(): Promise<void> {
    for (;;) {
      try {
        const { value, done } = (iterator as Iterator<unknown>).next();
        if (done) {
          readable.push(null);
          return;
        }
        const res =
          value && typeof (value as PromiseLike<unknown>).then === "function"
            ? await (value as PromiseLike<unknown>)
            : value;
        if (res === null) {
          reading = false;
          throw errStreamNullValues();
        }
        if (readable.push(res)) {
          continue;
        }
        reading = false;
      } catch (err) {
        readable.destroy(err as Error);
      }
      break;
    }
  }

  async function nextAsync(): Promise<void> {
    for (;;) {
      try {
        const { value, done } = await (iterator as AsyncIterator<unknown>).next();
        if (done) {
          readable.push(null);
          return;
        }
        if (value === null) {
          reading = false;
          throw errStreamNullValues();
        }
        if (readable.push(value)) {
          continue;
        }
        reading = false;
      } catch (err) {
        readable.destroy(err as Error);
      }
      break;
    }
  }

  return readable;
}

/**
 * What `ReadableStream.prototype.values()` does: every value as read, `null`
 * included (`from()` rejects it as Node does); leaving early cancels the
 * stream, and the lock is released either way.
 */
async function* readerValues(stream: ReadableStream): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  let done = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!done) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
