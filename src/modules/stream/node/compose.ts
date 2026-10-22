/**
 * Node.js Stream - compose()
 *
 * Node's own `stream.compose`. With a Web stream among the stages it runs the
 * module's compose over Node's classes instead: Node's takes a reader / writer
 * on a Web head or tail and never gives it back when the composed stream is
 * destroyed, so the Web stream stays locked and the composed stream never
 * closes.
 */

import { compose as nodeCompose, Duplex, PassThrough, Readable } from "stream";

import { composeImpl } from "@stream/kernel/compose-impl";
import { isWebStream } from "@stream/kernel/stream-utils";
import type { IDuplex, PipelineStageLike } from "@stream/types";

/**
 * `node:stream`'s Duplex with the chunk-carrying members typed: `R` is what is
 * read or iterated out, `T` what is written in.
 *
 * Where Node declares `any` (`read`, the async iterator) the typed signature is
 * added in front, so calls are typed while the result still satisfies
 * `NodeJS.ReadableStream`, whose `read` promises `string | Buffer`. `write` and
 * `end` are replaced, so a chunk of the wrong type is rejected. The result is
 * assignable to `Duplex` and `NodeJS.ReadWriteStream`, and goes wherever
 * `node:stream`'s own `compose` result goes.
 */
export type ComposedDuplex<T = unknown, R = unknown> = {
  [Symbol.asyncIterator](): NodeJS.AsyncIterator<R>;
} & IDuplex<R, T> &
  Omit<Duplex, "write" | "end">;

/**
 * Combine stages into one Duplex: writes go into the first, reads come out of
 * the last. Stages are what `pipeline` takes — streams, Web streams,
 * generator functions, iterables — and the rules are Node's: no stage throws
 * ERR_MISSING_ARGS, one stage is `Duplex.from(stage)`.
 *
 * `T` is what is written in and `R` what is read out (see {@link ComposedDuplex}).
 * They are the caller's statement, like a type argument to `JSON.parse`: the
 * stages are not checked against them, as Node's own `compose` checks nothing.
 */
export function compose<T = unknown, R = unknown>(
  ...stages: PipelineStageLike[]
): ComposedDuplex<T, R> {
  if (stages.some(isWebStream)) {
    return composeImpl({ Readable, Duplex, PassThrough }, ...stages);
  }
  return (nodeCompose as (...streams: unknown[]) => ComposedDuplex<T, R>)(...stages);
}
