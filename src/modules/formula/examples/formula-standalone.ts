import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Functional / Standalone API
 *
 * Covers:
 * - `calculateFormulas(wb)` from `documonster/excel/formula` — the formula
 *   engine driven from a real workbook, with no install / registration step.
 *   Its own subpath, so a consumer who never imports it never bundles the
 *   engine.
 *
 * - `tokenize` / `parse` — pure syntax inspection. Use these for linters,
 *   formula migration tools, or static analysis that does not evaluate
 *   anything (they never pull the evaluator in).
 */
import { Formula } from "../index";

// =============================================================================
// 1. Functional calculation — zero side effects, no install step
// =============================================================================

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Func");
Cell.setValue(ws, "A1", 10);
Cell.setValue(ws, "A2", 20);
Cell.setValue(ws, "A3", 30);
Cell.setValue(ws, "B1", { formula: "SUM(A1:A3)" });
Cell.setValue(ws, "B2", { formula: "AVERAGE(A1:A3)" });
Cell.setValue(ws, "B3", { formula: "MAX(A1:A3)" });

calculateFormulas(wb);

console.log("Functional calculateFormulas():");
console.log("  B1 =", Cell.getResult(ws, "B1")); // 60
console.log("  B2 =", Cell.getResult(ws, "B2")); // 20
console.log("  B3 =", Cell.getResult(ws, "B3")); // 30

// =============================================================================
// 2. Syntax inspection — tokenize + parse
// =============================================================================

const tokens = Formula.tokenize("SUM(A1:B10) + VLOOKUP(key, table, 2, FALSE)");
console.log("\ntokenize():");
for (const tok of tokens) {
  console.log(`  ${tok.type} ${"value" in tok ? JSON.stringify(tok.value) : ""}`);
}

// Structural check — can the parser handle it?
try {
  const ast = Formula.parse(tokens);
  console.log("\nparse():", ast.type, "root node — syntactically valid");
} catch (err) {
  console.log("\nparse() failed:", (err as Error).message);
}

// A deliberately malformed formula
try {
  Formula.parse(Formula.tokenize("SUM(A1:"));
  console.log("unexpected success");
} catch (err) {
  console.log("Bad formula rejected as expected:", (err as Error).message);
}
