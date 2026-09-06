#!/usr/bin/env node
/**
 * Form Control Checkbox example
 *
 * Generates an XLSX file with legacy Form Control Checkboxes that work in:
 * - Microsoft Excel 2007+
 * - Microsoft 365 desktop
 * - (Excel for the web support is limited and may not allow interaction)
 * - WPS Office
 * - LibreOffice Calc
 *
 * Unlike in-cell checkboxes (which only work in Microsoft 365), Form Control
 * Checkboxes are backward compatible with older Excel versions.
 *
 * Usage:
 *   npx nodemon src/modules/excel/examples/form-checkbox.ts [outputPath]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Column, Form, Row, Workbook, Worksheet } from "@excel/index";

async function main(): Promise<void> {
  const outDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../tmp/excel-examples"
  );
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = process.argv[2] || path.join(outDir, "form-checkbox.xlsx");

  const wb = Workbook.create();
  wb.creator = "documonster";

  const ws = Workbook.addWorksheet(wb, "Form Controls");

  // Header
  Cell.setValue(ws, "A1", "Form Control Checkbox Demo");
  Cell.setStyle(ws, "A1", { font: { bold: true, size: 14 } });
  Worksheet.merge(ws, "A1:E1");

  // Instructions
  Cell.setValue(ws, "A3", "These are legacy Form Control Checkboxes.");
  Cell.setValue(ws, "A4", "They work in Excel 2007+, WPS Office, and LibreOffice.");

  // Labels
  Cell.setValue(ws, "A6", "Option");
  Cell.setValue(ws, "C6", "Checkbox");
  Cell.setValue(ws, "E6", "Linked Value");
  Row.setFont(ws, 6, { bold: true });

  // Data rows
  const options = [
    { name: "Enable feature A", checked: true, linkedCell: "E8" },
    { name: "Enable feature B", checked: false, linkedCell: "E10" },
    { name: "Accept terms", checked: true, linkedCell: "E12" },
    { name: "Subscribe newsletter", checked: false, linkedCell: "E14" }
  ];

  // Set row heights and add checkboxes
  options.forEach((opt, index) => {
    const rowNumber = 8 + index * 2;

    // Label
    Cell.setValue(ws, `A${rowNumber}`, opt.name);

    // Add form checkbox (placed in column B-C, spanning row height)
    // Range format: "startCell:endCell" - the checkbox will be positioned over this range
    Form.addCheckbox(ws, `B${rowNumber}:C${rowNumber + 1}`, {
      checked: opt.checked,
      link: opt.linkedCell,
      text: "" // Empty text since we have label in column A
    });

    // Linked cell will display TRUE/FALSE based on checkbox state
    // (value is updated when user clicks checkbox in Excel)
    Cell.setValue(ws, opt.linkedCell, opt.checked);

    // Set row height
    Row.setHeight(ws, rowNumber, 25);
    Row.setHeight(ws, rowNumber + 1, 10);
  });

  // Column widths
  Column.setWidth(ws, "A", 25);
  Column.setWidth(ws, "B", 4);
  Column.setWidth(ws, "C", 10);
  Column.setWidth(ws, "D", 5);
  Column.setWidth(ws, "E", 15);

  // Additional example: Checkbox with text label inside
  Cell.setValue(ws, "A18", "Checkbox with built-in label:");
  Form.addCheckbox(ws, "B18:D19", {
    checked: false,
    text: "I agree to the terms",
    link: "E18"
  });
  Row.setHeight(ws, 18, 25);

  // Note about linked cells
  Cell.setValue(ws, "A21", "Note: Click checkboxes in Excel to update linked cell values.");
  Cell.setStyle(ws, "A21", { font: { italic: true, color: { argb: "FF666666" } } });

  await writeBothFormats(wb, outputPath);

  console.log(`Wrote: ${outputPath}`);
  console.log("");
  console.log("Open the file in:");
  console.log("  - Microsoft Excel 2007 or later");
  console.log("  - WPS Office");
  console.log("  - LibreOffice Calc");
  console.log("");
  console.log("Click on checkboxes to toggle them and see linked cell values update.");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
