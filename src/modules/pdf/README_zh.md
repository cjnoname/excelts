# PDF 模块

[English](README.md)

一个功能完备、零依赖、用纯 TypeScript 从零构建的 PDF 引擎。使用 `Pdf.create()` 或 `Pdf.fromExcel()` 桥接 **写入** PDF。使用 `Pdf.read()` **读取** 任意 PDF —— 从所有主流 PDF 版本中提取文本、图像和元数据。使用 `Pdf.Builder` **构建** 自由排版的 PDF —— 文本、矢量图形、SVG 路径、注释和表单字段。使用 `Pdf.Editor` **编辑** 已有 PDF —— 叠加内容、填写表单、添加/删除/旋转页面、合并文档以及数字签名。所有 API 均为异步,并在页面之间让出事件循环以避免阻塞。

```typescript
import { Pdf } from "documonster/pdf";

// 写入 —— 独立:           Pdf.create(rows)
// 写入 —— 来自 Excel:     await Pdf.fromExcel(workbook)
// 读取 —— 文本/图像/元数据: Pdf.read(bytes)
// 构建 —— 自由排版:        new Pdf.Builder()
// 编辑 —— 叠加/表单:       new Pdf.Editor() / Pdf.Editor.load(bytes)
// 签名 —— 数字签名:        Pdf.sign(...) / Pdf.verifySignature(...)
```

## 特性

### 写入

- **零依赖** —— 纯 TypeScript 生成 PDF,无任何外部库
- **PDF 2.0** —— 写入现代 PDF 2.0 格式
- **独立引擎** —— 通过 `Pdf.create()` 使用普通数组和对象,无需依赖 Excel
- **Excel 桥接** —— 一行 `Pdf.fromExcel(workbook)` 实现 Excel 到 PDF 的转换
- **跨平台** —— 在 Node.js 和浏览器中使用相同 API
- **完整样式** —— 字体、颜色、边框、填充、对齐、合并单元格
- **富文本** —— 单个单元格内混合多种格式,并支持自动换行
- **分页** —— 自动垂直/水平分页,并可重复表头
- **图像** —— 支持嵌入 JPEG 和 PNG,带 alpha 透明度
- **AES-256 加密** —— 使用 AES-256(V=5, R=5)进行密码保护并控制权限
- **字体嵌入** —— TrueType 字体子集化以支持 Unicode/CJK 文本
- **水印** —— 文本和图像水印,支持透明度、旋转、平铺以及按页/按表过滤
- **页面设置** —— 完整还原打印设置:纸张大小、方向、边距、打印区域、缩放、打印顺序、打印标题、行号列标、居中方式、单色、草稿、错误单元格
- **可摇树优化** —— 不导入即不进入打包产物
- **非阻塞** —— 在页面之间让出事件循环以避免阻塞

### 读取

- **通用读取器** —— 读取所有主流 PDF 版本(1.0 至 2.0)
- **文本提取** —— 完整文本,支持行重建、多列以及表格检测
- **多语言** —— WinAnsi、MacRoman、通过 ToUnicode CMap 的 CJK、Identity-H/V、Symbol、ZapfDingbats
- **图像提取** —— JPEG、JPEG2000、CCITT、JBIG2、raw/Flate,带 SMask/alpha
- **注释提取** —— 链接、批注、高亮、图章、自由文本等
- **表单字段** —— AcroForm 提取:文本输入框、复选框、单选按钮、下拉框、签名
- **书签提取** —— 嵌套大纲树,带命名/动作目标
- **表格提取** —— 基于文本片段定位的启发式表格检测
- **元数据** —— Info 字典 + XMP(标题、作者、日期、页数、页面尺寸)
- **所有加密格式** —— RC4-40、RC4-128、AES-128、AES-256(读取所有版本)
- **容错** —— 交叉引用表/流恢复、增量更新

### 构建(PdfDocumentBuilder)

- **自由文本定位** —— 在任意位置放置文本,带字体、字号、颜色、粗体/斜体
- **矢量图形** —— 矩形、圆形、椭圆、直线、任意路径,带填充/描边
- **SVG 路径渲染** —— 解析并渲染 SVG `d` 属性(包括弧线在内的所有命令)
- **图像** —— 在任意位置嵌入 JPEG 和 PNG
- **注释** —— 创建 Highlight、Underline、StrikeOut、Squiggly、Text(便签)、FreeText 和 Stamp 注释
- **创建表单字段** —— 从零创建 TextField、Checkbox、Dropdown 和 RadioGroup
- **书签** —— 嵌套大纲树,带页面目标
- **目录** —— 自动生成带点引导线、页码和可点击链接的目录
- **PDF/A-1b** —— 归档合规性,带 XMP 元数据、OutputIntent 和 sRGB ICC 配置文件
- **AES-256 加密** —— 为构建器创建的 PDF 设置密码保护
- **字体嵌入** —— TrueType 字体子集化以支持 Unicode/CJK 文本

### 编辑(PdfEditor)

- **叠加内容** —— 在已有 PDF 页面上绘制文本、图形、图像
- **在已有页面上添加注释** —— 向已有 PDF 添加 Highlight、Text、FreeText、Stamp 等
- **在已有页面上添加表单字段** —— 向已有 PDF 添加 TextField、Checkbox、Dropdown
- **在已有页面上绘制 SVG 路径** —— 在已有 PDF 页面上绘制 SVG 路径
- **填写表单** —— 设置文本字段值和复选框状态
- **添加页面** —— 追加带内容的新空白页
- **删除页面** —— 按索引删除页面
- **旋转页面** —— 按 90/180/270 度旋转页面
- **拆分页面** —— 将一个 PDF 拆分为多个单页 PDF
- **合并/复制页面** —— 从其他 PDF 复制页面(包括加密来源)
- **增量保存** —— 仅追加更新,保留原始字节(对已签名 PDF 安全)
- **完整保存** —— 重建整个 PDF 并应用所有修改
- **元数据保留** —— 保留 XMP、页面属性(Rotate、CropBox 等)

### 数字签名

- **签名验证** —— 验证 RSA PKCS#1 v1.5 + SHA-256 签名,并完整解析 PKCS#7/CMS
- **签名创建** —— 创建 CMS SignedData 签名,带 ByteRange 占位符/回填
- **ASN.1 DER 编解码** —— 解析和编码 ASN.1 结构(由验证和签名共享)
- **X.509 证书** —— 从 DER 编码的证书中提取公钥
- **平台原生加密** —— 在 Node.js 上使用 `node:crypto`,在浏览器中使用 Web Crypto API

---

## 快速上手

### 读取 PDF

