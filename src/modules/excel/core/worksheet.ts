// Chart runtime is imported directly (static). The chart modules depend only
// on the `*-core` data layer (never on this heavy `worksheet.ts`), so the
// dependency graph stays acyclic: `worksheet → chart → *-core`. A consumer
// that never references a chart API gets the entire chart implementation
// tree-shaken out by the bundler — no host registry / install step required.
import {
  chartExOptionsFromRows,
  chartExOptionsFromTable,
  chartOptionsFromRows,
  chartOptionsFromTable,
  seriesFromColumns as chartSeriesFromColumns
} from "@excel/chart/build/chart-api";
import type {
  AddChartExFromRowsOptions,
  AddChartExFromTableOptions,
  AddChartFromRowsOptions,
  AddChartFromTableOptions,
  SeriesFromColumnsOptions
} from "@excel/chart/build/chart-api";
import { buildChartModel, buildComboChartModel } from "@excel/chart/build/chart-builder";
import { buildChartExModel } from "@excel/chart/build/chart-ex-builder";
import { createChart, registerChart, registerChartEx } from "@excel/chart/chart-handle";
import type { AddChartExOptions } from "@excel/chart/model/chart-ex-types";
import { applyChartExPreset, applyChartPreset } from "@excel/chart/model/chart-presets";
import type { ExcelChartExPreset, ExcelChartPreset } from "@excel/chart/model/chart-presets";
import type {
  AddBarChartOptions,
  AddChartOptions,
  AddChartRange,
  AddComboChartOptions,
  AddPieChartOptions,
  AddScatterChartOptions,
  AddSurfaceChartOptions,
  ChartAnchorModel
} from "@excel/chart/model/types";
import type { CellData, FormulaResult, FormulaValueData } from "@excel/core/cell";
import {
  cellAlignment,
  cellCol,
  cellComment,
  cellGetValue,
  cellIsMerged,
  cellMaster,
  cellMerge,
  cellSetComment,
  cellSetValue,
  cellType,
  cellUnmerge,
  cellView
} from "@excel/core/cell";
import type { ColumnData, ColumnModel, ColumnDefn } from "@excel/core/column";
import { columnDefn, columnToModel } from "@excel/core/column";
import { createDataValidations } from "@excel/core/data-validations";
import { definedNamesSpliceColumns, definedNamesSpliceRows } from "@excel/core/defined-names";
import { Enums } from "@excel/core/enums";
import type {
  FormCheckboxData,
  FormCheckboxModel,
  FormCheckboxOptions,
  FormControlRange
} from "@excel/core/form-control";
import { formCheckboxCreate, formCheckboxFromModel } from "@excel/core/form-control";
import type { ImageData, ImageModel } from "@excel/core/image";
import { imageClone, imageCreate, imageModel } from "@excel/core/image";
import { withPivotChartSource } from "@excel/core/pivot-chart";
import type { PivotTable, PivotTableModel } from "@excel/core/pivot-table";
import { makePivotTable } from "@excel/core/pivot-table";
import type { RangeData, RangeInput } from "@excel/core/range";
import { rangeCreate, rangeExpand, rangeIntersects, rangeRange } from "@excel/core/range";
import type { RowData, RowModel } from "@excel/core/row";
import {
  rowCellCount,
  rowCreate,
  rowDimensions,
  rowFindCell,
  rowGetModel,
  rowHidden,
  rowValues
} from "@excel/core/row";
import type { AddSparklineGroupOptions, SparklineGroup } from "@excel/core/sparkline";
import { buildSparklineGroup } from "@excel/core/sparkline";
import type { TableData, TableModel } from "@excel/core/table";
import { createTable, tableModel, tableName, tableSetModel } from "@excel/core/table";
import type { Workbook } from "@excel/core/workbook";
import {
  getDefinedNames,
  getImage,
  removeChartEntry,
  removeChartExStructuredEntry,
  removeWorksheetEx,
  validateSheetName
} from "@excel/core/workbook-core";
import type {
  AutoFilterCriteria,
  WorksheetData,
  SheetProtection,
  ChartHandle
} from "@excel/core/worksheet-core";
import {
  _copyStyle,
  _setStyleOption,
  columnCreate,
  columnFromModel,
  columnSetDefn,
  eachRow,
  findCell,
  findRow,
  getCell,
  getColumn,
  get_lastRowNumber,
  getRow,
  getRows,
  getSheetName,
  getSheetWorkbook,
  rowEachCell,
  rowGetCell,
  rowSetModel,
  rowSetValues,
  rowSplice
} from "@excel/core/worksheet-core";
import { ImageError, MergeConflictError, TableError } from "@excel/errors";
import type {
  AddImageRange,
  AddShapeOptions,
  AutoFilter,
  CellValue,
  ColBreak,
  ConditionalFormattingOptions,
  DataValidation,
  HeaderFooter,
  HeaderFooterImagePosition,
  IgnoredError,
  PageSetup,
  RowBreak,
  RowValues,
  ShapeModel,
  Style,
  TableProperties,
  ThreadedComment,
  WatermarkOptions,
  WorksheetProperties,
  WorksheetState,
  WorksheetView
} from "@excel/types";
import type { Origin } from "@excel/utils/address";
import { decodeCell, decodeRange, encodeCol } from "@excel/utils/address";
import { getCellDisplayText } from "@excel/utils/cell-format";
import type { DecodedRange } from "@excel/utils/col-cache";
import { colCache } from "@excel/utils/col-cache";
import { copyStyle } from "@excel/utils/copy-style";
import { isExternalImage } from "@excel/utils/drawing-utils";
import { applyMergeBorders, collectMergeBorders } from "@excel/utils/merge-borders";
import { buildSheetProtection, verifySheetPassword } from "@excel/utils/sheet-protection";
import {
  calculateAutoFitWidth,
  getMaxDigitWidth,
  getColumnContentWidthPx,
  getCellTextWidthPx,
  getCellHeightPt
} from "@excel/utils/text-metrics";

// Type for data validation model - maps address to validation
type DataValidationModel = { [address: string]: DataValidation | undefined };

interface WorksheetOptions {
  workbook?: Workbook;
  id?: number;
  orderNo?: number;
  name?: string;
  state?: WorksheetState;
  properties?: Partial<WorksheetProperties>;
  pageSetup?: Partial<PageSetup>;
  headerFooter?: Partial<HeaderFooter>;
  views?: Partial<WorksheetView>[];
  autoFilter?: AutoFilter | null;
}

interface WorksheetModel {
  id: number;
  name: string;
  dataValidations: DataValidationModel;
  properties: Partial<WorksheetProperties>;
  state: WorksheetState;
  pageSetup: PageSetup;
  headerFooter: HeaderFooter;
  rowBreaks: RowBreak[];
  colBreaks: ColBreak[];
  views: Partial<WorksheetView>[];
  autoFilter: AutoFilter | null;
  autoFilterCriteria?: AutoFilterCriteria;
  sortStateXml?: string;
  worksheetNamespaceAttributes?: Record<string, string>;
  worksheetMcIgnorable?: string;
  sortStateAutoFilterRef?: string;
  media: ImageModel[];
  shapes?: ShapeModel[];
  sheetProtection: SheetProtection | null;
  tables: TableModel[];
  pivotTables: PivotTable[];
  conditionalFormattings: ConditionalFormattingOptions[];
  formControls: FormCheckboxModel[];
  ignoredErrors: IgnoredError[];
  watermark?: WatermarkOptions | null;
  /** Internal snapshot used to make API-owned header watermark removal reversible. */
  cols?: ColumnModel[];
  rows?: RowModel[];
  dimensions?: RangeData;
  mergeCells?: string[];
  /** Loaded drawing data (for charts, etc.) - preserved for round-trip */
  drawing?: unknown;
  /** Chart anchor models for worksheet charts */
  charts?: ChartAnchorModel[];
  /** Sparkline groups (x14:sparklineGroups) */
  sparklineGroups?: SparklineGroup[];
  /**
   * Office 365 threaded comments for this worksheet. Rendered as a
   * separate `xl/threadedComments/threadedComment{N}.xml` part. Empty
   * when the sheet has no modern comments.
   */
  threadedComments?: Array<{ ref: string; comment: ThreadedComment }>;
}

// Worksheet requirements
//  Operate as sheet inside workbook or standalone
//  Load and Save from file and stream
//  Access/Add/Delete individual cells
//  Manage column widths and row heights

export function createWorksheet(options: WorksheetOptions): WorksheetData {
  const ws = {} as WorksheetData;

  ws._workbook = options.workbook!;

  // in a workbook, each sheet will have a number
  ws.id = options.id ?? 0;
  ws.orderNo = options.orderNo ?? 0;

  // and a name - use the setter to ensure validation and truncation
  setSheetName(ws, options.name || `sheet${ws.id}`);

  // add a state
  ws.state = options.state ?? "visible";

  // rows allows access organised by row. Sparse array of arrays indexed by row-1, col
  // Note: _rows is zero based. Must subtract 1 to go from Cell.row(cell) to index
  ws._rows = [];

  // column definitions
  ws._columns = [];

  // column keys (addRow convenience): key ==> this._collumns index
  ws._keys = {};

  // keep record of all merges
  ws._merges = {};

  // record of all row and column pageBreaks
  ws.rowBreaks = [];
  ws.colBreaks = [];

  // for tabColor, default row height, outline levels, etc
  ws.properties = {
    defaultRowHeight: 15,
    outlineLevelCol: 0,
    outlineLevelRow: 0,
    ...options.properties
  };

  // for all things printing
  ws.pageSetup = {
    margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    orientation: "portrait",
    // Excel does not normally write these unless explicitly set.
    // Historically we used 4294967295 as a sentinel when parsing, but emitting it
    // can cause strict Excel parsers to treat the workbook as corrupted.
    horizontalDpi: undefined,
    verticalDpi: undefined,
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
    colBreaks: null,
    ...options.pageSetup
  } as PageSetup;

  ws.headerFooter = {
    differentFirst: false,
    differentOddEven: false,
    scaleWithDoc: true,
    alignWithMargins: true,
    oddHeader: null,
    oddFooter: null,
    evenHeader: null,
    evenFooter: null,
    firstHeader: null,
    firstFooter: null,
    ...options.headerFooter
  };

  ws.dataValidations = createDataValidations();

  // for freezepanes, split, zoom, gridlines, etc
  ws.views = options.views ?? [];

  ws.autoFilter = options.autoFilter ?? null;

  // for images, etc
  ws._media = [];

  // for user-drawn shapes (rectangles, lines, text boxes, …)
  ws._shapes = [];

  // for charts
  ws._charts = [];
  ws._sparklineGroups = [];

  // worksheet protection
  ws.sheetProtection = null;

  // for tables
  ws.tables = {};

  ws.pivotTables = [];

  ws.conditionalFormattings = [];

  // for form controls (legacy checkboxes, etc.)
  ws.formControls = [];

  // ignored errors (suppress green triangles in Excel)
  ws.ignoredErrors = [];

  // Office 365 threaded comments (separate from classic VML notes).
  ws.threadedComments = [];

  // watermark configuration
  ws._watermark = null;
  ws._watermarkMedia = null;

  return ws;
}

