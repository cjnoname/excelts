/**
 * Pull Stream
 *
 * A stream that allows pulling data from internal buffer with pattern matching.
 * Works identically in both browser and Node.js environments.
 */

import type { PullStreamOptions } from "@stream/types";
import { uint8ArrayIndexOf } from "@utils/binary";
import { EventEmitter } from "@utils/event-emitter";

export type { PullStreamOptions } from "@stream/types";

const EMPTY_U8 = new Uint8Array(0);

/**
 * Browser-compatible Pull Stream - Read data from buffer on demand with pattern matching
 */
export class PullStream extends EventEmitter {
  // Single growable buffer with read/write cursors.
  // IMPORTANT: never mutate bytes that have already been returned via subarray
  // (to keep views stable). When we need to reclaim prefix space, we allocate
  // a new buffer and copy the remaining bytes.
  private _buffer: Uint8Array = new Uint8Array(0);
  private _bufferReadIndex: number = 0;
  private _bufferWriteIndex: number = 0;
  protected finished: boolean = false;
  protected _match?: number;
  private _destroyed: boolean = false;
  // Backpressure: when buffer length exceeds highWaterMark, `write()` returns
  // false so producers know to slow down. `'drain'` fires once the buffer
  // drops below half the HWM (low-water mark). Defaults to Infinity for
  // backward compatibility — callers that opt in by passing `highWaterMark`
  // get bounded memory, callers that don't keep the legacy unbounded behaviour.
  private _highWaterMark: number = Infinity;
  private _needsDrain: boolean = false;

  constructor(options: PullStreamOptions = {}) {
    super();
    if (
      options.highWaterMark !== undefined &&
      options.highWaterMark > 0 &&
      Number.isFinite(options.highWaterMark)
    ) {
      this._highWaterMark = options.highWaterMark;
    }
  }

  /** Reset the internal buffer to empty. */
  private _resetBuffer(): void {
    this._buffer = EMPTY_U8;
    this._bufferReadIndex = 0;
    this._bufferWriteIndex = 0;
  }

  // Maintain legacy protected accessor for subclasses.
  // Returned value is a view of the readable region.
  protected get buffer(): Uint8Array {
    if (this._bufferReadIndex === this._bufferWriteIndex) {
      return EMPTY_U8;
    }
    return this._buffer.subarray(this._bufferReadIndex, this._bufferWriteIndex);
  }

  protected set buffer(buf: Uint8Array) {
    if (buf.length === 0) {
      this._resetBuffer();
      return;
    }

    this._buffer = buf;
    this._bufferReadIndex = 0;
    this._bufferWriteIndex = buf.length;
  }

  /**
   * Write data to the stream.
   *
   * Returns `false` when the buffer's readable size exceeds `highWaterMark`
   * (backpressure signal). Producers should pause and resume on the next
   * `'drain'` event.
   */
  write(chunk: Uint8Array): boolean {
    if (this._destroyed) {
      this.emit("error", new Error("Cannot write to destroyed stream"));
      return false;
    }

    const chunkLen = chunk.length;
    if (chunkLen === 0) {
      this.emit("chunk");
      return !this._needsDrain;
    }

    // Fast path: first write can reuse caller buffer without copy.
    if (this._buffer.length === 0) {
      this._buffer = chunk;
      this._bufferReadIndex = 0;
      this._bufferWriteIndex = chunkLen;
      this.emit("chunk");
      return this._evaluateBackpressure();
    }

    const required = this._bufferWriteIndex + chunkLen;
    if (required <= this._buffer.length) {
      this._buffer.set(chunk, this._bufferWriteIndex);
      this._bufferWriteIndex += chunkLen;
      this.emit("chunk");
      return this._evaluateBackpressure();
    }

    // Need a new buffer. We keep previously returned views stable by allocating.
    // Size it from the live data, not the old capacity: doubling the capacity
    // each time made it grow with total throughput even when little was buffered.
    const remaining = this._bufferWriteIndex - this._bufferReadIndex;
    const nextLength = remaining + chunkLen;
    const nextCap = Math.max(nextLength * 2, 1024);
    const next = new Uint8Array(nextCap);
    next.set(this._buffer.subarray(this._bufferReadIndex, this._bufferWriteIndex), 0);
    next.set(chunk, remaining);

    this._buffer = next;
    this._bufferReadIndex = 0;
    this._bufferWriteIndex = nextLength;
    this.emit("chunk");
    return this._evaluateBackpressure();
  }

  /**
   * Set `_needsDrain` based on current buffer size, return whether the
   * producer should keep writing (true) or pause (false).
   */
  private _evaluateBackpressure(): boolean {
    const readable = this._bufferWriteIndex - this._bufferReadIndex;
    if (readable >= this._highWaterMark) {
      this._needsDrain = true;
      return false;
    }
    return true;
  }

  /**
   * Internal: subclasses or pull paths must call this after consuming bytes
   * (advancing `_bufferReadIndex`) to potentially emit `'drain'`. Idempotent
   * and free when no backpressure is in effect.
   */
  protected _maybeEmitDrain(): void {
    if (!this._needsDrain) {
      return;
    }
    const readable = this._bufferWriteIndex - this._bufferReadIndex;
    // Low-water mark = half of HWM (classic Node Writable behaviour).
    if (readable * 2 < this._highWaterMark) {
      this._needsDrain = false;
      this.emit("drain");
    }
  }

