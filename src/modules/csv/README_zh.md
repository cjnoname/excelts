# CSV 模块

[English](README.md)

高性能、RFC 4180 兼容的 CSV 解析器和格式化器，零依赖。

```typescript
import { Csv } from "documonster/csv";
// Csv.parse, Csv.format, Csv.ParserStream, …
```

## 功能特性

- **RFC 4180 兼容** — 完整规范支持，包括多行字段、引号字段和边界情况
- **零依赖** — 纯 TypeScript，无外部包
- **跨平台** — Node.js 和浏览器使用相同 API
- **高性能** — 基于 indexOf 的扫描器、快速模式检测、批处理
- **流式处理** — `Csv.ParserStream` / `Csv.FormatterStream` 处理大文件
- **类型安全** — 完整的 TypeScript 泛型和重载签名
- **自动检测** — 分隔符、换行符和 BOM 检测
- **动态类型** — 自动类型转换（数字、布尔值、日期）
- **数据生成** — 内置 CSV 测试数据生成器，支持种子 PRNG 保证可复现性

---

## 快速开始

### 解析

```typescript
import { Csv } from "documonster/csv";

// 简单用法：返回 string[][]
const rows = Csv.parse("name,age\nAlice,30\nBob,25");
// [["name","age"], ["Alice","30"], ["Bob","25"]]

// 使用表头：返回 { rows, headers, meta, errors }
const result = Csv.parse("name,age\nAlice,30\nBob,25", { headers: true });
// result.rows = [{ name: "Alice", age: "30" }, { name: "Bob", age: "25" }]
// result.headers = ["name", "age"]

// 动态类型：自动转换数字、布尔值、日期
const typed = Csv.parse("name,age,active\nAlice,30,true", {
  headers: true,
  dynamicTyping: true
});
// typed.rows = [{ name: "Alice", age: 30, active: true }]
```

### 格式化

```typescript
import { Csv } from "documonster/csv";

// 从数组
Csv.format([
  ["name", "age"],
  ["Alice", "30"]
]);
// "name,age\nAlice,30"

// 从对象（自动推导表头）
Csv.format([
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 }
]);
// "name,age\nAlice,30\nBob,25"

// 使用选项
Csv.format(data, {
  delimiter: ";",
  bom: true,
  escapeFormulae: true,
  quoteColumns: { name: true }
});
```

---

## 解析 API

### `Csv.parse(input, options?)`

同步 CSV 解析器，支持类型安全的重载。

```text
// 无选项 -> string[][]
Csv.parse(csvString): string[][];

// headers: true -> CsvParseResult<Record<string, unknown>>
Csv.parse(csvString, { headers: true }): CsvParseResult;

// headers: true + dynamicTyping -> 自动类型转换的值
Csv.parse(csvString, { headers: true, dynamicTyping: true }): CsvParseResult;

// info: true -> 行包含元数据（行号、原始输入等）
Csv.parse(csvString, { headers: true, info: true }): CsvParseResult<RecordWithInfo>;
```

**解析选项（`CsvParseOptions`）：**

