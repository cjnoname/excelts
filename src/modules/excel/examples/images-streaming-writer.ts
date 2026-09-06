/**
 * A background image through the streaming writer, in both containers.
 *
 * Media is the one part a streamed workbook still writes whole: an image is bytes, not rows, and the sheet only
 * names the relationship that reaches it. So this works identically for `xlsx` and `xlsb` — the drawing and the
 * media are XML and bytes in both, and only the sheet's reference to them is binary in one.
 *
 * Run: pnpm example --filter images-streaming-writer
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HrStopwatch } from "@excel/examples/utils/hr-stopwatch";
import { streamBothFormats } from "@excel/examples/utils/stream-both";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(exampleDir, "../../../../tmp/excel-examples");
const filename = process.argv[2] ?? path.join(outDir, "images-streaming-writer.xlsx");

const stopwatch = new HrStopwatch();
stopwatch.start();

await streamBothFormats(filename, {}, wb => {
  const imageId = wb.addImage({
    filename: path.join(exampleDir, "data/image2.png"),
    extension: "png"
  });
  const ws = wb.addWorksheet("Foo");
  ws.addBackgroundImage(imageId);
  ws.commit();
});

console.log(`Done in ${stopwatch.microseconds} microseconds`);
