/**
 * Formatting in a binary workbook: fonts, fills, alignment, protection and page setup.
 *
 * Run: `pnpm example --filter xlsb-formatting`
 *
 * Every layout used here was read off Excel's own output rather than assumed, and two of them are
 * worth knowing about as a *caller*:
 *
 * - A `BrtFont` has no optional fields. A cell that asks only for bold reads back as Calibri 11
 *   bold, because the record cannot say "the default name at the default size, but bold" — which is
 *   also what Excel does with such a cell.
 * - Vertical alignment defaults to *bottom*, not top. So a cell with no vertical alignment is not
 *   the same as one aligned to the top, and the two are distinguishable on the round trip.
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
const filename = process.argv[2] ?? path.join(outDir, "xlsb-formatting.xlsb");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Invoice");

Worksheet.addRow(ws, ["Item", "Qty", "Price", "Total"]);
Worksheet.addRow(ws, ["Widget", 3, 9.99, 29.97]);
Worksheet.addRow(ws, ["Gadget", 1, 24.5, 24.5]);

// A header row, styled as a row rather than cell by cell. The row's format index used to be written
// as a hardcoded zero, so this had no way into the file at all.
Row.setStyle(ws, 1, {
  font: { bold: true, size: 12, color: { argb: "FFFFFFFF" } },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF305090" } },
  alignment: { horizontal: "center", vertical: "middle" }
});

// A column-wide number format, likewise.
Column.setStyle(ws, 3, { numFmt: '"$"#,##0.00', alignment: { horizontal: "right" } });
Column.setStyle(ws, 4, { numFmt: '"$"#,##0.00', alignment: { horizontal: "right" } });
Column.setWidth(ws, 1, 18);

// Text rotation and wrapping.
Cell.setValue(ws, "F1", "rotated");
Cell.setStyle(ws, "F1", { alignment: { textRotation: 90 } });
Cell.setValue(ws, "F2", "a long label that wraps");
Cell.setStyle(ws, "F2", { alignment: { wrapText: true, vertical: "top" } });

// Cell protection. Locked is Excel's default, so it is the *unlocked* cell that carries
// information — which is why the reader reports `locked: false` and never `locked: true`.
Cell.setValue(ws, "H1", "editable");
Cell.setStyle(ws, "H1", { protection: { locked: false } });

// Page setup, and the sheet's own defaults.
ws.pageSetup = {
  ...ws.pageSetup,
  paperSize: 9, // A4
  orientation: "landscape",
  scale: 90,
  margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 }
};
ws.properties = { ...ws.properties, defaultRowHeight: 16, tabColor: { argb: "FF305090" } };

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);
const read = Workbook.getWorksheets(reopened)[0]!;

console.log("row 1 style:", JSON.stringify(Row.getStyle(read, 1)));
console.log("column 3 style:", JSON.stringify(Column.getStyle(read, 3)));
console.log("F1 alignment:", JSON.stringify(Cell.getStyle(read, "F1")?.alignment));
console.log("H1 protection:", JSON.stringify(Cell.getStyle(read, "H1")?.protection));
// Locked is the default, so a cell that never mentioned protection reports none at all.
console.log("A2 protection:", JSON.stringify(Cell.getStyle(read, "A2")?.protection));
console.log("page setup:", JSON.stringify(read.pageSetup.margins), read.pageSetup.orientation);
console.log("tab colour:", JSON.stringify(read.properties.tabColor));
