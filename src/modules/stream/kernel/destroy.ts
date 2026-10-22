/**
 * Stream kernel - destroy / construct lifecycle
 *
 * Port of Node.js `lib/internal/streams/destroy.js`. Every stream class shares
 * these functions, so a Duplex is destroyed once — both of its states are
 * marked in the same call, and `'error'` / `'close'` are emitted once.
 */

import { aggregateTwoErrors, createAbortError, errMultipleCallback } from "@stream/kernel/errors";
import type { DestroyableStream, ReadableState, WritableState } from "@stream/kernel/state";
import { nextTick } from "@stream/kernel/state";
import { isDestroyed, isFinished, kIsDestroyed } from "@stream/kernel/stream-utils";

const kDestroy = Symbol("kDestroy");
const kConstruct = Symbol("kConstruct");

function checkError(err: Error | null | undefined, w?: WritableState, r?: ReadableState): void {
  if (err) {
    if (w && !w.errored) {
      w.errored = err;
    }
    if (r && !r.errored) {
      r.errored = err;
    }
  }
}

export function destroy<S extends DestroyableStream>(
  this: S,
  err?: Error | null,
  cb?: (error?: Error | null) => void
): S {
  const r = this._readableState;
  const w = this._writableState;
  const s = (w || r)!;

  if (w?.destroyed || r?.destroyed) {
    if (typeof cb === "function") {
      cb();
    }
    return this;
  }

  // Mark destroyed before any callback runs so re-entrant destroy() is a no-op.
  checkError(err, w, r);
  if (w) {
    w.destroyed = true;
  }
  if (r) {
    r.destroyed = true;
  }

  if (!s.constructed) {
    this.once(kDestroy, (er?: Error | null) => {
      callDestroy(this, aggregateTwoErrors(er, err), cb);
    });
  } else {
    callDestroy(this, err, cb);
  }
  return this;
}

function callDestroy(
  self: DestroyableStream,
  err: Error | null | undefined,
  cb?: (error?: Error | null) => void
): void {
  let called = false;

  const onDestroy = (err?: Error | null): void => {
    if (called) {
      return;
    }
    called = true;

    const r = self._readableState;
    const w = self._writableState;
    checkError(err, w, r);
    if (w) {
      w.closed = true;
    }
    if (r) {
      r.closed = true;
    }

    if (typeof cb === "function") {
      cb(err);
    }

    if (err) {
      nextTick(() => emitErrorCloseNT(self, err));
    } else {
      nextTick(() => emitCloseNT(self));
    }
  };

  try {
    self._destroy(err || null, onDestroy);
  } catch (e) {
    onDestroy(e as Error);
  }
}

function emitErrorCloseNT(self: DestroyableStream, err: Error): void {
  emitErrorNT(self, err);
  emitCloseNT(self);
}

function emitCloseNT(self: DestroyableStream): void {
  const r = self._readableState;
  const w = self._writableState;
  if (w) {
    w.closeEmitted = true;
  }
  if (r) {
    r.closeEmitted = true;
  }
  if (w?.emitClose || r?.emitClose) {
    self.emit("close");
  }
}

function emitErrorNT(self: DestroyableStream, err: Error): void {
  const r = self._readableState;
  const w = self._writableState;
  if (w?.errorEmitted || r?.errorEmitted) {
    return;
  }
  if (w) {
    w.errorEmitted = true;
  }
  if (r) {
    r.errorEmitted = true;
  }
  self.emit("error", err);
}

export function undestroy(this: DestroyableStream): void {
  const r = this._readableState;
  const w = this._writableState;

  if (r) {
    r.constructed = true;
    r.closed = false;
    r.closeEmitted = false;
    r.destroyed = false;
    r.errored = null;
    r.errorEmitted = false;
    r.reading = false;
    r.ended = r.readable === false;
    r.endEmitted = r.readable === false;
  }

  if (w) {
    w.constructed = true;
    w.destroyed = false;
    w.closed = false;
    w.closeEmitted = false;
    w.errored = null;
    w.errorEmitted = false;
    w.finalCalled = false;
    w.prefinished = false;
    w.ended = w.writable === false;
    w.ending = w.writable === false;
    w.finished = w.writable === false;
  }
}

/**
 * Report an error the way the stream is configured to: destroy it when
 * `autoDestroy` is on, otherwise record and emit it without tearing down.
 */
export function errorOrDestroy(stream: DestroyableStream, err: Error, sync?: boolean): void {
  const r = stream._readableState;
  const w = stream._writableState;

  if (w?.destroyed || r?.destroyed) {
    return;
  }

  if (r?.autoDestroy || w?.autoDestroy) {
    stream.destroy(err);
  } else if (err) {
    if (w && !w.errored) {
      w.errored = err;
    }
    if (r && !r.errored) {
      r.errored = err;
    }
    if (sync) {
      nextTick(() => emitErrorNT(stream, err));
    } else {
      emitErrorNT(stream, err);
    }
  }
}

export function construct(stream: DestroyableStream, cb: () => void): void {
  if (typeof stream._construct !== "function") {
    return;
  }

  const r = stream._readableState;
  const w = stream._writableState;
  if (r) {
    r.constructed = false;
  }
  if (w) {
    w.constructed = false;
  }

  stream.once(kConstruct, cb);

  if (stream.listenerCount(kConstruct) > 1) {
    // Duplex: the second side registers its callback on the same run.
    return;
  }

  nextTick(() => constructNT(stream));
}

function constructNT(stream: DestroyableStream): void {
  let called = false;

  const onConstruct = (err?: Error | null): void => {
    if (called) {
      errorOrDestroy(stream, err ?? errMultipleCallback());
      return;
    }
    called = true;

    const r = stream._readableState;
    const w = stream._writableState;
    const s = (w || r)!;
    if (r) {
      r.constructed = true;
    }
    if (w) {
      w.constructed = true;
    }

    if (s.destroyed) {
      stream.emit(kDestroy, err);
    } else if (err) {
      errorOrDestroy(stream, err, true);
    } else {
      stream.emit(kConstruct);
    }
  };

  try {
    stream._construct!(err => {
      nextTick(() => onConstruct(err));
    });
  } catch (err) {
    nextTick(() => onConstruct(err as Error));
  }
}

/**
 * Tear down any stream-like object. A stream that has not finished cleanly is
 * destroyed with an AbortError so whoever is waiting on it learns why.
 */
export function destroyer(stream: any, err?: Error | null): void {
  if (!stream || isDestroyed(stream)) {
    return;
  }

  if (!err && !isFinished(stream)) {
    err = createAbortError();
  }

  if (typeof stream.destroy === "function") {
    stream.destroy(err);
  } else if (typeof stream.close === "function") {
    stream.close();
  } else if (err) {
    nextTick(() => {
      stream.emit("error", err);
      nextTick(() => stream.emit("close"));
    });
  } else {
    nextTick(() => stream.emit("close"));
  }

  if (!stream.destroyed) {
    stream[kIsDestroyed] = true;
  }
}
