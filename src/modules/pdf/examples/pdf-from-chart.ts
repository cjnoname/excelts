/**
 * Example: Pdf.fromChart — Render an Excel Chart to a Standalone PDF
 *
 * `Pdf.fromChart(chart, options?)` takes a single `ChartHandle` (the value
 * returned by `Chart.add(...)`) and renders it to a one-page PDF. Classic
 * charts take the vector path, so text stays selectable and shapes stay
 * resolution-independent. Options come from `ChartToPdfOptions`
 * (see pdf/excel-bridge.ts): pageWidth/pageHeight, width/height, margin,
 * title/author, forceRaster, rasterScale.
 *
 * The pdf module is allowed to reach into @excel via its bridge layer, so
 * this example builds the workbook + chart with @excel directly.
 *
 * Usage:  pnpm example --filter pdf-from-chart
 * Output: tmp/pdf-examples/from-chart-vector.pdf
 *         tmp/pdf-examples/from-chart-raster.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Chart, Workbook, Worksheet } from "@excel/index";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. Build a workbook with data and a clustered column chart
// =============================================================================

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Sales");
Worksheet.addRows(ws, [
  ["Quarter", "Revenue", "Cost"],
  ["Q1", 1200, 800],
  ["Q2", 1500, 900],
  ["Q3", 1100, 720],
  ["Q4", 1800, 1050]
]);

// Add the chart, then retrieve its ChartHandle via `Chart.get(ws)` — the
// retrieved handle carries the worksheet/workbook backref the bridge needs.
Chart.add(
  ws,
  {
    type: "bar",
    barDir: "col",
    grouping: "clustered",
    title: "Quarterly Revenue vs Cost",
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$5", values: "Sales!$B$2:$B$5", fill: "4472C4" },
      { name: "Cost", categories: "Sales!$A$2:$A$5", values: "Sales!$C$2:$C$5", fill: "ED7D31" }
    ],
    categoryAxis: { title: "Quarter" },
    valueAxis: { title: "USD", numFmt: "$#,##0" },
    legendPosition: "b"
  },
  "E2:M18"
);
const chart = Chart.get(ws)[0];

console.log("=== Pdf.fromChart ===\n");

// =============================================================================
// 2. Vector render (default path for classic charts)
// =============================================================================

const vectorBytes = await Pdf.fromChart(chart, {
  width: 520,
  height: 360,
  margin: 36,
  title: "Quarterly Chart",
  author: "documonster"
});
const vectorPath = path.join(outDir, "from-chart-vector.pdf");
fs.writeFileSync(vectorPath, vectorBytes);
console.log(`Vector chart PDF: ${vectorPath} (${vectorBytes.length} bytes)`);

// =============================================================================
// 3. Forced raster render (SVG → PNG → image XObject)
// =============================================================================

const rasterBytes = await Pdf.fromChart(chart, {
  width: 520,
  height: 360,
  forceRaster: true,
  rasterScale: 2
});
const rasterPath = path.join(outDir, "from-chart-raster.pdf");
fs.writeFileSync(rasterPath, rasterBytes);
console.log(`Raster chart PDF: ${rasterPath} (${rasterBytes.length} bytes)`);

// =============================================================================
// 4. Read the vector PDF back to confirm it is a valid one-page document
// =============================================================================

const read = await Pdf.read(vectorBytes);
console.log(
  `\nRead back: ${read.pages.length} page(s), ` +
    `${read.pages[0].width.toFixed(0)} x ${read.pages[0].height.toFixed(0)} pts, ` +
    `title="${read.metadata.title}"`
);

console.log("\n=== Done ===");
