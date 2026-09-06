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
const filename = process.argv[2] ?? path.join(outDir, "protection.xlsx");
const password = process.argv[3] ?? "password";

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");
Cell.setValue(ws, "A1", 1);
Cell.setValue(ws, "B1", 2);
Cell.setValue(ws, "A2", { formula: "A1+2", result: 3 });
Cell.setValue(ws, "B2", { formula: "B1+2", result: 4 });

Cell.setStyle(ws, "B1", { protection: { locked: false } });
Cell.setStyle(ws, "A2", { protection: { locked: false } });
Cell.setStyle(ws, "B2", { protection: { hidden: true } });

async function save() {
  const stopwatch = new HrStopwatch();
  stopwatch.start();

  await Worksheet.protect(ws, password);
  console.log("Protection Time:", stopwatch.microseconds);

  stopwatch.start();
  await writeBothFormats(wb, filename);
  console.log("Done.");
  console.log("Time taken:", stopwatch.microseconds);
}

save().catch(error => {
  console.log(error.message);
});
