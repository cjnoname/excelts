import { colCache } from "../utils/col-cache.js";
import { Range } from "./range.js";
import { Row } from "./row.js";
import { Column } from "./column.js";
import { Enums } from "./enums.js";
import { Image } from "./image.js";
import { Table } from "./table.js";
import { DataValidations } from "./data-validations.js";
import { Encryptor } from "../utils/encryptor.js";
import { makePivotTable } from "./pivot-table.js";
import { copyStyle } from "../utils/copy-style.js";
import type { RowBreak } from "../types.js";

interface WorksheetOptions {
  workbook?: any;
  id?: number;
  orderNo?: number;
  name?: string;
  state?: string;
  properties?: any;
  pageSetup?: any;
  headerFooter?: any;
  views?: any[];
  autoFilter?: any;
}

interface EachRowOptions {
  includeEmpty?: boolean;
}

interface PageSetupMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
  header: number;
  footer: number;
}

interface PageSetup {
  margins: PageSetupMargins;
  orientation: string;
  horizontalDpi: number;
  verticalDpi: number;
  fitToPage: boolean;
  pageOrder: string;
  blackAndWhite: boolean;
  draft: boolean;
  cellComments: string;
  errors: string;
  scale: number;
  fitToWidth: number;
  fitToHeight: number;
  paperSize?: number;
  showRowColHeaders: boolean;
  showGridLines: boolean;
  firstPageNumber?: number;
  horizontalCentered: boolean;
  verticalCentered: boolean;
  rowBreaks: RowBreak[];
  colBreaks: any;
  printTitlesRow?: string;
  printTitlesColumn?: string;
}

interface HeaderFooter {
  differentFirst: boolean;
  differentOddEven: boolean;
  oddHeader: string | null;
  oddFooter: string | null;
  evenHeader: string | null;
  evenFooter: string | null;
  firstHeader: string | null;
  firstFooter: string | null;
}

interface WorksheetModel {
  id: number;
  name: string;
  dataValidations: any;
  properties: any;
  state: string;
  pageSetup: PageSetup;
  headerFooter: HeaderFooter;
  rowBreaks: RowBreak[];
  views: any[];
  autoFilter: any;
  media: any[];
  sheetProtection: any;
  tables: any[];
  pivotTables: any[];
  conditionalFormattings: any[];
  cols?: any[];
  rows?: any[];
  dimensions?: Range;
  merges?: string[];
  mergeCells?: string[];
}

// Worksheet requirements
//  Operate as sheet inside workbook or standalone
//  Load and Save from file and stream
//  Access/Add/Delete individual cells
//  Manage column widths and row heights

class Worksheet {
  // Type declarations only - no runtime overhead
  declare public _workbook: any;
  declare public id: number;
  declare public orderNo: number;
  declare public _name: string;
  declare public state: string;
  declare public _rows: any[];
  declare public _columns: any[] | null;
  declare public _keys: { [key: string]: any };
  declare public _merges: { [key: string]: Range };
  declare public rowBreaks: any[];
  declare public properties: any;
  declare public pageSetup: PageSetup;
  declare public headerFooter: HeaderFooter;
  declare public dataValidations: DataValidations;
  declare public views: any[];
  declare public autoFilter: any;
  declare public _media: any[];
  declare public sheetProtection: any;
  declare public tables: { [key: string]: Table };
  declare public pivotTables: any[];
  declare public conditionalFormattings: any[];
  declare public _headerRowCount?: number;

