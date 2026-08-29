/**
 * Example: PDF Reader — Annotation / Table / Bookmark Extraction
 *
 * Demonstrates the read-side extraction features driven by `Pdf.read`
 * options:
 *   - extractAnnotations → result.pages[].annotations  (PdfAnnotation[])
 *   - extractTables      → result.pages[].tables        (PdfTable[])
 *   - extractBookmarks   → result.bookmarks             (PdfBookmark[])
 *
 * We first build a PDF from scratch with `Pdf.Builder` containing a sticky
 * note + highlight + free-text annotation, a grid of text laid out as a
 * table, and a nested outline (bookmarks). Then we read it back and print
 * the extracted structures.
 *
 * Usage:  pnpm example --filter pdf-reader-extraction
 * Output: tmp/pdf-examples/extraction-source.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. Build a source PDF with annotations, a table-like grid, and bookmarks
// =============================================================================

const doc = new Pdf.Builder();
doc.setMetadata({ title: "Extraction Demo", author: "documonster" });

// --- Page 1: annotations + a tabular grid ---
const page1 = doc.addPage({ width: 595, height: 842 }); // A4
page1.drawText("Extraction Demo — Page 1", { x: 72, y: 790, fontSize: 18, bold: true });

// A highlight annotation over a line of text.
page1.drawText("This sentence is highlighted for emphasis.", { x: 72, y: 750, fontSize: 12 });
page1.addAnnotation({
  type: "Highlight",
  rect: [72, 745, 360, 765],
  color: { r: 1, g: 1, b: 0 },
  contents: "Highlighted phrase",
  author: "Reviewer A"
});

// A sticky-note (Text) annotation.
page1.drawText("See note →", { x: 72, y: 720, fontSize: 12 });
page1.addAnnotation({
  type: "Text",
  rect: [150, 715, 170, 735],
  iconName: "Comment",
  contents: "Please double-check this figure.",
  author: "Reviewer B"
});

// A free-text annotation.
page1.addAnnotation({
  type: "FreeText",
  rect: [380, 700, 540, 760],
  contents: "Inline reviewer comment",
  fontSize: 10,
  author: "Reviewer C"
});

// A table laid out as a regular grid of text fragments. The table extractor
// detects rows/columns from the X/Y positions of these fragments.
const tableData = [
  ["Product", "Region", "Units"],
  ["Widget A", "North", "120"],
  ["Widget B", "South", "98"],
  ["Gadget C", "West", "210"]
];
const colX = [72, 220, 360];
let rowY = 640;
for (const row of tableData) {
  row.forEach((cell, c) => {
    page1.drawText(cell, { x: colX[c], y: rowY, fontSize: 11 });
  });
  rowY -= 24;
}

// --- Page 2: target for a child bookmark ---
const page2 = doc.addPage({ width: 595, height: 842 });
page2.drawText("Extraction Demo — Page 2", { x: 72, y: 790, fontSize: 18, bold: true });
page2.drawText("Appendix content lives here.", { x: 72, y: 750, fontSize: 12 });

// --- Bookmarks (outline): one top-level entry with a nested child ---
doc.addBookmark("Overview", 0); // points to page 1 (0-based)
doc.addBookmark("Appendix", 1); // top-level → page 2
doc.addBookmark("Appendix Details", 1, 1); // nested under "Appendix" (parent index 1)

const bytes = await doc.build();
const srcPath = path.join(outDir, "extraction-source.pdf");
fs.writeFileSync(srcPath, bytes);
console.log("=== PDF Extraction Examples ===\n");
console.log(`Built source PDF: ${srcPath} (${bytes.length} bytes)\n`);

// =============================================================================
// 2. Read it back with extraction enabled
// =============================================================================

const result = await Pdf.read(bytes, {
  extractAnnotations: true,
  extractTables: true,
  extractBookmarks: true
});

// --- Annotations (per page) ---
console.log("--- Annotations ---");
for (const page of result.pages) {
  console.log(`Page ${page.pageNumber}: ${page.annotations.length} annotation(s)`);
  for (const a of page.annotations) {
    const rect = `[${a.rect.x1.toFixed(0)}, ${a.rect.y1.toFixed(0)}, ${a.rect.x2.toFixed(0)}, ${a.rect.y2.toFixed(0)}]`;
    console.log(
      `  ${a.subtype.padEnd(10)} author="${a.author}" contents="${a.contents}" rect=${rect}`
    );
  }
}

// --- Tables (per page) ---
console.log("\n--- Tables ---");
for (const page of result.pages) {
  if (page.tables.length === 0) {
    continue;
  }
  console.log(`Page ${page.pageNumber}: ${page.tables.length} table(s)`);
  page.tables.forEach((table, ti) => {
    console.log(`  Table ${ti + 1}: ${table.rows.length} rows`);
    for (const row of table.rows) {
      console.log(`    | ${row.cells.map(c => c.text.padEnd(10)).join(" | ")} |`);
    }
  });
}

// --- Bookmarks (document-level, nested) ---
console.log("\n--- Bookmarks ---");
function printBookmarks(items: typeof result.bookmarks, depth: number): void {
  for (const b of items) {
    console.log(`${"  ".repeat(depth + 1)}• ${b.title}  → page ${b.pageIndex + 1}`);
    if (b.children.length > 0) {
      printBookmarks(b.children, depth + 1);
    }
  }
}
printBookmarks(result.bookmarks, 0);

console.log("\n=== Done ===");
