# Excel Module

[中文](README_zh.md)

Modern TypeScript Excel Workbook Manager — read, manipulate, and write XLSX and JSON spreadsheets with zero runtime dependencies.

## Features

- **Create, read, and modify XLSX files** — full Open XML support
- **Multiple worksheet support** — add, remove, reorder, copy
- **Cell styling** — fonts, colors, borders, fills, alignment, number formats
- **Cell merging and formatting** — merge ranges, rich text, hyperlinks
- **Row and column properties** — width, height, hidden, outline level, auto-fit; nested column-key paths (`"address.city"`) when adding rows by object
- **Freeze panes and split views** — freeze rows/columns, split at position
- **Rich text support** — multiple fonts/styles within a single cell
- **Formulas and calculated values** — shared formulas, defined names
- **Data validation** — list, whole, decimal, date, textLength, custom
- **Conditional formatting** — cell value, color scale, data bar, icon set
- **Images** — JPEG, PNG, GIF with one-cell and two-cell anchors; embedded or external (linked) via URL/file path; SVG with raster fallback
- **Shapes** — rectangles, ellipses, lines, text boxes with fill/outline/text
- **Hyperlinks** — internal, external, email
- **Pivot tables** — read and preserve pivot table definitions
- **Charts** — create/read/edit classic charts, ChartEx modern charts, combo charts, pivot charts, chartsheets, and zero-dependency SVG/PNG/PDF previews (deterministic, not Excel-pixel-perfect — see [Rendering scope](#rendering-scope))
- **Tables** — auto-filters, totals row, structured references
- **Comments and notes** — threaded comments, legacy notes
- **Checkboxes** — form controls and cell-level checkboxes
- **Page setup** — print area, print titles, header/footer, page breaks
- **Data protection** — sheet protection with password (SHA-512)
- **Streaming** — `WorkbookReader` and `WorkbookWriter` for large files
- **CSV import/export** — `readCsv`, `writeCsv`, `readCsvFile`, `writeCsvFile`
- **Markdown import/export** — `readMarkdown`, `writeMarkdown`, `readMarkdownFile`, `writeMarkdownFile`
- **PDF export** — `Pdf.fromExcel()` with full styling, pagination, fonts, encryption
- **Browser support** — `xlsx.load()`, `xlsx.writeBuffer()`, no polyfills needed

## Quick Start

### Creating a Workbook

```typescript
import { Workbook, Worksheet } from "documonster/excel";

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "My Sheet");

// Add data
Worksheet.addRow(sheet, ["Name", "Age", "Email"]);
Worksheet.addRow(sheet, ["John Doe", 30, "john@example.com"]);
Worksheet.addRow(sheet, ["Jane Smith", 25, "jane@example.com"]);

// Node.js: write to file
await Workbook.writeFile(workbook, "output.xlsx");

// Browser: write to buffer
const buffer = await Workbook.toBuffer(workbook);
```

#### Adding rows by object (with nested keys)

When columns have keys, rows can be added from objects. Keys may use dotted
paths to pull values from nested objects:

```typescript
Worksheet.setColumns(sheet, [
  { header: "Name", key: "name", width: 20 },
  { header: "City", key: "address.city", width: 20 }
]);
Worksheet.addRow(sheet, { name: "Alice", address: { city: "Sydney" } });
```

### Reading a Workbook

```typescript
import { Workbook, Worksheet, Row } from "documonster/excel";

const workbook = Workbook.create();

// Node.js: read from file
await Workbook.readFile(workbook, "input.xlsx");

// Browser: read from ArrayBuffer
await Workbook.read(workbook, arrayBuffer);

const worksheet = Workbook.getWorksheet(workbook, 1);
Worksheet.eachRow(worksheet, (row, rowNumber) => {
  console.log("Row " + rowNumber + " = " + JSON.stringify(Row.values(worksheet, rowNumber)));
});
```

### Reading a Range

`Range.getValues` reads a rectangular block as a row-major matrix:

```typescript
import { Range } from "documonster/excel";

const values = Range.getValues(worksheet, "G7:H19");
// values.length === 13, values[0].length === 2
// values[r][c] is the cell at row 7 + r, column G + c
```

The result is always exactly as tall and wide as the range — blank rows and cells
keep their position and read as `null`, so indices line up with the request no
matter how sparse the sheet is. Reading never creates cells, so it leaves the
worksheet untouched.

Values carry the same semantics as `Cell.getValue`: formula cells yield a
`{ formula, result }` record, dates yield `Date`, and every cell of a merged
region yields the master cell's value.

A `Range.Handle` works in place of the A1 string, so geometry composes with
reads:

```typescript
Range.getValues(worksheet, Range.create(7, 7, 19, 8)); // same as "G7:H19"
```

Whole-column (`"A:A"`) and whole-row (`"1:5"`) references are rejected — they
have no bounds to read, as is an unset range. To read the whole sheet, either
pass `Worksheet.dimensions(worksheet)` (which is unset, and so rejected, on a
sheet with no cells) or use `Worksheet.getValues(worksheet)` — note that one is
indexed by row _number_, so `result[1]` is row 1 and `result[0]` is empty.

### Styling Cells

```typescript
import { Cell } from "documonster/excel";

Cell.setValue(worksheet, "A1", "Hello");
Cell.setFont(worksheet, "A1", {
  name: "Arial",
  size: 16,
  bold: true,
  color: { argb: "FFFF0000" }
});
Cell.setFill(worksheet, "A1", {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFFF00" }
});
Cell.setBorder(worksheet, "A1", {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" }
});
Cell.setAlignment(worksheet, "A1", { vertical: "middle", horizontal: "center", wrapText: true });
Cell.setNumFmt(worksheet, "A1", "$#,##0.00");
```

### Number Formats

```typescript
import { Cell } from "documonster/excel";

// Currency
Cell.setNumFmt(worksheet, "A1", "$#,##0.00");

// Percentage
Cell.setNumFmt(worksheet, "A1", "0.00%");

// Date
Cell.setNumFmt(worksheet, "A1", "yyyy-mm-dd");

// Custom
Cell.setNumFmt(worksheet, "A1", '#,##0.00 "units"');
```

### Rich Text

```typescript
Cell.setValue(worksheet, "A1", {
  richText: [
    { text: "Bold ", font: { bold: true } },
    { text: "and ", font: {} },
    { text: "Red", font: { color: { argb: "FFFF0000" } } }
  ]
});
```

### Formulas

```typescript
Cell.setValue(worksheet, "A1", { formula: "SUM(A1:A10)" });
Cell.setValue(worksheet, "A1", { formula: "A1+B1", result: 42 }); // with cached result

// Shared formulas
Cell.setValue(sheet, "A1", { formula: "B1*2", shareType: "shared", ref: "A1:A10" });

// Defined names
DefinedNames.add(Workbook.getDefinedNames(workbook), "Sheet1!$A$1:$B$10", "MyRange");
```

Setting a formula stores it; it does not evaluate it. To compute results,
import the calculation engine from the `documonster/excel/formula` subpath
(kept separate so the ~200 KB engine stays out of bundles that only read and
write XLSX — there is no install or registration step):

```typescript
import { Workbook, Cell } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";

Cell.setValue(worksheet, "A4", { formula: "SUM(A1:A3)" });
calculateFormulas(workbook); // results written back in place
console.log(Cell.getResult(worksheet, "A4"));
```

See the [formula module docs](../formula/README.md) for the 448 supported
functions and for driving the engine against a non-excel host.

### Data Validation

```typescript
Cell.setValidation(worksheet, "A1", {
  type: "list",
  allowBlank: true,
  formulae: ['"Option1,Option2,Option3"']
});

Cell.setValidation(worksheet, "B1", {
  type: "whole",
  operator: "between",
  formulae: [1, 100],
  showErrorMessage: true,
  errorTitle: "Invalid",
  error: "Enter a number between 1 and 100"
});
```

### Conditional Formatting

```typescript
Worksheet.addConditionalFormatting(worksheet, {
  ref: "A1:A100",
  rules: [
    {
      type: "cellIs",
      operator: "greaterThan",
      formulae: [90],
      style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF00FF00" } } },
      priority: 1
    }
  ]
});
```

### Images

```typescript
import { Image } from "documonster/excel";
import { readFileSync } from "fs";

const imageId = Image.add(workbook, {
  buffer: readFileSync("logo.png"),
  extension: "png"
});

Image.place(worksheet, imageId, {
  tl: { col: 0, row: 0 },
  br: { col: 3, row: 5 }
});
```

#### Embedded vs. external (linked) images

`Image.add` registers an image one of two ways:

- **Embedded** — pass `buffer`, `base64`, or `filename`. The bytes are written
  into the `.xlsx` package (`xl/media/imageN.ext`). Self-contained, but the file
  grows with every image.
- **Linked (external)** — pass only `link` (a URL or local file path). No bytes
  are stored; the package keeps a relationship with `TargetMode="External"` and
  the picture is rendered via `<a:blip r:link>`. The file stays small and the
  image is resolved by Excel when the workbook is opened.

If both bytes and a `link` are provided, **embedding wins**.

```typescript
// Linked picture from a URL — nothing is written to xl/media/.
const urlId = Image.add(workbook, { extension: "png", link: "https://example.com/logo.png" });
Image.place(worksheet, urlId, "B2:D6");

// Linked picture from a local file path (resolved by Excel on open).
const fileId = Image.add(workbook, { extension: "png", link: "file:///C:/images/logo.png" });
Image.place(worksheet, fileId, "F2:H6");
```

Linked images also work as overlay watermarks:

```typescript
const wmId = Image.add(workbook, { extension: "png", link: "https://example.com/draft.png" });
Watermark.add(worksheet, { imageId: wmId, mode: "overlay", opacity: 0.15 });
```

**Caveats** (inherent to Excel, not this library):

- Linked images are volatile — if the target moves or the workbook is shared,
  Excel shows a broken-image placeholder. Use embedding for self-contained files.
- Modern Excel may refuse to auto-load remote URLs for security reasons.
- Only **cell pictures** and **overlay watermarks** may be linked. Worksheet
  **background** images (`Image.setBackground`) and **header/footer (VML)**
  watermarks (`Watermark.add(worksheet, { mode: "header" })`) **cannot** be linked — they
  throw an `ImageError` if given a linked image (Excel drops such backgrounds on
  open). Use an embedded image for those.

See the runnable [`images-external.ts`](examples/images-external.ts) example.

#### SVG images (with raster fallback)

Excel renders SVG pictures via a raster `a:blip` plus an `asvg:svgBlip`
extension. This library does **not** rasterize — you supply both the SVG bytes
and the raster fallback (typically a PNG) you want embedded. Modern Excel shows
the crisp SVG; older versions and non-SVG consumers show the raster fallback.

```typescript
const id = Image.add(workbook, {
  buffer: pngFallbackBytes, // raster fallback — required
  extension: "png",
  svg: { buffer: svgBytes } // vector data shown by Excel 2016+
});
Image.place(worksheet, id, "B2:D6");
```

### Shapes

Add free-form drawing shapes (rectangles, ellipses, lines, text boxes, …)
anchored to a cell range. Shapes need no media file — geometry, fill, outline
and an optional text label are written straight into the drawing part.

```typescript
Image.addShape(worksheet, {
  type: "rect", // rect | roundRect | ellipse | triangle | line | …
  range: "B2:D5", // a cell range or { tl, br } anchors
  fillColor: "FFD966", // hex RGB (omit for no fill)
  lineColor: "000000",
  lineWidth: 1, // points
  text: "Important"
});

Image.addShape(worksheet, { type: "ellipse", range: "F2:H5", fillColor: "9DC3E6" });
Image.addShape(worksheet, {
  type: "line",
  range: { tl: "B7", br: "E7" },
  lineColor: "FF0000",
  lineWidth: 2
});
```

Shapes are write-only (not parsed back on read), consistent with other
non-chart drawing content.

### Tables

```typescript
Table.add(worksheet, {
  name: "SalesTable",
  ref: "A1",
  headerRow: true,
  totalsRow: true,
  columns: [
    { name: "Product", totalsRowLabel: "Total", filterButton: true },
    { name: "Revenue", totalsRowFunction: "sum", filterButton: true }
  ],
  rows: [
    ["Widget", 1000],
    ["Gadget", 2500]
  ]
});
```

### Merge Cells

```typescript
Worksheet.merge(worksheet, "A1:D1");
Cell.setValue(worksheet, "A1", "Merged Header");
Cell.setAlignment(worksheet, "A1", { horizontal: "center" });
```

### Freeze Panes

```typescript
// Freeze first row
worksheet.views = [{ state: "frozen", ySplit: 1 }];

// Freeze first column
worksheet.views = [{ state: "frozen", xSplit: 1 }];

// Freeze both
worksheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
```

### Page Setup

```typescript
worksheet.pageSetup = {
  paperSize: 9, // A4
  orientation: "landscape",
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 0,
  margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75 }
};

// Print area
worksheet.pageSetup.printArea = "A1:G20";

// Print titles (repeat rows 1-2 on every page)
worksheet.pageSetup.printTitlesRow = "1:2";
```

### Sheet Protection

```typescript
await Worksheet.protect(worksheet, "password123", {
  selectLockedCells: true,
  selectUnlockedCells: true,
  formatCells: false,
  insertRows: false,
  deleteRows: false,
  sort: true,
  autoFilter: true
});
```

### Comments

```typescript
Cell.setNote(worksheet, "A1", "Simple comment");

Cell.setNote(worksheet, "B1", {
  texts: [{ text: "Author: ", font: { bold: true } }, { text: "This is a rich text comment" }]
});

// Configure the comment box size (points). Defaults to 97.8 × 59.1pt.
Cell.setNote(worksheet, "C1", {
  texts: [{ text: "A roomier note" }],
  width: 200,
  height: 120
});
```

### Auto-Fit Column Width

```typescript
Worksheet.autoFitColumns(worksheet);
```

## Charts

Documonster includes a structured chart API, raw XML preservation for templates, and deterministic preview renderers. It is designed to cover the open-source gap left by libraries that only preserve chart XML or only write worksheet data.

> **Setup:** No install or registration step is required. The chart APIs
> (`Chart.add`, the per-type shortcuts, chart load/write, etc.) pull the chart
> implementation directly and statically. A consumer that never references any
> chart API gets the entire chart implementation tree-shaken out of the bundle.

> A runnable end-to-end example is at [`src/modules/excel/examples/charts.ts`](examples/charts.ts) — it creates 70+ charts covering every classic + ChartEx type, all preset families, combo / pivot / chartsheet layouts, and exports SVG / PNG / PDF previews. Run with `pnpm exec tsx src/modules/excel/examples/charts.ts`.

### Rendering scope

The built-in `Chart.toSVG(chart)` / `Chart.toPNG(chart)` / `Pdf.fromChart(chart)` helpers produce a **zero-dependency deterministic preview** — not an Excel-pixel-perfect compositor. Classic charts are driven by a `ChartScene` intermediate representation shared across SVG, PNG, and PDF; ChartEx charts use dedicated geometry collectors that keep the SVG and vector-PDF paths equivalent by construction. The preview is well-suited to:

- Server-side thumbnails, email attachments, and README images
- CI sanity checks ("does this chart render without crashing")
- Quick dashboard previews before the user opens Excel

It is **not** a replacement for Excel / LibreOffice rendering when pixel-identical output matters. Specific scope boundaries:

- Excel-internal text layout heuristics, font hinting, and kerning are approximated, not reproduced
- 3D rendering is limited to `bar3D` axonometric projection; other 3D variants fall back to 2D (see the 3D note below)
- DrawingML effect filters (shadow / glow / soft-edge / blur / reflection) emit as SVG `<filter>` but are silently dropped by the Node PNG rasteriser
- Pivot chart field buttons and drop-zone UI are metadata-only — the host application still draws them

**For production-grade rendering**, round-trip the `.xlsx` through headless LibreOffice (`soffice --convert-to pdf`). The byte-preserving round-trip + `templateMode: "strict"` guarantees in this library make that a safe handoff.

### Classic Chart

```typescript
const ws = Workbook.addWorksheet(workbook, "Sales");
Worksheet.addRows(ws, [
  ["Month", "Revenue", "Profit"],
  ["Jan", 120, 32],
  ["Feb", 180, 49],
  ["Mar", 160, 41]
]);

Chart.add(
  ws,
  {
    type: "bar",
    barDir: "col",
    grouping: "clustered",
    title: "Revenue",
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$4",
        values: "Sales!$B$2:$B$4",
        dataLabels: { showVal: true },
        trendline: { type: "linear", lineDash: "dash" },
        errorBars: { type: "fixedVal", value: 5 }
      }
    ],
    categoryAxis: { title: "Month" },
    valueAxis: { title: "USD", min: 0 }
  },
  "E1:M16"
);
```

### Presets And Convenience APIs

```typescript
import {
  EXCEL_CHART_PRESETS,
  EXCEL_CHART_EX_PRESETS,
  applyChartPreset,
  applyChartExPreset
} from "documonster/chart";

// 99 classic presets + 10 ChartEx presets (Excel UI aliases)
Chart.addPreset(ws, "col3DConeStacked100", { series: [{ values: "Sales!$B$2:$B$4" }] }, "E1:M16");
Chart.addPresetEx(ws, "boxAndWhisker", { series: [{ values: "Samples!$A$2:$A$50" }] }, "N1:V16");

// Per-type shortcut methods — the `type` field is implied.
Chart.addColumn(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "E18:M32");
Chart.addBar(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "E34:M48");
Chart.addLine(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "E50:M64");
Chart.addArea(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "E66:M80");
Chart.addPie(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "P1:X16");
Chart.addDoughnut(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "P18:X32");
Chart.addScatter(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "P34:X48");
Chart.addBubble(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "P50:X64");
Chart.addRadar(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "P66:X80");
Chart.addStock(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AA1:AI16");
Chart.addSurface(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AA18:AI32");
// ChartEx shortcuts
Chart.addHistogram(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AA34:AI48");
Chart.addPareto(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AA50:AI64");
Chart.addWaterfall(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AA66:AI80");
Chart.addFunnel(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AK1:AS16");
Chart.addTreemap(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AK18:AS32");
Chart.addSunburst(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AK34:AS48");
Chart.addBoxWhisker(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AK50:AS64");
Chart.addRegionMap(ws, { series: [{ values: "Sales!$B$2:$B$4" }] }, "AK66:AS80");

console.log(EXCEL_CHART_PRESETS.length, EXCEL_CHART_EX_PRESETS.length); // 99, 10
```

Build chart option bags from data-frame-style inputs:

```typescript
// Object-array → chart: stages the rows into the worksheet and returns
// the chart number.
Chart.addFromRows(
  ws,
  [
    { day: "Mon", visits: 312 },
    { day: "Tue", visits: 400 },
    { day: "Wed", visits: 280 }
  ],
  { type: "bar", barDir: "col", x: "day", y: "visits", startCell: "A1" },
  "C1:K16"
);

// Column-shortcut — same as above with `type: "bar", barDir: "col"` implied.
Chart.addColumnFromRows(ws, rows, { x: "quarter", y: "revenue", startCell: "A1" }, "C1:K16");

// Excel Table → chart. Series references are structured (`Table1[Col]`)
// so the chart expands automatically when the table grows.
const table = Table.add(ws, {
  name: "Kpi",
  ref: "A1",
  headerRow: true,
  columns: [{ name: "Month" }, { name: "Revenue" }, { name: "Profit" }],
  rows: [["Jan", 1000, 250]]
});
Chart.addFromTable(
  ws,
  table,
  { type: "bar", barDir: "col", categoryColumn: "Month", valueColumns: ["Revenue", "Profit"] },
  "F1:N18"
);

// ChartEx helpers have the same shape.
Chart.addExFromRows(ws, rows, { type: "histogram", x: "bucket", y: "count" }, "AA1:AI18");
Chart.addExFromTable(
  ws,
  table,
  { type: "funnel", categoryColumn: "Stage", valueColumns: ["Users"] },
  "AA20:AI40"
);

// Low-level range helper — emits a series with absolute refs, matching
// what the builders produce internally.
const s = Chart.seriesFromColumns(ws, {
  categories: "Sales!$A$2:$A$7",
  values: "Sales!$B$2:$B$7",
  name: "Revenue"
});
Chart.add(ws, { type: "line", series: [s] }, "A20:I35");
```

### Combo, ChartEx, Pivot Chart, And Chartsheet

```typescript
Chart.addCombo(
  ws,
  {
    groups: [
      {
        type: "bar",
        barDir: "col",
        series: [{ name: "Revenue", categories: "Sales!$A$2:$A$4", values: "Sales!$B$2:$B$4" }]
      },
      {
        type: "line",
        useSecondaryAxis: true,
        series: [{ name: "Profit", categories: "Sales!$A$2:$A$4", values: "Sales!$C$2:$C$4" }]
      }
    ],
    title: "Revenue vs Profit",
    dataTable: { showKeys: true, showHorzBorder: true, showVertBorder: true }
  },
  "N1:V16"
);

// ChartEx — Office 2016+ modern types (histogram/pareto/waterfall/funnel/
// treemap/sunburst/boxWhisker/regionMap). Each type has a dedicated
// shortcut; for full control pass `AddChartExOptions` to `addChartEx`.
Chart.addHistogram(
  ws,
  { series: [{ name: "Distribution", values: "Sales!$B$2:$B$4" }], binning: { binType: "auto" } },
  "N18:V32"
);
Chart.addWaterfall(
  ws,
  {
    title: "Revenue waterfall",
    categories: "Sales!$A$2:$A$7",
    series: [{ name: "Delta", values: "Sales!$C$2:$C$7", subtotals: [0, 5] }],
    layout: { connectorLines: true }
  },
  "N34:V48"
);
Chart.addTreemap(
  ws,
  {
    categories: "Hier!$C$2:$C$10",
    series: [
      {
        name: "Sales",
        values: "Hier!$D$2:$D$10",
        hierarchy: ["Hier!$A$2:$A$10", "Hier!$B$2:$B$10"]
      }
    ],
    layout: { parentLabelLayout: "banner" }
  },
  "N50:V64"
);

// Pivot chart — same options as a classic chart plus the link back to
// the pivot table; `pivotChartOptions` controls drop-zone visibility,
// refresh-on-open, and the Office 2014 expand/collapse field buttons.
const pivot = Pivot.add(ws, { sourceTable: src, rows: ["Region"], values: ["Revenue"] });
Chart.addPivot(
  ws,
  pivot,
  {
    type: "bar",
    barDir: "col",
    series: [{ name: "Revenue", categories: "Src!$A$2:$A$9", values: "Src!$D$2:$D$9" }],
    pivotChartOptions: {
      dropZonesVisible: true,
      dropZoneFilter: true,
      dropZoneCategories: true,
      dropZoneData: true,
      refreshOnOpen: true,
      showExpandCollapseFieldButtons: true
    }
  },
  "F1:N20"
);
Chart.addPivotCombo(ws, pivot, { groups: [] }, "F22:N40");

// Chartsheet — a full-page chart on its own tab. Works with any of
// `AddChartOptions`, `AddComboChartOptions`, or `AddChartExOptions`.
Workbook.addChartsheet(workbook, "Revenue Chart", {
  tabSelected: true,
  zoomToFit: true,
  chart: { type: "bar", series: [{ values: "Sales!$B$2:$B$4" }] }
});

Workbook.addPivotChartsheet(workbook, "Pivot Dashboard", pivot, {
  chart: { type: "line", showMarker: true, series: [{ values: "Sales!$B$2:$B$4" }] }
});
```

### Anchor Forms

```typescript
// String A1 range (two-cell anchor, the most common form).
Chart.add(ws, { type: "bar", series: [{ values: "Sales!$B$2:$B$4" }] }, "A1:H15");

// Two-cell anchor with row/col coordinates.
Chart.add(ws, options, { tl: { col: 1, row: 2 }, br: { col: 8, row: 17 } });

// One-cell anchor — pinned to a cell with a fixed EMU extent (5×3 in).
// 914400 EMU = 1 inch.
Chart.add(ws, options, {
  tl: { col: 1, row: 19 },
  ext: { cx: 5 * 914400, cy: 3 * 914400 },
  editAs: "oneCell"
});

// Absolute anchor — fixed EMU position + size, ignores rows/columns.
Chart.add(ws, options, {
  pos: { x: 914400, y: 36 * 914400 },
  ext: { cx: 5 * 914400, cy: 3 * 914400 },
  editAs: "absolute"
});
```

### Advanced Series Formatting

```typescript
Chart.add(
  ws,
  {
    type: "line",
    title: {
      paragraphs: [
        { runs: [{ text: "Q2 ", properties: { bold: true, size: 1600 } }, { text: "Performance" }] }
      ]
    },
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        line: "4472C4",
        lineWidth: 2.5,
        lineDash: "solid",
        marker: { symbol: "circle", size: 8, fill: "4472C4", border: "FFFFFF" },
        trendline: {
          type: "linear",
          displayEq: true,
          displayRSqr: true,
          forward: 1,
          line: "ED7D31",
          lineDash: "dash"
        },
        errorBars: {
          direction: "y",
          barDir: "both",
          type: "percentage",
          value: 10
        },
        dataLabels: { showVal: true, position: "t", numFmt: "$#,##0" },
        // Per-point overrides
        dataPoints: [
          { index: 0, fill: "C00000" },
          { index: 5, fill: "70AD47", marker: { symbol: "diamond", size: 10 } }
        ]
      }
    ],
    categoryAxis: { title: "Month", textRotation: -45 },
    valueAxis: {
      title: "Revenue",
      numFmt: "$#,##0",
      min: 0,
      logBase: 10,
      majorGridlines: true,
      displayUnits: "thousands",
      displayUnitsLabel: "× 1 000"
    },
    legendOptions: {
      entries: [{ index: 1, hidden: true }],
      txPr: { size: 900, color: { srgb: "595959" } }
    },
    plotAreaOptions: { spPr: { fill: "FAFAFA", border: "D9D9D9" } }
  },
  "A1:L20"
);

// Picture-fill (bars filled with an image). Accepts raw Uint8Array,
// a `data:` URL, a bare base64 string, a `{ workbookImageId }` handle,
// or a structured `ChartPictureFillImageData`.
Chart.add(
  ws,
  {
    type: "bar",
    barDir: "col",
    series: [
      {
        name: "Revenue",
        categories: "Sales!$A$2:$A$7",
        values: "Sales!$B$2:$B$7",
        pictureFill: { image: pngBytes, fillMode: "stretch" }
      }
    ]
  },
  "N1:V16"
);
```

### Chart Styling

```typescript
// Legacy 2007/2010 built-in style (1..48). Emits `<c:style val="N"/>`.
Chart.setStyle(chart, 42);
Chart.setBuiltInStyle(chart, 42); // alias for the built-in style index

// Modern Office 2013+ sidecar — full styleN.xml + colorsN.xml. Applied
// via `addChart` options or copied in later via the chart entry.
Chart.add(
  ws,
  {
    type: "bar",
    series: [{ values: "Sales!$B$2:$B$4" }],
    chartStyle: {
      id: 201,
      elements: {
        chartArea: { fillRefIdx: 1, lnRefIdx: 1, effectRefIdx: 0, fontRefIdx: "minor" },
        title: { fontRefIdx: "major" }
      }
    },
    chartColors: {
      method: "cycle",
      id: 10,
      colors: [{ srgb: "4472C4" }, { srgb: "ED7D31" }, { srgb: "A5A5A5" }]
    }
  },
  "A1:H15"
);
```

### Preview Export

```typescript
import { Chart } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const chart = Chart.get(ws)[0];

// SVG / PNG previews — Promise for PNG because the Node rasteriser is async.
const svg = Chart.toSVG(chart, { width: 800, height: 450, backgroundColor: "transparent" });
const png = await Chart.toPNG(chart, { width: 800, height: 450, scale: 2, dpi: 192 });

// Standalone one-page PDF — classic charts render as vector content
// (selectable text, resolution-independent shapes); ChartEx types render
// as vector too when supported, or raster via `forceRaster: true`.
const pdf = await Pdf.fromChart(chart, {
  title: "Revenue",
  width: 640,
  height: 400,
  margin: 36
});

// Inspect the vector-vs-raster decision explicitly:
import { canRenderChartExAsVectorPdf } from "documonster/chart";
const chartExModel = Chart.chartExModel(chart);
if (chartExModel) {
  console.log(canRenderChartExAsVectorPdf(chartExModel));
}
```

Preview rendering is intentionally deterministic and dependency-free. Browser PNG export uses canvas. Node.js PNG export uses the built-in basic rasterizer. It draws core chart geometry, axes, secondary axes, axis titles, legends, labels, markers, trendlines, and error bars for thumbnails, tests, and server-side previews; it is not an Excel-pixel-perfect renderer or an Excel-identical layout engine. ChartEx `regionMap` previews use a small built-in country centroid table plus projection math for known regions and a deterministic tile fallback for unknown labels; they are geographic previews, not a GIS/map-boundary renderer.

### Template Preservation

Loaded chart XML is preserved byte-for-byte when not modified. For safe high-level mutations, Documonster patches only known XML blocks and keeps unsupported extensions intact:

- classic charts: title, legend, series references, series formatting, markers, data points, data labels, trendlines, error bars, axes, plot layout
- ChartEx charts: chart data, title, legend, auto-title deletion, chart/plot shapes, plot-region layout, series visibility/name/axis bindings, series data references, layout properties (including `extLst` passthrough), data labels, data points, and axes
- unsafe structural mutations fall back to structured re-rendering

Use `Chart.mutate(chart, model => { ... }, { preferRawPatch: true })` when you want local XML patching after editing a loaded template chart.

For strict template workflows, use `requireRawPatch: true` to fail instead of falling back to structured re-rendering when a mutation cannot be safely patched:

```typescript
Chart.mutate(
  chart,
  model => {
    model.chart.plotArea.chartTypes[0].series[0].val = {
      numRef: { formula: "Sales!$B$2:$B$100", cache: { points: [] } }
    };
  },
  { preferRawPatch: true, requireRawPatch: true }
);
```

This gives a hard guarantee of "preserve the raw template XML or throw" for supported patch classes. It does not claim arbitrary unknown OOXML can be mutated safely; unsupported structural edits are rejected when `requireRawPatch` is set.

You can also enforce that rule for every loaded chart/chartEx part during a write:

```typescript
await Workbook.toBuffer(workbook, { templateMode: "strict" });
// or
await Workbook.toBuffer(workbook, { strictTemplateMode: true });
```

Strict template mode affects edited chart parts loaded from an existing workbook. Newly created charts still render structurally.

### Oracle And Corpus Testing

The repository includes optional harnesses for real-application validation. They are disabled by default because they require external binaries or private fixture corpora.

Every generated workbook in these harnesses also runs an OOXML package audit before external conversion. The audit checks required part content types, relationship targets, duplicate relationship IDs, chart/ChartEx/drawing/chartsheet structure, ChartEx data/axis references, and ChartEx external-data relationship IDs so common Excel "repaired records" issues fail early in CI. When an enabled Office/LibreOffice open-validation command logs repair/corruption/error text, the test treats it as a hard validation failure.

```bash
# LibreOffice visual/PDF export oracle
DOCUMONSTER_LIBREOFFICE_VISUAL_ORACLE=1 LIBREOFFICE_BIN=/path/to/soffice \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# LibreOffice open/convert validation for generated workbooks
DOCUMONSTER_LIBREOFFICE_OPEN_VALIDATION=1 LIBREOFFICE_BIN=/path/to/soffice \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# Proprietary Office CLI validation hook. The command must accept
# {input} and {outDir} placeholders via DOCUMONSTER_OFFICE_OPEN_ARGS.
DOCUMONSTER_OFFICE_OPEN_VALIDATION=1 EXCEL_OFFICE_BIN=/path/to/validator \
DOCUMONSTER_OFFICE_OPEN_ARGS="--open {input} --outdir {outDir}" \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# Enterprise corpus round-trip harness
DOCUMONSTER_ENTERPRISE_CORPUS_DIR=/path/to/private/xlsx-corpus \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# Enterprise corpus plus LibreOffice open validation
DOCUMONSTER_ENTERPRISE_CORPUS_DIR=/path/to/private/xlsx-corpus \
DOCUMONSTER_CORPUS_LIBREOFFICE_OPEN_VALIDATION=1 LIBREOFFICE_BIN=/path/to/soffice \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts
```

An optional `manifest.json` in the corpus directory can mark expected structures:

```json
{
  "entries": [
    {
      "path": "charts/sales-dashboard.xlsx",
      "source": "Excel 365",
      "expectCharts": true,
      "expectChartEx": true,
      "openValidation": true
    },
    {
      "path": "pivot/pivot-chart.xlsx",
      "source": "Excel 365",
      "expectCharts": true,
      "expectPivotTables": true
    }
  ]
}
```

Excel and WPS can be wired into the same pattern by providing CI jobs that convert each generated workbook to PDF/images and compare against approved artifacts. Documonster itself stays zero-dependency and does not bundle proprietary renderers. The built-in audit is a structural gate, not a replacement for real Office visual/open-repair validation.

### Capability Matrix

#### High-level capability map

| Area                    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classic charts          | bar, bar3D, line, line3D, pie, pie3D, doughnut, area, area3D, scatter, bubble, radar, stock, surface, surface3D, ofPie (see 3D note)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ChartEx                 | sunburst, treemap, waterfall, funnel, histogram, pareto, boxWhisker, regionMap (see regionMap note)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Advanced chart features | combo charts, secondary axes, markers, data labels (`DataLabelPosition`, pie leader lines, bar/line collision avoidance), trendlines, error bars, manual plot layout (edge-mode), chartsheets, data table (`c:dTable` — rendered below plot area), user-shape overlays (`c:userShapes` byte-preserving + programmatic replacement; not rendered in SVG/PNG/PDF previews)                                                                                                                                                                                                                |
| Pivot charts            | classic pivot chart source metadata, field buttons/filter metadata, pivot chartsheets (metadata-only — see pivot chart note below)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Presets                 | 99 classic presets + 10 ChartEx presets — cone/cylinder/pyramid, scatter variants, stock, surface/contour, exploded pie/doughnut, histogram/pareto/waterfall/funnel/treemap/sunburst/boxWhisker/regionMap (via `EXCEL_CHART_PRESETS` / `EXCEL_CHART_EX_PRESETS`)                                                                                                                                                                                                                                                                                                                        |
| ChartEx helpers         | `chartExOptionsFromTable` / `chartExOptionsFromRows` (+ `Chart.addExFromTable/addExFromRows`) for sunburst/treemap/waterfall/funnel/histogram/pareto/boxWhisker                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Template fidelity       | byte-preserving round-trip, raw-XML patching for narrow edits, `templateMode: "strict"` to refuse silent loss, `Chart.unknownElements` surfacing `c15:` / `cx14:` vendor tags                                                                                                                                                                                                                                                                                                                                                                                                           |
| Rendering scope         | **zero-dependency deterministic preview** — not an Excel-identical compositor. Classic charts use a `ChartScene` IR for SVG, PNG, PDF; ChartEx uses dedicated geometry collectors for SVG and vector PDF. For pixel-perfect output, round-trip the `.xlsx` through `soffice --convert-to pdf`                                                                                                                                                                                                                                                                                           |
| Rendering features      | deterministic SVG, browser PNG, Node PNG fallback (honours text `rotate`), PDF drawing bridge (labels/markers/errorBars/trendlines/leader lines/data tables); text anchor+rotation+color+fontFamily (`bold`/`italic` from `txPr/a:latin`); radar/area/bubble true alpha via `PdfColor.a` → `/ExtGState`; bar3D true axonometric projection (`view3D.rotX` / `rotY` / `rAngAx`) with three shaded faces; text sized via `@excel/utils/text-metrics` (Calibri/Arial/Times/9 fonts + ~230 category factors). DrawingML effect filters emit as SVG `<filter>` but are not reproduced in PDF |
| Commercial-grade gaps   | Excel-perfect rendering, true 3D for line3D/pie3D/area3D/surface3D, arbitrary unknown XML mutation, and full real-file compatibility matrices require external oracle testing                                                                                                                                                                                                                                                                                                                                                                                                           |

#### Per-type capability grid

Rows are chart types. Columns mean:

- **Create** — programmatic `addChart` / `addChartEx` (structured API, no template needed)
- **Read** — parse an existing `chartN.xml` / `chartExN.xml` into a structured model
- **Edit** — `Chart.mutate(chart, fn, { preferRawPatch })` works for this type (raw-patch for narrow edits, structured rebuild for the rest)
- **Round-trip** — load → write → load yields an equivalent model + package audit passes
- **Raw preserve** — loaded bytes are preserved verbatim when the chart is not edited (and via raw-patch for narrow edits)
- **SVG** — content-asserting test (not just "does not throw"): text / path / colour / hash
- **PNG** — content-asserting test (IHDR / IDAT signature or value-level hash)
- **PDF** — type-specific PDF surface test beyond the generic `drawChartPdf` smoke
- **LibreOffice** — opt-in `chart-oracle` integration run opens the exported xlsx via LibreOffice without error

Legend: ✅ direct type-specific test · ⬛ exercised via generic / preset-scan loop (no value-level assert) · ➖ not implemented / not applicable

##### Classic charts

| Type      | Create | Read | Edit | Round-trip | Raw preserve | SVG | PNG | PDF | LibreOffice |
| --------- | :----: | :--: | :--: | :--------: | :----------: | :-: | :-: | :-: | :---------: |
| bar       |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ✅      |
| bar3D     |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| line      |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ⬛  |     ✅      |
| line3D    |   ✅   |  ✅  |  ✅  |     ⬛     |      ✅      | ⬛  | ⬛  | ⬛  |     ⬛      |
| pie       |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| pie3D     |   ✅   |  ✅  |  ✅  |     ⬛     |      ✅      | ⬛  | ⬛  | ⬛  |     ⬛      |
| doughnut  |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ⬛  |     ⬛      |
| area      |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| area3D    |   ✅   |  ✅  |  ✅  |     ⬛     |      ✅      | ⬛  | ⬛  | ⬛  |     ⬛      |
| scatter   |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ⬛  |     ⬛      |
| bubble    |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| radar     |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| stock     |   ✅   |  ✅  |  ✅  |     ⬛     |      ✅      | ✅  | ⬛  | ⬛  |     ⬛      |
| surface   |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ⬛  |     ⬛      |
| surface3D |   ✅   |  ✅  |  ✅  |     ⬛     |      ✅      | ⬛  | ⬛  | ⬛  |     ⬛      |
| ofPie     |   ✅   |  ✅  |  ✅  |     ⬛     |      ✅      | ✅  | ⬛  | ⬛  |     ⬛      |

##### ChartEx types

| Type       | Create | Read | Edit | Round-trip | Raw preserve | SVG | PNG | PDF | LibreOffice |
| ---------- | :----: | :--: | :--: | :--------: | :----------: | :-: | :-: | :-: | :---------: |
| sunburst   |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| treemap    |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ✅      |
| waterfall  |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| funnel     |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ✅      |
| histogram  |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| pareto     |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| boxWhisker |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |
| regionMap  |   ✅   |  ✅  |  ✅  |     ✅     |      ✅      | ✅  | ⬛  | ✅  |     ⬛      |

🟨 = (no longer used in this table) — as of the regionMap vector port every ChartEx layout takes the vector path through `drawChartExPdf`. Callers can still opt into raster per call with `Pdf.fromChart(chart, { forceRaster: true })` when pixel-identity with the SVG preview matters more than selectable text. See the "ChartEx PDF note" below.

##### Capability gaps that are known but intentional

- **Classic PNG content assertions** are generic: every type hits the PNG pipeline, but only `bar` has a hash golden because binary-level stability across chart types would over-couple tests to renderer internals.
- **Classic PDF content assertions** exist only where the PDF path diverges meaningfully from SVG (alpha via `/ExtGState`, pie leader lines, marker geometry). Other types re-use the same call graph, so one SVG assertion and the generic `drawChartPdf` smoke are considered sufficient.
- **LibreOffice visual oracle** is gated on `DOCUMONSTER_LIBREOFFICE_VISUAL_ORACLE` and CI does not install LibreOffice by default to keep matrix jobs fast; direct per-type open-validation is provided for `bar` (solo) and the combo/chartsheet/ChartEx-treemap/funnel fixture, with the full catalogue reachable via the `DOCUMONSTER_ENTERPRISE_CORPUS_DIR` opt-in (see `src/modules/excel/__tests__/helpers/enterprise-corpus.ts`).
- **ChartEx PDF vector path** (`drawChartExPdf`) covers every ChartEx layout the builder currently emits; see the dedicated note.

**3D note:** `bar3D` renders as a **true extruded box** whose axonometric projection is driven by `view3D.rotX` / `view3D.rotY` / `view3D.rAngAx` — three shaded faces (top + front + right) per bar, with depth scaled to bar width so the 3D effect stays readable across chart sizes. The default fallback (`rotX=15°, rotY=20°, rAngAx=true`) matches Excel's new-chart defaults. `line3D`, `pie3D`, `area3D`, `surface3D` and the richer `view3D` / `Scene3D` / `ShapeProperties3D` metadata are **preserved in XML** so clean round-trips and Excel re-opens survive intact, but the preview still renders those types as their 2D equivalents — there is no projection matrix, no light rig, no depth sort for non-bar 3D. This is a preview-grade renderer, not a 3D engine; use Excel or LibreOffice for commercial-grade 3D output.

**Fonts & CJK:** `Pdf.Builder` auto-discovers a system font (the same mechanism used by `Pdf.fromExcel`) whenever a page contains non-WinAnsi characters and no font was explicitly embedded. Call `builder.disableFontAutoDiscovery()` for byte-stable output across hosts, or `builder.embedFont(ttfBytes)` for a deterministic typeface. Register `builder.onWarning(handler)` to receive one diagnostic per distinct unknown `fontFamily` (e.g. non-standard names that fall back to Helvetica metrics) and one diagnostic per build when non-WinAnsi characters land on a page with no covering font (Type3 NOTDEF boxes render).

**Minimal PDF surfaces:** `ChartPdfDrawingSurface.drawPath?` and `drawCircle?` are optional. When a surface lacks `drawPath`, pie/doughnut/ofPie slice outlines degrade to `drawLine` polyline strokes (shape preserved, fill lost); area and radar-filled fills are dropped but the surrounding strokes are still emitted; markers fall back to circle→rect→line chains. `PdfPageBuilder` / `PdfEditorPage` both provide the full interface, so this only matters for custom surfaces.

**regionMap note:** ChartEx `regionMap` previews ship a ~180-entry country centroid table and four real projection formulas (`mercator`, `miller`, `albers` Equal-Area Conic, `robinson`). This is a centroid-dot geographic preview by default; unmatched labels fall back to a deterministic hexagonal tile layout. For real country polygons, pass a TopoJSON topology via the render option `regionMap: { topology, objectName, match, projection }` — the renderer will decode features, match labels to `feature.id` or `feature.properties.<key>`, and draw choropleth paths. This keeps the library zero-data-bundle: the caller loads their own `world-atlas`/`natural-earth` file. The same three-mode pipeline (TopoJSON → centroid preview → hex-tile fallback) is implemented for **both** SVG and vector PDF — `Pdf.fromChart` passes the same `regionMap` option through to `drawChartExPdf`. See `src/modules/excel/chart/topojson.ts` and the exported `RegionMapDataOptions` / `TopologyLike` types.

**Built-in chart styles:** `Chart.setStyle(chart, 1..48)` (alias `Chart.setBuiltInStyle(chart, 1..48)`) writes `<c:style val="N"/>` on a classic chart, selecting one of the built-in style indices. This is the lightweight knob that maps to the 2007/2010 style catalogue. For modern Office-2013-era styling with full `styleN.xml` / `colorsN.xml` sidecars, use `Chart.add(ws, { …, chartStyle: ChartStyleModel })`.

**3D rendering boundaries (non-goals):** Beyond the axonometric box used for `bar3D`, we intentionally do **not** render:

- true 3D projection (rotX/rotY/perspective → matrix + depth sort + light rig) for `line3D`, `pie3D`, `area3D`, `surface3D`
- surface3D as a triangle mesh / wireframe / band-contour

These features would require multi-week investments with a low payoff for a preview-grade renderer; users who need Excel-identical 3D output should round-trip through Excel or LibreOffice. All metadata needed to do so (`Scene3D`, `View3D`, `ShapeProperties3D`) already round-trips through XML.

**ChartEx PDF note:** Classic charts render as vector PDF content via `drawChartPdf` (text stays selectable, shapes stay resolution-independent). ChartEx charts now all render as vector PDF content via `drawChartExPdf`:

- **Vector path (default)** — `sunburst`, `treemap`, `waterfall`, `funnel`, `histogram`, `pareto`, `boxWhisker`, `regionMap` all go through `drawChartExPdf`, which shares its geometry collectors with the SVG renderer so the two backends stay pixel-equivalent modulo rasterisation. Sunburst arcs are emitted as cubic-Bézier approximations (≤ 0.03 % max error); everything else is straight `drawRect` / `drawLine` / `drawPath` primitives that PDF understands natively. `regionMap` reuses the same TopoJSON decoder + projection math + centroid table as the SVG renderer; the only intentional visual divergence is that the rounded-corner frame (`rx="14"`) becomes a sharp-corner frame in PDF (`drawRect` does not expose a corner radius).
- **Raster opt-in** — any ChartEx type can be rasterised on demand with `Pdf.fromChart(chart, { forceRaster: true })` when pixel-identity with the SVG preview matters more than selectable text or vector scalability.

Use `Pdf.fromChart(chart, options)` from `documonster/pdf` — it picks the path automatically and honours `forceRaster: true` when you need the raster route on purpose. Import `canRenderChartExAsVectorPdf(model)` separately from `documonster/chart` if you want to inspect the decision before rendering.

**Pivot chart note:** Documonster supports **metadata-only** pivot charts — the `pivotSource`, field buttons, drop-zone options, `refreshOnOpen` and `c16:showExpandCollapseFieldButtons` extensions all round-trip through XML, and `addPivotChart` / `addPivotChartsheet` create the references Excel needs to reconstruct the chart. There is **no** runtime pivot-chart engine: the preview renderer treats pivot charts like regular charts and does not paint field buttons, drop-zone hints, or apply pivot filtering to the data. Once the file is opened in Excel / LibreOffice / WPS, the host application drives the real rendering from the pivot table. For programmatic manipulation of pivot cache data, use the `pivotTable` module directly; the chart side intentionally stays thin.

**Strict template mode:** Writers accept `{ templateMode: "strict" }` (or `{ strictTemplateMode: true }`) to refuse any chart/ChartEx edit that would force a structural rebuild. When a rebuild is unavoidable the error message now lists any unstructured XML elements the parser observed (available as `ChartExModel.unknownElements`) so vendor extensions can never disappear silently from a loaded template.

**Testing scope boundaries (what this library does _not_ test):**

- **No pixel-level visual diff.** Preview output is tested through SVG-structure assertions and PNG header/signature hashes — a true RMS/SSIM pixel diff would require bundling a PNG decoder and a diff algorithm, and the preview is explicitly not pixel-perfect anyway (see the rendering notes above). If your workflow needs pixel parity with Excel, save the workbook and convert it with LibreOffice's headless PDF export, then compare that output.
- **No in-tree Office-generated fixtures.** Every real-file fixture in this repo (`src/modules/excel/__tests__/data/`) was either generated by Documonster itself or minimally hand-authored for regression testing. For host-application compatibility coverage, use the opt-in `DOCUMONSTER_ENTERPRISE_CORPUS_DIR` mechanism: point it at a directory of files the three vendors produced, and `chart-oracle.integration.test.ts` will audit each one. See `docs/enterprise-corpus-manifest.example.json` for the manifest shape.
- **No automated Excel / WPS runtime.** CI gates open-validation on LibreOffice only. Excel and WPS binaries are not shipped in any CI runner, and GUI-driven validation of those apps is out of scope. The `DOCUMONSTER_OFFICE_OPEN_VALIDATION` + `DOCUMONSTER_OFFICE_OPEN_ARGS` hook lets a self-hosted runner with Office installed participate in the same check pattern.

Enterprise corpus validation manifest example: [`docs/enterprise-corpus-manifest.example.json`](../../../docs/enterprise-corpus-manifest.example.json).

## PDF Export

Export any workbook to PDF with zero external dependencies:

```typescript
import { Workbook, Worksheet, Column } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Report");
Worksheet.setColumns(sheet, [
  { header: "Product", key: "product", width: 20 },
  { header: "Revenue", key: "revenue", width: 15 }
]);
Worksheet.addRow(sheet, { product: "Widget", revenue: 1000 });
Column.setStyle(sheet, "revenue", { numFmt: "$#,##0.00" });

const pdf = await Pdf.fromExcel(workbook, {
  showGridLines: true,
  showPageNumbers: true,
  title: "Sales Report"
});

// Node.js
import { writeFileSync } from "fs";
writeFileSync("report.pdf", pdf);

// Browser
const blob = new Blob([pdf], { type: "application/pdf" });
window.open(URL.createObjectURL(blob));
```

### XLSX to PDF Conversion

```typescript
const workbook = Workbook.create();
await Workbook.readFile(workbook, "input.xlsx");
const pdf = await Pdf.fromExcel(workbook);
```

### PDF Encryption

```typescript
const pdf = await Pdf.fromExcel(workbook, {
  encryption: {
    ownerPassword: "admin",
    userPassword: "reader",
    permissions: { print: true, copy: false }
  }
});
```

### Unicode / CJK Font Embedding

```typescript
import { readFileSync } from "fs";
const pdf = await Pdf.fromExcel(workbook, {
  font: readFileSync("NotoSansSC-Regular.ttf")
});
```

## CSV Import/Export

```typescript
import { Workbook } from "documonster/excel";
import {
  readCsv,
  writeCsv,
  writeCsvBuffer,
  readCsvFile,
  writeCsvFile
} from "documonster/excel/csv";
import fs from "fs";

const workbook = Workbook.create();

// Node.js: read/write CSV files
await readCsvFile(workbook, "data.csv");
await writeCsvFile(workbook, "output.csv");

// Read CSV from stream
await readCsv(workbook, fs.createReadStream("data.csv"), { sheetName: "Imported" });

// Write CSV to stream
await writeCsv(workbook, fs.createWriteStream("output.csv"));

// Write CSV to string / bytes
const csvText = writeCsv(workbook);
const bytes = await writeCsvBuffer(workbook);

// Browser: read from string/ArrayBuffer/File
await readCsv(workbook, csvString);
await readCsv(workbook, arrayBuffer);
```

## Markdown Import/Export

```typescript
import { Workbook } from "documonster/excel";
import {
  readMarkdown,
  writeMarkdown,
  writeMarkdownBuffer,
  readMarkdownFile,
  writeMarkdownFile
} from "documonster/excel/markdown";

const workbook = Workbook.create();

// Read Markdown table
readMarkdown(workbook, "| Name | Age |\n| --- | --- |\n| Alice | 30 |");
await readMarkdownFile(workbook, "table.md");

// Write Markdown
const mdText = writeMarkdown(workbook);
await writeMarkdownFile(workbook, "output.md");
const bytes = writeMarkdownBuffer(workbook);
```

## Streaming API

### Streaming Reader

Read large XLSX files with minimal memory usage:

```typescript
import { Stream } from "documonster/excel";

const reader = new Stream.WorkbookReader("large-file.xlsx", {
  worksheets: "emit",
  sharedStrings: "cache",
  hyperlinks: "ignore",
  styles: "ignore"
});

for await (const worksheet of reader) {
  console.log(`Reading: ${worksheet.name}`);
  for await (const row of worksheet) {
    console.log(row.values);
  }
}
```

### Streaming Writer

Write large XLSX files row by row:

```typescript
import { Stream } from "documonster/excel";

const workbook = new Stream.WorkbookWriter({
  filename: "output.xlsx",
  useSharedStrings: true,
  useStyles: true
});

const sheet = workbook.addWorksheet("Data");
for (let i = 0; i < 1000000; i++) {
  sheet.addRow([`Row ${i}`, i, new Date()]).commit();
}

sheet.commit();
await workbook.commit();
```

`WorksheetWriter.commit()` is intentionally synchronous and returns `void`; it cannot wait for
browser compression or a slow destination. `WorkbookWriter.commit()` owns that asynchronous work:
it commits any open worksheets, waits for every ZIP push, and observes destination backpressure
before resolving. Prefer leaving the final worksheet open and calling `await workbook.commit()`.
If you explicitly call `sheet.commit()`, always follow it with and await `workbook.commit()`; the
sheet call alone only closes input and does not mean that its bytes have reached the destination.

### Web Streams (Node.js 22+ and Browsers)

```typescript
import { Stream } from "documonster/excel";

// Write to Web WritableStream
const chunks: Uint8Array[] = [];
const writable = new WritableStream({
  write(chunk) {
    chunks.push(chunk);
  }
});

const writer = new Stream.WorkbookWriter({ stream: writable });
const sheet = writer.addWorksheet("Sheet1");
sheet.addRow(["Name", "Score"]).commit();
sheet.addRow(["Alice", 98]).commit();
sheet.commit();
await writer.commit();

// Read from Web ReadableStream
const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
let offset = 0;
for (const c of chunks) {
  bytes.set(c, offset);
  offset += c.length;
}

const readable = new ReadableStream({
  start(ctrl) {
    ctrl.enqueue(bytes);
    ctrl.close();
  }
});

const reader = new Stream.WorkbookReader(readable, { worksheets: "emit" });
for await (const ws of reader) {
  for await (const row of ws) {
    console.log(row.values);
  }
}
```

## Browser Support

### Using with Bundlers (Vite, Webpack, Rollup, esbuild)

```typescript
import { Workbook, Cell } from "documonster/excel";

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Sheet1");
Cell.setValue(sheet, "A1", "Hello, Browser!");

const buffer = await Workbook.toBuffer(workbook);
const blob = new Blob([buffer], {
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
});
const url = URL.createObjectURL(blob);
```

### Using with Script Tags

```html
<script src="https://unpkg.com/documonster/dist/iife/documonster.iife.min.js"></script>
<script>
  const { Workbook } = Documonster;
  const wb = Workbook.create();
</script>
```

### Browser Notes

- Use `Workbook.read(workbook, arrayBuffer)` instead of `Workbook.readFile(...)`
- Use `Workbook.toBuffer(workbook)` instead of `Workbook.writeFile(...)`
- PDF export is fully supported
- CSV and Markdown operations are supported
- Sheet protection with passwords uses pure JS SHA-512

## Types

### Addressing cells

Every `Cell` function takes exactly two forms — an `"A1"` address, or a 1-based
`(row, col)` pair — and nothing else:

```typescript
Cell.setValue(ws, "B3", 42);
Cell.setValue(ws, 3, 2, 42);
Cell.setFont(ws, 3, 2, { bold: true }); // facet setters take both forms too
```

Mixing them is a compile error rather than a silent misread: `Cell.getValue(ws,
"A1", 99)` used to type-check and read `"CUA1"`, and `Cell.getValue(ws, 5)` used
to type-check and throw at runtime. Both are now rejected.

### Columns by key

`Column.*` accepts a key, a letter or a 1-based number. `Column.getNumber`
bridges a key to the `(row, col)` form, and `Worksheet.columnDefinitions` is the
inverse of `Worksheet.setColumns`:

```typescript
Worksheet.setColumns(ws, [{ header: "Total", key: "total", width: 12 }]);

const col = Column.getNumber(ws, "total"); // 1
Cell.setValue(ws, 2, col, 99);

// Append a column while keeping the existing definitions — no hand-copying.
Worksheet.setColumns(ws, [...Worksheet.columnDefinitions(ws), { header: "Error", key: "error" }]);
```

`Worksheet.columns(ws)` returns the live, **read-only** column handles; declare
columns through `setColumns` and change them through `Column.set*`. Note that
`Worksheet.columnCount(ws)` is unrelated: it measures the _used_ range (the
largest cell count over all rows), not how many columns were declared.

### Rows from your own types

Row objects are matched against the column keys, so any object works — a plain
interface needs no cast:

```typescript
interface Invoice {
  invoiceId: string;
  total: number;
}

const invoices: Invoice[] = await load();
Worksheet.setColumns(ws, [
  { header: "Invoice", key: "invoiceId", width: 20 },
  { header: "Total", key: "total", width: 12 }
]);
Worksheet.addRows(ws, invoices); // keys are read off each object
```

### Cell handles

`Row.eachCell` / `Row.getCell` / `Worksheet.getRow` hand out `CellData` handles.
A handle exposes its address and style directly; read the rest with `Cell.view`
and write through the `Stream` handle operations (they are not streaming-only):

```typescript
Row.eachCell(ws, 1, cell => {
  const header = Cell.view(cell).text.trim();
  Stream.setCellFont(cell, { bold: true });
});
```

Every type the public API speaks is exported from `documonster/excel` under its
**declared** name — the same name TypeScript prints in errors and hovers. There
are no aliases to learn, and no `import type` gymnastics: annotate a value, build
a style helper, or store a column definition directly.

```typescript
import type {
  Style,
  Alignment,
  Border,
  Borders,
  Color,
  Font,
  NumFmt,
  PageSetup,
  ColumnDefn,
  RowValues,
  CellValue,
  DataValidationRule,
  ConditionalFormattingOptions,
  TableProperties,
  WorksheetModel,
  XlsxWriteOptions
} from "documonster/excel";

// Style values are now declarable, so styles can be composed and shared.
const HEADER: Partial<Style> = {
  font: { bold: true, size: 11 },
  alignment: { vertical: "middle", horizontal: "center" },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } }
};
const THIN: Partial<Border> = { style: "thin", color: { argb: "FF000000" } };
const BOX: Partial<Borders> = { top: THIN, bottom: THIN, left: THIN, right: THIN };

export const mergeStyle = (base: Partial<Style>, ...rest: (Partial<Style> | undefined)[]) =>
  rest.reduce<Partial<Style>>((acc, s) => ({ ...acc, ...(s ?? {}) }), base);

// Column definitions for `Worksheet.setColumns`.
export const REPORT_COLUMNS: ColumnDefn[] = [
  { header: "Invoice", key: "invoiceId", width: 20, style: HEADER },
  { header: "Amount", key: "amount", width: 14, style: { numFmt: "#,##0.00" } }
];
```

Handles (the opaque objects the API hands out) are named by the `Handle` alias on the
namespace that owns them:

```typescript
import type { Workbook, Worksheet } from "documonster/excel";

const render = (ws: Worksheet.Handle) => {
  /* … */
};
const save = (wb: Workbook.Handle) => {
  /* … */
};
```

Streaming types live on the `Stream` namespace, next to the streaming classes:

```typescript
import { Stream } from "documonster/excel";

const options: Stream.WorkbookWriterOptions = { filename: "big.xlsx", useSharedStrings: true };
const writer = new Stream.WorkbookWriter(options);
const sheet: Stream.WorksheetWriter = writer.addWorksheet("Data");
```

The cell-value kinds, formula kinds, Excel error strings and the common paper
sizes are constant lookup objects that double as types, so they work in both
positions and tree-shake away when unused (a TS `enum` cannot):

```typescript
import { Cell, ErrorValue, PaperSize, ValueType } from "documonster/excel";
import type { CellErrorValue } from "documonster/excel";

if (Cell.getType(ws, "A1") === ValueType.Number) {
  /* … */
}
const na: CellErrorValue = { error: ErrorValue.NotApplicable };
ws.pageSetup.paperSize = PaperSize.A4;
```

One type, one public name — including for handles. Where a namespace publishes a
`Handle` alias (`Worksheet.Handle`, `Workbook.Handle`, `Table.Handle`, …) that
alias is the public name, and the underlying `WorksheetData` / `WorkbookData` /
… interfaces are deliberately not re-exported flat. The cell, row and column
handles have no such alias, so their declared names are the public ones:

```typescript
import type { CellData, ColumnData, RowData } from "documonster/excel";

const cellText = (cell: CellData) => cell.address;
const rowNumber = (row: RowData) => row.number;
const columnWidth = (column: ColumnData) => column.width;
```

## Utility Exports

Documonster is published as subpath entry points — there is no bare
`"documonster"` export. Import each symbol from the module that owns it.

```typescript
// Excel domain errors — from documonster/excel
import { ExcelError, isExcelError, ImageError, TableError } from "documonster/excel";

// PDF export + PDF errors — from documonster/pdf
import { Pdf, PdfError, isPdfError } from "documonster/pdf";

// XML helpers + XML errors — from documonster/xml
import { Xml, XmlError, isXmlError } from "documonster/xml";

// Encode/decode text for safe XML embedding.
const encoded = Xml.encode("a & b < c"); // "a &amp; b &lt; c"
const decoded = Xml.decode(encoded); // "a & b < c"

// Export a workbook to PDF.
const bytes = await Pdf.fromExcel(workbook);

// Errors extend BaseError and support instanceof + type guards.
try {
  await Workbook.readFile(workbook, "broken.xlsx");
} catch (err) {
  if (isExcelError(err)) {
    console.error("Excel error:", err.message);
  }
}
```

## Examples

See the [examples directory](examples/) for runnable code covering all features:

- Workbook creation, reading, and copying
- Cell styling, fonts, borders, fills
- Formulas, data validation, conditional formatting
- Images (JPEG, PNG), hyperlinks, comments
- Tables with auto-filters and totals
- Merge cells, freeze panes, page setup
- Streaming reader and writer
- Web Streams integration
- PDF export
- And more...
