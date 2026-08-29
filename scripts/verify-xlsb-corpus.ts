import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Workbook } from "../dist/esm/modules/excel/index.js";

type CorpusSourceEncoding = "binary" | "base64";
type CorpusResultStatus = "passed" | "expected-rejection" | "failed";

interface CorpusSource {
  revision: string;
  urlTemplate: string;
  encoding: CorpusSourceEncoding;
}

interface CorpusFixture {
  source: string;
  path: string;
  sha256: string;
  expectedError?: string;
}

interface CorpusManifest {
  version: 1;
  sources: Record<string, CorpusSource>;
  fixtures: CorpusFixture[];
}

interface CorpusExpectation {
  expectedError?: string;
}

interface CorpusResult {
  name: string;
  status: CorpusResultStatus;
  bytes: number;
  worksheets?: number;
  details?: string;
}

const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const manifestPath = join(scriptDirectory, "xlsb-corpus-manifest.json");
const cacheDirectory = resolve(
  process.env.DOCUMONSTER_XLSB_CORPUS_CACHE ?? join(repositoryRoot, "tmp/xlsb-corpus")
);
const offline =
  process.argv.includes("--offline") || process.env.DOCUMONSTER_XLSB_CORPUS_OFFLINE === "1";
const refresh = process.argv.includes("--refresh");
const parsedManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));

validateManifest(parsedManifest);
const manifest = parsedManifest;
if (offline && refresh) {
  throw new Error("--offline and --refresh cannot be used together");
}

const results: CorpusResult[] = [];
for (const fixture of manifest.fixtures) {
  const source = manifest.sources[fixture.source];
  if (!source) {
    throw new Error(`unknown XLSB corpus source ${fixture.source}`);
  }
  const bytes = await loadFixture(fixture, source);
  results.push(await verifyFixture(`${fixture.source}/${basename(fixture.path)}`, bytes, fixture));
}

const localRoot = process.env.DOCUMONSTER_XLSB_CORPUS_DIR;
if (localRoot) {
  for (const path of await discoverXlsbFiles(resolve(localRoot))) {
    const bytes = new Uint8Array(await readFile(path));
    results.push(await verifyFixture(`local/${relative(resolve(localRoot), path)}`, bytes, {}));
  }
}

const failures = results.filter(result => result.status === "failed");
const summary = {
  manifestVersion: manifest.version,
  cacheDirectory,
  offline,
  refresh,
  fixtures: results.length,
  passed: results.length - failures.length,
  expectedRejections: results.filter(result => result.status === "expected-rejection").length,
  failed: failures.length,
  totalBytes: results.reduce((sum, result) => sum + result.bytes, 0),
  results
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}

async function loadFixture(fixture: CorpusFixture, source: CorpusSource): Promise<Uint8Array> {
  const cachePath = join(cacheDirectory, fixture.source, fixture.path);
  if (!refresh) {
    const cached = await readValidCache(cachePath, fixture.sha256);
    if (cached) {
      return cached;
    }
  }
  if (offline) {
    throw new Error(`missing or invalid offline corpus fixture ${fixture.source}/${fixture.path}`);
  }

  const url = source.urlTemplate
    .replace("{revision}", source.revision)
    .replace("{path}", fixture.path);
  const response = await fetch(url, {
    headers: { "user-agent": "documonster-xlsb-corpus" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FIXTURE_BYTES) {
    throw new Error(`${fixture.path} exceeds the ${MAX_FIXTURE_BYTES}-byte download limit`);
  }
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  const bytes =
    source.encoding === "base64"
      ? new Uint8Array(Buffer.from(new TextDecoder().decode(responseBytes).trim(), "base64"))
      : responseBytes;
  validateFixtureBytes(bytes, fixture.sha256, fixture.path);

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, bytes);
  return bytes;
}

async function readValidCache(path: string, expectedHash: string): Promise<Uint8Array | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    validateFixtureBytes(bytes, expectedHash, path);
    return bytes;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    if (offline) {
      throw error;
    }
    return undefined;
  }
}

async function verifyFixture(
  name: string,
  bytes: Uint8Array,
  fixture: CorpusExpectation
): Promise<CorpusResult> {
  try {
    const workbook = Workbook.create();
    if (fixture.expectedError) {
      await Workbook.read(workbook, bytes, { format: "xlsb" });
    } else {
      await Workbook.read(workbook, bytes);
    }
    if (fixture.expectedError) {
      return {
        name,
        status: "failed",
        bytes: bytes.byteLength,
        details: `expected an error containing ${JSON.stringify(fixture.expectedError)}`
      };
    }
    const roundTrip = await Workbook.toBuffer(workbook, { format: "xlsb" });
    if (!equalBytes(bytes, roundTrip)) {
      throw new Error("unchanged XLSB was not returned byte-for-byte");
    }
    return {
      name,
      status: "passed",
      bytes: bytes.byteLength,
      worksheets: Workbook.getWorksheets(workbook).length
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (fixture.expectedError && details.includes(fixture.expectedError)) {
      return { name, status: "expected-rejection", bytes: bytes.byteLength, details };
    }
    return { name, status: "failed", bytes: bytes.byteLength, details };
  }
}

async function discoverXlsbFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverXlsbFiles(path)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xlsb")) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function validateManifest(value: unknown): asserts value is CorpusManifest {
  if (!value || typeof value !== "object") {
    throw new Error("XLSB corpus manifest must be an object");
  }
  const candidate = value as Partial<CorpusManifest>;
  if (
    candidate.version !== 1 ||
    !candidate.sources ||
    typeof candidate.sources !== "object" ||
    !Array.isArray(candidate.fixtures)
  ) {
    throw new Error("XLSB corpus manifest must have version 1, sources, and fixtures");
  }
  for (const [name, source] of Object.entries(candidate.sources)) {
    if (
      !source ||
      typeof source.revision !== "string" ||
      typeof source.urlTemplate !== "string" ||
      !["binary", "base64"].includes(source.encoding)
    ) {
      throw new Error(`invalid XLSB corpus source ${name}`);
    }
  }
  for (const fixture of candidate.fixtures) {
    if (
      !fixture ||
      typeof fixture !== "object" ||
      typeof fixture.source !== "string" ||
      !candidate.sources[fixture.source] ||
      typeof fixture.path !== "string" ||
      fixture.path.startsWith("/") ||
      fixture.path.split("/").includes("..") ||
      typeof fixture.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(fixture.sha256) ||
      (fixture.expectedError !== undefined && typeof fixture.expectedError !== "string")
    ) {
      throw new Error(`invalid XLSB corpus fixture: ${JSON.stringify(fixture)}`);
    }
  }
}

function validateFixtureBytes(bytes: Uint8Array, expectedHash: string, label: string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FIXTURE_BYTES) {
    throw new Error(`${label} has invalid size ${bytes.byteLength}`);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
