/**
 * Stream kernel - iterator helpers (map, filter, reduce, …)
 *
 * Port of Node.js `lib/internal/streams/operators.js`. Every helper is one
 * bounded, ordered async-iterator algorithm (`map`); the others are thin
 * compositions of it. `Readable` wraps the stream-returning ones with
 * `Readable.from`, so returning early or destroying the result tears down the
 * source through the normal iterator lifecycle — there is no second
 * cancellation path to keep in sync.
 */

import {
  createAbortError,
  errInvalidArgType,
  errMissingArgs,
  errOutOfRange,
  validateInteger
} from "@stream/kernel/errors";

export interface OperatorOptions {
  signal?: AbortSignal;
  concurrency?: number;
  highWaterMark?: number;
}

type Source = AsyncIterable<unknown> & {
  once?(event: string, fn: (...args: any[]) => void): unknown;
  destroy?(err?: Error): unknown;
};
type Mapper = (value: any, options: { signal: AbortSignal }) => unknown;

const kEmpty = Symbol("kEmpty");
const kEof = Symbol("kEof");

function validateFunction(fn: unknown, name: string): void {
  if (typeof fn !== "function") {
    throw errInvalidArgType(name, "Function", fn);
  }
}

function validateOptions(options: OperatorOptions | undefined): void {
  if (options != null && typeof options !== "object") {
    throw errInvalidArgType("options", "Object", options);
  }
  if (options?.signal != null && !(options.signal instanceof AbortSignal)) {
    throw errInvalidArgType("options.signal", "AbortSignal", options.signal);
  }
}

export function map(this: Source, fn: Mapper, options?: OperatorOptions): AsyncGenerator<unknown> {
  validateFunction(fn, "fn");
  validateOptions(options);

  let concurrency = 1;
  if (options?.concurrency != null) {
    concurrency = Math.floor(options.concurrency);
  }
  let highWaterMark = concurrency - 1;
  if (options?.highWaterMark != null) {
    highWaterMark = Math.floor(options.highWaterMark);
  }
  validateInteger(concurrency, "options.concurrency", 1);
  validateInteger(highWaterMark, "options.highWaterMark", 0);
  highWaterMark += concurrency;

  return async function* (this: Source) {
    const signal = options?.signal ?? new AbortController().signal;
    const signalOpt = { signal };
    const queue: Array<Promise<unknown> | typeof kEof> = [];

    let next: (() => void) | null = null;
    let resume: (() => void) | null = null;
    let done = false;
    let cnt = 0;

    function onCatch(): void {
      done = true;
      afterItemProcessed();
    }

    function afterItemProcessed(): void {
      cnt -= 1;
      maybeResume();
    }

    function maybeResume(): void {
      if (resume && !done && cnt < concurrency && queue.length < highWaterMark) {
        resume();
        resume = null;
      }
    }

    const pump = async (): Promise<void> => {
      try {
        for await (const item of this) {
          if (done) {
            return;
          }
          if (signal.aborted) {
            throw createAbortError();
          }

          let val: Promise<unknown>;
          try {
            const result = fn(item, signalOpt);
            if (result === kEmpty) {
              continue;
            }
            val = Promise.resolve(result);
          } catch (err) {
            val = Promise.reject(err);
          }

          cnt += 1;
          val.then(afterItemProcessed, onCatch);
          queue.push(val);
          if (next) {
            next();
            next = null;
          }

          if (!done && (queue.length >= highWaterMark || cnt >= concurrency)) {
            await new Promise<void>(resolve => {
              resume = resolve;
            });
          }
        }
        queue.push(kEof);
      } catch (err) {
        const val = Promise.reject(err);
        val.then(afterItemProcessed, onCatch);
        queue.push(val);
      } finally {
        done = true;
        if (next) {
          next();
          next = null;
        }
      }
    };

    pump();

    try {
      while (true) {
        while (queue.length > 0) {
          const val = await queue[0];
          if (val === kEof) {
            return;
          }
          if (signal.aborted) {
            throw createAbortError();
          }
          if (val !== kEmpty) {
            yield val;
          }
          queue.shift();
          maybeResume();
        }
        await new Promise<void>(resolve => {
          next = resolve;
        });
      }
    } finally {
      done = true;
      const pending = resume as (() => void) | null;
      if (pending) {
        resume = null;
        pending();
      }
    }
  }.call(this);
}

