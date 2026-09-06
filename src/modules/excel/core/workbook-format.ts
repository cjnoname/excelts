/**
 * Workbook package format dispatch.
 *
 * XLSX and XLSB are two encodings of the same document, so the canonical IO functions treat
 * the format as a choice rather than exposing a second API. This module holds the choosing.
 *
 * ## The cost of detection is charged carefully
 *
 * Both formats are OPC ZIP packages and the only reliable difference is which workbook part
 * is present, so detecting one means reading the ZIP central directory. Two things make that
 * cheap enough to do unconditionally, and both were mistakes worth avoiding rather than
 * hypotheticals:
 *
 *  * **The input is normalised once.** A base64 string is decoded a single time and the bytes
 *    are handed to whichever loader runs. Sniffing on the string and then letting the loader
 *    decode it again doubles the work and the peak memory on the largest input a caller can
 *    supply.
 *  * **A file path is decided by its extension.** `readFile` on Node streams the ZIP rather
 *    than buffering it, which is a real advantage for a large XLSX; sniffing would mean
 *    reading the tail first and giving that up. `.xlsb` selects the binary reader, everything
 *    else keeps the streaming path, and an explicit `format` overrides both.
 */

import { refuseUnsupported } from "@excel/core/unsupported";
import type { WorkbookData } from "@excel/core/workbook-core";
import { ExcelFileError } from "@excel/errors";
import { modelHash, sameHash } from "@excel/xlsb/model-hash";
import { commitXlsbRead, isXlsbPackage, parseXlsbPackage } from "@excel/xlsb/read/package";
import { writeXlsbPackage } from "@excel/xlsb/write/package";
import { base64ToUint8Array } from "@utils/utils";

/** Package formats the canonical IO functions can read and write. */
export type WorkbookFormat = "xlsx" | "xlsb";

/**
 * Normalise a byte input to a `Uint8Array`, decoding base64 at most once.
 *
 * Returns `undefined` for anything that is not *definitely* bytes, and the exhaustiveness
 * matters more than it looks. The obvious shape for the last branch is "otherwise it is an
 * ArrayBufferView", which for a caller who passed `{}` produces
 * `new Uint8Array(undefined, undefined, undefined)` — an empty buffer. The XLSX loader's type
 * guard then never sees the original value, and instead of "is it a supported JavaScript
 * type?" the caller is told the ZIP has no central directory. Declining to normalise leaves
 * the guard able to do its job.
 */
