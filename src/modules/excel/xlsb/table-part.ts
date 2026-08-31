import type { TableModel } from "@excel/core/table";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type { TableColumnProperties, TableStyleProperties } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";
import {
  autoFilterCriteriaFromColumns,
  parseAutoFilterColumns,
  writeAutoFilter
} from "@excel/xlsb/auto-filter";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord,
  XlsbBinaryReader
} from "@excel/xlsb/binary";
import { compileCellFormula, parseNameFormula } from "@excel/xlsb/formula";
import type { XlsbFormulaContext } from "@excel/xlsb/formula";
import { XlsbRecordType } from "@excel/xlsb/record-types";

export interface XlsbTablePart {
  id: number;
  model: TableModel;
  unsupportedRecordTypes: number[];
  unsupportedSettings: string[];
}

interface ParsedTableColumn extends TableColumnProperties {
  id: number;
  rawFilterXml?: string[];
}

const TOTAL_FUNCTIONS = [
  "none",
  "average",
  "count",
  "countNums",
  "max",
  "min",
  "sum",
  "stdDev",
  "var",
  "custom"
] as const;

export function parseTablePart(bytes: Uint8Array, context: XlsbFormulaContext): XlsbTablePart {
  const filterColumns = parseAutoFilterColumns(bytes);
  const unsupportedRecordTypes = new Set<number>();
  const unsupportedSettings: string[] = [];
  let id = 0;
  let tableRef = "";
  let name = "";
  let displayName = "";
  let headerRow = true;
  let totalsRow = false;
  let autoFilterRef: string | undefined;
  let style: TableStyleProperties | undefined;
  let expectedColumnCount: number | undefined;
  let currentColumn: ParsedTableColumn | undefined;
  const columns: ParsedTableColumn[] = [];
  const hiddenFilterColumns = new Set<number>();
  if (filterColumns.some(column => column.buttonInNextColumn)) {
    unsupportedSettings.push("table AutoFilter button positioned in the next column");
  }

  for (const record of iterateBiffRecords(bytes, "XLSB table")) {
    switch (record.type) {
      case XlsbRecordType.BeginList: {
        const parsed = parseBeginList(record.data);
        id = parsed.id;
        tableRef = parsed.tableRef;
        name = parsed.name;
        displayName = parsed.displayName;
        headerRow = parsed.headerRow;
        totalsRow = parsed.totalsRow;
        unsupportedSettings.push(...parsed.unsupportedSettings);
        break;
      }
      case XlsbRecordType.BeginAutoFilter:
        autoFilterRef = parseRange(record.data, "table BrtBeginAFilter");
        break;
      case XlsbRecordType.BeginListCols:
        expectedColumnCount = parseCount(record.data, "BrtBeginListCols");
        break;
      case XlsbRecordType.BeginListCol:
        if (currentColumn) {
          throw new XlsbParseError("XLSB table", "nested BrtBeginListCol records");
        }
        currentColumn = parseBeginListColumn(record.data, unsupportedSettings);
        columns.push(currentColumn);
        break;
      case XlsbRecordType.ListCalculatedColumnFormula:
        if (!currentColumn) {
          throw new XlsbParseError("XLSB table", "BrtListCCFmla outside a table column");
        }
        currentColumn.calculatedColumnFormula = parseTableFormula(
          record.data,
          `calculated formula for table column ${currentColumn.name}`,
          context,
          unsupportedSettings
        );
        break;
      case XlsbRecordType.ListTotalRowFormula:
        if (!currentColumn) {
          throw new XlsbParseError("XLSB table", "BrtListTrFmla outside a table column");
        }
        currentColumn.totalsRowFormula = parseTableFormula(
          record.data,
          `total formula for table column ${currentColumn.name}`,
          context,
          unsupportedSettings
        );
        break;
      case XlsbRecordType.EndListCol:
        currentColumn = undefined;
        break;
      case XlsbRecordType.BeginFilterColumn:
        parseFilterColumn(record.data, hiddenFilterColumns);
        break;
      case XlsbRecordType.TableStyleClient:
        style = parseTableStyle(record.data);
        break;
      default:
        if (!isTableContainerRecord(record.type)) {
          unsupportedRecordTypes.add(record.type);
        }
    }
  }

  if (!id || !tableRef || !displayName || currentColumn) {
    throw new XlsbParseError("XLSB table", "missing or unterminated required table records");
  }
  if (expectedColumnCount !== undefined && expectedColumnCount !== columns.length) {
    throw new XlsbParseError(
      "BrtBeginListCols",
      `declares ${expectedColumnCount} columns but ${columns.length} were found`
    );
  }
  for (const index of hiddenFilterColumns) {
    const column = columns[index];
    if (!column) {
      throw new XlsbParseError("BrtBeginFilterColumn", `invalid table column index ${index}`);
    }
    column.filterButton = false;
  }
  for (const filterColumn of filterColumns) {
    const column = columns[filterColumn.index];
    if (!column) {
      throw new XlsbParseError(
        "BrtBeginFilterColumn",
        `invalid table column index ${filterColumn.index}`
      );
    }
    column.filterButton = filterColumn.filterButton;
    if (filterColumn.rawFilterXml.length > 0) {
      column.rawFilterXml = filterColumn.rawFilterXml;
    }
  }
  const publicColumns = columns.map(column => {
    const { id: _id, ...value } = column;
    return value;
  });
  return {
    id,
    model: {
      ref: tableRef,
      tableRef,
      autoFilterRef,
      name: name || displayName,
      displayName,
      columns: publicColumns,
      rows: [],
      headerRow,
      totalsRow,
      style
    },
    unsupportedRecordTypes: [...unsupportedRecordTypes].sort((left, right) => left - right),
    unsupportedSettings
  };
}

