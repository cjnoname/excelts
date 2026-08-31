/**
 * A large binary workbook, which is what the format exists for.
 *
 * Run: `pnpm example --filter xlsb-large`
 *
 * Two things make a `.xlsb` smaller and quicker than the same data as `.xlsx`, and both are visible
 * here. Strings are interned once and referenced by a four-byte index. And a number that fits is
 * written as an `RK` — thirty bits of mantissa in four bytes instead of a full `float64` — which
 * `encodeRk` will only use when it is *exact*, so `19.99` becomes an RK through the ×100 form while
 * `1/3` stays a full double rather than being quietly rounded.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { Cell, Column, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const prefix = process.argv[2] ?? path.join(outDir, "xlsb-large");

const ROWS = 20_000;
const REGIONS = ["North", "South", "East", "West", "Central"] as const;
const PRODUCTS = ["Widget", "Gadget", "Doohickey", "Thingamajig"] as const;

function build(): ReturnType<typeof Workbook.create> {
  const wb = Workbook.create();
  const ws = Workbook.addWorksheet(wb, "Transactions");
  Worksheet.addRow(ws, ["Date", "Region", "Product", "Units", "Unit price", "Revenue"]);
  Cell.setStyle(ws, "A1", { font: { bold: true } });
  Column.setWidth(ws, 1, 12);
  Column.setWidth(ws, 5, 12);
  Column.setWidth(ws, 6, 14);
  // A number format on the *column* rather than on twenty thousand cells. Both because it is one
  // record instead of twenty thousand style references, and because it is the only way the dates
  // come back as dates: a `.xlsb` stores a date as a serial number, and the format is the only thing
  // that says which serials are dates. Without it, `A10000` reads back as 45291 — correct, and not
  // an answer to the question anyone asked.
  Column.setStyle(ws, 1, { numFmt: "yyyy-mm-dd" });
  Column.setStyle(ws, 5, { numFmt: '"$"#,##0.00' });
  Column.setStyle(ws, 6, { numFmt: '"$"#,##0.00' });

  for (let index = 0; index < ROWS; index++) {
    const row = index + 2;
    // A deterministic spread, so the file is the same on every run and the sizes are comparable.
    const units = 1 + ((index * 7) % 500);
    // Prices in whole cents: exactly the shape `encodeRk`'s ×100 form is for.
    const price = (100 + ((index * 13) % 4900)) / 100;
    Cell.setValue(ws, `A${row}`, new Date(Date.UTC(2024, 0, 1 + (index % 366))));
    Cell.setValue(ws, `B${row}`, REGIONS[index % REGIONS.length]!);
    Cell.setValue(ws, `C${row}`, PRODUCTS[index % PRODUCTS.length]!);
    Cell.setValue(ws, `D${row}`, units);
    Cell.setValue(ws, `E${row}`, price);
    Cell.setValue(ws, `F${row}`, Math.round(units * price * 100) / 100);
  }
  return wb;
}

const stopwatch = new HrStopwatch();
const sizes: Record<string, number> = {};
for (const format of ["xlsb", "xlsx"] as const) {
  const wb = build();
  const file = `${prefix}.${format}`;
  stopwatch.start();
  await Workbook.writeFile(wb, file);
  const micros = stopwatch.microseconds;
  sizes[format] = fs.statSync(file).size;
  console.log(
    `wrote ${file} — ${ROWS} rows, ${(sizes[format]! / 1024).toFixed(0)} KiB, ${(micros / 1000).toFixed(0)} ms`
  );
}
console.log(
  `xlsb is ${((1 - sizes.xlsb! / sizes.xlsx!) * 100).toFixed(0)}% smaller than the same data as xlsx`
);

// Read it back and check a row in the middle, so the assertion is not about the edges.
stopwatch.start();
const reopened = Workbook.create();
await Workbook.readFile(reopened, `${prefix}.xlsb`);
const readMicros = stopwatch.microseconds;
const read = Workbook.getWorksheets(reopened)[0]!;
console.log(`read back in ${(readMicros / 1000).toFixed(0)} ms`);
console.log(
  `  row 10000: ${["B", "C", "D", "E", "F"].map(column => JSON.stringify(Cell.getValue(read, `${column}10000`))).join(" ")}`
);
const when = Cell.getValue(read, "A10000");
console.log(
  `  A10000 is a Date: ${when instanceof Date}`,
  when instanceof Date ? when.toISOString().slice(0, 10) : ""
);
