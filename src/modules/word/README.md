# Word Module

[中文](README_zh.md)

Zero-dependency TypeScript library for reading, writing, and manipulating DOCX files.
Works in Node.js 22+ and modern browsers.

## Features

- **Create, read, and modify DOCX files** — full WordprocessingML support
- **Document builder** — paragraphs, headings, rich text runs (bold/italic/underline/color/highlight)
- **Tables** — styles, borders, cell merges (horizontal + vertical), nested tables
- **Images** — inline and floating (JPEG, PNG, GIF, BMP, TIFF, SVG with raster fallback)
- **Lists** — bulleted, numbered, multi-level
- **Page layout** — sections, page size/orientation/margins, columns, breaks
- **Headers and footers** — default, first, even
- **Hyperlinks and bookmarks** — external, internal, cross-references
- **Table of contents** — field-driven, with cached entries
- **Footnotes, endnotes, and comments** — including threaded/extended comments
- **Fields** — PAGE/NUMPAGES, TOC, INDEX/XE, REF, SEQ, STYLEREF, formulas, and more
- **Math** — OMML equations (fractions, radicals, matrices, n-ary, …)
- **Drawing shapes** — preset geometries with fill, line, gradient, shadow/glow/3-D effects
- **Charts** — opaque preservation plus a from-scratch builder; bridge to the Excel chart engine
- **Track changes** — accept/reject insertions, deletions, moves, and property changes
- **Templates** — `{{variable}}`, `{{#if}}`, `{{#each}}`, mail merge, template patching
- **Form fields and content controls (SDT)** — extract and fill; OpenDoPE data binding
- **Font embedding** — with automatic glyph subsetting
- **Document protection** — read-only/comments/forms with password
- **Encryption** — decrypt password-protected DOCX (Agile Encryption)
- **Digital signatures** — detection and metadata extraction
- **Conversion** — DOCX ↔ HTML, DOCX ↔ Markdown, Excel → Word, Word → PDF
- **Flat OPC** — single-XML `.xml` representation round-trip
- **Diff and merge** — compare two documents, combine multiple documents
- **Streaming writer** — `createDocxStream()` for large documents
- **Validation** — structural checks with severity-tagged issues
- **OOXML Strict** — transparent normalization to Transitional on read
- **Browser support** — the same `documonster/word` import works in Node.js and browsers

## Quick Start

```typescript
import { Document, Io } from "documonster/word";

// Create a document
const doc = Document.create();
Document.addHeading(doc, "Hello World", 1);
Document.addParagraph(doc, "This is a paragraph.");
Document.addTable(doc, [
  ["A", "B"],
  ["1", "2"]
]);

const buffer = await Io.toBuffer(Document.build(doc));
// Write to file, send as response, etc.

// Read a document
const parsed = await Io.read(buffer);
console.log(parsed.body.length, "elements");
```

## Core API

### Document Builder

```typescript
import { Document, Build, Io } from "documonster/word";

const doc = Document.create();

// Text
Document.addParagraph(doc, "Simple text");
Document.addParagraphElement(
  doc,
  Build.paragraph([Build.text("Normal "), Build.bold("bold "), Build.italic("italic")])
);
Document.addHeading(doc, "Title", 1);

// Tables
Document.addTable(
  doc,
  [
    ["Header1", "Header2"],
    ["cell1", "cell2"]
  ],
  { headerRow: true }
);

// Images
Document.addImage(doc, pngBytes, "png", width, height);
Document.addFloatingImage(doc, jpgBytes, "jpeg", width, height, { wrap: { style: "square" } });

// Lists
Document.addBulletList(doc, ["Item 1", "Item 2", "Item 3"]);
Document.addNumberedList(doc, ["First", "Second", "Third"]);

// Page layout
Document.setSectionProperties(doc, {
  pageSize: { width: 11906, height: 16838 }, // A4
  margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
});

// Headers/Footers
Document.setHeader(doc, "default", { children: [Build.textParagraph("Page Header")] });

// Build & export
const model = Document.build(doc);
const bytes = await Io.toBuffer(model);
```

### Reading Documents

```typescript
import { Io, Query } from "documonster/word";

const doc = await Io.read(fileBuffer);

// Extract text content
const text = Query.extractText(doc);

// Search
const results = Query.searchText(doc, /pattern/g);
```

### Modifying Documents

```typescript
import { Io, Query } from "documonster/word";

const doc = await Io.read(buffer);
const modified = Query.replaceText(doc, "OLD_TEXT", "NEW_TEXT");
const output = await Io.toBuffer(modified);
```

## Advanced Features

### Template Engine

