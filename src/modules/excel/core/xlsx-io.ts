import type { Readable } from "node:stream";

/**
 * Node XLSX handle accessor and the canonical workbook IO surface.
 *
 * Same shape as `xlsx-io.browser.ts`, but binds the Node `XLSX` serializer
 * (which adds file-path `readFile` / `writeFile` and true-streaming `read`)
 * and dispatches to XLSB when requested or detected. It layers the Node-only
 * file-path functions on top and is selected over the browser variant via the
 * `.browser` same-name swap at build/test time.
 */
import { ZipParser } from "@archive/unzip/zip-parser";
import type { WorkbookData } from "@excel/core/workbook-core";
import {
  read as readXlsb,
  readFile as readXlsbFile,
  readStream as readXlsbStream,
  toBuffer as toXlsbBuffer,
  toStream as toXlsbStream,
  writeFile as writeXlsbFile,
  writeStream as writeXlsbStream
} from "@excel/core/xlsb-io";
import type {
  XlsbInputStream,
  XlsbReadOptions,
  XlsbStreamOptions,
  XlsbWriteOptions
} from "@excel/core/xlsb-io";
import type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
import { createXlsxByteStream } from "@excel/core/xlsx-stream";
import { XLSX } from "@excel/xlsx/xlsx";
import type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";
import { base64ToUint8Array } from "@utils/utils";

/** Workbook package formats supported by the canonical IO surface. */
export type WorkbookFormat = "xlsx" | "xlsb";
/** Read options shared by XLSX and XLSB, with an optional explicit format. */
export type WorkbookReadOptions = XlsxReadOptions & XlsbReadOptions & { format?: WorkbookFormat };
/** Write options shared by XLSX and XLSB, with an optional explicit format. */
export type WorkbookWriteOptions = XlsxWriteOptions &
  Omit<XlsbWriteOptions, "zip"> & {
    format?: WorkbookFormat;
    zip?: XlsxWriteOptions["zip"] & XlsbWriteOptions["zip"];
  };
/** Canonical workbook write options plus readable-stream queue configuration. */
export type WorkbookStreamOptions = WorkbookWriteOptions & XlsbStreamOptions;

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
 * Serialize a workbook to XLSX bytes, or XLSB when `options.format` requests it.
 *
 * Returns a `Buffer` on Node — the same nominal type `fs.writeFile`, `res.end`,
 * and SDK upload bodies ask for — so callers do not need the defensive
 * `Buffer.from(bytes)` that a `Uint8Array` declaration invites, and which really
 * does copy the whole package.
 *
 * The guarantee is structural, not a re-label: the XLSX `StreamBuf.read()` path
 * already hands back a `Buffer` view, while the XLSB and fallback paths wrap the
 * existing memory (`Buffer.from(buffer, byteOffset, byteLength)` is a view,
 * never a copy). No bytes are duplicated, and the declared type cannot silently
 * drift from the runtime one.
 */
