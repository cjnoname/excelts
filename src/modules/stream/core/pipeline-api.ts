/**
 * The module's `pipeline()` calling convention, shared by both entry points:
 * stages, then optional `{ signal, end }` options, then an optional callback;
 * a promise is returned either way. Each entry supplies how to run the stages.
 */

import type { PipelineCallback, PipelineOptions } from "@stream/core/options";
import { isPipelineOptions } from "@stream/core/options";
import type { PipelineStageLike } from "@stream/types";

type PipelineRunner = (stages: unknown[], options: PipelineOptions | undefined) => Promise<void>;

export function createPipeline(
  run: PipelineRunner
): (
  ...args: [...PipelineStageLike[], PipelineOptions | PipelineCallback] | PipelineStageLike[]
) => Promise<void> {
  return function pipeline(...args) {
    let stages = args as unknown[];
    let options: PipelineOptions | undefined;
    let callback: PipelineCallback | undefined;

    if (typeof stages[stages.length - 1] === "function") {
      // A trailing function is always the completion callback.
      callback = stages[stages.length - 1] as PipelineCallback;
      stages = stages.slice(0, -1);
    }
    if (isPipelineOptions(stages[stages.length - 1])) {
      options = stages[stages.length - 1] as PipelineOptions;
      stages = stages.slice(0, -1);
    }

    const promise =
      stages.length < 2
        ? Promise.reject(new Error("Pipeline requires at least 2 streams"))
        : new Promise<void>((resolve, reject) => {
            run(stages, options).then(resolve, reject);
          });

    if (callback) {
      const cb = callback;
      promise.then(
        () => cb(),
        err => cb(err)
      );
    }
    return promise;
  };
}