| 选项             | 类型                                             | 默认值        | 描述                                    |
| ---------------- | ------------------------------------------------ | ------------- | --------------------------------------- |
| `delimiter`      | `string`                                         | 自动检测      | 字段分隔符（`,`、`;`、`\t`、`\|`）      |
| `headers`        | `boolean \| string[] \| HeaderTransformFunction` | `false`       | 使用第一行作为表头，或提供自定义表头    |
| `quote`          | `string \| false`                                | `"`           | 引号字符（`false` 禁用）                |
| `escape`         | `string \| false`                                | 与 quote 相同 | 引号字段内的转义字符                    |
| `comment`        | `string`                                         | -             | 注释行前缀（如 `"#"`）                  |
| `skipEmptyLines` | `boolean \| "greedy"`                            | `false`       | 跳过空行；`"greedy"` 也跳过仅含空白的行 |
| `skipLines`      | `number`                                         | `0`           | 解析前跳过的行数                        |
| `maxRows`        | `number`                                         | -             | 最大解析行数                            |
| `dynamicTyping`  | `boolean \| DynamicTypingConfig`                 | `false`       | 自动转换为数字/布尔值/日期              |
| `castDate`       | `boolean \| CastDateConfig`                      | `false`       | 将日期字符串解析为 Date 对象            |
| `transform`      | `RowTransformFunction`                           | -             | 输出前转换每一行                        |
| `validate`       | `RowValidateFunction`                            | -             | 验证行；无效行进入 `errors`             |
| `columns`        | `ColumnConfig[]`                                 | -             | 按列的类型/转换配置                     |
| `objname`        | `string`                                         | -             | 按特定列值作为行的键                    |
| `encoding`       | `string`                                         | `"utf-8"`     | 输入编码                                |
| `info`           | `boolean`                                        | `false`       | 每行包含行/记录元数据                   |
| `fastMode`       | `boolean`                                        | 自动          | 强制快速模式解析（不处理引号）          |
| `renameHeaders`  | `boolean`                                        | `false`       | 自动重命名重复表头                      |
| `columnMismatch` | `ColumnMismatchConfig`                           | -             | 处理列数与表头不匹配的行                |

**结果（`CsvParseResult<T>`）：**

```typescript
interface CsvParseResult<T> {
  rows: T[];
  headers: string[];
  meta: CsvParseMeta; // { delimiter, linebreak, rowCount, truncated }
  errors: CsvRecordError[];
  invalidRows: T[];
}
```

### `Csv.parseAsync(input, options?)`

异步解析器，支持字符串、`AsyncIterable<string | Uint8Array>` 和 `ReadableStream`。

```typescript
import { Csv } from "documonster/csv";

// 从字符串
const result = await Csv.parseAsync(csvString, { headers: true });

// 从 ReadableStream（浏览器 fetch）
const response = await fetch("/data.csv");
const result = await Csv.parseAsync(response.body, { headers: true });

// 从异步可迭代对象
const result = await Csv.parseAsync(asyncChunks, { headers: true });
```

### `Csv.parseRows(input, options?)`

真正的流式异步生成器 — 逐行产出。适合大文件的内存高效处理。

```typescript
import { Csv } from "documonster/csv";

for await (const row of Csv.parseRows(hugeFile, { headers: true })) {
  console.log(row); // { name: "...", age: "..." }
}
```

### `Csv.parseWithProgress(input, options?, onProgress?)`

带进度回调的异步解析器，适合大文件。

```typescript
import { Csv } from "documonster/csv";

const result = await Csv.parseWithProgress(
  largeCsvString,
  { headers: true },
  ({ rowsProcessed, bytesProcessed }) => {
    console.log(`已解析 ${rowsProcessed} 行（${bytesProcessed} 字节）`);
  }
);
```

---

## 格式化 API

### `Csv.format(data, options?)`

批量 CSV 格式化器。接受数组的数组或对象的数组。

```typescript
import { Csv } from "documonster/csv";

// 数组的数组
Csv.format([
  ["a", "b"],
  [1, 2]
]);

// 对象的数组
Csv.format([{ name: "Alice", age: 30 }]);

// RowHashArray 格式
Csv.format([
  [
    ["name", "Alice"],
    ["age", "30"]
  ]
]);
```

**格式化选项（`CsvFormatOptions`）：**

| 选项              | 类型                                              | 默认值        | 描述                                        |
| ----------------- | ------------------------------------------------- | ------------- | ------------------------------------------- |
| `delimiter`       | `string`                                          | `,`           | 字段分隔符                                  |
| `headers`         | `boolean \| string[]`                             | 自动          | 包含表头；从对象自动推导                    |
| `quote`           | `string \| false`                                 | `"`           | 引号字符                                    |
| `escape`          | `string`                                          | 与 quote 相同 | 转义字符                                    |
| `quoteColumns`    | `boolean \| boolean[] \| Record<string, boolean>` | 自动          | 按列强制引用                                |
| `escapeFormulae`  | `boolean`                                         | `false`       | 公式字符（`=`、`+`、`-`、`@`）前加 `'` 前缀 |
| `bom`             | `boolean`                                         | `false`       | 前置 UTF-8 BOM                              |
| `columns`         | `ColumnConfig[]`                                  | -             | 按列的格式化配置                            |
| `transform`       | `RowTransformFunction`                            | -             | 格式化前转换行                              |
| `trailingNewline` | `boolean`                                         | `false`       | 添加尾部换行符                              |

