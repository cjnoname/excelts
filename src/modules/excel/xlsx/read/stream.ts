/**
 * Read a workbook from a stream — Node variant.
 *
 * Node has a streaming ZIP parser, so entries are parsed as they arrive instead of the whole package
 * being buffered first, which is what the browser variant (`read/stream.browser.ts`) has to do.
 */
import type { ZipEntry } from "@archive/unzip/stream";
import { Parse } from "@archive/unzip/stream";
import type { Workbook } from "@excel/core/workbook";
import { readXlsxEntriesInto } from "@excel/xlsx/read/package";
import type { XlsxReadOptions } from "@excel/xlsx/types";
import { Writable, pipeline } from "@stream";
import type { ReadableLike } from "@stream/types";
import { toError } from "@utils/errors";

export async function readXlsxStreamInto(
  workbook: Workbook,
  stream: ReadableLike,
  options?: XlsxReadOptions
): Promise<Workbook> {
  const parser = new Parse();

  const swallowError = () => {
    // Prevent unhandled 'error' events from crashing the process.
    // Errors are surfaced via rejected promises.
  };

  // Always attach an error listener to avoid uncaught exceptions.
  parser.on("error", swallowError);
  if (stream && typeof stream.on === "function") {
    stream.on("error", swallowError);
  }

  // Pump incoming data into the ZIP parser without buffering the whole file.
  // NOTE: `Parse` is a Duplex; passing it directly to pipeline() can make
  // Node treat it like a transform and surface `Premature close` errors.
  // We instead pipeline the input stream into a Writable sink that forwards
  // chunks into the parser with backpressure.
  const sink = new Writable({
    write(chunk: Uint8Array | string, _encoding: string, callback: (error?: Error | null) => void) {
      try {
        const ok = parser.write(chunk);
        if (ok) {
          callback();
        } else {
          parser.once("drain", () => callback());
        }
      } catch (e) {
        callback(toError(e));
      }
    },
    final(callback: (error?: Error | null) => void) {
      try {
        parser.end();
        callback();
      } catch (e) {
        callback(toError(e));
      }
    }
  });

  const onParserError = (err: unknown) => {
    try {
      sink.destroy(toError(err));
    } catch {
      // ignore
    }
  };
  parser.on("error", onParserError);

  const pump = pipeline(stream, sink);

  const entries = (async function* () {
    for await (const entry of iterateZipEntries(parser)) {
      entry.on("error", swallowError);
      const drain = async () => {
        if (entry.readableEnded || entry.destroyed) {
          return;
        }
        const draining = entry.autodrain();
        await draining.promise();
      };
      yield {
        name: entry.path,
        type: entry.type,
        stream: entry,
        drain
      };
    }
  })();

  try {
    const result = await readXlsxEntriesInto(workbook, entries, options);
    await pump;
    return result;
  } catch (err) {
    // Stop the ZIP parser so pipeline() can unwind promptly.
    try {
      parser.destroy();
    } catch {
      // ignore
    }

    // Ensure pump settles to avoid unhandled rejections.
    try {
      await pump;
    } catch {
      // ignore pump failures; the original parse error is more useful
    }
    throw err;
  } finally {
    try {
      parser.off("error", onParserError);
    } catch {
      // ignore
    }
    try {
      parser.off("error", swallowError);
    } catch {
      // ignore
    }
    if (stream && typeof stream.off === "function") {
      try {
        stream.off("error", swallowError);
      } catch {
        // ignore
      }
    }
  }
}

async function* iterateZipEntries(parser: Parse): AsyncGenerator<ZipEntry> {
  const queue: ZipEntry[] = [];
  let head = 0;
  let done = false;
  let error: unknown;
  let notify: (() => void) | null = null;

  const wake = () => {
    if (notify) {
      const fn = notify;
      notify = null;
      fn();
    }
  };

  parser.on("entry", (entry: ZipEntry) => {
    queue.push(entry);
    wake();
  });
  parser.once("error", (err: unknown) => {
    error = err;
    wake();
  });
  parser.once("close", () => {
    done = true;
    wake();
  });

  while (!done || head < queue.length) {
    if (error) {
      throw toError(error);
    }
    if (head < queue.length) {
      const entry = queue[head++]!;
      // Periodically compact to avoid unbounded growth.
      if (head > 1024 && head > queue.length / 2) {
        queue.splice(0, head);
        head = 0;
      }
      yield entry;
      continue;
    }
    await new Promise<void>(resolve => {
      notify = resolve;
    });
  }
}
