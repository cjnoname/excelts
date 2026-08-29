import type { DefinedNameModel } from "@excel/core/defined-names";
import type { WorkbookProtectionModel } from "@excel/core/workbook.browser";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type { CalculationProperties, WorkbookView } from "@excel/types";
import {
  createBinaryWriter,
  createPayload,
  encodeWideString,
  finishBinaryWriter,
  iterateBiffRecords,
  writeRecord,
  XlsbBinaryReader
} from "@excel/xlsb/binary";
import { compileCellFormula, parseNameFormula, type XlsbFormulaContext } from "@excel/xlsb/formula";
import {
  encodeIsoPasswordData,
  parseIsoPasswordData,
  validateProtectionSpinCount
} from "@excel/xlsb/protection";
import { XlsbRecordType } from "@excel/xlsb/record-types";

export interface XlsbSheetDescriptor {
  name: string;
  relationId: string;
  sheetId: number;
  state: "visible" | "hidden" | "veryHidden";
}

export interface XlsbWorkbookPart {
  sheets: XlsbSheetDescriptor[];
  date1904: boolean;
  externalSheets: XlsbExternalSheet[];
  views: WorkbookView[];
  calcProperties: Partial<CalculationProperties>;
  definedNames: DefinedNameModel[];
  formulaNames: { name: string; localSheetId?: number }[];
  protection?: WorkbookProtectionModel;
  unsupportedSettings: string[];
  unsupportedRecordTypes: number[];
}

export interface XlsbExternalSheet {
  externalLink: number;
  firstSheet: number;
  lastSheet: number;
}

export function parseWorkbookPart(bytes: Uint8Array): XlsbWorkbookPart {
  const result: XlsbWorkbookPart = {
    sheets: [],
    date1904: false,
    externalSheets: [],
    views: [],
    calcProperties: {},
    definedNames: [],
    formulaNames: collectDefinedNameHeaders(bytes),
    unsupportedSettings: [],
    unsupportedRecordTypes: []
  };
  const unsupportedRecordTypes = new Set<number>();
  let pendingProtectionFlags: number | undefined;
  for (const record of iterateBiffRecords(bytes, "xl/workbook.bin")) {
    if (pendingProtectionFlags !== undefined && record.type !== XlsbRecordType.BookProtection) {
      throw new XlsbParseError(
        "xl/workbook.bin",
        "BrtBookProtectionIso is not immediately followed by BrtBookProtection"
      );
    }
    if (record.type === XlsbRecordType.WbProp) {
      const reader = new XlsbBinaryReader(record.data, "BrtWbProp");
      result.date1904 = (reader.u32() & 1) !== 0;
    } else if (record.type === XlsbRecordType.BundleSh) {
      const { state, sheetId, relationId, name } = parseBundleSheet(
        record.data,
        result.sheets.length + 1
      );
      result.sheets.push({
        name,
        relationId,
        sheetId,
        state: state === 1 ? "hidden" : state === 2 ? "veryHidden" : "visible"
      });
    } else if (record.type === XlsbRecordType.ExternSheet) {
      const reader = new XlsbBinaryReader(record.data, "BrtExternSheet");
      const count = reader.u32();
      for (let index = 0; index < count; index++) {
        result.externalSheets.push({
          externalLink: reader.u32(),
          firstSheet: reader.i32(),
          lastSheet: reader.i32()
        });
      }
    } else if (record.type === XlsbRecordType.BookView) {
      result.views.push(parseBookView(record.data));
    } else if (record.type === XlsbRecordType.CalcProp) {
      parseCalculationProperties(result, record.data);
    } else if (record.type === XlsbRecordType.Name) {
      parseDefinedName(result, record.data);
    } else if (record.type === XlsbRecordType.BookProtectionIso) {
      pendingProtectionFlags = parseIsoWorkbookProtection(result, record.data);
    } else if (record.type === XlsbRecordType.BookProtection) {
      const flags = parseLegacyWorkbookProtection(
        result,
        record.data,
        pendingProtectionFlags !== undefined
      );
      if (pendingProtectionFlags !== undefined && flags !== pendingProtectionFlags) {
        throw new XlsbParseError(
          "xl/workbook.bin",
          "BrtBookProtection does not match the preceding BrtBookProtectionIso"
        );
      }
      pendingProtectionFlags = undefined;
    } else if (!isSupportedWorkbookRecord(record.type)) {
      unsupportedRecordTypes.add(record.type);
    }
  }
  result.unsupportedRecordTypes = [...unsupportedRecordTypes].sort((left, right) => left - right);
  return result;
}

