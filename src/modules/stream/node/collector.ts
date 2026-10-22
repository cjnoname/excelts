/**
 * Node.js Stream - Collector
 *
 * A writable stream that collects all chunks.
 */

import { Writable } from "stream";

import { toBinaryChunk } from "@stream/core/binary-chunk";
import { StreamTypeError } from "@stream/errors";
import type { WritableStreamOptions, ICollector } from "@stream/types";
import { chunksToString, concatUint8Arrays } from "@utils/binary";

// =============================================================================
// Collector Stream - Collects all chunks into an array
// =============================================================================

/**
 * A writable stream that collects all chunks
 */
export class Collector<T = Uint8Array> extends Writable {
  public chunks: T[];

  constructor(options?: WritableStreamOptions) {
    // The write handler collects into a closed-over array exposed as
    // `this.chunks` after construction, mirroring the browser Collector.
    const chunks: T[] = [];
    super({
      ...options,
      objectMode: options?.objectMode ?? true,
      write(chunk: T, _encoding: string, callback: (error?: Error | null) => void) {
        chunks.push(chunk);
        callback();
      }
    });
    this.chunks = chunks;
  }

  // `node:stream`'s Writable takes any chunk. The collector's element type
  // applies to what is written, as it does to `chunks` and as the browser
  // Collector's does; the arguments are passed through unchanged.
  override write(chunk: T, callback?: (error?: Error | null) => void): boolean;
  override write(
    chunk: T,
    encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void
  ): boolean;
  override write(chunk: T, encodingOrCallback?: any, callback?: any): boolean {
    return super.write(chunk, encodingOrCallback, callback);
  }

  override end(callback?: () => void): this;
  override end(chunk: T, callback?: () => void): this;
  override end(chunk: T, encoding?: BufferEncoding, callback?: () => void): this;
  override end(chunkOrCallback?: any, encodingOrCallback?: any, callback?: any): this {
    return super.end(chunkOrCallback, encodingOrCallback, callback);
  }

  /**
   * Get all collected data as a single Uint8Array (for binary mode)
   */
  toUint8Array(): Uint8Array {
    const chunks = this.chunks;
    const len = chunks.length;
    if (len === 0) {
      return new Uint8Array(0);
    }

    const binaryChunks = new Array<Uint8Array>(len);
    let totalLength = 0;
    for (let i = 0; i < len; i++) {
      const normalized = toBinaryChunk(chunks[i]);
      if (!normalized) {
        throw new StreamTypeError("Uint8Array", "non-binary data");
      }
      binaryChunks[i] = normalized;
      totalLength += normalized.length;
    }

    if (len === 1) {
      return binaryChunks[0]!;
    }

    return concatUint8Arrays(binaryChunks, totalLength);
  }

  /**
   * Get all collected data as a string
   */
  override toString(): string {
    return chunksToString(this.chunks, () => this.toUint8Array());
  }

  /**
   * Whether the collector has finished receiving data
   */
  get isFinished(): boolean {
    return this.writableFinished;
  }
}

/**
 * Create a collector stream
 */
export function createCollector<T = Uint8Array>(options?: WritableStreamOptions): ICollector<T> {
  return new Collector<T>(options);
}
