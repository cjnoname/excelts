/**
 * Stream kernel - Duplex.from()
 *
 * Port of Node.js `lib/internal/streams/duplexify.js`: turn a stream, Web
 * stream, iterable, async generator function, promise or `{ readable,
 * writable }` pair into a Duplex. The stream classes are passed in so this module
 * does not import `classes.ts`, which imports it.
 */

import { destroyer } from "@stream/kernel/destroy";
import { eos } from "@stream/kernel/end-of-stream";
import { createAbortError, errInvalidArgType, errInvalidReturnValue } from "@stream/kernel/errors";
import { from } from "@stream/kernel/from";
import type { DuplexifyKernel } from "@stream/kernel/state";
import { nextTick } from "@stream/kernel/state";
import {
  isDuplexNodeStream,
  isIterable,
  isNodeStream,
  isReadable,
  isReadableNodeStream,
  isReadableStream,
  isWritable,
  isWritableNodeStream,
  isWritableStream
} from "@stream/kernel/stream-utils";

type Callback = (error?: Error | null) => void;
export function duplexify(kernel: DuplexifyKernel, body: any, name: string): any {
  const { Readable, Writable, Duplex } = kernel;
  if (isDuplexNodeStream(body)) {
    return body;
  }
  if (isReadableNodeStream(body)) {
    return duplexifyPair(kernel, { readable: body });
  }
  if (isWritableNodeStream(body)) {
    return duplexifyPair(kernel, { writable: body });
  }
  if (isNodeStream(body)) {
    return duplexifyPair(kernel, { writable: false, readable: false });
  }
  if (isReadableStream(body)) {
    return duplexifyPair(kernel, { readable: Readable.fromWeb(body) });
  }
  if (isWritableStream(body)) {
    return duplexifyPair(kernel, { writable: Writable.fromWeb(body) });
  }

  if (typeof body === "function") {
    const { value, write, final, destroy } = fromAsyncGen(body);

    if (isDuplexNodeStream(value)) {
      return value;
    }
    if (isIterable(value)) {
      return from(Duplex, value, { objectMode: true, write, final, destroy });
    }

    const then = value?.then;
    if (typeof then === "function") {
      const promise = then.call(
        value,
        (val: unknown) => {
          if (val != null) {
            throw errInvalidReturnValue("nully", "body", val);
          }
        },
        (err: Error) => {
          destroyer(d, err);
        }
      );
      const d = new Duplex({
        objectMode: true,
        readable: false,
        write,
        final(cb: Callback) {
          final(async () => {
            try {
              await promise;
              nextTick(() => cb(null));
            } catch (err) {
              nextTick(() => cb(err as Error));
            }
          });
        },
        destroy
      });
      return d;
    }

    throw errInvalidReturnValue("Iterable, AsyncIterable or AsyncFunction", name, value);
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return duplexify(kernel, body.arrayBuffer(), name);
  }

  if (isIterable(body)) {
    return from(Duplex, body, { objectMode: true, writable: false });
  }

  if (isReadableStream(body?.readable) && isWritableStream(body?.writable)) {
    return (Duplex as any).fromWeb(body);
  }

  if (typeof body?.writable === "object" || typeof body?.readable === "object") {
    const readable = body?.readable
      ? isReadableNodeStream(body.readable)
        ? body.readable
        : duplexify(kernel, body.readable, name)
      : undefined;
    const writable = body?.writable
      ? isWritableNodeStream(body.writable)
        ? body.writable
        : duplexify(kernel, body.writable, name)
      : undefined;
    return duplexifyPair(kernel, { readable, writable });
  }

  const then = body?.then;
  if (typeof then === "function") {
    then.call(
      body,
      (val: unknown) => {
        if (val != null) {
          d.push(val);
        }
        d.push(null);
      },
      (err: Error) => {
        destroyer(d, err);
      }
    );
    const d = new Duplex({ objectMode: true, writable: false, read() {} });
    return d;
  }

  throw invalidDuplexBody(body, name);
}

/** The error `Duplex.from` throws for a `body` it cannot use. */
export function invalidDuplexBody(body: unknown, name = "body"): Error {
  return errInvalidArgType(
    name,
    [
      "Blob",
      "ReadableStream",
      "WritableStream",
      "Stream",
      "Iterable",
      "AsyncIterable",
      "Function",
      "{ readable, writable } pair",
      "Promise"
    ],
    body
  );
}

/**
 * What `duplexify` would reject inside `body`, found without touching `body`:
 * the branches above, in the same order, with nothing created, locked or
 * subscribed to. `undefined` when it would accept it. A function counts as
 * accepted — what it returns is known only by calling it.
 */
export function rejectedDuplexBody(body: any): { value: unknown } | undefined {
  if (
    isNodeStream(body) ||
    isReadableStream(body) ||
    isWritableStream(body) ||
    typeof body === "function" ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    isIterable(body) ||
    (isReadableStream(body?.readable) && isWritableStream(body?.writable))
  ) {
    return undefined;
  }
  if (typeof body?.writable === "object" || typeof body?.readable === "object") {
    const readable = body?.readable;
    const writable = body?.writable;
    return (
      (readable && !isReadableNodeStream(readable) ? rejectedDuplexBody(readable) : undefined) ??
      (writable && !isWritableNodeStream(writable) ? rejectedDuplexBody(writable) : undefined)
    );
  }
  return typeof body?.then === "function" ? undefined : { value: body };
}

function isThenable(value: any): boolean {
  return !isNodeStream(value) && typeof value?.then === "function";
}

