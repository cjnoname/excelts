/**
 * Stream Utilities (browser)
 *
 * Browser counterpart of `utils.ts`, selected automatically
 * by the `preferBrowserFilesPlugin()` mechanism.
 *
 * All factory-produced helpers are lazily initialized on first call to avoid
 * eagerly pulling in heavy stream class dependencies at import time.
 */

import { createReadableFromArray, createTransform } from "@stream/browser/factories";
import { consumers } from "@stream/browser/utils";
import type { UtilsDeps } from "@stream/utils.base";
import {
  collect,
  createText,
  createJson,
  createBytes,
  createFromString,
  createFromJSON,
  createFromBytes,
  createTransformHelper,
  createFilter,
  isReadableStreamLike,
  readableStreamToAsyncIterable
} from "@stream/utils.base";

let _deps: UtilsDeps | null = null;
function getDeps(): UtilsDeps {
  if (!_deps) {
    _deps = {
      createReadableFromArray,
      createTransform: createTransform as UtilsDeps["createTransform"],
      consumers
    };
  }
  return _deps;
}

export { collect, isReadableStreamLike, readableStreamToAsyncIterable };

/** The minimal shape {@link text} / {@link json} / {@link bytes} consume. */
export type AsyncIterableStream = { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> };

let _text: ReturnType<typeof createText>;
export function text(stream: AsyncIterableStream): Promise<string> {
  if (!_text) {
    _text = createText(getDeps());
  }
  return _text(stream);
}

let _json: ReturnType<typeof createJson>;
export function json<T = unknown>(stream: AsyncIterableStream): Promise<T> {
  if (!_json) {
    _json = createJson(getDeps());
  }
  return (_json as (s: AsyncIterableStream) => Promise<T>)(stream);
}

let _bytes: ReturnType<typeof createBytes>;
export function bytes(stream: AsyncIterableStream): Promise<Uint8Array> {
  if (!_bytes) {
    _bytes = createBytes(getDeps());
  }
  return _bytes(stream);
}

let _fromString: ReturnType<typeof createFromString>;
export function fromString(str: string) {
  if (!_fromString) {
    _fromString = createFromString(getDeps());
  }
  return _fromString(str);
}

let _fromJSON: ReturnType<typeof createFromJSON>;
export function fromJSON(data: unknown) {
  if (!_fromJSON) {
    _fromJSON = createFromJSON(getDeps());
  }
  return _fromJSON(data);
}

let _fromBytes: ReturnType<typeof createFromBytes>;
export function fromBytes(data: Uint8Array) {
  if (!_fromBytes) {
    _fromBytes = createFromBytes(getDeps());
  }
  return _fromBytes(data);
}

let _transform: ReturnType<typeof createTransformHelper>;
export function transform<TIn = Uint8Array, TOut = TIn>(fn: (chunk: TIn) => TOut | Promise<TOut>) {
  if (!_transform) {
    _transform = createTransformHelper(getDeps());
  }
  return _transform(fn);
}

let _filter: ReturnType<typeof createFilter>;
export function filter<T>(predicate: (chunk: T) => boolean | Promise<boolean>) {
  if (!_filter) {
    _filter = createFilter(getDeps());
  }
  return _filter(predicate);
}
