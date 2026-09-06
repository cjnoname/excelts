/**
 * Auto-filters through XLSB: the range, and the criteria inside it.
 *
 * The *range* is one record. The **criteria** are a nested collection — `BrtBeginFilterColumn` with a value
 * list, a custom comparison, a top-N or a dynamic rule under it — and this library carries them through as
 * preserved XML rather than translating each kind, which is why the second row below reports whether the
 * criteria block came back at all rather than what it says.
 *
 * Run: pnpm example --filter xlsb-auto-filter
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildAutoFilter, sampleSheet } from "@excel/examples/utils/features";
import { Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
buildAutoFilter(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-auto-filter");

report("filter range", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(sheet!) as unknown as { autoFilter?: unknown };
  return model.autoFilter === undefined ? "none survived" : String(model.autoFilter);
});

report("criteria block", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(sheet!) as unknown as {
    autoFilterCriteria?: { readonly xml?: string };
  };
  const xml = model.autoFilterCriteria?.xml;
  return xml === undefined ? "no criteria (none were set)" : `${xml.length} bytes of criteria XML`;
});

reportDropped(dropped);
reportFiles(results);
