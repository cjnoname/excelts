import events from "events";
import { Zip, ZipPassThrough } from "fflate";
import { StreamBuf } from "./stream-buf.js";
import { stringToBuffer } from "./browser-buffer-encode.js";
import { isBrowser } from "./browser.js";

interface ZipWriterOptions {
  type?: string;
  compression?: string;
}

interface AppendOptions {
  name: string;
  base64?: boolean;
}

interface ZipFile {
  data: Uint8Array;
  isStream?: boolean;
}

// =============================================================================
// The ZipWriter class
// Packs streamed data into an output zip stream
class ZipWriter extends events.EventEmitter {
  options: ZipWriterOptions;
  files: Record<string, ZipFile>;
  stream: any;
  zip: Zip;
  finalized: boolean;

  constructor(options?: ZipWriterOptions) {
    super();
    this.options = Object.assign(
      {
        type: "nodebuffer",
        compression: "DEFLATE"
      },
      options
    );

    this.files = {};
    this.stream = new StreamBuf();
    this.finalized = false;

    // Create fflate Zip instance for streaming compression
    this.zip = new Zip((err, data, final) => {
      if (err) {
        this.stream.emit("error", err);
      } else {
        this.stream.write(Buffer.from(data));
        if (final) {
          this.stream.end();
        }
      }
    });
  }

  append(data: any, options: AppendOptions): void {
    let buffer: Uint8Array;

    if (Object.prototype.hasOwnProperty.call(options, "base64") && options.base64) {
      // Use Buffer.from for efficient base64 decoding
      const base64Data = typeof data === "string" ? data : data.toString();
      if (isBrowser) {
        // Browser: use atob with optimized Uint8Array conversion
        const binaryString = atob(base64Data);
        const len = binaryString.length;
        buffer = new Uint8Array(len);
        // Use a single loop with cached length for better performance
        for (let i = 0; i < len; i++) {
          buffer[i] = binaryString.charCodeAt(i);
        }
      } else {
        // Node.js: use efficient Buffer.from
        buffer = Buffer.from(base64Data, "base64");
      }
    } else {
      if (typeof data === "string") {
        // Convert string to Uint8Array
        if (isBrowser) {
          buffer = stringToBuffer(data);
        } else {
          buffer = Buffer.from(data, "utf8");
        }
      } else if (Buffer.isBuffer(data)) {
        buffer = new Uint8Array(data);
      } else {
        buffer = data;
      }
    }

    // Add file to zip using streaming API
    const zipFile = new ZipPassThrough(options.name);
    this.zip.add(zipFile);
    zipFile.push(buffer, true); // true = final chunk
  }

  push(chunk: any): boolean {
    return this.stream.push(chunk);
  }

  async finalize(): Promise<void> {
    if (this.finalized) {
      return;
    }
    this.finalized = true;

    // End the zip stream
    this.zip.end();

    this.emit("finish");
  }

  // ==========================================================================
  // Stream.Readable interface
  read(size?: number): any {
    return this.stream.read(size);
  }

  setEncoding(encoding: string): any {
    return this.stream.setEncoding(encoding);
  }

  pause(): any {
    return this.stream.pause();
  }

  resume(): any {
    return this.stream.resume();
  }

  isPaused(): boolean {
    return this.stream.isPaused();
  }

  pipe(destination: any, options?: any): any {
    return this.stream.pipe(destination, options);
  }

  unpipe(destination?: any): any {
    return this.stream.unpipe(destination);
  }

  unshift(chunk: any): any {
    return this.stream.unshift(chunk);
  }

  wrap(stream: any): any {
    return this.stream.wrap(stream);
  }
}

// =============================================================================

export { ZipWriter };
