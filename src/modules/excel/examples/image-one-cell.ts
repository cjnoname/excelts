import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Image, Workbook } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });

const filename = process.argv[2] ?? path.join(outDir, "image-one-cell.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "blort");

const imageId = Image.add(wb, {
  filename: path.join(exampleDir, "data/image2.png"),
  extension: "png"
});
Image.place(ws, imageId, {
  tl: { col: 0.1125, row: 0.4 },
  br: { col: 2.101046875, row: 3.4 },
  editAs: "oneCell"
});

const stopwatch = new HrStopwatch();
stopwatch.start();
try {
  await writeBothFormats(wb, filename);
  const micros = stopwatch.microseconds;
  console.log("Done.");
  console.log("Time taken:", micros);
} catch (error) {
  console.error(error.stack);
}
