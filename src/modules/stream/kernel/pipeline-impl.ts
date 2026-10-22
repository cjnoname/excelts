/**
 * Stream kernel - pipeline algorithm
 *
 * `pipelineImpl` is a port of Node.js `lib/internal/streams/pipeline.js`. Each
 * stage is connected to the stage before it as it is visited — Node stream to
 * Node stream with `pipe()`, anything else by pumping an async iterable — so
 * every edge exists exactly once regardless of which kinds of stage meet.
 * Web streams are written and read through their own reader / writer; nothing
 * is wrapped in a Node-style stream and unwrapped again. The stream classes
 * are passed in, since `classes.ts` reaches this module through `compose`.
 */

import { destroyer } from "@stream/kernel/destroy";
import {
  adoptThenables,
  forEachThenable,
  invalidDuplexBody,
  rejectedDuplexBody
} from "@stream/kernel/duplexify";
import { eos } from "@stream/kernel/end-of-stream";
import {
  aggregateTwoErrors,
  createAbortError,
  errInvalidArgType,
  errInvalidReturnValue,
  errMissingArgs,
  errStreamDestroyed,
  errStreamPrematureClose,
  errStreamUnableToPipe
} from "@stream/kernel/errors";
import type { PipelineKernel, StreamKernel } from "@stream/kernel/state";
import { nextTick } from "@stream/kernel/state";
import {
  isIterable,
  isNodeStream,
  isReadable,
  isReadableFinished,
  isReadableNodeStream,
  isReadableStream,
  isTransformStream,
  isWebStream
} from "@stream/kernel/stream-utils";

const noop = (): void => {};

type Callback = (err?: Error | null, value?: unknown) => void;

function streamDestroyer(
  stream: any,
  reading: boolean,
  writing: boolean
): { destroy: (err?: Error | null) => void; cleanup: () => void } {
  let finished = false;
  stream.on("close", () => {
    finished = true;
  });
  const cleanup = eos(stream, { readable: reading, writable: writing }, err => {
    finished = !err;
  });
  return {
    destroy(err) {
      if (finished) {
        return;
      }
      finished = true;
      destroyer(stream, err || errStreamDestroyed("pipe"));
    },
    cleanup
  };
}

/** Stops one connection; a returned promise is the cleanup the pipeline waits for. */
type Destroy = (err?: Error | null) => void | Promise<unknown>;

/**
 * Anything readable, as an async iterable. A Web stream is read through a
 * reader the pipeline owns: its `cancel` joins `destroys`, so an abort or a
 * failure elsewhere wakes a read that is waiting for data.
 */
function makeAsyncIterable(
  kernel: PipelineKernel,
  val: any,
  destroys: Destroy[]
): AsyncIterable<unknown> | Iterable<unknown> {
  if (isReadableStream(val)) {
    return readWebStream(val, destroys);
  }
  if (isIterable(val)) {
    return val;
  }
  if (isReadableNodeStream(val)) {
    return fromReadable(kernel, val);
  }
  throw errInvalidArgType("val", ["Readable", "Iterable", "AsyncIterable"], val);
}

/** Every chunk of a Web stream, as is — `undefined` and `null` included. */
function readWebStream(stream: ReadableStream, destroys: Destroy[]): AsyncIterable<unknown> {
  const reader = stream.getReader();
  let done = false;
  // One cancellation, however many paths ask for it: each gets the same task,
  // so whichever one the pipeline waits on is the one actually running.
  let cancelling: Promise<unknown> | undefined;
  const cancel = (err?: Error | null): Promise<unknown> | undefined => {
    if (!done && !cancelling) {
      cancelling = reader.cancel(err ?? undefined).catch(noop);
    }
    return cancelling;
  };
  destroys.push(cancel);
  return {
    async *[Symbol.asyncIterator]() {
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
        // Left early (the consumer failed): the source is no longer wanted.
        await cancel();
        reader.releaseLock();
      }
    }
  };
}

async function* fromReadable(
  kernel: Pick<PipelineKernel, "Readable">,
  val: any
): AsyncGenerator<unknown> {
  yield* kernel.Readable.prototype[Symbol.asyncIterator].call(val);
}

async function pumpToNode(
  iterable: AsyncIterable<unknown> | Iterable<unknown>,
  writable: any,
  finish: (err?: Error | null) => void,
  { end }: { end: boolean }
): Promise<void> {
  let error: Error | null | undefined;
  let onresolve: (() => void) | null = null;

  const resume = (err?: Error | null): void => {
    if (err) {
      error = err;
    }
    if (onresolve) {
      const callback = onresolve;
      onresolve = null;
      callback();
    }
  };

  const wait = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (error) {
        reject(error);
      } else {
        onresolve = () => (error ? reject(error) : resolve());
      }
    });

  writable.on("drain", resume);
  const cleanup = eos(writable, { readable: false }, resume);

  try {
    if (writable.writableNeedDrain) {
      await wait();
    }
    for await (const chunk of iterable) {
      if (!writable.write(chunk)) {
        await wait();
      }
    }
    if (end) {
      writable.end();
      await wait();
    }
    finish();
  } catch (err) {
    finish(error !== err ? aggregateTwoErrors(error, err as Error) : (err as Error));
  } finally {
    cleanup();
    writable.off("drain", resume);
  }
}

