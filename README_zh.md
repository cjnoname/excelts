# Documonster

[![构建状态](https://github.com/documonster/documonster/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/documonster/documonster/actions/workflows/ci.yml) &nbsp; [English](README.md)

TypeScript 生态在文档和数据处理领域长期存在碎片化问题。要处理电子表格、文档、PDF 以及围绕它们的各种数据和归档格式，往往需要分别引入不同的包；到了浏览器端又要换一套方案；流式处理还得再额外接入一个适配库。这些库的 API 风格、质量和维护状态参差不齐，给每个需要组合使用它们的项目都带来了额外的负担。

Documonster 正是为了解决这个问题而生。一个包、一套 API、一份代码 — 在 Node.js、Bun 和浏览器中行为完全一致。流式处理是每个模块的一等公民，而非通过第三方适配器后期拼装的附属品。目标很简单：安装一次，按需导入，在任何环境下都获得相同的可靠体验 — 同时将流式处理的性能发挥到极致。

## 关于本项目

Documonster 是一个零依赖的 TypeScript 电子表格和文档工具包：

- **AI 友好** — 简洁一致的 API,专为 AI 编程助手设计。每个模块都配有完整的文档和可运行的示例供 AI 学习。另提供 [MCP 服务器](packages/mcp/README.md),供需要操作真实文件的 AI 客户端使用
- **零运行时依赖** — 纯 TypeScript,无外部包
- **九大模块** — Excel、Word、Formula、PDF、CSV、Markdown、XML、Archive、Stream
- **跨平台** — Node.js 22.13+、Bun、Chrome 89+、Firefox 102+、Safari 14.1+
- **纯 ESM** — 原生 ES Modules,完整 tree-shaking;CommonJS 消费者在 Node >= 22.13 上写法不变,直接 `require()`

## 模块

Documonster 由九个独立模块组成,每个模块都有自己的文档和可运行示例。

### Excel — XLSX/JSON 工作簿管理器

创建、读取和修改 Excel 电子表格,完整支持样式、公式、图片和流式处理。

- [文档](src/modules/excel/README.md) | [中文](src/modules/excel/README_zh.md)
- [示例](src/modules/excel/examples/)

### Word — DOCX 文档处理器

读取、写入和操作 DOCX 文件,提供完整的构建器、读取器和转换器能力。可构建含标题、表格、图片、列表、页眉/页脚、绘图形状、数学公式和图表的文档；可对现有文件做文本查找/替换、格式感知查询、书签/批注查找等读取与修改;可与 HTML 和 Markdown 互相转换,将 Excel 工作簿桥接为 Word 表格,并将 Word 直接渲染为 PDF。高级功能包括模板引擎、表单字段、OpenDoPE 数据绑定、字体嵌入与子集化、修订追踪接受/拒绝、文档比对/合并、流式写入器、密码保护、Agile 加密解密以及数字签名检测。

- [文档](src/modules/word/README.md) | [中文](src/modules/word/README_zh.md)
- [示例](src/modules/word/examples/)

### Formula — Excel 兼容公式引擎

448 函数计算引擎,包含 tokenizer、parser、依赖图、动态数组 spill,支持 `LAMBDA`/`LET`/`MAP`/`REDUCE`。用 `documonster/excel/formula` 的 `calculateFormulas()` 重算 workbook;用 `documonster/formula` 的 `Formula` 检查语法。无需任何安装步骤,且引擎不会进入只读写 XLSX 的 bundle。

- [文档](src/modules/formula/README.md) | [中文](src/modules/formula/README_zh.md)
- [示例](src/modules/formula/examples/)

### PDF — 零依赖 PDF 引擎

功能完整的 PDF 生成和读取。写入支持字体嵌入、AES-256 加密、图片和 Excel 转 PDF。读取支持从任意 PDF 提取文本、图片、注解、表单字段和元数据。

- [文档](src/modules/pdf/README.md) | [中文](src/modules/pdf/README_zh.md)
- [示例](src/modules/pdf/examples/)

### CSV — RFC 4180 解析器/格式化器

高性能 CSV 解析和格式化，支持流式处理、动态类型、数据生成和工作线程池。

- [文档](src/modules/csv/README.md) | [中文](src/modules/csv/README_zh.md)
- [示例](src/modules/csv/examples/)

### Markdown — GFM 表格解析器/格式化器

解析和格式化 GitHub 风格 Markdown 表格，支持对齐方式保留和工作簿集成。

- [文档](src/modules/markdown/README.md) | [中文](src/modules/markdown/README_zh.md)
- [示例](src/modules/markdown/examples/)

### XML — SAX/DOM 解析器、查询引擎、写入器

流式和缓冲式 XML 处理，含查询引擎、命名空间支持和双模式写入。

- [文档](src/modules/xml/README.md) | [中文](src/modules/xml/README_zh.md)
- [示例](src/modules/xml/examples/)

### Archive — 归档创建/读取/编辑

ZIP 和 TAR 归档创建、读取、编辑、流式处理、加密和压缩工具，以及 `encodePng` —— PNG 就是带 CRC-32 校验 chunk 的 DEFLATE 流，而这两样原语都在这里。

- [文档](src/modules/archive/README.md) | [中文](src/modules/archive/README_zh.md)
- [示例](src/modules/archive/examples/)

### Stream — 跨平台流式处理

兼容 Node.js 的 Readable/Writable/Transform/Duplex，在 Node.js 和浏览器中行为一致。

- [文档](src/modules/stream/README.md) | [中文](src/modules/stream/README_zh.md)
- [示例](src/modules/stream/examples/)

### Draw — 共享绘图引擎

一份结构化显示列表,一个遍历器,多个后端。构建 `DrawList`,即可从同一份输出得到 SVG 标记、RGBA 像素或 PDF 页面 —— 任何渲染器都不必重新解析另一个渲染器的 SVG。自带文本测量与换行,生产者在构建列表之前就能确定盒子尺寸。

- [文档](src/modules/draw/README.md) | [中文](src/modules/draw/README_zh.md)

### Mermaid — 图表文本转绘图

21 种 Mermaid 图表类型 —— 流程图、状态图、类图、ER 图、时序图、甘特图、思维导图、Git 图等 —— 无需浏览器或 headless Chrome 即可渲染。本模块产出显示列表且不实现任何后端,因此 SVG、像素和 PDF 页面都是免费附带的。解析、布局、渲染是分离的三个阶段,可在任一阶段停下。

- [文档](src/modules/mermaid/README.md) | [中文](src/modules/mermaid/README_zh.md)
- [示例](src/modules/mermaid/examples/)

## MCP 服务器 — 面向 AI 客户端的 Documonster

`@documonster/mcp` 通过 Model Context Protocol 暴露本工具包,让 Claude Desktop、Claude Code、Cursor 等 MCP 客户端能够真正读写电子表格、文档、PDF、表单和归档,而不是靠猜。它作为独立的包发布,因此 MCP SDK 不会进入 `documonster`,零依赖承诺保持不变。

- [文档](packages/mcp/README.md)
- [示例](packages/mcp/src/examples/)

## 安装

```bash
npm install documonster
# or
pnpm add documonster
# or
bun add documonster
```

每个模块都可以作为独立的子路径导出使用。所有子路径均支持 `browser`、`import`（ESM）和 `require`（CJS）条件导出。

## 快速开始

```typescript
import { Workbook, Worksheet, Row } from "documonster/excel";

// 创建
const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Sheet1");
Worksheet.addRow(sheet, ["姓名", "年龄"]);
Worksheet.addRow(sheet, ["Alice", 30]);
await Workbook.writeFile(workbook, "output.xlsx");

// 读取
const wb = Workbook.create();
await Workbook.readFile(wb, "output.xlsx");
const readSheet = Workbook.getWorksheet(wb, 1);
Worksheet.eachRow(readSheet, (_row, n) => console.log(n, Row.getValues(readSheet, n)));

// PDF — 直接从数据生成，无需 Workbook
import { Pdf } from "documonster/pdf";
const pdfBytes = await Pdf.create([
  ["产品", "收入"],
  ["小工具", 1000]
]);

// PDF — 读取任意 PDF 的文本、图片和元数据
const result = await Pdf.read(pdfBytes);
console.log(result.text); // 提取的文本
console.log(result.metadata); // 标题、作者等

// CSV — 解析和格式化
import { Csv } from "documonster/csv";
const rows = Csv.parse("name,age\nAlice,30", { headers: true });
const csv = Csv.format([{ name: "Bob", age: 25 }], { headers: true });

// XML — 解析、查询、写入
import { Xml } from "documonster/xml";
const titles = Xml.queryAll(Xml.parse(xmlString).root, "book/title");

// ZIP — 创建和解压
import { Archive } from "documonster/archive";
const archive = await Archive.zip().add("hello.txt", "Hello!").bytes();

// Markdown — 解析和格式化表格
import { Markdown } from "documonster/markdown";
const table = Markdown.parse("| A | B |\n|---|---|\n| 1 | 2 |");

// Word — 创建、读取和转换 DOCX
import { Document, Io } from "documonster/word";
const wdoc = Document.create();
Document.addHeading(wdoc, "报告", 1);
Document.addParagraph(wdoc, "由 Documonster 生成。");
const docxBytes = await Io.toBuffer(Document.build(wdoc));
const parsedDocx = await Io.read(docxBytes); // 往返读取

// Formula — 可选的公式引擎(默认不打进主 bundle)
// 重算 excel workbook：走 excel/formula subpath。
import { calculateFormulas } from "documonster/excel/formula";
import { Cell } from "documonster/excel";
Cell.setValue(sheet, "A4", { formula: "SUM(A1:A3)" });
calculateFormulas(workbook); // 现在能填充单元格计算结果了

// 语法检查单独可用
import { Formula } from "documonster/formula";
const ast = Formula.parse(Formula.tokenize("SUM(A1:A3)"));
```

## 浏览器支持

Documonster 原生支持浏览器，现代打包工具**零配置**即可使用。

```typescript
// 打包工具（Vite、Webpack、Rollup、esbuild）— 直接导入
import { Workbook } from "documonster/excel";
const wb = Workbook.create();
Workbook.addWorksheet(wb, "S1");
const buffer = await Workbook.toBuffer(wb);
```

<!-- x-release-please-start-version -->

```html
<!-- Script 标签（无需打包工具）— 每个模块一个 IIFE，共享同一个 `Documonster` 全局 -->
<script src="https://unpkg.com/documonster@0.12.0/dist/iife/documonster.excel.iife.min.js"></script>
<script>
  const { Workbook, Cell } = Documonster.Excel;
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S1");
  Cell.setValue(ws, "A1", "Hello, Browser!");
  Workbook.toBuffer(wb).then(buffer => console.log(buffer.byteLength));
</script>
```

<!-- x-release-please-end -->

URL 中的版本号是刻意锁定的：不锁版本的 `unpkg.com/documonster/…` 会解析到最新版，
于是一次发布就会改变一个并未要求改变的页面。每个模块都有自己的产物，文件名即模块名：

<!-- iife-bundles:start -->

`excel`、`word`、`pdf`、`csv`、`markdown`、`xml`、`formula`、`archive`、`stream`、
`draw`、`mermaid`

<!-- iife-bundles:end -->

把 URL 里的名字换掉，再从 `Documonster.Word`、`Documonster.Pdf`、
`Documonster.Mermaid`…… 上取用即可。同时加载多个也没问题，它们扩展的是同一个全局
对象。没有全家桶产物，所以页面只为它点名的模块付费。

> IIFE 打包产物不包含公式计算引擎。如果需要重算公式，请改用 ESM + 导入
> `documonster/excel/formula`。

对于不支持原生 `CompressionStream` API 的旧版浏览器，Documonster 自动使用内置的纯 JavaScript DEFLATE 实现 — 无需 polyfill。

## 系统要求

- **Node.js >= 22.13.0**
- **Bun >= 1.0**

本包是纯 ESM。Node ESM、打包工具、`<script>` 标签一切不变;CommonJS 的 `require()` 写法也
不变——Node 从 22.12 起支持用 `require()` 加载 ES 模块,从 22.13 起不再为此打印实验特性警告,
所以下限定在 22.13。

<details>
<summary>TypeScript 用 <code>module: node16</code> 时</summary>

改用 `nodenext`。TypeScript 的 `node16` 模式早于 `require(esm)`,它会在 Node 看到之前就拒绝:

```
error TS1479: The current file is a CommonJS module whose imports will produce 'require'
calls; however, the referenced file is an ECMAScript module and cannot be imported with
'require'.
```

`nodenext` 认识 `require(esm)`,可以通过——在 tsc 5.9 上验证过,`bundler` 以及传统的
`commonjs` + `node10`(通过 `typesVersions` 解析类型)同样可以。编译出来的 JavaScript
完全一样、运行也一样,只有类型检查器有意见。

</details>

<details>
<summary>在 Jest 中使用</summary>

Jest 无法 `require()` 一个 ES 模块,需要加一个 transform。这和 `chalk`、`uuid`、`nanoid`、
`strip-ansi` 等大多数现代包要求的配置完全相同——如果你已经为其中任何一个配过,只要把
`documonster` 加进已有的 pattern 即可:

```js
// babel.config.cjs
module.exports = { presets: [["@babel/preset-env", { targets: { node: "current" } }]] };
```

```json
// jest.config.json
{
  "transform": { "\\.[jt]sx?$": "babel-jest" },
  "transformIgnorePatterns": ["/node_modules/(?!documonster)"]
}
```

Vitest 无需任何配置。

</details>

| 浏览器  | 最低版本           |
| ------- | ------------------ |
| Chrome  | 89+（2021年3月）   |
| Edge    | 89+（2021年3月）   |
| Firefox | 102+（2022年6月）  |
| Safari  | 14.1+（2021年4月） |
| Opera   | 75+（2021年3月）   |

## 链接

- 🏠 [GitHub 仓库](https://github.com/documonster/documonster)
- 🐛 [问题追踪](https://github.com/documonster/documonster/issues)
- 📋 [更新日志](CHANGELOG.md)
- 🔄 [迁移指南](MIGRATION.md)
- 📄 [许可证 (Apache-2.0)](LICENSE)
- 📦 [第三方声明](THIRD_PARTY_NOTICES.md)
