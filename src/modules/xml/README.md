# XML Module

[中文](README_zh.md)

A zero-dependency, cross-platform XML toolkit for reading and writing XML. Supports both streaming and buffered modes.

```typescript
import { Xml } from "documonster/xml";
```

## Features

- **Zero Dependencies** — Pure TypeScript, no native addons
- **Cross-Platform** — Same API in Node.js and browsers
- **Dual-Mode Writing** — Buffered (`Xml.Writer`) and streaming (`Xml.StreamWriter`)
- **Dual-Mode Reading** — SAX streaming (`Xml.SaxParser`) and DOM tree (`Xml.parse`)
- **Shared Interface** — `XmlSink` lets rendering code target both write modes transparently
- **XML Encoding** — Fast entity encode/decode with special character handling
- **Namespace Support** — Full XML Namespaces with prefix resolution, reserved namespace enforcement, and unbound prefix detection
- **Query Engine** — Simplified path expressions for querying DOM trees
- **Security Hardened** — Entity expansion limits, nesting depth limits, duplicate attribute rejection, name injection prevention, BOM handling

---

## Quick Start

### Writing XML (Buffered)

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

### Writing XML (Streaming)

```text
import { Xml } from "documonster/xml";

const chunks: string[] = [];
const target = { write: (chunk: string) => chunks.push(chunk) };
const sw = new Xml.StreamWriter(target);

sw.openXml();
sw.openNode("root");
sw.leafNode("item", { id: "1" }, "hello");
sw.closeNode();
// Each method call writes directly to target — no buffering
```

### Reading XML (SAX — Streaming)

```text
import { Xml } from "documonster/xml";

const parser = new Xml.SaxParser();
parser.on("opentag", tag => console.log("open:", tag.name, tag.attributes));
parser.on("text", text => console.log("text:", text));
parser.on("closetag", tag => console.log("close:", tag.name));
parser.write('<root><item id="1">hello</item></root>');
parser.close();
```

### Reading XML (DOM — Buffered)

```text
import { Xml } from "documonster/xml";

const doc = Xml.parse('<root><item id="1">hello</item></root>');
const item = Xml.findChild(doc.root, "item");
console.log(Xml.attr(item!, "id")); // "1"
console.log(Xml.textContent(item!)); // "hello"
```

### XML to Plain Object

Convert XML into plain JavaScript objects.

Two entry points for different scenarios:

```text
import { Xml } from "documonster/xml";

// Option 1: already have a DOM tree
const doc = Xml.parse('<root attr="1"><item>a</item><item>b</item></root>');
const obj = Xml.toPlainObject(doc.root);
// { root: { "@_attr": "1", item: ["a", "b"] } }

// Option 2: XML string → plain object directly (faster, single SAX pass)
const obj2 = Xml.parseToObject('<root attr="1"><item>a</item><item>b</item></root>');
// same output, ~1.6x faster on medium/large XML
```

**When to use which:**

- `Xml.toPlainObject(element)` — when you already have an `XmlElement` from `Xml.parse()`
- `Xml.parseToObject(xml)` — when you only need the plain object (skips DOM allocation)

**Default conversion rules:**

- Attributes are prefixed with `@_`
- Repeated sibling elements become arrays
- Text-only elements collapse to their string value
- Empty elements become `""`
- Whitespace-only indentation text is discarded by default

**Limitations:** plain-object conversion is intentionally lossy — it does not preserve element ordering, comments, or processing instructions. If you need exact XML structure, use `Xml.parse()` and work with the DOM tree directly.

### Query Engine

```typescript
import { Xml } from "documonster/xml";

const doc = Xml.parse("<root><a><b>1</b><b>2</b></a><a><b>3</b></a></root>");
const first = Xml.query(doc.root, "a/b"); // first <b> element
const all = Xml.queryAll(doc.root, "a/b"); // all <b> elements
const indexed = Xml.queryAll(doc.root, "a/b[0]"); // first <b> under each <a>
const filtered = Xml.query(doc.root, "a/b[@id='x']"); // <b> with id="x"
const deep = Xml.queryAll(doc.root, "a//b"); // <b> at any depth under <a>
```

### Encoding/Decoding

```typescript
import { Xml } from "documonster/xml";

Xml.encode('<tag attr="val">'); // "&lt;tag attr=&quot;val&quot;&gt;"
Xml.decode("&lt;hello&gt;"); // "<hello>"
```

---

## Architecture

