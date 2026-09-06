/**
 * Fetch the pinned XLSB reference corpus into the local cache.
 *
 * Run: `pnpm corpus:xlsb`
 *
 * The files are other projects' test fixtures, pinned by commit and SHA-256 in
 * `xlsb/corpus/manifest.ts`. They are not committed — their licensing is not ours to assume and they
 * do not belong in the published package — so this downloads them into the gitignored `tmp/` cache
 * that `real-world-corpus.node.test.ts` reads.
 *
 * **A digest mismatch fails.** Upstream is free to change a fixture; this module is not free to keep
 * asserting the old bytes while reading the new ones. Re-pinning is a deliberate edit to the manifest,
 * with the layout claims re-checked, rather than something a download quietly does for you.
 *
 * Already-cached files are verified and skipped, so a second run costs no network.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { XLSB_CORPUS } from "../src/modules/excel/xlsb/corpus/manifest.ts";
import { XLSB_CORPUS_CACHE } from "../src/modules/excel/xlsb/corpus/paths.ts";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Bytes already in the cache with the right digest, or `undefined`. */
async function cached(path: string, sha256: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    return digest(bytes) === sha256 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

await mkdir(XLSB_CORPUS_CACHE, { recursive: true });

let fetched = 0;
let skipped = 0;
const problems: string[] = [];

for (const entry of XLSB_CORPUS) {
  const path = join(XLSB_CORPUS_CACHE, entry.name);
  if (await cached(path, entry.sha256)) {
    skipped++;
    continue;
  }
  const response = await fetch(entry.url);
  if (!response.ok) {
    problems.push(`${entry.name}: ${response.status} ${response.statusText} from ${entry.url}`);
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = digest(bytes);
  if (actual !== entry.sha256) {
    // Not written. A fixture whose bytes changed is a fixture whose upstream moved, and silently
    // caching the new ones would leave every layout claim in this module asserted against bytes
    // nobody checked them against.
    problems.push(
      `${entry.name}: expected sha256 ${entry.sha256}, got ${actual}. ` +
        `Upstream changed; re-pin the manifest and re-check the layout claims.`
    );
    continue;
  }
  await writeFile(path, bytes);
  fetched++;
}

if (problems.length > 0) {
  console.error(`✗ corpus:xlsb — ${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

const bytes = XLSB_CORPUS.reduce((total, entry) => total + entry.bytes, 0);
console.log(
  `✓ corpus:xlsb — ${XLSB_CORPUS.length} fixture(s) in ${XLSB_CORPUS_CACHE} ` +
    `(${fetched} fetched, ${skipped} already cached, ${(bytes / 1024).toFixed(0)} KiB), ` +
    `every digest verified.`
);
