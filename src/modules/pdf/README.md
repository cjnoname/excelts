# PDF Module

[中文](README_zh.md)

A full-featured, zero-dependency PDF engine built from scratch in pure TypeScript. **Write** PDFs with `Pdf.create()` or the `Pdf.fromExcel()` bridge. **Read** any PDF with `Pdf.read()` — extract text, images, and metadata from all major PDF versions. **Build** free-form PDFs with `Pdf.Builder` — text, vector graphics, SVG paths, annotations, and form fields. **Edit** existing PDFs with `Pdf.Editor` — overlay content, fill forms, add/remove/rotate pages, merge documents, and sign digitally. All APIs are async and yield to the event loop between pages to avoid blocking.

```typescript
import { Pdf } from "documonster/pdf";

// Write — standalone:      Pdf.create(rows)
// Write — from Excel:      await Pdf.fromExcel(workbook)
// Read — text/images/meta: Pdf.read(bytes)
// Build — free-form:       new Pdf.Builder()
// Edit — overlay/forms:    new Pdf.Editor() / Pdf.Editor.load(bytes)
// Sign — digital sigs:     Pdf.sign(...) / Pdf.verifySignature(...)
```

## Features

### Writing

- **Zero Dependencies** — Pure TypeScript PDF generation, no external libraries
- **PDF 2.0** — Writes modern PDF 2.0 format
- **Standalone Engine** — Use `Pdf.create()` with plain arrays and objects, no Excel dependency
- **Excel Bridge** — One-line `Pdf.fromExcel(workbook)` for Excel-to-PDF conversion
- **Cross-Platform** — Same API in Node.js and browsers
- **Full Styling** — Fonts, colors, borders, fills, alignment, merged cells
- **Rich Text** — Mixed formatting within a single cell, with word-wrap support
- **Pagination** — Automatic vertical/horizontal page splitting with repeat headers
- **Images** — JPEG and PNG embedding with alpha transparency
- **AES-256 Encryption** — Password protection with AES-256 (V=5, R=5) and permission controls
- **Font Embedding** — TrueType font subsetting for Unicode/CJK text
- **Watermarks** — Text and image watermarks with opacity, rotation, tiling, per-page/per-sheet filtering
- **Page Setup** — Per-sheet paper size, orientation, margins, print area
- **Tree-Shakeable** — Not imported? Not in your bundle
- **Non-Blocking** — Yields to the event loop between pages to avoid blocking

### Reading

- **Universal Reader** — Reads all major PDF versions (1.0 through 2.0)
- **Text Extraction** — Full text with line reconstruction, multi-column, and table detection
- **Multilingual** — WinAnsi, MacRoman, CJK via ToUnicode CMap, Identity-H/V, Symbol, ZapfDingbats
- **Image Extraction** — JPEG, JPEG2000, CCITT, JBIG2, raw/Flate with SMask/alpha
- **Annotation Extraction** — Links, comments, highlights, stamps, free text, and more
- **Form Fields** — AcroForm extraction: text inputs, checkboxes, radio buttons, dropdowns, signatures
- **Bookmark Extraction** — Nested outline tree with named/action destinations
- **Table Extraction** — Heuristic table detection from text fragment positioning
- **Metadata** — Info dictionary + XMP (title, author, dates, page count, page sizes)
- **All Encryption** — RC4-40, RC4-128, AES-128, AES-256 (reads all versions)
- **Fault-Tolerant** — Cross-reference table/stream recovery, incremental updates

### Building (PdfDocumentBuilder)

- **Free Text Positioning** — Place text anywhere with font, size, color, bold/italic
- **Vector Graphics** — Rectangles, circles, ellipses, lines, arbitrary paths with fill/stroke
- **SVG Path Rendering** — Parse and render SVG `d` attributes (all commands including arcs)
- **Images** — JPEG and PNG embedding at any position
- **Annotations** — Create Highlight, Underline, StrikeOut, Squiggly, Text (sticky note), FreeText, and Stamp annotations
- **Form Field Creation** — Create TextField, Checkbox, Dropdown, and RadioGroup from scratch
- **Bookmarks** — Nested outline tree with page destinations
- **Table of Contents** — Auto-generated TOC with dot leaders, page numbers, and clickable links
- **PDF/A-1b** — Archival compliance with XMP metadata, OutputIntent, and sRGB ICC profile
- **AES-256 Encryption** — Password-protect builder-created PDFs
- **Font Embedding** — TrueType font subsetting for Unicode/CJK text

