# Documonster

[![Build Status](https://github.com/documonster/documonster/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/documonster/documonster/actions/workflows/ci.yml) &nbsp; [中文](README_zh.md)

The TypeScript ecosystem is heavily fragmented when it comes to document and data processing. To work with spreadsheets, documents, PDFs, and the many data and archive formats around them, developers often need to pull in a different package for each task — and then yet another set of packages to make them work in the browser, plus separate streaming wrappers on top. These libraries vary in API style, quality, and maintenance status, creating a tax on every project that needs more than one of them.

Documonster was built to fix this. One package, one consistent API, one codebase — working identically across Node.js, Bun, and browsers. Streaming is a first-class citizen in every module, not an afterthought bolted on through a third-party adapter. The goal is simple: install once, import what you need, and get the same reliable behavior everywhere — with maximum streaming performance out of the box.

## About This Project

Documonster is a zero-dependency TypeScript toolkit for spreadsheets and documents:

- **AI-Friendly** — Clean, consistent API designed for AI coding agents. Every module has comprehensive documentation and runnable examples for AI to learn from. An [MCP server](packages/mcp/README.md) is available for AI clients that need to work on real files
- **Zero Runtime Dependencies** — Pure TypeScript, no external packages
- **Nine Modules** — Excel, Word, Formula, PDF, CSV, Markdown, XML, Archive, Stream
- **Cross-Platform** — Node.js 22+, Bun, Chrome 89+, Firefox 102+, Safari 14.1+
- **ESM First** — Native ES Modules with CommonJS compatibility and full tree-shaking

## Modules

Documonster is organized into nine standalone modules. Each module has its own documentation and runnable examples.

### Excel — XLSX/JSON Workbook Manager

Create, read, and modify Excel spreadsheets with full styling, formulas, images, and streaming support.

- [Documentation](src/modules/excel/README.md) | [中文](src/modules/excel/README_zh.md)
- [Examples](src/modules/excel/examples/)

### Word — DOCX Document Processor

Read, write, and manipulate DOCX files with a full builder, reader, and converter surface. Build documents with headings, tables, images, lists, headers/footers, drawing shapes, math, and charts. Read and modify existing files with text search/replace, format-aware queries, and bookmark/comment lookup. Convert to and from HTML and Markdown, bridge Excel workbooks into Word tables, and render Word straight to PDF. Advanced features include a template engine, form fields, OpenDoPE data binding, font embedding with subsetting, track-changes accept/reject, document diff/merge, streaming writer, password protection, Agile-encryption decryption, and digital-signature inspection.

- [Documentation](src/modules/word/README.md) | [中文](src/modules/word/README_zh.md)
- [Examples](src/modules/word/examples/)

### Formula — Excel-Compatible Calculation Engine

433-function calculation engine with tokenizer, parser, dependency graph, dynamic-array spill, and `LAMBDA`/`LET`/`MAP`/`REDUCE` support. Recalculate workbooks with `calculateFormulas()` from `documonster/excel/formula`; tokenize and parse syntax with `Formula` from `documonster/formula`. There is no install step, and the engine stays out of bundles that only read/write XLSX.

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

ZIP and TAR archive creation, reading, editing, streaming, encryption, and compression utilities.

- [Documentation](src/modules/archive/README.md) | [中文](src/modules/archive/README_zh.md)
- [Examples](src/modules/archive/examples/)

### Stream — Cross-Platform Streaming

Node.js-compatible Readable/Writable/Transform/Duplex that works identically in Node.js and browsers.

- [Documentation](src/modules/stream/README.md) | [中文](src/modules/stream/README_zh.md)
- [Examples](src/modules/stream/examples/)

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

```html
<!-- Script tag (no bundler) -->
<script src="https://unpkg.com/documonster/dist/iife/documonster.excel.iife.min.js"></script>
```

> The IIFE bundle does not include the formula calculation engine. Use
> ESM + `documonster/excel/formula` if you need to recalculate formulas.

For older browsers without native `CompressionStream` API, Documonster automatically uses a built-in pure JavaScript DEFLATE implementation — no polyfills needed.

## Requirements

- **Node.js >= 22.0.0**
- **Bun >= 1.0**

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
- 🗺️ [Roadmap](ROADMAP.md)
- 📄 [License (Apache-2.0)](LICENSE)
- 📦 [Third-Party Notices](THIRD_PARTY_NOTICES.md)
