import type { PackageSink, PartWriter } from "@excel/utils/package-sink";
/**
 * The XLSB half of `Stream.WorkbookWriter`.
 *
 * **What this file is, and what it deliberately is not.** It is the seam that lets one streaming writer serve two
 * containers: `WorksheetWriter` accumulates a sheet's metadata and hands its rows over as they are committed, and
 * this decides what bytes that becomes when the target is binary. It is *not* a second workbook writer — every
 * record comes from `xlsb/write/*`, and the whole package except the sheet parts is produced by
 * `writeXlsbPackage` from the same `WorkbookModel` the buffered path uses.
 *
 * That division is the point. This module has produced the same defect eight times — two pieces of code sharing
 * one wrong belief, agreeing with each other and disagreeing with Excel — and a streaming writer with its own
 * record layer would be the ninth by construction. So the row encoder is shared (`encodeRowRecords`), the
 * prologue and epilogue are shared (`worksheetPrologueRecords` / `worksheetEpilogueRecords`), and
 * `__tests__/streaming-xlsb.node.test.ts` asserts that a streamed workbook is byte-identical to a buffered one
 * apart from the single record a forward pass cannot write.
 *
 * ## What is bounded, and what is not
 *
 * Rows are. They are encoded and handed to the ZIP as they arrive and never collected, which is the property the
 * streaming writer exists for — `benchmark/xlsb-streaming-scale.ts` writes ten million cells.
 *
 * The shared-string table and the style table are not: both are proportional to *distinct* values rather than to
 * cells, and both must survive until `sharedStrings.bin` and `styles.bin` are written at the end. The streaming
 * XLSX writer holds exactly the same two, so this is the claim that writer already makes rather than a weaker
 * one. A caller who wants strings unbounded passes `useSharedStrings: false` there; the binary form has no
 * equivalent, because `BrtCellIsst` is how a string reaches a cell.
 *
 * The workbook-level model is not either — sheet metadata, merges, conditional formats, hyperlinks. That is
 * bounded by the *shape* of the workbook rather than by its data, and it is what `writeXlsbPackage` consumes.
 *
 * ## The one thing given up
 *
 * `BrtWsDim` states the used range and sits before the rows, so a forward pass cannot fill it in. Excel writes it
 * in every reference workbook, so whether it may be omitted was a question about Excel rather than about the
 * specification, and it was settled by opening a package without it: Excel opens it without a repair. The XLSX
 * streaming writer drops `<dimension>` for the identical reason, and has since long before this.
 */
import type { PtgContext } from "@excel/xlsb/formula/ptg";
import { CellFormatTable } from "@excel/xlsb/styles";
import {
  breaksFromModel,
  columnsFromModel,
  mergesFromModel,
  paneFromModel,
  sheetOptionsFromModel,
  validationsFromModel,
  viewSettingsFromModel
} from "@excel/xlsb/write/model-adapter";
import type { sheetRowsFromModel } from "@excel/xlsb/write/model-adapter";
import { SharedStringTable } from "@excel/xlsb/write/shared-strings";
import type { SheetRow } from "@excel/xlsb/write/types";
import type { WriteWorksheetPartOptions } from "@excel/xlsb/write/worksheet";
import { beginWorksheetPart } from "@excel/xlsb/write/worksheet-stream";
import type { WorksheetPartStream } from "@excel/xlsb/write/worksheet-stream";

/** The sheet part path for a one-based sheet number, which is what the bundle and the rels agree on. */
export function streamedWorksheetPath(sheetNumber: number): string {
  return `xl/worksheets/sheet${sheetNumber}.bin`;
}

/**
 * The interning tables a streamed workbook fills as it goes, handed to `writeXlsbPackage` at the end.
 *
 * One instance per workbook, not per sheet: a `BrtCellIsst` index is workbook-wide, so a second table would make
 * every sheet after the first name the wrong strings. Sharing them is a correctness requirement rather than an
 * optimisation, which is why they live on the workbook writer and are passed down.
 */
