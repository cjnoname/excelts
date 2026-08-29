/**
 * Example: CSV Module — Advanced / Streaming APIs
 *
 * Complements `csv-complete.ts` by covering the branch APIs it skips:
 * - Csv.parseRows: true streaming async generator (one row at a time)
 * - Csv.parseWithProgress: buffered parse with a progress callback
 * - Csv.generateRows: sync row-string iterator (memory efficient)
 * - Csv.generateAsync: async row-string iterator (supports delay)
 * - Csv.generateData: raw data rows (array or objectMode)
 * - Csv.createGenerator: reusable preconfigured generator (generate/rows/data/asyncRows)
 * - Error handling: CsvError / isCsvError
 *
 * Usage:   pnpm example --filter csv-advanced
 * Output:  tmp/csv-examples/advanced-*.csv
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Csv, CsvError, isCsvError } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/csv-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. Csv.parseRows — true streaming async generator
// =============================================================================

console.log("=== 1. Csv.parseRows (streaming async generator) ===");

const csv1 = `id,name,score
1,Alice,95
2,Bob,42
3,Carol,78
4,Dave,31`;

// Yields one row at a time — never buffers the whole result.
const collected: Record<string, unknown>[] = [];
for await (const row of Csv.parseRows(csv1, { headers: true, dynamicTyping: true })) {
  collected.push(row as Record<string, unknown>);
}
console.log("Streamed rows:", collected.length);
console.log("First row:", collected[0]);

// With per-row validation — only rows passing the predicate are yielded.
const passing: Record<string, unknown>[] = [];
for await (const row of Csv.parseRows(csv1, {
  headers: true,
  dynamicTyping: true,
  validate: r => ((r as Record<string, unknown>).score as number) >= 50
})) {
  passing.push(row as Record<string, unknown>);
}
console.log(
  "Rows with score >= 50:",
  passing.map(r => r.name)
);

// =============================================================================
// 2. Csv.parseWithProgress — buffered parse with progress reporting
// =============================================================================

console.log("\n=== 2. Csv.parseWithProgress ===");

// Build a larger CSV to make progress meaningful.
const bigCsv = Csv.generate({
  columns: [
    { name: "id", type: "int", min: 1, max: 100000 },
    { name: "name", type: "name" },
    { name: "amount", type: "float", min: 0, max: 1000 }
  ],
  rows: 200,
  seed: 7,
  headers: true
}).csv;

const progressUpdates: { rowsProcessed: number; bytesProcessed?: number }[] = [];
const progResult = await Csv.parseWithProgress(
  bigCsv,
  { headers: true, dynamicTyping: true },
  info => progressUpdates.push(info)
);

const progRows = Array.isArray(progResult) ? progResult : progResult.rows;
console.log("Parsed rows:", Array.isArray(progRows) ? progRows.length : "n/a");
console.log("Progress callbacks:", progressUpdates.length);
console.log("Final progress:", progressUpdates[progressUpdates.length - 1]);

// =============================================================================
// 3. Csv.generateRows — sync row-string iterator
// =============================================================================

console.log("\n=== 3. Csv.generateRows (sync iterator) ===");

const generatedLines: string[] = [];
for (const line of Csv.generateRows({
  columns: [
    { name: "id", type: "index" },
    { name: "user", type: "username" },
    { name: "active", type: "bool" }
  ],
  rows: 5,
  seed: 42,
  headers: true
})) {
  generatedLines.push(line);
}
console.log("Generated lines:", generatedLines.length);
console.log(generatedLines.join("\n"));

fs.writeFileSync(path.join(outDir, "advanced-generate-rows.csv"), generatedLines.join("\n"));

// Unlimited generation with a manual break (rows: -1).
let count = 0;
for (const _line of Csv.generateRows({ columns: 2, rows: -1, seed: 1, headers: false })) {
  if (++count >= 3) {
    break;
  }
}
console.log("Pulled from unlimited iterator then broke at:", count);

// =============================================================================
// 4. Csv.generateAsync — async row-string iterator (with delay)
// =============================================================================

console.log("\n=== 4. Csv.generateAsync (async iterator) ===");

const asyncLines: string[] = [];
for await (const line of Csv.generateAsync({
  columns: [
    { name: "ts", type: "timestamp" },
    { name: "city", type: "city" }
  ],
  rows: 4,
  seed: 99,
  headers: true,
  delay: 5 // ms between rows
})) {
  asyncLines.push(line);
}
console.log("Async-generated lines:", asyncLines.length);
console.log(asyncLines.join("\n"));

// =============================================================================
// 5. Csv.generateData — raw data rows (arrays and objectMode)
// =============================================================================

console.log("\n=== 5. Csv.generateData ===");

// Array mode (default): unknown[][]
const arrayData = Csv.generateData({
  columns: ["name", "int", "email"],
  rows: 3,
  seed: 5
});
console.log("Array mode rows:", arrayData);

// Object mode: Record<string, unknown>[]
const objectData = Csv.generateData({
  columns: [
    { type: "name", name: "fullName" },
    { type: "int", name: "age", min: 18, max: 65 }
  ],
  rows: 3,
  seed: 5,
  objectMode: true
});
console.log("Object mode rows:", objectData);

// =============================================================================
// 6. Csv.createGenerator — reusable preconfigured generator
// =============================================================================

console.log("\n=== 6. Csv.createGenerator ===");

const gen = Csv.createGenerator({
  columns: [
    { name: "id", type: "int", min: 1, max: 9999 },
    { name: "name", type: "name" },
    { name: "score", type: "float", min: 0, max: 100 }
  ],
  seed: 2024,
  headers: true
});

// generate(): full CSV string + data
const batch1 = gen.generate(4);
console.log("Batch 1 CSV:\n" + batch1.csv);
fs.writeFileSync(path.join(outDir, "advanced-generator-batch.csv"), batch1.csv);

// rows(): sync iterator with per-call override
const overrideLines: string[] = [];
for (const line of gen.rows(2)) {
  overrideLines.push(line);
}
console.log("rows(2) produced", overrideLines.length, "lines (incl. header)");

// data(): raw data array with override
const dataRows = gen.data(3);
console.log("data(3) rows:", dataRows.length);

// asyncRows(): async iterator
let asyncCount = 0;
for await (const _line of gen.asyncRows({ rows: 2 })) {
  asyncCount++;
}
console.log("asyncRows produced", asyncCount, "lines (incl. header)");

// =============================================================================
// 7. Error handling — CsvError / isCsvError
// =============================================================================

console.log("\n=== 7. CsvError / isCsvError ===");

// Csv.format throws a CsvError when given an invalid decimal separator
// (must be "." or ","). This is a reliable, real CsvError trigger.
let caught: unknown;
try {
  Csv.format([{ a: 1 }], { decimalSeparator: "|" } as never);
} catch (err) {
  caught = err;
}

if (caught !== undefined && isCsvError(caught)) {
  console.log("Caught a real CsvError:", (caught as CsvError).message);
  console.log("isCsvError(caught):", isCsvError(caught)); // true
  console.log("isCsvError(new Error()):", isCsvError(new Error("plain"))); // false
} else {
  // Fallback (should not happen): construct one so the guard is still shown.
  const manual = new CsvError("Example CSV failure", { cause: new Error("root cause") });
  console.log("Constructed CsvError:", manual.name, "-", manual.message);
  console.log("isCsvError(manual):", isCsvError(manual));
  console.log("isCsvError(new Error()):", isCsvError(new Error("plain")));
}

console.log("\n=== CSV Advanced Examples Complete ===");
