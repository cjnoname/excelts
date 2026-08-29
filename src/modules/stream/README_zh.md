# Stream 模块

[English](README.md)

跨平台流式实现，在 Node.js 和浏览器中提供完全相同的 API。

- **Node.js**：使用原生 `stream` 模块以获得最佳性能
- **浏览器**：使用 Web Streams API（`ReadableStream`、`WritableStream`、`TransformStream`）

```typescript
import { Readable, pipeline, createTransform } from "documonster/stream";
```

## 功能特性

- **100% 跨平台** - 在 Node.js 和浏览器中拥有相同的 API、相同的类型、相同的行为
- **单一入口** - 根据运行环境自动解析到正确的实现
- **类型安全** - 完整的 TypeScript 支持和一致的类型定义
- **兼容 Node.js API** - 熟悉的 `Readable`、`Writable`、`Transform`、`Duplex` 类
- **高性能** - 两个平台均使用原生实现

## 安装

Stream 模块是 Documonster 的一部分。通过子路径导入：

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

## 快速开始

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

## 核心类

### EventEmitter

浏览器兼容的 EventEmitter，提供类 Node.js API。

```typescript
// 注意：documonster/stream 不导出 EventEmitter。流类
// （Readable/Writable/Transform/Duplex）已提供 on/once/off/emit 等 API。
// 如需独立的事件发射器，请从 Node.js 导入：
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

用于消费数据的可读流。

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

**关键属性：**

- `readable.readable` - 流是否可读
- `readable.readableEnded` - 流是否已结束
- `readable.readableFlowing` - 流动状态（null、true、false）
- `readable.readableLength` - 内部缓冲区中的字节/对象数
- `readable.destroyed` - 是否已销毁

---

### Writable

用于输出数据的可写流。

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

**关键属性：**

- `writable.writable` - 流是否可写
- `writable.writableEnded` - 是否已调用 `end()`
- `writable.writableFinished` - 流是否已完成
- `writable.writableLength` - 缓冲区中的字节/对象数
- `writable.writableHighWaterMark` - 高水位线
- `writable.destroyed` - 是否已销毁

---

### Transform

在数据通过时进行转换的双工流。

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

同时独立具备可读和可写功能的流。

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

## 专用流

### Collector

将流中的所有数据收集到数组中。

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

基于拉取的 Transform 流，支持模式匹配。适用于解析协议和文件格式。

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

**模式匹配：**

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

具有高效内部缓冲的 Duplex 流。

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

高效的字符串构建器，输出为 Uint8Array。适用于高效构建大型字符串/XML/JSON。

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

支持快照/回滚的 ChunkedBuilder。适用于可能需要回溯的推测性解析。

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

## Pipeline 与工具函数

### pipeline

将多个流通过管道连接，提供正确的错误处理和清理。返回一个 Promise。

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

等待流完成（结束、关闭或出错）。

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

将多个 Transform 组合为单个 Transform。

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

等待多个流全部完成。

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

为任意流添加中止信号处理。

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

## 工厂函数

### createReadableFromArray

从数组创建可读流。

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

从异步可迭代对象创建可读流。

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

从生成器函数创建可读流。

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

从 Promise 创建可读流（发出单个值）。

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

创建一个立即结束且无数据的可读流。

```typescript
import { createEmptyReadable, pipeline } from "documonster/stream";

const empty = createEmptyReadable();
// Useful for conditional pipelines or testing
```

---

### createNullWritable

创建一个丢弃所有数据的可写流（类似 `/dev/null`）。

```typescript
import { createNullWritable, pipeline } from "documonster/stream";

const devNull = createNullWritable();

// Drain a stream without collecting data
await pipeline(source, devNull);
```

---

## 流消费者

用于消费整个流的工具函数。

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

## 类型守卫

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

## 流状态检查

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

## 二进制工具

这些辅助函数存在于库内部，但**不属于任何已发布入口** —— `stringToUint8Array`、
`uint8ArrayToString`、`concatUint8Arrays`、`uint8ArrayEquals` 和 `uint8ArrayIndexOf` 都位于
内部 `utils/` 层，该层刻意从不导出。它们只是平台内置能力的薄封装，请直接使用后者：

```typescript
// String <-> Uint8Array 转换（UTF-8）
const bytes = new TextEncoder().encode("Hello, 世界!");
const text = new TextDecoder().decode(bytes);

