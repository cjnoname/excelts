/**
 * The streaming writer, in both containers.
 *
 * `Stream.WorkbookWriter` writes as you go rather than at the end: rows are serialised and handed to the ZIP as
 * they are committed and never collected, so a workbook larger than memory can be written. `format: "xlsb"` gets
 * the same property in the binary container — see `stream/xlsb-writer.ts` for exactly what is bounded and what is
 * not, and for the one record (`BrtWsDim`, the used range) that a forward pass cannot write.
 *
 * The build runs once per container, which is what `streamBothFormats` does. A streamed workbook is not a value
 * that can be written twice, so the *description* is what gets reused.
 *
 * Run: pnpm example --filter streaming-writer
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { streamBothFormats } from "@excel/examples/utils/stream-both";
import { Stream } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);
const filename = process.argv[2] ?? path.join(outDir, "streaming-writer.xlsx");

const style = {
  font: { name: "Comic Sans MS", underline: true, bold: true, size: 16 },
  alignment: { vertical: "middle" as const, horizontal: "center" as const }
};

await streamBothFormats(filename, { useStyles: true }, writer => {
  const ws = writer.addWorksheet("blort");
  ws.columns = [
    { header: "A1", width: 10 },
    { header: "B1", width: 20, style },
    { header: "C1", width: 30 }
  ];

  Stream.setRowFont(ws.getRow(2), {
    name: "Broadway",
    color: { argb: "FFFF0000" },
    outline: true,
    size: 20
  });

  for (const row of [2, 3]) {
    for (const column of ["A", "B", "C"]) {
      Stream.setCellValue(ws.getCell(`${column}${row}`), `${column}${row}`);
    }
  }
  // Committing the sheet is the caller's job: it is what says "no more rows", and it is when the trailing records
  // — merges, panes, page setup — are written. The workbook commit is `streamBothFormats`'s.
  ws.commit();
});

console.log("Done");
