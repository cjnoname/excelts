/**
 * Example: PDF Edge Cases
 *
 * Demonstrates advanced rendering scenarios not covered by the basic styled example.
 *
 * Covers:
 * - Type-based default alignment (numbers right, booleans center, formula result inference)
 * - Merged cell boundary borders (different colors per edge, double border)
 * - Text overflow into adjacent empty cells
 * - Zero-value number formats (#.##, ??0.00, accounting "-"??)
 * - fitToPage scaling with many columns
 * - Long word overflow vs wrap
 * - Custom vs auto row heights
 * - Error values and empty styled rows
 * - Explicit newlines in non-wrapped cells
 * - Rich text with mixed styles
 *
 * Run: pnpm example --filter pdf-edge-cases
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, Row, Stream, Workbook, Worksheet } from "@excel/index";
import type { CellErrorValue } from "@excel/types";

import { Pdf } from "../index";
import { pdf } from "../pdf";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const wb = Workbook.create();

// =============================================================================
// Sheet 1: Default Alignment by Type
// =============================================================================

const wsAlign = Workbook.addWorksheet(wb, "Default Alignment");
Worksheet.setColumns(wsAlign, [
  { header: "Type", width: 15 },
  { header: "Value", width: 20 },
  { header: "Expected", width: 15 }
]);
Cell.setValue(wsAlign, "A2", "Text");
Cell.setValue(wsAlign, "B2", "Hello World");
Cell.setValue(wsAlign, "C2", "LEFT");

Cell.setValue(wsAlign, "A3", "Number");
Cell.setValue(wsAlign, "B3", 1234.56);
Cell.setValue(wsAlign, "C3", "RIGHT");

Cell.setValue(wsAlign, "A4", "Date");
Cell.setValue(wsAlign, "B4", new Date(2025, 0, 15));
Cell.setStyle(wsAlign, "B4", { numFmt: "m/d/yyyy" });
Cell.setValue(wsAlign, "C4", "RIGHT");

Cell.setValue(wsAlign, "A5", "Boolean");
Cell.setValue(wsAlign, "B5", true);
Cell.setValue(wsAlign, "C5", "CENTER");

Cell.setValue(wsAlign, "A6", "Num formula");
Cell.setValue(wsAlign, "B6", { formula: "1+1", result: 2 });
Cell.setValue(wsAlign, "C6", "RIGHT");

Cell.setValue(wsAlign, "A7", "Str formula");
Cell.setValue(wsAlign, "B7", { formula: 'CONCAT("a","b")', result: "ab" });
Cell.setValue(wsAlign, "C7", "LEFT");

Cell.setValue(wsAlign, "A8", "Bool formula");
Cell.setValue(wsAlign, "B8", { formula: "TRUE()", result: true });
Cell.setValue(wsAlign, "C8", "CENTER");

// =============================================================================
// Sheet 2: Merge Borders + Double Border
// =============================================================================

const wsMerge = Workbook.addWorksheet(wb, "Merge Borders");
Worksheet.setColumns(wsMerge, [{ width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }]);

// 4-column merge with different colored border per edge
Worksheet.merge(wsMerge, "A1:D3");
Cell.setValue(wsMerge, "A1", "Merged A1:D3");
Cell.setStyle(wsMerge, "A1", { alignment: { horizontal: "center", vertical: "middle" } });
Cell.setStyle(wsMerge, "A1", {
  border: {
    top: { style: "thick", color: { argb: "FFFF0000" } },
    left: { style: "thick", color: { argb: "FF00CC00" } }
  }
});
Cell.setStyle(wsMerge, "D1", {
  border: { right: { style: "thick", color: { argb: "FF0000FF" } } }
});
Cell.setStyle(wsMerge, "D2", {
  border: { right: { style: "thick", color: { argb: "FF0000FF" } } }
});
Cell.setStyle(wsMerge, "D3", {
  border: {
    right: { style: "thick", color: { argb: "FF0000FF" } },
    bottom: { style: "double", color: { argb: "FFFF00FF" } }
  }
});
Cell.setStyle(wsMerge, "A3", {
  border: { bottom: { style: "double", color: { argb: "FFFF00FF" } } }
});
Cell.setStyle(wsMerge, "B3", {
  border: { bottom: { style: "double", color: { argb: "FFFF00FF" } } }
});
Cell.setStyle(wsMerge, "C3", {
  border: { bottom: { style: "double", color: { argb: "FFFF00FF" } } }
});

// Bordered empty cells
Cell.setValue(wsMerge, "A5", "Data");
Cell.setStyle(wsMerge, "B5", {
  border: {
    top: { style: "thick", color: { argb: "FFFF0000" } },
    right: { style: "thick", color: { argb: "FFFF0000" } },
    bottom: { style: "thick", color: { argb: "FFFF0000" } },
    left: { style: "thick", color: { argb: "FFFF0000" } }
  }
});
Cell.setStyle(wsMerge, "C5", {
  fill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFF00" }
  }
});
Cell.setStyle(wsMerge, "C5", {
  border: {
    top: { style: "thin" },
    right: { style: "thin" },
    bottom: { style: "thin" },
    left: { style: "thin" }
  }
});

// =============================================================================
// Sheet 3: Text Overflow + Long Word + Newlines
// =============================================================================

const wsOverflow = Workbook.addWorksheet(wb, "Overflow & Wrap");
Worksheet.setColumns(wsOverflow, [{ width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }]);

// Overflow into empty neighbors
Cell.setValue(wsOverflow, "A1", "This text overflows into B1 and C1");
Cell.setValue(wsOverflow, "D1", "Blocker");

// Long single word
Cell.setValue(wsOverflow, "A3", "Supercalifragilisticexpialidocious");
Cell.setValue(wsOverflow, "D3", "Stop");

// Same word but wrapped
Cell.setValue(wsOverflow, "A5", "Supercalifragilisticexpialidocious");
Cell.setStyle(wsOverflow, "A5", { alignment: { wrapText: true } });

// Explicit newlines without wrapText
Cell.setValue(wsOverflow, "C5", "Line1\nLine2\nLine3");

// Explicit newlines with wrapText
Cell.setValue(wsOverflow, "A7", "Wrap\nwith\nnewlines");
Cell.setStyle(wsOverflow, "A7", { alignment: { wrapText: true } });

// =============================================================================
// Sheet 4: Zero-Value Number Formats
// =============================================================================

const wsZero = Workbook.addWorksheet(wb, "Zero Formats");
Worksheet.setColumns(wsZero, [
  { header: "Format", width: 30 },
  { header: "Value=0", width: 20 }
]);

const zeroFormats: [string, string][] = [
  ['#,##0.00;-#,##0.00;"-"??', 'Dash + 2 spaces: "-  "'],
  ["??0.00", 'Space-padded: "  0.00"'],
  ["#.##", "Empty string"],
  ['0.00;-0.00;"-"', 'Just a dash: "-"'],
  ["#,##0", '"0"'],
  ["???.???", '"   .   " (spaces + dot + spaces)'],
  ["0.##", '"0" (no trailing decimals)'],
  ["#.0#", '".0"'],
  ["0.0?", '"0.0 " (trailing space)']
];
for (const [fmt, desc] of zeroFormats) {
  const row = Worksheet.addRow(wsZero, [`${fmt}  →  ${desc}`, 0]);
  Stream.setCellNumFmt(Stream.rowCell(row, 2), fmt);
}

// =============================================================================
// Sheet 5: Row Heights + fitToPage
// =============================================================================

const wsHeight = Workbook.addWorksheet(wb, "Row Heights");
Column.setWidth(wsHeight, 1, 30);

Cell.setValue(wsHeight, "A1", "Auto height (default)");
// `Row.setHeight` also marks the row `customHeight`, which is what tells the
// exporter to honour the number as-is. Assigning `row.height` on a handle sets
// the value but not the flag, and the exporter then treats it as Excel's own
// auto-calculated height — a floor to grow from, not a height to keep. That is
// why the cramped row below only actually looks cramped through this call.
Row.setHeight(wsHeight, 2, 40);
Cell.setValue(wsHeight, "A2", "Custom height = 40pt");
Cell.setValue(wsHeight, "A3", "Tall font (auto expand)");
Cell.setStyle(wsHeight, "A3", { font: { size: 24 } });
Row.setHeight(wsHeight, 4, 10);
Cell.setValue(wsHeight, "A4", "Cramped: height=10pt");

// =============================================================================
// Sheet 6: Error Value + Empty Styled Row + Hyperlink
// =============================================================================

const wsMixed = Workbook.addWorksheet(wb, "Mixed Types");
Column.setWidth(wsMixed, 1, 30);

Cell.setValue(wsMixed, "A1", { text: "Click me (hyperlink)", hyperlink: "https://example.com" });
Cell.setStyle(wsMixed, "A1", { font: { color: { argb: "FF0563C1" }, underline: true } });

Cell.setValue(wsMixed, "A2", { error: "#DIV/0!" } as CellErrorValue);

// Empty row with styling
Row.setFont(wsMixed, 3, { bold: true, size: 14 });
Row.setFill(wsMixed, 3, { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFCCCC" } });

Cell.setValue(wsMixed, "A4", "Normal cell after styled empty row");

// =============================================================================
// Export: multi-sheet workbook
// =============================================================================

const mainPdf = await Pdf.fromExcel(wb, {
  showGridLines: true,
  showSheetNames: true,
  title: "PDF Edge Cases",
  author: "documonster"
});
fs.writeFileSync(path.join(outDir, "pdf-edge-cases.pdf"), mainPdf);
console.log("pdf-edge-cases.pdf — 6 sheets covering advanced rendering edge cases");

// =============================================================================
// Separate file: fitToPage with 20 columns
// =============================================================================

const wbFit = Workbook.create();
const wsFit = Workbook.addWorksheet(wbFit, "20 Columns");
for (let c = 1; c <= 20; c++) {
  Column.setWidth(wsFit, c, 12);
  Cell.setValue(wsFit, 1, c, `Col ${c}`);
  Cell.setStyle(wsFit, 1, c, { font: { bold: true } });
  Cell.setValue(wsFit, 2, c, c * 100);
}
const fitPdf = await Pdf.fromExcel(wbFit, {
  showGridLines: true,
  fitToPage: true,
  title: "Fit To Page: 20 Columns"
});
fs.writeFileSync(path.join(outDir, "pdf-fit-to-page.pdf"), fitPdf);
console.log("pdf-fit-to-page.pdf — 20 columns shrunk to fit one page");

// =============================================================================
// Separate file: standalone pdf() with type-based alignment
// =============================================================================

const standalonePdf = await pdf(
  {
    sheets: [
      {
        name: "Standalone Alignment",
        data: [
          ["Text", "Number", "Boolean"],
          ["hello", 123.45, true],
          ["world", -67.89, false],
          ["test", 0, true]
        ]
      }
    ]
  },
  { showGridLines: true, title: "Standalone PDF: Type Alignment" }
);
fs.writeFileSync(path.join(outDir, "pdf-standalone-align.pdf"), standalonePdf);
console.log("pdf-standalone-align.pdf — standalone pdf() with type-based alignment");

console.log(`\nAll files written to: ${outDir}`);
