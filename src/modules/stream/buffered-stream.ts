/**
 * Buffered Stream
 *
 * A Duplex-like stream that manages internal buffering with chunk-based read/write operations.
 * Works identically in both browser and Node.js environments.
 */

import { StreamStateError } from "@stream/errors";
import type { BufferedStreamOptions, DataChunk } from "@stream/types";
import { textEncoder } from "@utils/binary";
import { EventEmitter } from "@utils/event-emitter";

export type { BufferedStreamOptions, DataChunk } from "@stream/types";

/**
 * Create a string-backed data chunk.
 */
export function createStringChunk(data: string): DataChunk {
  let buffer: Uint8Array | undefined;
  function toUint8Array(): Uint8Array {
    if (!buffer) {
      buffer = textEncoder.encode(data);
    }
    return buffer;
  }
  return {
    get length(): number {
      // Cache the buffer on first access
      return toUint8Array().length;
    },
    copy(target: Uint8Array, targetOffset: number, offset: number, length: number): number {
      const source = toUint8Array();
      const copyLength = Math.min(length, source.length - offset);
      target.set(source.subarray(offset, offset + copyLength), targetOffset);
      return copyLength;
    },
    toUint8Array
  };
}

/**
 * Create a Uint8Array-backed data chunk.
 */
export function createByteChunk(data: Uint8Array): DataChunk {
  return {
    get length(): number {
      return data.length;
    },
    copy(target: Uint8Array, targetOffset: number, offset: number, length: number): number {
      const copyLength = Math.min(length, data.length - offset);
      target.set(data.subarray(offset, offset + copyLength), targetOffset);
      return copyLength;
    },
    toUint8Array(): Uint8Array {
      return data;
    }
  };
}

/**
 * Read-Write buffer for efficient chunk management
 */
class ReadWriteBuffer {
  private buffer: Uint8Array;
  private iRead: number = 0;
  private iWrite: number = 0;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.buffer = new Uint8Array(size);
  }

  get length(): number {
    return this.iWrite - this.iRead;
  }

  get isEOD(): boolean {
    return this.iRead === this.iWrite;
  }

  get isFull(): boolean {
    return this.iWrite === this.size;
  }

  read(size?: number): Uint8Array | null {
    if (size === 0) {
      return null;
    }

    if (size === undefined || size >= this.length) {
      const buf = this.toUint8Array();
      this.iRead = this.iWrite;
      return buf;
    }

    const buf = new Uint8Array(size);
    buf.set(this.buffer.subarray(this.iRead, this.iRead + size));
    this.iRead += size;
    return buf;
  }

  write(chunk: DataChunk, offset: number, length: number): number {
    const size = Math.min(length, this.size - this.iWrite);
    chunk.copy(this.buffer, this.iWrite, offset, size);
    this.iWrite += size;
    return size;
  }

  toUint8Array(): Uint8Array {
    if (this.iRead === 0 && this.iWrite === this.size) {
      return this.buffer;
    }
    // Use subarray for zero-copy view when returning whole remaining buffer
    return this.buffer.subarray(this.iRead, this.iWrite);
  }
}

/**
 * Browser-compatible Buffered Stream with efficient chunk management
 */
export class BufferedStream extends EventEmitter {
  private _chunks: DataChunk[] = [];
  private _chunkReadIndex: number = 0;
  private _buffers: ReadWriteBuffer[] = [];
  private _bufferReadIndex: number = 0;
  private readonly _batchSize: number;
  private _finished: boolean = false;
  private _destroyed: boolean = false;
  private _totalLength: number = 0;

  constructor(options: BufferedStreamOptions = {}) {
    super();
    this._batchSize = options.batchSize ?? 16384; // 16KB default
  }

  /**
   * Write data to the stream
   */
  write(chunk: Uint8Array | string): boolean {
    if (this._destroyed) {
      this.emit("error", new StreamStateError("write", "stream is destroyed"));
      return false;
    }

    if (this._finished) {
      this.emit("error", new StreamStateError("write", "stream has ended"));
      return false;
    }

    const dataChunk = typeof chunk === "string" ? createStringChunk(chunk) : createByteChunk(chunk);
    this._chunks.push(dataChunk);
    this._totalLength += dataChunk.length;
    return true;
  }

  /**
   * Read data from the stream
   */
  read(size?: number): Uint8Array | null {
    // Try to satisfy the read from existing buffers
    let buffer = this._getBuffer(size);

    if (!buffer) {
      // Create new buffers from pending chunks
      while (this._chunkReadIndex < this._chunks.length) {
        const chunk = this._chunks[this._chunkReadIndex++]!;
        this._addChunkToBuffers(chunk);
      }

      // Reset/compact chunk queue when drained
      if (this._chunkReadIndex === this._chunks.length) {
        this._chunks.length = 0;
        this._chunkReadIndex = 0;
      } else if (this._chunkReadIndex > 1024 && this._chunkReadIndex * 2 > this._chunks.length) {
        this._chunks = this._chunks.slice(this._chunkReadIndex);
        this._chunkReadIndex = 0;
      }

      buffer = this._getBuffer(size);
    }

    return buffer;
  }