async function pumpToWeb(
  readable: AsyncIterable<unknown> | Iterable<unknown>,
  writable: WritableStream | TransformStream,
  finish: (err?: Error | null) => void,
  { end }: { end: boolean },
  destroys: Destroy[],
  onSinkError: (err: Error) => void
): Promise<void> {
  const target = isTransformStream(writable) ? writable.writable : writable;
  // This pump takes the writer, so it closes, aborts or releases it — always.
  const writer = target.getWriter();
  let settled = false;
  // The sink can fail while this pump waits for input (its other end was
  // cancelled, say); report it at once rather than at the next write.
  writer.closed.catch((err: Error) => {
    if (!settled) {
      onSinkError(err);
    }
  });
  // An abort or a failure elsewhere aborts the sink, which also releases a
  // write waiting on `writer.ready`.
  destroys.push(err => {
    if (!settled && err) {
      settled = true;
      return writer.abort(err).catch(() => {});
    }
    return undefined;
  });
  let lastWrite: Promise<void> = Promise.resolve();
  try {
    for await (const chunk of readable) {
      await writer.ready;
      lastWrite = writer.write(chunk);
      lastWrite.catch(() => {});
    }
    if (end) {
      await writer.close();
    } else {
      // Left open for the caller: everything written must have landed first.
      await lastWrite;
    }
    settled = true;
    finish();
  } catch (err) {
    if (settled) {
      finish(err as Error);
      return;
    }
    settled = true;
    try {
      await writer.abort(err);
      finish(err as Error);
    } catch (abortErr) {
      finish(abortErr as Error);
    }
  } finally {
    writer.releaseLock();
  }
}

