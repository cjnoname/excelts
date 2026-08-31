import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  writeRecord
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { parseWorkbookPart } from "@excel/xlsb/workbook-part";
import { describe, expect, it } from "vitest";

describe("XLSB workbook records", () => {
  it("reads both current and legacy relationship encodings in BrtBundleSh", () => {
    const writer = createBinaryWriter();
    writeRecord(writer, XlsbRecordType.BeginBook);
    writeRecord(writer, XlsbRecordType.BeginBundleShs);
    writeRecord(writer, XlsbRecordType.BundleSh, bundleSheetPayload("rId1", "Current", 1));
    writeRecord(writer, XlsbRecordType.BundleSh, bundleSheetPayload("rId2", "Legacy", 0, 2));
    writeRecord(writer, XlsbRecordType.EndBundleShs);
    writeRecord(writer, XlsbRecordType.EndBook);

    expect(parseWorkbookPart(finishBinaryWriter(writer)).sheets).toEqual([
      { name: "Current", relationId: "rId1", sheetId: 1, state: "visible" },
      { name: "Legacy", relationId: "rId2", sheetId: 2, state: "visible" }
    ]);
  });

  it("reads the legacy one-byte BrtCalcProp flags field", () => {
    const writer = createBinaryWriter();
    const calculation = createPayload(25);
    calculation.view.setUint32(4, 1, true);
    calculation.view.setUint32(8, 100, true);
    calculation.view.setFloat64(12, 0.001, true);
    calculation.view.setInt32(20, 1, true);
    calculation.bytes[24] = 0x6f;
    writeRecord(writer, XlsbRecordType.BeginBook);
    writeRecord(writer, XlsbRecordType.CalcProp, calculation.bytes);
    writeRecord(writer, XlsbRecordType.EndBook);

    expect(parseWorkbookPart(finishBinaryWriter(writer)).calcProperties).toEqual({
      fullCalcOnLoad: true,
      iterate: true,
      iterateCount: 100,
      iterateDelta: 0.001
    });
  });
});

function bundleSheetPayload(
  relationId: string,
  name: string,
  sheetId: number,
  legacyRelationshipIndex?: number
): Uint8Array {
  const relation = encodeWideString(relationId);
  const sheetName = encodeWideString(name);
  const legacyPrefix = legacyRelationshipIndex === undefined ? 0 : 4;
  const payload = new Uint8Array(8 + legacyPrefix + relation.length + sheetName.length);
  const view = new DataView(payload.buffer);
  view.setUint32(4, sheetId, true);
  if (legacyRelationshipIndex !== undefined) {
    view.setUint32(8, legacyRelationshipIndex, true);
  }
  payload.set(relation, 8 + legacyPrefix);
  payload.set(sheetName, 8 + legacyPrefix + relation.length);
  return payload;
}
