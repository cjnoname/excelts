# Excel 模块

[English](README.md)

现代化的 TypeScript Excel 工作簿管理器 —— 零运行时依赖，读取、操作并写入 XLSX 与 JSON 电子表格。

## 特性

- **创建、读取并修改 XLSX 文件** —— 完整的 Open XML 支持
- **多工作表支持** —— 添加、删除、重排、复制
- **单元格样式** —— 字体、颜色、边框、填充、对齐、数字格式
- **单元格合并与格式化** —— 合并区域、富文本、超链接
- **行与列属性** —— 宽度、高度、隐藏、分级显示级别、自动适应；按对象添加行时支持嵌套列键路径（`"address.city"`）
- **冻结窗格与拆分视图** —— 冻结行/列、按位置拆分
- **富文本支持** —— 单个单元格内可包含多种字体/样式
- **公式与计算值** —— 共享公式、定义名称
- **数据验证** —— 列表、整数、小数、日期、文本长度、自定义
- **条件格式** —— 单元格值、色阶、数据条、图标集
- **图片** —— JPEG、PNG、GIF，支持单格与双格锚定；可嵌入或通过 URL/文件路径外部（链接）引用；SVG 带栅格回退
- **形状** —— 矩形、椭圆、直线、文本框，支持填充/轮廓/文字
- **超链接** —— 内部、外部、电子邮件
- **数据透视表** —— 读取并保留数据透视表定义
- **图表** —— 创建/读取/编辑经典图表、ChartEx 现代图表、组合图、透视图、图表工作表，以及零依赖的 SVG/PNG/PDF 预览（确定性输出，并非 Excel 像素级精确 —— 参见[渲染范围](#渲染范围)）
- **表格** —— 自动筛选、汇总行、结构化引用
- **批注与备注** —— 线程化批注、传统备注
- **复选框** —— 表单控件与单元格级复选框
- **页面设置** —— 打印区域、打印标题、页眉/页脚、分页符
- **数据保护** —— 带密码（SHA-512）的工作表保护
- **流式处理** —— 用于大文件的 `WorkbookReader` 与 `WorkbookWriter`
- **CSV 导入/导出** —— `readCsv`、`writeCsv`、`readCsvFile`、`writeCsvFile`
- **Markdown 导入/导出** —— `readMarkdown`、`writeMarkdown`、`readMarkdownFile`、`writeMarkdownFile`
- **PDF 导出** —— `Pdf.fromExcel()`，支持完整样式、分页、字体、加密
- **浏览器支持** —— `xlsx.load()`、`xlsx.writeBuffer()`，无需任何 polyfill

## 快速开始

### 创建工作簿

```typescript
import { Workbook, Worksheet } from "documonster/excel";

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "My Sheet");

// 添加数据
Worksheet.addRow(sheet, ["Name", "Age", "Email"]);
Worksheet.addRow(sheet, ["John Doe", 30, "john@example.com"]);
Worksheet.addRow(sheet, ["Jane Smith", 25, "jane@example.com"]);

// Node.js：写入文件
await Workbook.writeFile(workbook, "output.xlsx");

// 浏览器：写入缓冲区
const buffer = await Workbook.toBuffer(workbook);
```

#### 按对象添加行（带嵌套键）

当列设置了键时，行可以从对象添加。键可以使用点分路径从嵌套对象中提取值：

```typescript
Worksheet.setColumns(sheet, [
  { header: "Name", key: "name", width: 20 },
  { header: "City", key: "address.city", width: 20 }
]);
Worksheet.addRow(sheet, { name: "Alice", address: { city: "Sydney" } });
```

### 读取工作簿

```typescript
import { Workbook, Worksheet, Row } from "documonster/excel";

const workbook = Workbook.create();

// Node.js：从文件读取
await Workbook.readFile(workbook, "input.xlsx");

// 浏览器：从 ArrayBuffer 读取
await Workbook.read(workbook, arrayBuffer);

const worksheet = Workbook.getWorksheet(workbook, 1);
Worksheet.eachRow(worksheet, (row, rowNumber) => {
  console.log("Row " + rowNumber + " = " + JSON.stringify(Row.values(worksheet, rowNumber)));
});
```

### 读取区域

`Range.getValues` 按行优先把矩形区域读成矩阵：

```typescript
import { Range } from "documonster/excel";

const values = Range.getValues(worksheet, "G7:H19");
// values.length === 13，values[0].length === 2
// values[r][c] 对应第 7 + r 行、第 G + c 列的单元格
```

返回的矩阵尺寸始终与区域一致 —— 空行和空格保留各自位置并读为 `null`，因此无论工作表多稀疏，下标都与请求一一对应。读取不会创建单元格，工作表保持原样。

取值语义与 `Cell.getValue` 完全相同：公式单元格返回 `{ formula, result }` 记录，日期返回 `Date`，合并区域的每个单元格都返回主单元格的值。

除 A1 字符串外也接受 `Range.Handle`，几何计算与读取可以组合：

```typescript
Range.getValues(worksheet, Range.create(7, 7, 19, 8)); // 等价于 "G7:H19"
```

整列（`"A:A"`）和整行（`"1:5"`）引用会被拒绝 —— 它们没有可读的边界，未设置的区域同理。要读取整张表，可以传 `Worksheet.dimensions(worksheet)`（空表的 dimensions 处于未设置状态，因此会被拒绝），或者用 `Worksheet.getValues(worksheet)` —— 注意后者按行**号**索引，`result[1]` 是第 1 行，`result[0]` 为空。

### 设置单元格样式

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

数字格式往往属于整列而不是逐个单元格，所以 `setNumFmt` 在三个层级都有：

```typescript
import { Column, Row } from "documonster/excel";

Column.setNumFmt(worksheet, "revenue", "$#,##0.00"); // 可用 key、字母或列号
Row.setNumFmt(worksheet, 2, "0.00%");
```

在行或列上设置某个样式面，会同时应用到该行/列**以及其中已存在的单元格**。`Row` 另有
`setFont` / `setFill` / `setBorder` / `setAlignment`；其余组合走 `setStyle` ——
一次设置多个样式面时也该用它，因为它只遍历一遍：

```typescript
Column.setStyle(worksheet, "revenue", { numFmt: "$#,##0.00", alignment: { horizontal: "right" } });
```

### 数字格式

```typescript
import { Cell } from "documonster/excel";

// 货币
Cell.setNumFmt(worksheet, "A1", "$#,##0.00");

// 百分比
Cell.setNumFmt(worksheet, "A1", "0.00%");

// 日期
Cell.setNumFmt(worksheet, "A1", "yyyy-mm-dd");

// 自定义
Cell.setNumFmt(worksheet, "A1", '#,##0.00 "units"');
```

### 富文本

```typescript
Cell.setValue(worksheet, "A1", {
  richText: [
    { text: "Bold ", font: { bold: true } },
    { text: "and ", font: {} },
    { text: "Red", font: { color: { argb: "FFFF0000" } } }
  ]
});
```

### 公式

```typescript
Cell.setValue(worksheet, "A1", { formula: "SUM(A1:A10)" });
Cell.setValue(worksheet, "A1", { formula: "A1+B1", result: 42 }); // 带缓存结果

// 共享公式
Cell.setValue(sheet, "A1", { formula: "B1*2", shareType: "shared", ref: "A1:A10" });

// 定义名称
DefinedNames.add(Workbook.getDefinedNames(workbook), "Sheet1!$A$1:$B$10", "MyRange");
```

设置公式只是存下公式,并不会求值。要计算结果,从 `documonster/excel/formula`
subpath 导入计算引擎(单独拆开,好让约 200 KB 的引擎不进入只读写 XLSX 的
bundle — 无需任何安装或注册步骤):

```typescript
import { Workbook, Cell } from "documonster/excel";
import { calculateFormulas } from "documonster/excel/formula";

Cell.setValue(worksheet, "A4", { formula: "SUM(A1:A3)" });
calculateFormulas(workbook); // 结果就地写回
console.log(Cell.getResult(worksheet, "A4"));
```

448 个支持的函数、以及如何在非 excel 宿主上驱动引擎,见
[formula 模块文档](../formula/README_zh.md)。

### 数据验证

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

### 条件格式

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

### 图片

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

#### 嵌入式与外部（链接）图片

`Image.add` 以两种方式之一注册图片：

- **嵌入式** —— 传入 `buffer`、`base64` 或 `filename`。字节会写入 `.xlsx`
  包（`xl/media/imageN.ext`）。自包含，但文件会随每张图片增大。
- **链接式（外部）** —— 仅传入 `link`（URL 或本地文件路径）。不存储任何字节；
  包会保留一个 `TargetMode="External"` 的关系，图片通过 `<a:blip r:link>`
  渲染。文件保持较小，图片在工作簿打开时由 Excel 解析。

如果同时提供了字节和 `link`，则**嵌入式优先**。

```typescript
// 来自 URL 的链接图片——不会向 xl/media/ 写入任何内容。
const urlId = Image.add(workbook, { extension: "png", link: "https://example.com/logo.png" });
Image.place(worksheet, urlId, "B2:D6");

// 来自本地文件路径的链接图片（由 Excel 在打开时解析）。
const fileId = Image.add(workbook, { extension: "png", link: "file:///C:/images/logo.png" });
Image.place(worksheet, fileId, "F2:H6");
```

链接图片也可用作覆盖式水印：

```typescript
const wmId = Image.add(workbook, { extension: "png", link: "https://example.com/draft.png" });
Watermark.add(worksheet, { imageId: wmId, mode: "overlay", opacity: 0.15 });
```

**注意事项**（这是 Excel 固有的限制，而非本库的限制）：

- 链接图片是易失的——如果目标移动或工作簿被共享，Excel 会显示损坏图片占位符。
  对于自包含文件，请使用嵌入式。
- 出于安全原因，现代 Excel 可能拒绝自动加载远程 URL。
- 只有**单元格图片**和**覆盖式水印**可以链接。工作表**背景**图片
  （`Image.setBackground`）和**页眉/页脚（VML）**水印
  （`Watermark.add(worksheet, { mode: "header" })`）**不能**被链接——若给定链接图片，
  它们会抛出 `ImageError`（Excel 在打开时会丢弃此类背景）。这些情况请使用嵌入式图片。

参见可运行的 [`images-external.ts`](examples/images-external.ts) 示例。

#### SVG 图片（带栅格回退）

Excel 通过栅格 `a:blip` 加上 `asvg:svgBlip` 扩展来渲染 SVG 图片。本库**不**进行
栅格化——你需要同时提供 SVG 字节和你想嵌入的栅格回退（通常是 PNG）。现代 Excel
显示清晰的 SVG；旧版本和非 SVG 消费者则显示栅格回退。

```typescript
const id = Image.add(workbook, {
  buffer: pngFallbackBytes, // 栅格回退——必需
  extension: "png",
  svg: { buffer: svgBytes } // Excel 2016+ 显示的矢量数据
});
Image.place(worksheet, id, "B2:D6");
```

### 形状

添加锚定到单元格区域的自由绘制形状（矩形、椭圆、直线、文本框……）。形状不需要
媒体文件——几何、填充、轮廓和可选的文本标签会直接写入绘图部件。

```typescript
Image.addShape(worksheet, {
  type: "rect", // rect | roundRect | ellipse | triangle | line | …
  range: "B2:D5", // 单元格区域或 { tl, br } 锚点
  fillColor: "FFD966", // 十六进制 RGB（省略则无填充）
  lineColor: "000000",
  lineWidth: 1, // 磅
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

形状是只写的（读取时不会解析回来），这与其他非图表绘图内容保持一致。

### 表格

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

### 合并单元格

```typescript
Worksheet.merge(worksheet, "A1:D1");
Cell.setValue(worksheet, "A1", "Merged Header");
Cell.setAlignment(worksheet, "A1", { horizontal: "center" });
```

### 冻结窗格

```typescript
// 冻结首行
worksheet.views = [{ state: "frozen", ySplit: 1 }];

// 冻结首列
worksheet.views = [{ state: "frozen", xSplit: 1 }];

// 同时冻结
worksheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
```

### 页面设置

```typescript
worksheet.pageSetup = {
  paperSize: 9, // A4
  orientation: "landscape",
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 0,
  margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75 }
};

// 打印区域
worksheet.pageSetup.printArea = "A1:G20";

// 打印标题（每页重复第 1-2 行）
worksheet.pageSetup.printTitlesRow = "1:2";
```

### 分页符

手动分页符，等价于 Excel 的**页面布局 → 分隔符 → 插入分页符**。它影响打印与
`Pdf.fromExcel`，不影响屏幕上的网格。

```typescript
import { Column, Row } from "documonster/excel";

Row.addPageBreak(worksheet, 20); // 第 2 页从第 21 行开始
Column.addPageBreak(worksheet, "F"); // 下一页从 G 列开始
```

分页符总是贯穿整个工作表的宽度或高度。`CT_Break` 有 `min`/`max` 属性，理论上可以把
分页符限制在若干列或若干行的区带内，但这里刻意不暴露：Excel 的界面无法创建这种分页符，
Excel 写出的文件一律贯穿全幅，而 `Pdf.fromExcel` 只读取分页位置 —— 因此区带是一个
两边都观察不到的值。

用流式写入器时，你持有的是行**句柄**而不是行号，因此分页符走 `Stream` 面：

```typescript
import { Stream } from "documonster/excel";

Stream.addRowPageBreak(sheet.getRow(20));
```

### 工作表保护

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

### 批注

```typescript
Cell.setNote(worksheet, "A1", "Simple comment");

Cell.setNote(worksheet, "B1", {
  texts: [{ text: "Author: ", font: { bold: true } }, { text: "This is a rich text comment" }]
});

// 配置批注框尺寸（磅）。默认为 97.8 × 59.1pt。
Cell.setNote(worksheet, "C1", {
  texts: [{ text: "A roomier note" }],
  width: 200,
  height: 120
});
```

### 自动适应列宽

```typescript
Worksheet.autoFitColumns(worksheet);
```

## 图表

Documonster 包含结构化的图表 API、用于模板的原始 XML 保留，以及确定性预览渲染器。它旨在填补那些只保留图表 XML 或只写入工作表数据的库所留下的开源空白。

> **设置：** 无需安装或注册步骤。图表 API
> （`Chart.add`、各类型快捷方法、图表加载/写入等）直接静态地引入图表实现。
> 从不引用任何图表 API 的消费者，其整个图表实现树会被从打包产物中 tree-shaken 掉。

> 一个可运行的端到端示例位于 [`src/modules/excel/examples/charts.ts`](examples/charts.ts) —— 它创建了 70 多个图表，涵盖每一种经典 + ChartEx 类型、所有预设系列、组合/透视/图表工作表布局，并导出 SVG / PNG / PDF 预览。运行命令：`pnpm exec tsx src/modules/excel/examples/charts.ts`。

### 渲染范围

内置的 `Chart.toSVG(chart)` / `Chart.toPNG(chart)` / `Pdf.fromChart(chart)` 辅助方法生成的是**零依赖的确定性预览** —— 并非 Excel 像素级精确的合成器。经典图表由一个在 SVG、PNG 和 PDF 之间共享的 `ChartScene` 中间表示驱动；ChartEx 图表使用专门的几何收集器，从构造上保证 SVG 与矢量 PDF 路径等价。该预览非常适合：

- 服务端缩略图、电子邮件附件和 README 图片
- CI 健全性检查（"该图表能否在不崩溃的情况下渲染"）
- 用户打开 Excel 前的快速仪表盘预览

当像素级一致的输出至关重要时，它**不能**替代 Excel / LibreOffice 渲染。具体范围边界：

- Excel 内部的文本布局启发式、字体微调（hinting）和字偶距（kerning）是近似的，而非复现的
- 3D 渲染仅限于 `bar3D` 轴测投影；其他 3D 变体回退到 2D（参见下方的 3D 说明）
- DrawingML 效果滤镜（阴影/发光/柔化边缘/模糊/反射）会以 SVG `<filter>` 形式输出，但被 Node PNG 栅格化器静默丢弃
- 透视图字段按钮和拖放区 UI 仅为元数据 —— 仍由宿主应用程序绘制它们

**对于生产级渲染**，请通过无头 LibreOffice（`soffice --convert-to pdf`）对 `.xlsx` 进行往返转换。未被修改的图表部件会以加载时的原始字节交给 LibreOffice，而 `templateMode: "strict"` 会拒绝重新渲染任何无法就地修补的已编辑图表部件——因此这一交接不会悄悄用重建产物替换原件。

### 经典图表

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

### 预设与便捷 API

```typescript
import {
  EXCEL_CHART_PRESETS,
  EXCEL_CHART_EX_PRESETS,
  applyChartPreset,
  applyChartExPreset
} from "documonster/chart";

