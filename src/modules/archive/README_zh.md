# Archive 模块

[English](README.md)

零依赖、跨平台的归档工具包，用于创建、读取和编辑 ZIP 和 TAR 归档。

```typescript
import { Archive } from "documonster/archive";
```

## 功能特性

- **零依赖** — 纯 TypeScript，无原生插件
- **跨平台** — Node.js 和浏览器使用相同 API
- **ZIP + TAR** — 两种归档格式的统一 API
- **流式处理** — 真正的异步流式处理，支持背压
- **ZIP 编辑** — 对现有归档进行文件系统式编辑，高效直通传递
- **远程读取** — 通过 HTTP Range 请求读取 ZIP 文件（只下载需要的部分）
- **加密** — ZIP 传统加密和 AES-256 加密/解密
- **ZIP64** — 大文件支持（> 4GB 文件、> 65535 条目）
- **压缩** — DEFLATE、GZIP 和 Zlib，支持同步/异步/流式 API
- **PNG 编码** — `encodePng`，因为 PNG 就是带 CRC-32 校验 chunk 的 DEFLATE 流
- **进度和中止** — 内置进度回调和 AbortSignal 支持
- **文件系统集成** — Node.js 磁盘 I/O 便捷层

---

## 快速开始

### 创建 ZIP

```typescript
import { Archive } from "documonster/archive";

// 便捷函数
const archive = Archive.zip();
archive.add("hello.txt", "Hello, World!");
archive.add("data.json", JSON.stringify({ key: "value" }));
const bytes = await archive.bytes();

// 使用选项
const archive = Archive.zip({ level: 9, comment: "My archive" });
archive.add("file.txt", content, { modTime: new Date() });
archive.addDirectory("empty-dir/");
archive.addSymlink("link.txt", "hello.txt");
const bytes = await archive.bytes();
```

### 读取 ZIP

```typescript
import { Archive } from "documonster/archive";

const reader = Archive.unzip(zipBytes);
for await (const entry of reader.entries()) {
  console.log(entry.path, entry.type);
  if (entry.type === "file") {
    const data = await entry.bytes();
    console.log(new TextDecoder().decode(data));
  }
}

// 按路径随机访问
const data = await reader.bytes("hello.txt");
```

### 编辑 ZIP

```typescript
import { Archive } from "documonster/archive";

const editor = await Archive.editZip(existingZipBytes, { preserve: "best-effort" });
editor.delete("old.txt");
editor.rename("a.txt", "renamed.txt");
editor.set("new.txt", "new content");
const output = await editor.bytes();
```

---

## ZIP API

### `zip(options?)`

工厂函数，创建新的 `ZipArchive` 或 `TarArchive`。

```typescript
import { Archive } from "documonster/archive";

const archive = Archive.zip(); // ZipArchive
const tarArchive = Archive.zip({ format: "tar" }); // TarArchive
```

### `ZipArchive`

流式 ZIP 归档构建器，支持链式调用。

```typescript
import { Archive } from "documonster/archive";

const archive = new Archive.ZipArchive({ level: 6, reproducible: true });

// 添加条目（可链式调用）
archive
  .add("file.txt", "text content")
  .add("binary.dat", uint8Array)
  .add("from-stream.bin", readableStream)
  .addDirectory("empty-dir/")
  .addSymlink("link.txt", "file.txt");

// 输出选项：

// 1. 完整 Uint8Array
const bytes = await archive.bytes();

// 2. 同步（仅限内存数据源）
const bytes = archive.bytesSync();

// 3. 异步流式
for await (const chunk of archive.stream()) {
  // 逐块处理
}

// 4. 管道到 WritableStream
await archive.pipeTo(writableStream);

// 5. 带进度和中止的操作
const op = archive.operation({
  onProgress: p => console.log(`${p.entriesDone}/${p.entriesTotal}`),
  signal: abortController.signal
});
for await (const chunk of op.iterable) {
  /* process chunk */
}
```

