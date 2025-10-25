import { colCache } from "../utils/col-cache.js";
import { Enums } from "./enums.js";
import { Note } from "./note.js";
import { escapeHtml } from "../utils/under-dash.js";
import { slideFormula } from "../utils/shared-formula.js";

interface HyperlinkValueData {
  text?: string;
  hyperlink?: string;
  tooltip?: string;
}

interface FormulaValueData {
  shareType?: string;
  ref?: string;
  formula?: string;
  sharedFormula?: string;
  result?: any;
}

interface FullAddress {
  sheetName: string;
  address: string;
  row: number;
  col: number;
}

interface CellModel {
  address: string;
  type: number;
  value?: any;
  style?: any;
  comment?: any;
  text?: string;
  hyperlink?: string;
  tooltip?: string;
  master?: string;
  shareType?: string;
  ref?: string;
  formula?: string;
  sharedFormula?: string;
  result?: any;
  richText?: any[];
  sharedString?: any;
  error?: any;
  rawValue?: any;
}

// Cell requirements
//  Operate inside a worksheet
//  Store and retrieve a value with a range of types: text, number, date, hyperlink, reference, formula, etc.
//  Manage/use and manipulate cell format either as local to cell or inherited from column or row.

class Cell {
  static Types = Enums.ValueType;

  // Type declarations only - no runtime overhead
  declare public _row: any;
  declare public _column: any;
  declare public _address: string;
  declare public _value: any;
  declare public style: any;
  declare public _mergeCount: number;
  declare public _comment?: any;

  constructor(row: any, column: any, address: string) {
    if (!row || !column) {
      throw new Error("A Cell needs a Row");
    }

    this._row = row;
    this._column = column;

    colCache.validateAddress(address);
    this._address = address;

    // TODO: lazy evaluation of this._value
    this._value = Value.create(Cell.Types.Null, this);

    this.style = this._mergeStyle(row.style, column.style, {});

    this._mergeCount = 0;
  }

  get worksheet(): any {
    return this._row.worksheet;
  }

  get workbook(): any {
    return this._row.worksheet.workbook;
  }

  // help GC by removing cyclic (and other) references
  destroy(): void {
    delete this.style;
    delete this._value;
    delete this._row;
    delete this._column;
    delete this._address;
  }

  // =========================================================================
  // Styles stuff
  get numFmt(): any {
    return this.style.numFmt;
  }

  set numFmt(value: any) {
    this.style.numFmt = value;
  }

  get font(): any {
    return this.style.font;
  }

  set font(value: any) {
    this.style.font = value;
  }

  get alignment(): any {
    return this.style.alignment;
  }

  set alignment(value: any) {
    this.style.alignment = value;
  }

  get border(): any {
    return this.style.border;
  }

  set border(value: any) {
    this.style.border = value;
  }

  get fill(): any {
    return this.style.fill;
  }

  set fill(value: any) {
    this.style.fill = value;
  }

  get protection(): any {
    return this.style.protection;
  }

  set protection(value: any) {
    this.style.protection = value;
  }

  _mergeStyle(rowStyle: any, colStyle: any, style: any): any {
    const numFmt = (rowStyle && rowStyle.numFmt) || (colStyle && colStyle.numFmt);
    if (numFmt) {
      style.numFmt = numFmt;
    }

    const font = (rowStyle && rowStyle.font) || (colStyle && colStyle.font);
    if (font) {
      style.font = font;
    }

    const alignment = (rowStyle && rowStyle.alignment) || (colStyle && colStyle.alignment);
    if (alignment) {
      style.alignment = alignment;
    }

    const border = (rowStyle && rowStyle.border) || (colStyle && colStyle.border);
    if (border) {
      style.border = border;
    }

    const fill = (rowStyle && rowStyle.fill) || (colStyle && colStyle.fill);
    if (fill) {
      style.fill = fill;
    }

    const protection = (rowStyle && rowStyle.protection) || (colStyle && colStyle.protection);
    if (protection) {
      style.protection = protection;
    }

    return style;
  }