function parseDefinedName(result: XlsbWorkbookPart, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtName");
  const flags = reader.u32();
  reader.u8();
  const localSheetId = reader.u32();
  const name = reader.wideString();
  let formula: string | undefined;
  try {
    formula = parseNameFormula(reader, name, {
      ...formulaContext(result),
      ...(localSheetId === 0xffffffff ? {} : { currentSheetIndex: localSheetId })
    });
  } catch (error) {
    if (!(error instanceof ExcelNotSupportedError)) {
      throw error;
    }
    result.unsupportedSettings.push(`defined name ${name} formula tokens`);
  }
  const comment = reader.wideString();
  if (flags & 0x08) {
    reader.wideString();
    reader.wideString();
    reader.wideString();
    reader.wideString();
  }
  if ((flags & ~0x21) !== 0 || comment || reader.remaining !== 0) {
    result.unsupportedSettings.push(`defined name ${name} metadata`);
  }
  if (!formula) {
    result.unsupportedSettings.push(`defined name ${name} without a representable formula`);
    return;
  }
  result.definedNames.push({
    name,
    ranges: [],
    rawText: formula,
    ...(localSheetId === 0xffffffff ? {} : { localSheetId }),
    ...(flags & 0x01 ? { hidden: true } : {})
  });
}

function formulaContext(result: XlsbWorkbookPart): XlsbFormulaContext {
  return {
    sheetNames: result.sheets.map(sheet => sheet.name),
    externalSheets: result.externalSheets,
    definedNames: result.formulaNames
  };
}

function collectDefinedNameHeaders(bytes: Uint8Array): { name: string; localSheetId?: number }[] {
  const headers: { name: string; localSheetId?: number }[] = [];
  for (const record of iterateBiffRecords(bytes, "xl/workbook.bin defined names")) {
    if (record.type !== XlsbRecordType.Name) {
      continue;
    }
    const reader = new XlsbBinaryReader(record.data, "BrtName header");
    reader.u32();
    reader.u8();
    const localSheetId = reader.u32();
    const name = reader.wideString();
    if (!name) {
      throw new XlsbParseError("BrtName", "defined name cannot be empty");
    }
    headers.push({
      name,
      ...(localSheetId === 0xffffffff ? {} : { localSheetId })
    });
  }
  return headers;
}

function parseBundleSheet(
  data: Uint8Array,
  fallbackSheetId: number
): { state: number; sheetId: number; relationId: string; name: string } {
  const reader = new XlsbBinaryReader(data, "BrtBundleSh");
  const state = reader.u32();
  const sheetId = reader.u32() || fallbackSheetId;
  try {
    const { relationId, name } = parseBundleSheetStrings(data.subarray(8));
    return { state, sheetId, relationId, name };
  } catch (error) {
    if (data.length < 12) {
      throw error;
    }
    try {
      const { relationId, name } = parseBundleSheetStrings(data.subarray(12));
      return { state, sheetId, relationId, name };
    } catch {
      throw error;
    }
  }
}

function parseBundleSheetStrings(data: Uint8Array): { relationId: string; name: string } {
  const reader = new XlsbBinaryReader(data, "BrtBundleSh strings");
  const relationId = reader.wideString();
  const name = reader.wideString();
  if (reader.remaining !== 0) {
    throw new Error(`BrtBundleSh has ${reader.remaining} trailing bytes`);
  }
  return { relationId, name };
}

function isSupportedWorkbookRecord(type: number): boolean {
  return (
    type === XlsbRecordType.BeginBook ||
    type === XlsbRecordType.EndBook ||
    type === XlsbRecordType.FileVersion ||
    type === XlsbRecordType.FutureRecordBegin ||
    type === XlsbRecordType.FutureRecordEnd ||
    type === XlsbRecordType.AlternateContentBegin ||
    type === XlsbRecordType.AlternateContentEnd ||
    type === XlsbRecordType.BeginBookViews ||
    type === XlsbRecordType.EndBookViews ||
    type === XlsbRecordType.BeginBundleShs ||
    type === XlsbRecordType.EndBundleShs ||
    type === XlsbRecordType.CalcProp ||
    type === XlsbRecordType.Name ||
    type === XlsbRecordType.BookProtection ||
    type === XlsbRecordType.BookProtectionIso ||
    type === XlsbRecordType.BeginExternals ||
    type === XlsbRecordType.EndExternals ||
    type === XlsbRecordType.SupSelf
  );
}

