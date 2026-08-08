/**
 * `Cell` namespace surface — public `(ws, addr, …)` cell operations.
 *
 * Consumed as `import { Cell } from "documonster/excel"` → `Cell.setValue(ws, "A1", 42)`.
 * Each function resolves the cell handle via `getCell(ws, addr)` and delegates
 * to the internal handle-level helpers. Consumers never hold a `CellData`.
 *
 * This is a flat-named-export module; `excel/index.ts` re-exports it via
 * `export * as Cell`, which tree-shakes per-member on rolldown / rspack.
 */
import type {
  CellData,
  CellModel,
  CellValueInputType,
  CellValueType,
  FormulaResult,
  NoteConfig
} from "@excel/core/cell";
import {
  cellAddName,
  cellAlignment,
  cellBorder,
  cellComment,
  cellDataValidation,
  cellDisplayText,
  cellEffectiveType,
  cellFill,
  cellFont,
  cellFormula,
  cellFullAddress,
  cellGetModel,
  cellGetStyle,
  cellGetValue,
  cellHyperlink,
  cellIsMerged,
  cellMaster,
  cellNames,
  cellNote,
  cellNumFmt,
  cellProtection,
  cellRemoveAllNames,
  cellRemoveName,
  cellResult,
  cellSetAlignment,
  cellSetBorder,
  cellSetComment,
  cellSetDataValidation,
  cellSetFill,
  cellSetFont,
  cellSetModel,
  cellSetName,
  cellSetNames,
  cellSetNote,
  cellSetNumFmt,
  cellSetProtection,
  cellSetResult,
  cellSetStyle,
  cellSetValue,
  cellText,
  cellType
} from "@excel/core/cell";
import type { ValueType } from "@excel/core/enums";
import type { NoteData } from "@excel/core/note";
import { getCellStyle } from "@excel/core/workbook-core";
import { getCell, getSheetWorkbook } from "@excel/core/worksheet-core";
import type { WorksheetData } from "@excel/core/worksheet-core";
import { ExcelError } from "@excel/errors";
import type {
  Alignment,
  Borders,
  DataValidation,
  Fill,
  Font,
  NumFmt,
  Protection,
  Style
} from "@excel/types";

/** A worksheet handle (opaque to consumers). */
export type Sheet = WorksheetData;
/** An address: an `"A1"` string, or a 1-based `(row, col)` pair. */
type Addr = string | number;

// --- value / type / text ---

export function getValue(ws: Sheet, addr: Addr, col?: number): CellValueType {
  return cellGetValue(getCell(ws, addr, col));
}
/** Set a cell value by "A1" address. */
export function setValue(ws: Sheet, addr: string, value: CellValueInputType): void;
/** Set a cell value by 1-based (row, col). */
export function setValue(ws: Sheet, row: number, col: number, value: CellValueInputType): void;
export function setValue(
  ws: Sheet,
  addr: Addr,
  valueOrCol: CellValueInputType,
  value?: CellValueInputType
): void {
  // The 4-arg (ws, row, col, value) form passes valueOrCol as the column; the
  // 3-arg (ws, addr, value) form passes it as the value. arguments.length is
  // reliable here (named function declaration, never an arrow / bound fn).
  if (arguments.length >= 4) {
    cellSetValue(getCell(ws, addr, valueOrCol as number), value as CellValueInputType);
    return;
  }
  cellSetValue(getCell(ws, addr), valueOrCol);
}
export function getText(ws: Sheet, addr: Addr, col?: number): string {
  return cellText(getCell(ws, addr, col));
}
export function getDisplayText(ws: Sheet, addr: Addr, col?: number): string {
  return cellDisplayText(getCell(ws, addr, col));
}
export function getType(ws: Sheet, addr: Addr, col?: number): ValueType {
  return cellType(getCell(ws, addr, col));
}
export function getEffectiveType(ws: Sheet, addr: Addr, col?: number): ValueType {
  return cellEffectiveType(getCell(ws, addr, col));
}

// --- formula ---

export function getFormula(ws: Sheet, addr: Addr, col?: number): string | undefined {
  return cellFormula(getCell(ws, addr, col));
}
export function getResult(ws: Sheet, addr: Addr, col?: number): FormulaResult | undefined {
  return cellResult(getCell(ws, addr, col));
}

// --- style ---

export function getStyle(ws: Sheet, addr: Addr, col?: number): Partial<Style> {
  return cellGetStyle(getCell(ws, addr, col));
}
/** Merge a partial style into the cell at "A1" address. */
export function setStyle(ws: Sheet, addr: string, style: Partial<Style>): void;
/** Merge a partial style into the cell at 1-based (row, col). */
export function setStyle(ws: Sheet, row: number, col: number, style: Partial<Style>): void;
export function setStyle(
  ws: Sheet,
  addr: Addr,
  styleOrCol: Partial<Style> | number,
  style?: Partial<Style>
): void {
  // The 4-arg (ws, row, col, style) form passes styleOrCol as the column; the
  // 3-arg (ws, addr, style) form passes it as the style. arguments.length is
  // reliable here (named function declaration, never an arrow / bound fn).
  if (arguments.length >= 4) {
    cellSetStyle(getCell(ws, addr, styleOrCol as number), style as Partial<Style>);
    return;
  }
  cellSetStyle(getCell(ws, addr), styleOrCol as Partial<Style>);
}

/**
 * Apply a workbook-level named cell style (e.g. "Heading 1") to the cell at
 * the "A1" address. The style must first be defined with
 * `Workbook.defineCellStyle`; applying an unknown name throws. To set a raw
 * `styleName` without this check, use `Cell.setStyle(ws, addr, { styleName })`.
 */
