/**
 * Example: Archive Module — Functional TAR API, tar.gz & Error Handling
 *
 * Fills coverage gaps promised by archive-complete.ts but not demonstrated there:
 * - Functional (non-class) TAR API: Archive.tarSync / Archive.parseTar /
 *   Archive.untar and the Archive.TarReader streaming reader.
 * - Functional gzipped TAR: targz() to build a .tar.gz and untargz() to read it
 *   back into a Map (these live on the Node entrypoint, not the Archive namespace).
 * - Error class handling: deliberately trigger and catch ZipParseError,
 *   Crc32MismatchError, and PasswordRequiredError.
 *
 * Usage: pnpm example --filter archive-functional-tar-errors
 * Output: tmp/archive-examples/functional.tar, functional.tar.gz
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Archive,
  ArchiveFile,
  targz,
  untargz,
  ZipParseError,
  Crc32MismatchError,
  PasswordRequiredError
} from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/archive-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const decoder = new TextDecoder();

// =============================================================================
// 1. Functional TAR creation — Archive.tarSync
// =============================================================================
//
// tarSync() accepts a Map<name, content> (or an iterable of [name, source]).

console.log("1. Functional TAR (Archive.tarSync):");

const tarBytes = Archive.tarSync(
  new Map<string, string | Uint8Array>([
    ["readme.txt", "Functional TAR built with tarSync()."],
    ["nested/data.json", JSON.stringify({ ok: true, count: 3 })],
    ["bytes.bin", new Uint8Array([0, 1, 2, 3, 255])]
  ])
);
fs.writeFileSync(path.join(outDir, "functional.tar"), tarBytes);
console.log(`  functional.tar: ${tarBytes.length} bytes (sync)`);

// =============================================================================
// 2. Functional TAR parsing — Archive.parseTar
// =============================================================================

console.log("\n2. Functional parse (Archive.parseTar):");

const parsed = Archive.parseTar(tarBytes);
for (const entry of parsed) {
  const data = await entry.data();
  console.log(`  ${entry.info.path} (type=${entry.info.type}): ${data.length} bytes`);
}

// =============================================================================
// 3. Functional TAR extract-to-Map — Archive.untar
// =============================================================================

console.log("\n3. Functional extract (Archive.untar):");

const tarMap = await Archive.untar(tarBytes);
console.log(`  untar() returned ${tarMap.size} entries`);
const readmeEntry = tarMap.get("readme.txt");
if (readmeEntry) {
  console.log(`    readme.txt: "${decoder.decode(readmeEntry.data)}"`);
}

// =============================================================================
// 4. Streaming TAR reader — Archive.TarReader
// =============================================================================

console.log("\n4. Streaming reader (Archive.TarReader):");

const tarReader = new Archive.TarReader(tarBytes);
for await (const entry of tarReader.entries()) {
  console.log(`  ${entry.path}: ${entry.info.size} bytes (isDirectory=${entry.isDirectory})`);
}

// Random-access lookup by path
const dataEntry = await tarReader.get("nested/data.json");
if (dataEntry) {
  console.log(`  get("nested/data.json"): ${decoder.decode(await dataEntry.bytes())}`);
}

// =============================================================================
// 5. Functional gzipped TAR — targz() / untargz()
// =============================================================================
//
// targz / untargz are Node-only (require zlib) and exported from the package
// entrypoint rather than the platform-agnostic Archive namespace.

console.log("\n5. Functional tar.gz (targz / untargz):");

const tgzBytes = await targz(
  new Map<string, string>([
    ["log.txt", "Compressible log line. ".repeat(200)],
    ["meta.json", JSON.stringify({ compressed: true })]
  ])
);
fs.writeFileSync(path.join(outDir, "functional.tar.gz"), tgzBytes);
console.log(`  functional.tar.gz: ${tgzBytes.length} bytes (gzipped)`);

const tgzMap = await untargz(tgzBytes);
console.log(`  untargz() returned ${tgzMap.size} entries`);
for (const [name, { data }] of tgzMap) {
  console.log(`    ${name}: ${data.length} bytes`);
}

// =============================================================================
// 6. Error handling — ZipParseError
// =============================================================================
//
// Feed garbage to the ZIP parser. The reader is lazy, so iterate to force a
// parse and surface the error.

console.log("\n6. Error handling:");

try {
  const junk = new Uint8Array(64).fill(0x42); // not a ZIP — no EOCD
  const reader = Archive.unzip(junk);
  for await (const _entry of reader.entries()) {
    // force parsing
    void _entry;
  }
  console.log("  ZipParseError: UNEXPECTED — no error thrown");
} catch (err) {
  console.log(
    `  ZipParseError caught: ${err instanceof ZipParseError}` +
      ` (name=${err instanceof Error ? err.name : "?"})`
  );
}

// =============================================================================
// 7. Error handling — Crc32MismatchError
// =============================================================================
//
// Build a STORED (uncompressed) ZIP so we can flip a payload byte without
// breaking decompression, then read it back with CRC checking enabled. The
// RemoteZipReader.extract({ checkCrc32: true }) path validates the checksum and
// throws Crc32MismatchError on mismatch.

try {
  const marker = "ZZZUNIQUEPAYLOADZZZ";
  const goodZip = await Archive.zip({ level: 0 }).add("payload.txt", marker).bytes();

  // Locate the stored payload by its unique marker and flip one of its bytes.
  const corrupted = goodZip.slice();
  const markerBytes = new TextEncoder().encode(marker);
  let idx = -1;
  for (let i = 0; i + markerBytes.length <= corrupted.length; i++) {
    let match = true;
    for (let j = 0; j < markerBytes.length; j++) {
      if (corrupted[i + j] !== markerBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    corrupted[idx] = corrupted[idx]! ^ 0xff;
  }

  const reader = await Archive.RemoteZipReader.fromReader(Archive.createBufferReader(corrupted));
  await reader.extract("payload.txt", { checkCrc32: true });
  await reader.close();
  console.log("  Crc32MismatchError: UNEXPECTED — no error thrown");
} catch (err) {
  console.log(
    `  Crc32MismatchError caught: ${err instanceof Crc32MismatchError}` +
      ` (name=${err instanceof Error ? err.name : "?"})`
  );
}

// =============================================================================
// 8. Error handling — PasswordRequiredError
// =============================================================================
//
// Create an encrypted ZIP, then attempt extraction without a password via the
// random-access reader, which routes through the decrypt path and throws.

try {
  const af = new ArchiveFile({
    format: "zip",
    encryptionMethod: "aes-256",
    password: "pw"
  });
  af.addText("needs a password", "secret.txt");
  const encrypted = await af.toBuffer();

  const reader = await Archive.RemoteZipReader.fromReader(Archive.createBufferReader(encrypted));
  await reader.extract("secret.txt"); // no password supplied → throws
  await reader.close();
  console.log("  PasswordRequiredError: UNEXPECTED — no error thrown");
} catch (err) {
  console.log(
    `  PasswordRequiredError caught: ${err instanceof PasswordRequiredError}` +
      ` (name=${err instanceof Error ? err.name : "?"})`
  );
}

console.log("\n=== Functional TAR / tar.gz / Error Examples Complete ===");
