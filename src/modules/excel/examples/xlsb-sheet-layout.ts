/**
 * Sheet geometry through XLSB: column widths, row heights, merges, defaults and visibility.
 *
 * Run: `pnpm example --filter xlsb-sheet-layout`
 *
 * Every unit here was read off Excel's own output rather than assumed, and two are worth knowing as
 * a caller: a column width is stored in 256ths of a character (the default 8.43 characters is 2158),
 * and a row height in twips (15 points is 300). Getting either scale wrong produces a sheet that is
 * plausibly laid out and wrong by a factor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-sheet-layout.xlsb");

const wb = Workbook.create();

const grid = Workbook.addWorksheet(wb, "Geometry");
Cell.setValue(grid, "A1", "Column widths and row heights");
Cell.setStyle(grid, "A1", { font: { bold: true, size: 14 } });
Worksheet.merge(grid, "A1:E1");

Worksheet.addRow(grid, []);
Worksheet.addRow(grid, ["narrow", "default", "wide", "wider", "widest"]);
for (const [column, width] of [
  [1, 6],
  [3, 20],
  [4, 30],
  [5, 45]
] as const) {
  Column.setWidth(grid, column, width);
}

Cell.setValue(grid, "A4", "a tall row");
Row.setHeight(grid, 4, 48);
Cell.setStyle(grid, "A4", { alignment: { vertical: "middle" } });
Cell.setValue(grid, "A5", "a short row");
Row.setHeight(grid, 5, 10);

Cell.setValue(grid, "A7", "wrapped text in a tall row, which is what a height is usually for");
Cell.setStyle(grid, "A7", { alignment: { wrapText: true, vertical: "top" } });
Row.setHeight(grid, 7, 60);

// Sheet-wide defaults, which every row and column inherits unless it says otherwise.
grid.properties = { ...grid.properties, defaultRowHeight: 18, defaultColWidth: 12 };

const merges = Workbook.addWorksheet(wb, "Merges");
Cell.setValue(merges, "A1", "A banner across four columns");
Cell.setStyle(merges, "A1", {
  font: { bold: true, color: { argb: "FFFFFFFF" } },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF305090" } },
  alignment: { horizontal: "center", vertical: "middle" }
});
Worksheet.merge(merges, "A1:D1");
Row.setHeight(merges, 1, 30);

Cell.setValue(merges, "A3", "two rows tall");
Cell.setStyle(merges, "A3", { alignment: { vertical: "middle", horizontal: "center" } });
Worksheet.merge(merges, "A3:A4");
Worksheet.addRow(merges, []);
Cell.setValue(merges, "B3", "b3");
Cell.setValue(merges, "C3", "c3");
Cell.setValue(merges, "B4", "b4");
Cell.setValue(merges, "C4", "c4");

// Sheet visibility. `veryHidden` cannot be unhidden through the Excel UI, only through VBA — the
// three states were established from a workbook whose sheets are named after them and carry 0, 1
// and 2, which is as direct a confirmation as reference data gets.
const hidden = Workbook.addWorksheet(wb, "Hidden", { state: "hidden" });
Cell.setValue(hidden, "A1", "you can unhide me from the sheet tab menu");
const veryHidden = Workbook.addWorksheet(wb, "VeryHidden", { state: "veryHidden" });
Cell.setValue(veryHidden, "A1", "only VBA can unhide me");

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);
const [readGrid, readMerges, readHidden, readVeryHidden] = Workbook.getWorksheets(reopened);

console.log(
  "column widths:",
  [1, 2, 3, 4, 5].map(column => Column.getWidth(readGrid!, column)).join(", ")
);
console.log("row heights:", [4, 5, 7].map(row => Row.getHeight(readGrid!, row)).join(", "));
console.log(
  `sheet defaults: rowHeight=${readGrid!.properties.defaultRowHeight} colWidth=${readGrid!.properties.defaultColWidth}`
);
console.log("merges:", JSON.stringify(Worksheet.mergedRegions(readMerges!)));
console.log(
  "visibility:",
  Workbook.getWorksheets(reopened)
    .map(sheet => `${Worksheet.getName(sheet)}=${sheet.state ?? "visible"}`)
    .join(" ")
);
// A hidden sheet keeps its content; hiding is presentation, not deletion.
console.log(`Hidden!A1 = ${JSON.stringify(Cell.getValue(readHidden!, "A1"))}`);
console.log(`VeryHidden!A1 = ${JSON.stringify(Cell.getValue(readVeryHidden!, "A1"))}`);
