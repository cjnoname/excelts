import { Enums } from "./enums.js";
import { colCache } from "../utils/col-cache.js";
import { Cell } from "./cell.js";
import type { Worksheet } from "./worksheet.js";

interface CellAddress {
  address: string;
  row: number;
  col: number;
  $col$row?: string;
}

interface RowDimensions {
  min: number;
  max: number;
}

interface RowModel {
  cells: any[];
  number: number;
  min: number;
  max: number;
  height?: number;
  style: any;
  hidden: boolean;
  outlineLevel: number;
  collapsed: boolean;
}

interface PageBreak {
  id: number;
  max: number;
  man: number;
  min?: number;
}

interface EachCellOptions {
  includeEmpty?: boolean;
}

class Row {
  // Type declarations only - no runtime overhead
  declare public _worksheet: Worksheet;
  declare public _number: number;
  declare public _cells: any[];
  declare public style: any;
  declare public _hidden?: boolean;
  declare public _outlineLevel?: number;
  declare public height?: number;

  constructor(worksheet: any, number: number) {
    this._worksheet = worksheet;
    this._number = number;
    this._cells = [];
    this.style = {};
    this.outlineLevel = 0;
  }

  // return the row number
  get number(): number {
    return this._number;
  }

  get worksheet(): any {
    return this._worksheet;
  }

  // Inform Streaming Writer that this row (and all rows before it) are complete
  // and ready to write. Has no effect on Worksheet document
  commit(): void {
    this._worksheet._commitRow(this);
  }

  // helps GC by breaking cyclic references
  destroy(): void {
    delete this._worksheet;
    delete this._cells;
    delete this.style;
  }

  findCell(colNumber: number): any {
    return this._cells[colNumber - 1];
  }

  // given {address, row, col}, find or create new cell
  getCellEx(address: CellAddress): any {
    let cell = this._cells[address.col - 1];
    if (!cell) {
      const column = this._worksheet.getColumn(address.col);
      cell = new Cell(this, column, address.address);
      this._cells[address.col - 1] = cell;
    }
    return cell;
  }

  // get cell by key, letter or column number
  getCell(col: string | number): any {
    let colNum: number;
    if (typeof col === "string") {
      // is it a key?
      const column = this._worksheet.getColumnKey(col);
      if (column) {
        colNum = column.number;
      } else {
        colNum = colCache.l2n(col);
      }
    } else {
      colNum = col;
    }
    return (
      this._cells[colNum - 1] ||
      this.getCellEx({
        address: colCache.encodeAddress(this._number, colNum),
        row: this._number,
        col: colNum
      })
    );
  }

  // remove cell(s) and shift all higher cells down by count
  splice(start: number, count: number, ...inserts: any[]): void {
    const nKeep = start + count;
    const nExpand = inserts.length - count;
    const nEnd = this._cells.length;
    let i: number;
    let cSrc: any;
    let cDst: any;

    if (nExpand < 0) {
      // remove cells
      for (i = start + inserts.length; i <= nEnd; i++) {
        cDst = this._cells[i - 1];
        cSrc = this._cells[i - nExpand - 1];
        if (cSrc) {
          cDst = this.getCell(i);
          cDst.value = cSrc.value;
          cDst.style = cSrc.style;
          cDst._comment = cSrc._comment;
        } else if (cDst) {
          cDst.value = null;
          cDst.style = {};
          cDst._comment = undefined;
        }
      }
    } else if (nExpand > 0) {
      // insert new cells
      for (i = nEnd; i >= nKeep; i--) {
        cSrc = this._cells[i - 1];
        if (cSrc) {
          cDst = this.getCell(i + nExpand);
          cDst.value = cSrc.value;
          cDst.style = cSrc.style;
          cDst._comment = cSrc._comment;
        } else {
          this._cells[i + nExpand - 1] = undefined;
        }
      }
    }

    // now add the new values
    for (i = 0; i < inserts.length; i++) {
      cDst = this.getCell(start + i);
      cDst.value = inserts[i];
      cDst.style = {};
      cDst._comment = undefined;
    }
  }

  // Iterate over all non-null cells in this row
  eachCell(iteratee: (cell: any, colNumber: number) => void): void;
  eachCell(options: EachCellOptions, iteratee: (cell: any, colNumber: number) => void): void;
  eachCell(options: any, iteratee?: (cell: any, colNumber: number) => void): void {
    if (!iteratee) {
      iteratee = options;
      options = null;
    }
    if (options && options.includeEmpty) {
      const n = this._cells.length;
      for (let i = 1; i <= n; i++) {
        iteratee(this.getCell(i), i);
      }
    } else {
      this._cells.forEach((cell, index) => {
        if (cell && cell.type !== Enums.ValueType.Null) {
          iteratee(cell, index + 1);
        }
      });
    }
  }

