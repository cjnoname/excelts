import type { ColumnData } from "@excel/core/column";
import { dataValidationAdd, dataValidationFind } from "@excel/core/data-validations";
import {
  definedNamesAddEx,
  definedNamesGetNamesEx,
  definedNamesRemoveAllNames,
  definedNamesRemoveEx
} from "@excel/core/defined-names";
import type { ValueType, FormulaType } from "@excel/core/enums";
import { Enums } from "@excel/core/enums";
import { isNoteData, noteCreate, noteFromModel, noteModel } from "@excel/core/note";
import type { NoteData } from "@excel/core/note";
import type { RowData } from "@excel/core/row";
import type { Workbook } from "@excel/core/workbook";
import type { Worksheet } from "@excel/core/worksheet";
import { ExcelError, InvalidValueTypeError } from "@excel/errors";
import type {
  Style,
  DecodedAddress,
  NumFmt,
  Font,
  Alignment,
  Protection,
  Borders,
  Fill,
  CellRichTextValue,
  CellErrorValue,
  DataValidationRule,
  CellValue,
  CellValueInput,
  CellHyperlinkValue,
  CellHyperlinkValueInput,
  CellFormulaHyperlinkValue,
  CellCheckboxValue,
  RichText
} from "@excel/types";
import { getCellDisplayText } from "@excel/utils/cell-format";
import { colCache } from "@excel/utils/col-cache";
import { copyStyle } from "@excel/utils/copy-style";
import { slideFormula } from "@excel/utils/shared-formula";

export type FormulaResult = string | number | boolean | Date | CellErrorValue;

export interface FormulaValueData {
  shareType?: string;
  ref?: string;
  formula?: string;
  sharedFormula?: string;
  result?: FormulaResult;
  date1904?: boolean;
  isDynamicArray?: boolean;
}

export interface NoteText {
  text: string;
  font?: Partial<Font>;
}

export interface NoteConfig {
  texts?: NoteText[];
  margins?: { insetmode?: string; inset?: number[] };
  protection?: { locked?: string; lockText?: string };
  editAs?: string;
  anchor?: string;
  width?: number;
  height?: number;
}

export interface NoteModel {
  type: string;
  note: NoteConfig;
  author?: string;
}

export interface CellModel {
  address: string;
  type: ValueType;
  value?:
    | number
    | string
    | boolean
    | Date
    | CellRichTextValue
    | CellErrorValue
    | CellHyperlinkValue;
  style?: Partial<Style>;
  comment?: NoteModel;
  text?: string;
  hyperlink?: string;
  tooltip?: string;
  master?: string;
  shareType?: string;
  ref?: string;
  formula?: string;
  sharedFormula?: string;
  result?: FormulaResult;
  richText?: CellRichTextValue | RichText[];
  sharedString?: number;
  error?: CellErrorValue;
  rawValue?: unknown;
  isDynamicArray?: boolean;
}

// Internal interface for Value type objects (value-boxing representation).
interface ICellValue {
  model: CellModel;
  value: CellValueType;
  type: ValueType;
  effectiveType: ValueType;
  address: string;
  formula?: string;
  result?: FormulaResult;
  formulaType?: FormulaType;
  hyperlink?: string;
  master?: CellData;
  text?: string;
  release(): void;
  toCsvString(): string;
  toString(): string;
  isMergedTo?(master: CellData): boolean;
}

export type CellValueType = CellValue;
export type CellValueInputType = CellValueInput;

function hasOwnKeys(v: unknown): boolean {
  return !!v && (typeof v !== "object" || Object.keys(v as object).length > 0);
}

function flattenRichText(runs: readonly RichText[]): string {
  let out = "";
  for (const run of runs) {
    if (run && typeof run.text === "string") {
      out += run.text;
    }
  }
  return out;
}

interface NormalizedHyperlink extends CellHyperlinkValue {
  text: string;
  hyperlink: string;
}

function normalizeHyperlinkValue(value: CellHyperlinkValueInput): NormalizedHyperlink {
  let text: string;
  let richText: RichText[] | undefined;
  if (Array.isArray(value.richText) && value.richText.length > 0) {
    richText = value.richText;
    text = flattenRichText(richText);
  } else {
    text = typeof value.text === "string" ? value.text : "";
  }
  const out: NormalizedHyperlink = {
    text,
    hyperlink: typeof value.hyperlink === "string" ? value.hyperlink : ""
  };
  if (richText) {
    out.richText = richText;
  }
  if (typeof value.tooltip === "string" && value.tooltip.length > 0) {
    out.tooltip = value.tooltip;
  }
  return out;
}

const Types = Enums.ValueType;

/**
 * Plain-data cell record. The entire state of a cell — no class. All
 * operations are free functions in the {@link Cell} namespace. The `_value`
 * field holds an internal value-boxing object (the polymorphic Value
 * representation); it is an implementation detail not exposed to consumers.
 */
