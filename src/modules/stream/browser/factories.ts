/**
 * Browser Stream - factory functions, built on the browser stream classes.
 */

import {
  makeCreateReadable,
  makeCreateReadableFromAsyncIterable,
  makeCreateReadableFromArray,
  makeCreateReadableFromGenerator,
  makeCreateReadableFromPromise,
  makeCreateEmptyReadable,
  makeCreateWritable,
  makeCreateNullWritable,
  makeCreateTransform,
  makeCreatePassThrough,
  makeCreateDuplex,
  makeFilter,
  makeFromBytes,
  makeFromJSON,
  makeFromString,
  makeTransform
} from "@stream/core/factories";
import type { StreamFactories } from "@stream/core/factories";
import { Duplex, PassThrough, Readable, Transform } from "@stream/kernel/classes";
import { Writable } from "@stream/kernel/writable";

export { BufferedStream, createByteChunk, createStringChunk } from "@stream/buffered-stream";
export { createBufferedStream, createPullStream } from "@stream/core/factories";
export { PullStream } from "@stream/pull-stream";

export const createReadable: StreamFactories["createReadable"] =
  /* @__PURE__ */ makeCreateReadable(Readable);
export const createReadableFromAsyncIterable: StreamFactories["createReadableFromAsyncIterable"] =
  /* @__PURE__ */ makeCreateReadableFromAsyncIterable(Readable);
export const createReadableFromArray: StreamFactories["createReadableFromArray"] =
  /* @__PURE__ */ makeCreateReadableFromArray(Readable);
export const createReadableFromGenerator: StreamFactories["createReadableFromGenerator"] =
  /* @__PURE__ */ makeCreateReadableFromGenerator(Readable);
export const createReadableFromPromise: StreamFactories["createReadableFromPromise"] =
  /* @__PURE__ */ makeCreateReadableFromPromise(Readable);
export const createEmptyReadable: StreamFactories["createEmptyReadable"] =
  /* @__PURE__ */ makeCreateEmptyReadable(Readable);
export const createWritable: StreamFactories["createWritable"] =
  /* @__PURE__ */ makeCreateWritable(Writable);
export const createNullWritable: StreamFactories["createNullWritable"] =
  /* @__PURE__ */ makeCreateNullWritable(Writable);
export const createTransform: StreamFactories["createTransform"] =
  /* @__PURE__ */ makeCreateTransform(Transform);
export const createPassThrough: StreamFactories["createPassThrough"] =
  /* @__PURE__ */ makeCreatePassThrough(PassThrough);
export const createDuplex: StreamFactories["createDuplex"] =
  /* @__PURE__ */ makeCreateDuplex(Duplex);
export const fromBytes: StreamFactories["fromBytes"] = /* @__PURE__ */ makeFromBytes(Readable);
export const fromString: StreamFactories["fromString"] = /* @__PURE__ */ makeFromString(Readable);
export const fromJSON: StreamFactories["fromJSON"] = /* @__PURE__ */ makeFromJSON(Readable);
export const transform: StreamFactories["transform"] = /* @__PURE__ */ makeTransform(Transform);
export const filter: StreamFactories["filter"] = /* @__PURE__ */ makeFilter(Transform);
