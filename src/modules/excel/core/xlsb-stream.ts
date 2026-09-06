import type { WorkbookModel } from "@excel/core/workbook.browser";
/**
 * Streaming an XLSB package into a sink, part by part.
 *
 * This is the second half of the unification `PackageSink` exists for. The buffered path calls
 * `writeXlsbPackage(model)` and gets bytes; this one calls `writeXlsbPackage(model, { sink })` with a sink over
 * a streaming zip, and the *same writer* produces the same parts straight into the destination. There is no
 * second orchestration of content types, relationships or part numbering — the thing the module README named as
 * the larger piece of work is not duplicated, it is reused.
 *
 * ## The reason this used to be thought impossible
 *
 * `workbook-format-stream.ts` existed to say: "XLSB cannot be produced incrementally the way XLSX can. A ZIP central
 * directory is written last and the XLSB parts are built from a shared-string table that is only complete once every
 * worksheet has been visited, so there is no point in the process where a prefix of the output is known."
 *
 * Both halves are false, and the second measurably so. `sharedStrings.bin` is the **ninth** part the writer hands over
 * for a three-sheet workbook — the eight before it are finished bytes. The central directory being last is not an
 * obstacle either: it is exactly how the XLSX path streams, and how every ZIP writer works. The confusion was between
 * a *table* and a *part*: the table is only complete after the sheets are walked, and the part it becomes is written
 * after them, which is where it belongs.
 *
 * That file is gone, along with the `createXlsbReadable` it held — a readable that assembled the whole package and
 * pushed it as one chunk. It was the last route by which an XLSB could reach a stream without going through the parts,
 * and `toStream` used it: measured on an eight-sheet workbook, one chunk of 2,033 KB against XLSX's 427 chunks of at
 * most 7 KB, so `highWaterMark` was inert. Both containers now go through `createXlsxByteStream`.
 *
 * ## What streams and what does not
 *
 * What this buys, precisely: the package is no longer assembled in memory before any of it is sent, and backpressure
 * is observed between the large parts — `writeXlsbPackage` awaits `sink.drain()` after each worksheet, medium and
 * preserved part.
 *
 * **Input does not stream.** The writer still takes a finished model, so a million-row sheet is a million rows in
 * memory before anything is written. Closing that gap needs two more things: `BrtWsDim` precedes a sheet's rows and
 * states their extent, so a forward pass must either omit it — unobserved; Excel writes it in all 67 worksheet parts
 * across the corpus — or buffer one sheet; and `writeXlsbPackage` would have to accept sheets as they are committed
 * rather than reading them off a model. `stream/xlsb-writer.ts` is the path that does the second for *rows*.
 *
 * What it does not buy is per-row streaming: the writer still reads a finished model. Nor does it make the peak small
 * for every workbook — measured, the bound is the *largest single part*, and a workbook with a million distinct strings
 * hands `sharedStrings.bin` over in one call. See `addPartAndDrain` for the numbers and for what would lower it.
 */
import type { XlsxWritable } from "@excel/core/xlsx-io-types";
import { StreamingSink, type StreamingZipLike } from "@excel/utils/package-sink-adapters";
import { writeXlsbPackage } from "@excel/xlsb/write/package";

/**
 * The zip writer this needs, plus the two lifecycle members a sink does not use.
 *
 * Structural rather than `IZipWriter`, so this file does not depend on `xlsx/`. The four members
 * {@link StreamingSink} needs are in `StreamingZipLike`; `pipe` and `finalize` are the ones only a driver calls.
 */
