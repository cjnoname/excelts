import type { CellRichTextValue, Font } from "@excel/types";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord,
  XlsbBinaryReader
} from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { parseXlsbRichString, writeXlsbRichString } from "@excel/xlsb/rich-string";
import type { XlsbStyleRegistry } from "@excel/xlsb/styles";

export type XlsbSharedStringValue = string | CellRichTextValue;

export interface XlsbSharedStrings {
  values: XlsbSharedStringValue[];
  indexes: Map<string, number>;
  totalCount: number;
}

export interface XlsbSharedStringTable {
  values: XlsbSharedStringValue[];
  hasUnsupportedFormatting: boolean;
  unsupportedRecordTypes: number[];
}

export function createSharedStrings(): XlsbSharedStrings {
  return { values: [], indexes: new Map(), totalCount: 0 };
}

export function addSharedString(table: XlsbSharedStrings, value: XlsbSharedStringValue): number {
  table.totalCount++;
  const key = typeof value === "string" ? `s:${value}` : `r:${JSON.stringify(value.richText)}`;
  const existing = table.indexes.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const index = table.values.length;
  table.values.push(value);
  table.indexes.set(key, index);
  return index;
}

export function parseSharedStrings(
  bytes: Uint8Array,
  fonts: readonly Partial<Font>[] = []
): XlsbSharedStringTable {
  const values: XlsbSharedStringValue[] = [];
  const unsupportedRecordTypes = new Set<number>();
  let hasUnsupportedFormatting = false;
  for (const record of iterateBiffRecords(bytes, "xl/sharedStrings.bin")) {
    if (
      record.type === XlsbRecordType.BeginSst ||
      record.type === XlsbRecordType.EndSst ||
      record.type === XlsbRecordType.FutureRecordBegin ||
      record.type === XlsbRecordType.FutureRecordEnd ||
      record.type === XlsbRecordType.AlternateContentBegin ||
      record.type === XlsbRecordType.AlternateContentEnd
    ) {
      continue;
    }
    if (record.type !== XlsbRecordType.SstItem) {
      unsupportedRecordTypes.add(record.type);
      continue;
    }
    const parsed = parseXlsbRichString(
      new XlsbBinaryReader(record.data, "BrtSSTItem"),
      "BrtSSTItem",
      fonts
    );
    if (parsed.hasPhoneticData) {
      hasUnsupportedFormatting = true;
    }
    values.push(parsed.richText ? { richText: parsed.richText } : parsed.text);
  }
  return {
    values,
    hasUnsupportedFormatting,
    unsupportedRecordTypes: [...unsupportedRecordTypes].sort((left, right) => left - right)
  };
}

export function writeSharedStrings(
  table: XlsbSharedStrings,
  styles?: XlsbStyleRegistry
): Uint8Array {
  const writer = createBinaryWriter();
  const begin = createPayload(8);
  begin.view.setUint32(0, table.totalCount, true);
  begin.view.setUint32(4, table.values.length, true);
  writeRecord(writer, XlsbRecordType.BeginSst, begin.bytes);

  for (const value of table.values) {
    writeRecord(writer, XlsbRecordType.SstItem, sharedStringPayload(value, styles));
  }

  writeRecord(writer, XlsbRecordType.EndSst);
  return finishBinaryWriter(writer);
}

function sharedStringPayload(
  value: XlsbSharedStringValue,
  styles: XlsbStyleRegistry | undefined
): Uint8Array {
  if (typeof value === "string") {
    const text = encodeWideString(value);
    const payload = new Uint8Array(1 + text.length);
    payload.set(text, 1);
    return payload;
  }
  if (!styles) {
    throw new TypeError("Writing rich XLSB shared strings requires a style registry");
  }
  return writeXlsbRichString(value.richText, styles, "Write XLSB shared strings");
}
