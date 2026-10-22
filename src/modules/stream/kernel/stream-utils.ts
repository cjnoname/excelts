/**
 * Stream kernel - state predicates
 *
 * Port of Node.js `lib/internal/streams/utils.js`. These read a stream's state
 * the same way for our own streams and for third-party / legacy ones, so
 * `finished`, `pipeline` and `destroy` treat both alike.
 */

export const kIsDestroyed = Symbol.for("nodejs.stream.destroyed");
const kIsErrored = Symbol.for("nodejs.stream.errored");
const kIsReadable = Symbol.for("nodejs.stream.readable");
const kIsWritable = Symbol.for("nodejs.stream.writable");
export const kIsDisturbed = Symbol.for("nodejs.stream.disturbed");

export function isReadableNodeStream(obj: any, strict = false): boolean {
  return !!(
    obj &&
    typeof obj.pipe === "function" &&
    typeof obj.on === "function" &&
    (!strict || (typeof obj.pause === "function" && typeof obj.resume === "function")) &&
    (!obj._writableState || obj._readableState?.readable !== false) &&
    (!obj._writableState || obj._readableState)
  );
}

export function isWritableNodeStream(obj: any): boolean {
  return !!(
    obj &&
    typeof obj.write === "function" &&
    typeof obj.on === "function" &&
    (!obj._readableState || obj._writableState?.writable !== false)
  );
}

export function isDuplexNodeStream(obj: any): boolean {
  return !!(
    obj &&
    typeof obj.pipe === "function" &&
    obj._readableState &&
    typeof obj.on === "function" &&
    typeof obj.write === "function"
  );
}

export function isNodeStream(obj: any): boolean {
  return !!(
    obj &&
    (obj._readableState ||
      obj._writableState ||
      (typeof obj.write === "function" && typeof obj.on === "function") ||
      (typeof obj.pipe === "function" && typeof obj.on === "function"))
  );
}

export function isReadableStream(obj: any): obj is ReadableStream {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.pipeThrough === "function" &&
    typeof obj.getReader === "function" &&
    typeof obj.cancel === "function"
  );
}

export function isWritableStream(obj: any): obj is WritableStream {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.getWriter === "function" &&
    typeof obj.abort === "function"
  );
}

export function isTransformStream(obj: any): obj is TransformStream {
  return !!(
    obj &&
    !isNodeStream(obj) &&
    typeof obj.readable === "object" &&
    typeof obj.writable === "object"
  );
}

export function isWebStream(obj: any): boolean {
  return isReadableStream(obj) || isWritableStream(obj) || isTransformStream(obj);
}

export function isIterable(obj: any, isAsync?: boolean): boolean {
  if (obj == null) {
    return false;
  }
  if (isAsync === true) {
    return typeof obj[Symbol.asyncIterator] === "function";
  }
  if (isAsync === false) {
    return typeof obj[Symbol.iterator] === "function";
  }
  return (
    typeof obj[Symbol.asyncIterator] === "function" || typeof obj[Symbol.iterator] === "function"
  );
}

export function isDestroyed(stream: any): boolean | null {
  if (!isNodeStream(stream)) {
    return null;
  }
  const state = stream._writableState || stream._readableState;
  return !!(stream.destroyed || stream[kIsDestroyed] || state?.destroyed);
}

export function isWritableEnded(stream: any): boolean | null {
  if (!isWritableNodeStream(stream)) {
    return null;
  }
  if (stream.writableEnded === true) {
    return true;
  }
  const wState = stream._writableState;
  if (wState?.errored) {
    return false;
  }
  if (typeof wState?.ended !== "boolean") {
    return null;
  }
  return wState.ended;
}

export function isWritableFinished(stream: any, strict?: boolean): boolean | null {
  if (!isWritableNodeStream(stream)) {
    return null;
  }
  if (stream.writableFinished === true) {
    return true;
  }
  const wState = stream._writableState;
  if (wState?.errored) {
    return false;
  }
  if (typeof wState?.finished !== "boolean") {
    return null;
  }
  return !!(wState.finished || (strict === false && wState.ended === true && wState.length === 0));
}

export function isReadableFinished(stream: any, strict?: boolean): boolean | null {
  if (!isReadableNodeStream(stream)) {
    return null;
  }
  const rState = stream._readableState;
  if (rState?.errored) {
    return false;
  }
  if (typeof rState?.endEmitted !== "boolean") {
    return null;
  }
  return !!(
    rState.endEmitted ||
    (strict === false && rState.ended === true && rState.length === 0)
  );
}

export function isReadable(stream: any): boolean | null {
  if (stream && stream[kIsReadable] != null) {
    return stream[kIsReadable];
  }
  if (typeof stream?.readable !== "boolean") {
    return null;
  }
  if (isDestroyed(stream)) {
    return false;
  }
  return isReadableNodeStream(stream) && stream.readable && !isReadableFinished(stream);
}

export function isWritable(stream: any): boolean | null {
  if (stream && stream[kIsWritable] != null) {
    return stream[kIsWritable];
  }
  if (typeof stream?.writable !== "boolean") {
    return null;
  }
  if (isDestroyed(stream)) {
    return false;
  }
  return isWritableNodeStream(stream) && stream.writable && !isWritableEnded(stream);
}

export function isFinished(
  stream: any,
  opts?: { readable?: boolean; writable?: boolean }
): boolean | null {
  if (!isNodeStream(stream)) {
    return null;
  }
  if (isDestroyed(stream)) {
    return true;
  }
  if (opts?.readable !== false && isReadable(stream)) {
    return false;
  }
  if (opts?.writable !== false && isWritable(stream)) {
    return false;
  }
  return true;
}

export function isWritableErrored(stream: any): Error | null {
  if (!isNodeStream(stream)) {
    return null;
  }
  return stream.writableErrored || (stream._writableState?.errored ?? null);
}

export function isReadableErrored(stream: any): Error | null {
  if (!isNodeStream(stream)) {
    return null;
  }
  return stream.readableErrored || (stream._readableState?.errored ?? null);
}

export function isClosed(stream: any): boolean | null {
  if (!isNodeStream(stream)) {
    return null;
  }
  if (typeof stream.closed === "boolean") {
    return stream.closed;
  }
  const wState = stream._writableState;
  const rState = stream._readableState;
  if (typeof wState?.closed === "boolean" || typeof rState?.closed === "boolean") {
    return wState?.closed || rState?.closed;
  }
  return null;
}

export function willEmitClose(stream: any): boolean | null {
  if (!isNodeStream(stream)) {
    return null;
  }
  const state = stream._writableState || stream._readableState;
  return !!(state?.autoDestroy && state.emitClose && state.closed === false);
}

export function isDisturbed(stream: any): boolean {
  return !!(stream && (stream[kIsDisturbed] ?? (stream.readableDidRead || stream.readableAborted)));
}

export function isErrored(stream: any): boolean {
  return !!(
    stream &&
    (stream[kIsErrored] ??
      stream.readableErrored ??
      stream.writableErrored ??
      stream._readableState?.errorEmitted ??
      stream._writableState?.errorEmitted ??
      stream._readableState?.errored ??
      stream._writableState?.errored)
  );
}