---

## 流式 API

### `Csv.ParserStream`

转换流，逐块解析 CSV 数据。跨平台（Node.js + 浏览器）。

```typescript
import { Csv } from "documonster/csv";
import { pipeline } from "documonster/stream";

// 使用工厂函数
const parser = Csv.createParserStream({ headers: true, dynamicTyping: true });

// 使用类构造函数
const parser = new Csv.ParserStream({ headers: true });

// 使用转换和验证
parser.transform(row => ({ ...row, age: Number(row.age) })).validate(row => row.age > 0);

// 事件
parser.on("headers", headers => console.log("表头:", headers));
parser.on("data", row => console.log("行:", row));
parser.on("data-invalid", row => console.log("无效:", row));
parser.on("end", () => console.log("完成"));

// 管道用法
await pipeline(readableStream, parser, writable);
```

### `Csv.FormatterStream`

转换流，将行格式化为 CSV 文本。跨平台（Node.js + 浏览器）。

```typescript
import { Csv } from "documonster/csv";

const formatter = Csv.createFormatterStream({
  headers: ["name", "age"],
  delimiter: ";",
  bom: true
});

formatter.write(["Alice", 30]);
formatter.write(["Bob", 25]);
formatter.end();

// 将输出管道到文件或可写流
formatter.pipe(writable);
```

---

## 检测工具

```typescript
import { Csv } from "documonster/csv";

// 从 CSV 内容自动检测分隔符
Csv.detectDelimiter("a,b,c\n1,2,3"); // ","
Csv.detectDelimiter("a;b;c\n1;2;3"); // ";"
Csv.detectDelimiter("a\tb\tc\n1\t2\t3"); // "\t"

// 检测行终止符（引号感知）
Csv.detectLinebreak("a,b\r\nc,d"); // "\r\n"
Csv.detectLinebreak("a,b\nc,d"); // "\n"

// 去除 UTF-8 BOM
Csv.stripBom("\ufeffname,age"); // "name,age"
```

---

## 行工具

```typescript
import { Csv } from "documonster/csv";

// 检查行是否为 RowHashArray
Csv.isRowHashArray([["key", "value"]]); // true

// 去重表头名称
Csv.deduplicateHeaders(["id", "name", "name", "name"]);
// ["id", "name", "name_1", "name_2"]
```

---

## 动态类型

```typescript
import { Csv } from "documonster/csv";

// 将字符串值自动转换为原生类型
Csv.applyDynamicTyping("42"); // 42（number）
Csv.applyDynamicTyping("3.14"); // 3.14（number）
Csv.applyDynamicTyping("true"); // true（boolean）
Csv.applyDynamicTyping("hello"); // "hello"（string，不变）
```

---

## 数字工具

```typescript
import { Csv } from "documonster/csv";

// 使用区域特定的小数分隔符格式化数字
Csv.formatNumber(3.14, "."); // "3.14"
Csv.formatNumber(3.14, ","); // "3,14"

// 使用区域特定的小数分隔符解析数字
Csv.parseNumber("3,14", ","); // 3.14
```

---

## CSV 数据生成器

生成测试 CSV 数据，内置列类型和种子 PRNG 保证可复现性。

