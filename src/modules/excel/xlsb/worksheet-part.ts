import type { CellData, CellModel } from "@excel/core/cell";
import {
  cellFormula,
  cellGetValue,
  cellResult,
  cellSetStyle,
  cellSetValue,
  cellText
} from "@excel/core/cell";
import { ErrorValue, ValueType } from "@excel/core/enums";
import type { WorksheetModel } from "@excel/core/worksheet";
import { mergeCellsWithoutStyle } from "@excel/core/worksheet";
import type { SheetProtection, WorksheetData } from "@excel/core/worksheet-core";
import { getCell, getColumn, getRow, getSheetName } from "@excel/core/worksheet-core";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type {
  CellErrorValue,
  CellRichTextValue,
  DataValidationOperator,
  DataValidationRule,
  IgnoredError,
  Style,
  WorksheetView
} from "@excel/types";
import { decodeRange } from "@excel/utils/address";
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
import {
  compileCellFormula,
  compileSharedFormula,
  formulaResultErrorCode,
  parseCellFormulaValue,
  parseNameFormula,
  parseStandaloneFormula
} from "@excel/xlsb/formula";
import type { XlsbFormulaContext, XlsbFormulaReference } from "@excel/xlsb/formula";
import {
  encodeIsoPasswordData,
  parseIsoPasswordData,
  validateProtectionSpinCount
} from "@excel/xlsb/protection";
import { XlsbRecordType } from "@excel/xlsb/record-types";
import {
  addSharedString,
  type XlsbSharedStrings,
  type XlsbSharedStringValue
} from "@excel/xlsb/shared-strings";
import { addStyle, type XlsbStyleRegistry, type XlsbStyleTable } from "@excel/xlsb/styles";
import { dateToExcel, excelToDate, isDateFmt } from "@utils/utils";

/** Controls worksheet limits and formula handling while reading XLSB. */
export interface XlsbWorksheetReadOptions {
  /** Maximum number of worksheet rows to load. Defaults to no limit. */
  maxRows?: number;
  /** Maximum number of worksheet columns to load. Defaults to no limit. */
  maxCols?: number;
  /** Preserve formulas, keep cached results, or reject formula cells. Defaults to `preserve`. */
  formulas?: "preserve" | "cached" | "error";
}

/** Controls how the writer handles workbook state that XLSB cannot preserve. */
export interface XlsbWorksheetWriteOptions {
  /** Reject unsupported state by default, or omit it with `ignore`. */
  unsupported?: "error" | "ignore";
}

export interface XlsbWorksheetRelationships {
  hyperlinkTargets?: ReadonlyMap<string, string>;
  addHyperlink?: (target: string) => string;
  legacyDrawingRelationId?: string;
  tableRelationIds?: readonly string[];
}

export interface XlsbWorksheetParseResult {
  cachedFormulaCount: number;
  legacyDrawingRelationId?: string;
  tableRelationIds: string[];
  unsupportedSettings: string[];
  unsupportedRecordTypes: number[];
}

export function parseWorksheetTableRelationIds(bytes: Uint8Array): string[] {
  const relationIds: string[] = [];
  for (const record of iterateBiffRecords(bytes, "XLSB worksheet table references")) {
    if (record.type !== XlsbRecordType.ListPart) {
      continue;
    }
    const reader = new XlsbBinaryReader(record.data, "BrtListPart");
    const relationId = reader.wideString();
    if (!relationId || reader.remaining !== 0) {
      throw new XlsbParseError("BrtListPart", "invalid table relationship id");
    }
    relationIds.push(relationId);
  }
  return relationIds;
}

type WorksheetPaneName = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

type XlsbWorksheetView = Partial<WorksheetView> & {
  workbookViewId?: number;
  xSplit?: number;
  ySplit?: number;
  topLeftCell?: string;
  activePane?: WorksheetPaneName;
};

interface ParsedFormulaGroup {
  type: "array" | "shared";
  masterAddress: string;
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}

interface PendingFormulaCell {
  cell: CellData;
  result: unknown;
  reference: XlsbFormulaReference;
}

interface ParsedCellResult {
  cachedFormula: boolean;
  pendingFormula?: PendingFormulaCell;
}

interface ArrayFormulaRange {
  masterAddress: string;
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}