### Editing (PdfEditor)

- **Overlay Content** — Draw text, shapes, images on existing PDF pages
- **Annotations on Existing Pages** — Add Highlight, Text, FreeText, Stamp, etc. to existing PDFs
- **Form Fields on Existing Pages** — Add TextField, Checkbox, Dropdown to existing PDFs
- **SVG Paths on Existing Pages** — Draw SVG paths on existing PDF pages
- **Form Filling** — Set text field values and checkbox states
- **Add Pages** — Append new blank pages with content
- **Remove Pages** — Delete pages by index
- **Rotate Pages** — Rotate pages by 90/180/270 degrees
- **Split Pages** — Split a PDF into individual single-page PDFs
- **Merge / Copy Pages** — Copy pages from other PDFs (including encrypted sources)
- **Incremental Save** — Append-only updates preserving original bytes (safe for signed PDFs)
- **Full Save** — Rebuild entire PDF with all modifications
- **Metadata Preservation** — Retains XMP, page properties (Rotate, CropBox, etc.)

### Digital Signatures

- **Signature Verification** — Verify RSA PKCS#1 v1.5 + SHA-256 signatures with full PKCS#7/CMS parsing
- **Signature Creation** — Create CMS SignedData signatures with ByteRange placeholder/backfill
- **ASN.1 DER Codec** — Parse and encode ASN.1 structures (shared by verify and sign)
- **X.509 Certificate** — Extract public keys from DER-encoded certificates
- **Platform-Native Crypto** — Uses `node:crypto` on Node.js, Web Crypto API in browsers

---

## Quick Start

### Read a PDF

```typescript
import { Pdf } from "documonster/pdf";
import { readFileSync } from "fs";

const bytes = readFileSync("document.pdf");
const result = await Pdf.read(bytes);

// All text
console.log(result.text);

// Per-page text
for (const page of result.pages) {
  console.log(`Page ${page.pageNumber}: ${page.text.length} chars`);
}

// Metadata
console.log(result.metadata.title);
console.log(result.metadata.author);
console.log(result.metadata.pageCount);

// Images
for (const page of result.pages) {
  for (const img of page.images) {
    console.log(img.format, img.width, img.height);
  }
}

// Annotations (links, comments, highlights)
for (const page of result.pages) {
  for (const annot of page.annotations) {
    console.log(annot.subtype, annot.contents, annot.uri);
  }
}

// Form fields
for (const field of result.formFields) {
  console.log(field.name, field.type, field.value);
}

// Bookmarks (document outline)
for (const bm of result.bookmarks) {
  console.log(bm.title, bm.pageIndex);
}
```

### Read Encrypted PDF

```typescript
const result = await Pdf.read(bytes, { password: "secret" });
```

### Selective Extraction

```typescript
// Only pages 1 and 3, text only (no images)
const result = await Pdf.read(bytes, {
  pages: [1, 3],
  extractImages: false
});

// Extract bookmarks (outline tree)
const result = await Pdf.read(bytes, { extractBookmarks: true });
for (const bm of result.bookmarks) {
  console.log(bm.title, `→ page ${bm.pageIndex + 1}`);
}

// Extract tables (heuristic text-position detection)
const result = await Pdf.read(bytes, { extractTables: true });
for (const page of result.pages) {
  for (const table of page.tables) {
    for (const row of table.rows) {
      console.log(row.cells.map(c => c.text).join(" | "));
    }
  }
}
```

### Excel-to-PDF (Bridge API)

The simplest way to generate PDFs from Excel workbooks:

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

// Browser
const blob = new Blob([pdf], { type: "application/pdf" });
const url = URL.createObjectURL(blob);
window.open(url);
```

### Read XLSX, Export PDF

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

### Standalone PDF (No Excel)

Generate PDFs from plain data — no Excel module, no Map objects, no boilerplate:

```typescript
import { Pdf } from "documonster/pdf";

