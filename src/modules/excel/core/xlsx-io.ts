import type { Readable } from "node:stream";

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

/**
 * Serialize a workbook to xlsx bytes.
 *
 * Returns a `Buffer` on Node — the same nominal type `fs.writeFile`, `res.end`,
 * and SDK upload bodies ask for — so callers do not need the defensive
 * `Buffer.from(bytes)` that a `Uint8Array` declaration invites, and which really
 * does copy the whole package.
 *
 * The guarantee is structural, not a re-label: `StreamBuf.read()` already hands
 * back a `Buffer` view on Node, so the common path returns that value untouched,
 * and the fallback wraps the existing memory (`Buffer.from(buffer, byteOffset,
 * byteLength)` is a view, never a copy). Either way no bytes are duplicated, and
 * the declared type cannot silently drift from the runtime one.
 */
export async function toBuffer(wb: WorkbookData, options?: XlsxWriteOptions): Promise<Buffer> {
  const bytes = await getXlsxIo(wb).writeBuffer(options);
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
 * // take it directly — no `Readable.from()` adapter, no cast:
 * const body = Workbook.toStream(wb);
 * const web = Readable.toWeb(Workbook.toStream(wb));
 * ```
 *
 * The return type refines {@link XlsxReadable} rather than replacing it: it is
 * still assignable to `XlsxReadable`, which is identical in both builds, so
 * cross-platform code written against that name keeps compiling while Node code
 * gets the nominal `stream.Readable`.
 *
 * {@link XlsxStreamOptions.highWaterMark} is not a hard memory bound:
 * backpressure is sampled after each ZIP entry, and a worksheet is rendered as
 * one entry, so peak buffering may substantially exceed the
 * configured value and is usually driven by the largest worksheet. See
 * {@link XlsxStreamOptions.highWaterMark} for how `Stream.WorkbookWriter`
 * compares.
 *
 * Do not mutate the workbook until the stream ends. A consumer that abandons the
 * stream should `destroy()` it, which releases the parked writer; serialization
 * failures surface as an `'error'` event, so consume through `stream.pipeline()`
 * or `for await` rather than a bare `.pipe()`.
 */
export function toStream(wb: WorkbookData, options?: XlsxStreamOptions): XlsxReadable & Readable {
  const io = getXlsxIo(wb);
  // `createXlsxByteStream` is shared with the browser build, so it is typed as
  // the portable `XlsxReadable`. On Node the stream it builds is a real
  // `stream.Readable` — `@stream`'s `createReadable` constructs one — which is
  // what this narrowing states. Asserted at runtime by
  // `surface/__tests__/node-io-types.node.test.ts` ("is a byte-mode
  // stream.Readable"), so the claim cannot rot silently.
  return createXlsxByteStream(
    (sink, writeOptions) => io.write(sink, writeOptions),
    options
  ) as XlsxReadable & Readable;
}

export type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
export type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";
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
