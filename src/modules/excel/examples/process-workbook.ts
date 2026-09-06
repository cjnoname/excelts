import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Workbook, Worksheet } from "@excel/index";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");

fs.mkdirSync(outDir, { recursive: true });

const inputFile = process.argv[2] ?? path.join(exampleDir, "data/test.xlsx");
const outputFile = process.argv[3] ?? path.join(outDir, "process-workbook-out.xlsx");

const wb = Workbook.create();

let passed = true;
function assert(value, failMessage, passMessage) {
  if (!value) {
    if (failMessage) {
      console.error(failMessage);
    }
    passed = false;
  } else if (passMessage) {
    console.log(passMessage);
  }
}

// assuming file created by testBookOut
Workbook.getXlsxIo(wb)
  .readFile(inputFile)
  .then(() => {
    console.log("Loaded", inputFile);

    Workbook.eachSheet(wb, sheet => {
      console.log(Worksheet.getName(sheet));
    });

    const ws = Workbook.getWorksheets(wb)[0]!;

    assert(ws, "Expected to find a worksheet called sheet1", "");

    Cell.setValue(ws!, "B1", new Date());
    Cell.setStyle(ws!, "B1", { numFmt: "hh:mm:ss" });

    Worksheet.addRow(ws!, [1, "hello"]);
    return writeBothFormats(wb, outputFile);
  })
  .then(() => {
    assert(passed, "Something went wrong", "All tests passed!");
  })
  .catch(error => {
    console.error(error.message);
    console.error(error.stack);
  });