export function destroy(ws: WorksheetData): void {
  removeWorksheetEx(ws._workbook, ws);
}

export function spliceColumns(
  ws: WorksheetData,
  start: number,
  count: number,
  ...inserts: CellValue[][]
): void {
  // Before splicing cells, release all cell-level merge references so that
  // row.splice copies plain values instead of merge proxies.
  // _spliceMerges (called later) will rebuild cell-level refs at new coordinates.
  for (const merge of Object.values(ws._merges)) {
    for (let r = merge.top; r <= merge.bottom; r++) {
      for (let c = merge.left; c <= merge.right; c++) {
        const cell = findCell(ws, r, c);
        if (cell && cellType(cell) === Enums.ValueType.Merge) {
          cellUnmerge(cell);
        }
      }
    }
  }

  const rows = ws._rows;
  const nRows = rows.length;
  if (inserts.length > 0) {
    // must iterate over all rows whether they exist yet or not
    for (let i = 0; i < nRows; i++) {
      const insertValues = inserts.map(insert => insert[i] ?? null);
      const row = getRow(ws, i + 1);
      rowSplice(row, start, count, ...insertValues);
    }
  } else {
    // nothing to insert, so just splice all rows
    ws._rows.forEach(r => {
      if (r) {
        rowSplice(r, start, count);
      }
    });
  }

  // splice column definitions
  const nExpand = inserts.length - count;
  const nKeep = start + count;
  const nEnd = ws._columns.length;
  if (nExpand < 0) {
    for (let i = start + inserts.length; i <= nEnd; i++) {
      columnSetDefn(getColumn(ws, i), columnDefn(getColumn(ws, i - nExpand)));
    }
  } else if (nExpand > 0) {
    for (let i = nEnd; i >= nKeep; i--) {
      columnSetDefn(getColumn(ws, i + nExpand), columnDefn(getColumn(ws, i)));
    }
  }
  for (let i = start; i < start + inserts.length; i++) {
    columnSetDefn(getColumn(ws, i), undefined);
  }

  // account for defined names
  definedNamesSpliceColumns(
    getDefinedNames(getSheetWorkbook(ws)),
    getSheetName(ws),
    start,
    count,
    inserts.length
  );

  // account for images
  if (nExpand !== 0) {
    for (const image of ws._media) {
      if (image.type === "image" && image.range) {
        const { tl, br } = image.range;
        if (tl && tl.nativeCol >= start - 1) {
          tl.nativeCol = Math.max(0, tl.nativeCol + nExpand);
        }
        if (br && br.nativeCol >= start - 1) {
          br.nativeCol = Math.max(0, br.nativeCol + nExpand);
        }
      }
    }

    // account for chart anchors in drawing and programmatic chart objects
    _shiftChartAnchors(ws, "col", start - 1, nExpand);
  }

  // account for merges
  _spliceMerges(ws, "col", start, count, inserts.length);
}

export function insertRow(
  ws: WorksheetData,
  pos: number,
  value: RowValues,
  style: string = "n"
): RowData {
  spliceRows(ws, pos, 0, value);
  _setStyleOption(ws, pos, style);
  return getRow(ws, pos);
}

export function insertRows(
  ws: WorksheetData,
  pos: number,
  values: RowValues[],
  style: string = "n"
): RowData[] | undefined {
  spliceRows(ws, pos, 0, ...values);
  if (style !== "n") {
    // copy over the styles
    for (let i = 0; i < values.length; i++) {
      if (style[0] === "o" && findRow(ws, values.length + pos + i) !== undefined) {
        _copyStyle(ws, values.length + pos + i, pos + i, style[1] === "+");
      } else if (style[0] === "i" && findRow(ws, pos - 1) !== undefined) {
        _copyStyle(ws, pos - 1, pos + i, style[1] === "+");
      }
    }
  }
  return getRows(ws, pos, values.length);
}

export function duplicateRow(
  ws: WorksheetData,
  rowNum: number,
  count: number,
  insert: boolean = false
): void {
  // create count duplicates of rowNum
  // either inserting new or overwriting existing rows

  const rSrc = getRow(ws, rowNum);
  const inserts = Array.from<RowValues>({ length: count }).fill(rowValuesForStructuralCopy(rSrc));

  // Collect single-row merges from the source row before splicing
  // (only merges where top == bottom == rowNum, i.e. horizontal merges within one row)
  const srcMerges: RangeData[] = [];
  for (const merge of Object.values(ws._merges)) {
    if (merge.top === rowNum && merge.bottom === rowNum) {
      srcMerges.push(merge);
    }
  }

  // Collect images anchored to the source row before splicing
  // (images whose top-left anchor is on the source row)
  const srcImages: ImageData[] = [];
  const srcRow0 = rowNum - 1; // 0-based source row
  for (const image of ws._media) {
    if (image.type === "image" && image.range) {
      if (image.range.tl.nativeRow === srcRow0) {
        srcImages.push(image);
      }
    }
  }

  spliceRows(ws, rowNum + 1, insert ? 0 : count, ...inserts);

  // now copy styles...
  for (let i = 0; i < count; i++) {
    const rDst = ws._rows[rowNum + i];
    rDst.style = copyStyle(rSrc.style) ?? {};
    rDst.height = rSrc.height;
    rowEachCell(rSrc, { includeEmpty: true }, (cell: CellData, colNumber: number) => {
      rowGetCell(rDst, colNumber).style = copyStyle(cell.style) ?? {};
    });
  }

  // Duplicate single-row merges from source row into each new row
  if (srcMerges.length > 0) {
    for (let i = 0; i < count; i++) {
      const dstRow = rowNum + 1 + i;

      // In overwrite mode, clear any existing merges in the target row
      if (!insert) {
        const toRemove: string[] = [];
        for (const [key, merge] of Object.entries(ws._merges)) {
          if (merge.top <= dstRow && merge.bottom >= dstRow) {
            toRemove.push(key);
          }
        }
        for (const key of toRemove) {
          _unMergeMaster(ws, getCell(ws, key));
        }
      }

      for (const srcMerge of srcMerges) {
        mergeCellsWithoutStyle(ws, dstRow, srcMerge.left, dstRow, srcMerge.right);
      }
    }
  }

  // Duplicate images from source row into each new row.
  // In overwrite mode, first remove any images anchored to the target rows
  // so they don't coexist with the clones (mirrors merge cleanup above).
  if (!insert) {
    const dstStart0 = rowNum; // first target row, 0-based (1-based rowNum + 1 → 0-based rowNum)
    const dstEnd0 = rowNum + count - 1; // last target row, 0-based
    ws._media = ws._media.filter(image => {
      if (image.type === "image" && image.range) {
        const row0 = image.range.tl.nativeRow;
        return row0 < dstStart0 || row0 > dstEnd0;
      }
      return true;
    });
  }

  for (let i = 0; i < count; i++) {
    const rowDelta = i + 1; // offset from source row to target row
    for (const srcImage of srcImages) {
      const cloned = imageClone(srcImage);
      cloned.range!.tl.nativeRow = srcRow0 + rowDelta;
      if (cloned.range!.br) {
        const brDelta = srcImage.range!.br!.nativeRow - srcRow0;
        cloned.range!.br.nativeRow = srcRow0 + rowDelta + brDelta;
      }
      ws._media.push(cloned);
    }
  }
}

export function spliceRows(
  ws: WorksheetData,
  start: number,
  count: number,
  ...inserts: RowValues[]
): void {
  // same problem as row.splice, except worse.

  // Before splicing rows, release all cell-level merge references so that
  // row value copies work on plain values instead of merge proxies.
  // _spliceMerges (called later) will rebuild cell-level refs at new coordinates.
  for (const merge of Object.values(ws._merges)) {
    for (let r = merge.top; r <= merge.bottom; r++) {
      for (let c = merge.left; c <= merge.right; c++) {
        const cell = findCell(ws, r, c);
        if (cell && cellType(cell) === Enums.ValueType.Merge) {
          cellUnmerge(cell);
        }
      }
    }
  }

  const nKeep = start + count;
  const nInserts = inserts.length;
  const nExpand = nInserts - count;
  const nEnd = ws._rows.length;
  let i: number;
  let rSrc: RowData | undefined;
  if (nExpand < 0) {
    // remove rows
    if (start === nEnd) {
      ws._rows[nEnd - 1] = undefined!;
    }
    for (i = nKeep; i <= nEnd; i++) {
      rSrc = ws._rows[i - 1];
      if (rSrc) {
        const rDst = getRow(ws, i + nExpand);
        rowSetValues(rDst, rowValuesForStructuralCopy(rSrc));
        rDst.style = (copyStyle(rSrc.style) as Partial<Style>) ?? {};
        rDst.height = rSrc.height;
        rowEachCell(rSrc, { includeEmpty: true }, (cell: CellData, colNumber: number) => {
          const target = rowGetCell(rDst, colNumber);
          target.style = (copyStyle(cell.style) as Partial<Style>) ?? {};
          cellSetComment(target, cellComment(cell));
        });
        ws._rows[i - 1] = undefined!;
      } else {
        ws._rows[i + nExpand - 1] = undefined!;
      }
    }
  } else if (nExpand > 0) {
    // insert new cells
    for (i = nEnd; i >= nKeep; i--) {
      rSrc = ws._rows[i - 1];
      if (rSrc) {
        const rDst = getRow(ws, i + nExpand);
        rowSetValues(rDst, rowValuesForStructuralCopy(rSrc));
        rDst.style = (copyStyle(rSrc.style) as Partial<Style>) ?? {};
        rDst.height = rSrc.height;
        rowEachCell(rSrc, { includeEmpty: true }, (cell: CellData, colNumber: number) => {
          const target = rowGetCell(rDst, colNumber);
          target.style = (copyStyle(cell.style) as Partial<Style>) ?? {};
          cellSetComment(target, cellComment(cell));
        });
      } else {
        ws._rows[i + nExpand - 1] = undefined!;
      }
    }
  }

  // now copy over the new values
  for (i = 0; i < nInserts; i++) {
    const rDst = getRow(ws, start + i);
    rDst.style = {};
    rowSetValues(rDst, inserts[i]);
  }

  // account for defined names
  definedNamesSpliceRows(
    getDefinedNames(getSheetWorkbook(ws)),
    getSheetName(ws),
    start,
    count,
    nInserts
  );

  // account for images
  if (nExpand !== 0) {
    for (const image of ws._media) {
      if (image.type === "image" && image.range) {
        const { tl, br } = image.range;
        if (tl && tl.nativeRow >= start - 1) {
          tl.nativeRow = Math.max(0, tl.nativeRow + nExpand);
        }
        if (br && br.nativeRow >= start - 1) {
          br.nativeRow = Math.max(0, br.nativeRow + nExpand);
        }
      }
    }

    // account for chart anchors in drawing and programmatic chart objects
    _shiftChartAnchors(ws, "row", start - 1, nExpand);
  }

  // account for merges
  _spliceMerges(ws, "row", start, count, nInserts);
}