function pipe(
  src: any,
  dst: any,
  finish: (err?: Error | null) => void,
  finishOnlyHandleError: (err?: Error | null) => void,
  { end }: { end: boolean }
): () => void {
  let ended = false;
  dst.on("close", () => {
    if (!ended) {
      // The destination closed under us.
      finishOnlyHandleError(errStreamPrematureClose());
    }
  });

  // end:false here — when ending, the 'end' listener below does it.
  src.pipe(dst, { end: false });

  if (end) {
    const endFn = (): void => {
      ended = true;
      dst.end();
    };
    if (isReadableFinished(src)) {
      nextTick(endFn);
    } else {
      src.once("end", endFn);
    }
  } else {
    finish();
  }

  eos(src, { readable: true, writable: false }, err => {
    const rState = src._readableState;
    if (
      err &&
      (err as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE" &&
      rState?.ended &&
      !rState.errored &&
      !rState.errorEmitted
    ) {
      // 'close' before 'end' on a stream that did end: wait for the 'end'.
      src.once("end", finish).once("error", finish);
    } else {
      finish(err);
    }
  });
  return eos(dst, { readable: false, writable: true }, finish);
}

/** Connect `streams` and call `callback` once, when all of them are done. */
export function pipelineImpl(
  kernel: PipelineKernel,
  streams: any[],
  callback: Callback,
  opts?: { signal?: AbortSignal; end?: boolean }
): any {
  if (streams.length === 1 && Array.isArray(streams[0])) {
    streams = streams[0];
  }
  if (streams.length < 2) {
    throw errMissingArgs("streams");
  }

  // Phase 1 — check and classify, before anything is connected: every stage
  // the connection loop cannot use as is becomes a Duplex, and a stage that
  // can never work (locked, destroyed, not a stream) fails here.
  assertDistinctStages(streams);
  streams = classifyStages(kernel, streams);

  const { PassThrough } = kernel;
  const ac = new AbortController();
  const signal = ac.signal;
  const outerSignal = opts?.signal;
  const lastStreamCleanup: Array<() => void> = [];

  const abort = (): void => {
    finishImpl(createAbortError(outerSignal?.reason));
  };
  outerSignal?.addEventListener("abort", abort, { once: true });

  let error: Error | null | undefined;
  let value: unknown;
  const destroys: Destroy[] = [];
  // Cleanup still in flight (a source's cancel, a sink's abort); settling waits for it.
  const cleanups: Array<Promise<unknown>> = [];
  let finishCount = 0;
  let called = false;

  function finish(err?: Error | null): void {
    finishImpl(err, --finishCount === 0);
  }

  function finishOnlyHandleError(err?: Error | null): void {
    finishImpl(err, false);
  }

  function finishImpl(err?: Error | null, final?: boolean): void {
    if (
      err &&
      (!error ||
        (error as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE" ||
        error.name === "AbortError")
    ) {
      error = err;
    }
    if (!error && !final) {
      return;
    }
    while (destroys.length) {
      const cleanup = destroys.shift()!(error);
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
    outerSignal?.removeEventListener("abort", abort);
    ac.abort();

    if (final && !called) {
      called = true;
      if (!error) {
        for (const fn of lastStreamCleanup) {
          fn();
        }
      }
      const e = error;
      Promise.allSettled(cleanups).then(() => nextTick(() => callback(e, value)));
    }
  }

  // Phase 2 — connect. Each connection registers how to stop it in `destroys`.
  // A stage that only proves invalid now (a generator's return value) tears
  // down everything the pipeline was given, connected or not, and is reported
  // through the callback like any other failure — once that teardown is done.
  let ret: any;
  try {
    ret = connect();
  } catch (err) {
    for (const stage of streams) {
      const cleanup = releaseStage(stage, err as Error);
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
    finishImpl(err as Error, true);
    return undefined;
  }

  if (signal.aborted || outerSignal?.aborted) {
    nextTick(abort);
  }

  // Phase 3 — settle: `finish` runs once per connection, and the callback once.
  return ret;

  function connect(): any {
    let ret: any;
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      const reading = i < streams.length - 1;
      const writing = i > 0;
      const end = reading || opts?.end !== false;
      const isLastStream = i === streams.length - 1;

      if (isNodeStream(stream)) {
        if (end) {
          const { destroy, cleanup } = streamDestroyer(stream, reading, writing);
          destroys.push(destroy);
          if (isReadable(stream) && isLastStream) {
            lastStreamCleanup.push(cleanup);
          }
        }

        const onError = (err: Error): void => {
          if (
            err &&
            err.name !== "AbortError" &&
            (err as { code?: string }).code !== "ERR_STREAM_PREMATURE_CLOSE"
          ) {
            finishOnlyHandleError(err);
          }
        };
        stream.on("error", onError);
        if (isReadable(stream) && isLastStream) {
          lastStreamCleanup.push(() => stream.removeListener("error", onError));
        }
      }

      if (i === 0) {
        if (typeof stream === "function") {
          ret = stream({ signal });
          if (!isIterable(ret)) {
            throw errInvalidReturnValue("Iterable, AsyncIterable or Stream", "source", ret);
          }
        } else if (
          isIterable(stream) ||
          isReadableNodeStream(stream) ||
          isTransformStream(stream) ||
          isReadableStream(stream)
        ) {
          ret = stream;
        } else {
          ret = kernel.Duplex.from(stream);
        }
      } else if (typeof stream === "function") {
        ret = makeAsyncIterable(kernel, isTransformStream(ret) ? ret.readable : ret, destroys);
        ret = stream(ret, { signal });

        if (reading) {
          if (!isIterable(ret, true)) {
            throw errInvalidReturnValue("AsyncIterable", `transform[${i - 1}]`, ret);
          }
        } else {
          // The last stage is a sink function: expose its result as a stream.
          const pt = new PassThrough({ objectMode: true });

          const then = ret?.then;
          if (typeof then === "function") {
            finishCount++;
            then.call(
              ret,
              (val: unknown) => {
                value = val;
                if (val != null) {
                  pt.write(val);
                }
                if (end) {
                  pt.end();
                }
                nextTick(finish);
              },
              (err: Error) => {
                pt.destroy(err);
                nextTick(() => finish(err));
              }
            );
          } else if (isIterable(ret, true)) {
            finishCount++;
            pumpToNode(ret, pt, finish, { end });
          } else if (isReadableStream(ret) || isTransformStream(ret)) {
            finishCount++;
            pumpToNode(
              makeAsyncIterable(kernel, isTransformStream(ret) ? ret.readable : ret, destroys),
              pt,
              finish,
              {
                end
              }
            );
          } else {
            throw errInvalidReturnValue("AsyncIterable or Promise", "destination", ret);
          }

          ret = pt;
          const { destroy, cleanup } = streamDestroyer(ret, false, true);
          destroys.push(destroy);
          if (isLastStream) {
            lastStreamCleanup.push(cleanup);
          }
        }
      } else if (isNodeStream(stream)) {
        if (isReadableNodeStream(ret)) {
          finishCount += 2;
          const cleanup = pipe(ret, stream, finish, finishOnlyHandleError, { end });
          if (isReadable(stream) && isLastStream) {
            lastStreamCleanup.push(cleanup);
          }
        } else if (isTransformStream(ret) || isReadableStream(ret)) {
          finishCount++;
          pumpToNode(
            makeAsyncIterable(kernel, isTransformStream(ret) ? ret.readable : ret, destroys),
            stream,
            finish,
            {
              end
            }
          );
        } else if (isIterable(ret)) {
          finishCount++;
          pumpToNode(ret, stream, finish, { end });
        } else {
          throw errInvalidArgType(
            "val",
            ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
            ret
          );
        }
        ret = stream;
      } else if (isWebStream(stream)) {
        if (isReadableNodeStream(ret) || isReadableStream(ret) || isIterable(ret)) {
          finishCount++;
          pumpToWeb(
            makeAsyncIterable(kernel, ret, destroys),
            stream,
            finish,
            { end },
            destroys,
            finishOnlyHandleError
          );
        } else if (isTransformStream(ret)) {
          finishCount++;
          pumpToWeb(
            makeAsyncIterable(kernel, ret.readable, destroys),
            stream,
            finish,
            { end },
            destroys,
            finishOnlyHandleError
          );
        } else {
          throw errInvalidArgType(
            "val",
            ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
            ret
          );
        }
        ret = stream;
      }
    }
    return ret;
  }
}

/**
 * Phase 1 for the whole list: a stream object may appear once. Used twice it
 * would be piped into itself, or have a second lock taken on it mid-connect.
 */
export function assertDistinctStages(stages: unknown[]): void {
  const objects = stages.filter(stage => typeof stage === "object" && stage !== null);
  if (new Set(objects).size !== objects.length) {
    throw new TypeError("pipeline: the same stream appears more than once");
  }
}

/**
 * Phase 1: every stage as the connection loop will use it. All stages are
 * checked before any is converted, and checking has no side effects: a stage
 * that fails leaves every stage untouched and nothing created. Converting
 * first would have started work — a promise subscribed to, a Web pair's locks
 * taken — that nobody owns once a later stage is rejected.
 */
export function classifyStages(kernel: Pick<StreamKernel, "Duplex">, stages: any[]): any[] {
  try {
    stages.forEach(checkStage);
  } catch (err) {
    // The pipeline reports the failure itself. A promise among the stages —
    // or inside a `{ readable, writable }` one — is the one thing whose own
    // failure would surface anyway, as an unhandled rejection, so it is
    // handled here. Nothing else is touched. (Node's pipeline leaves a nested
    // one unhandled.)
    for (const stage of stages) {
      forEachThenable(stage, thenable => {
        thenable.then(undefined, noop);
      });
    }
    throw err;
  }
  return stages.map((stage, index) => toPipelineStage(kernel, stage, index));
}

function checkStage(stage: any, index: number): void {
  if (typeof stage === "function") {
    return;
  }
  if (isNodeStream(stage)) {
    if (index > 0 && (stage.closed || stage.destroyed)) {
      throw errStreamUnableToPipe();
    }
    return;
  }
  if (isWebStream(stage)) {
    const locked = isTransformStream(stage)
      ? stage.readable.locked || stage.writable.locked
      : (stage as ReadableStream | WritableStream).locked;
    if (locked) {
      throw new TypeError("pipeline: a stream is locked, so it cannot be piped");
    }
    return;
  }
  if (index === 0 && isIterable(stage)) {
    return;
  }
  const rejected = rejectedDuplexBody(stage);
  if (rejected) {
    throw invalidDuplexBody(rejected.value);
  }
}

function toPipelineStage(kernel: Pick<StreamKernel, "Duplex">, stage: any, index: number): any {
  if (
    typeof stage === "function" ||
    isNodeStream(stage) ||
    isWebStream(stage) ||
    (index === 0 && isIterable(stage))
  ) {
    return stage;
  }
  return kernel.Duplex.from(adoptThenables(stage));
}

/**
 * Release a stage the pipeline was given but never connected, and say when
 * that is done: the pipeline settles only after it. Its error is reported
 * through the pipeline, so the stage's own 'error' event must not surface as
 * an unhandled one.
 */
function releaseStage(stage: any, err: Error): Promise<unknown> | undefined {
  if (isNodeStream(stage)) {
    stage.on("error", noop);
    if (typeof stage.destroy === "function" && (stage._readableState || stage._writableState)) {
      // A Node-style stream reports the end of its own `_destroy`, and calls
      // back at once if it is already destroyed.
      return new Promise<void>(resolve => {
        stage.destroy(err, () => resolve());
      });
    }
    destroyer(stage, err);
    return undefined;
  }
  if (isTransformStream(stage)) {
    return Promise.allSettled([
      releaseStage(stage.readable, err),
      releaseStage(stage.writable, err)
    ]);
  }
  if (isReadableStream(stage)) {
    return stage.locked ? undefined : stage.cancel(err).catch(noop);
  }
  if (isWebStream(stage) && !(stage as WritableStream).locked) {
    return (stage as WritableStream).abort(err).catch(noop);
  }
  return undefined;
}