**`ZipOptions`：**

| 选项           | 类型                       | 默认值    | 描述                           |
| -------------- | -------------------------- | --------- | ------------------------------ |
| `level`        | `number`                   | `6`       | 压缩级别（0 = 存储，9 = 最大） |
| `comment`      | `string`                   | -         | 归档级注释                     |
| `reproducible` | `boolean`                  | `false`   | 稳定时间戳，用于可复现构建     |
| `smartStore`   | `boolean`                  | `true`    | 自动对不可压缩数据使用 STORE   |
| `zip64`        | `"auto" \| boolean`        | `"auto"`  | ZIP64 模式                     |
| `signal`       | `AbortSignal`              | -         | 中止信号                       |
| `onProgress`   | `(p: ZipProgress) => void` | -         | 进度回调                       |
| `encoding`     | `ZipStringEncoding`        | `"utf-8"` | 名称的字符串编码               |
| `timestamps`   | `ZipTimestampMode`         | -         | 时间戳编码模式                 |

### `unzip(source, options?)`

打开归档进行读取。

```typescript
import { Archive } from "documonster/archive";

const reader = Archive.unzip(zipBytes);
const reader = Archive.unzip(zipBytes, { password: "secret" });
const reader = Archive.unzip(tarBytes, { format: "tar" });
```

### `ZipReader`

流式 ZIP 读取器，支持随机访问。

```typescript
import { Archive } from "documonster/archive";

const reader = new Archive.ZipReader(zipBytes);

// 流式迭代
for await (const entry of reader.entries()) {
  const data = await entry.bytes();
  const text = await entry.text();
  // 或流式读取条目
  for await (const chunk of entry.stream()) {
    /* process chunk */
  }
  // 或管道
  await entry.pipeTo(writableStream);
}

// 随机访问
const entry = await reader.get("path/to/file.txt");
const bytes = await reader.bytes("path/to/file.txt");

// 带进度和中止
const op = reader.operation({
  onProgress: p => console.log(`${p.entriesEmitted} 个条目，${p.bytesOut} 字节`),
  signal: controller.signal
});
```

### `UnzipEntry`

表示归档中的单个条目。

```typescript
entry.path; // "path/to/file.txt"
entry.type; // "file" | "directory" | "symlink"
entry.mode; // Unix 模式（如 0o644）
entry.linkTarget; // 符号链接目标（在 bytes() 之后可用）

await entry.bytes(); // Uint8Array
await entry.text(); // 字符串（UTF-8）
await entry.text("latin1"); // 字符串（自定义编码）
for await (const chunk of entry.stream()) {
  /* process chunk */
}
await entry.pipeTo(writable);
entry.readableStream(); // WHATWG ReadableStream
entry.discard(); // 跳过不读取
```

**`UnzipOptions`：**

| 选项         | 类型                         | 默认值    | 描述       |
| ------------ | ---------------------------- | --------- | ---------- |
| `password`   | `string \| Uint8Array`       | -         | 解密密码   |
| `encoding`   | `ZipStringEncoding`          | `"utf-8"` | 条目名编码 |
| `signal`     | `AbortSignal`                | -         | 中止信号   |
| `onProgress` | `(p: UnzipProgress) => void` | -         | 进度回调   |

---

## ZIP 编辑器

对现有 ZIP 归档进行文件系统式编辑。未变更的条目高效直通传递（保留原始压缩字节）。

