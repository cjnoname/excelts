interface StringBufOptions {
  size?: number;
  encoding?: BufferEncoding;
}

// StringBuf - a way to keep string memory operations to a minimum
// while building the strings for the xml files
class StringBuf {
  declare private _buf: Buffer;
  declare private _encoding: BufferEncoding;
  declare private _inPos: number;
  declare private _buffer: Buffer | undefined;

  constructor(options?: StringBufOptions) {
    this._buf = Buffer.alloc((options && options.size) || 16384);
    this._encoding = (options && options.encoding) || "utf8";

    // where in the buffer we are at
    this._inPos = 0;

    // for use by toBuffer()
    this._buffer = undefined;
  }

  get length(): number {
    return this._inPos;
  }

  get capacity(): number {
    return this._buf.length;
  }

  get buffer(): Buffer {
    return this._buf;
  }

  toBuffer(): Buffer {
    // return the current data as a single enclosing buffer
    if (!this._buffer) {
      this._buffer = Buffer.alloc(this.length);
      this._buf.copy(this._buffer, 0, 0, this.length);
    }
    return this._buffer;
  }

  reset(position?: number): void {
    position = position || 0;
    this._buffer = undefined;
    this._inPos = position;
  }

  private _grow(min: number): void {
    let size = this._buf.length * 2;
    while (size < min) {
      size *= 2;
    }
    const buf = Buffer.alloc(size);
    this._buf.copy(buf, 0);
    this._buf = buf;
  }

  addText(text: string): void {
    this._buffer = undefined;

    let inPos = this._inPos + this._buf.write(text, this._inPos, this._encoding);

    // if we've hit (or nearing capacity), grow the buf
    while (inPos >= this._buf.length - 4) {
      this._grow(this._inPos + text.length);

      // keep trying to write until we've completely written the text
      inPos = this._inPos + this._buf.write(text, this._inPos, this._encoding);
    }

    this._inPos = inPos;
  }

  addStringBuf(inBuf: StringBuf): void {
    if (inBuf.length) {
      this._buffer = undefined;

      if (this.length + inBuf.length > this.capacity) {
        this._grow(this.length + inBuf.length);
      }
      inBuf._buf.copy(this._buf, this._inPos, 0, inBuf.length);
      this._inPos += inBuf.length;
    }
  }
}

export { StringBuf };
