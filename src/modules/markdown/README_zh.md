# Markdown 模块

[English](README.md)

零依赖的 GFM(GitHub 风格 Markdown)表格解析器与格式化器。

```typescript
import { Markdown } from "documonster/markdown";
// Markdown.parse, Markdown.parseAll, Markdown.format
```

## 特性

- **符合 GFM 规范** — 解析标准的 GitHub 风格 Markdown 表格语法
- **零依赖** — 纯 TypeScript,无任何外部包
- **跨平台** — 在 Node.js 与浏览器中使用相同的 API
- **往返转换** — 解析与格式化集于一身,并保留对齐信息
- **列对齐** — 检测并生成左对齐、居中、右对齐、无对齐
- **管道符转义** — 在解析与格式化两个方向均处理 `\|` 与 `\\`
- **CJK/Emoji 宽度** — 内置显示宽度计算,实现正确的列对齐
- **多行单元格** — 支持 `<br>` 标签以在单元格内换行
- **多表格** — 使用 `Markdown.parseAll` 从一篇 Markdown 文档中提取所有表格
- **Workbook 集成** — 使用 `documonster/excel/markdown` 的 `readMarkdown(workbook, input)` / `writeMarkdown(workbook)` 实现 Excel↔Markdown

---

## 快速开始

### 解析

```typescript
import { Markdown } from "documonster/markdown";

const result = Markdown.parse("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
// result.headers = ["Name", "Age"]
// result.rows = [["Alice", "30"]]
// result.alignments = ["none", "none"]

// 带对齐检测
const aligned = Markdown.parse("| Left | Center | Right |\n|:---|:---:|---:|\n|a|b|c|");
// aligned.alignments = ["left", "center", "right"]

// 从较大的文档中(查找第一个表格)
const doc = Markdown.parse("# Title\n\nSome text.\n\n| A |\n| --- |\n| 1 |");
// doc.headers = ["A"], doc.rows = [["1"]]
```

### 格式化

```typescript
import { Markdown } from "documonster/markdown";

Markdown.format(
  ["Name", "Age"],
  [
    ["Alice", "30"],
    ["Bob", "25"]
  ]
);
// | Name  | Age |
// | ----- | --- |
// | Alice | 30  |
// | Bob   | 25  |

// 带对齐
Markdown.format(["Left", "Center", "Right"], [["a", "b", "c"]], {
  columns: [
    { header: "Left", alignment: "left" },
    { header: "Center", alignment: "center" },
    { header: "Right", alignment: "right" }
  ]
});

// 任意值类型 — 自动转为字符串
Markdown.format(["Name", "Age", "Active"], [["Alice", 30, true]]);
```

### Workbook 集成

```typescript
import { Workbook, Cell } from "documonster/excel";
import {
  readMarkdown,
  writeMarkdown,
  readMarkdownAll,
  readMarkdownFile,
  writeMarkdownFile
} from "documonster/excel/markdown";

const workbook = Workbook.create();

// 读取 Markdown → 工作表
const ws = readMarkdown(workbook, "| Name | Age |\n| --- | --- |\n| Alice | 30 |");
console.log(Cell.getValue(ws, "A2")); // "Alice"

// 工作表 → Markdown
const markdownText = writeMarkdown(workbook);

// 从文档中读取所有表格
const sheets = readMarkdownAll(workbook, markdownDoc, { sheetName: "Table" });
// 创建 "Table"、"Table_2"、"Table_3"、……

// 文件 I/O(仅限 Node.js)
await readMarkdownFile(workbook, "data.md");
await writeMarkdownFile(workbook, "output.md");
```

---

## 解析 API

### `Markdown.parse(input, options?)`

解析输入字符串中找到的第一个 Markdown 表格。

```text
Markdown.parse(input: string, options?: MarkdownParseOptions): MarkdownParseResult
```

若未找到有效表格,则抛出 `MarkdownParseError`。

### `Markdown.parseAll(input, options?)`

解析文档中的所有 Markdown 表格。

```text
Markdown.parseAll(input: string, options?: MarkdownParseOptions): MarkdownParseResult[]
```

若未找到任何表格,则返回空数组。

**解析选项(`MarkdownParseOptions`):**

