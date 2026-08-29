import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Math & Trigonometry Formulas
 *
 * Covers:
 * - Basic arithmetic formulas (SUM, PRODUCT, ABS)
 * - Rounding (ROUND, ROUNDUP, ROUNDDOWN, INT, CEILING, FLOOR)
 * - Trigonometry (SIN, COS, TAN, ATAN2, RADIANS, DEGREES, PI)
 * - Power & logarithms (POWER, SQRT, EXP, LN, LOG, LOG10)
 * - Matrix math (MMULT, MDETERM, MINVERSE, TRANSPOSE)
 * - Modular arithmetic (MOD, QUOTIENT)
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Math");

// Inputs
Cell.setValue(ws, "A1", 10);
Cell.setValue(ws, "A2", 20);
Cell.setValue(ws, "A3", 30);
Cell.setValue(ws, "B1", -5.678);

// Aggregates and basic arithmetic
Cell.setValue(ws, "C1", { formula: "SUM(A1:A3)" }); // 60
Cell.setValue(ws, "C2", { formula: "PRODUCT(A1:A3)" }); // 6000
Cell.setValue(ws, "C3", { formula: "ABS(B1)" }); // 5.678

// Rounding family
Cell.setValue(ws, "D1", { formula: "ROUND(B1, 2)" }); // -5.68
Cell.setValue(ws, "D2", { formula: "ROUNDUP(B1, 0)" }); // -6
Cell.setValue(ws, "D3", { formula: "INT(B1)" }); // -6
Cell.setValue(ws, "D4", { formula: "CEILING(4.3, 1)" }); // 5

// Trigonometry — 30° in radians, then back
Cell.setValue(ws, "E1", { formula: "RADIANS(30)" });
Cell.setValue(ws, "E2", { formula: "SIN(E1)" }); // 0.5
Cell.setValue(ws, "E3", { formula: "DEGREES(ATAN2(1, 1))" }); // 45

// Power & log
Cell.setValue(ws, "F1", { formula: "POWER(2, 10)" }); // 1024
Cell.setValue(ws, "F2", { formula: "SQRT(144)" }); // 12
Cell.setValue(ws, "F3", { formula: "LOG(1000, 10)" }); // 3

// Modular
Cell.setValue(ws, "G1", { formula: "MOD(17, 5)" }); // 2
Cell.setValue(ws, "G2", { formula: "QUOTIENT(17, 5)" }); // 3

// Matrix — populate a 2x2 and compute determinant / inverse via MMULT
Cell.setValue(ws, "H1", 1);
Cell.setValue(ws, "I1", 2);
Cell.setValue(ws, "H2", 3);
Cell.setValue(ws, "I2", 4);
Cell.setValue(ws, "J1", { formula: "MDETERM(H1:I2)" }); // -2

calculateFormulas(wb);

// Report — single pass, tabulated so you can eyeball the results.
const cells = [
  "C1",
  "C2",
  "C3",
  "D1",
  "D2",
  "D3",
  "D4",
  "E1",
  "E2",
  "E3",
  "F1",
  "F2",
  "F3",
  "G1",
  "G2",
  "J1"
];
for (const addr of cells) {
  console.log(
    `${addr}  ${String(Cell.getFormula(ws, addr)).padEnd(28)}  = ${Cell.getResult(ws, addr)}`
  );
}
