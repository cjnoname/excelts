import type { ArchiveSink } from "@archive/io/archive-sink";
import { pipeIterableToSink } from "@archive/io/archive-sink";
import { ZipParser } from "@archive/unzip/zip-parser";
import { ZipArchive } from "@archive/zip/zip-archive";
import type { WorkbookData } from "@excel/core/workbook-core";
import type { WorkbookModel } from "@excel/core/workbook.browser";
import {
  addWorksheet,
  createWorkbook,
  getWorkbookModel,
  setDefaultFont,
  setWorkbookModel
} from "@excel/core/workbook.browser";
import { ExcelNotSupportedError, XlsbParseError } from "@excel/errors";
import type { WorksheetState } from "@excel/types";
import {
  applyCommentsToWorksheet,
  collectWorksheetComments,
  parseCommentsPart,
  writeCommentsPart,
  writeCommentsVml
} from "@excel/xlsb/comments";
import type { XlsbFormulaContext } from "@excel/xlsb/formula";
import {
  parseSharedStrings,
  createSharedStrings,
  writeSharedStrings
} from "@excel/xlsb/shared-strings";
import { createStyleRegistry, parseStyles, writeStyles } from "@excel/xlsb/styles";
import { parseTablePart, writeTablePart } from "@excel/xlsb/table-part";
import {
  parseWorkbookPart,
  writeWorkbookPart,
  type XlsbSheetDescriptor
} from "@excel/xlsb/workbook-part";
import {
  parseWorksheetTableRelationIds,
  parseWorksheetPart,
  writeWorksheetPart,
  type XlsbWorksheetReadOptions,
  type XlsbWorksheetWriteOptions
} from "@excel/xlsb/worksheet-part";
import { theme1Xml } from "@excel/xlsx/xml/theme1";
import { concatUint8Arrays, decodeBytesToString, stringToUint8Array } from "@utils/binary";
import { base64ToUint8Array } from "@utils/utils";
import { xmlEncode, xmlEncodeAttr } from "@utils/xml-encode";
import { parseXml, findChildren, attr, textContent } from "@xml/dom";

export interface XlsbReadOptions extends XlsbWorksheetReadOptions {
  /** Interpret string input as base64-encoded XLSB bytes. */
  base64?: boolean;
}

export interface XlsbWriteOptions extends XlsbWorksheetWriteOptions {
  zip?: {
    level?: number;
    modTime?: Date;
    reproducible?: boolean;
  };
}

