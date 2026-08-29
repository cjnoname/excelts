/**
 * Example: readable/writable factory family + chunk constructors
 *
 * Demonstrates the remaining stream creation helpers:
 * - createReadableFromGenerator()    — drive a readable from an async generator
 * - createReadableFromAsyncIterable() — wrap any async iterable as a readable
 * - createReadableFromPromise()      — emit a single value once a promise settles
 * - createEmptyReadable()            — a readable that ends immediately
 * - createNullWritable()             — a sink that discards everything (/dev/null)
 * - createStringChunk() / createByteChunk() — build DataChunk objects from
 *   strings / bytes for use with BufferedStream-style buffering
 *
 * Usage: pnpm example --filter 08-readable-factories
 */

import {
  collect,
  createByteChunk,
  createEmptyReadable,
  createNullWritable,
  createReadableFromAsyncIterable,
  createReadableFromGenerator,
  createReadableFromPromise,
  createStringChunk,
  finished,
  streamToString
} from "@stream";

const decoder = new TextDecoder();

/** createReadableFromGenerator(): pull values from an async generator. */
export async function exampleFromGenerator(): Promise<void> {
  async function* countUp(): AsyncGenerator<number, void, unknown> {
    for (let i = 1; i <= 4; i++) {
      yield i * 10;
    }
  }
  const source = createReadableFromGenerator(countUp);
  const values = await collect<number>(source);
  console.log("createReadableFromGenerator:", values);
}

/** createReadableFromAsyncIterable(): wrap an arbitrary async iterable. */
export async function exampleFromAsyncIterable(): Promise<void> {
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      yield "alpha";
      yield "beta";
      yield "gamma";
    }
  };
  const source = createReadableFromAsyncIterable(iterable);
  const values = await collect<string>(source);
  console.log("createReadableFromAsyncIterable:", values);
}

/** createReadableFromPromise(): emit one resolved value, then end. */
export async function exampleFromPromise(): Promise<void> {
  const source = createReadableFromPromise(Promise.resolve({ ready: true, id: 7 }));
  const values = await collect<{ ready: boolean; id: number }>(source);
  console.log("createReadableFromPromise:", values);
}

/** createEmptyReadable(): a readable that yields nothing and ends. */
export async function exampleEmptyReadable(): Promise<void> {
  const source = createEmptyReadable<Uint8Array>();
  const text = await streamToString(source);
  console.log("createEmptyReadable produced length:", text.length);
}

/** createNullWritable(): discard every chunk written to it. */
export async function exampleNullWritable(): Promise<void> {
  const sink = createNullWritable();
  const encoder = new TextEncoder();
  sink.write(encoder.encode("this data goes nowhere"));
  sink.write(encoder.encode(" and so does this"));
  sink.end();
  await finished(sink);
  console.log("createNullWritable discarded all writes (writableEnded:", sink.writableEnded, ")");
}

/** createStringChunk() / createByteChunk(): build DataChunk objects. */
export function exampleChunkConstructors(): void {
  const strChunk = createStringChunk("héllo");
  console.log("createStringChunk length (bytes):", strChunk.length);
  console.log("createStringChunk decoded:", decoder.decode(strChunk.toUint8Array()));

  const byteChunk = createByteChunk(new Uint8Array([0x42, 0x59, 0x54, 0x45]));
  console.log("createByteChunk length:", byteChunk.length);
  console.log("createByteChunk decoded:", decoder.decode(byteChunk.toUint8Array()));

  // copy() blits a slice of the chunk into a caller-provided target buffer.
  const target = new Uint8Array(2);
  const copied = byteChunk.copy(target, 0, 0, 2);
  console.log("createByteChunk copy() copied bytes:", copied, "->", Array.from(target));
}

export async function exampleReadableFactories(): Promise<void> {
  await exampleFromGenerator();
  await exampleFromAsyncIterable();
  await exampleFromPromise();
  await exampleEmptyReadable();
  await exampleNullWritable();
  exampleChunkConstructors();
}

await exampleReadableFactories();
