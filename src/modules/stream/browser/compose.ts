/**
 * Browser Stream - compose()
 */

import type { Duplex } from "@stream/kernel/classes";
import { kernel } from "@stream/kernel/classes";
import { composeImpl } from "@stream/kernel/compose-impl";
import type { PipelineStageLike } from "@stream/types";

/** The kernel's Duplex, reading `R` and writing `T`. */
export type ComposedDuplex<T = unknown, R = unknown> = Duplex<R, T>;

/**
 * Combine stages into one Duplex: writes go into the first, reads come out of
 * the last. Stages are what `pipeline` takes — streams, Web streams,
 * generator functions, iterables — and the rules are Node's: no stage throws
 * ERR_MISSING_ARGS, one stage is `Duplex.from(stage)`.
 *
 * `T` is what is written in and `R` what is read out. They are the caller's
 * statement, like a type argument to `JSON.parse`: the stages are not checked
 * against them, as Node's own `compose` checks nothing.
 */
export function compose<T = unknown, R = unknown>(
  ...stages: PipelineStageLike[]
): ComposedDuplex<T, R> {
  return composeImpl(kernel, ...stages);
}
