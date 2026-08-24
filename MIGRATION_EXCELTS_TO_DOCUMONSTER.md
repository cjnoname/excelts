# Migration Guide: `@cj-tech-master/excelts` → `documonster`

This guide describes every breaking change introduced when the package
`@cj-tech-master/excelts` was renamed and restructured into `documonster`. It is
written to be followed mechanically: an AI or a developer can rewrite an existing
`excelts` codebase to `documonster` by applying the rules below in order.

> **TL;DR of the four biggest changes**
>
> 1. **Package renamed**: `@cj-tech-master/excelts` → `documonster`.
> 2. **No root entry**: the bare `import ... from "@cj-tech-master/excelts"`
>    (and `/browser`) subpath is **gone**. Excel now lives at
>    `documonster/excel`.
> 3. **Excel is no longer class-based.** The `Workbook` / `Worksheet` / `Cell`
>    / `Row` / `Column` / `Range` / `Table` / `Image` / `Note` / `FormCheckbox`
>    **classes were removed** and replaced by **namespaces of plain functions**
>    (`Workbook.create()`, `Cell.setValue(ws, "A1", 42)`, …). You never call
>    `new` and never hold instances with methods; you pass opaque handles into
>    functions.
> 4. **CSV, Markdown, formula and PDF integrations moved off `Workbook`.** They
>    now live at `documonster/excel/csv`, `documonster/excel/markdown`,
>    `documonster/excel/formula`, and `documonster/pdf` as free functions taking
>    the workbook as the first arg.

---

## 1. Package & tooling changes

| Aspect             | Old (`excelts`)           | New (`documonster`)                     |
| ------------------ | ------------------------- | --------------------------------------- |
| Package name       | `@cj-tech-master/excelts` | `documonster`                           |
| License            | MIT                       | Apache-2.0                              |
| Root `.` export    | present (Excel API)       | **removed**                             |
| `./browser` export | present                   | **removed** (per-module browser builds) |

### Install

```bash
# remove
npm remove @cj-tech-master/excelts
# add
npm install documonster
```

### Node / TypeScript baseline

`documonster` builds against **TypeScript 7.0** and **Node.js 22+**. The
package is ESM-first with CommonJS compatibility and ships one entry per module.

---

## 2. Import subpath map

The root entry (`.`) and `./browser` were removed. Every module now has its own
subpath. Update all import specifiers:

| Old specifier                           | New specifier                | Notes                                                          |
| --------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| `@cj-tech-master/excelts`               | `documonster/excel`          | Excel API (see §3, now namespaces)                             |
| `@cj-tech-master/excelts/browser`       | `documonster/excel`          | Browser build auto-selected via the `browser` export condition |
| `@cj-tech-master/excelts/formula`       | `documonster/formula`        | Now `Formula.*` namespace (see §7)                             |
| `@cj-tech-master/excelts/chart`         | `documonster/chart`          | Unchanged shape (free functions)                               |
| `@cj-tech-master/excelts/pdf`           | `documonster/pdf`            | `pdf`/`excelToPdf` → `Pdf.*` (see §6)                          |
| `@cj-tech-master/excelts/word`          | `documonster/word`           | Namespaced already                                             |
| `@cj-tech-master/excelts/word/html`     | `documonster/word/html`      |                                                                |
| `@cj-tech-master/excelts/word/crypto`   | `documonster/word/crypto`    |                                                                |
| `@cj-tech-master/excelts/word/markdown` | `documonster/word/markdown`  |                                                                |
| `@cj-tech-master/excelts/word/excel`    | `documonster/word/excel`     |                                                                |
| `@cj-tech-master/excelts/csv`           | `documonster/csv`            | Standalone CSV parser/formatter                                |
| `@cj-tech-master/excelts/markdown`      | `documonster/markdown`       | Standalone Markdown table module                               |
| `@cj-tech-master/excelts/xml`           | `documonster/xml`            | Now `Xml.*` namespace                                          |
| `@cj-tech-master/excelts/stream`        | `documonster/stream`         | Mostly unchanged                                               |
| `@cj-tech-master/excelts/archive`       | `documonster/archive`        |                                                                |
| _(CSV on Workbook)_                     | `documonster/excel/csv`      | **New** — Workbook CSV I/O (see §5)                            |
| _(Markdown on Workbook)_                | `documonster/excel/markdown` | **New** — Workbook Markdown I/O (see §5)                       |
| _(`wb.calculateFormulas()`)_            | `documonster/excel/formula`  | **New** — Workbook formula recalculation (see §7)              |

Browser vs Node is chosen automatically by the bundler/runtime through the
package `exports` `"browser"` condition — you no longer import a `/browser`
subpath explicitly.

---

## 3. Excel: from classes to namespaces (the big one)

`documonster/excel` exports **namespaces of functions**, not classes. The
mental model changes:

- **Before:** you created objects with `new` and called methods on them
  (`wb.addWorksheet("S")`, `cell.value = 42`, `ws.getCell("A1").font = {...}`).
- **After:** you call namespace functions and pass **opaque handles** as the
  first argument (`Workbook.addWorksheet(wb, "S")`,
  `Cell.setValue(ws, "A1", 42)`, `Cell.setFont(ws, "A1", {...})`).

Handles (`Workbook.Handle`, `Worksheet.Handle` = the value returned by
`Workbook.addWorksheet`, `Cell` handle, etc.) are plain data. **They have no
methods.** Never call a method on them; always route through a namespace
function.

### 3.1 Available namespaces

`import { Workbook, Worksheet, Cell, Row, Column, Range, Chart, Table, Image, Pivot, Sparkline, Form, Chartsheet, DataValidation, DefinedNames, Note, Address, Anchor, Watermark, Stream } from "documonster/excel";`

- **Platform-independent:** `Worksheet`, `Cell`, `Row`, `Column`, `Range`,
  `Chart`, `Table`, `Image`, `Pivot`, `Sparkline`, `Form`, `Chartsheet`,
  `DataValidation`, `DefinedNames`, `Note`, `Address`, `Anchor`, `Watermark`.
- **Platform-specific** (resolve to Node or browser variant automatically):
  `Workbook` (Node adds file-path `readFile`/`writeFile`) and `Stream`.

Also exported (unchanged classes of errors): `ExcelError`, `isExcelError`,
`WorksheetNameError`, `InvalidAddressError`, `ColumnOutOfBoundsError`,
`RowOutOfBoundsError`, `MergeConflictError`, `InvalidValueTypeError`,
`ExcelNotSupportedError`, `ExcelFileError`, `ExcelStreamStateError`,
`ExcelDownloadError`, `PivotTableError`, `ChartOptionsError`, `TableError`,
`ImageError`, `MaxItemsExceededError`.

> Note: the standalone `Column`, `Range`, `Table`, `Image`, `Note`,
> `FormCheckbox`, `DataValidations`, `DefinedNames`, `Chartsheet` **class
> exports have been removed** from the top level. Their functionality is now in
> the same-named namespaces.

### 3.2 Canonical before/after

**Before (excelts):**

```ts
import { Workbook } from "@cj-tech-master/excelts";

const wb = new Workbook();
const ws = wb.addWorksheet("Sheet1");
ws.getCell("A1").value = 42;
ws.getCell("A1").font = { bold: true };
ws.addRow(["a", "b", "c"]);
await wb.xlsx.writeFile("out.xlsx"); // Node
const buf = await wb.xlsx.writeBuffer(); // Browser
```

**After (documonster):**

```ts
import { Workbook, Worksheet, Cell } from "documonster/excel";

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Sheet1");
Cell.setValue(ws, "A1", 42);
Cell.setFont(ws, "A1", { bold: true });
Worksheet.addRow(ws, ["a", "b", "c"]);
await Workbook.writeFile(wb, "out.xlsx"); // Node
const buf = await Workbook.toBuffer(wb); // works in Node & browser
```

### 3.3 The `xlsx` I/O gateway is gone

The old `workbook.xlsx.*` accessor (`readFile`, `writeFile`, `load`,
`writeBuffer`) is removed. Use `Workbook` namespace functions directly:

| Old (`wb.xlsx.*`)             | New (`Workbook.*`)                         |
| ----------------------------- | ------------------------------------------ |
| `await wb.xlsx.writeFile(p)`  | `await Workbook.writeFile(wb, p)` _(Node)_ |
| `await wb.xlsx.readFile(p)`   | `await Workbook.readFile(wb, p)` _(Node)_  |
| `await wb.xlsx.writeBuffer()` | `await Workbook.toBuffer(wb)`              |
| `await wb.xlsx.load(bytes)`   | `await Workbook.read(wb, bytes)`           |
| `wb.xlsx.write(stream)`       | `await Workbook.writeStream(wb, stream)`   |
| `wb.xlsx.read(stream)`        | `await Workbook.readStream(wb, stream)`    |

> **`writeStream` respects backpressure — attach the consumer first.** Unlike
> exceljs, whose zip writer ignores `write()` returning `false` and lets the
> sink buffer without bound, `Workbook.writeStream` waits for the sink to
> `'drain'` at each zip-entry boundary. Awaiting it on an **unconsumed**
> intermediate stream therefore deadlocks once the stream's buffers fill
> (~128 KB of output on Node 22+, i.e. every non-trivial workbook), while small
> workbooks still succeed:
>
> ```ts
> // ❌ never resolves: the consumer is attached only after `writeStream` returns
> const passThrough = new PassThrough();
> await Workbook.writeStream(wb, passThrough);
> await upload(passThrough);
>
> // ✅ start the consumer, then await the producer
> const passThrough = new PassThrough();
> const uploading = upload(passThrough);
> await Workbook.writeStream(wb, passThrough);
> await uploading;
>
> // ✅ or don't stream at all
> await upload(await Workbook.toBuffer(wb));
> ```
>
> A terminal sink (`fs.createWriteStream`, an HTTP response, an SDK upload body
> that starts reading immediately) needs no special handling.

Reading always fills an existing workbook handle you create first:

```ts
const wb = Workbook.create();
await Workbook.read(wb, bytes); // browser / any platform
// or
await Workbook.readFile(wb, "in.xlsx"); // Node only
```

---

## 4. Excel API mapping tables (class member → namespace function)

Apply these substitutions. In all rows, `wb` is a workbook handle, `ws` is a
worksheet handle. Addresses are `"A1"` strings **or** 1-based `(row, col)` pairs
where noted.

