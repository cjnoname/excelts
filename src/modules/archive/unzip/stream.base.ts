import { ByteQueue } from "@archive/core/byte-queue";
import { EMPTY_UINT8ARRAY } from "@archive/core/bytes";
import { decodeZipPath, resolveZipStringCodec } from "@archive/core/text";
import { PatternScanner } from "@archive/unzip/pattern-scanner";
import type { Readable } from "@stream";
import { Duplex, PassThrough, Transform, pipeline, finished } from "@stream";
import { concatUint8Arrays, textEncoder as utf8Encoder } from "@utils/binary";
import { toError } from "@utils/errors";

/**
 * Returns true when `err` is the Node.js ERR_STREAM_PREMATURE_CLOSE error.
 *
 * This error is emitted by `finished()` / `pipeline()` when a stream is
 * destroyed before it has properly ended (e.g. a consumer breaks out of a
 * `for await` loop, or the entry PassThrough is destroyed by an external
 * consumer). In the context of ZIP parsing, a premature close on an *entry*
 * stream is not a fatal error — the parse loop only needs to advance the ZIP
 * cursor past the entry's compressed data.
 */
function isPrematureCloseError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    (err as { code?: unknown }).code === "ERR_STREAM_PREMATURE_CLOSE" ||
    err.message === "Premature close"
  );
}

/**
 * Wait for an entry's writable side to finish, tolerating premature close.
 *
 * The parse loop calls this after pumping all compressed data into an entry.
 * It ensures the decompressed data has been flushed through the inflater →
 * entry pipeline before advancing the ZIP cursor.
 *
 * If the consumer has already destroyed / autodraining the entry (e.g. early
 * break, external destroy, Readable.from() wrapper), `finished()` rejects
 * with ERR_STREAM_PREMATURE_CLOSE. This is not an error for the parse loop
 * — the compressed data has been fully read from the ZIP cursor, so we
 * can safely continue.
 */
async function awaitEntryCompletion(entry: PassThrough): Promise<void> {
  try {
    await finished(entry, { readable: false });
  } catch (err) {
    if (!isPrematureCloseError(err)) {
      throw err;
    }
    // Entry was destroyed/autodraining — treat as normal completion.
  }
}

import type {
  CrxHeader,
  EntryProps,
  EntryVars,
  ParseDriverState,
  ParseOptions,
  ZipExtraFields,
  ZipVars
} from "@archive/unzip/parser-core";
import {
  DEFAULT_PARSE_THRESHOLD_BYTES,
  buildZipEntryProps,
  getZipEntryType,
  hasDataDescriptorFlag,
  isFileSizeKnown,
  parseExtraField,
  readDataDescriptor,
  readLocalFileHeader,
  resolveZipEntryLastModifiedDateTime,
  runParseLoopCore,
  isValidZipRecordSignature
} from "@archive/unzip/parser-core";

export const DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK = 256 * 1024;

export type DrainStream = Transform & { promise: () => Promise<void> };

export function autodrain(stream: { pipe: (dest: Transform) => unknown }): DrainStream {
  const draining = stream.pipe(
    new Transform({
      transform(_chunk: Uint8Array, _encoding: string, callback: () => void) {
        callback();
      }
    })
  ) as DrainStream;

  draining.promise = () =>
    new Promise<void>((resolve, reject) => {
      draining.on("finish", resolve);
      draining.on("error", reject);
    });

  return draining;
}

/**
 * Collects all data from a readable stream into a single Uint8Array.
 */
export function bufferStream(entry: Readable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = new Transform({
      transform(d: Uint8Array, _encoding: string, callback: () => void) {
        chunks.push(d);
        callback();
      }
    });

    stream.on("finish", () => {
      resolve(chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks));
    });
    stream.on("error", reject);

    entry.on("error", reject).pipe(stream);
  });
}

export type PullFn = (length: number) => Promise<Uint8Array>;

const STR_FUNCTION = "function";

export class PullStream<TRead = unknown> extends Duplex {
  protected readonly _queue = new ByteQueue();

  // Writable-side backpressure (Node.js)
  private readonly _inputHighWaterMarkBytes: number;
  private readonly _inputLowWaterMarkBytes: number;

  get buffer(): Uint8Array {
    return this._queue.view();
  }
  set buffer(value: Uint8Array) {
    this._queue.reset(value);
  }

  cb?: () => void;
  finished: boolean;
  match?: number;
  __emittedError?: Error;
  private _pendingChunkResolve?: () => void;
  private _pendingChunkPromise?: Promise<void>;

