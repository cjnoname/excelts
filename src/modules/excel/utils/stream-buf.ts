/**
 * StreamBuf - Cross-Platform Multi-purpose Read-Write Stream
 *
 * A unified implementation that works in both Node.js and Browser environments
 * using the cross-platform EventEmitter from modules/stream.
 *
 * Features:
 * - As MemBuf: write data, then call toBuffer() to consolidate
 * - As StreamHub: pipe to multiple writable streams
 * - As readable stream: feed data into writable part and read from it
 */

import { ExcelNotSupportedError, InvalidValueTypeError } from "@excel/errors";
import { getTextDecoder, uint8ArrayToNodeBufferView } from "@utils/binary";
import { EventEmitter } from "@utils/event-emitter";
import { StringBuf } from "@utils/string-buf";

// =============================================================================
// Data Chunks - encapsulating incoming data
// =============================================================================

/**
 * Encoding label accepted by the buffer helpers. Writing always encodes UTF-8
 * (that is all `TextEncoder` supports); reading goes through `TextDecoder`, so
 * any WHATWG label works. Spelled as a widened string union rather than Node's
 * `BufferEncoding` so the type does not drag `@types/node` into the browser
 * declaration graph.
 */
type TextEncoding = "utf-8" | "utf8" | (string & {});

// Node-style write/end completion callback. Invoked with an optional error;
// the return value is ignored.
type WriteCallback = (error?: Error) => void;

// Shared TextEncoder instance — avoid allocating a new one per StringChunk.toBuffer()
const sharedTextEncoder = new TextEncoder();

class StringChunk {
  private _data: string;
  private _buffer?: Uint8Array;

  constructor(data: string) {
    this._data = data;
  }

  get length(): number {
    return this.toBuffer().length;
  }

  copy(target: Uint8Array, targetOffset: number, offset: number, length: number): number {
    const buf = this.toBuffer();
    const bytesToCopy = Math.min(length, buf.length - offset);
    target.set(buf.subarray(offset, offset + bytesToCopy), targetOffset);
    return bytesToCopy;
  }

  toBuffer(): Uint8Array {
    if (!this._buffer) {
      this._buffer = sharedTextEncoder.encode(this._data);
    }
    return this._buffer;
  }
}

class StringBufChunk {
  private _data: StringBuf;

  constructor(data: StringBuf) {
    this._data = data;
  }

  get length(): number {
    return this._data.length;
  }

  copy(target: Uint8Array, targetOffset: number, offset: number, length: number): number {
    const buf = this.toBuffer();
    const bytesToCopy = Math.min(length, buf.length - offset);
    target.set(buf.subarray(offset, offset + bytesToCopy), targetOffset);
    return bytesToCopy;
  }

  toBuffer(): Uint8Array {
    return this._data.toBuffer();
  }
}

class BufferChunk {
  private _data: Uint8Array;

  constructor(data: Uint8Array) {
    this._data = data;
  }

  get length(): number {
    return this._data.length;
  }

  copy(target: Uint8Array, targetOffset: number, offset: number, length: number): number {
    const bytesToCopy = Math.min(length, this._data.length - offset);
    target.set(this._data.subarray(offset, offset + bytesToCopy), targetOffset);
    return bytesToCopy;
  }

  toBuffer(): Uint8Array {
    return this._data;
  }
}

type Chunk = StringChunk | StringBufChunk | BufferChunk;

// =============================================================================
// ReadWriteBuf - a single buffer supporting simple read-write
// =============================================================================

class ReadWriteBuf {
  size: number;
  buffer: Uint8Array;
  iRead: number;
  iWrite: number;

  constructor(size: number) {
    this.size = size;
    this.buffer = new Uint8Array(size);
    this.iRead = 0;
    this.iWrite = 0;
  }

  toBuffer(): Uint8Array {
    if (this.iRead === 0 && this.iWrite === this.size) {
      return this.buffer;
    }
    return this.buffer.subarray(this.iRead, this.iWrite);
  }

  get length(): number {
    return this.iWrite - this.iRead;
  }

  get eod(): boolean {
    return this.iRead === this.iWrite;
  }

  get full(): boolean {
    return this.iWrite === this.size;
  }

  read(size?: number): Uint8Array | null {
    if (size === 0) {
      return null;
    }

    if (size === undefined || size >= this.length) {
      const buf = this.toBuffer();
      this.iRead = this.iWrite;
      return buf;
    }

    const buf = this.buffer.subarray(this.iRead, this.iRead + size);
    this.iRead += size;
    return buf;
  }

  write(chunk: Chunk, offset: number, length: number): number {
    const size = Math.min(length, this.size - this.iWrite);
    chunk.copy(this.buffer, this.iWrite, offset, size);
    this.iWrite += size;
    return size;
  }
}

// =============================================================================
// StreamBuf Options
// =============================================================================

interface StreamBufOptions {
  bufSize?: number;
  batch?: boolean;
}

// =============================================================================
// StreamBuf - Cross-Platform Implementation
// =============================================================================

function nop() {}

