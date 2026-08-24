# XML 模块

[English](README.md)

零依赖、跨平台的 XML 工具包，支持流式和缓冲两种模式的读写。

```typescript
import { Xml } from "documonster/xml";
```

## 功能特性

- **零依赖** — 纯 TypeScript，无原生插件
- **跨平台** — Node.js 和浏览器使用相同 API
- **双模式写入** — 缓冲式（`Xml.Writer`）和流式（`Xml.StreamWriter`）
- **双模式读取** — SAX 流式（`Xml.SaxParser`）和 DOM 树（`Xml.parse`）
- **共享接口** — `XmlSink` 让渲染代码可以透明地同时适配两种写入模式
- **XML 编码** — 快速实体编码/解码，支持特殊字符处理
- **命名空间支持** — 完整的 XML 命名空间：前缀解析、保留命名空间强制、未绑定前缀检测
- **查询引擎** — 简化路径表达式，用于查询 DOM 树
- **安全加固** — 实体扩展限制、嵌套深度限制、重复属性拒绝、名称注入防护、BOM 处理

---

## 快速开始

### 写入 XML（缓冲模式）

```typescript
import { Xml } from "documonster/xml";

const w = new Xml.Writer();
w.openXml(Xml.StdDocAttributes);
w.openNode("root", { version: "1.0" });
w.leafNode("item", { id: "1" }, "hello");
w.leafNode("item", { id: "2" }, "world");
w.closeNode();

console.log(w.xml);
// <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
// <root version="1.0"><item id="1">hello</item><item id="2">world</item></root>
```

### 写入 XML（流式模式）

```text
import { Xml } from "documonster/xml";

const chunks: string[] = [];
const target = { write: (chunk: string) => chunks.push(chunk) };
const sw = new Xml.StreamWriter(target);

sw.openXml();
sw.openNode("root");
sw.leafNode("item", { id: "1" }, "hello");
sw.closeNode();
// 每次方法调用都直接写入 target — 无缓冲
```

### 读取 XML（SAX — 流式）

```text
import { Xml } from "documonster/xml";

const parser = new Xml.SaxParser();
parser.on("opentag", tag => console.log("open:", tag.name, tag.attributes));
parser.on("text", text => console.log("text:", text));
parser.on("closetag", tag => console.log("close:", tag.name));
parser.write('<root><item id="1">hello</item></root>');
parser.close();
```

### 读取 XML（DOM — 缓冲模式）

```text
import { Xml } from "documonster/xml";

const doc = Xml.parse('<root><item id="1">hello</item></root>');
const item = Xml.findChild(doc.root, "item");
console.log(Xml.attr(item!, "id")); // "1"
console.log(Xml.textContent(item!)); // "hello"
```

### XML 转换为普通对象

将 XML 转换为普通 JavaScript 对象。

两种入口适用于不同场景：

```text
import { Xml } from "documonster/xml";

// 方式 1：已有 DOM 树
const doc = Xml.parse('<root attr="1"><item>a</item><item>b</item></root>');
const obj = Xml.toPlainObject(doc.root);
// { root: { "@_attr": "1", item: ["a", "b"] } }

// 方式 2：XML 字符串直接转换为普通对象（更快，单次 SAX 遍历）
const obj2 = Xml.parseToObject('<root attr="1"><item>a</item><item>b</item></root>');
// 输出相同，中大型 XML 约快 1.6 倍
```

**如何选择：**

- `Xml.toPlainObject(element)` — 当你已经通过 `Xml.parse()` 获得了 `XmlElement`
- `Xml.parseToObject(xml)` — 当你只需要普通对象（跳过 DOM 分配）

**默认转换规则：**

- 属性以 `@_` 为前缀
- 重复的同级元素合并为数组
- 纯文本元素折叠为字符串值
- 空元素变为 `""`
- 仅含空白的缩进文本默认丢弃

**局限性：** 普通对象转换是有损的 — 不保留元素顺序、注释或处理指令。如需精确的 XML 结构，请使用 `Xml.parse()` 并直接操作 DOM 树。

### 查询引擎

