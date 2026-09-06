import { anchorCreate, anchorModel } from "@excel/core/anchor";
import type { CellData } from "@excel/core/cell";
import { cellMerge } from "@excel/core/cell";
import type { ColumnData, ColumnDefn } from "@excel/core/column";
import { columnToModel } from "@excel/core/column";
import type { DataValidationsData } from "@excel/core/data-validations";
import { createDataValidations } from "@excel/core/data-validations";
import type { RangeData } from "@excel/core/range";
import { rangeCreate, rangeIntersects, rangeRange } from "@excel/core/range";
import type { RowData } from "@excel/core/row";
import { rowCreate, rowFindCell, rowGetModel, rowHasValues } from "@excel/core/row";
import type { WorkbookFormat } from "@excel/core/workbook-format";
import type { WorksheetData } from "@excel/core/worksheet";
import {
  columnCreate,
  columnSetDefn,
  getSheetModel,
  rowGetCellEx,
  rowSetValues
} from "@excel/core/worksheet";
import {
  ExcelStreamStateError,
  ImageError,
  MergeConflictError,
  RowOutOfBoundsError
} from "@excel/errors";
import { SheetCommentsWriter } from "@excel/stream/sheet-comments-writer";
import { SheetRelsWriter } from "@excel/stream/sheet-rels-writer";
import type { Medium as WriterMedium } from "@excel/stream/workbook-writer";
import {
  StreamedXlsbWorksheet,
  streamedWorksheetPath,
  type StreamedXlsbTables,
  xlsbSheetOptionsFromModel
} from "@excel/stream/xlsb-writer";
import { colCache } from "@excel/utils/col-cache";
import type { DrawingAnchor, DrawingRel } from "@excel/utils/drawing-utils";
import { buildDrawingAnchorsAndRels, isExternalImage } from "@excel/utils/drawing-utils";
import { applyMergeBorders, collectMergeBorders } from "@excel/utils/merge-borders";
import {
  drawingRelTargetFromWorksheet,
  mediaRelTargetFromRels,
  worksheetPath
} from "@excel/utils/ooxml-paths";
import type { PackageSink } from "@excel/utils/package-sink";
import type { SharedStrings } from "@excel/utils/shared-strings";
import { buildSheetProtection } from "@excel/utils/sheet-protection";
import type { StreamBuf } from "@excel/utils/stream-buf";
import type { SheetComment } from "@excel/xlsb/comments";
import { commentsFromModel, sheetRowsFromModel } from "@excel/xlsb/write/model-adapter";
import type { WriteWorksheetPartOptions } from "@excel/xlsb/write/worksheet";
import { RelType } from "@excel/xlsx/rel-type";
import type { CommentModel } from "@excel/xlsx/xform/comment/comment-xform";
import { StringBuf } from "@utils/string-buf";

const xmlBuffer = /* @__PURE__ */ new StringBuf();

import type {
  RowBreak,
  ColBreak,
  PageSetup,
  HeaderFooter,
  WorksheetProperties,
  WorksheetView,
  WorksheetState,
  AutoFilter,
  WorksheetProtection,
  ConditionalFormattingOptions,
  AddImageRange,
  IgnoredError,
  WatermarkOptions,
  RowValues
} from "@excel/types";
// ============================================================================================
// Xforms
import { ListXform } from "@excel/xlsx/xform/list-xform";
import { AutoFilterXform } from "@excel/xlsx/xform/sheet/auto-filter-xform";
import { ConditionalFormattingsXform } from "@excel/xlsx/xform/sheet/cf/conditional-formattings-xform";
import { ColBreaksXform } from "@excel/xlsx/xform/sheet/col-breaks-xform";
import { ColXform } from "@excel/xlsx/xform/sheet/col-xform";
import { DataValidationsXform } from "@excel/xlsx/xform/sheet/data-validations-xform";
import { DrawingXform as DrawingPartXform } from "@excel/xlsx/xform/sheet/drawing-xform";
import { ExtLstXform } from "@excel/xlsx/xform/sheet/ext-lst-xform";
import { HeaderFooterXform } from "@excel/xlsx/xform/sheet/header-footer-xform";
import { HyperlinkXform } from "@excel/xlsx/xform/sheet/hyperlink-xform";
import { IgnoredErrorsXform } from "@excel/xlsx/xform/sheet/ignored-errors-xform";
import { PageMarginsXform } from "@excel/xlsx/xform/sheet/page-margins-xform";
import { PageSetupXform } from "@excel/xlsx/xform/sheet/page-setup-xform";
import { PictureXform } from "@excel/xlsx/xform/sheet/picture-xform";
import { RowBreaksXform } from "@excel/xlsx/xform/sheet/row-breaks-xform";
import { RowXform } from "@excel/xlsx/xform/sheet/row-xform";
import { SheetFormatPropertiesXform } from "@excel/xlsx/xform/sheet/sheet-format-properties-xform";
import { SheetPropertiesXform } from "@excel/xlsx/xform/sheet/sheet-properties-xform";
import { SheetProtectionXform } from "@excel/xlsx/xform/sheet/sheet-protection-xform";
import { SheetViewXform } from "@excel/xlsx/xform/sheet/sheet-view-xform";

// since prepare and render are functional, we can use singletons
const xform = {
  dataValidations: new DataValidationsXform(),
  sheetProperties: new SheetPropertiesXform(),
  sheetFormatProperties: new SheetFormatPropertiesXform(),
  columns: new ListXform({ tag: "cols", count: false, childXform: new ColXform() }),
  row: new RowXform(),
  hyperlinks: new ListXform({
    tag: "hyperlinks",
    count: false,
    childXform: new HyperlinkXform()
  }),
  sheetViews: new ListXform({
    tag: "sheetViews",
    count: false,
    childXform: new SheetViewXform()
  }),
  sheetProtection: new SheetProtectionXform(),
  pageMargins: new PageMarginsXform(),
  pageSeteup: new PageSetupXform(),
  autoFilter: new AutoFilterXform(),
  picture: new PictureXform(),
  drawing: new DrawingPartXform(),
  conditionalFormattings: new ConditionalFormattingsXform(),
  extLst: new ExtLstXform(),
  ignoredErrors: new IgnoredErrorsXform(),
  headerFooter: new HeaderFooterXform(),
  rowBreaks: new RowBreaksXform(),
  colBreaks: new ColBreaksXform()
};

