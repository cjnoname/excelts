import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Workbook } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });

const filenameIn = process.argv[2] ?? path.join(exampleDir, "data/table.xlsx");
const filenameOut = process.argv[3] ?? path.join(outDir, "copy-workbook.xlsx");

// all this script does is read a file and write to another
// useful for testing for lost properties

const stopwatch = new HrStopwatch();
const wb = Workbook.create();
stopwatch.start();
Workbook.getXlsxIo(wb)
  .readFile(filenameIn)
  .then(() => writeBothFormats(wb, filenameOut))
  .then(() => {
    const micros = stopwatch.microseconds;
    console.log("Done.");
    console.log("Time taken:", micros);
  })
  .catch(error => {
    console.error("Error", error.stack);
  });
