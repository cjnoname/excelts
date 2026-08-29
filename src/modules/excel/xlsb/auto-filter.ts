import type { AutoFilterCriteria } from "@excel/core/worksheet-core";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  iterateBiffRecords,
  writeRecord,
  XlsbBinaryReader
} from "@excel/xlsb/binary";
import type { XlsbBinaryWriter } from "@excel/xlsb/binary";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import { parseXml } from "@xml/dom";
import type { XmlElement } from "@xml/types";
import { XmlWriter } from "@xml/writer";

export interface XlsbFilterColumn {
  index: number;
  filterButton: boolean;
  buttonInNextColumn: boolean;
  rawFilterXml: string[];
}

const DYNAMIC_FILTER_TYPES = [
  undefined,
  "aboveAverage",
  "belowAverage",
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  "tomorrow",
  "today",
  "yesterday",
  "nextWeek",
  "thisWeek",
  "lastWeek",
  "nextMonth",
  "thisMonth",
  "lastMonth",
  "nextQuarter",
  "thisQuarter",
  "lastQuarter",
  "nextYear",
  "thisYear",
  "lastYear",
  "yearToDate",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "M7",
  "M8",
  "M9",
  "M10",
  "M11",
  "M12"
] as const;

const CUSTOM_FILTER_OPERATORS = [
  undefined,
  "lessThan",
  "equal",
  "lessThanOrEqual",
  "greaterThan",
  "notEqual",
  "greaterThanOrEqual"
] as const;

const ICON_SETS = [
  "3Arrows",
  "3ArrowsGray",
  "3Flags",
  "3TrafficLights1",
  "3TrafficLights2",
  "3Signs",
  "3Symbols",
  "3Symbols2",
  "4Arrows",
  "4ArrowsGray",
  "4RedToBlack",
  "4Rating",
  "4TrafficLights",
  "5Arrows",
  "5ArrowsGray",
  "5Rating",
  "5Quarters"
] as const;

const DATE_GROUPINGS = ["year", "month", "day", "hour", "minute", "second"] as const;

