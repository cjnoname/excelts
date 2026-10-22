/**
 * Browser Stream - utilities
 */

import { finished, pipeline } from "@stream/browser/pipeline";
import { createAddAbortSignal } from "@stream/core/add-abort-signal";
import { createConsumers } from "@stream/core/consumers";
import { streamToString, streamToUint8Array } from "@stream/core/stream-helpers";
import { createIsDuplex, createIsStream, createIsTransform } from "@stream/core/type-guards";
import { Duplex, Readable, Transform } from "@stream/kernel/classes";
import { Writable } from "@stream/kernel/writable";
import type { IDuplex, ITransform, ReadableLike, WritableLike } from "@stream/types";

export {
  drainStream,
  isDisturbed,
  isReadable,
  isWritable,
  streamToBuffer,
  streamToString,
  streamToUint8Array
} from "@stream/core/stream-helpers";

/** Resolve when a stream has finished. */
export const streamToPromise = finished;

/** Copy from a readable stream to a writable stream. */
export const copyStream = pipeline;

export const isTransform: (obj: unknown) => obj is ITransform<unknown, unknown> =
  /* @__PURE__ */ createIsTransform(Transform);

export const isDuplex: (obj: unknown) => obj is IDuplex<unknown, unknown> =
  /* @__PURE__ */ createIsDuplex(Duplex);

export const isStream: (obj: unknown) => obj is ReadableLike | WritableLike =
  /* @__PURE__ */ createIsStream(Readable, Writable);

export const addAbortSignal = /* @__PURE__ */ createAddAbortSignal({
  add(emitter, event, listener) {
    emitter.once?.(event, listener);
  },
  remove(emitter, event, listener) {
    (emitter.off ?? emitter.removeListener)?.call(emitter, event, listener);
  }
});

export const consumers = /* @__PURE__ */ createConsumers({ streamToUint8Array, streamToString });

export const promises = { pipeline, finished };
