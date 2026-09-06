/**
 * Example: Comments with subdirectory layout (Issue #148)
 *
 * Demonstrates that documonster can read comments from xlsx files that use
 * the subdirectory layout (xl/comments/comment1.xml) produced by tools
 * used by some third-party tools, in addition to the standard flat layout (xl/comments1.xml).
 *
 * This example:
 * 1. Creates a workbook with comments (with authors) and writes it
 * 2. Reads it back and verifies comments + authors survive the round-trip
 * 3. Re-packs the xlsx into subdirectory layout with absolute rel targets
 * 4. Reads the subdirectory-layout file and verifies comments are parsed
 */
import fs from "node:fs";
import path from "node:path";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Note, Workbook } from "@excel/index";

import { ArchiveFile } from "../../archive/fs/archive-file";

const tmpDir = path.resolve(import.meta.dirname, "../../../../tmp/excel-examples");
fs.mkdirSync(tmpDir, { recursive: true });

const flatFile = path.join(tmpDir, "comments-flat.xlsx");
const subdirFile = path.join(tmpDir, "comments-subdir.xlsx");

// ---------------------------------------------------------------------------
// Step 1: Create a workbook with comments (with different authors)
// ---------------------------------------------------------------------------
console.log("Step 1: Creating workbook with comments...");
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Sheet1");

Cell.setValue(ws, "A1", "Hello");
Cell.setComment(ws, "A1", Note.create({ texts: [{ text: "Comment by Alice" }] }, "Alice"));

Cell.setValue(ws, "B2", "World");
Cell.setComment(ws, "B2", Note.create({ texts: [{ text: "Comment by Bob" }] }, "Bob"));

await writeBothFormats(wb, flatFile);
console.log(`  Written flat-layout file: ${flatFile}`);

// ---------------------------------------------------------------------------
// Step 2: Read back the flat-layout file and verify
// ---------------------------------------------------------------------------
console.log("\nStep 2: Reading flat-layout file...");
const wb2 = Workbook.create();
await Workbook.readFile(wb2, flatFile);
const ws2 = Workbook.getWorksheet(wb2, "Sheet1")!;

console.log(
  `  A1 note: ${JSON.stringify(Cell.getNote(ws2, "A1"))}, author: ${Cell.getComment(ws2, "A1")?.author}`
);
console.log(
  `  B2 note: ${JSON.stringify(Cell.getNote(ws2, "B2"))}, author: ${Cell.getComment(ws2, "B2")?.author}`
);
console.log(`  A1 has comment: ${Cell.getNote(ws2, "A1") != null ? "YES" : "MISSING"}`);
console.log(`  B2 has comment: ${Cell.getNote(ws2, "B2") != null ? "YES" : "MISSING"}`);
console.log(
  `  A1 author correct: ${Cell.getComment(ws2, "A1")?.author === "Alice" ? "YES" : `NO (got "${Cell.getComment(ws2, "A1")?.author}")`}`
);
console.log(
  `  B2 author correct: ${Cell.getComment(ws2, "B2")?.author === "Bob" ? "YES" : `NO (got "${Cell.getComment(ws2, "B2")?.author}")`}`
);

// ---------------------------------------------------------------------------
// Step 3: Re-pack into subdirectory layout (simulating third-party output)
// ---------------------------------------------------------------------------
console.log("\nStep 3: Re-packing into subdirectory layout...");

const flatBytes = fs.readFileSync(flatFile);
const flatZip = ArchiveFile.fromBuffer(flatBytes);
const subdirZip = new ArchiveFile();