export function writeWorkbookPart(
  sheets: readonly XlsbSheetDescriptor[],
  date1904: boolean,
  views: readonly WorkbookView[] = [],
  definedNames: readonly DefinedNameModel[] = [],
  protection?: WorkbookProtectionModel,
  calcProperties: Partial<CalculationProperties> = {},
  unsupported: "error" | "ignore" = "error"
): Uint8Array {
  const writer = createBinaryWriter();
  writeRecord(writer, XlsbRecordType.BeginBook);
  writeRecord(writer, XlsbRecordType.FileVersion, fileVersionPayload());

  const properties = createPayload(12);
  properties.view.setUint32(0, 0x00010020 | (date1904 ? 1 : 0), true);
  writeRecord(writer, XlsbRecordType.WbProp, properties.bytes);
  writeWorkbookProtection(writer, protection, unsupported);

  writeRecord(writer, XlsbRecordType.BeginBookViews);
  if (views.length > 0) {
    views.forEach(view => writeRecord(writer, XlsbRecordType.BookView, bookViewPayload(view)));
  } else {
    writeRecord(writer, XlsbRecordType.BookView, bookViewPayload());
  }
  writeRecord(writer, XlsbRecordType.EndBookViews);

  writeRecord(writer, XlsbRecordType.BeginBundleShs);
  for (const sheet of sheets) {
    const relation = encodeWideString(sheet.relationId);
    const name = encodeWideString(sheet.name);
    const payload = new Uint8Array(8 + relation.length + name.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, sheet.state === "hidden" ? 1 : sheet.state === "veryHidden" ? 2 : 0, true);
    view.setUint32(4, sheet.sheetId, true);
    payload.set(relation, 8);
    payload.set(name, 8 + relation.length);
    writeRecord(writer, XlsbRecordType.BundleSh, payload);
  }
  writeRecord(writer, XlsbRecordType.EndBundleShs);
  writeCalculationProperties(writer, calcProperties, unsupported);
  writeRecord(writer, XlsbRecordType.BeginExternals);
  writeRecord(writer, XlsbRecordType.SupSelf);
  const externals = createPayload(4 + sheets.length * 12);
  externals.view.setUint32(0, sheets.length, true);
  sheets.forEach((_sheet, index) => {
    const offset = 4 + index * 12;
    externals.view.setUint32(offset, 0, true);
    externals.view.setInt32(offset + 4, index, true);
    externals.view.setInt32(offset + 8, index, true);
  });
  writeRecord(writer, XlsbRecordType.ExternSheet, externals.bytes);
  writeRecord(writer, XlsbRecordType.EndExternals);
  for (const definedName of definedNames) {
    try {
      writeDefinedName(writer, definedName, {
        sheetNames: sheets.map(sheet => sheet.name),
        externalSheets: sheets.map((_sheet, index) => ({
          externalLink: 0,
          firstSheet: index,
          lastSheet: index
        })),
        definedNames
      });
    } catch (error) {
      if (unsupported !== "ignore" || !(error instanceof ExcelNotSupportedError)) {
        throw error;
      }
    }
  }
  writeRecord(writer, XlsbRecordType.EndBook);
  return finishBinaryWriter(writer);
}