```typescript
import { Pdf } from "documonster/pdf";
import { readFileSync } from "fs";

const bytes = readFileSync("document.pdf");
const result = await Pdf.read(bytes);

// 全部文本
console.log(result.text);

// 逐页文本
for (const page of result.pages) {
  console.log(`Page ${page.pageNumber}: ${page.text.length} chars`);
}

// 元数据
console.log(result.metadata.title);
console.log(result.metadata.author);
console.log(result.metadata.pageCount);

// 图像
for (const page of result.pages) {
  for (const img of page.images) {
    console.log(img.format, img.width, img.height);
  }
}

// 注释(链接、批注、高亮)
for (const page of result.pages) {
  for (const annot of page.annotations) {
    console.log(annot.subtype, annot.contents, annot.uri);
  }
}

// 表单字段
for (const field of result.formFields) {
  console.log(field.name, field.type, field.value);
}

// 书签(文档大纲)
for (const bm of result.bookmarks) {
  console.log(bm.title, bm.pageIndex);
}
```

### 读取加密 PDF

```typescript
const result = await Pdf.read(bytes, { password: "secret" });
```

### 选择性提取

```typescript
// 仅第 1 页和第 3 页,仅文本(不含图像)
const result = await Pdf.read(bytes, {
  pages: [1, 3],
  extractImages: false
});

// 提取书签(大纲树)
const result = await Pdf.read(bytes, { extractBookmarks: true });
for (const bm of result.bookmarks) {
  console.log(bm.title, `→ page ${bm.pageIndex + 1}`);
}

// 提取表格(基于文本位置的启发式检测)
const result = await Pdf.read(bytes, { extractTables: true });
for (const page of result.pages) {
  for (const table of page.tables) {
    for (const row of table.rows) {
      console.log(row.cells.map(c => c.text).join(" | "));
    }
  }
}
```

### Excel 转 PDF(桥接 API)

从 Excel 工作簿生成 PDF 的最简单方式:

```typescript
import { Workbook, Worksheet, Column } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Sales");
Worksheet.setColumns(sheet, [
  { header: "Product", key: "product", width: 20 },
  { header: "Revenue", key: "revenue", width: 15 }
]);
Worksheet.addRow(sheet, { product: "Widget", revenue: 1000 });
Worksheet.addRow(sheet, { product: "Gadget", revenue: 2500 });
Column.setStyle(sheet, "revenue", { numFmt: "$#,##0.00" });

const pdf = await Pdf.fromExcel(workbook);

// Node.js
import { writeFileSync } from "fs";
writeFileSync("output.pdf", pdf);

// 浏览器
const blob = new Blob([pdf], { type: "application/pdf" });
const url = URL.createObjectURL(blob);
window.open(url);
```

### 读取 XLSX 并导出 PDF

```typescript
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const workbook = Workbook.create();
await Workbook.readFile(workbook, "report.xlsx");

const pdf = await Pdf.fromExcel(workbook, {
  showGridLines: true,
  showPageNumbers: true,
  title: "Monthly Report"
});
```

### 独立 PDF(无需 Excel)

从普通数据生成 PDF —— 无需 Excel 模块、无需 Map 对象、无需样板代码:

```typescript
import { Pdf } from "documonster/pdf";

// 最简单 —— 传入二维数组
const bytes = await Pdf.create([
  ["Product", "Revenue"],
  ["Widget", 1000],
  ["Gadget", 2500]
]);

// 带选项
const bytes = await Pdf.create(
  [
    ["Name", "Score"],
    ["Alice", 95],
    ["Bob", 87]
  ],
  { showGridLines: true, title: "Scores" }
);

// 多个工作表
const bytes = await Pdf.create({
  sheets: [
    {
      name: "Sales",
      data: [
        ["Product", "Revenue"],
        ["Widget", 1000]
      ]
    },
    {
      name: "Costs",
      data: [
        ["Item", "Amount"],
        ["Rent", 500]
      ]
    }
  ]
});

// 列宽 + 带样式的单元格
const bytes = await Pdf.create({
  name: "Report",
  columns: [{ width: 25 }, { width: 15 }],
  data: [
    [
      { value: "Product", bold: true },
      { value: "Revenue", bold: true }
    ],
    ["Widget", 1000],
    ["Gadget", 2500]
  ]
});
```

### 水印

为任何通过 `Pdf.create()` 或 `Pdf.fromExcel()` 生成的 PDF 添加文本或图像水印:

```text
// 文本水印 —— 居中、半透明、旋转
const bytes = await Pdf.create(data, {
  watermark: {
    type: "text",
    text: "CONFIDENTIAL",
    fontSize: 48,
    color: { r: 0.8, g: 0.8, b: 0.8 },
    opacity: 0.3,
    rotation: -45,
    position: "center"
  }
});

// 图像水印 —— 在每一页平铺
const bytes = await Pdf.fromExcel(workbook, {
  watermark: {
    type: "image",
    data: logoPngBytes,
    format: "png",
    width: 100,
    height: 50,
    opacity: 0.1,
    repeat: true,
    repeatSpacingX: 150,
    repeatSpacingY: 100
  }
});

// 仅在指定页面或工作表上添加水印
const bytes = await Pdf.create(data, {
  watermark: {
    type: "text",
    text: "DRAFT",
    fontSize: 60,
    color: { r: 1, g: 0, b: 0 },
    opacity: 0.2,
    pages: [1], // 仅第一页
    sheets: ["Summary"] // 仅 "Summary" 工作表
  }
});
```

### 构建自由排版的 PDF(PdfDocumentBuilder)

创建对文本、图形和布局拥有精确控制的 PDF:

```text
const doc: Pdf.Builder;
doc.setMetadata({ title: "My Report", author: "documonster" });

const page = doc.addPage({ width: 595, height: 842 }); // A4

// 可先 addPage(),但字体配置必须早于第一次 drawText()。
doc.embedFont(fontFileBytes);

// 文本
page.drawText("Hello, World!", { x: 72, y: 770, fontSize: 24, bold: true });

// 图形
page.drawRect({ x: 72, y: 700, width: 200, height: 50, fill: { r: 0.2, g: 0.4, b: 0.8 } });
page.drawCircle({ cx: 400, cy: 725, r: 25, fill: { r: 1, g: 0, b: 0 } });

// SVG 路径
page.drawSvgPath("M 100 600 C 150 500 250 500 300 600", {
  stroke: { r: 0, g: 0.5, b: 0 },
  lineWidth: 2
});

// 注释
page.addAnnotation({
  type: "Highlight",
  rect: [72, 765, 250, 785],
  color: { r: 1, g: 1, b: 0 }
});

// 表单字段
page.addFormField({
  type: "text",
  name: "email",
  rect: [72, 550, 300, 575]
});

// 加密
doc.setEncryption({ ownerPassword: "admin", userPassword: "reader" });

const bytes = await doc.build();
```

### 编辑已有 PDF(PdfEditor)

叠加内容、填写表单、合并文档以及操作页面:

```typescript
import { Pdf } from "documonster/pdf";

const editor = Pdf.Editor.load(existingPdfBytes);

// 在第 1 页叠加文本和图形
const page = editor.getPage(0);
page.drawText("CONFIDENTIAL", { x: 200, y: 400, fontSize: 36, color: { r: 1, g: 0, b: 0 } });

// 向已有页面添加注释
page.addAnnotation({ type: "Highlight", rect: [72, 700, 300, 720] });

// 向已有页面添加表单字段
page.addFormField({ type: "text", name: "note", rect: [72, 650, 300, 675] });

// 在已有页面上绘制 SVG 路径
page.drawSvgPath("M 100 600 L 200 600 L 150 550 Z", { fill: { r: 0, g: 0.5, b: 1 } });

// 填写表单字段
editor.setFormField("name", "Jane Doe");
editor.setFormField("agree", "Yes");

// 页面操作
editor.removePage(2); // 删除第 3 页
editor.rotatePage(0, 90); // 旋转第 1 页
editor.addPage(); // 添加空白页

// 从另一个 PDF 复制页面
editor.copyPagesFrom(otherPdfBytes);

// 保存(完整重建或增量追加)
const result = await editor.save();
const incremental = await editor.saveIncremental(); // 保留原始字节
```

### 数字签名

```typescript
import { Pdf } from "documonster/pdf";

// 验证签名
const result = await Pdf.verifySignature(pdfBytes, signatureHex, byteRange);
console.log(result.valid, result.coversWholeFile);

// 签名一个 PDF(需要 DER 编码的证书 + PKCS#8 私钥)
const signed = await Pdf.sign(pdfWithPlaceholder, certificate, privateKey);
```

---

## 架构

PDF 模块分为四层:

```
src/modules/pdf/
├── core/               # PDF 基元(对象、流、写入器、加密、数字签名)
├── font/               # TTF 解析、字形度量、字体子集化、嵌入
├── render/             # 布局引擎、页面渲染器、样式转换器
│   ├── layout-engine   — PdfSheetData → LayoutPage[] (零 @excel 导入)
│   ├── page-renderer   — LayoutPage → PDF 内容流(零 @excel 导入)
│   ├── style-converter — PdfCellStyle → PDF 渲染参数(零 @excel 导入)
│   ├── png-decoder     — 用于 PDF 嵌入的 PNG 图像解码(零 @excel 导入)
│   └── pdf-exporter    — PdfWorkbook → Uint8Array(零 @excel 导入)
├── builder/            # 自由排版的 PDF 创建与编辑
│   ├── document-builder — PdfDocumentBuilder + PdfPageBuilder(文本、图形、SVG、注释、表单)
│   ├── pdf-editor      — PdfEditor + PdfEditorPage(叠加、合并、拆分、签名)
│   ├── form-appearance — 表单字段外观流生成
│   ├── resource-merger — 用于叠加的资源字典合并
│   └── image-utils     — 共享的图像 XObject 写入
├── reader/             # PDF 读取器 —— 分词器、解析器、解密、文本/图像提取
│   ├── pdf-tokenizer   — 字节级 PDF 分词
│   ├── pdf-parser      — 对象、xref 表/流、trailer
│   ├── pdf-document    — 文档结构、页面树、对象解析
│   ├── pdf-decrypt     — 适用于所有 PDF 加密版本的 RC4/AES 解密
│   ├── stream-filters  — Flate、ASCII85、ASCIIHex、LZW、RunLength 解码器
│   ├── cmap-parser     — 带可变长度 codespace 的 ToUnicode CMap 解析
│   ├── font-decoder    — Type1、TrueType、Type0/CID、Symbol、ZapfDingbats
│   ├── content-interpreter — BT/ET、Tj/TJ、Tm/Td、Form XObject、内联图像
│   ├── text-reconstruction — 行构建、表格/多列检测、RTL
│   ├── image-extractor — JPEG、JPEG2000、CCITT、JBIG2、raw、SMask
│   ├── annotation-extractor — Link、Text、Highlight、FreeText、Stamp 等
│   ├── form-extractor  — AcroForm:文本、复选框、单选、下拉、列表框、签名
│   ├── bookmark-extractor — 嵌套大纲树提取
│   ├── table-extractor — 基于文本位置的启发式表格检测
│   ├── metadata-reader — Info 字典 + XMP 元数据
│   ├── reader-utils    — 共享的读取器工具函数
│   └── pdf-reader      — 公共 API:Pdf.read()
├── types.ts            # PdfWorkbook、PdfSheetData、PdfCellData 等
├── excel-bridge.ts     # Excel Workbook → PdfWorkbook 转换(唯一的 @excel 依赖)
└── index.ts
```

整个 PDF 引擎(core、font、render、reader)**零导入 Excel 模块**。`excel-bridge.ts` 是唯一了解 Excel 的文件 —— 它将 `Workbook` 转换为 `PdfWorkbook`。

**写入策略:** 仅写入 PDF 2.0(现代、AES-256)。
**读取策略:** 读取所有主流 PDF 版本(1.0 至 2.0,所有加密类型)。

---

## 写入选项

`Pdf.create()` 接受 `PdfExportOptions`。`Pdf.fromExcel()` 接受
`ExcelToPdfOptions`,它继承相同的写入选项,并额外提供类型严格的可选公式重算回调:

```typescript
import { calculateFormulas } from "documonster/excel/formula";
import { Pdf, type ExcelToPdfOptions } from "documonster/pdf";

const options: ExcelToPdfOptions = {
  recalculate: calculateFormulas,
  fitToPage: true
};
const bytes = await Pdf.fromExcel(workbook, options);
```

不传 `recalculate` 时使用 workbook 现有的公式缓存结果。回调保持独立,可避免未主动
使用重算功能的 bundle 引入公式引擎。

