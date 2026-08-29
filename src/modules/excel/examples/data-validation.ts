/**
 * Example: Excel — DataValidation namespace (standalone registry API)
 *
 * Demonstrates the `DataValidation` namespace's standalone handle API:
 * - DataValidation.create()        — make / reuse a validation registry
 * - DataValidation.add(dv, a, r)   — register a rule at an address
 * - DataValidation.find(dv, a)     — resolve the rule applying to an address
 * - DataValidation.remove(dv, a)   — clear a rule
 *
 * Each worksheet exposes its own registry via `ws.dataValidations`, so rules
 * added through the namespace are persisted into the written workbook.
 * Multiple validation types are shown: list, whole, decimal, date, textLength.
 *
 * Usage:   pnpm example --filter data-validation
 * Output:  tmp/excel-examples/data-validation.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, DataValidation, Workbook } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "data-validation.xlsx");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Validations");

// Label column for context.
Cell.setValue(ws, "A1", "Field");
Cell.setValue(ws, "B1", "Enter value ->");

Cell.setValue(ws, "A2", "Department (list)");
Cell.setValue(ws, "A3", "Quantity (whole 1..100)");
Cell.setValue(ws, "A4", "Price (decimal >= 0)");
Cell.setValue(ws, "A5", "Start date (>= 2024-01-01)");
Cell.setValue(ws, "A6", "Code (textLength = 5)");

// The worksheet's own data-validation registry. Rules added here are written
// into the .xlsx.
const dv = ws.dataValidations;
console.log("Registry is a fresh handle:", Object.keys(dv.model).length === 0);

// 1. List validation — dropdown of allowed values.
DataValidation.add(dv, "B2", {
  type: "list",
  allowBlank: true,
  formulae: ['"Engineering,Design,Sales,Support"'],
  showErrorMessage: true,
  errorTitle: "Invalid department",
  error: "Pick a value from the dropdown."
});

// 2. Whole number between 1 and 100.
DataValidation.add(dv, "B3", {
  type: "whole",
  operator: "between",
  formulae: [1, 100],
  allowBlank: false,
  showErrorMessage: true,
  errorTitle: "Out of range",
  error: "Quantity must be a whole number from 1 to 100."
});

// 3. Decimal greater-than-or-equal to 0.
DataValidation.add(dv, "B4", {
  type: "decimal",
  operator: "greaterThanOrEqual",
  formulae: [0],
  allowBlank: false,
  showInputMessage: true,
  promptTitle: "Price",
  prompt: "Enter a non-negative price."
});

// 4. Date on or after 2024-01-01. Use a UTC midnight so the serialised Excel
// date is a whole number (no time-of-day fraction) regardless of the host
// timezone.
DataValidation.add(dv, "B5", {
  type: "date",
  operator: "greaterThanOrEqual",
  formulae: [new Date(Date.UTC(2024, 0, 1))],
  allowBlank: true,
  showErrorMessage: true,
  errorTitle: "Too early",
  error: "Start date must be in 2024 or later."
});

// 5. Text length exactly 5.
DataValidation.add(dv, "B6", {
  type: "textLength",
  operator: "equal",
  formulae: [5],
  allowBlank: false,
  showErrorMessage: true,
  errorTitle: "Bad code",
  error: "Code must be exactly 5 characters."
});

console.log("Rules registered:", Object.keys(dv.model).length);

// find() resolves a rule at a given address.
const found = DataValidation.find(dv, "B3");
const foundOperator = found && found.type !== "any" ? found.operator : undefined;
console.log("find(B3).type:", found?.type, "operator:", foundOperator);

const missing = DataValidation.find(dv, "Z99");
console.log("find(Z99):", missing);

// remove() clears a rule; find() then returns undefined.
DataValidation.remove(dv, "B6");
console.log("After remove(B6), find(B6):", DataValidation.find(dv, "B6"));
console.log("Remaining rules:", Object.keys(dv.model).filter(k => dv.model[k]).length);

// create() can build a standalone registry (e.g. seeded from a parsed model)
// that is independent of any worksheet.
const standalone = DataValidation.create();
DataValidation.add(standalone, "A1", { type: "any", allowBlank: true });
console.log("Standalone registry rule at A1:", DataValidation.find(standalone, "A1")?.type);

try {
  await Workbook.writeFile(wb, filename);
  console.log("Wrote:", filename);
} catch (error) {
  console.error((error as Error).stack);
}