  constructor(opts: ParseOptions = {}) {
    super({ decodeStrings: false, objectMode: true });
    this.finished = false;

    // Default values are intentionally conservative to avoid memory spikes
    // when parsing large archives under slow consumers.
    const hi = Math.max(64 * 1024, opts.inputHighWaterMarkBytes ?? 2 * 1024 * 1024);
    const lo = Math.max(32 * 1024, opts.inputLowWaterMarkBytes ?? Math.floor(hi / 4));
    this._inputHighWaterMarkBytes = hi;
    this._inputLowWaterMarkBytes = Math.min(lo, hi);

    this.on("finish", () => {
      this.finished = true;
      this._notifyPendingChunkWaiter();
      this.emit("chunk", false);
    });
  }

  // Accept string writes as well (Node Readable.from([string]) compatibility).
  declare write: {
    (chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
    (chunk: Uint8Array, encoding?: string, callback?: (error?: Error | null) => void): boolean;
    (chunk: string, callback?: (error?: Error | null) => void): boolean;
    (chunk: string, encoding?: string, callback?: (error?: Error | null) => void): boolean;
  };

  // Improve public typing for consumers without relying on generic Duplex
  // types. The declared chunk type WIDENS the base signature (it includes the
  // base's byte chunk) rather than replacing it: `Duplex` is Node's non-generic
  // class on the Node build and `Duplex<Uint8Array, Uint8Array>` on the browser
  // build, and dropping the byte arm was not assignable to the latter.
  declare push: (chunk: TRead | Uint8Array | null, encoding?: string) => boolean;

  private _notifyPendingChunkWaiter(): void {
    if (!this._pendingChunkResolve) {
      return;
    }
    const resolve = this._pendingChunkResolve;
    this._pendingChunkResolve = undefined;
    this._pendingChunkPromise = undefined;
    resolve();
  }

  private _waitForChunkSignal(): Promise<void> {
    if (this._pendingChunkPromise) {
      return this._pendingChunkPromise;
    }
    this._pendingChunkPromise = new Promise<void>(resolve => {
      this._pendingChunkResolve = resolve;
    });
    return this._pendingChunkPromise;
  }

  private async _pullFixedLength(length: number): Promise<Uint8Array> {
    const queue = this._queue;
    let remaining = length;
    let firstChunk: Uint8Array | null = null;
    let chunks: Uint8Array[] | null = null;

    const appendChunk = (chunk: Uint8Array): void => {
      if (chunk.length === 0) {
        return;
      }

      if (!firstChunk) {
        firstChunk = chunk;
        return;
      }

      if (!chunks) {
        chunks = [firstChunk, chunk];
        return;
      }

      chunks.push(chunk);
    };

    while (remaining > 0) {
      while (queue.length === 0) {
        if (this.finished) {
          throw new Error("FILE_ENDED");
        }
        await this._waitForChunkSignal();
      }

      const toRead = Math.min(remaining, queue.length);
      appendChunk(queue.read(toRead));
      remaining -= toRead;

      if (queue.length === 0) {
        this._maybeReleaseWriteCallback();
      }
    }

    this._maybeReleaseWriteCallback();
    if (!firstChunk) {
      return EMPTY_UINT8ARRAY;
    }
    if (!chunks) {
      return firstChunk;
    }
    return concatUint8Arrays(chunks);
  }

  _write(chunk: Uint8Array | string, _encoding: string, callback: () => void): void {
    const data = typeof chunk === "string" ? utf8Encoder.encode(chunk) : chunk;
    this._queue.append(data);

    // Apply writable backpressure by deferring the callback when the input buffer is large.
    // Otherwise, release it immediately so producers can stream in more bytes.
    if (this._queue.length >= this._inputHighWaterMarkBytes) {
      this.cb = callback;
    } else {
      callback();
    }
    this._notifyPendingChunkWaiter();
    this.emit("chunk");
  }

  _read(): void {}

  protected _maybeReleaseWriteCallback(): void {
    // Only release a deferred write callback when we've drained enough data.
    // This provides bounded buffering while still preventing deadlocks.
    if (typeof this.cb === STR_FUNCTION && this._queue.length <= this._inputLowWaterMarkBytes) {
      const callback = this.cb as () => void;
      this.cb = undefined;
      callback();
    }
  }

  /**
   * The `eof` parameter is interpreted as `file_length` if the type is number
   * otherwise (i.e. Uint8Array) it is interpreted as a pattern signaling end of stream
   */
  stream(eof: number | Uint8Array, includeEof?: boolean): PassThrough {
    const p = new PassThrough({ highWaterMark: DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK });
    let done = false;
    let waitingDrain = false;

    const eofIsNumber = typeof eof === "number";
    let remainingBytes = eofIsNumber ? (eof as number) : 0;
    const pattern = eofIsNumber ? undefined : (eof as Uint8Array);
    const patternLen = pattern ? pattern.length : 0;
    const minTailBytes = eofIsNumber ? 0 : patternLen;

    const scanner = eofIsNumber ? undefined : new PatternScanner(pattern!);

    const cb = (): void => {
      this._maybeReleaseWriteCallback();
    };

    const onDrain = (): void => {
      waitingDrain = false;
      pull();
    };

    const pull = (): void => {
      if (done || waitingDrain) {
        return;
      }

      while (true) {
        const available = this._queue.length;
        if (!available) {
          break;
        }

        let packet: Uint8Array | undefined;

        if (eofIsNumber) {
          const toRead = Math.min(remainingBytes, available);
          if (toRead > 0) {
            packet = this._queue.read(toRead);
            remainingBytes -= toRead;
          }
          done = done || remainingBytes === 0;
        } else {
          const bufLen = this._queue.length;
          const match = scanner!.find(this._queue);
          if (match !== -1) {
            // store signature match byte offset to allow us to reference
            // this for zip64 offset
            this.match = match;
            const toRead = includeEof ? match + patternLen : match;
            if (toRead > 0) {
              packet = this._queue.read(toRead);
              scanner!.onConsume(toRead);
            }
            done = true;
          } else {
            // No match yet. Avoid rescanning bytes that can't start a match.
            scanner!.onNoMatch(bufLen);

            const len = bufLen - patternLen;
            if (len <= 0) {
              // Keep enough bytes to detect a split signature.
              if (
                this._queue.length === 0 ||
                (minTailBytes && this._queue.length <= minTailBytes)
              ) {
                cb();
              }
            } else {
              packet = this._queue.read(len);
              scanner!.onConsume(len);
            }
          }
        }

        if (!packet) {
          break;
        }

        const ok = p.write(packet);

        // If we drained the internal buffer (or kept only a minimal tail), allow upstream to continue.
        if (this._queue.length === 0 || (minTailBytes && this._queue.length <= minTailBytes)) {
          cb();
        }

        if (!ok) {
          waitingDrain = true;
          p.once("drain", onDrain);
          return;
        }

        if (done) {
          cb();
          this.removeListener("chunk", pull);
          p.end();
          return;
        }
      }

      if (!done) {
        if (this.finished) {
          this.removeListener("chunk", pull);
          cb();
          p.destroy(new Error("FILE_ENDED"));
        }
        return;
      }

      this.removeListener("chunk", pull);
      cb();
      p.end();
    };

    this.on("chunk", pull);
    pull();
    return p;
  }

  pull(eof: number | Uint8Array, includeEof?: boolean): Promise<Uint8Array> {
    if (eof === 0) {
      return Promise.resolve(EMPTY_UINT8ARRAY);
    }

    if (typeof eof === "number") {
      return this._pullFixedLength(eof);
    }

    const queue = this._queue;

    // Otherwise we wait for more data and fulfill directly from the internal queue.
    // This avoids constructing intermediate streams for small pulls (hot path).
    let firstChunk: Uint8Array | null = null;
    let chunks: Uint8Array[] | null = null;
    let pullStreamRejectHandler: (e: Error) => void;

    // Pattern scanning state (only used when eof is a pattern)
    const pattern = eof as Uint8Array;
    const patternLen = pattern.length;
    const scanner = new PatternScanner(pattern);

    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      pullStreamRejectHandler = (e: Error) => {
        this.__emittedError = e;
        cleanup();
        reject(e);
      };

      if (this.finished) {
        reject(new Error("FILE_ENDED"));
        return;
      }

      const cleanup = (): void => {
        this.removeListener("chunk", onChunk);
        this.removeListener("finish", onFinish);
        this.removeListener("error", pullStreamRejectHandler);
      };

      const finalize = (): void => {
        cleanup();
        settled = true;
        if (!firstChunk) {
          resolve(EMPTY_UINT8ARRAY);
          return;
        }
        if (!chunks) {
          resolve(firstChunk);
          return;
        }
        resolve(concatUint8Arrays(chunks));
      };

      const appendChunk = (chunk: Uint8Array): void => {
        if (chunk.length === 0) {
          return;
        }

        if (!firstChunk) {
          firstChunk = chunk;
          return;
        }

        if (!chunks) {
          chunks = [firstChunk, chunk];
          return;
        }

        chunks.push(chunk);
      };

      const onFinish = (): void => {
        if (settled) {
          return;
        }

        // Try one last time to drain anything already buffered.
        onChunk();

        if (!settled) {
          cleanup();
          reject(new Error("FILE_ENDED"));
        }
      };

      const onChunk = (): void => {
        while (queue.length > 0) {
          const bufLen = queue.length;
          const match = scanner.find(queue);
          if (match !== -1) {
            // store signature match byte offset to allow us to reference
            // this for zip64 offset
            this.match = match;
            const toRead = includeEof ? match + patternLen : match;
            if (toRead > 0) {
              appendChunk(queue.read(toRead));
              scanner.onConsume(toRead);
            }

            if (queue.length === 0 || (patternLen && queue.length <= patternLen)) {
              this._maybeReleaseWriteCallback();
            }
            finalize();
            return;
          }

          // No match yet. Avoid rescanning bytes that can't start a match.
          scanner.onNoMatch(bufLen);

          const safeLen = bufLen - patternLen;
          if (safeLen <= 0) {
            // Keep enough bytes to detect a split signature.
            this._maybeReleaseWriteCallback();
            return;
          }

          appendChunk(queue.read(safeLen));
          scanner.onConsume(safeLen);

          if (queue.length === 0 || (patternLen && queue.length <= patternLen)) {
            this._maybeReleaseWriteCallback();
            return;
          }
        }
      };

      this.once("error", pullStreamRejectHandler);
      this.on("chunk", onChunk);
      this.once("finish", onFinish);

      // Attempt immediate fulfillment from any already-buffered data.
      onChunk();

      // Race fix: `finish` can fire between the early `this.finished` check and
      // registering the listener above. If that happens and we don't have enough
      // buffered bytes to fulfill the pull, the Promise would never settle.
      if (this.finished) {
        onFinish();
      }
    });
  }

  pullUntil(pattern: Uint8Array, includeEof?: boolean): Promise<Uint8Array> {
    return this.pull(pattern, includeEof);
  }
}

