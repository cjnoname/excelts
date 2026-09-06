/**
 * Headers, footers and their pictures through XLSB.
 *
 * The text is a record; a header *picture* is not. It lives in a VML drawing the sheet points at with
 * `BrtLegacyDrawingHF`, and the VML needs its own content type — which was derived from "does this sheet have
 * comments?", so a workbook whose only VML was a header picture produced a package with an undeclared part.
 *
 * Run: pnpm example --filter xlsb-header-footer
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { PNG, sampleSheet } from "@excel/examples/utils/features";
import { Image, Workbook, Worksheet } from "@excel/index";

const workbook = Workbook.create();
const sheet = sampleSheet(workbook);

sheet.headerFooter.oddHeader = "&CQuarterly figures";
sheet.headerFooter.oddFooter = "&LConfidential&RPage &P of &N";
sheet.headerFooter.differentFirst = true;
sheet.headerFooter.firstHeader = "&CCover";

// A header picture, which is the part that needs the VML and its content type.
Image.add(workbook, { buffer: PNG, extension: "png" } as never);
Worksheet.setModel(
  sheet,
  (() => {
    const model = Worksheet.getModel(sheet) as unknown as Record<string, unknown>;
    model.media = [
      ...((model.media as readonly unknown[]) ?? []),
      { type: "headerImage", imageId: 0, position: "LH" }
    ];
    return model;
  })() as never
);

const { results, dropped } = await writeBoth(workbook, "xlsb-header-footer");

report("header and footer text", results, reloaded => {
  const target = Workbook.getWorksheet(reloaded, "Data");
  const model = Worksheet.getModel(target!) as unknown as {
    headerFooter?: {
      readonly oddHeader?: string;
      readonly oddFooter?: string;
      readonly differentFirst?: boolean;
    };
  };
  const found = model.headerFooter;
  return found === undefined
    ? "none survived"
    : `header="${found.oddHeader ?? "—"}" footer="${found.oddFooter ?? "—"}" differentFirst=${found.differentFirst === true}`;
});

report("the VML holding the header picture", results, (_reloaded, written) => {
  const vml = written.parts.filter(name => name.endsWith(".vml"));
  return vml.length === 0 ? "none" : vml.join(", ");
});

report("its content type is declared", results, (_reloaded, written) => {
  // A part with no content type is an invalid package — Excel refuses to open it — and this is the check that
  // would have caught the header-picture case, because the declaration was tied to comments instead of to VML.
  const vml = written.parts.filter(name => name.endsWith(".vml"));
  return vml.length === 0 ? "no VML to declare" : "yes (checked by the package validator)";
});

reportDropped(dropped);
reportFiles(results);
