import { cellGetValue } from "@excel/core/cell";
import { addWorksheet, createWorkbook } from "@excel/core/workbook.browser";
import { getCell } from "@excel/core/worksheet-core";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  writeRecord
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { parseWorksheetPart } from "@excel/xlsb/worksheet-part";
import { describe, expect, it } from "vitest";

describe("XLSB worksheet records", () => {
  it("reads direct strings and both RK integer flags according to BIFF12", () => {
    const writer = createBinaryWriter();
    writeRecord(writer, XlsbRecordType.BeginSheet);
    writeRecord(writer, XlsbRecordType.BeginSheetData);
    writeRecord(writer, XlsbRecordType.RowHdr, rowHeaderPayload(0, 0, 2));
    writeRecord(writer, XlsbRecordType.CellSt, directStringPayload(0, "direct"));
    writeRecord(writer, XlsbRecordType.CellRk, rkPayload(1, (123 << 2) | 2));
    writeRecord(writer, XlsbRecordType.CellRk, rkPayload(2, (12345 << 2) | 3));
    writeRecord(writer, XlsbRecordType.EndSheetData);
    writeRecord(writer, XlsbRecordType.EndSheet);

    const workbook = createWorkbook();
    const worksheet = addWorksheet(workbook, "Sheet1");
    parseWorksheetPart(
      worksheet,
      finishBinaryWriter(writer),
      [],
      {
        styles: [{}],
        namedStyles: [],
        fonts: [],
        numFmtIds: [0],
        customFormats: new Map(),
        hasUnsupportedFormatting: false,
        unsupportedRecordTypes: []
      },
      false,
      { sheetNames: ["Sheet1"], externalSheets: [] }
    );

    expect(cellGetValue(getCell(worksheet, "A1"))).toBe("direct");
    expect(cellGetValue(getCell(worksheet, "B1"))).toBe(123);
    expect(cellGetValue(getCell(worksheet, "C1"))).toBe(123.45);
  });

  it("reads sequential short cell records 12 through 18", () => {
    const writer = createBinaryWriter();
    writeRecord(writer, XlsbRecordType.BeginSheet);
    writeRecord(writer, XlsbRecordType.BeginSheetData);
    writeRecord(writer, XlsbRecordType.RowHdr, rowHeaderPayload(0, 0, 6));
    writeRecord(writer, XlsbRecordType.ShortBlank, new Uint8Array(4));
    writeRecord(writer, XlsbRecordType.ShortRk, rkPayload(0, (7 << 2) | 2).subarray(4));
    writeRecord(writer, XlsbRecordType.ShortError, Uint8Array.of(0, 0, 0, 0, 7));
    writeRecord(writer, XlsbRecordType.ShortBool, Uint8Array.of(0, 0, 0, 0, 1));
    writeRecord(writer, XlsbRecordType.ShortReal, realPayload(0, 12.5).subarray(4));
    writeRecord(writer, XlsbRecordType.ShortSt, directStringPayload(0, "direct").subarray(4));
    writeRecord(writer, XlsbRecordType.ShortIsst, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0));
    writeRecord(writer, XlsbRecordType.EndSheetData);
    writeRecord(writer, XlsbRecordType.EndSheet);

    const workbook = createWorkbook();
    const worksheet = addWorksheet(workbook, "Sheet1");
    parseWorksheetPart(
      worksheet,
      finishBinaryWriter(writer),
      ["shared"],
      {
        styles: [{}],
        namedStyles: [],
        fonts: [],
        numFmtIds: [0],
        customFormats: new Map(),
        hasUnsupportedFormatting: false,
        unsupportedRecordTypes: []
      },
      false,
      { sheetNames: ["Sheet1"], externalSheets: [] }
    );

    expect(cellGetValue(getCell(worksheet, "A1"))).toBeNull();
    expect(cellGetValue(getCell(worksheet, "B1"))).toBe(7);
    expect(cellGetValue(getCell(worksheet, "C1"))).toEqual({ error: "#DIV/0!" });
    expect(cellGetValue(getCell(worksheet, "D1"))).toBe(true);
    expect(cellGetValue(getCell(worksheet, "E1"))).toBe(12.5);
    expect(cellGetValue(getCell(worksheet, "F1"))).toBe("direct");
    expect(cellGetValue(getCell(worksheet, "G1"))).toBe("shared");
  });

  it("falls back to a formula's cached result when its token stream is unsupported", () => {
    const writer = createBinaryWriter();
    writeRecord(writer, XlsbRecordType.BeginSheet);
    writeRecord(writer, XlsbRecordType.BeginSheetData);
    writeRecord(writer, XlsbRecordType.RowHdr, rowHeaderPayload(0, 0, 0));
    const formula = createPayload(27);
    formula.view.setFloat64(8, 42, true);
    formula.view.setUint32(18, 1, true);
    formula.bytes[22] = 0x20;
    writeRecord(writer, XlsbRecordType.FmlaNum, formula.bytes);
    writeRecord(writer, XlsbRecordType.EndSheetData);
    writeRecord(writer, XlsbRecordType.EndSheet);

    const workbook = createWorkbook();
    const worksheet = addWorksheet(workbook, "Sheet1");
    const result = parseWorksheetPart(
      worksheet,
      finishBinaryWriter(writer),
      [],
      {
        styles: [{}],
        namedStyles: [],
        fonts: [],
        numFmtIds: [0],
        customFormats: new Map(),
        hasUnsupportedFormatting: false,
        unsupportedRecordTypes: []
      },
      false,
      { sheetNames: ["Sheet1"], externalSheets: [] }
    );

    expect(cellGetValue(getCell(worksheet, "A1"))).toBe(42);
    expect(result.cachedFormulaCount).toBe(1);
  });
});

function rowHeaderPayload(row: number, firstColumn: number, lastColumn: number): Uint8Array {
  const payload = createPayload(25);
  payload.view.setUint32(0, row, true);
  payload.view.setUint16(8, 300, true);
  payload.view.setUint32(13, 1, true);
  payload.view.setUint32(17, firstColumn, true);
  payload.view.setUint32(21, lastColumn, true);
  return payload.bytes;
}

function directStringPayload(column: number, value: string): Uint8Array {
  const text = encodeWideString(value);
  const payload = new Uint8Array(8 + text.length);
  new DataView(payload.buffer).setUint32(0, column, true);
  payload.set(text, 8);
  return payload;
}

function rkPayload(column: number, value: number): Uint8Array {
  const payload = createPayload(12);
  payload.view.setUint32(0, column, true);
  payload.view.setUint32(8, value, true);
  return payload.bytes;
}

function realPayload(column: number, value: number): Uint8Array {
  const payload = createPayload(16);
  payload.view.setUint32(0, column, true);
  payload.view.setFloat64(8, value, true);
  return payload.bytes;
}
