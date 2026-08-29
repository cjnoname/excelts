/**
 * Stream performance benchmark — the browser-variant primitives vs Node's own.
 *
 * Runs under Node despite the name: it imports `node:stream` on purpose, to time
 * the browser implementations against the platform ones. A benchmark, not an
 * example — see `stream-benchmark.ts`.
 *
 * Imports `index.browser` explicitly rather than `index`. The alias `@stream` and
 * the bare `index` both resolve to the *Node* entry outside a browser-conditioned
 * build, so this file previously compared the Node implementation against Node's
 * own streams and reported the "browser" numbers as ~16% faster than native — a
 * measurement of nothing.
 *
 * Run: node --import @oxc-node/core/register benchmark/stream-benchmark-browser.ts
 */
import { Readable, Writable, Transform, pipeline } from "stream";
import { promisify } from "util";

import {
  createReadableFromArray as browserCreateReadableFromArray,
  createTransform as browserCreateTransform,
  createCollector as browserCreateCollector,
  pipeline as browserPipeline
} from "../src/modules/stream/index.browser";
import { EventEmitter as BrowserEmitter } from "../src/utils/event-emitter";

const pipelineAsync = promisify(pipeline);

// Test data
const ITERATIONS = 50;
const CHUNK_COUNT = 10000;
const CHUNK_SIZE = 1024;

function createTestChunks(count: number, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const arr = new Uint8Array(size);
    arr.fill(i % 256);
    chunks.push(arr);
  }
  return chunks;
}

// Benchmark: Native Node.js streams
async function benchmarkNative(chunks: Uint8Array[]): Promise<number> {
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

  const collected: Uint8Array[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      collected.push(chunk);
      cb();
    }
  });

  await pipelineAsync(readable, transform, writable);

  return performance.now() - start;
}

// Benchmark: Browser streams
async function benchmarkBrowser(chunks: Uint8Array[]): Promise<number> {
  const start = performance.now();

  const readable = browserCreateReadableFromArray(chunks, { objectMode: false });

  const transform = browserCreateTransform<Uint8Array, Uint8Array>(chunk => chunk, {
    objectMode: false
  });

  const collector = browserCreateCollector<Uint8Array>({ objectMode: false });

  await browserPipeline(readable, transform, collector);

  return performance.now() - start;
}

// Benchmark: EventEmitter overhead
async function benchmarkEventEmitter(): Promise<{ native: number; browser: number }> {
  const { EventEmitter } = await import("events");

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

  return { native: nativeTime, browser: browserTime };
}

// Main benchmark
async function main() {
  console.log("=".repeat(60));
  console.log("Browser Stream vs Native Node.js Benchmark");
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
  await benchmarkBrowser(chunks);

  // Benchmark
  console.log("Running benchmarks...\n");

  const nativeTimes: number[] = [];
  const browserTimes: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    nativeTimes.push(await benchmarkNative(chunks));
    browserTimes.push(await benchmarkBrowser(chunks));
  }

  const avgNative = nativeTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
  const avgBrowser = browserTimes.reduce((a, b) => a + b, 0) / ITERATIONS;

  console.log("Pipeline (Readable → Transform → Writable):");
  console.log("-".repeat(40));
  console.log(`Native Node.js:     ${avgNative.toFixed(2)} ms avg`);
  console.log(`Browser streams.ts: ${avgBrowser.toFixed(2)} ms avg`);
  const overhead = (avgBrowser / avgNative - 1) * 100;
  console.log(`Difference:         ${overhead > 0 ? "+" : ""}${overhead.toFixed(1)}%`);
  console.log("");

  // EventEmitter benchmark
  console.log("EventEmitter (100k emits):");
  console.log("-".repeat(40));
  const emitterResult = await benchmarkEventEmitter();
  console.log(`Native EventEmitter:  ${emitterResult.native.toFixed(2)} ms`);
  console.log(`Browser EventEmitter: ${emitterResult.browser.toFixed(2)} ms`);
  const emitterOverhead = (emitterResult.browser / emitterResult.native - 1) * 100;
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
  const throughputBrowser =
    (CHUNK_COUNT * CHUNK_SIZE * ITERATIONS) /
    (browserTimes.reduce((a, b) => a + b, 0) / 1000) /
    1024 /
    1024;

  console.log("Throughput:");
  console.log("-".repeat(40));
  console.log(`Native Node.js:     ${throughputNative.toFixed(0)} MB/s`);
  console.log(`Browser streams.ts: ${throughputBrowser.toFixed(0)} MB/s`);
  console.log("");
  console.log("=".repeat(60));
  console.log("");
  console.log("Summary:");
  if (Math.abs(overhead) < 10) {
    console.log("✅ Browser streams has excellent performance (within 10% of native)!");
  } else if (overhead < 30) {
    console.log("✅ Browser streams has good performance (~" + overhead.toFixed(0) + "% overhead)");
  } else if (overhead < 100) {
    console.log("⚠️  Browser streams has moderate overhead (~" + overhead.toFixed(0) + "%)");
  } else {
    console.log("❌ Browser streams has significant overhead (~" + overhead.toFixed(0) + "%)");
  }
  console.log("");
  console.log("Note: Browser streams use Web Streams API internally,");
  console.log("which adds overhead but provides cross-platform compatibility.");
}

main().catch(console.error);