```typescript
interface PdfExportOptions {
  // 页面布局
  pageSize?: PageSizeName | PdfPageSize; // "A4"、"LETTER"、"A3" 等,或 { width, height }
  orientation?: "portrait" | "landscape";
  margins?: Partial<PdfMargins>; // { top, right, bottom, left },单位为点(72pt = 1in)
  horizontalCentered?: boolean; // 水平居中(默认:取工作表 pageSetup)
  verticalCentered?: boolean; // 垂直居中(默认:取工作表 pageSetup)
  pageOrder?: "downThenOver" | "overThenDown"; // 多页遍历顺序(默认:取工作表 pageSetup,否则 "downThenOver")

  // 缩放 —— 见下文"缩放"。
  fitToPage?: boolean; // 无其他缩放意图时缩到一页宽(默认:true)
  scale?: number; // 显式缩放因子 0.1–4.0(对应 Excel 10–400%;可放大)
  fitToWidth?: number; // 最多缩到 N 页宽;0 表示不限制
  fitToHeight?: number; // 最多缩到 M 页高;0 表示不限制

  // 内容
  showGridLines?: boolean; // 渲染单元格网格线
  gridLineColor?: string; // 网格线的 ARGB 颜色(例如 "FF3366CC")
  showRowColHeaders?: boolean; // 打印行号与列标(默认:取工作表 pageSetup)
  repeatRows?: number | false; // 每页重复的表头行数(默认:取工作表 printTitlesRow)
  repeatCols?: number | false; // 每页重复的左侧列数(默认:取工作表 printTitlesColumn)
  blackAndWhite?: boolean; // 矢量内容转灰度(默认:取工作表 pageSetup)
  draft?: boolean; // 省略图片与图表(默认:取工作表 pageSetup)
  errors?: "displayed" | "blank" | "dash" | "NA"; // 错误单元格的打印方式(默认:取工作表 pageSetup)
  cellComments?: "none" | "atEnd" | "asDisplayed"; // 批注打印方式(默认:取工作表 pageSetup)
  sheets?: (string | number)[]; // 按名称或 1 基索引选择特定工作表
  ignorePrintArea?: boolean; // 导出整个已用区域,忽略每个工作表的打印区域(默认:false)

  // 页眉与页脚
  showSheetNames?: boolean; // 在每页顶部显示工作表名称
  showPageNumbers?: boolean; // 在每页底部显示 "Page X of Y"

  // 元数据
  title?: string;
  author?: string;
  subject?: string;
  creator?: string; // PDF producer 字符串(默认:"documonster")

  // 字体
  font?: Uint8Array; // 旧版单 TrueType 字体快捷选项
  fonts?: PdfFontConfig; // 命名字体族、样式 face、TTC 选择和 fallback
  defaultFontFamily?: string; // 后备字体族(默认:"Helvetica")
  defaultFontSize?: number; // 后备字号(默认:11)

  // 加密(AES-256, PDF 2.0)
  encryption?: {
    ownerPassword: string; // 所有者密码(必填)
    userPassword?: string; // 用户打开密码(可选)
    permissions?: {
      print?: boolean; // 允许打印
      modify?: boolean; // 允许修改
      copy?: boolean; // 允许复制/粘贴
      annotate?: boolean; // 允许注释
      fillForms?: boolean; // 允许填写表单
      accessibility?: boolean; // 允许无障碍提取
      assemble?: boolean; // 允许文档组装
      printHighQuality?: boolean; // 允许高质量打印
    };
  };
}
```

## 读取选项

```typescript
interface ReadPdfOptions {
  password?: string; // 加密 PDF 的密码(用户或所有者)
  pages?: number[]; // 要提取哪些页面(1 基)。省略则提取所有页面
  extractText?: boolean; // 提取文本(默认:true)
  extractImages?: boolean; // 提取图像(默认:true)
  extractMetadata?: boolean; // 提取元数据(默认:true)
  extractAnnotations?: boolean; // 提取注释(默认:true)
  extractFormFields?: boolean; // 提取表单字段(默认:true)
  extractBookmarks?: boolean; // 提取书签/大纲(默认:true)
  extractTables?: boolean; // 通过启发式提取表格(默认:false)
}
```

### 读取结果

```typescript
interface ReadPdfResult {
  text: string; // 所有页面的全部文本
  pages: ReadPdfPage[]; // 逐页结果
  metadata: PdfMetadata; // 文档元数据
  formFields: PdfFormField[]; // 表单字段(文档级)
  bookmarks: PdfBookmark[]; // 文档大纲 / 目录
}

interface ReadPdfPage {
  pageNumber: number; // 1 基
  text: string; // 页面文本
  textLines: TextLine[]; // 带位置的结构化行
  textFragments: TextFragment[]; // 带精确坐标的原始片段
  images: ExtractedImage[]; // 提取的图像
  annotations: PdfAnnotation[]; // 注释(链接、批注、高亮)
  width: number; // 页宽,单位为点
  height: number; // 页高,单位为点
  warnings: string[]; // 非致命的提取警告
}

interface PdfAnnotation {
  subtype: string; // "Link"、"Text"、"Highlight"、"FreeText"、"Stamp" 等
  rect: PdfRect; // 边界矩形 { x1, y1, x2, y2 }
  contents: string; // 文本内容
  author: string; // 作者 / 标题
  uri: string; // 对于 Link:目标 URI
  destination: string; // 对于 Link:命名目标
  color: number[]; // 颜色数组 [r, g, b],范围 [0,1]
  flags: number; // 注释标志
}

interface PdfFormField {
  name: string; // 完全限定名称(例如 "form.address.city")
  type: PdfFormFieldType; // "text" | "checkbox" | "radio" | "dropdown" | "listbox" | "button" | "signature"
  value: string; // 当前值
  defaultValue: string; // 默认值
  readOnly: boolean; // 只读标志
  required: boolean; // 必填标志
  options: string[]; // 对于选择字段:可用选项
  exportValue: string; // 对于复选框:选中时的导出值
}

interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  pdfVersion: string;
  pageCount: number;
  encrypted: boolean;
}
```

### 页面尺寸

通过 `Pdf.PageSizes` 可访问的内置页面尺寸:

| 名称        | 尺寸(pt)         | 毫米      |
| ----------- | ---------------- | --------- |
| `"LETTER"`  | 612 x 792        | 216 x 279 |
| `"LEGAL"`   | 612 x 1008       | 216 x 356 |
| `"TABLOID"` | 792 x 1224       | 279 x 432 |
| `"A3"`      | 841.89 x 1190.55 | 297 x 420 |
| `"A4"`      | 595.28 x 841.89  | 210 x 297 |
| `"A5"`      | 419.53 x 595.28  | 148 x 210 |

自定义尺寸:`{ width: 396, height: 612 }`(单位为点,72pt = 1 英寸)。

---

## 样式支持

PDF 写入器渲染所有标准单元格样式:

### 文本

- 字体族、字号、粗体、斜体
- 字体颜色(ARGB、带 tint 的主题色)
- 下划线和删除线
- 富文本(每个单元格混合多种格式)
- 通过 `numFmt` 进行数字/日期/货币格式化
- 超链接(可点击注释)

### 对齐

- 水平:左、中、右
- 垂直:上、中、下
- 带断词的文本换行
- 文本缩进
- 文本旋转(倾斜和垂直堆叠)

### 单元格

- 背景填充(带 alpha 透明度的纯色)
- 边框:细、中、粗、虚线、点线(带颜色)
- 合并单元格(水平和垂直跨度)

---

## 分页

### 自动

- 行超出页高:自动垂直分页
- 列超出页宽:自动水平分页
- 比页面更窄或更矮的内容从左上边距开始 —— 与 Excel 一致

### 缩放

Excel 有两种互斥的缩放模式,两者都已支持:

