# Archive Module

[中文](README_zh.md)

A zero-dependency, cross-platform archive toolkit for creating, reading, and editing ZIP and TAR archives.

```typescript
import { Archive } from "documonster/archive";
```

## Features

- **Zero Dependencies** - Pure TypeScript, no native addons
- **Cross-Platform** - Same API in Node.js and browsers
- **ZIP + TAR** - Unified API for both archive formats
- **Streaming** - True async streaming with backpressure support
- **ZIP Editing** - Filesystem-like editing of existing archives with efficient passthrough
- **Remote Reading** - Read ZIP files via HTTP Range requests (download only what you need)
- **Encryption** - ZIP Traditional and AES-256 encryption/decryption
- **ZIP64** - Large file support (> 4GB files, > 65535 entries)
- **Compression** - DEFLATE, GZIP, and Zlib with sync/async/streaming APIs
- **PNG Encoding** - `encodePng`, because a PNG is a DEFLATE stream with CRC-32-checked chunks
- **Progress & Abort** - Built-in progress callbacks and AbortSignal support
- **File System Integration** - Node.js convenience layer for disk I/O

---

## Quick Start

### Creating a ZIP

```typescript
import { Archive } from "documonster/archive";

// Convenience function
const archive = Archive.zip();
archive.add("hello.txt", "Hello, World!");
archive.add("data.json", JSON.stringify({ key: "value" }));
const bytes = await archive.bytes();

// With options
const archive = Archive.zip({ level: 9, comment: "My archive" });
archive.add("file.txt", content, { modTime: new Date() });
archive.addDirectory("empty-dir/");
archive.addSymlink("link.txt", "hello.txt");
const bytes = await archive.bytes();
```

### Reading a ZIP

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

// Random access by path
const data = await reader.bytes("hello.txt");
```

### Editing a ZIP

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

Factory function that creates a new `ZipArchive` or `TarArchive`.

```typescript
import { Archive } from "documonster/archive";

const archive = Archive.zip(); // ZipArchive
const tarArchive = Archive.zip({ format: "tar" }); // TarArchive
```

### `ZipArchive`

Streaming ZIP archive builder with chainable API.

```typescript
import { Archive } from "documonster/archive";

const archive = new Archive.ZipArchive({ level: 6, reproducible: true });

// Add entries (chainable)
archive
  .add("file.txt", "text content")
  .add("binary.dat", uint8Array)
  .add("from-stream.bin", readableStream)
  .addDirectory("empty-dir/")
  .addSymlink("link.txt", "file.txt");

// Output options:

// 1. Complete Uint8Array
const bytes = await archive.bytes();

// 2. Synchronous (in-memory sources only)
const bytes = archive.bytesSync();

// 3. Async streaming
for await (const chunk of archive.stream()) {
  // Process chunk by chunk
}

// 4. Pipe to WritableStream
await archive.pipeTo(writableStream);

// 5. Operation with progress and abort
const op = archive.operation({
  onProgress: p => console.log(`${p.entriesDone}/${p.entriesTotal}`),
  signal: abortController.signal
});
for await (const chunk of op.iterable) {
  /* process chunk */
}
```

**`ZipOptions`:**

| Option         | Type                       | Default   | Description                               |
| -------------- | -------------------------- | --------- | ----------------------------------------- |
| `level`        | `number`                   | `6`       | Compression level (0 = store, 9 = max)    |
| `comment`      | `string`                   | -         | Archive-level comment                     |
| `reproducible` | `boolean`                  | `false`   | Stable timestamps for reproducible builds |
| `smartStore`   | `boolean`                  | `true`    | Auto-STORE incompressible data            |
| `zip64`        | `"auto" \| boolean`        | `"auto"`  | ZIP64 mode                                |
| `signal`       | `AbortSignal`              | -         | Abort signal                              |
| `onProgress`   | `(p: ZipProgress) => void` | -         | Progress callback                         |
| `encoding`     | `ZipStringEncoding`        | `"utf-8"` | String encoding for names                 |
| `timestamps`   | `ZipTimestampMode`         | -         | Timestamp encoding mode                   |

### `unzip(source, options?)`

Open an archive for reading.

```typescript
import { Archive } from "documonster/archive";