// 其他编码，取决于运行时是否支持
const latin1 = new TextDecoder("latin1").decode(bytes);

// 拼接多个数组
const total = arrays.reduce((n, a) => n + a.length, 0);
const combined = new Uint8Array(total);
let offset = 0;
for (const a of arrays) {
  combined.set(a, offset);
  offset += a.length;
}
```

---

## Promise 工具

### onceEvent

等待来自 emitter 的单个事件。

```typescript
import { onceEvent } from "documonster/stream";

// 等待单个事件（事件触发时 resolve 为 void）
await onceEvent(emitter, "data");
console.log("data event fired");

// 注意：onceEvent 仅接受 (emitter, event)，返回 Promise<void>。
// 它不接受 AbortSignal，也不会以事件参数进行 resolve。
// 若需要 Node 中可返回参数、支持 { signal } 的 `once`，请从 node:events 导入：
//   import { once } from "node:events";
```

---

### promisify

将回调风格的函数转换为 Promise。

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

基于 Promise 版本的 pipeline 和 finished。

```typescript
import { promises } from "documonster/stream";

// Same as regular pipeline/finished but explicitly promise-based
await promises.pipeline(source, transform, destination);
await promises.finished(stream);
```

---

## 高水位线

控制流的缓冲行为。

```typescript
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "documonster/stream";

// Get defaults
getDefaultHighWaterMark(false); // 16384 (16KB for byte streams)
getDefaultHighWaterMark(true); // 16 (16 objects for object mode)

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

## 错误处理

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

## 浏览器兼容性

浏览器实现使用 Web Streams API，兼容以下浏览器：

| 浏览器  | 最低版本 |
| ------- | -------- |
| Chrome  | 89+      |
| Firefox | 102+     |
| Safari  | 14.1+    |
| Edge    | 89+      |

Node.js 和浏览器之间的 API **完全相同**，允许你编写一次代码即可在任何平台运行。

---

## 性能

- **Node.js**：使用原生 stream 模块，零开销（与 `require('stream')` 性能完全一致）
- **浏览器**：优化的 Web Streams 实现（约为 Node.js 原生速度的 1/9，这在浏览器使用场景下是符合预期且可接受的）

### 性能建议

1. **使用 object mode** 处理非二进制数据以避免编码开销
2. **优先使用 pipeline** 而非手动 pipe，以获得正确的错误处理和清理
3. **使用合适的 highWaterMark**，根据数据大小进行调整
4. **避免不必要的 Transform** - 尽可能合并操作
5. **使用异步迭代**（`for await...of`）编写更简洁的代码

---

## 示例

### CSV 处理

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

### 数据过滤和转换

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

### 异步数据处理

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

### 使用 PullStream 解析协议

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

### 文件处理（Node.js）

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

### Fetch API 集成（浏览器）

```typescript
import { Readable, pipeline, createCollector } from "documonster/stream";

// Fetch and process response
const response = await fetch("/api/large-data");

// Convert Web ReadableStream to our Readable
const readable = Readable.fromWeb(response.body!);

const collector = createCollector<Uint8Array>();

await pipeline(readable, collector);
const data = collector.toUint8Array();
```

---

## API 参考

### 类

| 类                            | 描述                   |
| ----------------------------- | ---------------------- |
| `Readable`                    | 可读流类               |
| `Writable`                    | 可写流类               |
| `Transform`                   | 转换流类               |
| `Duplex`                      | 双工流类               |
| `PassThrough`                 | 直通转换（无操作）     |
| `Collector`                   | 将流数据收集到数组中   |
| `PullStream`                  | 支持模式匹配的拉取式流 |
| `BufferedStream`              | 带内部缓冲的流         |
| `ChunkedBuilder`              | 高效字符串构建器       |
| `TransactionalChunkedBuilder` | 支持快照/回滚的构建器  |
| `createStringChunk()`         | 字符串数据块工厂函数   |
| `createByteChunk()`           | 二进制数据块工厂函数   |