function rowValuesForStructuralCopy(row: RowData): CellValue[] {
  const values = rowValues(row);
  row.cells.forEach(cell => {
    if (cell?._formulaGhostOwner !== undefined) {
      values[cellCol(cell)] = null;
    }
  });
  return values;
}

export function mergeCells(ws: WorksheetData, ...cells: RangeInput[]): void {
  const dimensions = rangeCreate(cells);
  _mergeCellsInternal(ws, dimensions);
}

export function mergeCellsWithoutStyle(ws: WorksheetData, ...cells: RangeInput[]): void {
  const dimensions = rangeCreate(cells);
  _mergeCellsInternal(ws, dimensions, true);
}

export function _mergeCellsInternal(
  ws: WorksheetData,
  dimensions: RangeData,
  ignoreStyle?: boolean
): void {
  // check cells aren't already merged
  Object.values(ws._merges).forEach((merge: RangeData) => {
    if (rangeIntersects(merge, dimensions)) {
      throw new MergeConflictError();
    }
  });

  const { top, left, bottom, right } = dimensions;

  // Collect perimeter borders BEFORE merge overwrites slave styles
  const collected = ignoreStyle
    ? undefined
    : collectMergeBorders(top, left, bottom, right, (r, c) => findCell(ws, r, c));

  // Apply merge — slave cells inherit the master's full style
  const master = getCell(ws, dimensions.top, dimensions.left);
  // A merge turns the top-left cell into user-owned content. It must no
  // longer be treated as a derived spill ghost during cleanup/serialization.
  master._formulaGhostOwner = undefined;
  for (let i = top; i <= bottom; i++) {
    for (let j = left; j <= right; j++) {
      if (i > top || j > left) {
        cellMerge(getCell(ws, i, j), master, ignoreStyle);
      }
    }
  }

  // Reconstruct position-aware borders (like Excel):
  // outer borders survive, inner borders are cleared.
  if (collected) {
    applyMergeBorders(top, left, bottom, right, collected, (r, c) => getCell(ws, r, c));
  }

  // index merge
  ws._merges[master.address] = dimensions;
}

export function _unMergeMaster(ws: WorksheetData, master: CellData): void {
  // master is always top left of a rectangle
  const merge = ws._merges[master.address];
  if (merge) {
    for (let i = merge.top; i <= merge.bottom; i++) {
      for (let j = merge.left; j <= merge.right; j++) {
        cellUnmerge(getCell(ws, i, j));
      }
    }
    delete ws._merges[master.address];
  }
}

export function _shiftChartAnchors(
  ws: WorksheetData,
  axis: "row" | "col",
  threshold: number,
  delta: number
): void {
  const prop = axis === "row" ? "nativeRow" : "nativeCol";

  // Drawing anchors (from loaded file)
  type AnchorPos = { nativeRow?: number; nativeCol?: number };
  const drawing = ws._drawing as
    | { anchors?: { range?: { tl?: AnchorPos; br?: AnchorPos } }[] }
    | undefined;
  if (drawing?.anchors) {
    for (const anchor of drawing.anchors) {
      const tl = anchor.range?.tl;
      const br = anchor.range?.br;
      if (tl && tl[prop] !== undefined && tl[prop]! >= threshold) {
        tl[prop] = Math.max(0, tl[prop]! + delta);
      }
      if (br && br[prop] !== undefined && br[prop]! >= threshold) {
        br[prop] = Math.max(0, br[prop]! + delta);
      }
    }
  }

  // Programmatic chart objects
  for (const chart of ws._charts) {
    const { tl, br } = chart.range;
    if (tl[prop] >= threshold) {
      tl[prop] = Math.max(0, tl[prop] + delta);
    }
    if (br && br[prop] >= threshold) {
      br[prop] = Math.max(0, br[prop] + delta);
    }
  }
}

export function _spliceMerges(
  ws: WorksheetData,
  axis: "row" | "col",
  start: number,
  count: number,
  nInserts: number
): void {
  const nExpand = nInserts - count;
  if (nExpand === 0 && count === 0) {
    return;
  }
  const nKeep = start + count;
  const isRow = axis === "row";

  const newMerges: Record<string, RangeData> = {};

  for (const merge of Object.values(ws._merges)) {
    const { top, left, bottom, right } = merge;
    // For row axis: lo=top, hi=bottom. For col axis: lo=left, hi=right.
    const lo = isRow ? top : left;
    const hi = isRow ? bottom : right;

    if (nExpand <= 0 && count > 0) {
      // Deleting rows/columns
      const deleteEnd = nKeep - 1;
      if (lo > deleteEnd) {
        // Entirely after deleted range — shift
        const newRange = isRow
          ? rangeCreate(top + nExpand, left, bottom + nExpand, right)
          : rangeCreate(top, left + nExpand, bottom, right + nExpand);
        newMerges[colCache.encodeAddress(newRange.top, newRange.left)] = newRange;
      } else if (hi < start) {
        // Entirely before deleted range — unchanged
        newMerges[colCache.encodeAddress(top, left)] = merge;
      } else if (lo >= start && hi <= deleteEnd) {
        // Entirely within deleted range — remove
      } else {
        // Spans splice boundary — shrink
        let newTop = top;
        let newLeft = left;
        let newBottom = bottom;
        let newRight = right;
        if (isRow) {
          newTop = top < start ? top : start;
          newBottom = Math.max(newTop, bottom + nExpand);
        } else {
          newLeft = left < start ? left : start;
          newRight = Math.max(newLeft, right + nExpand);
        }
        const newRange = rangeCreate(newTop, newLeft, newBottom, newRight);
        if (newTop === newBottom && newLeft === newRight) {
          // Degenerate 1x1 merge — remove instead of keeping
        } else {
          newMerges[colCache.encodeAddress(newRange.top, newRange.left)] = newRange;
        }
      }
    } else {
      // Inserting rows/columns: shift items at/after nKeep
      if (lo >= nKeep) {
        // Entirely at or after splice — shift
        const newRange = isRow
          ? rangeCreate(top + nExpand, left, bottom + nExpand, right)
          : rangeCreate(top, left + nExpand, bottom, right + nExpand);
        newMerges[colCache.encodeAddress(newRange.top, newRange.left)] = newRange;
      } else if (hi < nKeep) {
        // Entirely before splice — unchanged
        newMerges[colCache.encodeAddress(top, left)] = merge;
      } else {
        // Spans splice boundary — stretch
        if (isRow) {
          merge.bottom = bottom + nExpand;
        } else {
          merge.right = right + nExpand;
        }
        newMerges[colCache.encodeAddress(top, left)] = merge;
      }
    }
  }

  ws._merges = newMerges;

  // Rebuild cell-level merge references for all merges.
  // Pre-unmerge in spliceRows/spliceColumns clears all cell refs,
  // so we must rebuild every merge, not just moved/resized ones.
  for (const m of Object.values(newMerges)) {
    const master = getCell(ws, m.top, m.left);
    for (let r = m.top; r <= m.bottom; r++) {
      for (let c = m.left; c <= m.right; c++) {
        if (r > m.top || c > m.left) {
          cellMerge(getCell(ws, r, c), master, true);
        }
      }
    }
  }
}

export function unMergeCells(ws: WorksheetData, ...cells: RangeInput[]): void {
  const dimensions = rangeCreate(cells);

  // find any cells in that range and unmerge them
  for (let i = dimensions.top; i <= dimensions.bottom; i++) {
    for (let j = dimensions.left; j <= dimensions.right; j++) {
      const cell = findCell(ws, i, j);
      if (cell) {
        if (cellType(cell) === Enums.ValueType.Merge) {
          // this cell merges to another master
          _unMergeMaster(ws, cellMaster(cell));
        } else if (ws._merges[cell.address]) {
          // this cell is a master
          _unMergeMaster(ws, cell);
        }
      }
    }
  }
}

export function fillFormula(
  ws: WorksheetData,
  range: string,
  formula: string,
  results?:
    | FormulaResult[][]
    | FormulaResult[]
    | ((row: number, col: number) => FormulaResult | undefined),
  shareType: string = "shared"
): void {
  // Define formula for top-left cell and share to rest
  const decoded = colCache.decode(range) as DecodedRange;
  const { top, left, bottom, right } = decoded;
  const width = right - left + 1;
  const masterAddress = colCache.encodeAddress(top, left);
  const isShared = shareType === "shared";

  // work out result accessor
  let getResult: (row: number, col: number) => FormulaResult | undefined;
  if (typeof results === "function") {
    getResult = results;
  } else if (Array.isArray(results)) {
    if (Array.isArray(results[0])) {
      getResult = (row: number, col: number) =>
        (results as FormulaResult[][])[row - top][col - left];
    } else {
      getResult = (row: number, col: number) =>
        (results as FormulaResult[])[(row - top) * width + (col - left)];
    }
  } else {
    getResult = () => undefined;
  }
  let first = true;
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      if (first) {
        const cell = getCell(ws, r, c);
        const formulaValue: FormulaValueData = {
          shareType,
          formula,
          ref: range,
          result: getResult(r, c)
        };
        cellSetValue(cell, formulaValue as CellValue);
        first = false;
      } else {
        cellSetValue(
          getCell(ws, r, c),
          isShared
            ? {
                sharedFormula: masterAddress,
                result: getResult(r, c)
              }
            : getResult(r, c)
        );
      }
    }
  }
}

export function addImage(ws: WorksheetData, imageId: string | number, range: AddImageRange): void {
  const model = {
    type: "image",
    imageId: String(imageId),
    range
  };
  ws._media.push(imageCreate(ws, model));
}

