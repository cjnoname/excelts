import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Workbook } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "newline.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");

Cell.setValue(ws, "A1", " H, \n W! ");
Cell.setNote(ws, "A1", " Hello, \n World! ");
Cell.setStyle(ws, "A1", { alignment: { wrapText: true } });

Cell.setValue(ws, "C1", "H,\nW!");
Cell.setNote(ws, "C1", "H,\nW!");
Cell.setStyle(ws, "C1", { alignment: { wrapText: true } });

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
