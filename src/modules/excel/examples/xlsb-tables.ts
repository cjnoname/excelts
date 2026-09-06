/**
 * Tables through XLSB: the part, the record that points at it, and the totals-row formula.
 *
 * A table is its own part reached by a relationship — and **also named by a `BrtListPart` in the sheet**, which
 * this writer did not emit. The part, its content type and its relationship were all correct and the sheet never
 * referred to them, so every table was in the package and invisible in Excel. A package validator cannot see
 * that: every part it checks is present and well formed.
 *
 * The totals row is the other half. `SUBTOTAL(109,Sales[Qty])` needs both a function id and a structured
 * reference, and the function table was missing `SUBTOTAL` — so the cell went out blank.
 *
 * Run: pnpm example --filter xlsb-tables
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildTable, sampleSheet } from "@excel/examples/utils/features";
import { Table, Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
buildTable(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-tables");

report("tables after a round trip", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  // `Table.list` yields *handles*, not models — the name comes from `Table.name`. Reading `.name` off the
  // handle gives `undefined`, which is how the first version of this printed "(unnamed)" for a table that was
  // perfectly intact. An example that reports the wrong thing is worse than one that reports nothing.
  const tables = Table.list(sheet!);
  return tables.length === 0 ? "none survived" : tables.map(table => Table.name(table)).join(", ");
});

// **The range, not just the name.** `ref` is the anchor the caller passed and `tableRef` is the range the table
// actually occupies; the XLSB adapter read them in the wrong order, so an anchored table went out one cell wide.
report("range", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(sheet!) as unknown as {
    tables?: readonly { readonly tableRef?: string; readonly ref?: string }[];
  };
  const table = model.tables?.[0];
  return table === undefined ? "no table" : (table.tableRef ?? table.ref ?? "no range");
});

report("totals-row formula", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(sheet!) as unknown as {
    tables?: readonly { readonly columns?: readonly { readonly totalsRowFunction?: string }[] }[];
  };
  const columns = model.tables?.[0]?.columns ?? [];
  const totals = columns.map(column => column.totalsRowFunction ?? "—").join(", ");
  return totals === "" ? "no columns" : totals;
});

reportDropped(dropped);
reportFiles(results);
