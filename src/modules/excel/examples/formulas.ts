import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "formulas.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");

Worksheet.fillFormula(ws, "A1:B2", "ROW()+COLUMN()", [
  [2, 3],
  [3, 4]
]);

Worksheet.fillFormula(ws, "A4:B5", "A1", [
  [2, 3],
  [3, 4]
]);

for (let i = 1; i <= 4; i++) {
  Cell.setValue(ws, `D${i}`, { formula: "ROW()", result: i });
}

Worksheet.fillFormula(ws, "E1:E4", "D1", [1, 1, 1, 1], "array");

// manual fill formula
Cell.setValue(ws, "F1", { formula: "ROW()", result: 1 });
Cell.setValue(ws, "F2", { sharedFormula: "F1", result: 2 });
Cell.setValue(ws, "F3", { sharedFormula: "F1", result: 3 });
Cell.setValue(ws, "F4", { sharedFormula: "F1", result: 4 });

// function fill
Cell.setValue(ws, "H1", 1);
Worksheet.fillFormula(ws, "H2:H20", "H1+1", row => row);

// array formula

Cell.setValue(ws, "I1", 1);
Cell.setValue(ws, "J1", {
  shareType: "array",
  ref: "J1:K2",
  formula: "I1",
  result: 1
});

const stopwatch = new HrStopwatch();
stopwatch.start();

try {
  await writeBothFormats(wb, filename);
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
} catch (error) {
  console.log((error as Error).message);
}
