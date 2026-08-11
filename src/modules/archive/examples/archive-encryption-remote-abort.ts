/**
 * Example: Archive Module — AES Encryption, Remote ZIP & Abort Signals
 *
 * Fills coverage gaps promised by archive-complete.ts but not demonstrated there:
 * - AES-encrypted ZIP (aes-128 / aes-192 / aes-256) via ArchiveFile, with
 *   decrypt round-trip verification.
 * - Low-level AES primitives: Archive.aesEncrypt / Archive.aesDecrypt and
 *   Archive.buildAesExtraField.
 * - Random-access / "remote" ZIP reading via Archive.RemoteZipReader, fed by an
 *   in-memory RandomAccessReader from Archive.createBufferReader (no network):
 *   fromReader() / getEntries() / extract() / getStats() / close().
 * - Abort signals: Archive.throwIfAborted / Archive.isAbortError /
 *   Archive.createAbortError, with an AbortController cancelling a streaming
 *   ZipArchive.operation({ signal }) mid-flight.
 *
 * Usage: npx tsx src/modules/archive/examples/archive-encryption-remote-abort.ts
 * Output: tmp/archive-examples/aes-128.zip, aes-192.zip, aes-256.zip
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Archive, ArchiveFile } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/archive-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const decoder = new TextDecoder();

// =============================================================================
// 1. AES-encrypted ZIP via ArchiveFile (high-level)
// =============================================================================
//
// NOTE: AES key strength is selected through the `encryptionMethod` string
// itself — "aes-128" | "aes-192" | "aes-256". The ArchiveFile/ZipFileOptions
// layer does NOT expose a separate `aesKeyStrength` option (that field only
// appears on *read* results in ZipEntryRecord). See report for details.

console.log("1. AES-encrypted ZIP (high-level ArchiveFile):");

const aesMethods = ["aes-128", "aes-192", "aes-256"] as const;
const aesPassword = "correct horse battery staple";

for (const method of aesMethods) {
  const af = new ArchiveFile({
    format: "zip",
    encryptionMethod: method,
    password: aesPassword
  });
  af.addText(`Top secret, encrypted with ${method}.`, "secret.txt");
  af.addText("Second classified file.", "classified.txt");

  const encrypted = await af.toBuffer();
  const filePath = path.join(outDir, `${method}.zip`);
  fs.writeFileSync(filePath, encrypted);

  // Inspect the metadata: confirm encryption + reported key strength.
  // getEntry() returns ZIP-specific info (isEncrypted / encryptionMethod /
  // aesKeyStrength), whereas getEntries() returns format-agnostic info.
  const reader = ArchiveFile.fromBuffer(encrypted, { format: "zip", password: aesPassword });
  const info = reader.getEntry("secret.txt")!;
  console.log(
    `  ${method}.zip: ${encrypted.length} bytes, ` +
      `encrypted=${info.isEncrypted}, method=${info.encryptionMethod}, ` +
      `keyStrength=${info.aesKeyStrength}`
  );

  // Decrypt round-trip
  const text = await reader.readAsText("secret.txt");
  console.log(`    decrypted "secret.txt": "${text}"`);

  // Wrong password should fail
  try {
    const bad = ArchiveFile.fromBuffer(encrypted, { format: "zip", password: "wrong" });
    await bad.readAsText("secret.txt");
    console.log("    UNEXPECTED: wrong password succeeded");
  } catch {
    console.log("    wrong password correctly rejected");
  }
}

// =============================================================================
// 2. Low-level AES primitives: aesEncrypt / aesDecrypt / buildAesExtraField
// =============================================================================

console.log("\n2. Low-level AES primitives:");

const plaintext = new TextEncoder().encode("Raw AES-256 payload for primitive demo.");
const aesEncrypted = await Archive.aesEncrypt(plaintext, aesPassword, 256);
console.log(
  `  aesEncrypt(256): ${plaintext.length} -> ${aesEncrypted.length} bytes ` +
    `(salt + verify + ciphertext + HMAC)`
);

const aesRoundTrip = await Archive.aesDecrypt(aesEncrypted, aesPassword, 256);
console.log(
  `  aesDecrypt(256) match: ${decoder.decode(aesRoundTrip) === decoder.decode(plaintext)}`
);

// buildAesExtraField: AE-2, 256-bit, original compression method 8 (DEFLATE)
const extraField = Archive.buildAesExtraField(2, 256, 8);
console.log(
  `  buildAesExtraField(AE-2, 256, DEFLATE): ${extraField.length} bytes, ` +
    `header id=0x${((extraField[1]! << 8) | extraField[0]!).toString(16).padStart(4, "0")}`
);

// =============================================================================
// 3. Remote / random-access ZIP reading (no network)
// =============================================================================
//
// Build a multi-file ZIP in memory, then read it back through the same
// random-access path RemoteZipReader uses for HTTP Range requests — but backed
// by an in-memory buffer reader instead of a network socket.

console.log("\n3. Remote (random-access) ZIP reading:");

const sourceZip = await Archive.zip()
  .add("docs/readme.txt", "Read me first. ".repeat(50))
  .add("docs/changelog.txt", "v1.0.0 initial release")
  .add("data/numbers.json", JSON.stringify({ values: [1, 2, 3, 4, 5] }))
  .bytes();

const bufferReader = Archive.createBufferReader(sourceZip);
const remote = await Archive.RemoteZipReader.fromReader(bufferReader);

const remoteEntries = remote.getEntries();
console.log(`  getEntries(): ${remoteEntries.length} entries`);
for (const entry of remoteEntries) {
  console.log(`    ${entry.path} (${entry.type}): ${entry.uncompressedSize} bytes`);
}

// Random-access extract of a single entry — only the bytes for that entry are read
const extracted = await remote.extract("data/numbers.json");
console.log(
  `  extract("data/numbers.json"): ${extracted ? decoder.decode(extracted) : "<missing>"}`
);

const stats = remote.getStats();
console.log(
  `  getStats(): totalSize=${stats.totalSize} bytes, entryCount=${stats.entryCount}` +
    (stats.http ? `, http.requestCount=${stats.http.requestCount}` : " (in-memory, no http stats)")
);

await remote.close();
console.log("  close(): reader released");

// =============================================================================
// 4. Abort signals
// =============================================================================
//
// throwIfAborted / isAbortError / createAbortError, plus a real abort flowing
// through a streaming ZipArchive.operation({ signal }).

console.log("\n4. Abort signals:");

// 4a. Standalone helpers
const standaloneController = new AbortController();
console.log("  throwIfAborted (not aborted): no throw");
Archive.throwIfAborted(standaloneController.signal);

standaloneController.abort();
try {
  Archive.throwIfAborted(standaloneController.signal);
} catch (err) {
  console.log(`  throwIfAborted (aborted) threw, isAbortError=${Archive.isAbortError(err)}`);
}

const manualAbort = Archive.createAbortError("manual cancel");
console.log(
  `  createAbortError("manual cancel"): name=${manualAbort.name}, isAbortError=${Archive.isAbortError(manualAbort)}`
);

// 4b. Abort a streaming ZIP operation mid-flight.
//     ZipArchive.stream() calls throwIfAborted(signal) between entries, so
//     aborting after the first chunk surfaces an AbortError.
const bigZip = new Archive.ZipArchive();
for (let i = 0; i < 50; i++) {
  bigZip.add(`file-${i}.txt`, `Payload for file ${i}. `.repeat(500));
}

const opController = new AbortController();
const op = bigZip.operation({ signal: opController.signal });

let received = 0;
let aborted = false;
try {
  for await (const chunk of op.iterable) {
    received += chunk.length;
    // Cancel as soon as we have seen some output
    if (!opController.signal.aborted) {
      opController.abort();
    }
  }
  console.log("  streaming op completed without abort (unexpected)");
} catch (err) {
  aborted = Archive.isAbortError(err);
  console.log(
    `  streaming ZipArchive.operation aborted after ${received} bytes, isAbortError=${aborted}`
  );
}

console.log("\n=== Encryption / Remote / Abort Examples Complete ===");
