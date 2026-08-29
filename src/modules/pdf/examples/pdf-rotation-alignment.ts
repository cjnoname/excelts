/**
 * Example: Rotated Text Alignment
 *
 * Demonstrates PDF rendering of rotated text with all alignment combinations:
 * - textRotation = 90 (CCW 90°) with 6 h/v alignment combos
 * - textRotation = -90 (CW 90°) with 6 h/v alignment combos
 * - textRotation = "vertical" (stacked) with 6 h/v alignment combos
 * - textRotation = 45 with slanted parallelogram borders and 6 h/v alignment combos
 *
 * Generates both an .xlsx (for Excel comparison) and a .pdf side by side.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, Row, Stream, Workbook, Worksheet } from "@excel/index";
import type { Alignment } from "@excel/types";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Rotation Alignment Test");

for (let c = 1; c <= 6; c++) {
  Column.setWidth(ws, c, 12);
}

const thinBorder = {
  top: { style: "thin" as const },
  bottom: { style: "thin" as const },
  left: { style: "thin" as const },
  right: { style: "thin" as const }
};

const combos: Array<{ h: Alignment["horizontal"]; v: Alignment["vertical"] }> = [
  { h: "center", v: "top" },
  { h: "center", v: "middle" },
  { h: "center", v: "bottom" },
  { h: "left", v: "bottom" },
  { h: "right", v: "bottom" },
  { h: "left", v: "top" }
];
const headers = [
  "h=center,v=top",
  "h=center,v=mid",
  "h=center,v=bot",
  "h=left,v=bot",
  "h=right,v=bot",
  "h=left,v=top"
];

/** Helper: populate a row section with rotated text cells. */
function addSection(
  title: string,
  titleRow: number,
  headerRow: number,
  dataRow: number,
  rowHeight: number,
  rotation: number | "vertical",
  cellValue: string | ((i: number) => string),
  wrap = false
): void {
  Cell.setValue(ws, titleRow, 1, title);
  Cell.setStyle(ws, titleRow, 1, { font: { bold: true, size: 14 } });
  Worksheet.merge(ws, titleRow, 1, titleRow, 6);

  for (let c = 0; c < 6; c++) {
    Cell.setValue(ws, headerRow, c + 1, headers[c]);
    Cell.setStyle(ws, headerRow, c + 1, { font: { size: 8 } });
  }

  Row.setHeight(ws, dataRow, rowHeight);
  for (let c = 0; c < 6; c++) {
    const cell = Row.getCell(ws, dataRow, c + 1);
    Stream.setCellValue(cell, typeof cellValue === "function" ? cellValue(c) : cellValue);
    Stream.setCellAlignment(cell, {
      horizontal: combos[c].h,
      vertical: combos[c].v,
      textRotation: rotation,
      wrapText: wrap
    });
    Stream.setCellBorder(cell, thinBorder);
  }
}

// --- Section 1: 90° CCW ---
addSection("textRotation=90 tests", 1, 2, 3, 80, 90, i => `Test ${i + 1}`, true);

// --- Section 2: -90° CW ---
addSection("textRotation=-90 (CW 90°) tests", 5, 6, 7, 80, -90, i => `Test ${i + 1}`, true);

// --- Section 3: Vertical stacked ---
addSection("textRotation=vertical (stacked) tests", 9, 10, 11, 100, "vertical", "Hi");

// --- Section 4: 45° with slanted borders ---
addSection("textRotation=45 tests", 13, 14, 15, 60, 45, i => `Test ${i + 1}`);

// --- Write outputs ---
(async () => {
  await Workbook.writeFile(wb, path.join(outDir, "pdf-rotation-alignment.xlsx"));
  console.log("Generated pdf-rotation-alignment.xlsx");

  const pdfBytes = await Pdf.fromExcel(wb, { showGridLines: true, showSheetNames: true });
  fs.writeFileSync(path.join(outDir, "pdf-rotation-alignment.pdf"), pdfBytes);
  console.log(`Generated pdf-rotation-alignment.pdf (${pdfBytes.length} bytes)`);
})();
