/**
 * XLSX - Node.js version with full functionality
 *
 * Extends XLSX with:
 * - readFile: Read from file path
 * - writeFile: Write to file path
 * - Constructor injects readFileAsync for filename-based media loading
 *
 * Inherited from XLSX (and narrowed to the Node `Workbook` type via the
 * `XLSXBase<Workbook>` generic):
 * - read: Read from stream
 * - write: Write to stream
 * - load: Load from buffer
 * - writeBuffer: Write to buffer (Uint8Array)
 * - addMedia: Supports buffer, base64, and filename (via readFileAsync)
 *
 * The `<Workbook>` type argument is what makes `wb.xlsx.load(buf)` /
 * `wb.xlsx.read(stream)` return the *Node* Workbook (which exposes
 * `xlsx.readFile` / `xlsx.writeFile`) instead of the browser base class.
 * Without the generic, the inherited methods would be typed against the
 * browser `Workbook` and Node consumers chaining off the returned value
 * would lose access to the Node-only file APIs.
 */

import type { ZipEntry } from "@archive/unzip/stream";
import { Parse } from "@archive/unzip/stream";
import type { Workbook } from "@excel/core/workbook";
import { ExcelFileError } from "@excel/errors";
import type { XlsxReadOptions, XlsxWriteOptions } from "@excel/xlsx/xlsx.browser";
import { XLSX as XLSXBase } from "@excel/xlsx/xlsx.browser";
import { Writable, pipeline } from "@stream";
import type { ReadableLike } from "@stream/types";
import { toError } from "@utils/errors";
import { fileExists, readFileBytes, createReadStream, createWriteStream } from "@utils/fs";

class XLSX extends XLSXBase<Workbook> {
  constructor(workbook: Workbook) {
    super(workbook);
    // Provide file reading capability for addMedia
    this.readFileAsync = (filename: string) => readFileBytes(filename);
  }

  private static async *iterateZipEntries(parser: Parse): AsyncGenerator<ZipEntry> {
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

  // ==========================================================================
  // Node.js specific: TRUE streaming read
  // ==========================================================================

  override async read(stream: ReadableLike, options?: XlsxReadOptions): Promise<Workbook> {
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
    const sink = new Writable<Uint8Array | string>({
      write(
        chunk: Uint8Array | string,
        _encoding: string,
        callback: (error?: Error | null) => void
      ) {
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
      for await (const entry of XLSX.iterateZipEntries(parser)) {
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
      const workbook = await this.loadFromZipEntries(entries, options);
      await pump;
      return workbook;
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
  // ===========================================================================
  // Node.js specific: File operations
  // ===========================================================================

  async readFile(filename: string, options?: XlsxReadOptions): Promise<Workbook> {
    if (!(await fileExists(filename))) {
      throw new ExcelFileError(filename, "read", "File not found");
    }
    // `loadFromFiles` clears stale origin metadata for all non-file reads.
    // Set the path only after a successful parse so failed reads preserve the
    // previously loaded workbook's origin.
    const stream = createReadStream(filename);
    const workbook = await this.read(stream, options);
    workbook.sourceFilePath = filename;
    return workbook;
  }

  writeFile(filename: string, options?: XlsxWriteOptions): Promise<void> {
    const stream = createWriteStream(filename);

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        stream.off("error", onError);
        stream.off("close", onClose);
      };

      const onError = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };

      // Wait for "close" (fd released) instead of "finish" — on Windows,
      // reading the file before the fd is closed can see truncated content.
      const onClose = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };

      stream.once("error", onError);
      stream.once("close", onClose);

      this.write(stream, options).catch(err => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        // Ensure the underlying FD is closed on failure. Keep listeners
        // attached until the stream closes, otherwise the emitted 'error'
        // event can become an uncaught exception.
        stream.destroy(err);
      });
    });
  }
}

export { XLSX };
