import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Workbook, Worksheet } from "../dist/esm/modules/excel/index.js";

type CorpusSourceEncoding = "binary" | "base64";
type CorpusResultStatus = "passed" | "expected-rejection" | "failed";
type CorpusScalar = string | number | boolean | null;
type CorpusFormulaResult = CorpusScalar | { error: string };

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
  expect?: CorpusSemanticExpectation;
}

interface CorpusManifest {
  version: 1;
  sources: Record<string, CorpusSource>;
  fixtures: CorpusFixture[];
}

interface CorpusExpectation {
  expectedError?: string;
  expect?: CorpusSemanticExpectation;
}

interface CorpusCellExpectation {
  sheet: string;
  address: string;
  value?: CorpusScalar;
  date?: string;
  formula?: string;
  result?: CorpusFormulaResult;
  text?: string;
  hyperlink?: string;
  numFmt?: string;
  comment?: {
    author?: string;
    text?: string;
  };
}

interface CorpusMergeExpectation {
  sheet: string;
  ranges: string[];
}

interface CorpusMutationExpectation {
  sheet: string;
  address: string;
  value: CorpusScalar;
  unsupported?: "ignore";
}

interface CorpusSemanticExpectation {
  date1904?: boolean;
  worksheets?: string[];
  cells?: CorpusCellExpectation[];
  merges?: CorpusMergeExpectation[];
  mutation?: CorpusMutationExpectation;
}

interface CorpusResult {
  name: string;
  status: CorpusResultStatus;
  bytes: number;
  worksheets?: number;
  semanticChecks?: number;
  mutatedRoundTrip?: boolean;
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
  semanticChecks: results.reduce((sum, result) => sum + (result.semanticChecks ?? 0), 0),
  mutatedRoundTrips: results.filter(result => result.mutatedRoundTrip).length,
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
    const semanticChecks = verifySemanticExpectations(workbook, fixture.expect, name);
    const roundTrip = await Workbook.toBuffer(workbook, { format: "xlsb" });
    if (!equalBytes(bytes, roundTrip)) {
      throw new Error("unchanged XLSB was not returned byte-for-byte");
    }
    const mutationChecks = fixture.expect?.mutation
      ? await verifyMutation(workbook, bytes, fixture.expect, name)
      : 0;
    return {
      name,
      status: "passed",
      bytes: bytes.byteLength,
      worksheets: Workbook.getWorksheets(workbook).length,
      ...(semanticChecks + mutationChecks > 0
        ? { semanticChecks: semanticChecks + mutationChecks }
        : {}),
      ...(mutationChecks > 0 ? { mutatedRoundTrip: true } : {})
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (fixture.expectedError && details.includes(fixture.expectedError)) {
      return { name, status: "expected-rejection", bytes: bytes.byteLength, details };
    }
    return { name, status: "failed", bytes: bytes.byteLength, details };
  }
}

