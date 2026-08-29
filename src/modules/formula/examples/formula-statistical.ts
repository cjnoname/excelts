import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Statistical Formulas
 *
 * Covers:
 * - Basic descriptive (AVERAGE, MEDIAN, MODE, STDEV, VAR)
 * - Extremes (MIN, MAX, LARGE, SMALL)
 * - Conditional aggregates (COUNTIF, COUNTIFS, SUMIF, SUMIFS, AVERAGEIF)
 * - Rank & percentile (RANK, PERCENTILE, QUARTILE, PERCENTRANK)
 * - Correlation & regression (CORREL, COVAR, SLOPE, INTERCEPT, LINEST)
 * - Distributions (NORM.DIST, NORM.INV, T.TEST, CHISQ.TEST)
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Stats");

// Sample dataset
const nums = [12, 15, 14, 10, 18, 22, 19, 24, 13, 21];
for (let i = 0; i < nums.length; i++) {
  Cell.setValue(ws, i + 1, 1, nums[i]); // A1:A10
}
// Second dataset for correlation
const ys = [30, 33, 31, 29, 40, 42, 39, 45, 32, 44];
for (let i = 0; i < ys.length; i++) {
  Cell.setValue(ws, i + 1, 2, ys[i]); // B1:B10
}

// Descriptive
Cell.setValue(ws, "D1", { formula: "AVERAGE(A1:A10)" });
Cell.setValue(ws, "D2", { formula: "MEDIAN(A1:A10)" });
Cell.setValue(ws, "D3", { formula: "MODE(A1:A10)" });
Cell.setValue(ws, "D4", { formula: "STDEV.S(A1:A10)" });
Cell.setValue(ws, "D5", { formula: "VAR.S(A1:A10)" });

// Extremes
Cell.setValue(ws, "E1", { formula: "MIN(A1:A10)" });
Cell.setValue(ws, "E2", { formula: "MAX(A1:A10)" });
Cell.setValue(ws, "E3", { formula: "LARGE(A1:A10, 2)" }); // 2nd largest
Cell.setValue(ws, "E4", { formula: "SMALL(A1:A10, 3)" }); // 3rd smallest

// Conditional — count / sum values ≥ 18
Cell.setValue(ws, "F1", { formula: 'COUNTIF(A1:A10, ">=18")' });
Cell.setValue(ws, "F2", { formula: 'SUMIF(A1:A10, ">=18")' });
Cell.setValue(ws, "F3", { formula: 'AVERAGEIF(A1:A10, ">=18")' });
// COUNTIFS with two criteria
Cell.setValue(ws, "F4", { formula: 'COUNTIFS(A1:A10, ">=14", B1:B10, ">=35")' });

// Rank & percentile
Cell.setValue(ws, "G1", { formula: "RANK(21, A1:A10)" }); // descending rank
Cell.setValue(ws, "G2", { formula: "PERCENTILE.INC(A1:A10, 0.9)" });
Cell.setValue(ws, "G3", { formula: "QUARTILE.INC(A1:A10, 3)" }); // Q3
Cell.setValue(ws, "G4", { formula: "PERCENTRANK.INC(A1:A10, 18)" });

// Correlation & simple regression
Cell.setValue(ws, "H1", { formula: "CORREL(A1:A10, B1:B10)" });
Cell.setValue(ws, "H2", { formula: "SLOPE(B1:B10, A1:A10)" });
Cell.setValue(ws, "H3", { formula: "INTERCEPT(B1:B10, A1:A10)" });
Cell.setValue(ws, "H4", { formula: "FORECAST(16, B1:B10, A1:A10)" });

// Distributions
Cell.setValue(ws, "I1", { formula: "NORM.DIST(1, 0, 1, TRUE)" }); // ≈ 0.8413
Cell.setValue(ws, "I2", { formula: "NORM.INV(0.975, 0, 1)" }); // ≈ 1.96

calculateFormulas(wb);

for (const row of [1, 2, 3, 4, 5]) {
  for (const col of ["D", "E", "F", "G", "H", "I"]) {
    const addr = `${col}${row}`;
    const formula = Cell.getFormula(ws, addr);
    if (formula) {
      console.log(`${addr}  ${formula.padEnd(40)}  = ${JSON.stringify(Cell.getResult(ws, addr))}`);
    }
  }
}
