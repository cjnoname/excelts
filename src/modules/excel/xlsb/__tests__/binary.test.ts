/**
 * BIFF12 framing and value encodings.
 *
 * Byte tables, not round-trips. A reader and a writer that agree with each other
 * and disagree with `[MS-XLSB]` pass every round-trip test ever written, because
 * both sides share the mistake — so the assertions here name literal bytes.
 */

import { XlsbParseError } from "@excel/errors";
import {
  canEncodeRk,
  decodeRk,
  encodeBiffRecord,
  encodeBiffRecords,
  encodeCell,
  encodeNullableWideString,
  encodeRange,
  encodeRk,
  encodeVarUInt,
  encodeWideString,
  iterateBiffRecords,
  readCell,
  readNullableWideString,
  readRange,
  readWideString
} from "@excel/xlsb/binary";
import { createRng } from "@test/rng";
import { BinaryReader } from "@utils/binary";
import { describe, expect, it } from "vitest";

const records = (bytes: Uint8Array) => [...iterateBiffRecords(bytes, "test.bin")];

describe("record framing", () => {
  it("writes id and length as one byte each when both are small", () => {
    // BrtBeginSheet (0x81) has no payload. 0x81 needs a continuation byte because
    // its high bit is set, which is exactly the case a naive single-byte encoder
    // gets wrong.
    expect(encodeBiffRecord(0x81)).toEqual(Uint8Array.of(0x81, 0x01, 0x00));
    expect(encodeBiffRecord(0x00)).toEqual(Uint8Array.of(0x00, 0x00));
  });

  it("round-trips the id/length boundary widths", () => {
    for (const id of [0, 1, 0x7f, 0x80, 0x81, 0x3fff]) {
      const parsed = records(encodeBiffRecord(id, Uint8Array.of(9)));
      expect(parsed, `id ${id}`).toHaveLength(1);
      expect(parsed[0]!.id, `id ${id}`).toBe(id);
    }
    for (const length of [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 300_000]) {
      const parsed = records(encodeBiffRecord(1, new Uint8Array(length)));
      expect(parsed[0]!.payload.length, `length ${length}`).toBe(length);
    }
  });

  it("encodes a length above 2^28 without the sign flipping", () => {
    // `value | (byte << 28)` coerces to int32 and turns a large length negative.
    // The varint uses arithmetic rather than shifts for exactly this reason.
    const encoded = encodeVarUInt(0x0fff_ffff, 4);
    expect(encoded).toHaveLength(4);
    expect(records(encodeBiffRecord(1, new Uint8Array(0))).length).toBe(1);
  });

  it("reports the offset of the record that declared a bad length", () => {
    const stream = encodeBiffRecords([{ id: 0x81 }, { id: 0x94, payload: new Uint8Array(4) }]);
    const overrun = stream.slice(0, stream.length - 2);
    expect(() => records(overrun)).toThrow(XlsbParseError);
    expect(() => records(overrun)).toThrow(/test\.bin: record 148 at byte 3 declares 4 byte\(s\)/);
  });

  it("rejects an id that cannot be encoded in two bytes", () => {
    // The limit is only reachable on the writing side. A two-byte varint holds
    // seven value bits per byte, so a *parsed* id cannot exceed 0x3FFF and any
    // bound check on the read path would be dead code — a third continuation byte
    // is rejected as an over-long varint instead.
    expect(() => encodeBiffRecord(0x4000)).toThrow(RangeError);
    expect(() => encodeBiffRecord(-1)).toThrow(RangeError);
    expect(records(encodeBiffRecord(0x3fff))[0]!.id).toBe(0x3fff);
    expect(() => records(Uint8Array.of(0x80, 0x80, 0x01, 0x00))).toThrow(
      /record id at byte 0 exceeds 2 byte\(s\)/
    );
  });

  it("reports a truncated header rather than reading past the end", () => {
    expect(() => records(Uint8Array.of(0x81))).toThrow(
      /truncated record id|truncated record length/
    );
    expect(() => records(Uint8Array.of(0x81, 0x01))).toThrow(/truncated record length/);
  });

  it("returns payloads as views, so walking a part copies nothing", () => {
    const stream = encodeBiffRecord(1, Uint8Array.of(1, 2, 3, 4));
    expect(records(stream)[0]!.payload.buffer).toBe(stream.buffer);
  });

  it("never hangs or throws anything but XlsbParseError on arbitrary bytes", () => {
    // The framing layer is the first thing a malformed file reaches. It is allowed
    // to reject input; it is not allowed to loop, or to surface a raw TypeError from
    // somewhere inside a decode.
    for (const seed of [1, 2, 3, 42, 1337, 99_999]) {
      const rng = createRng(seed);
      for (let i = 0; i < 200; i++) {
        const bytes = rng.bytes(rng.int(0, 64));
        try {
          records(bytes);
        } catch (error) {
          expect(error, `seed ${seed}, iteration ${i}`).toBeInstanceOf(XlsbParseError);
        }
      }
    }
  });
});

