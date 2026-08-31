/**
 * Reading and writing a binary workbook (`.xlsb`).
 *
 * Run: `pnpm example --filter xlsb-round-trip`
 *
 * The point of this one is that nothing about the *call* changes. `.xlsb` is selected by the file
 * extension, or explicitly with `{ format: "xlsb" }` when the bytes have no name — and the reader
 * detects the format from the content, so a caller that does not know what it was handed does not
 * have to guess.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, DefinedNames, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-round-trip.xlsb");

const wb = Workbook.create();

const data = Workbook.addWorksheet(wb, "Data");
Worksheet.addRow(data, ["Region", "Units", "Unit price", "Booked"]);
Worksheet.addRow(data, ["North", 120, 19.99, new Date(Date.UTC(2024, 0, 15))]);
Worksheet.addRow(data, ["South", 84, 24.5, new Date(Date.UTC(2024, 1, 3))]);
Worksheet.addRow(data, ["East", 203, 12.75, new Date(Date.UTC(2024, 1, 27))]);

// A number format is the difference between a correct number and a correct *answer*: without it
// 45306 is a plausible integer rather than a date.
for (const row of [2, 3, 4]) {
  Cell.setStyle(data, `C${row}`, { numFmt: '"$"#,##0.00' });
  Cell.setStyle(data, `D${row}`, { numFmt: "yyyy-mm-dd" });
}
Cell.setStyle(data, "A1", { font: { bold: true }, alignment: { horizontal: "center" } });
Cell.setStyle(data, "B1", { font: { bold: true }, alignment: { horizontal: "center" } });
Cell.setStyle(data, "C1", { font: { bold: true }, alignment: { horizontal: "center" } });
Cell.setStyle(data, "D1", { font: { bold: true }, alignment: { horizontal: "center" } });

// A name, and a formula that uses it. Both the name's own definition and the reference to it are
// token streams pointing at tables in the workbook part, so this is the case that used to produce a
// file whose formula referenced an index that was never written.
DefinedNames.add(Workbook.getDefinedNames(wb), "Data!$B$2:$B$4", "Units");

const summary = Workbook.addWorksheet(wb, "Summary");
Cell.setValue(summary, "A1", "Total units");
Cell.setValue(summary, "B1", { formula: "SUM(Units)", result: 407 });
Cell.setValue(summary, "A2", "Highest price");
// A cross-sheet reference. Its `ixti` indexes a table in the workbook part rather than the sheet
// list, which is why writing that table matters.
Cell.setValue(summary, "B2", { formula: "MAX(Data!C2:C4)", result: 24.5 });
Cell.setStyle(summary, "B2", { numFmt: '"$"#,##0.00' });

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

// Reading it back. The formulas come back as expressions, not as the numbers they happened to
// evaluate to — which is the assertion worth making, because a reader that lost the expression and
// kept the cached result looks correct until you edit a cell.
const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);

const readSummary = Workbook.getWorksheets(reopened)[1]!;
console.log("B1:", JSON.stringify(Cell.getValue(readSummary, "B1")));
console.log("B2:", JSON.stringify(Cell.getValue(readSummary, "B2")));
console.log(
  "defined names:",
  JSON.stringify(DefinedNames.getAllEntries(Workbook.getDefinedNames(reopened)))
);

const readData = Workbook.getWorksheets(reopened)[0]!;
const booked = Cell.getValue(readData, "D2");
console.log(
  "D2 is a Date:",
  booked instanceof Date,
  booked instanceof Date ? booked.toISOString() : ""
);

// The same bytes, without a filename to go by. `format` is only needed when writing to a buffer;
// reading detects it from the content.
const bytes = await Workbook.toBuffer(wb, { format: "xlsb" });
const fromBytes = Workbook.create();
await Workbook.read(fromBytes, bytes);
console.log("read from a buffer with no name:", Workbook.getWorksheets(fromBytes).length, "sheets");
