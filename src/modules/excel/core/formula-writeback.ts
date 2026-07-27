import type { CellModel, FormulaResult } from "@excel/core/cell";
import {
  cellGetModel,
  cellSetModel,
  cellSetResult,
  cellSetValue,
  cellType
} from "@excel/core/cell";
import { Enums } from "@excel/core/enums";
import type { WorkbookData } from "@excel/core/workbook-core";
import { getWorksheet } from "@excel/core/workbook.browser";
import type { WorksheetData } from "@excel/core/worksheet";
import { findCell, findRow, getCell } from "@excel/core/worksheet";
import type { CellErrorValue } from "@excel/types";
import type {
  CellSnapshot,
  SnapshotCellValue,
  SnapshotErrorValue,
  WorkbookSnapshot,
  WorksheetSnapshot
} from "@formula/integration/workbook-snapshot";
import { spillCellKeyFromId } from "@formula/integration/workbook-snapshot";
import type {
  CleanupWrite,
  CSEWrite,
  ScalarWrite,
  SpillErrorWrite,
  SpillWrite,
  WriteOperation,
  WritebackPlan
} from "@formula/materialize/writeback-plan";

/** Apply an engine writeback plan to an Excel workbook. */
export function applyFormulaWriteback(
  wb: WorkbookData,
  plan: WritebackPlan,
  captured: WorkbookSnapshot,
  current: WorkbookSnapshot,
  hooks?: { afterOperation?: (operation: WriteOperation, index: number) => void }
): void {
  validateWriteback(wb, plan, captured, current);
  const journal = captureWritebackJournal(wb, plan);
  try {
    for (let index = 0; index < plan.operations.length; index++) {
      const operation = plan.operations[index];
      applyOperation(wb, operation);
      hooks?.afterOperation?.(operation, index);
    }
  } catch (error) {
    rollbackWriteback(wb, journal);
    throw error;
  }
}

interface JournalEntry {
  readonly sheetId: number;
  readonly row: number;
  readonly col: number;
  readonly model?: CellModel;
  readonly ghostOwner?: string;
}

function captureWritebackJournal(wb: WorkbookData, plan: WritebackPlan): JournalEntry[] {
  const targets = new Map<string, { sheetId: number; row: number; col: number }>();
  function add(sheetId: number, row: number, col: number): void {
    targets.set(`${sheetId}:${row}:${col}`, { sheetId, row, col });
  }
  for (const operation of plan.operations) {
    const ws =
      "sheetId" in operation
        ? worksheetById(wb, operation.sheetId)
        : worksheetByName(wb, operation.sheetName);
    if (!ws) {
      continue;
    }
    if (operation.type === "cse") {
      for (let row = operation.top; row <= operation.bottom; row++) {
        for (let col = operation.left; col <= operation.right; col++) {
          add(ws.id, row, col);
        }
      }
    } else if (operation.type === "spill") {
      for (let r = 0; r < operation.results.length; r++) {
        for (let c = 0; c < (operation.results[r]?.length ?? 0); c++) {
          add(ws.id, operation.row + r, operation.col + c);
        }
      }
    } else if (operation.type === "cleanup") {
      for (const cell of operation.cells) {
        add(ws.id, cell.row, cell.col);
      }
    } else {
      add(ws.id, operation.row, operation.col);
    }
  }
  return [...targets.values()].map(target => {
    const ws = worksheetById(wb, target.sheetId)!;
    const cell = findCell(ws, target.row, target.col);
    return {
      ...target,
      model: cell ? structuredClone(cellGetModel(cell)) : undefined,
      ghostOwner: cell?._formulaGhostOwner
    };
  });
}

function rollbackWriteback(wb: WorkbookData, journal: readonly JournalEntry[]): void {
  for (const entry of journal) {
    const ws = worksheetById(wb, entry.sheetId);
    if (!ws) {
      continue;
    }
    if (entry.model) {
      const cell = getCell(ws, entry.row, entry.col);
      cellSetModel(cell, structuredClone(entry.model));
      cell._formulaGhostOwner = entry.ghostOwner;
    } else {
      const row = findRow(ws, entry.row);
      if (row) {
        row.cells[entry.col - 1] = undefined!;
      }
    }
  }
}

