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
const filename = process.argv[2] ?? path.join(outDir, "merge-align.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "blort");

Worksheet.addRow(ws, [1, 2, 3, 4]);
Worksheet.addRow(ws, ["one", "two", "three", "four"]);
Worksheet.addRow(ws, ["une", "deux", "trois", "quatre"]);
Worksheet.addRow(ws, ["uno", "due", "tre", "quatro"]);

Worksheet.merge(ws, "B2:C3");
Cell.setStyle(ws, "B2", { alignment: { horizontal: "center", vertical: "middle" } });

const stopwatch = new HrStopwatch();
stopwatch.start();
try {
  await writeBothFormats(wb, filename);
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
} catch (error) {
  console.log(error.message);
}