export function writeTablePart(
  model: TableModel,
  id: number,
  context: XlsbFormulaContext,
  unsupported: "error" | "ignore" = "error"
): Uint8Array {
  validateTableModel(model, unsupported);
  const writer = createBinaryWriter();
  writeRecord(writer, XlsbRecordType.BeginList, beginListPayload(model, id));
  if (model.autoFilterRef) {
    const filterColumns = model.columns.flatMap((column, index) =>
      column.filterButton !== undefined || column.rawFilterXml?.length
        ? [
            {
              index,
              filterButton: column.filterButton !== false,
              buttonInNextColumn: false,
              rawFilterXml: column.rawFilterXml ?? []
            }
          ]
        : []
    );
    writeAutoFilter(
      writer,
      rangePayload(model.autoFilterRef),
      model.autoFilterRef,
      autoFilterCriteriaFromColumns(model.autoFilterRef, filterColumns),
      unsupported
    );
  }
  const beginColumns = createPayload(4);
  beginColumns.view.setUint32(0, model.columns.length, true);
  writeRecord(writer, XlsbRecordType.BeginListCols, beginColumns.bytes);
  model.columns.forEach((column, index) => {
    writeRecord(writer, XlsbRecordType.BeginListCol, beginListColumnPayload(column, index + 1));
    writeOptionalTableFormula(
      writer,
      XlsbRecordType.ListCalculatedColumnFormula,
      column.calculatedColumnFormula,
      model.tableRef ?? model.ref,
      context,
      unsupported
    );
    writeOptionalTableFormula(
      writer,
      XlsbRecordType.ListTotalRowFormula,
      column.totalsRowFormula,
      model.tableRef ?? model.ref,
      context,
      unsupported
    );
    writeRecord(writer, XlsbRecordType.EndListCol);
  });
  writeRecord(writer, XlsbRecordType.EndListCols);
  if (model.style) {
    writeRecord(writer, XlsbRecordType.TableStyleClient, tableStylePayload(model.style));
  }
  writeRecord(writer, XlsbRecordType.EndList);
  return finishBinaryWriter(writer);
}

