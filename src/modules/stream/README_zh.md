# Stream 模块

[English](README.md)

Node.js 风格的流类与工具函数，同一份代码可在 Node.js 和浏览器中运行。

- **Node.js**：直接使用原生 `node:stream`——`Readable`、`Writable`、`Duplex`、`Transform`、
  `PassThrough` 就是 Node 自己的类；阶段都是 Node 风格的流时，`pipeline`、`compose`、`duplexPair`
  也调用 Node 的实现。
- **浏览器**：移植自 Node 的 `lib/internal/streams`，背压、事件顺序和销毁流程与 Node 一致。

两端凡是接受流的地方都接受 Web Streams（`ReadableStream`、`WritableStream`、`TransformStream`）。
转换时请使用 `readableFromWeb` / `readableToWeb` / `writableFromWeb` / `writableToWeb`，它们在 Node.js、Bun
和浏览器上行为一致；类自带的 `Readable.fromWeb` 等方法保持 Node 的行为，缺陷也一样（见
[Node 风格流与 Web 流的转换](#node-风格流与-web-流的转换)）。

```typescript
import { Readable, pipeline, createTransform } from "documonster/stream";
```

## 功能特性

- **跨平台** - Node.js 和浏览器的 API 与行为一致；共享测试套件同时在两端运行
- **单一入口** - 根据运行环境自动解析到正确的实现
- **类型安全** - 完整的 TypeScript 支持和一致的类型定义
- **兼容 Node.js API** - 熟悉的 `Readable`、`Writable`、`Transform`、`Duplex` 类
- **能用原生就用原生** - Node 端是 Node 自己的实现；Web Streams 通过其自身的 reader / writer 读写

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

把多个阶段组合成一个 `Duplex`：写入进第一个阶段，读取来自最后一个阶段。阶段的类型与 `pipeline` 相同（Node 风格的流、
Web 流、生成器函数、可迭代对象），规则与 Node 一致：不传阶段时抛出 `ERR_MISSING_ARGS`，只传一个阶段时返回
`Duplex.from(stage)`。`compose<In, Out>(…)` 为写入和读取的数据标注类型（这是调用方的声明，不会与各阶段核对，Node 的 `compose`
同样不做核对）；返回值是各入口自己的 `Duplex`，所以在 Node 上
它可以用在任何接受 `node:stream` 的 `compose` 结果的地方。

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
import {
  Readable,
  Writable,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark
} from "documonster/stream";

// Get defaults
getDefaultHighWaterMark(false); // 65536（字节流 64KB；Windows 上的 Node 为 16384）
getDefaultHighWaterMark(true); // 16（对象模式 16 个对象）

// 修改之后新建的所有流的默认值，类和工厂函数创建的流都受影响。与 Node 一样，值必须是非负整数，
// 否则抛出 ERR_INVALID_ARG_TYPE 或 ERR_OUT_OF_RANGE。需要在各平台上保持相同阈值时，请显式传入 `highWaterMark`。
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

浏览器实现是纯 JavaScript，依赖 `queueMicrotask`、`TextDecoder` 和 Web Streams，兼容以下浏览器：

| 浏览器  | 最低版本 |
| ------- | -------- |
| Chrome  | 89+      |
| Firefox | 102+     |
| Safari  | 14.1+    |
| Edge    | 89+      |

仅为本模块的下限；整个包的下限更高，见[根 README](../../../README_zh.md#系统要求)。

Node.js 和浏览器之间的 API **完全相同**，允许你编写一次代码即可在任何平台运行。

---

## 性能

- **Node.js**：使用原生 stream 模块，零开销（与 `require('stream')` 性能完全一致）
- **浏览器**：与 Node 实现相同的算法，缓冲和背压表现一致

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
import { readableFromWeb, pipeline, createCollector } from "documonster/stream";

// 获取并处理响应
const response = await fetch("/api/large-data");

// 把 Web ReadableStream 转成 Node 风格的 Readable（也可以直接把 `response.body` 交给 `pipeline`，
// 它原样接受 Web 流）
const readable = readableFromWeb(response.body!);

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

API 及其类型在 Node.js、Bun 和浏览器上完全相同。下面这些差异之所以保留，是因为浏览器的标准 API 无法表达 Node 的行为；
要消除它们，就得放弃 Node 已有的能力（`instanceof` 则需要改变它的含义）：

| 方面                                    | Node.js                                                                                           | 浏览器                                                                                             | 影响                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **二进制数据块类型**                    | `Buffer`（`Uint8Array` 的子类，具有 `.toString('hex')`、`.toString('base64')`、`.copy()` 等方法） | `Uint8Array`（以字符串 push 的数据块保留 `.toString(encoding)`）                                   | 使用 `Buffer` 特有方法的代码将无法跨平台运行。请改用本模块提供的 `Uint8Array` 工具函数。                                                                                                                                                                                             |
| **事件调度**                            | `process.nextTick`                                                                                | 一个微任务按顺序执行期间排入的所有 tick                                                            | 流自身事件和回调之间的顺序与 Node 一致；在宏任务（事件回调、定时器、I/O）中排入的 tick，执行位置也与 Node 一致。在 Promise 续体中排入时，Node 要等整个微任务队列清空才执行，浏览器没有任何原语能做到，因此会更早执行。两者均由 `__tests__/stream-scheduling.node.test.ts` 实测验证。 |
| **`_readableState` / `_writableState`** | Node 的内部状态对象                                                                               | 字段名相同，但是不同的对象                                                                         | 属于内部实现：请使用公开的访问器（`readableLength`、`writableNeedDrain` 等）。                                                                                                                                                                                                       |
| **`isDisturbed(webStream)`**            | 由 Node 自己的 Web Streams 回答                                                                   | 未锁定的流可准确判断（通过 `new Response(stream)` 探测，既不加锁也不读取）；已锁定的流返回 `false` | 对已锁定的流，真实答案是“未知”：读过和没读过无法区分，所以这里的 `false` 表示“未发现被读取过”。                                                                                                                                                                                      |
| **`instanceof` 流的类**                 | 任何来源的 `node:stream` 流都为 `true`                                                            | 只有本模块的类创建的流为 `true`                                                                    | 其他来源的流（`readable-stream`、其他库）仍能被这里的所有函数识别和驱动：和 Node 一样，它们按流的协议判断，而不是按类判断。请用 `isReadable` / `isWritable` / `isStream` 判断，不要用 `instanceof`。                                                                                 |
| **`finished(webStream)`**               | 任意 Web 流                                                                                       | 不支持：立即拒绝，且不对流加锁                                                                     | 标准 API 没有不加锁的完成信号，Web 流的队列是否被消费完，只有消费它的 reader 知道。请等待你自己的 reader / writer 的 `closed`。                                                                                                                                                      |

### Node 风格流与 Web 流的转换

请使用本模块自己的转换函数，它们在两端的行为一致：

```ts
import { readableFromWeb, readableToWeb, writableFromWeb, writableToWeb } from "documonster/stream";

const nodeStyle = readableFromWeb(response.body!);
const web = writableToWeb(nodeStyleWritable);
```

类上的静态方法（`Readable.fromWeb`、`Writable.toWeb`、`Duplex.fromWeb` 等）在**两端**都是 Node 的行为：
Node 入口中是 `node:stream` 自己的实现，浏览器中是对它的忠实移植。因此基于它们写的代码在各处表现一致，
缺陷也一致。截至 Node 26 它们有五处行为是错的，上面这几个模块函数全部修正了，且两端一致：

| 类的静态方法（Node 的行为）                                                                             | 模块函数                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Readable.fromWeb` 把读到的 `null` push 进去，导致流提前结束，后面的数据被悄悄丢掉                      | `readableFromWeb` 以 `ERR_STREAM_NULL_VALUES` 失败 |
| `Readable.fromWeb` / `Writable.fromWeb` / `Duplex.fromWeb` 永久持有 Web 流的锁                          | 适配器用完后交还锁                                 |
| `w.writableNeedDrain` 时调用 `Writable.toWeb(w)`：下一次 Web 写入直接完成，从未调用 `w.write()`         | 先写入这块数据，再等待 drain                       |
| `r.setEncoding(...)` 之后调用 `Readable.toWeb(r)`：字符串一旦排队，`'data'` 中抛出未捕获的 `RangeError` | 按字符数计算字符串大小                             |
| `Readable.toWeb` / `Writable.toWeb` 用完后不移除挂在源流上的 `'data'` / `'drain'` 监听器                | 移除监听器                                         |

`pipeline` 和 `compose` 自己读写 Web 流，`toWritable` 经由 `writableFromWeb`，所以两端都不受这些缺陷影响。

在 Bun 上，Node 入口的类就是 Bun 自己的 `node:stream`，所以静态方法也是 Bun 的行为。例如 Bun 1.4 的 `Readable.fromWeb`
在流结束后会释放锁，而 Node 不会。只有本模块的转换函数在 Node、Bun 和浏览器上行为完全一致。

Node 风格的流根本无法传递 `null`（任何模式下 `push(null)` 都表示结束），需要传递时请在 Web 侧先包装，
例如 `{ value: null }`。

## 维护：上游基线

`src/modules/stream/kernel/` 移植自 Node.js **v26.8.1**。Node 修复流相关的 bug 时，请对照下表比较，
不要重新摸索行为：

| Node.js 文件                                                       | 移植位置                                         |
| ------------------------------------------------------------------ | ------------------------------------------------ |
| `lib/internal/streams/readable.js`                                 | `readable-impl.ts`、`classes.ts` 中的 `Readable` |
| `lib/internal/streams/writable.js`                                 | `writable.ts`                                    |
| `lib/internal/streams/duplex.js`、`transform.js`、`passthrough.js` | `classes.ts`                                     |
| `lib/internal/streams/destroy.js`                                  | `destroy.ts`                                     |
| `lib/internal/streams/end-of-stream.js`                            | `end-of-stream.ts`                               |
| `lib/internal/streams/from.js`                                     | `from.ts`                                        |
| `lib/internal/streams/operators.js`                                | `operators.ts`                                   |
| `lib/internal/streams/pipeline.js`                                 | `pipeline-impl.ts`                               |
| `lib/internal/streams/compose.js`                                  | `compose-impl.ts`                                |
| `lib/internal/streams/duplexify.js`                                | `duplexify.ts`                                   |
| `lib/internal/streams/duplexpair.js`                               | `../browser/utils.ts` 中的 `DuplexSide`          |
| `lib/internal/streams/utils.js`、`state.js`                        | `stream-utils.ts`、`state.ts`                    |
| `lib/internal/webstreams/adapters.js`                              | `web-adapters.ts`                                |

浏览器端的替代机制：`process.nextTick` → `state.ts` 中的 tick 队列；`Buffer` → `Uint8Array`（字符串数据块保留
`toString(encoding)`）；`StringDecoder` → `createStreamDecoder`；位域状态 → 普通字段；CommonJS 对 `compose`
的延迟 `require` → 由类传入的 `StreamKernel`。

类的行为与 Node 完全一致，缺陷也一样。有意偏离之处只存在于本模块自己的函数中：上文安全转换函数的五处修正；
`pipeline` 通过可在 abort 时取消的 reader 读取 Web 源，全 Web 管道走 `pipeTo`，在所有连接拆除完毕后才结束，
并拒绝重复传入的同一个流；浏览器端的 `finished(webStream)` 直接拒绝 Web 流，而不是对它加锁。

各类行为由哪个测试文件负责：

| 文件（`__tests__/`）              | 判定标准                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| `stream-node-oracle.node.test.ts` | 以 `node:stream` 为准：同一调用在两个入口上都必须得到它的结果          |
| `stream-contract.shared.ts`       | 本模块自己的约定，逐条直接断言；在两个入口和 Chromium 中运行           |
| `stream-interop.node.test.ts`     | 来自 `readable-stream`（以及对内核而言的 `node:stream`）的流，双向互通 |
| `stream-scheduling.node.test.ts`  | 与 `node:stream` 对照事件顺序，以及唯一一处实测的平台限制              |
| `stream-parity.node.test.ts`      | 旧浏览器实现出过的问题的回归测试，预期值显式写出                       |

### 资源所有权

谁负责清理由一条规则决定：**谁取得了 reader 或 writer，谁负责关闭、取消或释放它。** 流内核负责 Node 风格的
状态和事件；Web 适配器负责它取得的 reader / writer；`pipeline` 负责它启动的连接；`finished` 只观察，从不加锁。模块的 `fromWeb` 函数在取得任何锁之前先检查所有锁，并在流结束、出错或被销毁时交还锁；模块的 `toWeb` 函数用完源流后会移除自己挂上的监听器。类的静态方法和 Node 一样，这两件事都不做。

`pipeline` 分三个阶段。先检查每个阶段（类型不对、已被锁定、已被销毁，或同一个流出现两次——Node 不检查最后这一项），
全部检查通过后才开始转换，而且检查没有副作用：在这一步被拒绝的管道没有创建、锁定或订阅任何东西，所有流仍归调用方。
唯一的例外是阶段中的 Promise（包括嵌在 `{ readable, writable }` 对象任意层级里的）：它的拒绝会被处理掉，否则会变成
未处理的拒绝。然后连接各阶段，并为每个连接登记停止方式；只有连接之后才会暴露的失败（生成器返回了无法使用的值）
会拆除交给管道的所有阶段。最后在所有连接都结束、**并且所有清理都完成之后**只结束一次——包括数据源的取消、目标的中止、
阶段自己的异步 `_destroy`。因此，如果某个阶段的 `_destroy` 永远不调用回调，管道也永远不会结束，这和 Node 的 `finished`
在这种情况下不会结束是一样的。使用 `end: false` 时，Web 可写流会在全部写入完成后以未锁定状态交还给调用方。

在 Node 入口，纯 Node 流的管道走 Node 自己的 `stream.pipeline`；含 Web 流或生成器阶段的管道走本模块的 pipeline，
并使用 Node 的类。原因是 Node 的实现会让 Web 可写流保持锁定、在 abort 时无法取消正在等待的 Web 读取，并在生成器
失败时让后面的阶段继续运行。

浏览器端各类的类型参数默认为 `any`，与 Node 不带泛型的类在效果上一致，因此同一个子类在两端都能编译。
`pnpm verify:portable-types` 会针对两个已发布入口编译 `__tests__/type/portable/consumer.ts`，持续保证这一点。