// ============================================================================================

/**
 * Structural view of the fields/methods WorksheetWriter needs from its
 * parent WorkbookWriter. Defined here (rather than importing WorkbookWriter
 * directly) to avoid the circular `workbook-writer.ts <-> worksheet-writer.ts`
 * dependency. The shape must stay in sync with the concrete WorkbookWriter.
 */
export interface WorkbookWriterLike {
  /** Shared-string table (deduplicates plain/rich-text cell values). */
  readonly sharedStrings: SharedStrings;
  /**
   * Style manager. Typed loosely here (`unknown`) because the concrete
   * `StylesXform` is an internal xform class and pulling it in would
   * reintroduce the circular import. Xform methods accept it by duck-typing.
   */
  readonly styles: object;
  /** Incremented once per dynamic-array formula cell during row commit. */
  dynamicArrayCount: number;
  /** Lookup a media (image/chart) by registered id. */
  getImage(id: number): WriterMedium | undefined;
  /** Accumulated comment-part references (for the content-types manifest). */
  commentRefs: { commentName: string; vmlDrawing: string }[];
  /** Open a streaming entry in the output zip for the given path. */
  _openStream(path: string): InstanceType<typeof StreamBuf>;
  /**
   * The workbook-wide names a BIFF12 formula resolves against — see `WorkbookWriter.xlsbFormulaContext`.
   *
   * Optional so an XLSX-only host need not provide it; absent means cross-sheet formulas cannot be encoded, which is
   * then reported rather than written as a blank cell.
   */
  xlsbFormulaContext?: () => {
    readonly sheetNames: readonly string[];
    readonly definedNames: readonly string[];
    readonly externSheets: { first: number; last: number }[];
  };
  /**
   * Whether the workbook counts days from 1904 — see `WorkbookWriter.xlsbDate1904`.
   *
   * Optional for the same reason as `xlsbFormulaContext`; absent means the 1900 system, which is the default a host
   * that does not model the setting would want.
   */
  xlsbDate1904?: () => boolean;
  /** Which container is being written. `"xlsb"` sends rows through the binary encoder. */
  readonly format: WorkbookFormat;
  /** The workbook-wide interning tables for a streamed XLSB. Absent for XLSX. */
  readonly xlsbTables?: StreamedXlsbTables;
  /** The zip as a `PackageSink`, which is what the binary sheet writer takes. */
  packageSink(): PackageSink;
}

interface WorksheetWriterOptions {
  id: number;
  name?: string;
  workbook: WorkbookWriterLike;
  useSharedStrings?: boolean;
  properties?: Partial<WorksheetProperties>;
  state?: WorksheetState;
  pageSetup?: Partial<PageSetup>;
  views?: Partial<WorksheetView>[];
  autoFilter?: AutoFilter;
  headerFooter?: Partial<HeaderFooter>;
}

/** Internal model for an image added via addImage(). */
interface WriterImageModel {
  type: "image";
  imageId: string;
  range: {
    tl: { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number };
    br?: { nativeCol: number; nativeColOff: number; nativeRow: number; nativeRowOff: number };
    ext?: { width: number; height: number };
    editAs?: string;
    /** Absolute position in pixels — mutually exclusive with tl/br cell anchors. */
    pos?: { x: number; y: number };
  };
  hyperlinks?: { hyperlink?: string; tooltip?: string };
  /** Internal dedup marker for watermark-generated entries (not serialized as-is). */
  _watermarkTag?: boolean;
  /** Watermark opacity, carried on watermark entries. */
  opacity?: number;
}