/** Whether `duplexify` would read `body` as a `{ readable, writable }` object of its own. */
function isSidesObject(body: any): boolean {
  return (
    !isNodeStream(body) &&
    !isReadableStream(body) &&
    !isWritableStream(body) &&
    typeof body !== "function" &&
    !isIterable(body) &&
    !(isReadableStream(body?.readable) && isWritableStream(body?.writable)) &&
    (typeof body?.writable === "object" || typeof body?.readable === "object")
  );
}

/**
 * `body` with every promise `duplexify` would subscribe to — the body itself,
 * or a side of a `{ readable, writable }` object, at any depth — adopted into
 * a native promise. A native promise always calls back later; a thenable that
 * calls back at once reaches `duplexify` before its Duplex exists, and throws
 * `Cannot read properties of undefined` — in Node's own `Duplex.from`, too.
 */
export function adoptThenables(body: any): any {
  if (isThenable(body)) {
    return Promise.resolve(body);
  }
  if (isSidesObject(body)) {
    const sides: { readable?: unknown; writable?: unknown } = {};
    if ("readable" in body) {
      sides.readable = adoptThenables(body.readable);
    }
    if ("writable" in body) {
      sides.writable = adoptThenables(body.writable);
    }
    return sides;
  }
  return body;
}

/** Call `visit` on every promise `duplexify` would subscribe to inside `body`. */
export function forEachThenable(body: any, visit: (thenable: PromiseLike<unknown>) => void): void {
  if (isThenable(body)) {
    visit(body);
  } else if (isSidesObject(body)) {
    forEachThenable(body.readable, visit);
    forEachThenable(body.writable, visit);
  }
}

/** Feed writes into an async generator function and read what it yields. */
function fromAsyncGen(
  fn: (source: AsyncGenerator<unknown>, options: { signal: AbortSignal }) => any
): {
  value: any;
  write: (chunk: unknown, encoding: string, cb: Callback) => void;
  final: (cb: Callback) => void;
  destroy: (err: Error | null, cb: Callback) => void;
} {
  type Step = { chunk?: unknown; done: boolean; cb: () => void };
  let resolve: ((step: Step) => void) | null = null;
  let promise: Promise<Step> | null = new Promise<Step>(r => {
    resolve = r;
  });
  const ac = new AbortController();
  const signal = ac.signal;

  const value = fn(
    (async function* () {
      while (true) {
        const current = promise!;
        promise = null;
        const { chunk, done, cb } = await current;
        nextTick(cb);
        if (done) {
          return;
        }
        if (signal.aborted) {
          throw createAbortError(signal.reason);
        }
        promise = new Promise<Step>(r => {
          resolve = r;
        });
        yield chunk;
      }
    })(),
    { signal }
  );

  return {
    value,
    write(chunk, _encoding, cb) {
      const r = resolve!;
      resolve = null;
      r({ chunk, done: false, cb });
    },
    final(cb) {
      const r = resolve!;
      resolve = null;
      r({ done: true, cb });
    },
    destroy(err, cb) {
      ac.abort(err);
      if (resolve !== null) {
        const r = resolve;
        resolve = null;
        r({ done: true, cb() {} });
      }
      cb(err);
    }
  };
}

function duplexifyPair(kernel: DuplexifyKernel, pair: { readable?: any; writable?: any }): any {
  const { Readable, Duplex } = kernel;
  const r =
    pair.readable && typeof pair.readable.read !== "function"
      ? Readable.wrap(pair.readable)
      : pair.readable;
  const w = pair.writable;

  let readable = !!isReadable(r);
  let writable = !!isWritable(w);

  let ondrain: Callback | null = null;
  let onfinish: Callback | null = null;
  let onreadable: (() => void) | null = null;
  // undefined: still open; null: both sides finished; a function: destroy waiting on them.
  let onclose: Callback | null | undefined;

  const d = new Duplex({
    readableObjectMode: !!r?.readableObjectMode,
    writableObjectMode: !!w?.writableObjectMode,
    readable,
    writable
  });

  function onfinished(err?: Error | null): void {
    const cb = onclose;
    onclose = null;
    if (cb) {
      cb(err);
    } else if (err) {
      d.destroy(err);
    }
  }

  if (writable) {
    eos(w, err => {
      writable = false;
      if (err) {
        destroyer(r, err);
      }
      onfinished(err);
    });

    d._write = function (chunk: unknown, encoding: string, callback: Callback) {
      if (w.write(chunk, encoding)) {
        callback();
      } else {
        ondrain = callback;
      }
    };

    d._final = function (callback: Callback) {
      w.end();
      onfinish = callback;
    };

    w.on("drain", () => {
      if (ondrain) {
        const cb = ondrain;
        ondrain = null;
        cb();
      }
    });

    w.on("finish", () => {
      if (onfinish) {
        const cb = onfinish;
        onfinish = null;
        cb();
      }
    });
  }

  if (readable) {
    eos(r, err => {
      readable = false;
      if (err) {
        destroyer(w, err);
      }
      onfinished(err);
    });

    r.on("readable", () => {
      if (onreadable) {
        const cb = onreadable;
        onreadable = null;
        cb();
      }
    });

    r.on("end", () => {
      d.push(null);
    });

    d._read = function () {
      while (true) {
        const buf = r.read();
        if (buf === null) {
          onreadable = d._read;
          return;
        }
        if (!d.push(buf)) {
          return;
        }
      }
    };
  }

  d._destroy = function (err: Error | null, callback: Callback) {
    if (!err && onclose !== null) {
      err = createAbortError();
    }
    onreadable = null;
    ondrain = null;
    onfinish = null;

    if (onclose === null) {
      callback(err);
    } else {
      onclose = callback;
      destroyer(w, err);
      destroyer(r, err);
    }
  };

  return d;
}
