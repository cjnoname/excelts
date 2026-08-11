/**
 * `documonster/excel/csv` — Node entry.
 *
 * Re-exports the cross-platform CSV functions plus the Node-only file-path
 * variants (`readCsvFile` / `writeCsvFile`), and types `createCsvReadStream` as
 * the Node stream it actually returns.
 */

import type { Readable } from "node:stream";

import type { CsvOptions } from "@excel/bridge/csv-bridge";
import { createCsvByteStream } from "@excel/bridge/csv-bridge";
import type { Workbook } from "@excel/core/workbook.browser";
import type { IReadable } from "@stream/types";

export {
  readCsv,
  writeCsv,
  writeCsvBuffer,
  createCsvWriteStream,
  type CsvInput,
  type CsvOptions
} from "@excel/bridge/csv-bridge";
export { readCsvFile, writeCsvFile } from "@excel/bridge/csv-bridge.node";

/**
 * Create a readable stream that outputs the worksheet as CSV.
 *
 * Same stream as the cross-platform export, typed as the `stream.Readable` Node
 * actually returns, so it goes straight into `stream.pipeline()`,
 * `Readable.toWeb()`, or an SDK upload body — no `as unknown as Readable`.
 *
 * There is no type assertion here: on the Node build `CsvFormatterStream extends
 * Transform extends Readable`, so the compiler verifies the narrowing on the
 * return statement below. Intersecting with `Readable` rather than with the
 * concrete `CsvFormatterStream` is what keeps `write()` / `end()` off the public
 * surface — the stream is already attached to a producer, so a caller who wrote
 * to it would inject rows into the CSV.
 *
 * `IReadable<Uint8Array>` stays first in the intersection so `for await` keeps
 * yielding `Uint8Array` instead of the `any` Node's own declaration returns.
 */
export function createCsvReadStream(
  workbook: Workbook,
  options?: CsvOptions
): IReadable<Uint8Array> & Readable {
  return createCsvByteStream(workbook, options);
}
