/**
 * Word Example 27 — Excel ↔ DOCX
 *
 * Covers:
 *   - excelToDocx: render every visible sheet as a Word table with the
 *     original cell formatting preserved (bold, italic, fonts, colours,
 *     alignment).
 *   - Selecting specific sheets, capping rows/columns, including the
 *     workbook title page, suppressing borders.
 *   - extractTablesToExcel: pull tabular data out of a DOCX and feed it
 *     back into a Workbook (round-trip).
 *
 * Output: tmp/word-examples/27-excel/...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";

import {
  excelToDocx,
  extractTablesToExcel,
  buildWordChartExXml,
  generateChartEmbeddedXlsx,
  renderWordChartSvg,
  wordChartToChartModel
} from "../excel";
import { Document, Io } from "../index";
import type { Chart } from "../types";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/word-examples/27-excel"
);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Build a small workbook with formatting
// ---------------------------------------------------------------------------
const wb = Workbook.create();
wb.creator = "OpenCode";
wb.created = new Date("2026-05-01");

const ws1 = Workbook.addWorksheet(wb, "Sales");
Worksheet.setColumns(ws1, [
  { header: "Region", key: "region", width: 12 },
  { header: "Q1", key: "q1", width: 10 },
  { header: "Q2", key: "q2", width: 10 },
  { header: "Q3", key: "q3", width: 10 },
  { header: "Q4", key: "q4", width: 10 }
]);
// Style header row
Row.setFont(ws1, 1, { bold: true, color: { argb: "FFFFFFFF" } });
Row.setFill(ws1, 1, {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E79" }
});
const data = [
  { region: "North", q1: 1200, q2: 1400, q3: 1600, q4: 1900 },
  { region: "South", q1: 900, q2: 1100, q3: 1300, q4: 1500 },
  { region: "East", q1: 2000, q2: 2100, q3: 2200, q4: 2400 },
  { region: "West", q1: 750, q2: 820, q3: 950, q4: 1100 }
];
for (const r of data) {
  Worksheet.addRow(ws1, r);
}
Column.setNumFmt(ws1, "q1", "$#,##0");
Column.setNumFmt(ws1, "q2", "$#,##0");
Column.setNumFmt(ws1, "q3", "$#,##0");
Column.setNumFmt(ws1, "q4", "$#,##0");

const ws2 = Workbook.addWorksheet(wb, "Inventory");
Worksheet.addRow(ws2, ["Item", "Qty", "Note"]);
Worksheet.addRow(ws2, ["Widget", 100, "in stock"]);
Worksheet.addRow(ws2, ["Gadget", 0, "OUT OF STOCK"]);
Cell.setStyle(ws2, "C3", { font: { color: { argb: "FFC00000" }, bold: true } });

// Add a hidden sheet — by default excelToDocx skips it
const ws3 = Workbook.addWorksheet(wb, "Internal");
ws3.state = "hidden";
Worksheet.addRow(ws3, ["secret", 42]);

// ---------------------------------------------------------------------------
// 2. Convert — default: every visible sheet, headings included
// ---------------------------------------------------------------------------
const docModel = excelToDocx(wb);
fs.writeFileSync(path.join(outDir, "01-default.docx"), await Io.toBuffer(docModel));
console.log(`  → 01-default.docx (${docModel.body.length} body items)`);

// ---------------------------------------------------------------------------
// 3. Custom options — only the Sales sheet, with title page, no borders
// ---------------------------------------------------------------------------
const docModel2 = excelToDocx(wb, {
  sheets: ["Sales"],
  includeSheetHeadings: false,
  includeTitlePage: true,
  includeBorders: false
});
fs.writeFileSync(path.join(outDir, "02-sales-only.docx"), await Io.toBuffer(docModel2));
console.log(`  → 02-sales-only.docx`);

// ---------------------------------------------------------------------------
// 4. Cap rows and columns — useful for previewing huge workbooks
// ---------------------------------------------------------------------------
const docModel3 = excelToDocx(wb, { maxRows: 3, maxColumns: 3 });
fs.writeFileSync(path.join(outDir, "03-capped.docx"), await Io.toBuffer(docModel3));
console.log(`  → 03-capped.docx`);

// ---------------------------------------------------------------------------
// 5. Round-trip: take a hand-built Word document with tables and pull the
//    table data back into Excel via extractTablesToExcel.
// ---------------------------------------------------------------------------
const wordDoc = Document.create();
Document.useDefaultStyles(wordDoc);
Document.addHeading(wordDoc, "Quarterly results", 1);
Document.addTable(
  wordDoc,
  [
    ["Quarter", "Revenue", "Profit"],
    ["Q1", "1.2", "0.2"],
    ["Q2", "1.5", "0.3"],
    ["Q3", "1.8", "0.4"]
  ],
  { headerRow: true, borders: true }
);
Document.addParagraph(wordDoc, "");
Document.addTable(
  wordDoc,
  [
    ["Region", "Sales"],
    ["North", "120"],
    ["South", "90"]
  ],
  { headerRow: true, borders: true }
);

const wordBuf = await Io.toBuffer(Document.build(wordDoc));
fs.writeFileSync(path.join(outDir, "04-source.docx"), wordBuf);
const reread = await Io.read(wordBuf);

const tables = extractTablesToExcel(reread);
console.log(`  extracted ${tables.length} tables from DOCX:`);
for (const t of tables) {
  console.log(`    - ${t.name}: ${t.data.length} rows`);
}

// Fold each extracted table into a sheet of a new workbook
const wb2 = Workbook.create();
for (const tbl of tables) {
  const sheet = Workbook.addWorksheet(wb2, tbl.name);
  for (const row of tbl.data) {
    Worksheet.addRow(sheet, row);
  }
}
await Workbook.writeFile(wb2, path.join(outDir, "05-extracted.xlsx"));
console.log(`  → 05-extracted.xlsx`);

// ---------------------------------------------------------------------------
// 6. Low-level chart bridge helpers — used internally by the writer when a
//    Chart appears in a Word document. They are exposed as public API so
//    callers can pre-build chart XML / SVG / embedded xlsx workbooks
//    independently of the document writer (e.g. when generating standalone
//    chart parts for templates or for off-line rendering).
// ---------------------------------------------------------------------------
{
  // 6a. wordChartToChartModel — convert a Word `Chart` definition into the
  //     internal ChartModel used by the Excel chart renderer. Useful when
  //     you want to reuse Excel's chart rendering pipeline against a
  //     Word-defined chart (e.g. for headless preview generation, or for
  //     pre-computing geometry). The returned object's shape mirrors
  //     `documonster/excel`'s ChartModel — opaque here but introspectable
  //     by anyone who wants to drill in via the Excel module.
  const sampleChart: Chart = {
    type: "column",
    title: "Quarterly revenue",
    series: [
      {
        name: "FY-25",
        categories: ["Q1", "Q2", "Q3", "Q4"],
        values: [1.2, 1.5, 1.8, 2.1]
      }
    ],
    legend: "r"
  };
  const model = wordChartToChartModel(sampleChart);
  // Top-level reachable fields of the ChartModel (the rich data lives on
  // model.chart.plotArea / model.chart.legend / model.chart.title).
  console.log(
    `  wordChartToChartModel → has chart=${"chart" in model ? "Y" : "n"}, plotArea=${"plotArea" in model.chart ? "Y" : "n"}, title=${model.chart.title ? "Y" : "n"}`
  );

  // 6b. renderWordChartSvg — render the same chart to an SVG string. Useful
  //     for embedding charts into HTML exports or for generating preview
  //     thumbnails. The function returns a self-contained SVG document.
  const svg = renderWordChartSvg(sampleChart);
  fs.writeFileSync(path.join(outDir, "06-chart-preview.svg"), svg);
  console.log(`  → 06-chart-preview.svg (${svg.length} chars)`);

  // 6c. generateChartEmbeddedXlsx — generate the embedded xlsx workbook that
  //     Word stores alongside a chart so the user can edit chart data in
  //     Excel. The workbook contains a single Sheet1 with categories in
  //     column A and series values in columns B+.
  const embeddedXlsx = await generateChartEmbeddedXlsx([
    {
      name: "FY-25",
      categories: ["Q1", "Q2", "Q3", "Q4"],
      values: [1.2, 1.5, 1.8, 2.1]
    },
    {
      name: "FY-26 forecast",
      categories: ["Q1", "Q2", "Q3", "Q4"],
      values: [1.4, 1.7, 2.1, 2.4]
    }
  ]);
  fs.writeFileSync(path.join(outDir, "06-chart-data.xlsx"), embeddedXlsx);
  console.log(`  → 06-chart-data.xlsx (${embeddedXlsx.length} bytes)`);

  // 6d. buildWordChartExXml — render a ChartEx (cx: namespace, Office 2016+)
  //     chart to its full XML representation. ChartEx covers chart types
  //     classic OOXML can't express (sunburst, treemap, waterfall, funnel,
  //     histogram, pareto, boxWhisker, regionMap).
  const chartExXml = buildWordChartExXml({
    type: "sunburst",
    title: "Population by region",
    showLegend: true,
    legendPosition: "r",
    series: [
      {
        name: "Population",
        categories: ["Asia/China", "Asia/India", "Europe/Germany", "Europe/France"],
        values: [1400, 1300, 84, 67]
      }
    ]
  });
  fs.writeFileSync(path.join(outDir, "06-chartex.xml"), chartExXml);
  console.log(`  → 06-chartex.xml (${chartExXml.length} chars)`);
}