function verifySemanticExpectations(
  workbook: Workbook.Handle,
  expectation: CorpusSemanticExpectation | undefined,
  context: string
): number {
  if (!expectation) {
    return 0;
  }
  let checks = 0;
  if (expectation.date1904 !== undefined) {
    assertSemanticEqual(
      workbook.properties.date1904,
      expectation.date1904,
      `${context} workbook date1904`
    );
    checks++;
  }
  if (expectation.worksheets) {
    const names = Workbook.getWorksheets(workbook).map(sheet => Worksheet.getModel(sheet).name);
    assertSemanticEqual(names, expectation.worksheets, `${context} worksheet names`);
    checks++;
  }
  for (const cell of expectation.cells ?? []) {
    const sheet = requireWorksheet(workbook, cell.sheet, context);
    const label = `${context} ${cell.sheet}!${cell.address}`;
    if (Object.hasOwn(cell, "value")) {
      assertSemanticEqual(Cell.getValue(sheet, cell.address), cell.value, `${label} value`);
      checks++;
    }
    if (cell.date !== undefined) {
      const actual = Cell.getValue(sheet, cell.address);
      if (!(actual instanceof Date)) {
        throw new Error(`${label} value: expected Date ${cell.date}, received ${describe(actual)}`);
      }
      assertSemanticEqual(actual.toISOString(), cell.date, `${label} date`);
      checks++;
    }
    if (cell.formula !== undefined) {
      assertSemanticEqual(Cell.getFormula(sheet, cell.address), cell.formula, `${label} formula`);
      checks++;
    }
    if (Object.hasOwn(cell, "result")) {
      assertSemanticEqual(Cell.getResult(sheet, cell.address), cell.result, `${label} result`);
      checks++;
    }
    if (cell.text !== undefined) {
      assertSemanticEqual(Cell.getText(sheet, cell.address), cell.text, `${label} text`);
      checks++;
    }
    if (cell.hyperlink !== undefined) {
      assertSemanticEqual(
        Cell.getHyperlink(sheet, cell.address),
        cell.hyperlink,
        `${label} hyperlink`
      );
      checks++;
    }
    if (cell.numFmt !== undefined) {
      assertSemanticEqual(Cell.getNumFmt(sheet, cell.address), cell.numFmt, `${label} numFmt`);
      checks++;
    }
    if (cell.comment) {
      const actual = Cell.getComment(sheet, cell.address);
      if (!actual) {
        throw new Error(`${label} comment: expected a comment, received none`);
      }
      if (cell.comment.author !== undefined) {
        assertSemanticEqual(actual.author, cell.comment.author, `${label} comment author`);
        checks++;
      }
      if (cell.comment.text !== undefined) {
        assertSemanticEqual(commentText(actual.note), cell.comment.text, `${label} comment text`);
        checks++;
      }
    }
  }
  for (const merge of expectation.merges ?? []) {
    const sheet = requireWorksheet(workbook, merge.sheet, context);
    assertSemanticEqual(
      Worksheet.getModel(sheet).mergeCells ?? [],
      merge.ranges,
      `${context} ${merge.sheet} merged ranges`
    );
    checks++;
  }
  return checks;
}

async function verifyMutation(
  workbook: Workbook.Handle,
  originalBytes: Uint8Array,
  expectation: CorpusSemanticExpectation,
  context: string
): Promise<number> {
  const mutation = expectation.mutation!;
  const sheet = requireWorksheet(workbook, mutation.sheet, context);
  Cell.setValue(sheet, mutation.address, mutation.value);
  const mutatedBytes = await Workbook.toBuffer(workbook, {
    format: "xlsb",
    ...(mutation.unsupported ? { unsupported: mutation.unsupported } : {})
  });
  if (equalBytes(originalBytes, mutatedBytes)) {
    throw new Error(`${context} mutation returned the unchanged XLSB bytes`);
  }

  const reopened = Workbook.create();
  await Workbook.read(reopened, mutatedBytes);
  let checks = verifySemanticExpectations(reopened, expectation, `${context} mutated round-trip`);
  const reopenedSheet = requireWorksheet(reopened, mutation.sheet, context);
  assertSemanticEqual(
    Cell.getValue(reopenedSheet, mutation.address),
    mutation.value,
    `${context} mutated round-trip ${mutation.sheet}!${mutation.address}`
  );
  return checks + 1;
}

function requireWorksheet(
  workbook: Workbook.Handle,
  name: string,
  context: string
): Worksheet.Handle {
  const worksheet = Workbook.getWorksheet(workbook, name);
  if (!worksheet) {
    throw new Error(`${context}: worksheet ${JSON.stringify(name)} was not loaded`);
  }
  return worksheet;
}

function commentText(note: unknown): string | undefined {
  if (typeof note === "string") {
    return note;
  }
  if (!isRecord(note) || !Array.isArray(note.texts)) {
    return undefined;
  }
  return note.texts
    .map(run => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
    .join("");
}

function assertSemanticEqual(actual: unknown, expected: unknown, label: string): void {
  if (!semanticEqual(actual, expected)) {
    throw new Error(`${label}: expected ${describe(expected)}, received ${describe(actual)}`);
  }
}

function semanticEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) {
    return true;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((value, index) => semanticEqual(value, expected[index]))
    );
  }
  if (isRecord(actual) && isRecord(expected)) {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return (
      semanticEqual(actualKeys, expectedKeys) &&
      actualKeys.every(key => semanticEqual(actual[key], expected[key]))
    );
  }
  return false;
}