export interface StreamedXlsbTables {
  readonly strings: SharedStringTable;
  readonly formats: CellFormatTable;
  /** Paths written so far, so the package writer knows not to produce them again. */
  readonly sheetPaths: Set<string>;
}

/** Fresh tables for a workbook. */
export function createStreamedXlsbTables(): StreamedXlsbTables {
  return {
    strings: new SharedStringTable(),
    formats: new CellFormatTable(),
    sheetPaths: new Set<string>()
  };
}

/**
 * A sheet being written forward into the package.
 *
 * Created when the sheet's first row is committed rather than when the sheet is created, because the prologue
 * describes the columns, panes and views — and a caller sets those between `addWorksheet` and the first row.
 * Opening the ZIP entry earlier would freeze them at their defaults, which is how the XLSX streaming writer's
 * `<cols>` handling works too: it emits them on the first row, not at construction.
 */
export class StreamedXlsbWorksheet {
  private stream: WorksheetPartStream | undefined;
  private readonly losses: string[] = [];

  constructor(
    private readonly sink: PackageSink,
    private readonly path: string,
    private readonly tables: StreamedXlsbTables,
    /** Everything the prologue and epilogue describe, read when each is written. */
    private readonly options: () => Omit<WriteWorksheetPartOptions, "rows" | "omitDimension">
  ) {}

  /** Append one row, opening the part if this is the first. */
  row(row: SheetRow): void {
    this.open().row(row);
  }

  /**
   * Finish the part.
   *
   * Opens it first when no row was ever committed: a sheet with no cells is still a sheet, and a package missing
   * the part its bundle names is one Excel repairs. That case is easy to lose because it cannot happen in the
   * buffered path, where the part is written whether or not there are rows.
   */
  end(): { readonly path: string; readonly unsupported: readonly string[] } {
    const stream = this.open();
    stream.end();
    this.losses.push(...stream.unsupported);
    this.tables.sheetPaths.add(this.path);
    return { path: this.path, unsupported: this.losses };
  }

  private open(): WorksheetPartStream {
    if (this.stream === undefined) {
      // The provider is handed through rather than resolved here: `beginWorksheetPart` calls it once for the prologue
      // and again when the part is closed, which is what lets a caller keep filling in merges, conditional formats and
      // page setup while rows arrive. Resolving it here is what froze all of that at the first row.
      this.stream = beginWorksheetPart(this.sink.open(this.path) as PartWriter, () => ({
        ...this.options(),
        strings: this.tables.strings,
        formats: this.tables.formats
      }));
    }
    return this.stream;
  }
}

/**
 * A worksheet model as the binary sheet writer's options, minus the rows.
 *
 * **The mapping itself is not here.** `writeXlsbPackage` derives merges, panes, views, page setup, conditional
 * formats, hyperlinks, breaks and validations from a `WorksheetModel`, and the whole value of making
 * `WorksheetWriter` produce a real model is that those derivations are reached rather than reimplemented. This
 * function is the small amount that is genuinely streaming-specific: the interning tables, and the absence of the
 * cross-sheet state a single streamed sheet cannot have.
 *
 * What a streamed sheet gives up, and why each is a consequence of writing forward rather than an omission:
 *
 * - **Tables and their `PtgList` indices.** A structured reference names a table by index into a workbook-wide
 *   table, and that table is not complete until every sheet exists. A formula written in sheet 1 cannot resolve a
 *   table introduced in sheet 3.
 * - **Cross-sheet `dxf` and conditional-format priorities.** Both are allocated across the workbook; a sheet
 *   committed before its successors exist cannot know what they will claim.
 * - **Drawings, tables and pivot tables as *parts*.** Those are produced by `writeXlsbPackage` at the end from the
 *   model, not by this sheet writer — so they are not lost, they are simply not this function's business.
 */