// Structural public API for PullStream-like consumers.
//
// NOTE: Do not use the PullStream class type directly for cross-environment typing,
// because it contains protected members (nominal typing).
export type PullStreamPublicApi = {
  buffer: Uint8Array;
  cb?: () => void;
  finished: boolean;
  match?: number;
  stream(eof: number | Uint8Array, includeEof?: boolean): PassThrough;
  pull(eof: number | Uint8Array, includeEof?: boolean): Promise<Uint8Array>;
  pullUntil(pattern: Uint8Array, includeEof?: boolean): Promise<Uint8Array>;
};

export interface StreamUntilValidatedDataDescriptorSource {
  getLength(): number;
  read(length: number): Uint8Array;
  /** Optional: zero-copy chunk views for streaming writes. */
  peekChunks?(length: number): Uint8Array[];
  /** Optional: consume bytes previously written from peekChunks(). */
  discard?(length: number): void;
  indexOfPattern(pattern: Uint8Array, startIndex: number): number;
  peekUint32LE(offset: number): number | null;
  isFinished(): boolean;
  onDataAvailable(cb: () => void): () => void;
  maybeReleaseWriteCallback?: () => void;
}

export interface StreamUntilValidatedDataDescriptorOptions {
  source: StreamUntilValidatedDataDescriptorSource;
  dataDescriptorSignature: Uint8Array;
  /** Keep enough bytes to validate: descriptor(16) + next record sig(4) = 20. */
  keepTailBytes?: number;
  errorMessage?: string;
}

