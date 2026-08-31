/**
 * Checking a binary workbook before trusting it, with the validator this module ships.
 *
 * Run: `pnpm example --filter xlsb-validate`
 *
 * The validator exists because of a lesson that cost several rounds to learn: **"internally
 * coherent" and "Excel will open it" are different claims**, and asserting the second on the
 * strength of the first produces files that pass every check and fail in the one place that matters.
 *
 * So it now asks two kinds of question. Structural ones — is this a readable record stream, do the
 * scopes nest, are the indices in range — and *conformance* ones: does this part contain the records
 * every Excel-authored workbook contains, and is each record the length Excel always writes it at? A
 * record of the wrong length is perfectly consistent with itself, which is exactly why the first
 * kind of check cannot see it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAll } from "@archive/unzip/extract";
import { ZipArchive } from "@archive/zip";
import { Cell, Workbook, Worksheet } from "@excel/index";
import { validateXlsbBuffer } from "@excel/utils/xlsb-validator";
import { encodeBiffRecords, iterateBiffRecords } from "@excel/xlsb/binary";
import { recordSpec } from "@excel/xlsb/spec/records";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-validate.xlsb");

// ---------------------------------------------------------------------------
// A workbook this library wrote.
// ---------------------------------------------------------------------------

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Checked");
Worksheet.addRow(ws, ["Item", "Amount"]);
Worksheet.addRow(ws, ["Widget", 19.99]);
Worksheet.addRow(ws, ["Gadget", 24.5]);
Cell.setValue(ws, "B4", { formula: "SUM(B2:B3)", result: 44.49 });
Cell.setStyle(ws, "A1", { font: { bold: true } });
await Workbook.writeFile(wb, filename);

const own = await validateXlsbBuffer(fs.readFileSync(filename), { includeWarnings: true });
console.log(
  `${path.basename(filename)}: ${own.ok ? "ok" : "not ok"}, ${own.problems.length} problem(s)`
);

// ---------------------------------------------------------------------------
// The fixture, which carries parts this library does not model.
// ---------------------------------------------------------------------------

const fixture = path.join(exampleDir, "data/themed.xlsb");
const themed = await validateXlsbBuffer(fs.readFileSync(fixture), { includeWarnings: true });
console.log(`themed.xlsb: ${themed.ok ? "ok" : "not ok"}, ${themed.problems.length} problem(s)`);

// ---------------------------------------------------------------------------
// What it says about a file that is coherent and unopenable.
// ---------------------------------------------------------------------------

// Rebuilt with one record shortened, which is the shape a wrong writer produces: the ZIP is fine,
// the stream still frames, the scopes still nest and the indices are still in range. This is exactly
// what this library shipped — a twelve-byte `BrtRowHdr` where Excel writes twenty-five — and Excel's
// answer was "we found a problem with some content".
const source = await extractAll(fs.readFileSync(filename));
const damaged = new ZipArchive();
for (const [part, file] of source) {
  if (part !== "xl/worksheets/sheet1.bin") {
    damaged.add(part, file.data);
    continue;
  }
  const records: { id: number; payload: Uint8Array }[] = [];
  for (const record of iterateBiffRecords(file.data, part)) {
    const shorten = recordSpec(record.id)?.name === "BrtRowHdr";
    records.push({
      id: record.id,
      payload: shorten ? record.payload.subarray(0, 12) : record.payload
    });
  }
  damaged.add(part, encodeBiffRecords(records));
}

const broken = await validateXlsbBuffer(await damaged.bytes(), { includeWarnings: true });
console.log(`\nwith every BrtRowHdr shortened to twelve bytes: ${broken.ok ? "ok" : "not ok"}`);
for (const problem of broken.problems.slice(0, 3)) {
  console.log(`  ${problem.severity} ${problem.kind}: ${problem.message.slice(0, 84)}`);
}

// ---------------------------------------------------------------------------
// The two conformance checks, which are what "will Excel open it" turns on.
// ---------------------------------------------------------------------------

console.log("\nthe checks that exist because a coherent file can still be unopenable:");
console.log("  record-missing-required        — a part lacking a record every Excel file has");
console.log("  framing-unexpected-payload-size — a record whose length Excel never varies");
console.log(
  "\nBoth are measured against Excel's own output rather than a specification's notion of"
);
console.log("required, that being the only evidence available here.");