/** Decode all representable filter columns in the first BIFF12 AutoFilter collection. */
export function parseAutoFilterColumns(bytes: Uint8Array): XlsbFilterColumn[] {
  const columns: XlsbFilterColumn[] = [];
  let inAutoFilter = false;
  let current: XlsbFilterColumn | undefined;
  let criteriaWriter: XmlWriter | undefined;
  let criteriaContainer: "filters" | "customFilters" | undefined;

  for (const record of iterateBiffRecords(bytes, "XLSB AutoFilter")) {
    if (record.type === XlsbRecordType.BeginAutoFilter) {
      if (inAutoFilter) {
        throw new XlsbParseError("XLSB AutoFilter", "nested BrtBeginAFilter records");
      }
      inAutoFilter = true;
      continue;
    }
    if (!inAutoFilter) {
      continue;
    }
    if (record.type === XlsbRecordType.EndAutoFilter) {
      if (current || criteriaContainer) {
        throw new XlsbParseError("XLSB AutoFilter", "unterminated filter-column criteria");
      }
      break;
    }
    if (record.type === XlsbRecordType.BeginFilterColumn) {
      if (current) {
        throw new XlsbParseError("XLSB AutoFilter", "nested BrtBeginFilterColumn records");
      }
      const reader = new XlsbBinaryReader(record.data, "BrtBeginFilterColumn");
      const index = reader.u32();
      const flags = reader.u16();
      if ((flags & ~0x03) !== 0 || reader.remaining !== 0) {
        throw new XlsbParseError("BrtBeginFilterColumn", "invalid filter-column flags");
      }
      current = {
        index,
        filterButton: (flags & 0x01) === 0,
        buttonInNextColumn: (flags & 0x02) !== 0,
        rawFilterXml: []
      };
      criteriaWriter = new XmlWriter();
      continue;
    }
    if (!current || !criteriaWriter) {
      continue;
    }
    switch (record.type) {
      case XlsbRecordType.EndFilterColumn:
        if (criteriaContainer) {
          throw new XlsbParseError("BrtEndFilterColumn", "unterminated filter criteria");
        }
        if (criteriaWriter.xml) {
          current.rawFilterXml.push(criteriaWriter.xml);
        }
        columns.push(current);
        current = undefined;
        criteriaWriter = undefined;
        break;
      case XlsbRecordType.BeginFilters:
        ensureNoCriteriaContainer(criteriaContainer, "BrtBeginFilters");
        parseBeginFilters(criteriaWriter, record.data);
        criteriaContainer = "filters";
        break;
      case XlsbRecordType.EndFilters:
        ensureCriteriaContainer(criteriaContainer, "filters", "BrtEndFilters");
        criteriaWriter.closeNode();
        criteriaContainer = undefined;
        break;
      case XlsbRecordType.Filter:
        ensureCriteriaContainer(criteriaContainer, "filters", "BrtFilter");
        parseValueFilter(criteriaWriter, record.data);
        break;
      case XlsbRecordType.AutoFilterDateGroupItem:
        ensureCriteriaContainer(criteriaContainer, "filters", "BrtAFilterDateGroupItem");
        parseDateGroupItem(criteriaWriter, record.data);
        break;
      case XlsbRecordType.BeginCustomFilters:
        ensureNoCriteriaContainer(criteriaContainer, "BrtBeginCustomFilters");
        parseBeginCustomFilters(criteriaWriter, record.data);
        criteriaContainer = "customFilters";
        break;
      case XlsbRecordType.EndCustomFilters:
        ensureCriteriaContainer(criteriaContainer, "customFilters", "BrtEndCustomFilters");
        criteriaWriter.closeNode();
        criteriaContainer = undefined;
        break;
      case XlsbRecordType.CustomFilter:
        ensureCriteriaContainer(criteriaContainer, "customFilters", "BrtCustomFilter");
        parseCustomFilter(criteriaWriter, record.data);
        break;
      case XlsbRecordType.DynamicFilter:
        ensureNoCriteriaContainer(criteriaContainer, "BrtDynamicFilter");
        parseDynamicFilter(criteriaWriter, record.data);
        break;
      case XlsbRecordType.Top10Filter:
        ensureNoCriteriaContainer(criteriaContainer, "BrtTop10Filter");
        parseTop10Filter(criteriaWriter, record.data);
        break;
      case XlsbRecordType.ColorFilter:
        ensureNoCriteriaContainer(criteriaContainer, "BrtColorFilter");
        parseColorFilter(criteriaWriter, record.data);
        break;
      case XlsbRecordType.IconFilter:
        ensureNoCriteriaContainer(criteriaContainer, "BrtIconFilter");
        parseIconFilter(criteriaWriter, record.data);
        break;
    }
  }
  return columns;
}

export function autoFilterCriteriaFromColumns(
  ref: string,
  columns: readonly XlsbFilterColumn[]
): AutoFilterCriteria | undefined {
  if (columns.length === 0) {
    return undefined;
  }
  const writer = new XmlWriter();
  for (const column of columns) {
    writer.openNode("filterColumn", {
      colId: column.index,
      ...(column.filterButton ? {} : { hiddenButton: 1 })
    });
    column.rawFilterXml.forEach(xml => writer.writeRaw(xml));
    writer.closeNode();
  }
  return { ref, xml: writer.xml };
}

/** Write a complete BrtBeginAFilter collection, translating retained XLSX criteria when present. */
export function writeAutoFilter(
  writer: XlsbBinaryWriter,
  rangePayload: Uint8Array,
  ref: string,
  criteria: AutoFilterCriteria | undefined,
  unsupported: "error" | "ignore"
): void {
  writeRecord(writer, XlsbRecordType.BeginAutoFilter, rangePayload);
  if (criteria?.ref === ref && criteria.xml) {
    const criteriaRecords = createBinaryWriter();
    try {
      const document = parseXml(`<autoFilter>${criteria.xml}</autoFilter>`);
      for (const child of childElements(document.root)) {
        if (child.name !== "filterColumn") {
          throw unsupportedFilterXml(child.name);
        }
        writeFilterColumn(criteriaRecords, child);
      }
      writer.chunks.push(...criteriaRecords.chunks);
      writer.length += criteriaRecords.length;
    } catch (error) {
      if (unsupported !== "ignore") {
        throw error;
      }
    }
  }
  writeRecord(writer, XlsbRecordType.EndAutoFilter);
}

