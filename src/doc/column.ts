import { colCache } from "../utils/col-cache.js";
import { isEqual } from "../utils/under-dash.js";
import { Enums } from "./enums.js";

const DEFAULT_COLUMN_WIDTH = 9;

interface ColumnDefn {
  header?: any;
  key?: string;
  width?: number;
  outlineLevel?: number;
  hidden?: boolean;
  style?: any;
}

interface ColumnModel {
  min: number;
  max: number;
  width?: number;
  style?: any;
  isCustomWidth?: boolean;
  hidden?: boolean;
  outlineLevel?: number;
  collapsed?: boolean;
}

// Column defines the column properties for 1 column.
// This includes header rows, widths, key, (style), etc.
// Worksheet will condense the columns as appropriate during serialization
class Column {
  declare public _worksheet: any;
  declare public _number: number;
  declare public _header: any;
  declare public _key: string | undefined;
  declare public width: number | undefined;
  declare public _hidden: boolean | undefined;
  declare public _outlineLevel: number | undefined;
  declare public style: any;

  constructor(worksheet: any, number: number, defn?: any) {
    this._worksheet = worksheet;
    this._number = number;
    if (defn !== false) {
      // sometimes defn will follow
      this.defn = defn;
    }
  }

  get number(): number {
    return this._number;
  }

  get worksheet(): any {
    return this._worksheet;
  }

  get letter(): string {
    return colCache.n2l(this._number);
  }

  get isCustomWidth(): boolean {
    return this.width !== undefined && this.width !== DEFAULT_COLUMN_WIDTH;
  }

  get defn(): ColumnDefn {
    return {
      header: this._header,
      key: this.key,
      width: this.width,
      style: this.style,
      hidden: this.hidden,
      outlineLevel: this.outlineLevel
    };
  }

  set defn(value: ColumnDefn | undefined) {
    if (value) {
      this.key = value.key;
      this.width = value.width !== undefined ? value.width : DEFAULT_COLUMN_WIDTH;
      this.outlineLevel = value.outlineLevel;
      if (value.style) {
        this.style = value.style;
      } else {
        this.style = {};
      }

      // headers must be set after style
      this.header = value.header;
      this._hidden = !!value.hidden;
    } else {
      delete this._header;
      delete this._key;
      delete this.width;
      this.style = {};
      this.outlineLevel = 0;
    }
  }

  get headers(): any[] {
    return this._header && this._header instanceof Array ? this._header : [this._header];
  }

  get header(): any {
    return this._header;
  }

  set header(value: any) {
    if (value !== undefined) {
      this._header = value;
      this.headers.forEach((text: any, index: number) => {
        this._worksheet.getCell(index + 1, this.number).value = text;
      });
    } else {
      this._header = undefined;
    }
  }

  get key(): string | undefined {
    return this._key;
  }

  set key(value: string | undefined) {
    const column = this._key && this._worksheet.getColumnKey(this._key);
    if (column === this) {
      this._worksheet.deleteColumnKey(this._key);
    }

    this._key = value;
    if (value) {
      this._worksheet.setColumnKey(this._key, this);
    }
  }

  get hidden(): boolean {
    return !!this._hidden;
  }

  set hidden(value: boolean) {
    this._hidden = value;
  }

  get outlineLevel(): number {
    return this._outlineLevel || 0;
  }

  set outlineLevel(value: number | undefined) {
    this._outlineLevel = value;
  }

  get collapsed(): boolean {
    return !!(
      this._outlineLevel && this._outlineLevel >= this._worksheet.properties.outlineLevelCol
    );
  }

  toString(): string {
    return JSON.stringify({
      key: this.key,
      width: this.width,
      headers: this.headers.length ? this.headers : undefined
    });
  }

  equivalentTo(other: Column): boolean {
    return (
      this.width === other.width &&
      this.hidden === other.hidden &&
      this.outlineLevel === other.outlineLevel &&
      isEqual(this.style, other.style)
    );
  }

