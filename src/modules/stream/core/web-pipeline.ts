/**
 * An all-Web pipeline, run by the platform.
 *
 * When every stage is a Web stream, both entry points hand the pipeline to the
 * platform's own `pipeThrough` / `pipeTo` instead of pumping chunks in
 * JavaScript. That carries backpressure, cancellation and abort natively — and
 * on Node it also avoids `stream.pipeline`, which never settles when such a
 * pipeline is aborted while its source is waiting for data.
 */

import type { PipelineOptions } from "@stream/core/options";
import { isReadableStream, isTransformStream, isWritableStream } from "@stream/kernel/stream-utils";
import { createAbortError } from "@utils/errors";

/** `ReadableStream → TransformStream* → WritableStream`: nothing but Web streams. */
export function isWebOnlyPipeline(streams: unknown[]): boolean {
  if (!isReadableStream(streams[0]) || !isWritableStream(streams[streams.length - 1])) {
    return false;
  }
  for (let i = 1; i < streams.length - 1; i++) {
    if (!isTransformStream(streams[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Run an all-Web pipeline with the platform's own `pipeTo`.
 *
 * The data moves natively, but the pipeline is managed here: every stage is
 * checked for a lock before anything starts, each connection is its own
 * `pipeTo`, and the promise settles only once every connection has finished
 * tearing down — with the first error that occurred.
 *
 * A failure travels along the chain by the Streams spec's own propagation
 * (error forwards, cancel backwards); only the caller's abort uses a signal.
 * Aborting the other connections on the first failure as well looks tidier
 * but races that propagation: Node's `pipeTo` then skips cancelling the
 * source once there are two or more transforms.
 */
export async function pipeWebStreams(
  streams: unknown[],
  options: PipelineOptions | undefined
): Promise<void> {
  const source = streams[0] as ReadableStream;
  const transforms = streams.slice(1, -1) as TransformStream[];
  const destination = streams[streams.length - 1] as WritableStream;

  if (
    source.locked ||
    destination.locked ||
    transforms.some(t => t.readable.locked || t.writable.locked)
  ) {
    throw new TypeError("pipeline: a stream is locked, so it cannot be piped");
  }
  // Every port must be distinct: a stage used twice would be connected twice,
  // the second connection would fail to take its lock and never be made, and
  // the rest would wait forever for an error that has no path to them.
  const ports = [source, destination, ...transforms.flatMap(t => [t.readable, t.writable])];
  if (new Set(ports).size !== ports.length) {
    throw new TypeError("pipeline: the same stream appears more than once");
  }

  // The caller's abort, reported as the AbortError the rest of the module uses.
  let signal: AbortSignal | undefined;
  let detach = (): void => {};
  const outer = options?.signal;
  if (outer) {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(createAbortError(outer.reason));
    if (outer.aborted) {
      onAbort();
    } else {
      outer.addEventListener("abort", onAbort, { once: true });
      detach = () => outer.removeEventListener("abort", onAbort);
    }
    signal = controller.signal;
  }

  const connections: Array<Promise<void>> = [];
  let upstream = source;
  for (const transform of transforms) {
    connections.push(upstream.pipeTo(transform.writable, { signal }));
    upstream = transform.readable;
  }
  connections.push(upstream.pipeTo(destination, { signal, preventClose: options?.end === false }));

  // Wait for every connection to settle, then report the failure seen first.
  let failed = false;
  let firstError: unknown;
  await Promise.all(
    connections.map(connection =>
      connection.catch((err: unknown) => {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      })
    )
  );
  detach();
  if (failed) {
    throw firstError;
  }
}