export function addShape(ws: WorksheetData, options: AddShapeOptions): void {
  const range = options.range;
  // A shape must cover an area, mirroring images. Reject inputs that resolve
  // to no size up front, with a clear shape-specific message — otherwise the
  // failure surfaces much later as a confusing `ImageError` from the internal
  // range parser when the worksheet is serialized.
  const hasArea =
    (typeof range === "string" && range.includes(":")) ||
    (typeof range === "object" &&
      range !== null &&
      ("br" in range || "ext" in range || "pos" in range));
  if (!hasArea) {
    throw new ImageError(
      'addShape requires a range covering an area: a cell range like "B2:D5", or an object with `br`, `ext`, or `pos`.'
    );
  }
  ws._shapes.push({
    type: "shape",
    shapeType: options.type ?? "rect",
    range,
    fillColor: options.fillColor,
    lineColor: options.lineColor,
    lineWidth: options.lineWidth,
    text: options.text,
    name: options.name
  });
}

export function getShapes(ws: WorksheetData): ShapeModel[] {
  return ws._shapes.slice();
}

export function _resolveShapeModel(ws: WorksheetData, shape: ShapeModel): ShapeModel {
  let range: Extract<ImageModel, { type: "image" }>["range"] | undefined;
  try {
    const probe = imageCreate(ws, { type: "image", imageId: "", range: shape.range });
    // The probe is always an "image" type, so its model carries `range`.
    range = (imageModel(probe) as Extract<ImageModel, { type: "image" }>).range;
  } catch {
    // Range could not be parsed into an anchor (addShape validates the common
    // cases up front; this guards exotic inputs). Drop the anchor so the
    // serializer skips this shape rather than failing the whole worksheet.
    range = undefined;
  }
  if (!range) {
    return { ...shape, anchorRange: undefined };
  }
  return {
    ...shape,
    anchorRange: {
      tl: range.tl,
      br: range.br,
      ext: range.ext,
      pos: range.pos,
      editAs: range.editAs
    }
  };
}

export function getImages(ws: WorksheetData): ImageData[] {
  return ws._media.filter(m => m.type === "image");
}

export function addChart(
  ws: WorksheetData,
  options: AddChartOptions,
  range: AddChartRange
): number {
  return registerChart(ws, buildChartModel(options), range, options);
}

export function addColumnChart(
  ws: WorksheetData,
  options: Omit<AddBarChartOptions, "type" | "barDir">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "bar", barDir: "col" }, range);
}

export function addBarChart(
  ws: WorksheetData,
  options: Omit<AddBarChartOptions, "type" | "barDir">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "bar", barDir: "bar" }, range);
}

export function addLineChart(
  ws: WorksheetData,
  options: Omit<AddChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "line" }, range);
}

export function addAreaChart(
  ws: WorksheetData,
  options: Omit<AddChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "area" }, range);
}

export function addPieChart(
  ws: WorksheetData,
  options: Omit<AddPieChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "pie" }, range);
}

export function addDoughnutChart(
  ws: WorksheetData,
  options: Omit<AddPieChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "doughnut" }, range);
}

export function addScatterChart(
  ws: WorksheetData,
  options: Omit<AddScatterChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "scatter" }, range);
}

export function addBubbleChart(
  ws: WorksheetData,
  options: Omit<AddChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "bubble" }, range);
}

export function addRadarChart(
  ws: WorksheetData,
  options: Omit<AddChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "radar" }, range);
}

export function addStockChart(
  ws: WorksheetData,
  options: Omit<AddChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "stock" }, range);
}

export function addSurfaceChart(
  ws: WorksheetData,
  options: Omit<AddSurfaceChartOptions, "type">,
  range: AddChartRange
): number {
  return addChart(ws, { ...options, type: "surface" }, range);
}

export function addHistogramChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "histogram" }, range);
}

export function addParetoChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "pareto" }, range);
}

export function addWaterfallChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "waterfall" }, range);
}

export function addFunnelChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "funnel" }, range);
}

export function addTreemapChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "treemap" }, range);
}

export function addSunburstChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "sunburst" }, range);
}

export function addBoxWhiskerChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "boxWhisker" }, range);
}

export function addRegionMapChart(
  ws: WorksheetData,
  options: Omit<AddChartExOptions, "type">,
  range: AddChartRange
): number {
  return addChartEx(ws, { ...options, type: "regionMap" }, range);
}

export function addPresetChart(
  ws: WorksheetData,
  preset: ExcelChartPreset,
  options: Omit<AddChartOptions, "type"> & Partial<Pick<AddChartOptions, "type">>,
  range: AddChartRange
): number {
  return addChart(ws, applyChartPreset(preset, options), range);
}

export function addPresetChartEx(
  ws: WorksheetData,
  preset: ExcelChartExPreset,
  options: Omit<AddChartExOptions, "type"> & Partial<Pick<AddChartExOptions, "type">>,
  range: AddChartRange
): number {
  return addChartEx(ws, applyChartExPreset(preset, options), range);
}

export function seriesFromColumns(
  ws: WorksheetData,
  options: SeriesFromColumnsOptions
): ReturnType<typeof chartSeriesFromColumns> {
  return chartSeriesFromColumns(getSheetName(ws), options);
}

export function addChartFromTable(
  ws: WorksheetData,
  table: TableData | string,
  options: AddChartFromTableOptions,
  range: AddChartRange
): number {
  return addChart(ws, chartOptionsFromTable(ws, table, options), range);
}

export function addChartFromRows<T extends Record<string, unknown>>(
  ws: WorksheetData,
  rows: T[],
  options: AddChartFromRowsOptions<T>,
  range: AddChartRange
): number {
  return addChart(ws, chartOptionsFromRows(ws, rows, options), range);
}

export function addColumnChartFromRows<T extends Record<string, unknown>>(
  ws: WorksheetData,
  rows: T[],
  options: Omit<AddChartFromRowsOptions<T>, "type" | "barDir">,
  range: AddChartRange
): number {
  return addChart(
    ws,
    chartOptionsFromRows(ws, rows, {
      ...options,
      type: "bar",
      barDir: "col"
    } as AddChartFromRowsOptions<T>),
    range
  );
}

export function addChartExFromTable(
  ws: WorksheetData,
  table: TableData | string,
  options: AddChartExFromTableOptions & {
    type: Exclude<AddChartExOptions["type"], "regionMap">;
  },
  range: AddChartRange
): number {
  return addChartEx(ws, chartExOptionsFromTable(ws, table, options), range);
}

export function addChartExFromRows<T extends Record<string, unknown>>(
  ws: WorksheetData,
  rows: T[],
  options: AddChartExFromRowsOptions<T> & {
    type: Exclude<AddChartExOptions["type"], "regionMap">;
  },
  range: AddChartRange
): number {
  return addChartEx(ws, chartExOptionsFromRows(ws, rows, options), range);
}

export function addPivotChart(
  ws: WorksheetData,
  pivotTable: PivotTable,
  options: AddChartOptions,
  range: AddChartRange
): number {
  const pivotChartOptions = withPivotChartSource(pivotTable, options);
  return registerChart(ws, buildChartModel(pivotChartOptions), range, pivotChartOptions);
}

export function addPivotComboChart(
  ws: WorksheetData,
  pivotTable: PivotTable,
  options: AddComboChartOptions,
  range: AddChartRange
): number {
  const pivotChartOptions = withPivotChartSource(pivotTable, options);
  return registerChart(ws, buildComboChartModel(pivotChartOptions), range, pivotChartOptions);
}

export function addComboChart(
  ws: WorksheetData,
  options: AddComboChartOptions,
  range: AddChartRange
): number {
  return registerChart(ws, buildComboChartModel(options), range, options);
}

export function addChartEx(
  ws: WorksheetData,
  options: AddChartExOptions,
  range: AddChartRange
): number {
  return registerChartEx(ws, buildChartExModel(options), range);
}

export function getCharts(ws: WorksheetData): ChartHandle[] {
  return [...ws._charts];
}

export function removeChart(ws: WorksheetData, chart: ChartHandle | number): boolean {
  const idx = typeof chart === "number" ? chart : ws._charts.indexOf(chart);
  if (idx < 0 || idx >= ws._charts.length) {
    return false;
  }
  const removed = ws._charts.splice(idx, 1)[0];
  if (removed.chartNumber > 0) {
    removeChartEntry(ws._workbook, removed.chartNumber);
  }
  if (removed.chartExNumber > 0) {
    removeChartExStructuredEntry(ws._workbook, removed.chartExNumber);
  }
  // Prune the matching anchor from the loaded drawing so the writer
  // doesn't emit a dangling rel pointing at the now-removed chart
  // part. The drawing xform regenerates rels from `drawing.anchors`
  // on every write (see `worksheet-xform.ts` chart-anchor reconcile),
  // so dropping the anchor here is sufficient — we don't need to
  // hand-edit `drawing.rels` ourselves.
  const drawing = ws._drawing as
    | { anchors?: Array<{ chartNumber?: number; chartExNumber?: number }> }
    | undefined;
  if (drawing?.anchors) {
    drawing.anchors = drawing.anchors.filter(anchor => {
      if (removed.chartNumber > 0 && anchor.chartNumber === removed.chartNumber) {
        return false;
      }
      if (removed.chartExNumber > 0 && anchor.chartExNumber === removed.chartExNumber) {
        return false;
      }
      return true;
    });
  }
  return true;
}

export function addSparklineGroup(
  ws: WorksheetData,
  options: AddSparklineGroupOptions
): SparklineGroup {
  const group = buildSparklineGroup(options);
  ws._sparklineGroups.push(group);
  return group;
}

export function getSparklineGroups(ws: WorksheetData): SparklineGroup[] {
  return [...ws._sparklineGroups];
}

export function removeSparklineGroup(
  ws: WorksheetData,
  groupOrIndex: SparklineGroup | number
): boolean {
  const idx =
    typeof groupOrIndex === "number" ? groupOrIndex : ws._sparklineGroups.indexOf(groupOrIndex);
  if (idx < 0 || idx >= ws._sparklineGroups.length) {
    return false;
  }
  ws._sparklineGroups.splice(idx, 1);
  return true;
}

export function addBackgroundImage(ws: WorksheetData, imageId: string | number): void {
  const bookImage = getImage(ws._workbook, imageId);
  if (bookImage && isExternalImage(bookImage)) {
    throw new ImageError(
      "Background images cannot be external (linked) images. " +
        "Use an embedded image (buffer/base64/filename). " +
        "External images are only supported for cell pictures and overlay watermarks."
    );
  }
  const model = {
    type: "background",
    imageId: String(imageId)
  };
  ws._media.push(imageCreate(ws, model));
}

export function getBackgroundImageId(ws: WorksheetData): string | undefined {
  const image = ws._media.find(m => m.type === "background");
  return image && image.imageId;
}

