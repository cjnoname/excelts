/**
 * Little-endian scalar IO.
 *
 * Byte tables rather than round-trips: a reader and a writer that agree with
 * each other but disagree with the format are the failure mode that matters
 * here, and only a literal expected-bytes assertion can see it. Every cursor
 * read therefore asserts the value *and* how far the cursor moved, since a read
 * that returns the right number but advances by the wrong width corrupts every
 * field after it while looking correct in isolation.
 */

import { describe, expect, it } from "vitest";

import {
  BinaryReader,
  BinaryWriter,
  readFloat64LE,
  readInt32LE,
  readUint16LE,
  readUint32LE,
  writeFloat64LE,
  writeUint16LE,
  writeUint32LE
} from "../binary";

describe("writeUint16LE / writeUint32LE", () => {
  it("emits least-significant byte first", () => {
    expect(writeUint16LE(0x1234)).toEqual(Uint8Array.of(0x34, 0x12));
    expect(writeUint32LE(0x12345678)).toEqual(Uint8Array.of(0x78, 0x56, 0x34, 0x12));
  });

  it("handles zero and the unsigned maximum", () => {
    expect(writeUint16LE(0)).toEqual(Uint8Array.of(0, 0));
    expect(writeUint16LE(0xffff)).toEqual(Uint8Array.of(0xff, 0xff));
    expect(writeUint32LE(0)).toEqual(Uint8Array.of(0, 0, 0, 0));
    expect(writeUint32LE(0xffffffff)).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  });

  it("wraps a negative input to its two's-complement encoding", () => {
    // ZIP and BIFF12 both carry fields that are semantically signed but declared
    // unsigned; encoding -1 must produce the all-ones pattern rather than throw.
    expect(writeUint32LE(-1)).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    expect(writeUint16LE(-1)).toEqual(Uint8Array.of(0xff, 0xff));
  });
});

describe("readUint16LE / readUint32LE / readInt32LE", () => {
  it("reads at an offset without touching the surrounding bytes", () => {
    const data = Uint8Array.of(0xaa, 0xbb, 0x78, 0x56, 0x34, 0x12, 0xcc);
    expect(readUint32LE(data, 2)).toBe(0x12345678);
    expect(readUint16LE(data, 2)).toBe(0x5678);
  });

  it("returns uint32 as unsigned, not as a negative int32", () => {
    // `<<24` produces a negative number in JavaScript; the `>>>0` that fixes it
    // is easy to drop and the result still looks plausible in a debugger.
    const data = Uint8Array.of(0x00, 0x00, 0x00, 0x80);
    expect(readUint32LE(data, 0)).toBe(0x80000000);
    expect(readInt32LE(data, 0)).toBe(-2147483648);
  });

  it("agrees with its writer across the sign boundary", () => {
    for (const value of [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      expect(readUint32LE(writeUint32LE(value), 0)).toBe(value);
    }
  });
});

describe("readFloat64LE / writeFloat64LE", () => {
  it("matches the IEEE 754 byte pattern for 1.0", () => {
    const one = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f);
    expect(writeFloat64LE(1)).toEqual(one);
    expect(readFloat64LE(one, 0)).toBe(1);
  });

  it("round-trips the values a spreadsheet actually stores", () => {
    for (const value of [0, -0, 1, -1, 0.1, 1e308, 5e-324, 45678.5, Number.MAX_SAFE_INTEGER]) {
      expect(readFloat64LE(writeFloat64LE(value), 0)).toBe(value);
    }
  });

  it("preserves NaN and the infinities", () => {
    expect(readFloat64LE(writeFloat64LE(NaN), 0)).toBeNaN();
    expect(readFloat64LE(writeFloat64LE(Infinity), 0)).toBe(Infinity);
    expect(readFloat64LE(writeFloat64LE(-Infinity), 0)).toBe(-Infinity);
  });

  it("reads at an offset", () => {
    const data = new Uint8Array(10);
    data.set(writeFloat64LE(-2.5), 2);
    expect(readFloat64LE(data, 2)).toBe(-2.5);
  });
});

