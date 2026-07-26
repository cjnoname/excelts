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
- **页面设置** —— 按表设置纸张大小、方向、边距、打印区域
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

```typescript
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

```typescript
import { Pdf } from "documonster/pdf";

const doc = new Pdf.Builder();
doc.setMetadata({ title: "My Report", author: "documonster" });

const page = doc.addPage({ width: 595, height: 842 }); // A4

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

// 字体嵌入(用于 Unicode/CJK)
doc.embedFont(fontFileBytes);

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
│   ├── layout-engine   — PdfSheetData → LayoutPage[](零 @excel 导入)
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
  fitToPage?: boolean; // 缩放列以适应页宽(默认:true)
  scale?: number; // 额外缩放因子(默认:1.0)

  // 内容
  showGridLines?: boolean; // 渲染单元格网格线
  gridLineColor?: string; // 网格线的 ARGB 颜色(例如 "FF3366CC")
  repeatRows?: number | false; // 在每页重复的表头行数
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
  font?: Uint8Array; // TrueType 字体文件字节(用于 Unicode/CJK)
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
- `fitToPage: true`(默认):缩放所有列以适应页宽

### 重复表头行

```typescript
await Pdf.fromExcel(workbook, { repeatRows: 2 }); // 在每页重复前 2 行
```

或通过工作表的页面设置:

```typescript
worksheet.pageSetup.printTitlesRow = "1:2"; // 重复第 1-2 行
```

### 手动分页

```typescript
worksheet.rowBreaks.push({ id: 20, max: 16838, man: 1 }); // 在第 20 行后分页
```

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

## Unicode / CJK 支持

标准 Type1 字体(Helvetica、Times、Courier)仅支持拉丁字符。对于 Unicode、CJK 或其他文字,请提供 TrueType 字体:

```typescript
import { readFileSync } from "fs";

const pdf = await Pdf.fromExcel(workbook, {
  font: readFileSync("NotoSansSC-Regular.ttf")
});
```

字体会被自动子集化(仅嵌入用到的字形)以最小化 PDF 文件大小。

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
npx tsx src/modules/pdf/examples/pdf-basic.ts
# 输出: tmp/pdf-examples/*.pdf

npx tsx src/modules/pdf/examples/pdf-builder.ts
# 输出: tmp/pdf-builder-examples/*.pdf

npx tsx src/modules/pdf/examples/pdf-signatures.ts
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
await Pdf.create([["Name", "Age"], ["Alice", 30]]);

// 带列宽的单个工作表
await Pdf.create({ name: "Report", columns: [{ width: 25 }, 15], data: [["A", "B"]] });

// 多个工作表
await Pdf.create({ sheets: [{ name: "S1", data: [...] }, { name: "S2", data: [...] }] });

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

```typescript
import { Pdf } from "documonster/pdf";

const doc = new Pdf.Builder();
doc.setMetadata({ title, author, subject, creator });
doc.setEncryption({ ownerPassword, userPassword?, permissions? });
doc.setPdfACompliance();       // 启用 PDF/A-1b
doc.embedFont(fontBytes);      // 用于 Unicode/CJK 的 TrueType 字体

const page = doc.addPage({ width?, height? }); // 返回 PdfPageBuilder

// PdfPageBuilder 方法:
page.drawText(text, { x, y, fontSize?, bold?, italic?, color?, font? });
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

```typescript
import { Pdf } from "documonster/pdf";

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
editor.addPage(options?);              // 返回 PdfEditorPage
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
  name?, reason?, location?, contactInfo?
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
