import { calculateFormulas } from "@excel/bridge/formula";
import { cellFormula, cellGetValue, cellResult } from "@excel/core/cell";
import { findCell, getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Dynamic Array Formulas (Excel 365)
 *
 * Covers:
 * - Spill semantics — one formula, many output cells
 * - FILTER / SORT / SORTBY / UNIQUE
 * - SEQUENCE / RANDARRAY
 * - TAKE / DROP / CHOOSECOLS / CHOOSEROWS
 * - VSTACK / HSTACK
 * - TEXTSPLIT / TEXTJOIN (paired)
 * - Higher-order (MAP, REDUCE, SCAN, LAMBDA)
 *
 * Dynamic arrays write their full rectangle into the sheet. Inspect the
 * `ghost` cells around the source formula to see the spilled values.
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Dynamic");

// Source data (A1:C6)
// Region   Product  Sales
Cell.setValue(ws, "A1", "Region");
Cell.setValue(ws, "B1", "Product");
Cell.setValue(ws, "C1", "Sales");
const rows: [string, string, number][] = [
  ["East", "Widget", 120],
  ["West", "Gadget", 95],
  ["East", "Gadget", 140],
  ["South", "Widget", 60],
  ["West", "Widget", 110]
];
rows.forEach((row, i) => {
  Cell.setValue(ws, i + 2, 1, row[0]);
  Cell.setValue(ws, i + 2, 2, row[1]);
  Cell.setValue(ws, i + 2, 3, row[2]);
});

// FILTER — rows where Sales ≥ 100
Cell.setValue(ws, "E1", { formula: "FILTER(A2:C6, C2:C6>=100)" });

// SORT — by Sales descending
Cell.setValue(ws, "E10", { formula: "SORT(A2:C6, 3, -1)" });

// UNIQUE — distinct regions
Cell.setValue(ws, "J1", { formula: "UNIQUE(A2:A6)" });

// SEQUENCE — 1..10
Cell.setValue(ws, "L1", { formula: "SEQUENCE(10)" });

// TAKE — first 2 rows, last 2 cols
Cell.setValue(ws, "N1", { formula: "TAKE(A2:C6, 2, -2)" });

// VSTACK — combine uniques from two sources
Cell.setValue(ws, "P1", { formula: "VSTACK(UNIQUE(A2:A6), UNIQUE(B2:B6))" });

// TEXTSPLIT — break a CSV row into cells (row-wise)
Cell.setValue(ws, "R1", "Alice,Bob,Carol,Dave");
Cell.setValue(ws, "R2", { formula: 'TEXTSPLIT(R1, ",")' });

// LAMBDA / REDUCE — sum of squares of 1..10
Cell.setValue(ws, "T1", {
  formula: "REDUCE(0, SEQUENCE(10), LAMBDA(acc,x, acc + x*x))"
}); // 385

// MAP — double each value in a range
Cell.setValue(ws, "T3", {
  formula: "MAP(SEQUENCE(5), LAMBDA(x, x*2))"
});

// SCAN — running total 1..5
Cell.setValue(ws, "T5", {
  formula: "SCAN(0, SEQUENCE(5), LAMBDA(acc,x, acc + x))"
});

calculateFormulas(wb);

// Dynamic array sources print their scalar top-left; the full spill
// lives in surrounding cells.
for (const addr of ["E1", "E10", "J1", "L1", "T1"]) {
  const c = getCell(ws, addr);
  console.log(
    `${addr}  ${String(cellFormula(c)).padEnd(52)}  top-left = ${JSON.stringify(cellResult(c))}`
  );
}

// Demonstrate the spill — FILTER writes its full rectangle into E1:G{n}.
// Source cell's `result` holds the top-left scalar; ghost cells hold the
// spilled values in their `value` (not `result`).
console.log("\nFILTER spill E1:G?");
for (let rn = 1; rn <= 6; rn++) {
  const row: unknown[] = [];
  for (let cn = 5; cn <= 7; cn++) {
    const cell = findCell(ws, rn, cn);
    if (!cell) {
      row.push(null);
      continue;
    }
    // For the source cell, the spilled value is carried in `result`;
    // ghost cells carry it in `value`.
    row.push(rn === 1 && cn === 5 ? cellResult(cell) : cellGetValue(cell));
  }
  if (row.some(v => v !== null)) {
    console.log(`  row ${rn}: ${JSON.stringify(row)}`);
  }
}