```typescript
import { Archive } from "documonster/archive";

// 从字节
const editor = await Archive.editZip(zipBytes, {
  reproducible: true,
  preserve: "best-effort",
  onWarning: w => console.warn(w.code, w.entry, w.message)
});

// 从 URL（HTTP Range 请求）
const editor = await Archive.editZipUrl("https://example.com/archive.zip");

// 操作
editor.has("file.txt"); // 检查存在
editor.set("new.txt", "content"); // 添加或替换
editor.delete("old.txt"); // 删除条目
editor.deleteDirectory("old-dir/"); // 递归删除目录
editor.rename("a.txt", "b.txt"); // 重命名条目
editor.setComment("Updated archive"); // 设置归档注释

// 可复用的编辑计划
import { Archive } from "documonster/archive";

const plan = new Archive.ZipEditPlan();
plan.set("config.json", newConfig);
plan.delete("temp/");
editor.apply(plan);

// 输出
const output = await editor.bytes();
await editor.pipeTo(writable);
for await (const chunk of editor.stream()) {
  /* process chunk */
}
```

---

## 远程 ZIP 读取器

通过 HTTP Range 请求读取 ZIP 文件 — 只下载你需要的条目。

```typescript
import { Archive } from "documonster/archive";

const reader = await Archive.RemoteZipReader.open("https://example.com/large.zip");

// 元数据（尚未下载内容）
const entries = reader.getEntries();
console.log(`${entries.length} 个条目`);

const files = reader.listFiles();
const count = reader.getFileCount();

// 按模式查找条目
const jsFiles = reader.findEntries("**/*.js");

// 提取单个文件（只下载该条目）
const data = await reader.extract("path/to/file.txt");

// 提取多个（批量处理以提高效率）
const results = await reader.extractMultiple(["a.txt", "b.txt"]);

// 流式提取
await reader.extractToStream("large-file.bin", writableStream);

// 密码保护的归档
const reader = await Archive.RemoteZipReader.open(url);
const isValid = await reader.checkPassword("secret.txt", "mypassword");
const data = await reader.extract("secret.txt", { password: "mypassword" });

// 统计信息
const stats = reader.getStats();
console.log(`已下载 ${stats.http?.bytesDownloaded} 字节（${stats.http?.downloadedPercent}%）`);

await reader.close();
```

---

## 压缩 API

底层压缩工具。DEFLATE、GZIP 和 Zlib，支持同步、异步和流式变体。

### 一次性压缩

```typescript
import {
  compress,
  compressSync,
  decompress,
  decompressSync,
  gzip,
  gunzip,
  gzipSync,
  gunzipSync,
  zlib,
  unzlib,
  zlibSync,
  unzlibSync,
  decompressAuto,
  decompressAutoSync,
  detectCompressionFormat
} from "documonster/archive";

// DEFLATE-RAW（ZIP 文件使用）
const compressed = await compress(data, { level: 9 });
const original = await decompress(compressed);
const compressedSync = compressSync(data);

// GZIP
const gzipped = await gzip(data);
const ungzipped = await gunzip(gzipped);

// Zlib（RFC 1950）
const zlibbed = await zlib(data);
const unzlibbed = await unzlib(zlibbed);

// 自动检测并解压
const format = detectCompressionFormat(data); // "gzip" | "zlib" | "deflate-raw"
const original = await decompressAuto(data);
```

### 流式压缩

```typescript
import {
  createDeflateStream,
  createInflateStream,
  createGzipStream,
  createGunzipStream,
  createZlibStream,
  createUnzlibStream,
  hasDeflateRaw
} from "documonster/archive";

// DEFLATE-RAW 流式
const deflater = createDeflateStream({ level: 6 });
const inflater = createInflateStream();

// GZIP 流式
const gzipper = createGzipStream();
const gunzipper = createGunzipStream();

// Zlib 流式
const zlibber = createZlibStream();
const unzlibber = createUnzlibStream();

// 检查可用性
hasDeflateRaw(); // Node.js 中为 true，浏览器取决于 CompressionStream
```

### CRC32

```typescript
import { crc32, crc32Update, crc32Finalize } from "documonster/archive";

// 一次性
const checksum = crc32(data);

// 增量（流式）
let state = 0xffffffff;
state = crc32Update(state, chunk1);
state = crc32Update(state, chunk2);
const checksum = crc32Finalize(state);
```

### PNG 编码