| Excel 页面设置           | 工作表字段                                      | 导出选项                     |
| ------------------------ | ----------------------------------------------- | ---------------------------- |
| **缩放比例 N %**         | `scale`、`fitToPage: false`                     | `scale`(0.1–4.0 的倍数)      |
| **调整为 N 页宽 M 页高** | `fitToWidth` / `fitToHeight`、`fitToPage: true` | `fitToWidth` / `fitToHeight` |

```typescript
// 显式指定
await Pdf.fromExcel(workbook, { fitToWidth: 1, fitToHeight: 0 });
await Pdf.fromExcel(workbook, { scale: 0.8 });

// 或交由工作表决定
worksheet.pageSetup.fitToPage = true;
worksheet.pageSetup.fitToWidth = 1;
```

与 Excel 一致,**`fitToWidth` / `fitToHeight` 只缩小、不放大**:小于目标的表格按实际
大小打印。`scale` 不同 —— 它是纯乘数,**可以放大**(Excel 允许 10–400%)。

`fitToPage`(默认 `true`)是 documonster 自己的兜底 —— "缩到一页宽" —— 仅在调用方
与工作表都没有表达缩放意图时生效,因此设了 80% 的工作表不会被二次缩小。注意 `scale`
不会关闭它:`{ scale: 2 }` 仍会限制在一页宽,结果为 `min(scale, 内容区宽 / 表格宽)`。
需要纯乘数请同时传 `fitToPage: false`。

两个 fit 约束都通过二分法针对真实分页器求解,因此不可拆分的行列、手动分页符和重复
标题带都被计入 —— 仅按总面积求比例会缩得不够(三列各占页宽 60%,按面积是"1.8 页",
实际仍需三页)。

> **页数目标是在 Excel 缩放范围内的尽力而为。** 缩放止于 Excel 的 10% 下限,若目标在
> 该下限也无法达成(例如手动分页符本身就强制超过 N 页),结果会超过 N 页,而不是把表格
> 缩到无法阅读。
>
> 行高只在未缩放时测量一次,二分时按线性缩放。这对**所有**单元格都是精确的,包括换行
> 单元格:换行计算会同步缩放列宽、内边距与字号,因此换行行数不随打印缩放变化。

### 重复表头行与列

```typescript
await Pdf.fromExcel(workbook, { repeatRows: 2, repeatCols: 1 });
```

或通过工作表的页面设置:

```typescript
worksheet.pageSetup.printTitlesRow = "1:2"; // 每页重复第 1-2 行
worksheet.pageSetup.printTitlesColumn = "A"; // 每页重复 A 列
```

显式传 `false` 可抑制工作表的打印标题。

打印标题是**绝对**的,与打印区域无关(与 Excel 一致):打印 `E1:T3` 的工作表仍会在每页
左侧重复 `A:B`。若标题带**位于打印范围内部**,它仍会在第一页之后的每页重复,只是不会被
提到最左侧 —— 那样会打乱第一页的列序。

### 页顺序

对应 Excel 的**页面设置 → 工作表 → 打印顺序**,用于同时纵横分页的工作表。默认与
Excel 相同,为 `downThenOver`:先自上而下打完一个列带,再向右移动。

```typescript
await Pdf.fromExcel(workbook, { pageOrder: "overThenDown" });
```

### 行号与列标

对应 Excel 的**工作表 → 行号列标**。标题带保持固定字号,不随打印缩放变化,
因此在缩小的输出上依然清晰。

```typescript
await Pdf.fromExcel(workbook, { showRowColHeaders: true });
worksheet.pageSetup.showRowColHeaders = true; // 或通过工作表设置
```

### 单色、草稿与错误单元格

```typescript
await Pdf.fromExcel(workbook, {
  blackAndWhite: true, // 矢量内容转灰度(见下方说明)
  draft: true, // 省略图片与图表
  errors: "dash" // 打印 "--" 而不是 #DIV/0! 等
});
```

`blackAndWhite` 按亮度转换为灰度,保留相对明暗(即对比度),而不是一律压成黑色,
并保留不透明度。

矢量内容 —— 单元格文本、填充与边框、网格线、标题带、图表矢量、`&K` 着色的页眉页脚 run、
文本水印 —— 的颜色在布局阶段就已转换。

**光栅内容同样会被转换**,是逐像素转换而非叠加覆盖:

- **PNG** 在嵌入时本来就已解码,因此其 RGB 采样会合并为单个 `/DeviceGray` 亮度分量。
  Alpha 存放在独立的 `SMask` 中,不受影响,透明区域仍保持透明。
- **JPEG** 保留其 `DCTDecode` 数据(无需解码器),通过
  `[/DeviceN [...] /DeviceGray <luma>]` 色彩空间重新解释,其 tint transform 即
  Rec. 601 亮度公式。

看似便捷的 `/BM /Saturation` 叠加层**刻意没有采用**:其源色是不透明黑色,在透明 PNG
区域会直接涂黑而不是起滤镜作用。

`draft` 省略图片与图表。图表工作表仍会输出其页面(空白),因此页码不受影响 —— 与 Excel 一致。

`errors` 接受 `"displayed"`(默认)、`"blank"`、`"dash"` 和 `"NA"`,对纯错误单元格
和结果为错误的公式同样生效。

### 单元格批注

对应 Excel 的**工作表 → 注释和批注**。默认关闭;Excel 的两种模式都已支持:

```typescript
// 在工作表页面之后追加批注清单,每条标注其所属单元格
await Pdf.fromExcel(workbook, { cellComments: "atEnd" });

// 在工作表上的实际位置绘制批注框,并带 Excel 的红色角标
await Pdf.fromExcel(workbook, { cellComments: "asDisplayed" });

worksheet.pageSetup.cellComments = "atEnd"; // 或通过工作表设置
```

经典批注与线程批注都包含。`asDisplayed` 会解码批注的 VML anchor 来定位批注框;若批注
没有 anchor,则回退到 Excel 相对单元格的默认偏移。anchor 落在当前页之外的批注框会被
跳过,而不是从页缝处切开。

### 页面居中

对应 Excel 的**页面设置 → 页边距 → 居中方式**。默认关闭,因此窄表保持贴靠左/上边距:

```typescript
await Pdf.fromExcel(workbook, { horizontalCentered: true, verticalCentered: true });
```

或通过工作表的页面设置(对应 XLSX 中的 `<printOptions horizontalCentered="1"/>`):

```typescript
worksheet.pageSetup.horizontalCentered = true;
worksheet.pageSetup.verticalCentered = true;
```

显式导出选项始终优先于工作表设置;选项按工作表逐个解析,因此同一工作簿内各表可以不同。

### 手动分页

```typescript
import { Column, Row } from "documonster/excel";

Row.addPageBreak(worksheet, 20); // 第 2 页从第 21 行开始
Column.addPageBreak(worksheet, "F"); // 下一页从 G 列开始
```