```
src/modules/xml/
├── types.ts              # Core types (XmlNode, XmlSink, SaxTag, etc.)
├── errors.ts             # XmlError, XmlParseError, XmlWriteError
├── encode.ts             # Xml.encode, Xml.decode, Xml.validateXmlName, Xml.encodeCData, etc.
├── writer.ts             # Xml.Writer (buffered, with rollback support)
├── stream-writer.ts      # Xml.StreamWriter (streaming, writes to WritableTarget)
├── sax.ts                # Xml.SaxParser (event-driven) + Xml.parseSax (async generator)
├── dom.ts                # Xml.parse + DOM query helpers + Xml.toPlainObject
├── to-object.ts          # Xml.parseToObject (SAX-direct, single-pass)
├── to-object-shared.ts   # Shared conversion logic (internal)
├── query.ts              # Simplified path query engine
├── index.ts              # Public API barrel
└── __tests__/            # Tests
```

### Write Path

```
XmlSink (interface)
├── Xml.Writer        — Builds XML as a string in memory
│                      Supports rollback/transactions (save/commit/rollback)
│                      Best for: small-medium XML, speculative writes
│
└── Xml.StreamWriter  — Writes directly to a WritableTarget
                       O(1) memory — never holds full document
                       Best for: large XML (worksheets with 100K+ rows)
```

### Read Path

```
Xml.SaxParser        — Event-driven streaming parser
│                      Feed chunks via write(), events fire synchronously
│                      Best for: large XML, when you only need specific elements
│
├── Xml.parse        — Builds a DOM tree (XmlDocument/XmlElement)
│   │                  Built on top of Xml.SaxParser — no duplicate parsing logic
│   │                  Best for: small-medium XML, when you need tree traversal
│   │
│   └── Xml.toPlainObject — Converts XmlElement DOM to plain JS object
│                       Best for: when you already have a DOM tree
│
├── Xml.parseToObject — SAX-direct to plain JS object (single pass, no DOM)
│                      ~1.6x faster than Xml.parse + Xml.toPlainObject
│                      Best for: XML string → plain object → JSON.stringify
│
└── Xml.parseSax     — Async generator wrapping Xml.SaxParser for stream iteration
                       Best for: async pipelines (e.g. reading from zip streams)
```

---

## API Reference

### Xml.Writer

| Method                          | Description                             |
| ------------------------------- | --------------------------------------- |
| `openXml(attrs?)`               | Write `<?xml ...?>` declaration         |
| `openNode(name, attrs?)`        | Open an element                         |
| `closeNode()`                   | Close the most recent element           |
| `leafNode(name, attrs?, text?)` | Write a complete element in one call    |
| `addAttribute(name, value)`     | Add attribute to currently-open element |
| `addAttributes(attrs)`          | Add multiple attributes                 |
| `writeText(text)`               | Write escaped text content              |
| `writeRaw(xml)`                 | Write pre-escaped XML                   |
| `writeCData(text)`              | Write `<![CDATA[...]]>` section         |
| `writeComment(text)`            | Write `<!--...-->` comment              |
| `closeAll()`                    | Close all open elements                 |
| `toString()` / `xml`            | Get the built XML string                |
| `save()`                        | Save rollback snapshot                  |
| `commit()`                      | Discard snapshot (keep changes)         |
| `rollback()`                    | Restore to snapshot (discard changes)   |
| `reset()`                       | Clear everything                        |
| `depth`                         | Current nesting depth                   |
| `currentElement`                | Name of innermost open element          |
| `cursor`                        | Monotonic position counter              |

### Xml.StreamWriter

Same methods as `Xml.Writer` (both implement `XmlSink`), except:

- No `toString()` / `xml` — content is already written to target
- No `save()` / `commit()` / `rollback()` — streaming is irreversible
- No `cursor` — not applicable for streaming

### Xml.SaxParser

| Method / Property    | Description                                       |
| -------------------- | ------------------------------------------------- |
| `write(chunk)`       | Feed XML text (can be called multiple times)      |
| `close()`            | Signal end of input                               |
| `on(event, handler)` | Register event handler                            |
| `off(event)`         | Remove event handler                              |
| `line` / `column`    | Current position (when position tracking enabled) |
| `closed`             | Whether parser has been closed                    |

**Events:** `opentag`, `closetag`, `text`, `cdata`, `comment`, `pi`, `error`

**Options:**

| Option                | Default   | Description                                       |
| --------------------- | --------- | ------------------------------------------------- |
| `position`            | `true`    | Track line/column for error messages              |
| `fragment`            | `false`   | Allow multiple root elements                      |
| `xmlns`               | `false`   | Enable namespace processing                       |
| `maxDepth`            | `256`     | Maximum element nesting depth                     |
| `maxEntityExpansions` | `10000`   | Maximum entity expansion count (XML bomb defense) |
| `invalidCharHandling` | `"error"` | How to handle invalid XML characters (see below)  |
| `fileName`            | —         | File name for error messages                      |