  /**
   * Signal end of input
   */
  end(chunk?: Uint8Array): void {
    if (this._destroyed || this.finished) {
      return;
    }

    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.finished = true;
    this.emit("chunk", false);
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
    this._resetBuffer();

    // Wake up any pending pull() promises so they can see _destroyed and reject.
    // This MUST be synchronous — pending pull() promises depend on immediate wakeup.
    this.emit("chunk");

    // Defer error/close emission via queueMicrotask to match Node.js process.nextTick behavior
    queueMicrotask(() => {
      if (error) {
        this.emit("error", error);
      }
      this.emit("close");
    });
  }

  /**
   * Pull exactly N bytes from buffer, or pull until pattern is found
   */
  pull(size: number): Promise<Uint8Array>;
  pull(pattern: Uint8Array, includePattern?: boolean): Promise<Uint8Array>;
  pull(sizeOrPattern: number | Uint8Array, includePattern?: boolean): Promise<Uint8Array> {
    if (typeof sizeOrPattern === "number") {
      return this._pullSize(sizeOrPattern);
    }
    return this._pullPattern(sizeOrPattern, includePattern ?? false);
  }

  /**
   * Pull until pattern is found (alias for pull(pattern, includePattern))
   */
  pullUntil(pattern: Uint8Array, includePattern?: boolean): Promise<Uint8Array> {
    return this._pullPattern(pattern, includePattern ?? false);
  }

  private _pullSize(size: number): Promise<Uint8Array> {
    if (!Number.isInteger(size) || size < 0) {
      return Promise.reject(
        new RangeError(`PullStream.pull: size must be a non-negative integer, got ${size}`)
      );
    }
    return new Promise((resolve, reject) => {
      const tryPull = (): void => {
        if (this._destroyed) {
          reject(new Error("Stream destroyed"));
          return;
        }

        if (size === 0) {
          resolve(this._buffer.subarray(this._bufferReadIndex, this._bufferReadIndex));
          return;
        }

        const available = this._bufferWriteIndex - this._bufferReadIndex;
        if (available >= size) {
          const start = this._bufferReadIndex;
          const end = start + size;
          const result = this._buffer.subarray(start, end);
          this._bufferReadIndex = end;

          if (this._bufferReadIndex === this._bufferWriteIndex) {
            this._resetBuffer();
          }

          this._maybeEmitDrain();
          resolve(result);
          return;
        }

        if (this.finished) {
          // Return whatever we have
          const result =
            this._bufferReadIndex === this._bufferWriteIndex
              ? EMPTY_U8
              : this._buffer.subarray(this._bufferReadIndex, this._bufferWriteIndex);
          this._resetBuffer();
          resolve(result);
          return;
        }

        // Wait for more data
        this.once("chunk", tryPull);
      };

      tryPull();
    });
  }

  private _pullPattern(pattern: Uint8Array, includePattern: boolean): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const patternLen = pattern.length;
      // Bytes past the read position already scanned without a match, so a
      // retry only scans new data (backing up patternLen - 1 for a match that
      // straddles the boundary). Kept relative to the read position, not as a
      // buffer index: write() may move the unread bytes into a new buffer.
      let scanned = 0;

      const tryPull = (): void => {
        if (this._destroyed) {
          reject(new Error("Stream destroyed"));
          return;
        }

        // Match empty pattern without consuming anything.
        if (patternLen === 0) {
          this._match = 0;
          resolve(this._buffer.subarray(this._bufferReadIndex, this._bufferReadIndex));
          return;
        }

        const matchIndexAbs = uint8ArrayIndexOf(
          this._buffer,
          pattern,
          // Another pull may have consumed bytes meanwhile; never start past the data.
          this._bufferReadIndex + Math.min(scanned, this._bufferWriteIndex - this._bufferReadIndex),
          this._bufferWriteIndex
        );

        if (matchIndexAbs !== -1) {
          this._match = matchIndexAbs - this._bufferReadIndex;

          const resultEndAbs = includePattern ? matchIndexAbs + patternLen : matchIndexAbs;
          const consumeTo = matchIndexAbs + patternLen;

          const result = this._buffer.subarray(this._bufferReadIndex, resultEndAbs);

          this._bufferReadIndex = consumeTo;
          if (this._bufferReadIndex === this._bufferWriteIndex) {
            this._resetBuffer();
          }
          this._maybeEmitDrain();
          resolve(result);
          return;
        }

        // No match yet — advance scanFrom so the next retry only scans new
        // bytes (minus overlap for cross-boundary matches).
        scanned = Math.max(0, this._bufferWriteIndex - this._bufferReadIndex - (patternLen - 1));

        if (this.finished) {
          // Pattern not found, return everything
          const result =
            this._bufferReadIndex === this._bufferWriteIndex
              ? EMPTY_U8
              : this._buffer.subarray(this._bufferReadIndex, this._bufferWriteIndex);
          this._resetBuffer();
          resolve(result);
          return;
        }

        // Wait for more data
        this.once("chunk", tryPull);
      };

      tryPull();
    });
  }

  /**
   * Get the match position from last pattern match
   */
  get matchPosition(): number | undefined {
    return this._match;
  }

  /**
   * Get remaining buffer length
   */
  get length(): number {
    return this._bufferWriteIndex - this._bufferReadIndex;
  }

  /**
   * Check if stream is finished
   */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Check if stream is destroyed
   */
  get destroyed(): boolean {
    return this._destroyed;
  }
}