describe("BinaryReader", () => {
  it("advances the cursor by each field's width", () => {
    const reader = new BinaryReader(
      Uint8Array.of(0x01, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f)
    );
    expect(reader.readUint8()).toBe(0x01);
    expect(reader.position).toBe(1);
    expect(reader.readUint16()).toBe(0x1234);
    expect(reader.position).toBe(3);
    expect(reader.readUint32()).toBe(0x12345678);
    expect(reader.position).toBe(7);
    expect(reader.readFloat64()).toBe(1);
    expect(reader.position).toBe(15);
    expect(reader.remaining).toBe(0);
  });

  it("reads the signed variants", () => {
    const reader = new BinaryReader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
    expect(reader.readInt8()).toBe(-1);
    expect(reader.readInt16()).toBe(-1);
    expect(reader.readInt32()).toBe(-1);
    expect(reader.position).toBe(7);
  });

  it("reads a 64-bit unsigned field as a bigint", () => {
    const reader = new BinaryReader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
    expect(reader.readBigUint64()).toBe(0xffffffffffffffffn);
    expect(reader.position).toBe(8);
  });

  it("honours the byteOffset of a subarray view", () => {
    // The `DataView` must be constructed with the view's byteOffset and length.
    // Getting this wrong reads from the start of the backing ArrayBuffer, which
    // silently returns whatever preceded the slice — the single easiest way to
    // write a binary reader that is wrong only for non-zero-offset input.
    const backing = Uint8Array.of(0xde, 0xad, 0x78, 0x56, 0x34, 0x12);
    const view = backing.subarray(2);
    expect(view.byteOffset).toBe(2);
    expect(new BinaryReader(view).readUint32()).toBe(0x12345678);
  });

  it("starts at the requested offset", () => {
    const reader = new BinaryReader(Uint8Array.of(0xde, 0xad, 0x34, 0x12), 2);
    expect(reader.position).toBe(2);
    expect(reader.remaining).toBe(2);
    expect(reader.readUint16()).toBe(0x1234);
  });

  it("returns a view from readBytes, not a copy", () => {
    const data = Uint8Array.of(1, 2, 3, 4);
    const reader = new BinaryReader(data);
    const slice = reader.readBytes(2);
    expect(slice).toEqual(Uint8Array.of(1, 2));
    expect(slice.buffer).toBe(data.buffer);
    expect(reader.position).toBe(2);
  });

  it("skips without reading", () => {
    const reader = new BinaryReader(Uint8Array.of(1, 2, 3, 4));
    reader.skip(3);
    expect(reader.position).toBe(3);
    expect(reader.readUint8()).toBe(4);
  });

  it("peeks at an absolute offset without moving the cursor", () => {
    const reader = new BinaryReader(Uint8Array.of(0x78, 0x56, 0x34, 0x12, 0x00));
    reader.readUint8();
    expect(reader.peekUint32(0)).toBe(0x12345678);
    expect(reader.position).toBe(1);
  });

  it("reports the cursor position and the label when it runs out", () => {
    const reader = new BinaryReader(Uint8Array.of(1, 2, 3), 0, "sheet1.bin");
    reader.readUint16();
    expect(() => reader.readUint32()).toThrow(RangeError);
    expect(() => reader.readUint32()).toThrow(/sheet1\.bin: truncated at byte 2/);
    expect(() => reader.readUint32()).toThrow(/need 4 byte\(s\), 1 remain/);
  });

  it("leaves the cursor untouched when a read fails", () => {
    // A decoder that catches a truncation to report it needs the position it
    // failed at, so a partial read must not have moved the cursor first.
    const reader = new BinaryReader(Uint8Array.of(1, 2, 3));
    expect(() => reader.readUint32()).toThrow(RangeError);
    expect(reader.position).toBe(0);
  });

  it("rejects a declared length that is negative, fractional or absurd", () => {
    const reader = new BinaryReader(new Uint8Array(4));
    expect(() => reader.require(-1)).toThrow(RangeError);
    expect(() => reader.require(1.5)).toThrow(RangeError);
    expect(() => reader.require(0x7fffffff)).toThrow(RangeError);
    // `require` is the pre-allocation guard, so it must reject before a caller
    // tries to allocate for the declared size rather than after.
    expect(() => reader.readBytes(0x7fffffff)).toThrow(RangeError);
  });

  it("rejects an out-of-range peek instead of returning garbage", () => {
    const reader = new BinaryReader(new Uint8Array(4));
    expect(() => reader.peekUint32(1)).toThrow(/cannot peek 4 byte\(s\) at 1/);
    expect(() => reader.peekUint32(-1)).toThrow(RangeError);
  });

  it("exposes the source bytes unsliced", () => {
    const data = Uint8Array.of(9, 8, 7);
    expect(new BinaryReader(data).bytes).toBe(data);
  });
});

