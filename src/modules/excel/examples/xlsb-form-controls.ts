/**
 * Form Control checkboxes through XLSB.
 *
 * A legacy checkbox is **not** a binary record. It is an `xl/ctrlProps/ctrlPropN.xml` describing the control, a
 * VML shape that draws it, and a drawing the sheet points at — all XML, in both containers. So XLSB's only job
 * is to carry the parts and name them, and the failure mode is the same one tables had: parts that are present,
 * correct and referred to by nothing.
 *
 * The VML matters for a second reason. Its content type used to be derived from "does this sheet have
 * comments?", so a sheet whose only VML came from a form control produced a package with an undeclared part —
 * which Excel refuses to open at all.
 *
 * Run: pnpm example --filter xlsb-form-controls
 */

import { report, reportDropped, reportFiles, writeBoth } from "@excel/examples/utils/both-formats";
import { buildFormControls, sampleSheet } from "@excel/examples/utils/features";
import { Form, Workbook } from "@excel/index";

const workbook = Workbook.create();
buildFormControls(sampleSheet(workbook));

const { results, dropped } = await writeBoth(workbook, "xlsb-form-controls");

report("the parts a checkbox needs", results, (_reloaded, written) => {
  const ctrlProps = written.parts.filter(name => name.includes("ctrlProps/")).length;
  const vml = written.parts.filter(name => name.endsWith(".vml")).length;
  return `${ctrlProps} ctrlProp(s), ${vml} VML drawing(s)`;
});

report("checkboxes the model reports", results, reloaded => {
  const sheet = Workbook.getWorksheet(reloaded, "Data");
  const found = Form.listCheckboxes(sheet!).length;
  // **Zero in both containers, and that is the honest answer.** The parts survive as preserved bytes and neither
  // reader puts the control back into the model, so a caller cannot inspect or toggle it after a round trip.
  // This is not an XLSB limitation — it is the same in XLSX, which is why the two columns agree.
  return found === 0 ? "0 — preserved as parts, modelled by neither container" : String(found);
});

reportDropped(dropped);
reportFiles(results);