function validateWriteback(
  wb: WorkbookData,
  plan: WritebackPlan,
  captured: WorkbookSnapshot,
  current: WorkbookSnapshot
): void {
  // A single workbook-wide comparison subsumes per-target checks: if every
  // captured cell still matches, no plan target can have drifted.
  if (!snapshotsEqual(captured, current)) {
    throw new Error("Workbook changed during formula calculation");
  }
  for (const operation of plan.operations) {
    switch (operation.type) {
      case "scalar": {
        const ws = worksheetByName(wb, operation.sheetName);
        if (!ws || !findCell(ws, operation.row, operation.col)) {
          throw new Error(`Formula writeback target disappeared: ${operation.sheetName}`);
        }
        break;
      }
      case "cse": {
        const ws = worksheetByName(wb, operation.sheetName);
        if (!ws) {
          throw new Error(`Formula writeback worksheet disappeared: ${operation.sheetName}`);
        }
        if (
          operation.top < 1 ||
          operation.left < 1 ||
          operation.bottom > 1048576 ||
          operation.right > 16384 ||
          operation.top > operation.bottom ||
          operation.left > operation.right
        ) {
          throw new Error(`Formula CSE target is outside worksheet bounds: ${operation.sheetName}`);
        }
        break;
      }
      case "spill":
      case "spill-error": {
        const ws = worksheetById(wb, operation.sheetId);
        if (!ws || !findCell(ws, operation.row, operation.col)) {
          throw new Error(`Formula spill source disappeared: ${operation.sheetName}`);
        }
        if (
          operation.type === "spill" &&
          (operation.row + operation.results.length - 1 > 1048576 ||
            operation.col + (operation.results[0]?.length ?? 0) - 1 > 16384)
        ) {
          throw new Error(
            `Formula spill target is outside worksheet bounds: ${operation.sheetName}`
          );
        }
        break;
      }
      case "cleanup": {
        if (!worksheetById(wb, operation.sheetId)) {
          throw new Error(`Formula cleanup worksheet disappeared: ${operation.sheetName}`);
        }
        if (
          operation.cells.some(({ row, col }) => row < 1 || row > 1048576 || col < 1 || col > 16384)
        ) {
          throw new Error(
            `Formula cleanup target is outside worksheet bounds: ${operation.sheetName}`
          );
        }
        break;
      }
    }
  }
}

function snapshotsEqual(a: WorkbookSnapshot, b: WorkbookSnapshot): boolean {
  if (a === b) {
    // The host passed the same capture twice, meaning it already proved the
    // workbook could not have changed during calculation.
    return true;
  }
  if (
    a.worksheets.length !== b.worksheets.length ||
    a.properties.date1904 !== b.properties.date1904 ||
    a.calcProperties.fullCalcOnLoad !== b.calcProperties.fullCalcOnLoad ||
    a.calcProperties.iterate !== b.calcProperties.iterate ||
    a.calcProperties.iterateCount !== b.calcProperties.iterateCount ||
    a.calcProperties.iterateDelta !== b.calcProperties.iterateDelta ||
    a.definedNames.size !== b.definedNames.size
  ) {
    return false;
  }
  for (let index = 0; index < a.worksheets.length; index++) {
    const left = a.worksheets[index];
    const right = b.worksheets[index];
    if (!right || !worksheetsEqual(left, right)) {
      return false;
    }
  }
  for (const [key, left] of a.definedNames) {
    const right = b.definedNames.get(key);
    if (
      !right ||
      left.name !== right.name ||
      left.scope !== right.scope ||
      left.ranges.length !== right.ranges.length ||
      left.ranges.some((range, index) => range !== right.ranges[index])
    ) {
      return false;
    }
  }
  return true;
}

function worksheetsEqual(a: WorksheetSnapshot, b: WorksheetSnapshot): boolean {
  if (
    a.id !== b.id ||
    a.name !== b.name ||
    a.cells.size !== b.cells.size ||
    a.hiddenRows.size !== b.hiddenRows.size ||
    a.tables.length !== b.tables.length ||
    !regionsEqual(a, b) ||
    !dimensionsEqual(a.dimensions, b.dimensions)
  ) {
    return false;
  }
  for (const row of a.hiddenRows) {
    if (!b.hiddenRows.has(row)) {
      return false;
    }
  }
  for (const [key, left] of a.cells) {
    if (!cellsEqual(left, b.cells.get(key))) {
      return false;
    }
  }
  for (let index = 0; index < a.tables.length; index++) {
    const left = a.tables[index];
    const right = b.tables[index];
    if (
      !right ||
      left.name !== right.name ||
      left.topLeft.row !== right.topLeft.row ||
      left.topLeft.col !== right.topLeft.col ||
      left.dataRowCount !== right.dataRowCount ||
      left.hasHeaderRow !== right.hasHeaderRow ||
      left.hasTotalsRow !== right.hasTotalsRow ||
      left.columns.length !== right.columns.length ||
      left.columns.some((column, columnIndex) => column.name !== right.columns[columnIndex]?.name)
    ) {
      return false;
    }
  }
  return true;
}

function dimensionsEqual(
  a: WorksheetSnapshot["dimensions"],
  b: WorksheetSnapshot["dimensions"]
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
}

function cellsEqual(a: CellSnapshot | undefined, b: CellSnapshot | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.formulaKind === b.formulaKind &&
    a.formula === b.formula &&
    a.ref === b.ref &&
    a.isDynamicArray === b.isDynamicArray &&
    a.ghostOwner === b.ghostOwner &&
    valuesEqual(a.value, b.value)
  );
}

function valuesEqual(a: SnapshotCellValue, b: SnapshotCellValue): boolean {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return a.error === b.error;
  }
  return Object.is(a, b);
}