分页符贯穿整个工作表的宽度或高度 —— 这是 Excel 唯一能创建、也是本导出器唯一会渲染的
形式。

### 打印区域

```typescript
worksheet.pageSetup.printArea = "A1:F50"; // 仅导出此区域
```

> **注意:** 如果设置了多范围打印区域(例如 `"A1:B5&&D1:E10"`),PDF 导出仅使用第一个范围。

要导出整个已用区域并忽略任何打印区域(且不修改工作簿),传入 `ignorePrintArea`:

```typescript
await Pdf.fromExcel(workbook, { ignorePrintArea: true });
```

---

## 图像

当工作表包含图像时,会嵌入 JPEG 和 PNG 图像:

```typescript
import { Workbook, Image } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const imageId = Image.add(workbook, {
  buffer: jpegBytes,
  extension: "jpeg"
});

Image.place(worksheet, imageId, {
  tl: { col: 0, row: 0 },
  ext: { width: 200, height: 150 }
});

const pdf = await Pdf.fromExcel(workbook);
// 图像出现在 PDF 中指定的位置
```

PNG 透明度(RGBA 和 tRNS)通过 PDF 软掩码得以保留。

---

## 加密

写入器生成 **AES-256 加密的 PDF**(PDF 2.0, V=5, R=5)。读取器可解密 **所有主流加密格式**,包括传统的 RC4。

### 写入器加密(AES-256)

#### 仅所有者(无打开密码)

```typescript
const pdf = await Pdf.fromExcel(workbook, {
  encryption: {
    ownerPassword: "admin",
    permissions: { print: true, copy: false, modify: false }
  }
});
// 无需密码即可打开,但复制/修改受限
```

#### 需要打开密码

```typescript
const pdf = await Pdf.fromExcel(workbook, {
  encryption: {
    ownerPassword: "admin",
    userPassword: "reader"
  }
});
// 需要 "reader" 才能打开
```

### 读取器解密(所有格式)

读取器自动检测并解密:

| 格式    | 版本       | 支持 |
| ------- | ---------- | ---- |
| RC4-40  | V=1, R=2   | 读取 |
| RC4-128 | V=2, R=3   | 读取 |
| AES-128 | V=4, R=4   | 读取 |
| AES-256 | V=5, R=5/6 | 读取 |

```typescript
// 自动检测加密类型
const result = await Pdf.read(encryptedBytes, { password: "secret" });
```

---

## 字体配置

标准 Type1 字体(Helvetica、Times、Courier)仅覆盖有限字符集。使用 `PdfFontConfig` 嵌入 TrueType 字体族,以支持 Unicode 文本、样式 face 和确定性的 fallback:

```typescript
import { readFileSync } from "node:fs";
import type { PdfFontConfig, PdfFontSource } from "documonster/pdf";

const notoCjk: PdfFontSource = {
  data: readFileSync("NotoSansCJK.ttc"),
  collectionIndex: 2 // TTC 中从 0 开始的 face 索引;默认为 0
};

const fonts: PdfFontConfig = {
  // 请求的字体族名或别名均不匹配时使用 default。regular 必填;
  // 缺少 bold/italic/boldItalic 时回退到该字体族的 regular face。
  default: {
    regular: readFileSync("NotoSans-Regular.ttf"),
    bold: readFileSync("NotoSans-Bold.ttf"),
    italic: readFileSync("NotoSans-Italic.ttf"),
    boldItalic: readFileSync("NotoSans-BoldItalic.ttf")
  },
  families: [
    {
      name: "Noto Sans CJK SC",
      aliases: ["Microsoft YaHei", "SimSun"],
      faces: { regular: notoCjk }
    }
  ],
  // 按顺序填写 families 中的 name 或 alias。只有列出的字体族参与缺字
  // fallback;最后再尝试 default。
  fallbackFamilies: ["Noto Sans CJK SC"]
};
```

字体族名和别名按不区分大小写的方式匹配。Fallback 按 Unicode grapheme cluster 为单位选择单个 face,不会把同一个 grapheme 拆到多个字体中。输出只嵌入实际用到的序列子集。

所有写入桥接和 Builder 都接受同一配置:

```typescript
// 独立数据或 Excel 工作簿
const tablePdf = await Pdf.create(rows, { fonts });
const workbookPdf = await Pdf.fromExcel(workbook, { fonts });

// Word 文档;同一字体配置同时用于布局测量和 PDF 渲染
const wordPdf = await Pdf.fromDocx(docxDocument, { fonts });

// 独立 Excel 图表;字体用于可选择的矢量图表文本
const chartPdf = await Pdf.fromChart(chart, { fonts }); // chartToPdf 桥接

// Builder:在构造函数中配置,或调用 embedFonts()。
const builder = new Pdf.Builder({ fonts });
const page = builder.addPage();
page.drawText("报告", { x: 72, y: 760, fontFamily: "Noto Sans CJK SC" });
```

`Pdf.create()` 和 `Pdf.fromExcel()` 仍支持 `font?: Uint8Array`,作为旧版单字体快捷选项;它相当于仅配置一个默认 regular face,不能与 `fonts` 同时使用。`Builder.embedFont(bytes)` 是对应的兼容方法,并会替换 Builder 之前的字体配置。`embedFont()` 和 `embedFonts()` 必须在所有页面的首个文本命令之前调用。可以先调用 `addPage()`,前提是尚未绘制文本。

如果所有已配置 face 都缺少某字符,PDF 会显示该 face 的 `.notdef` 字形,但 ToUnicode 仍保留原始 Unicode 序列,供复制、搜索、无障碍和文本提取使用。每个嵌入 face 在单个 PDF 中最多编码 65,535 个不同 Unicode 序列。

由于这种降级只体现在视觉上,请通过 `onWarning` 检测。所有 bridge 和 builder 都接受
该回调,它会报告未被覆盖的码点,便于补一个 fallback 字体族:

```typescript
await Pdf.fromExcel(workbook, {
  fonts,
  onWarning: message => console.warn(message)
});
```

### 系统字体自动发现

在 Node 环境下,若文档含有 WinAnsi 无法编码的字符(最典型的就是中文),且既未提供 `font` 也未提供 `fonts`,则会尽力扫描宿主机的字体目录,找一个 face 来为这些字符借用字形。拉丁文本仍使用标准 14 字体,因此粗体与斜体不会丢失。浏览器环境不扫描;显式提供字体时也不扫描。

扫描优先选择平台自带的中文字体,并把 Arial Unicode MS 这类广覆盖字体视为最后兜底:它一个文件几乎覆盖所有文字系统,但其中文字形字面偏小,观感明显差于任何系统中文字体。TTC 集合会逐 face 搜索,因为同一个 `.ttc` 内各 face 的覆盖范围与地区排版惯例并不相同——macOS `Songti.ttc` 的 face 0 只有 8,535 个字形,face 1 有 43,033 个。