  // =========================================================================
  // return the address for this cell
  get address(): string {
    return this._address;
  }

  get row(): number {
    return this._row.number;
  }

  get col(): number {
    return this._column.number;
  }

  get $col$row(): string {
    return `$${this._column.letter}$${this.row}`;
  }

  // =========================================================================
  // Value stuff

  get type(): number {
    return this._value.type;
  }

  get effectiveType(): number {
    return this._value.effectiveType;
  }

  toCsvString(): string {
    return this._value.toCsvString();
  }

  // =========================================================================
  // Merge stuff

  addMergeRef(): void {
    this._mergeCount++;
  }

  releaseMergeRef(): void {
    this._mergeCount--;
  }

  get isMerged(): boolean {
    return this._mergeCount > 0 || this.type === Cell.Types.Merge;
  }

  merge(master: Cell, ignoreStyle?: boolean): void {
    this._value.release();
    this._value = Value.create(Cell.Types.Merge, this, master);
    if (!ignoreStyle) {
      this.style = master.style;
    }
  }

  unmerge(): void {
    if (this.type === Cell.Types.Merge) {
      this._value.release();
      this._value = Value.create(Cell.Types.Null, this);
      this.style = this._mergeStyle(this._row.style, this._column.style, {});
    }
  }

  isMergedTo(master: Cell): boolean {
    if (this._value.type !== Cell.Types.Merge) {
      return false;
    }
    return this._value.isMergedTo(master);
  }

  get master(): Cell {
    if (this.type === Cell.Types.Merge) {
      return this._value.master;
    }
    return this; // an unmerged cell is its own master
  }

  get isHyperlink(): boolean {
    return this._value.type === Cell.Types.Hyperlink;
  }

  get hyperlink(): string | undefined {
    return this._value.hyperlink;
  }

  // return the value
  get value(): any {
    return this._value.value;
  }

  // set the value - can be number, string or raw
  set value(v: any) {
    // special case - merge cells set their master's value
    if (this.type === Cell.Types.Merge) {
      this._value.master.value = v;
      return;
    }

    this._value.release();

    // assign value
    this._value = Value.create(Value.getType(v), this, v);
  }

  get note(): string | undefined {
    return this._comment && this._comment.note;
  }

  set note(note: string) {
    this._comment = new Note(note);
  }

  get text(): string {
    return this._value.toString();
  }

  get html(): string {
    return escapeHtml(this.text);
  }

  toString(): string {
    return this.text;
  }

  _upgradeToHyperlink(hyperlink: string): void {
    // if this cell is a string, turn it into a Hyperlink
    if (this.type === Cell.Types.String) {
      this._value = Value.create(Cell.Types.Hyperlink, this, {
        text: this._value.value,
        hyperlink
      });
    }
  }

  // =========================================================================
  // Formula stuff
  get formula(): string | undefined {
    return this._value.formula;
  }

  get result(): any {
    return this._value.result;
  }

  get formulaType(): number {
    return this._value.formulaType;
  }

  // =========================================================================
  // Name stuff
  get fullAddress(): FullAddress {
    const { worksheet } = this._row;
    return {
      sheetName: worksheet.name,
      address: this.address,
      row: this.row,
      col: this.col
    };
  }

  get name(): string {
    return this.names[0];
  }

  set name(value: string) {
    this.names = [value];
  }

  get names(): string[] {
    return this.workbook.definedNames.getNamesEx(this.fullAddress);
  }

  set names(value: string[]) {
    const { definedNames } = this.workbook;
    definedNames.removeAllNames(this.fullAddress);
    value.forEach(name => {
      definedNames.addEx(this.fullAddress, name);
    });
  }

  addName(name: string): void {
    this.workbook.definedNames.addEx(this.fullAddress, name);
  }

  removeName(name: string): void {
    this.workbook.definedNames.removeEx(this.fullAddress, name);
  }

  removeAllNames(): void {
    this.workbook.definedNames.removeAllNames(this.fullAddress);
  }

  // =========================================================================
  // Data Validation stuff
  get _dataValidations(): any {
    return this.worksheet.dataValidations;
  }