function parseBeginFilters(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtBeginFilters");
  const blank = reader.u32();
  reader.u32();
  if (blank > 1 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtBeginFilters", "invalid blank-filter flag");
  }
  writer.openNode("filters", blank ? { blank: 1 } : undefined);
}

function parseValueFilter(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtFilter");
  const value = reader.wideString();
  if (!value || value.length > 255 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtFilter", "invalid filter value");
  }
  writer.leafNode("filter", { val: value });
}

function parseDateGroupItem(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtAFilterDateGroupItem");
  const year = reader.u16();
  const month = reader.u16();
  const day = reader.u32();
  const hour = reader.u16();
  const minute = reader.u16();
  const second = reader.u16();
  reader.u16();
  reader.u32();
  const grouping = reader.u32();
  const name = DATE_GROUPINGS[grouping];
  if (!name || year < 1000 || year > 9999 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtAFilterDateGroupItem", "invalid date-group criterion");
  }
  writer.leafNode("dateGroupItem", {
    year,
    ...(grouping >= 1 ? { month } : {}),
    ...(grouping >= 2 ? { day } : {}),
    ...(grouping >= 3 ? { hour } : {}),
    ...(grouping >= 4 ? { minute } : {}),
    ...(grouping >= 5 ? { second } : {}),
    dateTimeGrouping: name
  });
}

function parseBeginCustomFilters(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtBeginCustomFilters");
  const useOr = reader.u32();
  if (useOr > 1 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtBeginCustomFilters", "invalid relationship flag");
  }
  writer.openNode("customFilters", useOr ? undefined : { and: 1 });
}

function parseCustomFilter(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtCustomFilter");
  const valueType = reader.u8();
  const operator = CUSTOM_FILTER_OPERATORS[reader.u8()];
  if (!operator) {
    throw new XlsbParseError("BrtCustomFilter", "invalid comparison operator");
  }
  let value: string;
  switch (valueType) {
    case 0x04:
      value = String(reader.f64());
      break;
    case 0x06:
      reader.skip(8);
      value = reader.wideString();
      break;
    case 0x08:
      value = reader.u8() ? "TRUE" : "FALSE";
      reader.skip(7);
      break;
    case 0x0c:
      reader.skip(8);
      value = "";
      break;
    case 0x0e:
      reader.skip(8);
      value = "";
      break;
    default:
      throw new XlsbParseError("BrtCustomFilter", `unsupported value type ${valueType}`);
  }
  if (reader.remaining !== 0) {
    throw new XlsbParseError("BrtCustomFilter", "unexpected trailing data");
  }
  writer.leafNode("customFilter", {
    ...(operator === "equal" ? {} : { operator }),
    val: value
  });
}

function parseDynamicFilter(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtDynamicFilter");
  const typeCode = reader.u32();
  const type = DYNAMIC_FILTER_TYPES[typeCode];
  const applied = reader.u8() & 0x01;
  const value = reader.f64();
  const maxValue = reader.f64();
  if (typeCode === 0) {
    if (reader.remaining !== 0) {
      throw new XlsbParseError("BrtDynamicFilter", "unexpected trailing data");
    }
    return;
  }
  if (!type || reader.remaining !== 0) {
    throw new XlsbParseError("BrtDynamicFilter", "invalid dynamic-filter type");
  }
  writer.leafNode("dynamicFilter", {
    type,
    ...(applied ? { val: value, maxVal: maxValue } : {})
  });
}