  // ===========================================================================
  // Page Breaks
  addPageBreak(lft?: number, rght?: number): void {
    const ws = this._worksheet;
    const left = Math.max(0, (lft || 0) - 1) || 0;
    const right = Math.max(0, (rght || 0) - 1) || 16838;
    const pb: PageBreak = {
      id: this._number,
      max: right,
      man: 1
    };
    if (left) {
      pb.min = left;
    }

    ws.rowBreaks.push(pb);
  }

  // return a sparse array of cell values
  get values(): any[] {
    const values: any[] = [];
    this._cells.forEach(cell => {
      if (cell && cell.type !== Enums.ValueType.Null) {
        values[cell.col] = cell.value;
      }
    });
    return values;
  }

  // set the values by contiguous or sparse array, or by key'd object literal
  set values(value: any[] | { [key: string]: any }) {
    // this operation is not additive - any prior cells are removed
    this._cells = [];
    if (!value) {
      // empty row
    } else if (value instanceof Array) {
      let offset = 0;
      if (Object.prototype.hasOwnProperty.call(value, "0")) {
        // contiguous array - start at column 1
        offset = 1;
      }
      value.forEach((item, index) => {
        if (item !== undefined) {
          this.getCellEx({
            address: colCache.encodeAddress(this._number, index + offset),
            row: this._number,
            col: index + offset
          }).value = item;
        }
      });
    } else {
      // assume object with column keys
      this._worksheet.eachColumnKey((column: any, key: string) => {
        if (value[key] !== undefined) {
          this.getCellEx({
            address: colCache.encodeAddress(this._number, column.number),
            row: this._number,
            col: column.number
          }).value = value[key];
        }
      });
    }
  }

  // returns true if the row includes at least one cell with a value
  get hasValues(): boolean {
    return this._cells.some((cell: any) => cell && cell.type !== Enums.ValueType.Null);
  }

  get cellCount(): number {
    return this._cells.length;
  }

  get actualCellCount(): number {
    let count = 0;
    this.eachCell(() => {
      count++;
    });
    return count;
  }

  // get the min and max column number for the non-null cells in this row or null
  get dimensions(): RowDimensions | null {
    let min = 0;
    let max = 0;
    this._cells.forEach(cell => {
      if (cell && cell.type !== Enums.ValueType.Null) {
        if (!min || min > cell.col) {
          min = cell.col;
        }
        if (max < cell.col) {
          max = cell.col;
        }
      }
    });
    return min > 0
      ? {
          min,
          max
        }
      : null;
  }

  // =========================================================================
  // styles
  _applyStyle(name: string, value: any): any {
    this.style[name] = value;
    this._cells.forEach(cell => {
      if (cell) {
        cell[name] = value;
      }
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

  get hidden(): boolean {
    return !!this._hidden;
  }

  set hidden(value: boolean) {
    this._hidden = value;
  }

  get outlineLevel(): number {
    return this._outlineLevel || 0;
  }

  set outlineLevel(value: number) {
    this._outlineLevel = value;
  }

  get collapsed(): boolean {
    return !!(
      this._outlineLevel && this._outlineLevel >= this._worksheet.properties.outlineLevelRow
    );
  }

  // =========================================================================
  get model(): RowModel | null {
    const cells: any[] = [];
    let min = 0;
    let max = 0;
    this._cells.forEach(cell => {
      if (cell) {
        const cellModel = cell.model;
        if (cellModel) {
          if (!min || min > cell.col) {
            min = cell.col;
          }
          if (max < cell.col) {
            max = cell.col;
          }
          cells.push(cellModel);
        }
      }
    });

    return this.height || cells.length
      ? {
          cells,
          number: this.number,
          min,
          max,
          height: this.height,
          style: this.style,
          hidden: this.hidden,
          outlineLevel: this.outlineLevel,
          collapsed: this.collapsed
        }
      : null;
  }

  set model(value: RowModel) {
    if (value.number !== this._number) {
      throw new Error("Invalid row number in model");
    }
    this._cells = [];
    let previousAddress: CellAddress | undefined;
    value.cells.forEach(cellModel => {
      switch (cellModel.type) {
        case Cell.Types.Merge:
          // special case - don't add this types
          break;
        default: {
          let address: CellAddress | undefined;
          if (cellModel.address) {
            address = colCache.decodeAddress(cellModel.address);
          } else if (previousAddress) {
            // This is a <c> element without an r attribute
            // Assume that it's the cell for the next column
            const { row } = previousAddress;
            const col = previousAddress.col + 1;
            address = {
              row,
              col,
              address: colCache.encodeAddress(row, col),
              $col$row: `$${colCache.n2l(col)}$${row}`
            };
          }
          previousAddress = address;
          const cell = this.getCellEx(address);
          cell.model = cellModel;
          break;
        }
      }
    });

    if (value.height) {
      this.height = value.height;
    } else {
      delete this.height;
    }

    this.hidden = value.hidden;
    this.outlineLevel = value.outlineLevel || 0;

    this.style = (value.style && JSON.parse(JSON.stringify(value.style))) || {};
  }
}

export { Row };
