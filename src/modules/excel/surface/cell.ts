/**
 * `Cell` namespace surface — public `(ws, addr, …)` cell operations.
 *
 * Consumed as `import { Cell } from "documonster/excel"` → `Cell.setValue(ws, "A1", 42)`.
 * Each function resolves the cell handle via `getCell(ws, addr)` and delegates
 * to the internal handle-level helpers. Consumers never hold a `CellData`.
 *
 * The `addr` parameter is either an `"A1"` string or a 1-based row number
 * followed by a column (`Cell.setValue(ws, 1, 1, 42)`), hence the
 * `string | number` unions in the signatures below.
 *
 * This is a flat-named-export module; `excel/index.ts` re-exports it via
 * `export * as Cell`, which tree-shakes per-member on rolldown / rspack.
 */
import type {
  CellData,
  CellModel,
  CellView,
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
  cellType,
  cellView
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
  DecodedAddress,
  DataValidationRule,
  Fill,
  Font,
  NumFmt,
  Protection,
  Style
} from "@excel/types";

/** A worksheet handle (opaque to consumers). */
export type Sheet = WorksheetData;

/**
 * Resolve the `(ws, addr)` / `(ws, row, col)` reader overload pair.
 *
 * `argc` is the caller's `arguments.length`: the 3-arg form addresses by
 * `(row, col)`, the 2-arg form by `"A1"`. Passing `col` positionally instead of
 * inspecting `argc` would make `(ws, "A1", 99)` silently address a completely
 * different cell (`n2l(99) + "A1"`), which is exactly what the old
 * `addr: string | number, col?: number` signature allowed.
 */
function target(ws: Sheet, addr: string | number, col: number | undefined, argc: number): CellData {
  return argc >= 3 ? getCell(ws, addr, col) : getCell(ws, addr);
}

/**
 * Resolve the `(ws, addr, value)` / `(ws, row, col, value)` writer overload
 * pair. See {@link target} for why `argc` decides.
 */
function targetWithValue<V>(
  ws: Sheet,
  addr: string | number,
  valueOrCol: V | number,
  value: V | undefined,
  argc: number
): [CellData, V] {
  return argc >= 4
    ? [getCell(ws, addr, valueOrCol as number), value as V]
    : [getCell(ws, addr), valueOrCol as V];
}

// --- value / type / text ---

/** Read a cell value by `"A1"` address. */
export function getValue(ws: Sheet, addr: string): CellValueType;
/** Read a cell value by 1-based (row, col). */
export function getValue(ws: Sheet, row: number, col: number): CellValueType;
export function getValue(ws: Sheet, addr: string | number, col?: number): CellValueType {
  return cellGetValue(target(ws, addr, col, arguments.length));
}
/** Set a cell value by "A1" address. */
export function setValue(ws: Sheet, addr: string, value: CellValueInputType): void;
/** Set a cell value by 1-based (row, col). */
export function setValue(ws: Sheet, row: number, col: number, value: CellValueInputType): void;
export function setValue(
  ws: Sheet,
  addr: string | number,
  valueOrCol: CellValueInputType,
  value?: CellValueInputType
): void {
  const [cell, resolved] = targetWithValue<CellValueInputType>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetValue(cell, resolved);
}
/** Read a cell's text by `"A1"` address. */
export function getText(ws: Sheet, addr: string): string;
/** Read a cell's text by 1-based (row, col). */
export function getText(ws: Sheet, row: number, col: number): string;
export function getText(ws: Sheet, addr: string | number, col?: number): string {
  return cellText(target(ws, addr, col, arguments.length));
}
/** Read a cell's display text by `"A1"` address. */
export function getDisplayText(ws: Sheet, addr: string): string;
/** Read a cell's display text by 1-based (row, col). */
export function getDisplayText(ws: Sheet, row: number, col: number): string;
export function getDisplayText(ws: Sheet, addr: string | number, col?: number): string {
  return cellDisplayText(target(ws, addr, col, arguments.length));
}
/** Read a cell's value kind by `"A1"` address. */
export function getType(ws: Sheet, addr: string): ValueType;
/** Read a cell's value kind by 1-based (row, col). */
export function getType(ws: Sheet, row: number, col: number): ValueType;
export function getType(ws: Sheet, addr: string | number, col?: number): ValueType {
  return cellType(target(ws, addr, col, arguments.length));
}
/** Read a cell's effective value kind by `"A1"` address. */
export function getEffectiveType(ws: Sheet, addr: string): ValueType;
/** Read a cell's effective value kind by 1-based (row, col). */
export function getEffectiveType(ws: Sheet, row: number, col: number): ValueType;
export function getEffectiveType(ws: Sheet, addr: string | number, col?: number): ValueType {
  return cellEffectiveType(target(ws, addr, col, arguments.length));
}

