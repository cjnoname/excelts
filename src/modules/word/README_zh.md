# Word 模块

[English](README.md)

零依赖的 TypeScript 库，用于读取、写入和操作 DOCX 文件。
支持 Node.js 22+ 和现代浏览器。

## 功能

- **创建、读取和修改 DOCX 文件** — 完整的 WordprocessingML 支持
- **文档构建器** — 段落、标题、富文本 run（粗体/斜体/下划线/颜色/高亮）
- **表格** — 样式、边框、单元格合并（水平 + 垂直）、嵌套表格
- **图片** — 内联和浮动（JPEG、PNG、GIF、BMP、TIFF，SVG 带光栅 fallback）
- **列表** — 无序、有序、多级
- **页面布局** — 分节、页面尺寸/方向/边距、分栏、分隔符
- **页眉和页脚** — 默认、首页、奇偶页
- **超链接和书签** — 外部链接、内部链接、交叉引用
- **目录** — 基于域，带缓存条目
- **脚注、尾注和批注** — 包括线程/扩展批注
- **域（field）** — PAGE/NUMPAGES、TOC、INDEX/XE、REF、SEQ、STYLEREF、公式等
- **数学公式** — OMML 公式（分数、根式、矩阵、n 元运算符……）
- **绘图形状** — 预设几何，支持填充、线条、渐变、阴影/发光/3D 特效
- **图表** — 不透明保留 + 从零构建；桥接到 Excel 图表引擎
- **修订追踪** — 接受/拒绝插入、删除、移动和属性变更
- **模板** — `{{variable}}`、`{{#if}}`、`{{#each}}`、邮件合并、模板修补
- **表单字段和内容控件（SDT）** — 提取和填充；OpenDoPE 数据绑定
- **字体嵌入** — 自动字形子集化
- **文档保护** — 只读/批注/表单，带密码
- **加密** — 解密受密码保护的 DOCX（Agile Encryption）
- **数字签名** — 检测和元数据提取
- **转换** — DOCX ↔ HTML、DOCX ↔ Markdown、Excel → Word、Word → PDF
- **Flat OPC** — 单一 XML `.xml` 表示形式往返
- **比对和合并** — 比较两个文档、合并多个文档
- **流式写入器** — `createDocxStream()` 处理大文档
- **校验** — 结构检查，带严重级别标记
- **OOXML Strict** — 读取时透明归一化为 Transitional
- **浏览器支持** — 同一个 `documonster/word` 导入在 Node.js 和浏览器中均可用

## 快速开始

```typescript
import { Document, Io } from "documonster/word";

// 创建文档
const doc = Document.create();
Document.addHeading(doc, "Hello World", 1);
Document.addParagraph(doc, "This is a paragraph.");
Document.addTable(doc, [
  ["A", "B"],
  ["1", "2"]
]);

const buffer = await Io.toBuffer(Document.build(doc));
// 写入文件、作为响应返回等

// 读取文档
const parsed = await Io.read(buffer);
console.log(parsed.body.length, "elements");
```

## 核心 API

### 文档构建器

```typescript
import { Document, Build, Io } from "documonster/word";

const doc = Document.create();

// 文本
Document.addParagraph(doc, "Simple text");
Document.addParagraphElement(
  doc,
  Build.paragraph([Build.text("Normal "), Build.bold("bold "), Build.italic("italic")])
);
Document.addHeading(doc, "Title", 1);

// 表格
Document.addTable(
  doc,
  [
    ["Header1", "Header2"],
    ["cell1", "cell2"]
  ],
  { headerRow: true }
);

// 图片
Document.addImage(doc, pngBytes, "png", width, height);
Document.addFloatingImage(doc, jpgBytes, "jpeg", width, height, { wrap: { style: "square" } });

// 列表
Document.addBulletList(doc, ["Item 1", "Item 2", "Item 3"]);
Document.addNumberedList(doc, ["First", "Second", "Third"]);

// 页面布局
Document.setSectionProperties(doc, {
  pageSize: { width: 11906, height: 16838 }, // A4
  margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
});

// 页眉/页脚
Document.setHeader(doc, "default", { children: [Build.textParagraph("Page Header")] });

// 构建与导出
const model = Document.build(doc);
const bytes = await Io.toBuffer(model);
```

### 读取文档

```typescript
import { Io, Query } from "documonster/word";

const doc = await Io.read(fileBuffer);

// 提取文本内容
const text = Query.extractText(doc);

// 搜索
const results = Query.searchText(doc, /pattern/g);
```

### 修改文档

```typescript
import { Io, Query } from "documonster/word";

const doc = await Io.read(buffer);
const modified = Query.replaceText(doc, "OLD_TEXT", "NEW_TEXT");
const output = await Io.toBuffer(modified);
```

## 高级功能

### 模板引擎

```typescript
import { Template } from "documonster/word";

const filled = Template.fillTemplate(doc, {
  name: "John",
  showDetails: true,
  items: ["A", "B", "C"]
});
// 支持：{{variable}}、{{#if cond}}...{{/if}}、{{#each arr}}...{{/each}}
```

