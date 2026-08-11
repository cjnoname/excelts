/**
 * Browser Stream - Pipeline & Finished
 */

import { Duplex } from "@stream/browser/duplex";
import { createListenerRegistry } from "@stream/browser/helpers";
import { Readable } from "@stream/browser/readable";
import { Transform } from "@stream/browser/transform";
import { Writable } from "@stream/browser/writable";
import { createFinishedAll } from "@stream/core/finished-all";
import type { PipelineOptions, PipelineCallback, FinishedOptions } from "@stream/core/options";
import { isPipelineOptions } from "@stream/core/options";
import { isReadableStream, isTransformStream, isWritableStream } from "@stream/core/type-guards";
import { createAbortError } from "@stream/errors";
import type {
  EventEmitterLike,
  PipelineGeneratorStage,
  PipelineStageLike,
  PipelineStreamLike
} from "@stream/types";

// Re-export for consumers
export type { PipelineOptions, FinishedOptions } from "@stream/core/options";
export { isPipelineOptions } from "@stream/core/options";

// =============================================================================
// Pipeline
// =============================================================================

/**
 * Structural view of the runtime stream-state properties this module inspects
 * to drive pipeline/finished completion logic. Members are optional because
 * the inputs may be our own Readable/Writable/Transform/Duplex, Web streams,
 * or third-party duck-typed streams that expose only a subset.
 */
