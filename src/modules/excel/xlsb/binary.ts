import { XlsbParseError } from "@excel/errors";
import { concatUint8Arrays, decodeBytesToString } from "@utils/binary";

export interface BiffRecord {
  type: number;
  data: Uint8Array;
  offset: number;
}

/** Bounds-checked cursor over a single BIFF12 record payload. */
export class XlsbBinaryReader {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly context: string
  ) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  get position(): number {
    return this.offset;
  }

  skip(length: number): void {
    this.require(length);
    this.offset += length;
  }

  u8(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }

  u16(): number {
    this.require(2);
    const value = this.view().getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.require(2);
    const value = this.view().getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u24(): number {
    this.require(3);
    const value =
      this.bytes[this.offset]! |
      (this.bytes[this.offset + 1]! << 8) |
      (this.bytes[this.offset + 2]! << 16);
    this.offset += 3;
    return value >>> 0;
  }

  u32(): number {
    this.require(4);
    const value = this.view().getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.require(4);
    const value = this.view().getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.require(8);
    const value = this.view().getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  slice(length: number): Uint8Array {
    this.require(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  wideString(): string {
    const characterCount = this.u32();
    if (characterCount === 0xffffffff) {
      return "";
    }
    if (characterCount > Math.floor(this.remaining / 2)) {
      throw new XlsbParseError(
        this.context,
        `UTF-16 string declares ${characterCount} characters with only ${this.remaining} bytes remaining`
      );
    }
    return decodeBytesToString(this.slice(characterCount * 2), "utf-16le");
  }

  private require(length: number): void {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new XlsbParseError(
        this.context,
        `truncated record at byte ${this.offset}: need ${length} bytes, have ${this.remaining}`
      );
    }
  }

  private view(): DataView {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }
}

/** Iterate the records in a BIFF12 stream, validating both variable-length header fields. */
export function* iterateBiffRecords(bytes: Uint8Array, context: string): Generator<BiffRecord> {
  let offset = 0;
  while (offset < bytes.length) {
    const recordOffset = offset;
    const typeField = readVarUInt(bytes, offset, 2, context, "record type");
    offset = typeField.nextOffset;
    const sizeField = readVarUInt(bytes, offset, 4, context, "record size");
    offset = sizeField.nextOffset;

    if (typeField.value >= 0x4000) {
      throw new XlsbParseError(
        context,
        `invalid record type ${typeField.value} at byte ${recordOffset}`
      );
    }
    if (sizeField.value > bytes.length - offset) {
      throw new XlsbParseError(
        context,
        `record ${typeField.value} at byte ${recordOffset} declares ${sizeField.value} bytes, but only ${bytes.length - offset} remain`
      );
    }

    yield {
      type: typeField.value,
      data: bytes.subarray(offset, offset + sizeField.value),
      offset: recordOffset
    };
    offset += sizeField.value;
  }
}

interface VarUIntResult {
  value: number;
  nextOffset: number;
}

function readVarUInt(
  bytes: Uint8Array,
  start: number,
  maxBytes: number,
  context: string,
  label: string
): VarUIntResult {
  let value = 0;
  let offset = start;
  for (let i = 0; i < maxBytes; i++) {
    if (offset >= bytes.length) {
      throw new XlsbParseError(context, `truncated ${label} at byte ${start}`);
    }
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
  }
  throw new XlsbParseError(context, `${label} at byte ${start} exceeds ${maxBytes} bytes`);
}

/** Mutable binary sink used while producing one BIFF12 part. */
export interface XlsbBinaryWriter {
  chunks: Uint8Array[];
  length: number;
}

export function createBinaryWriter(): XlsbBinaryWriter {
  return { chunks: [], length: 0 };
}

export function writeRecord(
  writer: XlsbBinaryWriter,
  type: number,
  payload: Uint8Array = new Uint8Array(0)
): void {
  writeChunk(writer, encodeVarUInt(type, 2));
  writeChunk(writer, encodeVarUInt(payload.length, 4));
  writeChunk(writer, payload);
}

export function finishBinaryWriter(writer: XlsbBinaryWriter): Uint8Array {
  return concatUint8Arrays(writer.chunks, writer.length);
}

export function encodeWideString(value: string): Uint8Array {
  const bytes = new Uint8Array(4 + value.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, value.length, true);
  for (let i = 0; i < value.length; i++) {
    view.setUint16(4 + i * 2, value.charCodeAt(i), true);
  }
  return bytes;
}

export function createPayload(length: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

function writeChunk(writer: XlsbBinaryWriter, chunk: Uint8Array): void {
  writer.chunks.push(chunk);
  writer.length += chunk.length;
}

function encodeVarUInt(value: number, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`BIFF12 variable integer must be a non-negative safe integer: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0 && bytes.length < maxBytes);
  if (remaining > 0) {
    throw new RangeError(`BIFF12 variable integer ${value} exceeds ${maxBytes} bytes`);
  }
  return new Uint8Array(bytes);
}