### 表单字段

```typescript
import { Query, Build } from "documonster/word";

// 提取表单数据
const fields = Query.extractFormFields(doc);
// → [{ name: "FullName", type: "text", value: "..." }, ...]

// 填充表单数据
const filled = Query.fillFormFields(
  doc,
  new Map([
    ["FullName", "Jane Doe"],
    ["AgreeTerms", true],
    ["Country", 2]
  ])
);
```

### 数据绑定（OpenDoPE）

```typescript
import { Query } from "documonster/word";

// 根据 CustomXML 部件解析 SDT 数据绑定
const resolved = Query.resolveDataBindings(doc);

// 或使用覆盖数据
const resolved2 = Query.resolveDataBindings(
  doc,
  new Map([["{GUID}", "<root><field>value</field></root>"]])
);
```

### 带特效的绘图形状

```typescript
import { Build } from "documonster/word";

const shape = Build.createShape({
  shapeType: "roundRect",
  width: 3000000, // EMU
  height: 2000000,
  fill: {
    type: "gradient",
    stops: [
      { position: 0, color: "FF0000" },
      { position: 100000, color: "0000FF" }
    ]
  },
  effects: {
    shadow: {
      type: "outer",
      color: "000000",
      blurRadius: 50800,
      distance: 38100,
      direction: 2700000
    },
    glow: { color: "FFFF00", radius: 101600 },
    reflection: { startOpacity: 50, endOpacity: 0, distance: 25400 },
    softEdges: 63500,
    effect3d: {
      camera: "perspectiveFront",
      bevelTop: { width: 127000, height: 63500, preset: "circle" }
    }
  }
});
```

### 字体嵌入与子集化

```typescript
import { Font } from "documonster/word";

// 嵌入并自动子集化（只嵌入文档中用到的字形）
const result = Font.embed({
  name: "CustomFont",
  data: fontFileBytes,
  style: "regular",
  usedCharacters: "Hello World" // 只嵌入这些字形
});

// 添加到文档
const docWithFonts = Font.addEmbedded(doc, [result]);
```

### 修订追踪

```typescript
import { Query } from "documonster/word";

const accepted = Query.acceptAllRevisions(doc);
const rejected = Query.rejectAllRevisions(doc);
```

### 文档比对

```typescript
import { Diff } from "documonster/word";

const diff = Diff.documents(docA, docB);
// → { changes: [{ type: "added"|"removed"|"modified", ... }] }
```

### 文档合并

```typescript
import { Io } from "documonster/word";

const merged = Io.merge([doc1, doc2, doc3], { sectionBreak: "nextPage" });
```

### 流式写入器

```typescript
import { Streaming } from "documonster/word";

const stream = Streaming.createDocxStream();
stream.addText("Title", { style: "Heading1" });
for (const item of largeDataset) {
  stream.addText(item.text);
}
const buffer = await stream.finalize();
```

### 文档保护

```typescript
import { Security } from "documonster/word";

const protectedDoc = Security.protect(doc, { type: "readOnly", password: "secret" });
const isProtected = Security.isProtected(protectedDoc); // true
const valid = Security.verifyPassword(protectedDoc, "secret"); // true
```

### 校验

```typescript
import { Validation } from "documonster/word";

const result = Validation.document(doc);
if (!result.valid) {
  console.log(result.issues); // [{ severity, message, path }]
}
```

### HTML/Markdown 转换

```typescript
// DOCX → Markdown（GFM：标题、粗体/斜体/删除线、行内代码、
// 代码块、引用块、有序/无序列表、带对齐的表格、
// 链接、图片、脚注）
import { renderToMarkdown } from "documonster/word/markdown";
const md = renderToMarkdown(doc);
const mdSetext = renderToMarkdown(doc, { headingStyle: "setext" });

// Markdown → DOCX（完整文档或正文片段）
import { markdownToDocx, markdownToDocxBody } from "documonster/word/markdown";
const doc = markdownToDocx("# Title\n\nHello **world**");
const bodyItems = markdownToDocxBody("- a\n- b");

// 表格列宽按内容测量，代码块字号收缩到最长行不折行为止 —— 这两件事只能由生产方决定，
// 因为 .docx 里存的是列网格和字号，而不是"稍后再算"的指令。正文若不是投放到 Letter
// 页面，就把目标版心宽度说明清楚：
const wide = markdownToDocx(markdown, {
  contentWidth: 15840 - 2 * 720, // 横向 Letter，半英寸页边距
  codeBlockFit: "shrink" // 默认值；"wrap" 保持字号、改为折行
});

// DOCX → HTML
import { renderToHtml } from "documonster/word/html";
const html = renderToHtml(doc);

// HTML → DOCX 正文内容
import { htmlToDocxBody } from "documonster/word/html";
const body = htmlToDocxBody("<h1>Hello</h1><p>World</p>");
```

### Flat OPC 格式

```typescript
import { Convert } from "documonster/word";

// DOCX 的单一 XML 表示形式
const flatXml = Convert.toFlatOpc(doc);
const doc = Convert.parseFlatOpc(flatXmlString);
```

