import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Table, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "table.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");

const now = new Date();
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDay());

Worksheet.setColumns(ws, [{ key: "date", width: 32 }, { key: "number" }, { key: "word" }]);

const words = [
  "Twas",
  "brillig",
  "and",
  "the",
  "slithy",
  "toves",
  "did",
  "gyre",
  "and",
  "gimble",
  "in",
  "the",
  "wabe"
];

Table.add(ws, {
  name: "TestTable",
  ref: "A1",
  headerRow: true,
  totalsRow: true,
  style: {
    theme: "TableStyleDark3",
    showRowStripes: true
  },
  columns: [
    { name: "Date", totalsRowLabel: "Totally", filterButton: true },
    {
      name: "Id",
      totalsRowFunction: "max",
      filterButton: true,
      totalsRowResult: 8,
      style: { numFmt: "0.00%" }
    },
    {
      name: "Word",
      filterButton: false,
      style: { font: { bold: true, name: "Comic Sans MS" } }
    }
  ],
  rows: words.map((word, i) => {
    const additionalDays = 86400 * i;
    return [new Date(today + additionalDays), i, word];
  })
});

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
