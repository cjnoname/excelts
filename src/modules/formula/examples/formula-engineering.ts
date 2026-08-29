import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Engineering Formulas
 *
 * Covers:
 * - Number base conversions (DEC2BIN, DEC2HEX, DEC2OCT, BIN2DEC, HEX2DEC, OCT2DEC)
 * - Bitwise operations (BITAND, BITOR, BITXOR, BITLSHIFT, BITRSHIFT)
 * - Complex numbers (COMPLEX, IMSUM, IMABS, IMARGUMENT)
 * - Special functions (ERF, BESSELJ)
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Eng");

// Base conversions
Cell.setValue(ws, "A1", { formula: "DEC2BIN(42)" }); // "101010"
Cell.setValue(ws, "A2", { formula: "DEC2HEX(255)" }); // "FF"
Cell.setValue(ws, "A3", { formula: "DEC2OCT(64)" }); // "100"
Cell.setValue(ws, "A4", { formula: 'BIN2DEC("101010")' }); // 42
Cell.setValue(ws, "A5", { formula: 'HEX2DEC("FF")' }); // 255
Cell.setValue(ws, "A6", { formula: 'OCT2DEC("777")' }); // 511

// Bitwise
Cell.setValue(ws, "B1", { formula: "BITAND(12, 10)" }); // 8
Cell.setValue(ws, "B2", { formula: "BITOR(12, 10)" }); // 14
Cell.setValue(ws, "B3", { formula: "BITXOR(12, 10)" }); // 6
Cell.setValue(ws, "B4", { formula: "BITLSHIFT(1, 4)" }); // 16
Cell.setValue(ws, "B5", { formula: "BITRSHIFT(64, 2)" }); // 16

// Complex numbers (strings with "i" suffix)
Cell.setValue(ws, "C1", { formula: "COMPLEX(3, 4)" }); // "3+4i"
Cell.setValue(ws, "C2", { formula: 'IMSUM("3+4i", "1+2i")' }); // "4+6i"
Cell.setValue(ws, "C3", { formula: 'IMABS("3+4i")' }); // 5
Cell.setValue(ws, "C4", { formula: 'IMARGUMENT("1+1i")' }); // π/4 ≈ 0.7854

// Special functions
Cell.setValue(ws, "D1", { formula: "ERF(1)" }); // 0.8427
Cell.setValue(ws, "D2", { formula: "BESSELJ(0.5, 0)" });

calculateFormulas(wb);

for (const addr of [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "C1",
  "C2",
  "C3",
  "C4",
  "D1",
  "D2"
]) {
  console.log(
    `${addr}  ${String(Cell.getFormula(ws, addr)).padEnd(32)}  = ${JSON.stringify(Cell.getResult(ws, addr))}`
  );
}