export async function toBuffer(wb: WorkbookData, options?: WorkbookWriteOptions): Promise<Buffer> {
  if (options?.format === "xlsb") {
    return toXlsbBuffer(wb, xlsbWriteOptions(options));
  }
  const bytes = await getXlsxIo(wb).writeBuffer(options);
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read XLSX or XLSB bytes into a workbook, mutating and returning `wb`. */
export async function read(
  wb: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options?: WorkbookReadOptions
): Promise<WorkbookData> {
  if (options?.format === "xlsb" || (options?.format !== "xlsx" && isXlsbInput(data, options))) {
    return readXlsb(wb, data, options);
  }
  return getXlsxIo(wb).load(data, options);
}

/** Read a workbook from a parse stream (mutates and returns `wb`). */
export function readStream(
  wb: WorkbookData,
  stream: unknown,
  options?: WorkbookReadOptions
): Promise<WorkbookData> {
  if (options?.format === "xlsb") {
    return readXlsbStream(wb, stream as XlsbInputStream, options);
  }
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
  options?: WorkbookWriteOptions
): Promise<void> {
  if (options?.format === "xlsb") {
    return writeXlsbStream(wb, stream as never, xlsbWriteOptions(options));
  }
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
 * With `format: "xlsb"`, this delegates to the XLSB serializer and applies
 * `XlsbStreamOptions`. The XLSX entry-buffering details below apply only to the
 * default XLSX path.
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
 *
 * ### Leaving `for await` early
 *
 * Reading the first N chunks and `break`ing is Node's semantics, not this
 * stream's, and the two teardown paths do **not** look alike:
 *
 * ```ts
 * for await (const chunk of Workbook.toStream(wb)) break;
 * // stream.errored === AbortError: The operation was aborted
 * ```
 *
 * Node's async iterator destroys the stream with an `AbortError` on early exit
 * (`createAsyncIterator` → `destroyer`), whereas calling `destroy()` yourself
 * destroys it with no error. Nothing crashes — the iterator handles the event, so
 * an absent `'error'` listener is not an unhandled error — but a listener that
 * *is* attached receives a spurious `AbortError`, and `stream.errored` is set, so
 * code that reports either as a serialization failure will report a false one.
 *
 * Two ways to leave early *silently*, both of which still release the parked
 * writer:
 *
 * ```ts
 * // 1. destroy first, then break
 * const stream = Workbook.toStream(wb);
 * for await (const chunk of stream) {
 *   if (enough(chunk)) {
 *     stream.destroy();
 *     break;
 *   }
 * }
 *
 * // 2. opt out of the iterator's teardown — but then YOU must destroy it,
 * //    or the serializer stays parked
 * const stream = Workbook.toStream(wb);
 * try {
 *   for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
 *     if (enough(chunk)) break;
 *   }
 * } finally {
 *   stream.destroy();
 * }
 * ```
 *
 * The browser build destroys silently on early exit instead, so `errored` is not
 * a portable way to tell "the consumer stopped" from "serialization failed" —
 * track that yourself if the same code runs on both platforms.
 */
export function toStream(
  wb: WorkbookData,
  options?: WorkbookStreamOptions
): XlsxReadable & Readable {
  if (options?.format === "xlsb") {
    return toXlsbStream(wb, options) as XlsxReadable & Readable;
  }
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
// Node-only workbook file-path IO.
// =============================================================================

/** Node-only: read an XLSX or XLSB file, mutating and returning `wb`. */
export function readFile(
  wb: WorkbookData,
  filename: string,
  options?: WorkbookReadOptions
): Promise<WorkbookData> {
  if (options?.format === "xlsb" || (options?.format !== "xlsx" && isXlsbFilename(filename))) {
    return readXlsbFile(wb, filename, options);
  }
  return getXlsxIo(wb).readFile(filename, options);
}

/** Node-only: write an XLSX or XLSB file, inferred from the extension or options. */
export function writeFile(
  wb: WorkbookData,
  filename: string,
  options?: WorkbookWriteOptions
): Promise<void> {
  if (options?.format === "xlsb" || (options?.format !== "xlsx" && isXlsbFilename(filename))) {
    return writeXlsbFile(wb, filename, xlsbWriteOptions(options ?? {}));
  }
  return getXlsxIo(wb).writeFile(filename, options);
}

function isXlsbInput(
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options: WorkbookReadOptions | undefined
): boolean {
  try {
    const bytes =
      typeof data === "string"
        ? options?.base64
          ? base64ToUint8Array(data)
          : undefined
        : data instanceof Uint8Array
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return bytes
      ? new ZipParser(bytes)
          .getEntries()
          .some(entry => entry.path.toLowerCase() === "xl/workbook.bin")
      : false;
  } catch {
    return false;
  }
}

function isXlsbFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".xlsb");
}

function xlsbWriteOptions(options: WorkbookWriteOptions): XlsbWriteOptions {
  const { format: _format, ...writeOptions } = options;
  return writeOptions;
}