// Simplest — pass a 2D array
const bytes = await Pdf.create([
  ["Product", "Revenue"],
  ["Widget", 1000],
  ["Gadget", 2500]
]);

// With options
const bytes = await Pdf.create(
  [
    ["Name", "Score"],
    ["Alice", 95],
    ["Bob", 87]
  ],
  { showGridLines: true, title: "Scores" }
);

// Multiple sheets
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

// Column widths + styled cells
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

### Watermarks

Add text or image watermarks to any PDF generated via `Pdf.create()` or `Pdf.fromExcel()`:

```typescript
// Text watermark — centered, semi-transparent, rotated
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

// Image watermark — tiled across every page
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

// Watermark on specific pages or sheets only
const bytes = await Pdf.create(data, {
  watermark: {
    type: "text",
    text: "DRAFT",
    fontSize: 60,
    color: { r: 1, g: 0, b: 0 },
    opacity: 0.2,
    pages: [1], // Only first page
    sheets: ["Summary"] // Only "Summary" sheet
  }
});
```

### Build Free-Form PDFs (PdfDocumentBuilder)

Create PDFs with precise control over text, shapes, and layout:

```typescript
import { Pdf } from "documonster/pdf";

const doc = new Pdf.Builder();
doc.setMetadata({ title: "My Report", author: "documonster" });

const page = doc.addPage({ width: 595, height: 842 }); // A4

// Text
page.drawText("Hello, World!", { x: 72, y: 770, fontSize: 24, bold: true });

// Shapes
page.drawRect({ x: 72, y: 700, width: 200, height: 50, fill: { r: 0.2, g: 0.4, b: 0.8 } });
page.drawCircle({ cx: 400, cy: 725, r: 25, fill: { r: 1, g: 0, b: 0 } });

// SVG paths
page.drawSvgPath("M 100 600 C 150 500 250 500 300 600", {
  stroke: { r: 0, g: 0.5, b: 0 },
  lineWidth: 2
});

// Annotations
page.addAnnotation({
  type: "Highlight",
  rect: [72, 765, 250, 785],
  color: { r: 1, g: 1, b: 0 }
});

// Form fields
page.addFormField({
  type: "text",
  name: "email",
  rect: [72, 550, 300, 575]
});

// Encryption
doc.setEncryption({ ownerPassword: "admin", userPassword: "reader" });

// Font embedding (for Unicode/CJK)
doc.embedFont(fontFileBytes);

const bytes = await doc.build();
```

### Edit Existing PDFs (PdfEditor)

Overlay content, fill forms, merge documents, and manipulate pages:

```typescript
import { Pdf } from "documonster/pdf";

const editor = Pdf.Editor.load(existingPdfBytes);

// Overlay text and shapes on page 1
const page = editor.getPage(0);
page.drawText("CONFIDENTIAL", { x: 200, y: 400, fontSize: 36, color: { r: 1, g: 0, b: 0 } });

// Add annotations to existing pages
page.addAnnotation({ type: "Highlight", rect: [72, 700, 300, 720] });

// Add form fields to existing pages
page.addFormField({ type: "text", name: "note", rect: [72, 650, 300, 675] });

// Draw SVG paths on existing pages
page.drawSvgPath("M 100 600 L 200 600 L 150 550 Z", { fill: { r: 0, g: 0.5, b: 1 } });

// Fill form fields
editor.setFormField("name", "Jane Doe");
editor.setFormField("agree", "Yes");

// Page manipulation
editor.removePage(2); // Remove page 3
editor.rotatePage(0, 90); // Rotate page 1
editor.addPage(); // Add blank page

// Copy pages from another PDF
editor.copyPagesFrom(otherPdfBytes);

// Save (full rebuild or incremental append)
const result = await editor.save();
const incremental = await editor.saveIncremental(); // preserves original bytes
```

### Digital Signatures

```typescript
import { Pdf } from "documonster/pdf";

// Verify a signature
const result = await Pdf.verifySignature(pdfBytes, signatureHex, byteRange);
console.log(result.valid, result.coversWholeFile);

// Sign a PDF (requires DER-encoded certificate + PKCS#8 private key)
const signed = await Pdf.sign(pdfWithPlaceholder, certificate, privateKey);
```