  /**
   * Signal end of writes
   */
  end(chunk?: Uint8Array | string): void {
    if (this._destroyed || this._finished) {
      return;
    }

    if (chunk !== undefined) {
      this.write(chunk);
    }
    this._finished = true;
    this.emit("finish");
    this.emit("end");
  }

  /**
   * Destroy the stream
   */
  destroy(error?: Error): void {
    if (this._destroyed) {
      return;
    }

    this._destroyed = true;
    this._chunks = [];
    this._chunkReadIndex = 0;
    this._buffers = [];
    this._bufferReadIndex = 0;
    this._totalLength = 0;

    // Defer event emission via queueMicrotask to match Node.js process.nextTick behavior
    queueMicrotask(() => {
      if (error) {
        this.emit("error", error);
      }
      this.emit("close");
    });
  }

  /**
   * Get total buffered length
   */
  get bufferedLength(): number {
    return this._totalLength;
  }

  /**
   * Get buffer of specified size from internal buffers
   */
  private _getBuffer(size?: number): Uint8Array | null {
    while (this._bufferReadIndex < this._buffers.length) {
      const buf = this._buffers[this._bufferReadIndex]!;
      if (buf.isEOD) {
        // Drop the reference so a consumed batch can be collected before compaction.
        this._buffers[this._bufferReadIndex++] = undefined!;
        continue;
      }

      // Track length reduction
      const beforeLen = buf.length;
      const data = buf.read(size);
      this._totalLength -= beforeLen - buf.length;

      if (buf.isEOD) {
        this._buffers[this._bufferReadIndex++] = undefined!;
      }

      // Reset/compact buffer queue occasionally
      if (this._bufferReadIndex === this._buffers.length) {
        this._buffers.length = 0;
        this._bufferReadIndex = 0;
      } else if (this._bufferReadIndex > 1024 && this._bufferReadIndex * 2 > this._buffers.length) {
        this._buffers = this._buffers.slice(this._bufferReadIndex);
        this._bufferReadIndex = 0;
      }

      return data;
    }

    // Queue drained
    if (this._bufferReadIndex !== 0) {
      this._buffers.length = 0;
      this._bufferReadIndex = 0;
    }
    return null;
  }

  /**
   * Add chunk to internal buffers
   */
  private _addChunkToBuffers(chunk: DataChunk): void {
    let chunkOffset = 0;
    let chunkLength = chunk.length;

    while (chunkLength > 0) {
      if (this._buffers.length === 0 || this._buffers[this._buffers.length - 1].isFull) {
        this._buffers.push(new ReadWriteBuffer(this._batchSize));
      }

      const buffer = this._buffers[this._buffers.length - 1];
      const written = buffer.write(chunk, chunkOffset, chunkLength);

      chunkOffset += written;
      chunkLength -= written;
    }
  }

  /**
   * Get all buffered data as a single Uint8Array.
   * Consumes the internal buffers — after this call, `bufferedLength` is 0.
   */
  toUint8Array(): Uint8Array {
    // Fast path: no data
    if (this._totalLength === 0) {
      return new Uint8Array(0);
    }

    // Allocate exactly once, then copy remaining chunks/buffers.
    const out = new Uint8Array(this._totalLength);
    let offset = 0;

    // Older data first: what was already moved into buffers, then pending chunks.
    for (let i = this._bufferReadIndex; i < this._buffers.length; i++) {
      const buf = this._buffers[i]!;
      if (buf.isEOD) {
        continue;
      }
      const view = buf.toUint8Array();
      out.set(view, offset);
      offset += view.length;
    }

    for (let i = this._chunkReadIndex; i < this._chunks.length; i++) {
      const chunk = this._chunks[i]!;
      offset += chunk.copy(out, offset, 0, chunk.length);
    }

    // Reset internal state — data has been consumed.
    this._chunks = [];
    this._chunkReadIndex = 0;
    this._buffers = [];
    this._bufferReadIndex = 0;
    this._totalLength = 0;

    // Defensive: if internal counters drift, avoid returning trailing zeros.
    return offset === out.length ? out : out.subarray(0, offset);
  }

  /**
   * Check if stream is finished
   */
  get isFinished(): boolean {
    return this._finished;
  }

  /**
   * Check if stream is destroyed
   */
  get destroyed(): boolean {
    return this._destroyed;
  }
}
