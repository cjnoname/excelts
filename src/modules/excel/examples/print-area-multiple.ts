import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "print-area-multiple.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "test sheet");

for (let row = 1; row <= 10; row++) {
  const values: string[] = [];
  if (row === 1) {
    values.push("");
    for (let col = 2; col <= 10; col++) {
      values.push(`Col ${col}`);
    }
  } else {
    for (let col = 1; col <= 10; col++) {
      if (col === 1) {
        values.push(`Row ${row}`);
      } else {
        values.push(`${row}-${col}`);
      }
    }
  }
  Worksheet.addRow(ws, values);
}

ws.pageSetup.printTitlesColumn = "A:A";
ws.pageSetup.printTitlesRow = "1:1";
// Multiple print areas: separate ranges with `&&` (documonster convention)
// or `,` (Excel's native syntax). Both round-trip correctly.
ws.pageSetup.printArea = "A1:B5&&A6:B10";

try {
  await writeBothFormats(wb, filename);
  console.log("Done.");
} catch (error) {
  console.log(error.message);
}
