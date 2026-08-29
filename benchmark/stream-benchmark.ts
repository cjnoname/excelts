/**
 * Stream performance benchmark — library primitives vs Node's own `node:stream`.
 *
 * A benchmark, not an example: it measures the cost of internal machinery
 * (`@utils/event-emitter`, the pull-based readers) against the platform's
 * equivalents. Nothing here is a usage pattern to copy, which is why it lives
 * beside the other benchmarks rather than under `examples/` — an example that
 * has to reach into internals is either the wrong file or a missing API, and
 * this one is the former.
 *
 * Run: node --import @oxc-node/core/register benchmark/stream-benchmark.ts
 */
import { Readable, Writable, Transform, pipeline } from "stream";
import { promisify } from "util";

import {
  createReadableFromArray,
  createTransform,
  createCollector,
  pipeline as myPipeline
} from "../src/modules/stream/index";

const pipelineAsync = promisify(pipeline);

// Test data
const ITERATIONS = 50;
const CHUNK_COUNT = 10000;
const CHUNK_SIZE = 1024;

function createTestChunks(count: number, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(Buffer.alloc(size, i % 256));
  }
  return chunks;
}

// Benchmark: Native Node.js streams
async function benchmarkNative(chunks: Buffer[]): Promise<number> {
  const start = performance.now();

  let index = 0;
  const readable = new Readable({
    read() {
      if (index < chunks.length) {
        this.push(chunks[index++]);
      } else {
        this.push(null);
      }
    }
  });

  const transform = new Transform({
    transform(chunk, _enc, cb) {
      cb(null, chunk);
    }
  });

  const collected: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      collected.push(chunk);
      cb();
    }
  });

  await pipelineAsync(readable, transform, writable);

  return performance.now() - start;
}

// Benchmark: Your wrapped streams
async function benchmarkWrapped(chunks: Buffer[]): Promise<number> {
  const start = performance.now();

  const readable = createReadableFromArray(chunks, { objectMode: false });

  const transform = createTransform<Buffer, Buffer>(chunk => chunk, { objectMode: false });

  const collector = createCollector<Buffer>({ objectMode: false });

  await myPipeline(readable, transform, collector);

  return performance.now() - start;
}

// Benchmark: EventEmitter overhead
async function benchmarkEventEmitter(): Promise<{ native: number; wrapped: number }> {
  const { EventEmitter } = await import("events");
  const { EventEmitter: BrowserEmitter } = await import("../src/utils/event-emitter");

  const EMIT_COUNT = 100000;

  // Native EventEmitter
  const nativeEmitter = new EventEmitter();
  let _nativeCount = 0;
  nativeEmitter.on("data", () => {
    _nativeCount++;
  });

  const nativeStart = performance.now();
  for (let i = 0; i < EMIT_COUNT; i++) {
    nativeEmitter.emit("data", i);
  }
  const nativeTime = performance.now() - nativeStart;

  // Browser EventEmitter
  const browserEmitter = new BrowserEmitter();
  let _browserCount = 0;
  browserEmitter.on("data", () => {
    _browserCount++;
  });

  const browserStart = performance.now();
  for (let i = 0; i < EMIT_COUNT; i++) {
    browserEmitter.emit("data", i);
  }
  const browserTime = performance.now() - browserStart;

  return { native: nativeTime, wrapped: browserTime };
}

// Main benchmark
async function main() {
  console.log("=".repeat(60));
  console.log("Stream Performance Benchmark");
  console.log("=".repeat(60));
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Chunks per stream: ${CHUNK_COUNT}`);
  console.log(`Chunk size: ${CHUNK_SIZE} bytes`);
  console.log(
    `Total data per iteration: ${((CHUNK_COUNT * CHUNK_SIZE) / 1024 / 1024).toFixed(2)} MB`
  );
  console.log("");

  const chunks = createTestChunks(CHUNK_COUNT, CHUNK_SIZE);

  // Warmup
  console.log("Warming up...");
  await benchmarkNative(chunks);
  await benchmarkWrapped(chunks);

  // Benchmark
  console.log("Running benchmarks...\n");

  const nativeTimes: number[] = [];
  const wrappedTimes: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    nativeTimes.push(await benchmarkNative(chunks));
    wrappedTimes.push(await benchmarkWrapped(chunks));
  }

  const avgNative = nativeTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
  const avgWrapped = wrappedTimes.reduce((a, b) => a + b, 0) / ITERATIONS;

  console.log("Pipeline (Readable → Transform → Writable):");
  console.log("-".repeat(40));
  console.log(`Native Node.js:  ${avgNative.toFixed(2)} ms avg`);
  console.log(`Your streams.ts: ${avgWrapped.toFixed(2)} ms avg`);
  const overhead = (avgWrapped / avgNative - 1) * 100;
  console.log(`Difference:      ${overhead > 0 ? "+" : ""}${overhead.toFixed(1)}%`);
  console.log("");

  // EventEmitter benchmark
  console.log("EventEmitter (100k emits):");
  console.log("-".repeat(40));
  const emitterResult = await benchmarkEventEmitter();
  console.log(`Native EventEmitter:  ${emitterResult.native.toFixed(2)} ms`);
  console.log(`Browser EventEmitter: ${emitterResult.wrapped.toFixed(2)} ms`);
  const emitterOverhead = (emitterResult.wrapped / emitterResult.native - 1) * 100;
  console.log(
    `Difference:           ${emitterOverhead > 0 ? "+" : ""}${emitterOverhead.toFixed(1)}%`
  );
  console.log("");

  // Throughput
  const throughputNative =
    (CHUNK_COUNT * CHUNK_SIZE * ITERATIONS) /
    (nativeTimes.reduce((a, b) => a + b, 0) / 1000) /
    1024 /
    1024;
  const throughputWrapped =
    (CHUNK_COUNT * CHUNK_SIZE * ITERATIONS) /
    (wrappedTimes.reduce((a, b) => a + b, 0) / 1000) /
    1024 /
    1024;

  console.log("Throughput:");
  console.log("-".repeat(40));
  console.log(`Native Node.js:  ${throughputNative.toFixed(0)} MB/s`);
  console.log(`Your streams.ts: ${throughputWrapped.toFixed(0)} MB/s`);
  console.log("");
  console.log("=".repeat(60));
  console.log("");
  console.log("Summary:");
  if (Math.abs(overhead) < 5) {
    console.log("✅ Your streams.ts has nearly identical performance to native Node.js!");
  } else if (overhead < 0) {
    console.log("✅ Your streams.ts is FASTER than native Node.js!");
  } else if (overhead < 20) {
    console.log("✅ Your streams.ts has minimal overhead (~" + overhead.toFixed(0) + "%)");
  } else {
    console.log("⚠️  Your streams.ts has noticeable overhead (~" + overhead.toFixed(0) + "%)");
  }
}

main().catch(console.error);
