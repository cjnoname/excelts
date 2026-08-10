/**
 * Node xlsx IO handle accessor and the canonical public IO surface (Node).
 *
 * Same shape as `xlsx-io.browser.ts`, but binds the Node `XLSX` serializer
 * (which adds file-path `readFile` / `writeFile` and true-streaming `read`)
 * and layers the Node-only file-path free functions on top. Selected over the
 * browser variant via the `.browser` same-name swap at build/test time.
 */
import type { WorkbookData } from "@excel/core/workbook-core";
import type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
import type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
import { createXlsxByteStream } from "@excel/core/xlsx-stream";
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
 * Write a workbook to a writable stream, resolving once the sink has accepted
 * the whole package.
 *
 * Downstream backpressure is respected, so **the sink must already be consumed**
 * — or be a terminal sink such as `fs.createWriteStream()`, an HTTP response, or
 * an upload body — *before* this call. Handing over an unconsumed intermediate
 * stream (most commonly a bare `stream.PassThrough`) deadlocks: once its buffers
 * fill (64 KB per side on Node 22+, so roughly 128 KB of output) `write()`
 * returns `false`, no `'drain'` ever fires because nothing is reading, and this
 * promise never settles. Small workbooks that fit inside those buffers appear to
 * work, which makes the failure look size-dependent.
 *
 * {@link toStream} carries no such contract — prefer it whenever the consumer is
 * not already running.
 *
 * ```ts
 * // ❌ Deadlocks above ~128 KB of output: the consumer is attached only after
 * //    this promise resolves, which never happens.
 * const passThrough = new PassThrough();
 * await Workbook.writeStream(wb, passThrough);
 * await upload(passThrough);
 *
 * // ✅ Start the consumer first, then await the producer.
 * const passThrough = new PassThrough();
 * const uploading = upload(passThrough);
 * await Workbook.writeStream(wb, passThrough);
 * await uploading;
 *
 * // ✅ Or hand out a source and let the consumer pull — no ordering contract.
 * await upload(Workbook.toStream(wb));
 *
 * // ✅ Or buffer the package in memory.
 * await upload(await Workbook.toBuffer(wb));
 * ```
 *
 * A sink that errors, or that closes before serialization finishes, rejects this
 * promise instead of hanging.
 */
export function writeStream(
  wb: WorkbookData,
  stream: XlsxWritable,
  options?: XlsxWriteOptions
): Promise<void> {
  return getXlsxIo(wb)
    .write(stream, options)
    .then(() => undefined);
}

/**
 * Serialize a workbook into a readable byte stream.
 *
 * The consumer drives production: serialization starts on the first read and
 * pauses whenever the reader stops pulling. Unlike {@link writeStream} there is
 * no ordering contract to get wrong, so an unconsumed destination cannot park
 * the writer forever.
 *
 * ```ts
 * await pipeline(Workbook.toStream(wb), createWriteStream("report.xlsx"));
 * for await (const chunk of Workbook.toStream(wb)) {
 *   // …
 * }
 * // SDKs that demand a nominal `stream.Readable` (upload bodies, `toWeb`)
 * // accept it through the async-iterable adapter:
 * const body = Readable.from(Workbook.toStream(wb));
 * ```
 *
 * {@link XlsxStreamOptions.highWaterMark} is not a hard memory bound:
 * backpressure is sampled at selected ZIP-entry boundaries, and a worksheet is
 * rendered in one pass, so peak buffering may substantially exceed the
 * configured value and is usually driven by the largest worksheet. Reach for
 * `Stream.WorkbookWriter` when row-level flow control matters.
 *
 * Do not mutate the workbook until the stream ends. A consumer that abandons the
 * stream should `destroy()` it, which releases the parked writer; serialization
 * failures surface as an `'error'` event, so consume through `stream.pipeline()`
 * or `for await` rather than a bare `.pipe()`.
 */
export function toStream(wb: WorkbookData, options?: XlsxStreamOptions): XlsxReadable {
  const io = getXlsxIo(wb);
  return createXlsxByteStream((sink, writeOptions) => io.write(sink, writeOptions), options);
}

export type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
export type { XlsxStreamOptions } from "@excel/core/xlsx-stream";

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
