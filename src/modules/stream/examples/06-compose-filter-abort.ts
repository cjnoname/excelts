/**
 * Example: compose / filter / finishedAll / addAbortSignal
 *
 * Demonstrates composition + functional helpers:
 * - compose()       — fuse several transforms into one transform stream
 * - filter()        — functional predicate transform (drops non-matching chunks)
 * - finishedAll()   — await completion of multiple streams at once
 * - addAbortSignal() — wire an AbortSignal to destroy a stream on abort
 *
 * Usage: pnpm example --filter 06-compose-filter-abort
 */

import {
  addAbortSignal,
  collect,
  compose,
  createReadableFromArray,
  createTransform,
  filter,
  finished,
  finishedAll,
  pipeline
} from "@stream";

/** compose(): chain transforms into a single composite transform. */
export async function exampleCompose(): Promise<void> {
  const double = createTransform<number, number>(n => n * 2, { objectMode: true });
  const addOne = createTransform<number, number>(n => n + 1, { objectMode: true });

  // compose -> a single transform: n => (n * 2) + 1
  const composed = compose<number, number>(double, addOne);

  const source = createReadableFromArray([1, 2, 3], { objectMode: true });
  const out = source.pipe(composed);

  const results = await collect<number>(out);
  console.log("compose results:", results);
}

/** filter(): keep only chunks matching the predicate. */
export async function exampleFilter(): Promise<void> {
  const source = createReadableFromArray([1, 2, 3, 4, 5, 6], { objectMode: true });
  const evens = filter<number>(n => n % 2 === 0);

  const results = await collect<number>(source.pipe(evens));
  console.log("filter (evens):", results);
}

/** finishedAll(): resolve once every stream has finished. */
export async function exampleFinishedAll(): Promise<void> {
  const a = createReadableFromArray(["a1", "a2"], { objectMode: true });
  const b = createReadableFromArray(["b1", "b2", "b3"], { objectMode: true });

  // Streams must be consumed to reach their end.
  a.resume();
  b.resume();

  await finishedAll([a, b]);
  console.log("finishedAll: both streams finished");
}

/** addAbortSignal(): destroy a stream when the signal aborts. */
export async function exampleAddAbortSignal(): Promise<void> {
  const controller = new AbortController();
  const source = createReadableFromArray(["x", "y", "z"], { objectMode: true });

  addAbortSignal(controller.signal, source);

  // Abort before consuming — the stream is destroyed with an AbortError.
  controller.abort();

  try {
    await finished(source);
    console.log("addAbortSignal: finished without abort (unexpected)");
  } catch (err) {
    console.log("addAbortSignal: stream aborted ->", (err as Error).name);
  }
}

export async function exampleComposeFilterAbort(): Promise<void> {
  await exampleCompose();
  await exampleFilter();
  await exampleFinishedAll();
  await exampleAddAbortSignal();
}

// pipeline is imported to show it pairs with these helpers; keep a tiny demo.
export async function examplePipelineWithFilter(): Promise<void> {
  const source = createReadableFromArray([10, 15, 20, 25], { objectMode: true });
  const big = filter<number>(n => n >= 20);
  const collected: number[] = [];
  const sink = createTransform<number, number>(
    n => {
      collected.push(n);
      return n;
    },
    { objectMode: true }
  );
  sink.resume();
  await pipeline(source, big, sink);
  console.log("pipeline + filter (>=20):", collected);
}

await exampleComposeFilterAbort();
await examplePipelineWithFilter();
