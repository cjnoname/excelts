/**
 * Stream Module (Node.js entry)
 *
 * Node's own `node:stream` classes, plus the module's helpers around them.
 * `index.browser.ts` exports the same names backed by the browser kernel.
 *
 * @example
 * ```ts
 * import { pipeline, createTransform, createCollector } from "@stream";
 *
 * const upper = createTransform<Uint8Array, Uint8Array>(chunk => chunk);
 * const out = createCollector<Uint8Array>();
 * await pipeline(source, upper, out);
 * ```
 */

// Shared type + platform-independent exports
export * from "@stream/index.base";

// Core stream classes (native Node.js)
export {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark
} from "stream";
export type { ReadableOptions, WritableOptions, DuplexOptions, TransformOptions } from "stream";

// Collector
export { Collector, createCollector } from "@stream/node/collector";

// Factory functions + re-exported helpers
export {
  PullStream,
  BufferedStream,
  createStringChunk,
  createByteChunk,
  createReadable,
  createReadableFromAsyncIterable,
  createReadableFromArray,
  createWritable,
  createTransform,
  createPassThrough,
  createPullStream,
  createBufferedStream,
  createDuplex,
  createReadableFromGenerator,
  createReadableFromPromise,
  createEmptyReadable,
  createNullWritable,
  filter,
  fromBytes,
  fromJSON,
  fromString,
  transform
} from "@stream/node/factories";

// Pipeline & Finished
export { pipeline, finished, finishedAll } from "@stream/node/pipeline";

// Compose
export { compose } from "@stream/node/compose";
export type { ComposedDuplex } from "@stream/node/compose";

// Utilities
export {
  streamToPromise,
  streamToUint8Array,
  streamToBuffer,
  streamToString,
  drainStream,
  copyStream,
  isTransform,
  isDuplex,
  isStream,
  addAbortSignal,
  isDisturbed,
  isReadable,
  isWritable,
  duplexPair,
  consumers,
  promises
} from "@stream/node/utils";

// Web Streams conversions
export {
  readableFromWeb,
  readableToWeb,
  toWritable,
  writableFromWeb,
  writableToWeb
} from "@stream/node/web";
