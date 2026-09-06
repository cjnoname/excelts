import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Column, Row, Workbook, Worksheet } from "@excel/index";
/**
 * Auto-Fit Example: Demonstrates autoFitColumns() and autoFitRows()
 *
 * Generates 3 xlsx files showcasing different auto-fit scenarios:
 * 1. auto-fit-basic.xlsx      — Mixed content types with autoFitColumns
 * 2. auto-fit-fonts.xlsx      — Different fonts and sizes
 * 3. auto-fit-advanced.xlsx   — Wrap text, multi-line, rich text, merged cells, indent
 */

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });

// =============================================================================
// 1. Basic auto-fit: mixed content types
// =============================================================================
async function generateBasic() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Auto-Fit Basic");

  // Header row (bold)
  const headers = ["ID", "Name", "Description", "Amount", "Date", "Active"];
  const headerRow = Worksheet.addRow(ws, headers);
  Row.setFont(ws, headerRow.number, { bold: true });

  // Data rows
  Worksheet.addRow(ws, [1, "Alice", "Software Engineer", 95000.5, new Date(2024, 0, 15), true]);
  Worksheet.addRow(ws, [
    2,
    "Bob",
    "Senior Product Manager with a very long title",
    120000,
    new Date(2024, 5, 1),
    false
  ]);
  Worksheet.addRow(ws, [3, "Charlie", "QA", 78000.99, new Date(2023, 11, 20), true]);
  Worksheet.addRow(ws, [
    4,
    "Diana",
    "VP of Engineering and Operations",
    185000,
    new Date(2024, 2, 10),
    true
  ]);
  Worksheet.addRow(ws, [5, "Eve", "Intern", 45000, new Date(2024, 8, 1), false]);

  // Apply number format to Amount column
  Column.setStyle(ws, "D", { numFmt: "#,##0.00" });
  // Apply date format
  Column.setStyle(ws, "E", { numFmt: "yyyy-mm-dd" });

  // Auto-fit all columns then all rows
  Worksheet.autoFitRows(Worksheet.autoFitColumns(ws));

  const filePath = `${outDir}/auto-fit-basic.xlsx`;
  await writeBothFormats(wb, filePath);
  console.log(`Written: ${filePath}`);
}

// =============================================================================
// 2. Different fonts and sizes
// =============================================================================
async function generateFonts() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Auto-Fit Fonts");

  Cell.setValue(ws, "A1", "Calibri 11 (default)");

  Cell.setValue(ws, "A2", "Calibri 16 Bold");
  Cell.setStyle(ws, "A2", { font: { name: "Calibri", size: 16, bold: true } });

  Cell.setValue(ws, "A3", "Arial 14");
  Cell.setStyle(ws, "A3", { font: { name: "Arial", size: 14 } });

  Cell.setValue(ws, "A4", "Arial 11 Bold");
  Cell.setStyle(ws, "A4", { font: { name: "Arial", size: 11, bold: true } });

  Cell.setValue(ws, "A5", "Times New Roman 12");
  Cell.setStyle(ws, "A5", { font: { name: "Times New Roman", size: 12 } });

  Cell.setValue(ws, "A6", "Courier New 11 (monospace)");
  Cell.setStyle(ws, "A6", { font: { name: "Courier New", size: 11 } });

  Cell.setValue(ws, "A7", "Verdana 10");
  Cell.setStyle(ws, "A7", { font: { name: "Verdana", size: 10 } });

  Cell.setValue(ws, "A8", "Tahoma 13 Italic");
  Cell.setStyle(ws, "A8", { font: { name: "Tahoma", size: 13, italic: true } });

  Cell.setValue(ws, "A9", "Georgia 14");
  Cell.setStyle(ws, "A9", { font: { name: "Georgia", size: 14 } });

  Cell.setValue(ws, "A10", "Trebuchet MS 11");
  Cell.setStyle(ws, "A10", { font: { name: "Trebuchet MS", size: 11 } });

  // Second column: numbers
  Cell.setValue(ws, "B1", "Numbers");
  Cell.setStyle(ws, "B1", { font: { bold: true } });
  for (let i = 2; i <= 10; i++) {
    Cell.setValue(ws, `B${i}`, 1234567.89);
    Cell.setStyle(ws, `B${i}`, { numFmt: "#,##0.00" });
    Cell.setStyle(ws, `B${i}`, { font: Cell.getFont(ws, `A${i}`) });
  }

  Worksheet.autoFitRows(Worksheet.autoFitColumns(ws));

  const filePath = `${outDir}/auto-fit-fonts.xlsx`;
  await writeBothFormats(wb, filePath);
  console.log(`Written: ${filePath}`);
}