function parseCalculationProperties(result: XlsbWorkbookPart, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtCalcProp");
  reader.u32();
  const calculationMode = reader.u32();
  const iterateCount = reader.u32();
  const iterateDelta = reader.f64();
  reader.i32();
  // Early BIFF12 producers (including the Apache POI Simple.xlsb fixture)
  // serialized the nine flags in one byte because all then-defined bits fit;
  // current [MS-XLSB] specifies a 16-bit field. Accept both layouts and emit
  // only the current 26-byte form.
  const flags = reader.remaining === 1 ? reader.u8() : reader.u16();
  if (calculationMode > 2 || !Number.isFinite(iterateDelta) || iterateDelta < 0) {
    throw new XlsbParseError("BrtCalcProp", "invalid calculation properties");
  }
  if ((flags & ~0x01ff) !== 0 || reader.remaining !== 0) {
    throw new XlsbParseError("BrtCalcProp", "invalid calculation flags or trailing data");
  }
  result.calcProperties = {
    fullCalcOnLoad: (flags & 0x01) !== 0,
    iterate: (flags & 0x04) !== 0 ? true : undefined,
    iterateCount,
    iterateDelta
  };
  if (calculationMode !== 1) {
    result.unsupportedSettings.push(`calculation mode ${calculationMode}`);
  }
  if ((flags & 0x02) === 0) {
    result.unsupportedSettings.push("R1C1 calculation reference mode");
  }
  if ((flags & 0x08) === 0) {
    result.unsupportedSettings.push("precision as displayed");
  }
  if ((flags & 0x10) !== 0) {
    result.unsupportedSettings.push("partially calculated workbook state");
  }
  if ((flags & 0x20) === 0) {
    result.unsupportedSettings.push("recalculate-before-save disabled");
  }
  if ((flags & 0x40) === 0) {
    result.unsupportedSettings.push("multithreaded calculation disabled");
  }
  if ((flags & 0x80) !== 0) {
    result.unsupportedSettings.push("user-defined calculation thread count");
  }
  if ((flags & 0x100) !== 0) {
    result.unsupportedSettings.push("calculation dependency tracking disabled");
  }
}

function writeCalculationProperties(
  writer: ReturnType<typeof createBinaryWriter>,
  properties: Partial<CalculationProperties>,
  unsupported: "error" | "ignore"
): void {
  if (Object.keys(properties).length === 0) {
    return;
  }
  let iterateCount = properties.iterateCount ?? 100;
  let iterateDelta = properties.iterateDelta ?? 0.001;
  const validCount =
    Number.isInteger(iterateCount) && iterateCount >= 0 && iterateCount <= 0xffffffff;
  const validDelta = Number.isFinite(iterateDelta) && iterateDelta >= 0;
  if (!validCount || !validDelta) {
    if (unsupported !== "ignore") {
      throw new ExcelNotSupportedError(
        "Write XLSB calculation properties",
        "iterateCount must be an unsigned 32-bit integer and iterateDelta must be finite and non-negative"
      );
    }
    iterateCount = 100;
    iterateDelta = 0.001;
  }
  const payload = createPayload(26);
  payload.view.setUint32(0, 0x0001eb1d, true);
  payload.view.setUint32(4, 1, true);
  payload.view.setUint32(8, iterateCount, true);
  payload.view.setFloat64(12, iterateDelta, true);
  payload.view.setInt32(20, 1, true);
  payload.view.setUint16(
    24,
    0x006a | (properties.fullCalcOnLoad ? 0x01 : 0) | (properties.iterate ? 0x04 : 0),
    true
  );
  writeRecord(writer, XlsbRecordType.CalcProp, payload.bytes);
}

function parseLegacyWorkbookProtection(
  result: XlsbWorkbookPart,
  data: Uint8Array,
  followsIso: boolean
): number {
  const reader = new XlsbBinaryReader(data, "BrtBookProtection");
  const workbookPassword = reader.u16();
  const revisionsPassword = reader.u16();
  const flags = reader.u16();
  if (reader.remaining !== 0) {
    throw new XlsbParseError("BrtBookProtection", `${reader.remaining} trailing bytes`);
  }
  if (followsIso && (workbookPassword !== 0 || revisionsPassword !== 0)) {
    throw new XlsbParseError(
      "BrtBookProtection",
      "password verifiers following BrtBookProtectionIso must be zero"
    );
  }
  result.protection = {
    ...workbookProtectionFlags(flags),
    ...result.protection,
    ...(!followsIso && workbookPassword
      ? { workbookPassword: workbookPassword.toString(16).toUpperCase().padStart(4, "0") }
      : {}),
    ...(!followsIso && revisionsPassword
      ? { revisionsPassword: revisionsPassword.toString(16).toUpperCase().padStart(4, "0") }
      : {})
  };
  return flags;
}

