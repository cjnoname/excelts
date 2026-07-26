import { calculateFormulas } from "@excel/bridge/formula";
import { cellFormula, cellResult } from "@excel/core/cell";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Financial Formulas
 *
 * Covers:
 * - Loan / mortgage (PMT, IPMT, PPMT, NPER, RATE)
 * - Time value of money (PV, FV)
 * - Investment evaluation (NPV, IRR, XNPV, XIRR, MIRR)
 * - Depreciation (SLN, DB, DDB, SYD)
 * - Bonds (PRICE, YIELD, DURATION, ACCRINT)
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Finance");

// Loan assumptions
Cell.setValue(ws, "A1", 300000); // principal
Cell.setValue(ws, "A2", 0.065 / 12); // monthly rate (6.5% annual)
Cell.setValue(ws, "A3", 30 * 12); // periods (30 years)

// Monthly payment — negative of PMT because of cashflow convention
Cell.setValue(ws, "B1", { formula: "-PMT(A2, A3, A1)" });
Cell.setValue(ws, "B2", { formula: "IPMT(A2, 1, A3, A1)" }); // interest, period 1
Cell.setValue(ws, "B3", { formula: "PPMT(A2, 1, A3, A1)" }); // principal, period 1

// How long until a $500k goal at 8% earning $2k/month?
Cell.setValue(ws, "B4", { formula: "NPER(0.08/12, -2000, 0, 500000)" });
// What rate makes a $10k loan turn into $15k over 5 yr?
Cell.setValue(ws, "B5", { formula: "RATE(5, 0, -10000, 15000)" });

// Investment — cashflows in C1:C5
Cell.setValue(ws, "C1", -1000);
Cell.setValue(ws, "C2", 300);
Cell.setValue(ws, "C3", 400);
Cell.setValue(ws, "C4", 500);
Cell.setValue(ws, "C5", 200);

// NPV applies to future cashflows; add the initial outlay separately
Cell.setValue(ws, "D1", { formula: "NPV(0.1, C2:C5) + C1" });
Cell.setValue(ws, "D2", { formula: "IRR(C1:C5)" });

// Time value — PV of $1000 received in 10 years at 5%
Cell.setValue(ws, "D3", { formula: "PV(0.05, 10, 0, -1000)" });
Cell.setValue(ws, "D4", { formula: "FV(0.05, 10, -100)" }); // $100/yr deposits

// Depreciation — $10k asset over 5 years, $1k salvage
Cell.setValue(ws, "E1", { formula: "SLN(10000, 1000, 5)" }); // straight line
Cell.setValue(ws, "E2", { formula: "DDB(10000, 1000, 5, 1)" }); // double declining
Cell.setValue(ws, "E3", { formula: "SYD(10000, 1000, 5, 1)" }); // sum-of-years

calculateFormulas(wb);

for (const addr of ["B1", "B2", "B3", "B4", "B5", "D1", "D2", "D3", "D4", "E1", "E2", "E3"]) {
  const c = getCell(ws, addr);
  console.log(`${addr}  ${String(cellFormula(c)).padEnd(36)}  = ${JSON.stringify(cellResult(c))}`);
}