---

## Architecture

The PDF module is split into four layers:

```
src/modules/pdf/
├── core/               # PDF primitives (objects, streams, writer, encryption, digital signatures)
├── font/               # TTF parsing, glyph metrics, font subsetting, embedding
├── render/             # Layout engine, page renderer, style converter
│   ├── layout-engine   — PdfSheetData → LayoutPage[] (zero @excel imports)
│   ├── page-renderer   — LayoutPage → PDF content stream (zero @excel imports)
│   ├── style-converter — PdfCellStyle → PDF rendering params (zero @excel imports)
│   ├── png-decoder     — PNG image decoding for PDF embedding (zero @excel imports)
│   └── pdf-exporter    — PdfWorkbook → Uint8Array (zero @excel imports)
├── builder/            # Free-form PDF creation and editing
│   ├── document-builder — PdfDocumentBuilder + PdfPageBuilder (text, shapes, SVG, annotations, forms)
│   ├── pdf-editor      — PdfEditor + PdfEditorPage (overlay, merge, split, sign)
│   ├── form-appearance — Form field appearance stream generation
│   ├── resource-merger — Resource dictionary merge for overlays
│   └── image-utils     — Shared image XObject writing
├── reader/             # PDF reader — tokenizer, parser, decryption, text/image extraction
│   ├── pdf-tokenizer   — byte-level PDF tokenization
│   ├── pdf-parser      — objects, xref tables/streams, trailer
│   ├── pdf-document    — document structure, page tree, object resolution
│   ├── pdf-decrypt     — RC4/AES decryption for all PDF encryption versions
│   ├── stream-filters  — Flate, ASCII85, ASCIIHex, LZW, RunLength decoders
│   ├── cmap-parser     — ToUnicode CMap parsing with variable-length codespace
│   ├── font-decoder    — Type1, TrueType, Type0/CID, Symbol, ZapfDingbats
│   ├── content-interpreter — BT/ET, Tj/TJ, Tm/Td, Form XObject, inline images
│   ├── text-reconstruction — line building, table/multi-column detection, RTL
│   ├── image-extractor — JPEG, JPEG2000, CCITT, JBIG2, raw, SMask
│   ├── annotation-extractor — Link, Text, Highlight, FreeText, Stamp, etc.
│   ├── form-extractor  — AcroForm: text, checkbox, radio, dropdown, listbox, signature
│   ├── bookmark-extractor — Nested outline tree extraction
│   ├── table-extractor — Heuristic table detection from text positions
│   ├── metadata-reader — Info dict + XMP metadata
│   ├── reader-utils    — shared reader utility functions
│   └── pdf-reader      — public API: Pdf.read()
├── types.ts            # PdfWorkbook, PdfSheetData, PdfCellData, etc.
├── excel-bridge.ts     # Excel Workbook → PdfWorkbook conversion (ONLY @excel dependency)
└── index.ts
```

The entire PDF engine (core, font, render, reader) has **zero imports from the Excel module**. The `excel-bridge.ts` is the only file that knows about Excel — it converts `Workbook` to `PdfWorkbook`.

**Write strategy:** Write PDF 2.0 only (modern, AES-256).
**Read strategy:** Read all major PDF versions (1.0 through 2.0, all encryption types).

---

## Writer Options

`Pdf.create()` accepts `PdfExportOptions`. `Pdf.fromExcel()` accepts
`ExcelToPdfOptions`, which extends the same writer options with an optional,
strongly typed formula recalculation hook:

```typescript
import { calculateFormulas } from "documonster/excel/formula";
import { Pdf, type ExcelToPdfOptions } from "documonster/pdf";

const options: ExcelToPdfOptions = {
  recalculate: calculateFormulas,
  fitToPage: true
};
const bytes = await Pdf.fromExcel(workbook, options);
```

Omit `recalculate` to render the workbook's existing cached formula results.
The separate callback keeps the formula engine out of bundles that do not opt
in.