export function normalizeBytes(
  data: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  base64: boolean | undefined
): Uint8Array | undefined {
  if (typeof data === "string") {
    // Only a base64 string is bytes; a bare string is a caller error the loader reports.
    return base64 ? base64ToUint8Array(data) : undefined;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

/**
 * Decide which format some bytes are.
 *
 * Falls back to `"xlsx"` for anything unrecognisable so the XLSX loader produces the error.
 * A message from a loader that tried to read the file says more than one from a sniffer that
 * declined to.
 */
export function detectFormat(bytes: Uint8Array | undefined): WorkbookFormat {
  return bytes && isXlsbPackage(bytes) ? "xlsb" : "xlsx";
}

/**
 * Resolve the format to read as, refusing a request that would silently lose everything.
 *
 * Detection runs even when the caller states a format, because the one combination worth
 * rejecting is invisible otherwise: the XLSX loader is deliberately tolerant of a package it
 * does not recognise — there is a fixture pinning that it reads a damaged file without
 * throwing — so handing it an XLSB package yields an empty workbook and no error at all. A
 * caller who asked for the wrong format gets told, rather than getting a workbook with
 * nothing in it.
 *
 * The reverse direction needs no special handling: the XLSB reader already reports a missing
 * `xl/workbook.bin` by name.
 *
 * Detection costs one central-directory scan, which is O(entries) and measured within noise of
 * a read that then parses the package anyway — so it is not worth a second code path to skip.
 */
export function resolveReadFormat(
  bytes: Uint8Array | undefined,
  requested: WorkbookFormat | undefined
): WorkbookFormat {
  const detected = detectFormat(bytes);
  if (requested === "xlsx" && detected === "xlsb") {
    throw new ExcelFileError(
      "<buffer>",
      "read",
      `the package contains xl/workbook.bin, so it is XLSB, but format: "xlsx" was requested. ` +
        `The XLSX reader would return an empty workbook rather than fail. Omit the format to ` +
        `detect it, or pass format: "xlsb".`
    );
  }
  return requested ?? detected;
}

/** Whether a file path names an XLSB package. */
export function formatFromPath(path: string): WorkbookFormat {
  return /\.xlsb$/i.test(path) ? "xlsb" : "xlsx";
}

/**
 * Read XLSB bytes into a workbook.
 *
 * Content the reader could not recover is reported the same way the writer reports content it cannot
 * express, and for the same reason: a converter that loses cells without saying so is worse than one
 * that stops. The two differ in their **default**, and deliberately —
 *
 * - Writing defaults to `"error"`. The workbook is in memory and complete, so a loss is the writer's
 *   limitation and refusing costs the caller nothing they had.
 * - Reading defaults to `"ignore"`. The loss already happened, in a file someone else wrote; a reader
 *   that refuses a real workbook because seven of its cells use a record whose layout is unestablished
 *   is a reader nobody can use. `"error"` is for a caller who would rather stop than convert something
 *   incomplete, which is the converter's position rather than the viewer's.
 *
 * Either way the thrown error carries the list on `items`, so a caller does not parse the message.
 *
 * **The check happens before anything is applied.** The package is read into a model of its own, the
 * policy is evaluated against that model's diagnostics, and only then is the caller's workbook
 * replaced — so a rejected read leaves the target exactly as it was. Checking afterwards, which is
 * what this did first, made `"error"` mean "replace the workbook, then report failure": a rejection
 * the caller could not recover from, and the opposite of what the scratch workbook was added for.
 */
export async function readXlsbInto(
  workbook: WorkbookData,
  bytes: Uint8Array,
  source?: string,
  options: {
    readonly unsupported?: "error" | "ignore";
    readonly blankCells?: "keep" | "collapse";
    readonly formulas?: "preserve" | "cached" | "error";
  } = {}
): Promise<WorkbookData> {
  const parsed = await parseXlsbPackage(bytes, source, {
    ...(options.blankCells === undefined ? {} : { blankCells: options.blankCells }),
    ...(options.formulas === undefined ? {} : { formulas: options.formulas })
  });
  if (parsed.diagnostics.lost.length > 0 && options.unsupported === "error") {
    const { ExcelNotSupportedError } = await import("@excel/errors");
    throw new ExcelNotSupportedError(
      "Read XLSB",
      `${parsed.diagnostics.lost.length} item(s) could not be recovered: ` +
        `${parsed.diagnostics.lost.slice(0, 10).join(", ")}` +
        `${parsed.diagnostics.lost.length > 10 ? ", …" : ""}. ` +
        `Omit { unsupported: "error" } to read the workbook without them.`,
      { items: parsed.diagnostics.lost }
    );
  }
  commitXlsbRead(workbook, parsed);
  // The origin travels with the commit, so a workbook read from a buffer does not keep the path of a
  // file it used to hold — which is what the XLSX reader does, and what a relative path resolved
  // against a stale origin would get wrong.
  workbook.sourceFilePath = source;
  return workbook;
}

/**
 * Serialise a workbook as XLSB.
 *
 * Content the writer cannot express is reported and, by default, refused. That is the whole point of
 * the default: a converter that loses formulas, tables or conditional formatting without saying so is
 * worse than one that stops, because the loss is discovered by whoever opens the file next. The caller
 * can opt out with `unsupported: "ignore"` once they know what they are giving up.
 *
 * The report names cells by address (`Sheet1!B4: rich text`) and everything else by sheet
 * (`Sheet1: table (2)`) or by name (`Sales: defined name definition`).
 */
export async function writeXlsbBytes(
  workbook: WorkbookData,
  options: { readonly unsupported?: "error" | "ignore" } = {}
): Promise<Uint8Array> {
  const { getWorkbookModel } = await import("@excel/core/workbook.browser");
  const model = getWorkbookModel(workbook);
  // **An unchanged package comes back exactly as it arrived.**
  //
  // The comparison is against a hash taken when the workbook was read, and it is safe to act on because
  // `writeXlsbPackage` reads nothing but the model: an unchanged model would produce equivalent bytes regardless.
  // What the original adds is fidelity for the parts this library understands imperfectly — a macro project, a
  // chart it did not model, a pivot cache it rebuilt approximately. Those survive a read-and-write untouched
  // instead of being reconstructed from what was understood of them.
  //
  // `unsupported` is deliberately not consulted. There is nothing to refuse: nothing is being dropped, because
  // nothing is being rewritten. Reporting a loss here would describe a package that is not the one returned.
  const source = (workbook as unknown as { _xlsbSource?: { bytes: Uint8Array; hash: Uint8Array } })
    ._xlsbSource;
  if (source !== undefined && sameHash(source.hash, modelHash(model))) {
    return source.bytes;
  }
  const written = await writeXlsbPackage(model);
  refuseUnsupported(written.unsupported, options);
  return written.bytes;
}

/**
 * Write an XLSB package straight into a sink, one part at a time.
 *
 * The same `writeXlsbPackage` as {@link writeXlsbBytes} — the only difference is where the parts go, which is
 * the whole point of `PackageSink`. So the loss report and its `unsupported` policy are shared too, through
 * {@link refuseUnsupported}: a caller must not get a different answer about what was dropped depending on
 * whether they asked for bytes or a stream.
 *
 * **The refusal happens after the parts are written**, which is a real difference worth naming. A buffered write
 * can refuse before anything leaves the process; a streamed one has already sent bytes downstream by the time
 * the report is complete, so `unsupported: "error"` throws *and* the sink has received a package. That is
 * inherent to streaming rather than a flaw here — the alternative is to buffer, which is the mode the caller
 * chose against — and it is why the default for a stream is worth thinking about at the call site.
 */
export async function writeXlsbToStream(
  workbook: WorkbookData,
  stream: unknown,
  options: { readonly unsupported?: "error" | "ignore" } = {}
): Promise<void> {
  const [{ getWorkbookModel }, { streamXlsbPackage }, { createXlsbZipWriter }] = await Promise.all([
    import("@excel/core/workbook.browser"),
    import("@excel/core/xlsb-stream"),
    import("@excel/core/xlsb-zip")
  ]);
  const model = getWorkbookModel(workbook);
  // **The same unchanged-package passthrough `writeXlsbBytes` does, because the guarantee is about the workbook and
  // not about which entry point asked for it.**
  //
  // This entry point rebuilt unconditionally, so one unmodified workbook produced two different packages depending on
  // whether the caller wanted bytes or a stream: measured on `poi-sample.xlsb`, 10,843 bytes from `toBuffer` and 8,061
  // from here. The missing 2,782 are exactly what the passthrough exists to protect — parts this library models
  // imperfectly, kept as Excel wrote them.
  //
  // Written through the sink rather than returned, so the caller's stream receives the original bytes as one part-less
  // copy of the archive. There is nothing to refuse: nothing is being rewritten, so nothing is being dropped.
  const source = (workbook as unknown as { _xlsbSource?: { bytes: Uint8Array; hash: Uint8Array } })
    ._xlsbSource;
  if (source !== undefined && sameHash(source.hash, modelHash(model))) {
    await writeBytesToStream(stream, source.bytes);
    return;
  }
  // The policy is applied *inside*, before the archive is finalised — see `streamXlsbPackage`'s `refuse`. Applying it
  // here, after the call returned, meant the destination already held a complete package when the error was thrown.
  await streamXlsbPackage(model, stream as never, createXlsbZipWriter, unsupported =>
    refuseUnsupported(unsupported, options)
  );
}

/**
 * The original package, handed to whatever stream shape the caller supplied.
 *
 * `writeStream` accepts a Node writable, a web `WritableStream` and this library's own sink, so the passthrough has to
 * reach all three — which is why this is a small adapter rather than a `write` call.
 */
async function writeBytesToStream(stream: unknown, bytes: Uint8Array): Promise<void> {
  const candidate = stream as {
    write?: (chunk: Uint8Array) => unknown;
    end?: (callback?: () => void) => unknown;
    getWriter?: () => {
      write: (chunk: Uint8Array) => Promise<void>;
      close: () => Promise<void>;
    };
  };
  if (typeof candidate.getWriter === "function") {
    const writer = candidate.getWriter();
    await writer.write(bytes);
    await writer.close();
    return;
  }
  if (typeof candidate.write !== "function") {
    throw new TypeError("writeStream needs a writable stream");
  }
  // **`write` is called with one argument, and completion is settled separately.**
  //
  // This used to pass a second, callback argument and resolve only when it was invoked — but `XlsxWritable.write` is
  // declared as `(data) => boolean | void | Promise<boolean>` and carries no callback at all. So a destination that
  // conforms to the published type and simply returns `true` was never going to call it, and `writeStream` hung
  // forever. Measured: a `{ write(d) { …; return true; }, end() {} }` sink received the bytes and the promise never
  // settled.
  //
  // The returned value is awaited when it is a promise, which is the other shape the type allows, and completion goes
  // through the same `settled` the part-by-part path uses rather than a protocol private to this branch. That helper
  // already knows the three ways a destination can say it is done, including the one where it cannot.
  const result = candidate.write(bytes);
  if (result !== null && typeof result === "object" && "then" in result) {
    await (result as PromiseLike<unknown>);
  }
  if (typeof candidate.end === "function" && candidate.end.length === 0) {
    candidate.end();
  }
  // Imported here rather than at the top, because every other reach into this module in this file is dynamic: the
  // XLSB path is loaded on demand so an XLSX-only consumer does not pay for it.
  const { settled } = await import("@excel/core/xlsb-stream");
  await settled(candidate);
}