export interface XlsbStreamOptions extends XlsbWriteOptions {
  highWaterMark?: number;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

interface XlsbLoadState {
  cachedFormulaCount: number;
  unsupportedFormatting: boolean;
  unsupportedParts: string[];
  unsupportedRecords: string[];
  unsupportedSettings: string[];
  originalBytes: Uint8Array;
  modelSnapshot: WorkbookModel;
}

interface DiscoveredTablePart {
  relationId: string;
  path: string;
  data: Uint8Array;
}

const loadedXlsbState = new WeakMap<WorkbookData, XlsbLoadState>();

export async function readXlsb(
  workbook: WorkbookData,
  input: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options: XlsbReadOptions = {}
): Promise<WorkbookData> {
  const bytes = normalizeInput(input, options);
  let files: Map<string, Uint8Array>;
  try {
    files = await new ZipParser(bytes).extractAll();
  } catch (cause) {
    throw new XlsbParseError("XLSB package", "the input is not a valid ZIP package", { cause });
  }

  const workbookPackagePart = findPart(files, "xl/workbook.bin");
  if (!workbookPackagePart) {
    throw new XlsbParseError("XLSB package", "missing required part xl/workbook.bin");
  }
  const workbookBytes = workbookPackagePart.data;
  const workbookRels = parseRelationships(findPart(files, "xl/_rels/workbook.bin.rels")?.data);
  const relationshipById = new Map(workbookRels.map(relation => [relation.id, relation]));
  const workbookPart = parseWorkbookPart(workbookBytes);
  const sharedStringsRelation = workbookRels.find(relation =>
    relation.type.endsWith("/sharedStrings")
  );
  const stylesRelation = workbookRels.find(relation => relation.type.endsWith("/styles"));
  const sharedStringsPath = sharedStringsRelation
    ? resolveRelationshipTarget("xl/workbook.bin", sharedStringsRelation.target)
    : "xl/sharedStrings.bin";
  const stylesPath = stylesRelation
    ? resolveRelationshipTarget("xl/workbook.bin", stylesRelation.target)
    : "xl/styles.bin";
  const stylesPart = findPart(files, stylesPath);
  const actualStylesPath = stylesPart?.path ?? stylesPath;
  const styleTable = parseStyles(stylesPart?.data);
  const sharedStringsPart = findPart(files, sharedStringsPath);
  const actualSharedStringsPath = sharedStringsPart?.path ?? sharedStringsPath;
  const sharedStringsBytes = sharedStringsPart?.data;
  const sharedStringTable = sharedStringsBytes
    ? parseSharedStrings(sharedStringsBytes, styleTable.fonts)
    : { values: [], hasUnsupportedFormatting: false, unsupportedRecordTypes: [] };
  const sharedStrings = sharedStringTable.values;
  const sheetNames = workbookPart.sheets.map(sheet => sheet.name);
  const baseFormulaContext = {
    sheetNames,
    externalSheets: workbookPart.externalSheets,
    definedNames: workbookPart.formulaNames
  };
  const discoveredTables = new Map<number, DiscoveredTablePart[]>();
  const formulaTables: NonNullable<XlsbFormulaContext["tables"]>[number][] = [];
  for (const [sheetOrder, descriptor] of workbookPart.sheets.entries()) {
    const relation = relationshipById.get(descriptor.relationId);
    if (!relation?.type.endsWith("/worksheet")) {
      continue;
    }
    const expectedPath = resolveRelationshipTarget("xl/workbook.bin", relation.target);
    const sheetPart = findPart(files, expectedPath);
    if (!sheetPart) {
      continue;
    }
    const worksheetRelationships = parseRelationshipsOptional(
      findPart(files, relationshipPartPath(sheetPart.path))?.data
    );
    const tableParts = parseWorksheetTableRelationIds(sheetPart.data).map(relationId => {
      const tableRelationship = worksheetRelationships.find(
        worksheetRelationship =>
          worksheetRelationship.id === relationId && worksheetRelationship.type.endsWith("/table")
      );
      if (!tableRelationship) {
        throw new XlsbParseError(
          "XLSB package",
          `worksheet ${descriptor.name} references missing table relationship ${relationId}`
        );
      }
      const tablePath = resolveRelationshipTarget(sheetPart.path, tableRelationship.target);
      const tablePart = findPart(files, tablePath);
      if (!tablePart) {
        throw new XlsbParseError("XLSB package", `missing table part ${tablePath}`);
      }
      const table = parseTablePart(tablePart.data, baseFormulaContext);
      formulaTables.push({
        id: table.id,
        name: table.model.name,
        sheetIndex: sheetOrder,
        range: table.model.tableRef ?? table.model.ref,
        columns: table.model.columns.map(column => column.name)
      });
      return { relationId, path: tablePart.path, data: tablePart.data };
    });
    discoveredTables.set(sheetOrder, tableParts);
  }

  const parsed = createWorkbook();
  parsed.properties.date1904 = workbookPart.date1904;
  parsed.views = workbookPart.views;
  setDefaultFont(parsed, styleTable.defaultFont);
  applyCoreProperties(parsed, findPart(files, "docProps/core.xml")?.data);
  applyAppProperties(parsed, findPart(files, "docProps/app.xml")?.data);

  let cachedFormulaCount = 0;
  const unsupportedRecords = workbookPart.unsupportedRecordTypes.map(type =>
    unsupportedRecord("xl/workbook.bin", type)
  );
  unsupportedRecords.push(
    ...styleTable.unsupportedRecordTypes.map(type => unsupportedRecord(actualStylesPath, type)),
    ...sharedStringTable.unsupportedRecordTypes.map(type =>
      unsupportedRecord(actualSharedStringsPath, type)
    )
  );
  const worksheetPaths: string[] = [];
  const worksheetRelationshipPaths: string[] = [];
  const auxiliaryPaths: string[] = [];
  const unsupportedRelationships: string[] = [];
  const unsupportedSettings: string[] = [...workbookPart.unsupportedSettings];
  const worksheetTables: WorkbookModel["worksheets"][number]["tables"][] = [];
  for (const [sheetOrder, descriptor] of workbookPart.sheets.entries()) {
    const relation = relationshipById.get(descriptor.relationId);
    if (!relation) {
      throw new XlsbParseError(
        "xl/workbook.bin",
        `sheet ${descriptor.name} references missing relationship ${descriptor.relationId}`
      );
    }
    const path = resolveRelationshipTarget("xl/workbook.bin", relation.target);
    if (relation.type.endsWith("/chartsheet")) {
      parsed._chartsheets.push({
        sheetNo: parsed._chartsheets.length + 1,
        name: descriptor.name,
        id: descriptor.sheetId,
        orderNo: sheetOrder,
        rId: descriptor.relationId,
        state: descriptor.state
      });
      continue;
    }
    if (!relation.type.endsWith("/worksheet")) {
      throw new XlsbParseError(
        "xl/workbook.bin",
        `sheet ${descriptor.name} uses unsupported relationship type ${relation.type}`
      );
    }
    const sheetPart = findPart(files, path);
    const actualPath = sheetPart?.path ?? path;
    worksheetPaths.push(actualPath);
    const relationshipsPath = relationshipPartPath(actualPath);
    const worksheetRelationships = parseRelationshipsOptional(
      findPart(files, relationshipsPath)?.data
    );
    if (worksheetRelationships.length > 0) {
      worksheetRelationshipPaths.push(relationshipsPath);
    }
    const hyperlinkTargets = new Map(
      worksheetRelationships
        .filter(worksheetRelationship => worksheetRelationship.type.endsWith("/hyperlink"))
        .map(worksheetRelationship => [worksheetRelationship.id, worksheetRelationship.target])
    );
    const commentsRelationship = worksheetRelationships.find(worksheetRelationship =>
      worksheetRelationship.type.endsWith("/comments")
    );
    const vmlRelationship = worksheetRelationships.find(worksheetRelationship =>
      worksheetRelationship.type.endsWith("/vmlDrawing")
    );
    unsupportedRelationships.push(
      ...worksheetRelationships
        .filter(
          worksheetRelationship =>
            !worksheetRelationship.type.endsWith("/hyperlink") &&
            !worksheetRelationship.type.endsWith("/table") &&
            !(
              commentsRelationship &&
              (worksheetRelationship === commentsRelationship ||
                worksheetRelationship === vmlRelationship)
            )
        )
        .map(worksheetRelationship => `${relationshipsPath}:${worksheetRelationship.type}`)
    );
    const sheetBytes = sheetPart?.data;
    if (!sheetBytes) {
      throw new XlsbParseError("XLSB package", `missing worksheet part ${path}`);
    }
    const worksheet = addWorksheet(parsed, descriptor.name, {
      state: descriptor.state as WorksheetState
    });
    worksheet.orderNo = sheetOrder;
    const tableParts = discoveredTables.get(sheetOrder) ?? [];
    const tableModels: WorkbookModel["worksheets"][number]["tables"] = [];
    for (const tablePart of tableParts) {
      auxiliaryPaths.push(tablePart.path);
      const table = parseTablePart(tablePart.data, {
        ...baseFormulaContext,
        currentSheetIndex: sheetOrder,
        tables: formulaTables
      });
      tableModels.push(table.model);
      unsupportedRecords.push(
        ...table.unsupportedRecordTypes.map(type => unsupportedRecord(tablePart.path, type))
      );
      unsupportedSettings.push(
        ...table.unsupportedSettings.map(setting => `${descriptor.name}: ${setting}`)
      );
    }
    const result = parseWorksheetPart(
      worksheet,
      sheetBytes,
      sharedStrings,
      styleTable,
      workbookPart.date1904,
      { ...baseFormulaContext, currentSheetIndex: sheetOrder, tables: formulaTables },
      options,
      { hyperlinkTargets }
    );
    cachedFormulaCount += result.cachedFormulaCount;
    unsupportedRecords.push(
      ...result.unsupportedRecordTypes.map(type => unsupportedRecord(actualPath, type))
    );
    unsupportedSettings.push(
      ...result.unsupportedSettings.map(setting => `${descriptor.name}: ${setting}`)
    );
    if (
      result.tableRelationIds.length !== tableParts.length ||
      result.tableRelationIds.some(
        (relationId, index) => relationId !== tableParts[index]?.relationId
      )
    ) {
      throw new XlsbParseError(
        "XLSB package",
        `worksheet ${descriptor.name} table references changed during parsing`
      );
    }
    worksheetTables.push(tableModels);
    if (commentsRelationship) {
      const commentsPath = resolveRelationshipTarget(actualPath, commentsRelationship.target);
      const commentsPart = findPart(files, commentsPath);
      if (!commentsPart) {
        throw new XlsbParseError("XLSB package", `missing comments part ${commentsPath}`);
      }
      auxiliaryPaths.push(commentsPart.path);
      const comments = parseCommentsPart(commentsPart.data, styleTable);
      unsupportedRecords.push(
        ...comments.unsupportedRecordTypes.map(type => unsupportedRecord(commentsPart.path, type))
      );
      const linkedVmlRelationship = result.legacyDrawingRelationId
        ? worksheetRelationships.find(
            worksheetRelationship => worksheetRelationship.id === result.legacyDrawingRelationId
          )
        : vmlRelationship;
      if (result.legacyDrawingRelationId && !linkedVmlRelationship?.type.endsWith("/vmlDrawing")) {
        throw new XlsbParseError(
          "XLSB package",
          `worksheet ${descriptor.name} references missing VML relationship ${result.legacyDrawingRelationId}`
        );
      }
      let vmlBytes: Uint8Array | undefined;
      if (linkedVmlRelationship) {
        const vmlPath = resolveRelationshipTarget(actualPath, linkedVmlRelationship.target);
        const vmlPart = findPart(files, vmlPath);
        if (!vmlPart) {
          throw new XlsbParseError("XLSB package", `missing VML drawing part ${vmlPath}`);
        }
        auxiliaryPaths.push(vmlPart.path);
        vmlBytes = vmlPart.data;
      }
      await applyCommentsToWorksheet(worksheet, comments, vmlBytes);
    }
  }

  const parsedModel = getWorkbookModel(parsed);
  const themePart = findPart(files, "xl/theme/theme1.xml");
  if (themePart) {
    parsedModel.themes = { theme1: decodeBytesToString(themePart.data) };
  }
  parsedModel.definedNames = workbookPart.definedNames;
  parsedModel.calcProperties = workbookPart.calcProperties;
  parsedModel.protection = workbookPart.protection;
  parsedModel.cellStyles = styleTable.namedStyles;
  parsedModel.worksheets.forEach((worksheet, index) => {
    worksheet.tables = worksheetTables[index] ?? [];
  });
  setWorkbookModel(workbook, parsedModel);
  loadedXlsbState.set(workbook, {
    cachedFormulaCount,
    unsupportedFormatting:
      styleTable.hasUnsupportedFormatting || sharedStringTable.hasUnsupportedFormatting,
    unsupportedParts: [
      ...findUnsupportedParts(files, worksheetPaths, worksheetRelationshipPaths, auxiliaryPaths),
      ...unsupportedRelationships
    ].sort(),
    unsupportedRecords,
    unsupportedSettings,
    originalBytes: bytes.slice(),
    modelSnapshot: structuredClone(getWorkbookModel(workbook))
  });
  return workbook;
}

export async function writeXlsbBytes(
  workbook: WorkbookData,
  options: XlsbWriteOptions = {}
): Promise<Uint8Array> {
  const passthrough = originalXlsbIfUnchanged(workbook, options);
  if (passthrough) {
    return passthrough;
  }
  return buildXlsbArchive(workbook, options).bytes();
}

export function streamXlsb(
  workbook: WorkbookData,
  options: XlsbWriteOptions = {}
): AsyncIterable<Uint8Array> {
  const passthrough = originalXlsbIfUnchanged(workbook, options);
  if (passthrough) {
    return singleChunk(passthrough);
  }
  return buildXlsbArchive(workbook, options).stream();
}

export async function pipeXlsb(
  workbook: WorkbookData,
  sink: ArchiveSink,
  options: XlsbWriteOptions = {}
): Promise<void> {
  await pipeIterableToSink(streamXlsb(workbook, options), sink);
}

export async function collectXlsbInput(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    chunks.push(bytes);
    length += bytes.length;
  }
  return concatUint8Arrays(chunks, length);
}