/**
 * Stream compressed file data until we reach a validated DATA_DESCRIPTOR boundary.
 *
 * This encapsulates the shared logic used by both Node and browser parsers.
 */
export function streamUntilValidatedDataDescriptor(
  options: StreamUntilValidatedDataDescriptorOptions
): PassThrough {
  const { source, dataDescriptorSignature } = options;
  const keepTailBytes = options.keepTailBytes ?? 20;
  const errorMessage = options.errorMessage ?? "FILE_ENDED: Data descriptor not found";

  const output = new PassThrough({ highWaterMark: DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK });
  let done = false;

  let waitingDrain = false;

  // Total number of compressed bytes already emitted for this entry.
  let bytesEmitted = 0;
  const scanner = new PatternScanner(dataDescriptorSignature);

  let unsubscribe: (() => void) | undefined;

  const cleanup = (): void => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  };

  const onDrain = (): void => {
    waitingDrain = false;
    pull();
  };

  const pull = (): void => {
    if (done) {
      return;
    }

    if (waitingDrain) {
      return;
    }

    let available = source.getLength();
    if (available === 0) {
      // If we have no buffered data, ensure upstream isn't stuck behind a
      // deferred write callback.
      source.maybeReleaseWriteCallback?.();
    }
    while (available > 0) {
      // Try to find and validate a descriptor candidate.
      let pendingCandidate = false;
      while (true) {
        const idx = scanner.find(source);
        if (idx === -1) {
          break;
        }

        // Need 16 bytes for descriptor + 4 bytes for next record signature.
        const nextSigOffset = idx + 16;
        if (nextSigOffset + 4 <= available) {
          const nextSig = source.peekUint32LE(nextSigOffset);
          const descriptorCompressedSize = source.peekUint32LE(idx + 8);
          const expectedCompressedSize = (bytesEmitted + idx) >>> 0;

          if (
            nextSig !== null &&
            descriptorCompressedSize !== null &&
            isValidZipRecordSignature(nextSig) &&
            descriptorCompressedSize === expectedCompressedSize
          ) {
            if (idx > 0) {
              if (source.peekChunks && source.discard) {
                const parts = source.peekChunks(idx);
                let written = 0;
                for (const part of parts) {
                  const ok = output.write(part);
                  written += part.length;
                  if (!ok) {
                    waitingDrain = true;
                    output.once("drain", onDrain);
                    break;
                  }
                }
                if (written > 0) {
                  source.discard(written);
                  bytesEmitted += written;
                  scanner.onConsume(written);
                }
                if (waitingDrain) {
                  return;
                }
              } else {
                const ok = output.write(source.read(idx));
                bytesEmitted += idx;
                scanner.onConsume(idx);

                if (!ok) {
                  waitingDrain = true;
                  output.once("drain", onDrain);
                  return;
                }
              }
            }

            done = true;
            source.maybeReleaseWriteCallback?.();
            cleanup();
            output.end();
            return;
          }

          scanner.searchFrom = idx + 1;
          continue;
        }

        // Not enough bytes to validate yet. Re-check this candidate once
        // more bytes arrive. Mark as pending so we don't accidentally
        // advance searchFrom past it via onNoMatch().
        scanner.searchFrom = idx;
        pendingCandidate = true;

        // If the source is finished (no more bytes will arrive), attempt a
        // relaxed validation: accept the descriptor without checking the
        // next-record signature. This handles the case where the descriptor
        // is at the very end of the available data (e.g. the last entry in
        // the ZIP, or the next-record header hasn't been fully buffered yet
        // due to extreme input fragmentation).
        if (source.isFinished() && idx + 16 <= available) {
          const descriptorCompressedSize = source.peekUint32LE(idx + 8);
          const expectedCompressedSize = (bytesEmitted + idx) >>> 0;

          if (
            descriptorCompressedSize !== null &&
            descriptorCompressedSize === expectedCompressedSize
          ) {
            // Descriptor compressed size matches — accept it.
            if (idx > 0) {
              if (source.peekChunks && source.discard) {
                const parts = source.peekChunks(idx);
                let written = 0;
                for (const part of parts) {
                  output.write(part);
                  written += part.length;
                }
                if (written > 0) {
                  source.discard(written);
                  bytesEmitted += written;
                  scanner.onConsume(written);
                }
              } else {
                output.write(source.read(idx));
                bytesEmitted += idx;
                scanner.onConsume(idx);
              }
            }

            done = true;
            source.maybeReleaseWriteCallback?.();
            cleanup();
            output.end();
            return;
          }
        }

        break;
      }

      // Only advance the scanner's search cursor when there is no pending
      // candidate waiting for more bytes. Without this guard, onNoMatch()
      // would move searchFrom past the candidate, causing it to be skipped
      // and the entry data to be flushed — leading to FILE_ENDED.
      if (!pendingCandidate) {
        scanner.onNoMatch(available);
      }

      // Flush most of the buffered data but keep a tail so a potential signature
      // split across chunks can still be detected/validated.
      // When a pending candidate exists, do NOT flush past it.
      let maxFlush = available - keepTailBytes;
      if (pendingCandidate) {
        maxFlush = Math.min(maxFlush, scanner.searchFrom);
      }
      const flushLen = Math.max(0, maxFlush);
      if (flushLen > 0) {
        if (source.peekChunks && source.discard) {
          const parts = source.peekChunks(flushLen);
          let written = 0;
          for (const part of parts) {
            const ok = output.write(part);
            written += part.length;
            if (!ok) {
              waitingDrain = true;
              output.once("drain", onDrain);
              break;
            }
          }

          if (written > 0) {
            source.discard(written);
            bytesEmitted += written;
            available -= written;
            scanner.onConsume(written);
          }

          if (available <= keepTailBytes) {
            source.maybeReleaseWriteCallback?.();
          }

          return;
        }

        const ok = output.write(source.read(flushLen));
        bytesEmitted += flushLen;
        available -= flushLen;
        scanner.onConsume(flushLen);

        if (available <= keepTailBytes) {
          source.maybeReleaseWriteCallback?.();
        }

        if (!ok) {
          waitingDrain = true;
          output.once("drain", onDrain);
        }

        return;
      }

      // Need more data.
      // IMPORTANT: If we keep a tail and cannot flush anything yet, we must still
      // release upstream write callbacks; otherwise the producer can deadlock waiting
      // for backpressure while we wait for more bytes to arrive.
      source.maybeReleaseWriteCallback?.();
      break;
    }

    if (!done && source.isFinished()) {
      done = true;
      cleanup();
      output.destroy(new Error(errorMessage));
    }
  };

  unsubscribe = source.onDataAvailable(pull);
  queueMicrotask(pull);
  return output;
}