  get isDefault(): boolean {
    if (this.isCustomWidth) {
      return false;
    }
    if (this.hidden) {
      return false;
    }
    if (this.outlineLevel) {
      return false;
    }
    const s = this.style;
    if (s && (s.font || s.numFmt || s.alignment || s.border || s.fill || s.protection)) {
      return false;
    }
    return true;
  }

  get headerCount(): number {
    return this.headers.length;
  }

  eachCell(options: any, iteratee?: any): void {
    const colNumber = this.number;
    if (!iteratee) {
      iteratee = options;
      options = null;
    }
    this._worksheet.eachRow(options, (row: any, rowNumber: number) => {
      iteratee(row.getCell(colNumber), rowNumber);
    });
  }

  get values(): any[] {
    const v: any[] = [];
    this.eachCell((cell: any, rowNumber: number) => {
      if (cell && cell.type !== Enums.ValueType.Null) {
        v[rowNumber] = cell.value;
      }
    });
    return v;
  }

  set values(v: any[]) {
    if (!v) {
      return;
    }
    const colNumber = this.number;
    let offset = 0;
    if (Object.prototype.hasOwnProperty.call(v, "0")) {
      // assume contiguous array, start at row 1
      offset = 1;
    }
    v.forEach((value: any, index: number) => {
      this._worksheet.getCell(index + offset, colNumber).value = value;
    });
  }

  // =========================================================================
  // styles
  _applyStyle(name: string, value: any): any {
    this.style[name] = value;
    this.eachCell((cell: any) => {
      cell[name] = value;
    });
    return value;
  }

  get numFmt(): any {
    return this.style.numFmt;
  }

  set numFmt(value: any) {
    this._applyStyle("numFmt", value);
  }

  get font(): any {
    return this.style.font;
  }

  set font(value: any) {
    this._applyStyle("font", value);
  }

  get alignment(): any {
    return this.style.alignment;
  }

  set alignment(value: any) {
    this._applyStyle("alignment", value);
  }

  get protection(): any {
    return this.style.protection;
  }

  set protection(value: any) {
    this._applyStyle("protection", value);
  }

  get border(): any {
    return this.style.border;
  }

  set border(value: any) {
    this._applyStyle("border", value);
  }

  get fill(): any {
    return this.style.fill;
  }

  set fill(value: any) {
    this._applyStyle("fill", value);
  }

  // =============================================================================
  // static functions

  static toModel(columns: Column[]): ColumnModel[] | undefined {
    // Convert array of Column into compressed list cols
    const cols: ColumnModel[] = [];
    let col: ColumnModel | null = null;
    if (columns) {
      columns.forEach((column, index) => {
        if (column.isDefault) {
          if (col) {
            col = null;
          }
        } else if (!col || !column.equivalentTo(col as any)) {
          col = {
            min: index + 1,
            max: index + 1,
            width: column.width !== undefined ? column.width : DEFAULT_COLUMN_WIDTH,
            style: column.style,
            isCustomWidth: column.isCustomWidth,
            hidden: column.hidden,
            outlineLevel: column.outlineLevel,
            collapsed: column.collapsed
          };
          cols.push(col);
        } else {
          col.max = index + 1;
        }
      });
    }
    return cols.length ? cols : undefined;
  }

  static fromModel(worksheet: any, cols: ColumnModel[]): Column[] | null {
    cols = cols || [];
    const columns: Column[] = [];
    let count = 1;
    let index = 0;
    /**
     * sort cols by min
     * If it is not sorted, the subsequent column configuration will be overwritten
     * */
    cols = cols.sort(function (pre, next) {
      return pre.min - next.min;
    });
    while (index < cols.length) {
      const col = cols[index++];
      while (count < col.min) {
        columns.push(new Column(worksheet, count++));
      }
      while (count <= col.max) {
        columns.push(new Column(worksheet, count++, col));
      }
    }
    return columns.length ? columns : null;
  }
}

export { Column };
