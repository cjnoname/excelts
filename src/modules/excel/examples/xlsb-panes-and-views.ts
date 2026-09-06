/**
 * Frozen panes through XLSB — three records that have to agree with each other.
 *
 * `BrtPane`'s two split values are **columns first, then rows**, which is the opposite of the order the
 * specification's field list implies; and its flags carry `fFrozen` *and* `fFrozenNoSplit` together, which the
 * same specification says are mutually exclusive. Excel writes both. Then every pane the split creates needs its
 * own `BrtSel`, all of them anchored at A1 — a frozen row makes two panes, a frozen row *and* column make four,
 * and writing one selection for four panes loses the active cell.
 *
 * Run: pnpm example --filter xlsb-panes-and-views
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildFrozenPane, sampleSheet } from "@excel/examples/utils/features";
import { Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
buildFrozenPane(sampleSheet(workbook));

// A second sheet frozen on rows only, because that is a two-pane split rather than a four-pane one.
const rowsOnly = sampleSheet(workbook, "RowsOnly");
const rowsOnlyModel = Worksheet.getModel(rowsOnly) as unknown as Record<string, unknown>;
rowsOnlyModel.views = [{ state: "frozen", xSplit: 0, ySplit: 1, topLeftCell: "A2" }];
Worksheet.setModel(rowsOnly, rowsOnlyModel as never);

const { results, dropped } = await writeBoth(workbook, "xlsb-panes-and-views");

function paneOf(reloaded: Workbook.Handle, name: string): string {
  const sheet = Workbook.getWorksheet(reloaded, name);
  const views =
    (
      Worksheet.getModel(sheet!) as unknown as {
        views?: readonly {
          readonly state?: string;
          readonly xSplit?: number;
          readonly ySplit?: number;
          readonly topLeftCell?: string;
        }[];
      }
    ).views ?? [];
  const view = views[0];
  return view === undefined
    ? "no view"
    : `${view.state ?? "normal"} x=${view.xSplit ?? 0} y=${view.ySplit ?? 0} topLeft=${view.topLeftCell ?? "—"}`;
}

report("frozen on both axes", results, reloaded => paneOf(reloaded, "Data"));
report("frozen on rows only", results, reloaded => paneOf(reloaded, "RowsOnly"));

reportDropped(dropped);
reportFiles(results);