`preferSystemFonts` 用于按顺序指定你想要的字体族:

```typescript
// 简体中文标点惯例;同一个 .ttc 内的繁体 face 名为 "Heiti TC"。
await Pdf.fromExcel(workbook, { preferSystemFonts: ["Heiti SC", "Songti SC"] });

new Pdf.Builder().preferSystemFonts(["Microsoft YaHei", "Noto Sans CJK SC"]);
```

名称按字体族名大小写不敏感匹配,同时也是选中 TTC 内特定 face 的方式。若指定的字体族未安装、无法解析,或无法覆盖文档文本,则跳过并回退到内置顺序——它引导的是一次尽力而为的搜索,而非硬性约束。若某个 face 是硬性要求,请使用 `fonts`。

### 东亚语言与字形

Unicode Han Unification 让中日韩共用汉字使用同一码位,但字形并不相同——「者」「骨」「今」「青」「每」在各地区的写法各不一样。因此仅按**覆盖范围**挑选字体可能"正确但依然是错的":用日文字体渲染中文,中文读者看到的是错别字感。

所以选择顺序是**先语言,后覆盖**:

```typescript
await Pdf.fromExcel(workbook, { textLanguage: "zh-Hans" }); // 也可以是 zh-Hant / ja / ko
new Pdf.Builder().textLanguage("zh-Hant");
```

未指定时,语言由内容推断:出现假名即判定日文,出现谚文即判定韩文,只在简体或繁体之一中存在的字用于区分简繁。若文本全部由中日韩共通字形组成(如日期、专有名词),则没有任何证据可用,此时优先简体中文字体族——这是**默认值**而非检测结果,也正是知道语言时应当显式指定的原因。

`Pdf.fromChart` 同样接受这两个选项,因此独立图表的标签也能获得与工作簿、文档一致的地区控制。

当一个 TTC 集合内同一字体族有多个字重时(macOS 的 `Songti.ttc` 把 `Songti SC` 的 Black 排在 Regular 之前),会选择常规字重,而不是文件中排在最前的那个 face。

语言同时用于在一个 TTC 集合的多个 face 之间取舍:macOS 的 `STHeiti Light.ttc` 中 face 0 是 `Heiti TC`、face 1 是 `Heiti SC`,而 `Songti.ttc` 有跨简繁的八个 face。若你自行指定字体族名,`preferSystemFonts` 的优先级仍高于语言。

有两点限制需要注意。CFF 轮廓的字体(`.otf`,以及各 face 均为 CFF 的 `.ttc`)会被拒绝,因为子集化嵌入器需要 `glyf` 轮廓——这排除了 macOS 的苹方(PingFang)与冬青黑体(Hiragino),也排除了官方 Noto Sans CJK 的 `.otf`/`.ttc` 发行版;请改用 Noto Sans SC 的 `.ttf` 版本。另外,由于结果取决于宿主机安装了什么字体,当输出字节稳定性比可读性更重要时,可用 `disableFontAutoDiscovery` 彻底关闭扫描。

该选项在**所有入口**上都可用,而非仅 builder —— 否则同一份导出是否可复现,会取决于你调用了哪个函数:

```typescript
import { Pdf } from "documonster/pdf";

// 确定性输出:要么由你提供的字体绘制,要么谁也画不出
const bytes = await Pdf.fromExcel(workbook, {
  disableFontAutoDiscovery: true,
  fonts: { default: { regular: myFontBytes } }
});
```

它关闭的是**发现**,不是嵌入,所以你显式提供的字体依然生效。若未提供字体,字符仍保留其 Unicode(可复制、可搜索),只是渲染为 `.notdef` 方框,并且 `onWarning` 会指出丢失了哪些区块 —— 关掉扫描不会连诊断一起关掉。

字体 fallback 只是标量渲染,不是复杂文本布局。本模块**不支持** OpenType shaping(GSUB/GPOS)、bidi 重排与彩色 emoji——仅配置字体不能让依赖 shaping 的 Arabic 或 Indic 文本正确渲染。

这些限制是可检测的,不会静默发生:当文档包含复杂文字系统(script)、从右至左文本,或内嵌字体带有彩色字形表(`COLR`/`CBDT`/`sbix`/`SVG`)时,`onWarning` 会按特性各上报一次,并指出涉及的文字系统或字体族。请在绘制前自行完成 shaping 与重排(或改为渲染为图片)。

---

## 按表页面设置

使用 Excel 桥接时,会遵循每个工作表的 `pageSetup`:

```typescript
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const ws1 = Workbook.addWorksheet(workbook, "Summary");
ws1.pageSetup.paperSize = 9; // A4
ws1.pageSetup.orientation = "portrait";

const ws2 = Workbook.addWorksheet(workbook, "Data");
ws2.pageSetup.paperSize = 1; // Letter
ws2.pageSetup.orientation = "landscape";

// 每个工作表以其各自的页面大小/方向渲染
const pdf = await Pdf.fromExcel(workbook);
```

工作表边距也会被继承:

```typescript
ws.pageSetup.margins = {
  left: 0.5, // 英寸
  right: 0.5,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3
};
```

---

## 摇树优化

PDF 模块完全可摇树优化。如果你不导入任何 PDF 导出项,该模块为你的打包产物增加 **零字节**:

```typescript
// 仅导入 Excel 核心 —— PDF 模块不会被包含
import { Workbook } from "documonster/excel";

// 导入 Excel + PDF 桥接
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";
```

---

## 示例

可运行示例位于 `src/modules/pdf/examples/`:

| 文件                   | 演示内容                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `pdf-basic.ts`         | 页面尺寸、边距、元数据、工作表选择、缩放                                               |
| `pdf-styled.ts`        | 字体、填充、边框、对齐、合并、旋转、富文本、数字格式                                   |
| `pdf-advanced.ts`      | 分页、分页符、加密、透明度、书签、隐藏行/列                                            |
| `pdf-excel-to-pdf.ts`  | 读取真实 `.xlsx` 文件并转换为 PDF                                                      |
| `pdf-images.ts`        | 图像嵌入(JPEG、带透明度的 PNG)                                                         |
| `pdf-reader.ts`        | 文本提取、元数据、图像、加密 PDF、选择性提取                                           |
| `pdf-reader-stress.ts` | 大规模压力测试:数千个单元格、加密往返、基准测试                                        |
| `pdf-builder.ts`       | PdfDocumentBuilder、PdfEditor、注释、表单、SVG 路径、书签、目录、PDF/A、合并、增量保存 |
| `pdf-signatures.ts`    | 数字签名占位符、ASN.1 解析、签名验证                                                   |

运行任意示例:

