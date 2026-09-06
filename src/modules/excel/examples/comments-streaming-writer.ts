/**
 * Rich-text and plain comments through the streaming writer, in both containers.
 *
 * A comment is not a cell: it lands in its own part plus a VML drawing, both written by `SheetCommentsWriter` as
 * the sheet commits. Those parts are XML in both containers, so `format: "xlsb"` changes only how the sheet names
 * them — which is why comments were the first non-cell feature to work on the streamed binary path.
 *
 * Run: pnpm example --filter comments-streaming-writer
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { streamBothFormats } from "@excel/examples/utils/stream-both";
import { Stream } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
const filename = process.argv[2] ?? path.join(outDir, "comments-streaming-writer.xlsx");

const stopwatch = new HrStopwatch();
stopwatch.start();

await streamBothFormats(filename, {}, wb => {
  const ws = wb.addWorksheet("Foo");
  Stream.setCellValue(ws.getCell("B2"), 5);
  Stream.setCellNote(ws.getCell("B2"), {
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

  Stream.setCellValue(ws.getCell("D2"), "Zoo");
  Stream.setCellNote(ws.getCell("D2"), "Plain Text Comment");

  ws.commit();
});

console.log(`Done in ${stopwatch.microseconds} microseconds`);