describe("BinaryWriter", () => {
  it("tracks length as it goes and joins once", () => {
    const writer = new BinaryWriter();
    expect(writer.length).toBe(0);
    writer.writeUint8(0x01);
    expect(writer.length).toBe(1);
    writer.writeUint16(0x1234);
    expect(writer.length).toBe(3);
    writer.writeUint32(0x12345678);
    expect(writer.length).toBe(7);
    expect(writer.toUint8Array()).toEqual(Uint8Array.of(0x01, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12));
  });

  it("writes a double in IEEE 754 little-endian order", () => {
    expect(new BinaryWriter().writeFloat64(1).toUint8Array()).toEqual(
      Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f)
    );
  });

  it("writes a signed int32 as two's complement", () => {
    expect(new BinaryWriter().writeInt32(-2).toUint8Array()).toEqual(
      Uint8Array.of(0xfe, 0xff, 0xff, 0xff)
    );
  });

  it("appends bytes verbatim and reserves zero runs", () => {
    const bytes = new BinaryWriter()
      .writeUint8(0xff)
      .writeBytes(Uint8Array.of(0xaa, 0xbb))
      .writeZeros(3)
      .toUint8Array();
    expect(bytes).toEqual(Uint8Array.of(0xff, 0xaa, 0xbb, 0x00, 0x00, 0x00));
  });

  it("ignores an empty append and a zero-length run", () => {
    const writer = new BinaryWriter().writeBytes(new Uint8Array(0)).writeZeros(0);
    expect(writer.length).toBe(0);
    expect(writer.toUint8Array()).toEqual(new Uint8Array(0));
  });

  it("rejects a byte count that is not a non-negative integer", () => {
    // A count, unlike a value, has no sensible coercion: -4 would silently do
    // nothing and 1.9 would be truncated to one byte, so a mis-derived
    // reserved-field width would produce a differently shaped record with nothing
    // reporting it.
    expect(() => new BinaryWriter().writeZeros(-4)).toThrow(RangeError);
    expect(() => new BinaryWriter().writeZeros(1.9)).toThrow(RangeError);
    expect(() => new BinaryWriter().writeZeros(NaN)).toThrow(RangeError);
  });

  it("returns an empty array when nothing was written", () => {
    expect(new BinaryWriter().toUint8Array()).toEqual(new Uint8Array(0));
  });

  it("is chainable and reads back through BinaryReader", () => {
    const bytes = new BinaryWriter()
      .writeUint16(0xbeef)
      .writeUint32(0xdeadbeef)
      .writeFloat64(-2.5)
      .writeBytes(Uint8Array.of(0x01, 0x02))
      .toUint8Array();

    const reader = new BinaryReader(bytes, 0, "writer output");
    expect(reader.readUint16()).toBe(0xbeef);
    expect(reader.readUint32()).toBe(0xdeadbeef);
    expect(reader.readFloat64()).toBe(-2.5);
    expect(reader.readBytes(2)).toEqual(Uint8Array.of(0x01, 0x02));
    expect(reader.remaining).toBe(0);
  });
});

describe("out-of-range reads are reported, not fabricated", () => {
  // Indexing past the end of a Uint8Array yields `undefined`, and `undefined | 0`
  // is 0 — so byte arithmetic without a bounds check turns a truncated field into
  // a plausible smaller number. In a ZIP that surfaces as "invalid signature" or
  // "CRC mismatch" instead of "truncated", blaming the wrong thing at the wrong
  // offset. `DataView` throws here; replacing it must not give that up.
  it("throws instead of reading a short field as a smaller number", () => {
    const twoBytes = Uint8Array.of(0x50, 0x4b);
    expect(() => readUint32LE(twoBytes, 0)).toThrow(RangeError);
    expect(() => readUint16LE(Uint8Array.of(0x50), 0)).toThrow(RangeError);
    expect(() => readInt32LE(twoBytes, 0)).toThrow(RangeError);
    expect(() => readFloat64LE(new Uint8Array(4), 0)).toThrow(RangeError);
  });

  it("throws when the offset runs past the end", () => {
    const four = new Uint8Array(4);
    expect(() => readUint32LE(four, 1)).toThrow(RangeError);
    expect(readUint32LE(four, 0)).toBe(0);
  });

  it("rejects a negative, fractional or NaN offset", () => {
    const eight = new Uint8Array(8);
    for (const offset of [-1, 1.5, NaN, Infinity]) {
      expect(() => readUint32LE(eight, offset), String(offset)).toThrow(RangeError);
    }
  });

  it("names the count and the length so the failure is locatable", () => {
    expect(() => readUint32LE(Uint8Array.of(1, 2), 0)).toThrow(
      /cannot read 4 byte\(s\) at offset 0: length is 2/
    );
  });
});

describe("BinaryReader cursor validation", () => {
  it("rejects seeking outside the stream", () => {
    const reader = new BinaryReader(new Uint8Array(4), 0, "sheet1.bin");
    expect(() => {
      reader.position = 5;
    }).toThrow(/sheet1\.bin: cannot seek to 5/);
    expect(() => {
      reader.position = -1;
    }).toThrow(RangeError);
    expect(() => {
      reader.position = 1.5;
    }).toThrow(RangeError);
    // The end of the stream is a valid cursor position: a decoder lands there.
    reader.position = 4;
    expect(reader.remaining).toBe(0);
  });

  it("rejects an out-of-range initial offset", () => {
    // Left unvalidated this makes `remaining` negative or NaN, after which every
    // later bounds check passes or fails for the wrong reason.
    expect(() => new BinaryReader(new Uint8Array(4), 9)).toThrow(RangeError);
    expect(() => new BinaryReader(new Uint8Array(4), NaN)).toThrow(RangeError);
  });

  it("rejects a NaN peek offset rather than returning the first field", () => {
    // Every comparison against NaN is false, so a range check alone lets it
    // through and DataView then coerces it to 0.
    const reader = new BinaryReader(Uint8Array.of(0x78, 0x56, 0x34, 0x12));
    expect(() => reader.peekUint32(NaN)).toThrow(RangeError);
    expect(reader.peekUint32(0)).toBe(0x12345678);
  });
});
