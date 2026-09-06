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
const password = process.argv[3] ?? "password";

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");
Cell.setValue(ws, "A1", "Bar");

async function save() {
  const stopwatch = new HrStopwatch();

  stopwatch.start();
  await Worksheet.protect(ws, password); // default 100000
  console.log("Protection Time [spinCount default]:", stopwatch.microseconds);

  await writeBothFormats(wb, path.join(outDir, `protection-spin-count-${0}.xlsx`));

  // options defined but spinCount not
  stopwatch.start();
  await Worksheet.protect(ws, password, { insertRows: true }); // default 100000
  console.log("Protection Time [spinCount default]:", stopwatch.microseconds);

  await writeBothFormats(wb, path.join(outDir, `protection-spin-count-${1}.xlsx`));

  const values = [100000, 10000, 1, 0, -1, undefined, null, NaN, Infinity, -Infinity, 31415.9265];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    stopwatch.start();
    await Worksheet.protect(ws, password, { spinCount: value ?? undefined });
    console.log(`Protection Time [spinCount ${value}]:`, stopwatch.microseconds);

    await writeBothFormats(wb, path.join(outDir, `protection-spin-count-${index + 2}.xlsx`));
  }
}

try {
  await save();
} catch (error) {
  console.log((error as Error).message);
}
