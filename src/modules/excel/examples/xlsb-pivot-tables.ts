/**
 * PivotTables through XLSB — the feature with the most records and the least room for error.
 *
 * Fourteen separate defects stood between a modelled pivot and one Excel would open, and the two worth naming
 * here are the ones that produce a *plausible* file. `BrtBeginPivotCacheIDs` must carry an **empty** payload
 * rather than a count, and the body's rectangle has to agree with the pivot lines actually written — those were
 * computed by two different rules, a cross product against the combinations the data really contains, so the
 * body claimed rows it never fills.
 *
 * Cached source values matter too: a date in a cache record is eight structured bytes, and reaching that path
 * through `String()` wrote a locale-dependent English sentence instead.
 *
 * Run: pnpm example --filter xlsb-pivot-tables
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { sampleSheet } from "@excel/examples/utils/features";
import { Pivot, Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
const source = sampleSheet(workbook);

// Three shapes, because the geometry differs for each: one row field, two nested, and a column axis.
Pivot.add(
  Workbook.addWorksheet(workbook, "OneRow") as never,
  {
    sourceSheet: source,
    rows: ["Region"],
    values: ["Units"],
    anchor: "A3"
  } as never
);
Pivot.add(
  Workbook.addWorksheet(workbook, "TwoRows") as never,
  {
    sourceSheet: source,
    rows: ["Region", "Sold"],
    values: ["Units"],
    anchor: "A3"
  } as never
);
Pivot.add(
  Workbook.addWorksheet(workbook, "WithColumn") as never,
  {
    sourceSheet: source,
    rows: ["Region"],
    columns: ["Sold"],
    values: ["Units"],
    anchor: "A3"
  } as never
);

const { results, dropped } = await writeBoth(workbook, "xlsb-pivot-tables");

// **Read the XLSB row as a limitation, not a loss.** The three pivot parts survive an XLSB round trip as
// preserved bytes — the file keeps its pivots — but the reader does not put them back into the model, so the
// count is zero and a caller cannot inspect or edit them. The XLSX column is what a modelled pivot looks like,
// and the gap between the two columns is precisely the work still outstanding.
report("pivots the model reports", results, reloaded => {
  const counts = ["OneRow", "TwoRows", "WithColumn"].map(name => {
    const sheet = Workbook.getWorksheet(reloaded, name);
    const model = Worksheet.getModel(sheet!) as unknown as { pivotTables?: readonly unknown[] };
    return `${name}=${model.pivotTables?.length ?? 0}`;
  });
  return counts.join(", ");
});

report("pivot parts still in the package", results, (_reloaded, written) => {
  // Counted in the package rather than in the model, because that is the distinction being made: the parts are
  // there in both containers, and only one of them reads them back.
  const kept = written.parts.filter(name => /pivotTable\d+\.(bin|xml)$/.test(name));
  return kept.length === 0 ? "none" : `${kept.length} part(s)`;
});

// Only meaningful for the container that models them; the XLSB row says so rather than reporting zero as if it
// were an answer.
report("row and value fields", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "TwoRows");
  const model = Worksheet.getModel(sheet!) as unknown as {
    pivotTables?: readonly {
      readonly rows?: readonly unknown[];
      readonly values?: readonly unknown[];
    }[];
  };
  const pivot = model.pivotTables?.[0];
  return pivot === undefined
    ? "no pivot"
    : `${pivot.rows?.length ?? 0} row field(s), ${pivot.values?.length ?? 0} value(s)`;
});

reportDropped(dropped);
reportFiles(results);
