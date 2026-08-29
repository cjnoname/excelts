import { calculateFormulas } from "@excel/bridge/formula";
import { Cell, Workbook } from "@excel/index";

/**
 * Example: Text Formulas
 *
 * Covers:
 * - Case & trim (UPPER, LOWER, PROPER, TRIM, CLEAN)
 * - Slicing (LEFT, RIGHT, MID, LEN)
 * - Search / replace (FIND, SEARCH, SUBSTITUTE, REPLACE)
 * - Concatenation (CONCAT, TEXTJOIN, `&` operator)
 * - Formatting (TEXT, VALUE, FIXED, DOLLAR)
 * - Character codes (CHAR, UNICHAR, CODE, UNICODE)
 * - Regex (REGEXTEST, REGEXEXTRACT, REGEXREPLACE)
 */
const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Text");

Cell.setValue(ws, "A1", "  hello WORLD  ");
Cell.setValue(ws, "A2", "name@example.com");
Cell.setValue(ws, "A3", "Phone: +1-415-555-0123");

// Case & trim
Cell.setValue(ws, "B1", { formula: "TRIM(A1)" }); // "hello WORLD"
Cell.setValue(ws, "B2", { formula: "UPPER(TRIM(A1))" }); // "HELLO WORLD"
Cell.setValue(ws, "B3", { formula: "PROPER(TRIM(A1))" }); // "Hello World"

// Slicing
Cell.setValue(ws, "C1", { formula: "LEFT(A2, 4)" }); // "name"
Cell.setValue(ws, "C2", { formula: 'MID(A2, FIND("@",A2)+1, 100)' }); // "example.com"
Cell.setValue(ws, "C3", { formula: "LEN(A2)" }); // 16

// Search / substitute
Cell.setValue(ws, "D1", { formula: 'SUBSTITUTE(A2,"example","acme")' });
Cell.setValue(ws, "D2", { formula: 'FIND("@", A2)' }); // 5

// Concatenation
Cell.setValue(ws, "E1", { formula: 'CONCAT("Hi, ", PROPER(TRIM(A1)), "!")' });
Cell.setValue(ws, "E2", { formula: 'TEXTJOIN(", ", TRUE, B1, B2, B3)' });

// Formatting
Cell.setValue(ws, "F1", { formula: 'TEXT(1234567.89, "#,##0.00")' }); // "1,234,567.89"
Cell.setValue(ws, "F2", { formula: 'VALUE("42.5")' }); // 42.5

// Regex (Excel 365)
Cell.setValue(ws, "G1", { formula: 'REGEXTEST(A2, "^[^@]+@[^@]+$")' }); // TRUE
Cell.setValue(ws, "G2", { formula: 'REGEXEXTRACT(A3, "[0-9]{3}-[0-9]{3}-[0-9]{4}")' }); // "415-555-0123"

calculateFormulas(wb);

for (const addr of [
  "B1",
  "B2",
  "B3",
  "C1",
  "C2",
  "C3",
  "D1",
  "D2",
  "E1",
  "E2",
  "F1",
  "F2",
  "G1",
  "G2"
]) {
  console.log(
    `${addr}  ${String(Cell.getFormula(ws, addr)).padEnd(48)}  = ${JSON.stringify(Cell.getResult(ws, addr))}`
  );
}