/**
 * The relationship id a streamed sheet claims for its legacy VML drawing.
 *
 * **One place, because two would be the pattern this module keeps removing.** `writeXlsbPackage` seeds a sheet's
 * allocator with this so it cannot hand the same id to something else, and uses it for the VML relationship instead of
 * allocating a fresh one. A streamed sheet starts with an empty relationship set — newly authored, so no preserved
 * relationships and no drawing — which is what makes the first id safe to claim in advance.
 */
export const STREAMED_LEGACY_VML_REL_ID = "rId1";

export function xlsbSheetOptionsFromModel(
  model: Parameters<typeof sheetRowsFromModel>[0],
  tables: StreamedXlsbTables,
  isFirstSheet: boolean,
  /**
   * The workbook-wide names a formula's token stream resolves against.
   *
   * **Omitting this made every cross-sheet formula a blank cell, silently.** `encodeFormulaCell` resolves `Sheet2!A1`
   * to an `ixti` through `sheetNames`, and with an empty context it reported "sheet Other is not in the workbook" for a
   * sheet that was right there — the row encoder then wrote `BrtCellBlank`. Two formulas out of two disappeared from a
   * two-sheet workbook.
   *
   * What a streamed sheet still cannot resolve is a reference *forward*: a formula in sheet 1 naming sheet 3 is written
   * before sheet 3 exists. That is inherent to writing forward, and it is now reported rather than silent — see
   * `WorksheetWriter.xlsbUnsupported`.
   */
  formulaContext?: PtgContext,
  /**
   * The workbook's date system, for a `type: "date"` validation bound.
   *
   * Cell values carry their own copy through `sheetRowsFromModel`; a validation bound is a serial belonging to
   * no cell, so it had nothing telling it which epoch to use and was written against 1900 inside a 1904
   * package — 1,462 days from the cells it constrains. The buffered writer passes this at
   * `writeXlsbPackage`; a streamed sheet is skipped there because its bytes are already in the sink, so it has
   * to arrive here.
   */
  date1904 = false
): Omit<WriteWorksheetPartOptions, "rows" | "omitDimension"> {
  const merges = mergesFromModel(model as never);
  const pane = paneFromModel(model as never);
  // The first sheet is the active one, which is what the buffered writer says for a workbook that has not chosen
  // otherwise. Passing `false` unconditionally cleared a flag in `BrtBeginWsView` and made a streamed workbook
  // differ from a buffered one in a byte that has nothing to do with streaming.
  const views = viewSettingsFromModel(model as never, isFirstSheet);
  const breaks = breaksFromModel(model as never);
  return {
    strings: tables.strings,
    formats: tables.formats,
    merges: merges.ranges,
    columns: columnsFromModel(model as never),
    ...sheetOptionsFromModel(model as never),
    validations: validationsFromModel(model as never),
    date1904,
    rowBreaks: breaks.rows,
    columnBreaks: breaks.columns,
    ...(pane === undefined ? {} : { pane }),
    ...(views === undefined ? {} : { viewSettings: views }),
    sheetName: (model as { name?: string }).name ?? "Sheet1",
    // **`BrtLegacyDrawing` has to go inside the sheet part, and the sheet part closes before the package is assembled.**
    //
    // That record names the relationship reaching the VML that draws a note's box — the little marker on the cell — and
    // `writeXlsbPackage` allocates that relationship when it builds the sheet's `.rels`, which is after this part has been
    // closed. So a streamed sheet with notes got the comments part, the VML and the relationship, and no record pointing
    // at it: Excel showed no indicator, which is exactly how this was reported.
    //
    // Resolved by having the sheet *declare* the id and the package writer honour it, rather than both computing it. A
    // streamed sheet's relationship set starts empty — it is newly authored, so it carries no preserved relationships and
    // no drawing — so the first id is free. The literal lives here only, and `writeXlsbPackage` seeds its own allocator
    // with it.
    ...(((model as { retainedComments?: readonly unknown[] }).retainedComments ?? []).length === 0
      ? {}
      : { legacyDrawingRelationshipId: STREAMED_LEGACY_VML_REL_ID }),
    ...(formulaContext === undefined ? {} : { formulaContext })
  };
}
