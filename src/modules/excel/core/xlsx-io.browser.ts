/**
 * Browser xlsx IO handle accessor and the canonical public IO surface.
 *
 * Kept out of `workbook.browser` so the heavy `XLSX` serializer is not a static
 * dependency of the workbook record module (which would create a
 * workbook ↔ xlsx import cycle). Selected over `xlsx-io.ts` (Node) via the
 * `.browser` same-name swap at build/test time.
 */
import type { WorkbookData } from "@excel/core/workbook-core";
import type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
import type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
import { createXlsxByteStream } from "@excel/core/xlsx-stream";
import type { XlsxReadOptions, XlsxWriteOptions, IParseStream } from "@excel/xlsx/xlsx.browser";
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
 * Write a workbook to a writable stream, resolving once the sink has accepted
 * the whole package.
 *
 * Downstream backpressure is respected, so **the sink must already be consumed**
 * — or be a terminal sink such as an HTTP response or an upload body — *before*
 * this call. Handing over an unconsumed intermediate stream (most commonly a
 * bare `PassThrough`) deadlocks: once its buffers fill (64 KB per side, so
 * roughly 128 KB of output) `write()` returns `false`, no `'drain'` ever fires
 * because nothing is reading, and this promise never settles. Small workbooks
 * that fit inside those buffers appear to work, which makes the failure look
 * size-dependent.
 *
 * {@link toStream} carries no such contract — prefer it whenever the consumer is
 * not already running.
 *
 * ```ts
 * // ❌ Deadlocks above ~128 KB of output: the consumer is attached only after
 * //    this promise resolves, which never happens.
 * const passThrough = createPassThrough<Uint8Array>();
 * await Workbook.writeStream(wb, passThrough);
 * await upload(passThrough);
 *
 * // ✅ Start the consumer first, then await the producer.
 * const passThrough = createPassThrough<Uint8Array>();
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
 * Serialize a workbook into a cross-platform readable byte stream.
 *
 * The consumer drives production: serialization starts on the first read and
 * pauses whenever the reader stops pulling. Unlike {@link writeStream} there is
 * no ordering contract to get wrong, so an unconsumed destination cannot park
 * the writer forever.
 *
 * ```ts
 * for await (const chunk of Workbook.toStream(wb)) {
 *   // …
 * }
 * await pipeline(Workbook.toStream(wb), sink);
 * const response = new Response(Readable.toWeb(Workbook.toStream(wb) as Readable));
 * ```
 *
 * Buffering is bounded by ZIP-entry granularity rather than by
 * {@link XlsxStreamOptions.highWaterMark}: a worksheet is rendered in one
 * uninterruptible burst, so peak memory is roughly the compressed size of the
 * largest worksheet. Reach for `Stream.WorkbookWriter` when row-level flow
 * control matters.
 *
 * Do not mutate the workbook until the stream ends. A consumer that abandons the
 * stream should `destroy()` it, which releases the parked writer; serialization
 * failures surface as an `'error'` event, so consume through `pipeline()` or
 * `for await` rather than a bare `.pipe()`.
 */
export function toStream(wb: WorkbookData, options?: XlsxStreamOptions): XlsxReadable {
  const io = getXlsxIo(wb);
  return createXlsxByteStream((sink, writeOptions) => io.write(sink, writeOptions), options);
}

export type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
export type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
