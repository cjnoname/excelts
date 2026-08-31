import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Cell, Workbook, Worksheet, Xlsb } from "@excel/index";

const filename = resolve(process.argv[2] ?? "tmp/excel-examples/xlsb-round-trip.xlsb");
await mkdir(dirname(filename), { recursive: true });

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Summary", {
  views: [{ state: "frozen", ySplit: 1, topLeftCell: "A2", activeCell: "A2" }]
});
Cell.setValue(sheet, "A1", "Metric");
Cell.setValue(sheet, "B1", "Value");
Cell.setValue(sheet, "A2", "Net sales");
Cell.setValue(sheet, "B2", 1250.5);
Cell.setStyle(sheet, "B2", { numFmt: "$#,##0.00", font: { bold: true } });
Cell.setValue(sheet, "C2", { formula: "B2*1.2", result: 1500.6 });
Worksheet.merge(sheet, "A4:C4");
Cell.setValue(sheet, "A4", "Created by documonster");

// The `.xlsb` extension selects the binary writer on Node.js.
await Workbook.writeFile(workbook, filename);

const loaded = Workbook.create();
await Workbook.readFile(loaded, filename);
const loadedSheet = Workbook.getWorksheet(loaded, "Summary");
if (!loadedSheet || Cell.getFormula(loadedSheet, "C2") !== "B2*1.2") {
  throw new Error("XLSB file round-trip did not preserve the formula");
}

// Explicit XLSB IO uses the same workbook model and works in browsers as well.
Cell.setValue(loadedSheet, "A5", "Edited after reading");
const editedBytes = await Xlsb.toBuffer(loaded, { zip: { reproducible: true } });
const verified = Workbook.create();
await Workbook.read(verified, editedBytes);
const verifiedSheet = Workbook.getWorksheet(verified, "Summary");
if (!verifiedSheet || Cell.getValue(verifiedSheet, "A5") !== "Edited after reading") {
  throw new Error("XLSB edit round-trip did not preserve the new value");
}

await Workbook.writeFile(verified, filename);
console.log(`Wrote and verified ${filename} (${editedBytes.byteLength} bytes)`);