class WorksheetWriter {
  id: number;
  name: string;
  /**
   * Alias of {@link name} under the field that flat cell helpers
   * (`cellFullAddress`, defined-name registration, …) read from a worksheet.
   * Record worksheets store the name in `_name`; the streaming writer keeps it
   * in the public `name`, so we mirror it here for cross-cutting helpers.
   */
  get _name(): string {
    return this.name;
  }
  state: WorksheetState;
  /** Rows stored while being worked on. Set to null after commit. */
  private _rows: (RowData | undefined)[] | null;
  /** Column definitions */
  private _columns: ColumnData[];
  /** Column keys mapping: key => Column */
  private _keys: { [key: string]: ColumnData };
  /**
   * Merged cell ranges. Carries a no-op `add` so code paths that expect the
   * in-memory worksheet's merge collection (which exposes `.add`) can call it
   * harmlessly during streaming.
   */
  private _merges: RangeData[] & { add?: () => void };
  private _sheetRelsWriter: SheetRelsWriter;
  private _sheetCommentsWriter: SheetCommentsWriter;
  /**
   * Notes collected as rows were committed, for the XLSB comments part.
   *
   * Named `_retainedComments` because `getSheetModel` reads it under that name — see the field it emits. Small by
   * construction: one entry per annotated cell, not per row.
   */
  readonly _retainedComments: SheetComment[] = [];
  private _dimensions: RangeData;
  private _rowZero: number;
  private _rowOffset: number;
  committed: boolean;
  dataValidations: DataValidationsData;
  /** Shared formulae by address */
  private _formulae: { [key: string]: unknown };
  private _siFormulae: number;
  conditionalFormatting: ConditionalFormattingOptions[];
  /**
   * The rest of what a worksheet is, so `getSheetModel` can be handed this object.
   *
   * **`_asWorksheet` used to be a cast with a note calling it "a deliberate, contained masquerade".** It was
   * passed only to the core factories, which store it as a back-pointer and never look inside — so nothing
   * checked the claim, and the model that both binary writers consume could not be obtained from a streaming
   * sheet at all. Filling the gaps makes the cast honest and gives `format: "xlsb"` the whole of
   * `writeXlsbPackage`'s model→records mapping for free, rather than a second adapter reaching into twenty
   * private fields.
   *
   * **Empty is not a placeholder here, it is the truth.** A streaming worksheet has no charts, shapes,
   * sparklines, tables or pivot tables — those need a second pass over cells this writer has already discarded,
   * which is the whole point of it. `Worksheet` reports the same fields as populated because it keeps its cells;
   * this one reports them as absent because they are.
   *
   * `conditionalFormattings` is the exception and is a genuine naming split rather than a gap: this class has
   * always called the same thing `conditionalFormatting`, and `getSheetModel` reads the plural. The getter below
   * bridges the two rather than renaming a public field.
   */
  readonly tables: Record<string, unknown> = {};
  readonly pivotTables: readonly unknown[] = [];
  readonly threadedComments: readonly unknown[] = [];
  readonly formControls: readonly unknown[] = [];
  readonly _charts: readonly unknown[] = [];
  readonly _shapes: readonly unknown[] = [];
  readonly _sparklineGroups: readonly unknown[] = [];
  readonly _worksheetMcIgnorable: string | undefined = undefined;
  readonly _sortStateAutoFilterRef: string | undefined = undefined;
  /** Tab position, allocated across worksheets and chartsheets — see `core/sheet-order`. */
  orderNo?: number;
  /** The file-path number, which is this sheet's `id` for a streaming writer. */
  get sheetNo(): number {
    return this.id;
  }
  /** What `getSheetModel` reads; this class spells the same field singular. */
  get conditionalFormattings(): ConditionalFormattingOptions[] {
    return this.conditionalFormatting;
  }
  ignoredErrors: IgnoredError[];
  rowBreaks: RowBreak[];
  colBreaks: ColBreak[];
  properties: Partial<WorksheetProperties> & {
    defaultRowHeight: number;
    dyDescent?: number;
    outlineLevelCol: number;
    outlineLevelRow: number;
  };
  headerFooter: Partial<HeaderFooter>;
  pageSetup: Partial<PageSetup> & { margins: PageSetup["margins"] };
  useSharedStrings: boolean;
  // WorkbookWriter parent — structural reference to avoid the circular
  // dependency between workbook-writer.ts and worksheet-writer.ts.
  private _workbook: WorkbookWriterLike;
  hasComments: boolean;
  private _views: Partial<WorksheetView>[];
  autoFilter: AutoFilter | null;
  private _media: WriterImageModel[];
  sheetProtection: {
    sheet?: boolean;
    algorithmName?: string;
    saltValue?: string;
    spinCount?: number;
    hashValue?: string;
    [key: string]: unknown;
  } | null;
  private _stream?: InstanceType<typeof StreamBuf>;
  startedData: boolean;
  private _background?: { imageId?: number; rId?: string };
  private _headerRowCount?: number;
  /** Watermark configuration */
  private _watermark: WatermarkOptions | null;
  /** The binary sheet part being written forward, when the target is XLSB. */
  private _xlsb: StreamedXlsbWorksheet | undefined;
  /** What the binary encoder could not express in this sheet. */
  private _xlsbLosses: readonly string[] = [];

  /**
   * What the binary encoder could not express in this sheet, once `commit()` has run.
   *
   * **Public because it had no reader at all.** The row encoder reports what it cannot express — a formula whose token
   * stream needs a workbook-wide context the streaming path does not have becomes a blank cell — and the report was
   * stored in a private field nothing consulted. The package writer cannot recover it either: by the time it runs, the
   * sheet is already in the ZIP and its rows are gone, so `writeXlsbPackage` sees nothing to report. The result was a
   * cross-sheet formula silently becoming an empty cell with `xlsbUnsupported` reading `[]`.
   *
   * `WorkbookWriter.commit()` folds this into `xlsbUnsupported`, which is where a caller looks.
   */
  get xlsbUnsupported(): readonly string[] {
    return this._xlsbLosses;
  }
  /** Drawing model — populated during commit if images were added */
  private _drawing?: {
    rId: string;
    name: string;
    anchors: DrawingAnchor[];
    rels: DrawingRel[];
  };
  /** Relationship Id - assigned by WorkbookWriter */
  rId?: string;

  constructor(options: WorksheetWriterOptions) {
    // in a workbook, each sheet will have a number
    this.id = options.id;

    // and a name
    this.name = options.name || `Sheet${this.id}`;

    // add a state
    this.state = options.state ?? "visible";

    // rows are stored here while they need to be worked on.
    // when they are committed, they will be deleted.
    this._rows = [];

    // column definitions
    this._columns = [];

    // column keys (addRow convenience): key ==> this._columns index
    this._keys = {};

    // keep a record of all row and column pageBreaks
    this._merges = [];
    // **Non-enumerable, because it is a method and not a merge.** The stub exists so that code calling
    // `merges.add(...)` does not have to know which kind of worksheet it holds. As a plain assignment it became an
    // own enumerable property of the array, and `getSheetModel` reads merges with `Object.values` — correct for a
    // real worksheet, whose `_merges` is keyed by address — so the function was mapped into a range and every
    // streamed sheet gained a phantom `A1:A1` merge. It surfaced the moment this class started producing a model.
    Object.defineProperty(this._merges, "add", { value: () => {}, enumerable: false });

    // keep record of all hyperlinks
    this._sheetRelsWriter = new SheetRelsWriter(options);

    this._sheetCommentsWriter = new SheetCommentsWriter(
      this as unknown as { comments?: CommentModel[] },
      this._sheetRelsWriter,
      options
    );

    // keep a record of dimensions
    this._dimensions = rangeCreate();

    // first uncommitted row
    this._rowZero = 1;

    // Internal offset into `_rows` to avoid O(n) `Array.shift()` in hot path.
    this._rowOffset = 0;

    // committed flag
    this.committed = false;

    // for data validations
    this.dataValidations = createDataValidations();

    // for sharing formulae
    this._formulae = {};
    this._siFormulae = 0;

    // keep a record of conditionalFormattings
    this.conditionalFormatting = [];

    // ignored errors (suppress green triangles in Excel)
    this.ignoredErrors = [];

    // keep a record of all row and column pageBreaks
    this.rowBreaks = [];
    this.colBreaks = [];

    // for default row height, outline levels, etc
    this.properties = Object.assign(
      {},
      {
        defaultRowHeight: 15,
        outlineLevelCol: 0,
        outlineLevelRow: 0
      },
      options.properties
    );

    this.headerFooter = Object.assign(
      {},
      {
        differentFirst: false,
        differentOddEven: false,
        scaleWithDoc: true,
        alignWithMargins: true,
        oddHeader: null,
        oddFooter: null,
        evenHeader: null,
        evenFooter: null,
        firstHeader: null,
        firstFooter: null
      },
      options.headerFooter
    );

    // for all things printing
    this.pageSetup = Object.assign(
      {},
      {
        margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
        orientation: "portrait",
        // Absent, expressed as absent. This used to be 4294967295, a sentinel the XLSX writer stripped on the
        // way out — which worked for exactly one writer and left the XLSB one stating 0xFFFFFFFF where the
        // schema's default is 600. `core/worksheet.ts` already had it this way with a note saying why.
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
        horizontalCentered: false,
        verticalCentered: false,
        rowBreaks: null,
        colBreaks: null
      },
      options.pageSetup
    );

    // using shared strings creates a smaller xlsx file but may use more memory
    this.useSharedStrings = options.useSharedStrings ?? false;

    this._workbook = options.workbook;

    this.hasComments = false;

    // views
    this._views = options.views ?? [];

    // auto filter
    this.autoFilter = options.autoFilter ?? null;

    this._media = [];

    // watermark
    this._watermark = null;

    // worksheet protection
    this.sheetProtection = null;

    // start writing to stream now
    if (this._workbook.format === "xlsb") {
      // **No XML prologue, and no ZIP entry yet.** The binary prologue describes the columns, panes and views, and
      // a caller sets those after `addWorksheet` — so the part is opened on the first committed row instead. The
      // XLSX path emits `<cols>` on the first row for the same reason; this just moves one more record behind the
      // same line.
      this._xlsb = new StreamedXlsbWorksheet(
        this._workbook.packageSink(),
        streamedWorksheetPath(this.id),
        this._workbook.xlsbTables!,
        () => this._xlsbSheetOptions()
      );
    } else {
      this._writeOpenWorksheet();
    }

    this.startedData = false;
  }