// 99 个经典预设 + 10 个 ChartEx 预设（Excel UI 别名）
Chart.addPreset(ws, "col3DConeStacked100", { series: [{ values: "Sales!$B$2:$B$4" }] }, "E1:M16");
Chart.addPresetEx(ws, "boxAndWhisker", { series: [{ values: "Samples!$A$2:$A$50" }] }, "N1:V16");

// 各类型快捷方法——`type` 字段已隐含。
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
// ChartEx 快捷方法
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

从数据帧风格的输入构建图表选项包：

```typescript
// 对象数组 → 图表：将行暂存到工作表并返回图表编号。
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

// 列快捷方法——同上，隐含 `type: "bar", barDir: "col"`。
Chart.addColumnFromRows(ws, rows, { x: "quarter", y: "revenue", startCell: "A1" }, "C1:K16");

// Excel 表格 → 图表。系列引用是结构化的（`Table1[Col]`），
// 因此当表格增长时图表会自动扩展。
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

// ChartEx 辅助方法具有相同的形态。
Chart.addExFromRows(ws, rows, { type: "histogram", x: "bucket", y: "count" }, "AA1:AI18");
Chart.addExFromTable(
  ws,
  table,
  { type: "funnel", categoryColumn: "Stage", valueColumns: ["Users"] },
  "AA20:AI40"
);

// 低级区域辅助方法——发出带绝对引用的系列，与
// 构建器内部产出的内容一致。
const s = Chart.seriesFromColumns(ws, {
  categories: "Sales!$A$2:$A$7",
  values: "Sales!$B$2:$B$7",
  name: "Revenue"
});
Chart.add(ws, { type: "line", series: [s] }, "A20:I35");
```

### 组合图、ChartEx、透视图与图表工作表

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

// ChartEx —— Office 2016+ 现代类型（histogram/pareto/waterfall/funnel/
// treemap/sunburst/boxWhisker/regionMap）。每种类型都有专门的
// 快捷方法；如需完全控制，请将 `AddChartExOptions` 传入 `addChartEx`。
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

// 透视图——与经典图表选项相同，外加回到透视表的链接；
// `pivotChartOptions` 控制拖放区可见性、打开时刷新，
// 以及 Office 2014 的展开/折叠字段按钮。
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

// 图表工作表——独立标签页上的整页图表。可与
// `AddChartOptions`、`AddComboChartOptions` 或 `AddChartExOptions` 中的任意一种配合使用。
Workbook.addChartsheet(workbook, "Revenue Chart", {
  tabSelected: true,
  zoomToFit: true,
  chart: { type: "bar", series: [{ values: "Sales!$B$2:$B$4" }] }
});

Workbook.addPivotChartsheet(workbook, "Pivot Dashboard", pivot, {
  chart: { type: "line", showMarker: true, series: [{ values: "Sales!$B$2:$B$4" }] }
});
```

### 锚定形式

```typescript
// 字符串 A1 区域（双格锚定，最常见的形式）。
Chart.add(ws, { type: "bar", series: [{ values: "Sales!$B$2:$B$4" }] }, "A1:H15");

// 带行/列坐标的双格锚定。
Chart.add(ws, options, { tl: { col: 1, row: 2 }, br: { col: 8, row: 17 } });

// 单格锚定——固定到某单元格，带固定的 EMU 范围（5×3 英寸）。
// 914400 EMU = 1 英寸。
Chart.add(ws, options, {
  tl: { col: 1, row: 19 },
  ext: { cx: 5 * 914400, cy: 3 * 914400 },
  editAs: "oneCell"
});

// 绝对锚定——固定的 EMU 位置 + 尺寸，忽略行/列。
Chart.add(ws, options, {
  pos: { x: 914400, y: 36 * 914400 },
  ext: { cx: 5 * 914400, cy: 3 * 914400 },
  editAs: "absolute"
});
```

### 高级系列格式化

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
        // 单点覆盖
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

// 图片填充（用图片填充柱形）。接受原始 Uint8Array、
// `data:` URL、裸 base64 字符串、`{ workbookImageId }` 句柄，
// 或结构化的 `ChartPictureFillImageData`。
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

### 图表样式

```typescript
// 传统 2007/2010 内置样式（1..48）。发出 `<c:style val="N"/>`。
Chart.setStyle(chart, 42);
Chart.setBuiltInStyle(chart, 42); // 内置样式索引的别名

// 现代 Office 2013+ 附属文件——完整的 styleN.xml + colorsN.xml。
// 通过 `addChart` 选项应用，或之后通过图表条目复制进来。
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

### 预览导出

```typescript
import { Chart } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const chart = Chart.get(ws)[0];

// SVG / PNG 预览——PNG 返回 Promise，因为 Node 栅格化器是异步的。
const svg = Chart.toSVG(chart, { width: 800, height: 450, backgroundColor: "transparent" });
const png = await Chart.toPNG(chart, { width: 800, height: 450, scale: 2, dpi: 192 });

// 独立的单页 PDF——经典图表渲染为矢量内容
//（可选中的文本、与分辨率无关的形状）；ChartEx 类型
// 在受支持时也渲染为矢量，或通过 `forceRaster: true` 栅格化。
const pdf = await Pdf.fromChart(chart, {
  title: "Revenue",
  width: 640,
  height: 400,
  margin: 36
});

// 显式检查矢量与栅格的决策：
import { canRenderChartExAsVectorPdf } from "documonster/chart";
const chartExModel = Chart.chartExModel(chart);
if (chartExModel) {
  console.log(canRenderChartExAsVectorPdf(chartExModel));
}
```

预览渲染有意做到确定性且无依赖。浏览器 PNG 导出使用 canvas。Node.js PNG 导出使用内置的基础栅格化器。它为缩略图、测试和服务端预览绘制核心图表几何、坐标轴、次坐标轴、坐标轴标题、图例、标签、标记、趋势线和误差线；它不是 Excel 像素级精确的渲染器，也不是与 Excel 一致的布局引擎。ChartEx 的 `regionMap` 预览对已知区域使用一个小型内置的国家质心表加投影数学，对未知标签使用确定性瓦片回退；它们是地理预览，而非 GIS/地图边界渲染器。

### 模板保留

加载的图表 XML 在未被修改时会逐字节保留。对于安全的高级修改，Documonster 仅修补已知的 XML 块，并保持不支持的扩展完好无损：

- 经典图表：标题、图例、系列引用、系列格式化、标记、数据点、数据标签、趋势线、误差线、坐标轴、绘图区布局
- ChartEx 图表：图表数据、标题、图例、自动标题删除、图表/绘图形状、绘图区布局、系列可见性/名称/坐标轴绑定、系列数据引用、布局属性（包括 `extLst` 透传）、数据标签、数据点和坐标轴
- 不安全的结构性修改回退到结构化重新渲染

当你想在编辑已加载的模板图表后进行局部 XML 修补时，使用 `Chart.mutate(chart, model => { ... }, { preferRawPatch: true })`。

对于严格的模板工作流，使用 `requireRawPatch: true`，以便在修改无法被安全修补时失败，而不是回退到结构化重新渲染：

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

这为受支持的修补类别提供了"保留原始模板 XML，否则抛出"的硬性保证。它并不声称任意未知的 OOXML 都能被安全修改；当设置了 `requireRawPatch` 时，不支持的结构性编辑会被拒绝。

你也可以在写入时对每一个加载的 chart/chartEx 部件强制执行该规则：

```typescript
await Workbook.toBuffer(workbook, { templateMode: "strict" });
// 或
await Workbook.toBuffer(workbook, { strictTemplateMode: true });
```

严格模板模式影响从现有工作簿加载的、被编辑过的图表部件。新创建的图表仍按结构化方式渲染。

### 包部件保留

真实工作簿会携带本库并未建模的部件：VBA 项目、自定义文档属性、数据连接、查询表、打印机设置、厂商扩展。对这些部件的契约是：

> **保留每一个能够重新建立可达性的部件；其余部件明确丢弃，并报告原因。**

保留一个部件不只是留下它的字节。读取方通过 relationship 找到部件，并通过 content type 决定如何解释它，而本 writer 会从模型重新生成 `[Content_Types].xml` 和每一个 `.rels` 文件。因此有三样东西随保留部件一起被带出：

- 它的 `Override` content type，或其扩展名对应的 `Default` —— 当源包对该扩展名的声明与本 writer 输出的不同时，会被提升为该部件上的显式 `Override`，使厂商类型不会被静默改写成 `application/xml`；
- 它自己的 `.rels`，使它指向的内容仍然可以解析；
- 指向**它**的 relationship，重新登记在原本声明这些 relationship 的部件上 —— 包括 `<pageSetup>` 中的 `r:id`，缺少它时保留下来的 `printerSettings` 部件虽然存在却不会被使用。

`xl/vbaProject.bin` 是促成这整套机制的案例：工作簿 content type 是会往返保留的，因此在包部件保留机制存在之前，读取一个 `.xlsm` 再写出会得到一个仍然声称启用宏、而其中所有宏都已消失的文件。

#### 哪些内容会被明确地不写回

三类，原因各不相同：

| 类别     | 部件                                                                | 原因                                                                                                                                             |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 陈旧缓存 | `xl/calcChain.xml`、`xl/volatileDependencies.xml`、`xl/revisions/*` | 它们描述的是一个被本次写入作废的工作簿状态。Excel 会在打开时重建它们，因此省略它们不是数据丢失 —— 而是拒绝断言一件不成立的事。                   |
| 失效签名 | `_xmlsignatures/*`                                                  | 签名覆盖的是它被创建时的确切字节，而重新序列化任何已建模部件都会改变这些字节。一个诚实地未签名的文件，好过一个声称拥有它已不再具备的保证的文件。 |
| 不可达   | 输出中不会有任何内容指向的部件                                      | 应用程序无法到达的部件，与从未存在过的部件没有区别；而目标缺失的 relationship 比两者都更糟 —— 悬空引用正是 Excel 会提示"修复"的问题之一。        |

当引用某部件的工作表被删除，或该部件唯一的入边来自一个由本 writer 重新生成 `.rels`、且没有保留边回填通道的部件时，该部件即成为不可达。可达性是传递的，因此挂在被丢弃部件之下的整条链会随之一并消失。

不属于上述类别的内容都会被保留，包括本库从未见过的部件。一个未分类的部件更可能是你的数据，而不是本库有权删除的东西；而"文件略大"这个错误的代价，远低于"功能缺失"。

#### 检查发生了什么

丢弃会被记录而非静默处理，因为其中两类原因是调用方可能需要采取行动的：

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

`Workbook.getModel(workbook).opaqueParts` 列出被保留下来的部件，每一项都携带其 `path`、`data`、`contentType`，以及两个方向上的 relationship。

#### 边界

被保留的入边会在包根、`xl/workbook.xml` 以及工作表上重新发射。从 chart、drawing 或 pivot table 指向某部件的 relationship 会在读取时被记录 —— 这正是让上述判定有据可依的原因 —— 但它没有回到输出的通道，因此这类部件会被报告为 `unreachable`，而不是被写入一个没有任何内容引用它的位置。

### Oracle 与语料库测试

该仓库包含用于真实应用验证的可选测试框架。它们默认禁用，因为需要外部二进制文件或私有的固定语料库。

这些测试框架中每一个生成的工作簿在外部转换前还会运行一次 OOXML 包审计。该审计检查必需的部件内容类型、关系目标、重复的关系 ID、chart/ChartEx/drawing/chartsheet 结构、ChartEx 数据/坐标轴引用以及 ChartEx 外部数据关系 ID，从而让常见的 Excel"已修复记录"问题在 CI 中尽早失败。当已启用的 Office/LibreOffice 打开验证命令记录了修复/损坏/错误文本时，测试会将其视为硬性验证失败。

```bash
# LibreOffice 可视化/PDF 导出 oracle
DOCUMONSTER_LIBREOFFICE_VISUAL_ORACLE=1 LIBREOFFICE_BIN=/path/to/soffice \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# 对生成的工作簿进行 LibreOffice 打开/转换验证
DOCUMONSTER_LIBREOFFICE_OPEN_VALIDATION=1 LIBREOFFICE_BIN=/path/to/soffice \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# 专有 Office CLI 验证钩子。该命令必须通过
# DOCUMONSTER_OFFICE_OPEN_ARGS 接受 {input} 和 {outDir} 占位符。
DOCUMONSTER_OFFICE_OPEN_VALIDATION=1 EXCEL_OFFICE_BIN=/path/to/validator \
DOCUMONSTER_OFFICE_OPEN_ARGS="--open {input} --outdir {outDir}" \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# 企业语料库往返测试框架
DOCUMONSTER_ENTERPRISE_CORPUS_DIR=/path/to/private/xlsx-corpus \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts

# 企业语料库加上 LibreOffice 打开验证
DOCUMONSTER_ENTERPRISE_CORPUS_DIR=/path/to/private/xlsx-corpus \
DOCUMONSTER_CORPUS_LIBREOFFICE_OPEN_VALIDATION=1 LIBREOFFICE_BIN=/path/to/soffice \
  pnpm exec vitest run src/modules/excel/__tests__/chart-oracle.integration.test.ts
```

语料库目录中可选的 `manifest.json` 可以标记预期的结构：

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

Excel 和 WPS 可以通过提供 CI 作业接入同样的模式，这些作业将每个生成的工作簿转换为 PDF/图像并与已批准的工件比对。Documonster 本身保持零依赖，且不捆绑专有渲染器。内置审计是一道结构性关卡，而非真实 Office 可视化/打开修复验证的替代品。

### 能力矩阵

#### 高层能力图

| 领域             | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 经典图表         | bar、bar3D、line、line3D、pie、pie3D、doughnut、area、area3D、scatter、bubble、radar、stock、surface、surface3D、ofPie（参见 3D 说明）                                                                                                                                                                                                                                                                                                                                                           |
| ChartEx          | sunburst、treemap、waterfall、funnel、histogram、pareto、boxWhisker、regionMap（参见 regionMap 说明）                                                                                                                                                                                                                                                                                                                                                                                            |
| 高级图表特性     | 组合图、次坐标轴、标记、数据标签（`DataLabelPosition`、饼图引导线、柱/线碰撞避免）、趋势线、误差线、手动绘图区布局（边缘模式）、图表工作表、数据表（`c:dTable` —— 渲染在绘图区下方）、用户形状覆盖（`c:userShapes` 字节保留 + 程序化替换；不在 SVG/PNG/PDF 预览中渲染）                                                                                                                                                                                                                          |
| 透视图           | 经典透视图源元数据、字段按钮/筛选元数据、透视图图表工作表（仅元数据 —— 参见下方透视图说明）                                                                                                                                                                                                                                                                                                                                                                                                      |
| 预设             | 99 个经典预设 + 10 个 ChartEx 预设 —— 圆锥/圆柱/棱锥、散点变体、股价、曲面/等高线、分离饼图/圆环图、histogram/pareto/waterfall/funnel/treemap/sunburst/boxWhisker/regionMap（通过 `EXCEL_CHART_PRESETS` / `EXCEL_CHART_EX_PRESETS`）                                                                                                                                                                                                                                                             |
| ChartEx 辅助方法 | `chartExOptionsFromTable` / `chartExOptionsFromRows`（+ `Chart.addExFromTable/addExFromRows`），用于 sunburst/treemap/waterfall/funnel/histogram/pareto/boxWhisker                                                                                                                                                                                                                                                                                                                               |
| 模板保真度       | 未修改的 chart / chartEx 部件及其样式与配色 sidecar 的逐字节保留往返（不是整个包的逐字节保留）、用于狭窄编辑的原始 XML 修补、`templateMode: "strict"` 以拒绝静默丢失、`Chart.unknownElements` 浮现 `c15:` / `cx14:` 厂商标签                                                                                                                                                                                                                                                                     |
| 包部件保真度     | 未建模部件（VBA 项目、自定义属性、连接、查询表、打印机设置、厂商扩展）连同其 content type 与两个方向的 relationship 一并保留；陈旧缓存、失效签名与不可达部件被明确丢弃，并通过 `WorkbookModel.opaqueDrops` 报告                                                                                                                                                                                                                                                                                  |
| 渲染范围         | **零依赖确定性预览** —— 并非与 Excel 一致的合成器。经典图表对 SVG、PNG、PDF 使用 `ChartScene` IR；ChartEx 对 SVG 和矢量 PDF 使用专门的几何收集器。对于像素级精确的输出，请通过 `soffice --convert-to pdf` 对 `.xlsx` 进行往返转换                                                                                                                                                                                                                                                                |
| 渲染特性         | 确定性 SVG、浏览器 PNG、Node PNG 回退（遵循文本 `rotate`）、PDF 绘图桥（标签/标记/误差线/趋势线/引导线/数据表）；文本锚点+旋转+颜色+字体族（来自 `txPr/a:latin` 的 `bold`/`italic`）；radar/area/bubble 通过 `PdfColor.a` → `/ExtGState` 实现真实 alpha；bar3D 真实轴测投影（`view3D.rotX` / `rotY` / `rAngAx`）带三个着色面；文本尺寸通过 `@excel/utils/text-metrics` 计算（Calibri/Arial/Times/9 种字体 + 约 230 个类别因子）。DrawingML 效果滤镜以 SVG `<filter>` 形式输出，但在 PDF 中不复现 |
| 商业级差距       | Excel 完美渲染、line3D/pie3D/area3D/surface3D 的真实 3D、任意未知 XML 修改，以及完整的真实文件兼容性矩阵，都需要外部 oracle 测试                                                                                                                                                                                                                                                                                                                                                                 |