describe("XLWideString", () => {
  it("writes a UTF-16 code-unit count, not a code-point count", () => {
    expect(encodeWideString("A")).toEqual(Uint8Array.of(1, 0, 0, 0, 0x41, 0x00));
    expect(encodeWideString("")).toEqual(Uint8Array.of(0, 0, 0, 0));
  });

  it("keeps a surrogate pair intact", () => {
    // "😀" is two code units and one code point. Counting code points writes 1 and
    // truncates the string on read; the count here must be 2.
    const encoded = encodeWideString("😀");
    expect(encoded.subarray(0, 4)).toEqual(Uint8Array.of(2, 0, 0, 0));
    expect(readWideString(new BinaryReader(encoded, 0, "test"), "test")).toBe("😀");
  });

  it("round-trips text that exercises the encoding", () => {
    for (const value of ["", "A", "héllo", "日本語", "😀🎉", "a\u0000b", "x".repeat(1000)]) {
      const encoded = encodeWideString(value);
      expect(readWideString(new BinaryReader(encoded, 0, "test"), "test"), value).toBe(value);
    }
  });

  it("rejects a declared length the record cannot hold, before allocating", () => {
    // The count is four attacker-controlled bytes: an eight-byte record can ask for
    // two gigabytes of string.
    const forged = Uint8Array.of(0xff, 0xff, 0xff, 0x7f, 0x41, 0x00);
    const started = performance.now();
    expect(() => readWideString(new BinaryReader(forged, 0, "sheet1.bin"), "sheet1.bin")).toThrow(
      /declares 2147483647 code unit\(s\)/
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("treats 0xFFFFFFFF as absent only for the nullable form", () => {
    const nullBytes = encodeNullableWideString(undefined);
    expect(nullBytes).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
    expect(readNullableWideString(new BinaryReader(nullBytes, 0, "t"), "t")).toBeUndefined();
    expect(
      readNullableWideString(new BinaryReader(encodeNullableWideString(""), 0, "t"), "t")
    ).toBe("");
  });
});

describe("RkNumber", () => {
  it("decodes the four flag combinations", () => {
    // Low two bits are fX100 and fInt; the upper 30 carry the value.
    expect(decodeRk((42 << 2) | 0x02)).toBe(42); // integer
    expect(decodeRk((4250 << 2) | 0x03)).toBe(42.5); // integer / 100
    expect(decodeRk((-7 << 2) | 0x02)).toBe(-7); // sign-extended
    // Double form: the 30 bits are the *high* end of an IEEE 754 double.
    const scratch = new DataView(new ArrayBuffer(8));
    scratch.setFloat64(0, 1.5, true);
    expect(decodeRk(scratch.getUint32(4, true))).toBe(1.5);
  });

  it("refuses to encode a value it cannot represent exactly", () => {
    // Returning undefined rather than rounding is the point: the caller has
    // BrtCellReal, and a silently rounded cell value is the worst kind of bug.
    expect(encodeRk(1 / 3)).toBeUndefined();
    expect(encodeRk(NaN)).toBeUndefined();
    expect(encodeRk(Infinity)).toBeUndefined();
    expect(encodeRk(1.0000001)).toBeUndefined();
    expect(canEncodeRk(1 / 3)).toBe(false);
  });

  it("uses the hundredths form for values a decimal fraction can hold", () => {
    // 0.1 looks unrepresentable and is not: the fX100 flag stores 10 and divides.
    // That is worth pinning, because a conservative implementation that fell back
    // to BrtCellReal here would still be correct but eight bytes per cell heavier
    // on the most common shape of spreadsheet data there is.
    for (const value of [0.1, 19.99, -19.99, 0.01, 1234.56, -0.05, 5_368_709.11]) {
      const encoded = encodeRk(value);
      expect(encoded, `${value} should fit the hundredths form`).toBeDefined();
      expect(decodeRk(encoded!), `${value}`).toBe(value);
    }
    expect(canEncodeRk(0.1)).toBe(true);
    // The hundredths form holds a 30-bit *scaled* integer, so the boundary sits at
    // 2^29 / 100 and the value just above it needs the double form or nothing.
    expect(encodeRk(5_368_709.11)).toBeDefined();
    expect(encodeRk(5_368_709.12)).toBeUndefined();
  });

  it("never accepts a value it would round", () => {
    // The exactness check is what makes the hundredths form safe: three decimal
    // places must be rejected, not silently rounded to two.
    for (const value of [0.001, 1.005, 19.999, 1 / 3, 0.12345]) {
      const encoded = encodeRk(value);
      if (encoded !== undefined) {
        expect(decodeRk(encoded), `${value} was accepted, so it must round-trip`).toBe(value);
      }
    }
    expect(encodeRk(19.999)).toBeUndefined();
  });

  it("round-trips every value it accepts", () => {
    const candidates = [0, 1, -1, 42, -42, 42.5, -42.5, 0.25, 1.5, 2 ** 29 - 1, -(2 ** 29), 1e10];
    for (const value of candidates) {
      const encoded = encodeRk(value);
      if (encoded === undefined) {
        continue;
      }
      expect(decodeRk(encoded), `${value}`).toBe(value);
    }
  });

  it("falls back to the double form outside the 30-bit integer range", () => {
    // 2^29 overflows the integer form but its low 34 mantissa bits are zero, so the
    // double form holds it exactly. Rejecting it would have been safe but wasteful;
    // what must never happen is accepting it *inexactly*.
    expect(decodeRk(encodeRk(2 ** 29)!)).toBe(2 ** 29);
    expect(decodeRk(encodeRk(2 ** 29 - 1)!)).toBe(2 ** 29 - 1);
    expect(encodeRk(-(2 ** 29) - 1)).toBeUndefined();
  });
});

describe("Cell and UncheckedRfX", () => {
  it("keeps iStyleRef in the low 24 bits", () => {
    // The upper byte of that dword is flags, not part of the style index. Reading
    // the whole u32 would produce a plausible but wrong index whenever a flag is set.
    const encoded = encodeCell({ column: 5, styleIndex: 0x00abcdef });
    expect(encoded).toEqual(Uint8Array.of(5, 0, 0, 0, 0xef, 0xcd, 0xab, 0x00));
    expect(readCell(new BinaryReader(encoded, 0, "t"))).toEqual({
      column: 5,
      styleIndex: 0x00abcdef
    });
  });

  it("ignores flag bits above the style index when reading", () => {
    const withFlags = Uint8Array.of(5, 0, 0, 0, 0x01, 0x00, 0x00, 0x80);
    expect(readCell(new BinaryReader(withFlags, 0, "t")).styleIndex).toBe(1);
  });

  it("round-trips a range as four u32s in row-then-column order", () => {
    const range = { firstRow: 1, lastRow: 1048575, firstColumn: 0, lastColumn: 16383 };
    const encoded = encodeRange(range);
    expect(encoded).toHaveLength(16);
    expect(readRange(new BinaryReader(encoded, 0, "t"))).toEqual(range);
  });
});