export function addWatermark(ws: WorksheetData, options: WatermarkOptions): void {
  const mode = options.mode ?? "overlay";

  // Validate BEFORE mutating any state: VML header/footer images use
  // embedded media (`<v:imagedata o:relid>`); external (linked) images are
  // not representable here. Reject them up front so a failed call leaves the
  // existing watermark untouched (no partial mutation).
  if (mode === "header") {
    const bookImage = getImage(ws._workbook, options.imageId);
    if (bookImage && isExternalImage(bookImage)) {
      throw new ImageError(
        "Header watermark images cannot be external (linked) images. " +
          "Use an embedded image (buffer/base64/filename), or use overlay mode for linked images."
      );
    }
  }

  // Replace only the watermark owned by this API. Imported header/footer
  // images are independent document content and must survive both replacement
  // and removal of the API watermark.
  if (ws._watermark?.mode === "header") {
    removeWatermark(ws);
  } else {
    removeOwnedWatermarkMedia(ws);
  }

  const position = options.position ?? "CH";

  ws._watermark = {
    imageId: String(options.imageId),
    mode,
    opacity: options.opacity,
    headerWidth: options.headerWidth,
    headerHeight: options.headerHeight,
    applyTo: options.applyTo,
    position: options.position
  };

  if (ws._watermark.mode === "overlay") {
    // Add as a special "watermark" media entry for the drawing pipeline
    const model = {
      type: "watermark",
      imageId: String(options.imageId),
      opacity: options.opacity
    };
    const medium = imageCreate(ws, model);
    ws._media.push(medium);
    ws._watermarkMedia = medium;
  } else {
    // Delegate section ownership, `&G` bookkeeping, and replacement semantics
    // to the explicit six-section API.
    setHeaderFooterImage(ws, {
      imageId: options.imageId,
      position,
      width: options.headerWidth,
      height: options.headerHeight,
      applyTo: options.applyTo
    });
    ws._watermarkMedia =
      ws._media.find(
        medium => medium.type === "headerImage" && (medium.position ?? "CH") === position
      ) ?? null;
  }
}

/** Section token (`&L`/`&C`/`&R`) that anchors an image position. */
function headerFooterSectionToken(position: HeaderFooterImagePosition): string {
  return position[0] === "L" ? "&L" : position[0] === "R" ? "&R" : "&C";
}

/**
 * Header/footer fields a given image position writes into, ordered
 * odd → even → first, filtered by the caller's `applyTo` selection.
 */
function headerFooterImageFields(
  position: HeaderFooterImagePosition,
  applyTo: "all" | "odd" | "even" | "first",
  headerFooter: HeaderFooter
): Array<keyof HeaderFooter> {
  const isFooter = position[1] === "F";
  const odd = isFooter ? "oddFooter" : "oddHeader";
  const even = isFooter ? "evenFooter" : "evenHeader";
  const first = isFooter ? "firstFooter" : "firstHeader";
  if (applyTo === "odd") {
    return [odd];
  }
  if (applyTo === "even") {
    return [even];
  }
  if (applyTo === "first") {
    return [first];
  }
  return [odd, even, first];
}

/**
 * Remove the `&G` image placeholder from one header/footer section across all
 * three page variants, leaving every other section and code untouched.
 */
function stripSectionImagePlaceholder(
  source: HeaderFooter,
  position: HeaderFooterImagePosition
): HeaderFooter {
  const result: HeaderFooter = { ...source };
  const token = headerFooterSectionToken(position);
  const fields: Array<keyof HeaderFooter> =
    position[1] === "F"
      ? ["oddFooter", "evenFooter", "firstFooter"]
      : ["oddHeader", "evenHeader", "firstHeader"];

  for (const field of fields) {
    const value = result[field];
    if (typeof value !== "string" || !sectionContainsImage(value, token)) {
      continue;
    }
    const start = value.indexOf(token);
    const imageIndex = value.indexOf("&G", start + token.length);
    let cleaned = value.slice(0, imageIndex) + value.slice(imageIndex + 2);
    const sectionStart = cleaned.indexOf(token);
    if (sectionStart >= 0) {
      const sectionTail = cleaned.slice(sectionStart + token.length);
      const nextSection = sectionTail.search(/&[LCR]/);
      const sectionContent = nextSection < 0 ? sectionTail : sectionTail.slice(0, nextSection);
      if (sectionContent === "") {
        cleaned = cleaned.slice(0, sectionStart) + cleaned.slice(sectionStart + token.length);
      }
    }
    result[field] = (cleaned || null) as never;
  }
  return result;
}

function sectionContainsImage(value: string | null | undefined, token: string): boolean {
  if (!value) {
    return false;
  }
  const start = value.indexOf(token);
  if (start < 0) {
    return false;
  }
  const tail = value.slice(start + token.length);
  const nextSection = tail.search(/&[LCR]/);
  return (nextSection < 0 ? tail : tail.slice(0, nextSection)).includes("&G");
}

function insertImagePlaceholder(value: string | null, token: string): string {
  const existing = value ?? "";
  if (sectionContainsImage(existing, token)) {
    return existing;
  }
  const index = existing.indexOf(token);
  return index >= 0
    ? `${existing.slice(0, index + token.length)}&G${existing.slice(index + token.length)}`
    : `${existing}${token}&G`;
}

/** Pure transformation used both when adding and when precisely undoing. */
function buildWatermarkedHeaderFooter(
  source: HeaderFooter,
  position: HeaderFooterImagePosition,
  applyTo: "all" | "odd" | "even" | "first"
): HeaderFooter {
  const result: HeaderFooter = { ...source };
  const token = headerFooterSectionToken(position);
  const isFooter = position[1] === "F";
  const oddField = isFooter ? "oddFooter" : "oddHeader";
  if (applyTo === "even" && !result.differentOddEven) {
    result[isFooter ? "evenFooter" : "evenHeader"] = result[oddField];
    result.differentOddEven = true;
  }
  if (applyTo === "all") {
    if (!result.differentOddEven) {
      result[isFooter ? "evenFooter" : "evenHeader"] = result[oddField];
      result.differentOddEven = true;
    }
    if (!result.differentFirst) {
      result[isFooter ? "firstFooter" : "firstHeader"] = result[oddField];
      result.differentFirst = true;
    }
  }
  if (applyTo === "first" && !result.differentFirst) {
    result[isFooter ? "firstFooter" : "firstHeader"] = result[oddField];
    result.differentFirst = true;
  }
  for (const field of headerFooterImageFields(position, applyTo, result)) {
    const current = result[field];
    if (typeof current === "string" || current === null) {
      result[field] = insertImagePlaceholder(current, token) as never;
    }
  }
  return result;
}

/**
 * Remove the API-owned media entry. Imported sibling images are untouched.
 */
function removeOwnedWatermarkMedia(ws: WorksheetData): void {
  const owned = ws._watermarkMedia;
  if (!owned) {
    return;
  }
  // Identity match: the API removes exactly the entry it created, never an
  // identically-positioned image that came from the source document.
  ws._media = ws._media.filter(medium => medium !== owned);
  ws._watermarkMedia = null;
}

/**
 * Options for {@link setHeaderFooterImage}.
 */
export interface HeaderFooterImageOptions {
  /** Image ID obtained from `Workbook.addImage()`. */
  imageId: string | number;
  /** Section that holds the image. */
  position: HeaderFooterImagePosition;
  /** Image width in points. Defaults to Excel's 467.25. */
  width?: number;
  /** Image height in points. Defaults to Excel's 311.25. */
  height?: number;
  /**
   * Which page variants show the image.
   *
   * @default "odd" — the shared field used by every page while the odd/even
   * and first-page variants are disabled.
   */
  applyTo?: "all" | "odd" | "even" | "first";
}

/** A header/footer image as stored on the worksheet. */
export interface HeaderFooterImageEntry {
  imageId: string;
  position: HeaderFooterImagePosition;
  width?: number;
  height?: number;
}

/**
 * Place an image in one of Excel's six header/footer sections
 * (`LH`/`CH`/`RH`/`LF`/`CF`/`RF`), replacing whatever occupied that section.
 *
 * This is the explicit counterpart to the single-value {@link addWatermark}
 * API: it addresses each section independently, so images loaded from an
 * existing workbook can be inspected, replaced, or removed individually.
 */
export function setHeaderFooterImage(ws: WorksheetData, options: HeaderFooterImageOptions): void {
  const bookImage = getImage(ws._workbook, options.imageId);
  if (bookImage && isExternalImage(bookImage)) {
    throw new ImageError(
      "Header/footer images cannot be external (linked) images. " +
        "Use an embedded image (buffer/base64/filename)."
    );
  }

  removeHeaderFooterImage(ws, options.position);
  ws._media.push(
    imageCreate(ws, {
      type: "headerImage",
      imageId: String(options.imageId),
      headerWidth: options.width,
      headerHeight: options.height,
      applyTo: options.applyTo,
      position: options.position
    })
  );
  ws.headerFooter = buildWatermarkedHeaderFooter(
    ws.headerFooter,
    options.position,
    options.applyTo ?? "odd"
  );
}

/** Every header/footer image on the worksheet, in section order. */
export function getHeaderFooterImages(ws: WorksheetData): HeaderFooterImageEntry[] {
  return ws._media
    .filter(medium => medium.type === "headerImage")
    .map(medium => ({
      // Parsed workbooks carry numeric media indexes; normalise so the public
      // shape is always the string id used by `Workbook.addImage()`.
      imageId: String(medium.imageId ?? ""),
      position: medium.position ?? "CH",
      width: medium.headerWidth,
      height: medium.headerHeight
    }));
}

/**
 * Remove the image in one header/footer section together with its `&G`
 * placeholder. Returns `true` when a section image was removed.
 */
export function removeHeaderFooterImage(
  ws: WorksheetData,
  position: HeaderFooterImagePosition
): boolean {
  const occupants = ws._media.filter(
    medium => medium.type === "headerImage" && (medium.position ?? "CH") === position
  );
  if (occupants.length === 0) {
    return false;
  }
  ws._media = ws._media.filter(medium => !occupants.includes(medium));
  ws.headerFooter = stripSectionImagePlaceholder(ws.headerFooter, position);
  if (occupants.includes(ws._watermarkMedia as never)) {
    // The single-value watermark API owned this entry; drop its bookkeeping so
    // a later removeWatermark() cannot resurrect a stale snapshot.
    ws._watermark = null;
    ws._watermarkMedia = null;
  }
  return true;
}

export function getWatermark(ws: WorksheetData): WatermarkOptions | null {
  return ws._watermark;
}