function regionsEqual(a: WorksheetSnapshot, b: WorksheetSnapshot): boolean {
  if (a.name !== b.name || a.mergedRegions.length !== b.mergedRegions.length) {
    return false;
  }
  return a.mergedRegions.every((region, index) => {
    const other = b.mergedRegions[index];
    return (
      other !== undefined &&
      region.top === other.top &&
      region.left === other.left &&
      region.bottom === other.bottom &&
      region.right === other.right
    );
  });
}

function applyOperation(wb: WorkbookData, operation: WriteOperation): void {
  switch (operation.type) {
    case "scalar":
      applyScalar(wb, operation);
      break;
    case "cse":
      applyCSE(wb, operation);
      break;
    case "spill":
      applySpill(wb, operation);
      break;
    case "spill-error":
      applySpillError(wb, operation);
      break;
    case "cleanup":
      applyCleanup(wb, operation);
      break;
  }
}

function worksheetByName(wb: WorkbookData, name: string): WorksheetData | undefined {
  return getWorksheet(wb, name);
}

function worksheetById(wb: WorkbookData, id: number): WorksheetData | undefined {
  return getWorksheet(wb, id);
}

function requireWorksheetByName(wb: WorkbookData, name: string): WorksheetData {
  const ws = worksheetByName(wb, name);
  if (!ws) {
    throw new Error(`Formula writeback worksheet disappeared: ${name}`);
  }
  return ws;
}

function requireWorksheetById(wb: WorkbookData, id: number, name: string): WorksheetData {
  const ws = worksheetById(wb, id);
  if (!ws) {
    throw new Error(`Formula writeback worksheet disappeared: ${name}`);
  }
  return ws;
}

function requireCell(ws: WorksheetData, row: number, col: number, name: string) {
  const cell = findCell(ws, row, col);
  if (!cell) {
    throw new Error(`Formula writeback target disappeared: ${name}!${row}:${col}`);
  }
  return cell;
}

function applyScalar(wb: WorkbookData, operation: ScalarWrite): void {
  const ws = requireWorksheetByName(wb, operation.sheetName);
  const cell = requireCell(ws, operation.row, operation.col, operation.sheetName);
  cellSetResult(cell, snapshotToResult(operation.value));
}

function applyCSE(wb: WorkbookData, operation: CSEWrite): void {
  const ws = requireWorksheetByName(wb, operation.sheetName);
  for (let r = operation.top; r <= operation.bottom; r++) {
    for (let c = operation.left; c <= operation.right; c++) {
      const cell = findCell(ws, r, c);
      if (!cell || cellType(cell) !== Enums.ValueType.Formula) {
        continue;
      }
      const value =
        operation.scalarFill !== undefined
          ? operation.scalarFill
          : (operation.results[r - operation.top]?.[c - operation.left] ?? null);
      cellSetResult(cell, snapshotToResult(value));
    }
  }
}

function applySpill(wb: WorkbookData, operation: SpillWrite): void {
  const ws = requireWorksheetById(wb, operation.sheetId, operation.sheetName);
  const owner = spillCellKeyFromId(operation.sheetId, operation.row, operation.col);
  for (let r = 0; r < operation.results.length; r++) {
    for (let c = 0; c < (operation.results[0]?.length ?? 0); c++) {
      const value = operation.results[r]?.[c] ?? null;
      if (r === 0 && c === 0) {
        const source = requireCell(ws, operation.row, operation.col, operation.sheetName);
        cellSetResult(source, snapshotToResult(value));
      } else {
        const target = getCell(ws, operation.row + r, operation.col + c);
        if (cellType(target) !== Enums.ValueType.Merge) {
          cellSetValue(target, snapshotToCellValue(value));
          target._formulaGhostOwner = owner;
        }
      }
    }
  }
}

function applySpillError(wb: WorkbookData, operation: SpillErrorWrite): void {
  const ws = requireWorksheetById(wb, operation.sheetId, operation.sheetName);
  const cell = requireCell(ws, operation.row, operation.col, operation.sheetName);
  cellSetResult(cell, { error: "#SPILL!" });
}

function applyCleanup(wb: WorkbookData, operation: CleanupWrite): void {
  const ws = requireWorksheetById(wb, operation.sheetId, operation.sheetName);
  for (const { row, col } of operation.cells) {
    const cell = findCell(ws, row, col);
    if (cell && cellType(cell) !== Enums.ValueType.Merge) {
      cellSetValue(cell, null);
    }
  }
}

function snapshotToResult(value: SnapshotCellValue): FormulaResult | undefined {
  return value === null ? undefined : value;
}

function snapshotToCellValue(
  value: SnapshotCellValue
): number | string | boolean | CellErrorValue | null {
  return value === null ? null : value;
}

// Compile-time proof that the engine and Excel agree on the error value shape.
const _errorShape: SnapshotErrorValue = { error: "#VALUE!" } satisfies CellErrorValue;
void _errorShape;
