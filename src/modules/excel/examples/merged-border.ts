import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "merged-border.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "blort");

const borders = {
  thin: {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" }
  },
  doubleRed: {
    color: { argb: "FFFF0000" },
    top: { style: "double" },
    left: { style: "double" },
    bottom: { style: "double" },
    right: { style: "double" }
  }
} as const;

// Example 1: Set borders BEFORE merge — outer borders are preserved automatically
// No need to manually set borders on each cell after merge.
Cell.setValue(ws, "B2", "Auto borders");
Cell.setStyle(ws, "B2", { border: borders.thin });
Cell.setStyle(ws, "C2", { border: borders.thin });
Worksheet.merge(ws, "B2:C2");
// Result: B2 gets {left, top, bottom}, C2 gets {right, top, bottom}

// Example 2: Rectangular merge — perimeter borders preserved, inner borders cleared
Cell.setValue(ws, "E2", "Rect merge");
Cell.setStyle(ws, "E2", { border: borders.thin });
Cell.setStyle(ws, "F2", { border: borders.thin });
Cell.setStyle(ws, "E3", { border: borders.thin });
Cell.setStyle(ws, "F3", { border: borders.thin });
Worksheet.merge(ws, "E2:F3");
// Result: E2 = {left, top}, F2 = {right, top}, E3 = {left, bottom}, F3 = {right, bottom}

// Example 3: Set borders AFTER merge — still works as before
Cell.setValue(ws, "H2", "Manual");
Worksheet.merge(ws, "H2:I3");
Cell.setStyle(ws, "H2", { border: borders.doubleRed });
Cell.setStyle(ws, "I2", { border: borders.doubleRed });
Cell.setStyle(ws, "H3", { border: borders.doubleRed });
Cell.setStyle(ws, "I3", { border: borders.doubleRed });

try {
  await writeBothFormats(wb, filename);
  console.log("Done.");
} catch (error) {
  console.log(error.message);
}