function parseIsoWorkbookProtection(result: XlsbWorkbookPart, data: Uint8Array): number {
  const reader = new XlsbBinaryReader(data, "BrtBookProtectionIso");
  const spinCount = reader.u32();
  const revisionSpinCount = reader.u32();
  if (spinCount > 10_000_000 || revisionSpinCount > 10_000_000) {
    throw new XlsbParseError("BrtBookProtectionIso", "spin count exceeds 10000000");
  }
  const flags = reader.u16();
  const workbookPassword = parseIsoPasswordData(reader, "BrtBookProtectionIso workbook password");
  const revisionPassword = parseIsoPasswordData(reader, "BrtBookProtectionIso revision password");
  if (reader.remaining !== 0) {
    throw new XlsbParseError("BrtBookProtectionIso", `${reader.remaining} trailing bytes`);
  }
  if (revisionPassword.hashValue) {
    result.unsupportedSettings.push("ISO workbook revision password");
  }
  result.protection = {
    ...workbookProtectionFlags(flags),
    ...workbookPassword,
    ...(workbookPassword.hashValue ? { spinCount } : {})
  };
  return flags;
}

function workbookProtectionFlags(flags: number): WorkbookProtectionModel {
  return {
    ...(flags & 0x01 ? { lockStructure: true } : {}),
    ...(flags & 0x02 ? { lockWindows: true } : {}),
    ...(flags & 0x04 ? { lockRevision: true } : {})
  };
}

function writeWorkbookProtection(
  writer: ReturnType<typeof createBinaryWriter>,
  protection: WorkbookProtectionModel | undefined,
  unsupported: "error" | "ignore"
): void {
  if (!protection) {
    return;
  }
  const flags =
    (protection.lockStructure ? 0x01 : 0) |
    (protection.lockWindows ? 0x02 : 0) |
    (protection.lockRevision ? 0x04 : 0);
  const isoFields = [
    protection.algorithmName,
    protection.hashValue,
    protection.saltValue,
    protection.spinCount
  ];
  const hasAnyIsoField = isoFields.some(value => value !== undefined);
  const hasAllIsoFields = isoFields.every(value => value !== undefined);
  if (hasAnyIsoField && !hasAllIsoFields) {
    if (unsupported === "ignore") {
      writeRecord(
        writer,
        XlsbRecordType.BookProtection,
        legacyWorkbookProtectionPayload(protection, flags)
      );
      return;
    }
    throw new ExcelNotSupportedError(
      "Write XLSB workbook protection",
      "algorithmName, hashValue, saltValue and spinCount must be provided together"
    );
  }
  if (hasAllIsoFields) {
    if ((protection.workbookPassword || protection.revisionsPassword) && unsupported !== "ignore") {
      throw new ExcelNotSupportedError(
        "Write XLSB workbook protection",
        "legacy and ISO password verifiers cannot be written together"
      );
    }
    validateProtectionSpinCount(protection.spinCount!, "Write XLSB workbook protection");
    const bookPassword = encodeIsoPasswordData(protection, "Write XLSB workbook protection");
    const revisionPassword = encodeIsoPasswordData({}, "Write XLSB workbook protection");
    const iso = createPayload(10 + bookPassword.length + revisionPassword.length);
    iso.view.setUint32(0, protection.spinCount!, true);
    iso.view.setUint16(8, flags, true);
    iso.bytes.set(bookPassword, 10);
    iso.bytes.set(revisionPassword, 10 + bookPassword.length);
    writeRecord(writer, XlsbRecordType.BookProtectionIso, iso.bytes);
    const legacy = createPayload(6);
    legacy.view.setUint16(4, flags, true);
    writeRecord(writer, XlsbRecordType.BookProtection, legacy.bytes);
    return;
  }
  writeRecord(
    writer,
    XlsbRecordType.BookProtection,
    legacyWorkbookProtectionPayload(protection, flags)
  );
}

function legacyWorkbookProtectionPayload(
  protection: WorkbookProtectionModel,
  flags: number
): Uint8Array {
  const payload = createPayload(6);
  payload.view.setUint16(0, legacyPasswordVerifier(protection.workbookPassword), true);
  payload.view.setUint16(2, legacyPasswordVerifier(protection.revisionsPassword), true);
  payload.view.setUint16(4, flags, true);
  return payload.bytes;
}

function legacyPasswordVerifier(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  if (!/^[0-9A-F]{1,4}$/i.test(value)) {
    throw new ExcelNotSupportedError(
      "Write XLSB workbook protection",
      `legacy password verifier ${value} is not a hexadecimal 16-bit value`
    );
  }
  return Number.parseInt(value, 16);
}