function parseTop10Filter(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtTop10Filter");
  const flags = reader.u8();
  const value = reader.f64();
  const filterValue = reader.f64();
  if ((flags & ~0x07) !== 0 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtTop10Filter", "invalid top-filter flags");
  }
  writer.leafNode("top10", {
    top: flags & 0x01 ? 1 : 0,
    percent: flags & 0x02 ? 1 : 0,
    val: value,
    ...(flags & 0x04 ? { filterVal: filterValue } : {})
  });
}

function parseColorFilter(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtColorFilter");
  const dxfId = reader.u32();
  const cellColor = reader.u32();
  if (dxfId === 0xffffffff || cellColor > 1 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtColorFilter", "invalid color-filter fields");
  }
  writer.leafNode("colorFilter", { dxfId, cellColor });
}

function parseIconFilter(writer: XmlWriter, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtIconFilter");
  const iconSetId = reader.u32();
  const iconSet = ICON_SETS[iconSetId];
  const iconId = reader.i32();
  if (iconSetId === 0xffffffff && iconId === -1 && reader.remaining === 0) {
    return;
  }
  if (!iconSet || iconId < 0 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtIconFilter", "invalid icon-filter fields");
  }
  writer.leafNode("iconFilter", { iconSet, iconId });
}

function writeFilterColumn(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["colId", "hiddenButton", "showButton"]);
  const index = requiredIntegerAttribute(element, "colId", 0, 16_383);
  const hidden = booleanAttribute(element, "hiddenButton", false);
  const shown = booleanAttribute(element, "showButton", true);
  const payload = createPayload(6);
  payload.view.setUint32(0, index, true);
  payload.view.setUint16(4, hidden || !shown ? 1 : 0, true);
  writeRecord(writer, XlsbRecordType.BeginFilterColumn, payload.bytes);
  const children = childElements(element);
  if (children.length > 1) {
    throw unsupportedFilterXml("multiple criteria in one filterColumn");
  }
  if (children[0]) {
    writeCriteria(writer, children[0]);
  }
  writeRecord(writer, XlsbRecordType.EndFilterColumn);
}

function writeCriteria(writer: XlsbBinaryWriter, element: XmlElement): void {
  switch (element.name) {
    case "filters":
      writeValueFilters(writer, element);
      break;
    case "customFilters":
      writeCustomFilters(writer, element);
      break;
    case "dynamicFilter":
      writeDynamicFilter(writer, element);
      break;
    case "top10":
      writeTop10Filter(writer, element);
      break;
    case "colorFilter":
      throw unsupportedFilterXml("colorFilter requires a BIFF12 differential style");
    case "iconFilter":
      writeIconFilter(writer, element);
      break;
    default:
      throw unsupportedFilterXml(element.name);
  }
}

function writeValueFilters(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["blank", "calendarType"]);
  const calendarType = element.attributes.calendarType;
  if (calendarType && calendarType !== "none" && calendarType !== "gregorian") {
    throw unsupportedFilterXml(`calendar type ${calendarType}`);
  }
  const begin = createPayload(8);
  begin.view.setUint32(0, booleanAttribute(element, "blank", false) ? 1 : 0, true);
  writeRecord(writer, XlsbRecordType.BeginFilters, begin.bytes);
  for (const child of childElements(element)) {
    if (child.name === "filter") {
      assertOnlyAttributes(child, ["val"]);
      const value = requiredAttribute(child, "val");
      if (value.length < 1 || value.length > 255) {
        throw unsupportedFilterXml("filter values must contain 1 to 255 characters");
      }
      writeRecord(writer, XlsbRecordType.Filter, encodeWideString(value));
    } else if (child.name === "dateGroupItem") {
      writeDateGroupItem(writer, child);
    } else {
      throw unsupportedFilterXml(child.name);
    }
  }
  writeRecord(writer, XlsbRecordType.EndFilters);
}

