/**
 * Example: Excel-to-PDF Conversion
 *
 * Reads existing .xlsx files and converts them to PDF.
 * Demonstrates the real-world workflow: load workbook → export PDF.
 *
 * Covers:
 * - Reading .xlsx files from disk
 * - Converting workbooks with styles, merged cells, formulas, hyperlinks
 * - Batch conversion of multiple files
 * - Conversion with various PDF options
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Column, Workbook, Worksheet } from "@excel/index";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });
// Every input this example reads lives in the *examples* fixture directory. Two
// of them (`gold-standard`, `merged-cell-borders`) are also test fixtures, and
// this file used to read those straight out of `excel/__tests__/data`. That made
// the example uncopyable — `__tests__/` is excluded from every build and is not
// in the published package — and coupled its output to a test asset that is free
// to change for reasons that have nothing to do with PDF export.
const excelDataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../excel/examples/data"
);

async function convertFile(
  xlsxPath: string,
  pdfName: string,
  options?: Parameters<typeof Pdf.fromExcel>[1]
): Promise<void> {
  const wb = Workbook.create();
  await Workbook.readFile(wb, xlsxPath);
  const pdf = await Pdf.fromExcel(wb, options);
  fs.writeFileSync(path.join(outDir, pdfName), pdf);
  const sheets = Workbook.getWorksheets(wb).length;
  console.log(`  ${pdfName} — ${sheets} sheet(s), ${pdf.length} bytes`);
}

// =============================================================================
// 1. Simple xlsx → PDF (test.xlsx)
// =============================================================================

console.log("1. Simple workbook:");
await convertFile(path.join(excelDataDir, "test.xlsx"), "excel-to-pdf-simple.pdf", {
  showGridLines: true,
  showSheetNames: true,
  showPageNumbers: true,
  title: "Converted from test.xlsx"
});

// =============================================================================
// 2. Workbook with colors and styles (test-colour-cell.xlsx)
// =============================================================================

console.log("2. Colored cells:");
await convertFile(path.join(excelDataDir, "test-colour-cell.xlsx"), "excel-to-pdf-colors.pdf", {
  showGridLines: true,
  title: "Color Cells"
});

// =============================================================================
// 3. Workbook with merged cells and alignment (test-merge-align.xlsx)
// =============================================================================

console.log("3. Merged cells + alignment:");
await convertFile(path.join(excelDataDir, "test-merge-align.xlsx"), "excel-to-pdf-merged.pdf", {
  showGridLines: true,
  showSheetNames: true,
  title: "Merged Cells"
});

// =============================================================================
// 4. Workbook with hyperlinks (test-hyperlink.xlsx)
// =============================================================================

console.log("4. Hyperlinks:");
await convertFile(path.join(excelDataDir, "test-hyperlink.xlsx"), "excel-to-pdf-links.pdf", {
  showGridLines: true,
  title: "Hyperlinks"
});

// =============================================================================
// 5. Workbook with formulas (test-formula.xlsx)
// =============================================================================

console.log("5. Formulas:");
await convertFile(path.join(excelDataDir, "test-formula.xlsx"), "excel-to-pdf-formulas.pdf", {
  showGridLines: true,
  title: "Formulas"
});

// =============================================================================
// 6. Tiny workbook (test-tiny.xlsx)
// =============================================================================

console.log("6. Tiny workbook:");
await convertFile(path.join(excelDataDir, "test-tiny.xlsx"), "excel-to-pdf-tiny.pdf", {
  showGridLines: true
});

// =============================================================================
// 7. Newlines in cells (test-newline.xlsx)
// =============================================================================

console.log("7. Newline cells:");
await convertFile(path.join(excelDataDir, "test-newline.xlsx"), "excel-to-pdf-newline.pdf", {
  showGridLines: true,
  title: "Newline Handling"
});

// =============================================================================
// 8. Gold standard workbook — complex real-world file
// =============================================================================

console.log("8. Gold standard (complex workbook):");
await convertFile(path.join(excelDataDir, "gold-standard.xlsx"), "excel-to-pdf-gold.pdf", {
  showGridLines: true,
  showSheetNames: true,
  showPageNumbers: true,
  title: "Gold Standard Workbook"
});

// =============================================================================
// 9. Merged cell borders (merged-cell-borders.xlsx)
// =============================================================================

console.log("9. Merged cell borders:");
await convertFile(
  path.join(excelDataDir, "merged-cell-borders.xlsx"),
  "excel-to-pdf-merge-borders.pdf",
  {
    showGridLines: true,
    title: "Merged Cell Borders"
  }
);

// =============================================================================
// 10. Same file, different export options
// =============================================================================

console.log("10. Same file, multiple export variants:");

const wb10 = Workbook.create();
await Workbook.readFile(wb10, path.join(excelDataDir, "test.xlsx"));

// Variant A: Landscape, no grid
const pdfA = await Pdf.fromExcel(wb10, { orientation: "landscape" });
fs.writeFileSync(path.join(outDir, "excel-to-pdf-landscape.pdf"), pdfA);
console.log("  excel-to-pdf-landscape.pdf — landscape, no grid");

// Variant B: A5, fit to page — build a small workbook suited for A5
const wb10b = Workbook.create();
const wsA5 = Workbook.addWorksheet(wb10b, "A5 Demo");
Worksheet.setColumns(wsA5, [
  { header: "Item", key: "item", width: 15 },
  { header: "Qty", key: "qty", width: 8 },
  { header: "Price", key: "price", width: 10 }
]);
Worksheet.addRows(wsA5, [
  { item: "Apples", qty: 12, price: 3.5 },
  { item: "Bananas", qty: 6, price: 1.2 },
  { item: "Oranges", qty: 8, price: 2.8 }
]);
Column.setNumFmt(wsA5, "price", "$#,##0.00");
const pdfB = await Pdf.fromExcel(wb10b, { pageSize: "A5", fitToPage: true, showGridLines: true });
fs.writeFileSync(path.join(outDir, "excel-to-pdf-a5.pdf"), pdfB);
console.log("  excel-to-pdf-a5.pdf — A5, fit to page");

// Variant C: Encrypted
const pdfC = await Pdf.fromExcel(wb10, {
  showGridLines: true,
  encryption: { ownerPassword: "secret" }
});
fs.writeFileSync(path.join(outDir, "excel-to-pdf-encrypted.pdf"), pdfC);
console.log("  excel-to-pdf-encrypted.pdf — encrypted");

// Variant D: Select first sheet only
const pdfD = await Pdf.fromExcel(wb10, {
  sheets: [1],
  showGridLines: true,
  showPageNumbers: true
});
fs.writeFileSync(path.join(outDir, "excel-to-pdf-sheet1.pdf"), pdfD);
console.log("  excel-to-pdf-sheet1.pdf — first sheet only");

console.log("\nAll excel-to-pdf examples generated.");