### Xml.parseSax (Async Generator)

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

**Options:**

| Option                   | Default   | Description                                      |
| ------------------------ | --------- | ------------------------------------------------ |
| `comments`               | `false`   | Include comment nodes in DOM tree                |
| `processingInstructions` | `false`   | Include PI nodes in DOM tree                     |
| `cdataAsNodes`           | `false`   | Keep CDATA as explicit nodes vs merge into text  |
| `fragment`               | `false`   | Allow multiple root elements                     |
| `xmlns`                  | `false`   | Enable namespace processing                      |
| `maxDepth`               | `256`     | Maximum element nesting depth                    |
| `maxEntityExpansions`    | `10000`   | Maximum entity expansion count                   |
| `invalidCharHandling`    | `"error"` | How to handle invalid XML characters (see below) |

**Returns:** `XmlDocument` with:

| Field         | Type                                            | Description                                                |
| ------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `root`        | `XmlElement`                                    | First (or only) root element                               |
| `roots`       | `XmlElement[]`                                  | All root-level elements (useful in fragment mode)          |
| `declaration` | `Record<string, string> \| undefined`           | XML declaration attributes (version, encoding, standalone) |
| `prologue`    | `Array<XmlComment \| XmlProcessingInstruction>` | Top-level comments and PIs (when enabled via options)      |

### DOM Helpers

| Function                     | Description                 |
| ---------------------------- | --------------------------- |
| `Xml.findChild(el, name)`    | First child element by name |
| `Xml.findChildren(el, name)` | All child elements by name  |
| `Xml.textContent(node)`      | Recursive text content      |
| `Xml.attr(el, name)`         | Get attribute value         |
| `Xml.walk(el, visitor)`      | Depth-first traversal       |

### Xml.toPlainObject

```text
Xml.toPlainObject(
  element: XmlElement,
  options?: ToPlainObjectOptions
): Record<string, unknown>;
```

Convert an `XmlElement` DOM tree into a plain JavaScript object.

### Xml.parseToObject

```text
Xml.parseToObject(xml: string, options?: ParseXmlToObjectOptions): Record<string, unknown>;
```

Parse an XML string directly into a plain JavaScript object in a single SAX pass. ~1.6x faster than `Xml.parse()` + `Xml.toPlainObject()` on medium/large XML.

**Conversion options** (shared by both functions):

| Option                 | Default   | Description                                                 |
| ---------------------- | --------- | ----------------------------------------------------------- |
| `ignoreAttributes`     | `false`   | Discard all attributes entirely                             |
| `attributePrefix`      | `"@_"`    | Prefix for attribute keys (`""` for bare names)             |
| `textKey`              | `"#text"` | Key for text content in mixed-content elements              |
| `alwaysArray`          | `false`   | Always wrap child elements in arrays                        |
| `isArray`              | —         | Callback `(name) => boolean` for per-tag array wrapping     |
| `preserveCData`        | `true`    | Include CDATA values in text (relevant with `cdataAsNodes`) |
| `ignoreWhitespaceText` | `true`    | Discard whitespace-only text in elements that have children |

**Parser options** (`Xml.parseToObject` only):

| Option                | Default   | Description                                       |
| --------------------- | --------- | ------------------------------------------------- |
| `fragment`            | `false`   | Allow multiple root elements                      |
| `maxDepth`            | `256`     | Maximum element nesting depth                     |
| `maxEntityExpansions` | `10000`   | Maximum entity expansion count (XML bomb defense) |
| `invalidCharHandling` | `"error"` | How to handle invalid XML characters (see below)  |

### Query Engine

```typescript
import { Xml } from "documonster/xml";
```

| Syntax         | Description                                     |
| -------------- | ----------------------------------------------- |
| `a/b/c`        | Match child `a`, then `b`, then `c`             |
| `a/b[@id='1']` | Match `b` with attribute `id` equal to `"1"`    |
| `a/*/c`        | Wildcard: any element name at that level        |
| `a//c`         | Recursive descent: `c` at any depth under `a`   |
| `a/b[0]`       | Index: first matching `b` under each parent `a` |

- `Xml.query(element, path)` — First match or `undefined`
- `Xml.queryAll(element, path)` — All matches (may be empty)

Index filters use **per-parent semantics**: `a/b[0]` returns the first `b` under _each_ `a`, not the globally first `b`.

### Encoding Utilities

| Function                        | Description                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `Xml.encode(text)`              | Encode text for XML content (`<`, `>`, `&`, `"`, `'`)         |
| `Xml.decode(text)`              | Decode XML entities back to text                              |
| `Xml.encodeAttr(value)`         | Encode an attribute value (adds `\t\n\r` → `&#x9;&#xA;&#xD;`) |
| `Xml.validateXmlName(name)`     | Validate an XML element/attribute name                        |
| `Xml.validateCommentText(text)` | Validate text for XML comment content                         |
| `Xml.encodeCData(text)`         | Encode text for a CDATA section (splits `]]>`)                |

