/**
 * Browser Stream - pipeline() and finished()
 *
 * The module's calling convention (always a promise, optional trailing
 * callback, `{ signal, end }` options) over `pipelineImpl` and `eos`.
 */

import { createFinishedAll } from "@stream/core/finished-all";
import type { FinishedOptions, PipelineCallback, PipelineOptions } from "@stream/core/options";
import { createPipeline } from "@stream/core/pipeline-api";
import { isWebOnlyPipeline, pipeWebStreams } from "@stream/core/web-pipeline";
import { kernel } from "@stream/kernel/classes";
import { eos } from "@stream/kernel/end-of-stream";
import { pipelineImpl } from "@stream/kernel/pipeline-impl";
import { isNodeStream } from "@stream/kernel/stream-utils";
import type { PipelineStageLike, PipelineStreamLike } from "@stream/types";

export type { PipelineOptions, FinishedOptions } from "@stream/core/options";
export { isPipelineOptions } from "@stream/core/options";

/**
 * Pipe `streams` together and settle when all of them are done, destroying
 * every stage on the first error.
 *
 * Accepts Node-style streams, Web streams, (async) iterables as a source and
 * generator functions as stages. A pipeline of Web streams only runs on the
 * platform's `pipeTo`.
 */
const runPipeline = createPipeline((stages, options) =>
  isWebOnlyPipeline(stages)
    ? pipeWebStreams(stages, options)
    : new Promise<void>((resolve, reject) => {
        pipelineImpl(kernel, stages, err => (err ? reject(err) : resolve()), options);
      })
);

export function pipeline(
  ...args: [...PipelineStageLike[], PipelineOptions | PipelineCallback] | PipelineStageLike[]
): Promise<void> {
  return runPipeline(...args);
}

/**
 * Settle when `stream` has finished, errored or closed early.
 *
 * Web streams are adapted first; that takes their lock, as reading them does.
 */
export function finished(
  stream: PipelineStreamLike,
  optionsOrCallback?: FinishedOptions | PipelineCallback,
  callback?: PipelineCallback
): Promise<void> {
  let options: FinishedOptions | undefined;
  let cb: PipelineCallback | undefined;
  if (typeof optionsOrCallback === "function") {
    cb = optionsOrCallback;
  } else {
    options = optionsOrCallback;
    cb = callback;
  }

  const promise = isNodeStream(stream)
    ? new Promise<void>((resolve, reject) => {
        eos(stream, options ?? null, err => (err ? reject(err) : resolve()));
      })
    : webFinished();

  if (cb) {
    const done = cb;
    promise.then(
      () => done(),
      err => done(err)
    );
  }
  return promise;
}

/**
 * `finished()` on a Web stream is refused in the browser.
 *
 * The standard API has no way to observe a Web stream's completion without
 * locking it, and nothing short of the reader or writer that drains it knows
 * when its queue is empty — the Node-style side having ended does not mean
 * the Web side has. Adapting the stream would take its lock and leave the
 * caller unable to consume or close what it is waiting on.
 */
function webFinished(): Promise<void> {
  return Promise.reject(
    new TypeError(
      "finished(): a Web stream's completion cannot be observed in the browser without " +
        "locking it. Await the `closed` promise of the reader or writer you use instead."
    )
  );
}

export const finishedAll = createFinishedAll(finished);
