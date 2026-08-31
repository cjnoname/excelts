/**
 * Formulas through XLSB, and the honest boundary of what its token encoder can express.
 *
 * Run: `pnpm example --filter xlsb-formulas`
 *
 * BIFF12 does not store formula *text*. It stores a reverse-polish stream of typed tokens, so a
 * formula has to be parsed on the way in and printed on the way out — which is why this module owns
 * only the token half and `@formula` owns the text half. A formula whose tokens cannot be produced is
 * reported by address rather than written as its cached result, because a cell that shows the right
 * number and never recalculates is worse than a cell that admits it is empty.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, DefinedNames, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-formulas.xlsb");

const wb = Workbook.create();

const data = Workbook.addWorksheet(wb, "Data");
Worksheet.addRow(data, ["Quarter", "Units", "Price"]);
Worksheet.addRow(data, ["Q1", 120, 19.99]);
Worksheet.addRow(data, ["Q2", 84, 24.5]);
Worksheet.addRow(data, ["Q3", 203, 12.75]);
Worksheet.addRow(data, ["Q4", 156, 18.0]);
for (const row of [2, 3, 4, 5]) {
  Cell.setStyle(data, `C${row}`, { numFmt: '"$"#,##0.00' });
}
DefinedNames.add(Workbook.getDefinedNames(wb), "Data!$B$2:$B$5", "Units");

const calc = Workbook.addWorksheet(wb, "Calc");
Column.setWidth(calc, 1, 34);
Column.setWidth(calc, 2, 30);
Column.setWidth(calc, 3, 16);
Worksheet.addRow(calc, ["What it demonstrates", "Formula", "Result"]);
for (const column of ["A1", "B1", "C1"]) {
  Cell.setStyle(calc, column, { font: { bold: true } });
}

/**
 * Each entry is written with its cached result, which is what a consumer shows before it
 * recalculates — and what a reader gets back if it never does.
 */
const formulas: readonly {
  readonly note: string;
  readonly formula: string;
  readonly result: number | string | boolean;
}[] = [
  { note: "arithmetic", formula: "2+3*4", result: 14 },
  { note: "unary minus binds tighter than ^", formula: "-2^2", result: 4 },
  { note: "parentheses", formula: "(2+3)*4", result: 20 },
  { note: "a cell reference", formula: "Data!B2", result: 120 },
  { note: "an absolute reference", formula: "Data!$B$2", result: 120 },
  { note: "a range and a function", formula: "SUM(Data!B2:B5)", result: 563 },
  { note: "a defined name", formula: "SUM(Units)", result: 563 },
  { note: "nested functions", formula: "ROUND(AVERAGE(Data!B2:B5),1)", result: 140.8 },
  { note: "a comparison", formula: "Data!B2>Data!B3", result: true },
  { note: "text concatenation", formula: 'Data!A2&" units"', result: "Q1 units" },
  {
    note: "CONCATENATE, which & compiles to",
    formula: 'CONCATENATE(Data!A2," / ",Data!A3)',
    result: "Q1 / Q2"
  },
  { note: "a conditional", formula: 'IF(Data!B2>100,"high","low")', result: "high" },
  {
    note: "a string literal with a quote in it",
    formula: '"she said ""hi"""',
    result: 'she said "hi"'
  },
  { note: "a leading = , as a user types it", formula: "=SUM(Data!B2:B3)", result: 204 },
  { note: "an intersection of two ranges", formula: "SUM(Data!B2:B5 Data!B3:B4)", result: 287 },
  { note: "a union of two ranges", formula: "SUM((Data!B2,Data!B5))", result: 276 }
];

formulas.forEach(({ note, formula, result }, index) => {
  const row = index + 2;
  Cell.setValue(calc, `A${row}`, note);
  Cell.setValue(calc, `B${row}`, formula);
  Cell.setStyle(calc, `B${row}`, { font: { name: "Courier New" } });
  Cell.setValue(calc, `C${row}`, { formula, result });
});

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

// Read back and compare the *expressions*, not the numbers. A reader that lost the expression and
// kept the cached result looks correct until someone edits a cell.
const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);
const read = Workbook.getWorksheets(reopened)[1]!;
let survived = 0;
formulas.forEach(({ formula }, index) => {
  const value = Cell.getValue(read, `C${index + 2}`);
  const got =
    value !== null && typeof value === "object" && "formula" in value ? value.formula : undefined;
  // A leading `=` is notation rather than part of the expression, so it is not expected back.
  const expected = formula.replace(/^=/, "");
  if (got === expected) {
    survived++;
  } else {
    console.log(`  ${expected} → ${JSON.stringify(got)}`);
  }
});
console.log(`${survived}/${formulas.length} formulas round-tripped as expressions`);

// And what it cannot express, named by address rather than approximated.
const unsupported = Workbook.create();
const sheet = Workbook.addWorksheet(unsupported, "Limits");
Cell.setValue(sheet, "A1", { formula: "SUBTOTAL(109,Table1[Amount])", result: 0 });
Cell.setValue(sheet, "A2", { formula: "SEQUENCE(3)", result: 1 });
try {
  await Workbook.toBuffer(unsupported, { format: "xlsb" });
  console.log("unexpected: nothing reported");
} catch (error) {
  console.log(`reported: ${(error as Error).message.split(". Pass")[0]}`);
}