function parseBeginList(data: Uint8Array): {
  id: number;
  tableRef: string;
  name: string;
  displayName: string;
  headerRow: boolean;
  totalsRow: boolean;
  unsupportedSettings: string[];
} {
  const reader = new XlsbBinaryReader(data, "BrtBeginList");
  const tableRef = readRange(reader);
  const listType = reader.u32();
  const id = reader.u32();
  const headerRow = readBoolean(reader, "BrtBeginList.crwHeader");
  const totalsRow = readBoolean(reader, "BrtBeginList.crwTotals");
  const flags = reader.u32();
  const differentialFormats = Array.from({ length: 6 }, () => reader.u32());
  const connectionId = reader.u32();
  const name = reader.wideString();
  const displayName = reader.wideString();
  const comment = reader.wideString();
  const styleNames = [reader.wideString(), reader.wideString(), reader.wideString()];
  if (reader.remaining !== 0) {
    throw new XlsbParseError("BrtBeginList", "unexpected trailing table data");
  }
  const unsupportedSettings: string[] = [];
  if (listType !== 0) {
    unsupportedSettings.push(`table ${displayName} type ${listType}`);
  }
  if ((flags & ~1) !== 0) {
    unsupportedSettings.push(`table ${displayName} flags 0x${flags.toString(16)}`);
  }
  if (differentialFormats.some(value => value !== 0xffffffff)) {
    unsupportedSettings.push(`table ${displayName} differential formatting`);
  }
  if (connectionId !== 0) {
    unsupportedSettings.push(`table ${displayName} external connection`);
  }
  if (comment) {
    unsupportedSettings.push(`table ${displayName} comment`);
  }
  if (styleNames.some(Boolean)) {
    unsupportedSettings.push(`table ${displayName} named row styles`);
  }
  return { id, tableRef, name, displayName, headerRow, totalsRow, unsupportedSettings };
}

function parseBeginListColumn(data: Uint8Array, unsupportedSettings: string[]): ParsedTableColumn {
  const reader = new XlsbBinaryReader(data, "BrtBeginListCol");
  const id = reader.u32();
  const totalFunctionCode = reader.u32();
  const differentialFormats = [reader.u32(), reader.u32(), reader.u32()];
  const queryFieldId = reader.u32();
  reader.wideString();
  const caption = reader.wideString();
  const total = reader.wideString();
  const styleNames = [reader.wideString(), reader.wideString(), reader.wideString()];
  if (!id || !caption || totalFunctionCode >= TOTAL_FUNCTIONS.length || reader.remaining !== 0) {
    throw new XlsbParseError("BrtBeginListCol", "invalid table-column metadata");
  }
  if (differentialFormats.some(value => value !== 0xffffffff)) {
    unsupportedSettings.push(`table column ${caption} differential formatting`);
  }
  if (queryFieldId !== 0) {
    unsupportedSettings.push(`table column ${caption} query field`);
  }
  if (styleNames.some(Boolean)) {
    unsupportedSettings.push(`table column ${caption} named styles`);
  }
  const totalFunction = TOTAL_FUNCTIONS[totalFunctionCode]!;
  return {
    id,
    name: caption,
    ...(total ? { totalsRowLabel: total } : {}),
    ...(totalFunction !== "none" ? { totalsRowFunction: totalFunction } : {})
  };
}

function parseTableFormula(
  data: Uint8Array,
  label: string,
  context: XlsbFormulaContext,
  unsupportedSettings: string[]
): string | undefined {
  const reader = new XlsbBinaryReader(data, label);
  const flags = reader.u8();
  if ((flags & 2) !== 0) {
    unsupportedSettings.push(`${label} is an array formula`);
  }
  try {
    return parseNameFormula(reader, label, context);
  } catch (error) {
    if (!(error instanceof ExcelNotSupportedError)) {
      throw error;
    }
    unsupportedSettings.push(`${label} tokens`);
    return undefined;
  }
}

function parseFilterColumn(data: Uint8Array, hiddenColumns: Set<number>): void {
  const reader = new XlsbBinaryReader(data, "BrtBeginFilterColumn");
  const index = reader.u32();
  const flags = reader.u16();
  if (reader.remaining !== 0) {
    throw new XlsbParseError("BrtBeginFilterColumn", "unexpected trailing filter-column data");
  }
  if ((flags & 1) !== 0) {
    hiddenColumns.add(index);
  }
}

