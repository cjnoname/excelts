import { calculateFormulas } from "@excel/bridge/formula";
import { cellFormula, cellResult } from "@excel/core/cell";
import { getCell } from "@excel/core/worksheet";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Information Functions
 *
 * Covers the `IS*` predicate family plus the value-introspection helpers
 * the engine actually registers (see
 * `formula/runtime/function-registry.ts`):
 *
 * - Type predicates: ISNUMBER / ISTEXT / ISNONTEXT / ISLOGICAL / ISBLANK
 * - Error predicates: ISERROR / ISERR / ISNA
 * - Parity:           ISEVEN / ISODD
 * - Reference probes: ISREF / ISFORMULA / FORMULATEXT (evaluator-aware)
 * - Coercion:         N / T
 * - Classification:   TYPE / ERROR.TYPE
 * - Constructors:     NA
 * - Cell metadata:    CELL (address / row / col / contents / type)
 *
 * Usage: npx tsx src/modules/formula/examples/formula-information.ts
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Info");

// Source values of several different kinds.
Cell.setValue(ws, "A1", 42); // number
Cell.setValue(ws, "A2", "hello"); // text
Cell.setValue(ws, "A3", true); // boolean
Cell.setValue(ws, "A4", { formula: "1/0" }); // #DIV/0! error
Cell.setValue(ws, "A5", { formula: "NA()" }); // #N/A error
// A6 left blank on purpose
Cell.setValue(ws, "A7", 7); // odd number
Cell.setValue(ws, "A8", { formula: "A1+A7" }); // a formula cell → 49

// ── Type predicates ──
Cell.setValue(ws, "B1", { formula: "ISNUMBER(A1)" }); // TRUE
Cell.setValue(ws, "B2", { formula: "ISTEXT(A2)" }); // TRUE
Cell.setValue(ws, "B3", { formula: "ISNONTEXT(A1)" }); // TRUE
Cell.setValue(ws, "B4", { formula: "ISLOGICAL(A3)" }); // TRUE
Cell.setValue(ws, "B5", { formula: "ISBLANK(A6)" }); // TRUE

// ── Error predicates ──
Cell.setValue(ws, "C1", { formula: "ISERROR(A4)" }); // TRUE (any error)
Cell.setValue(ws, "C2", { formula: "ISERR(A4)" }); // TRUE (error, not #N/A)
Cell.setValue(ws, "C3", { formula: "ISERR(A5)" }); // FALSE (#N/A excluded)
Cell.setValue(ws, "C4", { formula: "ISNA(A5)" }); // TRUE

// ── Parity ──
Cell.setValue(ws, "D1", { formula: "ISEVEN(A1)" }); // TRUE  (42)
Cell.setValue(ws, "D2", { formula: "ISODD(A7)" }); // TRUE  (7)

// ── Reference probes (evaluator-aware) ──
Cell.setValue(ws, "E1", { formula: "ISREF(A1)" }); // TRUE (a real reference)
Cell.setValue(ws, "E2", { formula: "ISFORMULA(A8)" }); // TRUE (A8 holds a formula)
Cell.setValue(ws, "E3", { formula: "ISFORMULA(A1)" }); // FALSE (A1 is a literal)
Cell.setValue(ws, "E4", { formula: "FORMULATEXT(A8)" }); // "=A1+A7"

// ── Coercion ──
Cell.setValue(ws, "F1", { formula: "N(A1)" }); // 42
Cell.setValue(ws, "F2", { formula: "N(A3)" }); // 1   (TRUE → 1)
Cell.setValue(ws, "F3", { formula: "N(A2)" }); // 0   (text → 0)
Cell.setValue(ws, "F4", { formula: "T(A2)" }); // "hello"
Cell.setValue(ws, "F5", { formula: "T(A1)" }); // ""  (number → empty text)

// ── Classification ──
Cell.setValue(ws, "G1", { formula: "TYPE(A1)" }); // 1  (number)
Cell.setValue(ws, "G2", { formula: "TYPE(A2)" }); // 2  (text)
Cell.setValue(ws, "G3", { formula: "TYPE(A3)" }); // 4  (boolean)
Cell.setValue(ws, "G4", { formula: "TYPE(A4)" }); // 16 (error)
Cell.setValue(ws, "G5", { formula: "ERROR.TYPE(A4)" }); // 2  (#DIV/0!)
Cell.setValue(ws, "G6", { formula: "ERROR.TYPE(A5)" }); // 7  (#N/A)

// ── Constructors ──
Cell.setValue(ws, "H1", { formula: "NA()" }); // #N/A

// ── CELL metadata (evaluator-aware) ──
Cell.setValue(ws, "I1", { formula: 'CELL("address", A1)' }); // $A$1
Cell.setValue(ws, "I2", { formula: 'CELL("row", A8)' }); // 8
Cell.setValue(ws, "I3", { formula: 'CELL("col", A8)' }); // 1
Cell.setValue(ws, "I4", { formula: 'CELL("contents", A1)' }); // 42
Cell.setValue(ws, "I5", { formula: 'CELL("type", A2)' }); // "l" (label/text)

calculateFormulas(wb);

const groups: Record<string, string[]> = {
  "Type predicates": ["B1", "B2", "B3", "B4", "B5"],
  "Error predicates": ["C1", "C2", "C3", "C4"],
  Parity: ["D1", "D2"],
  "Reference probes": ["E1", "E2", "E3", "E4"],
  Coercion: ["F1", "F2", "F3", "F4", "F5"],
  Classification: ["G1", "G2", "G3", "G4", "G5", "G6"],
  Constructors: ["H1"],
  "CELL metadata": ["I1", "I2", "I3", "I4", "I5"]
};

console.log("=== Information Functions ===\n");
for (const [title, addrs] of Object.entries(groups)) {
  console.log(`--- ${title} ---`);
  for (const addr of addrs) {
    const c = getCell(ws, addr);
    console.log(
      `  ${addr}  ${String(cellFormula(c)).padEnd(24)}  = ${JSON.stringify(cellResult(c))}`
    );
  }
  console.log("");
}
