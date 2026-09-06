import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Workbook } from "@excel/index";

/**
 * Template Example — read an existing workbook and re-save it.
 *
 * Reads a bundled fixture, then writes a fresh copy with shared strings and
 * styles enabled.
 *
 * Output:
 *   tmp/excel-examples/template-out.xlsx
 *
 * Usage:
 *   pnpm example --filter template
 */
const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });

const inputFile = path.join(exampleDir, "data/table.xlsx");
const outputFile = path.join(outDir, "template-out.xlsx");

const workbook = Workbook.create();
Workbook.getXlsxIo(workbook)
  .readFile(inputFile)
  .then(stream => {
    const options = {
      useSharedStrings: true,
      useStyles: true
    };

    // **XLSX only, and not an oversight.** This goes through `Workbook.getXlsxIo`, the streaming XLSX
    // reader/writer pair, and the streaming writer has no binary form — `Stream.WorkbookWriter` produces XLSX
    // and nothing else. Every other example in this directory now writes both containers; the seven streaming
    // ones cannot until that writer gains an XLSB path, which is a capability gap rather than an example gap.
    return Workbook.writeFile(stream, outputFile, options).then(() => {
      console.log(`Done. Wrote ${outputFile}`);
    });
  })
  .catch(error => {
    console.error(error.message);
    console.error(error.stack);
  });