/**
 * StreamBuf is a multi-purpose read-write stream that works in both
 * Node.js and Browser environments.
 *
 * It extends EventEmitter to provide stream-like events:
 * - 'data': emitted when data is written (flowing mode)
 * - 'readable': emitted when data is available to read
 * - 'finish': emitted when end() is called
 * - 'error': emitted on errors
 * - 'drain': emitted when buffer drains (after pipe)
 */
/**
 * A pipe destination: any writable-like sink with a Node-style `write`
 * (and optional `end`). The `...args: any[]` is the standard Node stream
 * callback signature, not a removable cast.
 */
interface PipeDestination {
  write: (...args: any[]) => unknown;
  end?: (...args: any[]) => unknown;
}

class StreamBuf extends EventEmitter {
  private bufSize: number;
  private buffers: ReadWriteBuf[];
  private batch: boolean;
  private corked: boolean;
  private paused: boolean;
  private encoding: string | null;
  private pipes: PipeDestination[];
  private _ended: boolean;
  // Native WritableStream support
  private _writableStreamWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _asyncWriteQueue: Promise<void> = Promise.resolve();

  constructor(options?: StreamBufOptions) {
    super();
    this.bufSize = options?.bufSize || 1024 * 1024;
    this.buffers = [];
    this.batch = options?.batch ?? false;
    this.corked = false;
    this.paused = false;
    this.encoding = null;
    this.pipes = [];
    this._ended = false;
  }

  /**
   * Returns true if the stream is writable (not ended)
   * Required for compatibility with Node.js pipe()
   */
  get writable(): boolean {
    return !this._ended;
  }

  /**
   * Consolidate all buffers into a single Uint8Array
   */
  toBuffer(): Uint8Array | null {
    switch (this.buffers.length) {
      case 0:
        return null;
      case 1:
        return this.buffers[0].toBuffer();
      default: {
        const totalLength = this.buffers.reduce((acc, buf) => acc + buf.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const rwBuf of this.buffers) {
          const buf = rwBuf.toBuffer();
          result.set(buf, offset);
          offset += buf.length;
        }
        return result;
      }
    }
  }

  private _getWritableBuffer(): ReadWriteBuf {
    if (this.buffers.length) {
      const last = this.buffers[this.buffers.length - 1];
      if (!last.full) {
        return last;
      }
    }
    const buf = new ReadWriteBuf(this.bufSize);
    this.buffers.push(buf);
    return buf;
  }

  private async _pipeChunk(chunk: Chunk): Promise<void> {
    const writePromises = this.pipes.map(
      (pipe: PipeDestination) =>
        new Promise<void>(resolve => {
          pipe.write(chunk.toBuffer(), () => resolve());
        })
    );
    await Promise.all(writePromises);
  }

  private _writeToBuffers(chunk: Chunk): void {
    let inPos = 0;
    const inLen = chunk.length;
    while (inPos < inLen) {
      const buffer = this._getWritableBuffer();
      inPos += buffer.write(chunk, inPos, inLen - inPos);
    }
  }