export interface CellData {
  row: RowData;
  column: ColumnData;
  address: string;
  _value: ICellValue;
  style: Partial<Style>;
  _mergeCount: number;
  _comment?: NoteData;
  /** Internal ownership marker for a formula spill ghost. */
  _formulaGhostOwner?: string;
}

export function mergeCellStyle(
  rowStyle: Partial<Style>,
  colStyle: Partial<Style>,
  style: Partial<Style>
): Partial<Style> {
  const styleName = (rowStyle && rowStyle.styleName) || (colStyle && colStyle.styleName);
  if (styleName) {
    style.styleName = styleName;
  }
  const numFmt = (rowStyle && rowStyle.numFmt) || (colStyle && colStyle.numFmt);
  if (numFmt) {
    style.numFmt = numFmt;
  }
  const font =
    (rowStyle && hasOwnKeys(rowStyle.font) && rowStyle.font) ||
    (colStyle && hasOwnKeys(colStyle.font) && colStyle.font);
  if (font) {
    style.font = structuredClone(font);
  }
  const alignment =
    (rowStyle && hasOwnKeys(rowStyle.alignment) && rowStyle.alignment) ||
    (colStyle && hasOwnKeys(colStyle.alignment) && colStyle.alignment);
  if (alignment) {
    style.alignment = structuredClone(alignment);
  }
  const border =
    (rowStyle && hasOwnKeys(rowStyle.border) && rowStyle.border) ||
    (colStyle && hasOwnKeys(colStyle.border) && colStyle.border);
  if (border) {
    style.border = structuredClone(border);
  }
  const fill =
    (rowStyle && hasOwnKeys(rowStyle.fill) && rowStyle.fill) ||
    (colStyle && hasOwnKeys(colStyle.fill) && colStyle.fill);
  if (fill) {
    style.fill = structuredClone(fill);
  }
  const protection =
    (rowStyle && hasOwnKeys(rowStyle.protection) && rowStyle.protection) ||
    (colStyle && hasOwnKeys(colStyle.protection) && colStyle.protection);
  if (protection) {
    style.protection = structuredClone(protection);
  }
  return style;
}

/**
 * Cell namespace — free functions over the plain-data {@link CellData}.
 * Replaces the former `Cell` class.
 */
export const CellTypes = Types;

export function cellCreate(row: RowData, column: ColumnData, address: string): CellData {
  if (!row || !column) {
    throw new ExcelError("A Cell needs a Row");
  }
  colCache.validateAddress(address);
  // `mergeCellStyle` builds and returns the cell's own style object in one pass, so
  // we set it directly rather than allocating a throwaway `{}` literal first.
  const cell = {
    row,
    column,
    address,
    style: mergeCellStyle(row.style, column.style, {}),
    _mergeCount: 0
  } as CellData;
  cell._value = Value.create(Types.Null, cell);
  return cell;
}

export function cellWorksheet(c: CellData): Worksheet {
  return c.row.worksheet;
}

export function cellWorkbook(c: CellData): Workbook {
  return c.row.worksheet._workbook;
}

export function cellDestroy(c: CellData): void {
  c.style = undefined!;
  c._value = undefined!;
  c.row = undefined!;
  c.column = undefined!;
  c.address = undefined!;
}

export function cellNumFmt(c: CellData): string | NumFmt | undefined {
  return c.style.numFmt;
}

export function cellSetNumFmt(c: CellData, value: string | undefined): void {
  c.style.numFmt = value;
}

export function cellFont(c: CellData): Partial<Font> | undefined {
  return c.style.font;
}

export function cellSetFont(c: CellData, value: Partial<Font> | undefined): void {
  c.style.font = value;
}

export function cellAlignment(c: CellData): Partial<Alignment> | undefined {
  return c.style.alignment;
}

export function cellSetAlignment(c: CellData, value: Partial<Alignment> | undefined): void {
  c.style.alignment = value;
}

export function cellBorder(c: CellData): Partial<Borders> | undefined {
  return c.style.border;
}

export function cellSetBorder(c: CellData, value: Partial<Borders> | undefined): void {
  c.style.border = value;
}

export function cellFill(c: CellData): Fill | undefined {
  return c.style.fill;
}

export function cellSetFill(c: CellData, value: Fill | undefined): void {
  c.style.fill = value;
}

export function cellProtection(c: CellData): Partial<Protection> | undefined {
  return c.style.protection;
}

export function cellSetProtection(c: CellData, value: Partial<Protection> | undefined): void {
  c.style.protection = value;
}

/** Read the cell's full style record (numFmt / font / alignment / border / fill / protection). */
export function cellGetStyle(c: CellData): Partial<Style> {
  return c.style;
}