const reader = Archive.unzip(zipBytes);
const reader = Archive.unzip(zipBytes, { password: "secret" });
const reader = Archive.unzip(tarBytes, { format: "tar" });
```

### `ZipReader`

Streaming ZIP reader with random-access support.

```typescript
import { Archive } from "documonster/archive";

const reader = new Archive.ZipReader(zipBytes);

// Streaming iteration
for await (const entry of reader.entries()) {
  const data = await entry.bytes();
  const text = await entry.text();
  // Or stream the entry
  for await (const chunk of entry.stream()) {
    /* process chunk */
  }
  // Or pipe
  await entry.pipeTo(writableStream);
}

// Random access
const entry = await reader.get("path/to/file.txt");
const bytes = await reader.bytes("path/to/file.txt");

// With progress and abort
const op = reader.operation({
  onProgress: p => console.log(`${p.entriesEmitted} entries, ${p.bytesOut} bytes`),
  signal: controller.signal
});
```

### `UnzipEntry`

Represents a single entry in an archive.

```typescript
entry.path; // "path/to/file.txt"
entry.type; // "file" | "directory" | "symlink"
entry.mode; // Unix mode (e.g., 0o644)
entry.linkTarget; // Symlink target (after bytes())

await entry.bytes(); // Uint8Array
await entry.text(); // String (UTF-8)
await entry.text("latin1"); // String (custom encoding)
for await (const chunk of entry.stream()) {
  /* process chunk */
}
await entry.pipeTo(writable);
entry.readableStream(); // WHATWG ReadableStream
entry.discard(); // Skip without reading
```

**`UnzipOptions`:**

| Option       | Type                         | Default   | Description         |
| ------------ | ---------------------------- | --------- | ------------------- |
| `password`   | `string \| Uint8Array`       | -         | Decryption password |
| `encoding`   | `ZipStringEncoding`          | `"utf-8"` | Entry name encoding |
| `signal`     | `AbortSignal`                | -         | Abort signal        |
| `onProgress` | `(p: UnzipProgress) => void` | -         | Progress callback   |

---

## ZIP Editor

Filesystem-like editing of existing ZIP archives. Unchanged entries are passed through efficiently (raw compressed bytes preserved).

```typescript
import { Archive } from "documonster/archive";

// From bytes
const editor = await Archive.editZip(zipBytes, {
  reproducible: true,
  preserve: "best-effort",
  onWarning: w => console.warn(w.code, w.entry, w.message)
});

// From URL (HTTP Range requests)
const editor = await Archive.editZipUrl("https://example.com/archive.zip");

// Operations
editor.has("file.txt"); // Check existence
editor.set("new.txt", "content"); // Add or replace
editor.delete("old.txt"); // Delete entry
editor.deleteDirectory("old-dir/"); // Delete directory recursively
editor.rename("a.txt", "b.txt"); // Rename entry
editor.setComment("Updated archive"); // Set archive comment

// Reusable edit plans
import { Archive } from "documonster/archive";

const plan = new Archive.ZipEditPlan();
plan.set("config.json", newConfig);
plan.delete("temp/");
editor.apply(plan);

// Output
const output = await editor.bytes();
await editor.pipeTo(writable);
for await (const chunk of editor.stream()) {
  /* process chunk */
}
```

---

## Remote ZIP Reader

Read ZIP files from HTTP servers using Range requests -- download only the entries you need.

```typescript
import { Archive } from "documonster/archive";

const reader = await Archive.RemoteZipReader.open("https://example.com/large.zip");

// Metadata (no content downloaded yet)
const entries = reader.getEntries();
console.log(`${entries.length} entries`);

const files = reader.listFiles();
const count = reader.getFileCount();

// Find entries by pattern
const jsFiles = reader.findEntries("**/*.js");

// Extract single file (downloads only that entry)
const data = await reader.extract("path/to/file.txt");

// Extract multiple (batched for efficiency)
const results = await reader.extractMultiple(["a.txt", "b.txt"]);

// Streaming extraction
await reader.extractToStream("large-file.bin", writableStream);

// Password-protected archives
const reader = await Archive.RemoteZipReader.open(url);
const isValid = await reader.checkPassword("secret.txt", "mypassword");
const data = await reader.extract("secret.txt", { password: "mypassword" });

