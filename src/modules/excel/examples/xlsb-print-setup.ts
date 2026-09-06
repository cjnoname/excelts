/**
 * Print setup through XLSB: orientation, paper, scaling, the print area and repeated titles.
 *
 * `BrtPageSetup`'s flag word cost two defects at once. The bit this writer called `orientationSet` is actually
 * `fUsePage` — whether `iPageStart` is meaningful — and the real orientation bit is `fNoOrient`, whose polarity
 * is the *opposite* of the name it was given. So a landscape sheet came out portrait while a first-page number
 * silently went missing.
 *
 * Run: pnpm example --filter xlsb-print-setup
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { sampleSheet } from "@excel/examples/utils/features";
import { PaperSize, Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
const sheet = sampleSheet(workbook);

sheet.pageSetup.orientation = "landscape";
sheet.pageSetup.paperSize = PaperSize.A4;
sheet.pageSetup.scale = 90;
sheet.pageSetup.printArea = "A1:C4";
sheet.pageSetup.printTitlesRow = "1:1";
sheet.pageSetup.firstPageNumber = 7;
sheet.pageSetup.horizontalCentered = true;

const { results, dropped } = await writeBoth(workbook, "xlsb-print-setup");

report("page setup", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const setup = Worksheet.getModel(target!).pageSetup as unknown as {
    readonly orientation?: string;
    readonly paperSize?: number;
    readonly scale?: number;
    readonly horizontalCentered?: boolean;
  };
  return `${setup.orientation ?? "—"} paper=${setup.paperSize ?? "—"} scale=${setup.scale ?? "—"} centred=${setup.horizontalCentered === true}`;
});

// **The first page number is only meaningful when `fUsePage` is set**, which is the bit that was being used for
// orientation. A reader that ignores the flag reports a stale number; one that honours it reports none.
report("first page number", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const setup = Worksheet.getModel(target!).pageSetup as unknown as {
    readonly firstPageNumber?: number;
  };
  return setup.firstPageNumber === undefined ? "not set" : String(setup.firstPageNumber);
});

report("print area and repeated titles", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const setup = Worksheet.getModel(target!).pageSetup as unknown as {
    readonly printArea?: string;
    readonly printTitlesRow?: string;
  };
  return `area=${setup.printArea ?? "—"} titles=${setup.printTitlesRow ?? "—"}`;
});

reportDropped(dropped);
reportFiles(results);