#### 各类型能力网格

行是图表类型。列的含义：

- **Create** —— 程序化 `addChart` / `addChartEx`（结构化 API，无需模板）
- **Read** —— 将现有的 `chartN.xml` / `chartExN.xml` 解析为结构化模型
- **Edit** —— `Chart.mutate(chart, fn, { preferRawPatch })` 对此类型有效（狭窄编辑用原始修补，其余用结构化重建）
- **Round-trip** —— 加载 → 写入 → 加载产出等价的模型 + 包审计通过
- **Raw preserve** —— 当图表未被编辑时逐字保留加载的字节（狭窄编辑则通过原始修补）
- **SVG** —— 内容断言测试（不仅仅是"不抛出"）：文本 / 路径 / 颜色 / 哈希
- **PNG** —— 内容断言测试（IHDR / IDAT 签名或值级哈希）
- **PDF** —— 超出通用 `drawChartPdf` 冒烟测试的类型特定 PDF 表面测试
- **LibreOffice** —— 选择启用的 `chart-oracle` 集成运行，通过 LibreOffice 无错误地打开导出的 xlsx

图例：✅ 直接的类型特定测试 · ⬛ 通过通用/预设扫描循环执行（无值级断言）· ➖ 未实现 / 不适用

##### 经典图表

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

##### ChartEx 类型

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

🟨 =（此表中不再使用）—— 自 regionMap 矢量移植以来，每个 ChartEx 布局都通过 `drawChartExPdf` 走矢量路径。当与 SVG 预览的像素一致性比可选中文本更重要时，调用方仍可在每次调用时通过 `Pdf.fromChart(chart, { forceRaster: true })` 选择栅格化。参见下方的"ChartEx PDF 说明"。

##### 已知但有意为之的能力差距

- **经典 PNG 内容断言**是通用的：每种类型都会经过 PNG 流水线，但只有 `bar` 有哈希黄金值，因为跨图表类型的二进制级稳定性会让测试与渲染器内部过度耦合。
- **经典 PDF 内容断言**仅在 PDF 路径与 SVG 有显著分歧之处存在（通过 `/ExtGState` 实现的 alpha、饼图引导线、标记几何）。其他类型复用相同的调用图，因此一个 SVG 断言加上通用的 `drawChartPdf` 冒烟测试被认为已足够。
- **LibreOffice 可视化 oracle**受 `DOCUMONSTER_LIBREOFFICE_VISUAL_ORACLE` 控制，且 CI 默认不安装 LibreOffice 以保持矩阵作业的快速；为 `bar`（单独）和 combo/chartsheet/ChartEx-treemap/funnel 固定数据提供了直接的逐类型打开验证，完整目录可通过 `DOCUMONSTER_ENTERPRISE_CORPUS_DIR` 选择启用（参见 `src/modules/excel/__tests__/helpers/enterprise-corpus.ts`）。
- **ChartEx PDF 矢量路径**（`drawChartExPdf`）覆盖了构建器目前发出的每一种 ChartEx 布局；参见专门的说明。

**3D 说明：** `bar3D` 渲染为一个**真实的拉伸盒体**，其轴测投影由 `view3D.rotX` / `view3D.rotY` / `view3D.rAngAx` 驱动——每根柱形有三个着色面（顶 + 前 + 右），深度按柱宽缩放，使 3D 效果在各种图表尺寸下保持可读。默认回退（`rotX=15°, rotY=20°, rAngAx=true`）匹配 Excel 的新建图表默认值。`line3D`、`pie3D`、`area3D`、`surface3D` 以及更丰富的 `view3D` / `Scene3D` / `ShapeProperties3D` 元数据**在 XML 中保留**，因此干净的往返和 Excel 重新打开都能完好无损地存活，但预览仍将这些类型渲染为其 2D 等价形式——对于非柱形的 3D，没有投影矩阵、没有光照装置、没有深度排序。这是一个预览级渲染器，不是 3D 引擎；需要商业级 3D 输出的用户应使用 Excel 或 LibreOffice。

**字体与 CJK：** 每当页面包含非 WinAnsi 字符且未显式嵌入字体时，`Pdf.Builder` 会自动发现系统字体（与 `Pdf.fromExcel` 相同的机制）。传入 `disableFontAutoDiscovery()` 可在各宿主间获得字节稳定的输出，或传入 `embedFont(ttfBytes)` 以使用确定性的字型。注册 `onWarning(handler)` 可在以下情况各收到一条诊断：每个不同的未知 `fontFamily`（例如回退到 Helvetica 度量的非标准名称），以及每次构建中当非 WinAnsi 字符落在没有覆盖字体的页面上时（渲染 Type3 NOTDEF 方框）。

**最小化 PDF 表面：** `ChartPdfDrawingSurface.drawPath?` 和 `drawCircle?` 是可选的。当某个表面缺少 `drawPath` 时，pie/doughnut/ofPie 切片轮廓降级为 `drawLine` 折线描边（形状保留，填充丢失）；area 和 radar 填充被丢弃，但周围的描边仍会发出；标记回退到 circle→rect→line 链。`PdfPageBuilder` / `PdfEditorPage` 都提供完整接口，因此这只对自定义表面才有影响。

**regionMap 说明：** ChartEx 的 `regionMap` 预览附带一张约 180 条目的国家质心表和四个真实投影公式（`mercator`、`miller`、`albers` 等积圆锥投影、`robinson`）。默认情况下这是质心点地理预览；未匹配的标签回退到确定性的六边形瓦片布局。对于真实的国家多边形，请通过渲染选项 `regionMap: { topology, objectName, match, projection }` 传入 TopoJSON 拓扑——渲染器将解码要素、将标签匹配到 `feature.id` 或 `feature.properties.<key>`，并绘制 choropleth 路径。这使得本库保持零数据捆绑：调用方加载他们自己的 `world-atlas`/`natural-earth` 文件。相同的三模式流水线（TopoJSON → 质心预览 → 六边形瓦片回退）对 **SVG 和矢量 PDF 都**实现了——`Pdf.fromChart` 会将相同的 `regionMap` 选项透传给 `drawChartExPdf`。参见 `src/modules/excel/chart/topojson.ts` 以及导出的 `RegionMapDataOptions` / `TopologyLike` 类型。

**内置图表样式：** `Chart.setStyle(chart, 1..48)`（别名 `Chart.setBuiltInStyle(chart, 1..48)`）在经典图表上写入 `<c:style val="N"/>`，从内置样式索引中选择一个。这是映射到 2007/2010 样式目录的轻量级旋钮。对于带完整 `styleN.xml` / `colorsN.xml` 附属文件的现代 Office-2013 时代样式，请使用 `Chart.add(ws, { …, chartStyle: ChartStyleModel })`。

**3D 渲染边界（非目标）：** 除了用于 `bar3D` 的轴测盒体外，我们有意**不**渲染：

- `line3D`、`pie3D`、`area3D`、`surface3D` 的真实 3D 投影（rotX/rotY/透视 → 矩阵 + 深度排序 + 光照装置）
- 作为三角网格/线框/带状等高线的 surface3D

这些特性需要数周的投入，而对于预览级渲染器回报很低；需要与 Excel 一致的 3D 输出的用户应通过 Excel 或 LibreOffice 往返。完成这一点所需的所有元数据（`Scene3D`、`View3D`、`ShapeProperties3D`）都已通过 XML 往返。

**ChartEx PDF 说明：** 经典图表通过 `drawChartPdf` 渲染为矢量 PDF 内容（文本保持可选中，形状保持与分辨率无关）。ChartEx 图表现在全部通过 `drawChartExPdf` 渲染为矢量 PDF 内容：

- **矢量路径（默认）** —— `sunburst`、`treemap`、`waterfall`、`funnel`、`histogram`、`pareto`、`boxWhisker`、`regionMap` 全都经过 `drawChartExPdf`，它与 SVG 渲染器共享几何收集器，因此两个后端在栅格化之外保持像素等价。Sunburst 弧线以三次贝塞尔近似发出（最大误差 ≤ 0.03 %）；其余都是 PDF 原生理解的直接 `drawRect` / `drawLine` / `drawPath` 基元。`regionMap` 复用与 SVG 渲染器相同的 TopoJSON 解码器 + 投影数学 + 质心表；唯一有意的视觉分歧是圆角框（`rx="14"`）在 PDF 中变为尖角框（`drawRect` 不暴露圆角半径）。
- **栅格选择启用** —— 当与 SVG 预览的像素一致性比可选中文本或矢量可缩放性更重要时，任何 ChartEx 类型都可按需通过 `Pdf.fromChart(chart, { forceRaster: true })` 栅格化。

使用来自 `documonster/pdf` 的 `Pdf.fromChart(chart, options)` —— 它会自动选择路径，在你有意需要栅格路径时遵循 `forceRaster: true`，并暴露 `canRenderChartExAsVectorPdf(model)`，以便你想从辅助方法外部检查该决策。

**透视图说明：** Documonster 支持**仅元数据**的透视图 —— `pivotSource`、字段按钮、拖放区选项、`refreshOnOpen` 和 `c16:showExpandCollapseFieldButtons` 扩展全都通过 XML 往返，`addPivotChart` / `addPivotChartsheet` 创建 Excel 重建图表所需的引用。**不存在**运行时透视图引擎：预览渲染器将透视图视为普通图表，不绘制字段按钮、拖放区提示，也不对数据应用透视筛选。一旦文件在 Excel / LibreOffice / WPS 中打开，宿主应用程序便会从透视表驱动真实渲染。对于透视缓存数据的程序化操作，请直接使用 `pivotTable` 模块；图表这一侧有意保持轻量。

**严格模板模式：** 写入器接受 `{ templateMode: "strict" }`（或 `{ strictTemplateMode: true }`），以拒绝任何会强制结构性重建的 chart/ChartEx 编辑。当重建不可避免时，错误消息现在会列出解析器观察到的任何非结构化 XML 元素（可作为 `ChartExModel.unknownElements` 获取），这样厂商扩展就永远不会从加载的模板中静默消失。

**测试范围边界（本库*不*测试的内容）：**

- **没有像素级视觉差异。** 预览输出通过 SVG 结构断言和 PNG 头/签名哈希进行测试——真正的 RMS/SSIM 像素差异需要捆绑一个 PNG 解码器和一个差异算法，而且预览本来就明确不是像素级精确的（参见上方的渲染说明）。如果你的工作流需要与 Excel 的像素对等，请通过 LibreOffice 的无头 PDF 导出运行 `Pdf.fromChart(chart)` 并在那里比较。
- **没有树内的 Office 生成的固定数据。** 该仓库中每一个真实文件固定数据（`src/modules/excel/__tests__/data/`）要么由 Documonster 自身生成，要么为回归测试而最小化手工编写。对于宿主应用程序兼容性覆盖，请使用选择启用的 `DOCUMONSTER_ENTERPRISE_CORPUS_DIR` 机制：将其指向一个由三家厂商生成的文件目录，`chart-oracle.integration.test.ts` 将审计其中每一个。manifest 形态参见 `docs/enterprise-corpus-manifest.example.json`。
- **没有自动化的 Excel / WPS 运行时。** CI 仅在 LibreOffice 上对打开验证设关卡。任何 CI 运行器中都不附带 Excel 和 WPS 二进制文件，对这些应用的 GUI 驱动验证超出范围。`DOCUMONSTER_OFFICE_OPEN_VALIDATION` + `DOCUMONSTER_OFFICE_OPEN_ARGS` 钩子让安装了 Office 的自托管运行器能参与相同的检查模式。

企业语料库验证 manifest 示例：[`docs/enterprise-corpus-manifest.example.json`](../../../docs/enterprise-corpus-manifest.example.json)。

## PDF 导出

零外部依赖地将任意工作簿导出为 PDF：

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

// 浏览器
const blob = new Blob([pdf], { type: "application/pdf" });
window.open(URL.createObjectURL(blob));
```

### XLSX 转 PDF 转换

```typescript
const workbook = Workbook.create();
await Workbook.readFile(workbook, "input.xlsx");
const pdf = await Pdf.fromExcel(workbook);
```

### PDF 加密

```typescript
const pdf = await Pdf.fromExcel(workbook, {
  encryption: {
    ownerPassword: "admin",
    userPassword: "reader",
    permissions: { print: true, copy: false }
  }
});
```

### Unicode / CJK 字体嵌入

```typescript
import { readFileSync } from "fs";
const pdf = await Pdf.fromExcel(workbook, {
  font: readFileSync("NotoSansSC-Regular.ttf")
});
```

## CSV 导入/导出

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

// Node.js：读取/写入 CSV 文件
await readCsvFile(workbook, "data.csv");
await writeCsvFile(workbook, "output.csv");

// 从流读取 CSV
await readCsv(workbook, fs.createReadStream("data.csv"), { sheetName: "Imported" });

// 将 CSV 写入流
await writeCsv(workbook, fs.createWriteStream("output.csv"));

// 将 CSV 写入字符串 / 字节
const csvText = writeCsv(workbook);
const bytes = await writeCsvBuffer(workbook);

// 浏览器：从字符串/ArrayBuffer/File 读取
await readCsv(workbook, csvString);
await readCsv(workbook, arrayBuffer);
```

## Markdown 导入/导出

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

// 读取 Markdown 表格
readMarkdown(workbook, "| Name | Age |\n| --- | --- |\n| Alice | 30 |");
await readMarkdownFile(workbook, "table.md");

// 写入 Markdown
const mdText = writeMarkdown(workbook);
await writeMarkdownFile(workbook, "output.md");
const bytes = writeMarkdownBuffer(workbook);
```

## Excel 二进制工作簿（`.xlsb`）

`.xlsb` 是规范工作簿函数上的一个格式选择，而不是第二套 API：

```typescript
import { Workbook } from "documonster/excel";

// 扩展名选择格式。
await Workbook.writeFile(workbook, "report.xlsb");

// 读取时从包内容自动检测。
const reopened = Workbook.create();
await Workbook.readFile(reopened, "report.xlsb");

