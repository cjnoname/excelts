import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  writeRecord
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { parseSharedStrings } from "@excel/xlsb/shared-strings";
import { expect, it } from "vitest";

it("reads Excel phonetic shared strings while preserving their base text", () => {
  const base = encodeWideString("base");
  const phonetic = encodeWideString("kana");
  const item = createPayload(1 + base.length + phonetic.length + 4 + 6 + 4);
  item.bytes[0] = 2;
  item.bytes.set(base, 1);
  let offset = 1 + base.length;
  item.bytes.set(phonetic, offset);
  offset += phonetic.length;
  item.view.setUint32(offset, 1, true);
  offset += 4;
  item.view.setUint16(offset, 0, true);
  item.view.setUint16(offset + 2, 0, true);
  item.view.setUint16(offset + 4, 4, true);
  item.view.setUint16(offset + 6, 1, true);
  item.view.setUint16(offset + 8, 0x35, true);

  const writer = createBinaryWriter();
  writeRecord(writer, XlsbRecordType.BeginSst, new Uint8Array(8));
  writeRecord(writer, XlsbRecordType.SstItem, item.bytes);
  writeRecord(writer, XlsbRecordType.EndSst);

  expect(parseSharedStrings(finishBinaryWriter(writer))).toEqual({
    values: ["base"],
    hasUnsupportedFormatting: true,
    unsupportedRecordTypes: []
  });
});
