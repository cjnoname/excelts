/**
 * Example: Excel — dates as calendar values, not instants
 *
 * A spreadsheet date is a *civil* value: a date on a calendar, a time on a clock, no timezone. A JavaScript
 * `Date` is an instant. This example is about that gap, because it is where date bugs come from — and the
 * output is deliberately arranged so you can see the gap rather than read about it.
 *
 * Column B is what each row's value looks like once written. Run it in different timezones and watch which
 * rows move:
 *
 *   TZ=UTC            pnpm example --filter dates-and-temporal
 *   TZ=Asia/Shanghai  pnpm example --filter dates-and-temporal
 *
 * Only the `new Date(y, m, d)` row changes. Everything else is invariant, which is the whole point.
 *
 * Shows:
 * - Cell.setDateParts / Cell.getDateParts — calendar fields, available on every runtime
 * - Cell.getDateKind                      — date vs time vs dateTime, which a `Date` cannot carry
 * - Cell.setValue with Temporal.Plain*    — the same thing with nicer ergonomics, where the runtime has it
 * - Cell.getTemporal                      — reading one back as the type it went in as
 *
 * Usage:   pnpm example --filter dates-and-temporal
 * Output:  tmp/excel-examples/dates-and-temporal.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cell, Workbook, Worksheet } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
fs.mkdirSync(outDir, { recursive: true });
const filename = process.argv[2] ?? path.join(outDir, "dates-and-temporal.xlsx");

/** Present on Node 26+, Chrome 144+, Firefox 139+, Bun 1.4+, Deno 2.7+ — and nowhere else this package supports. */
const temporal = (globalThis as { Temporal?: typeof globalThis.Temporal }).Temporal;

const workbook = Workbook.create();
const sheet = Workbook.addWorksheet(workbook, "Dates");
Worksheet.setColumns(sheet, [
  { header: "How the value was written", width: 44 },
  { header: "The cell", width: 24 },
  { header: "Kind", width: 12 },
  { header: "Notes", width: 62 }
]);
Cell.setFont(sheet, "A1", { bold: true });
Cell.setFont(sheet, "B1", { bold: true });
Cell.setFont(sheet, "C1", { bold: true });
Cell.setFont(sheet, "D1", { bold: true });

let row = 1;

/** Write one demonstration row and label it. */
function demo(label: string, write: (address: string) => void, note: string): void {
  row += 1;
  Cell.setValue(sheet, `A${row}`, label);
  write(`B${row}`);
  Cell.setValue(sheet, `C${row}`, Cell.getDateKind(sheet, `B${row}`) ?? "—");
  Cell.setValue(sheet, `D${row}`, note);
}

// ---------------------------------------------------------------------------
// The two ways to pass a `Date`, and why only one of them is safe.
// ---------------------------------------------------------------------------

demo(
  "new Date(Date.UTC(2024, 0, 15))",
  address => Cell.setValue(sheet, address, new Date(Date.UTC(2024, 0, 15))),
  "Correct. The library reads a Date's UTC fields as the calendar value."
);

demo(
  "new Date(2024, 0, 15)",
  address => Cell.setValue(sheet, address, new Date(2024, 0, 15)),
  "Timezone-dependent. In UTC+8 this cell is 2024-01-14 16:00 — run this file under TZ=Asia/Shanghai and compare."
);

// ---------------------------------------------------------------------------
// Calendar fields. No timezone exists for them to be misread against, and they
// work on every runtime — this is the primitive, not a fallback.
// ---------------------------------------------------------------------------

demo(
  "Cell.setDateParts({ year, month, day })",
  address => Cell.setDateParts(sheet, address, { year: 2024, month: 1, day: 15 }),
  "Unambiguous by construction. Note month is 1-based, matching Excel and Temporal — not Date."
);

demo(
  'Cell.setDateParts({ hour, minute }, "time")',
  address => Cell.setDateParts(sheet, address, { hour: 9, minute: 30 }, "time"),
  "A time-of-day. Written as a bare Date this renders as 12-30-1899: the number format is the only record of the kind."
);

demo(
  "Cell.setDateParts({ …date, …time })",
  address =>
    Cell.setDateParts(sheet, address, {
      year: 2024,
      month: 1,
      day: 15,
      hour: 9,
      minute: 30,
      second: 45
    }),
  "Kind inferred from the fields present; pass it explicitly for a date-time whose time is midnight."
);

// ---------------------------------------------------------------------------
// Temporal. The same values, said more directly — a PlainDate simply has no
// instant for a timezone to act on.
// ---------------------------------------------------------------------------

if (temporal === undefined) {
  row += 1;
  Cell.setValue(sheet, `A${row}`, "Temporal.Plain* …");
  Cell.setValue(
    sheet,
    `D${row}`,
    `Skipped: this runtime (${process.version}) has no Temporal. Node 26+ does.`
  );
} else {
  demo(
    'Temporal.PlainDate.from("2024-01-15")',
    address => Cell.setValue(sheet, address, temporal.PlainDate.from("2024-01-15")),
    "Gets a date number format, and reads back as a PlainDate."
  );
  demo(
    'Temporal.PlainTime.from("09:30")',
    address => Cell.setValue(sheet, address, temporal.PlainTime.from("09:30")),
    "Gets a time number format, and reads back as a PlainTime."
  );
  demo(
    'Temporal.PlainDateTime.from("2024-01-15T09:30:45")',
    address => Cell.setValue(sheet, address, temporal.PlainDateTime.from("2024-01-15T09:30:45")),
    "Gets a date-time number format, and reads back as a PlainDateTime."
  );
}

// ---------------------------------------------------------------------------
// Read it all back, and report what came out.
// ---------------------------------------------------------------------------

const bytes = await Workbook.toBuffer(workbook);
const reopened = Workbook.create();
await Workbook.read(reopened, bytes);
const reread = Workbook.getWorksheet(reopened, "Dates")!;

console.log(`TZ=${process.env.TZ ?? "(system default)"}  —  what each cell became:\n`);
for (let index = 2; index <= row; index += 1) {
  const label = Cell.getValue(reread, `A${index}`);
  const parts = Cell.getDateParts(reread, `B${index}`);
  if (parts === undefined) {
    continue;
  }
  const kind = Cell.getDateKind(reread, `B${index}`);
  const iso =
    `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-` +
    `${String(parts.day).padStart(2, "0")} ` +
    `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:` +
    `${String(parts.second).padStart(2, "0")}`;
  // Through `getTemporal` as well, where it is available, so the example exercises the accessor it documents.
  const asTemporal =
    temporal === undefined ? "" : `  →  ${String(Cell.getTemporal(reread, `B${index}`))}`;
  console.log(`  ${String(label).padEnd(46)} ${iso}  [${String(kind).padEnd(8)}]${asTemporal}`);
}

fs.writeFileSync(filename, bytes);
console.log(`\nWrote ${filename}`);
