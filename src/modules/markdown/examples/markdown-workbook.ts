/**
 * Example: Round-Trip & Workbook Integration
 *
 * Covers:
 * - format → parse → format round-trip fidelity
 * - Workbook.readMarkdown / writeMarkdown
 * - Workbook.readMarkdownAll (multi-table → worksheets)
 * - Workbook.writeMarkdownBuffer
 * - Value mapper on readMarkdown
 * - Multiline round-trip through Workbook
 * - Error handling with MarkdownParseError
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readMarkdown,
  readMarkdownAll,
  writeMarkdown,
  writeMarkdownBuffer
} from "@excel/bridge/markdown-bridge";
import {
  readMarkdownAllFile,
  readMarkdownFile,
  writeMarkdownFile
} from "@excel/bridge/markdown-bridge.node";
import { Cell, Workbook, Worksheet } from "@excel/index";

import { Markdown, MarkdownParseError } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/markdown-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. Round-trip fidelity
// =============================================================================

console.log("=== 1. Round-Trip ===\n");

const headers = ["Name", "Formula", "Path"];
const rows: string[][] = [
  ["Alice", "a | b", "C:\\Users"],
  ["Bob", "x > y", "D:\\Data"]
];

const markdown1 = Markdown.format(headers, rows, {
  columns: [
    { header: "Name", alignment: "left" },
    { header: "Formula", alignment: "center" },
    { header: "Path", alignment: "right" }
  ]
});
console.log("Formatted:");
console.log(markdown1);

const parsed = Markdown.parse(markdown1);
const markdown2 = Markdown.format(parsed.headers, parsed.rows, {
  columns: parsed.headers.map((h, i) => ({
    header: h,
    alignment: parsed.alignments[i]
  }))
});

console.log("Round-trip match:", markdown1 === markdown2 ? "PASS" : "FAIL");
fs.writeFileSync(path.join(outDir, "round-trip.md"), markdown1, "utf8");
console.log();

// =============================================================================
// 2. Workbook.readMarkdown / writeMarkdown
// =============================================================================

console.log("=== 2. Workbook readMarkdown / writeMarkdown ===\n");

const markdownInput = `
| Name  | Age | Department  |
| :---- | --: | :---------: |
| Alice | 30  | Engineering |
| Bob   | 25  | Marketing   |
| Carol | 35  | Engineering |
`.trim();

const wb1 = Workbook.create();
const ws = readMarkdown(wb1, markdownInput, { sheetName: "Employees" });

console.log("Sheet:", Worksheet.getName(ws), "| Rows:", Worksheet.rowCount(ws));
for (let r = 1; r <= Worksheet.rowCount(ws); r++) {
  console.log(
    `  Row ${r}: ${Cell.getValue(ws, r, 1)} | ${Cell.getValue(ws, r, 2)} | ${Cell.getValue(ws, r, 3)}`
  );
}

const mdOut = writeMarkdown(wb1, { sheetName: "Employees" });
console.log("\nWritten back:");
console.log(mdOut);
fs.writeFileSync(path.join(outDir, "workbook-single.md"), mdOut, "utf8");

// =============================================================================
// 3. Workbook.readMarkdownAll
// =============================================================================

console.log("=== 3. readMarkdownAll ===\n");

const multiDoc = `
# Q1 Report

| Product | Revenue |
| :------ | ------: |
| Widget  | $10,000 |
| Gadget  | $25,000 |

| Category  | Amount  |
| :-------- | ------: |
| Salaries  | $50,000 |
| Rent      | $5,000  |

| Metric  | Value    |
| :------ | -------: |
| Revenue | $35,000  |
| Net     | -$28,000 |
`.trim();

const wb2 = Workbook.create();
const sheets = readMarkdownAll(wb2, multiDoc, { sheetName: "Q1" });

console.log(`Created ${sheets.length} worksheets:`);
const allMarkdown: string[] = [];
for (const s of sheets) {
  const markdown = writeMarkdown(wb2, { sheetName: Worksheet.getName(s) });
  console.log(`\n--- ${Worksheet.getName(s)} ---`);
  console.log(markdown);
  allMarkdown.push(`## ${Worksheet.getName(s)}\n\n${markdown}`);
}
fs.writeFileSync(
  path.join(outDir, "workbook-multi.md"),
  "# Multi-Table Workbook\n\n" + allMarkdown.join("\n"),
  "utf8"
);

// =============================================================================
// 4. writeMarkdownBuffer
// =============================================================================

console.log("=== 4. writeMarkdownBuffer ===\n");
const buffer = writeMarkdownBuffer(wb2, { sheetName: "Q1" });
console.log(`Buffer: ${buffer.length} bytes`);
fs.writeFileSync(path.join(outDir, "workbook-buffer.md"), buffer);
console.log();

// =============================================================================
// 5. Value mapper
// =============================================================================

console.log("=== 5. Value Mapper ===\n");

const wb3 = Workbook.create();
const ws3 = readMarkdown(wb3, markdownInput, {
  sheetName: "Typed",
  map: (value: string, _col: number) => {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
});
console.log("Age type:", typeof Cell.getValue(ws3, 2, 2));
console.log("Age value:", Cell.getValue(ws3, 2, 2));
console.log();

// =============================================================================
// 6. Multiline round-trip through Workbook
// =============================================================================

console.log("=== 6. Multiline Workbook Round-Trip ===\n");

const wb4 = Workbook.create();
const ws4 = Workbook.addWorksheet(wb4, "Notes");
Worksheet.addRow(ws4, ["Name", "Address"]);
Worksheet.addRow(ws4, ["Alice", "123 Main St\nApt 4\nNew York"]);
Worksheet.addRow(ws4, ["Bob", "456 Oak Ave\nLondon"]);

const markdownMultiline = writeMarkdown(wb4, { sheetName: "Notes" });
console.log("Written:");
console.log(markdownMultiline);

const wb5 = Workbook.create();
const ws5 = readMarkdown(wb5, markdownMultiline, { sheetName: "Notes", convertBr: true });
console.log("Parsed back (address):", JSON.stringify(Cell.getValue(ws5, 2, 2)));
fs.writeFileSync(path.join(outDir, "multiline-workbook.md"), markdownMultiline, "utf8");
console.log();

// =============================================================================
// 7. Error handling
// =============================================================================

console.log("=== 7. Error Handling ===\n");

try {
  Markdown.parse("no table here");
} catch (e) {
  if (e instanceof MarkdownParseError) {
    console.log("MarkdownParseError:", e.message);
    console.log("  line:", e.line);
  }
}

console.log();

// =============================================================================
// 8. File I/O (Node.js)
// =============================================================================

console.log("=== 8. File I/O ===\n");

const wb6 = Workbook.create();
readMarkdown(wb6, "| X | Y |\n| - | - |\n| 1 | 2 |", { sheetName: "Data" });
const outFile = path.join(outDir, "file-io-output.md");
await writeMarkdownFile(wb6, outFile, { sheetName: "Data" });
console.log("Wrote:", outFile);

const wb7 = Workbook.create();
await readMarkdownFile(wb7, outFile, { sheetName: "FromFile" });
const fromFileSheet = Workbook.getWorksheet(wb7, "FromFile")!;
if (fromFileSheet) {
  console.log("Read back:", Cell.getValue(fromFileSheet, 2, 1));
}

// readMarkdownAllFile
const multiFile = path.join(outDir, "multi-input.md");
fs.writeFileSync(multiFile, multiDoc, "utf8");
const wb8 = Workbook.create();
const allSheets = await readMarkdownAllFile(wb8, multiFile, { sheetName: "Sheet" });
console.log(
  `readMarkdownAllFile: ${allSheets.length} worksheets → ${allSheets.map(s => Worksheet.getName(s)).join(", ")}`
);

console.log("\nAll output files written to:", outDir);
