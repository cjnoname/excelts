import type { DecodedAddress, Location } from "@excel/types";
import { colCache } from "@excel/utils/col-cache";

// Safe deep clone that filters out prototype pollution keys
function safeDeepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => safeDeepClone(item)) as T;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    // Guard inline so static analysis recognizes the prototype-pollution
    // sanitizer at the assignment sink below.
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
      result[key] = safeDeepClone((obj as Record<string, unknown>)[key]);
    }
  }
  return result as T;
}

/** A decoded address, plus the optional range bounds a range decode carries. */
interface MatrixAddress extends DecodedAddress, Partial<Location> {}

/**
 * A matrix cell: the fixed address fields plus any extra template-derived
 * properties (callers attach arbitrary metadata via the constructor template).
 */
interface Cell extends MatrixAddress {
  [key: string]: unknown;
}
/** Rows are sparse: holes appear as `null` (column splice) or `undefined` (removal). */
type Row = (Cell | null | undefined)[];
type Sheet = Row[];

class CellMatrix {
  template?: Record<string, unknown>;
  sheets: Map<string, Sheet>;

  constructor(template?: Record<string, unknown>) {
    this.template = template;
    this.sheets = new Map();
  }

  addCell(addressStr: string): void {
    this.addCellEx(colCache.decodeEx(addressStr) as MatrixAddress);
  }

  getCell(addressStr: string): Cell {
    return this.findCellEx(colCache.decodeEx(addressStr) as MatrixAddress, true);
  }

  findCell(addressStr: string): Cell | undefined {
    return this.findCellEx(colCache.decodeEx(addressStr) as MatrixAddress, false);
  }

  findCellAt(sheetName: string, rowNumber: number, colNumber: number): Cell | undefined {
    const sheet = this.sheets.get(sheetName);
    const row = sheet && sheet[rowNumber];
    return (row && row[colNumber]) || undefined;
  }

  addCellEx(address: MatrixAddress): void {
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

  getCellEx(address: MatrixAddress): Cell {
    return this.findCellEx(address, true);
  }

  findCellEx(address: MatrixAddress, create: true): Cell;
  findCellEx(address: MatrixAddress, create: boolean): Cell | undefined;
  findCellEx(address: MatrixAddress, create: boolean): Cell | undefined {
    const sheet = this.findSheet(address, create);
    const row = this.findSheetRow(sheet, address, create);
    return this.findRowCell(row, address, create);
  }

  getCellAt(sheetName: string, rowNumber: number, colNumber: number): Cell {
    let sheet = this.sheets.get(sheetName);
    if (!sheet) {
      sheet = [];
      this.sheets.set(sheetName, sheet);
    }
    // >>> 0 coerces to uint32, preventing "__proto__" string injection
    const safeRow = rowNumber >>> 0;
    const safeCol = colNumber >>> 0;
    const row = sheet[safeRow] || (sheet[safeRow] = []);
    const cell =
      row[safeCol] ||
      (row[safeCol] = {
        sheetName,
        address: colCache.n2l(colNumber) + rowNumber,
        row: rowNumber,
        col: colNumber
      });
    return cell;
  }

  removeCellEx(address: MatrixAddress): void {
    const sheet = this.findSheet(address, false);
    if (!sheet) {
      return;
    }
    const row = this.findSheetRow(sheet, address, false);
    if (!row) {
      return;
    }
    row[address.col >>> 0] = undefined!;
  }

  forEachInSheet(
    sheetName: string,
    callback: (cell: Cell, rowNumber: number, colNumber: number) => void
  ): void {
    const sheet = this.sheets.get(sheetName);
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
    for (const sheetName of this.sheets.keys()) {
      this.forEachInSheet(sheetName, callback);
    }
  }

  map<T>(callback: (cell: Cell) => T): T[] {
    const results: T[] = [];
    this.forEach(cell => {
      results.push(callback(cell));
    });
    return results;
  }

  findSheet(address: MatrixAddress, create: true): Sheet;
  findSheet(address: MatrixAddress, create: boolean): Sheet | undefined;
  findSheet(address: MatrixAddress, create: boolean): Sheet | undefined {
    const name = address.sheetName!;
    if (this.sheets.has(name)) {
      return this.sheets.get(name);
    }
    if (create) {
      const sheet: Sheet = [];
      this.sheets.set(name, sheet);
      return sheet;
    }
    return undefined;
  }

  findSheetRow(sheet: Sheet | undefined, address: MatrixAddress, create: true): Row;
  findSheetRow(sheet: Sheet | undefined, address: MatrixAddress, create: boolean): Row | undefined;
  findSheetRow(sheet: Sheet | undefined, address: MatrixAddress, create: boolean): Row | undefined {
    const safeRow = address.row >>> 0;
    if (sheet && sheet[safeRow]) {
      return sheet[safeRow];
    }
    if (create) {
      return (sheet![safeRow] = []);
    }
    return undefined;
  }

  findRowCell(row: Row | undefined, address: MatrixAddress, create: true): Cell;
  findRowCell(row: Row | undefined, address: MatrixAddress, create: boolean): Cell | undefined;
  findRowCell(row: Row | undefined, address: MatrixAddress, create: boolean): Cell | undefined {
    const safeCol = address.col >>> 0;
    const existing = row && row[safeCol];
    if (existing) {
      return existing;
    }
    if (create) {
      return (row![safeCol] = this.template
        ? { ...address, ...safeDeepClone(this.template) }
        : { ...address });
    }
    return undefined;
  }

  spliceRows(sheetName: string, start: number, numDelete: number, numInsert: number): void {
    const sheet = this.sheets.get(sheetName);
    if (sheet) {
      const inserts: Row[] = [];
      for (let i = 0; i < numInsert; i++) {
        inserts.push([]);
      }
      sheet.splice(start, numDelete, ...inserts);
    }
  }

  spliceColumns(sheetName: string, start: number, numDelete: number, numInsert: number): void {
    const sheet = this.sheets.get(sheetName);
    if (sheet) {
      const inserts: (Cell | null)[] = [];
      for (let i = 0; i < numInsert; i++) {
        inserts.push(null);
      }
      sheet.forEach((row: Row) => {
        row.splice(start, numDelete, ...inserts);
      });
    }
  }
}

export { CellMatrix };