// 字节与流需要显式指定，因为它们没有文件名可读。
const bytes = await Workbook.toBuffer(workbook, { format: "xlsb" });
for await (const chunk of Workbook.toStream(workbook, { format: "xlsb" })) {
  // 消费
}
```

覆盖面是部分的，边界写在下面而不是留给你去发现。目前存在的是这个格式在 reader 可被信任之前
所需的框架，以及针对已确立编码的那部分记录集的 reader 与 writer。

顺序是刻意安排的。BIFF12 记录流是不透明的，而 Excel 对畸形记录流的诊断是"我们发现"某个文件"中的
部分内容有问题"——不给部件、不给偏移、不给原因。因此最先构建的是让其余一切变得可调试的两样东西：

- **验证器**（`utils/xlsb-validator/`），回答"Excel 会拒绝这个文件吗"——包结构、记录分帧、
  `Begin`/`End` 平衡、记录顺序、单元格坐标，以及对共享字符串表和单元格格式表的索引。
- **反汇编器**（`src/test/biff-dump.ts`），把一个部件渲染成带缩进、可 diff 的文本。

两者都派生自同一张记录表（`xlsb/spec/records.ts`），它是数据而不是代码：标识符、名称、scope 角色、
载荷布局。没有任何地方保留私有副本，并且 `spec.test.ts` 会单独检查这张表。

### 目前能够往返的内容

字符串（经共享字符串表）、数字、布尔值、日期与空白单元格，支持多个工作表。数字在可精确表示时使用
紧凑的 `RkNumber` 编码，否则使用完整的 double——绝不使用四舍五入的近似值。

**公式**，包含公式文本与缓存结果。BIFF12 把表达式存成逆波兰 token 流而非文本，因此本模块只负责
token 映射，文本一侧由 `documonster/formula` 负责：`Formula.tokenize` + `Formula.parse` 一个方向，
`Formula.print` 另一个方向。共享它不是图方便——优先级与括号只在一处决定，而第二份实现出错时不会
响亮失败。`=-2^2` 在 Excel 里是 `4`，在几乎所有其他地方是 `-4`。

绝对/相对引用、跨表引用、定义名、引用并集与交集都能保留。

**工作簿的日期 epoch。** 以 1904 系统保存的工作簿会作为 1904 系统往返，其日期读回时是它们本来的
时刻，而不是早四年。

**对齐与单元格保护** —— 水平、垂直、自动换行、缩小填充、缩进、阅读顺序、文本旋转、锁定与隐藏。
承载这些的六个字节此前被写成常量 `0x1010`,注释说这些字段"留作默认值"—— 这话是对的,却掩盖了默认值
并非零:`alcV = 0` 是**顶端对齐**,把该字节清零会把每个单元格的文本移到行顶。

**页面设置** —— 页边距、纸张、缩放、方向、分辨率、缩放到页面、起始页码 —— 以及工作表的
**默认行高与列宽**。

**工作表标签色与 VBA 代码名。** 代码名之所以重要,是因为 VBA 工程现在会被保留:宏通过代码名寻址工作
表,保住 `vbaProject.bin` 却丢掉代码名,会产出一个"代码再也找不到自己工作表"的工作簿。

**行级与列级格式。** `BrtRowHdr` 和 `BrtColInfo` 一直携带格式索引,而本 writer 一直往里写零 ——
因为它读取的那个字段声明了却从未被填充,于是 `Row.setStyle` 和 `Column.setStyle` 根本没有通往文件
的路径。

**跨表引用与定义名,作为表达式。** `PtgRef3d` 携带的是 `BrtExternSheet` 的索引、`PtgName` 携带的是
`BrtName` 记录的索引,而两张表都没被写出 —— 所以每一个这样的引用都指向虚无。往返测试看不见它,因为
读回的是**缓存结果**而不是公式 —— 这正是本节其余部分要防的那种失效模式,而它就出在本库自己的输出里。

**本 reader 不解释的每一个部件** —— 主题、图片、绘图、图表、打印机设置、VBA 工程。丢掉主题不是外观
问题:`{ theme: 1 }` 这类颜色要靠它解析。

**字体** —— 名称、字号、粗体、斜体、下划线、删除线、颜色、family、charset 与主题 scheme —— 以及
**图案填充**，含带真实颜色的实心填充。`BrtFont` 没有可选字段，因此只要求加粗的单元格会读回
"Calibri 11 加粗"；Excel 对这样的单元格也是如此处理。

**边框，这一段此前写的是"刻意缺席"。** 当时如此，现在不再。全部九个由 Excel 生成的参考工作簿都只含
**一条** `BrtBorder`，且在每个文件中字节完全相同 —— 51 个零字节，即默认的"无边框"项 —— 所以语料确立的
是这条记录的*长度*，而非其中任何一个字段。改变的是字段的来源：`1 + 5 × 10 = 51` 正是规范里的一个
`flags` 字节加五个十字节 `Blxf` 结构，因此实测长度是对规范布局的**印证**，而不再是唯一证据。按规范读出
字段、再用唯一样本核对算术，与"完全没有证据"是不同的处境；边框现在可以往返 —— 见 `xlsb/border.ts`，
那里还记录了为什么边的顺序是上、下、左、右而不是 CSS 的顺序。

**工作表可见性**、**合并单元格**、**列宽**与**行高**。每一处布局都从 Excel 自己的输出确立，
其中两处由不可能是巧合的数值印证：一个工作簿的三张表分别叫 `Visible`、`Hidden`、`VeryHidden`，
携带的正是 0、1、2；而默认列携带 2742——在这个格式使用的 1/256 字符单位下就是 10.71 字符，
即默认 Calibri 11 的列宽。

从未设置过尺寸的列或行不会凭空获得一个尺寸；自定义尺寸会被打上标记，使 Excel 保留它而不是
根据字体重新计算。

**数字格式**，以及随之而来的日期。BIFF12 把日期存成序列号，只通过格式说明它是日期，因此 `iFmt`
就是 `2016-10-07` 与 `42650` 的区别——这是用户会立刻察觉的那一类保真损失。格式字符串以及"这是不是
日期格式"的判定都复用 XLSX 路径所用的那一套，因此同一个工作簿不会因为容器不同而读出不同结果。
格式会被去重，因此五十个共享同一格式的单元格只产生一条记录。

**超链接。** `BrtHLink` 携带一个区域和一个关系 id；目标是工作表自己 `.rels` 里 `TargetMode="External"`
的一条，两半缺一不可。布局出自 MS-XLSB 2.4.693，并由语料中两个带超链接的文件印证。唯一有损的情形是
**无标签的链接** —— 单元格模型只在文本非空时才把值判定为超链接，所以读回时会把目标当作标签，并上报。

**图片** —— `xl/media/` 里的字节、`xl/drawings/drawingN.xml` 里的位置、工作表自己的 `.rels`。这些
全都是 XLSX 携带的同一份 XML，由同一套代码产出；只有引用是二进制的：一条十二字节的 `BrtDrawing`，
里面装着一个关系 id。`ImageData` 接受的三种形式 —— `buffer`、`base64`、`filename` —— 都会内嵌；
外部 `link` 则写成链接图片，包内不存字节。

### 同一个模型，两个写入器

这个容器最常产出的缺陷不是读错某个字段，而是**两个写入器各自独立地决定同一件事、结论不同**，
而其中只有一个是 Excel 接受的答案。这种缺陷从任一写入器内部都看不见，XLSB 经本库自己的读取器
往返还会愉快地确认那个错答案。目前找到六处：

| 事实                      | XLSX 说                        | XLSB 说                          |
| ------------------------- | ------------------------------ | -------------------------------- |
| 是否存在主题部件          | 写 `theme1.xml`                | 不写 —— 252 处悬空引用           |
| 默认字体的颜色            | `<color theme="1"/>`           | 自动色 + 调色板索引 64           |
| `containsText` 规则的公式 | `NOT(ISERROR(SEARCH("…",A2)))` | 不写公式 —— 规则匹配不到任何东西 |
| 数据字段在轴上的位置      | `colFields` 带 `x="-2"`        | 完全省略列轴                     |
| 透视表体从哪一行开始      | 锚点 + 每个筛选一行 + 一个空行 | 锚点行本身                       |
| 是否请求打开时重算        | 真实的 `calcId`，且不请求      | `recalcID = 0`，强制重算         |

`__tests__/writer-agreement.test.ts` 比较的是**两个容器**而不是各自与常量，因为常量可能跟着两边
一起漂。两个容器确实用不同词汇表达同一事实时（XML 里的主题索引 vs 二进制里的 `BrtColor` 种类），
测试会做翻译并写明。

`containsText` 那条最尖锐，因为公式不是装饰：有若干规则类型是**以公式定义**的，即使调用方是用别的
字段表达意图，文件里也必须带上那条公式。`core/conditional-formula.ts` 现在收纳了这些派生规则
（八个文本运算符、十个时间段），两个写入器共用。修它又暴露出二进制路径上另外两个错误：引用写成了
`PtgRef` 位置，而规则需要相对其范围左上角的 `PtgRefN` **偏移**（于是 `A2:A4` 上的规则三次都在测
`A2`）；以及操作数类别写成了引用类，而这里要的是值类。

### 没有任何东西被静默丢掉

需要 writer 无法表达的内容的单元格会被写成空白，并**按地址报告**，因此它的位置得以保留。本容器没有
对应记录的工作表特性**按工作表**报告；无法保住含义的定义名**按名字**报告。默认情况下其中任何一项都
会让写入被直接拒绝：

```typescript
await Workbook.toBuffer(workbook, { format: "xlsb" });
// ExcelNotSupportedError: 3 item(s) carry content this writer cannot express:
//   Sheet1!A1: formula, Sheet1: table, Sheet1: border (12).
//   Pass { unsupported: "ignore" } to write the workbook without them.
```

抛出的错误在 `items` 上携带完整清单，因此想报告"这些需要处理"的转换器不必去解析那句话。

读取有同一个选项，且**默认值相反**；此外还有第三种形式，用于两者都覆盖不到的情况 —— 既要读进来，
又要检查丢了什么：

```typescript
await Workbook.read(workbook, bytes); // 读进来，安静地丢掉无法解码的部分
await Workbook.read(workbook, bytes, { unsupported: "error" }); // 或者拒绝，并说明丢了什么

