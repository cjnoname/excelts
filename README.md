# Documonster

[![Build Status](https://github.com/documonster/documonster/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/documonster/documonster/actions/workflows/ci.yml) &nbsp; [中文](README_zh.md)

The TypeScript ecosystem is heavily fragmented when it comes to document and data processing. To work with spreadsheets, documents, PDFs, and the many data and archive formats around them, developers often need to pull in a different package for each task — and then yet another set of packages to make them work in the browser, plus separate streaming wrappers on top. These libraries vary in API style, quality, and maintenance status, creating a tax on every project that needs more than one of them.

Documonster was built to fix this. One package, one consistent API, one codebase — working identically across Node.js, Bun, and browsers. Streaming is a first-class citizen in every module, not an afterthought bolted on through a third-party adapter. The goal is simple: install once, import what you need, and get the same reliable behavior everywhere — with maximum streaming performance out of the box.

## About This Project

Documonster is a zero-dependency TypeScript toolkit for spreadsheets and documents:

- **AI-Friendly** — Clean, consistent API designed for AI coding agents. Every module has comprehensive documentation and runnable examples for AI to learn from. An [MCP server](packages/mcp/README.md) is available for AI clients that need to work on real files
- **Zero Runtime Dependencies** — Pure TypeScript, no external packages
- **Nine Modules** — Excel, Word, Formula, PDF, CSV, Markdown, XML, Archive, Stream
- **Cross-Platform** — Node.js 22.13+, Bun, Chrome 89+, Firefox 102+, Safari 14.1+
- **ESM only** — Native ES Modules with full tree-shaking; CommonJS consumers `require()` it unchanged on Node >= 22.13

## Modules

Documonster is organized into nine standalone modules. Each module has its own documentation and runnable examples.

### Excel — XLSX/JSON Workbook Manager

Create, read, and modify Excel spreadsheets with full styling, formulas, images, and streaming support. Dates are treated as calendar values rather than instants: `Cell.setDateParts` / `Cell.getDateParts` speak timezone-free fields on every runtime, and `Cell.setValue` / `Cell.getTemporal` accept and return `Temporal.PlainDate`, `PlainTime` and `PlainDateTime` where the host has them — which also recovers the date/time/date-time distinction a `Date` cannot carry. See [Dates: calendar values, not instants](src/modules/excel/README.md#dates-calendar-values-not-instants).

- [Documentation](src/modules/excel/README.md) | [中文](src/modules/excel/README_zh.md)
- [Examples](src/modules/excel/examples/)

### Word — DOCX Document Processor

Read, write, and manipulate DOCX files with a full builder, reader, and converter surface. Build documents with headings, tables, images, lists, headers/footers, drawing shapes, math, and charts. Read and modify existing files with text search/replace, format-aware queries, and bookmark/comment lookup. Convert to and from HTML and Markdown, bridge Excel workbooks into Word tables, and render Word straight to PDF. Advanced features include a template engine, form fields, OpenDoPE data binding, font embedding with subsetting, track-changes accept/reject, document diff/merge, streaming writer, password protection, Agile-encryption decryption, and digital-signature inspection.

- [Documentation](src/modules/word/README.md) | [中文](src/modules/word/README_zh.md)
- [Examples](src/modules/word/examples/)

### Formula — Excel-Compatible Calculation Engine

448-function calculation engine with tokenizer, parser, dependency graph, dynamic-array spill, and `LAMBDA`/`LET`/`MAP`/`REDUCE` support. Recalculate workbooks with `calculateFormulas()` from `documonster/excel/formula`; tokenize and parse syntax with `Formula` from `documonster/formula`. There is no install step, and the engine stays out of bundles that only read/write XLSX.

- [Documentation](src/modules/formula/README.md) | [中文](src/modules/formula/README_zh.md)
- [Examples](src/modules/formula/examples/)

### PDF — Zero-Dependency PDF Engine

Full-featured PDF generation, reading, building, editing, and signing. Write PDFs with font embedding, AES-256 encryption, images, and Excel-to-PDF conversion. Build free-form PDFs with text, vector graphics, SVG paths, annotations, and form fields. Edit existing PDFs with overlays, form filling, page manipulation, and merging. Read any PDF with text, image, annotation, form field, bookmark, and metadata extraction. Verify and create digital signatures with PKCS#7/CMS.

- [Documentation](src/modules/pdf/README.md) | [中文](src/modules/pdf/README_zh.md)
- [Examples](src/modules/pdf/examples/)

### CSV — RFC 4180 Parser/Formatter

High-performance CSV parsing and formatting with streaming, dynamic typing, data generation, and worker pool support.

- [Documentation](src/modules/csv/README.md) | [中文](src/modules/csv/README_zh.md)
- [Examples](src/modules/csv/examples/)

### Markdown — GFM Table Parser/Formatter

Parse and format GitHub Flavored Markdown tables with alignment round-trip and Workbook integration.

- [Documentation](src/modules/markdown/README.md) | [中文](src/modules/markdown/README_zh.md)
- [Examples](src/modules/markdown/examples/)

### XML — SAX/DOM Parser, Query Engine, Writer

Streaming and buffered XML processing with query engine, namespace support, and dual-mode writing.

- [Documentation](src/modules/xml/README.md) | [中文](src/modules/xml/README_zh.md)
- [Examples](src/modules/xml/examples/)

### Archive — Create/Read/Edit Archives

ZIP and TAR archive creation, reading, editing, streaming, encryption, and compression utilities — plus `encodePng`, since a PNG is a DEFLATE stream with CRC-32-checked chunks and this is where both primitives live.

- [Documentation](src/modules/archive/README.md) | [中文](src/modules/archive/README_zh.md)
- [Examples](src/modules/archive/examples/)

### Stream — Cross-Platform Streaming

Node.js-compatible Readable/Writable/Transform/Duplex that works identically in Node.js and browsers.

- [Documentation](src/modules/stream/README.md) | [中文](src/modules/stream/README_zh.md)
- [Examples](src/modules/stream/examples/)

### Draw — Shared Drawing Engine

One structured display list, one walker, many backends. Build a `DrawList` and get SVG markup, RGBA pixels, or a PDF page from the same output — no renderer ever re-parses another's SVG. Includes text measurement and wrapping, so a producer can size its boxes before it builds a list.

- [Documentation](src/modules/draw/README.md) | [中文](src/modules/draw/README_zh.md)

### Mermaid — Diagram Text to Drawings

Twenty-one Mermaid diagram types — flowchart, state, class, ER, sequence, Gantt, mindmap, git graph and more — rendered without a browser or headless Chrome. The module produces a display list and implements no backend, so SVG, pixels and PDF pages all come for free. Parse, layout and render are separate passes; stop after any of them.

- [Documentation](src/modules/mermaid/README.md) | [中文](src/modules/mermaid/README_zh.md)
- [Examples](src/modules/mermaid/examples/)

## MCP Server — Documonster for AI Clients

`@documonster/mcp` puts the toolkit behind the Model Context Protocol, so Claude Desktop, Claude Code, Cursor, and other MCP clients can read and write real spreadsheets, documents, PDFs, forms, and archives instead of guessing about them. It ships as a separate package, keeping the MCP SDK out of `documonster` and its zero-dependency promise intact.

- [Documentation](packages/mcp/README.md)
- [Examples](packages/mcp/src/examples/)

## Installation

```bash
npm install documonster
# or
pnpm add documonster
# or
bun add documonster
```

Each module is available as a standalone subpath export. All subpaths support `browser`, `import` (ESM), and `require` (CJS) conditions.

## Quick Start

```typescript
import { Workbook, Worksheet, Row } from "documonster/excel";

// Create
const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Sheet1");
Worksheet.addRow(sheet, ["Name", "Age"]);
Worksheet.addRow(sheet, ["Alice", 30]);
await Workbook.writeFile(workbook, "output.xlsx");

// Read
const wb = Workbook.create();
await Workbook.readFile(wb, "output.xlsx");
const readSheet = Workbook.getWorksheet(wb, 1);
Worksheet.eachRow(readSheet, (_row, n) => console.log(n, Row.getValues(readSheet, n)));

// PDF — generate from data, no Workbook needed
import { Pdf } from "documonster/pdf";
const pdfBytes = await Pdf.create([
  ["Product", "Revenue"],
  ["Widget", 1000]
]);

// PDF — read text, images, and metadata from any PDF
const result = await Pdf.read(pdfBytes);
console.log(result.text); // extracted text
console.log(result.metadata); // title, author, etc.

// PDF — build free-form PDFs with text, shapes, SVG paths
const doc = new Pdf.Builder();
const page = doc.addPage();
page.drawText("Hello!", { x: 72, y: 770, fontSize: 24 });
page.drawSvgPath("M10 10 L90 10 L50 80 Z", { fill: { r: 1, g: 0, b: 0 } });
page.addAnnotation({ type: "Highlight", rect: [72, 765, 150, 785] });

// PDF — edit existing PDFs (overlay, merge, fill forms)
const editor = Pdf.Editor.load(existingPdf);
editor.getPage(0).drawText("Stamp", { x: 200, y: 400, fontSize: 36 });
editor.setFormField("name", "Jane");
editor.copyPagesFrom(otherPdf);

// CSV — parse and format
import { Csv } from "documonster/csv";
const rows = Csv.parse("name,age\nAlice,30", { headers: true });
const csv = Csv.format([{ name: "Bob", age: 25 }], { headers: true });

// XML — parse, query, write
import { Xml } from "documonster/xml";
const titles = Xml.queryAll(Xml.parse(xmlString).root, "book/title");

// ZIP — create and extract
import { Archive } from "documonster/archive";
const archive = await Archive.zip().add("hello.txt", "Hello!").bytes();

// Markdown — parse and format tables
import { Markdown } from "documonster/markdown";
const table = Markdown.parse("| A | B |\n|---|---|\n| 1 | 2 |");

// Word — create, read, and convert DOCX
import { Document, Io } from "documonster/word";
const wdoc = Document.create();
Document.addHeading(wdoc, "Report", 1);
Document.addParagraph(wdoc, "Generated by Documonster.");
const docxBytes = await Io.toBuffer(Document.build(wdoc));
const parsedDocx = await Io.read(docxBytes); // round-trip read

// Formula — opt-in calculation engine (kept out of the base bundle)
// Recalculate an excel workbook via the excel/formula subpath.
import { calculateFormulas } from "documonster/excel/formula";
import { Cell } from "documonster/excel";
Cell.setValue(sheet, "A4", { formula: "SUM(A1:A3)" });
calculateFormulas(workbook); // now populates cell results

// Syntax inspection is available separately
import { Formula } from "documonster/formula";
const ast = Formula.parse(Formula.tokenize("SUM(A1:A3)"));
```

## Browser Support

Documonster has native browser support with **zero configuration** for modern bundlers.

```typescript
// Bundlers (Vite, Webpack, Rollup, esbuild) — just import
import { Workbook } from "documonster/excel";
const wb = Workbook.create();
Workbook.addWorksheet(wb, "S1");
const buffer = await Workbook.toBuffer(wb);
```

<!-- x-release-please-start-version -->

```html
<!-- Script tag (no bundler) — one IIFE per module, each under the shared `Documonster` global -->
<script src="https://unpkg.com/documonster@0.11.1/dist/iife/documonster.excel.iife.min.js"></script>
<script>
  const { Workbook, Cell } = Documonster.Excel;
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "S1");
  Cell.setValue(ws, "A1", "Hello, Browser!");
  Workbook.toBuffer(wb).then(buffer => console.log(buffer.byteLength));
</script>
```

<!-- x-release-please-end -->

The URL is pinned on purpose: an unpinned `unpkg.com/documonster/…` resolves to
whatever is newest, so a future release would change a page that never asked to
change. Every module ships its own bundle, and the file name names the module:

<!-- iife-bundles:start -->

`excel`, `word`, `pdf`, `csv`, `markdown`, `xml`, `formula`, `archive`, `stream`,
`draw`, `mermaid`

<!-- iife-bundles:end -->

Swap the name in the URL and read the namespace back off `Documonster.Word`,
`Documonster.Pdf`, `Documonster.Mermaid`, … Loading several is fine; they extend
one shared global. There is no whole-family bundle, so a page pays only for the
modules it names.

> The IIFE bundle does not include the formula calculation engine. Use
> ESM + `documonster/excel/formula` if you need to recalculate formulas.

For older browsers without native `CompressionStream` API, Documonster automatically uses a built-in pure JavaScript DEFLATE implementation — no polyfills needed.

## Requirements

- **Node.js >= 22.13.0**
- **Bun >= 1.0**

The package is ESM-only. Nothing changes for Node ESM, a bundler or a `<script>` tag, and a
CommonJS `require()` call site is unchanged too — Node loads an ES module through `require()`
from 22.12, and stops printing an experimental warning about it from 22.13, which is why that
is the floor.

<details>
<summary>Using it from TypeScript with <code>module: node16</code></summary>

Set `nodenext` instead. TypeScript's `node16` mode predates `require(esm)` and rejects the
import before Node ever sees it:

```
error TS1479: The current file is a CommonJS module whose imports will produce 'require'
calls; however, the referenced file is an ECMAScript module and cannot be imported with
'require'.
```

`nodenext` knows about `require(esm)` and accepts it — verified on tsc 5.9, along with
`bundler` and the legacy `commonjs` + `node10` pair, which resolves types through
`typesVersions`. The emitted JavaScript is identical and runs either way; only the type
checker objects.

</details>

<details>
<summary>Using it from Jest</summary>

Jest cannot `require()` an ES module, so it needs a transform. This is the same two-file
change a Jest project already needs for `chalk`, `uuid`, `nanoid`, `strip-ansi` and most
other modern packages — if you have one of those, add `documonster` to the pattern you
already have:

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

Vitest needs no configuration.

</details>

| Browser | Minimum Version    |
| ------- | ------------------ |
| Chrome  | 89+ (March 2021)   |
| Edge    | 89+ (March 2021)   |
| Firefox | 102+ (June 2022)   |
| Safari  | 14.1+ (April 2021) |
| Opera   | 75+ (March 2021)   |

## Links

- 🏠 [GitHub Repository](https://github.com/documonster/documonster)
- 🐛 [Issue Tracker](https://github.com/documonster/documonster/issues)
- 📋 [Changelog](CHANGELOG.md)
- 🔄 [Migration Guide](MIGRATION.md)
- 📄 [License (Apache-2.0)](LICENSE)
- 📦 [Third-Party Notices](THIRD_PARTY_NOTICES.md)