export function removeWatermark(ws: WorksheetData): void {
  const watermark = ws._watermark;
  if (!watermark) {
    return;
  }
  if (watermark.mode === "header") {
    removeHeaderFooterImage(ws, watermark.position ?? "CH");
  } else {
    removeOwnedWatermarkMedia(ws);
  }
  ws._watermark = null;
  ws._watermarkMedia = null;
}

export function addFormCheckbox(
  ws: WorksheetData,
  range: FormControlRange,
  options?: FormCheckboxOptions
): FormCheckboxData {
  const checkbox = formCheckboxCreate(ws, range, options);
  ws.formControls.push(checkbox);
  return checkbox;
}

export function getFormCheckboxes(ws: WorksheetData): FormCheckboxData[] {
  return ws.formControls;
}

export async function protect(
  ws: WorksheetData,
  password?: string,
  options?: Partial<SheetProtection>
): Promise<void> {
  ws.sheetProtection = await buildSheetProtection(password, options);
}

export function unprotect(ws: WorksheetData): void {
  ws.sheetProtection = null;
}

/**
 * Verify a candidate password against the sheet's stored protection hash
 * (set via `protect()`). Returns `false` when the sheet isn't protected, or
 * was protected without a password to check against.
 */
export async function verifyPassword(ws: WorksheetData, password: string): Promise<boolean> {
  return verifySheetPassword(ws.sheetProtection, password);
}

export function addTable(ws: WorksheetData, model: TableProperties): TableData {
  const table = createTable(ws, model);
  // table.name is sanitized by Table.validate() — check against the
  // sanitized name so that e.g. "My Table" and "My_Table" (which both
  // sanitize to "My_Table") are correctly detected as duplicates.
  const nameKey = tableName(table).toLowerCase();
  if (ws.tables[tableName(table)]) {
    throw new TableError(
      `Table name "${tableName(table)}" already exists in worksheet "${getSheetName(ws)}".`
    );
  }
  if (getSheetWorkbook(ws)._tableNames.has(nameKey)) {
    throw new TableError(
      `Table name "${tableName(table)}" already exists in another worksheet. ` +
        `Table names must be unique across the entire workbook (case-insensitive).`
    );
  }
  ws.tables[tableName(table)] = table;
  getSheetWorkbook(ws)._tableNames.add(nameKey);
  return table;
}

export function removeTable(ws: WorksheetData, name: string): void {
  if (ws.tables[name]) {
    getSheetWorkbook(ws)._tableNames.delete(name.toLowerCase());
  }
  delete ws.tables[name];
}

export function addPivotTable(ws: WorksheetData, model: PivotTableModel): PivotTable {
  const pivotTable = makePivotTable(
    { workbook: getSheetWorkbook(ws), name: getSheetName(ws) },
    model
  );

  ws.pivotTables.push(pivotTable);
  getSheetWorkbook(ws).pivotTables.push(pivotTable);

  return pivotTable;
}

export function addConditionalFormatting(
  ws: WorksheetData,
  cf: ConditionalFormattingOptions
): void {
  ws.conditionalFormattings.push(cf);
}

export function removeConditionalFormatting(
  ws: WorksheetData,
  filter?:
    | number
    | ((
        value: ConditionalFormattingOptions,
        index: number,
        array: ConditionalFormattingOptions[]
      ) => boolean)
): void {
  if (typeof filter === "number") {
    ws.conditionalFormattings.splice(filter, 1);
  } else if (typeof filter === "function") {
    // Keep entries for which the predicate returns false; drop the matches.
    ws.conditionalFormattings = ws.conditionalFormattings.filter(
      (value, index, array) => !filter(value, index, array)
    );
  } else {
    ws.conditionalFormattings = [];
  }
}

export function autoFitColumn(ws: WorksheetData, col: number | string): WorksheetData {
  const colNum = typeof col === "string" ? colCache.l2n(col) : col;
  _autoFitColumnImpl(ws, colNum);
  return ws;
}

export function autoFitColumns(
  ws: WorksheetData,
  startCol?: number | string,
  endCol?: number | string
): WorksheetData {
  const dims = getSheetDimensions(ws);
  if (!dims || dims.left === undefined) {
    return ws;
  }
  const start =
    startCol != null
      ? typeof startCol === "string"
        ? colCache.l2n(startCol)
        : startCol
      : dims.left;
  const end =
    endCol != null ? (typeof endCol === "string" ? colCache.l2n(endCol) : endCol) : dims.right;

  for (let c = start; c <= end; c++) {
    _autoFitColumnImpl(ws, c);
  }
  return ws;
}

export function autoFitRow(ws: WorksheetData, rowNumber: number): WorksheetData {
  _autoFitRowImpl(ws, rowNumber);
  return ws;
}

export function autoFitRows(ws: WorksheetData, startRow?: number, endRow?: number): WorksheetData {
  const dims = getSheetDimensions(ws);
  if (!dims || dims.top === undefined) {
    return ws;
  }
  const start = startRow ?? dims.top;
  const end = endRow ?? dims.bottom;

  for (let r = start; r <= end; r++) {
    _autoFitRowImpl(ws, r);
  }
  return ws;
}

export function _autoFitColumnImpl(ws: WorksheetData, colNum: number): void {
  const mdw = getMaxDigitWidth(); // default font MDW

  // Check if this column is under an autofilter
  const hasAutoFilter = _isColumnInAutoFilter(ws, colNum);

  let maxWidthPx = 0;

  // Iterate all rows
  ws._rows.forEach(row => {
    if (!row) {
      return;
    }
    // Skip hidden rows — Excel excludes them from auto-fit
    if (rowHidden(row)) {
      return;
    }
    const cell = rowFindCell(row, colNum);
    if (!cell) {
      return;
    }

    // Skip merged cell slaves — the content belongs to the master cell.
    // For the master cell of a multi-column merge, skip too (the width
    // should not be attributed to a single column).
    if (cellType(cell) === Enums.ValueType.Merge) {
      return;
    }
    if (cellIsMerged(cell)) {
      // This is a master cell with merges spanning multiple columns
      const mergeRange = ws._merges[cell.address];
      if (mergeRange && mergeRange.left !== mergeRange.right) {
        return; // multi-column merge — skip
      }
    }

    // Skip shrinkToFit cells — they adapt to the column, not vice versa
    if (cellAlignment(cell)?.shrinkToFit) {
      return;
    }

    let textWidthPx = getCellTextWidthPx(cellView(cell));

    // Account for indent: each level adds approximately 3 character widths
    const indent = cellAlignment(cell)?.indent;
    if (indent && indent > 0) {
      textWidthPx += indent * 3 * mdw;
    }

    if (textWidthPx > maxWidthPx) {
      maxWidthPx = textWidthPx;
    }
  });

  if (maxWidthPx > 0) {
    const charWidth = calculateAutoFitWidth(maxWidthPx, mdw, hasAutoFilter);
    if (charWidth > 0) {
      const column = getColumn(ws, colNum);
      column.width = charWidth;
      column.bestFit = true;
    }
  }
}

export function _autoFitRowImpl(ws: WorksheetData, rowNumber: number): void {
  const row = ws._rows[rowNumber - 1];
  if (!row) {
    return;
  }

  const mdw = getMaxDigitWidth();
  let maxHeightPt = 0;

  rowEachCell(row, cell => {
    // Skip merged cell slaves
    if (cellType(cell) === Enums.ValueType.Merge) {
      return;
    }
    // Skip multi-row merged masters
    if (cellIsMerged(cell)) {
      const mergeRange = ws._merges[cell.address];
      if (mergeRange && mergeRange.top !== mergeRange.bottom) {
        return;
      }
    }
    // Skip cells in hidden columns
    const col = ws._columns[cellCol(cell) - 1];
    if (col?.hidden) {
      return;
    }

    const columnWidthPx = _getColumnContentWidthForCell(ws, cell, mdw);
    const heightPt = getCellHeightPt(cellView(cell), mdw, columnWidthPx);
    if (heightPt > maxHeightPt) {
      maxHeightPt = heightPt;
    }
  });

  if (maxHeightPt > 0) {
    row.height = Math.ceil(maxHeightPt * 4) / 4; // Round to nearest 0.25pt (Excel precision)
    row.customHeight = true;
  }
}

export function _getColumnContentWidthForCell(
  ws: WorksheetData,
  cell: CellData,
  mdw: number
): number | undefined {
  if (!cellAlignment(cell)?.wrapText) {
    return undefined;
  }
  // Try to get explicit column width; avoid creating a column as side effect
  const col = ws._columns[cellCol(cell) - 1];
  const colWidth = col?.width ?? ws.properties.defaultColWidth ?? 9;
  return getColumnContentWidthPx(colWidth, mdw);
}

export function _isColumnInAutoFilter(ws: WorksheetData, colNum: number): boolean {
  if (!ws.autoFilter) {
    return false;
  }
  if (typeof ws.autoFilter === "string") {
    const range = colCache.decode(ws.autoFilter) as DecodedRange;
    return colNum >= range.left && colNum <= range.right;
  }
  const { from, to } = ws.autoFilter;
  const fromCol =
    typeof from === "string" ? (colCache.decode(from) as { col: number }).col : from.col;
  const toCol = typeof to === "string" ? (colCache.decode(to) as { col: number }).col : to.col;
  return colNum >= fromCol && colNum <= toCol;
}

export function _parseRows(ws: WorksheetData, model: WorksheetModel): void {
  ws._rows = [];
  if (model.rows) {
    model.rows.forEach(rowModel => {
      const row = rowCreate(ws, rowModel.number);
      ws._rows[row.number - 1] = row;
      rowSetModel(row, rowModel);
    });
  }
}

export function _parseMergeCells(ws: WorksheetData, model: WorksheetModel): void {
  if (model.mergeCells) {
    model.mergeCells.forEach((merge: string) => {
      // Do not merge styles when importing an Excel file
      // since each cell may have different styles intentionally.
      mergeCellsWithoutStyle(ws, merge);
    });
  }
}

export function toJSON(ws: WorksheetData, opts: SheetToJSONOptions & { header: 1 }): CellValue[][];

export function toJSON(ws: WorksheetData, opts?: SheetToJSONOptions): Record<string, CellValue>[];

