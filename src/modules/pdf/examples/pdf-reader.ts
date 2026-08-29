/**
 * Example: PDF Reader — All Use Cases
 *
 * Demonstrates every readPdf capability:
 *   1. Basic text extraction
 *   2. Multi-page text extraction
 *   3. Metadata extraction
 *   4. Image extraction (JPEG + PNG roundtrip)
 *   5. Encrypted PDF (user password + owner password)
 *   6. Selective extraction (specific pages, text-only, metadata-only)
 *   7. Text positioning & line structure
 *   8. Excel-to-PDF roundtrip
 *   9. Error handling (wrong password, invalid data)
 *
 * Run: pnpm example --filter pdf-reader
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Workbook, Worksheet } from "@excel/index";

import { PdfStructureError } from "../errors";
import { Pdf } from "../index";
import { pdf } from "../pdf";
import { readPdf } from "../reader/pdf-reader";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// Helper: write text to file and print summary
function save(filename: string, content: string): void {
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  console.log(`  → ${filePath}`);
}

// Helper: build a minimal JPEG (1x1 pixel)
function buildMinimalJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...Array.from({ length: 64 }, () => 0x01),
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x01,
    0x00,
    0x01,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xc4,
    0x00,
    0x1f,
    0x00,
    0x00,
    0x01,
    0x05,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x7b,
    0x40,
    0xff,
    0xd9
  ]);
}

// Helper: build a minimal PNG (2x2 RGBA)
function buildMinimalPng(): Uint8Array {
  const parts: number[] = [];
  parts.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

  function writeChunk(type: string, data: number[]): void {
    const len = data.length;
    parts.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    for (let i = 0; i < 4; i++) {
      parts.push(type.charCodeAt(i));
    }
    parts.push(...data);
    const crcInput = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) {
      crcInput[i] = type.charCodeAt(i);
    }
    for (let i = 0; i < data.length; i++) {
      crcInput[4 + i] = data[i];
    }
    let crc = 0xffffffff;
    for (let i = 0; i < crcInput.length; i++) {
      crc ^= crcInput[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    parts.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  }

  const ihdr = [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0];
  writeChunk("IHDR", ihdr);

  const raw = [
    0x00, 0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x80, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
    0xff, 0x00
  ];
  const len = raw.length;
  const deflated = [
    0x78,
    0x01,
    0x01,
    len & 0xff,
    (len >>> 8) & 0xff,
    ~len & 0xff,
    (~len >>> 8) & 0xff,
    ...raw
  ];
  let a = 1,
    b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  deflated.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  writeChunk("IDAT", deflated);
  writeChunk("IEND", []);

  return new Uint8Array(parts);
}

console.log("=== PDF Reader Examples ===\n");
console.log(`Output directory: ${outDir}\n`);

// =============================================================================
// 1. Basic Text Extraction
// =============================================================================

console.log("--- 1. Basic Text Extraction ---\n");

const basicPdf = await pdf([
  ["Product", "Price", "Quantity"],
  ["Widget A", 19.99, 100],
  ["Widget B", 24.5, 250],
  ["Widget C", 9.99, 500]
]);

const basic = await readPdf(basicPdf);
const basicOutput = [
  `Pages: ${basic.pages.length}`,
  `Full text:`,
  basic.text,
  "",
  `Page 1 dimensions: ${basic.pages[0].width} x ${basic.pages[0].height} points`
].join("\n");

console.log(basicOutput);
save("01-basic-text.txt", basicOutput);

// =============================================================================
// 2. Multi-Page Text Extraction
// =============================================================================

console.log("\n--- 2. Multi-Page Text Extraction ---\n");

const multiPdf = await pdf({
  sheets: [
    {
      name: "Q1 Sales",
      data: [
        ["Region", "Revenue"],
        ["North", 50000],
        ["South", 42000]
      ]
    },
    {
      name: "Q2 Sales",
      data: [
        ["Region", "Revenue"],
        ["North", 55000],
        ["South", 47000]
      ]
    },
    {
      name: "Q3 Sales",
      data: [
        ["Region", "Revenue"],
        ["North", 61000],
        ["South", 53000]
      ]
    }
  ]
});

const multi = await readPdf(multiPdf);
const multiOutput = [
  `Total pages: ${multi.pages.length}`,
  "",
  ...multi.pages.map(p =>
    [
      `--- Page ${p.pageNumber} (${p.width} x ${p.height} pts) ---`,
      p.text,
      `  Warnings: ${p.warnings.length === 0 ? "none" : p.warnings.join(", ")}`
    ].join("\n")
  )
].join("\n\n");

console.log(multiOutput);
save("02-multi-page.txt", multiOutput);

// =============================================================================
// 3. Metadata Extraction
// =============================================================================

console.log("\n--- 3. Metadata Extraction ---\n");

const metaPdf = await pdf([["Data", 123]], {
  title: "Quarterly Report",
  author: "Finance Team",
  subject: "Q4 2025 Financials",
  creator: "documonster PDF module"
});

const meta = await readPdf(metaPdf);
const m = meta.metadata;
const metaOutput = [
  `Title:      ${m.title}`,
  `Author:     ${m.author}`,
  `Subject:    ${m.subject}`,
  `Keywords:   ${m.keywords}`,
  `Creator:    ${m.creator}`,
  `Producer:   ${m.producer}`,
  `PDF Ver:    ${m.pdfVersion}`,
  `Pages:      ${m.pageCount}`,
  `Encrypted:  ${m.encrypted}`,
  `Page Size:  ${m.pageSize?.width} x ${m.pageSize?.height} pts`,
  `Created:    ${m.creationDate?.toISOString() ?? "N/A"}`,
  `Modified:   ${m.modDate?.toISOString() ?? "N/A"}`,
  `XMP XML:    ${m.xmpXml ? "present (" + m.xmpXml.length + " chars)" : "none"}`
].join("\n");

console.log(metaOutput);
save("03-metadata.txt", metaOutput);

// =============================================================================
// 4. Image Extraction
// =============================================================================

console.log("\n--- 4. Image Extraction ---\n");

const jpegData = buildMinimalJpeg();
const pngData = buildMinimalPng();

const imagePdf = await pdf({
  data: [["Image Gallery"]],
  images: [
    { data: jpegData, format: "jpeg", col: 0, row: 1, width: 100, height: 80 },
    { data: pngData, format: "png", col: 2, row: 1, width: 100, height: 80 }
  ]
});

const imageResult = await readPdf(imagePdf);
const imgLines: string[] = [
  `Pages: ${imageResult.pages.length}`,
  `Text: ${imageResult.text.trim()}`,
  `Images on page 1: ${imageResult.pages[0].images.length}`,
  ""
];

for (const img of imageResult.pages[0].images) {
  imgLines.push(
    `  Image "${img.name}":`,
    `    Format:     ${img.format}`,
    `    Dimensions: ${img.width} x ${img.height}`,
    `    BPC:        ${img.bitsPerComponent}`,
    `    ColorSpace:  ${img.colorSpace} (${img.components} components)`,
    `    Data size:   ${img.data.length} bytes`,
    `    Alpha mask:  ${img.alphaMask ? img.alphaMask.length + " bytes" : "none"}`,
    `    Filter:      ${img.filter}`,
    ""
  );
}

// Save extracted JPEG image as actual file
const jpegImg = imageResult.pages[0].images.find(i => i.format === "jpeg");
if (jpegImg) {
  fs.writeFileSync(path.join(outDir, "04-extracted-image.jpg"), jpegImg.data);
  imgLines.push(`  → Saved extracted JPEG to 04-extracted-image.jpg`);
}

const imageOutput = imgLines.join("\n");
console.log(imageOutput);
save("04-images.txt", imageOutput);

// =============================================================================
// 5. Encrypted PDF
// =============================================================================

console.log("\n--- 5. Encrypted PDF ---\n");

const encPdf = await pdf(
  [
    ["Account", "Balance"],
    ["Checking", 12500.0],
    ["Savings", 87300.5],
    ["Investment", 245000.0]
  ],
  {
    title: "Confidential Account Summary",
    author: "Bank Secure",
    encryption: {
      ownerPassword: "admin-secret",
      userPassword: "reader-pass"
    }
  }
);

// Read with user password
const encUser = await readPdf(encPdf, { password: "reader-pass" });

// Read with owner password
const encOwner = await readPdf(encPdf, { password: "admin-secret" });

// Try wrong password
let wrongPwError = "";
try {
  await readPdf(encPdf, { password: "wrong" });
} catch (err) {
  wrongPwError = err instanceof Error ? err.message : String(err);
}

const encOutput = [
  "With user password:",
  `  Encrypted: ${encUser.metadata.encrypted}`,
  `  Title: ${encUser.metadata.title}`,
  `  Author: ${encUser.metadata.author}`,
  `  Text: ${encUser.text.trim().substring(0, 200)}`,
  "",
  "With owner password:",
  `  Text: ${encOwner.text.trim().substring(0, 200)}`,
  "",
  "With wrong password:",
  `  Error: ${wrongPwError}`
].join("\n");

console.log(encOutput);
save("05-encrypted.txt", encOutput);

// =============================================================================
// 6. Selective Extraction
// =============================================================================

console.log("\n--- 6. Selective Extraction ---\n");

const selectPdf = await pdf({
  sheets: [
    { name: "Page1", data: [["First page content", 111]] },
    { name: "Page2", data: [["Second page content", 222]] },
    { name: "Page3", data: [["Third page content", 333]] },
    { name: "Page4", data: [["Fourth page content", 444]] }
  ]
});

// Extract only pages 2 and 4
const pages24 = await readPdf(selectPdf, { pages: [2, 4] });

// Text only (no images, no metadata)
const textOnly = await readPdf(selectPdf, {
  extractText: true,
  extractImages: false,
  extractMetadata: false
});

// Metadata only
const metaOnly = await readPdf(selectPdf, {
  extractText: false,
  extractImages: false,
  extractMetadata: true
});

const selectOutput = [
  "Pages [2, 4] only:",
  `  Extracted ${pages24.pages.length} pages: [${pages24.pages.map(p => p.pageNumber).join(", ")}]`,
  `  Text: ${pages24.text.trim().substring(0, 150)}`,
  "",
  "Text only (no images/metadata):",
  `  Has text: ${textOnly.text.length > 0}`,
  `  Images on p1: ${textOnly.pages[0].images.length}`,
  `  Metadata title: "${textOnly.metadata.title}"`,
  "",
  "Metadata only (no text/images):",
  `  Page count: ${metaOnly.metadata.pageCount}`,
  `  Page 1 text: "${metaOnly.pages[0].text}"`,
  `  Page 1 images: ${metaOnly.pages[0].images.length}`
].join("\n");

console.log(selectOutput);
save("06-selective.txt", selectOutput);

// =============================================================================
// 7. Text Positioning & Line Structure
// =============================================================================

console.log("\n--- 7. Text Positioning & Line Structure ---\n");

const posPdf = await pdf([
  ["Name", "Department", "Salary"],
  ["Alice Chen", "Engineering", 120000],
  ["Bob Smith", "Marketing", 95000],
  ["Carol Davis", "Finance", 110000]
]);

const posResult = await readPdf(posPdf);
const page = posResult.pages[0];

const posLines: string[] = [
  `Text lines: ${page.textLines.length}`,
  `Text fragments: ${page.textFragments.length}`,
  ""
];

posLines.push("Lines:");
for (const line of page.textLines.slice(0, 8)) {
  posLines.push(`  y=${line.y.toFixed(1)}  "${line.text}"`);
}

posLines.push("", "First 10 fragments:");
for (const frag of page.textFragments.slice(0, 10)) {
  posLines.push(
    `  (${frag.x.toFixed(1)}, ${frag.y.toFixed(1)}) size=${frag.fontSize.toFixed(1)} w=${frag.width.toFixed(1)} "${frag.text}"`
  );
}

const posOutput = posLines.join("\n");
console.log(posOutput);
save("07-text-positioning.txt", posOutput);

// =============================================================================
// 8. Excel-to-PDF Roundtrip
// =============================================================================

console.log("\n--- 8. Excel-to-PDF Roundtrip ---\n");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Inventory");
Worksheet.setColumns(ws, [
  { header: "Item", key: "item", width: 20 },
  { header: "SKU", key: "sku", width: 15 },
  { header: "Qty", key: "qty", width: 10 },
  { header: "Price", key: "price", width: 12 },
  { header: "In Stock", key: "inStock", width: 10 }
]);
Worksheet.addRows(ws, [
  { item: "Laptop Pro", sku: "LP-001", qty: 42, price: 1299.99, inStock: true },
  { item: "Wireless Mouse", sku: "WM-055", qty: 350, price: 29.99, inStock: true },
  { item: "USB-C Hub", sku: "UH-112", qty: 0, price: 49.99, inStock: false },
  { item: 'Monitor 27"', sku: "MN-270", qty: 18, price: 399.99, inStock: true }
]);

const ws2 = Workbook.addWorksheet(wb, "Summary");
Cell.setValue(ws2, "A1", "Total Items");
Cell.setValue(ws2, "B1", 4);
Cell.setValue(ws2, "A2", "Total Value");
Cell.setValue(ws2, "B2", 76827.16);

const excelPdfBytes = await Pdf.fromExcel(wb, {
  title: "Inventory Report",
  author: "Warehouse System",
  orientation: "landscape"
});

// Save the PDF file
fs.writeFileSync(path.join(outDir, "08-excel-roundtrip.pdf"), excelPdfBytes);

// Read it back
const excelResult = await readPdf(excelPdfBytes);

const excelOutput = [
  `PDF file size: ${excelPdfBytes.length} bytes`,
  `Pages: ${excelResult.pages.length}`,
  `Title: ${excelResult.metadata.title}`,
  `Author: ${excelResult.metadata.author}`,
  `Encrypted: ${excelResult.metadata.encrypted}`,
  "",
  "Extracted text per page:",
  ...excelResult.pages.map(p =>
    [
      `  Page ${p.pageNumber}: ${p.width} x ${p.height} pts`,
      `    Text: ${p.text.trim().substring(0, 200)}${p.text.length > 200 ? "..." : ""}`,
      `    Lines: ${p.textLines.length}`,
      `    Fragments: ${p.textFragments.length}`,
      `    Images: ${p.images.length}`,
      `    Warnings: ${p.warnings.length === 0 ? "none" : p.warnings.join(", ")}`
    ].join("\n")
  )
].join("\n");

console.log(excelOutput);
save("08-excel-roundtrip.txt", excelOutput);

// =============================================================================
// 9. Error Handling
// =============================================================================

console.log("\n--- 9. Error Handling ---\n");

const errors: string[] = [];

// Invalid data
try {
  await readPdf(new Uint8Array([0, 1, 2, 3]));
  errors.push("Invalid data: no error (unexpected)");
} catch (err) {
  errors.push(
    `Invalid data: ${err instanceof PdfStructureError ? "PdfStructureError" : "other"} — ${(err as Error).message}`
  );
}

// Empty data
try {
  await readPdf(new Uint8Array(0));
  errors.push("Empty data: no error (unexpected)");
} catch (err) {
  errors.push(
    `Empty data: ${err instanceof PdfStructureError ? "PdfStructureError" : "other"} — ${(err as Error).message}`
  );
}

// Truncated PDF
try {
  const valid = await pdf([["test"]]);
  await readPdf(valid.subarray(0, Math.floor(valid.length / 2)));
  errors.push("Truncated PDF: no error (unexpected)");
} catch (err) {
  errors.push(
    `Truncated PDF: ${err instanceof PdfStructureError ? "PdfStructureError" : "other"} — ${(err as Error).message}`
  );
}

// Wrong password
try {
  await readPdf(encPdf, { password: "bad" });
  errors.push("Wrong password: no error (unexpected)");
} catch (err) {
  errors.push(
    `Wrong password: ${err instanceof PdfStructureError ? "PdfStructureError" : "other"} — ${(err as Error).message}`
  );
}

const errorOutput = errors.join("\n");
console.log(errorOutput);
save("09-error-handling.txt", errorOutput);

// =============================================================================
// Summary
// =============================================================================

console.log("\n=== All examples completed ===");
console.log(`Output directory: ${outDir}`);
console.log(`Files generated: ${fs.readdirSync(outDir).length}`);
