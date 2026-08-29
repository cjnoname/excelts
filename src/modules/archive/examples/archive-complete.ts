/**
 * Example: Archive Module — Complete Guide
 *
 * Covers:
 * - Creating ZIP archives from buffers, strings, and streams
 * - ZipArchive: add files, directories, symlinks
 * - Compression levels, store mode
 * - Streaming ZIP output (async iterable)
 * - Progress tracking and abort signals
 * - Reading/extracting ZIP archives with unzip/ZipReader
 * - ZipEditor: modify existing ZIPs (add, delete, rename)
 * - ZipEditPlan for serializable edit operations
 * - TAR archives: create, read, and extract
 * - TAR + GZIP (tar.gz) support
 * - Compression utilities: gzip, zlib, deflate-raw
 * - CRC32 computation
 * - ZIP encryption: ZipCrypto and AES
 * - ArchiveFile: high-level file-system operations
 * - Remote ZIP reading via HTTP Range requests
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Archive,
  TarGzArchive,
  ArchiveFile,
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
  crc32,
  createDeflateStream,
  createInflateStream,
  isGzipData,
  isZlibData,
  detectCompressionFormat
} from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/archive-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// =============================================================================
// 1. Create a ZIP — simplest way
// =============================================================================

const archive1 = Archive.zip();
archive1.add("hello.txt", "Hello, World!");
archive1.add("data.json", JSON.stringify({ name: "test", value: 42 }));
archive1.add("binary.bin", new Uint8Array([0x00, 0x01, 0x02, 0xff]));

const zipBytes1 = await archive1.bytes();
fs.writeFileSync(path.join(outDir, "basic.zip"), zipBytes1);
console.log("1. basic.zip — 3 entries,", zipBytes1.length, "bytes");

// =============================================================================
// 2. Compression levels
// =============================================================================

const largeText = "The quick brown fox jumps over the lazy dog. ".repeat(1000);

const zipLevel0 = await Archive.zip({ level: 0 }).add("text.txt", largeText).bytes();
const zipLevel1 = await Archive.zip({ level: 1 }).add("text.txt", largeText).bytes();
const zipLevel9 = await Archive.zip({ level: 9 }).add("text.txt", largeText).bytes();

console.log("2. Compression levels:");
console.log("  Level 0 (store):", zipLevel0.length, "bytes");
console.log("  Level 1 (fast):", zipLevel1.length, "bytes");
console.log("  Level 9 (best):", zipLevel9.length, "bytes");

// =============================================================================
// 3. ZipArchive with directories and symlinks
// =============================================================================

const archive3 = new Archive.ZipArchive({ level: 6, timestamps: "dos" });
archive3.add("src/main.ts", 'console.log("hello");');
archive3.add("src/utils/helper.ts", "export const PI = 3.14;");
archive3.addDirectory("src/empty/");
archive3.addSymlink("src/link.ts", "main.ts");

const zipBytes3 = await archive3.bytes();
fs.writeFileSync(path.join(outDir, "with-dirs.zip"), zipBytes3);
console.log("3. with-dirs.zip — directories + symlink");

// =============================================================================
// 4. Synchronous ZIP creation
// =============================================================================

const archive4 = new Archive.ZipArchive();
archive4.add("sync.txt", "Created synchronously");
archive4.add("data.csv", "name,age\nAlice,30\nBob,25");

const zipSync4 = archive4.bytesSync();
fs.writeFileSync(path.join(outDir, "sync.zip"), zipSync4);
console.log("4. sync.zip —", zipSync4.length, "bytes (sync)");

// =============================================================================
// 5. Streaming ZIP output
// =============================================================================

const archive5 = new Archive.ZipArchive();
archive5.add("stream1.txt", "First file");
archive5.add("stream2.txt", "Second file");

let streamSize = 0;
for await (const chunk of archive5.stream()) {
  streamSize += chunk.length;
}
console.log("5. Streaming output: total", streamSize, "bytes");

// =============================================================================
// 6. Progress tracking
// =============================================================================

const archive6 = new Archive.ZipArchive();
for (let i = 0; i < 10; i++) {
  archive6.add(`file-${i}.txt`, `Content of file ${i}`);
}

const op6 = archive6.operation({
  onProgress: p => {
    if (p.entriesDone === p.entriesTotal) {
      console.log(`6. Progress: ${p.entriesDone}/${p.entriesTotal} entries done`);
    }
  }
});

const chunks6: Uint8Array[] = [];
for await (const chunk of op6.iterable) {
  chunks6.push(chunk);
}

// =============================================================================
// 7. Read/extract ZIP
// =============================================================================

const reader7 = Archive.unzip(zipBytes1);
console.log("\n7. Reading basic.zip:");
for await (const entry of reader7.entries()) {
  const bytes = await entry.bytes();
  console.log(`  ${entry.path} (${entry.type}): ${bytes.length} bytes`);
}

// Read specific entry
const helloEntry = await reader7.get("hello.txt");
if (helloEntry) {
  const text = decoder.decode(await helloEntry.bytes());
  console.log(`  hello.txt content: "${text}"`);
}

// =============================================================================
// 8. ZipEditor — modify existing archives
// =============================================================================

const editor8 = await Archive.ZipEditor.open(zipBytes1);
editor8.set("new-file.txt", "Added by editor");
editor8.delete("binary.bin");
editor8.rename("hello.txt", "greeting.txt");

const editedZip = await editor8.bytes();
fs.writeFileSync(path.join(outDir, "edited.zip"), editedZip);
console.log("\n8. edited.zip — added, deleted, renamed entries");

// Verify
const reader8 = Archive.unzip(editedZip);
console.log("  Entries after edit:");
for await (const entry of reader8.entries()) {
  console.log(`    ${entry.path}`);
}

// =============================================================================
// 9. ZipEditPlan — serializable edit operations
// =============================================================================

const plan = new Archive.ZipEditPlan();
plan.set("readme.md", "# Updated README");
plan.delete("data.json");

const editor9 = await Archive.ZipEditor.open(zipBytes1);
editor9.apply(plan);

const planned = await editor9.bytes();
console.log("\n9. ZipEditPlan applied:", planned.length, "bytes");

// =============================================================================
// 10. TAR archives
// =============================================================================

const tar10 = new Archive.TarArchive();
tar10.add("file1.txt", "TAR content 1");
tar10.add("file2.txt", "TAR content 2");
tar10.add("dir/file3.txt", "Nested file");

const tarBytes = await tar10.bytes();
fs.writeFileSync(path.join(outDir, "archive.tar"), tarBytes);
console.log("\n10. archive.tar —", tarBytes.length, "bytes");

// Read TAR
const tarReader = Archive.unzip(tarBytes, { format: "tar" });
console.log("  TAR entries:");
for await (const entry of tarReader.entries()) {
  console.log(`    ${entry.path} (${entry.isDirectory ? "dir" : "file"})`);
}

// =============================================================================
// 11. TAR + GZIP (tar.gz)
// =============================================================================

const targz11 = new TarGzArchive();
targz11.add("data.txt", "Compressed TAR content ".repeat(100));

const tgzBytes = await targz11.bytes();
fs.writeFileSync(path.join(outDir, "archive.tar.gz"), tgzBytes);
console.log("\n11. archive.tar.gz —", tgzBytes.length, "bytes");
console.log("  Is gzip:", isGzipData(tgzBytes));

// =============================================================================
// 12. Compression utilities — deflate-raw
// =============================================================================

const original12 = encoder.encode("Hello, compression! ".repeat(100));

const compressed12 = await compress(original12, { level: 6 });
const decompressed12 = await decompress(compressed12);
console.log("\n12. Deflate-raw compression:");
console.log("  Original:", original12.length, "bytes");
console.log("  Compressed:", compressed12.length, "bytes");
console.log("  Decompressed:", decompressed12.length, "bytes");
console.log("  Match:", decoder.decode(decompressed12) === decoder.decode(original12));

// Sync versions
const compSync = compressSync(original12, { level: 9 });
const decompSync = decompressSync(compSync);
console.log("  Sync compressed:", compSync.length, "bytes");
console.log("  Sync match:", decoder.decode(decompSync) === decoder.decode(original12));

// =============================================================================
// 13. GZIP compression
// =============================================================================

const gzipped = await gzip(original12, { level: 6 });
const gunzipped = await gunzip(gzipped);
console.log("\n13. GZIP:");
console.log("  Gzipped:", gzipped.length, "bytes");
console.log("  Is gzip:", isGzipData(gzipped));
console.log("  Gunzipped match:", decoder.decode(gunzipped) === decoder.decode(original12));

// Sync
const gzSync = gzipSync(original12);
const gunzSync = gunzipSync(gzSync);
console.log("  Sync gzip:", gzSync.length, "bytes");
console.log("  Sync match:", decoder.decode(gunzSync) === decoder.decode(original12));

// =============================================================================
// 14. Zlib compression
// =============================================================================

const zlibbed = await zlib(original12, { level: 6 });
const unzlibbed = await unzlib(zlibbed);
console.log("\n14. Zlib:");
console.log("  Zlib:", zlibbed.length, "bytes");
console.log("  Is zlib:", isZlibData(zlibbed));
console.log("  Unzlib match:", decoder.decode(unzlibbed) === decoder.decode(original12));

// =============================================================================
// 15. Auto-detect compression format
// =============================================================================

console.log("\n15. Format detection:");
console.log("  Gzip data:", detectCompressionFormat(gzipped));
console.log("  Zlib data:", detectCompressionFormat(zlibbed));
console.log("  Raw data:", detectCompressionFormat(original12));

// =============================================================================
// 16. CRC32
// =============================================================================

const crcValue = crc32(encoder.encode("Hello, World!"));
console.log("\n16. CRC32:", "0x" + (crcValue >>> 0).toString(16).padStart(8, "0"));

// =============================================================================
// 17. Streaming compression
// =============================================================================

console.log("\n17. Streaming compression:");

const deflateStream = createDeflateStream({ level: 6 });
const inflateStream = createInflateStream();

const compressedChunks: Uint8Array[] = [];
deflateStream.on("data", (chunk: Uint8Array) => compressedChunks.push(chunk));

const decompressedChunks: Uint8Array[] = [];
inflateStream.on("data", (chunk: Uint8Array) => decompressedChunks.push(chunk));

// Pipe: deflate → inflate
deflateStream.on("data", (chunk: Uint8Array) => inflateStream.write(chunk));
deflateStream.on("end", () => inflateStream.end());

// Write data
deflateStream.write(encoder.encode("Chunk 1. "));
deflateStream.write(encoder.encode("Chunk 2. "));
deflateStream.write(encoder.encode("Chunk 3."));

await new Promise<void>(resolve => {
  inflateStream.on("end", resolve);
  deflateStream.end();
});

const totalCompressed = compressedChunks.reduce((s, c) => s + c.length, 0);
const totalDecompressed = decompressedChunks.reduce((s, c) => s + c.length, 0);
console.log("  Compressed:", totalCompressed, "bytes");
console.log("  Decompressed:", totalDecompressed, "bytes");

// =============================================================================
// 18. ZIP encryption — ZipCrypto via ArchiveFile
// =============================================================================

console.log("\n18. ZIP encryption:");

const af18 = new ArchiveFile({
  format: "zip",
  encryptionMethod: "zipcrypto",
  password: "secret123"
});
af18.addText("This is encrypted content", "secret.txt");
af18.addText("Another secret file", "classified.txt");

const encryptedZip = await af18.toBuffer();
fs.writeFileSync(path.join(outDir, "encrypted.zip"), encryptedZip);
console.log("  encrypted.zip:", encryptedZip.length, "bytes");

// Read back with password
const af18b = ArchiveFile.fromBuffer(encryptedZip, {
  format: "zip",
  password: "secret123"
});
const secretText = await af18b.readAsText("secret.txt");
console.log(`  Decrypted: "${secretText}"`);

// =============================================================================
// 19. ArchiveFile — high-level file system operations
// =============================================================================

console.log("\n19. ArchiveFile:");

// Create from scratch
const af19 = new ArchiveFile({ format: "zip", level: 6 });
af19.addText("Hello from ArchiveFile!", "greeting.txt");
af19.addBuffer(new Uint8Array([1, 2, 3, 4, 5]), "data.bin");

const outPath19 = path.join(outDir, "archive-file.zip");
// `writeToFile` defaults to `overwrite: "error"` so it can never clobber a file
// the caller did not mean to replace. An example has to be re-runnable, and the
// second run always finds its own output from the first, so it opts in.
await af19.writeToFile(outPath19, { overwrite: "overwrite" });
console.log("  Written:", outPath19);

// Read back
const af19b = await ArchiveFile.fromFile(outPath19, { format: "zip" });
const entries19 = await af19b.getEntries();
console.log("  Entries:", entries19.length);
for (const e of entries19) {
  console.log(`    ${e.path} (${e.size} bytes, ${e.isDirectory ? "dir" : "file"})`);
}

// Extract specific entry
const greeting = await af19b.readAsText("greeting.txt");
console.log(`  greeting.txt: "${greeting}"`);

// Extract to directory
const extractDir = path.join(outDir, "extracted");
// `extractTo` also defaults to `overwrite: "error"` — same reason, same opt-in.
await af19b.extractTo(extractDir, { overwrite: "overwrite" });
console.log("  Extracted to:", extractDir);

// =============================================================================
// 20. ArchiveFile — add directories and globs
// =============================================================================

console.log("\n20. Directory and glob operations:");

const af20 = new ArchiveFile({ format: "zip" });

// Add the extracted directory back
af20.addDirectory(extractDir, { prefix: "re-archived" });

const zipBytes20 = await af20.toBuffer();
console.log("  Re-archived:", zipBytes20.length, "bytes");

// =============================================================================
// 21. Reproducible ZIP output
// =============================================================================

const repro1 = await new Archive.ZipArchive({ reproducible: true }).add("a.txt", "hello").bytes();

const repro2 = await new Archive.ZipArchive({ reproducible: true }).add("a.txt", "hello").bytes();

console.log("\n21. Reproducible output:");
console.log(
  "  Same bytes:",
  repro1.length === repro2.length && repro1.every((b, i) => b === repro2[i])
);

// =============================================================================
// 22. Smart store — auto-detect incompressible data
// =============================================================================

const randomData = new Uint8Array(1000);
for (let i = 0; i < randomData.length; i++) {
  randomData[i] = Math.floor(Math.random() * 256);
}

const smartZip = await new Archive.ZipArchive({ smartStore: true })
  .add("random.bin", randomData)
  .add("text.txt", "Compressible ".repeat(100))
  .bytes();

console.log("\n22. Smart store:", smartZip.length, "bytes");
console.log("  (random data stored, text compressed)");

console.log("\n=== Archive Examples Complete ===");
