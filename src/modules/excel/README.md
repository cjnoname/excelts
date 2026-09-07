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

A number format is often owned by the column rather than by each cell, so
`setNumFmt` exists at all three levels:

```typescript
import { Column, Row } from "documonster/excel";

Column.setNumFmt(worksheet, "revenue", "$#,##0.00"); // by key, letter or number
Row.setNumFmt(worksheet, 2, "0.00%");
```

Setting a facet on a row or column applies it to the row/column **and** to the
cells already in it. `Row` also has `setFont` / `setFill` / `setBorder` /
`setAlignment`; every other combination goes through `setStyle`, which is also
the better call for several facets at once — it makes a single pass for all of
them:

```typescript
Column.setStyle(worksheet, "revenue", { numFmt: "$#,##0.00", alignment: { horizontal: "right" } });
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

### Page Breaks

Manual page breaks, the equivalent of Excel's **Page Layout → Breaks → Insert
Page Break**. They affect printing and `Pdf.fromExcel`, not the on-screen grid.

```typescript
import { Column, Row } from "documonster/excel";

Row.addPageBreak(worksheet, 20); // page 2 starts at row 21
Column.addPageBreak(worksheet, "F"); // the next page starts at column G
```

A break always spans the full width or height of the sheet. `CT_Break` has
`min`/`max` attributes that could narrow one to a band of columns or rows, and
they are deliberately not exposed: Excel's UI cannot author such a break, every
file Excel writes spans the full extent, and `Pdf.fromExcel` reads only the break
position — so a band would be a value nothing on either side can observe.

When writing with the streaming writer you hold a row _handle_ rather than a row
number, so the break goes through the `Stream` surface:

```typescript
import { Stream } from "documonster/excel";

Stream.addRowPageBreak(sheet.getRow(20));
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

**For production-grade rendering**, round-trip the `.xlsx` through headless LibreOffice (`soffice --convert-to pdf`). An unmodified chart part is handed to LibreOffice as the exact bytes that were loaded, and `templateMode: "strict"` refuses to re-render an edited chart part it cannot patch in place — so the handoff does not quietly substitute a reconstruction for the original.

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

### Package Part Preservation

A real workbook carries parts this library does not model: a VBA project, custom document properties, data connections, query tables, printer settings, vendor extensions. The contract for those is:

> **Preserve every part whose reachability can be re-established; drop the rest deliberately and report why.**

Preserving a part means more than keeping its bytes. A reader finds a part through a relationship and decides how to interpret it from its content type, and this writer regenerates both `[Content_Types].xml` and every `.rels` file from the model. So three things travel with a preserved part:

- its `Override` content type, or the `Default` for its extension — promoted to an explicit `Override` when the source package declared that extension differently from what this writer emits, so a vendor type is not silently rewritten to `application/xml`;
- its own `.rels`, so whatever it points at still resolves;
- the relationships that pointed **at** it, re-registered on the parts that declared them — including the `r:id` inside `<pageSetup>`, without which a preserved `printerSettings` part is present but unused.

`xl/vbaProject.bin` is the case that motivates all of this: the workbook content type is round-tripped, so before package-part preservation existed, reading an `.xlsm` and writing it produced a file that still declared itself macro-enabled with every macro gone.

#### What is deliberately not written back

Three categories, and the reasons differ:

| Category               | Parts                                                               | Why                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale caches           | `xl/calcChain.xml`, `xl/volatileDependencies.xml`, `xl/revisions/*` | They describe a workbook state the write invalidates. Excel rebuilds them on open, so omitting them is not data loss — it is declining to assert something false.                                                           |
| Invalidated signatures | `_xmlsignatures/*`                                                  | A signature covers the exact bytes it was made over, and re-serialising any modelled part changes them. A file that is honestly unsigned is better than one that claims a guarantee it no longer has.                       |
| Unreachable            | anything nothing in the output would point at                       | A part no application can reach is indistinguishable from a part that was never there, and a relationship whose target is absent is worse than either — a dangling reference is one of the things Excel offers to "repair". |

A part becomes unreachable when the sheet that referenced it is deleted, or when its only inbound relationship came from a part whose `.rels` this writer regenerates without a channel for preserved edges. Reachability is transitive, so a chain hanging off a dropped part collapses with it.

Anything not in those categories is preserved, including parts this library has never seen. An unclassified part is more likely to be your data than something this library may delete, and a slightly larger file is a much cheaper mistake than a missing feature.

#### Inspecting what happened

Drops are recorded rather than silent, because two of the reasons are things a caller may need to act on:

```typescript
import { Workbook } from "documonster/excel";
import type { OpaqueDrop } from "documonster/excel";

const workbook = Workbook.create();
await Workbook.readFile(workbook, "signed-macro-enabled.xlsm");

const drops: readonly OpaqueDrop[] = Workbook.getModel(workbook).opaqueDrops ?? [];
for (const drop of drops) {
  console.warn(`${drop.path}: ${drop.reason} — ${drop.description}`);
}
// _xmlsignatures/sig1.xml: invalidated-signature — digital signature over the
// source bytes, which this write replaces
```

`Workbook.getModel(workbook).opaqueParts` lists what was kept, each entry carrying its `path`, `data`, `contentType`, and the relationships in both directions.

#### Boundary

Preserved inbound relationships are re-emitted on the package root, on `xl/workbook.xml`, and on worksheets. A relationship that reached a part from a chart, drawing or pivot table is recorded on read — which is what makes the decision informed — but has no channel back into the output, so such a part is reported as `unreachable` rather than written where nothing refers to it.

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
| Template fidelity       | byte-preserving round-trip of unmodified chart / chartEx parts and their style and colour sidecars (not of the package as a whole), raw-XML patching for narrow edits, `templateMode: "strict"` to refuse silent loss, `Chart.unknownElements` surfacing `c15:` / `cx14:` vendor tags                                                                                                                                                                                                                                                                                                   |
| Package part fidelity   | unmodelled parts (VBA project, custom properties, connections, query tables, printer settings, vendor extensions) preserved with their content type and relationships in both directions; stale caches, invalidated signatures and unreachable parts dropped deliberately and reported via `WorkbookModel.opaqueDrops`                                                                                                                                                                                                                                                                  |
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

## Excel Binary Workbook (`.xlsb`)

`.xlsb` is a format choice on the canonical workbook functions, not a second API:

```typescript
import { Workbook } from "documonster/excel";

// The extension selects the format.
await Workbook.writeFile(workbook, "report.xlsb");

// Reads detect it from the package contents.
const reopened = Workbook.create();
await Workbook.readFile(reopened, "report.xlsb");

// Bytes and streams take it explicitly, because there is no filename to read it from.
const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
for await (const chunk of Workbook.toStream(workbook, { format: "xlsb" })) {
  // consume
}
```

#### Two read options this container adds

A BIFF12 file makes two choices a caller can reasonably want to overrule, and both are public on
`Workbook.read` / `readFile` / `readWithDiagnostics`.

```ts
import { Workbook, XlsbFormulaDecodeError } from "documonster/excel";

// Formatting-only cells past the data. Excel writes a `BrtCellBlank` for every cell of a formatted
// region, so a sheet with a formatted column carries one per row to the sheet's end — measured at
// 186 MB of retained heap and 16,379 physical rows against 253 rows of real data.
await Workbook.readFile(workbook, "wide.xlsb", { blankCells: "collapse" });

// A formula cell holds two things: the value Excel computed and the tokens that computed it. The
// value always decodes; the token stream is where this codec can be defeated.
await Workbook.readFile(workbook, "book.xlsb", { formulas: "cached" }); // values only, no expressions
try {
  await Workbook.readFile(workbook, "book.xlsb", { formulas: "error" }); // refuse rather than degrade
} catch (error) {
  if (error instanceof XlsbFormulaDecodeError) {
    console.error(error.sheet, error.addresses);
  }
}
```

`blankCells: "collapse"` is **lossless in both containers** — the rectangles describe exactly the
cells they came from, so writing the workbook back reproduces them byte for byte. `formulas` has
three settings: `"preserve"` (the default) keeps every expression it can decode and the cached
value where it cannot, listing the addresses under `diagnostics.undecodedFormulas`; `"cached"`
decodes none of them, which makes it immune to a token stream this codec cannot read and means the
workbook writes back as literals; `"error"` throws `XlsbFormulaDecodeError` on the first failure.

Coverage is partial and the boundary is stated below rather than discovered. What exists is the
framework the format needs before a reader can be trusted, plus a reader and writer for the
record set whose encoding has been established.

The order is deliberate. A BIFF12 record stream is opaque, and Excel's diagnostic for a
malformed one is "we found a problem with some content" — no part, no offset, no reason. So
the first things built were the two that make the rest debuggable:

- **A validator** (`utils/xlsb-validator/`) that answers "would Excel refuse this?" — package
  structure, record framing, `Begin`/`End` balance, record ordering, cell coordinates, and
  indexes into the shared-string and cell-format tables.
- **A disassembler** (`src/test/biff-dump.ts`) that renders a part as indented, diffable text.

Both derive from one record table (`xlsb/spec/records.ts`), which is data rather than code:
identifier, name, scope role, and payload layout. Nothing keeps a private copy, and
`spec.test.ts` checks the table on its own.

### What round-trips today

Strings (via a shared-string table), numbers, booleans, dates and blanks, across multiple
sheets. Numbers use the compact `RkNumber` encoding where it is exact and a full double
otherwise — never a rounded approximation.

**Formulas**, as text and as their cached result. BIFF12 stores an expression as a
reverse-polish token stream rather than as text, so this module owns the token mapping and
`documonster/formula` owns the text: `Formula.tokenize` + `Formula.parse` one way,
`Formula.print` the other. Sharing that is not convenience — precedence and parenthesisation
are decided in one place, and a second implementation would not fail loudly. `=-2^2` is `4` in
Excel and `-4` almost everywhere else.

