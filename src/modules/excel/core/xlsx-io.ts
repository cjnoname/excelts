/**
 * Node xlsx IO handle accessor and the canonical public IO surface (Node).
 *
 * Same shape as `xlsx-io.browser.ts`, but binds the Node `XLSX` serializer
 * (which adds file-path `readFile` / `writeFile` and true-streaming `read`)
 * and layers the Node-only file-path free functions on top. Selected over the
 * browser variant via the `.browser` same-name swap at build/test time.
 */
import type { WorkbookData } from "@excel/core/workbook-core";
import { XLSX } from "@excel/xlsx/xlsx";
import type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";

/** Get (or lazily create) the Node xlsx IO handle bound to a workbook. */
export function getXlsxIo(wb: WorkbookData): XLSX {
  const slot = wb as WorkbookData & { _xlsxNode?: XLSX };
  if (!slot._xlsxNode) {
    slot._xlsxNode = new XLSX(wb);
  }
  return slot._xlsxNode;
}

// =============================================================================
// Cross-platform flat IO functions (canonical public surface, Node binding).
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
  stream: unknown,
  options?: XlsxReadOptions
): Promise<WorkbookData> {
  return getXlsxIo(wb).read(stream as never, options);
}

/**
 * Write a workbook to a writable stream.
 *
 * Respects downstream backpressure, so the sink must already be consumed
 * before this call. Passing an unconsumed `stream.PassThrough` deadlocks once
 * its buffers fill (~128 KB of output on Node 22+) — start the consumer first,
 * or use {@link toBuffer}. See `XLSX.write` for the full explanation.
 */
export function writeStream(
  wb: WorkbookData,
  stream: unknown,
  options?: XlsxWriteOptions
): Promise<unknown> {
  return getXlsxIo(wb).write(stream as never, options);
}

// =============================================================================
// Node-only xlsx file-path IO.
// =============================================================================

/** Node-only: read a workbook from an xlsx file path (mutates and returns `wb`). */
export function readFile(
  wb: WorkbookData,
  filename: string,
  options?: XlsxReadOptions
): Promise<WorkbookData> {
  return getXlsxIo(wb).readFile(filename, options);
}

/** Node-only: write a workbook to an xlsx file path. */
export function writeFile(
  wb: WorkbookData,
  filename: string,
  options?: XlsxWriteOptions
): Promise<void> {
  return getXlsxIo(wb).writeFile(filename, options);
}
