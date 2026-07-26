import { calculateFormulas } from "@excel/bridge/formula";
import { cellFormula, cellResult } from "@excel/core/cell";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Logical & Conditional Formulas
 *
 * Covers:
 * - IF / nested IF / IFS
 * - AND / OR / NOT / XOR
 * - IFERROR / IFNA / ISERROR
 * - SWITCH
 * - CHOOSE
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Logic");

Cell.setValue(ws, "A1", 85);
Cell.setValue(ws, "A2", "OK");
Cell.setValue(ws, "A3", 0);
Cell.setValue(ws, "A4", 42);

// Basic IF
Cell.setValue(ws, "B1", { formula: 'IF(A1>=60, "pass", "fail")' });

// Nested IF → grade letter
Cell.setValue(ws, "B2", {
  formula: 'IF(A1>=90,"A",IF(A1>=80,"B",IF(A1>=70,"C",IF(A1>=60,"D","F"))))'
});

// Same idea with IFS — cleaner
Cell.setValue(ws, "B3", {
  formula: 'IFS(A1>=90,"A",A1>=80,"B",A1>=70,"C",A1>=60,"D",TRUE,"F")'
});

// AND / OR / NOT
Cell.setValue(ws, "C1", { formula: "AND(A1>=60, A1<=100)" }); // TRUE
Cell.setValue(ws, "C2", { formula: 'OR(A2="OK", A2="YES")' }); // TRUE
Cell.setValue(ws, "C3", { formula: "NOT(A3)" }); // TRUE  (A3 is 0 → FALSE)

// IFERROR / IFNA guard against #DIV/0!, #N/A, etc.
Cell.setValue(ws, "D1", { formula: 'IFERROR(A4/A3, "n/a")' }); // "n/a"
Cell.setValue(ws, "D2", { formula: 'IFNA(VLOOKUP("x", A1:A4, 1, FALSE), "not found")' });

// SWITCH — dispatch on equality
Cell.setValue(ws, "E1", {
  formula: 'SWITCH(A2, "OK", 1, "WARN", 2, "ERR", 3, 0)'
}); // 1

// CHOOSE — index-based dispatch (1-based)
Cell.setValue(ws, "E2", { formula: 'CHOOSE(2, "low", "mid", "high")' }); // "mid"

calculateFormulas(wb);

for (const addr of ["B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2", "E1", "E2"]) {
  const c = getCell(ws, addr);
  console.log(`${addr}  ${String(cellFormula(c)).padEnd(60)}  = ${JSON.stringify(cellResult(c))}`);
}