```typescript
import { Template } from "documonster/word";

const filled = Template.fillTemplate(doc, {
  name: "John",
  showDetails: true,
  items: ["A", "B", "C"]
});
// Supports: {{variable}}, {{#if cond}}...{{/if}}, {{#each arr}}...{{/each}}
```

### Form Fields

```typescript
import { Query, Build } from "documonster/word";

// `Build.formTextField` / `Build.formCheckboxField` build form-field runs.

// Extract form data
const fields = Query.extractFormFields(doc);
// → [{ name: "FullName", type: "text", value: "..." }, ...]

// Fill form data
const filled = Query.fillFormFields(
  doc,
  new Map([
    ["FullName", "Jane Doe"],
    ["AgreeTerms", true],
    ["Country", 2]
  ])
);
```

### Data Binding (OpenDoPE)

```typescript
import { Query } from "documonster/word";

// Resolve SDT data bindings against CustomXML parts
const resolved = Query.resolveDataBindings(doc);

// Or with override data
const resolved2 = Query.resolveDataBindings(
  doc,
  new Map([["{GUID}", "<root><field>value</field></root>"]])
);
```

### Drawing Shapes with Effects

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

### Font Embedding with Subsetting

```typescript
import { Font } from "documonster/word";

// Embed with automatic subsetting (only glyphs used in document)
const result = Font.embed({
  name: "CustomFont",
  data: fontFileBytes,
  style: "regular",
  usedCharacters: "Hello World" // Only these glyphs are embedded
});

// Add to document
const docWithFonts = Font.addEmbedded(doc, [result]);
```

### Track Changes

```typescript
import { Query } from "documonster/word";

const accepted = Query.acceptAllRevisions(doc);
const rejected = Query.rejectAllRevisions(doc);
```

### Document Diff

```typescript
import { Diff } from "documonster/word";

const diff = Diff.documents(docA, docB);
// → { changes: [{ type: "added"|"removed"|"modified", ... }] }
```

### Document Merge

```typescript
import { Io } from "documonster/word";

const merged = Io.merge([doc1, doc2, doc3], { sectionBreak: "nextPage" });
```

### Streaming Writer

```typescript
import { Streaming } from "documonster/word";

const stream = Streaming.createDocxStream();
stream.addText("Title", { style: "Heading1" });
for (const item of largeDataset) {
  stream.addText(item.text);
}
const buffer = await stream.finalize();
```

### Document Protection

```typescript
import { Security } from "documonster/word";

const protectedDoc = Security.protect(doc, { type: "readOnly", password: "secret" });
const isProtected = Security.isProtected(protectedDoc); // true
const valid = Security.verifyPassword(protectedDoc, "secret"); // true
```

### Validation

```typescript
import { Validation } from "documonster/word";

const result = Validation.document(doc);
if (!result.valid) {
  console.log(result.issues); // [{ severity, message, path }]
}
```

### HTML/Markdown Conversion

```typescript
// DOCX → Markdown (GFM: headings, bold/italic/strike, inline code,
// code blocks, blockquotes, ordered/unordered lists, tables with
// alignment, links, images, footnotes)
import { renderToMarkdown } from "documonster/word/markdown";
const md = renderToMarkdown(doc);
const mdSetext = renderToMarkdown(doc, { headingStyle: "setext" });

// Markdown → DOCX (full document or body fragment)
import { markdownToDocx, markdownToDocxBody } from "documonster/word/markdown";
const doc = markdownToDocx("# Title\n\nHello **world**");
const bodyItems = markdownToDocxBody("- a\n- b");

// Table columns are sized from their content and a fenced code block is set
// small enough that its longest line does not wrap — both are decisions the
// producer has to make, because a `.docx` carries a column grid and a run size,
// not an instruction to work them out later. Say which measure they should be
// sized against if the body is going somewhere other than a Letter page:
const wide = markdownToDocx(markdown, {
  contentWidth: 15840 - 2 * 720, // landscape Letter, half-inch margins
  codeBlockFit: "shrink" // the default; "wrap" keeps the size and breaks lines
});

// DOCX → HTML
import { renderToHtml } from "documonster/word/html";
const html = renderToHtml(doc);

// HTML → DOCX body content
import { htmlToDocxBody } from "documonster/word/html";
const body = htmlToDocxBody("<h1>Hello</h1><p>World</p>");
```

### Flat OPC Format

```typescript
import { Convert } from "documonster/word";

// Single-XML representation of a DOCX
const flatXml = Convert.toFlatOpc(doc);
const doc = Convert.parseFlatOpc(flatXmlString);
```

### Encryption & Signatures

Low-level cryptography helpers live on the `documonster/word/crypto`
subpath so they stay out of bundles that only read/write plain DOCX.