/** Merge a partial style into the cell's existing style. */
export function cellSetStyle(c: CellData, style: Partial<Style>): void {
  if (style.numFmt !== undefined) {
    c.style.numFmt = style.numFmt;
  }
  if (style.styleName !== undefined) {
    c.style.styleName = style.styleName;
  }
  if (style.font !== undefined) {
    c.style.font = style.font;
  }
  if (style.alignment !== undefined) {
    c.style.alignment = style.alignment;
  }
  if (style.border !== undefined) {
    c.style.border = style.border;
  }
  if (style.fill !== undefined) {
    c.style.fill = style.fill;
  }
  if (style.protection !== undefined) {
    c.style.protection = style.protection;
  }
}

/**
 * Assign a single style facet onto `target`, deep-cloning the value so the
 * target never aliases a shared sub-object (`numFmt` is a primitive and is
 * effectively copied by value). The generic `K` keeps the key and value types
 * linked — a widened `keyof Style` loop variable would collapse the index type
 * to the intersection of all facet types and break assignment.
 */
export function setFacetCloned<K extends keyof Style>(
  target: Partial<Style>,
  key: K,
  value: Style[K] | undefined
): void {
  target[key] = typeof value === "object" && value !== null ? structuredClone(value) : value;
}

/**
 * Assign a single style facet onto `target` by reference (no clone). Companion
 * to {@link setFacetCloned}; the generic `K` exists for the same reason — to
 * keep the key/value index types linked across a `keyof Style` assignment.
 */
export function setFacet<K extends keyof Style>(
  target: Partial<Style>,
  key: K,
  value: Style[K] | undefined
): void {
  target[key] = value;
}

export function cellRow(c: CellData): number {
  return c.row.number;
}

export function cellCol(c: CellData): number {
  return c.column.number;
}

export function cellAbsoluteAddress(c: CellData): string {
  return `$${colCache.n2l(c.column.number)}$${c.row.number}`;
}

export function cellType(c: CellData): ValueType {
  return c._value.type;
}

export function cellEffectiveType(c: CellData): ValueType {
  return c._value.effectiveType;
}

export function cellToCsvString(c: CellData): string {
  return c._value.toCsvString();
}

export function cellGetValue(c: CellData): CellValueType {
  return c._value.value;
}

export function cellSetValue(c: CellData, v: CellValueInputType): void {
  if (cellType(c) === Types.Merge) {
    cellSetValue(c._value.master!, v);
    return;
  }
  c._formulaGhostOwner = undefined;
  c._value.release();
  c._value = Value.create(Value.getType(v), c, v);
}

export function cellAddMergeRef(c: CellData): void {
  c._mergeCount++;
}

export function cellReleaseMergeRef(c: CellData): void {
  c._mergeCount--;
}

export function cellIsMerged(c: CellData): boolean {
  return c._mergeCount > 0 || cellType(c) === Types.Merge;
}

export function cellMerge(c: CellData, master: CellData, ignoreStyle?: boolean): void {
  c._formulaGhostOwner = undefined;
  c._value.release();
  c._value = Value.create(Types.Merge, c, master);
  if (!ignoreStyle) {
    c.style = (copyStyle(master.style) as Partial<Style>) ?? {};
  }
}

export function cellUnmerge(c: CellData): void {
  c._formulaGhostOwner = undefined;
  if (cellType(c) === Types.Merge) {
    c._value.release();
    c._value = Value.create(Types.Null, c);
    c.style = mergeCellStyle(c.row.style, c.column.style, { ...c.style });
  }
}

export function cellIsMergedTo(c: CellData, master: CellData): boolean {
  if (c._value.type !== Types.Merge) {
    return false;
  }
  return c._value.isMergedTo ? c._value.isMergedTo(master) : false;
}

export function cellMaster(c: CellData): CellData {
  if (cellType(c) === Types.Merge) {
    return c._value.master!;
  }
  return c;
}

export function cellIsHyperlink(c: CellData): boolean {
  return c._value.type === Types.Hyperlink;
}

export function cellHyperlink(c: CellData): string | undefined {
  return c._value.hyperlink;
}

export function cellNote(c: CellData): string | NoteConfig | undefined {
  if (!c._comment) {
    return undefined;
  }
  return c._comment.note;
}

export function cellSetNote(c: CellData, note: string | NoteConfig): void {
  c._comment = noteCreate(note);
}

export function cellComment(c: CellData): NoteData | undefined {
  return c._comment;
}

export function cellSetComment(c: CellData, comment: NoteData | NoteConfig | undefined): void {
  if (comment === undefined) {
    c._comment = undefined;
  } else if (isNoteData(comment)) {
    c._comment = comment;
  } else {
    c._comment = noteCreate(comment);
  }
}

export function cellText(c: CellData): string {
  return c._value.toString();
}

