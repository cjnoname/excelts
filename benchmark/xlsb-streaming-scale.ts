/**
 * Ten million cells, in both containers.
 *
 * This is the example the streaming writer exists for. Five hundred thousand rows of twenty columns will not fit
 * in a `Workbook` — the model alone is several gigabytes — so `Stream.WorkbookWriter` serialises each row as it is
 * committed and hands it to the ZIP. Nothing keeps it.
 *
 * **`format: "xlsb"` costs the same as `"xlsx"`, and that is the measured claim** — not that either is flat.
 * Forcing collection every hundred thousand rows gives a live heap of 103 / 146 / 191 MB for the binary container
 * and 103 / 147 / 192 MB for the XML one: identical, so the binary path adds nothing of its own. Both grow by
 * roughly 450 bytes per row, and the reason is the API rather than either writer: `Stream.commitRow` is
 * synchronous, so a producer in a tight loop outruns the disk and the difference queues in the output stream.
 * A caller who needs that flat awaits a drain between batches.
 *
 * The peak RSS printed below is therefore a figure to compare *between containers*, not one to read as the
 * writer's working set.
 *
 * **The cells are numbers, and that is not incidental.** One thing is genuinely unbounded in the binary container
 * and bounded in the XML one: *distinct strings*. `BrtCellIsst` reaches a string through the shared-string table,
 * so ten million distinct strings mean ten million table entries — while XLSX with `useSharedStrings: false`
 * writes each inline and keeps nothing. This example asked for random strings at first and the XLSB run died of
 * it, which is the honest way to have found out.
 *
 * XLSB does define an inline-string cell (`BrtCellSt`), and it is not used here: Excel writes it in none of the
 * corpus's files, so emitting it would be inventing behaviour rather than matching it. The limitation is real,
 * documented in `stream/xlsb-writer.ts`, and stated here rather than hidden behind a workload chosen to avoid it.
 *
 * **This lives in `benchmark/`, and it was in `examples/` — which made two gates run it.**
 *
 * The example runner discovers every `.ts` under `examples/`, so `verify:examples` produced a 99 MB `.xlsb` and a 145 MB
 * `.xlsx` on every run, and `verify:libreoffice` then converted both. Neither is checking a public contract by doing so:
 * the file measures the streaming writer's memory shape against the platform's, which is what `benchmark/` is for, and
 * AGENTS.md says so directly — "a benchmark is not an example".
 *
 * Nothing about the measurement changed in the move.
 *
 * Run: pnpm benchmark:xlsb-scale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Stream } from "@excel/index";

const ROW_COUNT = 500_000;
const COL_COUNT = 20;

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  // `benchmark/` is one level under the root, and this used to be four levels down in `examples/`.
  "../tmp/xlsb-benchmark"
);
fs.mkdirSync(outDir, { recursive: true });

const keys = Array.from({ length: COL_COUNT }, (_unused, index) => `col${index}`);

for (const format of ["xlsx", "xlsb"] as const) {
  const target = path.join(outDir, `xlsb-streaming-scale.${format}`);
  const started = process.hrtime.bigint();
  let peak = 0;

  const book = new Stream.WorkbookWriter({
    filename: target,
    format,
    useStyles: false,
    useSharedStrings: false,
    zip: { zlib: { level: 1 } }
  });

  const sheet = book.addWorksheet("data");
  Stream.commitRow(sheet.addRow(keys));

  for (let index = 0; index < ROW_COUNT; index++) {
    // Numbers, so both containers are bounded — see the note above.
    Stream.commitRow(sheet.addRow(keys.map(() => Math.random() * 1000)));
    if ((index + 1) % 100_000 === 0) {
      peak = Math.max(peak, process.memoryUsage().rss);
    }
  }

  sheet.commit();
  await book.commit();

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const megabytes = (value: number): string => (value / 1024 / 1024).toFixed(0);
  console.log(
    `  ${format}  ${ROW_COUNT * COL_COUNT} cells  ${seconds.toFixed(1)}s  ` +
      `${megabytes(fs.statSync(target).size)} MB file  peak RSS ${megabytes(peak)} MB  ${target}`
  );
}
