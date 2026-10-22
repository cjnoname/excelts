import { EMPTY_UINT8ARRAY, indexOfUint8ArrayPattern } from "@archive/core/bytes";

export class ByteQueue {
  // Store data as immutable chunks to avoid copying on append.
  private _chunks: Uint8Array[] = [];
  private _chunkHead = 0;
  private _headOffset = 0;
  private _length = 0;

  // Lazily materialized contiguous view (used only by callers that require a single buffer).
  private _cachedView: Uint8Array | null = null;
  private _cachedLength = 0;

  private _activeChunkCount(): number {
    return this._chunks.length - this._chunkHead;
  }

  private _headChunk(): Uint8Array {
    return this._chunks[this._chunkHead]!;
  }

  private _compactConsumedChunks(): void {
    if (this._chunkHead === 0) {
      return;
    }

    if (this._chunkHead >= this._chunks.length) {
      this._chunks = [];
      this._chunkHead = 0;
      return;
    }

    if (this._chunkHead > 32 && this._chunkHead * 2 >= this._chunks.length) {
      this._chunks = this._chunks.slice(this._chunkHead);
      this._chunkHead = 0;
    }
  }

  private _dropHeadChunk(): void {
    // Release the consumed chunk now rather than at the next compaction.
    this._chunks[this._chunkHead++] = undefined!;
    this._headOffset = 0;
    this._compactConsumedChunks();
  }

  constructor(initial?: Uint8Array) {
    if (initial && initial.length > 0) {
      this.reset(initial);
    }
  }

  get length(): number {
    return this._length;
  }

  isEmpty(): boolean {
    return this.length === 0;
  }

  view(): Uint8Array {
    if (this._length === 0) {
      return EMPTY_UINT8ARRAY;
    }

    // Fast path: single chunk.
    if (this._activeChunkCount() === 1) {
      const c = this._headChunk();
      return c.subarray(this._headOffset, this._headOffset + this._length);
    }

    if (this._cachedView && this._cachedLength === this._length) {
      return this._cachedView;
    }

    const out = new Uint8Array(this._length);
    let offset = 0;
    for (let i = this._chunkHead; i < this._chunks.length; i++) {
      const c = this._chunks[i];
      const start = i === this._chunkHead ? this._headOffset : 0;
      const end = i === this._chunks.length - 1 ? start + (this._length - offset) : c.length;
      out.set(c.subarray(start, end), offset);
      offset += end - start;
      if (offset >= out.length) {
        break;
      }
    }

    this._cachedView = out;
    this._cachedLength = this._length;
    return out;
  }

