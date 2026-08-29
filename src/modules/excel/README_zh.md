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

**对于生产级渲染**，请通过无头 LibreOffice（`soffice --convert-to pdf`）对 `.xlsx` 进行往返转换。本库的字节保留往返 + `templateMode: "strict"` 保证使得这一交接是安全的。

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
| 模板保真度       | 字节保留往返、用于狭窄编辑的原始 XML 修补、`templateMode: "strict"` 以拒绝静默丢失、`Chart.unknownElements` 浮现 `c15:` / `cx14:` 厂商标签                                                                                                                                                                                                                                                                                                                                                       |
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

```html
<script src="https://unpkg.com/documonster/dist/iife/documonster.iife.min.js"></script>
<script>
  const { Workbook } = Documonster;
  const wb = Workbook.create();
</script>
```

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