export interface StreamingZipDriver extends StreamingZipLike {
  pipe(stream: XlsxWritable): void;
  finalize(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Write an XLSB package into `stream`, one part at a time.
 *
 * `createZip` is injected rather than imported so this stays free of the XLSX module — the caller that has a
 * zip adapter passes a factory for it. That is the same reason `IZipWriter` is described structurally above.
 */
export async function streamXlsbPackage(
  model: WorkbookModel,
  stream: XlsxWritable,
  createZip: () => StreamingZipDriver | Promise<StreamingZipDriver>,
  /**
   * Called with what the writer could not express, **before the archive is finalised**.
   *
   * **The refusal used to happen after.** `writeXlsbToStream` awaited this function and *then* consulted the policy, so
   * a write with the default `unsupported: "error"` handed a complete package to the caller's destination and threw
   * afterwards — leaving a finished file beside a rejected promise. And once `toStream` was rebuilt on this path the
   * consequence became visible: the readable had already been ended, so the throw reached nobody and a workbook with
   * unwritable content streamed to a clean finish.
   *
   * Refusing here means the ZIP is never finalised, so the destination gets a truncated archive and an error rather
   * than a plausible one and a promise nobody is watching. A truncated ZIP has no central directory and no reader will
   * accept it, which is the honest outcome for a write that was refused.
   */
  refuse?: (unsupported: readonly string[]) => void
): Promise<{ readonly unsupported: readonly string[] }> {
  const zip = await createZip();
  zip.pipe(stream);

  // The finish/error listeners are registered *before* any part is written. Registering them after would race
  // with a zip that fails on its first entry — the failure would have nowhere to go and the promise below would
  // wait for a 'finish' that never comes.
  const finished = new Promise<void>((resolve, reject) => {
    zip.on("finish", () => {
      resolve();
    });
    zip.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const written = await writeXlsbPackage(model, { sink: new StreamingSink(zip) });
  // Before `finalize`, so a refusal leaves no complete archive behind — see `refuse`.
  if (refuse !== undefined) {
    try {
      refuse(written.unsupported);
    } catch (error) {
      // **`finished` has to be disarmed on the way out.** It is created before the first part so a zip that fails on
      // its first entry has somewhere to report; on this path nothing will ever resolve it, and tearing the destination
      // down makes the zip emit `'error'` — which would reject a promise nobody is awaiting any more and surface as an
      // unhandled rejection *beside* the error the caller is already getting.
      finished.catch(() => {});
      throw error;
    }
  }
  zip.finalize();
  await finished;
  // `finish` on the zip means "every byte has been handed to the sink", which is not the same as "the sink has
  // finished with them". A file stream still has bytes in flight, so a caller that read the file as soon as
  // `writeStream` resolved got `EocdNotFoundError` on a package that was written perfectly.
  await settled(stream);
  return { unsupported: written.unsupported };
}

/**
 * Wait for a sink to finish, without ever waiting for something that cannot happen.
 *
 * **This deliberately does not live in the shared zip adapter.** Making the adapter's `finish` event wait for
 * the sink was tried and deadlocked the whole suite: `finish` means "the producer is done", every XLSX caller
 * depends on that meaning, and a sink whose completion never arrives then hangs a path that used to work.
 * Widening the *caller's* wait is the change that only affects the caller.
 *
 * Three ways a destination can say it is done, tried in order of how much they promise:
 *
 * 1. **`end(callback)`** — Node's own completion signal, and the only one that means "flushed". `end` is already
 *    called by the adapter, so calling it again is a no-op that still registers the callback; Node fires it on
 *    the already-finished stream.
 * 2. **`finish` / `close` events** — for a destination with an emitter but no callback-taking `end`.
 * 3. **Nothing** — a Web `WritableStream` has neither `end` nor `once`, and this is exactly what hung before:
 *    the previous attempt read `sink.end.length` on `undefined` inside a branch that had already committed to
 *    resolving through that path. Such a sink is closed by whoever created it, so returning immediately is
 *    correct rather than a compromise.
 *
 * A timeout is deliberately absent. A sink that accepts bytes and never completes is the documented deadlock in
 * `writeStream`'s own contract — "start the consumer first" — and silently resolving after a delay would turn
 * that into a truncated file, which is worse than a hang a stack trace explains.
 *
 * Exported because the unmodified-package passthrough needs exactly this and had grown its own version — see
 * `writeBytesToStream`. Two answers to "is this destination finished" is one too many.
 */
export async function settled(stream: unknown): Promise<void> {
  const sink = stream as {
    end?: (callback?: () => void) => void;
    once?: (event: string, listener: () => void) => unknown;
  };
  // **A destination that offers no completion signal is finished as far as this can tell.** `end.length === 0`
  // is the tell: a sink whose `end` takes no callback cannot report flushing, and a Web `WritableStream` has
  // neither `end` nor `once` at all. Waiting on such a sink is waiting for something that cannot arrive, which
  // is precisely how the first attempt at this deadlocked — and how the first draft of its test did.
  const takesCallback = typeof sink.end === "function" && sink.end.length > 0;
  const hasEvents = typeof sink.once === "function";
  if (!takesCallback && !hasEvents) {
    return;
  }

  await new Promise<void>(resolve => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    // Registered *before* `end` is called, because on an already-finished stream the events fire synchronously
    // from inside it — and because they are the fallback when the callback never comes.
    if (hasEvents) {
      sink.once!("close", finish);
      sink.once!("finish", finish);
    }
    if (takesCallback) {
      // The adapter has already called `end()`; calling it again on a finished stream is a no-op that still
      // registers the callback, which Node then fires.
      sink.end!(finish);
    }
  });
}
