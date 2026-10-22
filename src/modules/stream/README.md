# Stream Module

[中文](README_zh.md)

Node.js stream classes and helpers that run unchanged in Node.js and in browsers.

- **Node.js**: the native `node:stream` classes — `Readable`, `Writable`, `Duplex`, `Transform`
  and `PassThrough` are Node's own, and `pipeline`, `compose` and `duplexPair` call Node's for
  Node-style stages.
- **Browser**: a port of Node's `lib/internal/streams`, so the same code keeps the same
  backpressure, event order and teardown.

Web Streams (`ReadableStream`, `WritableStream`, `TransformStream`) are accepted wherever a stream
is, on both. Convert them with `readableFromWeb` / `readableToWeb` / `writableFromWeb` /
`writableToWeb`, which behave the same on Node.js, Bun and browsers; the classes' own
`Readable.fromWeb` and friends keep Node's behaviour, defects included (see
[Converting between Node-style and Web streams](#converting-between-node-style-and-web-streams)).

```typescript
import { Readable, pipeline, createTransform } from "documonster/stream";
```

## Features

- **Cross-Platform** - Same API and behaviour in Node.js and browsers; the shared test suite runs against both
- **Single Entry Point** - Auto-resolves to correct implementation based on environment
- **Type-Safe** - Full TypeScript support with consistent types
- **Node.js Compatible API** - Familiar `Readable`, `Writable`, `Transform`, `Duplex` classes
- **Native where it exists** - Node's implementation on Node; Web Streams are read and written through their own readers and writers

## Installation

The stream module is part of Documonster. Import from the subpath:

```typescript
import {
  Readable,
  Writable,
  Transform,
  Duplex,
  pipeline,
  finished,
  createTransform,
  createCollector
} from "documonster/stream";
```

## Quick Start

```typescript
import {
  createReadableFromArray,
  createTransform,
  createCollector,
  pipeline
} from "documonster/stream";

// Create a pipeline that doubles numbers
const source = createReadableFromArray([1, 2, 3, 4, 5], { objectMode: true });
const double = createTransform<number, number>(n => n * 2, { objectMode: true });
const collector = createCollector<number>({ objectMode: true });

await pipeline(source, double, collector);
console.log(collector.chunks); // [2, 4, 6, 8, 10]
```

---

## Core Classes

### EventEmitter

Browser-compatible EventEmitter with Node.js-like API.

```typescript
// NOTE: EventEmitter is not exported by documonster/stream. The stream classes
// (Readable/Writable/Transform/Duplex) already provide the on/once/off/emit API.
// If you need a standalone emitter, import it from Node.js:
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();

// Add listener
emitter.on("data", chunk => console.log(chunk));

// Add one-time listener
emitter.once("end", () => console.log("Stream ended"));

// Remove listener
emitter.off("data", listener);

// Emit event
emitter.emit("data", "Hello World");

// Get listener count
emitter.listenerCount("data"); // => 1

// Get all event names
emitter.eventNames(); // => ["data", "end"]

// Set max listeners (0 = unlimited)
emitter.setMaxListeners(20);

// Prepend listener to beginning
emitter.prependListener("data", listener);

// Remove all listeners
emitter.removeAllListeners("data");
```

---

### Readable

A readable stream for consuming data.

```typescript
import { Readable, createReadableFromArray } from "documonster/stream";

// Create from array
const readable = createReadableFromArray([1, 2, 3], { objectMode: true });

// Using async iteration (recommended)
for await (const chunk of readable) {
  console.log(chunk);
}

// Using events
readable.on("data", chunk => console.log(chunk));
readable.on("end", () => console.log("Done"));
readable.on("error", err => console.error(err));

// Create with custom read function
const custom = new Readable({
  objectMode: true,
  read() {
    this.push({ id: 1 });
    this.push({ id: 2 });
    this.push(null); // Signal end of stream
  }
});

// Pause and resume
readable.pause();
readable.resume();

// Pipe to writable
readable.pipe(writable);

// Unpipe
readable.unpipe(writable);
```

**Key Properties:**

- `readable.readable` - Whether the stream is readable
- `readable.readableEnded` - Whether the stream has ended
- `readable.readableFlowing` - Flow state (null, true, false)
- `readable.readableLength` - Bytes/objects in internal buffer
- `readable.destroyed` - Whether destroyed

---

### Writable

A writable stream for outputting data.

```typescript
import { Writable } from "documonster/stream";

const writable = new Writable({
  objectMode: true,
  write(chunk, encoding, callback) {
    console.log("Received:", chunk);
    callback(); // Signal completion (call with error on failure)
  },
  final(callback) {
    console.log("Finalizing...");
    callback();
  }
});

// Write data
writable.write({ data: "hello" });
writable.write({ data: "world" });

// End the stream
writable.end();

// Events
writable.on("finish", () => console.log("All data written"));
writable.on("drain", () => console.log("Buffer drained, can write more"));
writable.on("error", err => console.error(err));

// Check if write was buffered (backpressure)
const canContinue = writable.write(data);
if (!canContinue) {
  // Wait for drain before writing more
  writable.once("drain", () => continueWriting());
}

// Cork/uncork for batching writes
writable.cork();
writable.write(chunk1);
writable.write(chunk2);
writable.uncork(); // Flush all at once
```

**Key Properties:**

- `writable.writable` - Whether the stream is writable
- `writable.writableEnded` - Whether `end()` has been called
- `writable.writableFinished` - Whether the stream has finished
- `writable.writableLength` - Bytes/objects in buffer
- `writable.writableHighWaterMark` - High water mark
- `writable.destroyed` - Whether destroyed

---

### Transform

A duplex stream that transforms data as it passes through.

```typescript
import { Transform, createTransform } from "documonster/stream";

// Simple transform with factory function (recommended)
const double = createTransform<number, number>(n => n * 2, { objectMode: true });

// Using class constructor
const uppercase = new Transform({
  transform(chunk, encoding, callback) {
    const result = chunk.toString().toUpperCase();
    callback(null, result);
  }
});

// Async transform function
const asyncTransform = createTransform<string, string>(
  async chunk => {
    await delay(100);
    return chunk.toUpperCase();
  },
  { objectMode: true }
);

// With flush (called when input ends, before output ends)
const withFlush = new Transform({
  objectMode: true,
  transform(chunk, encoding, callback) {
    this.push(chunk);
    callback();
  },
  flush(callback) {
    this.push("final chunk from flush");
    callback();
  }
});

// Node.js style using this.push()
const nodeStyle = new Transform({
  objectMode: true,
  transform(chunk, encoding, callback) {
    // Push multiple outputs for one input
    this.push(chunk);
    this.push(chunk * 2);
    callback(); // No second argument when using push()
  }
});
```

---

### Duplex

A stream that is both readable and writable independently.

```typescript
import { Duplex, createDuplex, duplexPair } from "documonster/stream";

// Create duplex stream
const duplex = createDuplex({
  objectMode: true,
  read() {
    this.push("data from readable side");
    this.push(null);
  },
  write(chunk, encoding, callback) {
    console.log("Writable received:", chunk);
    callback();
  }
});

// Create connected pair (useful for testing bidirectional communication)
const [client, server] = duplexPair({ objectMode: true });

// Data written to client appears on server's readable side
client.write("Hello from client");
server.on("data", data => console.log("Server received:", data));

// Data written to server appears on client's readable side
server.write("Hello from server");
client.on("data", data => console.log("Client received:", data));
```

---

## Specialized Streams

### Collector

Collects all data from a stream into an array.

```typescript
import { createCollector, pipeline, finished } from "documonster/stream";

// Collect objects
const collector = createCollector<number>({ objectMode: true });
collector.write(1);
collector.write(2);
collector.write(3);
collector.end();

await finished(collector);
console.log(collector.chunks); // [1, 2, 3]

// Use in pipeline
const source = createReadableFromArray(["a", "b", "c"], { objectMode: true });
const collector2 = createCollector<string>({ objectMode: true });

await pipeline(source, collector2);
console.log(collector2.chunks); // ["a", "b", "c"]

// Collect binary data and convert
const binaryCollector = createCollector<Uint8Array>();
binaryCollector.write(new Uint8Array([1, 2, 3]));
binaryCollector.write(new Uint8Array([4, 5, 6]));
binaryCollector.end();

await finished(binaryCollector);
const bytes = binaryCollector.toUint8Array(); // Uint8Array [1, 2, 3, 4, 5, 6]
const text = binaryCollector.toString(); // Decode as UTF-8 string
```

---

### PullStream

A transform stream with pull-based reading and pattern matching. Useful for parsing protocols and file formats.

```typescript
import { createPullStream } from "documonster/stream";

const pull = createPullStream();

// Write data
pull.write(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHello"));
pull.end();

// Pull until pattern (e.g., read HTTP status line)
const statusLine = await pull.pullUntil(Buffer.from("\r\n"));
console.log(statusLine.toString()); // "HTTP/1.1 200 OK"

// Pull until pattern, including the pattern in result
const headerWithNewline = await pull.pullUntil(Buffer.from("\r\n"), true);

// Pull exact number of bytes (e.g., read body based on Content-Length)
const body = await pull.pull(5);
console.log(body.toString()); // "Hello"

// Check remaining buffer length
console.log(pull.length);

// Check if stream is finished (no more input)
console.log(pull.isFinished);

// Get last match position
console.log(pull.matchPosition);
```

**Pattern Matching:**

```typescript
const pull = createPullStream();
pull.write(Buffer.from("key1=value1&key2=value2"));
pull.end();

// Parse key-value pairs
const key1 = await pull.pullUntil(Buffer.from("=")); // "key1"
const val1 = await pull.pullUntil(Buffer.from("&")); // "value1"
const key2 = await pull.pullUntil(Buffer.from("=")); // "key2"
const val2 = await pull.pull(Infinity); // "value2" (rest of stream)
```

---

### BufferedStream

Duplex stream with efficient internal buffering.

```typescript
import { createBufferedStream, BufferedStream } from "documonster/stream";

const buffered = createBufferedStream();

// Write various data types
buffered.write("Hello ");
buffered.write("World");
buffered.write(new Uint8Array([33])); // "!"

// Check buffer state
console.log(buffered.bufferedLength); // 12

// Get all data
console.log(buffered.toString()); // "Hello World!"
console.log(buffered.toUint8Array()); // Uint8Array

// Check state
console.log(buffered.isFinished);
```

---

### ChunkedBuilder

Efficient string builder with Uint8Array output. Useful for building large strings/XML/JSON efficiently.

```typescript
import { ChunkedBuilder } from "documonster/stream";

const builder = new ChunkedBuilder();

// Push strings
builder.push("<xml>");
builder.push("<item>Hello</item>");
builder.push("<item>World</item>");
builder.push("</xml>");

// Check state
console.log(builder.length); // Total byte length
console.log(builder.cursor); // Current position

// Get output
const result = builder.toUint8Array();
console.log(builder.toString()); // "<xml><item>Hello</item><item>World</item></xml>"
```

---

### TransactionalChunkedBuilder

ChunkedBuilder with snapshot/rollback support. Useful for speculative parsing where you might need to backtrack.

```typescript
import { TransactionalChunkedBuilder } from "documonster/stream";

const builder = new TransactionalChunkedBuilder();

builder.push("header");

// Save state
builder.snapshot();

// Try something
builder.push("-tentative");
console.log(builder.toString()); // "header-tentative"

// Oops, that didn't work - rollback
builder.rollback();
console.log(builder.toString()); // "header"

// Try something else
builder.push("-correct");

// Confirm changes
builder.commit();
console.log(builder.toString()); // "header-correct"

// Nested snapshots
builder.snapshot(); // Level 1
builder.push("A");
builder.snapshot(); // Level 2
builder.push("B");
builder.rollback(); // Back to level 1 (removes "B")
builder.commit(); // Confirm level 1
```

---

## Pipeline & Utilities

### pipeline

Pipe streams together with proper error handling and cleanup. Returns a promise.

```typescript
import {
  pipeline,
  createReadableFromArray,
  createTransform,
  createCollector
} from "documonster/stream";

const source = createReadableFromArray([1, 2, 3, 4, 5], { objectMode: true });
const filter = createTransform<number, number>(
  n => (n % 2 === 0 ? n : undefined), // undefined = skip
  { objectMode: true }
);
const double = createTransform<number, number>(n => n * 2, { objectMode: true });
const collector = createCollector<number>({ objectMode: true });

// Chain multiple streams
await pipeline(source, filter, double, collector);

console.log(collector.chunks); // [4, 8] (2*2=4, 4*2=8)

// Error handling
try {
  await pipeline(source, badTransform, collector);
} catch (err) {
  console.error("Pipeline failed:", err.message);
}
```

---

### finished

Wait for a stream to finish (end, close, or error).

```typescript
import { finished, createReadableFromArray } from "documonster/stream";

const readable = createReadableFromArray([1, 2, 3], { objectMode: true });

// Consume data
readable.on("data", chunk => console.log(chunk));

// Wait for stream to complete
await finished(readable);
console.log("Stream completed");

// Also works with writables
const writable = createCollector();
writable.write("data");
writable.end();
await finished(writable);
```

---

### compose

Combine stages into one `Duplex`: writes go into the first, reads come out of the last. Stages are
what `pipeline` takes — Node-style streams, Web streams, generator functions, iterables — and the
rules are Node's: no stage throws `ERR_MISSING_ARGS`, a single stage becomes `Duplex.from(stage)`.
`compose<In, Out>(…)` types what is written and read — a statement by the caller, not checked
against the stages, just as Node's `compose` checks nothing; the result is the entry's own `Duplex`, so
on Node it goes wherever `node:stream`'s `compose` result goes.

```typescript
import { compose, createTransform, createReadableFromArray, pipeline } from "documonster/stream";

const addOne = createTransform<number, number>(n => n + 1, { objectMode: true });
const double = createTransform<number, number>(n => n * 2, { objectMode: true });
const square = createTransform<number, number>(n => n * n, { objectMode: true });

// Combine into single transform: (n + 1) * 2, then square
const combined = compose(addOne, double, square);

const source = createReadableFromArray([1, 2, 3], { objectMode: true });
const collector = createCollector<number>({ objectMode: true });

await pipeline(source, combined, collector);
console.log(collector.chunks); // [16, 36, 64]
// 1: (1+1)*2=4, 4²=16
// 2: (2+1)*2=6, 6²=36
// 3: (3+1)*2=8, 8²=64
```

---

### finishedAll

Wait for multiple streams to finish.

```typescript
import { finishedAll, createReadableFromArray } from "documonster/stream";

const stream1 = createReadableFromArray([1, 2, 3], { objectMode: true });
const stream2 = createReadableFromArray([4, 5, 6], { objectMode: true });

// Start consuming
stream1.on("data", () => {});
stream2.on("data", () => {});

// Wait for both to finish
await finishedAll([stream1, stream2]);
console.log("All streams completed");
```

---

### addAbortSignal

Add abort signal handling to any stream.

```typescript
import { addAbortSignal, createReadableFromArray, finished } from "documonster/stream";

const controller = new AbortController();
const readable = createReadableFromArray([1, 2, 3], { objectMode: true });

// Attach abort signal
addAbortSignal(controller.signal, readable);

// Start consuming
readable.on("data", chunk => {
  console.log(chunk);
  if (chunk === 2) {
    controller.abort(); // Abort after receiving 2
  }
});

try {
  await finished(readable);
} catch (err) {
  console.log("Stream aborted:", err.message);
}
```

---

## Factory Functions

### createReadableFromArray

Create a readable stream from an array.

```typescript
import { createReadableFromArray } from "documonster/stream";

// Object mode (for non-binary data)
const objectStream = createReadableFromArray([{ a: 1 }, { b: 2 }], { objectMode: true });

// Binary mode
const binaryStream = createReadableFromArray([
  new Uint8Array([1, 2, 3]),
  new Uint8Array([4, 5, 6])
]);
```

---

### createReadableFromAsyncIterable

Create a readable stream from an async iterable.

```typescript
import { createReadableFromAsyncIterable } from "documonster/stream";

async function* generateNumbers() {
  for (let i = 1; i <= 5; i++) {
    await delay(100);
    yield i;
  }
}

const readable = createReadableFromAsyncIterable(generateNumbers());

for await (const n of readable) {
  console.log(n); // 1, 2, 3, 4, 5
}
```

---

### createReadableFromGenerator

Create a readable stream from a generator function.

```typescript
import { createReadableFromGenerator } from "documonster/stream";

const readable = createReadableFromGenerator(async function* () {
  yield await fetch("/api/part1").then(r => r.json());
  yield await fetch("/api/part2").then(r => r.json());
  yield await fetch("/api/part3").then(r => r.json());
});
```

---

### createReadableFromPromise

Create a readable stream from a promise (emits single value).

```typescript
import { createReadableFromPromise } from "documonster/stream";

const readable = createReadableFromPromise(
  fetch("/api/data").then(r => r.json()),
  { objectMode: true }
);

for await (const data of readable) {
  console.log(data); // Single JSON object
}
```

---

### createEmptyReadable

Create a readable that immediately ends with no data.

```typescript
import { createEmptyReadable, pipeline } from "documonster/stream";

const empty = createEmptyReadable();
// Useful for conditional pipelines or testing
```

---

### createNullWritable

Create a writable that discards all data (like `/dev/null`).

```typescript
import { createNullWritable, pipeline } from "documonster/stream";

const devNull = createNullWritable();

// Drain a stream without collecting data
await pipeline(source, devNull);
```

---

## Stream Consumers

Utility functions for consuming entire streams.

```typescript
import { consumers, createReadableFromArray } from "documonster/stream";

const readable = createReadableFromArray([
  new Uint8Array([123, 34, 110, 97, 109, 101, 34, 58, 34, 116, 101, 115, 116, 34, 125])
]);

// Read as text
const text = await consumers.text(readable);
// '{"name":"test"}'

// Read as JSON (parses the text)
const json = await consumers.json(readable);
// { name: "test" }

// Read as Uint8Array
const bytes = await consumers.buffer(readable);
// Uint8Array(15)

// Read as ArrayBuffer
const arrayBuffer = await consumers.arrayBuffer(readable);
// ArrayBuffer(15)
```

---

## Type Guards

```typescript
import { isReadable, isWritable, isTransform, isDuplex, isStream } from "documonster/stream";

// Check stream types
isReadable(stream); // true if readable stream
isWritable(stream); // true if writable stream
isTransform(stream); // true if transform stream
isDuplex(stream); // true if duplex stream
isStream(stream); // true if any stream type

// Usage
async function processStream(input: unknown) {
  if (isReadable(input)) {
    // TypeScript knows input is Readable here
    for await (const chunk of input) {
      // ...
    }
  }
}
```

---

## Stream State Inspection

```typescript
import { isDestroyed, isDisturbed, isErrored } from "documonster/stream";

// Check if stream has been destroyed
isDestroyed(stream); // true if destroy() was called

// Check if readable has been read from (data consumed)
isDisturbed(readable); // true if data event emitted or pipe called

// Check if stream has errored
isErrored(stream); // true if error occurred
```

---

## Binary Utilities

These helpers exist inside the library but are **not** part of any published entry point —
`stringToUint8Array`, `uint8ArrayToString`, `concatUint8Arrays`, `uint8ArrayEquals` and
`uint8ArrayIndexOf` all live in the internal `utils/` layer, which is deliberately never
exported. They are thin wrappers over platform built-ins, so use those directly:

```typescript
// String <-> Uint8Array conversion (UTF-8)
const bytes = new TextEncoder().encode("Hello, 世界!");
const text = new TextDecoder().decode(bytes);

// Other encodings, where the runtime supports them
const latin1 = new TextDecoder("latin1").decode(bytes);

// Concatenate multiple arrays
const total = arrays.reduce((n, a) => n + a.length, 0);
const combined = new Uint8Array(total);
let offset = 0;
for (const a of arrays) {
  combined.set(a, offset);
  offset += a.length;
}
```

---

## Promise Utilities

### onceEvent

Wait for a single event from an emitter.

```typescript
import { onceEvent } from "documonster/stream";

// Wait for a single event (resolves to void when the event fires)
await onceEvent(emitter, "data");
console.log("data event fired");

// NOTE: onceEvent takes only (emitter, event) and returns Promise<void>.
// It does not accept an AbortSignal and does not resolve with event arguments.
// For Node's argument-returning `once` with { signal }, import from node:events:
//   import { once } from "node:events";
```

---

### promisify

Convert callback-style function to promise.

```typescript
import { promisify } from "documonster/stream";

// Callback-style function
function fetchData(callback: (err: Error | null, data?: string) => void) {
  setTimeout(() => callback(null, "result"), 100);
}

// Convert to promise
const fetchDataAsync = promisify(fetchData);
const data = await fetchDataAsync();
```

---

### promises API

Promise-based versions of pipeline and finished.

```typescript
import { promises } from "documonster/stream";

// Same as regular pipeline/finished but explicitly promise-based
await promises.pipeline(source, transform, destination);
await promises.finished(stream);
```

---

## High Water Mark

Control stream buffering behavior.

```typescript
import {
  Readable,
  Writable,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark
} from "documonster/stream";

// Get defaults
getDefaultHighWaterMark(false); // 65536 (64KB for byte streams; 16384 under Node on Windows)
getDefaultHighWaterMark(true); // 16 (16 objects for object mode)

// Change the default for every stream created afterwards — the classes' and the factories'
// alike. As in Node, the value must be a non-negative integer: anything else throws
// ERR_INVALID_ARG_TYPE or ERR_OUT_OF_RANGE. Pass `highWaterMark` explicitly where a
// threshold must be the same on every platform.
setDefaultHighWaterMark(false, 128 * 1024);

// Set custom high water mark per stream
const readable = new Readable({
  highWaterMark: 32768, // 32KB buffer
  read() {
    /* ... */
  }
});

const writable = new Writable({
  highWaterMark: 64, // 64 objects in object mode
  objectMode: true,
  write(chunk, enc, cb) {
    cb();
  }
});
```

---

## Error Handling

```typescript
import { pipeline, createTransform, createReadableFromArray } from "documonster/stream";

// Error in transform function
const badTransform = createTransform(
  chunk => {
    if (chunk === "bad") {
      throw new Error("Invalid data");
    }
    return chunk;
  },
  { objectMode: true }
);

// Pipeline catches and propagates errors
try {
  await pipeline(source, badTransform, destination);
} catch (err) {
  console.error("Pipeline failed:", err.message);
}

// Event-based error handling
badTransform.on("error", err => {
  console.error("Transform error:", err);
  // Stream is automatically destroyed on error
});

// Manual stream destruction
stream.destroy(new Error("Manual destruction"));
```

---

## Browser Compatibility

The browser implementation is plain JavaScript over `queueMicrotask`, `TextDecoder` and Web
Streams, and is compatible with:

| Browser | Minimum Version |
| ------- | --------------- |
| Chrome  | 89+             |
| Firefox | 102+            |
| Safari  | 14.1+           |
| Edge    | 89+             |

Floors for this module only; the package as a whole is higher — see the
[root README](../../../README.md#requirements).

The API is **identical** between Node.js and browsers, allowing you to write code once and run anywhere.

---

## Performance

- **Node.js**: Uses native stream module with zero overhead (identical performance to `require('stream')`)
- **Browser**: the same algorithms as Node's implementation, so buffering and backpressure behave alike

### Performance Tips

1. **Use object mode** for non-binary data to avoid encoding overhead
2. **Prefer pipeline** over manual piping for proper error handling and cleanup
3. **Use appropriate highWaterMark** based on your data size
4. **Avoid unnecessary transforms** - combine operations when possible
5. **Use async iteration** (`for await...of`) for cleaner code

---

## Examples

### CSV Processing

```typescript
import {
  createReadableFromArray,
  createTransform,
  createCollector,
  pipeline
} from "documonster/stream";

interface Person {
  name: string;
  age: number;
}

const data: Person[] = [
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
  { name: "Charlie", age: 35 }
];

const source = createReadableFromArray(data, { objectMode: true });

const toCsv = createTransform<Person, string>(row => `${row.name},${row.age}\n`, {
  objectMode: true
});

const collector = createCollector<string>({ objectMode: true });

await pipeline(source, toCsv, collector);
console.log(collector.chunks.join(""));
// "Alice,30\nBob,25\nCharlie,35\n"
```

---

### Data Filtering and Transformation

```typescript
const numbers = createReadableFromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { objectMode: true });

const filterEven = createTransform<number, number>(
  n => (n % 2 === 0 ? n : undefined), // undefined skips
  { objectMode: true }
);

const square = createTransform<number, number>(n => n * n, { objectMode: true });

const collector = createCollector<number>({ objectMode: true });

await pipeline(numbers, filterEven, square, collector);
console.log(collector.chunks); // [4, 16, 36, 64, 100]
```

---

### Async Data Processing

```typescript
const urls = createReadableFromArray(
  [
    "https://api.example.com/users/1",
    "https://api.example.com/users/2",
    "https://api.example.com/users/3"
  ],
  { objectMode: true }
);

const fetchData = createTransform<string, object>(
  async url => {
    const response = await fetch(url);
    return response.json();
  },
  { objectMode: true }
);

const collector = createCollector<object>({ objectMode: true });

await pipeline(urls, fetchData, collector);
console.log(collector.chunks); // Array of user objects
```

---

### Protocol Parsing with PullStream

```typescript
import { createPullStream } from "documonster/stream";

// Parse a simple protocol: LENGTH:DATA
const pull = createPullStream();
pull.write(Buffer.from("5:Hello3:World"));
pull.end();

async function parseMessages() {
  const messages: string[] = [];

  while (!pull.isFinished || pull.length > 0) {
    // Read length (until colon)
    const lengthBuf = await pull.pullUntil(Buffer.from(":"));
    if (lengthBuf.length === 0) break;

    const length = parseInt(lengthBuf.toString(), 10);

    // Read exactly that many bytes
    const data = await pull.pull(length);
    messages.push(data.toString());
  }

  return messages;
}

const messages = await parseMessages();
console.log(messages); // ["Hello", "World"]
```

---

### File Processing (Node.js)

```typescript
import { createReadStream, createWriteStream } from "fs";
import { pipeline, createTransform } from "documonster/stream";

// Transform file content to uppercase
const uppercase = createTransform<Buffer, Buffer>(chunk =>
  Buffer.from(chunk.toString().toUpperCase())
);

await pipeline(createReadStream("input.txt"), uppercase, createWriteStream("output.txt"));
```

---

### Fetch API Integration (Browser)

```typescript
import { readableFromWeb, pipeline, createCollector } from "documonster/stream";

// Fetch and process response
const response = await fetch("/api/large-data");

// Convert the Web ReadableStream to a Node-style Readable (or pass `response.body` to
// `pipeline` directly — it accepts Web streams as they are)
const readable = readableFromWeb(response.body!);

const collector = createCollector<Uint8Array>();

await pipeline(readable, collector);
const data = collector.toUint8Array();
```

---

## API Reference

### Classes

| Class                         | Description                             |
| ----------------------------- | --------------------------------------- |
| `Readable`                    | Readable stream class                   |
| `Writable`                    | Writable stream class                   |
| `Transform`                   | Transform stream class                  |
| `Duplex`                      | Duplex stream class                     |
| `PassThrough`                 | Pass-through transform (no-op)          |
| `Collector`                   | Collects stream data into array         |
| `PullStream`                  | Pull-based stream with pattern matching |
| `BufferedStream`              | Stream with internal buffering          |
| `ChunkedBuilder`              | Efficient string builder                |
| `TransactionalChunkedBuilder` | Builder with snapshot/rollback          |
| `createStringChunk()`         | String data chunk factory               |
| `createByteChunk()`           | Binary data chunk factory               |

### Factory Functions

| Function                            | Description                         |
| ----------------------------------- | ----------------------------------- |
| `createReadable()`                  | Create readable with custom options |
| `createReadableFromArray()`         | Create readable from array          |
| `createReadableFromAsyncIterable()` | Create readable from async iterable |
| `createReadableFromGenerator()`     | Create readable from generator      |
| `createReadableFromPromise()`       | Create readable from promise        |
| `createEmptyReadable()`             | Create empty readable               |
| `createWritable()`                  | Create writable with custom options |
| `createNullWritable()`              | Create writable that discards data  |
| `createTransform()`                 | Create transform with function      |
| `createDuplex()`                    | Create duplex stream                |
| `createPassThrough()`               | Create pass-through transform       |
| `createCollector()`                 | Create data collector               |
| `createPullStream()`                | Create pull stream                  |
| `createBufferedStream()`            | Create buffered stream              |
| `duplexPair()`                      | Create connected duplex pair        |

### Utility Functions

| Function               | Description                               |
| ---------------------- | ----------------------------------------- |
| `pipeline()`           | Pipe streams with error handling          |
| `finished()`           | Wait for stream to finish                 |
| `compose()`            | Compose multiple transforms               |
| `finishedAll()`        | Wait for multiple streams                 |
| `addAbortSignal()`     | Add abort signal to stream                |
| `onceEvent()`          | Wait for a single event; resolves to void |
| `promisify()`          | Convert callback to promise               |
| `streamToUint8Array()` | Collect stream to Uint8Array              |
| `streamToString()`     | Collect stream to string                  |
| `drainStream()`        | Consume stream without collecting         |
| `copyStream()`         | Copy source to destination                |

### Binary Utilities

These helpers are re-exported from `documonster/archive` (not `documonster/stream`).

| Function               | Description             |
| ---------------------- | ----------------------- |
| `stringToUint8Array()` | Convert string to bytes |
| `uint8ArrayToString()` | Convert bytes to string |
| `concatUint8Arrays()`  | Concatenate arrays      |

### Type Guards

| Function        | Returns true if      |
| --------------- | -------------------- |
| `isReadable()`  | Readable stream      |
| `isWritable()`  | Writable stream      |
| `isTransform()` | Transform stream     |
| `isDuplex()`    | Duplex stream        |
| `isStream()`    | Any stream type      |
| `isDestroyed()` | Stream is destroyed  |
| `isDisturbed()` | Stream has been read |
| `isErrored()`   | Stream has errored   |

---

## Platform Differences (Inherent)

The API and its types are the same on Node.js, Bun and the browser. The differences below remain
because the browser's standard APIs cannot express what Node does, without giving up something
Node offers (or, for `instanceof`, without redefining what it means):

| Aspect                                  | Node.js                                                                                             | Browser                                                                                                                          | Impact                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Binary chunk type**                   | `Buffer` (subclass of `Uint8Array` with `.toString('hex')`, `.toString('base64')`, `.copy()`, etc.) | `Uint8Array` (a chunk pushed as a string keeps `.toString(encoding)`)                                                            | Code using `Buffer`-specific methods will not work cross-platform. Use `Uint8Array` utilities from this module instead.                                                                                                                                                                                                                                             |
| **Event scheduling**                    | `process.nextTick`                                                                                  | One microtask drains every tick queued meanwhile, in order                                                                       | The order of a stream's own events and callbacks matches Node, and so does a tick's placement when queued from a task (event handler, timer, I/O). Queued from inside a promise continuation, Node runs it only once the whole microtask queue is empty; no browser primitive can, so it runs earlier. Both measured in `__tests__/stream-scheduling.node.test.ts`. |
| **`_readableState` / `_writableState`** | Node's internal state objects                                                                       | The same field names, but a different object                                                                                     | Internal: use the public getters (`readableLength`, `writableNeedDrain`, …).                                                                                                                                                                                                                                                                                        |
| **`isDisturbed(webStream)`**            | Answered by Node's own Web Streams                                                                  | Exact for an unlocked stream (probed through `new Response(stream)`, which neither locks nor reads it); `false` for a locked one | For a locked stream the true answer is "unknown": one that was read cannot be told from one that was not, so `false` there means "not known to be disturbed".                                                                                                                                                                                                       |
| **`instanceof` a stream class**         | `true` for every `node:stream` stream, whoever made it                                              | `true` only for streams made by this module's classes                                                                            | Streams from elsewhere (`readable-stream`, another library) are still recognised and driven by every function here, which checks the stream protocol rather than the class, as Node does. Test with `isReadable` / `isWritable` / `isStream`, not `instanceof`.                                                                                                     |
| **`finished(webStream)`**               | Any Web stream                                                                                      | Not supported: rejects at once, without locking the stream                                                                       | The standard API has no lock-free completion signal, and a Web stream's queue is only known to be drained by the reader that drains it. Await your reader's or writer's `closed` promise.                                                                                                                                                                           |

### Converting between Node-style and Web streams

Use the module's own conversions; they behave the same on both entries:

```ts
import { readableFromWeb, readableToWeb, writableFromWeb, writableToWeb } from "documonster/stream";

const nodeStyle = readableFromWeb(response.body!);
const web = writableToWeb(nodeStyleWritable);
```

The class statics (`Readable.fromWeb`, `Writable.toWeb`, `Duplex.fromWeb`, …) are Node's on
**both** entries — `node:stream`'s own on the Node entry, a faithful port in the browser — so code
written against them behaves the same everywhere, defects included. As of Node 26 five of their
behaviours are wrong, and the module's functions above fix all five, identically on both entries:

| Class static (Node's behaviour)                                                                                    | Module function                                       |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `Readable.fromWeb` pushes a `null` read, which ends the stream and silently drops the rest                         | `readableFromWeb` fails with `ERR_STREAM_NULL_VALUES` |
| `Readable.fromWeb` / `Writable.fromWeb` / `Duplex.fromWeb` keep the Web stream locked for good                     | the lock is handed back once the adapter is done      |
| `Writable.toWeb(w)` while `w.writableNeedDrain`: the next Web write resolves without reaching `w.write()`          | the chunk is written, then the write waits for drain  |
| `Readable.toWeb(r)` after `r.setEncoding(...)`: once strings queue, `RangeError` is thrown from `'data'`, uncaught | strings are sized in characters                       |
| `Readable.toWeb` / `Writable.toWeb` leave their `'data'` / `'drain'` listener on the source once done              | the listener is removed                               |

`pipeline` and `compose` read and write Web streams themselves, and `toWritable` goes through
`writableFromWeb`, so none of them shares these defects, on either entry.

On Bun the Node entry's classes are Bun's own `node:stream`, so their statics are Bun's: Bun 1.4,
for one, releases `Readable.fromWeb`'s lock once the stream ends, where Node keeps it. The module's
functions are the only Web conversions that behave identically on Node, Bun and the browser.

A `null` cannot be carried by a Node-style stream at all — `push(null)` means end in every mode —
so to send one through, wrap it on the Web side (`{ value: null }`).

## Maintenance: upstream baseline

`src/modules/stream/kernel/` is a port of Node.js **v26.8.1**. When Node fixes a stream bug,
compare against these files rather than rediscovering the behaviour:

| Node.js file                                                       | Port                                           |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| `lib/internal/streams/readable.js`                                 | `readable-impl.ts`, `Readable` in `classes.ts` |
| `lib/internal/streams/writable.js`                                 | `writable.ts`                                  |
| `lib/internal/streams/duplex.js`, `transform.js`, `passthrough.js` | `classes.ts`                                   |
| `lib/internal/streams/destroy.js`                                  | `destroy.ts`                                   |
| `lib/internal/streams/end-of-stream.js`                            | `end-of-stream.ts`                             |
| `lib/internal/streams/from.js`                                     | `from.ts`                                      |
| `lib/internal/streams/operators.js`                                | `operators.ts`                                 |
| `lib/internal/streams/pipeline.js`                                 | `pipeline-impl.ts`                             |
| `lib/internal/streams/compose.js`                                  | `compose-impl.ts`                              |
| `lib/internal/streams/duplexify.js`                                | `duplexify.ts`                                 |
| `lib/internal/streams/duplexpair.js`                               | `DuplexSide` in `../browser/utils.ts`          |
| `lib/internal/streams/utils.js`, `state.js`                        | `stream-utils.ts`, `state.ts`                  |
| `lib/internal/webstreams/adapters.js`                              | `web-adapters.ts`                              |

Browser substitutes: `process.nextTick` → the tick queue in `state.ts`; `Buffer` → `Uint8Array`
(string chunks keep `toString(encoding)`); `StringDecoder` → `createStreamDecoder`; bit-field
state → plain fields; the lazy CommonJS `require` of `compose` → the `StreamKernel` the classes
pass in.

The classes follow Node exactly, defects included. Deliberate departures live only in the module's
own functions: the five fixes in the safe Web conversions above; `pipeline` reads a Web source
through a reader it cancels on abort, runs an all-Web pipeline on `pipeTo`, settles only after
every connection has torn down, and rejects a stream given twice; `finished(webStream)` refuses Web
streams in the browser rather than taking their lock.

Where each kind of behaviour is tested:

| File (`__tests__/`)               | Oracle                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `stream-node-oracle.node.test.ts` | `node:stream` itself: the same call must give its result on both entries              |
| `stream-contract.shared.ts`       | The module's own contract, asserted directly; run on both entries and in Chromium     |
| `stream-interop.node.test.ts`     | Streams from `readable-stream` and, for the kernel, `node:stream`, in both directions |
| `stream-scheduling.node.test.ts`  | Event order against `node:stream`, and the one measured platform limit                |
| `stream-parity.node.test.ts`      | Regressions the previous browser implementation had, with explicit expectations       |

### Resource ownership

One rule decides who cleans up: **whoever takes a reader or writer closes, cancels or releases
it.** The stream kernel owns Node-style state and events; a Web adapter owns the reader or writer
it took; `pipeline` owns the connections it starts; `finished` only observes and never takes a
lock. The module's `fromWeb` functions check every lock before taking any, hand the lock back
when the stream ends, errors or is destroyed, and the module's `toWeb` functions remove their own
listeners from the source once the Web stream is done with it. The class statics do neither, as
Node's do not.

`pipeline` works in three phases. It first checks every stage — wrong kind, locked, already
destroyed, or the same stream given twice (Node does not check this one) — before converting
any, and checking has no side effects: a pipeline rejected there has created, locked and
subscribed to nothing, and every stream still belongs to the caller. The one exception is a
promise among the stages, at any depth of a `{ readable, writable }` object: its rejection is
handled, since it would otherwise surface as an unhandled one. It then connects the stages,
registering how to stop each connection; a stage that can only fail once connected (a generator
returning something unusable) tears down every stage it was given. Finally it settles once,
after every connection has finished **and every teardown has completed** — a source's cancel, a
sink's abort, a stage's own async `_destroy`. A stage whose `_destroy` never calls back therefore
keeps the pipeline from settling, as it keeps Node's `finished` from resolving. With `end: false`
a Web writable is handed back unlocked, with everything written.

On the Node entry, a pipeline of Node streams runs on Node's own `stream.pipeline`; one with a Web
stream or a generator stage runs on the module's pipeline over Node's classes, because Node's
leaves a Web writable locked, cannot cancel a Web read on abort, and leaves later stages running
when a generator fails.

The browser classes' type parameters default to `any`, as Node's non-generic classes effectively
do, so the same subclass compiles on both builds. `pnpm verify:portable-types` compiles
`__tests__/type/portable/consumer.ts` against both published entries to keep it that way.