// =============================================================================
// 3. Advanced: wrap text, multi-line, rich text, merged, indent, hidden
// =============================================================================
async function generateAdvanced() {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Auto-Fit Advanced");

  // Column A: Labels
  Cell.setValue(ws, "A1", "Feature");
  Cell.setStyle(ws, "A1", { font: { bold: true } });
  Cell.setValue(ws, "B1", "Content");
  Cell.setStyle(ws, "B1", { font: { bold: true } });
  Cell.setValue(ws, "C1", "Notes");
  Cell.setStyle(ws, "C1", { font: { bold: true } });

  // Row 2: Multi-line explicit newlines
  Cell.setValue(ws, "A2", "Multi-line (\\n)");
  Cell.setValue(ws, "B2", "Line 1\nLine 2\nLine 3");
  Cell.setValue(ws, "C2", "Height should accommodate 3 lines");

  // Row 3: Wrap text
  Cell.setValue(ws, "A3", "Wrap Text");
  Cell.setValue(
    ws,
    "B3",
    "This is a long sentence that should wrap within the column width when wrapText is enabled."
  );
  Cell.setStyle(ws, "B3", { alignment: { wrapText: true } });
  Cell.setValue(ws, "C3", "Column B is 30 chars wide");

  // Row 4: Rich text
  Cell.setValue(ws, "A4", "Rich Text");
  Cell.setValue(ws, "B4", {
    richText: [
      { text: "Bold ", font: { bold: true, size: 14 } },
      { text: "Normal ", font: { size: 11 } },
      { text: "Red Italic", font: { italic: true, color: { argb: "FFFF0000" } } }
    ]
  });
  Cell.setValue(ws, "C4", "Mixed fonts in one cell");

  // Row 5: Indent
  Cell.setValue(ws, "A5", "Indent");
  Cell.setValue(ws, "B5", "Indented text (level 3)");
  Cell.setStyle(ws, "B5", { alignment: { indent: 3 } });
  Cell.setValue(ws, "C5", "Extra width for indent");

  // Row 6: Merged cells (should be skipped for width)
  Cell.setValue(ws, "A6", "Merged");
  Cell.setValue(ws, "B6", "This cell is merged across B6:C6");
  Worksheet.merge(ws, "B6:C6");

  // Row 7: ShrinkToFit (should be skipped for width)
  Cell.setValue(ws, "A7", "ShrinkToFit");
  Cell.setValue(ws, "B7", "This long text has shrinkToFit — should NOT affect column width");
  Cell.setStyle(ws, "B7", { alignment: { shrinkToFit: true } });
  Cell.setValue(ws, "C7", "Skipped by auto-fit");

  // Row 8: Hidden row (should be skipped for width)
  Cell.setValue(ws, "A8", "Hidden Row");
  Cell.setValue(
    ws,
    "B8",
    "VERY LONG TEXT THAT IS HIDDEN AND SHOULD NOT AFFECT COLUMN WIDTH AT ALL"
  );
  Cell.setValue(ws, "C8", "This row is hidden");
  Row.setHidden(ws, 8, true);

  // Row 9: Large font
  Cell.setValue(ws, "A9", "Large Font");
  Cell.setValue(ws, "B9", "Big Text");
  Cell.setStyle(ws, "B9", { font: { size: 24, bold: true } });
  Cell.setValue(ws, "C9", "24pt bold");

  // Row 10: Numbers with format
  Cell.setValue(ws, "A10", "Formatted Number");
  Cell.setValue(ws, "B10", 9876543.21);
  Cell.setStyle(ws, "B10", { numFmt: "$#,##0.00" });
  Cell.setValue(ws, "C10", "Currency format");

  // Set column B to a reasonable width for wrap text demo
  Column.setWidth(ws, "B", 30);

  // Auto-fit columns A and C (skip B since we set it manually for wrap demo)
  Worksheet.autoFitColumn(ws, "A");
  Worksheet.autoFitColumn(ws, "C");

  // Auto-fit all rows (this will use column B's width for wrap calculation)
  Worksheet.autoFitRows(ws);

  const filePath = `${outDir}/auto-fit-advanced.xlsx`;
  await writeBothFormats(wb, filePath);
  console.log(`Written: ${filePath}`);
}

// =============================================================================
// Run all
// =============================================================================
await generateBasic();
await generateFonts();
await generateAdvanced();
console.log("Done!");
