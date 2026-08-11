/**
 * Workbook - Node.js entry point.
 *
 * Re-exports the platform-independent workbook surface (record + flat
 * functions) from `workbook.browser`, plus the Node xlsx IO (cross-platform
 * `read` / `toBuffer` / `readStream` / `writeStream` together with the
 * Node-only file-path `readFile` / `writeFile`) from `xlsx-io`. The
 * browser/Node split keeps Node-only `fs` and stream code out of browser
 * bundles.
 */

import type { WorkbookReaderOptions, WorkbookReaderInput } from "@excel/stream/workbook-reader";
import { WorkbookReader } from "@excel/stream/workbook-reader";
import type { WorkbookWriterOptions } from "@excel/stream/workbook-writer";
import { WorkbookWriter } from "@excel/stream/workbook-writer";

export * from "@excel/core/workbook.browser";

// Cross-platform + Node-only xlsx IO (read / readFile / writeFile / toBuffer /
// readStream / writeStream + getXlsxIo). Node binding via xlsx-io.ts.
export {
  toBuffer,
  toStream,
  read,
  readFile,
  writeFile,
  readStream,
  writeStream,
  getXlsxIo
} from "@excel/core/xlsx-io";
export type { XlsxReadable, XlsxWritable, XlsxStreamOptions } from "@excel/core/xlsx-io";

/**
 * Node streaming workbook writer factory (accepts `{ filename }`).
 *
 * Returns the Node `WorkbookWriter` it constructs — the same class the `Stream`
 * namespace exports on this entry, so callers can name the result
 * (`Stream.WorkbookWriter`). It used to be cast to the browser class, which left
 * the return type unnameable from `documonster/excel`.
 */
export function createStreamWriter(options?: WorkbookWriterOptions): WorkbookWriter {
  return new WorkbookWriter(options);
}

/** Node streaming workbook reader factory (accepts a file-path string). */
export function createStreamReader(
  input: WorkbookReaderInput,
  options?: WorkbookReaderOptions
): WorkbookReader {
  return new WorkbookReader(input, options);
}

export type { CsvOptions, CsvInput } from "@excel/bridge/csv-bridge";
export type {
  WorkbookModel,
  WorkbookMedia,
  WorkbookProtectionModel,
  ExternalLinkModel,
  ExternalLinkCachedSheet
} from "@excel/core/workbook.browser";
export type {
  AddChartsheetOptions,
  AddPivotChartsheetOptions,
  ChartsheetOptions,
  ChartsheetViewOptions
} from "@excel/core/chartsheet";