function parseTableStyle(data: Uint8Array): TableStyleProperties {
  const reader = new XlsbBinaryReader(data, "BrtTableStyleClient");
  const flags = reader.u16();
  const theme = reader.wideString();
  if (reader.remaining !== 0) {
    throw new XlsbParseError("BrtTableStyleClient", "unexpected trailing style data");
  }
  return {
    ...(theme ? { theme } : {}),
    showFirstColumn: (flags & 1) !== 0,
    showLastColumn: (flags & 2) !== 0,
    showRowStripes: (flags & 4) !== 0,
    showColumnStripes: (flags & 8) !== 0
  };
}

function beginListPayload(model: TableModel, id: number): Uint8Array {
  const range = rangePayload(model.tableRef ?? model.ref);
  const strings = [
    encodeNullableWideString(model.name === model.displayName ? null : model.name),
    encodeNullableWideString(model.displayName ?? model.name),
    encodeNullableWideString(""),
    encodeNullableWideString(null),
    encodeNullableWideString(null),
    encodeNullableWideString(null)
  ];
  const payload = createPayload(64 + strings.reduce((length, value) => length + value.length, 0));
  payload.bytes.set(range);
  payload.view.setUint32(20, id, true);
  payload.view.setUint32(24, model.headerRow === false ? 0 : 1, true);
  payload.view.setUint32(28, model.totalsRow ? 1 : 0, true);
  payload.view.setUint32(32, model.totalsRow ? 1 : 0, true);
  for (let offset = 36; offset < 60; offset += 4) {
    payload.view.setUint32(offset, 0xffffffff, true);
  }
  let offset = 64;
  strings.forEach(value => {
    payload.bytes.set(value, offset);
    offset += value.length;
  });
  return payload.bytes;
}

function beginListColumnPayload(column: TableColumnProperties, id: number): Uint8Array {
  const functionCode = TOTAL_FUNCTIONS.indexOf(column.totalsRowFunction ?? "none");
  const strings = [
    encodeNullableWideString(null),
    encodeNullableWideString(column.name),
    encodeNullableWideString(column.totalsRowLabel ?? null),
    encodeNullableWideString(null),
    encodeNullableWideString(null),
    encodeNullableWideString(null)
  ];
  const payload = createPayload(24 + strings.reduce((length, value) => length + value.length, 0));
  payload.view.setUint32(0, id, true);
  payload.view.setUint32(4, functionCode < 0 ? 0 : functionCode, true);
  payload.view.setUint32(8, 0xffffffff, true);
  payload.view.setUint32(12, 0xffffffff, true);
  payload.view.setUint32(16, 0xffffffff, true);
  let offset = 24;
  strings.forEach(value => {
    payload.bytes.set(value, offset);
    offset += value.length;
  });
  return payload.bytes;
}

function tableStylePayload(style: TableStyleProperties): Uint8Array {
  const theme = encodeNullableWideString(style.theme ?? null);
  const payload = createPayload(2 + theme.length);
  let flags = style.showFirstColumn ? 1 : 0;
  flags |= style.showLastColumn ? 2 : 0;
  flags |= style.showRowStripes ? 4 : 0;
  flags |= style.showColumnStripes ? 8 : 0;
  payload.view.setUint16(0, flags, true);
  payload.bytes.set(theme, 2);
  return payload.bytes;
}

function writeOptionalTableFormula(
  writer: ReturnType<typeof createBinaryWriter>,
  type: number,
  formula: string | undefined,
  address: string,
  context: XlsbFormulaContext,
  unsupported: "error" | "ignore"
): void {
  if (!formula) {
    return;
  }
  try {
    const parsed = compileCellFormula(formula, address.split(":")[0]!, context);
    const payload = new Uint8Array(1 + parsed.length);
    payload.set(parsed, 1);
    writeRecord(writer, type, payload);
  } catch (error) {
    if (unsupported !== "ignore" || !(error instanceof ExcelNotSupportedError)) {
      throw error;
    }
  }
}