interface StreamStateProbe {
  read?: unknown;
  write?: (chunk: unknown) => boolean;
  pipe?: (destination: unknown, options?: { end?: boolean }) => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
  destroy?: (error?: Error) => unknown;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  once?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
  readable?: boolean;
  writable?: boolean;
  readableEnded?: boolean;
  writableFinished?: boolean;
  destroyed?: boolean;
  closed?: boolean;
  errored?: Error | null;
  _closed?: boolean;
  _destroyed?: boolean;
  _errored?: Error | null;
  _endEmitted?: boolean;
  _finished?: boolean;
  _emitClose?: boolean;
  _autoDestroy?: boolean;
  // Runtime streams produced by generator stages are async-iterable Readables.
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

function asProbe(stream: unknown): StreamStateProbe {
  return stream as StreamStateProbe;
}

function supportsReadableSide(stream: StreamStateProbe): boolean {
  // Check for readable-side properties/methods.  Writable.pipe() is a no-op
  // that emits ERR_STREAM_CANNOT_PIPE, so `typeof pipe === "function"` alone
  // is not sufficient — we must also see an actual readable indicator.
  return "readableEnded" in stream || "readable" in stream || typeof stream.read === "function";
}

function supportsWritableSide(stream: StreamStateProbe): boolean {
  return "writableFinished" in stream || "writable" in stream || typeof stream.write === "function";
}

function isStreamCompleted(stream: StreamStateProbe): boolean {
  const readableDone = !supportsReadableSide(stream) || !!stream.readableEnded;
  const writableDone = !supportsWritableSide(stream) || !!stream.writableFinished;
  return readableDone && writableDone;
}

function createPrematureCloseError(): Error & { code: string } {
  const err = new Error("Premature close") as Error & { code: string };
  err.code = "ERR_STREAM_PREMATURE_CLOSE";
  err.name = "Error [ERR_STREAM_PREMATURE_CLOSE]";
  return err;
}

/**
 * Wait for a stream's 'close' event after it has finished/ended.
 * If the stream will emit close (autoDestroy && emitClose), wait for it.
 * Otherwise resolve immediately (matching Node.js pipeline behavior where
 * autoDestroy:false streams don't wait for close).
 */
function waitForClose(
  stream: StreamStateProbe,
  done: (err?: Error) => void,
  registry: {
    once: (emitter: EventEmitterLike, event: string, listener: (...args: any[]) => void) => void;
  }
): void {
  // Already closed — resolve immediately.
  if (stream.closed || stream._closed) {
    done();
    return;
  }
  const hasInternals = "_emitClose" in stream && "_autoDestroy" in stream;
  const willEmitClose =
    hasInternals && stream._emitClose !== false && stream._autoDestroy !== false;
  if (willEmitClose) {
    registry.once(stream, "close", () => done());
  } else {
    done();
  }
}

export function toBrowserPipelineStream(stream: PipelineStageLike): PipelineStageLike {
  if (
    stream instanceof Readable ||
    stream instanceof Writable ||
    stream instanceof Transform ||
    stream instanceof Duplex
  ) {
    return stream;
  }

  if (isTransformStream(stream)) {
    return Transform.fromWeb(stream);
  }
  if (isReadableStream(stream)) {
    return Readable.fromWeb(stream);
  }
  if (isWritableStream(stream)) {
    return Writable.fromWeb(stream);
  }

  // A bare (async) iterable source — `pipeline([chunk], dest)`. Node's pipeline
  // accepts one; without this the browser threw `current.pipe is not a
  // function`. Generator STAGES are handled separately (they are functions, and
  // consume the previous stage rather than being a source).
  if (typeof stream !== "function" && isIterableSource(stream)) {
    return Readable.from(stream as AsyncIterable<unknown>);
  }

  return stream;
}

/** `true` for an (async) iterable that is not already one of our streams. */
function isIterableSource(value: unknown): boolean {
  if (value == null || (typeof value !== "object" && typeof value !== "string")) {
    return false;
  }
  const probe = value as {
    [Symbol.asyncIterator]?: unknown;
    [Symbol.iterator]?: unknown;
    pipe?: unknown;
  };
  if (typeof probe.pipe === "function") {
    return false;
  }
  return (
    typeof probe[Symbol.asyncIterator] === "function" ||
    typeof probe[Symbol.iterator] === "function"
  );
}

/** A generator/async-generator transform stage. */
type GeneratorStage = PipelineGeneratorStage;

/**
 * Check if a pipeline stage is a generator/async generator function.
 * These are used as transform stages: fn(source) => AsyncIterable.
 */
function isGeneratorFunction(fn: unknown): fn is GeneratorStage {
  return typeof fn === "function" && !(fn instanceof Readable) && !(fn instanceof Writable);
}

/**
 * Apply a generator function as a transform stage.
 * Consumes the source stream via its async iterator, passes it through the
 * generator function, and produces a new Readable from the resulting iterable.
 */
function applyGeneratorStage(
  source: AsyncIterable<unknown>,
  fn: GeneratorStage
): Readable<unknown> {
  const iterable = fn(source);
  return Readable.from(iterable as AsyncIterable<unknown>);
}

/**
 * Pipeline streams together with proper error handling and cleanup.
 * Supports both callback and promise-based usage like Node.js.
 *
 * @example
 * // Promise usage
 * await pipeline(source, transform, destination);
 *
 * @example
 * // With options
 * await pipeline(source, transform, destination, { signal: controller.signal });
 *
 * @example
 * // Callback usage
 * pipeline(source, transform, destination, (err) => {
 *   if (err) console.error('Pipeline failed', err);
 * });
 */
export function pipeline(
  ...args: [...PipelineStageLike[], PipelineOptions | PipelineCallback] | PipelineStageLike[]
): Promise<void> {
  // Parse arguments
  let streams: PipelineStageLike[];
  let options: PipelineOptions = {};
  let callback: PipelineCallback | undefined;

  const lastArg = args[args.length - 1];

  if (typeof lastArg === "function") {
    callback = lastArg as PipelineCallback;
    // Check for combined style: pipeline(s1, s2, ..., options, callback)
    const secondToLast = args[args.length - 2];
    if (isPipelineOptions(secondToLast)) {
      options = secondToLast as PipelineOptions;
      streams = args.slice(0, -2) as PipelineStageLike[];
    } else {
      // Callback only: pipeline(s1, s2, ..., callback)
      streams = args.slice(0, -1) as PipelineStageLike[];
    }
  } else if (isPipelineOptions(lastArg)) {
    // Options only: pipeline(s1, s2, ..., { signal })
    options = lastArg as PipelineOptions;
    streams = args.slice(0, -1) as PipelineStageLike[];
  } else {
    // No callback or options: pipeline(s1, s2, s3)
    streams = args as PipelineStageLike[];
  }

  const promise = new Promise<void>((resolve, reject) => {
    if (streams.length < 2) {
      const err = new Error("Pipeline requires at least 2 streams");
      reject(err);
      return;
    }

    // Pre-process: normalize streams and resolve generator functions.
    // Generator functions consume their source as an async iterable and produce
    // a new Readable — they do NOT participate in .pipe() chains.
    // We build a flat list of pipe-able stream stages.
    const rawStages = streams.map(toBrowserPipelineStream);

    // allStreams: every stream created (for cleanup on error).
    // pipeStages: only the streams that need .pipe() chaining.
    const allStreams: StreamStateProbe[] = [];
    const pipeStages: StreamStateProbe[] = [];

    let current: StreamStateProbe = asProbe(rawStages[0]);
    allStreams.push(current);
    pipeStages.push(current);

    for (let i = 1; i < rawStages.length; i++) {
      const stage = rawStages[i];
      if (isGeneratorFunction(stage)) {
        // Generator consumes `current` internally → produces a new Readable.
        // This Readable replaces `current` as the source for subsequent stages.
        current = asProbe(applyGeneratorStage(current as AsyncIterable<unknown>, stage));
        allStreams.push(current);
        // Replace the last entry in pipeStages (the consumed source) with
        // the generator-produced Readable, so the next real stream stage
        // will be piped FROM this Readable.
        pipeStages[pipeStages.length - 1] = current;
      } else {
        const probe = asProbe(stage);
        allStreams.push(probe);
        pipeStages.push(probe);
        current = probe;
      }
    }

    const source = pipeStages[0];
    const destination = pipeStages[pipeStages.length - 1];
    const transforms = pipeStages.slice(1, -1);

    // Check for already-destroyed streams upfront.
    // If a stream is already destroyed and its close event has already fired,
    // our close listener would never fire — causing the pipeline to hang.
    // Node.js detects this and immediately rejects with ERR_STREAM_PREMATURE_CLOSE.
    for (const stream of allStreams) {
      if (stream.destroyed) {
        if (!isStreamCompleted(stream)) {
          reject(createPrematureCloseError());
          return;
        }
      }
    }

    let completed = false;

    const registry = createListenerRegistry();

    let onAbort: (() => void) | undefined;
    const cleanupWithSignal = (error?: Error): void => {
      if (completed) {
        return;
      }
      completed = true;

      if (onAbort && options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }

      // Node.js only destroys streams on ERROR, NOT on success.
      // On error, pass the error to destroy(); on success, leave streams intact.
      if (error) {
        const noop = (): void => {};
        for (const stream of allStreams) {
          if (typeof stream.on === "function") {
            stream.on("error", noop);
          }
          if (typeof stream.destroy === "function" && !stream.destroyed) {
            stream.destroy(error);
          }
        }
      }

      registry.cleanup();

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    // Handle abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        cleanupWithSignal(createAbortError(options.signal.reason));
        return;
      }
      onAbort = () => cleanupWithSignal(createAbortError(options.signal!.reason));
      options.signal.addEventListener("abort", onAbort);
    }

    // Chain the streams
    current = source;
    for (const transform of transforms) {
      current.pipe!(transform);
      current = transform;
    }

    // Pipe to destination
    if (options.end !== false) {
      current.pipe!(destination);
    } else {
      // Don't end destination
      let paused = false;
      let waitingForDrain = false;
      const onDrain = (): void => {
        waitingForDrain = false;
        if (paused && typeof current.resume === "function") {
          paused = false;
          current.resume();
        }
      };

      const onData = (chunk: unknown): void => {
        const ok = destination.write!(chunk);
        if (!ok && !waitingForDrain) {
          waitingForDrain = true;
          if (!paused && typeof current.pause === "function") {
            paused = true;
            current.pause();
          }
          registry.once(destination, "drain", onDrain);
        }
      };

      registry.add(current, "data", onData);
      // end:false — wait for source to fully close (not just 'end').
      // Node.js pipeline uses finished(source, {writable:false}) internally,
      // which waits until the 'close' event when the stream will emit close.
      registry.once(current, "end", () => {
        // Source ended — now wait for its close event (autoDestroy → close)
        // before resolving the pipeline. If the stream has already closed
        // (or won't emit close), resolve immediately.
        waitForClose(current, cleanupWithSignal, registry);
      });
    }

    // Handle completion — wait for destination to fully close, not just finish.
    // Node.js pipeline internally uses finished(destination) which waits for
    // 'close' after 'finish' when the stream will emit close (autoDestroy &&
    // emitClose). For streams that won't emit close (autoDestroy: false),
    // resolve on 'finish' alone (matching Node.js behavior).
    if (options.end !== false) {
      registry.once(destination, "finish", () => {
        waitForClose(destination, cleanupWithSignal, registry);
      });
    }

    // Node parity: close before completion is a premature close error.
    for (const stream of allStreams) {
      registry.once(stream, "close", () => {
        if (completed) {
          return;
        }
        if (!isStreamCompleted(stream)) {
          cleanupWithSignal(createPrematureCloseError());
        }
      });
    }

    // Handle errors on all streams
    for (const stream of allStreams) {
      registry.once(stream, "error", (err: Error) => cleanupWithSignal(err));
    }
  });