### 4.1 `Workbook`

| Old (`Workbook` class)                                    | New (`Workbook.*` function)                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `new Workbook()` / `new Workbook({ formulaSyntaxProbe })` | `Workbook.create()` / `Workbook.create({ formulaSyntaxProbe })`                                                           |
| `wb.addWorksheet(name, opts)`                             | `Workbook.addWorksheet(wb, name, opts)`                                                                                   |
| `wb.getWorksheet(id?)`                                    | `Workbook.getWorksheet(wb, id?)`                                                                                          |
| `wb.worksheets`                                           | `Workbook.getWorksheets(wb)`                                                                                              |
| `wb.removeWorksheet(id)`                                  | `Workbook.removeWorksheet(wb, id)`                                                                                        |
| `wb.eachSheet(cb)`                                        | `Workbook.eachSheet(wb, cb)`                                                                                              |
| `wb.importSheet(source, name?)`                           | `Workbook.importSheet(wb, source, name?)`                                                                                 |
| `await wb.protect(pw?, opts?)`                            | `Workbook.protect(wb, pw?, opts?)`                                                                                        |
| `wb.unprotect()`                                          | `Workbook.unprotect(wb)`                                                                                                  |
| `wb.addChartsheet(name, opts)`                            | `Workbook.addChartsheet(wb, name, opts)`                                                                                  |
| `wb.addPivotChartsheet(name, pt, opts)`                   | `Workbook.addPivotChartsheet(wb, name, pt, opts)`                                                                         |
| `wb.chartsheets`                                          | `Workbook.getChartsheets(wb)`                                                                                             |
| `wb.getChartsheet(x)`                                     | `Workbook.getChartsheet(wb, x)`                                                                                           |
| `wb.removeChartsheet(x)`                                  | `Workbook.removeChartsheet(wb, x)`                                                                                        |
| `wb.renameChartsheet(x, name)`                            | `Workbook.renameChartsheet(wb, x, name)`                                                                                  |
| `wb.copyChartsheet(x, name?)`                             | `Workbook.copyChartsheet(wb, x, name?)`                                                                                   |
| `wb.replaceChartsheetChart(x, chart)`                     | `Workbook.replaceChartsheetChart(wb, x, chart)`                                                                           |
| `wb.definedNames`                                         | `Workbook.getDefinedNames(wb)`                                                                                            |
| `wb.registerPerson(name, userId?, provId?)`               | `Workbook.registerPerson(wb, name, userId?, provId?)`                                                                     |
| `wb.registerFunction(name, fn, opts?)`                    | `Workbook.registerFunction(wb, name, fn, opts?)` — see §7 for the tightened callback type and the removed `opts.volatile` |
| `wb.unregisterFunction(name)`                             | `Workbook.unregisterFunction(wb, name)`                                                                                   |
| `wb.addExternalLink(input)`                               | `Workbook.addExternalLink(wb, input)`                                                                                     |
| `wb.getExternalLink(x)`                                   | `Workbook.getExternalLink(wb, x)`                                                                                         |
| `wb.model` (get)                                          | `Workbook.getModel(wb)`                                                                                                   |
| `wb.model = m` (set)                                      | `Workbook.setModel(wb, m)`                                                                                                |
| `wb.addImage(image)`                                      | `Image.add(wb, image)` _(see §4.7)_                                                                                       |
| `Workbook.createStreamWriter(opts)`                       | `Workbook.createStreamWriter(wb, opts)` / `new Stream.WorkbookWriter(opts)`                                               |
| `Workbook.createStreamReader(input, opts)`                | `Workbook.createStreamReader(wb, input, opts)` / `new Stream.WorkbookReader(input, opts)`                                 |
| `wb.calculateFormulas()`                                  | _removed from Workbook_ — use `calculateFormulas(wb)` from `documonster/excel/formula` (see §7)                           |

**Document-property fields** (`wb.title`, `wb.creator`, `wb.created`,
`wb.company`, `wb.properties`, `wb.views`, `wb.calcProperties`,
`wb.protection`, `wb.media`, `wb.pivotTables`, `wb.externalLinks`,
`wb.defaultFont`, …) that were **direct fields/getters/setters** on the class
are now read/written through the workbook **model**:

```ts
const model = Workbook.getModel(wb);
model.title = "Report";
model.creator = "Me";
Workbook.setModel(wb, model);
```

CSV / Markdown methods (`readCsv`, `writeCsv`, `readMarkdown`, …) — see §5.
PDF (`workbook`→PDF) — see §6.

### 4.2 `Worksheet`

Structure / lifecycle operations live on `Worksheet`; cell/row/column/chart/
table/image/pivot operations moved to their own namespaces.

| Old (`Worksheet` class)                                | New                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `ws.name` (get) / `ws.name = n`                        | `Worksheet.getName(ws)` / `Worksheet.setName(ws, n)`                         |
| `ws.getCell(addr)` / `ws.getCell(r, c)`                | Use `Cell.*` functions directly (see §4.4). There is no cell object to hold. |
| `ws.getRow(r)`                                         | Use `Row.*` functions with the row number (see §4.5).                        |
| `ws.getColumn(c)`                                      | Use `Column.*` functions with the column ref (see §4.6).                     |
| `ws.addRow(values, style?)`                            | `Worksheet.addRow(ws, values, style?)`                                       |
| `ws.addRows(values, style?)`                           | `Worksheet.addRows(ws, values, style?)`                                      |
| `ws.getRows(start, len)`                               | `Worksheet.getRows(ws, start, len)`                                          |
| `ws.findRow(r)` / `ws.findRows(s, l)`                  | `Worksheet.findRow(ws, r)` / `Worksheet.findRows(ws, s, l)`                  |
| `ws.eachRow(cb)` / `ws.eachRow(opt, cb)`               | `Worksheet.eachRow(ws, cb)` / `Worksheet.eachRow(ws, opt, cb)`               |
| `ws.insertRow(pos, v, style?)`                         | `Worksheet.insertRow(ws, pos, v, style?)`                                    |
| `ws.insertRows(pos, vs, style?)`                       | `Worksheet.insertRows(ws, pos, vs, style?)`                                  |
| `ws.duplicateRow(n, count, insert?)`                   | `Worksheet.duplicateRow(ws, n, count, insert?)`                              |
| `ws.spliceRows(start, count, ...inserts)`              | `Worksheet.spliceRows(ws, start, count, ...inserts)`                         |
| `ws.spliceColumns(start, count, ...inserts)`           | `Worksheet.spliceColumns(ws, start, count, ...inserts)`                      |
| `ws.getSheetValues()`                                  | `Worksheet.getValues(ws)`                                                    |
| `ws.mergeCells(...cells)`                              | `Worksheet.merge(ws, ...cells)`                                              |
| `ws.mergeCellsWithoutStyle(...)`                       | `Worksheet.mergeWithoutStyle(ws, ...)`                                       |
| `ws.unMergeCells(...)`                                 | `Worksheet.unmerge(ws, ...)`                                                 |
| `ws.fillFormula(range, formula, results?, shareType?)` | `Worksheet.fillFormula(ws, range, formula, results?, shareType?)`            |
| `await ws.protect(pw?, opts?)`                         | `Worksheet.protect(ws, pw?, opts?)`                                          |
| `ws.unprotect()`                                       | `Worksheet.unprotect(ws)`                                                    |
| `ws.destroy()`                                         | `Worksheet.destroy(ws)`                                                      |
| `ws.autoFitColumn(c)`                                  | `Worksheet.autoFitColumn(ws, c)`                                             |
| `ws.autoFitColumns(s?, e?)`                            | `Worksheet.autoFitColumns(ws, s?, e?)`                                       |
| `ws.autoFitRow(n)`                                     | `Worksheet.autoFitRow(ws, n)`                                                |
| `ws.autoFitRows(s?, e?)`                               | `Worksheet.autoFitRows(ws, s?, e?)`                                          |
| `ws.addConditionalFormatting(cf)`                      | `Worksheet.addConditionalFormatting(ws, cf)`                                 |
| `ws.removeConditionalFormatting(filter?)`              | `Worksheet.removeConditionalFormatting(ws, filter?)`                         |
| `ws.toJSON(opts?)`                                     | `Worksheet.toJson(ws, opts?)`                                                |
| `ws.addJSON(data, opts?)`                              | `Worksheet.addJson(ws, data, opts?)`                                         |
| `ws.toAOA()`                                           | `Worksheet.toAoa(ws)`                                                        |
| `ws.addAOA(data, opts?)`                               | `Worksheet.addAoa(ws, data, opts?)`                                          |
| `ws.dimensions`                                        | `Worksheet.dimensions(ws)`                                                   |
| `ws.columnCount` / `ws.actualColumnCount`              | `Worksheet.columnCount(ws)` / `Worksheet.actualColumnCount(ws)`              |
| `ws.rowCount` / `ws.actualRowCount`                    | `Worksheet.rowCount(ws)` / `Worksheet.actualRowCount(ws)`                    |
| `ws.hasMerges`                                         | `Worksheet.hasMerges(ws)`                                                    |
| `ws.mergedRegions`                                     | `Worksheet.mergedRegions(ws)`                                                |
| `ws.columns` (get) / `ws.columns = defs`               | `Worksheet.columns(ws)` / `Worksheet.setColumns(ws, defs)`                   |
| `ws.lastColumn` / `ws.lastRow`                         | `Worksheet.lastColumn(ws)` / `Worksheet.lastRow(ws)`                         |
| `ws.model` (get/set)                                   | `Worksheet.getModel(ws)` / `Worksheet.setModel(ws, m)`                       |

> **Note the JSON/AOA casing change:** `toJSON`/`addJSON`/`toAOA`/`addAOA`
> became `toJson`/`addJson`/`toAoa`/`addAoa`.

Chart / Table / Image / Pivot / Sparkline / Form / Watermark **creation**
methods that were on `Worksheet` moved to their own namespaces (see §4.7–§4.10).

### 4.3 `Cell`

All cell operations take `(ws, addr)` or `(ws, row, col)`. There is **no cell
object**. `addr` is `"A1"` or a `(row, col)` pair for `getValue`/`setValue`/
`getStyle`/`setStyle`.