  constructor(options: WorksheetOptions) {
    options = options || {};
    this._workbook = options.workbook;

    // in a workbook, each sheet will have a number
    this.id = options.id || 0;
    this.orderNo = options.orderNo || 0;

    // and a name - use the setter to ensure validation and truncation
    this.name = options.name || `sheet${this.id}`;

    // add a state
    this.state = options.state || "visible";

    // rows allows access organised by row. Sparse array of arrays indexed by row-1, col
    // Note: _rows is zero based. Must subtract 1 to go from cell.row to index
    this._rows = [];

    // column definitions
    this._columns = null;

    // column keys (addRow convenience): key ==> this._collumns index
    this._keys = {};

    // keep record of all merges
    this._merges = {};

    // record of all row and column pageBreaks
    this.rowBreaks = [];

    // for tabColor, default row height, outline levels, etc
    this.properties = Object.assign(
      {},
      {
        defaultRowHeight: 15,
        dyDescent: 55,
        outlineLevelCol: 0,
        outlineLevelRow: 0
      },
      options.properties
    );

    // for all things printing
    this.pageSetup = Object.assign(
      {},
      {
        margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
        orientation: "portrait",
        horizontalDpi: 4294967295,
        verticalDpi: 4294967295,
        fitToPage: !!(
          options.pageSetup &&
          (options.pageSetup.fitToWidth || options.pageSetup.fitToHeight) &&
          !options.pageSetup.scale
        ),
        pageOrder: "downThenOver",
        blackAndWhite: false,
        draft: false,
        cellComments: "None",
        errors: "displayed",
        scale: 100,
        fitToWidth: 1,
        fitToHeight: 1,
        paperSize: undefined,
        showRowColHeaders: false,
        showGridLines: false,
        firstPageNumber: undefined,
        horizontalCentered: false,
        verticalCentered: false,
        rowBreaks: null,
        colBreaks: null
      },
      options.pageSetup
    );

    this.headerFooter = Object.assign(
      {},
      {
        differentFirst: false,
        differentOddEven: false,
        oddHeader: null,
        oddFooter: null,
        evenHeader: null,
        evenFooter: null,
        firstHeader: null,
        firstFooter: null
      },
      options.headerFooter
    );

    this.dataValidations = new DataValidations();

    // for freezepanes, split, zoom, gridlines, etc
    this.views = options.views || [];

    this.autoFilter = options.autoFilter || null;

    // for images, etc
    this._media = [];

    // worksheet protection
    this.sheetProtection = null;

    // for tables
    this.tables = {};

    this.pivotTables = [];

    this.conditionalFormattings = [];
  }

  get name(): string {
    return this._name;
  }

