/**
 * The same workbook at three compression levels, in both containers.
 *
 * `zip.zlib.level` is passed straight to the DEFLATE encoder, so it trades time against size and nothing else —
 * the parts inside are byte for byte the same at every level. Six files come out of this, and putting the sizes
 * beside each other is the point: it shows what the level actually buys, per container.
 *
 * The binary container starts smaller — numbers are eight bytes rather than their decimal text, and a record
 * header is two bytes rather than a tag — so it has less redundancy left for DEFLATE to find. Expect the *ratio*
 * between levels to be narrower for `xlsb` than for `xlsx`, which is the interesting part rather than a defect.
 *
 * Run: pnpm example --filter streaming-writer-compression-options
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { streamBothFormats } from "@excel/examples/utils/stream-both";
import { Stream } from "@excel/index";

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tmp/excel-examples"
);

const style = {
  font: { name: "Comic Sans MS", underline: true, bold: true, size: 16 },
  alignment: { vertical: "middle" as const, horizontal: "center" as const }
};

/** The same content every time, so the only variable is the level. */
function build(wb: Stream.WorkbookWriter): void {
  const ws = wb.addWorksheet("blort");
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
  // Enough rows for the level to make a measurable difference; three cells would compress to the same size at
  // every setting and the example would demonstrate nothing.
  for (let row = 2; row <= 400; row++) {
    for (const column of ["A", "B", "C"]) {
      Stream.setCellValue(ws.getCell(`${column}${row}`), `${column}${row}`);
    }
  }
  ws.commit();
}

const levels: readonly { readonly name: string; readonly level: 9 | 1 | undefined }[] = [
  { name: "best", level: 9 },
  { name: "speed", level: 1 },
  { name: "default", level: undefined }
];

const sizes: Record<string, Record<string, number>> = {};

for (const { name, level } of levels) {
  const written = await streamBothFormats(
    path.join(outDir, `streaming-writer-compression-${name}.xlsx`),
    { useStyles: true, ...(level === undefined ? {} : { zip: { zlib: { level } } }) },
    build
  );
  sizes[name] = {
    xlsx: fs.statSync(written.xlsx).size,
    xlsb: fs.statSync(written.xlsb).size
  };
}

console.log("\n  level      xlsx      xlsb");
for (const { name } of levels) {
  console.log(
    `  ${name.padEnd(8)} ${String(sizes[name].xlsx).padStart(8)}  ${String(sizes[name].xlsb).padStart(8)}`
  );
}