  get dataValidation(): any {
    return this._dataValidations.find(this.address);
  }

  set dataValidation(value: any) {
    this._dataValidations.add(this.address, value);
  }

  // =========================================================================
  // Model stuff

  get model(): CellModel {
    const { model } = this._value;
    model.style = this.style;
    if (this._comment) {
      model.comment = this._comment.model;
    }
    return model;
  }

  set model(value: CellModel) {
    this._value.release();
    this._value = Value.create(value.type, this);
    this._value.model = value;

    if (value.comment) {
      switch (value.comment.type) {
        case "note":
          this._comment = Note.fromModel(value.comment);
          break;
      }
    }

    if (value.style) {
      this.style = value.style;
    } else {
      this.style = {};
    }
  }
}

// =============================================================================
// Internal Value Types

class NullValue {
  declare public model: CellModel;

  constructor(cell: Cell) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Null
    };
  }

  get value(): null {
    return null;
  }

  set value(_value: any) {
    // nothing to do
  }

  get type(): number {
    return Cell.Types.Null;
  }

  get effectiveType(): number {
    return Cell.Types.Null;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: number) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Number,
      value
    };
  }

  get value(): number {
    return this.model.value;
  }

  set value(value: number) {
    this.model.value = value;
  }

  get type(): number {
    return Cell.Types.Number;
  }

  get effectiveType(): number {
    return Cell.Types.Number;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: string) {
    this.model = {
      address: cell.address,
      type: Cell.Types.String,
      value
    };
  }

  get value(): string {
    return this.model.value;
  }

  set value(value: string) {
    this.model.value = value;
  }

  get type(): number {
    return Cell.Types.String;
  }

  get effectiveType(): number {
    return Cell.Types.String;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: any) {
    this.model = {
      address: cell.address,
      type: Cell.Types.String,
      value
    };
  }

  get value(): any {
    return this.model.value;
  }

  set value(value: any) {
    this.model.value = value;
  }

  toString(): string {
    return this.model.value.richText.map((t: any) => t.text).join("");
  }

  get type(): number {
    return Cell.Types.RichText;
  }

  get effectiveType(): number {
    return Cell.Types.RichText;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: Date) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Date,
      value
    };
  }

  get value(): Date {
    return this.model.value;
  }

  set value(value: Date) {
    this.model.value = value;
  }

  get type(): number {
    return Cell.Types.Date;
  }

  get effectiveType(): number {
    return Cell.Types.Date;
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
  declare public model: CellModel;

  constructor(cell: Cell, value?: HyperlinkValueData) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Hyperlink,
      text: value ? value.text : undefined,
      hyperlink: value ? value.hyperlink : undefined
    };
    if (value && value.tooltip) {
      this.model.tooltip = value.tooltip;
    }
  }

  get value(): HyperlinkValueData {
    const v: HyperlinkValueData = {
      text: this.model.text,
      hyperlink: this.model.hyperlink
    };
    if (this.model.tooltip) {
      v.tooltip = this.model.tooltip;
    }
    return v;
  }

  set value(value: HyperlinkValueData) {
    this.model.text = value.text;
    this.model.hyperlink = value.hyperlink;
    if (value.tooltip) {
      this.model.tooltip = value.tooltip;
    }
  }

  get text(): string | undefined {
    return this.model.text;
  }

  set text(value: string | undefined) {
    this.model.text = value;
  }

  get hyperlink(): string | undefined {
    return this.model.hyperlink;
  }

  set hyperlink(value: string | undefined) {
    this.model.hyperlink = value;
  }

  get type(): number {
    return Cell.Types.Hyperlink;
  }

  get effectiveType(): number {
    return Cell.Types.Hyperlink;
  }

  get address(): string {
    return this.model.address;
  }

  set address(value: string) {
    this.model.address = value;
  }

  toCsvString(): string {
    return this.model.hyperlink || "";
  }

  release(): void {}

  toString(): string {
    return this.model.text || "";
  }
}

