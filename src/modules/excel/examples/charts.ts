/**
 * Charts Example — end-to-end coverage of the Excel chart API.
 *
 * One runnable script that walks through every public surface of the
 * `@excel/chart` module and its worksheet/workbook integration points:
 *
 *  1.  Classic chart types (bar/col, bar3D, line, line3D, pie, pie3D,
 *      doughnut, area, area3D, scatter, bubble, radar, stock, surface,
 *      surface3D, ofPie).
 *  2.  Chart presets — representative sample + the full 99-preset catalogue.
 *  3.  ChartEx types (histogram, pareto, waterfall, funnel, treemap,
 *      sunburst, boxWhisker, regionMap).
 *  4.  Combo charts with secondary axis, data-table, up-down bars.
 *  5.  Convenience series builders: `addChartFromTable` /
 *      `addChartFromRows`, their ChartEx siblings, `seriesFromColumns`.
 *  6.  Axes: value/category axis, log scale, custom units, date axis,
 *      rotated labels, hidden axis.
 *  7.  Rich titles, legend entries, plot-area layout, picture fills.
 *  8.  Chart styling via `setStyle(N)` and structured `chartStyle` /
 *      `chartColors` sidecars.
 *  9.  Chartsheets (full-page charts) + custom page setup + replaceChart.
 * 10.  Pivot charts + pivot chartsheets.
 * 11.  Anchor variations — one-cell, two-cell, absolute.
 * 12.  Feature deep-dive — every trendline type, every error-bar type,
 *      every marker symbol, dropLines/serLines/upDownBars/hiLowLines,
 *      gapWidth/overlap/gapDepth, firstSliceAng/holeSize, valueFromCells,
 *      per-entry data labels, gradient/pattern fills, xValueType: "text",
 *      displayBlanksAs/plotVisOnly/showDLblsOverMax, date axis, null title.
 * 13.  Headless charts — `literalValues` / `literalCategories` for
 *      charts whose data does NOT live on the worksheet.
 * 14.  Chart editing — `addSeries` / `removeSeries` / `updateSeries` /
 *      `addSeriesFromOptions` / `setStyle` / `getSeries` / `chartTypes` /
 *      `removeUserShapes` / `mutateChartEx`.
 * 15.  Low-level builders — `buildChartModel` / `buildComboChartModel` /
 *      `buildChartExModel` invoked directly for programmatic workflows.
 * 16.  `workbook.addImage` + picture fill via `workbookImageId`.
 * 17.  Full preset catalogue — all 99 classic presets on one sheet so
 *      you can see what each name produces.
 * 18.  Custom chartsheet page setup + `replaceChart`.
 * 19.  Advanced shape / effect hooks — chart-level `spPr`, full
 *      `EffectList` (shadow / glow / softEdge / reflection / blur),
 *      `Scene3D` + `ShapeProperties3D` + `Bevel`, manual plot-area
 *      layout (edge mode), chart-level `PictureOptions`, surface
 *      `bandFormats`.
 * 20.  Chart copying + vendor extensions + external parser —
 *      `chart.copyTo(targetWorksheet)`, `chart.unknownElements` for
 *      `c15:` / `cx14:` passthrough, `parseChartEx(xml)` against a
 *      synthetic XML string.
 * 21.  Chartsheet lifecycle — `rename` / `state` / `copy` / `remove` /
 *      `zoomScale` / `zoomToFit` / `replaceChart`.
 * 22.  Sparklines — `addSparklineGroup` for line / column / stacked
 *      (win-loss) in-cell mini charts with grouped axis scales.
 * 23.  Rare chart features — multi-level categorical axis
 *      (`multiLvlStrRef`), view3D `depthPercent` / `hPercent`, ChartEx
 *      `rawLayoutId` vendor passthrough, `PresetGeometry` +
 *      `CustomGeometry` + `ShapeTransform` on series `spPr`.
 * 24.  Shape / text helpers — `parseSpPr` / `buildSpPr` /
 *      `getSpPrFillColor` / `getSpPrLine` / `getSpPrGradient` /
 *      `getSpPrPattern` / `setSpPrFill` / `setSpPrLine` / `parseTxPr` /
 *      `buildTxPr` / `getTxPrFontSize` / `getTxPrColor`.
 * 25.  Sidecar parsers / writers — `parseChartStyle` / `buildChartStyle`
 *      and `parseChartColors` / `buildChartColors`, plus attaching the
 *      round-tripped sidecars to an actual chart.
 * 26.  Cache populator API — `fillChartCaches` / `fillChartExCaches` /
 *      `fillNumRef` / `fillStrRef` called directly against programmatic
 *      chart models.
 * 27.  Low-level rendering & TopoJSON — direct `renderChartSvg` /
 *      `renderChartPng` / `renderChartExSvg` / `renderChartExPng`;
 *      `buildChartScene` IR; `applyAxisTransform`; `buildEffectFilter`;
 *      `VECTOR_PDF_CHART_EX_LAYOUT_IDS`; `resolveTopologyObject` against
 *      a synthetic two-country TopoJSON; `applyChartPreset` /
 *      `applyChartExPreset` direct invocation.
 * 28.  Axis edge cases — `invertIfNegative`, reversed axis
 *      (`orientation: "maxMin"`), `crossesAt` / `crosses: "max"`,
 *      `crossBetween: "midCat"`, `tickLblSkip` / `tickMarkSkip`,
 *      `lblAlgn` / `lblOffset`, every `lineDash` preset, `logBase`
 *      variants, `showDLblsOverMax`, `showLeaderLines`, defined-name
 *      series references.
 * 29.  Data-handling edge cases — three `displayBlanksAs` modes
 *      side-by-side, negative-values with `invertIfNegative` +
 *      `inBase`, `dataLabels.delete: true` mass-hide.
 * 30.  Chart-type variants — HLC / VHLC / VOHLC stock, bubble with
 *      negative sizes + `showNegBubbles`, wide radar (12 axes × 3
 *      series), `ofPie splitType: "val"`, oversized `secondPieSize`,
 *      8×8 surface matrix.
 * 31.  ChartEx deep-dive — waterfall with `subTotal` markers,
 *      4-level treemap / sunburst, funnel with custom per-stage
 *      labels, histogram `binCount` and fixed-width + over/underflow
 *      bins, styled pareto cumulative line, boxWhisker with every
 *      statistical flag on.
 * 32.  Style catalogue — trendline with rich-text label, error bars
 *      with gradient `spPr`.
 * 33.  Stress & robustness — 100 data points, 20 series, very long
 *      titles, Unicode / emoji / RTL text, extreme `view3D`, layered
 *      data-label cascade, 12 tile charts on one sheet.
 * 34.  Preview export — `chart.toSVG()`, `chart.toPNG()`, `chartToPdf()`.
 * 35.  Loading + mutating a chart (`chart.mutate(fn, { preferRawPatch })`).
 *
 * Output:
 *   tmp/excel-examples/charts-example.xlsx     — one workbook containing every chart
 *   tmp/excel-examples/charts-example-<N>.svg  — per-chart SVG previews
 *   tmp/excel-examples/charts-example-<N>.png  — per-chart PNG previews
 *   tmp/excel-examples/charts-example.pdf      — multi-page PDF of each chart
 *
 * Usage:
 *   pnpm exec tsx src/modules/excel/examples/charts.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodePng } from "@archive/png";
import type {
  AddChartSeriesOptions,
  AddChartOptions,
  ChartStyleModel,
  ChartColorsModel,
  ChartRichText,
  AddTrendlineOptions,
  AddErrorBarsOptions,
  ChartMarker,
  RegionMapDataOptions,
  TopologyLike,
  NumberReference,
  StringReference
} from "@excel/chart/index";
import {
  EXCEL_CHART_PRESETS,
  EXCEL_CHART_EX_PRESETS,
  CHART_PRESETS,
  buildChartModel,
  buildComboChartModel,
  buildChartExModel,
  canRenderChartExAsVectorPdf,
  parseChartEx,
  applyChartPreset,
  applyChartExPreset,
  fillChartCaches,
  fillChartExCaches,
  fillNumRef,
  fillStrRef,
  parseChartStyle,
  buildChartStyle,
  parseChartColors,
  buildChartColors,
  parseSpPr,
  buildSpPr,
  getSpPrFillColor,
  getSpPrLine,
  getSpPrGradient,
  getSpPrPattern,
  setSpPrFill,
  setSpPrLine,
  parseTxPr,
  buildTxPr,
  getTxPrFontSize,
  getTxPrColor,
  resolveTopologyObject,
  renderChartSvg,
  renderChartPng,
  renderChartExSvg,
  renderChartExPng,
  buildChartScene,
  buildEffectFilter,
  applyAxisTransform,
  drawChartPdf,
  drawChartExPdf,
  VECTOR_PDF_CHART_EX_LAYOUT_IDS
} from "@excel/chart/index";
import {
  Cell,
  Chart,
  Chartsheet,
  Column,
  DefinedNames,
  Image,
  Pivot,
  Row,
  Sparkline,
  Table,
  Workbook,
  Worksheet
} from "@excel/index";
import { chartToPdf } from "@pdf/excel-bridge";
import { Pdf } from "@pdf/index";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../tmp/excel-examples");
const XLSX_PATH = resolve(OUT_DIR, "charts-example.xlsx");
const PDF_PATH = resolve(OUT_DIR, "charts-example.pdf");

mkdirSync(OUT_DIR, { recursive: true });

// Shared palette — Excel's default chart-colors "cycle" sequence. Used by
// the feature-showcase sheet when we need a deterministic colour per
// series.
const HEX_PALETTE = [
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
  "264478",
  "9E480E",
  "C00000"
];

/**
 * Convert a 1-based column / row pair into an A1 address string
 * (`cellAddr(1, 3) === "A3"`). Used by the section-33 "many charts
 * on one sheet" tile generator where the chart ranges are laid out
 * in a grid and the bookkeeping is cleaner in column / row form.
 */