// =============================================================================
// Shared Parse Loop (used by Node + Browser)
// =============================================================================

export interface ZipEntry extends PassThrough {
  path: string;
  props: EntryProps;
  /**
   * Entry type. Note: Streaming parser can only reliably detect "Directory" vs "File".
   * "Symlink" detection requires Central Directory access (use buffer-based parsing).
   */
  type: "Directory" | "File" | "Symlink";
  vars: EntryVars;
  extraFields: ZipExtraFields;
  size?: number;
  __autodraining?: boolean;
  autodrain: () => DrainStream;
  buffer: () => Promise<Uint8Array>;
}

export interface ParseIO {
  pull(length: number): Promise<Uint8Array>;
  pullUntil(pattern: Uint8Array, includeEof?: boolean): Promise<Uint8Array>;
  stream(length: number): PassThrough;
  streamUntilDataDescriptor(): PassThrough;
  setDone(): void;
}

export interface ParseEmitter {
  emitEntry(entry: ZipEntry): void;
  pushEntry(entry: ZipEntry): void;
  pushEntryIfPiped(entry: ZipEntry): void;
  emitCrxHeader(header: CrxHeader): void;
  emitError(err: Error): void;
  emitClose(): void;
}

export type InflateFactory = () => Transform | Duplex | PassThrough;