```typescript
import { Xml } from "documonster/xml";

const doc = Xml.parse("<root><a><b>1</b><b>2</b></a><a><b>3</b></a></root>");
const first = Xml.query(doc.root, "a/b"); // 第一个 <b> 元素
const all = Xml.queryAll(doc.root, "a/b"); // 所有 <b> 元素
const indexed = Xml.queryAll(doc.root, "a/b[0]"); // 每个 <a> 下的第一个 <b>
const filtered = Xml.query(doc.root, "a/b[@id='x']"); // id="x" 的 <b>
const deep = Xml.queryAll(doc.root, "a//b"); // <a> 下任意深度的 <b>
```

### 编码/解码

```typescript
import { Xml } from "documonster/xml";

Xml.encode('<tag attr="val">'); // "&lt;tag attr=&quot;val&quot;&gt;"
Xml.decode("&lt;hello&gt;"); // "<hello>"
```

---

## 架构

```
src/modules/xml/
├── types.ts              # 核心类型（XmlNode、XmlSink、SaxTag 等）
├── errors.ts             # XmlError、XmlParseError、XmlWriteError
├── encode.ts             # Xml.encode、Xml.decode、Xml.validateXmlName、Xml.encodeCData 等
├── writer.ts             # Xml.Writer（缓冲式，支持回滚）
├── stream-writer.ts      # Xml.StreamWriter（流式，写入 WritableTarget）
├── sax.ts                # Xml.SaxParser（事件驱动）+ Xml.parseSax（异步生成器）
├── dom.ts                # Xml.parse + DOM 查询辅助函数 + Xml.toPlainObject
├── to-object.ts          # Xml.parseToObject（SAX 直接转换，单次遍历）
├── to-object-shared.ts   # 共享转换逻辑（内部使用）
├── query.ts              # 简化路径查询引擎
├── index.ts              # 公开 API barrel
└── __tests__/            # 测试
```

### 写入路径

```
XmlSink（接口）
├── Xml.Writer        — 在内存中构建 XML 字符串
│                      支持回滚/事务（save/commit/rollback）
│                      适用于：中小型 XML、试探性写入
│
└── Xml.StreamWriter  — 直接写入 WritableTarget
                       O(1) 内存 — 不持有完整文档
                       适用于：大型 XML（10万+ 行的工作表）
```

### 读取路径

```
Xml.SaxParser        — 事件驱动的流式解析器
│                      通过 write() 输入数据块，事件同步触发
│                      适用于：大型 XML、只需特定元素时
│
├── Xml.parse        — 构建 DOM 树（XmlDocument/XmlElement）
│   │                  基于 Xml.SaxParser 构建 — 无重复解析逻辑
│   │                  适用于：中小型 XML、需要树遍历时
│   │
│   └── Xml.toPlainObject — 将 XmlElement DOM 转换为普通 JS 对象
│                       适用于：已有 DOM 树时
│
├── Xml.parseToObject — SAX 直接转换为普通 JS 对象（单次遍历，无 DOM）
│                      比 Xml.parse + Xml.toPlainObject 快约 1.6 倍
│                      适用于：XML 字符串 → 普通对象 → JSON.stringify
│
└── Xml.parseSax     — 包装 Xml.SaxParser 的异步生成器，用于流式迭代
                       适用于：异步管道（如从 zip 流中读取）
```

---

## API 参考

### Xml.Writer

| 方法                            | 描述                      |
| ------------------------------- | ------------------------- |
| `openXml(attrs?)`               | 写入 `<?xml ...?>` 声明   |
| `openNode(name, attrs?)`        | 打开一个元素              |
| `closeNode()`                   | 关闭最近打开的元素        |
| `leafNode(name, attrs?, text?)` | 一次调用写入一个完整元素  |
| `addAttribute(name, value)`     | 为当前打开的元素添加属性  |
| `addAttributes(attrs)`          | 添加多个属性              |
| `writeText(text)`               | 写入转义后的文本内容      |
| `writeRaw(xml)`                 | 写入预转义的 XML          |
| `writeCData(text)`              | 写入 `<![CDATA[...]]>` 节 |
| `writeComment(text)`            | 写入 `<!--...-->` 注释    |
| `closeAll()`                    | 关闭所有打开的元素        |
| `toString()` / `xml`            | 获取构建的 XML 字符串     |
| `save()`                        | 保存回滚快照              |
| `commit()`                      | 丢弃快照（保留更改）      |
| `rollback()`                    | 恢复到快照（丢弃更改）    |
| `reset()`                       | 清除所有内容              |
| `depth`                         | 当前嵌套深度              |
| `currentElement`                | 最内层打开的元素名        |
| `cursor`                        | 单调递增位置计数器        |