  set name(name: string | undefined) {
    if (name === undefined) {
      name = `sheet${this.id}`;
    }

    if (this._name === name) {
      return;
    }

    if (typeof name !== "string") {
      throw new Error("The name has to be a string.");
    }

    if (name === "") {
      throw new Error("The name can't be empty.");
    }

    if (name === "History") {
      throw new Error('The name "History" is protected. Please use a different name.');
    }

    // Illegal character in worksheet name: asterisk (*), question mark (?),
    // colon (:), forward slash (/ \), or bracket ([])
    if (/[*?:/\\[\]]/.test(name)) {
      throw new Error(
        `Worksheet name ${name} cannot include any of the following characters: * ? : \\ / [ ]`
      );
    }

    if (/(^')|('$)/.test(name)) {
      throw new Error(
        `The first or last character of worksheet name cannot be a single quotation mark: ${name}`
      );
    }

    if (name && name.length > 31) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`Worksheet name ${name} exceeds 31 chars. This will be truncated`);
      }
      name = name.substring(0, 31);
    }

    if (
      this._workbook._worksheets.find(
        (ws: any) => ws && ws.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      throw new Error(`Worksheet name already exists: ${name}`);
    }

    this._name = name;
  }

  get workbook(): any {
    return this._workbook;
  }

  // when you're done with this worksheet, call this to remove from workbook
  destroy(): void {
    this._workbook.removeWorksheetEx(this);
  }

  // Get the bounding range of the cells in this worksheet
  get dimensions(): Range {
    const dimensions = new Range();
    this._rows.forEach(row => {
      if (row) {
        const rowDims = row.dimensions;
        if (rowDims) {
          dimensions.expand(row.number, rowDims.min, row.number, rowDims.max);
        }
      }
    });
    return dimensions;
  }

  // =========================================================================
  // Columns

  // get the current columns array.
  get columns(): any[] | null {
    return this._columns;
  }

  // set the columns from an array of column definitions.
  // Note: any headers defined will overwrite existing values.
  set columns(value: any[]) {
    // calculate max header row count
    this._headerRowCount = value.reduce((pv, cv) => {
      const headerCount = (cv.header && 1) || (cv.headers && cv.headers.length) || 0;
      return Math.max(pv, headerCount);
    }, 0);

    // construct Column objects
    let count = 1;
    const columns = (this._columns = []);
    value.forEach(defn => {
      const column = new Column(this, count++, false as any);
      columns.push(column);
      column.defn = defn;
    });
  }

  getColumnKey(key: string): any {
    return this._keys[key];
  }

  setColumnKey(key: string, value: any): void {
    this._keys[key] = value;
  }

  deleteColumnKey(key: string): void {
    delete this._keys[key];
  }

  eachColumnKey(f: (column: any, key: string) => void): void {
    Object.keys(this._keys).forEach(key => f(this._keys[key], key));
  }

  // get a single column by col number. If it doesn't exist, create it and any gaps before it
  getColumn(c: string | number): any {
    let colNum: number;
    if (typeof c === "string") {
      // if it matches a key'd column, return that
      const col = this._keys[c];
      if (col) {
        return col;
      }

      // otherwise, assume letter
      colNum = colCache.l2n(c);
    } else {
      colNum = c;
    }
    if (!this._columns) {
      this._columns = [];
    }
    if (colNum > this._columns.length) {
      let n = this._columns.length + 1;
      while (n <= colNum) {
        this._columns.push(new Column(this, n++));
      }
    }
    return this._columns[colNum - 1];
  }

  spliceColumns(start: number, count: number, ...inserts: any[][]): void {
    const rows = this._rows;
    const nRows = rows.length;
    if (inserts.length > 0) {
      // must iterate over all rows whether they exist yet or not
      for (let i = 0; i < nRows; i++) {
        const rowArguments: any[] = [start, count];
        inserts.forEach(insert => {
          rowArguments.push(insert[i] || null);
        });
        const row = this.getRow(i + 1);
        row.splice(...rowArguments);
      }
    } else {
      // nothing to insert, so just splice all rows
      this._rows.forEach(r => {
        if (r) {
          r.splice(start, count);
        }
      });
    }

    // splice column definitions
    const nExpand = inserts.length - count;
    const nKeep = start + count;
    const nEnd = this._columns ? this._columns.length : 0;
    if (nExpand < 0) {
      for (let i = start + inserts.length; i <= nEnd; i++) {
        this.getColumn(i).defn = this.getColumn(i - nExpand).defn;
      }
    } else if (nExpand > 0) {
      for (let i = nEnd; i >= nKeep; i--) {
        this.getColumn(i + nExpand).defn = this.getColumn(i).defn;
      }
    }
    for (let i = start; i < start + inserts.length; i++) {
      this.getColumn(i).defn = null as any;
    }

    // account for defined names
    this.workbook.definedNames.spliceColumns(this.name, start, count, inserts.length);
  }

  get lastColumn(): any {
    return this.getColumn(this.columnCount);
  }

  get columnCount(): number {
    let maxCount = 0;
    this.eachRow((row: any) => {
      maxCount = Math.max(maxCount, row.cellCount);
    });
    return maxCount;
  }

  get actualColumnCount(): number {
    // performance nightmare - for each row, counts all the columns used
    const counts: boolean[] = [];
    let count = 0;
    this.eachRow((row: any) => {
      row.eachCell(({ col }: any) => {
        if (!counts[col]) {
          counts[col] = true;
          count++;
        }
      });
    });
    return count;
  }

  // =========================================================================
  // Rows

  _commitRow(row: Row): void {
    // nop - allows streaming reader to fill a document
  }

  get _lastRowNumber(): number {
    // need to cope with results of splice
    const rows = this._rows;
    let n = rows.length;
    while (n > 0 && rows[n - 1] === undefined) {
      n--;
    }
    return n;
  }

  get _nextRow(): number {
    return this._lastRowNumber + 1;
  }

  get lastRow(): any {
    if (this._rows.length) {
      return this._rows[this._rows.length - 1];
    }
    return undefined;
  }

  // find a row (if exists) by row number
  findRow(r: number): any {
    return this._rows[r - 1];
  }

  // find multiple rows (if exists) by row number
  findRows(start: number, length: number): any[] {
    return this._rows.slice(start - 1, start - 1 + length);
  }

  get rowCount(): number {
    return this._lastRowNumber;
  }

  get actualRowCount(): number {
    // counts actual rows that have actual data
    let count = 0;
    this.eachRow(() => {
      count++;
    });
    return count;
  }

  // get a row by row number.
  getRow(r: number): any {
    let row = this._rows[r - 1];
    if (!row) {
      row = this._rows[r - 1] = new Row(this, r);
    }
    return row;
  }

  // get multiple rows by row number.
  getRows(start: number, length: number): any[] | undefined {
    if (length < 1) {
      return undefined;
    }
    const rows: any[] = [];
    for (let i = start; i < start + length; i++) {
      rows.push(this.getRow(i));
    }
    return rows;
  }

  addRow(value: any, style: string = "n"): any {
    const rowNo = this._nextRow;
    const row = this.getRow(rowNo);
    row.values = value;
    this._setStyleOption(rowNo, style[0] === "i" ? style : "n");
    return row;
  }

  addRows(value: any[], style: string = "n"): any[] {
    const rows: any[] = [];
    value.forEach(row => {
      rows.push(this.addRow(row, style));
    });
    return rows;
  }

  insertRow(pos: number, value: any, style: string = "n"): any {
    this.spliceRows(pos, 0, value);
    this._setStyleOption(pos, style);
    return this.getRow(pos);
  }

  insertRows(pos: number, values: any[], style: string = "n"): any[] | undefined {
    this.spliceRows(pos, 0, ...values);
    if (style !== "n") {
      // copy over the styles
      for (let i = 0; i < values.length; i++) {
        if (style[0] === "o" && this.findRow(values.length + pos + i) !== undefined) {
          this._copyStyle(values.length + pos + i, pos + i, style[1] === "+");
        } else if (style[0] === "i" && this.findRow(pos - 1) !== undefined) {
          this._copyStyle(pos - 1, pos + i, style[1] === "+");
        }
      }
    }
    return this.getRows(pos, values.length);
  }

  // set row at position to same style as of either pervious row (option 'i') or next row (option 'o')
  _setStyleOption(pos: number, style: string = "n"): void {
    if (style[0] === "o" && this.findRow(pos + 1) !== undefined) {
      this._copyStyle(pos + 1, pos, style[1] === "+");
    } else if (style[0] === "i" && this.findRow(pos - 1) !== undefined) {
      this._copyStyle(pos - 1, pos, style[1] === "+");
    }
  }

  _copyStyle(src: number, dest: number, styleEmpty: boolean = false): void {
    const rSrc = this.getRow(src);
    const rDst = this.getRow(dest);
    rDst.style = copyStyle(rSrc.style);
    rSrc.eachCell({ includeEmpty: styleEmpty }, (cell: any, colNumber: number) => {
      rDst.getCell(colNumber).style = copyStyle(cell.style);
    });
    rDst.height = rSrc.height;
  }

  duplicateRow(rowNum: number, count: number, insert: boolean = false): void {
    // create count duplicates of rowNum
    // either inserting new or overwriting existing rows

    const rSrc = this._rows[rowNum - 1];
    const inserts = Array.from({ length: count }).fill(rSrc.values);
    this.spliceRows(rowNum + 1, insert ? 0 : count, ...inserts);

    // now copy styles...
    for (let i = 0; i < count; i++) {
      const rDst = this._rows[rowNum + i];
      rDst.style = rSrc.style;
      rDst.height = rSrc.height;
      rSrc.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
        rDst.getCell(colNumber).style = cell.style;
      });
    }
  }

  spliceRows(start: number, count: number, ...inserts: any[]): void {
    // same problem as row.splice, except worse.
    const nKeep = start + count;
    const nInserts = inserts.length;
    const nExpand = nInserts - count;
    const nEnd = this._rows.length;
    let i: number;
    let rSrc: any;
    if (nExpand < 0) {
      // remove rows
      if (start === nEnd) {
        this._rows[nEnd - 1] = undefined;
      }
      for (i = nKeep; i <= nEnd; i++) {
        rSrc = this._rows[i - 1];
        if (rSrc) {
          const rDst = this.getRow(i + nExpand);
          rDst.values = rSrc.values;
          rDst.style = rSrc.style;
          rDst.height = rSrc.height;
          rSrc.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
            rDst.getCell(colNumber).style = cell.style;
          });
          this._rows[i - 1] = undefined;
        } else {
          this._rows[i + nExpand - 1] = undefined;
        }
      }
    } else if (nExpand > 0) {
      // insert new cells
      for (i = nEnd; i >= nKeep; i--) {
        rSrc = this._rows[i - 1];
        if (rSrc) {
          const rDst = this.getRow(i + nExpand);
          rDst.values = rSrc.values;
          rDst.style = rSrc.style;
          rDst.height = rSrc.height;
          rSrc.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
            rDst.getCell(colNumber).style = cell.style;

            // remerge cells accounting for insert offset
            if (cell._value.constructor.name === "MergeValue") {
              const cellToBeMerged = this.getRow(cell._row._number + nInserts).getCell(colNumber);
              const prevMaster = cell._value._master;
              const newMaster = this.getRow(prevMaster._row._number + nInserts).getCell(
                prevMaster._column._number
              );
              cellToBeMerged.merge(newMaster);
            }
          });
        } else {
          this._rows[i + nExpand - 1] = undefined;
        }
      }
    }

    // now copy over the new values
    for (i = 0; i < nInserts; i++) {
      const rDst = this.getRow(start + i);
      rDst.style = {};
      rDst.values = inserts[i];
    }

    // account for defined names
    this.workbook.definedNames.spliceRows(this.name, start, count, nInserts);
  }

  // iterate over every row in the worksheet, including maybe empty rows
  eachRow(iteratee: (row: any, rowNumber: number) => void): void;
  eachRow(options: EachRowOptions, iteratee: (row: any, rowNumber: number) => void): void;
  eachRow(options: any, iteratee?: (row: any, rowNumber: number) => void): void {
    if (!iteratee) {
      iteratee = options;
      options = undefined;
    }
    if (options && options.includeEmpty) {
      const n = this._rows.length;
      for (let i = 1; i <= n; i++) {
        iteratee(this.getRow(i), i);
      }
    } else {
      this._rows.forEach(row => {
        if (row && row.hasValues) {
          iteratee(row, row.number);
        }
      });
    }
  }

  // return all rows as sparse array
  getSheetValues(): any[] {
    const rows: any[] = [];
    this._rows.forEach(row => {
      if (row) {
        rows[row.number] = row.values;
      }
    });
    return rows;
  }

  // =========================================================================
  // Cells

  // returns the cell at [r,c] or address given by r. If not found, return undefined
  findCell(r: number | string, c?: number): any {
    const address = colCache.getAddress(r, c);
    const row = this._rows[address.row - 1];
    return row ? row.findCell(address.col) : undefined;
  }

  // return the cell at [r,c] or address given by r. If not found, create a new one.
  getCell(r: number | string, c?: number): any {
    const address = colCache.getAddress(r, c);
    const row = this.getRow(address.row);
    return row.getCellEx(address);
  }

  // =========================================================================
  // Merge

  // convert the range defined by ['tl:br'], [tl,br] or [t,l,b,r] into a single 'merged' cell
  mergeCells(...cells: any[]): void {
    const dimensions = new Range(cells);
    this._mergeCellsInternal(dimensions);
  }

  mergeCellsWithoutStyle(...cells: any[]): void {
    const dimensions = new Range(cells);
    this._mergeCellsInternal(dimensions, true);
  }

  _mergeCellsInternal(dimensions: Range, ignoreStyle?: boolean): void {
    // check cells aren't already merged
    Object.values(this._merges).forEach((merge: Range) => {
      if (merge.intersects(dimensions)) {
        throw new Error("Cannot merge already merged cells");
      }
    });

    // apply merge
    const master = this.getCell(dimensions.top, dimensions.left);
    for (let i = dimensions.top; i <= dimensions.bottom; i++) {
      for (let j = dimensions.left; j <= dimensions.right; j++) {
        // merge all but the master cell
        if (i > dimensions.top || j > dimensions.left) {
          this.getCell(i, j).merge(master, ignoreStyle);
        }
      }
    }

    // index merge
    this._merges[master.address] = dimensions;
  }

  _unMergeMaster(master: any): void {
    // master is always top left of a rectangle
    const merge = this._merges[master.address];
    if (merge) {
      for (let i = merge.top; i <= merge.bottom; i++) {
        for (let j = merge.left; j <= merge.right; j++) {
          this.getCell(i, j).unmerge();
        }
      }
      delete this._merges[master.address];
    }
  }

  get hasMerges(): boolean {
    // return true if this._merges has a merge object
    return Object.values(this._merges).some(Boolean);
  }

  // scan the range defined by ['tl:br'], [tl,br] or [t,l,b,r] and if any cell is part of a merge,
  // un-merge the group. Note this function can affect multiple merges and merge-blocks are
  // atomic - either they're all merged or all un-merged.
  unMergeCells(...cells: any[]): void {
    const dimensions = new Range(cells);

    // find any cells in that range and unmerge them
    for (let i = dimensions.top; i <= dimensions.bottom; i++) {
      for (let j = dimensions.left; j <= dimensions.right; j++) {
        const cell = this.findCell(i, j);
        if (cell) {
          if (cell.type === Enums.ValueType.Merge) {
            // this cell merges to another master
            this._unMergeMaster(cell.master);
          } else if (this._merges[cell.address]) {
            // this cell is a master
            this._unMergeMaster(cell);
          }
        }
      }
    }
  }

  // ===========================================================================
  // Shared/Array Formula
  fillFormula(
    range: string,
    formula: string,
    results?: any[][] | any[] | ((row: number, col: number) => any),
    shareType: string = "shared"
  ): void {
    // Define formula for top-left cell and share to rest
    const decoded = colCache.decode(range) as any;
    const { top, left, bottom, right } = decoded;
    const width = right - left + 1;
    const masterAddress = colCache.encodeAddress(top, left);
    const isShared = shareType === "shared";

    // work out result accessor
    let getResult: (row: number, col: number) => any;
    if (typeof results === "function") {
      getResult = results;
    } else if (Array.isArray(results)) {
      if (Array.isArray(results[0])) {
        getResult = (row: number, col: number) => (results as any[][])[row - top][col - left];
      } else {
        getResult = (row: number, col: number) =>
          (results as any[])[(row - top) * width + (col - left)];
      }
    } else {
      getResult = () => undefined;
    }
    let first = true;
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        if (first) {
          this.getCell(r, c).value = {
            shareType,
            formula,
            ref: range,
            result: getResult(r, c)
          };
          first = false;
        } else {
          this.getCell(r, c).value = isShared
            ? {
                sharedFormula: masterAddress,
                result: getResult(r, c)
              }
            : getResult(r, c);
        }
      }
    }
  }

  // =========================================================================
  // Images
  addImage(imageId: number, range: any): void {
    const model = {
      type: "image",
      imageId: String(imageId),
      range
    };
    this._media.push(new Image(this, model));
  }

  getImages(): any[] {
    return this._media.filter(m => m.type === "image");
  }

  addBackgroundImage(imageId: number): void {
    const model = {
      type: "background",
      imageId: String(imageId)
    };
    this._media.push(new Image(this, model));
  }

  getBackgroundImageId(): number | undefined {
    const image = this._media.find(m => m.type === "background");
    return image && image.imageId;
  }

  // =========================================================================
  // Worksheet Protection
  protect(password?: string, options?: any): Promise<void> {
    // TODO: make this function truly async
    // perhaps marshal to worker thread or something
    return new Promise(resolve => {
      this.sheetProtection = {
        sheet: true
      };
      if (options && "spinCount" in options) {
        // force spinCount to be integer >= 0
        options.spinCount = Number.isFinite(options.spinCount)
          ? Math.round(Math.max(0, options.spinCount))
          : 100000;
      }
      if (password) {
        this.sheetProtection.algorithmName = "SHA-512";
        this.sheetProtection.saltValue = Encryptor.randomBytes(16).toString("base64");
        this.sheetProtection.spinCount =
          options && "spinCount" in options ? options.spinCount : 100000; // allow user specified spinCount
        this.sheetProtection.hashValue = Encryptor.convertPasswordToHash(
          password,
          "SHA512",
          this.sheetProtection.saltValue,
          this.sheetProtection.spinCount
        );
      }
      if (options) {
        this.sheetProtection = Object.assign(this.sheetProtection, options);
        if (!password && "spinCount" in options) {
          delete this.sheetProtection.spinCount;
        }
      }
      resolve();
    });
  }

  unprotect(): void {
    this.sheetProtection = null;
  }

  // =========================================================================
  // Tables
  addTable(model: any): Table {
    const table = new Table(this, model);
    this.tables[model.name] = table;
    return table;
  }

  getTable(name: string): Table {
    return this.tables[name];
  }

  removeTable(name: string): void {
    delete this.tables[name];
  }

  getTables(): Table[] {
    return Object.values(this.tables);
  }

  // =========================================================================
  // Pivot Tables
  addPivotTable(model: any): any {
    console.warn(
      `Warning: Pivot Table support is experimental. 
Please leave feedback at https://github.com/excelts/excelts/discussions/2575`
    );

    const pivotTable = makePivotTable(this, model);

    this.pivotTables.push(pivotTable);
    this.workbook.pivotTables.push(pivotTable);

    return pivotTable;
  }

  // ===========================================================================
  // Conditional Formatting
  addConditionalFormatting(cf: any): void {
    this.conditionalFormattings.push(cf);
  }

  removeConditionalFormatting(
    filter: number | ((value: any, index: number, array: any[]) => boolean)
  ): void {
    if (typeof filter === "number") {
      this.conditionalFormattings.splice(filter, 1);
    } else if (filter instanceof Function) {
      this.conditionalFormattings = this.conditionalFormattings.filter(filter);
    } else {
      this.conditionalFormattings = [];
    }
  }

  // ===========================================================================
  // Model

  get model(): WorksheetModel {
    const model: WorksheetModel = {
      id: this.id,
      name: this.name,
      dataValidations: this.dataValidations.model,
      properties: this.properties,
      state: this.state,
      pageSetup: this.pageSetup,
      headerFooter: this.headerFooter,
      rowBreaks: this.rowBreaks,
      views: this.views,
      autoFilter: this.autoFilter,
      media: this._media.map(medium => medium.model),
      sheetProtection: this.sheetProtection,
      tables: Object.values(this.tables).map(table => table.model),
      pivotTables: this.pivotTables,
      conditionalFormattings: this.conditionalFormattings
    };

    // =================================================
    // columns
    model.cols = Column.toModel(this.columns as any);

    // ==========================================================
    // Rows
    const rows: any[] = (model.rows = []);
    const dimensions: Range = (model.dimensions = new Range());
    this._rows.forEach(row => {
      const rowModel = row && row.model;
      if (rowModel) {
        dimensions.expand(rowModel.number, rowModel.min, rowModel.number, rowModel.max);
        rows.push(rowModel);
      }
    });

    // ==========================================================
    // Merges
    model.merges = [];
    Object.values(this._merges).forEach((merge: Range) => {
      model.merges!.push(merge.range);
    });

    return model;
  }

  _parseRows(model: WorksheetModel): void {
    this._rows = [];
    if (model.rows) {
      model.rows.forEach(rowModel => {
        const row = new Row(this, rowModel.number);
        this._rows[row.number - 1] = row;
        row.model = rowModel;
      });
    }
  }

  _parseMergeCells(model: WorksheetModel): void {
    if (model.mergeCells) {
      model.mergeCells.forEach((merge: string) => {
        // Do not merge styles when importing an Excel file
        // since each cell may have different styles intentionally.
        this.mergeCellsWithoutStyle(merge);
      });
    }
  }

  set model(value: WorksheetModel) {
    this.name = value.name;
    this._columns = Column.fromModel(this, value.cols);
    this._parseRows(value);

    this._parseMergeCells(value);
    this.dataValidations = new DataValidations(value.dataValidations);
    this.properties = value.properties;
    this.pageSetup = value.pageSetup;
    this.headerFooter = value.headerFooter;
    this.views = value.views;
    this.autoFilter = value.autoFilter;
    this._media = value.media.map(medium => new Image(this, medium));
    this.sheetProtection = value.sheetProtection;
    this.tables = value.tables.reduce((tables: { [key: string]: Table }, table: any) => {
      const t = new Table(this, table);
      t.model = table;
      tables[table.name] = t;
      return tables;
    }, {});
    this.pivotTables = value.pivotTables;
    this.conditionalFormattings = value.conditionalFormattings;
  }
}

export { Worksheet };
