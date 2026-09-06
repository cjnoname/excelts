import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBothFormats } from "@excel/examples/utils/write-both";
import { Cell, Workbook } from "@excel/index";

const inputFile = fileURLToPath(new URL("./data/comments.xlsx", import.meta.url));
const outDir = path.resolve(path.dirname(inputFile), "../../../../../tmp/excel-examples");
fs.mkdirSync(outDir, { recursive: true });
const outputFile = path.join(outDir, "comments-out.xlsx");

const wb = Workbook.create();

Workbook.getXlsxIo(wb)
  .readFile(inputFile)
  .then(() => {
    Workbook.getWorksheets(wb).forEach(sheet => {
      console.info(Cell.getModel(sheet, "A1"));
      Cell.setValue(sheet, "B2", "Zeb");
      Cell.setComment(sheet, "B2", {
        texts: [
          {
            font: {
              size: 12,
              color: { theme: 0 },
              name: "Calibri",
              family: 2,
              scheme: "minor"
            },
            text: "This is "
          },
          {
            font: {
              italic: true,
              size: 12,
              color: { theme: 0 },
              name: "Calibri",
              scheme: "minor"
            },
            text: "a"
          },
          {
            font: {
              size: 12,
              color: { theme: 1 },
              name: "Calibri",
              family: 2,
              scheme: "minor"
            },
            text: " "
          },
          {
            font: {
              size: 12,
              color: { argb: "FFFF6600" },
              name: "Calibri",
              scheme: "minor"
            },
            text: "colorful"
          },
          {
            font: {
              size: 12,
              color: { theme: 1 },
              name: "Calibri",
              family: 2,
              scheme: "minor"
            },
            text: " text "
          },
          {
            font: {
              size: 12,
              color: { argb: "FFCCFFCC" },
              name: "Calibri",
              scheme: "minor"
            },
            text: "with"
          },
          {
            font: {
              size: 12,
              color: { theme: 1 },
              name: "Calibri",
              family: 2,
              scheme: "minor"
            },
            text: " in-cell "
          },
          {
            font: {
              bold: true,
              size: 12,
              color: { theme: 1 },
              name: "Calibri",
              family: 2,
              scheme: "minor"
            },
            text: "format"
          }
        ]
      });
    });

    return writeBothFormats(wb, outputFile);
  })
  .then(() => {
    console.log("Wrote", outputFile);
  })
  .catch(console.error);
