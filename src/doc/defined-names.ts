import { colCache } from "../utils/col-cache.js";
import { CellMatrix } from "../utils/cell-matrix.js";
import { Range } from "./range.js";

const rangeRegexp = /[$](\w+)[$](\d+)(:[$](\w+)[$](\d+))?/;

interface Cell {
  sheetName?: string;
  address: string;
  row: number;
  col: number;
  mark?: boolean;
}

interface DefinedNameModel {
  name: string;
  ranges: string[];
}

class DefinedNames {
  matrixMap: Record<string, CellMatrix>;

  constructor() {
    this.matrixMap = {};
  }

  getMatrix(name: string): CellMatrix {
    const matrix = this.matrixMap[name] || (this.matrixMap[name] = new CellMatrix());
    return matrix;
  }

  // add a name to a cell. locStr in the form SheetName!$col$row or SheetName!$c1$r1:$c2:$r2
  add(locStr: string, name: string): void {
    const location = colCache.decodeEx(locStr);
    this.addEx(location as any, name);
  }

  addEx(location: any, name: string): void {
    const matrix = this.getMatrix(name);
    if (location.top) {
      for (let col = location.left; col <= location.right; col++) {
        for (let row = location.top; row <= location.bottom; row++) {
          const address = {
            sheetName: location.sheetName,
            address: colCache.n2l(col) + row,
            row,
            col
          };

          matrix.addCellEx(address);
        }
      }
    } else {
      matrix.addCellEx(location);
    }
  }

  remove(locStr: string, name: string): void {
    const location = colCache.decodeEx(locStr);
    this.removeEx(location as any, name);
  }

  removeEx(location: any, name: string): void {
    const matrix = this.getMatrix(name);
    matrix.removeCellEx(location);
  }

  removeAllNames(location: any): void {
    Object.values(this.matrixMap).forEach((matrix: CellMatrix) => {
      matrix.removeCellEx(location);
    });
  }

  forEach(callback: (name: string, cell: Cell) => void): void {
    Object.entries(this.matrixMap).forEach(([name, matrix]) => {
      matrix.forEach((cell: Cell) => {
        callback(name as string, cell);
      });
    });
  }

  // get all the names of a cell
  getNames(addressStr: string): string[] {
    return this.getNamesEx(colCache.decodeEx(addressStr) as any);
  }

  getNamesEx(address: any): string[] {
    return Object.entries(this.matrixMap)
      .map(([name, matrix]) => matrix.findCellEx(address, false) && name)
      .filter(Boolean) as string[];
  }

  _explore(matrix: CellMatrix, cell: Cell): Range {
    cell.mark = false;
    const { sheetName } = cell;

    const range = new Range(cell.row, cell.col, cell.row, cell.col, sheetName);
    let x: number;
    let y: number;

    // grow vertical - only one col to worry about
    function vGrow(yy: number, edge: "top" | "bottom"): boolean {
      const c = matrix.findCellAt(sheetName!, yy, cell.col) as Cell | undefined;
      if (!c || !c.mark) {
        return false;
      }
      range[edge] = yy;
      c.mark = false;
      return true;
    }
    for (y = cell.row - 1; vGrow(y, "top"); y--) {}
    for (y = cell.row + 1; vGrow(y, "bottom"); y++) {}

    // grow horizontal - ensure all rows can grow
    function hGrow(xx: number, edge: "left" | "right"): boolean {
      const cells: Cell[] = [];
      for (y = range.top; y <= range.bottom; y++) {
        const c = matrix.findCellAt(sheetName!, y, xx) as Cell | undefined;
        if (c && c.mark) {
          cells.push(c);
        } else {
          return false;
        }
      }
      range[edge] = xx;
      for (let i = 0; i < cells.length; i++) {
        cells[i].mark = false;
      }
      return true;
    }
    for (x = cell.col - 1; hGrow(x, "left"); x--) {}
    for (x = cell.col + 1; hGrow(x, "right"); x++) {}

    return range;
  }

  getRanges(name: string, matrix?: CellMatrix): DefinedNameModel {
    matrix = matrix || this.matrixMap[name];

    if (!matrix) {
      return { name, ranges: [] };
    }

    // mark and sweep!
    matrix.forEach((cell: Cell) => {
      cell.mark = true;
    });
    const ranges = matrix
      .map((cell: Cell) => cell.mark && this._explore(matrix!, cell))
      .filter(Boolean)
      .map((range: Range) => range.$shortRange);

    return {
      name,
      ranges
    };
  }

  normaliseMatrix(matrix: CellMatrix, sheetName: string): void {
    // some of the cells might have shifted on specified sheet
    // need to reassign rows, cols
    matrix.forEachInSheet(sheetName, (cell: Cell | undefined, row: number, col: number) => {
      if (cell) {
        if (cell.row !== row || cell.col !== col) {
          cell.row = row;
          cell.col = col;
          cell.address = colCache.n2l(col) + row;
        }
      }
    });
  }

  spliceRows(sheetName: string, start: number, numDelete: number, numInsert: number): void {
    Object.values(this.matrixMap).forEach((matrix: CellMatrix) => {
      matrix.spliceRows(sheetName, start, numDelete, numInsert);
      this.normaliseMatrix(matrix, sheetName);
    });
  }

  spliceColumns(sheetName: string, start: number, numDelete: number, numInsert: number): void {
    Object.values(this.matrixMap).forEach((matrix: CellMatrix) => {
      matrix.spliceColumns(sheetName, start, numDelete, numInsert);
      this.normaliseMatrix(matrix, sheetName);
    });
  }

  get model(): DefinedNameModel[] {
    // To get names per cell - just iterate over all names finding cells if they exist
    return Object.entries(this.matrixMap)
      .map(([name, matrix]) => this.getRanges(name as string, matrix))
      .filter((definedName: DefinedNameModel) => definedName.ranges.length);
  }

  set model(value: DefinedNameModel[]) {
    // value is [ { name, ranges }, ... ]
    const matrixMap = (this.matrixMap = {});
    value.forEach(definedName => {
      const matrix = (matrixMap[definedName.name] = new CellMatrix());
      definedName.ranges.forEach(rangeStr => {
        if (rangeRegexp.test(rangeStr.split("!").pop() || "")) {
          matrix.addCell(rangeStr);
        }
      });
    });
  }
}

export { DefinedNames };
