/**
 * Sparklines through XLSB, and why a sparkline needs a colour to exist at all.
 *
 * Two things had to be true before this example could say anything. The records are **future records**, wrapped
 * in `BrtFRTBegin`/`BrtFRTEnd` — this writer emitted them outside the wrapper and its reader skipped wrapper
 * contents, so the pair agreed with each other and with nothing else. And a group with no `<x14:colorSeries>`
 * is one Excel *loads* and does not paint: selecting the cell highlights the source range, and the chart is
 * blank. `Sparkline.add` without a colour is the documented call, so the documented call drew nothing.
 *
 * Both groups below are therefore worth watching: the first takes the substituted default and the second states
 * its own colour, which is the pair that caught a field-name mismatch dropping every stated colour in XLSB.
 *
 * Run: pnpm example --filter xlsb-sparklines
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildSparklines, sampleSheet } from "@excel/examples/utils/features";
import { Sparkline, Workbook } from "@excel/index";

const workbook = Workbook.create();
buildSparklines(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-sparklines");

report("groups after a round trip", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const groups = Sparkline.list(sheet!) as readonly {
    readonly type?: string;
    readonly sparklines?: readonly unknown[];
  }[];
  return groups.length === 0
    ? "none survived"
    : groups.map(group => `${group.type ?? "line"}×${group.sparklines?.length ?? 0}`).join(", ");
});

report("series colours", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const groups = Sparkline.list(sheet!) as readonly {
    readonly colorSeries?: { readonly rgb?: string; readonly theme?: number };
  }[];
  return groups.length === 0
    ? "none"
    : groups
        .map(group => group.colorSeries?.rgb ?? `theme ${group.colorSeries?.theme ?? "—"}`)
        .join(", ");
});

report("the cells they draw in", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const groups = Sparkline.list(sheet!) as readonly {
    readonly sparklines?: readonly { readonly cellRef?: string; readonly dataRef?: string }[];
  }[];
  const cells = groups.flatMap(group =>
    (group.sparklines ?? []).map(one => `${one.cellRef ?? "?"}←${one.dataRef ?? "?"}`)
  );
  return cells.length === 0 ? "none" : cells.join(", ");
});

reportDropped(dropped);
reportFiles(results);