const report = await Workbook.readWithDiagnostics(workbook, bytes);
report.lost; // ["Sheet1: 1 cell(s) in BrtShortReal", …]
report.unknownRecords; // 本库没有名字的记录 id —— 不算损失，见下
```

`unknownRecords` 刻意**不属于** `lost`。本库没有名字的记录通常是新版 schema 的扩展而非缺内容 ——
参考语料里每个工作簿都有 —— 所以把它算成损失会让 `unsupported: "error"` 拒绝普通文件，从而教会
调用方永久关掉这个开关。它单独上报，供需要的人使用。

这种不对称是刻意的。被**写出**的工作簿在内存里且是完整的，所以损失是本库的局限，停下来不会让调用方
失去任何本来拥有的东西。被**读取**的工作簿是别人写的、损失早已发生；一个因为文件里有七个单元格用了
尚未确立布局的记录就拒绝读取真实文件的 reader，没人能用。`"error"` 是给那种"宁可停下也不要转换出不
完整结果"的调用方的。

**读取会替换工作簿，并且是原子的。** 对已经有工作表的工作簿调用 `Workbook.read` 会丢弃原有内容 ——
与 XLSX reader 完全一致；而如果包在读到一半时被发现是坏的，目标会保持原样，而不是留下半个文件。
**拒绝也同样如此**：`{ unsupported: "error" }` 会在任何内容被应用之前评估损失，因此被拒绝的读取
不会先替换工作簿再报告失败。

### 一处字段描述，代价是三个特性

`BrtRowHdr` 有**三个**标志字节。本模块的记录表把前两个声明成了一个 `u16`：

```
offset 10   fExtraAsc, fExtraDsc, reserved1(6)
offset 11   iOutLevel(3), fCollapsed, fDyZero, fUnsynced, fGhostDirty, fReserved
offset 12   fPhShow, reserved2(7)
```

writer 唯一设置的标志是 `fUnsynced` —— "这个行高是行自己的，而非从字体推导"，
它正是让自定义行高生效的东西。以 `0x0002` 写进 offset 10 的 `u16`，小端把它放进了
**offset 10 的 bit 1：`fExtraDsc`**，"给这一行底部加内边距"。reader 读同一个错位，
所以自定义行高在这个库内往返自洽，而 Excel 看到的是一个没有手动行高、
却多了没人要的内边距的行。记录的**长度**自始至终是对的 —— `u16` 加一个字节是三字节，
一个字节写三次也是三字节 —— 而这恰恰是它没被抓到的原因：帧校验器拿记录长度和 Excel 的比对，
而这条记录一直都是它该有的 25 字节。错的只有字节**内部**的位位置。

**后果远不止行高。** `iOutLevel`、`fCollapsed`、`fDyZero` 共用 offset 11 那个字节，
所以隐藏行、分组行、折叠行都被报告为"XLSX 能承载而 XLSB 不能"。
它们从来没有从记录里缺失过；**三个特性被宣布为不支持，只是为了描述一处字段表里的错误。**
把字节拆开后三者都能work了，损失清单少了三条，而**没有增加任何一条记录**。

`INFERRED_VALUES.rowHeightUnsynced` 随之从推断寄存器里移出。它的注释对不确定性一直是诚实的 ——
"这个标志的位置由两侧字段约束，但它的用途不是" —— 而答案一直就在 2.4.770 里。

`xlsb/__tests__/row-header.test.ts` 对照**规范**断言每个偏移，而不是断言编码器的产物，
因为它替换掉的那些测试正是后者，并在错误布局上一直是绿的。把旧字节还原回去会让其中四条失败。

### 长度表里的一条，是对所有生产者的断言

`OBSERVED_PAYLOAD_SIZES` 存放着六十个从 Excel 自身输出读到的长度，
而验证器在记录长度不符时报的是 **error**。正是这个严重级别让这张表的内容变得后果重大：
一条记录**不是**关于语料的备注，而是一个断言——**任何生产者都不会以别的长度写出这条记录**。

其中有一条不是这样的。`BrtDrawing` 的 payload 是一个 `XLWideString`，装着工作表 drawing 部件的关系 id，
所以它的长度**跟着 id 走**——`"rId2"` 编码为 12 字节，`"rId10"` 则是 14。
表里写的是 12，读自一个工作表恰好都是个位数 id 的工作簿。

**结果是验证器拒绝了一个本库刚刚写出的文件。** 工作表上九条被保留的关系会把 drawing 推到 `rId10`，
于是检查报出 `BrtDrawing is 14 byte(s); every Excel-authored one is 12`。而这个文件没有任何问题。

移除该条即可修复，并且 `check-records.ts` 现在**根本不允许**含**已声明**变长字段的记录进入这张表 ——
那个结构性事实本来就写在字段列表里，只是从没有人去查。

那个检查抓到了一条。把其余条目对照 `[MS-XLSB]` 读一遍，又抓到两条 —— 而它们对该检查不可见，
原因是一样的：**它们没有字段列表可供检视**。`BrtACBegin` 是 `cver` 后跟那么多个 `ACProductVersion` 结构 ——
命名一个应用时是六字节，两个就是十二字节。`BrtSel` 以 `sqrfx` 结尾，那是一个十六字节范围的计数数组，
所以 36 字节是**单选区**选择的长度，Ctrl+点选第二个区域就变成 52。

两者都从未被触发过，因为没有语料工作簿命名两个应用或选中两个区域。
这就是整个类别的形状：**一个长度在九个文件里恒定，其原因与格式本身毫无关系**，
而只有读懂这条记录**是什么**才能区分两者。检查现在覆盖了结构性的那一半；
其余部分靠手工审计，并把推理钉进了测试 —— 于是未来新增的条目必须与它争辩，而不能只是看起来合理。

### 清空推断寄存器

`INFERRED_VALUES` 是本模块记录"靠推理而非靠阅读得到的值"的地方 ——
一个由两侧字段推出位置的比特、一个从邻近格式借来的常量。把它们集中在一处，让猜测的规模保持可见。
它曾有 **17** 条，现在剩 **5** 条，而被移出的 12 条**没有一条是错的**。
它们只是从未与已发布的表核对过：

| 条目                        | 结果发现它写在哪                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 六个 `BrtFont` 标志位       | `FontFlags`，2.5.53 —— 而这六位**并不连续**，按属性顺序数出来的表会从 `fStrikeout` 起全部错位                                                          |
| `fWrap`、`fShrinkToFit`     | `BrtXF`，2.4.876 —— 且二者在**不同字节**里，这正是陷阱：把它们当成一个 16 位字段读，会把 `fShrinkToFit` 放到 `fMergeCell` 的位置上，单元格会变成已合并 |
| `fFrozen`、`fFrozenNoSplit` | `BrtPane`，2.4.755 —— 它们自己的注释早已引用了那条使二者互斥的 MUST                                                                                    |
| 定义名的 `fHidden`          | `BrtName`，2.4.712 —— 而且 `binary.ts` 里已有这个常量，所以它既是推断也是重复                                                                          |
| `fUnsynced`                 | `BrtRowHdr`，2.4.770 —— 唯一一条**真的错了**的，见[上文](#一处字段描述代价是三个特性)                                                                  |

每一条都带着引用移到了使用它的代码旁边，而不是继续留在一个写着"我们推出来的"的寄存器里。
剩下的五条是真推断：一个在任何语料工作簿和任何已发布枚举里都不出现的粗体字重、一个色调比例、
一个跨表跨度，以及两个偏移。

寄存器因此更小、也更诚实 —— **一个没人复核的推断，最终会被当成事实来读。**

### 枚举，以及一个读规范而非读代码的测试

那些把名字映射到数字的表 —— 填充图案、边框样式、两种对齐、阅读顺序 —— 用同样的方式审计过，结果是正确的。
错的是其中三张的**注释**：`HorizAlign`、`VertAlign` 和 `ReadingOrder` 都把自己的取值描述为
"从 Excel 输出读出、由相邻值推断"，而这三张表都是已发布的。
**靠推断得到的值和靠引用得到的值，值得用不同的标签**，而这里只是标签过期了。

`xlsb/__tests__/enumerations.test.ts` 现在钉住了它们，而它的**做法**才是要点：
期望值是**手工从规范转录**的，不是从模块导入的。此处其他每个测试都读模块自己的表、
再检查编码器与之一致 —— 这证明的是本模块两半自洽，**对它们是否与 Excel 一致什么也没说**。
一张转录的表是对着**文档**失败，而不是对着自己。把 `FillPattern` 的某一项挪动一个位置，它就会变红。

条目**数量**和取值一起被断言，理由相同：一张表新增一项会让其后所有项移位，
而一个从该表生成的测试会跟着一起移位。

### 一次几乎什么都没查到的审计

两条记录因为标志字处理不当丢掉了特性，于是其余八条被逐位对照规范读了一遍。
这件事值得记录，恰恰因为它几乎一无所获：**没有这条记录，下一个人还得重做一遍才能知道这一点。**

| 记录                      | 结论                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `BrtWbProp`               | `f1904` 是 bit 0 —— 正确                                                                       |
| `BrtPane`                 | 用的是 `fFrozenNoSplit` 而非 `fFrozen`；规范规定两者互斥，而后者才是人们所说的"冻结窗格"       |
| `BrtDVal`                 | 十个打包字段全部落在 2.4.353 规定的位置，包括夹在两个单比特之间、占据 bit 10–17 的 `mdImeMode` |
| `BrtName`                 | 三个位常量，各自分离                                                                           |
| `BrtSSTItem`              | 它的 flags 属于嵌套的 `RichStr`，不是它自己的标志字                                            |
| `BrtColInfo`、`BrtRowHdr` | 已修 —— 见上文                                                                                 |

若只读一条，值得读 `BrtPane`：冻结时 `xnumXSplit` 数的是**行**、`xnumYSplit` 数的是**列**，
与 XLSX 的 `xSplit`/`ySplit` 含义相反。本模块因此把自己的字段命名为 `rows` 和 `columns`，
而不把任何一方的约定传递下去。

这次审计确实找到了一样东西，但它不是位位置。**`WORKBOOK_FLAG_1904` 被定义了两次** ——
在 `binary.ts` 和 `defaults.ts` 里 —— 两者可以就"这是哪一位"产生分歧而无人察觉。
reader 导入的恰恰是那份没有其他调用者的副本。删掉它时在 import 处产生了编译错误，
而这是这处重复唯一得以显形的原因。

### 比对同一批字节的两份描述的闸门

本模块里有两张表描述每条记录的布局：**字段列表**，以及 `OBSERVED_PAYLOAD_SIZES` ——
后者存放从真实 Excel 输出里读到的长度。它们从不互相比对，
所以一份字段列表可以和它所描述的记录漂移开，而只有建立在它之上的工具会出错 ——
那正是此处其他每一项检查所依赖的工具。

这个比对**刻意是单向的**。声明得比记录**多**永远是错的：解码器会读过 payload 边界。
声明得**少**则是本模块经常采取的立场 —— 一个字段在被理解之后才被命名，
而 `BrtBorder` 的 51 个字节一个都没命名。所以短布局只对列在 `PARTIAL_LAYOUTS` 里的记录放行，
每条都带着自己的理由，于是这个检查抓的是**丢掉了尾部**的记录，而不是从未描述过尾部的记录。

它第一次运行就找到两处：`BrtWsFmtInfo` 在 `iOutLevelRw` 和 `iOutLevelCol` 之前少了两字节，
以及 `BrtBeginColInfos` 声明了一个四字节计数、而 Excel 写的是空 payload ——
后者的正确事实早已写在同一个文件的另外两处。

**任何长度检查都抓不到什么**，值得和它一起说清楚，因为人很容易假定这道闸门涵盖了上面那个行头缺陷。
它没有，`check-framing.ts` 也没有 —— 后者拿每条**写出的**记录和 Excel 自己的长度比对。
`BrtRowHdr` 自始至终长度都是对的：`u16` 加一个字节是三字节，一个字节写三次也是三字节。
错的只有字节内部的位。**一个长度正确而布局错误的记录，只能对照规范才看得见** ——
这正是 `__tests__/row-header.test.ts` 断言偏移而非大小的原因。

### 同一个缺陷的另一种形状

`BrtColInfo` 代价是四个特性 —— 隐藏列、分组列、折叠列、最适列宽 —— 而它的字段表是**正确的**。
那个标志字确实是一个 `u16`，布局里给四者都留了位置：

```text
bit 0     fHidden          bits 4-7   reserved1
bit 1     fUserSet         bits 8-10  iOutLevel
bit 2     fBestFit         bit 11     unused
bit 3     fPhonetic        bit 12     fCollapsed
```

而 writer 设了一位就停了：

```text
.writeUint16(0x02)   // 只有 fUserSet
```

所以 `BrtRowHdr` 因**错误的描述**丢了三个特性，`BrtColInfo` 因**正确但无人填写的描述**丢了四个。
两者合起来，**七条记录离开损失清单，而没有增加任何一条记录。** 两个缺口都不在格式里。

修复中有两个细节值得留存：

- **`fUserSet` 不能靠"宽度是否存在"来判断。** `setModel` 会把默认宽度填进它规范化的每一列，
  所以到 writer 运行时，作者设定的宽度和默认宽度都只是数字。模型把这个区别记作 `isCustomWidth`，
  而不看它就置 `fUserSet`，会把一个仅仅被隐藏的列永久钉死在默认宽度上。
- **只有标志、没有宽度的列此前会被整条跳过**，所以一个没有自己宽度的隐藏列根本不产生 `BrtColInfo` ——
  标志无处安放，这正是该特性看起来不受支持的很大一部分原因。

有一件看起来像第三个 bug、其实不是：**`collapsed` 是推导的，不是存储的。**
`columnCollapsed` 返回 `outlineLevel >= worksheet.properties.outlineLevelCol`，而该属性默认为 0 ——
于是除非工作表声明了大纲深度，**每个分组列都报告自己已折叠**。这是模型自身长期以来的语义、
有专门的测试钉着，writer 是在忠实反映它。列的测试通过抬高阈值来隔离断言大纲级别，
而不是去"修正"一个本模块并不拥有的模型。

### 读写对称性，以及那个没有名字的洞

下面的清单报告的是一次**写入**丢掉了什么。**读取**这一侧没有对应的东西，而这个不对称藏着一个比清单上任何条目都糟的失效。

一个 writer 会发出、reader 却不建模的特性，**第一次写入是正确的**，读回来时**从模型里消失**，
然后被**第二次写入删除** —— 而损失报告什么都不说，因为从 writer 的角度看，
它拿到的模型里确实没有这个特性。第一次检查时的实测：

```
条件格式  第一次写出:  4 条记录
          读回再写出:  0 条记录
          损失报告:    无
```

一次读-改-写删掉了工作簿的一部分，并报告成功。自动筛选条件同样如此。两者现在都有 reader，
而 `xlsb/__tests__/read-write-symmetry.test.ts` 是那道闸门：它把每个特性列为"往返存活"或"读回即丢失"，
两张清单合起来若不能恰好覆盖全部特性就失败，并且**对第二类断言其缺陷** ——
所以某项获得 reader 后测试会**变红**，那正是把它移列的信号。`LOSES_ON_READ` 今天是空的，形状本身被保留下来。

这道闸门找出的三件事，没有一件是"数记录数"能发现的：

- **规则回来了，格式没回来。** `dxfId` 是指向 `styles.bin` 的索引，而那个表没人解析，
  于是下一次写入拿到一条没有 `style` 的规则、写出"无格式"。规则会触发却什么都不显示 ——
  这比规则消失更难察觉，因为 Excel 的条件格式对话框里它还在。`readDxf` 反演那九种 `XFProp` facet，
  且索引在解析后被**丢弃**：模型持 `style`，而一个指向下次写入会重建的表的索引是没人读的字段。
- **未终结的集合会吞掉这张表的其余部分。** 筛选条件 reader 最初收集
  `BrtBeginAFilter` 到 `BrtEndAFilter` 之间的**全部**记录；一个缺失 End 的文件 ——
  本 writer 不会产生，但 reader 必须承受 —— 会丢掉其后的条件格式、数据验证和页面设置。
  单元格逃过一劫**纯属运气**，因为它们在部件里排得**更早**。现在它只收集自己认识的那十三种记录，
  所以未终结的集合只损失筛选条件本身。
- **反向枚举表由正向表推导**，不重新列一遍。一个自带 `CFOper` 副本的 reader 就是
  "1 表示 between"可以出错的第二个地方，而**任何拿 reader 与 writer 对比的测试都发现不了** ——
  两边会以同样的方式错。`fAnd` 同理，它在记录里是反的：照写的样子读会把每个 AND 变成 OR。

有一处窄化是真实存在的，如实命名而非隐藏：条件格式规则回来时**没有 `formulae`**。
把 `Rgce` token 流解码成公式文本需要 `encodeParsedFormula` 的逆函数，此处没有。
所以一条 `cellIs` 规则回来时带着运算符、没有操作数。编一个貌似合理的会更糟 ——
规则会看起来完整、而求值不同。

`priority` 也不会原值回来，这同样是有意的：`iPri` **必须**不与工作簿中任何其他规则重复，
所以由 writer 分配。规则保有**某个**优先级，供下一次写入重新编号。

### 目前还做不到的事

下面每一项在工作簿用到它时都会**被报告**，因此缺口在它产生代价的那一刻就是可见的，而不是事后在
Excel 里才被发现。

- 公式中的**数组常量**。按名字被拒绝，而不是被编码成别的东西。

  **结构化引用与整行/整列引用不再被拒绝。** 前者需要 `PtgList`，后者只需一个降解步骤 ——
  两者都已实现，见下文。

- **流式写入，两个容器都支持。** `Workbook.toBuffer`、`writeFile`、`toStream` 接受 `format: "xlsb"`，
  `read`/`readWithDiagnostics` 能自动识别，而 `createStreamWriter` 现在也接受 `format: "xlsb"` ——
  行在提交时就被编码并交给 ZIP，所以 `pnpm benchmark:xlsb-scale` 能把一千万个单元格
  写成 95 MB 的 `.xlsb`。

  **此处曾给出两条「做不到」的理由，两条都是错的。记录在此而非静默替换**，因为每一条都被相信过一段时间，
  而它们各自错在哪里才是有用的部分。

  第一条说共享字符串表与样式表在写工作表期间驻留、之后才发出，单趟前向写入做不到。两个容器的这两个部件
  都在包**末尾**写，XLSX 的流式 writer 正是这么做的。从来不是障碍。

  第二条是 `BrtWsDim`：它在行数据之前，却陈述最终范围，前向单趟填不了。这一半是真的。**未观察**的是
  Excel 是否*需要*它 —— 它在语料库全部 67 个工作表部件里都写了这条记录，而本库校验器接受缺它的部件
  并不能证明 Excel 接受。最后是靠构造一个每张表都删掉该记录的包、在 Excel 里打开来定论的：**Excel
  干净打开，无修复**。所以流式路径只省略它、别的一个不少，`stream/__tests__/streaming-xlsb.node.test.ts`
  用「流式 sheet 部件与缓冲的逐记录比对」把这一点钉住。

  第三条理由是真的，也是实际的工作量：`writeXlsbPackage` 在一趟遍历里编排内容类型、关系编号、部件编号、
  绘图与透视缓存。它现在接受 `streamed: { sheetPaths, strings, formats }` —— 流式调用方已经写出的
  sheet 部件路径，以及那些记录所索引的驻留表。所以**仍然只有一个包写入器**，流式产物与缓冲产物相差
  一条记录，而不是一百处细节。

  **什么有界、什么没有。** 行有界：什么都不累积，实测流式 XLSB 的存活堆与流式 XLSX **完全相同**
  （每十万行取样为 103 / 146 / 191 MB 对 103 / 147 / 192 MB）。两者都按约 450 字节/行增长，原因是
  API 而不是写入器 —— `Stream.commitRow` 是同步的，紧循环里的生产者跑得比磁盘快，差额排在输出流里。
  共享字符串表与样式表**没有**界，且是按*不同值*而非按单元格计 —— 与 XLSX 流式 writer 同一处境。
  不同的字符串是 XLSB 唯一真正无界的东西，因为 `BrtCellIsst` 要经表才能拿到字符串；XLSB 确实定义了
  内联字符串单元格（`BrtCellSt`），但没有使用，因为 Excel 在整个语料库里一次都没写过它。

  流式 XLSB 写入耗时约为流式 XLSX 的 **1.8 倍**。这是真实特征而不是舍入差异，`pnpm benchmark:xlsb`
  把它报出来，而不是换一个能藏住它的工况。

- **流式读取，两个容器都支持。** `Stream.WorkbookReader` 逐记录解码 `.bin` 工作表部件，产出与 XML
  路径**同一种** `row` 事件，所以调用方两边写同一个循环。它是**子类**而不是平行读取器：调用方触碰的
  一切都是 `WorksheetReader` 的，只有 `parse()` 不同。

  流式二进制读取有三处不呈现，是**实测**出来而非假定的：公式给出**缓存值**（解 token 需要工作簿的
  名称与表索引）、富文本被**摊平**（样式 run 与文本一起住在共享字符串表里）、`BrtEndSheetData` 之后
  的一切都缺席 —— 合并区、条件格式、窗格、页设置、超链接、批注 —— 因为前向读取器那时已经把这些记录
  本该附着的行发出去了。合并区的延续格因此流式为空。XML 流式读取器的最后一条限制完全相同，原因也相同。

- **共享公式与数组公式已可写入**，而这里是一条过期的「做不到」代价最大的地方。此前记录了两条拒绝理由，
  两条都已失效：

  - `PtgExp`「需要主单元格地址 —— 扁平的单元格模型不携带该信息」。模型恰恰携带它：`sharedFormula`
    **就是**主单元格地址。
  - `BrtArrFmla`「未出现在任何参照工作簿中，布局未确立」。那是针对当时的 9 文件语料库；当前语料库里
    `poi-bug66682.xlsb` 有一条 `BrtArrFmla`、`poi-62815.xlsb` 有四条 `BrtShrFmla`，且都能按字段表
    逐字节闭合。

  修它时暴露出**读取侧**一直存在的静默缺陷：`PtgExp` 被按七字节解码（token + 四字节行 + 两字节列），
  实际是五字节 —— 列在 `RgbExtra` 的 `PtgExtraCol` 里，而读取器**从不读 `RgbExtra`**。于是所有真实
  文件里的共享公式都解码失败、被记为「无法解码」，而一条用七字节夹具的测试让编解码始终自洽。

  **一般性教训比这个修复更值钱**：当支撑某条拒绝的证据变化时，没有任何机制去重新审视它。这个容器里有
  三条「做不到」同时过期 —— 本条、`BrtArrFmla`、以及下面的 `BErr` 表 —— 都因为语料库在它们写下之后
  扩充了。

- **富文本已可写入。** `RichStr` 携带各段落，每段的字体驻留进**样式部件**的 `BrtFont` 集合 ——
  那正是 `ifnt` 索引的对象。这个「触达」才是真正的障碍：共享字符串表看不到字体表，所以一个段落
  只能引用某个单元格恰好用过的字体。

- **错误值已可写入。** `BErr` 是八值表（MS-XLSB 2.5.98.2），其中四个由 Excel 自己的文件确认 ——
  `0x07` `#DIV/0!`、`0x17` `#REF!`、`0x1D` `#NAME?`、`0x2A` `#N/A`。仍被拒绝的是**没有 `BErr` 码**
  的错误：`#SPILL!`、`#CALC!` 等动态数组家族晚于这个枚举，用 `#VALUE!` 替代会变成另一个错误，
  而不是一次被报告的损失。

