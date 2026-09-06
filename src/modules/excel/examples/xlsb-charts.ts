/**
 * Charts through XLSB — an XML part in a binary container.
 *
 * A chart is **not** BIFF12. The chart part is the same XML an XLSX carries, and the only binary record involved
 * is a `BrtDrawing` naming the relationship that reaches it. So the interesting failure is not a malformed
 * chart but a chart nothing points at: omitting that one record produces a package that passes every
 * structural check and opens in Excel with no chart.
 *
 * Note what the round trip shows: the chart *part* survives as preserved bytes while the model does not carry
 * it back, so `Chart.get` finds nothing on the reloaded sheet. That is a real limitation and it is visible here
 * rather than asserted away.
 *
 * Run: pnpm example --filter xlsb-charts
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { sampleSheet } from "@excel/examples/utils/features";
import { Chart, Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
const sheet = sampleSheet(workbook);

Chart.addColumn(
  sheet as never,
  {
    title: "Units by region",
    series: [{ name: "Units", categories: "Data!$A$2:$A$4", values: "Data!$B$2:$B$4" }]
  } as never,
  { tl: { col: 4, row: 1 }, br: { col: 10, row: 12 } } as never
);

const { results, dropped } = await writeBoth(workbook, "xlsb-charts");

report("charts the model reports", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(target!) as unknown as { charts?: readonly unknown[] };
  const count = model.charts?.length ?? 0;
  // Zero is the honest answer for XLSB today: the drawing is kept as opaque bytes, so the picture is in the
  // file and the model cannot see it. The XLSX column is what a modelled chart looks like.
  return count === 0 ? "0 — preserved as opaque bytes, not modelled" : String(count);
});

report("the sheet still points at a drawing", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(target!) as unknown as {
    drawing?: unknown;
    xlsbDrawingRelationshipId?: string;
  };
  const reference =
    model.xlsbDrawingRelationshipId ?? (model.drawing === undefined ? undefined : "drawing");
  return reference === undefined ? "no — the chart would be invisible" : `yes (${reference})`;
});

reportDropped(dropped);
reportFiles(results);