function buildXlsbArchive(workbook: WorkbookData, options: XlsbWriteOptions): ZipArchive {
  const model = getWorkbookModel(workbook);
  validateWorkbookForWrite(model, loadedXlsbState.get(workbook), options);
  const workbookThemeXml = resolveThemeXml(model.themes, options.unsupported ?? "error");

  const sharedStrings = createSharedStrings();
  const styles = createStyleRegistry(model.defaultFont, model.cellStyles);
  const worksheets = model.worksheets;
  const worksheetComments = worksheets.map(collectWorksheetComments);
  const descriptors: XlsbSheetDescriptor[] = worksheets.map((worksheet, index) => ({
    name: worksheet.name,
    relationId: `rId${index + 1}`,
    sheetId: worksheet.id,
    state: worksheet.state
  }));
  const tableIds = new Map<WorkbookModel["worksheets"][number]["tables"][number], number>();
  const formulaTables = worksheets.flatMap((worksheet, sheetIndex) =>
    worksheet.tables.map(table => {
      const id = tableIds.size + 1;
      tableIds.set(table, id);
      return {
        id,
        name: table.name,
        sheetIndex,
        range: table.tableRef ?? table.ref,
        columns: table.columns.map(column => column.name)
      };
    })
  );
  const formulaContext = {
    sheetNames: descriptors.map(sheet => sheet.name),
    externalSheets: descriptors.map((_sheet, index) => ({
      externalLink: 0,
      firstSheet: index,
      lastSheet: index
    })),
    tables: formulaTables,
    definedNames: model.definedNames
  };
  const worksheetRelationships: Relationship[][] = [];
  const tableParts: { partNumber: number; bytes: Uint8Array }[] = [];
  const sheetParts = worksheets.map((worksheet, worksheetIndex) => {
    const configuredViews = worksheet.views?.length ? worksheet.views : [{ state: "normal" }];
    const views = configuredViews.map(view => {
      const workbookViewId = view.workbookViewId ?? 0;
      const activeTab = model.views[workbookViewId]?.activeTab ?? 0;
      return {
        ...view,
        workbookViewId,
        tabSelected: view.tabSelected ?? activeTab === worksheetIndex
      };
    });
    const sheetRelationships: Relationship[] = [];
    const comments = worksheetComments[worksheetIndex]!;
    let legacyDrawingRelationId: string | undefined;
    if (comments.length > 0) {
      sheetRelationships.push({
        id: "rId1",
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
        target: `../comments${worksheetIndex + 1}.bin`
      });
      legacyDrawingRelationId = "rId2";
      sheetRelationships.push({
        id: legacyDrawingRelationId,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing",
        target: `../drawings/vmlDrawing${worksheetIndex + 1}.vml`
      });
    }
    const tableRelationIds = worksheet.tables.map(table => {
      const partNumber = tableParts.length + 1;
      const id = `rId${sheetRelationships.length + 1}`;
      sheetRelationships.push({
        id,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table",
        target: `../tables/table${partNumber}.bin`
      });
      tableParts.push({
        partNumber,
        bytes: writeTablePart(
          table,
          tableIds.get(table)!,
          { ...formulaContext, currentSheetIndex: worksheetIndex },
          options.unsupported
        )
      });
      return id;
    });
    const hyperlinkIds = new Map<string, string>();
    worksheetRelationships.push(sheetRelationships);
    return writeWorksheetPart(
      { ...worksheet, views },
      sharedStrings,
      styles,
      model.properties.date1904 === true,
      { ...formulaContext, currentSheetIndex: worksheetIndex },
      options,
      {
        legacyDrawingRelationId,
        tableRelationIds,
        addHyperlink(target) {
          const existing = hyperlinkIds.get(target);
          if (existing) {
            return existing;
          }
          const id = `rId${sheetRelationships.length + 1}`;
          sheetRelationships.push({
            id,
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            target,
            targetMode: "External"
          });
          hyperlinkIds.set(target, id);
          return id;
        }
      }
    );
  });
  const commentParts = worksheetComments.map(comments =>
    comments.length > 0
      ? {
          comments: writeCommentsPart(comments, styles, options.unsupported),
          vml: writeCommentsVml(comments)
        }
      : undefined
  );
  const sharedStringsPart =
    sharedStrings.values.length > 0 ? writeSharedStrings(sharedStrings, styles) : undefined;

  const archive = new ZipArchive({
    level: options.zip?.level,
    modTime: options.zip?.modTime,
    reproducible: options.zip?.reproducible
  });
  archive.add(
    "[Content_Types].xml",
    utf8(
      contentTypesXml(
        worksheets.length,
        sharedStrings.values.length > 0,
        worksheetComments.flatMap((comments, index) => (comments.length > 0 ? [index + 1] : [])),
        tableParts.length
      )
    )
  );
  archive.add("_rels/.rels", utf8(rootRelationshipsXml()));
  archive.add(
    "docProps/app.xml",
    utf8(
      appPropertiesXml(
        descriptors.map(sheet => sheet.name),
        model.company,
        model.manager
      )
    )
  );
  archive.add("docProps/core.xml", utf8(corePropertiesXml(model)));
  archive.add(
    "xl/workbook.bin",
    writeWorkbookPart(
      descriptors,
      model.properties.date1904 === true,
      model.views,
      model.definedNames,
      model.protection,
      model.calcProperties,
      options.unsupported
    )
  );
  archive.add(
    "xl/_rels/workbook.bin.rels",
    utf8(workbookRelationshipsXml(worksheets.length, sharedStrings.values.length > 0))
  );
  archive.add("xl/styles.bin", writeStyles(styles));
  archive.add("xl/theme/theme1.xml", utf8(workbookThemeXml));
  sheetParts.forEach((part, index) => archive.add(`xl/worksheets/sheet${index + 1}.bin`, part));
  worksheetRelationships.forEach((relationships, index) => {
    if (relationships.length > 0) {
      archive.add(
        `xl/worksheets/_rels/sheet${index + 1}.bin.rels`,
        utf8(relationshipsXml(relationships))
      );
    }
  });
  commentParts.forEach((part, index) => {
    if (!part) {
      return;
    }
    archive.add(`xl/comments${index + 1}.bin`, part.comments);
    archive.add(`xl/drawings/vmlDrawing${index + 1}.vml`, part.vml);
  });
  tableParts.forEach(part => archive.add(`xl/tables/table${part.partNumber}.bin`, part.bytes));
  if (sharedStringsPart) {
    archive.add("xl/sharedStrings.bin", sharedStringsPart);
  }
  return archive;
}