Absolute and relative references, sheet-qualified references, defined names, reference unions
and intersections all survive.

**The workbook's date epoch.** A workbook saved with the 1904 system round-trips as one, and its
dates read back as the instants they are rather than four years early.

**Alignment and cell protection** — horizontal, vertical, wrap, shrink-to-fit, indent, reading
order, text rotation, locked and hidden. The six bytes carrying these were previously written as a
constant `0x1010` with a comment saying the fields were "left at their defaults", which was true and
concealed that the defaults are not zero: `alcV = 0` is _top_, so zeroing the byte would have moved
every cell's text.

**Page setup** — margins, paper size, scale, orientation, resolution, fit-to-page and first page
number — and the sheet's **default row height and column width**.

**The sheet's tab colour and VBA code name.** The code name matters because the VBA project is now
preserved: macros address sheets by it, so dropping it while keeping `vbaProject.bin` would produce
a workbook whose code no longer resolves its own sheets.

**Row and column formatting.** `BrtRowHdr` and `BrtColInfo` have always carried a format index and
this writer always wrote zero into it, because the field it read from was declared and never
populated — so `Row.setStyle` and `Column.setStyle` had no path into the file at all.

**Cross-sheet references and defined names, as expressions.** A `PtgRef3d` carries an index into
`BrtExternSheet` and a `PtgName` an index into the `BrtName` records; neither table was written, so
every such reference pointed into nothing. A round trip could not see it, because it read back the
_cached result_ rather than the formula — which is the exact failure mode the rest of this section
exists to prevent, found in this library's own output.

**Every part this reader does not interpret** — the theme, images, drawings, charts, printer
settings, a VBA project. Losing the theme is not cosmetic: a `{ theme: 1 }` colour resolves through
it.

**Fonts** — name, size, bold, italic, underline, strikethrough, colour, family, charset and theme
scheme — and **pattern fills**, including solid fills with a real colour. A `BrtFont` has no
optional fields, so a cell that asks only for bold reads back as Calibri 11 bold; that is what
Excel does with such a cell too.

**Borders, whose write-up here used to say they were deliberately absent.** That was true and is no longer:
all nine Excel-authored reference workbooks contain exactly one `BrtBorder`, byte-identical in every
file — 51 zero bytes, the default "no borders" entry — so the corpus established the record's _size_
and not one of its fields. What changed is where the fields came from: `1 + 5 × 10 = 51` is exactly
the specification's `flags` byte plus five ten-byte `Blxf` structures, so the observed length
corroborates the documented layout rather than being the only evidence for it. Reading them off the
specification and checking the arithmetic against the one sample is a different position from having
no evidence at all, and borders now round-trip — see `xlsb/border.ts`, which also records why the
edge order is top, bottom, left, right and not the CSS one.

**Sheet visibility**, **merged ranges**, **column widths** and **row heights**. Each layout was
established from Excel's own output, and two were confirmed by a value that could not be a
coincidence: a workbook whose three sheets are named `Visible`, `Hidden` and `VeryHidden` carries
0, 1 and 2, and a default column carries 2742 — which is 10.71 characters in the 1/256ths this
format uses, the width of a default Calibri 11 column.

A column or row that never had a size set does not acquire one, and a custom size is flagged so
Excel keeps it rather than recomputing from the font.

**Number formats**, and with them dates. BIFF12 stores a date as a serial number and says so
only through the format, so `iFmt` is the difference between `2016-10-07` and `42650` — the one
kind of fidelity loss a user notices immediately. The format strings and the "is this a date
format" test are the ones the XLSX path uses, so the same workbook cannot read back differently
depending on which container it arrived in. Formats are interned, so fifty cells sharing one
format produce one entry.

**Hyperlinks.** `BrtHLink` carries a range and a relationship id; the destination is a
`TargetMode="External"` entry in the sheet's own `.rels`, so neither half is useful without the other.
The layout is MS-XLSB 2.4.693 and is confirmed by two corpus fixtures that carry one. A link with no
label is the one lossy case — the cell model classifies a value as a hyperlink only when it has non-empty
text, so reading one back puts the destination there and says so.

**Images** — the bytes in `xl/media/`, the placement in `xl/drawings/drawingN.xml`, the sheet's own
`.rels`. All of it is the same XML an XLSX carries, produced by the same code; only the reference is
binary, a twelve-byte `BrtDrawing` holding a relationship id. The three forms `ImageData` accepts —
`buffer`, `base64` and `filename` — all embed, and an external `link` is written as a linked picture
with no bytes in the package.

### One model, two writers

The defect this container has produced most often is not a misread field. It is **two writers deciding one fact
independently and disagreeing**, where only one of the two answers is the one Excel accepts. Each is invisible
from inside either writer, and an XLSB round trip through this library's own reader confirms the wrong answer
happily. Six found so far:

| Fact                              | XLSX said                           | XLSB said                             |
| --------------------------------- | ----------------------------------- | ------------------------------------- |
| a theme part exists               | `theme1.xml` written                | nothing — 252 dangling references     |
| the default font's colour         | `<color theme="1"/>`                | automatic, palette index 64           |
| a `containsText` rule's formula   | `NOT(ISERROR(SEARCH("…",A2)))`      | no formula — the rule matched nothing |
| the data field's place on an axis | `colFields` gets `x="-2"`           | column axis omitted entirely          |
| where a pivot body starts         | anchor + one row per filter + a gap | the anchor row itself                 |
| whether to recalculate on load    | a real `calcId` and no request      | `recalcID = 0`, which forces one      |

`__tests__/writer-agreement.test.ts` compares the two containers rather than either against a constant, because
a constant can drift with both writers at once. Where the two genuinely spell a fact differently — a theme index
in XML against a `BrtColor` kind in binary — the test translates one into the other and says so.

The `containsText` case is the sharpest, because the formula is not decoration: several rule types are
_specified_ in terms of a formula the file must carry even though the caller expressed the intent another way.
`core/conditional-formula.ts` now holds those derivations — eight text operators and ten time periods — and both
writers read it. Fixing it exposed two more faults in the binary path: the references were `PtgRef` positions
where a rule needs `PtgRefN` **offsets** from its range's top-left (so a rule on `A2:A4` tested `A2` three
times), and the operand class was `reference` where a value was wanted.

### Nothing is dropped quietly

A cell needing something the writer cannot express is written as a blank and **reported by address**,
so its position survives. A sheet feature this container has no record for is reported **by sheet**,
and a defined name that could not keep its meaning is reported **by name**. By default any of them
refuses the write outright:

```typescript
await Workbook.toBuffer(workbook, { format: "xlsb" });
// ExcelNotSupportedError: 3 item(s) carry content this writer cannot express:
//   Sheet1!A1: formula, Sheet1: table, Sheet1: border (12).
//   Pass { unsupported: "ignore" } to write the workbook without them.
```

The thrown error carries the full list on `items`, so a converter reporting "these need attention"
does not have to parse the message.

Reading has the same option and the **opposite default**, plus a third form for the case neither
covers — read it _and_ inspect what was lost:

```typescript
await Workbook.read(workbook, bytes); // reads it, quietly, losing what it cannot decode
await Workbook.read(workbook, bytes, { unsupported: "error" }); // or refuse and say what was lost

const report = await Workbook.readWithDiagnostics(workbook, bytes);
report.lost; // ["Sheet1: 1 cell(s) in BrtShortReal", …]
report.unknownRecords; // record ids with no name here — not losses, see below
```

`unknownRecords` is deliberately **not** part of `lost`. A record this library has no name for is
usually a newer schema's extension rather than missing content — every workbook in the reference
corpus has some — so counting them as losses would make `unsupported: "error"` reject ordinary files
and teach callers to switch it off. They are reported separately for anyone who wants them.

That asymmetry is deliberate. A workbook being _written_ is in memory and complete, so a loss is this
library's limitation and stopping costs the caller nothing they had. A workbook being _read_ was
written by someone else and the loss already happened; a reader that refuses a real file because
seven of its cells use a record whose layout is unestablished is a reader nobody can use. `"error"`
is there for the caller who would rather stop than convert something incomplete.

**Reading replaces the workbook, and does so atomically.** `Workbook.read` into a workbook that
already has sheets discards them, exactly as the XLSX reader does — and if the package turns out to be
malformed part-way through, the target is left as it was rather than holding half a file. That holds
for a _refusal_ too: `{ unsupported: "error" }` evaluates the losses before anything is applied, so a
rejected read leaves the workbook untouched rather than replacing it and then reporting failure.

### A field description that cost three features

`BrtRowHdr` has **three** flag bytes. This module's record table declared the first two as one `u16`:

```
offset 10   fExtraAsc, fExtraDsc, reserved1(6)
offset 11   iOutLevel(3), fCollapsed, fDyZero, fUnsynced, fGhostDirty, fReserved
offset 12   fPhShow, reserved2(7)
```

The writer's only flag was `fUnsynced` — "this height is the row's own rather than derived from the font",
which is what makes a custom height stick. Written as `0x0002` into a `u16` at offset 10, little-endian put it
in **offset 10 bit 1: `fExtraDsc`**, "pad the bottom of this row". The reader read the same wrong bit, so a
custom height round-tripped through this library while Excel saw a row with no manual height and padding
nobody asked for. The record's _length_ was right throughout — `u16` plus a byte is three bytes and so is a
byte three times — which is precisely why nothing caught it: the framing validator compares record lengths
against Excel's own, and this record was always the 25 bytes it should be. Only the bits inside were in the
wrong places.