  get workbook(): WorkbookWriterLike {
    return this._workbook;
  }

  /**
   * The streaming writer impersonates an in-memory `Worksheet` when calling the
   * shared core factories (`columnCreate`/`rowCreate`/`anchorCreate`), which
   * only store the reference as a back-pointer on the produced model. The
   * writer is not a full `WorksheetData`, so this is a deliberate, contained
   * masquerade rather than a structural guarantee.
   */
  private get _asWorksheet(): WorksheetData {
    return this as unknown as WorksheetData;
  }

  get stream(): InstanceType<typeof StreamBuf> {
    if (!this._stream) {
      this._stream = this._workbook._openStream(worksheetPath(this.id));

      // DO NOT pause stream - fflate migration requires data events to flow
      // The stream uses 'data' events to pipe to ZipPassThrough
      // this._stream.pause();
    }
    return this._stream;
  }

  // destroy - not a valid operation for a streaming writer
  // even though some streamers might be able to, it's a bad idea.
  destroy(): void {
    throw new ExcelStreamStateError("destroy", "Invalid operation for a streaming writer");
  }

  commit(): void {
    if (this.committed) {
      return;
    }
    // commit all rows
    for (let i = this._rowOffset; i < this._rows!.length; i++) {
      const cRow = this._rows![i];
      if (cRow) {
        this._writeRow(cRow);
      }
    }

    // we _cannot_ accept new rows from now on
    this._rows = null;

    if (this._xlsb !== undefined) {
      // The epilogue reads the sheet's metadata — merges, conditional formats, panes, page setup — at this moment
      // rather than when the part was opened, which is what makes it legal for a caller to keep setting those
      // while rows arrive. Nothing after this point touches the rows.
      const { unsupported } = this._xlsb.end();
      this._xlsbLosses = unsupported;
      this._sheetCommentsWriter.commit();
      this._sheetRelsWriter.commit();
      this.committed = true;
      return;
    }

    if (!this.startedData) {
      this._writeOpenSheetData();
    }
    this._writeCloseSheetData();
    this._writeSheetProtection(); // Note: must be after sheetData and before autoFilter
    this._writeAutoFilter();
    this._writeMergeCells();

    // for some reason, Excel can't handle dimensions at the bottom of the file
    // this._writeDimensions();

    this._writeHyperlinks();
    this._writeConditionalFormatting();
    this._writeDataValidations();
    this._writePageMargins();
    this._writePageSetup();
    this._writeHeaderFooter();
    this._writeRowBreaks();
    this._writeColBreaks();
    this._writeDrawing(); // Note: must be after rowBreaks/colBreaks
    this._writeBackground(); // Note: must be after drawing

    // Legacy Data tag for comments
    this._writeLegacyData();

    // ignoredErrors must be before extLst
    this._writeIgnoredErrors();

    // extLst must be the last child element before </worksheet>
    this._writeExtLst();

    this._writeCloseWorksheet();
    // signal end of stream to workbook
    this.stream.end();

    this._sheetCommentsWriter.commit();
    // also commit the hyperlinks if any
    this._sheetRelsWriter.commit();

    this.committed = true;
  }

  // return the current dimensions of the writer
  get dimensions(): RangeData {
    return this._dimensions;
  }

  get views(): Partial<WorksheetView>[] {
    return this._views;
  }

  // =========================================================================
  // Columns

  // get the current columns array.
  get columns(): ColumnData[] {
    return this._columns;
  }

  // set the columns from an array of column definitions.
  // Note: any headers defined will overwrite existing values.
  set columns(value: Partial<ColumnData>[]) {
    // calculate max header row count
    this._headerRowCount = value.reduce((pv, cv) => {
      const headerCount = (cv.header && 1) || (Array.isArray(cv.header) && cv.header.length) || 0;
      return Math.max(pv, headerCount);
    }, 0);

    // construct Column objects
    let count = 1;
    const columns: ColumnData[] = (this._columns = []);
    value.forEach(defn => {
      const column = columnCreate(this._asWorksheet, count++, false);
      columns.push(column);
      columnSetDefn(column, defn as ColumnDefn);
    });
  }

  getColumnKey(key: string): ColumnData | undefined {
    return this._keys[key];
  }

  setColumnKey(key: string, value: ColumnData): void {
    this._keys[key] = value;
  }

  deleteColumnKey(key: string): void {
    delete this._keys[key];
  }