for (const entry of flatZip.getEntriesSync()) {
  const data = flatZip.readEntrySync(entry.path);
  if (!data) {
    continue;
  }

  // Rename xl/comments1.xml → xl/comments/comment1.xml
  if (/^xl\/comments(\d+)\.xml$/.test(entry.path)) {
    const idx = entry.path.match(/comments(\d+)/)?.[1];
    const newPath = `xl/comments/comment${idx}.xml`;
    console.log(`  Renaming: ${entry.path} → ${newPath}`);
    subdirZip.addBuffer(data, newPath);
    continue;
  }

  // Rewrite [Content_Types].xml to reference the new path
  if (entry.path === "[Content_Types].xml") {
    let xml = new TextDecoder().decode(data);
    xml = xml.replace(
      /PartName="\/xl\/comments(\d+)\.xml"/g,
      'PartName="/xl/comments/comment$1.xml"'
    );
    subdirZip.addBuffer(new TextEncoder().encode(xml), entry.path);
    continue;
  }

  // Rewrite worksheet rels to use absolute target for comments
  if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(entry.path)) {
    let xml = new TextDecoder().decode(data);
    xml = xml.replace(/Target="\.\.\/comments(\d+)\.xml"/g, 'Target="/xl/comments/comment$1.xml"');
    console.log(`  Rewrote rels: ${entry.path}`);
    subdirZip.addBuffer(new TextEncoder().encode(xml), entry.path);
    continue;
  }

  subdirZip.addBuffer(data, entry.path);
}

// **XLSX only, by subject.** This file is a hand-rebuilt ZIP that rewrites relationship targets to
// `/xl/comments/commentN.xml` in order to demonstrate a package-layout quirk of the *XML* container. There is no
// binary counterpart to produce: the thing being shown is the XLSX part naming itself, not a workbook feature.
// The workbook written earlier in this example does go out in both containers.
const subdirBytes = subdirZip.toBufferSync();
fs.writeFileSync(subdirFile, subdirBytes);
console.log(`  Written subdirectory-layout file: ${subdirFile}`);

// ---------------------------------------------------------------------------
// Step 4: Read the subdirectory-layout file and verify comments are parsed
// ---------------------------------------------------------------------------
console.log("\nStep 4: Reading subdirectory-layout file...");
const wb3 = Workbook.create();
await Workbook.readFile(wb3, subdirFile);
const ws3 = Workbook.getWorksheet(wb3, "Sheet1")!;

console.log(
  `  A1 note: ${JSON.stringify(Cell.getNote(ws3, "A1"))}, author: ${Cell.getComment(ws3, "A1")?.author}`
);
console.log(
  `  B2 note: ${JSON.stringify(Cell.getNote(ws3, "B2"))}, author: ${Cell.getComment(ws3, "B2")?.author}`
);
console.log(`  A1 has comment: ${Cell.getNote(ws3, "A1") != null ? "YES" : "MISSING"}`);
console.log(`  B2 has comment: ${Cell.getNote(ws3, "B2") != null ? "YES" : "MISSING"}`);
console.log(
  `  A1 author correct: ${Cell.getComment(ws3, "A1")?.author === "Alice" ? "YES" : `NO (got "${Cell.getComment(ws3, "A1")?.author}")`}`
);
console.log(
  `  B2 author correct: ${Cell.getComment(ws3, "B2")?.author === "Bob" ? "YES" : `NO (got "${Cell.getComment(ws3, "B2")?.author}")`}`
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const allPassed =
  Cell.getNote(ws2, "A1") != null &&
  Cell.getNote(ws2, "B2") != null &&
  Cell.getComment(ws2, "A1")?.author === "Alice" &&
  Cell.getComment(ws2, "B2")?.author === "Bob" &&
  Cell.getNote(ws3, "A1") != null &&
  Cell.getNote(ws3, "B2") != null &&
  Cell.getComment(ws3, "A1")?.author === "Alice" &&
  Cell.getComment(ws3, "B2")?.author === "Bob";

console.log(
  `\n${allPassed ? "SUCCESS" : "FAILURE"}: Comments and authors ${allPassed ? "correctly round-tripped" : "NOT fully preserved"} across both layouts.`
);

if (!allPassed) {
  process.exit(1);
}
