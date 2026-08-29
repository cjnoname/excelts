/**
 * Example: Rich text overflow and wrapping in PDF rendering
 *
 * Demonstrates correct handling of:
 *
 * 1. Rich text with 2-3 different sizes in a single (non-merged) cell
 *    overflowing into adjacent empty cells (same as plain text).
 *
 * 2. Gridlines/borders hidden under text overflow regions
 *    (white fill drawn after borders, before text).
 *
 * 3. Per-run font size measurement for word-wrap decisions
 *    (small-font runs wrap at their actual width, not max font width).
 *
 * 4. Layout row height consistent with render line count for rich text.
 *
 * Run: pnpm example --filter pdf-rich-text-overflow
 * Output: tmp/pdf-examples/rich-text-overflow.pdf
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Row, Workbook, Worksheet } from "@excel/index";

import { Pdf } from "../index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/pdf-examples"
);
fs.mkdirSync(outDir, { recursive: true });

const wb = Workbook.create();

// =============================================================================
// Sheet 1: Rich text overflow in single (non-merged) cells
//
// Rich text wider than the cell overflows into adjacent empty cells,
// just like plain text does.
// =============================================================================

const ws1 = Workbook.addWorksheet(wb, "RichText-Overflow");
Worksheet.setColumns(ws1, [
  { header: "Description", width: 18 },
  { header: "Narrow Single Cell", width: 12 },
  { header: "C (empty)", width: 12 },
  { header: "D (empty)", width: 12 },
  { header: "Wide Merged Cell", width: 12 }
]);

// Row 2: Rich text exceeds narrow cell width → overflows into C2, D2
Cell.setValue(ws1, "A2", "8pt + 16pt (no wrap)");
Cell.setValue(ws1, "B2", {
  richText: [
    { text: "Small(8)", font: { size: 8 } },
    { text: " BIG(16)", font: { size: 16 } }
  ]
});
// C2, D2 empty — rich text overflows into them
// Merged cell for comparison (wider, so text fits without overflow)
Worksheet.merge(ws1, "E2:G2");
Cell.setValue(ws1, "E2", {
  richText: [
    { text: "Small(8)", font: { size: 8 } },
    { text: " BIG(16)", font: { size: 16 } }
  ]
});

// Row 3: Three sizes, narrow cell
Cell.setValue(ws1, "A3", "7 + 8 + 14 (no wrap)");
Cell.setValue(ws1, "B3", {
  richText: [
    { text: "Tiny", font: { size: 7 } },
    { text: " Mid", font: { size: 8 } },
    { text: " BIG", font: { size: 14 } }
  ]
});
Worksheet.merge(ws1, "E3:G3");
Cell.setValue(ws1, "E3", {
  richText: [
    { text: "Tiny", font: { size: 7 } },
    { text: " Mid", font: { size: 8 } },
    { text: " BIG", font: { size: 14 } }
  ]
});

// Row 4: Plain text comparison — overflow works correctly
Cell.setValue(ws1, "A4", "Plain text overflow");
Cell.setValue(ws1, "B4", "This plain text overflows into C4 and D4 correctly");

// =============================================================================
// Sheet 2: Overflow region hides gridlines and borders
//
// When cell A has text that overflows into cells B, C, D (which are empty),
// gridlines and borders in the overflow area are hidden — matching Excel.
// =============================================================================

const ws2 = Workbook.addWorksheet(wb, "Overflow-Erase");
Worksheet.setColumns(ws2, [
  { header: "A", width: 12 },
  { header: "B", width: 8 },
  { header: "C", width: 8 },
  { header: "D", width: 8 },
  { header: "E", width: 8 },
  { header: "F", width: 8 }
]);

// Long text overflows → gridlines visible in overflow region
Cell.setValue(
  ws2,
  "A2",
  "This very long text overflows across several columns. In Excel the gridlines disappear under the text. In PDF they remain visible."
);

// Same but with explicit borders on some cells
Cell.setValue(ws2, "A4", "Bordered cell with overflow:");
Cell.setStyle(ws2, "A4", {
  border: {
    top: { style: "thin" },
    bottom: { style: "thin" },
    left: { style: "thin" },
    right: { style: "thin" }
  }
});
// B4 has border but is empty → border drawn even though text from A4 covers it visually in Excel
Cell.setStyle(ws2, "B4", {
  border: {
    top: { style: "thin" },
    bottom: { style: "thin" },
    left: { style: "thin" },
    right: { style: "thin" }
  }
});

// =============================================================================
// Sheet 3: Per-run font size measurement for wrapped rich text
//
// When wrapping rich text with different font sizes, each run's text is
// measured at its own font size for line-break decisions. This produces
// correct character density per line regardless of size differences.
// =============================================================================

const ws3 = Workbook.addWorksheet(wb, "PerRun-WrapSize");
Worksheet.setColumns(ws3, [
  { header: "Case", width: 25 },
  { header: "Wrapped Rich Text", width: 25 },
  { header: "Expected Layout", width: 40 }
]);

// 8pt vs 7pt — only 1pt difference but looks huge
Row.setHeight(ws3, 2, 30);
Cell.setValue(ws3, "A2", "8pt vs 7pt (wrap)");
Cell.setValue(ws3, "B2", {
  richText: [
    { text: "1TEXT-XD", font: { size: 8 } },
    { text: "(ex.2)(ex=1)", font: { size: 7 } }
  ]
});
Cell.setStyle(ws3, "B2", { alignment: { wrapText: true } });
Cell.setValue(ws3, "C2", "Both runs should be nearly same visual size (8:7 ratio)");
Cell.setStyle(ws3, "C2", { alignment: { wrapText: true } });

// Extreme case: 16pt header + 7pt body
Row.setHeight(ws3, 3, 60);
Cell.setValue(ws3, "A3", "16pt + 7pt body (wrap)");
Cell.setValue(ws3, "B3", {
  richText: [
    { text: "TITLE ", font: { size: 16 } },
    {
      text: "The body text is 7pt and should wrap normally at its own size, fitting many more characters per line than it currently does.",
      font: { size: 7 }
    }
  ]
});
Cell.setStyle(ws3, "B3", { alignment: { wrapText: true } });
Cell.setValue(
  ws3,
  "C3",
  "Body text wraps as if it were 16pt wide → only ~4 chars/line instead of ~8. Actual render at 7pt leaves huge gaps."
);
Cell.setStyle(ws3, "C3", { alignment: { wrapText: true } });

// Reference: same text at uniform 7pt (correct wrap behavior)
Row.setHeight(ws3, 4, 60);
Cell.setValue(ws3, "A4", "All 7pt (reference)");
Cell.setValue(
  ws3,
  "B4",
  "The body text is 7pt and should wrap normally at its own size, fitting many more characters per line than it currently does."
);
Cell.setStyle(ws3, "B4", { font: { size: 7 } });
Cell.setStyle(ws3, "B4", { alignment: { wrapText: true } });

// =============================================================================
// Sheet 4: Alignment with mixed-size rich text
//
// All runs share the same Y baseline (computed from the largest font's ascent).
// Vertical alignment (top/middle/bottom) positions the text block correctly
// within the cell, with line height based on the largest run's font size.
// =============================================================================

const ws4 = Workbook.addWorksheet(wb, "Alignment");
Worksheet.setColumns(ws4, [
  { header: "Vertical Align", width: 15 },
  { header: "Mixed Rich Text", width: 40 },
  { header: "Plain (reference)", width: 40 }
]);

// Middle alignment — Y position depends on totalTextHeight which uses maxFontSize lineHeight
Row.setHeight(ws4, 2, 40);
Cell.setValue(ws4, "A2", "Middle");
Cell.setValue(ws4, "B2", {
  richText: [
    { text: "BIG(16)", font: { size: 16 } },
    { text: " tiny(7)", font: { size: 7 } }
  ]
});
Cell.setStyle(ws4, "B2", { alignment: { horizontal: "left", vertical: "middle" } });
Cell.setValue(ws4, "C2", "Reference: 11pt middle");
Cell.setStyle(ws4, "C2", { alignment: { horizontal: "left", vertical: "middle" } });

// Bottom alignment
Row.setHeight(ws4, 3, 40);
Cell.setValue(ws4, "A3", "Bottom");
Cell.setValue(ws4, "B3", {
  richText: [
    { text: "BIG(16)", font: { size: 16 } },
    { text: " tiny(7)", font: { size: 7 } }
  ]
});
Cell.setStyle(ws4, "B3", { alignment: { horizontal: "left", vertical: "bottom" } });
Cell.setValue(ws4, "C3", "Reference: 11pt bottom");
Cell.setStyle(ws4, "C3", { alignment: { horizontal: "left", vertical: "bottom" } });

// Center horizontal with mixed sizes
Row.setHeight(ws4, 4, 30);
Cell.setValue(ws4, "A4", "H-Center");
Cell.setValue(ws4, "B4", {
  richText: [
    { text: "Big(14)", font: { size: 14 } },
    { text: " Small(8)", font: { size: 8 } }
  ]
});
Cell.setStyle(ws4, "B4", { alignment: { horizontal: "center", vertical: "middle" } });
Cell.setValue(ws4, "C4", "Reference: center");
Cell.setStyle(ws4, "C4", { alignment: { horizontal: "center", vertical: "middle" } });

// =============================================================================
// Export
// =============================================================================

const pdf = await Pdf.fromExcel(wb, {
  showGridLines: true,
  showSheetNames: true,
  showPageNumbers: true,
  title: "Rich Text Overflow Demo"
});

const filename = "rich-text-overflow.pdf";
fs.writeFileSync(path.join(outDir, filename), pdf);
console.log(`${filename} generated — ${pdf.length} bytes`);
console.log(`Output: ${path.join(outDir, filename)}`);

// Also export as xlsx for comparison in Excel
await Workbook.writeFile(wb, path.join(outDir, "rich-text-overflow.xlsx"));
console.log("rich-text-overflow.xlsx generated for comparison in Excel");
