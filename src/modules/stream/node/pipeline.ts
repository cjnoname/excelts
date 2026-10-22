/**
 * Node.js Stream - pipeline() and finished()
 *
 * The module's calling convention over `node:stream`; see `pipeline` for which
 * implementation runs which kind of pipeline.
 */

import { Duplex, PassThrough, Readable, Writable, finished as nodeFinished } from "stream";
import { pipeline as nodePipeline } from "stream/promises";

import { createFinishedAll } from "@stream/core/finished-all";
import type { FinishedOptions, PipelineCallback, PipelineOptions } from "@stream/core/options";
import { createPipeline } from "@stream/core/pipeline-api";
import { isWebOnlyPipeline, pipeWebStreams } from "@stream/core/web-pipeline";
import { assertDistinctStages, classifyStages, pipelineImpl } from "@stream/kernel/pipeline-impl";
import type { StreamKernel } from "@stream/kernel/state";
import { isWebStream } from "@stream/kernel/stream-utils";
import type { PipelineStageLike, PipelineStreamLike } from "@stream/types";

export type { PipelineOptions, FinishedOptions } from "@stream/core/options";
export { isPipelineOptions } from "@stream/core/options";

/** Node's own classes, for the module's pipeline on a mixed Node/Web pipeline. */
const nativeKernel: StreamKernel = { Readable, Writable, Duplex, PassThrough };

/**
 * Which implementation runs a pipeline:
 *
 * - Node streams, with an iterable source at most → Node's own
 *   `stream.pipeline`. Every stage is checked first, so nothing can fail after
 *   the first connections are made.
 * - only Web streams → the platform's `pipeTo`.
 * - anything else (a Web stream among Node ones, a generator stage) → the
 *   module's pipeline over Node's classes. Node's pumps a Web stream directly,
 *   so an abort never reaches a read waiting for data and a Web writable left
 *   open by `end: false` stays locked; and a generator whose return value is
 *   invalid is found only after earlier stages are connected, which Node's
 *   leaves running.
 */
const runPipeline = createPipeline((stages, options) => {
  if (isWebOnlyPipeline(stages)) {
    return pipeWebStreams(stages, options);
  }
  assertDistinctStages(stages);
  const checked = classifyStages(nativeKernel, stages);
  if (checked.some(stage => typeof stage === "function" || isWebStream(stage))) {
    return new Promise<void>((resolve, reject) => {
      pipelineImpl(nativeKernel, checked, err => (err ? reject(err) : resolve()), options);
    });
  }
  const run = nodePipeline as (...pipelineArgs: unknown[]) => Promise<unknown>;
  return (options ? run(...checked, options) : run(...checked)).then(() => undefined);
});

export function pipeline(
  ...args: [...PipelineStageLike[], PipelineOptions | PipelineCallback] | PipelineStageLike[]
): Promise<void> {
  return runPipeline(...args);
}

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

  const promise = new Promise<void>((resolve, reject) => {
    const run = nodeFinished as (
      target: unknown,
      opts: FinishedOptions,
      done: (err?: Error | null) => void
    ) => void;
    run(stream, options ?? {}, err => (err ? reject(err) : resolve()));
  });

  if (cb) {
    const done = cb;
    promise.then(
      () => done(),
      err => done(err)
    );
  }
  return promise;
}

export const finishedAll = createFinishedAll(finished);