class MergeValue {
  declare public model: CellModel;
  declare public _master: Cell;

  constructor(cell: Cell, master?: Cell) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Merge,
      master: master ? master.address : undefined
    };
    this._master = master as Cell;
    if (master) {
      master.addMergeRef();
    }
  }

  get value(): any {
    return this._master.value;
  }

  set value(value: any) {
    if (value instanceof Cell) {
      if (this._master) {
        this._master.releaseMergeRef();
      }
      value.addMergeRef();
      this._master = value;
    } else {
      this._master.value = value;
    }
  }

  isMergedTo(master: Cell): boolean {
    return master === this._master;
  }

  get master(): Cell {
    return this._master;
  }

  get type(): number {
    return Cell.Types.Merge;
  }

  get effectiveType(): number {
    return this._master.effectiveType;
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
    this._master.releaseMergeRef();
  }

  toString(): string {
    return this.value.toString();
  }
}

class FormulaValue {
  declare public cell: Cell;
  declare public model: CellModel;
  declare public _translatedFormula?: string;

  constructor(cell: Cell, value?: FormulaValueData) {
    this.cell = cell;

    this.model = {
      address: cell.address,
      type: Cell.Types.Formula,
      shareType: value ? value.shareType : undefined,
      ref: value ? value.ref : undefined,
      formula: value ? value.formula : undefined,
      sharedFormula: value ? value.sharedFormula : undefined,
      result: value ? value.result : undefined
    };
  }

  _copyModel(model: CellModel): any {
    const copy: any = {};
    const cp = (name: string) => {
      const value = (model as any)[name];
      if (value) {
        copy[name] = value;
      }
    };
    cp("formula");
    cp("result");
    cp("ref");
    cp("shareType");
    cp("sharedFormula");
    return copy;
  }

  get value(): any {
    return this._copyModel(this.model);
  }

  set value(value: any) {
    this.model = this._copyModel(value);
  }

  validate(value: any): void {
    switch (Value.getType(value)) {
      case Cell.Types.Null:
      case Cell.Types.String:
      case Cell.Types.Number:
      case Cell.Types.Date:
        break;
      case Cell.Types.Hyperlink:
      case Cell.Types.Formula:
      default:
        throw new Error("Cannot process that type of result value");
    }
  }

  get dependencies(): { ranges: string[] | null; cells: string[] | null } {
    // find all the ranges and cells mentioned in the formula
    const ranges = this.formula.match(/([a-zA-Z0-9]+!)?[A-Z]{1,3}\d{1,4}:[A-Z]{1,3}\d{1,4}/g);
    const cells = this.formula
      .replace(/([a-zA-Z0-9]+!)?[A-Z]{1,3}\d{1,4}:[A-Z]{1,3}\d{1,4}/g, "")
      .match(/([a-zA-Z0-9]+!)?[A-Z]{1,3}\d{1,4}/g);
    return {
      ranges,
      cells
    };
  }

  get formula(): string {
    return this.model.formula || this._getTranslatedFormula() || "";
  }

  set formula(value: string) {
    this.model.formula = value;
  }

  get formulaType(): number {
    if (this.model.formula) {
      return Enums.FormulaType.Master;
    }
    if (this.model.sharedFormula) {
      return Enums.FormulaType.Shared;
    }
    return Enums.FormulaType.None;
  }

  get result(): any {
    return this.model.result;
  }

  set result(value: any) {
    this.model.result = value;
  }

  get type(): number {
    return Cell.Types.Formula;
  }

  get effectiveType(): number {
    const v = this.model.result;
    if (v === null || v === undefined) {
      return Enums.ValueType.Null;
    }
    if (v instanceof String || typeof v === "string") {
      return Enums.ValueType.String;
    }
    if (typeof v === "number") {
      return Enums.ValueType.Number;
    }
    if (v instanceof Date) {
      return Enums.ValueType.Date;
    }
    if (v.text && v.hyperlink) {
      return Enums.ValueType.Hyperlink;
    }
    if (v.formula) {
      return Enums.ValueType.Formula;
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
      const { worksheet } = this.cell;
      const master = worksheet.findCell(this.model.sharedFormula);
      this._translatedFormula =
        master && slideFormula(master.formula, master.address, this.model.address);
    }
    return this._translatedFormula;
  }

