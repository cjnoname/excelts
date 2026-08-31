/**
 * Number formats through XLSB, laid out so the result can be read at a glance in a spreadsheet.
 *
 * Run: `pnpm example --filter xlsb-number-formats`
 *
 * A format code is the difference between a correct number and a correct *answer*: 45291 and
 * 2023-12-25 are the same cell, and only the format says which one a reader sees. This is the
 * feature XLSB support was built around first for that reason — a missing format does not lose
 * data, it changes what the data appears to say.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Column, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "xlsb-number-formats.xlsb");

const wb = Workbook.create();
const ws = Workbook.addWorksheet(wb, "Formats");

Worksheet.addRow(ws, ["Format code", "Raw value", "As Excel shows it"]);
Cell.setStyle(ws, "A1", { font: { bold: true } });
Cell.setStyle(ws, "B1", { font: { bold: true } });
Cell.setStyle(ws, "C1", { font: { bold: true } });
Column.setWidth(ws, 1, 30);
Column.setWidth(ws, 2, 16);
Column.setWidth(ws, 3, 22);

/** Every format is applied to the same value in column C, so the column reads as a comparison. */
const cases: readonly { readonly code: string; readonly value: number | Date }[] = [
  { code: "General", value: 1234.5678 },
  { code: "0", value: 1234.5678 },
  { code: "0.00", value: 1234.5678 },
  { code: "#,##0", value: 1234567.89 },
  { code: "#,##0.00", value: 1234567.89 },
  { code: "0%", value: 0.1234 },
  { code: "0.00%", value: 0.1234 },
  { code: "0.00E+00", value: 1234.5678 },
  { code: "# ?/?", value: 1.75 },
  { code: '"$"#,##0.00', value: 1234.5 },
  { code: '"£"#,##0.00;[Red]-"£"#,##0.00', value: -1234.5 },
  { code: "#,##0;[Red](#,##0)", value: -9876 },
  { code: "yyyy-mm-dd", value: new Date(Date.UTC(2023, 11, 25)) },
  { code: "d-mmm-yyyy", value: new Date(Date.UTC(2023, 11, 25)) },
  { code: "mmmm yyyy", value: new Date(Date.UTC(2023, 11, 25)) },
  { code: "h:mm:ss", value: 0.5 },
  { code: "[h]:mm:ss", value: 1.5 },
  { code: "yyyy-mm-dd hh:mm", value: new Date(Date.UTC(2023, 11, 25, 13, 45)) },
  { code: "@", value: 42 }
];

cases.forEach(({ code, value }, index) => {
  const row = index + 2;
  Cell.setValue(ws, `A${row}`, code);
  Cell.setStyle(ws, `A${row}`, { font: { name: "Courier New" } });
  Cell.setValue(ws, `B${row}`, value instanceof Date ? value.toISOString().slice(0, 19) : value);
  Cell.setValue(ws, `C${row}`, value);
  // `General` is the absence of a format, so it is not written as one — a cell that asked for it
  // comes back with no format at all rather than with a format whose name means "none".
  if (code !== "General") {
    Cell.setStyle(ws, `C${row}`, { numFmt: code });
  }
});

await Workbook.writeFile(wb, filename);
console.log(`wrote ${filename}`);

// The round trip, reported per format so a mismatch names itself.
const reopened = Workbook.create();
await Workbook.readFile(reopened, filename);
const read = Workbook.getWorksheets(reopened)[0]!;
let kept = 0;
cases.forEach(({ code }, index) => {
  const got = Cell.getStyle(read, `C${index + 2}`)?.numFmt;
  const expected = code === "General" ? undefined : code;
  if (got === expected) {
    kept++;
  } else {
    console.log(`  ${code} → ${JSON.stringify(got)}`);
  }
});
console.log(`${kept}/${cases.length} format codes survived unchanged`);

// A date-formatted cell reads back as a Date, not as the serial number underneath it.
const christmas = Cell.getValue(read, "C14");
console.log(
  `C14 is a Date: ${christmas instanceof Date}`,
  christmas instanceof Date ? christmas.toISOString().slice(0, 10) : ""
);
