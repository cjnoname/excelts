import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Image, Workbook } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });

const filename = process.argv[2] ?? path.join(outDir, "images-write.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "blort");

Cell.setValue(ws, "B2", "Hello, World!");

const imageId = Image.add(wb, {
  filename: path.join(exampleDir, "data/image2.png"),
  extension: "png"
});
const backgroundId = Image.add(wb, {
  buffer: fs.readFileSync(path.join(exampleDir, "data/bubbles.jpg")),
  extension: "jpeg"
});
Image.place(ws, imageId, {
  tl: { col: 1, row: 1 },
  br: { col: 3.5, row: 5.5 }
});
Image.place(ws, imageId, "B7:E12");

Image.setBackground(ws, backgroundId);

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