  eachColumnKey(f: (column: ColumnData, key: string) => void): void {
    Object.keys(this._keys).forEach(key => f(this._keys[key], key));
  }

  // get a single column by col number. If it doesn't exist, it and any gaps before it
  // are created.
  getColumn(c: string | number): ColumnData {
    if (typeof c === "string") {
      // if it matches a key'd column, return that
      const col = this._keys[c];
      if (col) {
        return col;
      }

      // otherwise, assume letter
      c = colCache.l2n(c);
    }
    if (c > this._columns.length) {
      let n = this._columns.length + 1;
      while (n <= c) {
        this._columns.push(columnCreate(this._asWorksheet, n++));
      }
    }
    return this._columns[c - 1];
  }

  // =========================================================================
  // Rows
  private get _nextRow(): number {
    return this._rowZero + (this._rows!.length - this._rowOffset);
  }

  // iterate over every uncommitted row in the worksheet, including maybe empty rows
  eachRow(
    options: { includeEmpty?: boolean } | ((row: RowData, rowNumber: number) => void),
    iteratee?: (row: RowData, rowNumber: number) => void
  ): void {
    let callback: ((row: RowData, rowNumber: number) => void) | undefined;
    let opts: { includeEmpty?: boolean } | undefined;

    if (typeof options === "function") {
      callback = options;
      opts = undefined;
    } else {
      callback = iteratee;
      opts = options;
    }

    if (opts && opts.includeEmpty) {
      const n = this._nextRow;
      for (let i = this._rowZero; i < n; i++) {
        callback!(this.getRow(i), i);
      }
    } else {
      this._rows!.forEach(row => {
        if (row && rowHasValues(row)) {
          callback!(row, row.number);
        }
      });
    }
  }

  private _commitRow(cRow: RowData): void {
    // since rows must be written in order, we commit all rows up till and including cRow
    let found = false;

    const rows = this._rows!;
    while (this._rowOffset < rows.length && !found) {
      const row = rows[this._rowOffset];
      rows[this._rowOffset] = undefined;
      this._rowOffset++;
      this._rowZero++;
      if (row) {
        this._writeRow(row);
        found = row.number === cRow.number;
        this._rowZero = row.number + 1;
      }

      // Occasionally compact the buffer to keep indices small and reduce memory.
      if (this._rowOffset > 1024 && this._rowOffset > rows.length >> 1) {
        rows.splice(0, this._rowOffset);
        this._rowOffset = 0;
      }
    }
  }

  get lastRow(): RowData | undefined {
    // returns last uncommitted row
    const rows = this._rows!;
    for (let i = rows.length - 1; i >= this._rowOffset; i--) {
      const row = rows[i];
      if (row) {
        return row;
      }
    }
    return undefined;
  }

  // find a row (if exists) by row number
  findRow(rowNumber: number): RowData | undefined {
    const index = rowNumber - this._rowZero + this._rowOffset;
    return this._rows![index];
  }

  getRow(rowNumber: number): RowData {
    const index = rowNumber - this._rowZero + this._rowOffset;

    // may fail if rows have been comitted
    if (index < this._rowOffset) {
      throw new RowOutOfBoundsError(rowNumber, "this row has been committed");
    }
    let row = this._rows![index];
    if (!row) {
      this._rows![index] = row = rowCreate(this._asWorksheet, rowNumber);
    }
    return row;
  }

  addRow(value: RowValues): RowData {
    const row = rowCreate(this._asWorksheet, this._nextRow);
    this._rows![row.number - this._rowZero + this._rowOffset] = row;
    rowSetValues(row, value);
    return row;
  }

  addRows(values: RowValues[]): RowData[] {
    return values.map(value => this.addRow(value));
  }

  // ================================================================================
  // Cells

  // returns the cell at [r,c] or address given by r. If not found, return undefined
  findCell(r: string | number, c?: number): CellData | undefined {
    const address = colCache.getAddress(r, c);
    const row = this.findRow(address.row);
    return row ? rowFindCell(row, address.col) : undefined;
  }

  // return the cell at [r,c] or address given by r. If not found, create a new one.
  getCell(r: string | number, c?: number): CellData {
    const address = colCache.getAddress(r, c);
    const row = this.getRow(address.row);
    return rowGetCellEx(row, address);
  }

  mergeCells(...cells: (string | number)[]): void {
    // may fail if rows have been comitted
    const dimensions = rangeCreate(cells);

    // check cells aren't already merged
    this._merges.forEach(merge => {
      if (rangeIntersects(merge, dimensions)) {
        throw new MergeConflictError();
      }
    });

    const { top, left, bottom, right } = dimensions;

    // Collect perimeter borders BEFORE merge overwrites slave styles
    const collected = collectMergeBorders(top, left, bottom, right, (r, c) => this.findCell(r, c));

    // Apply merge
    const master = this.getCell(top, left);
    for (let i = top; i <= bottom; i++) {
      for (let j = left; j <= right; j++) {
        if (i > top || j > left) {
          cellMerge(this.getCell(i, j), master);
        }
      }
    }

    // Reconstruct position-aware borders (like Excel)
    if (collected) {
      applyMergeBorders(top, left, bottom, right, collected, (r, c) => this.getCell(r, c));
    }

    // index merge
    this._merges.push(dimensions);
  }

  // ===========================================================================
  // Conditional Formatting
  addConditionalFormatting(cf: ConditionalFormattingOptions): void {
    this.conditionalFormatting.push(cf);
  }

  removeConditionalFormatting(
    filter?: number | ((cf: ConditionalFormattingOptions) => boolean)
  ): void {
    if (typeof filter === "number") {
      this.conditionalFormatting.splice(filter, 1);
    } else if (typeof filter === "function") {
      // Predicate selects rules to drop, not rules to keep.
      this.conditionalFormatting = this.conditionalFormatting.filter(cf => !filter(cf));
    } else {
      this.conditionalFormatting = [];
    }
  }

  // =========================================================================

  addBackgroundImage(imageId: string | number): void {
    const bookImage = this._workbook.getImage(Number(imageId));
    if (bookImage && isExternalImage(bookImage)) {
      throw new ImageError(
        "Background images cannot be external (linked) images. " +
          "Use an embedded image (buffer/base64/filename). " +
          "External images are only supported for cell pictures and overlay watermarks."
      );
    }
    this._background = {
      imageId: Number(imageId)
    };
  }