function describe(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
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
      (fixture.expectedError !== undefined && typeof fixture.expectedError !== "string") ||
      (fixture.expectedError !== undefined && fixture.expect !== undefined)
    ) {
      throw new Error(`invalid XLSB corpus fixture: ${JSON.stringify(fixture)}`);
    }
    if (fixture.expect !== undefined) {
      validateSemanticExpectation(fixture.expect, `${fixture.source}/${fixture.path}`);
    }
  }
}

function validateSemanticExpectation(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} semantic expectation must be an object`);
  }
  if (value.date1904 !== undefined && typeof value.date1904 !== "boolean") {
    throw new Error(`${label} date1904 expectation must be boolean`);
  }
  if (value.worksheets !== undefined && !isStringArray(value.worksheets)) {
    throw new Error(`${label} worksheets expectation must be a string array`);
  }
  if (value.cells !== undefined) {
    if (!Array.isArray(value.cells)) {
      throw new Error(`${label} cells expectation must be an array`);
    }
    value.cells.forEach((cell, index) => validateCellExpectation(cell, `${label} cells[${index}]`));
  }
  if (value.merges !== undefined) {
    if (!Array.isArray(value.merges)) {
      throw new Error(`${label} merges expectation must be an array`);
    }
    for (const [index, merge] of value.merges.entries()) {
      if (!isRecord(merge) || typeof merge.sheet !== "string" || !isStringArray(merge.ranges)) {
        throw new Error(`${label} merges[${index}] must contain sheet and ranges`);
      }
    }
  }
  if (value.mutation !== undefined) {
    const mutation = value.mutation;
    if (
      !isRecord(mutation) ||
      typeof mutation.sheet !== "string" ||
      typeof mutation.address !== "string" ||
      !isScalar(mutation.value) ||
      (mutation.unsupported !== undefined && mutation.unsupported !== "ignore")
    ) {
      throw new Error(`${label} mutation expectation is invalid`);
    }
  }
}

function validateCellExpectation(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value.sheet !== "string" || typeof value.address !== "string") {
    throw new Error(`${label} must contain sheet and address`);
  }
  if (
    !["value", "date", "formula", "result", "text", "hyperlink", "numFmt", "comment"].some(
      property => Object.hasOwn(value, property)
    )
  ) {
    throw new Error(`${label} must assert at least one cell property`);
  }
  if (Object.hasOwn(value, "value") && !isScalar(value.value)) {
    throw new Error(`${label} value expectation must be a JSON scalar`);
  }
  if (value.date !== undefined && (typeof value.date !== "string" || !isIsoDate(value.date))) {
    throw new Error(`${label} date expectation must be an ISO-8601 timestamp`);
  }
  if (Object.hasOwn(value, "value") && value.date !== undefined) {
    throw new Error(`${label} cannot expect both value and date`);
  }
  for (const property of ["formula", "text", "hyperlink", "numFmt"] as const) {
    if (value[property] !== undefined && typeof value[property] !== "string") {
      throw new Error(`${label} ${property} expectation must be a string`);
    }
  }
  if (Object.hasOwn(value, "result") && !isFormulaResult(value.result)) {
    throw new Error(`${label} result expectation must be a JSON scalar or Excel error`);
  }
  if (value.comment !== undefined) {
    if (!isRecord(value.comment)) {
      throw new Error(`${label} comment expectation must be an object`);
    }
    for (const property of ["author", "text"] as const) {
      if (value.comment[property] !== undefined && typeof value.comment[property] !== "string") {
        throw new Error(`${label} comment ${property} expectation must be a string`);
      }
    }
  }
}

function isFormulaResult(value: unknown): value is CorpusFormulaResult {
  return isScalar(value) || (isRecord(value) && typeof value.error === "string");
}

function isScalar(value: unknown): value is CorpusScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
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