/**
 * Synchronous inflate function type for small file optimization.
 * When provided and file size is below threshold, this will be used
 * instead of streaming decompression for better performance.
 */
export type InflateRawSync = (data: Uint8Array) => Uint8Array;

export async function runParseLoop(
  opts: ParseOptions,
  io: ParseIO,
  emitter: ParseEmitter,
  inflateFactory: InflateFactory,
  state: ParseDriverState,
  inflateRawSync?: InflateRawSync
): Promise<void> {
  const thresholdBytes = opts.thresholdBytes ?? DEFAULT_PARSE_THRESHOLD_BYTES;

  await runParseLoopCore(opts, io, emitter, state, async (_opts, _io, _emitter, _state) => {
    await readFileRecord(opts, io, emitter, inflateFactory, state, thresholdBytes, inflateRawSync);
  });
}

async function pumpKnownCompressedSizeToEntry(
  io: ParseIO,
  inflater: Transform | Duplex | PassThrough,
  entry: ZipEntry,
  compressedSize: number
): Promise<void> {
  // Keep chunks reasonably large to reduce per-await overhead.
  const CHUNK_SIZE = 256 * 1024;

  let remaining = compressedSize;
  let err: Error | null = null;

  const onError = (e: Error): void => {
    err = e;
  };

  inflater.once("error", onError);
  entry.once("error", onError);

  let skipping = false;
  let waitResolve: (() => void) | null = null;

  const cleanupWaitListeners = (): void => {
    try {
      inflater.removeListener("drain", onDrain);
    } catch {
      // ignore
    }
    try {
      entry.removeListener("__autodrain", onAutodrain);
    } catch {
      // ignore
    }
    try {
      entry.removeListener("close", onClose);
    } catch {
      // ignore
    }
  };

  const resolveWait = (): void => {
    const resolve = waitResolve;
    if (!resolve) {
      return;
    }
    waitResolve = null;
    cleanupWaitListeners();
    resolve();
  };

  const onDrain = (): void => {
    resolveWait();
  };
  const onAutodrain = (): void => {
    resolveWait();
  };
  const onClose = (): void => {
    resolveWait();
  };

  const waitForDrainOrSkipSignal = async (): Promise<void> => {
    await new Promise<void>(resolve => {
      waitResolve = resolve;

      inflater.once("drain", onDrain);
      entry.once("__autodrain", onAutodrain);
      entry.once("close", onClose);

      // Guard against a race where __autodrain was emitted between the
      // inflater.write() call and the listener registration above.
      // Without this check the pump can deadlock on Windows where
      // event-loop scheduling differs from macOS/Linux.
      if (entry.__autodraining || entry.destroyed) {
        resolveWait();
      }
    });
  };

  const switchToSkip = async (): Promise<void> => {
    if (skipping) {
      return;
    }
    skipping = true;

    // Stop forwarding decompressed output. We only need to advance the ZIP cursor.
    try {
      inflater.unpipe(entry);
    } catch {
      // ignore
    }

    // End the entry as early as possible so downstream drain resolves quickly.
    try {
      if (!entry.writableEnded && !entry.destroyed) {
        entry.end();
      }
    } catch {
      // ignore
    }

    // Stop the inflater to avoid work/backpressure.
    try {
      inflater.destroy();
    } catch {
      // ignore
    }
  };

  try {
    // Pipe decompressed output into the entry stream.
    inflater.pipe(entry);

    while (remaining > 0) {
      if (err) {
        throw toError(err);
      }

      // If downstream decides to autodrain mid-entry (common when a consumer bails out
      // early due to a limit), stop inflating and just skip the remaining compressed bytes.
      if (!skipping && (entry.__autodraining || entry.destroyed)) {
        await switchToSkip();
      }

      const toPull = Math.min(CHUNK_SIZE, remaining);
      const chunk = await io.pull(toPull);
      if (chunk.length !== toPull) {
        throw new Error("FILE_ENDED");
      }

      remaining -= chunk.length;

      if (!skipping) {
        const ok = inflater.write(chunk);
        if (!ok) {
          await waitForDrainOrSkipSignal();
        }
      }
    }

    if (!skipping) {
      inflater.end();
    }

    // Wait for all writes to complete (not for consumption).
    await awaitEntryCompletion(entry);
  } finally {
    inflater.removeListener("error", onError);
    entry.removeListener("error", onError);
  }
}

