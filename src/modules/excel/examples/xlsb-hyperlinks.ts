/**
 * Hyperlinks through XLSB: an external target, an internal location, and an email.
 *
 * The three are stored differently. An external target is an **OPC relationship** and `BrtHLink` carries only
 * the relationship id; an internal one carries a location string and no relationship at all. So a writer that
 * allocates ids for all three produces a package with a dangling relationship, and one that allocates for none
 * produces links that go nowhere.
 *
 * `Cell.setValue(sheet, address, { text, hyperlink })` is the only way to set one — there is no link collection
 * on the worksheet model, and writing to one (as an earlier version of this did) sets a property nothing reads.
 *
 * Run: pnpm example --filter xlsb-hyperlinks
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildHyperlinks, sampleSheet } from "@excel/examples/utils/features";
import { Cell, Workbook } from "@excel/index";

const workbook = Workbook.create();
buildHyperlinks(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-hyperlinks");

report("targets after a round trip", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const found = ["E2", "E3", "E4"]
    .map(address => {
      const link = Cell.getHyperlink(sheet!, address);
      return link === undefined || link === null ? undefined : `${address}→${String(link)}`;
    })
    .filter((one): one is string => one !== undefined);
  return found.length === 0 ? "none survived" : found.join("  ");
});

// The visible text is a separate fact from the destination, and a link can keep one without the other.
report("visible text", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  return ["E2", "E3", "E4"].map(address => Cell.getText(sheet!, address) || "—").join(", ");
});

reportDropped(dropped);
reportFiles(results);
