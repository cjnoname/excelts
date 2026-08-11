/**
 * WorkbookWriter - Node.js Streaming Excel Writer
 *
 * Extends base with file path support and file system image loading.
 */

import { ImageError } from "@excel/errors";
import type {
  WorkbookWriterOptions,
  WorkbookZipOptions,
  ZlibOptions
} from "@excel/stream/workbook-writer.browser";
import { WorkbookWriterBase } from "@excel/stream/workbook-writer.browser";
import { WorksheetWriter } from "@excel/stream/worksheet-writer";
import { isExternalImage } from "@excel/utils/drawing-utils";
import { mediaPath } from "@excel/utils/ooxml-paths";
import { readFileBytes, createWriteStream } from "@utils/fs";

export type { WorkbookWriterOptions, WorkbookZipOptions, ZlibOptions };
export type { Medium } from "@excel/stream/workbook-writer.browser";

// Interface for output stream
interface OutputStreamLike {
  emit(eventName: string | symbol, ...args: unknown[]): boolean;
  write(chunk: Uint8Array | string): boolean | Promise<boolean>;
  end(): void;
  // Listener args are event-specific; `any[]` is the standard EventEmitter shape.
  once(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
}

class WorkbookWriter extends WorkbookWriterBase<WorksheetWriter> {
  constructor(options: WorkbookWriterOptions = {}) {
    super(options, WorksheetWriter);
  }

  /**
   * Create output stream - supports filename option in Node.js
   */
  protected _createOutputStream(options: WorkbookWriterOptions): OutputStreamLike {
    if (options.filename) {
      return createWriteStream(options.filename);
    }
    return super._createOutputStream(options);
  }

  /**
   * Add media files - supports loading from file system
   */
  addMedia(): Promise<void[]> {
    return Promise.all(
      this.media.map(async medium => {
        if (medium.type === "image") {
          // External (linked) images carry only a `link` target — no bytes
          // are written into the package.
          if (isExternalImage(medium)) {
            return;
          }
          const filename = mediaPath(medium.name);
          // Node.js: support loading from file
          if (medium.filename) {
            const data = await readFileBytes(medium.filename);
            this._addFile(data, filename);
            return;
          }
          if (medium.buffer) {
            this._addFile(medium.buffer, filename);
            return;
          }
          if (medium.base64) {
            const content = medium.base64.substring(medium.base64.indexOf(",") + 1);
            this._addFile(content, filename, true);
            return;
          }
        }
        throw new ImageError("Unsupported media");
      })
    );
  }
}

export { WorkbookWriter };
