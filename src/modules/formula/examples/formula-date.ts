import { calculateFormulas } from "@excel/bridge/formula";
import { cellFormula, cellResult } from "@excel/core/cell";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Date & Time Formulas
 *
 * Covers:
 * - Current date/time (TODAY, NOW)
 * - Construct / extract (DATE, TIME, YEAR, MONTH, DAY, HOUR, MINUTE, SECOND)
 * - Weekday / week number (WEEKDAY, WEEKNUM, ISOWEEKNUM)
 * - Duration (DATEDIF, DAYS, DAYS360, EDATE, EOMONTH)
 * - Business days (NETWORKDAYS, WORKDAY, NETWORKDAYS.INTL)
 * - Formatting via TEXT
 *
 * Note: Excel stores dates as serial numbers (days since 1900-01-01). The
 * engine works with those serials; set `cell.numFmt` when reading back if
 * you need a formatted display.
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Dates");

// Fixed reference points so the example is deterministic
Cell.setValue(ws, "A1", { formula: "DATE(2026, 4, 18)" });
Cell.setValue(ws, "A2", { formula: "DATE(2026, 12, 25)" });
Cell.setValue(ws, "A3", { formula: "TIME(14, 30, 0)" });

// Extract components
Cell.setValue(ws, "B1", { formula: "YEAR(A1)" }); // 2026
Cell.setValue(ws, "B2", { formula: "MONTH(A1)" }); // 4
Cell.setValue(ws, "B3", { formula: "DAY(A1)" }); // 18
Cell.setValue(ws, "B4", { formula: "HOUR(A3)" }); // 14

// Weekday / week-of-year
Cell.setValue(ws, "C1", { formula: "WEEKDAY(A1, 2)" }); // 1..7, Mon=1
Cell.setValue(ws, "C2", { formula: "WEEKNUM(A1)" });
Cell.setValue(ws, "C3", { formula: "ISOWEEKNUM(A1)" });

// Duration
Cell.setValue(ws, "D1", { formula: 'DATEDIF(A1, A2, "D")' }); // 251 days
Cell.setValue(ws, "D2", { formula: "DAYS(A2, A1)" }); // 251
Cell.setValue(ws, "D3", { formula: "EOMONTH(A1, 0)" }); // last day of April 2026
Cell.setValue(ws, "D4", { formula: "EDATE(A1, 6)" }); // 6 months later

// Business days
Cell.setValue(ws, "E1", { formula: "NETWORKDAYS(A1, A2)" });
Cell.setValue(ws, "E2", { formula: "WORKDAY(A1, 10)" }); // 10 business days out

// Formatting (YYYY-MM-DD)
Cell.setValue(ws, "F1", { formula: 'TEXT(A1, "yyyy-mm-dd")' });

calculateFormulas(wb);

for (const addr of [
  "B1",
  "B2",
  "B3",
  "B4",
  "C1",
  "C2",
  "C3",
  "D1",
  "D2",
  "D3",
  "D4",
  "E1",
  "E2",
  "F1"
]) {
  const c = getCell(ws, addr);
  console.log(`${addr}  ${String(cellFormula(c)).padEnd(32)}  = ${JSON.stringify(cellResult(c))}`);
}