```typescript
interface PdfExportOptions {
  // Page layout
  pageSize?: PageSizeName | PdfPageSize; // "A4", "LETTER", "A3", etc. or { width, height }
  orientation?: "portrait" | "landscape";
  margins?: Partial<PdfMargins>; // { top, right, bottom, left } in points (72pt = 1in)
  fitToPage?: boolean; // Scale columns to fit page width (default: true)
  scale?: number; // Additional scale factor (default: 1.0)

  // Content
  showGridLines?: boolean; // Render cell grid lines
  gridLineColor?: string; // ARGB color for grid lines (e.g. "FF3366CC")
  repeatRows?: number | false; // Number of header rows to repeat on each page
  sheets?: (string | number)[]; // Select specific sheets by name or 1-based index
  ignorePrintArea?: boolean; // Export the full used range, ignoring each sheet's print area (default: false)

  // Headers & footers
  showSheetNames?: boolean; // Show sheet name at top of each page
  showPageNumbers?: boolean; // Show "Page X of Y" at bottom of each page

  // Metadata
  title?: string;
  author?: string;
  subject?: string;
  creator?: string; // PDF producer string (default: "documonster")

  // Font
  font?: Uint8Array; // TrueType font file bytes (for Unicode/CJK)
  defaultFontFamily?: string; // Fallback font family (default: "Helvetica")
  defaultFontSize?: number; // Fallback font size (default: 11)

  // Encryption (AES-256, PDF 2.0)
  encryption?: {
    ownerPassword: string; // Owner password (required)
    userPassword?: string; // User open password (optional)
    permissions?: {
      print?: boolean; // Allow printing
      modify?: boolean; // Allow modification
      copy?: boolean; // Allow copy/paste
      annotate?: boolean; // Allow annotations
      fillForms?: boolean; // Allow form filling
      accessibility?: boolean; // Allow accessibility extraction
      assemble?: boolean; // Allow document assembly
      printHighQuality?: boolean; // Allow high-quality printing
    };
  };
}
```

## Reader Options

```typescript
interface ReadPdfOptions {
  password?: string; // Password for encrypted PDFs (user or owner)
  pages?: number[]; // Which pages to extract (1-based). Omit for all pages
  extractText?: boolean; // Extract text (default: true)
  extractImages?: boolean; // Extract images (default: true)
  extractMetadata?: boolean; // Extract metadata (default: true)
  extractAnnotations?: boolean; // Extract annotations (default: true)
  extractFormFields?: boolean; // Extract form fields (default: true)
  extractBookmarks?: boolean; // Extract bookmarks/outlines (default: true)
  extractTables?: boolean; // Extract tables via heuristics (default: false)
}
```

### Reader Result