  reset(data?: Uint8Array): void {
    this._cachedView = null;
    this._cachedLength = 0;

    this._chunks = [];
    this._chunkHead = 0;
    this._headOffset = 0;
    this._length = 0;

    if (!data || data.length === 0) {
      return;
    }

    // Keep a private copy to ensure future writes cannot mutate the source.
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this._chunks = [copy];
    this._chunkHead = 0;
    this._headOffset = 0;
    this._length = copy.length;
  }

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }

    this._cachedView = null;
    this._cachedLength = 0;

    this._chunks.push(chunk);
    this._length += chunk.length;
  }

  read(length: number): Uint8Array {
    if (length <= 0) {
      return EMPTY_UINT8ARRAY;
    }
    if (length > this._length) {
      throw new RangeError("ByteQueue: read beyond available data");
    }

    this._cachedView = null;
    this._cachedLength = 0;

    if (this._activeChunkCount() === 1) {
      const c = this._headChunk();
      const start = this._headOffset;
      const end = start + length;
      const out = c.subarray(start, end);

      this._headOffset = end;
      this._length -= length;

      if (this._length === 0) {
        this._chunks = [];
        this._chunkHead = 0;
        this._headOffset = 0;
      } else if (this._headOffset >= c.length) {
        this._dropHeadChunk();
      }

      return out;
    }

    // Slow path: spans multiple chunks, copy into a single output buffer.
    const out = new Uint8Array(length);
    let outOffset = 0;
    let remaining = length;

    while (remaining > 0) {
      const c = this._headChunk();
      const start = this._headOffset;
      const available = c.length - start;
      const toCopy = Math.min(available, remaining);

      out.set(c.subarray(start, start + toCopy), outOffset);
      outOffset += toCopy;
      remaining -= toCopy;
      this._headOffset += toCopy;
      this._length -= toCopy;

      if (this._headOffset >= c.length) {
        this._dropHeadChunk();
      }
    }

    if (this._length === 0) {
      this._chunks = [];
      this._chunkHead = 0;
      this._headOffset = 0;
    }

    return out;
  }

  /**
   * Return a list of chunk views totaling `length` bytes without consuming.
   *
   * This avoids materializing a contiguous buffer for streaming write paths.
   */
  peekChunks(length: number): Uint8Array[] {
    if (length <= 0) {
      return [];
    }
    if (length > this._length) {
      throw new RangeError("ByteQueue: peek beyond available data");
    }

    // Fast path: single chunk.
    if (this._activeChunkCount() === 1) {
      const c = this._headChunk();
      const start = this._headOffset;
      return [c.subarray(start, start + length)];
    }

    const parts: Uint8Array[] = [];
    let remaining = length;

    for (let i = this._chunkHead; i < this._chunks.length && remaining > 0; i++) {
      const c = this._chunks[i]!;
      const start = i === this._chunkHead ? this._headOffset : 0;
      const avail = c.length - start;
      if (avail <= 0) {
        continue;
      }

      const toTake = Math.min(avail, remaining);
      parts.push(c.subarray(start, start + toTake));
      remaining -= toTake;
    }

    return parts;
  }

  discard(length: number): void {
    if (length <= 0) {
      return;
    }
    if (length >= this._length) {
      this._chunks = [];
      this._chunkHead = 0;
      this._headOffset = 0;
      this._length = 0;

      this._cachedView = null;
      this._cachedLength = 0;
      return;
    }

    this._cachedView = null;
    this._cachedLength = 0;

    let remaining = length;
    while (remaining > 0) {
      const c = this._headChunk();
      const start = this._headOffset;
      const available = c.length - start;
      const toDrop = Math.min(available, remaining);
      this._headOffset += toDrop;
      this._length -= toDrop;
      remaining -= toDrop;

      if (this._headOffset >= c.length) {
        this._dropHeadChunk();
      }
    }

    if (this._length === 0) {
      this._chunks = [];
      this._chunkHead = 0;
      this._headOffset = 0;
    }
  }

  /**
   * Find the first index of `pattern` within the queue.
   *
   * This avoids materializing a contiguous `view()` for common small patterns
   * (ZIP signatures are typically 2-4 bytes).
   */
  indexOfPattern(pattern: Uint8Array, startIndex = 0): number {
    const patLen = pattern.length;
    if (patLen === 0) {
      return 0;
    }
    const len = this._length;
    if (patLen > len) {
      return -1;
    }

    let start = startIndex | 0;
    if (start < 0) {
      start = 0;
    }
    if (start > len - patLen) {
      return -1;
    }

    // Fast path: single chunk.
    if (this._activeChunkCount() === 1) {
      const c = this._headChunk();
      const base = this._headOffset;
      const view = c.subarray(base, base + len);
      // Delegate to native indexOf checks for 1..4 bytes.
      if (patLen === 1) {
        return view.indexOf(pattern[0], start);
      }
      return indexOfUint8ArrayPattern(view, pattern, start);
    }

    // Multi-chunk: optimize only for very common small patterns.
    if (patLen > 4) {
      // Rare: materialize view.
      const v = this.view();
      return indexOfUint8ArrayPattern(v, pattern, start);
    }

    const b0 = pattern[0];
    const b1 = patLen >= 2 ? pattern[1] : 0;
    const b2 = patLen >= 3 ? pattern[2] : 0;
    const b3 = patLen >= 4 ? pattern[3] : 0;

    const chunks = this._chunks;
    const chunkHead = this._chunkHead;

    const peekByteAcrossChunks = (chunkIndex: number, absoluteIndex: number): number | null => {
      let ci = chunkIndex;
      let idx = absoluteIndex;
      while (ci < chunks.length) {
        const c = chunks[ci]!;
        if (idx < c.length) {
          return c[idx]! | 0;
        }
        idx -= c.length;
        ci++;
      }
      return null;
    };

    let globalBase = 0;
    for (let ci = chunkHead; ci < chunks.length; ci++) {
      const c = chunks[ci]!;
      const chunkOffset = ci === chunkHead ? this._headOffset : 0;
      const chunkLen = c.length - chunkOffset;
      if (chunkLen <= 0) {
        continue;
      }

      const chunkStartGlobal = globalBase;
      const chunkEndGlobal = chunkStartGlobal + chunkLen;

      // Compute local start for this chunk.
      const localStart =
        start <= chunkStartGlobal
          ? chunkOffset
          : start >= chunkEndGlobal
            ? c.length
            : chunkOffset + (start - chunkStartGlobal);

      if (localStart > c.length - 1) {
        globalBase += chunkLen;
        continue;
      }

      const lastLocal = c.length - 1;
      let i = c.indexOf(b0, localStart);
      while (i !== -1 && i <= lastLocal) {
        const globalPos = chunkStartGlobal + (i - chunkOffset);
        if (globalPos > len - patLen) {
          return -1;
        }

        if (patLen === 1) {
          return globalPos;
        }

        // Fast path: match stays fully inside the current chunk.
        // Avoid calling peekByte() which walks the chunk list per byte.
        const staysInChunk = i + patLen <= c.length;
        if (staysInChunk) {
          if (c[i + 1] !== b1) {
            i = c.indexOf(b0, i + 1);
            continue;
          }
          if (patLen === 2) {
            return globalPos;
          }
          if (c[i + 2] !== b2) {
            i = c.indexOf(b0, i + 1);
            continue;
          }
          if (patLen === 3) {
            return globalPos;
          }
          if (c[i + 3] !== b3) {
            i = c.indexOf(b0, i + 1);
            continue;
          }
          return globalPos;
        }

        // Slow path: pattern spans chunks.
        const b1v = peekByteAcrossChunks(ci, i + 1);
        if (b1v === null || b1v !== b1) {
          i = c.indexOf(b0, i + 1);
          continue;
        }
        if (patLen === 2) {
          return globalPos;
        }
        const b2v = peekByteAcrossChunks(ci, i + 2);
        if (b2v === null || b2v !== b2) {
          i = c.indexOf(b0, i + 1);
          continue;
        }
        if (patLen === 3) {
          return globalPos;
        }
        const b3v = peekByteAcrossChunks(ci, i + 3);
        if (b3v === null || b3v !== b3) {
          i = c.indexOf(b0, i + 1);
          continue;
        }
        return globalPos;
      }

      globalBase += chunkLen;
    }

    return -1;
  }

  /** Peek a little-endian uint32 at `offset` without consuming bytes. Returns null if not enough bytes. */
  peekUint32LE(offset: number): number | null {
    const off = offset | 0;
    if (off < 0 || off + 4 > this._length) {
      return null;
    }

    // Try to read contiguously from a single chunk to avoid 4x chunk-walk.
    const chunks = this._chunks;
    let remaining = off;
    for (let i = this._chunkHead; i < chunks.length; i++) {
      const c = chunks[i]!;
      const start = i === this._chunkHead ? this._headOffset : 0;
      const avail = c.length - start;
      if (remaining < avail) {
        const idx = start + remaining;
        if (idx + 4 <= c.length) {
          const b0 = c[idx] | 0;
          const b1 = c[idx + 1] | 0;
          const b2 = c[idx + 2] | 0;
          const b3 = c[idx + 3] | 0;
          return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
        }

        // Cross-chunk read (rare): walk forward across chunks once.
        const b0 = c[idx] | 0;
        let b1 = 0;
        let b2 = 0;
        let b3 = 0;

        let ci = i;
        let pos = idx + 1;
        for (let k = 1; k < 4; k++) {
          while (ci < chunks.length) {
            const cc = chunks[ci]!;
            if (pos < cc.length) {
              const v = cc[pos]! | 0;
              if (k === 1) {
                b1 = v;
              } else if (k === 2) {
                b2 = v;
              } else {
                b3 = v;
              }
              pos++;
              break;
            }
            ci++;
            pos = 0;
          }
        }

        return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
      }
      remaining -= avail;
    }

    // Should be unreachable due to bounds check above.
    return null;
  }

  /** Peek a single byte at `offset` without consuming bytes. */
  peekByte(offset: number): number {
    const off = offset | 0;
    if (off < 0 || off >= this._length) {
      throw new RangeError("ByteQueue: peek beyond available data");
    }

    let remaining = off;
    for (let i = this._chunkHead; i < this._chunks.length; i++) {
      const c = this._chunks[i];
      const start = i === this._chunkHead ? this._headOffset : 0;
      const avail = c.length - start;
      if (remaining < avail) {
        return c[start + remaining] | 0;
      }
      remaining -= avail;
    }

    // Should be unreachable.
    throw new RangeError("ByteQueue: peek beyond available data");
  }
}
