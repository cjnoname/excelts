import { calculateFormulas, FormulaValueKind } from "@excel/bridge/formula";
import type { FormulaValue } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Custom Function Registration
 *
 * The formula engine consults a workbook's `userFunctions` map *before*
 * the built-in registry, so callers can add brand-new functions or shadow
 * a built-in for a single workbook. Registration goes through
 * `Workbook.registerFunction(wb, name, fn, options?)` and removal through
 * `Workbook.unregisterFunction(wb, name)`.
 *
 * The `fn` receives evaluated arguments as `FormulaValue`s — tagged unions of
 * the shape `{ kind, value }`, where `kind` comes from the published
 * `FormulaValueKind` map (errors carry `code` instead of `value`). It must
 * return a `FormulaValue` of the same shape. A thrown error is caught at the
 * boundary and surfaces as `#VALUE!`.
 *
 * Usage: npx tsx src/modules/formula/examples/formula-custom-functions.ts
 */

const { Number: NUMBER, String: STRING, Boolean: BOOLEAN, Error: ERROR } = FormulaValueKind;

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Custom");

// ── 1. A brand-new numeric function: TAX(amount, rate) ──
Workbook.registerFunction(
  wb,
  "TAX",
  args => {
    const amount = args[0] as FormulaValue;
    const rate = args[1] as FormulaValue;
    if (amount.kind !== NUMBER || rate.kind !== NUMBER) {
      return { kind: ERROR, code: "#VALUE!" };
    }
    return { kind: NUMBER, value: amount.value * rate.value };
  },
  { minArity: 2, maxArity: 2 }
);

// ── 2. A text function: GREET(name) → "Hello, <name>!" ──
Workbook.registerFunction(
  wb,
  "GREET",
  args => {
    const name = args[0] as FormulaValue;
    const who = name.kind === STRING ? name.value : "world";
    return { kind: STRING, value: `Hello, ${who}!` };
  },
  { minArity: 1, maxArity: 1 }
);

// ── 3. A zero-arg constant ──
Workbook.registerFunction(wb, "ANSWER", () => ({ kind: NUMBER, value: 42 }));

// ── 4. A boolean predicate that returns a real error for bad input ──
Workbook.registerFunction(
  wb,
  "ISPOSITIVE",
  args => {
    const v = args[0] as FormulaValue;
    if (v.kind !== NUMBER) {
      return { kind: ERROR, code: "#N/A" };
    }
    return { kind: BOOLEAN, value: v.value > 0 };
  },
  { minArity: 1, maxArity: 1 }
);

// ── 5. Shadow a built-in: override SUM for THIS workbook only ──
// Our SUM doubles the first argument — proof the user map wins.
Workbook.registerFunction(wb, "SUM", args => {
  const v = args[0] as FormulaValue;
  return { kind: NUMBER, value: v.kind === NUMBER ? v.value * 2 : 0 };
});

// Inputs
Cell.setValue(ws, "A1", 200); // amount
Cell.setValue(ws, "A2", 0.08); // rate
Cell.setValue(ws, "A3", "Ada"); // name
Cell.setValue(ws, "A4", -5);
Cell.setValue(ws, "A5", 10);

// Formulas exercising the custom functions — including composition with
// built-ins (IF, ROUND) and a shadowed SUM.
Cell.setValue(ws, "B1", { formula: "TAX(A1, A2)" }); // 16
Cell.setValue(ws, "B2", { formula: "ROUND(TAX(A1, A2), 0)" }); // 16
Cell.setValue(ws, "B3", { formula: "GREET(A3)" }); // "Hello, Ada!"
Cell.setValue(ws, "B4", { formula: "ANSWER()" }); // 42
Cell.setValue(ws, "B5", { formula: "ISPOSITIVE(A5)" }); // TRUE
Cell.setValue(ws, "B6", { formula: "ISPOSITIVE(A4)" }); // FALSE
Cell.setValue(ws, "B7", { formula: 'IF(ISPOSITIVE(A4), "pos", "neg")' }); // "neg"
Cell.setValue(ws, "B8", { formula: "ISPOSITIVE(A3)" }); // #N/A (text input)
Cell.setValue(ws, "B9", { formula: "SUM(A5)" }); // 20 (shadowed: 10 * 2)

calculateFormulas(wb);

console.log("=== Custom Function Registration ===\n");
const labels: Record<string, string> = {
  B1: "TAX(A1, A2)            ",
  B2: "ROUND(TAX(A1, A2), 0)  ",
  B3: "GREET(A3)              ",
  B4: "ANSWER()               ",
  B5: "ISPOSITIVE(A5)         ",
  B6: "ISPOSITIVE(A4)         ",
  B7: "IF(ISPOSITIVE(A4),...) ",
  B8: "ISPOSITIVE(A3)         ",
  B9: "SUM(A5)  [shadowed]    "
};
for (const [addr, label] of Object.entries(labels)) {
  console.log(`  ${label} = ${JSON.stringify(Cell.getResult(ws, addr))}`);
}

// ── 6. unregisterFunction restores built-in / removes custom name ──
console.log("\n--- After unregistering SUM and TAX ---");
Workbook.unregisterFunction(wb, "SUM");
Workbook.unregisterFunction(wb, "TAX");
// Re-set the formulas so no cached result masks the change.
Cell.setValue(ws, "B9", { formula: "SUM(A1, A5)" }); // built-in again → 210
Cell.setValue(ws, "B1", { formula: "TAX(A1, A2)" }); // unknown now → #NAME?
calculateFormulas(wb);
console.log(`  SUM(A1, A5)  [built-in restored] = ${JSON.stringify(Cell.getResult(ws, "B9"))}`);
console.log(`  TAX(A1, A2)  [unregistered]      = ${JSON.stringify(Cell.getResult(ws, "B1"))}`);