export function filter(
  this: Source,
  fn: Mapper,
  options?: OperatorOptions
): AsyncGenerator<unknown> {
  validateFunction(fn, "fn");
  async function filterFn(value: unknown, opts: { signal: AbortSignal }): Promise<unknown> {
    return (await fn(value, opts)) ? value : kEmpty;
  }
  return map.call(this, filterFn, options);
}

export function flatMap(
  this: Source,
  fn: Mapper,
  options?: OperatorOptions
): AsyncGenerator<unknown> {
  const values = map.call(this, fn, options);
  return (async function* () {
    for await (const val of values) {
      yield* val as AsyncIterable<unknown>;
    }
  })();
}

function toIntegerOrInfinity(value: number): number {
  const n = Number(value);
  if (Number.isNaN(n)) {
    return 0;
  }
  if (n < 0) {
    throw errOutOfRange("number", ">= 0", n);
  }
  return n;
}

export function drop(
  this: Source,
  number: number,
  options?: { signal?: AbortSignal }
): AsyncGenerator<unknown> {
  validateOptions(options);
  let remaining = toIntegerOrInfinity(number);
  return async function* (this: Source) {
    if (options?.signal?.aborted) {
      throw createAbortError();
    }
    for await (const val of this) {
      if (options?.signal?.aborted) {
        throw createAbortError();
      }
      if (remaining-- <= 0) {
        yield val;
      }
    }
  }.call(this);
}

export function take(
  this: Source,
  number: number,
  options?: { signal?: AbortSignal }
): AsyncGenerator<unknown> {
  validateOptions(options);
  let remaining = toIntegerOrInfinity(number);
  return async function* (this: Source) {
    if (options?.signal?.aborted) {
      throw createAbortError();
    }
    for await (const val of this) {
      if (options?.signal?.aborted) {
        throw createAbortError();
      }
      if (remaining-- > 0) {
        yield val;
      }
      if (remaining <= 0) {
        return;
      }
    }
  }.call(this);
}

export async function some(this: Source, fn: Mapper, options?: OperatorOptions): Promise<boolean> {
  for await (const _ of filter.call(this, fn, options)) {
    return true;
  }
  return false;
}

export async function every(this: Source, fn: Mapper, options?: OperatorOptions): Promise<boolean> {
  validateFunction(fn, "fn");
  return !(await some.call(
    this,
    async (value: unknown, opts: { signal: AbortSignal }) => !(await fn(value, opts)),
    options
  ));
}

export async function find(this: Source, fn: Mapper, options?: OperatorOptions): Promise<unknown> {
  for await (const result of filter.call(this, fn, options)) {
    return result;
  }
  return undefined;
}

export async function forEach(this: Source, fn: Mapper, options?: OperatorOptions): Promise<void> {
  validateFunction(fn, "fn");
  async function forEachFn(value: unknown, opts: { signal: AbortSignal }): Promise<typeof kEmpty> {
    await fn(value, opts);
    return kEmpty;
  }
  for await (const _ of map.call(this, forEachFn, options)) {
    // drained for side effects
  }
}

export async function toArray(
  this: Source,
  options?: { signal?: AbortSignal }
): Promise<unknown[]> {
  validateOptions(options);
  const result: unknown[] = [];
  for await (const val of this) {
    if (options?.signal?.aborted) {
      throw createAbortError(options.signal.reason);
    }
    result.push(val);
  }
  return result;
}

export async function reduce(
  this: Source,
  reducer: (acc: any, value: any, options: { signal: AbortSignal }) => unknown,
  ...rest: [initialValue?: unknown, options?: { signal?: AbortSignal }]
): Promise<unknown> {
  validateFunction(reducer, "reducer");
  const options = rest[1];
  validateOptions(options);

  let hasInitialValue = rest.length > 0;
  let accumulator = rest[0];
  if (options?.signal?.aborted) {
    const err = createAbortError(options.signal.reason);
    this.once?.("error", () => {});
    this.destroy?.(err);
    throw err;
  }

  const ac = new AbortController();
  const signal = ac.signal;
  const outer = options?.signal;
  const onOuterAbort = (): void => ac.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  let gotAnyItem = false;
  try {
    for await (const value of this) {
      gotAnyItem = true;
      if (outer?.aborted) {
        throw createAbortError();
      }
      if (!hasInitialValue) {
        accumulator = value;
        hasInitialValue = true;
      } else {
        accumulator = await reducer(accumulator, value, { signal });
      }
    }
    if (!gotAnyItem && !hasInitialValue) {
      const err = errMissingArgs("reduce");
      err.message = "Reduce of an empty stream requires an initial value";
      throw err;
    }
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
    ac.abort();
  }
  return accumulator;
}
