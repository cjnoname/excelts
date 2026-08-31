/**
 * Finding out what a conversion costs, before it costs it.
 *
 * Run: `pnpm example --filter xlsb-losses`
 *
 * XLSB expresses less than XLSX does, and the interesting question is never "does it convert" — it is
 * *what does the file no longer contain*. This example is the answer to that, in both directions:
 *
 * - **Writing** defaults to refusing. The workbook is in memory and complete, so a loss is this
 *   library's limitation, and stopping costs the caller nothing they had.
 * - **Reading** defaults to accepting. The loss already happened in a file someone else wrote, and a
 *   reader that refuses real files is a reader nobody can use.
 *
 * The report is not a warning log. It is a list, on the error's `items`, of exactly what would be
 * missing — by address for a cell, by sheet for a feature, by name for a defined name — which is the
 * difference between a converter you can trust and one that merely finishes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ExcelNotSupportedError } from "@excel/errors";
import { Cell, DefinedNames, Workbook, Worksheet } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-losses.xlsb");

// ---------------------------------------------------------------------------
// A workbook that uses rather more than XLSB can carry.
// ---------------------------------------------------------------------------

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Report", {
  // A frozen header row: `BrtPane`, whose layout no reference workbook establishes.
  views: [{ state: "frozen", xSplit: 0, ySplit: 1 }]
});
Worksheet.addRow(ws, ["Region", "Units", "Revenue"]);
Worksheet.addRow(ws, ["North", 120, 4800]);
Worksheet.addRow(ws, ["South", 95, 3610]);
Worksheet.addRow(ws, ["Total", { formula: "SUM(B2:B3)", result: 215 }]);

// Borders: the corpus establishes `BrtBorder`'s size and not one of its fields, so a border cannot be
// written without guessing — and a border silently removed from a table of figures is noticed at once.
for (const address of ["A1", "B1", "C1"]) {
  Cell.setStyle(ws, address, {
    font: { bold: true },
    border: { bottom: { style: "medium", color: { argb: "FF333333" } } }
  });
}

// A defined name spanning two non-adjacent ranges. `BrtName` carries one token stream, so only the
// first survives — the name would come back meaning something narrower than it says.
const names = Workbook.getDefinedNames(wb);
DefinedNames.add(names, "Report!$B$2", "Sampled");
DefinedNames.add(names, "Report!$B$4", "Sampled");

// ---------------------------------------------------------------------------
// Writing: refused by default, with the list of what it would have cost.
// ---------------------------------------------------------------------------

try {
  await Workbook.toBuffer(wb, { format: "xlsb" });
  console.log("unexpected: the write was accepted");
} catch (error) {
  if (!(error instanceof ExcelNotSupportedError)) {
    throw error;
  }
  console.log(`refused, and named ${error.items.length} item(s):`);
  for (const item of error.items) {
    console.log(`  - ${item}`);
  }
}

// Knowing that, the conversion can be made deliberately.
const bytes = await Workbook.toBuffer(wb, { format: "xlsb", unsupported: "ignore" });
fs.writeFileSync(filename, bytes);
console.log(`\nwrote ${filename} (${(bytes.byteLength / 1024).toFixed(1)} KiB)`);

// ---------------------------------------------------------------------------
// Reading: accepted by default, refusable on request.
// ---------------------------------------------------------------------------

const reopened = Workbook.create();
await Workbook.read(reopened, bytes);
const readSheet = Workbook.getWorksheet(reopened, "Report")!;
console.log(`\nread back: ${Worksheet.getName(readSheet)}`);
// What survived: the values, the bold, the number, the formula.
console.log(`  C1 = ${JSON.stringify(Cell.getValue(readSheet, "C1"))}`);
console.log(`  A1 bold = ${Cell.getStyle(readSheet, "A1")?.font?.bold === true}`);
console.log(`  A1 border = ${JSON.stringify(Cell.getStyle(readSheet, "A1")?.border)}`);
console.log(`  B4 formula = ${JSON.stringify(Cell.getFormula(readSheet, "B4"))}`);

// The same read, asked to be strict. This package was written by this library and loses nothing on
// the way back in, so it is accepted — the option earns its keep on files from elsewhere, where a
// record whose layout is unestablished would otherwise cost cells silently.
const strict = Workbook.create();
try {
  await Workbook.read(strict, bytes, { unsupported: "error" });
  console.log("\nstrict read: nothing was lost coming back in");
} catch (error) {
  if (!(error instanceof ExcelNotSupportedError)) {
    throw error;
  }
  console.log(`\nstrict read refused, naming ${error.items.length} item(s):`);
  for (const item of error.items) {
    console.log(`  - ${item}`);
  }
}

// ---------------------------------------------------------------------------
// And reading replaces, atomically.
// ---------------------------------------------------------------------------

const target = Workbook.create();
Cell.setValue(Workbook.addWorksheet(target, "Leftover"), "A1", "from a previous life");
await Workbook.read(target, bytes);
console.log(
  `\nafter reading into a non-empty workbook: ${Workbook.getWorksheets(target)
    .map(sheet => Worksheet.getName(sheet))
    .join(", ")}`
);