```typescript
interface ReadPdfResult {
  text: string; // All text from all pages
  pages: ReadPdfPage[]; // Per-page results
  metadata: PdfMetadata; // Document metadata
  formFields: PdfFormField[]; // Form fields (document-level)
  bookmarks: PdfBookmark[]; // Document outline / TOC
}

interface ReadPdfPage {
  pageNumber: number; // 1-based
  text: string; // Page text
  textLines: TextLine[]; // Structured lines with positions
  textFragments: TextFragment[]; // Raw fragments with exact coordinates
  images: ExtractedImage[]; // Extracted images
  annotations: PdfAnnotation[]; // Annotations (links, comments, highlights)
  width: number; // Page width in points
  height: number; // Page height in points
  warnings: string[]; // Non-fatal extraction warnings
}

interface PdfAnnotation {
  subtype: string; // "Link", "Text", "Highlight", "FreeText", "Stamp", etc.
  rect: PdfRect; // Bounding rectangle { x1, y1, x2, y2 }
  contents: string; // Text content
  author: string; // Author / title
  uri: string; // For Link: destination URI
  destination: string; // For Link: named destination
  color: number[]; // Color array [r, g, b] in [0,1]
  flags: number; // Annotation flags
}

interface PdfFormField {
  name: string; // Fully qualified name (e.g. "form.address.city")
  type: PdfFormFieldType; // "text" | "checkbox" | "radio" | "dropdown" | "listbox" | "button" | "signature"
  value: string; // Current value
  defaultValue: string; // Default value
  readOnly: boolean; // Read-only flag
  required: boolean; // Required flag
  options: string[]; // For choice fields: available options
  exportValue: string; // For checkboxes: export value when checked
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

### Page Sizes

Built-in page sizes accessible via `Pdf.PageSizes`:

| Name        | Dimensions (pt)  | Millimeters |
| ----------- | ---------------- | ----------- |
| `"LETTER"`  | 612 x 792        | 216 x 279   |
| `"LEGAL"`   | 612 x 1008       | 216 x 356   |
| `"TABLOID"` | 792 x 1224       | 279 x 432   |
| `"A3"`      | 841.89 x 1190.55 | 297 x 420   |
| `"A4"`      | 595.28 x 841.89  | 210 x 297   |
| `"A5"`      | 419.53 x 595.28  | 148 x 210   |

Custom sizes: `{ width: 396, height: 612 }` (in points, 72pt = 1 inch).

---

## Styling Support

The PDF writer renders all standard cell styles:

### Text

- Font family, size, bold, italic
- Font color (ARGB, theme colors with tint)
- Underline and strikethrough
- Rich text (mixed formatting per cell)
- Number/date/currency formatting via `numFmt`
- Hyperlinks (clickable annotations)

### Alignment

- Horizontal: left, center, right
- Vertical: top, middle, bottom
- Text wrapping with word-break
- Text indentation
- Text rotation (angled and vertical stacked)

### Cells

- Background fills (solid colors with alpha transparency)
- Borders: thin, medium, thick, dashed, dotted (with colors)
- Merged cells (horizontal and vertical spans)

---

## Pagination

### Automatic

- Rows overflow the page height: automatic vertical page breaks
- Columns overflow the page width: automatic horizontal page splitting
- `fitToPage: true` (default): scales all columns to fit within page width

### Repeat Header Rows

```typescript
await Pdf.fromExcel(workbook, { repeatRows: 2 }); // Repeat first 2 rows on every page
```

Or via worksheet page setup:

```typescript
worksheet.pageSetup.printTitlesRow = "1:2"; // Repeat rows 1-2
```

### Manual Page Breaks

```typescript
worksheet.rowBreaks.push({ id: 20, max: 16838, man: 1 }); // Break after row 20
```

### Print Area

```typescript
worksheet.pageSetup.printArea = "A1:F50"; // Export only this range
```

> **Note:** If a multi-range print area is set (e.g. `"A1:B5&&D1:E10"`), only the first range is used for PDF export.

To export the full used range and ignore any print area without modifying the workbook, pass `ignorePrintArea`:

```typescript
await Pdf.fromExcel(workbook, { ignorePrintArea: true });
```

---

## Images

JPEG and PNG images are embedded when sheets contain images:

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
// Image appears in the PDF at the specified position
```

PNG transparency (RGBA and tRNS) is preserved via PDF soft masks.

---

## Encryption

The writer produces **AES-256 encrypted PDFs** (PDF 2.0, V=5, R=5). The reader can decrypt **all major encryption formats** including legacy RC4.

### Writer Encryption (AES-256)

#### Owner-Only (No Open Password)

```typescript
const pdf = await Pdf.fromExcel(workbook, {
  encryption: {
    ownerPassword: "admin",
    permissions: { print: true, copy: false, modify: false }
  }
});
// Opens without password, but copy/modify is restricted
```

#### Open Password Required

```typescript
const pdf = await Pdf.fromExcel(workbook, {
  encryption: {
    ownerPassword: "admin",
    userPassword: "reader"
  }
});
// Requires "reader" to open
```

### Reader Decryption (All Formats)

The reader automatically detects and decrypts:

| Format  | Version    | Support |
| ------- | ---------- | ------- |
| RC4-40  | V=1, R=2   | Read    |
| RC4-128 | V=2, R=3   | Read    |
| AES-128 | V=4, R=4   | Read    |
| AES-256 | V=5, R=5/6 | Read    |

```typescript
// Automatically detects encryption type
const result = await Pdf.read(encryptedBytes, { password: "secret" });
```

---

## Unicode / CJK Support

Standard Type1 fonts (Helvetica, Times, Courier) only support Latin characters. For Unicode, CJK, or other scripts, provide a TrueType font:

```typescript
import { readFileSync } from "fs";

const pdf = await Pdf.fromExcel(workbook, {
  font: readFileSync("NotoSansSC-Regular.ttf")
});
```

The font is automatically subsetted (only used glyphs are embedded) to minimize PDF file size.

---

## Per-Sheet Page Setup

Each sheet's `pageSetup` is respected when using the Excel bridge:

```typescript
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const ws1 = Workbook.addWorksheet(workbook, "Summary");
ws1.pageSetup.paperSize = 9; // A4
ws1.pageSetup.orientation = "portrait";

const ws2 = Workbook.addWorksheet(workbook, "Data");
ws2.pageSetup.paperSize = 1; // Letter
ws2.pageSetup.orientation = "landscape";

// Each sheet renders with its own page size/orientation
const pdf = await Pdf.fromExcel(workbook);
```

Worksheet margins are also inherited:

```typescript
ws.pageSetup.margins = {
  left: 0.5, // inches
  right: 0.5,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3
};
```

---

## Tree-Shaking

The PDF module is fully tree-shakeable. If you don't import any PDF exports, the module adds **zero bytes** to your bundle:

```typescript
// Only imports Excel core — PDF module is NOT included
import { Workbook } from "documonster/excel";

// Imports Excel + PDF bridge
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";
```

---

## Examples

Runnable examples are in `src/modules/pdf/examples/`:

| File                   | What it demonstrates                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pdf-basic.ts`         | Page sizes, margins, metadata, sheet selection, scale                                                        |
| `pdf-styled.ts`        | Fonts, fills, borders, alignment, merge, rotation, rich text, number formats                                 |
| `pdf-advanced.ts`      | Pagination, page breaks, encryption, transparency, bookmarks, hidden rows/cols                               |
| `pdf-excel-to-pdf.ts`  | Reading real `.xlsx` files and converting to PDF                                                             |
| `pdf-images.ts`        | Image embedding (JPEG, PNG with transparency)                                                                |
| `pdf-reader.ts`        | Text extraction, metadata, images, encrypted PDFs, selective extraction                                      |
| `pdf-reader-stress.ts` | Large-scale stress test: thousands of cells, encrypted roundtrip, benchmarks                                 |
| `pdf-builder.ts`       | PdfDocumentBuilder, PdfEditor, annotations, forms, SVG paths, bookmarks, TOC, PDF/A, merge, incremental save |
| `pdf-signatures.ts`    | Digital signature placeholders, ASN.1 parsing, signature verification                                        |

Run any example:

```bash
npx tsx src/modules/pdf/examples/pdf-basic.ts
# Output: tmp/pdf-examples/*.pdf

npx tsx src/modules/pdf/examples/pdf-builder.ts
# Output: tmp/pdf-builder-examples/*.pdf

npx tsx src/modules/pdf/examples/pdf-signatures.ts
# Output: tmp/pdf-signature-examples/
```

---

## API Reference

### `Pdf.read(data, options?)`

Read a PDF file and extract text, images, and metadata. Returns `Promise<ReadPdfResult>`.

```typescript
import { Pdf } from "documonster/pdf";

// Basic
const result = await Pdf.read(pdfBytes);
console.log(result.text);
console.log(result.pages[0].images);
console.log(result.pages[0].annotations);
console.log(result.formFields);
console.log(result.metadata);

// Encrypted
const result = await Pdf.read(pdfBytes, { password: "secret" });

// Selective
const result = await Pdf.read(pdfBytes, {
  pages: [1, 3],
  extractImages: false,
  extractMetadata: false
});
```

### `Pdf.create(input, options?)`

Generate a PDF from plain data. Returns `Promise<Uint8Array>`.

```typescript
// 2D array
await Pdf.create([["Name", "Age"], ["Alice", 30]]);

// Single sheet with column widths
await Pdf.create({ name: "Report", columns: [{ width: 25 }, 15], data: [["A", "B"]] });

// Multiple sheets
await Pdf.create({ sheets: [{ name: "S1", data: [...] }, { name: "S2", data: [...] }] });