PNG 就是一个 DEFLATE 流加上带 CRC-32 校验的 chunk —— 正是上面这两样原语 —— 所以编码器住在这里，
而不是住在某个"恰好需要图片"的模块里。它之所以存在，是因为绘图引擎刻意在像素处停下：
`documonster/draw` 的 `rasterizeToRgba` 交回 RGBA，而编码需要 DEFLATE，后者位于 `draw` 之上一层。

```typescript
import { encodePng } from "documonster/archive";
import { rasterizeToRgba } from "documonster/draw";

// 来自任意显示列表 —— 图表、Mermaid 图、你自己的生产者
const image = rasterizeToRgba(list, { scale: 2 });
const png = encodePng(image.data, image.width, image.height, { dpi: 192 });

// 或者来自你手上已有的像素（8 位 RGBA，行优先）
const bytes = encodePng(rgba, width, height);
```

输入 8 位 RGBA，filter 0，单个 `IDAT`。给了 `dpi` 会写入 `pHYs` chunk；不给则不写。

---

## TAR 支持

与 ZIP 接口兼容的统一 API。

### 创建 TAR 归档

```typescript
import { Archive } from "documonster/archive";

// 便捷函数
const tarBytes = await Archive.tar(
  new Map([
    ["file.txt", "content"],
    ["data.bin", uint8Array]
  ]),
  { modTime: new Date() }
);

// 构建器 API（与 ZipArchive 相同）
const archive = new Archive.TarArchive();
archive
  .add("file.txt", "content", { mode: 0o755 })
  .addDirectory("dir/")
  .addSymlink("link", "file.txt");

const bytes = await archive.bytes();
for await (const chunk of archive.stream()) {
  /* process chunk */
}
```

### 读取 TAR 归档

```typescript
import { Archive } from "documonster/archive";

// 通过统一 API
const reader = Archive.unzip(tarBytes, { format: "tar" });

// 直接使用
const reader = new Archive.TarReader(tarBytes);
for await (const entry of reader.entries()) {
  console.log(entry.path, entry.isDirectory);
  const data = await entry.bytes();
}

// 随机访问
const data = await reader.bytes("file.txt");
const paths = await reader.list();
```

### TAR + GZIP（仅 Node.js）

```typescript
import { targz, TarGzArchive, parseTarGz, untargz } from "documonster/archive";

// 创建 .tar.gz
const tgzBytes = await targz(new Map([["file.txt", "content"]]), { level: 9 });

// 构建器 API，使用流式 gzip
const archive = new TarGzArchive({ level: 6 });
archive.add("file.txt", "content");
const bytes = await archive.bytes();
for await (const chunk of archive.stream()) {
  /* process chunk */
}

// 解析 .tar.gz
const entries = await parseTarGz(tgzBytes);
for (const entry of entries) {
  console.log(entry.info.path, entry.data);
}

// 提取 .tar.gz 到 Map
const files = await untargz(tgzBytes);
```

---

## 文件系统集成（Node.js）

高级 `ArchiveFile` 类，支持磁盘 I/O、glob 模式、目录遍历和提取。

```typescript
import { ArchiveFile } from "documonster/archive";

// 从零创建
const af = new ArchiveFile();
af.addFile("./src/index.ts");
af.addText("Hello", "hello.txt");
af.addBuffer(bytes, "data.bin");
af.addDirectory("./src", { recursive: true });
af.addGlob("**/*.ts", { cwd: "./src" });
await af.writeToFile("output.zip");

// 打开现有归档
const af = await ArchiveFile.fromFile("archive.zip");
const entries = await af.getEntries();
const data = await af.readEntry("file.txt");
const text = await af.readAsText("file.txt");

// 提取
await af.extractTo("./output", {
  overwrite: "newer",
  filter: entry => entry.path.endsWith(".txt")
});

// 编辑（仅 ZIP）
af.set("new.txt", "content");
af.delete("old.txt");
af.rename("a.txt", "b.txt");
await af.writeToFile("modified.zip");

// 流式输出
for await (const chunk of af.stream()) {
  /* process chunk */
}
await af.streamToFile("output.zip");

// TAR 格式
const tar = new ArchiveFile({ format: "tar" });
tar.addFile("./data.txt");
await tar.writeToFile("archive.tar");
```