  // If callback provided, use it
  if (callback) {
    promise.then(() => callback!()).catch(err => callback!(err));
  }

  return promise;
}

// =============================================================================
// Finished
// =============================================================================

/**
 * Wait for a stream to finish, close, or error.
 * Node.js compatible with support for options and callbacks.
 *
 * @example
 * // Promise usage
 * await finished(stream);
 *
 * @example
 * // With options
 * await finished(stream, { readable: false }); // Only wait for writable side
 *
 * @example
 * // Callback usage
 * finished(stream, (err) => {
 *   if (err) console.error('Stream error', err);
 * });
 */
export function finished(
  stream: PipelineStreamLike,
  optionsOrCallback?: FinishedOptions | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void
): Promise<void> {
  let options: FinishedOptions = {};
  let cb: ((err?: Error | null) => void) | undefined;

  if (typeof optionsOrCallback === "function") {
    cb = optionsOrCallback;
  } else {
    options = optionsOrCallback ?? {};
    cb = callback;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const normalizedStream = toBrowserPipelineStream(stream);
    let resolved = false;

    const registry = createListenerRegistry();
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => {
      registry.cleanup();
      if (onAbort && options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const done = (err?: Error | null): void => {
      if (resolved) {
        return;
      }
      resolved = true;

      cleanup();

      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    // Handle abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        done(createAbortError(options.signal.reason));
        return;
      }
      onAbort = () => done(createAbortError(options.signal!.reason));
      options.signal.addEventListener("abort", onAbort);
    }

    // Node.js: if the stream is already destroyed, resolve/reject immediately.
    // An already-destroyed stream with an error rejects; otherwise it's premature close.
    const s = asProbe(normalizedStream);
    if (s.destroyed || s._destroyed) {
      if (s.errored || s._errored) {
        done(s.errored ?? s._errored);
      } else {
        // Already destroyed without error — check if it finished gracefully.
        // Respect options.readable / options.writable to match Node.js behavior:
        // if the caller only cares about one side, only check that side.
        const supportsReadable =
          "readableEnded" in s || "readable" in s || typeof s.read === "function";
        const supportsWritable =
          "writableFinished" in s || "writable" in s || typeof s.write === "function";
        const checkReadable = options.readable !== false && supportsReadable;
        const checkWritable = options.writable !== false && supportsWritable;
        const readableOk = !checkReadable || !!(s.readableEnded || s._endEmitted);
        const writableOk = !checkWritable || !!(s.writableFinished || s._finished);
        if (readableOk && writableOk) {
          done();
        } else {
          done(createPrematureCloseError());
        }
      }
      return;
    }

    const probe = asProbe(normalizedStream);
    const supportsReadable =
      "readableEnded" in probe || "readable" in probe || typeof probe.read === "function";
    const supportsWritable =
      "writableFinished" in probe || "writable" in probe || typeof probe.write === "function";

    const checkReadable = options.readable !== false && supportsReadable;
    const checkWritable = options.writable !== false && supportsWritable;

    let readableDone = !checkReadable || !!probe.readableEnded;
    let writableDone = !checkWritable || !!probe.writableFinished;

    // Node.js finished() waits for the 'close' event before resolving when
    // the stream will actually emit 'close'.  Node.js computes willEmitClose as:
    //   state.autoDestroy && state.emitClose && state.closed === false
    // This means: if autoDestroy is false, close won't fire automatically after
    // finish, so finished() must NOT wait for it — otherwise it deadlocks.
    //
    // Guard: only consult _emitClose / _autoDestroy when the stream actually
    // exposes them (i.e. our own Readable/Writable/Transform/Duplex instances).
    // Third-party or duck-typed streams may lack these internals — for those we
    // default to NOT waiting for 'close', which avoids a deadlock.
    const s2 = probe;
    const hasInternals = "_emitClose" in s2 && "_autoDestroy" in s2;
    const willEmitClose =
      hasInternals && s2._emitClose !== false && s2._autoDestroy !== false && !s2._closed;

    const maybeDone = (): void => {
      if (readableDone && writableDone) {
        if (willEmitClose) {
          // Don't resolve yet — wait for 'close' event
          return;
        }
        done();
      }
    };

    // Already finished?
    if (readableDone && writableDone) {
      // If the stream is already closed (or won't emit close), resolve now
      if (!willEmitClose || probe.closed) {
        done();
        return;
      }
      // Otherwise wait for 'close'
    }

    // Listen for events
    if (checkWritable && !writableDone) {
      registry.once(probe, "finish", () => {
        writableDone = true;
        maybeDone();
      });
    }

    if (checkReadable && !readableDone) {
      registry.once(probe, "end", () => {
        readableDone = true;
        maybeDone();
      });
    }

    // Node.js: with error:false, don't listen for the 'error' event.
    // Errors are still detected via stream.errored in the close handler.
    if (options.error !== false) {
      registry.once(probe, "error", (err: Error) => done(err));
    }
    registry.once(probe, "close", () => {
      const closedReadableDone = readableDone || !!probe.readableEnded;
      const closedWritableDone = writableDone || !!probe.writableFinished;

      if (closedReadableDone && closedWritableDone) {
        readableDone = closedReadableDone;
        writableDone = closedWritableDone;
        // Even with error:false, check stream.errored — Node.js close handler
        // still passes errors detected via stream.errored to the callback.
        const streamErr = probe.errored ?? probe._errored;
        done(streamErr ?? undefined);
        return;
      }

      // Premature close — stream closed before finishing.
      // Check for stream error first (e.g. destroyed with error).
      const streamErr = probe.errored ?? probe._errored;
      if (streamErr) {
        done(streamErr);
        return;
      }

      const err = new Error("Premature close") as Error & { code?: string };
      err.code = "ERR_STREAM_PREMATURE_CLOSE";
      err.name = "Error [ERR_STREAM_PREMATURE_CLOSE]";
      done(err);
    });
  });

  // If callback provided, use it
  if (cb) {
    promise.then(() => cb!()).catch(err => cb!(err));
  }

  return promise;
}

/**
 * Wait for multiple streams to finish
 */
export const finishedAll = createFinishedAll(finished);