- **未来函数已可写入。** `XLOOKUP`、`TEXTJOIN`、`CONFIDENCE.T`、`LET`、`SEQUENCE` —— 凡 `Ftab`
  没有 id 的函数，都按 Excel 的方式调用：一个 `PtgName` 指向隐藏的 `_xlfn.*` 存根，然后是参数，
  最后是 `tab = 0x00FF` 的 `PtgFuncVar`，其 `cparams` **把那个名字也数进去**。存根本身是一个带
  `fHidden | fFunc | fProc | fFutureFunction` 的定义名称，主体为 `PtgErr(#NAME?)` —— flags
  `0x0002000b`、rgce `1c 1d`，与 Excel 逐字节相同。`_xlfn.` 前缀不会泄漏给调用方：读回得到的是
  `XLOOKUP(…)`，也就是写入的原文、也是 XML 容器所存的形式。

  **数据透视表已可写入，包括从 XLSX 读入的。** 通过 `Pivot.add` 创建的透视表带着活的源工作表；
  从**文件**读入的没有，而 `pivotParts` 检查那个工作表、没有就返回 `undefined`。于是每一次
  XLSX→XLSB 转换都会丢弃透视表，而执行丢弃的那个 `continue` **什么都不记录** —— 连
  `unsupported: "error"` 都不会拒绝。读取器早已把解析形态规范化成 `cacheFields` 与 `cacheRecords`，
  信息本就齐备；需要的不是新知识，而是让写入器别问错问题。

  一张新建的透视表会变成四样东西：工作簿里把每个缓存绑定到其部件的
  `BrtBeginPivotCacheID` 记录、描述源范围及其字段的 `pivotCacheDefinition{n}.bin`、
  每个源行一条记录的 `pivotCacheRecords{n}.bin`、以及 `pivotTable{n}.bin` ——
  即视图，带着它的 pivot field、轴归属和数据项。算上两个 `.rels` 共五个部件，
  关系分三层：工作表 → 视图 → 缓存定义 → 缓存记录。

记录顺序来自 **MS-XLSB 3.8 节**，一个五十七步的逐字节实例。这份文档早先的版本声称透视表没有这样的依据，
而它在三段之前刚刚依赖了同一章里的 3.4 节（筛选的实例）。这一点记录在下面而非悄悄修掉。

**它无法分期交付，这塑造了整个工作方式。** 规范要求工作簿里**每条** `BrtBeginPivotCacheID`
都对应一个缓存定义部件，所以只带绑定而不带部件的包会指向不存在之物。
因此四个编码器先对着字段表建好并单测，最后**一步**接入 package writer。

### 五个跨部件不变量，全部端到端断言

它们没有一个能从单个部件里检查出来，也没有一个在被破坏时报错 —— 这正是此处最要紧的测试：

| 不变量                                           | 破坏后会发生什么                                             |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `idSx`（工作簿）= `idCache`（视图）              | 视图指向一个以别的 id 归档的缓存；表什么都不显示             |
| `cRecords`（定义）= `BrtPCRRecord` 条数 = 记录头 | reader 提前停止或读过集合边界                                |
| `csxvds`（视图）= `BrtBeginPCDField` 条数        | 轴集合索引进 `BrtBeginSXVDs`，缺口之后每个索引都指向错误字段 |
| 每个缓存记录索引 < 其字段的 `citems`             | **损坏**记录而非有损记录 —— reader 会跟着索引读到任意偏移    |
| `citems` = 实际写出的 `BrtPCDI*` 条数            | 同上                                                         |

### 四个布局陷阱

- **`BrtBeginPivotCacheDef` 的 `unused` 尾部当且仅当 `fLoadRefreshedWho` 为 0 时存在。**
  它读起来像存在标志、行为却是填充，两个都省会让记录短四字节并让其后每个字段错位。
  测试断言的是记录**长度**，不是标志。
- **`BrtBeginSXDI` 的字段表算不平。** 三行连着都叫 `ifmt`，外加一个 `reserved`；加起来 27，
  而实例声明 `0x3B`、标题占 34 字节。那个 `reserved` 字在四字节 `PivotNumFmt` **内部**、不在它旁边 ——
  多两字节会让这个部件里它之后的每条记录都读不出来。
- **`BrtBeginSXView` 有两个存在标志是反的。** `fDisplayData` 说 `irstData` **在**且 MUST 为 1；
  `fEmptyDisplayErrorString` 与 `fEmptyDisplayNullString` 说各自字符串**不在**。
  把这一对当普通"有值"标志读，会让记录的字符串从它后面的字节里读出来。
- **聚合枚举不是模型的顺序。** 记录里 `count`=1、`countNums`=6，这不是 OOXML
  `ST_DataConsolidateFunction` 的列举顺序。按位置映射会互换两者，
  **透视表会静默报出不同的数字**。十一个值全部断言。

两处刻意的选择值得知道。**共享项标志从项本身推导**，不用模型的 `containsNumber` 之类：
后者是保留下来的 **XLSX** 属性字符串、可能缺失，而 `BrtPCRRecord` 没有逐项标签、
reader 恰恰靠这些标志给它的内联值定类型。以及**透视行只写一条总计行**而非完整展开 ——
布局是 Excel 刷新时重算的东西，且缓存带着 `fRefreshOnLoad`。
把它们枚举出来意味着复刻 Excel 的分类汇总与嵌套规则，去产出一个它会丢弃的东西 ——
XLSX writer 用 `<rowItems>` 以同样方式回避了这件事。

### 记录这个错误

这份文档此前说记录顺序无从得知：每个部件的 ABNF 语法文件（`Biff12PivotTableGrammar.abnf`）
随微软内部构建发布而非随规范发布，且没有语料工作簿含透视表 —— 23 个里 0 个。
两个事实都成立而结论是错的，因为第 3 节标题就是 "Structure Examples"、
包含十个逐字节走查，其中一个正是这个。**这个"不存在"是对着一份当时正打开的文档断言的，
却没有读它的目录** —— 而筛选记录已经是照 3.4 节建起来的。
本次工作得出过两个"格式无法表达此项"的结论，两个都错了，另一个是保护密码；
两次证据都只差一次搜索。

从 XLSB **读入**的透视表仍作为 opaque 字节被搬运而非建模 —— 这个 reader 不解析二进制透视部件 ——
所以读-改-写会逐字节保留它，`xlsb/__tests__/pivot-preservation.node.test.ts`
用这个 writer 不可能合成的载荷钉住了这一点。

**水印两种模式都已写入**，而原先声称做不到的那条记录错了两层。这个模型里没有**文字**水印可丢：
`WatermarkOptions` 要求 `imageId`，文字是在上游被栅格化成半透明图片后当普通图片走的，
所以损失清单点名的是一个并不存在的特性 —— 它的 fixture `{ watermark: { text: "DRAFT" } }`
是全仓唯一出现过这个形状的地方。同时**页眉**模式的水印一直是正确写出的、却仍被报告为丢失，
这等于告诉调用者去预期一张其实就在文件里的图片。

真正的缺陷在下面：**overlay** 水印被和页眉图片收在一起，于是写进了页眉/页脚 VML。
它回来时成了页眉正中的 `headerImage`、透明度被丢掉 —— 一张本该在单元格背后的图片
变成了页眉装饰。这不是有损写入而是**另一个文档**，而它之所以不可见，恰恰因为结果是合法的。
`utils/drawing-utils.ts` 里的 `buildWatermarkOverlayAnchors` 现在服务两个 writer，
且测试比较的是两种容器各自的 drawing 部件、而不是拿其中一个和自己比：
同样的 `alphaModFix`、同样的绝对 anchor、同样的图片关系。

**条件格式已完整支持** —— 规则与它所应用的格式。规则的格式是一条 `BrtDXF`：
一种**差异**格式，即一组覆盖项而非一套完整样式，编码为一个标志字后跟一个 `XFProps` ——
`XFProp` 的计数数组，每项由类型、大小和一个由类型决定形态的 blob 组成。三十八种类型中写了十四种，
这就是此处 `Style` 能表达的全部：填充图案及其两种颜色、文字颜色、字体名、加粗、倾斜、删除线、
字号、四条边框边加对角线、以及两个对角线方向。

这条记录里有四个会静默出错的细节，都为此做了断言。**`cb` 是整个 `XFProp` 的大小，含头部**：
写成 blob 长度会让第一项之后的每个属性都提前四字节落位，而 reader 察觉不到 ——
它会从一个颜色的中间读出一个看似合理的类型，所以测试断言这趟遍历**恰好**闭合在 payload 长度上。
**`Bold` 是一个枚举** —— `0x0190` 常规、`0x02BC` 加粗 —— 所以模型持有的布尔值不能直接写过去；
那里的 `1` 两个值都不是，会被读成字体粗细为一。**`LongRGBA` 是红-绿-蓝-alpha**，
不是 `argb` 字符串拼写的顺序，这是一次通道轮转而非可见的错误。以及
**`XFPropBorder` 的 `dgBorder` 取自 `BrtBorder` 边所用的同一张表**（`borderStyleValue`），
因为那十四个样式名在两处以两种顺序各存一份，正是其中一处会把调用者要的 `thin` 写成 `medium` 的成因。

类型 `0x0B` 与 `0x0C` —— 区域的**内部**边框 —— 被有意从不写出，且 `fNewBorder` 保持为 0 来声明这一点：
它们由该标志门控，而单元格样式没有这种东西。属性按类型排序，规范并不要求
（它约束哪些类型可以**共存**，而非它们的次序），但 Excel 如此，
而一次无谓的偏离就多一件 reader 可能严格对待的事。

规则本身值得下功夫。**一条规则的形态由一**对**枚举决定**：`iType` 说格式如何绘制、`iTemplate`
说条件是什么，且 MS-XLSB 列出了合法组合并声明"其他组合 MUST NOT 使用"。模型把五种条件 ——
`containsText`、`containsBlanks`、`containsErrors` 及其否定 —— 折叠成一个类型、靠 operator 区分，
而记录有五个模板；并且 `CFOper` 从 **1** 开始，差一就会把"大于"变成"不等于"。两者都对照规范
自带的表格做了断言，因为两者都会静默出错。另有三个细节同样处理：`fAbove` 由模板推导而非读模型，
使两者不可能自相矛盾；`rgce2` 只在 `between`/`notBetween` 时存在，为其他运算符多写一个流会让
reader 从那里开始全部错位；以及 `iPri` 必须在整张表内唯一，而模型的优先级是按块给的、经常冲突 ——
所以由 writer 统一分配。

**迷你图已从这份清单移除**，而它是这里唯一完全由**未来记录**（future record）构成的特性。
未来记录以 `FRTHeader` 开头：四个标志位说明后面跟着四个可选块中的哪些 —— 而对迷你图来说，
那些块**就是**内容本身，所以它占据的单元格是一个 `FRTSqrefs`、它绘制的范围是一个 `FRTFormulas`。
嵌套是它静默出错的地方：`FRTSqrefs` 计数 `FRTSqref`，而每个 `FRTSqref` 又持有一个
`UncheckedSqRfX`、**再**计数一层范围 —— 两层，且都被要求为 1，并且 `rwFirst == rwLast`，
因为一个迷你图只占一个单元格。

两个细节由测试钉住，因为各自都是静默的。`fShowEmptyCellAsZero` 是一个**两位的枚举**而不是标志位，
按一位读会把"span"变成"gap"。以及数据范围必须是 `PtgArea3d`：未限定的 `A1:C1` 解析成普通
`PtgArea`，而这条记录不接受那种形态 —— 所以当模型省略工作表名时要补上。

**图表已从这份清单移除**，而当初把它留在清单上的那个估计错得很有教益。`chart` 在 XLSX writer 里
出现 434 次，读起来像是要移植一整个子系统 —— 但一个程序化图表走的是 `Chart.add` →
`addChartEntry`，后者把一个 `{ chartNumber, model }` 条目放到**工作簿**上，而一个 helper 就能把
该条目渲染成 XML。那 434 处的其余部分是读取路径和图表引擎，writer 两者都不需要。
数引用次数是难度的代理指标，而且是个糟糕的代理。

图表部件在**两种**容器里都是 XML —— `cal-any_sheets.xlsb` 就在它的 `.bin` 图表工作表旁边带着
`xl/charts/chart1.xml` —— 所以什么都不需要翻译，并且有一个测试断言两个 writer 产出的图表 XML
逐字节相同。两个容易搞错的细节已被钉住：绝对定位的图表 anchor，其位置在**模型里是 EMU、在
anchor 里是像素**（`PosXform` 会乘 `EMU_PER_PIXEL_AT_96_DPI`，直接传 EMU 会放大 9525 倍）；
以及图表的关系来自 **drawing** 而非工作表，因为是 `graphicFrame` 指名它。

**图表工作表**紧随其后，而且很便宜 —— 因为贵的那一半是图表部件。工作表本身只有十条记录，
且是对照 `cal-any_sheets.xlsb` 自身的记录流断言的、而非对照字段清单；其余一切都来自 XLSX
writer：图表、drawing 和两套关系。有两件事必须做对，而且都不显然。drawing 使用**绝对** anchor
并带具体的 EMU 尺寸，因为图表工作表没有单元格网格，基于单元格的 anchor 会解析成 0×0 ——
Excel 随后渲染出一张空白画布。以及 `BrtBundleSh` 携带的是**关系 id**，而这个 writer 原本按
bundle 位置推导它：图表工作表在该序列里排在工作表之后，于是每个图表工作表都指向了一个工作表 ——
一个标签写着"Chart1"、内容却是网格的页签。

**形状与线程批注已从这份清单移除**，原因恰好相反，值得对照。线程批注**根本没有** BIFF12 形式 ——
部件在两种容器里都是 XML —— 所以支持它就是把 XLSX 渲染器的输出写进包、再加两条关系，零翻译。
形状同样不需要新记录，但理由相反：它是**工作表既有 drawing 里的一个 anchor**；writer 之前没有形状
只是因为 `drawingForWorksheet` 过滤了 `type === "image"` 并提前返回，而那六十行 anchor 运算住在
XLSX 的 worksheet xform 里、外面拿不到。现在它是 `buildShapeAnchors`，两个 writer 都调用它。

**表单控件**走了同一条路，但值得单独一笔，因为一个控件是**三个**部件：一个通过 `spid` 桥接到 VML
形状的隐藏 DrawingML anchor、绘制它的那个 VML、以及承载其属性的
`xl/ctrlProps/ctrlPropN.xml`。而这个 VML 是**与批注共用的** —— Excel 每张表只写一个
`vmlDrawing{N}.vml`，同时容纳批注框与复选框形状，且工作表只有一条 `BrtLegacyDrawing` ——
所以写第二个文件会让其中一个无法触达。值得记录的错误：VML **关系**原本只在工作表有批注时才发出，
于是一个位于无批注工作表上的复选框到了 Excel 里，其 VML 存在却没有任何东西指向它。

工作表侧不再有更窄的缺口。多重工作表/工作簿视图、图表工作表、自动筛选条件和**保护密码**
都曾在这份清单上，现在均已写入。

**密码这一项值得作为一个错误记录下来，而不是作为一个特性。** 这份文档曾有一段时间声称它
**物理上不可能**：`BrtSheetProtection` 里的 `protpwd` 是 16 位验证码，模型持有 SHA-512 哈希，
而哈希无法被逆推回验证码算法所需的明文。这些陈述每一条都是真的。结论却不成立，
因为 `protpwd` 从来不是密码唯一的去处 —— **`BrtSheetProtectionIso` 与 `BrtBookProtectionIso`
正是为 ISO/IEC 29500 形式而存在的**，它们**逐字节**承载盐值、算法名、哈希字节和迭代次数。
什么都不需要逆推，因为什么都不需要计算：哈希是被**搬运**过去的。

让它成为一个错误而非一次疏漏的，是证据本来就在这个仓库里。`xlsb/spec/record-names.ts` 里
868 条记录名表包含这两条记录，搜一次 `Iso` 就能找到。当时的推理是从**已经实现的那一条记录**
推出了一个关于**整个格式**的结论 —— 这与"靠数一个词在源码里出现多少次来判断特性难度"是同一个错误。
一个测试在它存在的全部时间里把这个错误的结论原样断言回来，而这正是那类测试的作用，
也是它值得在此点名的原因。