function originalXlsbIfUnchanged(
  workbook: WorkbookData,
  options: XlsbWriteOptions
): Uint8Array | undefined {
  const state = loadedXlsbState.get(workbook);
  if (!state || options.zip || !modelsEqual(getWorkbookModel(workbook), state.modelSnapshot)) {
    return undefined;
  }
  return state.originalBytes.slice();
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function modelsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
      return false;
    }
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => modelsEqual(value, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      key => Object.hasOwn(rightObject, key) && modelsEqual(leftObject[key], rightObject[key])
    )
  );
}

function validateWorkbookForWrite(
  model: WorkbookModel,
  loadState: XlsbLoadState | undefined,
  options: XlsbWriteOptions
): void {
  if ((options.unsupported ?? "error") === "ignore") {
    return;
  }
  const unsupported: string[] = [];
  if (loadState?.cachedFormulaCount) {
    unsupported.push(`${loadState.cachedFormulaCount} formula(s) loaded as cached values`);
  }
  if (loadState?.unsupportedFormatting) {
    unsupported.push("loaded style flags that have no Workbook model representation");
  }
  if (loadState?.unsupportedParts.length) {
    unsupported.push(`loaded package parts: ${loadState.unsupportedParts.join(", ")}`);
  }
  if (loadState?.unsupportedRecords.length) {
    unsupported.push(`loaded BIFF12 records: ${loadState.unsupportedRecords.join(", ")}`);
  }
  if (loadState?.unsupportedSettings.length) {
    unsupported.push(`loaded XLSB settings: ${loadState.unsupportedSettings.join(", ")}`);
  }
  addFeature(unsupported, model.media.length, "workbook media");
  addFeature(unsupported, model.pivotTables.length, "workbook pivot tables");
  addFeature(unsupported, model.externalLinks?.length, "external links");
  addFeature(unsupported, model.chartsheets?.length, "chartsheets");
  addFeature(unsupported, model.persons?.length, "threaded-comment people");

  for (const worksheet of model.worksheets) {
    const prefix = `worksheet ${worksheet.name}`;
    addFeature(unsupported, worksheet.pivotTables.length, `${prefix} pivot tables`);
    addFeature(
      unsupported,
      worksheet.conditionalFormattings.length,
      `${prefix} conditional formatting`
    );
    addFeature(unsupported, worksheet.media.length, `${prefix} drawings/media`);
    addFeature(unsupported, worksheet.shapes?.length, `${prefix} shapes`);
    addFeature(unsupported, worksheet.charts?.length, `${prefix} charts`);
    addFeature(unsupported, worksheet.sparklineGroups?.length, `${prefix} sparklines`);
    addFeature(unsupported, worksheet.threadedComments?.length, `${prefix} threaded comments`);
    addFeature(unsupported, worksheet.formControls.length, `${prefix} form controls`);
    addFeature(unsupported, worksheet.watermark, `${prefix} watermark`);
  }

  if (unsupported.length > 0) {
    throw new ExcelNotSupportedError(
      "Write XLSB workbook",
      `${unsupported.join("; ")}. Pass unsupported: "ignore" to opt into lossy output`
    );
  }
}

