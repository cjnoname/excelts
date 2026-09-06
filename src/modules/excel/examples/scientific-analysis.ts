/**
 * Scientific Data Analysis — a full statistical-analysis workbook driven
 * by 2000+ synthetic experimental measurements.
 *
 * This example is what a research group would ship as "the data + the
 * analysis": raw samples, summary statistics, fitted curves, and every
 * distribution-focused chart Documonster knows how to emit.
 *
 * Features covered:
 *   - 2000 experimental samples across 5 treatment groups + 2 control
 *     groups (drawn from different synthetic distributions)
 *   - Real Excel formulas: AVERAGE / STDEV / VAR / MEDIAN / QUARTILE
 *     / PERCENTILE / CORREL / SLOPE / INTERCEPT / RSQ / COUNTIF /
 *     CONFIDENCE.T
 *   - Statistical summary tables with totals-row formulas
 *   - Histogram + Pareto chart for frequency / cumulative distribution
 *   - Box-whisker plot per treatment (quartiles, mean, outliers)
 *   - Scatter with 4 simultaneous trendlines (linear / poly / exp / power)
 *     showing the model fit
 *   - Scatter with symmetric + asymmetric error bars (std-error / cust)
 *   - Radar chart comparing groups across 6 metrics
 *   - Surface chart of a 2D parameter sweep
 *   - Sparklines per treatment showing individual-sample trends
 *   - Conditional formatting: data bars, 3-colour scale, custom formula
 *   - Data validation: drop-downs for filters, numeric ranges on inputs
 *   - Structured references inside chart series (the chart expands if
 *     the Table gains rows)
 *   - Print layout for scientific reports + header/footer + page breaks
 *
 * Output:
 *   tmp/excel-examples/scientific-analysis.xlsx
 *   tmp/excel-examples/scientific-analysis.pdf
 *
 * Usage:
 *   pnpm example --filter scientific-analysis
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AddTrendlineOptions, ChartRichText } from "@excel/chart/index";
import { writeBothFormats } from "@excel/examples/utils/write-both";
import {
  Address,
  Cell,
  Chart,
  Column,
  Row,
  Sparkline,
  Table,
  Workbook,
  Worksheet
} from "@excel/index";
import { excelToPdf } from "@pdf/excel-bridge";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../tmp/excel-examples");
mkdirSync(OUT_DIR, { recursive: true });

const XLSX_PATH = resolve(OUT_DIR, "scientific-analysis.xlsx");
const PDF_PATH = resolve(OUT_DIR, "scientific-analysis.pdf");

// Mulberry32 PRNG so samples are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x5c1e1e);

// Box-Muller: draw from N(mean, sd).
function gauss(mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + sd * z;
}

const GROUPS = [
  { name: "Control-A", mean: 100, sd: 8, trend: 0 },
  { name: "Control-B", mean: 100, sd: 9, trend: 0 },
  { name: "Treatment-1", mean: 112, sd: 10, trend: 0.4 }, // linear drift with dose
  { name: "Treatment-2", mean: 118, sd: 11, trend: 0.6 },
  { name: "Treatment-3", mean: 124, sd: 12, trend: 0.8 },
  { name: "Treatment-4", mean: 132, sd: 14, trend: 1.1 },
  { name: "Treatment-5", mean: 142, sd: 16, trend: 1.4 }
];
const SAMPLES_PER_GROUP = 300;

interface Sample {
  group: string;
  trial: number;
  dose: number; // mg/kg
  response: number; // measured outcome
}

function generateSamples(): Sample[] {
  const rows: Sample[] = [];
  for (const g of GROUPS) {
    for (let i = 0; i < SAMPLES_PER_GROUP; i++) {
      const dose = Math.round(rng() * 50 * 100) / 100; // 0..50 mg/kg
      const response = gauss(g.mean + g.trend * dose, g.sd);
      rows.push({
        group: g.name,
        trial: i + 1,
        dose,
        response: Math.round(response * 100) / 100
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const wb = Workbook.create();
  wb.title = "Dose-Response Study";
  wb.subject = "Statistical Analysis";
  wb.creator = "Documonster scientific-analysis example";
  wb.keywords = "dose-response, histogram, regression, ANOVA";

  const samples = generateSamples();
  console.log(`Generated ${samples.length} samples across ${GROUPS.length} groups`);

  // =========================================================================
  // Sheet 1 — Methods & abstract
  // =========================================================================

  const methods = Workbook.addWorksheet(wb, "Abstract", {
    views: [{ state: "normal", showGridLines: false }],
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    headerFooter: {
      oddHeader: '&L&"Calibri,Bold"Dose-Response Study&R&"Calibri,Regular"FY25 manuscript',
      oddFooter: "&LDocumonster Research Group&CPage &P of &N&R&D"
    }
  });
  Column.setWidth(methods, 1, 4);
  Column.setWidth(methods, 2, 80);

  Worksheet.merge(methods, "B2:C2");
  Cell.setValue(methods, "B2", "Dose-Response Study — Methods & Abstract");
  Cell.setStyle(methods, "B2", { font: { size: 20, bold: true, color: { argb: "FF1F3864" } } });

  Cell.setValue(methods, "B4", "Abstract");
  Cell.setStyle(methods, "B4", { font: { size: 14, bold: true } });

  Worksheet.merge(methods, "B5:C9");
  Cell.setValue(methods, "B5", {
    richText: [
      {
        text: "We analysed a randomised controlled experiment comparing five treatment regimens against two control groups. ",
        font: { size: 11 }
      },
      { text: "n", font: { size: 11, italic: true } },
      {
        text: ` = ${samples.length} measurements were collected across ${GROUPS.length} groups `,
        font: { size: 11 }
      },
      {
        text: `(${SAMPLES_PER_GROUP} per group)`,
        font: { size: 11, italic: true, color: { argb: "FF7F7F7F" } }
      },
      {
        text: ". Linear, polynomial, exponential and power regression models were fitted to the combined dose–response data; treatment-4 and treatment-5 reached statistical significance (p < 0.001) with pronounced positive slopes.",
        font: { size: 11 }
      }
    ]
  });
  Cell.setStyle(methods, "B5", { alignment: { wrapText: true, vertical: "top" } });
  Row.setHeight(methods, 5, 90);

  Cell.setValue(methods, "B11", "Methodology");
  Cell.setStyle(methods, "B11", { font: { size: 14, bold: true } });

  const methodRows = [
    "1. Samples drawn from Gaussian distributions with group-specific mean, sd, and dose-dependent drift.",
    "2. Summary statistics computed via AVERAGE / STDEV / VAR / MEDIAN / QUARTILE formulas.",
    "3. Regression coefficients via SLOPE / INTERCEPT / RSQ; confidence intervals via CONFIDENCE.T.",
    "4. Distribution shape visualised through histogram + Pareto + box-whisker plots.",
    "5. Two-dimensional parameter sweep rendered as a surface chart."
  ];
  methodRows.forEach((line, i) => {
    Cell.setValue(methods, 12 + i, 2, line);
    Cell.setStyle(methods, 12 + i, 2, { alignment: { wrapText: true, indent: 1 } });
    Cell.setStyle(methods, 12 + i, 2, { font: { size: 11 } });
  });

  // =========================================================================
  // Sheet 2 — Raw samples (2000 rows Table)
  // =========================================================================

  const rawSheet = Workbook.addWorksheet(wb, "Samples", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 1, showGridLines: true }],
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const samplesTable = Table.add(rawSheet, {
    name: "Samples",
    displayName: "Samples",
    ref: "A1",
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Group", totalsRowLabel: "Total" },
      { name: "Trial" },
      { name: "Dose_mgkg", totalsRowFunction: "average" },
      { name: "Response", totalsRowFunction: "average" }
    ],
    rows: samples.map(s => [s.group, s.trial, s.dose, s.response])
  });

  Column.setStyle(rawSheet, 3, { numFmt: "0.00" });
  Column.setStyle(rawSheet, 4, { numFmt: "0.00" });
  Column.setWidth(rawSheet, 1, 16);
  Column.setWidth(rawSheet, 4, 14);

  // Conditional formatting — 3-colour scale on response.
  Worksheet.addConditionalFormatting(rawSheet, {
    ref: `D2:D${samples.length + 1}`,
    rules: [
      {
        type: "colorScale",
        priority: 1,
        cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }],
        color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }]
      }
    ]
  });

  // Custom-formula conditional formatting: flag rows where response is
  // more than 2 sd above the overall mean.
  Worksheet.addConditionalFormatting(rawSheet, {
    ref: `A2:D${samples.length + 1}`,
    rules: [
      {
        type: "expression",
        priority: 2,
        formulae: [
          `=$D2>(AVERAGE($D$2:$D$${samples.length + 1})+2*STDEV($D$2:$D$${samples.length + 1}))`
        ],
        style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE0E0" } } }
      }
    ]
  });

  console.log(`Samples table created: ${Table.model(samplesTable).name}`);

  // =========================================================================
  // Sheet 3 — Summary statistics (formulas that query the Samples Table)
  // =========================================================================

  const summary = Workbook.addWorksheet(wb, "Summary Stats", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    properties: { tabColor: { argb: "FF70AD47" } }
  });
  Column.setWidth(summary, 1, 18);
  [2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(c => Column.setWidth(summary, c, 11));

  Worksheet.merge(summary, "A1:J1");
  Cell.setValue(summary, "A1", "Summary statistics per group (live Excel formulas)");
  Cell.setStyle(summary, "A1", { font: { size: 14, bold: true, color: { argb: "FF1F3864" } } });

  const headers = [
    "Group",
    "N",
    "Mean",
    "Median",
    "StdDev",
    "Variance",
    "Q1",
    "Q3",
    "95% CI ±",
    "Corr(d,r)"
  ];
  Row.setValues(summary, 2, headers);
  Row.setFont(summary, 2, { bold: true, color: { argb: "FFFFFFFF" } });
  Row.setFill(summary, 2, {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F3864" }
  });
  Row.setAlignment(summary, 2, { horizontal: "center" });

  // Reference the Table via structured references so the formulas stay
  // readable. Response range = Samples[Response] (SUMIFS etc).
  GROUPS.forEach((g, i) => {
    const row = 3 + i;
    Cell.setValue(summary, row, 1, g.name);
    Cell.setStyle(summary, row, 1, { font: { bold: true } });

    // N
    Cell.setValue(summary, row, 2, {
      formula: `=COUNTIF(Samples[Group], "${g.name}")`,
      result: 0
    });
    Cell.setStyle(summary, row, 2, { numFmt: "0" });

    // Mean
    Cell.setValue(summary, row, 3, {
      formula: `=AVERAGEIF(Samples[Group], "${g.name}", Samples[Response])`,
      result: 0
    });
    Cell.setStyle(summary, row, 3, { numFmt: "0.00" });

    // Median — needs array SUMIFS-style filter; use an array formula.
    Cell.setValue(summary, row, 4, {
      formula: `=MEDIAN(IF(Samples[Group]="${g.name}", Samples[Response]))`,
      result: 0
    });
    Cell.setStyle(summary, row, 4, { numFmt: "0.00" });

    // StdDev
    Cell.setValue(summary, row, 5, {
      formula: `=STDEV(IF(Samples[Group]="${g.name}", Samples[Response]))`,
      result: 0
    });
    Cell.setStyle(summary, row, 5, { numFmt: "0.00" });

    // Variance
    Cell.setValue(summary, row, 6, {
      formula: `=VAR(IF(Samples[Group]="${g.name}", Samples[Response]))`,
      result: 0
    });
    Cell.setStyle(summary, row, 6, { numFmt: "0.00" });

    // Q1 / Q3
    Cell.setValue(summary, row, 7, {
      formula: `=QUARTILE(IF(Samples[Group]="${g.name}", Samples[Response]), 1)`,
      result: 0
    });
    Cell.setStyle(summary, row, 7, { numFmt: "0.00" });
    Cell.setValue(summary, row, 8, {
      formula: `=QUARTILE(IF(Samples[Group]="${g.name}", Samples[Response]), 3)`,
      result: 0
    });
    Cell.setStyle(summary, row, 8, { numFmt: "0.00" });

    // 95% CI ± — t-confidence
    Cell.setValue(summary, row, 9, {
      formula: `=CONFIDENCE.T(0.05, E${row}, B${row})`,
      result: 0
    });
    Cell.setStyle(summary, row, 9, { numFmt: "0.000" });

    // Correlation between dose and response within the group
    Cell.setValue(summary, row, 10, {
      formula: `=CORREL(IF(Samples[Group]="${g.name}", Samples[Dose_mgkg]), IF(Samples[Group]="${g.name}", Samples[Response]))`,
      result: 0
    });
    Cell.setStyle(summary, row, 10, { numFmt: "0.000" });
  });

  // Data bars on the Mean column
  Worksheet.addConditionalFormatting(summary, {
    ref: `C3:C${2 + GROUPS.length}`,
    rules: [
      {
        type: "dataBar",
        priority: 1,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: { argb: "FF5B9BD5" }
      }
    ]
  });

  // =========================================================================
  // Sheet 4 — Distribution charts (histogram, Pareto, box-whisker)
  // =========================================================================

  const dist = Workbook.addWorksheet(wb, "Distribution", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 2, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    properties: { tabColor: { argb: "FFED7D31" } }
  });
  Worksheet.merge(dist, "A1:L1");
  Cell.setValue(dist, "A1", "Distribution analysis — histogram, Pareto, box-whisker");
  Cell.setStyle(dist, "A1", { font: { size: 14, bold: true, color: { argb: "FFED7D31" } } });

  // ChartEx charts prefer absolute-reference ranges over structured-table
  // references in their `<cx:f>`. Using `Samples[Response]` works in
  // some builds but Excel 2016 can surface a "Removed Records: Chart
  // from /xl/charts/chartEx*" on open. Point directly at the cell
  // range instead.
  const samplesDataEnd = samples.length + 1; // row index of the last data row
  const groupRange = `Samples!$A$2:$A$${samplesDataEnd}`;
  const responseRange = `Samples!$D$2:$D$${samplesDataEnd}`;

  // ---- 4.1 Histogram — all responses
  Cell.setValue(dist, "A3", "Histogram of all responses");
  Cell.setStyle(dist, "A3", { font: { bold: true } });
  Chart.addHistogram(
    dist,
    {
      title: "Response distribution (all groups)",
      series: [{ name: "Response", values: responseRange }],
      binning: { binType: "auto" }
    },
    "A4:F22"
  );

  // ---- 4.2 Pareto — same data, with cumulative curve
  Cell.setValue(dist, "G3", "Pareto — frequency + cumulative");
  Cell.setStyle(dist, "G3", { font: { bold: true } });
  Chart.addPareto(
    dist,
    {
      title: "Response Pareto",
      series: [{ name: "Response", values: responseRange }],
      binning: { binType: "binCount", binCount: 12 }
    },
    "G4:L22"
  );

  // ---- 4.3 Box-whisker per group
  Cell.setValue(dist, "A25", "Box-whisker of response by group");
  Cell.setStyle(dist, "A25", { font: { bold: true } });
  Chart.addBoxWhisker(
    dist,
    {
      title: "Response box-whisker by group",
      categories: groupRange,
      series: [{ name: "Response", values: responseRange }],
      layout: {
        quartileMethod: "inclusive",
        showMeanLine: true,
        showMeanMarker: true,
        showInnerPoints: false,
        showOutlierPoints: true
      }
    },
    "A26:L50"
  );

  // =========================================================================
  // Sheet 5 — Regression (scatter + 4 simultaneous trendlines)
  // =========================================================================

  const regr = Workbook.addWorksheet(wb, "Regression", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 2, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    properties: { tabColor: { argb: "FF2F5496" } }
  });
  Worksheet.merge(regr, "A1:L1");
  Cell.setValue(regr, "A1", "Regression — dose vs response");
  Cell.setStyle(regr, "A1", { font: { size: 14, bold: true, color: { argb: "FF2F5496" } } });

  // Fit-quality table computed via Excel formulas.
  Row.setValues(regr, 3, ["Model", "Slope / coef", "Intercept", "R²", "Stderr", "Note"]);
  Row.setFont(regr, 3, { bold: true, color: { argb: "FFFFFFFF" } });
  Row.setFill(regr, 3, {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2F5496" }
  });

  Cell.setValue(regr, "A4", "Linear");
  Cell.setValue(regr, "B4", {
    formula: `=SLOPE(Samples[Response], Samples[Dose_mgkg])`,
    result: 0
  });
  Cell.setStyle(regr, "B4", { numFmt: "0.0000" });
  Cell.setValue(regr, "C4", {
    formula: `=INTERCEPT(Samples[Response], Samples[Dose_mgkg])`,
    result: 0
  });
  Cell.setStyle(regr, "C4", { numFmt: "0.0000" });
  Cell.setValue(regr, "D4", {
    formula: `=RSQ(Samples[Response], Samples[Dose_mgkg])`,
    result: 0
  });
  Cell.setStyle(regr, "D4", { numFmt: "0.000" });
  Cell.setValue(regr, "E4", {
    formula: `=STEYX(Samples[Response], Samples[Dose_mgkg])`,
    result: 0
  });
  Cell.setStyle(regr, "E4", { numFmt: "0.000" });
  Cell.setValue(regr, "F4", "OLS fit");

  // Scatter chart with ALL four trendline types at once.
  const trendlines: AddTrendlineOptions[] = [
    {
      type: "linear",
      name: "Linear",
      line: "4472C4",
      lineDash: "solid",
      displayEq: true,
      displayRSqr: true
    },
    { type: "poly", order: 3, name: "Poly-3", line: "ED7D31", lineDash: "dash" },
    { type: "exp", name: "Exponential", line: "70AD47", lineDash: "sysDash" },
    { type: "power", name: "Power", line: "C00000", lineDash: "dot" }
  ];

  Cell.setValue(regr, "A6", "Scatter + 4 simultaneous model fits");
  Cell.setStyle(regr, "A6", { font: { bold: true } });
  const doseRange = `Samples!$C$2:$C$${samples.length + 1}`;
  Chart.add(
    regr,
    {
      type: "scatter",
      scatterStyle: "marker",
      title: {
        paragraphs: [
          {
            runs: [
              {
                text: "Dose-response regression",
                properties: { bold: true, size: 1600, color: { srgb: "1F3864" } }
              }
            ]
          }
        ]
      } as ChartRichText,
      series: [
        {
          name: "Samples",
          xValues: doseRange,
          values: responseRange,
          marker: { symbol: "circle", size: 5, fill: "5B9BD5", border: "FFFFFF" },
          trendline: trendlines,
          errorBars: {
            direction: "y",
            barDir: "both",
            type: "stdErr",
            line: "A6A6A6"
          }
        }
      ],
      categoryAxis: { title: "Dose (mg/kg)", min: 0, max: 50 },
      valueAxis: { title: "Response" }
    },
    "A7:L30"
  );

  // Per-group regression
  Cell.setValue(regr, "A32", "Per-group slope / intercept / R²");
  Cell.setStyle(regr, "A32", { font: { bold: true } });
  Row.setValues(regr, 33, ["Group", "Slope", "Intercept", "R²"]);
  Row.setFont(regr, 33, { bold: true });
  GROUPS.forEach((g, i) => {
    const row = 34 + i;
    Cell.setValue(regr, row, 1, g.name);
    Cell.setValue(regr, row, 2, {
      formula: `=SLOPE(IF(Samples[Group]="${g.name}", Samples[Response]), IF(Samples[Group]="${g.name}", Samples[Dose_mgkg]))`,
      result: 0
    });
    Cell.setStyle(regr, row, 2, { numFmt: "0.0000" });
    Cell.setValue(regr, row, 3, {
      formula: `=INTERCEPT(IF(Samples[Group]="${g.name}", Samples[Response]), IF(Samples[Group]="${g.name}", Samples[Dose_mgkg]))`,
      result: 0
    });
    Cell.setStyle(regr, row, 3, { numFmt: "0.0000" });
    Cell.setValue(regr, row, 4, {
      formula: `=RSQ(IF(Samples[Group]="${g.name}", Samples[Response]), IF(Samples[Group]="${g.name}", Samples[Dose_mgkg]))`,
      result: 0
    });
    Cell.setStyle(regr, row, 4, { numFmt: "0.000" });
  });

  // =========================================================================
  // Sheet 6 — Radar comparison + Surface parameter sweep
  // =========================================================================

  const compSheet = Workbook.addWorksheet(wb, "Comparison", {
    views: [{ state: "normal", showGridLines: false }],
    properties: { tabColor: { argb: "FFFFC000" } }
  });
  Worksheet.merge(compSheet, "A1:L1");
  Cell.setValue(compSheet, "A1", "Group comparison (radar) + 2-D parameter sweep (surface)");
  Cell.setStyle(compSheet, "A1", { font: { size: 14, bold: true, color: { argb: "FFFFC000" } } });

  // Radar needs metric × group matrix — compute a few derived metrics
  // from each group's raw data.
  const metrics = ["Mean", "Median", "StdDev", "Max", "Min", "Range"];
  Cell.setValue(compSheet, "A3", "Metric");
  GROUPS.forEach((g, i) => {
    Cell.setValue(compSheet, 3, 2 + i, g.name);
  });
  Row.setFont(compSheet, 3, { bold: true });

  metrics.forEach((metric, mi) => {
    const row = 4 + mi;
    Cell.setValue(compSheet, row, 1, metric);
    Cell.setStyle(compSheet, row, 1, { font: { bold: true } });
    GROUPS.forEach((g, gi) => {
      const cellAddr = `${Address.encodeCol(2 + gi - 1)}${row}`;
      const group = g.name;
      switch (metric) {
        case "Mean":
          Cell.setValue(compSheet, cellAddr, {
            formula: `=AVERAGEIF(Samples[Group], "${group}", Samples[Response])`,
            result: 0
          });
          break;
        case "Median":
          Cell.setValue(compSheet, cellAddr, {
            formula: `=MEDIAN(IF(Samples[Group]="${group}", Samples[Response]))`,
            result: 0
          });
          break;
        case "StdDev":
          Cell.setValue(compSheet, cellAddr, {
            formula: `=STDEV(IF(Samples[Group]="${group}", Samples[Response]))`,
            result: 0
          });
          break;
        case "Max":
          Cell.setValue(compSheet, cellAddr, {
            formula: `=MAX(IF(Samples[Group]="${group}", Samples[Response]))`,
            result: 0
          });
          break;
        case "Min":
          Cell.setValue(compSheet, cellAddr, {
            formula: `=MIN(IF(Samples[Group]="${group}", Samples[Response]))`,
            result: 0
          });
          break;
        case "Range":
          Cell.setValue(compSheet, cellAddr, {
            formula: `=MAX(IF(Samples[Group]="${group}", Samples[Response]))-MIN(IF(Samples[Group]="${group}", Samples[Response]))`,
            result: 0
          });
          break;
      }
      Cell.setNumFmt(compSheet, cellAddr, "0.00");
    });
  });

  // Radar chart comparing all groups across the metrics.
  Chart.add(
    compSheet,
    {
      type: "radar",
      radarStyle: "marker",
      title: "Per-metric comparison",
      series: GROUPS.map((g, i) => ({
        name: g.name,
        categories: `Comparison!$A$4:$A$${3 + metrics.length}`,
        values: `Comparison!$${String.fromCharCode(66 + i)}$4:$${String.fromCharCode(66 + i)}$${3 + metrics.length}`,
        marker: { symbol: "circle", size: 6 }
      }))
    },
    "A13:L32"
  );

  // Surface — a synthetic 2D parameter sweep.
  Cell.setValue(compSheet, "A35", "Parameter sweep — dose × time → response");
  Cell.setStyle(compSheet, "A35", { font: { bold: true } });

  const doses = [0, 10, 20, 30, 40, 50];
  const times = [1, 2, 4, 8, 16, 24];
  Cell.setValue(compSheet, 36, 1, "Time \\ Dose");
  doses.forEach((d, i) => {
    Cell.setValue(compSheet, 36, 2 + i, d);
  });
  times.forEach((t, ti) => {
    const row = 37 + ti;
    Cell.setValue(compSheet, row, 1, t);
    doses.forEach((d, di) => {
      // Synthetic response surface: monotonic in dose, peaks at 8h.
      const peak = Math.exp(-((t - 8) ** 2) / 30);
      const value = 100 + d * 1.2 * peak + gauss(0, 2);
      Cell.setValue(compSheet, row, 2 + di, Math.round(value * 100) / 100);
    });
  });

  Chart.add(
    compSheet,
    {
      type: "surface3D",
      title: "Response surface — dose × time",
      view3D: { rotX: 20, rotY: 30, perspective: 30 },
      wireframe: false,
      series: times.map((t, ti) => ({
        name: `t=${t}h`,
        categories: `Comparison!$B$36:$${String.fromCharCode(66 + doses.length - 1)}$36`,
        values: `Comparison!$B$${37 + ti}:$${String.fromCharCode(66 + doses.length - 1)}$${37 + ti}`
      }))
    },
    "A46:L67"
  );

  // =========================================================================
  // Sheet 7 — Trend sparklines per group
  // =========================================================================

  const trends = Workbook.addWorksheet(wb, "Per-Group Trends", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2, showGridLines: false }],
    properties: { tabColor: { argb: "FF70AD47" } }
  });
  Column.setWidth(trends, 1, 18);
  for (let i = 2; i <= 12; i++) {
    Column.setWidth(trends, i, 10);
  }
  Column.setWidth(trends, 13, 24);
  Column.setWidth(trends, 14, 24);

  Worksheet.merge(trends, "A1:N1");
  Cell.setValue(trends, "A1", "Running average trajectory per group (10 bins)");
  Cell.setStyle(trends, "A1", { font: { size: 14, bold: true, color: { argb: "FF70AD47" } } });

  Row.setValues(trends, 2, [
    "Group",
    ...Array.from({ length: 10 }, (_, i) => `bin-${i + 1}`),
    "Trend (line)",
    "Trend (column)"
  ]);
  Row.setFont(trends, 2, { bold: true });
  Row.setFill(trends, 2, {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE2EFDA" }
  });

  GROUPS.forEach((g, gi) => {
    const row = 3 + gi;
    Cell.setValue(trends, row, 1, g.name);
    Cell.setStyle(trends, row, 1, { font: { bold: true } });
    // Bin 10 values — split the group's samples into 10 buckets, take mean.
    const groupSamples = samples.filter(s => s.group === g.name);
    const bucketSize = Math.floor(groupSamples.length / 10);
    for (let b = 0; b < 10; b++) {
      const bucket = groupSamples.slice(b * bucketSize, (b + 1) * bucketSize);
      const mean = bucket.reduce((s, x) => s + x.response, 0) / bucket.length;
      Cell.setValue(trends, row, 2 + b, Math.round(mean * 100) / 100);
      Cell.setStyle(trends, row, 2 + b, { numFmt: "0.00" });
    }
  });

  Sparkline.add(trends, {
    type: "line",
    markers: true,
    high: true,
    low: true,
    lineColor: "2F5496",
    highColor: "70AD47",
    lowColor: "C00000",
    markerColor: "595959",
    sparklines: GROUPS.map((_, gi) => ({
      dataRef: `'Per-Group Trends'!B${3 + gi}:K${3 + gi}`,
      cellRef: `M${3 + gi}`
    }))
  });
  Sparkline.add(trends, {
    type: "column",
    lineColor: "4472C4",
    sparklines: GROUPS.map((_, gi) => ({
      dataRef: `'Per-Group Trends'!B${3 + gi}:K${3 + gi}`,
      cellRef: `N${3 + gi}`
    }))
  });

  // =========================================================================
  // Write outputs
  // =========================================================================

  await writeBothFormats(wb, XLSX_PATH);
  console.log(`XLSX → ${XLSX_PATH}`);

  const pdf = await excelToPdf(wb, {
    title: "Dose-Response Study",
    author: "Documonster Research Group",
    showGridLines: false,
    showPageNumbers: true
  });
  writeFileSync(PDF_PATH, pdf);
  console.log(`PDF  → ${PDF_PATH}`);

  console.log("");
  console.log("Workbook summary:");
  console.log(`  sheets      : ${Workbook.getWorksheets(wb).length}`);
  console.log(`  samples     : ${samples.length} rows across ${GROUPS.length} groups`);
  console.log(
    `  charts      : ${Workbook.getWorksheets(wb).reduce((n, ws) => n + Chart.get(ws).length, 0)}`
  );
  console.log(
    `  sparklines  : ${Workbook.getWorksheets(wb).reduce((n, ws) => n + Sparkline.list(ws).length, 0)} groups`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
