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
const filename = process.argv[2] ?? path.join(outDir, "tiny-workbook.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "blort");

Cell.setValue(ws, "A1", 7);
Cell.setValue(ws, "B1", "Hello, World!");

const stopwatch = new HrStopwatch();
stopwatch.start();
writeBothFormats(wb, filename).then(() => {
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
});
// .catch(function(error) {
//    console.log(error.message);
// })