// With options
await Pdf.create([["A", 1]], { showGridLines: true, pageSize: "A4" });
```

### `Pdf.fromExcel(workbook, options?)`

Convert an Excel `Workbook` to PDF. Returns `Promise<Uint8Array>`.

```typescript
import { Workbook } from "documonster/excel";
import { Pdf } from "documonster/pdf";

const workbook = Workbook.create();
// ... build workbook ...
const bytes = await Pdf.fromExcel(workbook, { showGridLines: true });
```

### `Pdf.Builder`

Build free-form PDFs with text, vector graphics, annotations, and form fields.

```typescript
import { Pdf } from "documonster/pdf";

const doc = new Pdf.Builder();
doc.setMetadata({ title, author, subject, creator });
doc.setEncryption({ ownerPassword, userPassword?, permissions? });
doc.setPdfACompliance();       // Enable PDF/A-1b
doc.embedFont(fontBytes);      // TrueType font for Unicode/CJK

const page = doc.addPage({ width?, height? }); // Returns PdfPageBuilder

// PdfPageBuilder methods:
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

const bytes = await doc.build(); // Returns Promise<Uint8Array>
```

### `Pdf.Editor`

Edit existing PDFs — overlay content, fill forms, merge, split, and sign.

```typescript
import { Pdf } from "documonster/pdf";

const editor = Pdf.Editor.load(pdfBytes, { password? });

// Page access
const page = editor.getPage(index);    // Returns PdfEditorPage
const count = editor.pageCount;         // getter, not a method

// PdfEditorPage methods (same drawing API as PdfPageBuilder):
page.drawText(text, options);
page.drawRect(options);
page.drawCircle(options);
page.drawLine(options);
page.drawImage(options);
page.drawSvgPath(d, options);
page.drawPath(ops, options);
page.addAnnotation(options);
page.addFormField(options);

// Page manipulation
editor.addPage(options?);              // Returns PdfEditorPage
editor.removePage(index);
editor.rotatePage(index, degrees);     // 90, 180, 270
editor.copyPagesFrom(otherPdfBytes);

// Form filling
editor.setFormField(name, value);
editor.setFormFields({ name: value, ... });

// Save
const full = await editor.save();             // Full rebuild
const incr = await editor.saveIncremental();  // Append-only
const pages = await editor.splitPages();      // Split into individual PDFs
```

### `Pdf.verifySignature(pdfData, signatureHex, byteRange)`

Verify a digital signature. Returns `Promise<SignatureVerificationResult>`.

```typescript
import { Pdf } from "documonster/pdf";

const result = await Pdf.verifySignature(pdfBytes, sigHex, [0, off1, off2, len2]);
// result.valid            — boolean
// result.coversWholeFile  — boolean (no unsigned gaps)
// result.digestAlgorithm  — OID string
// result.reason           — failure reason (if !valid)
```

### `Pdf.sign(pdfBytes, certificate, privateKey)`

Sign a PDF containing a signature placeholder. Returns `Promise<Uint8Array>`.

```typescript
import { Pdf } from "documonster/pdf";

// Step 1: Build placeholder
const { dictString, placeholder } = Pdf.buildSignatureDictPlaceholder({
  name?, reason?, location?, contactInfo?
});

// Step 2: Sign (certificate = DER X.509, privateKey = DER PKCS#8)
const signed = await Pdf.sign(pdfWithPlaceholder, certificate, privateKey);
```

### `Pdf.parseSvgPath(d)`

Parse an SVG path `d` attribute into an array of `PathOp` objects for `drawPath()`.

```typescript
import { Pdf } from "documonster/pdf";

const ops = Pdf.parseSvgPath("M10 10 L90 10 L50 80 Z");
page.drawPath(ops, { fill: { r: 1, g: 0, b: 0 } });
```

### Error Types

```typescript
import {
  PdfError, // Base class for all PDF errors
  PdfRenderError, // Layout/rendering failures
  PdfFontError, // Font parsing/embedding failures
  PdfStructureError, // PDF structure assembly failures
  isPdfError // Type guard: (err: unknown) => err is PdfError
} from "documonster/pdf";
```

All errors extend `BaseError` with `cause` chain support:

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
