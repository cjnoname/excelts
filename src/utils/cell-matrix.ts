import { colCache } from "./col-cache.js";

interface CellAddress {
  sheetName?: string;
  address: string;
  row: number;
  col: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

type Cell = CellAddress & any;
type Row = Cell[];
type Sheet = Row[];
type Sheets = Record<string, Sheet>;

class CellMatrix {
  template: any;
  sheets: Sheets;

  constructor(template?: any) {
    this.template = template;
    this.sheets = {};
  }

  addCell(addressStr: string): void {
    this.addCellEx(colCache.decodeEx(addressStr) as any);
  }

  getCell(addressStr: string): Cell {
    return this.findCellEx(colCache.decodeEx(addressStr) as any, true);
  }

  findCell(addressStr: string): Cell | undefined {
    return this.findCellEx(colCache.decodeEx(addressStr) as any, false);
  }

  findCellAt(sheetName: string, rowNumber: number, colNumber: number): Cell | undefined {
    const sheet = this.sheets[sheetName];
    const row = sheet && sheet[rowNumber];
    return row && row[colNumber];
  }

  addCellEx(address: CellAddress): void {
    if (address.top !== undefined) {
      for (let row = address.top; row <= address.bottom!; row++) {
        for (let col = address.left!; col <= address.right!; col++) {
          this.getCellAt(address.sheetName!, row, col);
        }
      }
    } else {
      this.findCellEx(address, true);
    }
  }

  getCellEx(address: CellAddress): Cell {
    return this.findCellEx(address, true);
  }

  findCellEx(address: CellAddress, create: boolean): Cell | undefined {
    const sheet = this.findSheet(address, create);
    const row = this.findSheetRow(sheet, address, create);
    return this.findRowCell(row, address, create);
  }

  getCellAt(sheetName: string, rowNumber: number, colNumber: number): Cell {
    const sheet = this.sheets[sheetName] || (this.sheets[sheetName] = []);
    const row = sheet[rowNumber] || (sheet[rowNumber] = []);
    const cell =
      row[colNumber] ||
      (row[colNumber] = {
        sheetName,
        address: colCache.n2l(colNumber) + rowNumber,
        row: rowNumber,
        col: colNumber
      });
    return cell;
  }

  removeCellEx(address: CellAddress): void {
    const sheet = this.findSheet(address, false);
    if (!sheet) {
      return;
    }
    const row = this.findSheetRow(sheet, address, false);
    if (!row) {
      return;
    }
    delete row[address.col];
  }

  forEachInSheet(
    sheetName: string,
    callback: (cell: Cell, rowNumber: number, colNumber: number) => void
  ): void {
    const sheet = this.sheets[sheetName];
    if (sheet) {
      sheet.forEach((row, rowNumber) => {
        if (row) {
          row.forEach((cell, colNumber) => {
            if (cell) {
              callback(cell, rowNumber, colNumber);
            }
          });
        }
      });
    }
  }

  forEach(callback: (cell: Cell) => void): void {
    Object.keys(this.sheets).forEach(sheetName => {
      this.forEachInSheet(sheetName as string, callback);
    });
  }

  map<T>(callback: (cell: Cell) => T): T[] {
    const results: T[] = [];
    this.forEach(cell => {
      results.push(callback(cell));
    });
    return results;
  }

  findSheet(address: CellAddress, create: boolean): Sheet | undefined {
    const name = address.sheetName!;
    if (this.sheets[name]) {
      return this.sheets[name];
    }
    if (create) {
      return (this.sheets[name] = []);
    }
    return undefined;
  }

  findSheetRow(sheet: Sheet | undefined, address: CellAddress, create: boolean): Row | undefined {
    const { row } = address;
    if (sheet && sheet[row]) {
      return sheet[row];
    }
    if (create) {
      return (sheet![row] = []);
    }
    return undefined;
  }

  findRowCell(row: Row | undefined, address: CellAddress, create: boolean): Cell | undefined {
    const { col } = address;
    if (row && row[col]) {
      return row[col];
    }
    if (create) {
      return (row![col] = this.template
        ? Object.assign(address, JSON.parse(JSON.stringify(this.template)))
        : address);
    }
    return undefined;
  }

  spliceRows(sheetName: string, start: number, numDelete: number, numInsert: number): void {
    const sheet = this.sheets[sheetName];
    if (sheet) {
      const inserts: Row[] = [];
      for (let i = 0; i < numInsert; i++) {
        inserts.push([]);
      }
      sheet.splice(start, numDelete, ...inserts);
    }
  }

  spliceColumns(sheetName: string, start: number, numDelete: number, numInsert: number): void {
    const sheet = this.sheets[sheetName];
    if (sheet) {
      const inserts: (Cell | null)[] = [];
      for (let i = 0; i < numInsert; i++) {
        inserts.push(null);
      }
      Object.values(sheet).forEach((row: Row) => {
        row.splice(start, numDelete, ...inserts);
      });
    }
  }
}

export { CellMatrix };