function writeDefinedName(
  writer: ReturnType<typeof createBinaryWriter>,
  definedName: DefinedNameModel,
  context: XlsbFormulaContext
): void {
  if (definedName.kind === "opaque") {
    throw new ExcelNotSupportedError(
      `Write XLSB defined name ${definedName.name}`,
      "opaque defined-name expressions cannot be compiled to BIFF12"
    );
  }
  const expressions = definedName.formulaExpression
    ? [definedName.formulaExpression]
    : definedName.ranges;
  if (expressions.length === 0) {
    throw new ExcelNotSupportedError(
      `Write XLSB defined name ${definedName.name}`,
      "the defined name has no formula or range"
    );
  }
  const name = encodeWideString(definedName.name);
  const formula = compileDefinedNameFormula(
    expressions,
    {
      ...context,
      ...(definedName.localSheetId === undefined
        ? {}
        : { currentSheetIndex: definedName.localSheetId })
    },
    definedName.name
  );
  const payload = createPayload(9 + name.length + formula.length + 4);
  let flags = definedName.hidden ? 0x01 : 0;
  flags |= definedName.name.startsWith("_xlnm.") ? 0x20 : 0;
  payload.view.setUint32(0, flags, true);
  payload.view.setUint32(5, definedName.localSheetId ?? 0xffffffff, true);
  payload.bytes.set(name, 9);
  payload.bytes.set(formula, 9 + name.length);
  payload.view.setUint32(9 + name.length + formula.length, 0xffffffff, true);
  writeRecord(writer, XlsbRecordType.Name, payload.bytes);
}

function compileDefinedNameFormula(
  expressions: readonly string[],
  context: XlsbFormulaContext,
  name: string
): Uint8Array {
  const tokenGroups = expressions.map(expression => {
    const formula = compileCellFormula(expression, `defined name ${name}`, context);
    const tokenLength = new DataView(
      formula.buffer,
      formula.byteOffset,
      formula.byteLength
    ).getUint32(0, true);
    return formula.subarray(4, 4 + tokenLength);
  });
  const tokenLength =
    tokenGroups.reduce((length, tokens) => length + tokens.length, 0) +
    Math.max(0, tokenGroups.length - 1);
  const payload = createPayload(8 + tokenLength);
  payload.view.setUint32(0, tokenLength, true);
  let offset = 4;
  tokenGroups.forEach((tokens, index) => {
    payload.bytes.set(tokens, offset);
    offset += tokens.length;
    if (index > 0) {
      payload.bytes[offset++] = 0x10;
    }
  });
  return payload.bytes;
}

function fileVersionPayload(): Uint8Array {
  return new Uint8Array([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x78, 0, 0x6c, 0, 1, 0, 0, 0, 0x33, 0, 1,
    0, 0, 0, 0x35, 0, 4, 0, 0, 0, 0x39, 0, 0x33, 0, 0x30, 0, 0x32, 0, 0
  ]);
}

function parseBookView(data: Uint8Array): WorkbookView {
  const reader = new XlsbBinaryReader(data, "BrtBookView");
  const x = reader.i32();
  const y = reader.i32();
  const width = reader.u32();
  const height = reader.u32();
  reader.u32();
  const firstSheet = reader.u32();
  const activeTab = reader.u32();
  const flags = reader.u8();
  return {
    x,
    y,
    width,
    height,
    firstSheet,
    activeTab,
    visibility: flags & 0x02 ? "veryHidden" : flags & 0x01 ? "hidden" : "visible"
  };
}

function bookViewPayload(view?: WorkbookView): Uint8Array {
  const payload = createPayload(29);
  payload.view.setInt32(0, view?.x ?? 0, true);
  payload.view.setInt32(4, view?.y ?? 0, true);
  payload.view.setUint32(8, view?.width ?? 28_800, true);
  payload.view.setUint32(12, view?.height ?? 12_495, true);
  payload.view.setUint32(16, 600, true);
  payload.view.setUint32(20, view?.firstSheet ?? 0, true);
  payload.view.setUint32(24, view?.activeTab ?? 0, true);
  let flags = 0x78;
  if (view?.visibility === "hidden") {
    flags |= 0x01;
  }
  if (view?.visibility === "veryHidden") {
    flags |= 0x03;
  }
  payload.bytes[28] = flags;
  return payload.bytes;
}
