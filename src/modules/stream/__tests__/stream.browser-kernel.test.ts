/**
 * Stream Module Browser Tests
 *
 * Runs the shared stream test suite against the Browser implementation.
 * The same suite is also executed in Node.js tests to ensure behavior and
 * data integrity stay consistent across environments.
 */

import type { StreamModuleImports } from "@stream/__tests__/stream.shared";
import { runStreamTests } from "@stream/__tests__/stream.shared";
import {
  Readable,
  Writable,
  Transform,
  Duplex,
  PassThrough,
  BufferedStream,
  createStringChunk,
  createByteChunk,
  ChunkedBuilder,
  TransactionalChunkedBuilder,
  PullStream,
  createCollector,
  createDuplex,
  createEmptyReadable,
  createNullWritable,
  createReadableFromAsyncIterable,
  createReadableFromGenerator,
  createReadableFromPromise,
  isStream,
  isReadable,
  isWritable,
  isTransform,
  isDuplex,
  isDestroyed,
  isDisturbed,
  isErrored,
  createTransform,
  createReadableFromArray,
  createReadable,
  createWritable,
  createPassThrough,
  pipeline,
  finished,
  streamToUint8Array,
  streamToString,
  drainStream,
  copyStream,
  addAbortSignal,
  compose,
  finishedAll,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark,
  duplexPair,
  consumers,
  promises,
  promisify
} from "@stream/index.browser";
import {
  stringToUint8Array,
  uint8ArrayToString,
  uint8ArrayEquals,
  uint8ArrayIndexOf,
  concatUint8Arrays
} from "@utils/binary";
import { EventEmitter } from "@utils/event-emitter";
import { describe } from "vitest";

// =============================================================================
// Run Shared Tests (Identical behavior for Node.js and Browser)
// =============================================================================
describe("Stream Module - Shared Tests (Browser kernel on Node)", () => {
  const imports: StreamModuleImports = {
    EventEmitter,
    Readable,
    Writable,
    Transform,
    Duplex,
    PassThrough,
    BufferedStream,
    PullStream,
    createStringChunk,
    createByteChunk,
    ChunkedBuilder,
    TransactionalChunkedBuilder,
    createReadable,
    createWritable,
    createPassThrough,
    createTransform,
    createCollector,
    createDuplex,
    createReadableFromArray,
    createReadableFromAsyncIterable,
    createReadableFromGenerator,
    createReadableFromPromise,
    createEmptyReadable,
    createNullWritable,
    duplexPair,
    pipeline,
    finished,
    streamToUint8Array,
    streamToString,
    drainStream,
    copyStream,
    concatUint8Arrays,
    addAbortSignal,
    compose,
    finishedAll,
    promisify,
    isReadable,
    isWritable,
    isTransform,
    isDuplex,
    isStream,
    isDestroyed,
    isDisturbed,
    isErrored,
    getDefaultHighWaterMark,
    setDefaultHighWaterMark,
    consumers,
    promises,
    stringToUint8Array,
    uint8ArrayToString,
    uint8ArrayEquals,
    uint8ArrayIndexOf,
    // Browser uses the project's own compose implementation which always returns a Duplex.
    nativeComposeReturnsDuplex: true,
    duplexPairDestroysPeerOnError: true
  };

  runStreamTests(imports);
});