function validateTableModel(model: TableModel, unsupported: "error" | "ignore"): void {
  if (!model.columns.length || !(model.tableRef ?? model.ref) || !model.name) {
    throw new ExcelNotSupportedError(
      "Write XLSB table",
      "table range, name and columns are required"
    );
  }
  if (unsupported === "ignore") {
    return;
  }
  const unsupportedFeatures = [
    model.rawAttributes && "preserved root attributes",
    model.sortStateXml && "sort state",
    model.autoFilterSortStateXml && "auto-filter sort state",
    model.autoFilterExtLstXml && "auto-filter extensions",
    model.extLstXml && "extensions"
  ].filter(Boolean);
  if (unsupportedFeatures.length > 0) {
    throw new ExcelNotSupportedError(
      `Write XLSB table ${model.name}`,
      unsupportedFeatures.join(", ")
    );
  }
}

function parseCount(data: Uint8Array, context: string): number {
  const reader = new XlsbBinaryReader(data, context);
  const count = reader.u32();
  if (reader.remaining !== 0) {
    throw new XlsbParseError(context, "unexpected trailing data");
  }
  return count;
}

function readBoolean(reader: XlsbBinaryReader, context: string): boolean {
  const value = reader.u32();
  if (value > 1) {
    throw new XlsbParseError(context, `invalid Boolean value ${value}`);
  }
  return value === 1;
}

function parseRange(data: Uint8Array, context: string): string {
  const reader = new XlsbBinaryReader(data, context);
  const range = readRange(reader);
  if (reader.remaining !== 0) {
    throw new XlsbParseError(context, "unexpected trailing range data");
  }
  return range;
}

function readRange(reader: XlsbBinaryReader): string {
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstColumn = reader.u32();
  const lastColumn = reader.u32();
  return colCache.encode(firstRow + 1, firstColumn + 1, lastRow + 1, lastColumn + 1);
}

function rangePayload(range: string): Uint8Array {
  const decoded = colCache.decode(range);
  if (!("dimensions" in decoded)) {
    throw new ExcelNotSupportedError("Write XLSB table", `invalid table range ${range}`);
  }
  const payload = createPayload(16);
  payload.view.setUint32(0, decoded.top - 1, true);
  payload.view.setUint32(4, decoded.bottom - 1, true);
  payload.view.setUint32(8, decoded.left - 1, true);
  payload.view.setUint32(12, decoded.right - 1, true);
  return payload.bytes;
}

function encodeNullableWideString(value: string | null): Uint8Array {
  if (value !== null) {
    return encodeWideString(value);
  }
  const payload = createPayload(4);
  payload.view.setUint32(0, 0xffffffff, true);
  return payload.bytes;
}

function isTableContainerRecord(type: number): boolean {
  return (
    type === XlsbRecordType.EndList ||
    type === XlsbRecordType.EndAutoFilter ||
    type === XlsbRecordType.EndFilterColumn ||
    type === XlsbRecordType.BeginFilters ||
    type === XlsbRecordType.EndFilters ||
    type === XlsbRecordType.Filter ||
    type === XlsbRecordType.ColorFilter ||
    type === XlsbRecordType.IconFilter ||
    type === XlsbRecordType.Top10Filter ||
    type === XlsbRecordType.DynamicFilter ||
    type === XlsbRecordType.BeginCustomFilters ||
    type === XlsbRecordType.EndCustomFilters ||
    type === XlsbRecordType.CustomFilter ||
    type === XlsbRecordType.AutoFilterDateGroupItem ||
    type === XlsbRecordType.EndListCols ||
    type === XlsbRecordType.FutureRecordBegin ||
    type === XlsbRecordType.FutureRecordEnd ||
    type === XlsbRecordType.AlternateContentBegin ||
    type === XlsbRecordType.AlternateContentEnd
  );
}