```typescript
import {
  isEncryptedDocx,
  decryptDocx,
  encryptDocx,
  extractSignatures,
  hasDigitalSignatures
} from "documonster/word/crypto";

// Decrypt a password-protected DOCX (Agile Encryption)
if (isEncryptedDocx(bytes)) {
  const plain = await decryptDocx(bytes, "password");
}

// Encrypt a DOCX with a password
const encrypted = await encryptDocx(docxBytes, "password");

// Inspect embedded XMLDSig signatures (read-only; no verification)
const signatures = extractSignatures(opaqueParts);
```

### Excel → Word

Convert an Excel `Workbook` into a `DocxDocument`, mapping worksheets to
Word tables with cell formatting (fonts, colours, alignment, fills,
borders), column widths, rich-text runs, and an optional title page.
Hidden sheets are skipped; rows/columns can be capped.

```typescript
import { excelToDocx, extractTablesToExcel } from "documonster/word/excel";
import { Io } from "documonster/word";

// Workbook → DocxDocument (all visible sheets, formatting preserved)
const doc = excelToDocx(workbook);
const docxBytes = await Io.package(doc);

// With options: a title page, only some sheets, capped dimensions
const doc2 = excelToDocx(workbook, {
  titlePage: { title: "Q3 Report", subtitle: "Sales" },
  sheets: ["Summary", 2], // by name or zero-based index
  maxRows: 100,
  maxColumns: 12,
  preserveFormatting: true
});

// Reverse direction: pull the tables out of a DOCX into a Workbook
const extracted = extractTablesToExcel(doc);
```

Charts embedded in a Word document also bridge to the Excel chart engine
(27 chart families, classic and modern ChartEx). See `Pdf.wordChartRenderer`
for the PDF rendering side.

### Word → PDF

Convert a `DocxDocument` to PDF bytes. The bridge is a thin layer over
the shared Word layout engine, so line wrapping, pagination, tables,
inline images, headers/footers, and floats all render identically to the
SVG path.

```typescript
import { Io } from "documonster/word";
import { Pdf } from "documonster/pdf";

const doc = await Io.read(docxBytes);
const pdfBytes = await Pdf.fromDocx(doc);

// Override page geometry (points). Any field omitted falls back to the
// document's section properties, then engine defaults (US Letter, 1").
const pdf2 = await Pdf.fromDocx(doc, {
  pageWidth: 595, // A4 width
  pageHeight: 842, // A4 height
  marginTop: 72,
  marginBottom: 72,
  marginLeft: 72,
  marginRight: 72,
  headerMargin: 36, // header band offset from the top edge
  footerMargin: 36, // footer band offset from the bottom edge
  defaultFont: "Helvetica",
  defaultFontSize: 11
});
```

**Charts.** When a chart renderer is supplied via `Pdf.wordChartRenderer()`,
both classic (`<c:chart>`) and modern ChartEx (`<cx:chartSpace>` — sunburst, treemap,
waterfall, funnel, boxWhisker, histogram, pareto, regionMap) charts render
as full vector PDF automatically. Without a chart renderer, charts
degrade to a titled placeholder box (no throw, no blank page). To supply
your own classic-chart renderer:

```typescript
import { Pdf } from "documonster/pdf";

const pdf = await Pdf.fromDocx(doc, {
  chartRenderer: await Pdf.wordChartRenderer()
});
```

A `chartRenderer` may return `false` to decline a particular chart; the
bridge then falls back to the built-in vector renderer, then to the
inline SVG / placeholder.

## OOXML Strict Format

The module automatically handles documents saved in ISO 29500 Strict conformance.
When reading a Strict-format .docx, namespace URIs and relationship types are
transparently normalized to their Transitional equivalents — no user action required.

## Compatibility

| Feature                | Support                                                        |
| ---------------------- | -------------------------------------------------------------- |
| .docx (read)           | ✅ Broad (common elements structured; unknown parts preserved) |
| .docx (write)          | ✅ Broad (common elements; unknown parts written as opaque)    |
| .dotx (template)       | ✅                                                             |
| .docm (macro)          | ✅ Round-trip (VBA preserved, not executed/edited)             |
| .dotm (macro template) | ✅ Round-trip                                                  |
| Flat OPC (.xml)        | ✅                                                             |
| ISO 29500 Strict       | ✅ Auto-normalized                                             |
| Encrypted .docx        | ✅ Decrypt with password (Agile Encryption)                    |
| Digital Signatures     | 🔍 Detection & metadata extraction (no signing/verification)   |
| Browser                | ✅ (same `documonster/word` import)                            |
| Node.js 22+            | ✅                                                             |
