import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Lookup & Reference Formulas
 *
 * Covers:
 * - VLOOKUP / HLOOKUP (legacy)
 * - INDEX / MATCH (flexible classic)
 * - XLOOKUP / XMATCH (modern)
 * - LOOKUP (vector form)
 * - OFFSET (dynamic range anchoring)
 * - INDIRECT (string-built references)
 * - ROW / COLUMN / ADDRESS (positional metadata)
 * - ROWS / COLUMNS (dimension of a range)
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Lookup");

// Price table
// A      B       C
// SKU    Name    Price
// A001   Widget  9.99
// A002   Gadget  14.50
// A003   Gizmo   3.25
Cell.setValue(ws, "A1", "SKU");
Cell.setValue(ws, "B1", "Name");
Cell.setValue(ws, "C1", "Price");
Cell.setValue(ws, "A2", "A001");
Cell.setValue(ws, "B2", "Widget");
Cell.setValue(ws, "C2", 9.99);
Cell.setValue(ws, "A3", "A002");
Cell.setValue(ws, "B3", "Gadget");
Cell.setValue(ws, "C3", 14.5);
Cell.setValue(ws, "A4", "A003");
Cell.setValue(ws, "B4", "Gizmo");
Cell.setValue(ws, "C4", 3.25);

// Query
Cell.setValue(ws, "E1", "A002");

// Classic VLOOKUP — get price by SKU
Cell.setValue(ws, "F1", { formula: "VLOOKUP(E1, A2:C4, 3, FALSE)" }); // 14.5

// INDEX + MATCH — the same, but right-to-left safe
Cell.setValue(ws, "F2", { formula: "INDEX(B2:B4, MATCH(E1, A2:A4, 0))" }); // "Gadget"

// XLOOKUP — modern, supports not-found default
Cell.setValue(ws, "F3", { formula: 'XLOOKUP(E1, A2:A4, C2:C4, "n/a")' }); // 14.5
Cell.setValue(ws, "F4", { formula: 'XLOOKUP("ZZZ", A2:A4, C2:C4, "n/a")' }); // "n/a"

// XMATCH
Cell.setValue(ws, "F5", { formula: "XMATCH(E1, A2:A4)" }); // 2

// OFFSET — dynamic anchor (2nd row, 2nd col, 1x1)
Cell.setValue(ws, "F6", { formula: "OFFSET(A1, 2, 1)" }); // "Gadget"

// INDIRECT — build a reference from a string
Cell.setValue(ws, "F7", { formula: 'SUM(C2:INDIRECT("C" & ROWS(A1:A4)))' }); // 27.74

// Metadata
Cell.setValue(ws, "G1", { formula: "ROW(E1)" }); // 1
Cell.setValue(ws, "G2", { formula: "COLUMN(E1)" }); // 5
Cell.setValue(ws, "G3", { formula: "ADDRESS(G1, G2)" }); // "$E$1"
Cell.setValue(ws, "G4", { formula: "ROWS(A2:C4)" }); // 3
Cell.setValue(ws, "G5", { formula: "COLUMNS(A2:C4)" }); // 3

calculateFormulas(wb);

for (const addr of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "G1", "G2", "G3", "G4", "G5"]) {
  console.log(
    `${addr}  ${String(Cell.getFormula(ws, addr)).padEnd(48)}  = ${JSON.stringify(Cell.getResult(ws, addr))}`
  );
}
