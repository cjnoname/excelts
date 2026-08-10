/**
 * Shared output pipeline for ZIP streaming operations.
 *
 * Both `ZipArchive` and `ZipEditor` use an identical scaffolding pattern for
 * their `operation()` method: signal/abort wiring, ProgressEmitter, async queue,
 * StreamingZip callback, error handling, and return object construction.
 * This module extracts that shared boilerplate into a single reusable function.
 */

import { createAsyncQueue } from "@archive/core/async-queue";
import { createLinkedAbortController, createAbortError, toError } from "@archive/core/errors";
import { ProgressEmitter } from "@archive/core/progress";
import type { ZipStringCodec, ZipStringEncoding } from "@archive/core/text";
import type { Zip64Mode } from "@archive/zip-spec/zip-records";
import type { ZipOperation, ZipProgress, ZipStreamOptions } from "@archive/zip/progress";
import { StreamingZip } from "@archive/zip/stream";

// =============================================================================
// Types
// =============================================================================

/** Resolved signal/progress options passed to the pipeline. */
export interface ZipPipelineOptions {
  signal?: AbortSignal;
  onProgress?: ZipStreamOptions["onProgress"];
  progressIntervalMs?: number;
}

/** Options for constructing the internal StreamingZip instance. */
export interface ZipPipelineZipOptions {
  comment?: string;
  zip64?: Zip64Mode;
  encoding?: ZipStringEncoding;
  codec?: ZipStringCodec;
}

/**
 * Callback that processes entries within the pipeline.
 *
 * The pipeline sets up all scaffolding (abort, progress, queue, StreamingZip)
 * and then calls this function to do the actual per-entry work. The callback
 * receives:
 *
 * - `zip`      — the StreamingZip instance to add files to
 * - `signal`   — the linked AbortSignal
 * - `progress` — the ProgressEmitter to update
 *
 * The callback MUST call `zip.end()` when all entries have been added.
 * It SHOULD call `throwIfAborted(signal)` between entries.
 */
export type ZipPipelineProcessFn = (ctx: {
  zip: StreamingZip;
  signal: AbortSignal;
  progress: ProgressEmitter<ZipProgress>;
}) => Promise<void>;

// =============================================================================
// Pipeline
// =============================================================================

/**
 * Create a streaming ZIP operation with all shared boilerplate wired up.
 *
 * @param entriesTotal - Total number of entries (for progress reporting)
 * @param zipOptions   - Options for the StreamingZip instance
 * @param pipelineOpts - Signal, progress callback, and interval
 * @param processFn    - Callback that adds entries to the StreamingZip
 * @returns A `ZipOperation` handle
 */
export function createZipOperation(
  entriesTotal: number,
  zipOptions: ZipPipelineZipOptions,
  pipelineOpts: ZipPipelineOptions,
  processFn: ZipPipelineProcessFn
): ZipOperation {
  const { controller, cleanup: cleanupAbortLink } = createLinkedAbortController(
    pipelineOpts.signal
  );
  const signal = controller.signal;

  const progress = new ProgressEmitter<ZipProgress>(
    {
      type: "zip",
      phase: "running",
      entriesTotal,
      entriesDone: 0,
      bytesIn: 0,
      bytesOut: 0,
      zip64: zipOptions.zip64 ?? "auto"
    },
    pipelineOpts.onProgress,
    { intervalMs: pipelineOpts.progressIntervalMs }
  );

  const queue = createAsyncQueue<Uint8Array>({
    capacity: 1,
    cancelError: () => createAbortError("cancelled"),
    onCancel: () => {
      try {
        controller.abort("cancelled");
      } catch {
        // ignore
      }
    }
  });

  let outputTail = Promise.resolve();

  const zip = new StreamingZip(
    (err, data, final) => {
      if (err) {
        progress.update({ phase: progress.snapshot.phase === "aborted" ? "aborted" : "error" });
        queue.fail(err);
        return;
      }

      if (data.length) {
        progress.mutate(s => {
          s.bytesOut += data.length;
        });
        outputTail = outputTail.then(() => queue.push(data));
        void outputTail.catch(() => undefined);
      }

      if (final) {
        outputTail = outputTail.then(() => {
          if (progress.snapshot.phase === "running") {
            progress.update({ phase: "done" });
          }
          queue.close();
        });
        void outputTail.catch(() => undefined);
      }
      return outputTail;
    },
    {
      comment: zipOptions.comment,
      zip64: zipOptions.zip64,
      encoding: zipOptions.encoding,
      codec: zipOptions.codec
    }
  );

  const onAbort = () => {
    const err = createAbortError(signal.reason);
    progress.update({ phase: "aborted" });
    try {
      zip.abort(err);
    } catch {
      // ignore
    }
    queue.fail(err);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  (async () => {
    try {
      await processFn({ zip, signal, progress });
      await outputTail;
    } catch (e) {
      const err = toError(e);
      if (signal.aborted || err.name === "AbortError") {
        progress.update({ phase: "aborted" });
        try {
          zip.abort(err);
        } catch {
          // ignore
        }
      } else {
        progress.update({ phase: "error" });
      }
      queue.fail(err);
    } finally {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
      cleanupAbortLink();
      progress.emitNow();
    }
  })();

  return {
    iterable: queue.iterable,
    signal,
    abort(reason?: unknown) {
      controller.abort(reason);
    },
    pointer() {
      return progress.snapshot.bytesOut;
    },
    progress() {
      return progress.snapshotCopy();
    }
  };
}
