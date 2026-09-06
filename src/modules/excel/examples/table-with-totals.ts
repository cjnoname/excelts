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
const filename = process.argv[2] ?? path.join(outDir, "table-with-totals.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Foo");

const now = Date.now();
const today = now - (now % 86400000);

function getRows() {
  const rows: (number | Date)[][] = [];
  for (let i = 0; i < 20; i++) {
    rows.push([new Date(today + 86400000 * i), Math.random() * 10]);
  }
  return rows;
}

Worksheet.setColumns(ws, [{ key: "date", width: 16 }, { key: "number" }]);

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
    { name: "Date", totalsRowLabel: "Max:", filterButton: true },
    {
      name: "Value",
      totalsRowFunction: "max",
      filterButton: true,
      totalsRowResult: 8
    }
  ],
  rows: getRows()
});

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
