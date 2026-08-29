/**
 * Example: consume helpers (collect / json / bytes / streamTo* / drain / copy)
 *
 * Demonstrates the full family of consumption utilities:
 * - collect()        — gather every chunk of an async-iterable stream into an array
 * - json() / fromJSON()   — round-trip a JS value through a byte stream
 * - bytes() / fromBytes() — round-trip raw bytes through a stream
 * - streamToString / streamToBuffer / streamToUint8Array — drain to string/bytes
 * - drainStream()    — consume and discard everything (run side effects to end)
 * - copyStream()     — pipe a readable into a writable (alias of pipeline)
 *
 * Usage: pnpm example --filter 05-consume-helpers
 */

import {
  bytes,
  collect,
  copyStream,
  createCollector,
  createReadableFromArray,
  drainStream,
  fromBytes,
  fromJSON,
  json,
  streamToBuffer,
  streamToString,
  streamToUint8Array
} from "@stream";

const decoder = new TextDecoder();

/** collect(): gather all object-mode chunks into a plain array. */
export async function exampleCollect(): Promise<void> {
  const source = createReadableFromArray([1, 2, 3, 4], { objectMode: true });
  const values = await collect<number>(source);
  console.log("collect:", values);
}

/** json()/fromJSON(): serialize a value to a byte stream and read it back. */
export async function exampleJson(): Promise<void> {
  const payload = { name: "stream", count: 42, tags: ["a", "b"] };
  const stream = fromJSON(payload);
  const parsed = await json<typeof payload>(stream);
  console.log("json round-trip:", parsed);
}

/** bytes()/fromBytes(): round-trip raw bytes. */
export async function exampleBytes(): Promise<void> {
  const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const collected = await bytes(fromBytes(original));
  console.log("bytes round-trip:", Array.from(collected));
}

/** streamToString / streamToBuffer / streamToUint8Array: drain a readable. */
export async function exampleStreamTo(): Promise<void> {
  const text = "The quick brown fox";

  // Each helper consumes a fresh stream (streams are one-shot).
  const asString = await streamToString(fromBytes(new TextEncoder().encode(text)));
  console.log("streamToString:", asString);

  const asBuffer = await streamToBuffer(fromBytes(new TextEncoder().encode(text)));
  console.log("streamToBuffer length:", asBuffer.length);

  const asU8 = await streamToUint8Array(fromBytes(new TextEncoder().encode(text)));
  console.log("streamToUint8Array head:", decoder.decode(asU8.subarray(0, 3)));
}

/** drainStream(): consume every chunk without keeping it. */
export async function exampleDrain(): Promise<void> {
  let count = 0;
  const source = createReadableFromArray(["a", "b", "c"], { objectMode: true });
  source.on("data", () => count++);
  await drainStream(source);
  console.log("drainStream consumed chunks:", count);
}

/** copyStream(): pipe a readable into a writable (pipeline alias). */
export async function exampleCopy(): Promise<void> {
  const source = createReadableFromArray(["x", "y", "z"], { objectMode: true });
  const sink = createCollector<string>();
  await copyStream(source, sink);
  console.log("copyStream collected:", sink.chunks);
}

export async function exampleConsumeHelpers(): Promise<void> {
  await exampleCollect();
  await exampleJson();
  await exampleBytes();
  await exampleStreamTo();
  await exampleDrain();
  await exampleCopy();
}

await exampleConsumeHelpers();