export function parseWorksheetPart(
  worksheet: WorksheetData,
  bytes: Uint8Array,
  sharedStrings: readonly XlsbSharedStringValue[],
  styleTable: XlsbStyleTable,
  date1904: boolean,
  formulaContext: XlsbFormulaContext,
  options: XlsbWorksheetReadOptions = {},
  relationships: XlsbWorksheetRelationships = {}
): XlsbWorksheetParseResult {
  const autoFilterColumns = parseAutoFilterColumns(bytes);
  let currentRow = -1;
  let currentColumn = -1;
  let currentView = -1;
  let pageBreakAxis: "row" | "column" | undefined;
  let pendingIsoProtection: readonly number[] | undefined;
  let pendingFormula: PendingFormulaCell | undefined;
  let cachedFormulaCount = 0;
  let legacyDrawingRelationId: string | undefined;
  const tableRelationIds: string[] = [];
  const unsupportedSettings: string[] = [];
  if (autoFilterColumns.some(column => column.buttonInNextColumn)) {
    unsupportedSettings.push("AutoFilter button positioned in the next column");
  }
  const unsupportedRecordTypes = new Set<number>();
  const formulaGroups: ParsedFormulaGroup[] = [];
  for (const record of iterateBiffRecords(bytes, `worksheet ${getSheetName(worksheet)}`)) {
    if (pendingIsoProtection && record.type !== XlsbRecordType.SheetProtection) {
      throw new XlsbParseError(
        `worksheet ${getSheetName(worksheet)}`,
        "BrtSheetProtectionIso is not immediately followed by BrtSheetProtection"
      );
    }
    if (!isSupportedWorksheetRecord(record.type)) {
      unsupportedRecordTypes.add(record.type);
    }
    if (
      record.type === XlsbRecordType.ArrayFormula ||
      record.type === XlsbRecordType.SharedFormula
    ) {
      if ((options.formulas ?? "preserve") !== "preserve" || !pendingFormula) {
        pendingFormula = undefined;
        continue;
      }
      formulaGroups.push(
        parseFormulaGroup(record.type, record.data, pendingFormula, formulaContext)
      );
      pendingFormula = undefined;
      continue;
    }
    if (pendingFormula) {
      throw new XlsbParseError(
        `worksheet ${getSheetName(worksheet)}`,
        `PtgExp formula at ${pendingFormula.cell.address} is not followed by BrtArrFmla or BrtShrFmla`
      );
    }
    if (record.type === XlsbRecordType.RowHdr) {
      currentRow = parseRow(worksheet, record.data, styleTable, options.maxRows);
      currentColumn = -1;
      continue;
    }
    if (record.type === XlsbRecordType.ColInfo) {
      parseColumn(worksheet, record.data, styleTable, options.maxCols);
      continue;
    }
    if (record.type === XlsbRecordType.WsProp) {
      parseWorksheetProperties(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.WsFmtInfo) {
      parseWorksheetFormatInfo(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.BeginWsView) {
      worksheet.views.push(parseWorksheetView(record.data));
      currentView = worksheet.views.length - 1;
      continue;
    }
    if (record.type === XlsbRecordType.Pane && currentView >= 0) {
      worksheet.views[currentView] = parsePane(worksheet.views[currentView]!, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.Selection && currentView >= 0) {
      parseSelection(worksheet.views[currentView]!, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.EndWsView) {
      currentView = -1;
      continue;
    }
    if (record.type === XlsbRecordType.MergeCell) {
      parseMerge(worksheet, record.data, options);
      continue;
    }
    if (record.type === XlsbRecordType.BeginAutoFilter) {
      const ref = parseRange(record.data, "BrtBeginAFilter");
      worksheet.autoFilter = ref;
      worksheet._autoFilterCriteria = autoFilterCriteriaFromColumns(ref, autoFilterColumns);
      continue;
    }
    if (record.type === XlsbRecordType.Margins) {
      parseMargins(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.PrintOptions) {
      parsePrintOptions(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.PageSetup) {
      parsePageSetup(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.BeginHeaderFooter) {
      parseHeaderFooter(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.Hyperlink) {
      parseHyperlink(worksheet, record.data, relationships.hyperlinkTargets);
      continue;
    }
    if (record.type === XlsbRecordType.LegacyDrawing) {
      const reader = new XlsbBinaryReader(record.data, "BrtLegacyDrawing");
      legacyDrawingRelationId = reader.wideString();
      if (!legacyDrawingRelationId || reader.remaining !== 0) {
        throw new XlsbParseError("BrtLegacyDrawing", "invalid VML relationship id");
      }
      continue;
    }
    if (record.type === XlsbRecordType.ListPart) {
      const reader = new XlsbBinaryReader(record.data, "BrtListPart");
      const relationId = reader.wideString();
      if (!relationId || reader.remaining !== 0) {
        throw new XlsbParseError("BrtListPart", "invalid table relationship id");
      }
      tableRelationIds.push(relationId);
      continue;
    }
    if (record.type === XlsbRecordType.BeginRowBreaks) {
      pageBreakAxis = "row";
      continue;
    }
    if (record.type === XlsbRecordType.BeginColumnBreaks) {
      pageBreakAxis = "column";
      continue;
    }
    if (
      record.type === XlsbRecordType.EndRowBreaks ||
      record.type === XlsbRecordType.EndColumnBreaks
    ) {
      pageBreakAxis = undefined;
      continue;
    }
    if (record.type === XlsbRecordType.PageBreak && pageBreakAxis) {
      parsePageBreak(worksheet, record.data, pageBreakAxis);
      continue;
    }
    if (record.type === XlsbRecordType.IgnoredError) {
      parseIgnoredError(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.DataValidation) {
      parseDataValidation(worksheet, record.data, date1904, formulaContext, unsupportedSettings);
      continue;
    }
    if (record.type === XlsbRecordType.SheetProtectionIso) {
      pendingIsoProtection = parseIsoSheetProtection(worksheet, record.data);
      continue;
    }
    if (record.type === XlsbRecordType.SheetProtection) {
      const legacy = parseLegacySheetProtection(worksheet, record.data);
      if (pendingIsoProtection && !sameProtectionValues(pendingIsoProtection, legacy.values)) {
        throw new XlsbParseError(
          `worksheet ${getSheetName(worksheet)}`,
          "BrtSheetProtection does not match the preceding BrtSheetProtectionIso"
        );
      }
      if (!pendingIsoProtection && legacy.passwordVerifier !== 0) {
        unsupportedSettings.push("legacy sheet-protection password verifier");
      }
      pendingIsoProtection = undefined;
      continue;
    }
    if (!isCellRecord(record.type) || currentRow < 0) {
      continue;
    }
    if (options.maxRows !== undefined && currentRow >= options.maxRows) {
      continue;
    }
    const normalized = normalizeCellRecord(record.type, record.data, currentColumn);
    currentColumn = normalized.column;
    const parsedCell = parseCell(
      worksheet,
      currentRow,
      normalized.type,
      normalized.data,
      sharedStrings,
      styleTable,
      date1904,
      formulaContext,
      options,
      formulaGroups
    );
    pendingFormula = parsedCell.pendingFormula;
    if (parsedCell.cachedFormula) {
      cachedFormulaCount++;
    }
  }
  if (pendingFormula) {
    throw new XlsbParseError(
      `worksheet ${getSheetName(worksheet)}`,
      `unterminated PtgExp formula at ${pendingFormula.cell.address}`
    );
  }
  return {
    cachedFormulaCount,
    legacyDrawingRelationId,
    tableRelationIds,
    unsupportedSettings,
    unsupportedRecordTypes: [...unsupportedRecordTypes].sort((left, right) => left - right)
  };
}

function parseLegacySheetProtection(
  worksheet: WorksheetData,
  data: Uint8Array
): { passwordVerifier: number; values: number[] } {
  const reader = new XlsbBinaryReader(data, "BrtSheetProtection");
  const passwordVerifier = reader.u16();
  const values = readProtectionValues(reader);
  applySheetProtectionValues(worksheet, values);
  return { passwordVerifier, values };
}

function parseIsoSheetProtection(worksheet: WorksheetData, data: Uint8Array): number[] {
  const reader = new XlsbBinaryReader(data, "BrtSheetProtectionIso");
  const spinCount = reader.u32();
  if (spinCount > 10_000_000) {
    throw new XlsbParseError("BrtSheetProtectionIso", `invalid spin count ${spinCount}`);
  }
  const values = readProtectionValues(reader);
  const password = parseIsoPasswordData(reader, "BrtSheetProtectionIso");
  if (!password.hashValue || reader.remaining !== 0) {
    throw new XlsbParseError(
      "BrtSheetProtectionIso",
      "sheet protection requires a password hash and no trailing data"
    );
  }
  applySheetProtectionValues(worksheet, values);
  worksheet.sheetProtection = {
    ...worksheet.sheetProtection,
    ...password,
    spinCount
  };
  return values;
}

function readProtectionValues(reader: XlsbBinaryReader): number[] {
  const values: number[] = [];
  for (let index = 0; index < 16; index++) {
    const value = reader.u32();
    if (value > 1) {
      throw new XlsbParseError("sheet protection", `invalid Boolean value ${value}`);
    }
    values.push(value);
  }
  return values;
}

function applySheetProtectionValues(worksheet: WorksheetData, values: readonly number[]): void {
  const [
    sheet,
    objects,
    scenarios,
    formatCells,
    formatColumns,
    formatRows,
    insertColumns,
    insertRows,
    insertHyperlinks,
    deleteColumns,
    deleteRows,
    selectLockedCells,
    sort,
    autoFilter,
    pivotTables,
    selectUnlockedCells
  ] = values;
  const protection: SheetProtection = {
    sheet: sheet === 1 ? true : undefined,
    objects: objects === 0 ? false : undefined,
    scenarios: scenarios === 0 ? false : undefined,
    formatCells: formatCells === 1 ? true : undefined,
    formatColumns: formatColumns === 1 ? true : undefined,
    formatRows: formatRows === 1 ? true : undefined,
    insertColumns: insertColumns === 1 ? true : undefined,
    insertRows: insertRows === 1 ? true : undefined,
    insertHyperlinks: insertHyperlinks === 1 ? true : undefined,
    deleteColumns: deleteColumns === 1 ? true : undefined,
    deleteRows: deleteRows === 1 ? true : undefined,
    selectLockedCells: selectLockedCells === 0 ? false : undefined,
    sort: sort === 1 ? true : undefined,
    autoFilter: autoFilter === 1 ? true : undefined,
    pivotTables: pivotTables === 1 ? true : undefined,
    selectUnlockedCells: selectUnlockedCells === 0 ? false : undefined
  };
  worksheet.sheetProtection = {
    ...protection,
    ...worksheet.sheetProtection
  };
}

function sameProtectionValues(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseWorksheetProperties(worksheet: WorksheetData, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtWsProp");
  const flags = reader.u24();
  const color = parseWorksheetColor(reader.slice(8));
  if (color) {
    worksheet.properties.tabColor = color;
  }
  worksheet.properties.outlineProperties = {
    summaryBelow: (flags & 0x40) !== 0,
    summaryRight: (flags & 0x80) !== 0
  };
  worksheet.pageSetup.fitToPage = (flags & 0x100) !== 0;
}

function parseWorksheetFormatInfo(worksheet: WorksheetData, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtWsFmtInfo");
  const defaultColumnWidth = reader.u32();
  const fallbackColumnWidth = reader.u16();
  const defaultRowHeight = reader.u16();
  const flags = reader.u16();
  worksheet.properties.outlineLevelRow = reader.u8();
  worksheet.properties.outlineLevelCol = reader.u8();
  worksheet.properties.defaultColWidth =
    defaultColumnWidth === 0xffffffff ? fallbackColumnWidth : defaultColumnWidth / 256;
  if (flags & 0x01) {
    worksheet.properties.defaultRowHeight = defaultRowHeight / 20;
  }
}

function parseMargins(worksheet: WorksheetData, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtMargins");
  worksheet.pageSetup.margins = {
    left: reader.f64(),
    right: reader.f64(),
    top: reader.f64(),
    bottom: reader.f64(),
    header: reader.f64(),
    footer: reader.f64()
  };
}

function parsePrintOptions(worksheet: WorksheetData, data: Uint8Array): void {
  const flags = new XlsbBinaryReader(data, "BrtPrintOptions").u16();
  worksheet.pageSetup.horizontalCentered = (flags & 0x01) !== 0;
  worksheet.pageSetup.verticalCentered = (flags & 0x02) !== 0;
  worksheet.pageSetup.showRowColHeaders = (flags & 0x04) !== 0;
  worksheet.pageSetup.showGridLines = (flags & 0x08) !== 0;
}

function parsePageSetup(worksheet: WorksheetData, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtPageSetup");
  const paperSize = reader.u32();
  worksheet.pageSetup.paperSize = paperSize || undefined;
  worksheet.pageSetup.scale = reader.u32();
  const horizontalDpi = reader.u32();
  const verticalDpi = reader.u32();
  worksheet.pageSetup.horizontalDpi = horizontalDpi || undefined;
  worksheet.pageSetup.verticalDpi = verticalDpi || undefined;
  worksheet.pageSetup.copies = reader.u32();
  const firstPageNumber = reader.i32();
  worksheet.pageSetup.fitToWidth = reader.u32();
  worksheet.pageSetup.fitToHeight = reader.u32();
  const flags = reader.u16();
  worksheet.pageSetup.pageOrder = flags & 0x01 ? "overThenDown" : "downThenOver";
  worksheet.pageSetup.orientation = flags & 0x02 ? "landscape" : "portrait";
  worksheet.pageSetup.blackAndWhite = (flags & 0x08) !== 0;
  worksheet.pageSetup.draft = (flags & 0x10) !== 0;
  worksheet.pageSetup.cellComments =
    flags & 0x20 ? (flags & 0x100 ? "atEnd" : "asDisplyed") : "None";
  worksheet.pageSetup.useFirstPageNumber = (flags & 0x80) !== 0;
  worksheet.pageSetup.usePrinterDefaults = (flags & 0x40) !== 0;
  worksheet.pageSetup.firstPageNumber = flags & 0x80 ? firstPageNumber : undefined;
  worksheet.pageSetup.errors = ["displayed", "blank", "dash", "NA"][(flags >>> 9) & 0x03]!;
}

function parseHeaderFooter(worksheet: WorksheetData, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtBeginHeaderFooter");
  const flags = reader.u16();
  worksheet.headerFooter = {
    differentOddEven: (flags & 0x01) !== 0,
    differentFirst: (flags & 0x02) !== 0,
    scaleWithDoc: (flags & 0x04) !== 0,
    alignWithMargins: (flags & 0x08) !== 0,
    oddHeader: nullableText(reader.wideString()),
    oddFooter: nullableText(reader.wideString()),
    evenHeader: nullableText(reader.wideString()),
    evenFooter: nullableText(reader.wideString()),
    firstHeader: nullableText(reader.wideString()),
    firstFooter: nullableText(reader.wideString())
  };
}

function parseHyperlink(
  worksheet: WorksheetData,
  data: Uint8Array,
  hyperlinkTargets: ReadonlyMap<string, string> | undefined
): void {
  const reader = new XlsbBinaryReader(data, "BrtHLink");
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstColumn = reader.u32();
  const lastColumn = reader.u32();
  const relationId = reader.wideString();
  const location = reader.wideString();
  const tooltip = reader.wideString();
  const display = reader.wideString();
  const target = relationId ? hyperlinkTargets?.get(relationId) : "";
  if (relationId && !target) {
    throw new XlsbParseError("BrtHLink", `missing hyperlink relationship ${relationId}`);
  }
  const hyperlink = target
    ? `${target}${location ? `#${location}` : ""}`
    : location
      ? `#${location}`
      : "";
  if (!hyperlink) {
    return;
  }
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const cell = getCell(worksheet, row + 1, column + 1);
      const formula = cellFormula(cell);
      if (formula) {
        cellSetValue(cell, {
          formula,
          result: cellResult(cell),
          hyperlink,
          ...(tooltip ? { tooltip } : {})
        });
      } else {
        const currentValue = cellGetValue(cell);
        const richText = isRichTextValue(currentValue) ? currentValue.richText : undefined;
        cellSetValue(cell, {
          text: cellText(cell) || display,
          hyperlink,
          ...(richText ? { richText } : {}),
          ...(tooltip ? { tooltip } : {})
        });
      }
    }
  }
}

function parsePageBreak(worksheet: WorksheetData, data: Uint8Array, axis: "row" | "column"): void {
  const reader = new XlsbBinaryReader(data, "BrtBrk");
  const pageBreak = {
    id: reader.u32() + 1,
    min: reader.u32(),
    max: reader.u32(),
    man: reader.u32()
  };
  reader.u32();
  if (pageBreak.min === 0) {
    delete (pageBreak as { min?: number }).min;
  }
  if (axis === "row") {
    worksheet.rowBreaks.push(pageBreak);
  } else {
    worksheet.colBreaks.push(pageBreak);
  }
}

function parseIgnoredError(worksheet: WorksheetData, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtCellIgnoreEC");
  const flags = reader.u32();
  const count = reader.u32();
  const ranges: string[] = [];
  for (let index = 0; index < count; index++) {
    const firstRow = reader.u32();
    const lastRow = reader.u32();
    const firstColumn = reader.u32();
    const lastColumn = reader.u32();
    const first = colCache.encodeAddress(firstRow + 1, firstColumn + 1);
    const last = colCache.encodeAddress(lastRow + 1, lastColumn + 1);
    ranges.push(first === last ? first : `${first}:${last}`);
  }
  const ignoredError: IgnoredError = { ref: ranges.join(" ") };
  if (flags & 0x001) {
    ignoredError.evalError = true;
  }
  if (flags & 0x002) {
    ignoredError.emptyCellReference = true;
  }
  if (flags & 0x004) {
    ignoredError.numberStoredAsText = true;
  }
  if (flags & 0x008) {
    ignoredError.formulaRange = true;
  }
  if (flags & 0x010) {
    ignoredError.formula = true;
  }
  if (flags & 0x020) {
    ignoredError.twoDigitTextYear = true;
  }
  if (flags & 0x040) {
    ignoredError.unlockedFormula = true;
  }
  if (flags & 0x080) {
    ignoredError.listDataValidation = true;
  }
  if (flags & 0x100) {
    ignoredError.calculatedColumn = true;
  }
  worksheet.ignoredErrors.push(ignoredError);
}

function parseDataValidation(
  worksheet: WorksheetData,
  data: Uint8Array,
  date1904: boolean,
  context: XlsbFormulaContext,
  unsupportedSettings: string[]
): void {
  const reader = new XlsbBinaryReader(data, "BrtDVal");
  const flags = reader.u32();
  const typeCode = flags & 0x0f;
  const rangeCount = reader.u32();
  const ranges: string[] = [];
  for (let index = 0; index < rangeCount; index++) {
    const firstRow = reader.u32();
    const lastRow = reader.u32();
    const firstColumn = reader.u32();
    const lastColumn = reader.u32();
    ranges.push(
      `${colCache.encodeAddress(firstRow + 1, firstColumn + 1)}:${colCache.encodeAddress(lastRow + 1, lastColumn + 1)}`
    );
  }
  const errorTitle = nullableText(reader.wideString());
  const error = nullableText(reader.wideString());
  const promptTitle = nullableText(reader.wideString());
  const prompt = nullableText(reader.wideString());
  let firstFormula: string | undefined;
  let secondFormula: string | undefined;
  try {
    firstFormula = parseNameFormula(reader, "data validation formula1", context);
    secondFormula = parseNameFormula(reader, "data validation formula2", context);
  } catch (error) {
    if (!(error instanceof ExcelNotSupportedError)) {
      throw error;
    }
    unsupportedSettings.push(`data validation on ${ranges.join(" ")} formula tokens`);
    return;
  }
  const type = ["any", "whole", "decimal", "list", "date", "time", "textLength", "custom"][
    typeCode
  ] as DataValidationRule["type"] | "time" | undefined;
  if (!type || type === "time") {
    unsupportedSettings.push(`data validation on ${ranges.join(" ")} type ${type ?? typeCode}`);
    return;
  }
  if ((flags & 0x3fe00) !== 0) {
    unsupportedSettings.push(`data validation on ${ranges.join(" ")} dropdown or IME settings`);
  }
  const formulae = [firstFormula, secondFormula]
    .filter((formula): formula is string => formula !== undefined)
    .map(formula =>
      type === "any" ? formula : parseDataValidationFormula(formula, type, date1904)
    );
  const rule: DataValidationRule = {
    type,
    ...(type === "any" ? {} : { formulae }),
    ...(!["any", "list", "custom"].includes(type)
      ? { operator: dataValidationOperator((flags >>> 20) & 0x0f) }
      : {}),
    ...((flags & 0x100) !== 0 ? { allowBlank: true } : {}),
    ...((flags & 0x40000) !== 0 ? { showInputMessage: true } : {}),
    ...((flags & 0x80000) !== 0 ? { showErrorMessage: true } : {}),
    ...(errorTitle ? { errorTitle } : {}),
    ...(error ? { error } : {}),
    ...(promptTitle ? { promptTitle } : {}),
    ...(prompt ? { prompt } : {}),
    ...(((flags >>> 4) & 0x07) !== 0
      ? { errorStyle: ["stop", "warning", "information"][(flags >>> 4) & 0x07] }
      : {})
  } as DataValidationRule;
  for (const range of ranges) {
    worksheet.dataValidations.model[range.includes(":") ? `range:${range}` : range] = rule;
  }
}

function parseDataValidationFormula(
  formula: string,
  type: Exclude<DataValidationRule["type"], "any">,
  date1904: boolean
): string | number | Date {
  if (type === "whole" || type === "textLength") {
    const value = Number(formula);
    return Number.isInteger(value) ? value : formula;
  }
  if (type === "decimal") {
    const value = Number(formula);
    return Number.isFinite(value) ? value : formula;
  }
  if (type === "date") {
    const value = Number(formula);
    return Number.isFinite(value) ? excelToDate(value, date1904) : formula;
  }
  return formula;
}

function dataValidationOperator(code: number): DataValidationOperator {
  return [
    "between",
    "notBetween",
    "equal",
    "notEqual",
    "greaterThan",
    "lessThan",
    "greaterThanOrEqual",
    "lessThanOrEqual"
  ][code] as DataValidationOperator;
}

function nullableText(value: string): string | null {
  return value === "" ? null : value;
}

function parseWorksheetView(data: Uint8Array): Partial<WorksheetView> {
  const reader = new XlsbBinaryReader(data, "BrtBeginWsView");
  const flags = reader.u16();
  const style = reader.u32();
  reader.u32();
  reader.u32();
  reader.skip(4);
  const zoomScale = reader.u16();
  const zoomScaleNormal = reader.u16();
  reader.skip(4);
  const workbookViewId = reader.u32();
  return {
    workbookViewId,
    state: "normal",
    ...(style === 1
      ? { style: "pageBreakPreview" as const }
      : style === 2
        ? { style: "pageLayout" as const }
        : {}),
    rightToLeft: (flags & 0x20) !== 0,
    tabSelected: (flags & 0x40) !== 0,
    showRuler: (flags & 0x80) !== 0,
    showGridLines: (flags & 0x04) !== 0,
    showRowColHeaders: (flags & 0x08) !== 0,
    zoomScale,
    zoomScaleNormal: zoomScaleNormal || 100
  };
}

function parsePane(view: XlsbWorksheetView, data: Uint8Array): Partial<WorksheetView> {
  const reader = new XlsbBinaryReader(data, "BrtPane");
  const xSplit = reader.f64();
  const ySplit = reader.f64();
  const topRow = reader.u32();
  const leftColumn = reader.u32();
  const activePane = paneName(reader.u32());
  const flags = reader.u8();
  return {
    ...view,
    state: flags & 0x03 ? "frozen" : "split",
    xSplit,
    ySplit,
    topLeftCell: colCache.encodeAddress(topRow + 1, leftColumn + 1),
    ...(flags & 0x03 ? {} : { activePane })
  } as Partial<WorksheetView>;
}

function parseSelection(view: XlsbWorksheetView, data: Uint8Array): void {
  const reader = new XlsbBinaryReader(data, "BrtSel");
  const pane = paneName(reader.u32());
  const row = reader.u32();
  const column = reader.u32();
  if (pane === viewPane(view)) {
    view.activeCell ??= colCache.encodeAddress(row + 1, column + 1);
  }
}

function parseRow(
  worksheet: WorksheetData,
  data: Uint8Array,
  styles: XlsbStyleTable,
  maxRows: number | undefined
): number {
  const reader = new XlsbBinaryReader(data, "BrtRowHdr");
  const rowIndex = reader.u32();
  const styleIndex = reader.u32();
  const heightTwips = reader.u16();
  reader.u8();
  const flags = reader.u8();
  reader.u8();
  if (maxRows !== undefined && rowIndex >= maxRows) {
    return rowIndex;
  }

  const row = getRow(worksheet, rowIndex + 1);
  row.outlineLevel = flags & 0x07;
  row.hidden = (flags & 0x10) !== 0;
  row.customHeight = (flags & 0x20) !== 0;
  if (row.customHeight) {
    row.height = heightTwips / 20;
  }
  if ((flags & 0x40) !== 0 && styles.styles[styleIndex]) {
    row.style = { ...styles.styles[styleIndex] };
  }
  return rowIndex;
}

function parseColumn(
  worksheet: WorksheetData,
  data: Uint8Array,
  styles: XlsbStyleTable,
  maxCols: number | undefined
): void {
  const reader = new XlsbBinaryReader(data, "BrtColInfo");
  const first = reader.u32();
  const last = reader.u32();
  const width = reader.u32() / 256;
  const styleIndex = reader.u32();
  const flags = reader.u16();
  const limit = maxCols === undefined ? last : Math.min(last, maxCols - 1);
  for (let index = first; index <= limit; index++) {
    const column = getColumn(worksheet, index + 1);
    column.width = width;
    column.hidden = (flags & 1) !== 0;
    column.bestFit = (flags & 4) !== 0;
    column.outlineLevel = (flags >>> 8) & 0x07;
    if (styles.styles[styleIndex]) {
      column.style = { ...styles.styles[styleIndex] };
    }
  }
}

function parseMerge(
  worksheet: WorksheetData,
  data: Uint8Array,
  options: XlsbWorksheetReadOptions
): void {
  const reader = new XlsbBinaryReader(data, "BrtMergeCell");
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstCol = reader.u32();
  const lastCol = reader.u32();
  if (
    (options.maxRows !== undefined && firstRow >= options.maxRows) ||
    (options.maxCols !== undefined && firstCol >= options.maxCols)
  ) {
    return;
  }
  const clippedLastRow =
    options.maxRows === undefined ? lastRow : Math.min(lastRow, options.maxRows - 1);
  const clippedLastCol =
    options.maxCols === undefined ? lastCol : Math.min(lastCol, options.maxCols - 1);
  mergeCellsWithoutStyle(
    worksheet,
    colCache.encode(firstRow + 1, firstCol + 1, clippedLastRow + 1, clippedLastCol + 1)
  );
}

function parseCell(
  worksheet: WorksheetData,
  rowIndex: number,
  recordType: number,
  data: Uint8Array,
  sharedStrings: readonly XlsbSharedStringValue[],
  styleTable: XlsbStyleTable,
  date1904: boolean,
  formulaContext: XlsbFormulaContext,
  options: XlsbWorksheetReadOptions,
  formulaGroups: readonly ParsedFormulaGroup[]
): ParsedCellResult {
  const reader = new XlsbBinaryReader(data, `cell record ${recordType}`);
  const columnIndex = reader.u32();
  const styleIndex = reader.u24();
  reader.u8();
  if (options.maxCols !== undefined && columnIndex >= options.maxCols) {
    return { cachedFormula: false };
  }

  const style = styleTable.styles[styleIndex] ?? {};
  const cell = getCell(worksheet, rowIndex + 1, columnIndex + 1);
  if (Object.keys(style).length > 0) {
    cellSetStyle(cell, style);
  }

  let value: unknown = null;
  switch (recordType) {
    case XlsbRecordType.CellBlank:
      return { cachedFormula: false };
    case XlsbRecordType.CellRk:
      value = decodeRk(reader.u32());
      break;
    case XlsbRecordType.CellError:
      value = decodeError(reader.u8());
      break;
    case XlsbRecordType.CellBool:
      value = reader.u8() !== 0;
      break;
    case XlsbRecordType.CellReal:
      value = reader.f64();
      break;
    case XlsbRecordType.CellSt:
      value = reader.wideString();
      break;
    case XlsbRecordType.CellIsst: {
      const index = reader.u32();
      if (index >= sharedStrings.length) {
        throw new XlsbParseError(
          `worksheet ${getSheetName(worksheet)}`,
          `shared-string index ${index} is outside the table of ${sharedStrings.length} strings`
        );
      }
      value = sharedStrings[index]!;
      break;
    }
    case XlsbRecordType.FmlaString:
    case XlsbRecordType.FmlaNum:
    case XlsbRecordType.FmlaBool:
    case XlsbRecordType.FmlaError: {
      const formulaMode = options.formulas ?? "preserve";
      if (formulaMode === "error") {
        throw new ExcelNotSupportedError(
          "Read XLSB formula",
          'BIFF12 stores formulas as token arrays; use formulas: "preserve" or formulas: "cached"'
        );
      }
      value = readFormulaResult(recordType, reader);
      if (
        typeof value === "number" &&
        typeof style.numFmt === "string" &&
        isDateFmt(style.numFmt)
      ) {
        value = excelToDate(value, date1904);
      }
      if (formulaMode === "preserve") {
        try {
          const parsed = parseCellFormulaValue(reader, cell.address, formulaContext);
          if (typeof parsed === "string") {
            cellSetValue(cell, { formula: parsed, result: value as never });
            return { cachedFormula: false };
          }
          const referencedMaster = colCache.encodeAddress(parsed.row + 1, parsed.column + 1);
          const group = formulaGroups.find(
            candidate =>
              candidate.masterAddress === referencedMaster &&
              formulaGroupContains(candidate, rowIndex, columnIndex)
          );
          if (group?.type === "shared") {
            cellSetValue(cell, { sharedFormula: group.masterAddress, result: value as never });
            return { cachedFormula: false };
          }
          cellSetValue(cell, value as never);
          if (group?.type === "array") {
            return { cachedFormula: false };
          }
          if (parsed.row !== rowIndex || parsed.column !== columnIndex) {
            throw new XlsbParseError(
              `formula at ${cell.address}`,
              `PtgExp references unknown formula master ${referencedMaster}`
            );
          }
          return {
            cachedFormula: false,
            pendingFormula: { cell, result: value, reference: parsed }
          };
        } catch (error) {
          if (!(error instanceof ExcelNotSupportedError)) {
            throw error;
          }
        }
      }
      cellSetValue(cell, value as never);
      return { cachedFormula: true };
    }
  }

  if (typeof value === "number" && typeof style.numFmt === "string" && isDateFmt(style.numFmt)) {
    value = excelToDate(value, date1904);
  }
  cellSetValue(cell, value as never);
  return {
    cachedFormula: recordType >= XlsbRecordType.FmlaString && recordType <= XlsbRecordType.FmlaError
  };
}

function parseFormulaGroup(
  type: number,
  data: Uint8Array,
  pending: PendingFormulaCell,
  context: XlsbFormulaContext
): ParsedFormulaGroup {
  const label = type === XlsbRecordType.ArrayFormula ? "BrtArrFmla" : "BrtShrFmla";
  const reader = new XlsbBinaryReader(data, label);
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstColumn = reader.u32();
  const lastColumn = reader.u32();
  if (
    firstRow > lastRow ||
    firstColumn > lastColumn ||
    lastRow >= 1_048_576 ||
    lastColumn >= 16_384
  ) {
    throw new XlsbParseError(label, "invalid formula range");
  }
  if (pending.reference.row !== firstRow || pending.reference.column !== firstColumn) {
    throw new XlsbParseError(label, "preceding PtgExp does not identify the range's first cell");
  }
  if (type === XlsbRecordType.ArrayFormula) {
    reader.u8();
  }
  const formula = parseStandaloneFormula(reader, pending.cell.address, context);
  if (reader.remaining !== 0) {
    throw new XlsbParseError(label, "unexpected trailing formula data");
  }
  const ref = colCache.encode(firstRow + 1, firstColumn + 1, lastRow + 1, lastColumn + 1);
  cellSetValue(pending.cell, {
    formula,
    result: pending.result,
    shareType: type === XlsbRecordType.ArrayFormula ? "array" : "shared",
    ref
  } as never);
  return {
    type: type === XlsbRecordType.ArrayFormula ? "array" : "shared",
    masterAddress: pending.cell.address,
    firstRow,
    lastRow,
    firstColumn,
    lastColumn
  };
}

function formulaGroupContains(
  group: Pick<ParsedFormulaGroup, "firstRow" | "lastRow" | "firstColumn" | "lastColumn">,
  row: number,
  column: number
): boolean {
  return (
    row >= group.firstRow &&
    row <= group.lastRow &&
    column >= group.firstColumn &&
    column <= group.lastColumn
  );
}

function readFormulaResult(type: number, reader: XlsbBinaryReader): unknown {
  switch (type) {
    case XlsbRecordType.FmlaString:
      return reader.wideString();
    case XlsbRecordType.FmlaNum:
      return reader.f64();
    case XlsbRecordType.FmlaBool:
      return reader.u8() !== 0;
    default:
      return decodeError(reader.u8());
  }
}

function isCellRecord(type: number): boolean {
  return type >= XlsbRecordType.CellBlank && type <= XlsbRecordType.ShortIsst;
}

function isSupportedWorksheetRecord(type: number): boolean {
  return (
    isCellRecord(type) ||
    type === XlsbRecordType.RowHdr ||
    type === XlsbRecordType.BeginSheet ||
    type === XlsbRecordType.EndSheet ||
    type === XlsbRecordType.FutureRecordBegin ||
    type === XlsbRecordType.FutureRecordEnd ||
    type === XlsbRecordType.AlternateContentBegin ||
    type === XlsbRecordType.AlternateContentEnd ||
    type === XlsbRecordType.BeginWsViews ||
    type === XlsbRecordType.EndWsViews ||
    type === XlsbRecordType.BeginWsView ||
    type === XlsbRecordType.EndWsView ||
    type === XlsbRecordType.BeginSheetData ||
    type === XlsbRecordType.EndSheetData ||
    type === XlsbRecordType.WsProp ||
    type === XlsbRecordType.WsDim ||
    type === XlsbRecordType.Pane ||
    type === XlsbRecordType.Selection ||
    type === XlsbRecordType.BeginColInfos ||
    type === XlsbRecordType.ColInfo ||
    type === XlsbRecordType.EndColInfos ||
    type === XlsbRecordType.BeginMergeCells ||
    type === XlsbRecordType.MergeCell ||
    type === XlsbRecordType.EndMergeCells ||
    type === XlsbRecordType.WsFmtInfo ||
    type === XlsbRecordType.BeginAutoFilter ||
    type === XlsbRecordType.EndAutoFilter ||
    type === XlsbRecordType.BeginFilterColumn ||
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
    type === XlsbRecordType.Margins ||
    type === XlsbRecordType.PrintOptions ||
    type === XlsbRecordType.PageSetup ||
    type === XlsbRecordType.BeginHeaderFooter ||
    type === XlsbRecordType.EndHeaderFooter ||
    type === XlsbRecordType.Hyperlink ||
    type === XlsbRecordType.LegacyDrawing ||
    type === XlsbRecordType.BeginRowBreaks ||
    type === XlsbRecordType.EndRowBreaks ||
    type === XlsbRecordType.BeginColumnBreaks ||
    type === XlsbRecordType.EndColumnBreaks ||
    type === XlsbRecordType.PageBreak ||
    type === XlsbRecordType.BeginIgnoredErrors ||
    type === XlsbRecordType.IgnoredError ||
    type === XlsbRecordType.EndIgnoredErrors ||
    type === XlsbRecordType.SheetProtection ||
    type === XlsbRecordType.SheetProtectionIso ||
    type === XlsbRecordType.BeginDataValidations ||
    type === XlsbRecordType.DataValidation ||
    type === XlsbRecordType.EndDataValidations ||
    type === XlsbRecordType.ArrayFormula ||
    type === XlsbRecordType.SharedFormula ||
    type === XlsbRecordType.BeginListParts ||
    type === XlsbRecordType.ListPart ||
    type === XlsbRecordType.EndListParts
  );
}

function normalizeCellRecord(
  type: number,
  data: Uint8Array,
  previousColumn: number
): { type: number; data: Uint8Array; column: number } {
  if (type <= XlsbRecordType.FmlaError) {
    if (data.length < 4) {
      throw new XlsbParseError("worksheet cell", "long cell record is missing its column index");
    }
    return {
      type,
      data,
      column: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
    };
  }
  const longTypes: Record<number, number> = {
    [XlsbRecordType.ShortBlank]: XlsbRecordType.CellBlank,
    [XlsbRecordType.ShortRk]: XlsbRecordType.CellRk,
    [XlsbRecordType.ShortError]: XlsbRecordType.CellError,
    [XlsbRecordType.ShortBool]: XlsbRecordType.CellBool,
    [XlsbRecordType.ShortReal]: XlsbRecordType.CellReal,
    [XlsbRecordType.ShortSt]: XlsbRecordType.CellSt,
    [XlsbRecordType.ShortIsst]: XlsbRecordType.CellIsst
  };
  const column = previousColumn + 1;
  const expanded = new Uint8Array(data.length + 4);
  new DataView(expanded.buffer).setUint32(0, column, true);
  expanded.set(data, 4);
  return { type: longTypes[type]!, data: expanded, column };
}

function decodeRk(encoded: number): number {
  const dividedByHundred = (encoded & 1) !== 0;
  const integer = (encoded & 2) !== 0;
  let value: number;
  if (integer) {
    value = encoded >> 2;
  } else {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(4, encoded & 0xfffffffc, true);
    value = new DataView(bytes.buffer).getFloat64(0, true);
  }
  return dividedByHundred ? value / 100 : value;
}

function decodeError(code: number): CellErrorValue {
  const errors: Record<number, CellErrorValue["error"]> = {
    0: ErrorValue.Null,
    7: ErrorValue.DivZero,
    15: ErrorValue.Value,
    23: ErrorValue.Ref,
    29: ErrorValue.Name,
    36: ErrorValue.Num,
    42: ErrorValue.NotApplicable,
    45: ErrorValue.Spill,
    46: ErrorValue.Calc
  };
  return { error: errors[code] ?? ErrorValue.Value };
}

export function writeWorksheetPart(
  model: WorksheetModel,
  sharedStrings: XlsbSharedStrings,
  styleRegistry: XlsbStyleRegistry,
  date1904: boolean,
  formulaContext: XlsbFormulaContext,
  options: XlsbWorksheetWriteOptions = {},
  relationships: XlsbWorksheetRelationships = {}
): Uint8Array {
  const writer = createBinaryWriter();
  const arrayFormulas = collectArrayFormulaRanges(model);
  writeRecord(writer, XlsbRecordType.BeginSheet);
  writeRecord(writer, XlsbRecordType.WsProp, worksheetPropertiesPayload(model));
  writeRecord(writer, XlsbRecordType.WsDim, dimensionsPayload(model));
  writeWorksheetViews(writer, model.views);
  writeRecord(writer, XlsbRecordType.WsFmtInfo, worksheetFormatInfoPayload(model));
  writeColumns(writer, model, styleRegistry, options);
  writeRecord(writer, XlsbRecordType.BeginSheetData);

  for (const row of model.rows ?? []) {
    const cells = row.cells.filter(cell => cell.type !== ValueType.Merge);
    if (cells.length === 0 && !row.height && !row.hidden && !row.outlineLevel) {
      continue;
    }
    writeRecord(
      writer,
      XlsbRecordType.RowHdr,
      rowHeaderPayload(row, cells, styleRegistry, options)
    );
    for (const cell of cells) {
      writeCell(
        writer,
        cell,
        sharedStrings,
        styleRegistry,
        date1904,
        formulaContext,
        options,
        arrayFormulas
      );
    }
  }
  writeRecord(writer, XlsbRecordType.EndSheetData);

  writeSheetProtection(writer, model.sheetProtection, options);

  if (model.autoFilter) {
    const ref = resolveAutoFilterRange(model.autoFilter);
    writeAutoFilter(
      writer,
      rangePayload(ref),
      ref,
      model.autoFilterCriteria,
      options.unsupported ?? "error"
    );
  }

  if (model.mergeCells && model.mergeCells.length > 0) {
    const begin = createPayload(4);
    begin.view.setUint32(0, model.mergeCells.length, true);
    writeRecord(writer, XlsbRecordType.BeginMergeCells, begin.bytes);
    model.mergeCells.forEach(range =>
      writeRecord(writer, XlsbRecordType.MergeCell, mergePayload(range))
    );
    writeRecord(writer, XlsbRecordType.EndMergeCells);
  }

  writeHyperlinks(writer, model, relationships);

  writeRecord(writer, XlsbRecordType.PrintOptions, printOptionsPayload(model));
  writeRecord(writer, XlsbRecordType.Margins, marginsPayload(model));
  writeRecord(writer, XlsbRecordType.PageSetup, pageSetupPayload(model));
  writeRecord(writer, XlsbRecordType.BeginHeaderFooter, headerFooterPayload(model));
  writeRecord(writer, XlsbRecordType.EndHeaderFooter);
  writePageBreaks(
    writer,
    model.rowBreaks,
    XlsbRecordType.BeginRowBreaks,
    XlsbRecordType.EndRowBreaks
  );
  writePageBreaks(
    writer,
    model.colBreaks,
    XlsbRecordType.BeginColumnBreaks,
    XlsbRecordType.EndColumnBreaks
  );
  writeIgnoredErrors(writer, model);
  writeDataValidations(writer, model, date1904, formulaContext, options);

  if (relationships.tableRelationIds?.length) {
    const payload = createPayload(4);
    payload.view.setUint32(0, relationships.tableRelationIds.length, true);
    writeRecord(writer, XlsbRecordType.BeginListParts, payload.bytes);
    relationships.tableRelationIds.forEach(relationId =>
      writeRecord(writer, XlsbRecordType.ListPart, encodeWideString(relationId))
    );
    writeRecord(writer, XlsbRecordType.EndListParts);
  }

  if (relationships.legacyDrawingRelationId) {
    writeRecord(
      writer,
      XlsbRecordType.LegacyDrawing,
      encodeWideString(relationships.legacyDrawingRelationId)
    );
  }

  writeRecord(writer, XlsbRecordType.EndSheet);
  return finishBinaryWriter(writer);
}

function writeDataValidations(
  writer: ReturnType<typeof createBinaryWriter>,
  model: WorksheetModel,
  date1904: boolean,
  context: XlsbFormulaContext,
  options: XlsbWorksheetWriteOptions
): void {
  const validations = Object.entries(model.dataValidations).filter(
    (entry): entry is [string, DataValidationRule] => entry[1] !== undefined
  );
  const payloads: Uint8Array[] = [];
  for (const [key, validation] of validations) {
    try {
      payloads.push(
        dataValidationPayload(
          key.startsWith("range:") ? key.slice(6) : key,
          validation,
          date1904,
          context
        )
      );
    } catch (error) {
      if (
        (options.unsupported ?? "error") !== "ignore" ||
        !(error instanceof ExcelNotSupportedError)
      ) {
        throw error;
      }
    }
  }
  if (payloads.length === 0) {
    return;
  }
  const begin = createPayload(18);
  begin.view.setUint32(14, payloads.length, true);
  writeRecord(writer, XlsbRecordType.BeginDataValidations, begin.bytes);
  for (const payload of payloads) {
    writeRecord(writer, XlsbRecordType.DataValidation, payload);
  }
  writeRecord(writer, XlsbRecordType.EndDataValidations);
}

function dataValidationPayload(
  range: string,
  validation: DataValidationRule,
  date1904: boolean,
  context: XlsbFormulaContext
): Uint8Array {
  const typeCode = [
    "any",
    "whole",
    "decimal",
    "list",
    "date",
    "time",
    "textLength",
    "custom"
  ].indexOf(validation.type);
  const formulas = validation.type === "any" ? [] : validation.formulae;
  const operator = validation.type === "any" ? undefined : (validation.operator ?? "between");
  const requiredFormulaCount =
    validation.type === "any"
      ? 0
      : validation.type !== "list" &&
          validation.type !== "custom" &&
          (operator === "between" || operator === "notBetween")
        ? 2
        : 1;
  if (formulas.length < requiredFormulaCount) {
    throw new ExcelNotSupportedError(
      `Write XLSB data validation on ${range}`,
      `expected ${requiredFormulaCount} formula value(s), received ${formulas.length}`
    );
  }
  let flags = typeCode;
  flags |= ({ stop: 0, warning: 1, information: 2 }[validation.errorStyle ?? "stop"] ?? 0) << 4;
  flags |= validation.allowBlank ? 0x100 : 0;
  flags |= validation.showInputMessage ? 0x40000 : 0;
  flags |= validation.showErrorMessage ? 0x80000 : 0;
  if (validation.type !== "any" && validation.type !== "list" && validation.type !== "custom") {
    flags |= dataValidationOperatorCode(validation.operator ?? "between") << 20;
  }
  const ranges = range.trim().split(/\s+/).map(decodeRange);
  const strings = [
    validation.errorTitle,
    validation.error,
    validation.promptTitle,
    validation.prompt
  ].map(value => encodeNullableWideString(value ?? null));
  const encodedFormulas = [0, 1].map(index =>
    index < formulas.length
      ? compileCellFormula(
          dataValidationFormulaText(formulas[index]!, date1904),
          range.split(":")[0]!,
          context
        )
      : new Uint8Array(8)
  );
  const length =
    8 +
    ranges.length * 16 +
    strings.reduce((total, value) => total + value.length, 0) +
    encodedFormulas.reduce((total, value) => total + value.length, 0);
  const payload = createPayload(length);
  payload.view.setUint32(0, flags, true);
  payload.view.setUint32(4, ranges.length, true);
  let offset = 8;
  ranges.forEach(decoded => {
    payload.view.setUint32(offset, decoded.s.r, true);
    payload.view.setUint32(offset + 4, decoded.e.r, true);
    payload.view.setUint32(offset + 8, decoded.s.c, true);
    payload.view.setUint32(offset + 12, decoded.e.c, true);
    offset += 16;
  });
  [...strings, ...encodedFormulas].forEach(value => {
    payload.bytes.set(value, offset);
    offset += value.length;
  });
  return payload.bytes;
}

function dataValidationFormulaText(value: string | number | Date, date1904: boolean): string {
  if (value instanceof Date) {
    return String(dateToExcel(value, date1904));
  }
  return String(value);
}

function dataValidationOperatorCode(operator: DataValidationOperator): number {
  return [
    "between",
    "notBetween",
    "equal",
    "notEqual",
    "greaterThan",
    "lessThan",
    "greaterThanOrEqual",
    "lessThanOrEqual"
  ].indexOf(operator);
}

function writeSheetProtection(
  writer: ReturnType<typeof createBinaryWriter>,
  protection: SheetProtection | null,
  options: XlsbWorksheetWriteOptions
): void {
  if (!protection) {
    return;
  }
  const values = sheetProtectionValues(protection);
  const passwordFields = [
    protection.algorithmName,
    protection.hashValue,
    protection.saltValue,
    protection.spinCount
  ];
  const hasAnyIsoField = passwordFields.some(value => value !== undefined);
  const hasAllIsoFields = passwordFields.every(value => value !== undefined);
  if (hasAnyIsoField && !hasAllIsoFields && (options.unsupported ?? "error") === "error") {
    throw new ExcelNotSupportedError(
      "Write XLSB sheet protection",
      "algorithmName, hashValue, saltValue and spinCount must be provided together"
    );
  }
  if (hasAllIsoFields) {
    writeRecord(
      writer,
      XlsbRecordType.SheetProtectionIso,
      isoSheetProtectionPayload(protection, values)
    );
  }
  writeRecord(writer, XlsbRecordType.SheetProtection, legacySheetProtectionPayload(values));
}

function sheetProtectionValues(protection: SheetProtection): number[] {
  return [
    protection.sheet ? 1 : 0,
    protection.objects === false ? 0 : 1,
    protection.scenarios === false ? 0 : 1,
    protection.formatCells ? 1 : 0,
    protection.formatColumns ? 1 : 0,
    protection.formatRows ? 1 : 0,
    protection.insertColumns ? 1 : 0,
    protection.insertRows ? 1 : 0,
    protection.insertHyperlinks ? 1 : 0,
    protection.deleteColumns ? 1 : 0,
    protection.deleteRows ? 1 : 0,
    protection.selectLockedCells === false ? 0 : 1,
    protection.sort ? 1 : 0,
    protection.autoFilter ? 1 : 0,
    protection.pivotTables ? 1 : 0,
    protection.selectUnlockedCells === false ? 0 : 1
  ];
}

function legacySheetProtectionPayload(values: readonly number[]): Uint8Array {
  const payload = createPayload(2 + values.length * 4);
  values.forEach((value, index) => payload.view.setUint32(2 + index * 4, value, true));
  return payload.bytes;
}

function isoSheetProtectionPayload(
  protection: SheetProtection,
  values: readonly number[]
): Uint8Array {
  const spinCount = protection.spinCount!;
  validateProtectionSpinCount(spinCount, "Write XLSB sheet protection");
  const password = encodeIsoPasswordData(protection, "Write XLSB sheet protection");
  const payload = createPayload(4 + values.length * 4 + password.length);
  payload.view.setUint32(0, spinCount, true);
  values.forEach((value, index) => payload.view.setUint32(4 + index * 4, value, true));
  payload.bytes.set(password, 4 + values.length * 4);
  return payload.bytes;
}

function writeColumns(
  writer: ReturnType<typeof createBinaryWriter>,
  model: WorksheetModel,
  styles: XlsbStyleRegistry,
  options: XlsbWorksheetWriteOptions
): void {
  if (!model.cols || model.cols.length === 0) {
    return;
  }
  writeRecord(writer, XlsbRecordType.BeginColInfos);
  for (const column of model.cols) {
    const payload = createPayload(18);
    payload.view.setUint32(0, column.min - 1, true);
    payload.view.setUint32(4, column.max - 1, true);
    payload.view.setUint32(8, Math.round((column.width ?? 9) * 256), true);
    payload.view.setUint32(12, styleIndex(column.style, styles, options), true);
    let flags = column.hidden ? 1 : 0;
    flags |= column.isCustomWidth ? 2 : 0;
    flags |= column.bestFit ? 4 : 0;
    flags |= ((column.outlineLevel ?? 0) & 7) << 8;
    flags |= column.collapsed ? 0x1000 : 0;
    payload.view.setUint16(16, flags, true);
    writeRecord(writer, XlsbRecordType.ColInfo, payload.bytes);
  }
  writeRecord(writer, XlsbRecordType.EndColInfos);
}

function writeCell(
  writer: ReturnType<typeof createBinaryWriter>,
  cell: CellModel,
  sharedStrings: XlsbSharedStrings,
  styles: XlsbStyleRegistry,
  date1904: boolean,
  formulaContext: XlsbFormulaContext,
  options: XlsbWorksheetWriteOptions,
  arrayFormulas: readonly ArrayFormulaRange[]
): void {
  const decoded = colCache.decodeAddress(cell.address);
  const style = { ...(cell.style ?? {}) };
  const arrayFormula = arrayFormulas.find(candidate =>
    formulaGroupContains(candidate, decoded.row - 1, decoded.col - 1)
  );
  if (arrayFormula && arrayFormula.masterAddress !== cell.address) {
    writeFormulaResultRecord(
      writer,
      cell,
      style,
      styles,
      date1904,
      formulaReferencePayload(arrayFormula.masterAddress),
      cell.result !== undefined ? cell.result : cell.value,
      options
    );
    return;
  }
  let value = cell.value;
  if (cell.type === ValueType.Formula || cell.formula || cell.sharedFormula) {
    writeFormulaCell(writer, cell, style, styles, date1904, formulaContext, options);
    return;
  }
  if (cell.type === ValueType.Hyperlink) {
    const richText = Array.isArray(cell.richText) ? cell.richText : cell.richText?.richText;
    value = richText?.length ? { richText } : (cell.text ?? "");
  }
  if (value instanceof Date) {
    style.numFmt ??= "mm-dd-yy";
    value = dateToExcel(value, date1904);
  }
  const styleId = styleIndex(style, styles, options);
  const header = cellHeader(decoded.col - 1, styleId);

  if (value === null || value === undefined) {
    writeRecord(writer, XlsbRecordType.CellBlank, header);
  } else if (typeof value === "number") {
    const payload = new Uint8Array(16);
    payload.set(header);
    new DataView(payload.buffer).setFloat64(8, value, true);
    writeRecord(writer, XlsbRecordType.CellReal, payload);
  } else if (typeof value === "boolean") {
    const payload = new Uint8Array(9);
    payload.set(header);
    payload[8] = value ? 1 : 0;
    writeRecord(writer, XlsbRecordType.CellBool, payload);
  } else if (typeof value === "string") {
    const payload = new Uint8Array(12);
    payload.set(header);
    new DataView(payload.buffer).setUint32(8, addSharedString(sharedStrings, value), true);
    writeRecord(writer, XlsbRecordType.CellIsst, payload);
  } else if (isRichTextValue(value)) {
    const payload = new Uint8Array(12);
    payload.set(header);
    new DataView(payload.buffer).setUint32(8, addSharedString(sharedStrings, value), true);
    writeRecord(writer, XlsbRecordType.CellIsst, payload);
  } else if (isErrorValue(value)) {
    const payload = new Uint8Array(9);
    payload.set(header);
    const errorCode = encodeError(value.error);
    if (errorCode === undefined) {
      throw new ExcelNotSupportedError(
        `Write XLSB error at ${cell.address}`,
        `${value.error} has no BIFF12 BErr representation`
      );
    }
    payload[8] = errorCode;
    writeRecord(writer, XlsbRecordType.CellError, payload);
  } else if ((options.unsupported ?? "error") === "error") {
    throw new ExcelNotSupportedError(
      `Write XLSB cell ${cell.address}`,
      `value type ${cell.type} cannot be represented without losing information`
    );
  }
}

function isRichTextValue(value: unknown): value is CellRichTextValue {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<CellRichTextValue>).richText)
  );
}

function writeHyperlinks(
  writer: ReturnType<typeof createBinaryWriter>,
  model: WorksheetModel,
  relationships: XlsbWorksheetRelationships
): void {
  for (const row of model.rows ?? []) {
    for (const cell of row.cells) {
      if (!cell.hyperlink) {
        continue;
      }
      const hashIndex = cell.hyperlink.indexOf("#");
      const target = hashIndex < 0 ? cell.hyperlink : cell.hyperlink.slice(0, hashIndex);
      const location = hashIndex < 0 ? "" : cell.hyperlink.slice(hashIndex + 1);
      let relationId = "";
      if (target) {
        if (!relationships.addHyperlink) {
          throw new ExcelNotSupportedError(
            `Write XLSB hyperlink at ${cell.address}`,
            "worksheet relationship collector is unavailable"
          );
        }
        relationId = relationships.addHyperlink(target);
      }
      const range = rangePayload(`${cell.address}:${cell.address}`);
      const strings = [
        encodeWideString(relationId),
        encodeWideString(location),
        encodeWideString(cell.tooltip ?? ""),
        encodeWideString(cell.text ?? "")
      ];
      const payload = new Uint8Array(
        range.length + strings.reduce((length, value) => length + value.length, 0)
      );
      payload.set(range);
      let offset = range.length;
      for (const value of strings) {
        payload.set(value, offset);
        offset += value.length;
      }
      writeRecord(writer, XlsbRecordType.Hyperlink, payload);
    }
  }
}

function writePageBreaks(
  writer: ReturnType<typeof createBinaryWriter>,
  pageBreaks: readonly { id: number; min?: number; max: number; man: number }[],
  beginType: number,
  endType: number
): void {
  if (pageBreaks.length === 0) {
    return;
  }
  const begin = createPayload(8);
  begin.view.setUint32(0, pageBreaks.length, true);
  begin.view.setUint32(4, pageBreaks.filter(pageBreak => pageBreak.man).length, true);
  writeRecord(writer, beginType, begin.bytes);
  for (const pageBreak of pageBreaks) {
    const payload = createPayload(20);
    payload.view.setUint32(0, pageBreak.id - 1, true);
    payload.view.setUint32(4, pageBreak.min ?? 0, true);
    payload.view.setUint32(8, pageBreak.max, true);
    payload.view.setUint32(12, pageBreak.man, true);
    writeRecord(writer, XlsbRecordType.PageBreak, payload.bytes);
  }
  writeRecord(writer, endType);
}

function writeIgnoredErrors(
  writer: ReturnType<typeof createBinaryWriter>,
  model: WorksheetModel
): void {
  if (model.ignoredErrors.length === 0) {
    return;
  }
  writeRecord(writer, XlsbRecordType.BeginIgnoredErrors);
  for (const ignoredError of model.ignoredErrors) {
    const ranges = ignoredError.ref.trim().split(/\s+/).filter(Boolean).map(decodeRange);
    const payload = createPayload(8 + ranges.length * 16);
    let flags = ignoredError.evalError ? 0x001 : 0;
    flags |= ignoredError.emptyCellReference ? 0x002 : 0;
    flags |= ignoredError.numberStoredAsText ? 0x004 : 0;
    flags |= ignoredError.formulaRange ? 0x008 : 0;
    flags |= ignoredError.formula ? 0x010 : 0;
    flags |= ignoredError.twoDigitTextYear ? 0x020 : 0;
    flags |= ignoredError.unlockedFormula ? 0x040 : 0;
    flags |= ignoredError.listDataValidation ? 0x080 : 0;
    flags |= ignoredError.calculatedColumn ? 0x100 : 0;
    payload.view.setUint32(0, flags, true);
    payload.view.setUint32(4, ranges.length, true);
    ranges.forEach((range, index) => {
      const offset = 8 + index * 16;
      payload.view.setUint32(offset, range.s.r, true);
      payload.view.setUint32(offset + 4, range.e.r, true);
      payload.view.setUint32(offset + 8, range.s.c, true);
      payload.view.setUint32(offset + 12, range.e.c, true);
    });
    writeRecord(writer, XlsbRecordType.IgnoredError, payload.bytes);
  }
  writeRecord(writer, XlsbRecordType.EndIgnoredErrors);
}

function writeFormulaCell(
  writer: ReturnType<typeof createBinaryWriter>,
  cell: CellModel,
  style: Partial<Style>,
  styles: XlsbStyleRegistry,
  date1904: boolean,
  formulaContext: XlsbFormulaContext,
  options: XlsbWorksheetWriteOptions
): void {
  if (cell.isDynamicArray) {
    throw new ExcelNotSupportedError(
      `Write XLSB formula at ${cell.address}`,
      "dynamic-array metadata is not implemented"
    );
  }
  if (cell.sharedFormula) {
    writeFormulaResultRecord(
      writer,
      cell,
      style,
      styles,
      date1904,
      formulaReferencePayload(cell.sharedFormula),
      cell.result,
      options
    );
    return;
  }
  if (!cell.formula) {
    throw new ExcelNotSupportedError(`Write XLSB formula at ${cell.address}`, "missing formula");
  }
  if (cell.shareType && cell.shareType !== "array" && cell.shareType !== "shared") {
    throw new ExcelNotSupportedError(
      `Write XLSB formula at ${cell.address}`,
      `unknown formula sharing type ${cell.shareType}`
    );
  }
  if (cell.shareType && !cell.ref) {
    throw new ExcelNotSupportedError(
      `Write XLSB formula at ${cell.address}`,
      `${cell.shareType} formula is missing its range`
    );
  }

  if (cell.shareType) {
    const decodedRange = decodeRange(cell.ref!);
    const master = colCache.decodeAddress(cell.address);
    if (decodedRange.s.r !== master.row - 1 || decodedRange.s.c !== master.col - 1) {
      throw new ExcelNotSupportedError(
        `Write XLSB formula at ${cell.address}`,
        `${cell.shareType} formula master must be the top-left cell of ${cell.ref}`
      );
    }
    writeFormulaResultRecord(
      writer,
      cell,
      style,
      styles,
      date1904,
      formulaReferencePayload(cell.address),
      cell.result,
      options
    );
    const formula =
      cell.shareType === "shared"
        ? compileSharedFormula(cell.formula, cell.address, formulaContext)
        : compileCellFormula(cell.formula, cell.address, formulaContext);
    const range = rangePayload(cell.ref!);
    const payload = new Uint8Array(
      range.length + (cell.shareType === "array" ? 1 : 0) + formula.length
    );
    payload.set(range);
    payload.set(formula, range.length + (cell.shareType === "array" ? 1 : 0));
    writeRecord(
      writer,
      cell.shareType === "array" ? XlsbRecordType.ArrayFormula : XlsbRecordType.SharedFormula,
      payload
    );
    return;
  }

  if (cell.ref) {
    throw new ExcelNotSupportedError(
      `Write XLSB formula at ${cell.address}`,
      "formula range requires a sharing type"
    );
  }
  writeFormulaResultRecord(
    writer,
    cell,
    style,
    styles,
    date1904,
    compileCellFormula(cell.formula, cell.address, formulaContext),
    cell.result,
    options
  );
}

function writeFormulaResultRecord(
  writer: ReturnType<typeof createBinaryWriter>,
  cell: CellModel,
  style: Partial<Style>,
  styles: XlsbStyleRegistry,
  date1904: boolean,
  formula: Uint8Array,
  rawResult: unknown,
  options: XlsbWorksheetWriteOptions
): void {
  let result = rawResult;
  if (result instanceof Date) {
    style.numFmt ??= "mm-dd-yy";
    result = dateToExcel(result, date1904);
  }
  const header = cellHeader(
    colCache.decodeAddress(cell.address).col - 1,
    styleIndex(style, styles, options)
  );
  let recordType: number;
  let encodedResult: Uint8Array;

  if (typeof result === "number") {
    recordType = XlsbRecordType.FmlaNum;
    encodedResult = new Uint8Array(8);
    new DataView(encodedResult.buffer).setFloat64(0, result, true);
  } else if (typeof result === "boolean") {
    recordType = XlsbRecordType.FmlaBool;
    encodedResult = Uint8Array.of(result ? 1 : 0);
  } else if (isErrorValue(result)) {
    const code = formulaResultErrorCode(result);
    if (code === undefined) {
      throw new ExcelNotSupportedError(
        `Write XLSB formula at ${cell.address}`,
        `${result.error} has no BIFF12 BErr representation`
      );
    }
    recordType = XlsbRecordType.FmlaError;
    encodedResult = Uint8Array.of(code);
  } else {
    recordType = XlsbRecordType.FmlaString;
    encodedResult = encodeWideString(typeof result === "string" ? result : "");
  }

  const payload = new Uint8Array(header.length + encodedResult.length + 2 + formula.length);
  payload.set(header);
  payload.set(encodedResult, header.length);
  payload.set(formula, header.length + encodedResult.length + 2);
  writeRecord(writer, recordType, payload);
}

function formulaReferencePayload(address: string): Uint8Array {
  const decoded = colCache.decodeAddress(address);
  const payload = createPayload(17);
  payload.view.setUint32(0, 5, true);
  payload.bytes[4] = 0x01;
  payload.view.setUint32(5, decoded.row - 1, true);
  payload.view.setUint32(9, 4, true);
  payload.view.setUint32(13, decoded.col - 1, true);
  return payload.bytes;
}

function collectArrayFormulaRanges(model: WorksheetModel): ArrayFormulaRange[] {
  const cells = (model.rows ?? []).flatMap(row => row.cells);
  const addresses = new Set(cells.map(cell => cell.address));
  const ranges = cells
    .filter(cell => cell.shareType === "array")
    .map(cell => {
      if (!cell.ref || !cell.formula || cell.isDynamicArray) {
        throw new ExcelNotSupportedError(
          `Write XLSB formula at ${cell.address}`,
          cell.isDynamicArray
            ? "dynamic-array metadata is not implemented"
            : "array formula requires a formula and range"
        );
      }
      const range = decodeRange(cell.ref);
      const master = colCache.decodeAddress(cell.address);
      if (range.s.r !== master.row - 1 || range.s.c !== master.col - 1) {
        throw new ExcelNotSupportedError(
          `Write XLSB formula at ${cell.address}`,
          `array formula master must be the top-left cell of ${cell.ref}`
        );
      }
      for (let row = range.s.r; row <= range.e.r; row++) {
        for (let column = range.s.c; column <= range.e.c; column++) {
          const address = colCache.encodeAddress(row + 1, column + 1);
          if (!addresses.has(address)) {
            throw new ExcelNotSupportedError(
              `Write XLSB formula at ${cell.address}`,
              `array range ${cell.ref} is missing cell ${address}`
            );
          }
        }
      }
      return {
        masterAddress: cell.address,
        firstRow: range.s.r,
        lastRow: range.e.r,
        firstColumn: range.s.c,
        lastColumn: range.e.c
      };
    });
  for (let index = 0; index < ranges.length; index++) {
    for (let other = index + 1; other < ranges.length; other++) {
      const left = ranges[index]!;
      const right = ranges[other]!;
      if (
        left.firstRow <= right.lastRow &&
        right.firstRow <= left.lastRow &&
        left.firstColumn <= right.lastColumn &&
        right.firstColumn <= left.lastColumn
      ) {
        throw new ExcelNotSupportedError(
          "Write XLSB array formulas",
          `${left.masterAddress} and ${right.masterAddress} have overlapping ranges`
        );
      }
    }
  }
  return ranges;
}

function styleIndex(
  style: Partial<Style> | undefined,
  registry: XlsbStyleRegistry,
  _options: XlsbWorksheetWriteOptions
): number {
  return addStyle(registry, style);
}

function rowHeaderPayload(
  row: NonNullable<WorksheetModel["rows"]>[number],
  cells: CellModel[],
  styles: XlsbStyleRegistry,
  options: XlsbWorksheetWriteOptions
): Uint8Array {
  const hasSpan = cells.length > 0;
  const payload = createPayload(17 + (hasSpan ? 8 : 0));
  payload.view.setUint32(0, row.number - 1, true);
  const rowStyle = styleIndex(row.style, styles, options);
  payload.view.setUint32(4, rowStyle, true);
  payload.view.setUint16(8, Math.round((row.height ?? 15) * 20), true);
  let flags = (row.outlineLevel ?? 0) & 7;
  flags |= row.collapsed ? 0x08 : 0;
  flags |= row.hidden ? 0x10 : 0;
  flags |= row.height !== undefined || row.customHeight ? 0x20 : 0;
  flags |= rowStyle > 0 ? 0x40 : 0;
  payload.bytes[11] = flags;
  payload.view.setUint32(13, hasSpan ? 1 : 0, true);
  if (hasSpan) {
    const columns = cells.map(cell => colCache.decodeAddress(cell.address).col - 1);
    payload.view.setUint32(17, Math.min(...columns), true);
    payload.view.setUint32(21, Math.max(...columns), true);
  }
  return payload.bytes;
}

function cellHeader(column: number, styleIndex: number): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, column, true);
  header[4] = styleIndex & 0xff;
  header[5] = (styleIndex >>> 8) & 0xff;
  header[6] = (styleIndex >>> 16) & 0xff;
  return header;
}

function dimensionsPayload(model: WorksheetModel): Uint8Array {
  const payload = createPayload(16);
  const rows = model.rows ?? [];
  const populated = rows.flatMap(row =>
    row.cells
      .filter(cell => cell.type !== ValueType.Merge)
      .map(cell => ({ row: row.number - 1, col: colCache.decodeAddress(cell.address).col - 1 }))
  );
  if (populated.length > 0) {
    payload.view.setUint32(0, Math.min(...populated.map(cell => cell.row)), true);
    payload.view.setUint32(4, Math.max(...populated.map(cell => cell.row)), true);
    payload.view.setUint32(8, Math.min(...populated.map(cell => cell.col)), true);
    payload.view.setUint32(12, Math.max(...populated.map(cell => cell.col)), true);
  }
  return payload.bytes;
}

function mergePayload(range: string): Uint8Array {
  return rangePayload(range);
}

function rangePayload(range: string): Uint8Array {
  const decoded = decodeRange(range);
  const payload = createPayload(16);
  payload.view.setUint32(0, decoded.s.r, true);
  payload.view.setUint32(4, decoded.e.r, true);
  payload.view.setUint32(8, decoded.s.c, true);
  payload.view.setUint32(12, decoded.e.c, true);
  return payload.bytes;
}

function parseRange(data: Uint8Array, context: string): string {
  const reader = new XlsbBinaryReader(data, context);
  const firstRow = reader.u32();
  const lastRow = reader.u32();
  const firstColumn = reader.u32();
  const lastColumn = reader.u32();
  return `${colCache.encodeAddress(firstRow + 1, firstColumn + 1)}:${colCache.encodeAddress(lastRow + 1, lastColumn + 1)}`;
}

function resolveAutoFilterRange(model: NonNullable<WorksheetModel["autoFilter"]>): string {
  if (typeof model === "string") {
    return model;
  }
  const address = (value: string | { row: number; col: number }): string =>
    typeof value === "string" ? value : colCache.encodeAddress(value.row, value.col);
  return `${address(model.from)}:${address(model.to)}`;
}

function marginsPayload(model: WorksheetModel): Uint8Array {
  const payload = createPayload(48);
  const margins = model.pageSetup.margins;
  [
    margins.left,
    margins.right,
    margins.top,
    margins.bottom,
    margins.header,
    margins.footer
  ].forEach((value, index) => payload.view.setFloat64(index * 8, value, true));
  return payload.bytes;
}

function printOptionsPayload(model: WorksheetModel): Uint8Array {
  const payload = createPayload(2);
  let flags = model.pageSetup.horizontalCentered ? 0x01 : 0;
  flags |= model.pageSetup.verticalCentered ? 0x02 : 0;
  flags |= model.pageSetup.showRowColHeaders ? 0x04 : 0;
  flags |= model.pageSetup.showGridLines ? 0x08 : 0;
  payload.view.setUint16(0, flags, true);
  return payload.bytes;
}

function pageSetupPayload(model: WorksheetModel): Uint8Array {
  const payload = createPayload(38);
  const pageSetup = model.pageSetup;
  payload.view.setUint32(0, pageSetup.paperSize ?? 0, true);
  payload.view.setUint32(4, pageSetup.scale, true);
  payload.view.setUint32(8, pageSetup.horizontalDpi ?? 0, true);
  payload.view.setUint32(12, pageSetup.verticalDpi ?? 0, true);
  payload.view.setUint32(16, pageSetup.copies ?? 1, true);
  payload.view.setInt32(20, pageSetup.firstPageNumber ?? 1, true);
  payload.view.setUint32(24, pageSetup.fitToWidth, true);
  payload.view.setUint32(28, pageSetup.fitToHeight, true);
  let flags = pageSetup.pageOrder === "overThenDown" ? 0x01 : 0;
  flags |= pageSetup.orientation === "landscape" ? 0x02 : 0;
  flags |= pageSetup.blackAndWhite ? 0x08 : 0;
  flags |= pageSetup.draft ? 0x10 : 0;
  flags |= pageSetup.cellComments !== "None" ? 0x20 : 0;
  flags |= pageSetup.usePrinterDefaults ? 0x40 : 0;
  flags |= (pageSetup.useFirstPageNumber ?? pageSetup.firstPageNumber !== undefined) ? 0x80 : 0;
  flags |= pageSetup.cellComments === "atEnd" ? 0x100 : 0;
  flags |= ({ displayed: 0, blank: 1, dash: 2, NA: 3 }[pageSetup.errors] ?? 0) << 9;
  payload.view.setUint16(32, flags, true);
  payload.view.setUint32(34, 0xffffffff, true);
  return payload.bytes;
}

function headerFooterPayload(model: WorksheetModel): Uint8Array {
  const headerFooter = model.headerFooter;
  const strings = [
    headerFooter.oddHeader,
    headerFooter.oddFooter,
    headerFooter.evenHeader,
    headerFooter.evenFooter,
    headerFooter.firstHeader,
    headerFooter.firstFooter
  ].map(encodeNullableWideString);
  const payload = new Uint8Array(2 + strings.reduce((length, value) => length + value.length, 0));
  let flags = headerFooter.differentOddEven ? 0x01 : 0;
  flags |= headerFooter.differentFirst ? 0x02 : 0;
  flags |= headerFooter.scaleWithDoc !== false ? 0x04 : 0;
  flags |= headerFooter.alignWithMargins !== false ? 0x08 : 0;
  new DataView(payload.buffer).setUint16(0, flags, true);
  let offset = 2;
  for (const value of strings) {
    payload.set(value, offset);
    offset += value.length;
  }
  return payload;
}

function encodeNullableWideString(value: string | null): Uint8Array {
  if (value === null) {
    const payload = createPayload(4);
    payload.view.setUint32(0, 0xffffffff, true);
    return payload.bytes;
  }
  return encodeWideString(value);
}

function worksheetPropertiesPayload(model: WorksheetModel): Uint8Array {
  const payload = createPayload(23);
  let flags = 0x020409;
  if (model.properties?.outlineProperties?.summaryBelow !== false) {
    flags |= 0x40;
  }
  if (model.properties?.outlineProperties?.summaryRight !== false) {
    flags |= 0x80;
  }
  if (model.pageSetup?.fitToPage) {
    flags |= 0x100;
  }
  payload.bytes[0] = flags & 0xff;
  payload.bytes[1] = (flags >>> 8) & 0xff;
  payload.bytes[2] = (flags >>> 16) & 0xff;
  payload.bytes.set(worksheetColorPayload(model.properties?.tabColor), 3);
  payload.view.setUint32(11, 0xffffffff, true);
  payload.view.setUint32(15, 0xffffffff, true);
  return payload.bytes;
}

function worksheetFormatInfoPayload(model: WorksheetModel): Uint8Array {
  const payload = createPayload(12);
  const defaultColumnWidth = model.properties?.defaultColWidth;
  if (defaultColumnWidth === undefined) {
    payload.view.setUint32(0, 0xffffffff, true);
    payload.view.setUint16(4, 8, true);
  } else {
    payload.view.setUint32(0, Math.round(defaultColumnWidth * 256), true);
  }
  payload.view.setUint16(6, Math.round((model.properties?.defaultRowHeight ?? 15) * 20), true);
  payload.view.setUint16(8, 0x01, true);
  payload.bytes[10] = model.properties?.outlineLevelRow ?? 0;
  payload.bytes[11] = model.properties?.outlineLevelCol ?? 0;
  return payload.bytes;
}

function writeWorksheetViews(
  writer: ReturnType<typeof createBinaryWriter>,
  configuredViews: readonly Partial<WorksheetView>[] | undefined
): void {
  writeRecord(writer, XlsbRecordType.BeginWsViews);
  const views = configuredViews?.length ? configuredViews : [{ state: "normal" as const }];
  for (let index = 0; index < views.length; index++) {
    const view = views[index]! as XlsbWorksheetView;
    writeRecord(writer, XlsbRecordType.BeginWsView, worksheetViewPayload(view));
    if (view.state === "frozen" || view.state === "split") {
      writeRecord(writer, XlsbRecordType.Pane, panePayload(view));
    }
    if (view.activeCell) {
      writeRecord(writer, XlsbRecordType.Selection, selectionPayload(view));
    }
    writeRecord(writer, XlsbRecordType.EndWsView);
  }
  writeRecord(writer, XlsbRecordType.EndWsViews);
}

function worksheetViewPayload(view: XlsbWorksheetView): Uint8Array {
  const payload = createPayload(30);
  let flags = 0x031c;
  if (view.rightToLeft) {
    flags |= 0x20;
  }
  if (view.tabSelected) {
    flags |= 0x40;
  }
  if (view.showRuler !== false) {
    flags |= 0x80;
  }
  if (view.showGridLines === false) {
    flags &= ~0x04;
  }
  if (view.showRowColHeaders === false) {
    flags &= ~0x08;
  }
  payload.view.setUint16(0, flags, true);
  payload.view.setUint32(
    2,
    view.style === "pageBreakPreview" ? 1 : view.style === "pageLayout" ? 2 : 0,
    true
  );
  payload.bytes[14] = 0x40;
  payload.view.setUint16(18, view.zoomScale ?? 100, true);
  payload.view.setUint16(20, view.zoomScaleNormal ?? 0, true);
  payload.view.setUint32(26, view.workbookViewId ?? 0, true);
  return payload.bytes;
}

function panePayload(view: XlsbWorksheetView): Uint8Array {
  const payload = createPayload(29);
  const xSplit = view.xSplit ?? 0;
  const ySplit = view.ySplit ?? 0;
  payload.view.setFloat64(0, xSplit, true);
  payload.view.setFloat64(8, ySplit, true);
  const topLeft = colCache.decodeAddress(
    view.topLeftCell ?? colCache.encodeAddress(ySplit + 1, xSplit + 1)
  );
  payload.view.setUint32(16, topLeft.row - 1, true);
  payload.view.setUint32(20, topLeft.col - 1, true);
  payload.view.setUint32(24, paneValue(view.activePane ?? inferredPane(xSplit, ySplit)), true);
  payload.bytes[28] = view.state === "frozen" ? 0x01 : 0;
  return payload.bytes;
}

function selectionPayload(view: XlsbWorksheetView): Uint8Array {
  const payload = createPayload(36);
  const active = colCache.decodeAddress(view.activeCell ?? "A1");
  payload.view.setUint32(0, paneValue(viewPane(view)), true);
  payload.view.setUint32(4, active.row - 1, true);
  payload.view.setUint32(8, active.col - 1, true);
  payload.view.setUint32(16, 1, true);
  payload.view.setUint32(20, active.row - 1, true);
  payload.view.setUint32(24, active.row - 1, true);
  payload.view.setUint32(28, active.col - 1, true);
  payload.view.setUint32(32, active.col - 1, true);
  return payload.bytes;
}

function parseWorksheetColor(
  bytes: Uint8Array
): WorksheetModel["properties"]["tabColor"] | undefined {
  const type = bytes[0]! >>> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tintRaw = view.getInt16(2, true);
  const tint = tintRaw === 0 ? undefined : tintRaw / (tintRaw > 0 ? 32767 : 32768);
  if (type === 2) {
    return {
      argb: [bytes[7], bytes[4], bytes[5], bytes[6]]
        .map(value => value!.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase(),
      ...(tint === undefined ? {} : { tint })
    };
  }
  if (type === 3) {
    return { theme: bytes[1]!, ...(tint === undefined ? {} : { tint }) };
  }
  if (type === 1) {
    return { indexed: bytes[1]!, ...(tint === undefined ? {} : { tint }) };
  }
  return undefined;
}

function worksheetColorPayload(color: WorksheetModel["properties"]["tabColor"]): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  if (color?.argb) {
    const argb = color.argb.length === 6 ? `FF${color.argb}` : color.argb.padStart(8, "F");
    bytes[0] = 0x05;
    bytes[4] = parseInt(argb.slice(2, 4), 16);
    bytes[5] = parseInt(argb.slice(4, 6), 16);
    bytes[6] = parseInt(argb.slice(6, 8), 16);
    bytes[7] = parseInt(argb.slice(0, 2), 16);
  } else if (color?.theme !== undefined) {
    bytes[0] = 0x06;
    bytes[1] = color.theme;
  } else if (color?.indexed !== undefined) {
    bytes[0] = 0x02;
    bytes[1] = color.indexed;
  }
  if (color?.tint !== undefined) {
    const tint = Math.max(-1, Math.min(1, color.tint));
    view.setInt16(2, Math.round(tint * (tint >= 0 ? 32767 : 32768)), true);
  }
  return bytes;
}

function inferredPane(xSplit: number, ySplit: number): WorksheetPaneName {
  if (xSplit && ySplit) {
    return "bottomRight";
  }
  if (xSplit) {
    return "topRight";
  }
  if (ySplit) {
    return "bottomLeft";
  }
  return "topLeft";
}

function viewPane(view: XlsbWorksheetView): WorksheetPaneName {
  if (view.state === "split" && view.activePane) {
    return view.activePane;
  }
  if (view.state === "frozen") {
    return inferredPane(view.xSplit ?? 0, view.ySplit ?? 0);
  }
  return "topLeft";
}

function paneName(value: number): WorksheetPaneName {
  return ["bottomRight", "topRight", "bottomLeft", "topLeft"][value] as WorksheetPaneName;
}

function paneValue(value: WorksheetPaneName | undefined): number {
  return { bottomRight: 0, topRight: 1, bottomLeft: 2, topLeft: 3 }[value ?? "bottomRight"];
}

function isErrorValue(value: unknown): value is CellErrorValue {
  return !!value && typeof value === "object" && "error" in value;
}

function encodeError(error: CellErrorValue["error"]): number | undefined {
  const codes: Partial<Record<CellErrorValue["error"], number>> = {
    [ErrorValue.Null]: 0,
    [ErrorValue.DivZero]: 7,
    [ErrorValue.Value]: 15,
    [ErrorValue.Ref]: 23,
    [ErrorValue.Name]: 29,
    [ErrorValue.Num]: 36,
    [ErrorValue.NotApplicable]: 42
  };
  return codes[error];
}
