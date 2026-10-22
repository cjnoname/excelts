/**
 * Stream kernel - end-of-stream detection
 *
 * Port of Node.js `lib/internal/streams/end-of-stream.js`: one place that
 * decides when a stream is done and whether it ended cleanly or prematurely.
 * `finished`, `pipeline`, `compose`, async iteration and the Web adapters all
 * rely on it, so they cannot disagree about completion.
 */

import {
  createAbortError,
  errInvalidArgType,
  errStreamPrematureClose
} from "@stream/kernel/errors";
import { nextTick } from "@stream/kernel/state";
import {
  isClosed,
  isNodeStream,
  isReadable,
  isReadableErrored,
  isReadableFinished,
  isReadableNodeStream,
  isWritable,
  isWritableErrored,
  isWritableFinished,
  isWritableNodeStream,
  willEmitClose as streamWillEmitClose
} from "@stream/kernel/stream-utils";

interface EosOptions {
  readable?: boolean;
  writable?: boolean;
  error?: boolean;
  signal?: AbortSignal;
  /** Invoke the callback synchronously when the result is already known. */
  synchronous?: boolean;
}

type EosCallback = (err?: Error | null) => void;

const nop = (): void => {};

function getEosErrored(stream: any): Error | null {
  return isWritableErrored(stream) || isReadableErrored(stream) || null;
}

function getEosOnCloseError(
  stream: any,
  readable: boolean,
  readableFinished: boolean | null,
  writable: boolean,
  writableFinished: boolean | null
): Error | null {
  const errored = getEosErrored(stream);
  if (errored) {
    return errored;
  }
  if (readable && !readableFinished && isReadableNodeStream(stream, true)) {
    if (!isReadableFinished(stream, false)) {
      return errStreamPrematureClose();
    }
  }
  if (writable && !writableFinished) {
    if (!isWritableFinished(stream, false)) {
      return errStreamPrematureClose();
    }
  }
  return null;
}

/**
 * Call `callback` once `stream` has finished, errored or closed. Returns a
 * function that detaches every listener this call added.
 */
export function eos(stream: any, callback: EosCallback): () => void;
export function eos(stream: any, options: EosOptions | null, callback: EosCallback): () => void;
export function eos(
  stream: any,
  optionsOrCallback: EosOptions | null | EosCallback,
  maybeCallback?: EosCallback
): () => void {
  let options: EosOptions;
  let callback: EosCallback;
  if (typeof optionsOrCallback === "function") {
    options = {};
    callback = optionsOrCallback;
  } else {
    options = optionsOrCallback ?? {};
    callback = maybeCallback!;
  }

  if (!isNodeStream(stream)) {
    throw errInvalidArgType("stream", ["ReadableStream", "WritableStream", "Stream"], stream);
  }

  const readable = options.readable ?? isReadableNodeStream(stream);
  const writable = options.writable ?? isWritableNodeStream(stream);

  let willEmitClose =
    !!streamWillEmitClose(stream) &&
    isReadableNodeStream(stream) === readable &&
    isWritableNodeStream(stream) === writable;
  let writableFinished = isWritableFinished(stream, false);
  let readableFinished = isReadableFinished(stream, false);

  const wState = stream._writableState;
  const rState = stream._readableState;

  // undefined: still pending; null: done cleanly; Error: done with an error.
  let immediateResult: Error | null | undefined;
  if (isClosed(stream)) {
    immediateResult = getEosOnCloseError(
      stream,
      readable,
      readableFinished,
      writable,
      writableFinished
    );
  } else if (wState?.errorEmitted || rState?.errorEmitted) {
    if (!willEmitClose) {
      immediateResult = getEosErrored(stream);
    }
  } else if (
    !readable &&
    (!willEmitClose || isReadable(stream)) &&
    (writableFinished || isWritable(stream) === false) &&
    (wState == null || wState.pendingcb === undefined || wState.pendingcb === 0)
  ) {
    immediateResult = getEosErrored(stream);
  } else if (
    !writable &&
    (!willEmitClose || isWritable(stream)) &&
    (readableFinished || isReadable(stream) === false)
  ) {
    immediateResult = getEosErrored(stream);
  }

  let cleanup = (): void => {
    callback = nop;
  };

  if (immediateResult !== undefined) {
    if (options.error !== false) {
      stream.on("error", nop);
      cleanup = () => {
        callback = nop;
        stream.removeListener("error", nop);
      };
    }
  } else if (options.signal?.aborted) {
    immediateResult = createAbortError(options.signal.reason);
  }

  if (immediateResult !== undefined) {
    const result = immediateResult;
    const report = (): void => {
      if (result === null) {
        callback.call(stream);
      } else {
        callback.call(stream, result);
      }
    };
    if (options.synchronous) {
      report();
    } else {
      nextTick(report);
    }
    return cleanup;
  }

  let called = false;
  const userCallback = callback;
  callback = function (this: unknown, err?: Error | null) {
    if (called) {
      return;
    }
    called = true;
    userCallback.call(this, err);
  };

  const onlegacyfinish = (): void => {
    if (!stream.writable) {
      onfinish();
    }
  };

  const onfinish = (): void => {
    writableFinished = true;
    if (stream.destroyed) {
      willEmitClose = false;
    }
    if (willEmitClose && (!stream.readable || readable)) {
      return;
    }
    if (!readable || readableFinished) {
      callback.call(stream);
    }
  };

  const onend = (): void => {
    readableFinished = true;
    if (stream.destroyed) {
      willEmitClose = false;
    }
    if (willEmitClose && (!stream.writable || writable)) {
      return;
    }
    if (!writable || writableFinished) {
      callback.call(stream);
    }
  };

  const onerror = (err: Error): void => {
    callback.call(stream, err);
  };

  const onclose = (): void => {
    const error = getEosOnCloseError(
      stream,
      readable,
      readableFinished,
      writable,
      writableFinished
    );
    if (error === null) {
      callback.call(stream);
    } else {
      callback.call(stream, error);
    }
  };

  // Legacy streams have no writable state to say when they finished.
  if (writable && !wState) {
    stream.on("end", onlegacyfinish);
    stream.on("close", onlegacyfinish);
  }

  stream.on("end", onend);
  stream.on("finish", onfinish);
  if (options.error !== false) {
    stream.on("error", onerror);
  }
  stream.on("close", onclose);

  cleanup = () => {
    callback = nop;
    stream.removeListener("end", onlegacyfinish);
    stream.removeListener("close", onlegacyfinish);
    stream.removeListener("finish", onfinish);
    stream.removeListener("end", onend);
    stream.removeListener("error", onerror);
    stream.removeListener("close", onclose);
  };

  const signal = options.signal;
  if (signal) {
    const abort = (): void => {
      const endCallback = callback;
      cleanup();
      endCallback.call(stream, createAbortError(signal.reason));
    };
    signal.addEventListener("abort", abort, { once: true });
    const originalCallback = callback;
    callback = function (this: unknown, err?: Error | null) {
      signal.removeEventListener("abort", abort);
      originalCallback.call(this, err);
    };
  }

  return cleanup;
}

/** Destroy `stream` when `signal` aborts; detaches once the stream is done. */
export function addAbortSignalNoValidate<S extends { destroy(err?: Error | null): unknown }>(
  signal: AbortSignal,
  stream: S
): S {
  if (typeof signal !== "object" || !("aborted" in signal)) {
    return stream;
  }
  const onAbort = (): void => {
    stream.destroy(createAbortError(signal.reason));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
    eos(stream, () => signal.removeEventListener("abort", onAbort));
  }
  return stream;
}