// Statistics
const stats = reader.getStats();
console.log(`Downloaded ${stats.http?.bytesDownloaded} bytes (${stats.http?.downloadedPercent}%)`);

await reader.close();
```

---

## Compression API

Low-level compression utilities. DEFLATE, GZIP, and Zlib with sync, async, and streaming variants.

### One-Shot Compression

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

// DEFLATE-RAW (used by ZIP files)
const compressed = await compress(data, { level: 9 });
const original = await decompress(compressed);
const compressedSync = compressSync(data);

// GZIP
const gzipped = await gzip(data);
const ungzipped = await gunzip(gzipped);

// Zlib (RFC 1950)
const zlibbed = await zlib(data);
const unzlibbed = await unzlib(zlibbed);

// Auto-detect and decompress
const format = detectCompressionFormat(data); // "gzip" | "zlib" | "deflate-raw"
const original = await decompressAuto(data);
```

### Streaming Compression

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

// DEFLATE-RAW streaming
const deflater = createDeflateStream({ level: 6 });
const inflater = createInflateStream();

// GZIP streaming
const gzipper = createGzipStream();
const gunzipper = createGunzipStream();

// Zlib streaming
const zlibber = createZlibStream();
const unzlibber = createUnzlibStream();

// Check availability
hasDeflateRaw(); // true in Node.js, depends on CompressionStream in browser
```

### CRC32

```typescript
import { crc32, crc32Update, crc32Finalize } from "documonster/archive";

// One-shot
const checksum = crc32(data);

// Incremental (streaming)
let state = 0xffffffff;
state = crc32Update(state, chunk1);
state = crc32Update(state, chunk2);
const checksum = crc32Finalize(state);
```

### PNG encoding

A PNG is a DEFLATE stream plus CRC-32-checked chunks — the two primitives above — so the
encoder lives here rather than in a module that merely happens to need pictures. It exists
because the drawing engine deliberately stops at pixels: `rasterizeToRgba` from
`documonster/draw` hands back RGBA, and encoding needs DEFLATE, which sits a layer above
`draw`.

```typescript
import { encodePng } from "documonster/archive";
import { rasterizeToRgba } from "documonster/draw";

// From any display list — a chart, a Mermaid diagram, your own producer
const image = rasterizeToRgba(list, { scale: 2 });
const png = encodePng(image.data, image.width, image.height, { dpi: 192 });

// Or from pixels you already have (8-bit RGBA, row-major)
const bytes = encodePng(rgba, width, height);
```

8-bit RGBA in, filter 0, one `IDAT`. `dpi` writes a `pHYs` chunk; omit it and none is
written.

---

## TAR Support

Unified API compatible with the ZIP interface.

### Creating TAR archives

```typescript
import { Archive } from "documonster/archive";

// Convenience function
const tarBytes = await Archive.tar(
  new Map([
    ["file.txt", "content"],
    ["data.bin", uint8Array]
  ]),
  { modTime: new Date() }
);

// Builder API (same as ZipArchive)
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

### Reading TAR archives

```typescript
import { Archive } from "documonster/archive";

// Via unified API
const reader = Archive.unzip(tarBytes, { format: "tar" });

// Direct
const reader = new Archive.TarReader(tarBytes);
for await (const entry of reader.entries()) {
  console.log(entry.path, entry.isDirectory);
  const data = await entry.bytes();
}

// Random access
const data = await reader.bytes("file.txt");
const paths = await reader.list();
```

### TAR + GZIP (Node.js only)

```typescript
import { targz, TarGzArchive, parseTarGz, untargz } from "documonster/archive";

// Create .tar.gz
const tgzBytes = await targz(new Map([["file.txt", "content"]]), { level: 9 });

// Builder API with streaming gzip
const archive = new TarGzArchive({ level: 6 });
archive.add("file.txt", "content");
const bytes = await archive.bytes();
for await (const chunk of archive.stream()) {
  /* process chunk */
}

// Parse .tar.gz
const entries = await parseTarGz(tgzBytes);
for (const entry of entries) {
  console.log(entry.info.path, entry.data);
}

// Extract .tar.gz to Map
const files = await untargz(tgzBytes);
```

---

## File System Integration (Node.js)