### Xml.StreamWriter

与 `Xml.Writer` 方法相同（都实现 `XmlSink`），区别在于：

- 无 `toString()` / `xml` — 内容已写入目标
- 无 `save()` / `commit()` / `rollback()` — 流式写入不可逆
- 无 `cursor` — 流式模式不适用

### Xml.SaxParser

| 方法 / 属性          | 描述                        |
| -------------------- | --------------------------- |
| `write(chunk)`       | 输入 XML 文本（可多次调用） |
| `close()`            | 信号输入结束                |
| `on(event, handler)` | 注册事件处理器              |
| `off(event)`         | 移除事件处理器              |
| `line` / `column`    | 当前位置（启用位置追踪时）  |
| `closed`             | 解析器是否已关闭            |

**事件：** `opentag`、`closetag`、`text`、`cdata`、`comment`、`pi`、`error`

**选项：**

| 选项                  | 默认值    | 描述                             |
| --------------------- | --------- | -------------------------------- |
| `position`            | `true`    | 追踪行/列位置用于错误信息        |
| `fragment`            | `false`   | 允许多个根元素                   |
| `xmlns`               | `false`   | 启用命名空间处理                 |
| `maxDepth`            | `256`     | 最大元素嵌套深度                 |
| `maxEntityExpansions` | `10000`   | 最大实体扩展次数（XML 炸弹防御） |
| `invalidCharHandling` | `"error"` | 如何处理无效 XML 字符（见下文）  |
| `fileName`            | —         | 用于错误信息的文件名             |

### Xml.parseSax（异步生成器）

```text
Xml.parseSax(
  iterable: AsyncIterable<string | Uint8Array | ArrayBuffer>,
  options?: SaxOptions
): AsyncGenerator<SaxEventAny[]>
```

### Xml.parse

```text
Xml.parse(xml: string, options?: XmlParseOptions): XmlDocument;
```

**选项：**

| 选项                     | 默认值    | 描述                                      |
| ------------------------ | --------- | ----------------------------------------- |
| `comments`               | `false`   | 在 DOM 树中包含注释节点                   |
| `processingInstructions` | `false`   | 在 DOM 树中包含处理指令节点               |
| `cdataAsNodes`           | `false`   | 保留 CDATA 为显式节点（而非合并到文本中） |
| `fragment`               | `false`   | 允许多个根元素                            |
| `xmlns`                  | `false`   | 启用命名空间处理                          |
| `maxDepth`               | `256`     | 最大元素嵌套深度                          |
| `maxEntityExpansions`    | `10000`   | 最大实体扩展次数                          |
| `invalidCharHandling`    | `"error"` | 如何处理无效 XML 字符（见下文）           |

**返回值：** `XmlDocument`，包含：

| 字段          | 类型                                            | 描述                                          |
| ------------- | ----------------------------------------------- | --------------------------------------------- |
| `root`        | `XmlElement`                                    | 第一个（或唯一的）根元素                      |
| `roots`       | `XmlElement[]`                                  | 所有根级元素（fragment 模式下有用）           |
| `declaration` | `Record<string, string> \| undefined`           | XML 声明属性（version、encoding、standalone） |
| `prologue`    | `Array<XmlComment \| XmlProcessingInstruction>` | 顶级注释和处理指令（通过选项启用时）          |

### DOM 辅助函数

| 函数                         | 描述                   |
| ---------------------------- | ---------------------- |
| `Xml.findChild(el, name)`    | 按名称查找第一个子元素 |
| `Xml.findChildren(el, name)` | 按名称查找所有子元素   |
| `Xml.textContent(node)`      | 递归获取文本内容       |
| `Xml.attr(el, name)`         | 获取属性值             |
| `Xml.walk(el, visitor)`      | 深度优先遍历           |