配对关系是**规范规定的**而非猜测，这一点很重要，因为没有语料工作簿带密码：
一条 Iso 记录**必须紧接其后跟着**它的旧记录，后者的验证码为 0、十六个权限布尔值完全相同。
两件事都做了断言 —— 顺序，以及十六个值全部一致 —— 并且权限来自**同一张共享表**，
因为那十六项带默认值的列表存两份，正是得到两份互不相同的可靠办法。

有一个会静默出错的细节并已处理：模型按 OOXML 的方式把哈希和盐值存成 **base64 文本**，
而记录要的是字节。把 base64 的**字符**写进去会产生一个形状正确、值错误的哈希，
而没有任何 reader 能察觉 —— 密码只是永远不会匹配。

**自动筛选条件**值得记一笔，因为解开它的既不是一条新记录、也不是一个新样本。范围一直是写入的；
条件被判定为不可写，理由是模型没有它的结构化表示 —— XLSX reader 把 `<filterColumn>` 元素
保存为**原始 XML**、XLSX writer 逐字节原样重放，而这正是那条往返路径字节精确的原因。
看起来该做的修法是在 `core/` 里建模条件，那意味着 XLSX writer 改为从该模型重新序列化 ——
为了那个还不能用的格式，去牺牲那个已经能用的格式的保真度。真正的修法是意识到
**这段 XML 本身就是数据**：`xlsb/filter-criteria.ts` 解析它并发出记录，XLSX 路径分毫未动。
条件没有公开设置入口 —— 它只会从读取而来 —— 所以把保留下来的 XML 当作数据源没有任何损失。

记录顺序也不是猜的。**MS-XLSB 3.4 节是这一序列的逐字节实例** ——
`BrtBeginAFilter`、`BrtBeginFilterColumn`、`BrtBeginCustomFilters`、`BrtCustomFilter` 及各自的 End ——
这正是透视表所缺的权威依据。

XLSX reader 能保留的七种条件全部已写入：值、日期分组项、自定义比较、top-N、动态、颜色、图标。
仍会被报告的是一个 schema **扩展** —— 筛选列里的 `extLst` —— 而因为 XML 是被解析的，
损失报告点名的是**它无法表达的那个元素**，不再一见条件就把全部条件一并判死。
唯一条件被拒的列会被跳过而非发出一个空列，且范围无论如何都保留 ——
丢掉范围会是比被报告的那个更大的损失。

三种动态类型里另有四个陷阱，都做了断言：

- **动态筛选的枚举中间有空洞。** `aboveAverage` 与 `belowAverage` 是 1 和 2，
  而日期区间从 **8** 才继续 —— 3 到 7 未分配。按 schema 列表位置索引的数组会让
  `tomorrow` 得到一个毫无意义的值，其后每个区间也都错位。
- **`cellColor` 缺失即为 true**，和 `showButton` 一样。`<colorFilter dxfId="0"/>` 按**填充**色筛选，
  所以把它当普通标志读会把每个填充色筛选反转成字体色筛选。
- **无法映射的种类一律拒绝，绝不近似。** `CFTNIL`、`KPINIL` 图标集、以及 `0xFFFFFFFF` 的 `dxfid`
  都是**声明"没有筛选"**的记录 —— 写出其中任何一个，就把一条被报告的损失变成了一个静默什么都不做的筛选。
- **日期分组项的字段宽度不统一**：`dom` 是四字节而 `hour` 是两字节。假定统一会让其后每个字段偏移两字节。

关于这部分为什么被写了两遍，值得如实记录。这个仓库里有一个开着的 pull request ——
一份独立的、另一套 XLSB 实现 —— 已经覆盖了 ISO 保护密码和全部七种筛选类型。
本次工作并不知道，因为它是对着 `[MS-XLSB]` 和语料做的调研，**从没对着仓库自己的分支查过**。
尤其是密码那一项：当这份文档称它物理上不可能时，一个开着的 PR 正在否证它。
这个教训说起来很便宜、学起来很贵：在判断格式能做什么之前，先查项目已经有什么。

这些记录里有两个会静默出错的细节，都为此做了断言。**`fAnd` 是反的**：MS-XLSB 给出
`0x00000000` 表示 AND、`0x00000001` 表示 OR，而 XML 把同一件事拼作 `and="1"`，
所以把属性直接传过去会让每个双条件筛选的 AND 与 OR 互换 ——
这是一个显示错误行数的筛选、而不是一个打不开的文件。以及
**`showButton` 与 `hiddenButton` 的默认值相反**：`hiddenButton` 缺失即为 false，
而 `showButton` 缺失即为 **true**，所以把后者当普通标志读会给每一列都设上 `fNoBtn`、
隐藏表中每一个下拉按钮 —— 一个存在于文件里、却无法从界面触达的筛选。
这一条是真实存在过的 bug，靠解码字节抓到的，而不是靠一个与代码互相认同的测试。

**结构化引用**（`Table1[Column]`）仍被拒绝，这是表格留下的唯一缺口：它需要 `PtgList`，
那是一个公式 token，不属于表格部件。

冻结与拆分窗格（`BrtPane`）、分页符（`BrtBrk`）和数据验证（`BrtDVal`）**曾在**这份清单上，
现在已可读写。促成改变的
不是新样本，而是两点认识：`[MS-XLSB]` 本身就记录了这两个布局；而语料是二十三个**测试固件**，
不是对人们实际构建内容的采样 —— 冻结窗格和分页符都是人刻意设置的东西，它们在固件集里缺席
几乎说明不了什么。两者各带一个值得知道的陷阱：`BrtPane` 的两个 `Xnum` 字段相对 XLSX 的
`xSplit`/`ySplit` 是**互换**的；且拆分窗格下它们是 twips 位置，冻结窗格下才是行列数。
经由本库的往返测试无法验证这两点 —— reader 与 writer 会彼此一致而同时与 Excel 不一致 ——
因此测试改为对照规范的字段顺序及其自带示例，断言字节布局。

数据验证是三者中最大的一个，因为该记录有四个部分、其中三个变长：一个带符号的区域计数、四个
字符串、两个 token 流。其中两个细节值得知道，因为它们都会静默出错。`DValStrings` 把**错误**
这一对排在提示之前，颠倒二者会把验证的提示塞进错误警告里。而验证的边界是 `Ptg` token 流而非
文本 —— reader 的第一版把它们返回为空数组并报告"无法读取"，这个判断错了两次：解码器早已为
单元格公式而存在；且 `{ type: "whole", operator: "between", formulae: [] }` 不是一条不完整的
规则，而是一条 Excel 对任何输入都接受的规则。产出这种结果的 reader 是悄悄把约束关掉了，比
承认自己丢了这条验证更糟。

批注则走了相反的路，它是这里**唯一对照 Excel 自身字节验证过**的特性：`poi-comments.xlsb` 与
`poi-testVarious.xlsb` 合计带有十四条批注，因此每一项布局主张 —— 去重后的作者表、36 字节的
锚点、带运行表的 `RichStr`、全零 GUID，甚至 `application/vnd.ms-excel.comments` 这个
content type —— 都是从真实文件里读出来的，而不是仅凭规范。测试直接断言语料样本本身，而不只是
跑往返，因为往返分不清"读对了"和"读写两侧同错"。

让批注比它的记录更大的那件事：**它是包里的三个部件，不是一个。** 文本在 `comments{N}.bin`，
而**批注框**是 `xl/drawings/vmlDrawing{N}.vml` 里的 legacy VML，且工作表需要一条
`BrtLegacyDrawing` 指向该 VML 的关系。只写记录不写 VML，Excel 打开后批注数据俱在、屏幕上
什么也没有。VML 通过 XLSX writer 自己的 xform 渲染而非重新实现，因为 legacy VML 没有二进制
形式，两种容器下逐字节相同。真正没能保住的是运行的字体：`ifnt` 索引 styles 部件，而后者在
comments 之后才写，所以保住的是运行的**分段** —— 署名在哪里结束、正文从哪里开始 ——
字体格式则作为损失上报。

表格是四者中最后做的，它自成一个**部件** `xl/tables/table{N}.bin`，由工作表的关系触达 ——
工作表的记录流里没有任何东西提到表格。没有语料工作簿含 `BrtBeginList`，但 MS-XLSB 为这两条
记录都给了**逐字节示例**，这比字段清单更有力：示例的 `BrtBeginListCol` 为 0x38 字节，算式
正好收在 `24 + 4 + 12 + 4 + 4 + 4 + 4`，同时钉住了字段顺序与空 `XLNullableWideString` 的
四字节宽度。三个陷阱都是静默的：`ilta` 的枚举顺序与模型**不同**（两对互换、`sum` 错开三位，
按下标映射会把平均值变成计数）；标准表格的 `stName` 为 NULL、表头文字在 `stCaption`；
以及"无差异格式"的 `DXFId` 是 `0xFFFFFFFF`，因为 0 是差异格式表里的真实下标。

表格的**数据**不在表格部件里 —— MS-XLSB 2.1.7.51 明确说它留在工作表 —— 因此 reader 从单元格
重建 `rows`。这是必须的：`tableSetModel` 会把"行数少于工作表"的模型判定为表格**收缩**并清空
差额，所以空 `rows` 会删掉数据区的每一个单元格。差分测试抓到了这个问题，接着又抓到了后续
问题 —— 把 totals 行算作数据会让表格高出一行，并把第二个 totals 行盖在下方单元格上。

接着是清空了大半清单的那一轮，它的教训比任何单个特性都重要：**"缺失"的大多数其实是记录早已在写、
只是字段被硬编码了。** `BrtSheetProtection` 是 66 字节不透明 blob —— 而旁边的注释写着"组装出
64 字节而 Excel 写 66"，那句话本身就指出了 bug：漏掉的两个字节是 `protpwd`，一个 `u16`，在**最前**。
`BrtBeginWsView` 写字面量 `0x039c` 并以另一条路径凑到相同长度，`icvHdr` 被当成 `u32` 而规范是 `u8`；
字节与 Excel 完全一致只因为 64 和 100 恰好放得下。`BrtWsFmtInfo` 末两字节原是清零的 `u16`，实为
`iOutLevelRw`/`iOutLevelCol`。`BrtCalcProp` 的 `fIter` 是 bit 2。`BrtBorder` 原是 51 个零字节。
`BrtName` 把每个名字强制为工作簿作用域 —— 这正是**打印区域与打印标题**当初上榜的原因：它们是
`_xlnm.*` 定义名而不是记录，被卡在那个缺口后面。

途中还有：多区域定义名需要**括号**（`(A1:B2,C3:D4)`），因为裸逗号在 Excel 语法里不是 union；
整行引用不需要新 token，只需把另一轴钉到极限的 `PtgArea` —— 而读回时若还原成普通范围而非 `$1:$1`，
得到的东西计算相同、却**不是合法的打印标题**；以及 `encodeColor(undefined)` 写的是**自动色**，
这对字体正确、对边框错误 —— 边框处 Excel 写的是零。

**结构化引用**现已可用，这让上面的表格能被公式真正使用。`PtgList` 携带 `idList` 与**相对于表格**
的列索引，因此表格 id 在任何工作表写入之前就分配好 —— 工作表 1 的公式可能引用工作表 3 的表格。
有一项归一化对调用者可见，因此被断言而非隐藏：`Table1[[Qty]:[Note]]` 会变回
`Table1[[Qty],[Note]]`，因为两者解析成同一个 AST 节点，而 XLSB 存 token、XLSX 存文本。

另有两件比特性清单本身更深的事。拒绝一个公式时原本只报 `A1: formula`；编码器本已指明是哪种构造，
而那个名字**被一个 `catch` 吞掉了**，于是所有无法编码的公式都给出同一条消息。以及
`applyCellFormat` 与 `styleAt` 是**分别**拼装单元格样式的 —— 这正是边框在行上生效、在单元格上
不生效的成因。

- 错误值，读写两侧都不行。`BrtCellError` 与 `BrtFmlaError` 有已声明的形状 —— 一个 cell 后跟一个
  单字节错误码 —— 而**语料中没有任何一个工作簿包含这两条记录之一**，因此从 `#DIV/0!` 到错误码的
  映射未被观测。读取时该单元格变成空白并上报地址；写入时保留公式、缓存值按"未计算"处理，因为
  Excel 打开即重算，为了保护一个即将被替换的值而丢掉表达式是更差的交换。
- 图表页。读成空工作表以免其后的表位置发生偏移，并上报。
- 单元格批注、行与列的隐藏/分组/折叠状态、best-fit 列、工作簿保护、工作簿与工作表视图设置、
  命名单元格样式，以及已确立子集之外的页面设置字段。每一项都按工作表或按工作簿上报。
- 富文本共享字符串的格式段。文字会保留 —— 因为它是粗体就丢掉整个字符串更糟 —— 格式段在读取时上报。

相比之下，文档属性**会**被保留：`docProps/core.xml` 与 `docProps/app.xml` 都会读写，因此
creator、title、company 和日期能往返。工作簿默认字体同样保留 —— 写入 0 号字体，读取时从该处恢复；
主题也一样：XLSX→XLSB 时从模型写出，XLSB→XLSB 时原样保留。

跨表范围引用（`SUM(Sheet1:Sheet3!A1)`）会按完整范围写出。这需要一条 `itabFirst` 与 `itabLast` 不同的
`BrtExternSheet` 项：该项的布局已由 Excel 输出确立，"两者不同即为跨表"属于**取值推断**，并已按推断登记。
此前的做法是写出首表的项，把公式变成 `SUM(Sheet1!A1)` —— 那不是保真损失，而是**另一个答案**。

**每张表最多只有一个 drawing**，因此向"图片来自 XLSB 读取"的表再添加图片会被拒绝而不是写出：第二个
drawing part 会让该表只指向其中一个，另一个里的图片就消失了。在 `unsupported: "ignore"` 下，原有图片优先。

- 有些**取值**被写入已确立的布局，却从未被观测到。语料库中每个字体都是常规字重且 `grbit` = 0，
  因此 `BrtFont` 的粗体与斜体**字段**是确立的，而它们的"开"状态不是 —— 那些值来自同一属性在
  XLSX 形式中所用的成文约定。从 Excel 字节读出的偏移与取自约定的取值是两类不同的断言，因此分开
  存放：推断集中在一处登记表（`xlsb/spec/records.ts` 的 `INFERRED_VALUES`），`spec.test.ts`
  会逐条把它们与记录表对齐，因此加一个推断值就必须在登记表里出现。一个含一个粗体和一个斜体单元格的工作簿就能把这
  八项全部落实。
- 有七条单元格记录——`BrtShortBlank`、`BrtShortRk`、`BrtShortError`、`BrtShortBool`、
  `BrtShortReal`、`BrtShortSt`、`BrtShortIsst`——没有已确立的载荷布局，而它们的依据比这句话
  暗示的还要薄：**`[MS-XLSB]` 2.4 根本没有收录 id 12–18**。这些名字来自社区逆向而非规范，
  `spec/record-names.ts` 把它们放在 `RECORDS_ABSENT_FROM_SPEC` 而不是与规范收录的 868 条并列，
  正是为了把这一点说明白。它们在钉住的二十三个语料工作簿（其中十八个由 Excel 生成）中出现
  **零**次，这些文件全部使用完整的 `BrtCell*` 形式。reader 会识别、计数并报告它们，而不是猜测
  偏移或丢弃单元格；writer 则从不发射它们。`spec.test.ts` 会断言清单上的每个名字确实是
  「无已声明布局的 cell 记录」，因此这个缺口不能靠删清单来关闭。

### 可运行示例

```bash
pnpm example --filter xlsb-round-trip   # 值、日期、公式、定义名、跨表引用
pnpm example --filter xlsb-formatting   # 字体、填充、对齐、保护、页面设置、标签色
pnpm example --filter xlsb-fidelity     # 什么被保留、什么被上报,以及 1904 epoch
```

其中第二个找出了测试套件没找到的 bug:「一个按行设置样式的表头行,加上其中某个想要旋转的单元格」——
这种形状在按功能逐项写测试时不会自然出现。行格式此前是在单元格**之后**应用的,于是覆盖了每个单元格
自己声明的格式 —— 这与格式本身的规则相反:单元格的 `iStyleRef` 胜过所在行的 `ixfe`。

### 参考语料，以及如何获取

```bash
pnpm corpus:xlsb   # 取 23 个 fixture 到 tmp/xlsb-corpus，逐个校验 SHA-256
```

