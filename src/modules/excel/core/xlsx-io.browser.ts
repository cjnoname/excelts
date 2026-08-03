/**
 * Browser xlsx IO handle accessor and the canonical public IO surface.
 *
 * Kept out of `workbook.browser` so the heavy `XLSX` serializer is not a static
 * dependency of the workbook record module (which would create a
 * workbook ↔ xlsx import cycle). Selected over `xlsx-io.ts` (Node) via the
 * `.browser` same-name swap at build/test time.
 */
import type { WorkbookData } from "@excel/core/workbook-core";
import type {
  XlsxReadOptions,
  XlsxWriteOptions,
  IParseStream,
  IWritableStream
} from "@excel/xlsx/xlsx.browser";
import { XLSX } from "@excel/xlsx/xlsx.browser";

/** Get (or lazily create) the xlsx IO handle bound to a workbook. */
export function getXlsxIo(wb: WorkbookData): XLSX {
  if (!wb._xlsx) {
    wb._xlsx = new XLSX(wb);
  }
  return wb._xlsx;
}

// =============================================================================
// Cross-platform flat IO functions (the canonical public surface).
// =============================================================================

/** Serialize a workbook to xlsx bytes. */
export function toBuffer(wb: WorkbookData, options?: XlsxWriteOptions): Promise<Uint8Array> {
  return getXlsxIo(wb).writeBuffer(options);
}

/** Read xlsx bytes into a workbook (mutates and returns `wb`). */
export function read(
  wb: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options?: XlsxReadOptions
): Promise<WorkbookData> {
  return getXlsxIo(wb).load(data, options);
}

/** Read a workbook from a parse stream (mutates and returns `wb`). */
export function readStream(
  wb: WorkbookData,
  stream: IParseStream,
  options?: XlsxReadOptions
): Promise<WorkbookData> {
  return getXlsxIo(wb).read(stream, options);
}

/**
 * Write a workbook to a writable stream.
 *
 * Respects downstream backpressure, so the sink must already be consumed
 * before this call. Passing an unconsumed intermediate stream (e.g. a bare
 * `PassThrough`) deadlocks once its buffers fill — start the consumer first,
 * or use {@link toBuffer}. See `XLSX.write` for the full explanation.
 */
export function writeStream(
  wb: WorkbookData,
  stream: IWritableStream,
  options?: XlsxWriteOptions
): Promise<unknown> {
  return getXlsxIo(wb).write(stream, options);
}