  getBackgroundImageId(): number | undefined {
    return this._background && this._background.imageId;
  }

  // =========================================================================
  // Images

  /**
   * Using the image id from `WorkbookWriter.addImage`,
   * embed an image within the worksheet to cover a range.
   */
  addImage(imageId: string | number, range: AddImageRange): void {
    const model = this._parseImageRange(String(imageId), range);
    this._media.push(model);
  }

  /**
   * Return the images that have been added to this worksheet.
   * Each entry contains imageId and the normalised range (with native anchors).
   */
  getImages(): ReadonlyArray<WriterImageModel> {
    return this._media;
  }

  // =========================================================================
  // Watermark

  /**
   * Add a watermark to the worksheet using an image from `WorkbookWriter.addImage()`.
   * Supports overlay mode (DrawingML with transparency) and header mode (VML behind content).
   *
   * `mode: "overlay"` supports external (linked) images; `mode: "header"` does
   * not — VML header/footer images require embedded media, so a linked image
   * with `mode: "header"` throws an `ImageError`.
   *
   * @throws {ImageError} If `mode: "header"` is used with an external (linked) image.
   */
  addWatermark(options: WatermarkOptions): void {
    const mode = options.mode ?? "overlay";

    // Validate BEFORE mutating any state: VML header/footer images use
    // embedded media; external (linked) images are not representable here.
    // Reject them up front so a failed call leaves existing watermark media
    // untouched (no partial mutation).
    if (mode === "header") {
      const bookImage = this._workbook.getImage(Number(options.imageId));
      if (bookImage && isExternalImage(bookImage)) {
        throw new ImageError(
          "Header watermark images cannot be external (linked) images. " +
            "Use an embedded image (buffer/base64/filename), or use overlay mode for linked images."
        );
      }
      throw new ImageError(
        "Header/footer watermark images are not supported by the streaming worksheet writer. " +
          "Use a regular Workbook worksheet, or use overlay mode when streaming."
      );
    }

    // Remove existing watermark entries (both stored type tags)
    this._media = this._media.filter(m => m._watermarkTag !== true);

    const opacity =
      options.opacity !== undefined ? Math.max(0, Math.min(1, options.opacity)) : 0.15;

    this._watermark = {
      imageId: String(options.imageId),
      mode,
      opacity,
      headerWidth: options.headerWidth,
      headerHeight: options.headerHeight,
      applyTo: options.applyTo,
      position: options.position
    };

    if (this._watermark.mode === "overlay") {
      // Coverage range is computed lazily during commit() via _resolveWatermarkRange()
      const entry: WriterImageModel = {
        type: "image",
        imageId: String(options.imageId),
        range: {
          tl: { nativeCol: 0, nativeColOff: 0, nativeRow: 0, nativeRowOff: 0 },
          br: { nativeCol: 100, nativeColOff: 0, nativeRow: 200, nativeRowOff: 0 },
          editAs: "absolute"
        },
        // Internal tag for dedup — not part of the WriterImageModel type
        _watermarkTag: true,
        opacity
      };
      this._media.push(entry);
    }
  }

  /**
   * Get the current watermark configuration.
   */
  getWatermark(): WatermarkOptions | null {
    return this._watermark;
  }

  /**
   * Remove the watermark from the worksheet.
   */
  removeWatermark(): void {
    this._watermark = null;
    this._media = this._media.filter(m => m._watermarkTag !== true);
  }

  /**
   * Parse the user-supplied range into a normalised internal model
   * mirroring what the regular Worksheet / Image class does.
   */
  private _parseImageRange(imageId: string, range: AddImageRange): WriterImageModel {
    if (typeof range === "string") {
      // e.g. "A1:C3"
      const decoded = colCache.decode(range);
      if ("top" in decoded) {
        return {
          type: "image",
          imageId,
          range: {
            tl: anchorModel(
              anchorCreate(this._asWorksheet, { col: decoded.left, row: decoded.top }, -1)
            ),
            br: anchorModel(
              anchorCreate(this._asWorksheet, { col: decoded.right, row: decoded.bottom }, 0)
            ),
            editAs: "oneCell"
          }
        };
      }
      throw new ImageError(`Invalid image range: "${range}". Expected a range like "A1:C3".`);
    }

    // Absolute positioning (pos + ext, no cell anchors)
    if ("pos" in range && range.pos) {
      return {
        type: "image",
        imageId,
        range: {
          tl: { nativeCol: 0, nativeColOff: 0, nativeRow: 0, nativeRowOff: 0 },
          ext: range.ext,
          pos: range.pos
        },
        hyperlinks: range.hyperlinks
      };
    }

    // Cell-based positioning (tl/br anchors)
    const cellRange = range as Exclude<typeof range, string | { pos: unknown }>;
    const tl = anchorModel(anchorCreate(this._asWorksheet, cellRange.tl, 0));
    const br = cellRange.br
      ? anchorModel(anchorCreate(this._asWorksheet, cellRange.br, 0))
      : undefined;
    return {
      type: "image",
      imageId,
      range: {
        tl,
        br,
        ext: cellRange.ext,
        editAs: cellRange.editAs
      },
      hyperlinks: cellRange.hyperlinks
    };
  }

  // =========================================================================
  // Worksheet Protection
  async protect(password?: string, options?: Partial<WorksheetProtection>): Promise<void> {
    // Synchronous pre-set so callers that don't await still see sheetProtection
    // before commit() (the original code was synchronous on the no-password path).
    this.sheetProtection = { sheet: true };
    this.sheetProtection = await buildSheetProtection(password, options);
  }

  unprotect(): void {
    this.sheetProtection = null;
  }

  // ================================================================================

  private _write(text: string): void {
    xmlBuffer.reset();
    xmlBuffer.addText(text);
    this.stream.write(xmlBuffer);
  }

