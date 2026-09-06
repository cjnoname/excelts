/**
 * Data validation through XLSB: a list, a numeric range, and the header that frames them.
 *
 * `BrtBeginDVals` is **eighteen bytes**, not four: a flag word, two positions and `idvMac`. It was written as
 * four, so every validation record after it was read from the wrong offset and Excel discarded the collection.
 * A length is the one kind of mistake in this format that costs the whole part rather than one value.
 *
 * Run: pnpm example --filter xlsb-data-validation
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildDataValidation, sampleSheet } from "@excel/examples/utils/features";
import { Cell, Workbook } from "@excel/index";

const workbook = Workbook.create();
buildDataValidation(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-data-validation");

report("validations after a round trip", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const found = ["E2", "E3"]
    .map(address => {
      const validation = Cell.getValidation(sheet!, address) as
        | { readonly type?: string; readonly operator?: string }
        | undefined;
      return validation === undefined
        ? undefined
        : `${address}=${validation.type ?? "?"}${validation.operator ? `/${validation.operator}` : ""}`;
    })
    .filter((one): one is string => one !== undefined);
  return found.length === 0 ? "none survived" : found.join(", ");
});

// The messages are separate strings in the record and a rule can survive without them.
report("prompts and errors", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const list = Cell.getValidation(sheet!, "E2") as { readonly errorTitle?: string } | undefined;
  const range = Cell.getValidation(sheet!, "E3") as { readonly promptTitle?: string } | undefined;
  return `error="${list?.errorTitle ?? "—"}" prompt="${range?.promptTitle ?? "—"}"`;
});

reportDropped(dropped);
reportFiles(results);
