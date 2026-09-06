/**
 * Defined names through XLSB, and the table their formulas point into.
 *
 * A name's formula is tokens, and a cross-sheet reference in it carries an `ixti` that indexes
 * `BrtExternSheet`. Until that table was written every such reference pointed at nothing — and a read-back still
 * returned the right answer, because it read the *cached* result rather than resolving the reference. So a name
 * can look correct in this library and be broken in Excel.
 *
 * Run: pnpm example --filter xlsb-defined-names
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildDefinedNames, sampleSheet } from "@excel/examples/utils/features";
import { DefinedNames, Workbook } from "@excel/index";

const workbook = Workbook.create();
sampleSheet(workbook);
buildDefinedNames(workbook);

const { results, dropped } = await writeBoth(workbook, "xlsb-defined-names");

report("names after a round trip", results, reloaded => {
  // `getAllEntries`, not `getNames` — the latter answers "which names cover *this cell*" and needs an address,
  // so calling it with only the container throws. Two members whose names suggest the same thing.
  const entries = DefinedNames.getAllEntries(
    Workbook.getDefinedNames(reloaded) as never
  ) as readonly { readonly name?: string }[];
  return entries.length === 0
    ? "none survived"
    : entries
        .map(entry => entry.name ?? "?")
        .sort()
        .join(", ");
});

report("what they point at", results, reloaded => {
  const container = Workbook.getDefinedNames(reloaded) as never;
  const entries = DefinedNames.getAllEntries(container) as readonly {
    readonly name?: string;
    readonly ranges?: readonly string[];
    readonly formula?: string;
  }[];
  return entries.length === 0
    ? "nothing"
    : entries
        .map(
          entry => `${entry.name ?? "?"}→${(entry.ranges ?? []).join("+") || entry.formula || "—"}`
        )
        .join("  ");
});

reportDropped(dropped);
reportFiles(results);
