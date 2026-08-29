/**
 * Example: Advanced PDF Export
 *
 * Covers:
 * - Multi-page pagination (many rows)
 * - Repeat header rows (printTitlesRow)
 * - Manual row page breaks
 * - Print area
 * - Page setup from worksheet (paperSize, orientation, margins)
 * - Column pagination (wide sheets with horizontal splitting)
 * - Hidden rows and columns (skipped in PDF)
 * - Password-protected / encrypted PDF
 * - Custom TrueType font embedding (Unicode/CJK support)
 * - Transparency / alpha colors
 * - Multiple worksheets with different page setups
 * - Bookmarks / outlines (auto-generated per sheet)
 * - Custom grid line color
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. Pagination with repeat header rows
// =============================================================================

const wb1 = Workbook.create();
const ws1 = Workbook.addWorksheet(wb1, "Inventory");
Worksheet.setColumns(ws1, [
  { header: "ID", key: "id", width: 8 },
  { header: "Product Name", key: "name", width: 25 },
  { header: "Category", key: "category", width: 15 },
  { header: "Stock", key: "stock", width: 10 },
  { header: "Price", key: "price", width: 12 }
]);

// Style the header row
Row.setFont(ws1, 1, { bold: true, color: { argb: "FFFFFFFF" } });
Row.setFill(ws1, 1, {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF2F5496" }
});
Row.setAlignment(ws1, 1, { horizontal: "center" });

// Add 100 rows to force pagination
const categories = ["Electronics", "Clothing", "Food", "Tools", "Books"];
for (let i = 1; i <= 100; i++) {
  Worksheet.addRow(ws1, {
    id: i,
    name: `Product ${i}`,
    category: categories[i % categories.length],
    stock: Math.floor(Math.random() * 500),
    price: Math.round(Math.random() * 10000) / 100
  });
}

// Format the price column
Column.setNumFmt(ws1, "price", "$#,##0.00");

// Repeat row 1 on every page
ws1.pageSetup.printTitlesRow = "1:1";

const pdf1 = await Pdf.fromExcel(wb1, {
  showGridLines: true,
  showPageNumbers: true,
  showSheetNames: true,
  repeatRows: 1,
  title: "Inventory Report"
});
fs.writeFileSync(path.join(outDir, "advanced-pagination.pdf"), pdf1);
console.log("1. advanced-pagination.pdf — 100 rows, repeat headers, page numbers");

// =============================================================================
// 2. Manual row page breaks + print area
// =============================================================================

const wb2 = Workbook.create();
const ws2 = Workbook.addWorksheet(wb2, "Sections");
for (let r = 1; r <= 30; r++) {
  Cell.setValue(ws2, `A${r}`, `Section ${Math.ceil(r / 10)}`);
  Cell.setValue(ws2, `B${r}`, `Row ${r} data`);
  Cell.setValue(ws2, `C${r}`, r * 100);
}
Column.setWidth(ws2, 1, 15);
Column.setWidth(ws2, 2, 20);
Column.setWidth(ws2, 3, 10);

// Break after row 10 and row 20
Row.addPageBreak(ws2, 10);
Row.addPageBreak(ws2, 20);

// Print area: only columns A-C, rows 1-30
ws2.pageSetup.printArea = "A1:C30";

const pdf2 = await Pdf.fromExcel(wb2, {
  showGridLines: true,
  showPageNumbers: true
});
fs.writeFileSync(path.join(outDir, "advanced-pagebreaks.pdf"), pdf2);
console.log("2. advanced-pagebreaks.pdf — manual page breaks + print area");

// =============================================================================
// 3. Wide sheet with column pagination
// =============================================================================

const wb3 = Workbook.create();
const ws3 = Workbook.addWorksheet(wb3, "Wide Data");
// 20 columns × 30 rows — will need horizontal page splits
for (let c = 1; c <= 20; c++) {
  Column.setWidth(ws3, c, 12);
  Cell.setValue(ws3, 1, c, `Col ${c}`);
  Cell.setStyle(ws3, 1, c, { font: { bold: true } });
}
for (let r = 2; r <= 30; r++) {
  for (let c = 1; c <= 20; c++) {
    Cell.setValue(ws3, r, c, (r - 1) * c);
  }
}

const pdf3 = await Pdf.fromExcel(wb3, {
  fitToPage: false, // Don't shrink — let it paginate horizontally
  showGridLines: true,
  showPageNumbers: true,
  showSheetNames: true
});
fs.writeFileSync(path.join(outDir, "advanced-wide.pdf"), pdf3);
console.log("3. advanced-wide.pdf — 20 columns, horizontal pagination");

// =============================================================================
// 4. Hidden rows and columns
// =============================================================================

const wb4 = Workbook.create();
const ws4 = Workbook.addWorksheet(wb4, "Hidden");
for (let r = 1; r <= 10; r++) {
  Cell.setValue(ws4, `A${r}`, `Visible A${r}`);
  Cell.setValue(ws4, `B${r}`, `Hidden B${r}`);
  Cell.setValue(ws4, `C${r}`, `Visible C${r}`);
}
Column.setHidden(ws4, 2, true);
Row.setHidden(ws4, 3, true);
Row.setHidden(ws4, 7, true);

const pdf4 = await Pdf.fromExcel(wb4, { showGridLines: true });
fs.writeFileSync(path.join(outDir, "advanced-hidden.pdf"), pdf4);
console.log("4. advanced-hidden.pdf — hidden column B, hidden rows 3 and 7");

// =============================================================================
// 5. Encrypted PDF with permissions
// =============================================================================

const wb5 = Workbook.create();
const ws5 = Workbook.addWorksheet(wb5, "Confidential");
Cell.setValue(ws5, "A1", "This document is password-protected.");
Cell.setStyle(ws5, "A1", { font: { bold: true, size: 14, color: { argb: "FFCC0000" } } });
Cell.setValue(ws5, "A3", "Owner password: owner123");
Cell.setValue(ws5, "A4", "User password: (none — opens without password)");
Cell.setValue(ws5, "A6", "Permissions: print=yes, copy=no, modify=no");
Column.setWidth(ws5, 1, 50);

const pdf5 = await Pdf.fromExcel(wb5, {
  encryption: {
    ownerPassword: "owner123",
    // No userPassword — document opens without a password
    permissions: {
      print: true,
      copy: false,
      modify: false,
      annotate: false
    }
  },
  title: "Confidential Document",
  author: "Security Team"
});
fs.writeFileSync(path.join(outDir, "advanced-encrypted.pdf"), pdf5);
console.log("5. advanced-encrypted.pdf — encrypted, print-only, no copy");

// =============================================================================
// 6. Encrypted PDF with open password
// =============================================================================

const wb6 = Workbook.create();
const ws6 = Workbook.addWorksheet(wb6, "Locked");
Cell.setValue(ws6, "A1", "You need a password to open this PDF.");
Cell.setValue(ws6, "A2", 'User password: "hello"');
Column.setWidth(ws6, 1, 40);

const pdf6 = await Pdf.fromExcel(wb6, {
  encryption: {
    ownerPassword: "admin",
    userPassword: "hello"
  }
});
fs.writeFileSync(path.join(outDir, "advanced-password.pdf"), pdf6);
console.log('6. advanced-password.pdf — requires password "hello" to open');

// =============================================================================
// 7. Multiple sheets with different page setups + bookmarks
// =============================================================================

const wb7 = Workbook.create();

const wsPortrait = Workbook.addWorksheet(wb7, "Portrait A4");
Cell.setValue(wsPortrait, "A1", "Portrait A4 sheet");
Cell.setStyle(wsPortrait, "A1", { font: { bold: true, size: 16 } });
wsPortrait.pageSetup.paperSize = 9; // A4
wsPortrait.pageSetup.orientation = "portrait";

const wsLandscape = Workbook.addWorksheet(wb7, "Landscape A4");
Cell.setValue(wsLandscape, "A1", "Landscape A4 sheet");
Cell.setStyle(wsLandscape, "A1", { font: { bold: true, size: 16 } });
wsLandscape.pageSetup.paperSize = 9;
wsLandscape.pageSetup.orientation = "landscape";

const wsLetter = Workbook.addWorksheet(wb7, "Letter");
Cell.setValue(wsLetter, "A1", "US Letter sheet");
Cell.setStyle(wsLetter, "A1", { font: { bold: true, size: 16 } });
wsLetter.pageSetup.paperSize = 1; // Letter

const wsSmall = Workbook.addWorksheet(wb7, "A5");
Cell.setValue(wsSmall, "A1", "A5 sheet");
Cell.setStyle(wsSmall, "A1", { font: { bold: true, size: 16 } });
wsSmall.pageSetup.paperSize = 11; // A5

// Export — each sheet gets its own page setup; bookmarks are auto-generated
const pdf7 = await Pdf.fromExcel(wb7, {
  showSheetNames: true,
  showPageNumbers: true
});
fs.writeFileSync(path.join(outDir, "advanced-multi-setup.pdf"), pdf7);
console.log("7. advanced-multi-setup.pdf — per-sheet page sizes + bookmarks");

// =============================================================================
// 8. Transparency / alpha fills
// =============================================================================

const wb8 = Workbook.create();
const ws8 = Workbook.addWorksheet(wb8, "Transparency");
Column.setWidth(ws8, 1, 25);
Column.setWidth(ws8, 2, 25);

Cell.setValue(ws8, "A1", "Opaque red fill");
Cell.setStyle(ws8, "A1", {
  fill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFF0000" }
  }
});

Cell.setValue(ws8, "A2", "Semi-transparent blue");
Cell.setStyle(ws8, "A2", {
  fill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "800000FF" } // alpha=0x80 (~50%)
  }
});

Cell.setValue(ws8, "A3", "Light transparent green");
Cell.setStyle(ws8, "A3", {
  fill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "4000CC00" } // alpha=0x40 (~25%)
  }
});

Cell.setValue(ws8, "A4", "Semi-transparent text");
Cell.setStyle(ws8, "A4", { font: { color: { argb: "80FF0000" }, size: 14, bold: true } });

const pdf8 = await Pdf.fromExcel(wb8, { showGridLines: true });
fs.writeFileSync(path.join(outDir, "advanced-transparency.pdf"), pdf8);
console.log("8. advanced-transparency.pdf — alpha fills and text");

// =============================================================================
// 9. Custom grid line color
// =============================================================================

const wb9 = Workbook.create();
const ws9 = Workbook.addWorksheet(wb9, "GridColors");
for (let r = 1; r <= 5; r++) {
  for (let c = 1; c <= 5; c++) {
    Cell.setValue(ws9, r, c, `${r},${c}`);
  }
}

const pdf9 = await Pdf.fromExcel(wb9, {
  showGridLines: true,
  gridLineColor: "FF3366CC" // blue grid lines
});
fs.writeFileSync(path.join(outDir, "advanced-grid-color.pdf"), pdf9);
console.log("9. advanced-grid-color.pdf — blue grid lines");

// =============================================================================
// 10. Worksheet margins from pageSetup
// =============================================================================

const wb10 = Workbook.create();
const ws10 = Workbook.addWorksheet(wb10, "WS Margins");
Cell.setValue(ws10, "A1", "This sheet uses worksheet-level margins (0.5in all sides)");
Column.setWidth(ws10, 1, 50);
ws10.pageSetup.margins = {
  left: 0.5,
  right: 0.5,
  top: 0.5,
  bottom: 0.5,
  header: 0.3,
  footer: 0.3
};

const pdf10 = await Pdf.fromExcel(wb10, { showPageNumbers: true });
fs.writeFileSync(path.join(outDir, "advanced-ws-margins.pdf"), pdf10);
console.log("10. advanced-ws-margins.pdf — worksheet pageSetup margins");

console.log("\nAll advanced examples generated.");