| 选项 | 类型 | 默认值 | 描述 |
| --------------- | --------- | ------- | -------------------------- | ------------- |
| `trim` | `boolean` | `true` | 去除单元格值的首尾空白 |
| `unescape` | `boolean` | `true` | 反转义 `\|` → `           |`以及`\\`→`\` |
| `skipEmptyRows` | `boolean` | `true` | 跳过所有单元格均为空的行 |
| `maxRows` | `number` | — | 最大解析数据行数(不含表头) |
| `convertBr` | `boolean` | `false` | 将 `<br>` 标签转换为换行符 |

**结果(`MarkdownParseResult`):**

```typescript
interface MarkdownParseResult {
  headers: string[]; // 表头行中的列名
  rows: string[][]; // 数据行(每行 = 单元格值数组)
  alignments: MarkdownAlignment[]; // "left" | "center" | "right" | "none"
}
```

---

## 格式化 API

### `Markdown.format(headers, rows, options?)`

将数据格式化为 Markdown 表格字符串。

```text
Markdown.format(headers: string[], rows: unknown[][], options?: MarkdownFormatOptions): string
```

**格式化选项(`MarkdownFormatOptions`):**

| 选项 | 类型 | 默认值 | 描述 |
| ----------------- | ------------------------------------ | -------- | -------------------------- | ------ |
| `columns` | `(string \| MarkdownColumnConfig)[]` | — | 每列的表头与对齐配置 |
| `alignment` | `MarkdownAlignment` | `"left"` | 所有列的默认对齐方式 |
| `padding` | `boolean` | `true` | 用填充将各列对齐到相等宽度 |
| `trailingNewline` | `boolean` | `true` | 在输出中包含末尾换行符 |
| `escapeContent` | `boolean` | `true` | 转义单元格内容中的 `      |`与`\` |
| `stringify` | `(value: unknown) => string` | 内置 | 自定义值到字符串的转换器 |

**列配置(`MarkdownColumnConfig`):**

```typescript
interface MarkdownColumnConfig {
  header: string;
  alignment?: MarkdownAlignment; // "left" | "center" | "right" | "none"
  minWidth?: number; // 最小列宽(默认:3)
}
```

---

## 多行单元格

单元格内容中的换行符在格式化时会转换为 `<br>` 标签,并可在解析时通过 `convertBr: true` 转换回换行符。

```typescript
// 格式化:换行符变为 <br>
Markdown.format(["Note"], [["Line 1\nLine 2"]]);
// | Note           |
// | -------------- |
// | Line 1<br>Line 2 |

// 解析:<br> 转回换行符
Markdown.parse(table, { convertBr: true });
// rows[0] = ["Line 1\nLine 2"]
```

---

## CJK / Unicode 宽度

在计算列宽时,格式化器会自动考虑 CJK 字符、全角字符以及 emoji,无需任何外部依赖。

```typescript
Markdown.format(["Name", "名前"], [["Alice", "太郎"]]);
// | Name  | 名前 |
// | ----- | ---- |
// | Alice | 太郎 |
```

---

## 错误

```typescript
import { Markdown } from "documonster/markdown";
import { MarkdownParseError } from "documonster/markdown";

try {
  Markdown.parse("no table here");
} catch (e) {
  if (e instanceof MarkdownParseError) {
    console.log(e.message); // "Line 1: No valid Markdown table found in input"
    console.log(e.line); // 1
  }
}
```

---

## Workbook 方法

| 方法                                  | 平台    | 描述                        |
| ------------------------------------- | ------- | --------------------------- |
| `readMarkdown(input, options?)`       | 全部    | 解析 Markdown 表格 → 工作表 |
| `readMarkdownAll(input, options?)`    | 全部    | 解析所有表格 → Worksheet[]  |
| `writeMarkdown(options?)`             | 全部    | 工作表 → Markdown 字符串    |
| `writeMarkdownBuffer(options?)`       | 全部    | 工作表 → Uint8Array(UTF-8)  |
| `readMarkdownFile(path, options?)`    | Node.js | 从文件读取                  |
| `readMarkdownAllFile(path, options?)` | Node.js | 从文件读取所有表格          |
| `writeMarkdownFile(path, options?)`   | Node.js | 写入文件                    |

**Workbook 选项(`MarkdownOptions`)** 同时继承 `MarkdownParseOptions` 与 `MarkdownFormatOptions`,并额外包含:

| 选项               | 类型                         | 描述                                      |
| ------------------ | ---------------------------- | ----------------------------------------- |
| `sheetName`        | `string`                     | 工作表名称(对 `readMarkdownAll`:用作前缀) |
| `sheetId`          | `number`                     | 要写入的工作表 ID                         |
| `map`              | `(value, column) => unknown` | 解析时的自定义值映射器                    |
| `dateFormat`       | `string`                     | 写入时的日期格式                          |
| `dateUTC`          | `boolean`                    | 日期使用 UTC                              |
| `includeEmptyRows` | `boolean`                    | 在输出中包含空行                          |