// --- formula ---

/** Read a cell's formula by `"A1"` address. */
export function getFormula(ws: Sheet, addr: string): string | undefined;
/** Read a cell's formula by 1-based (row, col). */
export function getFormula(ws: Sheet, row: number, col: number): string | undefined;
export function getFormula(ws: Sheet, addr: string | number, col?: number): string | undefined {
  return cellFormula(target(ws, addr, col, arguments.length));
}
/** Read a formula cell's cached result by `"A1"` address. */
export function getResult(ws: Sheet, addr: string): FormulaResult | undefined;
/** Read a formula cell's cached result by 1-based (row, col). */
export function getResult(ws: Sheet, row: number, col: number): FormulaResult | undefined;
export function getResult(
  ws: Sheet,
  addr: string | number,
  col?: number
): FormulaResult | undefined {
  return cellResult(target(ws, addr, col, arguments.length));
}

// --- style ---

/** Read a cell's style by `"A1"` address. */
export function getStyle(ws: Sheet, addr: string): Partial<Style>;
/** Read a cell's style by 1-based (row, col). */
export function getStyle(ws: Sheet, row: number, col: number): Partial<Style>;
export function getStyle(ws: Sheet, addr: string | number, col?: number): Partial<Style> {
  return cellGetStyle(target(ws, addr, col, arguments.length));
}
/** Merge a partial style into the cell at "A1" address. */
export function setStyle(ws: Sheet, addr: string, style: Partial<Style>): void;
/** Merge a partial style into the cell at 1-based (row, col). */
export function setStyle(ws: Sheet, row: number, col: number, style: Partial<Style>): void;
export function setStyle(
  ws: Sheet,
  addr: string | number,
  styleOrCol: Partial<Style> | number,
  style?: Partial<Style>
): void {
  const [cell, resolved] = targetWithValue<Partial<Style>>(
    ws,
    addr,
    styleOrCol,
    style,
    arguments.length
  );
  cellSetStyle(cell, resolved);
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
  addr: string | number,
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

/** Test whether a cell is merged by `"A1"` address. */
export function isMerged(ws: Sheet, addr: string): boolean;
/** Test whether a cell is merged by 1-based (row, col). */
export function isMerged(ws: Sheet, row: number, col: number): boolean;
export function isMerged(ws: Sheet, addr: string | number, col?: number): boolean {
  return cellIsMerged(target(ws, addr, col, arguments.length));
}
/** Read the master cell of a merge by `"A1"` address. */
export function getMergeMaster(ws: Sheet, addr: string): CellData;
/** Read the master cell of a merge by 1-based (row, col). */
export function getMergeMaster(ws: Sheet, row: number, col: number): CellData;
export function getMergeMaster(ws: Sheet, addr: string | number, col?: number): CellData {
  return cellMaster(target(ws, addr, col, arguments.length));
}

// --- hyperlink ---

/** Read a cell's hyperlink by `"A1"` address. */
export function getHyperlink(ws: Sheet, addr: string): string | undefined;
/** Read a cell's hyperlink by 1-based (row, col). */
export function getHyperlink(ws: Sheet, row: number, col: number): string | undefined;
export function getHyperlink(ws: Sheet, addr: string | number, col?: number): string | undefined {
  return cellHyperlink(target(ws, addr, col, arguments.length));
}

// --- note ---

/** Read a cell's note by `"A1"` address. */
export function getNote(ws: Sheet, addr: string): string | NoteConfig | undefined;
/** Read a cell's note by 1-based (row, col). */
export function getNote(ws: Sheet, row: number, col: number): string | NoteConfig | undefined;
export function getNote(
  ws: Sheet,
  addr: string | number,
  col?: number
): string | NoteConfig | undefined {
  return cellNote(target(ws, addr, col, arguments.length));
}
/** Set a cell's note by `"A1"` address. */
export function setNote(ws: Sheet, addr: string, note: string | NoteConfig): void;
/** Set a cell's note by 1-based (row, col). */
export function setNote(ws: Sheet, row: number, col: number, note: string | NoteConfig): void;
export function setNote(
  ws: Sheet,
  addr: string | number,
  noteOrCol: string | NoteConfig | number,
  note?: string | NoteConfig
): void {
  const [cell, resolved] = targetWithValue<string | NoteConfig>(
    ws,
    addr,
    noteOrCol,
    note,
    arguments.length
  );
  cellSetNote(cell, resolved);
}

// --- defined names ---

/** Read the defined names covering a cell by `"A1"` address. */
export function getNames(ws: Sheet, addr: string): string[];
/** Read the defined names covering a cell by 1-based (row, col). */
export function getNames(ws: Sheet, row: number, col: number): string[];
export function getNames(ws: Sheet, addr: string | number, col?: number): string[] {
  return cellNames(target(ws, addr, col, arguments.length));
}
/** Add a defined name to a cell by `"A1"` address. */
export function addName(ws: Sheet, addr: string, name: string): void;
/** Add a defined name to a cell by 1-based (row, col). */
export function addName(ws: Sheet, row: number, col: number, name: string): void;
export function addName(
  ws: Sheet,
  addr: string | number,
  nameOrCol: string | number,
  name?: string
): void {
  const [cell, resolved] = targetWithValue<string>(ws, addr, nameOrCol, name, arguments.length);
  cellAddName(cell, resolved);
}
/** Remove a defined name from a cell by `"A1"` address. */
export function removeName(ws: Sheet, addr: string, name: string): void;
/** Remove a defined name from a cell by 1-based (row, col). */
export function removeName(ws: Sheet, row: number, col: number, name: string): void;
export function removeName(
  ws: Sheet,
  addr: string | number,
  nameOrCol: string | number,
  name?: string
): void {
  const [cell, resolved] = targetWithValue<string>(ws, addr, nameOrCol, name, arguments.length);
  cellRemoveName(cell, resolved);
}
/** Replace a cell's defined names with one by `"A1"` address. */
export function setName(ws: Sheet, addr: string, name: string): void;
/** Replace a cell's defined names with one by 1-based (row, col). */
export function setName(ws: Sheet, row: number, col: number, name: string): void;
export function setName(
  ws: Sheet,
  addr: string | number,
  nameOrCol: string | number,
  name?: string
): void {
  const [cell, resolved] = targetWithValue<string>(ws, addr, nameOrCol, name, arguments.length);
  cellSetName(cell, resolved);
}
/** Replace a cell's defined names by `"A1"` address. */
export function setNames(ws: Sheet, addr: string, names: string[]): void;
/** Replace a cell's defined names by 1-based (row, col). */
export function setNames(ws: Sheet, row: number, col: number, names: string[]): void;
export function setNames(
  ws: Sheet,
  addr: string | number,
  namesOrCol: string[] | number,
  names?: string[]
): void {
  const [cell, resolved] = targetWithValue<string[]>(ws, addr, namesOrCol, names, arguments.length);
  cellSetNames(cell, resolved);
}
/** Remove every defined name from a cell by `"A1"` address. */
export function removeAllNames(ws: Sheet, addr: string): void;
/** Remove every defined name from a cell by 1-based (row, col). */
export function removeAllNames(ws: Sheet, row: number, col: number): void;
export function removeAllNames(ws: Sheet, addr: string | number, col?: number): void {
  cellRemoveAllNames(target(ws, addr, col, arguments.length));
}

// --- data validation ---

/** Read a cell's validation rule by `"A1"` address. */
export function getValidation(ws: Sheet, addr: string): DataValidationRule | undefined;
/** Read a cell's validation rule by 1-based (row, col). */
export function getValidation(ws: Sheet, row: number, col: number): DataValidationRule | undefined;
export function getValidation(
  ws: Sheet,
  addr: string | number,
  col?: number
): DataValidationRule | undefined {
  return cellDataValidation(target(ws, addr, col, arguments.length));
}
/** Set a cell's validation rule by `"A1"` address. */
export function setValidation(ws: Sheet, addr: string, value: DataValidationRule): void;
/** Set a cell's validation rule by 1-based (row, col). */
export function setValidation(ws: Sheet, row: number, col: number, value: DataValidationRule): void;
export function setValidation(
  ws: Sheet,
  addr: string | number,
  valueOrCol: DataValidationRule | number,
  value?: DataValidationRule
): void {
  const [cell, resolved] = targetWithValue<DataValidationRule>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetDataValidation(cell, resolved);
}

// --- model (advanced / round-trip) ---

/** Read a cell's round-trip model by `"A1"` address. */
export function getModel(ws: Sheet, addr: string): CellModel;
/** Read a cell's round-trip model by 1-based (row, col). */
export function getModel(ws: Sheet, row: number, col: number): CellModel;
export function getModel(ws: Sheet, addr: string | number, col?: number): CellModel {
  return cellGetModel(target(ws, addr, col, arguments.length));
}
/** Apply a round-trip cell model by `"A1"` address. */
export function setModel(ws: Sheet, addr: string, model: CellModel): void;
/** Apply a round-trip cell model by 1-based (row, col). */
export function setModel(ws: Sheet, row: number, col: number, model: CellModel): void;
export function setModel(
  ws: Sheet,
  addr: string | number,
  modelOrCol: CellModel | number,
  model?: CellModel
): void {
  const [cell, resolved] = targetWithValue<CellModel>(
    ws,
    addr,
    modelOrCol,
    model,
    arguments.length
  );
  cellSetModel(cell, resolved);
}

// --- individual style facets (getters + setters) ---

/** Read a cell's font by `"A1"` address. */
export function getFont(ws: Sheet, addr: string): Partial<Font> | undefined;
/** Read a cell's font by 1-based (row, col). */
export function getFont(ws: Sheet, row: number, col: number): Partial<Font> | undefined;
export function getFont(ws: Sheet, addr: string | number, col?: number): Partial<Font> | undefined {
  return cellFont(target(ws, addr, col, arguments.length));
}
/** Set a cell's font by `"A1"` address. */
export function setFont(ws: Sheet, addr: string, value: Partial<Font> | undefined): void;
/** Set a cell's font by 1-based (row, col). */
export function setFont(
  ws: Sheet,
  row: number,
  col: number,
  value: Partial<Font> | undefined
): void;
export function setFont(
  ws: Sheet,
  addr: string | number,
  valueOrCol: Partial<Font> | undefined | number,
  value?: Partial<Font>
): void {
  const [cell, resolved] = targetWithValue<Partial<Font> | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetFont(cell, resolved);
}
/** Read a cell's number format by `"A1"` address. */
export function getNumFmt(ws: Sheet, addr: string): string | NumFmt | undefined;
/** Read a cell's number format by 1-based (row, col). */
export function getNumFmt(ws: Sheet, row: number, col: number): string | NumFmt | undefined;
export function getNumFmt(
  ws: Sheet,
  addr: string | number,
  col?: number
): string | NumFmt | undefined {
  return cellNumFmt(target(ws, addr, col, arguments.length));
}
/** Set a cell's number format by `"A1"` address. */
export function setNumFmt(ws: Sheet, addr: string, value: string | undefined): void;
/** Set a cell's number format by 1-based (row, col). */
export function setNumFmt(ws: Sheet, row: number, col: number, value: string | undefined): void;
export function setNumFmt(
  ws: Sheet,
  addr: string | number,
  valueOrCol: string | undefined | number,
  value?: string
): void {
  const [cell, resolved] = targetWithValue<string | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetNumFmt(cell, resolved);
}
/** Read a cell's alignment by `"A1"` address. */
export function getAlignment(ws: Sheet, addr: string): Partial<Alignment> | undefined;
/** Read a cell's alignment by 1-based (row, col). */
export function getAlignment(ws: Sheet, row: number, col: number): Partial<Alignment> | undefined;
export function getAlignment(
  ws: Sheet,
  addr: string | number,
  col?: number
): Partial<Alignment> | undefined {
  return cellAlignment(target(ws, addr, col, arguments.length));
}
/** Set a cell's alignment by `"A1"` address. */
export function setAlignment(ws: Sheet, addr: string, value: Partial<Alignment> | undefined): void;
/** Set a cell's alignment by 1-based (row, col). */
export function setAlignment(
  ws: Sheet,
  row: number,
  col: number,
  value: Partial<Alignment> | undefined
): void;
export function setAlignment(
  ws: Sheet,
  addr: string | number,
  valueOrCol: Partial<Alignment> | undefined | number,
  value?: Partial<Alignment>
): void {
  const [cell, resolved] = targetWithValue<Partial<Alignment> | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetAlignment(cell, resolved);
}
/** Read a cell's borders by `"A1"` address. */
export function getBorder(ws: Sheet, addr: string): Partial<Borders> | undefined;
/** Read a cell's borders by 1-based (row, col). */
export function getBorder(ws: Sheet, row: number, col: number): Partial<Borders> | undefined;
export function getBorder(
  ws: Sheet,
  addr: string | number,
  col?: number
): Partial<Borders> | undefined {
  return cellBorder(target(ws, addr, col, arguments.length));
}
/** Set a cell's borders by `"A1"` address. */
export function setBorder(ws: Sheet, addr: string, value: Partial<Borders> | undefined): void;
/** Set a cell's borders by 1-based (row, col). */
export function setBorder(
  ws: Sheet,
  row: number,
  col: number,
  value: Partial<Borders> | undefined
): void;
export function setBorder(
  ws: Sheet,
  addr: string | number,
  valueOrCol: Partial<Borders> | undefined | number,
  value?: Partial<Borders>
): void {
  const [cell, resolved] = targetWithValue<Partial<Borders> | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetBorder(cell, resolved);
}
/** Read a cell's fill by `"A1"` address. */
export function getFill(ws: Sheet, addr: string): Fill | undefined;
/** Read a cell's fill by 1-based (row, col). */
export function getFill(ws: Sheet, row: number, col: number): Fill | undefined;
export function getFill(ws: Sheet, addr: string | number, col?: number): Fill | undefined {
  return cellFill(target(ws, addr, col, arguments.length));
}
/** Set a cell's fill by `"A1"` address. */
export function setFill(ws: Sheet, addr: string, value: Fill | undefined): void;
/** Set a cell's fill by 1-based (row, col). */
export function setFill(ws: Sheet, row: number, col: number, value: Fill | undefined): void;
export function setFill(
  ws: Sheet,
  addr: string | number,
  valueOrCol: Fill | undefined | number,
  value?: Fill
): void {
  const [cell, resolved] = targetWithValue<Fill | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetFill(cell, resolved);
}
/** Read a cell's protection by `"A1"` address. */
export function getProtection(ws: Sheet, addr: string): Partial<Protection> | undefined;
/** Read a cell's protection by 1-based (row, col). */
export function getProtection(ws: Sheet, row: number, col: number): Partial<Protection> | undefined;
export function getProtection(
  ws: Sheet,
  addr: string | number,
  col?: number
): Partial<Protection> | undefined {
  return cellProtection(target(ws, addr, col, arguments.length));
}
/** Set a cell's protection by `"A1"` address. */
export function setProtection(
  ws: Sheet,
  addr: string,
  value: Partial<Protection> | undefined
): void;
/** Set a cell's protection by 1-based (row, col). */
export function setProtection(
  ws: Sheet,
  row: number,
  col: number,
  value: Partial<Protection> | undefined
): void;
export function setProtection(
  ws: Sheet,
  addr: string | number,
  valueOrCol: Partial<Protection> | undefined | number,
  value?: Partial<Protection>
): void {
  const [cell, resolved] = targetWithValue<Partial<Protection> | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetProtection(cell, resolved);
}

// --- comment (author-bearing note) ---

/** Read a cell's comment by `"A1"` address. */
export function getComment(ws: Sheet, addr: string): NoteData | undefined;
/** Read a cell's comment by 1-based (row, col). */
export function getComment(ws: Sheet, row: number, col: number): NoteData | undefined;
export function getComment(ws: Sheet, addr: string | number, col?: number): NoteData | undefined {
  return cellComment(target(ws, addr, col, arguments.length));
}
/** Set a cell's comment by `"A1"` address. */
export function setComment(
  ws: Sheet,
  addr: string,
  comment: NoteData | NoteConfig | undefined
): void;
/** Set a cell's comment by 1-based (row, col). */
export function setComment(
  ws: Sheet,
  row: number,
  col: number,
  comment: NoteData | NoteConfig | undefined
): void;
export function setComment(
  ws: Sheet,
  addr: string | number,
  commentOrCol: NoteData | NoteConfig | undefined | number,
  comment?: NoteData | NoteConfig
): void {
  const [cell, resolved] = targetWithValue<NoteData | NoteConfig | undefined>(
    ws,
    addr,
    commentOrCol,
    comment,
    arguments.length
  );
  cellSetComment(cell, resolved);
}

// --- formula result / full address ---

/** Set a formula cell's cached result by `"A1"` address. */
export function setResult(ws: Sheet, addr: string, value: FormulaResult | undefined): void;
/** Set a formula cell's cached result by 1-based (row, col). */
export function setResult(
  ws: Sheet,
  row: number,
  col: number,
  value: FormulaResult | undefined
): void;
export function setResult(
  ws: Sheet,
  addr: string | number,
  valueOrCol: FormulaResult | undefined | number,
  value?: FormulaResult
): void {
  const [cell, resolved] = targetWithValue<FormulaResult | undefined>(
    ws,
    addr,
    valueOrCol,
    value,
    arguments.length
  );
  cellSetResult(cell, resolved);
}
/** The cell's fully-qualified address by `"A1"` address. */
export function getFullAddress(ws: Sheet, addr: string): DecodedAddress;
/** The cell's fully-qualified address by 1-based (row, col). */
export function getFullAddress(ws: Sheet, row: number, col: number): DecodedAddress;
export function getFullAddress(ws: Sheet, addr: string | number, col?: number): DecodedAddress {
  return cellFullAddress(target(ws, addr, col, arguments.length));
}

// --- cell handles ---

/**
 * Read a cell **handle** — the `CellData` handed to `Row.eachCell` /
 * `Row.getCell` / `Worksheet.getRow`.
 *
 * A handle exposes its address and style directly, but not its value: that
 * lives behind an internal box. This returns a live read-only projection
 * (`value`, `text`, `effectiveType`, `numFmt`, `font`, `alignment`), so
 * iterating a row does not have to re-address every cell:
 *
 * ```ts
 * Row.eachCell(ws, 1, cell => {
 *   const header = Cell.view(cell).text.trim();
 * });
 * ```
 *
 * To *write* through a handle, use the `Stream` namespace's handle operations
 * (`Stream.setCellValue`, `Stream.setCellFont`, …) — they work on any
 * `CellData`, streaming or not.
 */
export function view(cell: CellData): CellView {
  return cellView(cell);
}

// --- types ---

/**
 * A value read out of a cell — what {@link getValue} returns, and the element
 * type of the matrix `Range.getValues` returns.
 */
export type Value = CellValueType;
