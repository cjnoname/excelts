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
const filename = process.argv[2] ?? path.join(outDir, "comments-new-api.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");
Cell.setValue(ws, "B2", 5);
Cell.setNote(ws, "B2", {
  texts: [
    {
      font: {
        size: 12,
        color: { theme: 0 },
        name: "Calibri",
        family: 2,
        scheme: "minor"
      },
      text: "This is "
    },
    {
      font: {
        italic: true,
        size: 12,
        color: { theme: 0 },
        name: "Calibri",
        scheme: "minor"
      },
      text: "a"
    },
    {
      font: {
        size: 12,
        color: { theme: 1 },
        name: "Calibri",
        family: 2,
        scheme: "minor"
      },
      text: " "
    },
    {
      font: {
        size: 12,
        color: { argb: "FFFF6600" },
        name: "Calibri",
        scheme: "minor"
      },
      text: "colorful"
    },
    {
      font: {
        size: 12,
        color: { theme: 1 },
        name: "Calibri",
        family: 2,
        scheme: "minor"
      },
      text: " text "
    },
    {
      font: {
        size: 12,
        color: { argb: "FFCCFFCC" },
        name: "Calibri",
        scheme: "minor"
      },
      text: "with"
    },
    {
      font: {
        size: 12,
        color: { theme: 1 },
        name: "Calibri",
        family: 2,
        scheme: "minor"
      },
      text: " in-cell "
    },
    {
      font: {
        bold: true,
        size: 12,
        color: { theme: 1 },
        name: "Calibri",
        family: 2,
        scheme: "minor"
      },
      text: "format"
    }
  ]
});

Cell.setValue(ws, "D2", "Zoo");
Cell.setNote(ws, "D2", "Plain Text Comment");

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