**The consequence went well beyond the height.** `iOutLevel`, `fCollapsed` and `fDyZero` share the byte at
offset 11, so hidden rows, grouped rows and collapsed rows were all reported as things XLSX could carry and
XLSB could not. They were never missing from the record; three features were declared unsupported to describe
a mistake in a field table. Splitting the bytes made all three work, and the loss list lost three entries
without a single record being added.

`INFERRED_VALUES.rowHeightUnsynced` moved out of the inferred register with it. Its comment had been honest
about the uncertainty — "the flag's position is constrained by the fields either side of it but its use is not"
— and the answer was in 2.4.770 the whole time.

`xlsb/__tests__/row-header.test.ts` asserts every offset against the **specification** rather than against
what the encoder produces, because the tests it replaces did the latter and passed on the wrong layout for as
long as it stood. Restoring the old byte fails four of them.

### A length table entry is a claim about every producer

`OBSERVED_PAYLOAD_SIZES` holds sixty lengths read off Excel's own output, and the validator raises an
**error** when a record does not match. That severity is what makes the table's contents consequential:
an entry is not a note about the corpus, it is an assertion that no producer will ever write that record at
any other length.

One entry was not that. `BrtDrawing`'s payload is an `XLWideString` holding the sheet's drawing relationship
id, so its length follows the id — `"rId2"` encodes to 12 bytes and `"rId10"` to 14. The table listed 12,
read from a workbook whose sheets happened to have single-digit ids.

**The result was the validator rejecting a file this library had just written.** Nine preserved relationships
on a sheet push its drawing to `rId10`, and the check reported `BrtDrawing is 14 byte(s); every
Excel-authored one is 12`. Nothing about the file was wrong.

Removing the entry fixes it, and `check-records.ts` now refuses to let a record with a _declared_
variable-width field into that table at all — the structural fact was already in the field list, unconsulted.

That check caught one. Reading the rest against `[MS-XLSB]` caught two more, and they were invisible to it for
the same reason: they have no field list to inspect. `BrtACBegin` is `cver` followed by that many
`ACProductVersion` structures — six bytes when one application is named, twelve when two are. `BrtSel` ends in
`sqrfx`, a counted array of sixteen-byte ranges, so 36 bytes is the length of a _single-range_ selection and
ctrl-clicking a second range makes it 52.

Neither had ever been hit, because no corpus workbook names two applications or selects two ranges. That is
the shape of the whole category: **a length is constant across nine files for reasons that have nothing to do
with the format**, and only reading what the record _is_ distinguishes the two. The check now enforces the
structural half; the rest of the table was audited by hand and the reasoning pinned in a test, so a future
entry has to argue with it rather than merely look plausible.

### Emptying the inferred register

`INFERRED_VALUES` is where this module records values it arrived at by reasoning rather than by reading — a
bit whose position was deduced from the fields either side of it, a constant borrowed from a neighbouring
format. Keeping them in one place makes the size of the guess visible. It held **seventeen** entries; it now
holds **five**, and not one of the twelve was wrong. They were simply never checked against the published
tables:

| Entry                       | Where it turned out to be written down                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Six `BrtFont` flag bits     | `FontFlags`, 2.5.53 — and the six are _not_ contiguous, so a table built by counting attributes in order misplaces every one from `fStrikeout` on                                          |
| `fWrap`, `fShrinkToFit`     | `BrtXF`, 2.4.876 — and they are in **different bytes**, which is the trap: reading the pair as one sixteen-bit field puts `fShrinkToFit` where `fMergeCell` is, and cells come back merged |
| `fFrozen`, `fFrozenNoSplit` | `BrtPane`, 2.4.755 — their own comment already cited the MUST that makes them exclusive                                                                                                    |
| `fHidden` on a defined name | `BrtName`, 2.4.712 — and `binary.ts` already had the constant, so this was a duplicate as well as an inference                                                                             |
| `fUnsynced`                 | `BrtRowHdr`, 2.4.770 — the one that was actively wrong, described [above](#a-field-description-that-cost-three-features)                                                                   |

Each moved next to the code that uses it with the citation attached, rather than staying in a register that
says "we worked this out". The five that remain are genuine: a bold font weight that appears in no corpus
workbook and no published enumeration, a tint scale, an extern-sheet span, and two offsets.

The register is smaller and more honest for it — an inference nobody rechecks eventually reads as a fact.

### Enumerations, and a test that reads the specification rather than the code

The tables that map a name to a number — fill patterns, border styles, the two alignments, reading order —
were audited the same way and came out correct. What was wrong was three of their **comments**: `HorizAlign`,
`VertAlign` and `ReadingOrder` each described their values as read off Excel's output and inferred from
neighbours, when all three are published tables. Values arrived at by inference and values arrived at by
citation deserve to be labelled differently, and here the label was simply out of date.

`xlsb/__tests__/enumerations.test.ts` now pins them, and the way it does so is the point: the expected values
are **transcribed from the specification by hand** rather than imported from the module. Every other test here
reads the module's own table and checks the encoder agrees with it — which proves the two halves of this
module are consistent and nothing at all about whether either matches Excel. A transcribed table fails against
the document instead of against itself. Moving one entry of `FillPattern` by a single position turns it red.

The count is asserted alongside the values for the same reason. A table that gains an entry shifts everything
after it, and a generated test would shift with it.

### The audit that mostly found nothing

Two records had lost features to a mishandled flag word, so the remaining eight were read against the
specification bit by bit. That is worth recording precisely because it came up almost empty: without a note,
the next person has to repeat it to find that out.

| Record                    | Verdict                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `BrtWbProp`               | `f1904` is bit 0 — correct                                                                                                              |
| `BrtPane`                 | `fFrozenNoSplit`, not `fFrozen`; the specification makes them mutually exclusive and the second is the "freeze panes" a person asks for |
| `BrtDVal`                 | All ten packed fields sit where 2.4.353 puts them, including `mdImeMode` occupying bits 10–17 between two single flags                  |
| `BrtName`                 | Three bit constants, kept separate                                                                                                      |
| `BrtSSTItem`              | Its flags belong to the nested `RichStr`, not to a flag word of its own                                                                 |
| `BrtColInfo`, `BrtRowHdr` | Fixed — see above                                                                                                                       |

`BrtPane` is the one worth reading if only one is: `xnumXSplit` counts **rows** and `xnumYSplit` counts
**columns** when the panes are frozen, which is the opposite of what XLSX's `xSplit`/`ySplit` mean. The module
names its own fields `rows` and `columns` rather than carrying either convention through.

The audit did find one thing, and it was not a bit position. **`WORKBOOK_FLAG_1904` was defined twice** — in
`binary.ts` and in `defaults.ts` — and the two were free to disagree about which bit that is with nothing to
notice. The reader imported the copy that had no other callers. Deleting it produced a compile error at the
import, which is the only reason the duplication was visible at all.

### The gate that compares two descriptions of the same bytes

Two tables in this module describe every record's layout: the **field list**, and
`OBSERVED_PAYLOAD_SIZES`, which holds lengths read off real Excel output. Nothing compared them, so a field
list could drift from the record it described and only the tooling built on it would be wrong — which is the
tooling every other check here runs on.

The comparison is deliberately one-directional. Declaring **more** than the record holds is always an error:
a decoder reads past the payload. Declaring **less** is a position this module takes often — a field is named
once it is understood, and `BrtBorder` names none of its 51 bytes. So a short layout is allowed only for a
record listed in `PARTIAL_LAYOUTS`, each entry carrying its reason, and the check catches a record that
_lost_ its tail rather than one that never described it.

It found two on its first run: `BrtWsFmtInfo` stopping two bytes short of `iOutLevelRw` and `iOutLevelCol`,
and `BrtBeginColInfos` declaring a four-byte count where Excel writes an empty payload — the latter with the
correct fact already written down in two other places in the same file.

**What no length check can catch** is worth stating with it, because the temptation is to assume this gate
subsumes the row-header defect above. It does not, and neither does `check-framing.ts`, which compares every
_written_ record against Excel's own length. `BrtRowHdr` was the right length throughout: a `u16` plus a byte
is three bytes and so is a byte three times. Only the bits inside were misplaced. A wrong layout of the right
length is visible against the specification and nowhere else, which is why `__tests__/row-header.test.ts`
asserts offsets rather than sizes.

### The same defect, the other way round

`BrtColInfo` cost four features — hidden, grouped, collapsed and best-fit columns — and its field table was
**correct**. The flag word really is one `u16`, laid out with room for all of them:

```text
bit 0     fHidden          bits 4-7   reserved1
bit 1     fUserSet         bits 8-10  iOutLevel
bit 2     fBestFit         bit 11     unused
bit 3     fPhonetic        bit 12     fCollapsed
```

The writer set one bit and stopped:

```text
.writeUint16(0x02)   // fUserSet, and nothing else — a fragment, not a statement
```

So `BrtRowHdr` lost three features to a wrong description and `BrtColInfo` lost four to a right one nobody
filled in. Between them, **seven entries left the loss list without a single record being added.** Neither gap
was in the format.

Two details in the fix are worth keeping:

- **`fUserSet` cannot be decided from whether a width exists.** `setModel` fills the default width into every
  column it normalises, so by the time the writer runs, an author's width and a default are both numbers. The
  model records the distinction as `isCustomWidth`, and claiming `fUserSet` without it pins a merely-hidden
  column to the default width forever.
- **A column with flags and no width used to be skipped outright**, so a hidden column with no width of its
  own produced no `BrtColInfo` at all — the flags had nowhere to live, which is a large part of why the feature
  looked unsupported.

One thing that looked like a third bug and is not: **`collapsed` is derived, not stored.**
`columnCollapsed` returns `outlineLevel >= worksheet.properties.outlineLevelCol`, and that property defaults to
0 — so every grouped column reports itself collapsed unless the sheet declares an outline depth. That is the
model's own long-standing semantics, with a test of its own, and the writer is faithfully reflecting it. The
column tests raise the threshold to assert the outline level in isolation rather than "correcting" a model
this module does not own.

### Read/write symmetry, and the hole that had no name

The list below reports what a **write** drops. There was no equivalent for reading, and that asymmetry hid a
worse failure than any entry on it.

A feature the writer emits but the reader does not model is written correctly the first time, comes back
**absent from the model**, and is _deleted by the second write_ — with the loss report saying nothing, because
from the writer's point of view the model it was handed genuinely had no such feature. Measured when this was
first checked:

```
conditional formatting, first write:  4 records
                        read, rewrite: 0 records
                        loss report:  none
```

A read-modify-write deleted part of a workbook and reported success. Auto filter criteria did the same. Both
have readers now, and `xlsb/__tests__/read-write-symmetry.test.ts` is the gate: it lists every feature as
either surviving a round trip or not, fails if the two lists do not together account for every feature, and
**asserts the defect** for anything in the second list — so a feature that gains a reader fails the test,
which is the signal to move it. `LOSES_ON_READ` is empty today and kept for that shape.

Three things that gate found, none of which a record count would have:

- **A rule came back without its format.** `dxfId` is an index into `styles.bin`, which nothing parsed, so the
  next write found a rule with no `style` and wrote "no format". The rule then fired and displayed nothing —
  harder to notice than a missing rule, because Excel still lists it in the conditional-formatting dialog.
  `readDxf` reverses the nine `XFProp` facets, and the index is resolved and then _dropped_: the model holds a
  `style`, and an index into a table the next write rebuilds is a field nothing reads.
- **An unterminated collection swallowed the rest of the sheet.** The criteria reader first collected
  everything between `BrtBeginAFilter` and `BrtEndAFilter`; a file missing the end — which this writer cannot
  produce but a reader must survive — lost the conditional formatting, validations and page setup that
  followed. The cells escaped only because they come _earlier_ in the part, which is luck. It now collects the
  thirteen records it understands and nothing else, so an unterminated collection costs the criteria alone.
- **The inverse enumerations are derived from the forward ones**, not listed again. A reader with its own copy
  of `CFOper` is a second place for "1 means between" to be wrong, and it would be wrong in a way no test
  comparing reader against writer could see — both would agree. The same applies to `fAnd`, which is inverted
  in the record: reading it as written turns every AND into an OR.

One narrowing is real and named rather than hidden: a conditional-formatting rule comes back **without its
`formulae`**. Decoding an `Rgce` token stream to formula text needs the reverse of `encodeParsedFormula`, which
does not exist here. A `cellIs` rule therefore returns with its operator and no operand. Inventing a plausible
one would be worse — the rule would look complete and evaluate differently.

`priority` also does not come back as it went in, and that is deliberate: `iPri` MUST NOT duplicate another
rule's anywhere in the workbook, so the writer assigns it. The rule keeps _a_ priority for the next write to
renumber from.

### What it cannot do yet

Everything in this list is **reported** when a workbook needs it, so the gap is visible at the point
it costs something rather than discovered later in Excel.

- **Array constants** inside a formula. Refused by name rather than encoded as something else.

  **Structured references and whole-row/whole-column references are no longer refused** — the first
  needed `PtgList`, the second only a lowering step. Both are described below.

- **Streaming writes, in both containers.** `Workbook.toBuffer`, `writeFile` and `toStream` accept
  `format: "xlsb"`, `read`/`readWithDiagnostics` detect it, and `createStreamWriter` now takes
  `format: "xlsb"` as well — rows are encoded and handed to the ZIP as they are committed, so
  `pnpm benchmark:xlsb-scale` writes ten million cells to a 95 MB `.xlsb`.

  **Two reasons were given here for why this could not be done, and both were wrong. They are recorded rather
  than quietly replaced**, because each was believed for a while and the way each failed is the useful part.

  The first was that the shared-string and style tables "are interned while the sheets are written and emitted
  after them, which a single forward pass cannot do without buffering the sheet anyway". Both parts are written
  at the _end_ of the package in either container, and the XLSX streaming writer already does exactly this. Never
  the obstacle.

  The second was `BrtWsDim`: it precedes the rows and states the used range, so a forward pass cannot fill it in.
  That much is true. What was unobserved was whether Excel _needs_ it — it writes the record in all 67 worksheet
  parts across the corpus, and this library's validator accepting a part without one proves nothing about Excel.
  It was settled by building a package with the record removed from every sheet and opening it: Excel opens it
  without a repair. So the streaming path omits it and nothing else, which
  `stream/__tests__/streaming-xlsb.node.test.ts` asserts by comparing a streamed sheet part against a buffered
  one record for record.

  The third reason was real and was the actual work: `writeXlsbPackage` orchestrated content types, relationship
  numbering, part numbering, drawings and pivot caches in one pass over a finished model. It now accepts
  `streamed: { sheetPaths, strings, formats }` — the sheet parts a streaming caller has already written, and the
  interning tables their records index into. So there is still one package writer, and a streamed workbook and a
  buffered one differ in one record rather than in a hundred small ways.

  **What is bounded and what is not.** Rows are: nothing is collected, and the measured live heap for a streamed
  XLSB matches the streamed XLSX exactly (103 / 146 / 191 MB against 103 / 147 / 192 MB at 100k-row intervals).
  Both grow by roughly 450 bytes per row, and the reason is the API rather than either writer — `Stream.commitRow`
  is synchronous, so a producer in a tight loop outruns the disk and the difference queues in the output stream.
  The shared-string and style tables are _not_ bounded, and are bounded by distinct values rather than by cells:
  the same position the XLSX streaming writer is in. Distinct strings are the one thing XLSB cannot stream
  unbounded, because `BrtCellIsst` reaches a string through the table; XLSB does define an inline-string cell
  (`BrtCellSt`) and it is not used, because Excel writes it in none of the corpus's files.

  A streamed XLSB write measures about 1.8× the time of a streamed XLSX write. That is a real characteristic
  rather than a rounding difference, and `pnpm benchmark:xlsb` reports it rather than a workload chosen to hide
  it.

- **Streaming reads, in both containers.** `Stream.WorkbookReader` decodes `.bin` worksheet parts record by
  record and yields the same `row` events the XML path does, so a caller writes one loop either way. It is a
  subclass rather than a parallel reader: everything a caller touches is `WorksheetReader`'s and only `parse()`
  differs.

  Three things a streamed binary read does not surface, measured against the buffered reader rather than assumed:
  a formula arrives as its **cached value** (decoding the tokens needs the workbook's names and table indices),
  rich text arrives **flattened** (the runs live beside the text in the shared-string table), and everything
  after `BrtEndSheetData` — merges, conditional formats, panes, page setup, hyperlinks, comments — is absent,
  because a forward reader has already emitted the rows those records would attach to. A merged region's
  continuation cells therefore stream as empty. The XML streaming reader has the same last limitation for the
  same reason.

- **Shared and array formulas are written**, and this is where a stale "cannot" cost the most. Two reasons had
  been recorded for refusing them and both had expired:

  - `PtgExp` "needs the master's address — information the flat cell model does not carry". The model carries
    exactly that: `sharedFormula` _is_ the master's address.
  - `BrtArrFmla` "does not appear in any reference workbook, so its layout is not established". True of the
    nine-workbook corpus that was written against; the current one has `poi-bug66682.xlsb` with a `BrtArrFmla`
    and `poi-62815.xlsb` with four `BrtShrFmla`, and both close to the byte against the field lists.

  Fixing it surfaced a defect on the _read_ side that had been silent throughout: `PtgExp` was decoded as seven
  bytes — token, four-byte row, two-byte column — and it is five. The column is a `PtgExtraCol` in `RgbExtra`,
  which the reader never read at all. So every shared formula in every real file failed to decode and was
  reported as "could not be decoded", and a test with a seven-byte fixture kept the pair self-consistent.

  **The general lesson is worth more than the fix**: nothing re-examines a refusal when the evidence behind it
  changes. Three of this container's "cannot" entries were expired at once — this, `BrtArrFmla`, and the `BErr`
  table below — all because the corpus grew after they were written.

- **Rich text is written.** A `RichStr` carries the runs, and each run's font is interned into the _styles_
  part's `BrtFont` collection, which is what `ifnt` indexes. That reach was the real obstacle: the shared-string
  table could not see the font table, so a run could only have named a font some cell happened to use.

- **Error values are written.** `BErr` is an eight-value table (MS-XLSB 2.5.98.2) and Excel's own files confirm
  four of them — `0x07` `#DIV/0!`, `0x17` `#REF!`, `0x1D` `#NAME?`, `0x2A` `#N/A`. What is still refused is an
  error with no `BErr` code at all: `#SPILL!`, `#CALC!` and the rest of the dynamic-array family postdate the
  enumeration, and substituting `#VALUE!` for one would be a different error rather than a reported loss.

- **Future functions are written.** `XLOOKUP`, `TEXTJOIN`, `CONFIDENCE.T`, `LET`, `SEQUENCE` — anything the
  `Ftab` has no id for is called the way Excel calls it: a `PtgName` naming a hidden `_xlfn.*` stub, then the
  arguments, then `PtgFuncVar` with `tab = 0x00FF` and a `cparams` that **counts the name**. The stub itself is
  a defined name with `fHidden | fFunc | fProc | fFutureFunction` and a body of `PtgErr(#NAME?)` — flags
  `0x0002000b` and rgce `1c 1d`, byte-identical to Excel's. The `_xlfn.` prefix never reaches a caller: a read
  gives back `XLOOKUP(…)`, which is what was written and what the XML container stores.

  **Pivot tables are written — including ones read from an XLSX.** A pivot created through `Pivot.add` carries a
  live source worksheet; one _read from a file_ does not, and `pivotParts` tested for that worksheet and returned
  `undefined` without it. So every XLSX→XLSB conversion dropped its pivot tables, and the `continue` that did it
  recorded nothing at all — `unsupported: "error"` did not even refuse. The reader already normalises the parsed
  form into `cacheFields` and `cacheRecords`, which is the same information resolved, so the conversion needed no
  new knowledge; it needed the writer to stop asking the wrong question.

  A newly created pivot table becomes four things: `BrtBeginPivotCacheID` records
  in the workbook binding each cache to its part, `pivotCacheDefinition{n}.bin` describing the source range and
  its fields, `pivotCacheRecords{n}.bin` holding one record per source row, and `pivotTable{n}.bin` — the view,
  with its pivot fields, axis membership and data items. Five parts on disk once the two `.rels` are counted, and
  relationships at three levels: sheet → view → cache definition → records.

The record order is **MS-XLSB section 3.8**, a fifty-seven step byte-level worked example. An earlier version of
this document said no such authority existed for pivot tables while relying on section 3.4 — the filter example
in the same chapter — three paragraphs earlier. That is recorded below rather than quietly fixed.

**It could not be delivered in stages, and that shaped the work.** The specification requires one cache
definition part _per_ `BrtBeginPivotCacheID` record in the workbook, so a package carrying the binding without
the parts points at something that is not there. The four encoders were therefore built and unit-tested
against the field tables first and wired into the package writer last, in one step.

### Five cross-part invariants, each asserted end to end

None of these can be checked from a single part, and none produces an error when broken — which is why they
are the tests that matter most here:

| Invariant                                                       | What breaking it does                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `idSx` (workbook) = `idCache` (view)                            | The view refers to a cache filed under another id; the table shows nothing                        |
| `cRecords` (definition) = `BrtPCRRecord` count = records header | A reader stops early or runs past the collection                                                  |
| `csxvds` (view) = `BrtBeginPCDField` count                      | Axis collections index into `BrtBeginSXVDs`, so every index after a gap points at the wrong field |
| every cache-record index < its field's `citems`                 | A corrupt record, not a lossy one — the reader follows the index into whatever is at that offset  |
| `citems` = the `BrtPCDI*` records written                       | Same                                                                                              |

### Four layout traps

- **`BrtBeginPivotCacheDef`'s `unused` tail exists _if and only if_ `fLoadRefreshedWho` is 0.** It reads as a
  presence flag and behaves as padding, so omitting both leaves the record four bytes short and misaligns
  every field after it. The test asserts the record's _length_, not the flag.
- **`BrtBeginSXDI`'s field table does not add up.** Three consecutive rows are all called `ifmt` plus a
  `reserved`; summing them gives 27 where the worked example declares `0x3B` for a 34-byte caption. The
  `reserved` word is _inside_ the four-byte `PivotNumFmt`, not beside it — two bytes too many makes every
  record after it in the part unreadable.
- **Two of `BrtBeginSXView`'s presence flags are inverted.** `fDisplayData` says `irstData` _is_ present and
  MUST be 1; `fEmptyDisplayErrorString` and `fEmptyDisplayNullString` say their strings are _absent_. Reading
  the pair as ordinary "has a value" flags produces a record whose strings come out of what follows it.
- **The aggregation enumeration is not the model's order.** `count` is 1 and `countNums` is 6 in the record,
  which is not how OOXML's `ST_DataConsolidateFunction` lists them. A mapping by position swaps the two and the
  pivot table quietly reports a different number. All eleven are asserted.

Two deliberate choices worth knowing. The **shared-item flags are derived from the items**, not from the
model's `containsNumber` and friends: those are preserved _XLSX_ attribute strings and may be absent, while
`BrtPCRRecord` has no per-item tag and a reader types its inline values from exactly these flags. And the
**pivot lines are a single grand-total line** rather than the full expansion — the layout is what Excel
recomputes on refresh, and the cache is written with `fRefreshOnLoad` so it does. Enumerating them would mean
reproducing Excel's subtotal and nesting rules to produce something it discards, which is what the XLSX writer
avoids the same way with `<rowItems>`.

### The mistake, recorded

This document previously said the record order could not be known: the per-part ABNF grammar
(`Biff12PivotTableGrammar.abnf`) ships with Microsoft's internal build rather than the specification, and no
corpus workbook contains a pivot table — 0 of 23. Both facts are true and the conclusion was wrong, because
section 3 is titled "Structure Examples" and contains ten byte-level walkthroughs, one of them for exactly
this. **The absence was asserted about a document that was open at the time, without reading its table of
contents** — and the filter records had already been built from section 3.4. Two conclusions of the form "the
format cannot express this" were reached in this work and both were wrong, the other being the protection
password; in both cases the evidence was one search away.

A pivot table read from XLSB is still carried through as opaque bytes rather than modelled — this reader does
not parse the binary pivot parts — so a read-modify-write preserves it byte for byte, which
`xlsb/__tests__/pivot-preservation.node.test.ts` pins by injecting payloads this writer could not have
synthesised.
failing anything.
failing anything.

**Watermarks are written, both modes**, and the entry that said otherwise was wrong twice over. There is
no _text_ watermark in this model to lose: `WatermarkOptions` requires an `imageId`, and text becomes a
watermark upstream by being rasterised into a translucent image, so the loss list was naming a feature
that does not exist — its fixture, `{ watermark: { text: "DRAFT" } }`, was the only place in the
repository that shape ever appeared. Meanwhile a _header_-mode watermark had been written correctly all
along and was still reported as lost, which told a caller to expect a missing picture that was in the
file.

The real defect was underneath: an **overlay** watermark was collected with the header pictures, so it
was written into the header/footer VML. It came back as a `headerImage` in the centre of the page header
with its opacity dropped — a picture behind the cells had become a page-header decoration. That is not a
lossy write but a _different document_, and it was invisible precisely because the result was valid.
`buildWatermarkOverlayAnchors` in `utils/drawing-utils.ts` now serves both writers, and the test compares
the two containers' drawing parts rather than either one against itself: same `alphaModFix`, same
absolute anchor, same image relationship.

**Conditional formatting is complete** — the rules and the formatting they apply. A rule's format is a
`BrtDXF`: a **differential** format, meaning a set of overrides rather than a complete style, encoded as a
flag word and then an `XFProps` — a counted array of `XFProp`, each a type, a size and a blob whose shape
the type decides. Fourteen of the thirty-eight types are written, which is everything a `Style` can
express here: the fill pattern and both its colours, the text colour, the font name, bold, italic,
strikethrough, the size, all four border edges plus the diagonal, and the two diagonal directions.

Four details in that record fail silently and are asserted for it. **`cb` is the size of the whole
`XFProp`, header included**: writing the blob length instead makes every property after the first land
four bytes early, and a reader does not detect that — it reads a plausible type out of the middle of a
colour, so the test asserts the walk _closes_ exactly on the payload length. **`Bold` is an enumeration**
— `0x0190` normal, `0x02BC` bold — so the boolean the model holds cannot be written through; a `1` there
is neither value and reads as a font weight of one. **`LongRGBA` is red-green-blue-alpha**, not the order
the `argb` string spells, which is a channel rotation rather than a visible error. And an
**`XFPropBorder`'s `dgBorder` comes from the same table a `BrtBorder` edge uses** (`borderStyleValue`),
because two copies of those fourteen style names in two orders is how one of the two places ends up
writing `medium` for a caller who asked for `thin`.

Types `0x0B` and `0x0C` — a range's _internal_ borders — are deliberately never written, and `fNewBorder`
stays clear to say so: they are gated by that flag and a cell style has no such thing. The properties are
sorted by type, which the specification does not require (it constrains which types may _coexist_, not
their sequence) but Excel does, and a needless deviation is one more thing a reader could be strict about.

The rules themselves were worth the care. **A rule's shape is decided by a _pair_ of enumerations**:
`iType` says how the formatting is drawn, `iTemplate` says what the condition is, and MS-XLSB lists the
legal combinations with "other combinations MUST NOT be used". The model folds five conditions —
`containsText`, `containsBlanks`, `containsErrors` and their negations — onto one type distinguished by
an operator, where the record has five templates; and `CFOper` starts at **1**, so an off-by-one turns
"greater than" into "not equal". Both are asserted against the specification's own table, because both
fail silently. Three more details the same way: `fAbove` is derived from the template rather than read
from the model, so the two cannot contradict each other; `rgce2` exists only for `between`/`notBetween`,
and a second stream for any other operator makes a reader misparse everything after it; and `iPri` must
be unique across the sheet, while the model's priorities are per block and routinely collide — so the
writer hands them out.

**Sparklines came off this list**, and they are the only feature here built entirely from _future
records_. A future record opens with an `FRTHeader`: four flag bits saying which of four optional blocks
follow — and for a sparkline the blocks _are_ the content, so the cell it occupies is an `FRTSqrefs` and
the range it plots is an `FRTFormulas`. The nesting is where it goes wrong quietly: `FRTSqrefs` counts
`FRTSqref`, and each `FRTSqref` holds an `UncheckedSqRfX` that counts ranges _again_ — two levels, both
required to be 1, with `rwFirst == rwLast` because a sparkline occupies one cell.

Two details are pinned by tests because each is silent. `fShowEmptyCellAsZero` is a **two-bit
enumeration**, not a flag, so reading it as one bit turns "span" into "gap". And the data range must be a
`PtgArea3d`: an unqualified `A1:C1` parses to a plain `PtgArea`, which this record does not accept, so
the sheet name is added when the model leaves it off.

**Charts came off this list**, and the estimate that kept them on it was wrong in an instructive way.
`chart` appears 434 times in the XLSX writer, which reads like a subsystem to port — but a programmatic
chart goes through `Chart.add` → `addChartEntry`, which puts a `{ chartNumber, model }` entry on the
_workbook_, and one helper renders that entry to XML. The other 434 references are the reading path and
the chart engine, neither of which a writer needs. Counting references was a proxy for difficulty and a
bad one.

A chart part is XML in **both** containers — `cal-any_sheets.xlsb` carries `xl/charts/chart1.xml`
beside its `.bin` chartsheet — so nothing was translated, and a test asserts the two writers produce
byte-identical chart XML. Two details are easy to get wrong and are pinned: an absolute chart anchor's
position is **EMU in the model and pixels in the anchor** (`PosXform` multiplies by
`EMU_PER_PIXEL_AT_96_DPI`, so passing EMU through overshoots by 9525×), and a chart's relationship comes
from the **drawing** rather than the sheet, because the `graphicFrame` names it.

**Chartsheets** followed immediately, and cheaply, because the chart parts were the expensive half. The
sheet is ten records — asserted against `cal-any_sheets.xlsb`'s own stream, not against a field list —
and everything else comes from the XLSX writer: the chart, the drawing and both sets of relationships.
Two things had to be right and neither is obvious. The drawing uses an **absolute** anchor with concrete
EMU extents, because a chartsheet has no cell grid and a cell-based anchor resolves to 0×0 — Excel then
renders a blank canvas. And `BrtBundleSh` carries a **relationship id**, which this writer derived from
the bundle position: a chartsheet follows the worksheets in that sequence, so every chartsheet pointed
at a worksheet — a tab labelled "Chart1" whose contents were a grid.

**Shapes and threaded comments came off this list**, and for opposite reasons that are worth
contrasting. A threaded comment has no BIFF12 form _at all_ — the part is XML in both containers — so
supporting it meant writing the XLSX renderer's output into the package and adding two relationships,
with nothing translated. A shape needed no new record either, but because it is an _anchor in the
sheet's existing drawing_: the writer had none only because `drawingForWorksheet` filtered for
`type === "image"` and returned early, and the anchoring arithmetic lived inside the XLSX worksheet
xform where nothing else could reach it. It is `buildShapeAnchors` now, and both writers call it.

**Form controls** followed the same route and are worth a note of their own, because a control is
_three_ parts: a hidden DrawingML anchor that bridges to a VML shape by `spid`, the VML that draws it,
and an `xl/ctrlProps/ctrlPropN.xml` holding its properties. The VML is **shared with comments** — Excel
writes one `vmlDrawing{N}.vml` per sheet holding both a note's box and a checkbox's shape, and the sheet
has one `BrtLegacyDrawing` — so writing a second file would leave one of them unreachable. The mistake
worth recording: the VML _relationship_ was emitted only when the sheet had comments, so a checkbox on a
sheet with none reached Excel with its VML present and nothing pointing at it.

Nothing narrower remains on the sheet side. Multiple worksheet and workbook views, chartsheets, auto
filter criteria and **protection passwords** were all on this list and are now written.

**The password is worth recording as a mistake, not as a feature.** This document claimed for some time
that it was _physically impossible_: `protpwd` in `BrtSheetProtection` is a 16-bit verifier, the model
holds a SHA-512 hash, and a hash cannot be reversed into the plaintext the verifier algorithm needs. Every
one of those statements is true. The conclusion did not follow, because `protpwd` was never the only place
a password can go — **`BrtSheetProtectionIso` and `BrtBookProtectionIso` exist precisely for the ISO/IEC
29500 form** and carry the salt, the algorithm name, the hash bytes and the spin count _verbatim_. Nothing
has to be reversed because nothing has to be computed: the hash is copied across.

What makes it a mistake rather than an oversight is that the evidence was already in the repository. The
868-entry record-name table in `xlsb/spec/record-names.ts` contains both records, and a single search for
`Iso` finds them. The reasoning went from the one record that had already been implemented to a conclusion
about the format — the same error as judging a feature's difficulty by counting how often a word appears in
the source. A test asserted the wrong conclusion back for as long as it stood, which is what that kind of
test is for and why it is worth naming here.

The pairing is specified rather than guessed, which matters because no corpus workbook has a password: an
Iso record **MUST be immediately followed** by its legacy record, whose verifier is 0 and whose sixteen
permission Booleans are identical. Both facts are asserted — the ordering, and that all sixteen values
match — and the permissions come from one shared table, because two copies of a sixteen-entry list with
defaults attached is the reliable way to end up with two that disagree.

One detail fails silently and is handled for it: the model stores the hash and salt the way OOXML does, as
**base64 text**, while the records want the bytes. Writing the base64 characters would produce a hash of
the right shape and the wrong value, which no reader can detect — the password would simply never match.

**AutoFilter criteria** are worth a note, because what unblocked them was neither a new record nor a new
sample. The range was always written; the criteria were declared unwritable because the model has no
structured representation of one — the XLSX reader keeps the `<filterColumn>` elements as **raw XML** and
the XLSX writer replays them verbatim, which is what makes that round trip byte-exact. The apparent fix
was to model criteria in `core/`, which would have meant the XLSX writer re-serialising from that model
and trading the fidelity of the format that already works for the sake of the one that did not. The actual
fix was to notice that the XML _is_ the data: `xlsb/filter-criteria.ts` parses it and emits records, and
the XLSX path is untouched. There is no public setter for a criterion — one only ever arrives from a read —
so nothing is lost by treating the preserved XML as the source.

The record order is not guessed either. **MS-XLSB section 3.4 is a byte-level worked example of this exact
sequence** — `BrtBeginAFilter`, `BrtBeginFilterColumn`, `BrtBeginCustomFilters`, `BrtCustomFilter` and the
matching ends — which is the authority pivot tables lack.

All seven criterion kinds the XLSX reader can preserve are written: values, date group items, custom
comparisons, top-N, dynamic, colour and icon. What remains reportable is a schema _extension_ — an
`extLst` inside a filter column — and because the XML is parsed the loss report names the element it could
not express instead of condemning every criterion the moment one appears. A column whose only criterion was
declined is skipped rather than emitted empty, and the range survives regardless: dropping it would be a
larger loss than the one being reported.

Four more traps in the three dynamic kinds, each asserted:

- **The dynamic filter enumeration has a hole in it.** `aboveAverage` and `belowAverage` are 1 and 2, and
  the date periods resume at **8** — 3 through 7 are unassigned. An array indexed by position in the
  schema's list gives `tomorrow` a value with no meaning and every period after it the wrong one.
- **`cellColor` is absent-means-true**, like `showButton`. `<colorFilter dxfId="0"/>` filters by _fill_
  colour, so reading it as a plain flag inverts every fill-colour filter into a font-colour one.
- **An unmappable kind is declined, never approximated.** `CFTNIL`, a `KPINIL` icon set and a `dxfid` of
  `0xFFFFFFFF` are all records that specify _no filter_ — writing one turns a reported loss into a filter
  that silently does nothing.
- **A date group item's field widths are not uniform**: `dom` is four bytes while `hour` is two. Assuming
  otherwise shifts every field after it by two.

A note on how this came to be written twice. An open pull request in this repository — a separate,
independent XLSB implementation — already covered the ISO protection passwords and all seven filter kinds.
This work did not know that, because it was researched against `[MS-XLSB]` and the corpus and never against
the repository's own branches. The password claim in particular was contradicted by an open PR while this
document called it physically impossible. The lesson is cheap to state and was expensive to learn: check
what the project already has before deciding what the format can do.

Two details in those records fail silently and are asserted for it. **`fAnd` is inverted**: MS-XLSB gives
`0x00000000` for AND and `0x00000001` for OR, while the XML spells the same thing as `and="1"`, so passing
the attribute through swaps AND for OR on every two-criterion filter — a filter that shows the wrong rows
rather than a file that fails to open. And **`showButton` and `hiddenButton` have opposite defaults**:
`hiddenButton` is absent-means-false but `showButton` is absent-means-**true**, so reading the second as a
plain flag sets `fNoBtn` on every column and hides every dropdown button in the sheet — a filter that is
in the file and cannot be reached from the interface. That one was a real bug, caught by decoding the
bytes rather than by a test that agreed with the code.

**Array constants** in formulas are still refused. **Structured references are not** — see below.

Frozen and split panes (`BrtPane`), page breaks (`BrtBrk`) and data validation (`BrtDVal`) **were**
on this list and are now written and read. What moved them was not a new sample but the realisation that `[MS-XLSB]`
documents the layouts, and that the corpus is twenty-three _test fixtures_ rather than a sample of
what people build: a frozen pane and a page break are things a person sets deliberately, so their
absence from a fixture set says very little. Both carry a caveat worth knowing —
`BrtPane`'s two `Xnum` fields are **crossed** relative to XLSX's `xSplit`/`ySplit`, and they hold a
twip position for a split pane but a row or column count for a frozen one. A round trip through
this library cannot check either fact, because the reader and the writer would agree with each
other while both disagreed with Excel, so the tests assert the byte layout against the
specification's field order and its own worked example instead.

Data validation was the largest of the three, because the record is four parts and three are
variable-length: a signed range count, four strings, and two token streams. Two details in it are
worth knowing because both fail silently. `DValStrings` orders the **error** pair before the prompt
pair, so swapping them puts a validation's tooltip in its error alert. And a validation's bounds are
`Ptg` token streams rather than text — the first version of the reader returned them as an empty
array and reported them unreadable, which was the wrong call twice over: the decoder already existed
for cell formulas, and `{ type: "whole", operator: "between", formulae: [] }` is not a partial rule
but a rule Excel accepts every entry against. A reader that produces one has quietly turned a
constraint off, which is worse than admitting it dropped the validation.

Comments went the other way, and are the one feature here **verified against Excel's own bytes**:
`poi-comments.xlsb` and `poi-testVarious.xlsb` carry fourteen between them, so every layout claim —
the deduplicated author table, the 36-byte anchor, the `RichStr` with its run table, the all-zero
GUID, even the `application/vnd.ms-excel.comments` content type — was read out of a real file rather
than taken from the specification alone. The tests assert the corpus cases directly, not only through
a round trip, because a round trip cannot tell a correct reading from two matching mistakes.

The thing that makes a comment bigger than its records: **it is three parts of the package, not
one.** The text is in `comments{N}.bin`, the _box_ is legacy VML in `xl/drawings/vmlDrawing{N}.vml`,
and the sheet needs a `BrtLegacyDrawing` naming the relationship to that VML. Write the records
without the VML and Excel opens the file with the comment data present and nothing on screen. The
VML is rendered through the XLSX writer's own xform rather than reimplemented, because legacy VML has
no binary form and is byte-identical between the two containers. What does _not_ survive is a run's
font: `ifnt` indexes the styles part, which is written after the comments, so the run _segmentation_
is kept — where a byline ends and the body begins — and the formatting is reported as lost.

Tables came last of the four and are their own _part_, `xl/tables/table{N}.bin`, reached by a
relationship from the sheet — nothing in the worksheet's record stream names one. No corpus workbook
has a `BrtBeginList`, but MS-XLSB carries a **worked byte-level example** for both records, which is
better evidence than a field list: the example's `BrtBeginListCol` is 0x38 bytes and the arithmetic
closes at `24 + 4 + 12 + 4 + 4 + 4 + 4`, pinning the field order and the four-byte width of a null
`XLNullableWideString` together. Three traps, all silent: `ilta`'s enumeration order is **not** the
model's (two pairs transposed, `sum` three places off, so an index-for-index mapping turns an average
into a count); `stName` is NULL for a standard table and the header text lives in `stCaption`; and a
`DXFId` of "none" is `0xFFFFFFFF`, because zero is a real index into the differential-format table.

A table's _data_ is not in the table part — MS-XLSB 2.1.7.51 says it stays in the worksheet — so the
reader rebuilds `rows` from the cells. It has to: `tableSetModel` reads a model with fewer rows than
the sheet as a table that has **shrunk** and blanks the difference, so an empty `rows` deleted every
cell in the data region. The parity suite caught that, and then caught the follow-on — counting the
totals row as data made the table one row taller and stamped a second totals row over the cells
below it.

Then the run that emptied most of the list, and its lesson is worth more than any single feature:
**most of what was "missing" was a record already being written with its fields hard-coded.**
`BrtSheetProtection` was an opaque 66-byte blob — and the note beside it read "assembling it produced
64 bytes where Excel writes 66", which is exactly the bug: the missing two are `protpwd`, a `u16` that
comes _first_. `BrtBeginWsView` wrote a literal `0x039c` and reached the right length by a different
route, with `icvHdr` as a `u32` where the specification has a `u8`; the bytes were identical to Excel's
only because 64 and 100 happen to fit. `BrtWsFmtInfo`'s last two bytes were a zeroed `u16` and are
`iOutLevelRw`/`iOutLevelCol`. `BrtCalcProp`'s `fIter` is bit 2. `BrtBorder` was 51 zero bytes.
`BrtName` forced every name to workbook scope, which is why **print areas and print titles** were on
the list at all — they are `_xlnm.*` defined names, not records, and were stuck behind that.

Along the way: a multi-range defined name needs **parentheses** (`(A1:B2,C3:D4)`), because a bare comma
is not a union in Excel's grammar; a whole-row reference needs no new token, only a lowering step to
`PtgArea` with the other axis pinned — and reading it back as a range rather than as `$1:$1` produces
something that computes the same and is _not a valid print title_; and `encodeColor(undefined)` writes
the _automatic_ colour, which is right for a font and wrong for a border, where Excel writes zeros.

**Structured references** (`Table1[Column]`) work now, which makes the tables above usable from a
formula. `PtgList` carries an `idList` and column indices _relative to the table_, so the ids are
assigned before any sheet is written — a formula on sheet 1 may name a table on sheet 3. One
normalisation is visible to a caller and is asserted rather than hidden: `Table1[[Qty]:[Note]]` comes
back as `Table1[[Qty],[Note]]`, because both parse to the same AST node and XLSB stores tokens where
XLSX stores text.

Two other things that run deeper than the feature list. Refusing a formula used to report a bare
`A1: formula`; the encoder names the construct and that name was being **swallowed by a `catch`**, so
every unencodable formula produced the same message. And `applyCellFormat` and `styleAt` assemble a
cell's style _separately_ — which is how borders came to work on a row and not on a cell.

- Error values, on both sides. `BrtCellError` and `BrtFmlaError` have a declared shape — a cell then
  a one-byte code — and **no workbook in the corpus contains either record**, so the mapping from
  `#DIV/0!` to a code is unobserved. On read the cell becomes a blank and the address is reported;
  on write the formula is kept with an unevaluated cached value, because Excel recalculates on open
  and dropping the expression to protect a value that is about to be replaced would be the worse
  trade.
- Chartsheets. Read as an empty worksheet so nothing after them shifts, and reported.
- Cell comments, row and column hidden/grouped/collapsed state, best-fit columns, workbook
  protection, workbook and worksheet view settings, named cell styles, and the page-setup fields
  outside the established subset. Each is reported, by sheet or by workbook.
- Formatting runs on a rich shared string. The text survives — dropping the string because it was
  bold would be worse — and the runs are reported on read.

Document properties, by contrast, **are** preserved: `docProps/core.xml` and `docProps/app.xml` are
read and written, so the creator, title, company and dates survive a round trip. So does the
workbook's default font — written to font index 0, and recovered from it on read — and the theme, which
is written from the model on an XLSX→XLSB conversion and preserved verbatim on an XLSB one.

A reference across a span of sheets (`SUM(Sheet1:Sheet3!A1)`) is written as a span. That needed a
`BrtExternSheet` entry whose `itabFirst` and `itabLast` differ: the entry layout is established from
Excel's output, the differing pair is an inferred _value_, and it is registered as one. The alternative
was what this used to do — emit the first sheet's entry, turning the formula into `SUM(Sheet1!A1)`, which
is not a fidelity loss but a different answer.

**A sheet has at most one drawing**, so adding a picture to a sheet whose existing pictures came from an
XLSB read is refused rather than written: a second drawing part would leave the sheet naming only one of
the two, and the other's pictures would vanish. Under `unsupported: "ignore"` the pictures that were
already there win.

- Some _values_ are written into an established layout without ever having been observed. Every
  font in the corpus is regular weight with `grbit` = 0, so `BrtFont`'s bold and italic **fields**
  are established while their "on" state is not — those values come from the documented
  convention the XLSX form of the same attribute uses. An offset read off Excel's own bytes and a
  value taken from a convention are different kinds of claim, so they are kept apart: the
  inferences live in one register (`INFERRED_VALUES` in `xlsb/spec/records.ts`) and
  `spec.test.ts` pins each of them against the table, so a value cannot be added without one. A single workbook
  with one bold and one italic cell would settle all eight.
- Seven cell records — `BrtShortBlank`, `BrtShortRk`, `BrtShortError`, `BrtShortBool`,
  `BrtShortReal`, `BrtShortSt`, `BrtShortIsst` — have no established payload layout, and the
  evidence for them is thinner than that phrasing suggests: **`[MS-XLSB]` 2.4 does not list ids
  12–18 at all.** The names come from community reverse engineering, not the specification, which
  `spec/record-names.ts` states explicitly by keeping them in `RECORDS_ABSENT_FROM_SPEC` rather
  than beside the 868 records the specification does name. They also appear **zero** times across
  the twenty-three pinned corpus workbooks, eighteen of them Excel-authored, all of which used the
  full `BrtCell*` forms. The reader recognises them, counts them and reports them rather than
  guessing an offset or dropping the cell; the writer never emits them. `spec.test.ts` asserts that
  every name on that list really is a cell record with no declared layout, so the gap cannot be
  closed by deleting the list.

### Runnable examples

```bash
pnpm example --filter xlsb-round-trip   # values, dates, formulas, defined names, cross-sheet refs
pnpm example --filter xlsb-formatting   # fonts, fills, alignment, protection, page setup, tab colour
pnpm example --filter xlsb-fidelity     # what is preserved, what is reported, and the 1904 epoch
```

The second of these found a bug the test suite did not: a header row styled as a row, plus one cell
in it wanting a rotation, is a shape that does not arise when you write tests a feature at a time.
Row formatting was being applied _after_ the cells, so it overwrote what each cell had declared for
itself — inverting the format's own rule, in which a cell's `iStyleRef` wins over its row's `ixfe`.

### The reference corpus, and how to get it

```bash
pnpm corpus:xlsb   # 23 fixtures into tmp/xlsb-corpus, every SHA-256 verified
```

Twenty-three `.xlsb` files pinned in `xlsb/corpus/manifest.ts` by upstream commit and digest — twelve
from [Calamine](https://github.com/tafia/calamine) and eleven from [Apache POI](https://github.com/apache/poi).
They are not committed: they are other projects' test fixtures, their licensing is not ours to assume,
and 283 KiB of third-party binaries does not belong in the published package. The gate that reads them
skips when the cache is absent, so a contributor who has not fetched it is never blocked.

**This replaced a `DOCUMONSTER_XLSB_CORPUS_DIR` pointing at a directory on one machine**, which was not
a corpus but a private note: nobody else could confirm a single offset asserted here, and nothing said
whether a later run used the same bytes. Pinning turns "read off Excel's output" from a claim into a
procedure.

Each entry carries an `authority`, and the distinction is load-bearing rather than descriptive:

| Authority       | Count | What may be asserted of it                                                                                                                                                   |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excel`         | 18    | Everything. These establish record layouts.                                                                                                                                  |
| `reduced`       | 2     | Readability. Hand-trimmed bug reports legitimately omit records every real workbook has.                                                                                     |
| `nonconformant` | 1     | Readability. `poi-Simple.xlsb` says "Microsoft Excel 2007 Beta 2" in its own properties and writes `iTabID` as 0 where the spec says the value MUST be between 1 and 0xFFFF. |
| `encrypted`     | 2     | That they are refused rather than mangled. OLE-wrapped, not ZIP packages.                                                                                                    |

Without that column a beta's mistake becomes evidence about the format, and the temptation is to widen a
codec to accept it — which is how a reader comes to accept two layouts and write a third.

**Adding the second upstream immediately paid for itself.** Two of this module's pinned "constant" record
sizes were constant only across Calamine's collection: `BrtCellBlank` is 8 bytes in eleven files and 9 in
`poi-62815.xlsb`, which is Excel 16.0 and conformant in every other respect. And two real bugs surfaced on
the first run — a malformed sheet record made a three-sheet workbook read back as having none, and records
inside a future-record wrapper were being read as though they were ordinary records, which invented a cell
at A282 wearing a cell format the workbook does not have.

The two are worth keeping. They are a five-part skeleton with a 31-byte worksheet that declares no
view — which is, almost exactly, the shape this library used to write. So they are simultaneously
evidence that a reduced package is readable and evidence of what an _unopenable_ one looks like,
which is why `record-missing-required` is a warning rather than an error: refusing them would be
refusing files this library reads correctly.

### Bugs the reference corpus found

Four silent correctness bugs were in this library's own output, and each was invisible to a round
trip for the same reason: the reader and the writer agreed with each other.

| Bug                                                                                                   | Why no test saw it                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A formula naming a defined name wrote a `PtgName` index into a `BrtName` table that was never emitted | Reading it back returned the cached _result_, so the value was right and the formula was gone                                                                                             |
| Every cross-sheet reference wrote an `ixti` into a `BrtExternSheet` table that was never emitted      | Same — and 3D references are far more common than defined names                                                                                                                           |
| `ixti` was resolved as a sheet index rather than through the table                                    | Self-consistent between reader and writer. In `issues.xlsb` the table's second entry names the _third_ sheet, so `OneRange` read as `issue2!$A$1` where Excel means `Sheet1!$A$1`         |
| Workbook relationships were written to `xl/_rels/workbook.xml.rels`                                   | OPC looks for `workbook.bin.rels`, so the sheets were unreachable through the only mechanism that reaches them — and the reader found them anyway by computing their paths arithmetically |

A fifth was found by the same means but is a fidelity gap rather than a break: a chartsheet makes
the worksheet part numbering non-contiguous, so resolving a sheet's part by position puts one
sheet's data on another. `any_sheets.xlsb` has its chartsheet last, where the error costs nothing;
one in the middle silently misplaces every sheet after it.

### Checked against Excel's own output

Every layout was established from Excel-authored workbooks — nine of them — rather than
assumed, and three were pinned by a value that could not be a coincidence: format id 14 on a date
cell, 2742 on a default column, and 0/1/2 on three sheets named `Visible`, `Hidden` and
`VeryHidden`.

That corpus also found a bug no synthetic test would have: two otherwise-identical workbooks, one
saved with the 1904 date system, read four years apart. `BrtWbProp` carries the epoch in bit 0 of
its flags, and a reader that ignores it is wrong by exactly 1462 days — a plausible-looking date
rather than an error, so nothing downstream notices.

The declared layouts were confirmed against those workbooks: `BrtCellRk` is
twelve bytes, `BrtCellIsst` twelve, `BrtCellBlank` eight, exactly as the table says. Doing that
also found four false positives that fifty-odd hand-built tests had missed, all of them the
same mistake — treating `.bin` as a format:

| Part                                      | What it actually is                        |
| ----------------------------------------- | ------------------------------------------ |
| `xl/vbaProject.bin`                       | an OLE2 compound document                  |
| `xl/printerSettings/printerSettings1.bin` | a DEVMODE struct                           |
| `xl/worksheets/binaryIndex1.bin`          | a record stream, but not a worksheet       |
| `xl/workbook.bin`                         | declared by a `Default`, not an `Override` |

A part's identity comes from its content type, so that is what the validator reads. The shapes
are pinned by `utils/__tests__/xlsb-validator/real-world-shapes.test.ts`, as synthetic packages
rather than vendored binaries. The same checks run against real files too, from the pinned corpus:
`pnpm corpus:xlsb` fetches it and `real-world-corpus.node.test.ts` reads it.

That last point is the whole posture of this module: a layout that has not been established is
recorded as unestablished. Guessing an offset produces a reader and a writer that agree with
each other and disagree with Excel, which no round-trip test can detect because both sides
share the mistake.

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

The excel module ships its own IIFE bundle, exposed as `Documonster.Excel` — the
same namespaces as the ESM entry, one level down from the shared global. There is
no whole-family bundle, so the file name names the module.

<!-- x-release-please-start-version -->

```html
<script src="https://unpkg.com/documonster@0.12.0/dist/iife/documonster.excel.iife.min.js"></script>
<script>
  const { Workbook, Cell } = Documonster.Excel;
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Sheet1");
  Cell.setValue(ws, "A1", "Hello, Browser!");
</script>
```

<!-- x-release-please-end -->

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

### Dates: calendar values, not instants

A spreadsheet date is a _civil_ value — a date on a calendar, a time on a clock,
no timezone. A JavaScript `Date` is an instant. Bridging the two needs a
convention, and this library's is that **a `Date` carries the spreadsheet's
value in its UTC fields**:

```typescript
Cell.setValue(ws, "A1", new Date(Date.UTC(2024, 0, 15))); // ✅ 2024-01-15
Cell.setValue(ws, "A2", new Date(2024, 0, 15)); // ⚠️ depends on where you run it
```

The second line stores a different serial in every timezone. In UTC+8 it is
`45305.667`, which Excel displays as **2024-01-14 16:00**. Nothing can warn you,
because both readings of that `Date` are legitimate and it does not say which was
meant.

So don't say it with a `Date`. Either pass calendar fields:

```typescript
Cell.setDateParts(ws, "A1", { year: 2024, month: 1, day: 15 });
Cell.setDateParts(ws, "A2", { hour: 9, minute: 30 }, "time");

Cell.getDateParts(ws, "A1"); // { year: 2024, month: 1, day: 15, hour: 0, ... }
Cell.getDateKind(ws, "A2"); // "time"
```

…or a `Temporal.Plain*` value, where the runtime has one:

```typescript
Cell.setValue(ws, "A1", Temporal.PlainDate.from("2024-01-15"));
Cell.setValue(ws, "A2", Temporal.PlainTime.from("09:30"));
Cell.setValue(ws, "A3", Temporal.PlainDateTime.from("2024-01-15T09:30"));

Cell.getTemporal(ws, "A1"); // Temporal.PlainDate 2024-01-15
Cell.getTemporal(ws, "A2"); // Temporal.PlainTime 09:30:00
```

Both forms also carry something a `Date` cannot: **which of the three kinds of
date cell it is**. A spreadsheet records that only in the number format, so a
time-of-day written as a bare `Date` gets the default _date_ format and renders
as `12-30-1899`. A `PlainTime` gets a time format, a `PlainDate` a date one.

`Cell.getValue` still returns a `Date`, and `CellValue` is unchanged — only the
_input_ type grew, so no existing code and no exhaustive `switch` is affected.

> **The 1900 leap-year bug.** Excel spends serial 60 on a day that never existed,
> 1900-02-29, so every date before 1900-03-01 sits one serial lower than a naive
> count suggests. The converter models this — `DATE(1900,1,1)` is 1 and
> `MONTH(60)` is 2, as in Excel — but a cell's value is stored as a `Date`, and no
> `Date` names that day, so `Cell.setDateParts` refuses 1900-02-29 rather than
> silently storing March 1. Serials from 61 onward are unaffected.

> **Availability.** `Temporal` needs Node 26+, Chrome 144+, Firefox 139+, Bun
> 1.4+ or Deno 2.7+, and this package adds no polyfill. `Cell.getDateParts` and
> `Cell.setDateParts` work everywhere and are the primitive — `Temporal.PlainDate.from(parts)`
> is one line. `Cell.getTemporal` throws rather than quietly returning a `Date`
> where `Temporal` is absent. The exported `PlainDate` / `PlainTime` /
> `PlainDateTime` types are derived structurally from `globalThis`, so a
> consumer whose `lib` predates `esnext.temporal` gets `never` rather than an
> error in a declaration file they did not write.

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

`Cell.find` is the fourth source of a handle, and the only reader that does not
create what it looks at:

```typescript
const cell = Cell.find(ws, "B7"); // CellData | undefined
const value = cell ? Cell.view(cell).value : null;
```

Every other reader — `Cell.getValue`, `Cell.getFont`, … — resolves its address
through `getCell`, which **materialises** the row and the cell when they do not
exist. That is what you want when writing, but it means reading a cell far out in
a sparse sheet leaves rows behind and moves `Worksheet.rowCount`:

```typescript
Cell.getValue(ws, "A1000"); // creates 1000 rows
Worksheet.rowCount(ws); // 1000

Cell.find(ws, "A1000"); // undefined; sheet untouched
```

Use `find` when the question is whether a cell is there at all. To read a whole
region without materialising anything, use `Range.getValues` / `Worksheet.toAoa`.

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