High-level `ArchiveFile` class with disk I/O, glob patterns, directory traversal, and extraction.

```typescript
import { ArchiveFile } from "documonster/archive";

// Create from scratch
const af = new ArchiveFile();
af.addFile("./src/index.ts");
af.addText("Hello", "hello.txt");
af.addBuffer(bytes, "data.bin");
af.addDirectory("./src", { recursive: true });
af.addGlob("**/*.ts", { cwd: "./src" });
await af.writeToFile("output.zip");

// Open existing
const af = await ArchiveFile.fromFile("archive.zip");
const entries = await af.getEntries();
const data = await af.readEntry("file.txt");
const text = await af.readAsText("file.txt");

// Extract
await af.extractTo("./output", {
  overwrite: "newer",
  filter: entry => entry.path.endsWith(".txt")
});

// Edit (ZIP only)
af.set("new.txt", "content");
af.delete("old.txt");
af.rename("a.txt", "b.txt");
await af.writeToFile("modified.zip");

// Streaming output
for await (const chunk of af.stream()) {
  /* process chunk */
}
await af.streamToFile("output.zip");

// TAR format
const tar = new ArchiveFile({ format: "tar" });
tar.addFile("./data.txt");
await tar.writeToFile("archive.tar");
```

---

## Encryption

ZIP Traditional (legacy) and AES-256 encryption support.

```typescript
import { Archive } from "documonster/archive";

// Encrypted entries (handled automatically during read)
const reader = Archive.unzip(encryptedZip, { password: "secret" });
for await (const entry of reader.entries()) {
  const data = await entry.bytes(); // Automatically decrypted
}

// Remote encrypted ZIP
const remote = await Archive.RemoteZipReader.open(url);
const data = await remote.extract("secret.txt", { password: "mypassword" });

// Check password without full extraction
const valid = await remote.checkPassword("file.txt", "mypassword");
```

---

## Error Classes

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

## API Reference

### High-Level Functions

| Function                             | Description                       |
| ------------------------------------ | --------------------------------- |
| `Archive.zip(options?)`              | Create a new archive (ZIP or TAR) |
| `Archive.unzip(source, options?)`    | Open an archive for reading       |
| `Archive.editZip(source, options?)`  | Open a ZIP for editing            |
| `Archive.editZipUrl(url, options?)`  | Open a remote ZIP for editing     |
| `Archive.tar(entries, options?)`     | Create TAR from entries (async)   |
| `Archive.tarSync(entries, options?)` | Create TAR from entries (sync)    |
| `targz(entries, options?)`           | Create .tar.gz (Node.js only)     |

### Classes

| Class                     | Description                       |
| ------------------------- | --------------------------------- |
| `Archive.ZipArchive`      | Streaming ZIP builder             |
| `Archive.ZipReader`       | Streaming ZIP reader              |
| `Archive.UnzipEntry`      | Single archive entry              |
| `Archive.ZipEditor`       | Edit existing ZIP archives        |
| `Archive.TarArchive`      | Streaming TAR builder             |
| `Archive.TarReader`       | Streaming TAR reader              |
| `TarGzArchive`            | TAR + GZIP builder (Node.js)      |
| `Archive.RemoteZipReader` | HTTP Range-based ZIP reader       |
| `ArchiveFile`             | File system integration (Node.js) |

### Compression

| Function                      | Description                    |
| ----------------------------- | ------------------------------ |
| `compress / compressSync`     | DEFLATE-RAW compress           |
| `decompress / decompressSync` | DEFLATE-RAW decompress         |
| `gzip / gzipSync`             | GZIP compress                  |
| `gunzip / gunzipSync`         | GZIP decompress                |
| `zlib / zlibSync`             | Zlib compress                  |
| `unzlib / unzlibSync`         | Zlib decompress                |
| `decompressAuto`              | Auto-detect and decompress     |
| `createDeflateStream`         | Streaming DEFLATE compressor   |
| `createInflateStream`         | Streaming DEFLATE decompressor |
| `createGzipStream`            | Streaming GZIP compressor      |
| `createGunzipStream`          | Streaming GZIP decompressor    |
| `crc32`                       | CRC32 checksum                 |
| `encodePng`                   | RGBA pixels to PNG bytes       |