| Old (`cell` = `ws.getCell(...)`)        | New (`Cell.*`)                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `cell.value` (get)                      | `Cell.getValue(ws, addr)`                                                      |
| `cell.value = v`                        | `Cell.setValue(ws, addr, v)` / `Cell.setValue(ws, row, col, v)`                |
| `cell.text`                             | `Cell.getText(ws, addr)`                                                       |
| `cell.displayText`                      | `Cell.getDisplayText(ws, addr)`                                                |
| `cell.type`                             | `Cell.getType(ws, addr)`                                                       |
| `cell.effectiveType`                    | `Cell.getEffectiveType(ws, addr)`                                              |
| `cell.formula`                          | `Cell.getFormula(ws, addr)`                                                    |
| `cell.result` (get) / `cell.result = r` | `Cell.getResult(ws, addr)` / `Cell.setResult(ws, addr, r)`                     |
| `cell.style` (get)                      | `Cell.getStyle(ws, addr)`                                                      |
| _(assign to `cell.style`)_              | `Cell.setStyle(ws, addr, partialStyle)` / `Cell.setStyle(ws, row, col, style)` |
| `cell.font` (get) / `= v`               | `Cell.getFont(ws, addr)` / `Cell.setFont(ws, addr, v)`                         |
| `cell.numFmt` / `= v`                   | `Cell.getNumFmt(ws, addr)` / `Cell.setNumFmt(ws, addr, v)`                     |
| `cell.alignment` / `= v`                | `Cell.getAlignment(ws, addr)` / `Cell.setAlignment(ws, addr, v)`               |
| `cell.border` / `= v`                   | `Cell.getBorder(ws, addr)` / `Cell.setBorder(ws, addr, v)`                     |
| `cell.fill` / `= v`                     | `Cell.getFill(ws, addr)` / `Cell.setFill(ws, addr, v)`                         |
| `cell.protection` / `= v`               | `Cell.getProtection(ws, addr)` / `Cell.setProtection(ws, addr, v)`             |
| `cell.isMerged`                         | `Cell.isMerged(ws, addr)`                                                      |
| `cell.master`                           | `Cell.getMergeMaster(ws, addr)`                                                |
| `cell.hyperlink`                        | `Cell.getHyperlink(ws, addr)`                                                  |
| `cell.note` (get) / `= v`               | `Cell.getNote(ws, addr)` / `Cell.setNote(ws, addr, v)`                         |
| `cell.comment` (get) / `= v`            | `Cell.getComment(ws, addr)` / `Cell.setComment(ws, addr, v)`                   |
| `cell.dataValidation` (get) / `= v`     | `Cell.getValidation(ws, addr)` / `Cell.setValidation(ws, addr, v)`             |
| `cell.name` / `cell.names`              | `Cell.getNames(ws, addr)`                                                      |
| `cell.addName(n)`                       | `Cell.addName(ws, addr, n)`                                                    |
| `cell.removeName(n)`                    | `Cell.removeName(ws, addr, n)`                                                 |
| `cell.removeAllNames()`                 | `Cell.removeAllNames(ws, addr)`                                                |
| _(set a single name)_                   | `Cell.setName(ws, addr, n)`                                                    |
| _(set names)_                           | `Cell.setNames(ws, addr, names)`                                               |
| `cell.fullAddress`                      | `Cell.getFullAddress(ws, addr)`                                                |
| `cell.model` (get) / `= m`              | `Cell.getModel(ws, addr)` / `Cell.setModel(ws, addr, m)`                       |
| `cell.merge(master)` / `cell.unmerge()` | Use `Worksheet.merge(ws, range)` / `Worksheet.unmerge(ws, range)`              |

### 4.4 `Row`

All operations take `(ws, rowNumber)`.

| Old (`row` = `ws.getRow(n)`)     | New (`Row.*`)                                                  |
| -------------------------------- | -------------------------------------------------------------- |
| `row.height` (get) / `= h`       | `Row.getHeight(ws, n)` / `Row.setHeight(ws, n, h)`             |
| `row.hidden` (get) / `= b`       | `Row.getHidden(ws, n)` / `Row.setHidden(ws, n, b)`             |
| `row.outlineLevel` (get) / `= l` | `Row.getOutlineLevel(ws, n)` / `Row.setOutlineLevel(ws, n, l)` |
| _(assign row style)_             | `Row.getStyle(ws, n)` / `Row.setStyle(ws, n, style)`           |
| `row.font = v`                   | `Row.setFont(ws, n, v)`                                        |
| `row.alignment = v`              | `Row.setAlignment(ws, n, v)`                                   |
| `row.border = v`                 | `Row.setBorder(ws, n, v)`                                      |
| `row.fill = v`                   | `Row.setFill(ws, n, v)`                                        |
| `row.values` (get, 1-based)      | `Row.values(ws, n)` _(1-based, leading empty slot)_            |
| `row.getValues()` (0-based)      | `Row.getValues(ws, n)` _(0-based dense array)_                 |
| `row.values = v`                 | `Row.setValues(ws, n, v)`                                      |
| `row.getCell(col)`               | `Row.getCell(ws, n, col)`                                      |
| `row.eachCell(cb)` / `(opt, cb)` | `Row.eachCell(ws, n, cb)` / `Row.eachCell(ws, n, opt, cb)`     |
| `row.commit()`                   | `Row.commit(ws, n)`                                            |

> **`values` vs `getValues`:** `Row.values` keeps Excel's **1-based** layout
> (index 0 is an empty slot; column A is index 1). `Row.getValues` returns a
> **0-based** dense array (column A is index 0). Old `row.values` was 1-based
> and old `row.getValues()` was 0-based — same semantics, now as functions.

**Is there still a row object?** Yes, but you never need one to call `Row.*`.
`Worksheet.addRow` / `addRows` / `getRow` / `getRows` / `findRow` / `findRows` /
`eachRow` still hand out row handles, whose type is `RowData` (also reachable as
`Stream.RowHandle` in streaming code). The handle is opaque — read and mutate it
through `Row.*` by row number. So a signature that used to be
`(ws: Worksheet, row: Row)` becomes:

```typescript
import { Row } from "documonster/excel";
import type { RowData, Worksheet } from "documonster/excel";

// preferred — address by number
const stripe = (ws: Worksheet.Handle, rowNumber: number) =>
  Row.setFill(ws, rowNumber, { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F7F7" } });

// when you already hold a handle from Worksheet.eachRow / addRow
const rowNumberOf = (row: RowData) => row.number;
```

### 4.5 `Column`

All operations take `(ws, colRef)` where `colRef` is a key string, letter
(`"A"`), or 1-based number.

| Old (`col` = `ws.getColumn(c)`)  | New (`Column.*`)                                                     |
| -------------------------------- | -------------------------------------------------------------------- |
| `col.width` (get) / `= w`        | `Column.getWidth(ws, c)` / `Column.setWidth(ws, c, w)`               |
| `col.header` (get) / `= h`       | `Column.getHeader(ws, c)` / `Column.setHeader(ws, c, h)`             |
| `col.key` (get) / `= k`          | `Column.getKey(ws, c)` / `Column.setKey(ws, c, k)`                   |
| `col.hidden` (get) / `= b`       | `Column.getHidden(ws, c)` / `Column.setHidden(ws, c, b)`             |
| `col.outlineLevel` (get) / `= l` | `Column.getOutlineLevel(ws, c)` / `Column.setOutlineLevel(ws, c, l)` |
| `col.style` (get)                | `Column.getStyle(ws, c)` / `Column.setStyle(ws, c, style)`           |

Per-facet setters (`col.font = …`, etc.) are folded into
`Column.setStyle(ws, c, { font, numFmt, ... })`.

### 4.6 `Range`

The `Range` class became stateless geometry helpers. Handles are opaque
(`Range.Handle`).

| Old (`Range` class)                    | New (`Range.*`)                   |
| -------------------------------------- | --------------------------------- |
| `new Range("A1:B2")` (and other ctors) | `Range.create("A1:B2")`           |
| `range.contains(addr)`                 | `Range.contains(r, addr)`         |
| `range.containsEx(address)`            | `Range.containsCell(r, address)`  |
| `range.intersects(other)`              | `Range.intersects(r, other)`      |
| `range.forEachAddress(cb)`             | `Range.forEachAddress(r, cb)`     |
| `range.expand(t, l, b, r)`             | `Range.expand(r, t, l, b, right)` |
| `range.expandToAddress(addr)`          | `Range.expandToAddress(r, addr)`  |
| `range.toString()` / `range.range`     | `Range.toString(r)`               |
| `range.count`                          | `Range.count(r)`                  |

### 4.7 `Image`

| Old                                      | New (`Image.*`)                                                     |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `wb.addImage(image)` → imageId           | `Image.add(wb, image)` → imageId                                    |
| `ws.addImage(imageId, range)`            | `Image.place(ws, imageId, range)`                                   |
| `ws.getImages()`                         | `Image.list(ws)`                                                    |
| `ws.addBackgroundImage(imageId)`         | `Image.setBackground(ws, imageId)`                                  |
| `ws.getBackgroundImageId()`              | `Image.getBackground(ws)`                                           |
| `ws.addShape(options)`                   | `Image.addShape(ws, options)`                                       |
| `ws.getShapes()`                         | `Image.getShapes(ws)`                                               |
| `new Image(ws, model)` / `image.clone()` | `Image.create(...)` / `Image.clone(handle)` / `Image.model(handle)` |

### 4.8 `Chart`

Chart creation methods on `Worksheet` moved to `Chart.*` and were de-verbosed
(`addColumnChart` → `Chart.addColumn`, etc.). Chart-instance methods (formerly
on the `Chart` class) are also `Chart.*` functions taking a chart handle.

