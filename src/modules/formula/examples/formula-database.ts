import { calculateFormulas } from "@excel/bridge/formula";
import { cellFormula, cellResult } from "@excel/core/cell";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Database Formulas
 *
 * Covers:
 * - DSUM, DAVERAGE, DCOUNT, DCOUNTA, DMAX, DMIN
 * - DPRODUCT, DSTDEV, DVAR
 * - Criteria ranges (header + condition rows)
 * - Multi-column criteria (AND across columns, OR across rows)
 *
 * All D-functions share the same shape:
 *     DFUNC(database, field, criteria)
 *
 * - database: range including headers
 * - field: column header (string) or 1-based column index
 * - criteria: range including headers and one or more condition rows
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "DB");

// Database: A1:D7  (header row + 6 data rows)
// Region  Product  Sales  Units
Cell.setValue(ws, "A1", "Region");
Cell.setValue(ws, "B1", "Product");
Cell.setValue(ws, "C1", "Sales");
Cell.setValue(ws, "D1", "Units");
const data: [string, string, number, number][] = [
  ["East", "Widget", 120, 10],
  ["West", "Gadget", 95, 8],
  ["East", "Gadget", 140, 12],
  ["South", "Widget", 60, 5],
  ["West", "Widget", 110, 9],
  ["East", "Gadget", 75, 6]
];
data.forEach((row, i) => {
  Cell.setValue(ws, i + 2, 1, row[0]);
  Cell.setValue(ws, i + 2, 2, row[1]);
  Cell.setValue(ws, i + 2, 3, row[2]);
  Cell.setValue(ws, i + 2, 4, row[3]);
});

// Criteria — East + Gadget
Cell.setValue(ws, "F1", "Region");
Cell.setValue(ws, "G1", "Product");
Cell.setValue(ws, "F2", "East");
Cell.setValue(ws, "G2", "Gadget");

// DSUM — total sales of East-region Gadgets
Cell.setValue(ws, "I1", { formula: 'DSUM(A1:D7, "Sales", F1:G2)' }); // 215
// DCOUNT — matching rows
Cell.setValue(ws, "I2", { formula: 'DCOUNT(A1:D7, "Sales", F1:G2)' }); // 2
// DAVERAGE
Cell.setValue(ws, "I3", { formula: 'DAVERAGE(A1:D7, "Sales", F1:G2)' }); // 107.5
// DMAX / DMIN
Cell.setValue(ws, "I4", { formula: 'DMAX(A1:D7, "Sales", F1:G2)' }); // 140
Cell.setValue(ws, "I5", { formula: 'DMIN(A1:D7, "Sales", F1:G2)' }); // 75

// OR-style criteria — East OR West
Cell.setValue(ws, "F5", "Region");
Cell.setValue(ws, "F6", "East");
Cell.setValue(ws, "F7", "West");
Cell.setValue(ws, "I7", { formula: 'DSUM(A1:D7, "Sales", F5:F7)' });
Cell.setValue(ws, "I8", { formula: 'DCOUNTA(A1:D7, "Product", F5:F7)' });

calculateFormulas(wb);

for (const addr of ["I1", "I2", "I3", "I4", "I5", "I7", "I8"]) {
  const c = getCell(ws, addr);
  console.log(`${addr}  ${String(cellFormula(c)).padEnd(40)}  = ${JSON.stringify(cellResult(c))}`);
}