async function readFileRecord(
  opts: ParseOptions,
  io: ParseIO,
  emitter: ParseEmitter,
  inflateFactory: InflateFactory,
  state: ParseDriverState,
  thresholdBytes: number,
  inflateRawSync?: InflateRawSync
): Promise<void> {
  const {
    vars: headerVars,
    fileNameBuffer,
    extraFieldData
  } = await readLocalFileHeader(async l => io.pull(l));
  const vars = headerVars;

  if (state.crxHeader) {
    vars.crxHeader = state.crxHeader;
  }

  // Parse extra fields first so we can use Unicode Path Extra Field for decoding
  const zipVars: ZipVars = {
    uncompressedSize: vars.uncompressedSize ?? 0,
    compressedSize: vars.compressedSize ?? 0
  };
  const extra = parseExtraField(extraFieldData, zipVars);

  // Write back ZIP64-corrected sizes so downstream code uses the real values
  // instead of the 0xFFFFFFFF sentinel for entries > 4GB.
  vars.uncompressedSize = zipVars.uncompressedSize;
  vars.compressedSize = zipVars.compressedSize;

  const decoder = opts.encoding ? resolveZipStringCodec(opts.encoding) : undefined;

  // Decode filename: UTF-8 flag → Unicode extra field → CP437 (or custom decoder)
  const fileName = decodeZipPath(fileNameBuffer, vars.flags, extra, decoder);

  const entry = new PassThrough({
    highWaterMark: DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK
  }) as ZipEntry;
  let autodraining = false;

  entry.autodrain = function () {
    autodraining = true;
    entry.__autodraining = true;
    // Signal producers that downstream has switched to drain mode.
    // This helps avoid deadlocks if the producer is waiting on backpressure.
    entry.emit("__autodrain");
    return autodrain(entry);
  };

  entry.buffer = function () {
    return bufferStream(entry);
  };

  entry.path = fileName;
  entry.props = buildZipEntryProps(fileName, fileNameBuffer, vars.flags) as EntryProps;
  entry.type = getZipEntryType(fileName, vars.uncompressedSize ?? 0);

  if (opts.verbose) {
    if (entry.type === "Directory") {
      console.log("   creating:", fileName);
    } else if (entry.type === "File") {
      if (vars.compressionMethod === 0) {
        console.log(" extracting:", fileName);
      } else {
        console.log("  inflating:", fileName);
      }
    }
  }

  vars.lastModifiedDateTime = resolveZipEntryLastModifiedDateTime(
    {
      flags: vars.flags,
      uncompressedSize: vars.uncompressedSize ?? 0,
      lastModifiedDate: vars.lastModifiedDate,
      lastModifiedTime: vars.lastModifiedTime
    },
    extra
  );

  entry.vars = vars;
  entry.extraFields = extra;
  entry.__autodraining = autodraining;

  const fileSizeKnown = isFileSizeKnown(vars.flags, vars.compressedSize);
  if (fileSizeKnown) {
    entry.size = vars.uncompressedSize ?? 0;
  }

  if (opts.forceStream) {
    emitter.pushEntry(entry);
  } else {
    emitter.emitEntry(entry);
    emitter.pushEntryIfPiped(entry);
  }

  if (opts.verbose) {
    console.log({
      filename: fileName,
      vars: vars,
      extraFields: entry.extraFields
    });
  }

  // Encrypted entries store raw ciphertext in place of compressed data.
  // Decompression must be skipped here; decryption + decompression is handled
  // downstream by processEntryData / processEntryDataStream.
  const isEncrypted = ((vars.flags ?? 0) & 0x01) !== 0 || vars.compressionMethod === 99;

  // Whether the entry payload requires inflate (deflate decompression).
  // False for STORE (method 0), encrypted entries, and autodraining.
  const needsInflate = vars.compressionMethod !== 0 && !isEncrypted && !autodraining;

  // Small file optimization: use sync decompression if:
  // 1. Entry sizes are trusted (no data descriptor)
  // 2. File size is known and below threshold
  // 3. inflateRawSync is provided
  // 4. Entry needs inflate (not STORE, not encrypted, not autodraining)
  //
  // We require BOTH compressedSize and uncompressedSize <= thresholdBytes.
  // This prevents materializing large highly-compressible files in memory,
  // which can cause massive peak RSS and negate streaming backpressure.
  const sizesTrusted = !hasDataDescriptorFlag(vars.flags);
  const compressedSize = vars.compressedSize ?? 0;
  const uncompressedSize = vars.uncompressedSize ?? 0;

  const useSmallFileOptimization =
    sizesTrusted &&
    fileSizeKnown &&
    inflateRawSync &&
    needsInflate &&
    compressedSize <= thresholdBytes &&
    uncompressedSize <= thresholdBytes;

  if (useSmallFileOptimization) {
    // Read compressed data directly and decompress synchronously
    const compressedData = await io.pull(compressedSize);
    const decompressedData = inflateRawSync!(compressedData);
    entry.end(decompressedData);
    // Wait for entry stream write to complete (not for read/consume).
    await awaitEntryCompletion(entry);
    return;
  }

  const inflater = needsInflate
    ? inflateFactory()
    : new PassThrough({ highWaterMark: DEFAULT_UNZIP_STREAM_HIGH_WATER_MARK });

  if (fileSizeKnown) {
    await pumpKnownCompressedSizeToEntry(io, inflater, entry, vars.compressedSize ?? 0);
    // If the entry has a data descriptor flag, consume it after pumping.
    // compressedSize > 0 made us take this path, but the data descriptor
    // still follows the compressed data in the stream and must be skipped.
    if (hasDataDescriptorFlag(vars.flags)) {
      const dd = await readDataDescriptor(async l => io.pull(l));
      if (!entry.size) {
        entry.size = dd.uncompressedSize ?? 0;
      }
    }
    return;
  }

  // pipeline() destroys all streams if any stream errors or closes early.
  // If the entry was destroyed by the consumer, pipeline rejects with
  // ERR_STREAM_PREMATURE_CLOSE. This typically happens when the entry's
  // writable side is force-destroyed and the entire parse operation is
  // being torn down (abort/error).
  try {
    await pipeline(io.streamUntilDataDescriptor(), inflater, entry);
  } catch (pipelineErr) {
    if (!isPrematureCloseError(pipelineErr)) {
      throw pipelineErr;
    }
    // Entry was destroyed — attempt to read the data descriptor; if it
    // fails (cursor misaligned), swallow the error since the entry was
    // abandoned and the operation is ending.
    try {
      const dd = await readDataDescriptor(async l => io.pull(l));
      entry.size = dd.uncompressedSize ?? 0;
    } catch {
      // Cursor misaligned — not recoverable but not worth surfacing.
    }
    return;
  }
  const dd = await readDataDescriptor(async l => io.pull(l));
  entry.size = dd.uncompressedSize ?? 0;
}