function unsupportedRecord(part: string, type: number): string {
  return `${part}#${type} (0x${type.toString(16).toUpperCase()})`;
}

function addFeature(target: string[], value: unknown, label: string): void {
  if (value) {
    target.push(label);
  }
}

function findPart(
  files: ReadonlyMap<string, Uint8Array>,
  path: string
): { path: string; data: Uint8Array } | undefined {
  const exact = files.get(path);
  if (exact) {
    return { path, data: exact };
  }
  const normalized = path.toLowerCase();
  for (const [candidate, data] of files) {
    if (candidate.toLowerCase() === normalized) {
      return { path: candidate, data };
    }
  }
  return undefined;
}

function findUnsupportedParts(
  files: ReadonlyMap<string, Uint8Array>,
  worksheetPaths: readonly string[],
  worksheetRelationshipPaths: readonly string[],
  auxiliaryPaths: readonly string[] = []
): string[] {
  const supported = new Set(
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "xl/workbook.bin",
      "xl/_rels/workbook.bin.rels",
      "xl/sharedStrings.bin",
      "xl/styles.bin",
      "xl/theme/theme1.xml",
      ...worksheetPaths,
      ...worksheetRelationshipPaths,
      ...auxiliaryPaths
    ].map(path => path.toLowerCase())
  );
  const unsupported: string[] = [];
  for (const path of files.keys()) {
    if (path.endsWith("/") || supported.has(path.toLowerCase())) {
      continue;
    }
    unsupported.push(path);
  }
  return unsupported.sort();
}