export function cellDisplayText(c: CellData): string {
  return getCellDisplayText({
    value: c._value.value,
    numFmt: c.style.numFmt,
    text: c._value.toString()
  });
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;"
};
const HTML_ESCAPE_RE = /["&<>]/g;

export function cellHtml(c: CellData): string {
  return cellText(c).replace(HTML_ESCAPE_RE, ch => HTML_ESCAPE_MAP[ch]);
}

/**
 * A read-only projection of a cell handle: the fields a `CellData` does not
 * expose directly (`value`, `text` and the effective type live behind the
 * internal `_value` box).
 *
 * Every property is a live getter, so reading it reflects the cell's current
 * state. The properties themselves cannot be assigned, but `font` / `alignment`
 * are the cell's **live style objects** — the same references `Cell.getFont` /
 * `Cell.getStyle` return, so writing into them mutates the cell. Copy before
 * editing (`{ ...view.font }`), and write through `Cell.set*` or the `Stream`
 * handle operations.
 *
 * (These facets are deliberately not deeply readonly: every style getter in the
 * library hands back a live reference, and read-modify-write —
 * `Cell.setStyle(ws, a, { ...Cell.getStyle(ws, b) })` — is a supported pattern.
 * Freezing one projection while the rest stay live would be inconsistent.)
 */
export interface CellView {
  readonly value: CellValueType;
  readonly numFmt: string | NumFmt | undefined;
  readonly text: string;
  readonly effectiveType: ValueType;
  readonly font: Partial<Font> | undefined;
  readonly alignment: Partial<Alignment> | undefined;
}

export function cellView(c: CellData): CellView {
  return {
    get value() {
      return c._value.value;
    },
    get numFmt() {
      return c.style.numFmt;
    },
    get text() {
      return c._value.toString();
    },
    get effectiveType() {
      return c._value.effectiveType;
    },
    get font() {
      return c.style.font;
    },
    get alignment() {
      return c.style.alignment;
    }
  };
}

export function cellToString(c: CellData): string {
  return cellText(c);
}

export function _cellUpgradeToHyperlink(c: CellData, hyperlink: string): void {
  switch (cellType(c)) {
    case Types.String: {
      c._value = Value.create(Types.Hyperlink, c, {
        text: String(c._value.value),
        hyperlink
      });
      break;
    }
    case Types.RichText: {
      const current = c._value.value as CellRichTextValue | undefined;
      const runs = current && Array.isArray(current.richText) ? current.richText : [];
      c._value = Value.create(Types.Hyperlink, c, {
        text: flattenRichText(runs),
        richText: runs.length > 0 ? runs : undefined,
        hyperlink
      });
      break;
    }
    default:
      break;
  }
}

export function cellFormula(c: CellData): string | undefined {
  return c._value.formula;
}

export function cellResult(c: CellData): FormulaResult | undefined {
  return c._value.result;
}

export function cellSetResult(c: CellData, value: FormulaResult | undefined): void {
  if (cellType(c) === Types.Formula) {
    c._value.result = value;
  }
}

export function cellFormulaType(c: CellData): FormulaType {
  return c._value.formulaType ?? Enums.FormulaType.None;
}

export function cellFullAddress(c: CellData): DecodedAddress {
  const { worksheet } = c.row;
  return {
    sheetName: worksheet._name,
    address: c.address,
    row: c.row.number,
    col: c.column.number
  };
}

export function cellName(c: CellData): string {
  return cellNames(c)[0];
}

export function cellSetName(c: CellData, value: string): void {
  cellSetNames(c, [value]);
}

export function cellNames(c: CellData): string[] {
  return definedNamesGetNamesEx(cellWorkbook(c)._definedNames, cellFullAddress(c));
}

export function cellSetNames(c: CellData, value: string[]): void {
  const definedNames = cellWorkbook(c)._definedNames;
  definedNamesRemoveAllNames(definedNames, cellFullAddress(c));
  value.forEach(name => {
    definedNamesAddEx(definedNames, cellFullAddress(c), name);
  });
}

export function cellAddName(c: CellData, name: string): void {
  definedNamesAddEx(cellWorkbook(c)._definedNames, cellFullAddress(c), name);
}

export function cellRemoveName(c: CellData, name: string): void {
  definedNamesRemoveEx(cellWorkbook(c)._definedNames, cellFullAddress(c), name);
}

export function cellRemoveAllNames(c: CellData): void {
  definedNamesRemoveAllNames(cellWorkbook(c)._definedNames, cellFullAddress(c));
}

export function cellDataValidation(c: CellData): DataValidationRule | undefined {
  return dataValidationFind(cellWorksheet(c).dataValidations, c.address);
}

export function cellSetDataValidation(c: CellData, value: DataValidationRule): void {
  dataValidationAdd(cellWorksheet(c).dataValidations, c.address, value);
}

export function cellGetModel(c: CellData): CellModel {
  const { model } = c._value;
  model.style = c.style;
  if (c._comment) {
    model.comment = noteModel(c._comment);
  }
  return model;
}

export function cellSetModel(c: CellData, value: CellModel): void {
  c._formulaGhostOwner = undefined;
  c._value.release();
  c._value = Value.create(value.type, c);
  c._value.model = value;
  if (value.comment) {
    switch (value.comment.type) {
      case "note":
        c._comment = noteFromModel(value.comment);
        break;
    }
  }
  if (value.style) {
    c.style = (copyStyle(value.style) as Partial<Style>) ?? {};
  } else {
    c.style = {};
  }
}

// =============================================================================
// Internal Value Types (value-boxing representation; not exposed)

interface NullValueModel {
  address: string;
  type: number;
}
interface NumberValueModel {
  address: string;
  type: number;
  value: number;
}
interface StringValueModel {
  address: string;
  type: number;
  value: string;
}
interface DateValueModel {
  address: string;
  type: number;
  value: Date;
}
interface BooleanValueModel {
  address: string;
  type: number;
  value: boolean;
}
interface HyperlinkValueModel {
  address: string;
  type: number;
  text?: string;
  richText?: RichText[];
  hyperlink?: string;
  tooltip?: string;
}
interface MergeValueModel {
  address: string;
  type: number;
  master?: string;
}
interface FormulaValueModel {
  address: string;
  type: number;
  shareType?: string;
  ref?: string;
  formula?: string;
  sharedFormula?: string;
  result?: FormulaResult;
  isDynamicArray?: boolean;
}
interface SharedStringValueModel {
  address: string;
  type: number;
  value: number;
}
interface RichTextValueModel {
  address: string;
  type: number;
  value: CellRichTextValue;
}
interface ErrorValueModel {
  address: string;
  type: number;
  value: CellErrorValue;
}
interface JSONValueModel {
  address: string;
  type: number;
  value: string;
  rawValue: unknown;
}

class NullValue {
  declare public model: NullValueModel;
  constructor(cell: CellData) {
    this.model = { address: cell.address, type: Types.Null };
  }
  get value(): null {
    return null;
  }
  set value(_value: unknown) {}
  get type(): ValueType {
    return Types.Null;
  }
  get effectiveType(): ValueType {
    return Types.Null;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return "";
  }
  release(): void {}
  toString(): string {
    return "";
  }
}

class NumberValue {
  declare public model: NumberValueModel;
  constructor(cell: CellData, value: number) {
    this.model = { address: cell.address, type: Types.Number, value };
  }
  get value(): number {
    return this.model.value;
  }
  set value(value: number) {
    this.model.value = value;
  }
  get type(): ValueType {
    return Types.Number;
  }
  get effectiveType(): ValueType {
    return Types.Number;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return this.model.value.toString();
  }
  release(): void {}
  toString(): string {
    return this.model.value.toString();
  }
}

class StringValue {
  declare public model: StringValueModel;
  constructor(cell: CellData, value: string) {
    this.model = { address: cell.address, type: Types.String, value };
  }
  get value(): string {
    return this.model.value;
  }
  set value(value: string) {
    this.model.value = value;
  }
  get type(): ValueType {
    return Types.String;
  }
  get effectiveType(): ValueType {
    return Types.String;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return `"${this.model.value.replace(/"/g, '""')}"`;
  }
  release(): void {}
  toString(): string {
    return this.model.value;
  }
}

class RichTextValue {
  declare public model: RichTextValueModel;
  constructor(cell: CellData, value: CellRichTextValue) {
    this.model = { address: cell.address, type: Types.String, value };
  }
  get value(): CellRichTextValue {
    return this.model.value;
  }
  set value(value: CellRichTextValue) {
    this.model.value = value;
  }
  toString(): string {
    return this.model.value.richText.map(t => t.text).join("");
  }
  get type(): ValueType {
    return Types.RichText;
  }
  get effectiveType(): ValueType {
    return Types.RichText;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  get text(): string {
    return this.toString();
  }
  toCsvString(): string {
    return `"${this.text.replace(/"/g, '""')}"`;
  }
  release(): void {}
}

class DateValue {
  declare public model: DateValueModel;
  constructor(cell: CellData, value: Date) {
    this.model = { address: cell.address, type: Types.Date, value };
  }
  get value(): Date {
    return this.model.value;
  }
  set value(value: Date) {
    this.model.value = value;
  }
  get type(): ValueType {
    return Types.Date;
  }
  get effectiveType(): ValueType {
    return Types.Date;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return this.model.value.toISOString();
  }
  release(): void {}
  toString(): string {
    return this.model.value.toString();
  }
}

class HyperlinkValue {
  declare public model: HyperlinkValueModel;
  constructor(cell: CellData, value?: CellHyperlinkValueInput | CellFormulaHyperlinkValue) {
    this.model = { address: cell.address, type: Types.Hyperlink };
    if (value) {
      if ("formula" in value && typeof value.formula === "string") {
        const fh = value as CellFormulaHyperlinkValue;
        const display = fh.result === undefined || fh.result === null ? "" : String(fh.result);
        this.model.text = display;
        this.model.hyperlink = fh.hyperlink ?? "";
        if (fh.tooltip !== undefined) {
          this.model.tooltip = fh.tooltip;
        }
        (this.model as HyperlinkValueModel & { formula?: string; result?: FormulaResult }).formula =
          fh.formula;
        if (fh.result !== undefined) {
          (this.model as HyperlinkValueModel & { result?: FormulaResult }).result = fh.result;
        }
        return;
      }
      const normalized = normalizeHyperlinkValue(value as CellHyperlinkValueInput);
      this.model.text = normalized.text;
      this.model.hyperlink = normalized.hyperlink;
      if (normalized.richText) {
        this.model.richText = normalized.richText;
      }
      if (normalized.tooltip !== undefined) {
        this.model.tooltip = normalized.tooltip;
      }
    }
  }
  get value(): CellHyperlinkValue {
    const out: CellHyperlinkValue = {
      text: this.model.text ?? "",
      hyperlink: this.model.hyperlink ?? ""
    };
    if (this.model.richText && this.model.richText.length > 0) {
      out.richText = this.model.richText;
    }
    if (this.model.tooltip !== undefined) {
      out.tooltip = this.model.tooltip;
    }
    return out;
  }
  set value(value: CellHyperlinkValueInput) {
    const normalized = normalizeHyperlinkValue(value);
    this.model.text = normalized.text;
    this.model.hyperlink = normalized.hyperlink;
    if (normalized.richText) {
      this.model.richText = normalized.richText;
    } else {
      delete this.model.richText;
    }
    if (normalized.tooltip !== undefined) {
      this.model.tooltip = normalized.tooltip;
    } else {
      delete this.model.tooltip;
    }
  }
  get text(): string | undefined {
    return this.model.text;
  }
  set text(value: string | undefined) {
    if (this.model.richText) {
      delete this.model.richText;
    }
    this.model.text = value;
  }
  get richText(): RichText[] | undefined {
    return this.model.richText;
  }
  set richText(value: RichText[] | undefined) {
    if (Array.isArray(value) && value.length > 0) {
      this.model.richText = value;
      this.model.text = flattenRichText(value);
    } else {
      delete this.model.richText;
    }
  }
  get hyperlink(): string | undefined {
    return this.model.hyperlink;
  }
  set hyperlink(value: string | undefined) {
    this.model.hyperlink = value;
  }
  get formula(): string | undefined {
    return (this.model as HyperlinkValueModel & { formula?: string }).formula;
  }
  get result(): FormulaResult | undefined {
    return (this.model as HyperlinkValueModel & { result?: FormulaResult }).result;
  }
  get type(): ValueType {
    return Types.Hyperlink;
  }
  get effectiveType(): ValueType {
    return Types.Hyperlink;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return this.model.hyperlink ?? "";
  }
  release(): void {}
  toString(): string {
    return this.model.text ?? "";
  }
}

class MergeValue {
  declare public model: MergeValueModel;
  declare private _master: CellData;
  constructor(cell: CellData, master?: CellData) {
    this.model = {
      address: cell.address,
      type: Types.Merge,
      master: master ? master.address : undefined
    };
    this._master = master as CellData;
    if (master) {
      cellAddMergeRef(master);
    }
  }
  get value(): CellValueType {
    return cellGetValue(this._master);
  }
  set value(value: CellValueInputType | CellData) {
    if (isCellData(value)) {
      if (this._master) {
        cellReleaseMergeRef(this._master);
      }
      cellAddMergeRef(value);
      this._master = value;
    } else {
      cellSetValue(this._master, value);
    }
  }
  isMergedTo(master: CellData): boolean {
    return master === this._master;
  }
  get master(): CellData {
    return this._master;
  }
  get type(): ValueType {
    return Types.Merge;
  }
  get effectiveType(): ValueType {
    return cellEffectiveType(this._master);
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return "";
  }
  release(): void {
    cellReleaseMergeRef(this._master);
  }
  toString(): string {
    return this.value != null ? this.value.toString() : "";
  }
}

class FormulaValue {
  declare public cell: CellData;
  declare public model: FormulaValueModel;
  declare private _translatedFormula?: string;
  constructor(cell: CellData, value?: FormulaValueData) {
    this.cell = cell;
    this.model = {
      address: cell.address,
      type: Types.Formula,
      shareType: value ? value.shareType : undefined,
      ref: value ? value.ref : undefined,
      formula: value ? value.formula : undefined,
      sharedFormula: value ? value.sharedFormula : undefined,
      result: value ? value.result : undefined,
      isDynamicArray: value ? value.isDynamicArray : undefined
    };
  }
  private _copyModel(model: FormulaValueModel): FormulaValueData {
    const copy: FormulaValueData = {};
    if (model.formula) {
      copy.formula = model.formula;
    }
    if (model.result !== undefined) {
      copy.result = model.result;
    }
    if (model.ref) {
      copy.ref = model.ref;
    }
    if (model.shareType) {
      copy.shareType = model.shareType;
    }
    if (model.sharedFormula) {
      copy.sharedFormula = model.sharedFormula;
    }
    if (model.isDynamicArray) {
      copy.isDynamicArray = model.isDynamicArray;
    }
    return copy;
  }
  get value(): FormulaValueData {
    return this._copyModel(this.model);
  }
  set value(value: FormulaValueData) {
    if (value.formula) {
      this.model.formula = value.formula;
    }
    if (value.result !== undefined) {
      this.model.result = value.result;
    }
    if (value.ref) {
      this.model.ref = value.ref;
    }
    if (value.shareType) {
      this.model.shareType = value.shareType;
    }
    if (value.sharedFormula) {
      this.model.sharedFormula = value.sharedFormula;
    }
    if (value.isDynamicArray !== undefined) {
      this.model.isDynamicArray = value.isDynamicArray;
    }
  }
  validate(value: CellValueType): void {
    switch (Value.getType(value)) {
      case Types.Null:
      case Types.String:
      case Types.Number:
      case Types.Date:
        break;
      case Types.Hyperlink:
      case Types.Formula:
      default:
        throw new InvalidValueTypeError(
          String(Value.getType(value)),
          "Cannot process that type of result value"
        );
    }
  }
  get dependencies(): { ranges: string[] | null; cells: string[] | null } {
    const ranges = this.formula.match(/([a-zA-Z0-9]+!)?[A-Z]{1,3}\d{1,4}:[A-Z]{1,3}\d{1,4}/g);
    const cells = this.formula
      .replace(/([a-zA-Z0-9]+!)?[A-Z]{1,3}\d{1,4}:[A-Z]{1,3}\d{1,4}/g, "")
      .match(/([a-zA-Z0-9]+!)?[A-Z]{1,3}\d{1,4}/g);
    return { ranges, cells };
  }
  get formula(): string {
    return this.model.formula || this._getTranslatedFormula() || "";
  }
  set formula(value: string) {
    this.model.formula = value;
  }
  get formulaType(): FormulaType {
    if (this.model.formula) {
      return Enums.FormulaType.Master;
    }
    if (this.model.sharedFormula) {
      return Enums.FormulaType.Shared;
    }
    return Enums.FormulaType.None;
  }
  get result(): FormulaResult | undefined {
    return this.model.result;
  }
  set result(value: FormulaResult | undefined) {
    this.model.result = value;
  }
  get type(): ValueType {
    return Types.Formula;
  }
  get effectiveType(): ValueType {
    const v = this.model.result;
    if (v === null || v === undefined) {
      return Enums.ValueType.Null;
    }
    if (typeof v === "string") {
      return Enums.ValueType.String;
    }
    if (typeof v === "number") {
      return Enums.ValueType.Number;
    }
    if (v instanceof Date) {
      return Enums.ValueType.Date;
    }
    if (typeof v === "object" && "error" in v) {
      return Enums.ValueType.Error;
    }
    return Enums.ValueType.Null;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  _getTranslatedFormula(): string | undefined {
    if (!this._translatedFormula && this.model.sharedFormula) {
      const { worksheet } = this.cell.row;
      const addr = colCache.getAddress(this.model.sharedFormula);
      const masterRow = worksheet._rows[addr.row - 1];
      const master = masterRow ? masterRow.cells[addr.col - 1] : undefined;
      this._translatedFormula =
        master && cellFormula(master)
          ? slideFormula(cellFormula(master)!, master.address, this.model.address)
          : undefined;
    }
    return this._translatedFormula;
  }
  toCsvString(): string {
    return `${this.model.result ?? ""}`;
  }
  release(): void {}
  toString(): string {
    return this.model.result ? this.model.result.toString() : "";
  }
}

class SharedStringValue {
  declare public model: SharedStringValueModel;
  constructor(cell: CellData, value: number) {
    this.model = { address: cell.address, type: Types.SharedString, value };
  }
  get value(): number {
    return this.model.value;
  }
  set value(value: number) {
    this.model.value = value;
  }
  get type(): ValueType {
    return Types.SharedString;
  }
  get effectiveType(): ValueType {
    return Types.SharedString;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return this.model.value.toString();
  }
  release(): void {}
  toString(): string {
    return this.model.value.toString();
  }
}

class BooleanValue {
  declare public model: BooleanValueModel;
  constructor(cell: CellData, value: boolean) {
    this.model = { address: cell.address, type: Types.Boolean, value };
  }
  get value(): boolean {
    return this.model.value;
  }
  set value(value: boolean) {
    this.model.value = value;
  }
  get type(): ValueType {
    return Types.Boolean;
  }
  get effectiveType(): ValueType {
    return Types.Boolean;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): number {
    return this.model.value ? 1 : 0;
  }
  release(): void {}
  toString(): string {
    return this.model.value.toString();
  }
}

interface CheckboxValueModel extends CellModel {
  type: typeof Types.Checkbox;
  value: boolean;
}

class CheckboxValue {
  declare public model: CheckboxValueModel;
  constructor(cell: CellData, value: CellCheckboxValue) {
    this.model = { address: cell.address, type: Types.Checkbox, value: value.checkbox };
  }
  get value(): CellCheckboxValue {
    return { checkbox: this.model.value };
  }
  set value(value: CellCheckboxValue) {
    this.model.value = value.checkbox;
  }
  get type(): ValueType {
    return Types.Checkbox;
  }
  get effectiveType(): ValueType {
    return Types.Boolean;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): number {
    return this.model.value ? 1 : 0;
  }
  release(): void {}
  toString(): string {
    return this.model.value.toString();
  }
}

class ErrorValue {
  declare public model: ErrorValueModel;
  constructor(cell: CellData, value: CellErrorValue) {
    this.model = { address: cell.address, type: Types.Error, value };
  }
  get value(): CellErrorValue {
    return this.model.value;
  }
  set value(value: CellErrorValue) {
    this.model.value = value;
  }
  get type(): ValueType {
    return Types.Error;
  }
  get effectiveType(): ValueType {
    return Types.Error;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return this.toString();
  }
  release(): void {}
  toString(): string {
    return this.model.value.error.toString();
  }
}

class JSONValue {
  declare public model: JSONValueModel;
  constructor(cell: CellData, value: unknown) {
    this.model = {
      address: cell.address,
      type: Types.String,
      value: JSON.stringify(value),
      rawValue: value
    };
  }
  get value(): unknown {
    return this.model.rawValue;
  }
  set value(value: unknown) {
    this.model.rawValue = value;
    this.model.value = JSON.stringify(value);
  }
  get type(): ValueType {
    return Types.String;
  }
  get effectiveType(): ValueType {
    return Types.String;
  }
  get address(): string {
    return this.model.address;
  }
  set address(value: string) {
    this.model.address = value;
  }
  toCsvString(): string {
    return this.model.value;
  }
  release(): void {}
  toString(): string {
    return this.model.value;
  }
}

/** Discriminate a CellData record from a CellValue input. */
function isCellData(v: unknown): v is CellData {
  return !!v && typeof v === "object" && "_value" in v && "row" in v && "column" in v;
}

// Value is a place to hold common Value type functions.
const Value = {
  getType(value: CellValueInputType): number {
    if (value === null || value === undefined) {
      return Types.Null;
    }
    if (typeof value === "string") {
      return Types.String;
    }
    if (typeof value === "number") {
      return Types.Number;
    }
    if (typeof value === "boolean") {
      return Types.Boolean;
    }
    if (value instanceof Date) {
      return Types.Date;
    }
    if (typeof value === "object") {
      if ("checkbox" in value && typeof value.checkbox === "boolean") {
        return Types.Checkbox;
      }
      if ("hyperlink" in value && typeof value.hyperlink === "string" && value.hyperlink) {
        const hasText = "text" in value && typeof value.text === "string" && value.text.length > 0;
        const hasRichText =
          "richText" in value && Array.isArray(value.richText) && value.richText.length > 0;
        const hasFormula =
          "formula" in value && typeof (value as { formula?: unknown }).formula === "string";
        if (hasText || hasRichText || hasFormula) {
          return Types.Hyperlink;
        }
      }
      if (
        ("formula" in value && value.formula) ||
        ("sharedFormula" in value && value.sharedFormula)
      ) {
        return Types.Formula;
      }
      if ("richText" in value && Array.isArray(value.richText) && value.richText.length > 0) {
        return Types.RichText;
      }
      if ("sharedString" in value && value.sharedString) {
        return Types.SharedString;
      }
      if ("error" in value && value.error) {
        return Types.Error;
      }
    }
    return Types.JSON;
  },

  types: [
    { t: Types.Null, f: NullValue },
    { t: Types.Number, f: NumberValue },
    { t: Types.String, f: StringValue },
    { t: Types.Date, f: DateValue },
    { t: Types.Hyperlink, f: HyperlinkValue },
    { t: Types.Formula, f: FormulaValue },
    { t: Types.Merge, f: MergeValue },
    { t: Types.JSON, f: JSONValue },
    { t: Types.SharedString, f: SharedStringValue },
    { t: Types.RichText, f: RichTextValue },
    { t: Types.Boolean, f: BooleanValue },
    { t: Types.Error, f: ErrorValue },
    { t: Types.Checkbox, f: CheckboxValue }
  ].reduce(
    (
      p: (
        | typeof NullValue
        | typeof NumberValue
        | typeof StringValue
        | typeof DateValue
        | typeof HyperlinkValue
        | typeof FormulaValue
        | typeof MergeValue
        | typeof JSONValue
        | typeof SharedStringValue
        | typeof RichTextValue
        | typeof BooleanValue
        | typeof ErrorValue
        | typeof CheckboxValue
      )[],
      t
    ) => {
      p[t.t] = t.f;
      return p;
    },
    []
  ),

  create(type: number, cell: CellData, value?: CellValueInputType | CellData): ICellValue {
    const T = this.types[type];
    if (!T) {
      throw new InvalidValueTypeError(String(type), "Could not create Value");
    }
    return new T(cell, value as never) as unknown as ICellValue;
  }
};