```typescript
import { Csv } from "documonster/csv";

// 生成 CSV 字符串
const { csv, headers, data } = Csv.generate({
  columns: ["name", "email", "int", "bool", "date"],
  rows: 100,
  seed: 42
});

// 使用自定义列类型生成
const { csv } = Csv.generate({
  columns: [
    { type: "int", min: 18, max: 65, name: "age" },
    { type: "float", min: 0, max: 100, name: "score" },
    ctx => `row-${ctx.rowIndex}`
  ],
  rows: 50
});

// 内存高效：逐行产出
for (const row of Csv.generateRows({ columns: 5, rows: 1_000_000 })) {
  process.stdout.write(row + "\n");
}

// 按持续时间生成（无限行）
for (const row of Csv.generateRows({ columns: 3, duration: 5000 })) {
  // 生成 5 秒
}

// 异步生成器，行间有延迟
for await (const row of Csv.generateAsync({ columns: 5, rows: 100, delay: 10 })) {
  console.log(row);
}

// 生成原始数据（非 CSV 字符串）
const rawRows = Csv.generateData({ columns: ["name", "int"], rows: 10 });
// [[name, number], ...]

const objects = Csv.generateData({
  columns: [{ type: "name", name: "fullName" }],
  rows: 10,
  objectMode: true
});
// [{ fullName: "..." }, ...]

// 带预设配置的可复用生成器
const gen = Csv.createGenerator({ columns: ["name", "email"], seed: 42 });
const batch1 = gen.generate(100);
const batch2 = gen.generate(100);
```

**内置列类型：**
`string`、`int`、`float`、`bool`、`date`、`uuid`、`email`、`name`、`url`、`phone`、`address`、`ip`、`hex`、`lorem`

---

## 错误类

```typescript
import { Csv } from "documonster/csv";
import { CsvError, CsvWorkerError } from "documonster/csv";

try {
  Csv.parse(badInput, { headers: true });
} catch (e) {
  if (e instanceof CsvError) {
    console.error(e.message);
    console.error(e.cause); // 原始错误（如有）
  }
}
```

---

## API 参考

### 核心函数

| 函数                                                  | 描述                                     |
| ----------------------------------------------------- | ---------------------------------------- |
| `Csv.parse(input, options?)`                          | 同步 CSV 解析器                          |
| `Csv.parseAsync(input, options?)`                     | 异步解析器（字符串、流、异步可迭代对象） |
| `Csv.parseRows(input, options?)`                      | 异步生成器，逐行产出                     |
| `Csv.parseWithProgress(input, options?, onProgress?)` | 带进度报告的解析器                       |
| `Csv.format(data, options?)`                          | 批量 CSV 格式化器                        |

### 流类

| 类                                    | 描述                           |
| ------------------------------------- | ------------------------------ |
| `Csv.ParserStream`                    | 转换流：CSV 字节 -> 已解析的行 |
| `Csv.FormatterStream`                 | 转换流：行 -> CSV 文本         |
| `Csv.createParserStream(options?)`    | `Csv.ParserStream` 工厂函数    |
| `Csv.createFormatterStream(options?)` | `Csv.FormatterStream` 工厂函数 |

### 工具函数

| 函数                              | 描述                   |
| --------------------------------- | ---------------------- |
| `Csv.detectDelimiter(input)`      | 自动检测 CSV 分隔符    |
| `Csv.detectLinebreak(input)`      | 自动检测行终止符       |
| `Csv.stripBom(input)`             | 去除 UTF-8 BOM         |
| `Csv.applyDynamicTyping(value)`   | 将字符串转换为原生类型 |
| `Csv.formatNumber(value, sep)`    | 按区域格式化数字       |
| `Csv.parseNumber(value, sep)`     | 解析区域格式化的数字   |
| `Csv.deduplicateHeaders(headers)` | 重命名重复表头         |

### 生成器函数

| 函数                            | 描述                          |
| ------------------------------- | ----------------------------- |
| `Csv.generate(options?)`        | 生成 CSV 字符串 + 数据        |
| `Csv.generateRows(options?)`    | 同步生成器，逐行产出 CSV 行   |
| `Csv.generateAsync(options?)`   | 异步生成器，支持延迟          |
| `Csv.generateData(options?)`    | 生成原始数据（非 CSV 字符串） |
| `Csv.createGenerator(options?)` | 可复用的生成器工厂            |