### 加密与签名

底层加密工具位于 `documonster/word/crypto` 子路径，因此不会被打进
只读写普通 DOCX 的 bundle。

```typescript
import {
  isEncryptedDocx,
  decryptDocx,
  encryptDocx,
  extractSignatures,
  hasDigitalSignatures
} from "documonster/word/crypto";

// 解密受密码保护的 DOCX（Agile Encryption）
if (isEncryptedDocx(bytes)) {
  const plain = await decryptDocx(bytes, "password");
}

// 用密码加密 DOCX
const encrypted = await encryptDocx(docxBytes, "password");

// 检查嵌入的 XMLDSig 签名（只读；不做验证）
const signatures = extractSignatures(opaqueParts);
```

### Excel → Word

将 Excel `Workbook` 转换为 `DocxDocument`，把工作表映射为
带单元格格式（字体、颜色、对齐、填充、边框）、列宽、富文本 run
以及可选标题页的 Word 表格。隐藏的工作表会被跳过；行/列数量可以设上限。

```typescript
import { excelToDocx, extractTablesToExcel } from "documonster/word/excel";
import { Io } from "documonster/word";

// Workbook → DocxDocument（所有可见工作表，保留格式）
const doc = excelToDocx(workbook);
const docxBytes = await Io.package(doc);

// 带选项：标题页、只取部分工作表、限制行列数
const doc2 = excelToDocx(workbook, {
  titlePage: { title: "Q3 Report", subtitle: "Sales" },
  sheets: ["Summary", 2], // 按名称或从 0 开始的索引
  maxRows: 100,
  maxColumns: 12,
  preserveFormatting: true
});

// 反向：把 DOCX 中的表格抽取为 Workbook
const extracted = extractTablesToExcel(doc);
```

嵌入在 Word 文档中的图表也会桥接到 Excel 图表引擎
（27 个图表系列，经典图表与现代 ChartEx）。PDF 渲染侧参见
`Pdf.wordChartRenderer`。

### Word → PDF

将 `DocxDocument` 转换为 PDF 字节。该桥接是共享 Word 布局引擎之上的薄层，
因此换行、分页、表格、行内图片、页眉/页脚和浮动元素的渲染结果
与 SVG 路径完全一致。

```typescript
import { Io } from "documonster/word";
import { Pdf } from "documonster/pdf";

const doc = await Io.read(docxBytes);
const pdfBytes = await Pdf.fromDocx(doc);

// 覆盖页面几何（单位：磅）。省略的字段会回退到
// 文档的 section properties，再回退到引擎默认值（US Letter，1 英寸）。
const pdf2 = await Pdf.fromDocx(doc, {
  pageWidth: 595, // A4 宽度
  pageHeight: 842, // A4 高度
  marginTop: 72,
  marginBottom: 72,
  marginLeft: 72,
  marginRight: 72,
  headerMargin: 36, // 页眉带相对顶边的偏移
  footerMargin: 36, // 页脚带相对底边的偏移
  defaultFont: "Helvetica",
  defaultFontSize: 11
});
```

**图表。** 调用过 `Pdf.wordChartRenderer` 后，经典图表
（`<c:chart>`）和现代 ChartEx（`<cx:chartSpace>` —— 旭日图、矩形树图、
瀑布图、漏斗图、箱线图、直方图、帕累托图、地图）都会自动渲染为
完整矢量 PDF。若未安装图表支持，图表会降级为带标题的占位框
（不抛错、不留空白页）。要提供你自己的经典图表渲染器：

```typescript
import { Pdf } from "documonster/pdf";

const pdf = await Pdf.fromDocx(doc, {
  chartRenderer: await Pdf.wordChartRenderer()
});
```

`chartRenderer` 可以返回 `false` 来拒绝渲染某个图表；此时桥接会
回退到内置矢量渲染器，再回退到行内 SVG / 占位框。

## OOXML Strict 格式

本模块会自动处理以 ISO 29500 Strict 一致性级别保存的文档。
读取 Strict 格式的 .docx 时，命名空间 URI 和关系类型会被透明地
归一化为对应的 Transitional 形式 —— 无需任何用户操作。

## 兼容性

| 特性             | 支持情况                                      |
| ---------------- | --------------------------------------------- |
| .docx（读取）    | ✅ 广泛（常见元素结构化；未知部件保留）       |
| .docx（写入）    | ✅ 广泛（常见元素；未知部件以不透明形式写出） |
| .dotx（模板）    | ✅                                            |
| .docm（宏）      | ✅ 往返（保留 VBA，不执行/不编辑）            |
| .dotm（宏模板）  | ✅ 往返                                       |
| Flat OPC（.xml） | ✅                                            |
| ISO 29500 Strict | ✅ 自动归一化                                 |
| 加密的 .docx     | ✅ 用密码解密（Agile Encryption）             |
| 数字签名         | 🔍 检测与元数据提取（不签名/不验证）          |
| 浏览器           | ✅（同一个 `documonster/word` 导入）          |
| Node.js 22+      | ✅                                            |