export function applyCellStyle(ws: Sheet, addr: string, name: string): void;
/** Apply a named cell style to the cell at 1-based (row, col). */
export function applyCellStyle(ws: Sheet, row: number, col: number, name: string): void;
export function applyCellStyle(
  ws: Sheet,
  addr: Addr,
  nameOrCol: string | number,
  name?: string
): void {
  const styleName = (arguments.length >= 4 ? name : nameOrCol) as string;
  if (!getCellStyle(getSheetWorkbook(ws), styleName)) {
    throw new ExcelError(
      `Named cell style "${styleName}" is not defined. Define it first with Workbook.defineCellStyle().`
    );
  }
  if (arguments.length >= 4) {
    cellSetStyle(getCell(ws, addr, nameOrCol as number), { styleName });
    return;
  }
  cellSetStyle(getCell(ws, addr), { styleName });
}

// --- merge ---

export function isMerged(ws: Sheet, addr: Addr): boolean {
  return cellIsMerged(getCell(ws, addr));
}
export function getMergeMaster(ws: Sheet, addr: Addr): CellData {
  return cellMaster(getCell(ws, addr));
}

// --- hyperlink ---

export function getHyperlink(ws: Sheet, addr: Addr): string | undefined {
  return cellHyperlink(getCell(ws, addr));
}

// --- note ---

export function getNote(ws: Sheet, addr: Addr): string | NoteConfig | undefined {
  return cellNote(getCell(ws, addr));
}
export function setNote(ws: Sheet, addr: Addr, note: string | NoteConfig): void {
  cellSetNote(getCell(ws, addr), note);
}

// --- defined names ---

export function getNames(ws: Sheet, addr: Addr): string[] {
  return cellNames(getCell(ws, addr));
}
export function addName(ws: Sheet, addr: Addr, name: string): void {
  cellAddName(getCell(ws, addr), name);
}
export function removeName(ws: Sheet, addr: Addr, name: string): void {
  cellRemoveName(getCell(ws, addr), name);
}
export function setName(ws: Sheet, addr: Addr, name: string): void {
  cellSetName(getCell(ws, addr), name);
}
export function setNames(ws: Sheet, addr: Addr, names: string[]): void {
  cellSetNames(getCell(ws, addr), names);
}
export function removeAllNames(ws: Sheet, addr: Addr): void {
  cellRemoveAllNames(getCell(ws, addr));
}

// --- data validation ---

export function getValidation(ws: Sheet, addr: Addr): DataValidation | undefined {
  return cellDataValidation(getCell(ws, addr));
}
export function setValidation(ws: Sheet, addr: Addr, value: DataValidation): void {
  cellSetDataValidation(getCell(ws, addr), value);
}

// --- model (advanced / round-trip) ---

export function getModel(ws: Sheet, addr: Addr): CellModel {
  return cellGetModel(getCell(ws, addr));
}
export function setModel(ws: Sheet, addr: Addr, model: CellModel): void {
  cellSetModel(getCell(ws, addr), model);
}

// --- individual style facets (getters + setters) ---

export function getFont(ws: Sheet, addr: Addr): Partial<Font> | undefined {
  return cellFont(getCell(ws, addr));
}
export function setFont(ws: Sheet, addr: Addr, value: Partial<Font> | undefined): void {
  cellSetFont(getCell(ws, addr), value);
}
export function getNumFmt(ws: Sheet, addr: Addr): string | NumFmt | undefined {
  return cellNumFmt(getCell(ws, addr));
}
export function setNumFmt(ws: Sheet, addr: Addr, value: string | undefined): void {
  cellSetNumFmt(getCell(ws, addr), value);
}
export function getAlignment(ws: Sheet, addr: Addr): Partial<Alignment> | undefined {
  return cellAlignment(getCell(ws, addr));
}
export function setAlignment(ws: Sheet, addr: Addr, value: Partial<Alignment> | undefined): void {
  cellSetAlignment(getCell(ws, addr), value);
}
export function getBorder(ws: Sheet, addr: Addr): Partial<Borders> | undefined {
  return cellBorder(getCell(ws, addr));
}
export function setBorder(ws: Sheet, addr: Addr, value: Partial<Borders> | undefined): void {
  cellSetBorder(getCell(ws, addr), value);
}
export function getFill(ws: Sheet, addr: Addr): Fill | undefined {
  return cellFill(getCell(ws, addr));
}
export function setFill(ws: Sheet, addr: Addr, value: Fill | undefined): void {
  cellSetFill(getCell(ws, addr), value);
}
export function getProtection(ws: Sheet, addr: Addr): Partial<Protection> | undefined {
  return cellProtection(getCell(ws, addr));
}
export function setProtection(ws: Sheet, addr: Addr, value: Partial<Protection> | undefined): void {
  cellSetProtection(getCell(ws, addr), value);
}

// --- comment (author-bearing note) ---

export function getComment(ws: Sheet, addr: Addr): NoteData | undefined {
  return cellComment(getCell(ws, addr));
}
export function setComment(
  ws: Sheet,
  addr: Addr,
  comment: NoteData | NoteConfig | undefined
): void {
  cellSetComment(getCell(ws, addr), comment);
}

// --- formula result / full address ---

export function setResult(ws: Sheet, addr: Addr, value: FormulaResult | undefined): void {
  cellSetResult(getCell(ws, addr), value);
}
export function getFullAddress(ws: Sheet, addr: Addr): ReturnType<typeof cellFullAddress> {
  return cellFullAddress(getCell(ws, addr));
}

// --- types ---

/**
 * A value read out of a cell — what {@link getValue} returns, and the element
 * type of the matrix `Range.getValues` returns.
 */
export type Value = CellValueType;