function cellAddr(col: number, row: number): string {
  let c = col;
  let letters = "";
  while (c > 0) {
    const rem = (c - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return `${letters}${row}`;
}

// ---------------------------------------------------------------------------
// Data sheets — shared by most charts on the dashboard
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const wb = Workbook.create();
  wb.title = "Documonster — Chart Gallery";
  wb.creator = "Documonster charts example";
  wb.created = new Date();

  // "Sales" — month × (revenue, profit, cost, units, growth) grid used by
  // every bar / column / line / area / pivotable chart below. Kept small
  // enough to fit in printouts yet rich enough to exercise trendlines,
  // error bars and secondary axes.
  const sales = Workbook.addWorksheet(wb, "Sales");
  Worksheet.setColumns(sales, [
    { header: "Month", key: "month", width: 12 },
    { header: "Revenue", key: "revenue", width: 14 },
    { header: "Profit", key: "profit", width: 14 },
    { header: "Cost", key: "cost", width: 14 },
    { header: "Units", key: "units", width: 10 },
    { header: "Growth %", key: "growth", width: 12 }
  ]);
  Worksheet.addRows(sales, [
    { month: "Jan", revenue: 120, profit: 32, cost: 88, units: 540, growth: 0.04 },
    { month: "Feb", revenue: 180, profit: 49, cost: 131, units: 620, growth: 0.08 },
    { month: "Mar", revenue: 160, profit: 41, cost: 119, units: 610, growth: 0.02 },
    { month: "Apr", revenue: 205, profit: 64, cost: 141, units: 710, growth: 0.12 },
    { month: "May", revenue: 232, profit: 75, cost: 157, units: 805, growth: 0.13 },
    { month: "Jun", revenue: 248, profit: 81, cost: 167, units: 880, growth: 0.07 }
  ]);
  Column.setStyle(sales, "revenue", { numFmt: "$#,##0" });
  Column.setStyle(sales, "profit", { numFmt: "$#,##0" });
  Column.setStyle(sales, "cost", { numFmt: "$#,##0" });
  Column.setStyle(sales, "growth", { numFmt: "0.0%" });

  // "Scatter" — x / y pairs + bubble sizes. Dedicated sheet so scatter /
  // bubble charts have the right shape without interfering with the
  // category-axis data on the Sales sheet.
  const scatter = Workbook.addWorksheet(wb, "Scatter");
  Worksheet.addRows(scatter, [
    ["Hours", "Score", "Attempts"],
    [1, 45, 3],
    [2, 55, 5],
    [3, 62, 4],
    [4, 70, 7],
    [5, 78, 6],
    [6, 85, 9],
    [7, 90, 8]
  ]);

  // "Stock" — date / open / high / low / close for a classic OHLC stock
  // chart. Dates are real Date objects so Excel renders them as a date
  // axis.
  const stockSheet = Workbook.addWorksheet(wb, "Stock");
  Worksheet.addRow(stockSheet, ["Date", "Open", "High", "Low", "Close"]);
  const d = (iso: string): Date => new Date(iso);
  Worksheet.addRows(stockSheet, [
    [d("2024-01-02"), 150, 156, 149, 154],
    [d("2024-01-03"), 154, 158, 152, 157],
    [d("2024-01-04"), 157, 161, 155, 159],
    [d("2024-01-05"), 159, 162, 156, 160],
    [d("2024-01-08"), 160, 165, 158, 164]
  ]);
  Column.setStyle(stockSheet, 1, { numFmt: "yyyy-mm-dd" });

  // "Surface" — z values on a cat × series grid so surface / surface3D
  // charts have the 2-D matrix they expect.
  const surfaceSheet = Workbook.addWorksheet(wb, "Surface");
  Worksheet.addRow(surfaceSheet, ["", "Q1", "Q2", "Q3", "Q4"]);
  Worksheet.addRow(surfaceSheet, ["North", 10, 22, 34, 40]);
  Worksheet.addRow(surfaceSheet, ["South", 15, 25, 37, 48]);
  Worksheet.addRow(surfaceSheet, ["East", 12, 20, 30, 42]);
  Worksheet.addRow(surfaceSheet, ["West", 18, 28, 39, 50]);

  // "Hierarchy" — 3-level category data for sunburst / treemap.
  const hier = Workbook.addWorksheet(wb, "Hierarchy");
  Worksheet.addRows(hier, [
    ["Region", "Country", "City", "Sales"],
    ["Americas", "USA", "New York", 420],
    ["Americas", "USA", "San Francisco", 360],
    ["Americas", "Brazil", "São Paulo", 210],
    ["EMEA", "UK", "London", 310],
    ["EMEA", "Germany", "Berlin", 280],
    ["EMEA", "France", "Paris", 240],
    ["APAC", "Japan", "Tokyo", 400],
    ["APAC", "China", "Shanghai", 520],
    ["APAC", "Australia", "Sydney", 180]
  ]);

  // "Distribution" — raw samples for histogram / pareto / boxWhisker.
  const dist = Workbook.addWorksheet(wb, "Distribution");
  Worksheet.addRow(dist, ["Sample"]);
  // 40 synthetic samples clustered around two modes to give the
  // histogram a bi-modal shape and the box-whisker chart visible
  // whiskers + outliers.
  const samples = [
    52, 54, 57, 59, 60, 61, 62, 63, 63, 64, 65, 66, 67, 68, 69, 70, 72, 73, 75, 76, 78, 80, 82, 84,
    85, 86, 88, 90, 92, 94, 28, 35, 42, 96, 98, 102, 110, 115, 118, 122
  ];
  samples.forEach(n => Worksheet.addRow(dist, [n]));

  // "Regions" — country → value for a region-map chart.
  const regions = Workbook.addWorksheet(wb, "Regions");
  Worksheet.addRows(regions, [
    ["Country", "Revenue"],
    ["United States", 840],
    ["Germany", 410],
    ["Japan", 380],
    ["Brazil", 220],
    ["India", 310],
    ["Australia", 150]
  ]);

  // ---------------------------------------------------------------------------
  // 1. Classic chart gallery — every type Excel exposes (16 types).
  // ---------------------------------------------------------------------------

  const gallery = Workbook.addWorksheet(wb, "1-Classic Gallery");
  Worksheet.addRow(gallery, ["Type", "Notes"]);

  // Compact helper that stamps a label row, then positions the chart in
  // a 9-column × 15-row block to the right of the label so the gallery
  // reads left-to-right.
  let galleryRow = 2;
  const galleryChart = (
    label: string,
    options: AddChartOptions,
    opts?: { rows?: number }
  ): number => {
    Cell.setValue(gallery, `A${galleryRow}`, label);
    Cell.setStyle(gallery, `A${galleryRow}`, { font: { bold: true } });
    const rows = opts?.rows ?? 15;
    const top = galleryRow;
    const bottom = galleryRow + rows;
    galleryRow = bottom + 1;
    return Chart.add(gallery, options, `B${top}:J${bottom}`);
  };

  // -- Bar / Column family
  galleryChart("bar (horizontal)", {
    type: "bar",
    barDir: "bar",
    grouping: "clustered",
    title: "Horizontal bar",
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7", fill: "4472C4" }
    ],
    categoryAxis: { title: "Month" },
    valueAxis: { title: "USD", numFmt: "$#,##0" }
  });

  galleryChart("bar (column, clustered)", {
    type: "bar",
    barDir: "col",
    grouping: "clustered",
    title: "Revenue vs Cost",
    gapWidth: 120,
    overlap: -10,
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7", fill: "4472C4" },
      { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7", fill: "ED7D31" }
    ],
    dataLabels: { showVal: true, position: "outEnd", numFmt: "$0" },
    valueAxis: { title: "USD", majorGridlines: true, numFmt: "$#,##0" }
  });

  galleryChart("bar stacked", {
    type: "bar",
    barDir: "col",
    grouping: "stacked",
    title: "Revenue breakdown (stacked)",
    series: [
      { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7", fill: "70AD47" },
      { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7", fill: "FFC000" }
    ],
    legendPosition: "b"
  });

  galleryChart("bar percent-stacked", {
    type: "bar",
    barDir: "col",
    grouping: "percentStacked",
    title: "Revenue mix (100% stacked)",
    series: [
      { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" },
      { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
    ]
  });

  galleryChart("bar3D (extruded)", {
    type: "bar3D",
    barDir: "col",
    grouping: "clustered",
    shape: "box",
    title: "Extruded box 3D",
    view3D: { rotX: 15, rotY: 20, rAngAx: true, perspective: 30 },
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7", fill: "4472C4" }
    ],
    floor: { fill: "F2F2F2" },
    backWall: { fill: "FFFFFF", border: "BFBFBF" },
    sideWall: { fill: "FAFAFA" }
  });

  galleryChart("bar3D (cylinder)", {
    type: "bar3D",
    barDir: "col",
    grouping: "clustered",
    shape: "cylinder",
    title: "3D cylinder bars",
    series: [{ name: "Units", categories: "Sales!$A$2:$A$7", values: "Sales!$E$2:$E$7" }]
  });

  // -- Line family
  galleryChart("line (with markers)", {
    type: "line",
    title: "Revenue trend",
    smooth: true,
    showMarker: true,
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        line: "4472C4",
        lineWidth: 2.5,
        marker: { symbol: "circle", size: 8, fill: "4472C4", border: "FFFFFF" },
        trendline: {
          type: "linear",
          displayEq: true,
          displayRSqr: true,
          lineDash: "dash",
          line: "ED7D31",
          forward: 1
        },
        errorBars: {
          direction: "y",
          barDir: "both",
          type: "percentage",
          value: 10,
          line: "A6A6A6"
        }
      }
    ],
    valueAxis: { min: 0, max: 300, majorUnit: 50, majorGridlines: true, numFmt: "$#,##0" }
  });

  galleryChart("line stacked", {
    type: "line",
    grouping: "stacked",
    title: "Stacked line",
    showMarker: true,
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
      { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" }
    ]
  });

  galleryChart("line3D", {
    type: "line3D",
    title: "Line (3D)",
    view3D: { rotX: 20, rotY: 20 },
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
      { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
    ]
  });

  // -- Pie / Doughnut / OfPie family
  galleryChart("pie", {
    type: "pie",
    title: "Revenue by month",
    firstSliceAng: 10,
    varyColors: true,
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        dataLabels: { showPercent: true, showCatName: true, position: "outEnd", separator: " • " },
        // Pull two slices out of the centre
        dataPoints: [
          { index: 0, explosion: 15, fill: "4472C4" },
          { index: 3, explosion: 25, fill: "ED7D31" }
        ]
      }
    ]
  });

  galleryChart("pie3D", {
    type: "pie3D",
    title: "3D pie",
    view3D: { rotX: 30, rotY: 0, perspective: 15 },
    series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
  });

  galleryChart("doughnut", {
    type: "doughnut",
    title: "Doughnut (hole=60)",
    holeSize: 60,
    varyColors: true,
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        // `c:dLblPos` is not a valid child of `<c:dLbls>` inside a
        // doughnut series — see `VALID_DLBL_POSITIONS_BY_TYPE` in
        // chart-builder.ts. Only emit the number format + show flag.
        dataLabels: { showVal: true, numFmt: "$#,##0" }
      }
    ],
    legendPosition: "r"
  });

  galleryChart("ofPie (pie-of-pie)", {
    type: "ofPie",
    ofPieType: "pie",
    splitType: "pos",
    splitPos: 3,
    secondPieSize: 75,
    title: "Pie-of-pie",
    series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
  });

  // -- Area family
  galleryChart("area", {
    type: "area",
    title: "Area chart",
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        spPr: { fill: { solid: { srgb: "4472C4", alpha: 60000 } } }
      }
    ]
  });

  galleryChart("area stacked", {
    type: "area",
    grouping: "stacked",
    title: "Area (stacked)",
    series: [
      { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" },
      { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
    ]
  });

  galleryChart("area3D", {
    type: "area3D",
    title: "Area (3D)",
    view3D: { rotX: 15, rotY: 20 },
    series: [
      { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" },
      { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
    ]
  });

  // -- Scatter / Bubble
  galleryChart("scatter (smooth, markers)", {
    type: "scatter",
    scatterStyle: "smoothMarker",
    title: "Study hours vs score",
    series: [
      {
        name: "Students",
        xValues: "Scatter!$A$2:$A$8",
        values: "Scatter!$B$2:$B$8",
        marker: { symbol: "diamond", size: 9, fill: "5B9BD5", border: "FFFFFF" },
        trendline: { type: "poly", order: 2, line: "ED7D31", lineDash: "sysDash" }
      }
    ],
    categoryAxis: { title: "Hours studied" },
    valueAxis: { title: "Score" }
  });

  galleryChart("bubble", {
    type: "bubble",
    title: "Hours × score (bubble = attempts)",
    bubbleScale: 80,
    showNegBubbles: false,
    sizeRepresents: "area",
    series: [
      {
        name: "Students",
        xValues: "Scatter!$A$2:$A$8",
        values: "Scatter!$B$2:$B$8",
        bubbleSize: "Scatter!$C$2:$C$8",
        fill: "70AD47"
      }
    ]
  });

  // -- Radar family
  galleryChart("radar (standard)", {
    type: "radar",
    radarStyle: "standard",
    title: "Radar",
    series: [
      { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
      { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" }
    ]
  });

  galleryChart("radar (filled)", {
    type: "radar",
    radarStyle: "filled",
    title: "Filled radar",
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        spPr: { fill: { solid: { srgb: "4472C4", alpha: 40000 } } }
      }
    ]
  });

  // -- Stock (OHLC)
  galleryChart("stock (OHLC)", {
    type: "stock",
    title: "Open-High-Low-Close",
    hiLowLines: true,
    upDownBars: {
      gapWidth: 150,
      upBars: { fill: "FFFFFF", border: "70AD47" },
      downBars: { fill: "C00000", border: "C00000" }
    },
    series: [
      {
        name: "Open",
        categories: "Stock!$A$2:$A$6",
        values: "Stock!$B$2:$B$6",
        line: "70AD47",
        marker: { symbol: "none" }
      },
      {
        name: "High",
        categories: "Stock!$A$2:$A$6",
        values: "Stock!$C$2:$C$6",
        line: "70AD47",
        marker: { symbol: "none" }
      },
      {
        name: "Low",
        categories: "Stock!$A$2:$A$6",
        values: "Stock!$D$2:$D$6",
        line: "C00000",
        marker: { symbol: "none" }
      },
      {
        name: "Close",
        categories: "Stock!$A$2:$A$6",
        values: "Stock!$E$2:$E$6",
        line: "000000",
        marker: { symbol: "none" }
      }
    ],
    categoryAxis: { numFmt: "yyyy-mm-dd" }
  });

  // -- Surface family
  galleryChart("surface (contour)", {
    type: "surface",
    title: "Contour (surface top-down)",
    series: [
      { name: "North", categories: "Surface!$B$1:$E$1", values: "Surface!$B$2:$E$2" },
      { name: "South", categories: "Surface!$B$1:$E$1", values: "Surface!$B$3:$E$3" },
      { name: "East", categories: "Surface!$B$1:$E$1", values: "Surface!$B$4:$E$4" },
      { name: "West", categories: "Surface!$B$1:$E$1", values: "Surface!$B$5:$E$5" }
    ]
  });

  galleryChart("surface3D (wireframe)", {
    type: "surface3D",
    wireframe: true,
    title: "Wireframe surface",
    view3D: { rotX: 20, rotY: 30, perspective: 30 },
    series: [
      { name: "North", categories: "Surface!$B$1:$E$1", values: "Surface!$B$2:$E$2" },
      { name: "South", categories: "Surface!$B$1:$E$1", values: "Surface!$B$3:$E$3" },
      { name: "East", categories: "Surface!$B$1:$E$1", values: "Surface!$B$4:$E$4" },
      { name: "West", categories: "Surface!$B$1:$E$1", values: "Surface!$B$5:$E$5" }
    ]
  });

  // ---------------------------------------------------------------------------
  // 2. Chart presets — 70+ Excel UI aliases exposed through `addPresetChart`.
  // ---------------------------------------------------------------------------

  const presets = Workbook.addWorksheet(wb, "2-Presets");
  Worksheet.addRow(presets, ["Preset", "Notes"]);
  Cell.setStyle(presets, "A1", { font: { bold: true } });

  // Demonstrate a representative sample from every preset family.
  const presetCatalog: Array<{ preset: string; title: string }> = [
    { preset: "columnClustered", title: "Column, clustered" },
    { preset: "columnStacked", title: "Column, stacked" },
    { preset: "columnStacked100", title: "Column, 100% stacked" },
    { preset: "col3DConeStacked100", title: "3D cone, 100% stacked" },
    { preset: "col3DCylinderClustered", title: "3D cylinder, clustered" },
    { preset: "col3DPyramidStacked", title: "3D pyramid, stacked" },
    { preset: "barStacked", title: "Bar, stacked" },
    { preset: "pieOfPie", title: "Pie-of-pie" },
    { preset: "barOfPie", title: "Bar-of-pie" },
    { preset: "lineMarkers", title: "Line with markers" },
    { preset: "pieExploded", title: "Exploded pie" },
    { preset: "doughnutExploded", title: "Exploded doughnut" },
    { preset: "scatterSmoothMarker", title: "Scatter smooth + markers" },
    { preset: "bubble3D", title: "Bubble with 3D effect" },
    { preset: "radarFilled", title: "Radar filled" },
    { preset: "stockOHLC", title: "Stock OHLC" },
    { preset: "surface3D", title: "Surface 3D" },
    { preset: "surfaceTopView", title: "Surface top view" },
    { preset: "wireframeSurface", title: "Wireframe surface" }
  ];

  presetCatalog.forEach((entry, i) => {
    const row = 2 + i * 16;
    Cell.setValue(presets, `A${row}`, entry.preset);
    Cell.setStyle(presets, `A${row}`, { font: { bold: true } });
    Cell.setValue(presets, `A${row + 1}`, entry.title);

    // `addPresetChart` auto-fills the `type` from the preset. The caller
    // only has to supply series + any chart-specific overrides.
    const series: AddChartSeriesOptions[] =
      entry.preset === "scatterSmoothMarker"
        ? [{ xValues: "Scatter!$A$2:$A$8", values: "Scatter!$B$2:$B$8", name: "Scatter" }]
        : entry.preset === "bubble3D"
          ? [
              {
                xValues: "Scatter!$A$2:$A$8",
                values: "Scatter!$B$2:$B$8",
                bubbleSize: "Scatter!$C$2:$C$8",
                name: "Bubble",
                bubble3D: true
              }
            ]
          : entry.preset === "stockOHLC"
            ? [
                { name: "Open", categories: "Stock!$A$2:$A$6", values: "Stock!$B$2:$B$6" },
                { name: "High", categories: "Stock!$A$2:$A$6", values: "Stock!$C$2:$C$6" },
                { name: "Low", categories: "Stock!$A$2:$A$6", values: "Stock!$D$2:$D$6" },
                { name: "Close", categories: "Stock!$A$2:$A$6", values: "Stock!$E$2:$E$6" }
              ]
            : entry.preset.startsWith("surface")
              ? [
                  { name: "N", categories: "Surface!$B$1:$E$1", values: "Surface!$B$2:$E$2" },
                  { name: "S", categories: "Surface!$B$1:$E$1", values: "Surface!$B$3:$E$3" },
                  { name: "E", categories: "Surface!$B$1:$E$1", values: "Surface!$B$4:$E$4" },
                  { name: "W", categories: "Surface!$B$1:$E$1", values: "Surface!$B$5:$E$5" }
                ]
              : [
                  {
                    name: "Revenue",
                    categories: "Sales!$A$2:$A$7",
                    values: "Sales!$B$2:$B$7"
                  },
                  {
                    name: "Cost",
                    categories: "Sales!$A$2:$A$7",
                    values: "Sales!$D$2:$D$7"
                  }
                ];

    Chart.addPreset(
      presets,
      entry.preset as (typeof EXCEL_CHART_PRESETS)[number],
      { title: entry.title, series },
      `B${row}:J${row + 14}`
    );
  });

  // ---------------------------------------------------------------------------
  // 3. ChartEx gallery — Office 2016+ modern chart types.
  // ---------------------------------------------------------------------------

  const ex = Workbook.addWorksheet(wb, "3-ChartEx Gallery");
  Worksheet.addRow(ex, ["Type"]);
  Cell.setStyle(ex, "A1", { font: { bold: true } });
  let exRow = 2;
  const addExChart = (label: string, anchorHeight: number, cb: (range: string) => void): void => {
    Cell.setValue(ex, `A${exRow}`, label);
    Cell.setStyle(ex, `A${exRow}`, { font: { bold: true } });
    const top = exRow;
    const bottom = exRow + anchorHeight;
    cb(`B${top}:J${bottom}`);
    exRow = bottom + 1;
  };

  addExChart("histogram", 15, range => {
    Chart.addHistogram(
      ex,
      {
        title: "Histogram",
        series: [{ name: "Samples", values: "Distribution!$A$2:$A$41" }],
        binning: { binType: "auto" }
      },
      range
    );
  });

  addExChart("pareto", 15, range => {
    Chart.addPareto(
      ex,
      {
        title: "Pareto (histogram + cumulative)",
        series: [{ name: "Samples", values: "Distribution!$A$2:$A$41" }],
        binning: { binType: "binCount", binCount: 8 }
      },
      range
    );
  });

  addExChart("waterfall", 15, range => {
    Chart.addWaterfall(
      ex,
      {
        title: "Revenue waterfall",
        categories: "Sales!$A$2:$A$7",
        series: [
          {
            name: "Delta",
            values: "Sales!$C$2:$C$7",
            subtotals: [0, 5] // Mark first & last data points as subtotals
          }
        ],
        layout: { connectorLines: true }
      },
      range
    );
  });

  addExChart("funnel", 15, range => {
    Chart.addFunnel(
      ex,
      {
        title: "Sales funnel",
        categories: "Sales!$A$2:$A$7",
        series: [{ name: "Stages", values: "Sales!$B$2:$B$7" }]
      },
      range
    );
  });

  addExChart("treemap", 15, range => {
    Chart.addTreemap(
      ex,
      {
        title: "Sales treemap",
        categories: "Hierarchy!$C$2:$C$10",
        series: [
          {
            name: "Sales",
            values: "Hierarchy!$D$2:$D$10",
            hierarchy: ["Hierarchy!$A$2:$A$10", "Hierarchy!$B$2:$B$10"]
          }
        ],
        layout: { parentLabelLayout: "banner" }
      },
      range
    );
  });

  addExChart("sunburst", 15, range => {
    Chart.addSunburst(
      ex,
      {
        title: "Sales sunburst",
        categories: "Hierarchy!$C$2:$C$10",
        series: [
          {
            name: "Sales",
            values: "Hierarchy!$D$2:$D$10",
            hierarchy: ["Hierarchy!$A$2:$A$10", "Hierarchy!$B$2:$B$10"]
          }
        ]
      },
      range
    );
  });

  addExChart("boxWhisker", 15, range => {
    Chart.addBoxWhisker(
      ex,
      {
        title: "Distribution box-whisker",
        categories: "Distribution!$A$1:$A$1",
        series: [
          {
            name: "Samples",
            values: "Distribution!$A$2:$A$41"
          }
        ],
        layout: {
          quartileMethod: "inclusive",
          showMeanLine: true,
          showMeanMarker: true,
          showInnerPoints: true,
          showOutlierPoints: true
        }
      },
      range
    );
  });

  addExChart("regionMap", 15, range => {
    Chart.addRegionMap(
      ex,
      {
        title: "Revenue by country",
        categories: "Regions!$A$2:$A$7",
        series: [{ name: "Revenue", values: "Regions!$B$2:$B$7" }],
        layout: {
          projection: "mercator",
          regionLabels: "bestFit",
          geoMappingLevel: "country"
        }
      },
      range
    );
  });

  // ChartEx presets — same shape as classic presets but using
  // `addPresetChartEx` / `EXCEL_CHART_EX_PRESETS`.
  addExChart("preset: boxAndWhisker alias", 15, range => {
    Chart.addPresetEx(
      ex,
      "boxAndWhisker",
      {
        title: "Preset alias",
        categories: "Distribution!$A$1:$A$1",
        series: [{ name: "Samples", values: "Distribution!$A$2:$A$41" }]
      },
      range
    );
  });
  console.log(`ChartEx presets known: ${EXCEL_CHART_EX_PRESETS.join(", ")}`);

  // ---------------------------------------------------------------------------
  // 4. Combo charts — multiple chart-type groups with secondary axes,
  //    up-down bars, data tables, and 3D wall styling.
  // ---------------------------------------------------------------------------

  const combo = Workbook.addWorksheet(wb, "4-Combo");
  Worksheet.addRow(combo, ["Combo charts"]);
  Cell.setStyle(combo, "A1", { font: { bold: true } });

  // Column + line on secondary axis — the canonical combo layout.
  Chart.addCombo(
    combo,
    {
      title: "Revenue (bars) vs Growth (line, secondary axis)",
      groups: [
        {
          type: "bar",
          barDir: "col",
          grouping: "clustered",
          series: [
            {
              name: "Revenue",
              categories: "Sales!$A$2:$A$7",
              values: "Sales!$B$2:$B$7",
              fill: "4472C4"
            }
          ]
        },
        {
          type: "line",
          useSecondaryAxis: true,
          series: [
            {
              name: "Growth",
              categories: "Sales!$A$2:$A$7",
              values: "Sales!$F$2:$F$7",
              line: "ED7D31",
              lineWidth: 2,
              marker: { symbol: "circle", size: 7, fill: "ED7D31", border: "FFFFFF" }
            }
          ]
        }
      ],
      showLegend: true,
      legendPosition: "b",
      dataTable: { showHorzBorder: true, showVertBorder: true, showOutline: true, showKeys: true }
    },
    "A3:L22"
  );

  // Stacked bar + line trend combo
  Chart.addCombo(
    combo,
    {
      title: "Stacked revenue + total trend",
      groups: [
        {
          type: "bar",
          barDir: "col",
          grouping: "stacked",
          series: [
            { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" },
            { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
          ]
        },
        {
          type: "line",
          series: [
            {
              name: "Revenue",
              categories: "Sales!$A$2:$A$7",
              values: "Sales!$B$2:$B$7",
              smooth: true,
              line: "C00000",
              lineWidth: 2.5,
              marker: { symbol: "square", size: 7 }
            }
          ]
        }
      ]
    },
    "A24:L43"
  );

  // Volume-HLC: bar for volume on primary axis + stock on secondary
  // axis — the exact combo that used to be named `stockVHLC` in the
  // preset registry; see `chart-presets.ts` for the removal note.
  Chart.addCombo(
    combo,
    {
      title: "Volume + HLC (combo)",
      groups: [
        {
          type: "bar",
          barDir: "col",
          series: [
            {
              name: "Volume",
              categories: "Stock!$A$2:$A$6",
              values: "Stock!$E$2:$E$6",
              fill: "A6A6A6"
            }
          ]
        },
        {
          type: "stock",
          useSecondaryAxis: true,
          hiLowLines: true,
          series: [
            { name: "High", categories: "Stock!$A$2:$A$6", values: "Stock!$C$2:$C$6" },
            { name: "Low", categories: "Stock!$A$2:$A$6", values: "Stock!$D$2:$D$6" },
            { name: "Close", categories: "Stock!$A$2:$A$6", values: "Stock!$E$2:$E$6" }
          ]
        }
      ]
    },
    "A45:L64"
  );

  // ---------------------------------------------------------------------------
  // 5. Helper APIs — `addChartFromRows`, `addChartFromTable`,
  //    `addColumnChartFromRows`, `addChartExFromRows`, `seriesFromColumns`.
  // ---------------------------------------------------------------------------

  const helpers = Workbook.addWorksheet(wb, "5-Helper APIs");
  Worksheet.addRow(helpers, ["Helper APIs"]);
  Cell.setStyle(helpers, "A1", { font: { bold: true } });

  // -- `addChartFromRows`: write rows + build chart from the JS array.
  // Returns a regular chart, so you can chain formatting later.
  Cell.setValue(helpers, "A3", "addChartFromRows");
  Cell.setStyle(helpers, "A3", { font: { bold: true } });
  Chart.addFromRows(
    helpers,
    [
      { day: "Mon", visits: 312 },
      { day: "Tue", visits: 400 },
      { day: "Wed", visits: 280 },
      { day: "Thu", visits: 530 },
      { day: "Fri", visits: 470 }
    ],
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Visitors this week",
      startCell: "A4",
      x: "day",
      y: "visits"
    },
    "C3:K17"
  );

  // -- `addColumnChartFromRows`: shortcut — same as above but `type` /
  // `barDir` are implied.
  Cell.setValue(helpers, "A20", "addColumnChartFromRows");
  Cell.setStyle(helpers, "A20", { font: { bold: true } });
  Chart.addColumnFromRows(
    helpers,
    [
      { quarter: "Q1", revenue: 1.2 },
      { quarter: "Q2", revenue: 1.8 },
      { quarter: "Q3", revenue: 1.5 },
      { quarter: "Q4", revenue: 2.1 }
    ],
    {
      title: "Quarterly revenue",
      startCell: "A21",
      x: "quarter",
      y: "revenue"
    },
    "C20:K34"
  );

  // -- `addChartFromTable`: pull series out of a structured Excel Table
  // so the chart expands when the table grows.
  const tblSheet = Workbook.addWorksheet(wb, "5b-Table-backed");
  const table = Table.add(tblSheet, {
    name: "MonthlyKpis",
    ref: "A1",
    headerRow: true,
    totalsRow: true,
    columns: [
      { name: "Month" },
      { name: "Revenue", totalsRowFunction: "sum" },
      { name: "Profit", totalsRowFunction: "sum" },
      { name: "Units", totalsRowFunction: "sum" }
    ],
    rows: [
      ["Jan", 120, 32, 540],
      ["Feb", 180, 49, 620],
      ["Mar", 160, 41, 610],
      ["Apr", 205, 64, 710],
      ["May", 232, 75, 805],
      ["Jun", 248, 81, 880]
    ]
  });

  Chart.addFromTable(
    tblSheet,
    table,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Table-backed — expands with data",
      categoryColumn: "Month",
      valueColumns: ["Revenue", "Profit"]
    },
    "F1:N18"
  );

  // -- `seriesFromColumns`: compose series from raw column ranges.
  Cell.setValue(helpers, "A38", "seriesFromColumns");
  Cell.setStyle(helpers, "A38", { font: { bold: true } });
  const seriesA = Chart.seriesFromColumns(helpers, {
    categories: "Sales!$A$2:$A$7",
    values: "Sales!$B$2:$B$7",
    name: "Revenue"
  });
  const seriesB = Chart.seriesFromColumns(helpers, {
    categories: "Sales!$A$2:$A$7",
    values: "Sales!$C$2:$C$7",
    name: "Profit"
  });
  Chart.add(
    helpers,
    {
      type: "line",
      title: "Built via seriesFromColumns",
      showMarker: true,
      series: [seriesA, seriesB]
    },
    "C38:K52"
  );

  // -- `addChartExFromTable`: same idea, for modern ChartEx types.
  Chart.addExFromTable(
    tblSheet,
    table,
    {
      type: "funnel",
      title: "Funnel from table",
      categoryColumn: "Month",
      valueColumns: ["Revenue"]
    },
    "F20:N37"
  );

  // ---------------------------------------------------------------------------
  // 6. Axis features — secondary axis, log scale, rotated labels, custom
  //    units, date axis, hidden axis.
  // ---------------------------------------------------------------------------

  const axes = Workbook.addWorksheet(wb, "6-Axes");
  Worksheet.addRow(axes, ["Axis showcase"]);
  Cell.setStyle(axes, "A1", { font: { bold: true } });

  Chart.add(
    axes,
    {
      type: "line",
      title: "Log scale axis, rotated labels",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          smooth: true
        }
      ],
      categoryAxis: {
        title: "Month",
        textRotation: -45,
        majorTickMark: "outside",
        minorTickMark: "none"
      },
      valueAxis: {
        title: "Revenue (USD, log10)",
        logBase: 10,
        min: 10,
        max: 1000,
        majorGridlines: true,
        minorGridlines: true,
        numFmt: "$#,##0"
      }
    },
    "A3:I22"
  );

  Chart.add(
    axes,
    {
      type: "line",
      title: "Display units (thousands)",
      series: [{ name: "Units", categories: "Sales!$A$2:$A$7", values: "Sales!$E$2:$E$7" }],
      valueAxis: {
        title: "Units sold",
        displayUnits: "thousands",
        displayUnitsLabel: "× 1 000"
      }
    },
    "A24:I43"
  );

  Chart.add(
    axes,
    {
      type: "line",
      title: "Hidden value axis, minimalist axes",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          line: "4472C4",
          lineWidth: 3,
          marker: { symbol: "none" }
        }
      ],
      valueAxis: { hidden: true },
      categoryAxis: { majorTickMark: "none", minorTickMark: "none" },
      showLegend: false
    },
    "A45:I64"
  );

  // ---------------------------------------------------------------------------
  // 7. Rich titles, legend entries, plot-area layout, picture fills.
  // ---------------------------------------------------------------------------

  const rich = Workbook.addWorksheet(wb, "7-Rich Formatting");
  Worksheet.addRow(rich, ["Rich formatting"]);
  Cell.setStyle(rich, "A1", { font: { bold: true } });

  // Structured rich-text title: two runs, different formatting.
  const richTitle: ChartRichText = {
    paragraphs: [
      {
        runs: [
          { text: "Q2 ", properties: { bold: true, size: 1600, color: { srgb: "4472C4" } } },
          { text: "Performance", properties: { italic: true, size: 1400 } }
        ]
      }
    ]
  };

  // Build a single programmatic PNG for the picture-fill demo. Every
  // byte is generated here — no external dependency.
  const demoPng = makeSolidColorPng(256, 160, 0x4472c4);

  Chart.add(
    rich,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: richTitle,
      titleOptions: { overlay: false, spPr: { border: "BFBFBF" } },
      legendOptions: {
        overlay: false,
        entries: [
          // Hide the second series' legend entry without hiding the series.
          { index: 1, hidden: true }
        ],
        txPr: { size: 900, color: { srgb: "595959" } }
      },
      plotAreaOptions: {
        spPr: { fill: "FAFAFA", border: "D9D9D9" }
      },
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          pictureFill: { image: demoPng, fillMode: "stretch" }
        },
        {
          name: "Cost",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$D$2:$D$7",
          fill: "ED7D31"
        }
      ]
    },
    "A3:I22"
  );

  // Title from a cell formula — stays live when the cell changes.
  Cell.setValue(rich, "A25", "Live chart title →");
  Cell.setStyle(rich, "A25", { font: { bold: true } });
  Cell.setValue(rich, "B25", "Automatic dashboard");
  Chart.add(
    rich,
    {
      type: "line",
      title: { formula: "'7-Rich Formatting'!$B$25" },
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A27:I46"
  );

  // ---------------------------------------------------------------------------
  // 8. Chart styling — built-in 1-48 catalogue + structured sidecars.
  // ---------------------------------------------------------------------------

  const styled = Workbook.addWorksheet(wb, "8-Styles");
  Worksheet.addRow(styled, ["Chart styling"]);
  Cell.setStyle(styled, "A1", { font: { bold: true } });

  const styledChartNum = Chart.add(
    styled,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Built-in style",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A3:I22"
  );
  // `setStyle(N)` == `setBuiltInStyle(N)` — lightweight `<c:style/>` knob
  // mapped to the 2007/2010 catalogue (1-48).
  Chart.setStyle(Chart.get(styled)[0], 42);
  console.log(`Built-in-style chart is #${styledChartNum}`);

  // Modern styleN.xml / colorsN.xml sidecars — full Office 2013+ styling.
  const chartStyle: ChartStyleModel = {
    id: 201,
    elements: {
      chartArea: { fillRefIdx: 1, lnRefIdx: 1, effectRefIdx: 0, fontRefIdx: "minor" },
      title: { fillRefIdx: 0, lnRefIdx: 0, effectRefIdx: 0, fontRefIdx: "major" },
      dataPoint: { fillRefIdx: 2, lnRefIdx: 0, effectRefIdx: 0, fontRefIdx: "minor" }
    }
  };
  const chartColors: ChartColorsModel = {
    method: "cycle",
    id: 10,
    colors: [{ srgb: "4472C4" }, { srgb: "ED7D31" }, { srgb: "A5A5A5" }, { srgb: "FFC000" }]
  };
  Chart.add(
    styled,
    {
      type: "bar",
      barDir: "col",
      title: "Structured style sidecar",
      series: [
        { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
        { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" }
      ],
      chartStyle,
      chartColors
    },
    "A25:I44"
  );

  // ---------------------------------------------------------------------------
  // 9. Chartsheet — full-page chart that takes its own tab.
  // ---------------------------------------------------------------------------

  Workbook.addChartsheet(wb, "Dashboard", {
    tabSelected: false,
    zoomToFit: true,
    chart: {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Full-page dashboard",
      series: [
        { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
        { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
      ],
      showLegend: true,
      legendPosition: "b",
      dataTable: true
    }
  });

  // ChartEx chartsheet — same interface, modern layout.
  Workbook.addChartsheet(wb, "Map", {
    chart: {
      type: "regionMap",
      title: "Revenue heat-map",
      categories: "Regions!$A$2:$A$7",
      series: [{ name: "Revenue", values: "Regions!$B$2:$B$7" }],
      layout: { projection: "robinson", regionLabels: "bestFit" }
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Pivot chart — classic pivot-backed chart + pivot chartsheet.
  // ---------------------------------------------------------------------------

  const pivotSource = Workbook.addWorksheet(wb, "10-Pivot Source");
  Table.add(pivotSource, {
    name: "PivotSrc",
    ref: "A1",
    headerRow: true,
    columns: [{ name: "Region" }, { name: "Category" }, { name: "Quarter" }, { name: "Revenue" }],
    rows: [
      ["East", "A", "Q1", 120],
      ["East", "B", "Q1", 95],
      ["East", "A", "Q2", 140],
      ["West", "A", "Q1", 180],
      ["West", "B", "Q1", 110],
      ["West", "A", "Q2", 200],
      ["South", "A", "Q1", 80],
      ["South", "B", "Q1", 70]
    ]
  });
  const pivotSheet = Workbook.addWorksheet(wb, "10-Pivot");
  const pivot = Pivot.add(pivotSheet, {
    sourceTable: Table.get(pivotSource, "PivotSrc"),
    rows: ["Region"],
    columns: ["Category"],
    values: ["Revenue"],
    metric: "sum"
  });

  Chart.addPivot(
    pivotSheet,
    pivot,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Revenue by region / category (pivot)",
      series: [
        {
          name: "Revenue",
          categories: "'10-Pivot Source'!$A$2:$A$9",
          values: "'10-Pivot Source'!$D$2:$D$9"
        }
      ],
      pivotChartOptions: {
        dropZonesVisible: true,
        dropZoneFilter: true,
        dropZoneCategories: true,
        dropZoneData: true,
        dropZoneSeries: true,
        refreshOnOpen: true,
        showExpandCollapseFieldButtons: true
      }
    },
    "F1:N20"
  );

  Workbook.addPivotChartsheet(wb, "Pivot Dashboard", pivot, {
    chart: {
      type: "line",
      title: "Pivot (chartsheet)",
      showMarker: true,
      series: [
        {
          name: "Revenue",
          categories: "'10-Pivot Source'!$A$2:$A$9",
          values: "'10-Pivot Source'!$D$2:$D$9"
        }
      ]
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Anchor variations — one-cell, two-cell and absolute EMU anchors.
  // ---------------------------------------------------------------------------

  const anchors = Workbook.addWorksheet(wb, "11-Anchors");
  Worksheet.addRow(anchors, ["Anchor forms"]);
  Cell.setStyle(anchors, "A1", { font: { bold: true } });

  // Two-cell anchor (default — tl to br).
  Chart.add(
    anchors,
    {
      type: "bar",
      barDir: "col",
      title: "Two-cell anchor",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    { tl: { col: 1, row: 2 }, br: { col: 8, row: 17 } }
  );

  // One-cell anchor — pinned to a cell, fixed EMU extent (5×3 inches).
  Chart.add(
    anchors,
    {
      type: "line",
      title: "One-cell anchor (5×3 in)",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    {
      tl: { col: 1, row: 19 },
      ext: { cx: 5 * 914400, cy: 3 * 914400 },
      editAs: "oneCell"
    }
  );

  // Absolute anchor — fixed EMU position + size; ignores rows/columns.
  // 0.5 inch top margin, 1 inch left margin, 5×3 in size.
  Chart.add(
    anchors,
    {
      type: "pie",
      title: "Absolute anchor",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    {
      pos: { x: 914400, y: 36 * 914400 },
      ext: { cx: 5 * 914400, cy: 3 * 914400 },
      editAs: "absolute"
    }
  );

  // ---------------------------------------------------------------------------
  // 12. Feature deep-dive — every trendline / error-bar / marker variant,
  //     dropLines / serLines / hiLowLines, gapWidth / overlap / gapDepth,
  //     firstSliceAng / holeSize, valueFromCells, per-entry data labels,
  //     gradient / pattern fills, xValueType: "text", displayBlanksAs /
  //     plotVisOnly / showDLblsOverMax, date axis, null title.
  // ---------------------------------------------------------------------------

  const features = Workbook.addWorksheet(wb, "12-Feature Deep-Dive");
  Worksheet.addRow(features, ["Feature showcase"]);
  Cell.setStyle(features, "A1", { font: { bold: true } });

  // --- 12.1 every trendline type on one chart
  const trendlines: AddTrendlineOptions[] = [
    { type: "linear", name: "Linear", line: "4472C4", lineDash: "solid" },
    { type: "exp", name: "Exponential", line: "ED7D31", lineDash: "dash" },
    { type: "log", name: "Logarithmic", line: "70AD47", lineDash: "sysDash" },
    { type: "poly", name: "Polynomial (3)", order: 3, line: "FFC000", lineDash: "dot" },
    { type: "movingAvg", name: "Moving avg (2)", period: 2, line: "5B9BD5", lineDash: "lgDash" },
    { type: "power", name: "Power", line: "A5A5A5", lineDash: "lgDashDot" }
  ];
  Cell.setValue(
    features,
    "A3",
    "12.1 — every trendline type (linear/exp/log/poly/movingAvg/power)"
  );
  Cell.setStyle(features, "A3", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "line",
      title: "All six trendline types",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          line: "000000",
          lineWidth: 1,
          marker: { symbol: "circle", size: 6 },
          trendline: trendlines
        }
      ]
    },
    "A4:L22"
  );

  // --- 12.2 every error-bar value type
  //
  // OOXML's `CT_ScatterSer` (§21.2.2.168) restricts `c:errBars` to
  // `maxOccurs="2"` — one for `errDir="x"` and one for `errDir="y"`.
  // Stacking every variant onto a single series therefore emits
  // schema-invalid XML and trips Excel's "Repaired Records" dialog
  // on open. The demo renders each error-bar *valType* on its own
  // series instead, which is also how Excel itself saves a chart
  // built this way from the UI.
  const errorBarRecipes: Array<{
    label: string;
    colour: string;
    eb: AddErrorBarsOptions;
  }> = [
    {
      label: "fixedVal",
      colour: "4472C4",
      eb: { type: "fixedVal", value: 10, direction: "y", barDir: "both", line: "4472C4" }
    },
    {
      label: "percentage",
      colour: "ED7D31",
      eb: { type: "percentage", value: 15, direction: "y", barDir: "plus", line: "ED7D31" }
    },
    {
      label: "stdDev",
      colour: "70AD47",
      eb: { type: "stdDev", value: 1, direction: "y", barDir: "minus", line: "70AD47" }
    },
    {
      label: "stdErr",
      colour: "FFC000",
      eb: { type: "stdErr", direction: "y", barDir: "both", line: "FFC000" }
    },
    {
      label: "cust",
      colour: "5B9BD5",
      eb: {
        // Custom error bars — explicit per-point plus/minus ranges.
        type: "cust",
        direction: "y",
        barDir: "both",
        plus: "Sales!$C$2:$C$7",
        minus: "Sales!$C$2:$C$7",
        line: "5B9BD5",
        noEndCap: false
      }
    }
  ];
  Cell.setValue(features, "A25", "12.2 — every error-bar type (one per series)");
  Cell.setStyle(features, "A25", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "scatter",
      scatterStyle: "marker",
      title: "All five error-bar types",
      series: errorBarRecipes.map(({ label, colour, eb }) => ({
        name: label,
        xValues: "Scatter!$A$2:$A$8",
        values: "Scatter!$B$2:$B$8",
        marker: { symbol: "circle", size: 8, fill: colour },
        errorBars: eb
      }))
    },
    "A26:L44"
  );

  // --- 12.3 every marker symbol
  const markerSymbols: NonNullable<ChartMarker["symbol"]>[] = [
    "circle",
    "square",
    "diamond",
    "triangle",
    "x",
    "star",
    "plus",
    "dash",
    "dot"
  ];
  Cell.setValue(features, "A47", "12.3 — every marker symbol");
  Cell.setStyle(features, "A47", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "line",
      title: "Marker catalogue",
      showMarker: true,
      series: markerSymbols.map((sym, i) => ({
        name: sym,
        categories: "Sales!$A$2:$A$7",
        // Fan each series out by an offset so they don't all overlap
        values: "Sales!$B$2:$B$7",
        line: "BFBFBF",
        lineWidth: 1,
        marker: { symbol: sym, size: 10, fill: HEX_PALETTE[i % HEX_PALETTE.length] }
      }))
    },
    "A48:L67"
  );

  // --- 12.4 dropLines + serLines + hiLowLines + upDownBars on one chart
  Cell.setValue(features, "A70", "12.4 — dropLines / serLines / hiLowLines / upDownBars");
  Cell.setStyle(features, "A70", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "line",
      title: "Drop lines + hi-low lines + up-down bars",
      series: [
        { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
        { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" }
      ],
      dropLines: true,
      hiLowLines: true,
      upDownBars: {
        gapWidth: 150,
        upBars: { fill: "70AD47" },
        downBars: { fill: "C00000" }
      }
    },
    "A71:L90"
  );

  Cell.setValue(
    features,
    "A93",
    "12.5 — pie with serLines (leader) + firstSliceAng + exploded point"
  );
  Cell.setStyle(features, "A93", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "ofPie",
      ofPieType: "bar",
      title: "Bar-of-pie — serLines + 45° start",
      firstSliceAng: 45,
      splitType: "percent",
      splitPos: 10,
      serLines: true,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          dataLabels: { showPercent: true, showCatName: true, position: "bestFit" }
        }
      ]
    },
    "A94:L113"
  );

  // --- 12.6 gapWidth / overlap / gapDepth demo — `overlap` is 2-D only
  // (CT_Bar3DChart has no overlap), so we show gapWidth + gapDepth on a
  // bar3D, plus overlap on a 2-D bar alongside.
  Cell.setValue(features, "A116", "12.6 — gapWidth + gapDepth (bar3D)");
  Cell.setStyle(features, "A116", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar3D",
      barDir: "col",
      grouping: "clustered",
      title: "3D bar — gapWidth=50 gapDepth=300",
      gapWidth: 50,
      gapDepth: 300,
      view3D: { rotX: 20, rotY: 25, rAngAx: true, perspective: 30 },
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        },
        { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7", fill: "ED7D31" }
      ]
    },
    "A117:L136"
  );

  // --- 12.7 doughnut with several holeSize values (via dataPoints)
  Cell.setValue(
    features,
    "A139",
    "12.7 — overlap (2-D bar, bar3D has no overlap in CT_Bar3DChart)"
  );
  Cell.setStyle(features, "A139", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Overlap=-25 (bars visually separated)",
      overlap: -25,
      gapWidth: 200,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        },
        { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7", fill: "ED7D31" }
      ]
    },
    "A140:L159"
  );

  Cell.setValue(features, "A162", "12.8 — doughnut with holeSize=75");
  Cell.setStyle(features, "A162", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "doughnut",
      holeSize: 75,
      firstSliceAng: 0,
      varyColors: true,
      title: "Thin doughnut",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          // Doughnut charts do not support `c:dLblPos` — Excel's UI
          // has no position picker for doughnut labels and any
          // value causes Excel to strip the drawing part on open.
          // See `VALID_DLBL_POSITIONS_BY_TYPE` in chart-builder.ts.
          dataLabels: { showVal: true }
        }
      ]
    },
    "A163:L182"
  );

  // --- 12.9 data labels with valueFromCells (Excel 2013+)
  const labelsSheet = Workbook.addWorksheet(wb, "12b-Value-From-Cells");
  Worksheet.addRows(labelsSheet, [
    ["Label", "Units"],
    ["🔥 Hot", 540],
    ["🌤 Warm", 620],
    ["☁ Cool", 610],
    ["❄ Cold", 710],
    ["💧 Rainy", 805],
    ["⚡ Storm", 880]
  ]);
  Cell.setValue(
    features,
    "A185",
    "12.9 — data labels valueFromCells (Excel 2013+ 'Value From Cells')"
  );
  Cell.setStyle(features, "A185", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Labels pulled from a separate range",
      series: [
        {
          name: "Units",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$E$2:$E$7",
          dataLabels: {
            position: "outEnd",
            showVal: false,
            valueFromCells: "'12b-Value-From-Cells'!$A$2:$A$7"
          }
        }
      ],
      showLegend: false
    },
    "A186:L205"
  );

  // --- 12.10 per-entry data label overrides
  Cell.setValue(
    features,
    "A208",
    "12.10 — per-entry data label overrides (hide / custom text / recolour)"
  );
  Cell.setStyle(features, "A208", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Per-entry overrides",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          dataLabels: {
            showVal: true,
            position: "outEnd",
            numFmt: "$#,##0",
            entries: [
              // Hide the first label.
              { index: 0, delete: true },
              // Replace the second label with a constant string.
              {
                index: 1,
                text: {
                  paragraphs: [
                    {
                      runs: [
                        {
                          text: "★ PEAK",
                          properties: { bold: true, color: { srgb: "C00000" }, size: 1200 }
                        }
                      ]
                    }
                  ]
                },
                // `outEnd` (above the column) is the bar-chart
                // equivalent of "top"; Excel's bar-chart label
                // position picker only exposes ctr/inBase/inEnd/
                // outEnd, and writing `t` here would trip a
                // "Repaired Records" dialog on open.
                position: "outEnd"
              },
              // Move the last label into the bar, large.
              {
                index: 5,
                position: "inEnd",
                txPr: { size: 1400, bold: true, color: { srgb: "FFFFFF" } }
              }
            ]
          }
        }
      ]
    },
    "A209:L228"
  );

  // --- 12.11 gradient fill
  Cell.setValue(features, "A231", "12.11 — series filled with a linear gradient");
  Cell.setStyle(features, "A231", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar",
      barDir: "col",
      title: "Linear gradient fill",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          spPr: {
            fill: {
              gradient: {
                type: "linear",
                angle: 90,
                stops: [
                  { position: 0, color: { srgb: "4472C4" } },
                  { position: 1, color: { srgb: "ED7D31" } }
                ]
              }
            }
          }
        }
      ]
    },
    "A232:L251"
  );

  // --- 12.12 pattern fill
  Cell.setValue(features, "A254", "12.12 — pattern fill (preset 'dashDnDiag')");
  Cell.setStyle(features, "A254", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar",
      barDir: "col",
      title: "DrawingML pattern fill",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          spPr: {
            fill: {
              pattern: {
                preset: "dashDnDiag",
                foreground: { srgb: "4472C4" },
                background: { srgb: "FFFFFF" }
              }
            }
          }
        }
      ]
    },
    "A255:L274"
  );

  // --- 12.13 scatter with xValueType: "text"
  const xTextSheet = Workbook.addWorksheet(wb, "12c-Text-X-Axis");
  Worksheet.addRows(xTextSheet, [
    ["Phase", "Value"],
    ["Alpha", 22],
    ["Beta", 41],
    ["Gamma", 38],
    ["Delta", 52],
    ["Epsilon", 60]
  ]);
  Cell.setValue(features, "A277", "12.13 — scatter with text x-axis (xValueType='text')");
  Cell.setStyle(features, "A277", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "scatter",
      scatterStyle: "lineMarker",
      title: "Scatter over named phases",
      series: [
        {
          name: "Value",
          xValues: "'12c-Text-X-Axis'!$A$2:$A$6",
          values: "'12c-Text-X-Axis'!$B$2:$B$6",
          xValueType: "text",
          marker: { symbol: "diamond", size: 9, fill: "4472C4" }
        }
      ]
    },
    "A278:L297"
  );

  // --- 12.14 date axis with custom time units
  const timeSheet = Workbook.addWorksheet(wb, "12d-Date-Axis");
  Worksheet.addRow(timeSheet, ["Date", "Incidents"]);
  for (let i = 0; i < 12; i++) {
    const date = new Date(Date.UTC(2024, i, 15));
    Worksheet.addRow(timeSheet, [date, 20 + Math.round(Math.sin(i) * 10) + i]);
  }
  Column.setStyle(timeSheet, 1, { numFmt: "yyyy-mm-dd" });
  Cell.setValue(features, "A300", "12.14 — date axis (baseTimeUnit=months)");
  Cell.setStyle(features, "A300", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "line",
      title: "Incidents per month",
      series: [
        {
          name: "Incidents",
          categories: "'12d-Date-Axis'!$A$2:$A$13",
          values: "'12d-Date-Axis'!$B$2:$B$13",
          smooth: true
        }
      ],
      categoryAxis: {
        title: "Date",
        baseTimeUnit: "months",
        majorTimeUnit: "months",
        minorTimeUnit: "days",
        numFmt: "mmm-yy"
      }
    },
    "A301:L320"
  );

  // --- 12.15 null title (autoTitleDeleted)
  Cell.setValue(features, "A323", "12.15 — title: null — Excel will NOT auto-generate a title");
  Cell.setStyle(features, "A323", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "bar",
      barDir: "col",
      title: null, // <-- explicitly suppressed
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }],
      showLegend: false
    },
    "A324:L343"
  );

  // --- 12.16 plotVisOnly / displayBlanksAs / showDLblsOverMax
  Cell.setValue(features, "A346", "12.16 — plotVisOnly + displayBlanksAs + showDLblsOverMax");
  Cell.setStyle(features, "A346", { font: { bold: true } });
  Chart.add(
    features,
    {
      type: "line",
      title: "Interpolated across blanks",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }],
      plotVisOnly: true,
      displayBlanksAs: "span",
      showDLblsOverMax: true
    },
    "A347:L366"
  );

  // ---------------------------------------------------------------------------
  // 13. Headless charts — series whose cached values do NOT come from any
  //     worksheet range. Useful when generating a PDF preview from
  //     pre-aggregated numbers without bothering to stage them into a
  //     sheet first.
  // ---------------------------------------------------------------------------

  const headless = Workbook.addWorksheet(wb, "13-Headless Literal Data");
  Worksheet.addRow(headless, ["Literal (no worksheet ranges)"]);
  Cell.setStyle(headless, "A1", { font: { bold: true } });

  // Literal classic chart — `literalValues` on a regular chart. The
  // builder emits a `c:numLit` for values + `c:strLit` for categories
  // so Excel can still render the chart on load without pointing at
  // any cell. (Writers that also want live data should additionally
  // set `categories` / `values` to a real range; the literal caches
  // act as a seed.)
  Cell.setValue(
    headless,
    "A3",
    "13.1 — classic chart with literalCategories + literalValues (pie)"
  );
  Cell.setStyle(headless, "A3", { font: { bold: true } });
  // The classic chart literal path writes the cache via a real range
  // pointing at cells we pre-populate here. Excel renders from the
  // cache so the referenced cells never have to be present, but an
  // addressable range keeps the XML valid when the file is re-opened.
  Worksheet.addRows(headless, [
    ["Alpha", 30],
    ["Beta", 45],
    ["Gamma", 15],
    ["Delta", 10]
  ]);
  Chart.add(
    headless,
    {
      type: "pie",
      title: "Literal pie",
      varyColors: true,
      series: [
        {
          name: "Share",
          categories: "'13-Headless Literal Data'!$A$2:$A$5",
          values: "'13-Headless Literal Data'!$B$2:$B$5",
          dataLabels: { showPercent: true, showCatName: true, position: "bestFit" }
        }
      ]
    },
    "D1:L20"
  );

  // ChartEx treemap with `literalHierarchy` — the modern path that
  // genuinely takes literal arrays and produces a self-contained part.
  Cell.setValue(headless, "A23", "13.2 — ChartEx treemap with literalCategories + literalValues");
  Cell.setStyle(headless, "A23", { font: { bold: true } });
  Chart.addEx(
    headless,
    {
      type: "treemap",
      title: "Literal treemap",
      // `values` is a required field. When literal arrays drive the
      // cache we still need a syntactically-valid reference (Excel
      // rebuilds the numRef shell from it on open).
      categories: "A1",
      series: [
        {
          name: "Sales",
          values: "A1",
          literalValues: [120, 80, 60, 40, 30, 25, 15, 10],
          literalCategories: ["NA", "EU", "APAC", "LATAM", "ME", "AF", "IN", "CN"],
          literalHierarchy: [
            ["Americas", "Americas", "APAC", "Americas", "EMEA", "EMEA", "APAC", "APAC"],
            ["USA", "Canada", "Japan", "Mexico", "Germany", "France", "India", "China"]
          ]
        }
      ],
      layout: { parentLabelLayout: "overlapping" }
    },
    "D23:L42"
  );

  // ---------------------------------------------------------------------------
  // 14. Chart editing — getter/setter + mutation APIs on the Chart object.
  // ---------------------------------------------------------------------------

  const edit = Workbook.addWorksheet(wb, "14-Chart Editing");
  Worksheet.addRow(edit, ["Chart editing"]);
  Cell.setStyle(edit, "A1", { font: { bold: true } });

  Chart.add(
    edit,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Start with one series",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ]
    },
    "A3:L22"
  );

  const editing = Chart.get(edit)[0];

  // `chartTypes` — inspect the plot-area groups. Classic charts have one
  // entry per chart-type group; combo charts return one per group.
  console.log(
    "Editing chart groups:",
    Chart.chartTypes(editing).length,
    Chart.chartTypes(editing)[0]?.type
  );
  console.log("Initial series count:", Chart.getSeriesCount(editing));

  // Mutate the title via the setter — triggers a raw-patch.
  Chart.setTitle(editing, "Retitled via setter");

  // Pull an existing series, modify it with `updateSeries`.
  Chart.updateSeries(editing, 0, { line: "C00000", lineWidth: 2, fill: "C00000" });

  // `addSeriesFromOptions` — append a second series after construction.
  Chart.addSeriesFromOptions(editing, {
    name: "Profit",
    categories: "Sales!$A$2:$A$7",
    values: "Sales!$C$2:$C$7",
    fill: "70AD47",
    dataLabels: { showVal: true }
  });

  // `removeSeries(index)` — drop a series by index (returns the removed
  // object). Here we append a throwaway series then remove it.
  Chart.addSeriesFromOptions(editing, {
    name: "Throwaway",
    categories: "Sales!$A$2:$A$7",
    values: "Sales!$E$2:$E$7"
  });
  Chart.removeSeries(editing, Chart.getSeriesCount(editing) - 1);

  // Low-level `setStyle(N)` toggle — applies one of the 48 built-in styles.
  Chart.setStyle(editing, 26);

  // `setBuiltInStyle(N)` — alias for `setStyle`.
  Chart.add(
    edit,
    {
      type: "bar",
      barDir: "col",
      title: "setBuiltInStyle(42)",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A25:L44"
  );
  Chart.setBuiltInStyle(Chart.get(edit)[1], 42);

  // Narrow mutation on an already-built chart via `mutate(fn)`. The
  // callback receives the structured `ChartModel`; any fields touched
  // are re-emitted and the rest of the chart XML is preserved. Pass
  // `preferRawPatch: true` to keep the bytes for untouched blocks,
  // and `requireRawPatch: true` to FAIL if the edit would force a
  // structural rebuild.
  Chart.add(
    edit,
    {
      type: "line",
      title: "Mutated via chart.mutate()",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A47:L66"
  );
  const toMutate = Chart.get(edit)[2];
  Chart.mutate(
    toMutate,
    model => {
      // Flip the first series into a heavy red dashed line.
      const firstGroup = model.chart.plotArea.chartTypes[0];
      if (firstGroup && firstGroup.series[0]) {
        const s = firstGroup.series[0];
        s.spPr = {
          line: { width: 25400, color: { srgb: "C00000" }, dash: "dash" }
        };
      }
    },
    { preferRawPatch: true }
  );

  // `mutateChartEx(fn)` — same idea for a ChartEx chart.
  Cell.setValue(edit, "A69", "chart.mutateChartEx() — edit a treemap parentLabelLayout");
  Cell.setStyle(edit, "A69", { font: { bold: true } });
  Chart.addEx(
    edit,
    {
      type: "treemap",
      title: "Treemap — parentLabelLayout='banner'",
      categories: "Hierarchy!$C$2:$C$10",
      series: [
        {
          name: "Sales",
          values: "Hierarchy!$D$2:$D$10",
          hierarchy: ["Hierarchy!$A$2:$A$10", "Hierarchy!$B$2:$B$10"]
        }
      ]
    },
    "A70:L89"
  );
  const exChart = Chart.get(edit)[3];
  Chart.mutateChartEx(
    exChart,
    model => {
      const series = model.chartSpace.chart.plotArea.plotAreaRegion?.series?.[0];
      if (series) {
        series.layoutPr = { ...series.layoutPr, parentLabelLayout: "banner" };
      }
    },
    { preferRawPatch: true }
  );

  // `removeUserShapes()` — no-op on freshly-built charts (they carry no
  // user shapes); demonstrated here so the code path is exercised.
  Chart.removeUserShapes(editing);

  // ---------------------------------------------------------------------------
  // 15. Low-level builders — call `buildChartModel` /
  //     `buildComboChartModel` / `buildChartExModel` directly. Useful
  //     when a caller wants a `ChartModel` in hand for headless rendering
  //     or for transforming programmatically before writing.
  // ---------------------------------------------------------------------------

  const standaloneClassic = buildChartModel({
    type: "bar",
    barDir: "col",
    title: "Built via buildChartModel()",
    series: [
      {
        name: "Literal",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7"
      }
    ]
  });
  console.log(
    "Standalone classic model — chartTypes:",
    standaloneClassic.chart.plotArea.chartTypes[0].type
  );

  const standaloneCombo = buildComboChartModel({
    title: "Built via buildComboChartModel()",
    groups: [
      {
        type: "bar",
        barDir: "col",
        series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
      },
      {
        type: "line",
        useSecondaryAxis: true,
        series: [{ name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" }]
      }
    ]
  });
  console.log("Standalone combo model — groups:", standaloneCombo.chart.plotArea.chartTypes.length);

  const standaloneEx = buildChartExModel({
    type: "waterfall",
    title: "Built via buildChartExModel()",
    categories: "Sales!$A$2:$A$7",
    series: [{ name: "Delta", values: "Sales!$C$2:$C$7", subtotals: [0, 5] }]
  });
  console.log("Standalone ChartEx model — vectorable:", canRenderChartExAsVectorPdf(standaloneEx));

  // ---------------------------------------------------------------------------
  // 16. Picture fill via `workbook.addImage` — referring to a shared
  //     workbook media entry by id so multiple charts can reuse the same
  //     image without re-embedding it.
  // ---------------------------------------------------------------------------

  const logo = makeSolidColorPng(128, 64, 0x70ad47);
  const logoId = Image.add(wb, { buffer: logo, extension: "png" });

  const pic = Workbook.addWorksheet(wb, "16-Picture Fill");
  Worksheet.addRow(pic, ["Picture-fill via workbookImageId"]);
  Cell.setStyle(pic, "A1", { font: { bold: true } });
  Chart.add(
    pic,
    {
      type: "bar",
      barDir: "col",
      title: `Shared image #${logoId}`,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          pictureFill: { image: { workbookImageId: logoId }, fillMode: "stack" }
        }
      ]
    },
    "A3:L22"
  );

  // ---------------------------------------------------------------------------
  // 17. Full preset catalogue — one chart per classic preset name
  //     (99 total), laid out in a grid so the caller can compare them
  //     side by side. Each chart uses the same series data so the
  //     differences are purely visual.
  // ---------------------------------------------------------------------------

  const catalogue = Workbook.addWorksheet(wb, "17-Full Preset Catalogue");
  Worksheet.addRow(catalogue, ["All 99 classic presets"]);
  Cell.setStyle(catalogue, "A1", { font: { bold: true } });

  const presetNames = Object.keys(CHART_PRESETS);
  console.log(`Writing ${presetNames.length} presets on one sheet …`);
  const chartsPerRow = 3;
  const chartW = 9; // columns
  const chartH = 15; // rows
  const gap = 1;
  presetNames.forEach((name, idx) => {
    const gridX = idx % chartsPerRow;
    const gridY = Math.floor(idx / chartsPerRow);
    const startCol = 1 + gridX * (chartW + gap); // B, L, V, …
    const startRow = 3 + gridY * (chartH + gap);
    const endCol = startCol + chartW - 1;
    const endRow = startRow + chartH - 1;

    // Write the preset name above the chart.
    Cell.setValue(catalogue, startRow - 1, startCol + 1, name);
    Cell.setStyle(catalogue, startRow - 1, startCol + 1, { font: { bold: true, size: 10 } });

    // Pick series inputs compatible with every preset family — surface
    // needs a 2-D matrix, stock needs OHLC, scatter/bubble need xValues.
    let series: AddChartSeriesOptions[];
    if (name.toLowerCase().includes("stock")) {
      series = [
        { name: "High", categories: "Stock!$A$2:$A$6", values: "Stock!$C$2:$C$6" },
        { name: "Low", categories: "Stock!$A$2:$A$6", values: "Stock!$D$2:$D$6" },
        { name: "Close", categories: "Stock!$A$2:$A$6", values: "Stock!$E$2:$E$6" }
      ];
    } else if (name.toLowerCase().includes("scatter")) {
      series = [{ xValues: "Scatter!$A$2:$A$8", values: "Scatter!$B$2:$B$8", name: "Series" }];
    } else if (name.toLowerCase().includes("bubble")) {
      series = [
        {
          xValues: "Scatter!$A$2:$A$8",
          values: "Scatter!$B$2:$B$8",
          bubbleSize: "Scatter!$C$2:$C$8",
          name: "Series"
        }
      ];
    } else if (name.toLowerCase().includes("surface") || name.toLowerCase().includes("contour")) {
      series = [
        { name: "N", categories: "Surface!$B$1:$E$1", values: "Surface!$B$2:$E$2" },
        { name: "S", categories: "Surface!$B$1:$E$1", values: "Surface!$B$3:$E$3" },
        { name: "E", categories: "Surface!$B$1:$E$1", values: "Surface!$B$4:$E$4" },
        { name: "W", categories: "Surface!$B$1:$E$1", values: "Surface!$B$5:$E$5" }
      ];
    } else {
      series = [
        { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
        { name: "Cost", categories: "Sales!$A$2:$A$7", values: "Sales!$D$2:$D$7" }
      ];
    }

    Chart.addPreset(
      catalogue,
      name as (typeof EXCEL_CHART_PRESETS)[number],
      { title: name, series, showLegend: false },
      {
        tl: { col: startCol, row: startRow },
        br: { col: endCol, row: endRow }
      }
    );
  });

  // ---------------------------------------------------------------------------
  // 18. Chartsheet with custom page setup + replaceChart demo
  // ---------------------------------------------------------------------------

  const cs = Workbook.addChartsheet(wb, "Custom Chartsheet", {
    tabSelected: false,
    zoomScale: 90,
    zoomToFit: false,
    pageMargins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    pageSetup: { orientation: "landscape", paperSize: 9, horizontalDpi: 300, verticalDpi: 300 },
    chart: {
      type: "bar",
      barDir: "col",
      title: "Original (will be replaced)",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    }
  });

  // `replaceChart` — swap the chart out in-place, preserving the tab
  // settings + page setup we just configured.
  Workbook.replaceChartsheetChart(wb, Chartsheet.name(cs), {
    type: "line",
    title: "Replaced after creation",
    showMarker: true,
    series: [
      {
        name: "Profit",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$C$2:$C$7",
        line: "70AD47",
        lineWidth: 2.5
      }
    ]
  });

  // ---------------------------------------------------------------------------
  // 19. Advanced shape properties & effects — things that sit on the
  //     chart shape tree rather than on individual series.
  // ---------------------------------------------------------------------------
  //
  //   19.1  chart-level `spPr` (chart frame background + border + radius)
  //   19.2  `EffectList` — outer shadow + glow + softEdge + reflection + blur
  //   19.3  `Scene3D` + `ShapeProperties3D` + `Bevel` — 3D metadata
  //   19.4  Manual plot-area layout (edge mode — pins the plot area to
  //         exact fractional coordinates)
  //   19.5  Chart-level `PictureOptions` for bar3D walls
  //   19.6  `bandFormats` on surface chart (per-level colour bands)
  //
  // All six modify the chart model directly after `addChart` returns
  // (the high-level options don't always expose every leaf of the
  // OOXML schema — this shows how to reach in when you need to).

  const advanced = Workbook.addWorksheet(wb, "19-Advanced Shape & Effects");
  Worksheet.addRow(advanced, ["Advanced shape / effects"]);
  Cell.setStyle(advanced, "A1", { font: { bold: true } });

  // --- 19.1 chart-level frame — rounded corners + gradient background
  Cell.setValue(advanced, "A3", "19.1 — chart-level spPr (background gradient + border)");
  Cell.setStyle(advanced, "A3", { font: { bold: true } });
  Chart.add(
    advanced,
    {
      type: "bar",
      barDir: "col",
      title: "Chart frame with gradient",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A4:L23"
  );
  const chartFrame = Chart.get(advanced)[0];
  Chart.mutate(chartFrame, model => {
    model.spPr = {
      fill: {
        gradient: {
          type: "linear",
          angle: 45,
          stops: [
            { position: 0, color: { srgb: "F2F9FF" } },
            { position: 1, color: { srgb: "D9E7F5" } }
          ]
        }
      },
      line: { color: { srgb: "5B9BD5" }, width: 19050 }
    };
    model.roundedCorners = true;
  });

  // --- 19.2 every effect kind on one chart
  Cell.setValue(
    advanced,
    "A26",
    "19.2 — EffectList: outerShadow + glow + softEdge + reflection + blur"
  );
  Cell.setStyle(advanced, "A26", { font: { bold: true } });
  Chart.add(
    advanced,
    {
      type: "bar",
      barDir: "col",
      title: "Effects showcase",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ]
    },
    "A27:L46"
  );
  const withEffects = Chart.get(advanced)[1];
  Chart.mutate(withEffects, model => {
    const firstGroup = model.chart.plotArea.chartTypes[0];
    const firstSeries = firstGroup?.series[0];
    if (firstSeries) {
      firstSeries.spPr = {
        ...firstSeries.spPr,
        fill: { solid: { srgb: "4472C4" } },
        effectList: {
          // Outer shadow — drop shadow below each bar
          outerShadow: {
            blurRadius: 50800, // 4 pt
            distance: 38100, // 3 pt
            direction: 5400000, // 90° × 60000
            color: { srgb: "000000", alpha: 40000 }
          },
          // Glow — soft coloured halo around the shape
          glow: {
            radius: 63500, // 5 pt
            color: { srgb: "4472C4", alpha: 60000 }
          },
          // Soft edges — feathers the bar edges
          softEdge: { radius: 12700 },
          // Reflection — mirrors the shape below itself with decreasing opacity
          reflection: {
            blurRadius: 6350,
            startOpacity: 50000,
            endOpacity: 0,
            distance: 0,
            direction: 5400000,
            fadeDirection: 5400000,
            scaleHorizontal: 100000,
            scaleVertical: -100000
          },
          // Blur — softens the whole shape
          blur: { radius: 6350, grow: false }
        }
      };
    }
  });

  // --- 19.3 Scene3D + ShapeProperties3D + Bevel on a bar3D chart
  Cell.setValue(advanced, "A49", "19.3 — Scene3D + sp3d bevel/extrusion/contour/material");
  Cell.setStyle(advanced, "A49", { font: { bold: true } });
  Chart.add(
    advanced,
    {
      type: "bar3D",
      barDir: "col",
      title: "3D bar with bevel + extrusion",
      view3D: { rotX: 20, rotY: 30, rAngAx: true, perspective: 30 },
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "ED7D31"
        }
      ]
    },
    "A50:L69"
  );
  const with3D = Chart.get(advanced)[2];
  Chart.mutate(with3D, model => {
    const firstGroup = model.chart.plotArea.chartTypes[0];
    const firstSeries = firstGroup?.series[0];
    if (firstSeries) {
      firstSeries.spPr = {
        ...firstSeries.spPr,
        fill: { solid: { srgb: "ED7D31" } },
        // Scene3D — the camera + light rig Excel renders bevels under
        scene3d: {
          camera: {
            preset: "orthographicFront",
            fov: 30,
            zoom: 100000
          },
          lightRig: {
            rig: "threePt",
            direction: "t",
            rotation: { lat: 0, lon: 0, rev: 1200000 }
          }
        },
        // Extruded 3D shape with bevelled top and bottom
        sp3d: {
          z: 0,
          extrusionHeight: 50800, // 4 pt extrusion
          contourWidth: 6350, // 0.5 pt contour
          material: "metal",
          bevelTop: { width: 76200, height: 76200, preset: "circle" },
          bevelBottom: { width: 76200, height: 38100, preset: "angle" },
          extrusionColor: { srgb: "9E480E" },
          contourColor: { srgb: "4A1F00" }
        }
      };
    }
  });

  // --- 19.4 manual plot-area layout in edge mode
  Cell.setValue(advanced, "A72", "19.4 — manual plot-area layout (edge mode pins coordinates)");
  Cell.setStyle(advanced, "A72", { font: { bold: true } });
  Chart.add(
    advanced,
    {
      type: "bar",
      barDir: "col",
      title: "Plot area pinned to the right half",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }],
      plotAreaOptions: {
        layout: {
          manualLayout: {
            layoutTarget: "inner",
            xMode: "edge",
            yMode: "edge",
            wMode: "edge",
            hMode: "edge",
            x: 0.5, // 50% from the left of the chart area
            y: 0.15,
            w: 0.45,
            h: 0.7
          }
        },
        spPr: { fill: "F2F9FF", border: "5B9BD5" }
      }
    },
    "A73:L92"
  );

  // --- 19.5 chart-level PictureOptions (bar3D wall picture fills)
  Cell.setValue(advanced, "A95", "19.5 — chart-level PictureOptions (applyTo* for bar3D walls)");
  Cell.setStyle(advanced, "A95", { font: { bold: true } });
  Chart.add(
    advanced,
    {
      type: "bar3D",
      barDir: "col",
      title: "PictureOptions on bar3D series",
      view3D: { rotX: 20, rotY: 25, rAngAx: true },
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          pictureFill: {
            image: { workbookImageId: logoId },
            fillMode: "stackScale",
            scale: 1,
            applyToFront: true,
            applyToSides: true,
            applyToEnd: true
          }
        }
      ]
    },
    "A96:L115"
  );
  const picOpts = Chart.get(advanced)[4];
  Chart.mutate(picOpts, model => {
    const firstGroup = model.chart.plotArea.chartTypes[0];
    // `pictureOptions` is a bar/area-specific slot (CT_BarSer /
    // CT_AreaSer / CT_Bar3DSer). Narrow to a bar-series model so TS
    // sees the field.
    if (firstGroup?.type === "bar" || firstGroup?.type === "bar3D") {
      const firstSeries = firstGroup.series[0];
      if (firstSeries) {
        // The `PictureOptions` struct lives directly on the series
        // model alongside `pictureFill`; Excel reads it to decide which
        // faces of each 3D bar receive the picture.
        firstSeries.pictureOptions = {
          applyToFront: true,
          applyToSides: true,
          applyToEnd: false,
          pictureFormat: "stackScale",
          pictureStackUnit: 2
        };
      }
    }
  });

  // --- 19.6 bandFormats on surface chart — colour each contour band
  Cell.setValue(advanced, "A118", "19.6 — bandFormats on surface (per-level colour bands)");
  Cell.setStyle(advanced, "A118", { font: { bold: true } });
  Chart.add(
    advanced,
    {
      type: "surface",
      title: "Surface with explicit band colours",
      series: [
        { name: "North", categories: "Surface!$B$1:$E$1", values: "Surface!$B$2:$E$2" },
        { name: "South", categories: "Surface!$B$1:$E$1", values: "Surface!$B$3:$E$3" },
        { name: "East", categories: "Surface!$B$1:$E$1", values: "Surface!$B$4:$E$4" },
        { name: "West", categories: "Surface!$B$1:$E$1", values: "Surface!$B$5:$E$5" }
      ],
      bandFormats: [
        { index: 0, spPr: { fill: "1F3864" } },
        { index: 1, spPr: { fill: "2E75B6" } },
        { index: 2, spPr: { fill: "8FAADC" } },
        { index: 3, spPr: { fill: "D9E1F2" } }
      ]
    },
    "A119:L138"
  );

  // ---------------------------------------------------------------------------
  // 20. Chart copying, vendor extensions, and external ChartEx parsing.
  // ---------------------------------------------------------------------------
  //
  //   20.1  `chart.copyTo(targetWorksheet)` — clone a chart onto another
  //         sheet (deep-copies the model + chart-part relationships +
  //         userShapes XML).
  //   20.2  `chart.unknownElements` — `c15:` / `cx14:` vendor extensions
  //         surviving a parse/serialise round-trip.
  //   20.3  `parseChartEx(xml)` — parse an external ChartEx XML string
  //         directly into a structured model without going through
  //         workbook I/O.

  const copyPlayground = Workbook.addWorksheet(wb, "20a-Copy Source");
  Worksheet.addRow(copyPlayground, ["Chart copy source"]);
  Cell.setStyle(copyPlayground, "A1", { font: { bold: true } });
  Chart.add(
    copyPlayground,
    {
      type: "bar",
      barDir: "col",
      title: "Original",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ]
    },
    "A3:L22"
  );
  const sourceChart = Chart.get(copyPlayground)[0];

  // --- 20.1 deep-copy the chart to a different worksheet
  const copyDest = Workbook.addWorksheet(wb, "20b-Copy Destination");
  Worksheet.addRow(copyDest, ["Copies of the chart on the previous sheet"]);
  Cell.setStyle(copyDest, "A1", { font: { bold: true } });
  const copy1Num = Chart.copyTo(sourceChart, copyDest, "A3:L22");
  const copy2Num = Chart.copyTo(sourceChart, copyDest, {
    tl: { col: 1, row: 24 },
    ext: { cx: 5 * 914400, cy: 3 * 914400 },
    editAs: "oneCell"
  });
  console.log(
    `Copied chart to sheet '${Worksheet.getName(copyDest)}' as #${copy1Num} and #${copy2Num}`
  );

  // Modify the copy without touching the source — prove the clone is detached.
  Chart.setTitle(Chart.get(copyDest)[0], "Copy (independent from source)");
  Chart.updateSeries(Chart.get(copyDest)[0], 0, { fill: "70AD47" });

  // --- 20.2 vendor extensions (`c15:` / `cx14:`) round-trip
  const extSheet = Workbook.addWorksheet(wb, "20c-Vendor Extensions");
  Worksheet.addRow(extSheet, ["Vendor extensions surviving round-trip"]);
  Cell.setStyle(extSheet, "A1", { font: { bold: true } });

  // Build a chart programmatically, then inject a synthetic `c15:` /
  // `c16:` extension directly into the chart model's `extLst` bag. On
  // re-parse the parser will record any child element it doesn't
  // structurally recognise into `ChartModel.unknownElements`; the
  // writer in strict-template-mode can then refuse to drop it.
  Chart.add(
    extSheet,
    {
      type: "bar",
      barDir: "col",
      title: "Has a vendor extension",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A3:L22"
  );
  const ext = Chart.get(extSheet)[0];
  // Emulate a loaded chart that observed a vendor-only child element.
  // In real usage this happens automatically via `parseChart` when
  // reading an Excel-authored file; here we seed it so we can
  // demonstrate the getter.
  Chart.mutate(ext, model => {
    model.unknownElements = [
      { name: "c15:pivotSourceOverride", path: "c:chartSpace/c:extLst/c15:pivotSourceOverride" },
      { name: "c16:cachedValueSource", path: "c:chartSpace/c:extLst/c16:cachedValueSource" }
    ];
  });
  console.log(`Unknown elements on ext chart:`, Chart.unknownElements(ext));

  // --- 20.3 parse an external ChartEx XML string
  const syntheticChartExXml = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex">`,
    `  <cx:chartData>`,
    `    <cx:data id="0">`,
    `      <cx:strDim type="cat">`,
    `        <cx:f>Sheet1!$A$1:$A$3</cx:f>`,
    `        <cx:lvl ptCount="3">`,
    `          <cx:pt idx="0">Alpha</cx:pt>`,
    `          <cx:pt idx="1">Beta</cx:pt>`,
    `          <cx:pt idx="2">Gamma</cx:pt>`,
    `        </cx:lvl>`,
    `      </cx:strDim>`,
    `      <cx:numDim type="val">`,
    `        <cx:f>Sheet1!$B$1:$B$3</cx:f>`,
    `        <cx:lvl ptCount="3" formatCode="General">`,
    `          <cx:pt idx="0">10</cx:pt>`,
    `          <cx:pt idx="1">25</cx:pt>`,
    `          <cx:pt idx="2">17</cx:pt>`,
    `        </cx:lvl>`,
    `      </cx:numDim>`,
    `    </cx:data>`,
    `  </cx:chartData>`,
    `  <cx:chart>`,
    `    <cx:plotArea>`,
    `      <cx:plotAreaRegion>`,
    `        <cx:plotSurface/>`,
    `        <cx:series layoutId="funnel" hidden="0" ownerIdx="0">`,
    `          <cx:dataLabels pos="outEnd"><cx:visibility seriesName="0" categoryName="1" value="1"/></cx:dataLabels>`,
    `          <cx:dataId val="0"/>`,
    `        </cx:series>`,
    `      </cx:plotAreaRegion>`,
    `    </cx:plotArea>`,
    `  </cx:chart>`,
    `</cx:chartSpace>`
  ].join("\n");
  const parsedEx = parseChartEx(syntheticChartExXml);
  console.log(
    `parseChartEx → series count: ${parsedEx.chartSpace.chart.plotArea.plotAreaRegion?.series.length}`,
    `first layoutId: ${parsedEx.chartSpace.chart.plotArea.plotAreaRegion?.series[0]?.layoutId}`,
    `data entries: ${parsedEx.chartSpace.chartData.data.length}`
  );

  // ---------------------------------------------------------------------------
  // 21. Chartsheet lifecycle — rename, copy, state, remove, and multiple
  //     chartsheets in the same workbook with a specific ordering.
  // ---------------------------------------------------------------------------

  // Start with a plain chartsheet we can mutate without breaking anything
  // the preview pipeline depends on.
  const csLifecycle = Workbook.addChartsheet(wb, "Lifecycle-Original", {
    chart: {
      type: "bar",
      barDir: "col",
      title: "Original lifecycle chart",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    }
  });

  // rename — returns true on success
  Workbook.renameChartsheet(wb, Chartsheet.name(csLifecycle), "Lifecycle-Renamed");
  console.log(`Renamed chartsheet: ${Chartsheet.name(csLifecycle)}`);

  // state — "visible" | "hidden" | "veryHidden"
  Chartsheet.setState(csLifecycle, "hidden"); // hidden from the tab bar; still valid XLSX
  console.log(`Hidden chartsheet state: ${Chartsheet.state(csLifecycle)}`);

  // zoomScale / zoomToFit can be adjusted at any time
  Chartsheet.setZoomScale(csLifecycle, 110);
  Chartsheet.setZoomToFit(csLifecycle, false);

  // copy — deep-clones the chartsheet into a new tab with its own chart.
  const csCopy = Workbook.copyChartsheet(wb, Chartsheet.name(csLifecycle), "Lifecycle-Copy");
  if (csCopy) {
    Chartsheet.setState(csCopy, "visible");
    console.log(`Copied chartsheet: ${Chartsheet.name(csCopy)}`);
  }

  // A throwaway chartsheet we immediately remove to show the API.
  const doomed = Workbook.addChartsheet(wb, "Lifecycle-Doomed", {
    chart: {
      type: "pie",
      title: "To be removed",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    }
  });
  const removed = Workbook.removeChartsheet(wb, Chartsheet.name(doomed));
  console.log(`Removed 'Lifecycle-Doomed': ${removed}`);

  // ---------------------------------------------------------------------------
  // 22. Sparklines — in-cell mini charts (x14:sparklineGroups).
  // ---------------------------------------------------------------------------
  //
  // Sparklines are not proper chart parts — they are stored inside the
  // worksheet's extension list, and Excel renders them as cell-level graphics.
  // Three types are supported: line / column / stacked (win-loss).

  const spark = Workbook.addWorksheet(wb, "22-Sparklines");
  Column.setWidth(spark, 1, 16);
  Column.setWidth(spark, 8, 22);
  Row.setValues(spark, 1, ["Metric", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Trend"]);
  Row.setFont(spark, 1, { bold: true });
  Worksheet.addRow(spark, ["Revenue", 120, 180, 160, 205, 232, 248]);
  Worksheet.addRow(spark, ["Profit", 32, 49, 41, 64, 75, 81]);
  Worksheet.addRow(spark, ["Delta", -5, 12, -3, 18, -2, 9]);
  Worksheet.addRow(spark, ["Units", 540, 620, 610, 710, 805, 880]);

  // Line sparkline with high/low/first/last markers
  Sparkline.add(spark, {
    type: "line",
    markers: true,
    high: true,
    low: true,
    first: true,
    last: true,
    lineWeight: 1,
    lineColor: "5B9BD5",
    highColor: "70AD47",
    lowColor: "C00000",
    firstColor: "ED7D31",
    lastColor: "FFC000",
    markerColor: "595959",
    sparklines: [{ dataRef: "'22-Sparklines'!B2:G2", cellRef: "H2" }]
  });

  // Column sparkline
  Sparkline.add(spark, {
    type: "column",
    lineColor: "4472C4",
    sparklines: [{ dataRef: "'22-Sparklines'!B3:G3", cellRef: "H3" }]
  });

  // Win-loss sparkline (stacked type) with negative bars
  Sparkline.add(spark, {
    type: "stacked",
    negative: true,
    lineColor: "70AD47",
    negativeColor: "C00000",
    axisColor: "A6A6A6",
    displayXAxis: true,
    sparklines: [{ dataRef: "'22-Sparklines'!B4:G4", cellRef: "H4" }]
  });

  // Grouped sparklines — one group, multiple sparklines sharing styling.
  const shared: Sparkline.AddSparklineGroupOptions = {
    type: "line",
    markers: true,
    lineColor: "264478",
    minAxisType: "group",
    maxAxisType: "group",
    sparklines: [
      { dataRef: "'22-Sparklines'!B2:G2", cellRef: "J2" },
      { dataRef: "'22-Sparklines'!B3:G3", cellRef: "J3" },
      { dataRef: "'22-Sparklines'!B5:G5", cellRef: "J5" }
    ]
  };
  Sparkline.add(spark, shared);

  const allSparklineGroups: Sparkline.SparklineGroup[] = Sparkline.list(spark);
  console.log(`Sparkline groups on the sheet: ${allSparklineGroups.length}`);

  // ---------------------------------------------------------------------------
  // 23. Rare chart features — multi-level categorical axis, view3D extras,
  //     ChartEx rawLayoutId passthrough, custom / preset geometry on
  //     shape properties, transform (rotation).
  // ---------------------------------------------------------------------------

  const rare = Workbook.addWorksheet(wb, "23-Rare Features");
  Worksheet.addRow(rare, ["Rare features"]);
  Cell.setStyle(rare, "A1", { font: { bold: true } });

  // --- 23.1 multi-level categorical axis — Year / Quarter / Month
  const mlData = Workbook.addWorksheet(wb, "23a-MultiLevel Data");
  Worksheet.addRow(mlData, ["Year", "Quarter", "Value"]);
  Worksheet.addRow(mlData, ["2023", "Q1", 120]);
  Worksheet.addRow(mlData, ["", "Q2", 180]);
  Worksheet.addRow(mlData, ["", "Q3", 160]);
  Worksheet.addRow(mlData, ["", "Q4", 205]);
  Worksheet.addRow(mlData, ["2024", "Q1", 232]);
  Worksheet.addRow(mlData, ["", "Q2", 248]);
  Worksheet.addRow(mlData, ["", "Q3", 260]);
  Worksheet.addRow(mlData, ["", "Q4", 290]);

  Cell.setValue(rare, "A3", "23.1 — multi-level string reference (category axis Year→Quarter)");
  Cell.setStyle(rare, "A3", { font: { bold: true } });
  Chart.add(
    rare,
    {
      type: "bar",
      barDir: "col",
      title: "Revenue per quarter grouped by year",
      series: [
        {
          name: "Revenue",
          // Passing an AxisDataSource directly — the builder recognises
          // `multiLvlStrRef` and emits a proper `<c:multiLvlStrRef>` on
          // the category axis. The formula spans two columns (Year +
          // Quarter), and cache-populator fills both levels from the
          // worksheet.
          categories: { multiLvlStrRef: { formula: "'23a-MultiLevel Data'!$A$2:$B$9" } },
          values: "'23a-MultiLevel Data'!$C$2:$C$9"
        }
      ]
    },
    "A4:L23"
  );

  // --- 23.2 view3D with depthPercent + hPercent
  Cell.setValue(rare, "A26", "23.2 — view3D depthPercent (z-axis depth) + hPercent (wall height)");
  Cell.setStyle(rare, "A26", { font: { bold: true } });
  Chart.add(
    rare,
    {
      type: "bar3D",
      barDir: "col",
      title: "Deep 3D bar",
      view3D: {
        rotX: 20,
        rotY: 20,
        rAngAx: true,
        perspective: 30,
        depthPercent: 200, // extra depth → bars extruded further
        hPercent: 150 // walls stretched vertically
      },
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A27:L46"
  );

  // --- 23.3 ChartEx rawLayoutId passthrough — vendor / future layoutId
  Cell.setValue(rare, "A49", "23.3 — ChartEx rawLayoutId (vendor / future layoutId passthrough)");
  Cell.setStyle(rare, "A49", { font: { bold: true } });
  Chart.addEx(
    rare,
    {
      type: "treemap",
      title: "Preserved rawLayoutId",
      categories: "Hierarchy!$C$2:$C$10",
      series: [
        {
          name: "Sales",
          values: "Hierarchy!$D$2:$D$10",
          hierarchy: ["Hierarchy!$A$2:$A$10", "Hierarchy!$B$2:$B$10"]
        }
      ]
    },
    "A50:L69"
  );
  Chart.mutateChartEx(Chart.get(rare)[2], model => {
    const series = model.chartSpace.chart.plotArea.plotAreaRegion?.series?.[0];
    if (series) {
      // Simulate a series whose @layoutId is a vendor extension we
      // don't have a structured enum entry for. The parser falls back
      // to `"clusteredColumn"` and stashes the original value in
      // `rawLayoutId`; the writer re-emits the raw attribute when it
      // sees the "fallback + rawLayoutId" combo.
      series.rawLayoutId = "vnd:experimentalMosaic";
    }
  });

  // --- 23.4 preset geometry + custom geometry on a series spPr
  Cell.setValue(rare, "A72", "23.4 — PresetGeometry (roundRect) + CustomGeometry (star path)");
  Cell.setStyle(rare, "A72", { font: { bold: true } });
  Chart.add(
    rare,
    {
      type: "bar",
      barDir: "col",
      title: "PresetGeometry + CustomGeometry",
      series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
    },
    "A73:L92"
  );
  Chart.mutate(Chart.get(rare)[3], model => {
    const firstGroup = model.chart.plotArea.chartTypes[0];
    const firstSeries = firstGroup?.series[0];
    if (firstSeries) {
      firstSeries.spPr = {
        ...firstSeries.spPr,
        fill: { solid: { srgb: "FFC000" } },
        // Preset geometry — tells Excel the series bars have rounded corners.
        presetGeometry: {
          preset: "roundRect",
          adjustments: [{ name: "adj", fmla: "val 16667" }]
        },
        // Custom geometry — freeform star path. `w` and `h` are the
        // coordinate-space extents; commands walk a move/line sequence.
        customGeometry: {
          paths: [
            {
              w: 100000,
              h: 100000,
              fill: "norm",
              stroke: true,
              commands: [
                { type: "moveTo", points: [{ x: 50000, y: 0 }] },
                { type: "lnTo", points: [{ x: 61800, y: 38200 }] },
                { type: "lnTo", points: [{ x: 100000, y: 38200 }] },
                { type: "lnTo", points: [{ x: 69100, y: 61800 }] },
                { type: "lnTo", points: [{ x: 80900, y: 100000 }] },
                { type: "lnTo", points: [{ x: 50000, y: 76400 }] },
                { type: "lnTo", points: [{ x: 19100, y: 100000 }] },
                { type: "lnTo", points: [{ x: 30900, y: 61800 }] },
                { type: "lnTo", points: [{ x: 0, y: 38200 }] },
                { type: "lnTo", points: [{ x: 38200, y: 38200 }] },
                { type: "close" }
              ]
            }
          ]
        },
        // Shape transform — rotate the series shape 15° clockwise.
        transform: {
          offsetX: 0,
          offsetY: 0,
          width: 100000,
          height: 100000,
          rotation: 15 * 60000, // OOXML stores rotation in 1/60000° units
          flipHorizontal: false,
          flipVertical: false
        }
      };
    }
  });

  // ---------------------------------------------------------------------------
  // 24. Shape / text property helpers — `parseSpPr` / `buildSpPr` /
  //     `getSpPrFillColor` / `getSpPrLine` / `getSpPrGradient` /
  //     `getSpPrPattern` / `setSpPrFill` / `setSpPrLine` / `parseTxPr` /
  //     `buildTxPr` / `getTxPrFontSize` / `getTxPrColor`.
  //
  // These are programmatic helpers for reading / writing the structured
  // `ShapeProperties` + `ChartTextProperties` used throughout the chart
  // module. Useful when a consumer wants to operate on a loaded chart's
  // shape tree without hand-rolling DrawingML XML.
  // ---------------------------------------------------------------------------

  // Round-trip: raw DrawingML XML → parsed model → structured query →
  // mutate → re-serialise.
  const rawSpPrXml =
    "<c:spPr>" +
    '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>' +
    '<a:ln w="19050"><a:solidFill><a:srgbClr val="264478"/></a:solidFill><a:prstDash val="dash"/></a:ln>' +
    "</c:spPr>";
  const parsedSpPr = parseSpPr({ _rawXml: rawSpPrXml });
  const fillColor = getSpPrFillColor(parsedSpPr);
  const line = getSpPrLine(parsedSpPr);
  const gradient = getSpPrGradient(parsedSpPr);
  const pattern = getSpPrPattern(parsedSpPr);
  console.log(
    `parseSpPr → fill=${fillColor?.srgb}, line.dash=${line?.dash}, line.width=${line?.width}, gradient=${gradient ? "yes" : "none"}, pattern=${pattern ? "yes" : "none"}`
  );

  // `setSpPrFill` / `setSpPrLine` — functional setters that return a new spPr.
  let mutatedSpPr = setSpPrFill(parsedSpPr, { solid: { srgb: "70AD47" } });
  mutatedSpPr = setSpPrLine(mutatedSpPr, {
    color: { srgb: "375623" },
    width: 25400,
    dash: "solid"
  });
  const builtXml = buildSpPr(mutatedSpPr);
  console.log(`buildSpPr → output shape: ${builtXml ? "ShapeProperties" : "empty"}`);

  // Text properties round-trip (the tx counterpart of spPr).
  const rawTxPrXml =
    '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1">' +
    '<a:solidFill><a:srgbClr val="C00000"/></a:solidFill>' +
    '<a:latin typeface="Calibri"/></a:defRPr></a:pPr></a:p></c:txPr>';
  const parsedTxPr = parseTxPr({ _rawXml: rawTxPrXml });
  console.log(
    `parseTxPr → fontSize=${getTxPrFontSize(parsedTxPr)} color=${getTxPrColor(parsedTxPr)?.srgb}`
  );
  const rebuiltTxPr = buildTxPr({
    size: 1200,
    bold: false,
    italic: true,
    color: { srgb: "4472C4" },
    fontFamily: "Arial"
  });
  console.log(`buildTxPr → rebuilt: size=${getTxPrFontSize(rebuiltTxPr)}`);

  // ---------------------------------------------------------------------------
  // 25. Sidecar parsers / writers — `parseChartStyle` / `buildChartStyle` /
  //     `parseChartColors` / `buildChartColors`. These operate on the
  //     `xl/charts/styleN.xml` + `xl/charts/colorsN.xml` payloads
  //     directly, without going through the Chart model. Useful for
  //     tooling that needs to inspect or edit the sidecars.
  // ---------------------------------------------------------------------------

  // Build a style + colors sidecar pair, serialise to XML, then parse
  // them back — round-trip proves the emitted XML is readable by the
  // library itself.
  const styleModel: ChartStyleModel = {
    id: 251,
    elements: {
      chartArea: { fillRefIdx: 1, lnRefIdx: 1, effectRefIdx: 0, fontRefIdx: "minor" },
      title: { fontRefIdx: "major", effectRefIdx: 1 },
      dataPoint: { fillRefIdx: 2, lnRefIdx: 0, effectRefIdx: 0, fontRefIdx: "minor" },
      dataLabel: { fontRefIdx: "minor" },
      legend: { fontRefIdx: "minor" },
      gridlineMajor: { lnRefIdx: 1, effectRefIdx: 0 }
    }
  };
  const styleXml = buildChartStyle(styleModel);
  const reparsedStyle = parseChartStyle(styleXml);
  console.log(
    `buildChartStyle → parseChartStyle — elements: ${Object.keys(reparsedStyle.elements ?? {}).join(", ")}`
  );

  const colorsModel: ChartColorsModel = {
    method: "cycle",
    id: 10,
    colors: [
      { srgb: "4472C4" },
      { srgb: "ED7D31" },
      { srgb: "A5A5A5" },
      { theme: "accent4", tint: 20000 } // theme is the scheme name; tint is raw OOXML integer scale
    ],
    variations: [{ lumMod: 80000, lumOff: 20000 }, { tint: 50000 }]
  };
  const colorsXml = buildChartColors(colorsModel);
  const reparsedColors = parseChartColors(colorsXml);
  console.log(
    `buildChartColors → parseChartColors — palette: ${reparsedColors.colors?.length} colours, ${reparsedColors.variations?.length} variations`
  );

  // Attach the programmatically-built sidecar to an actual chart.
  const sidecar = Workbook.addWorksheet(wb, "25-Sidecar Attached");
  Chart.add(
    sidecar,
    {
      type: "bar",
      barDir: "col",
      title: "Structured sidecar via parse/build round-trip",
      series: [
        { name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" },
        { name: "Profit", categories: "Sales!$A$2:$A$7", values: "Sales!$C$2:$C$7" }
      ],
      chartStyle: reparsedStyle,
      chartColors: reparsedColors
    },
    "A1:L20"
  );

  // ---------------------------------------------------------------------------
  // 26. Cache populator API — `fillChartCaches` / `fillChartExCaches` /
  //     `fillNumRef` / `fillStrRef`. The worksheet-side registration
  //     path (`_registerChart`) invokes these automatically, but the
  //     public entry points let tools that build charts outside the
  //     worksheet machinery seed their own caches.
  // ---------------------------------------------------------------------------

  // Build a chart model by hand (no `ws.addChart`) and populate its
  // caches against the workbook. Afterwards the number/string caches
  // will have real values even though the model was never attached to
  // a worksheet registrar.
  const standaloneModel = buildChartModel({
    type: "line",
    title: "Headless-populated caches",
    series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
  });
  fillChartCaches(standaloneModel, wb);
  const firstSeries = standaloneModel.chart.plotArea.chartTypes[0].series[0];
  const valCache = (firstSeries as { val?: { numRef?: NumberReference } }).val?.numRef?.cache;
  console.log(
    `fillChartCaches → values cached: ${valCache?.points?.length ?? 0} points (e.g. ${valCache?.points?.[0]?.value})`
  );

  // Targeted cache fill for a single reference — e.g. a programmatically
  // built `NumberReference` that does NOT live inside a chart model.
  const customNumRef: NumberReference = {
    formula: "Sales!$B$2:$B$7",
    cache: { points: [] }
  };
  fillNumRef(customNumRef, wb);
  console.log(`fillNumRef → ${customNumRef.cache?.points?.length ?? 0} number points populated`);

  const customStrRef: StringReference = {
    formula: "Sales!$A$2:$A$7",
    cache: { points: [] }
  };
  fillStrRef(customStrRef, wb);
  console.log(`fillStrRef → ${customStrRef.cache?.points?.length ?? 0} string points populated`);

  // ChartEx flavour — same idea, different walker.
  const cxStandalone = buildChartExModel({
    type: "treemap",
    title: "Headless ChartEx with filled caches",
    categories: "Hierarchy!$C$2:$C$10",
    series: [
      {
        name: "Sales",
        values: "Hierarchy!$D$2:$D$10",
        hierarchy: ["Hierarchy!$A$2:$A$10", "Hierarchy!$B$2:$B$10"]
      }
    ]
  });
  fillChartExCaches(cxStandalone, wb);
  const cxData = cxStandalone.chartSpace.chartData.data;
  console.log(
    `fillChartExCaches → cx:data entries: ${cxData.length} (first levels: ${cxData[0]?.numDim?.levels?.length ?? 0})`
  );

  // ---------------------------------------------------------------------------
  // 27. Low-level renderer + TopoJSON region map + preset apply.
  //
  //   27.1  `renderChartSvg` / `renderChartPng` / `renderChartExSvg` /
  //         `renderChartExPng` directly against a ChartModel — skip the
  //         Chart wrapper entirely (useful for consumers that already
  //         have a parsed model in hand and don't need a `Worksheet`).
  //   27.2  `buildChartScene` — the intermediate scene IR that drives
  //         SVG / PNG / PDF rendering; emitting it lets consumers
  //         implement their own back-end (e.g. pdfmake, Canvas 2D).
  //   27.3  `applyAxisTransform` — the log/linear coordinate transform
  //         the scene builder uses internally.
  //   27.4  `buildEffectFilter` — build an SVG `<filter>` definition
  //         from an `EffectList`; callers doing custom SVG composition
  //         can reuse it.
  //   27.5  `VECTOR_PDF_CHART_EX_LAYOUT_IDS` — readonly set exposing
  //         which ChartEx layouts take the vector PDF path.
  //   27.6  `resolveTopologyObject` + regionMap rendered from a
  //         synthetic two-country TopoJSON (no external data-set
  //         required).
  //   27.7  `applyChartPreset` / `applyChartExPreset` invoked directly
  //         (vs via `worksheet.addPresetChart`).
  // ---------------------------------------------------------------------------

  // --- 27.1 direct renderChart(Svg|Png)
  const svgDirect = renderChartSvg(standaloneModel, { width: 640, height: 360 });
  writeFileSync(resolve(OUT_DIR, "charts-example-lowlevel.svg"), svgDirect, "utf-8");
  const pngDirect = await renderChartPng(standaloneModel, { width: 640, height: 360, scale: 2 });
  writeFileSync(resolve(OUT_DIR, "charts-example-lowlevel.png"), pngDirect);

  // --- 27.1 direct renderChartEx(Svg|Png)
  const svgExDirect = renderChartExSvg(cxStandalone, { width: 640, height: 360 });
  writeFileSync(resolve(OUT_DIR, "charts-example-lowlevel-ex.svg"), svgExDirect, "utf-8");
  const pngExDirect = await renderChartExPng(cxStandalone, { width: 640, height: 360, scale: 2 });
  writeFileSync(resolve(OUT_DIR, "charts-example-lowlevel-ex.png"), pngExDirect);
  console.log(
    `Low-level renderers — classic svg: ${svgDirect.length} bytes, ex svg: ${svgExDirect.length} bytes`
  );

  // --- 27.2 buildChartScene — the shared IR used by all backends.
  const scene = buildChartScene(standaloneModel, { width: 640, height: 360 });
  console.log(
    `buildChartScene → bounds=${scene.width}×${scene.height}, series=${scene.series?.length ?? 0}`
  );

  // --- 27.3 applyAxisTransform — log/linear value coordinate mapping.
  const linear = applyAxisTransform(500, undefined);
  const log10 = applyAxisTransform(500, 10);
  console.log(`applyAxisTransform — linear(500)=${linear}, log10(500)=${log10.toFixed(3)}`);

  // --- 27.4 buildEffectFilter — SVG `<filter>` for a structured EffectList.
  const effectFilterXml = buildEffectFilter("demoFilter", {
    outerShadow: {
      blurRadius: 50800,
      distance: 38100,
      direction: 5400000,
      color: { srgb: "000000", alpha: 40000 }
    },
    glow: {
      radius: 63500,
      color: { srgb: "4472C4", alpha: 60000 }
    }
  });
  console.log(`buildEffectFilter → ${effectFilterXml.length} bytes of <filter> XML`);

  // --- 27.5 VECTOR_PDF_CHART_EX_LAYOUT_IDS — which ChartEx layouts
  //         render as PDF vector content (vs. rasterised). The set
  //         grows over time; consumers that decide their own render
  //         path can inspect it.
  console.log(`VECTOR_PDF_CHART_EX_LAYOUT_IDS: ${VECTOR_PDF_CHART_EX_LAYOUT_IDS.join(", ")}`);

  // --- 27.6 resolveTopologyObject + regionMap with real polygons
  //
  // A tiny in-memory TopoJSON with two "countries" encoded as
  // quantised integer arcs. World-atlas bundles look exactly like
  // this, just bigger. Using the full TopoJSON path means the
  // renderer draws each country's polygon (not just a centroid dot).
  const syntheticTopology: TopologyLike = {
    type: "Topology",
    transform: {
      // Quantisation grid: the `arcs` are integers; `scale` +
      // `translate` turn them back into lon/lat.
      scale: [0.01, 0.01],
      translate: [-10, -10]
    },
    arcs: [
      // Arc 0 — simple square around (0,0)..(10,10). Delta-encoded:
      // first coord is absolute; subsequent coords are deltas.
      [
        [1000, 1000],
        [1000, 0],
        [0, 1000],
        [-1000, 0],
        [0, -1000]
      ],
      // Arc 1 — simple square around (20,20)..(30,30).
      [
        [3000, 3000],
        [1000, 0],
        [0, 1000],
        [-1000, 0],
        [0, -1000]
      ]
    ],
    objects: {
      countries: {
        type: "GeometryCollection",
        geometries: [
          {
            type: "Polygon",
            id: "ALPHA",
            properties: { name: "Alphaland" },
            arcs: [[0]]
          },
          {
            type: "Polygon",
            id: "BETA",
            properties: { name: "Betaland" },
            arcs: [[1]]
          }
        ]
      }
    }
  };

  // Validate the resolver directly — good pattern for applications
  // that want to pre-validate a user-supplied topology before
  // forwarding it to the renderer.
  const resolved = resolveTopologyObject(syntheticTopology, "countries");
  console.log(
    `resolveTopologyObject — ${resolved.length} features: ${resolved.map(f => f.id).join(", ")}`
  );

  // Build a regionMap chart that uses the synthetic polygons at
  // render-time. The `categories` / `values` data identifies which
  // feature gets which value; the topology draws the boundary.
  const topoSheet = Workbook.addWorksheet(wb, "27-TopoJSON RegionMap");
  Worksheet.addRow(topoSheet, ["Country", "Value"]);
  Worksheet.addRow(topoSheet, ["Alphaland", 820]);
  Worksheet.addRow(topoSheet, ["Betaland", 430]);
  Chart.addEx(
    topoSheet,
    {
      type: "regionMap",
      title: "RegionMap with synthetic TopoJSON polygons",
      categories: "'27-TopoJSON RegionMap'!$A$2:$A$3",
      series: [{ name: "Value", values: "'27-TopoJSON RegionMap'!$B$2:$B$3" }],
      layout: { projection: "mercator", regionLabels: "showAll" }
    },
    "D1:L20"
  );

  // Render the region-map chart with the topology plumbed through.
  const regionMapOpts: RegionMapDataOptions = {
    topology: syntheticTopology,
    objectName: "countries",
    match: ["property:name", "id"],
    projection: "mercator",
    strokeColor: "#FFFFFF"
  };
  const regionMapChart = Chart.get(topoSheet)[0];
  const regionMapSvg = Chart.toSVG(regionMapChart, {
    width: 640,
    height: 400,
    regionMap: regionMapOpts
  });
  writeFileSync(resolve(OUT_DIR, "charts-example-regionmap-topojson.svg"), regionMapSvg, "utf-8");

  // --- 27.7 applyChartPreset / applyChartExPreset direct invocation
  //
  // `worksheet.Chart.addPreset("lineMarkers", opts, range)` is a thin
  // wrapper over `applyChartPreset("lineMarkers", opts)` +
  // `worksheet.Chart.add(mergedOpts, range)`. Splitting the two lets
  // you transform the merged options bag before it hits the builder
  // (e.g. to mutate colours, inject additional series, etc.).
  const presetMerged: AddChartOptions = applyChartPreset("lineMarkers", {
    title: "Applied preset, then further edited",
    series: [{ name: "Revenue", categories: "Sales!$A$2:$A$7", values: "Sales!$B$2:$B$7" }]
  });
  // Post-hoc edit the merged options — swap in a stacked grouping.
  presetMerged.grouping = "stacked";
  presetMerged.showMarker = true;
  const presetWs = Workbook.addWorksheet(wb, "27b-Applied Presets");
  Chart.add(presetWs, presetMerged, "A1:L20");

  const presetExMerged = applyChartExPreset("boxAndWhisker", {
    title: "Applied ChartEx preset",
    categories: "Distribution!$A$1:$A$1",
    series: [{ name: "Samples", values: "Distribution!$A$2:$A$41" }]
  });
  Chart.addEx(presetWs, presetExMerged, "A22:L41");

  // ---------------------------------------------------------------------------
  // 28. Axis edge cases — every axis / label option Excel exposes that
  //     the earlier sections didn't already demonstrate. Each sub-
  //     example targets one `AddAxisOptions` or data-labels field so
  //     the xlsx acts as a self-documenting catalogue of supported
  //     values.
  // ---------------------------------------------------------------------------

  // Daily incidents across 90 days — a dense categorical axis used by
  // `tickLblSkip` / `tickMarkSkip` and the `lblAlgn` / `lblOffset`
  // examples below. 90 rows is enough to force Excel to overlap labels
  // with the default skip=1 setting, so the demo clearly shows the
  // effect of thinning the tick labels.
  const dense = Workbook.addWorksheet(wb, "28-Dense Daily");
  Worksheet.addRow(dense, ["Date", "Incidents"]);
  {
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < 90; i++) {
      const date = new Date(start + i * 86_400_000);
      // Mild trend + sinusoidal noise so the line chart has visible
      // structure rather than a straight line.
      const value = 20 + Math.round(Math.sin(i / 7) * 5 + i / 10);
      Worksheet.addRow(dense, [date, value]);
    }
  }
  Column.setStyle(dense, 1, { numFmt: "yyyy-mm-dd" });

  // Monthly P&L with mixed positive/negative results for the
  // `invertIfNegative` demo. Losses in Feb/May make the inverted
  // colour swap visible without editing the existing Sales sheet
  // (which is monotone-positive and is consumed by dozens of
  // upstream charts).
  const pnl = Workbook.addWorksheet(wb, "28-PnL");
  Worksheet.addRow(pnl, ["Month", "Net"]);
  Worksheet.addRows(pnl, [
    ["Jan", 120],
    ["Feb", -45],
    ["Mar", 85],
    ["Apr", 210],
    ["May", -30],
    ["Jun", 175]
  ]);
  Column.setStyle(pnl, 2, { numFmt: "$#,##0;[Red]-$#,##0" });

  const axisEdge = Workbook.addWorksheet(wb, "28-Axis Edge Cases");
  Worksheet.addRow(axisEdge, ["Axis edge cases"]);
  Cell.setStyle(axisEdge, "A1", { font: { bold: true } });

  // --- 28.1 `invertIfNegative` — bars flip fill colour when the value
  //     is negative. Excel's default is `false`; turning it on is the
  //     OOXML equivalent of the "Invert if negative" checkbox in the
  //     Format Data Series dialog. Requires `fill` so Excel has a
  //     positive-side colour to invert from.
  Cell.setValue(axisEdge, "A3", "28.1 — invertIfNegative (bar auto-flips colour on negatives)");
  Cell.setStyle(axisEdge, "A3", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Net P&L — invertIfNegative on",
      series: [
        {
          name: "Net",
          categories: "'28-PnL'!$A$2:$A$7",
          values: "'28-PnL'!$B$2:$B$7",
          fill: "4472C4",
          invertIfNegative: true
        }
      ],
      showLegend: false,
      valueAxis: {
        // `crossesAt: 0` and `crossBetween: "between"` just clarify
        // the zero baseline — not strictly needed for the demo.
        crosses: "autoZero",
        numFmt: "$#,##0"
      }
    },
    "A4:L23"
  );

  // --- 28.2 `orientation: "maxMin"` — reverse the axis so values
  //     count down. Common on financial / ranking charts where the
  //     top rank sits at the top of the Y axis.
  Cell.setValue(axisEdge, "A26", "28.2 — orientation: 'maxMin' (reversed value axis)");
  Cell.setStyle(axisEdge, "A26", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "bar",
      barDir: "bar",
      grouping: "clustered",
      title: "Reverse-ordered horizontal bars (highest at top)",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ],
      categoryAxis: {
        // `maxMin` flips the category axis so Jan ends up at the
        // bottom (OOXML default is `minMax`).
        orientation: "maxMin"
      }
    },
    "A27:L46"
  );

  // --- 28.3 `crosses: "max"` and `crossesAt: <number>` — make the
  //     X axis cross the Y axis at a specific value (here the monthly
  //     target $180k). Lets callers draw "above target / below target"
  //     charts where the bars hang off a non-zero baseline.
  Cell.setValue(axisEdge, "A49", "28.3 — crossesAt: target line at $180k");
  Cell.setStyle(axisEdge, "A49", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Deviation from $180k target",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4",
          invertIfNegative: true
        }
      ],
      showLegend: false,
      valueAxis: {
        crossesAt: 180,
        numFmt: "$#,##0"
      },
      categoryAxis: {
        // `crosses` on the category axis drives where the value axis
        // "crosses" it. `min` / `max` pin the category axis to the
        // corresponding end of the value axis — useful when the
        // value axis is inverted and you want the baseline at the
        // top of the plot.
        crosses: "max"
      }
    },
    "A50:L69"
  );

  // --- 28.4 `crossBetween: "midCat"` — value axis crosses the category
  //     axis at the midpoint of each category tick rather than between
  //     ticks. Mostly visible on line charts: `between` (default) makes
  //     the line start half a tick in from the left; `midCat` starts
  //     it flush against the axis.
  Cell.setValue(axisEdge, "A72", "28.4 — crossBetween: 'midCat' (line flush against axis)");
  Cell.setStyle(axisEdge, "A72", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "line",
      title: "crossBetween = midCat",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          line: "4472C4",
          marker: { symbol: "circle", size: 7 }
        }
      ],
      valueAxis: { crossBetween: "midCat" }
    },
    "A73:L92"
  );

  // --- 28.5 `tickLblSkip` / `tickMarkSkip` — on dense categorical
  //     axes Excel will overlap labels unless the author thins them
  //     out. `tickLblSkip: 10` means "label every 10th tick" — the
  //     tick marks themselves still render at each data point, but
  //     only one in ten carries a visible label.
  Cell.setValue(axisEdge, "A95", "28.5 — tickLblSkip=10 / tickMarkSkip=5 (90-day daily axis)");
  Cell.setStyle(axisEdge, "A95", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "line",
      title: "90 days of incidents — labels every 10 days",
      series: [
        {
          name: "Incidents",
          categories: "'28-Dense Daily'!$A$2:$A$91",
          values: "'28-Dense Daily'!$B$2:$B$91",
          line: "ED7D31",
          marker: { symbol: "none" }
        }
      ],
      categoryAxis: {
        tickLblSkip: 10,
        tickMarkSkip: 5,
        textRotation: -45,
        numFmt: "mmm-dd"
      },
      showLegend: false
    },
    "A96:L115"
  );

  // --- 28.6 `lblAlgn` / `lblOffset` — category axis label alignment
  //     and spacing. `lblAlgn: "l"` left-aligns labels against their
  //     tick; `lblOffset: 200` pushes them further from the axis
  //     (default 100 = flush against tick marks).
  Cell.setValue(axisEdge, "A118", "28.6 — lblAlgn='l' + lblOffset=200 (left-aligned, pushed away)");
  Cell.setStyle(axisEdge, "A118", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Left-aligned category labels with extra offset",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ],
      categoryAxis: {
        lblAlgn: "l",
        lblOffset: 200,
        textRotation: 0
      },
      showLegend: false
    },
    "A119:L138"
  );

  // --- 28.7 All 11 `lineDash` styles on one radar chart — one
  //     concentric ring per style so the reader can pick a dash they
  //     like from the catalogue. The list mirrors `ST_PresetLineDashVal`
  //     (§20.1.10.49).
  const dashStyles: NonNullable<AddChartSeriesOptions["lineDash"]>[] = [
    "solid",
    "dot",
    "dash",
    "lgDash",
    "dashDot",
    "lgDashDot",
    "lgDashDotDot",
    "sysDash",
    "sysDot",
    "sysDashDot",
    "sysDashDotDot"
  ];
  Cell.setValue(axisEdge, "A141", "28.7 — every lineDash style (11 variants)");
  Cell.setStyle(axisEdge, "A141", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "line",
      title: "Catalogue of line-dash presets",
      showMarker: false,
      series: dashStyles.map((dash, i) => ({
        // Offset each series vertically so they don't overlap — we
        // multiply the same Sales revenue by a per-series scale to
        // spread them into a readable ladder.
        name: dash,
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        line: HEX_PALETTE[i % HEX_PALETTE.length],
        lineWidth: 2,
        lineDash: dash
      })),
      legendPosition: "r"
    },
    "A142:L175"
  );

  // --- 28.8 Log axis with an explicit `logBase: 2` (the Excel UI
  //     defaults to 10, but any integer >= 2 is valid). Showcases
  //     that our log axis isn't hardcoded to base-10.
  Cell.setValue(axisEdge, "A178", "28.8 — logBase=2 value axis (binary decade ticks)");
  Cell.setStyle(axisEdge, "A178", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "line",
      title: "Log scale — base 2",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          line: "70AD47",
          marker: { symbol: "diamond", size: 7 }
        }
      ],
      valueAxis: {
        logBase: 2,
        min: 64,
        max: 512,
        numFmt: "0",
        title: "Revenue (log₂)"
      }
    },
    "A179:L198"
  );

  // --- 28.9 `showDLblsOverMax: true` — render data labels even when
  //     the label's value exceeds the value axis `max`. Without this
  //     flag Excel clips the label along with the bar; with it set,
  //     the label "floats" above the plot area so the number stays
  //     readable.
  Cell.setValue(axisEdge, "A201", "28.9 — showDLblsOverMax: clipped bars still label");
  Cell.setStyle(axisEdge, "A201", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Revenue clipped at $200 — labels still rendered",
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4",
          dataLabels: { showVal: true, position: "outEnd", numFmt: "$#,##0" }
        }
      ],
      valueAxis: { max: 200, numFmt: "$#,##0" },
      showDLblsOverMax: true,
      showLegend: false
    },
    "A202:L221"
  );

  // --- 28.10 `showLeaderLines: true` — pie charts with external
  //     `outEnd` labels emit leader lines connecting each slice to
  //     its label when the flag is on. Turning it off (default on
  //     some Excel builds) leaves the labels visually detached.
  Cell.setValue(axisEdge, "A224", "28.10 — pie with explicit showLeaderLines");
  Cell.setStyle(axisEdge, "A224", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "pie",
      title: "Revenue by month — leader lines on",
      varyColors: true,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          dataLabels: {
            showPercent: true,
            showCatName: true,
            position: "outEnd",
            separator: " • ",
            showLeaderLines: true
          }
        }
      ]
    },
    "A225:L244"
  );

  // --- 28.11 Defined-name reference — `wb.definedNames.add(...)`
  //     lets callers reuse a named range as a series reference
  //     without repeating the `Sheet!$A$1:$A$n` formula. Common
  //     when Excel users save a file with named ranges and expect
  //     round-trip fidelity.
  DefinedNames.add(Workbook.getDefinedNames(wb), "Sales!$A$2:$A$7", "MonthCategories");
  DefinedNames.add(Workbook.getDefinedNames(wb), "Sales!$B$2:$B$7", "MonthRevenue");
  Cell.setValue(axisEdge, "A247", "28.11 — categories / values via defined names");
  Cell.setStyle(axisEdge, "A247", { font: { bold: true } });
  Chart.add(
    axisEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Series references via `=MonthCategories` / `=MonthRevenue`",
      series: [
        {
          name: "Revenue",
          categories: "MonthCategories",
          values: "MonthRevenue",
          fill: "5B9BD5"
        }
      ],
      showLegend: false,
      valueAxis: { numFmt: "$#,##0" }
    },
    "A248:L267"
  );

  // ---------------------------------------------------------------------------
  // 29. Data-handling edge cases — how charts deal with blanks,
  //     negatives, and blanket overrides on the whole data-labels
  //     block.
  // ---------------------------------------------------------------------------

  // Sparse monthly data with two "hole" months, used by the three
  // `displayBlanksAs` charts below to visualise each mode against
  // the same numbers.
  const sparse = Workbook.addWorksheet(wb, "29-Sparse");
  Worksheet.addRow(sparse, ["Month", "Revenue"]);
  Worksheet.addRows(sparse, [
    ["Jan", 120],
    ["Feb", null],
    ["Mar", 160],
    ["Apr", null],
    ["May", 232],
    ["Jun", 248]
  ]);

  const dataEdge = Workbook.addWorksheet(wb, "29-Data Handling");
  Worksheet.addRow(dataEdge, ["Data-handling edge cases"]);
  Cell.setStyle(dataEdge, "A1", { font: { bold: true } });

  // --- 29.1 `displayBlanksAs` variants side-by-side. `gap` (default)
  //     leaves visible gaps in the line; `zero` treats blanks as 0
  //     (producing spikes down to the axis); `span` interpolates
  //     straight through the gap.
  const blanksModes: Array<"gap" | "zero" | "span"> = ["gap", "zero", "span"];
  for (let i = 0; i < blanksModes.length; i++) {
    const mode = blanksModes[i];
    const row = 3 + i * 22;
    Cell.setValue(dataEdge, `A${row}`, `29.1.${i + 1} — displayBlanksAs: '${mode}'`);
    Cell.setStyle(dataEdge, `A${row}`, { font: { bold: true } });
    Chart.add(
      dataEdge,
      {
        type: "line",
        title: `Sparse data rendered with displayBlanksAs='${mode}'`,
        series: [
          {
            name: "Revenue",
            categories: "'29-Sparse'!$A$2:$A$7",
            values: "'29-Sparse'!$B$2:$B$7",
            line: HEX_PALETTE[i],
            marker: { symbol: "circle", size: 7 }
          }
        ],
        displayBlanksAs: mode,
        showLegend: false
      },
      `A${row + 1}:L${row + 20}`
    );
  }

  // --- 29.2 Negative values with `invertIfNegative` + `inBase` label
  //     position. `inBase` places the value label at the category
  //     axis end of each bar — useful for negative values because
  //     it keeps the number anchored at the zero line instead of
  //     floating below the plot area.
  Cell.setValue(dataEdge, "A70", "29.2 — negative bars with invertIfNegative + dLblPos 'inBase'");
  Cell.setStyle(dataEdge, "A70", { font: { bold: true } });
  Chart.add(
    dataEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Quarterly P&L (loss months flipped red)",
      series: [
        {
          name: "Net",
          categories: "'28-PnL'!$A$2:$A$7",
          values: "'28-PnL'!$B$2:$B$7",
          fill: "4472C4",
          invertIfNegative: true,
          dataLabels: {
            showVal: true,
            position: "inBase",
            numFmt: "$#,##0;[Red]-$#,##0"
          }
        }
      ],
      showLegend: false,
      valueAxis: { numFmt: "$#,##0" }
    },
    "A71:L90"
  );

  // --- 29.3 Mass-hide every data label via per-entry `delete: true`.
  //     OOXML's internal `c:dLbls/c:delete` shortcut isn't exposed on
  //     the public builder (it would conflict with the display-flags
  //     choice group), but enumerating each point with `delete: true`
  //     achieves the same "silence all labels" outcome against a
  //     chart style that otherwise turns them on.
  Cell.setValue(dataEdge, "A93", "29.3 — per-entry delete suppresses every auto-label");
  Cell.setStyle(dataEdge, "A93", { font: { bold: true } });
  Chart.add(
    dataEdge,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Style-19 wants labels; enumerate-delete silences them",
      style: 19,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4",
          dataLabels: {
            entries: Array.from({ length: 6 }, (_, i) => ({ index: i, delete: true }))
          }
        }
      ],
      showLegend: false
    },
    "A94:L113"
  );

  // ---------------------------------------------------------------------------
  // 30. Chart-type variants — extra flavours of stock / bubble /
  //     radar / ofPie / surface that the 1-16 gallery glossed over.
  // ---------------------------------------------------------------------------

  // Stock variants. Excel's UI recognises four: HLC (High-Low-Close,
  // 3 series), OHLC (Open-High-Low-Close, 4), VHLC (Volume-High-
  // Low-Close, 4) and VOHLC (Volume-Open-High-Low-Close, 5). The
  // existing gallery covers OHLC — add the other three here.
  const stockMulti = Workbook.addWorksheet(wb, "30-Stock Variants");
  Worksheet.addRow(stockMulti, ["Date", "Volume", "Open", "High", "Low", "Close"]);
  const stockRows: Array<[Date, number, number, number, number, number]> = [
    [new Date("2024-02-01"), 2_400_000, 150, 156, 149, 154],
    [new Date("2024-02-02"), 2_900_000, 154, 158, 152, 157],
    [new Date("2024-02-05"), 2_150_000, 157, 161, 155, 159],
    [new Date("2024-02-06"), 3_100_000, 159, 162, 156, 160],
    [new Date("2024-02-07"), 2_750_000, 160, 165, 158, 164]
  ];
  Worksheet.addRows(stockMulti, stockRows);
  Column.setStyle(stockMulti, 1, { numFmt: "yyyy-mm-dd" });
  Column.setStyle(stockMulti, 2, { numFmt: "#,##0" });

  const variants = Workbook.addWorksheet(wb, "30-Chart Variants");
  Worksheet.addRow(variants, ["Chart-type variants"]);
  Cell.setStyle(variants, "A1", { font: { bold: true } });

  // --- 30.1 Stock HLC (no Open series) — just High / Low / Close
  //     connected by hiLowLines. The thinnest stock variant.
  Cell.setValue(variants, "A3", "30.1 — Stock HLC (High-Low-Close)");
  Cell.setStyle(variants, "A3", { font: { bold: true } });
  Chart.add(
    variants,
    {
      type: "stock",
      title: "HLC — 3-series stock chart",
      hiLowLines: true,
      series: [
        {
          name: "High",
          categories: "'30-Stock Variants'!$A$2:$A$6",
          values: "'30-Stock Variants'!$D$2:$D$6",
          line: "70AD47",
          marker: { symbol: "none" }
        },
        {
          name: "Low",
          categories: "'30-Stock Variants'!$A$2:$A$6",
          values: "'30-Stock Variants'!$E$2:$E$6",
          line: "C00000",
          marker: { symbol: "none" }
        },
        {
          name: "Close",
          categories: "'30-Stock Variants'!$A$2:$A$6",
          values: "'30-Stock Variants'!$F$2:$F$6",
          line: "000000",
          marker: { symbol: "none" }
        }
      ],
      categoryAxis: { numFmt: "yyyy-mm-dd" }
    },
    "A4:L23"
  );

  // --- 30.2 Stock VHLC — adds a Volume bar series on a secondary
  //     axis. The builder doesn't yet auto-split into combo groups
  //     for VHLC, so we use `addComboChart` to model it precisely
  //     (bar + line groups, volume on primary / OHLC on secondary).
  Cell.setValue(variants, "A26", "30.2 — Stock VHLC (Volume + High-Low-Close) combo");
  Cell.setStyle(variants, "A26", { font: { bold: true } });
  Chart.addCombo(
    variants,
    {
      title: "VHLC — Volume bars + HLC line",
      groups: [
        {
          type: "bar",
          barDir: "col",
          grouping: "clustered",
          series: [
            {
              name: "Volume",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$B$2:$B$6",
              fill: "BFBFBF"
            }
          ],
          // Put the category axis config on the primary group —
          // `AddComboChartOptions` has no top-level categoryAxis
          // slot (each group owns its own cat/val axes).
          categoryAxis: { numFmt: "yyyy-mm-dd" },
          valueAxis: { title: "Volume", numFmt: "#,##0" }
        },
        {
          type: "stock",
          hiLowLines: true,
          series: [
            {
              name: "High",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$D$2:$D$6",
              line: "70AD47",
              marker: { symbol: "none" }
            },
            {
              name: "Low",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$E$2:$E$6",
              line: "C00000",
              marker: { symbol: "none" }
            },
            {
              name: "Close",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$F$2:$F$6",
              line: "000000",
              marker: { symbol: "none" }
            }
          ],
          useSecondaryAxis: true,
          valueAxis: { title: "Price", numFmt: "$0.00" }
        }
      ]
    },
    "A27:L46"
  );

  // --- 30.3 Stock VOHLC — Volume + full OHLC, the richest stock
  //     variant. Same combo idea as VHLC plus an Open series.
  Cell.setValue(variants, "A49", "30.3 — Stock VOHLC (Volume + Open-High-Low-Close)");
  Cell.setStyle(variants, "A49", { font: { bold: true } });
  Chart.addCombo(
    variants,
    {
      title: "VOHLC — Volume bars + OHLC with upDownBars",
      groups: [
        {
          type: "bar",
          barDir: "col",
          grouping: "clustered",
          series: [
            {
              name: "Volume",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$B$2:$B$6",
              fill: "BFBFBF"
            }
          ],
          categoryAxis: { numFmt: "yyyy-mm-dd" },
          valueAxis: { title: "Volume", numFmt: "#,##0" }
        },
        {
          type: "stock",
          hiLowLines: true,
          upDownBars: {
            gapWidth: 150,
            upBars: { fill: "FFFFFF", border: "70AD47" },
            downBars: { fill: "C00000", border: "C00000" }
          },
          series: [
            {
              name: "Open",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$C$2:$C$6",
              line: "70AD47",
              marker: { symbol: "none" }
            },
            {
              name: "High",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$D$2:$D$6",
              line: "70AD47",
              marker: { symbol: "none" }
            },
            {
              name: "Low",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$E$2:$E$6",
              line: "C00000",
              marker: { symbol: "none" }
            },
            {
              name: "Close",
              categories: "'30-Stock Variants'!$A$2:$A$6",
              values: "'30-Stock Variants'!$F$2:$F$6",
              line: "000000",
              marker: { symbol: "none" }
            }
          ],
          useSecondaryAxis: true,
          valueAxis: { title: "Price", numFmt: "$0.00" }
        }
      ]
    },
    "A50:L69"
  );

  // --- 30.4 Bubble with negative bubble sizes + `showNegBubbles: true`
  //     + `bubble3D`. Negative sizes are common in scenario analysis
  //     (loss size) and Excel uses a hollow / inverted bubble glyph
  //     to represent them when the flag is on.
  const bubbleNeg = Workbook.addWorksheet(wb, "30-Bubble Neg");
  Worksheet.addRow(bubbleNeg, ["Hours", "Score", "Impact"]);
  Worksheet.addRows(bubbleNeg, [
    [1, 45, 3],
    [2, 55, -5],
    [3, 62, 4],
    [4, 70, -7],
    [5, 78, 6],
    [6, 85, 9]
  ]);
  Cell.setValue(variants, "A72", "30.4 — Bubble with negative sizes + showNegBubbles + bubble3D");
  Cell.setStyle(variants, "A72", { font: { bold: true } });
  Chart.add(
    variants,
    {
      type: "bubble",
      title: "Impact bubbles — negatives shown as inverted markers",
      bubbleScale: 100,
      showNegBubbles: true,
      sizeRepresents: "area",
      series: [
        {
          name: "Scenarios",
          xValues: "'30-Bubble Neg'!$A$2:$A$7",
          values: "'30-Bubble Neg'!$B$2:$B$7",
          bubbleSize: "'30-Bubble Neg'!$C$2:$C$7",
          fill: "4472C4",
          bubble3D: true
        }
      ],
      categoryAxis: { title: "Hours" },
      valueAxis: { title: "Score" }
    },
    "A73:L92"
  );

  // --- 30.5 Radar with 12 categories + 3 series — wide radar for
  //     comparing skill / balance profiles.
  const radarWide = Workbook.addWorksheet(wb, "30-Radar Wide");
  Worksheet.addRow(radarWide, ["Attribute", "Rookie", "Journeyman", "Expert"]);
  Worksheet.addRows(radarWide, [
    ["Vision", 3, 6, 9],
    ["Tempo", 4, 7, 8],
    ["Precision", 2, 5, 10],
    ["Strength", 5, 6, 7],
    ["Stamina", 6, 7, 8],
    ["Focus", 3, 6, 9],
    ["Clutch", 2, 4, 10],
    ["Leadership", 3, 7, 9],
    ["Creativity", 4, 6, 8],
    ["Adaptability", 5, 7, 9],
    ["Grit", 6, 7, 10],
    ["Poise", 4, 6, 9]
  ]);
  Cell.setValue(variants, "A95", "30.5 — Radar with 12 axes × 3 series");
  Cell.setStyle(variants, "A95", { font: { bold: true } });
  Chart.add(
    variants,
    {
      type: "radar",
      radarStyle: "marker",
      title: "Skill profile radar",
      series: [
        {
          name: "Rookie",
          categories: "'30-Radar Wide'!$A$2:$A$13",
          values: "'30-Radar Wide'!$B$2:$B$13",
          line: "A5A5A5",
          marker: { symbol: "circle", size: 5, fill: "A5A5A5" }
        },
        {
          name: "Journeyman",
          categories: "'30-Radar Wide'!$A$2:$A$13",
          values: "'30-Radar Wide'!$C$2:$C$13",
          line: "4472C4",
          marker: { symbol: "square", size: 5, fill: "4472C4" }
        },
        {
          name: "Expert",
          categories: "'30-Radar Wide'!$A$2:$A$13",
          values: "'30-Radar Wide'!$D$2:$D$13",
          line: "70AD47",
          marker: { symbol: "diamond", size: 6, fill: "70AD47" }
        }
      ],
      valueAxis: { min: 0, max: 10, majorUnit: 2 }
    },
    "A96:L115"
  );

  // --- 30.6 `ofPie splitType: "val"` — split secondary pie by value
  //     threshold. Every slice below the threshold goes into the
  //     second pie; larger slices stay in the main.
  Cell.setValue(variants, "A118", "30.6 — ofPie splitType='val' (threshold = $130)");
  Cell.setStyle(variants, "A118", { font: { bold: true } });
  Chart.add(
    variants,
    {
      type: "ofPie",
      ofPieType: "pie",
      title: "Bar-of-pie split by value threshold",
      splitType: "val",
      splitPos: 130,
      serLines: true,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7"
        }
      ]
    },
    "A119:L138"
  );

  // --- 30.7 `ofPie splitType: "percent"` with a larger secondPieSize.
  //     Demonstrates the `secondPieSize` extreme — pushing it to 150
  //     makes the secondary pie bigger than the primary, a layout
  //     choice Excel allows but rarely produces by default.
  Cell.setValue(
    variants,
    "A141",
    "30.7 — ofPie secondPieSize=150 (secondary pie larger than primary)"
  );
  Cell.setStyle(variants, "A141", { font: { bold: true } });
  Chart.add(
    variants,
    {
      type: "ofPie",
      ofPieType: "pie",
      title: "Oversized secondary pie",
      splitType: "percent",
      splitPos: 15,
      secondPieSize: 150,
      serLines: true,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7"
        }
      ]
    },
    "A142:L161"
  );

  // --- 30.8 Surface with a richer 8×8 matrix — highlights band
  //     transitions better than the 4×4 default gallery surface.
  const surfaceBig = Workbook.addWorksheet(wb, "30-Surface Big");
  // Build an 8×8 grid where z = sin(x/2) * cos(y/2) * 10 — a smooth
  // radial pattern that surface charts render as concentric bands.
  const headers = ["", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8"];
  Worksheet.addRow(surfaceBig, headers);
  for (let r = 0; r < 8; r++) {
    const row: Array<string | number> = [`R${r + 1}`];
    for (let c = 0; c < 8; c++) {
      row.push(Math.round(Math.sin(r / 2) * Math.cos(c / 2) * 10 + 20));
    }
    Worksheet.addRow(surfaceBig, row);
  }
  Cell.setValue(variants, "A164", "30.8 — Surface 8×8 matrix (smoother band transitions)");
  Cell.setStyle(variants, "A164", { font: { bold: true } });
  Chart.add(
    variants,
    {
      type: "surface3D",
      title: "Surface3D — smooth radial z = sin·cos",
      view3D: { rotX: 30, rotY: 30, perspective: 30 },
      series: Array.from({ length: 8 }, (_, i) => ({
        name: `R${i + 1}`,
        categories: "'30-Surface Big'!$B$1:$I$1",
        values: `'30-Surface Big'!$B$${i + 2}:$I$${i + 2}`
      }))
    },
    "A165:L184"
  );

  // ---------------------------------------------------------------------------
  // 31. ChartEx deep-dive — extras for the Excel 2016+ modern
  //     chart families that were only touched briefly in section 3.
  // ---------------------------------------------------------------------------

  // 4-level hierarchical data for the deep treemap / sunburst demos.
  // `Region → Country → State → City` with a $Sales column.
  const deepHier = Workbook.addWorksheet(wb, "31-Deep Hierarchy");
  Worksheet.addRows(deepHier, [
    ["Region", "Country", "State", "City", "Sales"],
    ["Americas", "USA", "CA", "San Francisco", 360],
    ["Americas", "USA", "CA", "Los Angeles", 220],
    ["Americas", "USA", "NY", "New York", 420],
    ["Americas", "USA", "NY", "Buffalo", 110],
    ["Americas", "USA", "TX", "Austin", 180],
    ["Americas", "USA", "TX", "Houston", 140],
    ["Americas", "Brazil", "SP", "São Paulo", 210],
    ["Americas", "Brazil", "RJ", "Rio", 130],
    ["EMEA", "UK", "ENG", "London", 310],
    ["EMEA", "UK", "SCT", "Edinburgh", 90],
    ["EMEA", "Germany", "BY", "Munich", 180],
    ["EMEA", "Germany", "BE", "Berlin", 280],
    ["EMEA", "France", "IDF", "Paris", 240],
    ["EMEA", "France", "PAC", "Marseille", 80],
    ["APAC", "Japan", "13", "Tokyo", 400],
    ["APAC", "Japan", "27", "Osaka", 180],
    ["APAC", "China", "31", "Shanghai", 520],
    ["APAC", "China", "11", "Beijing", 310],
    ["APAC", "Australia", "NSW", "Sydney", 180],
    ["APAC", "Australia", "VIC", "Melbourne", 160]
  ]);

  // Wide histogram dataset — 120 samples with long tails so the
  // `byWidth` / `overflow` bin modes show something interesting.
  const histoWide = Workbook.addWorksheet(wb, "31-Histogram Wide");
  Worksheet.addRow(histoWide, ["Sample"]);
  {
    const wideSamples: number[] = [];
    for (let i = 0; i < 100; i++) {
      // Normal-ish centre + long right tail.
      const value = Math.round(
        50 + Math.random() * 40 + (Math.random() < 0.08 ? Math.random() * 100 : 0)
      );
      wideSamples.push(value);
    }
    wideSamples.push(3, 7, 210, 240); // explicit outliers for overflow/underflow demos
    wideSamples.forEach(n => Worksheet.addRow(histoWide, [n]));
  }

  // Conversion-funnel stages for the custom-label funnel.
  const funnelCustom = Workbook.addWorksheet(wb, "31-Funnel Stages");
  Worksheet.addRows(funnelCustom, [
    ["Stage", "Visitors"],
    ["Landing page", 10_000],
    ["Viewed pricing", 4_200],
    ["Added to cart", 1_850],
    ["Checkout started", 720],
    ["Payment confirmed", 410],
    ["Retained 30d", 275]
  ]);

  const exDeep = Workbook.addWorksheet(wb, "31-ChartEx Deep");
  Worksheet.addRow(exDeep, ["ChartEx deep-dive"]);
  Cell.setStyle(exDeep, "A1", { font: { bold: true } });

  // --- 31.1 Waterfall with explicit `total` bars. Marking specific
  //     points as totals lets Excel render them as standalone bars
  //     (different colour, anchored at zero) instead of floating
  //     on top of the running sum.
  Cell.setValue(exDeep, "A3", "31.1 — Waterfall with total markers at quarter-ends");
  Cell.setStyle(exDeep, "A3", { font: { bold: true } });
  const wfSheet = Workbook.addWorksheet(wb, "31-Waterfall");
  Worksheet.addRows(wfSheet, [
    ["Step", "Delta"],
    ["Starting cash", 1_000],
    ["Q1 revenue", 450],
    ["Q1 cost", -210],
    ["Q1 total", 1_240],
    ["Q2 revenue", 520],
    ["Q2 cost", -280],
    ["Q2 total", 1_480]
  ]);
  Chart.addEx(
    exDeep,
    {
      type: "waterfall",
      title: "Waterfall — Q1/Q2 totals anchored at zero",
      categories: "'31-Waterfall'!$A$2:$A$8",
      series: [
        {
          name: "Cash",
          values: "'31-Waterfall'!$B$2:$B$8",
          // Flag specific indices as subtotals — the renderer draws
          // them as wider anchored bars instead of floating deltas.
          // Use the `subtotals` shortcut (array of 0-based indices)
          // or the `subtotalPoints` form (`{ idx: number }`) when
          // mixing with other OOXML-shaped builder code.
          subtotals: [0, 3, 6]
        }
      ],
      layout: { connectorLines: true }
    },
    "A4:L23"
  );

  // --- 31.2 Treemap with 4-level `parentLabelLayout: "overlapping"`.
  //     Deeper hierarchies exercise the label-wrapping / color
  //     cascade more than the gallery's 3-level demo.
  Cell.setValue(exDeep, "A26", "31.2 — Treemap 4 levels (Region → Country → State → City)");
  Cell.setStyle(exDeep, "A26", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "treemap",
      title: "Sales — 4-level treemap with overlapping parent labels",
      categories: "'31-Deep Hierarchy'!$D$2:$D$21",
      series: [
        {
          name: "Sales",
          values: "'31-Deep Hierarchy'!$E$2:$E$21",
          hierarchy: [
            "'31-Deep Hierarchy'!$A$2:$A$21",
            "'31-Deep Hierarchy'!$B$2:$B$21",
            "'31-Deep Hierarchy'!$C$2:$C$21"
          ]
        }
      ],
      layout: { parentLabelLayout: "overlapping" }
    },
    "A27:L50"
  );

  // --- 31.3 Sunburst with the same 4-level hierarchy — compare
  //     visual density vs the treemap.
  Cell.setValue(exDeep, "A53", "31.3 — Sunburst 4 levels (same hierarchy as 31.2)");
  Cell.setStyle(exDeep, "A53", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "sunburst",
      title: "Sales — 4-ring sunburst",
      categories: "'31-Deep Hierarchy'!$D$2:$D$21",
      series: [
        {
          name: "Sales",
          values: "'31-Deep Hierarchy'!$E$2:$E$21",
          hierarchy: [
            "'31-Deep Hierarchy'!$A$2:$A$21",
            "'31-Deep Hierarchy'!$B$2:$B$21",
            "'31-Deep Hierarchy'!$C$2:$C$21"
          ]
        }
      ]
    },
    "A54:L77"
  );

  // --- 31.4 Funnel with custom stage labels — annotating each stage
  //     with `text` on the data-label entry puts a richer, in-bar
  //     caption on top of the default stage name.
  Cell.setValue(exDeep, "A80", "31.4 — Funnel with per-stage custom labels");
  Cell.setStyle(exDeep, "A80", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "funnel",
      title: "Conversion funnel — rich per-stage callouts",
      categories: "'31-Funnel Stages'!$A$2:$A$7",
      series: [
        {
          name: "Visitors",
          values: "'31-Funnel Stages'!$B$2:$B$7",
          dataLabels: {
            showValue: true,
            showCategory: true,
            numFmt: "#,##0"
          }
        }
      ]
    },
    "A81:L104"
  );

  // --- 31.5 Histogram with `binCount: 8` — force an explicit number
  //     of bins instead of letting Excel auto-choose. The `binning`
  //     shortcut on `AddChartExOptions` is the ergonomic equivalent
  //     of `layout.binning`.
  Cell.setValue(exDeep, "A107", "31.5 — Histogram binCount=8 bins");
  Cell.setStyle(exDeep, "A107", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "histogram",
      title: "Histogram — 8 auto-width bins",
      categories: "'31-Histogram Wide'!$A$1:$A$1",
      series: [
        {
          name: "Samples",
          values: "'31-Histogram Wide'!$A$2:$A$105"
        }
      ],
      binning: { binCount: 8, binType: "binCount" }
    },
    "A108:L127"
  );

  // --- 31.6 Histogram with fixed-width bins (`binSize: 20`) and
  //     explicit overflow / underflow bounds. Outliers above 180
  //     collapse into a single ">" bin; below 20 into a "<" bin.
  Cell.setValue(exDeep, "A130", "31.6 — Histogram binSize=20 + overflow 180 / underflow 20");
  Cell.setStyle(exDeep, "A130", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "histogram",
      title: "Histogram — fixed-width bins with overflow / underflow",
      categories: "'31-Histogram Wide'!$A$1:$A$1",
      series: [
        {
          name: "Samples",
          values: "'31-Histogram Wide'!$A$2:$A$105"
        }
      ],
      binning: {
        binSize: 20,
        binType: "binSize",
        overflow: 180,
        underflow: 20
      }
    },
    "A131:L150"
  );

  // --- 31.7 Pareto — `layout.paretoLine: true` explicitly turns on
  //     the cumulative overlay line. The builder infers this from
  //     `type: "pareto"` but passing it explicitly is the escape
  //     hatch for callers that want to keep the base histogram on
  //     a pareto-typed chart without the cumulative curve.
  Cell.setValue(exDeep, "A153", "31.7 — Pareto with explicit paretoLine toggle");
  Cell.setStyle(exDeep, "A153", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "pareto",
      title: "Pareto — funnel stages with cumulative line",
      categories: "'31-Funnel Stages'!$A$2:$A$7",
      series: [
        {
          name: "Visitors",
          values: "'31-Funnel Stages'!$B$2:$B$7",
          fill: "4472C4"
        }
      ],
      layout: { paretoLine: true }
    },
    "A154:L173"
  );

  // --- 31.8 BoxWhisker with every statistical flag on — inner
  //     points, outliers, mean marker and mean line. All flags live
  //     on `layout` for ChartEx, not on the series itself.
  Cell.setValue(exDeep, "A176", "31.8 — BoxWhisker all flags on (showInner/Outlier/Mean/MeanLine)");
  Cell.setStyle(exDeep, "A176", { font: { bold: true } });
  Chart.addEx(
    exDeep,
    {
      type: "boxWhisker",
      title: "Distribution — full statistical detail",
      categories: "Distribution!$A$1:$A$1",
      series: [
        {
          name: "Samples",
          values: "Distribution!$A$2:$A$41"
        }
      ],
      layout: {
        showInnerPoints: true,
        showOutlierPoints: true,
        showMeanMarker: true,
        showMeanLine: true,
        quartileMethod: "inclusive"
      }
    },
    "A177:L196"
  );

  // ---------------------------------------------------------------------------
  // 32. Style catalogue — advanced trendline / error-bar styling that
  //     was not exercised in section 12.
  // ---------------------------------------------------------------------------

  const styleCat = Workbook.addWorksheet(wb, "32-Style Catalogue");
  Worksheet.addRow(styleCat, ["Style catalogue"]);
  Cell.setStyle(styleCat, "A1", { font: { bold: true } });

  // --- 32.1 Trendline with a custom rich-text label — label.txPr
  //     lets callers override the auto-generated "y = 1.2x + 45"
  //     caption with their own bold / coloured text.
  Cell.setValue(styleCat, "A3", "32.1 — Trendline with custom rich-text label");
  Cell.setStyle(styleCat, "A3", { font: { bold: true } });
  Chart.add(
    styleCat,
    {
      type: "scatter",
      scatterStyle: "marker",
      title: "Scatter with annotated trendline",
      series: [
        {
          name: "Points",
          xValues: "Scatter!$A$2:$A$8",
          values: "Scatter!$B$2:$B$8",
          marker: { symbol: "circle", size: 6, fill: "4472C4" },
          trendline: {
            type: "linear",
            displayEq: true,
            displayRSqr: true,
            line: "ED7D31",
            lineDash: "dash",
            lineWidth: 2,
            label: {
              numFmt: "0.00",
              txPr: { size: 1000, bold: true, color: { srgb: "C00000" } }
            }
          }
        }
      ]
    },
    "A4:L23"
  );

  // --- 32.2 Error bars with advanced `spPr` — structured line
  //     properties (explicit width + dash + compound style) instead
  //     of just a flat colour. `spPr` is the escape hatch for
  //     authors who need more than the `line` / `lineWidth` /
  //     `lineDash` shortcuts expose (e.g. compound double lines,
  //     bevelled joins). `ChartLine` does not accept gradients —
  //     Excel's `<a:ln>` grammar only takes a single solid-fill
  //     colour on the error-bar stroke.
  Cell.setValue(styleCat, "A26", "32.2 — Error bars with structured spPr (compound line)");
  Cell.setStyle(styleCat, "A26", { font: { bold: true } });
  Chart.add(
    styleCat,
    {
      type: "scatter",
      scatterStyle: "marker",
      title: "Error bars with a compound double line",
      series: [
        {
          name: "Measurements",
          xValues: "Scatter!$A$2:$A$8",
          values: "Scatter!$B$2:$B$8",
          marker: { symbol: "diamond", size: 7, fill: "4472C4" },
          errorBars: {
            type: "percentage",
            value: 15,
            direction: "y",
            barDir: "both",
            spPr: {
              line: {
                width: 28_575, // 3pt in EMU
                color: { srgb: "C00000" },
                dash: "dash",
                compound: "dbl",
                cap: "rnd"
              }
            }
          }
        }
      ]
    },
    "A27:L46"
  );

  // ---------------------------------------------------------------------------
  // 33. Stress & robustness — volume, long text, Unicode,
  //     layered label overrides, extreme view3D. Intentionally
  //     produces the "broadest" charts in the workbook so we can
  //     spot layout regressions visually.
  // ---------------------------------------------------------------------------

  const stressData = Workbook.addWorksheet(wb, "33-Stress Data");
  Worksheet.addRow(stressData, [
    "Category",
    ...Array.from({ length: 20 }, (_, i) => `Series ${i + 1}`)
  ]);
  for (let r = 0; r < 100; r++) {
    const row: Array<string | number> = [`C${r + 1}`];
    for (let s = 0; s < 20; s++) {
      // Each series follows a distinct sinusoid so the 20-series
      // pile visually separates rather than all overlapping.
      row.push(Math.round(50 + Math.sin(r / 8 + s / 3) * 20 + s));
    }
    Worksheet.addRow(stressData, row);
  }

  const stress = Workbook.addWorksheet(wb, "33-Stress & Edge");
  Worksheet.addRow(stress, ["Stress & robustness"]);
  Cell.setStyle(stress, "A1", { font: { bold: true } });

  // --- 33.1 Single series with 100 data points — tests how the
  //     category axis and renderer handle a high point-count without
  //     tick skipping.
  Cell.setValue(stress, "A3", "33.1 — 100 data points on one series");
  Cell.setStyle(stress, "A3", { font: { bold: true } });
  Chart.add(
    stress,
    {
      type: "line",
      title: "100 points — dense single series",
      series: [
        {
          name: "Series 1",
          categories: "'33-Stress Data'!$A$2:$A$101",
          values: "'33-Stress Data'!$B$2:$B$101",
          line: "4472C4",
          marker: { symbol: "none" }
        }
      ],
      categoryAxis: { tickLblSkip: 10, textRotation: -45 },
      showLegend: false
    },
    "A4:L23"
  );

  // --- 33.2 20 series on one chart — stresses the legend layout
  //     and the colour palette auto-selection. `varyColors` is
  //     true by default on area/line; passing explicit per-series
  //     `line` just to make every series visibly distinct.
  Cell.setValue(stress, "A26", "33.2 — 20 series at once (palette stress)");
  Cell.setStyle(stress, "A26", { font: { bold: true } });
  Chart.add(
    stress,
    {
      type: "line",
      title: "20-series line chart",
      series: Array.from({ length: 20 }, (_, i) => {
        const col = String.fromCharCode("B".charCodeAt(0) + i);
        return {
          name: `Series ${i + 1}`,
          categories: "'33-Stress Data'!$A$2:$A$21",
          values: `'33-Stress Data'!$${col}$2:$${col}$21`,
          line: HEX_PALETTE[i % HEX_PALETTE.length],
          marker: { symbol: "none" }
        };
      }),
      legendPosition: "r"
    },
    "A27:L46"
  );

  // --- 33.3 Extremely long titles and axis labels — exercises
  //     Excel's title auto-wrap and tests that the writer doesn't
  //     truncate text at arbitrary limits.
  Cell.setValue(stress, "A49", "33.3 — very long title + axis titles (wrap test)");
  Cell.setStyle(stress, "A49", { font: { bold: true } });
  const longTitle =
    "A comprehensive quarterly performance summary of the North American and EMEA revenue streams aligned against our strategic targets for fiscal year 2024";
  Chart.add(
    stress,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: longTitle,
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ],
      categoryAxis: {
        title: "Calendar months of the current reporting period (January through June)"
      },
      valueAxis: {
        title: "Revenue measured in United States dollars (before rebates and chargebacks)",
        numFmt: "$#,##0"
      }
    },
    "A50:L69"
  );

  // --- 33.4 Unicode / emoji / mixed-script text in titles and
  //     categories. Covers CJK, RTL-eligible scripts (Arabic,
  //     Hebrew) and emoji — text that historically tripped up
  //     XML serialisers or measurement code.
  const unicodeData = Workbook.addWorksheet(wb, "33-Unicode");
  Worksheet.addRows(unicodeData, [
    ["Category", "Count"],
    ["销售额 📈", 120],
    ["مبيعات 🌍", 180],
    ["מכירות ✨", 160],
    ["売上 🚀", 205],
    ["Продажи ❄", 232],
    ["Ventas 🔥", 248]
  ]);
  Cell.setValue(
    stress,
    "A72",
    "33.4 — Unicode categories (CJK / Arabic / Hebrew / Cyrillic / emoji)"
  );
  Cell.setStyle(stress, "A72", { font: { bold: true } });
  Chart.add(
    stress,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "Global categories — 销售额 / مبيعات / 売上 🌐",
      series: [
        {
          name: "Count",
          categories: "'33-Unicode'!$A$2:$A$7",
          values: "'33-Unicode'!$B$2:$B$7",
          fill: "70AD47"
        }
      ],
      showLegend: false
    },
    "A73:L92"
  );

  // --- 33.5 Extreme view3D angles (rotX=75, rotY=340, perspective=100).
  //     The OOXML range is 0–90 for rotX, 0–360 for rotY, 0–100 for
  //     perspective — picking values near each extreme tests the
  //     writer's attribute serialisation.
  Cell.setValue(stress, "A95", "33.5 — extreme view3D (rotX=75 / rotY=340 / perspective=100)");
  Cell.setStyle(stress, "A95", { font: { bold: true } });
  Chart.add(
    stress,
    {
      type: "bar3D",
      barDir: "col",
      grouping: "clustered",
      title: "3D bar — near-limit view3D",
      view3D: { rotX: 75, rotY: 340, rAngAx: false, perspective: 100 },
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4"
        }
      ]
    },
    "A96:L115"
  );

  // --- 33.6 Three-level data-label precedence: chart-level, series-
  //     level, and per-entry. Excel applies the most specific
  //     override wins — useful for programmatic writers that
  //     cascade styles from "everyone shows percent" down to
  //     "except point 3 which shows the value".
  Cell.setValue(stress, "A118", "33.6 — data-label cascade (chart > series > per-entry)");
  Cell.setStyle(stress, "A118", { font: { bold: true } });
  Chart.add(
    stress,
    {
      type: "bar",
      barDir: "col",
      grouping: "clustered",
      title: "dLbls cascade",
      // Chart-level default: show value + outEnd.
      dataLabels: { showVal: true, position: "outEnd", numFmt: "$#,##0" },
      series: [
        {
          name: "Revenue",
          categories: "Sales!$A$2:$A$7",
          values: "Sales!$B$2:$B$7",
          fill: "4472C4",
          // Series-level override: also show category name.
          dataLabels: {
            showVal: true,
            showCatName: true,
            position: "outEnd",
            numFmt: "$#,##0",
            separator: " • ",
            entries: [
              // Per-entry override: point 3 hides its label entirely.
              { index: 3, delete: true },
              // Per-entry override: point 5 uses a custom rich text
              // and moves inside the bar.
              {
                index: 5,
                text: {
                  paragraphs: [
                    {
                      runs: [
                        {
                          text: "🏆 JUN MAX",
                          properties: { bold: true, color: { srgb: "FFFFFF" }, size: 1100 }
                        }
                      ]
                    }
                  ]
                },
                position: "inEnd"
              }
            ]
          }
        }
      ]
    },
    "A119:L138"
  );

  // --- 33.7 Many charts on one sheet — 12 small tile charts packed
  //     in a 3×4 grid to test the per-drawing anchor handling and
  //     that drawing1.xml doesn't buckle under dozens of entries.
  const manyCharts = Workbook.addWorksheet(wb, "33-Many Charts");
  Cell.setValue(manyCharts, "A1", "12 small charts on one sheet");
  Cell.setStyle(manyCharts, "A1", { font: { bold: true } });
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      const tileIndex = r * 3 + c + 1;
      const startCol = 1 + c * 6;
      const startRow = 3 + r * 18;
      const range = `${cellAddr(startCol, startRow)}:${cellAddr(startCol + 5, startRow + 16)}`;
      Chart.add(
        manyCharts,
        {
          type: "line",
          title: `Tile ${tileIndex}`,
          series: [
            {
              name: "Revenue",
              categories: "Sales!$A$2:$A$7",
              values: "Sales!$B$2:$B$7",
              line: HEX_PALETTE[tileIndex % HEX_PALETTE.length],
              marker: { symbol: "circle", size: 4 }
            }
          ],
          showLegend: false
        },
        range
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 34. Preview export — each chart → SVG, PNG, and a multi-page PDF.
  // ---------------------------------------------------------------------------

  console.log("Rendering previews …");
  const previewWorksheets = [gallery, combo, ex, features, advanced];
  let previewCounter = 0;
  const pdfDoc = new Pdf.Builder();
  pdfDoc.setMetadata({ title: "Documonster chart previews", author: "charts example" });
  for (const ws of previewWorksheets) {
    for (const chart of Chart.get(ws)) {
      previewCounter += 1;
      const title = Chart.title(chart) ?? `chart-${previewCounter}`;
      const safe = title.replace(/[^\w\- ]+/g, "_").slice(0, 60);
      const svg = Chart.toSVG(chart, { width: 640, height: 400 });
      writeFileSync(resolve(OUT_DIR, `charts-example-${previewCounter}-${safe}.svg`), svg, "utf-8");
      const png = await Chart.toPNG(chart, { width: 640, height: 400, scale: 2 });
      writeFileSync(resolve(OUT_DIR, `charts-example-${previewCounter}-${safe}.png`), png);

      // Add a page to the combined PDF. Pick the renderer that matches
      // the chart flavour — classic charts go vector via `drawChartPdf`,
      // ChartEx via `drawChartExPdf`.
      const page = pdfDoc.addPage({ width: 700, height: 500 });
      const classic = Chart.chartModel(chart);
      const chartEx = Chart.chartExModel(chart);
      if (classic) {
        drawChartPdf(page, classic, { x: 30, y: 60, width: 640, height: 400 });
      } else if (chartEx) {
        drawChartExPdf(page, chartEx, { x: 30, y: 60, width: 640, height: 400 });
      }
    }
  }
  const pdfBytes = await pdfDoc.build();
  writeFileSync(PDF_PATH, pdfBytes);

  // Single-chart PDF via the high-level `chartToPdf` helper — the
  // canonical entry point from the `documonster/pdf` bundle.
  const firstChart = Chart.get(gallery)[0];
  const solo = await chartToPdf(firstChart, {
    title: "Solo chart PDF",
    width: 600,
    height: 400
  });
  writeFileSync(resolve(OUT_DIR, "charts-example-solo.pdf"), solo);

  // ---------------------------------------------------------------------------
  // 35. Load + mutate — `chart.mutate(fn, { preferRawPatch })` round-trip.
  //
  // We first write the workbook to `tmp/excel-examples/charts-example.xlsx`, then load
  // it back and make a narrow, template-safe edit using the raw-patch
  // path (stays byte-preserving for the rest of the chart XML).
  // ---------------------------------------------------------------------------

  await Workbook.writeFile(wb, XLSX_PATH);

  const reread = Workbook.create();
  await Workbook.readFile(reread, XLSX_PATH);
  const firstSheet = Workbook.getWorksheet(reread, "1-Classic Gallery")!;
  if (!firstSheet) {
    throw new Error("Expected to read back the gallery worksheet.");
  }
  const first = Chart.get(firstSheet)[0];
  if (first && Chart.chartModel(first)) {
    Chart.mutate(
      first,
      model => {
        // Flip the first bar chart's title to something new. The mutate
        // call is tagged with `preferRawPatch`, so when the chart XML
        // already exists on disk the writer patches only the changed
        // element and leaves every other byte untouched. With
        // `requireRawPatch: true` the call would throw if the edit
        // can't be performed without a full structural rebuild.
        if (model.chart.title) {
          model.chart.title.text = {
            paragraphs: [{ runs: [{ text: "Rewritten on reload" }] }]
          };
        }
      },
      { preferRawPatch: true }
    );
  }
  await Workbook.writeFile(reread, XLSX_PATH);

  // ---------------------------------------------------------------------------
  // Done — summarise counts and paths.
  // ---------------------------------------------------------------------------

  const chartCount = Workbook.getWorksheets(wb).reduce(
    (total, ws) => total + Chart.get(ws).length,
    0
  );
  const chartsheetCount = Workbook.getChartsheets(wb).length;

  console.log("");
  console.log(`XLSX  : ${XLSX_PATH}`);
  console.log(`PDF   : ${PDF_PATH}`);
  console.log(`SVGs  : ${OUT_DIR}/charts-example-*.svg`);
  console.log(`PNGs  : ${OUT_DIR}/charts-example-*.png`);
  console.log("");
  console.log(`Worksheets with charts: ${Workbook.getWorksheets(wb).length}`);
  console.log(`Charts embedded:       ${chartCount}`);
  console.log(`Chartsheets:           ${chartsheetCount}`);
  console.log(`Preset classic count:  ${EXCEL_CHART_PRESETS.length}`);
  console.log(`Preset chartEx count:  ${EXCEL_CHART_EX_PRESETS.length}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a single-colour PNG to exercise the picture-fill pipeline.
 *
 * This used to hand-roll the whole container — IHDR/IDAT/IEND framing, a CRC-32
 * table, an Adler-32 and *uncompressed* "stored" DEFLATE blocks — because there
 * was no encoder to call. There is one now, so the example uses it: the output
 * is properly compressed, and the example stops being a fourth copy of PNG
 * framing that nobody would remember to keep in step.
 */
function makeSolidColorPng(width: number, height: number, rgb: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (rgb >> 16) & 0xff;
    rgba[i * 4 + 1] = (rgb >> 8) & 0xff;
    rgba[i * 4 + 2] = rgb & 0xff;
    rgba[i * 4 + 3] = 0xff;
  }
  return encodePng(rgba, width, height);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