  private _writeSheetProperties(
    xmlBuf: StringBuf,
    properties: Partial<WorksheetProperties> | undefined,
    pageSetup: Partial<PageSetup> | undefined
  ): void {
    const sheetPropertiesModel = {
      outlineProperties: properties && properties.outlineProperties,
      tabColor: properties && properties.tabColor,
      pageSetup:
        pageSetup && pageSetup.fitToPage
          ? {
              fitToPage: pageSetup.fitToPage
            }
          : undefined
    };

    xmlBuf.addText(xform.sheetProperties.toXml(sheetPropertiesModel));
  }

  private _writeSheetFormatProperties(
    xmlBuf: StringBuf,
    properties: Partial<WorksheetProperties> | undefined
  ): void {
    const sheetFormatPropertiesModel = properties
      ? {
          defaultRowHeight: properties.defaultRowHeight,
          dyDescent: properties.dyDescent,
          outlineLevelCol: properties.outlineLevelCol,
          outlineLevelRow: properties.outlineLevelRow,
          ...(properties.defaultColWidth ? { defaultColWidth: properties.defaultColWidth } : {})
        }
      : undefined;

    xmlBuf.addText(xform.sheetFormatProperties.toXml(sheetFormatPropertiesModel));
  }

  private _writeOpenWorksheet(): void {
    xmlBuffer.reset();

    xmlBuffer.addText('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    xmlBuffer.addText(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
        ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"' +
        ' mc:Ignorable="x14ac"' +
        ' xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">'
    );

    this._writeSheetProperties(xmlBuffer, this.properties, this.pageSetup);

    xmlBuffer.addText(xform.sheetViews.toXml(this.views));

    this._writeSheetFormatProperties(xmlBuffer, this.properties);

    this.stream.write(xmlBuffer);
  }

  private _writeColumns(): void {
    const cols = columnToModel(this.columns);
    if (cols) {
      xform.columns.prepare(cols, { styles: this._workbook.styles });
      this.stream.write(xform.columns.toXml(cols));
    }
  }

  private _writeOpenSheetData(): void {
    this._write("<sheetData>");
  }

  /**
   * The sheet's options for the binary prologue and epilogue, from the shared model→options mapping.
   *
   * `getSheetModel(this)` works because this class now carries every field a worksheet does — see the note on
   * `tables` above. That is the whole reason there is no second adapter here: merges, panes, views, page setup,
   * conditional formats, hyperlinks and the rest are read by `worksheetPartOptionsFromModel`, the same function
   * the buffered writer uses, so a field added there reaches this path without an edit.
   */
  private _xlsbSheetOptions(): Omit<WriteWorksheetPartOptions, "rows" | "omitDimension"> {
    const model = getSheetModel(this as unknown as Parameters<typeof getSheetModel>[0]);
    // The formula context comes from the workbook, not from this sheet: an `ixti` indexes the workbook's sheet list.
    // Fetched per call rather than captured, because `addWorksheet` runs between sheet commits — see
    // `WorkbookWriter.xlsbFormulaContext`.
    return xlsbSheetOptionsFromModel(
      model,
      this._workbook.xlsbTables!,
      this.id === 1,
      this._workbook.xlsbFormulaContext?.()
    );
  }

  /**
   * One committed row, as binary records.
   *
   * Goes through `sheetRowsFromModel` on a one-row view of this sheet, which is where a cell's value, style,
   * number format, hyperlink and shared-formula role are decided. Deciding them again here would be the ninth
   * instance of this module's most repeated defect.
   */
  private _writeRowXlsb(row: RowData): void {
    const model = rowGetModel(row);
    if (model === null || model === undefined) {
      return;
    }
    // **Notes are kept, because this sheet will not have its rows when the package is written.**
    //
    // The XLSX branch of `_writeRow` collects a row's comments into `_sheetCommentsWriter` as it goes; this branch
    // returned before ever reaching that code, and nothing else carried them — a BIFF12 comments part is written whole at
    // the end, from `commentsFromModel`, which reads `rows[].cells[].comment` off a row store that `commit()` has already
    // released. So a note written through the streaming XLSB writer vanished: no `comments1.bin`, no VML, no indicator on
    // the cell. Measured against the two paths that work — streaming XLSX and buffered XLSB both produce a comments part
    // and its VML for the same workbook.
    //
    // Through `commentsFromModel` on a one-row view, which is the same extraction rule the buffered path uses. A second
    // implementation of "which cells have notes and what is in them" is this module's most repeated defect.
    this._retainedComments.push(
      ...commentsFromModel({ rows: [model] } as unknown as Parameters<typeof commentsFromModel>[0])
    );
    for (const sheetRow of sheetRowsFromModel(
      { rows: [model] } as unknown as Parameters<typeof sheetRowsFromModel>[0],
      // **The workbook's date system, not a literal `false`.** A serial is four years and a day out under the wrong
      // epoch, and the workbook part written at commit states the real setting — so the package disagreed with itself.
      // See `WorkbookWriter.xlsbDate1904`.
      this._workbook.xlsbDate1904?.() ?? false
    )) {
      this._xlsb!.row(sheetRow);
    }
  }

  private _writeRow(row: RowData): void {
    if (this._xlsb !== undefined) {
      this._writeRowXlsb(row);
      return;
    }
    if (!this.startedData) {
      this._writeColumns();
      this._writeOpenSheetData();
      this.startedData = true;
    }

    if (rowHasValues(row) || row.height != null) {
      const model = rowGetModel(row);
      if (!model) {
        return;
      }
      const options = {
        styles: this._workbook.styles,
        sharedStrings: this.useSharedStrings ? this._workbook.sharedStrings : undefined,
        hyperlinks: this._sheetRelsWriter.hyperlinksProxy,
        merges: this._merges,
        formulae: this._formulae,
        siFormulae: this._siFormulae,
        comments: []
      };
      xform.row.prepare(model, options);
      this.stream.write(xform.row.toXml(model));

      // Count dynamic array formula cells for metadata generation
      if (model.cells) {
        for (const cell of model.cells) {
          if (cell && cell.isDynamicArray) {
            this._workbook.dynamicArrayCount++;
          }
        }
      }

      if (options.comments.length) {
        this.hasComments = true;
        this._sheetCommentsWriter.addComments(options.comments);
      }
    }
  }

  private _writeCloseSheetData(): void {
    this._write("</sheetData>");
  }