| Old (`ws.*` creation)                    | New (`Chart.*`)                            |
| ---------------------------------------- | ------------------------------------------ |
| `ws.addChart(opts, range)`               | `Chart.add(ws, opts, range)`               |
| `ws.addColumnChart(opts, range)`         | `Chart.addColumn(ws, opts, range)`         |
| `ws.addBarChart(...)`                    | `Chart.addBar(ws, ...)`                    |
| `ws.addLineChart(...)`                   | `Chart.addLine(ws, ...)`                   |
| `ws.addAreaChart(...)`                   | `Chart.addArea(ws, ...)`                   |
| `ws.addPieChart(...)`                    | `Chart.addPie(ws, ...)`                    |
| `ws.addDoughnutChart(...)`               | `Chart.addDoughnut(ws, ...)`               |
| `ws.addScatterChart(...)`                | `Chart.addScatter(ws, ...)`                |
| `ws.addBubbleChart(...)`                 | `Chart.addBubble(ws, ...)`                 |
| `ws.addRadarChart(...)`                  | `Chart.addRadar(ws, ...)`                  |
| `ws.addStockChart(...)`                  | `Chart.addStock(ws, ...)`                  |
| `ws.addSurfaceChart(...)`                | `Chart.addSurface(ws, ...)`                |
| `ws.addHistogramChart(...)`              | `Chart.addHistogram(ws, ...)`              |
| `ws.addParetoChart(...)`                 | `Chart.addPareto(ws, ...)`                 |
| `ws.addWaterfallChart(...)`              | `Chart.addWaterfall(ws, ...)`              |
| `ws.addFunnelChart(...)`                 | `Chart.addFunnel(ws, ...)`                 |
| `ws.addTreemapChart(...)`                | `Chart.addTreemap(ws, ...)`                |
| `ws.addSunburstChart(...)`               | `Chart.addSunburst(ws, ...)`               |
| `ws.addBoxWhiskerChart(...)`             | `Chart.addBoxWhisker(ws, ...)`             |
| `ws.addRegionMapChart(...)`              | `Chart.addRegionMap(ws, ...)`              |
| `ws.addComboChart(...)`                  | `Chart.addCombo(ws, ...)`                  |
| `ws.addChartEx(...)`                     | `Chart.addEx(ws, ...)`                     |
| `ws.addPresetChart(preset, ...)`         | `Chart.addPreset(ws, preset, ...)`         |
| `ws.addPresetChartEx(preset, ...)`       | `Chart.addPresetEx(ws, preset, ...)`       |
| `ws.addChartFromTable(t, opts, range)`   | `Chart.addFromTable(ws, t, opts, range)`   |
| `ws.addChartFromRows(rows, opts, range)` | `Chart.addFromRows(ws, rows, opts, range)` |
| `ws.addColumnChartFromRows(...)`         | `Chart.addColumnFromRows(ws, ...)`         |
| `ws.addChartExFromTable(...)`            | `Chart.addExFromTable(ws, ...)`            |
| `ws.addChartExFromRows(...)`             | `Chart.addExFromRows(ws, ...)`             |
| `ws.addPivotChart(pt, opts, range)`      | `Chart.addPivot(ws, pt, opts, range)`      |
| `ws.addPivotComboChart(...)`             | `Chart.addPivotCombo(ws, ...)`             |
| `ws.seriesFromColumns(opts)`             | `Chart.seriesFromColumns(ws, opts)`        |
| `ws.getCharts()`                         | `Chart.get(ws)`                            |
| `ws.removeChart(chart)`                  | `Chart.remove(ws, chart)`                  |

Chart-handle operations (`chart` is the handle): `Chart.toSVG(chart)`,
`Chart.toPNG(chart)`, `Chart.mutate(chart, fn)`, `Chart.setStyle(chart, n)`,
`Chart.setBuiltInStyle(...)`, `Chart.addSeries(...)`, `Chart.removeSeries(...)`,
`Chart.getSeries(chart, i)`, `Chart.updateSeries(...)`, `Chart.setTitle(...)`,
`Chart.title(chart)`, `Chart.legend(chart)`, `Chart.setLegend(...)`,
`Chart.getAxis(...)`, `Chart.categoryAxis(chart)`, `Chart.valueAxis(chart)`,
`Chart.plotArea(chart)`, `Chart.chartModel(chart)`, `Chart.anchorModel(chart)`,
`Chart.isChartEx(chart)`, `Chart.clone(chart)`, `Chart.copyTo(...)`, etc.
(Full list: `title`, `setTitle`, `titleRichText`, `setTitleRichText`, `mutate`,
`mutateChartEx`, `setStyle`, `setBuiltInStyle`, `addSeries`, `removeSeries`,
`getSeries`, `updateSeries`, `addSeriesFromOptions`, `setSeriesValues`,
`setSeriesCategories`, `setSeriesName`, `getSeriesCount`, `totalSeriesCount`,
`chartTypes`, `axes`, `getAxis`, `categoryAxis`, `valueAxis`, `plotArea`,
`legend`, `setLegend`, `spPr`, `setSpPr`, `unknownElements`, `userShapesXml`,
`setUserShapesXml`, `removeUserShapes`, `copyTo`, `clone`, `chartModel`,
`chartExModel`, `isChartEx`, `anchorModel`, `toSVG`, `toPNG`.)

### 4.9 `Table`

| Old (`Table` class / `ws`)                | New (`Table.*`)                                                   |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `ws.addTable(model)`                      | `Table.add(ws, model)`                                            |
| `ws.getTable(name)`                       | `Table.get(ws, name)`                                             |
| `ws.getTables()`                          | `Table.list(ws)`                                                  |
| `ws.removeTable(name)`                    | `Table.remove(ws, name)`                                          |
| `new Table(ws, model)`                    | `Table.create(...)`                                               |
| `table.addRow(values, rowNumber?, opts?)` | `Table.addRow(t, values, rowNumber?, opts?)`                      |
| `table.removeRows(idx, count?, opts?)`    | `Table.removeRows(t, idx, count?, opts?)`                         |
| `table.getColumn(idx)`                    | `Table.column(t, idx)`                                            |
| `table.addColumn(col, values, idx?)`      | `Table.addColumn(t, col, values, idx?)`                           |
| `table.removeColumns(idx, count?)`        | `Table.removeColumns(t, idx, count?)`                             |
| `table.commit()`                          | `Table.commit(t)`                                                 |
| `table.model` (get/set)                   | `Table.model(t)` / `Table.setModel(t, m)`                         |
| `table.ref` / `= v`                       | `Table.ref(t)` / `Table.setRef(t, v)`                             |
| `table.name` / `= v`                      | `Table.name(t)` / `Table.setName(t, v)`                           |
| `table.displayName` / `= v`               | `Table.displayName(t)` / `Table.setDisplayName(t, v)`             |
| `table.headerRow` / `= v`                 | `Table.headerRow(t)` / `Table.setHeaderRow(t, v)`                 |
| `table.totalsRow` / `= v`                 | `Table.totalsRow(t)` / `Table.setTotalsRow(t, v)`                 |
| `table.theme` / `= v`                     | `Table.theme(t)` / `Table.setTheme(t, v)`                         |
| `table.showFirstColumn` / `= v`           | `Table.showFirstColumn(t)` / `Table.setShowFirstColumn(t, v)`     |
| `table.showLastColumn` / `= v`            | `Table.showLastColumn(t)` / `Table.setShowLastColumn(t, v)`       |
| `table.showRowStripes` / `= v`            | `Table.showRowStripes(t)` / `Table.setShowRowStripes(t, v)`       |
| `table.showColumnStripes` / `= v`         | `Table.showColumnStripes(t)` / `Table.setShowColumnStripes(t, v)` |

Table-column accessors (formerly on the table-column wrapper class) are on the
`Table` namespace prefixed with `column`: `Table.columnName(t, idx)`,
`Table.columnSetName(t, idx, v)`, `Table.columnFilterButton`,
`Table.columnSetFilterButton`, `Table.columnStyle`, `Table.columnSetStyle`,
`Table.columnTotalsRowLabel`, `Table.columnSetTotalsRowLabel`,
`Table.columnTotalsRowFunction`, `Table.columnSetTotalsRowFunction`,
`Table.columnTotalsRowResult`, `Table.columnSetTotalsRowResult`,
`Table.columnTotalsRowFormula`, `Table.columnSetTotalsRowFormula`.

### 4.10 Pivot / Sparkline / Form / Watermark / DataValidation / DefinedNames / Note / Anchor / Chartsheet / Address