### Xml.toPlainObject

```text
Xml.toPlainObject(
  element: XmlElement,
  options?: ToPlainObjectOptions
): Record<string, unknown>;
```

将 `XmlElement` DOM 树转换为普通 JavaScript 对象。

### Xml.parseToObject

```text
Xml.parseToObject(xml: string, options?: ParseXmlToObjectOptions): Record<string, unknown>;
```

将 XML 字符串在单次 SAX 遍历中直接转换为普通 JavaScript 对象。中大型 XML 比 `Xml.parse()` + `Xml.toPlainObject()` 快约 1.6 倍。

**转换选项**（两个函数共用）：

| 选项                   | 默认值    | 描述                                                 |
| ---------------------- | --------- | ---------------------------------------------------- |
| `ignoreAttributes`     | `false`   | 完全丢弃所有属性                                     |
| `attributePrefix`      | `"@_"`    | 属性键前缀（`""` 表示不加前缀）                      |
| `textKey`              | `"#text"` | 混合内容元素中文本内容的键名                         |
| `alwaysArray`          | `false`   | 始终将子元素包装在数组中                             |
| `isArray`              | —         | 回调 `(name) => boolean`，按标签名决定是否包装为数组 |
| `preserveCData`        | `true`    | 在文本中包含 CDATA 值（与 `cdataAsNodes` 相关）      |
| `ignoreWhitespaceText` | `true`    | 丢弃含有子元素的元素中仅含空白的文本                 |

**解析器选项**（仅 `Xml.parseToObject`）：

| 选项                  | 默认值    | 描述                             |
| --------------------- | --------- | -------------------------------- |
| `fragment`            | `false`   | 允许多个根元素                   |
| `maxDepth`            | `256`     | 最大元素嵌套深度                 |
| `maxEntityExpansions` | `10000`   | 最大实体扩展次数（XML 炸弹防御） |
| `invalidCharHandling` | `"error"` | 如何处理无效 XML 字符（见下文）  |

### 查询引擎

```typescript
import { Xml } from "documonster/xml";
```

| 语法           | 描述                               |
| -------------- | ---------------------------------- |
| `a/b/c`        | 匹配子元素 `a`，然后 `b`，然后 `c` |
| `a/b[@id='1']` | 匹配 `id` 属性等于 `"1"` 的 `b`    |
| `a/*/c`        | 通配符：该层级的任意元素名         |
| `a//c`         | 递归下降：`a` 下任意深度的 `c`     |
| `a/b[0]`       | 索引：每个父级 `a` 下的第一个 `b`  |

- `Xml.query(element, path)` — 第一个匹配项或 `undefined`
- `Xml.queryAll(element, path)` — 所有匹配项（可能为空）

索引过滤器使用**逐父级语义**：`a/b[0]` 返回每个 `a` 下的第一个 `b`，而非全局第一个 `b`。

### 编码工具

| 函数                            | 描述                                             |
| ------------------------------- | ------------------------------------------------ |
| `Xml.encode(text)`              | 编码 XML 内容中的文本（`<`、`>`、`&`、`"`、`'`） |
| `Xml.decode(text)`              | 将 XML 实体解码回文本                            |
| `Xml.encodeAttr(value)`         | 编码属性值（与 `Xml.encode` 相同）               |
| `Xml.validateXmlName(name)`     | 验证 XML 元素/属性名                             |
| `Xml.validateCommentText(text)` | 验证 XML 注释内容文本                            |
| `Xml.encodeCData(text)`         | 编码 CDATA 节的文本（拆分 `]]>`）                |

### 错误类型

| 类              | 父类        | 使用场景               |
| --------------- | ----------- | ---------------------- |
| `XmlError`      | `BaseError` | 编码/验证              |
| `XmlParseError` | `XmlError`  | SAX 解析器、DOM 解析器 |
| `XmlWriteError` | `XmlError`  | 写入器（状态错误）     |

所有错误都继承自 `XmlError`，因此 `catch (e) { if (e instanceof XmlError) ... }` 可以捕获 XML 模块的所有错误。

---

## 命名空间支持

当启用 `xmlns: true` 时：

