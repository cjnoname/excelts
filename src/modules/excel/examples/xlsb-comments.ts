/**
 * Comments and notes through XLSB, and the record that makes them visible.
 *
 * The comment text lives in `comments{N}.bin` and the *box* that displays it lives in a VML drawing the sheet
 * points at with `BrtLegacyDrawing`. Without that record Excel opens a workbook whose comment part is present
 * and correct and shows nothing — so the interesting question is not whether the text survived but whether the
 * sheet still refers to the drawing.
 *
 * Run: pnpm example --filter xlsb-comments
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildComments, sampleSheet } from "@excel/examples/utils/features";
import { Cell, Workbook } from "@excel/index";

const workbook = Workbook.create();
buildComments(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-comments");

/**
 * The text out of whatever `getComment`/`getNote` hand back.
 *
 * `Cell.getComment` returns `{ note: … }` and the `note` is either a plain string or a run list — reading
 * `.texts` off the *wrapper* yields nothing, which is how the first version of this reported an empty comment
 * for one that was intact. Both shapes are handled because both are produced.
 */
function textOf(value: unknown): string | undefined {
  const inner = (value as { readonly note?: unknown } | undefined)?.note ?? value;
  if (inner === undefined || inner === null) {
    return undefined;
  }
  if (typeof inner === "string") {
    return inner;
  }
  const runs = (inner as { readonly texts?: readonly { readonly text?: string }[] }).texts;
  return runs === undefined ? undefined : runs.map(run => run.text ?? "").join("");
}

report("comment text", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  return textOf(Cell.getComment(sheet!, "B2")) ?? "no comment";
});

report("note text", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  return textOf(Cell.getNote(sheet!, "B3")) ?? "no note";
});

reportDropped(dropped);
reportFiles(results);