| Old                                                                     | New                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ws.addPivotTable(model)`                                               | `Pivot.add(ws, model)`                                                                                                                                                                                                                                           |
| `ws.addSparklineGroup(opts)`                                            | `Sparkline.add(ws, opts)`                                                                                                                                                                                                                                        |
| `ws.getSparklineGroups()`                                               | `Sparkline.list(ws)`                                                                                                                                                                                                                                             |
| `ws.removeSparklineGroup(x)`                                            | `Sparkline.remove(ws, x)`                                                                                                                                                                                                                                        |
| `ws.addFormCheckbox(range, opts?)`                                      | `Form.addCheckbox(ws, range, opts?)`                                                                                                                                                                                                                             |
| `ws.getFormCheckboxes()`                                                | `Form.listCheckboxes(ws)`                                                                                                                                                                                                                                        |
| `checkbox.checked` / `= b`                                              | `Form.checked(cb)` / `Form.setChecked(cb, b)`                                                                                                                                                                                                                    |
| `checkbox.link` / `= v`                                                 | `Form.link(cb)` / `Form.setLink(cb, v)`                                                                                                                                                                                                                          |
| `checkbox.text` / `= v`                                                 | `Form.text(cb)` / `Form.setText(cb, v)`                                                                                                                                                                                                                          |
| `ws.addWatermark(opts)`                                                 | `Watermark.add(ws, opts)`                                                                                                                                                                                                                                        |
| `ws.getWatermark()`                                                     | `Watermark.get(ws)`                                                                                                                                                                                                                                              |
| `ws.removeWatermark()`                                                  | `Watermark.remove(ws)`                                                                                                                                                                                                                                           |
| `new DataValidations()`                                                 | `DataValidation.create()`                                                                                                                                                                                                                                        |
| `dv.add(addr, rule)`                                                    | `DataValidation.add(dv, addr, rule)`                                                                                                                                                                                                                             |
| `dv.find(addr)` / `dv.remove(addr)`                                     | `DataValidation.find(dv, addr)` / `DataValidation.remove(dv, addr)`                                                                                                                                                                                              |
| `new DefinedNames()`                                                    | `DefinedNames.create()`                                                                                                                                                                                                                                          |
| `dn.add(ref, name)`                                                     | `DefinedNames.add(dn, ref, name)`                                                                                                                                                                                                                                |
| `dn.addFormula(name, formula)`                                          | `DefinedNames.addFormula(dn, name, formula)`                                                                                                                                                                                                                     |
| `dn.remove(...)` / `dn.getNames()`                                      | `DefinedNames.remove(dn, ...)` / `DefinedNames.getNames(dn)`                                                                                                                                                                                                     |
| `new Note(text, author)`                                                | `Note.create(text, author)`                                                                                                                                                                                                                                      |
| `Note.fromModel(model)`                                                 | `Note.fromModel(model)` _(function)_                                                                                                                                                                                                                             |
| `new Anchor(ws, "B2")` (via Image APIs)                                 | `Anchor.create(ws, "B2")`, `Anchor.col(a)`, `Anchor.setRow(a, n)`, `Anchor.model(a)`, `Anchor.clone(a)`                                                                                                                                                          |
| Chartsheet handle methods                                               | `Chartsheet.name(cs)`, `Chartsheet.chart(cs)`, `Chartsheet.model(cs)`, `Chartsheet.setPageSetup(cs, …)`, … (management via `Workbook.addChartsheet`/`getChartsheet`/…)                                                                                           |
| `decodeCell`, `encodeCol`, `decodeRange`… (old top-level named exports) | `Address.decodeCell`, `Address.encodeCol`, `Address.decodeRange`, `Address.encodeCell`, `Address.encodeRange`, `Address.decodeRow`, `Address.encodeRow`, `Address.quoteSheetName` — these are **no longer top-level named exports**; use the `Address` namespace |

---

## 5. CSV & Markdown moved off `Workbook`

The `readCsv`/`writeCsv`/`readMarkdown`/`writeMarkdown` **methods on the
`Workbook` class are gone.** They are now free functions in dedicated subpaths,
taking the workbook handle as the first argument.

### 5.1 CSV — `documonster/excel/csv`

```ts
import { Workbook } from "documonster/excel";
import {
  readCsv,
  writeCsv,
  writeCsvBuffer,
  createCsvReadStream,
  createCsvWriteStream,
  readCsvFile,
  writeCsvFile, // Node-only
  type CsvInput,
  type CsvOptions
} from "documonster/excel/csv";
```

| Old (`Workbook` method)                       | New function                          |
| --------------------------------------------- | ------------------------------------- |
| `await wb.readCsv(input, opts?)`              | `await readCsv(wb, input, opts?)`     |
| `wb.writeCsv(opts?)` → string                 | `writeCsv(wb, opts?)` → string        |
| `await wb.writeCsv(stream, opts?)`            | `await writeCsv(wb, stream, opts?)`   |
| `await wb.writeCsvBuffer(opts?)`              | `await writeCsvBuffer(wb, opts?)`     |
| `wb.createCsvReadStream(opts?)`               | `createCsvReadStream(wb, opts?)`      |
| `wb.createCsvWriteStream(opts?)`              | `createCsvWriteStream(wb, opts?)`     |
| `await wb.readCsvFile(path, opts?)` _(Node)_  | `await readCsvFile(wb, path, opts?)`  |
| `await wb.writeCsvFile(path, opts?)` _(Node)_ | `await writeCsvFile(wb, path, opts?)` |

The `CsvInput` / `CsvOptions` types are now imported from
`documonster/excel/csv` (previously re-exported from the root).

### 5.2 Markdown — `documonster/excel/markdown`

```ts
import {
  readMarkdown,
  readMarkdownAll,
  writeMarkdown,
  writeMarkdownBuffer,
  readMarkdownFile,
  readMarkdownAllFile,
  writeMarkdownFile // Node-only
} from "documonster/excel/markdown";
```

| Old (`Workbook` method)                     | New function                                 |
| ------------------------------------------- | -------------------------------------------- |
| `wb.readMarkdown(input, opts?)`             | `readMarkdown(wb, input, opts?)`             |
| `wb.readMarkdownAll(input, opts?)`          | `readMarkdownAll(wb, input, opts?)`          |
| `wb.writeMarkdown(opts?)`                   | `writeMarkdown(wb, opts?)`                   |
| `wb.writeMarkdownBuffer(opts?)`             | `writeMarkdownBuffer(wb, opts?)`             |
| `await wb.readMarkdownFile(path, opts?)`    | `await readMarkdownFile(wb, path, opts?)`    |
| `await wb.readMarkdownAllFile(path, opts?)` | `await readMarkdownAllFile(wb, path, opts?)` |
| `await wb.writeMarkdownFile(path, opts?)`   | `await writeMarkdownFile(wb, path, opts?)`   |

> `MarkdownOptions` (and other Markdown types) still come from
> `documonster/markdown`.

---

## 6. PDF: `pdf` / `excelToPdf` → `Pdf.*` namespace

All PDF value functions now live under the `Pdf` namespace. The old flat
named exports (`pdf`, `readPdf`, `excelToPdf`, `docxToPdf`,
`PdfDocumentBuilder`, `PdfPageBuilder`, `PdfEditor`, `PageSizes`) were
**removed** from the top level.

```ts
import { Pdf } from "documonster/pdf";
```

| Old (`documonster/pdf`)                             | New                                          |
| --------------------------------------------------- | -------------------------------------------- |
| `import { pdf } ...; pdf(rows)`                     | `Pdf.create(rows)`                           |
| `import { excelToPdf } ...; excelToPdf(wb, opts?)`  | `await Pdf.fromExcel(wb, opts?)`             |
| `import { docxToPdf } ...; docxToPdf(doc, opts?)`   | `await Pdf.fromDocx(doc, opts?)`             |
| `import { readPdf } ...; readPdf(bytes)`            | `Pdf.read(bytes)`                            |
| `new PdfDocumentBuilder()`                          | `new Pdf.Builder()`                          |
| `PdfPageBuilder`                                    | `Pdf.PageBuilder`                            |
| `parseSvgPath`                                      | `Pdf.parseSvgPath`                           |
| `new PdfEditor()` / `PdfEditorPage`                 | `new Pdf.Editor()` / `Pdf.EditorPage`        |
| `PageSizes`                                         | `Pdf.PageSizes`                              |
| Digital signatures (`signPdf`/`verifyPdfSignature`) | `Pdf.sign(...)` / `Pdf.verifySignature(...)` |
| _(new)_ chart → PDF                                 | `await Pdf.fromChart(chartHandle, opts?)`    |
| _(new)_ Word-chart renderer                         | `await Pdf.wordChartRenderer()`              |

> **`excelToPdf` and `pdf` were removed as top-level named exports.** Use
> `Pdf.fromExcel(wb, options)` / `Pdf.create(rows)`. The converters are lazily
> loaded, so a bundle that only builds PDFs (`Pdf.create(...)`) never pulls in
> the excel/word object model.

`PdfError`, `PdfRenderError`, `PdfFontError`, `PdfStructureError`, `isPdfError`
remain named exports of `documonster/pdf`.

### Recalculation with PDF export

The old `excelToPdf` auto-recalculated when the formula engine was installed.
Now recalculation is explicit — pass `calculateFormulas`:

```ts
import { Workbook } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";
import { Pdf } from "documonster/pdf";

const bytes = await Pdf.fromExcel(wb, { recalculate: calculateFormulas });
```

The Excel-specific callback is declared on `ExcelToPdfOptions`, not on the
generic `PdfExportOptions`. If you explicitly typed an options object, update
the annotation:

```ts
import type { ExcelToPdfOptions } from "documonster/pdf";

const options: ExcelToPdfOptions = { recalculate: calculateFormulas };
```

The old `PdfExportOptions.recalculate` parameter used `never`, which accepted
incompatible callbacks and deferred the failure to runtime. That unsafe
declaration was removed rather than preserved as a
compatibility alias.

---

## 7. Formula engine: no more install step

The formula engine dropped its global install/registration mechanism. It is now
a pure functional namespace.

**Removed exports** (from `documonster/formula`):
`installFormulaEngine`, `uninstallFormulaEngine`, `createFormulaSyntaxProbe`,
and the `SyntaxProbe` type export. The `install.ts` / `host-registry.ts`
modules were deleted.

| Old (`documonster/formula`)                                                            | New                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `import { installFormulaEngine } ...; installFormulaEngine(); wb.calculateFormulas();` | `import { calculateFormulas } from "documonster/excel/formula"; calculateFormulas(wb);`          |
| `import { calculateFormulas } ...`                                                     | `calculateFormulas` from `documonster/excel/formula`                                             |
| `import { tokenize } ...`                                                              | `Formula.tokenize`                                                                               |
| `import { parse } ...`                                                                 | `Formula.parse`                                                                                  |
| `new Workbook({ formulaSyntaxProbe })`                                                 | `Workbook.create({ formulaSyntaxProbe })` (probe factory removed; pass your own if you have one) |

**0.3.0 breaking change.** `wb.calculateFormulas()` (the Workbook method) is removed. Call
`calculateFormulas(wb)` from `documonster/excel/formula` instead.
`Formula.calculate` and the old `WorkbookLike` host SPI are also removed: the
calculation core now operates on immutable snapshots behind the Excel adapter,
rather than requiring user data to imitate a workbook object graph. Formula
errors (`FormulaError`, `FormulaParseError`, `isFormulaError`) remain exported,
and `documonster/formula` now also exports the syntax types `Token`,
`TokenType`, `AstNode` and `NodeType`.

The host-shaped structural types are gone with `Formula.calculate`:
`WorkbookLike`, `WorksheetLike`, `RowLike`, `CellLike`, `CellErrorValueLike`,
`FormulaResultLike`, `DefinedNameEntry`, `DefinedNamesLike`, `DimensionsLike`
and `SpillRegion` are no longer exported.

**Custom functions.** `Workbook.registerFunction` now provides typed
`FormulaValue[]` arguments. Callbacks may keep returning primitive numbers,
strings, booleans or nullish values for compatibility; tagged `FormulaValue`
results remain available when an error or array value is needed. Import the
types and tag map from `documonster/excel/formula`:

```ts
import { FormulaValueKind } from "documonster/excel/formula";
import type { FormulaValue } from "documonster/excel/formula";

Workbook.registerFunction(wb, "ANSWER", (): FormulaValue => ({
  kind: FormulaValueKind.Number,
  value: 42
}));
```

The optional `volatile` flag remains supported. Set it when a custom function
must be evaluated afresh instead of being reused from the calculation cache.

**Before:**

```ts
import { Workbook } from "@cj-tech-master/excelts";
import { installFormulaEngine } from "@cj-tech-master/excelts/formula";