  toCsvString(): string {
    return `${this.model.result || ""}`;
  }

  release(): void {}

  toString(): string {
    return this.model.result ? this.model.result.toString() : "";
  }
}

class SharedStringValue {
  declare public model: CellModel;

  constructor(cell: Cell, value: any) {
    this.model = {
      address: cell.address,
      type: Cell.Types.SharedString,
      value
    };
  }

  get value(): any {
    return this.model.value;
  }

  set value(value: any) {
    this.model.value = value;
  }

  get type(): number {
    return Cell.Types.SharedString;
  }

  get effectiveType(): number {
    return Cell.Types.SharedString;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: boolean) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Boolean,
      value
    };
  }

  get value(): boolean {
    return this.model.value;
  }

  set value(value: boolean) {
    this.model.value = value;
  }

  get type(): number {
    return Cell.Types.Boolean;
  }

  get effectiveType(): number {
    return Cell.Types.Boolean;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: any) {
    this.model = {
      address: cell.address,
      type: Cell.Types.Error,
      value
    };
  }

  get value(): any {
    return this.model.value;
  }

  set value(value: any) {
    this.model.value = value;
  }

  get type(): number {
    return Cell.Types.Error;
  }

  get effectiveType(): number {
    return Cell.Types.Error;
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
  declare public model: CellModel;

  constructor(cell: Cell, value: any) {
    this.model = {
      address: cell.address,
      type: Cell.Types.String,
      value: JSON.stringify(value),
      rawValue: value
    };
  }

  get value(): any {
    return this.model.rawValue;
  }

  set value(value: any) {
    this.model.rawValue = value;
    this.model.value = JSON.stringify(value);
  }

  get type(): number {
    return Cell.Types.String;
  }

  get effectiveType(): number {
    return Cell.Types.String;
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

// Value is a place to hold common static Value type functions
const Value = {
  getType(value: any): number {
    if (value === null || value === undefined) {
      return Cell.Types.Null;
    }
    if (value instanceof String || typeof value === "string") {
      return Cell.Types.String;
    }
    if (typeof value === "number") {
      return Cell.Types.Number;
    }
    if (typeof value === "boolean") {
      return Cell.Types.Boolean;
    }
    if (value instanceof Date) {
      return Cell.Types.Date;
    }
    if (value.text && value.hyperlink) {
      return Cell.Types.Hyperlink;
    }
    if (value.formula || value.sharedFormula) {
      return Cell.Types.Formula;
    }
    if (value.richText) {
      return Cell.Types.RichText;
    }
    if (value.sharedString) {
      return Cell.Types.SharedString;
    }
    if (value.error) {
      return Cell.Types.Error;
    }
    return Cell.Types.JSON;
  },

  // map valueType to constructor
  types: [
    { t: Cell.Types.Null, f: NullValue },
    { t: Cell.Types.Number, f: NumberValue },
    { t: Cell.Types.String, f: StringValue },
    { t: Cell.Types.Date, f: DateValue },
    { t: Cell.Types.Hyperlink, f: HyperlinkValue },
    { t: Cell.Types.Formula, f: FormulaValue },
    { t: Cell.Types.Merge, f: MergeValue },
    { t: Cell.Types.JSON, f: JSONValue },
    { t: Cell.Types.SharedString, f: SharedStringValue },
    { t: Cell.Types.RichText, f: RichTextValue },
    { t: Cell.Types.Boolean, f: BooleanValue },
    { t: Cell.Types.Error, f: ErrorValue }
  ].reduce((p: any[], t: any) => {
    p[t.t] = t.f;
    return p;
  }, []),

  create(type: number, cell: Cell, value?: any): any {
    const T = this.types[type];
    if (!T) {
      throw new Error(`Could not create Value of type ${type}`);
    }
    return new T(cell, value);
  }
};

export { Cell };