二十三个 `.xlsb` 文件，在 `xlsb/corpus/manifest.ts` 里按上游 commit 和摘要钉住 —— 十二个来自
[Calamine](https://github.com/tafia/calamine)，十一个来自 [Apache POI](https://github.com/apache/poi)。
它们不入库：这是别人项目的测试文件，许可不由我们假定，283 KiB 第三方二进制也不该进发布包。读取它们的
gate 在缓存缺失时跳过，因此没取语料的贡献者不会被阻塞。

**这替代了原先指向某台机器上某个目录的 `DOCUMONSTER_XLSB_CORPUS_DIR`** —— 那不是语料，是一份私人笔记：
别人无法确认这里断言的任何一个偏移，也无从判断后一次运行用的是不是同一批字节。钉住之后，「从 Excel 的
输出读出来」才从一句声明变成一道可复现的流程。

每条记录带一个 `authority`，而这个区分是**承重的**，不是描述性的：

| 权威性          | 数量 | 可以对它断言什么                                                                                                                            |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `excel`         | 18   | 全部。记录布局由它们确立。                                                                                                                  |
| `reduced`       | 2    | 仅可读性。手工削减的 bug 复现文件会合理地缺少真实工作簿都有的记录。                                                                         |
| `nonconformant` | 1    | 仅可读性。`poi-Simple.xlsb` 自己的属性里写着 "Microsoft Excel 2007 Beta 2"，且把 `iTabID` 写成 0，而规范明文要求它必须在 1 到 0xFFFF 之间。 |
| `encrypted`     | 2    | 只断言「被拒绝而不是被弄坏」。它们是 OLE 封装，根本不是 ZIP 包。                                                                            |

没有这一列，一个 beta 版的错误就会变成关于格式的证据，接下来的诱惑就是放宽 codec 去接受它 —— 而这正是
一个 reader 如何变成接受两种布局、却写出第三种。

**加入第二个上游立刻就回本了。** 本模块钉住的两个「恒定」记录长度，其实只在 Calamine 那一批里恒定：
`BrtCellBlank` 在十一个文件里是 8 字节，在 `poi-62815.xlsb` 里是 9 —— 那是个 Excel 16.0 文件，其余方面
完全合规。而且第一次运行就浮出两个真 bug：一条畸形的工作表记录让三张表的工作簿读成零张表；future-record
包装器内部的记录被当作普通记录读取，于是在 A282 凭空造出一个单元格，还带着这个工作簿根本没有的格式索引。

那两个仍然值得留着。它们是五部件的骨架、31 字节的工作表、不声明任何视图 —— 而这几乎正是本库此前写
出的形状。所以它们同时既是"削减过的包仍可读"的证据,也是"不可打开的包长什么样"的证据 —— 这也是
`record-missing-required` 是 warning 而非 error 的原因:拒绝它们就等于拒绝本库能正确读取的文件。

### 参考语料找出的 bug

有四个静默的正确性 bug 就在本库自己的输出里,而它们对往返测试都不可见,原因相同:reader 与 writer
彼此一致。

| Bug                                                                 | 为什么没有测试能看见                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 引用定义名的公式写出 `PtgName` 索引,指向一张从未发出的 `BrtName` 表 | 读回得到的是缓存**结果**,所以值是对的而公式没了                                                                                    |
| 每一个跨表引用都写出 `ixti`,指向一张从未发出的 `BrtExternSheet` 表  | 同上 —— 而 3D 引用比定义名常见得多                                                                                                 |
| `ixti` 被当作工作表索引解析,而不是经由表解析                        | reader 与 writer 自洽。`issues.xlsb` 的表第二项指向**第三张**表,于是 `OneRange` 读成 `issue2!$A$1`,而 Excel 的意思是 `Sheet1!$A$1` |
| 工作簿关系被写到 `xl/_rels/workbook.xml.rels`                       | OPC 找的是 `workbook.bin.rels`,于是工作表在唯一能触达它们的机制里不可达 —— 而 reader 靠算术推算路径,照样找到了                     |

第五个由同样手段发现,但属于保真缺口而非破损:图表页会让工作表部件编号不连续,于是按位置推算部件会把
一张表的数据放到另一张表上。`any_sheets.xlsb` 的图表页在最后,那里的错误不造成损失;若在中间,它后面
的每一张表都会被静默错位。

### 已对照 Excel 自己的输出

每一处布局都是从由 Excel 生成的工作簿——共九个由 Excel 生成的——确立的，而不是假设出来的；其中三处由不可能是
巧合的数值钉住：日期单元格上的格式 id 14、默认列上的 2742，以及名为 `Visible`/`Hidden`/`VeryHidden`
的三张表上的 0/1/2。

这个语料库还找出了一个任何合成测试都发现不了的 bug：两个其余完全相同的工作簿，其中一个用 1904
日期系统保存，读出来相差四年。`BrtWbProp` 的 flags 第 0 位携带 epoch，忽略它的 reader 会**整整
错 1462 天**——得到的是一个看起来合理的日期而不是一个错误，因此下游不会有任何察觉。

已声明的布局经这些工作簿确认：`BrtCellRk` 是 12 字节、`BrtCellIsst` 12 字节、
`BrtCellBlank` 8 字节，与表中所写完全一致。这次对照还找出了五十多个手工测试都没发现的四个假
阳性，而它们全是同一个错误——把 `.bin` 当成一种格式：

| 部件                                      | 它实际是什么                       |
| ----------------------------------------- | ---------------------------------- |
| `xl/vbaProject.bin`                       | 一个 OLE2 复合文档                 |
| `xl/printerSettings/printerSettings1.bin` | 一个 DEVMODE 结构                  |
| `xl/worksheets/binaryIndex1.bin`          | 是记录流，但不是工作表             |
| `xl/workbook.bin`                         | 由 `Default` 声明，而非 `Override` |

一个部件的身份来自它的 content type，因此验证器读的就是它。这些形状由
`utils/__tests__/xlsb-validator/real-world-shapes.test.ts` 钉住，采用合成包而非入库的第三方
二进制。同一批检查也会跑在真实文件上，来源是钉住的语料：`pnpm corpus:xlsb` 负责获取，
`real-world-corpus.node.test.ts` 负责读取。

最后这一点是本模块的整体立场：尚未确立的布局会被记录为尚未确立。猜测一个偏移会产生一个彼此一致、
却与 Excel 不一致的 reader 和 writer，而任何往返测试都检测不到，因为双方共享同一个错误。

## 流式 API

### 流式读取器

以最小的内存占用读取大型 XLSX 文件：

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

### 流式写入器

逐行写入大型 XLSX 文件：

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

`WorksheetWriter.commit()` 特意保持同步并返回 `void`；它无法等待浏览器压缩或慢速目标流。
异步完成由 `WorkbookWriter.commit()` 负责：它会提交尚未关闭的工作表、等待所有 ZIP push
完成，并在返回前处理目标流背压。建议让最后一个工作表保持打开，直接调用并等待
`workbook.commit()`。如果显式调用了 `sheet.commit()`，仍必须随后等待 `workbook.commit()`；
工作表调用本身只关闭输入，并不表示其字节已写入目标流。

### Web Streams（Node.js 22+ 和浏览器）

```typescript
import { Stream } from "documonster/excel";

// 写入 Web WritableStream
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

// 从 Web ReadableStream 读取
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

## 浏览器支持

### 与打包工具配合使用（Vite、Webpack、Rollup、esbuild）

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

### 与 Script 标签配合使用

excel 模块有自己的 IIFE 产物，挂在 `Documonster.Excel` 下——命名空间与 ESM 入口
完全一致，只是在共享全局下多一层。没有全家桶产物，因此文件名就写明了模块。

<!-- x-release-please-start-version -->

```html
<script src="https://unpkg.com/documonster@0.11.1/dist/iife/documonster.excel.iife.min.js"></script>
<script>
  const { Workbook, Cell } = Documonster.Excel;
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Sheet1");
  Cell.setValue(ws, "A1", "Hello, Browser!");
</script>
```

<!-- x-release-please-end -->

### 浏览器注意事项

- 使用 `Workbook.read(workbook, arrayBuffer)` 而非 `Workbook.readFile(...)`
- 使用 `Workbook.toBuffer(workbook)` 而非 `Workbook.writeFile(...)`
- 完全支持 PDF 导出
- 支持 CSV 和 Markdown 操作
- 带密码的工作表保护使用纯 JS SHA-512

## 类型

### 单元格寻址

每个 `Cell` 函数只接受两种形式——`"A1"` 地址，或 1-based 的 `(row, col)`：

```typescript
Cell.setValue(ws, "B3", 42);
Cell.setValue(ws, 3, 2, 42);
Cell.setFont(ws, 3, 2, { bold: true }); // facet 设置器同样支持两种形式
```

混用会直接编译报错，而不是静默读错单元格：`Cell.getValue(ws, "A1", 99)` 以前能编译，
实际读的是 `"CUA1"`；`Cell.getValue(ws, 5)` 以前能编译，运行时抛异常。两者现在都被拒绝。

### 按 key 定位列

`Column.*` 接受 key、列字母或 1-based 列号。`Column.getNumber` 把 key 桥接到
`(row, col)` 形式，`Worksheet.columnDefinitions` 则是 `Worksheet.setColumns` 的反函数：

```typescript
Worksheet.setColumns(ws, [{ header: "Total", key: "total", width: 12 }]);

const col = Column.getNumber(ws, "total"); // 1
Cell.setValue(ws, 2, col, 99);

// 追加一列并保留既有定义——不需要手抄字段。
Worksheet.setColumns(ws, [...Worksheet.columnDefinitions(ws), { header: "Error", key: "error" }]);
```

`Worksheet.columns(ws)` 交出的是活的、但**深只读**的 `ColumnView`——数组、列本身、以及
嵌套的 `style` 都不可赋值，因此列的修改一律走 `setColumns` / `Column.set*`，由它们维护列号、
key 注册表和单元格样式的一致性。

`Worksheet.columnCount(ws)` 测的是另一件事：行里实际存在的 cell 数；而 `columns` /
`columnDefinitions` 列出的是列**记录**——包括仅被声明的列，以及因某个 cell 被访问而被补齐
出来的列。两者不可互换。

### 用你自己的类型写行

行对象按列的 key 取值，所以任何对象都可以——普通 interface 无需 cast：

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
Worksheet.addRows(ws, invoices); // 按 key 从每个对象取值
```

### 单元格句柄

`Row.eachCell` / `Row.getCell` / `Worksheet.getRow` 交出 `CellData` 句柄。句柄本身可直接
读地址和样式，其余内容用 `Cell.view` 读、用 `Stream` 的句柄操作写（它们并非仅限流式）：

```typescript
Row.eachCell(ws, 1, cell => {
  const header = Cell.view(cell).text.trim();
  Stream.setCellFont(cell, { bold: true });
});
```

`Cell.find` 是句柄的第四个来源，也是唯一一个**不会创建**所查对象的读取方式：

```typescript
const cell = Cell.find(ws, "B7"); // CellData | undefined
const value = cell ? Cell.view(cell).value : null;
```

其余所有读取方式 —— `Cell.getValue`、`Cell.getFont` 等 —— 都通过 `getCell` 解析地址，
而它在行与单元格不存在时会把它们**创建出来**。写入时这正是你想要的，但这意味着读取稀疏
工作表中一个很远的单元格会留下一堆行，并改变 `Worksheet.rowCount`：

```typescript
Cell.getValue(ws, "A1000"); // 创建了 1000 行
Worksheet.rowCount(ws); // 1000

Cell.find(ws, "A1000"); // undefined；工作表未被改动
```

当问题是"这个单元格到底存不存在"时用 `find`。要在不创建任何东西的前提下读取整个区域，
用 `Range.getValues` / `Worksheet.toAoa`。

公开 API 涉及的每一个类型都以**声明处的名字**从 `documonster/excel` 导出——也就是
TypeScript 在报错和悬浮提示里显示的那个名字。没有别名要记，也不需要绕路：可以直接
标注变量、编写样式辅助函数、保存列定义。

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

// 样式值可以被声明，因此样式能够组合与复用。
const HEADER: Partial<Style> = {
  font: { bold: true, size: 11 },
  alignment: { vertical: "middle", horizontal: "center" },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } }
};
const THIN: Partial<Border> = { style: "thin", color: { argb: "FF000000" } };
const BOX: Partial<Borders> = { top: THIN, bottom: THIN, left: THIN, right: THIN };

export const mergeStyle = (base: Partial<Style>, ...rest: (Partial<Style> | undefined)[]) =>
  rest.reduce<Partial<Style>>((acc, s) => ({ ...acc, ...(s ?? {}) }), base);

// 供 `Worksheet.setColumns` 使用的列定义。
export const REPORT_COLUMNS: ColumnDefn[] = [
  { header: "Invoice", key: "invoiceId", width: 20, style: HEADER },
  { header: "Amount", key: "amount", width: 14, style: { numFmt: "#,##0.00" } }
];
```

句柄（API 交给你的不透明对象）通过所属命名空间上的 `Handle` 别名命名：

```typescript
import type { Workbook, Worksheet } from "documonster/excel";

const render = (ws: Worksheet.Handle) => {
  /* … */
};
const save = (wb: Workbook.Handle) => {
  /* … */
};
```

流式 API 的类型挂在 `Stream` 命名空间上，与流式类放在一起：

```typescript
import { Stream } from "documonster/excel";

const options: Stream.WorkbookWriterOptions = { filename: "big.xlsx", useSharedStrings: true };
const writer = new Stream.WorkbookWriter(options);
const sheet: Stream.WorksheetWriter = writer.addWorksheet("Data");
```

单元格值类型、公式类型、Excel 错误字符串以及常用纸张尺寸都是既可当值又可当类型的常量
对象，未使用时会被 tree-shaking 移除（TS `enum` 做不到这一点）：

```typescript
import { Cell, ErrorValue, PaperSize, ValueType } from "documonster/excel";
import type { CellErrorValue } from "documonster/excel";

if (Cell.getType(ws, "A1") === ValueType.Number) {
  /* … */
}
const na: CellErrorValue = { error: ErrorValue.NotApplicable };
ws.pageSetup.paperSize = PaperSize.A4;
```

一个类型只有一个公开名字，句柄也一样。凡是命名空间提供了 `Handle` 别名的
（`Worksheet.Handle`、`Workbook.Handle`、`Table.Handle`…），该别名就是公开名，底层的
`WorksheetData` / `WorkbookData` 等声明名**不再**在顶层重复导出。单元格、行、列句柄
没有这种别名，因此它们的声明名就是公开名：

```typescript
import type { CellData, ColumnData, RowData } from "documonster/excel";

const cellText = (cell: CellData) => cell.address;
const rowNumber = (row: RowData) => row.number;
const columnWidth = (column: ColumnData) => column.width;
```

## 工具导出

Documonster 以子路径入口点发布——不存在裸 `"documonster"` 导出。
请从拥有各符号的模块中分别导入。

```typescript
// Excel 领域错误——来自 documonster/excel
import { ExcelError, isExcelError, ImageError, TableError } from "documonster/excel";

// PDF 导出 + PDF 错误——来自 documonster/pdf
import { Pdf, PdfError, isPdfError } from "documonster/pdf";

// XML 辅助方法 + XML 错误——来自 documonster/xml
import { Xml, XmlError, isXmlError } from "documonster/xml";

// 编码/解码文本以安全嵌入 XML。
const encoded = Xml.encode("a & b < c"); // "a &amp; b &lt; c"
const decoded = Xml.decode(encoded); // "a & b < c"

// 将工作簿导出为 PDF。
const bytes = await Pdf.fromExcel(workbook);

// 错误继承自 BaseError，并支持 instanceof + 类型守卫。
try {
  await Workbook.readFile(workbook, "broken.xlsx");
} catch (err) {
  if (isExcelError(err)) {
    console.error("Excel error:", err.message);
  }
}
```

## 示例

参见[示例目录](examples/)，其中包含覆盖所有特性的可运行代码：

- 工作簿的创建、读取和复制
- 单元格样式、字体、边框、填充
- 公式、数据验证、条件格式
- 图片（JPEG、PNG）、超链接、批注
- 带自动筛选和汇总的表格
- 合并单元格、冻结窗格、页面设置
- 流式读取器和写入器
- Web Streams 集成
- PDF 导出
- 以及更多……
