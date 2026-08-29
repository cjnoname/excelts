/**
 * Browser XLSX handle accessor and the canonical workbook IO surface.
 *
 * Kept out of `workbook.browser` so the heavy `XLSX` serializer is not a static
 * dependency of the workbook record module (which would create a
 * workbook ↔ xlsx import cycle). Selected over `xlsx-io.ts` (Node) via the
 * `.browser` same-name swap at build/test time. The public functions dispatch
 * to XLSB when requested or detected.
 */
import { ZipParser } from "@archive/unzip/zip-parser";
import type { WorkbookData } from "@excel/core/workbook-core";
import {
  read as readXlsb,
  readStream as readXlsbStream,
  toBuffer as toXlsbBuffer,
  toStream as toXlsbStream,
  writeStream as writeXlsbStream
} from "@excel/core/xlsb-io.browser";
import type {
  XlsbInputStream,
  XlsbReadOptions,
  XlsbStreamOptions,
  XlsbWriteOptions
} from "@excel/core/xlsb-io.browser";
import type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
import { createXlsxByteStream } from "@excel/core/xlsx-stream";
import type { XlsxReadOptions, XlsxWriteOptions, IParseStream } from "@excel/xlsx/xlsx.browser";
import { XLSX } from "@excel/xlsx/xlsx.browser";
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

/** Serialize a workbook to XLSX bytes, or XLSB when `options.format` requests it. */
export function toBuffer(wb: WorkbookData, options?: WorkbookWriteOptions): Promise<Uint8Array> {
  return options?.format === "xlsb"
    ? toXlsbBuffer(wb, xlsbWriteOptions(options))
    : getXlsxIo(wb).writeBuffer(options);
}

/** Read XLSX or XLSB bytes into a workbook (mutates and returns `wb`). */
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
  stream: IParseStream | XlsbInputStream,
  options?: WorkbookReadOptions
): Promise<WorkbookData> {
  if (options?.format === "xlsb") {
    return readXlsbStream(wb, stream as XlsbInputStream, options);
  }
  return getXlsxIo(wb).read(stream as IParseStream, options);
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
  options?: WorkbookWriteOptions
): Promise<void> {
  if (options?.format === "xlsb") {
    return writeXlsbStream(wb, stream, xlsbWriteOptions(options));
  }
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
 * {@link XlsxStreamOptions.highWaterMark} is not a hard memory bound:
 * backpressure is sampled after each ZIP entry, and a worksheet is rendered as
 * one entry, so peak buffering may substantially exceed the
 * configured value and is usually driven by the largest worksheet. See
 * {@link XlsxStreamOptions.highWaterMark} for how `Stream.WorkbookWriter`
 * compares.
 *
 * Do not mutate the workbook until the stream ends. A consumer that abandons the
 * stream should `destroy()` it, which releases the parked writer; serialization
 * failures surface as an `'error'` event, so consume through `pipeline()` or
 * `for await` rather than a bare `.pipe()`.
 *
 * ### Leaving `for await` early
 *
 * Breaking out of the loop destroys the stream with no error, so `errored` stays
 * `null` and no `'error'` listener fires. Use
 * `stream.iterator({ destroyOnReturn: false })` to keep the stream alive past the
 * loop — you then have to `destroy()` it yourself, or the serializer stays parked.
 *
 * Note this differs from the Node build, where Node's own async iterator destroys
 * the stream with an `AbortError` on early exit and sets `errored`. `errored` is
 * therefore not a portable way to distinguish "the consumer stopped" from
 * "serialization failed"; track that yourself if the same code runs on both.
 */
export function toStream(wb: WorkbookData, options?: WorkbookStreamOptions): XlsxReadable {
  if (options?.format === "xlsb") {
    return toXlsbStream(wb, options) as XlsxReadable;
  }
  const io = getXlsxIo(wb);
  return createXlsxByteStream((sink, writeOptions) => io.write(sink, writeOptions), options);
}

function isXlsbInput(
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options: WorkbookReadOptions | undefined
): boolean {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    if (!options?.base64) {
      return false;
    }
    bytes = base64ToUint8Array(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  try {
    return new ZipParser(bytes)
      .getEntries()
      .some(entry => entry.path.toLowerCase() === "xl/workbook.bin");
  } catch {
    return false;
  }
}

function xlsbWriteOptions(options: WorkbookWriteOptions): XlsbWriteOptions {
  const { format: _format, ...writeOptions } = options;
  return writeOptions;
}

export type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
export type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";
export type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
