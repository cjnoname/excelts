/**
 * Sparkline namespace API — add, list and remove sparkline groups.
 *
 * Dashboards demonstrate `Sparkline.add`/`list`, but never `Sparkline.remove`.
 * This example covers the full lifecycle:
 * - Sparkline.add    — add a sparkline group to a worksheet
 * - Sparkline.list   — list all sparkline groups on a worksheet
 * - Sparkline.remove — remove a group (by handle or index)
 *
 * Usage:
 *   pnpm example --filter sparkline-api
 *
 * Output:
 *   tmp/excel-examples/sparkline-api.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Sparkline, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "sparkline-api.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Trends");

Worksheet.addRow(ws, ["Region", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
Worksheet.addRow(ws, ["North", 540, 620, 610, 710, 805, 880]);
Worksheet.addRow(ws, ["South", 320, 300, 360, 410, 390, 460]);
Worksheet.addRow(ws, ["East", 210, 260, 250, 300, 340, 380]);

// 1. add — three sparkline groups
const line = Sparkline.add(ws, {
  type: "line",
  markers: true,
  lineColor: "5B9BD5",
  sparklines: [{ dataRef: "Trends!B2:G2", cellRef: "H2" }]
});
const column = Sparkline.add(ws, {
  type: "column",
  lineColor: "4472C4",
  sparklines: [{ dataRef: "Trends!B3:G3", cellRef: "H3" }]
});
Sparkline.add(ws, {
  type: "line",
  lineColor: "70AD47",
  sparklines: [{ dataRef: "Trends!B4:G4", cellRef: "H4" }]
});

// 2. list — should report 3 groups
console.log("groups after add:", Sparkline.list(ws).length); // 3

// 3. remove — by handle
const removedByHandle = Sparkline.remove(ws, line);
console.log("remove(line) ->", removedByHandle); // true
console.log("groups after remove(handle):", Sparkline.list(ws).length); // 2

// 4. remove — by index (the remaining 'column' group is now at index 0)
const idx = Sparkline.list(ws).indexOf(column);
const removedByIndex = Sparkline.remove(ws, idx);
console.log("remove(index) ->", removedByIndex); // true
console.log("groups after remove(index):", Sparkline.list(ws).length); // 1

// 5. remove — out-of-range index returns false
console.log("remove(99) ->", Sparkline.remove(ws, 99)); // false

await Workbook.writeFile(wb, filename);
console.log(`Done. Wrote ${filename}`);