installFormulaEngine();
const wb = new Workbook();
// ... build formulas ...
wb.calculateFormulas();
```

**After:**

```ts
import { Workbook } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";

const wb = Workbook.create();
// ... build formulas ...
calculateFormulas(wb);
```

---

## 8. Other modules now namespaced

These modules moved their value APIs behind a single namespace re-export
(`export * as X`). Types and error classes remain flat named exports. This
applies to the **standalone** `xml`, `markdown`, `formula`, `csv`, and `pdf`
modules — not only the Excel/Word integrations.

| Module                 | Namespace                              | Example                                       |
| ---------------------- | -------------------------------------- | --------------------------------------------- |
| `documonster/xml`      | `Xml`                                  | `Xml.parse(...)`, `Xml.encode(...)`           |
| `documonster/markdown` | `Markdown`                             | `Markdown.parse(...)`, `Markdown.format(...)` |
| `documonster/csv`      | `Csv`                                  | `Csv.parse(...)`, `Csv.format(...)`           |
| `documonster/formula`  | `Formula`                              | `Formula.tokenize(...)`, `Formula.parse(...)` |
| `documonster/pdf`      | `Pdf`                                  | `Pdf.create(...)`, `Pdf.read(...)`            |
| `documonster/word`     | `Build`, `Query`, `Io`, … (many, §8.5) | `Io.read(...)`, `Query.replaceText(...)`      |

If you previously imported individual functions from these modules (e.g.
`import { parseCsv } from ".../csv"`), switch to the namespace form
(`Csv.parse`). Members were also **renamed** (de-prefixed) inside the
namespace — see §8.2 and §8.3.

The `documonster/chart`, `documonster/stream`, and `documonster/archive`
module surfaces keep their flat free-function / class shape — only the package
name in the import specifier changes (e.g.
`import { gzip, gunzip } from "documonster/archive"`).

### 8.2 Standalone CSV — `documonster/csv`

The standalone CSV module is now the `Csv` namespace; **every** value export
was moved into it and most were de-prefixed. Types (`CsvParseOptions`, etc.)
and errors (`CsvError`, `CsvWorkerError`, `isCsvError`) plus
`DecimalSeparator` remain flat named exports.

| Old (`documonster/csv` named export)               | New (`Csv.*`)                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `parseCsv`                                         | `Csv.parse`                                                                 |
| `parseCsvAsync`                                    | `Csv.parseAsync`                                                            |
| `parseCsvRows`                                     | `Csv.parseRows`                                                             |
| `parseCsvWithProgress`                             | `Csv.parseWithProgress`                                                     |
| `formatCsv`                                        | `Csv.format`                                                                |
| `CsvParserStream`                                  | `Csv.ParserStream`                                                          |
| `CsvFormatterStream`                               | `Csv.FormatterStream`                                                       |
| `createCsvParserStream`                            | `Csv.createParserStream`                                                    |
| `createCsvFormatterStream`                         | `Csv.createFormatterStream`                                                 |
| `csvGenerate`                                      | `Csv.generate`                                                              |
| `csvGenerateRows`                                  | `Csv.generateRows`                                                          |
| `csvGenerateAsync`                                 | `Csv.generateAsync`                                                         |
| `csvGenerateData`                                  | `Csv.generateData`                                                          |
| `createCsvGenerator`                               | `Csv.createGenerator`                                                       |
| `formatNumberForCsv`                               | `Csv.formatNumber`                                                          |
| `parseNumberFromCsv`                               | `Csv.parseNumber`                                                           |
| `detectDelimiter` / `detectLinebreak` / `stripBom` | `Csv.detectDelimiter` / `Csv.detectLinebreak` / `Csv.stripBom` (same names) |
| `applyDynamicTyping` / `applyDynamicTypingToRow`   | `Csv.applyDynamicTyping` / `Csv.applyDynamicTypingToRow` (same names)       |
| `isFormattedValue` / `quoted` / `unquoted`         | `Csv.isFormattedValue` / `Csv.quoted` / `Csv.unquoted` (same names)         |

> This is the **standalone** CSV parser/formatter. It is separate from the
> Excel↔CSV bridge at `documonster/excel/csv` (§5.1), which reads/writes
> whole workbooks.

### 8.3 Standalone Markdown — `documonster/markdown`

| Old (`documonster/markdown` named export) | New (`Markdown.*`)  |
| ----------------------------------------- | ------------------- |
| `parseMarkdown`                           | `Markdown.parse`    |
| `parseMarkdownAll`                        | `Markdown.parseAll` |
| `formatMarkdown`                          | `Markdown.format`   |

Types (`MarkdownParseResult`, `MarkdownFormatOptions`, `MarkdownOptions`, …)
and errors (`MarkdownError`, `MarkdownParseError`, `isMarkdownError`) remain
flat named exports. This is separate from the Excel↔Markdown bridge at
`documonster/excel/markdown` (§5.2).

### 8.4 Standalone XML — `documonster/xml`

The `Xml` namespace collects encode/decode, DOM + SAX parsing, writers, and
query. Members were de-prefixed (`xmlEncode`→`Xml.encode`,
`xmlDecode`→`Xml.decode`, `xmlEncodeAttr`→`Xml.encodeAttr`, plus
`Xml.parse`, `Xml.query`, `Xml.encodeCData`, …). Types and errors
(`XmlError`, `XmlParseError`, `XmlWriteError`, `isXmlError`, `isXmlParseError`)
remain flat named exports.

### 8.5 Word — flat functions grouped into namespaces (`documonster/word`)

The Word module kept the same underlying functionality but reorganized its
**flat named function exports into namespaces**. Where a function's old name
already read well inside the namespace it kept its name; many were de-prefixed.
Types (`export type`), the document-model interfaces, and the error classes
stayed flat. Apply these mappings:

**Namespaces where members keep their old names** (just prefix with the
namespace): `Build.*` (all run/paragraph/table/math/shape/field builders:
`Build.text`, `Build.paragraph`, `Build.table`, `Build.heading`,
`Build.hyperlink`, `Build.field`, `Build.checkBox`, `Build.mathFraction`,
`Build.createRect`, …), `Units.*` (`Units.inchesToTwips`, `Units.ptToEmu`, …),
`Query.*` (`Query.replaceText`, `Query.mailMerge`, `Query.extractText`,
`Query.listTables`, `Query.acceptAllRevisions`, `Query.resolveStyle`,
`Query.extractFormFields`, `Query.walkDocument`, …), `Convert.*`
(`Convert.parseFlatOpc`, `Convert.toFlatOpc`, `Convert.readOdt`,
`Convert.writeOdt`, `Convert.ommlToMathML`, `Convert.mathMLToOmml`,
`Convert.docxToSemantic`, `Convert.mapDocument`, `Convert.createConversionContext`).

**Renamed members** (name changed inside the namespace):

| Old flat export                                                                | New access path                                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `readDocx`                                                                     | `Io.read`                                                                                                 |
| `packageDocx`                                                                  | `Io.package`                                                                                              |
| `mergeDocuments`                                                               | `Io.merge`                                                                                                |
| `splitDocument`                                                                | `Io.split`                                                                                                |
| `editDocxIncremental`                                                          | `Io.editDocxIncremental`                                                                                  |
| `listDocxParts` / `readDocxPart`                                               | `Io.listDocxParts` / `Io.readDocxPart`                                                                    |
| `patchDocument` / `compileTemplate` / `patchTemplate`                          | `Io.patchDocument` / `Io.compileTemplate` / `Io.patchTemplate`                                            |
| `updateFields` / `updateTableOfContents`                                       | `Io.updateFields` / `Io.updateTableOfContents`                                                            |
| `toBuffer` / `toBase64`                                                        | `Io.toBuffer` / `Io.toBase64`                                                                             |
| _(new)_ file-path IO                                                           | `Io.readFile` / `Io.writeFile`                                                                            |
| `resolveThemeColor`                                                            | `Theme.resolveColor`                                                                                      |
| `fillTemplate` / `fillTemplateEnhanced` / `listTemplateTags`                   | `Template.fillTemplate` / `Template.fillTemplateEnhanced` / `Template.listTemplateTags`                   |
| `fillTemplateFromSource` / `bindChartData` / `isTemplateChart`                 | `Template.fillTemplateFromSource` / `Template.bindChartData` / `Template.isTemplateChart`                 |
| `TemplateError`                                                                | `Template.TemplateError`                                                                                  |
| `JsonDataSource` (class)                                                       | `Template.createJsonDataSource` (factory)                                                                 |
| `XmlDataSource` (class)                                                        | `Template.createXmlDataSource` (factory)                                                                  |
| `CsvDataSource` (class)                                                        | `Template.createCsvDataSource` (factory)                                                                  |
| `CompositeDataSource` (class)                                                  | `Template.createCompositeDataSource` (factory)                                                            |
| `embedFont`                                                                    | `Font.embed`                                                                                              |
| `embedFontFamily`                                                              | `Font.embedFamily`                                                                                        |
| `addEmbeddedFonts`                                                             | `Font.addEmbedded`                                                                                        |
| `subsetFont`                                                                   | `Font.subset`                                                                                             |
| `shapeText` / `detectScript` / `detectDirection`                               | `Font.shapeText` / `Font.detectScript` / `Font.detectDirection`                                           |
| `createHyphenator` / `hyphenateWord` / `hyphenateText`                         | `Font.createHyphenator` / `Font.hyphenateWord` / `Font.hyphenateText`                                     |
| `layoutDocument`                                                               | `Layout.document`                                                                                         |
| `layoutDocumentFull`                                                           | `Layout.documentFull`                                                                                     |
| `renderPageToSvg` / `renderDocumentToSvg` / `renderPageFromLayout`             | `Layout.renderPageToSvg` / `Layout.renderDocumentToSvg` / `Layout.renderPageFromLayout`                   |
| `encryptDocx`                                                                  | `Security.encrypt`                                                                                        |
| `protectDocument` / `unprotectDocument`                                        | `Security.protect` / `Security.unprotect`                                                                 |
| `isDocumentProtected`                                                          | `Security.isProtected`                                                                                    |
| `getProtectionState`                                                           | `Security.getState`                                                                                       |
| `verifyProtectionPassword`                                                     | `Security.verifyPassword`                                                                                 |
| `resolveSecurityPolicy` / `DEFAULT_SECURITY_POLICY` / `STRICT_SECURITY_POLICY` | `Security.resolveSecurityPolicy` / `Security.DEFAULT_SECURITY_POLICY` / `Security.STRICT_SECURITY_POLICY` |
| `parseStyleMap`                                                                | `Styles.parse`                                                                                            |
| `createStyleMap`                                                               | `Styles.create`                                                                                           |
| `mergeStyleMaps`                                                               | `Styles.merge`                                                                                            |
| `matchStyleMap`                                                                | `Styles.match`                                                                                            |
| `DEFAULT_STYLE_MAP`                                                            | `Styles.DEFAULT`                                                                                          |
| `validateDocument`                                                             | `Validation.document`                                                                                     |
| `diffDocuments`                                                                | `Diff.documents`                                                                                          |
| `hasVbaProject` / `getVbaProjectInfo` / `getVbaProjectData`                    | `Vba.has` / `Vba.getInfo` / `Vba.getData`                                                                 |
| `addVbaProject` / `removeVbaProject` / `listVbaParts`                          | `Vba.add` / `Vba.remove` / `Vba.listParts`                                                                |
| `extractOleObjects` / `hasOleObjects` / `getOleObjectData`                     | `Ole.extract` / `Ole.has` / `Ole.getData`                                                                 |
| `createOleEmbedding` / `addOleObject`                                          | `Ole.createEmbedding` / `Ole.add`                                                                         |
| `createBuildingBlock` / `createGlossaryDocument`                               | `Glossary.createBlock` / `Glossary.createDocument`                                                        |
| `findBuildingBlock` / `listBuildingBlocks`                                     | `Glossary.findBlock` / `Glossary.listBlocks`                                                              |
| `getAutoTextEntries` / `getQuickParts`                                         | `Glossary.autoTextEntries` / `Glossary.quickParts`                                                        |
| `createRenderContext`                                                          | `RenderContext.create`                                                                                    |
| `createIdGenerators`                                                           | `RenderContext.createIds`                                                                                 |
| `StreamingDocxWriter` / `createDocxStream`                                     | `Streaming.StreamingDocxWriter` / `Streaming.createDocxStream`                                            |
| _(new)_ streaming reader                                                       | `Streaming.StreamingDocxReader` / `Streaming.createDocxStreamReader`                                      |

**Unchanged (still flat):** the error classes (`DocxError`, `DocxParseError`,
`DocxWriteError`, `DocxMissingPartError`, `DocxInvalidStructureError`,
`DocxUnsupportedFeatureError`, `DocxEncryptedError`, `DocxDecryptionError`,
`DocxLimitExceededError`, `isDocxError`) and every `export type` (data-model
types, options, `DocumentHandle`, layout/IR types). The Word→HTML/Markdown/
Excel/PDF integrations remain on their own subpaths
(`documonster/word/html`, `documonster/word/markdown`, `documonster/word/excel`,
and PDF via `documonster/pdf`).

> **`Document`** is still imported the same way
> (`import { Document } from "documonster/word"`), but it is now a **namespace
> re-export** of the document-handle module rather than a single binding.
> Members are reached as `Document.<member>`; the `DocumentHandle` **type** is
> still a flat `export type`.

### 8.6 Removed utility re-exports (previously on the root entry)

The old root `.` entry (`@cj-tech-master/excelts`) re-exported a grab-bag of
low-level helpers. These are **no longer exported from `documonster/excel`**
(nor from any other public entry). Migrate as follows:

| Old (root named export)                                                                               | New                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `decodeCell` / `encodeCol` / `decodeRow` / `encodeRow` / `encodeCell` / `decodeRange` / `encodeRange` | `Address.*` from `documonster/excel` (§4.10)                                                                            |
| `xmlEncode`                                                                                           | `Xml.encode` from `documonster/xml`                                                                                     |
| `xmlDecode`                                                                                           | `Xml.decode` from `documonster/xml`                                                                                     |
| `xmlEncodeAttr` / `validateXmlName`                                                                   | `Xml.encodeAttr` / `Xml.validateXmlName`                                                                                |
| `createTextWatermarkImage` / `TextWatermarkImageOptions`                                              | Use `Watermark.add(ws, opts)` on a worksheet (§4.10); the standalone image generator is no longer a public export       |
| `getCellDisplayText` / `formatCellValue` / `isDateDisplayFormat`                                      | Use `Cell.getDisplayText(ws, addr)` (§4.3); the standalone helpers are no longer public                                 |
| `dateToExcel` / `excelToDate`                                                                         | Internal — no longer public. Compute Excel serial dates in your own code, or store JS `Date` values directly in cells.  |
| `base64ToUint8Array` / `uint8ArrayToBase64`                                                           | Internal — no longer public. Use the platform `atob`/`btoa` or `Buffer`.                                                |
| `concatUint8Arrays` / `toUint8Array` / `stringToUint8Array` / `uint8ArrayToString`                    | Internal — no longer public. Use `TextEncoder`/`TextDecoder` and native array ops.                                      |
| `DateParser` / `DateFormatter` / `getSupportedFormats` / `DateFormat`                                 | Internal — no longer public.                                                                                            |
| `BaseError` / `toError` / `errorToJSON` / `getErrorChain` / `getRootCause`                            | Internal — no longer public. Catch the module-specific error classes (`ExcelError`, `PdfError`, `XmlError`, …) instead. |

If you depended on any of these, replace them with the namespace equivalent
above or inline a small implementation — they were never intended as a stable
public surface and are not re-exported by the per-module entries.

### 8.7 Signature and handle changes on the `Cell` / `Column` / `Worksheet` namespaces

Five things that used to need a workaround, or worked by accident:

| Old (excelts, or the first documonster surface)                                                 | Now                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Worksheet.addRows(ws, data as Record<string, unknown>[])`                                      | `Worksheet.addRows(ws, data)` — the keyed row type is `RowObject` (`object`), so a plain `interface` no longer needs a cast |
| `ws.getColumn("total").number`, or `Worksheet.columns(ws).find(c => c.key === "total")!.number` | `Column.getNumber(ws, "total")` (and `Column.getLetter`)                                                                    |
| `[...ws.columns.map(c => c.defn), extra]`, or hand-copying 7 fields                             | `[...Worksheet.columnDefinitions(ws), extra]` (single column: `Column.getDefinition(ws, ref)`)                              |
| `cell.value` on a handle from `Row.eachCell`                                                    | `Cell.view(cell).value` / `.text` / `.numFmt` / `.font` / `.alignment`; write with `Stream.setCell*(cell, …)`               |
| `Cell.setFont(ws, "B3", …)` only                                                                | `Cell.setFont(ws, 3, 2, …)` too — every cell function takes `"A1"` **or** `(row, col)`                                      |

