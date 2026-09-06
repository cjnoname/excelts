/**
 * Conditional formatting through XLSB: colour scales, data bars and icon sets.
 *
 * All three were at one point **written but not implemented** — `BrtBeginCFRule` was emitted with the rule type
 * set and none of the child records a graphical rule needs, so Excel opened the workbook and showed no
 * formatting. They are built together here for the same reason: they share the rule record and differ only in
 * what hangs off it, which is how two of them stayed missing while the third looked like coverage.
 *
 * The comparison against XLSX is the point. A rule that survives an XLSB round trip but differs from what the
 * XML container preserves is a rule this library reads back through its own assumptions.
 *
 * Run: pnpm example --filter xlsb-conditional-formatting
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildConditionalFormatting, sampleSheet } from "@excel/examples/utils/features";
import { Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
buildConditionalFormatting(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-conditional-formatting");

/** The rule kinds a reloaded workbook still has, in the order they were added. */
function kinds(reloaded: Workbook.Handle): string {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const blocks =
    (
      Worksheet.getModel(sheet!) as unknown as {
        conditionalFormattings?: readonly {
          readonly rules?: readonly { readonly type?: string }[];
        }[];
      }
    ).conditionalFormattings ?? [];
  const found = blocks.flatMap(block => (block.rules ?? []).map(rule => rule.type ?? "?"));
  return found.length === 0 ? "none survived" : found.sort().join(", ");
}

report("rule kinds after a round trip", results, kinds);

// The graphical rules carry more than a type: a colour scale has two bounds and two colours, and a rule that
// came back without them would still pass the check above.
report("colour-scale bounds", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const blocks =
    (
      Worksheet.getModel(sheet!) as unknown as {
        conditionalFormattings?: readonly {
          readonly rules?: readonly {
            readonly type?: string;
            readonly cfvo?: readonly { readonly type?: string }[];
          }[];
        }[];
      }
    ).conditionalFormattings ?? [];
  const scale = blocks.flatMap(block => block.rules ?? []).find(rule => rule.type === "colorScale");
  return scale === undefined
    ? "no colour scale"
    : `${(scale.cfvo ?? []).map(bound => bound.type ?? "?").join(" → ")}`;
});

reportDropped(dropped);
reportFiles(results);