function writeDateGroupItem(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
    "dateTimeGrouping"
  ]);
  const groupingName = requiredAttribute(element, "dateTimeGrouping");
  const grouping = DATE_GROUPINGS.indexOf(groupingName as (typeof DATE_GROUPINGS)[number]);
  if (grouping < 0) {
    throw unsupportedFilterXml(`date grouping ${groupingName}`);
  }
  const payload = createPayload(24);
  payload.view.setUint16(0, requiredIntegerAttribute(element, "year", 1000, 9999), true);
  if (grouping >= 1) {
    payload.view.setUint16(2, requiredIntegerAttribute(element, "month", 1, 12), true);
  }
  if (grouping >= 2) {
    payload.view.setUint32(4, requiredIntegerAttribute(element, "day", 1, 31), true);
  }
  if (grouping >= 3) {
    payload.view.setUint16(8, requiredIntegerAttribute(element, "hour", 0, 23), true);
  }
  if (grouping >= 4) {
    payload.view.setUint16(10, requiredIntegerAttribute(element, "minute", 0, 59), true);
  }
  if (grouping >= 5) {
    payload.view.setUint16(12, requiredIntegerAttribute(element, "second", 0, 59), true);
  }
  payload.view.setUint32(20, grouping, true);
  writeRecord(writer, XlsbRecordType.AutoFilterDateGroupItem, payload.bytes);
}

function writeCustomFilters(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["and"]);
  const filters = childElements(element);
  if (
    filters.length < 1 ||
    filters.length > 2 ||
    filters.some(child => child.name !== "customFilter")
  ) {
    throw unsupportedFilterXml("customFilters must contain one or two customFilter elements");
  }
  const begin = createPayload(4);
  begin.view.setUint32(0, booleanAttribute(element, "and", false) ? 0 : 1, true);
  writeRecord(writer, XlsbRecordType.BeginCustomFilters, begin.bytes);
  filters.forEach(filter => writeCustomFilter(writer, filter));
  writeRecord(writer, XlsbRecordType.EndCustomFilters);
}

function writeCustomFilter(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["operator", "val"]);
  const operatorName = element.attributes.operator ?? "equal";
  const operator = CUSTOM_FILTER_OPERATORS.indexOf(
    operatorName as NonNullable<(typeof CUSTOM_FILTER_OPERATORS)[number]>
  );
  if (operator < 1) {
    throw unsupportedFilterXml(`custom-filter operator ${operatorName}`);
  }
  const value = requiredAttribute(element, "val");
  let valueType = 0x06;
  let tail = new Uint8Array(8 + encodeWideString(value).length);
  tail.set(encodeWideString(value), 8);
  if (value === "" && (operatorName === "equal" || operatorName === "notEqual")) {
    valueType = operatorName === "equal" ? 0x0c : 0x0e;
    tail = new Uint8Array(8);
  } else if (/^(?:TRUE|FALSE)$/i.test(value)) {
    valueType = 0x08;
    tail = new Uint8Array(8);
    tail[0] = value.toUpperCase() === "TRUE" ? 1 : 0;
  } else if (value.trim() !== "" && Number.isFinite(Number(value))) {
    valueType = 0x04;
    tail = new Uint8Array(8);
    new DataView(tail.buffer).setFloat64(0, Number(value), true);
  }
  const payload = new Uint8Array(2 + tail.length);
  payload[0] = valueType;
  payload[1] = operator;
  payload.set(tail, 2);
  writeRecord(writer, XlsbRecordType.CustomFilter, payload);
}

function writeDynamicFilter(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["type", "val", "maxVal"]);
  const typeName = requiredAttribute(element, "type");
  const type = DYNAMIC_FILTER_TYPES.indexOf(
    typeName as NonNullable<(typeof DYNAMIC_FILTER_TYPES)[number]>
  );
  if (type < 0) {
    throw unsupportedFilterXml(`dynamic-filter type ${typeName}`);
  }
  const hasValue = element.attributes.val !== undefined || element.attributes.maxVal !== undefined;
  const payload = createPayload(21);
  payload.view.setUint32(0, type, true);
  payload.bytes[4] = hasValue ? 1 : 0;
  if (hasValue) {
    payload.view.setFloat64(5, optionalFiniteNumberAttribute(element, "val", 0), true);
    payload.view.setFloat64(13, optionalFiniteNumberAttribute(element, "maxVal", 0), true);
  }
  writeRecord(writer, XlsbRecordType.DynamicFilter, payload.bytes);
}