  private _writeMergeCells(): void {
    if (this._merges.length) {
      xmlBuffer.reset();
      xmlBuffer.addText(`<mergeCells count="${this._merges.length}">`);
      this._merges.forEach(merge => {
        xmlBuffer.addText(`<mergeCell ref="${rangeRange(merge)}"/>`);
      });
      xmlBuffer.addText("</mergeCells>");

      this.stream.write(xmlBuffer);
    }
  }

  private _writeHyperlinks(): void {
    this.stream.write(xform.hyperlinks.toXml(this._sheetRelsWriter._hyperlinks));
  }

  private _writeConditionalFormatting(): void {
    const options = {
      styles: this._workbook.styles
    };

    // Prepare both primary and ext sections upfront.
    // The primary prepare handles priorities, dxfId, and dataBar defaults.
    // The ext prepare (via ExtLstXform) assigns x14Id for rules that need
    // an ext section (dataBar, custom iconSet). Both must run before either
    // section is rendered, because the primary <cfRule> references the ext
    // via <x14:id>. This mirrors the non-streaming path where
    // WorkSheetXform.prepare() calls both chains sequentially.
    xform.conditionalFormattings.prepare(this.conditionalFormatting, options);
    const extModel = { conditionalFormattings: this.conditionalFormatting };
    xform.extLst.prepare(extModel);

    // Render primary section (position: after hyperlinks, before dataValidations)
    this.stream.write(xform.conditionalFormattings.toXml(this.conditionalFormatting));
  }

  /**
   * Write the `<extLst>` section at the end of the worksheet.
   * Currently this only contains conditional formatting extensions (data bar
   * ext attributes, custom icon sets), but the ExtLstXform will automatically
   * skip rendering when there is no ext content.
   *
   * The prepare phase was already done in _writeConditionalFormatting().
   */
  private _writeExtLst(): void {
    const model = { conditionalFormattings: this.conditionalFormatting };
    this.stream.write(xform.extLst.toXml(model));
  }

  private _writeIgnoredErrors(): void {
    if (this.ignoredErrors.length > 0) {
      this.stream.write(xform.ignoredErrors.toXml(this.ignoredErrors));
    }
  }

  private _writeRowBreaks(): void {
    this.stream.write(xform.rowBreaks.toXml(this.rowBreaks));
  }

  private _writeColBreaks(): void {
    this.stream.write(xform.colBreaks.toXml(this.colBreaks));
  }

  private _writeDataValidations(): void {
    this.stream.write(xform.dataValidations.toXml(this.dataValidations.model));
  }

  private _writeSheetProtection(): void {
    this.stream.write(xform.sheetProtection.toXml(this.sheetProtection));
  }

  private _writePageMargins(): void {
    this.stream.write(xform.pageMargins.toXml(this.pageSetup.margins));
  }

  private _writePageSetup(): void {
    this.stream.write(xform.pageSeteup.toXml(this.pageSetup));
  }

  private _writeHeaderFooter(): void {
    this.stream.write(xform.headerFooter.toXml(this.headerFooter));
  }

  private _writeAutoFilter(): void {
    this.stream.write(xform.autoFilter.toXml(this.autoFilter));
  }

  private _writeDrawing(): void {
    if (this._media.length === 0) {
      return;
    }

    // Resolve watermark coverage range from actual worksheet dimensions
    // (at commit time, all rows have been flushed so _dimensions is accurate)
    for (const entry of this._media) {
      if (entry._watermarkTag) {
        const dims = this._dimensions;
        const maxCol = dims ? Math.max(dims.right ?? 100, 100) : 100;
        const maxRow = dims ? Math.max(dims.bottom ?? 200, 200) : 200;
        entry.range.br = {
          nativeCol: maxCol,
          nativeColOff: 0,
          nativeRow: maxRow,
          nativeRowOff: 0
        };
      }
    }

    // Build the drawing model from the stored images.
    // The drawing XML will be generated later by WorkbookWriterBase.addDrawings().
    const drawingName = `drawing${this.id}`;
    const drawingRId = this._sheetRelsWriter.addRelationship({
      Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
      Target: drawingRelTargetFromWorksheet(drawingName)
    });

    // Build anchors and drawing-level rels using the shared utility
    const { anchors, rels } = buildDrawingAnchorsAndRels(this._media, [], {
      getBookImage: id => this._workbook.getImage(Number(id)),
      nextRId: currentRels => `rId${currentRels.length + 1}`
    });

    // Store drawing model for the workbook writer to generate the actual drawing XML
    this._drawing = {
      rId: drawingRId,
      name: drawingName,
      anchors,
      rels
    };

    // Write <drawing r:id="rIdN"/> into the worksheet XML
    this.stream.write(xform.drawing.toXml({ rId: drawingRId }));
  }

  /** Returns the drawing model if images were added, for the workbook writer. */
  get drawing():
    | { rId: string; name: string; anchors: DrawingAnchor[]; rels: DrawingRel[] }
    | undefined {
    return this._drawing;
  }

  private _writeBackground(): void {
    if (this._background) {
      if (this._background.imageId !== undefined) {
        const image = this._workbook.getImage(this._background.imageId);
        if (!image) {
          return;
        }
        // Background images are always embedded — external (linked) images are
        // rejected up front in addBackgroundImage (Excel drops them).
        const pictureId = this._sheetRelsWriter.addMedia({
          Target: mediaRelTargetFromRels(image.name),
          Type: RelType.Image
        });

        this._background = {
          ...this._background,
          rId: pictureId
        };
      }
      this.stream.write(xform.picture.toXml({ rId: this._background.rId }));
    }
  }

  private _writeLegacyData(): void {
    if (this.hasComments) {
      xmlBuffer.reset();
      xmlBuffer.addText(`<legacyDrawing r:id="${this._sheetCommentsWriter.vmlRelId}"/>`);
      this.stream.write(xmlBuffer);
    }
  }

  private _writeDimensions(): void {
    // for some reason, Excel can't handle dimensions at the bottom of the file
    // and we don't know the dimensions until the commit, so don't write them.
    // this._write('<dimension ref="' + this._dimensions + '"/>');
  }

  private _writeCloseWorksheet(): void {
    this._write("</worksheet>");
  }
}

export { WorksheetWriter };
export type { WriterImageModel };