  /**
   * Write data to the stream
   */
  async write(
    data: Uint8Array | string | StringBuf | ArrayBuffer | ArrayBufferView,
    encoding?: TextEncoding | WriteCallback,
    callback?: WriteCallback
  ): Promise<boolean> {
    if (typeof encoding === "function") {
      callback = encoding;
    }
    callback = callback || nop;

    // Create chunk from data
    let chunk: Chunk;
    if (
      data instanceof StringBuf ||
      (data && (data as { constructor?: { name?: string } }).constructor?.name === "StringBuf")
    ) {
      chunk = new StringBufChunk(data as StringBuf);
    } else if (data instanceof Uint8Array) {
      chunk = new BufferChunk(data);
    } else if (ArrayBuffer.isView(data)) {
      chunk = new BufferChunk(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof ArrayBuffer) {
      chunk = new BufferChunk(new Uint8Array(data));
    } else if (typeof data === "string") {
      chunk = new StringChunk(data);
    } else {
      throw new InvalidValueTypeError(
        typeof data,
        "Chunk must be one of type String, Uint8Array, ArrayBuffer or StringBuf."
      );
    }

    // Handle piping and buffering
    if (this.pipes.length) {
      if (this.batch) {
        this._writeToBuffers(chunk);
        while (!this.corked && this.buffers.length > 1) {
          const buf = this.buffers.shift()!;
          await this._pipeChunk(new BufferChunk(buf.toBuffer()));
        }
      } else if (!this.corked) {
        await this._pipeChunk(chunk);
        callback();
      } else {
        this._writeToBuffers(chunk);
        queueMicrotask(() => callback!());
      }
    } else {
      const chunkBuffer = chunk.toBuffer();

      // Track whether the data has been delivered to a consumer.
      // When a consumer exists ("data" listeners or a native WritableStream),
      // the data is consumed externally and must NOT also be accumulated in
      // internal buffers — otherwise the buffers grow without bound (memory leak)
      // since no one ever calls read()/toBuffer() to drain them.
      let consumed = false;

      if (!this.paused && this.listenerCount("data") > 0) {
        this.emit("data", chunkBuffer);
        consumed = true;
      }

      // Also write to native WritableStream if connected
      if (this._writableStreamWriter) {
        this._asyncWriteQueue = this._asyncWriteQueue.then(() =>
          this._writableStreamWriter!.write(chunkBuffer)
        );
        consumed = true;
      }

      // Only buffer internally when no consumer has received the data.
      // This keeps StreamBuf working as a memory buffer (write then read/toBuffer)
      // while preventing unbounded growth when used as an event-driven pass-through.
      if (!consumed) {
        this._writeToBuffers(chunk);
        this.emit("readable");
      }

      callback();
    }

    return true;
  }

  /**
   * Cork the stream - buffer writes until uncork
   */
  cork(): void {
    this.corked = true;
  }

  private _flush(): void {
    if (this.pipes.length) {
      const flushAll = async () => {
        while (this.buffers.length) {
          const buf = this.buffers.shift()!;
          await this._pipeChunk(new BufferChunk(buf.toBuffer()));
        }
      };
      flushAll().catch(err => this.emit("error", err));
    }
  }

  /**
   * Uncork the stream - flush buffered writes
   */
  uncork(): void {
    this.corked = false;
    this._flush();
  }

  /**
   * End the stream
   */
  end(
    chunk?: Uint8Array | string | StringBuf | ArrayBuffer | ArrayBufferView,
    encoding?: TextEncoding,
    callback?: WriteCallback
  ): void {
    const writeComplete = (error?: Error) => {
      if (error) {
        callback?.(error);
        return;
      }

      this._ended = true;
      this._flush();
      this.pipes.forEach((pipe: PipeDestination) => {
        if (typeof pipe.end === "function") {
          pipe.end();
        }
      });

      // If we have a native WritableStream, wait for all async writes to complete
      if (this._writableStreamWriter) {
        this._asyncWriteQueue
          .then(() => this._writableStreamWriter!.close())
          .then(() => {
            this.emit("finish");
            this.emit("close");
          })
          .catch(err => {
            this.emit("error", err);
          });
      } else {
        this.emit("finish");
        this.emit("close");
      }
    };

    if (chunk) {
      this.write(chunk, encoding, writeComplete);
    } else {
      writeComplete();
    }
  }

  /**
   * Read from the stream
   */
  read(size?: number): Uint8Array {
    if (size) {
      const buffers: Uint8Array[] = [];
      let remaining = size;
      while (remaining && this.buffers.length && !this.buffers[0].eod) {
        const first = this.buffers[0];
        const buffer = first.read(remaining);
        if (buffer) {
          remaining -= buffer.length;
          buffers.push(buffer);
        }
        if (first.eod && first.full) {
          this.buffers.shift();
        }
      }
      return uint8ArrayToNodeBufferView(concatUint8Arrays(buffers));
    }

    const buffers = this.buffers.map(buf => buf.toBuffer()).filter(Boolean) as Uint8Array[];
    this.buffers = [];
    return uint8ArrayToNodeBufferView(concatUint8Arrays(buffers));
  }

  /**
   * Read from the stream and return as string.
   * Cross-platform compatible - works identically in Node.js and Browser.
   */
  readString(encoding?: TextEncoding): string {
    const enc = encoding ?? (this.encoding as TextEncoding) ?? "utf-8";
    const buf = this.read();
    return getTextDecoder(enc).decode(buf);
  }

  /**
   * Set encoding for string reads
   */
  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  /**
   * Pause the stream
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume the stream
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * Check if stream is paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Pipe to a writable stream
   */
  pipe<T extends { write: (...args: any[]) => any; end?: (...args: any[]) => any }>(
    destination: T
  ): T {
    this.pipes.push(destination);
    if (!this.paused && this.buffers.length) {
      this.end();
    }
    return destination;
  }

  /**
   * Pipe to a native WritableStream (browser Streams API).
   * This properly handles async writes and waits for completion before finish.
   */
  pipeTo(writableStream: WritableStream<Uint8Array>): void {
    this._writableStreamWriter = writableStream.getWriter();
  }

  /**
   * Remove a piped destination
   */
  unpipe(destination: PipeDestination): void {
    this.pipes = this.pipes.filter(pipe => pipe !== destination);
  }

  /**
   * Put data back at the front (not implemented)
   */
  unshift(): void {
    throw new ExcelNotSupportedError("unshift", "Not implemented");
  }

  /**
   * Wrap a stream (not implemented)
   */
  wrap(): void {
    throw new ExcelNotSupportedError("wrap", "Not implemented");
  }

  /**
   * Push data to the stream (alias for write)
   */
  push(chunk: Uint8Array | string | StringBuf | ArrayBuffer | ArrayBufferView | null): boolean {
    if (chunk !== null) {
      this.write(chunk);
    }
    return true;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Concatenate multiple Uint8Arrays into one
 * Returns Buffer in Node.js for better toString() compatibility
 */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) {
    return new Uint8Array(0);
  }
  if (arrays.length === 1) {
    return arrays[0];
  }

  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export { StreamBuf };