### Error Types

| Class           | Parent      | Used by                |
| --------------- | ----------- | ---------------------- |
| `XmlError`      | `BaseError` | Encoding/validation    |
| `XmlParseError` | `XmlError`  | SAX parser, DOM parser |
| `XmlWriteError` | `XmlError`  | Writers (state errors) |

All errors extend `XmlError`, so `catch (e) { if (e instanceof XmlError) ... }` catches any XML module error.

---

## Namespace Support

When `xmlns: true` is enabled:

- **Prefix resolution** — Element and attribute QNames are resolved to `{ prefix, local, uri }`
- **Pre-bound prefixes** — `xml` is pre-bound to `http://www.w3.org/XML/1998/namespace`, `xmlns` to `http://www.w3.org/2000/xmlns/`
- **Reserved namespace enforcement** — Cannot rebind `xml` to a different URI, cannot rebind `xmlns`, cannot bind other prefixes to reserved URIs
- **Unbound prefix detection** — Elements and attributes with undeclared prefixes produce errors
- **Expanded-name duplicate detection** — Two attributes with different prefixes but same URI + local name are rejected
- **Multi-colon QName rejection** — `<a:b:c/>` is rejected in namespace mode
- **Scope management** — Namespace declarations follow XML scoping rules (inherited by descendants, overridable in children)

Note: Unprefixed attributes do **not** inherit the default namespace, per XML Namespaces §6.2.

---

## Security

- **Entity expansion limits** — Prevents XML bomb attacks (configurable via `maxEntityExpansions`)
- **Nesting depth limits** — Prevents stack overflow from deeply nested XML (configurable via `maxDepth`)
- **Duplicate attribute rejection** — XML 1.0 §3.1 WFC: Unique Att Spec (reports error, recovers with last-value-wins)
- **Name injection prevention** — Writers validate element and attribute names via `Xml.validateXmlName()`
- **Comment/CDATA safety** — `Xml.validateCommentText()` rejects `--`, `Xml.encodeCData()` splits `]]>`
- **BOM handling** — UTF-8 BOM at start of input is silently stripped
- **Prototype pollution prevention** — DOM attribute maps use null-prototype objects with dangerous key filtering
- **Invalid character handling** — Writers strip invalid XML 1.0 characters; parser behavior is configurable via `invalidCharHandling`

---

## Invalid Character Handling

Real-world XML data (especially from third-party XLSX files) may contain characters that are invalid per XML 1.0 — for example, `0x7F` (DEL), `0x01`–`0x08`, `0x0B`, `0x0C`, `0x0E`–`0x1F`, lone surrogates, and non-characters `U+FFFE`/`U+FFFF`.

The `invalidCharHandling` option controls how the parser responds:

| Value       | Behavior                                            |
| ----------- | --------------------------------------------------- |
| `"error"`   | Report via error handler or throw **(default)**     |
| `"skip"`    | Silently discard the invalid character              |
| `"replace"` | Replace with U+FFFD (Unicode REPLACEMENT CHARACTER) |

### Examples

```typescript
import { Xml } from "documonster/xml";

// Default: strict mode — throws on 0x7F
Xml.parse("<root>hello\x7fworld</root>");
// => XmlParseError: invalid XML character: 0x7f

// Skip mode — invalid chars are removed
const doc = Xml.parse("<root>hello\x7fworld</root>", { invalidCharHandling: "skip" });
// doc.root text content: "helloworld"

// Replace mode — invalid chars become U+FFFD
const doc2 = Xml.parse("<root>hello\x7fworld</root>", { invalidCharHandling: "replace" });
// doc.root text content: "hello\uFFFDworld"

// SAX parser with skip mode
const parser = new Xml.SaxParser({ invalidCharHandling: "skip" });
parser.on("text", text => console.log(text)); // "helloworld"
parser.write("<root>hello\x7fworld</root>");
parser.close();
```

### When to use which

- **`"error"` (default)** — Use for strict XML validation, testing, or when you control the XML source.
- **`"skip"`** — Use when reading untrusted/dirty XML (e.g., third-party XLSX files) where you want to silently discard bad characters. This is what the Excel XLSX reader uses internally.
- **`"replace"`** — Use when you want to preserve the _position_ of invalid characters (e.g., for diagnostics or data forensics) without crashing the parser.

> **Note:** The XML _writers_ (`Xml.Writer`, `Xml.StreamWriter`) always strip invalid characters via `Xml.encode()` — this option only affects the _parser_.