function resolveThemeXml(themes: unknown, unsupported: "error" | "ignore"): string {
  if (themes === undefined) {
    return theme1Xml;
  }
  if (themes && typeof themes === "object" && !Array.isArray(themes)) {
    const entries = Object.entries(themes);
    const theme = entries.find(([name]) => name === "theme1")?.[1];
    if (typeof theme === "string" && entries.every(([name]) => name === "theme1")) {
      return theme;
    }
  }
  if (unsupported === "ignore") {
    return theme1Xml;
  }
  throw new ExcelNotSupportedError(
    "Write XLSB workbook theme",
    "only a string-valued theme1 entry can be represented"
  );
}

function normalizeInput(
  input: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  options: XlsbReadOptions
): Uint8Array {
  if (typeof input === "string") {
    if (!options.base64) {
      throw new XlsbParseError("XLSB input", "string input requires options.base64 === true");
    }
    return base64ToUint8Array(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new XlsbParseError("XLSB input", "unsupported input type");
}

function parseRelationships(bytes: Uint8Array | undefined): Relationship[] {
  if (!bytes) {
    throw new XlsbParseError("XLSB package", "missing xl/_rels/workbook.bin.rels");
  }
  return parseRelationshipsXml(bytes);
}

function parseRelationshipsOptional(bytes: Uint8Array | undefined): Relationship[] {
  return bytes ? parseRelationshipsXml(bytes) : [];
}

function parseRelationshipsXml(bytes: Uint8Array): Relationship[] {
  const document = parseXml(decodeBytesToString(bytes));
  return findChildren(document.root, "Relationship").map(element => ({
    id: attr(element, "Id") ?? "",
    type: attr(element, "Type") ?? "",
    target: attr(element, "Target") ?? "",
    targetMode: attr(element, "TargetMode")
  }));
}

function relationshipPartPath(sourcePart: string): string {
  const slash = sourcePart.lastIndexOf("/");
  const directory = slash < 0 ? "" : sourcePart.slice(0, slash + 1);
  const name = sourcePart.slice(slash + 1);
  return `${directory}_rels/${name}.rels`;
}

function resolveRelationshipTarget(sourcePart: string, target: string): string {
  if (target.startsWith("/")) {
    return normalizePath(target.slice(1));
  }
  const slash = sourcePart.lastIndexOf("/");
  return normalizePath(`${slash < 0 ? "" : sourcePart.slice(0, slash + 1)}${target}`);
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function applyCoreProperties(workbook: WorkbookData, bytes: Uint8Array | undefined): void {
  if (!bytes) {
    return;
  }
  const document = parseXml(decodeBytesToString(bytes));
  for (const child of document.root.children) {
    if (child.type !== "element") {
      continue;
    }
    const value = textContent(child);
    switch (child.name) {
      case "dc:creator":
        workbook.creator = value;
        break;
      case "cp:lastModifiedBy":
        workbook.lastModifiedBy = value;
        break;
      case "dc:title":
        workbook.title = value;
        break;
      case "dc:subject":
        workbook.subject = value;
        break;
      case "dc:description":
        workbook.description = value;
        break;
      case "cp:keywords":
        workbook.keywords = value;
        break;
      case "cp:category":
        workbook.category = value;
        break;
      case "dcterms:created":
        workbook.created = new Date(value);
        break;
      case "dcterms:modified":
        workbook.modified = new Date(value);
        break;
    }
  }
}

function applyAppProperties(workbook: WorkbookData, bytes: Uint8Array | undefined): void {
  if (!bytes) {
    return;
  }
  const document = parseXml(decodeBytesToString(bytes));
  for (const child of document.root.children) {
    if (child.type !== "element") {
      continue;
    }
    switch (child.name) {
      case "Company":
        workbook.company = textContent(child);
        break;
      case "Manager":
        workbook.manager = textContent(child);
        break;
    }
  }
}

function contentTypesXml(
  sheetCount: number,
  hasSharedStrings: boolean,
  commentSheetIndexes: readonly number[] = [],
  tableCount = 0
): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.bin" ContentType="application/vnd.ms-excel.worksheet"/>`
  ).join("");
  const shared = hasSharedStrings
    ? '<Override PartName="/xl/sharedStrings.bin" ContentType="application/vnd.ms-excel.sharedStrings"/>'
    : "";
  const vml = commentSheetIndexes.length
    ? '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>'
    : "";
  const comments = commentSheetIndexes
    .map(
      index =>
        `<Override PartName="/xl/comments${index}.bin" ContentType="application/vnd.ms-excel.comments"/>`
    )
    .join("");
  const tables = Array.from(
    { length: tableCount },
    (_, index) =>
      `<Override PartName="/xl/tables/table${index + 1}.bin" ContentType="application/vnd.ms-excel.table"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${vml}<Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override PartName="/xl/styles.bin" ContentType="application/vnd.ms-excel.styles"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${shared}${sheets}${comments}${tables}</Types>`;
}

function rootRelationshipsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
}

function workbookRelationshipsXml(sheetCount: number, hasSharedStrings: boolean): string {
  const relationships: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    relationships.push(
      `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.bin"/>`
    );
  }
  let next = sheetCount + 1;
  if (hasSharedStrings) {
    relationships.push(
      `<Relationship Id="rId${next++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.bin"/>`
    );
  }
  relationships.push(
    `<Relationship Id="rId${next++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.bin"/>`
  );
  relationships.push(
    `<Relationship Id="rId${next}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`;
}

function relationshipsXml(relationships: readonly Relationship[]): string {
  const entries = relationships
    .map(
      relationship =>
        `<Relationship Id="${xmlEncodeAttr(relationship.id)}" Type="${xmlEncodeAttr(relationship.type)}" Target="${xmlEncodeAttr(relationship.target)}"${relationship.targetMode ? ` TargetMode="${xmlEncodeAttr(relationship.targetMode)}"` : ""}/>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

function appPropertiesXml(sheetNames: readonly string[], company: string, manager: string): string {
  const names = sheetNames.map(name => `<vt:lpstr>${xmlEncode(name)}</vt:lpstr>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>documonster</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${names}</vt:vector></TitlesOfParts><Company>${xmlEncode(company)}</Company><Manager>${xmlEncode(manager)}</Manager></Properties>`;
}

function corePropertiesXml(model: ReturnType<typeof getWorkbookModel>): string {
  const created = model.created.toISOString();
  const modified = model.modified.toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${xmlEncode(model.creator ?? "Unknown")}</dc:creator><cp:lastModifiedBy>${xmlEncode(model.lastModifiedBy ?? "Unknown")}</cp:lastModifiedBy><dc:title>${xmlEncode(model.title)}</dc:title><dc:subject>${xmlEncode(model.subject)}</dc:subject><dc:description>${xmlEncode(model.description)}</dc:description><cp:keywords>${xmlEncode(model.keywords)}</cp:keywords><cp:category>${xmlEncode(model.category)}</cp:category><dcterms:created xsi:type="dcterms:W3CDTF">${xmlEncodeAttr(created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xmlEncodeAttr(modified)}</dcterms:modified></cp:coreProperties>`;
}

function utf8(value: string): Uint8Array {
  return stringToUint8Array(value);
}