### 工厂函数

| 函数                                | 描述                       |
| ----------------------------------- | -------------------------- |
| `createReadable()`                  | 使用自定义选项创建可读流   |
| `createReadableFromArray()`         | 从数组创建可读流           |
| `createReadableFromAsyncIterable()` | 从异步可迭代对象创建可读流 |
| `createReadableFromGenerator()`     | 从生成器创建可读流         |
| `createReadableFromPromise()`       | 从 Promise 创建可读流      |
| `createEmptyReadable()`             | 创建空可读流               |
| `createWritable()`                  | 使用自定义选项创建可写流   |
| `createNullWritable()`              | 创建丢弃数据的可写流       |
| `createTransform()`                 | 使用函数创建转换流         |
| `createDuplex()`                    | 创建双工流                 |
| `createPassThrough()`               | 创建直通转换流             |
| `createCollector()`                 | 创建数据收集器             |
| `createPullStream()`                | 创建拉取式流               |
| `createBufferedStream()`            | 创建带缓冲的流             |
| `duplexPair()`                      | 创建已连接的双工流对       |

### 工具函数

| 函数                   | 描述                          |
| ---------------------- | ----------------------------- |
| `pipeline()`           | 管道连接流并处理错误          |
| `finished()`           | 等待流完成                    |
| `compose()`            | 组合多个转换流                |
| `finishedAll()`        | 等待多个流完成                |
| `addAbortSignal()`     | 为流添加中止信号              |
| `onceEvent()`          | 等待单个事件；resolve 为 void |
| `promisify()`          | 将回调转换为 Promise          |
| `streamToUint8Array()` | 收集流为 Uint8Array           |
| `streamToString()`     | 收集流为字符串                |
| `drainStream()`        | 消费流但不收集数据            |
| `copyStream()`         | 将源流复制到目标流            |

### 二进制工具

以下辅助函数从 `documonster/archive` 重新导出（并非 `documonster/stream`）。

| 函数                   | 描述                   |
| ---------------------- | ---------------------- |
| `stringToUint8Array()` | 将字符串转换为字节数组 |
| `uint8ArrayToString()` | 将字节数组转换为字符串 |
| `concatUint8Arrays()`  | 拼接多个数组           |

### 类型守卫

| 函数            | 返回 true 的条件 |
| --------------- | ---------------- |
| `isReadable()`  | 可读流           |
| `isWritable()`  | 可写流           |
| `isTransform()` | 转换流           |
| `isDuplex()`    | 双工流           |
| `isStream()`    | 任意流类型       |
| `isDestroyed()` | 流已被销毁       |
| `isDisturbed()` | 流已被读取       |
| `isErrored()`   | 流已发生错误     |

---

## 平台差异（固有）

虽然 Node.js 和浏览器之间的外部 API 完全对称，但以下差异是**平台固有的**，无法消除：

| 方面                                    | Node.js                                                                                           | 浏览器                                                | 影响                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **二进制数据块类型**                    | `Buffer`（`Uint8Array` 的子类，具有 `.toString('hex')`、`.toString('base64')`、`.copy()` 等方法） | `Uint8Array`（已补丁 `.toString()` 以支持基本 UTF-8） | 使用 `Buffer` 特有方法的代码将无法跨平台运行。请改用本模块提供的 `Uint8Array` 工具函数。           |
| **`readableBuffer` / `writableBuffer`** | 返回 Node.js 内部 `BufferList`（链表结构，具有 `.head`、`.length`）                               | 返回普通 `T[]` 数组                                   | 请勿依赖 `BufferList` 特有属性。两者都返回可迭代的数据块集合。                                     |
| **事件调度**                            | `process.nextTick`（在微任务之前执行）                                                            | `queueMicrotask`（本身就是微任务）                    | 相对于 `Promise.then()` 的事件顺序在边界情况下可能不同。共享测试套件已验证所有常见模式的行为一致。 |
| **`_readableState` / `_writableState`** | 可访问（Node.js 内部状态对象）                                                                    | 不存在（状态存储在各个私有字段中）                    | 请勿依赖内部状态对象。请使用公开的属性访问器。                                                     |