---

## 加密

支持 ZIP 传统加密（旧版）和 AES-256 加密。

```typescript
import { Archive } from "documonster/archive";

// 加密条目（读取时自动处理）
const reader = Archive.unzip(encryptedZip, { password: "secret" });
for await (const entry of reader.entries()) {
  const data = await entry.bytes(); // 自动解密
}

// 远程加密 ZIP
const remote = await Archive.RemoteZipReader.open(url);
const data = await remote.extract("secret.txt", { password: "mypassword" });

// 无需完整提取即可验证密码
const valid = await remote.checkPassword("file.txt", "mypassword");
```

---

## 错误类

```typescript
import {
  ArchiveError,
  ZipParseError,
  InvalidZipSignatureError,
  EocdNotFoundError,
  DecryptionError,
  PasswordRequiredError,
  FileTooLargeError,
  UnsupportedCompressionError,
  EntrySizeMismatchError,
  Crc32MismatchError,
  RangeNotSupportedError,
  HttpRangeError,
  AbortError
} from "documonster/archive";
```

---

## API 参考

### 高级函数

| 函数                                 | 描述                       |
| ------------------------------------ | -------------------------- |
| `Archive.zip(options?)`              | 创建新归档（ZIP 或 TAR）   |
| `Archive.unzip(source, options?)`    | 打开归档进行读取           |
| `Archive.editZip(source, options?)`  | 打开 ZIP 进行编辑          |
| `Archive.editZipUrl(url, options?)`  | 打开远程 ZIP 进行编辑      |
| `Archive.tar(entries, options?)`     | 从条目创建 TAR（异步）     |
| `Archive.tarSync(entries, options?)` | 从条目创建 TAR（同步）     |
| `targz(entries, options?)`           | 创建 .tar.gz（仅 Node.js） |

### 类

| 类                        | 描述                          |
| ------------------------- | ----------------------------- |
| `Archive.ZipArchive`      | 流式 ZIP 构建器               |
| `Archive.ZipReader`       | 流式 ZIP 读取器               |
| `Archive.UnzipEntry`      | 单个归档条目                  |
| `Archive.ZipEditor`       | 编辑现有 ZIP 归档             |
| `Archive.TarArchive`      | 流式 TAR 构建器               |
| `Archive.TarReader`       | 流式 TAR 读取器               |
| `TarGzArchive`            | TAR + GZIP 构建器（Node.js）  |
| `Archive.RemoteZipReader` | 基于 HTTP Range 的 ZIP 读取器 |
| `ArchiveFile`             | 文件系统集成（Node.js）       |

### 压缩

| 函数                          | 描述                 |
| ----------------------------- | -------------------- |
| `compress / compressSync`     | DEFLATE-RAW 压缩     |
| `decompress / decompressSync` | DEFLATE-RAW 解压     |
| `gzip / gzipSync`             | GZIP 压缩            |
| `gunzip / gunzipSync`         | GZIP 解压            |
| `zlib / zlibSync`             | Zlib 压缩            |
| `unzlib / unzlibSync`         | Zlib 解压            |
| `decompressAuto`              | 自动检测并解压       |
| `createDeflateStream`         | 流式 DEFLATE 压缩器  |
| `createInflateStream`         | 流式 DEFLATE 解压器  |
| `createGzipStream`            | 流式 GZIP 压缩器     |
| `createGunzipStream`          | 流式 GZIP 解压器     |
| `crc32`                       | CRC32 校验和         |
| `encodePng`                   | RGBA 像素转 PNG 字节 |