function writeTop10Filter(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["top", "percent", "val", "filterVal"]);
  const payload = createPayload(17);
  const applied = element.attributes.filterVal !== undefined;
  payload.bytes[0] =
    (booleanAttribute(element, "top", true) ? 0x01 : 0) |
    (booleanAttribute(element, "percent", false) ? 0x02 : 0) |
    (applied ? 0x04 : 0);
  payload.view.setFloat64(1, finiteNumberAttribute(element, "val"), true);
  if (applied) {
    payload.view.setFloat64(9, finiteNumberAttribute(element, "filterVal"), true);
  }
  writeRecord(writer, XlsbRecordType.Top10Filter, payload.bytes);
}

function writeIconFilter(writer: XlsbBinaryWriter, element: XmlElement): void {
  assertOnlyAttributes(element, ["iconSet", "iconId"]);
  const iconSetName = requiredAttribute(element, "iconSet");
  const iconSet = ICON_SETS.indexOf(iconSetName as (typeof ICON_SETS)[number]);
  if (iconSet < 0) {
    throw unsupportedFilterXml(`icon set ${iconSetName}`);
  }
  const payload = createPayload(8);
  payload.view.setUint32(0, iconSet, true);
  payload.view.setInt32(4, requiredIntegerAttribute(element, "iconId", 0, 4), true);
  writeRecord(writer, XlsbRecordType.IconFilter, payload.bytes);
}

function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.type === "element");
}

function ensureNoCriteriaContainer(
  actual: "filters" | "customFilters" | undefined,
  context: string
): void {
  if (actual) {
    throw new XlsbParseError(context, `nested inside ${actual}`);
  }
}

function ensureCriteriaContainer(
  actual: "filters" | "customFilters" | undefined,
  expected: "filters" | "customFilters",
  context: string
): void {
  if (actual !== expected) {
    throw new XlsbParseError(context, `outside ${expected}`);
  }
}

function assertOnlyAttributes(element: XmlElement, allowed: readonly string[]): void {
  const unknown = Object.keys(element.attributes).find(name => !allowed.includes(name));
  if (unknown) {
    throw unsupportedFilterXml(`${element.name} attribute ${unknown}`);
  }
}

function requiredAttribute(element: XmlElement, name: string): string {
  const value = element.attributes[name];
  if (value === undefined) {
    throw unsupportedFilterXml(`${element.name} without ${name}`);
  }
  return value;
}

function booleanAttribute(element: XmlElement, name: string, fallback: boolean): boolean {
  const value = element.attributes[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  throw unsupportedFilterXml(`${element.name} ${name}=${value}`);
}

function requiredIntegerAttribute(
  element: XmlElement,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(requiredAttribute(element, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw unsupportedFilterXml(`${element.name} ${name}=${element.attributes[name]}`);
  }
  return value;
}

function finiteNumberAttribute(element: XmlElement, name: string): number {
  const value = Number(requiredAttribute(element, name));
  if (!Number.isFinite(value)) {
    throw unsupportedFilterXml(`${element.name} ${name}=${element.attributes[name]}`);
  }
  return value;
}

function optionalFiniteNumberAttribute(
  element: XmlElement,
  name: string,
  fallback: number
): number {
  return element.attributes[name] === undefined ? fallback : finiteNumberAttribute(element, name);
}

function unsupportedFilterXml(feature: string): ExcelNotSupportedError {
  return new ExcelNotSupportedError(
    "Write XLSB AutoFilter criteria",
    `${feature} cannot be represented in BIFF12`
  );
}
