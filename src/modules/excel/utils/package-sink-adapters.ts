/**
 * `PackageSink` adapters — one per destination, and nothing format-specific in either.
 *
 * A writer takes a sink and never learns which of these it got. That is the whole point: the buffered and
 * streamed paths of both containers become the same code with a different constructor argument, instead of two
 * implementations that drift.
 */
import { ZipArchive } from "@archive/zip";
import type { PackageSink, PartWriter } from "@excel/utils/package-sink";

const TEXT_ENCODER = new TextEncoder();

/** Bytes for either accepted form. */
function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? TEXT_ENCODER.encode(data) : data;
}

/**
 * A sink that assembles a `ZipArchive` in memory.
 *
 * `open()` accumulates chunks and adds the part when closed, because a `ZipArchive` entry is a value rather
 * than a stream. A serialiser that streams into this therefore pays one buffer per part — which is what the
 * buffered path already did, so nothing regresses.
 */
export class ArchiveSink implements PackageSink {
  private readonly added: string[] = [];

  constructor(readonly archive: ZipArchive = new ZipArchive()) {}

  part(path: string, data: Uint8Array | string): void {
    this.added.push(path);
    this.archive.add(path, toBytes(data));
  }

  open(path: string): PartWriter {
    // Recorded now, not at `end()`: a derived part may be assembled while this one is still open, and it reads
    // `paths` to decide what to declare.
    this.added.push(path);
    const chunks: Uint8Array[] = [];
    const archive = this.archive;
    let closed = false;
    return {
      write(chunk: Uint8Array | string): void {
        if (closed) {
          throw new Error(`part ${path} is already closed`);
        }
        chunks.push(toBytes(chunk));
      },
      end(): void {
        if (closed) {
          return;
        }
        closed = true;
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const joined = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          joined.set(chunk, at);
          at += chunk.length;
        }
        archive.add(path, joined);
      }
    };
  }

  get paths(): readonly string[] {
    return this.added;
  }

  /** Nothing to wait for: the archive is memory. */
  async drain(): Promise<void> {}

  /** The finished package. */
  async bytes(): Promise<Uint8Array> {
    return await this.archive.bytes();
  }
}

/**
 * The subset of the streaming zip writer this sink needs.
 *
 * Named structurally rather than importing `IZipWriter`, for two reasons. It keeps `utils/` from depending on
 * `xlsx/` — `IZipWriter` is declared in `xlsx.browser.ts` — and it states exactly which four members are used,
 * so a reader can see that nothing here reaches for the emitter or the pipe.
 */
export interface StreamingZipLike {
  append(data: string | Uint8Array, options: { name: string; base64?: boolean }): void;
  createEntry(name: string): { write(chunk: Uint8Array | string): void; end(): void };
  waitForDrain(): Promise<void>;
}

/**
 * A sink that writes straight into a streaming zip.
 *
 * `createEntry` originally took `string` only, which is right for XML and **unusable** for a BIFF12 part: the
 * entry encodes what it is given as UTF-8, so any byte above 0x7F would be re-encoded as two. Mapping bytes
 * through latin1 first was tried here and is wrong for exactly that reason — it does not round-trip.
 *
 * So the signature was widened instead. That is the honest fix and it is a small one; taking the latin1 route
 * would have produced a corrupt binary part for any sheet containing a byte ≥ 0x80, which is every sheet with
 * a `BrtCellReal`.
 */
export class StreamingSink implements PackageSink {
  private readonly added: string[] = [];

  constructor(private readonly zip: StreamingZipLike) {}

  part(path: string, data: Uint8Array | string): void {
    this.added.push(path);
    this.zip.append(data, { name: path });
  }

  open(path: string): PartWriter {
    this.added.push(path);
    const entry = this.zip.createEntry(path);
    return {
      write(chunk: Uint8Array | string): void {
        entry.write(chunk);
      },
      end(): void {
        entry.end();
      }
    };
  }

  get paths(): readonly string[] {
    return this.added;
  }

  async drain(): Promise<void> {
    await this.zip.waitForDrain();
  }
}
