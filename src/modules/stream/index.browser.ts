/**
 * Stream Module (browser entry)
 *
 * The same names as `index.ts`, backed by the browser kernel in `./browser`,
 * a port of Node's `lib/internal/streams`.
 */

// Shared type + platform-independent exports
export * from "@stream/index.base";

// Core stream classes
export { Readable, Duplex, Transform, PassThrough } from "@stream/kernel/classes";
export type { ReadableOptions, DuplexOptions, TransformOptions } from "@stream/kernel/classes";
export { Writable } from "@stream/kernel/writable";
export type { WritableOptions, WritableSide } from "@stream/kernel/writable";
export { getDefaultHighWaterMark, setDefaultHighWaterMark } from "@stream/kernel/state";

// Collector
export { Collector, createCollector } from "@stream/browser/collector";

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
} from "@stream/browser/factories";

// Pipeline & Finished
export { pipeline, finished, finishedAll } from "@stream/browser/pipeline";

// Compose
export { compose } from "@stream/browser/compose";
export type { ComposedDuplex } from "@stream/browser/compose";

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
  consumers,
  promises
} from "@stream/browser/utils";

// Web Streams conversions
export { duplexPair } from "@stream/browser/duplex-pair";
export {
  readableFromWeb,
  readableToWeb,
  toWritable,
  writableFromWeb,
  writableToWeb
} from "@stream/browser/web";
