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

import type { WorkbookReaderOptions, NodeInput } from "@excel/stream/workbook-reader";
import { WorkbookReader } from "@excel/stream/workbook-reader";
import type { WorkbookReader as WorkbookReaderBrowser } from "@excel/stream/workbook-reader.browser";
import type { WorkbookWriterOptions } from "@excel/stream/workbook-writer";
import { WorkbookWriter } from "@excel/stream/workbook-writer";
import type { WorkbookWriter as WorkbookWriterBrowser } from "@excel/stream/workbook-writer.browser";

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

/** Node streaming workbook writer factory (accepts `{ filename }`). */
export function createStreamWriter(options?: WorkbookWriterOptions): WorkbookWriterBrowser {
  return new WorkbookWriter(options) as unknown as WorkbookWriterBrowser;
}

/** Node streaming workbook reader factory (accepts a file-path string). */
export function createStreamReader(
  input: NodeInput,
  options?: WorkbookReaderOptions
): WorkbookReaderBrowser {
  return new WorkbookReader(input, options) as unknown as WorkbookReaderBrowser;
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