export function toJSON(
  ws: WorksheetData,
  opts?: SheetToJSONOptions
): CellValue[][] | Record<string, CellValue>[] {
  const o = opts || {};

  // Determine range
  let startRow = 1;
  let endRow = getRowCount(ws);
  let startCol = 1;
  let endCol = getColumnCount(ws);

  if (o.range !== undefined) {
    if (typeof o.range === "number") {
      startRow = o.range + 1; // 0-indexed to 1-indexed
    } else if (typeof o.range === "string") {
      const r = decodeRange(o.range);
      startRow = r.s.r + 1;
      endRow = r.e.r + 1;
      startCol = r.s.c + 1;
      endCol = r.e.c + 1;
    }
  }

  if (endRow < startRow || endCol < startCol) {
    return [];
  }

  const headerOpt = o.header;

  // header: 1 — return array of arrays
  if (headerOpt === 1) {
    const result: CellValue[][] = [];
    const includeBlank = o.blankRows !== false;

    for (let row = startRow; row <= endRow; row++) {
      const rowData: CellValue[] = [];
      let isEmpty = true;

      for (let col = startCol; col <= endCol; col++) {
        const cell = getCell(ws, row, col);
        const val =
          o.raw === false
            ? getCellDisplayText(cellView(cell), o.dateFormat).trim()
            : cellGetValue(cell);

        if (val != null && val !== "") {
          rowData[col - startCol] = val;
          isEmpty = false;
        } else if (o.defaultValue !== undefined) {
          rowData[col - startCol] = o.defaultValue;
        } else {
          rowData[col - startCol] = null;
        }
      }

      if (!isEmpty || includeBlank) {
        result.push(rowData);
      }
    }

    return result;
  }

  // header: "A" — use column letters as keys
  if (headerOpt === "A") {
    const result: Record<string, CellValue>[] = [];
    const includeBlank = o.blankRows === true;

    for (let row = startRow; row <= endRow; row++) {
      const rowData: Record<string, CellValue> = {};
      let isEmpty = true;

      for (let col = startCol; col <= endCol; col++) {
        const cell = getCell(ws, row, col);
        const val =
          o.raw === false
            ? getCellDisplayText(cellView(cell), o.dateFormat).trim()
            : cellGetValue(cell);
        const key = encodeCol(col - 1);

        if (val != null && val !== "") {
          rowData[key] = val;
          isEmpty = false;
        } else if (o.defaultValue !== undefined) {
          rowData[key] = o.defaultValue;
        }
      }

      if (!isEmpty || includeBlank) {
        result.push(rowData);
      }
    }

    return result;
  }

  // header: string[] — use provided array as keys
  if (Array.isArray(headerOpt)) {
    const result: Record<string, CellValue>[] = [];
    const includeBlank = o.blankRows === true;

    for (let row = startRow; row <= endRow; row++) {
      const rowData: Record<string, CellValue> = {};
      let isEmpty = true;

      for (let col = startCol; col <= endCol; col++) {
        const colIdx = col - startCol;
        const key = headerOpt[colIdx] ?? `__EMPTY_${colIdx}`;
        const cell = getCell(ws, row, col);
        const val =
          o.raw === false
            ? getCellDisplayText(cellView(cell), o.dateFormat).trim()
            : cellGetValue(cell);

        if (val != null && val !== "") {
          rowData[key] = val;
          isEmpty = false;
        } else if (o.defaultValue !== undefined) {
          rowData[key] = o.defaultValue;
        }
      }

      if (!isEmpty || includeBlank) {
        result.push(rowData);
      }
    }

    return result;
  }

  // Default: first row as header, disambiguate duplicates
  const headers: string[] = [];
  const headerCounts: Record<string, number> = {};

  for (let col = startCol; col <= endCol; col++) {
    const cell = getCell(ws, startRow, col);
    const val = cellGetValue(cell);
    let header = val != null ? String(val) : `__EMPTY_${col - startCol}`;

    if (headerCounts[header] !== undefined) {
      headerCounts[header]++;
      header = `${header}_${headerCounts[header]}`;
    } else {
      headerCounts[header] = 0;
    }

    headers.push(header);
  }

  const result: Record<string, CellValue>[] = [];
  const dataStartRow = startRow + 1;
  const includeBlank = o.blankRows === true;

  for (let row = dataStartRow; row <= endRow; row++) {
    const rowData: Record<string, CellValue> = {};
    let isEmpty = true;

    for (let col = startCol; col <= endCol; col++) {
      const cell = getCell(ws, row, col);
      const val =
        o.raw === false
          ? getCellDisplayText(cellView(cell), o.dateFormat).trim()
          : cellGetValue(cell);
      const key = headers[col - startCol];

      if (val != null && val !== "") {
        rowData[key] = val;
        isEmpty = false;
      } else if (o.defaultValue !== undefined) {
        rowData[key] = o.defaultValue;
      }
    }

    if (!isEmpty || includeBlank) {
      result.push(rowData);
    }
  }

  return result;
}

export function addJSON(
  ws: WorksheetData,
  data: Record<string, CellValue>[],
  opts?: AddJSONOptions
): WorksheetData {
  if (data.length === 0) {
    return ws;
  }

  const o = opts || {};

  // Determine starting position
  let startRow = 1;
  let startCol = 1;
  if (o.origin !== undefined) {
    const resolved = _resolveOrigin(o.origin, getRowCount(ws));
    startRow = resolved.row;
    startCol = resolved.col;
  }

  // Determine headers
  const allKeys = new Set<string>();
  data.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
  const headers = o.header ? [...o.header] : [...allKeys];
  if (o.header) {
    allKeys.forEach(k => {
      if (!headers.includes(k)) {
        headers.push(k);
      }
    });
  }

  let rowNum = startRow;

  // Write header row
  if (!o.skipHeader) {
    headers.forEach((h, colIdx) => {
      cellSetValue(getCell(ws, rowNum, startCol + colIdx), h);
    });
    rowNum++;
  }

  // Write data rows
  for (const row of data) {
    headers.forEach((key, colIdx) => {
      const val = row[key];
      if (val === null && o.nullError) {
        cellSetValue(getCell(ws, rowNum, startCol + colIdx), { error: "#NULL!" });
      } else if (val !== undefined && val !== null) {
        cellSetValue(getCell(ws, rowNum, startCol + colIdx), val);
      }
    });
    rowNum++;
  }

  return ws;
}

export function toAOA(ws: WorksheetData): CellValue[][] {
  const result: CellValue[][] = [];

  eachRow(ws, { includeEmpty: true }, (row, rowNumber) => {
    const rowData: CellValue[] = [];
    rowEachCell(row, { includeEmpty: true }, (cell, colNumber) => {
      rowData[colNumber - 1] = cellGetValue(cell);
    });
    result[rowNumber - 1] = rowData;
  });

  return result;
}

export function addAOA(
  ws: WorksheetData,
  data: CellValue[][],
  opts?: AddAOAOptions
): WorksheetData {
  if (data.length === 0) {
    return ws;
  }

  let startRow = 1;
  let startCol = 1;
  if (opts?.origin !== undefined) {
    const resolved = _resolveOrigin(opts.origin, getRowCount(ws));
    startRow = resolved.row;
    startCol = resolved.col;
  }

  data.forEach((row, rowIdx) => {
    if (!row) {
      return;
    }
    row.forEach((val, colIdx) => {
      if (val !== undefined && val !== null) {
        cellSetValue(getCell(ws, startRow + rowIdx, startCol + colIdx), val);
      }
    });
  });

  return ws;
}

export function getSheetDimensions(ws: WorksheetData): RangeData {
  const dimensions = rangeCreate();
  ws._rows.forEach(row => {
    if (row) {
      const rowDims = rowDimensions(row);
      if (rowDims) {
        rangeExpand(dimensions, row.number, rowDims.min, row.number, rowDims.max);
      }
    }
  });
  return dimensions;
}

export function getColumns(ws: WorksheetData): ColumnData[] {
  return ws._columns;
}

export function getLastColumn(ws: WorksheetData): ColumnData {
  return getColumn(ws, getColumnCount(ws));
}

export function getColumnCount(ws: WorksheetData): number {
  let maxCount = 0;
  eachRow(ws, row => {
    maxCount = Math.max(maxCount, rowCellCount(row));
  });
  return maxCount;
}

export function getActualColumnCount(ws: WorksheetData): number {
  // performance nightmare - for each row, counts all the columns used
  const counts: boolean[] = [];
  let count = 0;
  eachRow(ws, row => {
    rowEachCell(row, (_cell: CellData, col: number) => {
      if (!counts[col]) {
        counts[col] = true;
        count++;
      }
    });
  });
  return count;
}

export function getLastRow(ws: WorksheetData): RowData | undefined {
  if (ws._rows.length) {
    return ws._rows[ws._rows.length - 1];
  }
  return undefined;
}

export function getRowCount(ws: WorksheetData): number {
  return get_lastRowNumber(ws);
}

export function getActualRowCount(ws: WorksheetData): number {
  // counts actual rows that have actual data
  let count = 0;
  eachRow(ws, () => {
    count++;
  });
  return count;
}

export function getHasMerges(ws: WorksheetData): boolean {
  // return true if this._merges has a merge object
  return Object.values(ws._merges).some(Boolean);
}

export function getMergedRegions(ws: WorksheetData): ReadonlyArray<{
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}> {
  return Object.values(ws._merges).map(merge => ({
    top: merge.top,
    left: merge.left,
    bottom: merge.bottom,
    right: merge.right
  }));
}

export function getSheetModel(ws: WorksheetData): WorksheetModel {
  const model: WorksheetModel = {
    id: ws.id,
    name: getSheetName(ws),
    dataValidations: ws.dataValidations.model,
    properties: ws.properties,
    state: ws.state,
    pageSetup: ws.pageSetup,
    headerFooter: ws.headerFooter,
    rowBreaks: ws.rowBreaks,
    colBreaks: ws.colBreaks,
    views: ws.views,
    autoFilter: ws.autoFilter,
    autoFilterCriteria: ws._autoFilterCriteria,
    sortStateXml: ws._sortStateXml,
    worksheetNamespaceAttributes: ws._worksheetNamespaceAttributes,
    worksheetMcIgnorable: ws._worksheetMcIgnorable,
    sortStateAutoFilterRef: ws._sortStateAutoFilterRef,
    media: ws._media.map(medium => imageModel(medium)),
    shapes: ws._shapes.map(shape => _resolveShapeModel(ws, shape)),
    sheetProtection: ws.sheetProtection,
    tables: Object.values(ws.tables).map(table => tableModel(table)),
    pivotTables: ws.pivotTables,
    conditionalFormattings: ws.conditionalFormattings,
    formControls: ws.formControls.map(fc => fc.model),
    ignoredErrors: ws.ignoredErrors,
    watermark: ws._watermark,
    drawing: ws._drawing,
    charts: ws._charts.map(
      (c): ChartAnchorModel => ({
        chartNumber: c.chartNumber,
        chartExNumber: c.chartExNumber,
        range: {
          tl: {
            nativeCol: c.range.tl.nativeCol,
            nativeColOff: c.range.tl.nativeColOff,
            nativeRow: c.range.tl.nativeRow,
            nativeRowOff: c.range.tl.nativeRowOff
          },
          br: c.range.br
            ? {
                nativeCol: c.range.br.nativeCol,
                nativeColOff: c.range.br.nativeColOff,
                nativeRow: c.range.br.nativeRow,
                nativeRowOff: c.range.br.nativeRowOff
              }
            : undefined,
          editAs: c.range.editAs,
          pos: c.range.pos,
          ext: c.range.ext
        } as ChartAnchorModel["range"]
      })
    ),
    sparklineGroups: ws._sparklineGroups,
    threadedComments: ws.threadedComments
  };

  // =================================================
  // columns
  model.cols = columnToModel(getColumns(ws));

  // ==========================================================
  // Rows
  const rows: RowModel[] = (model.rows = []);
  const dimensions: RangeData = (model.dimensions = rangeCreate());
  ws._rows.forEach(row => {
    const rowModel = row && rowGetModel(row);
    if (rowModel) {
      rangeExpand(dimensions, rowModel.number, rowModel.min, rowModel.number, rowModel.max);
      rows.push(rowModel);
    }
  });

  // ==========================================================
  // Merges
  model.mergeCells = Object.values(ws._merges).map((merge: RangeData) => rangeRange(merge));

  return model;
}

