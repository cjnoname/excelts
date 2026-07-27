import {
  applyChartCachePlan,
  applyChartExCachePlan,
  buildChartCachePlan,
  buildChartExCachePlan,
  buildChartCachePlanForReferences,
  collectChartReferencedCells
} from "@excel/chart/build/cache-populator";
import type {
  ChartDataSnapshot,
  ChartDefinedNameSnapshot,
  ChartTableSnapshot,
  ChartWorksheetSnapshot
} from "@excel/chart/core/chart-data-snapshot";
import { chartSnapshotCellKey } from "@excel/chart/core/chart-data-snapshot";
import type { ChartExModel } from "@excel/chart/model/chart-ex-types";
import type {
  ChartModel,
  MultiLevelStringReference,
  NumberReference,
  StringReference
} from "@excel/chart/model/types";
import { cellGetValue } from "@excel/core/cell";
import { definedNamesGetAllEntries } from "@excel/core/defined-names";
import { tableDisplayName, tableModel, tableName } from "@excel/core/table";
import type { WorkbookData } from "@excel/core/workbook-core";
import { getWorksheets } from "@excel/core/workbook-core";
import type { WorksheetData } from "@excel/core/worksheet-core";
import { eachRow, findCell, getSheetName, getTables } from "@excel/core/worksheet-core";

export function captureChartDataSnapshot(
  workbook: WorkbookData,
  contextWorksheet?: WorksheetData,
  references?: readonly string[]
): ChartDataSnapshot {
  const hostWorksheets = getWorksheets(workbook);
  const definedNames: ChartDefinedNameSnapshot[] = workbook._definedNames
    ? definedNamesGetAllEntries(workbook._definedNames).map(entry => ({
        name: entry.name,
        ranges: [...entry.ranges],
        localSheetId: entry.localSheetId
      }))
    : [];
  const contextSheetName = contextWorksheet ? getSheetName(contextWorksheet) : undefined;
  const contextLocalSheetId = contextWorksheet
    ? (contextWorksheet.orderNo ?? hostWorksheets.indexOf(contextWorksheet))
    : undefined;
  const worksheetMetadata: ChartWorksheetSnapshot[] = hostWorksheets.map(worksheet => ({
    name: getSheetName(worksheet),
    orderNo: worksheet.orderNo,
    cells: new Map(),
    tables: captureTables(worksheet)
  }));
  const metadataSnapshot = buildSnapshot(worksheetMetadata);
  const requestedCells = references
    ? collectChartReferencedCells(references, metadataSnapshot)
    : undefined;
  const worksheets: ChartWorksheetSnapshot[] = hostWorksheets.map((worksheet, index) => {
    const cells = new Map<string, unknown>();
    const requested = requestedCells?.get(getSheetName(worksheet).toLowerCase());
    if (requestedCells) {
      for (const key of requested ?? []) {
        const [row, col] = key.split(":").map(Number);
        const cell = findCell(worksheet, row, col);
        if (cell) {
          cells.set(key, normalizeCellValue(cellGetValue(cell)));
        }
      }
    } else {
      eachRow(worksheet, row => {
        row.cells.forEach((cell, index) => {
          if (cell) {
            cells.set(
              chartSnapshotCellKey(row.number, index + 1),
              normalizeCellValue(cellGetValue(cell))
            );
          }
        });
      });
    }
    return {
      ...worksheetMetadata[index],
      cells
    };
  });
  return buildSnapshot(worksheets);

  function buildSnapshot(sheets: ChartWorksheetSnapshot[]): ChartDataSnapshot {
    return {
      worksheets: sheets,
      worksheetsByName: new Map(
        sheets.map(worksheet => [worksheet.name.toLowerCase(), worksheet] as const)
      ),
      definedNames,
      date1904: workbook.properties?.date1904 ?? false,
      contextSheetName,
      contextLocalSheetId:
        contextLocalSheetId !== undefined && contextLocalSheetId >= 0
          ? contextLocalSheetId
          : undefined
    };
  }
}

function captureTables(worksheet: WorksheetData): ChartTableSnapshot[] {
  return getTables(worksheet).map(table => {
    const model = tableModel(table);
    return {
      name: tableName(table),
      displayName: tableDisplayName(table),
      ref: model.tableRef ?? model.ref,
      columns: model.columns.map(column => column.name),
      headerRow: model.headerRow !== false,
      totalsRow: model.totalsRow === true
    };
  });
}

export function fillChartCaches(
  model: ChartModel,
  workbook: WorkbookData,
  contextWorksheet?: WorksheetData
): void {
  applyChartCachePlan(
    buildChartCachePlan(
      model,
      captureChartDataSnapshot(workbook, contextWorksheet, collectChartFormulaReferences(model))
    )
  );
}

export function fillChartExCaches(
  model: ChartExModel,
  workbook: WorkbookData,
  contextWorksheet?: WorksheetData
): void {
  applyChartExCachePlan(
    buildChartExCachePlan(
      model,
      captureChartDataSnapshot(workbook, contextWorksheet, collectChartFormulaReferences(model))
    )
  );
}

export function fillChartExCachesForRendering(
  model: ChartExModel,
  workbook: WorkbookData,
  contextWorksheet?: WorksheetData
): void {
  applyChartExCachePlan(
    buildChartExCachePlan(
      model,
      captureChartDataSnapshot(workbook, contextWorksheet, collectChartFormulaReferences(model)),
      { includeSkippedDimensions: true }
    )
  );
}

export function fillNumRef(
  ref: NumberReference,
  workbook: WorkbookData,
  date1904?: boolean,
  contextWorksheet?: WorksheetData
): void {
  const snapshot = captureChartDataSnapshot(
    workbook,
    contextWorksheet,
    ref.formula ? [ref.formula] : []
  );
  applyChartCachePlan(
    buildChartCachePlanForReferences(
      { number: ref },
      {
        ...snapshot,
        date1904: date1904 ?? snapshot.date1904
      }
    )
  );
}

export function fillStrRef(
  ref: StringReference,
  workbook: WorkbookData,
  contextWorksheet?: WorksheetData
): void {
  applyChartCachePlan(
    buildChartCachePlanForReferences(
      { string: ref },
      captureChartDataSnapshot(workbook, contextWorksheet, ref.formula ? [ref.formula] : [])
    )
  );
}

export function fillMultiLvlStrRef(
  ref: MultiLevelStringReference,
  workbook: WorkbookData,
  contextWorksheet?: WorksheetData
): void {
  applyChartCachePlan(
    buildChartCachePlanForReferences(
      { multiLevelString: ref },
      captureChartDataSnapshot(workbook, contextWorksheet, ref.formula ? [ref.formula] : [])
    )
  );
}

export function collectChartFormulaReferences(model: unknown): string[] {
  const formulas = new Set<string>();
  visit(model);
  return [...formulas];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "formula" && typeof child === "string") {
          formulas.add(child);
        } else {
          visit(child);
        }
      }
    }
  }
}

function normalizeCellValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "object" && "result" in value) {
    return normalizeCellValue((value as { result?: unknown }).result);
  }
  if (typeof value === "object" && "richText" in value) {
    return (value as { richText?: Array<{ text?: string }> }).richText
      ?.map(run => run.text ?? "")
      .join("");
  }
  if (typeof value === "object" && "error" in value) {
    return undefined;
  }
  if (typeof value === "object" && "text" in value && "hyperlink" in value) {
    return (value as { text?: unknown }).text;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}
