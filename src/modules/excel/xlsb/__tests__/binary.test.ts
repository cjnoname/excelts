import { XlsbParseError } from "@excel/errors";
import {
  createBinaryWriter,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord
} from "@excel/xlsb/binary";
import { describe, expect, it } from "vitest";

describe("BIFF12 record framing", () => {
  it("round-trips one- and two-byte record identifiers", () => {
    const writer = createBinaryWriter();
    writeRecord(writer, 7, new Uint8Array([1, 2, 3]));
    writeRecord(writer, 617, new Uint8Array(130));

    const records = [...iterateBiffRecords(finishBinaryWriter(writer), "test")];

    expect(records.map(record => [record.type, record.data.length])).toEqual([
      [7, 3],
      [617, 130]
    ]);
  });

  it("rejects truncated payloads instead of reading into the next record", () => {
    const bytes = new Uint8Array([7, 5, 1, 2]);
    expect(() => [...iterateBiffRecords(bytes, "test")]).toThrowError(XlsbParseError);
  });

  it("rejects overlong record identifiers", () => {
    const bytes = new Uint8Array([0x80, 0x80, 0]);
    expect(() => [...iterateBiffRecords(bytes, "test")]).toThrow(
      "record type at byte 0 exceeds 2 bytes"
    );
  });
});