- **前缀解析** — 元素和属性的 QName 被解析为 `{ prefix, local, uri }`
- **预绑定前缀** — `xml` 预绑定到 `http://www.w3.org/XML/1998/namespace`，`xmlns` 预绑定到 `http://www.w3.org/2000/xmlns/`
- **保留命名空间强制** — 不能将 `xml` 重新绑定到不同的 URI，不能重新绑定 `xmlns`，不能将其他前缀绑定到保留 URI
- **未绑定前缀检测** — 使用未声明前缀的元素和属性会产生错误
- **扩展名称重复检测** — 两个属性具有不同前缀但相同 URI + 本地名时被拒绝
- **多冒号 QName 拒绝** — 命名空间模式下 `<a:b:c/>` 被拒绝
- **作用域管理** — 命名空间声明遵循 XML 作用域规则（被后代继承，可在子元素中覆盖）

注意：根据 XML 命名空间规范 §6.2，无前缀的属性**不**继承默认命名空间。

---

## 安全

- **实体扩展限制** — 防止 XML 炸弹攻击（可通过 `maxEntityExpansions` 配置）
- **嵌套深度限制** — 防止深度嵌套 XML 导致的栈溢出（可通过 `maxDepth` 配置）
- **重复属性拒绝** — XML 1.0 §3.1 WFC: Unique Att Spec（报告错误，以最后一个值恢复）
- **名称注入防护** — 写入器通过 `Xml.validateXmlName()` 验证元素和属性名
- **注释/CDATA 安全** — `Xml.validateCommentText()` 拒绝 `--`，`Xml.encodeCData()` 拆分 `]]>`
- **BOM 处理** — 输入开头的 UTF-8 BOM 被静默去除
- **原型污染防护** — DOM 属性映射使用空原型对象并过滤危险键
- **无效字符处理** — 写入器通过 `Xml.encode()` 去除无效 XML 1.0 字符；解析器行为可通过 `invalidCharHandling` 配置

---

## 无效字符处理

实际的 XML 数据（尤其来自第三方 XLSX 文件）可能包含 XML 1.0 规范中无效的字符 — 例如 `0x7F`（DEL）、`0x01`–`0x08`、`0x0B`、`0x0C`、`0x0E`–`0x1F`、孤立代理项，以及非字符 `U+FFFE`/`U+FFFF`。

`invalidCharHandling` 选项控制解析器的响应方式：

| 值          | 行为                                      |
| ----------- | ----------------------------------------- |
| `"error"`   | 通过错误处理器报告或抛出异常 **（默认）** |
| `"skip"`    | 静默丢弃无效字符                          |
| `"replace"` | 替换为 U+FFFD（Unicode 替换字符）         |

### 示例

```typescript
import { Xml } from "documonster/xml";

// 默认：严格模式 — 遇到 0x7F 时抛出异常
Xml.parse("<root>hello\x7fworld</root>");
// => XmlParseError: invalid XML character: 0x7f

// skip 模式 — 无效字符被移除
const doc = Xml.parse("<root>hello\x7fworld</root>", { invalidCharHandling: "skip" });
// doc.root 文本内容: "helloworld"

// replace 模式 — 无效字符变为 U+FFFD
const doc2 = Xml.parse("<root>hello\x7fworld</root>", { invalidCharHandling: "replace" });
// doc.root 文本内容: "hello\uFFFDworld"

// SAX 解析器使用 skip 模式
const parser = new Xml.SaxParser({ invalidCharHandling: "skip" });
parser.on("text", text => console.log(text)); // "helloworld"
parser.write("<root>hello\x7fworld</root>");
parser.close();
```

### 如何选择

- **`"error"`（默认）** — 用于严格的 XML 验证、测试，或当你控制 XML 来源时。
- **`"skip"`** — 用于读取不可信/脏数据 XML（如第三方 XLSX 文件），需要静默丢弃无效字符时。这是 Excel XLSX 读取器内部使用的模式。
- **`"replace"`** — 用于需要保留无效字符*位置*的场景（如诊断或数据取证），同时不让解析器崩溃。

> **注意：** XML _写入器_（`Xml.Writer`、`Xml.StreamWriter`）始终通过 `Xml.encode()` 去除无效字符 — 此选项仅影响*解析器*。