export function setSheetName(ws: WorksheetData, name: string | undefined): void {
  if (name === undefined) {
    name = `sheet${ws.id}`;
  }

  if (ws._name === name) {
    return;
  }

  // Delegate to the workbook-level validator so both worksheets and
  // chartsheets share a single naming namespace. Previously this
  // setter only cross-checked against other worksheets, allowing a
  // chartsheet named "S" to coexist with a worksheet named "S";
  // Excel itself forbids that collision. `validateSheetName`
  // performs the full type / empty / illegal-char / quote / length
  // / case-insensitive duplicate checks and returns the sanitised
  // name (truncated to 31 chars if needed).
  ws._name = validateSheetName(ws._workbook, name, ws);
}

export function setColumns(ws: WorksheetData, value: ColumnDefn[]): void {
  // calculate max header row count
  ws._headerRowCount = value.reduce((pv, cv) => {
    const headerCount = Array.isArray(cv.header) ? cv.header.length : cv.header ? 1 : 0;
    return Math.max(pv, headerCount);
  }, 0);

  // construct Column objects
  let count = 1;
  const columns: ColumnData[] = (ws._columns = []);
  value.forEach(defn => {
    const column = columnCreate(ws, count++, false);
    columns.push(column);
    columnSetDefn(column, defn);
  });
}

export function setSheetModel(ws: WorksheetData, value: WorksheetModel): void {
  setSheetName(ws, value.name);
  ws.state = value.state;
  ws._columns = columnFromModel(ws, value.cols ?? []);
  _parseRows(ws, value);

  _parseMergeCells(ws, value);
  ws.dataValidations = createDataValidations(value.dataValidations);
  ws.properties = value.properties;
  ws.pageSetup = value.pageSetup;
  // Re-apply the OOXML schema defaults: `scaleWithDoc` / `alignWithMargins`
  // default to true and are omitted from the XML when unset, so a parsed
  // model carries only the fields the file actually wrote. Filling them here
  // keeps `HeaderFooter` fully populated for every source (fresh, cloned,
  // parsed) instead of leaking `undefined` through the public shape.
  const headerFooter = (value.headerFooter ?? {}) as Partial<HeaderFooter>;
  ws.headerFooter = {
    differentFirst: headerFooter.differentFirst ?? false,
    differentOddEven: headerFooter.differentOddEven ?? false,
    scaleWithDoc: headerFooter.scaleWithDoc ?? true,
    alignWithMargins: headerFooter.alignWithMargins ?? true,
    oddHeader: headerFooter.oddHeader ?? null,
    oddFooter: headerFooter.oddFooter ?? null,
    evenHeader: headerFooter.evenHeader ?? null,
    evenFooter: headerFooter.evenFooter ?? null,
    firstHeader: headerFooter.firstHeader ?? null,
    firstFooter: headerFooter.firstFooter ?? null
  };
  ws.rowBreaks = value.rowBreaks ?? [];
  ws.colBreaks = value.colBreaks ?? [];
  ws.views = value.views;
  ws.autoFilter = value.autoFilter;
  ws._autoFilterCriteria = value.autoFilterCriteria;
  ws._sortStateXml = value.sortStateXml;
  ws._worksheetNamespaceAttributes = value.worksheetNamespaceAttributes;
  ws._worksheetMcIgnorable = value.worksheetMcIgnorable;
  ws._sortStateAutoFilterRef = value.sortStateAutoFilterRef;
  ws._media = value.media.map(medium => imageCreate(ws, medium));
  ws._shapes = value.shapes ? value.shapes.slice() : [];
  // Restore watermark state from media entries
  ws._watermark = value.watermark ?? null;
  ws._watermarkMedia = null;
  if (!ws._watermark) {
    for (const medium of ws._media) {
      if (medium.type === "watermark") {
        ws._watermark = {
          imageId: medium.imageId ?? "",
          mode: "overlay",
          opacity: medium.opacity
        };
        break;
      }
    }
  }
  ws.sheetProtection = value.sheetProtection;
  ws.tables = value.tables.reduce((tables: { [key: string]: TableData }, table: TableModel) => {
    const t = createTable(ws, table);
    tableSetModel(t, table);
    tables[table.name] = t;
    getSheetWorkbook(ws)._tableNames.add(table.name.toLowerCase());
    return tables;
  }, {});
  ws.pivotTables = value.pivotTables;
  for (const pivotTable of ws.pivotTables ?? []) {
    pivotTable.worksheetName ??= getSheetName(ws);
    pivotTable.name ??= `PivotTable${pivotTable.tableNumber}`;
  }
  ws.conditionalFormattings = value.conditionalFormattings;
  ws.ignoredErrors = value.ignoredErrors ?? [];
  ws.threadedComments = value.threadedComments ?? [];
  // Rebuild form controls from the serialised model so importSheet() and any
  // other model round-trip preserves checkbox state, position, and links.
  ws.formControls = (value.formControls ?? []).map(fcModel => formCheckboxFromModel(ws, fcModel));
  // Preserve loaded drawing data (charts, etc.)
  ws._drawing = value.drawing;
  // Restore chart handles from the model (explicit `charts` array) or from
  // drawing anchors. `createChart` is imported statically, so this works
  // unconditionally — pure load-save pass-through still flows through the same
  // path, and a consumer that never references any chart API gets the chart
  // implementation tree-shaken out regardless.
  if (value.charts && value.charts.length > 0) {
    ws._charts = value.charts.map((c: ChartAnchorModel) =>
      createChart(ws, { chartNumber: c.chartNumber, chartExNumber: c.chartExNumber }, c.range)
    );
  } else if ((value.drawing as { anchors?: unknown } | undefined)?.anchors) {
    // Extract chart anchors from drawing (loaded from XLSX)
    type DrawingChartAnchor = {
      chartNumber?: number;
      chartExNumber?: number;
      range?: Parameters<typeof createChart>[2];
    };
    const anchors = (value.drawing as { anchors: DrawingChartAnchor[] }).anchors;
    ws._charts = anchors
      .filter(a => a.chartNumber || a.chartExNumber)
      .map(a =>
        createChart(
          ws,
          { chartNumber: a.chartNumber ?? 0, chartExNumber: a.chartExNumber ?? 0 },
          a.range!
        )
      );
  } else {
    ws._charts = [];
  }
}

// =============================================================================
// Option Types for Data Conversion
// =============================================================================

export interface SheetToJSONOptions {
  /**
   * Control output format:
   * - `1`: Generate an array of arrays
   * - `"A"`: RowData object keys are literal column labels (A, B, C, ...)
   * - `string[]`: Use specified strings as keys in row objects
   * - `undefined`: Read and disambiguate first row as keys
   */
  header?: 1 | "A" | string[];
  /**
   * Override range:
   * - `number`: Use worksheet range but set starting row to the value (0-indexed)
   * - `string`: Use specified range (A1-style bounded range string)
   * - `undefined`: Use worksheet range
   */
  range?: number | string;
  /** Use raw values (true, default) or formatted text strings (false) */
  raw?: boolean;
  /** Default value for empty cells */
  defaultValue?: CellValue;
  /** Include blank rows in output (default: true for AOA, false for objects) */
  blankRows?: boolean;
  /** Override format for date values (only applies when raw: false) */
  dateFormat?: string;
}

export interface AddJSONOptions {
  /** Use specified field order (default: Object.keys from data) */
  header?: string[];
  /** If true, do not include header row in output */
  skipHeader?: boolean;
  /** Starting position: cell address string, {c, r} object, row number (0-indexed), or -1 to append */
  origin?: Origin;
  /** If true, emit #NULL! error cells for null values */
  nullError?: boolean;
}

export interface AddAOAOptions {
  /** Starting position: cell address string, {c, r} object, row number (0-indexed), or -1 to append */
  origin?: Origin;
}

// =============================================================================
// Private Helpers
// =============================================================================

/** Resolve an Origin value to 1-indexed {row, col} for internal use */
function _resolveOrigin(origin: Origin, rowCount: number): { row: number; col: number } {
  if (typeof origin === "string") {
    const addr = decodeCell(origin);
    return { row: addr.r + 1, col: addr.c + 1 };
  }
  if (typeof origin === "number") {
    if (origin === -1) {
      return { row: rowCount + 1, col: 1 };
    }
    return { row: origin + 1, col: 1 };
  }
  return { row: origin.r + 1, col: origin.c + 1 };
}

export { type WorksheetModel };
export type Worksheet = WorksheetData;

// Re-export the worksheet-core container layer so `@excel/worksheet` remains the
// canonical import path for all worksheet operations.
export {
  type WorksheetData,
  type SheetProtection,
  addRow,
  addRows,
  getColumnKey,
  setColumnKey,
  deleteColumnKey,
  getColumn,
  _commitRow,
  findRow,
  findRows,
  getRow,
  getRows,
  eachRow,
  getSheetValues,
  findCell,
  getCell,
  getSheetName,
  getSheetWorkbook,
  getTable,
  getTables,
  rowGetCell,
  rowGetCellEx,
  rowSetValues,
  rowEachCell,
  rowSplice,
  rowCommit,
  rowSetModel,
  columnCreate,
  columnSetDefn,
  columnSetHeader,
  columnSetKey,
  columnEachCell,
  columnValues,
  columnSetValues,
  columnFromModel,
  columnSetNumFmt,
  columnSetFont,
  columnSetAlignment,
  columnSetProtection,
  columnSetBorder,
  columnSetFill
} from "@excel/core/worksheet-core";