```bash
pnpm example --filter pdf-basic
# 输出: tmp/pdf-examples/*.pdf

pnpm example --filter pdf-builder
# 输出: tmp/pdf-builder-examples/*.pdf

pnpm example --filter pdf-signatures
# 输出: tmp/pdf-signature-examples/
```

---

## API 参考

### `Pdf.read(data, options?)`

读取 PDF 文件并提取文本、图像和元数据。返回 `Promise<ReadPdfResult>`。

```typescript
import { Pdf } from "documonster/pdf";

// 基本
const result = await Pdf.read(pdfBytes);
console.log(result.text);
console.log(result.pages[0].images);
console.log(result.pages[0].annotations);
console.log(result.formFields);
console.log(result.metadata);

// 加密
const result = await Pdf.read(pdfBytes, { password: "secret" });

// 选择性
const result = await Pdf.read(pdfBytes, {
  pages: [1, 3],
  extractImages: false,
  extractMetadata: false
});
```

### `Pdf.create(input, options?)`

从普通数据生成 PDF。返回 `Promise<Uint8Array>`。

```typescript
// 二维数组
await Pdf.create([
  ["Name", "Age"],
  ["Alice", 30]
]);

// 带列宽的单个工作表
await Pdf.create({ name: "Report", columns: [{ width: 25 }, 15], data: [["A", "B"]] });

// 多个工作表
await Pdf.create({
  sheets: [
    { name: "S1", data: [["A"]] },
    { name: "S2", data: [["B"]] }
  ]
});

// 带选项
await Pdf.create([["A", 1]], { showGridLines: true, pageSize: "A4" });
```

### `Pdf.fromExcel(workbook, options?)`

将 Excel `Workbook` 转换为 PDF。返回 `Promise<Uint8Array>`。

```typescript
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const workbook = Workbook.create();
// ... 构建工作簿 ...
const bytes = await Pdf.fromExcel(workbook, { showGridLines: true });
```

### `Pdf.Builder`

构建带文本、矢量图形、注释和表单字段的自由排版 PDF。

```text
import { Pdf } from "documonster/pdf";

const doc = new Pdf.Builder();
doc.setMetadata({ title, author, subject, creator });
doc.setEncryption({ ownerPassword, userPassword?, permissions? });
doc.setPdfACompliance();       // 启用 PDF/A-1b
doc.embedFont(fontBytes);      // 旧版单默认字体兼容 API
// 或:doc.embedFonts(fonts);   // 完整 PdfFontConfig;后一次调用替换之前的配置

const page = doc.addPage({ width?, height? }); // 返回 Pdf.PageBuilder

// PdfPageBuilder 方法:
page.drawText(text, { x, y, fontSize?, fontFamily?, bold?, italic?, color? });
page.drawRect({ x, y, width, height, fill?, stroke?, lineWidth? });
page.drawCircle({ cx, cy, r, fill?, stroke? });
page.drawEllipse({ cx, cy, rx, ry, fill?, stroke? });
page.drawLine({ x1, y1, x2, y2, color?, lineWidth? });
page.drawPath(ops, { fill?, stroke?, lineWidth? });
page.drawSvgPath(d, { fill?, stroke?, lineWidth? });
page.drawImage({ x, y, width, height, data, format });
page.addAnnotation({ type, rect, ...options });
page.addFormField({ type, name, rect, ...options });

doc.addBookmark(title, pageIndex, parent?);
doc.generateTableOfContents({ title?, fontSize?, indent? });

const bytes = await doc.build(); // 返回 Promise<Uint8Array>
```

### `Pdf.Editor`

编辑已有 PDF —— 叠加内容、填写表单、合并、拆分和签名。

```text
const editor = Pdf.Editor.load(pdfBytes, { password? });

// 页面访问
const page = editor.getPage(index);    // 返回 PdfEditorPage
const count = editor.pageCount;         // getter,而非方法

// PdfEditorPage 方法(与 PdfPageBuilder 相同的绘图 API):
page.drawText(text, options);
page.drawRect(options);
page.drawCircle(options);
page.drawLine(options);
page.drawImage(options);
page.drawSvgPath(d, options);
page.drawPath(ops, options);
page.addAnnotation(options);
page.addFormField(options);

// 页面操作
editor.addPage(options?);              // 返回 Pdf.PageBuilder
editor.removePage(index);
editor.rotatePage(index, degrees);     // 90, 180, 270
editor.copyPagesFrom(otherPdfBytes);

// 填写表单
editor.setFormField(name, value);
editor.setFormFields({ name: value, ... });

// 保存
const full = await editor.save();             // 完整重建
const incr = await editor.saveIncremental();  // 仅追加
const pages = await editor.splitPages();      // 拆分为多个独立 PDF
```

### `Pdf.verifySignature(pdfData, signatureHex, byteRange)`

验证数字签名。返回 `Promise<SignatureVerificationResult>`。

```typescript
import { Pdf } from "documonster/pdf";

const result = await Pdf.verifySignature(pdfBytes, sigHex, [0, off1, off2, len2]);
// result.valid            — boolean
// result.coversWholeFile  — boolean(无未签名间隙)
// result.digestAlgorithm  — OID 字符串
// result.reason           — 失败原因(若 !valid)
```

### `Pdf.sign(pdfBytes, certificate, privateKey)`

签名一个包含签名占位符的 PDF。返回 `Promise<Uint8Array>`。

```typescript
import { Pdf } from "documonster/pdf";

// 步骤 1:构建占位符
const { dictString, placeholder } = Pdf.buildSignatureDictPlaceholder({
  name: "Alice",
  reason: "Approval",
  location: "London",
  contactInfo: "alice@example.com"
});

// 步骤 2:签名(certificate = DER X.509, privateKey = DER PKCS#8)
const signed = await Pdf.sign(pdfWithPlaceholder, certificate, privateKey);
```

### `Pdf.parseSvgPath(d)`

将 SVG 路径 `d` 属性解析为 `PathOp` 对象数组,供 `drawPath()` 使用。

```typescript
import { Pdf } from "documonster/pdf";

const ops = Pdf.parseSvgPath("M10 10 L90 10 L50 80 Z");
page.drawPath(ops, { fill: { r: 1, g: 0, b: 0 } });
```

### 错误类型

```typescript
import {
  PdfError, // 所有 PDF 错误的基类
  PdfRenderError, // 布局/渲染失败
  PdfFontError, // 字体解析/嵌入失败
  PdfStructureError, // PDF 结构组装失败
  isPdfError // 类型守卫: (err: unknown) => err is PdfError
} from "documonster/pdf";
```

所有错误均继承自 `BaseError`,并支持 `cause` 链:

```typescript
import { Pdf } from "documonster/pdf";

try {
  await Pdf.fromExcel(workbook);
} catch (err) {
  if (isPdfError(err)) {
    console.error(err.message, err.cause);
  }
}
```
