import type { WorkbookData } from "@excel/core/workbook-core";
import {
  resolveReadFormat,
  normalizeBytes,
  readXlsbInto,
  writeXlsbBytes,
  writeXlsbToStream
} from "@excel/core/workbook-format";
/**
 * The canonical public workbook IO surface — browser variant.
 *
 * Kept out of `workbook.browser` so the serializer is not a static dependency of
 * the workbook record module (which would create a workbook ↔ xlsx import cycle).
 * Selected over `xlsx-io.ts` (Node) via the `.browser` same-name swap.
 */
import { readWorkbookWithDiagnostics } from "@excel/core/workbook-io-types";
import type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
import type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
import { createXlsxByteStream } from "@excel/core/xlsx-stream";
import type { IParseStream, XlsxReadOptions } from "@excel/xlsx/types";
import { writeXlsxBytes, writeXlsxToStream } from "@excel/xlsx/write/package";

export type {
  WorkbookDiagnosticReadOptions,
  WorkbookReadOptions,
  WorkbookReadReport,
  WorkbookWriteOptions
} from "@excel/core/workbook-io-types";

import type {
  WorkbookDiagnosticReadOptions,
  WorkbookReadOptions,
  WorkbookReadReport,
  WorkbookWriteOptions
} from "@excel/core/workbook-io-types";

/**
 * The XLSX reader, loaded on demand — the boundary `workbook-format.ts` already draws for XLSB.
 *
 * What this boundary buys depends on the bundler, and it is worth being exact about. One that drops
 * unused members of a namespace (rolldown, rspack) already leaves the reader out of a `toBuffer`-only
 * bundle, static import or not — the reader is kept out of the *writer* by `xlsx/write/` never importing
 * `xlsx/read/`, and `scripts/treeshake-verify.ts` asserts that. One that keeps a namespace object whole
 * (esbuild) retains `read` with `toBuffer`, and there this `import()` is what moves the reader into a
 * chunk fetched on first read instead of on page load. Every read entry is async, so it costs nothing.
 */
function loadXlsxReader() {
  return import("@excel/xlsx/read/package");
}

// =============================================================================
// Cross-platform flat IO functions (the canonical public surface).
// =============================================================================

/** Serialize a workbook to xlsx bytes. */
export async function toBuffer(
  wb: WorkbookData,
  options?: WorkbookWriteOptions
): Promise<Uint8Array> {
  if (options?.format === "xlsb") {
    return await writeXlsbBytes(wb, options);
  }
  // Inlined: the wrapper this replaced had one caller, isolated no platform difference and narrowed
  // nothing — it was a name standing in for a method call.
  return await writeXlsxBytes(wb, options);
}

/** Read xlsx bytes into a workbook (mutates and returns `wb`). */
export async function read(
  wb: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options?: WorkbookReadOptions
): Promise<WorkbookData> {
  const bytes = normalizeBytes(data, options?.base64);
  const format = resolveReadFormat(bytes, options?.format);
  if (format === "xlsb" && bytes) {
    return readXlsbInto(wb, bytes, undefined, options);
  }
  return (await loadXlsxReader()).readXlsxInto(wb, bytes ?? data, options);
}

/**
 * Read a workbook and return what could not be recovered alongside it.
 *
 * `read` throws away the diagnostics and `{ unsupported: "error" }` turns them into a rejection; this
 * is the third combination, and the one a converter actually wants — read the file, then report. The
 * workbook is replaced exactly as `read` replaces it.
 */
export async function readWithDiagnostics(
  wb: WorkbookData,
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options?: WorkbookDiagnosticReadOptions
): Promise<WorkbookReadReport> {
  // The shared body — see `readWorkbookWithDiagnostics`. This was 26 lines duplicated between the two platform
  // variants, in the one file pair where every other shared piece had already been extracted.
  return readWorkbookWithDiagnostics(wb, data, options, {
    read,
    normalizeBytes,
    resolveReadFormat
  });
}

/** Read a workbook from a parse stream (mutates and returns `wb`). */
export async function readStream(
  wb: WorkbookData,
  stream: IParseStream,
  options?: XlsxReadOptions
): Promise<WorkbookData> {
  const { readXlsxStreamInto } = await import("@excel/xlsx/read/stream");
  return readXlsxStreamInto(wb, stream as never, options);
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
export async function writeStream(
  wb: WorkbookData,
  stream: XlsxWritable,
  options?: WorkbookWriteOptions
): Promise<void> {
  if (options?.format === "xlsb") {
    // Streamed part by part through the same writer the buffered path uses — see the Node twin for why the
    // previous "nothing to stream incrementally" was wrong.
    await writeXlsbToStream(wb, stream, options);
    return;
  }
  await writeXlsxToStream(wb, stream, options);
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
 * As in Node, breaking out of the loop destroys the stream with an `AbortError`:
 * `errored` is set and an attached `'error'` listener receives it. To leave
 * silently, `destroy()` the stream before `break`, or iterate
 * `stream.iterator({ destroyOnReturn: false })` and `destroy()` it yourself
 * afterwards — otherwise the serializer stays parked.
 */
export function toStream(
  wb: WorkbookData,
  options?: XlsxStreamOptions & WorkbookWriteOptions
): XlsxReadable {
  if (options?.format === "xlsb") {
    // The same bridge the XLSX branch uses — see the Node variant for the measurement. Keeping the two platforms on one
    // mechanism matters more here than anywhere: a difference between them is invisible to whichever one a developer
    // happens to run.
    return createXlsxByteStream(sink => writeXlsbToStream(wb, sink, options), options);
  }
  return createXlsxByteStream(
    (sink, writeOptions) => writeXlsxToStream(wb, sink, writeOptions),
    options
  );
}

export type { XlsxReadable, XlsxWritable } from "@excel/core/xlsx-io-types";
export type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/types";
export type { XlsxStreamOptions } from "@excel/core/xlsx-stream";
export type { WorkbookFormat } from "@excel/core/workbook-format";