Two deliberate compile-time breaks:

- **Mixed addressing is rejected.** `Cell.getValue(ws, "A1", 99)` used to
  type-check and silently read `"CUA1"` (`n2l(99) + "A1"`); `Cell.getValue(ws, 5)`
  used to type-check and throw `InvalidAddressError`. Both are now errors. Pass
  `"A1"` alone, or `(row, col)` together.
- **`Worksheet.columns(ws)` is read-only.** It returns the live column handles as
  `readonly Readonly<ColumnData>[]`, so `ws.columns[0].header = "X"` (which used
  to work, unadvertised, and bypassed the key registry and cell styles) no longer
  compiles. Declare columns with `Worksheet.setColumns`, change them with
  `Column.set*`, and read them with `Worksheet.columnDefinitions`. The elements
  are `ColumnView`s — deeply readonly, so nested writes such as
  `ws.columns[0].style.numFmt = "0"` are rejected too.

`Worksheet.columnCount(ws)` is **not** `Worksheet.columns(ws).length`: it counts
the cells actually present in rows, while `columns` / `columnDefinitions` list
the column _records_, which also exist for columns that were merely declared or
padded into being by a cell access. Both are documented as such now.

Style getters (`Cell.getStyle`, `Cell.getFont`, `Column.getStyle`, `Row.getStyle`
and the `font` / `alignment` on `Cell.view`) still return the cell's **live**
style objects, unchanged: read-modify-write
(`Cell.setStyle(ws, a, { ...Cell.getStyle(ws, b) })`) is a supported pattern, so
copy before editing if you do not mean to touch the source.

Cell and row **handles** stay mutable on purpose — `Stream.setCellValue(cell, …)`
and friends take a `CellData` / `RowData`, and that is the supported way to write
through a handle in streaming and non-streaming code alike.

### 8.8 Type imports (`Style`, `ColumnDefn`, `PageSetup`, …)

The old root entry did `export * from "@excel/types"`, so the whole style /
worksheet / table vocabulary was importable by name. `documonster/excel` exports
the same vocabulary, flat and under the same **declared** names — so in almost
all cases only the specifier changes:

```typescript
// before
import type { Style, Alignment, Border, ColumnDefn, PageSetup } from "@cj-tech-master/excelts";
// after
import type { Style, Alignment, Border, ColumnDefn, PageSetup } from "documonster/excel";
```

Three names changed, because the namespaces introduced in documonster took them,
or to fix a typo:

| Old type (excelts)                          | New type (documonster/excel) | Why                                                                        |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `DataValidation` (the rule object)          | `DataValidationRule`         | `DataValidation` is now the namespace (`DataValidation.add(dv, …)`)        |
| `Address` (decoded `{ address, row, col }`) | `DecodedAddress`             | `Address` is now the namespace (`Address.decodeCell(…)`)                   |
| `Cvfo`                                      | `Cfvo`                       | Spelling fix — OOXML calls it a _conditional format value object_ (`cfvo`) |

`CellAddress` (the 0-indexed `{ c, r }` pair returned by `Address.decodeCell`),
`SheetRange` and `Origin` keep their names. `Cell.getFullAddress` now returns
`DecodedAddress` as well, so the three near-duplicate address types excelts
carried internally are down to two.

Removed, because they were unreferenced dead declarations:

