/**
 * Stream kernel - compose algorithm
 *
 * `composeImpl` is a port of Node.js `lib/internal/streams/compose.js`: the
 * stages are connected with `pipelineImpl`, and one Duplex writes into the
 * head and reads from the tail. It backs `Readable.prototype.compose` and the
 * module's `compose()`; the stream classes are passed in by both.
 */

import { destroyer } from "@stream/kernel/destroy";
import { eos } from "@stream/kernel/end-of-stream";
import { createAbortError, errInvalidArgValue, errMissingArgs } from "@stream/kernel/errors";
import { pipelineImpl } from "@stream/kernel/pipeline-impl";
import type { PipelineKernel } from "@stream/kernel/state";
import {
  isNodeStream,
  isReadable,
  isReadableStream,
  isTransformStream,
  isWebStream,
  isWritable,
  isWritableStream
} from "@stream/kernel/stream-utils";

type Callback = (error?: Error | null) => void;

const noop = (): void => {};

export function composeImpl(kernel: PipelineKernel, ...streams: any[]): any {
  const { Duplex } = kernel;
  if (streams.length === 0) {
    throw errMissingArgs("streams");
  }
  if (streams.length === 1) {
    return Duplex.from(streams[0]);
  }

  const orgStreams = streams.slice();

  if (typeof streams[0] === "function") {
    streams[0] = Duplex.from(streams[0]);
  }
  if (typeof streams[streams.length - 1] === "function") {
    const idx = streams.length - 1;
    streams[idx] = Duplex.from(streams[idx]);
  }

  for (let n = 0; n < streams.length; ++n) {
    if (!isNodeStream(streams[n]) && !isWebStream(streams[n])) {
      continue;
    }
    if (
      n < streams.length - 1 &&
      !(isReadable(streams[n]) || isReadableStream(streams[n]) || isTransformStream(streams[n]))
    ) {
      throw errInvalidArgValue(`streams[${n}]`, orgStreams[n], "must be readable");
    }
    if (
      n > 0 &&
      !(isWritable(streams[n]) || isWritableStream(streams[n]) || isTransformStream(streams[n]))
    ) {
      throw errInvalidArgValue(`streams[${n}]`, orgStreams[n], "must be writable");
    }
  }

  let ondrain: Callback | null = null;
  let onfinish: Callback | null = null;
  // undefined: running; null: the pipeline settled; a function: destroy waiting on it.
  let onclose: Callback | null | undefined;

  function onfinished(err?: Error | null): void {
    const cb = onclose;
    onclose = null;
    if (cb) {
      cb(err);
    } else if (err) {
      d.destroy(err);
    } else if (!readable && !writable) {
      d.destroy();
    }
  }

  function finishWrite(): void {
    if (onfinish) {
      const cb = onfinish;
      onfinish = null;
      cb();
    }
  }

  const head = streams[0];
  const tail = pipelineImpl(kernel, streams, onfinished);

  const writable = !!(isWritable(head) || isWritableStream(head) || isTransformStream(head));
  const readable = !!(isReadable(tail) || isReadableStream(tail) || isTransformStream(tail));

  // The Web reader / writer compose takes for itself: released when done,
  // cancelled or aborted when the composed stream is destroyed early.
  let headWriter: WritableStreamDefaultWriter | undefined;
  let tailReader: ReadableStreamDefaultReader | undefined;

  function releaseHeadWriter(): void {
    if (headWriter) {
      headWriter.releaseLock();
      headWriter = undefined;
    }
  }

  function releaseTailReader(): void {
    if (tailReader) {
      tailReader.releaseLock();
      tailReader = undefined;
    }
  }

  /** Stop whatever Web side is still held; resolves once that is done. */
  function abandonWebSides(err: Error | null): Promise<unknown> {
    const tasks: Array<Promise<unknown>> = [];
    if (tailReader) {
      const reader = tailReader;
      tasks.push(
        reader
          .cancel(err ?? undefined)
          .catch(noop)
          .then(releaseTailReader)
      );
    }
    if (headWriter) {
      const writer = headWriter;
      tasks.push(
        writer
          .abort(err ?? undefined)
          .catch(noop)
          .then(releaseHeadWriter)
      );
    }
    return Promise.allSettled(tasks);
  }

  const d = new Duplex({
    writableObjectMode: !!head?.writableObjectMode,
    readableObjectMode: !!tail?.readableObjectMode,
    writable,
    readable
  });

  if (writable) {
    if (isNodeStream(head)) {
      d._write = function (chunk: unknown, encoding: string, callback: Callback) {
        if (head.write(chunk, encoding)) {
          callback();
        } else {
          ondrain = callback;
        }
      };
      d._final = function (callback: Callback) {
        head.end();
        onfinish = callback;
      };
      head.on("drain", () => {
        if (ondrain) {
          const cb = ondrain;
          ondrain = null;
          cb();
        }
      });
    } else {
      const writer = (isTransformStream(head) ? head.writable : head).getWriter();
      headWriter = writer;
      d._write = async function (chunk: unknown, _encoding: string, callback: Callback) {
        try {
          await writer.ready;
          writer.write(chunk).catch(() => {});
          callback();
        } catch (err) {
          callback(err as Error);
        }
      };
      d._final = async function (callback: Callback) {
        try {
          await writer.ready;
          writer.close().then(releaseHeadWriter, noop);
          onfinish = callback;
        } catch (err) {
          callback(err as Error);
        }
      };
    }

    // The writable side is finished once the tail has produced everything.
    if (isNodeStream(tail)) {
      eos(tail, finishWrite);
    }
  }

  if (readable) {
    if (isNodeStream(tail)) {
      d._read = function () {
        tail.resume();
      };
      tail.on("data", (chunk: unknown) => {
        if (!d.push(chunk)) {
          tail.pause();
        }
      });
      tail.on("end", () => {
        d.push(null);
      });
    } else {
      const reader = (isTransformStream(tail) ? tail.readable : tail).getReader();
      tailReader = reader;
      d._read = async function () {
        while (true) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              releaseTailReader();
              d.push(null);
              finishWrite();
              return;
            }
            if (!d.push(value)) {
              return;
            }
          } catch {
            return;
          }
        }
      };
    }
  }

  d._destroy = function (err: Error | null, callback: Callback) {
    if (!err && onclose !== null) {
      err = createAbortError();
    }
    ondrain = null;
    onfinish = null;
    if (isNodeStream(tail)) {
      destroyer(tail, err);
    }
    // Cancelling the tail's reader (or aborting the head's writer) is also
    // what lets the inner pipeline finish, so wait for it either way.
    const abandoned = abandonWebSides(err);
    const finishDestroy = (e?: Error | null): void => {
      abandoned.then(() => callback(e));
    };
    if (onclose === null) {
      finishDestroy(err);
    } else {
      onclose = finishDestroy;
    }
  };

  return d;
}
