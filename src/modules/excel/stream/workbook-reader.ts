/**
 * WorkbookReader - Node.js Streaming Workbook Reader
 *
 * Extends base with file path support and temp file storage for large files.
 */

import { join } from "path";

import type { ZipEntry } from "@archive/unzip/stream";
import { HyperlinkReader } from "@excel/stream/hyperlink-reader";
import type {
  WorkbookReaderInput as CrossPlatformInput,
  WorkbookReaderOptions,
  WorksheetReadyEvent
} from "@excel/stream/workbook-reader.browser";
import {
  WorkbookReaderBase,
  WorkbookReaderOptionsSchema
} from "@excel/stream/workbook-reader.browser";
import { WorksheetReader } from "@excel/stream/worksheet-reader";
import { iterateStream } from "@excel/utils/iterate-stream";
import type { Readable } from "@stream";
import { createReadStream, createWriteStream, createTempDirSync, remove } from "@utils/fs";

// Re-export types
export type {
  WorkbookReaderOptions,
  InternalWorksheetOptions,
  SharedStringRichText,
  SharedStringValue,
  WorkbookRelationship,
  SheetMetadata,
  WorkbookModel,
  WorkbookPropertiesXform,
  ParseEventType,
  SharedStringEvent,
  WorksheetReadyEvent,
  HyperlinksEvent,
  ParseEvent
} from "@excel/stream/workbook-reader.browser";

/** What the Node streaming reader accepts — adds a file path. */
export type WorkbookReaderInput = string | CrossPlatformInput;

interface WaitingWorksheet {
  sheetNo: string;
  path: string;
  cleanup: () => void;
  writePromise: Promise<void>;
}

class WorkbookReader extends WorkbookReaderBase<
  WorkbookReaderInput,
  WorksheetReader,
  HyperlinkReader,
  WaitingWorksheet
> {
  constructor(input: WorkbookReaderInput, options: WorkbookReaderOptions = {}) {
    super(input as CrossPlatformInput, options, WorksheetReader, HyperlinkReader);
    this.input = input as WorkbookReaderInput;
  }

  _getStream(input: WorkbookReaderInput): Readable {
    if (typeof input === "string") {
      return createReadStream(input);
    }
    return super._getStream(input as CrossPlatformInput);
  }

  async _storeWaitingWorksheet(sheetNo: string, entry: ZipEntry): Promise<WaitingWorksheet> {
    const tmpDir = createTempDirSync("documonster-");
    const filePath = join(tmpDir, `sheet${sheetNo}.xml`);
    const cleanup = () => {
      remove(tmpDir).catch(() => {});
    };

    const maxBytes = this._maxBufferedBytes;

    const writePromise = new Promise<void>((resolve, reject) => {
      const tempStream = createWriteStream(filePath);
      tempStream.on("error", reject);
      tempStream.on("finish", resolve);

      // Track bytes written to detect oversized waiting worksheets.
      // Use an arrow function to capture `this` for cross-sheet accumulation.
      const originalWrite = tempStream.write.bind(tempStream);
      // `tempStream.write` has several overloads (chunk[, encoding][, callback]);
      // the trailing args are forwarded verbatim, so they keep the EventEmitter-
      // style `any[]` shape that the underlying overloads expect.
      const trackWrite = (chunk: string | Uint8Array, ...args: any[]): boolean => {
        const size = chunk instanceof Uint8Array ? chunk.length : Buffer.byteLength(chunk);
        this._totalBufferedBytes += size;
        if (this._totalBufferedBytes > maxBytes) {
          const err = new Error(
            `Buffered worksheet temp data exceeds limit of ${maxBytes} bytes. ` +
              "The XLSX file may be malicious (adversarial ZIP entry ordering) or too large " +
              "for streaming. Increase maxBufferedWorksheetBytes if this is expected."
          );
          tempStream.destroy(err);
          reject(err);
          return false;
        }
        return originalWrite(chunk, ...args);
      };
      tempStream.write = trackWrite as typeof tempStream.write;

      // Forward source errors to the temp file stream so:
      //   - the file write doesn't silently leak when zip parsing fails
      //   - `writePromise` rejects with the original cause instead of hanging
      // Without this, an `error` on `entry` (e.g. zip corruption / decryption
      // failure) becomes an uncaught exception in Node ≥ 16.
      entry.on("error", err => {
        tempStream.destroy(err);
        reject(err);
      });

      entry.pipe(tempStream);
    });

    return { sheetNo, path: filePath, cleanup, writePromise };
  }

  async *_processWaitingWorksheets(
    waitingWorksheets: WaitingWorksheet[]
  ): AsyncIterableIterator<WorksheetReadyEvent<WorksheetReader>> {
    for (const ws of waitingWorksheets) {
      await ws.writePromise;
      const fileStream = createReadStream(ws.path);
      try {
        yield* this._parseWorksheet(iterateStream(fileStream), ws.sheetNo);
      } finally {
        fileStream.close();
        ws.cleanup();
      }
    }
  }
}

export { WorkbookReader, WorkbookReaderOptionsSchema };