| Old type                                   | Replacement                                                                                                                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StyleInput` / `StyleOutput`               | `Style`. The split was never wired up and `StyleOutput` was wrong: the reader resolves `numFmtId` to its **format-code string**, so a style read back from a workbook has `numFmt: string`, not `{ id, formatCode }`                                       |
| `Media`                                    | `WorkbookMedia` (what the workbook actually stores)                                                                                                                                                                                                        |
| `ImagePosition` / `ImageHyperlinkValue`    | Use `AddImageRange` — the range/position/hyperlink shape `Image.place` accepts. Note `documonster/excel` also exports `ImageAbsolutePosition` (`{ x, y }`, for absolute anchors); it is a different concept and deliberately **not** named `ImagePosition` |
| `TableColumn`                              | `Required<TableColumnProperties>`                                                                                                                                                                                                                          |
| `DefinedNamesRanges` / `DefinedNamesModel` | `DefinedNameModel[]` — one entry per defined name (`DefinedNames.model(dn)` returns the array)                                                                                                                                                             |
| `Buffer` (alias of `Uint8Array`)           | `Uint8Array`                                                                                                                                                                                                                                               |

Streaming types moved onto the `Stream` namespace, next to the streaming classes:

```typescript
// before
import type {
  WorkbookWriterOptions,
  WorksheetReaderOptions,
  RowEvent
} from "@cj-tech-master/excelts";
// after
import { Stream } from "documonster/excel";
type Options = Stream.WorkbookWriterOptions;
type SheetOptions = Stream.WorksheetReaderOptions;
type Row = Stream.RowEvent;
```

`NodeInput` (the streaming reader input) is now `Stream.WorkbookReaderInput` on
both entries — the Node variant still adds the file-path form.

`PaperSize` is still a value, and so are the enums — but all of them are now
plain constant objects rather than TS `enum`s, so they tree-shake away when
unused. Member access is unchanged:

```typescript
import { Cell, ErrorValue, PaperSize, ValueType } from "documonster/excel";

if (Cell.getType(ws, "A1") === ValueType.Number) {
  /* … */
}
ws.pageSetup.paperSize = PaperSize.A4;
```

Two consequences of dropping `enum`:

- the **reverse mapping is gone** (`ValueType[2]` no longer yields `"Number"`);
  map the numbers yourself if you relied on it, e.g.
  `Object.entries(ValueType).find(([, v]) => v === t)?.[0]`.
- the types are literal unions now, so an arbitrary `number` is no longer
  silently assignable to `ValueType` — a cast is required where you genuinely
  have an unchecked number. `PageSetup.paperSize` stays `number`, so passing a
  code that `PaperSize` does not name (Letter = `1`, A3 = `8`, …) still works.

`ErrorValueType` is now simply `ErrorValue` (the constant object and its derived
union share one name), and it gained the two members the old type union had but
the old constant lacked (`Spill` = `#SPILL!`, `Calc` = `#CALC!`), so
`CellErrorValue.error` and `ErrorValue` are finally the same set of strings.

`RelationshipType` / `ReadingOrder` / `DocumentType` are no longer public — they
described internal OOXML plumbing.

---

## 9. Step-by-step migration checklist

Apply in order:

1. **Swap the dependency**: uninstall `@cj-tech-master/excelts`, install
   `documonster`.
2. **Global find/replace import specifiers** using the §2 table. In particular:
   - `from "@cj-tech-master/excelts"` → `from "documonster/excel"`
   - `from "@cj-tech-master/excelts/browser"` → `from "documonster/excel"`
   - `@cj-tech-master/excelts/<sub>` → `documonster/<sub>`
3. **Rewrite Excel object construction**: `new Workbook()` → `Workbook.create()`.
   There are no other `new` calls for Excel domain types (Range, Note, Table,
   Image, etc.) — replace with the corresponding `X.create(...)`.
4. **Rewrite every Excel method/property access** using §4 tables. The pattern
   is always: `obj.method(args)` → `Namespace.method(obj, args)` and
   `obj.prop` / `obj.prop = v` → `Namespace.getProp(obj)` /
   `Namespace.setProp(obj, v)`. Watch for renamed members
   (`getSheetValues`→`getValues`, `mergeCells`→`merge`, `toJSON`→`toJson`, …).
5. **Replace `wb.xlsx.*` I/O** with `Workbook.read` / `Workbook.readFile` /
   `Workbook.toBuffer` / `Workbook.writeFile` (§3.3). Reading requires a
   pre-created handle: `const wb = Workbook.create(); await Workbook.read(wb, bytes);`.
6. **Move CSV/Markdown calls** to `documonster/excel/csv` /
   `documonster/excel/markdown` free functions, passing `wb` first (§5).
7. **Replace `excelToPdf(wb, opts)`** with `await Pdf.fromExcel(wb, opts)` and
   drop any `pdf`/`excelToPdf` import in favor of `Pdf.*` (§6).
8. **Remove `installFormulaEngine()`** and replace `wb.calculateFormulas()`
   with `calculateFormulas(wb)` from `documonster/excel/formula` (§7).
9. **Update document-property mutations** (`wb.title = …`, `wb.creator = …`,
   etc.) to go through `Workbook.getModel(wb)` / `Workbook.setModel(wb, model)`
   (§4.1).
10. **Update standalone-module calls** to their namespaces: `parseCsv`→`Csv.parse`,
    `formatMarkdown`→`Markdown.format`, `xmlEncode`→`Xml.encode`, and every Word
    flat function → its namespace (`readDocx`→`Io.read`, `replaceText`→
    `Query.replaceText`, `layoutDocument`→`Layout.document`, `encryptDocx`→
    `Security.encrypt`, …) per §8.2–§8.5.
11. **Type-check.** Because the API is now function-based, TypeScript will flag
    every remaining `.method`/`.prop` on a handle and every missing named export
    — use those errors as a to-do list until the project compiles.

---

## 10. Complete before/after example

**Before (excelts):**

```ts
import { Workbook } from "@cj-tech-master/excelts";
import { installFormulaEngine } from "@cj-tech-master/excelts/formula";
import { excelToPdf } from "@cj-tech-master/excelts/pdf";

installFormulaEngine();

const wb = new Workbook();
wb.creator = "Reports Bot";

const ws = wb.addWorksheet("Sales");
ws.columns = [
  { header: "Product", key: "product", width: 20 },
  { header: "Revenue", key: "revenue", width: 15 }
];
ws.addRow({ product: "Widget", revenue: 1000 });
ws.addRow({ product: "Gadget", revenue: 2500 });
ws.getCell("B4").value = 42;
ws.getCell("B4").font = { bold: true };
ws.getCell("C1").value = { formula: "SUM(B2:B3)" };
ws.mergeCells("A6:B6");

wb.calculateFormulas();

await wb.xlsx.writeFile("sales.xlsx");
const pdfBytes = await excelToPdf(wb);

const csv = wb.writeCsv();
```

**After (documonster):**

```ts
import { Workbook, Worksheet, Cell } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";
import { Pdf } from "documonster/pdf";
import { writeCsv } from "documonster/excel/csv";

const wb = Workbook.create();
const model = Workbook.getModel(wb);
model.creator = "Reports Bot";
Workbook.setModel(wb, model);

const ws = Workbook.addWorksheet(wb, "Sales");
Worksheet.setColumns(ws, [
  { header: "Product", key: "product", width: 20 },
  { header: "Revenue", key: "revenue", width: 15 }
]);
Worksheet.addRow(ws, { product: "Widget", revenue: 1000 });
Worksheet.addRow(ws, { product: "Gadget", revenue: 2500 });
Cell.setValue(ws, "B4", 42);
Cell.setFont(ws, "B4", { bold: true });
Cell.setValue(ws, "C1", { formula: "SUM(B2:B3)" });
Worksheet.merge(ws, "A6:B6");

calculateFormulas(wb);

await Workbook.writeFile(wb, "sales.xlsx");
const pdfBytes = await Pdf.fromExcel(wb, { recalculate: calculateFormulas });

const csv = writeCsv(wb);
```

---

## 11. Quick reference: what was removed

- Package `@cj-tech-master/excelts` (renamed to `documonster`).
- Root `.` export and `./browser` export.
- All Excel domain **classes**: `Workbook`, `Worksheet`, `Cell`, `Row`,
  `Column`, `Range`, `Table`, `Image`, `Note`, `FormCheckbox`,
  `DataValidations`, `DefinedNames`, `Chartsheet`, `Chart` (as classes).
- `Workbook.xlsx` I/O accessor.
- `Workbook` CSV methods (`readCsv`, `writeCsv`, `writeCsvBuffer`,
  `readCsvFile`, `writeCsvFile`, `createCsvReadStream`, `createCsvWriteStream`)
  and Markdown methods (`readMarkdown`, `readMarkdownAll`, `writeMarkdown`,
  `writeMarkdownBuffer`, `readMarkdownFile`, `readMarkdownAllFile`,
  `writeMarkdownFile`).
- `Workbook.calculateFormulas()`.
- Top-level `excelToPdf` / `pdf` / `readPdf` / `PageSizes` /
  `PdfDocumentBuilder` / `PdfEditor` named exports (→ `Pdf.*`).
- Formula `installFormulaEngine`, `uninstallFormulaEngine`,
  `createFormulaSyntaxProbe`, and the `SyntaxProbe` export.
- `Formula.calculate` (workbook recalculation now lives at
  `documonster/excel/formula`).
- The structural host types `WorkbookLike`, `WorksheetLike`, `RowLike`,
  `CellLike`, `CellErrorValueLike`, `FormulaResultLike`, `DefinedNameEntry`,
  `DefinedNamesLike`, `DimensionsLike`, `SpillRegion`.
- `registerFunction`'s `volatile` option (never read by the engine).
- Root-entry utility re-exports: `decodeCell`/`encodeCol`/… (→ `Address.*`),
  `xmlEncode`/`xmlDecode`/… (→ `Xml.*`), `createTextWatermarkImage`,
  `getCellDisplayText`/`formatCellValue`, `dateToExcel`/`excelToDate`,
  `base64ToUint8Array`/`uint8ArrayToBase64`, `concatUint8Arrays`/`toUint8Array`/
  `stringToUint8Array`/`uint8ArrayToString`, `DateParser`/`DateFormatter`,
  `BaseError`/`toError`/`errorToJSON`/`getErrorChain`/`getRootCause` (§8.6).

Everything above has a functional replacement documented in this guide.
